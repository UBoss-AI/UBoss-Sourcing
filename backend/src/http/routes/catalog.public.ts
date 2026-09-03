/**
 * Public catalog.
 *
 * No authentication - guest browsing is enabled (Dev Plan 2.3). Every read goes
 * through `publicProductWhere()` and `PUBLIC_PRODUCT_SELECT`, so an unpublished
 * product cannot be reached even by guessing its slug, and no internal column
 * can leak by being added to the schema later.
 *
 * Everything here is priced in one currency, taken from `?currency=` and
 * falling back to the base. The listing is rooted at `product_prices` rather
 * than `products`, which is what makes sorting and price filtering happen in
 * the currency the shopper is actually looking at: ordering by the base-currency
 * column would list a USD grid in rupee order.
 *
 * A product with no row for the requested currency is not sold in it. It is
 * omitted from the listing, and its detail page says so rather than falling
 * back to another currency's number - that substitution would quote a JPY 5,000
 * item at USD 5,000.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import { NO_VARIANT_KEY } from '../../infra/ids.js';
import {
  PUBLIC_PRODUCT_SELECT,
  publicProductWhere,
} from '../../modules/catalog/catalog.visibility.js';
import {
  findCategoryBySlug,
  listCategoryTree,
  subtreeCategoryIds,
} from '../../modules/catalog/category.service.js';
import { loadPricesForCurrency, priceKey } from '../../modules/catalog/price.service.js';
import { resolveCurrencyFor } from '../../modules/settings/currency.service.js';

/**
 * List query.
 *
 * `limit` is capped at 60. Without a ceiling, `?limit=100000` is a trivial way
 * to make the database do a very expensive read on an unauthenticated route.
 */
const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  category: z.string().trim().max(255).optional(),
  q: z.string().trim().max(120).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  recurringOnly: z.enum(['true', 'false']).optional(),
  currency: z.string().trim().length(3).optional(),
  sort: z
    .enum(['newest', 'price_asc', 'price_desc', 'name_asc', 'name_desc'])
    .default('newest'),
});

const detailQuerySchema = z.object({
  currency: z.string().trim().length(3).optional(),
});

/**
 * Sort orders always end with a unique tiebreaker.
 *
 * Without one, two products at the same price can swap places between page 1
 * and page 2, so a customer sees one twice and never sees another. Stable
 * sorting is a correctness requirement for pagination, not a nicety.
 *
 * These are expressed against `product_prices`, so `product` reaches through
 * the to-one relation back to the catalogue row.
 */
const SORT_ORDERS = {
  newest: [{ product: { publishedAt: 'desc' } }, { productId: 'desc' }],
  price_asc: [{ basePriceMinor: 'asc' }, { productId: 'asc' }],
  price_desc: [{ basePriceMinor: 'desc' }, { productId: 'asc' }],
  name_asc: [{ product: { name: 'asc' } }, { productId: 'asc' }],
  name_desc: [{ product: { name: 'desc' } }, { productId: 'asc' }],
} as const satisfies Record<string, Prisma.ProductPriceOrderByWithRelationInput[]>;

type PublicProduct = NonNullable<
  Awaited<ReturnType<typeof prisma.product.findFirst<{ select: typeof PUBLIC_PRODUCT_SELECT }>>>
>;

interface PricePair {
  basePriceMinor: bigint;
  compareAtPriceMinor: bigint | null;
}

/**
 * Which currency to price this request in.
 *
 * These routes carry no auth guard - guest browsing is the point - so the
 * shopper's saved preference cannot be read here. The storefront knows it
 * (from `/account/locale`, or the country it asked a signed-out visitor for)
 * and sends it as `?currency=`. Absent that, the base currency.
 *
 * An unsellable code is rejected rather than silently ignored, so a typo shows
 * up as an error instead of quietly serving the wrong market's prices.
 */
async function currencyForRequest(requested: string | undefined): Promise<string> {
  return resolveCurrencyFor(null, requested ?? null);
}

/**
 * Shape a product for the wire.
 *
 * Money becomes `{ minor, formatted, currency }` strings - never a JS number,
 * which would silently lose precision above 2^53 and invites float arithmetic
 * in the frontend.
 *
 * `price` is null when the product is not sold in this currency. Callers must
 * render that as unavailable; there is deliberately no fallback amount.
 */
function serialiseProduct(
  product: PublicProduct,
  currency: string,
  price: PricePair | null,
  variantPrices: Map<string, PricePair>,
): Record<string, unknown> {
  const primaryImage = product.media[0]?.media ?? null;

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    sku: product.sku,
    shortDescription: product.shortDescription,
    description: product.description,
    descriptionHtml: product.descriptionHtml,

    currency,
    /** False when the catalogue carries no price for this SKU in `currency`. */
    availableInCurrency: price !== null,
    price: price === null ? null : serialiseMoney(price.basePriceMinor, currency),
    compareAtPrice:
      price === null || price.compareAtPriceMinor === null
        ? null
        : serialiseMoney(price.compareAtPriceMinor, currency),

    tax: {
      code: product.taxClass.code,
      name: product.taxClass.name,
      ratePercent: product.taxClass.ratePercent.toString(),
      inclusive: product.taxClass.isInclusive,
    },

    purchaseRules: {
      minOrderQty: product.minOrderQty,
      maxOrderQty: product.maxOrderQty,
      qtyIncrement: product.qtyIncrement,
      isRecurringEligible: product.isRecurringEligible,
    },

    category: product.category,
    isStockTracked: product.isStockTracked,
    hasVariants: product.hasVariants,
    publishedAt: product.publishedAt?.toISOString() ?? null,

    primaryImage:
      primaryImage === null ? null : { url: primaryImage.url, altText: primaryImage.altText },
    images: product.media.map((entry) => ({
      url: entry.media.url,
      altText: entry.media.altText,
      width: entry.media.width,
      height: entry.media.height,
      isPrimary: entry.isPrimary,
    })),

    attributes: product.attributes.map((attribute) => ({
      name: attribute.name,
      value: attribute.value,
    })),

    variants: product.variants.map((variant) => {
      const variantPrice = variantPrices.get(priceKey(product.id, variant.id)) ?? price;

      return {
        id: variant.id,
        sku: variant.sku,
        name: variant.name,
        options: variant.optionsJson,
        availableInCurrency: variantPrice !== null,
        price:
          variantPrice === null ? null : serialiseMoney(variantPrice.basePriceMinor, currency),
      };
    }),

    seo: { metaTitle: product.metaTitle, metaDescription: product.metaDescription },
  };
}

export function registerPublicCatalogRoutes(app: FastifyInstance): Promise<void> {
  /** Storefront navigation. Inactive categories are excluded by default. */
  app.get('/categories', async (_request, reply) => {
    const tree = await listCategoryTree();
    return reply.status(200).send({ categories: tree });
  });

  app.get('/categories/:slug', async (request, reply) => {
    const { slug } = z.object({ slug: z.string().trim().max(255) }).parse(request.params);

    const category = await findCategoryBySlug(slug);
    if (category === null) throw notFound('Category');

    return reply.status(200).send({ category });
  });

  app.get('/products', async (request, reply) => {
    const query = listQuerySchema.parse(request.query);
    const currency = await currencyForRequest(query.currency);

    const productWhere: Prisma.ProductWhereInput = publicProductWhere();

    if (query.category !== undefined) {
      const category = await findCategoryBySlug(query.category);
      if (category === null) {
        // An unknown category is an empty result, not a 404: the customer may
        // simply be following a stale link, and an empty grid with working
        // filters is a better experience than an error page.
        return reply.status(200).send({
          products: [],
          currency,
          pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
        });
      }
      // Include descendants, so browsing a parent shows everything beneath it.
      productWhere.categoryId = { in: await subtreeCategoryIds(category.id) };
    }

    if (query.q !== undefined && query.q.length > 0) {
      productWhere.OR = [
        { name: { contains: query.q } },
        { shortDescription: { contains: query.q } },
        { sku: { contains: query.q } },
      ];
    }

    if (query.recurringOnly === 'true') {
      productWhere.isRecurringEligible = true;
    }

    // Rooted at the price row for this currency, so the filter and the sort
    // both operate on the amount the shopper is actually shown. `variantKey`
    // pins it to the base product, giving exactly one row per product.
    const where: Prisma.ProductPriceWhereInput = {
      currencyCode: currency,
      variantKey: NO_VARIANT_KEY,
      product: productWhere,
      ...(query.minPrice !== undefined || query.maxPrice !== undefined
        ? {
            basePriceMinor: {
              ...(query.minPrice !== undefined ? { gte: BigInt(query.minPrice) } : {}),
              ...(query.maxPrice !== undefined ? { lte: BigInt(query.maxPrice) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.productPrice.findMany({
        where,
        select: {
          basePriceMinor: true,
          compareAtPriceMinor: true,
          product: { select: PUBLIC_PRODUCT_SELECT },
        },
        orderBy: [...SORT_ORDERS[query.sort]],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      prisma.productPrice.count({ where }),
    ]);

    // Variant prices for the page, so a grid card showing "from" pricing does
    // not need a query per product.
    const variantPrices = await loadPricesForCurrency(
      rows.flatMap((row) =>
        row.product.variants.map((variant) => ({
          productId: row.product.id,
          variantId: variant.id,
        })),
      ),
      currency,
    );

    return reply.status(200).send({
      products: rows.map((row) =>
        serialiseProduct(
          row.product,
          currency,
          {
            basePriceMinor: row.basePriceMinor,
            compareAtPriceMinor: row.compareAtPriceMinor,
          },
          variantPrices,
        ),
      ),
      currency,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  app.get('/products/:slug', async (request, reply) => {
    const { slug } = z.object({ slug: z.string().trim().max(255) }).parse(request.params);
    const query = detailQuerySchema.parse(request.query);
    const currency = await currencyForRequest(query.currency);

    const product = await prisma.product.findFirst({
      where: { ...publicProductWhere(), slug },
      select: PUBLIC_PRODUCT_SELECT,
    });

    // Covers both "no such product" and "exists but is not published". The
    // customer must not be able to tell those apart - the difference would
    // confirm an unreleased product by its slug.
    if (product === null) throw notFound('Product');

    const prices = await loadPricesForCurrency(
      [
        { productId: product.id, variantId: null },
        ...product.variants.map((variant) => ({
          productId: product.id,
          variantId: variant.id,
        })),
      ],
      currency,
    );

    const base = prices.get(priceKey(product.id, null)) ?? null;

    // Not sold in this currency is a real state, not an error. Telling the
    // shopper which currencies it IS sold in lets them switch, where a 404
    // would just look broken.
    const soldIn =
      base === null
        ? (
            await prisma.productPrice.findMany({
              where: { productId: product.id, variantKey: NO_VARIANT_KEY },
              select: { currencyCode: true },
              orderBy: { currencyCode: 'asc' },
            })
          ).map((row) => row.currencyCode)
        : [];

    return reply.status(200).send({
      product: serialiseProduct(product, currency, base, prices),
      currency,
      soldInCurrencies: soldIn,
    });
  });

  return Promise.resolve();
}
