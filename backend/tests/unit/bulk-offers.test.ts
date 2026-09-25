/**
 * The offer cards: every figure exact, nothing invented, "best value" only
 * when it is true.
 */
import { describe, expect, it } from 'vitest';
import { bulkOffers } from '../../src/domain/bulk-offers.js';
import type { QuantityTier, TierBuyer } from '../../src/domain/quantity-tier.js';

const buyer: TierBuyer = {
  now: new Date('2026-09-25T10:00:00.000Z'),
  isBusinessBuyer: false,
  country: 'IN',
  channel: 'BASKET',
};

function tier(minQuantity: number, priceMinor: bigint, extra: Partial<QuantityTier> = {}): QuantityTier {
  return {
    id: `t${String(minQuantity)}`,
    minQuantity,
    maxQuantity: null,
    priceMinor,
    isActive: true,
    startsAt: null,
    endsAt: null,
    businessBuyersOnly: false,
    countryCodes: null,
    preorderOnly: false,
    ...extra,
  };
}

// List ₹180.00 a piece; 10 at ₹175, 100 at ₹165, 1,000 at ₹150.
const LIST = 18_000n;
const TIERS = [tier(10, 17_500n), tier(100, 16_500n), tier(1_000, 15_000n)];

describe('bulkOffers', () => {
  it('shows every band together with exact savings and totals', () => {
    const offers = bulkOffers({ listPriceMinor: LIST, tiers: TIERS, buyer, quantity: 4, stock: 500 });

    expect(offers.map((o) => o.minQuantity)).toEqual([10, 100, 1_000]);
    expect(offers[0]).toMatchObject({
      unitPriceMinor: 17_500n,
      savingPerPieceMinor: 500n,
      lineTotalMinor: 175_000n,
      totalSavingMinor: 5_000n,
      savingBasisPoints: 277,
      withinStock: true,
    });
    expect(offers[1]).toMatchObject({
      savingPerPieceMinor: 1_500n,
      totalSavingMinor: 150_000n,
      lineTotalMinor: 1_650_000n,
    });
    expect(offers[2]).toMatchObject({
      savingPerPieceMinor: 3_000n,
      totalSavingMinor: 3_000_000n,
      lineTotalMinor: 15_000_000n,
      savingBasisPoints: 1_666,
      withinStock: false,
    });
  });

  it('marks the current, the next and the best value', () => {
    const offers = bulkOffers({ listPriceMinor: LIST, tiers: TIERS, buyer, quantity: 40, stock: 500 });
    expect(offers.map((o) => [o.minQuantity, o.isCurrent, o.isNext, o.isBestValue])).toEqual([
      [10, true, false, false],
      [100, false, true, false],
      [1_000, false, false, true],
    ]);
  });

  it('invents nothing: no bands, no cards; a band at list price is not an offer', () => {
    expect(bulkOffers({ listPriceMinor: LIST, tiers: [], buyer, quantity: 5, stock: 10 })).toEqual([]);
    expect(
      bulkOffers({ listPriceMinor: LIST, tiers: [tier(10, LIST)], buyer, quantity: 5, stock: 10 }),
    ).toEqual([]);
  });

  it('does not call a lone offer, or a tie, the best value', () => {
    const lone = bulkOffers({ listPriceMinor: LIST, tiers: [tier(10, 17_000n)], buyer, quantity: 1, stock: 0 });
    expect(lone[0]?.isBestValue).toBe(false);

    const tie = bulkOffers({
      listPriceMinor: LIST,
      tiers: [tier(10, 17_000n, { maxQuantity: 49 }), tier(50, 17_000n)],
      buyer,
      quantity: 1,
      stock: 0,
    });
    expect(tie.every((o) => !o.isBestValue)).toBe(true);
  });

  it('respects who the buyer is and when: business-only, expired, preorder-only and country bands', () => {
    const tiers = [
      tier(10, 17_000n, { businessBuyersOnly: true }),
      tier(20, 16_900n, { endsAt: new Date('2026-09-01T00:00:00.000Z') }),
      tier(30, 16_800n, { preorderOnly: true }),
      tier(40, 16_700n, { countryCodes: ['DE'] }),
      tier(50, 16_600n),
    ];
    const retail = bulkOffers({ listPriceMinor: LIST, tiers, buyer, quantity: 1, stock: 999 });
    expect(retail.map((o) => o.minQuantity)).toEqual([50]);

    const business = bulkOffers({
      listPriceMinor: LIST,
      tiers,
      buyer: { ...buyer, isBusinessBuyer: true, country: 'DE' },
      quantity: 1,
      stock: 999,
    });
    expect(business.map((o) => o.minQuantity)).toEqual([10, 40, 50]);
  });

  it('prices each card at what the basket would charge where bands overlap', () => {
    // A wide cheap band covers the start of a narrower dearer one.
    const offers = bulkOffers({
      listPriceMinor: LIST,
      tiers: [tier(10, 16_000n), tier(20, 17_000n, { maxQuantity: 30 })],
      buyer,
      quantity: 1,
      stock: 100,
    });
    // At 20 the basket charges 160.00 (the cheaper overlapping band), so the
    // second card says so, and neither card is strictly cheaper.
    expect(offers.map((o) => o.unitPriceMinor)).toEqual([16_000n, 16_000n]);
    expect(offers.some((o) => o.isBestValue)).toBe(false);
  });

  it('stays exact far beyond what a float can hold', () => {
    const offers = bulkOffers({
      listPriceMinor: 9_007_199_254_740_993n,
      tiers: [tier(100_000_000, 9_007_199_254_740_001n)],
      buyer,
      quantity: 1,
      stock: 0,
    });
    expect(offers[0]?.totalSavingMinor).toBe(99_200_000_000n);
    expect(offers[0]?.lineTotalMinor).toBe(900_719_925_474_000_100_000_000n);
  });
});
