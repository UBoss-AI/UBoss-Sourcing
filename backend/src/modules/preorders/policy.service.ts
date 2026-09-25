/**
 * Preorder policies: the seller's terms, and whether a product is open for
 * preorder at all.
 *
 * `evaluateEligibility` is the one answer to "can this be preordered, and on
 * what terms?". The product page's button, the form behind it, the preview and
 * the submission all ask it, so a button that says a product is open cannot
 * lead to a form that refuses it for a reason the button did not know.
 */
import type { QuantityTier } from '../../domain/quantity-tier.js';
import { TIER_SELECT, toQuantityTier } from '../catalog/quantity-tier.service.js';
import { storeTiersFor } from '../catalog/store-discount.service.js';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  POLICY_MOQ_UNITS,
  PREORDER_UNITS,
  orderableUnits,
  preorderDeliveryWindow,
  quantityRulesFor,
  resolvePolicy,
  type DeliveryWindow,
  type IneligibleReason,
  type PolicyIssue,
  type PolicyTerms,
  type PreorderScope,
  type PreorderUnit,
  type QuantityRules,
  type UnitSizes,
} from '../../domain/preorder.js';
import { resolveTimezone } from '../../domain/delivery-dates.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { SellerMembership } from '../seller/account.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';
import { getAvailabilityMap } from '../inventory/inventory.service.js';
import { listBuyableOptions } from '../seller/packaging.service.js';
import {
  containerOptionsForOffer,
  type ContainerOption,
} from '../seller/container-loading.service.js';
import { CONTAINER_SIZES } from '../../domain/container-loading.js';

// ---------------------------------------------------------------------------
// Reading a policy
// ---------------------------------------------------------------------------

type PolicyRow = Awaited<ReturnType<typeof loadPolicyRows>>[number];

async function loadPolicyRows(sellerAccountId: string, offerId: string, productId: string) {
  return prisma.preorderPolicy.findMany({
    where: {
      sellerAccountId,
      OR: [
        { scope: 'OFFER', scopeKey: offerId },
        { scope: 'PRODUCT', scopeKey: productId },
        { scope: 'SELLER_DEFAULT', scopeKey: '' },
      ],
    },
    include: { tiers: { orderBy: { minBaseUnits: 'asc' } } },
  });
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function toPolicyTerms(row: PolicyRow): PolicyTerms {
  const packaging = Array.isArray(row.packagingTypesJson)
    ? stringList(row.packagingTypesJson).filter((unit): unit is PreorderUnit =>
        (PREORDER_UNITS as readonly string[]).includes(unit),
      )
    : null;

  return {
    id: row.id,
    scope: row.scope,
    version: row.version,
    isEnabled: row.isEnabled,
    moqUnit: row.moqUnit,
    moqQuantity: row.moqQuantity,
    incrementQuantity: row.incrementQuantity,
    maxQuantity: row.maxQuantity,
    capacityBaseUnits: row.capacityBaseUnits,
    capacityPeriod: row.capacityPeriod,
    safetyStockBaseUnits: row.safetyStockBaseUnits,
    minLeadTimeDays: row.minLeadTimeDays,
    maxAdvanceDays: row.maxAdvanceDays,
    deliveryCountries: stringList(row.deliveryCountriesJson),
    eligibleLocationIds: stringList(row.eligibleLocationIdsJson),
    packagingTypes: packaging,
    pricingMode: row.pricingMode,
    allowPartialFulfilment: row.allowPartialFulfilment,
    allowSplitDelivery: row.allowSplitDelivery,
    requestExpiryHours: row.requestExpiryHours,
    offerExpiryHours: row.offerExpiryHours,
    cancellationTerms: row.cancellationTerms,
    specialInstructions: row.specialInstructions,
    tiers: row.tiers.map((tier) => ({
      minBaseUnits: tier.minBaseUnits,
      unitPriceMinor: tier.unitPriceMinor,
      currency: tier.currency,
    })),
  };
}

/** The JSON a policy is frozen onto a request as. Money as strings. */
export function serialisePolicyTerms(policy: PolicyTerms): Record<string, unknown> {
  return {
    ...policy,
    tiers: policy.tiers.map((tier) => ({
      minBaseUnits: tier.minBaseUnits,
      unitPriceMinor: tier.unitPriceMinor.toString(),
      currency: tier.currency,
    })),
  };
}

/**
 * Pieces per carton, pallet and container, from the offer's ACTIVE packaging,
 * and per 20-ft and 40-ft container from its VERIFIED container loading.
 *
 * A container size the seller has not verified is simply absent - the same
 * rule as an incomplete pallet - so nothing downstream can price, check or
 * convert a quantity against a figure nobody stands behind.
 */
export async function unitSizesForOffer(offerId: string): Promise<UnitSizes> {
  const [options, containers] = await Promise.all([
    listBuyableOptions(offerId),
    containerOptionsForOffer(offerId),
  ]);
  const sizes: UnitSizes = { PIECE: 1 };
  for (const option of options) sizes[option.packageType] = option.unitsPerPackage;
  for (const option of containers.options) {
    if (option.available && option.piecesPerContainer !== null) {
      sizes[option.unit] = option.piecesPerContainer;
    }
  }
  return sizes;
}

/** Every container size, unavailable, for a product no seller loads. */
function noContainerOptions(): ContainerOption[] {
  return CONTAINER_SIZES.map((unit) => ({
    unit,
    available: false,
    piecesPerContainer: null,
    cartonsPerContainer: null,
    piecesPerCarton: null,
    verifiedAt: null,
    reason: 'NOT_CONFIGURED',
  }));
}

/**
 * Handling plus published transit to a country, in calendar days.
 *
 * The seller's own figures and nothing else: the offer's handling time, the
 * slowest packaging handling time, and for each delivery level the slowest
 * PUBLISHED transit to that country (or a worldwide flat rate). A level with
 * no published transit contributes nothing, and `hasPublishedTransit` says
 * so, so the form can tell the buyer the date is subject to the seller's
 * confirmation rather than pretending a route was measured.
 */
export async function routeLeadDays(input: {
  /** Null for the operator's own product: no seller routes to read. */
  sellerAccountId: string | null;
  offerHandlingDays: number | null;
  destinationCountry: string | null;
}): Promise<{ days: number; hasPublishedTransit: boolean }> {
  const handling = Math.max(0, input.offerHandlingDays ?? 0);
  if (input.destinationCountry === null || input.sellerAccountId === null) {
    return { days: handling, hasPublishedTransit: false };
  }

  const rates = await prisma.logisticsLevelRate.findMany({
    where: {
      sellerAccountId: input.sellerAccountId,
      status: 'PUBLISHED',
      OR: [
        { destinationCountry: input.destinationCountry },
        { isWorldwideFlat: true },
        { level: 'L1' },
      ],
    },
    select: { level: true, transitDaysMax: true, transitDaysMin: true },
  });

  const slowest = new Map<string, number>();
  for (const rate of rates) {
    const days = rate.transitDaysMax ?? rate.transitDaysMin;
    if (days === null) continue;
    slowest.set(rate.level, Math.max(slowest.get(rate.level) ?? 0, days));
  }

  const transit = [...slowest.values()].reduce((sum, days) => sum + days, 0);
  return { days: handling + transit, hasPublishedTransit: slowest.size > 0 };
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

export interface EligibilityOffer {
  /**
   * The seller's offer, or null for the operator's own product - which has no
   * offer, and whose preorders the operator's staff answer.
   */
  id: string | null;
  sellerAccountId: string | null;
  productId: string;
  variantId: string | null;
  variantKey: string;
  status: string;
  priceMinor: bigint;
  currency: string;
  handlingTimeDays: number | null;
  availableQuantity: number;
  sellerDisplayName: string;
  sellerStatus: string;
  sellingRegions: string[];
  /** The offer's quantity bands. A preorder is priced from them too. */
  quantityTiers: QuantityTier[];
}

export type Eligibility =
  | {
      available: true;
      offer: EligibilityOffer;
      policy: PolicyTerms;
      rules: QuantityRules;
      units: PreorderUnit[];
      sizes: UnitSizes;
      /** 20-ft and 40-ft, each available or not with a reason. */
      containerOptions: ContainerOption[];
      window: DeliveryWindow;
      timezone: string;
      hasPublishedTransit: boolean;
      deliveryCountries: string[];
    }
  | {
      available: false;
      reason: IneligibleReason;
      message: string;
      issues: PolicyIssue[];
      offer: EligibilityOffer | null;
    };

const OFFER_SELECT = {
  id: true,
  sellerAccountId: true,
  productId: true,
  variantId: true,
  variantKey: true,
  status: true,
  priceMinor: true,
  currency: true,
  handlingTimeDays: true,
  availableQuantity: true,
  minimumOrderQuantity: true,
  orderIncrement: true,
  sellingRegionsJson: true,
  archivedAt: true,
  priceTiers: { select: TIER_SELECT },
  sellerAccount: { select: { displayName: true, status: true } },
  variant: { select: { isActive: true, archivedAt: true } },
  product: {
    select: {
      status: true,
      isPublished: true,
      archivedAt: true,
      isMarketplaceProduct: true,
    },
  },
} as const;

/**
 * Which offer a preorder for this product would be placed against.
 *
 * The one named, where one is - the product page passes the offer it is
 * showing. Otherwise the cheapest ACTIVE one, which is the one the product page
 * shows and the cart binds; asking the same question two ways would let the
 * button and the form describe two different sellers.
 */
async function findOffer(productId: string, variantKey: string, offerId: string | null) {
  if (offerId !== null) {
    const offer = await prisma.sellerOffer.findUnique({
      where: { id: offerId },
      select: OFFER_SELECT,
    });
    if (offer === null || offer.productId !== productId || offer.variantKey !== variantKey)
      return null;
    return offer;
  }

  return prisma.sellerOffer.findFirst({
    where: { productId, variantKey, status: 'ACTIVE', archivedAt: null },
    orderBy: [{ priceMinor: 'asc' }, { createdAt: 'asc' }],
    select: OFFER_SELECT,
  });
}

const MESSAGES: Readonly<Record<IneligibleReason, string>> = Object.freeze({
  NOT_MARKETPLACE: 'Bulk preorder configuration is not currently available for this product.',
  NOT_CONFIGURED: 'Bulk preorder configuration is not currently available for this product.',
  DISABLED: 'The seller does not take preorders for this product.',
  INCOMPLETE: 'Bulk preorder configuration is not currently available for this product.',
  OFFER_INACTIVE: 'This product is not currently on sale.',
  VARIANT_INACTIVE: 'This option is not currently on sale.',
  SELLER_SUSPENDED: 'This seller is not currently trading.',
});

/**
 * The terms a product gets when nobody configured any.
 *
 * Deliberately modest, because nobody chose them: the buyer's minimum is the
 * deployment's bulk minimum (`PREORDER_DEFAULT_MOQ`, 1,000 pieces unless the
 * operator changed it) or the listing's own ordering minimum where that is
 * higher, there is no capacity limit to promise against, and the price shown is the list price (or the quantity band, when
 * lower) - indicative only, as one band starting at the minimum. A product
 * with no price is "quote required". Every request still goes to the supplier
 * to accept, counter or refuse, and the supplier sets the final price and date.
 */
export function platformDefaultPolicy(input: {
  minimum: number | null;
  increment: number | null;
  listPriceMinor: bigint;
  currency: string;
  /** The deployment's bulk minimum in pieces. `PREORDER_DEFAULT_MOQ` unless a test says otherwise. */
  defaultMinimum?: number;
}): PolicyTerms {
  const increment = Math.max(1, input.increment ?? 1);
  const minimum = defaultMinimumOnGrid(
    Math.max(1, input.minimum ?? 1),
    increment,
    input.defaultMinimum ?? env.PREORDER_DEFAULT_MOQ,
  );
  const priced = input.listPriceMinor > 0n;
  return {
    id: '',
    scope: 'PLATFORM_DEFAULT',
    version: 0,
    isEnabled: true,
    moqUnit: 'PIECE',
    moqQuantity: minimum,
    incrementQuantity: increment,
    maxQuantity: null,
    capacityBaseUnits: null,
    capacityPeriod: 'WEEK',
    safetyStockBaseUnits: 0,
    minLeadTimeDays: env.PREORDER_DEFAULT_LEAD_DAYS,
    maxAdvanceDays: env.PREORDER_DEFAULT_MAX_ADVANCE_DAYS,
    deliveryCountries: [],
    eligibleLocationIds: [],
    packagingTypes: null,
    pricingMode: priced ? 'FIXED' : 'QUOTE_REQUIRED',
    allowPartialFulfilment: false,
    allowSplitDelivery: true,
    requestExpiryHours: null,
    offerExpiryHours: null,
    cancellationTerms: null,
    specialInstructions: null,
    tiers: priced
      ? [{ minBaseUnits: minimum, unitPriceMinor: input.listPriceMinor, currency: input.currency }]
      : [],
  };
}

/**
 * The platform minimum, raised onto the listing's own steps.
 *
 * A listing sold in cartons of 48 cannot be bought as exactly 1,000 pieces, so
 * its minimum becomes 1,008 - the first quantity at or above the deployment's
 * figure that the listing's own step can reach. A listing whose minimum is
 * already higher keeps it: the platform figure is a floor, never a cap.
 */
export function defaultMinimumOnGrid(
  listingMinimum: number,
  increment: number,
  platformMinimum: number,
): number {
  if (listingMinimum >= platformMinimum) return listingMinimum;
  const step = Math.max(1, increment);
  return listingMinimum + Math.ceil((platformMinimum - listingMinimum) / step) * step;
}

/** What one piece of the operator's own product costs, and how many are on hand. */
async function operatorEligibility(input: {
  productId: string;
  variantId: string | null;
  destinationCountry?: string | null;
  timezone?: string | null;
  now?: Date;
}): Promise<Eligibility> {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: input.productId },
    select: {
      id: true,
      status: true,
      isPublished: true,
      archivedAt: true,
      basePriceMinor: true,
      currency: true,
      piecesPerCarton: true,
      minOrderQty: true,
      qtyIncrement: true,
      isStockTracked: true,
    },
  });
  const variant =
    input.variantId === null
      ? null
      : await prisma.productVariant.findUnique({
          where: { id: input.variantId },
          select: { id: true, productId: true, isActive: true, archivedAt: true, priceMinor: true },
        });
  const business = await prisma.businessProfile.findFirst({ select: { displayName: true } });

  let available = 0;
  if (product.isStockTracked) {
    try {
      const map = await getAvailabilityMap([{ productId: product.id, variantId: input.variantId }]);
      available = Math.max(0, [...map.values()][0] ?? 0);
    } catch {
      // No default warehouse configured: nothing is on hand to promise.
      available = 0;
    }
  }

  const operatorPriceMinor = variant?.priceMinor ?? product.basePriceMinor;
  const offer: EligibilityOffer = {
    id: null,
    sellerAccountId: null,
    productId: product.id,
    variantId: variant?.id ?? null,
    variantKey: variant?.id ?? '',
    status: 'ACTIVE',
    priceMinor: operatorPriceMinor,
    currency: product.currency,
    handlingTimeDays: null,
    availableQuantity: available,
    sellerDisplayName: business?.displayName ?? 'The store',
    sellerStatus: 'APPROVED',
    sellingRegions: [],
    // The operator's own product is banded by the store-wide quantity
    // discounts, if the operator runs any. See `StoreQuantityDiscount`.
    quantityTiers: await storeTiersFor(operatorPriceMinor),
  };

  if (product.status !== 'ACTIVE' || !product.isPublished || product.archivedAt !== null) {
    return refuse('OFFER_INACTIVE', offer);
  }
  if (
    variant !== null &&
    (variant.productId !== product.id || !variant.isActive || variant.archivedAt !== null)
  ) {
    return refuse('VARIANT_INACTIVE', offer);
  }

  // The operator sells by its own carton where the product has one.
  const perCarton = product.piecesPerCarton ?? 1;
  const minimumPieces = Math.max(1, product.minOrderQty) * Math.max(1, perCarton);
  const policy = platformDefaultPolicy({
    minimum: minimumPieces,
    increment: Math.max(1, product.qtyIncrement) * Math.max(1, perCarton),
    listPriceMinor: offer.priceMinor,
    currency: offer.currency,
  });
  const sizes: UnitSizes = perCarton > 1 ? { PIECE: 1, CARTON: perCarton } : { PIECE: 1 };
  const quantity = quantityRulesFor(policy, sizes);
  if (quantity.rules === null) return refuse('INCOMPLETE', offer, quantity.issues);

  const timezone = resolveTimezone(input.timezone ?? null);
  const window = preorderDeliveryWindow({
    timezone,
    minNoticeDays: Math.max(env.PREORDER_MIN_NOTICE_DAYS, env.SCHEDULE_MIN_NOTICE_DAYS),
    productionLeadDays: policy.minLeadTimeDays,
    routeLeadDays: 0,
    maxAdvanceDays: policy.maxAdvanceDays,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  return {
    available: true,
    offer,
    policy,
    rules: quantity.rules,
    units: orderableUnits(policy, sizes),
    sizes,
    // The operator's own product has no seller to load a container, so
    // container ordering is unavailable and says so.
    containerOptions: noContainerOptions(),
    window,
    timezone,
    hasPublishedTransit: false,
    deliveryCountries: [],
  };
}

function refuse(
  reason: IneligibleReason,
  offer: EligibilityOffer | null,
  issues: PolicyIssue[] = [],
): Eligibility {
  return { available: false, reason, message: MESSAGES[reason], issues, offer };
}

/**
 * Can this product be preordered, and on what terms?
 *
 * `destinationCountry` and `timezone` come from the buyer's chosen address
 * where there is one; without them the window is computed on the buyer's
 * zone with no route lead, and the form recomputes it when an address is
 * chosen.
 */
export async function evaluateEligibility(input: {
  productId: string;
  variantId: string | null;
  offerId?: string | null;
  destinationCountry?: string | null;
  timezone?: string | null;
  now?: Date;
}): Promise<Eligibility> {
  const variantKey = input.variantId ?? '';
  const row = await findOffer(input.productId, variantKey, input.offerId ?? null);

  if (row === null) {
    const product = await prisma.product.findUnique({
      where: { id: input.productId },
      select: { isMarketplaceProduct: true },
    });
    if (product === null) throw notFound('Product');
    if (product.isMarketplaceProduct) return refuse('OFFER_INACTIVE', null);
    // The operator's own product: preorderable when the deployment opens
    // preorders to every product, answered by the operator's staff.
    if (!env.PREORDER_OPEN_TO_ALL) return refuse('NOT_MARKETPLACE', null);
    return operatorEligibility(input);
  }

  const offer: EligibilityOffer = {
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    productId: row.productId,
    variantId: row.variantId,
    variantKey: row.variantKey,
    status: row.status,
    priceMinor: row.priceMinor,
    currency: row.currency,
    handlingTimeDays: row.handlingTimeDays,
    availableQuantity: row.availableQuantity,
    sellerDisplayName: row.sellerAccount.displayName,
    sellerStatus: row.sellerAccount.status,
    sellingRegions: stringList(row.sellingRegionsJson),
    quantityTiers: row.priceTiers.map(toQuantityTier),
  };

  if (row.sellerAccount.status !== 'APPROVED') return refuse('SELLER_SUSPENDED', offer);

  const productLive =
    row.product.status === 'ACTIVE' && row.product.isPublished && row.product.archivedAt === null;
  if (!productLive || row.status !== 'ACTIVE' || row.archivedAt !== null) {
    return refuse('OFFER_INACTIVE', offer);
  }

  if (row.variant !== null && (!row.variant.isActive || row.variant.archivedAt !== null)) {
    return refuse('VARIANT_INACTIVE', offer);
  }

  const policyRow = resolvePolicy(await loadPolicyRows(row.sellerAccountId, row.id, row.productId));
  // Nobody configured terms: the platform default, when preorders are open
  // to every product. A seller who switched preorders OFF has a policy row
  // with isEnabled false, and that stays off below.
  if (policyRow === null && !env.PREORDER_OPEN_TO_ALL) return refuse('NOT_CONFIGURED', offer);

  const policy =
    policyRow === null
      ? platformDefaultPolicy({
          minimum: row.minimumOrderQuantity,
          increment: row.orderIncrement,
          listPriceMinor: row.priceMinor,
          currency: row.currency,
        })
      : toPolicyTerms(policyRow);
  if (!policy.isEnabled) return refuse('DISABLED', offer);

  const sizes = await unitSizesForOffer(row.id);
  const quantity = quantityRulesFor(policy, sizes);
  if (quantity.rules === null) return refuse('INCOMPLETE', offer, quantity.issues);

  const units = orderableUnits(policy, sizes);
  const { options: loadedContainers } = await containerOptionsForOffer(row.id);
  // A verified size the seller's terms do not permit is unavailable too, and
  // says why rather than quietly vanishing.
  const containerOptions = loadedContainers.map((option) =>
    option.available && !units.includes(option.unit)
      ? {
          ...option,
          available: false,
          piecesPerContainer: null,
          cartonsPerContainer: null,
          piecesPerCarton: null,
          verifiedAt: null,
          reason: 'NOT_OFFERED' as const,
        }
      : option,
  );
  if (units.length === 0) {
    return refuse('INCOMPLETE', offer, [
      {
        field: 'packagingTypes',
        message: 'None of the permitted packaging is active on this product.',
      },
    ]);
  }

  const timezone = resolveTimezone(input.timezone ?? null);
  const route = await routeLeadDays({
    sellerAccountId: row.sellerAccountId,
    offerHandlingDays: row.handlingTimeDays,
    destinationCountry: input.destinationCountry ?? null,
  });

  const window = preorderDeliveryWindow({
    timezone,
    minNoticeDays: Math.max(env.PREORDER_MIN_NOTICE_DAYS, env.SCHEDULE_MIN_NOTICE_DAYS),
    productionLeadDays: policy.minLeadTimeDays,
    routeLeadDays: route.days,
    maxAdvanceDays: policy.maxAdvanceDays,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  // Where the preorder may be delivered: the policy's own list, narrowed by
  // the offer's selling regions when both say something.
  const deliveryCountries =
    policy.deliveryCountries.length > 0 && offer.sellingRegions.length > 0
      ? policy.deliveryCountries.filter((country) => offer.sellingRegions.includes(country))
      : policy.deliveryCountries.length > 0
        ? policy.deliveryCountries
        : offer.sellingRegions;

  return {
    available: true,
    offer,
    policy,
    rules: quantity.rules,
    units,
    sizes,
    containerOptions,
    window,
    timezone,
    hasPublishedTransit: route.hasPublishedTransit,
    deliveryCountries,
  };
}

/** The eligibility answer as the storefront reads it. No internal ids beyond the offer. */
export function serialiseEligibility(result: Eligibility): Record<string, unknown> {
  if (!result.available) {
    return {
      available: false,
      reason: result.reason,
      message: result.message,
      offerId: result.offer?.id ?? null,
      sellerName: result.offer?.sellerDisplayName ?? null,
    };
  }

  const { policy } = result;

  return {
    available: true,
    offerId: result.offer.id,
    sellerName: result.offer.sellerDisplayName,
    currency: result.offer.currency,
    listUnitPriceMinor: result.offer.priceMinor.toString(),
    instantStockBaseUnits: result.offer.availableQuantity,
    units: result.units.map((unit) => ({
      unit,
      baseUnits: unit === 'PIECE' ? 1 : (result.sizes[unit] ?? 0),
    })),
    // Always both sizes, so the form can show a container it cannot sell as
    // disabled with the reason. An unavailable size carries no figure.
    containerOptions: result.containerOptions.map((option) => ({
      unit: option.unit,
      available: option.available,
      piecesPerContainer: option.piecesPerContainer,
      cartonsPerContainer: option.cartonsPerContainer,
      piecesPerCarton: option.piecesPerCarton,
      reason: option.reason,
    })),
    moq: {
      unit: policy.moqUnit,
      quantity: policy.moqQuantity,
      incrementQuantity: policy.incrementQuantity,
      maxQuantity: policy.maxQuantity,
      minimumBaseUnits: result.rules.minimumBaseUnits,
      incrementBaseUnits: result.rules.incrementBaseUnits,
      maximumBaseUnits: result.rules.maximumBaseUnits,
    },
    pricingMode: policy.pricingMode,
    tiers: policy.tiers
      .filter((tier) => tier.currency === result.offer.currency)
      .map((tier) => ({
        minBaseUnits: tier.minBaseUnits,
        unitPriceMinor: tier.unitPriceMinor.toString(),
      })),
    window: {
      today: result.window.today,
      earliest: result.window.earliest,
      latest: result.window.latest,
      decidedBy: result.window.decidedBy,
      timezone: result.timezone,
      hasPublishedTransit: result.hasPublishedTransit,
    },
    deliveryCountries: result.deliveryCountries,
    allowPartialFulfilment: policy.allowPartialFulfilment,
    allowSplitDelivery: policy.allowSplitDelivery,
    cancellationTerms: policy.cancellationTerms,
    specialInstructions: policy.specialInstructions,
  };
}

// ---------------------------------------------------------------------------
// The seller's side
// ---------------------------------------------------------------------------

const unitEnum = z.enum(POLICY_MOQ_UNITS);
/** What a seller may permit buyers to order in, containers included. */
const orderUnitEnum = z.enum([
  'PIECE',
  'CARTON',
  'UK_PALLET',
  'US_PALLET',
  'CONTAINER',
  'CONTAINER_20_FT',
  'CONTAINER_40_FT',
]);
const positiveInt = z.number().int().positive().max(1_000_000_000);
const optionalPositive = positiveInt.nullable();

export const policyInputSchema = z
  .object({
    scope: z.enum(['OFFER', 'PRODUCT', 'SELLER_DEFAULT']),
    /** The offer for OFFER; any of the seller's offers on the product for PRODUCT. */
    offerId: z.string().length(26).nullable().default(null),
    isEnabled: z.boolean(),
    moqUnit: unitEnum,
    moqQuantity: optionalPositive,
    incrementQuantity: positiveInt.default(1),
    maxQuantity: optionalPositive.default(null),
    capacityBaseUnits: optionalPositive.default(null),
    capacityPeriod: z.enum(['DAY', 'WEEK', 'MONTH']).default('MONTH'),
    safetyStockBaseUnits: z.number().int().min(0).max(1_000_000_000).default(0),
    minLeadTimeDays: z.number().int().min(0).max(730).nullable().default(null),
    maxAdvanceDays: z.number().int().min(1).max(1095).nullable().default(null),
    deliveryCountries: z
      .array(z.string().regex(/^[A-Z]{2}$/))
      .max(250)
      .default([]),
    eligibleLocationIds: z.array(z.string().length(26)).max(50).default([]),
    packagingTypes: z.array(orderUnitEnum).max(7).nullable().default(null),
    pricingMode: z.enum(['FIXED', 'QUOTE_REQUIRED']),
    allowPartialFulfilment: z.boolean().default(false),
    allowSplitDelivery: z.boolean().default(false),
    requestExpiryHours: z.number().int().min(1).max(2160).nullable().default(null),
    offerExpiryHours: z.number().int().min(1).max(2160).nullable().default(null),
    cancellationTerms: z.string().trim().max(1000).nullable().default(null),
    specialInstructions: z.string().trim().max(1000).nullable().default(null),
    tiers: z
      .array(
        z.object({
          minBaseUnits: positiveInt,
          unitPriceMinor: z.string().regex(/^\d{1,19}$/),
        }),
      )
      .max(20)
      .default([]),
    /** Optimistic concurrency. The version the form was loaded at. */
    expectedVersion: z.number().int().min(0).nullable().default(null),
  })
  .strict();

export type PolicyInput = z.infer<typeof policyInputSchema>;

function policyInvalid(field: string, message: string): never {
  throw badRequest(ErrorCode.PREORDER_POLICY_INVALID, message, [
    { field, code: 'INVALID', message },
  ]);
}

/**
 * Save a policy.
 *
 * Every rule a buyer is later refused under is checked here first, so a
 * seller cannot publish terms that would refuse every request.
 */
export async function savePolicy(
  membership: SellerMembership,
  input: PolicyInput,
): Promise<Record<string, unknown>> {
  const sellerAccountId = membership.sellerAccountId;

  let scopeKey = '';
  let offerId: string | null = null;
  let productId: string | null = null;
  let currency: string;

  if (input.scope === 'SELLER_DEFAULT') {
    const offer = await prisma.sellerOffer.findFirst({
      where: { sellerAccountId, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      select: { currency: true },
    });
    if (offer === null)
      policyInvalid('scope', 'List a product before setting default preorder terms.');
    currency = offer.currency;
  } else {
    if (input.offerId === null)
      policyInvalid('offerId', 'Choose which listing these terms are for.');
    const offer = await prisma.sellerOffer.findUnique({
      where: { id: input.offerId },
      select: { id: true, sellerAccountId: true, productId: true, currency: true },
    });
    // Another seller's offer answers exactly as a missing one does.
    if (offer === null || offer.sellerAccountId !== sellerAccountId) throw notFound('Listing');
    currency = offer.currency;
    if (input.scope === 'OFFER') {
      scopeKey = offer.id;
      offerId = offer.id;
    } else {
      scopeKey = offer.productId;
      productId = offer.productId;
    }
  }

  if (input.isEnabled && input.moqQuantity === null) {
    policyInvalid('moqQuantity', 'Set a minimum preorder quantity before switching preorders on.');
  }

  if (
    input.maxQuantity !== null &&
    input.moqQuantity !== null &&
    input.maxQuantity < input.moqQuantity
  ) {
    policyInvalid('maxQuantity', 'The maximum cannot be below the minimum.');
  }

  if (input.maxQuantity !== null && input.incrementQuantity > input.maxQuantity) {
    policyInvalid('incrementQuantity', 'The step cannot be larger than the maximum.');
  }

  if (
    input.packagingTypes !== null &&
    input.packagingTypes.length > 0 &&
    !input.packagingTypes.includes(input.moqUnit)
  ) {
    policyInvalid(
      'packagingTypes',
      'The unit the minimum is set in must be one buyers may order in.',
    );
  }

  if (input.pricingMode === 'FIXED' && input.tiers.length === 0) {
    policyInvalid('tiers', 'Fixed preorder pricing needs at least one price band.');
  }

  // Bands ascending, distinct, positive, and never dearer per piece as the
  // quantity rises. A preorder band that costs more at a larger quantity is a
  // typing mistake far more often than a policy, and a buyer shown one would
  // reasonably think the page was broken.
  const tiers = [...input.tiers].sort((a, b) => a.minBaseUnits - b.minBaseUnits);
  let previousPrice: bigint | null = null;
  const seen = new Set<number>();
  for (const [index, tier] of tiers.entries()) {
    const price = BigInt(tier.unitPriceMinor);
    if (seen.has(tier.minBaseUnits))
      policyInvalid(`tiers.${String(index)}`, 'Two bands start at the same quantity.');
    seen.add(tier.minBaseUnits);
    if (price <= 0n)
      policyInvalid(
        `tiers.${String(index)}.unitPriceMinor`,
        'A price band must have a price above zero.',
      );
    if (previousPrice !== null && price > previousPrice) {
      policyInvalid(
        `tiers.${String(index)}.unitPriceMinor`,
        'A larger quantity cannot cost more per piece than a smaller one.',
      );
    }
    previousPrice = price;
  }

  if (input.eligibleLocationIds.length > 0) {
    const owned = await prisma.sellerLocation.count({
      where: { id: { in: input.eligibleLocationIds }, sellerAccountId },
    });
    if (owned !== new Set(input.eligibleLocationIds).size) throw notFound('Location');
  }

  const existing = await prisma.preorderPolicy.findUnique({
    where: {
      sellerAccountId_scope_scopeKey: { sellerAccountId, scope: input.scope, scopeKey },
    },
    select: { id: true, version: true },
  });

  if (
    existing !== null &&
    input.expectedVersion !== null &&
    existing.version !== input.expectedVersion
  ) {
    throw conflict(
      ErrorCode.CONFLICT,
      'These preorder terms were changed by somebody else while you were editing. Reload and try again.',
    );
  }

  const data = {
    isEnabled: input.isEnabled,
    moqUnit: input.moqUnit,
    moqQuantity: input.moqQuantity,
    incrementQuantity: input.incrementQuantity,
    maxQuantity: input.maxQuantity,
    capacityBaseUnits: input.capacityBaseUnits,
    capacityPeriod: input.capacityPeriod,
    safetyStockBaseUnits: input.safetyStockBaseUnits,
    minLeadTimeDays: input.minLeadTimeDays,
    maxAdvanceDays: input.maxAdvanceDays,
    deliveryCountriesJson: input.deliveryCountries,
    eligibleLocationIdsJson: input.eligibleLocationIds,
    packagingTypesJson: input.packagingTypes ?? undefined,
    pricingMode: input.pricingMode,
    allowPartialFulfilment: input.allowPartialFulfilment,
    allowSplitDelivery: input.allowSplitDelivery,
    requestExpiryHours: input.requestExpiryHours,
    offerExpiryHours: input.offerExpiryHours,
    cancellationTerms: input.cancellationTerms === '' ? null : input.cancellationTerms,
    specialInstructions: input.specialInstructions === '' ? null : input.specialInstructions,
    updatedByLabel: membership.displayName.slice(0, 160),
  };

  const id = await prisma.$transaction(async (tx) => {
    let policyId: string;

    if (existing === null) {
      policyId = newId();
      await tx.preorderPolicy.create({
        data: {
          id: policyId,
          sellerAccountId,
          scope: input.scope,
          scopeKey,
          offerId,
          productId,
          ...data,
        },
      });
    } else {
      policyId = existing.id;
      const updated = await tx.preorderPolicy.updateMany({
        where: { id: existing.id, version: existing.version },
        data: {
          ...data,
          ...(input.packagingTypes === null ? { packagingTypesJson: null as never } : {}),
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1) {
        throw conflict(
          ErrorCode.CONFLICT,
          'These preorder terms changed while saving. Reload and try again.',
        );
      }
      await tx.preorderPriceTier.deleteMany({ where: { policyId } });
    }

    if (tiers.length > 0) {
      await tx.preorderPriceTier.createMany({
        data: tiers.map((tier) => ({
          id: newId(),
          policyId,
          minBaseUnits: tier.minBaseUnits,
          unitPriceMinor: BigInt(tier.unitPriceMinor),
          currency,
        })),
      });
    }

    await recordSellerAudit({
      sellerAccountId,
      action: 'preorder.policy_saved',
      actor: { type: 'CUSTOMER', userId: null, label: membership.displayName },
      resourceType: 'preorder_policy',
      resourceId: policyId,
      after: {
        scope: input.scope,
        scopeKey,
        isEnabled: input.isEnabled,
        moqQuantity: input.moqQuantity,
        moqUnit: input.moqUnit,
        pricingMode: input.pricingMode,
        tierCount: tiers.length,
      },
      summary: `Preorder terms saved (${input.scope.toLowerCase().replace('_', ' ')})`,
      tx,
    });

    return policyId;
  });

  return readPolicy(sellerAccountId, id);
}

export async function readPolicy(
  sellerAccountId: string,
  policyId: string,
): Promise<Record<string, unknown>> {
  const row = await prisma.preorderPolicy.findUnique({
    where: { id: policyId },
    include: { tiers: { orderBy: { minBaseUnits: 'asc' } } },
  });
  if (row === null || row.sellerAccountId !== sellerAccountId) throw notFound('Preorder terms');
  return serialisePolicyRow(row);
}

function serialisePolicyRow(row: PolicyRow): Record<string, unknown> {
  const terms = toPolicyTerms(row);
  return {
    ...serialisePolicyTerms(terms),
    scopeKey: row.scopeKey,
    offerId: row.offerId,
    productId: row.productId,
    updatedAt: row.updatedAt.toISOString(),
    updatedByLabel: row.updatedByLabel,
  };
}

/**
 * The three levels of the chain for one of the seller's offers, and which one
 * applies - what the Seller Hub's preorder panel draws.
 */
export async function readPolicyChain(
  sellerAccountId: string,
  offerId: string | null,
): Promise<Record<string, unknown>> {
  if (offerId === null) {
    const seller = await prisma.preorderPolicy.findUnique({
      where: {
        sellerAccountId_scope_scopeKey: { sellerAccountId, scope: 'SELLER_DEFAULT', scopeKey: '' },
      },
      include: { tiers: { orderBy: { minBaseUnits: 'asc' } } },
    });
    return {
      offer: null,
      product: null,
      sellerDefault: seller === null ? null : serialisePolicyRow(seller),
      applies: seller === null ? null : 'SELLER_DEFAULT',
    };
  }

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: offerId },
    select: { id: true, sellerAccountId: true, productId: true, currency: true },
  });
  if (offer === null || offer.sellerAccountId !== sellerAccountId) throw notFound('Listing');

  const rows = await loadPolicyRows(sellerAccountId, offer.id, offer.productId);
  const byScope = (scope: PreorderScope) => rows.find((row) => row.scope === scope) ?? null;
  const applies = resolvePolicy(rows);
  const sizes = await unitSizesForOffer(offer.id);

  const appliedTerms = applies === null ? null : toPolicyTerms(applies);
  const quantity = appliedTerms === null ? null : quantityRulesFor(appliedTerms, sizes);

  return {
    currency: offer.currency,
    offer: byScope('OFFER') === null ? null : serialisePolicyRow(byScope('OFFER') as PolicyRow),
    product:
      byScope('PRODUCT') === null ? null : serialisePolicyRow(byScope('PRODUCT') as PolicyRow),
    sellerDefault:
      byScope('SELLER_DEFAULT') === null
        ? null
        : serialisePolicyRow(byScope('SELLER_DEFAULT') as PolicyRow),
    applies: applies?.scope ?? null,
    // With nothing configured, whether buyers can still preorder on the
    // platform default terms (`PREORDER_OPEN_TO_ALL`), so the panel tells the
    // seller the truth either way.
    platformDefault: applies === null && env.PREORDER_OPEN_TO_ALL,
    unitSizes: sizes,
    // What a buyer would be held to, in pieces, or why nothing applies.
    effective:
      quantity === null
        ? null
        : quantity.rules === null
          ? { rules: null, issues: quantity.issues }
          : { rules: quantity.rules, issues: [] },
  };
}

export async function deletePolicy(membership: SellerMembership, policyId: string): Promise<void> {
  const row = await prisma.preorderPolicy.findUnique({
    where: { id: policyId },
    select: { sellerAccountId: true, scope: true },
  });
  if (row === null || row.sellerAccountId !== membership.sellerAccountId)
    throw notFound('Preorder terms');

  // Capacity held against these terms lives on them. Removing the terms while
  // a confirmed preorder depends on them would forget what was promised.
  const holding = await prisma.preorderRequest.count({
    where: {
      policyId,
      status: { in: ['PAYMENT_REQUIRED', 'CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_FULFILLMENT'] },
    },
  });
  if (holding > 0) {
    throw conflict(
      ErrorCode.PREORDER_POLICY_INVALID,
      'Confirmed preorders were made under these terms. Switch them off instead of removing them.',
      [{ code: 'IN_USE', meta: { activePreorders: holding } }],
    );
  }

  await prisma.preorderPolicy.delete({ where: { id: policyId } });

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'preorder.policy_removed',
    actor: { type: 'CUSTOMER', userId: null, label: membership.displayName },
    resourceType: 'preorder_policy',
    resourceId: policyId,
    summary: `Preorder terms removed (${row.scope.toLowerCase().replace('_', ' ')})`,
  });
}
