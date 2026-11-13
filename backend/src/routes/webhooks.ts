import type { FastifyInstance } from 'fastify';
import { withPublicAccess } from '../lib/publicDb.js';
import {
  eventKeyFor, mapPaystackStatus, readPaystackConfig, verifyPaystackSignature,
  type PaystackWebhookEvent,
} from '../lib/paystack.js';

/**
 * POST /webhooks/paystack
 *
 * Registered as its own plugin because it replaces the JSON body parser
 * (inside this plugin only — Fastify scopes parsers to the plugin that
 * declares them) with one that keeps the RAW bytes: Paystack signs the
 * exact body it sent, so the signature must be checked against those
 * bytes, not against JSON that was parsed and re-serialised.
 *
 * Order of operations, each step a hard stop:
 *   1. no secret key configured  -> 503 (nothing is accepted)
 *   2. missing/invalid signature -> 401, body ignored entirely
 *   3. body is not an event we can identify -> 200 (ack, nothing to do)
 *   4. payment_apply_event(): idempotent on (provider, event) and checks
 *      amount + currency against our own payment row.
 *
 * Paystack retries on non-2xx, so everything that is a "no-op by design"
 * (duplicate event, unknown reference, event types we ignore) answers 200.
 * A database failure answers 500 so Paystack retries later.
 *
 * Set the webhook URL in the Paystack dashboard to
 *   https://<your-host>/webhooks/paystack
 * Not exercised against live Paystack yet: use the dashboard's
 * "send test webhook" and a test-mode payment before going live.
 */
export default async function webhookRoutes(fastify: FastifyInstance) {
  if (fastify.hasContentTypeParser('application/json')) {
    fastify.removeContentTypeParser('application/json');
  }
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  fastify.post('/webhooks/paystack', async (request, reply) => {
    const cfg = readPaystackConfig();
    if (!cfg) {
      reply.code(503).send({ error: 'payments_disabled' });
      return;
    }
    const raw = request.body;
    if (!Buffer.isBuffer(raw)) {
      request.log.error('webhook body was not a raw buffer; content-type parser not applied');
      reply.code(500).send({ error: 'internal_error' });
      return;
    }
    const signature = request.headers['x-paystack-signature'];
    if (!verifyPaystackSignature(raw, Array.isArray(signature) ? signature[0] : signature, cfg.secretKey)) {
      request.log.warn('paystack webhook rejected: bad signature');
      reply.code(401).send({ error: 'invalid_signature' });
      return;
    }

    let evt: PaystackWebhookEvent;
    try {
      evt = JSON.parse(raw.toString('utf8')) as PaystackWebhookEvent;
    } catch {
      reply.code(200).send({ received: true });
      return;
    }
    const key = eventKeyFor(evt);
    const data = evt.data ?? {};
    if (!key || typeof data.reference !== 'string' || typeof data.amount !== 'number' || typeof data.currency !== 'string') {
      reply.code(200).send({ received: true });
      return;
    }

    // Narrowed values captured in consts: TypeScript does not carry a
    // property narrowing (data.currency is a string) into the callback below.
    const reference = data.reference;
    const amount = data.amount;
    const currency = data.currency.toUpperCase();

    // Only a successful charge can pay. Other event types are stored for
    // the audit trail and otherwise ignored (refunds are not implemented).
    const status = evt.event === 'charge.success' ? mapPaystackStatus(data.status) : 'other';

    const outcome = await withPublicAccess(async (client) => {
      const r = await client.query<{ o: { applied: boolean; reason: string | null } }>(
        'SELECT payment_apply_event($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9::jsonb) AS o',
        ['paystack', key, evt.event ?? 'unknown', reference, status,
         String(amount), currency, String(data.id ?? ''),
         JSON.stringify({ event: evt.event, reference, status: data.status, amount, currency })],
      );
      return r.rows[0].o;
    });
    request.log.info({ key, applied: outcome.applied, reason: outcome.reason }, 'paystack webhook processed');
    reply.code(200).send({ received: true });
  });
}
