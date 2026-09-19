/**
 * Adding versions to a listing that is already selling.
 *
 * `listing-variants.ts` is the wizard: a seller describing versions before
 * anything exists. This is the other half, and it is the one every catalogue
 * actually needs, because every listing that was published before versions
 * existed is sitting there with none.
 *
 * A suit listed as one thing, with one code and one price, is not wrong - it
 * is incomplete. Somewhere there is a rack of them in four sizes, and the
 * seller has no way to say so without deleting the listing and starting
 * again, which would throw away its code, its history and every order that
 * points at it.
 *
 * ---
 *
 * NOTHING IS INFERRED FROM THE OLD LISTING
 *
 * This is the rule the whole file is arranged around, and it is the one that
 * is tempting to break. A product called "Raymond, Suits & Clothing" is
 * obviously a suit, and a suit is obviously sold in sizes 38 to 44, and it
 * would be easy to offer that as a starting matrix with stock already in it.
 *
 * It must not. The seller has some sizes and not others, and inventing the
 * ones they do not stock puts combinations on a product page that nobody can
 * ship. The template SUGGESTS axes; the seller says which values are real;
 * and no combination becomes sellable until they have given it a code, a
 * price and a stock figure of their own.
 *
 * THE EXISTING OFFER IS NEVER DESTROYED
 *
 * The listing that is already selling keeps its id, its code, its price and
 * its order history. Adding versions ADDS rows beside it. What happens to the
 * original is the seller's decision, made explicitly afterwards - archive it,
 * pause it, or leave it as the "no particular size" line - because it is the
 * row their past orders point at and this code cannot know which they meant.
 *
 * STRUCTURAL CHANGES NEED THE LISTING PAUSED
 *
 * Adding versions changes what a buyer is choosing between, mid-session, on a
 * page somebody may have open. So the listing has to be off sale first. That
 * is the same rule the project guide states for every structural change, and
 * it is why Pause exists as something other than a way to hide a listing.
 */
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { findTemplate, resolveActiveAxes } from '../../domain/variants/registry.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { categorySlugPath } from '../catalog/variant-matrix.service.js';
import { syncMarketplacePrice } from '../catalog/marketplace-price.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { recordSellerAudit } from './audit.service.js';
import { refreshOfferTotals } from './inventory.service.js';
import {
  generateMatrix,
  normaliseAxes,
  normaliseRows,
  projectMatrix,
  validateVariants,
  variantNameOf,
  type DraftVariantAxis,
  type DraftVariantRow,
} from './listing-variants.js';

/** Pieces, stated rather than left to the column default. See the offer service. */
const SELLER_SELLING_UNIT = 'PIECE' as const;

/**
 * Everything the seller's version editor needs for one published listing.
 *
 * The template comes from the product's category rather than from anything
 * stored against the listing, so a suit gets the clothing axes whether it was
 * listed last week or two years ago.
 */
export async function readOfferVariants(membership: SellerMembership, offerId: string) {
  assertSellerPermission(membership, SellerPermission.LISTING_READ);

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: {
      id: true,
      sellerAccountId: true,
      status: true,
      sellerSku: true,
      currency: true,
      priceMinor: true,
      variantKey: true,
      version: true,
      productId: true,
      product: {
        select: { id: true, name: true, categoryId: true, hasVariants: true, variantAxesJson: true },
      },
    },
  });

  if (offer === null) throw notFound('Listing');
  assertSellerOwnership(membership, offer.sellerAccountId, 'Listing');

  const categorySlugs = await categorySlugPath(offer.product.categoryId);
  const template = findTemplate(categorySlugs);

  /*
   * Every version of this product THIS SELLER offers.
   *
   * Scoped to the seller, not to the product. Three distributors can sell one
   * shirt and each stocks a different half of the size run; showing one of
   * them the others' sizes as if they were their own would have them pricing
   * stock they do not hold.
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
      availableQuantity: true,
      variantKey: true,
      variant: {
        select: { id: true, name: true, optionsJson: true, optionSignature: true, isActive: true },
      },
      inventory: { select: { locationId: true, availableQuantity: true } },
    },
    orderBy: { sellerSku: 'asc' },
  });

  return {
    offerId: offer.id,
    status: offer.status,
    sellerSku: offer.sellerSku,
    currency: offer.currency,
    version: offer.version,
    productId: offer.productId,
    productName: offer.product.name,
    hasVariants: offer.product.hasVariants,
    /**
     * Whether versions can be added right now.
     *
     * A structural change on something a buyer may have open is refused, and
     * the reason is returned rather than left for the seller to deduce from a
     * disabled button.
     */
    isEditable: offer.status !== 'ACTIVE',
    blockedReason:
      offer.status === 'ACTIVE'
        ? 'Pause this listing before adding versions. Buyers may have it open right now.'
        : null,
    template:
      template === null
        ? null
        : {
            categorySlug: template.categorySlug,
            subcategorySlug: template.subcategorySlug,
            label: template.label,
            axes: [...template.axes],
          },
    existing: siblings.map((row) => ({
      offerId: row.id,
      sellerSku: row.sellerSku,
      status: row.status,
      priceMinor: row.priceMinor.toString(),
      compareAtPriceMinor: row.compareAtPriceMinor?.toString() ?? null,
      availableQuantity: row.availableQuantity,
      isBaseListing: row.variantKey === '',
      variantId: row.variant?.id ?? null,
      name: row.variant?.name ?? null,
      options: (row.variant?.optionsJson ?? {}) as Record<string, string>,
      optionSignature: row.variant?.optionSignature ?? '',
      inventory: row.inventory,
    })),
  };
}

export interface PreviewOfferVariantsInput {
  membership: SellerMembership;
  offerId: string;
  axes: DraftVariantAxis[];
}

/**
 * The combinations these axes would produce, without producing them.
 *
 * Marks the ones this seller already offers, so a seller adding one more
 * colour to a range they built last month is shown eight rows with six of
 * them already listed rather than eight that all look new.
 */
export async function previewOfferVariants(input: PreviewOfferVariantsInput): Promise<{
  rows: (DraftVariantRow & { exists: boolean })[];
  total: number;
  warnAbove: number;
  maximum: number;
  exceedsMaximum: boolean;
}> {
  const current = await readOfferVariants(input.membership, input.offerId);

  const template =
    current.template === null
      ? null
      : findTemplate([current.template.subcategorySlug ?? '', current.template.categorySlug]);

  const { axes } = normaliseAxes(template, input.axes);
  const projection = projectMatrix(axes);

  if (projection.exceedsMaximum) {
    return { rows: [], ...projection };
  }

  const taken = new Set(current.existing.map((row) => row.optionSignature).filter((s) => s !== ''));

  const { rows } = generateMatrix(axes, {
    templateAxes:
      template === null ? [] : resolveActiveAxes(template, axes.map((axis) => axis.axisKey)),
    productCode: current.sellerSku,
  });

  return {
    rows: rows.map((row) => ({ ...row, exists: taken.has(row.optionSignature) })),
    ...projection,
  };
}

export interface AddOfferVariantsInput {
  membership: SellerMembership;
  offerId: string;
  axes: DraftVariantAxis[];
  rows: DraftVariantRow[];
  expectedVersion?: number | null;
  correlationId?: string | null;
}

/**
 * Turn the seller's approved combinations into real, sellable rows.
 *
 * One transaction: a `ProductVariant` and a `SellerOffer` per combination,
 * with its opening stock and a movement to explain it. Half of this applied
 * would leave a product with variants nobody can buy, or offers pointing at
 * nothing.
 *
 * Idempotent by signature. A combination this seller already offers is
 * SKIPPED rather than duplicated or overwritten, so pressing the button twice
 * - which people do - adds nothing the second time and does not touch the
 * prices they set the first time.
 */
export async function addOfferVariants(
  input: AddOfferVariantsInput,
): Promise<{ created: number; skipped: number }> {
  const { membership, offerId } = input;

  assertSellerPermission(membership, SellerPermission.LISTING_WRITE);

  const current = await readOfferVariants(membership, offerId);

  if (!current.isEditable) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      current.blockedReason ?? 'This listing cannot be changed right now.',
    );
  }

  if (
    input.expectedVersion !== undefined &&
    input.expectedVersion !== null &&
    current.version !== input.expectedVersion
  ) {
    throw conflict(
      ErrorCode.SELLER_STALE_VERSION,
      'This listing changed since you opened it. Reload to see the newer version.',
    );
  }

  const template =
    current.template === null
      ? null
      : findTemplate([current.template.subcategorySlug ?? '', current.template.categorySlug]);

  const { axes } = normaliseAxes(template, input.axes);
  const { rows, duplicateSignatures } = normaliseRows(input.rows);

  /*
   * The same validator the wizard uses, and blockers are REFUSED here rather
   * than reported.
   *
   * The wizard reports because a draft is allowed to be half-finished. This
   * is not a draft: every row it accepts becomes something a buyer can put in
   * a basket within the minute, so a row with no price cannot be stored and
   * fixed later.
   */
  const problems = validateVariants({
    axes,
    rows,
    duplicateSignatures,
    skusInUseElsewhere: await skusInUseElsewhere(membership.sellerAccountId, current.productId),
  }).filter((issue) => issue.severity === 'BLOCKER');

  if (problems.length > 0) {
    throw conflict(
      ErrorCode.VALIDATION_FAILED,
      problems[0]?.message ?? 'Those versions cannot be added yet.',
    );
  }

  const existingSignatures = new Set(
    current.existing.map((row) => row.optionSignature).filter((entry) => entry !== ''),
  );

  const toCreate = rows.filter(
    (row) => row.isActive && !existingSignatures.has(row.optionSignature),
  );

  if (toCreate.length === 0) {
    return { created: 0, skipped: rows.length };
  }

  await prisma.$transaction(async (tx) => {
    for (const [position, row] of toCreate.entries()) {
      const variantId = newId();

      await tx.productVariant.create({
        data: {
          id: variantId,
          productId: current.productId,
          name: variantNameOf(row),
          sku: row.sku,
          optionsJson: row.options as never,
          optionSignature: row.optionSignature,
          priceMinor: row.priceMinor === null || row.priceMinor === undefined
            ? null
            : BigInt(row.priceMinor),
          ...(row.compareAtPriceMinor === null || row.compareAtPriceMinor === undefined
            ? {}
            : { compareAtPriceMinor: BigInt(row.compareAtPriceMinor) }),
          // A real barcode or none. Never an invented one - a fabricated GTIN
          // scans as somebody else's product.
          ...(row.barcode === null || row.barcode === undefined || row.barcode === ''
            ? {}
            : { gtin: row.barcode }),
          isActive: true,
          sortOrder: position,
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

      const newOfferId = newId();

      await tx.sellerOffer.create({
        data: {
          id: newOfferId,
          sellerAccountId: membership.sellerAccountId,
          productId: current.productId,
          variantId,
          variantKey: variantId,
          sellerSku: row.sku,
          // INACTIVE. The seller decides when each new version goes on sale,
          // the same as an approved listing - adding six sizes must not put
          // six things in front of buyers the instant Save is pressed.
          status: 'INACTIVE',
          orderingUnit: SELLER_SELLING_UNIT,
          priceMinor: BigInt(row.priceMinor ?? '0'),
          currency: current.currency,
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
            referenceId: offerId,
            idempotencyKey: `variant-open:${newOfferId}:${entry.locationId}`,
          },
        });
      }

      await refreshOfferTotals(tx, newOfferId);
    }

    // The family now sells along axes, so the buyer's page knows to draw a
    // selector rather than a bare quantity box.
    await tx.product.update({
      where: { id: current.productId },
      data: { hasVariants: true, variantAxesJson: axes.map((axis) => axis.axisKey) as never },
    });

    // New offers are INACTIVE, so this publishes nothing yet. Called anyway so
    // the price rows are correct the moment the seller switches one on, and
    // because leaving it to the status change would be one more thing to
    // remember.
    await syncMarketplacePrice(tx, current.productId);
  });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.offer.variants_added',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_offer',
    resourceId: offerId,
    after: {
      axes: axes.map((axis) => axis.axisKey),
      created: toCreate.map((row) => row.sku),
    },
    summary: `${toCreate.length} versions were added to ${current.sellerSku}.`,
    correlationId: input.correlationId ?? null,
  });

  return { created: toCreate.length, skipped: rows.length - toCreate.length };
}

/**
 * Every code this seller uses on another product.
 *
 * Scoped to OTHER products: the codes on this product are the matrix's own
 * business and are checked against each other by `validateVariants`, which
 * also has to allow a row that is simply already listed.
 */
async function skusInUseElsewhere(
  sellerAccountId: string,
  productId: string,
): Promise<Set<string>> {
  const rows = await prisma.sellerOffer.findMany({
    where: { sellerAccountId, archivedAt: null, productId: { not: productId } },
    select: { sellerSku: true },
  });

  return new Set(rows.map((row) => row.sellerSku.toLowerCase()));
}
