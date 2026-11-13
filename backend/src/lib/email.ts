/**
 * Transactional email over plain HTTPS APIs (no SMTP library, no new npm
 * dependency). Providers:
 *   resend  https://resend.com   — EMAIL_PROVIDER=resend
 *   brevo   https://www.brevo.com — EMAIL_PROVIDER=brevo
 *   log     prints the message to the server log — development ONLY.
 *           It is refused in production because verification and reset
 *           links are credentials and must never land in logs there.
 *
 * Nothing here has been run against a live provider account; the request
 * shapes follow each provider's published API. Treat the first real send
 * as a test (DEPLOY.md has a checklist).
 */

export type EmailProviderName = 'resend' | 'brevo' | 'log' | 'none';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailConfig {
  provider: EmailProviderName;
  from: string;
  apiKey: string;
}

export function readEmailConfig(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  const requested = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  const isProd = env.NODE_ENV === 'production';
  let provider: EmailProviderName = 'none';
  if (requested === 'resend' || requested === 'brevo') provider = requested;
  else if (requested === 'log' && !isProd) provider = 'log';

  const apiKey = (env.EMAIL_API_KEY ?? '').trim();
  const from = (env.EMAIL_FROM ?? '').trim();

  if ((provider === 'resend' || provider === 'brevo') && (!apiKey || !from)) {
    provider = 'none';
  }
  if (provider === 'log' && !from) {
    return { provider, from: 'e-BOS <no-reply@localhost>', apiKey };
  }
  return { provider, from, apiKey };
}

export function emailEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readEmailConfig(env).provider !== 'none';
}

/** "Name <a@b.c>" or "a@b.c" -> { name, email } */
export function parseFrom(from: string): { name: string | null; email: string } {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^>]+)>\s*$/.exec(from);
  if (m) return { name: m[1] ? m[1].trim() || null : null, email: m[2].trim() };
  return { name: null, email: from.trim() };
}

export interface SendResult {
  sent: boolean;
  provider: EmailProviderName;
  error?: string;
}

type FetchLike = (input: string, init?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export async function sendEmail(
  message: EmailMessage,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<SendResult> {
  const cfg = readEmailConfig(env);
  if (cfg.provider === 'none') {
    return { sent: false, provider: 'none', error: 'email is not configured' };
  }
  if (cfg.provider === 'log') {
    // Development only (readEmailConfig refuses this in production).
    console.log(`[email:log] to=${message.to} subject=${message.subject}\n${message.text}\n`);
    return { sent: true, provider: 'log' };
  }

  try {
    let response;
    if (cfg.provider === 'resend') {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: cfg.from,
          to: [message.to],
          subject: message.subject,
          html: message.html,
          text: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } else {
      const sender = parseFrom(cfg.from);
      response = await fetchImpl('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: sender.name ? { name: sender.name, email: sender.email } : { email: sender.email },
          to: [{ email: message.to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Provider error bodies can echo the recipient; keep it short and never log the API key.
      return { sent: false, provider: cfg.provider, error: `provider returned ${response.status}: ${body.slice(0, 200)}` };
    }
    return { sent: true, provider: cfg.provider };
  } catch (err) {
    return { sent: false, provider: cfg.provider, error: err instanceof Error ? err.message : 'send failed' };
  }
}

// ---------------------------------------------------------------- templates

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrap(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f4f5f7;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#1d2330">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(title)}</h1>${bodyHtml}
<p style="font-size:12px;color:#6b7280;margin-top:28px">Sent by e-BOS. If you did not expect this email you can ignore it.</p>
</div></body></html>`;
}

function button(link: string, label: string): string {
  return `<p style="margin:22px 0"><a href="${escapeHtml(link)}" style="background:#1d2330;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;display:inline-block">${escapeHtml(label)}</a></p>
<p style="font-size:12px;color:#6b7280;word-break:break-all">Or paste this link into your browser:<br>${escapeHtml(link)}</p>`;
}

export function verifyEmailMessage(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    subject: 'Confirm your e-BOS email address',
    text: `Hi ${name},\n\nConfirm your email to activate your e-BOS account (link valid for 24 hours):\n${link}\n\nIf you did not create an account you can ignore this email.`,
    html: wrap('Confirm your email', `<p>Hi ${escapeHtml(name)},</p><p>Confirm your email address to activate your e-BOS account. The link is valid for 24 hours.</p>${button(link, 'Confirm email')}`),
  };
}

export function resetPasswordMessage(to: string, name: string, link: string): EmailMessage {
  return {
    to,
    subject: 'Reset your e-BOS password',
    text: `Hi ${name},\n\nUse this link to choose a new password (valid for 1 hour):\n${link}\n\nIf you did not ask for this, ignore this email — your password has not changed.`,
    html: wrap('Reset your password', `<p>Hi ${escapeHtml(name)},</p><p>Use the button to choose a new password. The link is valid for 1 hour and works once.</p>${button(link, 'Choose a new password')}<p>If you did not ask for this, ignore this email — your password has not changed.</p>`),
  };
}

export function inviteMessage(to: string, name: string, inviter: string, businessName: string, link: string): EmailMessage {
  return {
    to,
    subject: `${inviter} invited you to ${businessName} on e-BOS`,
    text: `Hi ${name},\n\n${inviter} added you to ${businessName} on e-BOS. Set your password to get started (link valid for 7 days):\n${link}`,
    html: wrap('You have been invited', `<p>Hi ${escapeHtml(name)},</p><p>${escapeHtml(inviter)} added you to <b>${escapeHtml(businessName)}</b> on e-BOS. Set your password to get started. The link is valid for 7 days.</p>${button(link, 'Set my password')}`),
  };
}

export function existingAccountMessage(to: string, signInLink: string, resetLink: string): EmailMessage {
  return {
    to,
    subject: 'You already have an e-BOS account',
    text: `Someone (hopefully you) tried to register with this email address, but it already has an e-BOS account.\n\nSign in: ${signInLink}\nForgot your password? ${resetLink}\n\nIf this was not you, no action is needed.`,
    html: wrap('You already have an account', `<p>Someone (hopefully you) tried to register with this email address, but it already has an e-BOS account.</p>${button(signInLink, 'Sign in')}<p>Forgot your password? <a href="${escapeHtml(resetLink)}">Reset it</a>.</p><p>If this was not you, no action is needed.</p>`),
  };
}

const REASON_TEXT: Record<string, string> = {
  visitor_token_redeemed: 'the customer redeemed an order code',
  pricing: 'the customer asked about pricing or a custom quote',
  complaint: 'the customer raised a complaint or problem',
  low_confidence: 'the AI assistant could not answer confidently',
  visitor_requested: 'the customer asked to talk to a person',
};

export function handoffWaitingMessage(to: string, name: string, businessName: string, reason: string, link: string): EmailMessage {
  const why = REASON_TEXT[reason] ?? 'a conversation needs a person';
  return {
    to,
    subject: `A customer is waiting at ${businessName}`,
    text: `Hi ${name},\n\nA customer conversation at ${businessName} needs a person — ${why}.\n\nOpen the Chat Inbox: ${link}`,
    html: wrap('A customer is waiting', `<p>Hi ${escapeHtml(name)},</p><p>A customer conversation at <b>${escapeHtml(businessName)}</b> needs a person — ${escapeHtml(why)}.</p>${button(link, 'Open the Chat Inbox')}`),
  };
}
