/**
 * 017_ai_sender_type
 *
 * Adds 'ai' as a third messages.sender_type, alongside the existing
 * 'visitor' and 'person'. An AI-authored reply is neither a visitor
 * message nor a real staff member's — collapsing it into 'visitor'
 * would be dishonest bookkeeping (the AI isn't the consumer), and
 * collapsing it into 'person' with sender_person_id NULL would break
 * the existing sender_type_matches_person_id invariant (which already
 * requires 'person' rows to always have a real sender_person_id) and
 * would misrepresent an automated reply as a human one in the
 * conversation's own history — exactly the kind of muddying "very
 * honest about being an AI" is supposed to prevent, and that
 * requirement should hold in the DATA, not just in what the model says
 * out loud.
 *
 * sender_type_matches_person_id is rebuilt with a third branch: 'ai'
 * rows also require sender_person_id IS NULL, same as 'visitor'.
 *
 * is_ai_disclosure boolean, default false: a STRUCTURAL marker — set by
 * application code (routes/ai.ts), never by the model's own output —
 * on the first AI message in a conversation. This exists because a
 * system-prompt instruction to "be honest about being an AI" is real
 * but not bulletproof: a sufficiently long or adversarial conversation
 * could in principle erode a purely prompted behavior. This column is
 * the backstop — the disclosure isn't something the model chose to
 * say, it's a fact the code attaches to the message that a frontend can
 * check and render unconditionally (e.g. always showing an "AI" badge
 * on that message, or forcing the disclosure text into the UI
 * regardless of what the message body itself contains). This does NOT
 * replace prompting the model to be honest — see the system prompt in
 * routes/ai.ts — it's an additional, code-enforced guarantee on top of
 * it, not instead of it.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`ALTER TABLE messages DROP CONSTRAINT messages_sender_type_check;`);
  pgm.sql(
    `ALTER TABLE messages ADD CONSTRAINT messages_sender_type_check CHECK (sender_type IN ('visitor', 'person', 'ai'));`,
  );

  pgm.sql(`ALTER TABLE messages DROP CONSTRAINT sender_type_matches_person_id;`);
  pgm.sql(`
    ALTER TABLE messages ADD CONSTRAINT sender_type_matches_person_id CHECK (
      (sender_type = 'visitor' AND sender_person_id IS NULL) OR
      (sender_type = 'ai' AND sender_person_id IS NULL) OR
      (sender_type = 'person' AND sender_person_id IS NOT NULL)
    );
  `);

  pgm.sql(`ALTER TABLE messages ADD COLUMN is_ai_disclosure boolean NOT NULL DEFAULT false;`);
};

exports.down = (pgm) => {
  pgm.sql(`ALTER TABLE messages DROP COLUMN IF EXISTS is_ai_disclosure;`);

  pgm.sql(`ALTER TABLE messages DROP CONSTRAINT sender_type_matches_person_id;`);
  pgm.sql(`
    ALTER TABLE messages ADD CONSTRAINT sender_type_matches_person_id CHECK (
      (sender_type = 'visitor' AND sender_person_id IS NULL) OR
      (sender_type = 'person' AND sender_person_id IS NOT NULL)
    );
  `);

  pgm.sql(`ALTER TABLE messages DROP CONSTRAINT messages_sender_type_check;`);
  pgm.sql(
    `ALTER TABLE messages ADD CONSTRAINT messages_sender_type_check CHECK (sender_type IN ('visitor', 'person'));`,
  );
};
