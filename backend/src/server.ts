import 'dotenv/config';
import { startupWarnings } from './bootstrap.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import authPlugin from './plugins/auth.js';
import tenantContextPlugin from './plugins/tenantContext.js';
import authRoutes from './routes/auth.js';
import holdingCompanyRoutes from './routes/holdingCompanies.js';
import businessRoutes from './routes/businesses.js';
import businessNodeRoutes from './routes/businessNodes.js';
import peopleRoutes from './routes/people.js';
import partnershipRoutes from './routes/partnerships.js';
import allocationRuleRoutes from './routes/allocationRules.js';
import ledgerEntryRoutes from './routes/ledgerEntries.js';
import rollupRoutes from './routes/rollup.js';
import materialRoutes from './routes/materials.js';
import materialFlowRoutes from './routes/materialFlows.js';
import counterpartyRoutes from './routes/counterparties.js';
import orderRoutes from './routes/orders.js';
import orderItemRoutes from './routes/orderItems.js';
import productStreamRoutes from './routes/productStream.js';
import aiRoutes from './routes/ai.js';
import conversationRoutes from './routes/conversations.js';
import guideIngestionRoutes from './routes/guideIngestion.js';
import accountRoutes from './routes/accounts.js';
import notificationRoutes from './routes/notifications.js';
import aiSettingsRoutes from './routes/aiSettings.js';
import checkoutRoutes from './routes/checkout.js';
import webhookRoutes from './routes/webhooks.js';
import { closePool } from './lib/db.js';
import { publicPool } from './lib/publicDb.js';
import { checkReadiness, ownerBypassesRls } from './lib/health.js';
import { limits } from './lib/limits.js';
import { securityHeaders } from './lib/http.js';

const isProduction = process.env.NODE_ENV === 'production';

const fastify = Fastify({
  // Behind Render's proxy request.ip is the proxy unless this is on, which
  // would put every visitor in one rate-limit bucket. Opt out with
  // TRUST_PROXY=false if you run this directly on the internet.
  trustProxy: process.env.TRUST_PROXY ? process.env.TRUST_PROXY === 'true' : Boolean(process.env.RENDER),
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    // Credentials never reach the logs, even if request logging is widened.
    redact: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-visitor-token"]'],
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
  },
});

/**
 * CORS. Registered first, before any route, per @fastify/cors's own
 * documented convention. This backend was built and tested entirely
 * same-origin (this same process now also serves the frontend files —
 * see the static registration below), so CORS was never needed until a
 * real deployment platform (Render, etc.) puts the frontend on a
 * DIFFERENT generated subdomain than the backend, which is a real,
 * likely default on those platforms unless deliberately configured
 * otherwise.
 *
 * ALLOWED_ORIGIN, if set, is treated as the one trusted frontend
 * origin — NOT a wildcard. A wildcard ('*') CORS policy on a backend
 * that also does JWT-authenticated, credentialed requests (this one)
 * is a real security regression, not a convenience: it would let any
 * website's own JavaScript read responses from this API as if it were
 * the legitimate frontend. If ALLOWED_ORIGIN is unset, CORS defaults
 * to same-origin only (Fastify's own default when no origin option is
 * passed) — correct for the common case where this process serves
 * both the API and the static files itself, and a deliberate choice
 * to fail toward "cross-origin requests are blocked" rather than
 * toward "cross-origin requests are silently allowed" if this
 * variable is simply forgotten during a real deployment.
 */
await fastify.register(cors, {
  origin: process.env.ALLOWED_ORIGIN || false,
  credentials: true,
});

// Security headers on EVERY response (API, static HTML, errors).
// JSON responses are also marked no-store: they can contain one person's
// private data and must not be kept by shared caches.
const staticSecurityHeaders = securityHeaders(isProduction);
fastify.addHook('onSend', async (_request, reply, payload) => {
  for (const [name, value] of Object.entries(staticSecurityHeaders)) reply.header(name, value);
  const type = reply.getHeader('content-type');
  if (typeof type === 'string' && type.startsWith('application/json')) reply.header('Cache-Control', 'no-store');
  return payload;
});

// A coarse per-IP ceiling for the whole service; route-specific limits in
// lib/limits.ts are much tighter where it matters. Health checks and
// payment webhooks are exempt (Paystack retries from a small set of IPs).
fastify.addHook('onRequest', async (request, reply) => {
  const url = request.url;
  if (url === '/health' || url === '/ready' || url.startsWith('/webhooks/')) return;
  const result = limits.global.check(request.ip);
  if (!result.allowed) {
    reply.header('Retry-After', String(result.retryAfterSec));
    return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Please slow down.' });
  }
  return;
});

/**
 * Centralized error handler: anything a route handler throws that wasn't
 * already caught and turned into an explicit reply.code(...).send(...)
 * lands here. Postgres errors in particular carry a `code` (SQLSTATE) —
 * surfaced as clear 4xx responses instead of leaking a raw database error
 * message (which could include table/column names or query fragments)
 * into a 500 response body.
 *
 * THIS MUST BE REGISTERED BEFORE fastify.register(...) IS CALLED FOR ANY
 * ROUTE PLUGIN BELOW. That ordering requirement is not cosmetic and not
 * obvious from Fastify's own encapsulation docs (which describe child
 * contexts inheriting a parent's error handler regardless of source
 * order) — it was found by actually reproducing the failure against this
 * codebase, not by reading documentation. The concrete symptom, if this
 * handler is ever moved back below the fastify.register(...) calls: every
 * error thrown inside a route registered via fastify.register(pluginFn)
 * — which is every real route in src/routes/, since each one is a plugin
 * function — falls through to Fastify's own default error handler instead
 * of this one, silently. A worker session querying ledger_entries still
 * gets correctly REFUSED at the database level (REVOKE, migration 004 —
 * that's unaffected), but the response becomes a raw, unstyled 500 with
 * the Postgres error message instead of this handler's clean 403. Isolated
 * with a bare `throw` inside a plugin (no DB, no auth, no async) that
 * failed identically to the real routes, which ruled out RLS/pg/withDb/
 * async-nesting as the cause and pointed at the plugin-registration
 * boundary itself — matching a known Fastify discussion (fastify/fastify
 * #5257, "Why is the custom error handler ignored?") with the exact same
 * registration order and the exact same fix: setErrorHandler before
 * register(), not after.
 */
fastify.setErrorHandler((error, request, reply) => {
  const pgCode = (error as { code?: string }).code;

  if (pgCode === '23505') {
    reply.code(409).send({ error: 'conflict', message: 'A record with these values already exists' });
    return;
  }
  if (pgCode === '23503') {
    // foreign_key_violation — fires for two genuinely different
    // situations that share one SQLSTATE: inserting/updating a row that
    // references an id which doesn't exist, OR deleting a row that
    // something else still references via an ON DELETE RESTRICT
    // constraint (e.g. DELETE /materials/:id while an order_items row
    // still points at it). The message below is written to cover both —
    // an earlier version only described the first case ("Referenced
    // record does not exist"), which reads backwards for the RESTRICT
    // case (the referenced record very much exists; that's exactly why
    // the delete was refused). Found by actually testing DELETE against a
    // RESTRICT-constrained row, not by inspection.
    reply.code(400).send({
      error: 'bad_request',
      message:
        'This operation violates a foreign key constraint — either a referenced record does not exist, or another record still depends on the one you tried to delete',
    });
    return;
  }
  if (pgCode === '23514') {
    reply
      .code(400)
      .send({ error: 'bad_request', message: 'Value violates a database check constraint' });
    return;
  }
  if (pgCode === '22P02') {
    // invalid_text_representation — most commonly a malformed UUID in a
    // path or query parameter (e.g. an empty string reaching a ::uuid
    // cast). Found while testing GET /business-nodes/:id/subtree with an
    // accidentally-empty :id segment, which produced a raw "invalid input
    // syntax for type uuid" 500 instead of a clean 400 — the same class of
    // problem the 42501 mapping above addresses, just for malformed input
    // instead of insufficient privilege.
    reply.code(400).send({ error: 'bad_request', message: 'One or more identifiers are not valid' });
    return;
  }
  if (pgCode === '42501') {
    // insufficient_privilege — this is what a worker session querying
    // ledger_entries/allocation_rules actually raises (see migration
    // 004's REVOKE). Surfaced as 403, not 500: it's an authorization
    // failure the caller caused, not a server malfunction.
    reply.code(403).send({ error: 'forbidden', message: 'Insufficient privileges for this operation' });
    return;
  }

  // Framework-level client errors (malformed JSON, oversized body, wrong
  // content type) carry their own 4xx status. They used to fall through to
  // the 500 below, which told clients the SERVER was broken.
  const clientStatus = (error as { statusCode?: number }).statusCode;
  if (typeof clientStatus === 'number' && clientStatus >= 400 && clientStatus < 500) {
    reply.code(clientStatus).send({
      error: 'bad_request',
      message: clientStatus === 413 ? 'Request body is too large' : 'The request could not be processed',
    });
    return;
  }

  request.log.error(error);
  reply.code(500).send({ error: 'internal_error', message: 'An unexpected error occurred' });
});

// Order matters here too, though for a different, previously-documented
// reason: authPlugin must register before any route using
// fastify.authenticate, since that decorator has to exist on the instance
// before routes registered after it can reference it.
await fastify.register(authPlugin);
await fastify.register(tenantContextPlugin);

await fastify.register(authRoutes);
await fastify.register(holdingCompanyRoutes);
await fastify.register(businessRoutes);
await fastify.register(businessNodeRoutes);
await fastify.register(peopleRoutes);
await fastify.register(partnershipRoutes);
await fastify.register(allocationRuleRoutes);
await fastify.register(ledgerEntryRoutes);
await fastify.register(rollupRoutes);
await fastify.register(materialRoutes);
await fastify.register(materialFlowRoutes);
await fastify.register(counterpartyRoutes);
await fastify.register(orderRoutes);
await fastify.register(orderItemRoutes);
await fastify.register(productStreamRoutes);
await fastify.register(aiRoutes);
await fastify.register(conversationRoutes);
await fastify.register(guideIngestionRoutes);
await fastify.register(accountRoutes);
await fastify.register(notificationRoutes);
await fastify.register(aiSettingsRoutes);
await fastify.register(checkoutRoutes);
// Own plugin: it swaps in a raw-body JSON parser, which Fastify scopes to
// the plugin that declares it (see routes/webhooks.ts).
await fastify.register(webhookRoutes);

/**
 * Serves the two frontend files directly from THIS process — the
 * primary answer to the CORS problem above: if the backend serves the
 * frontend itself, they're same-origin by construction and CORS is
 * simply never exercised in the common case. `public/` is populated by
 * the build step (see package.json's build script) copying
 * ../frontend/*.html here — NOT read directly from a sibling
 * ../frontend directory at runtime, so this service stays
 * self-contained and doesn't depend on a directory layout outside its
 * own folder existing on whatever platform actually runs it.
 *
 * __dirname doesn't exist in ESM — reconstructed from import.meta.url,
 * the standard pattern for this.
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
await fastify.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
});

// The public landing page lives at "/".
fastify.get('/', async (_request, reply) => reply.sendFile('e-bos-landing.html'));

// Liveness: the process is up. Says nothing about dependencies.
fastify.get('/health', async () => ({ status: 'ok' }));

// Readiness: the process can actually serve — both database pools answer.
// Point Render's health check here. The body is deliberately bare: no
// hostnames, no error text, no role names.
fastify.get('/ready', async (_request, reply) => {
  const r = await checkReadiness();
  reply.code(r.ready ? 200 : 503).send({ status: r.ready ? 'ready' : 'unavailable' });
});

const port = Number(process.env.PORT ?? 3000);
try {
  await fastify.listen({ port, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

for (const w of startupWarnings) fastify.log.warn({ variable: w.variable }, w.message);

// SECURITY DEFINER functions only see rows if the migration user bypasses
// RLS (superuser or BYPASSRLS). Say so loudly at startup rather than
// letting chat, AI replies and checkout fail mysteriously later.
const bypass = await ownerBypassesRls();
if (bypass === false) {
  fastify.log.error(
    'Database owner does not bypass row-level security: the SECURITY DEFINER functions (identify, redeem, AI chat, checkout) will not see any rows. See DEPLOY.md "Database role requirement".',
  );
} else if (bypass === null) {
  fastify.log.warn('Could not run the database owner/RLS self-check (is migration 019 applied?).');
}

// Graceful shutdown: stop accepting connections, let in-flight requests
// finish, then close the pools. Render sends SIGTERM on every deploy.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  fastify.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  try {
    await fastify.close();
    await Promise.allSettled([closePool(), publicPool.end()]);
    process.exit(0);
  } catch (err) {
    fastify.log.error(err, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
