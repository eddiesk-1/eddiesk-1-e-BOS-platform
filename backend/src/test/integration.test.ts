import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool as PgPool, PoolClient } from 'pg';

/**
 * REAL-DATABASE TESTS. They need a migrated Postgres (all 21 migrations):
 *
 *   TEST_DATABASE_URL         admin/owner connection (same kind as DATABASE_URL)
 *   TEST_APP_DATABASE_URL     the app_login connection (same kind as APP_DATABASE_URL)
 *   TEST_PUBLIC_DATABASE_URL  the app_public_login connection
 *   TEST_DATABASE_SSL=true    only if your database requires TLS
 *
 * Use a scratch database — the tests create their own tenants (named
 * "ITEST ...") and delete them afterwards, but they run migrations'
 * functions for real. Without those variables the whole file reports as
 * SKIPPED, which is not the same as passed.
 *
 * Tests inside a describe run in order and some build on earlier ones
 * (e.g. the handoff test relies on the region the region test set).
 */
const adminUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const publicUrl = process.env.TEST_PUBLIC_DATABASE_URL;

if (!adminUrl || !appUrl || !publicUrl) {
  describe('database integration — SKIPPED (TEST_DATABASE_URL / TEST_APP_DATABASE_URL / TEST_PUBLIC_DATABASE_URL not set)', () => {
    test.skip('tenant isolation, account functions, chat functions, payments', () => {});
  });
} else {
  const { Pool } = await import('pg');
  const ssl = process.env.TEST_DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined;
  const admin: PgPool = new Pool({ connectionString: adminUrl, ssl, max: 4 });
  const appPool: PgPool = new Pool({ connectionString: appUrl, ssl, max: 4 });
  const publicPool: PgPool = new Pool({ connectionString: publicUrl, ssl, max: 4 });

  const suffix = randomUUID().slice(0, 8);

  interface Tenant {
    hc: string;
    biz: string;
    owner: string;
    ownerEmail: string;
    worker: string;
    material: string;
  }

  async function makeTenant(label: string): Promise<Tenant> {
    const t: Tenant = {
      hc: randomUUID(), biz: randomUUID(), owner: randomUUID(), worker: randomUUID(), material: randomUUID(),
      ownerEmail: `Owner-${label}-${suffix}@Example.TEST`,
    };
    await admin.query(`INSERT INTO holding_companies (id, name) VALUES ($1, $2)`, [t.hc, `ITEST ${label} ${suffix}`]);
    await admin.query(`INSERT INTO businesses (id, holding_company_id, name) VALUES ($1, $2, $3)`, [t.biz, t.hc, `ITEST Biz ${label}`]);
    await admin.query(
      `INSERT INTO people (id, holding_company_id, name, role, email) VALUES ($1, $2, 'Test Owner', 'owner', $3)`,
      [t.owner, t.hc, t.ownerEmail],
    );
    await admin.query(
      `INSERT INTO people (id, holding_company_id, name, role, email) VALUES ($1, $2, 'Test Worker', 'worker', $3)`,
      [t.worker, t.hc, `worker-${label}-${suffix}@example.test`],
    );
    await admin.query(
      `INSERT INTO materials (id, business_id, name, stage, unit, catalog_meta)
       VALUES ($1, $2, $3, 'finished', 'loaf', $4::jsonb)`,
      [t.material, t.biz, `ITEST Loaf ${label}`, JSON.stringify({ category: 'food', description: 'Daily loaf', price: 25.5, currency: 'GHS' })],
    );
    return t;
  }

  async function asTenant<T>(t: Tenant, who: 'owner' | 'worker', fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query(who === 'worker' ? 'SET ROLE app_worker' : 'SET ROLE app_owner_partner');
      await c.query(`SELECT set_config('app.holding_company_id', $1, true)`, [t.hc]);
      await c.query(`SELECT set_config('app.person_id', $1, true)`, [who === 'worker' ? t.worker : t.owner]);
      await c.query(`SELECT set_config('app.person_role', $1, true)`, [who]);
      return await fn(c);
    } finally {
      await c.query('ROLLBACK').catch(() => {});
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
  }

  /** app_owner_partner with NO tenant variables — how the auth_* functions are called. Commits. */
  async function asAuth<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await appPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET ROLE app_owner_partner');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
  }

  async function asPublic<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await publicPool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET ROLE app_public');
      const r = await fn(c);
      await c.query('COMMIT');
      return r;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await c.query('RESET ROLE').catch(() => {});
      c.release();
    }
  }

  const code = (c: string) => (e: unknown) => (e as { code?: string }).code === c;

  let A: Tenant;
  let B: Tenant;

  before(async () => {
    A = await makeTenant('A');
    B = await makeTenant('B');
  });

  after(async () => {
    try {
      const hcs = [A?.hc, B?.hc].filter(Boolean);
      if (hcs.length > 0) {
        await admin.query(`DELETE FROM payment_events WHERE reference LIKE $1`, [`itest_${suffix}%`]);
        await admin.query(`DELETE FROM payments WHERE business_id IN (SELECT id FROM businesses WHERE holding_company_id = ANY($1::uuid[]))`, [hcs]);
        await admin.query(`DELETE FROM holding_companies WHERE id = ANY($1::uuid[])`, [hcs]);
      }
    } finally {
      await Promise.allSettled([admin.end(), appPool.end(), publicPool.end()]);
    }
  });

  // ==================================================================
  describe('tenant isolation (row-level security)', () => {
    test("owner of A sees only A's business", async () => {
      const rows = await asTenant(A, 'owner', (c) => c.query(`SELECT id FROM businesses`));
      assert.deepEqual(rows.rows.map((r) => r.id), [A.biz]);
    });

    test("A cannot read B's materials, people or business by id", async () => {
      await asTenant(A, 'owner', async (c) => {
        assert.equal((await c.query(`SELECT 1 FROM materials WHERE business_id = $1`, [B.biz])).rowCount, 0);
        assert.equal((await c.query(`SELECT 1 FROM people WHERE id = $1`, [B.owner])).rowCount, 0);
        assert.equal((await c.query(`SELECT 1 FROM businesses WHERE id = $1`, [B.biz])).rowCount, 0);
      });
    });

    test("A cannot modify or delete B's rows (0 rows affected) and B's data survives", async () => {
      await asTenant(A, 'owner', async (c) => {
        assert.equal((await c.query(`UPDATE businesses SET name = 'hijacked' WHERE id = $1`, [B.biz])).rowCount, 0);
        assert.equal((await c.query(`DELETE FROM materials WHERE business_id = $1`, [B.biz])).rowCount, 0);
      });
      const still = await admin.query(`SELECT name FROM businesses WHERE id = $1`, [B.biz]);
      assert.equal(still.rows[0].name, 'ITEST Biz B');
      assert.equal((await admin.query(`SELECT 1 FROM materials WHERE id = $1`, [B.material])).rowCount, 1);
    });

    test("A cannot insert rows into B's tenant", async () => {
      await assert.rejects(
        asTenant(A, 'owner', (c) => c.query(
          `INSERT INTO people (holding_company_id, name, role, email) VALUES ($1, 'Intruder', 'worker', 'x@example.test')`, [B.hc])),
        code('42501'),
      );
      await assert.rejects(
        asTenant(A, 'owner', (c) => c.query(
          `INSERT INTO materials (business_id, name, stage, unit) VALUES ($1, 'Planted', 'raw', 'kg')`, [B.biz])),
        code('42501'),
      );
    });

    test('workers cannot read the ledger', async () => {
      await assert.rejects(asTenant(A, 'worker', (c) => c.query(`SELECT 1 FROM ledger_entries`)), code('42501'));
    });

    test('application roles have no direct access to the auth tables', async () => {
      for (const table of ['account_security', 'auth_tokens', 'payment_events']) {
        await assert.rejects(asTenant(A, 'owner', (c) => c.query(`SELECT 1 FROM ${table}`)), code('42501'), table);
      }
    });

    test('the public role cannot read guide chunks or other tenants\' tables directly', async () => {
      for (const table of ['knowledge_chunks', 'payments', 'notifications', 'account_security']) {
        await assert.rejects(asPublic((c) => c.query(`SELECT 1 FROM ${table}`)), code('42501'), table);
      }
    });
  });

  // ==================================================================
  describe('account functions (migration 019)', () => {
    test('a new person gets an unverified account_security row with a normalised email', async () => {
      const r = await admin.query(`SELECT email_normalized, email_verified_at FROM account_security WHERE person_id = $1`, [A.owner]);
      assert.equal(r.rows[0].email_normalized, A.ownerEmail.toLowerCase());
      assert.equal(r.rows[0].email_verified_at, null);
    });

    test('auth_resolve_candidates finds the account by any casing of the email, and only that account', async () => {
      const rows = await asAuth((c) => c.query(`SELECT * FROM auth_resolve_candidates($1)`, ['  ' + A.ownerEmail.toUpperCase() + ' ']));
      assert.equal(rows.rows.length, 1);
      assert.equal(rows.rows[0].person_id, A.owner);
      assert.equal(rows.rows[0].holding_company_id, A.hc);
      assert.equal(rows.rows[0].email_verified, false);
    });

    test('failed logins count up, lock, and a success clears them', async () => {
      await asAuth(async (c) => {
        const n1 = (await c.query(`SELECT auth_record_failure($1) AS n`, [A.owner])).rows[0].n;
        const n2 = (await c.query(`SELECT auth_record_failure($1) AS n`, [A.owner])).rows[0].n;
        assert.equal(n2, n1 + 1);
        await c.query(`SELECT auth_lock($1, 120)`, [A.owner]);
      });
      const locked = await asAuth((c) => c.query(`SELECT locked_until FROM auth_resolve_candidates($1)`, [A.ownerEmail]));
      assert.ok(new Date(locked.rows[0].locked_until).getTime() > Date.now());
      await asAuth((c) => c.query(`SELECT auth_record_success($1)`, [A.owner]));
      const cleared = await admin.query(`SELECT failed_attempts, locked_until FROM account_security WHERE person_id = $1`, [A.owner]);
      assert.equal(cleared.rows[0].failed_attempts, 0);
      assert.equal(cleared.rows[0].locked_until, null);
    });

    test('tokens are single-use, purpose-bound, and a newer token retires the older one', async () => {
      const first = 'hash-' + randomUUID();
      const second = 'hash-' + randomUUID();
      await asAuth((c) => c.query(`SELECT auth_issue_token($1, 'reset_password', $2, 60)`, [A.owner, first]));
      await asAuth((c) => c.query(`SELECT auth_issue_token($1, 'reset_password', $2, 60)`, [A.owner, second]));
      assert.equal((await asAuth((c) => c.query(`SELECT * FROM auth_consume_token($1, 'reset_password')`, [first]))).rowCount, 0, 'older token must be retired');
      assert.equal((await asAuth((c) => c.query(`SELECT * FROM auth_consume_token($1, 'verify_email')`, [second]))).rowCount, 0, 'wrong purpose');
      const ok = await asAuth((c) => c.query(`SELECT * FROM auth_consume_token($1, 'reset_password')`, [second]));
      assert.equal(ok.rowCount, 1);
      assert.equal(ok.rows[0].person_id, A.owner);
      assert.equal((await asAuth((c) => c.query(`SELECT * FROM auth_consume_token($1, 'reset_password')`, [second]))).rowCount, 0, 'second use must fail');
    });

    test('an expired token cannot be consumed', async () => {
      const h = 'hash-' + randomUUID();
      await asAuth((c) => c.query(`SELECT auth_issue_token($1, 'verify_email', $2, -5)`, [A.owner, h]));
      assert.equal((await asAuth((c) => c.query(`SELECT * FROM auth_consume_token($1, 'verify_email')`, [h]))).rowCount, 0);
    });

    test('verifying marks the account verified; changing the email resets it', async () => {
      await asAuth((c) => c.query(`SELECT auth_mark_verified($1)`, [A.owner]));
      assert.ok((await admin.query(`SELECT email_verified_at FROM account_security WHERE person_id = $1`, [A.owner])).rows[0].email_verified_at);
      await admin.query(`UPDATE people SET email = $2 WHERE id = $1`, [A.owner, `changed-${suffix}@example.test`]);
      const after = await admin.query(`SELECT email_normalized, email_verified_at FROM account_security WHERE person_id = $1`, [A.owner]);
      assert.equal(after.rows[0].email_normalized, `changed-${suffix}@example.test`);
      assert.equal(after.rows[0].email_verified_at, null);
    });

    test('revoking sessions bumps the version used to invalidate old JWTs', async () => {
      const before = (await asAuth((c) => c.query(`SELECT auth_session_version($1) AS v`, [A.owner]))).rows[0].v;
      const bumped = (await asAuth((c) => c.query(`SELECT auth_revoke_sessions($1) AS v`, [A.owner]))).rows[0].v;
      assert.equal(bumped, before + 1);
      assert.equal((await asAuth((c) => c.query(`SELECT auth_session_version($1) AS v`, [randomUUID()]))).rows[0].v, null);
    });
  });

  // ==================================================================
  describe('visitor chat functions (migration 020)', () => {
    const token = randomUUID();
    const conv = randomUUID();

    before(async () => {
      await admin.query(
        `INSERT INTO conversations (id, business_id, kind, visitor_token, subject) VALUES ($1, $2, 'consumer', $3, 'ITEST')`,
        [conv, A.biz, token],
      );
      await admin.query(`INSERT INTO messages (conversation_id, sender_type, body) VALUES ($1, 'visitor', 'Do you deliver bread to Kumasi?')`, [conv]);
      const guide = randomUUID();
      for (const content of ['We deliver bread across Kumasi and Accra every morning.', 'The shop is closed on Sundays and public holidays.']) {
        await admin.query(
          `INSERT INTO knowledge_chunks (business_id, source_guide_id, content, embedding)
           VALUES ($1, $2, $3, array_fill(0.01::real, ARRAY[1536])::vector)`,
          [A.biz, guide, content],
        );
      }
      await admin.query(`INSERT INTO transaction_paths (person_id, region_label, transaction_types) VALUES ($1, 'Ashanti', '{}')`, [A.worker]);
    });

    const ctx = (tsquery: string | null, tok = token) =>
      asPublic((c) => c.query(`SELECT chat_ai_context($1, $2, $3) AS ctx`, [conv, tok, tsquery])).then((r) => r.rows[0].ctx);

    test('returns ranked guide chunks, the published catalog and the business region labels', async () => {
      const c = await ctx('deliver | kumasi');
      assert.equal(c.retrieval_mode, 'fts');
      assert.match(c.chunks[0], /Kumasi/);
      assert.ok(!c.chunks.some((x: string) => /Sundays/.test(x)), 'irrelevant chunk must not be returned');
      assert.ok(c.items.some((i: { name: string }) => i.name === 'ITEST Loaf A'));
      assert.ok(c.region_labels.includes('Ashanti'));
      assert.equal(c.handled_by, 'ai');
    });

    test('falls back to the first chunks when nothing matches, and honours retrieval depth', async () => {
      const c = await ctx('zzzzunmatched');
      assert.equal(c.retrieval_mode, 'fallback');
      assert.equal(c.chunks.length, 2);
      await admin.query(`INSERT INTO business_ai_settings (business_id, retrieval_depth) VALUES ($1, 1) ON CONFLICT (business_id) DO UPDATE SET retrieval_depth = 1`, [A.biz]);
      assert.equal((await ctx('zzzzunmatched')).chunks.length, 1);
      await admin.query(`UPDATE business_ai_settings SET retrieval_depth = 8 WHERE business_id = $1`, [A.biz]);
    });

    test('a wrong visitor token gets nothing', async () => {
      assert.equal(await ctx('deliver', randomUUID()), null);
    });

    test('the AI reply is saved, marked as AI, and counted', async () => {
      const r = (await asPublic((c) => c.query(`SELECT chat_post_ai_message($1, $2, 'Yes — we deliver in Kumasi.', true, false) AS m`, [conv, token]))).rows[0].m;
      assert.equal(r.ok, true);
      assert.equal(r.sender_type, 'ai');
      assert.equal(r.is_ai_disclosure, true);
      assert.equal((await ctx(null)).prior_ai_count, 1);
      const bad = (await asPublic((c) => c.query(`SELECT chat_post_ai_message($1, $2, 'x', false, false) AS m`, [conv, randomUUID()]))).rows[0].m;
      assert.equal(bad.ok, false);
    });

    test('region is only set once', async () => {
      assert.equal((await asPublic((c) => c.query(`SELECT chat_set_region($1, $2, 'Ashanti') AS ok`, [conv, token]))).rows[0].ok, true);
      assert.equal((await asPublic((c) => c.query(`SELECT chat_set_region($1, $2, 'Northern') AS ok`, [conv, token]))).rows[0].ok, false);
    });

    test('handoff marks the conversation, notifies matching staff once, and never other tenants', async () => {
      const r = (await asPublic((c) => c.query(`SELECT chat_request_handoff($1, $2, 'pricing') AS r`, [conv, token]))).rows[0].r;
      assert.equal(r.changed, true);
      const ids = r.recipients.map((x: { person_id: string }) => x.person_id);
      assert.ok(ids.includes(A.owner), 'owners are always notified');
      assert.ok(ids.includes(A.worker), 'worker whose path covers Ashanti is notified');
      assert.ok(!ids.includes(B.owner), 'another tenant is never notified');

      const row = (await admin.query(`SELECT handled_by, handoff_reason FROM conversations WHERE id = $1`, [conv])).rows[0];
      assert.equal(row.handled_by, 'awaiting_human');
      assert.equal(row.handoff_reason, 'pricing');

      const again = (await asPublic((c) => c.query(`SELECT chat_request_handoff($1, $2, 'complaint') AS r`, [conv, token]))).rows[0].r;
      assert.equal(again.changed, false);
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM notifications WHERE conversation_id = $1`, [conv])).rows[0].n, ids.length);
    });

    test('after handoff the AI cannot keep chatting, except for the one notice', async () => {
      const blocked = (await asPublic((c) => c.query(`SELECT chat_post_ai_message($1, $2, 'more', false, false) AS m`, [conv, token]))).rows[0].m;
      assert.equal(blocked.ok, false);
      const notice = (await asPublic((c) => c.query(`SELECT chat_post_ai_message($1, $2, 'A team member will join.', false, true) AS m`, [conv, token]))).rows[0].m;
      assert.equal(notice.ok, true);
    });

    test('notifications are visible only to their addressee', async () => {
      const own = await asTenant(A, 'owner', (c) => c.query(`SELECT person_id FROM notifications`));
      assert.ok(own.rows.length >= 1);
      assert.ok(own.rows.every((r) => r.person_id === A.owner));
      const worker = await asTenant(A, 'worker', (c) => c.query(`SELECT person_id FROM notifications`));
      assert.ok(worker.rows.every((r) => r.person_id === A.worker));
      const other = await asTenant(B, 'owner', (c) => c.query(`SELECT 1 FROM notifications`));
      assert.equal(other.rowCount, 0);
    });
  });

  // ==================================================================
  describe('checkout and payments (migration 021)', () => {
    const token = randomUUID();
    const conv = randomUUID();
    const ref = `itest_${suffix}_${randomUUID().slice(0, 12)}`;
    const ref2 = `itest_${suffix}_${randomUUID().slice(0, 12)}`;
    const strangerToken = randomUUID();
    let orderId = '';

    const checkout = (items: unknown, reference: string, tok = token, c0 = conv) =>
      asPublic((c) => c.query(`SELECT checkout_create($1, $2, $3::jsonb, $4, 'paystack') AS r`, [c0, tok, JSON.stringify(items), reference])).then((r) => r.rows[0].r);
    const apply = (key: string, reference: string, status: string, amount: number, currency = 'GHS') =>
      asPublic((c) => c.query(
        `SELECT payment_apply_event('paystack', $1, 'charge.success', $2, $3, $4::bigint, $5, '1001', '{}'::jsonb) AS o`,
        [key, reference, status, String(amount), currency])).then((r) => r.rows[0].o);
    const view = (reference: string, tok = token) =>
      asPublic((c) => c.query(`SELECT payment_visitor_view($1, $2) AS v`, [reference, tok])).then((r) => r.rows[0].v);

    before(async () => {
      const cp = (await admin.query(
        `INSERT INTO counterparties (business_id, name, roles, contact) VALUES ($1, 'ITEST Buyer', ARRAY['customer'], $2::jsonb) RETURNING id`,
        [A.biz, JSON.stringify({ email: 'buyer@example.test' })])).rows[0].id;
      await admin.query(
        `INSERT INTO conversations (id, business_id, kind, visitor_token, counterparty_id, subject) VALUES ($1, $2, 'consumer', $3, $4, 'ITEST pay')`,
        [conv, A.biz, token, cp]);
      await admin.query(
        `INSERT INTO conversations (id, business_id, kind, visitor_token, subject) VALUES ($1, $2, 'consumer', $3, 'ITEST stranger')`,
        [randomUUID(), A.biz, strangerToken]);
    });

    test('an unidentified visitor cannot check out', async () => {
      const strangerConv = (await admin.query(`SELECT id FROM conversations WHERE visitor_token = $1`, [strangerToken])).rows[0].id;
      const r = await checkout([{ material_id: A.material, quantity: 1 }], `itest_${suffix}_x1`, strangerToken, strangerConv);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'not_identified');
    });

    test("an item from another business, or a bad basket, is refused", async () => {
      assert.equal((await checkout([{ material_id: B.material, quantity: 1 }], `itest_${suffix}_x2`)).reason, 'item_unavailable');
      assert.equal((await checkout([{ material_id: A.material, quantity: 0 }], `itest_${suffix}_x3`)).reason, 'invalid_items');
      assert.equal((await checkout([], `itest_${suffix}_x4`)).reason, 'invalid_items');
    });

    test('the price comes from the database and the total is exact', async () => {
      const r = await checkout([{ material_id: A.material, quantity: 2 }], ref);
      assert.equal(r.ok, true);
      assert.equal(Number(r.amount_minor), 5100); // 2 x GHS 25.50
      assert.equal(r.currency, 'GHS');
      orderId = r.order_id;
      const o = (await admin.query(`SELECT status, total FROM orders WHERE id = $1`, [orderId])).rows[0];
      assert.equal(o.status, 'pending_payment');
      assert.equal(o.total, '51.00');
      assert.equal((await admin.query(`SELECT status FROM payments WHERE reference = $1`, [ref])).rows[0].status, 'initialized');
    });

    test('before payment the visitor gets no transaction token', async () => {
      const v = await view(ref);
      assert.equal(v.status, 'initialized');
      assert.equal(v.transaction_token, null);
    });

    test('a different visitor cannot see the payment', async () => {
      assert.equal(await view(ref, strangerToken), null);
    });

    test('a success event with the wrong amount or currency does NOT mark it paid', async () => {
      assert.equal((await apply(`charge.success:${suffix}-1`, ref, 'success', 5099)).reason, 'amount_mismatch');
      assert.equal((await apply(`charge.success:${suffix}-2`, ref, 'success', 5100, 'USD')).reason, 'amount_mismatch');
      assert.equal((await view(ref)).status, 'initialized');
    });

    test('an unknown reference is recorded and ignored', async () => {
      assert.equal((await apply(`charge.success:${suffix}-3`, `itest_${suffix}_nope`, 'success', 5100)).reason, 'unknown_reference');
    });

    test('a correct success event marks it paid, updates the order and releases the token', async () => {
      const r = await apply(`charge.success:${suffix}-4`, ref, 'success', 5100);
      assert.equal(r.applied, true);
      assert.equal((await admin.query(`SELECT status FROM orders WHERE id = $1`, [orderId])).rows[0].status, 'paid');
      const v = await view(ref);
      assert.equal(v.status, 'paid');
      assert.match(v.transaction_token, /^[0-9a-f-]{36}$/);
      assert.ok((await admin.query(`SELECT 1 FROM notifications WHERE order_id = $1 AND person_id = $2`, [orderId, A.owner])).rowCount === 1, 'owner is told about the payment');
    });

    test('redelivered and later events change nothing (idempotent), one token only', async () => {
      assert.equal((await apply(`charge.success:${suffix}-4`, ref, 'success', 5100)).reason, 'duplicate_event');
      assert.equal((await apply(`charge.success:${suffix}-5`, ref, 'success', 5100)).reason, 'already_paid');
      assert.equal((await admin.query(`SELECT count(*)::int AS n FROM transaction_tokens WHERE order_id = $1`, [orderId])).rows[0].n, 1);
    });

    test('a failed or abandoned event cannot un-pay a paid payment, but does fail an unpaid one', async () => {
      assert.equal((await apply(`charge.failed:${suffix}-6`, ref, 'failed', 5100)).applied, false);
      assert.equal((await view(ref)).status, 'paid');
      const r2 = await checkout([{ material_id: A.material, quantity: 1 }], ref2);
      assert.equal(r2.ok, true);
      assert.equal((await apply(`charge.failed:${suffix}-7`, ref2, 'failed', Number(r2.amount_minor))).applied, true);
      assert.equal((await view(ref2)).status, 'failed');
    });
  });
}
