/**
 * A paid, delivered marketplace order and everybody who touches it after the
 * sale: the buyer, a second buyer, two sellers and four members of staff, each
 * with a real signed-in session.
 *
 * Returns and disputes are both "something is wrong with an order that was
 * delivered", so their HTTP tests share one world rather than each rebuilding
 * it. Everything is written under a `tag`, and `cleanUpOrderDesk(tag)` removes
 * exactly that - orders are ON DELETE RESTRICT from several directions, so a
 * test that leaves rows behind breaks the first file of the next run.
 */
import type { LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import type { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { splitOrder } from '../../src/modules/seller/order-split.service.js';
import { signInAdmin } from './admin-session.js';

type App = Awaited<ReturnType<typeof buildApp>>;

export interface Session {
  cookie: string;
  csrf: string;
  ip: string;
}

export interface StaffSession {
  cookies: string;
  csrfToken: string;
  ip: string;
}

export interface OrderDesk {
  tag: string;
  buyer: Session;
  rivalBuyer: Session;
  sellerA: Session;
  sellerB: Session;
  /** Two finance approvers: one proposes, the other checks. */
  financeOne: StaffSession;
  financeTwo: StaffSession;
  /** The order desk: may work returns and hear disputes, cannot approve a refund. */
  orderDesk: StaffSession;
  /** Holds neither: the catalogue team. */
  catalog: StaffSession;
  orderId: string;
  /** The line the disputes and returns are about (quantity 2, seller A's). */
  itemId: string;
  /** A second line on the same order (quantity 1, seller A's). */
  secondItemId: string;
  sellerAId: string;
  sellerBId: string;
}

const PASSWORD = 'OrderDeskPass!2026x';
const HUB_PASSWORD = 'OrderDeskHub!2026x';

export const emailFor = (tag: string, who: string): string => `${tag}-${who}@orderdesk.test.local`;

export async function cleanUpOrderDesk(tag: string): Promise<void> {
  const emails = [
    'buyer',
    'rival',
    'selleraowner',
    'sellerbowner',
    'finance1',
    'finance2',
    'desk',
    'catalog',
    // Inspection agency staff and an inspection admin (inspection-http.test.ts).
    'agcoord',
    'aginsp',
    'agqa',
    'inspadmin',
    // A second agency, a second inspector, the least-privilege staff roles
    // and a buyer who is deactivated (authorization-matrix.test.ts).
    'agcoordb',
    'aginsp2',
    'support',
    'compliance',
    'gone',
  ].map((who) => emailFor(tag, who));
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: emails } }, select: { id: true } })
  ).map((row) => row.id);
  const sellerIds = (
    await prisma.sellerAccount.findMany({
      where: { slug: { startsWith: `${tag}-seller` } },
      select: { id: true },
    })
  ).map((row) => row.id);
  const orderIds = (
    await prisma.order.findMany({
      where: { orderNumber: { startsWith: `UB-${tag.toUpperCase()}-` } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.adminNotification.deleteMany({
    where: { OR: [{ linkPath: { contains: tag } }, { relatedId: { in: orderIds } }] },
  });
  await prisma.dispute.deleteMany({ where: { orderId: { in: orderIds } } });
  const returnIds = (
    await prisma.returnRequest.findMany({
      where: { orderId: { in: orderIds } },
      select: { id: true },
    })
  ).map((row) => row.id);
  await prisma.returnRequestFile.deleteMany({ where: { returnRequestId: { in: returnIds } } });
  await prisma.returnRequestEvent.deleteMany({ where: { returnRequestId: { in: returnIds } } });
  await prisma.returnRequestLine.deleteMany({ where: { returnRequestId: { in: returnIds } } });
  await prisma.returnRequest.deleteMany({ where: { id: { in: returnIds } } });
  await prisma.notificationOutbox.deleteMany({
    where: {
      OR: [{ recipientEmail: { in: emails } }, { relatedId: { in: [...orderIds, ...returnIds] } }],
    },
  });
  await prisma.auditLog.deleteMany({
    where: {
      OR: [{ actorEmail: { in: emails } }, { resourceId: { in: [...orderIds, ...returnIds] } }],
    },
  });
  await prisma.sellerOrderLine.deleteMany({ where: { orderGroup: { orderId: { in: orderIds } } } });
  await prisma.sellerOrderGroup.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });

  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: `${tag}-` } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: `${tag}-` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `${tag}-` } } });
  await prisma.taxClass.deleteMany({ where: { code: tag.toUpperCase() } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: emails } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

function jarOf(response: LightMyRequestResponse): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[])
    jar.set(cookie.name, cookie.value);
  return jar;
}

export async function customer(
  app: App,
  tag: string,
  who: string,
  ip: string,
  hubSellerId?: string,
): Promise<Session> {
  const email = emailFor(tag, who);
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
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: `${who} ${tag}` },
  });
  if (hubSellerId !== undefined) {
    await prisma.sellerMember.create({
      data: {
        id: newId(),
        sellerAccountId: hubSellerId,
        customerProfileId: profile.id,
        role: 'OWNER',
        passwordHash: await hashPassword(HUB_PASSWORD),
        passwordSetAt: new Date(),
      },
    });
  }

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': ip },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = jarOf(login);
  const session: Session = {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
    ip,
  };
  if (hubSellerId !== undefined) {
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/sellers/lock/open',
      headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-for': ip },
      payload: { password: HUB_PASSWORD },
    });
    expect(opened.statusCode, opened.body).toBe(200);
  }
  return session;
}

export async function staff(
  app: App,
  tag: string,
  who: string,
  role: string,
  ip: string,
): Promise<StaffSession> {
  const email = emailFor(tag, who);
  const roleRow = await prisma.role.findUniqueOrThrow({
    where: { key: role },
    select: { id: true },
  });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
  const session = await signInAdmin(app, { email, password: PASSWORD, ip });
  return { ...session, ip };
}

async function makeSeller(tag: string, letter: 'a' | 'b'): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      slug: `${tag}-seller${letter}`,
      legalName: `${tag} ${letter} Ltd`,
      displayName: `${tag} ${letter}`,
      displayNameNormalized: `${tag}${letter}`,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  return id;
}

/**
 * Build the world. `tag` is short and lower-case (`ret6`, `dsp6`), unique per
 * test file.
 */
export async function buildOrderDesk(
  app: App,
  tag: string,
  ipBase: number,
  /** The third octet, so several files can share one `10.<ipBase>.x` range. */
  ipSubnet = 0,
): Promise<OrderDesk> {
  await cleanUpOrderDesk(tag);
  const upper = tag.toUpperCase();

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: upper, name: upper, ratePercent: '12.000000', isActive: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: upper, slug: `${tag}-category`, isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: `${upper} product`,
      slug: `${tag}-product`,
      sku: `${upper}-1`,
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

  const sellerAId = await makeSeller(tag, 'a');
  const sellerBId = await makeSeller(tag, 'b');
  const offerId = newId();
  await prisma.sellerOffer.create({
    data: {
      id: offerId,
      sellerAccountId: sellerAId,
      productId: product.id,
      variantKey: '',
      sellerSku: `${upper}-A1`,
      status: 'ACTIVE',
      priceMinor: 10_000n,
      currency: 'INR',
    },
  });

  const ip = (offset: number): string => `10.${String(ipBase)}.${String(ipSubnet)}.${String(offset)}`;
  const buyer = await customer(app, tag, 'buyer', ip(1));
  const rivalBuyer = await customer(app, tag, 'rival', ip(2));
  const sellerA = await customer(app, tag, 'selleraowner', ip(3), sellerAId);
  const sellerB = await customer(app, tag, 'sellerbowner', ip(4), sellerBId);
  const financeOne = await staff(app, tag, 'finance1', Role.FINANCE_APPROVER, ip(5));
  const financeTwo = await staff(app, tag, 'finance2', Role.FINANCE_APPROVER, ip(6));
  const orderDesk = await staff(app, tag, 'desk', Role.ORDER_MANAGER, ip(7));
  const catalog = await staff(app, tag, 'catalog', Role.CATALOG_MANAGER, ip(8));

  // The order is the buyer's: their profile, paid, delivered today.
  const buyerProfile = await prisma.customerProfile.findFirstOrThrow({
    where: { user: { emailNormalized: emailFor(tag, 'buyer') } },
    select: { id: true },
  });
  const orderId = newId();
  const now = new Date();
  await prisma.order.create({
    data: {
      id: orderId,
      orderNumber: `UB-${upper}-000001`,
      customerProfileId: buyerProfile.id,
      status: 'DELIVERED',
      currency: 'INR',
      subtotalMinor: 30_000n,
      discountMinor: 0n,
      taxMinor: 3_600n,
      shippingMinor: 0n,
      grandTotalMinor: 33_600n,
      paidMinor: 33_600n,
      placedAt: now,
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
  const itemId = newId();
  const secondItemId = newId();
  const line = (id: string, quantity: number) => ({
    id,
    orderId,
    productId: product.id,
    sellerOfferId: offerId,
    nameSnapshot: `${upper} product`,
    skuSnapshot: `${upper}-1`,
    taxClassCodeSnapshot: upper,
    unitPriceMinor: 10_000n,
    quantity,
    lineSubtotalMinor: 10_000n * BigInt(quantity),
    taxRatePercent: '12.000000',
    taxAmountMinor: 1_200n * BigInt(quantity),
    lineTotalMinor: 11_200n * BigInt(quantity),
  });
  await prisma.orderItem.createMany({ data: [line(itemId, 2), line(secondItemId, 1)] });
  await splitOrder(orderId);
  await prisma.sellerOrderGroup.updateMany({
    where: { orderId },
    data: { status: 'DELIVERED', deliveredAt: now },
  });
  await prisma.orderStatusHistory.create({
    data: {
      id: newId(),
      orderId,
      fromStatus: 'SHIPPED',
      toStatus: 'DELIVERED',
      actorType: 'SYSTEM',
    },
  });

  return {
    tag,
    buyer,
    rivalBuyer,
    sellerA,
    sellerB,
    financeOne,
    financeTwo,
    orderDesk,
    catalog,
    orderId,
    itemId,
    secondItemId,
    sellerAId,
    sellerBId,
  };
}

export type CallOptions = { idempotencyKey?: string; payload?: unknown };

/** A customer-side or Seller Hub call. `url` starts after `/api/v1`. */
export function asCustomer(
  app: App,
  session: Session,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'x-forwarded-for': session.ip,
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.payload === undefined
      ? {}
      : { payload: options.payload as Record<string, unknown> }),
  });
}

/** A staff call. `url` starts after `/api/v1/admin`. */
export function asStaff(
  app: App,
  session: StaffSession,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  options: CallOptions = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: {
      cookie: session.cookies,
      'x-csrf-token': session.csrfToken,
      'x-forwarded-for': session.ip,
      ...(options.idempotencyKey === undefined
        ? {}
        : { 'idempotency-key': options.idempotencyKey }),
    },
    ...(options.payload === undefined
      ? {}
      : { payload: options.payload as Record<string, unknown> }),
  });
}

export const errorCode = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code?: string } }>().error?.code;
