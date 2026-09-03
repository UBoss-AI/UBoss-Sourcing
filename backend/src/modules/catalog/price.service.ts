/**
 * Per-currency catalogue prices.
 *
 * `product_prices` is the authority for what a SKU costs. Each row is a real
 * figure a human entered for that currency - never a conversion, because a
 * converted number drifts with the rate and the customer would be charged
 * something other than what the page showed.
 *
 * A SKU with no row for a currency is not sellable in it. `resolve` returns
 * null in that case and every caller must treat that as "unavailable", not as
 * "use another currency's number": falling back would sell a JPY 5,000 item
 * for USD 5,000.
 *
 * `Product.basePriceMinor` survives as a mirror of the base-currency row. It is
 * what bulk import writes, what inventory valuation totals, and what the admin
 * list sorts by - all base-currency concepts. `writeProductPrices` keeps the
 * two in step inside one transaction so they cannot disagree.
 */
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { type Minor } from '../../domain/money.js';
import { NO_VARIANT_KEY, newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

export interface SkuPrice {
  basePriceMinor: Minor;
  compareAtPriceMinor: Minor | null;
}

export interface SkuKey {
  productId: string;
  variantId?: string | null;
}

/** `${productId}:${variantKey}` - the shape every price map is keyed by. */
export function priceKey(productId: string, variantId: string | null | undefined): string {
  return `${productId}:${variantId ?? NO_VARIANT_KEY}`;
}

/**
 * Batch-load prices for a set of SKUs in one currency.
 *
 * A variant with no price row of its own inherits the base product's row for
 * that currency, mirroring how `ProductVariant.priceMinor` falls back to
 * `Product.basePriceMinor`. Absent both, the SKU is simply missing from the map.
 */
export async function loadPricesForCurrency(
  keys: readonly SkuKey[],
  currency: string,
): Promise<Map<string, SkuPrice>> {
  const result = new Map<string, SkuPrice>();
  if (keys.length === 0) return result;

  const productIds = [...new Set(keys.map((key) => key.productId))];

  const rows = await prisma.productPrice.findMany({
    where: { productId: { in: productIds }, currencyCode: currency },
    select: {
      productId: true,
      variantKey: true,
      basePriceMinor: true,
      compareAtPriceMinor: true,
    },
  });

  const byKey = new Map<string, SkuPrice>();
  for (const row of rows) {
    byKey.set(`${row.productId}:${row.variantKey}`, {
      basePriceMinor: row.basePriceMinor,
      compareAtPriceMinor: row.compareAtPriceMinor,
    });
  }

  for (const key of keys) {
    const variantKey = key.variantId ?? NO_VARIANT_KEY;
    const own = byKey.get(`${key.productId}:${variantKey}`);
    const inherited = variantKey === NO_VARIANT_KEY ? undefined : byKey.get(`${key.productId}:`);
    const price = own ?? inherited;

    if (price !== undefined) result.set(priceKey(key.productId, key.variantId), price);
  }

  const unresolved = keys.filter((key) => !result.has(priceKey(key.productId, key.variantId)));
  if (unresolved.length === 0) return result;

  await fillFromLegacyColumns(unresolved, currency, result);
  return result;
}

/**
 * Read the pre-multi-currency `products.basePriceMinor` column, but only for
 * products whose own `currency` is the one being asked for.
 *
 * This is NOT a cross-currency fallback - it never substitutes one currency's
 * number for another, which is the mistake this module exists to prevent. It
 * reads the same currency's price from the older column, so a product created
 * by a path that predates `product_prices` (bulk import, a direct fixture)
 * still appears in its home market instead of silently vanishing from the shop.
 *
 * `backfillBaseCurrencyPrices` promotes these into real rows; until it runs,
 * this keeps the catalogue whole.
 */
async function fillFromLegacyColumns(
  keys: readonly SkuKey[],
  currency: string,
  into: Map<string, SkuPrice>,
): Promise<void> {
  const products = await prisma.product.findMany({
    where: { id: { in: [...new Set(keys.map((key) => key.productId))] }, currency },
    select: {
      id: true,
      basePriceMinor: true,
      compareAtPriceMinor: true,
      variants: { select: { id: true, priceMinor: true } },
    },
  });

  const byProduct = new Map(products.map((product) => [product.id, product]));

  for (const key of keys) {
    const product = byProduct.get(key.productId);
    if (product === undefined) continue;

    const variant =
      key.variantId === null || key.variantId === undefined
        ? undefined
        : product.variants.find((row) => row.id === key.variantId);

    into.set(priceKey(key.productId, key.variantId), {
      basePriceMinor: variant?.priceMinor ?? product.basePriceMinor,
      compareAtPriceMinor:
        variant === undefined || variant.priceMinor === null
          ? product.compareAtPriceMinor
          : null,
    });
  }
}

/** Single-SKU convenience. Null means "not sellable in this currency". */
export async function resolvePrice(
  productId: string,
  variantId: string | null,
  currency: string,
): Promise<SkuPrice | null> {
  const map = await loadPricesForCurrency([{ productId, variantId }], currency);
  return map.get(priceKey(productId, variantId)) ?? null;
}

/** Currencies a product can actually be sold in, for the admin editor. */
export async function currenciesForProduct(productId: string): Promise<string[]> {
  const rows = await prisma.productPrice.findMany({
    where: { productId, variantKey: NO_VARIANT_KEY },
    select: { currencyCode: true },
    orderBy: { currencyCode: 'asc' },
  });
  return rows.map((row) => row.currencyCode);
}

export interface PriceInput {
  currencyCode: string;
  basePriceMinor: Minor;
  compareAtPriceMinor?: Minor | null;
}

/**
 * Replace the price set for one SKU.
 *
 * Currencies absent from `prices` are deleted, which is how staff withdraw a
 * product from a market. The base-currency mirror on `products` is updated in
 * the same transaction.
 */
export async function writeProductPrices(
  productId: string,
  variantId: string | null,
  prices: readonly PriceInput[],
  baseCurrency: string,
  actorId: string | null,
  tx?: PrismaTransaction,
): Promise<void> {
  const client = tx ?? prisma;
  const variantKey = variantId ?? NO_VARIANT_KEY;

  const seen = new Set<string>();
  for (const price of prices) {
    const code = price.currencyCode.trim().toUpperCase();

    if (seen.has(code)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `${code} is listed more than once.`,
        [{ field: 'prices', code: ErrorCode.VALIDATION_FAILED }],
      );
    }
    seen.add(code);

    if (price.basePriceMinor <= 0n) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `The ${code} price must be greater than zero.`,
        [{ field: `prices.${code}.basePriceMinor`, code: ErrorCode.VALIDATION_FAILED }],
      );
    }

    if (
      price.compareAtPriceMinor !== null &&
      price.compareAtPriceMinor !== undefined &&
      price.compareAtPriceMinor < price.basePriceMinor
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `The ${code} compare-at price cannot be below the selling price.`,
        [{ field: `prices.${code}.compareAtPriceMinor`, code: ErrorCode.VALIDATION_FAILED }],
      );
    }
  }

  await client.productPrice.deleteMany({
    where: { productId, variantKey, currencyCode: { notIn: [...seen] } },
  });

  for (const price of prices) {
    const code = price.currencyCode.trim().toUpperCase();

    await client.productPrice.upsert({
      where: {
        productId_variantKey_currencyCode: { productId, variantKey, currencyCode: code },
      },
      create: {
        id: newId(),
        productId,
        variantId,
        variantKey,
        currencyCode: code,
        basePriceMinor: price.basePriceMinor,
        compareAtPriceMinor: price.compareAtPriceMinor ?? null,
        updatedById: actorId,
      },
      update: {
        basePriceMinor: price.basePriceMinor,
        compareAtPriceMinor: price.compareAtPriceMinor ?? null,
        updatedById: actorId,
      },
    });
  }

  // Keep the base-currency mirror on `products` in step. Only the base product
  // row carries it; variants keep their own `priceMinor`.
  const base = prices.find((price) => price.currencyCode.trim().toUpperCase() === baseCurrency);
  if (base === undefined) return;

  if (variantKey === NO_VARIANT_KEY) {
    await client.product.update({
      where: { id: productId },
      data: {
        basePriceMinor: base.basePriceMinor,
        compareAtPriceMinor: base.compareAtPriceMinor ?? null,
      },
    });
  } else {
    await client.productVariant.update({
      where: { id: variantId ?? '' },
      data: { priceMinor: base.basePriceMinor },
    });
  }
}

/**
 * Seed `product_prices` from the legacy single-currency columns.
 *
 * Idempotent: it only creates rows that are missing, so it is safe to run on
 * every boot of a deployment that predates multi-currency pricing. Without it,
 * an existing catalogue would have no price in any currency and the storefront
 * would show an empty shop.
 */
export async function backfillBaseCurrencyPrices(baseCurrency: string): Promise<number> {
  const products = await prisma.product.findMany({
    select: {
      id: true,
      basePriceMinor: true,
      compareAtPriceMinor: true,
      variants: { select: { id: true, priceMinor: true } },
    },
  });

  const rows: {
    id: string;
    productId: string;
    variantId: string | null;
    variantKey: string;
    currencyCode: string;
    basePriceMinor: Minor;
    compareAtPriceMinor: Minor | null;
  }[] = [];

  for (const product of products) {
    rows.push({
      id: newId(),
      productId: product.id,
      variantId: null,
      variantKey: NO_VARIANT_KEY,
      currencyCode: baseCurrency,
      basePriceMinor: product.basePriceMinor,
      compareAtPriceMinor: product.compareAtPriceMinor,
    });

    for (const variant of product.variants) {
      if (variant.priceMinor === null) continue;
      rows.push({
        id: newId(),
        productId: product.id,
        variantId: variant.id,
        variantKey: variant.id,
        currencyCode: baseCurrency,
        basePriceMinor: variant.priceMinor,
        compareAtPriceMinor: null,
      });
    }
  }

  if (rows.length === 0) return 0;

  // skipDuplicates makes this a no-op for SKUs that already have a base row.
  const created = await prisma.productPrice.createMany({ data: rows, skipDuplicates: true });
  return created.count;
}
