import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

type MaterialStage = 'raw' | 'wip' | 'finished';

interface CatalogMetaInput {
  icon?: string;
  category?: string;
  description?: string;
  price?: number | null;
  currency?: string | null;
  media?: { image?: string | null; video?: string | null };
}

interface CreateMaterialBody {
  businessId: string;
  name: string;
  stage: MaterialStage;
  unit: string;
  catalogMeta?: CatalogMetaInput | null;
}

interface UpdateMaterialBody {
  name?: string;
  stage?: MaterialStage;
  unit?: string;
  catalogMeta?: CatalogMetaInput | null;
}

const VALID_STAGES: MaterialStage[] = ['raw', 'wip', 'finished'];
const VALID_STREAM_CATEGORIES = ['food', 'agriculture', 'energy', 'manufacturing', 'education'];

/**
 * catalogMeta is the publish signal for GET /product-stream (see
 * migration 007, migration 008, and routes/productStream.ts) — setting
 * it to a non-null value here is what makes a material appear on the
 * public landing page at all. Validated loosely (it's jsonb, meant to
 * stay flexible) but with one real check: if `category` is present, it
 * must be one of the five the landing page actually renders a color for
 * (routes/productStream.ts defaults an unset category to
 * 'manufacturing' — this check exists so a typo doesn't silently become
 * an item that always defaults there instead of failing loudly at
 * publish time, when it's still cheap to notice and fix).
 */
function validateCatalogMeta(
  meta: unknown,
): { valid: true; meta: CatalogMetaInput | null } | { valid: false; reason: string } {
  if (meta === null || meta === undefined) {
    return { valid: true, meta: null };
  }
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    return { valid: false, reason: 'catalogMeta must be an object or null' };
  }
  const m = meta as Record<string, unknown>;
  if (m.category !== undefined && !VALID_STREAM_CATEGORIES.includes(m.category as string)) {
    return {
      valid: false,
      reason: `catalogMeta.category must be one of ${VALID_STREAM_CATEGORIES.join(', ')}`,
    };
  }
  // price/currency make an item purchasable through checkout. Optional: an
  // item without a price is browse-and-enquire only. Money is validated as
  // a positive amount with at most 2 decimals; checkout re-reads it from
  // the database and does all arithmetic in SQL numeric (migration 021).
  if (m.price !== undefined && m.price !== null) {
    const price = m.price;
    if (
      typeof price !== 'number' || !Number.isFinite(price) || price <= 0 || price > 999_999_999 ||
      Math.round(price * 100) / 100 !== price
    ) {
      return { valid: false, reason: 'catalogMeta.price must be a positive amount with at most 2 decimal places' };
    }
  }
  if (m.currency !== undefined && m.currency !== null && !(typeof m.currency === 'string' && /^[A-Z]{3}$/.test(m.currency))) {
    return { valid: false, reason: 'catalogMeta.currency must be a 3-letter code such as GHS' };
  }
  // Owner-supplied media is loaded into the public storefront, so only
  // https links are accepted (no javascript:, data:, or plain http).
  if (m.media !== undefined && m.media !== null) {
    if (typeof m.media !== 'object' || Array.isArray(m.media)) {
      return { valid: false, reason: 'catalogMeta.media must be an object' };
    }
    for (const key of ['image', 'video'] as const) {
      const link = (m.media as Record<string, unknown>)[key];
      if (link !== undefined && link !== null && link !== '' &&
          !(typeof link === 'string' && link.length <= 2000 && /^https:\/\/\S+$/i.test(link))) {
        return { valid: false, reason: `catalogMeta.media.${key} must be an https:// link` };
      }
    }
  }
  if (m.icon !== undefined && m.icon !== null && !(typeof m.icon === 'string' && m.icon.length <= 16)) {
    return { valid: false, reason: 'catalogMeta.icon must be a short string (one emoji)' };
  }
  if (m.description !== undefined && m.description !== null && !(typeof m.description === 'string' && m.description.length <= 2000)) {
    return { valid: false, reason: 'catalogMeta.description must be text of at most 2000 characters' };
  }
  return { valid: true, meta: meta as CatalogMetaInput };
}

function toApiShape(row: {
  id: string;
  business_id: string;
  name: string;
  stage: MaterialStage;
  unit: string;
  catalog_meta: CatalogMetaInput | null;
}) {
  return {
    id: row.id,
    businessId: row.business_id,
    name: row.name,
    stage: row.stage,
    unit: row.unit,
    catalogMeta: row.catalog_meta,
    // publishedToStream is a convenience the frontend can check without
    // having to know "catalogMeta !== null" is the actual publish rule —
    // derived here at the API boundary, not a separate stored column.
    publishedToStream: row.catalog_meta !== null,
  };
}

export default async function materialRoutes(fastify: FastifyInstance) {
  // GET /materials?businessId=... — required, same reasoning as
  // business-nodes.ts and partnerships.ts: an unscoped "every material
  // across every business" listing isn't a useful default for a
  // per-business resource.
  fastify.get<{ Querystring: { businessId?: string; stage?: string } }>(
    '/materials',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, stage } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      if (stage !== undefined && !VALID_STAGES.includes(stage as MaterialStage)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: `stage must be one of ${VALID_STAGES.join(', ')}` });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, name, stage, unit, catalog_meta
         FROM materials
         WHERE business_id = $1 AND ($2::text IS NULL OR stage = $2)
         ORDER BY name ASC`,
        [businessId, stage ?? null],
      );
      return result.rows.map(toApiShape);
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/materials/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_id, name, stage, unit, catalog_meta FROM materials WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Material not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  fastify.post<{ Body: CreateMaterialBody }>(
    '/materials',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, name, stage, unit, catalogMeta } = request.body ?? ({} as CreateMaterialBody);
      if (!businessId || !name || !stage || !unit) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: 'businessId, name, stage, and unit are all required' });
        return;
      }
      if (!VALID_STAGES.includes(stage)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: `stage must be one of ${VALID_STAGES.join(', ')}` });
        return;
      }
      const metaValidation = validateCatalogMeta(catalogMeta);
      if (!metaValidation.valid) {
        reply.code(400).send({ error: 'bad_request', message: metaValidation.reason });
        return;
      }
      const result = await request.db.query(
        `INSERT INTO materials (business_id, name, stage, unit, catalog_meta)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, business_id, name, stage, unit, catalog_meta`,
        [
          businessId,
          name,
          stage,
          unit,
          metaValidation.meta !== null ? JSON.stringify(metaValidation.meta) : null,
        ],
      );
      reply.code(201).send(toApiShape(result.rows[0]));
    }),
  );

  // PATCH /materials/:id — this is where publishing (or unpublishing) a
  // material to the public landing page actually happens: setting
  // catalogMeta to a non-null object publishes it; setting it explicitly
  // to null unpublishes it. Distinguishing "not provided" (leave
  // unchanged) from "provided as null" (unpublish) matters here more
  // than for the other COALESCE-based fields on this route, since null
  // is a meaningful, intentional value for this field — not "no
  // change" — so it's handled with its own boolean flag rather than the
  // COALESCE($n, existing) pattern used for name/stage/unit above, which
  // can't distinguish "omitted" from "explicitly null."
  fastify.patch<{ Params: { id: string }; Body: UpdateMaterialBody }>(
    '/materials/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { name, stage, unit, catalogMeta } = request.body ?? ({} as UpdateMaterialBody);
      const catalogMetaProvided = Object.prototype.hasOwnProperty.call(
        request.body ?? {},
        'catalogMeta',
      );
      if (name === undefined && stage === undefined && unit === undefined && !catalogMetaProvided) {
        reply.code(400).send({ error: 'bad_request', message: 'Nothing to update' });
        return;
      }
      if (stage !== undefined && !VALID_STAGES.includes(stage)) {
        reply
          .code(400)
          .send({ error: 'bad_request', message: `stage must be one of ${VALID_STAGES.join(', ')}` });
        return;
      }
      let validatedMeta: CatalogMetaInput | null = null;
      if (catalogMetaProvided) {
        const metaValidation = validateCatalogMeta(catalogMeta);
        if (!metaValidation.valid) {
          reply.code(400).send({ error: 'bad_request', message: metaValidation.reason });
          return;
        }
        validatedMeta = metaValidation.meta;
      }
      const result = await request.db.query(
        `UPDATE materials
         SET name = COALESCE($2, name),
             stage = COALESCE($3, stage),
             unit = COALESCE($4, unit),
             catalog_meta = CASE WHEN $5::boolean THEN $6::jsonb ELSE catalog_meta END
         WHERE id = $1
         RETURNING id, business_id, name, stage, unit, catalog_meta`,
        [
          request.params.id,
          name ?? null,
          stage ?? null,
          unit ?? null,
          catalogMetaProvided,
          validatedMeta !== null ? JSON.stringify(validatedMeta) : null,
        ],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Material not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  // DELETE /materials/:id — material_flows.material_id and
  // order_items.material_id both reference this table. material_flows has
  // ON DELETE CASCADE (migration 005), so deleting a material removes any
  // flow definitions that reference it. order_items has ON DELETE
  // RESTRICT (migration 005, deliberately — an order line item shouldn't
  // silently vanish because someone deleted a material master record), so
  // this DELETE is refused by the database with a foreign-key violation
  // (mapped to a 400 by the 23503 handler in server.ts) if any order still
  // references this material.
  fastify.delete<{ Params: { id: string } }>(
    '/materials/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(`DELETE FROM materials WHERE id = $1 RETURNING id`, [
        request.params.id,
      ]);
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Material not found' });
        return;
      }
      reply.code(204).send();
    }),
  );
}
