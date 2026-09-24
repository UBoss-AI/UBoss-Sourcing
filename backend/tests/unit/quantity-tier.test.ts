/**
 * Quantity price bands: which one applies, what the next one saves, and what
 * a seller may not save.
 */
import { describe, expect, it } from 'vitest';

import {
  nextSaving,
  priceForQuantity,
  savingBasisPoints,
  validateTiers,
  type QuantityTier,
  type TierBuyer,
} from '../../src/domain/quantity-tier.js';

const NOW = new Date('2026-09-24T10:00:00.000Z');
const guest: TierBuyer = { now: NOW, isBusinessBuyer: false, country: 'IN', channel: 'BASKET' };
const business: TierBuyer = { ...guest, isBusinessBuyer: true };

function tier(overrides: Partial<QuantityTier>): QuantityTier {
  return {
    id: `t${String(overrides.minQuantity ?? 1)}`,
    minQuantity: 1,
    maxQuantity: null,
    priceMinor: 900n,
    isActive: true,
    startsAt: null,
    endsAt: null,
    businessBuyersOnly: false,
    countryCodes: null,
    preorderOnly: false,
    ...overrides,
  };
}

const LADDER = [
  tier({ minQuantity: 100, priceMinor: 950n }),
  tier({ minQuantity: 500, priceMinor: 920n }),
  tier({ minQuantity: 2000, priceMinor: 880n }),
];

describe('priceForQuantity', () => {
  it('charges list below the first band and the band it reaches above', () => {
    expect(priceForQuantity(1000n, LADDER, 99, guest)).toEqual({
      unitPriceMinor: 1000n,
      tier: null,
    });
    expect(priceForQuantity(1000n, LADDER, 100, guest).unitPriceMinor).toBe(950n);
    expect(priceForQuantity(1000n, LADDER, 499, guest).unitPriceMinor).toBe(950n);
    expect(priceForQuantity(1000n, LADDER, 500, guest).unitPriceMinor).toBe(920n);
    expect(priceForQuantity(1000n, LADDER, 1_000_000, guest).unitPriceMinor).toBe(880n);
  });

  it('respects a bounded band and falls back once past it', () => {
    const bounded = [tier({ minQuantity: 10, maxQuantity: 49, priceMinor: 900n })];
    expect(priceForQuantity(1000n, bounded, 49, guest).unitPriceMinor).toBe(900n);
    expect(priceForQuantity(1000n, bounded, 50, guest).unitPriceMinor).toBe(1000n);
  });

  it('never makes a line dearer than list', () => {
    expect(priceForQuantity(800n, LADDER, 600, guest)).toEqual({
      unitPriceMinor: 800n,
      tier: null,
    });
  });

  it('applies business-only, country and preorder-only bands only to those buyers', () => {
    const special = [
      tier({ minQuantity: 10, priceMinor: 700n, businessBuyersOnly: true }),
      tier({ minQuantity: 10, priceMinor: 650n, countryCodes: ['DE'] }),
      tier({ minQuantity: 10, priceMinor: 600n, preorderOnly: true }),
    ];
    expect(priceForQuantity(1000n, special, 10, guest).unitPriceMinor).toBe(1000n);
    expect(priceForQuantity(1000n, special, 10, business).unitPriceMinor).toBe(700n);
    expect(priceForQuantity(1000n, special, 10, { ...guest, country: 'DE' }).unitPriceMinor).toBe(
      650n,
    );
    expect(priceForQuantity(1000n, special, 10, { ...guest, country: null }).unitPriceMinor).toBe(
      1000n,
    );
    expect(
      priceForQuantity(1000n, special, 10, { ...business, channel: 'PREORDER' }).unitPriceMinor,
    ).toBe(600n);
  });

  it('ignores a paused band and one outside its window', () => {
    const timed = [
      tier({ minQuantity: 10, priceMinor: 700n, isActive: false }),
      tier({ minQuantity: 20, priceMinor: 750n, startsAt: new Date('2026-10-01T00:00:00Z') }),
      tier({ minQuantity: 30, priceMinor: 760n, endsAt: NOW }),
    ];
    expect(priceForQuantity(1000n, timed, 100, guest).unitPriceMinor).toBe(1000n);
  });
});

describe('nextSaving', () => {
  it('names the nearest band that lowers the price, and how many more reach it', () => {
    expect(nextSaving(1000n, LADDER, 480, guest)).toMatchObject({
      addQuantity: 20,
      unitPriceMinor: 920n,
      savingPerPieceMinor: 30n,
    });
    expect(nextSaving(1000n, LADDER, 5000, guest)).toBeNull();
  });

  it('does not offer a band this buyer cannot have', () => {
    const onlyBusiness = [tier({ minQuantity: 100, priceMinor: 900n, businessBuyersOnly: true })];
    expect(nextSaving(1000n, onlyBusiness, 50, guest)).toBeNull();
    expect(nextSaving(1000n, onlyBusiness, 50, business)?.addQuantity).toBe(50);
  });
});

describe('savingBasisPoints', () => {
  it('is whole basis points, rounded down, and never negative', () => {
    expect(savingBasisPoints(1000n, 920n)).toBe(800);
    expect(savingBasisPoints(3n, 2n)).toBe(3333);
    expect(savingBasisPoints(1000n, 1200n)).toBe(0);
  });
});

describe('validateTiers', () => {
  it('accepts an ordinary ladder', () => {
    expect(validateTiers(1000n, LADDER)).toEqual([]);
  });

  it('refuses a band that is not a discount, and a price that goes up with quantity', () => {
    const codes = validateTiers(1000n, [
      tier({ minQuantity: 100, priceMinor: 900n }),
      tier({ minQuantity: 500, priceMinor: 950n }),
      tier({ minQuantity: 900, priceMinor: 1000n }),
    ]).map((p) => p.code);
    expect(codes).toContain('PRICE_NOT_DECREASING');
    expect(codes).toContain('NOT_A_DISCOUNT');
  });

  it('refuses overlapping bounded bands, duplicates, inverted ranges and bad countries', () => {
    const codes = validateTiers(1000n, [
      tier({ minQuantity: 100, maxQuantity: 600, priceMinor: 950n }),
      tier({ minQuantity: 500, priceMinor: 900n }),
      tier({ minQuantity: 500, priceMinor: 890n }),
      tier({ minQuantity: 50, maxQuantity: 10, priceMinor: 990n, countryCodes: ['india'] }),
    ]).map((p) => p.code);
    expect(codes).toEqual(
      expect.arrayContaining(['OVERLAP', 'DUPLICATE_MINIMUM', 'RANGE_INVERTED', 'COUNTRY_INVALID']),
    );
  });

  it('lets bands for different buyers sit at the same quantities', () => {
    expect(
      validateTiers(1000n, [
        tier({ minQuantity: 100, priceMinor: 950n }),
        tier({ minQuantity: 200, priceMinor: 990n, businessBuyersOnly: true }),
      ]),
    ).toEqual([]);
  });
});
