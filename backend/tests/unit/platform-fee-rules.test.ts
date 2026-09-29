/**
 * Fee rules on top of a fee policy: value bands, volume tiers, seller tiers,
 * promotions, their dates, and the maker-checker test.
 *
 * Every rate and amount here is a fixture, not a business default.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import {
  applyFeeRules,
  feeRuleMatches,
  isIndependentApprover,
  type FeeAdjustmentRule,
  type FeeRule,
  type FeeRuleContext,
} from '../../src/domain/platform-fee.js';
import { calculateSettlement } from '../../src/modules/settings/platform-fee.service.js';

const AT = new Date('2026-10-01T10:00:00.000Z');

const policy: FeeRule = {
  feeType: 'PERCENT',
  feeBasis: 'PRODUCT_SUBTOTAL',
  percentRate: '10',
  flatFeeMinor: 0n,
  minFeeMinor: null,
  maxFeeMinor: null,
  taxRatePercent: '15',
};

function rule(overrides: Partial<FeeAdjustmentRule>): FeeAdjustmentRule {
  return {
    id: '01RULE00000000000000000001',
    kind: 'VALUE_BAND',
    name: 'Band',
    scopeKey: 'GLOBAL',
    currency: 'INR',
    minValueMinor: 0n,
    maxValueMinor: null,
    volumeThresholdMinor: null,
    volumeWindowDays: null,
    sellerTier: null,
    percentRate: '8',
    discountPercent: null,
    effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
    effectiveTo: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<FeeRuleContext> = {}): FeeRuleContext {
  return {
    scopeKeys: ['SELLER:01SELLER000000000000000000', 'MARKET:IN', 'GLOBAL'],
    currency: 'INR',
    basisMinor: 1_000_000n,
    volumeByWindowDays: new Map(),
    sellerTier: null,
    at: AT,
    ...overrides,
  };
}

describe('value bands', () => {
  const band = rule({ minValueMinor: 500_000n, maxValueMinor: 1_000_000n, percentRate: '7' });

  it('includes the lower bound and excludes the upper one', () => {
    expect(feeRuleMatches(band, ctx({ basisMinor: 500_000n }))).toBe(true);
    expect(feeRuleMatches(band, ctx({ basisMinor: 999_999n }))).toBe(true);
    expect(feeRuleMatches(band, ctx({ basisMinor: 1_000_000n }))).toBe(false);
    expect(feeRuleMatches(band, ctx({ basisMinor: 499_999n }))).toBe(false);
  });

  it('replaces the policy percentage inside the band', () => {
    const outcome = applyFeeRules(policy, [band], ctx({ basisMinor: 600_000n }));
    expect(outcome.baseFeeMinor).toBe(60_000n);
    expect(outcome.feeMinor).toBe(42_000n);
    expect(outcome.applied).toEqual([
      { ruleId: band.id, kind: 'VALUE_BAND', name: 'Band', percent: '7', effectMinor: 18_000n },
    ]);
  });

  it('never matches an order in another currency', () => {
    expect(feeRuleMatches(band, ctx({ basisMinor: 600_000n, currency: 'EUR' }))).toBe(false);
  });
});

describe('volume tiers', () => {
  const tier = rule({ kind: 'VOLUME_TIER', minValueMinor: null, volumeThresholdMinor: 5_000_000n, volumeWindowDays: 30, percentRate: '6' });

  it('applies at the threshold and not one unit below it', () => {
    expect(feeRuleMatches(tier, ctx({ volumeByWindowDays: new Map([[30, 5_000_000n]]) }))).toBe(true);
    expect(feeRuleMatches(tier, ctx({ volumeByWindowDays: new Map([[30, 4_999_999n]]) }))).toBe(false);
  });

  it('does not match when the volume for its window was never measured', () => {
    expect(feeRuleMatches(tier, ctx({ volumeByWindowDays: new Map([[90, 9_000_000n]]) }))).toBe(false);
  });
});

describe('seller tiers', () => {
  const gold = rule({ kind: 'SELLER_TIER', minValueMinor: null, sellerTier: 'GOLD', percentRate: '5', currency: null });

  it('matches the tier case-insensitively and nothing else', () => {
    expect(feeRuleMatches(gold, ctx({ sellerTier: 'gold' }))).toBe(true);
    expect(feeRuleMatches(gold, ctx({ sellerTier: 'SILVER' }))).toBe(false);
    expect(feeRuleMatches(gold, ctx({ sellerTier: null }))).toBe(false);
  });
});

describe('more than one rule', () => {
  it('uses the lowest rate among the rules that match', () => {
    const band = rule({ id: '01RULE00000000000000000001', percentRate: '8' });
    const gold = rule({ id: '01RULE00000000000000000002', kind: 'SELLER_TIER', sellerTier: 'GOLD', percentRate: '6.5' });
    const outcome = applyFeeRules(policy, [band, gold], ctx({ sellerTier: 'GOLD' }));
    expect(outcome.feeMinor).toBe(65_000n);
    expect(outcome.applied.map((entry) => entry.ruleId)).toEqual([gold.id]);
  });

  it('takes the largest promotion off the adjusted fee, and does not stack them', () => {
    const band = rule({ percentRate: '8' });
    const small = rule({ id: '01RULE00000000000000000003', kind: 'PROMOTION', percentRate: null, discountPercent: '10', effectiveTo: new Date('2026-12-01T00:00:00.000Z') });
    const big = rule({ id: '01RULE00000000000000000004', kind: 'PROMOTION', percentRate: null, discountPercent: '50', effectiveTo: new Date('2026-12-01T00:00:00.000Z') });
    const outcome = applyFeeRules(policy, [band, small, big], ctx());
    // 8% of 10,000.00 = 800.00; half off = 400.00.
    expect(outcome.feeMinor).toBe(40_000n);
    expect(outcome.applied.map((entry) => [entry.kind, entry.effectMinor])).toEqual([
      ['VALUE_BAND', 20_000n],
      ['PROMOTION', 40_000n],
    ]);
  });

  it('keeps the policy minimum and maximum on a replaced rate', () => {
    const capped: FeeRule = { ...policy, maxFeeMinor: 50_000n };
    const outcome = applyFeeRules(capped, [rule({ percentRate: '9' })], ctx());
    expect(outcome.feeMinor).toBe(50_000n);
  });

  it('leaves a flat policy alone for rate rules but still applies a promotion', () => {
    const flat: FeeRule = { ...policy, feeType: 'FLAT', percentRate: '0', flatFeeMinor: 10_000n };
    const promo = rule({ kind: 'PROMOTION', percentRate: null, discountPercent: '25', effectiveTo: new Date('2026-12-01T00:00:00.000Z') });
    const outcome = applyFeeRules(flat, [rule({ percentRate: '1' }), promo], ctx());
    expect(outcome.feeMinor).toBe(7_500n);
    expect(outcome.applied.map((entry) => entry.kind)).toEqual(['PROMOTION']);
  });
});

describe('effective dates and scope', () => {
  it('applies from effectiveFrom inclusive to effectiveTo exclusive', () => {
    const from = rule({ effectiveFrom: AT });
    expect(feeRuleMatches(from, ctx())).toBe(true);
    expect(feeRuleMatches(rule({ effectiveFrom: new Date(AT.getTime() + 1) }), ctx())).toBe(false);
    expect(feeRuleMatches(rule({ effectiveTo: AT }), ctx())).toBe(false);
    expect(feeRuleMatches(rule({ effectiveTo: new Date(AT.getTime() + 1) }), ctx())).toBe(true);
  });

  it('only applies to an order whose scope keys include its own', () => {
    expect(feeRuleMatches(rule({ scopeKey: 'MARKET:DE' }), ctx())).toBe(false);
    expect(feeRuleMatches(rule({ scopeKey: 'MARKET:IN' }), ctx())).toBe(true);
  });

  it('changes nothing when no rule matches', () => {
    const outcome = applyFeeRules(policy, [rule({ scopeKey: 'MARKET:DE' })], ctx());
    expect(outcome.feeMinor).toBe(outcome.baseFeeMinor);
    expect(outcome.applied).toEqual([]);
  });
});

describe('maker-checker', () => {
  const makers = { createdByUserId: 'maker', lastEditedByUserId: 'editor', submittedByUserId: 'submitter' };

  it('refuses the creator, the last editor, the submitter and a nameless actor', () => {
    expect(isIndependentApprover('maker', makers)).toBe(false);
    expect(isIndependentApprover('editor', makers)).toBe(false);
    expect(isIndependentApprover('submitter', makers)).toBe(false);
    expect(isIndependentApprover(null, makers)).toBe(false);
  });

  it('accepts somebody else', () => {
    expect(isIndependentApprover('checker', makers)).toBe(true);
  });
});

describe('calculateSettlement with fee rules', () => {
  function client(rules: unknown[], tier: string | null) {
    return {
      sellerAccount: { findUnique: () => Promise.resolve({ commissionBasisPoints: null, feeTier: tier }) },
      businessProfile: { findFirst: () => Promise.resolve({ sellerCommissionBasisPoints: 0 }) },
      platformFeePolicy: {
        findMany: () =>
          Promise.resolve([
            {
              id: '01POLICY000000000000000000',
              scope: 'GLOBAL',
              scopeKey: 'GLOBAL',
              activeScopeKey: 'GLOBAL',
              versionNumber: 3,
              currency: 'INR',
              feeType: 'PERCENT',
              feeBasis: 'PRODUCT_SUBTOTAL',
              percentRate: new Prisma.Decimal('10.000000'),
              flatFeeMinor: 0n,
              minFeeMinor: null,
              maxFeeMinor: null,
              taxRatePercent: new Prisma.Decimal('15.000000'),
              taxLabel: 'Tax',
              isTaxRuleVerified: false,
              status: 'PUBLISHED',
            },
          ]),
      },
      platformFeeRule: { findMany: () => Promise.resolve(rules) },
      sellerOrderSettlement: { aggregate: () => Promise.resolve({ _sum: { grossProceedsMinor: 0n } }) },
    } as never;
  }

  const goldRow = {
    id: '01RULE0000000000000000GOLD',
    kind: 'SELLER_TIER',
    name: 'Gold sellers',
    scopeKey: 'GLOBAL',
    currency: null,
    minValueMinor: null,
    maxValueMinor: null,
    volumeThresholdMinor: null,
    volumeWindowDays: null,
    sellerTier: 'GOLD',
    percentRate: new Prisma.Decimal('5.000000'),
    discountPercent: null,
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveTo: null,
  };

  it('charges the tier rate, taxes the lower fee, and records which rule applied', async () => {
    const calc = await calculateSettlement(client([goldRow], 'GOLD'), {
      sellerAccountId: '01SELLER000000000000000000',
      currency: 'INR',
      marketCountry: 'IN',
      lines: [
        { categoryId: null, goodsMinor: 600_000n },
        { categoryId: null, goodsMinor: 400_000n },
      ],
      sellerDeliveryMinor: 0n,
      ubossDeliveryMinor: 0n,
      at: AT,
    });
    expect(calc.platformFeeMinor).toBe(50_000n);
    expect(calc.platformFeeTaxMinor).toBe(7_500n);
    expect(calc.lineFeesMinor).toEqual([30_000n, 20_000n]);
    expect(calc.breakdown[0]?.baseFeeMinor).toBe('100000');
    expect(calc.breakdown[0]?.rulesApplied?.[0]).toMatchObject({ ruleId: goldRow.id, kind: 'SELLER_TIER', percent: '5' });
    expect(calc.ruleApplications).toEqual([{ ruleId: goldRow.id, kind: 'SELLER_TIER', effectMinor: 50_000n }]);
  });

  it('charges the policy when the seller is not in the tier', async () => {
    const calc = await calculateSettlement(client([goldRow], null), {
      sellerAccountId: '01SELLER000000000000000000',
      currency: 'INR',
      marketCountry: 'IN',
      lines: [{ categoryId: null, goodsMinor: 1_000_000n }],
      sellerDeliveryMinor: 0n,
      ubossDeliveryMinor: 0n,
      at: AT,
    });
    expect(calc.platformFeeMinor).toBe(100_000n);
    expect(calc.ruleApplications).toEqual([]);
    expect(calc.breakdown[0]?.rulesApplied).toBeUndefined();
  });
});
