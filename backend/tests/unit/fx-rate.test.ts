/**
 * The margin the refresh adds on top of a fetched rate.
 *
 * Small, and the reason it is tested anyway: it sits between a feed and every
 * price in a market, it is the only place a percentage meets a rate, and it is
 * exactly the shape of arithmetic that quietly turns into a float. A margin
 * that is 0.4% wrong is a margin nobody notices and everybody pays.
 */
import { describe, expect, it } from 'vitest';
import { applyMargin } from '../../src/modules/settings/fx-rate.service.js';
import { convert, conversionFor } from '../../src/modules/catalog/bulk-price.service.js';

describe('applyMargin', () => {
  it('returns the rate unchanged at zero', () => {
    expect(applyMargin('0.01050000', '0.00')).toBe('0.01050000');
  });

  it('adds a whole percentage', () => {
    // 0.0105 + 2% = 0.01071
    expect(applyMargin('0.01050000', '2.00')).toBe('0.01071000');
  });

  it('adds a fractional percentage without reaching for a float', () => {
    // 0.0105 * 1.025 = 0.01076250 exactly. In IEEE-754 this is
    // 0.010762500000000002, which would round a price up a cent at some
    // amounts and not at others.
    expect(applyMargin('0.01050000', '2.50')).toBe('0.01076250');
  });

  it('handles a rate above one', () => {
    expect(applyMargin('92.50000000', '1.00')).toBe('93.42500000');
  });

  it('survives a rate written with fewer decimal places', () => {
    expect(applyMargin('0.5', '10.00')).toBe('0.55000000');
  });

  it('produces a rate the conversion still accepts', () => {
    // The two halves have to agree on the format: `conversionFor` rejects
    // anything over eight decimal places, and `applyMargin` always emits
    // exactly eight.
    const rate = applyMargin('0.01050000', '2.50');
    const conversion = conversionFor({
      sourceCurrency: 'INR',
      targetCurrency: 'EUR',
      rate,
      rounding: 'exact',
    });

    // ₹4550.00 * 0.0107625 = €48.9694, which is 4896.94 minor units and
    // rounds half-up to 4897.
    expect(convert(455_000n, conversion)).toBe(4897n);
  });
});
