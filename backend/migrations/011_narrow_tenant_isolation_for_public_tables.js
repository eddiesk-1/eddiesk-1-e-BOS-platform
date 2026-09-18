/**
 * 011_narrow_tenant_isolation_for_public_tables
 *
 * Migration 008 did `ALTER POLICY tenant_isolation ON materials TO
 * app_owner_partner, app_worker` — narrowing that policy's role list so
 * it stops applying to app_public (which has its own separate
 * public_catalog policy). That comment even explained why: "without
 * this, Postgres would AND the two policies together for app_public."
 * But migration 008 only ran that ALTER POLICY against materials.
 * Migration 009 then granted app_public SELECT on businesses, orders,
 * and order_items too — all three of which ALSO have a tenant_isolation
 * policy with no TO clause (defaulting to PUBLIC, i.e. every role,
 * including app_public) — and nothing ever narrowed those three the same
 * way. The gap was invisible until GET /product-stream was actually run
 * end-to-end: querying businesses/orders/order_items as app_public
 * failed with "permission denied for table partnerships", NOT because
 * app_public was denied businesses/orders/order_items directly, but
 * because evaluating whether tenant_isolation's condition applies
 * requires calling is_business_visible_to_caller(), which internally
 * queries partnerships — a table app_public has no grant on at all. RLS
 * combines multiple applicable permissive policies with OR, but Postgres
 * still has to EVALUATE every policy that targets the querying role to
 * know whether to OR it in; an unnarrowed tenant_isolation targets every
 * role by default, so it was being evaluated (and failing) for
 * app_public even though public_catalog alone would have returned the
 * right rows.
 *
 * This is the third bug in this integration effort caused by the same
 * root pattern: a fix applied to one table in migration 008 needed to be
 * applied everywhere the underlying condition (app_public needing
 * isolation FROM the tenant-scoped policy machinery) actually recurs,
 * and wasn't. Fixed here by running the same ALTER POLICY against the
 * three tables migration 008 missed.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER POLICY tenant_isolation ON businesses TO app_owner_partner, app_worker;`);
  pgm.sql(`ALTER POLICY tenant_isolation ON orders TO app_owner_partner, app_worker;`);
  pgm.sql(`ALTER POLICY tenant_isolation ON order_items TO app_owner_partner, app_worker;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER POLICY tenant_isolation ON order_items TO public;`);
  pgm.sql(`ALTER POLICY tenant_isolation ON orders TO public;`);
  pgm.sql(`ALTER POLICY tenant_isolation ON businesses TO public;`);
};
