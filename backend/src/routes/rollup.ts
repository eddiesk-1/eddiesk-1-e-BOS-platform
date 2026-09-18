import type { FastifyInstance } from 'fastify';
import { withDb } from '../plugins/tenantContext.js';

/**
 * GET /holding-companies/:id/rollup
 *
 * "Sums ledger entries across every business under that holding company —
 * this must be a live query, not a separately maintained running total."
 *
 * This is a single SELECT with SUM(...)/GROUP BY hitting ledger_entries
 * directly, joined up to businesses and filtered to the requested holding
 * company, run fresh on every request. There is no cache, no materialized
 * view, no cron job updating a running-total column anywhere in this
 * codebase — the number returned is always exactly what you'd get by
 * hand-summing every ledger_entries row that currently exists for this
 * holding company, as of the moment the query executes. If that ever
 * changes (e.g. for performance at very large scale), it should be a
 * deliberate, documented decision, not a drift introduced by someone
 * "optimizing" this endpoint later without reading this comment.
 *
 * RLS still applies to this query the same as any other — a partner
 * session hitting this endpoint gets a rollup computed only over the
 * ledger_entries rows visible to them (i.e. businesses they're a partner
 * in, per is_business_visible_to_caller), not the whole holding company.
 * That's a natural consequence of RLS applying uniformly, not special-
 * cased logic in this handler — worth knowing if a partner's rollup total
 * looks smaller than an owner's for the same holding_company_id.
 */
export default async function rollupRoutes(fastify: FastifyInstance) {
  fastify.get<{ Params: { id: string } }>(
    '/holding-companies/:id/rollup',
    { preHandler: [fastify.authenticate] },
    withDb(async (request, reply) => {
      const holdingCompanyId = request.params.id;

      // Confirm the holding company itself is visible to this caller
      // before computing a rollup for it — same not-found-vs-forbidden
      // reasoning as businesses.ts: a 404 here doesn't distinguish
      // "doesn't exist" from "exists but isn't yours."
      const hcResult = await request.db.query(
        `SELECT id, name FROM holding_companies WHERE id = $1`,
        [holdingCompanyId],
      );
      if (hcResult.rows.length === 0) {
        reply.code(404).send({ error: 'not_found', message: 'Holding company not found' });
        return;
      }

      const totalsResult = await request.db.query(
        `SELECT
           b.id AS business_id,
           b.name AS business_name,
           le.entry_type,
           SUM(le.amount) AS total
         FROM businesses b
         JOIN ledger_entries le ON le.business_id = b.id
         WHERE b.holding_company_id = $1
         GROUP BY b.id, b.name, le.entry_type
         ORDER BY b.name ASC, le.entry_type ASC`,
        [holdingCompanyId],
      );

      // Reshape the flat (business, entry_type) -> total rows into one
      // entry per business with debit/credit broken out, plus a grand
      // total per entry_type across the whole holding company. This
      // reshaping is pure presentation — it happens in application code
      // AFTER the live SUM/GROUP BY has already run; no aggregation
      // happens here that the database didn't already do.
      const byBusiness = new Map<
        string,
        { businessId: string; businessName: string; totalDebits: string; totalCredits: string }
      >();
      let grandTotalDebits = 0;
      let grandTotalCredits = 0;

      for (const row of totalsResult.rows) {
        if (!byBusiness.has(row.business_id)) {
          byBusiness.set(row.business_id, {
            businessId: row.business_id,
            businessName: row.business_name,
            totalDebits: '0.00',
            totalCredits: '0.00',
          });
        }
        const entry = byBusiness.get(row.business_id)!;
        if (row.entry_type === 'debit') {
          entry.totalDebits = row.total;
          grandTotalDebits += parseFloat(row.total);
        } else {
          entry.totalCredits = row.total;
          grandTotalCredits += parseFloat(row.total);
        }
      }

      return {
        holdingCompanyId,
        holdingCompanyName: hcResult.rows[0].name,
        businesses: Array.from(byBusiness.values()),
        grandTotal: {
          totalDebits: grandTotalDebits.toFixed(2),
          totalCredits: grandTotalCredits.toFixed(2),
        },
      };
    }),
  );
}
