/**
 * Startup environment validation. Returns a list of problems instead of
 * throwing from deep inside a route handler an hour after boot (which is
 * how a missing CREDENTIAL_ENCRYPTION_KEY used to surface: only when
 * somebody first stored a provider key).
 *
 * Errors stop the server from starting. Warnings are logged once.
 * Values are never echoed back — only variable names and rules.
 */
export interface EnvProblem {
  level: 'error' | 'warn';
  variable: string;
  message: string;
}

const KNOWN_PLACEHOLDERS = [
  'dev_only_jwt_secret_change_in_production',
  'change_me_in_production',
  'your_real_',
  'your_postgres_password',
];

function looksLikePlaceholder(value: string): boolean {
  const v = value.toLowerCase();
  return KNOWN_PLACEHOLDERS.some((p) => v.includes(p));
}

export function checkEnvironment(env: NodeJS.ProcessEnv = process.env): EnvProblem[] {
  const problems: EnvProblem[] = [];
  const isProd = env.NODE_ENV === 'production';
  const add = (level: EnvProblem['level'], variable: string, message: string) =>
    problems.push({ level, variable, message });

  // ---- JWT secret
  const jwt = env.JWT_SECRET ?? '';
  if (!jwt) {
    add('error', 'JWT_SECRET', 'is not set.');
  } else if (isProd && (jwt.length < 32 || looksLikePlaceholder(jwt))) {
    add('error', 'JWT_SECRET', 'must be a random value of at least 32 characters in production (not the example value).');
  } else if (!isProd && jwt.length < 16) {
    add('warn', 'JWT_SECRET', 'is very short; use a long random value.');
  }

  // ---- credential encryption key
  const key = env.CREDENTIAL_ENCRYPTION_KEY ?? '';
  if (!key) {
    add(isProd ? 'error' : 'warn', 'CREDENTIAL_ENCRYPTION_KEY',
      'is not set — storing embeddings-provider keys will fail until it is.');
  } else {
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length !== 32) {
      add('error', 'CREDENTIAL_ENCRYPTION_KEY', `must be base64 that decodes to exactly 32 bytes (decodes to ${decoded.length}).`);
    }
    if (jwt && key === jwt) {
      add('error', 'CREDENTIAL_ENCRYPTION_KEY', 'must not be the same value as JWT_SECRET.');
    }
  }

  // ---- database URLs
  for (const name of ['APP_DATABASE_URL', 'PUBLIC_DATABASE_URL'] as const) {
    const value = env[name] ?? '';
    if (!value) add('error', name, 'is not set.');
    else if (isProd && looksLikePlaceholder(value)) {
      add('error', name, 'still contains the default role password; run the deploy script so sync-roles applies a real one.');
    }
  }

  // ---- public base URL (used inside email links and payment callbacks)
  const base = env.APP_BASE_URL ?? '';
  if (!base) {
    add(isProd ? 'error' : 'warn', 'APP_BASE_URL',
      'is not set — verification, reset and payment-return links need the public https URL of this service.');
  } else if (isProd && !/^https:\/\/[^/\s]+/.test(base)) {
    add('error', 'APP_BASE_URL', 'must start with https:// in production.');
  }

  // ---- CORS
  if ((env.ALLOWED_ORIGIN ?? '').trim() === '*') {
    add('error', 'ALLOWED_ORIGIN', 'must not be "*" (credentialed requests).');
  }

  // ---- email
  const provider = (env.EMAIL_PROVIDER ?? '').trim().toLowerCase();
  if (provider === 'resend' || provider === 'brevo') {
    if (!env.EMAIL_API_KEY) add('error', 'EMAIL_API_KEY', `is required when EMAIL_PROVIDER=${provider}.`);
    if (!env.EMAIL_FROM) add('error', 'EMAIL_FROM', `is required when EMAIL_PROVIDER=${provider}.`);
  } else if (provider === 'log') {
    if (isProd) add('error', 'EMAIL_PROVIDER', '"log" is development-only: it would write verification links into logs.');
  } else if (provider) {
    add('error', 'EMAIL_PROVIDER', 'must be one of: resend, brevo, log (development only).');
  } else if (isProd) {
    add('warn', 'EMAIL_PROVIDER', 'is not set — business signup, password reset, invites and staff alerts are disabled.');
  }

  // ---- payments
  const paystack = env.PAYSTACK_SECRET_KEY ?? '';
  if (paystack) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(paystack)) {
      add('error', 'PAYSTACK_SECRET_KEY', 'does not look like a Paystack secret key (sk_test_… or sk_live_…).');
    } else if (isProd && paystack.startsWith('sk_test_')) {
      add('warn', 'PAYSTACK_SECRET_KEY', 'is a TEST key while NODE_ENV=production — no real money will move.');
    }
  }

  return problems;
}

export function assertEnvironment(env: NodeJS.ProcessEnv = process.env): EnvProblem[] {
  const problems = checkEnvironment(env);
  const errors = problems.filter((p) => p.level === 'error');
  if (errors.length > 0) {
    const lines = errors.map((p) => `  - ${p.variable}: ${p.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${lines}`);
  }
  return problems.filter((p) => p.level === 'warn');
}
