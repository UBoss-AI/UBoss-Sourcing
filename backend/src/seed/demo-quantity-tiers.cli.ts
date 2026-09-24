/**
 * Mock quantity bands on every seller listing, for demonstrations.
 *
 *     npm run seed:demo-quantity-tiers              # add
 *     npm run seed:demo-quantity-tiers -- --undo    # take them off again
 *
 * A marketplace fresh from its imports has hundreds of seller listings and
 * almost none with quantity prices, so the product page's bulk-savings card
 * has nothing to offer. This gives each ACTIVE seller offer that has no bands
 * of its own a small ladder - 3% off from 10 pieces, 5% from 50, 8% from 100 -
 * written as the seller's own bands, exactly as Seller Hub would write them,
 * and checked by the same `validateTiers`.
 *
 * It never touches an offer that already has bands: those are a seller's own
 * decision. `--undo` removes a set only when it is still exactly the mock
 * ladder for that offer's current price, so a seller who has since edited
 * their bands keeps them.
 *
 * Refuses NODE_ENV=production. On a live marketplace a seller's prices are the
 * seller's, and nobody else sets them.
 */
import { isProduction } from '../config/env.js';
import { storeDiscountTiers, validateTiers, type QuantityTier } from '../domain/quantity-tier.js';
import { newId } from '../infra/ids.js';
import { prisma } from '../infra/prisma.js';

/** The same shape as a store-wide rule, so the rounding is the same: the discount rounds down. */
const MOCK_LADDER = [
  { id: 'mock-10', minQuantity: 10, discountBasisPoints: 300, isActive: true },
  { id: 'mock-50', minQuantity: 50, discountBasisPoints: 500, isActive: true },
  { id: 'mock-100', minQuantity: 100, discountBasisPoints: 800, isActive: true },
];

function mockBandsFor(listPriceMinor: bigint): QuantityTier[] {
  return storeDiscountTiers(listPriceMinor, MOCK_LADDER).map((tier) => ({ ...tier, id: newId() }));
}

async function add(): Promise<void> {
  const offers = await prisma.sellerOffer.findMany({
    where: { status: 'ACTIVE', priceTiers: { none: {} } },
    select: { id: true, priceMinor: true },
  });
  let written = 0;
  let skipped = 0;
  for (const offer of offers) {
    const bands = mockBandsFor(offer.priceMinor);
    // A price too small for every step to take a whole minor unit off, or a
    // ladder the seller's own editor would refuse, is left alone.
    if (bands.length !== MOCK_LADDER.length || validateTiers(offer.priceMinor, bands).length > 0) {
      skipped += 1;
      continue;
    }
    await prisma.sellerPriceTier.createMany({
      data: bands.map((band) => ({
        id: band.id,
        offerId: offer.id,
        minQuantity: band.minQuantity,
        maxQuantity: null,
        priceMinor: band.priceMinor,
        isActive: true,
      })),
    });
    written += 1;
  }
  console.log(`Mock quantity bands added to ${String(written)} seller listing(s); ${String(skipped)} skipped.`);
}

async function undo(): Promise<void> {
  const offers = await prisma.sellerOffer.findMany({
    where: { priceTiers: { some: {} } },
    select: {
      id: true,
      priceMinor: true,
      priceTiers: { select: { minQuantity: true, maxQuantity: true, priceMinor: true, isActive: true, startsAt: true, endsAt: true, businessBuyersOnly: true, countryCodes: true, preorderOnly: true } },
    },
  });
  let removed = 0;
  for (const offer of offers) {
    const expected = mockBandsFor(offer.priceMinor);
    const actual = [...offer.priceTiers].sort((a, b) => a.minQuantity - b.minQuantity);
    const isMock =
      actual.length === expected.length &&
      actual.every((band, index) => {
        const want = expected[index];
        return (
          want !== undefined &&
          band.minQuantity === want.minQuantity &&
          band.priceMinor === want.priceMinor &&
          band.maxQuantity === null &&
          band.isActive &&
          band.startsAt === null &&
          band.endsAt === null &&
          !band.businessBuyersOnly &&
          band.countryCodes === null &&
          !band.preorderOnly
        );
      });
    if (!isMock) continue;
    await prisma.sellerPriceTier.deleteMany({ where: { offerId: offer.id } });
    removed += 1;
  }
  console.log(`Mock quantity bands removed from ${String(removed)} seller listing(s).`);
}

async function main(): Promise<void> {
  if (isProduction) {
    throw new Error('Mock quantity bands set sellers’ prices and refuse to run with NODE_ENV=production.');
  }
  if (process.argv.includes('--undo')) await undo();
  else await add();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
