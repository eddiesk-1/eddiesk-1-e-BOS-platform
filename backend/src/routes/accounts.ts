import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { withAuthFunctions, scopeToHoldingCompany, withTenantScope } from '../lib/db.js';
import { withDb } from '../plugins/tenantContext.js';
import { forgetSessionVersion, startSession } from '../plugins/auth.js';
import { hashPassword, verifyPassword } from '../lib/passwordHash.js';
import { checkPasswordStrength } from '../lib/password.js';
import { generateToken, hashToken, looksLikeToken } from '../lib/tokens.js';
import {
  BUSINESS_CATEGORIES, cleanText, isBusinessCategory, isUuid, normalizeEmail, normalizePhone,
} from '../lib/validate.js';
import {
  emailEnabled, existingAccountMessage, inviteMessage, resetPasswordMessage, sendEmail, verifyEmailMessage,
} from '../lib/email.js';
import { limits } from '../lib/limits.js';
import { byIp, rateLimitHook } from '../lib/rateLimit.js';

const VERIFY_TTL_MINUTES = 24 * 60;
const RESET_TTL_MINUTES = 60;
const INVITE_TTL_MINUTES = 7 * 24 * 60;
const STALE_UNVERIFIED_MS = 24 * 60 * 60 * 1000;

function baseUrl(): string {
  const configured = (process.env.APP_BASE_URL ?? '').replace(/\/+$/, '');
  return configured || `http://localhost:${process.env.PORT ?? 3000}`;
}

// Links use the URL FRAGMENT (#verify=..., #reset=...). Fragments are never
// sent to servers, so the token cannot appear in access logs, proxies or
// Referer headers; the page reads it with JavaScript and POSTs it.
const verifyLink = (t: string) => `${baseUrl()}/#verify=${t}`;
const resetLink = (t: string) => `${baseUrl()}/#reset=${t}`;
const signInLink = () => `${baseUrl()}/e-bos-backoffice.html`;
const forgotLink = () => `${baseUrl()}/e-bos-backoffice.html#forgot`;

interface CandidateRow {
  person_id: string;
  holding_company_id: string;
  email_verified: boolean;
  created_at: Date;
}

/** name + company of one person, read under that person's own tenant. */
async function describePerson(
  client: PoolClient,
  hcId: string,
  personId: string,
): Promise<{ name: string; company: string } | null> {
  await scopeToHoldingCompany(client, hcId);
  const r = await client.query<{ name: string; company: string }>(
    `SELECT p.name AS name, h.name AS company
     FROM people p JOIN holding_companies h ON h.id = p.holding_company_id
     WHERE p.id = $1 AND p.holding_company_id = $2`,
    [personId, hcId],
  );
  return r.rows[0] ?? null;
}

async function issueToken(client: PoolClient, personId: string, purpose: string, ttlMinutes: number): Promise<string> {
  const token = generateToken();
  await client.query('SELECT auth_issue_token($1, $2, $3, $4)', [personId, purpose, hashToken(token), ttlMinutes]);
  return token;
}

const SIGNUP_ACCEPTED = {
  status: 'check_email',
  message:
    'If this email address can be registered, we have sent a confirmation link to it. ' +
    'Open that email to activate your account. (If you already have an account, sign in instead.)',
} as const;

const GENERIC_ACCEPTED = {
  status: 'accepted',
  message: 'If an account exists for that email address, we have sent it an email.',
} as const;

interface SignupBody {
  fullName?: string;
  email?: string;
  phone?: string;
  password?: string;
  businessName?: string;
  category?: string;
  country?: string;
  city?: string;
  address?: string;
  description?: string;
}

export default async function accountRoutes(fastify: FastifyInstance) {
  // ------------------------------------------------------------------
  // POST /auth/signup — real business registration.
  //
  // Creates, in ONE transaction: a holding company, its first business,
  // the first owner (role 'owner'), that owner's password credentials and
  // the business profile. Identifiers are generated server-side.
  //
  // This is the one place a tenant is created from nothing. It works
  // inside the existing RLS model, not around it: the server mints the new
  // holding company's UUID itself, scopes the transaction to that UUID,
  // and RLS then only permits rows belonging to it. A caller cannot
  // choose, or even see, an existing tenant's id through this route.
  //
  // The account cannot sign in until the emailed link is used.
  // The response never says whether the email was already registered.
  // ------------------------------------------------------------------
  fastify.post<{ Body: SignupBody }>(
    '/auth/signup',
    { preHandler: [rateLimitHook(limits.signup, byIp)] },
    async (request, reply) => {
      const b = request.body ?? ({} as SignupBody);
      const fields: Record<string, string> = {};

      const fullName = cleanText(b.fullName, 100);
      if (!fullName || fullName.length < 2) fields.fullName = 'Enter your full name.';
      const email = normalizeEmail(b.email);
      if (!email) fields.email = 'Enter a valid email address.';
      const phone = normalizePhone(b.phone);
      if (!phone) fields.phone = 'Enter a valid phone number (for Ghana: 024 123 4567, or +country code for others).';
      const businessName = cleanText(b.businessName, 120);
      if (!businessName || businessName.length < 2) fields.businessName = 'Enter your business name.';
      if (!isBusinessCategory(b.category)) fields.category = `Choose a category (${BUSINESS_CATEGORIES.join(', ')}).`;
      const country = cleanText(b.country, 60);
      if (!country) fields.country = 'Enter your country.';
      const city = cleanText(b.city, 80);
      if (!city) fields.city = 'Enter your city or town.';
      const address = cleanText(b.address, 200);
      if (!address) fields.address = 'Enter your business address.';
      const description = cleanText(b.description, 1000);
      if (!description || description.length < 10) fields.description = 'Describe your business in a sentence or two (at least 10 characters).';

      const strength = checkPasswordStrength(b.password, { email: email ?? undefined, name: fullName ?? undefined });
      if (!strength.ok) fields.password = strength.problems.join(' ');

      if (Object.keys(fields).length > 0) {
        reply.code(400).send({ error: 'validation', message: 'Please correct the highlighted fields.', fields });
        return;
      }
      // All narrowed above; assertions keep the type checker honest.
      const e = email as string;
      const p = phone as string;
      const name = fullName as string;
      const biz = businessName as string;

      if (!limits.signupEmail.check(e).allowed) {
        reply.code(429).send({ error: 'rate_limited', message: 'Too many registration attempts for this email. Try again tomorrow.' });
        return;
      }
      if (!emailEnabled()) {
        // Without email nobody could ever verify, and unverifiable accounts
        // would pile up. Refuse honestly rather than create dead accounts.
        reply.code(503).send({
          error: 'email_unavailable',
          message: 'Registration is temporarily unavailable: this server is not able to send confirmation emails yet.',
        });
        return;
      }

      // ---- duplicate handling (enumeration-safe: same response either way)
      const dup = await withAuthFunctions(async (client) => {
        const found = await client.query<CandidateRow>('SELECT * FROM auth_resolve_candidates($1)', [e]);
        const rows = found.rows;
        if (rows.some((r) => r.email_verified)) return { kind: 'verified' as const };
        const fresh = rows.find((r) => Date.now() - new Date(r.created_at).getTime() < STALE_UNVERIFIED_MS);
        if (fresh) {
          const who = await describePerson(client, fresh.holding_company_id, fresh.person_id);
          const token = await issueToken(client, fresh.person_id, 'verify_email', VERIFY_TTL_MINUTES);
          return { kind: 'resend' as const, token, name: who?.name ?? name };
        }
        return { kind: 'new' as const };
      });

      if (dup.kind === 'verified') {
        void sendEmail(existingAccountMessage(e, signInLink(), forgotLink()))
          .then((r) => { if (!r.sent) request.log.warn({ provider: r.provider }, 'existing-account email not sent'); });
        reply.code(202).send(SIGNUP_ACCEPTED);
        return;
      }
      if (dup.kind === 'resend') {
        const r = await sendEmail(verifyEmailMessage(e, dup.name, verifyLink(dup.token)));
        if (!r.sent) request.log.warn({ provider: r.provider }, 'verification email not sent');
        reply.code(202).send(SIGNUP_ACCEPTED);
        return;
      }

      // ---- create the tenant
      const hcId = randomUUID();
      const businessId = randomUUID();
      const personId = randomUUID();
      const passwordHash = await hashPassword(b.password as string);
      let token = '';

      await withTenantScope({ holdingCompanyId: hcId, personId, personRole: 'owner' }, async (client) => {
        await client.query(`INSERT INTO holding_companies (id, name) VALUES ($1, $2)`, [hcId, biz]);
        await client.query(`INSERT INTO businesses (id, holding_company_id, name) VALUES ($1, $2, $3)`, [businessId, hcId, biz]);
        await client.query(
          `INSERT INTO people (id, holding_company_id, name, role, email) VALUES ($1, $2, $3, 'owner', $4)`,
          [personId, hcId, name, e],
        );
        await client.query(`INSERT INTO credentials (person_id, password_hash) VALUES ($1, $2)`, [personId, passwordHash]);
        await client.query(
          `INSERT INTO business_profiles (business_id, category, country, city, address, description, phone)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [businessId, b.category, country, city, address, description, p],
        );
        await client.query('SELECT auth_set_phone($1, $2)', [personId, p]);
        token = await issueToken(client, personId, 'verify_email', VERIFY_TTL_MINUTES);
      });

      const sent = await sendEmail(verifyEmailMessage(e, name, verifyLink(token)));
      if (!sent.sent) {
        // The account exists and is unverifiable until a mail arrives; the
        // user can use "resend". Log the provider, never the token.
        request.log.warn({ provider: sent.provider, error: sent.error }, 'verification email not sent after signup');
      }
      reply.code(202).send(SIGNUP_ACCEPTED);
    },
  );

  // ------------------------------------------------------------------
  // POST /auth/verify-email { token }
  // ------------------------------------------------------------------
  fastify.post<{ Body: { token?: string } }>(
    '/auth/verify-email',
    { preHandler: [rateLimitHook(limits.tokenAttempts, byIp)] },
    async (request, reply) => {
      const token = request.body?.token;
      if (!looksLikeToken(token)) {
        reply.code(400).send({ error: 'invalid_token', message: 'This link is invalid or has expired. Request a new one.' });
        return;
      }
      const ok = await withAuthFunctions(async (client) => {
        const r = await client.query<{ person_id: string }>(
          'SELECT person_id FROM auth_consume_token($1, $2)',
          [hashToken(token), 'verify_email'],
        );
        if (r.rows.length === 0) return false;
        await client.query('SELECT auth_mark_verified($1)', [r.rows[0].person_id]);
        return true;
      });
      if (!ok) {
        reply.code(400).send({ error: 'invalid_token', message: 'This link is invalid or has expired. Request a new one.' });
        return;
      }
      reply.send({ verified: true, message: 'Your email is confirmed. You can sign in now.' });
    },
  );

  // ------------------------------------------------------------------
  // POST /auth/resend-verification { email } — always 202.
  // ------------------------------------------------------------------
  fastify.post<{ Body: { email?: string } }>(
    '/auth/resend-verification',
    { preHandler: [rateLimitHook(limits.emailActions, byIp)] },
    async (request, reply) => {
      const email = normalizeEmail(request.body?.email);
      if (!email) {
        reply.code(400).send({ error: 'bad_request', message: 'Enter a valid email address.' });
        return;
      }
      if (!limits.emailActionsEmail.check('resend:' + email).allowed || !emailEnabled()) {
        reply.code(202).send(GENERIC_ACCEPTED);
        return;
      }
      const jobs = await withAuthFunctions(async (client) => {
        const found = await client.query<CandidateRow>('SELECT * FROM auth_resolve_candidates($1)', [email]);
        const out: Array<{ token: string; name: string }> = [];
        for (const c of found.rows.filter((r) => !r.email_verified)) {
          const who = await describePerson(client, c.holding_company_id, c.person_id);
          const token = await issueToken(client, c.person_id, 'verify_email', VERIFY_TTL_MINUTES);
          out.push({ token, name: who?.name ?? 'there' });
        }
        return out;
      });
      for (const j of jobs) {
        const r = await sendEmail(verifyEmailMessage(email, j.name, verifyLink(j.token)));
        if (!r.sent) request.log.warn({ provider: r.provider }, 'verification email not sent');
      }
      reply.code(202).send(GENERIC_ACCEPTED);
    },
  );

  // ------------------------------------------------------------------
  // POST /auth/forgot-password { email } — always 202.
  // One email per account carrying that address (it can exist in several
  // companies), each naming its company.
  // ------------------------------------------------------------------
  fastify.post<{ Body: { email?: string } }>(
    '/auth/forgot-password',
    { preHandler: [rateLimitHook(limits.emailActions, byIp)] },
    async (request, reply) => {
      const email = normalizeEmail(request.body?.email);
      if (!email) {
        reply.code(400).send({ error: 'bad_request', message: 'Enter a valid email address.' });
        return;
      }
      if (!limits.emailActionsEmail.check('forgot:' + email).allowed || !emailEnabled()) {
        reply.code(202).send(GENERIC_ACCEPTED);
        return;
      }
      const jobs = await withAuthFunctions(async (client) => {
        const found = await client.query<CandidateRow>('SELECT * FROM auth_resolve_candidates($1)', [email]);
        const out: Array<{ token: string; name: string }> = [];
        for (const c of found.rows) {
          const who = await describePerson(client, c.holding_company_id, c.person_id);
          const token = await issueToken(client, c.person_id, 'reset_password', RESET_TTL_MINUTES);
          out.push({ token, name: who ? `${who.name} (${who.company})` : 'there' });
        }
        return out;
      });
      for (const j of jobs) {
        const r = await sendEmail(resetPasswordMessage(email, j.name, resetLink(j.token)));
        if (!r.sent) request.log.warn({ provider: r.provider }, 'reset email not sent');
      }
      reply.code(202).send(GENERIC_ACCEPTED);
    },
  );

  // ------------------------------------------------------------------
  // POST /auth/reset-password { token, password }
  // Serves both password-reset links and staff invitations (an invitation
  // is "choose your first password"). Using the link proves the person
  // controls the mailbox, so it also marks the email verified.
  //
  // Token consumption and the password change share ONE transaction: if
  // the new password is rejected afterwards (it must not contain the
  // person's own name or email), the transaction rolls back and the link
  // still works for another attempt.
  // ------------------------------------------------------------------
  fastify.post<{ Body: { token?: string; password?: string } }>(
    '/auth/reset-password',
    { preHandler: [rateLimitHook(limits.tokenAttempts, byIp)] },
    async (request, reply) => {
      const { token, password } = request.body ?? {};
      if (!looksLikeToken(token)) {
        reply.code(400).send({ error: 'invalid_token', message: 'This link is invalid or has expired. Request a new one.' });
        return;
      }
      const generic = checkPasswordStrength(password);
      if (!generic.ok) {
        reply.code(400).send({ error: 'weak_password', message: generic.problems.join(' '), problems: generic.problems });
        return;
      }
      const newHash = await hashPassword(password as string);

      // Thrown to make withAuthFunctions roll the whole transaction back —
      // including the token consumption — so the link stays usable.
      class WeakPassword extends Error {
        constructor(readonly problems: string[]) {
          super('weak password');
        }
      }

      type Result = { kind: 'ok' } | { kind: 'invalid' } | { kind: 'weak'; problems: string[] };
      let result: Result;
      try {
        result = await withAuthFunctions<Result>(async (client) => {
          let consumed = await client.query<{ person_id: string; holding_company_id: string; email: string }>(
            'SELECT * FROM auth_consume_token($1, $2)', [hashToken(token), 'reset_password'],
          );
          if (consumed.rows.length === 0) {
            consumed = await client.query('SELECT * FROM auth_consume_token($1, $2)', [hashToken(token), 'invite']);
          }
          if (consumed.rows.length === 0) return { kind: 'invalid' };
          const { person_id: personId, holding_company_id: hcId, email } = consumed.rows[0];

          const who = await describePerson(client, hcId, personId);
          const contextual = checkPasswordStrength(password, { email, name: who?.name });
          if (!contextual.ok) throw new WeakPassword(contextual.problems);

          await client.query(
            `INSERT INTO credentials (person_id, password_hash) VALUES ($1, $2)
             ON CONFLICT (person_id) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
            [personId, newHash],
          );
          await client.query('SELECT auth_mark_verified($1)', [personId]);
          await client.query('SELECT auth_clear_lockout($1)', [personId]);
          await client.query('SELECT auth_revoke_sessions($1)', [personId]); // every old session dies
          forgetSessionVersion(personId);
          return { kind: 'ok' };
        });
      } catch (err) {
        if (err instanceof WeakPassword) result = { kind: 'weak', problems: err.problems };
        else throw err;
      }

      if (result.kind === 'invalid') {
        reply.code(400).send({ error: 'invalid_token', message: 'This link is invalid or has expired. Request a new one.' });
        return;
      }
      if (result.kind === 'weak') {
        reply.code(400).send({ error: 'weak_password', message: result.problems.join(' '), problems: result.problems });
        return;
      }
      reply.send({ reset: true, message: 'Your password has been changed. You can sign in now.' });
    },
  );

  // ------------------------------------------------------------------
  // POST /auth/change-password { currentPassword, newPassword }
  // Signed-in users. Revokes every other session and keeps this one alive
  // by issuing a fresh token.
  // ------------------------------------------------------------------
  fastify.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    '/auth/change-password',
    { preHandler: [fastify.authenticate, rateLimitHook(limits.login, byIp)] },
    withDb(async (request, reply) => {
      const { currentPassword, newPassword } = request.body ?? {};
      if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
        reply.code(400).send({ error: 'bad_request', message: 'currentPassword and newPassword are required' });
        return;
      }
      const me = await request.db.query<{ name: string }>(`SELECT name FROM people WHERE id = $1`, [request.user.personId]);
      const strength = checkPasswordStrength(newPassword, { email: request.user.email, name: me.rows[0]?.name });
      if (!strength.ok) {
        reply.code(400).send({ error: 'weak_password', message: strength.problems.join(' '), problems: strength.problems });
        return;
      }
      const cred = await request.db.query<{ password_hash: string }>(
        `SELECT password_hash FROM credentials WHERE person_id = $1`, [request.user.personId],
      );
      if (cred.rows.length === 0 || !(await verifyPassword(currentPassword, cred.rows[0].password_hash))) {
        reply.code(403).send({ error: 'invalid_credentials', message: 'Your current password is not correct.' });
        return;
      }
      const hash = await hashPassword(newPassword);
      await request.db.query(`UPDATE credentials SET password_hash = $2 WHERE person_id = $1`, [request.user.personId, hash]);
      const v = await request.db.query<{ v: number }>('SELECT auth_revoke_sessions($1) AS v', [request.user.personId]);
      forgetSessionVersion(request.user.personId);
      const { personId, holdingCompanyId, role, email } = request.user;
      const token = startSession(fastify, reply, { personId, holdingCompanyId, role, email, sv: v.rows[0].v });
      return { changed: true, token };
    }),
  );

  // ------------------------------------------------------------------
  // POST /people/:id/invite — owners only. Emails a set-your-password link
  // to a person that already exists (created via POST /people).
  // ------------------------------------------------------------------
  fastify.post<{ Params: { id: string } }>(
    '/people/:id/invite',
    { preHandler: [fastify.authenticate, rateLimitHook(limits.emailActions, byIp)] },
    withDb(async (request, reply) => {
      if (request.user.role !== 'owner') {
        reply.code(403).send({ error: 'forbidden', message: 'Only an owner can invite people.' });
        return;
      }
      if (!isUuid(request.params.id)) {
        reply.code(400).send({ error: 'bad_request', message: 'Invalid person id' });
        return;
      }
      if (!emailEnabled()) {
        reply.code(503).send({ error: 'email_unavailable', message: 'This server cannot send email yet, so invitations are unavailable.' });
        return;
      }
      const target = await request.db.query<{ id: string; name: string; email: string }>(
        `SELECT id, name, email FROM people WHERE id = $1`, [request.params.id],
      );
      if (target.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Person not found' });
        return;
      }
      const company = await request.db.query<{ name: string }>(
        `SELECT name FROM holding_companies WHERE id = $1`, [request.user.holdingCompanyId],
      );
      const inviter = await request.db.query<{ name: string }>(`SELECT name FROM people WHERE id = $1`, [request.user.personId]);
      const token = generateToken();
      await request.db.query('SELECT auth_issue_token($1, $2, $3, $4)', [target.rows[0].id, 'invite', hashToken(token), INVITE_TTL_MINUTES]);

      const sent = await sendEmail(
        inviteMessage(target.rows[0].email, target.rows[0].name, inviter.rows[0]?.name ?? 'An owner', company.rows[0]?.name ?? 'your company', resetLink(token)),
      );
      if (!sent.sent) {
        reply.code(502).send({ error: 'email_failed', message: 'The invitation could not be emailed. Try again shortly.' });
        return;
      }
      return { invited: true };
    }),
  );
}
