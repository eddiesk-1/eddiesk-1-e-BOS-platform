import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';
import { withVisitorAccess } from '../lib/publicDb.js';
import { isValidUuid, getVisitorToken } from './conversations.js';
import { limits } from '../lib/limits.js';
import { byIp, rateLimitHook } from '../lib/rateLimit.js';
import { buildTsQuery } from '../lib/guideSearch.js';
import { inferRegion } from '../lib/regionInference.js';
import { detectEscalation, extractHandoffMarker, handoffNotice, shouldEscalate, type HandoffReason } from '../lib/escalation.js';
import { requestHandoff } from '../lib/handoff.js';
import { buildReceptionSystemPrompt, toClaudeHistory, type ChatContext, type ClaudeMessage } from '../lib/chatPrompt.js';

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
  fastify.post<{ Body: SearchBody }>('/product-stream/search', { preHandler: [rateLimitHook(limits.aiPublic, byIp)] }, async (request, reply) => {
    const apiKey = requireApiKey(reply);
    if (!apiKey) return;

    const { query, catalog } = request.body ?? ({} as SearchBody);
    if (!query || typeof query !== 'string' || !Array.isArray(catalog)) {
      reply.code(400).send({ error: 'bad_request', message: 'query and catalog are both required' });
      return;
    }
    // Public + billed per call: bound the size of what a caller can make us send.
    if (query.length > 200 || catalog.length > 300) {
      reply.code(400).send({ error: 'bad_request', message: 'query is limited to 200 characters and catalog to 300 items' });
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
  fastify.post<{ Body: OverviewBody }>('/product-stream/overview', { preHandler: [rateLimitHook(limits.aiPublic, byIp)] }, async (request, reply) => {
    const apiKey = requireApiKey(reply);
    if (!apiKey) return;

    const { name, category, businessName, description } = request.body ?? ({} as OverviewBody);
    if (
      !name || !category || !businessName || !description ||
      [name, category, businessName, description].some((v) => typeof v !== 'string' || v.length > 2000)
    ) {
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
   * conversation route (X-Visitor-Token header).
   *
   * HOW IT WORKS (rewritten in 0.0.6; the earlier version could not have
   * worked — see migration 020's header):
   *   1. chat_ai_context() (one database function, token-verified) returns
   *      the recent history, the business's PUBLISHED catalog, the guide
   *      chunks most relevant to what the visitor just said (Postgres
   *      full-text rank, not "the first 8"), the business's registered
   *      region labels, and its AI settings.
   *   2. If the conversation has no region yet, a rule-based matcher tries
   *      to infer one from the visitor's words (lib/regionInference.ts)
   *      and records it so human routing can use it.
   *   3. Escalation. If the visitor asks for a person, complains, or
   *      negotiates price (lib/escalation.ts) — or the model itself ends
   *      its reply with a [[HANDOFF:reason]] marker — the conversation is
   *      handed to staff FIRST (database state + in-app notifications +
   *      email), and only then does the visitor get a short notice saying
   *      so. They are never told about a handoff that did not happen.
   *   4. Otherwise the model's reply is saved via chat_post_ai_message().
   *
   * WHAT THE AI CAN KNOW: exactly what chat_ai_context returns — the
   * business name, published catalog (the same data GET /product-stream
   * already exposes), that business's guide chunks and region labels. It
   * never sees orders, ledger entries, counterparties, other people's
   * contact details or unpublished materials.
   *
   * WHAT THE AI CANNOT DO: create orders, take payments, grant discounts
   * or change any record. It has no tools. The only side effect a model
   * reply can have is a handoff request, validated against a fixed list of
   * reasons. Visitor text is treated as untrusted data in the prompt.
   *
   * COST CONTROL: per-IP and per-conversation rate limits (lib/limits.ts)
   * and max_tokens 500 per reply. Nothing here is metered per business yet.
   */
  fastify.post<{ Params: { id: string } }>(
    '/conversations/:id/ai-reply',
    { preHandler: [rateLimitHook(limits.aiReplyIp, byIp)] },
    async (request, reply) => {
      // Token check BEFORE the API-key check, same ordering as
      // POST /guides/analyze: an unauthenticated caller learns nothing
      // about server configuration.
      const token = getVisitorToken(request);
      if (!token) {
        reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
        return;
      }
      const conversationId = request.params.id;
      if (!isValidUuid(conversationId)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid conversation id' });
        return;
      }
      if (!limits.aiReplyConversation.check(conversationId).allowed) {
        reply.code(429).send({ error: 'rate_limited', message: 'Slow down a little — please wait a moment before sending more.' });
        return;
      }
      const apiKey = requireApiKey(reply);
      if (!apiKey) return;

      const gathered = await withVisitorAccess(token, async (client) => {
        const recent = await client.query<{ body: string }>(
          `SELECT body FROM messages
           WHERE conversation_id = $1 AND sender_type = 'visitor'
           ORDER BY created_at DESC LIMIT 3`,
          [conversationId],
        );
        const visitorTexts = recent.rows.map((r) => r.body);
        const tsq = buildTsQuery(visitorTexts.slice(0, 2));
        const ctxRes = await client.query<{ ctx: ChatContext | null }>(
          `SELECT chat_ai_context($1, $2, $3) AS ctx`,
          [conversationId, token, tsq.length > 0 ? tsq : null],
        );
        return { ctx: ctxRes.rows[0].ctx, visitorTexts };
      });

      const ctx = gathered.ctx;
      if (ctx === null) {
        reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
        return;
      }
      const last = ctx.history[ctx.history.length - 1];
      if (ctx.handled_by !== 'ai' || !last || last.sender_type !== 'visitor') {
        reply.code(409).send({
          error: 'conflict',
          message: ctx.handled_by !== 'ai' ? 'A team member is handling this conversation' : 'There is no new visitor message to reply to',
        });
        return;
      }
      const isFirst = ctx.prior_ai_count === 0;

      // ---- region (rule-based; best effort, never blocks the reply)
      if (!ctx.region && ctx.region_labels.length > 0) {
        const inferred = inferRegion(gathered.visitorTexts.join('\n'), ctx.region_labels);
        if (inferred) {
          await withVisitorAccess(token, (client) =>
            client.query('SELECT chat_set_region($1, $2, $3)', [conversationId, token, inferred]),
          ).catch((err: unknown) => request.log.warn({ err }, 'region inference could not be saved'));
        }
      }

      const respond = async (body: string, escalated: HandoffReason | null, allowAwaiting: boolean) => {
        const written = await withVisitorAccess(token, async (client) => {
          const r = await client.query<{ m: PostedMessage }>(
            'SELECT chat_post_ai_message($1, $2, $3, $4, $5) AS m',
            [conversationId, token, body, isFirst, allowAwaiting],
          );
          return r.rows[0].m;
        });
        if (!written.ok) {
          reply.code(409).send({ error: 'conflict', message: 'A team member is handling this conversation' });
          return;
        }
        reply.code(201).send({
          id: written.id,
          conversationId: written.conversation_id,
          senderType: written.sender_type,
          senderPersonId: written.sender_person_id,
          body: written.body,
          createdAt: written.created_at,
          isAiDisclosure: written.is_ai_disclosure,
          handoff: escalated ? { requested: true, reason: escalated } : { requested: false },
        });
      };

      const aiIntro = isFirst ? `Just so you know, I'm an AI assistant for ${ctx.business_name}. ` : '';

      // ---- 1. the visitor's own words
      const detected = detectEscalation(last.body);
      if (detected && shouldEscalate(detected, ctx.auto_escalation)) {
        try {
          await requestHandoff(conversationId, token, detected, request.log);
        } catch (err) {
          request.log.error({ err }, 'handoff failed');
          reply.code(502).send({ error: 'handoff_failed', message: 'We could not reach the team just now. Please try again in a moment.' });
          return;
        }
        await respond(aiIntro + handoffNotice(detected), detected, true);
        return;
      }

      // ---- 2. the model
      const systemPrompt = buildReceptionSystemPrompt(ctx, isFirst);
      const claudeHistory = toClaudeHistory(ctx.history);
      let modelText: string;
      try {
        modelText = await callClaude(apiKey, systemPrompt, claudeHistory, 500);
      } catch (err) {
        request.log.warn({ err }, 'Reception-salesperson AI reply failed');
        reply.code(502).send({ error: 'ai_unavailable', message: 'The AI assistant is temporarily unavailable' });
        return;
      }
      const { text, reason } = extractHandoffMarker(modelText);
      const escalate = reason !== null && shouldEscalate(reason, ctx.auto_escalation) ? reason : null;

      if (escalate) {
        try {
          await requestHandoff(conversationId, token, escalate, request.log);
        } catch (err) {
          request.log.error({ err }, 'handoff failed');
          reply.code(502).send({ error: 'handoff_failed', message: 'We could not reach the team just now. Please try again in a moment.' });
          return;
        }
        await respond(text.length > 0 ? text : aiIntro + handoffNotice(escalate), escalate, true);
        return;
      }
      if (text.length === 0) {
        reply.code(502).send({ error: 'ai_unavailable', message: 'The AI assistant is temporarily unavailable' });
        return;
      }
      await respond(text, null, false);
    },
  );
}

interface PostedMessage {
  ok: boolean;
  id: string;
  conversation_id: string;
  sender_type: string;
  sender_person_id: string | null;
  body: string;
  created_at: string;
  is_ai_disclosure: boolean;
}
