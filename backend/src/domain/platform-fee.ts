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
import { calculateTax, parseRateToScaled, percentOf, sumMinor, type Minor } from './money.js';

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

// ---------------------------------------------------------------------------
// Fee rules: value bands, volume tiers, seller tiers and promotions
// ---------------------------------------------------------------------------
//
// A rule never stands alone. It adjusts the fee the POLICY in force would
// charge, so a deployment with no rules settles exactly as it did before they
// existed. Two stages, always in this order:
//
//   1. RATE. Of the value-band, volume-tier and seller-tier rules that match,
//      the one with the LOWEST percentage replaces the policy's percentage.
//      Lowest, not "most specific", so a seller who qualifies twice is never
//      charged the worse of two rates the operator published. The flat part,
//      the minimum and the maximum remain the policy's. A FLAT policy has no
//      percentage to replace and is left alone.
//   2. PROMOTION. Of the promotions that match, the largest discount is taken
//      off the fee from stage 1. Promotions do not stack.
//
// A rule matches when it is live at the order's confirmation instant
// (effectiveFrom <= at < effectiveTo), its scope key is one of the order's
// candidate keys, and its own condition holds. Value and volume amounts are in
// the rule's currency; a rule in another currency never matches.

export type FeeRuleKind = 'VALUE_BAND' | 'VOLUME_TIER' | 'SELLER_TIER' | 'PROMOTION';

export interface FeeAdjustmentRule {
  id: string;
  kind: FeeRuleKind;
  name: string;
  scopeKey: string;
  currency: string | null;
  minValueMinor: Minor | null;
  maxValueMinor: Minor | null;
  volumeThresholdMinor: Minor | null;
  volumeWindowDays: number | null;
  sellerTier: string | null;
  /** Exact decimal percent, or null. */
  percentRate: string | null;
  discountPercent: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
}

export interface FeeRuleContext {
  /** Every candidate scope key the order's goods share (see `candidateScopeKeys`). */
  scopeKeys: readonly string[];
  currency: string;
  /** The fee basis the policy charges on, for value bands. */
  basisMinor: Minor;
  /** The seller's goods sold over each window a live volume rule asks about. */
  volumeByWindowDays: ReadonlyMap<number, Minor>;
  sellerTier: string | null;
  at: Date;
}

export interface AppliedFeeRule {
  ruleId: string;
  kind: FeeRuleKind;
  name: string;
  /** The rate set, or the discount taken, as an exact decimal string. */
  percent: string;
  /** Fee before this rule minus fee after it. Positive saves the seller money. */
  effectMinor: Minor;
}

export interface FeeRuleOutcome {
  rule: FeeRule;
  feeMinor: Minor;
  /** What the policy alone would have charged. */
  baseFeeMinor: Minor;
  applied: AppliedFeeRule[];
}

/** Normalised tier label: trimmed, upper case, or null. */
export function normaliseTier(tier: string | null | undefined): string | null {
  const trimmed = (tier ?? '').trim().toUpperCase();
  return trimmed === '' ? null : trimmed;
}

/** Whether a rule is live and its condition holds for this order. */
export function feeRuleMatches(rule: FeeAdjustmentRule, ctx: FeeRuleContext): boolean {
  if (rule.effectiveFrom.getTime() > ctx.at.getTime()) return false;
  if (rule.effectiveTo !== null && rule.effectiveTo.getTime() <= ctx.at.getTime()) return false;
  if (!ctx.scopeKeys.includes(rule.scopeKey)) return false;

  switch (rule.kind) {
    case 'VALUE_BAND': {
      if (rule.currency !== ctx.currency || rule.minValueMinor === null) return false;
      if (ctx.basisMinor < rule.minValueMinor) return false;
      return rule.maxValueMinor === null || ctx.basisMinor < rule.maxValueMinor;
    }
    case 'VOLUME_TIER': {
      if (rule.currency !== ctx.currency || rule.volumeThresholdMinor === null || rule.volumeWindowDays === null) {
        return false;
      }
      const volume = ctx.volumeByWindowDays.get(rule.volumeWindowDays);
      return volume !== undefined && volume >= rule.volumeThresholdMinor;
    }
    case 'SELLER_TIER': {
      const tier = normaliseTier(rule.sellerTier);
      return tier !== null && tier === normaliseTier(ctx.sellerTier);
    }
    case 'PROMOTION':
      return rule.discountPercent !== null;
  }
}

function comparePercent(a: string, b: string): number {
  const left = parseRateToScaled(a);
  const right = parseRateToScaled(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** A stable order for ties: earlier start first, then id. */
function tieBreak(a: FeeAdjustmentRule, b: FeeAdjustmentRule): number {
  const byStart = a.effectiveFrom.getTime() - b.effectiveFrom.getTime();
  if (byStart !== 0) return byStart;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The fee on a basis once the rules that match have been applied.
 *
 * Pure: the caller gathers the rules, the seller's tier and volume; this
 * decides. Deterministic for the same inputs, which is what lets a stored
 * settlement be recomputed by hand from its breakdown.
 */
export function applyFeeRules(
  base: FeeRule,
  rules: readonly FeeAdjustmentRule[],
  ctx: FeeRuleContext,
): FeeRuleOutcome {
  const baseFeeMinor = platformFeeOn(base, ctx.basisMinor);
  const matching = rules.filter((rule) => feeRuleMatches(rule, ctx));
  const applied: AppliedFeeRule[] = [];

  let rule = base;
  let feeMinor = baseFeeMinor;

  if (base.feeType !== 'FLAT') {
    const chosen = matching
      .filter((candidate) => candidate.kind !== 'PROMOTION' && candidate.percentRate !== null)
      .sort((a, b) => comparePercent(a.percentRate ?? '0', b.percentRate ?? '0') || tieBreak(a, b))[0];
    if (chosen !== undefined && chosen.percentRate !== null) {
      rule = { ...base, percentRate: chosen.percentRate };
      const adjusted = platformFeeOn(rule, ctx.basisMinor);
      applied.push({
        ruleId: chosen.id,
        kind: chosen.kind,
        name: chosen.name,
        percent: chosen.percentRate,
        effectMinor: feeMinor - adjusted,
      });
      feeMinor = adjusted;
    }
  }

  const promotion = matching
    .filter((candidate) => candidate.kind === 'PROMOTION' && candidate.discountPercent !== null)
    .sort((a, b) => comparePercent(b.discountPercent ?? '0', a.discountPercent ?? '0') || tieBreak(a, b))[0];
  if (promotion !== undefined && promotion.discountPercent !== null && feeMinor > 0n) {
    const discount = percentOf(feeMinor, promotion.discountPercent);
    applied.push({
      ruleId: promotion.id,
      kind: 'PROMOTION',
      name: promotion.name,
      percent: promotion.discountPercent,
      effectMinor: discount,
    });
    feeMinor -= discount;
  }

  return { rule, feeMinor, baseFeeMinor, applied };
}

/**
 * Maker-checker: may this person approve what these people made?
 *
 * The approver must be a named person, and none of the creator, the last
 * editor and the submitter. "Named" matters: a system actor with no user id
 * could otherwise approve anything, which is no second pair of eyes at all.
 */
export function isIndependentApprover(
  approverUserId: string | null,
  makers: { createdByUserId: string | null; lastEditedByUserId: string | null; submittedByUserId: string | null },
): boolean {
  if (approverUserId === null) return false;
  return (
    approverUserId !== makers.createdByUserId &&
    approverUserId !== makers.lastEditedByUserId &&
    approverUserId !== makers.submittedByUserId
  );
}
