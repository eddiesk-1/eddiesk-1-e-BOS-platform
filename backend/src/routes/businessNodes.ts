import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

type NodeType = 'product_line' | 'workflow' | 'task';

interface CreateNodeBody {
  businessId: string;
  parentId?: string | null;
  nodeType: NodeType;
  title: string;
  metadata?: Record<string, unknown>;
}

interface UpdateNodeBody {
  parentId?: string | null;
  title?: string;
  metadata?: Record<string, unknown>;
}

function toApiShape(row: {
  id: string;
  business_id: string;
  parent_id: string | null;
  node_type: NodeType;
  title: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}) {
  return {
    id: row.id,
    businessId: row.business_id,
    parentId: row.parent_id,
    nodeType: row.node_type,
    title: row.title,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

const VALID_NODE_TYPES: NodeType[] = ['product_line', 'workflow', 'task'];

export default async function businessNodeRoutes(fastify: FastifyInstance) {
  // GET /business-nodes?businessId=... — flat list, one business at a time
  // (an unscoped "all nodes across every business" listing isn't useful
  // for a tree-shaped resource, so businessId is required rather than
  // optional).
  fastify.get<{ Querystring: { businessId?: string } }>(
    '/business-nodes',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, parent_id, node_type, title, metadata, created_at
         FROM business_nodes WHERE business_id = $1 ORDER BY created_at ASC`,
        [businessId],
      );
      return result.rows.map(toApiShape);
    }),
  );

  // GET /business-nodes/:id
  fastify.get<{ Params: { id: string } }>(
    '/business-nodes/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_id, parent_id, node_type, title, metadata, created_at
         FROM business_nodes WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Business node not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // GET /business-nodes/:id/subtree — the node itself plus every
  // descendant, flattened, each entry tagged with its depth relative to
  // the requested node (0 = the node itself).
  //
  // Implemented as a single WITH RECURSIVE query rather than N+1 queries
  // walking down level by level in application code — both because it's
  // one round trip instead of (tree depth) round trips, and because it
  // means RLS is evaluated by Postgres itself on every row the recursion
  // touches, the same way it would be for any other query. A recursive
  // CTE's recursive term is just another query against business_nodes on
  // this same connection, so the tenant_isolation policy applies to it
  // exactly as it does to the base case — a partner session recursing
  // into a subtree can't walk into nodes belonging to a business they
  // don't have a partnerships row for, because that business's nodes
  // simply aren't visible to this connection in the first place. (This
  // was checked behaviorally against the live database with a partner
  // session missing a partnerships row for the business under test — see
  // README's "Verifying this yourself" section for the exact commands —
  // not just asserted from how RLS is documented to compose with CTEs.)
  fastify.get<{ Params: { id: string } }>(
    '/business-nodes/:id/subtree',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `WITH RECURSIVE subtree AS (
           SELECT id, business_id, parent_id, node_type, title, metadata, created_at, 0 AS depth
           FROM business_nodes
           WHERE id = $1

           UNION ALL

           SELECT bn.id, bn.business_id, bn.parent_id, bn.node_type, bn.title, bn.metadata, bn.created_at,
                  subtree.depth + 1
           FROM business_nodes bn
           JOIN subtree ON bn.parent_id = subtree.id
         )
         SELECT id, business_id, parent_id, node_type, title, metadata, created_at, depth
         FROM subtree
         ORDER BY depth ASC, created_at ASC`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        // The root itself wasn't found (or isn't visible to this caller —
        // see the same not-found-vs-forbidden reasoning as businesses.ts).
        reply.code(404).send({ error: 'not_found', message: 'Business node not found' });
        return;
      }
      return {
        rootId: request.params.id,
        nodes: result.rows.map((row) => ({ ...toApiShape(row), depth: row.depth })),
      };
    }),
  );

  // POST /business-nodes
  fastify.post<{ Body: CreateNodeBody }>(
    '/business-nodes',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, parentId, nodeType, title, metadata } =
        request.body ?? ({} as CreateNodeBody);

      if (!businessId || !nodeType || !title) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: 'businessId, nodeType, and title are required' });
        return;
      }
      if (!VALID_NODE_TYPES.includes(nodeType)) {
        reply.code(400).send({
          error: 'bad_request',
          message: `nodeType must be one of ${VALID_NODE_TYPES.join(', ')}`,
        });
        return;
      }

      const result = await request.db.query(
        `INSERT INTO business_nodes (business_id, parent_id, node_type, title, metadata)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, business_id, parent_id, node_type, title, metadata, created_at`,
        [businessId, parentId ?? null, nodeType, title, JSON.stringify(metadata ?? {})],
      );
      reply.code(201).send(toApiShape(result.rows[0]));
    }),
  );

  // PATCH /business-nodes/:id
  fastify.patch<{ Params: { id: string }; Body: UpdateNodeBody }>(
    '/business-nodes/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { parentId, title, metadata } = request.body ?? ({} as UpdateNodeBody);
      if (parentId === undefined && title === undefined && metadata === undefined) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      const result = await request.db.query(
        `UPDATE business_nodes
         SET parent_id = CASE WHEN $2::boolean THEN $3::uuid ELSE parent_id END,
             title = COALESCE($4, title),
             metadata = COALESCE($5::jsonb, metadata)
         WHERE id = $1
         RETURNING id, business_id, parent_id, node_type, title, metadata, created_at`,
        [
          request.params.id,
          parentId !== undefined,
          parentId ?? null,
          title ?? null,
          metadata !== undefined ? JSON.stringify(metadata) : null,
        ],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Business node not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // DELETE /business-nodes/:id — cascades to descendants via
  // business_nodes.parent_id's ON DELETE CASCADE (migration 002), and to
  // material_flows referencing this node via ITS ON DELETE CASCADE
  // (migration 005). Both cascades happen at the database level, not in
  // this handler.
  fastify.delete<{ Params: { id: string } }>(
    '/business-nodes/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `DELETE FROM business_nodes WHERE id = $1 RETURNING id`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Business node not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
