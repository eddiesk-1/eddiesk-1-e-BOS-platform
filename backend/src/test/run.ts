/**
 * `npm test` entry point. node:test runs whatever has been imported.
 *
 *   unit.test.ts         pure logic: passwords, tokens, lockout, rate
 *                        limiting, validators, email, env checks, Paystack
 *                        signatures/money, region inference, escalation
 *   chat.test.ts         prompt building for the reception AI
 *   migrations.test.ts   structural checks on migrations 019-021 (no DB)
 *   integration.test.ts  REAL database tests — tenant isolation, auth
 *                        functions, chat functions, payments. Skipped
 *                        (and reported as skipped) unless TEST_DATABASE_URL,
 *                        TEST_APP_DATABASE_URL and TEST_PUBLIC_DATABASE_URL
 *                        are set. See DEPLOY.md "Running the tests".
 */
import './unit.test.js';
import './chat.test.js';
import './migrations.test.js';
import './integration.test.js';
