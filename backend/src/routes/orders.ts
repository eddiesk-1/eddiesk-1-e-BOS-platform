import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

type OrderDirection = 'sale' | 'purchase';

interface CreateOrderBody {
  businessId: string;
  counterpartyId: string;
  direction: OrderDirection;
  status: string;
  total: string; // decimal string, same reasoning as ledger_entries.amount — see below
  metadata?: Record<string, unknown>;
}

interface UpdateOrderBody {
  status?: string;
  total?: string;
  metadata?: Record<string, unknown>;
}

const VALID_DIRECTIONS: OrderDirection[] = ['sale', 'purchase'];

/**
 * total is numeric(14,2) in Postgres, same as ledger_entries.amount, and
 * for the same reason gets the same treatment here: validated as a
 * decimal string on input, returned as a string on output, never
 * parseFloat'd at this boundary. See ledgerEntries.ts's file-level note on
 * amount for the full reasoning — it applies identically here.
 */
function isValidAmountString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(value) && parseFloat(value) >= 0;
}

function toApiShape(row: {
  id: string;
  business_id: string;
  counterparty_id: string;
  direction: OrderDirection;
  status: string;
  total: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}) {
  return {
    id: row.id,
    businessId: row.business_id,
    counterpartyId: row.counterparty_id,
    direction: row.direction,
    status: row.status,
    total: row.total,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

export default async function orderRoutes(fastify: FastifyInstance) {
  // GET /orders?businessId=...&direction=... — direction is optional;
  // "procurement POs: direction=purchase, sales and export orders:
  // direction=sale" per the contract's own comment, so filtering by it is
  // a natural, expected access pattern. Backed by the (business_id,
  // direction) composite index from migration 005.
  fastify.get<{ Querystring: { businessId?: string; direction?: string } }>(
    '/orders',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, direction } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      if (direction !== undefined && !VALID_DIRECTIONS.includes(direction as OrderDirection)) {
        reply.code(400).send({
          error: 'bad_request',
          message: `direction must be one of ${VALID_DIRECTIONS.join(', ')}`,
        });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, counterparty_id, direction, status, total, metadata, created_at
         FROM orders
         WHERE business_id = $1 AND ($2::text IS NULL OR direction = $2)
         ORDER BY created_at DESC`,
        [businessId, direction ?? null],
      );
      return result.rows.map(toApiShape);
    }),
  );

  // GET /orders/:id?includeItems=true — includeItems is opt-in rather than
  // always-on: the plain GET stays a single-table query matching every
  // other resource's :id route in this codebase, and callers that don't
  // need line items don't pay for the extra join. Set it when you want
  // "this order plus everything in it" in one round trip instead of a
  // separate GET /order-items?orderId=... call.
  fastify.get<{ Params: { id: string }; Querystring: { includeItems?: string } }>(
    '/orders/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_id, counterparty_id, direction, status, total, metadata, created_at
         FROM orders WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Order not found' });
        return;
      }
      const order = toApiShape(result.rows[0]);
      if (request.query.includeItems !== 'true') {
        return order;
      }
      const itemsResult = await request.db.query(
        `SELECT id, order_id, material_id, quantity, unit_price
         FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
        [request.params.id],
      );
      return {
        ...order,
        items: itemsResult.rows.map((row) => ({
          id: row.id,
          orderId: row.order_id,
          materialId: row.material_id,
          // parseFloat to match orderItems.ts's toApiShape exactly — an
          // item fetched inline here and the same item fetched directly
          // via GET /order-items/:id must return quantity as the same
          // type. (Found by testing this endpoint directly: without this,
          // quantity came back as the string "1000.0000" here but as the
          // number 1000 from /order-items/:id — same underlying numeric(14,4)
          // column, two different JSON types depending on which route
          // reached it, which is exactly the kind of inconsistency this
          // codebase's toApiShape-per-resource pattern exists to prevent.)
          quantity: parseFloat(row.quantity),
          unitPrice: row.unit_price,
        })),
      };
    }),
  );

  fastify.post<{ Body: CreateOrderBody }>(
    '/orders',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, counterpartyId, direction, status, total, metadata } =
        request.body ?? ({} as CreateOrderBody);
      if (!businessId || !counterpartyId || !direction || !status || total === undefined) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'businessId, counterpartyId, direction, status, and total are all required',
        });
        return;
      }
      if (!VALID_DIRECTIONS.includes(direction)) {
        reply.code(400).send({
          error: 'bad_request',
          message: `direction must be one of ${VALID_DIRECTIONS.join(', ')}`,
        });
        return;
      }
      if (!isValidAmountString(total)) {
        reply.code(400).send({
          error: 'bad_request',
          message:
            'total must be a non-negative decimal string with at most 2 decimal places (e.g. "1500.00")',
        });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO orders (business_id, counterparty_id, direction, status, total, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, business_id, counterparty_id, direction, status, total, metadata, created_at`,
        [businessId, counterpartyId, direction, status, total, JSON.stringify(metadata ?? {})],
      );
      const order = result.rows[0];

      let transactionToken: string | null = null;
      if (direction === 'sale') {
        // "When a consumer makes a transaction, a token is generated for
        // them" — this is that mechanism. Automatic, not a separate step
        // a business could forget to take: every sale order gets a token
        // the moment it's created, tied to this specific order and
        // counterparty (migration 015's transaction_tokens table). The
        // consumer holds this token and later presents it back to the AI
        // (POST /conversations/:id/redeem-token) as proof of payment —
        // see conversations.ts for the redemption/escalation side. Only
        // 'sale' orders get one; a 'purchase' order (this business buying
        // from a supplier) has no consumer on the other end to hand a
        // token to.
        const tokenResult = await request.db.query(
          `INSERT INTO transaction_tokens (order_id, counterparty_id)
           VALUES ($1, $2)
           RETURNING token`,
          [order.id, counterpartyId],
        );
        transactionToken = tokenResult.rows[0].token;
      }

      reply.code(201).send({ ...toApiShape(order), transactionToken });
    }),
  );

  // PATCH /orders/:id — direction and counterpartyId are deliberately not
  // updatable here (only status, total, metadata are). Changing which
  // counterparty or which direction an existing order belongs to isn't an
  // update, it's really a different order — if that's genuinely needed,
  // it should go through explicit business logic this foundation doesn't
  // try to guess, not a silent PATCH.
  fastify.patch<{ Params: { id: string }; Body: UpdateOrderBody }>(
    '/orders/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { status, total, metadata } = request.body ?? ({} as UpdateOrderBody);
      if (status === undefined && total === undefined && metadata === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      if (total !== undefined && !isValidAmountString(total)) {
        reply.code(400).send({
          error: 'bad_request',
          message:
            'total must be a non-negative decimal string with at most 2 decimal places (e.g. "1500.00")',
        });
        return;
      }
      const result = await request.db.query(
        `UPDATE orders
         SET status = COALESCE($2, status),
             total = COALESCE($3, total),
             metadata = COALESCE($4::jsonb, metadata)
         WHERE id = $1
         RETURNING id, business_id, counterparty_id, direction, status, total, metadata, created_at`,
        [
          request.params.id,
          status ?? null,
          total ?? null,
          metadata !== undefined ? JSON.stringify(metadata) : null,
        ],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Order not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // DELETE /orders/:id — cascades to order_items via ON DELETE CASCADE
  // (migration 005: order_items.order_id references orders(id) ON DELETE
  // CASCADE, unlike order_items.material_id which is RESTRICT — an
  // order's own line items are part of the order and go with it; a
  // material master record is a separate, shared thing that shouldn't
  // vanish just because one order referencing it was deleted).
  fastify.delete<{ Params: { id: string } }>(
    '/orders/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(`DELETE FROM orders WHERE id = $1 RETURNING id`, [
        request.params.id,
      ]);
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Order not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
