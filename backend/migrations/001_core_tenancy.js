/**
 * 001_core_tenancy
 *
 * Extensions, and the three tables everything else hangs off of:
 * holding_companies -> businesses -> people.
 *
 * This file (and every migration after it) uses pgm.sql() with literal SQL
 * rather than node-pg-migrate's schema-builder API. The schema in this
 * project is a shared contract that three other codebases build against —
 * the migration file should read as the DDL, not as a translation of it.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`); // gen_random_uuid()
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "vector";`); // knowledge_chunks.embedding

  pgm.sql(`
    CREATE TABLE holding_companies (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name        text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE businesses (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      holding_company_id  uuid NOT NULL REFERENCES holding_companies(id) ON DELETE CASCADE,
      name                text NOT NULL,
      guide_source_id     uuid NULL,
      created_at          timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_businesses_holding_company_id ON businesses(holding_company_id);`);

  pgm.sql(`
    CREATE TABLE people (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      holding_company_id  uuid NOT NULL REFERENCES holding_companies(id) ON DELETE CASCADE,
      name                text NOT NULL,
      role                text NOT NULL CHECK (role IN ('owner', 'partner', 'worker')),
      email               text NOT NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_people_holding_company_id ON people(holding_company_id);`);
  // A person authenticates by email; lookups at login are by (holding_company_id, email).
  pgm.sql(`CREATE UNIQUE INDEX idx_people_holding_company_email ON people(holding_company_id, email);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS people;`);
  pgm.sql(`DROP TABLE IF EXISTS businesses;`);
  pgm.sql(`DROP TABLE IF EXISTS holding_companies;`);
};
