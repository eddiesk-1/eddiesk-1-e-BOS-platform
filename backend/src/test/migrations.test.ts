import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Static checks on migrations 019-021. They run without a database: each
 * migration is executed against a fake `pgm` that just records the SQL.
 * This catches structural mistakes (a SECURITY DEFINER function without a
 * pinned search_path, a function nobody revoked from PUBLIC, an `up` that
 * cannot be reversed) — it does NOT prove the SQL is valid Postgres. That
 * needs a real database (integration.test.ts, or `npm run migrate:up`).
 */
const require = createRequire(import.meta.url);
const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

function capture(file: string, direction: 'up' | 'down'): string[] {
  const out: string[] = [];
  const mod = require(path.join(dir, file));
  mod[direction]({ sql: (s: string) => out.push(s) });
  return out;
}

const NEW = ['019_accounts_and_auth.js', '020_chat_ai_and_notifications.js', '021_payments.js'];
// Functions that are deliberately not "revoke from PUBLIC, grant to a role" pairs.
const NOT_REVOKED = new Set(['sync_account_security', 'diag_owner_bypasses_rls']);

describe('migration files', () => {
  test('numbering is contiguous 001..021 with no duplicates', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
    const numbers = files.map((f) => Number(f.slice(0, 3)));
    assert.deepEqual(numbers, Array.from({ length: numbers.length }, (_, i) => i + 1));
    assert.equal(numbers[numbers.length - 1], 21);
  });
});

for (const file of NEW) {
  describe(file, () => {
    const up = capture(file, 'up');
    const down = capture(file, 'down');
    const upSql = up.join('\n');
    const downSql = down.join('\n');

    test('up is non-destructive', () => {
      assert.doesNotMatch(upSql, /\bDROP\s+TABLE\b/i);
      assert.doesNotMatch(upSql, /\bDROP\s+COLUMN\b/i);
      assert.doesNotMatch(upSql, /\bTRUNCATE\b/i);
      assert.doesNotMatch(upSql, /\bDELETE\s+FROM\b/i);
    });

    test('every SECURITY DEFINER function pins search_path', () => {
      for (const stmt of up.filter((s) => /CREATE OR REPLACE FUNCTION/i.test(s))) {
        if (/SECURITY DEFINER/i.test(stmt)) {
          assert.match(stmt, /SET search_path\s*=/i, stmt.slice(0, 120));
        }
      }
    });

    test('every function is revoked from PUBLIC and granted to named roles', () => {
      const created = [...upSql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1]);
      for (const name of created) {
        if (NOT_REVOKED.has(name)) continue;
        assert.match(upSql, new RegExp(`REVOKE ALL ON FUNCTION ${name}\\(`), `${name} not revoked from PUBLIC`);
        assert.match(upSql, new RegExp(`GRANT EXECUTE ON FUNCTION ${name}\\(`), `${name} has no grant`);
      }
    });

    test('down drops every function and table that up creates', () => {
      const fns = [...upSql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)\(/g)].map((m) => m[1]);
      for (const name of fns) assert.match(downSql, new RegExp(`DROP FUNCTION IF EXISTS ${name}\\(`), `down misses ${name}`);
      const tables = [...upSql.matchAll(/CREATE TABLE (\w+)/g)].map((m) => m[1]);
      for (const name of tables) assert.match(downSql, new RegExp(`DROP TABLE IF EXISTS ${name}\\b`), `down misses table ${name}`);
    });
  });
}

describe('migration 019 specifics', () => {
  const upSql = capture(NEW[0], 'up').join('\n');
  test('account_security and auth_tokens have no grants to application roles and no RLS policies', () => {
    for (const t of ['account_security', 'auth_tokens']) {
      assert.doesNotMatch(upSql, new RegExp(`GRANT [^;]* ON ${t}\\b`), `${t} must be function-only`);
      assert.doesNotMatch(upSql, new RegExp(`CREATE POLICY [^;]* ON ${t}\\b`));
    }
  });
  test('people FORCE RLS is lifted only for the back-fill and restored after it', () => {
    const stmts = capture(NEW[0], 'up');
    const lift = stmts.findIndex((s) => /ALTER TABLE people NO FORCE ROW LEVEL SECURITY/.test(s));
    const fill = stmts.findIndex((s) => /INSERT INTO account_security/.test(s) && /FROM people/.test(s));
    const restore = stmts.findIndex((s) => /ALTER TABLE people FORCE ROW LEVEL SECURITY/.test(s));
    assert.ok(lift >= 0 && fill > lift && restore > fill, `order was lift=${lift} fill=${fill} restore=${restore}`);
  });
  test('existing people are back-filled as verified so the upgrade locks nobody out', () => {
    assert.match(upSql, /SELECT p\.id, p\.holding_company_id, lower\(btrim\(p\.email\)\), now\(\)/);
  });
  test('tokens are stored hashed only', () => {
    assert.match(upSql, /token_hash\s+text NOT NULL/);
    assert.doesNotMatch(upSql, /token\s+text NOT NULL/);
  });
});

describe('tenant tables created in 019-021 have row-level security', () => {
  for (const [file, tables] of [
    [NEW[0], ['business_profiles']],
    [NEW[1], ['business_ai_settings', 'notifications']],
    [NEW[2], ['payments']],
  ] as Array<[string, string[]]>) {
    const upSql = capture(file, 'up').join('\n');
    for (const t of tables) {
      test(`${t} has RLS enabled and a policy`, () => {
        assert.match(upSql, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`));
        assert.match(upSql, new RegExp(`CREATE POLICY \\w+ ON ${t}\\b`));
      });
    }
  }
});

describe('migration 021 money rules', () => {
  const upSql = capture(NEW[2], 'up').join('\n');
  test('amounts are integer minor units, never floats', () => {
    assert.match(upSql, /amount_minor\s+bigint NOT NULL CHECK \(amount_minor > 0\)/);
    assert.doesNotMatch(upSql, /\b(float|double precision|real)\b/i);
  });
  test('duplicate provider events are impossible at the schema level', () => {
    assert.match(upSql, /UNIQUE \(provider, event_key\)/);
    assert.match(upSql, /ON CONFLICT \(provider, event_key\) DO NOTHING/);
  });
  test('a payment cannot be paid without a paid_at, nor have paid_at without being paid', () => {
    assert.match(upSql, /CHECK \(\(status = 'paid'\) = \(paid_at IS NOT NULL\)\)/);
  });
  test('exactly one statement can set a payment to paid, and the generic status update is limited to failed/abandoned', () => {
    assert.equal((upSql.match(/UPDATE payments\s+SET status = 'paid'/g) ?? []).length, 1);
    assert.match(upSql, /IF p_status IN \('failed', 'abandoned'\) AND v_pay\.status = 'initialized' THEN\s+UPDATE payments SET status = p_status/);
    // and that single statement lives inside payment_apply_event
    const fn = upSql.slice(upSql.indexOf('CREATE OR REPLACE FUNCTION payment_apply_event'), upSql.indexOf('CREATE OR REPLACE FUNCTION payment_visitor_view'));
    assert.match(fn, /UPDATE payments\s+SET status = 'paid'/);
  });
  test('amount and currency are compared before marking paid', () => {
    assert.match(upSql, /v_pay\.amount_minor <> p_amount_minor OR v_pay\.currency <> upper/);
  });
  test('the visitor only receives the transaction token once paid', () => {
    assert.match(upSql, /IF v_pay\.status = 'paid' THEN\s+SELECT t\.token/);
  });
});
