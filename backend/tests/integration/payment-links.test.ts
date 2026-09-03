/**
 * Payment links and refunds - integration, against a real MariaDB.
 *
 * Scope note: these tests exercise everything up to the provider boundary -
 * token hashing, expiry, single use, supersession, amount binding, and the
 * max-refundable rule. They deliberately do NOT call Razorpay, so the suite
 * stays fast and offline.
 *
 * That boundary is a real one: every rejection tested here happens BEFORE any
 * provider call, which is exactly where an over-refund or a stale link must be
 * caught. The adapter's live API path is verified separately against Razorpay's
 * test environment.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { encryptSecret, sha256Hex } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  createPaymentLink,
  expirePaymentLinks,
  resolvePaymentLink,
  revokePaymentLink,
} from '../../src/modules/payments/payment-link.service.js';
import { createRefund, getRefundQuote } from '../../src/modules/payments/refund.service.js';

let adminActor: { userId: string; email: string };
let customerProfileId: string;
let orderId: string;
let connectionId: string;

/** Pull the raw token out of the queued email - the only place it exists. */
async function tokenFromOutbox(): Promise<string> {
  const outbox = await prisma.notificationOutbox.findFirstOrThrow({
    where: { eventKey: 'payment.link' },
    orderBy: { createdAt: 'desc' },
  });

  const match = /\/pay\?token=([A-Za-z0-9_-]+)/.exec(outbox.body);
  if (match?.[1] === undefined) throw new Error('no payment link token found in the outbox body');
  return match[1];
}

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.refund.deleteMany({});
  await prisma.paymentLink.deleteMany({});
  await prisma.paymentTransaction.deleteMany({});
  await prisma.paymentProviderConnection.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
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
      email: 'finance@link.test',
      emailNormalized: 'finance@link.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'finance@link.test' };

  const customerUserId = newId();
  await prisma.user.create({
    data: {
      id: customerUserId,
      type: 'CUSTOMER',
      email: 'buyer@link.test',
      emailNormalized: 'buyer@link.test',
      status: 'ACTIVE',
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: customerUserId, fullName: 'Link Buyer' },
  });
  customerProfileId = profile.id;

  connectionId = newId();
  await prisma.paymentProviderConnection.create({
    data: {
      id: connectionId,
      provider: 'RAZORPAY',
      mode: 'TEST',
      label: 'Test connection',
      credentialsEnc: encryptSecret(
        JSON.stringify({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }),
        `payment_connection:${connectionId}`,
      ),
      webhookSecretEnc: encryptSecret(
        env.RAZORPAY_WEBHOOK_SECRET,
        `payment_connection:${connectionId}`,
      ),
      isActive: true,
    },
  });

  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: 'UB-2026-000001',
      customerProfileId,
      status: 'PENDING_PAYMENT',
      currency: 'INR',
      subtotalMinor: 100_000n,
      taxMinor: 18_000n,
      grandTotalMinor: 118_000n,
      billingAddressJson: {},
      shippingAddressJson: {},
    },
  });
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

function makeLink(overrides: Record<string, unknown> = {}) {
  return createPaymentLink({
    orderId,
    recipientEmail: 'approver@acme.test',
    recipientName: 'Finance Approver',
    actorUserId: adminActor.userId,
    actorEmail: adminActor.email,
    ...overrides,
  });
}

describe('creating a payment link', () => {
  it('locks the outstanding amount and emails the link', async () => {
    const link = await makeLink();

    expect(link.amount.minor).toBe('118000');
    expect(link.url).toContain('/pay?token=');

    const outbox = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventKey: 'payment.link' },
    });
    expect(outbox.recipientEmail).toBe('approver@acme.test');
    expect(outbox.body).toContain('118000.00'.replace('118000.00', '1180.00'));
  });

  /** A leaked database dump must contain no usable link. */
  it('stores only the token hash, never the token', async () => {
    const link = await makeLink();
    const token = await tokenFromOutbox();

    const row = await prisma.paymentLink.findUniqueOrThrow({ where: { id: link.paymentLinkId } });

    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(row.tokenHash).not.toContain(token);

    // The row carries BigInt money columns, so JSON.stringify needs a replacer.
    const serialised = JSON.stringify(row, (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialised).not.toContain(token);
  });

  it('refuses an order that is not awaiting payment', async () => {
    await prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED' } });
    await expect(makeLink()).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' });
  });

  it('refuses an order that is already paid in full', async () => {
    await prisma.order.update({ where: { id: orderId }, data: { paidMinor: 118_000n } });
    await expect(makeLink()).rejects.toMatchObject({ code: 'ORDER_ALREADY_PAID' });
  });

  /**
   * Two live links for one order is two invitations to pay the same money.
   * Resending must kill the previous one.
   */
  it('supersedes an earlier link when a new one is sent', async () => {
    await makeLink();
    const firstToken = await tokenFromOutbox();

    const second = await makeLink();

    await expect(resolvePaymentLink(firstToken)).rejects.toMatchObject({
      code: 'PAYMENT_LINK_REVOKED',
    });

    const superseded = await prisma.paymentLink.findFirstOrThrow({
      where: { tokenHash: sha256Hex(firstToken) },
    });
    expect(superseded.supersededByLinkId).toBe(second.paymentLinkId);

    // The new one still works.
    const newToken = await tokenFromOutbox();
    await expect(resolvePaymentLink(newToken)).resolves.toBeTruthy();
  });
});

describe('resolving a payment link', () => {
  it('shows what is being paid for, without consuming the link', async () => {
    await makeLink();
    const token = await tokenFromOutbox();

    const resolved = await resolvePaymentLink(token);
    expect(resolved.orderNumber).toBe('UB-2026-000001');
    expect(resolved.customerName).toBe('Link Buyer');
    expect(resolved.amount.formatted).toBe('1180.00');

    // Still usable - resolving is a read.
    await expect(resolvePaymentLink(token)).resolves.toBeTruthy();
  });

  it('rejects an unknown token', async () => {
    await expect(resolvePaymentLink('not-a-real-token-value')).rejects.toMatchObject({
      code: 'PAYMENT_LINK_INVALID',
    });
  });

  it('rejects an expired link', async () => {
    const link = await makeLink();
    const token = await tokenFromOutbox();

    await prisma.paymentLink.update({
      where: { id: link.paymentLinkId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(resolvePaymentLink(token)).rejects.toMatchObject({
      code: 'PAYMENT_LINK_EXPIRED',
    });
  });

  it('rejects a link that has already been used', async () => {
    const link = await makeLink();
    const token = await tokenFromOutbox();

    await prisma.paymentLink.update({
      where: { id: link.paymentLinkId },
      data: { usedAt: new Date() },
    });

    await expect(resolvePaymentLink(token)).rejects.toMatchObject({
      code: 'PAYMENT_LINK_ALREADY_USED',
    });
  });

  it('rejects a revoked link', async () => {
    const link = await makeLink();
    const token = await tokenFromOutbox();

    await revokePaymentLink(link.paymentLinkId, adminActor, 'sent to the wrong person');

    await expect(resolvePaymentLink(token)).rejects.toMatchObject({
      code: 'PAYMENT_LINK_REVOKED',
    });
  });

  it('rejects a link once the order is paid another way', async () => {
    await makeLink();
    const token = await tokenFromOutbox();

    await prisma.order.update({ where: { id: orderId }, data: { status: 'CONFIRMED' } });

    await expect(resolvePaymentLink(token)).rejects.toMatchObject({
      code: 'ORDER_ALREADY_PAID',
    });
  });

  /**
   * The amount binding. If the order changed after the link was sent, the payer
   * would otherwise be settling a figure they never approved.
   */
  it('rejects a link whose locked amount no longer matches the order', async () => {
    await makeLink();
    const token = await tokenFromOutbox();

    await prisma.order.update({
      where: { id: orderId },
      data: { grandTotalMinor: 250_000n },
    });

    await expect(resolvePaymentLink(token)).rejects.toMatchObject({
      code: 'PAYMENT_AMOUNT_MISMATCH',
    });
  });
});

describe('revoking and expiring', () => {
  it('cannot revoke twice', async () => {
    const link = await makeLink();
    await revokePaymentLink(link.paymentLinkId, adminActor, 'mistake');

    await expect(
      revokePaymentLink(link.paymentLinkId, adminActor, 'again'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('marks expired links so an admin can see why they stopped working', async () => {
    const link = await makeLink();
    await prisma.paymentLink.update({
      where: { id: link.paymentLinkId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect(await expirePaymentLinks()).toBe(1);

    const row = await prisma.paymentLink.findUniqueOrThrow({ where: { id: link.paymentLinkId } });
    expect(row.revokedReason).toBe('expired');
  });

  it('writes an audit entry for creation and revocation', async () => {
    const link = await makeLink();
    await revokePaymentLink(link.paymentLinkId, adminActor, 'no longer needed');

    expect(await prisma.auditLog.count({ where: { action: 'payment_link.created' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'payment_link.revoked' } })).toBe(1);
  });
});

describe('refund quote', () => {
  it('reports captured, already refunded and the maximum refundable', async () => {
    await prisma.order.update({
      where: { id: orderId },
      data: { paidMinor: 118_000n, refundedMinor: 18_000n },
    });

    const quote = await getRefundQuote(orderId);
    expect(quote.capturedMinor).toBe('118000');
    expect(quote.alreadyRefundedMinor).toBe('18000');
    expect(quote.maxRefundableMinor).toBe('100000');
  });

  /**
   * The quote clamps at zero defensively, but the state it guards against is
   * unreachable: chk_order_refund_within_paid refuses refunded > paid, and
   * paidMinor only ever increments. This asserts the constraint that makes the
   * clamp unnecessary.
   */
  it('cannot be driven negative, because the database refuses the state', async () => {
    await prisma.order.update({ where: { id: orderId }, data: { paidMinor: 10_000n } });

    await expect(
      prisma.order.update({ where: { id: orderId }, data: { refundedMinor: 50_000n } }),
    ).rejects.toBeTruthy();

    expect((await getRefundQuote(orderId)).maxRefundableMinor).toBe('10000');
  });
});

describe('refund validation', () => {
  /**
   * Every case here is rejected BEFORE any provider call, which is exactly
   * where an over-refund has to be stopped.
   */
  const refund = (overrides: Record<string, unknown> = {}) =>
    createRefund({
      orderId,
      reason: 'Customer returned the goods',
      idempotencyKey: newId(),
      actorUserId: adminActor.userId,
      actorEmail: adminActor.email,
      ...overrides,
    });

  it('refuses when there is no captured payment', async () => {
    await expect(refund()).rejects.toMatchObject({ code: 'PAYMENT_NOT_CAPTURED' });
  });

  it('refuses to exceed the captured amount', async () => {
    await prisma.order.update({ where: { id: orderId }, data: { paidMinor: 118_000n } });
    await prisma.paymentTransaction.create({
      data: {
        id: newId(),
        orderId,
        connectionId,
        provider: 'RAZORPAY',
        mode: 'TEST',
        providerPaymentId: 'pay_captured_1',
        status: 'CAPTURED',
        amountMinor: 118_000n,
        capturedMinor: 118_000n,
        currency: 'INR',
        idempotencyKey: newId(),
        capturedAt: new Date(),
      },
    });

    const error = await refund({ amountMinor: '200000' }).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'REFUND_EXCEEDS_CAPTURED' });
    expect((error as { details: { meta?: Record<string, unknown> }[] }).details[0]?.meta).toMatchObject(
      { maxRefundableMinor: '118000', requestedMinor: '200000' },
    );

    // No refund row was created for a request that never should have reached
    // the provider.
    expect(await prisma.refund.count()).toBe(0);
  });

  it('refuses to exceed what remains after an earlier refund', async () => {
    await prisma.order.update({
      where: { id: orderId },
      data: { paidMinor: 118_000n, refundedMinor: 100_000n },
    });
    await prisma.paymentTransaction.create({
      data: {
        id: newId(),
        orderId,
        connectionId,
        provider: 'RAZORPAY',
        mode: 'TEST',
        providerPaymentId: 'pay_captured_1',
        status: 'CAPTURED',
        amountMinor: 118_000n,
        capturedMinor: 118_000n,
        currency: 'INR',
        idempotencyKey: newId(),
        capturedAt: new Date(),
      },
    });

    // 18000 remains; 20000 must be refused.
    await expect(refund({ amountMinor: '20000' })).rejects.toMatchObject({
      code: 'REFUND_EXCEEDS_CAPTURED',
    });
  });

  it('refuses an already fully refunded order', async () => {
    await prisma.order.update({
      where: { id: orderId },
      data: { paidMinor: 118_000n, refundedMinor: 118_000n },
    });
    await prisma.paymentTransaction.create({
      data: {
        id: newId(),
        orderId,
        connectionId,
        provider: 'RAZORPAY',
        mode: 'TEST',
        providerPaymentId: 'pay_captured_1',
        status: 'CAPTURED',
        amountMinor: 118_000n,
        capturedMinor: 118_000n,
        currency: 'INR',
        idempotencyKey: newId(),
        capturedAt: new Date(),
      },
    });

    await expect(refund({ amountMinor: '1' })).rejects.toMatchObject({
      code: 'REFUND_EXCEEDS_CAPTURED',
    });
  });

  it('requires a reason', async () => {
    await expect(refund({ reason: '   ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('rejects a non-integer amount', async () => {
    await expect(refund({ amountMinor: '118.00' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('rejects a zero amount', async () => {
    await prisma.order.update({ where: { id: orderId }, data: { paidMinor: 118_000n } });
    await prisma.paymentTransaction.create({
      data: {
        id: newId(),
        orderId,
        connectionId,
        provider: 'RAZORPAY',
        mode: 'TEST',
        providerPaymentId: 'pay_captured_1',
        status: 'CAPTURED',
        amountMinor: 118_000n,
        capturedMinor: 118_000n,
        currency: 'INR',
        idempotencyKey: newId(),
        capturedAt: new Date(),
      },
    });

    await expect(refund({ amountMinor: '0' })).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });
});

describe('database-level refund guard', () => {
  /**
   * The last line of defence. Even with the service bypassed entirely,
   * chk_order_refund_within_paid must reject an over-refund.
   */
  it('refuses to record a refund larger than the captured amount', async () => {
    await prisma.order.update({ where: { id: orderId }, data: { paidMinor: 100_000n } });

    await expect(
      prisma.order.update({ where: { id: orderId }, data: { refundedMinor: 150_000n } }),
    ).rejects.toBeTruthy();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.refundedMinor).toBe(0n);
  });
});
