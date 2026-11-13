# 0.0.6 technical audit (what was found, what was done)

Method: full read of the 0.0.5 backend (19 routes, 18 migrations, 2 frontends), then tests where a test
was possible. **"Found by reading"** means nothing was executed; **"reproduced"** means it was observed running.

## Defects in 0.0.5

| # | Finding | How found | Status |
|---|---|---|---|
| D1 | `POST /conversations/:id/ai-reply` could not work: the public role has no SELECT on `knowledge_chunks` and the only public INSERT policy on `messages` demands `sender_type='visitor'`. It was never reached in testing because the API-key gate comes first. | by reading | Fixed with narrow SECURITY DEFINER functions (migration 020). **Unverified against a database.** |
| D2 | Landing: opening the chat threw `Cannot set properties of null (setting 'handledBy')` on first open, so the chat panel never opened. | **reproduced** in Chromium on the original file | Fixed; covered by a browser test. |
| D3 | Landing "Get this" showed "Added ✓" and did nothing; the Create/Join dialogs showed success without sending anything. | by reading, confirmed in the page | Replaced by real checkout / registration / a real chat message. |
| D4 | Back office: any 401, including a wrong password, reloaded the page, so a failed sign-in showed nothing. | by reading | Fixed; covered by a browser test. |
| D5 | Voyage embeddings (1024-d at time of writing) cannot be inserted into `vector(1536)`. | by reading | Zero-padded (lossless for cosine) or refused with a clear message; `npm run verify:embeddings` lets you check your key. |
| D6 | Malformed JSON / oversized bodies were reported as HTTP 500. | by reading | Now 4xx. |
| D7 | Public endpoints that call Anthropic had no rate limits or size bounds (cost exposure). | by reading | Limited per IP and per conversation; inputs bounded. |
| D8 | `npm test` pointed at a file that did not exist. | ran it | Tests added. |
| D9 | Dashboard showed `$` on ledger totals; the ledger records no currency. | by reading | `$` removed, with an explicit note. |
| D10 | Seed script would create publicly known passwords if run against production. | by reading | Refuses when `NODE_ENV=production`. |
| D11 | Landing "Upload Guide" claimed PDF/Word support that does not exist. | by reading | Text corrected; `.md`/`.txt` really analysed. |
| **D12 (open)** | Migration 015 gives the public role SELECT on `people` with `USING (true)`: every person's email is readable by anything that can run SQL as that role. Only server code can reach it today, and no route selects it for visitors, but it is wider than it needs to be. | by reading | **Not changed** (changing it risks routing); recommended follow-up: expose only the routing columns through a view or function. |

## Security work

Rate limiting (in-memory), security headers + CSP (still `'unsafe-inline'` for scripts and styles because
the frontends are single HTML files — the cost of that architecture), HttpOnly SameSite=Strict cookie
sessions with a CSRF header guard, token versioning for revocation, bcrypt 12 for new passwords,
password policy incl. the 72-byte bcrypt limit, progressive lockout, enumeration-safe signup/reset/login
responses (same body and status; login also equalises timing — signup and reset can still differ in
response time, e.g. creating an account does extra work, which a determined attacker could measure), single-use hashed expiring tokens
that travel in URL fragments (not logged), secrets validated at startup, `Cache-Control: no-store` on
JSON, log redaction of credentials, https-only media links, graceful shutdown, `/ready`.

Tenant isolation: new tenant tables use RLS; the two auth tables have no grants and no policies and
are function-only; every new SECURITY DEFINER function pins `search_path` and is revoked from PUBLIC
(asserted by tests). Signup mints the new holding-company id on the server and scopes the transaction
to it, so a caller can neither choose nor see an existing tenant's id.

## Residual risks, stated plainly

* Everything database-side is **unexecuted**. Treat migrations 019-021 as unverified until run on a copy.
* SECURITY DEFINER functions need the migration user to bypass RLS (DEPLOY.md). Startup self-check logs it.
* Rate limits are per instance; locking a known email's account for up to 15 minutes by failing on purpose is possible.
* Revocation can lag ≤ 15 s across instances; a copied token survives "Sign out" on one device until expiry (12 h) unless you use "Sign out everywhere".
* The AI can mis-classify; escalation heuristics are keyword-based and will sometimes hand over too early or too late.
* The webhook raw-body parser override relies on Fastify's per-plugin content-type-parser scoping; confirm with Paystack's "send test webhook" before trusting it.
* Emails/links assume `APP_BASE_URL` is right; a wrong value sends users to the wrong host.

## Things this release deliberately did not claim

Statutory tax/accounting compliance, Ghana data-protection compliance, PCI scope (card data never touches
this server — Paystack's hosted page handles it), and multi-device browser support beyond Chromium.
