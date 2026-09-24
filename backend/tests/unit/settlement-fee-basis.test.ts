/**
 * The fee basis a settlement reports and the fee it charges come from one rule.
 *
 * A seller with a negotiated rate, under a policy whose basis includes the
 * seller's own delivery, used to be reported a basis of goods + delivery and
 * charged on the goods alone. Rates and amounts here are fixtures.
 *
 * `calculateSettlement` is given a stand-in client: it reads the seller, the
 * platform rate and the live policies, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { Prisma } from '../../src/generated/prisma/client.js';
import { calculateSettlement } from '../../src/modules/settings/platform-fee.service.js';

function policy(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: '01POLICY000000000000000000',
    scope: 'GLOBAL',
    scopeKey: 'GLOBAL',
    activeScopeKey: 'GLOBAL',
    versionNumber: 1,
    currency: 'INR',
    feeType: 'PERCENT',
    feeBasis: 'PRODUCT_SUBTOTAL_PLUS_SELLER_DELIVERY',
    percentRate: new Prisma.Decimal('10.000000'),
    flatFeeMinor: 0n,
    minFeeMinor: null,
    maxFeeMinor: null,
    taxRatePercent: new Prisma.Decimal('15.000000'),
    taxLabel: 'Tax',
    isTaxRuleVerified: false,
    status: 'PUBLISHED',
    ...overrides,
  };
}

function client(input: { negotiatedBp: number | null; policies: unknown[] }) {
  return {
    sellerAccount: { findUnique: () => Promise.resolve({ commissionBasisPoints: input.negotiatedBp }) },
    businessProfile: { findFirst: () => Promise.resolve({ sellerCommissionBasisPoints: 0 }) },
    platformFeePolicy: { findMany: () => Promise.resolve(input.policies) },
  } as never;
}

const lines = [
  { categoryId: null, goodsMinor: 600_000n },
  { categoryId: null, goodsMinor: 400_000n },
];

describe('a negotiated rate under a basis that includes delivery', () => {
  it('charges the rate on the same basis it reports', async () => {
    const calc = await calculateSettlement(client({ negotiatedBp: 500, policies: [policy()] }), {
      sellerAccountId: '01SELLER000000000000000000',
      currency: 'INR',
      marketCountry: 'IN',
      lines,
      sellerDeliveryMinor: 100_000n,
      ubossDeliveryMinor: 0n,
    });

    expect(calc.feeBasisMinor).toBe(1_100_000n);
    // 5% of goods and of the seller's own delivery.
    expect(calc.platformFeeMinor).toBe(55_000n);
    expect(calc.lineFeesMinor.reduce((sum, fee) => sum + fee, 0n)).toBe(calc.platformFeeMinor);
    expect(calc.breakdown[0]?.basisMinor).toBe('1100000');
    expect(calc.breakdown[0]?.feeMinor).toBe('55000');
  });

  it('is unchanged on a goods-only basis, rounded per line', async () => {
    const calc = await calculateSettlement(
      client({ negotiatedBp: 333, policies: [policy({ feeBasis: 'PRODUCT_SUBTOTAL' })] }),
      {
        sellerAccountId: '01SELLER000000000000000000',
        currency: 'INR',
        marketCountry: 'IN',
        lines: [
          { categoryId: null, goodsMinor: 1_001n },
          { categoryId: null, goodsMinor: 1_001n },
        ],
        sellerDeliveryMinor: 100_000n,
        ubossDeliveryMinor: 0n,
      },
    );

    expect(calc.feeBasisMinor).toBe(2_002n);
    // 3.33% of 1001 is 33.33 -> 33 per line.
    expect(calc.lineFeesMinor).toEqual([33n, 33n]);
    expect(calc.platformFeeMinor).toBe(66n);
  });
});
