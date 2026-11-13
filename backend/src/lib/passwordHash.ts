import bcrypt from 'bcrypt';

/**
 * bcrypt wrapper. Cost 12 by default (BCRYPT_COST overrides, minimum 10).
 * A hash computed with a lower cost still verifies — bcrypt stores its own
 * cost — so existing accounts (seed script used 10) keep working.
 */
function cost(): number {
  const n = Number(process.env.BCRYPT_COST ?? 12);
  return Number.isInteger(n) && n >= 10 && n <= 15 ? n : 12;
}

export function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, cost());
}

export function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

let dummyHashPromise: Promise<string> | null = null;

/**
 * Burns the same CPU as a real check when no account matched, so the
 * response time of POST /auth/login does not reveal whether an email is
 * registered.
 */
export async function burnPasswordCheck(plain: string): Promise<void> {
  dummyHashPromise ??= bcrypt.hash('not-a-real-password-for-timing-only', cost());
  await bcrypt.compare(plain, await dummyHashPromise);
}
