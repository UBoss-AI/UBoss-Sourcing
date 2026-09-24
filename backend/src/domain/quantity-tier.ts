/**
 * Quantity price bands: "from 500 pieces, 9.20 each".
 *
 * THE ONE PLACE A BAND IS APPLIED
 *
 * The basket, the checkout (which prices from the basket), the preorder price
 * and the bulk-savings popover all call `priceForQuantity`. A second
 * implementation of "which band does 480 pieces fall in" is how a popover ends
 * up promising a price the checkout does not charge.
 *
 * THE RULES
 *
 *   - Quantities are BASE UNITS (pieces), the unit a cart line holds.
 *   - A band applies when it is active, inside its window, the quantity is in
 *     its range, and the buyer matches its conditions (business account,
 *     delivery country, and preorder-only bands only through a preorder).
 *   - Of the bands that apply, the cheapest wins - and only if it is cheaper
 *     than the list price. A band can never make a line dearer.
 *   - Money is BigInt minor units throughout. A band is a price per piece, so
 *     `unit x quantity` is exact and nothing is ever divided.
 */

export type TierChannel = 'BASKET' | 'PREORDER';

export interface QuantityTier {
  id: string;
  minQuantity: number;
  maxQuantity: number | null;
  priceMinor: bigint;
  isActive: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  businessBuyersOnly: boolean;
  countryCodes: string[] | null;
  preorderOnly: boolean;
}

export interface TierBuyer {
  now: Date;
  isBusinessBuyer: boolean;
  /** ISO alpha-2 delivery country, or null when not known yet. */
  country: string | null;
  channel: TierChannel;
}

/** Does this band apply to this buyer, ignoring quantity? */
export function tierEligible(tier: QuantityTier, buyer: TierBuyer): boolean {
  if (!tier.isActive) return false;
  if (tier.startsAt !== null && buyer.now < tier.startsAt) return false;
  if (tier.endsAt !== null && buyer.now >= tier.endsAt) return false;
  if (tier.businessBuyersOnly && !buyer.isBusinessBuyer) return false;
  if (tier.preorderOnly && buyer.channel !== 'PREORDER') return false;
  if (tier.countryCodes !== null) {
    // A band aimed at some countries does not apply before the country is
    // known: promising it and then withdrawing it at checkout is worse.
    if (buyer.country === null || !tier.countryCodes.includes(buyer.country.toUpperCase()))
      return false;
  }
  return true;
}

export function tierCovers(tier: QuantityTier, quantity: number): boolean {
  return (
    quantity >= tier.minQuantity && (tier.maxQuantity === null || quantity <= tier.maxQuantity)
  );
}

export interface TierPrice {
  unitPriceMinor: bigint;
  /** The band that set the price, or null when the list price applied. */
  tier: QuantityTier | null;
}

/** The price per piece for this many pieces. */
export function priceForQuantity(
  listPriceMinor: bigint,
  tiers: readonly QuantityTier[],
  quantity: number,
  buyer: TierBuyer,
): TierPrice {
  let best: TierPrice = { unitPriceMinor: listPriceMinor, tier: null };
  for (const tier of tiers) {
    if (!tierEligible(tier, buyer) || !tierCovers(tier, quantity)) continue;
    if (
      tier.priceMinor < best.unitPriceMinor ||
      // Same price: the more specific (higher-starting) band is the one named.
      (best.tier !== null &&
        tier.priceMinor === best.unitPriceMinor &&
        tier.minQuantity > best.tier.minQuantity)
    ) {
      best = { unitPriceMinor: tier.priceMinor, tier };
    }
  }
  return best;
}

export interface NextSaving {
  tier: QuantityTier;
  /** How many more pieces reach it. */
  addQuantity: number;
  unitPriceMinor: bigint;
  /** Per piece, against what this quantity pays now. */
  savingPerPieceMinor: bigint;
}

/** The nearest band above this quantity that would lower the price per piece. */
export function nextSaving(
  listPriceMinor: bigint,
  tiers: readonly QuantityTier[],
  quantity: number,
  buyer: TierBuyer,
): NextSaving | null {
  const current = priceForQuantity(listPriceMinor, tiers, quantity, buyer).unitPriceMinor;
  let nearest: NextSaving | null = null;
  for (const tier of tiers) {
    if (tier.minQuantity <= quantity || !tierEligible(tier, buyer)) continue;
    const there = priceForQuantity(listPriceMinor, tiers, tier.minQuantity, buyer).unitPriceMinor;
    if (there >= current) continue;
    if (nearest === null || tier.minQuantity < nearest.tier.minQuantity) {
      nearest = {
        tier,
        addQuantity: tier.minQuantity - quantity,
        unitPriceMinor: there,
        savingPerPieceMinor: current - there,
      };
    }
  }
  return nearest;
}

/** The bands this buyer could reach, in quantity order. */
export function ladderFor(tiers: readonly QuantityTier[], buyer: TierBuyer): QuantityTier[] {
  return tiers
    .filter((tier) => tierEligible(tier, buyer))
    .sort((a, b) => a.minQuantity - b.minQuantity);
}

/** A saving as whole basis points (1% = 100), rounded down. Never a float. */
export function savingBasisPoints(listPriceMinor: bigint, priceMinor: bigint): number {
  if (listPriceMinor <= 0n || priceMinor >= listPriceMinor) return 0;
  return Number(((listPriceMinor - priceMinor) * 10_000n) / listPriceMinor);
}

// ---------------------------------------------------------------------------
// Validation, for the seller's editor
// ---------------------------------------------------------------------------

export interface TierProblem {
  /** Index into the submitted list; -1 for the list as a whole. */
  index: number;
  code:
    | 'MIN_TOO_LOW'
    | 'RANGE_INVERTED'
    | 'PRICE_NOT_POSITIVE'
    | 'NOT_A_DISCOUNT'
    | 'WINDOW_INVERTED'
    | 'COUNTRY_INVALID'
    | 'DUPLICATE_MINIMUM'
    | 'OVERLAP'
    | 'PRICE_NOT_DECREASING'
    | 'TOO_MANY';
  /** The other band involved, for OVERLAP and PRICE_NOT_DECREASING. */
  otherIndex?: number;
}

export const MAX_TIERS = 20;

/** Bands that compete for the same buyers: same conditions, overlapping windows. */
function sameAudience(a: QuantityTier, b: QuantityTier): boolean {
  const countries = (tier: QuantityTier) =>
    tier.countryCodes === null ? '*' : [...tier.countryCodes].sort().join(',');
  if (a.businessBuyersOnly !== b.businessBuyersOnly || a.preorderOnly !== b.preorderOnly)
    return false;
  if (countries(a) !== countries(b)) return false;
  const aStart = a.startsAt?.getTime() ?? -Infinity;
  const aEnd = a.endsAt?.getTime() ?? Infinity;
  const bStart = b.startsAt?.getTime() ?? -Infinity;
  const bEnd = b.endsAt?.getTime() ?? Infinity;
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Everything wrong with a proposed set of bands, or an empty list.
 *
 * Among bands for the same buyers, a larger quantity may never cost more per
 * piece than a smaller one, and two bands may not cover the same quantity -
 * otherwise "which price applies" depends on which row was read first.
 */
export function validateTiers(
  listPriceMinor: bigint,
  tiers: readonly QuantityTier[],
): TierProblem[] {
  const problems: TierProblem[] = [];
  if (tiers.length > MAX_TIERS) problems.push({ index: -1, code: 'TOO_MANY' });

  const seen = new Map<number, number>();
  tiers.forEach((tier, index) => {
    if (!Number.isSafeInteger(tier.minQuantity) || tier.minQuantity < 1)
      problems.push({ index, code: 'MIN_TOO_LOW' });
    if (tier.maxQuantity !== null && tier.maxQuantity < tier.minQuantity)
      problems.push({ index, code: 'RANGE_INVERTED' });
    if (tier.priceMinor <= 0n) problems.push({ index, code: 'PRICE_NOT_POSITIVE' });
    else if (tier.priceMinor >= listPriceMinor) problems.push({ index, code: 'NOT_A_DISCOUNT' });
    if (tier.startsAt !== null && tier.endsAt !== null && tier.endsAt <= tier.startsAt) {
      problems.push({ index, code: 'WINDOW_INVERTED' });
    }
    if (
      tier.countryCodes !== null &&
      (tier.countryCodes.length === 0 || tier.countryCodes.some((code) => !/^[A-Z]{2}$/.test(code)))
    ) {
      problems.push({ index, code: 'COUNTRY_INVALID' });
    }
    const earlier = seen.get(tier.minQuantity);
    if (earlier !== undefined)
      problems.push({ index, code: 'DUPLICATE_MINIMUM', otherIndex: earlier });
    else seen.set(tier.minQuantity, index);
  });

  const indexed = tiers.map((tier, index) => ({ tier, index })).filter(({ tier }) => tier.isActive);
  for (let i = 0; i < indexed.length; i += 1) {
    for (let j = i + 1; j < indexed.length; j += 1) {
      const a = indexed[i];
      const b = indexed[j];
      if (a === undefined || b === undefined || !sameAudience(a.tier, b.tier)) continue;
      const [low, high] = a.tier.minQuantity <= b.tier.minQuantity ? [a, b] : [b, a];
      if (low.tier.minQuantity === high.tier.minQuantity) continue; // reported as DUPLICATE_MINIMUM
      if (low.tier.maxQuantity === null || low.tier.maxQuantity >= high.tier.minQuantity) {
        // Open-ended bands overlap by design ("from 100", "from 500"): the
        // cheaper one wins. Only a bounded band reaching into the next is an overlap.
        if (low.tier.maxQuantity !== null)
          problems.push({ index: high.index, code: 'OVERLAP', otherIndex: low.index });
      }
      if (high.tier.priceMinor > low.tier.priceMinor) {
        problems.push({ index: high.index, code: 'PRICE_NOT_DECREASING', otherIndex: low.index });
      }
    }
  }
  return problems;
}
