import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { checkPasswordStrength } from '../lib/password.js';
import { generateToken, hashToken, looksLikeToken, safeEqual } from '../lib/tokens.js';
import { lockoutSecondsFor } from '../lib/lockout.js';
import { normalizeEmail, normalizePhone, cleanText, isUuid, isBusinessCategory } from '../lib/validate.js';
import { RateLimiter } from '../lib/rateLimit.js';
import { buildCsp, securityHeaders, parseCookies, serializeSessionCookie, clearSessionCookie } from '../lib/http.js';
import {
  parseFrom, readEmailConfig, sendEmail, verifyEmailMessage, handoffWaitingMessage, escapeHtml, emailEnabled,
} from '../lib/email.js';
import { checkEnvironment } from '../lib/env.js';
import { buildTsQuery } from '../lib/guideSearch.js';
import { inferRegion } from '../lib/regionInference.js';
import { detectEscalation, extractHandoffMarker, shouldEscalate } from '../lib/escalation.js';
import {
  verifyPaystackSignature, toMinorUnits, mapPaystackStatus, eventKeyFor, newReference,
} from '../lib/paystack.js';
import { normalizeEmbeddingDimension, EmbeddingDimensionError } from '../lib/embeddings.js';

describe('password policy', () => {
  test('rejects short, common and sequential passwords', () => {
    assert.equal(checkPasswordStrength('short1A!').ok, false);
    assert.equal(checkPasswordStrength('password123').ok, false);
    assert.equal(checkPasswordStrength('aaaaaaaaaaaa').ok, false);
    assert.equal(checkPasswordStrength('abcdefghijkl').ok, false);
    assert.equal(checkPasswordStrength('1234567890').ok, false);
  });
  test('accepts a mixed password and a long passphrase', () => {
    assert.equal(checkPasswordStrength('Tr1cky-Harvest#9').ok, true);
    assert.equal(checkPasswordStrength('correct horse battery staple').ok, true);
  });
  test('rejects 10-char single-class passwords', () => {
    assert.equal(checkPasswordStrength('abcdefghij').ok, false);
  });
  test('rejects passwords containing the email name or the person name', () => {
    assert.equal(checkPasswordStrength('Kwame-Mensah-99!', { email: 'kwame.mensah@example.com' }).ok, false);
    assert.equal(checkPasswordStrength('Ama-Serwaa-2024!x', { name: 'Ama Serwaa' }).ok, false);
  });
  test('rejects anything over 72 bytes because bcrypt would truncate it', () => {
    const long = 'Aa1!' + 'x'.repeat(80);
    const res = checkPasswordStrength(long);
    assert.equal(res.ok, false);
    assert.match(res.problems.join(' '), /72/);
  });
  test('non-strings are rejected', () => {
    assert.equal(checkPasswordStrength(undefined).ok, false);
    assert.equal(checkPasswordStrength(12345678901).ok, false);
  });
});

describe('tokens', () => {
  test('generated tokens are url-safe, long and unique', () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
    assert.equal(looksLikeToken(a), true);
    assert.match(a, /^[A-Za-z0-9_-]+$/);
    assert.ok(a.length >= 43);
  });
  test('hash is deterministic, hex, and not the token', () => {
    const t = generateToken();
    assert.equal(hashToken(t), hashToken(t));
    assert.match(hashToken(t), /^[0-9a-f]{64}$/);
    assert.notEqual(hashToken(t), t);
  });
  test('known SHA-256 vector', () => {
    assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('looksLikeToken rejects junk', () => {
    assert.equal(looksLikeToken('short'), false);
    assert.equal(looksLikeToken("x'; DROP TABLE people;--" + 'a'.repeat(40)), false);
    assert.equal(looksLikeToken(null), false);
  });
  test('safeEqual', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
  });
});

describe('login lockout schedule', () => {
  test('no lock below the threshold', () => {
    for (const n of [0, 1, 2, 3, 4]) assert.equal(lockoutSecondsFor(n), 0);
  });
  test('doubles from 30s and caps at 15 minutes', () => {
    assert.equal(lockoutSecondsFor(5), 30);
    assert.equal(lockoutSecondsFor(6), 60);
    assert.equal(lockoutSecondsFor(7), 120);
    assert.equal(lockoutSecondsFor(8), 240);
    assert.equal(lockoutSecondsFor(9), 480);
    assert.equal(lockoutSecondsFor(10), 900);
    assert.equal(lockoutSecondsFor(500), 900);
  });
  test('garbage input never locks forever', () => {
    assert.equal(lockoutSecondsFor(NaN), 0);
    assert.equal(lockoutSecondsFor(Infinity), 0);
  });
});

describe('validators', () => {
  test('normalizeEmail', () => {
    assert.equal(normalizeEmail('  Kwame@Example.COM '), 'kwame@example.com');
    assert.equal(normalizeEmail('no-at-sign'), null);
    assert.equal(normalizeEmail('a b@example.com'), null);
    assert.equal(normalizeEmail('x@y'), null);
    assert.equal(normalizeEmail(42), null);
    assert.equal(normalizeEmail('a'.repeat(250) + '@x.com'), null);
  });
  test('normalizePhone: Ghana formats', () => {
    assert.equal(normalizePhone('024 123 4567'), '+233241234567');
    assert.equal(normalizePhone('0241234567'), '+233241234567');
    assert.equal(normalizePhone('233241234567'), '+233241234567');
    assert.equal(normalizePhone('+233 24 123 4567'), '+233241234567');
    assert.equal(normalizePhone('(0551) 234-567'), '+233551234567');
    assert.equal(normalizePhone('0312345678'), '+233312345678');
  });
  test('normalizePhone: international and invalid', () => {
    assert.equal(normalizePhone('+44 7911 123456'), '+447911123456');
    assert.equal(normalizePhone('0044 7911 123456'), '+447911123456');
    assert.equal(normalizePhone('0141234567'), null); // 01x is not a Ghana prefix
    assert.equal(normalizePhone('12345'), null);
    assert.equal(normalizePhone('+233 94 123 4567'), null);
    assert.equal(normalizePhone('abc'), null);
    assert.equal(normalizePhone(undefined), null);
  });
  test('cleanText strips control chars and enforces length', () => {
    assert.equal(cleanText('  hello\u0000 world  ', 50), 'hello world');
    assert.equal(cleanText('', 50), null);
    assert.equal(cleanText('x'.repeat(51), 50), null);
    assert.equal(cleanText(null, 50), null);
  });
  test('uuid + category', () => {
    assert.equal(isUuid('123e4567-e89b-12d3-a456-426614174000'), true);
    assert.equal(isUuid('nope'), false);
    assert.equal(isBusinessCategory('food'), true);
    assert.equal(isBusinessCategory('hacking'), false);
  });
});

describe('RateLimiter', () => {
  test('allows up to max then blocks with a retry hint', () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 3 });
    const t0 = 1_000_000;
    assert.equal(rl.check('ip', t0).allowed, true);
    assert.equal(rl.check('ip', t0 + 1).allowed, true);
    const third = rl.check('ip', t0 + 2);
    assert.equal(third.allowed, true);
    assert.equal(third.remaining, 0);
    const fourth = rl.check('ip', t0 + 3);
    assert.equal(fourth.allowed, false);
    assert.ok(fourth.retryAfterSec >= 1);
  });
  test('window slides: allowed again after expiry', () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 1 });
    assert.equal(rl.check('k', 0).allowed, true);
    assert.equal(rl.check('k', 500).allowed, false);
    assert.equal(rl.check('k', 1001).allowed, true);
  });
  test('keys are independent', () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 1 });
    assert.equal(rl.check('a', 0).allowed, true);
    assert.equal(rl.check('b', 0).allowed, true);
    assert.equal(rl.check('a', 1).allowed, false);
  });
  test('memory is bounded by maxKeys', () => {
    const rl = new RateLimiter({ windowMs: 60_000, max: 5, maxKeys: 100 });
    for (let i = 0; i < 1000; i++) rl.check('ip-' + i, i);
    assert.ok(rl.size() <= 100, `size was ${rl.size()}`);
  });
  test('a blocked caller does not extend its own block', () => {
    const rl = new RateLimiter({ windowMs: 1000, max: 1 });
    rl.check('k', 0);
    for (let t = 1; t < 900; t += 100) rl.check('k', t);
    assert.equal(rl.check('k', 1001).allowed, true);
  });
});

describe('http security helpers', () => {
  test('CSP blocks framing, third-party scripts and foreign connections', () => {
    const csp = buildCsp();
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*https:/);
    assert.doesNotMatch(csp, /fonts\.(googleapis|gstatic)/, 'pages use the system font stack; no third-party font hosts');
    assert.doesNotMatch(csp, /style-src[^;]*https:/);
  });
  test('HSTS only in production', () => {
    assert.equal('Strict-Transport-Security' in securityHeaders(false), false);
    assert.equal('Strict-Transport-Security' in securityHeaders(true), true);
    assert.equal(securityHeaders(true)['X-Content-Type-Options'], 'nosniff');
  });
  test('session cookie flags', () => {
    const c = serializeSessionCookie('tok.en', 3600, true);
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Secure/);
    assert.match(c, /Max-Age=3600/);
    assert.doesNotMatch(serializeSessionCookie('t', 10, false), /Secure/);
  });
  test('clear cookie expires immediately', () => {
    assert.match(clearSessionCookie(true), /Max-Age=0/);
  });
  test('parseCookies', () => {
    assert.deepEqual(parseCookies('a=1; ebos_session=abc%20def; b=2'), { a: '1', ebos_session: 'abc def', b: '2' });
    assert.deepEqual(parseCookies(undefined), {});
  });
});

describe('email', () => {
  const base = { EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'key_x', EMAIL_FROM: 'e-BOS <no-reply@example.com>' };
  test('config: production refuses the log provider', () => {
    assert.equal(readEmailConfig({ NODE_ENV: 'production', EMAIL_PROVIDER: 'log' } as NodeJS.ProcessEnv).provider, 'none');
    assert.equal(readEmailConfig({ NODE_ENV: 'development', EMAIL_PROVIDER: 'log' } as NodeJS.ProcessEnv).provider, 'log');
  });
  test('config: provider without key or from is treated as disabled', () => {
    assert.equal(emailEnabled({ EMAIL_PROVIDER: 'resend' } as NodeJS.ProcessEnv), false);
    assert.equal(emailEnabled(base as NodeJS.ProcessEnv), true);
  });
  test('parseFrom', () => {
    assert.deepEqual(parseFrom('e-BOS <no-reply@example.com>'), { name: 'e-BOS', email: 'no-reply@example.com' });
    assert.deepEqual(parseFrom('no-reply@example.com'), { name: null, email: 'no-reply@example.com' });
    assert.deepEqual(parseFrom('"My Co, Ltd" <a@b.co>'), { name: 'My Co, Ltd', email: 'a@b.co' });
  });
  test('resend request shape', async () => {
    let seen: { url: string; init: Record<string, unknown> } | null = null;
    const res = await sendEmail(verifyEmailMessage('x@y.com', 'Ama', 'https://app.example/#verify=abc'), base as NodeJS.ProcessEnv,
      async (url, init) => { seen = { url, init: init ?? {} }; return { ok: true, status: 200, text: async () => '{}' }; });
    assert.equal(res.sent, true);
    assert.equal(seen!.url, 'https://api.resend.com/emails');
    assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer key_x');
    const body = JSON.parse(seen!.init.body as string);
    assert.deepEqual(body.to, ['x@y.com']);
    assert.match(body.text, /verify=abc/);
  });
  test('brevo request shape', async () => {
    let seen: { url: string; init: Record<string, unknown> } | null = null;
    const env = { EMAIL_PROVIDER: 'brevo', EMAIL_API_KEY: 'bk', EMAIL_FROM: 'e-BOS <no-reply@example.com>' } as NodeJS.ProcessEnv;
    const res = await sendEmail(verifyEmailMessage('x@y.com', 'Ama', 'https://l'), env,
      async (url, init) => { seen = { url, init: init ?? {} }; return { ok: true, status: 201, text: async () => '{}' }; });
    assert.equal(res.sent, true);
    assert.equal(seen!.url, 'https://api.brevo.com/v3/smtp/email');
    assert.equal((seen!.init.headers as Record<string, string>)['api-key'], 'bk');
    const body = JSON.parse(seen!.init.body as string);
    assert.deepEqual(body.sender, { name: 'e-BOS', email: 'no-reply@example.com' });
    assert.deepEqual(body.to, [{ email: 'x@y.com' }]);
  });
  test('provider errors are reported, never thrown, and never include the API key', async () => {
    const res = await sendEmail(verifyEmailMessage('x@y.com', 'Ama', 'https://l'), base as NodeJS.ProcessEnv,
      async () => ({ ok: false, status: 401, text: async () => 'unauthorized' }));
    assert.equal(res.sent, false);
    assert.doesNotMatch(JSON.stringify(res), /key_x/);
    const thrown = await sendEmail(verifyEmailMessage('x@y.com', 'Ama', 'https://l'), base as NodeJS.ProcessEnv,
      async () => { throw new Error('network down'); });
    assert.equal(thrown.sent, false);
  });
  test('unconfigured email does not pretend to send', async () => {
    const res = await sendEmail(verifyEmailMessage('x@y.com', 'Ama', 'https://l'), {} as NodeJS.ProcessEnv);
    assert.equal(res.sent, false);
  });
  test('templates escape HTML in names and business names', () => {
    const m = verifyEmailMessage('x@y.com', '<script>alert(1)</script>', 'https://l');
    assert.doesNotMatch(m.html, /<script>/);
    const h = handoffWaitingMessage('x@y.com', 'A', '<b>Evil</b>', 'pricing', 'https://l');
    assert.doesNotMatch(h.html, /<b>Evil<\/b>/);
    assert.equal(escapeHtml(`"'<>&`), '&quot;&#39;&lt;&gt;&amp;');
  });
});

describe('startup environment validation', () => {
  const good = {
    NODE_ENV: 'production',
    JWT_SECRET: 'x'.repeat(48),
    CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    APP_DATABASE_URL: 'postgres://app_login:s3cret@db:5432/x',
    PUBLIC_DATABASE_URL: 'postgres://app_public_login:s3cret2@db:5432/x',
    APP_BASE_URL: 'https://ebos.example.com',
    EMAIL_PROVIDER: 'resend', EMAIL_API_KEY: 'k', EMAIL_FROM: 'a@b.co',
  } as NodeJS.ProcessEnv;
  const errors = (env: NodeJS.ProcessEnv) => checkEnvironment(env).filter((p) => p.level === 'error').map((p) => p.variable);

  test('a correct production config has no errors', () => {
    assert.deepEqual(errors(good), []);
  });
  test('weak or placeholder JWT secret is an error in production', () => {
    assert.ok(errors({ ...good, JWT_SECRET: 'short' }).includes('JWT_SECRET'));
    assert.ok(errors({ ...good, JWT_SECRET: 'dev_only_jwt_secret_change_in_production_xxxxxxxx' }).includes('JWT_SECRET'));
  });
  test('encryption key must be 32 bytes and differ from JWT secret', () => {
    assert.ok(errors({ ...good, CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') }).includes('CREDENTIAL_ENCRYPTION_KEY'));
    assert.ok(errors({ ...good, JWT_SECRET: good.CREDENTIAL_ENCRYPTION_KEY }).includes('CREDENTIAL_ENCRYPTION_KEY'));
  });
  test('missing encryption key: error in production, warning in development', () => {
    const noKey = { ...good, CREDENTIAL_ENCRYPTION_KEY: '' } as NodeJS.ProcessEnv;
    assert.ok(errors(noKey).includes('CREDENTIAL_ENCRYPTION_KEY'));
    const dev = checkEnvironment({ ...noKey, NODE_ENV: 'development', APP_BASE_URL: '' } as NodeJS.ProcessEnv);
    assert.equal(dev.filter((p) => p.level === 'error').length, 0);
  });
  test('default database role password is an error in production', () => {
    assert.ok(errors({ ...good, APP_DATABASE_URL: 'postgres://app_login:change_me_in_production@db/x' }).includes('APP_DATABASE_URL'));
  });
  test('APP_BASE_URL must be https in production; wildcard CORS is refused', () => {
    assert.ok(errors({ ...good, APP_BASE_URL: 'http://ebos.example.com' }).includes('APP_BASE_URL'));
    assert.ok(errors({ ...good, ALLOWED_ORIGIN: '*' }).includes('ALLOWED_ORIGIN'));
  });
  test('email provider rules', () => {
    assert.ok(errors({ ...good, EMAIL_API_KEY: '' }).includes('EMAIL_API_KEY'));
    assert.ok(errors({ ...good, EMAIL_PROVIDER: 'log' }).includes('EMAIL_PROVIDER'));
    assert.ok(errors({ ...good, EMAIL_PROVIDER: 'carrier-pigeon' }).includes('EMAIL_PROVIDER'));
  });
  test('Paystack key shape', () => {
    assert.ok(errors({ ...good, PAYSTACK_SECRET_KEY: 'pk_live_abc' }).includes('PAYSTACK_SECRET_KEY'));
    assert.deepEqual(errors({ ...good, PAYSTACK_SECRET_KEY: 'sk_test_abc123' }), []);
  });
  test('messages never echo secret values', () => {
    const text = JSON.stringify(checkEnvironment({ ...good, JWT_SECRET: 'supersecretvalue', CREDENTIAL_ENCRYPTION_KEY: 'zzzz' }));
    assert.doesNotMatch(text, /supersecretvalue|zzzz/);
  });
});

describe('guide search query builder', () => {
  test('drops stop words, dedupes, ORs terms', () => {
    assert.equal(buildTsQuery('Do you deliver to Kumasi? Kumasi delivery'), 'deliver | kumasi | delivery');
  });
  test('cannot inject tsquery syntax', () => {
    const q = buildTsQuery("coconut' & !(oil) | <-> :* ; DROP TABLE x");
    assert.match(q, /^[a-z0-9 |]+$/);
    assert.doesNotMatch(q, /[&!()<>:*';]/);
  });
  test('empty and stop-word-only input gives an empty query', () => {
    assert.equal(buildTsQuery('what is the'), '');
    assert.equal(buildTsQuery(''), '');
  });
  test('caps the number of terms', () => {
    const many = Array.from({ length: 50 }, (_, i) => 'word' + i).join(' ');
    assert.equal(buildTsQuery(many).split(' | ').length, 12);
  });
});

describe('region inference', () => {
  const labels = ['Greater Accra', 'Ashanti', 'Northern'];
  test('direct label match', () => {
    assert.equal(inferRegion("I'm based in Greater Accra", labels), 'Greater Accra');
  });
  test('town implies registered region', () => {
    assert.equal(inferRegion('Can you deliver to Kumasi?', labels), 'Ashanti');
    assert.equal(inferRegion('I live near Tema', labels), 'Greater Accra');
    assert.equal(inferRegion('tamale please', labels), 'Northern');
  });
  test('never invents a label that is not registered', () => {
    assert.equal(inferRegion('I am in Takoradi', labels), null);
    assert.equal(inferRegion('Kumasi', []), null);
  });
  test('ambiguous short place names need a place word', () => {
    assert.equal(inferRegion('ho ho ho what a deal', ['Volta']), null);
    assert.equal(inferRegion('we are in Ho', ['Volta']), 'Volta');
    assert.equal(inferRegion('wa wa wa', ['Upper West']), null);
  });
  test('label matching is whole-word', () => {
    assert.equal(inferRegion('ashantiland', ['Ashanti']), null);
  });
  test('prefers the longest matching label', () => {
    assert.equal(inferRegion('upper east region please', ['East', 'Upper East']), 'Upper East');
  });
});

describe('escalation detection', () => {
  test('visitor asks for a person', () => {
    for (const t of ['Can I speak to a human?', 'let me talk with someone please', 'I want a real person', 'connect me to the manager']) {
      assert.equal(detectEscalation(t), 'visitor_requested', t);
    }
  });
  test('complaints', () => {
    for (const t of ['I want a refund', 'this is a scam', 'my order never arrived', 'item was damaged']) {
      assert.equal(detectEscalation(t), 'complaint', t);
    }
  });
  test('pricing / negotiation', () => {
    for (const t of ['any discount for bulk orders?', 'can we negotiate', 'I need a custom quote', 'wholesale price?']) {
      assert.equal(detectEscalation(t), 'pricing', t);
    }
  });
  test('ordinary questions do not escalate', () => {
    for (const t of ['What are your opening hours?', 'Do you sell coconut oil?', 'hello', 'How much is the cocoa butter?']) {
      assert.equal(detectEscalation(t), null, t);
    }
  });
  test('a request for a human outranks a complaint', () => {
    assert.equal(detectEscalation('this is terrible, let me speak to a manager'), 'visitor_requested');
  });
  test('marker extraction strips the marker and validates the reason', () => {
    const r = extractHandoffMarker("I'm not sure about that. [[HANDOFF:low_confidence]]");
    assert.equal(r.reason, 'low_confidence');
    assert.equal(r.text, "I'm not sure about that.");
    const bad = extractHandoffMarker('Hello [[HANDOFF:drop_all_tables]] there');
    assert.equal(bad.reason, null);
    assert.doesNotMatch(bad.text, /HANDOFF/);
    assert.equal(extractHandoffMarker('plain reply').reason, null);
  });
  test('settings gate everything except an explicit request for a human', () => {
    assert.equal(shouldEscalate('pricing', false), false);
    assert.equal(shouldEscalate('complaint', false), false);
    assert.equal(shouldEscalate('low_confidence', false), false);
    assert.equal(shouldEscalate('visitor_requested', false), true);
    assert.equal(shouldEscalate('pricing', true), true);
  });
});

describe('Paystack', () => {
  test('HMAC-SHA512 matches the published test vector (independent of the implementation)', () => {
    const key = 'key';
    const msg = 'The quick brown fox jumps over the lazy dog';
    const vector = 'b42af09057bac1e2d41708e48a902e09b5ff7f12ab428a4fe86653c73dd248fb82f948a549f7b791a5b41915ee4d1ec3935357e4e2317250d0372afa2ebeeb3a';
    assert.equal(createHmac('sha512', key).update(msg).digest('hex'), vector);
    assert.equal(verifyPaystackSignature(msg, vector, key), true);
  });
  test('signature verification rejects tampering and absence', () => {
    const body = Buffer.from('{"event":"charge.success","data":{"id":1}}');
    const sig = createHmac('sha512', 'sk_test_abc').update(body).digest('hex');
    assert.equal(verifyPaystackSignature(body, sig, 'sk_test_abc'), true);
    assert.equal(verifyPaystackSignature(Buffer.from(body.toString() + ' '), sig, 'sk_test_abc'), false);
    assert.equal(verifyPaystackSignature(body, sig, 'sk_test_other'), false);
    assert.equal(verifyPaystackSignature(body, undefined, 'sk_test_abc'), false);
    assert.equal(verifyPaystackSignature(body, 'deadbeef', 'sk_test_abc'), false);
    assert.equal(verifyPaystackSignature(body, sig, ''), false);
  });
  test('toMinorUnits is exact', () => {
    assert.equal(toMinorUnits('12.50'), 1250n);
    assert.equal(toMinorUnits('0.1'), 10n);
    assert.equal(toMinorUnits('100'), 10000n);
    assert.equal(toMinorUnits(19.99), 1999n);
    assert.equal(toMinorUnits('0.07'), 7n);
  });
  test('toMinorUnits rejects ambiguous or hostile input', () => {
    for (const bad of ['1.234', '-5', '1e3', '', 'abc', '1,000.00', '12345678901234.00']) {
      assert.throws(() => toMinorUnits(bad), /invalid amount/, bad);
    }
  });
  test('status mapping', () => {
    assert.equal(mapPaystackStatus('success'), 'success');
    assert.equal(mapPaystackStatus('FAILED'), 'failed');
    assert.equal(mapPaystackStatus('abandoned'), 'abandoned');
    assert.equal(mapPaystackStatus('ongoing'), 'other');
    assert.equal(mapPaystackStatus(undefined), 'other');
  });
  test('event keys are stable across retries and absent when unidentifiable', () => {
    assert.equal(eventKeyFor({ event: 'charge.success', data: { id: 302961 } }), 'charge.success:302961');
    assert.equal(eventKeyFor({ event: 'charge.success' }), null);
    assert.equal(eventKeyFor({}), null);
  });
  test('references are unique and well-formed', () => {
    const a = newReference();
    assert.match(a, /^ebos_[0-9a-f]{32}$/);
    assert.notEqual(a, newReference());
  });
});

describe('embedding dimension handling', () => {
  test('exact size passes through', () => {
    const v = new Array(1536).fill(0.1);
    assert.equal(normalizeEmbeddingDimension(v).length, 1536);
  });
  test('shorter vectors are zero-padded without changing cosine similarity', () => {
    const a = [0.2, 0.4, 0.1];
    const b = [0.3, 0.1, 0.9];
    const cos = (x: number[], y: number[]) => {
      const dot = x.reduce((s, xi, i) => s + xi * y[i], 0);
      return dot / (Math.hypot(...x) * Math.hypot(...y));
    };
    const pa = normalizeEmbeddingDimension(a);
    const pb = normalizeEmbeddingDimension(b);
    assert.equal(pa.length, 1536);
    assert.ok(Math.abs(cos(a, b) - cos(pa, pb)) < 1e-12);
  });
  test('longer vectors and bad values are refused', () => {
    assert.throws(() => normalizeEmbeddingDimension(new Array(3072).fill(0.1)), EmbeddingDimensionError);
    assert.throws(() => normalizeEmbeddingDimension([]), EmbeddingDimensionError);
    assert.throws(() => normalizeEmbeddingDimension([NaN, 1]), EmbeddingDimensionError);
  });
});
