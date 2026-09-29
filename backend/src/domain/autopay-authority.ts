/**
 * The pure parts of an AutoPay standing authority: which calendar period a
 * charge falls in, and whether an order is inside the suppliers and
 * categories the customer authorised.
 *
 * Pure so they can be tested exhaustively and so the review screen and the
 * charge-time decision share one answer.
 */

export type AutoPayCapPeriodName = 'WEEK' | 'MONTH' | 'QUARTER' | 'YEAR';

export const AutoPayCapPeriodValues: readonly AutoPayCapPeriodName[] = Object.freeze([
  'WEEK',
  'MONTH',
  'QUARTER',
  'YEAR',
]);

/**
 * The UTC calendar period `now` falls in: [start, end).
 *
 * A week runs Monday 00:00 to the next Monday 00:00, which is ISO-8601 and is
 * what "per week" means to a finance team on either side of the Channel.
 */
export function capPeriodWindow(now: Date, period: AutoPayCapPeriodName): { start: Date; end: Date } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();

  switch (period) {
    case 'WEEK': {
      const midnight = Date.UTC(y, m, now.getUTCDate());
      const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
      const start = new Date(midnight - sinceMonday * 86_400_000);
      return { start, end: new Date(start.getTime() + 7 * 86_400_000) };
    }
    case 'MONTH':
      return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
    case 'QUARTER': {
      const first = m - (m % 3);
      return { start: new Date(Date.UTC(y, first, 1)), end: new Date(Date.UTC(y, first + 3, 1)) };
    }
    case 'YEAR':
      return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  }
}

/** The operator's own stock, in a supplier scope. Sellers are named by id. */
export const MARKETPLACE_SUPPLIER_KEY = 'MARKETPLACE';

export interface ScopedLine {
  /** Null for the operator's own stock. */
  sellerAccountId: string | null;
  categoryId: string | null;
}

export interface AuthorityScope {
  /** Null: every supplier. */
  sellerKeys: readonly string[] | null;
  /** Null: every category. */
  categoryIds: readonly string[] | null;
}

/**
 * The first line the authority does not cover, or null when it covers them
 * all.
 *
 * An empty list is not "everything": a customer who unticked every supplier
 * has authorised none, and treating that as no restriction would be the
 * opposite of what they asked for. A line with no category is outside a
 * category scope for the same reason - the customer named what they allow.
 */
export function firstLineOutsideScope(
  scope: AuthorityScope,
  lines: readonly ScopedLine[],
): { line: ScopedLine; dimension: 'SUPPLIER' | 'CATEGORY' } | null {
  for (const line of lines) {
    if (scope.sellerKeys !== null) {
      const key = line.sellerAccountId ?? MARKETPLACE_SUPPLIER_KEY;
      if (!scope.sellerKeys.includes(key)) return { line, dimension: 'SUPPLIER' };
    }
    if (scope.categoryIds !== null) {
      if (line.categoryId === null || !scope.categoryIds.includes(line.categoryId)) {
        return { line, dimension: 'CATEGORY' };
      }
    }
  }
  return null;
}

/** Read a stored JSON scope column: an array of strings, or null for "any". */
export function parseScopeList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((entry): entry is string => typeof entry === 'string');
}
