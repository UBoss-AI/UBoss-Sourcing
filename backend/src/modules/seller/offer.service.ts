/**
 * Live offers: the rows a buyer actually buys from.
 *
 * A `SellerOffer` is one seller's terms for one catalogue product. It is what
 * the listings page lists, what the buyer's product page compares, and what an
 * order line points at. It comes into existence only when a moderator approves
 * a draft - see `approveListing` - which is what guarantees nothing reaches a
 * hospital's basket without having been looked at.
 *
 * The commission rate is read here and STORED on the order group rather than
 * recomputed later, and that is the single most important line in this file's
 * neighbourhood: a seller's settlement must not move because somebody edited a
 * rate afterwards.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { syncMarketplacePriceForOffer } from '../catalog/marketplace-price.service.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  assertSellerTrading,
  type SellerMembership,
} from './account.service.js';

export type OfferStatusName = 'INACTIVE' | 'ACTIVE' | 'PAUSED' | 'NEEDS_CHANGES' | 'ARCHIVED';

export interface OfferListQuery {
  status?: OfferStatusName | null;
  search?: string | null;
  categoryId?: string | null;
  brandId?: string | null;
  locationId?: string | null;
  /** `in`, `low` or `out`. The stock chips on the listings page. */
  stockState?: 'in' | 'low' | 'out' | null;
  sort?: 'updated' | 'price_asc' | 'price_desc' | 'stock_asc' | 'quality_asc' | null;
  page?: number;
  pageSize?: number;
}

export interface OfferRow {
  id: string;
  status: OfferStatusName;
  productId: string;
  productName: string;
  productSlug: string;
  imageUrl: string | null;
  sellerSku: string;
  brandName: string | null;
  /** Minor units, as a string. Never a JS number - see the schema header. */
  priceMinor: string;
  currency: string;
  minimumOrderQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  qualityScore: number | null;
  statusReason: string | null;
  updatedAt: string;
  locations: { locationId: string; locationName: string; availableQuantity: number }[];
}

/**
 * The listings table.
 *
 * Server-side paging, one grouped query for the tab counts, and an indexed
 * `where` throughout. A seller with twelve hundred live offers is the normal
 * case rather than the exceptional one, and a page that loads them all to count
 * them is a page that stops working at exactly the point the seller starts
 * mattering.
 */
export async function listOffers(
  membership: SellerMembership,
  query: OfferListQuery,
): Promise<{ rows: OfferRow[]; total: number; counts: Record<string, number> }> {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const search = query.search?.trim() ?? '';

  const where = {
    sellerAccountId: membership.sellerAccountId,
    archivedAt: null,
    ...(query.status === null || query.status === undefined ? {} : { status: query.status }),
    ...(query.brandId === null || query.brandId === undefined ? {} : { brandId: query.brandId }),
    ...(query.categoryId === null || query.categoryId === undefined ? {} : { product: { categoryId: query.categoryId } }),
    ...(query.locationId === null || query.locationId === undefined ? {} : { inventory: { some: { locationId: query.locationId } } }),
    ...(query.stockState === 'out'
      ? { availableQuantity: { lte: 0 } }
      : query.stockState === 'low'
        ? { availableQuantity: { gt: 0, lte: 10 } }
        : query.stockState === 'in'
          ? { availableQuantity: { gt: 0 } }
          : {}),
    ...(search.length === 0
      ? {}
      : {
          OR: [{ sellerSku: { contains: search } }, { product: { name: { contains: search } } }],
        }),
  };

  const orderBy =
    query.sort === 'price_asc'
      ? { priceMinor: 'asc' as const }
      : query.sort === 'price_desc'
        ? { priceMinor: 'desc' as const }
        : query.sort === 'stock_asc'
          ? { availableQuantity: 'asc' as const }
          : query.sort === 'quality_asc'
            ? { qualityScore: 'asc' as const }
            : { updatedAt: 'desc' as const };

  const [rows, total, grouped] = await Promise.all([
    prisma.sellerOffer.findMany({
      where,
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        brand: { select: { name: true } },
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            media: {
              where: { isPrimary: true },
              take: 1,
              select: { media: { select: { url: true } } },
            },
          },
        },
        inventory: {
          select: {
            locationId: true,
            availableQuantity: true,
            location: { select: { name: true } },
          },
        },
      },
    }),
    prisma.sellerOffer.count({ where }),
    prisma.sellerOffer.groupBy({
      by: ['status'],
      where: { sellerAccountId: membership.sellerAccountId, archivedAt: null },
      _count: { _all: true },
    }),
  ]);

  return {
    rows: rows.map((row) => ({
      id: row.id,
      status: row.status,
      productId: row.productId,
      productName: row.product.name,
      productSlug: row.product.slug,
      imageUrl: row.product.media[0]?.media.url ?? null,
      sellerSku: row.sellerSku,
      brandName: row.brand?.name ?? null,
      priceMinor: row.priceMinor.toString(),
      currency: row.currency,
      minimumOrderQuantity: row.minimumOrderQuantity,
      availableQuantity: row.availableQuantity,
      reservedQuantity: row.reservedQuantity,
      qualityScore: row.qualityScore,
      statusReason: row.statusReason,
      updatedAt: row.updatedAt.toISOString(),
      locations: row.inventory.map((entry) => ({
        locationId: entry.locationId,
        locationName: entry.location.name,
        availableQuantity: entry.availableQuantity,
      })),
    })),
    total,
    counts: Object.fromEntries(grouped.map((entry) => [entry.status, entry._count._all])),
  };
}

/**
 * Pause or resume an offer.
 *
 * Resuming is refused while the offer is NEEDS_CHANGES, because that state
 * exists precisely to stop something being sold - an expired certificate, a
 * retired brand - and a resume button that overrode it would make the state
 * decorative.
 */
export async function setOfferStatus(
  membership: SellerMembership,
  offerId: string,
  next: 'ACTIVE' | 'PAUSED' | 'ARCHIVED',
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.OFFER_PUBLISH);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      sellerAccountId: true,
      status: true,
      statusReason: true,
      sellerSku: true,
      availableQuantity: true,
    },
  });

  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');

  if (next === 'ACTIVE') {
    assertSellerTrading(membership);

    if (offer.status === 'NEEDS_CHANGES') {
      throw conflict(
        ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
        offer.statusReason ??
          'This listing needs changes before it can go back on sale.',
      );
    }
  }

  /*
   * The status change and the shelf, together.
   *
   * In one transaction because this is what puts a marketplace product into a
   * category and takes it out again: the storefront's grid is rooted at the
   * price rows, and for a product a seller described those rows are a
   * projection of the live offers. Written separately, a crash between the two
   * leaves a paused offer still on sale in every category - or, worse, a live
   * offer that no category can show and the seller cannot explain.
   */
  await prisma.$transaction(async (tx) => {
    await tx.sellerOffer.update({
      where: { id: offerId },
      data: {
        status: next,
        ...(next === 'ACTIVE' ? { publishedAt: new Date(), statusReason: null } : {}),
        ...(next === 'ARCHIVED' ? { archivedAt: new Date() } : {}),
        version: { increment: 1 },
      },
    });

    await syncMarketplacePriceForOffer(tx, offerId);
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: `seller.offer.${next.toLowerCase()}`,
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_offer',
    resourceId: offerId,
    before: { status: offer.status },
    after: { status: next },
    summary: `${offer.sellerSku} was ${next === 'ACTIVE' ? 'put back on sale' : next === 'PAUSED' ? 'paused' : 'archived'}.`,
    correlationId: correlationId ?? null,
  });
}

export interface PriceUpdate {
  priceMinor: string;
  currency?: string | null;
  compareAtPriceMinor?: string | null;
  minimumOrderQuantity?: number | null;
  orderIncrement?: number | null;
  maximumOrderQuantity?: number | null;
  priceTiers?: { minQuantity: number; priceMinor: string }[] | null;
}

/**
 * Change what an offer costs.
 *
 * Its own permission (`OFFER_PRICE_WRITE`) and its own audit action, because a
 * price change on a live offer is the change most likely to be disputed later:
 * a buyer who added something to a basket at one price and checked out at
 * another will ask, and "the price was changed at 14:02 by this member" has to
 * be answerable.
 */
export async function updateOfferPrice(
  membership: SellerMembership,
  offerId: string,
  update: PriceUpdate,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.OFFER_PRICE_WRITE);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      sellerAccountId: true,
      priceMinor: true,
      currency: true,
      sellerSku: true,
    },
  });

  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');

  if (!/^\d+$/.test(update.priceMinor)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A price must be whole minor units.', [
      { field: 'priceMinor', code: 'NOT_MINOR_UNITS' },
    ]);
  }

  const priceMinor = BigInt(update.priceMinor);

  if (priceMinor <= 0n) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A price has to be above zero.', [
      { field: 'priceMinor', code: 'NOT_POSITIVE' },
    ]);
  }

  const compareAt =
    update.compareAtPriceMinor === null || update.compareAtPriceMinor === undefined || update.compareAtPriceMinor === ''
      ? null
      : BigInt(update.compareAtPriceMinor);

  if (compareAt !== null && compareAt < priceMinor) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The was-price cannot be lower than the price buyers pay.',
      [{ field: 'compareAtPriceMinor', code: 'BELOW_PRICE' }],
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.sellerOffer.update({
      where: { id: offerId },
      data: {
        priceMinor,
        compareAtPriceMinor: compareAt,
        ...(update.currency === null || update.currency === undefined ? {} : { currency: update.currency.toUpperCase() }),
        ...(update.minimumOrderQuantity === null || update.minimumOrderQuantity === undefined
          ? {}
          : { minimumOrderQuantity: update.minimumOrderQuantity }),
        ...(update.orderIncrement === null || update.orderIncrement === undefined ? {} : { orderIncrement: update.orderIncrement }),
        ...(update.maximumOrderQuantity === undefined
          ? {}
          : { maximumOrderQuantity: update.maximumOrderQuantity }),
        version: { increment: 1 },
      },
    });

    if (update.priceTiers !== undefined && update.priceTiers !== null) {
      // Replaced wholesale rather than merged. Bands are a set, and a merge
      // leaves an old band alive that the seller thought they had deleted -
      // which a buyer then gets.
      await tx.sellerPriceTier.deleteMany({ where: { offerId } });

      if (update.priceTiers.length > 0) {
        await tx.sellerPriceTier.createMany({
          data: update.priceTiers.map((tier) => ({
            id: newId(),
            offerId,
            minQuantity: tier.minQuantity,
            priceMinor: BigInt(tier.priceMinor),
          })),
        });
      }
    }

    /*
     * And the shelf, in the same transaction.
     *
     * A marketplace product is found and sorted in the storefront by a price
     * row projected from its live offers. Leaving that behind would show every
     * shopper the old figure in the grid and charge them the new one in the
     * basket - the dispute this codebase is written to avoid.
     */
    await syncMarketplacePriceForOffer(tx, offerId);
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.offer.price_changed',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_offer',
    resourceId: offerId,
    before: { priceMinor: offer.priceMinor.toString(), currency: offer.currency },
    after: { priceMinor: priceMinor.toString(), currency: update.currency ?? offer.currency },
    summary: `The price of ${offer.sellerSku} was changed.`,
    correlationId: correlationId ?? null,
  });
}

/** One offer in full, for the listing detail screen. */
export async function readOffer(membership: SellerMembership, offerId: string) {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    include: {
      brand: { select: { id: true, name: true, status: true } },
      priceTiers: { orderBy: { minQuantity: 'asc' } },
      inventory: { include: { location: { select: { id: true, name: true, code: true } } } },
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          categoryId: true,
          shortDescription: true,
        },
      },
    },
  });

  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');

  return {
    id: offer.id,
    status: offer.status,
    sellerSku: offer.sellerSku,
    priceMinor: offer.priceMinor.toString(),
    compareAtPriceMinor: offer.compareAtPriceMinor?.toString() ?? null,
    currency: offer.currency,
    orderingUnit: offer.orderingUnit,
    minimumOrderQuantity: offer.minimumOrderQuantity,
    orderIncrement: offer.orderIncrement,
    maximumOrderQuantity: offer.maximumOrderQuantity,
    handlingTimeDays: offer.handlingTimeDays,
    guaranteedShelfLifeMonths: offer.guaranteedShelfLifeMonths,
    warrantyMonths: offer.warrantyMonths,
    availableQuantity: offer.availableQuantity,
    reservedQuantity: offer.reservedQuantity,
    qualityScore: offer.qualityScore,
    statusReason: offer.statusReason,
    sellingRegions: Array.isArray(offer.sellingRegionsJson)
      ? (offer.sellingRegionsJson as string[])
      : [],
    brand: offer.brand,
    product: offer.product,
    priceTiers: offer.priceTiers.map((tier) => ({
      minQuantity: tier.minQuantity,
      priceMinor: tier.priceMinor.toString(),
    })),
    inventory: offer.inventory.map((entry) => ({
      locationId: entry.locationId,
      locationName: entry.location.name,
      locationCode: entry.location.code,
      availableQuantity: entry.availableQuantity,
      reservedQuantity: entry.reservedQuantity,
      quarantinedQuantity: entry.quarantinedQuantity,
      reorderThreshold: entry.reorderThreshold,
      batchNumber: entry.batchNumber,
      expiresOn: entry.expiresOn?.toISOString().slice(0, 10) ?? null,
    })),
    version: offer.version,
    updatedAt: offer.updatedAt.toISOString(),
  };
}

/**
 * Duplicate an offer onto another product, or as a starting point for a new
 * one.
 *
 * The SKU is NOT copied - it is unique per seller and a copy would collide -
 * and the stock is not copied either, because stock is a fact about a
 * warehouse rather than a property of the terms. Everything else carries over,
 * which is the whole point: a seller listing the same glove in six sizes should
 * type the shipping regions once.
 */
export async function duplicateOffer(
  membership: SellerMembership,
  offerId: string,
  newSellerSku: string,
  correlationId?: string | null,
): Promise<{ offerId: string }> {
  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);

  const source = await prisma.sellerOffer.findUnique({ where: { id: offerId } });

  if (source === null) throw notFound('Listing');
  assertSellerOwnership(membership, source.sellerAccountId, 'Listing');

  const sku = newSellerSku.trim();

  const clash = await prisma.sellerOffer.findFirst({
    where: { sellerAccountId: membership.sellerAccountId, sellerSku: sku },
    select: { id: true },
  });

  if (clash !== null) {
    throw conflict(ErrorCode.SELLER_SKU_ALREADY_EXISTS, `You already use the code ${sku}.`, [
      { field: 'sellerSku', code: 'DUPLICATE' },
    ]);
  }

  const id = newId();

  await prisma.sellerOffer.create({
    data: {
      id,
      sellerAccountId: membership.sellerAccountId,
      productId: source.productId,
      variantId: source.variantId,
      variantKey: source.variantKey,
      sellerSku: sku,
      brandId: source.brandId,
      // Never ACTIVE. A duplicate has no stock and has not been reviewed in its
      // own right; going live on creation would put an out-of-stock listing in
      // front of a buyer.
      status: 'INACTIVE',
      priceMinor: source.priceMinor,
      currency: source.currency,
      compareAtPriceMinor: source.compareAtPriceMinor,
      taxClassId: source.taxClassId,
      orderingUnit: source.orderingUnit,
      minimumOrderQuantity: source.minimumOrderQuantity,
      orderIncrement: source.orderIncrement,
      maximumOrderQuantity: source.maximumOrderQuantity,
      handlingTimeDays: source.handlingTimeDays,
      guaranteedShelfLifeMonths: source.guaranteedShelfLifeMonths,
      warrantyMonths: source.warrantyMonths,
      sellingRegionsJson: source.sellingRegionsJson ?? undefined,
    },
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.offer.duplicated',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_offer',
    resourceId: id,
    summary: `${source.sellerSku} was duplicated as ${sku}.`,
    correlationId: correlationId ?? null,
  });

  return { offerId: id };
}
