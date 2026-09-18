/**
 * Validates an allocation_rules.splits array per the contract's own
 * comment on that column: "splits = [{person_id, pct}], must sum to 100."
 *
 * This can't live in a Postgres CHECK constraint — jsonb array contents
 * aren't practically checkable that way — so it's enforced here, inside
 * the same transaction as the insert (see routes/allocationRules.ts),
 * ahead of the write. Floating point summation is avoided: pct values
 * arrive as numbers over JSON, but they're summed as integer cents-of-a-
 * percent (multiplying by 100 and rounding) specifically so that e.g.
 * three splits of 33.33/33.33/33.34 sum to exactly 100.00 and don't fail
 * a naive floating-point equality check due to binary representation
 * error.
 */

export interface AllocationSplitInput {
  personId: string;
  pct: number;
}

export interface SplitValidationResult {
  valid: boolean;
  reason?: string;
}

const EXPECTED_SUM_HUNDREDTHS = 10000; // 100.00 expressed as hundredths of a percent

export function validateSplitsSumTo100(splits: unknown): SplitValidationResult {
  if (!Array.isArray(splits) || splits.length === 0) {
    return { valid: false, reason: 'splits must be a non-empty array' };
  }

  const seenPersonIds = new Set<string>();
  let sumHundredths = 0;

  for (const [index, split] of splits.entries()) {
    if (
      typeof split !== 'object' ||
      split === null ||
      typeof (split as Record<string, unknown>).personId !== 'string' ||
      typeof (split as Record<string, unknown>).pct !== 'number'
    ) {
      return {
        valid: false,
        reason: `splits[${index}] must be an object with a string personId and a numeric pct`,
      };
    }
    const { personId, pct } = split as AllocationSplitInput;

    if (pct < 0 || pct > 100) {
      return { valid: false, reason: `splits[${index}].pct (${pct}) must be between 0 and 100` };
    }
    if (seenPersonIds.has(personId)) {
      return {
        valid: false,
        reason: `personId ${personId} appears more than once in splits — each person may only have one entry`,
      };
    }
    seenPersonIds.add(personId);

    // Round to the nearest hundredth-of-a-percent before summing, matching
    // the numeric(5,2) precision the value will ultimately be compared
    // against downstream (via ledger allocation math) — this keeps the
    // validation's notion of "equal" aligned with the column's own
    // precision instead of introducing a stricter or looser standard.
    sumHundredths += Math.round(pct * 100);
  }

  if (sumHundredths !== EXPECTED_SUM_HUNDREDTHS) {
    const actualSum = (sumHundredths / 100).toFixed(2);
    return {
      valid: false,
      reason: `splits must sum to exactly 100, got ${actualSum}`,
    };
  }

  return { valid: true };
}
