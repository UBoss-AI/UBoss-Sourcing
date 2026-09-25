/**
 * Stripe-hosted Checkout, end to end against a real MariaDB and a fake Stripe.
 *
 * Stripe cannot reach a laptop, and the cases that matter are the ones a real
 * Stripe will not produce on demand: two tabs at once, a webhook overtaking
 * its own session event, a delivery repeated, a signature forged, a session
 * that timed out mid-create. So Stripe's API is a small in-memory fake that
 * honours idempotency keys exactly as Stripe does, and every webhook is signed
 * here with the real algorithm over the raw bytes.
 *
 * Each block names the property it protects. The headline ones:
 *
 *   · One order, one open Stripe page - however many clicks, tabs or retries.
 *   · The amount Stripe is asked for is the order's, never the browser's.
 *   · The order is confirmed exactly once, only by Stripe's signed word or
 *     Stripe's API asked by the server - never by the customer's return.
 *   · A card is kept only when the customer ticked Stripe's box, against THEIR
 *     Stripe Customer, and that consent never becomes an auto-pay mandate.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { ROLE_DEFINITIONS, Role } from '../../src/domain/permissions.js';
import { readOrderItemSnapshot } from '../../src/domain/order-item-snapshot.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';
import {
  assertChargeable,
  removePaymentMethod,
} from '../../src/modules/payments/payment-method.service.js';
import {
  createOrderPayment,
  processWebhook,
  reconcilePayment,
} from '../../src/modules/payments/payment.service.js';
import {
  CHECKOUT_SESSION_MINUTES,
  cancelOpenCheckout,
  getCheckoutConfirmation,
  refreshCheckoutConfirmation,
} from '../../src/modules/payments/stripe-checkout.service.js';

const PASSWORD = 'CheckoutTestPass!2026';

// ---------------------------------------------------------------------------
// A fake Stripe
// ---------------------------------------------------------------------------

interface FakeSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid';
  expires_at: number;
  amount_total: number;
  currency: string;
  client_reference_id: string | null;
  customer: string | null;
  metadata: Record<string, string>;
  payment_intent: string | null;
  /** What we were sent, for assertions. */
  form: URLSearchParams;
}

interface FakeIntent {
  id: string;
  amount: number;
  amount_received: number;
  currency: string;
  status: string;
  latest_charge: string;
  payment_method: string;
  metadata: Record<string, string>;
}

interface FakeMethod {
  id: string;
  type: string;
  customer: string | null;
  allow_redisplay: string;
  card: { brand: string; last4: string; exp_month: number; exp_year: number; funding: string; country: string };
}

class FakeStripe {
  sessions = new Map<string, FakeSession>();
  intents = new Map<string, FakeIntent>();
  methods = new Map<string, FakeMethod>();
  customers: string[] = [];
  deletedCustomers: string[] = [];
  /** Idempotency key -> the response body Stripe stored for it. */
  replays = new Map<string, unknown>();
  /** Every session-create request, including replays. */
  sessionCreates = 0;
  /** Make the next session create hang up after Stripe has created it. */
  timeoutNextCreate = false;
  /** Make the next session create refuse the customer, as for a deleted one. */
  missingCustomerOnce = false;

  private json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  private error(status: number, code: string, message: string): Response {
    return this.json({ error: { type: 'invalid_request_error', code, message } }, status);
  }

  private sessionBody(session: FakeSession, expand: boolean): Record<string, unknown> {
    const intent = session.payment_intent === null ? null : this.intents.get(session.payment_intent);

    return {
      id: session.id,
      object: 'checkout.session',
      url: session.status === 'open' ? session.url : null,
      status: session.status,
      payment_status: session.payment_status,
      expires_at: session.expires_at,
      amount_total: session.amount_total,
      currency: session.currency,
      client_reference_id: session.client_reference_id,
      customer: session.customer,
      metadata: session.metadata,
      payment_intent:
        intent === undefined || intent === null
          ? null
          : expand
            ? {
                ...intent,
                latest_charge: {
                  id: intent.latest_charge,
                  amount: intent.amount,
                  currency: intent.currency,
                  payment_method_details: { type: 'card' },
                },
                payment_method: this.methods.get(intent.payment_method) ?? null,
              }
            : intent.id,
    };
  }

  handle(input: string | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const method = init?.method ?? 'GET';
    const form = new URLSearchParams(typeof init?.body === 'string' ? init.body : '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const key = headers['Idempotency-Key'];
    const path = url.pathname.replace(/^\/v1/, '');

    if (url.hostname !== 'api.stripe.com') {
      return Promise.reject(new Error(`unexpected fetch: ${url.toString()}`));
    }

    // Stripe's own idempotency: the same key returns the stored response.
    if (method === 'POST' && key !== undefined && this.replays.has(key)) {
      if (path === '/checkout/sessions') this.sessionCreates += 1;
      return Promise.resolve(this.json(this.replays.get(key)));
    }

    if (method === 'POST' && path === '/customers') {
      const id = `cus_test_${String(this.customers.length + 1)}`;
      this.customers.push(id);
      const body = { id, email: form.get('email') };
      if (key !== undefined) this.replays.set(key, body);
      return Promise.resolve(this.json(body));
    }

    if (method === 'DELETE' && path.startsWith('/customers/')) {
      this.deletedCustomers.push(path.split('/')[2] ?? '');
      return Promise.resolve(this.json({ deleted: true }));
    }

    if (method === 'POST' && path === '/checkout/sessions') {
      this.sessionCreates += 1;

      if (this.missingCustomerOnce && form.get('customer') !== null) {
        this.missingCustomerOnce = false;
        return Promise.resolve(
          this.error(400, 'resource_missing', `No such customer: '${form.get('customer') ?? ''}'`),
        );
      }

      const id = `cs_test_${randomBytes(12).toString('hex')}`;
      const session: FakeSession = {
        id,
        url: `https://checkout.stripe.com/c/pay/${id}#fidkdWxOYHwnPyd1blpxYHZxWjA`,
        status: 'open',
        payment_status: 'unpaid',
        expires_at: Number(form.get('expires_at')),
        amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
        currency: form.get('line_items[0][price_data][currency]') ?? '',
        client_reference_id: form.get('client_reference_id'),
        customer: form.get('customer'),
        metadata: {
          uboss_payment_transaction_id: form.get('metadata[uboss_payment_transaction_id]') ?? '',
        },
        payment_intent: null,
        form,
      };
      this.sessions.set(id, session);

      const body = this.sessionBody(session, false);
      if (key !== undefined) this.replays.set(key, body);

      if (this.timeoutNextCreate) {
        this.timeoutNextCreate = false;
        const abort = new Error('The operation was aborted');
        abort.name = 'AbortError';
        return Promise.reject(abort);
      }

      return Promise.resolve(this.json(body));
    }

    const sessionMatch = /^\/checkout\/sessions\/([^/]+)(\/expire)?$/.exec(path);
    if (sessionMatch !== null) {
      const session = this.sessions.get(sessionMatch[1] ?? '');
      if (session === undefined) return Promise.resolve(this.error(404, 'resource_missing', 'No such session'));

      if (sessionMatch[2] === '/expire') {
        if (session.status !== 'open') {
          return Promise.resolve(
            this.error(400, 'checkout_session_not_open', 'Only open sessions can be expired.'),
          );
        }
        session.status = 'expired';
      }

      return Promise.resolve(this.json(this.sessionBody(session, url.searchParams.has('expand[0]'))));
    }

    const methodMatch = /^\/payment_methods\/([^/]+)$/.exec(path);
    if (methodMatch !== null) {
      const found = this.methods.get(methodMatch[1] ?? '');
      if (found === undefined) {
        return Promise.resolve(this.error(404, 'resource_missing', 'No such PaymentMethod'));
      }
      if (method === 'POST') found.allow_redisplay = form.get('allow_redisplay') ?? found.allow_redisplay;
      return Promise.resolve(this.json(found));
    }

    return Promise.reject(new Error(`fake Stripe has no route for ${method} ${path}`));
  }

  /**
   * The customer completes Stripe's page.
   *
   * `saveCard` is Stripe's own tickbox: ticked, the card is attached to the
   * session's Customer with allow_redisplay 'always'; left empty, it is
   * attached to nobody - exactly Checkout's behaviour.
   */
  pay(
    sessionId: string,
    options: { saveCard?: boolean; last4?: string; paymentStatus?: 'paid' | 'unpaid' } = {},
  ): { intent: FakeIntent; method: FakeMethod; session: FakeSession } {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new Error('no such session');

    const methodId = `pm_test_${randomBytes(6).toString('hex')}`;
    const method: FakeMethod = {
      id: methodId,
      type: 'card',
      customer: options.saveCard === true ? session.customer : null,
      allow_redisplay: options.saveCard === true ? 'always' : 'unspecified',
      card: {
        brand: 'visa',
        last4: options.last4 ?? '4242',
        exp_month: 12,
        exp_year: 2031,
        funding: 'credit',
        country: 'IN',
      },
    };
    this.methods.set(methodId, method);

    const paid = (options.paymentStatus ?? 'paid') === 'paid';
    const intent: FakeIntent = {
      id: `pi_test_${randomBytes(6).toString('hex')}`,
      amount: session.amount_total,
      amount_received: paid ? session.amount_total : 0,
      currency: session.currency,
      status: paid ? 'succeeded' : 'processing',
      latest_charge: `ch_test_${randomBytes(6).toString('hex')}`,
      payment_method: methodId,
      metadata: { uboss_payment_transaction_id: session.client_reference_id ?? '' },
    };
    this.intents.set(intent.id, intent);

    session.status = 'complete';
    session.payment_status = paid ? 'paid' : 'unpaid';
    session.payment_intent = intent.id;

    return { intent, method, session };
  }
}

let stripe: FakeStripe;

/** Sign an event exactly as Stripe does. */
function signed(type: string, object: Record<string, unknown>, eventId = `evt_${newId()}`): {
  rawBody: Buffer;
  headers: Record<string, string | undefined>;
} {
  const rawBody = Buffer.from(JSON.stringify({ id: eventId, type, data: { object } }), 'utf8');
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', env.STRIPE_WEBHOOK_SECRET)
    .update(`${String(timestamp)}.`)
    .update(rawBody)
    .digest('hex');

  return { rawBody, headers: { 'stripe-signature': `t=${String(timestamp)},v1=${signature}` } };
}

function deliver(type: string, object: Record<string, unknown>, eventId?: string): ReturnType<typeof processWebhook> {
  const { rawBody, headers } = signed(type, object, eventId);
  return processWebhook(rawBody, headers, undefined, 'STRIPE');
}

function sessionObject(session: FakeSession): Record<string, unknown> {
  return {
    id: session.id,
    object: 'checkout.session',
    status: session.status,
    payment_status: session.payment_status,
    amount_total: session.amount_total,
    currency: session.currency,
    client_reference_id: session.client_reference_id,
    customer: session.customer,
    metadata: session.metadata,
    payment_intent: session.payment_intent,
  };
}

function intentObject(intent: FakeIntent, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...intent, object: 'payment_intent', ...overrides };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let app: Awaited<ReturnType<typeof buildApp>>;
let productId: string;
let adminActor: { userId: string; email: string };

interface Buyer {
  userId: string;
  profileId: string;
  addressId: string;
  email: string;
  cookies: string;
  csrfToken: string;
}

async function reset(): Promise<void> {
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
  await prisma.customerAutoPaySetting.deleteMany({});
  await prisma.customerPaymentMethod.deleteMany({});
  await prisma.paymentProviderCustomer.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.shippingMethod.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
  await prisma.businessProfile.deleteMany({});
}

async function createBuyer(email: string): Promise<Buyer> {
  const role = await prisma.role.findUniqueOrThrow({ where: { key: Role.CUSTOMER } });
  const userId = newId();

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: role.id } },
    },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Asha Rao', activatedAt: new Date() },
  });

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId: profile.id,
      contactName: 'Asha Rao',
      contactPhone: '+91 90000 00000',
      line1: '12 MG Road',
      city: 'Bengaluru',
      state: 'KA',
      postalCode: '560001',
      country: 'IN',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const jar = signIn.cookies as { name: string; value: string }[];

  return {
    userId,
    profileId: profile.id,
    addressId: address.id,
    email,
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
}

async function placeOrder(buyer: Buyer, quantity = 20): Promise<{ orderId: string; totalMinor: bigint }> {
  await addItem(buyer.profileId, { productId, quantity });

  const checkout = await submitCheckout({
    customerProfileId: buyer.profileId,
    shippingAddressId: buyer.addressId,
    paymentMode: 'ONLINE',
    actor: { userId: buyer.userId, email: buyer.email, type: 'CUSTOMER' },
  });

  const order = await prisma.order.findUniqueOrThrow({ where: { id: checkout.orderId } });
  return { orderId: order.id, totalMinor: order.grandTotalMinor };
}

function openCheckout(buyer: Buyer, orderId: string): ReturnType<typeof createOrderPayment> {
  return createOrderPayment({
    orderId,
    customerProfileId: buyer.profileId,
    idempotencyKey: newId(),
    actorUserId: buyer.userId,
    preferredProvider: 'STRIPE',
  });
}

function sessionIdOf(result: { checkoutSessionId?: string | null }): string {
  if (typeof result.checkoutSessionId !== 'string') throw new Error('no session');
  return result.checkoutSessionId;
}

let buyer: Buyer;

beforeEach(async () => {
  stripe = new FakeStripe();
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit) => stripe.handle(input, init));

  app = await buildApp();
  await app.ready();
  await reset();

  for (const definition of ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        id: newId(),
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
    });
  }

  await prisma.businessProfile.create({
    data: {
      id: newId(),
      legalName: 'Glovia Test',
      displayName: 'Glovia',
      supportEmail: 'support@test.local',
      currency: 'INR',
      timezone: 'Asia/Kolkata',
      orderPrefix: 'GL',
    },
  });

  const adminId = newId();
  await prisma.user.create({
    data: {
      id: adminId,
      type: 'ADMIN',
      email: 'admin@checkout.test',
      emailNormalized: 'admin@checkout.test',
      status: 'ACTIVE',
    },
  });
  adminActor = { userId: adminId, email: 'admin@checkout.test' };

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
    data: { id: newId(), name: 'Gloves', slug: 'gloves', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Nitrile gloves',
      slug: 'nitrile-gloves',
      sku: 'GLV-N-M',
      shortDescription: 'Box of 100',
      basePriceMinor: 9_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
      minOrderQty: 1,
    },
  });
  productId = product.id;

  await receiveStock({ productId, quantity: 100 }, adminActor);

  buyer = await createBuyer('asha@checkout.test');
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
});

afterAll(async () => {
  await reset();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Opening a session
// ---------------------------------------------------------------------------

describe('opening Stripe Checkout', () => {
  it('freezes what was ordered in the checkout transaction itself', async () => {
    const { orderId } = await placeOrder(buyer);
    const items = await prisma.orderItem.findMany({
      where: { orderId },
      select: { nameSnapshot: true, productInfoSnapshotJson: true, productInfoCapturedAt: true },
    });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      const snapshot = readOrderItemSnapshot(item.productInfoSnapshotJson);
      expect(snapshot?.productName).toBe(item.nameSnapshot);
      expect(item.productInfoCapturedAt).not.toBeNull();
    }
  });

  it('asks Stripe for the order’s own total, on the customer’s own Stripe record', async () => {
    const { orderId, totalMinor } = await placeOrder(buyer);

    const result = await openCheckout(buyer, orderId);

    expect(result.next).toBe('REDIRECT');
    expect(result.redirectUrl).toMatch(/^https:\/\/checkout\.stripe\.com\/c\/pay\/cs_test_/);

    const session = stripe.sessions.get(sessionIdOf(result));
    expect(session?.form.get('line_items[0][price_data][unit_amount]')).toBe(totalMinor.toString());
    expect(session?.form.get('line_items[0][price_data][currency]')).toBe('inr');
    expect(session?.form.get('mode')).toBe('payment');
    expect(session?.form.get('customer')).toBe('cus_test_1');
    expect(session?.form.get('saved_payment_method_options[payment_method_save]')).toBe('enabled');
    expect(session?.form.get('payment_intent_data[setup_future_usage]')).toBeNull();
    expect(session?.form.get('success_url')).toMatch(
      new RegExp(`/checkout/payment/${orderId}/confirmation\\?session_id=\\{CHECKOUT_SESSION_ID\\}$`),
    );

    const attempt = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: result.paymentTransactionId },
    });
    expect(attempt).toMatchObject({
      status: 'CREATED',
      provider: 'STRIPE',
      mode: 'TEST',
      amountMinor: totalMinor,
      currency: 'INR',
      openAttemptKey: orderId,
      providerSessionId: sessionIdOf(result),
    });
    // Minted by the server, never by the browser.
    expect(attempt.idempotencyKey).toBe(`stripe-checkout:${attempt.id}`);
  });

  it('files one Stripe Customer per person, and one person per Stripe Customer', async () => {
    const { orderId } = await placeOrder(buyer);
    await openCheckout(buyer, orderId);

    const rows = await prisma.paymentProviderCustomer.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      customerProfileId: buyer.profileId,
      provider: 'STRIPE',
      mode: 'TEST',
      providerCustomerId: 'cus_test_1',
    });
  });

  it('holds the order’s stock for as long as Stripe’s page can take money', async () => {
    const { orderId } = await placeOrder(buyer);
    const before = Date.now();

    await openCheckout(buyer, orderId);

    const reservation = await prisma.stockReservation.findFirstOrThrow({
      where: { orderId, status: 'ACTIVE' },
    });
    expect(reservation.expiresAt.getTime()).toBeGreaterThan(before + CHECKOUT_SESSION_MINUTES * 60_000);
  });

  it('holds the same stock again when the first hold lapsed while the customer was away', async () => {
    const { orderId } = await placeOrder(buyer, 20);

    // The twenty-minute hold from placing the order has run out and been swept.
    await prisma.stockReservation.updateMany({
      where: { orderId },
      data: { status: 'RELEASED', releaseReason: 'reservation_expired', releasedAt: new Date() },
    });
    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { reservedQty: 0 } });

    await openCheckout(buyer, orderId);

    const active = await prisma.stockReservation.findMany({ where: { orderId, status: 'ACTIVE' } });
    expect(active).toHaveLength(1);
    expect(active[0]?.quantity).toBe(20);
  });

  it('refuses to open a page when the lapsed stock has since been sold', async () => {
    const { orderId } = await placeOrder(buyer, 20);

    await prisma.stockReservation.updateMany({
      where: { orderId },
      data: { status: 'RELEASED', releaseReason: 'reservation_expired', releasedAt: new Date() },
    });
    // Somebody else bought everything in the meantime.
    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { reservedQty: 100 } });

    await expect(openCheckout(buyer, orderId)).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    expect(stripe.sessionCreates).toBe(0);

    const attempt = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId } });
    expect(attempt).toMatchObject({ status: 'FAILED', openAttemptKey: null });
  });
});

describe('one order, one Stripe page', () => {
  it('hands a double click the same page, and asks Stripe once', async () => {
    const { orderId } = await placeOrder(buyer);

    // Both settle before the test ends, so neither can leak into the next one.
    const outcomes = await Promise.allSettled([
      openCheckout(buyer, orderId),
      openCheckout(buyer, orderId),
    ]);

    const opened = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value.checkoutSessionId] : [],
    );
    const refused = outcomes.flatMap((outcome) =>
      outcome.status === 'rejected' ? [outcome.reason as { code?: string }] : [],
    );

    // Either the same page twice, or one page and one "one moment" - never two.
    expect(opened.length).toBeGreaterThan(0);
    expect(new Set(opened).size).toBe(1);
    for (const reason of refused) expect(reason.code).toBe('PAYMENT_ATTEMPT_IN_PROGRESS');

    expect(stripe.sessions.size).toBe(1);
    expect(await prisma.paymentTransaction.count({ where: { orderId } })).toBe(1);
  });

  it('hands a second tab - with its own request key - the page the first opened', async () => {
    const { orderId } = await placeOrder(buyer);

    const first = await openCheckout(buyer, orderId);
    const second = await openCheckout(buyer, orderId);

    expect(second.checkoutSessionId).toBe(first.checkoutSessionId);
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(stripe.sessionCreates).toBe(1);
  });

  it('survives a timeout mid-create without ever showing two pages', async () => {
    const { orderId } = await placeOrder(buyer);

    stripe.timeoutNextCreate = true;
    await expect(openCheckout(buyer, orderId)).rejects.toMatchObject({ code: 'PAYMENT_PROVIDER_ERROR' });

    // Stripe did create it; nobody was told its address. The slot stays held...
    const stuck = await prisma.paymentTransaction.findFirstOrThrow({ where: { orderId } });
    expect(stuck.openAttemptKey).toBe(orderId);

    // ...so an immediate retry is told to wait rather than handed a second page.
    await expect(openCheckout(buyer, orderId)).rejects.toMatchObject({
      code: 'PAYMENT_ATTEMPT_IN_PROGRESS',
    });

    // Once it is clearly abandoned, it is closed and a fresh page is opened.
    await prisma.paymentTransaction.update({
      where: { id: stuck.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    const retried = await openCheckout(buyer, orderId);
    expect(retried.next).toBe('REDIRECT');

    const attempts = await prisma.paymentTransaction.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
    });
    expect(attempts.map((attempt) => attempt.status)).toEqual(['FAILED', 'CREATED']);
    expect(attempts.filter((attempt) => attempt.openAttemptKey !== null)).toHaveLength(1);
  });

  it('opens a fresh page when the customer comes back after Stripe closed the old one', async () => {
    const { orderId } = await placeOrder(buyer);

    const first = await openCheckout(buyer, orderId);
    const old = stripe.sessions.get(sessionIdOf(first));
    if (old !== undefined) old.status = 'expired';

    const second = await openCheckout(buyer, orderId);

    expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId);
    const closed = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: first.paymentTransactionId },
    });
    expect(closed).toMatchObject({ status: 'EXPIRED', openAttemptKey: null });
  });

  it('does not open a second page for an order already paid in another tab', async () => {
    const { orderId } = await placeOrder(buyer);

    const first = await openCheckout(buyer, orderId);
    stripe.pay(sessionIdOf(first));

    const second = await openCheckout(buyer, orderId);

    expect(second.next).toBe('AWAIT_CONFIRMATION');
    expect(stripe.sessions.size).toBe(1);
    // And what Stripe said was applied: the order is paid, once.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paidMinor).toBe(order.grandTotalMinor);
  });

  it('opens a new Stripe Customer when the filed one was deleted at Stripe', async () => {
    const { orderId } = await placeOrder(buyer);
    await prisma.paymentProviderCustomer.create({
      data: {
        id: newId(),
        customerProfileId: buyer.profileId,
        provider: 'STRIPE',
        mode: 'TEST',
        providerCustomerId: 'cus_deleted_in_dashboard',
      },
    });

    stripe.missingCustomerOnce = true;
    const result = await openCheckout(buyer, orderId);

    expect(result.next).toBe('REDIRECT');
    const filed = await prisma.paymentProviderCustomer.findMany({});
    expect(filed.map((row) => row.providerCustomerId)).toEqual(['cus_test_1']);
    expect(stripe.sessions.get(sessionIdOf(result))?.form.get('customer')).toBe('cus_test_1');
  });
});

describe('over HTTP', () => {
  function post(url: string, who: Buyer | null, payload: Record<string, unknown> = {}) {
    return app.inject({
      method: 'POST',
      url,
      payload,
      headers:
        who === null
          ? { 'idempotency-key': newId() }
          : { cookie: who.cookies, 'x-csrf-token': who.csrfToken, 'idempotency-key': newId() },
    });
  }

  it('refuses a session to somebody who is not signed in', async () => {
    const { orderId } = await placeOrder(buyer);

    const response = await post(`/api/v1/payments/orders/${orderId}/session`, null, {
      provider: 'STRIPE',
    });

    expect(response.statusCode).toBe(401);
    expect(stripe.sessionCreates).toBe(0);
  });

  it('will not open a page for another customer’s order', async () => {
    const { orderId } = await placeOrder(buyer);
    const other = await createBuyer('other@checkout.test');

    const response = await post(`/api/v1/payments/orders/${orderId}/session`, other, {
      provider: 'STRIPE',
    });

    expect(response.statusCode).toBe(404);
    expect(stripe.sessionCreates).toBe(0);
  });

  it('ignores an amount and a currency the browser made up', async () => {
    const { orderId, totalMinor } = await placeOrder(buyer);

    const response = await post(`/api/v1/payments/orders/${orderId}/session`, buyer, {
      provider: 'STRIPE',
      amount: '1',
      amountMinor: '1',
      currency: 'USD',
      discountMinor: '999999',
    });

    expect(response.statusCode, response.body).toBe(201);
    const body = response.json<{ checkoutSessionId: string; amount: { minor: string; currency: string } }>();
    expect(body.amount).toMatchObject({ minor: totalMinor.toString(), currency: 'INR' });

    const session = stripe.sessions.get(body.checkoutSessionId);
    expect(session?.form.get('line_items[0][price_data][unit_amount]')).toBe(totalMinor.toString());
    expect(session?.form.get('line_items[0][price_data][currency]')).toBe('inr');
  });

  it('shows one customer’s confirmation to nobody else', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const other = await createBuyer('peeker@checkout.test');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/orders/${orderId}/checkout/${sessionIdOf(result)}`,
      headers: { cookie: other.cookies },
    });

    expect(response.statusCode).toBe(404);
  });

  it('refuses a session id that is not shaped like one', async () => {
    const { orderId } = await placeOrder(buyer);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/payments/orders/${orderId}/checkout/not-a-session`,
      headers: { cookie: buyer.cookies },
    });

    expect(response.statusCode).toBe(400);
  });

  it('answers a Stripe webhook whose signature is forged with a refusal, and changes nothing', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const { session } = stripe.pay(sessionIdOf(result));

    const body = JSON.stringify({
      id: 'evt_forged',
      type: 'checkout.session.completed',
      data: { object: sessionObject(session) },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/webhooks/stripe',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'stripe-signature': `t=${String(Math.floor(Date.now() / 1000))},v1=${'0'.repeat(64)}`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: false });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('PENDING_PAYMENT');
    expect(order.paidMinor).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// Payment outcomes
// ---------------------------------------------------------------------------

describe('a successful payment', () => {
  it('confirms the order from checkout.session.completed, commits the stock, and records the card shown', async () => {
    const { orderId, totalMinor } = await placeOrder(buyer, 20);
    const result = await openCheckout(buyer, orderId);
    const { session, intent } = stripe.pay(sessionIdOf(result));

    const outcome = await deliver('checkout.session.completed', sessionObject(session));
    expect(outcome).toMatchObject({ accepted: true, duplicate: false });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');
    expect(order.paidMinor).toBe(totalMinor);

    const attempt = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: result.paymentTransactionId },
    });
    expect(attempt).toMatchObject({
      status: 'CAPTURED',
      providerOrderId: intent.id,
      providerPaymentId: intent.latest_charge,
      capturedMinor: totalMinor,
      cardBrand: 'visa',
      cardLast4: '4242',
      openAttemptKey: null,
    });

    const reservations = await prisma.stockReservation.findMany({ where: { orderId } });
    expect(reservations.map((reservation) => reservation.status)).toEqual(['COMMITTED']);

    const view = await getCheckoutConfirmation(orderId, buyer.profileId, session.id);
    expect(view).toMatchObject({
      state: 'SUCCEEDED',
      orderStatus: 'CONFIRMED',
      card: { brand: 'visa', last4: '4242' },
      failureReason: null,
      canRetry: false,
    });
    expect(view.paidAt).not.toBeNull();
  });

  it('is fulfilled exactly once, however many routes report the same capture', async () => {
    const { orderId, totalMinor } = await placeOrder(buyer, 20);
    const result = await openCheckout(buyer, orderId);
    const { session, intent } = stripe.pay(sessionIdOf(result));

    // The same event delivered twice, the PaymentIntent's own event, a manual
    // "check again", and an administrator's reconcile.
    await deliver('checkout.session.completed', sessionObject(session), 'evt_dup');
    const repeat = await deliver('checkout.session.completed', sessionObject(session), 'evt_dup');
    await deliver('payment_intent.succeeded', intentObject(intent));
    await refreshCheckoutConfirmation(orderId, buyer.profileId, session.id);
    await reconcilePayment(result.paymentTransactionId);

    expect(repeat).toMatchObject({ duplicate: true });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paidMinor).toBe(totalMinor);

    const confirmations = await prisma.orderStatusHistory.count({
      where: { orderId, toStatus: 'CONFIRMED' },
    });
    expect(confirmations).toBe(1);

    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId } });
    expect(balance.onHandQty).toBe(80);
  });

  it('applies a payment_intent.succeeded that overtakes its own session event', async () => {
    const { orderId, totalMinor } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const { session, intent } = stripe.pay(sessionIdOf(result), { saveCard: true });

    // Stripe does not promise order. At this moment no row carries the pi_.
    await deliver('payment_intent.succeeded', intentObject(intent));

    let order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe('CONFIRMED');

    // The session event, arriving second, credits nothing more but still
    // records the card the customer chose to save.
    await deliver('checkout.session.completed', sessionObject(session));

    order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.paidMinor).toBe(totalMinor);
    expect(await prisma.customerPaymentMethod.count({ where: { customerProfileId: buyer.profileId } })).toBe(1);
  });

  it('says "confirming" to a customer who beats the webhook back, and confirms from Stripe on "check again"', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const { session } = stripe.pay(sessionIdOf(result));

    // Back on our page. No webhook yet: the return itself proves nothing.
    const before = await getCheckoutConfirmation(orderId, buyer.profileId, session.id);
    expect(before.state).toBe('CONFIRMING');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      'PENDING_PAYMENT',
    );

    // The server asks Stripe, which is the authority.
    const after = await refreshCheckoutConfirmation(orderId, buyer.profileId, session.id);
    expect(after.state).toBe('SUCCEEDED');
  });

  it('waits in PROCESSING for a delayed method, then confirms on async success', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const { session, intent } = stripe.pay(sessionIdOf(result), { paymentStatus: 'unpaid' });

    await deliver('checkout.session.completed', sessionObject(session));

    expect((await getCheckoutConfirmation(orderId, buyer.profileId, session.id)).state).toBe(
      'PROCESSING',
    );
    // Still holding the order: nothing may open a second payment beside it.
    await expect(openCheckout(buyer, orderId)).resolves.toMatchObject({ next: 'AWAIT_CONFIRMATION' });

    // The bank settles.
    intent.status = 'succeeded';
    intent.amount_received = intent.amount;
    session.payment_status = 'paid';
    await deliver('checkout.session.async_payment_succeeded', sessionObject(session));

    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CONFIRMED');
  });

  it('refuses a session whose amount does not match the attempt, and tells finance', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const { session } = stripe.pay(sessionIdOf(result));

    const outcome = await deliver('checkout.session.completed', {
      ...sessionObject(session),
      amount_total: 100,
    });

    expect(outcome).toMatchObject({ accepted: false, reason: 'amount mismatch' });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).paidMinor).toBe(0n);
  });
});

describe('a payment that does not go through', () => {
  it.each([
    ['card_declined', 'DECLINED'],
    ['insufficient_funds', 'INSUFFICIENT_FUNDS'],
    ['incorrect_cvc', 'INCORRECT_CVC'],
    ['expired_card', 'EXPIRED_CARD'],
    ['payment_intent_authentication_failure', 'AUTHENTICATION_FAILED'],
  ])('keeps the page open after a %s inside Checkout, then explains it once the page closes', async (code, reason) => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const intentId = `pi_test_${newId()}`;

    await deliver('payment_intent.payment_failed', {
      id: intentId,
      object: 'payment_intent',
      amount: 1,
      currency: 'inr',
      status: 'requires_payment_method',
      metadata: { uboss_payment_transaction_id: result.paymentTransactionId },
      last_payment_error: { code: code === 'insufficient_funds' ? 'card_declined' : code, decline_code: code },
    });

    // The customer is still on Stripe's page and can try another card.
    const attempt = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: result.paymentTransactionId },
    });
    expect(attempt).toMatchObject({ status: 'CREATED', openAttemptKey: orderId });
    expect(await prisma.notificationOutbox.count({ where: { eventKey: 'payment.failed' } })).toBe(0);

    // They give up; Stripe closes the page.
    const session = stripe.sessions.get(sessionIdOf(result));
    if (session !== undefined) session.status = 'expired';
    await deliver('checkout.session.expired', sessionObject(session as FakeSession));

    const view = await getCheckoutConfirmation(orderId, buyer.profileId, sessionIdOf(result));
    expect(view).toMatchObject({ state: 'EXPIRED', failureReason: reason, canRetry: true });
  });

  it('frees the order for a new attempt when the session expires', async () => {
    const { orderId } = await placeOrder(buyer);
    const first = await openCheckout(buyer, orderId);
    const session = stripe.sessions.get(sessionIdOf(first)) as FakeSession;
    session.status = 'expired';

    await deliver('checkout.session.expired', sessionObject(session));

    const closed = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: first.paymentTransactionId },
    });
    expect(closed).toMatchObject({ status: 'EXPIRED', openAttemptKey: null });

    const second = await openCheckout(buyer, orderId);
    expect(second.checkoutSessionId).not.toBe(first.checkoutSessionId);
    // The order itself was never touched.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      'PENDING_PAYMENT',
    );
  });

  it('closes the attempt and tells the customer when a delayed bank payment fails', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const { session } = stripe.pay(sessionIdOf(result), { paymentStatus: 'unpaid' });

    await deliver('checkout.session.completed', sessionObject(session));
    await deliver('checkout.session.async_payment_failed', sessionObject(session));

    const view = await getCheckoutConfirmation(orderId, buyer.profileId, session.id);
    expect(view).toMatchObject({ state: 'FAILED', failureReason: 'BANK_PAYMENT_FAILED', canRetry: true });
    expect(await prisma.notificationOutbox.count({ where: { eventKey: 'payment.failed' } })).toBe(1);
  });
});

describe('coming back through Cancel', () => {
  it('closes the page at Stripe so it can no longer be paid, and frees the order', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);

    const cancelled = await cancelOpenCheckout(orderId, buyer.profileId, buyer.userId);

    expect(cancelled.state).toBe('CANCELLED');
    expect(stripe.sessions.get(sessionIdOf(result))?.status).toBe('expired');
    const attempt = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: result.paymentTransactionId },
    });
    expect(attempt).toMatchObject({ status: 'CANCELLED', openAttemptKey: null });
  });

  it('records the payment instead, when the customer had paid in another tab', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    stripe.pay(sessionIdOf(result));

    const cancelled = await cancelOpenCheckout(orderId, buyer.profileId, buyer.userId);

    expect(cancelled.state).toBe('SUCCEEDED');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CONFIRMED');
  });

  it('cannot cancel another customer’s payment', async () => {
    const { orderId } = await placeOrder(buyer);
    await openCheckout(buyer, orderId);
    const other = await createBuyer('meddler@checkout.test');

    const result = await cancelOpenCheckout(orderId, other.profileId, other.userId);

    expect(result.state).toBe('NONE');
    expect(await prisma.paymentTransaction.count({ where: { orderId, status: 'CREATED' } })).toBe(1);
  });
});

describe('a dispute', () => {
  it('is recorded against the payment without undoing it', async () => {
    const { orderId } = await placeOrder(buyer);
    const result = await openCheckout(buyer, orderId);
    const { session, intent } = stripe.pay(sessionIdOf(result));
    await deliver('checkout.session.completed', sessionObject(session));

    await deliver('charge.dispute.created', {
      id: 'dp_test_1',
      charge: intent.latest_charge,
      payment_intent: intent.id,
      amount: intent.amount,
      currency: 'inr',
      reason: 'fraudulent',
    });

    const attempt = await prisma.paymentTransaction.findUniqueOrThrow({
      where: { id: result.paymentTransactionId },
    });
    expect(attempt.status).toBe('CAPTURED');
    expect(attempt.disputedAt).not.toBeNull();
    expect(attempt.disputeReason).toBe('fraudulent');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('CONFIRMED');
  });
});

// ---------------------------------------------------------------------------
// Saved cards
// ---------------------------------------------------------------------------

describe('Save this card for next time', () => {
  async function payAndConfirm(who: Buyer, saveCard: boolean, last4 = '4242'): Promise<string> {
    const { orderId } = await placeOrder(who, 2);
    const result = await openCheckout(who, orderId);
    const { session } = stripe.pay(sessionIdOf(result), { saveCard, last4 });
    await deliver('checkout.session.completed', sessionObject(session));
    return session.id;
  }

  it('keeps the card, with display fields only, when the customer ticked Stripe’s box', async () => {
    const sessionId = await payAndConfirm(buyer, true);

    const cards = await prisma.customerPaymentMethod.findMany({ where: { customerProfileId: buyer.profileId } });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      provider: 'STRIPE',
      providerCustomerId: 'cus_test_1',
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2031,
      status: 'ACTIVE',
      consentScope: 'CHECKOUT',
      consentVersion: 'stripe-checkout-native-v1',
    });

    // The consent record: who, what, which version, for what use, and where.
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'payment_method.saved', resourceId: cards[0]?.id },
    });
    expect(audit.afterJson).toMatchObject({
      consentType: 'SAVE_CARD_FOR_CHECKOUT',
      consentVersion: 'stripe-checkout-native-v1',
      intendedUsage: 'CUSTOMER_INITIATED_CHECKOUT',
      customerProfileId: buyer.profileId,
      providerSessionId: sessionId,
    });

    // Nothing that could pay for anything, anywhere in what we keep.
    const kept = JSON.stringify(cards[0], (_key, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(kept).not.toMatch(/cvc|cvv|"number"|4242424242424242/i);
  });

  it('keeps nothing when the customer left the box empty', async () => {
    await payAndConfirm(buyer, false);

    expect(await prisma.customerPaymentMethod.count({})).toBe(0);
  });

  it('opens the next checkout on the same Stripe Customer, so the card is offered back', async () => {
    await payAndConfirm(buyer, true);

    const { orderId } = await placeOrder(buyer, 2);
    const next = await openCheckout(buyer, orderId);

    expect(stripe.sessions.get(sessionIdOf(next))?.form.get('customer')).toBe('cus_test_1');
    expect(stripe.customers).toEqual(['cus_test_1']);
  });

  it('gives each customer their own Stripe Customer, so nobody is offered another’s cards', async () => {
    await payAndConfirm(buyer, true);
    const other = await createBuyer('neighbour@checkout.test');

    const { orderId } = await placeOrder(other, 2);
    const theirs = await openCheckout(other, orderId);

    expect(stripe.sessions.get(sessionIdOf(theirs))?.form.get('customer')).toBe('cus_test_2');
    expect(await prisma.customerPaymentMethod.count({ where: { customerProfileId: other.profileId } })).toBe(0);
  });

  it('never files a card attached to somebody else’s Stripe Customer', async () => {
    const { orderId } = await placeOrder(buyer, 2);
    const result = await openCheckout(buyer, orderId);
    const { session, method } = stripe.pay(sessionIdOf(result), { saveCard: true });
    // Stripe reports the card on a different Customer than the one we filed.
    method.customer = 'cus_somebody_else';

    await deliver('checkout.session.completed', sessionObject(session));

    expect(await prisma.customerPaymentMethod.count({})).toBe(0);
  });

  it('does not turn the save-for-checkout consent into an auto-pay mandate', async () => {
    await payAndConfirm(buyer, true);
    const card = await prisma.customerPaymentMethod.findFirstOrThrow({});

    expect(() => {
      assertChargeable(card);
    }).toThrowError(expect.objectContaining({ code: 'PAYMENT_METHOD_NOT_CHARGEABLE' }) as Error);

    const session = [...stripe.sessions.values()][0];
    const sent = [...(session?.form.entries() ?? [])].map(([key, value]) => `${key}=${value}`).join('&');
    expect(sent).not.toContain('off_session');
    expect(sent).not.toContain('setup_future_usage');
  });

  it('stops offering a card that was removed at Stripe', async () => {
    await payAndConfirm(buyer, true);
    const card = await prisma.customerPaymentMethod.findFirstOrThrow({});

    await deliver('payment_method.detached', {
      id: card.providerPaymentMethodId,
      object: 'payment_method',
      customer: null,
    });

    expect((await prisma.customerPaymentMethod.findUniqueOrThrow({ where: { id: card.id } })).status).toBe(
      'DETACHED',
    );
  });

  it('will not remove the card behind a live auto-pay mandate', async () => {
    await payAndConfirm(buyer, true);
    const card = await prisma.customerPaymentMethod.findFirstOrThrow({});

    await prisma.customerAutoPaySetting.create({
      data: {
        id: newId(),
        customerProfileId: buyer.profileId,
        status: 'ACTIVE',
        paymentMethodId: card.id,
        consentAcceptedAt: new Date(),
        consentVersion: 'v1',
        enabledAt: new Date(),
      },
    });

    await expect(
      removePaymentMethod(card.id, buyer.profileId, {
        userId: buyer.userId,
        email: buyer.email,
        type: 'CUSTOMER',
      }),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_IN_USE' });
  });
});
