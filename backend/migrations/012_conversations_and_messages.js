/**
 * 012_conversations_and_messages
 *
 * ONE new pair of tables, deliberately shared between two different
 * features rather than two separate schemas:
 *
 *   - consumer chat: an anonymous landing-page visitor asking a business
 *     a question, per the user's explicit request this migration
 *     implements.
 *   - internal org messaging: owner/partner/worker communication within a
 *     business, requested at the same time but explicitly deferred —
 *     "both, consumer chat first." conversations.kind already has an
 *     'internal' value in its CHECK constraint so the table shape doesn't
 *     need to change when that half gets built, but NOTHING in this
 *     migration (routes, RLS policies, grants) implements it yet. A
 *     conversation with kind='internal' cannot currently be created or
 *     read by anything in this codebase — the CHECK constraint accepting
 *     the value is not the same as the feature existing.
 *
 * WHY ONE TABLE PAIR INSTEAD OF TWO: both features are fundamentally "an
 * ordered thread of messages between named senders, scoped to a
 * business." Building them as two independent schemas now would mean
 * duplicating that shape and then having two different RLS patterns to
 * keep correct instead of one — and this project has already paid the
 * cost, twice, of an RLS pattern not being applied consistently
 * everywhere it needed to be (see migrations 009-011's history). One
 * table pair, one RLS pattern, extended (not duplicated) when the
 * internal half is built.
 *
 * THE ANONYMOUS-TO-IDENTIFIED TRANSITION (the specific behavior
 * requested: a visitor chooses whether to identify, and is nudged toward
 * it without being forced): a consumer conversation starts with
 * counterparty_id NULL and a visitor_token — an opaque, server-issued
 * uuid the visitor's browser holds (see routes/conversations.ts for how
 * it's issued and checked; there is no session/cookie mechanism in this
 * codebase prior to this migration, so this is a new, narrow one, scoped
 * to exactly this feature). Identifying later means the conversation
 * gets counterparty_id set (matched or created by email) — a one-way
 * upgrade. The row's own presence of a non-null counterparty_id IS the
 * "did they identify" signal; there's no separate boolean to keep in
 * sync with it.
 *
 * ACCESS MODEL — genuinely different from everything else in this
 * schema, and worth being explicit about rather than force-fitting: a
 * visitor has no JWT, so app_public isn't the right role either (that
 * role only ever proved "is this material published," a business-wide
 * fact — this needs "does the presented token match THIS ONE row," a
 * per-row secret-possession check, which is a different shape of
 * authorization than anything RLS-by-session-variable in this project
 * has done so far). The visitor_token check happens at the APPLICATION
 * layer in routes/conversations.ts (the query includes
 * "WHERE visitor_token = $1", not RLS), because RLS session variables
 * are inherently role/connection-scoped and this needs to be
 * per-request, per-token, checked against arbitrary tokens a stateless
 * public connection pool has no way to pre-declare. app_public IS still
 * used for the DB role (SELECT/INSERT only, no UPDATE/DELETE — a visitor
 * can post messages and read their own thread, never edit or delete
 * history), but the actual "is this YOUR conversation" boundary is a
 * WHERE clause, not a policy. This is the one deliberate exception to
 * "RLS enforces every boundary" in this codebase, and it's deliberate
 * FOR A REASON specific to this feature's shape, not a shortcut.
 *
 * The business side (owner/partner/worker reading and replying to
 * consumer conversations) DOES go through the normal RLS pattern —
 * is_business_visible_to_caller(), same as every other business-scoped
 * table — because that side DOES have a real JWT with real session
 * variables to check against.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE conversations (
      id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      kind                text NOT NULL CHECK (kind IN ('consumer', 'internal')),
      counterparty_id     uuid NULL REFERENCES counterparties(id) ON DELETE SET NULL,
      visitor_token       uuid NULL,
      visitor_display_name text NULL,
      subject             text NULL,
      created_at          timestamptz NOT NULL DEFAULT now(),
      last_message_at     timestamptz NOT NULL DEFAULT now(),
      -- A consumer conversation always carries a visitor_token (even
      -- after identifying — the token remains valid so the same browser
      -- keeps access without needing to re-identify every visit).
      -- An internal conversation never has one; there's no anonymous
      -- party to hold it. This CHECK exists now, even though 'internal'
      -- has no routes yet, so the invariant can never be violated by
      -- whatever eventually creates internal conversations either.
      CONSTRAINT consumer_has_token_internal_does_not CHECK (
        (kind = 'consumer' AND visitor_token IS NOT NULL) OR
        (kind = 'internal' AND visitor_token IS NULL)
      )
    );
  `);
  pgm.sql(`CREATE INDEX idx_conversations_business_id ON conversations(business_id);`);
  pgm.sql(`CREATE INDEX idx_conversations_counterparty_id ON conversations(counterparty_id);`);
  // The lookup routes/conversations.ts actually runs on every
  // authenticated visitor request: "find my conversation for this
  // business given my token." Unique per business — the same token
  // could theoretically start a separate thread with a different
  // business without collision.
  pgm.sql(
    `CREATE UNIQUE INDEX idx_conversations_business_visitor_token ON conversations(business_id, visitor_token) WHERE visitor_token IS NOT NULL;`,
  );
  // Business-side inbox sort: "this business's conversations, most
  // recently active first."
  pgm.sql(`CREATE INDEX idx_conversations_business_last_message ON conversations(business_id, last_message_at DESC);`);

  pgm.sql(`
    CREATE TABLE messages (
      id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id   uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_type       text NOT NULL CHECK (sender_type IN ('visitor', 'person')),
      sender_person_id  uuid NULL REFERENCES people(id) ON DELETE SET NULL,
      body              text NOT NULL CHECK (length(body) > 0 AND length(body) <= 8000),
      created_at        timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT sender_type_matches_person_id CHECK (
        (sender_type = 'visitor' AND sender_person_id IS NULL) OR
        (sender_type = 'person' AND sender_person_id IS NOT NULL)
      )
    );
  `);
  pgm.sql(`CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);`);
  pgm.sql(`CREATE INDEX idx_messages_sender_person_id ON messages(sender_person_id);`);
  // The one query every thread view runs: "every message in this
  // conversation, oldest first."
  pgm.sql(`CREATE INDEX idx_messages_conversation_created ON messages(conversation_id, created_at ASC);`);

  // --- Grants and RLS ----------------------------------------------
  // Business side: normal tenant-scoped roles, normal pattern.
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON conversations TO app_owner_partner, app_worker;`);
  pgm.sql(`GRANT SELECT, INSERT ON messages TO app_owner_partner, app_worker;`);
  // No DELETE grant on either table for owner/partner/worker — deleting
  // conversation history isn't exposed by this feature (same "don't
  // mutate history" instinct as ledger_entries/allocation_rules, applied
  // here because a business shouldn't be able to unilaterally erase a
  // customer's side of a conversation, not because of a financial
  // invariant this time).

  pgm.sql(`ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE conversations FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE messages ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE messages FORCE ROW LEVEL SECURITY;`);

  pgm.sql(`
    CREATE POLICY tenant_isolation ON conversations
      FOR ALL
      TO app_owner_partner, app_worker
      USING (is_business_visible_to_caller(business_id));
  `);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON messages
      FOR ALL
      TO app_owner_partner, app_worker
      USING (
        EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.id = messages.conversation_id
            AND is_business_visible_to_caller(c.business_id)
        )
      );
  `);

  // Visitor side: app_public gets SELECT + INSERT only (read their
  // thread, post new messages — never UPDATE/DELETE, matching the
  // "history isn't mutable by anyone" stance above). No RLS policy is
  // created for app_public here — see the file-level comment on why the
  // per-visitor boundary is an application-layer WHERE clause, not RLS.
  // Grants alone are NOT sufficient to make this safe: without a policy,
  // FORCE ROW LEVEL SECURITY still applies, meaning app_public would see
  // ZERO rows from any plain SELECT (correct — it should never be able
  // to browse conversations at large), and can only ever reach a
  // specific row by including the exact conversation_id AND
  // visitor_token in its WHERE clause, which the RLS policy below
  // enforces regardless of what the application code's WHERE clause
  // says. This is NOT "no protection" — it's RLS enforcing "you may
  // never see a row you don't already know the token for," with
  // "matches a specific token" being what routes/conversations.ts's own
  // WHERE clause narrows further to "matches THIS request's token."
  pgm.sql(`GRANT SELECT, INSERT ON conversations TO app_public;`);
  pgm.sql(`GRANT SELECT, INSERT ON messages TO app_public;`);

  pgm.sql(`
    CREATE POLICY visitor_token_access ON conversations
      FOR SELECT
      TO app_public
      USING (
        kind = 'consumer'
        AND visitor_token = current_setting('app.visitor_token', true)::uuid
      );
  `);
  // INSERT (starting a new conversation) has no matching row yet to
  // check a token against — WITH CHECK governs what a new row is allowed
  // to look like, not what existing rows are visible. A visitor can
  // insert a consumer-kind conversation with any visitor_token — that's
  // fine, since it's THEIR token they're choosing for a NEW thread, not
  // reading someone else's.
  pgm.sql(`
    CREATE POLICY visitor_token_insert ON conversations
      FOR INSERT
      TO app_public
      WITH CHECK (kind = 'consumer');
  `);

  pgm.sql(`
    CREATE POLICY visitor_token_access ON messages
      FOR SELECT
      TO app_public
      USING (
        EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.id = messages.conversation_id
            AND c.kind = 'consumer'
            AND c.visitor_token = current_setting('app.visitor_token', true)::uuid
        )
      );
  `);
  pgm.sql(`
    CREATE POLICY visitor_token_insert ON messages
      FOR INSERT
      TO app_public
      WITH CHECK (
        sender_type = 'visitor'
        AND EXISTS (
          SELECT 1 FROM conversations c
          WHERE c.id = messages.conversation_id
            AND c.kind = 'consumer'
            AND c.visitor_token = current_setting('app.visitor_token', true)::uuid
        )
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS visitor_token_insert ON messages;`);
  pgm.sql(`DROP POLICY IF EXISTS visitor_token_access ON messages;`);
  pgm.sql(`DROP POLICY IF EXISTS visitor_token_insert ON conversations;`);
  pgm.sql(`DROP POLICY IF EXISTS visitor_token_access ON conversations;`);
  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON messages;`);
  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON conversations;`);

  pgm.sql(`REVOKE ALL ON messages FROM app_owner_partner, app_worker, app_public;`);
  pgm.sql(`REVOKE ALL ON conversations FROM app_owner_partner, app_worker, app_public;`);

  pgm.sql(`DROP TABLE IF EXISTS messages;`);
  pgm.sql(`DROP TABLE IF EXISTS conversations;`);
};
