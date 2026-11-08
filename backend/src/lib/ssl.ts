/**
 * TLS settings shared by every Postgres connection in this project
 * (the two request pools in db.ts/publicDb.ts and the seed script).
 *
 * WHY THIS EXISTS: managed Postgres hosts (Render, and most others)
 * can REQUIRE TLS on a connection path. A pool created with no `ssl`
 * option then fails at connect time with `SSL/TLS required` (SQLSTATE
 * 28000) — before authentication is even attempted. Migrations can still
 * succeed in that situation, because they connect through DATABASE_URL
 * by a different path, which is what makes this easy to miss: the
 * service boots and the first real query is what fails.
 *
 * BEHAVIOUR:
 *   DATABASE_SSL=true | 1 | on     -> TLS on
 *   DATABASE_SSL=false | 0 | off   -> TLS off (e.g. a local, non-TLS DB
 *                                     inside a production container)
 *   unset                          -> TLS on when NODE_ENV=production,
 *                                     off otherwise (so setup.sh's local
 *                                     Postgres keeps working untouched)
 *
 * CERTIFICATE CHECKING: by default the connection is ENCRYPTED but the
 * server's certificate is NOT verified (rejectUnauthorized: false).
 * Managed providers commonly present certificates that don't chain to a
 * public CA, so verifying by default would break the common case. The
 * cost, stated plainly: this protects against eavesdropping but not
 * against an active man-in-the-middle on the network path. Connecting
 * over the provider's private/internal network (the Internal Database
 * URL on Render) keeps that exposure small. Set DATABASE_SSL_VERIFY=true
 * to turn verification on if your provider's certificate supports it.
 */
export function pgSsl(): { rejectUnauthorized: boolean } | undefined {
  const flag = (process.env.DATABASE_SSL ?? '').trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off') return undefined;
  const on = flag === 'true' || flag === '1' || flag === 'on' || process.env.NODE_ENV === 'production';
  if (!on) return undefined;
  return { rejectUnauthorized: (process.env.DATABASE_SSL_VERIFY ?? '').trim().toLowerCase() === 'true' };
}
