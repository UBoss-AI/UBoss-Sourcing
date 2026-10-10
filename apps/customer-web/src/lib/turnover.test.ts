import { describe, expect, it } from 'vitest';
import {
  compactEquivalent,
  croreFigure,
  meetsMinimum,
  financialYearOptions,
  formatTurnover,
  minorToEntry,
  mostRecentFinancialYear,
  parseTurnoverEntry,
} from './turnover';

const POLICY = { minimumMinor: '30000000000', currency: 'INR', currencyExponent: 2 };

describe('parseTurnoverEntry', () => {
  it('converts rupees and crore to the same exact paise', () => {
    expect(parseTurnoverEntry('300000000', 'MAJOR', 2)).toEqual({ ok: true, minor: 30_000_000_000n });
    expect(parseTurnoverEntry('30', 'CRORE', 2)).toEqual({ ok: true, minor: 30_000_000_000n });
    expect(parseTurnoverEntry('30,00,00,000.01', 'MAJOR', 2)).toEqual({ ok: true, minor: 30_000_000_001n });
    // One paisa above 30 crore, typed in crore: 30 + 1/10^9.
    expect(parseTurnoverEntry('30.000000001', 'CRORE', 2)).toEqual({ ok: true, minor: 30_000_000_001n });
  });

  it.each([
    ['', 'MAJOR', 'REQUIRED'],
    ['  ', 'CRORE', 'REQUIRED'],
    ['-5', 'MAJOR', 'NEGATIVE'],
    ['300000000.001', 'MAJOR', 'TOO_PRECISE'],
    ['30.0000000001', 'CRORE', 'TOO_PRECISE'],
    ['3e8', 'MAJOR', 'MALFORMED'],
    ['30 crore', 'CRORE', 'MALFORMED'],
    ['1.2.3', 'MAJOR', 'MALFORMED'],
    ['99999999999999999', 'MAJOR', 'TOO_LARGE'],
  ] as const)('refuses %j in %s as %s', (text, unit, problem) => {
    expect(parseTurnoverEntry(text, unit, 2)).toEqual({ ok: false, problem });
  });
});

describe('switching units keeps the exact figure', () => {
  it.each([30_000_000_001n, 30_000_000_000n, 1n, 0n, 123_456_789_012_345n])('round-trips %s paise', (minor) => {
    for (const unit of ['MAJOR', 'CRORE'] as const) {
      const text = minorToEntry(minor, unit, 2);
      expect(parseTurnoverEntry(text, unit, 2)).toEqual({ ok: true, minor });
    }
  });

  it('writes no trailing zeros', () => {
    expect(minorToEntry(30_000_000_000n, 'CRORE', 2)).toBe('30');
    expect(minorToEntry(30_000_000_001n, 'CRORE', 2)).toBe('30.000000001');
    expect(minorToEntry(30_000_000_050n, 'MAJOR', 2)).toBe('300000000.5');
  });
});

describe('the threshold', () => {
  it('is strictly greater than', () => {
    expect(meetsMinimum(30_000_000_000n, POLICY)).toBe(true);
    expect(meetsMinimum(29_999_999_999n, POLICY)).toBe(false);
    expect(meetsMinimum(30_000_000_001n, POLICY)).toBe(true);
  });

  it('formats the minimum as 30 crore and as INR 300 million', () => {
    expect(croreFigure(30_000_000_000n, 2)).toBe('30');
    expect(compactEquivalent(30_000_000_000n, POLICY, 'en')).toBe('INR 300 million');
    expect(formatTurnover(30_000_000_001n, POLICY, 'en')).toBe('₹30,00,00,000.01');
  });
});

describe('financial years', () => {
  const today = new Date(2026, 9, 8);

  it('offers the most recently completed year first, for the usual start month', () => {
    expect(mostRecentFinancialYear(4, today)).toEqual({ start: '2025-04-01', end: '2026-03-31' });
    const options = financialYearOptions(4, today);
    expect(options[0]).toMatchObject({ start: '2025-04-01', end: '2026-03-31' });
    expect(options.map((option) => option.start)).toContain('2025-01-01');
    expect(new Set(options.map((option) => option.key)).size).toBe(options.length);
  });
});
