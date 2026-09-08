/**
 * Scheduled orders: Buy Later, and Subscribe & Reorder.
 *
 * A plan is a standing authority to charge someone, so activation is guarded
 * harder than an ordinary record:
 *
 *   - Every product must be individually marked recurring-eligible. An admin
 *     opts a product in; a customer cannot schedule anything they like.
 *   - Explicit consent is required and versioned, so a policy change can force
 *     re-consent rather than silently inheriting the old agreement.
 *   - Auto-pay needs a stored payment method whose own consent record says it
 *     may be charged off-session. No method, no auto-charge.
 *   - A plan built through the review flow starts as a DRAFT and charges
 *     nobody until the customer confirms what they read.
 *
 * Editing a plan only ever affects FUTURE runs, and only outside the edit
 * cutoff. Inside it the worker may already be pricing the delivery, and an
 * edit would race the charge - the customer would see one basket and be billed
 * for another. Completed orders are immutable.
 *
 * Nothing in this file writes `status` directly. Plan and occurrence statuses
 * go through `schedule-state.ts`, for the same reason order statuses go
 * through `order-state-machine.ts`.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  describeRule,
  isRepeating,
  isValidTimeZone,
  nextRunAt,
  validateRule,
  type Frequency,
  type RecurrenceRule,
} from '../../domain/recurrence.js';
import {
  assertOccurrenceTransition,
  assertPlanTransition,
  isCustomerEditable,
  type PlanStatusName,
  type ScheduleActorKind,
} from '../../domain/schedule-state.js';
import { newId, variantKeyOf } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import { assertChargeable } from '../payments/payment-method.service.js';
import { materialiseOccurrences, rematerialiseOccurrences } from './occurrence.service.js';

export interface ScheduleActor {
  userId: string;
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  ipAddress?: string | null;
  correlationId?: string | null;
}

/** The state machine's notion of who is acting. */
function actorKind(actor: ScheduleActor): ScheduleActorKind {
  return actor.type;
}

export interface ScheduleItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  /** The one product the customer authorises as a stand-in for this line. */
  substituteProductId?: string | null;
  substituteVariantId?: string | null;
}

export interface CreateScheduleInput {
  customerProfileId: string;
  name: string;
  /** ONE_TIME is Buy Later: one delivery, then the plan is COMPLETED. */
  frequency: Frequency;
  intervalDays?: number | null;
  weekday?: number | null;
  monthDay?: number | null;
  timezone?: string;
  runAtMinute?: number;
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  paymentMode: 'AUTO_PAY' | 'PAYMENT_LINK';
  /** The stored instrument for auto-pay. Preferred over `mandateReference`. */
  paymentMethodId?: string | null;
  mandateReference?: string | null;
  payerEmail?: string | null;
  shippingAddressId: string;
  billingAddressId?: string;
  shippingMethodCode?: string | null;
  items: ScheduleItemInput[];
  /**
   * Must be true unless the plan is being created as a draft.
   *
   * A draft charges nobody, so it does not need consent yet - consent is taken
   * at activation, against the amounts on the review screen. Creating a plan
   * ACTIVE in one step (the admin API, and the API-first path) still requires
   * it here.
   */
  consentAccepted: boolean;
  consentVersion?: string;
  maxFailures?: number;
  repriceApprovalThresholdMinor?: string | null;
  priceTolerancePercent?: string | null;
  priceToleranceMinor?: string | null;
  editCutoffMinutes?: number;
  substitutionPolicy?: 'NEVER' | 'SAVED_PREFERENCE';
  fulfilmentRule?: 'AUTO' | 'FIXED_LOCATION';
  inventoryLocationId?: string | null;
  /**
   * Start as a DRAFT rather than ACTIVE.
   *
   * The storefront's flow: configure, read the review screen, then confirm.
   */
  asDraft?: boolean;
  /** Provenance, when the plan came from a cart. */
  cartSnapshotJson?: Prisma.InputJsonValue;
  sourceCartId?: string | null;
}

export interface CreatedSchedule {
  scheduleId: string;
  name: string;
  status: PlanStatusName;
  summary: string;
  nextRunAt: Date | null;
  paymentMode: string;
  kind: 'ONE_TIME' | 'RECURRING';
}

function ruleFrom(input: {
  frequency: Frequency;
  intervalDays?: number | null;
  weekday?: number | null;
  monthDay?: number | null;
  timezone: string;
  runAtMinute: number;
}): RecurrenceRule {
  return {
    frequency: input.frequency,
    intervalDays: input.intervalDays ?? null,
    weekday: input.weekday ?? null,
    monthDay: input.monthDay ?? null,
    timezone: input.timezone,
    runAtMinute: input.runAtMinute,
  };
}

/**
 * The instant a one-shot plan fires.
 *
 * `startDate` is a calendar date in the customer's own zone and `runAtMinute`
 * is a wall-clock time in it, so the two are combined through the same
 * zone-aware path a recurring rule uses. Doing it any other way is how "deliver
 * at 09:00 on the 14th" becomes 03:30 for a customer in Kolkata.
 */
function oneTimeInstant(startDate: string, runAtMinute: number, timezone: string): Date {
  const [year, month, day] = startDate.split('-').map(Number);

  // Reuses the recurrence engine rather than reimplementing the conversion.
  // `nextRunAt` returns the start instant whenever it is still in the future,
  // which is exactly what is wanted here - and the past case is refused by the
  // caller before this is reached.
  const instant = nextRunAt({
    rule: { frequency: 'WEEKLY', weekday: isoWeekdayOf(year ?? 1970, month ?? 1, day ?? 1), timezone, runAtMinute },
    startDate: new Date(`${startDate}T00:00:00.000Z`),
    after: new Date(`${startDate}T00:00:00.000Z`),
  });

  if (instant === null) {
    throw badRequest(ErrorCode.SCHEDULE_DATE_IN_PAST, 'Choose a delivery date in the future.');
  }

  return instant;
}

function isoWeekdayOf(year: number, month: number, day: number): number {
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return jsDay === 0 ? 7 : jsDay;
}

export async function createSchedule(
  input: CreateScheduleInput,
  actor: ScheduleActor,
): Promise<CreatedSchedule> {
  const asDraft = input.asDraft === true;

  // --- Feature gates -----------------------------------------------------
  if (!isRepeating(input.frequency) && !env.FEATURE_SCHEDULED_ORDERS) {
    throw badRequest(
      ErrorCode.FEATURE_DISABLED,
      'Scheduling an order for a future date is not available.',
    );
  }

  if (isRepeating(input.frequency) && !env.FEATURE_RECURRING_ORDERS) {
    throw badRequest(ErrorCode.FEATURE_DISABLED, 'Repeat orders are not available.');
  }

  // The flag gates the path that can actually take money: a stored card
  // charged off-session. It deliberately does NOT gate the older
  // `mandateReference` form, which has no charge implementation in this build -
  // a plan carrying one creates its orders and leaves them payable. Gating that
  // too would have broken every schedule created before this feature existed,
  // for no gain in safety.
  const usesStoredCard =
    input.paymentMode === 'AUTO_PAY' &&
    input.paymentMethodId !== null &&
    input.paymentMethodId !== undefined &&
    input.paymentMethodId.length > 0;

  if (usesStoredCard && !env.FEATURE_SUBSCRIPTION_AUTOPAY) {
    throw badRequest(
      ErrorCode.FEATURE_DISABLED,
      'Automatic payment for scheduled orders is not enabled. Choose to pay by link for each order.',
    );
  }

  // --- Consent ----------------------------------------------------------
  //
  // A draft has authorised nothing, so consent is taken at activation instead,
  // against the numbers on the review screen. Anything created ACTIVE in one
  // step needs it now.
  if (!asDraft && !input.consentAccepted) {
    throw badRequest(
      ErrorCode.SCHEDULE_CONSENT_REQUIRED,
      'You must confirm the schedule before it can be activated.',
      [{ field: 'consentAccepted', code: 'CONSENT_REQUIRED' }],
    );
  }

  if (input.items.length === 0) {
    throw badRequest(ErrorCode.CART_EMPTY, 'A schedule needs at least one product.');
  }

  const business = await prisma.businessProfile.findFirst({
    select: { timezone: true, currency: true },
  });

  const timezone = input.timezone ?? business?.timezone ?? env.DEFAULT_TIMEZONE;
  if (!isValidTimeZone(timezone)) {
    throw badRequest(ErrorCode.RECURRENCE_RULE_INVALID, `Unknown timezone: ${timezone}`, [
      { field: 'timezone', code: 'INVALID' },
    ]);
  }

  const runAtMinute = input.runAtMinute ?? 360;
  const rule = ruleFrom({ ...input, timezone, runAtMinute });

  try {
    validateRule(rule);
  } catch (error) {
    // RECURRENCE_RULE_INVALID, not SCHEDULE_FREQUENCY_NOT_SUPPORTED. Both
    // frontends already map this code in eight languages, and a rule whose
    // parameters do not fit its frequency is exactly what it has always meant.
    // The newer code is for a frequency this deployment does not offer at all.
    throw badRequest(
      ErrorCode.RECURRENCE_RULE_INVALID,
      error instanceof Error ? error.message : 'The recurrence rule is not valid.',
      [{ field: 'frequency', code: 'INVALID_RULE' }],
    );
  }

  // --- Payment mode -----------------------------------------------------
  if (input.paymentMode === 'AUTO_PAY') {
    const methodId = input.paymentMethodId ?? null;

    if (methodId === null || methodId.length === 0) {
      // No mandate either. Refused up front rather than discovered a week
      // later by a subscription that silently never charges.
      if ((input.mandateReference ?? '').length === 0) {
        // SCHEDULE_MANDATE_MISSING is the published code for "auto-pay with
        // nothing to charge", and both frontends already map it. The newer
        // SCHEDULE_PAYMENT_METHOD_REQUIRED is for the narrower case of a plan
        // that named a stored card which then turned out to be unusable.
        throw badRequest(
          ErrorCode.SCHEDULE_MANDATE_MISSING,
          'Automatic payment needs a saved card. Add one, or choose to pay by link for each order.',
          [{ field: 'paymentMethodId', code: 'REQUIRED' }],
        );
      }
    } else {
      const method = await prisma.customerPaymentMethod.findFirst({
        // Scoped to the owner: one customer must not be able to name another's
        // card, and this is the query that makes that impossible.
        where: { id: methodId, customerProfileId: input.customerProfileId },
      });

      if (method === null) {
        throw badRequest(
          ErrorCode.SCHEDULE_PAYMENT_METHOD_INVALID,
          'That saved card could not be found on your account.',
          [{ field: 'paymentMethodId', code: 'NOT_FOUND' }],
        );
      }

      assertChargeable(method);
    }
  } else if ((input.payerEmail ?? '').length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose who should receive the payment link for each order.',
      [{ field: 'payerEmail', code: 'REQUIRED' }],
    );
  }

  // --- Addresses --------------------------------------------------------
  const billingAddressId = input.billingAddressId ?? input.shippingAddressId;

  const addresses = await prisma.address.findMany({
    where: {
      id: { in: [...new Set([input.shippingAddressId, billingAddressId])] },
      customerProfileId: input.customerProfileId,
      archivedAt: null,
    },
    select: { id: true },
  });

  const foundIds = new Set(addresses.map((address) => address.id));
  if (!foundIds.has(input.shippingAddressId) || !foundIds.has(billingAddressId)) {
    throw badRequest(ErrorCode.ADDRESS_REQUIRED, 'Select a valid delivery and billing address.', [
      { field: 'shippingAddressId', code: 'NOT_FOUND' },
    ]);
  }

  // --- Warehouse --------------------------------------------------------
  if (input.fulfilmentRule === 'FIXED_LOCATION') {
    const locationId = input.inventoryLocationId ?? null;

    if (locationId === null) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Choose the warehouse this order should ship from.',
        [{ field: 'inventoryLocationId', code: 'REQUIRED' }],
      );
    }

    const location = await prisma.inventoryLocation.findFirst({
      where: { id: locationId, isActive: true },
      select: { id: true, operationalStatus: true },
    });

    if (location === null) {
      throw badRequest(ErrorCode.LOCATION_STILL_IN_USE, 'That warehouse is not available.', [
        { field: 'inventoryLocationId', code: 'NOT_FOUND' },
      ]);
    }
  }

  // --- Product eligibility ----------------------------------------------
  await assertItemsSchedulable(input.items);

  // --- Dates ------------------------------------------------------------
  const startDate = new Date(`${input.startDate}T00:00:00.000Z`);
  if (Number.isNaN(startDate.getTime())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter a valid start date.', [
      { field: 'startDate', code: 'INVALID' },
    ]);
  }

  const endDate =
    input.endDate === null || input.endDate === undefined
      ? null
      : new Date(`${input.endDate}T00:00:00.000Z`);

  if (endDate !== null && (Number.isNaN(endDate.getTime()) || endDate < startDate)) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The end date must be on or after the start date.',
      [{ field: 'endDate', code: 'INVALID_RANGE' }],
    );
  }

  const isOneTime = !isRepeating(input.frequency);

  // --- The first run, and the refusal of a date that has gone -----------
  const firstRun = isOneTime
    ? oneTimeInstant(input.startDate, runAtMinute, timezone)
    : nextRunAt({ rule, startDate });

  // A past date is refused rather than silently rolled forward. Rolling it
  // forward is worse than an error: the customer asked for the 14th, gets the
  // 21st, and is not told.
  if (firstRun === null) {
    throw badRequest(
      ErrorCode.SCHEDULE_FREQUENCY_NOT_SUPPORTED,
      'That schedule produces no delivery dates. Check the frequency and the dates.',
      [{ field: 'frequency', code: 'NO_OCCURRENCES' }],
    );
  }

  if (firstRun.getTime() <= Date.now()) {
    throw badRequest(
      ErrorCode.SCHEDULE_DATE_IN_PAST,
      isOneTime
        ? 'Choose a delivery date and time in the future.'
        : 'That schedule’s first delivery would be in the past. Choose a later start date.',
      [{ field: 'startDate', code: 'IN_PAST' }],
    );
  }

  const scheduleId = newId();
  const now = new Date();
  const status: PlanStatusName = asDraft ? 'DRAFT' : 'ACTIVE';

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.create({
      data: {
        id: scheduleId,
        customerProfileId: input.customerProfileId,
        name: input.name.trim(),
        status,
        kind: isOneTime ? 'ONE_TIME' : 'RECURRING',
        runOnceAt: isOneTime ? firstRun : null,
        frequency: input.frequency,
        intervalDays: input.intervalDays ?? null,
        weekday: input.weekday ?? null,
        monthDay: input.monthDay ?? null,
        timezone,
        runAtMinute,
        startDate,
        endDate,
        maxOccurrences: isOneTime ? 1 : (input.maxOccurrences ?? null),
        // A draft stays out of the worker's due query entirely, whatever else
        // is set on it.
        nextRunAt: asDraft ? null : firstRun,
        paymentMode: input.paymentMode,
        paymentMethodId: input.paymentMethodId ?? null,
        mandateReference: input.mandateReference ?? null,
        mandateProvider:
          input.paymentMode === 'AUTO_PAY'
            ? input.paymentMethodId !== null && input.paymentMethodId !== undefined
              ? 'STRIPE'
              : 'RAZORPAY'
            : null,
        payerEmail: input.payerEmail ?? null,
        shippingAddressId: input.shippingAddressId,
        billingAddressId,
        shippingMethodCode: input.shippingMethodCode ?? null,
        // Versioned, so a policy change can require fresh consent rather than
        // inheriting an agreement to different terms.
        consentAcceptedAt: now,
        consentVersion: input.consentVersion ?? 'v1',
        activatedAt: asDraft ? null : now,
        repriceApprovalThresholdMinor: bigIntOrNull(input.repriceApprovalThresholdMinor),
        priceTolerancePercent: input.priceTolerancePercent ?? null,
        priceToleranceMinor: bigIntOrNull(input.priceToleranceMinor),
        editCutoffMinutes: input.editCutoffMinutes ?? env.SCHEDULE_EDIT_CUTOFF_MINUTES,
        substitutionPolicy: input.substitutionPolicy ?? 'NEVER',
        fulfilmentRule: input.fulfilmentRule ?? 'AUTO',
        inventoryLocationId:
          input.fulfilmentRule === 'FIXED_LOCATION' ? (input.inventoryLocationId ?? null) : null,
        cartSnapshotJson: input.cartSnapshotJson ?? undefined,
        sourceCartId: input.sourceCartId ?? null,
        maxFailures: input.maxFailures ?? 3,
        items: {
          create: input.items.map((item) => ({
            id: newId(),
            productId: item.productId,
            variantId: item.variantId ?? null,
            variantKey: variantKeyOf(item.variantId ?? null),
            quantity: item.quantity,
            substituteProductId: item.substituteProductId ?? null,
            substituteVariantId: item.substituteVariantId ?? null,
            substituteVariantKey: variantKeyOf(item.substituteVariantId ?? null),
          })),
        },
      },
    });

    await recordAudit(
      {
        action: AuditAction.SCHEDULE_CREATED,
        resourceType: 'recurring_schedule',
        resourceId: scheduleId,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          name: input.name,
          kind: isOneTime ? 'ONE_TIME' : 'RECURRING',
          status,
          summary: describeRule(rule),
          paymentMode: input.paymentMode,
          itemCount: input.items.length,
          firstRunAt: firstRun.toISOString(),
          consentVersion: input.consentVersion ?? 'v1',
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // Rows the customer can skip or re-date. Only for a live plan - a draft has
  // no deliveries yet.
  if (!asDraft) await materialiseOccurrences(scheduleId);

  return {
    scheduleId,
    name: input.name.trim(),
    status,
    summary: describeRule(rule),
    nextRunAt: asDraft ? null : firstRun,
    paymentMode: input.paymentMode,
    kind: isOneTime ? 'ONE_TIME' : 'RECURRING',
  };
}

function bigIntOrNull(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined || value.length === 0) return null;
  return BigInt(value);
}

/**
 * Refuse a basket that cannot be put on a schedule.
 *
 * Collects every problem rather than throwing on the first: a B2B customer
 * with a forty-line basket should not fix it one round trip at a time.
 */
async function assertItemsSchedulable(items: ScheduleItemInput[]): Promise<void> {
  const productIds = [
    ...new Set([
      ...items.map((item) => item.productId),
      ...items
        .map((item) => item.substituteProductId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    ]),
  ];

  const products = await prisma.product.findMany({
    where: { ...publicProductWhere(), id: { in: productIds } },
    select: {
      id: true,
      name: true,
      isRecurringEligible: true,
      minOrderQty: true,
      maxOrderQty: true,
      qtyIncrement: true,
      hasVariants: true,
    },
  });

  const productById = new Map(products.map((product) => [product.id, product]));
  const problems: { field: string; code: string; message: string }[] = [];

  items.forEach((item, index) => {
    const product = productById.get(item.productId);

    if (product === undefined) {
      problems.push({
        field: `items.${String(index)}.productId`,
        code: 'NOT_AVAILABLE',
        message: 'This product is not available.',
      });
      return;
    }

    // The opt-in check. An admin decides which products may be scheduled.
    if (!product.isRecurringEligible) {
      problems.push({
        field: `items.${String(index)}.productId`,
        code: ErrorCode.SCHEDULE_PRODUCT_NOT_ELIGIBLE,
        message: `${product.name} cannot be set up as a scheduled purchase.`,
      });
    }

    if (item.quantity < product.minOrderQty) {
      problems.push({
        field: `items.${String(index)}.quantity`,
        code: ErrorCode.QUANTITY_BELOW_MINIMUM,
        message: `${product.name}: the minimum order quantity is ${String(product.minOrderQty)}.`,
      });
    }

    if (product.maxOrderQty !== null && item.quantity > product.maxOrderQty) {
      problems.push({
        field: `items.${String(index)}.quantity`,
        code: ErrorCode.QUANTITY_ABOVE_MAXIMUM,
        message: `${product.name}: the maximum order quantity is ${String(product.maxOrderQty)}.`,
      });
    }

    if (
      product.qtyIncrement > 1 &&
      (item.quantity - product.minOrderQty) % product.qtyIncrement !== 0
    ) {
      problems.push({
        field: `items.${String(index)}.quantity`,
        code: ErrorCode.QUANTITY_INCREMENT_INVALID,
        message: `${product.name}: order in multiples of ${String(product.qtyIncrement)} starting from ${String(product.minOrderQty)}.`,
      });
    }

    if (product.hasVariants && (item.variantId === null || item.variantId === undefined)) {
      problems.push({
        field: `items.${String(index)}.variantId`,
        code: ErrorCode.VARIANT_MISMATCH,
        message: `${product.name}: choose an option.`,
      });
    }

    // A substitute has to clear the same bar as the thing it replaces. A
    // stand-in nobody may schedule is not a stand-in.
    if (item.substituteProductId !== null && item.substituteProductId !== undefined) {
      const substitute = productById.get(item.substituteProductId);

      if (substitute === undefined || !substitute.isRecurringEligible) {
        problems.push({
          field: `items.${String(index)}.substituteProductId`,
          code: ErrorCode.SCHEDULE_PRODUCT_NOT_ELIGIBLE,
          message: 'The replacement product cannot be used on a scheduled order.',
        });
      }
    }
  });

  if (problems.length > 0) {
    throw badRequest(
      ErrorCode.SCHEDULE_PRODUCT_NOT_ELIGIBLE,
      'This schedule cannot be created as configured.',
      problems,
    );
  }
}

// ---------------------------------------------------------------------------
// Loading, scoped by owner
// ---------------------------------------------------------------------------

/**
 * Load a plan, scoped to its owner.
 *
 * `customerProfileId` of null means an administrator, who is not scoped by
 * ownership. Every customer-facing caller passes theirs, and that single
 * argument is what keeps one customer from reading or changing another's
 * schedule.
 */
async function loadOwnedSchedule(
  scheduleId: string,
  customerProfileId: string | null,
): Promise<{
  id: string;
  status: PlanStatusName;
  customerProfileId: string;
  name: string;
  kind: string;
  editCutoffMinutes: number;
  nextRunAt: Date | null;
  occurrenceCount: number;
}> {
  const schedule = await prisma.recurringSchedule.findFirst({
    where: {
      id: scheduleId,
      ...(customerProfileId !== null ? { customerProfileId } : {}),
    },
    select: {
      id: true,
      status: true,
      customerProfileId: true,
      name: true,
      kind: true,
      editCutoffMinutes: true,
      nextRunAt: true,
      occurrenceCount: true,
    },
  });

  if (schedule === null) throw notFound('Schedule');
  return { ...schedule, status: schedule.status };
}

/**
 * Refuse an edit that would race the worker.
 *
 * Inside the cutoff the engine may already be pricing the delivery: the
 * customer would see one basket on their screen and be charged for another.
 * The refusal names the date, because "too late" without one is not an answer
 * a person can act on.
 */
function assertOutsideCutoff(schedule: {
  nextRunAt: Date | null;
  editCutoffMinutes: number;
}): void {
  if (schedule.nextRunAt === null) return;

  const cutoff = new Date(schedule.nextRunAt.getTime() - schedule.editCutoffMinutes * 60_000);

  if (Date.now() >= cutoff.getTime()) {
    const hours = Math.round(schedule.editCutoffMinutes / 60);

    throw conflict(
      ErrorCode.SCHEDULE_EDIT_CUTOFF_PASSED,
      `This delivery is being prepared and can no longer be changed. Changes must be made at ` +
        `least ${String(hours)} hour${hours === 1 ? '' : 's'} before a delivery. You can change ` +
        `the ones after it.`,
      [
        {
          code: 'CUTOFF_PASSED',
          meta: {
            nextRunAt: schedule.nextRunAt.toISOString(),
            cutoffAt: cutoff.toISOString(),
            editCutoffMinutes: schedule.editCutoffMinutes,
          },
        },
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

/**
 * Turn a reviewed draft into a live authority to charge.
 *
 * The moment consent takes effect, and so the moment a dispute is measured
 * from. Consent is re-recorded here rather than inherited from creation: the
 * customer is agreeing to what the review screen showed them, which is not
 * necessarily what they typed into the form.
 */
export async function activateSchedule(
  scheduleId: string,
  input: { consentAccepted: boolean; consentVersion?: string },
  actor: ScheduleActor,
  customerProfileId: string | null,
): Promise<{ status: PlanStatusName; nextRunAt: Date | null }> {
  const schedule = await prisma.recurringSchedule.findFirst({
    where: { id: scheduleId, ...(customerProfileId !== null ? { customerProfileId } : {}) },
    include: { paymentMethod: true },
  });

  if (schedule === null) throw notFound('Schedule');

  if (schedule.status !== 'DRAFT') {
    throw conflict(
      ErrorCode.SCHEDULE_ALREADY_ACTIVATED,
      'This schedule has already been set up.',
      [{ code: 'NOT_DRAFT', meta: { status: schedule.status } }],
    );
  }

  if (!input.consentAccepted) {
    throw badRequest(
      ErrorCode.SCHEDULE_CONSENT_REQUIRED,
      'Please confirm the schedule to activate it.',
      [{ field: 'consentAccepted', code: 'CONSENT_REQUIRED' }],
    );
  }

  // Re-checked at activation, not just at creation: a draft can sit for days,
  // and a card can expire or be removed in that time.
  if (schedule.paymentMode === 'AUTO_PAY') {
    if (schedule.paymentMethod === null && (schedule.mandateReference ?? '').length === 0) {
      throw badRequest(
        ErrorCode.SCHEDULE_PAYMENT_METHOD_REQUIRED,
        'Add a card before activating this schedule.',
      );
    }

    if (schedule.paymentMethod !== null) assertChargeable(schedule.paymentMethod);
  }

  assertPlanTransition({ from: 'DRAFT', to: 'ACTIVE', actor: actorKind(actor) });

  // Recomputed from now. A draft created on Monday and confirmed on Thursday
  // must not fire for Monday's slot.
  const isOneTime = !isRepeating(schedule.frequency);

  const firstRun = isOneTime
    ? schedule.runOnceAt
    : nextRunAt({
        rule: ruleFrom({
          frequency: schedule.frequency,
          intervalDays: schedule.intervalDays,
          weekday: schedule.weekday,
          monthDay: schedule.monthDay,
          timezone: schedule.timezone,
          runAtMinute: schedule.runAtMinute,
        }),
        startDate: schedule.startDate,
      });

  if (firstRun === null || firstRun.getTime() <= Date.now()) {
    // The date the customer picked has passed while the draft sat unconfirmed.
    // Refused rather than moved: they should choose again knowingly.
    throw conflict(
      ErrorCode.SCHEDULE_DATE_IN_PAST,
      'The delivery date on this schedule has already passed. Please choose a new date.',
      [{ field: 'startDate', code: 'IN_PAST' }],
    );
  }

  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'ACTIVE',
        activatedAt: now,
        consentAcceptedAt: now,
        consentVersion: input.consentVersion ?? schedule.consentVersion,
        nextRunAt: firstRun,
      },
    });

    await recordAudit(
      {
        action: AuditAction.SCHEDULE_ACTIVATED,
        resourceType: 'recurring_schedule',
        resourceId: scheduleId,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: 'DRAFT' },
        after: {
          status: 'ACTIVE',
          nextRunAt: firstRun.toISOString(),
          consentVersion: input.consentVersion ?? schedule.consentVersion,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  await materialiseOccurrences(scheduleId);

  return { status: 'ACTIVE', nextRunAt: firstRun };
}

// ---------------------------------------------------------------------------
// Pause, resume, cancel
// ---------------------------------------------------------------------------

export async function pauseSchedule(
  scheduleId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
  reason?: string,
): Promise<void> {
  const schedule = await loadOwnedSchedule(scheduleId, customerProfileId);

  assertPlanTransition({
    from: schedule.status,
    to: 'PAUSED',
    actor: actorKind(actor),
    reason,
  });

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'PAUSED',
        pausedAt: new Date(),
        pausedReason: reason ?? null,
        pausedById: actor.userId,
        // Clearing nextRunAt takes it out of the worker's due query entirely.
        nextRunAt: null,
      },
    });

    // Pending deliveries are withdrawn, so a paused plan shows no upcoming
    // dates. Only untouched ones - anything the engine has started belongs to
    // its own lifecycle.
    await tx.scheduleOccurrence.updateMany({
      where: { scheduleId, status: 'SCHEDULED' },
      data: {
        status: 'CANCELLED',
        skipReason: 'the schedule was paused',
        completedAt: new Date(),
      },
    });

    await recordAudit(
      {
        action: AuditAction.SCHEDULE_PAUSED,
        resourceType: 'recurring_schedule',
        resourceId: scheduleId,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: schedule.status },
        after: { status: 'PAUSED', reason: reason ?? null },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

export async function resumeSchedule(
  scheduleId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
): Promise<{ nextRunAt: Date | null }> {
  const schedule = await prisma.recurringSchedule.findFirst({
    where: { id: scheduleId, ...(customerProfileId !== null ? { customerProfileId } : {}) },
    include: { paymentMethod: true },
  });

  if (schedule === null) throw notFound('Schedule');

  assertPlanTransition({
    from: schedule.status,
    to: 'ACTIVE',
    actor: actorKind(actor),
  });

  // Whatever paused it may still be true. Resuming onto a dead card would
  // pause it again at the next occurrence, having told the customer it was
  // running.
  if (schedule.paymentMode === 'AUTO_PAY' && schedule.paymentMethod !== null) {
    assertChargeable(schedule.paymentMethod);
  }

  const isOneTime = !isRepeating(schedule.frequency);

  // Recomputed from now, not from the paused value: a schedule paused for a
  // month must not fire four times to catch up.
  const next = isOneTime
    ? schedule.runOnceAt
    : nextRunAt({
        rule: ruleFrom({
          frequency: schedule.frequency,
          intervalDays: schedule.intervalDays,
          weekday: schedule.weekday,
          monthDay: schedule.monthDay,
          timezone: schedule.timezone,
          runAtMinute: schedule.runAtMinute,
        }),
        startDate: schedule.startDate,
        lastRunAt: schedule.lastRunAt,
      });

  // A Buy Later whose date passed while it was paused has nothing left to do.
  if (isOneTime && (next === null || next.getTime() <= Date.now())) {
    throw conflict(
      ErrorCode.SCHEDULE_DATE_IN_PAST,
      'The delivery date for this order has already passed. Create a new scheduled order instead.',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'ACTIVE',
        pausedAt: null,
        pausedReason: null,
        pausedById: null,
        // Resuming a FAILED schedule clears the counter, or it would pause
        // again on the next single failure.
        failureCount: 0,
        nextRunAt: next,
      },
    });

    await recordAudit(
      {
        action: AuditAction.SCHEDULE_RESUMED,
        resourceType: 'recurring_schedule',
        resourceId: scheduleId,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: schedule.status, failureCount: schedule.failureCount },
        after: { status: 'ACTIVE', nextRunAt: next?.toISOString() ?? null },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // Rebuilt rather than merely topped up: the pause cancelled the upcoming
  // rows and left them holding their slots. See `rematerialiseOccurrences`.
  await rematerialiseOccurrences(scheduleId);

  return { nextRunAt: next };
}

/**
 * Cancel a schedule.
 *
 * Stops future runs only. Orders already created keep their own lifecycle -
 * cancelling a subscription must not cancel goods already shipped, and must
 * not touch a delivery whose money has already moved.
 */
export async function cancelSchedule(
  scheduleId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
  reason?: string,
): Promise<void> {
  const schedule = await loadOwnedSchedule(scheduleId, customerProfileId);

  assertPlanTransition({
    from: schedule.status,
    to: 'CANCELLED',
    actor: actorKind(actor),
    reason,
  });

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.update({
      where: { id: scheduleId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelReason: reason ?? null,
        nextRunAt: null,
      },
    });

    // Only untouched cycles. Anything the engine has started - and in
    // particular anything paid - belongs to its own lifecycle and is left
    // exactly as it is.
    await tx.scheduleOccurrence.updateMany({
      where: { scheduleId, status: { in: ['SCHEDULED', 'PENDING'] } },
      data: {
        status: 'CANCELLED',
        skipReason: 'the schedule was cancelled',
        completedAt: new Date(),
      },
    });

    await recordAudit(
      {
        action: AuditAction.SCHEDULE_CANCELLED,
        resourceType: 'recurring_schedule',
        resourceId: scheduleId,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: schedule.status },
        after: { status: 'CANCELLED', reason: reason ?? null },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Engine-driven plan transitions
// ---------------------------------------------------------------------------

/**
 * A plan that has run its course.
 *
 * COMPLETED, not CANCELLED - which is what the previous engine wrote, and it
 * was wrong in a way the customer could see: "you cancelled this" and "this
 * finished" are different sentences, and a subscription that reached its end
 * date had not been cancelled by anybody.
 */
export async function completeSchedulePlan(scheduleId: string, reason: string): Promise<void> {
  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    select: { status: true },
  });

  if (schedule === null) return;

  const from = schedule.status;
  if (from !== 'ACTIVE' && from !== 'PAUSED') return;

  assertPlanTransition({ from, to: 'COMPLETED', actor: 'SYSTEM' });

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.updateMany({
      where: { id: scheduleId, status: from },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        cancelReason: reason.slice(0, 500),
        nextRunAt: null,
      },
    });

    await tx.scheduleOccurrence.updateMany({
      where: { scheduleId, status: 'SCHEDULED' },
      data: { status: 'CANCELLED', skipReason: reason.slice(0, 500), completedAt: new Date() },
    });

    await recordAudit(
      {
        action: AuditAction.SCHEDULE_COMPLETED,
        resourceType: 'recurring_schedule',
        resourceId: scheduleId,
        actorType: 'SYSTEM',
        after: { status: 'COMPLETED', reason },
      },
      tx,
    );
  });
}

/**
 * Suspend a plan after too many failures.
 *
 * FAILED, not CANCELLED. The customer's standing instruction is not withdrawn
 * - it is suspended until somebody looks at whatever kept failing. Only an
 * administrator can move it back to ACTIVE; see the state machine.
 */
export async function failSchedulePlan(scheduleId: string, reason: string): Promise<void> {
  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    select: { status: true },
  });

  if (schedule === null || schedule.status !== 'ACTIVE') return;

  assertPlanTransition({ from: 'ACTIVE', to: 'FAILED', actor: 'SYSTEM', reason });

  await prisma.recurringSchedule.updateMany({
    where: { id: scheduleId, status: 'ACTIVE' },
    data: {
      status: 'FAILED',
      pausedAt: new Date(),
      pausedReason: reason.slice(0, 500),
      nextRunAt: null,
    },
  });

  await recordAudit({
    action: AuditAction.SCHEDULE_PAUSED,
    resourceType: 'recurring_schedule',
    resourceId: scheduleId,
    actorType: 'SYSTEM',
    after: { status: 'FAILED', reason },
  });
}

/**
 * Pause a plan because something about it needs the customer.
 *
 * A dead card, a removed address, a withdrawn product. PAUSED rather than
 * FAILED because the customer can fix it themselves and resume.
 */
export async function pauseScheduleForFailure(
  scheduleId: string,
  reason: string,
): Promise<void> {
  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    select: { status: true },
  });

  if (schedule === null || schedule.status !== 'ACTIVE') return;

  assertPlanTransition({ from: 'ACTIVE', to: 'PAUSED', actor: 'SYSTEM' });

  await prisma.recurringSchedule.updateMany({
    where: { id: scheduleId, status: 'ACTIVE' },
    data: {
      status: 'PAUSED',
      pausedAt: new Date(),
      pausedReason: reason.slice(0, 500),
      nextRunAt: null,
    },
  });

  await recordAudit({
    action: AuditAction.SCHEDULE_PAUSED,
    resourceType: 'recurring_schedule',
    resourceId: scheduleId,
    actorType: 'SYSTEM',
    after: { status: 'PAUSED', reason },
  });
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

export interface UpdateScheduleInput {
  name?: string;
  frequency?: Frequency;
  intervalDays?: number | null;
  weekday?: number | null;
  monthDay?: number | null;
  runAtMinute?: number;
  /** Re-date a one-shot plan, or move a recurring plan's anchor. */
  startDate?: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  shippingAddressId?: string;
  billingAddressId?: string;
  shippingMethodCode?: string | null;
  payerEmail?: string | null;
  paymentMethodId?: string | null;
  items?: ScheduleItemInput[];
  substitutionPolicy?: 'NEVER' | 'SAVED_PREFERENCE';
  priceTolerancePercent?: string | null;
  priceToleranceMinor?: string | null;
  repriceApprovalThresholdMinor?: string | null;
  fulfilmentRule?: 'AUTO' | 'FIXED_LOCATION';
  inventoryLocationId?: string | null;
}

/**
 * Change future runs.
 *
 * Refused inside the edit cutoff, refused on a cancelled or completed plan,
 * and never touches an occurrence that already produced an order. Any change
 * to the rule or the dates re-materialises the upcoming rows, because their
 * dates came from a rule that no longer applies.
 */
export async function updateSchedule(
  scheduleId: string,
  input: UpdateScheduleInput,
  actor: ScheduleActor,
  customerProfileId: string | null,
): Promise<{ nextRunAt: Date | null }> {
  const schedule = await prisma.recurringSchedule.findFirst({
    where: { id: scheduleId, ...(customerProfileId !== null ? { customerProfileId } : {}) },
  });

  if (schedule === null) throw notFound('Schedule');

  if (schedule.status === 'CANCELLED') {
    throw conflict(ErrorCode.SCHEDULE_ALREADY_CANCELLED, 'A cancelled schedule cannot be edited.');
  }

  if (schedule.status === 'COMPLETED') {
    throw conflict(
      ErrorCode.SCHEDULE_NOT_ACTIVE,
      'This schedule has finished and cannot be edited. Create a new one instead.',
    );
  }

  // The cutoff applies to a customer, not to an administrator handling a
  // phone call about a delivery going out tomorrow.
  if (actor.type === 'CUSTOMER' && schedule.status === 'ACTIVE') {
    assertOutsideCutoff(schedule);
  }

  const frequency = input.frequency ?? schedule.frequency;
  const isOneTime = !isRepeating(frequency);

  const rule = ruleFrom({
    frequency,
    intervalDays: input.intervalDays ?? schedule.intervalDays,
    weekday: input.weekday ?? schedule.weekday,
    monthDay: input.monthDay ?? schedule.monthDay,
    timezone: schedule.timezone,
    runAtMinute: input.runAtMinute ?? schedule.runAtMinute,
  });

  try {
    validateRule(rule);
  } catch (error) {
    throw badRequest(
      ErrorCode.RECURRENCE_RULE_INVALID,
      error instanceof Error ? error.message : 'The recurrence rule is not valid.',
    );
  }

  const data: Prisma.RecurringScheduleUncheckedUpdateInput = {};

  if (input.name !== undefined) data.name = input.name.trim();
  if (input.frequency !== undefined) {
    data.frequency = input.frequency;
    data.kind = isOneTime ? 'ONE_TIME' : 'RECURRING';
  }
  if (input.intervalDays !== undefined) data.intervalDays = input.intervalDays;
  if (input.weekday !== undefined) data.weekday = input.weekday;
  if (input.monthDay !== undefined) data.monthDay = input.monthDay;
  if (input.runAtMinute !== undefined) data.runAtMinute = input.runAtMinute;
  if (input.maxOccurrences !== undefined) data.maxOccurrences = input.maxOccurrences;
  if (input.payerEmail !== undefined) data.payerEmail = input.payerEmail;
  if (input.shippingMethodCode !== undefined) data.shippingMethodCode = input.shippingMethodCode;
  if (input.substitutionPolicy !== undefined) data.substitutionPolicy = input.substitutionPolicy;

  if (input.priceTolerancePercent !== undefined) {
    data.priceTolerancePercent = input.priceTolerancePercent;
  }
  if (input.priceToleranceMinor !== undefined) {
    data.priceToleranceMinor = bigIntOrNull(input.priceToleranceMinor);
  }
  if (input.repriceApprovalThresholdMinor !== undefined) {
    data.repriceApprovalThresholdMinor = bigIntOrNull(input.repriceApprovalThresholdMinor);
  }

  const startDate =
    input.startDate === undefined
      ? schedule.startDate
      : new Date(`${input.startDate}T00:00:00.000Z`);

  if (input.startDate !== undefined) {
    if (Number.isNaN(startDate.getTime())) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter a valid date.', [
        { field: 'startDate', code: 'INVALID' },
      ]);
    }
    data.startDate = startDate;
  }

  if (input.endDate !== undefined) {
    data.endDate = input.endDate === null ? null : new Date(`${input.endDate}T00:00:00.000Z`);
  }

  // --- Warehouse --------------------------------------------------------
  if (input.fulfilmentRule !== undefined) {
    data.fulfilmentRule = input.fulfilmentRule;

    if (input.fulfilmentRule === 'FIXED_LOCATION') {
      const locationId = input.inventoryLocationId ?? schedule.inventoryLocationId;

      if (locationId === null) {
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          'Choose the warehouse this order should ship from.',
          [{ field: 'inventoryLocationId', code: 'REQUIRED' }],
        );
      }

      const location = await prisma.inventoryLocation.findFirst({
        where: { id: locationId, isActive: true },
        select: { id: true },
      });

      if (location === null) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'That warehouse is not available.', [
          { field: 'inventoryLocationId', code: 'NOT_FOUND' },
        ]);
      }

      data.inventoryLocationId = locationId;
    } else {
      data.inventoryLocationId = null;
    }
  } else if (input.inventoryLocationId !== undefined) {
    data.inventoryLocationId = input.inventoryLocationId;
  }

  // --- Addresses --------------------------------------------------------
  for (const [field, addressId] of [
    ['shippingAddressId', input.shippingAddressId],
    ['billingAddressId', input.billingAddressId],
  ] as const) {
    if (addressId === undefined) continue;

    const address = await prisma.address.findFirst({
      where: { id: addressId, customerProfileId: schedule.customerProfileId, archivedAt: null },
      select: { id: true },
    });

    if (address === null) {
      throw badRequest(ErrorCode.ADDRESS_REQUIRED, 'Select a valid address.', [
        { field, code: 'NOT_FOUND' },
      ]);
    }
    data[field] = addressId;
  }

  // --- Payment method ---------------------------------------------------
  if (input.paymentMethodId !== undefined) {
    if (input.paymentMethodId === null) {
      if (schedule.paymentMode === 'AUTO_PAY') {
        throw badRequest(
          ErrorCode.SCHEDULE_PAYMENT_METHOD_REQUIRED,
          'An automatic schedule needs a saved card.',
          [{ field: 'paymentMethodId', code: 'REQUIRED' }],
        );
      }
      data.paymentMethodId = null;
    } else {
      const method = await prisma.customerPaymentMethod.findFirst({
        // Owner-scoped, so one customer cannot attach another's card.
        where: { id: input.paymentMethodId, customerProfileId: schedule.customerProfileId },
      });

      if (method === null) {
        throw badRequest(
          ErrorCode.SCHEDULE_PAYMENT_METHOD_INVALID,
          'That saved card could not be found on your account.',
          [{ field: 'paymentMethodId', code: 'NOT_FOUND' }],
        );
      }

      assertChargeable(method);
      data.paymentMethodId = input.paymentMethodId;
    }
  }

  if (input.items !== undefined) {
    if (input.items.length === 0) {
      throw badRequest(ErrorCode.CART_EMPTY, 'A schedule needs at least one product.');
    }
    await assertItemsSchedulable(input.items);
  }

  // --- The next run -----------------------------------------------------
  const ruleChanged =
    input.frequency !== undefined ||
    input.intervalDays !== undefined ||
    input.weekday !== undefined ||
    input.monthDay !== undefined ||
    input.runAtMinute !== undefined ||
    input.startDate !== undefined ||
    input.endDate !== undefined;

  let next: Date | null = schedule.nextRunAt;

  if (schedule.status === 'ACTIVE' && ruleChanged) {
    next = isOneTime
      ? oneTimeInstant(
          (input.startDate ?? schedule.startDate.toISOString().slice(0, 10)),
          input.runAtMinute ?? schedule.runAtMinute,
          schedule.timezone,
        )
      : nextRunAt({ rule, startDate, lastRunAt: schedule.lastRunAt });

    if (next === null) {
      throw badRequest(
        ErrorCode.SCHEDULE_FREQUENCY_NOT_SUPPORTED,
        'That change leaves the schedule with no delivery dates.',
      );
    }

    if (next.getTime() <= Date.now()) {
      throw badRequest(
        ErrorCode.SCHEDULE_DATE_IN_PAST,
        'That change would put the next delivery in the past. Choose a later date.',
        [{ field: 'startDate', code: 'IN_PAST' }],
      );
    }

    data.nextRunAt = next;
    if (isOneTime) data.runOnceAt = next;
  }

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.update({ where: { id: scheduleId }, data });

    if (input.items !== undefined) {
      await tx.recurringScheduleItem.deleteMany({ where: { scheduleId } });
      await tx.recurringScheduleItem.createMany({
        data: input.items.map((item) => ({
          id: newId(),
          scheduleId,
          productId: item.productId,
          variantId: item.variantId ?? null,
          variantKey: variantKeyOf(item.variantId ?? null),
          quantity: item.quantity,
          substituteProductId: item.substituteProductId ?? null,
          substituteVariantId: item.substituteVariantId ?? null,
          substituteVariantKey: variantKeyOf(item.substituteVariantId ?? null),
        })),
      });
    }

    await recordAudit(
      {
        action: AuditAction.SCHEDULE_UPDATED,
        resourceType: 'recurring_schedule',
        resourceId: scheduleId,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          name: schedule.name,
          frequency: schedule.frequency,
          intervalDays: schedule.intervalDays,
          runAtMinute: schedule.runAtMinute,
          nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
          itemCount: undefined,
        },
        after: {
          ...Object.fromEntries(
            Object.entries(input).map(([key, value]) => [
              key,
              // Items are summarised rather than dumped: an audit row is read
              // by people, and a forty-line basket makes it unreadable.
              key === 'items' ? `${String(input.items?.length ?? 0)} items` : (value as never),
            ]),
          ),
          nextRunAt: next?.toISOString() ?? null,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // Upcoming rows came from a rule that no longer applies.
  if (schedule.status === 'ACTIVE' && (ruleChanged || input.items !== undefined)) {
    await rematerialiseOccurrences(scheduleId);
  }

  return { nextRunAt: next };
}

// ---------------------------------------------------------------------------
// Skipping one delivery
// ---------------------------------------------------------------------------

/**
 * Skip one upcoming delivery.
 *
 * The plan keeps running; only this cycle is withdrawn. `skippedByUser` is set
 * so the customer's own screens and the reminder can say "you skipped this"
 * rather than "we could not supply this" - both end in SKIPPED and they are
 * owed different sentences.
 *
 * Refused once the engine has touched the occurrence: at that point it is
 * being priced or charged, and skipping it would race the charge.
 */
export async function skipOccurrence(
  occurrenceId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
  reason?: string,
): Promise<{ scheduleId: string; plannedRunAt: Date }> {
  const occurrence = await prisma.scheduleOccurrence.findFirst({
    where: {
      id: occurrenceId,
      ...(customerProfileId !== null ? { schedule: { customerProfileId } } : {}),
    },
    include: { schedule: { select: { id: true, editCutoffMinutes: true, status: true } } },
  });

  if (occurrence === null) throw notFound('Scheduled delivery');

  if (!isCustomerEditable(occurrence.status)) {
    throw conflict(
      ErrorCode.OCCURRENCE_NOT_MODIFIABLE,
      'This delivery is already being prepared and can no longer be skipped.',
      [{ code: 'OCCURRENCE_STATUS', meta: { status: occurrence.status } }],
    );
  }

  if (actor.type === 'CUSTOMER') {
    assertOutsideCutoff({
      nextRunAt: occurrence.plannedRunAt,
      editCutoffMinutes: occurrence.schedule.editCutoffMinutes,
    });
  }

  assertOccurrenceTransition({ from: 'SCHEDULED', to: 'SKIPPED', actor: actorKind(actor) });

  // Conditional, so two clicks on "skip" do not race each other into an
  // inconsistent state.
  const updated = await prisma.scheduleOccurrence.updateMany({
    where: { id: occurrenceId, status: 'SCHEDULED' },
    data: {
      status: 'SKIPPED',
      skippedByUser: true,
      skipReason: reason ?? 'skipped at the customer’s request',
      completedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    throw conflict(
      ErrorCode.OCCURRENCE_NOT_MODIFIABLE,
      'This delivery has just started being prepared and can no longer be skipped.',
    );
  }

  await recordAudit({
    action: AuditAction.OCCURRENCE_SKIPPED,
    resourceType: 'schedule_occurrence',
    resourceId: occurrenceId,
    actorType: actor.type,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: {
      scheduleId: occurrence.scheduleId,
      plannedRunAt: occurrence.plannedRunAt.toISOString(),
      byUser: true,
      reason: reason ?? null,
    },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return { scheduleId: occurrence.scheduleId, plannedRunAt: occurrence.plannedRunAt };
}

/**
 * Skip whichever delivery is next.
 *
 * The convenience the customer's screen actually offers - "skip my next
 * delivery" - without them having to name an occurrence id.
 */
export async function skipNextOccurrence(
  scheduleId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
  reason?: string,
): Promise<{ occurrenceId: string; plannedRunAt: Date }> {
  const schedule = await loadOwnedSchedule(scheduleId, customerProfileId);

  if (schedule.status !== 'ACTIVE') {
    throw conflict(
      ErrorCode.SCHEDULE_NOT_ACTIVE,
      'Only an active schedule has a delivery to skip.',
      [{ code: 'SCHEDULE_STATUS', meta: { status: schedule.status } }],
    );
  }

  // Materialised on demand, so a plan whose rows have not been built yet
  // still answers this rather than reporting nothing to skip.
  await materialiseOccurrences(scheduleId);

  const next = await prisma.scheduleOccurrence.findFirst({
    where: { scheduleId, status: 'SCHEDULED', plannedRunAt: { gt: new Date() } },
    orderBy: { plannedRunAt: 'asc' },
    select: { id: true, plannedRunAt: true },
  });

  if (next === null) {
    throw notFound('Upcoming delivery');
  }

  await skipOccurrence(next.id, actor, customerProfileId, reason);
  return { occurrenceId: next.id, plannedRunAt: next.plannedRunAt };
}

/** Cancel one upcoming delivery outright, rather than skipping it. */
export async function cancelOccurrence(
  occurrenceId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
  reason?: string,
): Promise<void> {
  const occurrence = await prisma.scheduleOccurrence.findFirst({
    where: {
      id: occurrenceId,
      ...(customerProfileId !== null ? { schedule: { customerProfileId } } : {}),
    },
    select: { id: true, status: true, scheduleId: true },
  });

  if (occurrence === null) throw notFound('Scheduled delivery');

  assertOccurrenceTransition({
    from: occurrence.status,
    to: 'CANCELLED',
    actor: actorKind(actor),
  });

  await prisma.scheduleOccurrence.updateMany({
    where: { id: occurrenceId, status: occurrence.status },
    data: {
      status: 'CANCELLED',
      skippedByUser: actor.type === 'CUSTOMER',
      skipReason: reason ?? 'cancelled',
      completedAt: new Date(),
    },
  });

  await recordAudit({
    action: AuditAction.OCCURRENCE_CANCELLED,
    resourceType: 'schedule_occurrence',
    resourceId: occurrenceId,
    actorType: actor.type,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { scheduleId: occurrence.scheduleId, reason: reason ?? null },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export function scheduleSummary(schedule: {
  frequency: Frequency;
  intervalDays: number | null;
  weekday: number | null;
  monthDay: number | null;
  timezone: string;
  runAtMinute: number;
}): string {
  return describeRule(ruleFrom(schedule));
}

/**
 * When this plan can next be edited.
 *
 * Returned to the customer's screen so it can say what it will refuse, rather
 * than offering a button that then errors.
 */
export function editableUntil(schedule: {
  nextRunAt: Date | null;
  editCutoffMinutes: number;
}): Date | null {
  if (schedule.nextRunAt === null) return null;
  return new Date(schedule.nextRunAt.getTime() - schedule.editCutoffMinutes * 60_000);
}
