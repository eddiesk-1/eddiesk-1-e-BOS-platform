import fp from 'fastify-plugin';
import type {
  FastifyInstance,
  FastifyRequest,
  FastifyReply,
  RouteGenericInterface,
} from 'fastify';
import type { PoolClient } from 'pg';
import { withTenantScope } from '../lib/db.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * A Postgres client already SET ROLE'd and SET LOCAL'd for the current
     * request's tenant (see src/lib/db.ts). Only populated inside
     * withDb() — see below. Route handlers should never reach for
     * request.server's raw pool directly; that pool connects as app_login,
     * which has zero table grants and will fail every query with
     * "permission denied" (a deliberate design property, not a bug — see
     * db.ts's top comment).
     */
    db: PoolClient;
  }
}

/**
 * withDb wraps a route handler so that request.db is available inside it,
 * scoped via withTenantScope to the calling person's JWT claims
 * (request.user, populated by fastify.authenticate — this plugin assumes
 * that preHandler already ran). Use it like:
 *
 *   fastify.get<{ Params: { id: string } }>('/businesses/:id',
 *     { preHandler: [fastify.authenticate] },
 *     withDb(async (request, reply) => {
 *       // request.params.id is correctly typed as string here
 *       const result = await request.db.query('SELECT * FROM businesses WHERE id = $1', [request.params.id]);
 *       return result.rows;
 *     }));
 *
 * withDb<RouteGeneric> is itself generic over the SAME route-generic
 * interface (Params/Body/Querystring) that fastify.get<...>/post<...>/etc.
 * take. This isn't cosmetic: an earlier version of this function typed its
 * handler parameter as the plain, ungenericized FastifyRequest, which
 * meant that no matter what generic was passed to fastify.get<{ Params:
 * ... }>, TypeScript silently widened request.params back to `unknown`
 * inside every handler wrapped by withDb — the compiler caught this across
 * every route file in this project (`request.params is of type unknown`,
 * `Property 'businessId' does not exist on type '{}'`) the first time
 * `tsc --noEmit` was actually run against the whole codebase, not from
 * reading any individual route file in isolation. TypeScript can usually
 * infer this generic from the handler function you pass in — you don't
 * need to write withDb<{ Params: ... }> explicitly in each route file, as
 * seen in every actual usage under src/routes/.
 */
export function withDb<RouteGeneric extends RouteGenericInterface = RouteGenericInterface, T = unknown>(
  handler: (
    request: FastifyRequest<RouteGeneric>,
    reply: FastifyReply<RouteGeneric>,
  ) => Promise<T>,
) {
  return async (request: FastifyRequest<RouteGeneric>, reply: FastifyReply<RouteGeneric>) => {
    if (!request.user) {
      // Should be unreachable if fastify.authenticate ran first, but this
      // is the difference between "unscoped query" and "clear 401" if a
      // route is ever wired up without the preHandler by mistake.
      //
      // Cast to the untyped FastifyReply for this one send() call: no
      // route in this codebase declares a `Reply` schema in its route
      // generic (only Params/Body/Querystring), so
      // FastifyReply<RouteGeneric>'s reply-schema validation has nothing
      // real to check this object shape against, and TypeScript can't
      // prove `{ error, message }` matches a schema that was never
      // declared. This is the one place in this file that needs the
      // escape hatch — every other reply.send() below goes through the
      // caller-supplied `handler`, which gets the properly-typed
      // FastifyReply<RouteGeneric> and should NOT bypass it.
      (reply as FastifyReply)
        .code(401)
        .send({ error: 'unauthorized', message: 'No authenticated user on request' });
      return;
    }
    return withTenantScope(
      {
        holdingCompanyId: request.user.holdingCompanyId,
        personId: request.user.personId,
        personRole: request.user.role,
      },
      async (client) => {
        request.db = client;
        return handler(request, reply);
      },
    );
  };
}

// Registered as a no-op plugin so it participates in Fastify's plugin
// lifecycle/encapsulation the same way auth.ts does, even though its real
// export is the withDb helper above rather than a decorator.
export default fp(async function tenantContextPlugin(_fastify: FastifyInstance) {});
