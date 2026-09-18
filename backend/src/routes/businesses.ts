import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

interface CreateBusinessBody {
  name: string;
  guideSourceId?: string | null;
}

interface UpdateBusinessBody {
  name?: string;
  guideSourceId?: string | null;
}

/**
 * businesses row -> API shape. camelCase in TS/JSON per the naming rules;
 * this mapping function is the one place that translation happens for
 * this resource, so every route below returns a consistently-shaped
 * object instead of each handler doing its own ad hoc renaming.
 */
function toApiShape(row: {
  id: string;
  holding_company_id: string;
  name: string;
  guide_source_id: string | null;
  created_at: Date;
}) {
  return {
    id: row.id,
    holdingCompanyId: row.holding_company_id,
    name: row.name,
    guideSourceId: row.guide_source_id,
    createdAt: row.created_at,
  };
}

export default async function businessRoutes(fastify: FastifyInstance) {
  // GET /businesses — every business visible to the caller. For an owner
  // or worker session that's every business in their holding company; for
  // a partner session, RLS narrows this automatically to businesses they
  // appear in via partnerships (see is_business_visible_to_caller in
  // migration 004). No WHERE clause here does that narrowing — it doesn't
  // need to, since the RLS policy on `businesses` already applies to this
  // (or any) query against the table on this connection.
  fastify.get(
    '/businesses',
    { preHandler: [fastify.authenticate] },
    withDb(async (request) => {
      const result = await request.db.query(
        `SELECT id, holding_company_id, name, guide_source_id, created_at
         FROM businesses ORDER BY created_at DESC`,
      );
      return result.rows.map(toApiShape);
    }),
  );

  // GET /businesses/:id
  fastify.get<{ Params: { id: string } }>(
    '/businesses/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, holding_company_id, name, guide_source_id, created_at
         FROM businesses WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        // RLS means this 404 covers two genuinely different situations —
        // the business doesn't exist at all, or it exists but this caller
        // isn't allowed to see it (wrong holding company, or a partner who
        // isn't party to it) — and deliberately doesn't distinguish them.
        // Returning 403 for the second case would confirm to an
        // unauthorized caller that a specific business ID is valid, which
        // is exactly the kind of enumeration RLS is meant to prevent.
        reply.code(404).send({ error: 'not_found', message: 'Business not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // POST /businesses — owner and worker DB roles can insert (app_worker
  // has full CRUD grants on `businesses`, per migration 004 — the
  // ledger_entries/allocation_rules restriction is specific to those two
  // tables, not a blanket worker-is-read-only rule). holding_company_id is
  // taken from the JWT, never from the request body, so a caller can't
  // create a business under a holding company they don't belong to.
  fastify.post<{ Body: CreateBusinessBody }>(
    '/businesses',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { name, guideSourceId } = request.body ?? ({} as CreateBusinessBody);
      if (!name || typeof name !== 'string') {
        reply.code(400).send({ error: 'bad_request', message: 'name is required' });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO businesses (holding_company_id, name, guide_source_id)
         VALUES ($1, $2, $3)
         RETURNING id, holding_company_id, name, guide_source_id, created_at`,
        [request.user.holdingCompanyId, name, guideSourceId ?? null],
      );
      reply.code(201).send(toApiShape(result.rows[0]));
    }),
  );

  // PATCH /businesses/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateBusinessBody }>(
    '/businesses/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { name, guideSourceId } = request.body ?? ({} as UpdateBusinessBody);
      if (name === undefined && guideSourceId === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      const result = await request.db.query(
        `UPDATE businesses
         SET name = COALESCE($2, name),
             guide_source_id = CASE WHEN $3::boolean THEN $4::uuid ELSE guide_source_id END
         WHERE id = $1
         RETURNING id, holding_company_id, name, guide_source_id, created_at`,
        [request.params.id, name ?? null, guideSourceId !== undefined, guideSourceId ?? null],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Business not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // DELETE /businesses/:id
  fastify.delete<{ Params: { id: string } }>(
    '/businesses/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(`DELETE FROM businesses WHERE id = $1 RETURNING id`, [
        request.params.id,
      ]);
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Business not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
