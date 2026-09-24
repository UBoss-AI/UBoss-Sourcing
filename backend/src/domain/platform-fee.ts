/**
 * What the marketplace deducts from a seller's proceeds, and the tax on it.
 *
 * A SELLER-SETTLEMENT DEDUCTION. Nothing in this file is ever added to what a
 * buyer pays: a buyer pays for goods and delivery, and the platform's fee is
 * what the platform then keeps from the seller's share.
 *
 * Every rate arrives as an exact decimal string (Decimal(9,6), "10.000000")
 * and every amount as bigint minor units; rounding is half-up, once per step,
 * through the same `percentOf` the rest of the money code uses. No rate is a
 * constant here - the 15% tax on the platform fee that this deployment was
 * asked for is a row in `platform_fee_policies`, not a number in code.
 */
import { calculateTax, percentOf, sumMinor, type Minor } from './money.js';

export type PlatformFeeType = 'PERCENT' | 'FLAT' | 'PERCENT_PLUS_FLAT';
export type PlatformFeeBasis = 'PRODUCT_SUBTOTAL' | 'PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY';
export type PlatformFeeScope = 'GLOBAL' | 'MARKET' | 'CATEGORY' | 'SELLER';

export interface FeeRule {
  feeType: PlatformFeeType;
  feeBasis: PlatformFeeBasis;
  /** Percent as an exact decimal string. */
  percentRate: string;
  flatFeeMinor: Minor;
  minFeeMinor: Minor | null;
  maxFeeMinor: Minor | null;
  /** The configured tax on the fee, percent. */
  taxRatePercent: string;
}

/** The basis a rule charges on: goods, or goods plus the seller's own delivery. */
export function feeBasisFor(
  basis: PlatformFeeBasis,
  input: { goodsMinor: Minor; sellerDeliveryMinor: Minor },
): Minor {
  return basis === 'PRODUCT_SUBTOTAL' ? input.goodsMinor : input.goodsMinor + input.sellerDeliveryMinor;
}

/**
 * The fee on a basis.
 *
 * Percent, flat, or both; then held between the minimum and the maximum where
 * they are set. A basis of zero is a fee of zero whatever the flat part says:
 * a seller whose whole order was cancelled before anything was sold has not
 * used the platform for anything.
 */
export function platformFeeOn(rule: FeeRule, basisMinor: Minor): Minor {
  if (basisMinor <= 0n) return 0n;

  const percentPart = rule.feeType === 'FLAT' ? 0n : percentOf(basisMinor, rule.percentRate);
  const flatPart = rule.feeType === 'PERCENT' ? 0n : rule.flatFeeMinor;
  let fee = percentPart + flatPart;

  if (rule.minFeeMinor !== null && fee < rule.minFeeMinor) fee = rule.minFeeMinor;
  if (rule.maxFeeMinor !== null && fee > rule.maxFeeMinor) fee = rule.maxFeeMinor;
  // Never more than there was to take from.
  if (fee > basisMinor) fee = basisMinor;
  return fee;
}

/** The configured tax on the fee - on the FEE, never on the goods. */
export function taxOnPlatformFee(feeMinor: Minor, taxRatePercent: string): Minor {
  return calculateTax(feeMinor, taxRatePercent, false).taxMinor;
}

export interface SettlementInput {
  goodsMinor: Minor;
  sellerDeliveryMinor: Minor;
  platformFeeMinor: Minor;
  platformFeeTaxMinor: Minor;
  refundsAdjustmentsMinor: Minor;
}

/**
 *   gross seller proceeds
 * + seller-controlled delivery proceeds
 * - platform fee
 * - tax on platform fee
 * - refunds and adjustments
 * = estimated seller settlement
 */
export function estimatedSettlement(input: SettlementInput): Minor {
  return (
    sumMinor([input.goodsMinor, input.sellerDeliveryMinor]) -
    input.platformFeeMinor -
    input.platformFeeTaxMinor -
    input.refundsAdjustmentsMinor
  );
}

/**
 * The scope key a policy is stored and made unique under.
 *
 * One live version per key: 'GLOBAL', 'MARKET:IN', 'CATEGORY:<id>',
 * 'SELLER:<id>'.
 */
export function scopeKeyFor(scope: PlatformFeeScope, subject: string | null): string {
  if (scope === 'GLOBAL') return 'GLOBAL';
  if (subject === null || subject.trim() === '') {
    throw new RangeError(`A ${scope} fee policy needs the thing it applies to.`);
  }
  return `${scope}:${scope === 'MARKET' ? subject.trim().toUpperCase() : subject.trim()}`;
}

/**
 * The order policies are looked up in, most specific first.
 *
 * A seller's own negotiated terms beat a category's, which beat a market's,
 * which beat the platform's. Per LINE, because one seller's order can hold a
 * cold-chain reagent and a box of gloves filed under categories with
 * different fees.
 */
export function candidateScopeKeys(input: {
  sellerAccountId: string;
  categoryId: string | null;
  marketCountry: string | null;
}): string[] {
  const keys = [`SELLER:${input.sellerAccountId}`];
  if (input.categoryId !== null) keys.push(`CATEGORY:${input.categoryId}`);
  if (input.marketCountry !== null) keys.push(`MARKET:${input.marketCountry.toUpperCase()}`);
  keys.push('GLOBAL');
  return keys;
}

/**
 * The wording a settlement or invoice may use for the tax.
 *
 * "GST" is a legal claim. It is written only once a person with finance
 * authority has verified that this rule IS the applicable GST - until then
 * the configured label and rate are shown as exactly that, configured.
 */
export function feeTaxWording(input: {
  taxLabel: string;
  taxRatePercent: string;
  isTaxRuleVerified: boolean;
}): { label: string; verified: boolean } {
  const rate = trimRate(input.taxRatePercent);
  if (input.isTaxRuleVerified) return { label: `${input.taxLabel} (${rate}%)`, verified: true };
  return { label: `Tax on platform fee - configured ${rate}%`, verified: false };
}

/** "15.000000" -> "15", "12.500000" -> "12.5". */
export function trimRate(rate: string): string {
  if (!rate.includes('.')) return rate;
  const trimmed = rate.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}
