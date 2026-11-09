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

## Before every deploy: run the checks

```bash
cd backend && npm install && npx tsc --noEmit && npm run build && cd ..
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
