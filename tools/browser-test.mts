/**
 * REAL-BROWSER tests for the two frontend files, against a FAKE API.
 *
 * What this is: Chromium (via Playwright) loads e-bos-landing.html and
 * e-bos-backoffice.html from a tiny local server that also impersonates the
 * e-BOS API in memory. The browser really renders the pages, runs their
 * JavaScript, fills forms, clicks buttons, follows redirects and honours
 * cookies and the Content Security Policy.
 *
 * What this is NOT: a test of the real backend. The fake API implements the
 * response shapes documented in backend/src/routes/*.ts (it is only as
 * faithful as that reading), so a pass here means "the frontends do the
 * right thing given those responses", not "the deployed system works".
 * Android is EMULATED (Pixel 5 viewport and user agent in Chromium); this is
 * not a real device and not Opera/Firefox/Safari.
 *
 * Run (from backend/, where tsx lives), after installing Playwright once:
 *     npm i --no-save playwright && npx playwright install chromium
 *     npx tsx --test ../tools/browser-test.mts
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from '../backend/src/lib/http.js';

const { chromium, devices } = await import('playwright');
const here = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(here, '../frontend');

// ------------------------------------------------------------------ fake API
interface Logged { method: string; url: string; headers: http.IncomingHttpHeaders; body: any }
const COOKIE = 'ebos_session';
const GOOD_PASSWORD = 'Correct-Horse-9';
const VERIFY_TOKEN = 'v'.repeat(43);
const RESET_TOKEN = 'r'.repeat(43);
const TXN_TOKEN = '11111111-1111-4111-8111-111111111111';
const PAY_REF = 'ebos_testref_0001';

const STREAM = [
  { id: 'm1', name: 'Sourdough loaf', businessId: 'b1', businessName: 'Hearth & Vine Bakery', category: 'food', icon: '🍞', rating: null,
    sales: 120, repeatCustomers: 40, size: 1, visibilityWeight: 1, description: 'Daily loaf', price: 25.5, currency: 'GHS', media: { image: null, video: null } },
  { id: 'm9', name: 'Custom cake', businessId: 'b1', businessName: 'Hearth & Vine Bakery', category: 'food', icon: '🎂', rating: null,
    sales: 30, repeatCustomers: 9, size: 1, visibilityWeight: 1, description: 'Made to order', price: null, currency: 'GHS', media: { image: null, video: null } },
];

function freshState() {
  return {
    paymentsEnabled: true,
    stream: STREAM,
    businesses: [{ id: 'b1', name: 'Hearth & Vine Bakery' }] as any[],
    log: [] as Logged[],
    signups: [] as any[],
    materials: [
      { id: 'm1', businessId: 'b1', name: 'Sourdough loaf', stage: 'finished', unit: 'loaf', publishedToStream: true,
        catalogMeta: { icon: '🍞', category: 'food', description: 'Daily loaf', price: 25.5, currency: 'GHS' } },
      { id: 'm2', businessId: 'b1', name: 'Flour', stage: 'raw', unit: 'kg', publishedToStream: false, catalogMeta: null },
    ] as any[],
    people: [
      { id: 'p1', name: 'Test Owner', role: 'owner', email: 'owner@test.example' },
      { id: 'p2', name: 'Kofi Worker', role: 'worker', email: 'kofi@test.example' },
    ] as any[],
    partnerships: [] as any[],
    notifications: [
      { id: '22222222-2222-4222-8222-222222222222', businessId: 'b1', kind: 'handoff_waiting', conversationId: 'c-old',
        title: 'A customer is waiting for a person', body: 'Reason: pricing', createdAt: new Date().toISOString(), read: false },
    ] as any[],
    aiSettings: { retrievalDepth: 8, autoEscalation: true },
    convs: new Map<string, any>(),
    redeemed: [] as any[],
    checkouts: [] as any[],
    nextId: 1,
  };
}
let S = freshState();


function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function cookieOf(req: http.IncomingMessage): string | null {
  const m = new RegExp(`${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}

function sessionCookie(token: string) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200`;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://x');
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  let body: any = undefined;
  try { body = raw ? JSON.parse(raw) : undefined; } catch { /* not json */ }
  const p = url.pathname;
  const m = req.method ?? 'GET';
  S.log.push({ method: m, url: req.url ?? '', headers: req.headers, body });

  // ---- static files, with the REAL security headers
  if (m === 'GET' && (p === '/' || p === '/e-bos-landing.html' || p === '/e-bos-backoffice.html')) {
    const file = p === '/e-bos-backoffice.html' ? 'e-bos-backoffice.html' : 'e-bos-landing.html';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...securityHeaders(false) });
    res.end(fs.readFileSync(path.join(FRONTEND, file)));
    return;
  }

  // ---- the fake payment page: Paystack would redirect back like this
  if (m === 'GET' && p === '/fake-paystack') {
    res.writeHead(302, { Location: `/#paid=${url.searchParams.get('ref')}` });
    res.end();
    return;
  }

  // ---- public storefront
  if (m === 'GET' && p === '/product-stream') return json(res, 200, { items: S.stream });
  if (m === 'POST' && p === '/product-stream/overview') return json(res, 200, { overview: 'A fine product.' });
  if (m === 'POST' && p === '/product-stream/search') return json(res, 200, { ids: [] });
  if (m === 'GET' && p === '/checkout/config') return json(res, 200, { enabled: S.paymentsEnabled, provider: 'paystack' });

  if (m === 'POST' && p === '/conversations') {
    const n = S.nextId++;
    const conv = { id: `c-${n}`, businessId: body.businessId, kind: 'consumer', identified: false, handledBy: 'ai',
      visitorDisplayName: body.visitorDisplayName ?? null, subject: body.subject ?? null, createdAt: new Date().toISOString(), lastMessageAt: new Date().toISOString() };
    const message = { id: `msg-${n}`, conversationId: conv.id, senderType: 'visitor', body: body.message, createdAt: new Date().toISOString() };
    S.convs.set(conv.id, { conv, messages: [message], token: `vt-${n}` });
    return json(res, 201, { visitorToken: `vt-${n}`, conversation: conv, message });
  }
  let mm = /^\/conversations\/(c-\d+)(?:\/(messages|ai-reply|identify|redeem-token))?$/.exec(p);
  if (mm) {
    const rec = S.convs.get(mm[1]);
    if (!rec || req.headers['x-visitor-token'] !== rec.token) return json(res, 404, { error: 'not_found' });
    if (m === 'GET' && !mm[2]) return json(res, 200, { conversation: rec.conv, messages: rec.messages });
    if (m === 'POST' && mm[2] === 'messages') {
      const msg = { id: `msg-${rec.messages.length + 1}`, conversationId: rec.conv.id, senderType: 'visitor', body: body.message, createdAt: new Date().toISOString() };
      rec.messages.push(msg);
      return json(res, 201, msg);
    }
    if (m === 'POST' && mm[2] === 'ai-reply') return json(res, 201, { handoff: { requested: false }, body: 'Hello!' });
    if (m === 'POST' && mm[2] === 'identify') { rec.conv.identified = true; return json(res, 200, { identified: true }); }
    if (m === 'POST' && mm[2] === 'redeem-token') {
      S.redeemed.push({ conversationId: rec.conv.id, token: body.transactionToken });
      rec.conv.handledBy = 'awaiting_human';
      return json(res, 200, { escalated: true });
    }
  }
  if (m === 'POST' && p === '/checkout') {
    const rec = S.convs.get(body.conversationId);
    if (!rec || req.headers['x-visitor-token'] !== rec.token) return json(res, 404, { error: 'conversation_not_found', message: 'Conversation not found' });
    if (!rec.conv.identified) return json(res, 409, { error: 'not_identified', message: 'Please share your name and email in the chat before buying.' });
    S.checkouts.push(body);
    return json(res, 201, { reference: PAY_REF, orderId: 'o-1', amountMinor: 5100, currency: 'GHS', authorizationUrl: `/fake-paystack?ref=${PAY_REF}` });
  }
  mm = /^\/checkout\/([A-Za-z0-9_-]+)\/verify$/.exec(p);
  if (m === 'POST' && mm) {
    return json(res, 200, { status: 'paid', orderId: 'o-1', conversationId: 'c-1', amountMinor: 5100, currency: 'GHS', transactionToken: TXN_TOKEN });
  }

  // ---- account flows
  if (m === 'POST' && p === '/auth/signup') {
    const b = body ?? {};
    const fields: Record<string, string> = {};
    if (!b.fullName || String(b.fullName).trim().length < 2) fields.fullName = 'Enter your full name.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(b.email ?? ''))) fields.email = 'Enter a valid email address.';
    if (!/^(\+|0)[0-9 ]{8,}$/.test(String(b.phone ?? ''))) fields.phone = 'Enter a valid phone number.';
    if (String(b.password ?? '').length < 10) fields.password = 'Use at least 10 characters.';
    if (!b.businessName) fields.businessName = 'Enter your business name.';
    if (!b.city) fields.city = 'Enter your city or town.';
    if (!b.address) fields.address = 'Enter your business address.';
    if (String(b.description ?? '').length < 10) fields.description = 'Describe your business (at least 10 characters).';
    if (Object.keys(fields).length > 0) return json(res, 400, { error: 'validation', message: 'Please correct the highlighted fields.', fields });
    S.signups.push(b);
    return json(res, 202, { status: 'check_email', message: 'If this email address can be registered, we have sent a confirmation link to it.' });
  }
  if (m === 'POST' && p === '/auth/resend-verification') return json(res, 202, { status: 'accepted', message: 'ok' });
  if (m === 'POST' && p === '/auth/verify-email') {
    return body?.token === VERIFY_TOKEN ? json(res, 200, { verified: true }) : json(res, 400, { error: 'invalid_token', message: 'invalid' });
  }
  if (m === 'POST' && p === '/auth/forgot-password') return json(res, 202, { status: 'accepted', message: 'If an account exists for that email address, we have sent it an email.' });
  if (m === 'POST' && p === '/auth/reset-password') {
    if (body?.token !== RESET_TOKEN) return json(res, 400, { error: 'invalid_token', message: 'invalid' });
    if (String(body?.password ?? '').length < 10) return json(res, 400, { error: 'weak_password', message: 'Use at least 10 characters.' });
    return json(res, 200, { reset: true });
  }
  if (m === 'POST' && p === '/auth/login') {
    const { email, password, holdingCompanyId } = body ?? {};
    const person = (hc: string) => ({ personId: 'p1', holdingCompanyId: hc, role: 'owner', email, name: 'Test Owner' });
    if (password !== GOOD_PASSWORD) return json(res, 401, { error: 'invalid_credentials', message: 'Invalid email or password' });
    if (email === 'unverified@test.example') return json(res, 403, { error: 'email_not_verified', message: 'Please confirm your email address first.' });
    if (email === 'multi@test.example' && !holdingCompanyId) {
      return json(res, 409, { error: 'choose_company', message: 'This email belongs to more than one company.',
        companies: [{ holdingCompanyId: 'hc1', name: 'Alpha Co' }, { holdingCompanyId: 'hc2', name: 'Beta Co' }] });
    }
    return json(res, 200, { token: 'jwt-for-api-clients', person: person(holdingCompanyId ?? 'hc1') }, { 'Set-Cookie': sessionCookie('sess-1') });
  }
  if (m === 'POST' && p === '/auth/logout') return json(res, 200, { loggedOut: true }, { 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });

  // ---- everything below needs the session cookie, like the real API
  const authed = cookieOf(req) === 'sess-1';
  if (!authed) return json(res, 401, { error: 'unauthorized', message: 'Missing or invalid token' });
  if (m !== 'GET' && !req.headers['x-ebos-client']) return json(res, 403, { error: 'csrf', message: 'Missing client header' });

  if (m === 'GET' && p === '/auth/session') return json(res, 200, { person: { personId: 'p1', holdingCompanyId: 'hc1', role: 'owner', email: 'owner@test.example' } });
  if (m === 'POST' && p === '/auth/logout-everywhere') return json(res, 200, { loggedOut: true, everywhere: true });
  if (m === 'GET' && p === '/businesses') return json(res, 200, S.businesses);
  if (m === 'POST' && p === '/businesses') {
    const biz = { id: `b${S.nextId++ + 1}`, name: body.name };
    S.businesses.push(biz);
    return json(res, 201, biz);
  }
  if (m === 'GET' && /^\/holding-companies\/[^/]+\/rollup$/.test(p)) return json(res, 200, { grandTotal: { totalDebits: '0', totalCredits: '0' }, businesses: [] });
  if (m === 'GET' && p === '/materials') return json(res, 200, S.materials);
  if (m === 'POST' && p === '/materials') {
    const mat = { id: `m${S.nextId++ + 100}`, businessId: body.businessId, name: body.name, stage: body.stage, unit: body.unit,
      catalogMeta: body.catalogMeta ?? null, publishedToStream: Boolean(body.catalogMeta) };
    S.materials.push(mat);
    return json(res, 201, mat);
  }
  mm = /^\/materials\/(m\d+)$/.exec(p);
  if (mm) {
    const mat = S.materials.find((x) => x.id === mm![1]);
    if (!mat) return json(res, 404, { error: 'not_found' });
    if (m === 'PATCH') {
      for (const k of ['name', 'unit', 'stage']) if (body[k] !== undefined) mat[k] = body[k];
      if (body.catalogMeta !== undefined) { mat.catalogMeta = body.catalogMeta; mat.publishedToStream = body.catalogMeta !== null; }
      return json(res, 200, mat);
    }
    if (m === 'DELETE') { S.materials = S.materials.filter((x) => x.id !== mat.id); res.writeHead(204); res.end(); return; }
  }
  if (m === 'GET' && (p === '/orders' || p === '/counterparties' || p === '/conversations' || p === '/ledger-entries' || p === '/allocation-rules')) return json(res, 200, []);
  if (m === 'GET' && p === '/allocation-rules/current') return json(res, 404, { error: 'not_found' });
  if (m === 'GET' && p === '/people/me/transaction-paths') return json(res, 200, []);
  if (m === 'GET' && p === '/people') return json(res, 200, S.people);
  if (m === 'POST' && p === '/people') {
    const person = { id: `p${S.nextId++ + 10}`, name: body.name, role: body.role, email: body.email };
    S.people.push(person);
    return json(res, 201, person);
  }
  mm = /^\/people\/([^/]+)\/invite$/.exec(p);
  if (m === 'POST' && mm) return json(res, 200, { invited: true });
  if (m === 'GET' && p === '/partnerships') return json(res, 200, S.partnerships);
  if (m === 'POST' && p === '/partnerships') {
    const row = { id: `ps${S.nextId++}`, businessId: body.businessId, personId: body.personId, ownershipPct: body.ownershipPct, capitalContributed: body.capitalContributed ?? 0 };
    S.partnerships.push(row);
    return json(res, 201, row);
  }
  if (m === 'GET' && p === '/notifications') {
    const unread = S.notifications.filter((n) => !n.read).length;
    return json(res, 200, { unreadCount: unread, items: S.notifications });
  }
  if (m === 'POST' && p === '/notifications/read') {
    for (const n of S.notifications) if (!body?.ids || body.ids.includes(n.id)) n.read = true;
    return json(res, 200, { marked: 1 });
  }
  mm = /^\/businesses\/([^/]+)\/ai-settings$/.exec(p);
  if (mm && m === 'GET') return json(res, 200, { businessId: mm[1], ...S.aiSettings, isDefault: false });
  if (mm && m === 'PUT') { Object.assign(S.aiSettings, body); return json(res, 200, { businessId: mm[1], ...S.aiSettings, isDefault: false }); }

  json(res, 404, { error: 'not_found', message: `fake API has no ${m} ${p}` });
}

// ------------------------------------------------------------------ harness
let server: http.Server;
let base = '';
let browser: Awaited<ReturnType<typeof chromium.launch>>;

before(async () => {
  server = http.createServer((req, res) => { handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); server?.close(); });

async function newPage(opts: { mobile?: boolean } = {}) {
  const context = await browser.newContext(opts.mobile ? { ...devices['Pixel 5'] } : { viewport: { width: 1280, height: 800 } });
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort()); // no internet in CI; the CSP still permits them
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/fonts\.|ERR_FAILED|Failed to load resource/i.test(t + m.location().url)) problems.push('console: ' + t);
    if (/Content Security Policy/i.test(t)) problems.push('CSP: ' + t);
  });
  page.on('dialog', (d) => { void d.accept(); });
  return { page, context, problems };
}

const calls = (pred: (l: Logged) => boolean) => S.log.filter(pred);

async function openDetailFor(page: Awaited<ReturnType<typeof newPage>>['page'], name: string | null): Promise<boolean> {
  // The stream is a moving canvas, so find a bubble the way a person would:
  // click around until the detail sheet opens. Several passes, because the
  // bubbles drift between passes.
  for (let pass = 0; pass < 4; pass++) {
    const box = await page.locator('canvas').first().boundingBox();
    if (!box) return false;
    for (let y = box.y + 40; y < box.y + box.height - 30; y += 34) {
      for (let x = box.x + 24; x < box.x + box.width - 24; x += 34) {
        await page.mouse.click(x, y);
        if (await page.locator('#detail-panel').isVisible()) {
          if (name === null || (await page.locator('#detail-name').textContent()) === name) return true;
          await page.keyboard.press('Escape');
          await page.waitForTimeout(60);
        }
      }
    }
    await page.waitForTimeout(700);
  }
  return false;
}

// ================================================================== LANDING
describe('landing page (desktop Chromium)', () => {
  test('loads under the real Content-Security-Policy with no script or CSP errors', async () => {
    S = freshState();
    const { page, context, problems } = await newPage();
    await page.goto(base + '/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(600);
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('registration: server-side validation errors appear next to the fields', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/');
    await page.click('#join-create-btn');
    await page.click('#jc-create');
    await page.waitForSelector('#modal-create:not(.hidden)');
    await page.fill('#create-fullname', 'Ama Serwaa');
    await page.fill('#create-password', 'short');
    await page.click('#create-submit');
    await page.waitForSelector('#err-password:not(:empty)');
    assert.match((await page.textContent('#err-password')) ?? '', /at least 10/i);
    assert.match((await page.textContent('#err-email')) ?? '', /valid email/i);
    assert.equal(await page.locator('#create-success').isVisible(), false, 'must not claim success');
    await context.close();
  });

  test('registration: a valid form posts every field and shows the check-your-email state', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/');
    await page.click('#join-create-btn');
    await page.click('#jc-create');
    await page.waitForSelector('#modal-create:not(.hidden)');
    await page.fill('#create-fullname', 'Ama Serwaa');
    await page.fill('#create-email', 'ama@example.com');
    await page.fill('#create-phone', '024 123 4567');
    await page.fill('#create-password', 'Tr1cky-Harvest#9');
    await page.fill('#create-name', 'Hearth & Vine Bakery');
    await page.selectOption('#create-category', 'food');
    await page.fill('#create-city', 'Accra');
    await page.fill('#create-address', '12 Oxford Street, Osu');
    await page.fill('#create-desc', 'We bake sourdough and pastries daily.');
    await page.click('#create-submit');
    await page.waitForSelector('#create-success:not(.hidden)');
    assert.match((await page.textContent('#create-success-text')) ?? '', /confirmation link/i);
    assert.equal(S.signups.length, 1);
    assert.deepEqual(
      Object.keys(S.signups[0]).sort(),
      ['address', 'businessName', 'category', 'city', 'country', 'description', 'email', 'fullName', 'password', 'phone'],
    );
    assert.equal(S.signups[0].country, 'Ghana');
    await context.close();
  });

  test('email link #verify=TOKEN confirms the address and removes the token from the URL', async () => {
    S = freshState();
    const { page, context, problems } = await newPage();
    await page.goto(`${base}/#verify=${VERIFY_TOKEN}`);
    await page.waitForSelector('#modal-status:not(.hidden)');
    await page.waitForFunction(() => /confirmed/i.test(document.getElementById('status-title')?.textContent ?? ''));
    assert.equal(new URL(page.url()).hash, '', 'token must not stay in the address bar');
    assert.equal(calls((l) => l.url === '/auth/verify-email').length, 1);
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('an invalid or reused #verify link says so instead of pretending', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(`${base}/#verify=${'x'.repeat(43)}`);
    await page.waitForFunction(() => /didn.?t work/i.test(document.getElementById('status-title')?.textContent ?? ''));
    await context.close();
  });

  test('email link #reset=TOKEN: weak password is refused, strong one is accepted', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(`${base}/#reset=${RESET_TOKEN}`);
    await page.waitForSelector('#reset-form:not(.hidden)');
    await page.fill('#reset-password', 'short');
    await page.click('#reset-submit');
    await page.waitForFunction(() => /at least 10/i.test(document.getElementById('reset-error')?.textContent ?? ''));
    await page.fill('#reset-password', 'A-Much-Better-Pass-42');
    await page.click('#reset-submit');
    await page.waitForFunction(() => /password changed/i.test(document.getElementById('status-title')?.textContent ?? ''));
    await context.close();
  });

  test('a priced item shows its price and the Buy button; checkout goes through Paystack and back, and hands the token to the chat', async () => {
    S = freshState();
    S.stream = STREAM.filter((i) => i.id === 'm1');
    const { page, context, problems } = await newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(base + '/');
    await page.waitForSelector('canvas');
    await page.waitForFunction(() => true);
    await page.waitForTimeout(500);
    assert.equal(await openDetailFor(page, 'Sourdough loaf'), true, 'could not open the Sourdough detail panel');
    assert.equal((await page.textContent('#detail-price'))?.trim(), 'GHS 25.50');
    assert.equal((await page.textContent('#detail-purchase'))?.trim(), 'Buy now');

    await page.click('#detail-purchase');
    await page.waitForSelector('#modal-checkout:not(.hidden)');
    await page.fill('#checkout-name', 'Esi Mensah');
    await page.fill('#checkout-email', 'esi@example.com');
    await page.fill('#checkout-qty', '2');
    assert.match((await page.textContent('#checkout-total')) ?? '', /GHS 51\.00/);

    await Promise.all([
      page.waitForURL(/#paid=/),
      page.click('#checkout-submit'),
    ]);
    await page.waitForFunction(() => /payment confirmed/i.test(document.getElementById('status-title')?.textContent ?? ''), null, { timeout: 8000 });
    assert.match((await page.textContent('#status-text')) ?? '', /team member has been notified/i);

    assert.equal(S.checkouts.length, 1);
    assert.deepEqual(S.checkouts[0].items, [{ materialId: 'm1', quantity: 2 }]);
    assert.ok(!('price' in S.checkouts[0].items[0]) && !('amount' in S.checkouts[0]), 'the browser must not send a price');
    assert.equal(S.redeemed.length, 1);
    assert.equal(S.redeemed[0].token, TXN_TOKEN);
    assert.equal(new URL(page.url()).hash, '');
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('with payments off, or no price, the button opens a real chat — never a fake "Added ✓"', async () => {
    S = freshState();
    S.stream = STREAM.filter((i) => i.id === 'm1');
    S.paymentsEnabled = false;
    const { page, context } = await newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(base + '/');
    await page.waitForSelector('canvas');
    await page.waitForTimeout(500);
    assert.equal(await openDetailFor(page, 'Sourdough loaf'), true);
    assert.equal((await page.textContent('#detail-purchase'))?.trim(), 'Ask to buy');
    await page.click('#detail-purchase');
    await page.waitForSelector('#chat-panel:not(.hidden)');
    assert.equal(await page.locator('#detail-purchase:has-text("Added")').count(), 0);
    await context.close();
  });

  test('the demo order code hint is gone', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/');
    assert.equal(await page.locator('text=DEMO-1234').count(), 0);
    await context.close();
  });
});

describe('landing page (emulated Android Chrome, Pixel 5)', () => {
  test('loads without errors and the registration form is reachable and does not overflow sideways', async () => {
    S = freshState();
    const { page, context, problems } = await newPage({ mobile: true });
    await page.goto(base + '/');
    await page.waitForSelector('canvas');
    await page.click('#join-create-btn');
    await page.click('#jc-create');
    await page.waitForSelector('#modal-create:not(.hidden)');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px`);
    const modalBox = await page.locator('#modal-create').boundingBox();
    assert.ok(modalBox && modalBox.width <= 390 + 1, 'registration dialog is wider than the phone screen');
    assert.deepEqual(problems, []);
    await context.close();
  });
});

// ================================================================== BACK OFFICE
async function signIn(page: Awaited<ReturnType<typeof newPage>>['page'], email = 'owner@test.example') {
  await page.goto(base + '/e-bos-backoffice.html');
  await page.fill('#login-email', email);
  await page.fill('#login-password', GOOD_PASSWORD);
  await page.click('#login-submit');
  await page.waitForSelector('#app-shell:not(.hidden)');
}

describe('back office sign-in', () => {
  test('there is no holding-company UUID field any more', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/e-bos-backoffice.html');
    assert.equal(await page.locator('#login-hc').count(), 0);
    await context.close();
  });

  test('a wrong password shows an error and does NOT reload the page', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/e-bos-backoffice.html');
    await page.evaluate(() => { (window as any).__marker = 'still-here'; });
    await page.fill('#login-email', 'owner@test.example');
    await page.fill('#login-password', 'wrong-password');
    await page.click('#login-submit');
    await page.waitForSelector('#login-error:not(.hidden)');
    assert.match((await page.textContent('#login-error')) ?? '', /invalid email or password/i);
    assert.equal(await page.evaluate(() => (window as any).__marker), 'still-here', 'page was reloaded');
    await context.close();
  });

  test('an unverified account is told so and can ask for a new email', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/e-bos-backoffice.html');
    await page.fill('#login-email', 'unverified@test.example');
    await page.fill('#login-password', GOOD_PASSWORD);
    await page.click('#login-submit');
    await page.waitForSelector('#login-resend:not(.hidden)');
    await page.click('#resend-btn');
    await page.waitForFunction(() => /on its way/i.test(document.getElementById('resend-msg')?.textContent ?? ''));
    assert.equal(calls((l) => l.url === '/auth/resend-verification').length, 1);
    await context.close();
  });

  test('an email that belongs to two companies gets a chooser, then signs in to the chosen one', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/e-bos-backoffice.html');
    await page.fill('#login-email', 'multi@test.example');
    await page.fill('#login-password', GOOD_PASSWORD);
    await page.click('#login-submit');
    await page.waitForSelector('#login-company:not(.hidden)');
    await page.click('#login-company-list button:has-text("Beta Co")');
    await page.waitForSelector('#app-shell:not(.hidden)');
    const last = calls((l) => l.url === '/auth/login').pop()!;
    assert.equal(last.body.holdingCompanyId, 'hc2');
    await context.close();
  });

  test('forgot-password sends the request and shows a neutral message', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.goto(base + '/e-bos-backoffice.html');
    await page.click('#forgot-link');
    await page.fill('#forgot-email', 'someone@example.com');
    await page.click('#forgot-submit');
    await page.waitForFunction(() => /if an account exists/i.test(document.getElementById('forgot-msg')?.textContent ?? ''));
    await context.close();
  });

  test('signing in uses an HttpOnly cookie; no token is kept in localStorage; writes carry the CSRF header', async () => {
    S = freshState();
    const { page, context, problems } = await newPage();
    await signIn(page);
    const stored = await page.evaluate(() => localStorage.getItem('ebos_auth'));
    assert.ok(stored && !/token/i.test(stored), 'localStorage must not hold a token: ' + stored);
    const cookies = await context.cookies();
    const session = cookies.find((c) => c.name === COOKIE);
    assert.ok(session, 'session cookie missing');
    assert.equal(session!.httpOnly, true);
    assert.equal(session!.sameSite, 'Strict');
    assert.equal(await page.evaluate(() => document.cookie.includes('ebos_session')), false, 'JavaScript must not be able to read the session');
    assert.ok(calls((l) => l.method === 'GET' && l.url === '/auth/session').length >= 1);
    assert.equal(calls((l) => l.headers.authorization !== undefined).length, 0, 'same-origin mode must not send a bearer header');
    assert.deepEqual(problems, []);
    await context.close();
  });

  test('a page reload keeps you signed in (session cookie), and Sign out ends it on the server', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    await page.reload();
    await page.waitForSelector('#app-shell:not(.hidden)');
    await page.click('#logout-btn');
    await page.waitForSelector('#login-screen:not(.hidden)');
    assert.equal(calls((l) => l.url === '/auth/logout').length, 1);
    assert.equal((await context.cookies()).some((c) => c.name === COOKIE && c.value !== ''), false);
    await context.close();
  });
});

describe('back office cards', () => {
  test('every card shows a live one-line summary computed from real data', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    const summary = (key: string) => page.locator(`.widget-card[data-card="${key}"] .widget-summary`);
    await page.waitForFunction(() => document.querySelector('.widget-card[data-card="materials"] .widget-summary')?.textContent);
    assert.equal(await summary('materials').textContent(), '2 materials · 1 published');
    assert.equal(await summary('people').textContent(), '2 people');
    assert.equal(await summary('inbox').textContent(), '0 conversations');
    assert.equal(await summary('orders').textContent(), '0 orders');
    assert.equal(await summary('dashboard').textContent(), '1 business');
    await context.close();
  });

  test('materials: add with a price + publish, edit the price, delete after confirming', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    const card = page.locator('.widget-card[data-card="materials"]');
    await card.locator('.mat-name').fill('Honey cake');
    await card.locator('.mat-unit').fill('slice');
    await card.locator('.mat-stage').selectOption('finished');
    await card.locator('.mat-publish').check();
    await card.locator('.add-card .f-price').fill('12.50');
    await card.locator('.add-card .f-image').fill('http://insecure.example/x.png');
    await card.locator('.mat-create-btn').click();
    await page.waitForFunction(() => /https/.test(document.getElementById('toast-root')?.textContent ?? ''));
    assert.equal(S.materials.length, 2, 'a non-https image link must be refused before any request is made');
    await card.locator('.add-card .f-image').fill('https://cdn.example/x.png');
    await card.locator('.mat-create-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.widget-card[data-card="materials"] .mat-tbody tr').length === 3);
    const created = S.materials.find((x) => x.name === 'Honey cake');
    assert.equal(created.catalogMeta.price, 12.5);
    assert.equal(created.catalogMeta.currency, 'GHS');
    assert.deepEqual(created.catalogMeta.media, { image: 'https://cdn.example/x.png', video: null });
    assert.ok(calls((l) => l.method === 'POST' && l.url === '/materials').every((l) => l.headers['x-ebos-client'] === 'web'));

    const row = card.locator('tr[data-id="m1"]');
    await row.locator('.edit-btn').click();
    await card.locator('tr.inline-editor[data-for="m1"] .f-price').fill('30');
    await card.locator('tr.inline-editor[data-for="m1"] .e-save').click();
    await page.waitForFunction(() => /30\.00/.test(document.querySelector('.widget-card[data-card="materials"] tr[data-id="m1"]')?.textContent ?? ''));
    assert.equal(S.materials.find((x) => x.id === 'm1').catalogMeta.price, 30);

    await card.locator('tr[data-id="m2"] .delete-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('.widget-card[data-card="materials"] .mat-tbody tr[data-id]').length === 2);
    assert.equal(S.materials.some((x) => x.id === 'm2'), false);
    await context.close();
  });

  test('an invalid price is rejected in the browser with a clear message', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    const card = page.locator('.widget-card[data-card="materials"]');
    await card.locator('tr[data-id="m1"] .edit-btn').click();
    await card.locator('tr.inline-editor[data-for="m1"] .f-price').fill('10.999');
    await card.locator('tr.inline-editor[data-for="m1"] .e-save').click();
    await page.waitForFunction(() => /2 decimal/i.test(document.getElementById('toast-root')?.textContent ?? ''));
    assert.equal(calls((l) => l.method === 'PATCH').length, 0);
    await context.close();
  });

  test('the retrieval-depth slider is a real setting: moving it saves an integer to the server', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    const slider = page.locator('.widget-card[data-card="people"] #preview-depth-slider');
    await slider.waitFor();
    await slider.focus();
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => /saved/i.test(document.querySelector('.ai-settings-status')?.textContent ?? ''), null, { timeout: 5000 });
    assert.ok(Number.isInteger(S.aiSettings.retrievalDepth));
    assert.ok(S.aiSettings.retrievalDepth > 8 && S.aiSettings.retrievalDepth <= 20, String(S.aiSettings.retrievalDepth));
    const put = calls((l) => l.method === 'PUT' && /ai-settings$/.test(l.url)).pop()!;
    assert.equal(put.headers['x-ebos-client'], 'web');
    await page.locator('.widget-card[data-card="people"] .ai-auto-escalate').uncheck();
    await page.waitForFunction(() => /off/i.test(document.querySelector('.ai-settings-status')?.textContent ?? ''));
    assert.equal(S.aiSettings.autoEscalation, false);
    await context.close();
  });

  test('people: adding someone creates the person and emails an invitation', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    const card = page.locator('.widget-card[data-card="people"]');
    await card.locator('.np-name').fill('Yaa Boateng');
    await card.locator('.np-email').fill('yaa@example.com');
    await card.locator('.np-role').selectOption('worker');
    await card.locator('.add-person-btn').click();
    await page.waitForFunction(() => /invitation was emailed/i.test(document.getElementById('toast-root')?.textContent ?? ''));
    assert.equal(S.people.some((p) => p.email === 'yaa@example.com'), true);
    assert.equal(calls((l) => /\/people\/p\d+\/invite$/.test(l.url)).length, 1);
    await context.close();
  });

  test('equity: a partnership can be created, and over-allocating past 100% is refused', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    const card = page.locator('.widget-card[data-card="equity"]');
    await card.locator('.pship-person').selectOption('p1');
    await card.locator('.pship-pct').fill('60');
    await card.locator('.pship-capital').fill('5000');
    await card.locator('.pship-add-btn').click();
    await page.waitForFunction(() => /partnership added/i.test(document.getElementById('toast-root')?.textContent ?? ''));
    assert.deepEqual(S.partnerships.map((p) => p.ownershipPct), [60]);
    await page.waitForFunction(() => document.querySelector('.widget-card[data-card="equity"] .pship-person'));
    await card.locator('.pship-person').selectOption('p2');
    await card.locator('.pship-pct').fill('50');
    await card.locator('.pship-add-btn').click();
    await page.waitForFunction(() => /cannot exceed 100/i.test(document.getElementById('toast-root')?.textContent ?? ''));
    assert.equal(S.partnerships.length, 1);
    await context.close();
  });

  test('dashboard: an owner can add another business and switch to it', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    const card = page.locator('.widget-card[data-card="dashboard"]');
    await card.locator('.new-biz-name').fill('Sunrise Farms');
    await card.locator('.new-biz-btn').click();
    await page.waitForFunction(() => document.querySelectorAll('#biz-select option').length === 2);
    assert.equal(S.businesses.length, 2);
    assert.equal(await page.locator('#biz-select option:checked').textContent(), 'Sunrise Farms');
    assert.ok(calls((l) => l.method === 'POST' && l.url === '/businesses').every((l) => l.headers['x-ebos-client'] === 'web'));
    await context.close();
  });

  test('the bell shows unread notifications, opens a list, and marks one read on click', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await signIn(page);
    await page.waitForFunction(() => document.getElementById('notif-count') && !document.getElementById('notif-count')!.classList.contains('hidden'));
    assert.equal(await page.textContent('#notif-count'), '1');
    assert.match(await page.title(), /^\(1\) /);
    await page.click('#notif-btn');
    await page.waitForSelector('#notif-panel:not(.hidden) .notif-item.unread');
    assert.match((await page.textContent('#notif-panel')) ?? '', /customer is waiting/i);
    await page.click('#notif-panel .notif-item');
    await page.waitForFunction(() => document.getElementById('notif-count')!.classList.contains('hidden'));
    assert.equal(S.notifications[0].read, true);
    await context.close();
  });
});


// ================================================================== DESIGN SYSTEM
function parseColor(v: string): [number, number, number, number] {
  v = v.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)$/i.exec(v) as RegExpExecArray | null;
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  throw new Error('cannot parse colour: ' + v);
}
const lum = ([r, g, b]: number[]) => {
  const f = (c: number) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (fg: number[], bg: number[]) => { const a = fg[3] ?? 1; return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a)); };

describe('liquid-glass design system', () => {
  for (const [file, name] of [['/', 'landing'], ['/e-bos-backoffice.html', 'back office']] as const) {
    test(`${name}: follows the device theme, the toggle switches it, and the choice survives a reload`, async () => {
      S = freshState();
      const { context } = await newPage();
      await context.close();
      for (const scheme of ['light', 'dark'] as const) {
        const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        await page.goto(base + file);
        const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const first = await bg();
        const lightness = (c: string) => { const [r, g, b] = parseColor(c); return (r + g + b) / 3; };
        assert.ok(scheme === 'dark' ? lightness(first) < 60 : lightness(first) > 200, `${scheme}: body background was ${first}`);
        await page.locator('#theme-btn:visible, .theme-toggle:visible').first().click();
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), scheme === 'dark' ? 'light' : 'dark');
        const flipped = await bg();
        assert.notEqual(flipped, first);
        await page.reload();
        assert.equal(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), scheme === 'dark' ? 'light' : 'dark', 'choice not remembered');
        await ctx.close();
      }
    });

    test(`${name}: text and accent colours meet WCAG AA (4.5:1) on the glass fallback surface in BOTH themes`, async () => {
      S = freshState();
      const { page, context } = await newPage();
      await page.goto(base + file);
      for (const theme of ['light', 'dark']) {
        await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
        const v = await page.evaluate(() => {
          const cs = getComputedStyle(document.documentElement);
          const names = ['--solid', '--text', '--text-muted', '--text-faint', '--accent', '--accent-fill', '--ink-bad', '--ink-good', '--ink-warn', '--ink-ai', '--ink-wait'];
          return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim()]));
        });
        const solid = parseColor(v['--solid']);
        const on = (name2: string) => over(parseColor(v[name2]), solid);
        const checks: Array<[string, number]> = [
          ['--text', ratio(on('--text'), solid)],
          ['--text-muted', ratio(on('--text-muted'), solid)],
          ['--text-faint', ratio(on('--text-faint'), solid)],
          ['--accent (links)', ratio(on('--accent'), solid)],
          ['white on --accent-fill (buttons)', ratio([255, 255, 255], on('--accent-fill'))],
          ['--ink-bad', ratio(on('--ink-bad'), solid)],
          ['--ink-good', ratio(on('--ink-good'), solid)],
          ['--ink-warn', ratio(on('--ink-warn'), solid)],
          ['--ink-ai', ratio(on('--ink-ai'), solid)],
          ['--ink-wait', ratio(on('--ink-wait'), solid)],
        ];
        for (const [label, r] of checks) assert.ok(r >= 4.5, `${theme}: ${label} is only ${r.toFixed(2)}:1`);
      }
      await context.close();
    });
  }

  test('glass surfaces really use backdrop blur, and the sheets float (rounded, inset from the screen edge)', async () => {
    S = freshState();
    const { page, context } = await newPage();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(base + '/');
    await page.waitForSelector('canvas');
    const topbar = await page.evaluate(() => {
      const cs = getComputedStyle(document.getElementById('topbar-inner')!, '::before');
      return { blur: cs.backdropFilter || (cs as any).webkitBackdropFilter, radius: cs.borderTopLeftRadius };
    });
    assert.match(topbar.blur, /blur\(/);
    assert.ok(parseFloat(topbar.radius) >= 100, 'top bar must be a pill, radius ' + topbar.radius);
    await page.waitForTimeout(500);
    assert.equal(await openDetailFor(page, null), true);
    await page.waitForTimeout(600);
    const sheet = await page.evaluate(() => {
      const el = document.getElementById('detail-panel')!;
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      return { blur: cs.backdropFilter, radius: parseFloat(cs.borderTopLeftRadius), right: window.innerWidth - r.right, top: r.top };
    });
    assert.match(sheet.blur, /blur\(/);
    assert.ok(sheet.radius >= 24, 'sheet radius ' + sheet.radius);
    assert.ok(sheet.right >= 8 && sheet.top >= 8, `sheet must float: right gap ${sheet.right}, top gap ${sheet.top}`);
    await context.close();
  });

  test('no third-party requests are made (no web fonts or CDNs) — the pages work offline of everything but the API', async () => {
    S = freshState();
    const { page, context } = await newPage();
    const external: string[] = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (u.hostname !== '127.0.0.1') external.push(r.url()); });
    await page.goto(base + '/');
    await page.waitForTimeout(500);
    await page.goto(base + '/e-bos-backoffice.html');
    await page.waitForTimeout(300);
    assert.deepEqual(external, []);
    await context.close();
  });
});

describe('back office (emulated Android Chrome, Pixel 5)', () => {
  test('sign-in screen and the app shell fit the screen without sideways scrolling', async () => {
    S = freshState();
    const { page, context, problems } = await newPage({ mobile: true });
    await page.goto(base + '/e-bos-backoffice.html');
    let overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `login scrolls sideways by ${overflow}px`);
    await page.fill('#login-email', 'owner@test.example');
    await page.fill('#login-password', GOOD_PASSWORD);
    await page.click('#login-submit');
    await page.waitForSelector('#app-shell:not(.hidden)');
    await page.waitForTimeout(500);
    overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `app shell scrolls sideways by ${overflow}px`);
    assert.deepEqual(problems, []);
    await context.close();
  });
});
