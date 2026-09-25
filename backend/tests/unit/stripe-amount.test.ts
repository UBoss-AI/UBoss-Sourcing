/**
 * The integer Stripe is asked to charge.
 *
 * Identity for almost everything - that is the point - and a refusal, never a
 * rounding, for the handful of amounts Stripe cannot take as they are.
 */
import { describe, expect, it } from 'vitest';
import {
  STRIPE_MAX_AMOUNT_MINOR,
  StripeAmountError,
  toStripeAmount,
} from '../../src/domain/stripe-amount.js';

function problemOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof StripeAmountError ? error.problem : 'OTHER';
  }
}

describe('toStripeAmount', () => {
  it('passes ₹1,800.00 through as 180000 paise', () => {
    expect(toStripeAmount(180_000n, 'INR')).toEqual({ amount: 180_000, currency: 'inr' });
  });

  it('passes €21.99 through as 2199 cents', () => {
    expect(toStripeAmount(2_199n, 'EUR')).toEqual({ amount: 2_199, currency: 'eur' });
  });

  it('passes a zero-decimal currency through unscaled', () => {
    expect(toStripeAmount(1_500n, 'JPY')).toEqual({ amount: 1_500, currency: 'jpy' });
  });

  it('refuses a HUF amount that is not whole forint, rather than rounding it', () => {
    expect(problemOf(() => toStripeAmount(12_345n, 'HUF'))).toBe('NOT_WHOLE_UNITS');
    expect(toStripeAmount(12_300n, 'HUF')).toEqual({ amount: 12_300, currency: 'huf' });
  });

  it('refuses nothing, and less than nothing', () => {
    expect(problemOf(() => toStripeAmount(0n, 'INR'))).toBe('NOT_POSITIVE');
    expect(problemOf(() => toStripeAmount(-1n, 'INR'))).toBe('NOT_POSITIVE');
  });

  it('refuses one minor unit above Stripe’s per-payment ceiling, and takes the ceiling', () => {
    expect(toStripeAmount(STRIPE_MAX_AMOUNT_MINOR, 'INR').amount).toBe(99_999_999);
    expect(problemOf(() => toStripeAmount(STRIPE_MAX_AMOUNT_MINOR + 1n, 'INR'))).toBe(
      'ABOVE_MAXIMUM',
    );
  });

  it('refuses a currency this store does not price in', () => {
    expect(problemOf(() => toStripeAmount(100n, 'XYZ'))).toBe('CURRENCY_NOT_SUPPORTED');
  });

  it('accepts the currency in either case', () => {
    expect(toStripeAmount(100n, 'usd')).toEqual({ amount: 100, currency: 'usd' });
  });
});
