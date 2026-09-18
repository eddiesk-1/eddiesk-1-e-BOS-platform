/**
 * 014_grant_conversation_update
 *
 * THE ACTUAL ROOT CAUSE of a debugging session that took many turns to
 * resolve. Worth documenting in full, because the shape of how this hid
 * is a real lesson for whoever adds the next feature to this table pair.
 *
 * routes/conversations.ts's POST /conversations (and POST
 * /conversations/:id/messages) does three writes per request:
 *   1. INSERT INTO conversations (...)
 *   2. INSERT INTO messages (...)
 *   3. UPDATE conversations SET last_message_at = now() WHERE id = $1
 *
 * Migration 012 granted app_public SELECT + INSERT on both tables —
 * UPDATE was never granted on EITHER table, because at the time that
 * migration was written, "a visitor can post messages and read their own
 * thread, never edit or delete history" (see 012's own comment) was true
 * for messages, and was WRONGLY assumed to also cover conversations,
 * which the route logic itself needs to UPDATE (bumping
 * last_message_at) as an ordinary, expected part of every single write.
 * That's a real, simple gap between the migration's grants and what the
 * route code actually does — not a subtle bug, just one that hid
 * unusually well:
 *
 * The error Postgres raised was "permission denied for table
 * conversations" (SQLSTATE 42501) — which is also exactly the error a
 * missing INSERT grant would produce, and INSERT was the very first
 * write in the sequence, the most natural place to suspect first. Every
 * manual reproduction attempt during debugging (multiple standalone
 * Node scripts, dozens of direct psql sessions) tested ONLY the INSERT
 * in isolation — never the full three-statement sequence a real request
 * performs — and every one of those isolated tests succeeded, because
 * the INSERT alone was never the problem. The actual failing statement
 * (the UPDATE) was never reproduced in isolation until pool-level query
 * logging showed the literal sequence of queries Postgres was receiving,
 * in order, from the real running server — at which point it became
 * visible that the UPDATE was the last query attempted before the
 * ROLLBACK, not the INSERT.
 *
 * The lesson: when a table needs "read your own row, write new rows,"
 * check what the ACTUAL ROUTE CODE does end to end, not just what the
 * feature's stated access model implies — "never edit history" was true
 * for message CONTENT, but last_message_at is bookkeeping metadata the
 * feature updates on every single write, which is a different thing
 * that needed its own explicit grant.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`GRANT UPDATE ON conversations TO app_public;`);

  // The grant alone is not sufficient — conversations only had FOR
  // SELECT and FOR INSERT policies for app_public (migration 012); with
  // no FOR UPDATE policy at all, FORCE ROW LEVEL SECURITY means zero
  // rows would be updatable regardless of the grant. This policy uses
  // the same visitor_token boundary as visitor_token_access (a visitor
  // may only touch their own conversation), and additionally restricts
  // WHICH COLUMNS can change via WITH CHECK — the route only ever needs
  // to bump last_message_at, so this policy doesn't open the door to a
  // visitor rewriting their own subject, display name, or (especially)
  // counterparty_id directly. WITH CHECK re-verifies visitor_token on
  // the post-update row too, not just USING on the pre-update row — an
  // UPDATE that tried to change kind or visitor_token itself would fail
  // WITH CHECK even if USING allowed the row to be found in the first
  // place.
  pgm.sql(`
    CREATE POLICY visitor_token_update ON conversations
      FOR UPDATE
      TO app_public
      USING (
        kind = 'consumer'
        AND visitor_token = current_setting('app.visitor_token', true)::uuid
      )
      WITH CHECK (
        kind = 'consumer'
        AND visitor_token = current_setting('app.visitor_token', true)::uuid
      );
  `);
};

exports.down = (pgm) => {
  pgm.sql(`DROP POLICY IF EXISTS visitor_token_update ON conversations;`);
  pgm.sql(`REVOKE UPDATE ON conversations FROM app_public;`);
};
