/**
 * 018_business_integrations
 *
 * A business-scoped table for third-party API keys the OWNER supplies —
 * starting with embeddings providers for guide ingestion (see
 * routes/guideIngestion.ts), but deliberately not named
 * "embedding_providers" specifically, since the same shape (a business
 * brings their own key for a named provider) is likely to recur for
 * other integrations later, and a generic table now avoids a near-
 * identical migration 019 the first time that happens.
 *
 * THIS IS NOT THE SAME PROBLEM credentials (migration 006) SOLVES.
 * credentials stores a password_hash — one-way, never decrypted, only
 * ever compared against. A third-party API key must be genuinely
 * RETRIEVABLE (the server has to send the real key value to the actual
 * provider on every embedding request), so hashing is the wrong tool
 * entirely. This table stores AES-256-GCM CIPHERTEXT instead — real,
 * reversible encryption, decrypted only in application code
 * (lib/encryption.ts) at the moment a key is actually needed to call a
 * provider, using a server-side encryption key
 * (CREDENTIAL_ENCRYPTION_KEY, a NEW required env var — deliberately
 * separate from JWT_SECRET; a signing secret and an encryption key are
 * different cryptographic jobs and reusing one for the other is a
 * classic, avoidable mistake).
 *
 * provider is free text, not a fixed enum — "any AI, which the person
 * using it has to paste an API key for, could accept any" was the
 * explicit brief this table implements. routes/guideIngestion.ts's
 * embeddings dispatch function is what actually limits which providers
 * WORK today (it knows how to call OpenAI's and Voyage AI's embeddings
 * endpoints specifically — Anthropic's own recommended embeddings
 * partner, since Anthropic has no embeddings API of its own); this
 * table itself places no restriction on the provider string, so adding
 * a third provider later is a change to that dispatch function, not a
 * schema migration.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE business_integrations (
      id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id        uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      integration_type   text NOT NULL,
      provider           text NOT NULL,
      encrypted_api_key  text NOT NULL,
      encryption_iv      text NOT NULL,
      encryption_auth_tag text NOT NULL,
      created_at         timestamptz NOT NULL DEFAULT now(),
      updated_at         timestamptz NOT NULL DEFAULT now(),
      UNIQUE (business_id, integration_type)
    );
  `);
  // UNIQUE (business_id, integration_type): one active embeddings
  // provider per business at a time, deliberately — supporting several
  // simultaneous embeddings providers for the SAME business would mean
  // knowledge_chunks needed to track which provider embedded which row
  // (their vector spaces aren't comparable to each other), which is a
  // real complexity this design avoids by not allowing the ambiguous
  // state to exist in the first place. Switching providers later is a
  // real, deliberate migration-of-existing-chunks operation, not
  // something this table's shape should make look free.

  pgm.sql(`CREATE INDEX idx_business_integrations_business_id ON business_integrations(business_id);`);

  // Owner/worker manage their OWN business's integrations — ordinary
  // tenant-scoped table, same is_business_visible_to_caller narrowing
  // as every other business-scoped table (see migration 004's helper
  // function). NOT granted to app_public at all: unlike
  // transaction_paths (migration 015), which had a real reason for
  // public readability (routing needs it), there is no legitimate
  // reason a visitor-facing request should ever read this table, even
  // the encrypted ciphertext — the ingestion/embedding code that needs
  // a business's key runs under the authenticated owner/worker
  // connection (guide upload IS an authenticated owner action, same as
  // /guides/analyze already established), never under app_public.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON business_integrations TO app_owner_partner, app_worker;`);
  pgm.sql(`ALTER TABLE business_integrations ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE business_integrations FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON business_integrations
      TO app_owner_partner, app_worker
      USING (is_business_visible_to_caller(business_integrations.business_id));
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON business_integrations;`);
  pgm.sql(`REVOKE ALL ON business_integrations FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS business_integrations;`);
};
