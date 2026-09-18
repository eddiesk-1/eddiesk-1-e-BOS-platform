# e-BOS — Setup on your phone (proot-distro Ubuntu)

## What's in this folder

```
e-bos-platform/
├── SETUP.md          you are here
├── setup.sh           the one script — installs, migrates, seeds, boots everything
├── frontend/
│   ├── e-bos-landing.html      the public/consumer side — one file, no build step
│   └── e-bos-backoffice.html   owner/worker back office — one file, no build step
└── backend/
    ├── src/            the actual Fastify service
    ├── migrations/      17 Postgres migrations
    └── ...              package.json, .env.example, README.md (the full technical writeup)
```

## Run it

```bash
proot-distro login ubuntu
# once inside Ubuntu, cd to wherever you extracted this folder, then:
cd e-bos-platform
bash setup.sh
```

That's the whole install: packages, Postgres init, database + roles, all 18
migrations, seed data, build, and boot — backend on `:3000`, both frontend
files served on `:8080`. Takes a few minutes on first run (mostly
`npm install` and `apt-get`). Re-running `setup.sh` later is safe — every
step checks whether it's already done before doing it again.

When it finishes, open in a browser on the same device:

- **`http://localhost:8080/e-bos-landing.html`** — the public storefront and
  consumer chat. No login needed. Its "Join or Create Business" menu
  (top right) also has a "Sign In to Back Office" option that links
  straight to the file below — a plain navigation, not an animated
  transition, since an anonymous visitor and an authenticated back-office
  session share no real state to animate between.
- **`http://localhost:8080/e-bos-backoffice.html`** — the owner/worker back
  office: one scrollable screen of role-gated glass cards (dashboard,
  materials, orders, ledger, partnerships, chat inbox, people &amp;
  integrations), with a floating button (top right) to add back any
  card you've removed, or see which ones your role doesn't qualify for
  yet. Sign in with the demo owner/partner/worker credentials
  `setup.sh` prints at the end (also saved to `seed-output.txt`).

## Adding the remaining values — what you still need to fill in

**`backend/.env`** gets created automatically by `setup.sh`, with a random
database password and `JWT_SECRET` already generated for you. **One line
you must edit yourself:**

```
ANTHROPIC_API_KEY=your_real_anthropic_api_key_here
```

Replace that with a real key from your Anthropic account. Without it, the
core platform (browsing, chat threads, orders, the back office) all work
normally — only the four AI-backed features return a clear `503` instead of
working: AI search, the AI product-overview blurb, and the AI receptionist
in chat.

After editing `.env`, restart the backend for the new key to take effect:

```bash
pkill -f "node dist/server.js"
cd backend && export $(grep -v '^#' .env | xargs) && nohup node dist/server.js > ../backend.log 2>&1 &
```

**Logging into the back office**: `setup.sh` seeds one demo owner, one
partner, one worker — their emails, password, and IDs are printed to your
terminal during setup and also saved to `seed-output.txt` in this folder.
Open `e-bos-backoffice.html` and sign in with any of them (note the
holding company ID it also prints — the login screen asks for it). A
worker signing in won't see the Ledger or Partnerships &amp; Equity nav
items at all — that's not a bug, the database itself refuses those tables
to a worker regardless of what any UI shows.

**Publishing a product so the landing page shows something**: fresh from
seeding, `/product-stream` is empty — nothing's published yet. Either use
the backend's API directly, or open `e-bos-backoffice.html`, sign in, and
use Materials & Catalog's publish toggle — that's exactly the screen this
was missing before.

## What's actually been verified vs. what's genuinely untested

Said plainly, matching how every other part of this project has been
built:

**Directly verified, this session, against the real running backend:**
every consumer-chat flow (start a conversation, reply, identify, request
an AI reply, redeem a payment token) using the *actual* JavaScript extracted
from `e-bos-landing.html` — not a re-implementation, the literal file code
— run against a live Postgres + Fastify instance. Two real integration bugs
were found and fixed this way: `/product-stream` was missing a `businessId`
field the frontend needed, and a header-merging bug in the frontend's own
`apiFetch` helper was silently dropping `Content-Type: application/json` on
most POST requests. Both are fixed in the files in this folder, not just
described here.

**Corrected against a real failure, not just theorized:** the first
version of this script hardcoded `postgresql-16-pgvector` and the `/16/`
data-directory path throughout, because that's the exact Postgres version
the development sandbox above had. A real user's proot-distro Ubuntu
shipped Postgres 18 by default (a newer Ubuntu release than the sandbox
this was built in), and `postgresql-16-pgvector` doesn't exist as a
package on their system — the script failed at that exact step. Fixed:
`setup.sh` now runs `pg_lsclusters` to detect whichever Postgres version
actually got installed, and derives the pgvector package name, data
directory, and config paths from that detected value instead of assuming
16 anywhere. The detection logic itself was tested directly in the
development sandbox (confirmed it correctly reports "16" there); the
Postgres-18-specific path was NOT re-run end-to-end after the fix, since
that sandbox only has 16 available to test against — the fix is reasoned
correctly and the underlying package-naming convention was confirmed
consistent, but "made the same class of failure impossible to hit again"
is not the same claim as "confirmed working on Postgres 18 specifically."

**Still genuinely untested beyond that:**
- **This script, on real Termux + proot-distro Ubuntu, end to end.** If a
  step fails, the script's `fail()` messages point at what to check; the
  backend's own `README.md` has the from-scratch setup steps in more
  detail if you need to troubleshoot by hand.
- **The AI receptionist's actual output quality.** The endpoint's plumbing
  (auth, conversation history, honesty-disclosure enforcement, catalog
  scoping) is verified. What Claude actually *says* once you add a real API
  key has not been — that's real, human judgment to check once you're
  running with a live key.
- **`e-bos-backoffice.html`, rendered in an actual browser.** This file has
  been rebuilt twice now — first as a sidebar/single-view layout, then
  redesigned into the current card-scroll model (every eligible view
  as its own glass card on one scrollable screen, role-gated, with a
  floating picker for adding or revealing locked ones). Both versions
  went through the same checking process, and both times it caught a
  real, would-have-shipped bug: the first version had an unclosed
  wrapper function that would have made the entire file fail to load;
  this version had a duplicate, empty `<body>` tag left over from
  building the file in two stages. Neither was found by reading the
  code and deciding it looked right — both were found by mechanically
  checking every script block's syntax and every HTML tag's balance,
  the same two checks worth re-running on any future edit to this file
  before trusting it. Every view's field names are checked against the
  actual backend route source, not guessed, and every `querySelector`
  target (over 50 of them, across ids, classes, and one
  `parentElement`-relative lookup for the EQ slider's value readout)
  was cross-referenced against the markup it's meant to find. What
  none of that proves is what only a real browser can: whether a click
  actually does what it looks like it should, whether the glass/blur
  effects render acceptably across real GPUs, whether the layout holds
  up at real window sizes. That gap hasn't closed — it's the same one
  named in every version of this file so far.
- **The EQ-style slider is a real, working drag control** — pointer
  events (mouse and touch in one code path), keyboard arrow-key
  support, its own value readout — not a decorative CSS mockup. It
  currently controls exactly one thing: a LOCAL, client-side-only
  preview depth (how many freshly-ingested chunk IDs the People &amp;
  Integrations screen shows you after an ingest). It does **not**
  change how many chunks the live AI receptionist actually retrieves —
  that's a fixed backend constant (`LIMIT 8` in `src/routes/ai.ts`),
  never exposed as a configurable parameter. Labeled honestly as a
  local display preference in the UI itself, rather than implying it
  reaches further into the backend than it does.
- **Partnerships & Equity's allocation sliders are a different thing
  entirely — they DO write real data to the backend**, unlike the
  preview-depth slider above. Dragging one person's slider
  proportionally redistributes the remainder across the OTHER
  unlocked sliders (a 🔒 button holds a person's share still while you
  move the rest), so the set sums to exactly 100 by construction
  rather than requiring the user to manually balance plain number
  inputs — the same math the old number-input version validated after
  the fact, done live instead. The redistribution function itself was
  tested in isolation before ever being wired to a slider: basic
  proportional redistribution, a locked slider absorbing correctly,
  an over-drag clamped to what's actually available, and the
  division-by-zero case when every other slider is already at 0 —
  all confirmed against hand-worked expected values, not just "ran
  without crashing." One real gap was found and fixed after that:
  removing a person from the split didn't make them reappear in the
  "add a person" dropdown until the card was reloaded, because only
  the slider rows were being re-rendered, never the dropdown itself.
  Posting the rule still goes through the same
  `POST /allocation-rules` endpoint and the same "must sum to exactly
  100" backend check as before — the sliders make reaching that state
  easier to construct, they don't relax what the backend requires.
  reaches further into the backend than it does.

## If something goes wrong

- **`apt-get install` fails on `postgresql-<version>-pgvector`** (the
  script prints exactly which version it detected and tried): that
  package may need Ubuntu's `universe`/`multiverse` repos enabled, or may
  not exist at all for your specific Ubuntu release. Run
  `apt-cache search pgvector` yourself to see what IS available — if
  nothing comes back for your detected version, the backend's first
  migration (`CREATE EXTENSION vector`) will fail, and pgvector will need
  building from source against your installed Postgres version instead.
- **Migrations fail partway through**: `cd backend && npx node-pg-migrate down`
  repeatedly rolls back one migration at a time if you need to reset and
  retry — safe to do, every migration's rollback was verified during
  development (see `backend/README.md`'s "Running migrations" section).
- **Backend won't start**: check `backend.log` in this folder — the actual
  error is almost always there, not in the setup script's own output.
- **Blank landing page, no products showing**: expected on a fresh seed —
  see "Publishing a product" above.
