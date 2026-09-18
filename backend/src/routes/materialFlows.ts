import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

type FlowDirection = 'input' | 'output';

interface CreateMaterialFlowBody {
  businessNodeId: string;
  materialId: string;
  direction: FlowDirection;
  quantityPerUnit: number;
}

interface UpdateMaterialFlowBody {
  quantityPerUnit?: number;
}

const VALID_DIRECTIONS: FlowDirection[] = ['input', 'output'];

function toApiShape(row: {
  id: string;
  business_node_id: string;
  material_id: string;
  direction: FlowDirection;
  quantity_per_unit: string;
}) {
  return {
    id: row.id,
    businessNodeId: row.business_node_id,
    materialId: row.material_id,
    direction: row.direction,
    // Same reasoning as order_items.quantity — see that file's note.
    // quantityPerUnit isn't currency; a plain number at this precision is
    // the more useful shape for consumers than a decimal string would be.
    quantityPerUnit: parseFloat(row.quantity_per_unit),
  };
}

export default async function materialFlowRoutes(fastify: FastifyInstance) {
  // GET /material-flows — supports filtering by EITHER businessNodeId OR
  // materialId (at least one required), not just businessNodeId. That's
  // deliberate, not an inconsistency with how every other resource here
  // requires exactly one scoping param: the contract's own comment on this
  // table calls out "one material can be the input flow for MANY
  // business_nodes" as the specific thing this table exists to represent
  // — "which business_nodes consume material X" (query by materialId) is
  // just as core an access pattern as "which materials does this node use"
  // (query by businessNodeId), and migration 005 built the (material_id,
  // direction) composite index specifically for the former. Restricting
  // this endpoint to businessNodeId-only would make that index pointless
  // to have built.
  fastify.get<{
    Querystring: { businessNodeId?: string; materialId?: string; direction?: string };
  }>(
    '/material-flows',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessNodeId, materialId, direction } = request.query;
      if (!businessNodeId && !materialId) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'At least one of businessNodeId or materialId query params is required',
        });
        return;
      }
      if (direction !== undefined && !VALID_DIRECTIONS.includes(direction as FlowDirection)) {
        reply.code(400).send({
          error: 'bad_request',
          message: `direction must be one of ${VALID_DIRECTIONS.join(', ')}`,
        });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_node_id, material_id, direction, quantity_per_unit
         FROM material_flows
         WHERE ($1::uuid IS NULL OR business_node_id = $1)
           AND ($2::uuid IS NULL OR material_id = $2)
           AND ($3::text IS NULL OR direction = $3)
         ORDER BY id ASC`,
        [businessNodeId ?? null, materialId ?? null, direction ?? null],
      );
      return result.rows.map(toApiShape);
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/material-flows/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_node_id, material_id, direction, quantity_per_unit
         FROM material_flows WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Material flow not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.post<{ Body: CreateMaterialFlowBody }>(
    '/material-flows',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessNodeId, materialId, direction, quantityPerUnit } =
        request.body ?? ({} as CreateMaterialFlowBody);
      if (!businessNodeId || !materialId || !direction || quantityPerUnit === undefined) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'businessNodeId, materialId, direction, and quantityPerUnit are all required',
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
      if (typeof quantityPerUnit !== 'number' || quantityPerUnit <= 0) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: 'quantityPerUnit must be a positive number' });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO material_flows (business_node_id, material_id, direction, quantity_per_unit)
         VALUES ($1, $2, $3, $4)
         RETURNING id, business_node_id, material_id, direction, quantity_per_unit`,
        [businessNodeId, materialId, direction, quantityPerUnit],
      );
      reply.code(201).send(toApiShape(result.rows[0]));
    }),
  );

  // PATCH /material-flows/:id — only quantityPerUnit is updatable.
  // Changing which node, which material, or the direction of an existing
  // flow isn't really an update to the same flow — it's a different flow
  // definition — so those three are immutable here, same reasoning as
  // orders.ts not allowing direction/counterpartyId to change via PATCH.
  fastify.patch<{ Params: { id: string }; Body: UpdateMaterialFlowBody }>(
    '/material-flows/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { quantityPerUnit } = request.body ?? ({} as UpdateMaterialFlowBody);
      if (quantityPerUnit === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      if (typeof quantityPerUnit !== 'number' || quantityPerUnit <= 0) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: 'quantityPerUnit must be a positive number' });
        return;
      }
      const result = await request.db.query(
        `UPDATE material_flows
         SET quantity_per_unit = $2
         WHERE id = $1
         RETURNING id, business_node_id, material_id, direction, quantity_per_unit`,
        [request.params.id, quantityPerUnit],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Material flow not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.delete<{ Params: { id: string } }>(
    '/material-flows/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `DELETE FROM material_flows WHERE id = $1 RETURNING id`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Material flow not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
