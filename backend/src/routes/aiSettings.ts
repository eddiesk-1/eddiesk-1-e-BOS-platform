import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';
import { isUuid } from '../lib/validate.js';

interface SettingsBody {
  retrievalDepth?: number;
  autoEscalation?: boolean;
}

const DEFAULTS = { retrievalDepth: 8, autoEscalation: true };

/**
 * Per-business AI behaviour that the back office can actually change.
 *   retrievalDepth  how many guide chunks the receptionist AI reads per
 *                   reply (1-20). Used by chat_ai_context (migration 020).
 *   autoEscalation  whether pricing / complaint / low-confidence signals
 *                   hand the chat to a person. (An explicit "let me talk
 *                   to a human" is always honoured.)
 * Anyone who can see the business can read; only owners/partners can write
 * (workers have no INSERT/UPDATE grant — the database refuses, 403).
 */
export default async function aiSettingsRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { businessId: string } }>(
    '/businesses/:businessId/ai-settings',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      if (!isUuid(request.params.businessId)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid business id' });
        return;
      }
      const biz = await request.db.query(`SELECT id FROM businesses WHERE id = $1`, [request.params.businessId]);
      if (biz.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Business not found' });
        return;
      }
      const r = await request.db.query(
        `SELECT retrieval_depth, auto_escalation FROM business_ai_settings WHERE business_id = $1`,
        [request.params.businessId],
      );
      if (r.rows.length === 0) return { businessId: request.params.businessId, ...DEFAULTS, isDefault: true };
      return {
        businessId: request.params.businessId,
        retrievalDepth: r.rows[0].retrieval_depth,
        autoEscalation: r.rows[0].auto_escalation,
        isDefault: false,
      };
    }),
  );

  fastify.put<{ Params: { businessId: string }; Body: SettingsBody }>(
    '/businesses/:businessId/ai-settings',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { retrievalDepth, autoEscalation } = request.body ?? {};
      if (!isUuid(request.params.businessId)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid business id' });
        return;
      }
      if (retrievalDepth === undefined && autoEscalation === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Provide retrievalDepth and/or autoEscalation' });
        return;
      }
      if (retrievalDepth !== undefined && (!Number.isInteger(retrievalDepth) || retrievalDepth < 1 || retrievalDepth > 20)) {
        reply.code(400).send({ error: 'bad_request', message: 'retrievalDepth must be a whole number from 1 to 20' });
        return;
      }
      if (autoEscalation !== undefined && typeof autoEscalation !== 'boolean') {
        reply.code(400).send({ error: 'bad_request', message: 'autoEscalation must be true or false' });
        return;
      }
      const r = await request.db.query(
        `INSERT INTO business_ai_settings (business_id, retrieval_depth, auto_escalation, updated_at)
         VALUES ($1, COALESCE($2::int, 8), COALESCE($3::boolean, true), now())
         ON CONFLICT (business_id) DO UPDATE SET
           retrieval_depth = COALESCE($2::int, business_ai_settings.retrieval_depth),
           auto_escalation = COALESCE($3::boolean, business_ai_settings.auto_escalation),
           updated_at = now()
         RETURNING retrieval_depth, auto_escalation`,
        [request.params.businessId, retrievalDepth ?? null, autoEscalation ?? null],
      );
      return {
        businessId: request.params.businessId,
        retrievalDepth: r.rows[0].retrieval_depth,
        autoEscalation: r.rows[0].auto_escalation,
        isDefault: false,
      };
    }),
  );
}
