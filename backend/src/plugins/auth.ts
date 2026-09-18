import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PersonRole } from '../lib/db.js';

/**
 * JWT payload shape. Every claim a route handler or RLS session-var setup
 * needs is in here — nothing is looked up from the DB again after login to
 * determine who's making a request. (RLS partner-narrowing still queries
 * partnerships live per-request; that's about which BUSINESSES a partner
 * can see, not about re-deriving who the partner IS.)
 */
export interface AuthPayload {
  personId: string;
  holdingCompanyId: string;
  role: PersonRole;
  email: string;
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: AuthPayload;
    user: AuthPayload;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
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
  // Verifies the JWT and populates request.user with the AuthPayload above;
  // fails the request with 401 if the token is missing, expired, or invalid.
  fastify.decorate('authenticate', async function (request: FastifyRequest, reply: FastifyReply) {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.code(401).send({ error: 'unauthorized', message: 'Missing or invalid token' });
    }
  });
});
