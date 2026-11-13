/**
 * 020_chat_ai_and_notifications
 *
 * Fixes and completes the visitor-facing AI chat, and makes human handoff
 * actually reach a human.
 *
 * WHY THE AI REPLY NEEDS SECURITY DEFINER FUNCTIONS
 * -------------------------------------------------
 * POST /conversations/:id/ai-reply runs on the public pool as app_public.
 * Reading the code against migrations 004-018 shows two things app_public
 * has never been allowed to do:
 *   1. SELECT from knowledge_chunks (only app_owner_partner / app_worker
 *      are granted it, and the policy is tenant-only), and
 *   2. INSERT a message with sender_type = 'ai' (the only app_public
 *      insert policy on messages requires sender_type = 'visitor').
 * So as shipped, the AI reply path could not read guide material or save
 * its own answer. Rather than widen app_public's table grants (which would
 * expose every business's guide text and let any visitor forge staff/AI
 * messages), this migration follows the pattern of migrations 013 and 016:
 * narrow functions that re-verify the visitor token themselves, and
 * EXECUTE on those functions is the whole capability granted.
 *
 * WHAT IS ADDED
 *   conversations.handoff_reason / handoff_at / handoff_notified_at
 *   business_ai_settings   per-business retrieval depth + auto-escalation
 *   notifications          in-app inbox for staff (one row per recipient)
 *   GIN full-text index on knowledge_chunks.content
 *   chat_ai_context()      one round trip: history, catalog, ranked guide
 *                          chunks, region labels, settings
 *   chat_post_ai_message() saves the AI's reply (token-verified)
 *   chat_request_handoff() marks a conversation awaiting_human, records
 *                          why, notifies eligible staff (idempotent)
 *   chat_set_region()      records the inferred region (only if unset)
 *
 * Like 013/016, the chat_* functions read FORCE-RLS tables as the function
 * owner. That requires the migration user to be a superuser or BYPASSRLS —
 * see diag_owner_bypasses_rls() in migration 019 and DEPLOY.md.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ---- conversations: why and when a handoff happened -----------------
  pgm.sql(`
    ALTER TABLE conversations
      ADD COLUMN handoff_reason text NULL
        CHECK (handoff_reason IS NULL OR handoff_reason IN
          ('visitor_token_redeemed', 'pricing', 'complaint', 'low_confidence', 'visitor_requested'));
  `);
  pgm.sql(`ALTER TABLE conversations ADD COLUMN handoff_at timestamptz NULL;`);
  pgm.sql(`ALTER TABLE conversations ADD COLUMN handoff_notified_at timestamptz NULL;`);

  // ---- full-text relevance over guide chunks --------------------------
  pgm.sql(`
    CREATE INDEX idx_knowledge_chunks_fts
      ON knowledge_chunks USING gin (to_tsvector('english', content));
  `);

  // ---- per-business AI settings ---------------------------------------
  pgm.sql(`
    CREATE TABLE business_ai_settings (
      business_id      uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
      retrieval_depth  integer NOT NULL DEFAULT 8 CHECK (retrieval_depth BETWEEN 1 AND 20),
      auto_escalation  boolean NOT NULL DEFAULT true,
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON business_ai_settings TO app_owner_partner;`);
  pgm.sql(`GRANT SELECT ON business_ai_settings TO app_worker;`);
  pgm.sql(`ALTER TABLE business_ai_settings ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE business_ai_settings FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON business_ai_settings
      TO app_owner_partner, app_worker
      USING (is_business_visible_to_caller(business_ai_settings.business_id));
  `);

  // ---- notifications ---------------------------------------------------
  // Written only by SECURITY DEFINER functions (RLS enabled but NOT forced,
  // so the function owner can insert). Read/updated by the addressee only.
  pgm.sql(`
    CREATE TABLE notifications (
      id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id      uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
      person_id        uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      kind             text NOT NULL CHECK (kind IN ('handoff_waiting', 'payment_received')),
      conversation_id  uuid NULL REFERENCES conversations(id) ON DELETE CASCADE,
      order_id         uuid NULL REFERENCES orders(id) ON DELETE CASCADE,
      title            text NOT NULL,
      body             text NULL,
      created_at       timestamptz NOT NULL DEFAULT now(),
      read_at          timestamptz NULL
    );
  `);
  pgm.sql(`CREATE INDEX idx_notifications_person_unread ON notifications(person_id, read_at, created_at DESC);`);
  pgm.sql(`CREATE INDEX idx_notifications_business ON notifications(business_id);`);
  pgm.sql(`CREATE INDEX idx_notifications_conversation ON notifications(conversation_id);`);
  pgm.sql(`GRANT SELECT, UPDATE ON notifications TO app_owner_partner, app_worker;`);
  pgm.sql(`ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`
    CREATE POLICY addressee_only ON notifications
      TO app_owner_partner, app_worker
      USING (person_id = current_setting('app.person_id', true)::uuid);
  `);

  // ---- chat_ai_context -------------------------------------------------
  // p_tsquery is built by the application from the visitor's last message:
  // lowercase alphanumeric terms joined with ' | ' (see lib/guideSearch.ts).
  // It is still wrapped in an exception handler so a malformed query can
  // only ever degrade to the old "first N chunks" behaviour.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION chat_ai_context(
      p_conversation_id uuid,
      p_visitor_token   uuid,
      p_tsquery         text
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_business_id  uuid;
      v_hc_id        uuid;
      v_handled_by   text;
      v_region       text;
      v_name         text;
      v_depth        integer := 8;
      v_auto         boolean := true;
      v_history      jsonb;
      v_ai_count     integer;
      v_items        jsonb;
      v_chunks       jsonb := '[]'::jsonb;
      v_mode         text := 'fts';
      v_labels       jsonb;
    BEGIN
      SELECT c.business_id, c.handled_by, c.consumer_region_label
        INTO v_business_id, v_handled_by, v_region
      FROM conversations c
      WHERE c.id = p_conversation_id AND c.kind = 'consumer' AND c.visitor_token = p_visitor_token;

      IF v_business_id IS NULL THEN
        RETURN NULL;
      END IF;

      SELECT b.name, b.holding_company_id INTO v_name, v_hc_id FROM businesses b WHERE b.id = v_business_id;

      SELECT s.retrieval_depth, s.auto_escalation INTO v_depth, v_auto
      FROM business_ai_settings s WHERE s.business_id = v_business_id;
      v_depth := LEAST(GREATEST(COALESCE(v_depth, 8), 1), 20);
      v_auto  := COALESCE(v_auto, true);

      SELECT COALESCE(jsonb_agg(jsonb_build_object('sender_type', h.sender_type, 'body', h.body)
                                ORDER BY h.created_at ASC), '[]'::jsonb)
        INTO v_history
      FROM (
        SELECT m.sender_type, m.body, m.created_at
        FROM messages m WHERE m.conversation_id = p_conversation_id
        ORDER BY m.created_at DESC LIMIT 30
      ) h;

      SELECT COUNT(*) INTO v_ai_count
      FROM messages m WHERE m.conversation_id = p_conversation_id AND m.sender_type = 'ai';

      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'name', i.name,
               'category', i.catalog_meta->>'category',
               'description', i.catalog_meta->>'description',
               'price', i.catalog_meta->>'price',
               'currency', i.catalog_meta->>'currency') ORDER BY i.name), '[]'::jsonb)
        INTO v_items
      FROM (
        SELECT m.name, m.catalog_meta FROM materials m
        WHERE m.business_id = v_business_id AND m.catalog_meta IS NOT NULL
        ORDER BY m.name LIMIT 60
      ) i;

      IF p_tsquery IS NOT NULL AND length(btrim(p_tsquery)) > 0 THEN
        BEGIN
          SELECT COALESCE(jsonb_agg(r.content ORDER BY r.score DESC), '[]'::jsonb) INTO v_chunks
          FROM (
            SELECT k.content, ts_rank(to_tsvector('english', k.content), q.tsq) AS score
            FROM knowledge_chunks k, to_tsquery('english', p_tsquery) AS q(tsq)
            WHERE k.business_id = v_business_id
              AND to_tsvector('english', k.content) @@ q.tsq
            ORDER BY score DESC
            LIMIT v_depth
          ) r;
        EXCEPTION WHEN OTHERS THEN
          v_chunks := '[]'::jsonb;
        END;
      END IF;

      IF jsonb_array_length(v_chunks) = 0 THEN
        v_mode := 'fallback';
        SELECT COALESCE(jsonb_agg(r.content ORDER BY r.id ASC), '[]'::jsonb) INTO v_chunks
        FROM (
          SELECT k.content, k.id FROM knowledge_chunks k
          WHERE k.business_id = v_business_id
          ORDER BY k.id ASC LIMIT v_depth
        ) r;
      END IF;

      SELECT COALESCE(jsonb_agg(DISTINCT tp.region_label), '[]'::jsonb) INTO v_labels
      FROM transaction_paths tp
      JOIN people p ON p.id = tp.person_id
      WHERE p.holding_company_id = v_hc_id AND tp.region_label IS NOT NULL;

      RETURN jsonb_build_object(
        'business_id',     v_business_id,
        'business_name',   v_name,
        'handled_by',      v_handled_by,
        'region',          v_region,
        'region_labels',   v_labels,
        'prior_ai_count',  v_ai_count,
        'auto_escalation', v_auto,
        'retrieval_depth', v_depth,
        'retrieval_mode',  v_mode,
        'history',         v_history,
        'items',           v_items,
        'chunks',          v_chunks
      );
    END;
    $$;
  `);

  // ---- chat_post_ai_message -------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION chat_post_ai_message(
      p_conversation_id uuid,
      p_visitor_token   uuid,
      p_body            text,
      p_is_disclosure   boolean,
      p_allow_awaiting  boolean
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_handled_by text;
      v_row        messages%ROWTYPE;
    BEGIN
      SELECT c.handled_by INTO v_handled_by
      FROM conversations c
      WHERE c.id = p_conversation_id AND c.kind = 'consumer' AND c.visitor_token = p_visitor_token;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'conversation_not_found');
      END IF;
      -- A human may have taken over while the model was thinking. The one
      -- exception: the short "I've asked a team member" notice, which is
      -- posted right AFTER the handoff (p_allow_awaiting) so the visitor
      -- is only ever told about a handoff that really happened.
      IF v_handled_by <> 'ai' AND NOT (COALESCE(p_allow_awaiting, false) AND v_handled_by = 'awaiting_human') THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'not_handled_by_ai');
      END IF;
      IF p_body IS NULL OR length(btrim(p_body)) = 0 THEN
        RETURN jsonb_build_object('ok', false, 'reason', 'empty_body');
      END IF;

      INSERT INTO messages (conversation_id, sender_type, body, is_ai_disclosure)
      VALUES (p_conversation_id, 'ai', left(p_body, 8000), COALESCE(p_is_disclosure, false))
      RETURNING * INTO v_row;

      UPDATE conversations SET last_message_at = now() WHERE id = p_conversation_id;

      RETURN jsonb_build_object(
        'ok', true,
        'id', v_row.id,
        'conversation_id', v_row.conversation_id,
        'sender_type', v_row.sender_type,
        'sender_person_id', v_row.sender_person_id,
        'body', v_row.body,
        'created_at', v_row.created_at,
        'is_ai_disclosure', v_row.is_ai_disclosure
      );
    END;
    $$;
  `);

  // ---- chat_request_handoff -------------------------------------------
  // One function for both ways a conversation reaches a human:
  //   * the AI/server decides to escalate (handled_by is still 'ai'), or
  //   * the visitor redeemed a transaction token (migration 016 already
  //     set awaiting_human; this call records the reason and notifies).
  // Idempotent: a conversation is notified at most once.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION chat_request_handoff(
      p_conversation_id uuid,
      p_visitor_token   uuid,
      p_reason          text
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_conv        conversations%ROWTYPE;
      v_hc_id       uuid;
      v_biz_name    text;
      v_recipients  jsonb;
    BEGIN
      IF p_reason NOT IN ('visitor_token_redeemed', 'pricing', 'complaint', 'low_confidence', 'visitor_requested') THEN
        RAISE EXCEPTION 'invalid handoff reason';
      END IF;

      SELECT * INTO v_conv FROM conversations c
      WHERE c.id = p_conversation_id AND c.kind = 'consumer' AND c.visitor_token = p_visitor_token
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('changed', false, 'reason', 'conversation_not_found');
      END IF;

      IF v_conv.handled_by = 'ai' THEN
        UPDATE conversations
        SET handled_by = 'awaiting_human', handoff_reason = p_reason, handoff_at = now()
        WHERE id = v_conv.id;
      ELSIF v_conv.handled_by = 'awaiting_human' AND v_conv.handoff_notified_at IS NULL THEN
        UPDATE conversations
        SET handoff_reason = COALESCE(handoff_reason, p_reason), handoff_at = COALESCE(handoff_at, now())
        WHERE id = v_conv.id;
      ELSE
        RETURN jsonb_build_object('changed', false, 'reason', 'already_handed_off');
      END IF;

      SELECT b.holding_company_id, b.name INTO v_hc_id, v_biz_name FROM businesses b WHERE b.id = v_conv.business_id;

      -- Eligible staff: every owner, plus workers whose transaction paths
      -- cover this region (or who handle "anywhere"). Partners are not
      -- routed, matching routing-candidates.
      SELECT COALESCE(jsonb_agg(jsonb_build_object('person_id', r.id, 'name', r.name, 'email', r.email)), '[]'::jsonb)
        INTO v_recipients
      FROM (
        SELECT DISTINCT p.id, p.name, p.email
        FROM people p
        WHERE p.holding_company_id = v_hc_id
          AND p.role IN ('owner', 'worker')
          AND (
            p.role = 'owner'
            OR EXISTS (
              SELECT 1 FROM transaction_paths tp
              WHERE tp.person_id = p.id
                AND (tp.region_label IS NULL
                     OR (v_conv.consumer_region_label IS NOT NULL
                         AND lower(tp.region_label) = lower(v_conv.consumer_region_label)))
            )
          )
      ) r;

      INSERT INTO notifications (business_id, person_id, kind, conversation_id, title, body)
      SELECT v_conv.business_id, (e->>'person_id')::uuid, 'handoff_waiting', v_conv.id,
             'A customer is waiting for a person',
             'Conversation about ' || COALESCE(v_conv.subject, 'your business') || ' at ' || v_biz_name
               || ' needs a human. Reason: ' || p_reason
      FROM jsonb_array_elements(v_recipients) e;

      UPDATE conversations SET handoff_notified_at = now() WHERE id = v_conv.id;

      RETURN jsonb_build_object(
        'changed', true,
        'business_name', v_biz_name,
        'business_id', v_conv.business_id,
        'region', v_conv.consumer_region_label,
        'reason', p_reason,
        'recipients', v_recipients
      );
    END;
    $$;
  `);

  // ---- chat_set_region -------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION chat_set_region(
      p_conversation_id uuid,
      p_visitor_token   uuid,
      p_region          text
    )
    RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_rows integer;
    BEGIN
      IF p_region IS NULL OR length(btrim(p_region)) = 0 OR length(p_region) > 80 THEN
        RETURN false;
      END IF;
      UPDATE conversations
      SET consumer_region_label = btrim(p_region)
      WHERE id = p_conversation_id AND kind = 'consumer' AND visitor_token = p_visitor_token
        AND consumer_region_label IS NULL;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      RETURN v_rows > 0;
    END;
    $$;
  `);

  const publicFns = [
    'chat_ai_context(uuid, uuid, text)',
    'chat_post_ai_message(uuid, uuid, text, boolean, boolean)',
    'chat_request_handoff(uuid, uuid, text)',
    'chat_set_region(uuid, uuid, text)',
  ];
  for (const fn of publicFns) {
    pgm.sql(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
    pgm.sql(`GRANT EXECUTE ON FUNCTION ${fn} TO app_public;`);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS chat_set_region(uuid, uuid, text);`);
  pgm.sql(`DROP FUNCTION IF EXISTS chat_request_handoff(uuid, uuid, text);`);
  pgm.sql(`DROP FUNCTION IF EXISTS chat_post_ai_message(uuid, uuid, text, boolean, boolean);`);
  pgm.sql(`DROP FUNCTION IF EXISTS chat_ai_context(uuid, uuid, text);`);

  pgm.sql(`DROP POLICY IF EXISTS addressee_only ON notifications;`);
  pgm.sql(`REVOKE ALL ON notifications FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS notifications;`);

  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON business_ai_settings;`);
  pgm.sql(`REVOKE ALL ON business_ai_settings FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS business_ai_settings;`);

  pgm.sql(`DROP INDEX IF EXISTS idx_knowledge_chunks_fts;`);

  pgm.sql(`ALTER TABLE conversations DROP COLUMN IF EXISTS handoff_notified_at;`);
  pgm.sql(`ALTER TABLE conversations DROP COLUMN IF EXISTS handoff_at;`);
  pgm.sql(`ALTER TABLE conversations DROP COLUMN IF EXISTS handoff_reason;`);
};
