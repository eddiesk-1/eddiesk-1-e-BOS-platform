import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';
import { withVisitorAccess } from '../lib/publicDb.js';
import { isValidUuid, getVisitorToken } from './conversations.js';

/**
 * This file exists because of a real security defect found in the
 * e-BOS landing-page frontend: callClaude() there did a bare
 * client-side fetch to https://api.anthropic.com/v1/messages with no
 * API key, no auth header, and no server in between. Anyone who opened
 * dev tools on that page could read the code and hit Anthropic's API on
 * whatever key eventually backed it, unmetered, as themselves. Three
 * features routed through it: AI search, guide-upload structure
 * analysis, and the product detail AI overview.
 *
 * These three routes are the fix: the exact same prompts, moved
 * server-side, called with ANTHROPIC_API_KEY from this process's own
 * environment (never sent to or knowable by any client), gated behind
 * this service's normal JWT auth. The frontend's job becomes: call
 * these instead of api.anthropic.com directly, with an Authorization
 * header like every other authenticated request it already needs to
 * make against this backend.
 *
 * If ANTHROPIC_API_KEY isn't configured, every route here returns a
 * clear 503 rather than a confusing downstream failure — see
 * requireApiKey() below. Everything else in this service works with no
 * Anthropic key at all; only these three routes need one.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-4-6';

function requireApiKey(reply: import('fastify').FastifyReply): string | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_real_anthropic_api_key_here') {
    reply.code(503).send({
      error: 'service_unavailable',
      message: 'ANTHROPIC_API_KEY is not configured on this server — AI features are unavailable.',
    });
    return null;
  }
  return key;
}

interface ClaudeMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * `user` accepts either a flat string (the shape the three original
 * routes below already use — one isolated question, no history) or a
 * full ClaudeMessage[] (needed for the reception-salesperson endpoint
 * further down, which replies within an ONGOING conversation and needs
 * the model to see prior turns, not just the latest message in
 * isolation). One shared call site rather than a forked duplicate
 * function, so the actual Anthropic API interaction — auth header,
 * response parsing, error handling — stays defined in exactly one
 * place.
 */
async function callClaude(
  apiKey: string,
  system: string,
  user: string | ClaudeMessage[],
  maxTokens: number,
): Promise<string> {
  const messages: ClaudeMessage[] =
    typeof user === 'string' ? [{ role: 'user', content: user }] : user;
  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
    }),
  });
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw new Error(`Anthropic API error ${response.status}: ${bodyText.slice(0, 500)}`);
  }
  const data = (await response.json()) as { content: Array<{ type: string; text?: string }> };
  return data.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('');
}

interface SearchCatalogItem {
  id: string;
  name: string;
  category: string;
  desc: string;
}

interface SearchBody {
  query: string;
  catalog: SearchCatalogItem[];
}

interface GuideAnalysisBody {
  text: string;
}

interface OverviewBody {
  name: string;
  category: string;
  businessName: string;
  description: string;
}

export default async function aiRoutes(fastify: FastifyInstance) {
  /**
   * POST /product-stream/search
   *
   * Mirrors the frontend's runAISearch() exactly: the client already has
   * the full catalog from GET /product-stream (a snapshot it fetched
   * itself) and sends {id, name, category, desc} per item plus a query;
   * this returns a ranked array of ids. The prompt text is copied
   * verbatim from the frontend's runAISearch() — this route doesn't
   * change what the feature does, only where the API call happens.
   *
   * Deliberately public (no fastify.authenticate) to match
   * /product-stream itself — search over a public catalog by an
   * anonymous visitor is the same trust boundary as browsing it, and
   * requiring login just to search a public landing page would be a
   * worse regression than the one being fixed here.
   */
  fastify.post<{ Body: SearchBody }>('/product-stream/search', async (request, reply) => {
    const apiKey = requireApiKey(reply);
    if (!apiKey) return;

    const { query, catalog } = request.body ?? ({} as SearchBody);
    if (!query || !Array.isArray(catalog)) {
      reply.code(400).send({ error: 'bad_request', message: 'query and catalog are both required' });
      return;
    }

    const sys =
      'You rank a product/service catalog by semantic relevance to a search query for a marketplace discovery UI. Respond with ONLY a JSON array of relevant product ids, most relevant first. Include only genuinely relevant items; omit clearly irrelevant ones. No prose, no markdown fences, just the JSON array.';
    const user = `Query: "${query}"\nCatalog:\n${JSON.stringify(catalog)}`;

    try {
      const text = await callClaude(apiKey, sys, user, 500);
      const cleaned = text.replace(/```json|```/g, '').trim();
      const ids = JSON.parse(cleaned);
      if (!Array.isArray(ids)) throw new Error('Model did not return an array');
      reply.send({ ids });
    } catch (err) {
      request.log.warn({ err }, 'AI search failed, client should fall back to keyword search');
      reply.code(502).send({ error: 'ai_unavailable', message: 'AI search is temporarily unavailable' });
    }
  });

  /**
   * POST /guides/analyze
   *
   * Mirrors analyzeGuideText() from the frontend exactly. Requires auth
   * (unlike search/overview above) — analyzing a guide is part of the
   * business-creation flow, which the frontend's own "Upload Guide" menu
   * item ties to an authenticated owner action, not anonymous browsing.
   */
  fastify.post<{ Body: GuideAnalysisBody }>(
    '/guides/analyze',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const apiKey = requireApiKey(reply);
      if (!apiKey) return;

      const { text } = request.body ?? ({} as GuideAnalysisBody);
      if (!text || typeof text !== 'string') {
        reply.code(400).send({ error: 'bad_request', message: 'text is required' });
        return;
      }

      const sys =
        'You read the first part of a small business operating guide and propose a short starting structure for it: 2-4 product lines, each with 1-2 workflow steps. Respond in concise plain text as a small nested list, no more than 10 lines total. No preamble.';
      const user = `Guide excerpt:\n${text.slice(0, 6000)}`;

      try {
        const structure = await callClaude(apiKey, sys, user, 400);
        reply.send({ structure: structure.trim() });
      } catch (err) {
        request.log.warn({ err }, 'Guide analysis failed');
        reply
          .code(502)
          .send({ error: 'ai_unavailable', message: 'Guide analysis is temporarily unavailable' });
      }
    }),
  );

  /**
   * POST /product-stream/overview
   *
   * Mirrors getAIOverview() from the frontend, with one deliberate
   * change: the frontend's original prompt included item.rating, but
   * this backend's /product-stream never returns a real rating (it's
   * null — see productStream.ts's comment on why fabricating one would
   * be worse than admitting it doesn't exist). Passing a null rating
   * into the prompt would produce a confused overview that references a
   * rating that isn't there, so it's omitted from the prompt entirely
   * here rather than forwarded as-is.
   *
   * Public, same reasoning as /product-stream/search — viewing a
   * product's detail panel on a public landing page shouldn't require
   * login. Unlike the frontend's version, this route does NOT cache by
   * item id (the frontend already does that client-side via
   * overviewCache — caching again server-side would just be redundant,
   * not add anything the client-side cache doesn't already provide
   * within a single browsing session, and a server-side cache raises its
   * own question — how long is a generated overview valid for, does it
   * need invalidating when catalog_meta changes — that isn't worth
   * answering for a feature this small).
   */
  fastify.post<{ Body: OverviewBody }>('/product-stream/overview', async (request, reply) => {
    const apiKey = requireApiKey(reply);
    if (!apiKey) return;

    const { name, category, businessName, description } = request.body ?? ({} as OverviewBody);
    if (!name || !category || !businessName || !description) {
      reply.code(400).send({
        error: 'bad_request',
        message: 'name, category, businessName, and description are all required',
      });
      return;
    }

    const sys =
      'You write a warm, specific two-sentence overview of a small business product or service for a marketplace detail panel. Plain language, concrete, no hype words like "amazing" or "revolutionary". Output only the two sentences, no preamble.';
    const user = `Product: ${name}\nCategory: ${category}\nBusiness: ${businessName}\nDescription: ${description}`;

    try {
      const text = await callClaude(apiKey, sys, user, 200);
      reply.send({ overview: text.trim() });
    } catch (err) {
      request.log.warn({ err }, 'AI overview generation failed');
      reply
        .code(502)
        .send({ error: 'ai_unavailable', message: 'AI overview is temporarily unavailable' });
    }
  });

  /**
   * POST /conversations/:id/ai-reply — the reception-salesperson.
   * Public, token-gated exactly like every other visitor-facing
   * conversation route (X-Visitor-Token header) — this is not a separate
   * auth mechanism, it reuses conversations.ts's own boundary, because
   * it's operating on the same conversation a visitor already owns.
   *
   * WHAT THIS DOES: reads the conversation's message history, builds a
   * SCOPED context of what this specific business actually has to offer
   * (see gatherBusinessContext below), and asks Claude to reply in
   * character as that business's reception-salesperson — conversational,
   * warm, actively working toward understanding what the visitor needs,
   * openly an AI. The reply is written back as a new message with
   * sender_type='ai'.
   *
   * WHAT THIS DELIBERATELY DOES NOT DO, STATED HONESTLY: this endpoint
   * does not run — and this codebase does not yet have — any guide-
   * ingestion pipeline that populates knowledge_chunks with real,
   * embedded content from an uploaded operating guide. The retrieval
   * query against knowledge_chunks below is real, working code, scoped
   * correctly, and will correctly return real chunks the moment such a
   * pipeline exists — but as of this migration, it will return an empty
   * result for every business, because nothing has ever written a row
   * to that table. The "guide" half of "knowledge based on the guide
   * and product lines" is honestly the product-lines half only, today.
   * See README's "Consumer chat and human handoff" section (and its own
   * update for this endpoint) for the same disclosure in the docs — this
   * isn't hidden in a code comment nobody reads.
   *
   * "NEVER OVEREXPOSED": gatherBusinessContext() queries exactly three
   * things — the business's own name, its PUBLISHED materials
   * (catalog_meta IS NOT NULL — the identical dataset GET /product-stream
   * already exposes publicly, so this introduces no NEW exposure), and
   * knowledge_chunks scoped to this business_id. It never touches
   * orders, ledger_entries, counterparties (other than implicitly, via
   * the conversation's own identity — never queried directly here),
   * people's emails, or unpublished materials. If this endpoint is ever
   * extended to pull in more context, that context should be added to
   * gatherBusinessContext() specifically, so there's exactly one
   * function to audit for "what can the AI possibly know," not context-
   * gathering scattered across the route body.
   */
  fastify.post<{ Params: { id: string } }>('/conversations/:id/ai-reply', async (request, reply) => {
    // Token check BEFORE the API-key check — same ordering as
    // POST /guides/analyze, and for the same reason: an unauthenticated
    // caller shouldn't learn anything about whether this server's AI
    // features are configured before proving they actually own this
    // conversation. An earlier version of this endpoint checked the API
    // key first, which leaked a 503 to a request with no token at all —
    // caught by testing the actual no-token request, not by reviewing
    // the code in isolation (each individual check looked correct; the
    // ORDER was the bug).
    const token = getVisitorToken(request);
    if (!token) {
      reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
      return;
    }
    if (!isValidUuid(request.params.id)) {
      reply.code(400).send({ error: 'bad_request', message: 'Invalid conversation id' });
      return;
    }

    const apiKey = requireApiKey(reply);
    if (!apiKey) return;

    const gathered = await withVisitorAccess(token, async (client) => {
      const convResult = await client.query(
        `SELECT id, business_id, kind FROM conversations WHERE id = $1`,
        [request.params.id],
      );
      if (convResult.rows.length === 0) return null;
      const { business_id: businessId } = convResult.rows[0];

      const historyResult = await client.query(
        `SELECT sender_type, body FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [request.params.id],
      );

      const context = await gatherBusinessContext(client, businessId);

      // Has this conversation ever had an AI message before? Determines
      // whether the disclosure marker (and an explicit "this is your
      // first time talking to the AI here" framing in the system
      // prompt) applies to the reply about to be generated.
      const priorAiCount = historyResult.rows.filter((r) => r.sender_type === 'ai').length;

      return { businessId, history: historyResult.rows, context, isFirstAiMessage: priorAiCount === 0 };
    });

    if (gathered === null) {
      reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
      return;
    }
    const { history, context, isFirstAiMessage } = gathered;

    if (history.length === 0 || history[history.length - 1].sender_type !== 'visitor') {
      // Nothing new to reply to — either the conversation is empty (data
      // shouldn't reach this state given POST /conversations always
      // creates the first message, but this is a defensive check, not
      // an assumption that it's unreachable) or the last message was
      // already from staff/AI, in which case generating another AI
      // reply on top of it isn't this endpoint's job.
      reply.code(409).send({
        error: 'conflict',
        message: 'There is no new visitor message to reply to',
      });
      return;
    }

    const systemPrompt = buildReceptionSystemPrompt(context, isFirstAiMessage);
    const claudeHistory: ClaudeMessage[] = history.map((row) => ({
      role: row.sender_type === 'visitor' ? 'user' : 'assistant',
      content: row.body,
    }));

    let replyText: string;
    try {
      replyText = await callClaude(apiKey, systemPrompt, claudeHistory, 500);
    } catch (err) {
      request.log.warn({ err }, 'Reception-salesperson AI reply failed');
      reply
        .code(502)
        .send({ error: 'ai_unavailable', message: 'The AI assistant is temporarily unavailable' });
      return;
    }

    const written = await withVisitorAccess(token, async (client) => {
      const result = await client.query(
        `INSERT INTO messages (conversation_id, sender_type, body, is_ai_disclosure)
         VALUES ($1, 'ai', $2, $3)
         RETURNING id, conversation_id, sender_type, sender_person_id, body, created_at, is_ai_disclosure`,
        [request.params.id, replyText, isFirstAiMessage],
      );
      await client.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [
        request.params.id,
      ]);
      return result.rows[0];
    });

    reply.code(201).send({
      id: written.id,
      conversationId: written.conversation_id,
      senderType: written.sender_type,
      senderPersonId: written.sender_person_id,
      body: written.body,
      createdAt: written.created_at,
      isAiDisclosure: written.is_ai_disclosure,
    });
  });
}

interface BusinessContext {
  businessName: string;
  publishedItems: Array<{ name: string; category: string | null; description: string | null }>;
  guideChunks: string[];
}

/**
 * The ONE function responsible for "what can the reception-salesperson
 * possibly know." See the ai-reply endpoint's own comment above for the
 * exposure boundary this is meant to hold — every query here is scoped
 * to exactly what's needed, nothing broader "in case it's useful later."
 */
async function gatherBusinessContext(
  client: import('pg').PoolClient,
  businessId: string,
): Promise<BusinessContext> {
  const bizResult = await client.query(`SELECT name FROM businesses WHERE id = $1`, [businessId]);
  const businessName = bizResult.rows[0]?.name ?? 'this business';

  const materialsResult = await client.query(
    `SELECT name, catalog_meta FROM materials WHERE business_id = $1 AND catalog_meta IS NOT NULL ORDER BY name ASC`,
    [businessId],
  );
  const publishedItems = materialsResult.rows.map((row) => ({
    name: row.name,
    category: row.catalog_meta?.category ?? null,
    description: row.catalog_meta?.description ?? null,
  }));

  // Real query, honestly empty in practice today — see the endpoint's
  // own comment on why. LIMIT 8 is a deliberate cap on how much guide
  // text could ever be pulled into one prompt, once this table has real
  // rows — "never overexposed" applies here too, not just to the
  // materials list above: even a real guide shouldn't be dumped in
  // full, only a bounded, relevant slice of it.
  const chunksResult = await client.query(
    `SELECT content FROM knowledge_chunks WHERE business_id = $1 ORDER BY id ASC LIMIT 8`,
    [businessId],
  );
  const guideChunks = chunksResult.rows.map((row) => row.content);

  return { businessName, publishedItems, guideChunks };
}

/**
 * The persona. Every clause here maps to a specific word in the request
 * that produced this endpoint — worth reading this comment alongside the
 * prompt text itself if either ever needs revising, so a future edit
 * doesn't accidentally drop a requirement that was deliberate:
 *
 * "reception-salesperson" -> the role framing in the first line.
 * "vibey-chalant and conversational" -> "warm, easygoing, genuinely
 *   conversational... not stiff or corporate, not overeager either" —
 *   the plain-language translation of that phrase into something a
 *   model can actually act on consistently, rather than the slang term
 *   itself, which risks being interpreted inconsistently turn to turn.
 * "fairly-effectively enquire any information the system needs" -> the
 *   explicit instruction to actively ask toward understanding what the
 *   visitor wants, and to invite identification when it's natural
 *   rather than immediately — NOT to interrogate or checklist through
 *   required fields.
 * "very honest about being an AI" -> its own clearly separated,
 *   unambiguous, non-negotiable paragraph — deliberately given more
 *   prominence than the tone instructions, and reinforced with an
 *   EXPLICIT "if the conversation runs long, do not let this instruction
 *   fade" line, precisely because that's the realistic failure mode for
 *   a purely-prompted behavior (see migration 017's is_ai_disclosure
 *   column for the structural backstop this prompt instruction is
 *   layered on top of, not a replacement for).
 * "knowledge... from the guide and product lines... never overexposed"
 *   -> the CONTEXT section is built entirely from gatherBusinessContext,
 *   and the prompt explicitly instructs the model not to volunteer
 *   information beyond it and not to invent anything not present in
 *   that context.
 */
function buildReceptionSystemPrompt(context: BusinessContext, isFirstAiMessage: boolean): string {
  const catalogSection =
    context.publishedItems.length > 0
      ? context.publishedItems
          .map((item) => {
            const parts = [item.name];
            if (item.category) parts.push(`(${item.category})`);
            if (item.description) parts.push(`— ${item.description}`);
            return `- ${parts.join(' ')}`;
          })
          .join('\n')
      : '(No products or services have been published for this business yet.)';

  const guideSection =
    context.guideChunks.length > 0
      ? context.guideChunks.map((chunk) => `- ${chunk}`).join('\n')
      : '(No additional guide material is available.)';

  return `You are the reception-salesperson for ${context.businessName}, chatting with a visitor on this business's public landing page.

TONE: Warm, easygoing, genuinely conversational — the way a good salesperson greets someone browsing in person, not a corporate script. Not stiff or overly formal, but not overeager or pushy either. Short, natural messages, not long paragraphs. It's fine to ask a genuine question back.

WHAT YOU'RE ACTUALLY DOING: actively work toward understanding what the visitor is looking for — ask, don't wait to be asked everything. Once it feels natural (not immediately, not as an interrogation), you can mention that if they'd like to be remembered for next time or want a human to follow up, they're welcome to share their name and email. Never demand this; it's an invitation, not a requirement.

ABSOLUTE REQUIREMENT — HONESTY ABOUT BEING AN AI: You are an AI. If asked, directly or indirectly, whether you are a real person, an AI, a bot, automated, or anything adjacent — say clearly and immediately that you are an AI. Never claim, imply, or allow the visitor to reasonably conclude you are a human. This instruction does not soften or fade as the conversation continues — hold it exactly as firmly on the twentieth message as the first.

WHAT YOU KNOW — AND THE LIMIT OF WHAT YOU KNOW: Everything you can truthfully say about this business is in the CONTEXT below. Do not invent products, prices, policies, or details that aren't there. If you don't know something, say so plainly and offer to have a human follow up — do not guess or make something plausible-sounding up.

CONTEXT — What ${context.businessName} offers (published products/services):
${catalogSection}

CONTEXT — Additional business guide material:
${guideSection}

${isFirstAiMessage ? 'This is your first reply in this conversation — a brief, natural mention that you\'re an AI assistant for this business fits well here, without making it the whole message.' : ''}`;
}
