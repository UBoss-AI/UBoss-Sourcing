/**
 * Editing a listing that already exists.
 *
 * `listing-draft.service.ts` is how a listing comes into being; this is how it
 * is changed afterwards, which until now it largely could not be. A seller
 * could pause a listing, change its price, and add versions to it - and that
 * was the whole of it. Everything else they had typed into the wizard was
 * frozen the moment a moderator approved it: the minimum order, the lead time,
 * the countries they ship to, the price of an individual size, the stock
 * against one colour. "Edit" opened a screen that could add sizes and nothing
 * more, which is not what the word means.
 *
 * ---
 *
 * TWO KINDS OF CHANGE, AND ONLY ONE OF THEM NEEDS THE LISTING OFF SALE
 *
 * This distinction is the reason the file is shaped the way it is.
 *
 * A **routine** change is one a buyer looking at the page can absorb: a new
 * price, a different minimum order, ten more in the warehouse. Stock in
 * particular changes many times a day, and a system that demanded a listing be
 * taken off sale to correct a count would be a system whose counts are wrong,
 * because nobody would use it.
 *
 * A **structural** change rearranges what the buyer is choosing between: an
 * axis added or removed, a combination added or withdrawn, the product moved
 * to another category. Doing that underneath somebody who has the page open
 * means they pick a size that stops existing between the click and the basket.
 * So those are refused while the listing is ACTIVE, and `pauseForEdit` is the
 * door: it takes the listing off sale, records who did it and when, and leaves
 * every order, every variant and every stock figure exactly where they were.
 *
 * NOTHING IS DELETED, EVER
 *
 * A seller who stops stocking Brown in size 9 has not un-sold the four of them
 * they shipped last month. Withdrawing a combination deactivates its offer and
 * archives its variant; it never removes a row an order line points at. That
 * is not politeness about history - `order_items` is ON DELETE RESTRICT, and a
 * hard delete would simply fail - it is that an archived variant still renders
 * correctly on the order the buyer is looking at, and a missing one does not.
 *
 * IDS SURVIVE
 *
 * Combinations are matched by `optionSignature`, never by position and never
 * by SKU. A seller adding size 10 to a run of 7-9 keeps three variant ids,
 * three offer ids, three piles of stock and three sets of order history, and
 * gains one row. Regenerating the matrix and writing it over the top would
 * lose all of that while looking, from the outside, like it had worked.
 */
import { createHash } from 'node:crypto';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { findTemplate } from '../../domain/variants/registry.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  assertWithinSizeLimit,
  readImageDimensions,
  sniffImageType,
  storage,
} from '../../infra/storage/index.js';
import { syncMarketplacePrice } from '../catalog/marketplace-price.service.js';
import { categorySlugPath } from '../catalog/variant-matrix.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  assertSellerTrading,
  type SellerMembership,
} from './account.service.js';
import { recordSellerAudit } from './audit.service.js';
import { refreshOfferTotals } from './inventory.service.js';
import {
  normaliseAxes,
  normaliseRows,
  variantNameOf,
  type DraftVariantAxis,
  type DraftVariantRow,
} from './listing-variants.js';

/** Pieces, stated rather than left to the column default. See the offer service. */
const SELLER_SELLING_UNIT = 'PIECE' as const;

/**
 * How a save ends: off sale, or back on it.
 *
 * Two buttons rather than one, because "save" and "publish" are different
 * decisions and a seller halfway through re-pricing forty rows must be able to
 * put the work down without putting it in front of buyers.
 */
export type EditFinish = 'PAUSED' | 'ACTIVE';

// ---------------------------------------------------------------------------
// Reading, for a form that has to arrive filled in
// ---------------------------------------------------------------------------

/** The commercial terms of one listing, as the form holds them. */
export interface ListingTermsPatch {
  priceMinor?: string | null;
  compareAtPriceMinor?: string | null;
  minimumOrderQuantity?: number | null;
  orderIncrement?: number | null;
  maximumOrderQuantity?: number | null;
  handlingTimeDays?: number | null;
  guaranteedShelfLifeMonths?: number | null;
  warrantyMonths?: number | null;
  sellingRegions?: string[] | null;
  taxClassId?: string | null;
  priceTiers?: { minQuantity: number; priceMinor: string }[] | null;
}

/**
 * One combination as the editor holds it: what it is, what it costs, and what
 * cannot be done to it.
 *
 * `offerId` and `variantId` are echoed back on save. They are how the server
 * recognises a row it already has - the signature does the matching, but the
 * ids are what the audit trail names, and a row that arrives claiming an id
 * belonging to another seller is refused rather than believed.
 */
export interface ListingEditVariantRow {
  offerId: string;
  variantId: string | null;
  optionSignature: string;
  options: Record<string, string>;
  name: string;
  sku: string;
  barcode: string | null;
  status: string;
  isActive: boolean;
  isBaseListing: boolean;
  priceMinor: string;
  compareAtPriceMinor: string | null;
  minOrderQty: number;
  qtyIncrement: number;
  maxOrderQty: number | null;
  leadTimeDays: number | null;
  shippingWeightGrams: number | null;
  shippingLengthMm: number | null;
  shippingWidthMm: number | null;
  shippingHeightMm: number | null;
  imageMediaId: string | null;
  availableQuantity: number;
  reservedQuantity: number;
  stock: { locationId: string; availableQuantity: number }[];
  /**
   * Whether somebody has bought this.
   *
   * Decides what "remove" can mean. A combination nobody has ordered can be
   * switched off and forgotten; one that appears on an order is archived and
   * kept, because the order detail page still has to be able to say what was
   * in the box.
   */
  isOrderLinked: boolean;
}

function toMinor(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

/**
 * Everything the edit form needs, in one request.
 *
 * One round trip rather than six, because the form cannot render a single
 * field until it has all of it - a half-filled form that fills in as queries
 * land is a form a seller starts typing into and then has their typing
 * overwritten.
 */
export async function readListingForEdit(membership: SellerMembership, offerId: string) {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      sellerAccountId: true,
      status: true,
      statusReason: true,
      pausedAt: true,
      pausedByProfileId: true,
      sellerSku: true,
      currency: true,
      priceMinor: true,
      compareAtPriceMinor: true,
      orderingUnit: true,
      minimumOrderQuantity: true,
      orderIncrement: true,
      maximumOrderQuantity: true,
      handlingTimeDays: true,
      guaranteedShelfLifeMonths: true,
      warrantyMonths: true,
      sellingRegionsJson: true,
      taxClassId: true,
      version: true,
      productId: true,
      variantKey: true,
      updatedAt: true,
      brand: { select: { id: true, name: true, status: true } },
      priceTiers: { orderBy: { minQuantity: 'asc' }, select: { minQuantity: true, priceMinor: true } },
      product: {
        select: {
          id: true,
          name: true,
          slug: true,
          categoryId: true,
          shortDescription: true,
          description: true,
          gtin: true,
          modelIdentifier: true,
          weightGrams: true,
          hasVariants: true,
          variantAxesJson: true,
          category: { select: { id: true, name: true, slug: true } },
          attributes: {
            orderBy: { sortOrder: 'asc' },
            select: { name: true, value: true, sortOrder: true },
          },
          isMarketplaceProduct: true,
          createdBySellerAccountId: true,
          media: {
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            select: {
              mediaId: true,
              isPrimary: true,
              sortOrder: true,
              media: { select: { id: true, storageKey: true, url: true, altText: true } },
            },
          },
          /*
           * The packing description for the base product only.
           *
           * `variantKey` is '' for the family and the variant ULID for one
           * particular size; reading them all would hand the form forty rows
           * where it draws one panel. Packing that differs per size is edited
           * on the row that owns it, in the matrix.
           */
          packagings: {
            where: { variantKey: '' },
            take: 1,
            select: {
              packingType: true,
              packingRawText: true,
              innerPackType: true,
              outerPackType: true,
              piecesPerInnerPack: true,
              innerPacksPerOuterCarton: true,
              piecesPerOuterCarton: true,
            },
          },
        },
      },
    },
  });

  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');

  const categorySlugs = await categorySlugPath(offer.product.categoryId);
  const template = findTemplate(categorySlugs);

  /*
   * Every version of this product THIS seller offers - the same scoping
   * `readOfferVariants` uses, and for the same reason. Three distributors
   * share one product page and each stocks a different half of the size run;
   * showing one of them the others' rows would have them pricing stock they
   * do not hold.
   */
  const siblings = await prisma.sellerOffer.findMany({
    where: {
      sellerAccountId: membership.sellerAccountId,
      productId: offer.productId,
      archivedAt: null,
    },
    select: {
      id: true,
      sellerSku: true,
      status: true,
      priceMinor: true,
      compareAtPriceMinor: true,
      minimumOrderQuantity: true,
      orderIncrement: true,
      maximumOrderQuantity: true,
      availableQuantity: true,
      reservedQuantity: true,
      variantKey: true,
      variant: {
        select: {
          id: true,
          name: true,
          sku: true,
          gtin: true,
          optionsJson: true,
          optionSignature: true,
          isActive: true,
          archivedAt: true,
          leadTimeDays: true,
          shippingWeightGrams: true,
          shippingLengthMm: true,
          shippingWidthMm: true,
          shippingHeightMm: true,
          media: {
            take: 1,
            orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
            select: { mediaId: true },
          },
        },
      },
      inventory: { select: { locationId: true, availableQuantity: true } },
      _count: { select: { orderItems: true, orderLines: true } },
    },
    orderBy: { sellerSku: 'asc' },
  });

  const pausedBy =
    offer.pausedByProfileId === null
      ? null
      : await prisma.sellerMember.findFirst({
          where: {
            sellerAccountId: membership.sellerAccountId,
            customerProfileId: offer.pausedByProfileId,
          },
          select: { customerProfile: { select: { fullName: true } } },
        });

  const rows: ListingEditVariantRow[] = siblings.map((row) => ({
    offerId: row.id,
    variantId: row.variant?.id ?? null,
    optionSignature: row.variant?.optionSignature ?? '',
    options: (row.variant?.optionsJson ?? {}) as Record<string, string>,
    name: row.variant?.name ?? '',
    sku: row.sellerSku,
    barcode: row.variant?.gtin ?? null,
    status: row.status,
    /*
     * "Do you sell this", NOT "is it on sale this minute".
     *
     * The two are different questions and conflating them is the bug this
     * comment exists to prevent: a PAUSED listing has every one of its
     * versions off sale, and reading that as "the seller does not offer any of
     * these" would mean a paused listing could never be resumed - every row
     * would arrive unticked and the resume check would refuse it for having
     * nothing switched on. INACTIVE is the seller's own "we do not offer this
     * combination"; ARCHIVED is one they withdrew.
     */
    isActive: row.status !== 'INACTIVE' && row.status !== 'ARCHIVED',
    isBaseListing: row.variantKey === '',
    priceMinor: row.priceMinor.toString(),
    compareAtPriceMinor: toMinor(row.compareAtPriceMinor),
    minOrderQty: row.minimumOrderQuantity,
    qtyIncrement: row.orderIncrement,
    maxOrderQty: row.maximumOrderQuantity,
    leadTimeDays: row.variant?.leadTimeDays ?? null,
    shippingWeightGrams: row.variant?.shippingWeightGrams ?? null,
    shippingLengthMm: row.variant?.shippingLengthMm ?? null,
    shippingWidthMm: row.variant?.shippingWidthMm ?? null,
    shippingHeightMm: row.variant?.shippingHeightMm ?? null,
    imageMediaId: row.variant?.media[0]?.mediaId ?? null,
    availableQuantity: row.availableQuantity,
    reservedQuantity: row.reservedQuantity,
    stock: row.inventory.map((entry) => ({
      locationId: entry.locationId,
      availableQuantity: entry.availableQuantity,
    })),
    isOrderLinked: row._count.orderItems > 0 || row._count.orderLines > 0,
  }));

  const isStructuralEditAllowed = offer.status !== 'ACTIVE';

  return {
    offerId: offer.id,
    version: offer.version,
    status: offer.status,
    statusReason: offer.statusReason,
    sellerSku: offer.sellerSku,
    currency: offer.currency,
    updatedAt: offer.updatedAt.toISOString(),
    pausedAt: offer.pausedAt?.toISOString() ?? null,
    pausedBy: pausedBy?.customerProfile.fullName ?? null,

    /**
     * Whether the structure can be changed right now, and why not.
     *
     * Returned rather than left for the form to deduce from the status, so
     * that the one sentence the seller reads and the one rule the server
     * enforces are written down in one place.
     */
    isStructuralEditAllowed,
    structuralBlockedReason: isStructuralEditAllowed
      ? null
      : 'This listing is on sale. Pause it before changing its options or combinations — buyers may have it open right now.',

    terms: {
      priceMinor: offer.priceMinor.toString(),
      compareAtPriceMinor: toMinor(offer.compareAtPriceMinor),
      orderingUnit: offer.orderingUnit,
      minimumOrderQuantity: offer.minimumOrderQuantity,
      orderIncrement: offer.orderIncrement,
      maximumOrderQuantity: offer.maximumOrderQuantity,
      handlingTimeDays: offer.handlingTimeDays,
      guaranteedShelfLifeMonths: offer.guaranteedShelfLifeMonths,
      warrantyMonths: offer.warrantyMonths,
      taxClassId: offer.taxClassId,
      sellingRegions: Array.isArray(offer.sellingRegionsJson)
        ? (offer.sellingRegionsJson as string[])
        : [],
      priceTiers: offer.priceTiers.map((tier) => ({
        minQuantity: tier.minQuantity,
        priceMinor: tier.priceMinor.toString(),
      })),
    },

    brand: offer.brand,

    product: {
      id: offer.product.id,
      name: offer.product.name,
      slug: offer.product.slug,
      categoryId: offer.product.categoryId,
      categoryName: offer.product.category.name,
      shortDescription: offer.product.shortDescription,
      description: offer.product.description,
      gtin: offer.product.gtin,
      modelIdentifier: offer.product.modelIdentifier,
      weightGrams: offer.product.weightGrams,
      hasVariants: offer.product.hasVariants,
      axes: Array.isArray(offer.product.variantAxesJson)
        ? (offer.product.variantAxesJson as string[])
        : [],
      specifications: offer.product.attributes.map((entry) => ({
        name: entry.name,
        value: entry.value,
      })),
      images: offer.product.media.map((entry) => ({
        mediaId: entry.mediaId,
        storageKey: entry.media.storageKey,
        url: entry.media.url,
        altText: entry.media.altText,
        isPrimary: entry.isPrimary,
      })),

      /**
       * Whether this seller may add or remove the photographs.
       *
       * Yes for the seller who described the product, no for one who matched
       * their stock to a page somebody else wrote - see `mayEditPhotos`.
       * Returned so the screen can say why rather than offer a button that
       * fails.
       */
      canEditPhotos:
        offer.product.isMarketplaceProduct &&
        offer.product.createdBySellerAccountId === membership.sellerAccountId,
      packaging: offer.product.packagings[0] ?? null,
    },

    template:
      template === null
        ? null
        : {
            categorySlug: template.categorySlug,
            subcategorySlug: template.subcategorySlug,
            label: template.label,
            axes: [...template.axes],
          },

    variants: rows,
  };
}

export type ListingEditView = Awaited<ReturnType<typeof readListingForEdit>>;

// ---------------------------------------------------------------------------
// Taking it off sale in order to change it
// ---------------------------------------------------------------------------

/**
 * Pause a live listing so that its structure can be edited.
 *
 * Distinct from `setOfferStatus(..., 'PAUSED')` in what it records, not in
 * what it does to the listing: the same status, the same effect on buyers,
 * and a trail that says a person took it off sale in order to work on it. A
 * colleague finding it paused on Monday is then told that rather than left to
 * guess at a compliance hold.
 *
 * Idempotent. Pressing "Pause & Edit" on something already paused returns
 * quietly, because the seller's intent - "let me edit this" - is already true.
 */
export async function pauseForEdit(
  membership: SellerMembership,
  offerId: string,
  correlationId?: string | null,
): Promise<{ status: string; version: number }> {
  assertSellerPermission(membership, SellerPermission.OFFER_PUBLISH);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { id: true, sellerAccountId: true, status: true, sellerSku: true, version: true },
  });

  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');

  if (offer.status === 'ARCHIVED') {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      'This listing has been withdrawn. Copy it to start a new one.',
    );
  }

  if (offer.status !== 'ACTIVE') {
    return { status: offer.status, version: offer.version };
  }

  const updated = await prisma.$transaction(async (tx) => {
    const next = await tx.sellerOffer.update({
      where: { id: offerId },
      data: {
        status: 'PAUSED',
        pausedAt: new Date(),
        pausedByProfileId: membership.customerProfileId,
        statusReason: 'Paused to be edited.',
        version: { increment: 1 },
      },
      select: { status: true, version: true, productId: true },
    });

    // The shelf, in the same transaction as the status. A paused offer still
    // listed at its old price is a category page offering something that
    // cannot be bought - see `setOfferStatus` for the longer version.
    await syncMarketplacePrice(tx, next.productId);

    return next;
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.offer.paused_for_edit',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_offer',
    resourceId: offerId,
    before: { status: offer.status },
    after: { status: 'PAUSED', pausedBy: membership.displayName },
    summary: `${offer.sellerSku} was paused so it could be edited.`,
    correlationId: correlationId ?? null,
  });

  return { status: updated.status, version: updated.version };
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

/**
 * One combination as it arrives from the form.
 *
 * `offerId` identifies a row that already exists; absent or empty means a new
 * one. `isActive` is the seller's answer to "do you sell this" - which is not
 * the same question as "have you got any", and conflating the two is how a
 * shoe that is simply sold out disappears from the size picker altogether.
 */
export interface ListingEditRowInput extends DraftVariantRow {
  offerId?: string | null;
}

export interface SaveListingEditInput {
  membership: SellerMembership;
  offerId: string;
  /** The version the form was built from. A stale one is refused, never merged. */
  expectedVersion: number;
  terms?: ListingTermsPatch | null;
  /** The axes the listing sells along. Omitted leaves them as they are. */
  axes?: DraftVariantAxis[] | null;
  /** Every combination the seller means to offer. Omitted leaves them alone. */
  rows?: ListingEditRowInput[] | null;
  /** Off sale, or back on it. */
  finish: EditFinish;
  correlationId?: string | null;
}

export interface SaveListingEditResult {
  created: number;
  updated: number;
  withdrawn: number;
  archived: number;
  status: string;
  version: number;
}

/**
 * Apply the seller's edit.
 *
 * One transaction covering the terms, the combinations, their stock and the
 * category shelf, because half of this applied is a listing whose price says
 * one thing and whose sizes say another, on sale, with nobody aware.
 */
export async function saveListingEdit(
  input: SaveListingEditInput,
): Promise<SaveListingEditResult> {
  const { membership, offerId } = input;

  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);

  const current = await readListingForEdit(membership, offerId);

  if (current.status === 'ARCHIVED') {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      'This listing has been withdrawn and cannot be edited.',
    );
  }

  if (current.version !== input.expectedVersion) {
    throw conflict(
      ErrorCode.SELLER_STALE_VERSION,
      'This listing changed since you opened it. Reload to see the newer version before saving.',
    );
  }

  const template =
    current.template === null
      ? null
      : findTemplate([current.template.subcategorySlug ?? '', current.template.categorySlug]);

  const { axes } = normaliseAxes(template, input.axes ?? []);
  const { rows, duplicateSignatures } = normaliseRows(input.rows ?? []);

  if (duplicateSignatures.length > 0) {
    throw conflict(
      ErrorCode.VARIANT_COMBINATION_EXISTS,
      'Two of those versions describe the same combination. Each combination can appear once.',
    );
  }

  const byId = new Map(current.variants.map((row) => [row.offerId, row]));
  const bySignature = new Map(
    current.variants.filter((row) => row.optionSignature !== '').map((row) => [row.optionSignature, row]),
  );

  /*
   * Which of the rows that arrived is which.
   *
   * Matched by signature FIRST and by id second. The signature is the identity
   * of the combination - "Black in 8" is Black in 8 whichever row of the form
   * it was typed into - and an id is only a way of naming a row the seller
   * started from. A row carrying an id whose signature now matches a different
   * existing row is treated as that row, which is what happens when somebody
   * corrects a typo in an option value.
   */
  const seenExisting = new Set<string>();
  const creates: DraftVariantRow[] = [];
  const updates: { row: DraftVariantRow; existing: ListingEditVariantRow }[] = [];

  for (const row of rows) {
    const existing =
      bySignature.get(row.optionSignature) ??
      ((input.rows ?? []).find((entry) => entry.optionSignature === row.optionSignature)?.offerId
        ? byId.get(
            (input.rows ?? []).find((entry) => entry.optionSignature === row.optionSignature)
              ?.offerId ?? '',
          )
        : undefined);

    if (existing === undefined) {
      creates.push(row);
      continue;
    }

    seenExisting.add(existing.offerId);
    updates.push({ row, existing });
  }

  /*
   * Combinations the seller no longer offers.
   *
   * The base listing - the "no particular version" row a product had before it
   * had versions - is never in this set. It is what the seller's existing
   * orders point at, and withdrawing it silently because it carries no options
   * would take a product off sale in the middle of an edit about sizes.
   */
  const withdrawals =
    input.rows === null || input.rows === undefined
      ? []
      : current.variants.filter(
          (row) => !row.isBaseListing && !seenExisting.has(row.offerId) && row.status !== 'ARCHIVED',
        );

  const isStructural =
    creates.length > 0 ||
    withdrawals.length > 0 ||
    (input.axes !== null &&
      input.axes !== undefined &&
      axes.map((axis) => axis.axisKey).join('|') !== current.product.axes.join('|'));

  if (isStructural && !current.isStructuralEditAllowed) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      current.structuralBlockedReason ?? 'Pause this listing before changing its structure.',
    );
  }

  assertRowsAreSane(rows);
  await assertSkusAreFree(membership.sellerAccountId, current.product.id, rows);

  if (input.finish === 'ACTIVE') {
    assertSellerTrading(membership);
    assertReadyToResume(current, { rows, updates, creates, withdrawals });
  }

  const nextStatus: 'ACTIVE' | 'PAUSED' = input.finish === 'ACTIVE' ? 'ACTIVE' : 'PAUSED';

  let archived = 0;

  const result = await prisma.$transaction(async (tx) => {
    // --- Combinations that already exist ---------------------------------
    for (const { row, existing } of updates) {
      await updateExistingRow(tx, membership, row, existing, nextStatus);
    }

    // --- Combinations being added ----------------------------------------
    for (const [position, row] of creates.entries()) {
      await createRow(tx, membership, current, row, current.variants.length + position);
    }

    // --- Combinations being withdrawn ------------------------------------
    for (const row of withdrawals) {
      archived += await withdrawRow(tx, row);
    }

    /*
     * --- The listing's own terms -----------------------------------------
     *
     * LAST, and the ordering is the rule rather than an accident.
     *
     * The listing named in the URL is sometimes one of the combinations above
     * - a seller who arrived from "Black / 8" is editing that row - so its
     * price can be stated twice in one payload: once in the matrix and once
     * here. One of them has to win, and it is this one, because `terms` names
     * this listing specifically while the matrix row is a line in a table of
     * many. The editor avoids sending both, but a seller's own integration
     * posting to this endpoint gets a defined answer rather than whichever
     * write happened to run second.
     */
    if (input.terms !== null && input.terms !== undefined) {
      await applyTerms(tx, current, input.terms);
    }

    // --- The product's own shape -----------------------------------------
    const activeAxisKeys = axes.map((axis) => axis.axisKey);

    if (input.axes !== null && input.axes !== undefined) {
      await tx.product.update({
        where: { id: current.product.id },
        data: {
          hasVariants: activeAxisKeys.length > 0,
          variantAxesJson: activeAxisKeys as never,
        },
      });
    } else if (creates.length > 0) {
      await tx.product.update({
        where: { id: current.product.id },
        data: { hasVariants: true },
      });
    }

    // --- The listing's own status ----------------------------------------
    const offer = await tx.sellerOffer.update({
      where: { id: offerId },
      data: {
        status: nextStatus,
        ...(nextStatus === 'ACTIVE'
          ? { publishedAt: new Date(), statusReason: null, pausedAt: null, pausedByProfileId: null }
          : {}),
        version: { increment: 1 },
      },
      select: { status: true, version: true },
    });

    await syncMarketplacePrice(tx, current.product.id);

    return offer;
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.offer.edited',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_offer',
    resourceId: offerId,
    before: {
      status: current.status,
      priceMinor: current.terms.priceMinor,
      versions: current.variants.length,
    },
    after: {
      status: result.status,
      priceMinor: input.terms?.priceMinor ?? current.terms.priceMinor,
      created: creates.map((row) => row.sku),
      withdrawn: withdrawals.map((row) => row.sku),
      updated: updates.map((entry) => entry.existing.sku),
    },
    summary:
      `${current.sellerSku} was edited` +
      (creates.length > 0 ? `, ${creates.length} versions added` : '') +
      (withdrawals.length > 0 ? `, ${withdrawals.length} withdrawn` : '') +
      (result.status === 'ACTIVE' ? ' and put back on sale.' : ' and left off sale.'),
    correlationId: input.correlationId ?? null,
  });

  return {
    created: creates.length,
    updated: updates.length,
    withdrawn: withdrawals.length,
    archived,
    status: result.status,
    version: result.version,
  };
}

// ---------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------

async function applyTerms(
  tx: PrismaTransaction,
  current: ListingEditView,
  terms: ListingTermsPatch,
): Promise<void> {
  const priceMinor =
    terms.priceMinor === null || terms.priceMinor === undefined
      ? BigInt(current.terms.priceMinor)
      : BigInt(terms.priceMinor);

  const compareAt =
    terms.compareAtPriceMinor === undefined
      ? current.terms.compareAtPriceMinor === null
        ? null
        : BigInt(current.terms.compareAtPriceMinor)
      : terms.compareAtPriceMinor === null
        ? null
        : BigInt(terms.compareAtPriceMinor);

  if (compareAt !== null && compareAt < priceMinor) {
    // Not a discount - a claim that the buyer is paying above the usual price.
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The recommended price cannot be lower than what you are charging.',
      [{ field: 'compareAtPriceMinor', code: 'BELOW_PRICE' }],
    );
  }

  await tx.sellerOffer.update({
    where: { id: current.offerId },
    data: {
      priceMinor,
      compareAtPriceMinor: compareAt,
      ...(terms.minimumOrderQuantity === null || terms.minimumOrderQuantity === undefined
        ? {}
        : { minimumOrderQuantity: terms.minimumOrderQuantity }),
      ...(terms.orderIncrement === null || terms.orderIncrement === undefined
        ? {}
        : { orderIncrement: terms.orderIncrement }),
      ...(terms.maximumOrderQuantity === undefined
        ? {}
        : { maximumOrderQuantity: terms.maximumOrderQuantity }),
      ...(terms.handlingTimeDays === undefined ? {} : { handlingTimeDays: terms.handlingTimeDays }),
      ...(terms.guaranteedShelfLifeMonths === undefined
        ? {}
        : { guaranteedShelfLifeMonths: terms.guaranteedShelfLifeMonths }),
      ...(terms.warrantyMonths === undefined ? {} : { warrantyMonths: terms.warrantyMonths }),
      ...(terms.taxClassId === undefined ? {} : { taxClassId: terms.taxClassId }),
      ...(terms.sellingRegions === undefined || terms.sellingRegions === null
        ? {}
        : { sellingRegionsJson: terms.sellingRegions as never }),
    },
  });

  if (terms.priceTiers !== undefined && terms.priceTiers !== null) {
    // Replaced wholesale rather than merged: a band the seller deleted has to
    // disappear, and there is no stable identity to merge against - a band IS
    // its starting quantity.
    await tx.sellerPriceTier.deleteMany({ where: { offerId: current.offerId } });

    for (const tier of terms.priceTiers) {
      await tx.sellerPriceTier.create({
        data: {
          id: newId(),
          offerId: current.offerId,
          minQuantity: tier.minQuantity,
          priceMinor: BigInt(tier.priceMinor),
        },
      });
    }
  }
}

/**
 * Update one combination the seller already sells.
 *
 * The variant's id, its order history and its stock are untouched. What
 * changes is what the seller typed: the code, the price, the terms, the
 * shipping figures, and whether they still offer it at all.
 */
async function updateExistingRow(
  tx: PrismaTransaction,
  membership: SellerMembership,
  row: DraftVariantRow,
  existing: ListingEditVariantRow,
  /** Where the whole listing is landing: on sale, or off it. */
  listingStatus: 'ACTIVE' | 'PAUSED',
): Promise<void> {
  const priceMinor = row.priceMinor === null || row.priceMinor === undefined
    ? BigInt(existing.priceMinor)
    : BigInt(row.priceMinor);

  const compareAt =
    row.compareAtPriceMinor === undefined
      ? existing.compareAtPriceMinor === null
        ? null
        : BigInt(existing.compareAtPriceMinor)
      : row.compareAtPriceMinor === null
        ? null
        : BigInt(row.compareAtPriceMinor);

  if (compareAt !== null && compareAt < priceMinor) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `${row.name || existing.sku}: the recommended price cannot be lower than what you are charging.`,
      [{ field: 'compareAtPriceMinor', code: 'BELOW_PRICE' }],
    );
  }

  if (existing.variantId !== null) {
    await tx.productVariant.update({
      where: { id: existing.variantId },
      data: {
        name: variantNameOf(row),
        sku: row.sku === '' ? existing.sku : row.sku,
        optionsJson: row.options as never,
        optionSignature: row.optionSignature,
        priceMinor,
        compareAtPriceMinor: compareAt,
        ...(row.barcode === undefined ? {} : { gtin: row.barcode === '' ? null : row.barcode }),
        ...(row.minOrderQty === undefined ? {} : { minOrderQty: row.minOrderQty }),
        ...(row.qtyIncrement === undefined ? {} : { qtyIncrement: row.qtyIncrement }),
        ...(row.maxOrderQty === undefined ? {} : { maxOrderQty: row.maxOrderQty }),
        ...(row.leadTimeDays === undefined ? {} : { leadTimeDays: row.leadTimeDays }),
        ...(row.shippingWeightGrams === undefined
          ? {}
          : { shippingWeightGrams: row.shippingWeightGrams }),
        ...(row.shippingLengthMm === undefined ? {} : { shippingLengthMm: row.shippingLengthMm }),
        ...(row.shippingWidthMm === undefined ? {} : { shippingWidthMm: row.shippingWidthMm }),
        ...(row.shippingHeightMm === undefined ? {} : { shippingHeightMm: row.shippingHeightMm }),
        // "Not offered" deactivates the variant; it never archives it here.
        // Archiving is what `withdrawRow` does, and the difference matters:
        // this one can be switched back on with a tick.
        isActive: row.isActive,
      },
    });

    if (row.mediaId !== undefined && row.mediaId !== null && row.mediaId !== '') {
      await tx.productVariantMedia.deleteMany({ where: { variantId: existing.variantId } });
      await tx.productVariantMedia.create({
        data: {
          id: newId(),
          variantId: existing.variantId,
          mediaId: row.mediaId,
          isPrimary: true,
          sortOrder: 0,
        },
      });
    }
  }

  await tx.sellerOffer.update({
    where: { id: existing.offerId },
    data: {
      sellerSku: row.sku === '' ? existing.sku : row.sku,
      priceMinor,
      compareAtPriceMinor: compareAt,
      ...(row.minOrderQty === null || row.minOrderQty === undefined
        ? {}
        : { minimumOrderQuantity: row.minOrderQty }),
      ...(row.qtyIncrement === null || row.qtyIncrement === undefined
        ? {}
        : { orderIncrement: row.qtyIncrement }),
      ...(row.maxOrderQty === undefined ? {} : { maximumOrderQuantity: row.maxOrderQty }),
      /*
       * Where this row lands.
       *
       * Unticked is INACTIVE - "we do not offer this combination" - which is
       * reversible with the same tick and is deliberately NOT the same
       * statement as a stock of zero. Ticked follows the listing: the seller
       * is editing one product family and pressing "Save & resume sale" means
       * the sizes they have ticked go back on sale, not that they must then
       * switch each of eight rows on by hand.
       *
       * NEEDS_CHANGES and ARCHIVED are left exactly where they are. The first
       * exists to stop something being sold and a tick must not override it;
       * the second is a withdrawal, and `withdrawRow` is the only thing that
       * writes or clears it.
       */
      ...(existing.status === 'NEEDS_CHANGES' || existing.status === 'ARCHIVED'
        ? {}
        : { status: row.isActive ? listingStatus : ('INACTIVE' as const) }),
    },
  });

  await applyStock(tx, membership, existing, row);
}

/** Create one combination that did not exist before. */
async function createRow(
  tx: PrismaTransaction,
  membership: SellerMembership,
  current: ListingEditView,
  row: DraftVariantRow,
  sortOrder: number,
): Promise<void> {
  const variantId = newId();

  await tx.productVariant.create({
    data: {
      id: variantId,
      productId: current.product.id,
      name: variantNameOf(row),
      sku: row.sku,
      optionsJson: row.options as never,
      optionSignature: row.optionSignature,
      priceMinor:
        row.priceMinor === null || row.priceMinor === undefined ? null : BigInt(row.priceMinor),
      ...(row.compareAtPriceMinor === null || row.compareAtPriceMinor === undefined
        ? {}
        : { compareAtPriceMinor: BigInt(row.compareAtPriceMinor) }),
      // A real barcode or none. Never an invented one - a fabricated GTIN
      // scans as somebody else's product.
      ...(row.barcode === null || row.barcode === undefined || row.barcode === ''
        ? {}
        : { gtin: row.barcode }),
      isActive: row.isActive,
      sortOrder,
      minOrderQty: row.minOrderQty ?? null,
      qtyIncrement: row.qtyIncrement ?? null,
      maxOrderQty: row.maxOrderQty ?? null,
      leadTimeDays: row.leadTimeDays ?? null,
      multipackCount: row.multipackCount ?? null,
      netContentValue: row.netContentValue ?? null,
      netContentUnit: row.netContentUnit ?? null,
      shippingWeightGrams: row.shippingWeightGrams ?? null,
      shippingLengthMm: row.shippingLengthMm ?? null,
      shippingWidthMm: row.shippingWidthMm ?? null,
      shippingHeightMm: row.shippingHeightMm ?? null,
    },
  });

  if (row.mediaId !== undefined && row.mediaId !== null && row.mediaId !== '') {
    await tx.productVariantMedia.create({
      data: { id: newId(), variantId, mediaId: row.mediaId, isPrimary: true, sortOrder: 0 },
    });
  }

  const newOfferId = newId();

  await tx.sellerOffer.create({
    data: {
      id: newOfferId,
      sellerAccountId: membership.sellerAccountId,
      productId: current.product.id,
      variantId,
      variantKey: variantId,
      sellerSku: row.sku,
      // INACTIVE, whatever the seller is about to do with the listing itself.
      // Adding six sizes must not put six things in front of buyers because
      // the seventh button pressed said "resume".
      status: 'INACTIVE',
      orderingUnit: SELLER_SELLING_UNIT,
      priceMinor: BigInt(row.priceMinor ?? '0'),
      currency: current.currency,
      ...(current.terms.taxClassId === null ? {} : { taxClassId: current.terms.taxClassId }),
      minimumOrderQuantity: row.minOrderQty ?? 1,
      orderIncrement: row.qtyIncrement ?? 1,
      maximumOrderQuantity: row.maxOrderQty ?? null,
    },
  });

  for (const entry of row.stock) {
    if (entry.availableQuantity <= 0) continue;

    await tx.sellerInventory.create({
      data: {
        id: newId(),
        sellerAccountId: membership.sellerAccountId,
        offerId: newOfferId,
        locationId: entry.locationId,
        availableQuantity: entry.availableQuantity,
      },
    });

    await tx.sellerInventoryMovement.create({
      data: {
        id: newId(),
        sellerAccountId: membership.sellerAccountId,
        offerId: newOfferId,
        locationId: entry.locationId,
        type: 'RECEIPT',
        quantityDelta: entry.availableQuantity,
        balanceAfter: entry.availableQuantity,
        reason: 'Opening stock for a new version.',
        referenceType: 'seller_offer',
        referenceId: current.offerId,
        idempotencyKey: `variant-open:${newOfferId}:${entry.locationId}`,
      },
    });
  }

  await refreshOfferTotals(tx, newOfferId);
}

/**
 * The seller no longer offers this combination.
 *
 * Deactivated always; archived as well when nobody has bought it. A
 * combination that appears on an order keeps its variant row alive because the
 * order detail page reads through it to say what was in the box, and
 * `order_items` is ON DELETE RESTRICT in any case - a hard delete would fail
 * rather than corrupt anything, but a failed save on the last row of a matrix
 * is not a message a seller can act on.
 *
 * Returns 1 when the variant was archived, so the caller can report it.
 */
async function withdrawRow(tx: PrismaTransaction, row: ListingEditVariantRow): Promise<number> {
  await tx.sellerOffer.update({
    where: { id: row.offerId },
    data: {
      status: 'INACTIVE',
      ...(row.isOrderLinked ? {} : { archivedAt: new Date() }),
    },
  });

  if (row.variantId === null) return 0;

  await tx.productVariant.update({
    where: { id: row.variantId },
    data: { isActive: false, archivedAt: new Date() },
  });

  return 1;
}

/**
 * Move a combination's stock to the figure the seller typed.
 *
 * A movement per location, never a bare balance write. The ledger is the truth
 * and the balance is a running total of it, so a save that set the number
 * directly would leave the two disagreeing and the stock screen unable to
 * explain where twelve went.
 *
 * Locations the form did not mention are left alone. A seller editing prices
 * on a laptop must not empty a warehouse they were not looking at.
 */
async function applyStock(
  tx: PrismaTransaction,
  membership: SellerMembership,
  existing: ListingEditVariantRow,
  row: DraftVariantRow,
): Promise<void> {
  if (row.stock.length === 0) return;

  const held = new Map(existing.stock.map((entry) => [entry.locationId, entry.availableQuantity]));
  let touched = false;

  for (const entry of row.stock) {
    const before = held.get(entry.locationId) ?? 0;
    const delta = entry.availableQuantity - before;

    if (delta === 0) continue;
    touched = true;

    const balance = await tx.sellerInventory.findUnique({
      where: { offerId_locationId: { offerId: existing.offerId, locationId: entry.locationId } },
      select: { id: true, availableQuantity: true, version: true },
    });

    if (balance === null) {
      await tx.sellerInventory.create({
        data: {
          id: newId(),
          sellerAccountId: membership.sellerAccountId,
          offerId: existing.offerId,
          locationId: entry.locationId,
          availableQuantity: entry.availableQuantity,
        },
      });
    } else {
      await tx.sellerInventory.update({
        where: { id: balance.id },
        data: { availableQuantity: entry.availableQuantity, version: { increment: 1 } },
      });
    }

    await tx.sellerInventoryMovement.create({
      data: {
        id: newId(),
        sellerAccountId: membership.sellerAccountId,
        offerId: existing.offerId,
        locationId: entry.locationId,
        type: 'ADJUSTMENT',
        quantityDelta: delta,
        balanceAfter: entry.availableQuantity,
        reason: 'Counted while editing the listing.',
        referenceType: 'seller_offer',
        referenceId: existing.offerId,
        actorProfileId: membership.customerProfileId,
      },
    });
  }

  if (touched) await refreshOfferTotals(tx, existing.offerId);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * The things no row may say, whatever the form allowed.
 *
 * Checked here and not only in the browser, because the browser is not where
 * the rule lives: a seller's own integration posts to this endpoint too, and a
 * negative minimum order typed by a script is the same broken listing as one
 * typed by a person.
 */
function assertRowsAreSane(rows: readonly DraftVariantRow[]): void {
  const skus = new Map<string, string>();

  for (const row of rows) {
    const label = row.name === '' ? row.sku : row.name;

    if (row.isActive && row.sku.trim() === '') {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `${label} needs its own product code.`, [
        { field: 'sku', code: 'REQUIRED' },
      ]);
    }

    if (row.isActive && (row.priceMinor === null || row.priceMinor === undefined || BigInt(row.priceMinor) <= 0n)) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, `${label} needs a price before it can be sold.`, [
        { field: 'priceMinor', code: 'REQUIRED' },
      ]);
    }

    if (row.minOrderQty !== null && row.minOrderQty !== undefined && row.minOrderQty < 1) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `${label}: the smallest order has to be at least one.`,
        [{ field: 'minOrderQty', code: 'TOO_SMALL' }],
      );
    }

    if (row.qtyIncrement !== null && row.qtyIncrement !== undefined && row.qtyIncrement < 1) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `${label}: orders have to go up in steps of at least one.`,
        [{ field: 'qtyIncrement', code: 'TOO_SMALL' }],
      );
    }

    for (const entry of row.stock) {
      if (entry.availableQuantity < 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, `${label}: stock cannot be a negative number.`, [
          { field: 'stock', code: 'NEGATIVE' },
        ]);
      }
    }

    if (row.sku.trim() === '') continue;

    const fingerprint = row.sku.trim().toLowerCase();
    const clash = skus.get(fingerprint);

    if (clash !== undefined) {
      throw conflict(
        ErrorCode.SELLER_SKU_ALREADY_EXISTS,
        `${clash} and ${label} both use the code ${row.sku}. Each version needs its own.`,
        [{ field: 'sku', code: 'DUPLICATE' }],
      );
    }

    skus.set(fingerprint, label);
  }
}

/**
 * A code this seller already uses on something else.
 *
 * Scoped to OTHER products: the codes on this one are the matrix's own
 * business and are checked against each other above, which also has to allow a
 * row that simply keeps the code it already had.
 */
async function assertSkusAreFree(
  sellerAccountId: string,
  productId: string,
  rows: readonly DraftVariantRow[],
): Promise<void> {
  const wanted = rows.map((row) => row.sku.trim()).filter((sku) => sku !== '');
  if (wanted.length === 0) return;

  const clashes = await prisma.sellerOffer.findMany({
    where: {
      sellerAccountId,
      archivedAt: null,
      productId: { not: productId },
      sellerSku: { in: wanted },
    },
    select: { sellerSku: true },
  });

  const clash = clashes[0];

  if (clash !== undefined) {
    throw conflict(
      ErrorCode.SELLER_SKU_ALREADY_EXISTS,
      `You already use the code ${clash.sellerSku} on another listing.`,
      [{ field: 'sku', code: 'DUPLICATE' }],
    );
  }
}

/**
 * What has to be true before a buyer sees this again.
 *
 * Checked on RESUME rather than trusted from whenever it was last live,
 * because pausing is what a seller does in order to change things - that is
 * the whole point of the button - and the state they paused in is not the
 * state they are resuming from.
 *
 * Every refusal names the one thing to fix. "This listing is not valid" on a
 * screen with forty rows is a dead end.
 */
function assertReadyToResume(
  current: ListingEditView,
  change: {
    rows: readonly DraftVariantRow[];
    updates: readonly { row: DraftVariantRow; existing: ListingEditVariantRow }[];
    creates: readonly DraftVariantRow[];
    withdrawals: readonly ListingEditVariantRow[];
  },
): void {
  const problems: string[] = [];

  if (current.product.name.trim() === '') problems.push('it has no name');
  if (current.sellerSku.trim() === '') problems.push('it has no product code');
  if (current.product.categoryId.trim() === '') problems.push('it is not in a department');

  if (current.status === 'NEEDS_CHANGES') {
    problems.push(
      current.statusReason ?? 'the marketplace asked for changes that have not been made',
    );
  }

  /*
   * Whether anything is actually sellable once this save lands.
   *
   * Composed from what the form sent rather than from what is in the database,
   * because the database still holds the state before the save - a seller who
   * has just ticked their last combination back on would otherwise be told
   * they have none.
   */
  const withdrawn = new Set(change.withdrawals.map((row) => row.offerId));
  const sellable =
    change.rows.length > 0
      ? change.rows.filter((row) => row.isActive).length
      : current.variants.filter((row) => !withdrawn.has(row.offerId)).length;

  if (sellable === 0) {
    problems.push('none of its versions are switched on');
  }

  if (current.product.images.length === 0) {
    problems.push('it has no photograph');
  }

  if (current.terms.taxClassId === null) {
    problems.push('it has no tax class, so the GST on it cannot be worked out');
  }

  if (problems.length > 0) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      `${current.sellerSku} cannot go back on sale because ${problems.join(', and ')}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Photographs
// ---------------------------------------------------------------------------

/**
 * How many pictures one product carries.
 *
 * The same ceiling the wizard applies to a draft. A gallery past this stops
 * being a gallery and starts being a page a buyer scrolls through looking for
 * the one photograph that shows the connector.
 */
const MAX_PHOTOS_PER_PRODUCT = 12;

/**
 * Whether this seller may change this product's photographs.
 *
 * Only the seller who described the product in the first place. Several
 * sellers offer one catalogue entry - that is what a marketplace product IS -
 * so a distributor who merely matched their stock to an existing page must not
 * be able to replace the photographs somebody else's listing put there. The
 * answer is returned to the editor as well as enforced here, so the screen can
 * explain the rule rather than show a button that fails.
 */
export async function mayEditPhotos(
  membership: SellerMembership,
  productId: string,
): Promise<boolean> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { createdBySellerAccountId: true, isMarketplaceProduct: true },
  });

  return (
    product !== null &&
    product.isMarketplaceProduct &&
    product.createdBySellerAccountId === membership.sellerAccountId
  );
}

async function assertMayEditPhotos(
  membership: SellerMembership,
  productId: string,
): Promise<void> {
  if (await mayEditPhotos(membership, productId)) return;

  throw conflict(
    ErrorCode.SELLER_RESOURCE_DENIED,
    'These photographs belong to a catalogue entry somebody else described. Ask the marketplace to change them.',
  );
}

/** The listing a photograph is being changed on, checked for ownership. */
async function photoTarget(
  membership: SellerMembership,
  offerId: string,
): Promise<{ productId: string; sellerSku: string }> {
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { sellerAccountId: true, productId: true, sellerSku: true },
  });

  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');
  await assertMayEditPhotos(membership, offer.productId);

  return { productId: offer.productId, sellerSku: offer.sellerSku };
}

export interface AddListingPhotoInput {
  membership: SellerMembership;
  offerId: string;
  buffer: Buffer;
  originalFileName: string;
  altText?: string | null;
  correlationId?: string | null;
}

/**
 * Add one photograph to a product the seller is editing.
 *
 * The BYTES decide the type; the declared content type is not trusted anywhere
 * in this path. Stored once as a `MediaAsset` and attached with a
 * `ProductMedia` row - the same pair every other photograph in the catalogue
 * is, because a seller's picture is not a second kind of picture.
 */
export async function addListingPhoto(
  input: AddListingPhotoInput,
): Promise<{ mediaId: string; url: string; isPrimary: boolean }> {
  const { membership } = input;

  assertSellerPermission(membership, SellerPermission.MEDIA_UPLOAD);

  const target = await photoTarget(membership, input.offerId);

  const sniffed = sniffImageType(input.buffer);
  assertWithinSizeLimit(input.buffer.length);

  const existing = await prisma.productMedia.findMany({
    where: { productId: target.productId },
    select: { id: true, isPrimary: true, mediaId: true },
  });

  if (existing.length >= MAX_PHOTOS_PER_PRODUCT) {
    throw conflict(
      ErrorCode.MEDIA_TYPE_NOT_ALLOWED,
      `A product can carry ${String(MAX_PHOTOS_PER_PRODUCT)} photographs. Remove one before adding another.`,
    );
  }

  /*
   * The same picture twice is a seller pressing upload again after a slow
   * response, not a seller who wants two copies.
   *
   * Matched on the checksum of the bytes rather than on the file name, because
   * a browser renames on re-download. An asset the catalogue already holds is
   * REUSED rather than stored a second time - which is what `MediaAsset`'s
   * checksum column exists for.
   */
  const checksum = createHash('sha256').update(input.buffer).digest('hex');

  const held = await prisma.mediaAsset.findFirst({
    where: { checksum },
    select: { id: true, url: true },
  });

  const dimensions = readImageDimensions(input.buffer, sniffed.mimeType);

  const asset =
    held ??
    (await prisma.mediaAsset.create({
      data: {
        id: newId(),
        ...(await (async () => {
          const stored = await storage.put(
            input.buffer,
            sniffed.mimeType,
            sniffed.extension,
            'public',
          );
          return { storageKey: stored.storageKey, url: stored.url };
        })()),
        mimeType: sniffed.mimeType,
        sizeBytes: input.buffer.length,
        width: dimensions?.width ?? null,
        height: dimensions?.height ?? null,
        altText: input.altText ?? null,
        checksum,
      },
      select: { id: true, url: true },
    }));

  if (existing.some((row) => row.mediaId === asset.id)) {
    throw conflict(ErrorCode.CONFLICT, 'That exact picture is already on this product.', [
      { field: 'file', code: 'DUPLICATE_FILE' },
    ]);
  }

  // The first picture becomes the primary one: it is what renders in a search
  // result and on an order confirmation, and a product with none shows a
  // placeholder in both.
  const isPrimary = !existing.some((row) => row.isPrimary);

  await prisma.productMedia.create({
    data: {
      id: newId(),
      productId: target.productId,
      mediaId: asset.id,
      isPrimary,
      sortOrder: existing.length,
    },
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.listing.photo_added',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'product',
    resourceId: target.productId,
    after: { mediaId: asset.id, fileName: input.originalFileName.slice(0, 255) },
    summary: `A photograph was added to ${target.sellerSku}.`,
    correlationId: input.correlationId ?? null,
  });

  return { mediaId: asset.id, url: asset.url, isPrimary };
}

/**
 * Take a photograph off a product.
 *
 * The `MediaAsset` itself is left alone. It may be attached to another product
 * - the checksum reuse above makes that ordinary rather than exceptional - and
 * deleting the bytes because one listing stopped showing them would blank the
 * others. Sweeping unreferenced assets is a housekeeping job, not this one.
 */
export async function removeListingPhoto(
  membership: SellerMembership,
  offerId: string,
  mediaId: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.MEDIA_UPLOAD);

  const target = await photoTarget(membership, offerId);

  const rows = await prisma.productMedia.findMany({
    where: { productId: target.productId },
    orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
    select: { id: true, mediaId: true, isPrimary: true },
  });

  const going = rows.find((row) => row.mediaId === mediaId);
  if (going === undefined) throw notFound('Photograph');

  if (rows.length === 1) {
    // A published product with no picture is a search result with a grey box.
    throw conflict(
      ErrorCode.LISTING_IMAGE_REQUIRED,
      'A product needs at least one photograph. Add the replacement first, then remove this one.',
    );
  }

  await prisma.$transaction(async (tx) => {
    // A version pointing at this picture would otherwise render a broken one.
    // Removing the link falls it back to the family's gallery, which is the
    // reader's behaviour already.
    await tx.productVariantMedia.deleteMany({
      where: { mediaId, variant: { productId: target.productId } },
    });

    await tx.productMedia.delete({ where: { id: going.id } });

    if (going.isPrimary) {
      const next = rows.find((row) => row.id !== going.id);

      if (next !== undefined) {
        await tx.productMedia.update({ where: { id: next.id }, data: { isPrimary: true } });
      }
    }
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.listing.photo_removed',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'product',
    resourceId: target.productId,
    before: { mediaId },
    summary: `A photograph was removed from ${target.sellerSku}.`,
    correlationId: correlationId ?? null,
  });
}

/** Which picture a buyer sees first. */
export async function setPrimaryListingPhoto(
  membership: SellerMembership,
  offerId: string,
  mediaId: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.MEDIA_UPLOAD);

  const target = await photoTarget(membership, offerId);

  const row = await prisma.productMedia.findFirst({
    where: { productId: target.productId, mediaId },
    select: { id: true },
  });

  if (row === null) throw notFound('Photograph');

  await prisma.$transaction(async (tx) => {
    await tx.productMedia.updateMany({
      where: { productId: target.productId },
      data: { isPrimary: false },
    });

    await tx.productMedia.update({ where: { id: row.id }, data: { isPrimary: true } });
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.listing.photo_primary_changed',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'product',
    resourceId: target.productId,
    after: { mediaId },
    summary: `The main photograph of ${target.sellerSku} was changed.`,
    correlationId: correlationId ?? null,
  });
}
