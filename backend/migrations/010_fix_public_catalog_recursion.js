/**
 * 010_fix_public_catalog_recursion
 *
 * Migration 009 gave orders' public_catalog policy an EXISTS subquery
 * against order_items, and gave order_items' own public_catalog policy an
 * EXISTS subquery against orders. That is the EXACT SAME two-table cycle
 * shape that migration 004's long comment on is_business_visible_to_caller
 * already documents and warns about — evaluating order_items' RLS
 * requires evaluating orders' RLS, which requires evaluating order_items'
 * RLS again. Postgres raised "infinite recursion detected in policy for
 * relation order_items" (SQLSTATE 42P17) for every query touching either
 * table via app_public, which broke GET /product-stream outright (found
 * by actually running the endpoint end-to-end after migration 009
 * applied cleanly with no SQL error — a clean migration apply does not
 * mean the policies it creates are actually usable, which is exactly why
 * this project tests behaviorally rather than trusting "no error on
 * CREATE POLICY" as sufficient).
 *
 * This is a real lesson not fully learned the first time: migration 004's
 * own comment explicitly warns "if you're adding a new tenant-scoped
 * table, call [the helper] function from its policy rather than writing
 * a new inline partnerships/businesses check — that's exactly the
 * pattern that broke last time." Migration 009 added two NEW policies
 * that reference each other directly instead of routing through a
 * shared, non-recursive helper — the same mistake in a new location.
 *
 * The fix, same pattern as migration 004: SECURITY DEFINER functions
 * that compute the underlying checks WITHOUT going through the other
 * table's own RLS policy, so two policies can depend on the same
 * underlying fact without depending on EACH OTHER. Both orders' and
 * order_items' public_catalog policies are DROPped and recreated to call
 * these functions instead of directly querying each other's table.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION is_material_published(target_material_id uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    STABLE
    SET search_path = public
    AS $$
      SELECT EXISTS (
        SELECT 1 FROM materials m
        WHERE m.id = target_material_id
          AND m.catalog_meta IS NOT NULL
      );
    $$;
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION is_order_a_published_sale(target_order_id uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    STABLE
    SET search_path = public
    AS $$
      SELECT EXISTS (
        SELECT 1 FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN materials m ON m.id = oi.material_id
        WHERE o.id = target_order_id
          AND o.direction = 'sale'
          AND m.catalog_meta IS NOT NULL
      );
    $$;
  `);
  pgm.sql(`GRANT EXECUTE ON FUNCTION is_material_published(uuid) TO app_public;`);
  pgm.sql(`GRANT EXECUTE ON FUNCTION is_order_a_published_sale(uuid) TO app_public;`);

  // orders: was EXISTS (... FROM order_items oi JOIN materials m ...) —
  // now calls the function instead. Same visibility rule, no direct
  // reference to order_items' table from within this policy.
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON orders;`);
  pgm.sql(`
    CREATE POLICY public_catalog ON orders
      FOR SELECT
      TO app_public
      USING (
        orders.direction = 'sale'
        AND is_order_a_published_sale(orders.id)
      );
  `);

  // order_items: was EXISTS (... FROM materials ...) AND EXISTS (...
  // FROM orders o ...) — the second EXISTS against orders is what closed
  // the cycle (orders' policy, in turn, queried order_items). Now calls
  // is_material_published() for the material check and
  // is_order_a_published_sale() for the order check instead of querying
  // orders directly — that function's own internal query against orders
  // runs SECURITY DEFINER, so it does not re-trigger orders' RLS policy,
  // which is what breaks the cycle.
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON order_items;`);
  pgm.sql(`
    CREATE POLICY public_catalog ON order_items
      FOR SELECT
      TO app_public
      USING (
        is_material_published(order_items.material_id)
        AND is_order_a_published_sale(order_items.order_id)
      );
  `);

  // businesses: unchanged in substance (still "has a published
  // material"), but routed through the new function instead of an
  // inline EXISTS against materials, for consistency — one definition of
  // "is this material published," reused everywhere.
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON businesses;`);
  pgm.sql(`
    CREATE POLICY public_catalog ON businesses
      FOR SELECT
      TO app_public
      USING (
        EXISTS (
          SELECT 1 FROM materials m
          WHERE m.business_id = businesses.id
            AND is_material_published(m.id)
        )
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON businesses;`);
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

  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON order_items;`);
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

  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON orders;`);
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

  pgm.sql(`REVOKE EXECUTE ON FUNCTION is_order_a_published_sale(uuid) FROM app_public;`);
  pgm.sql(`REVOKE EXECUTE ON FUNCTION is_material_published(uuid) FROM app_public;`);
  pgm.sql(`DROP FUNCTION IF EXISTS is_order_a_published_sale(uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS is_material_published(uuid);`);
};
