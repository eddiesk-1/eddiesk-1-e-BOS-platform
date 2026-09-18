/**
 * 007_catalog_meta
 *
 * Adds ONE new nullable column: materials.catalog_meta jsonb. Nothing
 * else in this migration — no new tables, no changed constraints on
 * anything the shared contract specifies.
 *
 * WHY THIS EXISTS: the e-BOS landing page (a separate frontend, built
 * against a GET /product-stream + WebSocket spec) renders a live stream
 * of products as circles, sized and colored using fields the core
 * business/accounting schema was never designed to carry — icon, display
 * category (food/agriculture/energy/manufacturing/education), and media
 * (image/video URLs for the circle's visual). None of that is
 * accounting or ops data; it's publish-time marketing metadata a business
 * owner sets once when they want a product to appear on the landing page.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not add a `rating` field,
 * and it does not try to compute `sales`/`repeatCustomers`/`size`/
 * `visibilityWeight` from this column. Those are either derived live from
 * real order_items/orders data (see src/routes/productStream.ts) or, for
 * `rating`, not returned at all — there's no review/rating data anywhere
 * in this schema, and inventing a plausible-looking number would be worse
 * than admitting it doesn't exist yet. A future ratings feature, if it's
 * ever built, deserves its own real table (reviewer identity, a
 * timestamp, a score you can aggregate and audit) — not a fabricated
 * number quietly living inside a jsonb blob nobody would think to check.
 *
 * catalog_meta is NULLABLE with no default beyond NULL, and every
 * existing materials row already has NULL here after this migration —
 * nothing about existing behavior changes for a material that never
 * opts into landing-page display. GET /product-stream (see
 * productStream.ts) only includes a material row at all when
 * catalog_meta IS NOT NULL — that's the explicit publish signal, not
 * "every material implicitly appears on the public landing page."
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE materials ADD COLUMN catalog_meta jsonb NULL;`);
  // Partial index: only rows that are actually published to the stream
  // need to be found quickly by this predicate. A material that never
  // sets catalog_meta doesn't bloat an index built for a query it will
  // never match.
  pgm.sql(
    `CREATE INDEX idx_materials_catalog_meta_published ON materials(business_id) WHERE catalog_meta IS NOT NULL;`,
  );
};

exports.down = (pgm) => {
  pgm.sql(`DROP INDEX IF EXISTS idx_materials_catalog_meta_published;`);
  pgm.sql(`ALTER TABLE materials DROP COLUMN IF EXISTS catalog_meta;`);
};
