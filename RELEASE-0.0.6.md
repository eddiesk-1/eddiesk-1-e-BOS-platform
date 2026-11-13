# e-BOS 0.0.6 — release notes, upgrade and rollback

Baseline: 0.0.5 (18 migrations). This release: **21 migrations** (019-021).
Git: this archive has no `.git`. Commit it, then `git tag v0.0.6`.
(If your pitch deck says "17 migrations" or "18", it is now **21**. The deck was not in the
archive, so it has not been touched.)

## What you can now do

| Area | Change |
|---|---|
| **Accounts** | Real business registration (`POST /auth/signup`) creates a holding company, its first business, the first owner, a business profile (category, country, city, address, description, phone) in one transaction. Email must be confirmed before sign-in. Forgot/reset password. Sign in with **email + password only** — no holding-company UUID (it is only asked for when one email belongs to several companies). Progressive lockout. Change password. Sign out everywhere. Owner invitations (`POST /people/:id/invite`). |
| **Sessions** | HttpOnly + SameSite=Strict (+ Secure) cookie; bearer tokens still accepted for API clients; CSRF header guard on cookie writes; token versioning for revocation. |
| **Hardening** | Rate limits on login, signup, email-sending, chat, AI and checkout routes plus a global per-IP ceiling; security headers incl. CSP and HSTS; `/ready` (checks both DB pools) beside `/health`; startup validation of all secrets; graceful shutdown; request-header redaction in logs; framework 4xx no longer reported as 500; seed refuses production. |
| **Human handoff** | A conversation that needs a person (token redeemed, visitor asks, complaint, pricing, AI unsure) now creates **in-app notifications** for eligible staff (bell, 30 s polling) **and emails them**; the inbox shows why. |
| **AI chat** | The reply path is rewritten (see audit D1). Guide chunks are chosen by Postgres full-text relevance, not "the first 8"; retrieval depth (1-20) and auto-escalation are saved per business from the back office; region is inferred from the visitor's words (rule-based) so routing can trigger; the AI escalates on pricing / complaints / low confidence and can't act without a person. |
| **Checkout** | Prices on materials; Paystack hosted checkout; signed webhook + server-side verification; idempotent; amount/currency re-checked; the payment token is released to the chat only after a confirmed payment. **Off until `PAYSTACK_SECRET_KEY` is set.** |
| **Back office** | Edit/delete materials; price, icon, image and video links; create people (+ invite) and partnerships; add another business; one-line summary on every card; notification bell; real retrieval-depth slider. |
| **Design** | Floating, pill-shaped "liquid glass" in light and dark (follows the device, sun/moon toggle remembers the choice) across the storefront, search bar, dropdowns, sheets, dialogs and back office. No third-party fonts or CDNs. |

## Database migrations (all additive; each has a written `down`)

* **019_accounts_and_auth** — `account_security`, `auth_tokens` (no grants, functions only), `auth_*` functions, `business_profiles`, `diag_owner_bypasses_rls()`. Back-fills every existing person as email-verified (briefly lifting FORCE RLS on `people` inside the migration transaction, restored in the same transaction).
* **020_chat_ai_and_notifications** — `conversations.handoff_reason/handoff_at/handoff_notified_at`, full-text index on `knowledge_chunks`, `business_ai_settings`, `notifications`, `chat_*` functions.
* **021_payments** — `payments`, `payment_events`, `checkout_create`, `payment_apply_event`, `payment_visitor_view`.

**Never executed against Postgres in the environment this was written in.** Run them on a copy first.

## API added or changed

New: `POST /auth/signup`, `/auth/verify-email`, `/auth/resend-verification`, `/auth/forgot-password`, `/auth/reset-password`, `/auth/change-password`, `/auth/logout`, `/auth/logout-everywhere`, `GET /auth/session`; `POST /people/:id/invite`; `GET /notifications`, `POST /notifications/read`; `GET|PUT /businesses/:id/ai-settings`; `GET /checkout/config`, `POST /checkout`, `POST /checkout/:ref/verify`, `GET /checkout/:ref`; `GET /orders/:id/payments`; `POST /webhooks/paystack`; `GET /ready`; `GET /` serves the landing page.
Changed (backward compatible unless noted): `POST /auth/login` — `holdingCompanyId` now optional; may answer 403 `email_not_verified`, 409 `choose_company`, 429. Response still has `token` + `person`. **Old tokens are refused once** (see upgrade). `POST /conversations/:id/ai-reply` may answer 409 when a person already has the chat; its response gains `handoff`. `catalogMeta` accepts `price`, `currency`; media links must be https. Conversation objects gain `handoffReason`, `handoffAt`. `GET /product-stream` items gain `price`, `currency` and no longer count unpaid checkout orders as sales.

## Security implications (summary — details in docs/AUDIT-0.0.6.md)

Tenant isolation is not weakened: signup mints the new tenant id server-side and works through the existing RLS policies; the auth tables are reachable only through narrow functions; every new SECURITY DEFINER function pins `search_path`, is revoked from PUBLIC and granted to one named role (checked by a test). New dependency count: **zero** (lockfile untouched).

## Upgrade

See DEPLOY.md → "Upgrading to 0.0.6". Short version: snapshot the DB; set `NODE_ENV=production` and `APP_BASE_URL` (+ email variables if you want signup); deploy; everyone signs in once more; set the health check path to `/ready`; read the "Database role requirement" log line if it appears.

## Rollback

1. **Fastest:** redeploy the 0.0.5 build. The schema changes are additive and 0.0.5 ignores them, so it runs unchanged (its AI reply path is still broken, as before; users sign in again).
2. **Undo the schema** (only if needed): `npm run migrate:down` three times (21 → 20 → 19). This **drops** registration profiles, notifications, AI settings, payments, payment events, verification/reset tokens and lockout/session state — taken together with an incoming `pg_restore` of the pre-upgrade snapshot it is the only fully clean return.
3. Accounts registered under 0.0.6 stay in the database after an app-only rollback. 0.0.5's login still
   needs the holding-company UUID, so those owners can sign in only if they know it; 0.0.5 ignores the
   verified flag.

## Not done (so nothing is assumed)

Platform-administrator console, subscriptions/billing, refunds, payment-provider choice beyond Paystack, object storage / image upload (media is https links), real-time chat and push (polling only), per-business AI cost metering/quotas, owner-supplied chat/search AI keys, distance-based routing, public business profile pages / ratings / pagination, an in-app feedback button, MFA, data export / account deletion, privacy notice and terms, order items / material flows / product-line tree screens, adaptive card order (you chose fixed), iOS-style screen transitions. Semantic (embedding) search at chat time: **not done** — the public database role cannot read a business's provider key by design, so ranking uses Postgres full-text instead. Terms/consent text for Ghana's data-protection rules needs a lawyer, not code.

## Test results (honest)

* `npm test` — 109 tests: **108 pass, 0 fail, 1 skipped** (the database suite, which needs `TEST_*` URLs).
* `tools/browser-test.mts` — **32 pass, 0 fail**: real Chromium against a faked API (desktop and an *emulated* Pixel 5).
* Smoke tests — `ReferenceErrors: 0` for both pages.
* Type-check — clean against stub declarations; real `npm run build` not run here.
* Not run anywhere: migrations on Postgres, database tests, email, Paystack, Anthropic, OpenAI/Voyage, real devices, Opera/Firefox/Safari.
