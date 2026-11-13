import { assertEnvironment, type EnvProblem } from './lib/env.js';

/**
 * Imported by server.ts right after dotenv and BEFORE anything that reads
 * the environment (lib/db.ts opens its pools at import time), so a bad
 * configuration stops the process with one readable message instead of a
 * stack trace from whichever module noticed first. Only variable NAMES and
 * rules are printed — never values.
 */
export let startupWarnings: EnvProblem[] = [];
try {
  startupWarnings = assertEnvironment();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
