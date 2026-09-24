/**
 * Store-wide quantity discounts: a percentage turned into a band on one list
 * price, and the ladder rules an operator may not break.
 */
import { describe, expect, it } from 'vitest';

import {
  nextSaving,
  priceForQuantity,
  storeDiscountTiers,
  validateStoreDiscounts,
  type StoreQuantityDiscount,
  type TierBuyer,
} from '../../src/domain/quantity-tier.js';

const buyer: TierBuyer = {
  now: new Date('2026-09-24T10:00:00.000Z'),
  isBusinessBuyer: false,
  country: null,
  channel: 'BASKET',
};

function rule(minQuantity: number, discountBasisPoints: number, isActive = true): StoreQuantityDiscount {
  return { id: `d${String(minQuantity)}`, minQuantity, discountBasisPoints, isActive };
}

const LADDER = [rule(10, 300), rule(50, 500), rule(100, 800)];

describe('storeDiscountTiers', () => {
  it('turns each percentage into a price per piece, rounding the discount down', () => {
    // 3% of 999 is 29.97: 29 comes off, never 30.
    const tiers = storeDiscountTiers(999n, [rule(10, 300)]);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]?.priceMinor).toBe(970n);
  });

  it('prices a basket through priceForQuantity like a seller band', () => {
    const tiers = storeDiscountTiers(10_000n, LADDER);
    expect(priceForQuantity(10_000n, tiers, 9, buyer).unitPriceMinor).toBe(10_000n);
    expect(priceForQuantity(10_000n, tiers, 10, buyer).unitPriceMinor).toBe(9_700n);
    expect(priceForQuantity(10_000n, tiers, 75, buyer).unitPriceMinor).toBe(9_500n);
    expect(priceForQuantity(10_000n, tiers, 500, buyer).unitPriceMinor).toBe(9_200n);
  });

  it('tells a buyer what adding pieces saves per piece', () => {
    const tiers = storeDiscountTiers(10_000n, LADDER);
    const next = nextSaving(10_000n, tiers, 4, buyer);
    expect(next?.addQuantity).toBe(6);
    expect(next?.savingPerPieceMinor).toBe(300n);
    expect(nextSaving(10_000n, tiers, 100, buyer)).toBeNull();
  });

  it('leaves out paused rules and rules too small to take a whole minor unit off', () => {
    expect(storeDiscountTiers(10_000n, [rule(10, 300, false)])).toEqual([]);
    // 1% of 50 paise is half a paisa: no saving to show.
    expect(storeDiscountTiers(50n, [rule(10, 100)])).toEqual([]);
    expect(storeDiscountTiers(0n, LADDER)).toEqual([]);
  });
});

describe('validateStoreDiscounts', () => {
  it('accepts a rising ladder', () => {
    expect(validateStoreDiscounts(LADDER)).toEqual([]);
  });

  it('refuses a rule from one piece, a zero or huge discount, and a repeated start', () => {
    const codes = validateStoreDiscounts([rule(1, 300), rule(10, 0), rule(20, 9_500), rule(20, 600)]).map(
      (problem) => problem.code,
    );
    expect(codes).toContain('MIN_TOO_LOW');
    expect(codes).toContain('DISCOUNT_OUT_OF_RANGE');
    expect(codes).toContain('DUPLICATE_MINIMUM');
  });

  it('refuses a larger quantity that takes off less', () => {
    const problems = validateStoreDiscounts([rule(10, 500), rule(50, 300)]);
    expect(problems).toEqual([{ index: 1, code: 'DISCOUNT_NOT_INCREASING', otherIndex: 0 }]);
  });

  it('ignores a paused rule when checking the ladder', () => {
    expect(validateStoreDiscounts([rule(10, 500), rule(50, 300, false)])).toEqual([]);
  });

  it('refuses more than ten rules', () => {
    const many = Array.from({ length: 11 }, (_, i) => rule(10 + i, 100 + i));
    expect(validateStoreDiscounts(many).map((problem) => problem.code)).toContain('TOO_MANY');
  });
});
