/**
 * 002_business_structure
 *
 * business_nodes: the self-referencing tree (product_line -> workflow -> task)
 * that each business's operating guide gets parsed into.
 *
 * partnerships / allocation_rules: who owns what % of a business, and the
 * versioned history of split changes over time. allocation_rules.splits is
 * validated for "sums to 100" at the application layer (see
 * src/lib/allocationRules.ts) inside the same transaction as the insert —
 * jsonb array contents aren't practically checkable in a CHECK constraint,
 * and the failure needs to be a normal request-time 400, not a constraint
 * violation with a database-specific error shape.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE business_nodes (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      parent_id   uuid NULL REFERENCES business_nodes(id) ON DELETE CASCADE,
      node_type   text NOT NULL CHECK (node_type IN ('product_line', 'workflow', 'task')),
      title       text NOT NULL,
      metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_business_nodes_business_id ON business_nodes(business_id);`);
  pgm.sql(`CREATE INDEX idx_business_nodes_parent_id ON business_nodes(parent_id);`);
  // Explicitly requested in the brief, and distinct from the two single-column
  // indexes above: this composite index is what the "get children of this
  // parent, within this business" access pattern (the subtree query, run
  // once per level) actually hits.
  pgm.sql(`CREATE INDEX idx_business_nodes_business_parent ON business_nodes(business_id, parent_id);`);

  pgm.sql(`
    CREATE TABLE partnerships (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      person_id           uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      ownership_pct       numeric(5,2) NOT NULL CHECK (ownership_pct >= 0 AND ownership_pct <= 100),
      capital_contributed numeric(14,2) NOT NULL DEFAULT 0
    );
  `);
  pgm.sql(`CREATE INDEX idx_partnerships_business_id ON partnerships(business_id);`);
  pgm.sql(`CREATE INDEX idx_partnerships_person_id ON partnerships(person_id);`);
  // RLS on `businesses` for partner-role sessions is a subquery against this
  // table shaped exactly like this composite lookup — see migration 004.
  pgm.sql(`CREATE INDEX idx_partnerships_person_business ON partnerships(person_id, business_id);`);

  pgm.sql(`
    CREATE TABLE allocation_rules (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      version         int NOT NULL,
      effective_from  timestamptz NOT NULL,
      splits          jsonb NOT NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_allocation_rules_business_id ON allocation_rules(business_id);`);
  // Version numbers are per-business and sequential; this is both the natural
  // key and what ledger_entries.allocation_rule_version joins back against.
  pgm.sql(`CREATE UNIQUE INDEX idx_allocation_rules_business_version ON allocation_rules(business_id, version);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS allocation_rules;`);
  pgm.sql(`DROP TABLE IF EXISTS partnerships;`);
  pgm.sql(`DROP TABLE IF EXISTS business_nodes;`);
};
