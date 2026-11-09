import 'dotenv/config';
import { Client } from 'pg';
import { pgSsl } from '../lib/ssl.js';

/**
 * Sets the passwords of the two LOGIN roles the migrations create
 * (app_login, app_public_login) to the passwords found in
 * APP_DATABASE_URL / PUBLIC_DATABASE_URL. Runs on every deploy, between
 * the migrations and the server start (see package.json "deploy").
 *
 * WHY: migrations 004 and 008 create those roles with the fixed password
 * 'change_me_in_production'. Nothing ever applied the passwords an
 * operator put in the two URLs, so on a fresh database the server booted
 * (pools connect lazily) and then every request using those pools failed
 * with "password authentication failed". Reproduced against a real
 * Postgres before this script existed. Idempotent: safe to run every
 * deploy; the URLs are the single source of truth.
 *
 * Needs DATABASE_URL (the admin user that ran the migrations). Set
 * SKIP_ROLE_PASSWORD_SYNC=true if that user cannot ALTER ROLE and you
 * manage the role passwords yourself. Never logs a password.
 */
const TARGETS = [
  { role: 'app_login', envVar: 'APP_DATABASE_URL' },
  { role: 'app_public_login', envVar: 'PUBLIC_DATABASE_URL' },
] as const;

const DEFAULT_PASSWORD = 'change_me_in_production';

function passwordFrom(raw: string, expectedUser: string, envVar: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${envVar} is not a valid connection URL (expected postgres://USER:PASSWORD@HOST/DATABASE)`);
  }
  const user = decodeURIComponent(url.username);
  if (user !== expectedUser) {
    // NEVER print `user` here. If the ":" between the user and the password
    // is missing, the parsed "user" IS the password, and an earlier version
    // of this message echoed it straight into the deploy logs.
    const missingColon = user.startsWith(expectedUser) && !url.password;
    throw new Error(
      `${envVar} must connect as "${expectedUser}", but the user part of the URL does not match it.` +
        (missingColon
          ? ' It starts with that name but has extra characters and no password — the ":" between the user and the password is probably missing.'
          : ''),
    );
  }
  const password = decodeURIComponent(url.password);
  if (!password) throw new Error(`${envVar} contains no password`);
  return password;
}

async function main(): Promise<void> {
  if ((process.env.SKIP_ROLE_PASSWORD_SYNC ?? '').toLowerCase() === 'true') {
    console.log('[sync-role-passwords] skipped (SKIP_ROLE_PASSWORD_SYNC=true)');
    return;
  }
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) throw new Error('DATABASE_URL is not set');

  // Validate every URL BEFORE touching any role, so one bad variable can
  // never leave the roles half-updated.
  const planned: Array<{ role: string; envVar: string; password: string }> = [];
  for (const target of TARGETS) {
    const raw = process.env[target.envVar];
    if (!raw) {
      console.warn(`[sync-role-passwords] ${target.envVar} is not set; leaving ${target.role} unchanged`);
      continue;
    }
    planned.push({ role: target.role, envVar: target.envVar, password: passwordFrom(raw, target.role, target.envVar) });
  }

  const client = new Client({ connectionString: adminUrl, ssl: pgSsl() });
  await client.connect();
  try {
    // One transaction: both roles change, or neither does.
    await client.query('BEGIN');
    for (const item of planned) {
      // item.role comes from the constant list above, never from input.
      await client.query(`ALTER ROLE ${item.role} PASSWORD ${client.escapeLiteral(item.password)}`);
    }
    await client.query('COMMIT');
    for (const item of planned) {
      console.log(
        `[sync-role-passwords] ${item.role}: password set from ${item.envVar}` +
          (item.password === DEFAULT_PASSWORD ? ' — WARNING: this is the publicly known default password' : ''),
      );
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err: unknown) => {
  console.error('[sync-role-passwords] failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
