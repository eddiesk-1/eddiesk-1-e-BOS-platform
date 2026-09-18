/**
 * 015_human_handoff_routing
 *
 * The schema for: "humans (closest to the consumer's location) get
 * invited into an AI-handled chat after the consumer provides evidence
 * of order payment and self-identification." Five additions, one
 * coherent feature:
 *
 * 1. people.latitude/longitude/location_label — self-service location a
 *    member sets on their own record (PATCH /people/me/location, see
 *    routes/people.ts). Nullable: not every member needs to set one
 *    immediately, and a member with no location simply can't be matched
 *    by proximity until they do.
 *
 * 2. transaction_paths — a member's own declared service scope: which
 *    regions and which transaction types they personally handle. One
 *    person can have several (e.g. "coconut oil sales in Texas" AND
 *    "bulk orders anywhere"), so it's its own table, not columns on
 *    people. transaction_types is a free-text array, not a fixed enum —
 *    same reasoning as orders.status being free-text: what counts as a
 *    "transaction type" is business-specific, and inventing a closed
 *    vocabulary here would be guessing at conventions this project has
 *    no basis to assume.
 *
 * 3. transaction_tokens — the actual escalation proof. Generated at the
 *    moment of a REAL completed transaction, tied to a specific orders
 *    row. The consumer holds this token (same "opaque uuid, client
 *    stores it, presents it back" pattern as conversations.visitor_token)
 *    and submits it INTO their conversation as proof of payment.
 *    Single-use: redeemed_at is set the moment it's successfully used,
 *    and a redeemed token can never be redeemed again — this is what
 *    makes it a real proof rather than a shareable, endlessly-reusable
 *    secret.
 *
 * 4. conversations.handled_by — 'ai' (default) | 'awaiting_human' |
 *    'staff'. Transitions to 'awaiting_human' when BOTH conditions are
 *    met: the conversation is identified (counterparty_id IS NOT NULL —
 *    already built, migration 013) AND a valid transaction_token has
 *    been redeemed into it. Transitions to 'staff' when a real person
 *    claims it.
 *
 * 5. conversations.consumer_region_label — set by the AI reply-
 *    generation logic as a side effect of understanding, through
 *    ordinary conversation, where the consumer is ("through their
 *    conversation with the AI" — not a structured form field the
 *    consumer fills in, and NOT geocoded coordinates; this is a free-text
 *    label the AI extracts, e.g. "Austin, TX" or "shipping to the UK").
 *
 * WHAT "CLOSEST" ACTUALLY MEANS HERE, STATED HONESTLY: this schema
 * captures real lat/long for MEMBERS (addition 1), but never captures
 * real coordinates for a CONSUMER — only a free-text region label the AI
 * extracted from conversation. That means true geographic distance
 * cannot be computed between "the consumer" and any candidate member;
 * there is no consumer point to measure from. What's actually
 * implemented (routes/conversations.ts's routing logic) is REGION-LABEL
 * MATCHING, not distance math: candidates whose transaction_paths.
 * region_label matches consumer_region_label (or who declared no region
 * restriction at all, i.e. "handles anywhere") are preferred over
 * everyone else, and among matches, an exact region match ranks above a
 * wildcard "anywhere" entry. This is a real, useful proxy for "handles
 * this consumer's area" — it is NOT literal proximity ranking, and
 * anyone extending this feature with genuine lat/long-based nearest-
 * neighbor routing would need to also solve consumer geolocation first
 * — that's a separate, bigger capability this migration deliberately
 * does not build or fake.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // --- 1. Member self-service location -------------------------------
  pgm.sql(`ALTER TABLE people ADD COLUMN latitude numeric(9,6) NULL;`);
  pgm.sql(`ALTER TABLE people ADD COLUMN longitude numeric(9,6) NULL;`);
  pgm.sql(`ALTER TABLE people ADD COLUMN location_label text NULL;`);
  pgm.sql(
    `ALTER TABLE people ADD CONSTRAINT people_lat_long_together CHECK (
      (latitude IS NULL AND longitude IS NULL) OR (latitude IS NOT NULL AND longitude IS NOT NULL)
    );`,
  );

  // --- 2. Member-declared transaction paths ---------------------------
  pgm.sql(`
    CREATE TABLE transaction_paths (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id         uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      region_label      text NULL,
      transaction_types text[] NOT NULL DEFAULT '{}',
      created_at        timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_transaction_paths_person_id ON transaction_paths(person_id);`);
  pgm.sql(`CREATE INDEX idx_transaction_paths_region_label ON transaction_paths(region_label);`);

  // --- 3. Transaction tokens (the payment-proof escalation trigger) ---
  pgm.sql(`
    CREATE TABLE transaction_tokens (
      id                           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      order_id                     uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      counterparty_id              uuid NOT NULL REFERENCES counterparties(id) ON DELETE CASCADE,
      token                        uuid NOT NULL DEFAULT gen_random_uuid(),
      created_at                   timestamptz NOT NULL DEFAULT now(),
      redeemed_at                  timestamptz NULL,
      redeemed_by_conversation_id  uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
      CONSTRAINT redeemed_fields_together CHECK (
        (redeemed_at IS NULL AND redeemed_by_conversation_id IS NULL) OR
        (redeemed_at IS NOT NULL AND redeemed_by_conversation_id IS NOT NULL)
      )
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_transaction_tokens_token ON transaction_tokens(token);`);
  pgm.sql(`CREATE INDEX idx_transaction_tokens_order_id ON transaction_tokens(order_id);`);
  pgm.sql(`CREATE INDEX idx_transaction_tokens_counterparty_id ON transaction_tokens(counterparty_id);`);

  // --- 4 & 5. Conversation escalation state ----------------------------
  pgm.sql(`
    ALTER TABLE conversations ADD COLUMN handled_by text NOT NULL DEFAULT 'ai'
      CHECK (handled_by IN ('ai', 'awaiting_human', 'staff'));
  `);
  pgm.sql(`ALTER TABLE conversations ADD COLUMN consumer_region_label text NULL;`);
  pgm.sql(
    `ALTER TABLE conversations ADD COLUMN claimed_by_person_id uuid NULL REFERENCES people(id) ON DELETE SET NULL;`,
  );
  pgm.sql(`CREATE INDEX idx_conversations_handled_by ON conversations(handled_by);`);

  // --- Grants and RLS ---------------------------------------------------
  pgm.sql(`GRANT SELECT, INSERT, UPDATE, DELETE ON transaction_paths TO app_owner_partner, app_worker;`);
  pgm.sql(`ALTER TABLE transaction_paths ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE transaction_paths FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON transaction_paths
      USING (
        EXISTS (
          SELECT 1 FROM people p
          WHERE p.id = transaction_paths.person_id
            AND p.holding_company_id = current_setting('app.holding_company_id', true)::uuid
        )
      );
  `);
  // Public routing lookup: escalation-matching needs to read
  // transaction_paths/people for candidate routing WITHOUT a JWT (it runs
  // inside the visitor-facing token-redemption request). transaction_paths
  // carries no sensitive data (no financial figures, no customer info) —
  // "which member handles what" is operationally fine to expose for
  // routing, unlike ledger_entries/allocation_rules which stay REVOKEd
  // from workers even internally.
  pgm.sql(`GRANT SELECT ON transaction_paths TO app_public;`);
  pgm.sql(`GRANT SELECT ON people TO app_public;`);
  pgm.sql(`
    CREATE POLICY public_routing_lookup ON transaction_paths
      FOR SELECT
      TO app_public
      USING (true);
  `);
  pgm.sql(`
    CREATE POLICY public_routing_lookup ON people
      FOR SELECT
      TO app_public
      USING (true);
  `);
  // people's existing tenant_isolation policy has no TO clause — the SAME
  // class of gap migration 011 fixed for businesses/orders/order_items.
  // Narrowed HERE, in the same migration that grants app_public access to
  // people, rather than risk shipping that bug a third time.
  pgm.sql(`ALTER POLICY tenant_isolation ON people TO app_owner_partner, app_worker;`);

  // transaction_tokens: NOT readable by app_public — a token's VALUE is
  // the whole security model (possession = proof); a visitor never lists
  // or browses tokens, only ever presents the one they already have.
  // Redemption goes through a SECURITY DEFINER function (migration 016),
  // mirroring identify_conversation()'s pattern for the same reason.
  pgm.sql(`GRANT SELECT, INSERT ON transaction_tokens TO app_owner_partner, app_worker;`);
  pgm.sql(`ALTER TABLE transaction_tokens ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE transaction_tokens FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON transaction_tokens
      USING (
        EXISTS (
          SELECT 1 FROM orders o
          WHERE o.id = transaction_tokens.order_id
            AND is_business_visible_to_caller(o.business_id)
        )
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER POLICY tenant_isolation ON people TO public;`);
  pgm.sql(`DROP POLICY IF EXISTS public_routing_lookup ON people;`);
  pgm.sql(`DROP POLICY IF EXISTS public_routing_lookup ON transaction_paths;`);
  pgm.sql(`REVOKE SELECT ON people FROM app_public;`);
  pgm.sql(`REVOKE SELECT ON transaction_paths FROM app_public;`);

  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON transaction_tokens;`);
  pgm.sql(`REVOKE ALL ON transaction_tokens FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS transaction_tokens;`);

  pgm.sql(`DROP INDEX IF EXISTS idx_conversations_handled_by;`);
  pgm.sql(`ALTER TABLE conversations DROP COLUMN IF EXISTS claimed_by_person_id;`);
  pgm.sql(`ALTER TABLE conversations DROP COLUMN IF EXISTS consumer_region_label;`);
  pgm.sql(`ALTER TABLE conversations DROP COLUMN IF EXISTS handled_by;`);

  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON transaction_paths;`);
  pgm.sql(`REVOKE ALL ON transaction_paths FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS transaction_paths;`);

  pgm.sql(`ALTER TABLE people DROP CONSTRAINT IF EXISTS people_lat_long_together;`);
  pgm.sql(`ALTER TABLE people DROP COLUMN IF EXISTS location_label;`);
  pgm.sql(`ALTER TABLE people DROP COLUMN IF EXISTS longitude;`);
  pgm.sql(`ALTER TABLE people DROP COLUMN IF EXISTS latitude;`);
};
