/**
 * Recurring engine - integration, against a real MariaDB.
 *
 * The question this file exists to answer: can a schedule ever charge twice?
 *
 * It is attacked from four directions - the same slot run twice, ten workers
 * racing, a worker crashing mid-run, and a lease expiring under a slow run.
 * Every one must produce exactly one order.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { addCalendarDays } from '../../src/domain/delivery-dates.js';
import { earliestFirstDelivery } from '../support/schedule-dates.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { receiveStock, getAvailability } from '../../src/modules/inventory/inventory.service.js';
import {
  cancelSchedule,
  createSchedule,
  pauseSchedule,
  resumeSchedule,
  updateSchedule,
} from '../../src/modules/recurring/schedule.service.js';
import {
  claimDueSchedules,
  runOccurrence,
  sendUpcomingReminders,
} from '../../src/modules/recurring/occurrence.service.js';

let adminActor: { userId: string; email: string; type: 'ADMIN' };
let customerActor: { userId: string; email: string; type: 'CUSTOMER' };
let customerProfileId: string;
let productId: string;
let nonRecurringProductId: string;
let addressId: string;

/**
 * Run a block with the per-product eligibility tick back in charge.
 *
 * `FEATURE_SCHEDULE_ANY_PRODUCT` defaults to on, which means every published
 * product may be scheduled and `Product.isRecurringEligible` is not consulted.
 * The two tests below are about the OTHER mode - the deployment that curates
 * which of its products may be repeated - so they say so rather than relying
 * on a default that no longer holds.
 *
 * Restored in a `finally`: leaking a flag out of one test would silently
 * change what every later test in the file is exercising.
 */
async function withCuratedEligibility(body: () => Promise<void>): Promise<void> {
  const previous = env.FEATURE_SCHEDULE_ANY_PRODUCT;
  Object.assign(env as unknown as { FEATURE_SCHEDULE_ANY_PRODUCT: boolean }, {
    FEATURE_SCHEDULE_ANY_PRODUCT: false,
  });

  try {
    await body();
  } finally {
    Object.assign(env as unknown as { FEATURE_SCHEDULE_ANY_PRODUCT: boolean }, {
      FEATURE_SCHEDULE_ANY_PRODUCT: previous,
    });
  }
}

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.paymentLink.deleteMany({});
  await prisma.paymentTransaction.deleteMany({});
  await prisma.paymentProviderConnection.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.scheduleOccurrence.deleteMany({});
  await prisma.recurringScheduleItem.deleteMany({});
  await prisma.recurringSchedule.deleteMany({});
  await prisma.numberSequence.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.shippingMethod.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

beforeEach(async () => {
  await resetAll();

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'UBOSS Test',
      displayName: 'UBOSS',
      supportEmail: 'support@test.local',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      orderPrefix: 'UB',
    },
  });

  const adminId = newId();
  await prisma.user.create({
    data: {
      id: adminId,
      type: 'ADMIN',
      email: 'admin@rec.test',
      emailNormalized: 'admin@rec.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@rec.test', type: 'ADMIN' };

  const customerUserId = newId();
  await prisma.user.create({
    data: {
      id: customerUserId,
      type: 'CUSTOMER',
      email: 'buyer@rec.test',
      emailNormalized: 'buyer@rec.test',
      status: 'ACTIVE',
    },
  });
  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: customerUserId,
      fullName: 'Recurring Buyer',
      activatedAt: new Date(),
    },
  });
  customerProfileId = profile.id;
  customerActor = { userId: customerUserId, email: 'buyer@rec.test', type: 'CUSTOMER' };

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Recurring Buyer',
      contactPhone: '+91 90000 00000',
      line1: 'Gate 3',
      city: 'Pune',
      state: 'MH',
      postalCode: '411019',
      country: 'IN',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });
  addressId = address.id;

  await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'GST18',
      name: 'GST 18%',
      ratePercent: '18.000000',
      isDefault: true,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Fasteners', slug: 'fasteners', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Hex Bolt M12',
      slug: 'hex-bolt-m12',
      sku: 'HEX-M12',
      shortDescription: 'Grade 8.8',
      basePriceMinor: 4550n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
      minOrderQty: 10,
      isRecurringEligible: true,
    },
  });
  productId = product.id;

  const other = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'One-off Tool',
      slug: 'one-off-tool',
      sku: 'TOOL-1',
      basePriceMinor: 250_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      // Not opted in by an admin.
      isRecurringEligible: false,
    },
  });
  nonRecurringProductId = other.id;

  await receiveStock({ productId, quantity: 1000 }, adminActor);
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

async function makeSchedule(overrides: Record<string, unknown> = {}) {
  return createSchedule(
    {
      customerProfileId,
      name: 'Weekly bolts',
      frequency: 'EVERY_N_DAYS',
      intervalDays: 7,
      /*
       * The first date the notice period allows, rather than an anchor in the
       * past.
       *
       * These fixtures used to start yesterday and let the cadence roll
       * forward, which no anchor can do any more: a weekly plan's next slot is
       * never more than seven days out, so a past anchor always lands inside
       * the notice window. Every test below that needs a schedule the worker
       * will pick up calls `makeDue` afterwards, which is what actually put
       * them in the due query before and still does.
       */
      startDate: await earliestFirstDelivery(),
      paymentMode: 'PAYMENT_LINK',
      payerEmail: 'finance@acme.test',
      shippingAddressId: addressId,
      items: [{ productId, quantity: 20 }],
      consentAccepted: true,
      ...overrides,
    },
    customerActor,
  );
}

/** Force a schedule due now, as the worker would find it. */
async function makeDue(scheduleId: string): Promise<Date> {
  const slot = new Date(Date.now() - 60_000);
  await prisma.recurringSchedule.update({
    where: { id: scheduleId },
    data: { nextRunAt: slot },
  });
  return slot;
}

describe('creating a schedule', () => {
  it('activates with a computed next run', async () => {
    const created = await makeSchedule();

    expect(created.summary).toContain('Every 7 days');
    expect(created.nextRunAt).not.toBeNull();
    expect(created.nextRunAt?.getTime()).toBeGreaterThan(Date.now());

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: created.scheduleId },
    });
    expect(row.status).toBe('ACTIVE');
    expect(row.consentAcceptedAt).not.toBeNull();
    expect(row.consentVersion).toBe('v1');
  });

  /**
   * The month-interval cadences, against the real CHECK constraint.
   *
   * `chk_schedule_frequency_field_present` names every frequency and the
   * column it depends on, and a CHECK that matches no branch FAILS. So a new
   * frequency whose branch was not added to the constraint cannot be inserted
   * at all — and no unit test can catch that, because the constraint only
   * exists in the database. This is the test that would have failed had the
   * migration been forgotten.
   */
  it.each([2, 3, 6, 12])('stores an every-%i-months plan', async (intervalMonths) => {
    const created = await makeSchedule({
      frequency: 'EVERY_N_MONTHS',
      intervalMonths,
      intervalDays: null,
    });

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: created.scheduleId },
    });

    expect(row.frequency).toBe('EVERY_N_MONTHS');
    expect(row.intervalMonths).toBe(intervalMonths);
    expect(row.status).toBe('ACTIVE');

    // A repeating plan is queued. The interval is months, so the next run is
    // further out than any day-counted cadence would put it.
    expect(row.nextRunAt).not.toBeNull();
    expect(row.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  /** One month is MONTHLY. Accepting it here would be a second spelling. */
  it('refuses a month interval of one', async () => {
    await expect(
      makeSchedule({ frequency: 'EVERY_N_MONTHS', intervalMonths: 1, intervalDays: null }),
    ).rejects.toMatchObject({ code: 'RECURRENCE_RULE_INVALID' });
  });

  /** A standing authority to charge requires explicit agreement. */
  it('refuses without consent', async () => {
    await expect(makeSchedule({ consentAccepted: false })).rejects.toMatchObject({
      code: 'SCHEDULE_CONSENT_REQUIRED',
    });
  });

  /**
   * A curated range still refuses what is not in it.
   *
   * Only meaningful with FEATURE_SCHEDULE_ANY_PRODUCT off — with it on, which
   * is the default, everything the store sells may be repeated and there is
   * nothing for this to refuse.
   */
  it('refuses a product outside a curated recurring range', async () => {
    await withCuratedEligibility(async () => {
      await expect(
        makeSchedule({ items: [{ productId: nonRecurringProductId, quantity: 1 }] }),
      ).rejects.toMatchObject({ code: 'SCHEDULE_PRODUCT_NOT_ELIGIBLE' });
    });
  });

  /** And with the flag on, the same basket is accepted. */
  it('accepts any published product when the store repeats everything', async () => {
    const created = await makeSchedule({
      items: [{ productId: nonRecurringProductId, quantity: 1 }],
    });

    expect(created.scheduleId).toBeTruthy();
  });

  it('refuses auto-pay without a mandate', async () => {
    await expect(
      makeSchedule({ paymentMode: 'AUTO_PAY', mandateReference: null, payerEmail: null }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_MANDATE_MISSING' });
  });

  it('accepts auto-pay with a mandate', async () => {
    const created = await makeSchedule({
      paymentMode: 'AUTO_PAY',
      mandateReference: 'token_abc123',
      payerEmail: null,
    });
    expect(created.paymentMode).toBe('AUTO_PAY');
  });

  it('refuses a payment-link schedule with no payer', async () => {
    await expect(makeSchedule({ payerEmail: null })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('enforces quantity rules at creation', async () => {
    await expect(makeSchedule({ items: [{ productId, quantity: 3 }] })).rejects.toMatchObject({
      code: 'SCHEDULE_PRODUCT_NOT_ELIGIBLE',
    });
  });

  it('refuses another customer address', async () => {
    const otherUserId = newId();
    await prisma.user.create({
      data: {
        id: otherUserId,
        type: 'CUSTOMER',
        email: 'other@rec.test',
        emailNormalized: 'other@rec.test',
        status: 'ACTIVE',
      },
    });
    const otherProfile = await prisma.customerProfile.create({
      data: { id: newId(), userId: otherUserId, fullName: 'Other' },
    });
    const foreign = await prisma.address.create({
      data: {
        id: newId(),
        customerProfileId: otherProfile.id,
        contactName: 'Other',
        contactPhone: '+91 90000 00001',
        line1: 'Elsewhere',
        city: 'Mumbai',
        state: 'MH',
        postalCode: '400001',
        country: 'IN',
      },
    });

    await expect(makeSchedule({ shippingAddressId: foreign.id })).rejects.toMatchObject({
      code: 'ADDRESS_REQUIRED',
    });
  });

  it('rejects an invalid recurrence rule', async () => {
    await expect(makeSchedule({ intervalDays: 0 })).rejects.toMatchObject({
      code: 'RECURRENCE_RULE_INVALID',
    });
  });
});

describe('duplicate prevention', () => {
  /**
   * THE test. The same slot run twice must produce exactly one order - the
   * second run collides on unique(scheduleId, plannedRunAt) and stops before
   * any side effect.
   */
  it('produces one order when the same slot runs twice', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);

    const first = await runOccurrence(schedule.scheduleId, slot);
    const second = await runOccurrence(schedule.scheduleId, slot);

    expect(first.result).toBe('ORDER_CREATED');
    expect(second.result).toBe('DUPLICATE');

    expect(await prisma.order.count()).toBe(1);

    // Exactly one occurrence for the slot that was served.
    //
    // Not a count of the whole table: upcoming deliveries are now materialised
    // ahead of time so the customer has rows to skip and re-date, so a plan
    // carries several SCHEDULED rows for dates in the future. The guarantee
    // being tested is about the slot that ran.
    expect(await prisma.scheduleOccurrence.count({ where: { plannedRunAt: slot } })).toBe(1);
    expect(await prisma.scheduleOccurrence.count({ where: { order: { isNot: null } } })).toBe(1);
  });

  /** Ten workers, one slot. Exactly one order. */
  it('produces one order when ten workers race for the same slot', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => runOccurrence(schedule.scheduleId, slot)),
    );

    const created = results.filter(
      (r) => r.status === 'fulfilled' && r.value.result === 'ORDER_CREATED',
    );

    expect(created).toHaveLength(1);
    expect(await prisma.order.count()).toBe(1);
    // One row for the contested slot, however many workers reached for it.
    expect(await prisma.scheduleOccurrence.count({ where: { plannedRunAt: slot } })).toBe(1);
  });

  /** The lease stops two workers even attempting the same schedule. */
  it('leases a schedule to exactly one worker', async () => {
    const schedule = await makeSchedule();
    await makeDue(schedule.scheduleId);

    const claims = await Promise.all([
      claimDueSchedules(10, 'worker-a'),
      claimDueSchedules(10, 'worker-b'),
      claimDueSchedules(10, 'worker-c'),
    ]);

    const total = claims.reduce((sum, batch) => sum + batch.length, 0);
    expect(total).toBe(1);
  });

  it('does not claim a schedule that is not yet due', async () => {
    await makeSchedule();
    expect(await claimDueSchedules(10, 'worker-a')).toHaveLength(0);
  });

  it('does not claim a paused schedule', async () => {
    const schedule = await makeSchedule();
    await makeDue(schedule.scheduleId);
    await pauseSchedule(schedule.scheduleId, customerActor, customerProfileId);

    expect(await claimDueSchedules(10, 'worker-a')).toHaveLength(0);
  });

  /** A crashed worker must not hold a schedule hostage. */
  it('reclaims a schedule whose lease expired', async () => {
    const schedule = await makeSchedule();
    await makeDue(schedule.scheduleId);

    await claimDueSchedules(10, 'worker-that-dies');
    expect(await claimDueSchedules(10, 'worker-b')).toHaveLength(0);

    await prisma.recurringSchedule.update({
      where: { id: schedule.scheduleId },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    expect(await claimDueSchedules(10, 'worker-b')).toHaveLength(1);
  });

  /**
   * The second guard. Even with the occurrence row forced back to PENDING, the
   * unique index on orders.scheduleOccurrenceId prevents a second order.
   */
  it('cannot attach two orders to one occurrence', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);
    await runOccurrence(schedule.scheduleId, slot);

    // The occurrence that actually ran, not merely the first row in the
    // table - a plan also carries materialised rows for future dates, and
    // attaching an order to one of those would prove nothing.
    const occurrence = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });

    await expect(
      prisma.order.create({
        data: {
          id: newId(),
          orderNumber: 'UB-DUPLICATE-1',
          customerProfileId,
          source: 'RECURRING',
          scheduleOccurrenceId: occurrence.id,
          status: 'PENDING_PAYMENT',
          currency: 'INR',
          billingAddressJson: {},
          shippingAddressJson: {},
        },
      }),
    ).rejects.toBeTruthy();
  });
});

describe('running an occurrence', () => {
  it('creates a recurring order with current prices and reserved stock', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);

    const outcome = await runOccurrence(schedule.scheduleId, slot);
    expect(outcome.result).toBe('ORDER_CREATED');

    const order = await prisma.order.findFirstOrThrow({ include: { items: true } });
    expect(order.source).toBe('RECURRING');
    expect(order.status).toBe('PENDING_PAYMENT');
    // 20 x 45.50 = 910.00 + 18% = 1073.80.
    expect(order.grandTotalMinor).toBe(107_380n);
    expect(order.items[0]?.nameSnapshot).toBe('Hex Bolt M12');

    expect((await getAvailability({ productId })).reservedQty).toBe(20);
  });

  /** SOP 11: every occurrence is repriced, never charged at the old figure. */
  it('reprices at the current catalog value', async () => {
    const schedule = await makeSchedule();
    await prisma.product.update({ where: { id: productId }, data: { basePriceMinor: 5000n } });

    const slot = await makeDue(schedule.scheduleId);
    await runOccurrence(schedule.scheduleId, slot);

    const order = await prisma.order.findFirstOrThrow();
    // 20 x 50.00 = 1000.00 + 18% = 1180.00.
    expect(order.grandTotalMinor).toBe(118_000n);
  });

  it('advances the schedule to the next slot', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);
    await runOccurrence(schedule.scheduleId, slot);

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });

    expect(row.occurrenceCount).toBe(1);
    expect(row.nextRunAt).not.toBeNull();
    expect(row.nextRunAt?.getTime()).toBeGreaterThan(slot.getTime());
    // The lease is released for the next run.
    expect(row.leaseOwner).toBeNull();
  });

  it('sends a payment link for a payment-link schedule', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);
    await runOccurrence(schedule.scheduleId, slot);

    const link = await prisma.paymentLink.findFirst();
    expect(link?.recipientEmail).toBe('finance@acme.test');

    const outbox = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'payment.link' },
    });
    expect(outbox?.body).toContain('/pay?token=');
  });

  it('skips when the customer has been deactivated', async () => {
    const schedule = await makeSchedule();
    await prisma.user.updateMany({
      where: { emailNormalized: 'buyer@rec.test' },
      data: { status: 'DEACTIVATED' },
    });

    const slot = await makeDue(schedule.scheduleId);
    const outcome = await runOccurrence(schedule.scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    expect(await prisma.order.count()).toBe(0);
  });

  /** A product pulled from sale must pause the schedule, not charge for it. */
  it('pauses when a scheduled product is unpublished', async () => {
    const schedule = await makeSchedule();
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });

    const slot = await makeDue(schedule.scheduleId);
    const outcome = await runOccurrence(schedule.scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    expect(await prisma.order.count()).toBe(0);

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });
    expect(row.status).toBe('PAUSED');

    // And the customer is told rather than left wondering.
    const notice = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'schedule.failed' },
    });
    expect(notice).not.toBeNull();
  });

  /**
   * Withdrawing a product from a curated recurring range pauses the plans on
   * it, rather than holding the occurrence and emailing the customer about it
   * every cycle for ever. Only reachable with the flag off — see
   * `withCuratedEligibility`.
   */
  it('pauses when a product is taken out of a curated recurring range', async () => {
    await withCuratedEligibility(async () => {
      const schedule = await makeSchedule();
      await prisma.product.update({
        where: { id: productId },
        data: { isRecurringEligible: false },
      });

      const slot = await makeDue(schedule.scheduleId);
      expect((await runOccurrence(schedule.scheduleId, slot)).result).toBe('SKIPPED');

      const row = await prisma.recurringSchedule.findUniqueOrThrow({
        where: { id: schedule.scheduleId },
      });
      expect(row.status).toBe('PAUSED');
    });
  });

  /**
   * SOP 11.1: a price rise past the approved threshold must not be charged
   * silently.
   */
  it('pauses when the total exceeds the approved reprice threshold', async () => {
    const schedule = await makeSchedule({ repriceApprovalThresholdMinor: '110000' });

    // Push the total from 1073.80 to well above the 1100.00 threshold.
    await prisma.product.update({ where: { id: productId }, data: { basePriceMinor: 9000n } });

    const slot = await makeDue(schedule.scheduleId);
    const outcome = await runOccurrence(schedule.scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    expect(await prisma.order.count()).toBe(0);

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });
    expect(row.status).toBe('PAUSED');
    expect(row.pausedReason).toContain('threshold');
  });

  /**
   * Short stock HOLDS the delivery; it does not fail it.
   *
   * The distinction is the customer's. Nothing went wrong and nothing was
   * charged - the warehouse simply cannot supply this week, and the
   * subscription carries on. So the occurrence is SKIPPED with a reason rather
   * than FAILED, which is reserved for something that actually broke.
   *
   * The plan's failure streak still advances (see below), so a product that
   * stays short for months stops the plan instead of emailing the customer
   * every cycle for ever.
   */
  it('holds the delivery without an order when stock is short', async () => {
    const schedule = await makeSchedule();
    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { onHandQty: 5 } });

    const slot = await makeDue(schedule.scheduleId);
    const outcome = await runOccurrence(schedule.scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    // Nothing half-written: no order, no items, no reservation.
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.orderItem.count()).toBe(0);
    expect(await prisma.stockReservation.count()).toBe(0);

    // And the customer is told, without being told anything was substituted.
    const notice = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'schedule.stock_unavailable' },
    });
    expect(notice).not.toBeNull();

    const held = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    expect(held.status).toBe('SKIPPED');
    // Not the customer's doing, so their screens say "we could not supply
    // this" rather than "you skipped this".
    expect(held.skippedByUser).toBe(false);
  });

  /**
   * A plan that reaches its limit is COMPLETED, not CANCELLED.
   *
   * The previous engine wrote CANCELLED here, and it was wrong in a way the
   * customer could see: nobody cancelled anything, the subscription ran the
   * number of times they asked for and finished. "This has finished" and "you
   * cancelled this" are different sentences and the screens say different
   * things for each.
   */
  it('completes at the occurrence limit', async () => {
    const schedule = await makeSchedule({ maxOccurrences: 1 });
    const slot = await makeDue(schedule.scheduleId);

    await runOccurrence(schedule.scheduleId, slot);

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });
    expect(row.status).toBe('COMPLETED');
    expect(row.completedAt).not.toBeNull();
    expect(row.cancelReason).toContain('occurrence limit');
    expect(row.nextRunAt).toBeNull();
  });

  it('stops after the end date', async () => {
    /*
     * The window has closed behind the slot being run.
     *
     * It used to be expressed as an end date in the past, which is no longer
     * expressible: a first delivery needs a week's notice, so the start date
     * is a week out and an end date before it would be a window with no days
     * in it - refused, correctly, by a different check. So the plan ends on
     * the day of its first delivery, and the slot handed to the engine is two
     * days after that. The thing under test is unchanged: the engine refuses
     * a slot past the end date and writes no order.
     */
    const endDate = await earliestFirstDelivery();
    const schedule = await makeSchedule({ endDate });

    const slot = new Date(`${addCalendarDays(endDate, 2)}T06:00:00.000Z`);
    await prisma.recurringSchedule.update({
      where: { id: schedule.scheduleId },
      data: { nextRunAt: slot },
    });

    const outcome = await runOccurrence(schedule.scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    expect(await prisma.order.count()).toBe(0);
  });
});

describe('repeated failures', () => {
  /**
   * A schedule that fails forever, retrying nightly, is worse than one that
   * stops and asks for attention.
   */
  it('pauses the schedule after the failure threshold', async () => {
    const schedule = await makeSchedule({ maxFailures: 2 });
    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { onHandQty: 0 } });

    // Each attempt uses a distinct slot, as consecutive real runs would.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const slot = new Date(Date.now() - (attempt + 1) * 3_600_000);
      await prisma.recurringSchedule.update({
        where: { id: schedule.scheduleId },
        data: { nextRunAt: slot, status: 'ACTIVE' },
      });
      await runOccurrence(schedule.scheduleId, slot);
    }

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });

    expect(row.status).toBe('FAILED');
    expect(row.failureCount).toBeGreaterThanOrEqual(2);
    expect(row.nextRunAt).toBeNull();
    // And it stops being picked up.
    expect(await claimDueSchedules(10, 'worker-a')).toHaveLength(0);
  });

  it('resets the failure count after a success', async () => {
    const schedule = await makeSchedule({ maxFailures: 3 });

    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { onHandQty: 0 } });
    const failSlot = new Date(Date.now() - 7_200_000);
    await prisma.recurringSchedule.update({
      where: { id: schedule.scheduleId },
      data: { nextRunAt: failSlot },
    });
    await runOccurrence(schedule.scheduleId, failSlot);

    expect(
      (await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.scheduleId } }))
        .failureCount,
    ).toBe(1);

    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { onHandQty: 1000 } });
    const okSlot = new Date(Date.now() - 3_600_000);
    await prisma.recurringSchedule.update({
      where: { id: schedule.scheduleId },
      data: { nextRunAt: okSlot, status: 'ACTIVE' },
    });
    await runOccurrence(schedule.scheduleId, okSlot);

    expect(
      (await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: schedule.scheduleId } }))
        .failureCount,
    ).toBe(0);
  });
});

describe('pause, resume, cancel', () => {
  it('pauses and takes the schedule out of the due query', async () => {
    const schedule = await makeSchedule();
    await pauseSchedule(schedule.scheduleId, customerActor, customerProfileId, 'going on holiday');

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });
    expect(row.status).toBe('PAUSED');
    expect(row.nextRunAt).toBeNull();
  });

  /** A schedule paused for a month must not fire four times to catch up. */
  it('recomputes the next run on resume rather than firing for missed slots', async () => {
    const schedule = await makeSchedule();
    await pauseSchedule(schedule.scheduleId, customerActor, customerProfileId);

    const resumed = await resumeSchedule(schedule.scheduleId, customerActor, customerProfileId);

    expect(resumed.nextRunAt).not.toBeNull();
    expect(resumed.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(await prisma.order.count()).toBe(0);
  });

  it('clears the failure count on resume', async () => {
    const schedule = await makeSchedule();
    await prisma.recurringSchedule.update({
      where: { id: schedule.scheduleId },
      data: { status: 'FAILED', failureCount: 5 },
    });

    await resumeSchedule(schedule.scheduleId, customerActor, customerProfileId);

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });
    expect(row.status).toBe('ACTIVE');
    // Otherwise it would pause again on the next single failure.
    expect(row.failureCount).toBe(0);
  });

  /** SOP 11: cancelling future runs must not disturb completed orders. */
  it('cancels future runs and leaves completed orders alone', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);
    await runOccurrence(schedule.scheduleId, slot);

    const orderBefore = await prisma.order.findFirstOrThrow();

    await cancelSchedule(schedule.scheduleId, customerActor, customerProfileId, 'no longer needed');

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: schedule.scheduleId },
    });
    expect(row.status).toBe('CANCELLED');
    expect(row.nextRunAt).toBeNull();

    const orderAfter = await prisma.order.findFirstOrThrow();
    expect(orderAfter.status).toBe(orderBefore.status);
    expect(orderAfter.grandTotalMinor).toBe(orderBefore.grandTotalMinor);
  });

  it('cannot resume a cancelled schedule', async () => {
    const schedule = await makeSchedule();
    await cancelSchedule(schedule.scheduleId, customerActor, customerProfileId);

    await expect(
      resumeSchedule(schedule.scheduleId, customerActor, customerProfileId),
    ).rejects.toMatchObject({ code: 'SCHEDULE_ALREADY_CANCELLED' });
  });

  /** The IDOR case: another customer's schedule must not resolve. */
  it('scopes pause and cancel to the owning customer', async () => {
    const schedule = await makeSchedule();
    const strangerProfileId = newId();

    await expect(
      pauseSchedule(schedule.scheduleId, customerActor, strangerProfileId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      cancelSchedule(schedule.scheduleId, customerActor, strangerProfileId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets an admin act without an ownership scope', async () => {
    const schedule = await makeSchedule();
    await expect(
      pauseSchedule(schedule.scheduleId, adminActor, null, 'support request'),
    ).resolves.toBeUndefined();
  });
});

describe('editing a schedule', () => {
  it('changes future runs only', async () => {
    const schedule = await makeSchedule();
    const slot = await makeDue(schedule.scheduleId);
    await runOccurrence(schedule.scheduleId, slot);

    const orderBefore = await prisma.order.findFirstOrThrow();

    await updateSchedule(
      schedule.scheduleId,
      { intervalDays: 14, items: [{ productId, quantity: 30 }] },
      customerActor,
      customerProfileId,
    );

    // The completed order is untouched.
    const orderAfter = await prisma.order.findFirstOrThrow({ include: { items: true } });
    expect(orderAfter.grandTotalMinor).toBe(orderBefore.grandTotalMinor);
    expect(orderAfter.items[0]?.quantity).toBe(20);

    const items = await prisma.recurringScheduleItem.findMany({
      where: { scheduleId: schedule.scheduleId },
    });
    expect(items[0]?.quantity).toBe(30);
  });

  it('cannot edit a cancelled schedule', async () => {
    const schedule = await makeSchedule();
    await cancelSchedule(schedule.scheduleId, customerActor, customerProfileId);

    await expect(
      updateSchedule(schedule.scheduleId, { name: 'New name' }, customerActor, customerProfileId),
    ).rejects.toMatchObject({ code: 'SCHEDULE_ALREADY_CANCELLED' });
  });
});

describe('reminders', () => {
  it('warns before a run, once per slot', async () => {
    const schedule = await makeSchedule();
    await prisma.recurringSchedule.update({
      where: { id: schedule.scheduleId },
      data: { nextRunAt: new Date(Date.now() + 3_600_000) },
    });

    expect(await sendUpcomingReminders(24)).toBe(1);
    // A second sweep must not send a second reminder for the same slot.
    expect(await sendUpcomingReminders(24)).toBe(0);
  });

  it('does not remind for a run beyond the window', async () => {
    const schedule = await makeSchedule();
    await prisma.recurringSchedule.update({
      where: { id: schedule.scheduleId },
      data: { nextRunAt: new Date(Date.now() + 5 * 86_400_000) },
    });

    expect(await sendUpcomingReminders(24)).toBe(0);
  });
});
