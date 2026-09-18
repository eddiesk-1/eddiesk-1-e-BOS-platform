# e-BOS Backend

Backend foundation for e-BOS: one holding company runs multiple businesses,
each seeded from an uploaded operating guide, with partners holding equity
splits and workers executing tasks. This service implements the shared
contract's Postgres schema, row-level security, JWT auth, and the core REST
API three other codebases build against.

Built with **Fastify 5** (chosen over NestJS for this piece specifically:
route handlers, RLS session-variable plumbing, and transaction boundaries
are all explicit function calls here, not resolved through a DI container —
predictable-from-reading was the design goal, not framework convenience),
**raw `pg`** with parameterized queries (no ORM — the SQL in the migrations
is exactly the SQL that runs), and **`node-pg-migrate`** for schema
migrations, written as literal SQL rather than a schema-builder DSL.

## Prerequisites

- Node.js 20+
- PostgreSQL 16 with the `pgvector` extension available (`CREATE EXTENSION
  vector` must succeed — on Debian/Ubuntu, `apt install postgresql-16-pgvector`;
  see [pgvector's install docs](https://github.com/pgvector/pgvector) for
  other platforms)

## Setup

```bash
npm install
cp .env.example .env   # then edit — see below
```

`.env` needs three different Postgres connection strings, plus one
optional API key:

- **`DATABASE_URL`** — an admin/superuser connection. Migrations use this to
  `CREATE ROLE`, `GRANT`, and `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`.
  The application process never uses this connection string.
- **`APP_DATABASE_URL`** — the connection every authenticated request
  uses, authenticating as `app_login`. This role has **zero table grants
  of its own**; every request immediately `SET ROLE`s into
  `app_owner_partner` or `app_worker` depending on the caller's JWT role
  claim (see "How RLS actually gets enforced" below). If you ever see
  every single authenticated request fail with `permission denied`, check
  that the app is using `APP_DATABASE_URL`, not `DATABASE_URL`.
- **`PUBLIC_DATABASE_URL`** — a separate connection used only by
  `GET /product-stream`, the one genuinely public, unauthenticated route
  in this service. Authenticates as `app_public_login`, which can `SET
  ROLE` into `app_public` and nothing else — see "The public landing
  page" below.
- **`ANTHROPIC_API_KEY`** — optional. Only the three routes in
  `src/routes/ai.ts` need it; everything else works with it unset. If
  it's missing, those three routes return a clear `503` instead of
  failing confusingly.

Create the database and run migrations:

```bash
createdb ai_bos
npm run migrate:up
```

Seed some data to work with (one holding company, one business, one person
per role, a partnership, and login credentials — printed to stdout,
including a ready-to-run `curl` login command):

```bash
npm run seed
```

Run it:

```bash
npm run build && npm start
# or, for development with auto-restart:
npm run dev
```

The server listens on `PORT` (default `3000`). `GET /health` returns
`{"status":"ok"}` once it's up.

## How RLS actually gets enforced

This is the part of the system most worth understanding before changing
anything, because it has three layers that all have to agree, and getting
one wrong silently breaks the other two.

**Layer 1 — two Postgres roles.** `app_owner_partner` (used when the JWT
role claim is `owner` or `partner`) has full CRUD grants on every table.
`app_worker` has full CRUD grants on everything *except* `ledger_entries`
and `allocation_rules`, which are `REVOKE`d outright — not filtered by a
row-security policy, actually revoked at the grant level. That distinction
is deliberate: an RLS policy with `USING (false)` still lets a query plan
and execute, returning zero rows, which is indistinguishable from "no
entries exist yet." The brief requires workers to be refused at the
database level, so a worker session querying either table gets a real
`permission denied for table X` from Postgres (SQLSTATE `42501`), mapped by
this service's error handler to a clean `403`.

**Layer 2 — session variables**, set per-request via `SET LOCAL` inside the
request's own transaction (`src/lib/db.ts`, `withTenantScope`):
`app.holding_company_id`, `app.person_id`, `app.person_role`. `SET LOCAL`
specifically, not `SET` — the value is scoped to the transaction and can't
leak across pooled connections between unrelated requests.

**Layer 3 — RLS policies** on every tenant-scoped table
(`migrations/004_row_level_security.js`, extended in `005`), all routed
through a single `SECURITY DEFINER` helper function,
`is_business_visible_to_caller(business_id)`. That function exists for a
specific, previously-hit reason: an earlier version of this migration had
`businesses`' policy query `partnerships` (for partner-narrowing) while
`partnerships`' own policy queried `businesses` (for tenant scoping) — a
two-table cycle. Postgres detects this and refuses to evaluate *either*
policy, for *every* role, with `infinite recursion detected in policy`.
Routing every table's partner-visibility check through one
`SECURITY DEFINER` function (which computes the check once, with
`partnerships`' own RLS bypassed *inside that function specifically*,
because the function runs with its owner's privileges rather than the
caller's) fixes this and means the partner-visibility rule is defined in
exactly one place. If you're adding a new tenant-scoped table, call this
function from its policy rather than writing a new inline
`partnerships`/`businesses` check — that's exactly the pattern that broke
last time.

Partner narrowing itself: an owner or worker session sees every business in
the holding company. A partner session sees only businesses where a
`partnerships` row links their `person_id` to that `business_id` — checked
live against the `partnerships` table on every query, not cached from the
JWT, so a partnership added or removed mid-session takes effect on the very
next request.

## Verifying this yourself

Everything below was actually run against a live Postgres 16 instance
during development, not just reasoned about — including finding and fixing
two real bugs this way (the RLS recursion above, and a Fastify error-handler
ordering issue described in a comment at the top of `src/server.ts`). This
same "actually run it, don't just reason about it" discipline is also what
caught three more bugs later, in the public-landing-page work — see "The
public landing page" section further down for that history; this section
predates it. If you want to confirm the RLS boundary yourself rather than
take this on faith:

```bash
# As the worker seeded by `npm run seed`:
curl http://localhost:3000/ledger-entries?businessId=<id> \
  -H "Authorization: Bearer <worker's token>"
# -> 403 {"error":"forbidden","message":"Insufficient privileges for this operation"}

# As the owner, same business:
curl http://localhost:3000/ledger-entries?businessId=<id> \
  -H "Authorization: Bearer <owner's token>"
# -> 200 []
```

Or directly against Postgres, bypassing the app entirely:

```sql
SET ROLE app_worker;
SELECT * FROM ledger_entries;
-- ERROR:  permission denied for table ledger_entries
```

## API surface

All routes except `POST /auth/login` require `Authorization: Bearer
<token>`. Request/response bodies are camelCase JSON; the database is
snake_case; routes are kebab-case plural nouns, per the shared contract's
naming rules.

| Resource | Routes |
|---|---|
| Auth | `POST /auth/login` |
| Holding companies | `GET/PATCH /holding-companies/:id` (no POST/DELETE — see below), `GET /holding-companies/:id/rollup` |
| Businesses | `GET/POST /businesses`, `GET/PATCH/DELETE /businesses/:id` |
| Business nodes | `GET/POST /business-nodes`, `GET/PATCH/DELETE /business-nodes/:id`, `GET /business-nodes/:id/subtree` |
| People | `GET/POST /people`, `GET/PATCH/DELETE /people/:id` |
| Partnerships | `GET/POST /partnerships`, `GET/PATCH/DELETE /partnerships/:id` |
| Allocation rules | `GET/POST /allocation-rules`, `GET /allocation-rules/current`, `GET /allocation-rules/:id` (no PATCH/DELETE — see below) |
| Ledger entries | `GET /ledger-entries`, `POST /ledger-entries` (no PATCH/DELETE), `GET /ledger-entries/:id` |
| Materials | `GET/POST /materials`, `GET/PATCH/DELETE /materials/:id` |
| Material flows | `GET/POST /material-flows`, `GET/PATCH/DELETE /material-flows/:id` |
| Counterparties | `GET/POST /counterparties`, `GET/PATCH/DELETE /counterparties/:id` |
| Orders | `GET/POST /orders`, `GET/PATCH/DELETE /orders/:id` (`?includeItems=true` to nest line items) |
| Order items | `GET/POST /order-items`, `GET/PATCH/DELETE /order-items/:id` |
| Product stream (public) | `GET /product-stream` — no auth required |
| AI-backed | `POST /product-stream/search` (public), `POST /product-stream/overview` (public), `POST /guides/analyze` (requires JWT), `POST /conversations/:id/ai-reply` (public, visitor-token) |
| Consumer conversations (public) | `POST /conversations`, `GET /conversations/:id`, `POST /conversations/:id/messages`, `POST /conversations/:id/identify`, `POST /conversations/:id/redeem-token` — all token-based, no JWT |
| Conversations (business-side) | `GET /conversations`, `GET/POST /conversations/business/:id`(`/messages`), `GET /conversations/business/:id/routing-candidates`, `POST /conversations/business/:id/claim` |
| Member self-service | `PATCH /people/me/location`, `GET/PUT /people/me/transaction-paths` |

A few of these are deliberately incomplete, not oversights:

- **No `POST /holding-companies`.** Creating a new holding company means
  creating a new tenant before any person or JWT exists for it — there's no
  authenticated caller's `holding_company_id` to scope the insert against,
  unlike every other `POST` route in this service. That's bootstrapping,
  not ordinary authenticated CRUD, and doesn't belong behind a route any
  JWT holder can call. `src/scripts/seed.ts` is the local-dev equivalent;
  see its comments for the reasoning, and adapt it into a real
  signup/provisioning flow before this goes anywhere near production.
- **No `DELETE /holding-companies/:id`.** Cascades to every business,
  person, and ledger entry beneath it. Not reachable from a plain
  authenticated `DELETE` call.
- **No `PATCH`/`DELETE` on `allocation_rules`.** It's an append-only version
  history (`(business_id, version)` is a unique index; `version` is
  auto-assigned on `POST`, not client-supplied). Correcting a mistake means
  posting a new version, not mutating one that past ledger entries may
  already reference via `ledger_entries.allocation_rule_version`.
- **No `PATCH`/`DELETE` on `ledger_entries`.** Same reasoning, standard
  double-entry bookkeeping practice: reverse a mistaken entry with a new
  balanced pair, don't mutate history. `related_entry_id` has `ON DELETE
  RESTRICT`, so a `DELETE` on one half of a pair would be refused by the
  database anyway as long as the other half still references it.

### The two invariants the brief calls out explicitly

**`allocation_rules.splits` must sum to exactly 100.** Enforced in
`src/lib/allocationRules.ts`, inside the same transaction as the insert,
ahead of the write — this can't be a Postgres `CHECK` constraint, since
`jsonb` array contents aren't practically checkable that way. Summed as
integer hundredths-of-a-percent (not floating point), so e.g. three splits
of `33.33`/`33.33`/`33.34` correctly sum to exactly `100.00` rather than
tripping on binary floating-point representation error.

**Every `POST /ledger-entries` must be a balanced debit+credit pair.**
Also not expressible as a table constraint — it's a cross-row invariant
(two rows, equal amount, opposite `entry_type`) and a `CHECK` constraint
only sees the row being written. `POST /ledger-entries` requires the
request body to contain exactly one `debit` and one `credit` object for the
same `businessId`, with exactly matching amounts (compared as decimal
strings, not parsed floats — see the note on money below), and inserts both
rows in a single database transaction, each pointing at the other via
`related_entry_id`. There is no code path where a debit can be persisted
without its matching credit.

### Money

`amount` (on `ledger_entries`) is `numeric(14,2)` in Postgres specifically
so it never touches IEEE 754 float representation. The API preserves that:
`amount` is validated as a string on the way in (`"150.00"`, not `150.00`)
and returned as a string on the way out — never `parseFloat`'d at the API
boundary the way `ownershipPct`/`capitalContributed` are, because those
aren't money in the same sense and doing the same conversion to `amount`
would throw away the precision guarantee the moment it left the database.

### The subtree endpoint

`GET /business-nodes/:id/subtree` returns the node itself plus every
descendant, flattened, each tagged with `depth` relative to the requested
node. Implemented as one `WITH RECURSIVE` query rather than N+1 queries
walking down level by level — both for the single round trip, and because
RLS applies to every row the recursion touches the same way it applies to
any other query on the connection. This was specifically checked, not just
assumed: a partner session recursing into a subtree cannot walk into nodes
belonging to a business they have no `partnerships` row for — confirmed
against a live database by building a real multi-business tree and
querying it as a partner scoped to only one of the businesses (`404`, not a
partial or leaked result).

### Rollup

`GET /holding-companies/:id/rollup` is a live `SUM(...)/GROUP BY` against
`ledger_entries`, joined up through `businesses`, filtered to the requested
holding company, computed fresh on every request — no cache, no
materialized view, no separately-maintained running total anywhere in this
codebase. If that ever needs to change for performance at scale, it should
be a deliberate, documented decision made in this file and in
`src/routes/rollup.ts`'s comment, not a drift introduced by someone
"optimizing" the endpoint later.

## Materials, flows, counterparties, and orders

`materials`, `material_flows`, `counterparties`, `orders`, and
`order_items` — the schema extension covering the physical/commercial
layer — have full CRUD routes (`src/routes/materials.ts`,
`materialFlows.ts`, `counterparties.ts`, `orders.ts`, `orderItems.ts`),
built after the six originally-required resources and following the exact
same pattern as every other route in this codebase (`withDb`,
parameterized queries, one `toApiShape` per resource). A few things worth
knowing that are specific to these five:

**`material_flows` is queryable by `materialId` as much as by
`businessNodeId`.** `GET /material-flows` requires at least one of the two,
not just `businessNodeId` the way most other list endpoints here require
exactly one scoping param — because "which business_nodes consume material
X" is just as core an access pattern as "which materials does this node
use." This was actually exercised, not just designed: a single `materials`
row (whole coconuts) was wired as an `input` flow into two independently
created `business_nodes`, and `GET /material-flows?materialId=<id>&direction=input`
correctly returned both — confirming the contract's specific design point
("one coconut → VCO + desiccated + coir...") holds through the real API,
not just at the schema level.

**`counterparties` supports `?role=` filtering** via `roles @> ARRAY[$1]`,
backed by the GIN index built for this in migration 005. A counterparty
with `roles: ["supplier", "buyer"]` correctly appears in both
`?role=supplier` and `?role=buyer` queries — tested directly, not assumed
from the index existing.

**`GET /orders/:id?includeItems=true`** returns the order with its line
items nested inline, opt-in via query param rather than always-on, so the
plain `GET /orders/:id` stays a single-table query like every other
resource's `:id` route. Building and testing this surfaced a real
inconsistency: the inline `items` array initially returned
`order_items.quantity` as a raw Postgres string (`"1000.0000"`), while
`GET /order-items/:id` returned the identical field as a parsed number
(`1000`) — same column, two different JSON types depending on which route
you hit. Fixed so both paths produce the same type; worth remembering if
you add a third way to reach the same underlying row.

**`total` (orders) and `unitPrice` (order_items)** get the same
decimal-string treatment as `ledger_entries.amount` — see "Money" above —
since both are `numeric(14,2)`. **`quantity`** (order_items) and
**`quantityPerUnit`** (material_flows) are `numeric(14,4)` and are treated
differently: returned as plain JS numbers, not strings, since a quantity
being off by float-epsilon isn't the same class of problem money is. See
the comment at the top of `orderItems.ts` for the full reasoning.

**The `ON DELETE RESTRICT` vs `CASCADE` boundaries were tested, not just
declared.** Deleting a `material` still referenced by an `order_items` row
is refused (`RESTRICT`); deleting an `order` correctly removes its
`order_items` (`CASCADE`) without touching the `materials` they reference.
Testing the `RESTRICT` case surfaced a real, if minor, bug: the shared
`23503` (foreign-key-violation) error handler in `server.ts` originally
said "Referenced record does not exist," which is backwards for this
case — the referenced record very much exists; that's exactly why the
delete was refused. The message now covers both situations that share this
one SQLSTATE (inserting a reference to something missing, and deleting
something still depended on).

Workers have full CRUD on all five of these tables — unlike
`ledger_entries`/`allocation_rules`, none of them are in the
`REVOKE`-restricted set, and this was confirmed with a real worker-token
request, not just read off the `GRANT` statements in migration 005.

## The public landing page: `catalog_meta`, `/product-stream`, and `app_public`

Everything documented above requires a JWT. `GET /product-stream` is the
one deliberate exception — a public, unauthenticated route that feeds the
e-BOS landing page's live circle-stream visualization, meant to be
browsable by an anonymous visitor with no login at all. Building this
correctly needed a genuinely different security mechanism from the rest of
the service, not a smaller version of the existing one, and getting it
right took three real, sequential bugs — each one caught by actually
running the endpoint, not by reading the migrations and deciding they
looked correct. That history is worth knowing before touching any of this.

### Publishing: `materials.catalog_meta`

`materials` (migration 007) has one new nullable column, `catalog_meta
jsonb`. Setting it to a non-null value via the ordinary authenticated
`PATCH /materials/:id` route — `{"catalogMeta": {"icon": "🍞", "category":
"food", "description": "...", "media": {...}}}` — is what publishes a
material to the public landing page. Setting it explicitly to `null`
unpublishes it. `PATCH` distinguishes "not provided" (leave unchanged)
from "provided as `null`" (unpublish) using `Object.hasOwnProperty`, not
the `COALESCE`-on-omitted-value pattern most other fields on this route
use — `null` is a meaningful, intentional value here, not "no change."
Both directions were tested: publishing makes an item appear in
`GET /product-stream` immediately, and unpublishing (explicit `null`)
makes it vanish immediately, confirmed end to end through the real API,
not just at the database layer.

`category`, when present, is validated against the five values the
landing page actually has a color for (`food`, `agriculture`, `energy`,
`manufacturing`, `education`) — a typo fails loudly at publish time rather
than silently defaulting later.

### `GET /product-stream`

Returns `{ items: ProductStreamItem[] }` matching the shape the landing
page's `Backend.fetchSnapshot()` expects. What's real and what isn't,
stated plainly rather than left for someone to discover the field values
don't mean what they'd assume:

- `name`, `businessName` — straight from `materials`/`businesses`.
- `icon`, `category`, `description`, `media` — from `catalog_meta`, i.e.
  whatever the publishing owner/worker set. Not derived from anything.
- `sales` — a live `SUM(order_items.quantity)` across every
  `direction='sale'` order referencing this material. Computed fresh on
  every request, same "live query, not cached" discipline as
  `GET /holding-companies/:id/rollup`.
- `repeatCustomers` — a live `COUNT(DISTINCT counterparty)` among
  customers who placed **more than one** `sale`-direction order
  containing this material. Also live, also real.
- `size`, `visibilityWeight` — **derived**, not stored. `size` normalizes
  `sales + repeatCustomers` to `0..1` **within each business's own
  published catalog**, not globally across the platform — deliberately,
  so a small business's actual best-seller reads as "this business's
  flagship item" rather than shrinking to nothing next to a large
  manufacturer's volume. `visibilityWeight` uses recency of the most
  recent sale (the only real "activity over time" signal this schema
  has) with exponential decay, floored at `0.15` rather than `0` — an
  unsold item should reappear *less*, per the original landing-page spec,
  not *never*. See the long comment above `normalizeForStream()` in
  `src/routes/productStream.ts` for the exact formula and its edge cases
  (a business with one published item, a material with no sales yet).
- `rating` — always `null`. There is no review/rating data anywhere in
  this schema, and returning a plausible-looking fabricated number would
  be worse than admitting it doesn't exist. A real ratings feature needs
  its own table (reviewer identity, timestamp, an auditable score), not a
  number quietly invented inside this endpoint. The frontend needs to
  handle a `null` rating (e.g. hide the star row).

A material only appears here once `catalog_meta IS NOT NULL` — that's the
publish signal, enforced at the RLS layer (see below), not just by this
route's own `WHERE` clause. Even a bug in this route's code couldn't leak
an unpublished material, because the connection it runs on literally
cannot see that row.

### `app_public`: a third Postgres role, and the three bugs building it surfaced

Every other route authenticates as `app_owner_partner` or `app_worker` via
`SET ROLE` after JWT verification (`src/lib/db.ts`). `/product-stream` has
no JWT to verify, so it needed its own connection path from the ground up:
a separate pool (`src/lib/publicDb.ts`), authenticating as
`app_public_login`, which can `SET ROLE` into **only** `app_public` — a
role with `SELECT`-only access to exactly the tables this one query needs
(`materials`, `businesses`, `orders`, `order_items`), gated by its own
`public_catalog` RLS policies that check nothing except "is the relevant
material published." `app_public_login` has no membership path into
`app_owner_partner` or `app_worker` at all, even in principle — confirmed
by trying (`SET ROLE app_owner_partner` from that login correctly returns
`permission denied to set role`).

Building this took three migrations to get right (007–008 got the
mechanism established; 009–011 are the fix history below), and each bug
was the same root lesson resurfacing in a new place — worth reading if
you're ever adding a fourth public-facing table:

1. **Migration 009** granted `app_public` access to `materials` only.
   The real query also joins `businesses` and `orders`/`order_items` (for
   the live sales aggregation) — nothing was granted there. Running the
   actual endpoint failed with `permission denied for table businesses`
   before it even reached the interesting part of the query.
2. **Fixing that** meant giving `orders` and `order_items` their own
   `public_catalog` policies — and the first version had them reference
   *each other* directly (`orders`' policy queries `order_items`,
   `order_items`' policy queries `orders`). That's the exact two-table RLS
   recursion this project already hit once, between `businesses` and
   `partnerships` (see "How RLS actually gets enforced" above) — and
   migration 004's own comment explicitly warns against writing a new
   inline cross-table check instead of routing through a shared helper
   function. It happened again anyway. **Migration 010** fixes it with the
   same `SECURITY DEFINER` pattern: `is_material_published()` and
   `is_order_a_published_sale()`, each computing their check without
   triggering the other table's RLS.
3. Even after the recursion was fixed, `/product-stream` still failed —
   this time with `permission denied for table partnerships`, on a query
   that never touches `partnerships` at all. The actual cause:
   `tenant_isolation` (the policy governing `app_owner_partner`/
   `app_worker`) was narrowed to stop applying to `app_public` on
   `materials` back in migration 008 — but that narrowing was never
   applied to `businesses`, `orders`, or `order_items`. An unnarrowed
   policy still gets *evaluated* for a role it doesn't ultimately restrict
   (Postgres has to check it to know whether to `OR` it in), and
   evaluating `tenant_isolation` means calling
   `is_business_visible_to_caller()`, which queries `partnerships` — a
   table `app_public` has no grant on. **Migration 011** applies the same
   `ALTER POLICY ... TO app_owner_partner, app_worker` narrowing to the
   three tables migration 008 missed.

All three are now confirmed fixed with real, repeated testing: directly
against Postgres as `app_public` (bypassing the app entirely), through the
live HTTP endpoint, through a complete publish→appear /
unpublish→disappear cycle, through a regression pass confirming the
pre-existing tenant-scoped security boundary on `businesses`/`orders`/
`order_items` is completely unaffected, and — the strongest check — a full
migration teardown to empty, rebuild, fresh seed, and an end-to-end flow
using only real authenticated API calls (create a material, publish it,
create a customer and a sale order, check the public stream), confirming
this isn't just working on a database that happens to have accumulated the
right fix history.

## The AI endpoints

The e-BOS landing-page frontend originally called
`https://api.anthropic.com/v1/messages` directly from client-side
JavaScript — no API key, no auth header, no server in between. Anyone who
opened dev tools on that page could read the code and call Anthropic's API
on whatever key eventually backed it, unmetered, as themselves. Three
features routed through it. These routes (`src/routes/ai.ts`) are the fix:
prompts moved server-side, called with `ANTHROPIC_API_KEY` from this
process's own environment — never sent to or knowable by any client —
gated behind this service's normal auth where the original feature
warranted it.

| Route | Auth | Mirrors |
|---|---|---|
| `POST /product-stream/search` | Public (same boundary as browsing the public catalog) | `runAISearch()` |
| `POST /guides/analyze` | Requires JWT (guide upload is part of business creation, an owner action) | `analyzeGuideText()` |
| `POST /product-stream/overview` | Public | `getAIOverview()`, minus `rating` — the frontend's original prompt included it, but this backend's `rating` is always `null` (see above), and forwarding a null rating into the prompt would produce a confused-sounding overview referencing something that isn't there |
| `POST /conversations/:id/ai-reply` | Public, `X-Visitor-Token` (same boundary as every other conversation route) | New — the reception-salesperson, see below |

If `ANTHROPIC_API_KEY` is unset (or left as the `.env.example` placeholder),
all four return a clear `503` rather than a confusing downstream
failure. Every other route in this service works with no Anthropic key
configured at all; only these four need one.

**Not yet verified**: this environment has no real Anthropic API key, so
the guard-clause logic (auth ordering, the `503` fallback, request
validation, the 409 "no new message to reply to" check) is confirmed, but
the actual `fetch` to `api.anthropic.com` — response parsing, behavior on
a real API error, and what the model actually says — is not. If you have
a key to test with, that's the one gap left in this integration.

### The reception-salesperson (`POST /conversations/:id/ai-reply`)

Reads a conversation's message history, builds a scoped picture of what
the business actually has to offer, and replies in character as a warm,
conversational reception-salesperson — written back as a new message with
`sender_type='ai'` (`migrations/017` adds this as a third value alongside
`'visitor'`/`'person'`).

**Honesty about being an AI is enforced two ways, not one.** The system
prompt (`buildReceptionSystemPrompt()`) has its own explicit,
non-negotiable paragraph on this, with a direct instruction not to let it
fade over a long conversation — but a purely prompted behavior is real,
not bulletproof, so there's a structural backstop too:
`messages.is_ai_disclosure` (`migrations/017`) is set by application code,
never by the model's own output, `true` on the first AI message in any
conversation. A frontend can check this flag and render an unconditional
"AI" badge regardless of what the message text itself says — the
disclosure isn't something the model chose to include, it's a fact the
code attaches.

**What the AI actually knows, and the exposure boundary.**
`gatherBusinessContext()` is the one function responsible for "what can
this endpoint possibly tell the model" — it queries exactly three things:
the business's own name, its **published** materials (`catalog_meta IS
NOT NULL` — the identical dataset `GET /product-stream` already exposes
publicly, so this introduces no new exposure), and `knowledge_chunks`
scoped to the business, capped at 8 rows. It never touches `orders`,
`ledger_entries`, `counterparties`, or `people`'s emails. Stated
honestly: **no guide-ingestion pipeline exists yet** to populate
`knowledge_chunks` with real content from an uploaded operating guide —
the retrieval query is real, working code, correctly scoped, and will
correctly return real chunks the moment such a pipeline exists, but as of
this migration it returns nothing for every business, because nothing has
ever written a row to that table. "Knowledge from the guide and product
lines" is honestly the product-lines half only, today.

**A real bug found by testing, not by review**: the first version of this
endpoint checked `ANTHROPIC_API_KEY` availability *before* checking the
visitor token, which meant a request with no token at all still got back a
`503` (revealing whether the AI backend was configured to a caller who
hadn't proven they owned any conversation) instead of the `401` it should
get. Every other guard in this route looked correct in isolation — the
*order* was the bug, the same class of mistake `POST /guides/analyze`
already existed specifically to avoid, just not applied consistently to
this newer endpoint. Fixed: token check now runs first, matching
`/guides/analyze`'s established pattern.

Login needs a password, but the shared contract's `people` table has no
password column, and `people` is a table other codebases build against
verbatim per the brief's "DO NOT DEVIATE FROM THESE NAMES/TYPES"
instruction. Rather than silently extend a contract table, credentials
live in a separate table (`migrations/006_credentials.js`) that isn't part
of the shared contract at all — `person_id` (FK to `people`) plus
`password_hash`. Anything reading `people` through the API still sees
exactly the four contract columns.

This creates a real chicken-and-egg problem worth knowing about:
`people`'s RLS policy requires `app.holding_company_id` to already be set
as a session variable, but at login time that value doesn't exist yet —
nothing has been authenticated. `src/routes/auth.ts` resolves this by
legitimately setting that session variable from the **unauthenticated**
request body's claimed `holdingCompanyId`, then looking up the person by
`(holding_company_id, email)`. If the caller lied about which holding
company they belong to, the lookup simply finds no matching row — the
password check that follows is what actually gates access, exactly like it
would in a service with no multi-tenant structure at all. A wrong password
and a wrong `holdingCompanyId` both fail with the identical generic
`{"error":"invalid_credentials"}`, deliberately, so the endpoint doesn't
leak which case it was.

## Guide ingestion — closing the reception-salesperson's real gap

The AI endpoints section above documented, honestly, that
`knowledge_chunks` was real schema with no pipeline ever writing to it.
`src/routes/guideIngestion.ts` (migrations 018) is that pipeline.

**Why this needed its own credential system, not another `.env` key**:
Anthropic has no embeddings API — this is a hard fact, not a choice this
project made. Embeddings-provider credentials are genuinely different
from `ANTHROPIC_API_KEY`: they're **business-scoped**, owner-supplied, and
can be *any* provider ("could accept any... they follow platform
playbooks" was the actual design brief). `business_integrations`
(migration 018) stores them **encrypted** — AES-256-GCM via
`src/lib/encryption.ts`, genuinely reversible (unlike `credentials`'
password hashing, migration 006, which is one-way by design and solves a
different problem entirely) — because the server has to send the real key
value to the real provider on every ingestion call. `CREDENTIAL_ENCRYPTION_KEY`
is a new required env var, deliberately separate from `JWT_SECRET` — a
signing secret and an encryption key are different jobs.

**The flow**: `POST /businesses/:id/integrations` stores a provider name +
key (encrypted before it touches the database; never echoed back in any
response). `POST /businesses/:id/guides/ingest` takes raw guide text,
splits it into overlapping chunks (`chunkGuideText()` — paragraph-boundary
aware, character-based since this project carries no tokenizer
dependency), calls the business's configured provider once with the whole
batch, and inserts one `knowledge_chunks` row per chunk, all sharing one
fresh `source_guide_id` so a later re-ingestion can cleanly
`DELETE /businesses/:id/guides/:sourceGuideId` the old set first.

Two providers implemented (`callEmbeddingsProvider()`): OpenAI
(`text-embedding-3-small`, matching `knowledge_chunks.embedding`'s
`vector(1536)` column exactly) and Voyage AI (Anthropic's own recommended
embeddings partner, since Anthropic has none itself). Adding a third
provider is a change to that one function, not a schema migration — the
table itself places no restriction on the provider string.

**What's verified, and what genuinely isn't, stated plainly**: `chunkGuideText()`
was run directly against six real test cases (empty input, short input,
realistic multi-paragraph text, overlap-boundary correctness, an
oversized single paragraph, no-data-loss) — all passing. The encryption
round-trip, tamper-rejection, and wrong-key-rejection were each directly
tested with real `crypto` calls. The pgvector literal format
(`callEmbeddingsProvider`'s output feeding `[n,n,n]`-style text into an
`::vector` cast) was checked against pgvector's documented text-input
syntax. What was **not** verified: an actual call to OpenAI's or Voyage's
real embeddings endpoint, and the full route running against a live
Postgres instance end to end — this was built in an environment with no
outbound network access to those providers and no Postgres available to
run migration 018 against. Every other feature in this README was
verified that way before being called done; this one is real, carefully
cross-checked code that has not cleared that same bar yet. The first real
test of this feature should be exactly that: configure a real provider
key, ingest a real guide, and confirm rows land in `knowledge_chunks`
with the right dimension.

## Consumer chat and human handoff

A landing-page visitor can message a business directly — no signup, no
account — and, once they've proven they're a real paying customer, get
routed to a real staff member. Two features, built together because they
share one table pair (`conversations`/`messages`) and one authorization
shape (possession-based tokens, not JWTs):

### Starting a conversation

`POST /conversations` (public, no auth) is the entire "start chatting"
flow: `{businessId, message}` in, a `visitorToken` back — an opaque uuid
the client stores (localStorage, not a cookie — this service sets no
cookies) and presents as `X-Visitor-Token` on every later request to that
thread. There's no recovery flow for a lost token; that's deliberate, not
an oversight — the whole point of a possession-based secret is that
nothing except holding it grants access, and a recovery path would have to
weaken that. `GET /conversations/:id` and
`POST /conversations/:id/messages` are the read/reply side, same token
required. RLS (`visitor_token_access`/`visitor_token_insert`/
`visitor_token_update` policies, `migrations/012` and `014`) is what
actually enforces "you may only touch your own conversation" — the
route-level token checks are a courtesy for clean error messages, not the
real boundary. This was adversarially tested directly against Postgres
before any route code existed: no token, a random unissued token, and even
knowing another visitor's exact conversation `id` are all correctly
refused.

### Identifying (enticed, not required)

`POST /conversations/:id/identify` — `{name, email}` — matches or creates
a real `counterparties` row (tagged `'lead'`) and links it to the
conversation. Delegates entirely to a `SECURITY DEFINER` function,
`identify_conversation()` (`migrations/013`), rather than a direct grant:
an anonymous visitor should never get broad write access to
`counterparties`, only the ability to attach themselves to a conversation
they already own — the function re-verifies token ownership internally
rather than trusting RLS already checked, the same pattern
`is_business_visible_to_caller()` and the material-published checks use.

### The payment-proof token and human handoff

Every `POST /orders` with `direction='sale'` automatically issues a
`transactionToken` (`migrations/015`'s `transaction_tokens` table) — a
real uuid tied to that specific order and counterparty, returned once, in
the order-creation response. A consumer holds onto it and later submits it
via `POST /conversations/:id/redeem-token`. Redemption
(`redeem_transaction_token()`, `migrations/016`, same `SECURITY DEFINER`
pattern as `identify_conversation`) requires **both**: the conversation
must already be identified, and the token must be real, unredeemed, and
belong to the *same* counterparty the conversation identified as — a
correctly-formed, currently-valid token for someone else's purchase is
still refused. All four failure modes were tested directly: redeeming
before identifying, redeeming a token issued for a different consumer,
double-redeeming the same token, and the successful path — each produces
a distinct, honest reason (`not_identified`, `token_belongs_to_different_consumer`,
`token_already_redeemed`) rather than one opaque 403.

A successful redemption flips `conversations.handled_by` from `'ai'` to
`'awaiting_human'`. `GET /conversations/business/:id/routing-candidates`
then surfaces which owner/worker at the business is best positioned to
take it over, and `POST /conversations/business/:id/claim` lets one of
them actually take it (`handled_by` becomes `'staff'`).

**What "closest to the consumer's location" honestly means here.**
Members get real, self-service location (`PATCH /people/me/location`,
`latitude`/`longitude`/`locationLabel`) and a declared service scope
(`PUT /people/me/transaction-paths` — which regions and transaction types
they personally handle, replace-the-whole-set semantics). But there is no
equivalent coordinate for the *consumer* — only a free-text
`consumer_region_label`, meant to be populated by extracting a region from
the natural conversation ("through their conversation with the AI," not a
form field). That means routing-candidates does **region-label matching**,
not geographic distance math: an exact `region_label` match ranks first, a
member who declared no region restriction (handles "anywhere") ranks
second, everyone else last. This was verified directly — a worker with a
matching `transaction_paths` entry correctly outranks an owner with
neither a matching path nor any location set at all, and the response is
honest about it (`hasLocation: false` shown plainly rather than silently
assuming proximity data that doesn't exist). Real nearest-neighbor
distance routing would need real consumer coordinates first (IP lookup, a
shipping address, something) — that's a separate, bigger capability this
feature deliberately doesn't fake.

**What isn't built yet:** the AI itself doesn't generate replies or
extract `consumer_region_label` from conversation — nothing calls the
existing AI infrastructure (`src/routes/ai.ts`) from inside this feature
yet. A human (via `POST /conversations/business/:id/messages`) is
currently the only thing that can reply on the business's behalf; an
AI-authored `sender_type` doesn't exist in the schema, so an "AI handles
routine questions" layer is a genuine next piece, not something silently
assumed to already work.

## Running migrations

```bash
npm run migrate:up      # apply all pending migrations
npm run migrate:down    # roll back the most recent migration (one at a time)
```

Eighteen migrations, applied in order:

1. `001_core_tenancy` — extensions (`pgcrypto`, `vector`),
   `holding_companies`, `businesses`, `people`
2. `002_business_structure` — `business_nodes` (self-referencing tree),
   `partnerships`, `allocation_rules`
3. `003_ledger_and_knowledge` — `ledger_entries`, `knowledge_chunks`
4. `004_row_level_security` — the two Postgres roles, `GRANT`s, RLS
   policies, the `is_business_visible_to_caller` helper function
5. `005_materials_and_orders` — `materials`, `material_flows`,
   `counterparties`, `orders`, `order_items`, plus their RLS policies
6. `006_credentials` — the non-contract credentials table for login
7. `007_catalog_meta` — `materials.catalog_meta`, the landing-page publish
   signal
8. `008_public_catalog_access` — `app_public`/`app_public_login`, the
   `public_catalog` policy on `materials`
9. `009_public_catalog_joins` — extends `app_public` to `businesses`/
   `orders`/`order_items` (see "The public landing page" above for why
   this needed two follow-up migrations to actually work)
10. `010_fix_public_catalog_recursion` — the `SECURITY DEFINER` fix for
    the `orders`↔`order_items` RLS recursion 009 introduced
11. `011_narrow_tenant_isolation_for_public_tables` — completes the
    `tenant_isolation` role-narrowing that 008 only applied to `materials`
12. `012_conversations_and_messages` — `conversations`/`messages`, the
    visitor-token RLS boundary (see "Consumer chat and human handoff"
    above)
13. `013_conversation_identify` — `identify_conversation()`, the
    `SECURITY DEFINER` match-or-create for self-identification
14. `014_grant_conversation_update` — the actual root cause of a long
    debugging session: `conversations` needed an `UPDATE` grant AND
    policy for `app_public` (for bumping `last_message_at`), never just
    `SELECT`/`INSERT`. Every isolated reproduction during that debugging
    session tested only the `INSERT` half of the real request and missed
    it — see this migration's own comment for the full account, worth
    reading before extending this table pair further
15. `015_human_handoff_routing` — member self-service location and
    `transaction_paths`, `transaction_tokens` (the payment-proof table),
    `conversations.handled_by`/`consumer_region_label`/
    `claimed_by_person_id`
16. `016_redeem_transaction_token` — `redeem_transaction_token()`, the
    `SECURITY DEFINER` function enforcing "both identified AND a valid,
    unredeemed, correctly-matched token" before escalation
17. `017_ai_sender_type` — adds `'ai'` as a `messages.sender_type`, and
    `is_ai_disclosure`, the structural (not just prompted) honesty
    backstop for the reception-salesperson (see "The AI endpoints" above)
18. `018_business_integrations` — encrypted, business-scoped third-party
    API key storage (starting with embeddings providers for guide
    ingestion — see "Guide ingestion" above). NOT yet round-trip tested
    against a live database (see that section's own honesty note) —
    every migration 001–017 above was; this is the one exception, stated
    plainly rather than folded silently into the same claim.

Every migration's `down` has been verified against a populated database,
not just written and assumed correct — including a full down-to-empty,
back-up-to-current round trip, most recently after all seventeen were in
place (immediately followed by a fresh reseed and a real end-to-end flow
through the actual API, not just confirming the schema reconstructs). Real
bugs were found and fixed this way, not just theorized about: the `004`
down migration originally tried `DROP ROLE` before revoking that role's
table grants (Postgres refuses with error `2BP01`, "role cannot be dropped
because some objects depend on it"), and separately tried to revoke
`EXECUTE` on the helper function *after* already dropping it — both now
ordered correctly, `REVOKE` before `DROP` throughout. Migrations 009–011
are their own three-bug history, walked through in detail in "The public
landing page" section above; worth reading before adding a fourth
public-facing table, since the same recursion and narrowing mistakes are
easy to reintroduce in a new spot even with the first instance documented
in migration 004's own comments.

## Project layout

```
migrations/            node-pg-migrate migrations, literal SQL (see above)
src/
  lib/
    db.ts               connection pool + withTenantScope (the SET ROLE / SET LOCAL mechanics)
    publicDb.ts          separate pool + withPublicAccess, for GET /product-stream only
    allocationRules.ts  the sum-to-100 validation
  plugins/
    auth.ts              JWT verification, fastify.authenticate
    tenantContext.ts      withDb — wires a JWT's claims into a tenant-scoped DB client
  routes/                one file per resource, all following the same withDb pattern
                          (except productStream.ts and ai.ts's public routes, which use
                          withPublicAccess or nothing — see "The public landing page" above)
  scripts/
    seed.ts               local dev seed data
  server.ts               wiring, centralized Postgres-error-code -> HTTP-status mapping
```

## Known limitations / things to decide before production

- `JWT_SECRET` and the `app_login`/`app_public_login` Postgres passwords
  in `.env.example` are dev-only placeholders — rotate all three for any
  real deployment.
- No rate limiting on `POST /auth/login`, or on any of the public routes
  (`GET /product-stream`, `POST /product-stream/search`,
  `POST /product-stream/overview`). The last two call Anthropic's API on
  this server's own key with no per-visitor limit — worth adding before
  this is exposed to real traffic, since an unmetered public AI endpoint
  is a real cost/abuse surface even though the API key itself is no
  longer exposed to the client.
- No refresh-token flow; JWTs are issued with a 12-hour expiry and that's
  the whole story right now.
- The three AI endpoints (`src/routes/ai.ts`) are verified for their
  guard-clause logic (auth ordering, the `503` fallback when
  `ANTHROPIC_API_KEY` is unset, request validation) but not against a
  real Anthropic API call — this environment has no real key to test
  with. If you have one, that's the one gap left in this integration.
- The `knowledge_chunks` table (for the RAG/guide-upload pipeline) has no
  routes at all yet — nothing in the brief asked for that surface, and
  it's a genuinely different kind of endpoint (embedding generation,
  similarity search) than the CRUD pattern everything else here follows.
- The landing-page frontend this backend now integrates with
  (`Backend.fetchSnapshot()` / `connectStream()`) also expects a
  WebSocket subscription for live updates (`stream.item.upsert` events) —
  this backend only implements the REST snapshot half
  (`GET /product-stream`), not a WebSocket push channel. This is a real,
  unresolved gap, not a soft one: the frontend's own comment is explicit
  that "the client code below never polls; it reads a snapshot once, then
  only ever reacts to pushed events" — there's no documented fallback to
  re-fetching `GET /product-stream` on an interval if no WebSocket
  connects. As it stands, wiring this backend in as-is would mean the
  landing page shows one static snapshot at load and never updates again,
  unless the frontend is changed to poll (a frontend-side change, not
  something this backend can paper over) or a real WebSocket channel is
  built here. That's a separate, larger piece of work than the
  security/integration gaps this session addressed, and wasn't built.
