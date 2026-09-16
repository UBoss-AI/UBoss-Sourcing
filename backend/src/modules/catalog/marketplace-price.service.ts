/**
 * What a marketplace product costs, on the operator's own shelf.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A product a seller described is a `Product` row like any other, and the
 * storefront's grid is rooted at `product_prices` - "rooted at the price row
 * for this currency, so the filter and the sort both operate on the amount the
 * shopper is actually shown". A seller never writes a price row; they write an
 * OFFER. So an approved listing, on sale, with stock, appeared in no category,
 * no search result and no facet count: the product existed and the shelf it
 * should have sat on had nothing pointing at it.
 *
 * WHAT THIS IS
 *
 * The price row for a marketplace product is a PROJECTION of its live offers -
 * the cheapest one, per currency. Not a second opinion about what something
 * costs: the offer remains the only price anybody is ever charged (the cart
 * reads `seller_offers.priceMinor` and always has), and this exists so that the
 * catalogue can FIND and SORT the product at the figure the buyer will be
 * shown.
 *
 * Three rules keep the projection from becoming a lie:
 *
 *  1. **It is written in the same transaction as the offer change.** Not on a
 *     schedule, not on a queue. A projection that can lag is a projection that
 *     shows one price in the grid and charges another in the basket, which is
 *     the exact dispute this codebase refuses to design in - see the note on
 *     `quoteSchedule` in CLAUDE.md.
 *
 *  2. **It only ever touches `isMarketplaceProduct` rows.** The operator's own
 *     prices are typed by a person and must never be overwritten by anything
 *     automatic; a bug here that reached them would rewrite the catalogue.
 *
 *  3. **No live offer means no row.** A seller pausing their only offer takes
 *     the product off the shelf, which is what "a marketplace product becomes
 *     visible because a live offer points at it" has always meant. The product
 *     row stays published - it is still a real catalogue entry that another
 *     seller can offer tomorrow.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * Stock is not considered. An offer with nothing in the warehouse stays on the
 * shelf, marked out of stock, the same as the operator's own products - a buyer
 * looking for something needs to find it and then learn it is out of stock, not
 * fail to find it at all.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

/** The base product's own price row. Variants are priced separately. */
const NO_VARIANT_KEY = '';

type Client = PrismaTransaction | typeof prisma;

/**
 * The cheapest live offer per currency, for one product.
 *
 * `groupBy` rather than reading every offer: a popular product may carry
 * dozens, and this runs inside the transaction of a seller pressing "put back
 * on sale". `_min` over the price is the whole question being asked.
 */
async function cheapestLiveOffers(
  client: Client,
  productId: string,
): Promise<{ currency: string; priceMinor: bigint }[]> {
  const groups = await client.sellerOffer.groupBy({
    by: ['currency'],
    where: {
      productId,
      variantKey: NO_VARIANT_KEY,
      status: 'ACTIVE',
      archivedAt: null,
    },
    _min: { priceMinor: true },
  });

  return groups
    .filter((group) => group._min.priceMinor !== null)
    .map((group) => ({ currency: group.currency, priceMinor: group._min.priceMinor as bigint }));
}

/**
 * The strike-through to publish beside a projected price.
 *
 * Read off the offer that actually set the price rather than aggregated: a
 * `MAX(compareAtPriceMinor)` across sellers would advertise one seller's
 * discount against another seller's list price, which is a saving nobody is
 * offering. Null where the cheapest offer has no was-price.
 */
async function compareAtFor(
  client: Client,
  productId: string,
  currency: string,
  priceMinor: bigint,
): Promise<bigint | null> {
  const offer = await client.sellerOffer.findFirst({
    where: {
      productId,
      variantKey: NO_VARIANT_KEY,
      status: 'ACTIVE',
      archivedAt: null,
      currency,
      priceMinor,
    },
    select: { compareAtPriceMinor: true },
  });

  return offer?.compareAtPriceMinor ?? null;
}

/**
 * Bring one marketplace product's price rows into line with its live offers.
 *
 * Pass the caller's `tx` whenever there is one, which is every caller that
 * changes an offer - see rule 1 in the header. A non-marketplace product is a
 * no-op, checked here rather than trusted from the call site so no future
 * caller can point this at the operator's own catalogue.
 */
export async function syncMarketplacePrice(client: Client, productId: string): Promise<void> {
  const product = await client.product.findUnique({
    where: { id: productId },
    select: { id: true, isMarketplaceProduct: true },
  });

  if (product === null || !product.isMarketplaceProduct) return;

  const live = await cheapestLiveOffers(client, productId);
  const currencies = live.map((entry) => entry.currency);

  /*
   * Currencies this deployment does not hold are skipped rather than written.
   *
   * `product_prices.currencyCode` is a foreign key onto `currencies` with
   * ON DELETE RESTRICT, so a row for a currency an operator has never added
   * fails the insert - and a seller pressing "on sale" would get a database
   * error for a decision an operator made months ago. Skipping leaves the offer
   * live and the product off that shelf, which is the truth: there is no shelf.
   */
  const known =
    currencies.length === 0
      ? []
      : (
          await client.currency.findMany({
            where: { code: { in: currencies } },
            select: { code: true },
          })
        ).map((row) => row.code);

  const usable = live.filter((entry) => known.includes(entry.currency));

  // Gone first: a seller who switched currency leaves a row behind on the old
  // one, and a row nothing points at is a product on a shelf nobody stocks.
  await client.productPrice.deleteMany({
    where: {
      productId,
      variantKey: NO_VARIANT_KEY,
      ...(usable.length === 0
        ? {}
        : { currencyCode: { notIn: usable.map((entry) => entry.currency) } }),
    },
  });

  for (const entry of usable) {
    const compareAtPriceMinor = await compareAtFor(
      client,
      productId,
      entry.currency,
      entry.priceMinor,
    );

    await client.productPrice.upsert({
      where: {
        productId_variantKey_currencyCode: {
          productId,
          variantKey: NO_VARIANT_KEY,
          currencyCode: entry.currency,
        },
      },
      create: {
        id: newId(),
        productId,
        variantKey: NO_VARIANT_KEY,
        currencyCode: entry.currency,
        basePriceMinor: entry.priceMinor,
        compareAtPriceMinor,
      },
      update: { basePriceMinor: entry.priceMinor, compareAtPriceMinor },
    });
  }
}

/**
 * The same, for the product an offer belongs to.
 *
 * The convenience the offer services actually want: they hold an offer id and
 * would otherwise each re-read the row to find its product.
 */
export async function syncMarketplacePriceForOffer(
  client: Client,
  offerId: string,
): Promise<void> {
  const offer = await client.sellerOffer.findUnique({
    where: { id: offerId },
    select: { productId: true },
  });

  if (offer === null) return;

  await syncMarketplacePrice(client, offer.productId);
}

/**
 * Rebuild every marketplace product's price rows.
 *
 * The repair path, for two situations: a deployment that carried approved
 * listings from before the projection existed, and anybody who wants to prove
 * the rows still match the offers. Idempotent, so running it twice costs
 * nothing but the reads.
 *
 * Deliberately not run at boot. A catalogue-wide rewrite that happens because
 * somebody restarted the API is a rewrite nobody decided to do; this is a
 * script an operator runs, and `npm run marketplace:sync` is how.
 */
export async function syncAllMarketplacePrices(): Promise<{ products: number }> {
  const products = await prisma.product.findMany({
    where: { isMarketplaceProduct: true },
    select: { id: true },
  });

  for (const product of products) {
    try {
      await prisma.$transaction((tx) => syncMarketplacePrice(tx, product.id));
    } catch (error) {
      // One product that cannot be rebuilt must not abandon the rest: a repair
      // pass that stops at the first bad row leaves the catalogue half fixed
      // and the operator with no idea how far it got.
      logger.error({ err: error, productId: product.id }, 'marketplace price sync failed');
    }
  }

  return { products: products.length };
}

/**
 * The offer a marketplace product is bought from, when the buyer did not pick
 * one.
 *
 * The other half of the projection, and it has to agree with it: the grid shows
 * the cheapest live offer's price, so adding that product to a basket has to
 * attach THAT offer. Resolved on the server rather than sent by the browser -
 * every existing way into the basket (a product card, a reorder, AI Mode, a
 * schedule) then works without knowing marketplaces exist, and no client can
 * name an offer to be charged at.
 *
 * Currency first, then price. A buyer shopping in rupees must not be bound to a
 * euro offer because it sorted cheaper on a number that means something else.
 */
export async function cheapestOfferFor(
  client: Client,
  productId: string,
  variantKey: string,
  currency: string | null,
): Promise<{ id: string } | null> {
  const where: Prisma.SellerOfferWhereInput = {
    productId,
    variantKey,
    status: 'ACTIVE',
    archivedAt: null,
    ...(currency === null ? {} : { currency }),
  };

  return client.sellerOffer.findFirst({
    where,
    orderBy: [{ priceMinor: 'asc' }, { createdAt: 'asc' }],
    select: { id: true },
  });
}
