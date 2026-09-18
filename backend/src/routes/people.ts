import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

type PersonRole = 'owner' | 'partner' | 'worker';

interface CreatePersonBody {
  name: string;
  role: PersonRole;
  email: string;
}

interface UpdatePersonBody {
  name?: string;
  role?: PersonRole;
  email?: string;
}

const VALID_ROLES: PersonRole[] = ['owner', 'partner', 'worker'];

function toApiShape(row: {
  id: string;
  holding_company_id: string;
  name: string;
  role: PersonRole;
  email: string;
}) {
  return {
    id: row.id,
    holdingCompanyId: row.holding_company_id,
    name: row.name,
    role: row.role,
    email: row.email,
  };
}

export default async function peopleRoutes(fastify: FastifyInstance) {
  // GET /people — everyone in the caller's holding company. Note this is
  // NOT narrowed by partnerships the way businesses is for partner
  // sessions — people's RLS policy (migration 001... actually 004) scopes
  // by holding_company_id only. A partner can see the full roster of
  // people in the holding company even though they can only see the
  // subset of businesses they're a partner in; the contract doesn't ask
  // for people-list narrowing, and org-roster visibility being broader
  // than business-financial visibility is a reasonable default rather
  // than an oversight — flagged here explicitly in case that's not what's
  // wanted going forward.
  fastify.get(
    '/people',
    { preHandler: [fastify.authenticate] },
    withDb(async (request) => {
      const result = await request.db.query(
        `SELECT id, holding_company_id, name, role, email FROM people ORDER BY name ASC`,
      );
      return result.rows.map(toApiShape);
    }),
  );

  /**
   * PATCH /people/me/location — self-service: a member sets or updates
   * their OWN location. "me" resolves to request.user.personId from the
   * JWT, never a request body or path param — a member can only ever
   * change their own location this way, matching the brief's "members
   * add and change their own location." Registered here, before
   * GET /people/:id below, so the literal path /people/me/location is
   * matched before Fastify would otherwise need "me" to satisfy a :id
   * param.
   *
   * latitude/longitude/locationLabel are all optional and independent of
   * each other in the request, but the DATABASE constraint
   * (people_lat_long_together, migration 015) requires lat and long to
   * be both-null or both-set — passing only one of the two fails at the
   * database layer with a 23514 check-violation, mapped to a clean 400
   * by server.ts. locationLabel can be set alone (a member who knows
   * their region but hasn't looked up exact coordinates) or alongside
   * coordinates.
   */
  fastify.patch<{
    Body: { latitude?: number | null; longitude?: number | null; locationLabel?: string | null };
  }>(
    '/people/me/location',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { latitude, longitude, locationLabel } = request.body ?? {};
      if (latitude === undefined && longitude === undefined && locationLabel === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      if (latitude !== undefined && latitude !== null && (latitude < -90 || latitude > 90)) {
        reply.code(400).send({ error: 'bad_request', message: 'latitude must be between -90 and 90' });
        return;
      }
      if (longitude !== undefined && longitude !== null && (longitude < -180 || longitude > 180)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: 'longitude must be between -180 and 180' });
        return;
      }
      // Both-or-neither is a database constraint (people_lat_long_together,
      // migration 015), but the check needs to run against the RESULTING
      // row, not just the two incoming fields in isolation — a PATCH that
      // only touches locationLabel shouldn't trip this if lat/long are
      // already both set from an earlier call. Without this app-level
      // check, sending only one of the two on a person's FIRST call (both
      // currently NULL) fell through to the raw database error — a bare
      // "Value violates a database check constraint" with no indication
      // of which field or what the actual rule is. Found while writing
      // the frontend spec and checking this route's real behavior against
      // what the spec claimed, not from a design review.
      if (latitude !== undefined || longitude !== undefined) {
        const currentResult = await request.db.query(
          `SELECT latitude, longitude FROM people WHERE id = $1`,
          [request.user.personId],
        );
        const current = currentResult.rows[0];
        const resultingLat = latitude !== undefined ? latitude : current?.latitude;
        const resultingLong = longitude !== undefined ? longitude : current?.longitude;
        const latSet = resultingLat !== null && resultingLat !== undefined;
        const longSet = resultingLong !== null && resultingLong !== undefined;
        if (latSet !== longSet) {
          reply.code(400).send({
            error: 'bad_request',
            message: 'latitude and longitude must be set together — provide both, or clear both by sending null for both',
          });
          return;
        }
      }
      const result = await request.db.query(
        `UPDATE people
         SET latitude = CASE WHEN $2::boolean THEN $3::numeric ELSE latitude END,
             longitude = CASE WHEN $4::boolean THEN $5::numeric ELSE longitude END,
             location_label = CASE WHEN $6::boolean THEN $7 ELSE location_label END
         WHERE id = $1
         RETURNING id, holding_company_id, name, role, email, latitude, longitude, location_label`,
        [
          request.user.personId,
          latitude !== undefined,
          latitude ?? null,
          longitude !== undefined,
          longitude ?? null,
          locationLabel !== undefined,
          locationLabel ?? null,
        ],
      );
      // Always exactly one row — request.user.personId is a real id from
      // a verified JWT, not a client-supplied value that could fail to
      // match anything.
      const row = result.rows[0];
      reply.send({
        ...toApiShape(row),
        latitude: row.latitude !== null ? parseFloat(row.latitude) : null,
        longitude: row.longitude !== null ? parseFloat(row.longitude) : null,
        locationLabel: row.location_label,
      });
    }),
  );

  /**
   * GET /people/me/transaction-paths and PUT (replace-all) — a member's
   * own declared service scope. PUT rather than POST-per-path: the brief
   * says members "add ... and change their ... transaction paths," and
   * replace-the-whole-set is simpler and less error-prone for a client to
   * reason about than tracking individual path ids for incremental
   * add/remove — a member reviewing "here's everywhere I currently
   * handle" and resubmitting the corrected full list is a natural UI
   * shape for this. If per-path add/remove turns out to be needed later
   * (e.g. many paths, editing one shouldn't require resending all), that
   * can be added without removing this endpoint.
   */
  fastify.get(
    '/people/me/transaction-paths',
    { preHandler: [fastify.authenticate] },
    withDb(async (request) => {
      const result = await request.db.query(
        `SELECT id, person_id, region_label, transaction_types, created_at
         FROM transaction_paths WHERE person_id = $1 ORDER BY created_at ASC`,
        [request.user.personId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        personId: row.person_id,
        regionLabel: row.region_label,
        transactionTypes: row.transaction_types,
        createdAt: row.created_at,
      }));
    }),
  );

  fastify.put<{
    Body: { paths?: Array<{ regionLabel?: string | null; transactionTypes: string[] }> };
  }>(
    '/people/me/transaction-paths',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { paths } = request.body ?? {};
      if (!Array.isArray(paths)) {
        reply.code(400).send({ error: 'bad_request', message: 'paths must be an array' });
        return;
      }
      for (const [index, p] of paths.entries()) {
        if (!Array.isArray(p.transactionTypes) || p.transactionTypes.some((t) => typeof t !== 'string')) {
          reply.code(400).send({
            error: 'bad_request',
            message: `paths[${index}].transactionTypes must be an array of strings`,
          });
          return;
        }
      }
      // Replace-all within a single transaction: delete every existing
      // path for this person, then insert the submitted set. Both
      // statements run on request.db, which withDb already wraps in one
      // transaction (see lib/db.ts's withTenantScope) — a failure on the
      // INSERT half rolls back the DELETE half too, so a member never
      // ends up with zero paths because of a mid-request error.
      await request.db.query(`DELETE FROM transaction_paths WHERE person_id = $1`, [
        request.user.personId,
      ]);
      const inserted = [];
      for (const p of paths) {
        const result = await request.db.query(
          `INSERT INTO transaction_paths (person_id, region_label, transaction_types)
           VALUES ($1, $2, $3)
           RETURNING id, person_id, region_label, transaction_types, created_at`,
          [request.user.personId, p.regionLabel ?? null, p.transactionTypes],
        );
        inserted.push(result.rows[0]);
      }
      reply.send(
        inserted.map((row) => ({
          id: row.id,
          personId: row.person_id,
          regionLabel: row.region_label,
          transactionTypes: row.transaction_types,
          createdAt: row.created_at,
        })),
      );
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/people/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, holding_company_id, name, role, email FROM people WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Person not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // POST /people — holding_company_id taken from the JWT, same reasoning
  // as businesses.ts: never trust the request body for which tenant a new
  // row belongs to.
  fastify.post<{ Body: CreatePersonBody }>(
    '/people',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { name, role, email } = request.body ?? ({} as CreatePersonBody);
      if (!name || !role || !email) {
        reply.code(400).send({ error: 'bad_request', message: 'name, role, and email are required' });
        return;
      }
      if (!VALID_ROLES.includes(role)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: `role must be one of ${VALID_ROLES.join(', ')}` });
        return;
      }
      try {
        const result = await request.db.query(
          `INSERT INTO people (holding_company_id, name, role, email)
           VALUES ($1, $2, $3, $4)
           RETURNING id, holding_company_id, name, role, email`,
          [request.user.holdingCompanyId, name, role, email],
        );
        reply.code(201).send(toApiShape(result.rows[0]));
      } catch (err: unknown) {
        // Postgres error code 23505 = unique_violation. The
        // people(holding_company_id, email) unique index (migration 001)
        // is what login depends on to find exactly one row — surface its
        // violation as an ordinary 409, not a generic 500.
        if (isPgUniqueViolation(err)) {
          reply.code(409).send({
            error: 'conflict',
            message: 'A person with this email already exists in this holding company',
          });
          return;
        }
        throw err;
      }
    }),
  );

  fastify.patch<{ Params: { id: string }; Body: UpdatePersonBody }>(
    '/people/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { name, role, email } = request.body ?? ({} as UpdatePersonBody);
      if (name === undefined && role === undefined && email === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      if (role !== undefined && !VALID_ROLES.includes(role)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: `role must be one of ${VALID_ROLES.join(', ')}` });
        return;
      }
      const result = await request.db.query(
        `UPDATE people
         SET name = COALESCE($2, name),
             role = COALESCE($3, role),
             email = COALESCE($4, email)
         WHERE id = $1
         RETURNING id, holding_company_id, name, role, email`,
        [request.params.id, name ?? null, role ?? null, email ?? null],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Person not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/people/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(`DELETE FROM people WHERE id = $1 RETURNING id`, [
        request.params.id,
      ]);
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Person not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}

function isPgUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
