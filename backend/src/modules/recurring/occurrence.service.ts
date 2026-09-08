/**
 * The scheduled-order runner.
 *
 * This is the most dangerous code in the system: it charges people without
 * anyone watching. A duplicate here is a duplicate charge on a real card, and
 * a mistake is discovered by the customer rather than by us.
 *
 * ## Duplicate protection is structural
 *
 * None of it depends on this file being careful:
 *
 *   1. `unique(scheduleId, plannedRunAt)` on `schedule_occurrences`. The
 *      occurrence row exists BEFORE any side effect, so a second worker, a
 *      retry, a clock skew or a replayed job all collide on the index.
 *   2. `unique(schedule_occurrences.idempotencyKey)`, derived from those same
 *      two fields. Every downstream key - the Stripe charge, the ERP push, the
 *      inventory movement - is derived from it, so a retry recomputes the same
 *      keys instead of minting new ones.
 *   3. `unique(orders.scheduleOccurrenceId)`. Even if an occurrence were
 *      somehow processed twice, it could not produce two orders.
 *   4. `unique(payment_transactions.idempotencyKey)`, so a charge cannot be
 *      started twice for one occurrence.
 *   5. `unique(erp_order_pushes.orderId)`, so one order reaches the ERP once.
 *   6. A lease on the schedule row, so two workers do not even try at once.
 *
 * Claiming uses a conditional UPDATE rather than `FOR UPDATE SKIP LOCKED`,
 * which MariaDB 10.4 does not have. See `database-queue.ts` for the same
 * pattern.
 *
 * ## The order of operations, and why it is that order
 *
 *   validate -> price -> check tolerance -> create order -> charge -> push ERP
 *
 * Validation and pricing come before the order because an occurrence that
 * cannot run should leave nothing behind. The order comes before the charge
 * because the charge needs something to reference and the stock needs holding
 * at the moment we commit to supplying it. The ERP push comes after the charge
 * because an ERP order for something unpaid is worse than a late one - but
 * ERP *stock* is checked before the charge, in `quoteSchedule`, because
 * charging for something the warehouse will refuse to ship is the worst
 * available outcome.
 *
 * ## What never happens
 *
 *   - A failed payment never leaves a confirmed order.
 *   - A failed payment never cancels the subscription. One dead card is not
 *     consent to stop delivering.
 *   - An authentication request is never treated as a failure. The money has
 *     not moved and only the customer can advance it.
 *   - A paid occurrence whose ERP push fails is never marked FAILED. It holds
 *     at PAID_ERP_PENDING, because telling a customer their order failed when
 *     their money is gone and the order is real is the one message that turns a
 *     technical problem into a lost account.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { isRepeating, nextRunAt, retryDelayMinutes } from '../../domain/recurrence.js';
import {
  assertOccurrenceTransition,
  derivedIdempotencyKey,
  hasCapturedPayment,
  occurrenceIdempotencyKey,
  type OccurrenceStatusName,
} from '../../domain/schedule-state.js';
import { newId } from '../../infra/ids.js';
import { logger, loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { pushOrderToErp, reconcileErpInventory } from '../integrations/erp-order.service.js';
import { reserveStock } from '../inventory/inventory.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { createPaymentLink } from '../payments/payment-link.service.js';
import { chargeOrderOffSession } from '../payments/payment.service.js';
import { completeSchedulePlan, failSchedulePlan, pauseScheduleForFailure } from './schedule.service.js';
import {
  evaluatePriceTolerance,
  exceedsApprovalThreshold,
  quoteSchedule,
  type ScheduleQuote,
} from './schedule-quote.service.js';

/** How long a claimed schedule stays leased to one worker. */
const LEASE_SECONDS = 120;

/**
 * How long an ACTION_REQUIRED occurrence waits for the customer, in hours.
 *
 * After this it is skipped and the plan carries on. Left open indefinitely it
 * would eventually charge for a delivery the customer had forgotten asking
 * for, at a price quoted weeks earlier.
 */
const ACTION_REQUIRED_WINDOW_HOURS = 72;

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

// ---------------------------------------------------------------------------
// Materialising occurrences ahead of time
// ---------------------------------------------------------------------------

/**
 * Create the SCHEDULED rows for a plan's upcoming runs.
 *
 * The reason this exists at all: a customer cannot skip, re-date or cancel a
 * delivery that has no row. Creating occurrences only at run time - as the
 * previous engine did - means "skip my next delivery" has nothing to write
 * against, and would have to be modelled as a flag on the plan that the engine
 * then remembers to honour. A row per cycle is simpler and it is the same row
 * the engine later claims, so there is no second source of truth about when a
 * delivery is due.
 *
 * Safe to call repeatedly: every insert is guarded by
 * `unique(scheduleId, plannedRunAt)`.
 */
export async function materialiseOccurrences(
  scheduleId: string,
  aheadDays = env.SCHEDULE_MATERIALISE_AHEAD_DAYS,
): Promise<{ created: number }> {
  const schedule = await prisma.recurringSchedule.findUnique({ where: { id: scheduleId } });

  // Only a live plan gets rows. A draft has authorised nothing, and a paused
  // one should show no future dates to a customer looking at it.
  if (schedule === null || schedule.status !== 'ACTIVE') return { created: 0 };

  const horizon = new Date(Date.now() + aheadDays * 86_400_000);
  const slots: Date[] = [];

  if (schedule.frequency === 'ONE_TIME') {
    // Exactly one, and it is the instant the customer named.
    const only = schedule.runOnceAt ?? schedule.nextRunAt;
    if (only !== null) slots.push(only);
  } else {
    let candidate = schedule.nextRunAt;

    // Bounded: a daily plan over a 35-day horizon is 35 rows, and the guard
    // stops a misconfigured rule from running away.
    for (let guard = 0; guard < 400 && candidate !== null && candidate <= horizon; guard += 1) {
      if (
        schedule.maxOccurrences !== null &&
        schedule.occurrenceCount + slots.length >= schedule.maxOccurrences
      ) {
        break;
      }

      if (schedule.endDate !== null && candidate > schedule.endDate) break;

      slots.push(candidate);

      // The slot just pushed is what the next one is computed from, so it is
      // read back from `slots` rather than tracked in a second variable that
      // has to be kept in step with it.
      const served = candidate;

      candidate = nextRunAt({
        rule: {
          frequency: schedule.frequency,
          intervalDays: schedule.intervalDays,
          weekday: schedule.weekday,
          monthDay: schedule.monthDay,
          timezone: schedule.timezone,
          runAtMinute: schedule.runAtMinute,
        },
        startDate: schedule.startDate,
        lastRunAt: served,
        after: served,
      });
    }
  }

  if (slots.length === 0) return { created: 0 };

  const result = await prisma.scheduleOccurrence.createMany({
    data: slots.map((plannedRunAt) => ({
      id: newId(),
      scheduleId,
      plannedRunAt,
      // Copied off the plan now, so changing the plan's zone later does not
      // rewrite history. See the column's comment.
      timezone: schedule.timezone,
      status: 'SCHEDULED' as const,
      idempotencyKey: occurrenceIdempotencyKey(scheduleId, plannedRunAt),
    })),
    skipDuplicates: true,
  });

  return { created: result.count };
}

/**
 * Re-materialise after a plan's rule changed.
 *
 * Future SCHEDULED rows are deleted and rebuilt, because their dates came from
 * a rule that no longer applies. Deliberately narrow about what it removes:
 * only SCHEDULED, only in the future. Anything the engine has touched, and
 * anything the customer has skipped, stays exactly as it is - a skip is a
 * decision they made and rebuilding over it would silently reinstate a
 * delivery they cancelled.
 */
export async function rematerialiseOccurrences(scheduleId: string): Promise<{
  removed: number;
  created: number;
}> {
  const removed = await prisma.scheduleOccurrence.deleteMany({
    where: {
      scheduleId,
      plannedRunAt: { gt: new Date() },
      // A row that already has an order is not a plan for the future, whatever
      // its status says.
      order: null,
      OR: [
        { status: 'SCHEDULED' },
        // Rows a PAUSE cancelled, which have to go for the plan to be
        // resumable at all.
        //
        // Pausing withdraws every upcoming delivery so the customer's screen
        // shows no future dates. Those rows keep their slots, and a resume
        // recomputes the same weekly dates - so re-materialising collided with
        // them on unique(scheduleId, plannedRunAt) and created nothing at all,
        // leaving a resumed plan with no upcoming deliveries to skip or show.
        //
        // `skippedByUser: false` is what keeps this from undoing the
        // customer's own decisions: a cycle THEY cancelled stays cancelled and
        // is never quietly reinstated by a later pause and resume.
        { status: 'CANCELLED', skippedByUser: false },
      ],
    },
  });

  const { created } = await materialiseOccurrences(scheduleId);
  return { removed: removed.count, created };
}

// ---------------------------------------------------------------------------
// Running one occurrence
// ---------------------------------------------------------------------------

export type OccurrenceOutcome =
  | { result: 'COMPLETED'; orderId: string; orderNumber: string; erpOrderReference: string | null }
  | { result: 'ORDER_CREATED'; orderId: string; orderNumber: string }
  | { result: 'PAID_ERP_PENDING'; orderId: string; orderNumber: string }
  | { result: 'ACTION_REQUIRED'; orderId: string; reason: string }
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

  const idempotencyKey = occurrenceIdempotencyKey(scheduleId, plannedRunAt);

  // --- Step 1: claim the slot BEFORE any side effect ---------------------
  const claim = await claimOccurrenceSlot(scheduleId, plannedRunAt, idempotencyKey, runLogger);

  if (claim.outcome !== null) {
    await releaseLease(scheduleId);
    return claim.outcome;
  }

  const occurrenceId = claim.occurrenceId;

  try {
    const outcome = await executeOccurrence(
      occurrenceId,
      scheduleId,
      plannedRunAt,
      idempotencyKey,
      correlationId,
    );
    await releaseLease(scheduleId);
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    runLogger.error({ err: error }, 'scheduled occurrence failed');

    // The one case an exception must not be allowed to mislabel. If the money
    // has already moved, this is not a failed occurrence however this function
    // exited - it is a paid one with unfinished work, and calling it FAILED
    // would tell the customer their order did not happen.
    const current = await prisma.scheduleOccurrence.findUnique({
      where: { id: occurrenceId },
      select: { status: true, order: { select: { id: true, orderNumber: true } } },
    });

    if (current !== null && hasCapturedPayment(current.status)) {
      runLogger.error(
        { occurrenceId, status: current.status },
        'an occurrence threw after payment was captured; holding it rather than failing it',
      );

      await prisma.scheduleOccurrence.update({
        where: { id: occurrenceId },
        data: { failureMessage: `after payment: ${message}`.slice(0, 500) },
      });

      await releaseLease(scheduleId);

      return current.order === null
        ? { result: 'FAILED', reason: message }
        : {
            result: 'PAID_ERP_PENDING',
            orderId: current.order.id,
            orderNumber: current.order.orderNumber,
          };
    }

    await recordFailure(occurrenceId, scheduleId, message, correlationId);
    await releaseLease(scheduleId);

    return { result: 'FAILED', reason: message };
  }
}

/**
 * Take ownership of this slot.
 *
 * Two shapes of the same problem. The row may not exist yet (the plan was
 * created before materialising ran, or the horizon moved), in which case it is
 * inserted; or it may exist as a pre-created SCHEDULED row, in which case it is
 * claimed with a conditional UPDATE.
 *
 * The conditional UPDATE is what makes the pre-created row as safe as the
 * insert was: `status: 'SCHEDULED'` in the WHERE clause means the second
 * worker's update matches nothing, exactly as its insert would have collided.
 */
async function claimOccurrenceSlot(
  scheduleId: string,
  plannedRunAt: Date,
  idempotencyKey: string,
  runLogger: ReturnType<typeof loggerFor>,
): Promise<{ occurrenceId: string; outcome: null } | { occurrenceId: string; outcome: OccurrenceOutcome }> {
  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    select: { timezone: true },
  });

  const newOccurrenceId = newId();

  const inserted = await prisma.scheduleOccurrence.createMany({
    data: [
      {
        id: newOccurrenceId,
        scheduleId,
        plannedRunAt,
        timezone: schedule?.timezone ?? 'UTC',
        status: 'AWAITING_VALIDATION',
        attemptCount: 1,
        lastAttemptAt: new Date(),
        idempotencyKey,
      },
    ],
    skipDuplicates: true,
  });

  if (inserted.count === 1) {
    return { occurrenceId: newOccurrenceId, outcome: null };
  }

  // A row was already there. What it is decides everything.
  const existing = await prisma.scheduleOccurrence.findUnique({
    where: { scheduleId_plannedRunAt: { scheduleId, plannedRunAt } },
    select: {
      id: true,
      status: true,
      skipReason: true,
      skippedByUser: true,
      attemptCount: true,
      order: { select: { id: true, orderNumber: true } },
    },
  });

  if (existing === null) {
    // Inserted by another worker between the two statements and then removed.
    // Vanishingly unlikely and not worth guessing at.
    runLogger.warn('the occurrence row disappeared between insert and read');
    return {
      occurrenceId: newOccurrenceId,
      outcome: { result: 'DUPLICATE' },
    };
  }

  // Pre-created and untouched: claim it.
  if (existing.status === 'SCHEDULED') {
    const claimed = await prisma.scheduleOccurrence.updateMany({
      // The guard, and the whole reason this is an updateMany.
      where: { id: existing.id, status: 'SCHEDULED' },
      data: {
        status: 'AWAITING_VALIDATION',
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    if (claimed.count === 1) return { occurrenceId: existing.id, outcome: null };

    // Somebody else claimed it first.
    runLogger.info('another worker claimed this occurrence first');
    return { occurrenceId: existing.id, outcome: { result: 'DUPLICATE' } };
  }

  // The customer skipped or cancelled this cycle. Honour it and move the plan
  // on - this is the path that makes "skip my next delivery" work.
  if (existing.status === 'SKIPPED' || existing.status === 'CANCELLED') {
    runLogger.info({ status: existing.status }, 'this cycle was skipped or cancelled; advancing');
    await advanceSchedule(scheduleId, plannedRunAt);

    return {
      occurrenceId: existing.id,
      outcome: {
        result: 'SKIPPED',
        reason: existing.skipReason ?? (existing.skippedByUser ? 'skipped by the customer' : 'cancelled'),
      },
    };
  }

  // A previous attempt failed and this is the retry. Re-entering validation is
  // safe: no money moved on a FAILED occurrence.
  if (existing.status === 'FAILED') {
    const reclaimed = await prisma.scheduleOccurrence.updateMany({
      where: { id: existing.id, status: 'FAILED' },
      data: {
        status: 'AWAITING_VALIDATION',
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
      },
    });

    if (reclaimed.count === 1) return { occurrenceId: existing.id, outcome: null };
    return { occurrenceId: existing.id, outcome: { result: 'DUPLICATE' } };
  }

  // Anything else - PAYMENT_PENDING, PROCESSING, PAID_ERP_PENDING, COMPLETED,
  // ACTION_REQUIRED, or a legacy status - is a slot already in flight or
  // finished. This is the duplicate guard doing its job.
  runLogger.info({ status: existing.status }, 'occurrence already in progress for this slot');
  await advanceSchedule(scheduleId, plannedRunAt);

  return { occurrenceId: existing.id, outcome: { result: 'DUPLICATE' } };
}

async function executeOccurrence(
  occurrenceId: string,
  scheduleId: string,
  plannedRunAt: Date,
  idempotencyKey: string,
  correlationId?: string,
): Promise<OccurrenceOutcome> {
  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    include: {
      items: true,
      customerProfile: {
        include: { user: { select: { id: true, email: true, status: true } } },
      },
      shippingAddress: true,
      billingAddress: true,
      paymentMethod: true,
    },
  });

  if (schedule === null) {
    return hold(occurrenceId, scheduleId, plannedRunAt, 'the schedule no longer exists');
  }

  const customerEmail = schedule.customerProfile.user.email;
  const customerName = schedule.customerProfile.fullName;
  const occurrence = await prisma.scheduleOccurrence.findUniqueOrThrow({
    where: { id: occurrenceId },
    select: { quotedTotalMinor: true, paymentAttemptCount: true },
  });

  // --- Step 2: re-validate the plan itself -------------------------------
  //
  // Nothing about a fortnight-old plan may be assumed still true.

  if (schedule.status !== 'ACTIVE') {
    return hold(occurrenceId, scheduleId, plannedRunAt, `the schedule is ${schedule.status}`);
  }

  if (
    schedule.customerProfile.user.status !== 'ACTIVE' ||
    schedule.customerProfile.activatedAt === null
  ) {
    return hold(occurrenceId, scheduleId, plannedRunAt, 'the customer account is not active');
  }

  if (schedule.endDate !== null && plannedRunAt > schedule.endDate) {
    await completeSchedulePlan(scheduleId, 'end date reached');
    return hold(occurrenceId, scheduleId, plannedRunAt, 'the schedule end date has passed');
  }

  if (schedule.maxOccurrences !== null && schedule.occurrenceCount >= schedule.maxOccurrences) {
    await completeSchedulePlan(scheduleId, 'occurrence limit reached');
    return hold(occurrenceId, scheduleId, plannedRunAt, 'the schedule occurrence limit is reached');
  }

  // --- Payment configuration --------------------------------------------
  if (schedule.paymentMode === 'AUTO_PAY') {
    const hasStoredMethod = schedule.paymentMethod !== null;
    const hasLegacyMandate = (schedule.mandateReference ?? '').length > 0;

    if (!hasStoredMethod && !hasLegacyMandate) {
      await pauseScheduleForFailure(scheduleId, 'the payment method is missing');
      await notifyPaused(
        customerEmail,
        customerName,
        schedule.name,
        'The saved payment method for this schedule is missing, so it has been paused.',
        scheduleId,
        occurrenceId,
      );
      return hold(occurrenceId, scheduleId, plannedRunAt, 'the payment method is missing');
    }

    if (schedule.paymentMethod !== null && schedule.paymentMethod.status !== 'ACTIVE') {
      // Paused rather than failed: the customer can fix this by adding a card,
      // and cancelling their subscription over an expired card would be a
      // wildly disproportionate response.
      await pauseScheduleForFailure(scheduleId, 'the saved card is no longer usable');
      await notifyPaused(
        customerEmail,
        customerName,
        schedule.name,
        'The card saved for this schedule can no longer be used, so the schedule has been paused. ' +
          'Add a new card to resume it.',
        scheduleId,
        occurrenceId,
      );
      return hold(occurrenceId, scheduleId, plannedRunAt, 'the saved card is not usable');
    }
  }

  if (schedule.shippingAddress.archivedAt !== null || schedule.billingAddress.archivedAt !== null) {
    await pauseScheduleForFailure(scheduleId, 'the delivery address was removed');
    await notifyPaused(
      customerEmail,
      customerName,
      schedule.name,
      'The delivery address for this schedule was removed, so it has been paused.',
      scheduleId,
      occurrenceId,
    );
    return hold(occurrenceId, scheduleId, plannedRunAt, 'the delivery address was removed');
  }

  // --- Step 3: reprice and revalidate the basket -------------------------
  //
  // The same function the customer's review screen used. See
  // `schedule-quote.service.ts`.
  const quote = await quoteSchedule({
    customerProfileId: schedule.customerProfileId,
    items: schedule.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId,
      quantity: item.quantity,
      substituteProductId: item.substituteProductId,
      substituteVariantId: item.substituteVariantId,
    })),
    shippingAddressId: schedule.shippingAddressId,
    shippingMethodCode: schedule.shippingMethodCode,
    substitutionPolicy: schedule.substitutionPolicy,
    inventoryLocationId: schedule.inventoryLocationId,
    // The ERP's own view, before any money moves.
    checkErpStock: true,
  });

  if (!quote.ok) {
    const blocking = quote.problems.filter((problem) => problem.severity !== 'WARN');
    const reason = blocking.map((problem) => problem.message).join(' ');

    // BLOCK means the plan itself cannot run as configured - a product has been
    // withdrawn from sale, or the address is gone. Permanent, so the plan
    // pauses and somebody is asked to look. HOLD means only this delivery
    // cannot go; the subscription keeps running.
    //
    // See `QuoteSeverity`. Getting this the wrong way round either loses a
    // customer over one short week, or emails them about a discontinued product
    // every week for ever.
    const isPermanent = blocking.some((problem) => problem.severity === 'BLOCK');

    // A supply problem gets its own message, because it is the one the customer
    // can act on - by authorising a substitute, or changing the items.
    const isSupplyProblem = blocking.some(
      (problem) =>
        problem.code === ErrorCode.INSUFFICIENT_STOCK ||
        problem.code === ErrorCode.SUBSTITUTION_NOT_PERMITTED,
    );

    await enqueueNotification({
      eventKey:
        isSupplyProblem && !isPermanent
          ? NotificationEvent.SCHEDULE_STOCK_UNAVAILABLE
          : NotificationEvent.SCHEDULE_FAILED,
      recipientEmail: customerEmail,
      recipientName: customerName,
      variables: {
        scheduleName: schedule.name,
        dueDate: formatInZone(plannedRunAt, schedule.timezone),
        reason: reason.slice(0, 900),
        scheduleUrl: scheduleUrl(scheduleId),
      },
      // Keyed on the occurrence, so a retried run does not email twice.
      dedupeKey: `occurrence_hold:${occurrenceId}`,
      relatedType: 'recurring_schedule',
      relatedId: scheduleId,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    await dispatchPendingNotifications();

    if (isPermanent) {
      await pauseScheduleForFailure(scheduleId, reason.slice(0, 400) || 'a product is no longer available');
    }

    // Either way the plan's failure streak advances, so a transient problem
    // that turns out not to be transient - a product that stays out of stock
    // for months - eventually stops rather than emailing the customer for ever.
    return hold(
      occurrenceId,
      scheduleId,
      plannedRunAt,
      reason || 'the order could not be validated',
      { countsAsFailure: !isPermanent },
    );
  }

  const totalMinor = quote.pricing.totals.grandTotalMinor;

  // --- Step 4: the price guards ------------------------------------------
  //
  // Two independent tests, and either one tripping holds the occurrence.

  if (exceedsApprovalThreshold(totalMinor, schedule.repriceApprovalThresholdMinor)) {
    await notifyPriceChanged({
      email: customerEmail,
      name: customerName,
      scheduleId,
      occurrenceId,
      scheduleName: schedule.name,
      quotedMinor: schedule.repriceApprovalThresholdMinor,
      actualMinor: totalMinor,
      currency: quote.currency,
      allowedChange: `limit of ${serialiseMoney(schedule.repriceApprovalThresholdMinor ?? 0n, quote.currency).formatted}`,
      correlationId,
    });

    await pauseScheduleForFailure(scheduleId, 'the total exceeds the approved threshold');
    return hold(occurrenceId, scheduleId, plannedRunAt, 'the total exceeds the approved threshold');
  }

  const tolerance = evaluatePriceTolerance({
    quotedMinor: occurrence.quotedTotalMinor,
    actualMinor: totalMinor,
    tolerancePercent: schedule.priceTolerancePercent?.toString() ?? null,
    toleranceMinor: schedule.priceToleranceMinor,
  });

  if (!tolerance.withinTolerance) {
    await notifyPriceChanged({
      email: customerEmail,
      name: customerName,
      scheduleId,
      occurrenceId,
      scheduleName: schedule.name,
      quotedMinor: occurrence.quotedTotalMinor,
      actualMinor: totalMinor,
      currency: quote.currency,
      allowedChange: `${tolerance.allowedPercent}%`,
      correlationId,
    });

    // Held, not paused: the plan is fine and the next cycle may well be back
    // inside tolerance. The customer is asked about THIS delivery.
    return holdWithSnapshot(
      occurrenceId,
      scheduleId,
      plannedRunAt,
      `the amount changed by ${tolerance.deltaPercent}%, beyond the approved ${tolerance.allowedPercent}%`,
      quote,
      ErrorCode.SCHEDULE_PRICE_CHANGED,
    );
  }

  // --- Payment attempt budget -------------------------------------------
  if (
    schedule.paymentMode === 'AUTO_PAY' &&
    occurrence.paymentAttemptCount >= env.SCHEDULE_MAX_PAYMENT_ATTEMPTS
  ) {
    // Counted apart from validation attempts on purpose - see the column's
    // comment. Repeated declines are a signal to the issuer about the card.
    await pauseScheduleForFailure(scheduleId, 'the payment failed too many times');
    await notifyPaused(
      customerEmail,
      customerName,
      schedule.name,
      'We could not take payment for this schedule after several attempts, so it has been paused. ' +
        'Check your card details to resume it.',
      scheduleId,
      occurrenceId,
    );
    return hold(occurrenceId, scheduleId, plannedRunAt, 'the payment attempt limit is reached');
  }

  // --- Step 5: exactly one order ----------------------------------------
  await transitionOccurrence(occurrenceId, 'AWAITING_VALIDATION', 'PAYMENT_PENDING', {
    quotedTotalMinor: occurrence.quotedTotalMinor ?? totalMinor,
    actualTotalMinor: totalMinor,
    cartSnapshotJson: snapshotOf(quote),
  });

  const { orderId, orderNumber } = await createOrderForOccurrence({
    occurrenceId,
    schedule,
    quote,
    plannedRunAt,
    correlationId,
  });

  // --- Step 6: payment ---------------------------------------------------
  //
  // Outside the order transaction: it calls an external provider, and holding
  // a transaction open across a network call would be a very bad idea.

  if (schedule.paymentMode === 'PAYMENT_LINK') {
    await createPaymentLink({
      orderId,
      recipientEmail: schedule.payerEmail ?? customerEmail,
      recipientName: customerName,
      actorUserId: schedule.customerProfile.user.id,
      actorEmail: customerEmail,
      correlationId: correlationId ?? null,
    }).catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : 'unknown error';
      logger.error({ err: error, orderId, scheduleId }, 'could not send the recurring payment link');

      await prisma.scheduleOccurrence
        .update({
          where: { id: occurrenceId },
          data: {
            failureMessage: `order created but the payment link failed: ${message}`.slice(0, 500),
          },
        })
        .catch(() => undefined);
    });

    // The order is payable and the link is out. The occurrence stays at
    // PAYMENT_PENDING until the webhook confirms the payment, which is what
    // `settleOccurrenceAfterPayment` reacts to.
    await advanceSchedule(scheduleId, plannedRunAt);
    await dispatchPendingNotifications();

    return { result: 'ORDER_CREATED', orderId, orderNumber };
  }

  // --- AUTO_PAY: charge the stored instrument ---------------------------
  if (schedule.paymentMethod === null) {
    // A legacy Razorpay mandate reference with no stored instrument. There is
    // no charge path for it in this build - the e-mandate flow was never
    // implemented - so the order is left payable rather than pretending.
    logger.warn(
      { orderId, scheduleId, mandateReference: schedule.mandateReference },
      'auto-pay is configured with a legacy mandate and no stored payment method; ' +
        'the order is left pending payment',
    );

    await advanceSchedule(scheduleId, plannedRunAt);
    return { result: 'ORDER_CREATED', orderId, orderNumber };
  }

  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: { paymentAttemptCount: { increment: 1 } },
  });

  const charge = await chargeOrderOffSession({
    orderId,
    paymentMethodId: schedule.paymentMethod.id,
    // Derived from the occurrence key, so a retry charges into the same
    // payment rather than a second one.
    idempotencyKey: derivedIdempotencyKey(idempotencyKey, 'payment'),
    scheduleId,
    occurrenceId,
    correlationId: correlationId ?? null,
  });

  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: { paymentReference: charge.providerOrderId },
  });

  if (charge.outcome === 'ACTION_REQUIRED') {
    await transitionOccurrence(occurrenceId, 'PAYMENT_PENDING', 'ACTION_REQUIRED', {
      actionRequiredAt: new Date(),
      failureCode: charge.failureCode,
      failureMessage: charge.failureMessage?.slice(0, 500) ?? null,
    });

    const expiresAt = new Date(Date.now() + ACTION_REQUIRED_WINDOW_HOURS * 3_600_000);

    await enqueueNotification({
      eventKey: NotificationEvent.SCHEDULE_PAYMENT_ACTION_REQUIRED,
      recipientEmail: customerEmail,
      recipientName: customerName,
      variables: {
        scheduleName: schedule.name,
        estimatedTotal: serialiseMoney(totalMinor, quote.currency).formatted,
        paymentUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/orders/${orderId}/pay`,
        expiresAt: formatInZone(expiresAt, schedule.timezone),
      },
      dedupeKey: `occurrence_action_required:${occurrenceId}`,
      relatedType: 'order',
      relatedId: orderId,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    await dispatchPendingNotifications();

    // The plan advances. This delivery waits for the customer, and the next
    // one is not held hostage to it.
    await advanceSchedule(scheduleId, plannedRunAt);

    return {
      result: 'ACTION_REQUIRED',
      orderId,
      reason: charge.failureMessage ?? 'the bank asked for the cardholder',
    };
  }

  if (charge.outcome === 'FAILED') {
    // The order is cancelled, which releases the stock. Unlike an interactive
    // checkout there is nobody present to retry against it, and leaving it
    // PENDING_PAYMENT would hold stock for an order nothing will ever complete.
    await cancelOrderAfterFailedCharge(orderId, charge.failureMessage ?? 'payment failed');

    await enqueueNotification({
      eventKey: NotificationEvent.PAYMENT_FAILED,
      recipientEmail: customerEmail,
      recipientName: customerName,
      variables: {
        orderNumber,
        reason: charge.failureMessage ?? 'The payment could not be completed.',
      },
      dedupeKey: `occurrence_payment_failed:${occurrenceId}:${String(occurrence.paymentAttemptCount + 1)}`,
      relatedType: 'order',
      relatedId: orderId,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    await dispatchPendingNotifications();

    // Emphatically NOT a cancellation of the subscription. One failed charge
    // is not consent to stop delivering.
    return recordFailure(
      occurrenceId,
      scheduleId,
      charge.failureMessage ?? 'the payment failed',
      correlationId,
      charge.failureCode,
    );
  }

  // Captured. Everything from here on is post-payment, and the rules change:
  // nothing below may mark this occurrence FAILED.
  return settleOccurrenceAfterPayment(occurrenceId, correlationId);
}

// ---------------------------------------------------------------------------
// Post-payment settlement: order, ERP, inventory, confirmation
// ---------------------------------------------------------------------------

/**
 * Everything that happens once an occurrence's money has moved.
 *
 * Called from the charge path for auto-pay, and from the webhook path when a
 * payment-link occurrence is finally paid. Idempotent, because both can happen
 * for one occurrence and a redelivered webhook can happen twice.
 *
 * The ERP push is the only step that can fail here, and it cannot fail this
 * occurrence. It either succeeds - COMPLETED - or defers - PAID_ERP_PENDING,
 * which the retry sweep picks up.
 */
export async function settleOccurrenceAfterPayment(
  occurrenceId: string,
  correlationId?: string,
): Promise<OccurrenceOutcome> {
  const occurrence = await prisma.scheduleOccurrence.findUnique({
    where: { id: occurrenceId },
    include: {
      order: { select: { id: true, orderNumber: true, status: true } },
      schedule: {
        select: {
          id: true,
          name: true,
          timezone: true,
          customerProfile: {
            select: { fullName: true, user: { select: { email: true } } },
          },
        },
      },
    },
  });

  if (occurrence === null || occurrence.order === null) {
    return { result: 'FAILED', reason: 'the occurrence has no order to settle' };
  }

  const { order, schedule } = occurrence;

  // Already settled. The early return that makes a redelivered webhook
  // harmless.
  if (occurrence.status === 'COMPLETED') {
    return {
      result: 'COMPLETED',
      orderId: order.id,
      orderNumber: order.orderNumber,
      erpOrderReference: occurrence.erpOrderReference,
    };
  }

  if (occurrence.status === 'PAYMENT_PENDING' || occurrence.status === 'ACTION_REQUIRED') {
    await transitionOccurrence(occurrenceId, occurrence.status, 'PROCESSING', {
      failureCode: null,
      failureMessage: null,
    });
  } else if (occurrence.status !== 'PROCESSING' && occurrence.status !== 'PAID_ERP_PENDING') {
    loggerFor(correlationId ?? occurrenceId, { occurrenceId, orderId: order.id }).warn(
      { status: occurrence.status },
      'settlement asked for on an occurrence in an unexpected status',
    );
  }

  // --- The ERP hand-off --------------------------------------------------
  const erpKey = derivedIdempotencyKey(occurrence.idempotencyKey, 'erp');

  const push = await pushOrderToErp({
    orderId: order.id,
    occurrenceId,
    idempotencyKey: erpKey,
    correlationId: correlationId ?? null,
  });

  if (push.status === 'DEFERRED' || push.status === 'ABANDONED') {
    // Paid, ordered, and the warehouse system has not taken it. The one state
    // this whole module is shaped around.
    await prisma.scheduleOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: 'PAID_ERP_PENDING',
        erpPushStatus: push.status === 'ABANDONED' ? 'ABANDONED' : 'FAILED',
        failureCode: ErrorCode.ERP_ORDER_PUSH_FAILED,
        failureMessage: push.message?.slice(0, 500) ?? null,
      },
    });

    await recordAudit({
      action: AuditAction.ERP_ORDER_PUSH_DEFERRED,
      resourceType: 'schedule_occurrence',
      resourceId: occurrenceId,
      actorType: 'SYSTEM',
      after: { orderId: order.id, erpStatus: push.status },
      correlationId: correlationId ?? null,
    });

    // The customer is told the order is confirmed and dispatch may be late.
    // Never that anything failed - their order is real and paid.
    await enqueueNotification({
      eventKey: NotificationEvent.SCHEDULE_ERP_DELAYED,
      recipientEmail: schedule.customerProfile.user.email,
      recipientName: schedule.customerProfile.fullName,
      variables: {
        orderNumber: order.orderNumber,
        orderUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/orders/${order.id}`,
      },
      dedupeKey: `erp_delayed:${occurrenceId}`,
      relatedType: 'order',
      relatedId: order.id,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    await dispatchPendingNotifications();

    return { result: 'PAID_ERP_PENDING', orderId: order.id, orderNumber: order.orderNumber };
  }

  // SUCCEEDED, or SKIPPED because no ERP is configured. Both are done.
  return finishOccurrence(
    occurrenceId,
    order.id,
    order.orderNumber,
    push.erpOrderReference,
    occurrence.idempotencyKey,
    correlationId,
  );
}

/**
 * Called by the ERP retry sweep once a held push finally lands.
 *
 * The exit from PAID_ERP_PENDING.
 */
export async function completeOccurrenceAfterErp(
  occurrenceId: string,
  erpOrderReference: string | null,
): Promise<void> {
  const occurrence = await prisma.scheduleOccurrence.findUnique({
    where: { id: occurrenceId },
    include: { order: { select: { id: true, orderNumber: true } } },
  });

  if (occurrence === null || occurrence.order === null) return;
  if (occurrence.status !== 'PAID_ERP_PENDING') return;

  await finishOccurrence(
    occurrenceId,
    occurrence.order.id,
    occurrence.order.orderNumber,
    erpOrderReference,
    occurrence.idempotencyKey,
  );
}

/**
 * Settle a payment-link occurrence once its payment is confirmed.
 *
 * The webhook path's way in. Looked up by order rather than by occurrence
 * because that is what the payment layer has in hand, and it returns quietly
 * when the order is not a scheduled one - most orders are not.
 */
export async function settleOccurrenceForOrder(
  orderId: string,
  correlationId?: string,
): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { scheduleOccurrenceId: true },
  });

  if (order === null || order.scheduleOccurrenceId === null) return;

  await settleOccurrenceAfterPayment(order.scheduleOccurrenceId, correlationId);
}

/** Mark an occurrence done, reconcile inventory, and set up the next one. */
async function finishOccurrence(
  occurrenceId: string,
  orderId: string,
  orderNumber: string,
  erpOrderReference: string | null,
  idempotencyKey: string,
  correlationId?: string,
): Promise<OccurrenceOutcome> {
  const occurrence = await prisma.scheduleOccurrence.findUniqueOrThrow({
    where: { id: occurrenceId },
    select: {
      status: true,
      scheduleId: true,
      plannedRunAt: true,
      actualTotalMinor: true,
      schedule: {
        select: {
          name: true,
          timezone: true,
          frequency: true,
          customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
        },
      },
    },
  });

  if (occurrence.status === 'COMPLETED') {
    return { result: 'COMPLETED', orderId, orderNumber, erpOrderReference };
  }

  // Keyed, so a retried settlement cannot post the movement twice. The ledger
  // is append-only and has no reversal.
  await reconcileErpInventory({
    orderId,
    idempotencyKey: derivedIdempotencyKey(idempotencyKey, 'stock'),
  }).catch((error: unknown) => {
    // A reconciliation row is a record, not the stock itself: the commit
    // already moved it. Losing this must not fail a finished order.
    logger.error({ err: error, orderId }, 'could not record the ERP inventory reconciliation');
  });

  await prisma.$transaction(async (tx) => {
    await tx.scheduleOccurrence.update({
      where: { id: occurrenceId },
      data: {
        status: 'COMPLETED',
        erpOrderReference,
        erpPushStatus: erpOrderReference === null ? null : 'SUCCEEDED',
        completedAt: new Date(),
        failureCode: null,
        failureMessage: null,
      },
    });

    // Nothing to do to the plan here: `occurrenceCount`, `lastRunAt`
    // and the failure streak were all settled when the order was created. See
    // the note there for why that is the right moment rather than this one.

    await recordAudit(
      {
        action: AuditAction.OCCURRENCE_COMPLETED,
        resourceType: 'schedule_occurrence',
        resourceId: occurrenceId,
        actorType: 'SYSTEM',
        after: { orderId, orderNumber, erpOrderReference },
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  await advanceSchedule(occurrence.scheduleId, occurrence.plannedRunAt);

  // A one-shot plan has now done the only thing it was for.
  if (!isRepeating(occurrence.schedule.frequency)) {
    await completeSchedulePlan(occurrence.scheduleId, 'the single scheduled delivery was made');
  }

  await dispatchPendingNotifications();

  return { result: 'COMPLETED', orderId, orderNumber, erpOrderReference };
}

// ---------------------------------------------------------------------------
// Order creation
// ---------------------------------------------------------------------------

/**
 * A plan with everything order creation needs, already loaded.
 *
 * Spelled with `GetPayload` rather than inferred from a `findUnique` call:
 * inferring it makes the type depend on the exact generic the call site used,
 * and the two drift apart the first time somebody adds a relation to one and
 * not the other.
 */
type ScheduleWithRelations = Prisma.RecurringScheduleGetPayload<{
  include: {
    items: true;
    customerProfile: { include: { user: { select: { id: true; email: true; status: true } } } };
    shippingAddress: true;
    billingAddress: true;
    paymentMethod: true;
  };
}>;

async function createOrderForOccurrence(input: {
  occurrenceId: string;
  schedule: ScheduleWithRelations;
  quote: ScheduleQuote;
  plannedRunAt: Date;
  correlationId?: string;
}): Promise<{ orderId: string; orderNumber: string }> {
  const { occurrenceId, schedule, quote, correlationId } = input;

  // A retry that already created the order must not create another. The unique
  // index on `orders.scheduleOccurrenceId` would refuse it anyway; this turns
  // that refusal into a correct answer rather than an exception.
  const existing = await prisma.order.findUnique({
    where: { scheduleOccurrenceId: occurrenceId },
    select: { id: true, orderNumber: true },
  });

  if (existing !== null) {
    return { orderId: existing.id, orderNumber: existing.orderNumber };
  }

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
        currency: quote.currency,
        subtotalMinor: quote.pricing.totals.subtotalMinor,
        discountMinor: quote.pricing.totals.discountMinor,
        taxMinor: quote.pricing.totals.taxMinor,
        shippingMinor: quote.pricing.totals.shippingMinor,
        grandTotalMinor: quote.pricing.totals.grandTotalMinor,
        billingAddressJson: addressSnapshot(schedule.billingAddress) as never,
        shippingAddressJson: addressSnapshot(schedule.shippingAddress) as never,
        shippingMethodCode: quote.shippingMethod?.code ?? null,
        shippingMethodName: quote.shippingMethod?.name ?? null,
        paymentMode: schedule.paymentMode === 'AUTO_PAY' ? 'ONLINE' : 'PAYMENT_LINK',
        placedAt: new Date(),
      },
    });

    await tx.orderItem.createMany({
      data: quote.pricing.lines.map((line) => ({
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
        reason: `Scheduled order "${schedule.name}"`,
        correlationId: correlationId ?? null,
      },
    });

    // Reserved inside the same transaction, after the order exists - the FK
    // requires it, and "order created" must mean "stock held".
    const stocked = quote.sourceItems.filter((item) => item.isStockTracked);

    if (stocked.length > 0) {
      await reserveStock(
        {
          items: stocked.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          orderId,
          ...(schedule.fulfilmentRule === 'FIXED_LOCATION' && schedule.inventoryLocationId !== null
            ? { locationId: schedule.inventoryLocationId }
            : {}),
        },
        tx,
      );
    }

    // The plan's counters move here, not at completion.
    //
    // "This cycle produced an order" is the event `occurrenceCount` and
    // `maxOccurrences` are actually about, and it is the only point both
    // payment modes pass through: an auto-pay occurrence completes moments
    // later, but a payment-link one waits days for the customer and completes
    // on a webhook. Counting at completion left every payment-link plan with a
    // count of zero, so `maxOccurrences` never bit and `lastRunAt` never moved.
    await tx.recurringSchedule.update({
      where: { id: schedule.id },
      data: {
        occurrenceCount: { increment: 1 },
        lastRunAt: input.plannedRunAt,
        // The failure streak clears here too, for the same reason the count
        // advances here: producing an order is the success signal both payment
        // modes share. A payment-link plan does not reach
        // `finishOccurrence` until its customer pays, days later, so
        // clearing it there left an old shortage's streak standing - and three
        // unrelated shortages over three months would eventually suspend a plan
        // that had been delivering perfectly well in between.
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
          via: schedule.kind === 'ONE_TIME' ? 'scheduled_order' : 'subscription',
          scheduleId: schedule.id,
          occurrenceId,
          orderNumber: number,
          grandTotalMinor: quote.pricing.totals.grandTotalMinor.toString(),
        },
        correlationId: correlationId ?? null,
      },
      tx,
    );

    return number;
  });

  return { orderId, orderNumber };
}

/**
 * Cancel an order whose off-session charge failed.
 *
 * Releases the stock. Uses the order state machine like everything else -
 * nothing in this file writes `orders.status`.
 */
async function cancelOrderAfterFailedCharge(orderId: string, reason: string): Promise<void> {
  const { transitionOrder } = await import('../orders/order.service.js');

  await transitionOrder({
    orderId,
    to: 'CANCELLED',
    actor: { userId: null, email: null, type: 'SYSTEM' },
    reason: `Scheduled payment failed: ${reason}`.slice(0, 500),
  }).catch((error: unknown) => {
    logger.error(
      { err: error, orderId },
      'could not cancel the order behind a failed scheduled payment',
    );
  });
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

/**
 * Move an occurrence, through the state machine.
 *
 * Every status write in this file goes through here, for the reason given in
 * `schedule-state.ts`: what is legal lives in one place, and a transition this
 * code has not thought about fails loudly instead of quietly corrupting a
 * paid occurrence.
 */
async function transitionOccurrence(
  occurrenceId: string,
  from: string,
  to: OccurrenceStatusName,
  data: Record<string, unknown> = {},
): Promise<void> {
  assertOccurrenceTransition({
    from: from as OccurrenceStatusName,
    to,
    actor: 'SYSTEM',
  });

  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: { status: to, ...data } as never,
  });
}

/**
 * Hold this cycle.
 *
 * `countsAsFailure` decides whether the plan's failure streak advances. It
 * usually should: a hold that keeps happening is indistinguishable from a
 * failure to the customer, and a plan that holds silently for ever is worse
 * than one that stops and asks for attention. The exception is a hold that has
 * ALREADY paused the plan, where advancing the streak as well would be
 * double-counting a single event.
 */
async function hold(
  occurrenceId: string,
  scheduleId: string,
  plannedRunAt: Date,
  reason: string,
  options: { countsAsFailure?: boolean } = {},
): Promise<OccurrenceOutcome> {
  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: {
      status: 'SKIPPED',
      // False: the engine decided this, not the customer. They are owed a
      // different sentence for each.
      skippedByUser: false,
      skipReason: reason.slice(0, 500),
      completedAt: new Date(),
    },
  });

  await recordAudit({
    action: AuditAction.OCCURRENCE_HELD,
    resourceType: 'schedule_occurrence',
    resourceId: occurrenceId,
    actorType: 'SYSTEM',
    after: { reason: reason.slice(0, 300), countsAsFailure: options.countsAsFailure === true },
  });

  if (options.countsAsFailure === true) {
    const schedule = await prisma.recurringSchedule.findUnique({
      where: { id: scheduleId },
      select: { failureCount: true, maxFailures: true, status: true },
    });

    if (schedule !== null && schedule.status === 'ACTIVE') {
      const failureCount = schedule.failureCount + 1;

      await prisma.recurringSchedule.update({
        where: { id: scheduleId },
        data: { failureCount },
      });

      if (failureCount >= schedule.maxFailures) {
        await failSchedulePlan(scheduleId, `${String(failureCount)} consecutive holds`);
        return { result: 'SKIPPED', reason };
      }
    }
  }

  await advanceSchedule(scheduleId, plannedRunAt);
  return { result: 'SKIPPED', reason };
}

/** Hold, keeping the priced snapshot so the customer can be shown the amount. */
async function holdWithSnapshot(
  occurrenceId: string,
  scheduleId: string,
  plannedRunAt: Date,
  reason: string,
  quote: ScheduleQuote,
  failureCode: string,
): Promise<OccurrenceOutcome> {
  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: {
      status: 'SKIPPED',
      skippedByUser: false,
      skipReason: reason.slice(0, 500),
      failureCode,
      actualTotalMinor: quote.pricing.totals.grandTotalMinor,
      cartSnapshotJson: snapshotOf(quote) as never,
      completedAt: new Date(),
    },
  });

  await advanceSchedule(scheduleId, plannedRunAt);
  return { result: 'SKIPPED', reason };
}

/**
 * Record a failed attempt and decide whether to retry.
 *
 * Only ever reached before payment. See `runOccurrence`'s catch block for the
 * guard that keeps a paid occurrence out of here.
 */
async function recordFailure(
  occurrenceId: string,
  scheduleId: string,
  message: string,
  correlationId?: string,
  failureCode?: string | null,
): Promise<OccurrenceOutcome> {
  const occurrence = await prisma.scheduleOccurrence.findUnique({
    where: { id: occurrenceId },
    select: { attemptCount: true, plannedRunAt: true, status: true },
  });

  const attempts = occurrence?.attemptCount ?? 1;

  const schedule = await prisma.recurringSchedule.findUnique({
    where: { id: scheduleId },
    select: { failureCount: true, maxFailures: true, name: true },
  });

  const nextRetryAt =
    attempts >= (schedule?.maxFailures ?? 3)
      ? null
      : new Date(Date.now() + retryDelayMinutes(attempts) * 60_000);

  await prisma.scheduleOccurrence.update({
    where: { id: occurrenceId },
    data: {
      status: 'FAILED',
      failureCode: failureCode ?? null,
      failureMessage: message.slice(0, 500),
      lastAttemptAt: new Date(),
      nextRetryAt,
    },
  });

  const failureCount = (schedule?.failureCount ?? 0) + 1;

  await prisma.recurringSchedule.update({
    where: { id: scheduleId },
    data: { failureCount },
  });

  // Audited, and carrying the correlation id: a charge that failed at 06:00 is
  // reconstructed later from the log line, the audit row and the provider's
  // own record, and the correlation id is what ties the three together.
  await recordAudit({
    action: AuditAction.SCHEDULE_UPDATED,
    resourceType: 'schedule_occurrence',
    resourceId: occurrenceId,
    actorType: 'SYSTEM',
    after: {
      status: 'FAILED',
      attempt: attempts,
      scheduleFailureCount: failureCount,
      failureCode: failureCode ?? null,
      message: message.slice(0, 300),
      nextRetryAt: nextRetryAt?.toISOString() ?? null,
    },
    correlationId: correlationId ?? null,
  });

  if (failureCount >= (schedule?.maxFailures ?? 3)) {
    // Enough. A human has to look - and note this is FAILED, not CANCELLED:
    // the customer's standing instruction is not withdrawn, it is suspended.
    await failSchedulePlan(scheduleId, `${String(failureCount)} consecutive failures`);
  }

  if (occurrence !== null) {
    await advanceSchedule(scheduleId, occurrence.plannedRunAt);
  }

  logger.warn({ occurrenceId, scheduleId, attempts, failureCount }, 'occurrence failed');

  return { result: 'FAILED', reason: message };
}

/**
 * Compute and store the next run after a served slot.
 *
 * Also materialises the rows for it, so the customer's next delivery is
 * something they can see and skip rather than something the engine will invent
 * later.
 */
async function advanceSchedule(scheduleId: string, servedSlot: Date): Promise<void> {
  const schedule = await prisma.recurringSchedule.findUnique({ where: { id: scheduleId } });
  if (schedule === null || schedule.status !== 'ACTIVE') return;

  // A one-shot plan has no next run by definition.
  if (!isRepeating(schedule.frequency)) {
    await prisma.recurringSchedule.update({
      where: { id: scheduleId },
      data: { nextRunAt: null, lastRunAt: servedSlot },
    });
    return;
  }

  if (schedule.maxOccurrences !== null && schedule.occurrenceCount >= schedule.maxOccurrences) {
    await completeSchedulePlan(scheduleId, 'occurrence limit reached');
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
    await completeSchedulePlan(scheduleId, 'end date reached');
    return;
  }

  if (next === null) {
    await completeSchedulePlan(scheduleId, 'no further occurrences');
    return;
  }

  await prisma.recurringSchedule.update({
    where: { id: scheduleId },
    data: { nextRunAt: next, lastRunAt: servedSlot },
  });

  await materialiseOccurrences(scheduleId).catch((error: unknown) => {
    // Not fatal: the engine can still run a slot with no pre-created row. It
    // only means the customer temporarily cannot skip the next one.
    logger.warn({ err: error, scheduleId }, 'could not materialise upcoming occurrences');
  });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

function scheduleUrl(scheduleId: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL}/account/scheduled-orders/${scheduleId}`;
}

/** A date and time a person reads, in the zone the plan is scheduled in. */
function formatInZone(instant: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      dateStyle: 'full',
      timeStyle: 'short',
    }).format(instant);
  } catch {
    // A plan whose stored zone is no longer a valid IANA name must not stop a
    // notification going out.
    return instant.toISOString();
  }
}

async function notifyPaused(
  email: string,
  name: string,
  scheduleName: string,
  message: string,
  scheduleId: string,
  occurrenceId: string,
): Promise<void> {
  await enqueueNotification({
    eventKey: NotificationEvent.SCHEDULE_PAUSED,
    recipientEmail: email,
    recipientName: name,
    variables: { scheduleName, reason: message, scheduleUrl: scheduleUrl(scheduleId) },
    dedupeKey: `schedule_paused:${occurrenceId}`,
    relatedType: 'recurring_schedule',
    relatedId: scheduleId,
  });

  await dispatchPendingNotifications();
}

async function notifyPriceChanged(input: {
  email: string;
  name: string;
  scheduleId: string;
  occurrenceId: string;
  scheduleName: string;
  quotedMinor: bigint | null;
  actualMinor: bigint;
  currency: string;
  allowedChange: string;
  correlationId?: string;
}): Promise<void> {
  await enqueueNotification({
    eventKey: NotificationEvent.SCHEDULE_PRICE_CHANGED,
    recipientEmail: input.email,
    recipientName: input.name,
    variables: {
      scheduleName: input.scheduleName,
      quotedTotal:
        input.quotedMinor === null
          ? 'not previously quoted'
          : serialiseMoney(input.quotedMinor, input.currency).formatted,
      estimatedTotal: serialiseMoney(input.actualMinor, input.currency).formatted,
      allowedChange: input.allowedChange,
      scheduleUrl: scheduleUrl(input.scheduleId),
    },
    dedupeKey: `price_changed:${input.occurrenceId}`,
    relatedType: 'recurring_schedule',
    relatedId: input.scheduleId,
    ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
  });

  await dispatchPendingNotifications();
}

/**
 * Snapshot a quote for the occurrence record.
 *
 * Money as strings, as everywhere else it crosses a boundary. JSON numbers are
 * doubles, and a total that has been through one is no longer evidence of
 * anything.
 */
function snapshotOf(quote: ScheduleQuote): Record<string, unknown> {
  return {
    currency: quote.currency,
    capturedAt: new Date().toISOString(),
    lines: quote.lines.map((line) => ({
      productId: line.productId,
      variantId: line.variantId,
      name: line.name,
      sku: line.sku,
      quantity: line.quantity,
      unitPriceMinor: line.unitPrice.minor,
      taxAmountMinor: line.taxAmount.minor,
      discountMinor: line.discount.minor,
      lineTotalMinor: line.lineTotal.minor,
      taxRatePercent: line.taxRatePercent,
      substitutedFor: line.substitutedFor,
    })),
    totals: {
      subtotalMinor: quote.totals.subtotal.minor,
      discountMinor: quote.totals.discount.minor,
      taxMinor: quote.totals.tax.minor,
      shippingMinor: quote.totals.shipping.minor,
      grandTotalMinor: quote.totals.grandTotal.minor,
    },
    shippingMethod: quote.shippingMethod,
  };
}

// ---------------------------------------------------------------------------
// Reminders and sweeps
// ---------------------------------------------------------------------------

/**
 * Email customers about charges that are about to happen.
 *
 * Sent against materialised occurrence rows rather than computed from the
 * plan, so the reminder names the exact delivery the customer can then go and
 * skip - and `reminderSentAt` on that row is what stops it being sent twice.
 *
 * Also records `quotedTotalMinor`, which is what the tolerance check at run
 * time measures drift against. A reminder is a quote, and this is the system
 * remembering what it told them.
 */
export async function sendUpcomingReminders(
  leadHours = env.SCHEDULE_REMINDER_LEAD_HOURS,
): Promise<number> {
  const horizon = new Date(Date.now() + leadHours * 3_600_000);

  // Build any missing rows first.
  //
  // The sweep reads materialised occurrences, so a plan whose rows were never
  // built - materialisation failed, the plan predates it, or its next run was
  // moved forward by hand - would silently get no reminder and then be charged
  // without warning. Cheap: one indexed query per plan actually due, and
  // `materialiseOccurrences` is a no-op when the rows already exist.
  const dueSoon = await prisma.recurringSchedule.findMany({
    where: {
      status: 'ACTIVE',
      nextRunAt: { gt: new Date(), lte: horizon },
      occurrences: { none: { plannedRunAt: { gt: new Date(), lte: horizon } } },
    },
    select: { id: true },
    take: 200,
  });

  for (const schedule of dueSoon) {
    await materialiseOccurrences(schedule.id).catch(() => undefined);
  }

  const due = await prisma.scheduleOccurrence.findMany({
    where: {
      status: 'SCHEDULED',
      reminderSentAt: null,
      plannedRunAt: { gt: new Date(), lte: horizon },
      schedule: { status: 'ACTIVE' },
    },
    orderBy: { plannedRunAt: 'asc' },
    take: 200,
    include: {
      schedule: {
        include: {
          items: true,
          customerProfile: { select: { id: true, fullName: true, user: { select: { email: true } } } },
        },
      },
    },
  });

  let sent = 0;

  for (const occurrence of due) {
    const schedule = occurrence.schedule;

    // Priced now, so the customer is told a real number rather than last
    // month's. The same function the engine will use at run time.
    const quote = await quoteSchedule({
      customerProfileId: schedule.customerProfileId,
      items: schedule.items.map((item) => ({
        productId: item.productId,
        variantId: item.variantId,
        quantity: item.quantity,
        substituteProductId: item.substituteProductId,
        substituteVariantId: item.substituteVariantId,
      })),
      shippingAddressId: schedule.shippingAddressId,
      shippingMethodCode: schedule.shippingMethodCode,
      substitutionPolicy: schedule.substitutionPolicy,
      inventoryLocationId: schedule.inventoryLocationId,
      // Not asked of the ERP: a reminder is not a commitment, and a round trip
      // per reminder would make this sweep dependent on a third party being up.
      checkErpStock: false,
    }).catch(() => null);

    const totalMinor = quote?.pricing.totals.grandTotalMinor ?? null;

    const editableUntil = new Date(
      occurrence.plannedRunAt.getTime() - schedule.editCutoffMinutes * 60_000,
    );

    const enqueued = await enqueueNotification({
      eventKey: NotificationEvent.SCHEDULE_REMINDER,
      recipientEmail: schedule.customerProfile.user.email,
      recipientName: schedule.customerProfile.fullName,
      variables: {
        scheduleName: schedule.name,
        dueDate: formatInZone(occurrence.plannedRunAt, occurrence.timezone),
        estimatedTotal:
          totalMinor === null || quote === null
            ? 'to be confirmed'
            : serialiseMoney(totalMinor, quote.currency).formatted,
        editableUntil: formatInZone(editableUntil, occurrence.timezone),
        scheduleUrl: scheduleUrl(schedule.id),
      },
      dedupeKey: `schedule_reminder:${occurrence.id}`,
      relatedType: 'schedule_occurrence',
      relatedId: occurrence.id,
    });

    await prisma.scheduleOccurrence.update({
      where: { id: occurrence.id },
      data: {
        reminderSentAt: new Date(),
        // The quote the tolerance check will be measured against.
        ...(totalMinor === null ? {} : { quotedTotalMinor: totalMinor }),
      },
    });

    if (enqueued !== null) sent += 1;
  }

  if (sent > 0) await dispatchPendingNotifications();
  return sent;
}

/**
 * Close out occurrences whose authentication window has passed.
 *
 * An ACTION_REQUIRED occurrence left open for ever would eventually charge for
 * a delivery the customer had stopped expecting, at a price quoted weeks
 * earlier. After the window it is skipped and the plan carries on - the
 * subscription is not cancelled over one un-authenticated payment.
 */
export async function expireActionRequiredOccurrences(): Promise<number> {
  const cutoff = new Date(Date.now() - ACTION_REQUIRED_WINDOW_HOURS * 3_600_000);

  const stale = await prisma.scheduleOccurrence.findMany({
    where: { status: 'ACTION_REQUIRED', actionRequiredAt: { lt: cutoff } },
    take: 100,
    select: { id: true, order: { select: { id: true, status: true } } },
  });

  for (const occurrence of stale) {
    await prisma.scheduleOccurrence.update({
      where: { id: occurrence.id },
      data: {
        status: 'SKIPPED',
        skippedByUser: false,
        skipReason: 'the payment was not confirmed in time',
        completedAt: new Date(),
      },
    });

    // Release the stock the unpaid order was holding.
    if (occurrence.order !== null && occurrence.order.status === 'PENDING_PAYMENT') {
      await cancelOrderAfterFailedCharge(
        occurrence.order.id,
        'the payment was not confirmed in time',
      );
    }
  }

  return stale.length;
}

/**
 * Retry occurrences whose earlier attempt failed before payment.
 *
 * Only FAILED rows with a `nextRetryAt` in the past, and only ones whose money
 * never moved - `hasCapturedPayment` is checked again here rather than trusted
 * from the status alone.
 */
export async function retryFailedOccurrences(limit = 20): Promise<number> {
  const due = await prisma.scheduleOccurrence.findMany({
    where: {
      status: 'FAILED',
      nextRetryAt: { lte: new Date(), not: null },
      schedule: { status: 'ACTIVE' },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: { id: true, scheduleId: true, plannedRunAt: true, status: true },
  });

  let retried = 0;

  for (const occurrence of due) {
    if (hasCapturedPayment(occurrence.status)) continue;

    await runOccurrence(occurrence.scheduleId, occurrence.plannedRunAt);
    retried += 1;
  }

  return retried;
}
