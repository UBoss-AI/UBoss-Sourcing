/**
 * Money arithmetic.
 *
 * These tests exist because the failures they catch are invisible in review and
 * expensive in production: a cent of rounding drift per line, a float creeping
 * into a total, a discount that apportions to 9999 instead of 10000.
 */
import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  apportion,
  calculateTax,
  formatMinorToMajor,
  parseMajorToMinor,
  parseRateToScaled,
  serialiseMoney,
  sumMinor,
} from '../../src/domain/money.js';

describe('parseMajorToMinor', () => {
  it('converts rupee strings to paise', () => {
    expect(parseMajorToMinor('1499.50', 'INR')).toBe(149_950n);
    expect(parseMajorToMinor('0.01', 'INR')).toBe(1n);
    expect(parseMajorToMinor('1000', 'INR')).toBe(100_000n);
  });

  it('handles the classic float traps exactly', () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. In minor units it is just 10 + 20 = 30.
    const a = parseMajorToMinor('0.10', 'INR');
    const b = parseMajorToMinor('0.20', 'INR');
    expect(a + b).toBe(parseMajorToMinor('0.30', 'INR'));
  });

  it('rounds a third decimal place half-up', () => {
    expect(parseMajorToMinor('1.005', 'INR')).toBe(101n);
    expect(parseMajorToMinor('1.004', 'INR')).toBe(100n);
  });

  it('respects zero-decimal currencies', () => {
    expect(parseMajorToMinor('1500', 'JPY')).toBe(1500n);
  });

  it('rejects malformed input rather than coercing it', () => {
    expect(() => parseMajorToMinor('12.34.56', 'INR')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('abc', 'INR')).toThrow(MoneyError);
    expect(() => parseMajorToMinor('', 'INR')).toThrow(MoneyError);
  });

  it('rejects an unsupported currency instead of guessing an exponent', () => {
    expect(() => parseMajorToMinor('10.00', 'XYZ')).toThrow(MoneyError);
  });
});

describe('formatMinorToMajor', () => {
  it('round-trips through parse without drift', () => {
    for (const value of ['0.01', '1.00', '1499.50', '99999.99']) {
      expect(formatMinorToMajor(parseMajorToMinor(value, 'INR'), 'INR')).toBe(value);
    }
  });

  it('pads the fractional part', () => {
    expect(formatMinorToMajor(5n, 'INR')).toBe('0.05');
    expect(formatMinorToMajor(100n, 'INR')).toBe('1.00');
  });

  it('omits the separator for zero-decimal currencies', () => {
    expect(formatMinorToMajor(1500n, 'JPY')).toBe('1500');
  });
});

describe('parseRateToScaled', () => {
  it('scales a Decimal(9,6) percent string to an integer', () => {
    expect(parseRateToScaled('18.000000')).toBe(18_000_000n);
    expect(parseRateToScaled('18')).toBe(18_000_000n);
    expect(parseRateToScaled('0.5')).toBe(500_000n);
  });
});

describe('calculateTax', () => {
  it('adds exclusive tax on top of the listed price', () => {
    // 1000.00 at 18% -> 180.00 tax, 1180.00 gross.
    const result = calculateTax(100_000n, '18.000000', false);
    expect(result.taxMinor).toBe(18_000n);
    expect(result.netMinor).toBe(100_000n);
    expect(result.grossMinor).toBe(118_000n);
  });

  it('extracts inclusive tax from the listed price', () => {
    // 1180.00 inclusive of 18% -> 1000.00 net, 180.00 tax.
    const result = calculateTax(118_000n, '18.000000', true);
    expect(result.netMinor).toBe(100_000n);
    expect(result.taxMinor).toBe(18_000n);
    expect(result.grossMinor).toBe(118_000n);
  });

  it('keeps net + tax === gross for inclusive tax at awkward amounts', () => {
    // The property that matters: extraction must not lose or invent a paisa.
    for (const gross of [999n, 100_001n, 33_333n, 7n, 1n]) {
      const result = calculateTax(gross, '18.000000', true);
      expect(result.netMinor + result.taxMinor).toBe(gross);
    }
  });

  it('rounds half-up on exclusive tax', () => {
    // 0.05 at 5% = 0.0025 -> rounds to 0 (below half a paisa).
    expect(calculateTax(5n, '5.000000', false).taxMinor).toBe(0n);
    // 1.00 at 12.5% = 12.5 paise -> rounds up to 13.
    expect(calculateTax(100n, '12.500000', false).taxMinor).toBe(13n);
  });

  it('treats a zero rate as a no-op', () => {
    const result = calculateTax(100_000n, '0.000000', false);
    expect(result.taxMinor).toBe(0n);
    expect(result.grossMinor).toBe(100_000n);
  });

  it('refuses a negative base', () => {
    expect(() => calculateTax(-1n, '18.000000', false)).toThrow(MoneyError);
  });
});

describe('apportion', () => {
  it('distributes exactly the requested total', () => {
    const shares = apportion(100n, [1n, 1n, 1n]);
    expect(sumMinor(shares)).toBe(100n);
    // 33.33 each; largest-remainder hands the stray unit to the first line.
    expect(shares).toEqual([34n, 33n, 33n]);
  });

  it('never loses or invents a minor unit, across many shapes', () => {
    const cases: { total: bigint; weights: bigint[] }[] = [
      { total: 1n, weights: [1n, 1n, 1n] },
      { total: 9999n, weights: [1234n, 5678n, 91n] },
      { total: 100_000n, weights: [1n, 2n, 3n, 4n, 5n, 6n, 7n] },
      { total: 7n, weights: [100n] },
      { total: 0n, weights: [5n, 5n] },
    ];

    for (const { total, weights } of cases) {
      expect(sumMinor(apportion(total, weights))).toBe(total);
    }
  });

  it('weights proportionally', () => {
    expect(apportion(300n, [100n, 200n])).toEqual([100n, 200n]);
  });

  it('puts everything on the first line when there is no basis to weight by', () => {
    expect(apportion(50n, [0n, 0n])).toEqual([50n, 0n]);
  });

  it('returns an empty result for no lines', () => {
    expect(apportion(100n, [])).toEqual([]);
  });

  it('refuses a negative total', () => {
    expect(() => apportion(-1n, [1n])).toThrow(MoneyError);
  });
});

describe('sumMinor', () => {
  it('returns a bigint zero for an empty list, not a number', () => {
    const total = sumMinor([]);
    expect(total).toBe(0n);
    expect(typeof total).toBe('bigint');
  });
});

describe('serialiseMoney', () => {
  it('crosses the API boundary as strings, never as a JS number', () => {
    const payload = serialiseMoney(149_950n, 'INR');
    expect(payload).toEqual({ minor: '149950', formatted: '1499.50', currency: 'INR' });
    expect(typeof payload.minor).toBe('string');
  });

  it('survives an amount beyond Number.MAX_SAFE_INTEGER', () => {
    // 1e17 paise. As a JS number this would already have lost precision.
    const huge = 100_000_000_000_000_001n;
    expect(serialiseMoney(huge, 'INR').minor).toBe('100000000000000001');
  });
});
