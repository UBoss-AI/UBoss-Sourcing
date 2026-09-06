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
import {
  availableGateways,
  createOrderPayment,
  loadActiveProvider,
  processWebhook,
} from '../../src/modules/payments/payment.service.js';
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

describe('gateway selection', () => {
  /**
   * Connect a gateway the way an administrator would, so `loadActiveProvider`
   * is exercised against real stored credentials rather than a stub.
   *
   * `updatedAt` matters: with no preference the resolver takes the most
   * recently touched connection, and a test that wrote both in the same
   * millisecond would pass or fail on row order.
   */
  async function connect(provider: 'RAZORPAY' | 'STRIPE'): Promise<string> {
    const { encryptSecret } = await import('../../src/infra/crypto.js');
    const id = newId();

    const keyId = provider === 'RAZORPAY' ? env.RAZORPAY_KEY_ID : env.STRIPE_PUBLISHABLE_KEY;
    const keySecret = provider === 'RAZORPAY' ? env.RAZORPAY_KEY_SECRET : env.STRIPE_SECRET_KEY;

    await prisma.paymentProviderConnection.create({
      data: {
        id,
        provider,
        mode: 'TEST',
        label: `${provider} test connection`,
        credentialsEnc: encryptSecret(
          JSON.stringify({ keyId, keySecret }),
          `payment_connection:${id}`,
        ),
        webhookSecretEnc: encryptSecret(WEBHOOK_SECRET, `payment_connection:${id}`),
        isActive: true,
      },
    });

    return id;
  }

  it('gives the customer the gateway they asked for', async () => {
    await connect('RAZORPAY');
    await connect('STRIPE');

    await expect(loadActiveProvider('STRIPE')).resolves.toMatchObject({ kind: 'STRIPE' });
    await expect(loadActiveProvider('RAZORPAY')).resolves.toMatchObject({ kind: 'RAZORPAY' });
  });

  /**
   * The rule that keeps a preference from becoming an instruction.
   *
   * A storefront can be stale — a gateway it offered a minute ago may have
   * been deactivated since. Honouring the request literally would mean
   * decrypting credentials that are not there and failing the checkout, which
   * is a worse answer than quietly taking the payment through the gateway the
   * operator does have.
   */
  it('falls back rather than failing when the asked-for gateway is not connected', async () => {
    await connect('RAZORPAY');

    await expect(loadActiveProvider('STRIPE')).resolves.toMatchObject({ kind: 'RAZORPAY' });
  });

  it('still resolves a gateway when the customer expressed no preference', async () => {
    await connect('STRIPE');

    await expect(loadActiveProvider()).resolves.toMatchObject({ kind: 'STRIPE' });
  });

  it('offers no gateway that has been deactivated', async () => {
    const stripeId = await connect('STRIPE');
    await connect('RAZORPAY');

    await prisma.paymentProviderConnection.update({
      where: { id: stripeId },
      data: { isActive: false },
    });

    await expect(loadActiveProvider('STRIPE')).resolves.toMatchObject({ kind: 'RAZORPAY' });
  });
});

describe('gateways offered at checkout', () => {
  it('names UPI only for the gateway that can settle it', async () => {
    const { gateways } = await availableGateways();

    const razorpay = gateways.find((entry) => entry.provider === 'RAZORPAY');
    const stripe = gateways.find((entry) => entry.provider === 'STRIPE');

    expect(razorpay?.methods).toContain('UPI');
    expect(stripe?.methods).not.toContain('UPI');
  });

  /**
   * Razorpay settles to an Indian account. Offering it for a euro cart would
   * put a gateway in front of the customer that declines after they have
   * chosen it — the storefront filters on this, and it is only correct if the
   * restriction is actually reported.
   */
  it('reports the currencies each gateway may be offered for', async () => {
    const { gateways } = await availableGateways();

    expect(gateways.find((entry) => entry.provider === 'RAZORPAY')?.currencies).toStrictEqual([
      'INR',
    ]);
    // Stripe settles many currencies; no restriction is the honest answer.
    expect(gateways.find((entry) => entry.provider === 'STRIPE')?.currencies).toBeNull();
  });

  it('preselects a gateway that is actually on offer', async () => {
    const { gateways, defaultProvider } = await availableGateways();

    expect(defaultProvider).not.toBeNull();
    expect(gateways.map((entry) => entry.provider)).toContain(defaultProvider);
  });

  it('carries no credential into the offer', async () => {
    const serialised = JSON.stringify(await availableGateways());

    expect(serialised).not.toContain(env.RAZORPAY_KEY_SECRET);
    expect(serialised).not.toContain(env.STRIPE_SECRET_KEY);
    expect(serialised).not.toContain(WEBHOOK_SECRET);
  });
});

describe('the gateway choice survives the checkout', () => {
  /**
   * The bug this exists to prevent: the pick used to travel only in the
   * browser's navigation state, so reloading the payment page — or opening the
   * order again from an email an hour later — silently dropped it and put the
   * customer on the default gateway. Nobody was charged wrongly, but somebody
   * who chose UPI was shown a card form and had no idea why.
   */
  async function checkoutWith(choice: {
    preferredPaymentProvider?: 'RAZORPAY' | 'STRIPE';
    preferredPaymentMethod?: 'ANY' | 'UPI';
    paymentMode?: 'ONLINE' | 'PAYMENT_LINK';
  }): Promise<string> {
    await addItem(customerProfileId, { productId, quantity: 20 });

    const checkout = await submitCheckout({
      customerProfileId,
      shippingAddressId: addressId,
      paymentMode: choice.paymentMode ?? 'ONLINE',
      ...(choice.preferredPaymentProvider === undefined
        ? {}
        : { preferredPaymentProvider: choice.preferredPaymentProvider }),
      ...(choice.preferredPaymentMethod === undefined
        ? {}
        : { preferredPaymentMethod: choice.preferredPaymentMethod }),
      actor: { userId: customerUserId, email: 'buyer@pay.test', type: 'CUSTOMER' },
    });

    return checkout.orderId;
  }

  it('records what the customer picked', async () => {
    const orderId = await checkoutWith({
      preferredPaymentProvider: 'RAZORPAY',
      preferredPaymentMethod: 'UPI',
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    expect(order.preferredPaymentProvider).toBe('RAZORPAY');
    expect(order.preferredPaymentMethod).toBe('UPI');
  });

  it('records nothing when the customer was offered no choice', async () => {
    const order = await prisma.order.findUniqueOrThrow({ where: { id: await checkoutWith({}) } });

    // Null rather than a default: an order nobody chose for must not read back
    // as though somebody had.
    expect(order.preferredPaymentProvider).toBeNull();
    expect(order.preferredPaymentMethod).toBeNull();
  });

  /**
   * A payment link is sent, not opened. Which gateway is behind it is the
   * operator's business, so a preference against one would be an answer to a
   * question the customer was never asked.
   */
  it('records nothing against an order paid by link', async () => {
    const orderId = await checkoutWith({
      paymentMode: 'PAYMENT_LINK',
      preferredPaymentProvider: 'RAZORPAY',
      preferredPaymentMethod: 'UPI',
    });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

    expect(order.preferredPaymentProvider).toBeNull();
    expect(order.preferredPaymentMethod).toBeNull();
  });

  it('is readable without the browser having to remember it', async () => {
    const orderId = await checkoutWith({
      preferredPaymentProvider: 'RAZORPAY',
      preferredPaymentMethod: 'UPI',
    });

    // What a reloaded payment page relies on: the choice is on the order, so a
    // session request that names no gateway can still be answered with the one
    // the customer picked.
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { preferredPaymentProvider: true, preferredPaymentMethod: true },
    });

    expect(order).toStrictEqual({
      preferredPaymentProvider: 'RAZORPAY',
      preferredPaymentMethod: 'UPI',
    });
  });
});

describe('the offer matches what resolution can deliver', () => {
  async function connectAs(provider: 'RAZORPAY' | 'STRIPE', isActive: boolean): Promise<void> {
    const { encryptSecret } = await import('../../src/infra/crypto.js');
    const id = newId();

    const keyId = provider === 'RAZORPAY' ? env.RAZORPAY_KEY_ID : env.STRIPE_PUBLISHABLE_KEY;
    const keySecret = provider === 'RAZORPAY' ? env.RAZORPAY_KEY_SECRET : env.STRIPE_SECRET_KEY;

    await prisma.paymentProviderConnection.create({
      data: {
        id,
        provider,
        mode: 'TEST',
        label: `${provider} test connection`,
        credentialsEnc: encryptSecret(
          JSON.stringify({ keyId, keySecret }),
          `payment_connection:${id}`,
        ),
        credentialsMask: 'masked',
        isActive,
      },
    });
  }

  /**
   * The bug this covers, found by running the flow rather than by reading it.
   *
   * `availableGateways` used to merge the environment keys into the connected
   * set unconditionally. On a machine whose Razorpay connection had been
   * deactivated but whose .env still held Razorpay keys, checkout offered
   * Razorpay and UPI, the customer chose them, and the payment quietly went
   * through Stripe — because `loadActiveProvider` reaches for the environment
   * only when NO active connection exists, and a Stripe one did.
   *
   * The customer saw a card form after asking for UPI, and nothing explained
   * why. So the rule under test is the invariant, not the symptom: every
   * gateway offered must be one resolution would actually return.
   */
  it('does not offer a gateway whose connection an administrator deactivated', async () => {
    await connectAs('STRIPE', true);
    await connectAs('RAZORPAY', false);

    const { gateways } = await availableGateways();

    expect(gateways.map((entry) => entry.provider)).toStrictEqual(['STRIPE']);
  });

  it('offers only gateways that resolution would actually return', async () => {
    await connectAs('STRIPE', true);
    await connectAs('RAZORPAY', false);

    const { gateways } = await availableGateways();

    // The invariant stated directly: ask for each offered gateway and check
    // that is the one that comes back.
    for (const entry of gateways) {
      const resolved = await loadActiveProvider(entry.provider);
      expect(resolved.kind).toBe(entry.provider);
    }
  });

  it('falls back to environment keys only when nothing is connected', async () => {
    // No connection rows at all: the local-development path, where the .env
    // gateways are genuinely reachable.
    const { gateways, defaultProvider } = await availableGateways();

    expect(gateways.length).toBeGreaterThan(0);
    expect(defaultProvider).not.toBeNull();

    // Only one resolution is asserted, deliberately. Resolving through the
    // environment path bootstraps a connection row as a side effect, so a
    // second call in this test would be answered from the database and would
    // be testing the previous line rather than this one.
    const resolved = await loadActiveProvider(defaultProvider ?? undefined);
    expect(resolved.kind).toBe(defaultProvider);
  });

  it('never preselects a gateway it did not offer', async () => {
    await connectAs('STRIPE', true);
    await connectAs('RAZORPAY', false);

    const { gateways, defaultProvider } = await availableGateways();

    expect(gateways.map((entry) => entry.provider)).toContain(defaultProvider);
  });
});
