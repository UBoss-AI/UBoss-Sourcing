/**
 * The Seller Hub settlement preview resolves its fee policy the way an order
 * does: by the buyer's market and by the category of the goods.
 *
 * The preview used to send neither, so a market or category policy never
 * matched and the preview could quote a fee no real order would charge. The
 * database is a stand-in that records which scope keys were asked for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  askedKeys: [] as string[],
  offers: new Map<string, { sellerAccountId: string; categoryId: string }>(),
}));

vi.mock('../../src/infra/prisma.js', () => ({
  prisma: {
    // What the shared test setup calls before every test.
    $connect: () => Promise.resolve(),
    rateLimitBucket: { deleteMany: () => Promise.resolve({ count: 0 }) },
    sellerAccount: { findUnique: () => Promise.resolve({ commissionBasisPoints: null }) },
    businessProfile: { findFirst: () => Promise.resolve({ sellerCommissionBasisPoints: 0 }) },
    platformFeePolicy: {
      findMany: ({ where }: { where: { activeScopeKey: { in: string[] } } }) => {
        state.askedKeys = where.activeScopeKey.in;
        return Promise.resolve([]);
      },
    },
    sellerOffer: {
      findFirst: ({ where }: { where: { id: string; sellerAccountId: string } }) => {
        const offer = state.offers.get(where.id);
        return Promise.resolve(
          offer !== undefined && offer.sellerAccountId === where.sellerAccountId
            ? { product: { categoryId: offer.categoryId } }
            : null,
        );
      },
    },
  },
}));

vi.mock('../../src/modules/settings/currency.service.js', () => ({
  assertSellableCurrency: (code: string) => Promise.resolve(code),
  getBaseCurrency: () => Promise.resolve('INR'),
}));

const { previewSettlement } = await import('../../src/modules/settings/platform-fee.service.js');

const SELLER = '01SELLER000000000000000000';
const OTHER_SELLER = '01OTHERSELLER0000000000000';

beforeEach(() => {
  state.askedKeys = [];
  state.offers.clear();
  state.offers.set('01OFFER0000000000000000000', { sellerAccountId: SELLER, categoryId: '01CATEGORY0000000000000000' });
  state.offers.set('01OTHEROFFER00000000000000', { sellerAccountId: OTHER_SELLER, categoryId: '01CATEGORY0000000000000000' });
});

describe('the settlement preview', () => {
  it('looks up the market and the listing’s category, as an order would', async () => {
    await previewSettlement({
      sellerAccountId: SELLER,
      goodsMinor: 100_000n,
      sellerDeliveryMinor: 0n,
      currency: 'INR',
      marketCountry: 'de',
      offerId: '01OFFER0000000000000000000',
    });

    expect(state.askedKeys).toEqual([
      `SELLER:${SELLER}`,
      'CATEGORY:01CATEGORY0000000000000000',
      'MARKET:DE',
      'GLOBAL',
    ]);
  });

  it('refuses a listing that belongs to another seller', async () => {
    await expect(
      previewSettlement({
        sellerAccountId: SELLER,
        goodsMinor: 100_000n,
        sellerDeliveryMinor: 0n,
        offerId: '01OTHEROFFER00000000000000',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('asks only for the seller and platform policies when given neither', async () => {
    await previewSettlement({ sellerAccountId: SELLER, goodsMinor: 100_000n, sellerDeliveryMinor: 0n });

    expect(state.askedKeys).toEqual([`SELLER:${SELLER}`, 'GLOBAL']);
  });
});
