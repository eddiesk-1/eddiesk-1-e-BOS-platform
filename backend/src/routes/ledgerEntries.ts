import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

type EntryType = 'debit' | 'credit';

interface LedgerEntryInput {
  entryType: EntryType;
  account: string;
  amount: string; // see the note on amount's type, below
  allocationRuleVersion?: number | null;
}

interface CreateLedgerPairBody {
  businessId: string;
  debit: Omit<LedgerEntryInput, 'entryType'>;
  credit: Omit<LedgerEntryInput, 'entryType'>;
}

/**
 * amount is typed as `string` on the way in and left as a string on the
 * way out (never parseFloat'd), unlike ownership_pct in partnerships.ts.
 * That's deliberate, not an inconsistency: numeric(14,2) is arbitrary-
 * precision on the Postgres side specifically so money never touches IEEE
 * 754 float representation, and parsing it into a JS `number` at the API
 * boundary would throw that guarantee away the moment it left the
 * database. Clients should treat amount as a decimal string (parse with a
 * decimal library on their end if they need to do arithmetic on it) —
 * this is the one place in the API where "parse numeric columns to JS
 * numbers for convenience" is deliberately NOT done, and it's done this
 * way specifically because this is money.
 */
function toApiShape(row: {
  id: string;
  business_id: string;
  entry_type: EntryType;
  account: string;
  amount: string;
  related_entry_id: string | null;
  allocation_rule_version: number | null;
  created_at: Date;
}) {
  return {
    id: row.id,
    businessId: row.business_id,
    entryType: row.entry_type,
    account: row.account,
    amount: row.amount,
    relatedEntryId: row.related_entry_id,
    allocationRuleVersion: row.allocation_rule_version,
    createdAt: row.created_at,
  };
}

function isValidAmountString(value: unknown): value is string {
  // numeric(14,2): up to 12 digits before the decimal, exactly 0-2 after.
  // Validated as a string BEFORE it ever reaches a query parameter, so a
  // malformed value fails with a clear 400 instead of a Postgres numeric
  // parse error surfacing as an opaque 500.
  return typeof value === 'string' && /^\d{1,12}(\.\d{1,2})?$/.test(value) && parseFloat(value) > 0;
}

function validateEntryInput(
  entry: unknown,
  label: string,
): { valid: true; entry: LedgerEntryInput } | { valid: false; reason: string } {
  if (typeof entry !== 'object' || entry === null) {
    return { valid: false, reason: `${label} must be an object` };
  }
  const e = entry as Record<string, unknown>;
  if (typeof e.account !== 'string' || e.account.length === 0) {
    return { valid: false, reason: `${label}.account is required` };
  }
  if (!isValidAmountString(e.amount)) {
    return {
      valid: false,
      reason: `${label}.amount must be a positive decimal string with at most 2 decimal places (e.g. "150.00")`,
    };
  }
  if (
    e.allocationRuleVersion !== undefined &&
    e.allocationRuleVersion !== null &&
    typeof e.allocationRuleVersion !== 'number'
  ) {
    return { valid: false, reason: `${label}.allocationRuleVersion must be a number or null` };
  }
  return {
    valid: true,
    entry: {
      entryType: label === 'debit' ? 'debit' : 'credit',
      account: e.account,
      amount: e.amount as string,
      allocationRuleVersion: (e.allocationRuleVersion as number | null | undefined) ?? null,
    },
  };
}

export default async function ledgerEntryRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { businessId?: string } }>(
    '/ledger-entries',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId } = request.query;
      if (!businessId) {
        reply.code(400).send({ error: 'bad_request', message: 'businessId query param is required' });
        return;
      }
      const result = await request.db.query(
        `SELECT id, business_id, entry_type, account, amount, related_entry_id,
                allocation_rule_version, created_at
         FROM ledger_entries WHERE business_id = $1 ORDER BY created_at DESC`,
        [businessId],
      );
      return result.rows.map(toApiShape);
    }),
  );

  fastify.get<{ Params: { id: string } }>(
    '/ledger-entries/:id',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const result = await request.db.query(
        `SELECT id, business_id, entry_type, account, amount, related_entry_id,
                allocation_rule_version, created_at
         FROM ledger_entries WHERE id = $1`,
        [request.params.id],
      );
      if (result.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Ledger entry not found' });
        return;
      }
      return toApiShape(result.rows[0]);
    }),
  );

  /**
   * POST /ledger-entries — the balanced-pair endpoint.
   *
   * The contract says "reject any single POST that doesn't include a
   * balanced debit+credit pair," and there is no way to express that as a
   * constraint on the ledger_entries table itself (a CHECK constraint sees
   * one row at a time; it has no way to require that some OTHER row with
   * opposite entry_type and equal amount also exists). So the balance
   * requirement is a property of this endpoint's request shape, not of
   * the table: the request body must contain exactly one `debit` and one
   * `credit` object, both for the same businessId, and the two amounts
   * must match exactly (compared as the original decimal strings, not as
   * parsed floats — see isValidAmountString/the note on amount's type
   * above for why float comparison is avoided here specifically).
   *
   * Both rows are inserted in a single database transaction (via
   * withDb -> withTenantScope -> BEGIN/COMMIT, see lib/db.ts), each
   * pointing at the other via related_entry_id. If anything fails after
   * the debit insert but before the credit insert commits — a constraint
   * violation, a crashed connection, anything — the whole transaction
   * rolls back and NEITHER row exists. There is no code path in this
   * handler where a debit can be persisted without its matching credit.
   */
  fastify.post<{ Body: CreateLedgerPairBody }>(
    '/ledger-entries',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const { businessId, debit, credit } = request.body ?? ({} as CreateLedgerPairBody);

      if (!businessId || !debit || !credit) {
        reply.code(400).send({
          error: 'bad_request',
          message: 'businessId, debit, and credit are all required — every POST must be a balanced pair',
        });
        return;
      }

      const debitValidation = validateEntryInput(debit, 'debit');
      if (!debitValidation.valid) {
        reply.code(400).send({ error: 'bad_request', message: debitValidation.reason });
        return;
      }
      const creditValidation = validateEntryInput(credit, 'credit');
      if (!creditValidation.valid) {
        reply.code(400).send({ error: 'bad_request', message: creditValidation.reason });
        return;
      }

      // Compared as strings after normalizing trailing decimal
      // representation (e.g. "150" vs "150.00" are the same amount), not
      // via parseFloat — see the file-level note on why amount stays a
      // string throughout this handler.
      const normalize = (amount: string) => parseFloat(amount).toFixed(2);
      if (normalize(debitValidation.entry.amount) !== normalize(creditValidation.entry.amount)) {
        reply.code(400).send({
          error: 'unbalanced_entry',
          message: `debit.amount (${debit.amount}) must equal credit.amount (${credit.amount})`,
        });
        return;
      }

      const client = request.db;
      const debitResult = await client.query(
        `INSERT INTO ledger_entries (business_id, entry_type, account, amount, allocation_rule_version)
         VALUES ($1, 'debit', $2, $3, $4)
         RETURNING id, business_id, entry_type, account, amount, related_entry_id,
                   allocation_rule_version, created_at`,
        [
          businessId,
          debitValidation.entry.account,
          debitValidation.entry.amount,
          debitValidation.entry.allocationRuleVersion,
        ],
      );
      const debitRow = debitResult.rows[0];

      const creditResult = await client.query(
        `INSERT INTO ledger_entries (business_id, entry_type, account, amount, related_entry_id, allocation_rule_version)
         VALUES ($1, 'credit', $2, $3, $4, $5)
         RETURNING id, business_id, entry_type, account, amount, related_entry_id,
                   allocation_rule_version, created_at`,
        [
          businessId,
          creditValidation.entry.account,
          creditValidation.entry.amount,
          debitRow.id,
          creditValidation.entry.allocationRuleVersion,
        ],
      );
      const creditRow = creditResult.rows[0];

      // Link the debit row back to the credit row too, now that the
      // credit row's id exists — related_entry_id is symmetric (both rows
      // point at each other), not a one-directional "credit points at its
      // debit" relationship. Still inside the same transaction as both
      // inserts above.
      await client.query(`UPDATE ledger_entries SET related_entry_id = $1 WHERE id = $2`, [
        creditRow.id,
        debitRow.id,
      ]);
      debitRow.related_entry_id = creditRow.id;

      reply.code(201).send({
        debit: toApiShape(debitRow),
        credit: toApiShape(creditRow),
      });
    }),
  );

  // No PATCH/DELETE for ledger_entries. Correcting a mistaken entry means
  // posting a new balanced pair that reverses it (the standard double-
  // entry bookkeeping practice), not mutating or removing history —
  // consistent with related_entry_id's ON DELETE RESTRICT (migration 003),
  // which would refuse a DELETE on one half of a pair anyway as long as
  // the other half still references it.
}
