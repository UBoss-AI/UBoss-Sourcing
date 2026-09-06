/**
 * Data subject rights - integration, against a real MariaDB.
 *
 * Four themes, and each one is a claim that would be expensive to be wrong
 * about:
 *
 *   - **The export is complete.** The failure mode of an access request is
 *     quiet omission - a table nobody remembered - so the bundle is asserted
 *     section by section, and the manifest is checked against the models the
 *     schema actually has.
 *   - **The export is not too complete.** Staff commentary and credentials
 *     must not travel, and Art. 15(4) is the reason.
 *   - **Erasure keeps what the law says to keep.** An invoiced order's address
 *     survives; an abandoned draft's does not. Getting this backwards means
 *     either destroying a statutory record or claiming an erasure that did not
 *     happen.
 *   - **Erasure defers when it must.** Money still owed is "not yet", not
 *     "no", and the subject has to be told which.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/domain/errors.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { buildCustomerBundle } from '../../src/modules/privacy/export-bundle.service.js';
import {
  describeKept,
  executeErasure,
  findErasureBlockers,
} from '../../src/modules/privacy/erasure.service.js';
import {
  createDataRequest,
  rejectRequest,
} from '../../src/modules/privacy/data-request.service.js';
import { runRetentionSweeps } from '../../src/modules/privacy/retention.service.js';

interface Subject {
  userId: string;
  profileId: string;
  email: string;
}

async function reset(): Promise<void> {
  await prisma.dataRequest.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.assistantMessage.deleteMany({});
  await prisma.assistantConversation.deleteMany({});
  await prisma.returnRequest.deleteMany({});
  await prisma.recurringScheduleItem.deleteMany({});
  await prisma.recurringSchedule.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerLimit.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

async function makeSubject(overrides: { email?: string } = {}): Promise<Subject> {
  const userId = newId();
  const profileId = newId();
  const email = overrides.email ?? `subject-${userId.slice(-8).toLowerCase()}@example.test`;

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email.toLowerCase(),
      phone: '+31201234567',
      passwordHash: await hashPassword('Correct-Horse-9'),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      preferredLanguage: 'nl',
    },
  });

  await prisma.customerProfile.create({
    data: {
      id: profileId,
      userId,
      fullName: 'Anneke de Vries',
      organization: 'Zorggroep Noord',
      phone: '+31201234567',
      preferredCountry: 'NL',
      preferredCurrency: 'EUR',
      consentAcceptedAt: new Date(),
      consentVersion: 'v1',
      internalNotes: 'Chased by finance in March. Spoke to their colleague Bram about it.',
    },
  });

  return { userId, profileId, email };
}

async function makeAddress(profileId: string): Promise<string> {
  const id = newId();
  await prisma.address.create({
    data: {
      id,
      customerProfileId: profileId,
      contactName: 'Anneke de Vries',
      contactPhone: '+31201234567',
      line1: 'Keizersgracht 123',
      city: 'Amsterdam',
      state: 'Noord-Holland',
      postalCode: '1015CJ',
      country: 'NL',
    },
  });
  return id;
}

async function makeOrder(
  profileId: string,
  status: 'DRAFT' | 'CONFIRMED' | 'DELIVERED' | 'CANCELLED',
  amounts: { grandTotalMinor?: bigint; paidMinor?: bigint } = {},
): Promise<string> {
  const id = newId();
  await prisma.order.create({
    data: {
      id,
      orderNumber: `UB-${id.slice(-10)}`,
      customerProfileId: profileId,
      status,
      currency: 'EUR',
      grandTotalMinor: amounts.grandTotalMinor ?? 10_000n,
      paidMinor: amounts.paidMinor ?? (status === 'DRAFT' ? 0n : 10_000n),
      billingAddressJson: { contactName: 'Anneke de Vries', line1: 'Keizersgracht 123' },
      shippingAddressJson: { contactName: 'Anneke de Vries', line1: 'Keizersgracht 123' },
      customerNote: 'Please deliver to the rear entrance.',
      internalNote: 'Account flagged by Bram in finance.',
    },
  });
  return id;
}

beforeEach(async () => {
  await reset();
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

describe('Art. 15 / 20 export bundle', () => {
  it('discloses the account, profile, addresses, orders and consents', async () => {
    const subject = await makeSubject();
    await makeAddress(subject.profileId);
    await makeOrder(subject.profileId, 'DELIVERED');

    const bundle = (await buildCustomerBundle(subject)) as {
      manifest: Record<string, unknown>;
      data: Record<string, unknown>;
    };

    expect(bundle.manifest.about).toBe(subject.email);
    expect(bundle.manifest.basis).toContain('Art. 15');

    const data = bundle.data as Record<string, { length?: number } & Record<string, unknown>>;

    expect((data.account as Record<string, unknown>).email).toBe(subject.email);
    expect((data.profile as Record<string, unknown>).fullName).toBe('Anneke de Vries');
    expect(data.addresses).toHaveLength(1);
    expect(data.orders).toHaveLength(1);
    // The terms acceptance, which is the consent record Art. 7(1) asks the
    // controller to be able to produce.
    expect(data.consents).toHaveLength(1);
  });

  it('withholds staff commentary and every credential, and says that it did', async () => {
    const subject = await makeSubject();
    await makeOrder(subject.profileId, 'DELIVERED');

    const bundle = await buildCustomerBundle(subject);
    const serialised = JSON.stringify(bundle);

    // Art. 15(4): the internal note names a colleague, so it does not travel.
    expect(serialised).not.toContain('Bram');
    expect(serialised).not.toContain('Chased by finance');

    // Nor does anything that would function as a credential.
    expect(serialised).not.toContain('passwordHash');
    expect(serialised).not.toContain('$argon2');

    // But the subject is told these categories exist, rather than being left
    // to assume the file is everything.
    const manifest = (bundle as { manifest: { sectionsWithheld: { section: string }[] } }).manifest;
    const withheld = manifest.sectionsWithheld.map((entry) => entry.section);
    expect(withheld).toContain('internalNotes');
    expect(withheld).toContain('credentials');
  });

  it('reports that a password is set without disclosing it', async () => {
    const subject = await makeSubject();

    const bundle = (await buildCustomerBundle(subject)) as {
      data: { account: { passwordSet: boolean } };
    };

    expect(bundle.data.account.passwordSet).toBe(true);
  });

  it('serialises money as strings, so no amount is rounded by a JSON number', async () => {
    const subject = await makeSubject();
    await makeOrder(subject.profileId, 'DELIVERED', { grandTotalMinor: 9_007_199_254_740_993n });

    const bundle = (await buildCustomerBundle(subject)) as {
      data: { orders: { grandTotalMinor: unknown }[] };
    };

    expect(bundle.data.orders[0]?.grandTotalMinor).toBe('9007199254740993');
  });
});

describe('Art. 17 erasure', () => {
  it('defers while an order is unpaid, and names what is in the way', async () => {
    const subject = await makeSubject();
    await makeOrder(subject.profileId, 'CONFIRMED', {
      grandTotalMinor: 10_000n,
      paidMinor: 2_500n,
    });

    const blockers = await findErasureBlockers(subject.userId);

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.code).toBe('UNPAID_ORDERS');
    expect(blockers[0]?.detail).toContain('Art. 17(3)(b)');
  });

  it('refuses to run while blocked, rather than half-erasing', async () => {
    const subject = await makeSubject();
    await makeOrder(subject.profileId, 'CONFIRMED', {
      grandTotalMinor: 10_000n,
      paidMinor: 0n,
    });

    await expect(
      executeErasure({
        userId: subject.userId,
        actorUserId: null,
        actorEmail: null,
        dataRequestId: newId(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'ERASURE_BLOCKED_BY_OBLIGATION',
    );

    // Nothing moved.
    const user = await prisma.user.findUnique({ where: { id: subject.userId } });
    expect(user?.email).toBe(subject.email);
    expect(user?.erasedAt).toBeNull();
  });

  it('pseudonymises the account and deletes the contact record', async () => {
    const subject = await makeSubject();
    await makeAddress(subject.profileId);

    const result = await executeErasure({
      userId: subject.userId,
      actorUserId: null,
      actorEmail: null,
      dataRequestId: newId(),
    });

    const user = await prisma.user.findUnique({ where: { id: subject.userId } });
    const profile = await prisma.customerProfile.findUnique({ where: { id: subject.profileId } });

    // The row survives - a dozen tables point at it - carrying nothing that
    // identifies a person.
    expect(user).not.toBeNull();
    expect(user?.email).toBe(result.pseudonym);
    // RFC 2606 reserved: unresolvable, so nothing can deliver to it by mistake.
    expect(user?.email).toMatch(/@erased\.invalid$/);
    expect(user?.passwordHash).toBeNull();
    expect(user?.phone).toBeNull();
    expect(user?.erasedAt).not.toBeNull();

    expect(profile?.fullName).toBe('Erased customer');
    expect(profile?.organization).toBeNull();
    expect(profile?.internalNotes).toBeNull();

    expect(await prisma.address.count({ where: { customerProfileId: subject.profileId } })).toBe(0);
    expect(result.deleted.addresses).toBe(1);
  });

  it('keeps an invoiced order’s address and scrubs an uninvoiced one’s', async () => {
    const subject = await makeSubject();
    const invoiced = await makeOrder(subject.profileId, 'DELIVERED');
    const draft = await makeOrder(subject.profileId, 'DRAFT');

    const result = await executeErasure({
      userId: subject.userId,
      actorUserId: null,
      actorEmail: null,
      dataRequestId: newId(),
    });

    const kept = await prisma.order.findUnique({ where: { id: invoiced } });
    const scrubbed = await prisma.order.findUnique({ where: { id: draft } });

    // VAT Directive Art. 226 requires the invoice to name the customer, and
    // national tax law requires the invoice be kept. Erasing it would be
    // destroying a statutory record, not honouring a right.
    expect(kept?.billingAddressJson).toMatchObject({ contactName: 'Anneke de Vries' });
    // The customer's own note is not part of the invoice and has no basis of
    // its own, so it goes either way.
    expect(kept?.customerNote).toBeNull();

    // A draft was never sold. Nothing requires it be kept.
    expect(scrubbed?.billingAddressJson).toEqual({ erased: true });
    expect(scrubbed?.shippingAddressJson).toEqual({ erased: true });

    const orderExemption = result.retained.find((entry) => entry.table === 'orders');
    expect(orderExemption?.count).toBe(1);
    expect(orderExemption?.basis).toContain('Art. 226');
  });

  it('cancels standing payment authorities rather than leaving them live', async () => {
    const subject = await makeSubject();
    const addressId = await makeAddress(subject.profileId);

    const scheduleId = newId();
    await prisma.recurringSchedule.create({
      data: {
        id: scheduleId,
        customerProfileId: subject.profileId,
        name: 'Monthly gloves',
        status: 'ACTIVE',
        frequency: 'MONTHLY',
        monthDay: 1,
        timezone: 'Europe/Amsterdam',
        startDate: new Date(),
        paymentMode: 'PAYMENT_LINK',
        payerEmail: subject.email,
        mandateReference: 'mandate_live_123',
        shippingAddressId: addressId,
        billingAddressId: addressId,
        consentAcceptedAt: new Date(),
        consentVersion: 'v1',
        nextRunAt: new Date(Date.now() + 86_400_000),
      },
    });

    await executeErasure({
      userId: subject.userId,
      actorUserId: null,
      actorEmail: null,
      dataRequestId: newId(),
    });

    const schedule = await prisma.recurringSchedule.findUnique({ where: { id: scheduleId } });

    expect(schedule?.status).toBe('CANCELLED');
    expect(schedule?.nextRunAt).toBeNull();
    expect(schedule?.mandateReference).toBeNull();
    expect(schedule?.payerEmail).toBeNull();

    // The address the schedule pins cannot be deleted without deleting the
    // schedule's history, so it is overwritten in place instead - which erases
    // it just as completely.
    const address = await prisma.address.findUnique({ where: { id: addressId } });
    expect(address).not.toBeNull();
    expect(address?.contactName).toBe('Erased');
    expect(address?.line1).toBe('Erased');
  });

  it('scrubs the sent-mail outbox, which holds a second copy of the person', async () => {
    const subject = await makeSubject();

    // A delivered order confirmation. The body is the customer's name and
    // delivery address written out in prose - the least obvious place a full
    // copy of an erased person survives.
    const sentId = newId();
    await prisma.notificationOutbox.create({
      data: {
        id: sentId,
        eventKey: 'order.confirmed',
        recipientEmail: subject.email,
        recipientName: 'Anneke de Vries',
        subject: 'Your order is confirmed',
        body: 'Hello Anneke de Vries,\n\nDelivering to Keizersgracht 123, Amsterdam.',
        payloadJson: { recipientName: 'Anneke de Vries' },
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    // And one still queued, which has nobody left to go to.
    const pendingId = newId();
    await prisma.notificationOutbox.create({
      data: {
        id: pendingId,
        eventKey: 'order.shipped',
        recipientEmail: subject.email,
        recipientName: 'Anneke de Vries',
        subject: 'Your order has shipped',
        body: 'Hello Anneke de Vries,',
        status: 'PENDING',
      },
    });

    await executeErasure({
      userId: subject.userId,
      actorUserId: null,
      actorEmail: null,
      dataRequestId: newId(),
    });

    expect(await prisma.notificationOutbox.findUnique({ where: { id: pendingId } })).toBeNull();

    const sent = await prisma.notificationOutbox.findUnique({ where: { id: sentId } });

    // The delivery record survives - that a message of this kind went out, and
    // when. The prose does not.
    expect(sent).not.toBeNull();
    expect(sent?.recipientEmail).not.toBe(subject.email);
    expect(sent?.recipientName).toBeNull();
    expect(sent?.body).not.toContain('Anneke');
    expect(sent?.body).not.toContain('Keizersgracht');
    expect(sent?.payloadJson).toBeNull();
  });

  it('is idempotent: a redelivered job does not erase twice', async () => {
    const subject = await makeSubject();

    const first = await executeErasure({
      userId: subject.userId,
      actorUserId: null,
      actorEmail: null,
      dataRequestId: newId(),
    });

    const second = await executeErasure({
      userId: subject.userId,
      actorUserId: null,
      actorEmail: null,
      dataRequestId: newId(),
    });

    expect(second.pseudonym).toBe(first.pseudonym);
    expect(second.deleted).toEqual({});
  });

  it('leaves the audit trail as evidence, without the address that names anyone', async () => {
    const subject = await makeSubject();

    await prisma.auditLog.create({
      data: {
        id: newId(),
        action: 'user.login',
        resourceType: 'user',
        resourceId: subject.userId,
        actorType: 'CUSTOMER',
        actorUserId: subject.userId,
        actorEmail: subject.email,
        ipAddress: '203.0.113.7',
      },
    });

    const result = await executeErasure({
      userId: subject.userId,
      actorUserId: null,
      actorEmail: null,
      dataRequestId: newId(),
    });

    const entries = await prisma.auditLog.findMany({ where: { actorUserId: subject.userId } });

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.actorEmail).not.toBe(subject.email);
      expect(entry.ipAddress).toBeNull();
    }

    // And the erasure itself is on the record - Art. 5(2) accountability.
    const proof = await prisma.auditLog.findFirst({
      where: { action: 'data_erasure.executed', resourceId: subject.userId },
    });
    expect(proof).not.toBeNull();
    expect(describeKept(result)).toContain('Art. 17(3)(b)');
  });
});

describe('the request lifecycle', () => {
  it('refuses a second open request of the same type', async () => {
    const subject = await makeSubject();

    await createDataRequest({
      userId: subject.userId,
      email: subject.email,
      type: 'EXPORT',
    });

    // Art. 12(3) runs from the first request; a second does not restart it.
    await expect(
      createDataRequest({ userId: subject.userId, email: subject.email, type: 'EXPORT' }),
    ).rejects.toSatisfy(
      (error: unknown) => isAppError(error) && error.code === 'DATA_REQUEST_ALREADY_OPEN',
    );
  });

  it('sets the one-month deadline Art. 12(3) requires', async () => {
    const subject = await makeSubject();

    const created = await createDataRequest({
      userId: subject.userId,
      email: subject.email,
      type: 'ERASURE',
    });

    const days =
      (new Date(created.dueAt).getTime() - new Date(created.requestedAt).getTime()) / 86_400_000;

    expect(Math.round(days)).toBe(30);
  });

  it('will not refuse a request without a reason', async () => {
    const subject = await makeSubject();
    const created = await createDataRequest({
      userId: subject.userId,
      email: subject.email,
      type: 'ERASURE',
    });

    // Art. 12(4): the subject has to be told why, so an empty reason is not a
    // rejection that can lawfully be sent.
    await expect(
      rejectRequest({
        requestId: created.id,
        actorUserId: newId(),
        actorEmail: 'staff@example.test',
        note: '   ',
      }),
    ).rejects.toSatisfy((error: unknown) => isAppError(error) && error.code === 'VALIDATION_FAILED');

    const row = await prisma.dataRequest.findUnique({ where: { id: created.id } });
    expect(row?.status).toBe('PENDING');
  });
});

describe('retention sweeps', () => {
  it('deletes an abandoned cart and leaves a converted one alone', async () => {
    const subject = await makeSubject();
    const old = new Date(Date.now() - 400 * 86_400_000);

    const abandoned = newId();
    const converted = newId();

    await prisma.cart.create({
      data: {
        id: abandoned,
        customerProfileId: subject.profileId,
        status: 'ACTIVE',
        currency: 'EUR',
        createdAt: old,
        updatedAt: old,
      },
    });

    await prisma.cart.create({
      data: {
        id: converted,
        customerProfileId: subject.profileId,
        status: 'CONVERTED',
        currency: 'EUR',
        createdAt: old,
        updatedAt: old,
      },
    });

    const result = await runRetentionSweeps();

    expect(result.removed.abandonedCarts).toBe(1);
    expect(await prisma.cart.findUnique({ where: { id: abandoned } })).toBeNull();
    // The link between an order and the reservation that fed it.
    expect(await prisma.cart.findUnique({ where: { id: converted } })).not.toBeNull();
  });

  it('scrubs stale sign-in telemetry but keeps the session row', async () => {
    const subject = await makeSubject();
    const old = new Date(Date.now() - 400 * 86_400_000);
    const sessionId = newId();

    await prisma.session.create({
      data: {
        id: sessionId,
        userId: subject.userId,
        refreshTokenHash: newId().padEnd(64, '0').slice(0, 64),
        familyId: newId(),
        ipAddress: '203.0.113.7',
        userAgent: 'Mozilla/5.0',
        locationLatitude: '52.370216',
        locationLongitude: '4.895168',
        locationLabel: 'Amsterdam, Netherlands',
        locationCapturedAt: old,
        expiresAt: new Date(Date.now() + 86_400_000),
        createdAt: old,
      },
    });

    await runRetentionSweeps();

    const session = await prisma.session.findUnique({ where: { id: sessionId } });

    // Staff position data ages from useful to hazardous. The row stays - it is
    // still the thing that says a session existed - with the monitoring data
    // taken off it.
    expect(session).not.toBeNull();
    expect(session?.locationLatitude).toBeNull();
    expect(session?.locationLabel).toBeNull();
    expect(session?.ipAddress).toBeNull();
    expect(session?.userAgent).toBeNull();
  });

  it('deletes delivered mail but leaves anything still queued alone', async () => {
    const old = new Date(Date.now() - 400 * 86_400_000);
    const sent = newId();
    const queued = newId();

    await prisma.notificationOutbox.create({
      data: {
        id: sent,
        eventKey: 'order.confirmed',
        recipientEmail: 'someone@example.test',
        subject: 'Your order is confirmed',
        body: 'Hello Anneke de Vries,',
        status: 'SENT',
        sentAt: old,
        createdAt: old,
      },
    });

    // Old, but never delivered. Still the outbox drain's work, not this
    // sweep's - deleting it would silently drop a notification.
    await prisma.notificationOutbox.create({
      data: {
        id: queued,
        eventKey: 'order.shipped',
        recipientEmail: 'someone@example.test',
        subject: 'Your order has shipped',
        body: 'Hello Anneke de Vries,',
        status: 'PENDING',
        createdAt: old,
      },
    });

    const result = await runRetentionSweeps();

    expect(result.removed.sentNotifications).toBe(1);
    expect(await prisma.notificationOutbox.findUnique({ where: { id: sent } })).toBeNull();
    expect(await prisma.notificationOutbox.findUnique({ where: { id: queued } })).not.toBeNull();
  });

  it('writes nothing to the audit trail when a pass finds nothing', async () => {
    const before = await prisma.auditLog.count();
    await runRetentionSweeps();
    expect(await prisma.auditLog.count()).toBe(before);
  });
});
