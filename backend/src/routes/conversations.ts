import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { withVisitorAccess } from '../lib/publicDb.js';
import { withDb } from '../plugins/tenantContext.js';
import { limits } from '../lib/limits.js';
import { byIp, rateLimitHook } from '../lib/rateLimit.js';
import { requestHandoff } from '../lib/handoff.js';

/**
 * Consumer↔sales chat. The visitor-facing half of this file has NO JWT
 * anywhere — see migration 012's file-level comment for the full design
 * reasoning, and publicDb.ts's withVisitorAccess for the mechanism. Short
 * version: a visitor gets an opaque uuid token back from
 * POST /conversations, holds onto it (localStorage, not a cookie — this
 * service sets no cookies anywhere), and presents it on every later
 * request via the X-Visitor-Token header. RLS (visitor_token_access /
 * visitor_token_insert policies) is what actually enforces "you may only
 * see/post to a conversation whose token you hold" — this file's own
 * validation is a courtesy (clear 400s instead of opaque database
 * errors), not the real boundary.
 *
 * The business side (GET /conversations for an inbox, POST a reply) goes
 * through the completely ordinary withDb/JWT pattern every other
 * authenticated route in this codebase uses — no new mechanism there.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Exported for routes/ai.ts's ai-reply endpoint, which needs the exact
// same visitor-token validation this file already uses — one
// definition, not a duplicate that could silently drift from this one.
export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function getVisitorToken(request: import('fastify').FastifyRequest): string | null {
  const header = request.headers['x-visitor-token'];
  const token = Array.isArray(header) ? header[0] : header;
  return isValidUuid(token) ? token : null;
}

interface ConversationRow {
  id: string;
  business_id: string;
  kind: 'consumer' | 'internal';
  counterparty_id: string | null;
  visitor_display_name: string | null;
  subject: string | null;
  created_at: Date;
  last_message_at: Date;
  handled_by: 'ai' | 'awaiting_human' | 'staff';
  claimed_by_person_id: string | null;
  handoff_reason?: string | null;
  handoff_at?: Date | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  sender_type: 'visitor' | 'person';
  sender_person_id: string | null;
  body: string;
  created_at: Date;
}

function conversationShape(row: ConversationRow) {
  return {
    id: row.id,
    businessId: row.business_id,
    kind: row.kind,
    identified: row.counterparty_id !== null,
    counterpartyId: row.counterparty_id,
    visitorDisplayName: row.visitor_display_name,
    subject: row.subject,
    createdAt: row.created_at,
    lastMessageAt: row.last_message_at,
    handledBy: row.handled_by,
    claimedByPersonId: row.claimed_by_person_id,
    handoffReason: row.handoff_reason ?? null,
    handoffAt: row.handoff_at ?? null,
  };
}


function messageShape(row: MessageRow) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    senderType: row.sender_type,
    senderPersonId: row.sender_person_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

export default async function conversationRoutes(fastify: FastifyInstance) {
  // ============ VISITOR-FACING (public, token-based) ============

  /**
   * POST /conversations — the entire "start chatting" flow: one request,
   * no signup, no email. Body: { businessId, message, subject?,
   * visitorDisplayName? }. Response includes the visitor_token the
   * client must hold onto and send back as X-Visitor-Token on every
   * later request to this thread — this is the ONLY response that ever
   * contains it; it cannot be recovered later if lost. There's
   * deliberately no "forgot my token" recovery flow, since that would
   * need to weaken the exact boundary the token exists to enforce. A
   * lost token just means starting a new conversation.
   *
   * The token is generated HERE, in TypeScript, via node:crypto's
   * randomUUID() (a real CSPRNG, same security property as pgcrypto's
   * gen_random_uuid() used everywhere else in this schema) — NOT inside
   * the SQL the way every other id in this project is generated. That's
   * a deliberate, tested-into exception: the first version of this route
   * generated the token via gen_random_uuid() inside the INSERT and used
   * withPublicAccess (no session variable set at all). That failed with
   * "new row violates row-level security policy for table conversations"
   * — not on the INSERT's WITH CHECK (which was satisfiable), but on the
   * IMPLICIT SELECT that RETURNING performs on the newly-inserted row,
   * which is governed by conversations' SELECT policy
   * (visitor_token_access: visitor_token = current_setting(...)). With
   * no session variable set, and the token only existing inside the SQL
   * itself, there was no way for that implicit read-back to ever
   * succeed. Generating the token in TypeScript first and using
   * withVisitorAccess (which SET LOCALs app.visitor_token before running
   * any query) means the session variable matches the row this same
   * request is about to create, so RETURNING's implicit SELECT succeeds
   * the normal way — this required actually running the request and
   * reading the real Postgres error to find, not something visible from
   * reading the RLS policy in isolation.
   */
  fastify.post<{
    Body: { businessId?: string; message?: string; subject?: string; visitorDisplayName?: string };
  }>('/conversations', { preHandler: [rateLimitHook(limits.conversationStart, byIp)] }, async (request, reply) => {
    const { businessId, message, subject, visitorDisplayName } = request.body ?? {};
    if (!businessId || !isValidUuid(businessId)) {
      reply.code(400).send({ error: 'bad_request', message: 'businessId is required and must be a valid id' });
      return;
    }
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      reply.code(400).send({ error: 'bad_request', message: 'message is required' });
      return;
    }
    if (message.length > 8000) {
      reply.code(400).send({ error: 'bad_request', message: 'message is too long (max 8000 characters)' });
      return;
    }

    const visitorToken = randomUUID();

    const result = await withVisitorAccess(visitorToken, async (client) => {
      const convResult = await client.query(
        `INSERT INTO conversations (business_id, kind, visitor_token, visitor_display_name, subject)
         VALUES ($1, 'consumer', $2, $3, $4)
         RETURNING id, business_id, kind, counterparty_id, visitor_display_name, subject, created_at, last_message_at, handled_by, claimed_by_person_id`,
        [businessId, visitorToken, visitorDisplayName ?? null, subject ?? null],
      );
      const conversation = convResult.rows[0];

      const msgResult = await client.query(
        `INSERT INTO messages (conversation_id, sender_type, body)
         VALUES ($1, 'visitor', $2)
         RETURNING id, conversation_id, sender_type, sender_person_id, body, created_at`,
        [conversation.id, message],
      );

      await client.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [
        conversation.id,
      ]);

      return { conversation, message: msgResult.rows[0] };
    });

    reply.code(201).send({
      visitorToken,
      conversation: conversationShape(result.conversation),
      message: messageShape(result.message),
    });
  });

  /**
   * GET /conversations/:id — the thread plus its messages, for a visitor
   * holding the right token. X-Visitor-Token header required; RLS does
   * the real enforcement (see file header), this just gives a clean 401
   * instead of a confusing empty result when the header is missing or
   * malformed, and a clean 404 when it's well-formed but wrong/doesn't
   * match (RLS returns zero rows either way — this route can't actually
   * distinguish "wrong token" from "conversation doesn't exist," and
   * deliberately doesn't try to, same not-found-vs-forbidden reasoning
   * every other :id route in this codebase already uses).
   */
  fastify.get<{ Params: { id: string } }>('/conversations/:id', async (request, reply) => {
    const token = getVisitorToken(request);
    if (!token) {
      reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
      return;
    }
    if (!isValidUuid(request.params.id)) {
      reply.code(400).send({ error: 'bad_request', message: 'Invalid conversation id' });
      return;
    }

    const result = await withVisitorAccess(token, async (client) => {
      const convResult = await client.query(
        `SELECT id, business_id, kind, counterparty_id, visitor_display_name, subject, created_at, last_message_at, handled_by, claimed_by_person_id
         FROM conversations WHERE id = $1`,
        [request.params.id],
      );
      if (convResult.rows.length === 0) return null;

      const msgResult = await client.query(
        `SELECT id, conversation_id, sender_type, sender_person_id, body, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [request.params.id],
      );
      return { conversation: convResult.rows[0], messages: msgResult.rows };
    });

    if (result === null) {
      reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
      return;
    }
    reply.send({
      conversation: conversationShape(result.conversation),
      messages: result.messages.map(messageShape),
    });
  });

  /**
   * POST /conversations/:id/messages — a visitor replying in their own
   * thread. Same token requirement as GET.
   */
  fastify.post<{ Params: { id: string }; Body: { message?: string } }>(
    '/conversations/:id/messages',
    { preHandler: [rateLimitHook(limits.chatMessage, byIp)] },
    async (request, reply) => {
      const token = getVisitorToken(request);
      if (!token) {
        reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
        return;
      }
      if (!isValidUuid(request.params.id)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid conversation id' });
        return;
      }
      const { message } = request.body ?? {};
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        reply.code(400).send({ error: 'bad_request', message: 'message is required' });
        return;
      }
      if (message.length > 8000) {
        reply.code(400).send({ error: 'bad_request', message: 'message is too long (max 8000 characters)' });
        return;
      }

      let insertFailed = false;
      const row = await withVisitorAccess(token, async (client) => {
        const msgResult = await client.query(
          `INSERT INTO messages (conversation_id, sender_type, body)
           VALUES ($1, 'visitor', $2)
           RETURNING id, conversation_id, sender_type, sender_person_id, body, created_at`,
          [request.params.id, message],
        );
        await client.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [
          request.params.id,
        ]);
        return msgResult.rows[0];
      }).catch((err: unknown) => {
        // A permission-denied here means RLS's WITH CHECK refused the
        // insert — the token didn't actually match this
        // conversation_id. Surfaced as 404, same not-found-vs-forbidden
        // reasoning as GET above, rather than the generic 403 server.ts
        // would otherwise produce ("insufficient privileges" reads as a
        // role problem, confusing for a visitor with just the wrong
        // token for this one thread).
        if ((err as { code?: string }).code === '42501') {
          insertFailed = true;
          return null;
        }
        throw err;
      });

      if (insertFailed || row === null) {
        reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
        return;
      }
      reply.code(201).send(messageShape(row));
    },
  );

  /**
   * POST /conversations/:id/identify — the "enticed but not required"
   * moment. Body: { name, email }. Delegates entirely to
   * identify_conversation() (migration 013) — this route does no
   * counterparty logic itself, just input shape validation and turning
   * the function's NULL-on-wrong-token return into a clean 403.
   */
  fastify.post<{ Params: { id: string }; Body: { name?: string; email?: string } }>(
    '/conversations/:id/identify',
    { preHandler: [rateLimitHook(limits.identify, byIp)] },
    async (request, reply) => {
      const token = getVisitorToken(request);
      if (!token) {
        reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
        return;
      }
      if (!isValidUuid(request.params.id)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid conversation id' });
        return;
      }
      const { name, email } = request.body ?? {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        reply.code(400).send({ error: 'bad_request', message: 'name is required' });
        return;
      }
      if (!email || !EMAIL_RE.test(email)) {
        reply.code(400).send({ error: 'bad_request', message: 'A valid email is required' });
        return;
      }

      const counterpartyId = await withVisitorAccess(token, async (client) => {
        const result = await client.query<{ identify_conversation: string | null }>(
          `SELECT identify_conversation($1, $2, $3, $4) AS identify_conversation`,
          [request.params.id, token, name, email],
        );
        return result.rows[0].identify_conversation;
      });

      if (counterpartyId === null) {
        reply.code(403).send({
          error: 'forbidden',
          message: 'This token does not match this conversation',
        });
        return;
      }
      reply.send({ identified: true, counterpartyId });
    },
  );

  /**
   * POST /conversations/:id/redeem-token — the actual escalation
   * trigger. Body: { transactionToken }. Delegates entirely to
   * redeem_transaction_token() (migration 016), which checks
   * everything: the conversation must already be identified
   * (POST .../identify must have succeeded first — "evidence of ...
   * payment AND self-identification," both conditions, not either), the
   * token must be real, unredeemed, and belong to the SAME counterparty
   * this conversation identified as. A successful redemption transitions
   * conversations.handled_by to 'awaiting_human' as a side effect inside
   * the function itself — this route doesn't separately set that state,
   * so there's exactly one place that transition can happen from.
   */
  fastify.post<{ Params: { id: string }; Body: { transactionToken?: string } }>(
    '/conversations/:id/redeem-token',
    { preHandler: [rateLimitHook(limits.identify, byIp)] },
    async (request, reply) => {
      const token = getVisitorToken(request);
      if (!token) {
        reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
        return;
      }
      if (!isValidUuid(request.params.id)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid conversation id' });
        return;
      }
      const { transactionToken } = request.body ?? {};
      if (!transactionToken || !isValidUuid(transactionToken)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: 'transactionToken is required and must be a valid token' });
        return;
      }

      const outcome = await withVisitorAccess(token, async (client) => {
        const result = await client.query<{ redeem_transaction_token: { success: boolean; reason: string | null } }>(
          `SELECT redeem_transaction_token($1, $2, $3) AS redeem_transaction_token`,
          [request.params.id, token, transactionToken],
        );
        return result.rows[0].redeem_transaction_token;
      });

      if (!outcome.success) {
        // Every failure reason maps to 403 — none of them mean "you're
        // missing something you could just retry with different shape,"
        // they all mean "this specific token/conversation pairing isn't
        // valid," which is what 403 communicates. The `reason` field
        // gives the caller (a real frontend, not an attacker probing)
        // enough to show a sensible message — "please identify yourself
        // first" reads very differently from "that code doesn't look
        // right" — without this route needing a different HTTP status
        // per case.
        reply.code(403).send({ error: 'forbidden', message: 'Token could not be redeemed', reason: outcome.reason });
        return;
      }
      // The database function already moved the conversation to
      // awaiting_human. This is the step that actually tells a person:
      // in-app notifications for eligible staff plus an email. A failure
      // here must not undo or fail the redemption itself.
      try {
        await requestHandoff(request.params.id, token, 'visitor_token_redeemed', request.log);
      } catch (err) {
        request.log.error({ err }, 'handoff notification failed after token redemption');
      }
      reply.send({ escalated: true });
    },
  );

  // ============ BUSINESS-FACING (authenticated, normal JWT pattern) ============

  /**
   * GET /conversations?businessId=... — the sales inbox. Ordinary
   * withDb/RLS pattern, same as every other authenticated route; the
   * tenant_isolation policy on conversations (migration 012) narrows
   * this the same way every other business-scoped table is narrowed.
   */
  fastify.get<{ Querystring: { businessId?: string } }>(
    '/conversations',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, kind, counterparty_id, visitor_display_name, subject, created_at, last_message_at, handled_by, claimed_by_person_id, handoff_reason, handoff_at
         FROM conversations
         WHERE business_id = $1 AND kind = 'consumer'
         ORDER BY last_message_at DESC`,
        [businessId],
      );
      return result.rows.map(conversationShape);
    }),
  );

  /**
   * GET /conversations/business/:id — a specific thread, business side.
   * Separate path from the visitor-facing GET /conversations/:id above
   * (same resource, two very different auth mechanisms — token header vs
   * JWT — so they need to be distinguishable at the routing level, not
   * just by which header happens to be present).
   */
  fastify.get<{ Params: { id: string } }>(
    '/conversations/business/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const convResult = await request.db.query(
        `SELECT id, business_id, kind, counterparty_id, visitor_display_name, subject, created_at, last_message_at, handled_by, claimed_by_person_id, handoff_reason, handoff_at
         FROM conversations WHERE id = $1`,
        [request.params.id],
      );
      if (convResult.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
        return;
      }
      const msgResult = await request.db.query(
        `SELECT id, conversation_id, sender_type, sender_person_id, body, created_at
         FROM messages WHERE conversation_id = $1 ORDER BY created_at ASC`,
        [request.params.id],
      );
      return {
        conversation: conversationShape(convResult.rows[0]),
        messages: msgResult.rows.map(messageShape),
      };
    }),
  );

  /**
   * POST /conversations/business/:id/messages — staff replying.
   * sender_person_id comes from the JWT (request.user.personId), never
   * the request body — same "never trust the body for who's acting"
   * discipline as businessId on every authenticated POST in this
   * codebase.
   */
  fastify.post<{ Params: { id: string }; Body: { message?: string } }>(
    '/conversations/business/:id/messages',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { message } = request.body ?? {};
      if (!message || typeof message !== 'string' || message.trim().length === 0) {
        reply.code(400).send({ error: 'bad_request', message: 'message is required' });
        return;
      }
      if (message.length > 8000) {
        reply.code(400).send({ error: 'bad_request', message: 'message is too long (max 8000 characters)' });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO messages (conversation_id, sender_type, sender_person_id, body)
         VALUES ($1, 'person', $2, $3)
         RETURNING id, conversation_id, sender_type, sender_person_id, body, created_at`,
        [request.params.id, request.user.personId, message],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
        return;
      }
      await request.db.query(`UPDATE conversations SET last_message_at = now() WHERE id = $1`, [
        request.params.id,
      ]);
      reply.code(201).send(messageShape(result.rows[0]));
    }),
  );

  /**
   * GET /conversations/business/:id/routing-candidates — for an
   * 'awaiting_human' conversation, who's eligible to claim it, ranked by
   * how well their declared transaction_paths match this conversation's
   * consumer_region_label. See migration 015's file-level comment for
   * what "closest" honestly means here: this is REGION-LABEL matching,
   * not geographic distance — there is no consumer coordinate to measure
   * distance from, only a free-text label the AI extracted from
   * conversation. Ranking, in order:
   *   1. A transaction_paths row with region_label exactly matching
   *      consumer_region_label (case-insensitive) — the strongest
   *      available signal.
   *   2. A transaction_paths row with region_label IS NULL — "handles
   *      this transaction type anywhere," a real fallback, not a
   *      placeholder.
   *   3. Everyone else at the business who has SOME location set
   *      (people.latitude/longitude/location_label not null) but no
   *      matching transaction_paths row at all — listed last, as a
   *      genuine fallback pool, not filtered out entirely (a small
   *      business might have only one person, with no transaction_paths
   *      configured yet at all, and should still be shown as a
   *      candidate rather than the endpoint returning nobody).
   * People with no location set at all are still included (a business
   * shouldn't be unable to route to its own only employee just because
   * they haven't filled in a location field yet) but ranked last within
   * their tier and flagged with hasLocation: false, so a client UI can
   * make that visible rather than silently pretend proximity data exists
   * where it doesn't.
   */
  fastify.get<{ Params: { id: string } }>(
    '/conversations/business/:id/routing-candidates',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const convResult = await request.db.query(
        `SELECT business_id, consumer_region_label, handled_by FROM conversations WHERE id = $1`,
        [request.params.id],
      );
      if (convResult.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
        return;
      }
      const { business_id: businessId, consumer_region_label: regionLabel } = convResult.rows[0];

      // Deliberately select exactly the columns this endpoint needs from
      // people — never SELECT * here. email specifically is excluded:
      // this is a routing/claim-eligibility view, not a staff directory,
      // and there's no reason a routing-candidates lookup needs to
      // surface every candidate's email address.
      const result = await request.db.query(
        `SELECT
           p.id AS person_id,
           p.name,
           p.role,
           p.latitude,
           p.longitude,
           p.location_label,
           (tp.region_label IS NOT NULL AND lower(tp.region_label) = lower($2)) AS exact_region_match,
           (tp.id IS NOT NULL AND tp.region_label IS NULL) AS handles_anywhere
         FROM people p
         LEFT JOIN transaction_paths tp ON tp.person_id = p.id
           AND (tp.region_label IS NULL OR lower(tp.region_label) = lower($2))
         WHERE p.holding_company_id = (SELECT holding_company_id FROM businesses WHERE id = $1)
           AND p.role IN ('owner', 'worker')
         ORDER BY exact_region_match DESC, handles_anywhere DESC, (p.latitude IS NOT NULL) DESC, p.name ASC`,
        [businessId, regionLabel ?? ''],
      );

      return {
        conversationHandledBy: convResult.rows[0].handled_by,
        consumerRegionLabel: regionLabel,
        candidates: result.rows.map((row) => ({
          personId: row.person_id,
          name: row.name,
          role: row.role,
          hasLocation: row.latitude !== null,
          locationLabel: row.location_label,
          exactRegionMatch: row.exact_region_match,
          handlesAnywhere: row.handles_anywhere,
        })),
      };
    }),
  );

  /**
   * POST /conversations/business/:id/claim — a staff member takes
   * ownership of an 'awaiting_human' conversation. Sets both
   * claimed_by_person_id AND handled_by = 'staff' in one statement — a
   * conversation is either claimed-and-staff-handled or it isn't; there's
   * no state where claimed_by_person_id is set but handled_by still says
   * 'awaiting_human' (or vice versa), so both change together rather
   * than as two separate updates that could theoretically be observed
   * mid-transition.
   *
   * Does NOT restrict which person can claim to only the routing
   * candidates the previous endpoint would suggest — routing-candidates
   * is a RECOMMENDATION for who a client UI should show as suggested
   * claimants, not an access-control boundary. Any owner/worker at a
   * visible business can claim any of that business's conversations,
   * same as they can already reply to any of them via POST .../messages
   * — restricting claiming specifically to "only people whose declared
   * transaction_paths match" would mean a conversation nobody's declared
   * paths happen to match could never be claimed by anyone, which is a
   * worse failure mode than "the suggested-closest person didn't grab it
   * first."
   */
  fastify.post<{ Params: { id: string } }>(
    '/conversations/business/:id/claim',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `UPDATE conversations
         SET claimed_by_person_id = $2, handled_by = 'staff'
         WHERE id = $1
         RETURNING id, business_id, kind, counterparty_id, visitor_display_name, subject, created_at, last_message_at, handled_by, claimed_by_person_id`,
        [request.params.id, request.user.personId],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Conversation not found' });
        return;
      }
      reply.send(conversationShape(result.rows[0]));
    }),
  );
}
