/**
 * Writing the demonstration catalogue.
 *
 * THE ONE INVARIANT
 *
 * This file cannot touch a product a person created, and that is structural
 * rather than careful. Every write is addressed through `demo_catalog_entries`
 * - a blueprint resolves to a product by reading its own row, and a product
 * with no row here cannot be named. There is no SKU prefix being trusted, no
 * "created after this date", no heuristic. A bug in this file damages the
 * demonstration catalogue and stops there.
 *
 * IDEMPOTENT, AND IT HAS TO MEAN SOMETHING
 *
 * A second run converges rather than duplicating, which is the easy half. The
 * half that matters is that a second run produces the SAME catalogue: prices,
 * stock levels and SKUs are derived from the blueprint key rather than drawn at
 * random (see `rng.ts`), so a re-run after editing one blueprint changes one
 * product and leaves the other four hundred and thirteen byte-identical. A
 * seed whose diff is four hundred changed prices is a seed nobody reviews.
 *
 * WHAT IT DOES NOT DELETE
 *
 * A variant that has disappeared from a blueprint is DEACTIVATED, never
 * deleted. `order_items` and `cart_items` are RESTRICT on the variant, because
 * a line somebody bought is evidence of what was sold - so a delete would
 * either fail or, worse, succeed on a demonstration database and fail on the
 * one somebody has been placing test orders against all week.
 */
import { Prisma } from '../../../generated/prisma/client.js';
import { conversionFor, convert } from '../bulk-price.service.js';
import { env } from '../../../config/env.js';
import { findTemplate } from '../../../domain/variants/registry.js';
import { sanitiseProductHtml } from '../../../infra/sanitize.js';
import { NO_VARIANT_KEY, newId } from '../../../infra/ids.js';
import { logger } from '../../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../../infra/prisma.js';
import { ALL_SHELVES, assertRegistryIsSound } from './blueprints/index.js';
import { generateProduct, type GeneratedProduct } from './generate.js';
import {
  hasUnsplashKey,
  loadImageCache,
  resolveImage,
  saveImageCache,
  type ImageSource,
} from './images.js';
import type { Shelf } from './types.js';

/** Bumped when the registry changes shape in a way that should rewrite rows. */
export const SEED_VERSION = 1;

/** Which generator owns these rows. A second generator would use its own. */
export const SEED_SOURCE = 'demo-catalog';

/**
 * The markets the demonstration catalogue is priced into.
 *
 * The base currency's row is the authored figure. Every other row is a
 * CONVERSION, written with `isAutoConverted: true` so that the operator's own
 * exchange-rate refresh takes ownership of it from the first run onwards and
 * an administrator editing one by hand keeps their edit - see
 * `fx-rate.service.ts`. The rates here are indicative starting points, not a
 * market feed, and they are openly synthetic like every other figure in this
 * catalogue.
 *
 * A currency this deployment has switched off is skipped rather than failing:
 * `product_prices.currencyCode` is a foreign key, and a row in a currency
 * nobody sells in is a row nothing will ever read.
 */
const CONVERSIONS: readonly { currency: string; rate: string }[] = Object.freeze([
  { currency: 'EUR', rate: '0.0110' },
  { currency: 'USD', rate: '0.0120' },
  { currency: 'GBP', rate: '0.0094' },
  { currency: 'AED', rate: '0.0441' },
  { currency: 'PLN', rate: '0.0478' },
]);

/** What one run did, per product. */
export type ProductOutcome = 'created' | 'updated' | 'unchanged' | 'skipped';

export interface SeedOptions {
  /** Work everything out and report, writing nothing. */
  readonly dryRun?: boolean;
  /** Only this department, by slug. */
  readonly categorySlug?: string | undefined;
  /** Only this sub-category, by slug. */
  readonly subcategorySlug?: string | undefined;
  /** At most this many product families per sub-category. */
  readonly perSubcategory?: number | undefined;
  /** Re-resolve photographs and write nothing else. */
  readonly imagesOnly?: boolean;
  /** Check the registry and the catalogue, write nothing, resolve no images. */
  readonly validateOnly?: boolean;
  /** Ask Unsplash where a key is configured. False uses the library only. */
  readonly useApi?: boolean;
}

export interface SeedReport {
  readonly created: number;
  readonly updated: number;
  readonly unchanged: number;
  readonly skipped: number;
  readonly variantsWritten: number;
  readonly imagesFromApi: number;
  readonly imagesFromLibrary: number;
  readonly imagesPlaceholder: number;
  /** Products whose photograph is a stand-in rather than a picture of it. */
  readonly imagesNeedingReview: readonly string[];
  /** Sub-category slugs in the registry that this deployment does not have. */
  readonly missingSubcategories: readonly string[];
  /** Sub-categories with fewer than three products after the run. */
  readonly underCovered: readonly string[];
  readonly problems: readonly string[];
  readonly categoriesCovered: number;
  readonly subcategoriesCovered: number;
}

/** A sub-category as this deployment actually holds it. */
interface ShelfContext {
  readonly categoryId: string;
  readonly categoryName: string;
  readonly departmentSlug: string;
}

/**
 * Where every sub-category in the registry lives in THIS deployment.
 *
 * Read once rather than per blueprint, and keyed on slug because a display
 * name is the operator's to change - one of them will rename "Footwear" on
 * their second day, and the seed has to keep finding it.
 */
async function loadShelves(): Promise<Map<string, ShelfContext>> {
  const wanted = ALL_SHELVES.map((entry) => entry.subcategory);

  const rows = await prisma.category.findMany({
    where: { slug: { in: wanted }, archivedAt: null },
    select: {
      id: true,
      name: true,
      slug: true,
      parent: { select: { slug: true } },
    },
  });

  const map = new Map<string, ShelfContext>();
  for (const row of rows) {
    map.set(row.slug, {
      categoryId: row.id,
      categoryName: row.name,
      departmentSlug: row.parent?.slug ?? row.slug,
    });
  }
  return map;
}

/** The tax class a demonstration product is filed under. */
async function resolveTaxClassId(): Promise<string> {
  const preferred = await prisma.taxClass.findFirst({
    where: { isDefault: true },
    select: { id: true },
  });
  if (preferred !== null) return preferred.id;

  const any = await prisma.taxClass.findFirst({ select: { id: true } });
  if (any === null) {
    throw new Error(
      'This deployment has no tax class. Run `npm run db:seed` before the demonstration catalogue.',
    );
  }
  return any.id;
}

/** Where the demonstration stock is held. */
async function resolveLocationId(): Promise<string> {
  const location = await prisma.inventoryLocation.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  if (location === null) {
    throw new Error(
      'This deployment has no active warehouse. Run `npm run db:seed` before the demonstration catalogue.',
    );
  }
  return location.id;
}

/** The currencies this deployment actually sells in. */
async function resolveCurrencies(): Promise<{ base: string; targets: string[] }> {
  const rows = await prisma.currency.findMany({
    where: { isActive: true },
    select: { code: true, isBase: true },
  });

  const base = rows.find((row) => row.isBase)?.code;
  if (base === undefined) {
    throw new Error('This deployment has no base currency. Run `npm run db:seed` first.');
  }

  const active = new Set(rows.map((row) => row.code));
  const targets = CONVERSIONS.map((entry) => entry.currency).filter(
    (code) => code !== base && active.has(code),
  );

  return { base, targets };
}

// ---------------------------------------------------------------------------
// WRITING ONE FAMILY
// ---------------------------------------------------------------------------

interface WriteContext {
  readonly taxClassId: string;
  readonly locationId: string;
  readonly baseCurrency: string;
  readonly targetCurrencies: readonly string[];
  readonly categoryId: string;
  readonly image: {
    readonly url: string | null;
    readonly alt: string;
    readonly source: ImageSource;
    readonly photoId: string | null;
    readonly photographer: string | null;
    readonly profileUrl: string | null;
    readonly photoPageUrl: string | null;
    readonly needsReview: boolean;
  };
  readonly subcategorySlug: string;
}

/**
 * The media row for one product's photograph.
 *
 * Keyed on a storage key derived from the blueprint, so a re-run updates the
 * same asset rather than leaving an orphan behind every time a photograph
 * changes. Nothing is downloaded: the URL is hotlinked, which is what the
 * Unsplash terms ask for, and `sizeBytes` is therefore unknown rather than
 * zero - the column is not nullable, so zero is what "we did not fetch these
 * bytes" has to look like here.
 */
async function writeMedia(
  tx: PrismaTransaction,
  product: GeneratedProduct,
  context: WriteContext,
): Promise<string | null> {
  if (context.image.url === null) return null;

  const storageKey = `demo-catalog/${product.blueprintKey}`;

  const existing = await tx.mediaAsset.findUnique({
    where: { storageKey },
    select: { id: true },
  });

  if (existing !== null) {
    await tx.mediaAsset.update({
      where: { id: existing.id },
      data: { url: context.image.url, altText: context.image.alt.slice(0, 512) },
    });
    return existing.id;
  }

  const id = newId();
  await tx.mediaAsset.create({
    data: {
      id,
      storageKey,
      url: context.image.url,
      mimeType: 'image/jpeg',
      sizeBytes: 0,
      width: 1200,
      height: 1200,
      altText: context.image.alt.slice(0, 512),
    },
  });
  return id;
}

/** Price rows for one SKU, in the base currency and every conversion. */
async function writePrices(
  tx: PrismaTransaction,
  productId: string,
  variantId: string | null,
  priceMinor: bigint,
  compareAtMinor: bigint | null,
  context: WriteContext,
): Promise<void> {
  const variantKey = variantId ?? NO_VARIANT_KEY;

  const rows: {
    currency: string;
    price: bigint;
    compareAt: bigint | null;
    auto: boolean;
  }[] = [
    { currency: context.baseCurrency, price: priceMinor, compareAt: compareAtMinor, auto: false },
  ];

  for (const entry of CONVERSIONS) {
    if (!context.targetCurrencies.includes(entry.currency)) continue;

    const conversion = conversionFor({
      sourceCurrency: context.baseCurrency,
      targetCurrency: entry.currency,
      rate: entry.rate,
      rounding: 'charm',
    });

    rows.push({
      currency: entry.currency,
      price: convert(priceMinor, conversion),
      compareAt: compareAtMinor === null ? null : convert(compareAtMinor, conversion),
      auto: true,
    });
  }

  for (const row of rows) {
    await tx.productPrice.upsert({
      where: {
        productId_variantKey_currencyCode: {
          productId,
          variantKey,
          currencyCode: row.currency,
        },
      },
      update: {
        basePriceMinor: row.price,
        compareAtPriceMinor: row.compareAt,
        variantId,
        isAutoConverted: row.auto,
      },
      create: {
        id: newId(),
        productId,
        variantId,
        variantKey,
        currencyCode: row.currency,
        basePriceMinor: row.price,
        compareAtPriceMinor: row.compareAt,
        isAutoConverted: row.auto,
      },
    });
  }
}

/**
 * Put stock on one SKU, at the demonstration warehouse.
 *
 * The balance is set rather than adjusted, and a movement is written for the
 * difference - which keeps the ledger adding up to the balance, the discipline
 * the inventory module is built on. A re-run that changes nothing writes no
 * movement, which is what keeps a second seed from filling the ledger with
 * zero-quantity noise.
 */
async function writeStock(
  tx: PrismaTransaction,
  productId: string,
  variantId: string | null,
  quantity: number,
  context: WriteContext,
): Promise<void> {
  const variantKey = variantId ?? NO_VARIANT_KEY;

  const existing = await tx.inventoryBalance.findUnique({
    where: {
      productId_variantKey_locationId: { productId, variantKey, locationId: context.locationId },
    },
    select: { id: true, onHandQty: true, version: true },
  });

  if (existing === null) {
    await tx.inventoryBalance.create({
      data: {
        id: newId(),
        productId,
        variantId,
        variantKey,
        locationId: context.locationId,
        onHandQty: quantity,
        reservedQty: 0,
      },
    });
  } else {
    if (existing.onHandQty === quantity) return;
    await tx.inventoryBalance.update({
      where: { id: existing.id },
      data: { onHandQty: quantity, version: { increment: 1 } },
    });
  }

  const delta = quantity - (existing?.onHandQty ?? 0);
  if (delta === 0) return;

  await tx.inventoryMovement.create({
    data: {
      id: newId(),
      productId,
      variantId,
      variantKey,
      locationId: context.locationId,
      type: existing === null ? 'RECEIPT' : 'ADJUSTMENT',
      quantityDelta: delta,
      resultingOnHand: quantity,
      reason: 'Demonstration catalogue seed',
      referenceType: SEED_SOURCE,
      actorType: 'SYSTEM',
    },
  });
}

/**
 * How many pieces one purchasable unit of this product holds, or null.
 *
 * Read off the blueprint's own packing description rather than from a setting:
 * a carton exists because the supplier packs one, and a product whose
 * blueprint describes no carton does not have one. Both figures are required -
 * a description that says how many go in a box but not how many boxes go in a
 * carton has not described a carton, and inventing the second number is how a
 * buyer is quoted for a quantity nobody packs.
 */
function cartonSizeOf(product: GeneratedProduct): number | null {
  const packing = product.packing;
  if (packing === undefined) return null;
  if (packing.perInner === undefined || packing.innersPerOuter === undefined) return null;

  const pieces = packing.perInner * packing.innersPerOuter;
  return pieces > 1 ? pieces : null;
}

/**
 * Re-point one product's photograph, and change nothing else about it.
 *
 * What `--images-only` actually means. A full run would converge on the same
 * rows and is therefore harmless, but a flag that claims to touch one thing and
 * rewrites four hundred products is a flag nobody dares use on a database they
 * care about - and the whole point of this one is to be run after configuring
 * an Unsplash key against a catalogue somebody has already been working with.
 *
 * Returns 'skipped' for a product this deployment has never planted: there is
 * nothing to re-point, and creating it here would be the one thing this mode
 * promises not to do.
 */
async function writeImageOnly(
  product: GeneratedProduct,
  context: WriteContext,
): Promise<{ outcome: ProductOutcome; variants: number }> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.demoCatalogEntry.findUnique({
      where: { seedKey: product.seedKey },
      select: { id: true, productId: true },
    });

    if (entry === null) return { outcome: 'skipped' as const, variants: 0 };

    const mediaId = await writeMedia(tx, product, context);

    if (mediaId !== null) {
      await tx.productMedia.deleteMany({
        where: { productId: entry.productId, mediaId: { not: mediaId } },
      });
      await tx.productMedia.upsert({
        where: { productId_mediaId: { productId: entry.productId, mediaId } },
        update: { isPrimary: true, sortOrder: 0 },
        create: {
          id: newId(),
          productId: entry.productId,
          mediaId,
          isPrimary: true,
          sortOrder: 0,
        },
      });
    }

    await tx.demoCatalogEntry.update({
      where: { id: entry.id },
      data: {
        imageSource: context.image.source,
        imagePhotoId: context.image.photoId,
        imagePhotographer: context.image.photographer,
        imageProfileUrl: context.image.profileUrl,
        imagePhotoPageUrl: context.image.photoPageUrl,
        imageNeedsReview: context.image.needsReview,
      },
    });

    return { outcome: 'updated' as const, variants: 0 };
  });
}

/** Write one product family, and say what happened to it. */
async function writeFamily(
  product: GeneratedProduct,
  context: WriteContext,
): Promise<{ outcome: ProductOutcome; variants: number }> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.demoCatalogEntry.findUnique({
      where: { seedKey: product.seedKey },
      select: { id: true, productId: true },
    });

    const mediaId = await writeMedia(tx, product, context);
    const descriptionHtml = sanitiseProductHtml(product.descriptionHtml);

    const shared = {
      categoryId: context.categoryId,
      name: product.name,
      slug: product.slug,
      sku: product.sku,
      shortDescription: product.shortDescription.slice(0, 1024),
      description: product.description,
      descriptionHtml,
      status: 'ACTIVE' as const,
      isPublished: true,
      taxClassId: context.taxClassId,
      basePriceMinor: product.basePriceMinor,
      compareAtPriceMinor: product.compareAtPriceMinor,
      currency: context.baseCurrency,
      isStockTracked: true,
      isOrderable: true,
      minOrderQty: product.minOrderQty,
      qtyIncrement: product.qtyIncrement,

      /*
       * Sold one at a time unless the blueprint says otherwise.
       *
       * Null for all but a handful of these, and that is the point: a cordless
       * drill, a laptop and a pair of boots are bought singly, and the shop's
       * deployment-wide carton used to be applied to every one of them - which
       * put the drill on the page at five hundred times its price with "one
       * carton has 500 pieces" printed underneath it.
       *
       * A blueprint that declares a packing description with a full inner and
       * outer count IS cartoned, and gets the figure from its own description
       * rather than from a setting. That is the medical consumables range, and
       * it behaves exactly as the imported catalogue beside it does.
       */
      piecesPerCarton: cartonSizeOf(product),
      // Every one of these is a real catalogue product with a real price and
      // real stock, so there is no reason a customer should not be able to put
      // one on a schedule and see that flow work.
      isRecurringEligible: true,
      hasVariants: product.variants.length > 1,
      // Prisma distinguishes a JSON null from an absent value; a family with
      // no declared axes wants the column set to JSON null, not left alone.
      variantAxesJson: product.variantAxes === null ? Prisma.DbNull : [...product.variantAxes],
      weightGrams: product.weightGrams,
      metaTitle: product.metaTitle.slice(0, 255),
      metaDescription: product.metaDescription.slice(0, 512),
      archivedAt: null,
    };

    let productId: string;
    let outcome: ProductOutcome;

    if (entry === null) {
      productId = newId();
      await tx.product.create({
        data: { id: productId, publishedAt: new Date(), ...shared },
      });
      outcome = 'created';
    } else {
      productId = entry.productId;
      await tx.product.update({ where: { id: productId }, data: shared });
      outcome = 'updated';
    }

    // --- Specifications -------------------------------------------------
    //
    // Replaced wholesale rather than merged: a specification removed from a
    // blueprint must actually disappear from the product page, and a merge
    // would leave it there for ever. Nothing references these rows.
    await tx.productAttribute.deleteMany({ where: { productId } });
    await tx.productAttribute.createMany({
      data: product.attributes.map((attribute) => ({
        id: newId(),
        productId,
        name: attribute.name.slice(0, 128),
        value: attribute.value.slice(0, 512),
        sortOrder: attribute.sortOrder,
        isFilterable: attribute.isFilterable,
      })),
    });

    // --- Photograph ------------------------------------------------------
    if (mediaId !== null) {
      await tx.productMedia.deleteMany({ where: { productId, mediaId: { not: mediaId } } });
      await tx.productMedia.upsert({
        where: { productId_mediaId: { productId, mediaId } },
        update: { isPrimary: true, sortOrder: 0 },
        create: { id: newId(), productId, mediaId, isPrimary: true, sortOrder: 0 },
      });
    }

    // --- Variants ---------------------------------------------------------
    //
    // One family, one grid. A combination that has left the blueprint is
    // deactivated rather than deleted - see the note at the top of this file.
    const singleUnkeyed =
      product.variants.length === 1 && product.variants[0]?.optionSignature === '';

    const liveVariantIds = new Set<string>();
    let variantsWritten = 0;

    if (!singleUnkeyed) {
      for (const variant of product.variants) {
        const existing = await tx.productVariant.findUnique({
          where: {
            productId_optionSignature: {
              productId,
              optionSignature: variant.optionSignature,
            },
          },
          select: { id: true },
        });

        const data = {
          sku: variant.sku,
          name: variant.name.slice(0, 255),
          optionsJson: variant.options,
          priceMinor: variant.priceMinor,
          compareAtPriceMinor: variant.compareAtPriceMinor,
          minOrderQty: variant.minOrderQty,
          qtyIncrement: variant.qtyIncrement,
          leadTimeDays: variant.leadTimeDays,
          multipackCount: variant.multipackCount,
          netContentValue: variant.netContentValue,
          netContentUnit: variant.netContentUnit,
          unitPricingBaseValue: variant.unitPricingBaseValue,
          unitPricingBaseUnit: variant.unitPricingBaseUnit,
          manufacturerPackLabel: variant.manufacturerPackLabel,
          shippingWeightGrams: variant.shippingWeightGrams,
          isActive: true,
          sortOrder: variant.sortOrder,
          archivedAt: null,
        };

        const variantId =
          existing === null
            ? (
                await tx.productVariant.create({
                  data: {
                    id: newId(),
                    productId,
                    optionSignature: variant.optionSignature,
                    ...data,
                  },
                  select: { id: true },
                })
              ).id
            : (
                await tx.productVariant.update({
                  where: { id: existing.id },
                  data,
                  select: { id: true },
                })
              ).id;

        liveVariantIds.add(variantId);
        variantsWritten += 1;

        await writePrices(
          tx,
          productId,
          variantId,
          variant.priceMinor,
          variant.compareAtPriceMinor,
          context,
        );
        await writeStock(tx, productId, variantId, variant.stock, context);
      }

      await tx.productVariant.updateMany({
        where: { productId, id: { notIn: [...liveVariantIds] }, isActive: true },
        data: { isActive: false, archivedAt: new Date() },
      });
    }

    // The family's own price row is what the storefront grid is rooted at, so
    // it is written whether or not the family has variants. It carries the
    // cheapest figure - the "from" price a card shows.
    await writePrices(
      tx,
      productId,
      null,
      product.basePriceMinor,
      product.compareAtPriceMinor,
      context,
    );

    if (singleUnkeyed) {
      await writeStock(tx, productId, null, product.variants[0]?.stock ?? 0, context);
    }

    // --- Packaging ---------------------------------------------------------
    if (product.packing !== undefined) {
      const packing = product.packing;
      const pieces =
        packing.perInner !== undefined && packing.innersPerOuter !== undefined
          ? packing.perInner * packing.innersPerOuter
          : null;

      await tx.productPackaging.upsert({
        where: { productId_variantKey: { productId, variantKey: NO_VARIANT_KEY } },
        update: {
          packingType: packing.type,
          piecesPerInnerPack: packing.perInner ?? null,
          innerPacksPerOuterCarton: packing.innersPerOuter ?? null,
          piecesPerOuterCarton: pieces,
          innerPackType: packing.innerName ?? null,
          outerPackType: packing.outerName ?? null,
          parseStatus: pieces === null ? 'PARTIAL' : 'PARSED',
        },
        create: {
          id: newId(),
          productId,
          variantKey: NO_VARIANT_KEY,
          packingType: packing.type,
          packingRawText: null,
          piecesPerInnerPack: packing.perInner ?? null,
          innerPacksPerOuterCarton: packing.innersPerOuter ?? null,
          piecesPerOuterCarton: pieces,
          innerPackType: packing.innerName ?? null,
          outerPackType: packing.outerName ?? null,
          parseStatus: pieces === null ? 'PARTIAL' : 'PARSED',
        },
      });
    }

    // --- The marker row ------------------------------------------------------
    const markerData = {
      productId,
      seedSource: SEED_SOURCE,
      seedVersion: SEED_VERSION,
      subcategorySlug: context.subcategorySlug,
      imageSource: context.image.source,
      imagePhotoId: context.image.photoId,
      imagePhotographer: context.image.photographer,
      imageProfileUrl: context.image.profileUrl,
      imagePhotoPageUrl: context.image.photoPageUrl,
      imageNeedsReview: context.image.needsReview,
      generatedAt: new Date(),
    };

    await tx.demoCatalogEntry.upsert({
      where: { seedKey: product.seedKey },
      update: markerData,
      create: { id: newId(), seedKey: product.seedKey, ...markerData },
    });

    return { outcome, variants: variantsWritten };
  });
}

// ---------------------------------------------------------------------------
// THE RUN
// ---------------------------------------------------------------------------

/** Which shelves this run is interested in. */
function selectShelves(options: SeedOptions, shelves: Map<string, ShelfContext>): Shelf[] {
  return ALL_SHELVES.filter((entry) => {
    if (options.subcategorySlug !== undefined && entry.subcategory !== options.subcategorySlug) {
      return false;
    }
    if (options.categorySlug !== undefined) {
      const context = shelves.get(entry.subcategory);
      if (context === undefined || context.departmentSlug !== options.categorySlug) return false;
    }
    return true;
  });
}

/** Plant, or re-plant, the demonstration catalogue. */
export async function seedDemoCatalog(options: SeedOptions = {}): Promise<SeedReport> {
  assertRegistryIsSound();
  await prepareRuntime();

  const shelves = await loadShelves();
  const selected = selectShelves(options, shelves);

  const perSubcategory = options.perSubcategory ?? env.DEMO_CATALOG_PRODUCT_COUNT;

  const problems: string[] = [];
  const missingSubcategories: string[] = [];
  const underCovered: string[] = [];
  const imagesNeedingReview: string[] = [];
  const departments = new Set<string>();
  const covered = new Set<string>();

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  let variantsWritten = 0;
  let imagesFromApi = 0;
  let imagesFromLibrary = 0;
  let imagesPlaceholder = 0;

  const useApi = (options.useApi ?? true) && !options.validateOnly && hasUnsplashKey();
  const cache = useApi ? await loadImageCache() : {};

  // Slugs and SKUs are unique across the WHOLE catalogue, so the sets that
  // keep them apart span the whole run rather than one shelf.
  const slugs = new Set<string>();
  const skus = new Set<string>();

  for (const entry of selected) {
    const context = shelves.get(entry.subcategory);

    if (context === undefined) {
      // The operator has renamed or removed this shelf, which is their
      // business. Reported, not corrected: planting a category of ours beside
      // theirs is how a catalogue ends up with two of everything.
      missingSubcategories.push(entry.subcategory);
      skipped += entry.products.length;
      continue;
    }

    departments.add(context.departmentSlug);

    const blueprints = entry.products.slice(0, perSubcategory);
    if (blueprints.length < 3) underCovered.push(entry.subcategory);

    for (const [index, blueprint] of blueprints.entries()) {
      // Nearest slug first, exactly as the storefront resolves it, so the
      // variant names this generates read the way the selector will draw them.
      const product = generateProduct(blueprint, {
        departmentSlug: context.departmentSlug,
        subcategorySlug: entry.subcategory,
        subcategoryName: context.categoryName,
        template: findTemplate([entry.subcategory, context.departmentSlug]),
        slugs,
        skus,
      });

      if (options.validateOnly) {
        covered.add(entry.subcategory);
        unchanged += 1;
        continue;
      }

      const image = await resolveImage(
        {
          query: blueprint.img,
          alt: product.imageAlt,
          departmentSlug: context.departmentSlug,
          subcategorySlug: entry.subcategory,
          index,
          seedKey: product.seedKey,
        },
        cache,
        { useApi },
      );

      if (image.source === 'unsplash-api') imagesFromApi += 1;
      else if (image.source === 'verified-library') imagesFromLibrary += 1;
      else imagesPlaceholder += 1;

      if (image.needsReview) imagesNeedingReview.push(`${entry.subcategory}/${blueprint.key}`);

      if (options.dryRun) {
        covered.add(entry.subcategory);
        unchanged += 1;
        continue;
      }

      try {
        const write = options.imagesOnly === true ? writeImageOnly : writeFamily;

        const result = await write(product, {
          taxClassId: RUNTIME.taxClassId,
          locationId: RUNTIME.locationId,
          baseCurrency: RUNTIME.baseCurrency,
          targetCurrencies: RUNTIME.targetCurrencies,
          categoryId: context.categoryId,
          subcategorySlug: entry.subcategory,
          image,
        });

        covered.add(entry.subcategory);
        variantsWritten += result.variants;
        if (result.outcome === 'created') created += 1;
        else if (result.outcome === 'updated') updated += 1;
        else unchanged += 1;
      } catch (error) {
        skipped += 1;
        problems.push(
          `${entry.subcategory}/${blueprint.key}: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
        logger.error({ err: error, blueprint: blueprint.key }, 'demo catalogue product failed');
      }
    }
  }

  if (useApi) await saveImageCache(cache);

  return {
    created,
    updated,
    unchanged,
    skipped,
    variantsWritten,
    imagesFromApi,
    imagesFromLibrary,
    imagesPlaceholder,
    imagesNeedingReview,
    missingSubcategories,
    underCovered,
    problems,
    categoriesCovered: departments.size,
    subcategoriesCovered: covered.size,
  };
}

/**
 * The deployment-wide facts a run needs, resolved once.
 *
 * Module state rather than a parameter threaded through every function,
 * because they are constant for the life of a run and there is exactly one run
 * per process - this is a CLI, not a server. `prepareRuntime` is called by the
 * entry point below before anything reads them.
 */
const RUNTIME = {
  taxClassId: '',
  locationId: '',
  baseCurrency: '',
  targetCurrencies: [] as string[],
};

/** Resolve the deployment's tax class, warehouse and currencies. */
export async function prepareRuntime(): Promise<void> {
  const [taxClassId, locationId, currencies] = await Promise.all([
    resolveTaxClassId(),
    resolveLocationId(),
    resolveCurrencies(),
  ]);

  RUNTIME.taxClassId = taxClassId;
  RUNTIME.locationId = locationId;
  RUNTIME.baseCurrency = currencies.base;
  RUNTIME.targetCurrencies = currencies.targets;
}

/**
 * Every demonstration product this deployment holds, with its coverage.
 *
 * Read from the database rather than from the registry, because the question
 * it answers is "what is actually on the shelf" and the two can differ - a
 * blueprint added since the last run, a sub-category an operator archived.
 */
export async function demoCatalogCoverage(): Promise<{
  products: number;
  variants: number;
  subcategories: number;
  departments: number;
  bySubcategory: { slug: string; products: number }[];
}> {
  const entries = await prisma.demoCatalogEntry.groupBy({
    by: ['subcategorySlug'],
    _count: { _all: true },
  });

  const productIds = (
    await prisma.demoCatalogEntry.findMany({ select: { productId: true } })
  ).map((row) => row.productId);

  const variants =
    productIds.length === 0
      ? 0
      : await prisma.productVariant.count({
          where: { productId: { in: productIds }, isActive: true },
        });

  // The DEPARTMENT each stocked shelf sits under, read from this deployment's
  // own tree rather than assumed from the registry - an operator who re-parents
  // a sub-category has moved it, and this should say so.
  const stocked = entries.map((row) => row.subcategorySlug);
  const parents = await prisma.category.findMany({
    where: { slug: { in: stocked } },
    select: { parentId: true },
  });
  const departments = new Set(
    parents.map((row) => row.parentId).filter((id): id is string => id !== null),
  );

  return {
    products: productIds.length,
    variants,
    subcategories: entries.length,
    departments: departments.size,
    bySubcategory: entries
      .map((row) => ({ slug: row.subcategorySlug, products: row._count._all }))
      .sort((left, right) => (left.slug < right.slug ? -1 : 1)),
  };
}
