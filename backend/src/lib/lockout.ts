/**
 * Progressive login lockout. The 5th consecutive failure locks the account
 * for 30 s, then it doubles with every further failure, capped at 15 min.
 * A successful login (or a password reset) clears the counter in the
 * database (auth_record_success). A per-IP rate limit sits in front of
 * this, so one address cannot cycle through many accounts either.
 *
 * Trade-off, stated plainly: anyone who knows an email can lock that
 * account for up to 15 minutes by failing on purpose. Short caps plus the
 * reset flow keep that an annoyance rather than a lockout of the owner.
 */
export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MAX_SECONDS = 15 * 60;

export function lockoutSecondsFor(failedAttempts: number): number {
  if (!Number.isFinite(failedAttempts) || failedAttempts < LOCKOUT_THRESHOLD) return 0;
  const steps = Math.min(failedAttempts - LOCKOUT_THRESHOLD, 10);
  return Math.min(LOCKOUT_MAX_SECONDS, 30 * 2 ** steps);
}
