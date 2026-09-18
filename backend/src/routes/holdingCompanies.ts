import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

function toApiShape(row: { id: string; name: string; created_at: Date }) {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

export default async function holdingCompanyRoutes(fastify: FastifyInstance) {
  // GET /holding-companies/:id — a caller can only ever fetch their own
  // holding company (RLS on holding_companies is `id =
  // current_setting('app.holding_company_id')`, see migration 004), so
  // there's no unscoped "list all holding companies" endpoint — that would
  // either return just one row for every caller (not useful as a list) or
  // require a super-admin role concept the contract doesn't define. Fetch
  // by :id, where :id is normally the caller's own JWT-carried
  // holdingCompanyId.
  fastify.get<{ Params: { id: string } }>(
    '/holding-companies/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, name, created_at FROM holding_companies WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Holding company not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.patch<{ Params: { id: string }; Body: { name?: string } }>(
    '/holding-companies/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { name } = request.body ?? {};
      if (!name) {
        reply.code(400).send({ error: 'bad_request', message: 'name is required' });
        return;
      }
      const result = await request.db.query(
        `UPDATE holding_companies SET name = $2 WHERE id = $1 RETURNING id, name, created_at`,
        [request.params.id, name],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Holding company not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // No POST here deliberately: creating a NEW holding company means
  // creating a new tenant from scratch, which by definition happens
  // before any person/JWT exists for it — there's no "authenticated
  // caller's holding_company_id" to scope the insert against, unlike
  // every other POST route in this codebase (businesses.ts, people.ts,
  // etc. all take holding_company_id from request.user, never from the
  // request body). That's a fundamentally different operation from
  // everything else in this API — closer to provisioning/bootstrapping
  // than to ordinary authenticated CRUD — and belongs behind its own
  // administrative process (a signup flow, a seed script, an ops tool)
  // rather than a route any JWT holder can call. See README's "Creating
  // the first holding company" section for how to do this locally via a
  // direct psql insert plus the seed script.
  //
  // No DELETE either: deleting a holding company cascades to every
  // business, person, and ledger entry beneath it (ON DELETE CASCADE
  // throughout the schema) — an operation with that blast radius
  // shouldn't be reachable via a plain authenticated DELETE call from any
  // owner's JWT.
}
