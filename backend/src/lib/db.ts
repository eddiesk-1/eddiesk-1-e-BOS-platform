import { Pool, type PoolClient } from 'pg';
import { pgSsl } from './ssl.js';

/**
 * The app process connects to Postgres as app_login — a role with NO table
 * grants of its own (see migrations/004_row_level_security.js). Every
 * authenticated request must call withTenantScope() before touching any
 * app table; that function does the SET ROLE + SET LOCAL dance that
 * activates both the GRANT-level worker restriction and the RLS policies.
 *
 * Getting this wrong (e.g. running a query on a client that skipped
 * withTenantScope) fails LOUD: app_login itself has no privileges on any
 * app table, so a query on a bare pool connection gets "permission denied"
 * immediately. There's no quiet path where tenant scoping is accidentally
 * skipped and the query just runs unscoped — that's what having app_login
 * be table-privilege-empty buys you at the DB layer, on top of the app-layer
 * check in tenantContext.ts.
 */

if (!process.env.APP_DATABASE_URL) {
  throw new Error(
    'APP_DATABASE_URL is not set. The app connects as app_login (a role with ' +
      'zero direct table grants) and SET ROLEs into app_owner_partner or ' +
      'app_worker per request — see .env.example.',
  );
}

export const pool = new Pool({
  connectionString: process.env.APP_DATABASE_URL,
  ssl: pgSsl(),
  max: 10,
});

export type PersonRole = 'owner' | 'partner' | 'worker';

export interface TenantContext {
  holdingCompanyId: string;
  personId: string;
  personRole: PersonRole;
}

/**
 * The Postgres role that owner/partner JWT claims SET ROLE into. Owner vs.
 * partner is NOT a separate DB role — both use this one, and the RLS
 * policies themselves branch on app.person_role to narrow a partner's
 * visibility to businesses they appear in via partnerships. See the long
 * comment on is_business_visible_to_caller() in the migration for why.
 */
const DB_ROLE_FOR: Record<PersonRole, 'app_owner_partner' | 'app_worker'> = {
  owner: 'app_owner_partner',
  partner: 'app_owner_partner',
  worker: 'app_worker',
};

/**
 * Runs `fn` with a Postgres client that has SET ROLE'd into the correct
 * restricted role and SET LOCAL'd the three session variables every RLS
 * policy reads (app.holding_company_id, app.person_id, app.person_role).
 *
 * This wraps everything in a transaction because SET LOCAL is
 * transaction-scoped — that's deliberate, not incidental. If SET ROLE /
 * SET LOCAL were done outside a transaction on a pooled connection, the
 * next request to reuse that same physical connection could inherit the
 * previous request's tenant scoping. Wrapping in BEGIN/COMMIT (or
 * BEGIN/ROLLBACK on error) guarantees the scoping can never leak past the
 * request that set it, regardless of what the pool does with the
 * connection afterward.
 *
 * Every route handler that touches the database goes through this — see
 * src/plugins/tenantContext.ts, which calls this once per request and
 * exposes the scoped client as request.db.
 */
export async function withTenantScope<T>(
  ctx: TenantContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dbRole = DB_ROLE_FOR[ctx.personRole];
    // Role and session-var names come from a fixed internal map/enum, never
    // from unsanitized request input, so string interpolation here is safe
    // — but query parameters are still used for the actual UUID/role
    // values via set_config(), which is the parameterizable equivalent of
    // SET LOCAL for arbitrary values.
    await client.query(`SET ROLE ${dbRole}`);
    await client.query(`SELECT set_config('app.holding_company_id', $1, true)`, [
      ctx.holdingCompanyId,
    ]);
    await client.query(`SELECT set_config('app.person_id', $1, true)`, [ctx.personId]);
    await client.query(`SELECT set_config('app.person_role', $1, true)`, [ctx.personRole]);

    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      // The original error is what the caller needs; a failed ROLLBACK
      // (e.g. connection already dropped) shouldn't mask it.
    });
    throw err;
  } finally {
    // RESET ROLE before releasing back to the pool, so a connection that
    // errored mid-request never returns to the pool still SET ROLE'd into
    // a restricted role for whichever request borrows it next.
    await client.query('RESET ROLE').catch(() => {});
    client.release();
  }
}
