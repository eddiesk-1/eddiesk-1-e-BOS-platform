import type { FastifyInstance } from 'fastify';
import { withAuthFunctions, scopeToHoldingCompany } from '../lib/db.js';
import { withDb } from '../plugins/tenantContext.js';
import { endSession, forgetSessionVersion, startSession } from '../plugins/auth.js';
import { burnPasswordCheck, verifyPassword } from '../lib/passwordHash.js';
import { lockoutSecondsFor } from '../lib/lockout.js';
import { normalizeEmail, isUuid } from '../lib/validate.js';
import { limits } from '../lib/limits.js';
import { byIp, rateLimitHook } from '../lib/rateLimit.js';
import type { PersonRole } from '../lib/db.js';

interface LoginBody {
  email?: string;
  password?: string;
  /** Optional. Only needed when the same email belongs to several companies. */
  holdingCompanyId?: string;
}

interface Candidate {
  person_id: string;
  holding_company_id: string;
  email_verified: boolean;
  locked_until: Date | null;
  session_version: number;
}

const INVALID = { error: 'invalid_credentials', message: 'Invalid email or password' } as const;
const TOO_MANY = { error: 'too_many_attempts', message: 'Too many sign-in attempts. Please wait a few minutes and try again.' } as const;

type LoginOutcome =
  | { kind: 'ok'; person: { personId: string; holdingCompanyId: string; role: PersonRole; email: string; name: string }; sv: number }
  | { kind: 'invalid' }
  | { kind: 'locked' }
  | { kind: 'unverified' }
  | { kind: 'choose'; companies: Array<{ holdingCompanyId: string; name: string }> };

/**
 * POST /auth/login
 *
 * Email + password. The holding-company UUID used to be required because
 * login had no way to find a tenant on its own; auth_resolve_candidates()
 * (migration 019) now maps a normalised email to the accounts that carry
 * it, so ordinary users type two fields. holdingCompanyId is still
 * accepted (to disambiguate, and for existing API clients).
 *
 * Tenant isolation is unchanged: after the lookup, the transaction is
 * scoped to ONE candidate's holding company (a value the database
 * returned, not the request) before that person's row or password hash is
 * read, and RLS applies exactly as it does for every other request.
 *
 * What the response does and does not reveal:
 *   - unknown email and wrong password are indistinguishable (same body,
 *     status, and — via burnPasswordCheck — roughly the same time);
 *   - an UNVERIFIED account is only identified as such after its password
 *     was proven correct;
 *   - lockout is reported as a generic "too many attempts", and a separate
 *     per-email in-memory limiter produces the same response for emails
 *     that do not exist.
 */
export default async function authRoutes(fastify: FastifyInstance) {
  fastify.post<{ Body: LoginBody }>(
    '/auth/login',
    { preHandler: [rateLimitHook(limits.login, byIp)] },
    async (request, reply) => {
      const body = request.body ?? ({} as LoginBody);
      const email = normalizeEmail(body.email);
      const password = typeof body.password === 'string' ? body.password : '';
      const wantedHc = isUuid(body.holdingCompanyId) ? body.holdingCompanyId : null;

      if (!email || !password || password.length > 1024) {
        reply.code(400).send({ error: 'bad_request', message: 'email and password are required' });
        return;
      }

      if (!limits.loginEmail.check(email).allowed) {
        reply.code(429).send(TOO_MANY);
        return;
      }

      const outcome = await withAuthFunctions<LoginOutcome>(async (client) => {
        const found = await client.query<Candidate>('SELECT * FROM auth_resolve_candidates($1)', [email]);
        let candidates = found.rows;
        if (wantedHc) candidates = candidates.filter((c) => c.holding_company_id === wantedHc);

        if (candidates.length === 0) {
          await burnPasswordCheck(password);
          return { kind: 'invalid' };
        }

        const now = Date.now();
        const matched: Array<{
          cand: Candidate;
          person: { id: string; name: string; role: PersonRole; email: string };
          companyName: string;
        }> = [];
        const failed: Candidate[] = [];
        let lockedCount = 0;

        for (const cand of candidates) {
          if (cand.locked_until && new Date(cand.locked_until).getTime() > now) {
            lockedCount++;
            continue;
          }
          await scopeToHoldingCompany(client, cand.holding_company_id);
          const personRes = await client.query<{ id: string; name: string; role: PersonRole; email: string }>(
            `SELECT id, name, role, email FROM people WHERE id = $1 AND holding_company_id = $2`,
            [cand.person_id, cand.holding_company_id],
          );
          const credRes = await client.query<{ password_hash: string }>(
            `SELECT password_hash FROM credentials WHERE person_id = $1`,
            [cand.person_id],
          );
          if (personRes.rows.length === 0 || credRes.rows.length === 0) {
            await burnPasswordCheck(password);
            continue; // no credentials = nobody ever set a password; same response as wrong password
          }
          const ok = await verifyPassword(password, credRes.rows[0].password_hash);
          if (!ok) {
            failed.push(cand);
            continue;
          }
          const companyRes = await client.query<{ name: string }>(
            `SELECT name FROM holding_companies WHERE id = $1`,
            [cand.holding_company_id],
          );
          matched.push({ cand, person: personRes.rows[0], companyName: companyRes.rows[0]?.name ?? 'Company' });
        }

        if (matched.length === 0) {
          for (const cand of failed) {
            const r = await client.query<{ n: number }>('SELECT auth_record_failure($1) AS n', [cand.person_id]);
            const seconds = lockoutSecondsFor(r.rows[0]?.n ?? 0);
            if (seconds > 0) await client.query('SELECT auth_lock($1, $2)', [cand.person_id, seconds]);
          }
          if (failed.length === 0 && lockedCount > 0) return { kind: 'locked' };
          return { kind: 'invalid' };
        }

        const verified = matched.filter((m) => m.cand.email_verified);
        if (verified.length === 0) return { kind: 'unverified' };

        if (verified.length > 1) {
          return {
            kind: 'choose',
            companies: verified.map((m) => ({ holdingCompanyId: m.cand.holding_company_id, name: m.companyName })),
          };
        }

        const chosen = verified[0];
        await client.query('SELECT auth_record_success($1)', [chosen.cand.person_id]);
        return {
          kind: 'ok',
          sv: chosen.cand.session_version,
          person: {
            personId: chosen.person.id,
            holdingCompanyId: chosen.cand.holding_company_id,
            role: chosen.person.role,
            email: chosen.person.email,
            name: chosen.person.name,
          },
        };
      });

      switch (outcome.kind) {
        case 'invalid':
          reply.code(401).send(INVALID);
          return;
        case 'locked':
          reply.code(429).send(TOO_MANY);
          return;
        case 'unverified':
          reply.code(403).send({
            error: 'email_not_verified',
            message: 'Please confirm your email address first. You can request a new confirmation link.',
          });
          return;
        case 'choose':
          reply.code(409).send({
            error: 'choose_company',
            message: 'This email belongs to more than one company. Choose which one to sign in to.',
            companies: outcome.companies,
          });
          return;
        case 'ok': {
          const { name, ...identity } = outcome.person;
          const token = startSession(fastify, reply, { ...identity, sv: outcome.sv });
          // `token` stays in the body for existing API clients; the browser
          // frontends ignore it and rely on the HttpOnly cookie.
          reply.send({ token, person: { ...identity, name } });
          return;
        }
      }
    },
  );

  // Who am I? Also the cheap way for the frontend to learn whether its
  // cookie is still good on page load.
  fastify.get('/auth/session', { preHandler: [fastify.authenticate] }, async (request) => {
    const { personId, holdingCompanyId, role, email } = request.user;
    return { person: { personId, holdingCompanyId, role, email } };
  });

  fastify.post('/auth/logout', async (_request, reply) => {
    // Clears the cookie. The JWT itself stays valid until it expires or the
    // person's sessions are revoked (POST /auth/logout-everywhere), which is
    // inherent to stateless tokens — see DEPLOY.md "Sessions".
    endSession(reply);
    reply.send({ loggedOut: true });
  });

  fastify.post(
    '/auth/logout-everywhere',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      await request.db.query('SELECT auth_revoke_sessions($1)', [request.user.personId]);
      forgetSessionVersion(request.user.personId);
      endSession(reply);
      return { loggedOut: true, everywhere: true };
    }),
  );
}
