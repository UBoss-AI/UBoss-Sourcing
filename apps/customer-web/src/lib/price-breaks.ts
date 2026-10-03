/** Pure arithmetic for the quantity slider (ENH-027). Money stays BigInt minor units. */
import type { BulkOfferCard } from '@/lib/bulk-pricing';
import type { ProductSourcing } from '@/lib/types';

export interface BreakCapacity {
  unitsPerWeek: number | null;
  leadTimeDaysMin: number | null;
  leadTimeDaysMax: number | null;
}

/** The band a quantity falls in: the highest minimum at or below it, inside its maximum. */
export function bandFor(offers: BulkOfferCard[], quantity: number): BulkOfferCard | null {
  const sorted = [...offers].sort((a, b) => a.minQuantity - b.minQuantity);
  let found: BulkOfferCard | null = null;
  for (const offer of sorted) {
    if (offer.minQuantity <= quantity && (offer.maxQuantity === null || quantity <= offer.maxQuantity)) found = offer;
  }
  return found;
}

export function sliderRange(offers: BulkOfferCard[]): { min: number; max: number } {
  const mins = offers.map((offer) => offer.minQuantity);
  const min = Math.max(1, Math.min(...mins));
  const top = Math.max(...offers.map((offer) => offer.maxQuantity ?? offer.minQuantity * 2));
  return { min, max: Math.max(min, top) };
}

export function breakAt(offers: BulkOfferCard[], quantity: number, capacity: BreakCapacity | null) {
  const band = bandFor(offers, quantity);
  const total = band === null ? null : BigInt(band.unitPrice.minor) * BigInt(quantity);
  const perWeek = capacity?.unitsPerWeek ?? null;
  const productionWeeks = perWeek === null || perWeek <= 0 ? null : Math.ceil(quantity / perWeek);
  return { band, totalMinor: total, productionWeeks };
}

/** The listing's stated capacity and lead time; null when the product has no sourcing block. */
export function capacityFromSourcing(sourcing: ProductSourcing | null | undefined): BreakCapacity | null {
  if (sourcing === null || sourcing === undefined) return null;
  const fallback = sourcing.capacity?.leadTimeDays ?? null;
  return {
    unitsPerWeek: sourcing.capacity?.unitsPerWeek ?? null,
    leadTimeDaysMin: sourcing.terms?.leadTimeDaysMin ?? fallback,
    leadTimeDaysMax: sourcing.terms?.leadTimeDaysMax ?? fallback,
  };
}
