/**
 * The recurring order runner.
 *
 * This is the most dangerous code in the system: it charges people without
 * anyone watching. A duplicate here is a duplicate charge on a real card.
 *
 * Duplicate protection is structural, not procedural - it does not depend on
 * this code being careful:
 *
 *   1. `unique(scheduleId, plannedRunAt)` on schedule_occurrences. The
 *      occurrence row is inserted BEFORE any side effect, so a second worker,
 *      a retry, a clock skew or a replayed job all collide on the index and
 *      stop.
 *   2. `unique(orders.scheduleOccurrenceId)`. Even if an occurrence were
 *      somehow processed twice, it could not produce two orders.
 *   3. A lease on the schedule row, so two workers do not even try at once.
 *
 * Claiming uses a conditional UPDATE rather than `FOR UPDATE SKIP LOCKED`,
 * which MariaDB 10.4 does not have. See database-queue.ts for the same pattern.
 */
import { ErrorCode } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { assertTotalsConsistent, priceLines, type PricingLineInput } from '../../domain/pricing.js';
import { nextRunAt, retryDelayMinutes } from '../../domain/recurrence.js';
import { newId } from '../../infra/ids.js';
import { logger, loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import { checkPurchasingLimits } from '../customers/limits.service.js';
import { reserveStock } from '../inventory/inventory.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { createPaymentLink } from '../payments/payment-link.service.js';

/** How long a claimed schedule stays leased to one worker. */
const LEASE_SECONDS = 120;

export interface ClaimedSchedule {
  id: string;
  plannedRunAt: Date;
}

/**
 * Claim due schedules.
 *
 * Optimistic and lock-free, because MariaDB 10.4 lacks SKIP LOCKED and a plain
 * `FOR UPDATE` would make every worker queue behind the same row:
 *
 *   1. Read candidates - no locks held.
 *   2. Conditionally UPDATE each, guarded on the lease still being free.
 *   3. Proceed only when affectedRows === 1.
 */
export async function claimDueSchedules(limit: number, owner: string): Promise<ClaimedSchedule[]> {
  const now = new Date();
  const leaseExpiresAt = new Date(now.getTime() + LEASE_SECONDS * 1000);

  const candidates = await prisma.recurringSchedule.findMany({
    where: {
      status: 'ACTIVE',
      nextRunAt: { lte: now, not: null },
      OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    orderBy: { nextRunAt: 'asc' },
    take: limit * 2,
    select: { id: true, nextRunAt: true },
  });

  const claimed: ClaimedSchedule[] = [];

  for (const candidate of candidates) {
    if (claimed.length >= limit) break;
    if (candidate.nextRunAt === null) continue;

    const result = await prisma.recurringSchedule.updateMany({
      where: {
        id: candidate.id,
        status: 'ACTIVE',
        // The guard. Once another worker takes it, this matches nothing.
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
      },
      data: { leaseOwner: owner, leaseExpiresAt },
    });

    if (result.count === 1) {
      claimed.push({ id: candidate.id, plannedRunAt: candidate.nextRunAt });
    }
  }

  return claimed;
}

/** Release a lease so the schedule can be picked up again on its next due date. */
async function releaseLease(scheduleId: string): Promise<void> {
  await prisma.recurringSchedule.updateMany({
    where: { id: scheduleId },
    data: { leaseOwner: null, leaseExpiresAt: null },
  });
}

export type OccurrenceOutcome =
  | { result: 'ORDER_CREATED'; orderId: string; orderNumber: string }
  | { result: 'DUPLICATE' }
  | { result: 'SKIPPED'; reason: string }
  | { result: 'FAILED'; reason: string };

/**
 * Run one occurrence of a schedule.
 *
 * `plannedRunAt` is the slot being served. Combined with the schedule id it is
 * the idempotency key for this entire function.
 */
export async function runOccurrence(
  scheduleId: string,
  plannedRunAt: Date,
  correlationId?: string,
): Promise<OccurrenceOutcome> {
  const runLogger = loggerFor(correlationId ?? newId(), {
    scheduleId,
    plannedRunAt: plannedRunAt.toISOString(),
  });

  // --- Step 1: claim the slot BEFORE any side effect ---------------------
  //
  // Everything below is guarded by this insert succeeding.
  const occurrenceId = newId();

  const inserted = await prisma.scheduleOccurrence.createMany({
    data: [{ id: occurrenceId, scheduleId, plannedRunAt, status: 'PENDING', attemptCount: 1 }],
    skipDuplicates: true,
  });

  if (inserted.count === 0) {
    // This slot was already claimed. That is the whole point.
    runLogger.info('occurrence already exists for this slot; skipping');
    await advanceSchedule(scheduleId, plannedRunAt);
    await releaseLease(scheduleId);
    return { result: 'DUPLICATE' };
  }

  try {
    const outcome = await executeOccurrence(occurrenceId, scheduleId, plannedRunAt, correlationId);
    await releaseLease(scheduleId);
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    runLogger.error({ err: error }, 'recurring occurrence failed');

    await recordFailure(occurrenceId, scheduleId, message, correlationId);
    await releaseLease(scheduleId);

    return { result: 'FAILED', reason: message };
  }
}

async function executeOccurrence(
  occurrenceId: string,
  scheduleId: string,
  plannedRunAt: Date,
  correlationId?: string,
): Promise<OccurrenceOutcome> {
  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      items: true,
      customerProfile: { include: { user: { select: { id: true, email: true, status: true } } } },
      shippingAddress: true,
      billingAddress: true,
    },
  });

  if (schedule === null) {
    return skip(occurrenceId, scheduleId, plannedRunAt, 'schedule no longer exists');
  }

  // --- Step 2: re-validate everything at run time -------------------------
  //
  // SOP 11: current status, price, tax, stock, limits and mandate are all
  // re-checked. Nothing about a week-old schedule may be assumed still true.

  if (schedule.status !== 'ACTIVE') {
    return skip(occurrenceId, scheduleId, plannedRunAt, `schedule is ${schedule.status}`);
  }

  if (
    schedule.customerProfile.user.status !== 'ACTIVE' ||
    schedule.customerProfile.activatedAt === null
  ) {
    return skip(occurrenceId, scheduleId, plannedRunAt, 'customer account is not active');
  }

  if (schedule.endDate !== null && plannedRunAt > schedule.endDate) {
    await completeSchedule(scheduleId, 'end date reached');
    return skip(occurrenceId, scheduleId, plannedRunAt, 'schedule end date reached');
  }

  if (schedule.maxOccurrences !== null && schedule.occurrenceCount >= schedule.maxOccurrences) {
    await completeSchedule(scheduleId, 'occurrence limit reached');
    return skip(occurrenceId, scheduleId, plannedRunAt, 'occurrence limit reached');
  }

  // AUTO_PAY without a mandate cannot charge. Pause rather than fail forever.
  if (schedule.paymentMode === 'AUTO_PAY' && (schedule.mandateReference ?? '').length === 0) {
    await pauseForFailure(scheduleId, 'payment mandate is missing');
    return skip(occurrenceId, scheduleId, plannedRunAt, 'payment mandate is missing');
  }

  if (schedule.shippingAddress.archivedAt !== null || schedule.billingAddress.archivedAt !== null) {
    await pauseForFailure(scheduleId, 'the delivery address was removed');
    return skip(occurrenceId, scheduleId, plannedRunAt, 'delivery address was removed');
  }

  // --- Products: re-check publication and eligibility ---------------------
  const products = await prisma.product.findMany({
    where: {
      ...publicProductWhere(),
      id: { in: schedule.items.map((item) => item.productId) },
    },
    include: {
      taxClass: { select: { code: true, ratePercent: true, isInclusive: true } },
      media: {
        orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }],
        take: 1,
        select: { media: { select: { url: true } } },
      },
    },
  });

  const productById = new Map(products.map((product) => [product.id, product]));

  const unavailable = schedule.items.filter((item) => {
    const product = productById.get(item.productId);
    return product === undefined || !product.isRecurringEligible;
  });

  if (unavailable.length > 0) {
    // The customer is told rather than silently charged for a changed basket.
    await notifyFailure(
      schedule.customerProfile.user.email,
      schedule.customerProfile.fullName,
      schedule.name,
      'One or more products are no longer available for repeat purchase.',
      scheduleId,
      occurrenceId,
    );
    await pauseForFailure(scheduleId, 'a scheduled product is no longer available');
    return skip(occurrenceId, scheduleId, plannedRunAt, 'a scheduled product is unavailable');
  }

  // --- Price at TODAY'S catalog values -----------------------------------
  const pricingInputs: PricingLineInput[] = [];
  const variantById = new Map<string, { priceMinor: bigint | null; sku: string; name: string }>();

  for (const item of schedule.items) {
    if (item.variantId !== null) {
      const variant = await prisma.productVariant.findFirst({
        where: { id: item.variantId, isActive: true, archivedAt: null },
        select: { id: true, priceMinor: true, sku: true, name: true },
      });

      if (variant === null) {
        await pauseForFailure(scheduleId, 'a selected product option is no longer available');
        return skip(occurrenceId, scheduleId, plannedRunAt, 'a product option is unavailable');
      }
      variantById.set(item.variantId, variant);
    }

    const product = productById.get(item.productId);
    if (product === undefined) continue;

    const variant = item.variantId === null ? null : (variantById.get(item.variantId) ?? null);

    pricingInputs.push({
      product: {
        productId: product.id,
        variantId: item.variantId,
        name: product.name,
        sku: variant?.sku ?? product.sku,
        variantName: variant?.name ?? null,
        unitPriceMinor: variant?.priceMinor ?? product.basePriceMinor,
        taxClassCode: product.taxClass.code,
        taxRatePercent: product.taxClass.ratePercent.toString(),
        taxInclusive: product.taxClass.isInclusive,
        isRecurringEligible: product.isRecurringEligible,
        imageUrl: product.media[0]?.media.url ?? null,
      },
      quantity: item.quantity,
    });
  }

  const shipping =
    schedule.shippingMethodCode === null
      ? null
      : await prisma.shippingMethod.findFirst({
          where: { code: schedule.shippingMethodCode, isActive: true },
          select: { code: true, name: true, priceMinor: true, freeAboveMinor: true },
        });

  const pricing = priceLines(
    pricingInputs,
    shipping === null
      ? {}
      : { shipping: { priceMinor: shipping.priceMinor, freeAboveMinor: shipping.freeAboveMinor } },
  );

  assertTotalsConsistent(pricing.lines, pricing.totals);

  const business = await prisma.businessProfile.findFirst({ select: { currency: true } });
  const currency = business?.currency ?? 'INR';

  // --- Reprice guard ------------------------------------------------------
  //
  // SOP 11.1: a price rise above the approved threshold must not be charged
  // silently. Pause and tell the customer instead.
  if (schedule.repriceApprovalThresholdMinor !== null) {
    if (pricing.totals.grandTotalMinor > schedule.repriceApprovalThresholdMinor) {
      await notifyFailure(
        schedule.customerProfile.user.email,
        schedule.customerProfile.fullName,
        schedule.name,
        `The amount for this order (${serialiseMoney(pricing.totals.grandTotalMinor, currency).formatted} ${currency}) is above the limit you approved. The schedule has been paused for your review.`,
        scheduleId,
        occurrenceId,
      );
      await pauseForFailure(scheduleId, 'order total exceeds the approved threshold');
      return skip(occurrenceId, scheduleId, plannedRunAt, 'total exceeds the approved threshold');
    }
  }

  // --- Purchasing limits --------------------------------------------------
  const limits = await checkPurchasingLimits({
    customerProfileId: schedule.customerProfileId,
    lines: schedule.items.map((item) => {
      const product = productById.get(item.productId);
      return {
        productId: item.productId,
        variantId: item.variantId,
        productName: product?.name ?? 'Unknown',
        quantity: item.quantity,
        rules: {
          minOrderQty: product?.minOrderQty ?? 1,
          maxOrderQty: product?.maxOrderQty ?? null,
          qtyIncrement: product?.qtyIncrement ?? 1,
        },
      };
    }),
    grandTotalMinor: pricing.totals.grandTotalMinor,
    currency,
  });

  if (!limits.ok) {
    const reason = limits.violations[0]?.message ?? 'purchasing limits were not met';
    await notifyFailure(
      schedule.customerProfile.user.email,
      schedule.customerProfile.fullName,
      schedule.name,
      reason,
      scheduleId,
      occurrenceId,
    );
    return recordFailure(occurrenceId, scheduleId, reason, correlationId);
  }

  // --- Step 3: create exactly one order -----------------------------------
  const orderId = newId();
  const addressSnapshot = (address: typeof schedule.shippingAddress) => ({
    contactName: address.contactName,
    contactPhone: address.contactPhone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
  });

  const orderNumber = await prisma.$transaction(async (tx) => {
    const year = new Date().getUTCFullYear();
    const key = `order:${String(year)}`;
    const profile = await tx.businessProfile.findFirst({ select: { orderPrefix: true } });
    const prefix = profile?.orderPrefix ?? 'UB';

    await tx.numberSequence.upsert({
      where: { key },
      update: { value: { increment: 1 } },
      create: { key, value: 1, prefix, padding: 6 },
    });

    const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
    const number = `${prefix}-${String(year)}-${sequence.value.toString().padStart(sequence.padding, '0')}`;

    await tx.order.create({
      data: {
        id: orderId,
        orderNumber: number,
        customerProfileId: schedule.customerProfileId,
        source: 'RECURRING',
        // Unique. Even a reprocessed occurrence cannot produce a second order.
        scheduleOccurrenceId: occurrenceId,
        status: 'PENDING_PAYMENT',
        currency,
        subtotalMinor: pricing.totals.subtotalMinor,
        discountMinor: pricing.totals.discountMinor,
        taxMinor: pricing.totals.taxMinor,
        shippingMinor: pricing.totals.shippingMinor,
        grandTotalMinor: pricing.totals.grandTotalMinor,
        billingAddressJson: addressSnapshot(schedule.billingAddress) as never,
        shippingAddressJson: addressSnapshot(schedule.shippingAddress) as never,
        shippingMethodCode: shipping?.code ?? null,
        shippingMethodName: shipping?.name ?? null,
        paymentMode: schedule.paymentMode === 'AUTO_PAY' ? 'ONLINE' : 'PAYMENT_LINK',
        placedAt: new Date(),
      },
    });

    await tx.orderItem.createMany({
      data: pricing.lines.map((line) => ({
        id: newId(),
        orderId,
        productId: line.productId,
        variantId: line.variantId,
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
        isRecurringEligibleSnapshot: line.isRecurringEligibleSnapshot,
      })),
    });

    await tx.orderStatusHistory.create({
      data: {
        id: newId(),
        orderId,
        fromStatus: null,
        toStatus: 'PENDING_PAYMENT',
        actorType: 'SYSTEM',
        reason: `Recurring schedule "${schedule.name}"`,
        correlationId: correlationId ?? null,
      },
    });

    // Reserved inside the same transaction, after the order exists - the FK
    // requires it, and "order created" must mean "stock held".
    const stocked = schedule.items.filter(
      (item) => productById.get(item.productId)?.isStockTracked === true,
    );

    if (stocked.length > 0) {
      await reserveStock(
        {
          items: stocked.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          orderId,
        },
        tx,
      );
    }

    await tx.scheduleOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: 'ORDER_CREATED',
        actualTotalMinor: pricing.totals.grandTotalMinor,
        completedAt: new Date(),
        lastAttemptAt: new Date(),
      },
    });

    await tx.recurringSchedule.update({
      where: { id: scheduleId },
      data: {
        occurrenceCount: { increment: 1 },
        lastRunAt: plannedRunAt,
        failureCount: 0,
      },
    });

    await recordAudit(
      {
        action: AuditAction.ORDER_CREATED,
        resourceType: 'order',
        resourceId: orderId,
        actorType: 'SYSTEM',
        after: {
          via: 'recurring_schedule',
          scheduleId,
          occurrenceId,
          orderNumber: number,
          grandTotalMinor: pricing.totals.grandTotalMinor,
        },
        correlationId: correlationId ?? null,
      },
      tx,
    );

    return number;
  });

  // --- Step 4: payment ----------------------------------------------------
  //
  // Outside the order transaction: it calls an external provider, and holding
  // a transaction open across a network call would be a very bad idea.
  if (schedule.paymentMode === 'PAYMENT_LINK') {
    await createPaymentLink({
      orderId,
      recipientEmail: schedule.payerEmail ?? schedule.customerProfile.user.email,
      recipientName: schedule.customerProfile.fullName,
      // The customer's USER id, not their profile id: audit_logs.actorUserId
      // carries a foreign key to users.
      actorUserId: schedule.customerProfile.user.id,
      actorEmail: schedule.customerProfile.user.email,
      correlationId: correlationId ?? null,
    }).catch(async (error: unknown) => {
      // The order exists and is payable, so a link failure must not undo it -
      // but it must not vanish either. Record it on the occurrence so an
      // operator can see the order that needs a link resent by hand.
      const message = error instanceof Error ? error.message : 'unknown error';
      logger.error({ err: error, orderId, scheduleId }, 'could not send the recurring payment link');

      await prisma.scheduleOccurrence
        .update({
          where: { id: occurrenceId },
          data: { failureMessage: `order created but the payment link failed: ${message}`.slice(0, 500) },
        })
        .catch(() => undefined);
    });
  } else {
    // AUTO_PAY against a stored mandate is intentionally not implemented yet:
    // Razorpay mandates require a registered e-mandate or UPI Autopay flow
    // that this deployment has not set up, and inventing a charge path would
    // be the single most dangerous thing to guess at. The order is created and
    // payable, and the schedule stays active.
    logger.warn(
      { orderId, scheduleId, mandateReference: schedule.mandateReference },
      'auto-pay is configured but the mandate charge path is not implemented; order left pending payment',
    );
  }

  await advanceSchedule(scheduleId, plannedRunAt);
  await dispatchPendingNotifications();

  return { result: 'ORDER_CREATED', orderId, orderNumber };
}

/** Compute and store the next run after a served slot. */
async function advanceSchedule(scheduleId: string, servedSlot: Date): Promise<void> {
  const schedule = await prisma.recurringSchedule.findUnique({ where: { id: scheduleId } });
  if (schedule === null || schedule.status !== 'ACTIVE') return;

  if (schedule.maxOccurrences !== null && schedule.occurrenceCount >= schedule.maxOccurrences) {
    await completeSchedule(scheduleId, 'occurrence limit reached');
    return;
  }

  const next = nextRunAt({
    rule: {
      frequency: schedule.frequency,
      intervalDays: schedule.intervalDays,
      weekday: schedule.weekday,
      monthDay: schedule.monthDay,
      timezone: schedule.timezone,
      runAtMinute: schedule.runAtMinute,
    },
    startDate: schedule.startDate,
    // Strictly after the slot just served, so the same slot cannot recur.
    lastRunAt: servedSlot,
    after: servedSlot,
  });

  if (next !== null && schedule.endDate !== null && next > schedule.endDate) {
    await completeSchedule(scheduleId, 'end date reached');
    return;
  }

  await prisma.recurringSchedule.update({
    where: { id: scheduleId },
    data: { nextRunAt: next },
  });
}

async function completeSchedule(scheduleId: string, reason: string): Promise<void> {
  await prisma.recurringSchedule.updateMany({
    where: { id: scheduleId, status: 'ACTIVE' },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelReason: reason,
      nextRunAt: null,
    },
  });
}

async function skip(
  occurrenceId: string,
  scheduleId: string,
  plannedRunAt: Date,
  reason: string,
): Promise<OccurrenceOutcome> {
  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: { status: 'SKIPPED', skipReason: reason, completedAt: new Date() },
  });

  // The slot is still advanced: a skipped occurrence must not be retried
  // forever, and the next slot is a fresh chance.
  await advanceSchedule(scheduleId, plannedRunAt);

  return { result: 'SKIPPED', reason };
}

/**
 * Record a failure and decide whether to retry or pause.
 *
 * Auto-pause after the configured threshold is the important half: a schedule
 * that fails forever, retrying nightly, is worse than one that stops and asks
 * for attention.
 */
async function recordFailure(
  occurrenceId: string,
  scheduleId: string,
  reason: string,
  correlationId?: string,
): Promise<OccurrenceOutcome> {
  const schedule = await prisma.recurringSchedule.findUnique({ where: { id: scheduleId } });
  if (schedule === null) return { result: 'FAILED', reason };

  const failureCount = schedule.failureCount + 1;
  const exhausted = failureCount >= schedule.maxFailures;

  const occurrence = await prisma.scheduleOccurrence.findUnique({ where: { id: occurrenceId } });
  const attemptCount = occurrence?.attemptCount ?? 1;

  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: {
      status: 'FAILED',
      failureMessage: reason.slice(0, 500),
      failureCode: ErrorCode.INTERNAL_ERROR,
      lastAttemptAt: new Date(),
      nextRetryAt: exhausted
        ? null
        : new Date(Date.now() + retryDelayMinutes(attemptCount) * 60_000),
      completedAt: exhausted ? new Date() : null,
    },
  });

  await prisma.recurringSchedule.update({
    where: { id: scheduleId },
    data: {
      failureCount,
      ...(exhausted
        ? {
            status: 'FAILED',
            nextRunAt: null,
            pausedAt: new Date(),
            pausedReason: `paused after ${String(failureCount)} consecutive failures`,
          }
        : {}),
    },
  });

  if (exhausted) {
    logger.error({ scheduleId, failureCount, reason }, 'recurring schedule paused after repeated failures');

    await recordAudit({
      action: AuditAction.SCHEDULE_PAUSED,
      resourceType: 'recurring_schedule',
      resourceId: scheduleId,
      actorType: 'SYSTEM',
      after: { status: 'FAILED', failureCount, reason },
      correlationId: correlationId ?? null,
    });
  }

  return { result: 'FAILED', reason };
}

async function pauseForFailure(scheduleId: string, reason: string): Promise<void> {
  await prisma.recurringSchedule.updateMany({
    where: { id: scheduleId, status: 'ACTIVE' },
    data: {
      status: 'PAUSED',
      pausedAt: new Date(),
      pausedReason: reason,
      nextRunAt: null,
    },
  });

  await recordAudit({
    action: AuditAction.SCHEDULE_PAUSED,
    resourceType: 'recurring_schedule',
    resourceId: scheduleId,
    actorType: 'SYSTEM',
    after: { reason },
  });
}

async function notifyFailure(
  email: string,
  name: string,
  scheduleName: string,
  reason: string,
  scheduleId: string,
  occurrenceId: string,
): Promise<void> {
  await enqueueNotification({
    eventKey: NotificationEvent.SCHEDULE_FAILED,
    recipientEmail: email,
    recipientName: name,
    variables: { scheduleName, reason },
    dedupeKey: `schedule_failed:${occurrenceId}`,
    relatedType: 'recurring_schedule',
    relatedId: scheduleId,
  });

  await dispatchPendingNotifications();
}

/**
 * Send reminders for upcoming runs.
 *
 * SOP 11: a customer is told before money moves, not after.
 */
export async function sendUpcomingReminders(hoursAhead = 24): Promise<number> {
  const windowEnd = new Date(Date.now() + hoursAhead * 3_600_000);

  const due = await prisma.recurringSchedule.findMany({
    where: { status: 'ACTIVE', nextRunAt: { lte: windowEnd, gt: new Date() } },
    include: {
      customerProfile: { include: { user: { select: { email: true } } } },
      items: true,
    },
    take: 200,
  });

  let sent = 0;

  for (const schedule of due) {
    if (schedule.nextRunAt === null) continue;

    const queued = await enqueueNotification({
      eventKey: NotificationEvent.SCHEDULE_REMINDER,
      recipientEmail: schedule.payerEmail ?? schedule.customerProfile.user.email,
      recipientName: schedule.customerProfile.fullName,
      variables: {
        scheduleName: schedule.name,
        dueDate: schedule.nextRunAt.toISOString(),
        estimatedTotal: 'calculated at the time of the order',
        scheduleUrl: `/account/schedules/${schedule.id}`,
      },
      // One reminder per slot, whatever the sweep frequency.
      dedupeKey: `schedule_reminder:${schedule.id}:${schedule.nextRunAt.toISOString()}`,
      relatedType: 'recurring_schedule',
      relatedId: schedule.id,
    });

    if (queued !== null) sent += 1;
  }

  await dispatchPendingNotifications();
  return sent;
}
