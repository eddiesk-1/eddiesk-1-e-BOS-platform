import type { FastifyBaseLogger } from 'fastify';
import { withVisitorAccess } from './publicDb.js';
import { handoffWaitingMessage, sendEmail } from './email.js';
import type { HandoffReason } from './escalation.js';

export type RecordedReason = HandoffReason | 'visitor_token_redeemed';

interface HandoffResult {
  changed: boolean;
  reason?: string;
  business_name?: string;
  recipients?: Array<{ person_id: string; name: string; email: string }>;
}

/**
 * Marks a conversation as needing a human, records why, creates the
 * in-app notifications for eligible staff (all inside chat_request_handoff,
 * migration 020) and then emails them.
 *
 * Idempotent: the database function notifies a conversation at most once,
 * so calling this from two places (e.g. a token redemption and an AI
 * escalation in quick succession) cannot double-notify.
 *
 * Email is best-effort and happens AFTER the database commit. If it fails
 * the in-app notification and the inbox highlight still exist — the
 * handoff itself never fails because of a mail problem.
 */
export async function requestHandoff(
  conversationId: string,
  visitorToken: string,
  reason: RecordedReason,
  log: FastifyBaseLogger,
): Promise<{ changed: boolean; emailed: number }> {
  const result = await withVisitorAccess(visitorToken, async (client) => {
    const r = await client.query<{ r: HandoffResult }>(
      'SELECT chat_request_handoff($1, $2, $3) AS r',
      [conversationId, visitorToken, reason],
    );
    return r.rows[0].r;
  });

  if (!result.changed) return { changed: false, emailed: 0 };

  const base = (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  const link = `${base || ''}/e-bos-backoffice.html#inbox`;
  let emailed = 0;
  for (const rcpt of result.recipients ?? []) {
    const sent = await sendEmail(
      handoffWaitingMessage(rcpt.email, rcpt.name, result.business_name ?? 'your business', reason, link),
    );
    if (sent.sent) emailed++;
    else log.warn({ provider: sent.provider }, 'handoff email not sent');
  }
  log.info({ conversationId, reason, recipients: result.recipients?.length ?? 0, emailed }, 'handoff requested');
  return { changed: true, emailed };
}
