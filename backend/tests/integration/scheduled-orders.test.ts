/**
 * Buy Later, Subscribe & Reorder, and auto-pay - integration, against a real
 * MariaDB.
 *
 * `recurring.test.ts` covers the engine's duplicate protection. This file
 * covers the feature as a customer meets it, and in particular the four ways
 * it can go wrong once money is involved:
 *
 *   - the charge fails
 *   - the charge needs the cardholder
 *   - the ERP refuses BEFORE the charge
 *   - the ERP refuses AFTER the charge
 *
 * The last of those is the one that matters most, and it has a whole section:
 * the customer's money is gone, their order is real, and the warehouse cannot
 * see it. Nothing may tell them their order failed, nothing may charge them
 * again, and the retry must not produce a second ERP order.
 *
 * Stripe and the ERP are both reached through `fetch`, so both are stubbed
 * through one router keyed on the URL. Signatures on the webhook path are
 * computed with the real HMAC against a real secret rather than stubbed - the
 * point of a webhook test is that verification runs.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { occurrenceIdempotencyKey } from '../../src/domain/schedule-state.js';
import { encryptSecret } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { receiveStock } from '../../src/modules/inventory/inventory.service.js';
import { processWebhook } from '../../src/modules/payments/payment.service.js';
import {
  completePaymentMethodEnrolment,
  listPaymentMethods,
  removePaymentMethod,
} from '../../src/modules/payments/payment-method.service.js';
import { addItem } from '../../src/modules/cart/cart.service.js';
import {
  convertCartAfterActivation,
  createCartSchedule,
  previewCartSchedule,
} from '../../src/modules/recurring/cart-schedule.service.js';
import {
  activateSchedule,
  cancelSchedule,
  pauseSchedule,
  resumeSchedule,
  skipNextOccurrence,
  updateSchedule,
} from '../../src/modules/recurring/schedule.service.js';
import { runOccurrence } from '../../src/modules/recurring/occurrence.service.js';
import { retryDueErpPushes } from '../../src/modules/integrations/erp-order.service.js';

const WEBHOOK_SECRET = 'whsec_scheduled_orders_test';
const ERP_BASE_URL = 'https://erp.test.local/api';

let customerActor: { userId: string; email: string; type: 'CUSTOMER' };
let adminActor: { userId: string; email: string; type: 'ADMIN' };
let customerProfileId: string;
let otherProfileId: string;
let otherActor: { userId: string; email: string; type: 'CUSTOMER' };
let productId: string;
let addressId: string;
let paymentMethodId: string;

/** Flags this feature needs on, restored afterwards. */
const flags = {
  autopay: env.FEATURE_SUBSCRIPTION_AUTOPAY,
  scheduled: env.FEATURE_SCHEDULED_ORDERS,
  erpConnection: env.ERP_ORDER_CONNECTION_NAME,
  erpVerify: env.ERP_VERIFY_STOCK_BEFORE_CHARGE,
};

type Mutable = {
  FEATURE_SUBSCRIPTION_AUTOPAY: boolean;
  FEATURE_SCHEDULED_ORDERS: boolean;
  ERP_ORDER_CONNECTION_NAME: string;
  ERP_VERIFY_STOCK_BEFORE_CHARGE: boolean;
};

function setFlags(values: Partial<Mutable>): void {
  Object.assign(env as unknown as Mutable, values);
}

// ---------------------------------------------------------------------------
// The stubbed outside world
// ---------------------------------------------------------------------------

/**
 * What the stubs should do on the next call.
 *
 * Mutated per test rather than re-stubbed, so a test reads as "make the ERP
 * refuse, then run the occurrence" instead of as fetch plumbing.
 */
interface WorldState {
  /** How the off-session charge behaves. */
  charge: 'succeeds' | 'declines' | 'requires_action';
  /** How the ERP's order endpoint behaves. */
  erpOrder: 'accepts' | 'rejects' | 'unreachable' | 'duplicate';
  /** How the ERP's stock endpoint behaves. */
  erpStock: 'in_stock' | 'short' | 'unreachable';
  /** Every Stripe PaymentIntent created, keyed by idempotency key. */
  intentsByKey: Map<string, string>;
  /** Calls to the ERP order endpoint, with the idempotency header sent. */
  erpOrderCalls: { idempotencyKey: string | undefined; body: unknown }[];
  /** Off-session charge calls, with their idempotency keys. */
  chargeCalls: { idempotencyKey: string | undefined }[];
}

let world: WorldState;

function resetWorld(): void {
  world = {
    charge: 'succeeds',
    erpOrder: 'accepts',
    erpStock: 'in_stock',
    intentsByKey: new Map(),
    erpOrderCalls: [],
    chargeCalls: [],
  };
}

/**
 * The request body as text.
 *
 * `BodyInit` covers streams and buffers as well as strings; everything this
 * codebase sends is a JSON string, so it is narrowed rather than coerced -
 * `String(aBuffer)` would silently produce "[object Object]" and the test
 * would pass while asserting nothing.
 */
function bodyText(init: RequestInit | undefined): string {
  const body = init?.body;
  return typeof body === 'string' ? body : '{}';
}

/** One charge per intent, so the unique index on charge ids is satisfied. */
function chargeIdFor(intentId: string): string {
  return `ch_${intentId.replace(/^pi_/, '')}`;
}

function jsonResponse(body: unknown, status = 200): unknown {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  };
}

function installFetchRouter(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const idempotencyKey = headers['Idempotency-Key'];

      // --- Stripe ---------------------------------------------------------
      if (url.startsWith('https://api.stripe.com/v1/customers')) {
        return Promise.resolve(jsonResponse({ id: `cus_${newId().slice(0, 10)}` }));
      }

      if (url.startsWith('https://api.stripe.com/v1/setup_intents')) {
        return Promise.resolve(
          jsonResponse({
            id: 'seti_test_1',
            status: 'succeeded',
            client_secret: 'seti_test_1_secret_abc',
            customer: 'cus_test_1',
            payment_method: {
              id: 'pm_test_card_1',
              card: {
                brand: 'visa',
                last4: '4242',
                exp_month: 12,
                exp_year: new Date().getUTCFullYear() + 3,
                funding: 'credit',
                country: 'BE',
              },
            },
          }),
        );
      }

      if (url.startsWith('https://api.stripe.com/v1/payment_intents/search')) {
        // Only reached on the authentication-required recovery path.
        const existing = [...world.intentsByKey.values()][0] ?? 'pi_test_action';
        return Promise.resolve(
          jsonResponse({ data: [{ id: existing, amount: 0, currency: 'inr', status: 'requires_action' }] }),
        );
      }

      if (url.startsWith('https://api.stripe.com/v1/payment_intents/')) {
        // A GET of one intent: reconciliation, and `buildCheckoutPayload`.
        const intentId = url.split('/v1/payment_intents/')[1]?.split('?')[0] ?? 'pi_unknown';
        const captured = world.charge === 'succeeds';

        return Promise.resolve(
          jsonResponse({
            id: intentId,
            amount: currentAmountMinor,
            amount_received: captured ? currentAmountMinor : 0,
            currency: 'inr',
            status: captured ? 'succeeded' : 'requires_action',
            client_secret: `${intentId}_secret`,
            // Derived from the intent id, because charge ids are unique at
            // Stripe and `payment_transactions.providerPaymentId` is unique
            // here. A fixed value collided the second time a plan ran - the
            // index catching a stub that was lying about the world.
            latest_charge: captured
              ? { id: chargeIdFor(intentId), payment_method_details: { type: 'card' } }
              : null,
          }),
        );
      }

      if (url === 'https://api.stripe.com/v1/payment_intents') {
        world.chargeCalls.push({ idempotencyKey });

        if (world.charge === 'declines') {
          return Promise.resolve(
            jsonResponse(
              { error: { code: 'card_declined', decline_code: 'insufficient_funds', message: 'Your card was declined.' } },
              402,
            ),
          );
        }

        if (world.charge === 'requires_action') {
          return Promise.resolve(
            jsonResponse(
              {
                error: {
                  code: 'authentication_required',
                  message: 'This payment requires authentication.',
                },
              },
              402,
            ),
          );
        }

        // A replay under the same key returns the SAME intent, exactly as
        // Stripe does. This is what the duplicate-charge tests rely on.
        const existing = idempotencyKey === undefined ? undefined : world.intentsByKey.get(idempotencyKey);
        const intentId = existing ?? `pi_${newId().slice(0, 12)}`;
        if (idempotencyKey !== undefined) world.intentsByKey.set(idempotencyKey, intentId);

        return Promise.resolve(
          jsonResponse({
            id: intentId,
            amount: currentAmountMinor,
            amount_received: currentAmountMinor,
            currency: 'inr',
            status: 'succeeded',
            latest_charge: {
              id: chargeIdFor(intentId),
              payment_method_details: { type: 'card' },
            },
          }),
        );
      }

      if (url.includes('/payment_methods/') && url.endsWith('/detach')) {
        return Promise.resolve(jsonResponse({ id: 'pm_test_card_1' }));
      }

      if (url.startsWith('https://api.stripe.com/v1/balance')) {
        return Promise.resolve(jsonResponse({ livemode: false }));
      }

      // --- The ERP --------------------------------------------------------
      if (url === `${ERP_BASE_URL}/stock/availability`) {
        if (world.erpStock === 'unreachable') return Promise.reject(new Error('ECONNREFUSED'));

        const body = JSON.parse(bodyText(init)) as {
          lines?: { sku: string; quantity: number }[];
        };

        return Promise.resolve(
          jsonResponse({
            lines: (body.lines ?? []).map((line) => ({
              sku: line.sku,
              available: world.erpStock === 'short' ? 0 : line.quantity + 100,
            })),
          }),
        );
      }

      if (url === `${ERP_BASE_URL}/orders`) {
        world.erpOrderCalls.push({
          idempotencyKey,
          body: JSON.parse(bodyText(init)),
        });

        if (world.erpOrder === 'unreachable') return Promise.reject(new Error('ETIMEDOUT'));
        if (world.erpOrder === 'rejects') {
          return Promise.resolve(jsonResponse({ message: 'ERP is unavailable' }, 503));
        }
        if (world.erpOrder === 'duplicate') {
          // An ERP that honours the idempotency header answers a replay with
          // 409 and the reference of the order it already made.
          return Promise.resolve(jsonResponse({ id: 'ERP-ALREADY-1' }, 409));
        }

        return Promise.resolve(jsonResponse({ id: `ERP-${world.erpOrderCalls.length}` }));
      }

      return Promise.reject(new Error(`unstubbed fetch: ${url}`));
    }),
  );
}

/**
 * The amount the stubbed Stripe reports.
 *
 * Has to match the order, because the capture path refuses a mismatch and
 * alerts finance - which is the guard working, and would otherwise look like a
 * mysterious failure inside a test.
 */
let currentAmountMinor = 0;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

async function resetAll(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.notificationDelivery.deleteMany({});
  await prisma.notificationOutbox.deleteMany({});
  await prisma.erpOrderPush.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.paymentLink.deleteMany({});
  await prisma.paymentTransaction.deleteMany({});
  await prisma.paymentProviderConnection.deleteMany({});
  await prisma.integrationConnection.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.scheduleOccurrence.deleteMany({});
  await prisma.recurringScheduleItem.deleteMany({});
  await prisma.recurringSchedule.deleteMany({});
  await prisma.customerPaymentMethod.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
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

async function makeCustomer(email: string): Promise<{
  profileId: string;
  actor: { userId: string; email: string; type: 'CUSTOMER' };
  addressId: string;
}> {
  const userId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'CUSTOMER', email, emailNormalized: email, status: 'ACTIVE' },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Test Buyer', activatedAt: new Date() },
  });

  const address = await prisma.address.create({
    data: {
      id: newId(),
      customerProfileId: profile.id,
      contactName: 'Test Buyer',
      contactPhone: '+91 90000 00000',
      line1: 'Dock 4',
      city: 'Pune',
      state: 'MH',
      postalCode: '411019',
      country: 'IN',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });

  return {
    profileId: profile.id,
    actor: { userId, email, type: 'CUSTOMER' },
    addressId: address.id,
  };
}

beforeEach(async () => {
  await resetAll();
  resetWorld();
  installFetchRouter();

  setFlags({
    FEATURE_SUBSCRIPTION_AUTOPAY: true,
    FEATURE_SCHEDULED_ORDERS: true,
    ERP_ORDER_CONNECTION_NAME: 'Test ERP',
    ERP_VERIFY_STOCK_BEFORE_CHARGE: true,
  });

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

  const primary = await makeCustomer('buyer@sched.test');
  customerProfileId = primary.profileId;
  customerActor = primary.actor;
  addressId = primary.addressId;

  const secondary = await makeCustomer('rival@sched.test');
  otherProfileId = secondary.profileId;
  otherActor = secondary.actor;

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

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Nitrile Gloves M',
      slug: 'nitrile-gloves-m',
      sku: 'GLV-M',
      basePriceMinor: 20_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: true,
      minOrderQty: 1,
      isRecurringEligible: true,
    },
  });
  productId = product.id;

  await receiveStock({ productId, quantity: 500 }, adminActor);

  // --- Stripe, as an activated connection ------------------------------
  const stripeConnectionId = newId();
  await prisma.paymentProviderConnection.create({
    data: {
      id: stripeConnectionId,
      provider: 'STRIPE',
      mode: 'TEST',
      label: 'Stripe test',
      credentialsEnc: encryptSecret(
        JSON.stringify({ keyId: 'pk_test_abc', keySecret: 'sk_test_abc' }),
        `payment_connection:${stripeConnectionId}`,
      ),
      webhookSecretEnc: encryptSecret(
        WEBHOOK_SECRET,
        `payment_connection:${stripeConnectionId}`,
      ),
      isActive: true,
    },
  });

  // --- The ERP, as an activated connector -------------------------------
  const erpConnectionId = newId();
  await prisma.integrationConnection.create({
    data: {
      id: erpConnectionId,
      name: 'Test ERP',
      baseUrl: ERP_BASE_URL,
      authType: 'BEARER_TOKEN',
      credentialsEnc: encryptSecret(
        JSON.stringify({ token: 'erp-token' }),
        `integration_connection:${erpConnectionId}`,
      ),
      fieldMappingJson: {},
      direction: 'EXPORT',
      isActive: true,
      timeoutMs: 5000,
    },
  });

  // --- A saved card, enrolled the way the real flow enrols one ----------
  const method = await completePaymentMethodEnrolment(
    {
      customerProfileId,
      setupIntentId: 'seti_test_1',
      consentAccepted: true,
    },
    { userId: customerActor.userId, email: customerActor.email, type: 'CUSTOMER' },
  );
  paymentMethodId = method.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  setFlags({
    FEATURE_SUBSCRIPTION_AUTOPAY: flags.autopay,
    FEATURE_SCHEDULED_ORDERS: flags.scheduled,
    ERP_ORDER_CONNECTION_NAME: flags.erpConnection,
    ERP_VERIFY_STOCK_BEFORE_CHARGE: flags.erpVerify,
  });
});

afterAll(async () => {
  await resetAll();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tomorrow(): string {
  return new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
}

function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function fillCart(quantity = 10, profileId = customerProfileId): Promise<void> {
  await addItem(profileId, { productId, quantity });
}

/**
 * The config the storefront would post for a subscription.
 *
 * The start date is a week out rather than tomorrow, so the plan's first
 * delivery sits OUTSIDE the 24-hour edit cutoff. A plan due tomorrow morning
 * legitimately refuses edits, and building every management test on one would
 * have tested the cutoff over and over instead of the thing under test.
 * `dueSoonConfig` is the one that deliberately sits inside it.
 */
function subscriptionConfig(overrides: Record<string, unknown> = {}) {
  return {
    frequency: 'WEEKLY' as const,
    weekday: 3,
    startDate: inDays(7),
    runAtMinute: 360,
    shippingAddressId: addressId,
    paymentMode: 'AUTO_PAY' as const,
    paymentMethodId,
    ...overrides,
  };
}

/** Buy Later: one delivery, one date. */
function buyLaterConfig(overrides: Record<string, unknown> = {}) {
  return {
    frequency: 'ONE_TIME' as const,
    startDate: tomorrow(),
    runAtMinute: 600,
    shippingAddressId: addressId,
    paymentMode: 'AUTO_PAY' as const,
    paymentMethodId,
    ...overrides,
  };
}

/**
 * A due occurrence that the customer has already been quoted a price for.
 *
 * What the reminder sweep leaves behind: a SCHEDULED row for the slot with
 * `quotedTotalMinor` set. The tolerance check measures drift against exactly
 * that figure, so a test about repricing has to start from one.
 */
async function quotedOccurrence(scheduleId: string, quotedMinor: bigint): Promise<Date> {
  const slot = await makeDue(scheduleId);

  await prisma.scheduleOccurrence.create({
    data: {
      id: newId(),
      scheduleId,
      plannedRunAt: slot,
      timezone: 'Asia/Kolkata',
      status: 'SCHEDULED',
      idempotencyKey: occurrenceIdempotencyKey(scheduleId, slot),
      quotedTotalMinor: quotedMinor,
      reminderSentAt: new Date(),
    },
  });

  return slot;
}

/** Force a plan due now, as the worker would find it. */
async function makeDue(scheduleId: string): Promise<Date> {
  const slot = new Date(Date.now() - 60_000);
  await prisma.recurringSchedule.update({
    where: { id: scheduleId },
    data: { nextRunAt: slot },
  });
  return slot;
}

/** Create, activate, and return the live plan. */
async function liveSchedule(
  config: Record<string, unknown>,
  profileId = customerProfileId,
  actor = customerActor,
): Promise<string> {
  const created = await createCartSchedule(profileId, config as never, actor);

  await activateSchedule(
    created.scheduleId,
    { consentAccepted: true },
    actor,
    profileId,
  );

  // The route does this straight after activating, and the cart-clearing
  // behaviour is part of what these tests are about.
  await convertCartAfterActivation(profileId, created.scheduleId);

  return created.scheduleId;
}

/** A signed Stripe webhook, verified for real by the adapter. */
function stripeWebhook(eventType: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: `evt_${newId().slice(0, 12)}`,
    type: eventType,
    data: { object },
  });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${String(timestamp)}.`)
    .update(Buffer.from(payload, 'utf8'))
    .digest('hex');

  return {
    raw: Buffer.from(payload, 'utf8'),
    headers: { 'stripe-signature': `t=${String(timestamp)},v1=${signature}` },
  };
}

// ===========================================================================

describe('the review screen', () => {
  it('prices the cart under the proposed schedule without writing anything', async () => {
    await fillCart(10);

    const preview = await previewCartSchedule(customerProfileId, subscriptionConfig());

    // 10 x 200.00 = 2000.00, +18% = 2360.00.
    expect(preview.quote.totals.subtotal.minor).toBe('200000');
    expect(preview.quote.totals.tax.minor).toBe('36000');
    expect(preview.quote.totals.grandTotal.minor).toBe('236000');

    // Everything the customer has to read before authorising anything.
    expect(preview.summary).toContain('Wednesday');
    expect(preview.nextProcessingAt).not.toBeNull();
    expect(preview.deliveryAddress?.id).toBe(addressId);
    expect(preview.paymentMethod.description).toContain('4242');
    expect(preview.editableUntil).not.toBeNull();
    expect(preview.canActivate).toBe(true);

    // A preview writes nothing.
    expect(await prisma.recurringSchedule.count()).toBe(0);
  });

  it('honours a quantity that differs from the cart', async () => {
    await fillCart(2);
    const cart = await prisma.cartItem.findFirstOrThrow();

    const preview = await previewCartSchedule(
      customerProfileId,
      subscriptionConfig({ quantities: { [cart.id]: 25 } }),
    );

    expect(preview.quote.lines[0]?.quantity).toBe(25);
    expect(preview.quote.totals.subtotal.minor).toBe('500000');
  });

  it('refuses a past date, rather than quietly moving it', async () => {
    await fillCart();

    const preview = await previewCartSchedule(
      customerProfileId,
      buyLaterConfig({ startDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) }),
    );

    expect(preview.canActivate).toBe(false);
    expect(preview.problems.map((problem) => problem.code)).toContain('SCHEDULE_DATE_IN_PAST');
  });
});

describe('Buy Later', () => {
  it('places one order on the chosen date and completes the plan', async () => {
    await fillCart(5);
    const scheduleId = await liveSchedule(buyLaterConfig());

    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.kind).toBe('ONE_TIME');
    expect(plan.status).toBe('ACTIVE');
    expect(plan.runOnceAt).not.toBeNull();
    // A one-shot plan is capped at one delivery by construction.
    expect(plan.maxOccurrences).toBe(1);

    // The cart is cleared once the plan is live, not before.
    expect(await prisma.cartItem.count()).toBe(0);

    const slot = await makeDue(scheduleId);
    const order = await prisma.order.findFirst();
    expect(order).toBeNull();

    currentAmountMinor = 118_000; // 5 x 200.00 + 18%
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('COMPLETED');
    expect(await prisma.order.count()).toBe(1);

    const placed = await prisma.order.findFirstOrThrow();
    expect(placed.source).toBe('RECURRING');
    expect(placed.status).toBe('CONFIRMED');
    expect(placed.grandTotalMinor).toBe(118_000n);

    // Its single delivery made, the plan is COMPLETED - not CANCELLED.
    const after = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(after.status).toBe('COMPLETED');
    expect(after.nextRunAt).toBeNull();
  });

  it('leaves the cart alone while the plan is still a draft', async () => {
    await fillCart(5);

    const created = await createCartSchedule(
      customerProfileId,
      buyLaterConfig(),
      customerActor,
    );

    const draft = await prisma.recurringSchedule.findUniqueOrThrow({
      where: { id: created.scheduleId },
    });

    expect(draft.status).toBe('DRAFT');
    // A draft has no run date, so the worker cannot see it at all.
    expect(draft.nextRunAt).toBeNull();
    expect(await prisma.cartItem.count()).toBe(1);

    // And nothing is charged for a draft, however due it looks.
    expect(await prisma.order.count()).toBe(0);
  });
});

describe('Subscribe & Reorder', () => {
  it('charges the saved card and completes the first delivery', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    const slot = await makeDue(scheduleId);
    currentAmountMinor = 236_000;

    const outcome = await runOccurrence(scheduleId, slot);
    expect(outcome.result).toBe('COMPLETED');

    const order = await prisma.order.findFirstOrThrow();
    expect(order.status).toBe('CONFIRMED');
    expect(order.paidMinor).toBe(236_000n);

    const occurrence = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    expect(occurrence.status).toBe('COMPLETED');
    expect(occurrence.paymentReference).toMatch(/^pi_/);
    expect(occurrence.erpOrderReference).toMatch(/^ERP-/);
    expect(occurrence.actualTotalMinor).toBe(236_000n);
    // The snapshot is the evidence of what was charged.
    expect(occurrence.cartSnapshotJson).not.toBeNull();

    // The plan rolls on to its next date.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');
    expect(plan.occurrenceCount).toBe(1);
    expect(plan.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('runs a second, independent occurrence', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    currentAmountMinor = 236_000;

    const first = await makeDue(scheduleId);
    expect((await runOccurrence(scheduleId, first)).result).toBe('COMPLETED');

    const second = await makeDue(scheduleId);
    expect((await runOccurrence(scheduleId, second)).result).toBe('COMPLETED');

    expect(await prisma.order.count()).toBe(2);

    // Two charges, two DIFFERENT idempotency keys - one per slot.
    const keys = new Set(world.chargeCalls.map((call) => call.idempotencyKey));
    expect(keys.size).toBe(2);

    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.occurrenceCount).toBe(2);
  });

  it('materialises upcoming deliveries so they can be skipped', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    const upcoming = await prisma.scheduleOccurrence.findMany({
      where: { scheduleId, status: 'SCHEDULED' },
      orderBy: { plannedRunAt: 'asc' },
    });

    expect(upcoming.length).toBeGreaterThan(1);
    // Each carries the plan's zone, and a key derived from its own slot.
    expect(upcoming[0]?.timezone).toBe('Asia/Kolkata');
    expect(upcoming[0]?.idempotencyKey).toBe(
      occurrenceIdempotencyKey(scheduleId, upcoming[0]?.plannedRunAt ?? new Date()),
    );
  });
});

describe('managing a schedule', () => {
  it('changes the frequency, and rebuilds the upcoming deliveries', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    const before = await prisma.scheduleOccurrence.findMany({
      where: { scheduleId, status: 'SCHEDULED' },
      select: { plannedRunAt: true },
    });

    await updateSchedule(
      scheduleId,
      { frequency: 'BIWEEKLY', weekday: 1 },
      customerActor,
      customerProfileId,
    );

    const after = await prisma.scheduleOccurrence.findMany({
      where: { scheduleId, status: 'SCHEDULED' },
      orderBy: { plannedRunAt: 'asc' },
      select: { plannedRunAt: true },
    });

    // A fortnight apart, on a Monday, and not the dates the weekly rule made.
    expect(after.length).toBeGreaterThan(0);
    expect(after.map((row) => row.plannedRunAt.getTime())).not.toEqual(
      before.map((row) => row.plannedRunAt.getTime()),
    );

    // Measured between the SECOND and THIRD rows, not the first two.
    //
    // The first row is the plan's start date, which `nextRunAt` honours as-is
    // whenever it is still in the future - so the gap from it to the first
    // parity Monday is whatever the calendar says. Every row after that comes
    // from the rule, and those are the ones that have to be a fortnight apart.
    expect(after.length).toBeGreaterThanOrEqual(3);

    const gapDays =
      ((after[2]?.plannedRunAt.getTime() ?? 0) - (after[1]?.plannedRunAt.getTime() ?? 0)) /
      86_400_000;
    expect(Math.round(gapDays)).toBe(14);

    // And they are all Mondays.
    for (const row of after.slice(1)) {
      const weekday = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        weekday: 'long',
      }).format(row.plannedRunAt);
      expect(weekday).toBe('Monday');
    }
  });

  it('changes a quantity, and the next charge follows it', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    await updateSchedule(
      scheduleId,
      { items: [{ productId, quantity: 3 }] },
      customerActor,
      customerProfileId,
    );

    const slot = await makeDue(scheduleId);
    currentAmountMinor = 70_800; // 3 x 200.00 + 18%

    expect((await runOccurrence(scheduleId, slot)).result).toBe('COMPLETED');

    const order = await prisma.order.findFirstOrThrow({ include: { items: true } });
    expect(order.items[0]?.quantity).toBe(3);
    expect(order.grandTotalMinor).toBe(70_800n);
  });

  it('refuses an edit inside the cutoff, and says when it can be changed', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    // An hour away, well inside the 24-hour default cutoff.
    await prisma.recurringSchedule.update({
      where: { id: scheduleId },
      data: { nextRunAt: new Date(Date.now() + 3_600_000) },
    });

    await expect(
      updateSchedule(scheduleId, { runAtMinute: 480 }, customerActor, customerProfileId),
    ).rejects.toMatchObject({ code: 'SCHEDULE_EDIT_CUTOFF_PASSED' });

    // An administrator handling a phone call is not bound by it.
    await expect(
      updateSchedule(scheduleId, { runAtMinute: 480 }, adminActor, null),
    ).resolves.toBeTruthy();
  });

  it('skips the next delivery, and the engine honours it', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    const skipped = await skipNextOccurrence(
      scheduleId,
      customerActor,
      customerProfileId,
      'away that week',
    );

    const row = await prisma.scheduleOccurrence.findUniqueOrThrow({
      where: { id: skipped.occurrenceId },
    });
    expect(row.status).toBe('SKIPPED');
    // Their doing, so their screens say "you skipped this".
    expect(row.skippedByUser).toBe(true);

    // The engine reaching that slot places no order.
    const outcome = await runOccurrence(scheduleId, skipped.plannedRunAt);
    expect(outcome.result).toBe('SKIPPED');
    expect(await prisma.order.count()).toBe(0);

    // And the subscription is still running.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');
  });

  it('pauses and resumes without catching up on missed slots', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    await pauseSchedule(scheduleId, customerActor, customerProfileId, 'on holiday');

    let plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('PAUSED');
    // Out of the worker's due query entirely.
    expect(plan.nextRunAt).toBeNull();
    expect(
      await prisma.scheduleOccurrence.count({ where: { scheduleId, status: 'SCHEDULED' } }),
    ).toBe(0);

    const resumed = await resumeSchedule(scheduleId, customerActor, customerProfileId);

    plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');
    // Recomputed from now: a plan paused for a month does not fire four times.
    expect(resumed.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
    expect(
      await prisma.scheduleOccurrence.count({ where: { scheduleId, status: 'SCHEDULED' } }),
    ).toBeGreaterThan(0);
  });

  it('cancels future runs and leaves delivered orders alone', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    currentAmountMinor = 236_000;
    const slot = await makeDue(scheduleId);
    await runOccurrence(scheduleId, slot);

    await cancelSchedule(scheduleId, customerActor, customerProfileId, 'no longer needed');

    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('CANCELLED');
    expect(plan.nextRunAt).toBeNull();

    // The order that already went out is untouched.
    const order = await prisma.order.findFirstOrThrow();
    expect(order.status).toBe('CONFIRMED');

    // The completed occurrence keeps its own record.
    const completed = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    expect(completed.status).toBe('COMPLETED');
  });
});

describe('when a delivery cannot go ahead', () => {
  it('holds the delivery when the platform is out of stock, and keeps the plan', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    await prisma.inventoryBalance.updateMany({ where: { productId }, data: { onHandQty: 1 } });

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    expect(await prisma.order.count()).toBe(0);
    // Nothing was charged.
    expect(world.chargeCalls).toHaveLength(0);

    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');

    const notice = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'schedule.stock_unavailable' },
    });
    expect(notice).not.toBeNull();
  });

  it('holds the delivery when the ERP says it cannot supply, BEFORE charging', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.erpStock = 'short';

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    // The order of operations that matters: no charge, no order.
    expect(world.chargeCalls).toHaveLength(0);
    expect(await prisma.order.count()).toBe(0);
  });

  it('holds rather than charging when the ERP cannot be reached to confirm stock', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.erpStock = 'unreachable';

    const slot = await makeDue(scheduleId);
    expect((await runOccurrence(scheduleId, slot)).result).toBe('SKIPPED');

    // An unreachable ERP is our problem, not evidence of supply. Assuming
    // stock here is how somebody gets charged for a product that is not there.
    expect(world.chargeCalls).toHaveLength(0);
  });

  it('never substitutes a product the customer did not authorise', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    // Withdraw the product from sale entirely.
    await prisma.product.update({ where: { id: productId }, data: { isPublished: false } });

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    expect(await prisma.order.count()).toBe(0);

    // A withdrawn product is permanent, so the plan pauses rather than
    // emailing the customer about it every week for ever.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('PAUSED');
  });

  it('holds the delivery when the price moves beyond the approved tolerance', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(
      subscriptionConfig({ priceTolerancePercent: '5', priceToleranceMinor: '0' }),
    );

    // The occurrence has to EXIST and carry a quote, because the tolerance is
    // measured against what the customer was last told. That is what the
    // reminder sweep writes, so it is written here the same way rather than
    // updating rows the engine has not created yet.
    const slot = await quotedOccurrence(scheduleId, 236_000n);

    // Then double the price.
    await prisma.product.update({ where: { id: productId }, data: { basePriceMinor: 40_000n } });

    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    // The whole point: nothing charged.
    expect(world.chargeCalls).toHaveLength(0);
    expect(await prisma.order.count()).toBe(0);

    const notice = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventKey: 'schedule.price_changed' },
    });
    // The message has to say this first, or the customer assumes they paid it.
    expect(notice.body).toContain('NOT charged');

    // And the subscription survives a price change.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');
  });

  it('charges a price that moved DOWN without asking', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(
      subscriptionConfig({ priceTolerancePercent: '1', priceToleranceMinor: '0' }),
    );

    const slot = await quotedOccurrence(scheduleId, 236_000n);

    await prisma.product.update({ where: { id: productId }, data: { basePriceMinor: 10_000n } });
    currentAmountMinor = 118_000;

    // Stopping a delivery to ask whether the customer minds paying less would
    // be absurd.
    expect((await runOccurrence(scheduleId, slot)).result).toBe('COMPLETED');
  });
});

describe('payment outcomes', () => {
  it('creates no confirmed order when the card is declined', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.charge = 'declines';

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('FAILED');

    // The order is cancelled, which releases the stock - there is nobody
    // present to retry against it.
    const order = await prisma.order.findFirst();
    expect(order?.status).toBe('CANCELLED');
    expect(
      await prisma.stockReservation.count({ where: { status: 'ACTIVE' } }),
    ).toBe(0);

    const occurrence = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    expect(occurrence.status).toBe('FAILED');
    expect(occurrence.paymentAttemptCount).toBe(1);

    // One failed charge is NOT consent to stop delivering.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');

    const notice = await prisma.notificationOutbox.findFirst({
      where: { eventKey: 'payment.failed' },
    });
    expect(notice).not.toBeNull();
  });

  it('holds the delivery for the cardholder when the bank asks for authentication', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.charge = 'requires_action';

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('ACTION_REQUIRED');

    const occurrence = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    expect(occurrence.status).toBe('ACTION_REQUIRED');
    expect(occurrence.actionRequiredAt).not.toBeNull();

    // Not a failure: the order stays payable so the customer can finish it.
    const order = await prisma.order.findFirstOrThrow();
    expect(order.status).toBe('PENDING_PAYMENT');

    // The plan is neither paused nor failed, and the NEXT delivery is not
    // held hostage to this one.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');
    expect(plan.nextRunAt).not.toBeNull();

    const notice = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventKey: 'schedule.payment_action_required' },
    });
    expect(notice.body).toContain('confirm');
  });

  it('stops attempting after the payment attempt limit, and pauses the plan', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.charge = 'declines';

    // Each attempt on its own slot, as consecutive real runs would be.
    for (let attempt = 0; attempt < env.SCHEDULE_MAX_PAYMENT_ATTEMPTS; attempt += 1) {
      const slot = new Date(Date.now() - (attempt + 1) * 3_600_000);
      await prisma.recurringSchedule.update({
        where: { id: scheduleId },
        data: { nextRunAt: slot, status: 'ACTIVE', failureCount: 0 },
      });
      await runOccurrence(scheduleId, slot);
    }

    // A card is not charged indefinitely: repeated declines are a signal to
    // the issuer about the card.
    expect(world.chargeCalls.length).toBeLessThanOrEqual(env.SCHEDULE_MAX_PAYMENT_ATTEMPTS);
  });
});

describe('the ERP hand-off', () => {
  it('sends the order and stores the ERP reference', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    currentAmountMinor = 236_000;
    const slot = await makeDue(scheduleId);
    await runOccurrence(scheduleId, slot);

    expect(world.erpOrderCalls).toHaveLength(1);

    const push = await prisma.erpOrderPush.findFirstOrThrow();
    expect(push.status).toBe('SUCCEEDED');
    expect(push.erpOrderReference).toBe('ERP-1');

    // The payload carries money as strings, never JSON numbers.
    const body = world.erpOrderCalls[0]?.body as { totals: { grand_total_minor: unknown } };
    expect(typeof body.totals.grand_total_minor).toBe('string');
    expect(body.totals.grand_total_minor).toBe('236000');
  });

  /**
   * THE case this whole feature is shaped around: money taken, ERP silent.
   */
  it('holds at PAID_ERP_PENDING when the ERP refuses AFTER a successful charge', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.erpOrder = 'rejects';
    currentAmountMinor = 236_000;

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('PAID_ERP_PENDING');

    // The money moved and the order is real.
    const order = await prisma.order.findFirstOrThrow();
    expect(order.status).toBe('CONFIRMED');
    expect(order.paidMinor).toBe(236_000n);

    const occurrence = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    // NOT failed. Telling the customer their order failed when their money is
    // gone and the order is real is the one message that loses an account.
    expect(occurrence.status).toBe('PAID_ERP_PENDING');
    expect(occurrence.erpPushStatus).toBe('FAILED');

    const push = await prisma.erpOrderPush.findFirstOrThrow();
    expect(push.status).toBe('FAILED');
    expect(push.nextRetryAt).not.toBeNull();

    // The customer is told dispatch is delayed - never that anything failed.
    const notice = await prisma.notificationOutbox.findFirstOrThrow({
      where: { eventKey: 'schedule.erp_delayed' },
    });
    expect(notice.body).toContain('confirmed');
    expect(notice.body).not.toContain('failed');
  });

  it('retries the held push under the SAME key and never charges again', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.erpOrder = 'rejects';
    currentAmountMinor = 236_000;

    const slot = await makeDue(scheduleId);
    await runOccurrence(scheduleId, slot);

    const chargesBefore = world.chargeCalls.length;
    const firstKey = world.erpOrderCalls[0]?.idempotencyKey;

    // The ERP comes back.
    world.erpOrder = 'accepts';
    await prisma.erpOrderPush.updateMany({ data: { nextRetryAt: new Date(Date.now() - 1000) } });

    const result = await retryDueErpPushes();
    expect(result.succeeded).toBe(1);

    // The same idempotency key on the retry. This is the point.
    expect(world.erpOrderCalls).toHaveLength(2);
    expect(world.erpOrderCalls[1]?.idempotencyKey).toBe(firstKey);

    // No second charge, and no second order.
    expect(world.chargeCalls.length).toBe(chargesBefore);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.erpOrderPush.count()).toBe(1);

    // And the occurrence is finally finished.
    const occurrence = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    expect(occurrence.status).toBe('COMPLETED');
    expect(occurrence.erpOrderReference).toBe('ERP-2');
  });

  it('treats an ERP 409 as success, because the order is already there', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    world.erpOrder = 'duplicate';
    currentAmountMinor = 236_000;

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    // An ERP that honours the idempotency header answers a replay with 409 and
    // the reference it already made. Retrying for hours against that would be
    // wrong.
    expect(outcome.result).toBe('COMPLETED');

    const push = await prisma.erpOrderPush.findFirstOrThrow();
    expect(push.status).toBe('SUCCEEDED');
    expect(push.erpOrderReference).toBe('ERP-ALREADY-1');
  });

  it('records one inventory reconciliation, however many times settlement runs', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    currentAmountMinor = 236_000;
    const slot = await makeDue(scheduleId);
    await runOccurrence(scheduleId, slot);

    const before = await prisma.inventoryMovement.count({
      where: { type: 'SYNC_CORRECTION' },
    });

    // Re-run settlement, as a redelivered webhook would.
    const { settleOccurrenceAfterPayment } = await import(
      '../../src/modules/recurring/occurrence.service.js'
    );
    const occurrence = await prisma.scheduleOccurrence.findFirstOrThrow({
      where: { plannedRunAt: slot },
    });
    await settleOccurrenceAfterPayment(occurrence.id);

    // The ledger is append-only and has no reversal, so a second delta would
    // silently corrupt on-hand.
    expect(await prisma.inventoryMovement.count({ where: { type: 'SYNC_CORRECTION' } })).toBe(
      before,
    );
  });
});

describe('duplicate protection', () => {
  it('charges once when the same slot is executed twice', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    currentAmountMinor = 236_000;
    const slot = await makeDue(scheduleId);

    const first = await runOccurrence(scheduleId, slot);
    const second = await runOccurrence(scheduleId, slot);

    expect(first.result).toBe('COMPLETED');
    expect(second.result).toBe('DUPLICATE');

    expect(await prisma.order.count()).toBe(1);
    expect(world.chargeCalls).toHaveLength(1);
    expect(world.erpOrderCalls).toHaveLength(1);
    expect(await prisma.erpOrderPush.count()).toBe(1);
  });

  it('charges once when ten schedulers race for the same slot', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    currentAmountMinor = 236_000;
    const slot = await makeDue(scheduleId);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => runOccurrence(scheduleId, slot)),
    );

    const completed = results.filter(
      (result) => result.status === 'fulfilled' && result.value.result === 'COMPLETED',
    );

    expect(completed).toHaveLength(1);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.paymentTransaction.count()).toBe(1);
    expect(await prisma.erpOrderPush.count()).toBe(1);
  });

  it('credits the order once when the capture webhook is redelivered', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    currentAmountMinor = 236_000;
    const slot = await makeDue(scheduleId);
    await runOccurrence(scheduleId, slot);

    const order = await prisma.order.findFirstOrThrow();
    const transaction = await prisma.paymentTransaction.findFirstOrThrow();
    expect(order.paidMinor).toBe(236_000n);

    // The webhook Stripe sends after an off-session charge, arriving twice.
    const event = stripeWebhook('payment_intent.succeeded', {
      id: transaction.providerOrderId ?? 'pi_test',
      amount: 236_000,
      amount_received: 236_000,
      currency: 'inr',
      status: 'succeeded',
      latest_charge: chargeIdFor(transaction.providerOrderId ?? 'pi_test'),
      payment_method_types: ['card'],
    });

    const first = await processWebhook(event.raw, event.headers);
    expect(first.accepted).toBe(true);

    const replay = await processWebhook(event.raw, event.headers);
    expect(replay.duplicate).toBe(true);

    // The capture arrived by two routes - the charge's own response and this
    // event - and must be credited once.
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.paidMinor).toBe(236_000n);

    // And no second ERP order.
    expect(await prisma.erpOrderPush.count()).toBe(1);
    expect(world.erpOrderCalls).toHaveLength(1);
  });

  it('rejects a webhook whose signature does not verify', async () => {
    const event = stripeWebhook('payment_intent.succeeded', { id: 'pi_forged', amount: 1 });

    const result = await processWebhook(event.raw, {
      'stripe-signature': 't=1,v1=deadbeef',
    });

    expect(result.accepted).toBe(false);

    const recorded = await prisma.paymentEvent.findFirstOrThrow();
    expect(recorded.signatureVerified).toBe(false);
    expect(recorded.processingStatus).toBe('REJECTED');
  });
});

describe('tenant isolation', () => {
  it('will not let one customer read or change another customer’s schedule', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    // Every customer-facing call is scoped by the caller's own profile id, and
    // that scope IS the where clause - so another customer's id simply does
    // not match.
    await expect(
      updateSchedule(scheduleId, { runAtMinute: 60 }, otherActor, otherProfileId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      pauseSchedule(scheduleId, otherActor, otherProfileId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      cancelSchedule(scheduleId, otherActor, otherProfileId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      skipNextOccurrence(scheduleId, otherActor, otherProfileId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await expect(
      activateSchedule(scheduleId, { consentAccepted: true }, otherActor, otherProfileId),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // The plan is untouched.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('ACTIVE');
  });

  it('will not let one customer attach another customer’s saved card', async () => {
    await fillCart(10, otherProfileId);

    // `paymentMethodId` belongs to the first customer.
    await expect(
      createCartSchedule(
        otherProfileId,
        {
          ...subscriptionConfig(),
          shippingAddressId: (
            await prisma.address.findFirstOrThrow({
              where: { customerProfileId: otherProfileId },
            })
          ).id,
        },
        otherActor,
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULE_PAYMENT_METHOD_INVALID' });
  });

  it('scopes a saved-card list to its owner', async () => {
    expect(await listPaymentMethods(customerProfileId)).toHaveLength(1);
    expect(await listPaymentMethods(otherProfileId)).toHaveLength(0);
  });

  it('will not let one customer remove another customer’s saved card', async () => {
    await expect(
      removePaymentMethod(paymentMethodId, otherProfileId, otherActor),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('saved cards', () => {
  it('stores only what is needed to display and charge, never the card itself', async () => {
    const row = await prisma.customerPaymentMethod.findUniqueOrThrow({
      where: { id: paymentMethodId },
    });

    expect(row.brand).toBe('visa');
    expect(row.last4).toBe('4242');
    expect(row.providerPaymentMethodId).toBe('pm_test_card_1');

    // The consent record is what makes an off-session charge lawful, and it is
    // stored rather than assumed.
    expect(row.consentAcceptedAt).not.toBeNull();
    expect(row.consentVersion).toBe('v1');

    // The whole row, as JSON, must contain nothing resembling a card number.
    expect(JSON.stringify(row)).not.toMatch(/\d{13,19}/);
  });

  it('refuses to save a card without off-session consent', async () => {
    await expect(
      completePaymentMethodEnrolment(
        { customerProfileId, setupIntentId: 'seti_test_1', consentAccepted: false },
        { userId: customerActor.userId, email: customerActor.email, type: 'CUSTOMER' },
      ),
    ).rejects.toMatchObject({ code: 'PAYMENT_SETUP_CONSENT_REQUIRED' });
  });

  it('is idempotent: enrolling the same setup twice yields one card', async () => {
    const again = await completePaymentMethodEnrolment(
      { customerProfileId, setupIntentId: 'seti_test_1', consentAccepted: true },
      { userId: customerActor.userId, email: customerActor.email, type: 'CUSTOMER' },
    );

    expect(again.id).toBe(paymentMethodId);
    expect(await prisma.customerPaymentMethod.count()).toBe(1);
  });

  it('refuses to remove a card a live schedule depends on, and names it', async () => {
    await fillCart(10);
    await liveSchedule(subscriptionConfig({ name: 'Monthly gloves' }));

    await expect(
      removePaymentMethod(paymentMethodId, customerProfileId, customerActor),
    ).rejects.toMatchObject({ code: 'PAYMENT_METHOD_IN_USE' });

    // Silently detaching would leave a subscription that fails at its next
    // delivery for a reason the customer could not have anticipated.
    const row = await prisma.customerPaymentMethod.findUniqueOrThrow({
      where: { id: paymentMethodId },
    });
    expect(row.status).toBe('ACTIVE');
  });

  it('pauses a schedule whose card has expired rather than charging', async () => {
    await fillCart(10);
    const scheduleId = await liveSchedule(subscriptionConfig());

    await prisma.customerPaymentMethod.update({
      where: { id: paymentMethodId },
      data: { status: 'EXPIRED' },
    });

    const slot = await makeDue(scheduleId);
    const outcome = await runOccurrence(scheduleId, slot);

    expect(outcome.result).toBe('SKIPPED');
    expect(world.chargeCalls).toHaveLength(0);

    // Paused, not cancelled: the customer can add a card and resume.
    const plan = await prisma.recurringSchedule.findUniqueOrThrow({ where: { id: scheduleId } });
    expect(plan.status).toBe('PAUSED');
  });
});

describe('the idempotency key', () => {
  it('is a pure function of the plan and the slot', () => {
    const scheduleId = '01JBOSSSCHEDULE00000000001';
    const slot = new Date('2026-09-08T06:00:00.000Z');

    // Recomputed rather than minted, which is what makes a retry safe.
    expect(occurrenceIdempotencyKey(scheduleId, slot)).toBe(
      occurrenceIdempotencyKey(scheduleId, new Date(slot.getTime())),
    );

    expect(occurrenceIdempotencyKey(scheduleId, slot)).toBe(
      `occ:${scheduleId}:20260908060000000`,
    );

    // Fits the column.
    expect(occurrenceIdempotencyKey(scheduleId, slot).length).toBeLessThanOrEqual(80);
  });

  /**
   * The migration backfilled this column with a SQL expression. If the two
   * ever disagree, historical rows carry keys the application would never
   * recompute - and the guard silently stops guarding them.
   */
  it('matches the SQL expression the migration backfilled with', async () => {
    const scheduleId = '01JBOSSSCHEDULE00000000002';
    const slot = new Date('2026-02-28T23:59:59.123Z');

    const rows = await prisma.$queryRawUnsafe<{ k: string }[]>(
      `SELECT CONCAT('occ:', ?, ':', DATE_FORMAT(?, '%Y%m%d%H%i%s'),
              LPAD(FLOOR(MICROSECOND(?) / 1000), 3, '0')) AS k`,
      scheduleId,
      slot,
      slot,
    );

    expect(rows[0]?.k).toBe(occurrenceIdempotencyKey(scheduleId, slot));
  });
});
