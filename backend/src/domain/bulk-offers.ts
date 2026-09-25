/**
 * Every bulk offer a buyer can reach, as cards: "buy 100, pay 165 each, save
 * 1,500 in total".
 *
 * Built from the same two functions the basket prices with -
 * `priceForQuantity` and `nextSaving` - so a card never promises a price the
 * checkout would not charge. Nothing is invented:
 *
 *   - A band whose effective price at its own minimum is not below the list
 *     price produces no card. A seller's band that happens to match the list
 *     price is not an offer, and showing "save 0" would be one.
 *   - The price on a card is what `priceForQuantity` answers AT that minimum,
 *     so two overlapping bands show the price the basket would actually use.
 *   - "Best value" is said only when it is true: at least two offers, and one
 *     of them strictly cheaper per piece than every other.
 *   - Percentages are the configured prices' own saving in whole basis points,
 *     rounded down, never a float.
 *
 * All money is BigInt minor units in the offer's currency.
 */
import {
  ladderFor,
  nextSaving,
  priceForQuantity,
  savingBasisPoints,
  type QuantityTier,
  type TierBuyer,
} from './quantity-tier.js';

export interface BulkOffer {
  minQuantity: number;
  maxQuantity: number | null;
  unitPriceMinor: bigint;
  /** List price minus the price at this band. */
  savingPerPieceMinor: bigint;
  /** unit price x minimum quantity: what buying exactly the minimum costs. */
  lineTotalMinor: bigint;
  /** saving per piece x minimum quantity. */
  totalSavingMinor: bigint;
  savingBasisPoints: number;
  businessBuyersOnly: boolean;
  endsAt: Date | null;
  /** The band the chosen quantity is priced by now. */
  isCurrent: boolean;
  /** The nearest band above the chosen quantity that lowers the price. */
  isNext: boolean;
  /** Strictly the cheapest per piece, of two or more offers. */
  isBestValue: boolean;
  /** The minimum can be met from stock; past it the rest is a preorder. */
  withinStock: boolean;
}

export function bulkOffers(input: {
  listPriceMinor: bigint;
  tiers: readonly QuantityTier[];
  buyer: TierBuyer;
  /** Pieces chosen now. */
  quantity: number;
  /** Pieces that can be promised from stock. */
  stock: number;
}): BulkOffer[] {
  const { listPriceMinor, tiers, buyer } = input;
  const quantity = Math.max(1, input.quantity);
  const current = priceForQuantity(listPriceMinor, tiers, quantity, buyer);
  const upcoming = nextSaving(listPriceMinor, tiers, quantity, buyer);

  const seen = new Set<number>();
  const offers: Omit<BulkOffer, 'isBestValue'>[] = [];

  for (const tier of ladderFor(tiers, buyer)) {
    if (seen.has(tier.minQuantity)) continue;
    seen.add(tier.minQuantity);

    const unit = priceForQuantity(listPriceMinor, tiers, tier.minQuantity, buyer).unitPriceMinor;
    if (unit >= listPriceMinor) continue;

    const saving = listPriceMinor - unit;
    const pieces = BigInt(tier.minQuantity);
    offers.push({
      minQuantity: tier.minQuantity,
      maxQuantity: tier.maxQuantity,
      unitPriceMinor: unit,
      savingPerPieceMinor: saving,
      lineTotalMinor: unit * pieces,
      totalSavingMinor: saving * pieces,
      savingBasisPoints: savingBasisPoints(listPriceMinor, unit),
      businessBuyersOnly: tier.businessBuyersOnly,
      endsAt: tier.endsAt,
      isCurrent: current.tier !== null && current.tier.minQuantity === tier.minQuantity,
      isNext: upcoming !== null && upcoming.tier.minQuantity === tier.minQuantity,
      withinStock: tier.minQuantity <= input.stock,
    });
  }

  let cheapest: bigint | null = null;
  let cheapestCount = 0;
  for (const offer of offers) {
    if (cheapest === null || offer.unitPriceMinor < cheapest) {
      cheapest = offer.unitPriceMinor;
      cheapestCount = 1;
    } else if (offer.unitPriceMinor === cheapest) {
      cheapestCount += 1;
    }
  }

  return offers.map((offer) => ({
    ...offer,
    isBestValue: offers.length >= 2 && cheapestCount === 1 && offer.unitPriceMinor === cheapest,
  }));
}
