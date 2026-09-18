import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

interface CreatePartnershipBody {
  businessId: string;
  personId: string;
  ownershipPct: number;
  capitalContributed?: number;
}

interface UpdatePartnershipBody {
  ownershipPct?: number;
  capitalContributed?: number;
}

function toApiShape(row: {
  id: string;
  business_id: string;
  person_id: string;
  ownership_pct: string;
  capital_contributed: string;
}) {
  return {
    id: row.id,
    businessId: row.business_id,
    personId: row.person_id,
    // numeric columns come back from pg as strings (arbitrary precision —
    // pg doesn't silently narrow to a JS number). Parsed here at the API
    // boundary rather than left as strings, since ownershipPct is a
    // percentage the client will do arithmetic with; parseFloat is safe at
    // numeric(5,2)'s precision (max 3 significant digits before the
    // decimal). Money columns (ledger_entries.amount, orders.total, etc.)
    // deliberately do NOT get this same treatment — see ledgerEntries.ts.
    ownershipPct: parseFloat(row.ownership_pct),
    capitalContributed: parseFloat(row.capital_contributed),
  };
}

export default async function partnershipRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { businessId?: string } }>(
    '/partnerships',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, person_id, ownership_pct, capital_contributed
         FROM partnerships WHERE business_id = $1`,
        [businessId],
      );
      return result.rows.map(toApiShape);
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/partnerships/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_id, person_id, ownership_pct, capital_contributed
         FROM partnerships WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Partnership not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.post<{ Body: CreatePartnershipBody }>(
    '/partnerships',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, personId, ownershipPct, capitalContributed } =
        request.body ?? ({} as CreatePartnershipBody);
      if (!businessId || !personId || ownershipPct === undefined) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'businessId, personId, and ownershipPct are required',
        });
        return;
      }
      if (ownershipPct < 0 || ownershipPct > 100) {
        reply.code(400).send({ error: 'bad_request', message: 'ownershipPct must be between 0 and 100' });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO partnerships (business_id, person_id, ownership_pct, capital_contributed)
         VALUES ($1, $2, $3, $4)
         RETURNING id, business_id, person_id, ownership_pct, capital_contributed`,
        [businessId, personId, ownershipPct, capitalContributed ?? 0],
      );
      reply.code(201).send(toApiShape(result.rows[0]));
    }),
  );

  fastify.patch<{ Params: { id: string }; Body: UpdatePartnershipBody }>(
    '/partnerships/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { ownershipPct, capitalContributed } = request.body ?? ({} as UpdatePartnershipBody);
      if (ownershipPct === undefined && capitalContributed === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      if (ownershipPct !== undefined && (ownershipPct < 0 || ownershipPct > 100)) {
        reply.code(400).send({ error: 'bad_request', message: 'ownershipPct must be between 0 and 100' });
        return;
      }
      const result = await request.db.query(
        `UPDATE partnerships
         SET ownership_pct = COALESCE($2, ownership_pct),
             capital_contributed = COALESCE($3, capital_contributed)
         WHERE id = $1
         RETURNING id, business_id, person_id, ownership_pct, capital_contributed`,
        [request.params.id, ownershipPct ?? null, capitalContributed ?? null],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Partnership not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/partnerships/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `DELETE FROM partnerships WHERE id = $1 RETURNING id`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Partnership not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
