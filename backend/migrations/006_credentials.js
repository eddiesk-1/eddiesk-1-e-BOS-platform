/**
 * 006_credentials
 *
 * The shared contract's `people` table has no password/credential column —
 * deliberately not adding one here either. `people` is a table three other
 * codebases build against per the shared contract; silently bolting a
 * password_hash column onto it risks colliding with whatever any of those
 * other services independently assumes people rows look like, and the
 * brief's "DO NOT DEVIATE FROM THESE NAMES/TYPES" instruction is about not
 * doing exactly that kind of quiet schema extension.
 *
 * Instead: a separate `credentials` table, 1:1 with people by person_id,
 * that this service owns and nothing else needs to know about. Anything
 * reading `people` through the contract API still sees exactly the four
 * contract columns; login is implemented against this table instead.
 *
 * This table does NOT get an RLS tenant_isolation policy shaped like the
 * others — login has to be able to look up a credentials row BEFORE a JWT
 * (and therefore before app.holding_company_id) exists to scope by. See
 * src/routes/auth.ts for how the login route queries this table using a
 * connection that's SET ROLE'd to app_owner_partner with no session vars
 * set (which, given how the RLS policies in 004/005 are written, means
 * every *other* protected table returns zero rows for that connection —
 * but credentials isn't RLS-protected in the first place, so the lookup
 * still succeeds). It IS still scoped by holding_company_id as an ordinary
 * WHERE clause in the login query itself, since a person's email is only
 * unique within their holding company (see the unique index on
 * people(holding_company_id, email) in migration 001).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE credentials (
      person_id     uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
      password_hash text NOT NULL
    );
  `);

  // The login route connects as app_owner_partner (see auth.ts) to read
  // this table, since no role has been chosen yet at that point in the
  // request. Workers still need their own login to succeed, so grant here
  // is broader than the app_worker restriction pattern used elsewhere —
  // this table holds no business/financial data, just password hashes, so
  // there's nothing for the ledger_entries/allocation_rules-style REVOKE
  // to protect here.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON credentials TO app_owner_partner, app_worker;`);
};

exports.down = (pgm) => {
  pgm.sql(`REVOKE ALL ON credentials FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS credentials;`);
};
