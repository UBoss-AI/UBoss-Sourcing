/**
 * The seller turnover eligibility rule (domain/seller-turnover.ts).
 *
 * The threshold is "at least" (policy v1.0), so the three cases that matter are
 * one minor unit below the minimum (refused), the minimum itself (eligible) and
 * one minor unit above it (eligible) - compared as integers, never as rounded display values.
 */
import { describe, expect, it } from 'vitest';
import {
  financialYearProblem,
  meetsTurnoverMinimum,
  mostRecentFinancialYear,
  parseTurnoverMinor,
  turnoverStanding,
} from '../../src/domain/seller-turnover.js';

/** INR 30 crore in paise: 30 x 10,000,000 rupees x 100. */
const THIRTY_CRORE = 30_000_000_000n;
const TODAY = new Date(Date.UTC(2026, 9, 8)); // 8 October 2026
const POLICY = { minimumMinor: THIRTY_CRORE, currency: 'INR' };
const FY = { financialYearStart: new Date(Date.UTC(2025, 3, 1)), financialYearEnd: new Date(Date.UTC(2026, 2, 31)) };

describe('the minimum', () => {
  it('accepts exactly the minimum and one paisa more, and refuses one paisa less', () => {
    expect(meetsTurnoverMinimum(THIRTY_CRORE, THIRTY_CRORE)).toBe(true);
    expect(meetsTurnoverMinimum(THIRTY_CRORE + 1n, THIRTY_CRORE)).toBe(true);
    expect(meetsTurnoverMinimum(THIRTY_CRORE - 1n, THIRTY_CRORE)).toBe(false);
  });

  it('compares amounts a float would round together', () => {
    // 2^53 + 1 is not representable as a double; as a bigint it is exact.
    const big = 9_007_199_254_740_993n;
    expect(meetsTurnoverMinimum(big, big - 1n)).toBe(true);
    expect(meetsTurnoverMinimum(big - 2n, big - 1n)).toBe(false);
  });
});

describe('the amount on the wire', () => {
  it('accepts whole minor units only', () => {
    expect(parseTurnoverMinor('30000000001')).toEqual({ ok: true, minor: 30_000_000_001n });
    expect(parseTurnoverMinor('0')).toEqual({ ok: true, minor: 0n });
  });

  it.each([
    ['-1', 'MALFORMED'],
    ['30000000000.5', 'MALFORMED'],
    ['3e10', 'MALFORMED'],
    [' 300', 'MALFORMED'],
    ['30,00,00,000', 'MALFORMED'],
    [30_000_000_001, 'MALFORMED'],
    ['', 'REQUIRED'],
    [null, 'REQUIRED'],
    [undefined, 'REQUIRED'],
    ['1234567890123456789', 'TOO_LARGE'],
  ])('refuses %j as %s', (value, problem) => {
    expect(parseTurnoverMinor(value)).toEqual({ ok: false, problem });
  });
});

describe('the reporting period', () => {
  it('accepts the most recently completed April-March year', () => {
    expect(financialYearProblem('2025-04-01', '2026-03-31', TODAY)).toBeNull();
  });

  it('accepts a calendar year when it is the latest one ended', () => {
    expect(financialYearProblem('2025-01-01', '2025-12-31', TODAY)).toBeNull();
  });

  it('refuses a year that has not ended, and one that a later year replaced', () => {
    expect(financialYearProblem('2026-04-01', '2027-03-31', TODAY)).toBe('NOT_COMPLETED');
    expect(financialYearProblem('2024-04-01', '2025-03-31', TODAY)).toBe('NOT_MOST_RECENT');
  });

  it('refuses a period that is not twelve months from the first of a month', () => {
    expect(financialYearProblem('2025-04-01', '2026-02-28', TODAY)).toBe('NOT_TWELVE_MONTHS');
    expect(financialYearProblem('2025-04-02', '2026-04-01', TODAY)).toBe('NOT_TWELVE_MONTHS');
  });

  it('refuses a missing or impossible date', () => {
    expect(financialYearProblem('', '2026-03-31', TODAY)).toBe('REQUIRED');
    expect(financialYearProblem('2025-04-01', null, TODAY)).toBe('REQUIRED');
    expect(financialYearProblem('2025-02-30', '2026-03-31', TODAY)).toBe('INVALID_DATE');
  });

  it('suggests the most recently completed year for the usual start month', () => {
    expect(mostRecentFinancialYear(4, TODAY)).toEqual({ start: '2025-04-01', end: '2026-03-31' });
    expect(mostRecentFinancialYear(1, TODAY)).toEqual({ start: '2025-01-01', end: '2025-12-31' });
    // On 31 March the year ending that day has not ended yet.
    expect(mostRecentFinancialYear(4, new Date(Date.UTC(2026, 2, 31)))).toEqual({ start: '2024-04-01', end: '2025-03-31' });
  });
});

describe('where a declaration stands', () => {
  it('needs a declaration', () => {
    expect(turnoverStanding(null, POLICY, TODAY)).toBe('NOT_DECLARED');
  });

  it('is eligible at or above the minimum', () => {
    expect(turnoverStanding({ amountMinor: THIRTY_CRORE + 1n, currency: 'INR', ...FY }, POLICY, TODAY)).toBe('ELIGIBLE');
    expect(turnoverStanding({ amountMinor: THIRTY_CRORE, currency: 'INR', ...FY }, POLICY, TODAY)).toBe('ELIGIBLE');
    expect(turnoverStanding({ amountMinor: THIRTY_CRORE - 1n, currency: 'INR', ...FY }, POLICY, TODAY)).toBe('BELOW_MINIMUM');
  });

  it('does not convert another currency at a guessed rate', () => {
    expect(turnoverStanding({ amountMinor: THIRTY_CRORE * 100n, currency: 'EUR', ...FY }, POLICY, TODAY)).toBe('BELOW_MINIMUM');
  });

  it('goes out of date when a later financial year ends', () => {
    const later = new Date(Date.UTC(2027, 3, 1));
    expect(turnoverStanding({ amountMinor: THIRTY_CRORE + 1n, currency: 'INR', ...FY }, POLICY, later)).toBe('OUT_OF_DATE');
  });
});
