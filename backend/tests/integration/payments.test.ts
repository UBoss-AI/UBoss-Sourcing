/**
 * Payments and webhooks - integration, against a real MariaDB.
 *
 * Webhooks are signed here rather than fetched from Razorpay, on purpose:
 *
 *   - Razorpay cannot reach a localhost webhook anyway.
 *   - Signing locally is the only way to test the cases that matter and that a
 *     real provider will never send on demand: a forged signature, a tampered
 *     body, a replayed delivery, an amount that does not match the order.
 *
 * The signing algorithm under test is the real one - HMAC-SHA256 over the raw
 * bytes - so a change to the verification logic fails these tests.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { RazorpayAdapter } from '../../src/modules/payments/razorpay.adapter.js';
import { createOrderPayment, processWebhook } from '../../src/modules/payments/payment.service.js';
import { receiveStock, getAvailability } from '../../src/modules/inventory/inventory.service.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';

const WEBHOOK_SECRET = env.RAZORPAY_WEBHOOK_SECRET;

let customerProfileId: string;
let customerUserId: string;
let productId: string;
let addressId: string;
let adminActor: { userId: string; email: string };

/** Sign a payload exactly as Razorpay does, so verification is really tested. */
function signedWebhook(payload: unknown): {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
} {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  return {
    rawBody,
    headers: {
      'x-razorpay-signature': signature,
      'x-razorpay-event-id': `evt_${newId()}`,
    },
  };
}

function capturedPayload(params: {
  providerOrderId: string;
  paymentId?: string;
  amountMinor: number;
  currency?: string;
}): Record<string, unknown> {
  return {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: params.paymentId ?? `pay_${newId().slice(0, 14)}`,
          order_id: params.providerOrderId,
          amount: params.amountMinor,
          currency: params.currency ?? 'INR',
          status: 'captured',
          method: 'upi',
        },
      },
    },
  };
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
  await prisma.idempotencyRecord.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderApproval.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.numberSequence.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.shippingMethod.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
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
      email: 'admin@pay.test',
      emailNormalized: 'admin@pay.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@pay.test' };

  customerUserId = newId();
  await prisma.user.create({
    data: {
      id: customerUserId,
      type: 'CUSTOMER',
      email: 'buyer@pay.test',
      emailNormalized: 'buyer@pay.test',
      status: 'ACTIVE',
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: customerUserId, fullName: 'Pay Buyer' },
  });
  customerProfileId = profile.id;

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId,
      contactName: 'Pay Buyer',
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
    },
  });
  productId = product.id;

  await receiveStock({ productId, quantity: 100 }, adminActor);
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

/**
 * Place an order and attach a payment transaction, without calling Razorpay.
 *
 * The provider order id is synthetic: these tests exercise OUR webhook and
 * state handling, and a real API call would make them slow and network-bound.
 * The adapter's real API path is covered separately.
 */
async function orderAwaitingPayment(): Promise<{
  orderId: string;
  providerOrderId: string;
  amountMinor: bigint;
}> {
  await addItem(customerProfileId, { productId, quantity: 20 });

  const checkout = await submitCheckout({
    customerProfileId,
    shippingAddressId: addressId,
    paymentMode: 'ONLINE',
    actor: { userId: customerUserId, email: 'buyer@pay.test', type: 'CUSTOMER' },
  });

  // One active TEST connection per provider is a database invariant, so this
  // reuses the existing row when a test needs a second order. Creating
  // unconditionally collided on `uq_payment_connection_provider_mode`.
  const existingConnection = await prisma.paymentProviderConnection.findUnique({
    where: { provider_mode: { provider: 'RAZORPAY', mode: 'TEST' } },
    select: { id: true },
  });

  const connectionId = existingConnection?.id ?? newId();

  if (existingConnection === null) {
    const { encryptSecret } = await import('../../src/infra/crypto.js');

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
        webhookSecretEnc: encryptSecret(WEBHOOK_SECRET, `payment_connection:${connectionId}`),
        isActive: true,
      },
    });
  }

  const order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId } });
  const providerOrderId = `order_${newId().slice(0, 14)}`;

  await prisma.paymentTransaction.create({
    data: {
      id: newId(),
      orderId: order.id,
      connectionId,
      provider: 'RAZORPAY',
      mode: 'TEST',
      providerOrderId,
      status: 'CREATED',
      amountMinor: order.grandTotalMinor,
      currency: order.currency,
      idempotencyKey: newId(),
    },
  });

  return { orderId: order.id, providerOrderId, amountMinor: order.grandTotalMinor };
}

describe('webhook signature verification', () => {
  const adapter = new RazorpayAdapter({
    keyId: 'rzp_test_dummy',
    keySecret: 'dummy_secret',
    webhookSecret: WEBHOOK_SECRET,
  });

  it('accepts a correctly signed payload', () => {
    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId: 'order_abc', amountMinor: 117_280 }),
    );

    const result = adapter.verifyWebhook(rawBody, headers);
    expect(result.verified).toBe(true);
    expect(result.intent).toBe('PAYMENT_CAPTURED');
    expect(result.amountMinor).toBe(117_280n);
  });

  it('rejects a forged signature', () => {
    const { rawBody } = signedWebhook(
      capturedPayload({ providerOrderId: 'order_abc', amountMinor: 117_280 }),
    );

    const result = adapter.verifyWebhook(rawBody, {
      'x-razorpay-signature': 'a'.repeat(64),
    });

    expect(result.verified).toBe(false);
    expect(result.rejectionReason).toBe('signature mismatch');
  });

  it('rejects a missing signature header', () => {
    const { rawBody } = signedWebhook(
      capturedPayload({ providerOrderId: 'order_abc', amountMinor: 117_280 }),
    );

    expect(adapter.verifyWebhook(rawBody, {}).verified).toBe(false);
  });

  /**
   * The attack the raw-body capture exists to stop: altering the amount after
   * signing must invalidate the signature.
   */
  it('rejects a body tampered with after signing', () => {
    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId: 'order_abc', amountMinor: 117_280 }),
    );

    const tampered = Buffer.from(
      rawBody.toString('utf8').replace('117280', '1'),
      'utf8',
    );

    expect(adapter.verifyWebhook(tampered, headers).verified).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const rawBody = Buffer.from(
      JSON.stringify(capturedPayload({ providerOrderId: 'order_abc', amountMinor: 100 })),
      'utf8',
    );
    const wrongSignature = createHmac('sha256', 'not-the-secret').update(rawBody).digest('hex');

    expect(
      adapter.verifyWebhook(rawBody, { 'x-razorpay-signature': wrongSignature }).verified,
    ).toBe(false);
  });

  it('rejects a body that is not JSON, even when correctly signed', () => {
    const rawBody = Buffer.from('this is not json', 'utf8');
    const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

    const result = adapter.verifyWebhook(rawBody, { 'x-razorpay-signature': signature });
    expect(result.verified).toBe(false);
    expect(result.rejectionReason).toBe('body is not valid JSON');
  });

  it('normalises event types to intents', () => {
    const cases: [string, string][] = [
      ['payment.captured', 'PAYMENT_CAPTURED'],
      ['order.paid', 'PAYMENT_CAPTURED'],
      ['payment.failed', 'PAYMENT_FAILED'],
      ['refund.processed', 'REFUND_PROCESSED'],
      ['payment.authorized', 'UNKNOWN'],
    ];

    for (const [eventType, expected] of cases) {
      const { rawBody, headers } = signedWebhook({
        event: eventType,
        payload: {
          payment: {
            entity: { id: 'pay_1', order_id: 'order_1', amount: 100, currency: 'INR', status: 'x' },
          },
        },
      });

      expect(adapter.verifyWebhook(rawBody, headers).intent).toBe(expected);
    }
  });

  it('refuses to verify when no webhook secret is configured', () => {
    const unconfigured = new RazorpayAdapter({
      keyId: 'rzp_test_dummy',
      keySecret: 'dummy',
      webhookSecret: '',
    });

    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId: 'order_abc', amountMinor: 100 }),
    );

    expect(unconfigured.verifyWebhook(rawBody, headers).verified).toBe(false);
  });
});

describe('checkout signature (browser callback)', () => {
  const adapter = new RazorpayAdapter({
    keyId: 'rzp_test_dummy',
    keySecret: 'test_key_secret',
    webhookSecret: WEBHOOK_SECRET,
  });

  it('accepts a genuine checkout signature', () => {
    const expected = createHmac('sha256', 'test_key_secret')
      .update('order_abc|pay_xyz')
      .digest('hex');

    expect(
      adapter.verifyCheckoutSignature({
        razorpayOrderId: 'order_abc',
        razorpayPaymentId: 'pay_xyz',
        razorpaySignature: expected,
      }),
    ).toBe(true);
  });

  it('rejects a forged one', () => {
    expect(
      adapter.verifyCheckoutSignature({
        razorpayOrderId: 'order_abc',
        razorpayPaymentId: 'pay_xyz',
        razorpaySignature: 'b'.repeat(64),
      }),
    ).toBe(false);
  });
});

describe('webhook processing', () => {
  it('confirms the order and commits stock on a verified capture', async () => {
    const { orderId, providerOrderId, amountMinor } = await orderAwaitingPayment();

    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId, amountMinor: Number(amountMinor) }),
    );

    const result = await processWebhook(rawBody, headers);
    expect(result.accepted).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paidMinor).toBe(amountMinor);

    // Stock moved from reserved to deducted.
    const availability = await getAvailability({ productId });
    expect(availability.onHandQty).toBe(80);
    expect(availability.reservedQty).toBe(0);
  });

  /**
   * Razorpay retries webhooks. Without the unique index on providerEventId this
   * would confirm twice and deduct stock twice.
   */
  it('is a no-op on redelivery of the same event', async () => {
    const { orderId, providerOrderId, amountMinor } = await orderAwaitingPayment();
    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId, amountMinor: Number(amountMinor) }),
    );

    const first = await processWebhook(rawBody, headers);
    const second = await processWebhook(rawBody, headers);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    // Paid once, not twice.
    expect(order.paidMinor).toBe(amountMinor);
    expect((await getAvailability({ productId })).onHandQty).toBe(80);
    expect(
      await prisma.inventoryMovement.count({ where: { type: 'RESERVATION_COMMIT' } }),
    ).toBe(1);
  });

  it('survives two concurrent deliveries of the same event', async () => {
    const { orderId, providerOrderId, amountMinor } = await orderAwaitingPayment();
    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId, amountMinor: Number(amountMinor) }),
    );

    await Promise.allSettled([
      processWebhook(rawBody, headers),
      processWebhook(rawBody, headers),
    ]);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paidMinor).toBe(amountMinor);
    expect((await getAvailability({ productId })).onHandQty).toBe(80);
  });

  /** The event says one amount, the order says another. Never confirm. */
  it('refuses a capture whose amount does not match the order', async () => {
    const { orderId, providerOrderId } = await orderAwaitingPayment();

    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId, amountMinor: 1 }),
    );

    const result = await processWebhook(rawBody, headers);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('amount mismatch');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.paidMinor).toBe(0n);

    const event = await prisma.paymentEvent.findFirstOrThrow();
    expect(event.processingStatus).toBe('REJECTED');
  });

  it('refuses a capture in the wrong currency', async () => {
    const { orderId, providerOrderId, amountMinor } = await orderAwaitingPayment();

    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId, amountMinor: Number(amountMinor), currency: 'USD' }),
    );

    const result = await processWebhook(rawBody, headers);
    expect(result.reason).toBe('currency mismatch');

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING_PAYMENT');
  });

  it('records but does not apply an unverified event', async () => {
    const { orderId, providerOrderId, amountMinor } = await orderAwaitingPayment();

    const { rawBody } = signedWebhook(
      capturedPayload({ providerOrderId, amountMinor: Number(amountMinor) }),
    );

    const result = await processWebhook(rawBody, { 'x-razorpay-signature': 'c'.repeat(64) });

    expect(result.accepted).toBe(false);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING_PAYMENT');

    const event = await prisma.paymentEvent.findFirstOrThrow();
    expect(event.signatureVerified).toBe(false);
    expect(event.processingStatus).toBe('REJECTED');
  });

  it('ignores an event for an unknown provider order', async () => {
    await orderAwaitingPayment();

    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId: 'order_doesnotexist', amountMinor: 100 }),
    );

    const result = await processWebhook(rawBody, headers);
    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('no matching payment transaction');
  });

  /**
   * A failed payment must leave the order payable. Cancelling it here would
   * strand the customer's reserved stock and force them to rebuild the cart.
   */
  it('leaves the order payable after a failure', async () => {
    const { orderId, providerOrderId } = await orderAwaitingPayment();

    const { rawBody, headers } = signedWebhook({
      event: 'payment.failed',
      payload: {
        payment: {
          entity: {
            id: 'pay_failed_1',
            order_id: providerOrderId,
            amount: 117_280,
            currency: 'INR',
            status: 'failed',
            error_code: 'BAD_REQUEST_ERROR',
            error_description: 'Payment was declined by the bank.',
          },
        },
      },
    });

    const result = await processWebhook(rawBody, headers);
    expect(result.accepted).toBe(true);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.paidMinor).toBe(0n);

    // The stock stays held so the retry can succeed.
    expect((await getAvailability({ productId })).reservedQty).toBe(20);

    const transaction = await prisma.paymentTransaction.findFirstOrThrow();
    expect(transaction.status).toBe('FAILED');
    expect(transaction.failureCode).toBe('BAD_REQUEST_ERROR');
  });

  it('acknowledges an event type it does not act on', async () => {
    const { providerOrderId } = await orderAwaitingPayment();

    const { rawBody, headers } = signedWebhook({
      event: 'payment.authorized',
      payload: {
        payment: {
          entity: {
            id: 'pay_auth',
            order_id: providerOrderId,
            amount: 117_280,
            currency: 'INR',
            status: 'authorized',
          },
        },
      },
    });

    const result = await processWebhook(rawBody, headers);
    expect(result.accepted).toBe(true);

    const event = await prisma.paymentEvent.findFirstOrThrow();
    expect(event.processingStatus).toBe('PROCESSED');
  });
});

describe('stored credentials', () => {
  it('never stores a key secret in plaintext', async () => {
    await orderAwaitingPayment();

    const connection = await prisma.paymentProviderConnection.findFirstOrThrow();

    expect(connection.credentialsEnc).not.toContain(env.RAZORPAY_KEY_SECRET);
    expect(connection.credentialsEnc.startsWith('v1:')).toBe(true);
    expect(connection.webhookSecretEnc).not.toContain(WEBHOOK_SECRET);
  });

  it('does not leak a signature or secret into the stored event', async () => {
    const { providerOrderId, amountMinor } = await orderAwaitingPayment();
    const { rawBody, headers } = signedWebhook(
      capturedPayload({ providerOrderId, amountMinor: Number(amountMinor) }),
    );

    await processWebhook(rawBody, headers);

    const event = await prisma.paymentEvent.findFirstOrThrow();
    // The raw payload is retained for dispute handling, but the signature
    // header and the secret must not be in it.
    expect(event.rawPayload).not.toContain(WEBHOOK_SECRET);
    expect(event.rawPayload).not.toContain(headers['x-razorpay-signature']);
  });
});

describe('payment session idempotency', () => {
  /**
   * The regression this covers: `payment_transactions.idempotencyKey` is
   * unique, so a retry with the same key collided on insert and the P2002
   * escaped as a 500. The protection was working — no duplicate payment was
   * ever created — but the answer was unusable.
   *
   * It is the ordinary path, not an edge case. A customer whose card is
   * declined presses "try again", and the storefront deliberately reuses the
   * key so a retry cannot become a second payment. Every one of those retries
   * used to hit a 500.
   *
   * These tests never reach the network. That is the point: a replay must be
   * answered from what is already stored, so a retry cannot leave an orphaned
   * order in the gateway's dashboard.
   */
  it('replays the stored session rather than colliding on the unique key', async () => {
    const { orderId, providerOrderId } = await orderAwaitingPayment();

    const stored = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId } });

    const replayed = await createOrderPayment({
      orderId,
      customerProfileId,
      idempotencyKey: stored.idempotencyKey,
      actorUserId: customerUserId,
      correlationId: null,
    });

    expect(replayed.paymentTransactionId).toBe(stored.id);
    expect(replayed.providerOrderId).toBe(providerOrderId);
    expect(replayed.amount.minor).toBe(stored.amountMinor.toString());
  });

  it('creates no second payment row however many times it is retried', async () => {
    const { orderId } = await orderAwaitingPayment();
    const stored = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId } });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await createOrderPayment({
        orderId,
        customerProfileId,
        idempotencyKey: stored.idempotencyKey,
        actorUserId: customerUserId,
        correlationId: null,
      });
    }

    const count = await prisma.paymentTransaction.count({ where: { orderId } });
    expect(count).toBe(1);
  });

  it('rebuilds a checkout payload carrying the publishable key and no secret', async () => {
    const { orderId } = await orderAwaitingPayment();
    const stored = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId } });

    const replayed = await createOrderPayment({
      orderId,
      customerProfileId,
      idempotencyKey: stored.idempotencyKey,
      actorUserId: customerUserId,
      correlationId: null,
    });

    // The browser needs the publishable key id to open the provider's sheet.
    // The secret must never be within reach of it.
    expect(String(replayed.checkoutPayload.key)).toMatch(/^rzp_(test|live)_/);
    expect(JSON.stringify(replayed.checkoutPayload)).not.toContain(env.RAZORPAY_KEY_SECRET);
    expect(replayed.checkoutPayload.order_id).toBe(stored.providerOrderId);
  });

  it('refuses a key already used against a different order', async () => {
    const first = await orderAwaitingPayment();
    const stored = await prisma.paymentTransaction.findFirstOrThrow({
      where: { orderId: first.orderId },
    });

    const second = await orderAwaitingPayment();

    // Replaying the first order's session here would hand one order's payment
    // to another. A client bug must not become a data leak.
    await expect(
      createOrderPayment({
        orderId: second.orderId,
        customerProfileId,
        idempotencyKey: stored.idempotencyKey,
        actorUserId: customerUserId,
        correlationId: null,
      }),
    ).rejects.toThrow(/already been used for a different order/i);
  });
});
