import { Pool, type PoolClient } from 'pg';

/**
 * A second, separate connection pool from the one in lib/db.ts —
 * authenticated as app_public_login, a role that can ONLY SET ROLE into
 * app_public (see migrations/008_public_catalog_access.js). It has no
 * path into app_owner_partner or app_worker, even in principle, so a bug
 * in the one route that uses this pool (GET /product-stream) cannot
 * accidentally reach tenant-scoped data the way a bug reusing the main
 * app_login pool theoretically could.
 *
 * This is deliberately NOT withTenantScope from lib/db.ts. That function
 * exists to translate a verified JWT's claims (holdingCompanyId,
 * personId, personRole) into RLS session variables — there is no JWT
 * here, no person, no holding company being asserted. The public route
 * this pool serves doesn't need SET LOCAL app.holding_company_id at all;
 * RLS on materials for app_public (the public_catalog policy) checks
 * exactly one thing — catalog_meta IS NOT NULL — which needs no session
 * context whatsoever. Reusing withTenantScope here would mean either
 * passing it fake/empty tenant claims (confusing, and a foot-gun if
 * someone "fixes" it later by making those claims real) or forking its
 * logic anyway — this file is that fork, made explicit instead of
 * implicit.
 */

if (!process.env.PUBLIC_DATABASE_URL) {
  throw new Error(
    'PUBLIC_DATABASE_URL is not set. This must point at app_public_login, a role ' +
      'with no grants except SELECT on materials via the public_catalog RLS policy ' +
      '— see migrations/008_public_catalog_access.js and .env.example.',
  );
}

export const publicPool = new Pool({
  connectionString: process.env.PUBLIC_DATABASE_URL,
  max: 10,
});

/**
 * Runs `fn` with a client SET ROLE'd into app_public. Wrapped in a
 * transaction for the same reason withTenantScope is: SET ROLE on a
 * pooled connection has to be undone (RESET ROLE) before the connection
 * goes back to the pool, or the next unrelated request to borrow this
 * physical connection would silently inherit app_public's restricted
 * privileges — or, worse in the general pattern this mirrors, inherit
 * whatever a PREVIOUS request's SET ROLE left behind. BEGIN/COMMIT here
 * isn't protecting tenant isolation the way it does in db.ts (there's no
 * tenant context to leak), but the connection-hygiene reasoning is
 * identical.
 */
export async function withPublicAccess<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await publicPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET ROLE app_public');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
}

/**
 * Same pool, same app_public role, plus one addition: SET LOCAL
 * app.visitor_token — the session variable conversations/messages'
 * visitor_token_access RLS policies check (migration 012). This is a
 * genuinely different authorization shape from everything else in this
 * codebase: not a role (app_public is still just app_public, same grants
 * as withPublicAccess above), not a holding-company/JWT claim (there is
 * no JWT here) — a per-request, per-token, possession-based check. The
 * caller presented a specific uuid; RLS decides row-by-row whether that
 * uuid matches. See migration 012's file-level comment for the full
 * reasoning on why this is the one deliberate exception to "every
 * boundary in this project is enforced by role + RLS session variables
 * derived from a verified JWT."
 *
 * routes/conversations.ts is the only caller. token must already be a
 * validated uuid string by the time it reaches here — this function does
 * not validate its shape, it only sets it (an invalid string would fail
 * the ::uuid cast inside the RLS policy itself, which is a database
 * error, not a clean 400 — validate before calling this, the same way
 * every route already validates its own inputs before touching the DB).
 *
 * IMPORTANT, learned the hard way (see migration 014's full account):
 * every write this function's caller performs needs BOTH a GRANT and a
 * matching RLS policy FOR that exact command (SELECT/INSERT/UPDATE/
 * DELETE) — a grant with no matching policy for that command still
 * refuses every row under FORCE ROW LEVEL SECURITY, and a policy with no
 * grant never even gets evaluated (permission denied first). If you add
 * a new write to a route using this function, check both, for the
 * SPECIFIC command you're adding — "conversations already has some
 * grants for app_public" is not the same claim as "conversations has an
 * UPDATE grant AND an UPDATE policy for app_public," and conflating them
 * is exactly what caused migration 014 to be needed.
 */
export async function withVisitorAccess<T>(
  visitorToken: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await publicPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET ROLE app_public');
    await client.query(`SELECT set_config('app.visitor_token', $1, true)`, [visitorToken]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
}
