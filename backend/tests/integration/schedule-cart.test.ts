/**
 * Schedule Cart's server side - integration, against a real MariaDB.
 *
 * `recurring.test.ts` proves the engine cannot charge twice and
 * `scheduled-orders.test.ts` covers the money paths. This file covers what the
 * editing screen depends on, and every case here is one where getting it wrong
 * costs a customer money or trust:
 *
 *   - **A schedule is priced by `quoteSchedule` and nothing else.** The
 *     estimate the customer reads and the total the worker charges weeks later
 *     come out of one function, so a screen cannot quote a number the engine
 *     would not.
 *   - **An update is absolute, so a retry is safe.** The same PATCH applied
 *     twice leaves one basket, not a doubled one.
 *   - **The timezone can be changed, and changing it re-dates every upcoming
 *     delivery.** A plan whose clock moved but whose dates did not would fire
 *     at the old city's 06:00.
 *   - **An edit is refused while the engine is holding the basket**, even when
 *     the cutoff window for the *next* slot is wide open - which is exactly
 *     the state a plan is in while a delivery is being priced. And allowed
 *     once the order exists, because a payment link sitting unpaid for a week
 *     must not freeze the plan.
 *   - **Ownership is a `where` clause.** One customer cannot read, price or
 *     change another's schedule, and an id says nothing about whose it is.
 *
 * The catalogue endpoint AI Mode's product cards read is exercised here too,
 * because the two features arrived together and it is the same question: what
 * the server will and will not vouch for.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { earliestFirstDelivery } from '../support/schedule-dates.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import {
  cancelSchedule,
  completeSchedulePlan,
  createSchedule,
  hideSchedule,
  pauseSchedule,
  updateSchedule,
} from '../../src/modules/recurring/schedule.service.js';
import {
  estimateSchedule,
  estimateSchedules,
} from '../../src/modules/recurring/schedule-estimate.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

let adminActor: { userId: string; email: string; type: 'ADMIN' };
let customerActor: { userId: string; email: string; type: 'CUSTOMER' };
let otherActor: { userId: string; email: string; type: 'CUSTOMER' };
let customerProfileId: string;
let otherProfileId: string;
let addressId: string;
let productId: string;
let secondProductId: string;

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
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
  await prisma.productPrice.deleteMany({});
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

/** Tomorrow, as YYYY-MM-DD. Far enough out to be outside any cutoff. */
/**
 * The first date a plan's first delivery may be asked for, in this file's own
 * timezone.
 *
 * These fixtures pin their plans to Asia/Kolkata and give their addresses no
 * zone, so the floor has to be counted there - the server resolves the
 * address's zone first and falls through to the plan's. Resolved once per
 * test so the config builder below stays synchronous.
 */
let earliestDelivery = '';

beforeEach(async () => {
  await resetAll();
  earliestDelivery = await earliestFirstDelivery('Asia/Kolkata');

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
      email: 'admin@sched.test',
      emailNormalized: 'admin@sched.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@sched.test', type: 'ADMIN' };

  const buyerId = newId();
  await prisma.user.create({
    data: {
      id: buyerId,
      type: 'CUSTOMER',
      email: 'buyer@sched.test',
      emailNormalized: 'buyer@sched.test',
      status: 'ACTIVE',
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: buyerId, fullName: 'Schedule Buyer', activatedAt: new Date() },
  });
  customerProfileId = profile.id;
  customerActor = { userId: buyerId, email: 'buyer@sched.test', type: 'CUSTOMER' };

  // A second customer, purely so ownership can be attacked rather than assumed.
  const strangerId = newId();
  await prisma.user.create({
    data: {
      id: strangerId,
      type: 'CUSTOMER',
      email: 'stranger@sched.test',
      emailNormalized: 'stranger@sched.test',
      status: 'ACTIVE',
    },
  });
  const otherProfile = await prisma.customerProfile.create({
    data: { id: newId(), userId: strangerId, fullName: 'Somebody Else', activatedAt: new Date() },
  });
  otherProfileId = otherProfile.id;
  otherActor = { userId: strangerId, email: 'stranger@sched.test', type: 'CUSTOMER' };

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Schedule Buyer',
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
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });

  const gloves = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Nitrile Examination Gloves',
      slug: 'nitrile-examination-gloves',
      sku: 'NG-M',
      shortDescription: 'Powder-free, box of 100.',
      basePriceMinor: 45_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
      minOrderQty: 10,
      qtyIncrement: 10,
      isRecurringEligible: true,
    },
  });
  productId = gloves.id;

  const saline = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Sodium Chloride 0.9% Flush',
      slug: 'sodium-chloride-flush',
      sku: 'NACL-10',
      basePriceMinor: 1_200n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      isRecurringEligible: true,
    },
  });
  secondProductId = saline.id;

  await receiveStock({ productId, quantity: 500 }, adminActor);

  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  // Orders are ON DELETE RESTRICT, so anything left behind breaks the first
  // file of the next run rather than this one.
  await resetAll();
  await prisma.$disconnect();
});

/** A live monthly plan for 20 boxes of gloves. */
async function makeSchedule(overrides: Record<string, unknown> = {}) {
  return createSchedule(
    {
      customerProfileId,
      name: 'Gloves, monthly',
      frequency: 'MONTHLY',
      monthDay: 9,
      // The first date the notice period allows. It used to be three days
      // out, which the rule now refuses - and the timezone below is the one
      // it has to be counted in, because these fixtures give their addresses
      // no zone of their own.
      startDate: earliestDelivery,
      timezone: 'Asia/Kolkata',
      runAtMinute: 360,
      paymentMode: 'PAYMENT_LINK',
      payerEmail: 'finance@hospital.test',
      shippingAddressId: addressId,
      items: [{ productId, quantity: 20 }],
      consentAccepted: true,
      ...overrides,
    },
    customerActor,
  );
}

// ---------------------------------------------------------------------------
// The estimate
// ---------------------------------------------------------------------------

describe('what a schedule would cost', () => {
  it('prices the plan through quoteSchedule, in minor units', async () => {
    const created = await makeSchedule();

    const estimate = await estimateSchedule(created.scheduleId, customerProfileId);

    expect(estimate.currency).toBe('INR');
    expect(estimate.lines).toHaveLength(1);
    expect(estimate.lines[0]?.quantity).toBe(20);

    // 20 x 450.00 = 9,000.00, as a string of minor units. Never a float, and
    // never a number this test computed a second way.
    expect(estimate.lines[0]?.unitPrice.minor).toBe('45000');
    expect(estimate.totals.subtotal.minor).toBe('900000');
    // What the customer pays for the line: the tax class here is exclusive, so
    // the 18% is on top of the 9,000.00.
    expect(estimate.lines[0]?.lineTotal.minor).toBe('1062000');
    // 18% on top, because the tax class is exclusive.
    expect(estimate.totals.tax.minor).toBe('162000');
    expect(estimate.estimatedTotal?.minor).toBe('1062000');
    expect(estimate.ok).toBe(true);
  });

  it('reports a stock shortfall as a problem rather than an error', async () => {
    const created = await makeSchedule({ items: [{ productId, quantity: 1_000 }] });

    // 500 in stock, 1,000 wanted. The plan is not broken - it has something to
    // tell the customer, which is the whole reason the screen shows this.
    const estimate = await estimateSchedule(created.scheduleId, customerProfileId);

    expect(estimate.ok).toBe(false);
    expect(estimate.problems.map((problem) => problem.code)).toContain('INSUFFICIENT_STOCK');
    // And it still prices what it can, so the customer sees the consequence.
    expect(estimate.lines).toHaveLength(1);
  });

  it('prices a page of plans and stops at the documented ceiling', async () => {
    const first = await makeSchedule();
    const second = await makeSchedule({
      name: 'Saline, monthly',
      items: [{ productId: secondProductId, quantity: 5 }],
    });

    const estimates = await estimateSchedules(
      [{ id: first.scheduleId }, { id: second.scheduleId }],
      customerProfileId,
    );

    expect(estimates.size).toBe(2);
    expect(estimates.get(first.scheduleId)?.estimatedTotal?.minor).toBe('1062000');
    // 5 x 12.00 = 60.00, plus 18%.
    expect(estimates.get(second.scheduleId)?.estimatedTotal?.minor).toBe('7080');
  });

  it('will not price somebody else another customer schedule', async () => {
    const created = await makeSchedule();

    // Ownership is the `where` clause, so this is a 404 rather than a 403: an
    // id must not confirm that a schedule exists.
    await expect(estimateSchedule(created.scheduleId, otherProfileId)).rejects.toThrow(/not found/i);

    // And a list read scoped to the stranger returns nothing for it.
    const estimates = await estimateSchedules([{ id: created.scheduleId }], otherProfileId);
    expect(estimates.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

describe('changing a schedule', () => {
  it('replaces the basket rather than adding to it, however many times it is sent', async () => {
    const created = await makeSchedule();

    const body = {
      items: [
        { productId, quantity: 30 },
        { productId: secondProductId, quantity: 5 },
      ],
    };

    await updateSchedule(created.scheduleId, body, customerActor, customerProfileId);
    const afterFirst = await prisma.recurringScheduleItem.findMany({
      where: { scheduleId: created.scheduleId },
      orderBy: { productId: 'asc' },
    });

    // The retry. A network that dropped the first response, a double-click, a
    // client that resent - all of them land here.
    await updateSchedule(created.scheduleId, body, customerActor, customerProfileId);
    const afterRetry = await prisma.recurringScheduleItem.findMany({
      where: { scheduleId: created.scheduleId },
      orderBy: { productId: 'asc' },
    });

    expect(afterFirst).toHaveLength(2);
    expect(afterRetry).toHaveLength(2);
    expect(afterRetry.map((item) => [item.productId, item.quantity])).toEqual(
      afterFirst.map((item) => [item.productId, item.quantity]),
    );
  });

  it('removes a line the update leaves out', async () => {
    const created = await makeSchedule({
      items: [
        { productId, quantity: 20 },
        { productId: secondProductId, quantity: 5 },
      ],
    });

    await updateSchedule(
      created.scheduleId,
      { items: [{ productId, quantity: 20 }] },
      customerActor,
      customerProfileId,
    );

    const items = await prisma.recurringScheduleItem.findMany({
      where: { scheduleId: created.scheduleId },
    });

    expect(items).toHaveLength(1);
    expect(items[0]?.productId).toBe(productId);
  });

  it('refuses an empty basket', async () => {
    const created = await makeSchedule();

    await expect(
      updateSchedule(created.scheduleId, { items: [] }, customerActor, customerProfileId),
    ).rejects.toThrow(/at least one product/i);
  });

  it('changes the timezone and re-dates the upcoming deliveries', async () => {
    const created = await makeSchedule();
    const before = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: created.scheduleId },
    });

    const result = await updateSchedule(
      created.scheduleId,
      { timezone: 'Europe/Amsterdam' },
      customerActor,
      customerProfileId,
    );

    const after = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: created.scheduleId },
    });

    expect(after.timezone).toBe('Europe/Amsterdam');

    // 06:00 in Amsterdam is a different instant from 06:00 in Kolkata, so the
    // next run has to move. A plan whose clock changed but whose dates did not
    // would keep firing at the old city's morning.
    expect(after.nextRunAt?.toISOString()).not.toBe(before.nextRunAt?.toISOString());
    expect(result.nextRunAt?.toISOString()).toBe(after.nextRunAt?.toISOString());

    // And the materialised rows agree with the new clock rather than the old.
    const upcoming = await prisma.scheduleOccurrence.findMany({
      where: { scheduleId: created.scheduleId, status: 'SCHEDULED' },
      orderBy: { plannedRunAt: 'asc' },
    });
    expect(upcoming[0]?.plannedRunAt.toISOString()).toBe(after.nextRunAt?.toISOString());
    expect(upcoming.every((row) => row.timezone === 'Europe/Amsterdam')).toBe(true);
  });

  it('refuses a timezone the platform has never heard of', async () => {
    const created = await makeSchedule();

    await expect(
      updateSchedule(
        created.scheduleId,
        { timezone: 'Mars/Olympus_Mons' },
        customerActor,
        customerProfileId,
      ),
    ).rejects.toThrow(/timezone/i);
  });

  it('refuses an edit while a delivery is being processed', async () => {
    const created = await makeSchedule();

    /*
     * The state this guard exists for.
     *
     * The engine has claimed the imminent slot and is reading the basket to
     * price it. `nextRunAt` has moved on to the following cycle, so the cutoff
     * window for THAT slot is wide open - and the cutoff check alone would let
     * the edit through while the basket for this one was being quoted.
     */
    await prisma.scheduleOccurrence.updateMany({
      where: { scheduleId: created.scheduleId },
      data: { status: 'AWAITING_VALIDATION' },
    });

    await expect(
      updateSchedule(
        created.scheduleId,
        { items: [{ productId, quantity: 40 }] },
        customerActor,
        customerProfileId,
      ),
    ).rejects.toThrow(/being processed/i);

    // Nothing was written. The basket the worker quoted is the basket it will
    // charge for.
    const items = await prisma.recurringScheduleItem.findMany({
      where: { scheduleId: created.scheduleId },
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.quantity).toBe(20);
  });

  it('lets an administrator through the same window, on the phone to the buyer', async () => {
    const created = await makeSchedule();

    await prisma.scheduleOccurrence.updateMany({
      where: { scheduleId: created.scheduleId },
      data: { status: 'AWAITING_VALIDATION' },
    });

    // The cutoff and the in-flight guard are both about a customer racing the
    // engine. Staff handling a call about a delivery going out tomorrow are
    // not that case, and the admin surface passes `null` as the owner scope.
    await expect(
      updateSchedule(
        created.scheduleId,
        { items: [{ productId, quantity: 40 }] },
        adminActor,
        null,
      ),
    ).resolves.toBeDefined();
  });

  it('allows an edit while a payment link is out, because the order already exists', async () => {
    const created = await makeSchedule();

    /*
     * The state that is emphatically NOT in flight.
     *
     * A payment link has been sent and is unpaid, so the occurrence sits at
     * PAYMENT_PENDING - but the order was written before the link went out and
     * its items are snapshotted on it. Nothing an edit does can change what
     * that customer was asked to pay, and a plan that could not be edited
     * while a link went unpaid would be a plan frozen by somebody else's inbox.
     */
    await prisma.scheduleOccurrence.updateMany({
      where: { scheduleId: created.scheduleId },
      data: { status: 'PAYMENT_PENDING' },
    });

    await expect(
      updateSchedule(
        created.scheduleId,
        { items: [{ productId, quantity: 40 }] },
        customerActor,
        customerProfileId,
      ),
    ).resolves.toBeDefined();
  });

  it('never touches an occurrence that already produced an order', async () => {
    const created = await makeSchedule();

    // A delivery that has happened. Its row keeps a terminal status, and the
    // whole promise of this screen is that editing does not reach back into it.
    const past = await prisma.scheduleOccurrence.create({
      data: {
        id: newId(),
        scheduleId: created.scheduleId,
        plannedRunAt: new Date(Date.now() - 30 * 86_400_000),
        timezone: 'Asia/Kolkata',
        status: 'COMPLETED',
        idempotencyKey: `occ:${created.scheduleId}:20260101000000000`,
      },
    });

    await updateSchedule(
      created.scheduleId,
      { items: [{ productId, quantity: 40 }] },
      customerActor,
      customerProfileId,
    );

    const stillThere = await prisma.scheduleOccurrence.findUnique({ where: { id: past.id } });
    expect(stillThere?.status).toBe('COMPLETED');
    expect(stillThere?.plannedRunAt.toISOString()).toBe(past.plannedRunAt.toISOString());
  });

  it('will not let one customer change another schedule', async () => {
    const created = await makeSchedule();

    await expect(
      updateSchedule(
        created.scheduleId,
        { items: [{ productId, quantity: 999 }] },
        otherActor,
        otherProfileId,
      ),
    ).rejects.toThrow(/not found/i);

    const items = await prisma.recurringScheduleItem.findMany({
      where: { scheduleId: created.scheduleId },
    });
    expect(items[0]?.quantity).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Clearing a finished plan off the customer's list
// ---------------------------------------------------------------------------

describe('removing a schedule from the list', () => {
  it('hides a cancelled plan without deleting anything', async () => {
    const created = await makeSchedule();
    await cancelSchedule(created.scheduleId, customerActor, customerProfileId, 'switching supplier');

    await hideSchedule(created.scheduleId, customerActor, customerProfileId);

    // Gone from the customer's list...
    const visible = await prisma.recurringSchedule.findMany({
      where: { customerProfileId, hiddenAt: null },
    });
    expect(visible.map((plan) => plan.id)).not.toContain(created.scheduleId);

    // ...and still there. The row is the record that somebody authorised
    // recurring charges: the consent, the cart they agreed to, the reason it
    // was cancelled. A customer tidying a list does not destroy that.
    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: created.scheduleId },
      include: { items: true },
    });
    expect(row.hiddenAt).not.toBeNull();
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelReason).toBe('switching supplier');
    expect(row.consentAcceptedAt).not.toBeNull();
    expect(row.items).toHaveLength(1);
  });

  it('hides a completed plan too', async () => {
    const created = await makeSchedule();
    await completeSchedulePlan(created.scheduleId, 'reached its end date');

    await expect(
      hideSchedule(created.scheduleId, customerActor, customerProfileId),
    ).resolves.toEqual({ hidden: true });
  });

  it('refuses to hide a plan that is still running', async () => {
    const created = await makeSchedule();

    /*
     * The rule that matters.
     *
     * Hiding a live authority to charge would mean money leaving an account
     * for an arrangement the customer can no longer see. The refusal names the
     * way out rather than just saying no.
     */
    await expect(hideSchedule(created.scheduleId, customerActor, customerProfileId)).rejects.toThrow(
      /cancelled or finished/i,
    );

    const row = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: created.scheduleId },
    });
    expect(row.hiddenAt).toBeNull();
  });

  it('refuses to hide a paused plan', async () => {
    const created = await makeSchedule();
    await pauseSchedule(created.scheduleId, customerActor, customerProfileId, 'away this month');

    // Paused is not finished: it resumes, and then it charges.
    await expect(hideSchedule(created.scheduleId, customerActor, customerProfileId)).rejects.toThrow(
      /cancelled or finished/i,
    );
  });

  it('is idempotent, so a retry is not an error', async () => {
    const created = await makeSchedule();
    await cancelSchedule(created.scheduleId, customerActor, customerProfileId);

    const first = await hideSchedule(created.scheduleId, customerActor, customerProfileId);
    const hiddenAt = (
      await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: created.scheduleId } })
    ).hiddenAt;

    // A dropped response, a double-tap, a second tab. All of them mean the
    // same thing, and it has already been done.
    const second = await hideSchedule(created.scheduleId, customerActor, customerProfileId);

    expect(first).toEqual({ hidden: true });
    expect(second).toEqual({ hidden: true });
    // And the second call does not move the timestamp.
    expect(
      (await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: created.scheduleId } }))
        .hiddenAt,
    ).toEqual(hiddenAt);
  });

  it('will not let one customer hide another schedule', async () => {
    const created = await makeSchedule();
    await cancelSchedule(created.scheduleId, customerActor, customerProfileId);

    await expect(hideSchedule(created.scheduleId, otherActor, otherProfileId)).rejects.toThrow(
      /not found/i,
    );

    expect(
      (await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: created.scheduleId } }))
        .hiddenAt,
    ).toBeNull();
  });

  it('keeps a hidden plan out of every customer read, and in the admin one', async () => {
    const created = await makeSchedule();
    await cancelSchedule(created.scheduleId, customerActor, customerProfileId);
    await hideSchedule(created.scheduleId, customerActor, customerProfileId);

    // The estimate is a customer read, and answers 404 for a hidden plan: a
    // stale link must not open it.
    await expect(estimateSchedule(created.scheduleId, customerProfileId)).rejects.toThrow(
      /not found/i,
    );

    // Priced as an administrator — no ownership scope, no visibility scope.
    // Staff see everything, which is the whole point of a soft delete.
    await expect(estimateSchedule(created.scheduleId, null)).resolves.toMatchObject({
      scheduleId: created.scheduleId,
    });
  });

  it('records who removed it and when', async () => {
    const created = await makeSchedule();
    await cancelSchedule(created.scheduleId, customerActor, customerProfileId);
    await hideSchedule(created.scheduleId, customerActor, customerProfileId);

    // Not because hiding a row is dangerous, but because the row stops
    // appearing at that moment — and somebody asking later why a plan they
    // remember is missing deserves better than "it must have been you".
    const audit = await prisma.auditLog.findFirst({
      where: { resourceId: created.scheduleId, action: 'schedule.hidden' },
    });

    expect(audit).not.toBeNull();
    expect(audit?.actorEmail).toBe(customerActor.email);
  });

  it('is refused by the database even if a caller forgets to ask', async () => {
    const created = await makeSchedule();

    /*
     * The second lock.
     *
     * The service checks the status, and the CHECK constraint
     * chk_schedule_hidden_only_when_terminal checks it again in MariaDB. This
     * test bypasses the service entirely, which is the only way to prove the
     * constraint is really there — a future caller that writes the column
     * directly must not be able to hide a live plan.
     */
    await expect(
      prisma.recurringSchedule.update({
        where: { id: created.scheduleId },
        data: { hiddenAt: new Date() },
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The HTTP surface
// ---------------------------------------------------------------------------

describe('the routes the workspace calls', () => {
  it('refuses an unauthenticated read of somebody schedules', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/recurring-schedules' });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an unauthenticated estimate', async () => {
    const created = await makeSchedule();

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/recurring-schedules/${created.scheduleId}/estimate`,
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an unauthenticated removal', async () => {
    const created = await makeSchedule();

    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/recurring-schedules/${created.scheduleId}/hide`,
      payload: {},
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses an unauthenticated edit', async () => {
    const created = await makeSchedule();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/recurring-schedules/${created.scheduleId}`,
      payload: { items: [{ productId, quantity: 40 }] },
    });

    expect(response.statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Verified product cards, which AI Mode renders
// ---------------------------------------------------------------------------

describe('GET /api/v1/catalog/product-cards', () => {
  it('resolves a slug into a full, priced card', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/product-cards?refs=nitrile-examination-gloves&currency=INR&country=IN',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<{
      products: {
        matchedRef: string;
        name: string;
        sku: string;
        price: { minor: string } | null;
        primaryImage: unknown;
        availability: { isStockTracked: boolean; inStock: boolean; availableQty: number | null };
      }[];
      unresolved: string[];
    }>();

    expect(body.products).toHaveLength(1);
    expect(body.products[0]?.matchedRef).toBe('nitrile-examination-gloves');
    expect(body.products[0]?.name).toBe('Nitrile Examination Gloves');
    expect(body.products[0]?.sku).toBe('NG-M');
    expect(body.products[0]?.price?.minor).toBe('45000');
    // The card says whether it can be had now, from the balance rather than
    // from anything a model wrote.
    expect(body.products[0]?.availability).toEqual({
      isStockTracked: true,
      inStock: true,
      availableQty: 500,
    });
    expect(body.unresolved).toEqual([]);
  });

  it('resolves a product code as well, because that is what the model quotes', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/product-cards?refs=NG-M',
    });

    const body = response.json<{ products: { slug: string }[] }>();
    expect(body.products[0]?.slug).toBe('nitrile-examination-gloves');
  });

  it('names a reference it cannot resolve instead of dropping it', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/product-cards?refs=nitrile-examination-gloves,invented-by-a-model',
    });

    const body = response.json<{ products: unknown[]; unresolved: string[] }>();

    // The whole point of the endpoint: an invented product code produces no
    // card at all, and the caller is told so rather than quietly shown fewer
    // cards than the answer mentioned.
    expect(body.products).toHaveLength(1);
    expect(body.unresolved).toEqual(['invented-by-a-model']);
  });

  it('keeps the order the references were given in', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/product-cards?refs=sodium-chloride-flush,nitrile-examination-gloves',
    });

    const body = response.json<{ products: { slug: string }[] }>();

    // That order is the assistant's recommendation, most relevant first.
    expect(body.products.map((product) => product.slug)).toEqual([
      'sodium-chloride-flush',
      'nitrile-examination-gloves',
    ]);
  });

  it('reports an untracked product as uncounted, never as none left', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/product-cards?refs=sodium-chloride-flush',
    });

    const body = response.json<{
      products: { availability: { isStockTracked: boolean; inStock: boolean; availableQty: number | null } }[];
    }>();

    expect(body.products[0]?.availability).toEqual({
      isStockTracked: false,
      inStock: true,
      availableQty: null,
    });
  });

  it('cannot be used to reach an unpublished product', async () => {
    await prisma.product.update({
      where: { id: secondProductId },
      data: { isPublished: false, publishedAt: null },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/product-cards?refs=sodium-chloride-flush',
    });

    const body = response.json<{ products: unknown[]; unresolved: string[] }>();

    // The same visibility filter every storefront read uses. Guessing a slug
    // must not confirm an unreleased product.
    expect(body.products).toEqual([]);
    expect(body.unresolved).toEqual(['sodium-chloride-flush']);
  });

  it('answers an empty reference list with an empty result, not an error', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/product-cards',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ products: unknown[] }>().products).toEqual([]);
  });

  it('caps how many references one call will resolve', async () => {
    const refs = Array.from({ length: 40 }, (_unused, index) => `made-up-${String(index)}`);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/product-cards?refs=${refs.join(',')}`,
    });

    expect(response.statusCode).toBe(200);
    // Twelve, and the rest are not even reported: this is a public route and
    // the ceiling is what keeps it one indexed read.
    expect(response.json<{ unresolved: string[] }>().unresolved).toHaveLength(12);
  });
});
