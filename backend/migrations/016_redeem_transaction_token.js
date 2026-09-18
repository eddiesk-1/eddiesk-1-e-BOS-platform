/**
 * 016_redeem_transaction_token
 *
 * transaction_tokens has NO grant for app_public at all (migration
 * 015) — a token's value IS the security model (possession = proof), so
 * a visitor can never list, browse, or query tokens directly, only ever
 * present the one exact token they already hold. Redemption needs to:
 *   1. Look up the token
 *   2. Verify it's unredeemed
 *   3. Verify its counterparty_id matches the CALLING conversation's own
 *      counterparty_id (so a token can't be used to escalate a
 *      DIFFERENT conversation than the one belonging to the same
 *      identified consumer — otherwise a leaked/guessed token could
 *      hijack any thread, not just the transaction it was actually
 *      issued for)
 *   4. Mark it redeemed
 *   5. Transition the conversation to handled_by = 'awaiting_human'
 *
 * All five steps happen inside ONE SECURITY DEFINER function,
 * redeem_transaction_token(), exactly mirroring identify_conversation()'s
 * pattern (migration 013) and for the identical reason: app_public gets
 * EXECUTE on this one function, nothing broader, and the function
 * re-verifies the caller's ownership of the conversation itself (via
 * visitor_token) rather than trusting that RLS on conversations already
 * checked it — the same "SECURITY DEFINER functions must re-verify
 * their own caller's authority, since RLS on the tables THEY touch
 * doesn't apply to their internal queries" reasoning migration 013's
 * comment already lays out in full.
 *
 * Returns a small JSON result rather than a single scalar (unlike
 * identify_conversation's plain uuid-or-null): the caller needs to know
 * WHY a redemption failed (wrong token, wrong conversation, already
 * redeemed, not yet identified) to give a useful error, not just a bare
 * 403. { success: boolean, reason: text | null }.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
    CREATE OR REPLACE FUNCTION redeem_transaction_token(
      target_conversation_id uuid,
      presented_visitor_token uuid,
      presented_transaction_token uuid
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      conv_counterparty_id uuid;
      token_row transaction_tokens%ROWTYPE;
    BEGIN
      -- Re-verify conversation ownership via visitor_token, same as
      -- identify_conversation — never trust the caller already passed
      -- RLS to reach this point.
      SELECT counterparty_id INTO conv_counterparty_id
      FROM conversations
      WHERE id = target_conversation_id
        AND kind = 'consumer'
        AND visitor_token = presented_visitor_token;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'conversation_not_found');
      END IF;

      IF conv_counterparty_id IS NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'not_identified');
      END IF;

      SELECT * INTO token_row
      FROM transaction_tokens
      WHERE token = presented_transaction_token
      FOR UPDATE;

      IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'reason', 'token_not_found');
      END IF;

      IF token_row.redeemed_at IS NOT NULL THEN
        RETURN jsonb_build_object('success', false, 'reason', 'token_already_redeemed');
      END IF;

      IF token_row.counterparty_id != conv_counterparty_id THEN
        -- The token is real and unredeemed, but belongs to a DIFFERENT
        -- consumer than the one who identified into this conversation.
        -- Same generic-failure discipline as auth.ts's login route (see
        -- that file's own comment on not distinguishing failure
        -- reasons that would help an attacker) — but here the caller
        -- genuinely needs SOME signal to know "that's not your token"
        -- vs "that token doesn't exist," so this is deliberately its
        -- own reason rather than folded into token_not_found. The risk
        -- profile is different from login: guessing a valid token
        -- requires guessing a real uuid tied to a real transaction,
        -- not a password from a known-limited space, so this
        -- granularity doesn't meaningfully aid an attacker the way
        -- distinguishing "wrong password" from "no such user" would.
        RETURN jsonb_build_object('success', false, 'reason', 'token_belongs_to_different_consumer');
      END IF;

      UPDATE transaction_tokens
      SET redeemed_at = now(),
          redeemed_by_conversation_id = target_conversation_id
      WHERE id = token_row.id;

      UPDATE conversations
      SET handled_by = 'awaiting_human'
      WHERE id = target_conversation_id;

      RETURN jsonb_build_object('success', true, 'reason', null);
    END;
    $$;
  `);
  pgm.sql(
    `GRANT EXECUTE ON FUNCTION redeem_transaction_token(uuid, uuid, uuid) TO app_public;`,
  );
};

exports.down = (pgm) => {
  pgm.sql(
    `REVOKE EXECUTE ON FUNCTION redeem_transaction_token(uuid, uuid, uuid) FROM app_public;`,
  );
  pgm.sql(`DROP FUNCTION IF EXISTS redeem_transaction_token(uuid, uuid, uuid);`);
};
