/**
 * 009_public_catalog_joins
 *
 * Migration 008 gave app_public SELECT on materials, gated by
 * catalog_meta IS NOT NULL. That was correct but incomplete: GET
 * /product-stream's real query (routes/productStream.ts) also joins to
 * businesses (for businessName) and to orders/order_items via a LATERAL
 * subquery (for the live sales/repeatCustomers aggregation) — none of
 * which app_public had any grant on at all. Running the actual query as
 * app_public failed with "permission denied for table businesses" before
 * even reaching orders/order_items. This migration is the fix, found by
 * actually testing the endpoint end-to-end rather than by re-reading
 * migration 008 and assuming it was sufficient because materials alone
 * looked right in isolation.
 *
 * Each of the three new grants below is scoped as narrowly as the actual
 * query needs, not opened up broadly just to make the join succeed:
 *
 * - businesses: a row is visible to app_public only if that business has
 *   AT LEAST ONE published material (catalog_meta IS NOT NULL on some
 *   materials row referencing it). This matters: without this
 *   restriction, joining businesses to materials would still only
 *   surface businesses that have a published item in the actual query
 *   productStream.ts runs (since that query INNER JOINs materials to
 *   businesses, filtered to catalog_meta IS NOT NULL on the materials
 *   side) — but RLS is a property of the TABLE, not of one specific
 *   query. A future public-facing feature that queries `businesses`
 *   directly (not joined through materials) should not be able to see
 *   every business name/holding_company_id in the system just because
 *   app_public has a SELECT grant — it should see exactly the same
 *   "has published something" boundary this endpoint relies on.
 *
 * - orders / order_items: visible to app_public only when direction =
 *   'sale' AND the order (or order_item's parent order) references a
 *   material that is itself published. This is deliberately narrower
 *   than "any order for a business with a published item" — a
 *   PURCHASE order (buying raw coconuts from a supplier) has nothing to
 *   do with public sales activity and should never be reachable by the
 *   public role, regardless of whether that business also sells
 *   something published. Only real, completed sales history for
 *   specifically-published materials feeds this endpoint's stats, and
 *   that's now enforced at the RLS layer, not just by how
 *   productStream.ts happens to write its WHERE clause.
 *
 * None of these three policies grant INSERT/UPDATE/DELETE — app_public
 * remains read-only everywhere, same as migration 008 established for
 * materials.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`GRANT SELECT ON businesses TO app_public;`);
  pgm.sql(`GRANT SELECT ON orders TO app_public;`);
  pgm.sql(`GRANT SELECT ON order_items TO app_public;`);

  // businesses: visible only if it has at least one published material.
  pgm.sql(`
    CREATE POLICY public_catalog ON businesses
      FOR SELECT
      TO app_public
      USING (
        EXISTS (
          SELECT 1 FROM materials m
          WHERE m.business_id = businesses.id
            AND m.catalog_meta IS NOT NULL
        )
      );
  `);

  // orders: visible only if direction = 'sale' AND at least one of its
  // order_items references a published material.
  pgm.sql(`
    CREATE POLICY public_catalog ON orders
      FOR SELECT
      TO app_public
      USING (
        orders.direction = 'sale'
        AND EXISTS (
          SELECT 1 FROM order_items oi
          JOIN materials m ON m.id = oi.material_id
          WHERE oi.order_id = orders.id
            AND m.catalog_meta IS NOT NULL
        )
      );
  `);

  // order_items: visible only if its own material is published AND its
  // parent order is a 'sale'. Checking BOTH conditions directly here
  // (rather than relying on orders' own RLS to have already filtered)
  // because RLS policies on different tables don't cascade into each
  // other automatically — a row in order_items is subject to its OWN
  // policy regardless of what orders' policy says, the same reasoning
  // that governs every other table's policy in this schema (see
  // is_business_visible_to_caller's design in migration 004).
  pgm.sql(`
    CREATE POLICY public_catalog ON order_items
      FOR SELECT
      TO app_public
      USING (
        EXISTS (
          SELECT 1 FROM materials m
          WHERE m.id = order_items.material_id
            AND m.catalog_meta IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM orders o
          WHERE o.id = order_items.order_id
            AND o.direction = 'sale'
        )
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON order_items;`);
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON orders;`);
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON businesses;`);
  pgm.sql(`REVOKE SELECT ON order_items FROM app_public;`);
  pgm.sql(`REVOKE SELECT ON orders FROM app_public;`);
  pgm.sql(`REVOKE SELECT ON businesses FROM app_public;`);
};
