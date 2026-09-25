/**
 * Turning an order's total into the integer Stripe is asked to charge.
 *
 * Both sides count in minor units, so for almost every currency this is the
 * identity: ₹1,800.00 is 180000 paise here and 180000 to Stripe, €21.99 is
 * 2199 cents to both. There is no decimal arithmetic anywhere in this file and
 * there must never be any - the number the customer agreed to at checkout is
 * a BigInt, and it reaches Stripe as the same integer or not at all.
 *
 * What this file exists for is the handful of places where "the same integer"
 * is not enough, each of which Stripe states in its currency documentation:
 *
 *   · The exponent has to agree. `money.ts` is the authority on how many
 *     decimals a currency has here; Stripe has its own list. Where they
 *     disagreed the same integer would be a different amount - so a currency
 *     whose Stripe exponent is not known to match is refused, never guessed.
 *   · HUF is two-decimal in Stripe's API but settles in whole forint, so an
 *     amount must be a multiple of 100.
 *   · A single payment has a ceiling: eight digits of minor units for most
 *     currencies (₹9,99,999.99, €999,999.99).
 *
 * Every refusal is a refusal. Rounding a payment changes what the customer is
 * charged, which is the one thing this code may not do.
 */
import { MoneyError, currencyExponent } from './money.js';

/**
 * How many decimals Stripe uses for each currency this deployment can price
 * in. Written out rather than assumed from `money.ts`, because the point is
 * that the two lists are checked against each other.
 */
const STRIPE_EXPONENT: Readonly<Record<string, number>> = Object.freeze({
  INR: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  AED: 2,
  SGD: 2,
  PLN: 2,
  BGN: 2,
  CZK: 2,
  DKK: 2,
  HUF: 2,
  RON: 2,
  SEK: 2,
  JPY: 0,
  KRW: 0,
});

/** Currencies Stripe charges in whole major units, while still counting two decimals. */
const WHOLE_UNIT_ONLY: ReadonlySet<string> = new Set(['HUF']);

/** Stripe's per-payment ceiling for most currencies: eight digits of minor units. */
export const STRIPE_MAX_AMOUNT_MINOR = 99_999_999n;

export type StripeAmountProblem =
  | 'NOT_POSITIVE'
  | 'ABOVE_MAXIMUM'
  | 'NOT_WHOLE_UNITS'
  | 'CURRENCY_NOT_SUPPORTED';

export class StripeAmountError extends Error {
  constructor(
    readonly problem: StripeAmountProblem,
    message: string,
  ) {
    super(message);
    this.name = 'StripeAmountError';
  }
}

export interface StripeAmount {
  /** Safe to send as a JSON/form number: checked against the ceiling above. */
  amount: number;
  /** Lowercase, as Stripe's API expects it. */
  currency: string;
}

export function toStripeAmount(amountMinor: bigint, currency: string): StripeAmount {
  const code = currency.toUpperCase();

  let ours: number;
  try {
    ours = currencyExponent(code);
  } catch (error) {
    if (error instanceof MoneyError) {
      throw new StripeAmountError('CURRENCY_NOT_SUPPORTED', `${code} is not a currency this store prices in.`);
    }
    throw error;
  }

  const theirs = STRIPE_EXPONENT[code];
  if (theirs === undefined || theirs !== ours) {
    throw new StripeAmountError(
      'CURRENCY_NOT_SUPPORTED',
      `${code} is not a currency whose Stripe amount is known to match this store's.`,
    );
  }

  if (amountMinor <= 0n) {
    throw new StripeAmountError('NOT_POSITIVE', 'A payment must be for more than nothing.');
  }

  if (amountMinor > STRIPE_MAX_AMOUNT_MINOR) {
    throw new StripeAmountError(
      'ABOVE_MAXIMUM',
      `${amountMinor.toString()} ${code} minor units is above Stripe's per-payment maximum.`,
    );
  }

  if (WHOLE_UNIT_ONLY.has(code) && amountMinor % 100n !== 0n) {
    throw new StripeAmountError(
      'NOT_WHOLE_UNITS',
      `Stripe charges ${code} in whole units, and ${amountMinor.toString()} minor units is not one.`,
    );
  }

  // Safe: the ceiling above is far inside Number.MAX_SAFE_INTEGER.
  return { amount: Number(amountMinor), currency: code.toLowerCase() };
}
