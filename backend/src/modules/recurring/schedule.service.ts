/**
 * Recurring schedules.
 *
 * A schedule is a standing authority to charge someone, so activation is
 * guarded harder than an ordinary record:
 *
 *   - Every product must be individually marked recurring-eligible. An admin
 *     opts a product in; a customer cannot schedule anything they like.
 *   - Explicit consent is required and versioned, so a policy change can force
 *     re-consent rather than silently inheriting the old agreement.
 *   - AUTO_PAY needs a stored provider mandate. No mandate, no auto-charge.
 *
 * Editing a schedule only ever affects FUTURE runs. Completed orders are
 * immutable (SOP 11).
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import {
  describeRule,
  isValidTimeZone,
  nextRunAt,
  validateRule,
  type RecurrenceRule,
} from '../../domain/recurrence.js';
import { newId, variantKeyOf } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';

export interface ScheduleActor {
  userId: string;
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface ScheduleItemInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface CreateScheduleInput {
  customerProfileId: string;
  name: string;
  frequency: 'EVERY_N_DAYS' | 'WEEKLY' | 'MONTHLY';
  intervalDays?: number | null;
  weekday?: number | null;
  monthDay?: number | null;
  timezone?: string;
  runAtMinute?: number;
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  paymentMode: 'AUTO_PAY' | 'PAYMENT_LINK';
  mandateReference?: string | null;
  payerEmail?: string | null;
  shippingAddressId: string;
  billingAddressId?: string;
  shippingMethodCode?: string | null;
  items: ScheduleItemInput[];
  /** Must be true. The customer is authorising future charges. */
  consentAccepted: boolean;
  consentVersion?: string;
  maxFailures?: number;
  repriceApprovalThresholdMinor?: string | null;
}

export interface CreatedSchedule {
  scheduleId: string;
  name: string;
  summary: string;
  nextRunAt: Date | null;
  paymentMode: string;
}

function ruleFrom(input: {
  frequency: 'EVERY_N_DAYS' | 'WEEKLY' | 'MONTHLY';
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

export async function createSchedule(
  input: CreateScheduleInput,
  actor: ScheduleActor,
): Promise<CreatedSchedule> {
  // --- Consent ----------------------------------------------------------
  if (!input.consentAccepted) {
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

  const timezone = input.timezone ?? business?.timezone ?? 'Asia/Kolkata';
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
    throw badRequest(
      ErrorCode.RECURRENCE_RULE_INVALID,
      error instanceof Error ? error.message : 'The recurrence rule is not valid.',
      [{ field: 'frequency', code: 'INVALID_RULE' }],
    );
  }

  // --- Payment mode -----------------------------------------------------
  //
  // AUTO_PAY without a mandate would fail silently at every occurrence, so it
  // is refused up front rather than discovered a week later.
  if (input.paymentMode === 'AUTO_PAY') {
    if (input.mandateReference === null || input.mandateReference === undefined || input.mandateReference.length === 0) {
      throw badRequest(
        ErrorCode.SCHEDULE_MANDATE_MISSING,
        'Auto-pay requires an authorised payment mandate. Complete the mandate setup first.',
        [{ field: 'mandateReference', code: 'REQUIRED' }],
      );
    }
  } else if (input.payerEmail === null || input.payerEmail === undefined || input.payerEmail.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Choose who should receive the payment link for each occurrence.',
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

  // --- Product eligibility ----------------------------------------------
  const productIds = input.items.map((item) => item.productId);

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

  input.items.forEach((item, index) => {
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
        message: `${product.name} cannot be set up as a repeat purchase.`,
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
  });

  if (problems.length > 0) {
    throw badRequest(
      ErrorCode.SCHEDULE_PRODUCT_NOT_ELIGIBLE,
      'This schedule cannot be created as configured.',
      problems,
    );
  }

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
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The end date must be on or after the start date.', [
      { field: 'endDate', code: 'INVALID_RANGE' },
    ]);
  }

  const firstRun = nextRunAt({ rule, startDate });
  const scheduleId = newId();
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.recurringSchedule.create({
      data: {
        id: scheduleId,
        customerProfileId: input.customerProfileId,
        name: input.name.trim(),
        status: 'ACTIVE',
        frequency: input.frequency,
        intervalDays: input.intervalDays ?? null,
        weekday: input.weekday ?? null,
        monthDay: input.monthDay ?? null,
        timezone,
        runAtMinute,
        startDate,
        endDate,
        maxOccurrences: input.maxOccurrences ?? null,
        nextRunAt: firstRun,
        paymentMode: input.paymentMode,
        mandateReference: input.mandateReference ?? null,
        mandateProvider: input.paymentMode === 'AUTO_PAY' ? 'RAZORPAY' : null,
        payerEmail: input.payerEmail ?? null,
        shippingAddressId: input.shippingAddressId,
        billingAddressId,
        shippingMethodCode: input.shippingMethodCode ?? null,
        // Versioned, so a policy change can require fresh consent rather than
        // inheriting an agreement to different terms.
        consentAcceptedAt: now,
        consentVersion: input.consentVersion ?? 'v1',
        repriceApprovalThresholdMinor:
          input.repriceApprovalThresholdMinor === null ||
          input.repriceApprovalThresholdMinor === undefined
            ? null
            : BigInt(input.repriceApprovalThresholdMinor),
        maxFailures: input.maxFailures ?? 3,
        items: {
          create: input.items.map((item) => ({
            id: newId(),
            productId: item.productId,
            variantId: item.variantId ?? null,
            variantKey: variantKeyOf(item.variantId ?? null),
            quantity: item.quantity,
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
          summary: describeRule(rule),
          paymentMode: input.paymentMode,
          itemCount: input.items.length,
          nextRunAt: firstRun?.toISOString() ?? null,
          consentVersion: input.consentVersion ?? 'v1',
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return {
    scheduleId,
    name: input.name.trim(),
    summary: describeRule(rule),
    nextRunAt: firstRun,
    paymentMode: input.paymentMode,
  };
}

async function loadOwnedSchedule(
  scheduleId: string,
  customerProfileId: string | null,
): Promise<{ id: string; status: string; customerProfileId: string; name: string }> {
  const schedule = await prisma.recurringSchedule.findFirst({
    // A null customerProfileId means an admin, who is not scoped by ownership.
    where: {
      id: scheduleId,
      ...(customerProfileId !== null ? { customerProfileId } : {}),
    },
    select: { id: true, status: true, customerProfileId: true, name: true },
  });

  if (schedule === null) throw notFound('Schedule');
  return schedule;
}

export async function pauseSchedule(
  scheduleId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
  reason?: string,
): Promise<void> {
  const schedule = await loadOwnedSchedule(scheduleId, customerProfileId);

  if (schedule.status === 'CANCELLED') {
    throw conflict(ErrorCode.SCHEDULE_ALREADY_CANCELLED, 'This schedule has already been cancelled.');
  }

  if (schedule.status === 'PAUSED') {
    throw conflict(ErrorCode.SCHEDULE_NOT_ACTIVE, 'This schedule is already paused.');
  }

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
  });

  if (schedule === null) throw notFound('Schedule');

  if (schedule.status === 'CANCELLED') {
    throw conflict(
      ErrorCode.SCHEDULE_ALREADY_CANCELLED,
      'A cancelled schedule cannot be resumed. Create a new one instead.',
    );
  }

  if (schedule.status === 'ACTIVE') {
    throw conflict(ErrorCode.CONFLICT, 'This schedule is already active.');
  }

  const rule = ruleFrom({
    frequency: schedule.frequency,
    intervalDays: schedule.intervalDays,
    weekday: schedule.weekday,
    monthDay: schedule.monthDay,
    timezone: schedule.timezone,
    runAtMinute: schedule.runAtMinute,
  });

  // Recomputed from now, not from the paused value: a schedule paused for a
  // month must not fire four times to catch up.
  const next = nextRunAt({
    rule,
    startDate: schedule.startDate,
    lastRunAt: schedule.lastRunAt,
  });

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

  return { nextRunAt: next };
}

/**
 * Cancel a schedule.
 *
 * Stops future runs only. Orders already created keep their own lifecycle -
 * cancelling a subscription must not cancel goods already shipped.
 */
export async function cancelSchedule(
  scheduleId: string,
  actor: ScheduleActor,
  customerProfileId: string | null,
  reason?: string,
): Promise<void> {
  const schedule = await loadOwnedSchedule(scheduleId, customerProfileId);

  if (schedule.status === 'CANCELLED') {
    throw conflict(ErrorCode.SCHEDULE_ALREADY_CANCELLED, 'This schedule is already cancelled.');
  }

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

    // Only PENDING occurrences. A completed one belongs to a real order.
    await tx.scheduleOccurrence.updateMany({
      where: { scheduleId, status: 'PENDING' },
      data: { status: 'SKIPPED', skipReason: 'schedule cancelled', completedAt: new Date() },
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

export interface UpdateScheduleInput {
  name?: string;
  intervalDays?: number | null;
  weekday?: number | null;
  monthDay?: number | null;
  runAtMinute?: number;
  endDate?: string | null;
  maxOccurrences?: number | null;
  shippingAddressId?: string;
  billingAddressId?: string;
  payerEmail?: string | null;
  items?: ScheduleItemInput[];
}

/**
 * Change future runs.
 *
 * Recomputes `nextRunAt` from the new rule. Never touches an occurrence that
 * already produced an order.
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

  const rule = ruleFrom({
    frequency: schedule.frequency,
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
  if (input.intervalDays !== undefined) data.intervalDays = input.intervalDays;
  if (input.weekday !== undefined) data.weekday = input.weekday;
  if (input.monthDay !== undefined) data.monthDay = input.monthDay;
  if (input.runAtMinute !== undefined) data.runAtMinute = input.runAtMinute;
  if (input.maxOccurrences !== undefined) data.maxOccurrences = input.maxOccurrences;
  if (input.payerEmail !== undefined) data.payerEmail = input.payerEmail;

  if (input.endDate !== undefined) {
    data.endDate = input.endDate === null ? null : new Date(`${input.endDate}T00:00:00.000Z`);
  }

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

  // An active schedule gets a fresh next run; a paused one stays out of the
  // worker's due query until it is resumed.
  const next =
    schedule.status === 'ACTIVE'
      ? nextRunAt({ rule, startDate: schedule.startDate, lastRunAt: schedule.lastRunAt })
      : null;

  if (schedule.status === 'ACTIVE') data.nextRunAt = next;

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
          intervalDays: schedule.intervalDays,
          runAtMinute: schedule.runAtMinute,
          nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
        },
        after: { ...input, nextRunAt: next?.toISOString() ?? null },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { nextRunAt: next };
}

export function scheduleSummary(schedule: {
  frequency: 'EVERY_N_DAYS' | 'WEEKLY' | 'MONTHLY';
  intervalDays: number | null;
  weekday: number | null;
  monthDay: number | null;
  timezone: string;
  runAtMinute: number;
}): string {
  return describeRule(ruleFrom(schedule));
}
