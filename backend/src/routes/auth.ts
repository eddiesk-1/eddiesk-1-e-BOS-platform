import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcrypt';
import { pool } from '../lib/db.js';
import type { AuthPayload } from '../plugins/auth.js';

interface LoginBody {
  email: string;
  password: string;
  holdingCompanyId: string;
}

/**
 * POST /auth/login
 *
 * The one route in this service that legitimately runs BEFORE any JWT
 * exists — every other route requires fastify.authenticate to have already
 * verified one. That creates a real chicken-and-egg problem worth being
 * explicit about, because it's the one place tenant scoping works
 * differently from everywhere else in this codebase:
 *
 * people (and everything else RLS-protected) requires
 * app.holding_company_id to already be set as a session variable before a
 * query against it returns anything — that's the whole point of the RLS
 * policy. But at login time, nothing has been authenticated yet, so there
 * is no session to derive that value from. The only source for it is
 * whatever the login request body claims.
 *
 * That's fine, and it's not a bypass of tenant isolation — it's exactly
 * the situation RLS is designed for. This route SETs app.holding_company_id
 * to the value the request body supplies, then looks up the person by
 * (holding_company_id, email). If the caller lied about which holding
 * company they belong to, the lookup simply won't find a matching person
 * row (people(holding_company_id, email) is a unique index — see migration
 * 001 — so this is a single deterministic row or nothing), and the request
 * fails with the same generic "invalid credentials" response as a wrong
 * password. Nothing about supplying an arbitrary holdingCompanyId here
 * grants access to anything; the password check that follows is what
 * actually gates entry, exactly like it would for a service with no
 * multi-tenant structure at all.
 *
 * This route connects via SET ROLE app_owner_partner specifically (not
 * app_worker) for the people lookup, because a role hasn't been
 * established for the caller yet either — app_owner_partner is a superset
 * of app_worker's grants on every table involved here, and neither role
 * differs in what it can see on `people` in the first place (people has no
 * worker restriction, only ledger_entries/allocation_rules do). Once
 * login succeeds, the ISSUED JWT carries the person's real role, and every
 * subsequent request uses that — this route's own internal DB role choice
 * has no bearing on what the returned token can do.
 */
export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: LoginBody }>('/auth/login', async (request, reply) => {
    const { email, password, holdingCompanyId } = request.body ?? ({} as LoginBody);

    if (!email || !password || !holdingCompanyId) {
      reply.code(400).send({
        error: 'bad_request',
        message: 'email, password, and holdingCompanyId are all required',
      });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET ROLE app_owner_partner');
      // See the function-level comment above: this is the one place an
      // unauthenticated claim legitimately sets this session variable.
      await client.query(`SELECT set_config('app.holding_company_id', $1, true)`, [
        holdingCompanyId,
      ]);

      const personResult = await client.query(
        `SELECT id, holding_company_id, name, role, email
         FROM people
         WHERE holding_company_id = $1 AND email = $2`,
        [holdingCompanyId, email],
      );

      if (personResult.rows.length === 0) {
        await client.query('ROLLBACK');
        reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid credentials' });
        return;
      }

      const person = personResult.rows[0];

      const credResult = await client.query(
        `SELECT password_hash FROM credentials WHERE person_id = $1`,
        [person.id],
      );

      if (credResult.rows.length === 0) {
        // A people row with no credentials row means nobody ever set a
        // password for them — same generic response as wrong password, so
        // this endpoint doesn't leak which case it is to the caller.
        await client.query('ROLLBACK');
        reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid credentials' });
        return;
      }

      const passwordMatches = await bcrypt.compare(password, credResult.rows[0].password_hash);
      await client.query('COMMIT');

      if (!passwordMatches) {
        reply.code(401).send({ error: 'invalid_credentials', message: 'Invalid credentials' });
        return;
      }

      const payload: AuthPayload = {
        personId: person.id,
        holdingCompanyId: person.holding_company_id,
        role: person.role,
        email: person.email,
      };
      const token = fastify.jwt.sign(payload);

      reply.send({ token, person: payload });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      client.release();
    }
  });
}
