import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Paystack integration (https://paystack.com/docs/api/). Built from the
 * published API reference; NOT yet exercised against a live Paystack
 * account — run a test-mode payment end to end (DEPLOY.md) before
 * enabling live keys.
 *
 * SECURITY MODEL
 *   - The secret key never leaves the server.
 *   - Webhooks are authenticated by an HMAC-SHA512 of the RAW request
 *     body, keyed with the secret key, in the x-paystack-signature
 *     header. The raw bytes must be hashed — not re-serialised JSON.
 *   - A payment only becomes 'paid' through the payment_apply_event
 *     database function (migration 021), which re-checks amount and
 *     currency and ignores duplicate deliveries. Browser redirects
 *     ("?reference=…") carry no authority; they only prompt the server to
 *     ask Paystack's verify API.
 *   - Money is integer minor units (pesewas). toMinorUnits uses string
 *     arithmetic; there is no floating point anywhere in this path.
 */

export function verifyPaystackSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secretKey: string,
): boolean {
  if (!signatureHeader || !secretKey) return false;
  const expected = createHmac('sha512', secretKey).update(rawBody).digest('hex');
  const given = signatureHeader.trim().toLowerCase();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(given, 'utf8'));
}

/** "12.50" -> 1250n. Rejects more than 2 decimals, negatives, exponents. */
export function toMinorUnits(amount: string | number): bigint {
  const s = typeof amount === 'number' ? amount.toFixed(2) : amount.trim();
  const m = /^([0-9]{1,12})(?:\.([0-9]{1,2}))?$/.exec(s);
  if (!m) throw new Error('invalid amount');
  const major = BigInt(m[1]);
  const minor = BigInt((m[2] ?? '').padEnd(2, '0') || '0');
  return major * 100n + minor;
}

export function newReference(): string {
  return 'ebos_' + randomBytes(16).toString('hex');
}

export type MappedStatus = 'success' | 'failed' | 'abandoned' | 'other';

export function mapPaystackStatus(status: string | undefined): MappedStatus {
  switch ((status ?? '').toLowerCase()) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'abandoned':
      return 'abandoned';
    default:
      return 'other'; // ongoing, pending, queued, reversed...
  }
}

export interface PaystackWebhookEvent {
  event?: string;
  data?: {
    id?: number | string;
    reference?: string;
    status?: string;
    amount?: number;
    currency?: string;
  };
}

/** Paystack webhooks carry no event id; (event type + transaction id) is stable across retries. */
export function eventKeyFor(evt: PaystackWebhookEvent): string | null {
  const type = evt.event;
  const id = evt.data?.id;
  if (!type || id === undefined || id === null) return null;
  return `${type}:${String(id)}`;
}

export interface PaystackConfig {
  secretKey: string;
  baseUrl: string;
}

export function readPaystackConfig(env: NodeJS.ProcessEnv = process.env): PaystackConfig | null {
  const secretKey = (env.PAYSTACK_SECRET_KEY ?? '').trim();
  if (!secretKey) return null;
  return { secretKey, baseUrl: (env.PAYSTACK_BASE_URL ?? 'https://api.paystack.co').replace(/\/$/, '') };
}

async function paystackFetch(cfg: PaystackConfig, path: string, init: { method: string; body?: string }) {
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${cfg.secretKey}`, 'Content-Type': 'application/json' },
    body: init.body,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  if (!response.ok) {
    const msg = (json as { message?: string } | null)?.message ?? text.slice(0, 200);
    throw new Error(`Paystack ${response.status}: ${msg}`);
  }
  return json as { status: boolean; message?: string; data?: Record<string, unknown> };
}

export async function initializeTransaction(
  cfg: PaystackConfig,
  input: {
    email: string;
    amountMinor: bigint;
    currency: string;
    reference: string;
    callbackUrl: string;
    metadata?: Record<string, unknown>;
  },
): Promise<{ authorizationUrl: string; reference: string }> {
  const json = await paystackFetch(cfg, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: input.email,
      amount: Number(input.amountMinor), // integer pesewas; safe far below 2^53
      currency: input.currency,
      reference: input.reference,
      callback_url: input.callbackUrl,
      metadata: input.metadata ?? {},
    }),
  });
  const url = json.data?.authorization_url;
  if (!json.status || typeof url !== 'string') throw new Error('Paystack did not return an authorization URL');
  return { authorizationUrl: url, reference: String(json.data?.reference ?? input.reference) };
}

export interface VerifiedTransaction {
  status: MappedStatus;
  amountMinor: bigint;
  currency: string;
  providerTransactionId: string;
  reference: string;
}

export async function verifyTransaction(cfg: PaystackConfig, reference: string): Promise<VerifiedTransaction> {
  const json = await paystackFetch(cfg, `/transaction/verify/${encodeURIComponent(reference)}`, { method: 'GET' });
  const d = json.data ?? {};
  if (!json.status || typeof d.amount !== 'number' || typeof d.currency !== 'string') {
    throw new Error('Paystack verify response was not in the expected shape');
  }
  return {
    status: mapPaystackStatus(typeof d.status === 'string' ? d.status : undefined),
    amountMinor: BigInt(d.amount),
    currency: d.currency.toUpperCase(),
    providerTransactionId: String(d.id ?? ''),
    reference: String(d.reference ?? reference),
  };
}
