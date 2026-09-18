import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

interface CreateOrderItemBody {
  orderId: string;
  materialId: string;
  quantity: number;
  unitPrice: string; // decimal string — see the note on unitPrice below
}

interface UpdateOrderItemBody {
  quantity?: number;
  unitPrice?: string;
}

/**
 * unitPrice is numeric(14,2), same category as ledger_entries.amount and
 * orders.total — validated as a decimal string, never parseFloat'd. See
 * ledgerEntries.ts's file-level note for the full reasoning.
 *
 * quantity is numeric(14,4) — one more decimal place than money columns,
 * since quantities (e.g. kilograms of a raw material) legitimately need
 * finer precision than currency does. It's accepted and returned as a
 * plain JS number rather than a string: unlike money, a quantity being off
 * by float-epsilon in a display context isn't the same class of problem
 * (nobody's accounting reconciliation breaks over 1.00000000001 kg), and
 * forcing every consumer of this API to parse a decimal string just to
 * display "12.5 kg" would be friction with no matching benefit. If a
 * future consumer needs to do exact arithmetic on quantities (e.g. summing
 * many line items into a material_flows total), that math should still
 * happen with a decimal-safe library on their end — this is a judgment
 * call about the API boundary, not a claim that float quantities are
 * always safe everywhere.
 */
function isValidAmountString(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(value) && parseFloat(value) >= 0;
}

function toApiShape(row: {
  id: string;
  order_id: string;
  material_id: string;
  quantity: string;
  unit_price: string;
}) {
  return {
    id: row.id,
    orderId: row.order_id,
    materialId: row.material_id,
    quantity: parseFloat(row.quantity),
    unitPrice: row.unit_price,
  };
}

export default async function orderItemRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { orderId?: string } }>(
    '/order-items',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { orderId } = request.query;
      if (!orderId) {
        reply.code(400).send({ error: 'bad_request', message: 'orderId query param is required' });
        return;
      }
      const result = await request.db.query(
        `SELECT id, order_id, material_id, quantity, unit_price
         FROM order_items WHERE order_id = $1 ORDER BY id ASC`,
        [orderId],
      );
      return result.rows.map(toApiShape);
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/order-items/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, order_id, material_id, quantity, unit_price FROM order_items WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Order item not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.post<{ Body: CreateOrderItemBody }>(
    '/order-items',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { orderId, materialId, quantity, unitPrice } =
        request.body ?? ({} as CreateOrderItemBody);
      if (!orderId || !materialId || quantity === undefined || unitPrice === undefined) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'orderId, materialId, quantity, and unitPrice are all required',
        });
        return;
      }
      if (typeof quantity !== 'number' || quantity <= 0) {
        reply.code(400).send({ error: 'bad_request', message: 'quantity must be a positive number' });
        return;
      }
      if (!isValidAmountString(unitPrice)) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'unitPrice must be a non-negative decimal string with at most 2 decimal places (e.g. "12.50")',
        });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO order_items (order_id, material_id, quantity, unit_price)
         VALUES ($1, $2, $3, $4)
         RETURNING id, order_id, material_id, quantity, unit_price`,
        [orderId, materialId, quantity, unitPrice],
      );
      reply.code(201).send(toApiShape(result.rows[0]));
    }),
  );

  fastify.patch<{ Params: { id: string }; Body: UpdateOrderItemBody }>(
    '/order-items/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { quantity, unitPrice } = request.body ?? ({} as UpdateOrderItemBody);
      if (quantity === undefined && unitPrice === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      if (quantity !== undefined && (typeof quantity !== 'number' || quantity <= 0)) {
        reply.code(400).send({ error: 'bad_request', message: 'quantity must be a positive number' });
        return;
      }
      if (unitPrice !== undefined && !isValidAmountString(unitPrice)) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'unitPrice must be a non-negative decimal string with at most 2 decimal places (e.g. "12.50")',
        });
        return;
      }
      const result = await request.db.query(
        `UPDATE order_items
         SET quantity = COALESCE($2, quantity),
             unit_price = COALESCE($3, unit_price)
         WHERE id = $1
         RETURNING id, order_id, material_id, quantity, unit_price`,
        [request.params.id, quantity ?? null, unitPrice ?? null],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Order item not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/order-items/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `DELETE FROM order_items WHERE id = $1 RETURNING id`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Order item not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
