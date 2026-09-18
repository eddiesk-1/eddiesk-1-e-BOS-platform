import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';
import { validateSplitsSumTo100 } from '../lib/allocationRules.js';

interface CreateAllocationRuleBody {
  businessId: string;
  effectiveFrom: string; // ISO 8601
  splits: Array<{ personId: string; pct: number }>;
}

function toApiShape(row: {
  id: string;
  business_id: string;
  version: number;
  effective_from: Date;
  splits: unknown;
}) {
  return {
    id: row.id,
    businessId: row.business_id,
    version: row.version,
    effectiveFrom: row.effective_from,
    splits: row.splits,
  };
}

export default async function allocationRuleRoutes(fastify: FastifyInstance) {
  // GET /allocation-rules?businessId=... — full version history, newest first.
  fastify.get<{ Querystring: { businessId?: string } }>(
    '/allocation-rules',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, version, effective_from, splits
         FROM allocation_rules WHERE business_id = $1 ORDER BY version DESC`,
        [businessId],
      );
      return result.rows.map(toApiShape);
    }),
  );

  // GET /allocation-rules/current?businessId=... — the highest-version
  // rule whose effective_from has already passed, i.e. "what split is in
  // effect right now." Separate from the plain :id lookup below because
  // "what's currently active" is a distinct, common query shape from
  // "give me this exact historical version."
  fastify.get<{ Querystring: { businessId?: string } }>(
    '/allocation-rules/current',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, version, effective_from, splits
         FROM allocation_rules
         WHERE business_id = $1 AND effective_from <= now()
         ORDER BY effective_from DESC, version DESC
         LIMIT 1`,
        [businessId],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({
          error: 'not_found',
          message: 'No allocation rule is currently in effect for this business',
        });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/allocation-rules/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_id, version, effective_from, splits
         FROM allocation_rules WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Allocation rule not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // POST /allocation-rules — rejects any split set that doesn't sum to
  // exactly 100 (validateSplitsSumTo100, see lib/allocationRules.ts), and
  // auto-assigns the next version number for the business rather than
  // accepting one from the client (avoiding a race where two concurrent
  // POSTs both claim to be "version 3" — the unique index on
  // (business_id, version) from migration 002 would catch that as a
  // last-resort 409, but computing MAX(version)+1 inside the same
  // transaction as the insert makes the conflict rare rather than routine).
  fastify.post<{ Body: CreateAllocationRuleBody }>(
    '/allocation-rules',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, effectiveFrom, splits } = request.body ?? ({} as CreateAllocationRuleBody);

      if (!businessId || !effectiveFrom || !splits) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'businessId, effectiveFrom, and splits are all required',
        });
        return;
      }

      const validation = validateSplitsSumTo100(splits);
      if (!validation.valid) {
        reply.code(400).send({ error: 'invalid_splits', message: validation.reason });
        return;
      }

      try {
        const nextVersionResult = await request.db.query(
          `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
           FROM allocation_rules WHERE business_id = $1`,
          [businessId],
        );
        const nextVersion = nextVersionResult.rows[0].next_version;

        const result = await request.db.query(
          `INSERT INTO allocation_rules (business_id, version, effective_from, splits)
           VALUES ($1, $2, $3, $4)
           RETURNING id, business_id, version, effective_from, splits`,
          [businessId, nextVersion, effectiveFrom, JSON.stringify(splits)],
        );
        reply.code(201).send(toApiShape(result.rows[0]));
      } catch (err: unknown) {
        if (isPgUniqueViolation(err)) {
          // Two concurrent POSTs both computed the same next_version
          // before either committed. Rare given the MAX()+1 read happens
          // inside the same transaction, but still possible under
          // concurrent load — surfaced as a 409 so the client knows to
          // retry, not as an opaque 500.
          reply.code(409).send({
            error: 'conflict',
            message: 'Allocation rule version conflict — retry the request',
          });
          return;
        }
        throw err;
      }
    }),
  );

  // Allocation rules are intentionally NOT updatable or deletable via this
  // API — they're an append-only version history (that's what the
  // (business_id, version) unique index and effective_from timestamp are
  // for: reconstructing "what split applied to this specific ledger
  // entry" at any point in time via ledger_entries.allocation_rule_version).
  // Correcting a mistake means POSTing a new version, not mutating an old
  // one that past ledger entries may already reference.
}

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
