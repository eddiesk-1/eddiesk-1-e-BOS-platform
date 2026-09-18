import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

type CounterpartyRole = 'customer' | 'supplier' | 'buyer' | 'lead';

interface CreateCounterpartyBody {
  businessId: string;
  name: string;
  roles: CounterpartyRole[];
  contact?: Record<string, unknown>;
}

interface UpdateCounterpartyBody {
  name?: string;
  roles?: CounterpartyRole[];
  contact?: Record<string, unknown>;
}

const VALID_ROLES: CounterpartyRole[] = ['customer', 'supplier', 'buyer', 'lead'];

/**
 * Mirrors the table's own CHECK (roles <@ ARRAY['customer','supplier',
 * 'buyer','lead']) constraint at the application layer, so a bad roles
 * array fails with a clear 400 and a specific message rather than a raw
 * Postgres check-violation (mapped by server.ts's 23514 handler to a
 * generic "Value violates a database check constraint," which doesn't say
 * which value or which constraint). The database constraint stays as the
 * backstop either way — this validation existing doesn't make it
 * redundant, since anything writing to this table outside this route
 * (a script, a future service) still goes through the real constraint.
 */
function validateRoles(
  roles: unknown,
): { valid: true; roles: CounterpartyRole[] } | { valid: false; reason: string } {
  if (!Array.isArray(roles) || roles.length === 0) {
    return { valid: false, reason: 'roles must be a non-empty array' };
  }
  for (const role of roles) {
    if (!VALID_ROLES.includes(role as CounterpartyRole)) {
      return {
        valid: false,
        reason: `roles contains an invalid value "${role}" — must be one of ${VALID_ROLES.join(', ')}`,
      };
    }
  }
  return { valid: true, roles: Array.from(new Set(roles)) as CounterpartyRole[] };
}

function toApiShape(row: {
  id: string;
  business_id: string;
  name: string;
  roles: CounterpartyRole[];
  contact: Record<string, unknown>;
}) {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    roles: row.roles,
    contact: row.contact,
  };
}

export default async function counterpartyRoutes(fastify: FastifyInstance) {
  // GET /counterparties?businessId=...&role=... — role is optional and
  // filters to counterparties that include that role among possibly
  // several (e.g. ?role=supplier finds every supplier, whether or not
  // they're ALSO tagged customer/buyer/lead). Backed by the GIN index on
  // counterparties(roles) from migration 005, built specifically for this
  // "find every counterparty with role X" access pattern called out in
  // the contract's own comment on this table.
  fastify.get<{ Querystring: { businessId?: string; role?: string } }>(
    '/counterparties',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, role } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      if (role !== undefined && !VALID_ROLES.includes(role as CounterpartyRole)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: `role must be one of ${VALID_ROLES.join(', ')}` });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, name, roles, contact
         FROM counterparties
         WHERE business_id = $1 AND ($2::text IS NULL OR roles @> ARRAY[$2::text])
         ORDER BY name ASC`,
        [businessId, role ?? null],
      );
      return result.rows.map(toApiShape);
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/counterparties/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_id, name, roles, contact FROM counterparties WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Counterparty not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.post<{ Body: CreateCounterpartyBody }>(
    '/counterparties',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, name, roles, contact } = request.body ?? ({} as CreateCounterpartyBody);
      if (!businessId || !name || !roles) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: 'businessId, name, and roles are all required' });
        return;
      }
      const validation = validateRoles(roles);
      if (!validation.valid) {
        reply.code(400).send({ error: 'bad_request', message: validation.reason });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO counterparties (business_id, name, roles, contact)
         VALUES ($1, $2, $3, $4)
         RETURNING id, business_id, name, roles, contact`,
        [businessId, name, validation.roles, JSON.stringify(contact ?? {})],
      );
      reply.code(201).send(toApiShape(result.rows[0]));
    }),
  );

  fastify.patch<{ Params: { id: string }; Body: UpdateCounterpartyBody }>(
    '/counterparties/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { name, roles, contact } = request.body ?? ({} as UpdateCounterpartyBody);
      if (name === undefined && roles === undefined && contact === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      let validatedRoles: CounterpartyRole[] | null = null;
      if (roles !== undefined) {
        const validation = validateRoles(roles);
        if (!validation.valid) {
          reply.code(400).send({ error: 'bad_request', message: validation.reason });
          return;
        }
        validatedRoles = validation.roles;
      }
      const result = await request.db.query(
        `UPDATE counterparties
         SET name = COALESCE($2, name),
             roles = COALESCE($3, roles),
             contact = COALESCE($4::jsonb, contact)
         WHERE id = $1
         RETURNING id, business_id, name, roles, contact`,
        [
          request.params.id,
          name ?? null,
          validatedRoles,
          contact !== undefined ? JSON.stringify(contact) : null,
        ],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Counterparty not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // DELETE /counterparties/:id — orders.counterparty_id has ON DELETE
  // RESTRICT (migration 005): a counterparty with any order history can't
  // be deleted outright, since that would orphan the order's record of
  // who it was with. Refused as a 400 via the 23503 handler in server.ts
  // if any order still references this counterparty.
  fastify.delete<{ Params: { id: string } }>(
    '/counterparties/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `DELETE FROM counterparties WHERE id = $1 RETURNING id`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Counterparty not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
