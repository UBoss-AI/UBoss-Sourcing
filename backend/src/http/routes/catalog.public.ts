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
import type { PUBLIC_PRODUCT_SELECT } from '../../modules/catalog/catalog.visibility.js';
import {
  publicProductSelect,
  publicProductWhere,
} from '../../modules/catalog/catalog.visibility.js';
import {
  findCategoryBySlug,
  listCategoryTree,
  subtreeCategoryIds,
} from '../../modules/catalog/category.service.js';
import { loadPricesForCurrency, priceKey } from '../../modules/catalog/price.service.js';
import {
  attributeConditions,
  attributeFacetsFor,
  attributeFiltersFrom,
  inStockCondition,
} from '../../modules/catalog/product-filters.js';
import {
  applyProductCopy,
  productIdsMatchingTranslation,
} from '../../modules/catalog/translation.service.js';
import { isSupportedLanguage } from '../../modules/identity/language.service.js';
import { resolveCurrencyFor } from '../../modules/settings/currency.service.js';

/**
 * The filters, shared by the listing and by the facet endpoint.
 *
 * One schema for both, because the facets have to be counted against exactly
 * the filters the listing is applying. Two schemas is how a facet comes to
 * promise twelve results that the grid then does not show.
 */
const filterQuerySchema = z.object({
  category: z.string().trim().max(255).optional(),
  q: z.string().trim().max(120).optional(),
  minPrice: z.coerce.number().int().min(0).optional(),
  maxPrice: z.coerce.number().int().min(0).optional(),
  recurringOnly: z.enum(['true', 'false']).optional(),
  /**
   * Hide stock-tracked products with nothing left to sell.
   *
   * Untracked products always pass: "we do not count this one" is not the same
   * statement as "there are none of these", and treating it as one would empty
   * the catalogue of a business that never used stock control.
   */
  inStockOnly: z.enum(['true', 'false']).optional(),
  /** Only products whose compare-at price is above what they now cost. */
  onSaleOnly: z.enum(['true', 'false']).optional(),
  /** Published within this many days. Capped at a year; 0 would mean nothing. */
  addedWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  /**
   * Attribute facets, as repeated `attr=Name:Value` pairs.
   *
   * Values under one name are an OR ("Brand is Acme or Bosch") and separate
   * names are an AND ("Brand is Acme AND Finish is Zinc"), which is how a
   * shopper reads a column of tick boxes. One occurrence arrives as a string
   * and several as an array, so both shapes are accepted and normalised once
   * in `attributeFiltersFrom`.
   */
  attr: z.union([z.string(), z.array(z.string())]).optional(),
  currency: z.string().trim().length(3).optional(),
  /**
   * Which language to return product copy in.
   *
   * Sent by the storefront the same way `currency` is, and for the same
   * reason: these routes carry no auth guard, so the shopper's saved
   * preference cannot be read here. Absent or unsupported, the base copy is
   * returned - never an error, because an unreadable language code should
   * degrade to English, not to a broken catalogue.
   */
  language: z.string().trim().max(10).optional(),
});

type FilterQuery = z.infer<typeof filterQuerySchema>;

/**
 * List query.
 *
 * `limit` is capped at 60. Without a ceiling, `?limit=100000` is a trivial way
 * to make the database do a very expensive read on an unauthenticated route.
 */
const listQuerySchema = filterQuerySchema.extend({
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(60).default(24),
  sort: z.enum(['newest', 'price_asc', 'price_desc', 'name_asc', 'name_desc']).default('newest'),
});

const detailQuerySchema = z.object({
  currency: z.string().trim().length(3).optional(),
  language: z.string().trim().max(10).optional(),
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
 * Which language to return copy in, or null for the base language.
 *
 * Never throws on an unknown code, unlike the currency check next door. A bad
 * currency has to be an error - quoting the wrong market's prices is the most
 * expensive mistake this API can make - but a bad language code just means
 * base-language copy, which is readable. Failing the whole catalogue over it
 * would be the worse outcome.
 */
function languageForRequest(requested: string | undefined): string | null {
  if (requested === undefined) return null;
  const primary = requested.toLowerCase().split('-')[0] ?? '';
  return isSupportedLanguage(primary) ? primary : null;
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
/**
 * One economic operator, as a listing shows it.
 *
 * Art. 19(a) asks for a name, a postal address and an electronic address. All
 * three go out together or the block is worth nothing: a manufacturer's name
 * with no way to contact them is exactly the state the article exists to stop.
 */
function serialiseOperator(
  operator: {
    legalName: string;
    tradeName: string | null;
    addressJson: unknown;
    countryCode: string;
    email: string;
    phone: string | null;
    website: string | null;
  } | null,
): Record<string, unknown> | null {
  if (operator === null) return null;

  return {
    legalName: operator.legalName,
    tradeName: operator.tradeName,
    address: operator.addressJson,
    countryCode: operator.countryCode,
    email: operator.email,
    phone: operator.phone,
    website: operator.website,
  };
}

function serialiseProduct(
  product: PublicProduct,
  currency: string,
  price: PricePair | null,
  variantPrices: Map<string, PricePair>,
): Record<string, unknown> {
  const primaryImage = product.media[0]?.media ?? null;

  // Field by field, not row by row: a product whose Polish name is written but
  // whose Polish description is not shows the Polish name beside the English
  // description, rather than reverting the whole product to English.
  // The intended purpose lives on the device row rather than on the product,
  // so it is lifted into the copy here - `applyProductCopy` layers a
  // translation over a base, and the base has to have the field to layer onto.
  const copy = applyProductCopy(
    { ...product, intendedPurpose: product.deviceInfo?.intendedPurpose ?? null },
    product.translations[0],
  );

  return {
    id: product.id,
    name: copy.name,
    slug: product.slug,
    sku: product.sku,
    shortDescription: copy.shortDescription,
    description: copy.description,
    // Not translated: the rich-text body is authored once and carries markup a
    // translation table has no way to keep in step.
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

    /**
     * MDR device identification, where this product is a device.
     *
     * Null for everything else, and the storefront renders nothing rather
     * than an empty "Device information" heading - which would read as "this
     * is a device with no certification", a much worse claim than silence.
     */
    device:
      product.deviceInfo === null
        ? null
        : {
            deviceClass: product.deviceInfo.deviceClass,
            basicUdiDi: product.deviceInfo.basicUdiDi,
            udiDi: product.deviceInfo.udiDi,
            notifiedBodyNumber: product.deviceInfo.notifiedBodyNumber,
            declarationOfConformityUrl: product.deviceInfo.declarationOfConformityUrl,
            // Follows the reader's language, like the warnings.
            intendedPurpose: copy.intendedPurpose,
            isSterile: product.deviceInfo.isSterile,
            isSingleUse: product.deviceInfo.isSingleUse,
            hasMeasuringFunction: product.deviceInfo.hasMeasuringFunction,
            containsBiologicalMaterial: product.deviceInfo.containsBiologicalMaterial,
            manufacturerSrn: product.manufacturer?.eudamedSrn ?? null,
          },

    /**
     * GPSR Art. 19. Present on every public product read, list and detail
     * alike.
     *
     * The article is about what a buyer can see BEFORE they buy, so none of
     * this is gated on anything - not on being signed in, not on reaching the
     * detail page. `safetyWarnings` follows the reader's language via
     * `applyProductCopy`; the operators do not, because a registered company
     * name and a postal address are not translated, they are transcribed.
     *
     * Null throughout for a catalogue that has not filled it in. The
     * storefront renders what is there and says nothing where there is
     * nothing - a heading over an empty block would read as "no warnings",
     * which is a different and much worse claim than "not stated here".
     */
    safety: {
      warnings: copy.safetyWarnings,
      instructions: copy.safetyInstructions,
      gtin: product.gtin,
      modelIdentifier: product.modelIdentifier,
      manufacturer: serialiseOperator(product.manufacturer),
      euResponsiblePerson: serialiseOperator(product.euResponsible),
    },

    category: {
      id: product.category.id,
      slug: product.category.slug,
      // The breadcrumb on a product page, so it has to follow the same
      // language as the copy above it.
      name: product.category.translations[0]?.name ?? product.category.name,
    },
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
        price: variantPrice === null ? null : serialiseMoney(variantPrice.basePriceMinor, currency),
      };
    }),

    seo: { metaTitle: product.metaTitle, metaDescription: product.metaDescription },
  };
}

/**
 * The resolved filters for one request.
 *
 * `unknownCategory` is not an error: a stale link to a category that has since
 * been renamed or deactivated should show an empty, still-usable page.
 */
interface ResolvedFilters {
  productWhere: Prisma.ProductWhereInput;
  attributes: Map<string, string[]>;
  unknownCategory: boolean;
}

/**
 * Turn the query into a product-level `where`.
 *
 * Everything that narrows the *product* lives here; the price-row conditions
 * are built next door by `priceWhereFor`, because those have to be expressed
 * against the row for the shopper's own currency.
 *
 * The conditions go into `AND` rather than onto the object, so that the search
 * term's `OR` and the in-stock `OR` cannot overwrite one another - two `OR`
 * keys on one object is the silent way to lose a filter.
 */
async function resolveFilters(
  query: FilterQuery,
  language: string | null,
  options: { includeAttributes: boolean },
): Promise<ResolvedFilters> {
  const attributes = attributeFiltersFrom(query.attr);
  const productWhere: Prisma.ProductWhereInput = publicProductWhere();
  const conditions: Prisma.ProductWhereInput[] = [];

  if (query.category !== undefined) {
    const category = await findCategoryBySlug(query.category);
    if (category === null) return { productWhere, attributes, unknownCategory: true };

    // Include descendants, so browsing a parent shows everything beneath it.
    productWhere.categoryId = { in: await subtreeCategoryIds(category.id) };
  }

  if (query.q !== undefined && query.q.length > 0) {
    // Base-language columns *and* the translated ones. Without the second
    // half, a Polish buyer reading a fully translated catalogue would search
    // it and get nothing back - the page would look translated and behave as
    // though it were not. The base match stays so a SKU, or a product nobody
    // has translated yet, is still findable in any language.
    const translatedIds = await productIdsMatchingTranslation(language, query.q);

    conditions.push({
      OR: [
        { name: { contains: query.q } },
        { shortDescription: { contains: query.q } },
        { sku: { contains: query.q } },
        ...(translatedIds.length > 0 ? [{ id: { in: translatedIds } }] : []),
      ],
    });
  }

  if (query.recurringOnly === 'true') {
    conditions.push({ isRecurringEligible: true });
  }

  if (query.inStockOnly === 'true') {
    conditions.push(inStockCondition());
  }

  if (query.addedWithinDays !== undefined) {
    const since = new Date(Date.now() - query.addedWithinDays * 24 * 60 * 60 * 1000);
    conditions.push({ publishedAt: { gte: since } });
  }

  if (options.includeAttributes) conditions.push(...attributeConditions(attributes));

  if (conditions.length > 0) productWhere.AND = conditions;

  return { productWhere, attributes, unknownCategory: false };
}

/**
 * The price-row conditions, in the shopper's currency.
 *
 * `variantKey` pins this to the base product, giving exactly one row per
 * product - the listing is rooted here, so a second row would duplicate the
 * product in the grid and inflate the count.
 *
 * `applyBounds` exists for the facet endpoint's price range, which has to
 * report what the catalogue holds rather than what the current price filter
 * already narrowed it to.
 */
function priceWhereFor(
  query: FilterQuery,
  currency: string,
  productWhere: Prisma.ProductWhereInput,
  options: { applyBounds: boolean } = { applyBounds: true },
): Prisma.ProductPriceWhereInput {
  const bounded =
    options.applyBounds && (query.minPrice !== undefined || query.maxPrice !== undefined);

  return {
    currencyCode: currency,
    variantKey: NO_VARIANT_KEY,
    // Omitted when empty: the facet endpoint asks for the currency test alone,
    // and `product: {}` would join the table back for nothing.
    ...(Object.keys(productWhere).length > 0 ? { product: productWhere } : {}),
    ...(bounded
      ? {
          basePriceMinor: {
            ...(query.minPrice !== undefined ? { gte: BigInt(query.minPrice) } : {}),
            ...(query.maxPrice !== undefined ? { lte: BigInt(query.maxPrice) } : {}),
          },
        }
      : {}),
    ...(query.onSaleOnly === 'true'
      ? // Strictly above, not merely present: a compare-at equal to the price
        // is not a saving, and listing it under "on offer" would be a lie told
        // to every shopper who ticked the box.
        { compareAtPriceMinor: { gt: prisma.productPrice.fields.basePriceMinor } }
      : {}),
  };
}

export function registerPublicCatalogRoutes(app: FastifyInstance): Promise<void> {
  /** Storefront navigation. Inactive categories are excluded by default. */
  app.get('/categories', async (request, reply) => {
    // The category bar is on every page of the storefront, so it has to follow
    // the same language as the products beneath it.
    const { language } = detailQuerySchema.parse(request.query);
    const tree = await listCategoryTree({ language: languageForRequest(language) });
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
    const language = languageForRequest(query.language);

    const { productWhere, unknownCategory } = await resolveFilters(query, language, {
      includeAttributes: true,
    });

    if (unknownCategory) {
      // An unknown category is an empty result, not a 404: the customer may
      // simply be following a stale link, and an empty grid with working
      // filters is a better experience than an error page.
      return reply.status(200).send({
        products: [],
        currency,
        pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
      });
    }

    // Rooted at the price row for this currency, so the filter and the sort
    // both operate on the amount the shopper is actually shown.
    const where = priceWhereFor(query, currency, productWhere);

    const [rows, total] = await Promise.all([
      prisma.productPrice.findMany({
        where,
        select: {
          basePriceMinor: true,
          compareAtPriceMinor: true,
          product: { select: publicProductSelect(language) },
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

  /**
   * What is worth offering as a filter, for the listing these same parameters
   * describe.
   *
   * The storefront cannot hard-code a facet list: which attributes exist is
   * the administrator's decision, taken per product by ticking "filterable".
   * So the panel asks what it should be showing, for this category, in this
   * currency, under the filters already applied.
   *
   * Two rules keep the numbers honest:
   *
   *   - Counts are taken with every *other* filter applied but with the
   *     attribute filters left off. That is what makes "Brand: Bosch (7)"
   *     still true after Brand: Acme is ticked - a count taken through the
   *     selection itself would read zero everywhere and the panel would look
   *     broken the moment it was used.
   *   - The price range ignores the price boxes, because it exists to say what
   *     the catalogue holds, not to echo what was just typed into them.
   */
  app.get('/filters', async (request, reply) => {
    const query = filterQuerySchema.parse(request.query);
    const currency = await currencyForRequest(query.currency);
    const language = languageForRequest(query.language);

    const { productWhere, unknownCategory } = await resolveFilters(query, language, {
      includeAttributes: false,
    });

    if (unknownCategory) {
      return reply
        .status(200)
        .send({ currency, priceRange: { min: null, max: null }, attributes: [] });
    }

    const scopedProductWhere: Prisma.ProductWhereInput = {
      ...productWhere,
      // Sold in this currency and inside the price filter, or it is not in
      // the listing these facets describe. Two failures live here: a product
      // priced only in INR would otherwise put a Brand on a USD shopper's
      // panel that filters the grid down to nothing, and a count taken without
      // the price bounds would promise twelve results under a maximum of 1,000
      // that the grid then shows three of.
      prices: { some: priceWhereFor(query, currency, {}) },
    };

    const [range, facets] = await Promise.all([
      prisma.productPrice.aggregate({
        where: priceWhereFor(query, currency, productWhere, { applyBounds: false }),
        _min: { basePriceMinor: true },
        _max: { basePriceMinor: true },
      }),
      attributeFacetsFor(scopedProductWhere),
    ]);

    return reply.status(200).send({
      currency,
      priceRange: {
        min:
          range._min.basePriceMinor === null
            ? null
            : serialiseMoney(range._min.basePriceMinor, currency),
        max:
          range._max.basePriceMinor === null
            ? null
            : serialiseMoney(range._max.basePriceMinor, currency),
      },
      attributes: facets,
    });
  });

  app.get('/products/:slug', async (request, reply) => {
    const { slug } = z.object({ slug: z.string().trim().max(255) }).parse(request.params);
    const query = detailQuerySchema.parse(request.query);
    const currency = await currencyForRequest(query.currency);
    const language = languageForRequest(query.language);

    const product = await prisma.product.findFirst({
      where: { ...publicProductWhere(), slug },
      select: publicProductSelect(language),
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
