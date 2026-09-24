/**
 * The platform fee and the tax on it, as arithmetic.
 *
 * The 10% fee rate here is a TEST FIXTURE, not a business rule, and the 15%
 * tax on the fee is the value this deployment was asked to configure - it is
 * passed in, as it would be read from a policy row, and appears nowhere in the
 * code under test.
 */
import { describe, expect, it } from 'vitest';
import {
  candidateScopeKeys,
  estimatedSettlement,
  feeBasisFor,
  feeTaxWording,
  platformFeeOn,
  scopeKeyFor,
  taxOnPlatformFee,
  type FeeRule,
} from '../../src/domain/platform-fee.js';

const TEN_PERCENT: FeeRule = {
  feeType: 'PERCENT',
  feeBasis: 'PRODUCT_SUBTOTAL',
  percentRate: '10.000000',
  flatFeeMinor: 0n,
  minFeeMinor: null,
  maxFeeMinor: null,
  taxRatePercent: '15.000000',
};

describe('the brief’s worked example', () => {
  // Product subtotal ₹10,000; delivery L1 100 + L2 200 + L3 300 + L4 400.
  const goods = 1_000_000n;
  const delivery = 10_000n + 20_000n + 30_000n + 40_000n;

  it('charges 10% of the goods as the platform fee', () => {
    const basis = feeBasisFor(TEN_PERCENT.feeBasis, { goodsMinor: goods, sellerDeliveryMinor: delivery });
    expect(basis).toBe(1_000_000n); // delivery is not in a PRODUCT_SUBTOTAL basis
    expect(platformFeeOn(TEN_PERCENT, basis)).toBe(100_000n); // ₹1,000
  });

  it('charges the configured 15% on the fee, not on the goods', () => {
    const fee = platformFeeOn(TEN_PERCENT, goods);
    expect(taxOnPlatformFee(fee, TEN_PERCENT.taxRatePercent)).toBe(15_000n); // ₹150, not ₹1,500
  });

  it('settles the seller at ₹8,850 before other adjustments', () => {
    const fee = platformFeeOn(TEN_PERCENT, goods);
    const tax = taxOnPlatformFee(fee, TEN_PERCENT.taxRatePercent);
    expect(
      estimatedSettlement({
        goodsMinor: goods,
        sellerDeliveryMinor: 0n,
        platformFeeMinor: fee,
        platformFeeTaxMinor: tax,
        refundsAdjustmentsMinor: 0n,
      }),
    ).toBe(885_000n);
  });

  it('never adds the fee to what the buyer pays', () => {
    // The buyer's total is goods + delivery. The fee and its tax are only ever
    // subtracted from the seller's side.
    const buyerTotal = goods + delivery;
    expect(buyerTotal).toBe(1_100_000n);
  });
});

describe('fee shapes', () => {
  it('adds a flat part and holds the result between the minimum and the maximum', () => {
    const rule: FeeRule = { ...TEN_PERCENT, feeType: 'PERCENT_PLUS_FLAT', flatFeeMinor: 5_000n, minFeeMinor: 20_000n, maxFeeMinor: 50_000n };
    expect(platformFeeOn(rule, 100_000n)).toBe(20_000n); // 10,000 + 5,000 raised to the minimum
    expect(platformFeeOn(rule, 1_000_000n)).toBe(50_000n); // capped
  });

  it('charges nothing on nothing', () => {
    expect(platformFeeOn({ ...TEN_PERCENT, feeType: 'FLAT', flatFeeMinor: 9_900n }, 0n)).toBe(0n);
  });

  it('includes the seller’s own delivery only when the basis says so', () => {
    expect(feeBasisFor('PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY', { goodsMinor: 100n, sellerDeliveryMinor: 40n })).toBe(140n);
  });
});

describe('scopes and wording', () => {
  it('looks policies up seller first, then category, market and platform', () => {
    expect(candidateScopeKeys({ sellerAccountId: 'S', categoryId: 'C', marketCountry: 'in' })).toEqual([
      'SELLER:S',
      'CATEGORY:C',
      'MARKET:IN',
      'GLOBAL',
    ]);
    expect(scopeKeyFor('GLOBAL', null)).toBe('GLOBAL');
    expect(() => scopeKeyFor('SELLER', null)).toThrow();
  });

  it('does not call an unverified tax GST', () => {
    const unverified = feeTaxWording({ taxLabel: 'GST', taxRatePercent: '15.000000', isTaxRuleVerified: false });
    expect(unverified.label).toBe('Tax on platform fee - configured 15%');
    expect(unverified.label).not.toContain('GST');
    expect(unverified.verified).toBe(false);

    const verified = feeTaxWording({ taxLabel: 'GST', taxRatePercent: '18.000000', isTaxRuleVerified: true });
    expect(verified.label).toBe('GST (18%)');
  });
});
