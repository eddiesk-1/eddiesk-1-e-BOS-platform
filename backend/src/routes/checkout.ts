import type { FastifyInstance } from 'fastify';
import { withVisitorAccess } from '../lib/publicDb.js';
import { withDb } from '../plugins/tenantContext.js';
import { limits } from '../lib/limits.js';
import { byIp, rateLimitHook } from '../lib/rateLimit.js';
import { getVisitorToken, isValidUuid } from './conversations.js';
import {
  initializeTransaction, newReference, readPaystackConfig, verifyTransaction,
} from '../lib/paystack.js';

/**
 * Checkout. Paystack is the only provider wired up.
 *
 * The flow:
 *   1. The visitor has a conversation and has identified (name + email).
 *   2. POST /checkout { conversationId, items:[{materialId, quantity}] }
 *      -> checkout_create() (migration 021) re-reads every price from the
 *      database (the browser's idea of a price is never used), writes a
 *      'pending_payment' order and a payment row, and we ask Paystack for a
 *      hosted payment page. The browser is redirected there (card, mobile
 *      money, bank — whatever Paystack offers for the currency).
 *   3. Paystack calls the signed webhook (routes/webhooks.ts) and/or the
 *      browser returns and calls POST /checkout/:reference/verify, which
 *      asks Paystack's API for the truth. Either path ends in
 *      payment_apply_event(), the only code that can mark a payment paid.
 *   4. GET /checkout/:reference returns the payment state — and, only once
 *      it is paid, the transaction token the chat redeems to bring in a
 *      person ("hand the payment token to the chat").
 *
 * Disabled (503, and GET /checkout/config says so) until PAYSTACK_SECRET_KEY
 * is set.
 */
interface CheckoutBody {
  conversationId?: string;
  items?: Array<{ materialId?: string; quantity?: number }>;
}

const PROVIDER = 'paystack';

function appBase(): string {
  return (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');
}

export default async function checkoutRoutes(fastify: FastifyInstance) {
  fastify.get('/checkout/config', async () => ({
    enabled: readPaystackConfig() !== null,
    provider: PROVIDER,
  }));

  fastify.post<{ Body: CheckoutBody }>(
    '/checkout',
    { preHandler: [rateLimitHook(limits.checkout, byIp)] },
    async (request, reply) => {
      const token = getVisitorToken(request);
      if (!token) {
        reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
        return;
      }
      const cfg = readPaystackConfig();
      if (!cfg) {
        reply.code(503).send({ error: 'payments_disabled', message: 'Online payment is not switched on for this service yet.' });
        return;
      }
      if (!appBase()) {
        reply.code(503).send({ error: 'payments_disabled', message: 'Online payment is not configured (APP_BASE_URL).' });
        return;
      }
      const { conversationId, items } = request.body ?? {};
      if (!isValidUuid(conversationId)) {
        reply.code(400).send({ error: 'bad_request', message: 'conversationId is required' });
        return;
      }
      if (
        !Array.isArray(items) || items.length === 0 || items.length > 50 ||
        !items.every((i) => isValidUuid(i?.materialId) && Number.isInteger(i?.quantity) && (i.quantity as number) >= 1 && (i.quantity as number) <= 100)
      ) {
        reply.code(400).send({ error: 'bad_request', message: 'items must be 1-50 lines of { materialId, quantity: 1-100 }' });
        return;
      }

      const reference = newReference();
      const created = await withVisitorAccess(token, async (client) => {
        const r = await client.query<{ r: CheckoutCreated }>(
          'SELECT checkout_create($1, $2, $3::jsonb, $4, $5) AS r',
          [
            conversationId,
            token,
            JSON.stringify(items.map((i) => ({ material_id: i.materialId, quantity: i.quantity }))),
            reference,
            PROVIDER,
          ],
        );
        return r.rows[0].r;
      });

      if (!created.ok) {
        const messages: Record<string, [number, string]> = {
          conversation_not_found: [404, 'Conversation not found'],
          not_identified: [409, 'Please share your name and email in the chat before buying.'],
          item_unavailable: [409, 'One of the items is no longer available to buy online.'],
          mixed_currency: [409, 'Items priced in different currencies cannot be bought together.'],
          invalid_items: [400, 'The basket is not valid.'],
        };
        const [status, message] = messages[created.reason ?? ''] ?? [400, 'The order could not be created.'];
        reply.code(status).send({ error: created.reason ?? 'bad_request', message });
        return;
      }

      try {
        const init = await initializeTransaction(cfg, {
          email: created.email as string,
          amountMinor: BigInt(created.amount_minor as number | string),
          currency: created.currency as string,
          reference,
          callbackUrl: `${appBase()}/#paid=${reference}`,
          metadata: { orderId: created.order_id, source: 'e-bos' },
        });
        reply.code(201).send({
          reference,
          orderId: created.order_id,
          amountMinor: Number(created.amount_minor),
          currency: created.currency,
          authorizationUrl: init.authorizationUrl,
        });
      } catch (err) {
        // The order and payment rows exist ('initialized'); they simply
        // never get paid. Nothing is claimed to the visitor.
        request.log.error({ err, reference }, 'Paystack initialize failed');
        reply.code(502).send({ error: 'payment_provider_error', message: 'The payment provider could not be reached. Nothing was charged.' });
      }
    },
  );

  // The browser came back from Paystack. This does NOT trust that: it asks
  // Paystack for the transaction's real status and applies that.
  fastify.post<{ Params: { reference: string } }>(
    '/checkout/:reference/verify',
    { preHandler: [rateLimitHook(limits.checkoutVerify, byIp)] },
    async (request, reply) => {
      const token = getVisitorToken(request);
      if (!token) {
        reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
        return;
      }
      const reference = request.params.reference;
      if (!/^[A-Za-z0-9_-]{10,100}$/.test(reference)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid reference' });
        return;
      }
      const cfg = readPaystackConfig();
      if (!cfg) {
        reply.code(503).send({ error: 'payments_disabled', message: 'Online payment is not switched on for this service yet.' });
        return;
      }

      const view = await visitorView(reference, token);
      if (view === null) {
        reply.code(404).send({ error: 'not_found', message: 'Payment not found' });
        return;
      }

      if (view.status === 'initialized') {
        try {
          const v = await verifyTransaction(cfg, reference);
          await withVisitorAccess(token, (client) =>
            client.query(
              'SELECT payment_apply_event($1, $2, $3, $4, $5, $6::bigint, $7, $8, $9::jsonb)',
              [PROVIDER, `verify:${v.providerTransactionId}:${v.status}`, 'verify', reference, v.status,
               v.amountMinor.toString(), v.currency, v.providerTransactionId, JSON.stringify({ via: 'verify_api', status: v.status })],
            ),
          );
        } catch (err) {
          request.log.warn({ err, reference }, 'Paystack verify failed');
          reply.code(502).send({ error: 'payment_provider_error', message: 'Could not confirm the payment yet. If you were charged, it will appear shortly.' });
          return;
        }
      }
      reply.send(shape(await visitorView(reference, token)));
    },
  );

  fastify.get<{ Params: { reference: string } }>(
    '/checkout/:reference',
    { preHandler: [rateLimitHook(limits.checkoutVerify, byIp)] },
    async (request, reply) => {
      const token = getVisitorToken(request);
      if (!token) {
        reply.code(401).send({ error: 'unauthorized', message: 'X-Visitor-Token header is required' });
        return;
      }
      const view = await visitorView(request.params.reference, token);
      if (view === null) {
        reply.code(404).send({ error: 'not_found', message: 'Payment not found' });
        return;
      }
      reply.send(shape(view));
    },
  );

  // Staff: the payments for one order (owners, partners, workers who can see the business).
  fastify.get<{ Params: { id: string } }>(
    '/orders/:id/payments',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      if (!isValidUuid(request.params.id)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid order id' });
        return;
      }
      const r = await request.db.query(
        `SELECT id, provider, reference, amount_minor, currency, status, paid_at, created_at
         FROM payments WHERE order_id = $1 ORDER BY created_at DESC`,
        [request.params.id],
      );
      return r.rows.map((p) => ({
        id: p.id,
        provider: p.provider,
        reference: p.reference,
        amountMinor: Number(p.amount_minor),
        currency: p.currency,
        status: p.status,
        paidAt: p.paid_at,
        createdAt: p.created_at,
      }));
    }),
  );
}

interface CheckoutCreated {
  ok: boolean;
  reason?: string;
  order_id?: string;
  reference?: string;
  amount_minor?: number | string;
  currency?: string;
  email?: string;
}

interface VisitorPaymentView {
  status: 'initialized' | 'paid' | 'failed' | 'abandoned';
  order_id: string;
  conversation_id: string;
  amount_minor: number | string;
  currency: string;
  transaction_token: string | null;
}

async function visitorView(reference: string, token: string): Promise<VisitorPaymentView | null> {
  return withVisitorAccess(token, async (client) => {
    const r = await client.query<{ v: VisitorPaymentView | null }>(
      'SELECT payment_visitor_view($1, $2) AS v', [reference, token],
    );
    return r.rows[0].v;
  });
}

function shape(v: VisitorPaymentView | null) {
  if (v === null) return null;
  return {
    status: v.status,
    orderId: v.order_id,
    conversationId: v.conversation_id,
    amountMinor: Number(v.amount_minor),
    currency: v.currency,
    // Present only once the payment is confirmed paid.
    transactionToken: v.status === 'paid' ? v.transaction_token : null,
  };
}
