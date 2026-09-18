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
| `APP_DATABASE_URL`, `PUBLIC_DATABASE_URL` | Set these to real, unique passwords for `app_login`/`app_public_login` — migration 004/008 create these roles with `change_me_in_production` literally in their name for a reason; a real deployment must not keep that default |
| `ANTHROPIC_API_KEY` | Your real Anthropic key |
| `JWT_SECRET`, `CREDENTIAL_ENCRYPTION_KEY` | Generate REAL random values for a public deployment — `setup.sh` generates these for you locally; for a platform deploy, generate them yourself: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, once per variable. Reusing the value this doc or any example shows would mean anyone reading this doc could forge tokens or decrypt stored provider keys — these MUST be unique, private values you generate yourself, never copied from documentation. |
| `ALLOWED_ORIGIN` | Only needed if your frontend ends up on a different origin than the backend — see below |
| `PORT` | Most platforms set this for you automatically; only set it yourself on a raw VPS |

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

**NOT checked, and stated plainly rather than implied**: this Dockerfile
has never actually been built. Nothing in this deployment path — the
container, the CORS behavior under a real cross-origin request, the
static file serving actually returning the right files to a browser —
has been run. This environment had no access to Docker, no access to
`npm install` (blocked at the network level while this was written),
and no access to any real deployment platform to test against. The
reasoning behind every decision here is sound and specific, not
generic advice — but "reasoned through carefully" and "watched it
work" are different claims, and this document is only making the
first one. The first real build and deploy is the actual test.
