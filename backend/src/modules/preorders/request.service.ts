/**
 * Preorder requests: submission, the seller's answer, the buyer's answer, and
 * the one conversion into an order.
 *
 * The lifecycle is in `domain/preorder-state.ts` and every status write here
 * goes through `move`, which asserts the transition and makes the write
 * conditional on the status and version it read. Two tabs, a retried request
 * and a sweep running at the same moment therefore cannot both succeed: the
 * second finds the row has moved and is refused.
 *
 * WHAT IS NEVER DONE HERE
 *
 *   - Sellable stock is never reserved. A preorder is for goods that will be
 *     made; the order is reserved against the seller's shelf when they accept
 *     it, like any marketplace order.
 *   - Nobody is charged. The buyer's confirmation creates an order AWAITING
 *     payment. The order is confirmed only by the signed payment webhook, and
 *     `onPreorderOrderConfirmed` below is how the preorder hears about it.
 *   - A client's price is never used. The indicative price is recomputed from
 *     the policy on every preview and submission, and the order is built from
 *     the confirmed revision's own stored figures.
 */
import { priceForQuantity } from '../../domain/quantity-tier.js';
import { z } from 'zod';

import { env } from '../../config/env.js';
import {
  fromDateColumn,
  isCalendarDay,
  resolveTimezone,
  todayIn,
  addCalendarDays,
  toDateColumn,
  type CalendarDay,
} from '../../domain/delivery-dates.js';
import {
  ErrorCode,
  badRequest,
  conflict,
  notFound,
  type ErrorDetail,
} from '../../domain/errors.js';
import { serialiseMoney, type Minor } from '../../domain/money.js';
import {
  baseUnitsFor,
  capacityPeriodKey,
  checkDeliveryDate,
  checkDeliverySplits,
  checkPreorderQuantity,
  indicativePrice,
  termsHash,
  type PolicyTerms,
  type PreorderTerms,
} from '../../domain/preorder.js';
import {
  AWAITING_BUYER,
  AWAITING_SELLER,
  HOLDS_CAPACITY,
  allowedPreorderTransitions,
  assertPreorderTransition,
  isTerminalPreorderStatus,
  type PreorderActorKind,
  type PreorderStatusName,
} from '../../domain/preorder-state.js';
import { priceLines, type PricingLineInput } from '../../domain/pricing.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { describeConversion, indicativeConversion } from '../catalog/indicative-fx.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { nextOrderNumber } from '../orders/order.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';
import { notifySupplier, resolveSupplierNotifications, type Responder } from './supplier.js';
import { applyLineTax, loadTaxContext } from '../tax/vat.service.js';
import { evaluateEligibility, serialisePolicyTerms, type Eligibility } from './policy.service.js';
import { assertPreorderInfoAcknowledged } from './acknowledgement.service.js';
import {
  containerEquivalent,
  isContainerSize,
  type ContainerSize,
} from '../../domain/container-loading.js';
import {
  assessShortfall,
  validateAvailabilityProposal,
  type AvailabilityProposalKind,
  type PlannedInstallment,
  type Shortfall,
} from '../../domain/preorder-availability.js';
import {
  containerOptionsForOffer,
  containerSnapshot,
} from '../seller/container-loading.service.js';
import {
  holdStockForPreorder,
  offerAvailability,
  releasePreorderHolds,
  type OfferAvailability,
} from './availability.service.js';

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export interface BuyerActor {
  userId: string;
  email: string;
  customerProfileId: string;
  correlationId?: string | null;
  ipAddress?: string | null;
}

interface StatusActor {
  kind: PreorderActorKind;
  userId: string | null;
  label: string;
  /**
   * Staff acting as the supplier of the operator's own product. The kind is
   * SELLER - the supplier's role is what the state machine checks - and this
   * is what makes the history say it was a member of staff.
   */
  staff?: boolean;
}

function historyActorType(actor: StatusActor): 'SYSTEM' | 'ADMIN' | 'CUSTOMER' {
  // A seller is a customer account acting in Seller Hub - there is no SELLER
  // member of ActorType - and the label says which it was.
  if (actor.kind === 'SYSTEM') return 'SYSTEM';
  if (actor.kind === 'ADMIN' || actor.staff === true) return 'ADMIN';
  return 'CUSTOMER';
}

function responderActor(responder: Responder): StatusActor {
  return responder.kind === 'SELLER'
    ? { kind: 'SELLER', userId: null, label: `${responder.displayName} (seller)`.slice(0, 160) }
    : {
        kind: 'SELLER',
        userId: responder.userId,
        label: `${responder.staffEmail} (store staff)`.slice(0, 160),
        staff: true,
      };
}

/**
 * The supplier's own audit trail: Seller Hub's for a seller, the operator's
 * audit log for staff answering on the operator's product.
 */
async function supplierAudit(
  tx: PrismaTransaction,
  responder: Responder,
  entry: {
    action: string;
    requestId: string;
    summary: string;
    after?: Record<string, unknown>;
  },
): Promise<void> {
  if (responder.kind === 'SELLER') {
    await recordSellerAudit({
      sellerAccountId: responder.sellerAccountId,
      action: entry.action,
      actor: { type: 'CUSTOMER', label: responder.displayName },
      resourceType: 'preorder_request',
      resourceId: entry.requestId,
      ...(entry.after === undefined ? {} : { after: entry.after }),
      summary: entry.summary,
      tx,
    });
    return;
  }
  await recordAudit(
    {
      action: AuditAction.PREORDER_STATUS_CHANGED,
      resourceType: 'preorder_request',
      resourceId: entry.requestId,
      actorType: 'ADMIN',
      actorUserId: responder.userId,
      actorEmail: responder.staffEmail,
      after: { event: entry.action, summary: entry.summary, ...(entry.after ?? {}) },
    },
    tx,
  );
}

/** What the supplier sees after acting: Seller Hub's view, or the admin view. */
async function viewForSupplier(responder: Responder, id: string): Promise<Record<string, unknown>> {
  return responder.kind === 'SELLER'
    ? getSellerPreorder(responder.sellerAccountId, id)
    : getAdminPreorder(id);
}

const SYSTEM_ACTOR: StatusActor = { kind: 'SYSTEM', userId: null, label: 'System' };

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

const unitEnum = z.enum([
  'PIECE',
  'CARTON',
  'UK_PALLET',
  'US_PALLET',
  'CONTAINER',
  'CONTAINER_20_FT',
  'CONTAINER_40_FT',
]);
const calendarDay = z
  .string()
  .refine((value) => isCalendarDay(value), 'Enter a real date as YYYY-MM-DD.');
const minorString = z.string().regex(/^\d{1,19}$/);

export const preorderInputSchema = z
  .object({
    productId: z.string().length(26),
    variantId: z.string().length(26).nullable().default(null),
    offerId: z.string().length(26).nullable().default(null),
    orderingUnit: unitEnum,
    unitQuantity: z.number().int().positive().max(100_000_000),
    requestedDeliveryDate: calendarDay,
    shippingAddressId: z.string().length(26),
    destinationWarehouseLabel: z.string().trim().max(160).nullable().default(null),
    packagingPreference: unitEnum.nullable().default(null),
    transportPreference: z.enum(['ANY', 'ROAD', 'AIR', 'SEA', 'RAIL']).default('ANY'),
    allowPartialDelivery: z.boolean().default(false),
    purchaseOrderReference: z.string().trim().max(64).nullable().default(null),
    customerNotes: z.string().trim().max(2000).nullable().default(null),
    handlingInstructions: z.string().trim().max(1000).nullable().default(null),
    /** Required true on submission. A preview may be asked for before it is ticked. */
    acceptTerms: z.boolean().default(false),
    /** The currency the buyer browses in, for an approximate figure only. */
    displayCurrency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .nullable()
      .default(null),
  })
  .strict();

export type PreorderInput = z.infer<typeof preorderInputSchema>;

// ---------------------------------------------------------------------------
// Assessment: everything a submission is judged on, without writing anything
// ---------------------------------------------------------------------------

interface Assessment {
  eligibility: Extract<Eligibility, { available: true }>;
  address: {
    id: string;
    snapshot: Record<string, string | null>;
    country: string;
  };
  timezone: string;
  unitsPerPackage: number;
  baseUnits: number;
  /** For a 20-ft or 40-ft request: the seller's verified loading, frozen. */
  container: { unit: ContainerSize; snapshot: Record<string, unknown>; version: number } | null;
  /** Available-to-promise now, and how far short of the request it falls. */
  availability: { availableToPromise: number; shortfall: Shortfall };
  requestedDay: CalendarDay;
  price: ReturnType<typeof indicativePrice>;
  conversion: Awaited<ReturnType<typeof indicativeConversion>>;
  buyer: { fullName: string; organization: string; email: string };
}

function fail(
  code: (typeof ErrorCode)[keyof typeof ErrorCode],
  message: string,
  detail: ErrorDetail,
): never {
  throw badRequest(code, message, [detail]);
}

function formatCount(value: number): string {
  return value.toLocaleString('en');
}

/**
 * Is the buyer somebody who may place a preorder?
 *
 * "Approved business buyer", made concrete: an ACTIVE account (the session
 * guard refuses anything else before this runs) with a company name on its
 * profile. There is no separate buyer-approval workflow in this product to
 * defer to, so the business name is the test - a preorder is a commercial
 * negotiation, and a seller has to know which company they are negotiating
 * with.
 */
async function loadEligibleBuyer(customerProfileId: string) {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: {
      fullName: true,
      organization: true,
      vatNumber: true,
      vatNumberValid: true,
      user: { select: { email: true, status: true } },
    },
  });

  if (profile === null) throw notFound('Account');

  const organization = (profile.organization ?? '').trim();
  if (profile.user.status !== 'ACTIVE' || organization === '') {
    throw badRequest(
      ErrorCode.PREORDER_BUYER_NOT_ELIGIBLE,
      'Preorders are for business accounts. Add your company name to your profile to request one.',
      [{ field: 'organization', code: 'REQUIRED' }],
    );
  }

  return { ...profile, organization };
}

async function assess(customerProfileId: string, input: PreorderInput): Promise<Assessment> {
  const buyer = await loadEligibleBuyer(customerProfileId);

  const address = await prisma.address.findFirst({
    where: { id: input.shippingAddressId, customerProfileId, archivedAt: null },
  });
  if (address === null) throw notFound('Delivery address');

  const timezone = resolveTimezone(address.timezone);

  const eligibility = await evaluateEligibility({
    productId: input.productId,
    variantId: input.variantId,
    offerId: input.offerId,
    destinationCountry: address.country,
    timezone,
  });

  if (!eligibility.available) {
    fail(ErrorCode.PREORDER_NOT_AVAILABLE, eligibility.message, {
      code: eligibility.reason,
      meta: { reason: eligibility.reason },
    });
  }

  const { rules, units, sizes, window, deliveryCountries } = eligibility;

  if (deliveryCountries.length > 0 && !deliveryCountries.includes(address.country)) {
    fail(
      ErrorCode.PREORDER_DESTINATION_NOT_SERVED,
      `${eligibility.offer.sellerDisplayName} does not deliver preorders of this product to ${address.country}.`,
      { field: 'shippingAddressId', code: 'NOT_SERVED', meta: { country: address.country } },
    );
  }

  const unit = input.orderingUnit;

  // A container is its own refusal, with its own reason, so the buyer is told
  // "the seller has not configured the packing capacity" rather than "this
  // unit is not available" - and is left with Pieces, which always works.
  let container: Assessment['container'] = null;
  if (isContainerSize(unit)) {
    const option = eligibility.containerOptions.find((entry) => entry.unit === unit);
    const loading = await containerOptionsForOffer(eligibility.offer.id);
    const live = loading.options.find((entry) => entry.unit === unit);
    if (
      option?.available !== true ||
      live?.available !== true ||
      loading.row === null ||
      live.piecesPerContainer !== sizes[unit]
    ) {
      fail(
        ErrorCode.PREORDER_CONTAINER_NOT_CONFIGURED,
        'Container ordering is not available because the seller has not configured the packing capacity for this product.',
        {
          field: 'orderingUnit',
          code: option?.reason ?? 'NOT_CONFIGURED',
          meta: { unit, reason: option?.reason ?? 'NOT_CONFIGURED' },
        },
      );
    }
    container = {
      unit,
      snapshot: containerSnapshot(loading.row, unit),
      version: loading.row.version,
    };
  }

  if (!units.includes(unit)) {
    fail(ErrorCode.PREORDER_UNIT_NOT_AVAILABLE, 'This product cannot be preordered in that unit.', {
      field: 'orderingUnit',
      code: 'NOT_AVAILABLE',
      meta: { unit },
    });
  }

  const baseUnits = baseUnitsFor(input.unitQuantity, unit, sizes);
  const unitsPerPackage = unit === 'PIECE' ? 1 : (sizes[unit] ?? 0);
  if (baseUnits === null || unitsPerPackage <= 0) {
    fail(ErrorCode.PREORDER_UNIT_NOT_AVAILABLE, 'This product cannot be preordered in that unit.', {
      field: 'orderingUnit',
      code: 'NOT_AVAILABLE',
      meta: { unit },
    });
  }

  const violation = checkPreorderQuantity(baseUnits, rules);
  if (violation?.code === 'BELOW_MINIMUM') {
    fail(
      ErrorCode.PREORDER_BELOW_MINIMUM,
      `Minimum preorder quantity is ${formatCount(violation.minimumBaseUnits)} pieces.`,
      {
        field: 'unitQuantity',
        code: 'BELOW_MINIMUM',
        meta: { minimumBaseUnits: violation.minimumBaseUnits },
      },
    );
  }
  if (violation?.code === 'INCREMENT') {
    fail(
      ErrorCode.PREORDER_INCREMENT_MISMATCH,
      `Preorders must be placed in multiples of ${formatCount(violation.incrementBaseUnits)} pieces above the minimum of ${formatCount(violation.minimumBaseUnits)}.`,
      {
        field: 'unitQuantity',
        code: 'INCREMENT',
        meta: {
          incrementBaseUnits: violation.incrementBaseUnits,
          minimumBaseUnits: violation.minimumBaseUnits,
        },
      },
    );
  }
  if (violation?.code === 'ABOVE_MAXIMUM') {
    fail(
      ErrorCode.PREORDER_ABOVE_MAXIMUM,
      `The most this seller takes on one preorder is ${formatCount(violation.maximumBaseUnits)} pieces.`,
      {
        field: 'unitQuantity',
        code: 'ABOVE_MAXIMUM',
        meta: { maximumBaseUnits: violation.maximumBaseUnits },
      },
    );
  }

  const dateProblem = checkDeliveryDate(input.requestedDeliveryDate, window);
  if (dateProblem?.code === 'INVALID') {
    fail(ErrorCode.VALIDATION_FAILED, 'Enter a real date.', {
      field: 'requestedDeliveryDate',
      code: 'INVALID',
    });
  }
  if (dateProblem?.code === 'TOO_EARLY') {
    fail(
      ErrorCode.PREORDER_DATE_TOO_EARLY,
      `The earliest available delivery date is ${dateProblem.earliest}.`,
      {
        field: 'requestedDeliveryDate',
        code: 'TOO_EARLY',
        meta: {
          earliest: dateProblem.earliest,
          decidedBy: window.decidedBy,
          timezone: eligibility.timezone,
        },
      },
    );
  }
  if (dateProblem?.code === 'TOO_FAR') {
    fail(
      ErrorCode.PREORDER_DATE_TOO_FAR,
      `This seller takes preorders for delivery up to ${dateProblem.latest}.`,
      {
        field: 'requestedDeliveryDate',
        code: 'TOO_FAR',
        meta: { latest: dateProblem.latest },
      },
    );
  }

  // The seller's quantity bands price a preorder too - including bands kept
  // for preorders only - through the same function the basket uses. A buyer
  // who could get 500 pieces at a band in the basket is never charged more
  // for 5,000 made to order.
  const quantityBand = priceForQuantity(
    eligibility.offer.priceMinor,
    eligibility.offer.quantityTiers,
    baseUnits,
    { now: new Date(), isBusinessBuyer: true, country: address.country, channel: 'PREORDER' },
  );
  const price = indicativePrice({
    pricingMode: eligibility.policy.pricingMode,
    tiers: eligibility.policy.tiers,
    baseUnits,
    offerUnitPriceMinor: quantityBand.unitPriceMinor,
    offerCurrency: eligibility.offer.currency,
  });

  if (eligibility.policy.pricingMode === 'FIXED' && price === null) {
    fail(
      ErrorCode.PREORDER_NOT_AVAILABLE,
      'Bulk preorder configuration is not currently available for this product.',
      {
        code: 'PRICING_INCOMPLETE',
      },
    );
  }

  const conversion =
    price === null || input.displayCurrency === null
      ? null
      : await indicativeConversion(eligibility.offer.currency, input.displayCurrency);

  // Available-to-promise, read live from the seller's stock. Informational:
  // nothing is reserved until the buyer accepts terms. The operator's own
  // product reports what its warehouses have on hand.
  const atp =
    eligibility.offer.id === null
      ? Math.max(0, eligibility.offer.availableQuantity)
      : (
          await offerAvailability({
            offerId: eligibility.offer.id,
            eligibleLocationIds: eligibility.policy.eligibleLocationIds,
            safetyStock: eligibility.policy.safetyStockBaseUnits,
          })
        ).availableToPromise;

  return {
    eligibility,
    address: {
      id: address.id,
      country: address.country,
      snapshot: {
        contactName: address.contactName,
        contactPhone: address.contactPhone,
        line1: address.line1,
        line2: address.line2,
        city: address.city,
        state: address.state,
        postalCode: address.postalCode,
        country: address.country,
      },
    },
    timezone: eligibility.timezone,
    unitsPerPackage,
    baseUnits,
    container,
    availability: { availableToPromise: atp, shortfall: assessShortfall(baseUnits, atp) },
    requestedDay: input.requestedDeliveryDate,
    price,
    conversion,
    buyer: { fullName: buyer.fullName, organization: buyer.organization, email: buyer.user.email },
  };
}

function money(amount: Minor | null, currency: string) {
  return amount === null ? null : serialiseMoney(amount, currency);
}

function serialiseAssessment(assessment: Assessment): Record<string, unknown> {
  const { eligibility, price, conversion } = assessment;
  const currency = eligibility.offer.currency;

  const { shortfall } = assessment.availability;

  return {
    offerId: eligibility.offer.id,
    sellerName: eligibility.offer.sellerDisplayName,
    baseUnits: assessment.baseUnits,
    unitsPerPackage: assessment.unitsPerPackage,
    /** The container breakdown, from the seller's verified loading. */
    container:
      assessment.container === null
        ? null
        : {
            unit: assessment.container.unit,
            containers: assessment.baseUnits / assessment.unitsPerPackage,
            piecesPerContainer: assessment.unitsPerPackage,
            cartonsPerContainer: assessment.container.snapshot['cartonsPerContainer'] ?? null,
            piecesPerCarton: assessment.container.snapshot['piecesPerCarton'] ?? null,
            totalPieces: assessment.baseUnits,
          },
    /**
     * Whether the whole quantity is available now. The figure is what could
     * go in a first fulfilment - never a warehouse's stock - and it is not a
     * promise: nothing is reserved until terms are accepted.
     */
    availability: {
      sufficient: shortfall.sufficient,
      requested: shortfall.requested,
      availableNow: shortfall.availableNow,
      remaining: shortfall.remaining,
    },
    /** Delivery is quoted by the seller in their answer, never estimated here. */
    logistics: { status: 'TO_BE_CONFIRMED' },
    minimumBaseUnits: eligibility.rules.minimumBaseUnits,
    incrementBaseUnits: eligibility.rules.incrementBaseUnits,
    maximumBaseUnits: eligibility.rules.maximumBaseUnits,
    pricingMode: eligibility.policy.pricingMode,
    currency,
    unitPrice: money(price?.unitPriceMinor ?? null, currency),
    goodsTotal: money(price?.goodsTotalMinor ?? null, currency),
    appliedTierMinBaseUnits: price?.tierMinBaseUnits ?? null,
    listUnitPrice: serialiseMoney(eligibility.offer.priceMinor, currency),
    /** Saving per piece against the offer's own list price, when a band applied. */
    savingPerPiece:
      price !== null && price.unitPriceMinor < eligibility.offer.priceMinor
        ? serialiseMoney(eligibility.offer.priceMinor - price.unitPriceMinor, currency)
        : null,
    approximate:
      conversion === null || price === null
        ? null
        : {
            ...describeConversion(conversion),
            unitPrice: serialiseMoney(
              conversion.convert(price.unitPriceMinor),
              conversion.toCurrency,
            ),
            goodsTotal: serialiseMoney(
              conversion.convert(price.goodsTotalMinor),
              conversion.toCurrency,
            ),
          },
    window: {
      earliest: eligibility.window.earliest,
      latest: eligibility.window.latest,
      decidedBy: eligibility.window.decidedBy,
      timezone: assessment.timezone,
      hasPublishedTransit: eligibility.hasPublishedTransit,
    },
    // Instant stock is shown so the buyer can see why this is a preorder and
    // not a basket line - never reserved, never promised.
    instantStockBaseUnits: eligibility.offer.availableQuantity,
  };
}

/** Everything the form's summary shows, from the server, without writing. */
export async function previewPreorder(
  customerProfileId: string,
  input: PreorderInput,
): Promise<Record<string, unknown>> {
  return serialiseAssessment(await assess(customerProfileId, input));
}

// ---------------------------------------------------------------------------
// The price of a set of terms
// ---------------------------------------------------------------------------

/** The policy's eligible locations, as frozen on the request. */
function policyLocations(snapshot: unknown): string[] {
  const value = (snapshot as { eligibleLocationIds?: unknown } | null)?.eligibleLocationIds;
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** The policy's safety stock, as frozen on the request. Zero on older requests. */
function policySafetyStock(snapshot: unknown): number {
  const value = (snapshot as { safetyStockBaseUnits?: unknown } | null)?.safetyStockBaseUnits;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

type PricedTerms =
  | {
      ok: true;
      product: {
        id: string;
        name: string;
        sku: string;
        status: string;
        isPublished: boolean;
        archivedAt: Date | null;
        imageUrl: string | null;
        taxClassCode: string;
      };
      variant: { sku: string | null; name: string | null } | null;
      taxSetup: Awaited<ReturnType<typeof loadTaxContext>>;
      lineTax: ReturnType<typeof applyLineTax>;
      pricing: ReturnType<typeof priceLines>;
      line: ReturnType<typeof priceLines>['lines'][number];
    }
  | { ok: false; problem: string };

/**
 * Goods, tax, delivery and total for one set of terms.
 *
 * THE one place a preorder's money is worked out. The buyer's review of the
 * seller's offer and the buyer's acceptance - which writes the order - both
 * call it, so the total a buyer agrees to and the total the order is created
 * with come from the same function and the same inputs. The same bargain
 * `quoteSchedule` makes for scheduled baskets.
 */
async function priceTerms(
  request: {
    productId: string;
    variantId: string | null;
    destinationCountry: string;
  },
  terms: { unitPriceMinor: bigint; quantityBaseUnits: number; freightMinor: bigint },
  buyer: { vatNumber: string | null; vatNumberValid: boolean | null },
): Promise<PricedTerms> {
  const product = await prisma.product.findUniqueOrThrow({
    where: { id: request.productId },
    select: {
      id: true,
      name: true,
      sku: true,
      status: true,
      isPublished: true,
      archivedAt: true,
      taxClass: {
        select: { code: true, ratePercent: true, isInclusive: true, vatCategory: true },
      },
      media: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
        select: { media: { select: { url: true } } },
      },
    },
  });
  const variant =
    request.variantId === null
      ? null
      : await prisma.productVariant.findUnique({
          where: { id: request.variantId },
          select: { sku: true, name: true },
        });

  const taxSetup = await loadTaxContext({
    destinationCountry: request.destinationCountry,
    vatNumber: buyer.vatNumber,
    vatNumberValid: buyer.vatNumberValid ?? false,
  });

  const lineTax = applyLineTax(
    taxSetup,
    {
      vatCategory: product.taxClass.vatCategory,
      flatRatePercent: product.taxClass.ratePercent.toString(),
      taxInclusive: product.taxClass.isInclusive,
      productName: product.name,
    },
    terms.unitPriceMinor,
  );

  if (lineTax.problem !== null) return { ok: false, problem: lineTax.problem };

  const pricingInput: PricingLineInput = {
    product: {
      productId: product.id,
      variantId: request.variantId,
      name: product.name,
      sku: variant?.sku ?? product.sku,
      variantName: variant?.name ?? null,
      unitPriceMinor: lineTax.unitPriceMinor,
      taxClassCode: product.taxClass.code,
      taxRatePercent: lineTax.taxRatePercent,
      taxInclusive: lineTax.taxInclusive,
      isRecurringEligible: false,
      imageUrl: product.media[0]?.media.url ?? null,
    },
    quantity: terms.quantityBaseUnits,
  };

  // The one pricing engine. The seller's quoted freight goes in as seller
  // delivery, which `priceLines` adds after any free-shipping rule - the same
  // path every seller's delivery charge takes at checkout.
  const pricing = priceLines([pricingInput], { sellerDeliveryMinor: terms.freightMinor });
  const line = pricing.lines[0];
  if (line === undefined) throw new Error('priceLines returned no line for a single input');

  return {
    ok: true,
    product: {
      id: product.id,
      name: product.name,
      sku: product.sku,
      status: product.status,
      isPublished: product.isPublished,
      archivedAt: product.archivedAt,
      imageUrl: product.media[0]?.media.url ?? null,
      taxClassCode: product.taxClass.code,
    },
    variant,
    taxSetup,
    lineTax,
    pricing,
    line,
  };
}

// ---------------------------------------------------------------------------
// Moving a request
// ---------------------------------------------------------------------------

interface Movable {
  id: string;
  status: PreorderStatusName;
  version: number;
}

async function move(
  tx: PrismaTransaction,
  request: Movable,
  to: PreorderStatusName,
  actor: StatusActor,
  options: {
    data?: Record<string, unknown>;
    reason?: string | null;
    meta?: Record<string, unknown>;
  } = {},
): Promise<Movable> {
  assertPreorderTransition({
    from: request.status,
    to,
    actor: actor.kind,
    reason: options.reason ?? null,
  });

  const updated = await tx.preorderRequest.updateMany({
    where: { id: request.id, status: request.status, version: request.version },
    data: { ...(options.data ?? {}), status: to, version: { increment: 1 } } as never,
  });

  if (updated.count !== 1) {
    throw conflict(
      ErrorCode.PREORDER_TRANSITION_NOT_ALLOWED,
      'This preorder changed while you were working on it. Reload it and try again.',
      [{ code: 'STALE' }],
    );
  }

  await tx.preorderStatusHistory.create({
    data: {
      id: newId(),
      requestId: request.id,
      fromStatus: request.status,
      toStatus: to,
      actorType: historyActorType(actor),
      actorUserId: actor.userId,
      actorLabel: actor.label,
      reason: options.reason ?? null,
      metaJson: (options.meta ?? undefined) as never,
    },
  });

  return { id: request.id, status: to, version: request.version + 1 };
}

// ---------------------------------------------------------------------------
// Capacity
// ---------------------------------------------------------------------------

/**
 * Hold `baseUnits` of the policy's capacity in the period of `day`.
 *
 * One conditional UPDATE is the whole guard: it adds only if the result stays
 * within the capacity, and an affected-row count of zero means it did not.
 * Two buyers confirming the last 10,000 of a month in the same second both run
 * it and exactly one of them succeeds.
 *
 * Returns null when the policy does not track capacity.
 */
async function reserveCapacity(
  tx: PrismaTransaction,
  input: {
    policyId: string | null;
    sellerAccountId: string | null;
    day: CalendarDay;
    baseUnits: number;
  },
): Promise<string | null> {
  if (input.policyId === null) return null;

  // Capacity belongs to a seller's own policy; the operator's products run
  // under the platform default, which promises no capacity limit.
  if (input.sellerAccountId === null) return null;
  const policy = await tx.preorderPolicy.findUnique({
    where: { id: input.policyId },
    select: { capacityBaseUnits: true, capacityPeriod: true },
  });

  if (policy === null || policy.capacityBaseUnits === null) return null;

  const periodKey = capacityPeriodKey(input.day, policy.capacityPeriod);

  await tx.preorderCapacityBucket.createMany({
    data: [
      { id: newId(), policyId: input.policyId, sellerAccountId: input.sellerAccountId, periodKey },
    ],
    skipDuplicates: true,
  });

  const bucket = await tx.preorderCapacityBucket.findUniqueOrThrow({
    where: { policyId_periodKey: { policyId: input.policyId, periodKey } },
    select: { id: true },
  });

  const affected = await tx.$executeRaw`
    UPDATE preorder_capacity_buckets
       SET reservedBaseUnits = reservedBaseUnits + ${input.baseUnits}, updatedAt = NOW(3)
     WHERE id = ${bucket.id}
       AND reservedBaseUnits + ${input.baseUnits} <= ${policy.capacityBaseUnits}`;

  if (affected !== 1) {
    const current = await tx.preorderCapacityBucket.findUniqueOrThrow({
      where: { id: bucket.id },
      select: { reservedBaseUnits: true },
    });
    const available = Math.max(0, policy.capacityBaseUnits - current.reservedBaseUnits);

    throw conflict(
      ErrorCode.PREORDER_CAPACITY_EXCEEDED,
      `The seller can make ${formatCount(available)} more pieces for delivery in that period, and this preorder is for ${formatCount(input.baseUnits)}.`,
      [
        {
          code: 'CAPACITY',
          meta: { availableBaseUnits: available, requestedBaseUnits: input.baseUnits, periodKey },
        },
      ],
    );
  }

  return bucket.id;
}

async function releaseCapacity(
  tx: PrismaTransaction,
  request: { capacityBucketId: string | null; capacityReservedBaseUnits: number },
): Promise<void> {
  if (request.capacityBucketId === null || request.capacityReservedBaseUnits <= 0) return;

  await tx.$executeRaw`
    UPDATE preorder_capacity_buckets
       SET reservedBaseUnits = GREATEST(reservedBaseUnits - ${request.capacityReservedBaseUnits}, 0),
           updatedAt = NOW(3)
     WHERE id = ${request.capacityBucketId}`;
}

/** What is left in the period of `day`, for the seller's decision screen. */
async function capacityImpact(
  policyId: string | null,
  day: CalendarDay,
  baseUnits: number,
): Promise<Record<string, unknown> | null> {
  if (policyId === null) return null;
  const policy = await prisma.preorderPolicy.findUnique({
    where: { id: policyId },
    select: { capacityBaseUnits: true, capacityPeriod: true },
  });
  if (policy === null || policy.capacityBaseUnits === null) return null;

  const periodKey = capacityPeriodKey(day, policy.capacityPeriod);
  const bucket = await prisma.preorderCapacityBucket.findUnique({
    where: { policyId_periodKey: { policyId, periodKey } },
    select: { reservedBaseUnits: true },
  });
  const reserved = bucket?.reservedBaseUnits ?? 0;

  return {
    periodKey,
    period: policy.capacityPeriod,
    capacityBaseUnits: policy.capacityBaseUnits,
    reservedBaseUnits: reserved,
    availableBaseUnits: Math.max(0, policy.capacityBaseUnits - reserved),
    requestedBaseUnits: baseUnits,
    fits: reserved + baseUnits <= policy.capacityBaseUnits,
  };
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

async function nextRequestNumber(tx: PrismaTransaction): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `preorder:${String(year)}`;

  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'PRQ', padding: 6 },
  });

  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `PRQ-${String(year)}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

function hoursFromNow(hours: number, now: Date = new Date()): Date {
  return new Date(now.getTime() + hours * 3_600_000);
}

function preorderUrl(id: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/preorders/${id}`;
}

async function productLabel(productId: string, variantId: string | null): Promise<string> {
  const [product, variant] = await Promise.all([
    prisma.product.findUnique({ where: { id: productId }, select: { name: true } }),
    variantId === null
      ? Promise.resolve(null)
      : prisma.productVariant.findUnique({ where: { id: variantId }, select: { name: true } }),
  ]);
  const name = product?.name ?? 'the product';
  return variant?.name === undefined || variant.name === null ? name : `${name} — ${variant.name}`;
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export async function submitPreorder(
  actor: BuyerActor,
  input: PreorderInput,
): Promise<Record<string, unknown>> {
  if (!input.acceptTerms) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Confirm that you accept the preorder terms.', [
      { field: 'acceptTerms', code: 'REQUIRED' },
    ]);
  }

  // The bulk preorder note, read at its current version. Checked against the
  // server's own record - nothing in the body can say it was read.
  await assertPreorderInfoAcknowledged(actor.userId);

  const assessment = await assess(actor.customerProfileId, input);
  const { eligibility, price, conversion } = assessment;
  const policy: PolicyTerms = eligibility.policy;
  const now = new Date();
  const id = newId();
  const expiresAt = hoursFromNow(
    policy.requestExpiryHours ?? env.PREORDER_REQUEST_EXPIRY_HOURS,
    now,
  );
  const label = await productLabel(eligibility.offer.productId, eligibility.offer.variantId);

  const requestNumber = await prisma.$transaction(async (tx) => {
    const number = await nextRequestNumber(tx);

    await tx.preorderRequest.create({
      data: {
        id,
        requestNumber: number,
        sellerAccountId: eligibility.offer.sellerAccountId,
        customerProfileId: actor.customerProfileId,
        requestedByUserId: actor.userId,
        productId: eligibility.offer.productId,
        variantId: eligibility.offer.variantId,
        variantKey: eligibility.offer.variantKey,
        offerId: eligibility.offer.id,
        // The platform default is not a stored policy: nothing to point at.
        policyId: policy.id === '' ? null : policy.id,
        policyVersion: policy.version,
        policySnapshotJson: serialisePolicyTerms(policy) as never,
        status: 'SUBMITTED',
        orderingUnit: input.orderingUnit,
        unitQuantity: input.unitQuantity,
        unitsPerPackage: assessment.unitsPerPackage,
        requestedBaseUnits: assessment.baseUnits,
        containerLoadingSnapshotJson: (assessment.container?.snapshot ?? undefined) as never,
        containerLoadingVersion: assessment.container?.version ?? null,
        availableToPromiseAtSubmission: assessment.availability.availableToPromise,
        shortfallAtSubmission: assessment.availability.shortfall.remaining,
        requestedDeliveryDate: toDateColumn(assessment.requestedDay),
        earliestDeliveryDate: toDateColumn(eligibility.window.earliest),
        timezone: assessment.timezone,
        shippingAddressId: assessment.address.id,
        shippingAddressJson: assessment.address.snapshot as never,
        destinationCountry: assessment.address.country,
        destinationWarehouseLabel:
          input.destinationWarehouseLabel === '' ? null : input.destinationWarehouseLabel,
        packagingPreference: input.packagingPreference,
        transportPreference: input.transportPreference,
        allowPartialDelivery: input.allowPartialDelivery,
        purchaseOrderReference:
          input.purchaseOrderReference === '' ? null : input.purchaseOrderReference,
        customerNotes: input.customerNotes === '' ? null : input.customerNotes,
        handlingInstructions: input.handlingInstructions === '' ? null : input.handlingInstructions,
        termsAcceptedAt: now,
        pricingMode: policy.pricingMode,
        currency: eligibility.offer.currency,
        indicativeUnitPriceMinor: price?.unitPriceMinor ?? null,
        indicativeTotalMinor: price?.goodsTotalMinor ?? null,
        indicativeTierMinBaseUnits: price?.tierMinBaseUnits ?? null,
        displayCurrency: conversion?.toCurrency ?? null,
        fxSnapshotId: conversion?.snapshotId ?? null,
        fxRate: conversion?.rate ?? null,
        fxRateAsOf: conversion?.asOf ?? null,
        expiresAt,
        submittedAt: now,
      },
    });

    await tx.preorderStatusHistory.create({
      data: {
        id: newId(),
        requestId: id,
        fromStatus: null,
        toStatus: 'SUBMITTED',
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorLabel: `${assessment.buyer.fullName} (${assessment.buyer.organization})`.slice(0, 160),
        reason: 'Preorder requested',
      },
    });

    await notifySupplier({
      requestNumber: number,
      sellerAccountId: eligibility.offer.sellerAccountId,
      kind: 'PREORDER_REQUEST_RECEIVED',
      class: 'ALERT',
      resolutionKey: `preorder:${id}:seller`,
      severity: 'WARNING',
      title: `Preorder ${number}: ${formatCount(assessment.baseUnits)} of ${label}`,
      body:
        `${assessment.buyer.organization} asked for delivery by ${assessment.requestedDay}. ` +
        (assessment.availability.shortfall.sufficient
          ? ''
          : `Only ${formatCount(assessment.availability.shortfall.availableNow)} are available now: propose a revised date or a split delivery. `) +
        `Answer by ${expiresAt.toISOString().slice(0, 10)}.`,
      linkPath: `/seller/preorders/${id}`,
      subjectType: 'preorder_request',
      subjectId: id,
      dedupeKey: `preorder:${id}:submitted`,
      tx,
    });

    await enqueueNotification(
      {
        eventKey: NotificationEvent.PREORDER_SUBMITTED,
        recipientEmail: assessment.buyer.email,
        recipientName: assessment.buyer.fullName,
        variables: {
          requestNumber: number,
          quantity: `${formatCount(assessment.baseUnits)} pieces`,
          productName: label,
          sellerName: eligibility.offer.sellerDisplayName,
          requestedDate: assessment.requestedDay,
          preorderUrl: preorderUrl(id),
        },
        dedupeKey: `preorder:${id}:submitted`,
        relatedType: 'preorder_request',
        relatedId: id,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.PREORDER_SUBMITTED,
        resourceType: 'preorder_request',
        resourceId: id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          requestNumber: number,
          offerId: eligibility.offer.id,
          baseUnits: assessment.baseUnits,
          orderingUnit: input.orderingUnit,
          unitQuantity: input.unitQuantity,
          unitsPerPackage: assessment.unitsPerPackage,
          containerLoadingVersion: assessment.container?.version ?? null,
          availableToPromise: assessment.availability.availableToPromise,
          shortfall: assessment.availability.shortfall.remaining,
          requestedDeliveryDate: assessment.requestedDay,
          policyId: policy.id,
          policyVersion: policy.version,
          indicativeTotalMinor: price?.goodsTotalMinor ?? null,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return number;
  });

  await dispatchPendingNotifications();

  logger.info({ preorderId: id, requestNumber }, 'preorder submitted');
  return getBuyerPreorder(actor.customerProfileId, id);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const REQUEST_INCLUDE = {
  offers: {
    orderBy: { revision: 'asc' as const },
    include: { installments: { orderBy: { sequence: 'asc' as const } } },
  },
  history: { orderBy: { createdAt: 'asc' as const } },
  stockHolds: { orderBy: { createdAt: 'asc' as const } },
  sellerAccount: { select: { displayName: true } },
  customerProfile: {
    select: {
      fullName: true,
      organization: true,
      gstin: true,
      vatNumber: true,
      vatNumberValid: true,
    },
  },
  offer: { select: { sellerSku: true } },
  convertedOrder: {
    select: { id: true, orderNumber: true, status: true, grandTotalMinor: true, currency: true },
  },
};

type RequestRow = NonNullable<Awaited<ReturnType<typeof loadRequest>>>;

async function loadRequest(id: string) {
  return prisma.preorderRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
}

function dayOrNull(value: Date | null): CalendarDay | null {
  return value === null ? null : fromDateColumn(value);
}

/**
 * A piece count in the unit the buyer ordered in, WITHOUT rounding: whole
 * units and the pieces left over. Null for a piece order.
 */
function unitEquivalent(
  pieces: number,
  request: { orderingUnit: string; unitsPerPackage: number },
): { unit: string; fullUnits: number; remainderPieces: number; isWholeUnits: boolean } | null {
  if (request.orderingUnit === 'PIECE' || request.unitsPerPackage <= 1) return null;
  const equivalent = containerEquivalent(pieces, request.unitsPerPackage);
  return {
    unit: request.orderingUnit,
    fullUnits: equivalent.fullContainers,
    remainderPieces: equivalent.remainderPieces,
    isWholeUnits: equivalent.isWholeContainers,
  };
}

function serialiseOffer(
  offer: RequestRow['offers'][number],
  request: { orderingUnit: string; unitsPerPackage: number },
) {
  return {
    id: offer.id,
    revision: offer.revision,
    author: offer.author,
    kind: offer.kind,
    state: offer.state,
    quantityBaseUnits: offer.quantityBaseUnits,
    quantityInOrderedUnit: unitEquivalent(offer.quantityBaseUnits, request),
    /** What was available to promise when the seller wrote these terms. */
    availableNowBaseUnits: offer.availableNowBaseUnits,
    /** Pieces these terms take from stock on hand at acceptance. */
    stockAllocationBaseUnits: offer.stockAllocationBaseUnits,
    installments: offer.installments.map((part) => ({
      sequence: part.sequence,
      quantityBaseUnits: part.quantityBaseUnits,
      committedDeliveryDate: fromDateColumn(part.committedDeliveryDate),
      source: part.source,
      status: part.status,
      quantityInOrderedUnit: unitEquivalent(part.quantityBaseUnits, request),
    })),
    unitPrice: serialiseMoney(offer.unitPriceMinor, offer.currency),
    goodsTotal: serialiseMoney(offer.goodsTotalMinor, offer.currency),
    freight: serialiseMoney(offer.freightMinor, offer.currency),
    total: serialiseMoney(offer.goodsTotalMinor + offer.freightMinor, offer.currency),
    currency: offer.currency,
    committedDeliveryDate: fromDateColumn(offer.committedDeliveryDate),
    deliverySplits: offer.deliverySplitsJson,
    note: offer.note,
    expiresAt: offer.expiresAt.toISOString(),
    termsHash: offer.termsHash,
    createdByLabel: offer.createdByLabel,
    createdAt: offer.createdAt.toISOString(),
    respondedAt: offer.respondedAt?.toISOString() ?? null,
    respondedByLabel: offer.respondedByLabel,
    responseNote: offer.responseNote,
  };
}

async function serialiseRequest(
  row: RequestRow,
  audience: 'BUYER' | 'SELLER' | 'ADMIN',
): Promise<Record<string, unknown>> {
  const label = await productLabel(row.productId, row.variantId);
  const product = await prisma.product.findUnique({
    where: { id: row.productId },
    select: {
      slug: true,
      sku: true,
      media: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
        select: { media: { select: { url: true } } },
      },
    },
  });

  const current = row.offers.find((offer) => offer.id === row.currentOfferId) ?? null;

  // Live stock for the seller's screen, and for the check that tells the buyer
  // before they press Accept that the stock the terms were built on has gone.
  const live: OfferAvailability | null =
    row.offerId === null || isTerminalPreorderStatus(row.status)
      ? null
      : await offerAvailability({
          offerId: row.offerId,
          eligibleLocationIds: policyLocations(row.policySnapshotJson),
          safetyStock: policySafetyStock(row.policySnapshotJson),
        });

  const quote =
    current === null || current.state !== 'PROPOSED'
      ? null
      : await priceTerms(row, current, {
          vatNumber: row.customerProfile.vatNumber,
          vatNumberValid: row.customerProfile.vatNumberValid,
        });

  const snapshot = row.containerLoadingSnapshotJson as Record<string, unknown> | null;

  // On the operator's own product, staff ARE the supplier: the admin view
  // offers them the supplier's actions. On a seller's, staff only read.
  const operatorSupplies = row.sellerAccountId === null;
  const actor: PreorderActorKind =
    audience === 'BUYER' ? 'BUYER' : audience === 'SELLER' || operatorSupplies ? 'SELLER' : 'ADMIN';
  const supplierName =
    row.sellerAccount?.displayName ??
    (await prisma.businessProfile.findFirst({ select: { displayName: true } }))?.displayName ??
    'The store';

  const requestedDay = fromDateColumn(row.requestedDeliveryDate);

  return {
    id: row.id,
    requestNumber: row.requestNumber,
    status: row.status,
    allowedActions: allowedPreorderTransitions(row.status, actor),
    awaiting: AWAITING_SELLER.includes(row.status)
      ? 'SELLER'
      : AWAITING_BUYER.includes(row.status) || row.status === 'PAYMENT_REQUIRED'
        ? 'BUYER'
        : null,
    product: {
      id: row.productId,
      variantId: row.variantId,
      name: label,
      slug: product?.slug ?? null,
      sku: row.offer?.sellerSku ?? product?.sku ?? null,
      imageUrl: product?.media[0]?.media.url ?? null,
    },
    seller: { id: row.sellerAccountId, name: supplierName },
    /** Who answers: a seller in Seller Hub, or the operator's staff. */
    supplier: operatorSupplies ? 'OPERATOR' : 'SELLER',
    buyer:
      audience === 'BUYER'
        ? null
        : {
            name: row.customerProfile.fullName,
            organization: row.customerProfile.organization,
            taxNumber: row.customerProfile.gstin ?? row.customerProfile.vatNumber,
          },
    quantity: {
      orderingUnit: row.orderingUnit,
      unitQuantity: row.unitQuantity,
      unitsPerPackage: row.unitsPerPackage,
      baseUnits: row.requestedBaseUnits,
    },
    /**
     * The container loading this request was made under - its own snapshot,
     * never the listing's live figure.
     */
    container:
      snapshot === null
        ? null
        : {
            unit: row.orderingUnit,
            containers: row.unitQuantity,
            piecesPerContainer: row.unitsPerPackage,
            totalPieces: row.requestedBaseUnits,
            cartonsPerContainer: snapshot['cartonsPerContainer'] ?? null,
            piecesPerCarton: snapshot['piecesPerCarton'] ?? null,
            verifiedAt: snapshot['verifiedAt'] ?? null,
            version: row.containerLoadingVersion,
          },
    availability: {
      atSubmission: {
        requested: row.requestedBaseUnits,
        availableNow: row.requestedBaseUnits - row.shortfallAtSubmission,
        remaining: row.shortfallAtSubmission,
        sufficient: row.shortfallAtSubmission === 0,
      },
      // The seller's own stock, now. Never shown to a buyer, and never a
      // location to anybody but the seller.
      live:
        live === null || audience === 'BUYER'
          ? null
          : {
              availableToPromise: live.availableToPromise,
              onHand: live.onHand,
              unacceptedOrderQuantity: live.unacceptedOrderQuantity,
              safetyStock: live.safetyStock,
              shortfall: assessShortfall(row.requestedBaseUnits, live.availableToPromise),
              ...(audience === 'SELLER' ? { byLocation: live.byLocation } : {}),
            },
    },
    /** Stock held for this preorder in the seller's inventory. */
    stockHolds:
      audience === 'BUYER'
        ? null
        : row.stockHolds.map((hold) => ({
            quantityBaseUnits: hold.quantityBaseUnits,
            status: hold.status,
            ...(audience === 'SELLER' ? { locationId: hold.locationId } : {}),
            createdAt: hold.createdAt.toISOString(),
            releasedAt: hold.releasedAt?.toISOString() ?? null,
          })),
    policy: { ...(row.policySnapshotJson as Record<string, unknown>), version: row.policyVersion },
    requestedDeliveryDate: requestedDay,
    earliestDeliveryDate: fromDateColumn(row.earliestDeliveryDate),
    timezone: row.timezone,
    shippingAddress: row.shippingAddressJson,
    destinationCountry: row.destinationCountry,
    destinationWarehouseLabel: row.destinationWarehouseLabel,
    packagingPreference: row.packagingPreference,
    transportPreference: row.transportPreference,
    allowPartialDelivery: row.allowPartialDelivery,
    purchaseOrderReference: row.purchaseOrderReference,
    customerNotes: row.customerNotes,
    handlingInstructions: row.handlingInstructions,
    pricingMode: row.pricingMode,
    currency: row.currency,
    indicative: {
      unitPrice: money(row.indicativeUnitPriceMinor, row.currency),
      goodsTotal: money(row.indicativeTotalMinor, row.currency),
      tierMinBaseUnits: row.indicativeTierMinBaseUnits,
      displayCurrency: row.displayCurrency,
      fxRate: row.fxRate,
      fxRateAsOf: row.fxRateAsOf?.toISOString() ?? null,
    },
    currentOffer:
      current === null
        ? null
        : {
            ...serialiseOffer(current, row),
            /**
             * The whole price of these terms through the one pricing engine:
             * goods, tax for this delivery, the seller's quoted delivery and
             * the grand total - the figures an order would be created with.
             * Null with a reason where tax cannot be worked out.
             */
            quote:
              quote === null
                ? null
                : quote.ok
                  ? {
                      subtotal: serialiseMoney(
                        quote.pricing.totals.subtotalMinor,
                        current.currency,
                      ),
                      discount: serialiseMoney(
                        quote.pricing.totals.discountMinor,
                        current.currency,
                      ),
                      tax: serialiseMoney(quote.pricing.totals.taxMinor, current.currency),
                      shipping: serialiseMoney(
                        quote.pricing.totals.shippingMinor,
                        current.currency,
                      ),
                      grandTotal: serialiseMoney(
                        quote.pricing.totals.grandTotalMinor,
                        current.currency,
                      ),
                      taxRatePercent: quote.lineTax.taxRatePercent,
                      taxInclusive: quote.lineTax.taxInclusive,
                      // Zero freight means the seller included delivery.
                      logisticsIncluded: current.freightMinor === 0n,
                    }
                  : { unavailable: quote.problem },
            /**
             * Whether the stock these terms take is still there. False means
             * accepting will be refused and the seller asked again - said
             * BEFORE the buyer presses the button.
             */
            stockStillAvailable:
              current.stockAllocationBaseUnits <= 0 || live === null
                ? true
                : live.availableToPromise >= current.stockAllocationBaseUnits,
            isExpired: current.expiresAt.getTime() < Date.now(),
          },
    offers: row.offers.map((offer) => serialiseOffer(offer, row)),
    confirmed:
      row.confirmedTermsHash === null
        ? null
        : {
            termsHash: row.confirmedTermsHash,
            baseUnits: row.confirmedBaseUnits,
            unitPrice: money(row.confirmedUnitPriceMinor, row.currency),
            freight: money(row.confirmedFreightMinor, row.currency),
            goodsTotal: money(row.confirmedGoodsTotalMinor, row.currency),
            committedDeliveryDate: dayOrNull(row.committedDeliveryDate),
            terms: row.confirmedTermsJson,
          },
    order:
      row.convertedOrder === null
        ? null
        : {
            id: row.convertedOrder.id,
            orderNumber: row.convertedOrder.orderNumber,
            status: row.convertedOrder.status,
            grandTotal: serialiseMoney(
              row.convertedOrder.grandTotalMinor,
              row.convertedOrder.currency,
            ),
          },
    // The seller's own part of that order, which is what Seller Hub opens -
    // and where accepting it hands the preorder to fulfilment. Null until
    // payment has confirmed the order and split it.
    sellerOrderGroupId:
      audience === 'BUYER' || row.convertedOrderId === null || row.sellerAccountId === null
        ? null
        : ((
            await prisma.sellerOrderGroup.findUnique({
              where: {
                orderId_sellerAccountId: {
                  orderId: row.convertedOrderId,
                  sellerAccountId: row.sellerAccountId,
                },
              },
              select: { id: true },
            })
          )?.id ?? null),
    capacity:
      audience === 'BUYER'
        ? null
        : await capacityImpact(
            row.policyId,
            current === null ? requestedDay : fromDateColumn(current.committedDeliveryDate),
            current?.quantityBaseUnits ?? row.requestedBaseUnits,
          ),
    capacityReservedBaseUnits: audience === 'BUYER' ? null : row.capacityReservedBaseUnits,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    closedReason: row.closedReason,
    history: row.history.map((entry) => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      actorLabel: entry.actorLabel,
      reason: entry.reason,
      at: entry.createdAt.toISOString(),
    })),
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
  };
}

export async function getBuyerPreorder(
  customerProfileId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await loadRequest(id);
  // Somebody else's preorder answers exactly as a missing one: no existence
  // oracle across buyers.
  if (row === null || row.customerProfileId !== customerProfileId) throw notFound('Preorder');
  return serialiseRequest(row, 'BUYER');
}

export async function getSellerPreorder(
  sellerAccountId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const row = await loadRequest(id);
  if (row === null || row.sellerAccountId !== sellerAccountId) throw notFound('Preorder');
  return serialiseRequest(row, 'SELLER');
}

export async function getAdminPreorder(id: string): Promise<Record<string, unknown>> {
  const row = await loadRequest(id);
  if (row === null) throw notFound('Preorder');
  return serialiseRequest(row, 'ADMIN');
}

/** The seller inbox's filters, each a set of statuses. */
export const SELLER_FILTERS: Readonly<Record<string, readonly PreorderStatusName[]>> =
  Object.freeze({
    new: ['SUBMITTED'],
    awaiting_seller: ['SUBMITTED', 'SELLER_REVIEW_REQUIRED'],
    countered: ['SELLER_COUNTERED'],
    awaiting_buyer: ['SELLER_ACCEPTED', 'SELLER_COUNTERED', 'PAYMENT_REQUIRED'],
    confirmed: ['CONFIRMED', 'READY_FOR_FULFILLMENT'],
    in_production: ['IN_PRODUCTION'],
    converted: ['CONVERTED_TO_ORDER'],
    rejected: ['REJECTED'],
    expired: ['EXPIRED'],
    cancelled: ['CANCELLED'],
  });

function listItem(
  row: {
    id: string;
    requestNumber: string;
    status: PreorderStatusName;
    requestedBaseUnits: number;
    requestedDeliveryDate: Date;
    committedDeliveryDate: Date | null;
    currency: string;
    indicativeTotalMinor: bigint | null;
    confirmedGoodsTotalMinor: bigint | null;
    expiresAt: Date | null;
    submittedAt: Date;
    updatedAt: Date;
    productId: string;
    variantId: string | null;
    orderingUnit: string;
    unitQuantity: number;
    shortfallAtSubmission: number;
  },
  extra: Record<string, unknown>,
) {
  return {
    id: row.id,
    requestNumber: row.requestNumber,
    status: row.status,
    baseUnits: row.requestedBaseUnits,
    orderingUnit: row.orderingUnit,
    unitQuantity: row.unitQuantity,
    /** Pieces short of available-to-promise when it was asked for. 0 = enough. */
    shortfallAtSubmission: row.shortfallAtSubmission,
    requestedDeliveryDate: fromDateColumn(row.requestedDeliveryDate),
    committedDeliveryDate: dayOrNull(row.committedDeliveryDate),
    value: money(row.confirmedGoodsTotalMinor ?? row.indicativeTotalMinor, row.currency),
    expiresAt: row.expiresAt?.toISOString() ?? null,
    submittedAt: row.submittedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...extra,
  };
}

export async function listSellerPreorders(
  sellerAccountId: string,
  filter: string | null,
): Promise<Record<string, unknown>> {
  const statuses = filter === null ? null : (SELLER_FILTERS[filter] ?? null);
  if (filter !== null && statuses === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown filter.', [
      { field: 'filter', code: 'INVALID' },
    ]);
  }

  const [rows, grouped] = await Promise.all([
    prisma.preorderRequest.findMany({
      where: { sellerAccountId, ...(statuses === null ? {} : { status: { in: [...statuses] } }) },
      orderBy: { updatedAt: 'desc' },
      take: 200,
      include: { customerProfile: { select: { organization: true, fullName: true } } },
    }),
    prisma.preorderRequest.groupBy({
      by: ['status'],
      where: { sellerAccountId },
      _count: { _all: true },
    }),
  ]);

  const byStatus = new Map(grouped.map((group) => [group.status, group._count._all]));
  const counts = Object.fromEntries(
    Object.entries(SELLER_FILTERS).map(([key, set]) => [
      key,
      set.reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0),
    ]),
  );

  const labels = await Promise.all(rows.map((row) => productLabel(row.productId, row.variantId)));

  return {
    counts,
    preorders: rows.map((row, index) =>
      listItem(row, {
        productName: labels[index],
        buyerOrganization: row.customerProfile.organization ?? row.customerProfile.fullName,
      }),
    ),
  };
}

export async function listBuyerPreorders(
  customerProfileId: string,
): Promise<Record<string, unknown>> {
  const rows = await prisma.preorderRequest.findMany({
    where: { customerProfileId },
    orderBy: { createdAt: 'desc' },
    take: 200,
    include: { sellerAccount: { select: { displayName: true } } },
  });
  const labels = await Promise.all(rows.map((row) => productLabel(row.productId, row.variantId)));
  const store = await storeName();
  return {
    preorders: rows.map((row, index) =>
      listItem(row, {
        productName: labels[index],
        sellerName: row.sellerAccount?.displayName ?? store,
      }),
    ),
  };
}

/** Who the buyer is told supplies a preorder: the seller, or the store itself. */
async function supplierNameFor(
  sellerAccountId: string | null,
  client: PrismaTransaction = prisma,
): Promise<string> {
  if (sellerAccountId === null) return storeName();
  const seller = await client.sellerAccount.findUniqueOrThrow({
    where: { id: sellerAccountId },
    select: { displayName: true },
  });
  return seller.displayName;
}

/** The operator's trading name: who supplies a preorder on its own products. */
async function storeName(): Promise<string> {
  const profile = await prisma.businessProfile.findFirst({ select: { displayName: true } });
  return profile?.displayName ?? 'The store';
}

export async function listAdminPreorders(input: {
  status: PreorderStatusName | null;
  /** OPERATOR: only the preorders on the operator's own products - staff's to answer. */
  supplier?: 'OPERATOR' | 'SELLER' | null;
}): Promise<Record<string, unknown>> {
  const rows = await prisma.preorderRequest.findMany({
    where: {
      ...(input.status === null ? {} : { status: input.status }),
      ...(input.supplier === 'OPERATOR'
        ? { sellerAccountId: null }
        : input.supplier === 'SELLER'
          ? { sellerAccountId: { not: null } }
          : {}),
    },
    orderBy: { updatedAt: 'desc' },
    take: 200,
    include: {
      sellerAccount: { select: { displayName: true } },
      customerProfile: { select: { organization: true, fullName: true } },
    },
  });
  const labels = await Promise.all(rows.map((row) => productLabel(row.productId, row.variantId)));
  const store = await storeName();
  return {
    preorders: rows.map((row, index) => ({
      ...listItem(row, {
        productName: labels[index],
        sellerName: row.sellerAccount?.displayName ?? store,
        buyerOrganization: row.customerProfile.organization ?? row.customerProfile.fullName,
      }),
      supplier: row.sellerAccountId === null ? 'OPERATOR' : 'SELLER',
    })),
  };
}

// ---------------------------------------------------------------------------
// The seller's answer
// ---------------------------------------------------------------------------

const splitSchema = z
  .array(z.object({ date: calendarDay, baseUnits: z.number().int().positive() }))
  .max(24);

export const sellerAcceptSchema = z
  .object({
    /** Required under QUOTE_REQUIRED; must equal the indicative price under FIXED. */
    unitPriceMinor: minorString.nullable().default(null),
    freightMinor: minorString,
    /** Defaults to the date the buyer asked for. */
    committedDeliveryDate: calendarDay.nullable().default(null),
    originLocationId: z.string().length(26).nullable().default(null),
    note: z.string().trim().max(2000).nullable().default(null),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const sellerCounterSchema = z
  .object({
    quantityBaseUnits: z.number().int().positive().max(1_000_000_000),
    unitPriceMinor: minorString,
    freightMinor: minorString,
    committedDeliveryDate: calendarDay,
    deliverySplits: splitSchema.nullable().default(null),
    originLocationId: z.string().length(26).nullable().default(null),
    note: z.string().trim().max(2000).nullable().default(null),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export const reasonSchema = z
  .object({
    reason: z.string().trim().min(3).max(1000),
    expectedVersion: z.number().int().min(0).optional(),
  })
  .strict();

async function loadForSupplier(responder: Responder, id: string, expectedVersion?: number) {
  const row = await prisma.preorderRequest.findUnique({ where: { id } });
  // A seller's id for a seller, NULL for staff: neither can reach the other's.
  if (row === null || row.sellerAccountId !== responder.sellerAccountId) throw notFound('Preorder');
  if (expectedVersion !== undefined && row.version !== expectedVersion) {
    throw conflict(
      ErrorCode.PREORDER_TRANSITION_NOT_ALLOWED,
      'This preorder changed since you opened it. Reload it to see the latest.',
      [{ code: 'STALE' }],
    );
  }
  return row;
}

async function assertOwnLocation(responder: Responder, locationId: string | null): Promise<void> {
  if (locationId === null) return;
  if (responder.kind === 'OPERATOR') {
    // Staff ship from one of the operator's own warehouses.
    const warehouse = await prisma.inventoryLocation.findUnique({
      where: { id: locationId },
      select: { id: true },
    });
    if (warehouse === null) throw notFound('Location');
    return;
  }
  const location = await prisma.sellerLocation.findUnique({
    where: { id: locationId },
    select: { sellerAccountId: true },
  });
  if (location === null || location.sellerAccountId !== responder.sellerAccountId) {
    throw notFound('Location');
  }
}

/**
 * The seller's terms, as a new revision. Shared by accept and counter: the
 * two differ only in which figures the seller may choose.
 */
async function propose(
  responder: Responder,
  request: NonNullable<Awaited<ReturnType<typeof prisma.preorderRequest.findUnique>>>,
  terms: {
    kind: 'ACCEPT_AS_REQUESTED' | 'COUNTER' | AvailabilityProposalKind;
    quantityBaseUnits: number;
    unitPriceMinor: bigint;
    freightMinor: bigint;
    committedDay: CalendarDay;
    splits: { date: CalendarDay; baseUnits: number }[] | null;
    originLocationId: string | null;
    note: string | null;
    /** A revised-date or split-delivery answer, already validated. */
    fulfilment?: {
      installments: PlannedInstallment[];
      stockAllocationBaseUnits: number;
      availableNowBaseUnits: number;
      expiresAt: Date;
    };
  },
): Promise<Record<string, unknown>> {
  // Where the request stands decides first. A seller revising terms on a
  // preorder that is already paid for is told that, not that their capacity
  // is short - the capacity is irrelevant to a request they cannot change.
  assertPreorderTransition({
    from: request.status,
    to: terms.kind === 'ACCEPT_AS_REQUESTED' ? 'SELLER_ACCEPTED' : 'SELLER_COUNTERED',
    actor: 'SELLER',
  });

  if (terms.unitPriceMinor <= 0n) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The price per piece must be above zero.', [
      { field: 'unitPriceMinor', code: 'INVALID' },
    ]);
  }

  // The committed date is a promise to the BUYER, on the buyer's clock, and
  // it can be no sooner than the platform's notice - a seller cannot commit
  // to a delivery the buyer could not have asked for.
  const floor = addCalendarDays(
    todayIn(request.timezone),
    Math.max(1, Math.max(env.PREORDER_MIN_NOTICE_DAYS, env.SCHEDULE_MIN_NOTICE_DAYS)),
  );
  if (terms.committedDay < floor) {
    throw badRequest(
      ErrorCode.PREORDER_DATE_TOO_EARLY,
      `The earliest date you can commit to is ${floor}.`,
      [{ field: 'committedDeliveryDate', code: 'TOO_EARLY', meta: { earliest: floor } }],
    );
  }

  if (terms.splits !== null) {
    const policy = request.policySnapshotJson as { allowSplitDelivery?: boolean };
    // A split-delivery PROPOSAL is its own answer to a shortfall, and the
    // buyer accepts or refuses it explicitly; the policy switch governs splits
    // offered inside an ordinary counter.
    if (
      terms.fulfilment === undefined &&
      policy.allowSplitDelivery !== true &&
      !request.allowPartialDelivery
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Split delivery is not allowed on this preorder: neither your terms nor the buyer allow it.',
        [{ field: 'deliverySplits', code: 'NOT_ALLOWED' }],
      );
    }
    const problem = checkDeliverySplits(terms.splits, terms.quantityBaseUnits, terms.committedDay);
    if (problem !== null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, problem, [
        { field: 'deliverySplits', code: 'INVALID' },
      ]);
    }
    if ((terms.splits[0]?.date ?? floor) < floor) {
      throw badRequest(
        ErrorCode.PREORDER_DATE_TOO_EARLY,
        `The earliest date you can commit to is ${floor}.`,
        [{ field: 'deliverySplits', code: 'TOO_EARLY', meta: { earliest: floor } }],
      );
    }
  }

  await assertOwnLocation(responder, terms.originLocationId);

  // Refuse a promise the seller's own capacity cannot keep today. The hold is
  // taken atomically at the buyer's confirmation; this is so the seller is
  // told now rather than the buyer being refused later.
  // Stock already on the shelf is not production: only what is still to be
  // made counts against the seller's capacity.
  const impact = await capacityImpact(
    request.policyId,
    terms.committedDay,
    terms.quantityBaseUnits - (terms.fulfilment?.stockAllocationBaseUnits ?? 0),
  );
  if (impact !== null && impact['fits'] === false) {
    throw conflict(
      ErrorCode.PREORDER_CAPACITY_EXCEEDED,
      `You have ${formatCount(Number(impact['availableBaseUnits']))} pieces of capacity left for that period.`,
      [
        {
          code: 'CAPACITY',
          meta: {
            availableBaseUnits: Number(impact['availableBaseUnits']),
            periodKey: String(impact['periodKey']),
          },
        },
      ],
    );
  }

  const goodsTotalMinor = terms.unitPriceMinor * BigInt(terms.quantityBaseUnits);
  const revision = (await prisma.preorderOffer.count({ where: { requestId: request.id } })) + 1;
  const offerId = newId();
  const expiresAt =
    terms.fulfilment?.expiresAt ??
    hoursFromNow(
      (request.policySnapshotJson as { offerExpiryHours?: number | null }).offerExpiryHours ??
        env.PREORDER_OFFER_EXPIRY_HOURS,
    );
  const proposalKind =
    terms.kind === 'FULL_ON_REVISED_DATE' || terms.kind === 'SPLIT_DELIVERY' ? terms.kind : null;

  const canonical: PreorderTerms = {
    requestId: request.id,
    revision,
    quantityBaseUnits: terms.quantityBaseUnits,
    unitPriceMinor: terms.unitPriceMinor,
    goodsTotalMinor,
    freightMinor: terms.freightMinor,
    currency: request.currency,
    committedDeliveryDate: terms.committedDay,
    deliverySplits: terms.splits,
    ...(proposalKind === null || terms.fulfilment === undefined
      ? {}
      : {
          fulfilment: {
            kind: proposalKind,
            stockAllocationBaseUnits: terms.fulfilment.stockAllocationBaseUnits,
            installments: terms.fulfilment.installments,
          },
        }),
  };
  const hash = termsHash(canonical);

  const to: PreorderStatusName =
    terms.kind === 'ACCEPT_AS_REQUESTED' ? 'SELLER_ACCEPTED' : 'SELLER_COUNTERED';
  const actor = responderActor(responder);

  const buyer = await prisma.customerProfile.findUniqueOrThrow({
    where: { id: request.customerProfileId },
    select: { fullName: true, user: { select: { email: true } } },
  });
  const label = await productLabel(request.productId, request.variantId);

  await prisma.$transaction(async (tx) => {
    await move(tx, request, to, actor, {
      data: {
        currentOfferId: offerId,
        sellerRespondedAt: new Date(),
        expiresAt,
      },
      reason: terms.note,
      meta: { revision, termsHash: hash },
    });

    await tx.preorderOffer.updateMany({
      where: { requestId: request.id, state: 'PROPOSED' },
      data: { state: 'SUPERSEDED' },
    });
    await tx.preorderFulfilmentInstallment.updateMany({
      where: { requestId: request.id, status: 'PROPOSED' },
      data: { status: 'CANCELLED' },
    });

    await tx.preorderOffer.create({
      data: {
        id: offerId,
        requestId: request.id,
        sellerAccountId: request.sellerAccountId,
        revision,
        author: 'SELLER',
        kind: terms.kind,
        quantityBaseUnits: terms.quantityBaseUnits,
        unitPriceMinor: terms.unitPriceMinor,
        goodsTotalMinor,
        freightMinor: terms.freightMinor,
        currency: request.currency,
        committedDeliveryDate: toDateColumn(terms.committedDay),
        deliverySplitsJson: (terms.splits ?? undefined) as never,
        originLocationId: terms.originLocationId,
        availableNowBaseUnits: terms.fulfilment?.availableNowBaseUnits ?? null,
        stockAllocationBaseUnits: terms.fulfilment?.stockAllocationBaseUnits ?? 0,
        note: terms.note,
        expiresAt,
        termsHash: hash,
        createdByLabel: actor.label,
      },
    });

    if (terms.fulfilment !== undefined) {
      await tx.preorderFulfilmentInstallment.createMany({
        data: terms.fulfilment.installments.map((part) => ({
          id: newId(),
          requestId: request.id,
          offerId,
          sequence: part.sequence,
          quantityBaseUnits: part.baseUnits,
          committedDeliveryDate: toDateColumn(part.date),
          source: part.source,
        })),
      });
      // A CHECK cannot see across rows, so the one rule that spans them is
      // proved here, inside the transaction that wrote them: the schedule adds
      // up to exactly the quantity of the terms it belongs to.
      const written = await tx.preorderFulfilmentInstallment.aggregate({
        where: { offerId },
        _sum: { quantityBaseUnits: true },
      });
      if ((written._sum.quantityBaseUnits ?? 0) !== terms.quantityBaseUnits) {
        throw new Error('preorder installments do not add up to the offer quantity');
      }
    }

    await resolveSupplierNotifications(
      { resolutionKey: `preorder:${request.id}:seller`, note: 'Answered' },
      tx,
    );

    const total = serialiseMoney(goodsTotalMinor + terms.freightMinor, request.currency).formatted;

    await enqueueNotification(
      {
        eventKey:
          proposalKind !== null
            ? NotificationEvent.PREORDER_AVAILABILITY_PROPOSED
            : terms.kind === 'ACCEPT_AS_REQUESTED'
              ? NotificationEvent.PREORDER_SELLER_ACCEPTED
              : NotificationEvent.PREORDER_SELLER_COUNTERED,
        recipientEmail: buyer.user.email,
        recipientName: buyer.fullName,
        variables: {
          requestNumber: request.requestNumber,
          sellerName: responder.displayName,
          quantity: `${formatCount(terms.quantityBaseUnits)} pieces`,
          productName: label,
          committedDate: terms.committedDay,
          schedule: (terms.fulfilment?.installments ?? [])
            .map(
              (part) =>
                `  Shipment ${String(part.sequence)}: ${formatCount(part.baseUnits)} pieces, delivered by ${part.date}`,
            )
            .join('\n'),
          unitPrice: serialiseMoney(terms.unitPriceMinor, request.currency).formatted,
          total: `${total} ${request.currency}`,
          expiresAt: expiresAt.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
          preorderUrl: preorderUrl(request.id),
        },
        dedupeKey: `preorder:${request.id}:offer:${String(revision)}`,
        relatedType: 'preorder_request',
        relatedId: request.id,
      },
      tx,
    );

    await recordAudit(
      {
        action:
          proposalKind !== null
            ? AuditAction.PREORDER_AVAILABILITY_PROPOSED
            : terms.kind === 'ACCEPT_AS_REQUESTED'
              ? AuditAction.PREORDER_SELLER_ACCEPTED
              : AuditAction.PREORDER_SELLER_COUNTERED,
        resourceType: 'preorder_request',
        resourceId: request.id,
        actorType: responder.kind === 'OPERATOR' ? 'ADMIN' : 'CUSTOMER',
        actorUserId: responder.userId,
        actorEmail: responder.staffEmail,
        after: {
          revision,
          termsHash: hash,
          quantityBaseUnits: terms.quantityBaseUnits,
          unitPriceMinor: terms.unitPriceMinor,
          freightMinor: terms.freightMinor,
          committedDeliveryDate: terms.committedDay,
          splits: terms.splits?.length ?? 0,
          kind: terms.kind,
          stockAllocationBaseUnits: terms.fulfilment?.stockAllocationBaseUnits ?? 0,
          availableNowBaseUnits: terms.fulfilment?.availableNowBaseUnits ?? null,
          installments:
            terms.fulfilment?.installments.map((part) => ({
              sequence: part.sequence,
              date: part.date,
              baseUnits: part.baseUnits,
              source: part.source,
            })) ?? null,
        },
      },
      tx,
    );

    await supplierAudit(tx, responder, {
      action:
        proposalKind !== null
          ? 'preorder.availability_proposed'
          : terms.kind === 'ACCEPT_AS_REQUESTED'
            ? 'preorder.accepted'
            : 'preorder.countered',
      requestId: request.id,
      after: {
        revision,
        termsHash: hash,
        kind: terms.kind,
        committedDeliveryDate: terms.committedDay,
        stockAllocationBaseUnits: terms.fulfilment?.stockAllocationBaseUnits ?? 0,
      },
      summary:
        proposalKind === 'FULL_ON_REVISED_DATE'
          ? `Proposed the complete quantity of preorder ${request.requestNumber} by ${terms.committedDay}`
          : proposalKind === 'SPLIT_DELIVERY'
            ? `Proposed a split delivery of preorder ${request.requestNumber} in ${String(terms.fulfilment?.installments.length ?? 0)} shipments`
            : `${terms.kind === 'ACCEPT_AS_REQUESTED' ? 'Accepted' : 'Countered'} preorder ${request.requestNumber}`,
    });
  });

  await dispatchPendingNotifications();
  return viewForSupplier(responder, request.id);
}

export async function sellerAccept(
  responder: Responder,
  id: string,
  input: z.infer<typeof sellerAcceptSchema>,
): Promise<Record<string, unknown>> {
  const request = await loadForSupplier(responder, id, input.expectedVersion);

  let unitPriceMinor: bigint;
  if (input.unitPriceMinor === null) {
    if (request.indicativeUnitPriceMinor === null) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Give a price per piece: these terms are quoted per request.',
        [{ field: 'unitPriceMinor', code: 'REQUIRED' }],
      );
    }
    unitPriceMinor = request.indicativeUnitPriceMinor;
  } else {
    unitPriceMinor = BigInt(input.unitPriceMinor);
    // Accepting "as requested" at a different price is a counter-offer, and
    // calling it an acceptance would tell the buyer they got what they asked
    // for when they did not.
    if (
      request.indicativeUnitPriceMinor !== null &&
      unitPriceMinor !== request.indicativeUnitPriceMinor
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'That price differs from the one the buyer was shown. Send it as a counter-offer instead.',
        [{ field: 'unitPriceMinor', code: 'DIFFERS' }],
      );
    }
  }

  const requestedDay = fromDateColumn(request.requestedDeliveryDate);
  const committedDay = input.committedDeliveryDate ?? requestedDay;
  if (committedDay !== requestedDay) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'That date differs from the one the buyer asked for. Send it as a counter-offer instead.',
      [{ field: 'committedDeliveryDate', code: 'DIFFERS' }],
    );
  }

  return propose(responder, request, {
    kind: 'ACCEPT_AS_REQUESTED',
    quantityBaseUnits: request.requestedBaseUnits,
    unitPriceMinor,
    freightMinor: BigInt(input.freightMinor),
    committedDay,
    splits: null,
    originLocationId: input.originLocationId,
    note: input.note === '' ? null : input.note,
  });
}

export async function sellerCounter(
  responder: Responder,
  id: string,
  input: z.infer<typeof sellerCounterSchema>,
): Promise<Record<string, unknown>> {
  const request = await loadForSupplier(responder, id, input.expectedVersion);

  return propose(responder, request, {
    kind: 'COUNTER',
    quantityBaseUnits: input.quantityBaseUnits,
    unitPriceMinor: BigInt(input.unitPriceMinor),
    freightMinor: BigInt(input.freightMinor),
    committedDay: input.committedDeliveryDate,
    splits: input.deliverySplits,
    originLocationId: input.originLocationId,
    note: input.note === '' ? null : input.note,
  });
}

// ---------------------------------------------------------------------------
// Availability proposals: more was asked for than is available to promise
// ---------------------------------------------------------------------------

const installmentSchema = z
  .object({
    date: z.string().max(10),
    baseUnits: z.number().int().max(1_000_000_000),
    source: z.enum(['AVAILABLE_STOCK', 'FUTURE_SUPPLY']).nullable().default(null),
  })
  .strict();

export const availabilityProposalSchema = z
  .object({
    kind: z.enum(['FULL_ON_REVISED_DATE', 'SPLIT_DELIVERY']),
    unitPriceMinor: minorString,
    /** The seller's delivery charge. Zero means included. */
    freightMinor: minorString,
    /** FULL_ON_REVISED_DATE: the committed date for the complete quantity. */
    revisedDate: z.string().max(10).nullable().default(null),
    /** FULL_ON_REVISED_DATE: hold what is on hand now for this buyer. */
    reserveAvailableStock: z.boolean().default(true),
    /** SPLIT_DELIVERY: two or more shipments, in date order. */
    installments: z.array(installmentSchema).max(30).nullable().default(null),
    /** When the offer lapses if the buyer has not answered. ISO 8601. */
    expiresAt: z.string().datetime({ offset: true }),
    originLocationId: z.string().length(26).nullable().default(null),
    /** Shown to the buyer. */
    note: z.string().trim().max(2000).nullable().default(null),
    expectedVersion: z.number().int().min(0),
  })
  .strict();

export type AvailabilityProposalInput = z.infer<typeof availabilityProposalSchema>;

/**
 * Everything a revised-date or split-delivery proposal comes to, checked
 * against LIVE stock - what the seller sees before sending, and what the save
 * is held to. Problems are returned, not thrown, for the preview.
 */
async function assessProposal(
  request: NonNullable<Awaited<ReturnType<typeof prisma.preorderRequest.findUnique>>>,
  input: AvailabilityProposalInput,
) {
  assertPreorderTransition({ from: request.status, to: 'SELLER_COUNTERED', actor: 'SELLER' });

  const live =
    request.offerId === null
      ? null
      : await offerAvailability({
          offerId: request.offerId,
          eligibleLocationIds: policyLocations(request.policySnapshotJson),
          safetyStock: policySafetyStock(request.policySnapshotJson),
        });
  // The operator's own products hold no seller stock to reserve against, so
  // everything is future supply for them.
  const atp = live?.availableToPromise ?? 0;

  const floor = addCalendarDays(
    todayIn(request.timezone),
    Math.max(1, Math.max(env.PREORDER_MIN_NOTICE_DAYS, env.SCHEDULE_MIN_NOTICE_DAYS)),
  );

  const result = validateAvailabilityProposal({
    kind: input.kind,
    totalBaseUnits: request.requestedBaseUnits,
    availableToPromise: atp,
    requestedDay: fromDateColumn(request.requestedDeliveryDate),
    floorDay: floor,
    revisedDate: input.revisedDate,
    reserveAvailableStock: input.reserveAvailableStock,
    installments: input.installments,
    expiresAt: new Date(input.expiresAt),
    now: new Date(),
    maxExpiryHours: env.PREORDER_PROPOSAL_MAX_EXPIRY_HOURS,
  });

  const problems = result.ok ? [] : [...result.problems];
  const unitPriceMinor = BigInt(input.unitPriceMinor);
  if (unitPriceMinor <= 0n) {
    problems.push({
      field: 'unitPriceMinor',
      code: 'PRICE_REQUIRED',
      message: 'The price per piece must be above zero.',
    });
  }

  return { result, problems, atp, unitPriceMinor, freightMinor: BigInt(input.freightMinor), floor };
}

/**
 * What the seller will be sending, before they send it: the schedule with its
 * container equivalents, the stock it takes, and the full price - goods, tax,
 * delivery and total - from the same pricing the buyer will be shown.
 */
export async function previewAvailabilityProposal(
  responder: Responder,
  id: string,
  input: AvailabilityProposalInput,
): Promise<Record<string, unknown>> {
  const request = await loadForSupplier(responder, id, input.expectedVersion);
  const { result, problems, atp, unitPriceMinor, freightMinor, floor } = await assessProposal(
    request,
    input,
  );

  const buyer = await prisma.customerProfile.findUniqueOrThrow({
    where: { id: request.customerProfileId },
    select: { vatNumber: true, vatNumberValid: true },
  });
  const priced =
    unitPriceMinor > 0n
      ? await priceTerms(
          request,
          { unitPriceMinor, quantityBaseUnits: request.requestedBaseUnits, freightMinor },
          buyer,
        )
      : null;

  const installments = result.ok ? result.installments : [];

  return {
    ok: problems.length === 0,
    problems,
    earliestCommitDate: floor,
    availability: {
      availableToPromise: atp,
      ...assessShortfall(request.requestedBaseUnits, atp),
    },
    stockAllocationBaseUnits: result.ok ? result.stockAllocationBaseUnits : null,
    committedDeliveryDate: result.ok ? result.committedDate : null,
    installments: installments.map((part) => ({
      sequence: part.sequence,
      date: part.date,
      baseUnits: part.baseUnits,
      source: part.source,
      quantityInOrderedUnit: unitEquivalent(part.baseUnits, request),
    })),
    goodsTotal: serialiseMoney(
      unitPriceMinor * BigInt(request.requestedBaseUnits),
      request.currency,
    ),
    freight: serialiseMoney(freightMinor, request.currency),
    quote:
      priced === null
        ? null
        : priced.ok
          ? {
              subtotal: serialiseMoney(priced.pricing.totals.subtotalMinor, request.currency),
              tax: serialiseMoney(priced.pricing.totals.taxMinor, request.currency),
              shipping: serialiseMoney(priced.pricing.totals.shippingMinor, request.currency),
              grandTotal: serialiseMoney(priced.pricing.totals.grandTotalMinor, request.currency),
            }
          : { unavailable: priced.problem },
  };
}

/**
 * Send the buyer a revised date for the complete quantity, or a split
 * delivery. Checked against live stock; nothing is reserved until the buyer
 * accepts, and the buyer must accept before anything is ordered or charged.
 */
export async function sellerProposeAvailability(
  responder: Responder,
  id: string,
  input: AvailabilityProposalInput,
): Promise<Record<string, unknown>> {
  const request = await loadForSupplier(responder, id, input.expectedVersion);
  const { result, problems, atp, unitPriceMinor, freightMinor } = await assessProposal(
    request,
    input,
  );

  if (!result.ok || problems.length > 0) {
    throw badRequest(
      ErrorCode.PREORDER_PROPOSAL_INVALID,
      problems[0]?.message ?? 'The proposal does not hold together.',
      problems.map((problem) => ({
        field: problem.field,
        code: problem.code,
        message: problem.message,
        ...(problem.meta === undefined ? {} : { meta: problem.meta }),
      })),
    );
  }

  return propose(responder, request, {
    kind: input.kind,
    // Never changed: the buyer's quantity is the proposal's quantity.
    quantityBaseUnits: request.requestedBaseUnits,
    unitPriceMinor,
    freightMinor,
    committedDay: result.committedDate,
    splits:
      input.kind === 'SPLIT_DELIVERY'
        ? result.installments.map((part) => ({ date: part.date, baseUnits: part.baseUnits }))
        : null,
    originLocationId: input.originLocationId,
    note: input.note === '' ? null : input.note,
    fulfilment: {
      installments: result.installments,
      stockAllocationBaseUnits: result.stockAllocationBaseUnits,
      availableNowBaseUnits: atp,
      expiresAt: new Date(input.expiresAt),
    },
  });
}

export async function sellerReject(
  responder: Responder,
  id: string,
  input: z.infer<typeof reasonSchema>,
): Promise<Record<string, unknown>> {
  const request = await loadForSupplier(responder, id, input.expectedVersion);
  await closeRequest(request, 'REJECTED', responderActor(responder), input.reason);
  return viewForSupplier(responder, id);
}

/** CONFIRMED -> IN_PRODUCTION -> READY_FOR_FULFILLMENT, both the seller's. */
export async function sellerAdvanceProduction(
  responder: Responder,
  id: string,
  to: 'IN_PRODUCTION' | 'READY_FOR_FULFILLMENT',
  note: string | null,
): Promise<Record<string, unknown>> {
  const request = await loadForSupplier(responder, id);
  const buyer = await prisma.customerProfile.findUniqueOrThrow({
    where: { id: request.customerProfileId },
    select: { fullName: true, user: { select: { email: true } } },
  });
  const order =
    request.convertedOrderId === null
      ? null
      : await prisma.order.findUnique({
          where: { id: request.convertedOrderId },
          select: { orderNumber: true },
        });

  await prisma.$transaction(async (tx) => {
    await move(tx, request, to, responderActor(responder), {
      data: to === 'IN_PRODUCTION' ? { productionStartedAt: new Date() } : { readyAt: new Date() },
      reason: note,
    });

    await enqueueNotification(
      {
        eventKey:
          to === 'IN_PRODUCTION'
            ? NotificationEvent.PREORDER_PRODUCTION_STARTED
            : NotificationEvent.PREORDER_READY,
        recipientEmail: buyer.user.email,
        recipientName: buyer.fullName,
        variables: {
          requestNumber: request.requestNumber,
          sellerName: responder.displayName,
          committedDate: dayOrNull(request.committedDeliveryDate) ?? '',
          orderNumber: order?.orderNumber ?? '',
          orderUrl:
            request.convertedOrderId === null
              ? preorderUrl(id)
              : `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/orders/${request.convertedOrderId}`,
          preorderUrl: preorderUrl(id),
        },
        dedupeKey: `preorder:${id}:${to}`,
        relatedType: 'preorder_request',
        relatedId: id,
      },
      tx,
    );

    if (to === 'READY_FOR_FULFILLMENT') await resolveDeliveryRisk(id, tx);

    await supplierAudit(tx, responder, {
      action: to === 'IN_PRODUCTION' ? 'preorder.production_started' : 'preorder.ready',
      requestId: id,
      summary: `Preorder ${request.requestNumber}: ${to === 'IN_PRODUCTION' ? 'production started' : 'ready for fulfilment'}`,
    });
    // Staff have acted on it: close the bell alert that asked them to.
    await resolveSupplierNotifications(
      { resolutionKey: `preorder:${id}:seller`, note: to.toLowerCase() },
      tx,
    );
  });

  await dispatchPendingNotifications();
  return viewForSupplier(responder, id);
}

// ---------------------------------------------------------------------------
// The buyer's answer
// ---------------------------------------------------------------------------

export const buyerConfirmSchema = z
  .object({ offerId: z.string().length(26), termsHash: z.string().regex(/^[0-9a-f]{64}$/) })
  .strict();

export const buyerDeclineSchema = z
  .object({ note: z.string().trim().max(1000).nullable().default(null) })
  .strict();

/** "Request a change": the buyer's message is required and goes to the seller. */
export const buyerRequestChangeSchema = z
  .object({ message: z.string().trim().min(3).max(1000) })
  .strict();

async function loadForBuyer(customerProfileId: string, id: string) {
  const row = await prisma.preorderRequest.findUnique({ where: { id } });
  if (row === null || row.customerProfileId !== customerProfileId) throw notFound('Preorder');
  return row;
}

/**
 * The buyer agrees to the seller's current terms. The ONLY way an order is
 * made from a preorder.
 *
 * In one transaction: the offer is accepted by hash, capacity is held, the
 * order is written AWAITING PAYMENT, and the request records which order it
 * became. `convertedOrderId` is UNIQUE, so a second confirmation - a double
 * click, a retry, a race between two tabs - cannot make a second order; it
 * finds the request has already moved and is refused before writing
 * anything.
 */
export async function buyerConfirm(
  actor: BuyerActor,
  id: string,
  input: z.infer<typeof buyerConfirmSchema>,
): Promise<Record<string, unknown>> {
  const request = await loadForBuyer(actor.customerProfileId, id);

  const offer = await prisma.preorderOffer.findUnique({ where: { id: input.offerId } });
  if (offer === null || offer.requestId !== request.id) throw notFound('Preorder terms');

  // The terms confirmed must be the terms now on the table - the current
  // revision, still open, and with the hash the buyer was shown.
  if (
    request.currentOfferId !== offer.id ||
    offer.state !== 'PROPOSED' ||
    offer.termsHash !== input.termsHash
  ) {
    throw conflict(
      ErrorCode.PREORDER_TERMS_CHANGED,
      "The seller's terms have changed since you opened this page. Review the latest terms before confirming.",
      [{ code: 'TERMS_CHANGED' }],
    );
  }

  if (offer.expiresAt.getTime() < Date.now()) {
    throw conflict(
      ErrorCode.PREORDER_EXPIRED,
      'These terms have expired. Ask the seller to send them again.',
      [{ code: 'EXPIRED' }],
    );
  }

  // Everything the order needs that is not a lock: read before the
  // transaction so it is not held open over them.
  const buyer = await loadEligibleBuyer(actor.customerProfileId);
  const supplierName = await supplierNameFor(request.sellerAccountId);
  const sellerOffer =
    request.offerId === null
      ? null
      : await prisma.sellerOffer.findUniqueOrThrow({
          where: { id: request.offerId },
          select: {
            status: true,
            sellerAccount: { select: { status: true } },
            packagingProfile: { select: { version: true } },
            containerLoading: { select: { version: true } },
          },
        });

  if (
    sellerOffer !== null &&
    (sellerOffer.status !== 'ACTIVE' || sellerOffer.sellerAccount.status !== 'APPROVED')
  ) {
    throw conflict(
      ErrorCode.PREORDER_NOT_AVAILABLE,
      'This seller is no longer offering this product.',
      [{ code: 'OFFER_INACTIVE' }],
    );
  }

  // The same function that priced the terms on the buyer's review screen.
  const priced = await priceTerms(request, offer, {
    vatNumber: buyer.vatNumber,
    vatNumberValid: buyer.vatNumberValid,
  });
  if (!priced.ok) {
    throw conflict(
      ErrorCode.PREORDER_NOT_AVAILABLE,
      `Tax for this delivery cannot be worked out: ${priced.problem}`,
      [{ code: 'TAX_UNAVAILABLE' }],
    );
  }
  const { product, taxSetup, lineTax, pricing, line } = priced;

  if (
    sellerOffer === null &&
    (product.status !== 'ACTIVE' || !product.isPublished || product.archivedAt !== null)
  ) {
    throw conflict(ErrorCode.PREORDER_NOT_AVAILABLE, 'This product is no longer on sale.', [
      { code: 'OFFER_INACTIVE' },
    ]);
  }

  const address = request.shippingAddressJson as Record<string, string | null>;
  const installments = await prisma.preorderFulfilmentInstallment.findMany({
    where: { offerId: offer.id },
    orderBy: { sequence: 'asc' },
  });
  const containerLoadingSnapshot = request.containerLoadingSnapshotJson as Record<
    string,
    unknown
  > | null;

  const confirmedTerms = {
    offerId: offer.id,
    revision: offer.revision,
    termsHash: offer.termsHash,
    quantityBaseUnits: offer.quantityBaseUnits,
    unitPriceMinor: offer.unitPriceMinor.toString(),
    goodsTotalMinor: offer.goodsTotalMinor.toString(),
    freightMinor: offer.freightMinor.toString(),
    currency: offer.currency,
    committedDeliveryDate: fromDateColumn(offer.committedDeliveryDate),
    deliverySplits: offer.deliverySplitsJson,
    originLocationId: offer.originLocationId,
    kind: offer.kind,
    stockAllocationBaseUnits: offer.stockAllocationBaseUnits,
    installments: installments.map((part) => ({
      sequence: part.sequence,
      date: fromDateColumn(part.committedDeliveryDate),
      baseUnits: part.quantityBaseUnits,
      source: part.source,
    })),
    orderingUnit: request.orderingUnit,
    unitQuantity: request.unitQuantity,
    unitsPerPackage: request.unitsPerPackage,
    // The loading the request was made under, and whether the seller has
    // re-specified it since. Recorded, never applied: the request's own
    // snapshot is what this buyer asked for.
    containerLoading:
      containerLoadingSnapshot === null
        ? null
        : {
            ...containerLoadingSnapshot,
            changedSinceRequest:
              (sellerOffer?.containerLoading?.version ?? null) !== request.containerLoadingVersion,
          },
    taxTreatment: taxSetup.context.treatment,
    taxRatePercent: lineTax.taxRatePercent,
    confirmedAt: new Date().toISOString(),
  };

  // What the buyer ordered in, when it divides back into whole packages.
  const packageUnit = request.orderingUnit;
  const wholePackages =
    packageUnit !== 'PIECE' &&
    request.unitsPerPackage > 0 &&
    offer.quantityBaseUnits % request.unitsPerPackage === 0;
  // A 20-ft or 40-ft container is recorded on the order line as a CONTAINER,
  // with its piece count, and its breakdown comes from the request's snapshot.
  const containerUnit = isContainerSize(packageUnit) ? packageUnit : null;
  const lineUnit = containerUnit === null ? packageUnit : 'CONTAINER';

  const committedDay = fromDateColumn(offer.committedDeliveryDate);
  const orderId = newId();
  const now = new Date();
  const requiresApproval = await prisma.customerProfile
    .findUnique({ where: { id: actor.customerProfileId }, select: { requiresOrderApproval: true } })
    .then((row) => row?.requiresOrderApproval ?? false);

  const packagingOption =
    wholePackages && request.offerId !== null && containerUnit === null
      ? await prisma.sellerPackagingOption.findFirst({
          where: {
            profile: { offerId: request.offerId },
            packageType: packageUnit as never,
            state: 'ACTIVE',
          },
        })
      : null;

  let orderNumber: string;
  try {
    orderNumber = await prisma.$transaction(async (tx) => {
      const confirmedState = await move(
        tx,
        request,
        'BUYER_CONFIRMED',
        {
          kind: 'BUYER',
          userId: actor.userId,
          label: `${buyer.fullName} (${buyer.organization})`.slice(0, 160),
        },
        {
          data: { buyerConfirmedAt: now },
          meta: { offerId: offer.id, termsHash: offer.termsHash },
        },
      );

      const accepted = await tx.preorderOffer.updateMany({
        where: { id: offer.id, state: 'PROPOSED' },
        data: {
          state: 'ACCEPTED',
          respondedAt: now,
          respondedByLabel: buyer.fullName.slice(0, 160),
        },
      });
      if (accepted.count !== 1) {
        throw conflict(ErrorCode.PREORDER_TERMS_CHANGED, 'These terms are no longer open.', [
          { code: 'TERMS_CHANGED' },
        ]);
      }

      // The stock these terms take from the shelf, held for this buyer now -
      // atomically, against live stock. If it has gone, nothing is held, the
      // whole transaction rolls back, and the terms are invalidated below.
      if (
        offer.stockAllocationBaseUnits > 0 &&
        request.offerId !== null &&
        request.sellerAccountId !== null
      ) {
        const hold = await holdStockForPreorder(tx, {
          requestId: request.id,
          offerId: request.offerId,
          sellerAccountId: request.sellerAccountId,
          quantity: offer.stockAllocationBaseUnits,
          preferredLocationId: offer.originLocationId,
          eligibleLocationIds: policyLocations(request.policySnapshotJson),
          safetyStock: policySafetyStock(request.policySnapshotJson),
        });
        if (!hold.ok) {
          throw new StockChangedSignal(hold.availableToPromise, offer.stockAllocationBaseUnits);
        }
      }

      // The accepted schedule becomes the plan: stock shipments held, the rest
      // waiting for their goods.
      await tx.preorderFulfilmentInstallment.updateMany({
        where: { offerId: offer.id, status: 'PROPOSED', source: 'AVAILABLE_STOCK' },
        data: { status: offer.stockAllocationBaseUnits > 0 ? 'STOCK_RESERVED' : 'PLANNED' },
      });
      await tx.preorderFulfilmentInstallment.updateMany({
        where: { offerId: offer.id, status: 'PROPOSED', source: 'FUTURE_SUPPLY' },
        data: { status: 'PLANNED' },
      });

      // Only what is still to be made counts against production capacity.
      const productionBaseUnits = offer.quantityBaseUnits - offer.stockAllocationBaseUnits;
      const bucketId =
        productionBaseUnits > 0
          ? await reserveCapacity(tx, {
              policyId: request.policyId,
              sellerAccountId: request.sellerAccountId,
              day: committedDay,
              baseUnits: productionBaseUnits,
            })
          : null;

      const number = await nextOrderNumber(tx);
      const initialStatus = requiresApproval ? 'PENDING_APPROVAL' : 'PENDING_PAYMENT';

      await tx.order.create({
        data: {
          id: orderId,
          orderNumber: number,
          customerProfileId: actor.customerProfileId,
          source: 'PREORDER',
          status: initialStatus,
          currency: offer.currency,
          subtotalMinor: pricing.totals.subtotalMinor,
          discountMinor: pricing.totals.discountMinor,
          taxMinor: pricing.totals.taxMinor,
          shippingMinor: pricing.totals.shippingMinor,
          grandTotalMinor: pricing.totals.grandTotalMinor,
          billingAddressJson: address as never,
          shippingAddressJson: address as never,
          paymentMode: 'ONLINE',
          customerNote:
            request.purchaseOrderReference === null
              ? `Preorder ${request.requestNumber}`
              : `Preorder ${request.requestNumber} · PO ${request.purchaseOrderReference}`,
          placedAt: now,
          taxTreatment: taxSetup.context.treatment,
          taxCountry: taxSetup.context.rateCountry,
          sellerVatNumberSnapshot: taxSetup.context.sellerVatNumber,
          buyerVatNumberSnapshot: taxSetup.context.buyerVatNumber,
          // A person - the seller - stated this price in this currency. Nothing
          // was converted.
          fxPriceSource: 'MANUAL',
        },
      });

      const orderItemId = newId();

      await tx.orderItem.create({
        data: {
          id: orderItemId,
          orderId,
          productId: line.productId,
          variantId: line.variantId,
          sellerOfferId: request.offerId,
          noteSnapshot: request.handlingInstructions,
          nameSnapshot: line.nameSnapshot,
          skuSnapshot: line.skuSnapshot,
          variantNameSnapshot: line.variantNameSnapshot,
          taxClassCodeSnapshot: line.taxClassCodeSnapshot,
          imageUrlSnapshot: line.imageUrlSnapshot,
          unitPriceMinor: line.unitPriceMinor,
          quantity: line.quantity,
          lineSubtotalMinor: line.lineSubtotalMinor,
          taxRatePercent: line.taxRatePercent,
          taxInclusive: line.taxInclusive,
          taxAmountMinor: line.taxAmountMinor,
          discountMinor: line.discountMinor,
          lineTotalMinor: line.lineTotalMinor,
          isRecurringEligibleSnapshot: false,
          orderingUnit: wholePackages ? (lineUnit as never) : 'PIECE',
          unitQuantity: wholePackages
            ? offer.quantityBaseUnits / request.unitsPerPackage
            : offer.quantityBaseUnits,
          piecesPerUnitSnapshot: wholePackages ? request.unitsPerPackage : 1,
        },
      });

      // The bulk breakdown, frozen from the seller's CURRENT packaging - the
      // moment the order is made is the moment it has to be true. A packing
      // list and an invoice read this, never the live option.
      if (packagingOption !== null && packagingOption.unitsPerPackage !== null) {
        await tx.orderItemPackaging.create({
          data: {
            id: newId(),
            orderItemId,
            packageType: packagingOption.packageType,
            palletStandard: packagingOption.palletStandard,
            containerType: packagingOption.containerType,
            containerLoadMode: packagingOption.containerLoadMode,
            containerLoadingMethod: packagingOption.containerLoadingMethod,
            packageQuantity: offer.quantityBaseUnits / packagingOption.unitsPerPackage,
            unitsPerPackage: packagingOption.unitsPerPackage,
            totalBaseUnits: offer.quantityBaseUnits,
            unitsPerCarton: packagingOption.unitsPerCarton,
            cartonsPerPallet: packagingOption.cartonsPerPallet,
            palletsPerContainer: packagingOption.palletsPerContainer,
            cartonsPerContainer: packagingOption.cartonsPerContainer,
            lengthMm: packagingOption.lengthMm,
            widthMm: packagingOption.widthMm,
            heightMm: packagingOption.heightMm,
            grossWeightGrams: packagingOption.grossWeightGrams,
            cargoVolumeCm3: packagingOption.cargoVolumeCm3,
            packagePriceMinor: offer.unitPriceMinor * BigInt(packagingOption.unitsPerPackage),
            unitPriceMinor: offer.unitPriceMinor,
            currency: offer.currency,
            appliedTierMinPackages: null,
            profileVersion: sellerOffer?.packagingProfile?.version ?? 1,
            snapshotAt: now,
            requiresFreightQuote: false,
            packageSkuSnapshot: packagingOption.packageSku,
            incotermSnapshot: packagingOption.incoterm,
            originPortLabelSnapshot: packagingOption.originPortLabel,
          },
        });
      }

      if (containerUnit !== null && wholePackages && containerLoadingSnapshot !== null) {
        const cartons = Number(containerLoadingSnapshot['cartonsPerContainer']);
        const pallets = containerLoadingSnapshot['palletsPerContainer'];
        const cartonWeight = BigInt(String(containerLoadingSnapshot['grossWeightPerCartonGrams']));
        await tx.orderItemPackaging.create({
          data: {
            id: newId(),
            orderItemId,
            packageType: 'CONTAINER',
            containerType: containerUnit === 'CONTAINER_20_FT' ? 'DRY_20GP' : 'DRY_40GP',
            containerLoadMode: 'FCL',
            containerLoadingMethod:
              containerLoadingSnapshot['loadingMethod'] === 'PALLET_LOADED'
                ? 'PALLET_LOADED'
                : 'CARTON_LOADED',
            packageQuantity: offer.quantityBaseUnits / request.unitsPerPackage,
            unitsPerPackage: request.unitsPerPackage,
            totalBaseUnits: offer.quantityBaseUnits,
            unitsPerCarton: Number(containerLoadingSnapshot['piecesPerCarton']),
            cartonsPerPallet:
              typeof containerLoadingSnapshot['cartonsPerPallet'] === 'number'
                ? containerLoadingSnapshot['cartonsPerPallet']
                : null,
            palletsPerContainer: typeof pallets === 'number' ? pallets : null,
            cartonsPerContainer: cartons,
            lengthMm: null,
            widthMm: null,
            heightMm: null,
            grossWeightGrams: cartonWeight * BigInt(cartons),
            cargoVolumeCm3: null,
            packagePriceMinor: offer.unitPriceMinor * BigInt(request.unitsPerPackage),
            unitPriceMinor: offer.unitPriceMinor,
            currency: offer.currency,
            appliedTierMinPackages: null,
            profileVersion: request.containerLoadingVersion ?? 1,
            snapshotAt: now,
            requiresFreightQuote: false,
            packageSkuSnapshot: null,
            incotermSnapshot: null,
            originPortLabelSnapshot: null,
          },
        });
      }

      await tx.orderStatusHistory.create({
        data: {
          id: newId(),
          orderId,
          fromStatus: null,
          toStatus: initialStatus,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          reason: `Preorder ${request.requestNumber} confirmed by the buyer`,
          correlationId: actor.correlationId ?? null,
        },
      });

      if (requiresApproval) {
        await tx.orderApproval.create({
          data: {
            id: newId(),
            orderId,
            status: 'PENDING',
            requiredReason: 'Approval required by account policy.',
          },
        });
      }

      const paymentExpiry = hoursFromNow(env.PREORDER_PAYMENT_EXPIRY_HOURS, now);

      await move(tx, confirmedState, 'PAYMENT_REQUIRED', SYSTEM_ACTOR, {
        data: {
          acceptedOfferId: offer.id,
          confirmedTermsJson: confirmedTerms,
          confirmedTermsHash: offer.termsHash,
          confirmedBaseUnits: offer.quantityBaseUnits,
          confirmedUnitPriceMinor: offer.unitPriceMinor,
          confirmedFreightMinor: offer.freightMinor,
          confirmedGoodsTotalMinor: offer.goodsTotalMinor,
          committedDeliveryDate: offer.committedDeliveryDate,
          convertedOrderId: orderId,
          capacityBucketId: bucketId,
          capacityReservedBaseUnits: bucketId === null ? 0 : productionBaseUnits,
          expiresAt: paymentExpiry,
        },
        reason: `Order ${number} created, awaiting payment`,
        meta: { orderId, orderNumber: number },
      });

      await notifySupplier({
        requestNumber: request.requestNumber,
        sellerAccountId: request.sellerAccountId,
        kind: 'PREORDER_BUYER_RESPONSE',
        title: `Preorder ${request.requestNumber} confirmed by the buyer`,
        body: `${buyer.organization} agreed to your terms. Order ${number} is awaiting payment; production should not start until it is paid.`,
        linkPath: `/seller/preorders/${id}`,
        subjectType: 'preorder_request',
        subjectId: id,
        dedupeKey: `preorder:${id}:buyer_confirmed`,
        tx,
      });

      await enqueueNotification(
        {
          eventKey: NotificationEvent.PREORDER_PAYMENT_REQUIRED,
          recipientEmail: actor.email,
          recipientName: buyer.fullName,
          variables: {
            requestNumber: request.requestNumber,
            sellerName: supplierName,
            orderNumber: number,
            total: `${serialiseMoney(pricing.totals.grandTotalMinor, offer.currency).formatted} ${offer.currency}`,
            expiresAt: paymentExpiry.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
            orderUrl: `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/orders/${orderId}`,
          },
          dedupeKey: `preorder:${id}:payment_required`,
          relatedType: 'preorder_request',
          relatedId: id,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );

      await recordAudit(
        {
          action: AuditAction.PREORDER_BUYER_CONFIRMED,
          resourceType: 'preorder_request',
          resourceId: id,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: {
            termsHash: offer.termsHash,
            revision: offer.revision,
            orderId,
            orderNumber: number,
            grandTotalMinor: pricing.totals.grandTotalMinor,
            capacityBucketId: bucketId,
          },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );

      await recordAudit(
        {
          action: AuditAction.ORDER_CREATED,
          resourceType: 'order',
          resourceId: orderId,
          actorType: 'CUSTOMER',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: {
            via: 'preorder',
            preorderRequestId: id,
            orderNumber: number,
            status: initialStatus,
            grandTotalMinor: pricing.totals.grandTotalMinor,
            currency: offer.currency,
          },
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );

      return number;
    });
  } catch (error) {
    if (!(error instanceof StockChangedSignal)) throw error;
    // Nothing above was written. Record, on its own, that these terms can no
    // longer be kept, and send the request back to the seller.
    await invalidateForStockChange({
      requestId: request.id,
      offerId: offer.id,
      availableToPromise: error.availableToPromise,
      required: error.required,
    });
    throw conflict(
      ErrorCode.PREORDER_STOCK_CHANGED,
      'The stock this offer was based on is no longer available. Nothing has been reserved or charged, and the seller has been asked for a revised offer.',
      [
        {
          code: 'STOCK_CHANGED',
          meta: { availableToPromise: error.availableToPromise, required: error.required },
        },
      ],
    );
  }

  await dispatchPendingNotifications();
  logger.info(
    { preorderId: id, orderId, orderNumber },
    'preorder confirmed by buyer, order awaiting payment',
  );

  return getBuyerPreorder(actor.customerProfileId, id);
}

/** Thrown inside the acceptance transaction to roll it back when stock has gone. */
class StockChangedSignal extends Error {
  constructor(
    readonly availableToPromise: number,
    readonly required: number,
  ) {
    super('preorder stock changed');
  }
}

/**
 * The buyer accepted terms whose stock has gone. The terms are INVALIDATED,
 * the request goes back to the seller, and both are told. Nothing was reserved
 * or charged - the acceptance transaction rolled back before this runs.
 */
async function invalidateForStockChange(input: {
  requestId: string;
  offerId: string;
  availableToPromise: number;
  required: number;
}): Promise<void> {
  const request = await prisma.preorderRequest.findUnique({ where: { id: input.requestId } });
  if (
    request === null ||
    request.currentOfferId !== input.offerId ||
    !AWAITING_BUYER.includes(request.status)
  ) {
    return;
  }

  const buyer = await prisma.customerProfile.findUniqueOrThrow({
    where: { id: request.customerProfileId },
    select: { fullName: true, user: { select: { email: true } } },
  });
  const sellerName = await supplierNameFor(request.sellerAccountId);
  const label = await productLabel(request.productId, request.variantId);
  const reason = `Only ${formatCount(input.availableToPromise)} of the ${formatCount(input.required)} pieces this offer takes from stock were still available when the buyer accepted.`;

  try {
    await prisma.$transaction(async (tx) => {
      await move(tx, request, 'SELLER_REVIEW_REQUIRED', SYSTEM_ACTOR, {
        data: {
          currentOfferId: null,
          expiresAt: hoursFromNow(
            (request.policySnapshotJson as { requestExpiryHours?: number | null })
              .requestExpiryHours ?? env.PREORDER_REQUEST_EXPIRY_HOURS,
          ),
        },
        reason,
        meta: {
          offerId: input.offerId,
          availableToPromise: input.availableToPromise,
          required: input.required,
        },
      });

      await tx.preorderOffer.updateMany({
        where: { id: input.offerId, state: 'PROPOSED' },
        data: {
          state: 'INVALIDATED',
          respondedAt: new Date(),
          responseNote: reason.slice(0, 1000),
        },
      });
      await tx.preorderFulfilmentInstallment.updateMany({
        where: { offerId: input.offerId, status: 'PROPOSED' },
        data: { status: 'CANCELLED' },
      });

      await notifySupplier({
        requestNumber: request.requestNumber,
        sellerAccountId: request.sellerAccountId,
        kind: 'PREORDER_BUYER_RESPONSE',
        class: 'ALERT',
        resolutionKey: `preorder:${request.id}:seller`,
        severity: 'WARNING',
        title: `Preorder ${request.requestNumber}: stock changed before the buyer could accept`,
        body: `${reason} Send the buyer a revised proposal.`,
        linkPath: `/seller/preorders/${request.id}`,
        subjectType: 'preorder_request',
        subjectId: request.id,
        dedupeKey: `preorder:${request.id}:stock_changed:${input.offerId}`,
        tx,
      });

      await enqueueNotification(
        {
          eventKey: NotificationEvent.PREORDER_STOCK_CHANGED,
          recipientEmail: buyer.user.email,
          recipientName: buyer.fullName,
          variables: {
            requestNumber: request.requestNumber,
            productName: label,
            sellerName,
            preorderUrl: preorderUrl(request.id),
          },
          dedupeKey: `preorder:${request.id}:stock_changed:${input.offerId}`,
          relatedType: 'preorder_request',
          relatedId: request.id,
        },
        tx,
      );

      await recordAudit(
        {
          action: AuditAction.PREORDER_STOCK_INVALIDATED,
          resourceType: 'preorder_request',
          resourceId: request.id,
          actorType: 'SYSTEM',
          after: {
            offerId: input.offerId,
            availableToPromise: input.availableToPromise,
            required: input.required,
          },
        },
        tx,
      );
    });
    await dispatchPendingNotifications();
  } catch (error) {
    // Somebody else moved the request first - the seller revised, or it
    // expired. Their outcome stands; the buyer is still refused.
    logger.warn(
      { err: error, preorderId: request.id },
      'could not invalidate a stale preorder offer',
    );
  }
}

/** The buyer declines the seller's terms and asks the seller to look again. */
export async function buyerDecline(
  actor: BuyerActor,
  id: string,
  input: z.infer<typeof buyerDeclineSchema>,
): Promise<Record<string, unknown>> {
  const request = await loadForBuyer(actor.customerProfileId, id);
  const buyer = await loadEligibleBuyer(actor.customerProfileId);
  const expiresAt = hoursFromNow(
    (request.policySnapshotJson as { requestExpiryHours?: number | null }).requestExpiryHours ??
      env.PREORDER_REQUEST_EXPIRY_HOURS,
  );

  await prisma.$transaction(async (tx) => {
    await move(
      tx,
      request,
      'SELLER_REVIEW_REQUIRED',
      { kind: 'BUYER', userId: actor.userId, label: buyer.fullName.slice(0, 160) },
      {
        data: { currentOfferId: null, expiresAt },
        reason: input.note,
      },
    );

    await tx.preorderOffer.updateMany({
      where: { requestId: id, state: 'PROPOSED' },
      data: {
        state: 'DECLINED',
        respondedAt: new Date(),
        respondedByLabel: buyer.fullName.slice(0, 160),
        responseNote: input.note,
      },
    });
    await tx.preorderFulfilmentInstallment.updateMany({
      where: { requestId: id, status: 'PROPOSED' },
      data: { status: 'CANCELLED' },
    });

    await notifySupplier({
      requestNumber: request.requestNumber,
      sellerAccountId: request.sellerAccountId,
      kind: 'PREORDER_BUYER_RESPONSE',
      class: 'ALERT',
      resolutionKey: `preorder:${id}:seller`,
      severity: 'WARNING',
      title: `Preorder ${request.requestNumber}: the buyer declined your terms`,
      body:
        input.note === null
          ? `${buyer.organization} asked you to look again.`
          : `${buyer.organization}: ${input.note}`,
      linkPath: `/seller/preorders/${id}`,
      subjectType: 'preorder_request',
      subjectId: id,
      dedupeKey: `preorder:${id}:declined:${String(request.version)}`,
      tx,
    });

    await recordAudit(
      {
        action: AuditAction.PREORDER_BUYER_DECLINED,
        resourceType: 'preorder_request',
        resourceId: id,
        actorType: 'CUSTOMER',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { note: input.note },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  await dispatchPendingNotifications();
  return getBuyerPreorder(actor.customerProfileId, id);
}

/**
 * "Request a change": the buyer's message goes back to the seller with the
 * request, and the seller answers with new terms. Each round is a new offer
 * revision, so the whole negotiation stays readable in order.
 */
export async function buyerRequestChange(
  actor: BuyerActor,
  id: string,
  input: z.infer<typeof buyerRequestChangeSchema>,
): Promise<Record<string, unknown>> {
  return buyerDecline(actor, id, { note: input.message });
}

/**
 * The buyer withdraws.
 *
 * Before an order exists this closes the request. Once one exists and is
 * awaiting payment, the ORDER is cancelled through its own state machine and
 * the order's cancellation closes the preorder - one path for "the order
 * behind a preorder was cancelled", whoever started it.
 */
export async function buyerCancel(
  actor: BuyerActor,
  id: string,
  input: z.infer<typeof reasonSchema>,
): Promise<Record<string, unknown>> {
  const request = await loadForBuyer(actor.customerProfileId, id);
  const buyer = await loadEligibleBuyer(actor.customerProfileId);

  if (request.status === 'PAYMENT_REQUIRED' && request.convertedOrderId !== null) {
    const { transitionOrder } = await import('../orders/order.service.js');
    await transitionOrder({
      orderId: request.convertedOrderId,
      to: 'CANCELLED',
      actor: {
        userId: actor.userId,
        email: actor.email,
        type: 'CUSTOMER',
        correlationId: actor.correlationId ?? null,
      },
      reason: `Preorder ${request.requestNumber} cancelled by the buyer: ${input.reason}`.slice(
        0,
        500,
      ),
    });
    return getBuyerPreorder(actor.customerProfileId, id);
  }

  await closeRequest(
    request,
    'CANCELLED',
    { kind: 'BUYER', userId: actor.userId, label: buyer.fullName.slice(0, 160) },
    input.reason,
  );
  return getBuyerPreorder(actor.customerProfileId, id);
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * End a request without an order: rejected, cancelled or expired. Releases
 * any capacity, withdraws any open terms, closes the seller's alert and tells
 * the buyer.
 */
async function closeRequest(
  request: NonNullable<Awaited<ReturnType<typeof prisma.preorderRequest.findUnique>>>,
  to: 'REJECTED' | 'CANCELLED' | 'EXPIRED',
  actor: StatusActor,
  reason: string,
  tx?: PrismaTransaction,
): Promise<void> {
  const buyer = await (tx ?? prisma).customerProfile.findUniqueOrThrow({
    where: { id: request.customerProfileId },
    select: { fullName: true, user: { select: { email: true } } },
  });
  const seller = { displayName: await supplierNameFor(request.sellerAccountId, tx) };
  const label = await productLabel(request.productId, request.variantId);

  const run = async (client: PrismaTransaction) => {
    await move(client, request, to, actor, {
      data: {
        closedAt: new Date(),
        closedReason: reason.slice(0, 1000),
        expiresAt: null,
        capacityReservedBaseUnits: 0,
      },
      reason,
    });

    if (HOLDS_CAPACITY.includes(request.status)) await releaseCapacity(client, request);

    // Stock held for the buyer goes back on the shelf in this transaction.
    // A no-op for a request that never held any.
    const releasedStock = await releasePreorderHolds(client, request.id, 'RELEASED');

    await client.preorderOffer.updateMany({
      where: { requestId: request.id, state: 'PROPOSED' },
      data: { state: to === 'EXPIRED' ? 'EXPIRED' : 'WITHDRAWN' },
    });
    await client.preorderFulfilmentInstallment.updateMany({
      where: { requestId: request.id, status: { in: ['PROPOSED', 'PLANNED', 'STOCK_RESERVED'] } },
      data: { status: 'CANCELLED' },
    });

    await resolveSupplierNotifications(
      { resolutionKey: `preorder:${request.id}:seller`, note: to.toLowerCase() },
      client,
    );

    const closedBySupplier =
      actor.kind === 'SELLER' || (request.sellerAccountId === null && actor.kind === 'ADMIN');
    if (!closedBySupplier) {
      await notifySupplier({
        requestNumber: request.requestNumber,
        sellerAccountId: request.sellerAccountId,
        kind: 'PREORDER_CLOSED',
        title: `Preorder ${request.requestNumber} ${to.toLowerCase()}`,
        body: reason,
        linkPath: `/seller/preorders/${request.id}`,
        subjectType: 'preorder_request',
        subjectId: request.id,
        dedupeKey: `preorder:${request.id}:${to}`,
        tx: client,
      });
    }

    if (actor.kind !== 'BUYER') {
      await enqueueNotification(
        {
          eventKey:
            to === 'REJECTED'
              ? NotificationEvent.PREORDER_REJECTED
              : to === 'EXPIRED'
                ? NotificationEvent.PREORDER_EXPIRED
                : NotificationEvent.PREORDER_CANCELLED,
          recipientEmail: buyer.user.email,
          recipientName: buyer.fullName,
          variables: {
            requestNumber: request.requestNumber,
            sellerName: seller.displayName,
            productName: label,
            reason,
          },
          dedupeKey: `preorder:${request.id}:${to}`,
          relatedType: 'preorder_request',
          relatedId: request.id,
        },
        client,
      );
    }

    await recordAudit(
      {
        action:
          to === 'REJECTED'
            ? AuditAction.PREORDER_REJECTED
            : to === 'EXPIRED'
              ? AuditAction.PREORDER_EXPIRED
              : AuditAction.PREORDER_CANCELLED,
        resourceType: 'preorder_request',
        resourceId: request.id,
        actorType: historyActorType(actor),
        actorUserId: actor.userId,
        after: {
          reason,
          releasedBaseUnits: request.capacityReservedBaseUnits,
          releasedStockBaseUnits: releasedStock,
        },
      },
      client,
    );
  };

  if (tx === undefined) {
    await prisma.$transaction(run);
    await dispatchPendingNotifications();
  } else {
    await run(tx);
  }
}

// ---------------------------------------------------------------------------
// Hooks from the order's own state machine
// ---------------------------------------------------------------------------

/**
 * The order behind a preorder was confirmed - by a signed payment webhook,
 * through `transitionOrder`, inside that transaction.
 *
 * A preorder not in PAYMENT_REQUIRED is left alone and logged: money arriving
 * for a request that has already expired is a real edge (the payment raced
 * the sweep), and the order it paid for is still a real, paid order the
 * seller now holds. The preorder record is not rewritten to pretend otherwise.
 */
export async function onPreorderOrderConfirmed(
  orderId: string,
  tx: PrismaTransaction,
): Promise<void> {
  const request = await tx.preorderRequest.findUnique({ where: { convertedOrderId: orderId } });
  if (request === null) return;

  if (request.status !== 'PAYMENT_REQUIRED') {
    logger.warn(
      { preorderId: request.id, orderId, status: request.status },
      'payment confirmed for a preorder that is no longer awaiting it',
    );
    return;
  }

  await move(tx, request, 'CONFIRMED', SYSTEM_ACTOR, {
    data: { confirmedAt: new Date(), expiresAt: null },
    reason: 'Payment confirmed',
  });

  const [buyer, order] = await Promise.all([
    tx.customerProfile.findUniqueOrThrow({
      where: { id: request.customerProfileId },
      select: { fullName: true, user: { select: { email: true } } },
    }),
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { orderNumber: true } }),
  ]);

  await notifySupplier({
    requestNumber: request.requestNumber,
    sellerAccountId: request.sellerAccountId,
    kind: 'PREORDER_CONFIRMED',
    severity: 'SUCCESS',
    title: `Preorder ${request.requestNumber} is paid and confirmed`,
    body: `Order ${order.orderNumber}. Committed delivery ${dayOrNull(request.committedDeliveryDate) ?? ''}.`,
    linkPath: `/seller/preorders/${request.id}`,
    subjectType: 'preorder_request',
    subjectId: request.id,
    dedupeKey: `preorder:${request.id}:confirmed`,
    tx,
  });

  await enqueueNotification(
    {
      eventKey: NotificationEvent.PREORDER_CONFIRMED,
      recipientEmail: buyer.user.email,
      recipientName: buyer.fullName,
      variables: {
        requestNumber: request.requestNumber,
        orderNumber: order.orderNumber,
        committedDate: dayOrNull(request.committedDeliveryDate) ?? '',
        preorderUrl: preorderUrl(request.id),
      },
      dedupeKey: `preorder:${request.id}:confirmed`,
      relatedType: 'preorder_request',
      relatedId: request.id,
    },
    tx,
  );

  await recordAudit(
    {
      action: AuditAction.PREORDER_CONFIRMED,
      resourceType: 'preorder_request',
      resourceId: request.id,
      actorType: 'SYSTEM',
      after: { orderId, orderNumber: order.orderNumber },
    },
    tx,
  );
}

/**
 * The order behind a preorder was cancelled. The preorder closes with it and
 * gives its capacity back - EXPIRED when it was the unpaid-payment sweep that
 * cancelled it, CANCELLED otherwise.
 */
export async function onPreorderOrderCancelled(
  orderId: string,
  reason: string | null,
  tx: PrismaTransaction,
): Promise<void> {
  const request = await tx.preorderRequest.findUnique({ where: { convertedOrderId: orderId } });
  if (request === null || isTerminalPreorderStatus(request.status)) return;

  const expired =
    request.status === 'PAYMENT_REQUIRED' &&
    request.expiresAt !== null &&
    request.expiresAt.getTime() <= Date.now();

  await closeRequest(
    request,
    expired ? 'EXPIRED' : 'CANCELLED',
    SYSTEM_ACTOR,
    expired ? 'the order was not paid for in time' : (reason ?? 'The order was cancelled.'),
    tx,
  );
}

/**
 * The seller is accepting the order a preorder became: hand the preorder's
 * held stock to the order.
 *
 * Called by the seller-order transition BEFORE it reserves the order's own
 * stock, in the same transaction. The held units go back to available here
 * and the order's reservation takes them at the location the seller chose -
 * so nothing is reserved twice, and nothing is free for anybody else in
 * between, because it is one transaction.
 *
 * `allowsPartial` is true for a split delivery: the order may be accepted
 * with only its first shipment's stock on hand, and each later shipment
 * reserves its own stock when it is dispatched.
 */
export async function preparePreorderGroupAcceptance(
  orderId: string,
  tx: PrismaTransaction,
): Promise<{ isPreorder: boolean; allowsPartial: boolean }> {
  const request = await tx.preorderRequest.findUnique({
    where: { convertedOrderId: orderId },
    select: { id: true },
  });
  if (request === null) return { isPreorder: false, allowsPartial: false };

  await releasePreorderHolds(tx, request.id, 'TRANSFERRED');

  return { isPreorder: true, allowsPartial: await isSplitPreorderOrder(orderId, tx) };
}

/**
 * Was this order made from a preorder the buyer agreed to receive in parts?
 * A split-delivery proposal, or a counter-offer with more than one delivery.
 */
export async function isSplitPreorderOrder(
  orderId: string,
  client: PrismaTransaction = prisma,
): Promise<boolean> {
  const request = await client.preorderRequest.findUnique({
    where: { convertedOrderId: orderId },
    select: { acceptedOfferId: true },
  });
  if (request?.acceptedOfferId === null || request?.acceptedOfferId === undefined) return false;
  const accepted = await client.preorderOffer.findUnique({
    where: { id: request.acceptedOfferId },
    select: { kind: true, deliverySplitsJson: true },
  });
  return (
    accepted !== null &&
    (accepted.kind === 'SPLIT_DELIVERY' ||
      (Array.isArray(accepted.deliverySplitsJson) && accepted.deliverySplitsJson.length > 1))
  );
}

/**
 * The seller accepted the order a preorder became. That is the hand-off to
 * ordinary fulfilment, and the preorder is finished: its capacity is used
 * rather than released.
 */
export async function onPreorderSellerGroupAccepted(
  orderId: string,
  tx: PrismaTransaction,
): Promise<void> {
  const request = await tx.preorderRequest.findUnique({ where: { convertedOrderId: orderId } });
  if (request === null) return;
  if (
    !(['CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_FULFILLMENT'] as PreorderStatusName[]).includes(
      request.status,
    )
  )
    return;

  await move(tx, request, 'CONVERTED_TO_ORDER', SYSTEM_ACTOR, {
    data: { convertedAt: new Date(), closedAt: new Date() },
    reason: 'The seller accepted the order for fulfilment',
  });
}

/**
 * Staff moved an order on the operator's own product to PROCESSING. A
 * preorder behind it that is paid (and made, or not yet) is converted, the
 * same states a seller's acceptance converts from. A no-op for a seller's
 * preorder - that one converts when the seller accepts - and for any other order.
 */
export async function onPreorderOperatorOrderProcessing(
  orderId: string,
  tx: PrismaTransaction,
): Promise<void> {
  const request = await tx.preorderRequest.findUnique({ where: { convertedOrderId: orderId } });
  if (request === null || request.sellerAccountId !== null) return;
  if (
    !(['CONFIRMED', 'IN_PRODUCTION', 'READY_FOR_FULFILLMENT'] as PreorderStatusName[]).includes(
      request.status,
    )
  )
    return;

  await move(tx, request, 'CONVERTED_TO_ORDER', SYSTEM_ACTOR, {
    data: { convertedAt: new Date(), closedAt: new Date() },
    reason: 'The store started fulfilling the order',
  });
  await resolveSupplierNotifications(
    { resolutionKey: `preorder:${request.id}:seller`, note: 'converted' },
    tx,
  );
}

// ---------------------------------------------------------------------------
// Sweeps
// ---------------------------------------------------------------------------

/**
 * Expire every request whose waiting party ran out of time.
 *
 * One row per transaction, each conditional on the status it was read in, so
 * a sweep racing a seller's answer loses cleanly. A request awaiting payment
 * is expired by cancelling its ORDER, which closes the request through
 * `onPreorderOrderCancelled` - and an order that was paid in the meantime
 * refuses the cancellation, which is exactly the right outcome.
 */
export async function expireStalePreorders(now: Date = new Date()): Promise<number> {
  const stale = await prisma.preorderRequest.findMany({
    where: {
      status: {
        in: [
          'SUBMITTED',
          'SELLER_REVIEW_REQUIRED',
          'SELLER_ACCEPTED',
          'SELLER_COUNTERED',
          'PAYMENT_REQUIRED',
        ],
      },
      expiresAt: { lt: now },
    },
    take: 200,
    orderBy: { expiresAt: 'asc' },
  });

  let expired = 0;

  for (const request of stale) {
    try {
      if (request.status === 'PAYMENT_REQUIRED' && request.convertedOrderId !== null) {
        const { transitionOrder } = await import('../orders/order.service.js');
        await transitionOrder({
          orderId: request.convertedOrderId,
          to: 'CANCELLED',
          actor: { userId: null, email: null, type: 'SYSTEM' },
          reason: `Preorder ${request.requestNumber} was not paid for in time`,
        });
      } else {
        const why = AWAITING_SELLER.includes(request.status)
          ? 'the seller did not answer in time'
          : 'the terms were not confirmed in time';
        await closeRequest(request, 'EXPIRED', SYSTEM_ACTOR, why);
      }
      expired += 1;
    } catch (error) {
      logger.warn({ err: error, preorderId: request.id }, 'could not expire a stale preorder');
    }
  }

  return expired;
}

/**
 * Warn both parties, once, about a paid preorder close to its committed date
 * that the seller has not yet marked ready.
 */
export async function flagPreorderDeliveryRisks(now: Date = new Date()): Promise<number> {
  const horizon = toDateColumn(addCalendarDays(todayIn('UTC', now), env.PREORDER_RISK_WINDOW_DAYS));

  const atRisk = await prisma.preorderRequest.findMany({
    where: {
      status: { in: ['CONFIRMED', 'IN_PRODUCTION'] },
      committedDeliveryDate: { lte: horizon },
      deliveryRiskNotifiedAt: null,
    },
    take: 200,
    include: {
      customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
      sellerAccount: { select: { displayName: true } },
    },
  });

  let flagged = 0;

  for (const request of atRisk) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.preorderRequest.updateMany({
        where: { id: request.id, deliveryRiskNotifiedAt: null },
        data: { deliveryRiskNotifiedAt: now },
      });
      if (claimed.count !== 1) return;

      const committed = dayOrNull(request.committedDeliveryDate) ?? '';

      await notifySupplier({
        requestNumber: request.requestNumber,
        sellerAccountId: request.sellerAccountId,
        kind: 'PREORDER_DELIVERY_RISK',
        class: 'ALERT',
        resolutionKey: `preorder:${request.id}:risk`,
        severity: 'CRITICAL',
        title: `Preorder ${request.requestNumber} is due by ${committed} and is not ready`,
        body: 'Mark it ready for fulfilment, or tell the buyer what the new date is.',
        linkPath: `/seller/preorders/${request.id}`,
        subjectType: 'preorder_request',
        subjectId: request.id,
        dedupeKey: `preorder:${request.id}:risk`,
        tx,
      });

      await enqueueNotification(
        {
          eventKey: NotificationEvent.PREORDER_DELIVERY_RISK,
          recipientEmail: request.customerProfile.user.email,
          recipientName: request.customerProfile.fullName,
          variables: {
            requestNumber: request.requestNumber,
            committedDate: committed,
            sellerName: request.sellerAccount?.displayName ?? (await storeName()),
            preorderUrl: preorderUrl(request.id),
          },
          dedupeKey: `preorder:${request.id}:risk`,
          relatedType: 'preorder_request',
          relatedId: request.id,
        },
        tx,
      );
    });
    flagged += 1;
  }

  await dispatchPendingNotifications();
  return flagged;
}

/** The risk alert closes once the preorder is ready or finished. */
export async function resolveDeliveryRisk(requestId: string, tx: PrismaTransaction): Promise<void> {
  await resolveSupplierNotifications(
    { resolutionKey: `preorder:${requestId}:risk`, note: 'ready' },
    tx,
  );
}
