/**
 * 013_conversation_identify
 *
 * The "enticed but not required to identify" flow needs one write
 * app_public cannot safely be granted directly: matching-or-creating a
 * counterparties row. Granting app_public INSERT on counterparties
 * outright would let any anonymous request create arbitrary counterparty
 * records for any business, with no connection to a real conversation at
 * all — a much bigger surface than "let a visitor who already owns a
 * specific conversation attach their name and email to it."
 *
 * The fix is the same SECURITY DEFINER pattern used twice already in
 * this schema (is_business_visible_to_caller in migration 004,
 * is_material_published/is_order_a_published_sale in migration 010): a
 * function that does the privileged operation internally, callable by a
 * restricted role, but the function itself re-verifies the caller's
 * authority to do it rather than trusting RLS already checked.
 *
 * identify_conversation(conversation_id, visitor_token, name, email):
 *   1. Re-checks that visitor_token actually matches the given
 *      conversation_id — SECURITY DEFINER functions run with elevated
 *      privilege specifically so RLS on the tables they touch doesn't
 *      apply to their internal queries, which means this function is
 *      the one place actually responsible for re-verifying ownership,
 *      not something delegated to RLS.
 *   2. Finds an existing counterparties row for this business by email,
 *      or creates one, tagged with the 'lead' role (a landing-page
 *      inquiry is a lead, not yet a customer/supplier/buyer).
 *   3. Sets conversations.counterparty_id to that row's id.
 *   4. Returns the counterparty id, or NULL if the token didn't match
 *      (routes/conversations.ts turns NULL into a 403 — a caller trying
 *      to identify isn't doing anything wrong by trying, they just don't
 *      own this conversation, so this is a return value, not a raised
 *      exception).
 *
 * This does NOT let app_public read or list counterparties generally —
 * EXECUTE on this one function is the entire capability granted.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION identify_conversation(
      target_conversation_id uuid,
      presented_visitor_token uuid,
      visitor_name text,
      visitor_email text
    )
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      target_business_id uuid;
      resolved_counterparty_id uuid;
    BEGIN
      SELECT business_id INTO target_business_id
      FROM conversations
      WHERE id = target_conversation_id
        AND kind = 'consumer'
        AND visitor_token = presented_visitor_token;

      IF target_business_id IS NULL THEN
        RETURN NULL;
      END IF;

      IF visitor_name IS NULL OR length(trim(visitor_name)) = 0 THEN
        RAISE EXCEPTION 'visitor_name is required';
      END IF;
      IF visitor_email IS NULL OR visitor_email !~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$' THEN
        RAISE EXCEPTION 'visitor_email must be a valid email address';
      END IF;

      SELECT id INTO resolved_counterparty_id
      FROM counterparties
      WHERE business_id = target_business_id
        AND contact->>'email' = visitor_email
      LIMIT 1;

      IF resolved_counterparty_id IS NULL THEN
        INSERT INTO counterparties (business_id, name, roles, contact)
        VALUES (
          target_business_id,
          visitor_name,
          ARRAY['lead'],
          jsonb_build_object('email', visitor_email)
        )
        RETURNING id INTO resolved_counterparty_id;
      END IF;

      UPDATE conversations
      SET counterparty_id = resolved_counterparty_id,
          visitor_display_name = COALESCE(visitor_display_name, visitor_name)
      WHERE id = target_conversation_id;

      RETURN resolved_counterparty_id;
    END;
    $$;
  `);
  pgm.sql(`GRANT EXECUTE ON FUNCTION identify_conversation(uuid, uuid, text, text) TO app_public;`);
};

exports.down = (pgm) => {
  pgm.sql(
    `REVOKE EXECUTE ON FUNCTION identify_conversation(uuid, uuid, text, text) FROM app_public;`,
  );
  pgm.sql(`DROP FUNCTION IF EXISTS identify_conversation(uuid, uuid, text, text);`);
};
