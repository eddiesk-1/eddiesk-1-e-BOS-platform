import type { FastifyInstance } from 'fastify';
import { withPublicAccess } from '../lib/publicDb.js';

/**
 * GET /product-stream
 *
 * The one genuinely public, unauthenticated route in this service —
 * everything else requires a JWT and is scoped to a holding company (see
 * lib/db.ts, lib/publicDb.ts's file-level comment explains why this route
 * can't just reuse that machinery). Feeds the e-BOS landing page's live
 * circle-stream visualization, matching the ProductStreamItem shape that
 * frontend's Backend.fetchSnapshot() expects: id, name, businessId,
 * businessName, category, icon, rating, sales, repeatCustomers, size,
 * visibilityWeight, description, media.
 *
 * businessId was MISSING from this endpoint's response until it was found
 * by actually wiring a real frontend to this backend and running the real
 * consumer-chat flow end to end — the query already JOINed businesses
 * (for business_name), it just never SELECTed b.id. Every other check on
 * this endpoint (typechecking, RLS testing, the raw SQL) was correct in
 * isolation; a frontend developer following the spec's own documented
 * flow ("start a conversation using item.businessId from a
 * ProductStreamItem") would have hit a confusing "businessId is
 * required" 400 from POST /conversations with no way to know the field
 * just didn't exist. Exactly the class of bug that only surfaces at the
 * INTEGRATION boundary, not from testing either side alone.
 *
 * WHAT'S REAL AND WHAT ISN'T, HONESTLY:
 *
 * - name, businessName come straight from materials/businesses. icon,
 *   category, description, and media all come from
 *   materials.catalog_meta (migration 007) — publish-time metadata an
 *   owner/worker sets once via PATCH /materials/:id, not derived from
 *   anything. (description started as a plan to reference a bare
 *   materials.description column that turns out not to exist in this
 *   schema — materials only has name/stage/unit; folding description
 *   into catalog_meta alongside icon/category/media is more consistent
 *   than adding a second new column for the same category of "display-
 *   only, publish-time text" that catalog_meta already exists to hold.)
 * - sales is a live SUM(order_items.quantity) across every 'sale'-direction
 *   order referencing this material. Real, computed fresh every request,
 *   same "live query, not cached" discipline as GET
 *   /holding-companies/:id/rollup.
 * - repeatCustomers is a live COUNT(DISTINCT counterparty) among
 *   customers who placed MORE THAN ONE 'sale'-direction order containing
 *   this material. Also real, also live.
 * - size and visibilityWeight are DERIVED, not stored, computed below in
 *   normalizeForStream() — see that function's comment for the exact
 *   formula and, importantly, its limits (normalized within one
 *   business's own published catalog, not globally, and why).
 * - rating is NOT computed, faked, or defaulted to some plausible-looking
 *   number. It's returned as null. There is no review/rating data
 *   anywhere in this schema — see migration 007's comment on why that's a
 *   deliberate omission rather than an oversight, and what a real ratings
 *   feature would need instead. The frontend needs to handle a null
 *   rating (e.g. hide the star row) rather than assume one always exists.
 *
 * A material only appears here at all once catalog_meta IS NOT NULL —
 * that's the publish signal (see migration 007 and 008's public_catalog
 * RLS policy, which enforces this at the database level independent of
 * anything this route does — even a bug here couldn't leak an unpublished
 * material, because the connection literally cannot see the row).
 */

interface CatalogMeta {
  icon?: string;
  category?: string;
  description?: string;
  price?: number | null;
  currency?: string | null;
  media?: { image?: string | null; video?: string | null };
}

interface RawStreamRow {
  id: string;
  name: string;
  business_id: string;
  business_name: string;
  catalog_meta: CatalogMeta;
  sales: string;
  repeat_customers: string;
  most_recent_sale: Date | null;
}

interface StreamItem {
  id: string;
  name: string;
  businessId: string;
  businessName: string;
  category: string;
  icon: string;
  rating: null;
  sales: number;
  repeatCustomers: number;
  size: number;
  visibilityWeight: number;
  description: string;
  price: number | null;
  currency: string;
  media: { image: string | null; video: string | null };
}

/**
 * Converts raw per-material sales/repeatCustomers/recency into the two
 * 0..1 fields the frontend expects (size, visibilityWeight), matching
 * that file's own comment: "a real backend computes these... and this
 * file only ever *reads* them."
 *
 * SIZE is normalized WITHIN each business's own published catalog, not
 * globally across the platform. This is a deliberate choice, not an
 * oversight: a small home bakery's actual best-seller should read as
 * "this business's flagship item" (a large circle relative to its own
 * other products), not shrink to near-invisible next to a large
 * manufacturer's highest-volume line just because the platform has
 * businesses of wildly different scale on it. Within a business, a
 * material's raw "activity score" (sales + repeatCustomers, matching the
 * landing-page spec's own stated formula) is divided by the max score
 * among that business's OTHER published materials. A business with only
 * one published item gets size = 1 for it — there's nothing to be
 * relatively smaller than, which is the correct behavior, not a
 * fallback/edge-case hack.
 *
 * VISIBILITY WEIGHT uses recency of the material's most recent sale as
 * the only real "activity over time" signal this schema has (there's no
 * "views" or "impressions" table). Exponential decay with a 30-day
 * half-life, floored at 0.15 rather than allowed to reach 0 — a material
 * with zero recent sales should reappear LESS often, per the original
 * landing-page spec ("older products reappear less frequently"), not
 * NEVER (a hard 0 would make it permanently invisible, which the spec
 * doesn't ask for and which would make an otherwise-real, currently-
 * unsold product impossible for a new customer to discover at all). A
 * material with no sales record at all (most_recent_sale is null — e.g.
 * a newly published item nobody has bought yet) gets a fixed, moderate
 * 0.5 rather than the floor — new and not-yet-proven is different from
 * old and no-longer-moving, and this formula tries to keep those
 * distinguishable instead of collapsing both to "low."
 */
function normalizeForStream(rows: RawStreamRow[]): StreamItem[] {
  const byBusiness = new Map<string, RawStreamRow[]>();
  for (const row of rows) {
    const key = row.business_name;
    if (!byBusiness.has(key)) byBusiness.set(key, []);
    byBusiness.get(key)!.push(row);
  }

  const scoreOf = (row: RawStreamRow) => parseFloat(row.sales) + parseInt(row.repeat_customers, 10);

  const maxScoreByBusiness = new Map<string, number>();
  for (const [business, businessRows] of byBusiness) {
    const max = Math.max(...businessRows.map(scoreOf), 0.0001); // avoid divide-by-zero if every score is 0
    maxScoreByBusiness.set(business, max);
  }

  const now = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
  const FLOOR = 0.15;
  const NO_SALES_YET = 0.5;

  return rows.map((row) => {
    const maxScore = maxScoreByBusiness.get(row.business_name)!;
    const size = Math.max(0, Math.min(1, scoreOf(row) / maxScore));

    let visibilityWeight: number;
    if (row.most_recent_sale === null) {
      visibilityWeight = NO_SALES_YET;
    } else {
      const ageMs = now - row.most_recent_sale.getTime();
      const decayed = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      visibilityWeight = Math.max(FLOOR, decayed);
    }

    const meta = row.catalog_meta ?? {};
    return {
      id: row.id,
      name: row.name,
      businessId: row.business_id,
      businessName: row.business_name,
      category: meta.category ?? 'manufacturing',
      icon: meta.icon ?? '📦',
      rating: null,
      sales: parseFloat(row.sales),
      repeatCustomers: parseInt(row.repeat_customers, 10),
      size,
      visibilityWeight,
      description: meta.description ?? '',
      price: typeof meta.price === 'number' ? meta.price : null,
      currency: meta.currency ?? 'GHS',
      media: {
        image: meta.media?.image ?? null,
        video: meta.media?.video ?? null,
      },
    };
  });
}

export default async function productStreamRoutes(fastify: FastifyInstance) {
  // Deliberately NOT { preHandler: [fastify.authenticate] } — this is the
  // one route in the whole service that must work with no Authorization
  // header at all.
  fastify.get('/product-stream', async () => {
    const rows = await withPublicAccess<RawStreamRow[]>(async (client) => {
      const result = await client.query(
        `SELECT
           m.id,
           m.name,
           b.id AS business_id,
           b.name AS business_name,
           m.catalog_meta,
           COALESCE(stats.total_qty, 0) AS sales,
           COALESCE(stats.repeat_customers, 0) AS repeat_customers,
           stats.most_recent_sale
         FROM materials m
         JOIN businesses b ON b.id = m.business_id
         LEFT JOIN LATERAL (
           SELECT
             SUM(oi.quantity) AS total_qty,
             COUNT(DISTINCT o.counterparty_id) FILTER (WHERE cust.order_count > 1) AS repeat_customers,
             MAX(o.created_at) AS most_recent_sale
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           JOIN (
             SELECT counterparty_id, COUNT(DISTINCT order_id) AS order_count
             FROM order_items oi2
             JOIN orders o2 ON o2.id = oi2.order_id
             WHERE o2.direction = 'sale' AND o2.status <> 'pending_payment' AND oi2.material_id = m.id
             GROUP BY counterparty_id
           ) cust ON cust.counterparty_id = o.counterparty_id
           WHERE o.direction = 'sale' AND o.status <> 'pending_payment' AND oi.material_id = m.id
         ) stats ON true
         WHERE m.catalog_meta IS NOT NULL
         ORDER BY m.id ASC`,
      );
      return result.rows;
    });

    return { items: normalizeForStream(rows) };
  });
}
