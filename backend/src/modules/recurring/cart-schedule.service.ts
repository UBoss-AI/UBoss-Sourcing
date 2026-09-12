/**
 * Turning a cart into a scheduled order.
 *
 * The storefront's three purchase options all start from the same basket:
 *
 *   Buy Now            -> `submitCheckout`, unchanged, and not this file.
 *   Buy Later          -> one delivery on a chosen date. A ONE_TIME plan.
 *   Subscribe & Reorder -> the basket, repeating. A RECURRING plan.
 *
 * The last two are the same code path with a different frequency, which is
 * why they live in one function. Both go through a draft:
 *
 *   1. `previewCartSchedule` prices the basket under the proposed schedule and
 *      answers with everything the review screen shows - items, quantities,
 *      price, discount, tax, delivery, total, address, payment method,
 *      frequency and the next processing date. Nothing is written.
 *   2. `createCartSchedule` writes a DRAFT. Still nothing is charged; a draft
 *      has no run date and the worker cannot see it.
 *   3. `activateSchedule` - in `schedule.service.ts` - takes the customer's
 *      confirmation and makes it live.
 *
 * Step 1 existing separately from step 2 is the whole point. A customer must
 * be able to read the real numbers before they authorise anything, and the
 * numbers on that screen have to come from the same code that will later
 * charge them. See `schedule-quote.service.ts`.
 *
 * The cart is emptied at activation rather than at draft creation. A draft the
 * customer abandons must not cost them their basket.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, type ErrorCodeValue } from '../../domain/errors.js';
import { todayIn } from '../../domain/delivery-dates.js';
import { serialiseMoney } from '../../domain/money.js';
import {
  describeRule,
  isRepeating,
  nextRunAt,
  type Frequency,
  type NextRunInput,
} from '../../domain/recurrence.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../infra/prisma.js';
import { resolveCart } from '../cart/cart.service.js';
import { listPaymentMethods } from '../payments/payment-method.service.js';
import {
  createSchedule,
  editableUntil,
  type CreatedSchedule,
  type ScheduleActor,
  type ScheduleItemInput,
} from './schedule.service.js';
import { deliveryNoticeFloor } from './schedule-notice.js';
import { quoteSchedule, type QuoteProblem, type ScheduleQuote } from './schedule-quote.service.js';

export interface CartScheduleConfig {
  /** ONE_TIME for Buy Later; anything else is a subscription. */
  frequency: Frequency;
  intervalDays?: number | null;
  intervalMonths?: number | null;
  weekday?: number | null;
  monthDay?: number | null;
  /** The first (or only) delivery date, as YYYY-MM-DD in the customer's zone. */
  startDate: string;
  /** Local time of day, minutes since midnight. */
  runAtMinute?: number;
  timezone?: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  shippingAddressId: string;
  billingAddressId?: string;
  shippingMethodCode?: string | null;
  paymentMode: 'AUTO_PAY' | 'PAYMENT_LINK';
  paymentMethodId?: string | null;
  payerEmail?: string | null;
  substitutionPolicy?: 'NEVER' | 'SAVED_PREFERENCE';
  fulfilmentRule?: 'AUTO' | 'FIXED_LOCATION';
  inventoryLocationId?: string | null;
  /**
   * Quantities to schedule, when they differ from the cart.
   *
   * Keyed by cart item id. Absent means "as the cart has it", which is the
   * ordinary case; the review screen lets a customer order six a month of
   * something they have one of in their basket today.
   */
  quantities?: Record<string, number>;
  /** Saved stand-ins, keyed by cart item id. */
  substitutes?: Record<string, { productId: string; variantId?: string | null }>;
  name?: string;
}

export interface CartSchedulePreview {
  /** What the plan would be called. */
  name: string;
  kind: 'ONE_TIME' | 'RECURRING';
  frequency: Frequency;
  /** The schedule in words, for the customer to read back. */
  summary: string;
  /** The first (or only) processing date, in UTC. */
  nextProcessingAt: string | null;
  /** The same instant, formatted in the plan's own zone. */
  nextProcessingLabel: string | null;
  timezone: string;
  /** Latest moment this delivery could still be changed or skipped. */
  editableUntil: string | null;
  /**
   * The earliest first-delivery date this configuration allows, `YYYY-MM-DD`.
   *
   * The later of the notice period and the chosen warehouse's own soonest -
   * see `schedule-notice.ts`. Returned on every preview, including the ones
   * with no problem at all, because the review screen draws its calendar from
   * it: a picker that greys out the closed days is the difference between a
   * rule and a rejection, and re-previewing after a warehouse change is how
   * the screen learns the floor has moved.
   */
  earliestDeliveryDate: string;
  /** The notice period in days, so the screen can state the rule. */
  noticeDays: number;
  /**
   * The chosen warehouse's own soonest, when it is a FIXED_LOCATION plan and
   * that warehouse publishes a lane to the address. Null otherwise - not
   * zero, and not a guess.
   */
  warehouseEarliestDate: string | null;
  quote: ScheduleQuote;
  deliveryAddress: {
    id: string;
    contactName: string;
    line1: string;
    line2: string | null;
    city: string;
    state: string | null;
    postalCode: string;
    country: string;
  } | null;
  paymentMethod: {
    mode: 'AUTO_PAY' | 'PAYMENT_LINK';
    /** Set for AUTO_PAY: which card, in the words a person reads. */
    description: string | null;
    payerEmail: string | null;
  };
  /** Anything that would stop this being activated, or would hold a delivery. */
  problems: QuoteProblem[];
  canActivate: boolean;
}

/**
 * The review screen.
 *
 * Reads the cart, applies the proposed quantities, prices the result under the
 * proposed schedule, and reports it. Writes nothing, so a customer can adjust
 * and re-preview as often as they like.
 */
export async function previewCartSchedule(
  customerProfileId: string,
  config: CartScheduleConfig,
): Promise<CartSchedulePreview> {
  assertFeatureAvailable(config.frequency);

  const resolved = await resolveCart(customerProfileId, {
    shippingMethodCode: config.shippingMethodCode ?? null,
  });

  if (resolved.lines.length === 0) {
    throw badRequest(ErrorCode.CART_EMPTY, 'Your cart is empty.');
  }

  const items = itemsFromCart(resolved, config);

  const business = await prisma.businessProfile.findFirst({ select: { timezone: true } });
  const timezone = config.timezone ?? business?.timezone ?? env.DEFAULT_TIMEZONE;
  const runAtMinute = config.runAtMinute ?? 360;

  const quote = await quoteSchedule({
    customerProfileId,
    items,
    shippingAddressId: config.shippingAddressId,
    shippingMethodCode: config.shippingMethodCode ?? null,
    substitutionPolicy: config.substitutionPolicy ?? 'NEVER',
    inventoryLocationId: config.inventoryLocationId ?? null,
    // Not asked of the ERP here: a customer on a form should not wait for a
    // third-party round trip, and the answer would be stale by the time the
    // delivery actually ran. It IS asked at every occurrence.
    checkErpStock: false,
  });

  const address = await prisma.address.findFirst({
    where: { id: config.shippingAddressId, customerProfileId, archivedAt: null },
    select: {
      id: true,
      contactName: true,
      line1: true,
      line2: true,
      city: true,
      state: true,
      postalCode: true,
      country: true,
    },
  });

  // The first processing date, computed exactly as creation will compute it -
  // the review screen must not promise a date the plan then does not use.
  const firstRun = computeFirstRun({
    frequency: config.frequency,
    intervalDays: config.intervalDays ?? null,
    intervalMonths: config.intervalMonths ?? null,
    weekday: config.weekday ?? null,
    monthDay: config.monthDay ?? null,
    timezone,
    runAtMinute,
    startDate: config.startDate,
  });

  const problems = [...quote.problems];

  if (address === null) {
    problems.push({
      severity: 'BLOCK',
      code: ErrorCode.ADDRESS_REQUIRED,
      message: 'Choose a delivery address.',
    });
  }

  if (firstRun === null) {
    problems.push({
      severity: 'BLOCK',
      code: ErrorCode.SCHEDULE_FREQUENCY_NOT_SUPPORTED,
      message: 'That schedule produces no delivery dates.',
    });
  } else if (firstRun.getTime() <= Date.now()) {
    problems.push({
      severity: 'BLOCK',
      code: ErrorCode.SCHEDULE_DATE_IN_PAST,
      message: 'Choose a delivery date and time in the future.',
    });
  }

  const paymentDescription = await describePaymentMethod(customerProfileId, config);

  if (config.paymentMode === 'AUTO_PAY' && paymentDescription === null) {
    // Two different refusals, because they mean different things to the
    // person reading them. Naming a card that is not on this account is not
    // the same as not having chosen one - and it is also the shape a request
    // takes when one customer reaches for another customer's card, so it must
    // not be answered with a friendly "choose a card".
    const named =
      config.paymentMethodId !== null &&
      config.paymentMethodId !== undefined &&
      config.paymentMethodId.length > 0;

    problems.push(
      named
        ? {
            severity: 'BLOCK',
            code: ErrorCode.SCHEDULE_PAYMENT_METHOD_INVALID,
            message: 'That saved card could not be found on your account.',
          }
        : {
            severity: 'BLOCK',
            code: ErrorCode.SCHEDULE_PAYMENT_METHOD_REQUIRED,
            message: 'Choose a saved card for automatic payment, or pay by link for each order.',
          },
    );
  }

  /*
   * The notice period, as the review screen has to show it.
   *
   * Reported as a problem rather than thrown, like every other block on this
   * screen: a customer adjusting a form should see what is wrong beside the
   * field, not a toast from a failed request. `createSchedule` throws for
   * real when they submit, so the two cannot drift - this is the courtesy and
   * that is the guarantee.
   */
  const floor = await deliveryNoticeFloor({
    scheduleTimezone: timezone,
    shippingAddressId: config.shippingAddressId,
    customerProfileId,
    fulfilmentRule: config.fulfilmentRule ?? 'AUTO',
    inventoryLocationId: config.inventoryLocationId ?? null,
  });

  // Measured against the first delivery this configuration produces, not
  // against the start date - see `assertDeliveryNotice`, which is what
  // actually refuses the creation this screen is previewing. A configuration
  // that produces no dates at all already has its own problem above.
  const firstDeliveryDay = firstRun === null ? null : todayIn(timezone, firstRun);

  if (firstDeliveryDay !== null && firstDeliveryDay < floor.earliest) {
    problems.push({
      severity: 'BLOCK',
      code: ErrorCode.SCHEDULE_DATE_TOO_SOON,
      message:
        floor.warehouseEarliest !== null && floor.warehouseEarliest > floor.noticeFloor
          ? `The warehouse you chose cannot deliver before ${floor.earliest}.`
          : `The first delivery needs ${String(floor.noticeDays)} days' notice. The earliest we can take is ${floor.earliest}.`,
    });
  }

  const editCutoffMinutes = env.SCHEDULE_EDIT_CUTOFF_MINUTES;

  return {
    name: config.name?.trim() ?? defaultName(resolved, config.frequency),
    kind: isRepeating(config.frequency) ? 'RECURRING' : 'ONE_TIME',
    frequency: config.frequency,
    summary: isRepeating(config.frequency)
      ? describeRule({
          frequency: config.frequency,
          intervalDays: config.intervalDays ?? null,
          intervalMonths: config.intervalMonths ?? null,
          weekday: config.weekday ?? null,
          monthDay: config.monthDay ?? null,
          timezone,
          runAtMinute,
        })
      : firstRun === null
        ? 'Once'
        : `Once, on ${formatInZone(firstRun, timezone)}`,
    nextProcessingAt: firstRun?.toISOString() ?? null,
    nextProcessingLabel: firstRun === null ? null : formatInZone(firstRun, timezone),
    timezone,
    editableUntil:
      firstRun === null
        ? null
        : (editableUntil({ nextRunAt: firstRun, editCutoffMinutes })?.toISOString() ?? null),
    earliestDeliveryDate: floor.earliest,
    noticeDays: floor.noticeDays,
    warehouseEarliestDate: floor.warehouseEarliest,
    quote,
    deliveryAddress: address,
    paymentMethod: {
      mode: config.paymentMode,
      description: paymentDescription,
      payerEmail: config.payerEmail ?? null,
    },
    problems,
    canActivate: !problems.some((problem) => problem.severity === 'BLOCK'),
  };
}

/**
 * Create the draft.
 *
 * Charges nobody and leaves the cart alone. The stored snapshot is the basket
 * as the review screen priced it, kept as evidence of what was agreed - never
 * as an input to what is later charged.
 */
export async function createCartSchedule(
  customerProfileId: string,
  config: CartScheduleConfig,
  actor: ScheduleActor,
): Promise<CreatedSchedule & { preview: CartSchedulePreview }> {
  const preview = await previewCartSchedule(customerProfileId, config);

  if (!preview.canActivate) {
    const blocking = preview.problems.filter((problem) => problem.severity === 'BLOCK');

    // The problem's own code where it is one of the published set, so both
    // frontends can map it to their eight languages. A quote problem carries a
    // plain string - most are ErrorCodes but nothing in the type says so - and
    // an unrecognised one falls back rather than inventing a code the
    // frontends have never heard of.
    const first = blocking[0];
    const code: ErrorCodeValue =
      first !== undefined && first.code in ErrorCode
        ? (first.code as ErrorCodeValue)
        : ErrorCode.VALIDATION_FAILED;

    throw badRequest(
      code,
      first?.message ?? 'This schedule cannot be set up as configured.',
      blocking.map((problem) => ({
        code: problem.code,
        message: problem.message,
        ...(problem.productId === undefined ? {} : { meta: { productId: problem.productId } }),
      })),
    );
  }

  const resolved = await resolveCart(customerProfileId, {
    shippingMethodCode: config.shippingMethodCode ?? null,
  });

  const created = await createSchedule(
    {
      customerProfileId,
      name: preview.name,
      frequency: config.frequency,
      intervalDays: config.intervalDays ?? null,
      intervalMonths: config.intervalMonths ?? null,
      weekday: config.weekday ?? null,
      monthDay: config.monthDay ?? null,
      timezone: preview.timezone,
      runAtMinute: config.runAtMinute ?? 360,
      startDate: config.startDate,
      endDate: config.endDate ?? null,
      maxOccurrences: config.maxOccurrences ?? null,
      paymentMode: config.paymentMode,
      paymentMethodId: config.paymentMethodId ?? null,
      payerEmail: config.payerEmail ?? null,
      shippingAddressId: config.shippingAddressId,
      billingAddressId: config.billingAddressId ?? config.shippingAddressId,
      shippingMethodCode: config.shippingMethodCode ?? null,
      items: itemsFromCart(resolved, config),
      // Consent is taken at activation, against the numbers the customer read.
      consentAccepted: false,
      asDraft: true,
      substitutionPolicy: config.substitutionPolicy ?? 'NEVER',
      fulfilmentRule: config.fulfilmentRule ?? 'AUTO',
      inventoryLocationId: config.inventoryLocationId ?? null,
      cartSnapshotJson: snapshotOf(preview),
      sourceCartId: resolved.cartId,
    },
    actor,
  );

  return { ...created, preview };
}

/**
 * Empty the cart once a plan built from it goes live.
 *
 * Called after activation rather than at draft creation: a customer who
 * abandons a draft keeps their basket. The cart is marked CONVERTED, the same
 * state an ordinary checkout leaves it in, so nothing downstream has to learn
 * a new one.
 */
export async function convertCartAfterActivation(
  customerProfileId: string,
  scheduleId: string,
): Promise<{ converted: boolean }> {
  const schedule = await prisma.recurringSchedule.findFirst({
    where: { id: scheduleId, customerProfileId },
    select: { sourceCartId: true, status: true },
  });

  if (schedule === null || schedule.sourceCartId === null) return { converted: false };
  if (schedule.status !== 'ACTIVE') return { converted: false };

  // Only if it is still the customer's open cart. A cart they have since
  // checked out, or emptied and refilled for something else, is not this
  // plan's to clear.
  const cart = await prisma.cart.findFirst({
    where: { id: schedule.sourceCartId, customerProfileId, status: 'ACTIVE' },
    select: { id: true },
  });

  if (cart === null) return { converted: false };

  await prisma.$transaction(async (tx) => {
    await tx.cart.update({ where: { id: cart.id }, data: { status: 'CONVERTED' } });
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
  });

  return { converted: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assertFeatureAvailable(frequency: Frequency): void {
  if (!isRepeating(frequency) && !env.FEATURE_SCHEDULED_ORDERS) {
    throw badRequest(
      ErrorCode.FEATURE_DISABLED,
      'Scheduling an order for a future date is not available.',
    );
  }

  if (isRepeating(frequency) && !env.FEATURE_RECURRING_ORDERS) {
    throw badRequest(ErrorCode.FEATURE_DISABLED, 'Repeat orders are not available.');
  }
}

/**
 * The cart's lines as schedule items, with the customer's overrides applied.
 *
 * Lines the customer cannot schedule are dropped rather than refused, and the
 * caller reports them: a basket of ten things where one is not available for
 * repeat purchase should offer a subscription for the other nine, not a blank
 * refusal. `createSchedule` re-checks every remaining line anyway.
 */
function itemsFromCart(
  resolved: Awaited<ReturnType<typeof resolveCart>>,
  config: CartScheduleConfig,
): ScheduleItemInput[] {
  return resolved.lines
    .filter((line) => line.isRecurringEligible)
    .map((line) => {
      const substitute = config.substitutes?.[line.itemId];

      // The customer may have retyped the quantity on the review screen, and
      // that number is in pieces like every other quantity. The pack count
      // follows it through the line's own snapshot, so a plan built from a
      // basket of cartons stays a plan of cartons.
      const quantity = config.quantities?.[line.itemId] ?? line.quantity;
      const piecesPerUnit = Math.max(line.ordering.piecesPerUnit, 1);

      return {
        productId: line.productId,
        variantId: line.variantId,
        quantity,
        orderingUnit: line.ordering.unit,
        unitQuantity:
          line.ordering.unit === 'PIECE'
            ? quantity
            : Math.max(1, Math.round(quantity / piecesPerUnit)),
        piecesPerUnitSnapshot: line.ordering.piecesPerUnit,
        substituteProductId: substitute?.productId ?? null,
        substituteVariantId: substitute?.variantId ?? null,
      };
    });
}

/** A name the customer will recognise in their list, without being asked for one. */
function defaultName(
  resolved: Awaited<ReturnType<typeof resolveCart>>,
  frequency: Frequency,
): string {
  const first = resolved.lines[0]?.name ?? 'Scheduled order';
  const others = resolved.lines.length - 1;

  const basket =
    others > 0 ? `${first} + ${String(others)} more` : first;

  return (isRepeating(frequency) ? basket : `${basket} (one delivery)`).slice(0, 128);
}

/**
 * The first processing instant.
 *
 * Shares its arithmetic with creation by going through the same recurrence
 * functions, so the review screen and the stored plan cannot disagree about
 * the date.
 */
function computeFirstRun(input: {
  frequency: Frequency;
  intervalDays: number | null;
  intervalMonths: number | null;
  weekday: number | null;
  monthDay: number | null;
  timezone: string;
  runAtMinute: number;
  startDate: string;
}): Date | null {
  const startDate = new Date(`${input.startDate}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime())) return null;

  try {
    if (!isRepeating(input.frequency)) {
      // A one-shot delivery is the start date at the chosen local time. Routed
      // through a WEEKLY rule on that date's own weekday so the zone
      // conversion is the same code the recurring path uses - see
      // `oneTimeInstant` in schedule.service.ts, which does this for real.
      const [year, month, day] = input.startDate.split('-').map(Number);
      const jsDay = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)).getUTCDay();

      return nextRunAtSafe({
        rule: {
          frequency: 'WEEKLY',
          weekday: jsDay === 0 ? 7 : jsDay,
          timezone: input.timezone,
          runAtMinute: input.runAtMinute,
        },
        startDate,
        after: startDate,
      });
    }

    return nextRunAtSafe({
      rule: {
        frequency: input.frequency,
        intervalDays: input.intervalDays,
        intervalMonths: input.intervalMonths,
        weekday: input.weekday,
        monthDay: input.monthDay,
        timezone: input.timezone,
        runAtMinute: input.runAtMinute,
      },
      startDate,
    });
  } catch {
    // An invalid rule. Reported as a problem by the caller rather than thrown:
    // this is a preview, and a half-filled form should render.
    return null;
  }
}

/**
 * `nextRunAt`, returning null instead of throwing on a rule it cannot use.
 *
 * This is a preview of a form the customer is still filling in, so a rule that
 * does not yet make sense - WEEKLY with no weekday chosen - has to render as a
 * problem rather than a 500.
 */
function nextRunAtSafe(input: NextRunInput): Date | null {
  try {
    return nextRunAt(input);
  } catch {
    return null;
  }
}

/** A date and time a person reads, in the plan's own zone. */
function formatInZone(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(instant);
  } catch {
    return instant.toISOString();
  }
}

/** Which card, in the words a person reads. Never the provider reference. */
async function describePaymentMethod(
  customerProfileId: string,
  config: CartScheduleConfig,
): Promise<string | null> {
  if (config.paymentMode !== 'AUTO_PAY') return null;

  const methods = await listPaymentMethods(customerProfileId);

  const chosen =
    config.paymentMethodId === null || config.paymentMethodId === undefined
      ? methods.find((method) => method.isDefault) ?? null
      : (methods.find((method) => method.id === config.paymentMethodId) ?? null);

  if (chosen === null || chosen.status !== 'ACTIVE') return null;

  const expiry =
    chosen.expMonth === null || chosen.expYear === null
      ? ''
      : ` (expires ${String(chosen.expMonth).padStart(2, '0')}/${String(chosen.expYear).slice(-2)})`;

  return `${chosen.brand ?? 'Card'} ending ${chosen.last4 ?? '????'}${expiry}`;
}

/**
 * The snapshot stored on the plan.
 *
 * Money as strings, as everywhere else it crosses a boundary. This is evidence
 * of what the customer agreed to, so it records what they were shown rather
 * than a re-derivation of it.
 */
function snapshotOf(preview: CartSchedulePreview): Prisma.InputJsonValue {
  return {
    agreedAt: new Date().toISOString(),
    summary: preview.summary,
    frequency: preview.frequency,
    timezone: preview.timezone,
    firstProcessingAt: preview.nextProcessingAt,
    currency: preview.quote.currency,
    lines: preview.quote.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      name: line.name,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPrice.minor,
      lineTotalMinor: line.lineTotal.minor,
    })),
    // What the customer was counting in when they agreed. Part of the evidence
    // for the same reason the prices are: "three cartons a month" is what they
    // consented to, and the piece count is how it was worked out.
    orderingUnits: preview.quote.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      unit: line.ordering?.unit ?? 'PIECE',
      unitQuantity: line.ordering?.unitQuantity ?? line.quantity,
      piecesPerUnit: line.ordering?.piecesPerUnit ?? 1,
    })),
    totals: {
      subtotalMinor: preview.quote.totals.subtotal.minor,
      discountMinor: preview.quote.totals.discount.minor,
      taxMinor: preview.quote.totals.tax.minor,
      shippingMinor: preview.quote.totals.shipping.minor,
      grandTotalMinor: preview.quote.totals.grandTotal.minor,
    },
    deliveryAddressId: preview.deliveryAddress?.id ?? null,
    paymentMode: preview.paymentMethod.mode,
    paymentDescription: preview.paymentMethod.description,
  };
}

/** The formatted total, for a caller that only wants the headline figure. */
export function headlineTotal(preview: CartSchedulePreview): string {
  return serialiseMoney(
    BigInt(preview.quote.totals.grandTotal.minor),
    preview.quote.currency,
  ).formatted;
}
