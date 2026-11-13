import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** 256-bit URL-safe random token. Shown to the user once (in an email). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Only this hash is ever stored (auth_tokens.token_hash). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Cheap shape check so garbage never reaches the database. */
export function looksLikeToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value);
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
