/** Small, dependency-free input validators shared by the routes. */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  if (email.length < 5 || email.length > 254) return null;
  if (!EMAIL_RE.test(email)) return null;
  const [local] = email.split('@');
  if (!local || local.length > 64) return null;
  return email;
}

/**
 * Normalises a phone number to E.164. Ghana (+233) is the default country:
 *   024 123 4567, 0241234567, 233241234567, +233 24 123 4567 -> +233241234567
 * Anything else must be written with a leading + (or 00) and a country
 * code. Returns null when the number cannot be valid. This checks shape,
 * not whether the line is live.
 */
export function normalizePhone(value: unknown, defaultCountry: 'GH' = 'GH'): string | null {
  if (typeof value !== 'string') return null;
  let digits = value.trim().replace(/[\s().-]/g, '');
  if (digits.startsWith('00')) digits = '+' + digits.slice(2);

  if (digits.startsWith('+')) {
    if (!/^\+[1-9][0-9]{7,14}$/.test(digits)) return null;
    if (digits.startsWith('+233') && !/^\+233[235][0-9]{8}$/.test(digits)) return null;
    return digits;
  }
  if (!/^[0-9]+$/.test(digits)) return null;

  if (defaultCountry === 'GH') {
    if (/^0[235][0-9]{8}$/.test(digits)) return '+233' + digits.slice(1);
    if (/^233[235][0-9]{8}$/.test(digits)) return '+' + digits;
  }
  return null;
}

/** Trims, strips control characters, enforces a maximum length. */
export function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (cleaned.length === 0 || cleaned.length > max) return null;
  return cleaned;
}

export const BUSINESS_CATEGORIES = [
  'food', 'agriculture', 'energy', 'manufacturing', 'education',
  'retail', 'services', 'technology', 'health', 'other',
] as const;
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

export function isBusinessCategory(value: unknown): value is BusinessCategory {
  return typeof value === 'string' && (BUSINESS_CATEGORIES as readonly string[]).includes(value);
}
