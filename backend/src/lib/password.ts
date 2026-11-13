/**
 * Password policy. Pure functions only (no bcrypt import) so the rules are
 * unit-testable without native modules — hashing lives in passwordHash.ts.
 *
 * bcrypt only reads the first 72 BYTES of its input, so a longer password
 * would be silently truncated: two different 100-character passwords with
 * the same first 72 bytes would be accepted as the same password. The
 * policy therefore rejects anything over 72 bytes instead of pretending to
 * honour it.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_BYTES = 72;

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'passw0rd', '123456', '1234567', '12345678', '123456789',
  '1234567890', '0123456789', 'qwerty', 'qwerty123', 'qwertyuiop', 'abc123', 'abcd1234', 'iloveyou',
  'admin', 'admin123', 'administrator', 'welcome', 'welcome1', 'welcome123', 'letmein', 'monkey',
  'dragon', 'football', 'baseball', 'master', 'sunshine', 'princess', 'trustno1', 'changeme',
  'change_me_in_production', 'seed_password_123', 'ghana123', 'accra123', 'kumasi123', 'gh123456',
  'p@ssw0rd', 'p@ssword', 'test1234', 'testtest', 'default', 'login', 'secret', 'e-bos', 'ebos1234',
]);

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

function characterClasses(password: string): number {
  let n = 0;
  if (/[a-z]/.test(password)) n++;
  if (/[A-Z]/.test(password)) n++;
  if (/[0-9]/.test(password)) n++;
  if (/[^A-Za-z0-9]/.test(password)) n++;
  return n;
}

function isSequentialOrRepeated(password: string): boolean {
  const lower = password.toLowerCase();
  if (/^(.)\1+$/.test(lower)) return true;
  if ('0123456789'.includes(lower) || 'abcdefghijklmnopqrstuvwxyz'.includes(lower)) return true;
  if (/^(?:(..?.?.?)\1+)$/.test(lower)) return true; // "abcabcabcabc"
  return false;
}

export function checkPasswordStrength(
  password: unknown,
  context: { email?: string; name?: string } = {},
): PasswordCheck {
  const problems: string[] = [];
  if (typeof password !== 'string' || password.length === 0) {
    return { ok: false, problems: ['A password is required.'] };
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_BYTES) {
    problems.push(`Use at most ${PASSWORD_MAX_BYTES} bytes (long non-English text counts extra).`);
  }

  // A long passphrase is fine without symbols; a short one needs variety.
  if (password.length < 14 && characterClasses(password) < 3) {
    problems.push('Mix at least three of: lowercase, uppercase, numbers, symbols — or use 14+ characters.');
  }

  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) {
    problems.push('That password is too common.');
  } else if (isSequentialOrRepeated(password)) {
    problems.push('Avoid repeated or sequential characters.');
  }

  // Check each word of the email's local part ("kwame.mensah" -> kwame,
  // mensah) and the whole thing with separators removed, so swapping a dot
  // for a hyphen does not get around the rule.
  const emailLocal = (context.email ?? '').split('@')[0]?.toLowerCase() ?? '';
  const emailWords = emailLocal.split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const emailJoined = emailLocal.replace(/[^a-z0-9]+/g, '');
  const lowerAlnum = lower.replace(/[^a-z0-9]+/g, '');
  if (
    emailWords.some((w) => lower.includes(w)) ||
    (emailJoined.length >= 4 && lowerAlnum.includes(emailJoined))
  ) {
    problems.push('Do not include your email name in your password.');
  }
  for (const part of (context.name ?? '').toLowerCase().split(/\s+/)) {
    if (part.length >= 4 && lower.includes(part)) {
      problems.push('Do not include your name in your password.');
      break;
    }
  }

  return { ok: problems.length === 0, problems };
}
