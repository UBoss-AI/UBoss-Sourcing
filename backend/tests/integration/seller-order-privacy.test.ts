/**
 * What a seller is never shown about the buyer.
 *
 * A marketplace that hands a seller the buyer's email, phone or payment
 * reference has handed over its own customer relationship (and, for the
 * payment reference, something a seller has no business holding at all).
 * `readSellerOrder` leaves them out on purpose. This file is the guard so that a
 * later `include` or `select` cannot quietly put them back: it plants a
 * recognisable value in every one of those places, signs in as the seller over
 * HTTP, reads every seller-facing order response, and looks for the values.
 *
 * It searches the raw response text, not just a few named fields, because a
 * leak is by definition a field nobody expected to be there.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { splitOrder } from '../../src/modules/seller/order-split.service.js';

const PASSWORD = 'SellerPrivacy!2026x';
const HUB_PASSWORD = 'SellerPrivacyHub!2026';
const SLUG = 'dod17-seller';
const SELLER_EMAIL = 'dod17-owner@test.local';
const BUYER_EMAIL = 'dod17-buyer-secret@buyers.example';
const BUYER_PHONE = '+919876500017';
const PAYMENT_ORDER_REF = 'order_DOD17ProviderRef';
const PAYMENT_PAYMENT_REF = 'pay_DOD17ProviderPay';
const PAYMENT_SESSION_REF = 'cs_test_DOD17Session';
const ORDER_NUMBER = 'UB-DOD17-000001';

/** Values that must never appear in anything a seller reads. */
const FORBIDDEN = [
  BUYER_EMAIL,
  BUYER_PHONE,
  PAYMENT_ORDER_REF,
  PAYMENT_PAYMENT_REF,
  PAYMENT_SESSION_REF,
  'dod17-key',
];

let app: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
let csrf = '';
let groupId = '';
let orderId = '';

async function cleanUp(): Promise<void> {
  const order = await prisma.order.findFirst({
    where: { orderNumber: ORDER_NUMBER },
    select: { id: true },
  });
  const sellerIds = (
    await prisma.sellerAccount.findMany({ where: { slug: SLUG }, select: { id: true } })
  ).map((row) => row.id);
  const userEmails = [SELLER_EMAIL, BUYER_EMAIL];
  const userIds = (
    await prisma.user.findMany({
      where: { emailNormalized: { in: userEmails } },
      select: { id: true },
    })
  ).map((row) => row.id);

  if (order !== null) {
    await prisma.paymentTransaction.deleteMany({ where: { orderId: order.id } });
    await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: order.id } } });
    await prisma.sellerOrderGroup.deleteMany({ where: { orderId: order.id } });
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    await prisma.orderStatusHistory.deleteMany({ where: { orderId: order.id } });
    await prisma.order.deleteMany({ where: { id: order.id } });
  }
  await prisma.paymentProviderConnection.deleteMany({ where: { label: 'dod17-connection' } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: 'dod17-product' } } });
  await prisma.product.deleteMany({ where: { slug: 'dod17-product' } });
  await prisma.category.deleteMany({ where: { slug: 'dod17-category' } });
  await prisma.taxClass.deleteMany({ where: { code: 'DOD17' } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: userEmails } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function get(url: string): Promise<LightMyRequestResponse> {
  return app.inject({
    method: 'GET',
    url: `/api/v1${url}`,
    headers: { cookie, 'x-csrf-token': csrf, 'x-forwarded-for': '203.0.113.171' },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: 'DOD17', name: 'DOD17', ratePercent: '12.000000', isActive: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'DOD17', slug: 'dod17-category', isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Privacy product',
      slug: 'dod17-product',
      sku: 'DOD17-1',
      basePriceMinor: 10_000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });

  const sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      slug: SLUG,
      legalName: 'Dod17 Ltd',
      displayName: 'Dod17',
      displayNameNormalized: 'dod17',
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  const offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: sellerId,
      productId: product.id,
      variantKey: '',
      sellerSku: 'D17-1',
      status: 'ACTIVE',
      priceMinor: 10_000n,
      currency: 'INR',
    },
  });

  // The seller, who signs in like any customer and then opens the Seller Hub.
  const sellerUser = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: SELLER_EMAIL,
      emailNormalized: SELLER_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const sellerProfile = await prisma.customerProfile.create({
    data: { id: newId(), userId: sellerUser.id, fullName: 'Seller Owner' },
  });
  await prisma.sellerMember.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      customerProfileId: sellerProfile.id,
      role: 'OWNER',
      passwordHash: await hashPassword(HUB_PASSWORD),
      passwordSetAt: new Date(),
    },
  });

  // The buyer, with a recognisable email and phone.
  const buyerUser = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: BUYER_EMAIL,
      emailNormalized: BUYER_EMAIL,
      passwordHash: 'x',
      status: 'ACTIVE',
      phone: BUYER_PHONE,
    },
  });
  const buyerProfile = await prisma.customerProfile.create({
    data: { id: newId(), userId: buyerUser.id, fullName: 'Private Buyer', phone: BUYER_PHONE },
  });

  orderId = newId();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: ORDER_NUMBER,
      customerProfileId: buyerProfile.id,
      status: 'CONFIRMED',
      currency: 'INR',
      subtotalMinor: 10_000n,
      discountMinor: 0n,
      taxMinor: 1_200n,
      shippingMinor: 0n,
      grandTotalMinor: 11_200n,
      shippingAddressJson: {
        line1: '1 Test Road',
        city: 'Pune',
        postalCode: '411001',
        countryCode: 'IN',
      },
      billingAddressJson: {
        line1: '1 Test Road',
        city: 'Pune',
        postalCode: '411001',
        countryCode: 'IN',
      },
    },
  });
  await prisma.orderItem.create({
    data: {
      id: newId(),
      orderId,
      productId: product.id,
      sellerOfferId: offerId,
      nameSnapshot: 'Privacy product',
      skuSnapshot: 'DOD17-1',
      taxClassCodeSnapshot: 'DOD17',
      unitPriceMinor: 10_000n,
      quantity: 1,
      lineSubtotalMinor: 10_000n,
      taxRatePercent: '12.000000',
      taxAmountMinor: 1_200n,
      lineTotalMinor: 11_200n,
    },
  });

  // The payment, with the provider's own references.
  const existing = await prisma.paymentProviderConnection.findFirst({
    where: { provider: 'RAZORPAY', mode: 'LIVE' },
    select: { id: true },
  });
  const connectionId =
    existing?.id ??
    (
      await prisma.paymentProviderConnection.create({
        data: {
          id: newId(),
          provider: 'RAZORPAY',
          mode: 'LIVE',
          label: 'dod17-connection',
          credentialsEnc: 'x',
        },
      })
    ).id;
  await prisma.paymentTransaction.create({
    data: {
      id: newId(),
      orderId,
      connectionId,
      provider: 'RAZORPAY',
      mode: 'LIVE',
      providerOrderId: PAYMENT_ORDER_REF,
      providerPaymentId: PAYMENT_PAYMENT_REF,
      providerSessionId: PAYMENT_SESSION_REF,
      status: 'CAPTURED',
      amountMinor: 11_200n,
      capturedMinor: 11_200n,
      currency: 'INR',
      idempotencyKey: 'dod17-key',
    },
  });

  const split = await splitOrder(orderId);
  expect(split.groups).toBe(1);
  groupId = (
    await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId }, select: { id: true } })
  ).id;

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': '203.0.113.171' },
    payload: { email: SELLER_EMAIL, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = new Map<string, string>();
  for (const c of login.cookies as { name: string; value: string }[]) jar.set(c.name, c.value);
  cookie = [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  csrf = jar.get('uboss_shop_csrf') ?? '';

  const opened = await app.inject({
    method: 'POST',
    url: '/api/v1/sellers/lock/open',
    headers: { cookie, 'x-csrf-token': csrf, 'x-forwarded-for': '203.0.113.171' },
    payload: { password: HUB_PASSWORD },
  });
  expect(opened.statusCode, opened.body).toBe(200);
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

function expectNothingAboutTheBuyer(response: LightMyRequestResponse): void {
  expect(response.statusCode, response.body).toBe(200);
  for (const value of FORBIDDEN) {
    expect(response.body, `response leaked ${value}`).not.toContain(value);
  }
  // A field that would carry them, whatever it holds.
  expect(response.body).not.toMatch(
    /"(customerEmail|buyerEmail|customerPhone|buyerPhone|email|phone|providerPaymentId|providerOrderId|paymentReference|idempotencyKey)"\s*:/,
  );
}

describe('what a seller reads about an order', () => {
  it('sees the order in the list, without the buyer or the payment', async () => {
    const response = await get('/seller/orders');
    expectNothingAboutTheBuyer(response);
    expect(response.body).toContain(groupId);
  });

  it('sees one order in full, delivery address included, buyer contact and payment left out', async () => {
    const response = await get(`/seller/orders/${groupId}`);
    expectNothingAboutTheBuyer(response);
    // They still get what they need to ship it.
    expect(response.body).toContain('Pune');
  });

  it('sees no buyer contact or payment in the order documents', async () => {
    expectNothingAboutTheBuyer(await get(`/seller/orders/${groupId}/documents`));
  });

  it('sees no buyer contact or payment in the delivery legs', async () => {
    expectNothingAboutTheBuyer(await get(`/seller/orders/${groupId}/legs`));
  });

  it('sees no buyer contact or payment on the dashboard or in notifications', async () => {
    expectNothingAboutTheBuyer(await get('/seller/dashboard'));
    expectNothingAboutTheBuyer(await get('/seller/notifications'));
  });
});
