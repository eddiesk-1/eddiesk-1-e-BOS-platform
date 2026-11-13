/**
 * 019_accounts_and_auth
 *
 * Real accounts: email verification, password reset, login lockout,
 * session revocation, and login WITHOUT typing a holding-company UUID.
 *
 * DESIGN (read this before changing anything here)
 * ------------------------------------------------
 * Everything in this migration that has to work BEFORE a caller is
 * authenticated (finding which tenant an email belongs to, consuming a
 * verification/reset token, counting failed logins) cannot use the
 * tenant-RLS model, because there is no tenant context yet. The existing
 * schema solves the same problem with SECURITY DEFINER functions that
 * re-verify the caller's authority themselves (identify_conversation,
 * redeem_transaction_token). This migration follows that pattern, with one
 * extra rule: the two new tables below (account_security, auth_tokens)
 * have NO grants to any application role and NO row-level-security
 * policies. They are reachable ONLY through the auth_* functions. That
 * means:
 *   - no dependence on the table owner bypassing FORCE ROW LEVEL SECURITY;
 *   - a SQL-injection bug elsewhere in the app cannot read hashes of
 *     reset tokens, lockout state or session versions directly;
 *   - tenant isolation of the existing tables is untouched.
 *
 * What is stored where:
 *   account_security  one row per person: identity index (normalised email
 *                     + holding company, kept in sync by a trigger on
 *                     people), email_verified_at, phone, failed-login
 *                     counter, lockout, session_version.
 *   auth_tokens       single-use, expiring tokens. Only the SHA-256 hash
 *                     of a token is stored — the plaintext exists only in
 *                     the email that was sent.
 *   business_profiles category/country/city/address/description captured
 *                     at registration. Ordinary tenant-scoped table.
 *
 * EXISTING ACCOUNTS: every person that exists when this migration runs is
 * back-filled as email-verified, so nobody is locked out by the upgrade.
 * Only accounts created AFTER this migration need to verify.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  // ------------------------------------------------------------------
  // account_security
  // ------------------------------------------------------------------
  pgm.sql(`
    CREATE TABLE account_security (
      person_id            uuid PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
      holding_company_id   uuid NOT NULL,
      email_normalized     text NOT NULL,
      email_verified_at    timestamptz NULL,
      phone                text NULL,
      failed_attempts      integer NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
      locked_until         timestamptz NULL,
      last_login_at        timestamptz NULL,
      session_version      integer NOT NULL DEFAULT 0,
      created_at           timestamptz NOT NULL DEFAULT now(),
      updated_at           timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE INDEX idx_account_security_email ON account_security(email_normalized);`);
  pgm.sql(`CREATE INDEX idx_account_security_holding_company ON account_security(holding_company_id);`);

  // Keep the identity index in sync with people. SECURITY DEFINER so it can
  // write account_security even though no app role has any grant on it.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION sync_account_security()
    RETURNS trigger
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        INSERT INTO account_security (person_id, holding_company_id, email_normalized)
        VALUES (NEW.id, NEW.holding_company_id, lower(btrim(NEW.email)))
        ON CONFLICT (person_id) DO NOTHING;
      ELSE
        UPDATE account_security
        SET holding_company_id = NEW.holding_company_id,
            email_normalized   = lower(btrim(NEW.email)),
            -- A changed email address must be proven again.
            email_verified_at  = CASE
              WHEN lower(btrim(OLD.email)) <> lower(btrim(NEW.email)) THEN NULL
              ELSE email_verified_at
            END,
            updated_at = now()
        WHERE person_id = NEW.id;
      END IF;
      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER people_sync_account_security
      AFTER INSERT OR UPDATE OF email, holding_company_id ON people
      FOR EACH ROW EXECUTE FUNCTION sync_account_security();
  `);

  // Back-fill existing people as verified. people has FORCE ROW LEVEL
  // SECURITY, which would hide every row from this migration's own
  // connection, so FORCE is lifted for the duration of this one statement
  // pair inside the migration transaction and restored immediately after.
  // (The application never connects as the table owner, so this window
  // affects nothing but this migration.)
  pgm.sql(`ALTER TABLE people NO FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`
    INSERT INTO account_security (person_id, holding_company_id, email_normalized, email_verified_at)
    SELECT p.id, p.holding_company_id, lower(btrim(p.email)), now()
    FROM people p
    ON CONFLICT (person_id) DO NOTHING;
  `);
  pgm.sql(`ALTER TABLE people FORCE ROW LEVEL SECURITY;`);

  // ------------------------------------------------------------------
  // auth_tokens
  // ------------------------------------------------------------------
  pgm.sql(`
    CREATE TABLE auth_tokens (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      person_id   uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      purpose     text NOT NULL CHECK (purpose IN ('verify_email', 'reset_password', 'invite')),
      token_hash  text NOT NULL,
      expires_at  timestamptz NOT NULL,
      used_at     timestamptz NULL,
      created_at  timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`CREATE UNIQUE INDEX idx_auth_tokens_hash ON auth_tokens(token_hash);`);
  pgm.sql(`CREATE INDEX idx_auth_tokens_person_purpose ON auth_tokens(person_id, purpose);`);

  // ------------------------------------------------------------------
  // auth_* functions. All SECURITY DEFINER, all with a pinned
  // search_path, all REVOKEd from PUBLIC and granted only to the roles
  // the application actually switches into.
  // ------------------------------------------------------------------

  // Who might this email be? Up to 5 candidates (the same address can
  // legitimately exist in several holding companies).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_resolve_candidates(p_email text)
    RETURNS TABLE (
      person_id uuid,
      holding_company_id uuid,
      email_verified boolean,
      locked_until timestamptz,
      created_at timestamptz,
      session_version integer
    )
    LANGUAGE sql
    SECURITY DEFINER
    STABLE
    SET search_path = public
    AS $$
      SELECT s.person_id, s.holding_company_id, (s.email_verified_at IS NOT NULL),
             s.locked_until, s.created_at, s.session_version
      FROM account_security s
      WHERE s.email_normalized = lower(btrim(p_email))
      ORDER BY s.created_at ASC
      LIMIT 5;
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_record_failure(p_person_id uuid)
    RETURNS integer
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      UPDATE account_security
      SET failed_attempts = failed_attempts + 1, updated_at = now()
      WHERE person_id = p_person_id
      RETURNING failed_attempts;
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_lock(p_person_id uuid, p_seconds integer)
    RETURNS timestamptz
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      UPDATE account_security
      SET locked_until = now() + make_interval(secs => GREATEST(p_seconds, 0)),
          updated_at = now()
      WHERE person_id = p_person_id
      RETURNING locked_until;
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_record_success(p_person_id uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      UPDATE account_security
      SET failed_attempts = 0, locked_until = NULL, last_login_at = now(), updated_at = now()
      WHERE person_id = p_person_id;
    $$;
  `);

  // Used after a password reset: clears the failed-login counter and any
  // lockout WITHOUT pretending a login happened (last_login_at untouched).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_clear_lockout(p_person_id uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      UPDATE account_security
      SET failed_attempts = 0, locked_until = NULL, updated_at = now()
      WHERE person_id = p_person_id;
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_mark_verified(p_person_id uuid)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      UPDATE account_security
      SET email_verified_at = COALESCE(email_verified_at, now()), updated_at = now()
      WHERE person_id = p_person_id;
    $$;
  `);

  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_set_phone(p_person_id uuid, p_phone text)
    RETURNS void
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      UPDATE account_security SET phone = p_phone, updated_at = now() WHERE person_id = p_person_id;
    $$;
  `);

  // Bumping session_version invalidates every JWT issued before now.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_revoke_sessions(p_person_id uuid)
    RETURNS integer
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      UPDATE account_security
      SET session_version = session_version + 1, updated_at = now()
      WHERE person_id = p_person_id
      RETURNING session_version;
    $$;
  `);

  // NULL result = the person no longer exists.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_session_version(p_person_id uuid)
    RETURNS integer
    LANGUAGE sql
    SECURITY DEFINER
    STABLE
    SET search_path = public
    AS $$
      SELECT s.session_version FROM account_security s WHERE s.person_id = p_person_id;
    $$;
  `);

  // Issue a token, retiring any earlier unused token of the same purpose.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_issue_token(
      p_person_id uuid, p_purpose text, p_token_hash text, p_ttl_minutes integer
    )
    RETURNS void
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    BEGIN
      UPDATE auth_tokens SET used_at = now()
      WHERE person_id = p_person_id AND purpose = p_purpose AND used_at IS NULL;

      INSERT INTO auth_tokens (person_id, purpose, token_hash, expires_at)
      VALUES (p_person_id, p_purpose, p_token_hash, now() + make_interval(mins => p_ttl_minutes));
    END;
    $$;
  `);

  // Atomically consume a token: valid only once, only before expiry.
  // Zero rows = unknown, expired or already used (callers must not say which).
  pgm.sql(`
    CREATE OR REPLACE FUNCTION auth_consume_token(p_token_hash text, p_purpose text)
    RETURNS TABLE (person_id uuid, holding_company_id uuid, email text)
    LANGUAGE sql
    SECURITY DEFINER
    SET search_path = public
    AS $$
      WITH used AS (
        UPDATE auth_tokens t
        SET used_at = now()
        WHERE t.token_hash = p_token_hash
          AND t.purpose = p_purpose
          AND t.used_at IS NULL
          AND t.expires_at > now()
        RETURNING t.person_id AS pid
      )
      SELECT s.person_id, s.holding_company_id, s.email_normalized
      FROM used u
      JOIN account_security s ON s.person_id = u.pid;
    $$;
  `);

  const authFns = [
    'auth_resolve_candidates(text)',
    'auth_record_failure(uuid)',
    'auth_lock(uuid, integer)',
    'auth_record_success(uuid)',
    'auth_clear_lockout(uuid)',
    'auth_mark_verified(uuid)',
    'auth_set_phone(uuid, text)',
    'auth_revoke_sessions(uuid)',
    'auth_session_version(uuid)',
    'auth_issue_token(uuid, text, text, integer)',
    'auth_consume_token(text, text)',
  ];
  for (const fn of authFns) {
    pgm.sql(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC;`);
    pgm.sql(`GRANT EXECUTE ON FUNCTION ${fn} TO app_owner_partner, app_worker;`);
  }

  // ------------------------------------------------------------------
  // business_profiles — registration details for a business.
  // ------------------------------------------------------------------
  pgm.sql(`
    CREATE TABLE business_profiles (
      business_id  uuid PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
      category     text NULL,
      country      text NULL,
      city         text NULL,
      address      text NULL,
      description  text NULL,
      phone        text NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now()
    );
  `);
  pgm.sql(`GRANT SELECT, INSERT, UPDATE ON business_profiles TO app_owner_partner;`);
  pgm.sql(`GRANT SELECT ON business_profiles TO app_worker;`);
  pgm.sql(`ALTER TABLE business_profiles ENABLE ROW LEVEL SECURITY;`);
  pgm.sql(`ALTER TABLE business_profiles FORCE ROW LEVEL SECURITY;`);
  pgm.sql(`
    CREATE POLICY tenant_isolation ON business_profiles
      TO app_owner_partner, app_worker
      USING (is_business_visible_to_caller(business_profiles.business_id));
  `);

  // ------------------------------------------------------------------
  // Diagnostic: SECURITY DEFINER functions from migrations 013, 016, 020
  // and 021 read tables that have FORCE ROW LEVEL SECURITY. That only
  // returns rows if the function owner (the migration user) is a
  // superuser or has BYPASSRLS. This function reports which it is, so the
  // server can warn loudly at startup instead of failing mysteriously in
  // production. Inside a SECURITY DEFINER function current_user IS the
  // owner, which is exactly what we want to test.
  // ------------------------------------------------------------------
  pgm.sql(`
    CREATE OR REPLACE FUNCTION diag_owner_bypasses_rls()
    RETURNS boolean
    LANGUAGE sql
    SECURITY DEFINER
    STABLE
    SET search_path = public, pg_catalog
    AS $$
      SELECT COALESCE((SELECT r.rolsuper OR r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user), false);
    $$;
  `);
  pgm.sql(`GRANT EXECUTE ON FUNCTION diag_owner_bypasses_rls() TO app_owner_partner, app_worker, app_public;`);
};

exports.down = (pgm) => {
  pgm.sql(`DROP FUNCTION IF EXISTS diag_owner_bypasses_rls();`);

  pgm.sql(`DROP POLICY IF EXISTS tenant_isolation ON business_profiles;`);
  pgm.sql(`REVOKE ALL ON business_profiles FROM app_owner_partner, app_worker;`);
  pgm.sql(`DROP TABLE IF EXISTS business_profiles;`);

  pgm.sql(`DROP FUNCTION IF EXISTS auth_consume_token(text, text);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_issue_token(uuid, text, text, integer);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_session_version(uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_revoke_sessions(uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_set_phone(uuid, text);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_mark_verified(uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_record_success(uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_clear_lockout(uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_lock(uuid, integer);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_record_failure(uuid);`);
  pgm.sql(`DROP FUNCTION IF EXISTS auth_resolve_candidates(text);`);

  pgm.sql(`DROP TABLE IF EXISTS auth_tokens;`);

  pgm.sql(`DROP TRIGGER IF EXISTS people_sync_account_security ON people;`);
  pgm.sql(`DROP FUNCTION IF EXISTS sync_account_security();`);
  pgm.sql(`DROP TABLE IF EXISTS account_security;`);
};
