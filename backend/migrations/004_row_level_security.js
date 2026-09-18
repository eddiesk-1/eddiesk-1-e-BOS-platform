/**
 * 004_row_level_security
 *
 * This is the migration that actually implements "scoped by holding_company_id,
 * partners further scoped to businesses they appear in via partnerships,
 * workers blocked from ledger_entries/allocation_rules at the database level."
 * Read this file's comments before touching any RLS policy — the mechanism
 * has three layers and it's easy to change one without the others.
 *
 * LAYER 1 — two Postgres roles, not one.
 *   app_owner_partner : used for DB connections when the JWT role claim is
 *                        'owner' or 'partner'. Has full CRUD grants on every
 *                        app table.
 *   app_worker         : used when the JWT role claim is 'worker'. Has CRUD
 *                        grants on everything EXCEPT ledger_entries and
 *                        allocation_rules, which are REVOKEd outright.
 *
 *   Why two DB roles instead of one role plus an RLS policy that hides
 *   ledger rows from workers: RLS with USING (false) still lets the query
 *   plan and execute — it just returns zero rows. The task requires workers
 *   "never query ledger_entries or allocation_rules at the database level,"
 *   which means the query itself has to be refused (permission denied for
 *   relation ledger_entries), not silently return an empty result set that
 *   looks identical to "no entries yet." A REVOKE does that; RLS alone
 *   cannot. See src/lib/db.ts for how a request's JWT role claim picks
 *   which of these two Postgres roles the pooled connection SET ROLEs into.
 *
 * LAYER 2 — session variables, set per-request via SET LOCAL inside the
 *   request's transaction (see src/plugins/tenantContext.ts):
 *     app.holding_company_id  -- from the JWT, every request
 *     app.person_id           -- from the JWT, every request
 *     app.person_role         -- from the JWT, every request
 *   SET LOCAL (not SET) so the value is scoped to the transaction and can't
 *   leak across pooled connections between requests.
 *
 * LAYER 3 — RLS policies on every tenant-scoped table, using those session
 *   vars. holding_companies/businesses/business_nodes/people/partnerships/
 *   allocation_rules/ledger_entries/knowledge_chunks are ALL scoped to the
 *   caller's holding_company_id (directly, or via a join up to businesses
 *   for tables that don't carry holding_company_id themselves). On top of
 *   that base scoping, businesses/business_nodes/knowledge_chunks carry an
 *   ADDITIONAL policy clause for partner-role sessions: a business is only
 *   visible to a partner if a partnerships row links their person_id to
 *   that business_id. This is a live join against partnerships on every
 *   query, not a cached list, so it can never drift from the actual
 *   partnership records.
 *
 * FORCE ROW LEVEL SECURITY is set on every table in addition to ENABLE.
 * Without FORCE, RLS is bypassed for the table owner. The app connects as
 * app_owner_partner / app_worker (never as the owning role), so this
 * matters most for anyone who later runs an ad hoc script as the table
 * owner and assumes RLS still applies.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // --- Roles -----------------------------------------------------------
  // NOLOGIN: these are permission templates the app assumes via SET ROLE
  // after connecting as a login role (see src/lib/db.ts). No client ever
  // authenticates to Postgres directly as app_owner_partner or app_worker.
  pgm.sql(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_owner_partner') THEN
        CREATE ROLE app_owner_partner NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_worker') THEN
        CREATE ROLE app_worker NOLOGIN;
      END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_login') THEN
        CREATE ROLE app_login LOGIN PASSWORD 'change_me_in_production';
      END IF;
    END
    $$;
  `);
  // app_login is the role the connection pool actually authenticates as.
  // It has no direct table grants of its own — every request immediately
  // SET ROLEs into app_owner_partner or app_worker (see tenantContext.ts),
  // and it's only permitted to become those two.
  pgm.sql(`GRANT app_owner_partner TO app_login;`);
  pgm.sql(`GRANT app_worker TO app_login;`);

  const allTables = [
    'holding_companies',
    'businesses',
    'business_nodes',
    'people',
    'partnerships',
    'allocation_rules',
    'ledger_entries',
    'knowledge_chunks',
  ];
  const workerTables = allTables.filter(
    (t) => t !== 'ledger_entries' && t !== 'allocation_rules',
  );

  for (const table of allTables) {
    pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_owner_partner;`);
  }
  for (const table of workerTables) {
    pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${table} TO app_worker;`);
  }
  // Belt-and-suspenders: app_worker is never GRANTed anything on these two
  // tables above, so this REVOKE is a no-op today. It's here so that if
  // someone later adds a blanket "GRANT ALL ON ALL TABLES" migration, this
  // one still runs after it in sequence and the worker restriction holds.
  pgm.sql(`REVOKE ALL ON ledger_entries, allocation_rules FROM app_worker;`);

  // Sequences: every table's gen_random_uuid() PK doesn't need a sequence
  // grant, but node-pg-migrate's own tooling and any future serial/identity
  // columns will, so grant usage on the schema broadly for both roles.
  pgm.sql(`GRANT USAGE ON SCHEMA public TO app_owner_partner, app_worker;`);

  // --- Enable + force RLS on every tenant-scoped table ------------------
  for (const table of allTables) {
    pgm.sql(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;`);
  }

  // --- holding_companies: a row is visible only if it IS the caller's tenant
  pgm.sql(`
    CREATE POLICY tenant_isolation ON holding_companies
      USING (id = current_setting('app.holding_company_id', true)::uuid);
  `);

  // --- people: scoped directly by holding_company_id -------------------
  pgm.sql(`
    CREATE POLICY tenant_isolation ON people
      USING (holding_company_id = current_setting('app.holding_company_id', true)::uuid);
  `);

  // --- Partner-visibility helper: SECURITY DEFINER function ------------
  //
  // WHY THIS FUNCTION EXISTS (read this before editing any policy below):
  //
  // The first version of this migration gave businesses' policy an EXISTS
  // subquery against partnerships (for partner narrowing), and gave
  // partnerships' own policy an EXISTS subquery against businesses (for
  // tenant scoping). That is a two-table cycle: evaluating businesses' RLS
  // requires evaluating partnerships' RLS, which requires evaluating
  // businesses' RLS again. Postgres detects this and raises "infinite
  // recursion detected in policy for relation X" — and it did so for
  // EVERY query against either table, for every role, including
  // app_owner_partner, which meant RLS wasn't narrowing anything, it was
  // just erroring on every request. Restructuring the join order didn't
  // fix it, because the cycle is between the two policies themselves, not
  // between two particular queries.
  //
  // The fix is to compute partner visibility exactly once, in a function
  // that queries partnerships WITHOUT partnerships' own RLS policy being
  // in effect for that particular query — which is what SECURITY DEFINER
  // gives you: the function body runs with the privileges (and RLS
  // exposure) of its OWNER, not its caller. Since this function is
  // created by the migration role (effectively an admin role, not
  // app_owner_partner or app_worker), its internal SELECT against
  // partnerships bypasses partnerships' RLS entirely — which is safe
  // specifically because the function itself re-implements the exact
  // same check partnerships' RLS would have done, so nothing is actually
  // exposed that wouldn't have been visible anyway.
  //
  // Every policy below that needs "is business X visible to the current
  // caller" calls this function instead of writing its own partnerships
  // subquery. That means the partner-visibility rule is defined ONCE. If
  // it needs to change, it changes here, and every table that depends on
  // it picks up the change automatically instead of nine copies having to
  // be kept in sync by hand.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION is_business_visible_to_caller(target_business_id uuid)
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    STABLE
    SET search_path = public
    AS $$
      SELECT EXISTS (
        SELECT 1
        FROM businesses b
        WHERE b.id = target_business_id
          AND b.holding_company_id = current_setting('app.holding_company_id', true)::uuid
          AND (
            current_setting('app.person_role', true) <> 'partner'
            OR EXISTS (
              SELECT 1 FROM partnerships p
              WHERE p.business_id = b.id
                AND p.person_id = current_setting('app.person_id', true)::uuid
            )
          )
      );
    $$;
  `);
  // Ordinary app roles need EXECUTE on the function itself (SECURITY
  // DEFINER controls what happens INSIDE the function, not who can call
  // it — that's a separate, normal GRANT).
  pgm.sql(`GRANT EXECUTE ON FUNCTION is_business_visible_to_caller(uuid) TO app_owner_partner, app_worker;`);

  // --- businesses: holding_company_id scoping, PLUS partner narrowing --
  // Note this does NOT call is_business_visible_to_caller(businesses.id) —
  // doing so would recreate the exact cycle described above, just via a
  // function call instead of a subquery (the function's own internal
  // query against businesses would re-trigger businesses' policy, which
  // would call the function again). businesses' policy is the one place
  // in this migration allowed to inline the raw partnerships check,
  // because businesses is the base case: nothing else's visibility can be
  // computed without first knowing which businesses are visible, so this
  // policy has to be self-contained. Every other table's policy below
  // calls the function instead of repeating this block.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON businesses
      USING (
        holding_company_id = current_setting('app.holding_company_id', true)::uuid
        AND (
          current_setting('app.person_role', true) <> 'partner'
          OR EXISTS (
            SELECT 1 FROM partnerships p
            WHERE p.business_id = businesses.id
              AND p.person_id = current_setting('app.person_id', true)::uuid
          )
        )
      );
  `);

  // --- business_nodes: delegate to the helper function ------------------
  pgm.sql(`
    CREATE POLICY tenant_isolation ON business_nodes
      USING (is_business_visible_to_caller(business_nodes.business_id));
  `);

  // --- partnerships: delegate to the helper function ---------------------
  // This queries businesses via the function (SECURITY DEFINER, so it does
  // NOT re-trigger businesses' own RLS policy or loop back into
  // partnerships), rather than a direct EXISTS against businesses. That
  // direct-EXISTS version is exactly what caused the original recursion,
  // since evaluating it as part of partnerships' policy meant evaluating
  // businesses' policy, which (at the time) queried partnerships again.
  pgm.sql(`
    CREATE POLICY tenant_isolation ON partnerships
      USING (is_business_visible_to_caller(partnerships.business_id));
  `);

  // --- allocation_rules: delegate to the helper function -----------------
  // (app_worker has zero GRANTs on this table regardless of what RLS says
  // — see the REVOKE above — so this policy only ever actually evaluates
  // for owner/partner sessions. It's still defined correctly rather than
  // left permissive, since GRANT and RLS are independent layers.)
  pgm.sql(`
    CREATE POLICY tenant_isolation ON allocation_rules
      USING (is_business_visible_to_caller(allocation_rules.business_id));
  `);

  // --- ledger_entries: delegate to the helper function --------------------
  pgm.sql(`
    CREATE POLICY tenant_isolation ON ledger_entries
      USING (is_business_visible_to_caller(ledger_entries.business_id));
  `);

  // --- knowledge_chunks: delegate to the helper function -------------------
  pgm.sql(`
    CREATE POLICY tenant_isolation ON knowledge_chunks
      USING (is_business_visible_to_caller(knowledge_chunks.business_id));
  `);
};

exports.down = (pgm) => {
  const allTables = [
    'holding_companies',
    'businesses',
    'business_nodes',
    'people',
    'partnerships',
    'allocation_rules',
    'ledger_entries',
    'knowledge_chunks',
  ];
  for (const table of allTables) {
    pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON ${table};`);
    pgm.sql(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY;`);
    pgm.sql(`ALTER TABLE ${table} DISABLE ROW LEVEL SECURITY;`);
  }
  // DROP ROLE fails with "role cannot be dropped because some objects
  // depend on it" (error 2BP01) if any GRANT to that role is still in
  // effect — table AND function privileges both count as a dependency.
  // REVOKE everything from both roles before dropping the roles OR the
  // function they were granted EXECUTE on. (Discovered by actually
  // running this down migration against a populated database, not by
  // inspection — the up migration's GRANTs have to be unwound explicitly
  // and in dependency order, same as everything else here. The first pass
  // at this down migration dropped the function before revoking EXECUTE
  // on it, which is the same class of ordering bug.)
  for (const table of allTables) {
    pgm.sql(`REVOKE ALL ON ${table} FROM app_owner_partner, app_worker;`);
  }
  pgm.sql(`REVOKE ALL ON SCHEMA public FROM app_owner_partner, app_worker;`);
  pgm.sql(`REVOKE EXECUTE ON FUNCTION is_business_visible_to_caller(uuid) FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP FUNCTION IF EXISTS is_business_visible_to_caller(uuid);`);

  pgm.sql(`REVOKE app_owner_partner FROM app_login;`);
  pgm.sql(`REVOKE app_worker FROM app_login;`);
  pgm.sql(`DROP ROLE IF EXISTS app_login;`);
  pgm.sql(`DROP ROLE IF EXISTS app_owner_partner;`);
  pgm.sql(`DROP ROLE IF EXISTS app_worker;`);
};
