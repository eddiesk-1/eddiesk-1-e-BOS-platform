import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool, type PersonRole } from '../lib/db.js';
import {
  CSRF_HEADER,
  SESSION_COOKIE,
  clearSessionCookie,
  parseCookies,
  serializeSessionCookie,
} from '../lib/http.js';

/**
 * JWT payload shape. Every claim a route handler or RLS session-var setup
 * needs is in here — nothing is looked up from the DB again after login to
 * determine who's making a request. (RLS partner-narrowing still queries
 * partnerships live per-request; that's about which BUSINESSES a partner
 * can see, not about re-deriving who the partner IS.)
 *
 * sv  = the person's session_version at issue time. Changing a password or
 *       signing out everywhere bumps the stored version, which makes every
 *       older token fail the check below (revocation for a stateless JWT).
 * use = 'session'. Rejects tokens minted for any other purpose.
 */
export interface AuthPayload {
  personId: string;
  holdingCompanyId: string;
  role: PersonRole;
  email: string;
  sv: number;
  use: 'session';
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  }
}

/** Keep in step with expiresIn: '12h' below. */
export const SESSION_SECONDS = 12 * 60 * 60;
const isProduction = () => process.env.NODE_ENV === 'production';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// ---------------------------------------------------------------- revocation
// Looking the version up on every request would add a database round trip
// to every call, so it is cached for a few seconds. Cost: after a password
// change or "sign out everywhere", another server instance may keep
// honouring an old token for up to CACHE_TTL_MS. On this process the cache
// entry is dropped immediately (forgetSessionVersion).
const CACHE_TTL_MS = 15_000;
const versionCache = new Map<string, { v: number | null; at: number }>();

export function forgetSessionVersion(personId: string): void {
  versionCache.delete(personId);
}

async function currentSessionVersion(personId: string): Promise<number | null> {
  const hit = versionCache.get(personId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.v;

  const client = await pool.connect();
  try {
    await client.query('SET ROLE app_owner_partner');
    const r = await client.query<{ v: number | null }>('SELECT auth_session_version($1) AS v', [personId]);
    const v = r.rows[0]?.v ?? null;
    if (versionCache.size > 5000) versionCache.clear();
    versionCache.set(personId, { v, at: Date.now() });
    return v;
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
}

// ---------------------------------------------------------------- issuing
type HeaderSetter = { header(name: string, value: string): unknown };

export function startSession(
  fastify: FastifyInstance,
  reply: HeaderSetter,
  identity: Omit<AuthPayload, 'use'>,
): string {
  const token = fastify.jwt.sign({ ...identity, use: 'session' }, { expiresIn: '12h' });
  reply.header('Set-Cookie', serializeSessionCookie(token, SESSION_SECONDS, isProduction()));
  return token;
}

export function endSession(reply: HeaderSetter): void {
  reply.header('Set-Cookie', clearSessionCookie(isProduction()));
}

export default fp(async function authPlugin(fastify: FastifyInstance) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not set — see .env.example');
  }

  await fastify.register(jwt, {
    secret: process.env.JWT_SECRET,
    sign: { expiresIn: '12h' },
  });

  // A preHandler every protected route uses via { preHandler: [fastify.authenticate] }.
  //
  // Accepts EITHER credential:
  //   - Authorization: Bearer <jwt>   (API clients, scripts — unchanged)
  //   - the HttpOnly session cookie    (the browser frontends)
  // Bearer wins when both are present.
  //
  // Cookie-authenticated requests that change data must also send the
  // X-Ebos-Client header. A page on another site cannot add a custom
  // header without a CORS preflight, and this server refuses cross-origin
  // preflights, so a forged cross-site form or fetch cannot ride the
  // cookie. (SameSite=Strict on the cookie is the first line of defence;
  // this is the second.)
  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    const header = request.headers.authorization;
    let token: string | null = null;
    let viaCookie = false;

    if (typeof header === 'string' && header.startsWith('Bearer ')) {
      token = header.slice(7).trim();
    } else {
      const fromCookie = parseCookies(request.headers.cookie)[SESSION_COOKIE];
      if (fromCookie) {
        token = fromCookie;
        viaCookie = true;
      }
    }
    if (!token) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid token' });
    }

    let payload: AuthPayload;
    try {
      payload = fastify.jwt.verify<AuthPayload>(token);
    } catch {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid token' });
    }
    if (payload.use !== 'session' || typeof payload.sv !== 'number' || !payload.personId) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid token' });
    }

    if (viaCookie && !SAFE_METHODS.has(request.method) && !request.headers[CSRF_HEADER]) {
      return reply.code(403).send({ error: 'csrf', message: 'Missing client header' });
    }

    let current: number | null;
    try {
      current = await currentSessionVersion(payload.personId);
    } catch (err) {
      // Fail closed, but as 503 — a 401 would make the frontend sign the
      // user out because of a transient database problem.
      request.log.error({ err }, 'session check failed');
      return reply.code(503).send({ error: 'service_unavailable', message: 'Please try again in a moment' });
    }
    if (current === null || current !== payload.sv) {
      return reply.code(401).send({ error: 'unauthorized', message: 'Session expired or revoked' });
    }

    request.user = payload;
    return undefined;
  });
});
