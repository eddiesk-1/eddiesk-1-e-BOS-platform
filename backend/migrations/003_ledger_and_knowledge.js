/**
 * 003_ledger_and_knowledge
 *
 * ledger_entries: double-entry bookkeeping. The schema does NOT enforce
 * "every transaction posts a balanced debit and credit pair" via a table
 * constraint — that's a cross-row invariant (two rows, equal amount,
 * opposite entry_type, same business_id) and Postgres CHECK constraints
 * can only see the row being written. The invariant is enforced by
 * src/routes/ledgerEntries.ts, which requires POST /ledger-entries to
 * receive exactly a [debit, credit] pair and inserts both rows in a single
 * transaction, each pointing at the other via related_entry_id. Anyone
 * writing directly to this table (a migration, a script, a future service)
 * that doesn't go through that transaction can silently break the
 * invariant — see the README's "Ledger integrity" section.
 *
 * knowledge_chunks: RAG storage for parsed operating guides. ivfflat needs
 * rows to train its clusters against, so the vector index is deferred to
 * migration 006 (seed) rather than created empty here.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE ledger_entries (
      id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id            uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      entry_type             text NOT NULL CHECK (entry_type IN ('debit', 'credit')),
      account                text NOT NULL,
      amount                 numeric(14,2) NOT NULL CHECK (amount > 0),
      related_entry_id       uuid NULL REFERENCES ledger_entries(id) ON DELETE RESTRICT,
      allocation_rule_version int NULL,
      created_at             timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_ledger_entries_business_id ON ledger_entries(business_id);`);
  pgm.sql(`CREATE INDEX idx_ledger_entries_related_entry_id ON ledger_entries(related_entry_id);`);
  // The rollup endpoint (GET /holding-companies/:id/rollup) is a live SUM(amount)
  // grouped by (business_id, entry_type) across every business under the holding
  // company. This index is what keeps that a fast query instead of a seq scan
  // as ledger_entries grows.
  pgm.sql(`CREATE INDEX idx_ledger_entries_business_type ON ledger_entries(business_id, entry_type);`);

  pgm.sql(`
    CREATE TABLE knowledge_chunks (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      source_guide_id uuid NOT NULL,
      content         text NOT NULL,
      embedding       vector(1536) NOT NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_knowledge_chunks_business_id ON knowledge_chunks(business_id);`);
  pgm.sql(`CREATE INDEX idx_knowledge_chunks_source_guide_id ON knowledge_chunks(source_guide_id);`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP TABLE IF EXISTS knowledge_chunks;`);
  pgm.sql(`DROP TABLE IF EXISTS ledger_entries;`);
};
