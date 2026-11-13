import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';
import { isUuid } from '../lib/validate.js';

/**
 * In-app notifications for the signed-in person. Row-level security
 * (policy addressee_only, migration 020) means a person can only ever see
 * and update rows addressed to them — even a bug in these queries could
 * not show someone else's.
 */
export default async function notificationRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { unread?: string; limit?: string } }>(
    '/notifications',
    { preHandler: [fastify.authenticate] },
    withDb(async (request) => {
      const limit = Math.min(Math.max(parseInt(request.query.limit ?? '30', 10) || 30, 1), 100);
      const unreadOnly = request.query.unread === 'true';
      const result = await request.db.query(
        `SELECT id, business_id, kind, conversation_id, order_id, title, body, created_at, read_at
         FROM notifications
         WHERE ($1::boolean = false OR read_at IS NULL)
         ORDER BY created_at DESC
         LIMIT $2`,
        [unreadOnly, limit],
      );
      const unread = await request.db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM notifications WHERE read_at IS NULL`,
      );
      return {
        unreadCount: parseInt(unread.rows[0].n, 10),
        items: result.rows.map((r) => ({
          id: r.id,
          businessId: r.business_id,
          kind: r.kind,
          conversationId: r.conversation_id,
          orderId: r.order_id,
          title: r.title,
          body: r.body,
          createdAt: r.created_at,
          read: r.read_at !== null,
        })),
      };
    }),
  );

  // Body { ids?: string[] } — omit ids to mark everything read.
  fastify.post<{ Body: { ids?: string[] } }>(
    '/notifications/read',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const ids = request.body?.ids;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > 200 || !ids.every(isUuid))) {
        reply.code(400).send({ error: 'bad_request', message: 'ids must be a list of up to 200 valid ids' });
        return;
      }
      const result = await request.db.query(
        `UPDATE notifications SET read_at = now()
         WHERE read_at IS NULL AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
        [ids ?? null],
      );
      return { marked: result.rowCount ?? 0 };
    }),
  );
}
