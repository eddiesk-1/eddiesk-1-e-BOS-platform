/**
 * 008_public_catalog_access
 *
 * Every other table in this schema is reachable only by an authenticated
 * caller, scoped to their holding company (see migration 004's three-layer
 * RLS design). GET /product-stream is different on purpose: it's a public
 * landing page, meant to be viewed by an anonymous visitor with no login
 * at all — "the ecosystem across the whole platform," not one tenant's
 * data. Forcing that through the existing app_owner_partner/app_worker +
 * JWT machinery would mean either requiring every visitor to authenticate
 * (wrong — defeats the point of a public discovery page) or weakening
 * holding-company RLS to let unauthenticated callers see everything
 * (wrong — that's not a public-catalog exception, that's breaking tenant
 * isolation for everyone).
 *
 * The actual answer: a THIRD Postgres role, app_public, that:
 *   1. Has SELECT only (no INSERT/UPDATE/DELETE) on exactly one table,
 *      materials — nothing else in the schema is reachable this way.
 *   2. Is governed by its own RLS policy on materials, `public_catalog`,
 *      which has NOTHING to do with holding_company_id or partnerships —
 *      it has exactly one condition: catalog_meta IS NOT NULL. Setting
 *      catalog_meta (via the authenticated PATCH /materials/:id route,
 *      same auth as every other write in this service) IS the publish
 *      action. A material an owner/worker never explicitly published
 *      is invisible to this role, full stop, regardless of what business
 *      or holding company it belongs to.
 *   3. Is NOLOGIN, exactly like app_owner_partner/app_worker — no client
 *      ever authenticates to Postgres directly as app_public either. The
 *      connection pool used by GET /product-stream (see
 *      src/lib/publicDb.ts) authenticates as a dedicated login role,
 *      app_public_login, that can ONLY SET ROLE into app_public — it
 *      cannot become app_owner_partner or app_worker, so even a bug in
 *      this endpoint's code can't accidentally escalate it into touching
 *      tenant-scoped data the way a compromised app_login connection
 *      theoretically could (app_login can become either restricted role,
 *      by design, since real requests need to be able to be either
 *      owner/partner or worker depending on the JWT presented — a
 *      public-facing connection has no such need and is deliberately
 *      denied the capability rather than just not exercising it).
 *
 * FORCE ROW LEVEL SECURITY still applies (materials already has it from
 * migration 005) — app_public is bound by public_catalog the same way
 * app_owner_partner/app_worker are bound by tenant_isolation. Two
 * policies coexist on the same table; Postgres evaluates whichever
 * policy applies to the role actually making the query (RLS policies are
 * not combined across roles — each role only sees the policies that
 * target it, or that have no explicit role restriction and therefore
 * apply to everyone. tenant_isolation was created with no TO clause,
 * which defaults to PUBLIC — meaning it would also apply to app_public
 * unless we're explicit. public_catalog is created FOR app_public
 * specifically, and tenant_isolation is narrowed below to exclude
 * app_public, so the two policies don't stack in a way that would
 * accidentally require BOTH conditions or leak tenant-scoped columns to
 * the public role).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_public') THEN
        CREATE ROLE app_public NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_public_login') THEN
        CREATE ROLE app_public_login LOGIN PASSWORD 'change_me_in_production';
      END IF;
    END
    $$;
  `);
  // app_public_login can become app_public and ONLY app_public — it is
  // never granted membership in app_owner_partner or app_worker, so
  // there is no SET ROLE path from the public connection into
  // tenant-scoped access, even in principle.
  pgm.sql(`GRANT app_public TO app_public_login;`);

  pgm.sql(`GRANT USAGE ON SCHEMA public TO app_public;`);
  pgm.sql(`GRANT SELECT ON materials TO app_public;`);

  // Narrow tenant_isolation (created in migration 005 with no TO clause,
  // i.e. defaulting to PUBLIC/every role) so it no longer applies to
  // app_public specifically. Without this, Postgres would AND the two
  // policies together for app_public — requiring a row to be BOTH
  // "visible to some holding_company_id session context that doesn't
  // exist for this role" AND "published," which would make every row
  // invisible to app_public regardless of catalog_meta, since app_public
  // never has app.holding_company_id set at all.
  pgm.sql(`ALTER POLICY tenant_isolation ON materials TO app_owner_partner, app_worker;`);

  pgm.sql(`
    CREATE POLICY public_catalog ON materials
      FOR SELECT
      TO app_public
      USING (catalog_meta IS NOT NULL);
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS public_catalog ON materials;`);
  pgm.sql(`ALTER POLICY tenant_isolation ON materials TO public;`);
  pgm.sql(`REVOKE SELECT ON materials FROM app_public;`);
  pgm.sql(`REVOKE USAGE ON SCHEMA public FROM app_public;`);
  pgm.sql(`REVOKE app_public FROM app_public_login;`);
  pgm.sql(`DROP ROLE IF EXISTS app_public_login;`);
  pgm.sql(`DROP ROLE IF EXISTS app_public;`);
};
