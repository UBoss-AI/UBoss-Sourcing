/**
 * Bulk price conversion.
 *
 * The arithmetic that fills a whole currency's price list. It runs once and
 * what it writes is then the real price of every product in that market, so a
 * rounding error here is not a cent of drift on one line - it is a catalogue
 * priced wrongly until somebody notices.
 *
 * The float trap is the one worth naming: `4550 * 0.0105` in IEEE-754 is
 * 47.775000000000006, and any implementation that touches a `number` will
 * eventually round the wrong way on some product. These tests pin the exact
 * results a fraction-of-integers implementation gives.
 */
import { describe, expect, it } from 'vitest';
import { convert, conversionFor } from '../../src/modules/catalog/bulk-price.service.js';

/** INR minor units to the named currency, at `rate`, with `rounding`. */
function from(
  amount: bigint,
  rate: string,
  rounding: 'exact' | 'whole' | 'charm',
  targetCurrency = 'EUR',
): bigint {
  return convert(
    amount,
    conversionFor({ sourceCurrency: 'INR', targetCurrency, rate, rounding }),
  );
}

describe('exact conversion', () => {
  it('converts a rupee price into euro without touching a float', () => {
    // ₹45.50 at 0.0105 is €0.47775, which is 47.775 minor units. Half-up: 48.
    expect(from(4550n, '0.0105', 'exact')).toBe(48n);
  });

  it('rounds half-up, the same direction as every other money operation', () => {
    // ₹10.00 at 0.0105 is exactly 10.5 minor units.
    expect(from(1000n, '0.0105', 'exact')).toBe(11n);
  });

  it('handles a rate above one', () => {
    // €1 = ₹92.50 read the other way: 100 EUR minor at 92.5 = 9250 INR minor.
    expect(
      convert(
        100n,
        conversionFor({
          sourceCurrency: 'EUR',
          targetCurrency: 'INR',
          rate: '92.5',
          rounding: 'exact',
        }),
      ),
    ).toBe(9250n);
  });
});

describe('rounding to a price a human would have typed', () => {
  it('rounds a part-unit price up to the next whole unit', () => {
    // €0.47775 -> €1.00. Never down: a rounded-down catalogue sells at a loss.
    expect(from(4550n, '0.0105', 'whole')).toBe(100n);
    // ₹4550 at 0.0105 is €47.775 -> €48.00.
    expect(from(455_000n, '0.0105', 'whole')).toBe(4800n);
  });

  it('lands charm pricing on the next .99', () => {
    // €47.775 -> €47.99, which is above the exact figure, not below it.
    expect(from(455_000n, '0.0105', 'charm')).toBe(4799n);
  });

  it('lifts an exact whole number to the .99 above it, never the one below', () => {
    // ₹4761.90… is contrived; take a rate that lands exactly on €50.00.
    const exact = from(500_000n, '0.01', 'exact');
    expect(exact).toBe(5000n);

    // €50.00 charm-priced must be €50.99, not €49.99 - the price may go up on
    // a rounding rule, but it must never quietly go down.
    expect(from(500_000n, '0.01', 'charm')).toBe(5099n);
  });

  it('treats charm as whole-unit pricing in a currency with no minor unit', () => {
    // Yen has no .99 to land on. ₹100 at 1.8 is ¥180.
    expect(from(10_000n, '1.8', 'charm', 'JPY')).toBe(180n);
    expect(from(10_000n, '1.8', 'whole', 'JPY')).toBe(180n);
  });

  it('crosses the exponent boundary correctly in both directions', () => {
    // INR (2dp) -> JPY (0dp): ₹45.50 at 1.8 is ¥81.9 -> 82 exact, 82 whole.
    expect(from(4550n, '1.8', 'exact', 'JPY')).toBe(82n);

    // JPY (0dp) -> INR (2dp): ¥100 at 0.55 is ₹55.00 = 5500 minor.
    expect(
      convert(
        100n,
        conversionFor({
          sourceCurrency: 'JPY',
          targetCurrency: 'INR',
          rate: '0.55',
          rounding: 'exact',
        }),
      ),
    ).toBe(5500n);
  });
});

describe('rates the arithmetic must refuse', () => {
  const terms = { sourceCurrency: 'INR', targetCurrency: 'EUR', rounding: 'exact' } as const;

  it('rejects a rate of zero, which would price the catalogue at nothing', () => {
    expect(() => conversionFor({ ...terms, rate: '0' })).toThrow();
    expect(() => conversionFor({ ...terms, rate: '0.00' })).toThrow();
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const rate of ['1,05', '1.05e-2', '-0.5', 'abc', '', '0.000000001']) {
      expect(() => conversionFor({ ...terms, rate })).toThrow();
    }
  });

  it('rejects a currency the arithmetic does not know', () => {
    expect(() => conversionFor({ ...terms, targetCurrency: 'XXX', rate: '1' })).toThrow();
  });
});
