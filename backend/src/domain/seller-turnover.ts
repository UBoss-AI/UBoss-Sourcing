/**
 * The seller turnover eligibility rule: pure, so it can be tested without a
 * database and so the onboarding checklist, the submit gate, the apply route
 * and the approval gate all ask the same question the same way.
 *
 * ## The rule
 *
 * A business may apply to sell only when its annual turnover for its most
 * recently completed financial year is STRICTLY GREATER than the minimum the
 * deployment configures (`SELLER_TURNOVER_MIN_MINOR`, in
 * `SELLER_TURNOVER_CURRENCY`). Exactly the minimum is not enough.
 *
 * This is the marketplace's own platform policy, never a legal requirement,
 * and every number in it is a setting: the next company to run this software
 * sets its own threshold, or switches the rule off.
 *
 * ## Money
 *
 * Whole minor units as a `bigint`, compared as integers. The amount arrives as
 * a string of digits - the same `minorUnits` shape every other money field on
 * the wire uses - so there is no float, no rounding and no display value
 * anywhere in the comparison. A turnover one paisa above the minimum is
 * eligible; the minimum itself is not.
 *
 * ## The reporting period
 *
 * Twelve months, starting on the first day of a month, already ended, and the
 * most recent such period with that year-end: the next one (twelve months
 * later) must not have ended yet. That is "the most recently completed
 * financial year" for any year-end a business uses - April to March in India,
 * a calendar year elsewhere - without hard-coding either.
 */

/** Digits only, at most 18 of them: a signed BIGINT column holds every such value. */
const MINOR_DIGITS = /^\d{1,18}$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type TurnoverAmountProblem = 'REQUIRED' | 'MALFORMED' | 'TOO_LARGE';

/**
 * Parse an amount of whole minor units.
 *
 * Refuses rather than coerces: a sign, a decimal point, an exponent or a space
 * is a malformed value, because the client converts rupees or crore into minor
 * units exactly before sending, and anything else reaching here did not come
 * from that conversion.
 */
export function parseTurnoverMinor(
  value: unknown,
): { ok: true; minor: bigint } | { ok: false; problem: TurnoverAmountProblem } {
  if (value === null || value === undefined || value === '') return { ok: false, problem: 'REQUIRED' };
  if (typeof value !== 'string') return { ok: false, problem: 'MALFORMED' };
  if (/^\d{19,}$/.test(value)) return { ok: false, problem: 'TOO_LARGE' };
  if (!MINOR_DIGITS.test(value)) return { ok: false, problem: 'MALFORMED' };
  return { ok: true, minor: BigInt(value) };
}

/** Strictly greater. Equal to the minimum is not eligible - the policy says "exceeding". */
export function isTurnoverAboveMinimum(amountMinor: bigint, minimumMinor: bigint): boolean {
  return amountMinor > minimumMinor;
}

/** A calendar date as UTC midnight, or null when the string is not a real date. */
export function parseIsoDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const match = ISO_DATE.exec(value);
  if (match === null) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  // Rejects 2026-02-30, which `Date.UTC` would quietly roll into March.
  if (date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The last day of the twelve months that begin on `start`. */
export function financialYearEndFor(start: Date): Date {
  return new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 0));
}

export type FinancialYearProblem =
  | 'REQUIRED'
  | 'INVALID_DATE'
  | 'NOT_TWELVE_MONTHS'
  | 'NOT_COMPLETED'
  | 'NOT_MOST_RECENT';

/**
 * Whether `start`..`end` is the most recently completed financial year on
 * `today` (a UTC date).
 *
 * `NOT_COMPLETED` - the year has not ended yet. `NOT_MOST_RECENT` - a later
 * year with the same year-end has already ended, so figures for this one are
 * out of date.
 */
export function financialYearProblem(
  startValue: unknown,
  endValue: unknown,
  today: Date,
): FinancialYearProblem | null {
  if (
    startValue === null || startValue === undefined || startValue === '' ||
    endValue === null || endValue === undefined || endValue === ''
  ) {
    return 'REQUIRED';
  }

  const start = parseIsoDate(startValue);
  const end = parseIsoDate(endValue);
  if (start === null || end === null) return 'INVALID_DATE';

  if (start.getUTCDate() !== 1 || financialYearEndFor(start).getTime() !== end.getTime()) {
    return 'NOT_TWELVE_MONTHS';
  }

  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  // Ended means its last day is before today.
  if (end.getTime() >= todayUtc) return 'NOT_COMPLETED';

  const nextEnd = financialYearEndFor(
    new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth(), 1)),
  );
  if (nextEnd.getTime() < todayUtc) return 'NOT_MOST_RECENT';

  return null;
}

/**
 * The most recently completed financial year that starts in `startMonth`
 * (1-12) on `today`. Used for the default the form offers.
 */
export function mostRecentFinancialYear(startMonth: number, today: Date): { start: string; end: string } {
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  // The latest start whose year has ended: try this calendar year's start
  // month and walk back until its year is over.
  let year = today.getUTCFullYear();
  for (;;) {
    const start = new Date(Date.UTC(year, startMonth - 1, 1));
    const end = financialYearEndFor(start);
    if (end.getTime() < todayUtc) return { start: isoDate(start), end: isoDate(end) };
    year -= 1;
  }
}

export type TurnoverStanding =
  /** Nothing declared. */
  | 'NOT_DECLARED'
  /** Declared, above the minimum, for the most recent year. */
  | 'ELIGIBLE'
  /** Declared at or below the minimum, or in another currency. */
  | 'BELOW_MINIMUM'
  /** Declared for a year that is no longer the most recently completed one. */
  | 'OUT_OF_DATE';

export interface TurnoverPolicyFacts {
  minimumMinor: bigint;
  currency: string;
}

export interface DeclaredTurnover {
  amountMinor: bigint;
  currency: string;
  financialYearStart: Date;
  financialYearEnd: Date;
}

/** One answer to "does this declaration meet the policy today?". */
export function turnoverStanding(
  declaration: DeclaredTurnover | null,
  policy: TurnoverPolicyFacts,
  today: Date,
): TurnoverStanding {
  if (declaration === null) return 'NOT_DECLARED';

  if (
    financialYearProblem(
      isoDate(declaration.financialYearStart),
      isoDate(declaration.financialYearEnd),
      today,
    ) !== null
  ) {
    return 'OUT_OF_DATE';
  }

  // A turnover stated in another currency is not compared at a guessed rate.
  if (declaration.currency !== policy.currency) return 'BELOW_MINIMUM';

  return isTurnoverAboveMinimum(declaration.amountMinor, policy.minimumMinor) ? 'ELIGIBLE' : 'BELOW_MINIMUM';
}
