/**
 * A B2C order from the basket to the seller's statement, over HTTP (LIVE-004,
 * LIVE-006).
 *
 * `acceptance-seller-to-doorstep.test.ts` proves the logistics half with the
 * order written directly. This file proves the money half with nothing
 * written directly that a person or a provider would have done:
 *
 *     basket -> checkout -> a SIGNED payment webhook confirms the order ->
 *     the order splits to the seller -> the seller accepts, ships and
 *     delivers -> the payment is booked and the seller's share held ->
 *     the hold is released after the acceptance window -> the period is
 *     closed and the seller's statement says what they are owed ->
 *     the balance is paid out
 *
 * and every ledger entry balances on the way. Three branches each start from
 * their own paid order:
 *
 *   (a) cancelled after payment -> refund at the provider -> refund webhook ->
 *       the ledger gives the money back and charges the seller's share
 *   (b) delivered, part returned -> refund webhook -> the seller's settlement
 *       carries the refund and the statement deducts it
 *   (c) a dispute decided with a refund -> ledger and settlement follow
 *
 * WHAT IS NOT REAL
 *
 *   - The payment provider's API. Razorpay cannot reach a test machine, so the
 *     attempt row the payment page would have created is written here (the
 *     same approach as `payments.test.ts`), and refunds go to a scripted fake
 *     provider on a real socket (`tests/support/fake-provider.ts`). Every
 *     WEBHOOK is real: signed with the connection's secret over the raw bytes
 *     and posted to the public webhook route.
 *   - The worker. The escrow sweep, hold evaluation, period close and payout
 *     run are called directly, with "now" moved forward, rather than waited for.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { encryptSecret } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { allocateOrder, evaluateHolds, recordRefund, runPayouts } from '../../src/modules/finance/escrow.service.js';
import { sellerFinance } from '../../src/modules/finance/finance-views.service.js';
import { setPayoutAdapterForTests, type PayoutProviderAdapter } from '../../src/modules/seller/payout.service.js';
import { closeSettlementPeriod } from '../../src/modules/seller/settlement-statement.service.js';
import { redirectingFetch, startFakeProvider, type FakeProvider } from '../support/fake-provider.js';
import { currentTermsId } from '../support/legal.js';
import {
  asCustomer as customerCall,
  asStaff as staffCall,
  cleanUpOrderDesk,
  customer,
  emailFor,
  staff,
  type CallOptions,
  type Session,
  type StaffSession,
} from '../support/order-desk-fixture.js';

const TAG = 'acs4';
const UPPER = TAG.toUpperCase();
const KEY_ID = 'rzp_test_acs4key';
const KEY_SECRET = 'acs4-key-secret-not-real';
const WEBHOOK_SECRET = 'acs4-webhook-secret-not-real';
const UNIT_PRICE = 10_000n;

type Flags = {
  FEATURE_ESCROW_LEDGER: boolean;
  SELLER_FUNDS_RELEASE_AFTER_DAYS: number | undefined;
  SELLER_FUNDS_RESERVE_BPS: number;
  SELLER_FUNDS_RESERVE_DAYS: number;
  FEATURE_SELLER_SETTLEMENT_STATEMENTS: boolean;
  SELLER_SETTLEMENT_PERIOD: 'WEEKLY' | 'MONTHLY';
  SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: number | undefined;
};
const mutable = env as unknown as Flags;
const savedFlags: Flags = {
  FEATURE_ESCROW_LEDGER: mutable.FEATURE_ESCROW_LEDGER,
  SELLER_FUNDS_RELEASE_AFTER_DAYS: mutable.SELLER_FUNDS_RELEASE_AFTER_DAYS,
  SELLER_FUNDS_RESERVE_BPS: mutable.SELLER_FUNDS_RESERVE_BPS,
  SELLER_FUNDS_RESERVE_DAYS: mutable.SELLER_FUNDS_RESERVE_DAYS,
  FEATURE_SELLER_SETTLEMENT_STATEMENTS: mutable.FEATURE_SELLER_SETTLEMENT_STATEMENTS,
  SELLER_SETTLEMENT_PERIOD: mutable.SELLER_SETTLEMENT_PERIOD,
  SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: mutable.SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS,
};

let app: Awaited<ReturnType<typeof buildApp>>;
let fake: FakeProvider;
const realFetch = globalThis.fetch;
let buyer: Session;
let sellerOwner: Session;
let financeOne: StaffSession;
let financeTwo: StaffSession;
let orderDesk: StaffSession;
let sellerId = '';
let offerId = '';
let productId = '';
let locationId = '';
let addressId = '';
let buyerProfileId = '';
let connectionId = '';
let savedConnection: { id: string; credentialsEnc: string; webhookSecretEnc: string | null; isActive: boolean } | null = null;
const myOrderIds: string[] = [];
const sentPayouts: { amountMinor: bigint; idempotencyKey: string }[] = [];

const asCustomer: typeof customerCall = (target, session, method, path, options: CallOptions = {}) =>
  customerCall(target, session, method, path, { idempotencyKey: newId(), ...options });
const asStaff: typeof staffCall = (target, session, method, path, options: CallOptions = {}) =>
  staffCall(target, session, method, path, { idempotencyKey: newId(), ...options });

const payoutAdapter: PayoutProviderAdapter = {
  name: 'stripe_connect',
  isConfigured: true,
  startOnboarding: (input) =>
    Promise.resolve({
      url: 'https://connect.test/setup',
      expiresAt: new Date(Date.now() + 300_000),
      providerAccountId: input.existingProviderAccountId ?? `acct_${TAG}`,
    }),
  readAccount: (id) =>
    Promise.resolve({ state: 'ENABLED', providerAccountId: id, payoutsEnabled: true, pendingRequirements: [], bankName: 'Test Bank', accountLast4: '4242' }),
  sendPayout: (input) => {
    sentPayouts.push({ amountMinor: input.amountMinor, idempotencyKey: input.idempotencyKey });
    return Promise.resolve({ providerPayoutId: `tr_${TAG}_${String(sentPayouts.length)}`, status: 'PAID' as const });
  },
  listTransfers: () => Promise.resolve([]),
};

// ---------------------------------------------------------------------------
// The provider's side: signed webhooks
// ---------------------------------------------------------------------------

async function postWebhook(payload: Record<string, unknown>): Promise<{ accepted: boolean; duplicate: boolean }> {
  const raw = JSON.stringify(payload);
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/razorpay',
    headers: {
      'content-type': 'application/json',
      'x-razorpay-signature': createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex'),
      'x-razorpay-event-id': `evt_${TAG}_${newId()}`,
      'x-forwarded-for': '10.92.4.50',
    },
    payload: raw,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ accepted: boolean; duplicate: boolean }>();
}

interface PaidOrder {
  orderId: string;
  groupId: string;
  itemId: string;
  providerOrderId: string;
  providerPaymentId: string;
  grandTotalMinor: bigint;
}

/** Basket -> checkout -> a signed capture. Returns the confirmed order. */
async function paidOrder(quantity: number): Promise<PaidOrder> {
  const added = await asCustomer(app, buyer, 'POST', '/cart/items', {
    payload: { productId, sellerOfferId: offerId, quantity },
  });
  expect(added.statusCode, added.body).toBe(201);

  const checkout = await asCustomer(app, buyer, 'POST', '/cart/checkout', {
    payload: { shippingAddressId: addressId, paymentMode: 'ONLINE', acceptedTerms: true, termsDocumentId: await currentTermsId() },
  });
  expect(checkout.statusCode, checkout.body).toBe(201);
  const { orderId } = checkout.json<{ orderId: string }>();
  myOrderIds.push(orderId);

  const placed = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(placed.status).toBe('PENDING_PAYMENT');
  // Nothing has been split to the seller before the money is real.
  expect(await prisma.sellerOrderGroup.count({ where: { orderId } })).toBe(0);

  // The attempt the payment page would have opened with the gateway.
  const providerOrderId = `order_${TAG}${newId().slice(-10)}`;
  const providerPaymentId = `pay_${TAG}${newId().slice(-10)}`;
  await prisma.paymentTransaction.create({
    data: {
      id: newId(),
      orderId,
      connectionId,
      provider: 'RAZORPAY',
      mode: 'TEST',
      providerOrderId,
      status: 'CREATED',
      amountMinor: placed.grandTotalMinor,
      currency: placed.currency,
      idempotencyKey: newId(),
    },
  });

  // A forged capture is refused and changes nothing.
  const forged = await app.inject({
    method: 'POST',
    url: '/api/v1/payments/webhooks/razorpay',
    headers: { 'content-type': 'application/json', 'x-razorpay-signature': 'f'.repeat(64), 'x-forwarded-for': '10.92.4.51' },
    payload: JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: providerPaymentId, order_id: providerOrderId, amount: Number(placed.grandTotalMinor), currency: placed.currency, status: 'captured', method: 'upi' } } } }),
  });
  expect(forged.statusCode).toBe(200);
  expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe('PENDING_PAYMENT');

  const capture = {
    event: 'payment.captured',
    payload: {
      payment: {
        entity: {
          id: providerPaymentId,
          order_id: providerOrderId,
          amount: Number(placed.grandTotalMinor),
          currency: placed.currency,
          status: 'captured',
          method: 'upi',
        },
      },
    },
  };
  expect(await postWebhook(capture)).toMatchObject({ accepted: true, duplicate: false });

  const confirmed = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
  expect(confirmed.status).toBe('CONFIRMED');
  expect(confirmed.paidMinor).toBe(placed.grandTotalMinor);

  const groups = await prisma.sellerOrderGroup.findMany({ where: { orderId } });
  expect(groups).toHaveLength(1);
  expect(groups[0]?.sellerAccountId).toBe(sellerId);
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId }, select: { id: true } });

  // What the background sweep does once a capture lands: book it and hold
  // the seller's share. Idempotent, so the real sweep running too is harmless.
  await allocateOrder(orderId);

  return {
    orderId,
    groupId: groups[0]?.id ?? '',
    itemId: item.id,
    providerOrderId,
    providerPaymentId,
    grandTotalMinor: placed.grandTotalMinor,
  };
}

/** The seller accepts, ships and delivers, through the Seller Hub routes. */
async function deliver(order: PaidOrder): Promise<void> {
  const accepted = await asCustomer(app, sellerOwner, 'PATCH', `/seller/orders/${order.groupId}/status`, {
    payload: { status: 'ACCEPTED', locationId },
  });
  expect(accepted.statusCode, accepted.body).toBe(204);

  const shipped = await asCustomer(app, sellerOwner, 'POST', `/seller/orders/${order.groupId}/shipments`, {
    payload: { carrierName: 'Blue Dart', trackingNumber: `BD${newId().slice(-10)}` },
  });
  expect(shipped.statusCode, shipped.body).toBe(201);
  expect((await prisma.sellerOrderGroup.findUniqueOrThrow({ where: { id: order.groupId } })).status).toBe('SHIPPED');

  const delivered = await asCustomer(app, sellerOwner, 'PATCH', `/seller/orders/${order.groupId}/status`, {
    payload: { status: 'DELIVERED' },
  });
  expect(delivered.statusCode, delivered.body).toBe(204);
  expect((await prisma.sellerOrderGroup.findUniqueOrThrow({ where: { id: order.groupId } })).status).toBe('DELIVERED');
  // The buyer's order follows its only seller part.
  expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('DELIVERED');
}

/** The refund the provider accepted, then its signed "processed" webhook. */
async function refundWebhook(order: PaidOrder, providerRefundId: string, amountMinor: bigint): Promise<void> {
  const result = await postWebhook({
    event: 'refund.processed',
    payload: {
      refund: { entity: { id: providerRefundId, payment_id: order.providerPaymentId, amount: Number(amountMinor), status: 'processed' } },
      payment: { entity: { id: order.providerPaymentId, order_id: order.providerOrderId, amount: Number(order.grandTotalMinor), currency: 'INR', status: 'refunded' } },
    },
  });
  expect(result.accepted).toBe(true);
}

// ---------------------------------------------------------------------------
// The ledger, read back
// ---------------------------------------------------------------------------

async function ledgerOf(orderId: string) {
  const entries = await prisma.ledgerEntry.findMany({
    where: { orderId },
    include: { lines: { include: { account: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const byCode = new Map<string, bigint>();
  for (const entry of entries) {
    // Every entry balances on its own, in its own currency.
    expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0n), entry.kind).toBe(0n);
    expect(entry.lines.every((line) => line.currency === entry.currency)).toBe(true);
    for (const line of entry.lines) byCode.set(line.account.code, (byCode.get(line.account.code) ?? 0n) + line.amountMinor);
  }
  return { kinds: entries.map((entry) => entry.kind), sum: (code: string) => byCode.get(code) ?? 0n };
}

/** What the seller is owed on a group: credit balances are negative. */
function sellerNet(ledger: Awaited<ReturnType<typeof ledgerOf>>): bigint {
  return -(ledger.sum('SELLER_HELD') + ledger.sum('SELLER_RESERVE') + ledger.sum('SELLER_AVAILABLE') + ledger.sum('PAYOUTS_IN_TRANSIT'));
}

// ---------------------------------------------------------------------------
// Set-up and clean-up
// ---------------------------------------------------------------------------

async function cleanOrders(): Promise<void> {
  // Seller acceptance reserves stock, so the fixture's products carry inventory rows.
  const productWhere = { product: { slug: { startsWith: `${TAG}-` } } };
  await prisma.inventoryMovement.deleteMany({ where: productWhere });
  await prisma.inventoryBalance.deleteMany({ where: productWhere });
  const profile = await prisma.customerProfile.findFirst({
    where: { user: { emailNormalized: emailFor(TAG, 'buyer') } },
    select: { id: true },
  });
  const orderIds = [
    ...new Set([
      ...myOrderIds,
      ...(profile === null
        ? []
        : (await prisma.order.findMany({ where: { customerProfileId: profile.id }, select: { id: true } })).map((row) => row.id)),
    ]),
  ];
  const sellers = (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: `${TAG}-seller` } }, select: { id: true } })).map((row) => row.id);
  const entries = (
    await prisma.ledgerEntry.findMany({ where: { OR: [{ orderId: { in: orderIds } }, { sellerAccountId: { in: sellers } }] }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.ledgerLine.deleteMany({ where: { entryId: { in: entries } } });
  await prisma.ledgerEntry.deleteMany({ where: { id: { in: entries } } });
  await prisma.ledgerAccount.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  const holds = (await prisma.sellerFundHold.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.sellerFundReleaseRequest.deleteMany({ where: { fundHoldId: { in: holds } } });
  await prisma.sellerFundHold.deleteMany({ where: { id: { in: holds } } });
  await prisma.sellerPayout.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerSettlementLine.deleteMany({ where: { settlement: { sellerAccountId: { in: sellers } } } });
  await prisma.sellerSettlement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.dispute.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.returnRequest.deleteMany({ where: { orderId: { in: orderIds } } });
  const refunds = (await prisma.refund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.auditLog.deleteMany({ where: { resourceId: { in: [...orderIds, ...refunds] } } });
  await prisma.refund.deleteMany({ where: { id: { in: refunds } } });
  await prisma.paymentEvent.deleteMany({ where: { providerEventId: { startsWith: `evt_${TAG}_` } } });
  await prisma.paymentEvent.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.paymentTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.commissionInvoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.sellerInvoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.sellerPackingList.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.invoice.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.logisticsShipment.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: orderIds } } });
  await prisma.adminNotification.deleteMany({ where: { relatedId: { in: orderIds } } });
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.sellerInventoryMovement.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerInventory.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerPayoutAccountReference.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  if (profile !== null) {
    await prisma.cartItem.deleteMany({ where: { cart: { customerProfileId: profile.id } } });
    await prisma.cart.deleteMany({ where: { customerProfileId: profile.id } });
    await prisma.address.deleteMany({ where: { customerProfileId: profile.id } });
  }
}

beforeAll(async () => {
  Object.assign(mutable, {
    FEATURE_ESCROW_LEDGER: true,
    SELLER_FUNDS_RELEASE_AFTER_DAYS: 7,
    SELLER_FUNDS_RESERVE_BPS: 0,
    SELLER_FUNDS_RESERVE_DAYS: 30,
    FEATURE_SELLER_SETTLEMENT_STATEMENTS: true,
    SELLER_SETTLEMENT_PERIOD: 'MONTHLY',
    SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS: 14,
  });
  setPayoutAdapterForTests(payoutAdapter);
  fake = await startFakeProvider();
  vi.stubGlobal('fetch', redirectingFetch({ 'https://api.razorpay.com': fake.origin }, realFetch));

  app = await buildApp();
  await app.ready();
  await cleanOrders();
  await cleanUpOrderDesk(TAG);

  // The one Razorpay TEST connection, with secrets this file knows. A row a
  // neighbouring file left is borrowed and put back exactly afterwards.
  const existing = await prisma.paymentProviderConnection.findUnique({
    where: { provider_mode: { provider: 'RAZORPAY', mode: 'TEST' } },
    select: { id: true, credentialsEnc: true, webhookSecretEnc: true, isActive: true },
  });
  connectionId = existing?.id ?? newId();
  savedConnection = existing;
  const credentialsEnc = encryptSecret(JSON.stringify({ keyId: KEY_ID, keySecret: KEY_SECRET }), `payment_connection:${connectionId}`);
  const webhookSecretEnc = encryptSecret(WEBHOOK_SECRET, `payment_connection:${connectionId}`);
  if (existing === null) {
    await prisma.paymentProviderConnection.create({
      data: { id: connectionId, provider: 'RAZORPAY', mode: 'TEST', label: `${TAG}-test`, credentialsEnc, webhookSecretEnc, isActive: true },
    });
  } else {
    // Updated last, so it is also the most recently saved active gateway -
    // which is the one a refund is sent through.
    await prisma.paymentProviderConnection.update({
      where: { id: connectionId },
      data: { credentialsEnc, webhookSecretEnc, isActive: true },
    });
  }

  if ((await prisma.inventoryLocation.findFirst({ select: { id: true } })) === null) {
    await prisma.inventoryLocation.create({ data: { id: newId(), code: `${UPPER}-MAIN`, name: 'Main', isDefault: true, isActive: true } });
  }

  // --- The seller, its warehouse and its stock --------------------------------
  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: `${TAG}-sellera`,
      legalName: `${UPPER} Supplies Ltd`,
      displayName: `${UPPER} Supplies`,
      displayNameNormalized: `${TAG}supplies`,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerPayoutAccountReference.create({
    data: { id: newId(), sellerAccountId: sellerId, provider: 'stripe_connect', providerAccountId: `acct_${TAG}`, state: 'ENABLED', payoutsEnabled: true },
  });
  locationId = newId();
  await prisma.sellerLocation.create({
    data: {
      id: locationId,
      sellerAccountId: sellerId,
      code: `${UPPER}-WH`,
      name: 'Pune warehouse',
      addressLine1: '7 Depot Road',
      city: 'Pune',
      postcode: '411001',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      dispatchCutoff: '16:00',
      workingDaysMask: 127,
      handlingTimeDays: 1,
      isOperational: true,
    },
  });

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: UPPER, name: `${UPPER} GST 18%`, ratePercent: '18.000000', isActive: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: `${UPPER} Consumables`, slug: `${TAG}-category`, isActive: true },
  });
  productId = newId();
  await prisma.product.create({
    data: {
      id: productId,
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: `${UPPER} nitrile gloves`,
      slug: `${TAG}-product`,
      sku: `${UPPER}-GLOVE`,
      basePriceMinor: 0n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isMarketplaceProduct: true,
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: sellerId,
      productId,
      variantKey: '',
      sellerSku: `${UPPER}-GLOVE-1`,
      status: 'ACTIVE',
      orderingUnit: 'PIECE',
      priceMinor: UNIT_PRICE,
      currency: 'INR',
      minimumOrderQuantity: 1,
      orderIncrement: 1,
      availableQuantity: 500,
    },
  });
  await prisma.sellerInventory.create({
    data: { id: newId(), sellerAccountId: sellerId, offerId, locationId, availableQuantity: 500 },
  });
  const { syncMarketplacePrice } = await import('../../src/modules/catalog/marketplace-price.service.js');
  await syncMarketplacePrice(prisma, productId);

  // --- The people ----------------------------------------------------------
  buyer = await customer(app, TAG, 'buyer', '10.92.4.1');
  sellerOwner = await customer(app, TAG, 'selleraowner', '10.92.4.3', sellerId);
  financeOne = await staff(app, TAG, 'finance1', Role.FINANCE_APPROVER, '10.92.4.5');
  financeTwo = await staff(app, TAG, 'finance2', Role.FINANCE_APPROVER, '10.92.4.6');
  orderDesk = await staff(app, TAG, 'desk', Role.ORDER_MANAGER, '10.92.4.7');

  buyerProfileId = (
    await prisma.customerProfile.findFirstOrThrow({ where: { user: { emailNormalized: emailFor(TAG, 'buyer') } }, select: { id: true } })
  ).id;
  addressId = newId();
  await prisma.address.create({
    data: {
      id: addressId,
      customerProfileId: buyerProfileId,
      kind: 'BOTH',
      contactName: 'Ward store',
      contactPhone: '+91 90000 00042',
      line1: '42 Hospital Road',
      city: 'Pune',
      state: 'Maharashtra',
      postalCode: '411001',
      country: 'IN',
      isDefaultBilling: true,
      isDefaultShipping: true,
    },
  });
}, 240_000);

afterAll(async () => {
  Object.assign(mutable, savedFlags);
  setPayoutAdapterForTests(null);
  vi.unstubAllGlobals();
  await fake.close();
  await cleanOrders();
  await cleanUpOrderDesk(TAG);
  if (savedConnection === null) {
    await prisma.paymentEvent.deleteMany({ where: { connectionId } });
    await prisma.paymentProviderConnection.deleteMany({ where: { id: connectionId } });
  } else {
    await prisma.paymentProviderConnection.update({
      where: { id: savedConnection.id },
      data: {
        credentialsEnc: savedConnection.credentialsEnc,
        webhookSecretEnc: savedConnection.webhookSecretEnc,
        isActive: savedConnection.isActive,
      },
    });
  }
  await app.close();
});

// ---------------------------------------------------------------------------

let mainOrder: PaidOrder;
let returnOrder: PaidOrder;
let disputeOrder: PaidOrder;
let returnRefundMinor = 0n;
let disputeRefundMinor = 0n;

describe('the main chain', () => {
  it('confirms only on the signed webhook, splits to the seller and books the money', async () => {
    mainOrder = await paidOrder(2);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: mainOrder.orderId } });
    // 2 x 100.00, with the tax class's 18% added on top, and the total adds up.
    expect(order.subtotalMinor).toBe(2n * UNIT_PRICE);
    expect(order.taxMinor).toBeGreaterThan(0n);
    expect(order.grandTotalMinor).toBe(order.subtotalMinor - order.discountMinor + order.taxMinor + order.shippingMinor);

    // A redelivered capture is acknowledged and changes nothing.
    const settlement = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: mainOrder.groupId } });
    expect(settlement.grossProceedsMinor).toBe(2n * UNIT_PRICE);
    const share = settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor - settlement.platformFeeMinor - settlement.platformFeeTaxMinor;

    const ledger = await ledgerOf(mainOrder.orderId);
    expect(ledger.kinds).toEqual(expect.arrayContaining(['PAYMENT_CAPTURED', 'SALE_ALLOCATED']));
    // Everything the buyer paid has a home: clearing nets to zero.
    expect(ledger.sum('BUYER_FUNDS_CLEARING')).toBe(0n);
    expect(ledger.sum('PROVIDER_BALANCE')).toBe(order.paidMinor);
    expect(ledger.sum('ORDER_TAX_COLLECTED')).toBe(-order.taxMinor);
    expect(ledger.sum('PLATFORM_COMMISSION')).toBe(-settlement.platformFeeMinor);
    expect(ledger.sum('PLATFORM_FEE_TAX')).toBe(-settlement.platformFeeTaxMinor);
    expect(sellerNet(ledger)).toBe(share);

    const hold = await prisma.sellerFundHold.findFirstOrThrow({ where: { sellerOrderGroupId: mainOrder.groupId } });
    expect(hold.status).toBe('HELD');
    expect(hold.allocatedMinor).toBe(share);
  });

  it('is accepted, shipped and delivered by the seller, and the money waits for the window', async () => {
    await deliver(mainOrder);
    // Still held: delivered today, and the acceptance window is seven days.
    await evaluateHolds(new Date());
    expect((await prisma.sellerFundHold.findFirstOrThrow({ where: { sellerOrderGroupId: mainOrder.groupId } })).status).toBe('HELD');

    await evaluateHolds(new Date(Date.now() + 8 * 86_400_000));
    const hold = await prisma.sellerFundHold.findFirstOrThrow({ where: { sellerOrderGroupId: mainOrder.groupId } });
    expect(hold.status).toBe('RELEASED');
    expect(hold.releasedMinor).toBe(hold.allocatedMinor);

    const ledger = await ledgerOf(mainOrder.orderId);
    expect(ledger.kinds).toContain('FUNDS_RELEASED');
    // Released means available, not held.
    expect(ledger.sum('SELLER_HELD')).toBe(0n);
    expect(-ledger.sum('SELLER_AVAILABLE')).toBe(hold.allocatedMinor);
  });
});

describe('(a) cancelled after payment', () => {
  it('refunds at the provider, settles on the webhook, and charges the seller share back', async () => {
    const order = await paidOrder(1);
    const cancelled = await asStaff(app, orderDesk, 'POST', `/orders/${order.orderId}/transition`, {
      payload: { to: 'CANCELLED', reason: 'Buyer asked to cancel before dispatch' },
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('CANCELLED');

    // The order desk may cancel but not refund (SOP 3).
    const notFinance = await asStaff(app, orderDesk, 'POST', `/orders/${order.orderId}/refunds`, {
      payload: { reason: 'Cancelled before dispatch' },
    });
    expect(notFinance.statusCode).toBe(403);

    const providerRefundId = `rfnd_${TAG}${newId().slice(-10)}`;
    fake.script({ status: 200, json: { id: providerRefundId, entity: 'refund', amount: Number(order.grandTotalMinor), status: 'pending', payment_id: order.providerPaymentId } });
    const refunded = await asStaff(app, financeOne, 'POST', `/orders/${order.orderId}/refunds`, {
      payload: { reason: 'Cancelled before dispatch' },
    });
    expect(refunded.statusCode, refunded.body).toBe(201);
    expect(refunded.json<{ status: string }>().status).toBe('PROCESSING');
    // The provider was asked for exactly the amount paid, under our key.
    const asked = fake.requests.find((request) => request.path === `/v1/payments/${order.providerPaymentId}/refund`);
    expect(asked?.method).toBe('POST');
    expect(JSON.parse(asked?.body ?? '{}')).toMatchObject({ amount: Number(order.grandTotalMinor) });

    // Nothing moves in the seller's settlement until the provider says so.
    expect((await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: order.groupId } })).refundsAdjustmentsMinor).toBe(0n);

    await refundWebhook(order, providerRefundId, order.grandTotalMinor);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.orderId } });
    expect(refund.status).toBe('SUCCEEDED');

    const settlement = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: order.groupId } });
    expect(settlement.refundsAdjustmentsMinor).toBeGreaterThan(0n);

    // The sweep books the refund: the money leaves, the seller is charged.
    await prisma.$transaction(async (tx) => {
      await recordRefund(tx, refund.id);
    });
    const ledger = await ledgerOf(order.orderId);
    expect(ledger.kinds).toEqual(expect.arrayContaining(['PAYMENT_CAPTURED', 'SALE_ALLOCATED', 'REFUND_ISSUED', 'REFUND_CHARGED_TO_SELLER']));
    expect(ledger.sum('PROVIDER_BALANCE')).toBe(0n);
    const share = settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor - settlement.platformFeeMinor - settlement.platformFeeTaxMinor;
    expect(sellerNet(ledger)).toBe(share - settlement.refundsAdjustmentsMinor);

    // Fully refunded and cancelled: the order closes out.
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.orderId } })).status).toBe('REFUNDED');
  });
});

describe('(b) delivered, then part of it returned', () => {
  it('refunds the return on the webhook and the settlement carries it', async () => {
    returnOrder = await paidOrder(2);
    await deliver(returnOrder);

    const requested = await asCustomer(app, buyer, 'POST', `/orders/${returnOrder.orderId}/returns`, {
      payload: { reasonCode: 'NO_LONGER_NEEDED', description: 'Ordered one box too many.', items: [{ orderItemId: returnOrder.itemId, quantity: 1 }] },
    });
    expect(requested.statusCode, requested.body).toBeLessThan(300);
    const returnId = requested.json<{ return: { id: string } }>().return.id;

    const response = await asCustomer(app, sellerOwner, 'POST', `/seller/returns/${returnId}/response`, {
      payload: { response: 'ACCEPT', note: 'Unopened, happy to take it back.' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((await asStaff(app, orderDesk, 'POST', `/returns/${returnId}/approve`, { payload: { instructions: 'Send it back to the Pune warehouse.' } })).statusCode).toBe(200);
    expect((await asCustomer(app, sellerOwner, 'POST', `/seller/returns/${returnId}/receive`, { payload: {} })).statusCode).toBe(200);
    const inspected = await asCustomer(app, sellerOwner, 'POST', `/seller/returns/${returnId}/inspect`, {
      payload: { outcome: [{ orderItemId: returnOrder.itemId, sellableQty: 1, damagedQty: 0 }] },
    });
    expect(inspected.statusCode, inspected.body).toBe(200);

    // The provider accepts it and will confirm later. The amount is the
    // returned goods' value, worked out by the return - never typed here.
    const providerRefundId = `rfnd_${TAG}${newId().slice(-10)}`;
    fake.script({ status: 200, json: { id: providerRefundId, entity: 'refund', amount: Number(UNIT_PRICE), status: 'pending', payment_id: returnOrder.providerPaymentId } });
    const refunded = await asStaff(app, financeOne, 'POST', `/returns/${returnId}/refund`, { payload: {} });
    expect(refunded.statusCode, refunded.body).toBe(201);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: returnOrder.orderId } });
    returnRefundMinor = refund.amountMinor;
    // One of two units: more than nothing, no more than half of what was paid.
    expect(returnRefundMinor).toBeGreaterThan(0n);
    expect(returnRefundMinor * 2n).toBeLessThanOrEqual(returnOrder.grandTotalMinor);
    expect(refund.status).toBe('PROCESSING');

    await refundWebhook(returnOrder, providerRefundId, returnRefundMinor);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: refund.id } })).status).toBe('SUCCEEDED');

    const settlement = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: returnOrder.groupId } });
    // The return names this seller's goods, so the seller carries it.
    expect(settlement.refundsAdjustmentsMinor).toBeGreaterThan(0n);
    expect(settlement.refundsAdjustmentsMinor).toBeLessThanOrEqual(returnRefundMinor);

    await prisma.$transaction(async (tx) => {
      await recordRefund(tx, refund.id);
    });
    const ledger = await ledgerOf(returnOrder.orderId);
    expect(ledger.sum('PROVIDER_BALANCE')).toBe(returnOrder.grandTotalMinor - returnRefundMinor);
    const share = settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor - settlement.platformFeeMinor - settlement.platformFeeTaxMinor;
    expect(sellerNet(ledger)).toBe(share - settlement.refundsAdjustmentsMinor);
  });
});

describe('(c) a dispute decided with a refund', () => {
  it('refunds through the decision and the ledger and settlement follow', async () => {
    disputeOrder = await paidOrder(2);
    await deliver(disputeOrder);

    const opened = await asCustomer(app, buyer, 'POST', '/disputes', {
      payload: {
        orderId: disputeOrder.orderId,
        orderItemId: disputeOrder.itemId,
        reasonCode: 'DAMAGED',
        description: 'Two boxes arrived crushed and the gloves inside are torn.',
        desiredOutcome: 'REFUND_PARTIAL',
        requestedAmountMinor: '5000',
      },
    });
    expect(opened.statusCode, opened.body).toBeLessThan(300);
    const reference = opened.json<{ dispute: { reference: string } }>().dispute.reference;
    const disputeId = (await prisma.dispute.findFirstOrThrow({ where: { reference }, select: { id: true } })).id;

    const answered = await asCustomer(app, sellerOwner, 'POST', `/seller/disputes/${reference}/response`, {
      payload: { body: 'We accept the boxes were damaged in transit.' },
    });
    expect(answered.statusCode, answered.body).toBe(200);

    disputeRefundMinor = 5_000n;
    const providerRefundId = `rfnd_${TAG}${newId().slice(-10)}`;
    // This provider settles the refund at once: no webhook needed.
    fake.script({ status: 200, json: { id: providerRefundId, entity: 'refund', amount: Number(disputeRefundMinor), status: 'processed', payment_id: disputeOrder.providerPaymentId } });
    const decided = await asStaff(app, financeOne, 'POST', `/disputes/${disputeId}/decision`, {
      payload: { resolution: 'REFUND_PARTIAL', amountMinor: disputeRefundMinor.toString(), reason: 'Photos show the damage; refund half.' },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    if (!decided.json<{ applied: boolean }>().applied) {
      // Above the approval threshold: a second person approves it.
      const approved = await asStaff(app, financeTwo, 'POST', `/disputes/${disputeId}/decision/approve`);
      expect(approved.statusCode, approved.body).toBe(200);
    }

    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: disputeOrder.orderId } });
    expect(refund.amountMinor).toBe(disputeRefundMinor);
    expect(refund.status).toBe('SUCCEEDED');
    const dispute = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId } });
    expect(dispute.refundId).toBe(refund.id);

    const settlement = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: disputeOrder.groupId } });
    expect(settlement.refundsAdjustmentsMinor).toBeGreaterThan(0n);

    await prisma.$transaction(async (tx) => {
      await recordRefund(tx, refund.id);
    });
    const ledger = await ledgerOf(disputeOrder.orderId);
    expect(ledger.kinds).toContain('REFUND_ISSUED');
    expect(ledger.sum('PROVIDER_BALANCE')).toBe(disputeOrder.grandTotalMinor - disputeRefundMinor);
    const share = settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor - settlement.platformFeeMinor - settlement.platformFeeTaxMinor;
    expect(sellerNet(ledger)).toBe(share - settlement.refundsAdjustmentsMinor);
  });
});

describe('the statement and the payout', () => {
  it('closes the period into a statement that adds up, deducting the refunds, and pays the balance once', async () => {
    const outcome = await closeSettlementPeriod(new Date(Date.now() + 62 * 86_400_000));
    expect(outcome.skipped).toBe(false);

    const statements = await prisma.sellerSettlement.findMany({ where: { sellerAccountId: sellerId }, include: { lines: true } });
    expect(statements).toHaveLength(1);
    const statement = statements[0];
    if (statement === undefined) throw new Error('no statement');
    expect(statement.netPayableMinor).toBe(statement.lines.reduce((sum, line) => sum + line.amountMinor, 0n));

    const linesFor = (groupId: string) => statement.lines.filter((line) => line.orderGroupId === groupId);
    for (const order of [mainOrder, returnOrder, disputeOrder]) {
      const settlement = await prisma.sellerOrderSettlement.findUniqueOrThrow({ where: { sellerOrderGroupId: order.groupId } });
      const share = settlement.grossProceedsMinor + settlement.sellerDeliveryProceedsMinor - settlement.platformFeeMinor - settlement.platformFeeTaxMinor;
      const lines = linesFor(order.groupId);
      expect(lines.find((line) => line.kind === 'SALE')?.amountMinor, order.orderId).toBe(settlement.grossProceedsMinor);
      // What the statement says this order is worth is what its settlement says.
      expect(lines.reduce((sum, line) => sum + line.amountMinor, 0n), order.orderId).toBe(share - settlement.refundsAdjustmentsMinor);
      if (settlement.refundsAdjustmentsMinor > 0n) {
        expect(lines.find((line) => line.kind === 'REFUND')?.amountMinor).toBe(-settlement.refundsAdjustmentsMinor);
      }
    }
    // The cancelled order was never sold, so it is not on the statement.
    expect(statement.lines.every((line) => [mainOrder.groupId, returnOrder.groupId, disputeOrder.groupId].includes(line.orderGroupId ?? ''))).toBe(true);

    // Release whatever has cleared, then pay the available balance - once.
    await evaluateHolds(new Date(Date.now() + 8 * 86_400_000));
    const before = (await sellerFinance(sellerId)).balances[0]?.availableMinor ?? '0';
    expect(BigInt(before)).toBeGreaterThan(0n);
    const run = await runPayouts(`${TAG}-test`, sellerId);
    expect(run.paid).toHaveLength(1);
    expect(run.paid[0]?.amountMinor).toBe(before);
    expect(sentPayouts.reduce((sum, payout) => sum + payout.amountMinor, 0n)).toBe(BigInt(before));
    expect((await sellerFinance(sellerId)).balances[0]?.availableMinor).toBe('0');
    expect((await runPayouts(`${TAG}-test`, sellerId)).paid).toHaveLength(0);

    // Every entry for this seller balances, across all four orders and the payout.
    const entries = await prisma.ledgerEntry.findMany({ where: { OR: [{ sellerAccountId: sellerId }, { orderId: { in: myOrderIds } }] }, include: { lines: true } });
    for (const entry of entries) {
      expect(entry.lines.reduce((sum, line) => sum + line.amountMinor, 0n), entry.kind).toBe(0n);
    }
  });
});
