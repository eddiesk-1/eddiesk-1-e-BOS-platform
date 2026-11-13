# Deploying e-BOS somewhere real

This covers deploying e-BOS to a hosting platform or your own server —
different from `SETUP.md`, which covers running it locally via Termux.
Read this instead of `SETUP.md` if you want other people to actually
reach and use this service.

## The one thing to confirm BEFORE anything else: pgvector

This backend's very first migration requires `CREATE EXTENSION vector`
(pgvector). **Not every managed Postgres offering supports this.**
Before picking a host, check directly:

- Neon and Supabase both document pgvector support on their sites as of
  this writing.
- Render's managed Postgres has also supported it — confirm current
  status on their docs before committing, since this could change and
  wasn't independently re-verified while writing this guide (this
  environment had no way to reach render.com to check at the time).
- A raw VPS (DigitalOcean, Hetzner, a bare EC2 instance) where you
  install Postgres yourself: `apt-get install postgresql-<version>-pgvector`
  — the exact command `setup.sh` already uses, and the one path here
  that's been genuinely exercised, not just read about.

If you pick a managed Postgres that turns out NOT to support pgvector,
migration 001 fails outright on first deploy — better to know that
before setting up everything else around it.

## Two ways to deploy this, both portable

### Option A: Docker (works almost anywhere containers run — Render,
Railway, Fly.io, a raw VPS, AWS/GCP/Azure container services)

```bash
# from the REPO ROOT (the folder containing this file, backend/, and frontend/)
docker build -f Dockerfile -t e-bos .
docker run -p 3000:3000 --env-file backend/.env e-bos
```

The `Dockerfile` at the repo root is a real multi-stage build — it
compiles TypeScript, copies the frontend's two HTML files into the
image so the backend can serve them itself, and ships a smaller
runtime image than the build stage. Read the comments at its top; they
explain a few real, specific decisions (why `bcrypt` needs build tools
in the build stage but not the runtime stage, why this must be built
from the repo root and not `backend/` alone) that matter if you ever
need to modify it.

### Option B: Plain Node buildpack (Render, Railway, and similar can
also just run a Node app directly, without Docker)

- **Root directory**: `backend/`
- **Build command**: `npm install && npm run build`
- **Start command**: `npm run deploy` (this runs migrations, THEN
  starts the server — see `package.json`; safe to run on every deploy,
  since `node-pg-migrate` tracks which migrations already applied and
  skips them)

Either way, the environment variables below are what the platform's
dashboard needs, in place of the `.env` file `setup.sh` generates
locally.

## Environment variables for a real deployment

Same variables as `backend/.env.example`, set through your platform's
dashboard instead of a local file:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Your managed Postgres provider's connection string (the superuser one, used only for running migrations) |
| `APP_DATABASE_URL`, `PUBLIC_DATABASE_URL` | Same host and database name as `DATABASE_URL` (use the provider's INTERNAL hostname), but connecting as `app_login` / `app_public_login` with passwords you generate yourself. The deploy script sets those two roles' passwords from these URLs on every start (see below) — you do not set them by hand. URL-encode special characters in the password. |
| `ANTHROPIC_API_KEY` | Your real Anthropic key |
| `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` | Generate REAL random values for a public deployment — `setup.sh` generates these for you locally; for a platform deploy, generate them yourself: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, once per variable. Reusing the value this doc or any example shows would mean anyone reading this doc could forge tokens or decrypt stored provider keys — these MUST be unique, private values you generate yourself, never copied from documentation. |
| `ALLOWED_ORIGIN` | Only needed if your frontend ends up on a different origin than the backend — see below |
| `NODE_ENV` | Set to `production`. Turns on startup validation of secrets, `Secure` cookies and HSTS, and makes the seed script refuse to run. |
| `APP_BASE_URL` | **Required in production.** The public `https://` URL of this service (no trailing slash). Used in emailed links and the Paystack return URL. |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM` | Needed for signup, password reset, invitations and staff alerts. `resend` or `brevo`. See "Email" below. Without them signup answers 503 (honestly) instead of creating accounts nobody can verify. |
| `PAYSTACK_SECRET_KEY` | Optional. Switches on checkout. Start with an `sk_test_…` key. See "Payments" below. |
| `TRUST_PROXY`, `BCRYPT_COST`, `LOG_LEVEL` | Optional tuning; see `backend/.env.example`. |

The server now **refuses to start** (one readable message, variable names
only, never values) if `JWT_SECRET` is short or an example value, if
`CREDENTIAL_ENCRYPTION_KEY` is not 32 base64 bytes or equals `JWT_SECRET`,
if a database URL still has the default role password, if `APP_BASE_URL`
is not https, or if `ALLOWED_ORIGIN` is `*`. That check lives in
`src/lib/env.ts` and is unit-tested.
| `PORT` | Most platforms set this for you automatically; only set it yourself on a raw VPS |

## Database connections: TLS and role passwords

Two problems hit the first real deployment. Both were reproduced against
a real Postgres before being fixed, and both are fixed in the code.

**TLS.** Managed Postgres hosts can refuse connections that are not
encrypted. A pool created with no `ssl` option then fails on its first
query, while the service itself boots and `/health` looks fine — the
symptom was a landing page whose product stream would not load. All
three connection pools (`db.ts`, `publicDb.ts`, the seed script) now go
through one helper, `src/lib/ssl.ts`:

| Setting | Effect |
|---|---|
| `DATABASE_SSL` unset | TLS **on** when `NODE_ENV=production` (Docker and most hosts), off otherwise — so the local Termux setup is untouched |
| `DATABASE_SSL=false` | Force TLS off (e.g. a plain local database inside a production container) |
| `DATABASE_SSL=true` | Force TLS on |
| `DATABASE_SSL_VERIFY=true` | Also verify the server's certificate |

By default the connection is **encrypted but the server's certificate is
not verified**, because managed providers often use certificates that do
not chain to a public CA. That stops eavesdropping but not an active
man-in-the-middle on the network path. Using the provider's INTERNAL
hostname (traffic stays on their private network) keeps that exposure
small. If your database URLs use a public hostname such as
`xxxx.oregon-postgres.render.com`, switch them to the internal one.

**Role passwords.** Migrations 004 and 008 create the two login roles
with the fixed password `change_me_in_production`. Nothing used to apply
the passwords an operator put in `APP_DATABASE_URL` /
`PUBLIC_DATABASE_URL`, so on a fresh database every request through
those pools failed with "password authentication failed" — again while
the service booted normally. The `deploy` script now runs
`sync-roles` between migrations and server start, which sets both roles'
passwords from those two URLs. It is idempotent, never prints a
password, and refuses a URL that connects as the wrong user. Set
`SKIP_ROLE_PASSWORD_SYNC=true` if your admin database user cannot
`ALTER ROLE` and you manage those passwords yourself.

## Reading a failed deploy

`npm run deploy` runs three steps joined by `&&`: migrations, then
`sync-roles`, then the server. If any step fails, the server never
starts, and Render keeps serving the PREVIOUS version while the new one
fails. Two signs you are in this situation: the log shows
`Port scan timeout reached, no open ports detected` (the new instance
never bound a port), and the live site still behaves like the old code.
Look for the last line starting `[sync-role-passwords] failed:` or an
error from `node-pg-migrate`.

The most common cause is a malformed database URL. The shape must be
exactly `postgres://ROLE:PASSWORD@HOST/DATABASE` — the `:` between the
role name and the password is required. Without it the password becomes
part of the username, which is what the first real deploy hit.

If a password ever appears in a log or a chat, treat it as exposed:
generate a new one and put it in the variable. The next deploy applies
it to the role automatically.

## CORS — read this if anything looks broken after deploying

**The backend now serves the frontend itself** (see `server.ts`'s
static-file registration) — the two files in `frontend/` get copied
into the backend's own served directory at build time. If you deploy
using either option above and don't do anything unusual, your frontend
and backend end up on the SAME origin automatically, and you'll never
need to touch CORS at all.

CORS only becomes relevant if you deliberately host the frontend
somewhere else — a separate static site, a CDN, a different
subdomain. If you do that, set `ALLOWED_ORIGIN` to the frontend's
exact origin (e.g. `https://your-frontend.example.com`) — never `*`.
This backend does JWT-authenticated, credentialed requests; a wildcard
CORS policy on a backend like that would let any website's own
JavaScript read this API's responses as if it were your real frontend.
If `ALLOWED_ORIGIN` is left unset and the frontend ends up cross-origin
anyway, every request will fail silently in the browser's console with
a CORS error — that specific symptom means this variable needs setting.

## Upgrading to 0.0.6 (read before deploying)

1. **Back up the database first** (your provider's snapshot, or
   `pg_dump -Fc "$DATABASE_URL" > before-0.0.6.dump`). Migrations 019-021
   only ADD tables, columns, functions and an index, and every `down` is
   written, but a restore point is the only real safety net.
2. Add the new environment variables (table above). At minimum set
   `NODE_ENV=production` and `APP_BASE_URL`. If you set nothing else the
   service still runs, signup is simply disabled (503) and checkout is off.
3. Deploy. `npm run deploy` applies migrations 019, 020, 021, then syncs
   the role passwords, then starts. Everyone who already has an account is
   back-filled as **email-verified** by migration 019, so nobody is locked
   out by the upgrade.
4. **Every signed-in user is signed out once.** Session tokens now carry a
   version and a purpose claim; tokens from before the upgrade have neither
   and are refused. Users just sign in again.
5. Set Render's **Health Check Path** to `/ready` (it checks both
   database connections). `/health` still exists and only says the process
   is up.
6. Look at the startup log. If you see the line *"Database owner does not
   bypass row-level security"*, read the next section before anything else.

## Database role requirement (important, and easy to miss)

Several functions in this schema (migrations 013 and 016, and now 019-021)
are `SECURITY DEFINER` and read tables that have `FORCE ROW LEVEL
SECURITY`. They only see rows if the database user that ran the migrations
is a **superuser or has `BYPASSRLS`**. If it is not, the visitor chat
(identify, redeem), the AI reply, handoff notifications and checkout all
fail with empty results rather than errors, and `is_business_visible_to_
caller()` — used by the policies on almost every business table — returns
false for everything.

The server runs a self-check at startup (`diag_owner_bypasses_rls()`,
migration 019) and logs a loud error if the requirement is not met. The
result is never exposed over HTTP. Fix it with
`ALTER ROLE <migration_user> BYPASSRLS;` run by a superuser, or run
migrations as a superuser. If your provider will not allow either, tell
me — the alternative is to restructure those functions, which is real work.

## Creating the first account (no seed accounts in production)

`npm run seed` is for development only and now refuses to run when
`NODE_ENV=production`. In production the first account comes from the
registration form on the landing page ("Join or Create Business" →
"Create Business"): fill it in, open the email, click the link, sign in at
`/e-bos-backoffice.html`. That requires email to be configured (below).
There is no platform-administrator role yet; every owner administers only
their own company.

## Email

Set `EMAIL_PROVIDER` to `resend` or `brevo`, plus `EMAIL_API_KEY` and
`EMAIL_FROM` (a sender you have verified with the provider). Messages are
sent over the provider's HTTPS API; there is no SMTP dependency. First-send
checklist: register with an address you control → the confirmation email
arrives → the link opens the landing page and says "Email confirmed" → sign
in. Then try "Forgot password". The provider request shapes follow each
provider's published API but **have not been run against a live account** —
treat the first send as a test.

## Payments (Paystack)

Leave `PAYSTACK_SECRET_KEY` empty and checkout stays off (product pages
offer "Ask to buy", a real chat). To switch it on:

1. Put an `sk_test_…` key in `PAYSTACK_SECRET_KEY`.
2. In the Paystack dashboard set the webhook URL to
   `https://<your-host>/webhooks/paystack`.
3. Give a published material a price (back office → Materials & Catalog →
   Edit → Price). Items without a price cannot be bought online.
4. Buy it from the landing page with a Paystack test card/number. Check:
   the order moves `pending_payment` → `paid`, the owner gets a bell
   notification, the chat shows "A team member has been notified", and the
   Paystack dashboard's "resend webhook" does nothing the second time
   (idempotency).
5. Only then switch to an `sk_live_…` key.

What guarantees correctness: a payment becomes `paid` only inside one
database function that checks the amount and currency against our own
record and ignores duplicate events; the browser's return from Paystack
only prompts the server to ask Paystack for the truth. Refunds are **not**
implemented. The webhook's raw-body signature check and Paystack's request
shapes have **not been exercised against live Paystack**.

## Sessions

Signing in sets an HttpOnly, SameSite=Strict (and Secure in production)
cookie; the page JavaScript cannot read it. `Authorization: Bearer` tokens
still work for API clients. Changing or resetting a password, or "Sign out
everywhere", invalidates every older session. Because tokens are stateless,
"Sign out" on one device clears that browser's cookie but a copied token
stays valid until it expires (12 h) or the person's sessions are revoked;
other server instances may honour a revoked token for up to 15 seconds
(cache). If you host the frontend on a different origin than the API
(`ALLOWED_ORIGIN`), the Strict cookie is not sent cross-site and the back
office falls back to keeping the bearer token in localStorage (the old
behaviour) — prefer the same-origin deployment this repo is built for.

## Rate limits

In-memory, per server instance (`src/lib/limits.ts`): login 20 per 10 min
per IP and 10 per 15 min per email, signup 5 per hour per IP, email-sending
actions 8 per hour per IP, AI replies 40 per hour per IP, and so on. A
single Render instance (what this repo targets) is what this is built for;
with several instances each keeps its own counters and the effective limit
is multiplied. A restart resets them.

## Running the tests

```bash
cd backend
npm install
npm test            # unit + structural migration tests (no database needed)
npm run test:types  # type-checks the tests too
```
`npm test` also contains the database tests (tenant isolation, account
functions, chat functions, payments). They are **skipped, and reported as
skipped,** unless you point them at a scratch database that has all 21
migrations applied:

```bash
export TEST_DATABASE_URL='postgres://<migration user>:...@host/scratch'
export TEST_APP_DATABASE_URL='postgres://app_login:...@host/scratch'
export TEST_PUBLIC_DATABASE_URL='postgres://app_public_login:...@host/scratch'
npm test
```
Real-browser tests (Chromium, with the API faked in memory) live in
`tools/browser-test.mts`:
```bash
cd backend && npm i --no-save playwright && npx playwright install chromium
npx tsx --test ../tools/browser-test.mts
```
Verify embeddings with your own key (cost: a fraction of a cent):
```bash
VERIFY_PROVIDER=openai VERIFY_API_KEY=sk-... npm run verify:embeddings
```

## What's genuinely verified here, and what isn't

Consistent with how the rest of this project has been built: real,
carefully-reasoned code, checked wherever checking was actually
possible, honest about the rest.

**Checked directly**: the CORS registration and static-file-serving
code in `server.ts` typechecks cleanly against this project's real
`tsconfig.json` (filtering out only the expected "module not found"
noise from `node_modules` not being installed in the environment this
was written in — the same class of noise every other file in this
project produces under the same condition). Brace balance was
independently verified character-by-character, not just assumed correct
from reading it. Every file path the Dockerfile references was
confirmed to exist in the real project structure.

**Run for real since this was first written**: the Dockerfile was built
and run by Render; all 18 migrations were applied to a real Postgres 16
with pgvector; the whole project type-checks and builds with its real
dependencies; and the TLS and role-password failures above were
reproduced against a database configured to refuse unencrypted
connections, then shown fixed.

**Still not verified, stated plainly**: behaviour on Render's own
Postgres 18 beyond what its logs showed, certificate verification
(`DATABASE_SSL_VERIFY=true`) against a real provider certificate, and
anything that needs a live Anthropic or embeddings-provider key.

**0.0.6 — what was and was not verified.** Written in an environment with
no Postgres, no npm registry access and no API keys. Verified there:
108 unit/structural tests pass (`npm test`); 32 real-browser tests pass
(Chromium, API faked in memory); both frontends pass the smoke test; every
new backend file type-checks against hand-written stubs of fastify/pg/bcrypt
(so `npm run build` with the real packages is still the real check).
**Not verified:** migrations 019-021 were never executed against Postgres;
the database tests in `integration.test.ts` were written but not run; no
email was sent; no Paystack request or webhook was made; no Anthropic,
OpenAI or Voyage call was made; nothing was tested on a physical Android
device or in Opera, Firefox or Safari (Android Chrome was *emulated*).

## Before every deploy: run the checks

```bash
cd backend && npm install && npx tsc --noEmit && npm run build && npm test && cd ..
node tools/smoke-test.js frontend/e-bos-landing.html
node tools/smoke-test.js frontend/e-bos-backoffice.html signed-in
```

The first line type-checks the whole backend and runs the exact build
Render runs. Both smoke tests should print `ReferenceErrors: 0`.

The smoke test exists because of a real incident: the first Render
deploy shipped a landing page whose Join/Create button did nothing. An
earlier edit had deleted a block of code by line number, and that block
also held shared helpers (`clamp`, `escapeHtml`, `lighten`,
`reducedMotion`, ...). The script died on its first line with
`ReferenceError: reducedMotion is not defined`, before it registered a
single event listener. Syntax checks passed the whole time — they verify
grammar, not that every name is declared — so the bug was only found by
opening the live page.

The smoke test is not a browser. It proves every name resolves and every
handler can start; it does not prove the layout looks right or that a
real tap does what you intend. Still open the live page yourself after
each deploy.
