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
 *
 * `?country=` is the second half of the same question and is asked separately,
 * because a currency is not a location: Germany, the Netherlands and Ireland
 * share the euro and charge 19%, 21% and 23% on the same box. The currency
 * chooses the price list; the country decides what that figure becomes once the
 * destination's VAT has been applied to it. Every price on the way out goes
 * through `location-price.service`, which is the same `applyLineTax` the cart
 * prices through - so the grid, the product page and the basket cannot quote
 * three different numbers. In a deployment with no EU VAT configured that call
 * returns the listed figure untouched.
 */
import type { FastifyInstance } from 'fastify';
import type { Prisma } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { AppError, ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import type { VariantAxis } from '../../domain/variants/axis.js';
import { VARIANT_TEMPLATES, findTemplate } from '../../domain/variants/registry.js';
import { prisma } from '../../infra/prisma.js';
import { NO_VARIANT_KEY } from '../../infra/ids.js';
import { assertWithinSizeLimit, sniffImageType } from '../../infra/storage/index.js';
import { getAvailabilityMap } from '../../modules/inventory/inventory.service.js';
import { requireCustomer } from '../plugins/auth.js';
import {
  AssistantBusyError,
  isAssistantConfigured,
} from '../../modules/assistant/assistant.service.js';
import {
  ImageSearchUnreadableError,
  analyseProductImage,
} from '../../modules/assistant/image-search.service.js';
import {
  SELLER_SELLING_UNIT,
  operatorSellUnit,
  sellerSellUnit,
} from '../../domain/ordering-unit.js';
import { cheapestOfferFor } from '../../modules/catalog/marketplace-price.service.js';
import { listBuyableOptions } from '../../modules/seller/packaging.service.js';
import type { PUBLIC_PRODUCT_SELECT } from '../../modules/catalog/catalog.visibility.js';
import {
  publicProductSelect,
  publicProductWhere,
} from '../../modules/catalog/catalog.visibility.js';
import {
  isScheduleEligible,
  scheduleEligibleWhere,
} from '../../modules/catalog/recurring-eligibility.js';
import {
  findCategoryBySlug,
  listCategoryTree,
  subtreeCategoryIds,
} from '../../modules/catalog/category.service.js';
import {
  loadShelfContext,
  quoteShelfPrice,
  toListed,
  toQuoted,
  type ShelfContext,
} from '../../modules/catalog/location-price.service.js';
import { loadPricesForCurrency, priceKey } from '../../modules/catalog/price.service.js';
import type { ConversionContext } from '../../modules/catalog/derived-price.service.js';
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
import {
  serialisePackaging,
  variantPackagingFor,
  type SerialisedPackaging,
} from '../../modules/catalog/packaging.service.js';

/**
 * The filters, shared by the listing and by the facet endpoint.
 *
 * One schema for both, because the facets have to be counted against exactly
 * the filters the listing is applying. Two schemas is how a facet comes to
 * promise twelve results that the grid then does not show.
 */
const filterQuerySchema = z.object({
  /**
   * A category slug, or several separated by commas.
   *
   * Widened from 255 to 512 characters when the second form was added: a
   * curated shelf naming four departments is comfortably over 255, and a
   * silently truncated list is a shelf that quietly loses its last department.
   */
  category: z.string().trim().max(512).optional(),
  q: z.string().trim().max(120).optional(),
  /** A model or size - "14G", "3 ml" - matched against the variants. */
  model: z.string().trim().max(120).optional(),
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
   * Where the shopper says they are, as ISO-3166 alpha-2.
   *
   * Not the same question as `currency`, and it is asked separately because
   * the answers genuinely differ: Germany, the Netherlands and Ireland are one
   * currency and three VAT rates. The currency decides which price list is
   * read; the country decides what that figure becomes once the destination's
   * tax is applied to it.
   *
   * Absent, unreadable, or in a deployment with no EU VAT configured, prices
   * come back exactly as they are listed - see `location-price.service`.
   */
  country: z.string().trim().max(8).optional(),
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

/**
 * How many product cards one answer may show.
 *
 * Six is the ceiling the assistant is told to keep to and twelve is what this
 * route will resolve, so a reply that overshoots renders a long-but-bounded
 * row rather than being cut off in a way that reads as a broken answer.
 */
const MAX_PRODUCT_CARDS = 12;

/** References, plus the same market questions every other read here asks. */
const cardQuerySchema = z.object({
  /** Comma-separated slugs or product codes. */
  refs: z.string().trim().max(2_000).default(''),
  currency: z.string().trim().length(3).optional(),
  country: z.string().trim().max(8).optional(),
  language: z.string().trim().max(10).optional(),
});

const detailQuerySchema = z.object({
  currency: z.string().trim().length(3).optional(),
  /** As on the listing: the destination whose VAT this price is quoted under. */
  country: z.string().trim().max(8).optional(),
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

/**
 * The same sorts, against a seller's own offers.
 *
 * A seller's shop front is rooted at `seller_offers` rather than at
 * `product_prices`, because on that shop the price of a thing IS the seller's
 * price — sorting by the operator's column would order a seller's grid by
 * somebody else's numbers, which is wrong in a way nobody would ever spot from
 * the screen.
 */
const SELLER_SORT_ORDERS = {
  newest: [{ product: { publishedAt: 'desc' } }, { productId: 'desc' }],
  price_asc: [{ priceMinor: 'asc' }, { productId: 'asc' }],
  price_desc: [{ priceMinor: 'desc' }, { productId: 'asc' }],
  name_asc: [{ product: { name: 'asc' } }, { productId: 'asc' }],
  name_desc: [{ product: { name: 'desc' } }, { productId: 'asc' }],
} as const satisfies Record<string, Prisma.SellerOfferOrderByWithRelationInput[]>;

type PublicProduct = NonNullable<
  Awaited<ReturnType<typeof prisma.product.findFirst<{ select: typeof PUBLIC_PRODUCT_SELECT }>>>
>;

interface PricePair {
  basePriceMinor: bigint;
  compareAtPriceMinor: bigint | null;
  /**
   * Present only when the figure was converted rather than typed.
   *
   * Optional rather than required because several call sites in this file
   * build a `PricePair` from a seller's offer or a variant row, where no
   * conversion was involved and there is nothing to disclose. Absent and null
   * mean the same thing to the caller: a real price somebody entered.
   */
  conversion?: ConversionContext | null;
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

/**
 * What the figure on this product's card is a price FOR.
 *
 * The one place the storefront's whole display basis is decided, and it is
 * decided from product OWNERSHIP - never from a category, a seller's name, a
 * route or a string comparison. The operator's own line is a carton at this
 * deployment's carton size; a product a seller described is a piece.
 *
 * `minimumOrderQuantity` and `orderIncrement` are the OFFER's, and are filled in
 * only where the caller has actually loaded an offer - the grid has not, and
 * would need one query per card to. The detail page has, so that is where a
 * "Minimum 5 pieces" can be shown. The defaults are the permissive ones,
 * because the server applies the real terms on every basket write regardless.
 */
function sellUnitFor(
  product: { isMarketplaceProduct: boolean; piecesPerCarton: number | null },
  offer?: {
    minimumOrderQuantity: number;
    orderIncrement: number;
    maximumOrderQuantity: number | null;
  } | null,
): Record<string, unknown> {
  const spec = product.isMarketplaceProduct
    ? sellerSellUnit({
        // The unit is not read off the offer here on purpose. Only PIECE is
        // sellable by a seller, and an offer holding anything else has already
        // been taken off sale by the migration - so a product reaching a public
        // grid is a product whose live offers are pieces.
        orderingUnit: SELLER_SELLING_UNIT,
        minimumOrderQuantity: offer?.minimumOrderQuantity ?? 1,
        orderIncrement: offer?.orderIncrement ?? 1,
        maximumOrderQuantity: offer?.maximumOrderQuantity ?? null,
      })
    : // The product's own carton, not the deployment's. A catalogue that sells
      // both a box of cannulas and a cordless drill has one of each, and the
      // deployment-wide figure was quoting the drill at five hundred times its
      // price. See `piecesPerUnitFor`.
      operatorSellUnit(product);

  return {
    unit: spec.unit,
    piecesPerUnit: spec.piecesPerUnit,
    minimumOrderQuantity: spec.minimumOrderQuantity,
    orderIncrement: spec.orderIncrement,
    maximumOrderQuantity: spec.maximumOrderQuantity,
    /** True when the figure above is already the price of one sell unit. */
    isPricedPerSellUnit: spec.piecesPerUnit === 1,
  };
}

/**
 * Each category's slug, then its ancestors' slugs, nearest first.
 *
 * What `findTemplate` walks: a shelf an operator added under "Footwear"
 * inherits Footwear's axes, because that is what a subcategory of footwear is.
 * `path` is the materialised `/rootId/childId/` trail, so this is one indexed
 * read for the whole page rather than a walk up the tree per product.
 */
async function categorySlugPathsFor(
  categories: readonly { id: string; slug: string; path: string }[],
): Promise<Map<string, string[]>> {
  const ancestorIds = [
    ...new Set(categories.flatMap((entry) => entry.path.split('/').filter((part) => part !== ''))),
  ];

  const slugById = new Map(
    ancestorIds.length === 0
      ? []
      : (
          await prisma.category.findMany({
            where: { id: { in: ancestorIds } },
            select: { id: true, slug: true },
          })
        ).map((row) => [row.id, row.slug] as const),
  );

  return new Map(
    categories.map((entry) => [
      entry.id,
      [
        entry.slug,
        // The trail reads root-to-leaf, so it is reversed: the nearest
        // ancestor is the one whose template a child should inherit.
        ...entry.path
          .split('/')
          .filter((part) => part !== '')
          .reverse()
          .map((id) => slugById.get(id))
          .filter((slug): slug is string => slug !== undefined),
      ],
    ]),
  );
}

function serialiseProduct(
  product: PublicProduct,
  currency: string,
  price: PricePair | null,
  variantPrices: Map<string, PricePair>,
  shelf: ShelfContext,
  variantPackaging?: Map<string, SerialisedPackaging>,
  offerTerms?: {
    minimumOrderQuantity: number;
    orderIncrement: number;
    maximumOrderQuantity: number | null;
  } | null,
  /**
   * Category id to its slug trail, nearest first, for resolving the variant
   * template of a shelf an operator created under one of ours.
   *
   * Supplied on the detail read, where one extra query is nothing and the
   * answer decides whether a selector can be labelled. Absent on a grid, where
   * no selector is drawn and the product's own category slug is the only
   * lookup worth paying for.
   */
  categorySlugPaths?: Map<string, string[]>,
  /**
   * Whether each sellable SKU can be had right now, keyed `productId:variantKey`.
   *
   * A BOOLEAN, never a quantity, and that distinction is the whole reason this
   * exists as its own argument. This storefront deliberately does not publish
   * warehouse figures - a competitor should not be able to read stock levels
   * off a shop front - but "is there one" and "how many are there" are
   * different questions, and refusing to answer the first one costs the buyer
   * something real.
   *
   * Without it the variant selector could only ever say "not offered". A size
   * that exists and is empty would look identical to a size that is not sold,
   * which is the single most common way a variant selector lies to somebody.
   *
   * Absent on a grid, and absent for an untracked product, both of which mean
   * "no answer" rather than "no stock".
   */
  variantStock?: Map<string, boolean>,
): Record<string, unknown> {
  const primaryImage = product.media[0]?.media ?? null;

  // What this product costs where the shopper says they are. Under FLAT_RATE -
  // any deployment that has not configured EU VAT - `quote` hands back the
  // listed figure and the tax class's own rate, so nothing below changes.
  const line = {
    vatCategory: product.taxClass.vatCategory,
    flatRatePercent: product.taxClass.ratePercent.toString(),
    taxInclusive: product.taxClass.isInclusive,
    productName: product.name,
  };

  const quote = price === null ? null : quoteShelfPrice(shelf.setup, line, price.basePriceMinor);

  // The strike-through follows the selling price. Leaving it at the listed
  // figure would invent a saving in a low-VAT market and erase one in a
  // high-VAT market, which is a claim about a discount that was never offered.
  const compareAt =
    price === null || price.compareAtPriceMinor === null
      ? null
      : quoteShelfPrice(shelf.setup, line, price.compareAtPriceMinor).unitPriceMinor;

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
    price: quote === null ? null : serialiseMoney(quote.unitPriceMinor, currency),
    compareAtPrice: compareAt === null ? null : serialiseMoney(compareAt, currency),

    /**
     * How that figure was arrived at, and - when it was converted - from what.
     *
     * Sent on every read because the storefront has to caption the price at
     * the moment it renders it, not after a second request. A shopper looking
     * at a converted figure is entitled to know it is one, and to know how old
     * the rate behind it is; a shopper looking at a price somebody typed is
     * entitled not to be told anything at all.
     *
     * Null for a manual price, which is the ordinary case and the default for
     * every deployment. `approximate` is always true when this is present,
     * spelled out rather than implied so a client cannot read the object and
     * conclude the opposite.
     */
    priceConversion:
      price?.conversion === undefined || price.conversion === null
        ? null
        : {
            approximate: true as const,
            baseCurrency: price.conversion.baseCurrency,
            rate: price.conversion.rate.rate,
            rateAsOf: price.conversion.rate.asOf.toISOString(),
            provider: price.conversion.rate.provider,
          },

    /**
     * What that price is PER, and how the quantity control may move.
     *
     * `price` above is, and always has been, the price of one PIECE - that is
     * how the catalogue stores money, and none of this changes it. What this
     * block adds is the missing half of the sentence: multiply it by
     * `piecesPerUnit` to get the figure to put on the card, and name the unit
     * beside it. The storefront used to supply that factor itself from the
     * deployment's carton setting, which was right for the operator's products
     * and wrong for every seller's.
     */
    sellUnit: sellUnitFor(product, offerTerms),

    /**
     * Whether this can be bought, and what to say instead when it cannot.
     *
     * Sent on every read, list and detail alike, because the grid has to decide
     * between a price and "Request a quote" before anybody clicks anything. A
     * storefront without this would render a price of zero beside a working Add
     * to basket button, which is the worst of every available outcome.
     *
     * `canAddToCart` is the single answer the two flags reduce to, computed
     * here so the storefront, the assistant and any future client cannot each
     * reach a different conclusion from the same two booleans. The server
     * enforces it again on every basket write regardless - see cart.service.
     */
    purchasability: {
      isPriceOnRequest: product.isPriceOnRequest,
      isOrderable: product.isOrderable,
      unavailabilityReason: product.unavailabilityReason,
      canAddToCart: product.isOrderable && !product.isPriceOnRequest && price !== null,
    },

    /**
     * How it is packed, and what a carton holds.
     *
     * Null for a product nobody has recorded packing for, and the storefront
     * renders nothing rather than an empty "Packaging" heading - which would
     * read as "this is sold loose", a claim the catalogue has not made.
     */
    packaging: serialisePackaging(product.packagings[0]),

    tax: {
      code: product.taxClass.code,
      name: product.taxClass.name,
      /**
       * The destination's rate, not the tax class's own.
       *
       * These two are the same figure in every deployment that has not
       * configured EU VAT, and they diverge the moment one has: the class says
       * what band the product is in, the destination member state says what
       * that band costs. The storefront prints this beside the price, so it has
       * to be the rate that produced the price.
       */
      ratePercent: quote?.taxRatePercent ?? product.taxClass.ratePercent.toString(),
      inclusive: quote?.taxInclusive ?? product.taxClass.isInclusive,
      /** ISO country whose rate was applied, or null where none was. */
      country: shelf.setup.context.rateCountry,
      treatment: shelf.setup.context.treatment,
    },

    purchaseRules: {
      minOrderQty: product.minOrderQty,
      maxOrderQty: product.maxOrderQty,
      qtyIncrement: product.qtyIncrement,
      isRecurringEligible: isScheduleEligible(product),
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

    /**
     * The dimensions this product is chosen along, as template axis keys.
     *
     * An empty list is the ordinary case and means the storefront shows the
     * option list it has always shown - one row per variant, several
     * selectable at once. A non-empty list turns on the narrowing selector:
     * colour, then size, with combinations nobody stocks disabled.
     *
     * Only the keys. `/catalog/variant-axes` serves the labels, units and
     * orders once per session; repeating 112 templates' worth of definitions
     * on every product read would be the same payload over and over.
     */
    variantAxisKeys: Array.isArray(product.variantAxesJson)
      ? product.variantAxesJson.filter((entry): entry is string => typeof entry === 'string')
      : [],

    /**
     * Which of the 112 templates this product's shelf uses.
     *
     * The storefront looks the axis definitions up under this key, because a
     * `size` on a shoe and a `size` on a shirt are sorted differently and one
     * global definition of "size" would hang a shirt rail L, M, S, XL.
     *
     * Null for a category with no template - Medical Devices, and any shelf an
     * operator invented - which is the same thing an empty `variantAxisKeys`
     * says, and both mean "show the option list this catalogue has always
     * shown".
     */
    variantTemplateSlug:
      categorySlugPaths?.get(product.category.id) === undefined
        ? (findTemplate([product.category.slug])?.subcategorySlug ?? null)
        : (findTemplate(categorySlugPaths.get(product.category.id) ?? [])?.subcategorySlug ?? null),

    /**
     * Whether the product itself can be had now. Never how many there are.
     *
     * The answer for a product sold as a single item, and the fallback for one
     * whose options are listed the old way. Null means the question has no
     * answer - an untracked product, or a grid read that did not look stock up
     * - and every reader treats null as purchasable, because stock is confirmed
     * when the item goes in the basket.
     *
     * This is what lets the whole catalogue that was already on sale say "out
     * of stock" where it is true. Before it, the page could only say nothing.
     */
    isInStock: variantStock?.get(`${product.id}:${NO_VARIANT_KEY}`) ?? null,

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

      // Quoted through the same destination as the base price. A variant left
      // at its listed figure would jump when the shopper picked it, after the
      // page had already shown them a location-adjusted price for the product.
      const variantQuote =
        variantPrice === null
          ? null
          : quoteShelfPrice(shelf.setup, line, variantPrice.basePriceMinor);

      /**
       * The compare-at figure, quoted like every other price on this page.
       *
       * Through the same destination as the selling price beside it, because
       * two figures a shopper reads as "was" and "now" have to have been
       * worked out the same way. A "was" price left at its listed value beside
       * a VAT-adjusted "now" price is a saving that is not the saving.
       */
      const compareAtQuote =
        variant.compareAtPriceMinor === null
          ? null
          : quoteShelfPrice(shelf.setup, line, variant.compareAtPriceMinor);

      return {
        id: variant.id,
        sku: variant.sku,
        name: variant.name,
        options: variant.optionsJson,
        availableInCurrency: variantPrice !== null,
        price: variantQuote === null ? null : serialiseMoney(variantQuote.unitPriceMinor, currency),
        compareAtPrice:
          compareAtQuote === null ? null : serialiseMoney(compareAtQuote.unitPriceMinor, currency),
        // GPSR Art. 19(c) per sellable SKU. A barcode belongs to the thing in
        // the box, and two sizes are two boxes with two barcodes.
        gtin: variant.gtin,
        modelIdentifier: variant.modelIdentifier,

        /**
         * Whether this one can be had now. Never how many there are.
         *
         * Null means the question has no answer here - an untracked product,
         * or a listing read where stock was not looked up - and the selector
         * treats that as purchasable, because stock is confirmed when the item
         * goes in the basket, which is what actually happens.
         */
        isInStock: variantStock?.get(`${product.id}:${variant.id}`) ?? null,

        /**
         * This size's own terms of trade, or null where the family's apply.
         *
         * Null is not a missing value the storefront has to guess at: it means
         * "the figure shown against the product". The storefront falls back to
         * the product's rules, and the server enforces the same thing on every
         * cart mutation - so a client that ignored these could not buy on
         * different terms than a client that honoured them.
         */
        minOrderQty: variant.minOrderQty,
        qtyIncrement: variant.qtyIncrement,
        maxOrderQty: variant.maxOrderQty,
        leadTimeDays: variant.leadTimeDays,

        /**
         * What is in one purchasable unit.
         *
         * `multipackCount` is how many identical units are supplied together -
         * the 10 in "Pack of 10" - and it is NOT the quantity the buyer wants.
         * That is the cart line's, and the page states both separately so the
         * total on the delivery note is never a surprise.
         */
        multipackCount: variant.multipackCount,
        netContentValue: variant.netContentValue?.toString() ?? null,
        netContentUnit: variant.netContentUnit,
        unitPricingBaseValue: variant.unitPricingBaseValue?.toString() ?? null,
        unitPricingBaseUnit: variant.unitPricingBaseUnit,
        manufacturerPackLabel: variant.manufacturerPackLabel,

        /** This size's photographs. Empty means "show the family's". */
        images: variant.media.map((entry) => ({
          url: entry.media.url,
          altText: entry.media.altText,
          width: entry.media.width,
          height: entry.media.height,
          isPrimary: entry.isPrimary,
        })),

        // Present on the detail read, absent on a listing - see the select.
        // Falls back to the product-level row so a size whose packing was never
        // recorded separately still shows the product's.
        packaging: variantPackaging?.get(variant.id) ?? null,
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
    /*
     * One slug, or several separated by commas.
     *
     * The single-slug case is what a category page sends and is unchanged. The
     * several-slug case is what a curated shelf on the landing page sends -
     * "Technology & electronics" is three departments, and the alternative is
     * three requests whose results then have to be interleaved in the browser,
     * with three loading states and three ways to be half-empty.
     *
     * A slug that does not resolve is DROPPED rather than failing the query.
     * A curated shelf names departments the operator is free to rename or
     * retire, and one of them going away should narrow the shelf, not empty
     * it. Only a request where NOTHING resolved is an unknown category, which
     * keeps a stale single-category link behaving exactly as it did.
     */
    const slugs = [...new Set(query.category.split(',').map((part) => part.trim()))].filter(
      (part) => part.length > 0,
    );

    const resolved = (await Promise.all(slugs.map((slug) => findCategoryBySlug(slug)))).filter(
      (category): category is NonNullable<typeof category> => category !== null,
    );

    if (resolved.length === 0) return { productWhere, attributes, unknownCategory: true };

    // Include descendants, so browsing a parent shows everything beneath it.
    const subtrees = await Promise.all(
      resolved.map((category) => subtreeCategoryIds(category.id)),
    );

    productWhere.categoryId = { in: [...new Set(subtrees.flat())] };
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
        // A buyer working from a supplier's paperwork types the code or the
        // barcode off it, not the marketing name - and on a catalogue whose
        // sizes are separate variants, both of those live on the variant
        // rather than on the product. Without the variant half, searching for
        // the exact code printed on the box returns nothing.
        { gtin: { contains: query.q } },
        { modelIdentifier: { contains: query.q } },
        {
          variants: {
            some: {
              isActive: true,
              archivedAt: null,
              OR: [
                { sku: { contains: query.q } },
                { gtin: { contains: query.q } },
                { modelIdentifier: { contains: query.q } },
                { name: { contains: query.q } },
              ],
            },
          },
        },
        ...(translatedIds.length > 0 ? [{ id: { in: translatedIds } }] : []),
      ],
    });
  }

  // Size, as its own filter rather than as free text.
  //
  // Brand, sterility, sterilisation method and packing type are already
  // filterable through `attr=Name:Value` - the catalogue import writes them as
  // filterable specifications, so they appear in the facet panel without a
  // line of code here. Size cannot ride on that: a product attribute is unique
  // per name per product, and a listing with seven gauges has seven sizes.
  // They live on the variants, so they are filtered there.
  if (query.model !== undefined && query.model.length > 0) {
    conditions.push({
      OR: [
        { modelIdentifier: { contains: query.model } },
        {
          variants: {
            some: {
              isActive: true,
              archivedAt: null,
              modelIdentifier: { contains: query.model },
            },
          },
        },
      ],
    });
  }

  if (query.recurringOnly === 'true') {
    // Empty when every product qualifies, which narrows nothing - the filter
    // then returns the whole catalogue, because the whole catalogue is
    // repeatable. See scheduleEligibleWhere.
    conditions.push(scheduleEligibleWhere());
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
  shelf: ShelfContext,
  options: { applyBounds: boolean } = { applyBounds: true },
): Prisma.ProductPriceWhereInput {
  const bounded =
    options.applyBounds && (query.minPrice !== undefined || query.maxPrice !== undefined);

  // The bounds arrive in the shopper's terms - they were typed against the
  // prices on screen, which are quoted for their country. The column holds the
  // listed figure, so they are converted back before they meet it. Without
  // this, a shopper in Ireland caps the grid at 100 and gets back items the
  // same response then displays at 104.
  const toColumn = (amount: number): bigint => toListed(BigInt(amount), shelf.scale);

  /**
   * A product quoted per account has no figure to compare against.
   *
   * It still has a price ROW - the catalogue keeps one per SKU per currency so
   * this listing, which is rooted at that table, can reach it at all - and the
   * figure in it is zero. That zero is never shown and never charged: the
   * storefront renders "Request a quote" instead, and `assertPurchasable`
   * refuses the basket. But it is still a zero, so it must not answer a
   * question about price.
   *
   * Under a maximum of 1,000 it would sort in as the cheapest thing in the
   * catalogue; under "on offer" it would qualify against any compare-at at
   * all. Both are excluded wherever the shopper has asked a question the
   * product cannot answer - and only there, so an unfiltered grid still shows
   * everything the catalogue sells.
   */
  const excludeUnpriced = bounded || query.onSaleOnly === 'true' ? { isPriceOnRequest: false } : {};

  const narrowed: Prisma.ProductWhereInput = { ...productWhere, ...excludeUnpriced };

  return {
    currencyCode: currency,
    variantKey: NO_VARIANT_KEY,
    // Omitted when empty: the facet endpoint asks for the currency test alone,
    // and `product: {}` would join the table back for nothing.
    ...(Object.keys(narrowed).length > 0 ? { product: narrowed } : {}),
    ...(bounded
      ? {
          basePriceMinor: {
            ...(query.minPrice !== undefined ? { gte: toColumn(query.minPrice) } : {}),
            ...(query.maxPrice !== undefined ? { lte: toColumn(query.maxPrice) } : {}),
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

/**
 * One page of a seller's own catalogue.
 *
 * The same answer shape as the operator's grid, built from the seller's offers.
 * Three things are deliberately different, and each of them is the point of the
 * seller having a shop front at all:
 *
 *   - **Only what they sell.** A product the seller has no active offer for is
 *     not in their shop, however published it is in the operator's catalogue.
 *   - **Their price, everywhere.** The card, the sort and the price filter all
 *     read `seller_offers.priceMinor`.
 *   - **Their currency.** An offer is priced in one currency and is never
 *     converted: a figure invented at browse time is one the seller never
 *     agreed to and would be settled against something else.
 *
 * Variant "from" pricing is not attempted. A seller lists the options they
 * actually stock, which is often one of six, and a range built from the
 * operator's variant prices would quote sizes this seller does not sell.
 */
async function listSellerProducts(input: {
  sellerAccountId: string;
  query: z.infer<typeof listQuerySchema>;
  productWhere: Prisma.ProductWhereInput;
  currency: string;
  language: string | null;
  shelf: ShelfContext;
}): Promise<Record<string, unknown>> {
  const { sellerAccountId, query, productWhere, currency, language, shelf } = input;

  const bounded = query.minPrice !== undefined || query.maxPrice !== undefined;

  const where: Prisma.SellerOfferWhereInput = {
    sellerAccountId,
    status: 'ACTIVE',
    currency,
    // The offer is for the base product or for one option; either way the
    // product itself still has to be publicly visible, so an unpublished
    // product cannot be reached through a seller's shop.
    product: productWhere,
    ...(bounded
      ? {
          priceMinor: {
            ...(query.minPrice !== undefined
              ? { gte: toListed(BigInt(query.minPrice), shelf.scale) }
              : {}),
            ...(query.maxPrice !== undefined
              ? { lte: toListed(BigInt(query.maxPrice), shelf.scale) }
              : {}),
          },
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.sellerOffer.findMany({
      where,
      select: {
        priceMinor: true,
        compareAtPriceMinor: true,
        product: { select: publicProductSelect(language) },
      },
      orderBy: [...SELLER_SORT_ORDERS[query.sort]],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.sellerOffer.count({ where }),
  ]);

  return {
    products: rows.map((row) =>
      serialiseProduct(
        row.product,
        currency,
        { basePriceMinor: row.priceMinor, compareAtPriceMinor: row.compareAtPriceMinor },
        new Map(),
        shelf,
      ),
    ),
    currency,
    country: shelf.country,
    pagination: {
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    },
  };
}

export function registerPublicCatalogRoutes(app: FastifyInstance): Promise<void> {
  /**
   * The variant axis definitions, for the whole catalogue.
   *
   * Served rather than duplicated into the storefront, because it is the same
   * registry the admin panel's matrix builder and the server's own validation
   * read. Three copies of 112 templates is three copies that eventually
   * disagree about what "Size" means - which shows up as a facet that filters
   * one thing and a selector that offers another.
   *
   * KEYED BY SUBCATEGORY, not flattened into one map of axis key to
   * definition. The flat version is smaller and it is wrong: `size` is a
   * NUMERIC run on a shoe and a semantic one on a shirt, and one definition
   * for both hangs a shirt rail in the order L, M, S, XL. Any axis whose
   * meaning depends on the shelf it is on has to be served per shelf.
   *
   * One cacheable request per session for the whole shop. It never varies by
   * shopper, by currency or by language - the labels travel in English and the
   * storefront translates the ones it shows - so it is the same bytes for
   * everybody.
   *
   * No authentication and no personalisation: this is a description of the
   * shop's shelves, which is exactly as public as the shelves.
   */
  app.get('/variant-axes', async (_request, reply) => {
    const serialise = (candidate: VariantAxis) => ({
      key: candidate.key,
      label: candidate.label,
      input: candidate.input,
      display: candidate.display,
      sort: candidate.sort,
      units: candidate.units ?? null,
      dependsOn: candidate.dependsOn ?? [],
      inTitle: candidate.inTitle,
    });

    return reply.status(200).send({
      templates: Object.fromEntries(
        VARIANT_TEMPLATES.map((entry) => [
          entry.subcategorySlug ?? entry.categorySlug,
          { label: entry.label, axes: entry.axes.map(serialise) },
        ]),
      ),
    });
  });

  /** Storefront navigation. Inactive categories are excluded by default. */
  app.get('/categories', async (request, reply) => {
    // The category bar is on every page of the storefront, so it has to follow
    // the same language as the products beneath it.
    const { language } = detailQuerySchema.parse(request.query);
    const tree = await listCategoryTree({
      language: languageForRequest(language),
      // On a seller's shop front the counts describe their catalogue, not the
      // operator's — a sidebar promising 239 beside a grid of four is 235
      // links to a 404.
      sellerAccountId: request.storefront?.sellerAccountId ?? null,
    });
    return reply.status(200).send({ categories: tree });
  });

  /**
   * Look up one category by its web address name and return its name and
   * description. Hidden or archived categories answer "not found".
   */
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
    const shelf = await loadShelfContext(query.country);

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
        country: shelf.country,
        pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 },
      });
    }

    /*
     * On a seller's own shop front, the grid is THEIR catalogue.
     *
     * Rooted at their offers rather than at the operator's price rows, which is
     * what makes the filter, the sort and every figure on a card come from the
     * same place the shopper will be charged from. Restricting the operator's
     * grid and then overwriting the prices afterwards would leave the sort
     * ordering a seller's shelf by somebody else's numbers.
     */
    if (request.storefront !== null) {
      const result = await listSellerProducts({
        sellerAccountId: request.storefront.sellerAccountId,
        query,
        productWhere,
        currency,
        language,
        shelf,
      });

      return reply.status(200).send(result);
    }

    // Rooted at the price row for this currency, so the filter and the sort
    // both operate on the amount the shopper is actually shown.
    const where = priceWhereFor(query, currency, productWhere, shelf);

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
          shelf,
        ),
      ),
      currency,
      /** The destination these prices were quoted for. Null when none was given. */
      country: shelf.country,
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
    const shelf = await loadShelfContext(query.country);

    const { productWhere, unknownCategory } = await resolveFilters(query, language, {
      includeAttributes: false,
    });

    if (unknownCategory) {
      return reply.status(200).send({
        currency,
        country: shelf.country,
        priceRange: { min: null, max: null },
        attributes: [],
      });
    }

    const scopedProductWhere: Prisma.ProductWhereInput = {
      ...productWhere,
      // Sold in this currency and inside the price filter, or it is not in
      // the listing these facets describe. Two failures live here: a product
      // priced only in INR would otherwise put a Brand on a USD shopper's
      // panel that filters the grid down to nothing, and a count taken without
      // the price bounds would promise twelve results under a maximum of 1,000
      // that the grid then shows three of.
      prices: { some: priceWhereFor(query, currency, {}, shelf) },
    };

    const [range, facets] = await Promise.all([
      prisma.productPrice.aggregate({
        where: {
          ...priceWhereFor(query, currency, productWhere, shelf, { applyBounds: false }),
          // The range says what the catalogue costs, so the zero standing in
          // for "ask us" has no business in it - it would pull the minimum to
          // nothing and make the slider useless for every other product.
          product: { ...productWhere, isPriceOnRequest: false },
        },
        _min: { basePriceMinor: true },
        _max: { basePriceMinor: true },
      }),
      attributeFacetsFor(scopedProductWhere),
    ]);

    return reply.status(200).send({
      currency,
      country: shelf.country,
      // Forward into the shopper's terms, because the boxes this fills sit
      // beside the grid and are typed against the prices in it. The reverse of
      // what `priceWhereFor` does to the bounds on the way in.
      priceRange: {
        min:
          range._min.basePriceMinor === null
            ? null
            : serialiseMoney(toQuoted(range._min.basePriceMinor, shelf.scale), currency),
        max:
          range._max.basePriceMinor === null
            ? null
            : serialiseMoney(toQuoted(range._max.basePriceMinor, shelf.scale), currency),
      },
      attributes: facets,
    });
  });

  app.get('/products/:slug', async (request, reply) => {
    const { slug } = z.object({ slug: z.string().trim().max(255) }).parse(request.params);
    const query = detailQuerySchema.parse(request.query);
    const currency = await currencyForRequest(query.currency);
    const language = languageForRequest(query.language);
    const shelf = await loadShelfContext(query.country);

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

    /*
     * On a seller's shop front, their offer IS the product's price.
     *
     * And a product they do not offer is not in their shop at all, however
     * published it is in the operator's catalogue — 404, the same answer an
     * unpublished product gets, because a shopper must not be able to tell
     * "this seller does not stock it" from "no such product" by the status
     * code alone.
     */
    let sellerOffer: { basePriceMinor: bigint; compareAtPriceMinor: bigint | null } | null = null;

    /**
     * The terms the buyer will be stepped by, for the detail page's control.
     *
     * Loaded here and nowhere in the grid: the grid would need one query per
     * card for a figure it does not render, and the detail page is where
     * somebody actually chooses a quantity. Null on the operator's own
     * products, which are stepped by the carton.
     */
    let offerTerms: {
      /**
       * The offer's own id, so the page can read the packaging it is sold in.
       *
       * Added alongside the terms rather than fetched separately, on the same
       * reasoning `OFFER_SELL_TERMS` states: a caller that has the terms and
       * then goes looking for the id is a caller that can end up describing
       * one offer's packaging beside another offer's minimum.
       */
      id: string;
      minimumOrderQuantity: number;
      orderIncrement: number;
      maximumOrderQuantity: number | null;
    } | null = null;

    if (request.storefront !== null) {
      const offer = await prisma.sellerOffer.findFirst({
        where: {
          sellerAccountId: request.storefront.sellerAccountId,
          productId: product.id,
          status: 'ACTIVE',
          currency,
        },
        // Cheapest first, so a seller listing several options of one product
        // shows the "from" figure rather than whichever row came back first.
        orderBy: { priceMinor: 'asc' },
        select: {
          id: true,
          priceMinor: true,
          compareAtPriceMinor: true,
          minimumOrderQuantity: true,
          orderIncrement: true,
          maximumOrderQuantity: true,
        },
      });

      if (offer === null) throw notFound('Product');

      sellerOffer = {
        basePriceMinor: offer.priceMinor,
        compareAtPriceMinor: offer.compareAtPriceMinor,
      };
      offerTerms = offer;
    } else if (product.isMarketplaceProduct) {
      /*
       * Off the marketplace shop front, the buyer gets the cheapest live
       * offer - which is the one the cart will bind when they press Add. Its
       * terms are the ones that will be applied to them, so they are the ones
       * the control has to step by.
       */
      offerTerms = await cheapestOfferFor(prisma, product.id, '', currency);
    }

    const base = sellerOffer ?? prices.get(priceKey(product.id, null)) ?? null;

    // Per-size packing, which the listing deliberately does not carry. The
    // detail page is where somebody chooses a size and then works out how many
    // cartons that is, and the sizes do not always agree - one gauge boxed 100
    // to a carton and the next 50 is normal rather than exceptional.
    const variantPackaging = await variantPackagingFor(product.id);

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

    // The shelf this product sits on, and the shelves above it, so a variant
    // template can be resolved for a subcategory an operator created under one
    // of ours. One extra read, on the one page where a selector is drawn.
    const categorySlugPaths = await categorySlugPathsFor([product.category]);

    /*
     * Which sizes can be had right now - as booleans, on the one page that
     * needs them.
     *
     * The detail page is where somebody narrows to one thing and presses buy,
     * so it is where "this one exists but is empty" has to be sayable. A grid
     * does not draw a selector and does not pay for this read.
     *
     * Only for a stock-tracked product. An untracked one gets an empty map,
     * every variant answers null, and the selector treats null as purchasable
     * - which is correct, because "we do not count these" is not "there are
     * none of these".
     */
    const variantStock = new Map<string, boolean>();
    /*
     * Stock is a courtesy on this page, never a precondition for it.
     *
     * `getAvailabilityMap` resolves the default warehouse and REFUSES when a
     * deployment has not configured one - which is correct for a stock
     * movement and completely wrong here. Letting that refusal escape turned
     * every product page of a warehouse-less deployment into a 400: a shop
     * that had been selling perfectly well suddenly could not show a product.
     *
     * So the lookup is allowed to fail and the answer becomes "no answer",
     * which every reader already treats as purchasable. A page that cannot
     * find out whether something is in stock still has to render the product.
     */
    if (product.isMarketplaceProduct) {
      /*
       * A marketplace product's stock is the SELLERS' stock, not the
       * operator's.
       *
       * `InventoryBalance` is the operator's own warehouse ledger and it has
       * no row for anything a third-party seller listed - so asking it about
       * a seller's shirt returns zero, and the page says "out of stock" about
       * something with a hundred in a warehouse. The answer lives on the live
       * offers, denormalised onto `availableQuantity` by `refreshOfferTotals`
       * as stock moves.
       *
       * Grouped by `variantKey`, which is what makes a size run answerable:
       * black in medium can be sold out while black in large is not, and one
       * figure for the whole shirt cannot say that. `_sum` across sellers,
       * because two sellers each holding four is eight a buyer can have.
       */
      const offerStock = await prisma.sellerOffer.groupBy({
        by: ['variantKey'],
        where: { productId: product.id, status: 'ACTIVE', archivedAt: null },
        _sum: { availableQuantity: true },
      });

      const byVariantKey = new Map(
        offerStock.map((row) => [row.variantKey, row._sum.availableQuantity ?? 0]),
      );

      // The base answer is "can anything under this product be had", which is
      // what a card in a grid is asking. A product whose every offer is
      // against a variant has no '' row of its own.
      const anyInStock = [...byVariantKey.values()].some((quantity) => quantity > 0);
      variantStock.set(`${product.id}:${NO_VARIANT_KEY}`, anyInStock);

      for (const variant of product.variants) {
        variantStock.set(`${product.id}:${variant.id}`, (byVariantKey.get(variant.id) ?? 0) > 0);
      }
    } else if (product.isStockTracked) {
      try {
        /*
         * The base product AND every variant.
         *
         * The base row matters for the whole catalogue that existed before
         * variant axes did: a product sold as a single item, and a product whose
         * options are listed the old way, both get their answer from
         * `productId:''`. Publishing it only for template-driven products would
         * have left every listing already on sale exactly as silent as before.
         */
        const availability = await getAvailabilityMap([
          { productId: product.id, variantId: null },
          ...product.variants.map((variant) => ({ productId: product.id, variantId: variant.id })),
        ]);

        // A row with no balance at this warehouse has never been received into
        // it, which is zero rather than unknown - the row is written by the
        // first receipt.
        variantStock.set(
          `${product.id}:${NO_VARIANT_KEY}`,
          (availability.get(`${product.id}:${NO_VARIANT_KEY}`) ?? 0) > 0,
        );

        for (const variant of product.variants) {
          variantStock.set(
            `${product.id}:${variant.id}`,
            (availability.get(`${product.id}:${variant.id}`) ?? 0) > 0,
          );
        }
      } catch {
        // No default warehouse configured, so there is nothing to read. The
        // map stays empty, every SKU answers null, and the page renders.
        variantStock.clear();
      }
    }

    return reply.status(200).send({
      product: serialiseProduct(
        product,
        currency,
        base,
        prices,
        shelf,
        variantPackaging,
        offerTerms,
        categorySlugPaths,
        variantStock,
      ),
      currency,
      country: shelf.country,
      /**
       * Why this price is what it is, in a sentence.
       *
       * The product page is where somebody notices that the same box costs
       * more than it did before they switched country, and "19% German VAT
       * applies" is the difference between a trusted price and a suspected
       * one. Under FLAT_RATE this says no VAT country is configured, which is
       * true and which no storefront in that deployment renders.
       */
      taxNote: shelf.setup.context.reason,
      soldInCurrencies: soldIn,
      /**
       * The packages this seller will sell this in - carton, pallet, container.
       *
       * On the DETAIL page only, and deliberately not on the grid. A card has
       * no room for "2 UK pallets x 50 cartons x 24 units" and the grid draws
       * forty of them, which would be forty extra queries for a sentence
       * nobody can read at that size. This page has already resolved the one
       * offer the basket will bind, so it is one query for the page.
       *
       * EMPTY is the ordinary answer and always will be for most of the
       * catalogue: an offer with no packaging profile returns `[]`, and an
       * empty array is what makes the storefront draw its plain quantity box
       * with no packaging controls at all.
       *
       * Only ACTIVE, enabled options appear. A pallet the seller switched on
       * and has not finished describing is held out of the selector rather
       * than offered at a size nobody has stated - see
       * `PackagingOptionState.INCOMPLETE`.
       */
      packagingOptions:
        offerTerms === null ? [] : await listBuyableOptions(offerTerms.id),
    });
  });

  // --- Verified product cards ----------------------------------------------

  /**
   * Resolve a handful of product references into verified catalogue rows.
   *
   * This exists because of what AI Mode renders. The assistant is grounded in
   * a snapshot of this catalogue and it ends an answer about specific products
   * with a reference line of slugs. Those references are the ONLY thing the
   * storefront takes from the model: it never renders a name, a price, a stock
   * figure or - above all - an image URL that arrived in generated text. It
   * brings the references here, and what is drawn on the card is what this
   * route says, read from the database under the same `publicProductWhere()`
   * every other storefront read uses.
   *
   * So a model that invents a product code produces no card at all rather than
   * a plausible-looking one. On a catalogue of cannulae and feeding tubes that
   * distinction is the whole feature: an invented SKU is somebody ordering the
   * wrong device.
   *
   * References may be slugs, product codes, or a variant's product code -
   * those are the three identifiers the snapshot puts in front of the model,
   * and it quotes whichever the customer used. Anything unresolved is named in
   * `unresolved` rather than silently dropped, so the caller can say "one of
   * these is no longer listed" instead of quietly showing fewer cards than the
   * answer mentioned.
   *
   * Public, like the rest of this file, and capped at twelve references: it is
   * one indexed read, but it is also a route anybody can call.
   */
  app.get('/product-cards', async (request, reply) => {
    const query = cardQuerySchema.parse(request.query);
    const currency = await currencyForRequest(query.currency);
    const language = languageForRequest(query.language);
    const shelf = await loadShelfContext(query.country);

    // De-duplicated but order-preserving: the assistant lists its references
    // most relevant first, and that order is the recommendation.
    const refs = [
      ...new Set(
        query.refs
          .split(',')
          .map((ref) => ref.trim())
          .filter((ref) => ref.length > 0 && ref.length <= 255),
      ),
    ].slice(0, MAX_PRODUCT_CARDS);

    if (refs.length === 0) {
      return reply
        .status(200)
        .send({ products: [], unresolved: [], currency, country: shelf.country });
    }

    const products = await prisma.product.findMany({
      where: {
        ...publicProductWhere(),
        OR: [
          { slug: { in: refs } },
          { sku: { in: refs } },
          // A model asked for "the 22G one" answers with the variant's own
          // product code, which is what the snapshot showed it.
          { variants: { some: { sku: { in: refs }, isActive: true, archivedAt: null } } },
        ],
      },
      select: publicProductSelect(language),
      take: MAX_PRODUCT_CARDS,
    });

    const prices = await loadPricesForCurrency(
      products.flatMap((product) => [
        { productId: product.id, variantId: null },
        ...product.variants.map((variant) => ({ productId: product.id, variantId: variant.id })),
      ]),
      currency,
    );

    /*
     * How many of each there are to sell.
     *
     * The card says whether it can be had now, and it has to be able to say
     * the right thing: a card promising availability the cart then refuses has
     * cost the buyer a click and some trust. An untracked product reports
     * `null`, which means "we do not count these" and not "there are none" -
     * the card renders no stock line for those rather than an alarming zero.
     */
    const availability = await getAvailabilityMap(
      products
        .filter((product) => product.isStockTracked)
        .map((product) => ({ productId: product.id, variantId: null })),
    );

    const lowered = refs.map((ref) => ref.toLowerCase());

    /** Which reference found this product, so the caller can keep its order. */
    const refFor = (product: (typeof products)[number]): string | null => {
      const candidates = [
        product.slug.toLowerCase(),
        product.sku.toLowerCase(),
        ...product.variants.map((variant) => variant.sku.toLowerCase()),
      ];

      let best: number | null = null;
      for (const candidate of candidates) {
        const at = lowered.indexOf(candidate);
        if (at !== -1 && (best === null || at < best)) best = at;
      }

      return best === null ? null : (refs[best] ?? null);
    };

    const rank = (ref: string | null): number => (ref === null ? refs.length : refs.indexOf(ref));

    const cards = products
      .map((product) => {
        const base = prices.get(priceKey(product.id, null)) ?? null;
        const available = availability.get(`${product.id}:${NO_VARIANT_KEY}`) ?? 0;

        return {
          matchedRef: refFor(product),
          ...serialiseProduct(product, currency, base, prices, shelf),
          availability: product.isStockTracked
            ? { isStockTracked: true, inStock: available > 0, availableQty: available }
            : { isStockTracked: false, inStock: true, availableQty: null },
        };
      })
      .sort((a, b) => rank(a.matchedRef) - rank(b.matchedRef));

    const matched = new Set(cards.map((card) => card.matchedRef));

    return reply.status(200).send({
      products: cards,
      /** Named, not dropped: the caller owes the reader an honest count. */
      unresolved: refs.filter((ref) => !matched.has(ref)),
      currency,
      country: shelf.country,
    });
  });

  // --- Image search --------------------------------------------------------

  /**
   * Find products from a photograph.
   *
   * The one authenticated route in this file, and the exception is deliberate.
   * Everything else here is a database read that costs the deployment a few
   * milliseconds; this one spends the operator's AI provider budget on every
   * call. Leaving it open would mean any script on the internet could bill a
   * self-hosted deployment for as many vision calls as it cared to make, which
   * is the same reasoning that put `/assistant/*` behind the session guard —
   * see the header of `assistant.public.ts`. Guests still browse, search and
   * filter the whole catalogue; what they cannot do is spend somebody's money.
   *
   * Rate limited well below the chat endpoint on top of that: a vision call is
   * the most expensive single request this API makes, and nobody legitimately
   * photographs ten products a minute.
   *
   * The upload is handled exactly as the admin media upload is. The client's
   * `Content-Type` and filename are both ignored: the real type comes from the
   * magic bytes, so neither a spoofed MIME type nor a `.jpg` that is really an
   * SVG has anywhere to go.
   *
   * The bytes are never stored. They go to the provider and are dropped when
   * the request ends — a photograph taken inside a hospital store room is not
   * something this system should be holding on to, and there is nothing to be
   * gained by keeping it.
   */
  app.post(
    '/image-search',
    {
      preHandler: requireCustomer,
      config: { rateLimit: { max: 12, timeWindow: '5 minutes' } },
    },
    async (request, reply) => {
      // 404 rather than 403 on a deployment with no AI key, matching the
      // assistant routes: the endpoint does not meaningfully exist, and that
      // is how the storefront learns not to render the camera button.
      if (!isAssistantConfigured()) throw notFound('Image search');

      const query = detailQuerySchema.parse(request.query);
      const currency = await currencyForRequest(query.currency);
      const language = languageForRequest(query.language);
      const shelf = await loadShelfContext(query.country);

      const upload = await request.file();
      if (upload === undefined) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'No image was uploaded.', [
          { field: 'image', code: 'REQUIRED' },
        ]);
      }

      const buffer = await upload.toBuffer();
      assertWithinSizeLimit(buffer.byteLength);
      const sniffed = sniffImageType(buffer);

      /*
       * The customer is watching a spinner over their own photograph. If they
       * navigate away, stop paying for the answer.
       *
       * `reply.raw`, not `request.raw`, and the difference is not cosmetic —
       * it is a bug that aborts every single request. An `IncomingMessage`
       * emits `close` when the request stream is finished, and `toBuffer()`
       * above finishes it: listening there cancels the provider call the
       * instant the upload has been read, every time, and the only symptom is
       * a 500 with `This operation was aborted` in the log.
       *
       * The `ServerResponse` emits `close` when the socket goes, which is the
       * event actually being asked about. It also emits it after a normal
       * reply, hence the `writableEnded` guard — by then the await has
       * resolved and aborting would be a no-op, but a signal that fires on
       * success is a trap for the next person reading this.
       */
      const abort = new AbortController();
      reply.raw.on('close', () => {
        if (!reply.raw.writableEnded) abort.abort();
      });

      let analysis;
      try {
        analysis = await analyseProductImage(
          { data: buffer, mimeType: sniffed.mimeType },
          { signal: abort.signal },
        );
      } catch (error) {
        if (error instanceof AssistantBusyError) {
          // The provider's own wording names quota metrics and internal
          // detail, so it is logged in full and never sent: "out of quota" and
          // "briefly overloaded" need different actions from the operator.
          request.log.error({ err: error }, 'image search provider unavailable');
          throw new AppError({
            statusCode: 503,
            code: ErrorCode.IMAGE_SEARCH_BUSY,
            message: 'Image search is busy right now. Please try again in a moment.',
          });
        }

        if (error instanceof ImageSearchUnreadableError) {
          request.log.warn('image search reply could not be parsed');
          throw new AppError({
            statusCode: 502,
            code: ErrorCode.IMAGE_SEARCH_UNREADABLE,
            message:
              'Image search could not read that photograph. Try a clearer one, or search by name.',
          });
        }

        throw error;
      }

      // Counts and identifiers only. Not the image, not the description, and
      // nothing about who uploaded it — the same rule the chat route follows.
      request.log.info(
        {
          model: analysis.model,
          inputTokens: analysis.inputTokens,
          outputTokens: analysis.outputTokens,
          matches: analysis.slugs.length,
          imageBytes: buffer.byteLength,
        },
        'image search',
      );

      if (analysis.slugs.length === 0) {
        return reply.status(200).send({
          description: analysis.description,
          terms: analysis.terms,
          products: [],
          currency,
          country: shelf.country,
        });
      }

      // Priced through exactly the same path as the grid, so a card that came
      // from a photograph and the same card in the catalogue cannot quote two
      // different numbers.
      const products = await prisma.product.findMany({
        where: { ...publicProductWhere(), slug: { in: analysis.slugs } },
        select: publicProductSelect(language),
      });

      const prices = await loadPricesForCurrency(
        products.flatMap((product) => [
          { productId: product.id, variantId: null },
          ...product.variants.map((variant) => ({
            productId: product.id,
            variantId: variant.id,
          })),
        ]),
        currency,
      );

      /*
       * Back into the model's order, best match first.
       *
       * `findMany` returns whatever the index gives it, and re-sorting by the
       * model's ranking is the whole value of having asked for a ranking. A
       * product with no price row in this currency is not sold in it and is
       * dropped, the same as it would be from the grid — showing a card with
       * no price is worse than showing one card fewer.
       */
      const bySlug = new Map(products.map((product) => [product.slug, product]));

      const ordered = analysis.slugs
        .map((slug) => bySlug.get(slug))
        .filter((product): product is (typeof products)[number] => product !== undefined)
        .map((product) => ({
          product,
          price: prices.get(priceKey(product.id, null)) ?? null,
        }))
        .filter((entry) => entry.price !== null);

      return reply.status(200).send({
        /**
         * What the picture was understood to be.
         *
         * Shown to the customer beside the results, and not decoration: this
         * match is on what the model recognises the item as, so a misreading
         * has to be visible as a misreading rather than looking like a
         * catalogue full of the wrong stock.
         */
        description: analysis.description,
        terms: analysis.terms,
        products: ordered.map((entry) =>
          serialiseProduct(entry.product, currency, entry.price, prices, shelf),
        ),
        currency,
        country: shelf.country,
      });
    },
  );

  return Promise.resolve();
}
