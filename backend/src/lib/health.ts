import { pool } from './db.js';
import { publicPool, withPublicAccess } from './publicDb.js';

/**
 * Readiness: can this process actually do its job? A running HTTP server
 * with a dead database is NOT healthy, so /ready (used by Render's health
 * check) exercises both pools. The response body deliberately contains no
 * hostnames, error text or role names.
 */
export interface Readiness {
  ready: boolean;
  appDb: boolean;
  publicDb: boolean;
}

async function ping(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await Promise.race([
      run(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

export async function checkReadiness(): Promise<Readiness> {
  const [appDb, publicDb] = await Promise.all([
    ping(() => pool.query('SELECT 1')),
    ping(() => publicPool.query('SELECT 1')),
  ]);
  return { ready: appDb && publicDb, appDb, publicDb };
}

/**
 * Do the SECURITY DEFINER functions (migrations 013, 016, 019-021) see rows?
 * They read FORCE-ROW-LEVEL-SECURITY tables as the function owner, which
 * only works if the migration user is a superuser or has BYPASSRLS.
 * Returns null when it cannot be determined (migration 019 not applied).
 * Logged at startup; never exposed over HTTP.
 */
export async function ownerBypassesRls(): Promise<boolean | null> {
  try {
    return await withPublicAccess(async (client) => {
      const r = await client.query<{ ok: boolean }>('SELECT diag_owner_bypasses_rls() AS ok');
      return r.rows[0]?.ok ?? null;
    });
  } catch {
    return null;
  }
}
