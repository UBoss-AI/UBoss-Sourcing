/**
 * The B2C maximum order quantity, enforced on real baskets and real orders.
 *
 * The arithmetic has its own unit tests. This file is about the places the
 * limit has to hold - and the ways a limit in a marketplace is usually got
 * round:
 *
 *   - Adding the same thing twice, or two of its options, or both in one
 *     request. The limit counts the whole product.
 *   - Two requests at once, each seeing 60 in the basket and each adding 50.
 *   - A company that is not approved yet, or a company id the buyer does not
 *     belong to. Only an approved company, resolved on the server, is exempt.
 *   - The limit going down while a basket sits open. The basket is kept and
 *     flagged, never trimmed, and cannot be checked out.
 *   - An order placed, then the limit changed. The order keeps the figure it
 *     was placed under.
 *   - A scheduled plan and a preorder, which create orders without a basket.
 *
 * Everything it creates carries a `b2c-` prefix and is removed in `afterAll`
 * - orders are ON DELETE RESTRICT and would break the next file otherwise.
 */
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isAppError } from '../../src/domain/errors.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { assertOrderLinesWithinB2c } from '../../src/modules/cart/b2c-limit.service.js';
import {
  addItem,
  addItems,
  resolveCart,
  toCartView,
  updateItemQuantity,
} from '../../src/modules/cart/cart.service.js';
import { submitCheckout } from '../../src/modules/orders/order.service.js';
import { quoteSchedule } from '../../src/modules/recurring/schedule-quote.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'B2cLimit!2026-test';
const EMAIL = {
  alice: 'b2c-alice@test.local',
  bob: 'b2c-bob@test.local',
  carol: 'b2c-carol@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);
const PREFIX = 'b2c-test';

const users: Record<keyof typeof EMAIL, { userId: string; profileId: string }> = {
  alice: { userId: '', profileId: '' },
  bob: { userId: '', profileId: '' },
  carol: { userId: '', profileId: '' },
};

let taxClassId = '';
let categoryId = '';
let productId = '';
let variantA = '';
let variantB = '';
/** No limit configured: sells exactly as before the rule existed. */
let unlimitedProductId = '';
let approvedCompanyId = '';
let pendingCompanyId = '';
let aliceAddressId = '';
let bobCompanyAddressId = '';

const LIMIT = 100;

// ---------------------------------------------------------------------------

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  const profileIds = (
    await prisma.customerProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } })
  ).map((row) => row.id);

  const orderIds = (
    await prisma.order.findMany({ where: { customerProfileId: { in: profileIds } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.stockReservation.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderStatusHistory.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderApproval.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });

  await prisma.cartItem.deleteMany({ where: { cart: { customerProfileId: { in: profileIds } } } });
  await prisma.cart.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.address.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerCompanyMember.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerCompany.deleteMany({ where: { createdByUserId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  await prisma.productPrice.deleteMany({ where: { product: { sku: { startsWith: PREFIX } } } });
  await prisma.productVariant.deleteMany({ where: { product: { sku: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}-category` } });
  await prisma.shippingMethod.deleteMany({ where: { code: 'B2C-STD' } });
  await prisma.taxClass.deleteMany({ where: { code: 'B2C-GST18' } });
  await prisma.inventoryLocation.deleteMany({ where: { code: 'B2C-MAIN' } });
}

async function createCustomer(email: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  const profileId = newId();
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
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: email.split('@')[0] ?? 'Buyer' } });
  return { userId, profileId };
}

async function createCompany(ownerUserId: string, status: 'APPROVED' | 'UNDER_REVIEW' | 'SUSPENDED'): Promise<string> {
  const id = newId();
  await prisma.buyerCompany.create({
    data: {
      id,
      applicationReference: `B2C${id.slice(-10)}`,
      createdByUserId: ownerUserId,
      legalName: `B2C Test ${status}`,
      status,
    },
  });
  await prisma.buyerCompanyMember.create({ data: { id: newId(), companyId: id, userId: ownerUserId, role: 'OWNER' } });
  return id;
}

async function address(profileId: string, buyerCompanyId: string | null = null): Promise<string> {
  const id = newId();
  await prisma.address.create({
    data: {
      id,
      customerProfileId: profileId,
      buyerCompanyId,
      contactName: 'B2C Buyer',
      contactPhone: '+91 90000 00000',
      line1: 'Gate 3',
      city: 'Pune',
      state: 'MH',
      postalCode: '411019',
      country: 'IN',
    },
  });
  return id;
}

async function setLimit(limit: number | null): Promise<void> {
  await prisma.product.update({ where: { id: productId }, data: { b2cMaxOrderQuantity: limit } });
}

async function emptyBaskets(): Promise<void> {
  await prisma.cartItem.deleteMany({
    where: { cart: { customerProfileId: { in: Object.values(users).map((user) => user.profileId) } } },
  });
}

const individual = (who: keyof typeof users) => users[who].profileId;
const inCompany = (who: keyof typeof users, companyId: string) => ({
  customerProfileId: users[who].profileId,
  buyerCompanyId: companyId,
});

/** The refusal a call made, or null if it succeeded. */
async function refusal(promise: Promise<unknown>): Promise<{ code: string; meta: Record<string, unknown> } | null> {
  try {
    await promise;
    return null;
  } catch (error) {
    if (!isAppError(error)) throw error;
    return { code: error.code, meta: (error.details[0]?.meta ?? {}) };
  }
}

async function productQuantity(owner: Parameters<typeof resolveCart>[0]): Promise<number> {
  const view = toCartView(await resolveCart(owner));
  return view.lines.filter((line) => line.productId === productId).reduce((sum, line) => sum + line.quantity, 0);
}

// --- HTTP ---------------------------------------------------------------

interface Session {
  cookie: string;
  csrf: string;
}

async function signIn(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
  };
}

function call(session: Session, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  for (const name of Object.keys(EMAIL) as (keyof typeof EMAIL)[]) users[name] = await createCustomer(EMAIL[name]);

  // Every basket read asks the default warehouse for availability, so one
  // has to exist. Borrowed if there is one; created, and removed, if not.
  if ((await prisma.inventoryLocation.count({ where: { isDefault: true } })) === 0) {
    await prisma.inventoryLocation.create({
      data: { id: newId(), code: 'B2C-MAIN', name: 'B2C Main', isDefault: true, isActive: true },
    });
  }

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: 'B2C-GST18', name: 'B2C GST 18%', ratePercent: '18.000000', isActive: true },
  });
  await prisma.shippingMethod.create({
    data: { id: newId(), code: 'B2C-STD', name: 'B2C standard', priceMinor: 0n, isActive: true },
  });
  categoryId = newId();
  await prisma.category.create({ data: { id: categoryId, name: 'B2C Test', slug: `${PREFIX}-category`, isActive: true } });

  // Untracked stock: this file is about a purchasing limit, and the limit is
  // exactly what must NOT depend on stock.
  productId = newId();
  await prisma.product.create({
    data: {
      id: productId,
      categoryId,
      taxClassId,
      name: 'B2C Limited Glove',
      slug: `${PREFIX}-glove`,
      sku: `${PREFIX}-GLOVE`,
      basePriceMinor: 1000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      hasVariants: true,
      isRecurringEligible: true,
      b2cMaxOrderQuantity: LIMIT,
    },
  });
  for (const [size, assign] of [
    ['S', (id: string) => (variantA = id)],
    ['M', (id: string) => (variantB = id)],
  ] as const) {
    const id = newId();
    await prisma.productVariant.create({
      data: {
        id,
        productId,
        sku: `${PREFIX}-GLOVE-${size}`,
        name: size,
        optionsJson: { Size: size },
        optionSignature: `size:${size.toLowerCase()}`,
        isActive: true,
      },
    });
    await prisma.productPrice.create({
      data: { id: newId(), productId, variantId: id, variantKey: id, currencyCode: 'INR', basePriceMinor: 1000n },
    });
    assign(id);
  }

  unlimitedProductId = newId();
  await prisma.product.create({
    data: {
      id: unlimitedProductId,
      categoryId,
      taxClassId,
      name: 'B2C Unlimited Mask',
      slug: `${PREFIX}-mask`,
      sku: `${PREFIX}-MASK`,
      basePriceMinor: 500n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
    },
  });
  await prisma.productPrice.create({
    data: { id: newId(), productId: unlimitedProductId, variantKey: '', currencyCode: 'INR', basePriceMinor: 500n },
  });

  approvedCompanyId = await createCompany(users.bob.userId, 'APPROVED');
  pendingCompanyId = await createCompany(users.carol.userId, 'UNDER_REVIEW');

  aliceAddressId = await address(users.alice.profileId);
  bobCompanyAddressId = await address(users.bob.profileId, approvedCompanyId);
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

beforeEach(async () => {
  await emptyBaskets();
  await setLimit(LIMIT);
});

// ---------------------------------------------------------------------------

describe('an individual buyer', () => {
  it('may order below the limit and exactly at it', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 99 });
    expect(await productQuantity(individual('alice'))).toBe(99);

    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 1 });
    expect(await productQuantity(individual('alice'))).toBe(LIMIT);
  });

  it('is refused one over, with the figures the storefront needs and nothing about the seller', async () => {
    const refused = await refusal(addItem(individual('alice'), { productId, variantId: variantA, quantity: 101 }));
    expect(refused).toEqual({
      code: 'B2C_MAX_ORDER_QUANTITY_EXCEEDED',
      meta: {
        productId,
        allowedQuantity: LIMIT,
        requestedQuantity: 101,
        currentCartQuantity: 0,
        requiresApprovedCompanyAccount: true,
      },
    });
    expect(await productQuantity(individual('alice'))).toBe(0);
  });

  it('cannot get round it by adding the same thing again', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 60 });
    const refused = await refusal(addItem(individual('alice'), { productId, variantId: variantA, quantity: 50 }));
    expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    expect(refused?.meta).toMatchObject({ requestedQuantity: 110, currentCartQuantity: 60 });
    // The refused add left the basket exactly as it was.
    expect(await productQuantity(individual('alice'))).toBe(60);
  });

  it('cannot get round it with a second variant: 60 of S and 50 of M is 110 of the product', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 60 });
    const refused = await refusal(addItem(individual('alice'), { productId, variantId: variantB, quantity: 50 }));
    expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    expect(await productQuantity(individual('alice'))).toBe(60);
  });

  it('cannot get round it in one bulk request, and the whole request is refused', async () => {
    const refused = await refusal(
      addItems(individual('alice'), [
        { productId, variantId: variantA, quantity: 60 },
        { productId, variantId: variantB, quantity: 50 },
        { productId: unlimitedProductId, quantity: 5 },
      ]),
    );
    expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    const view = toCartView(await resolveCart(individual('alice')));
    expect(view.lines).toHaveLength(0);
  });

  it('cannot raise a line past it from the basket, but may always lower one', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 60 });
    await addItem(individual('alice'), { productId, variantId: variantB, quantity: 40 });
    const lineA = toCartView(await resolveCart(individual('alice'))).lines.find((line) => line.variantId === variantA);

    const refused = await refusal(updateItemQuantity(individual('alice'), lineA?.itemId ?? '', 61));
    expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    expect(await productQuantity(individual('alice'))).toBe(100);

    await updateItemQuantity(individual('alice'), lineA?.itemId ?? '', 10);
    expect(await productQuantity(individual('alice'))).toBe(50);
  });

  it('leaves a product with no limit configured exactly as it was', async () => {
    await addItem(individual('alice'), { productId: unlimitedProductId, quantity: 5000 });
    const view = toCartView(await resolveCart(individual('alice')));
    expect(view.lines[0]?.quantity).toBe(5000);
    expect(view.lines[0]?.b2cLimit).toBeNull();
    expect(view.checkoutReady).toBe(true);
  });

  it('cannot get round it with two requests at once', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 10 });
    // Each request, on its own, fits: 10 + 60 = 70. Together they are 130.
    const results = await Promise.allSettled([
      addItem(individual('alice'), { productId, variantId: variantA, quantity: 60 }),
      addItem(individual('alice'), { productId, variantId: variantB, quantity: 60 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(isAppError(rejected?.reason) ? rejected.reason.code : rejected?.reason).toBe(
      'B2C_MAX_ORDER_QUANTITY_EXCEEDED',
    );
    expect(await productQuantity(individual('alice'))).toBe(70);
  });
});

describe('company buyers', () => {
  it('lets an approved company past the limit', async () => {
    await addItem(inCompany('bob', approvedCompanyId), { productId, variantId: variantA, quantity: 500 });
    const view = toCartView(await resolveCart(inCompany('bob', approvedCompanyId)));
    expect(view.lines[0]?.quantity).toBe(500);
    expect(view.lines[0]?.b2cLimit).toMatchObject({ maxQuantity: LIMIT, applies: false, exceeded: false });
    expect(view.checkoutReady).toBe(true);
  });

  it('holds a company still under review to the limit', async () => {
    const refused = await refusal(
      addItem(inCompany('carol', pendingCompanyId), { productId, variantId: variantA, quantity: 101 }),
    );
    expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
  });

  it('holds a suspended company to the limit, and flags the basket it built while approved', async () => {
    await addItem(inCompany('bob', approvedCompanyId), { productId, variantId: variantA, quantity: 300 });
    await prisma.buyerCompany.update({ where: { id: approvedCompanyId }, data: { status: 'SUSPENDED' } });
    try {
      const view = toCartView(await resolveCart(inCompany('bob', approvedCompanyId)));
      expect(view.lines[0]?.quantity).toBe(300);
      expect(view.checkoutReady).toBe(false);
      expect(view.lines[0]?.issues.map((issue) => issue.code)).toContain('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
      const refused = await refusal(
        addItem(inCompany('bob', approvedCompanyId), { productId, variantId: variantA, quantity: 1 }),
      );
      expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    } finally {
      await prisma.buyerCompany.update({ where: { id: approvedCompanyId }, data: { status: 'APPROVED' } });
    }
  });

  it('gives no exemption for a company the buyer does not belong to', async () => {
    // Alice naming Bob's approved company - which no route lets a client do,
    // and the service refuses to honour anyway: no membership, no exemption.
    const refused = await refusal(
      addItem(inCompany('alice', approvedCompanyId), { productId, variantId: variantA, quantity: 101 }),
    );
    expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
  });

  it('keeps an individual basket held to the limit for a person who also has an approved company', async () => {
    const refused = await refusal(addItem(individual('bob'), { productId, variantId: variantA, quantity: 101 }));
    expect(refused?.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
  });
});

describe('a basket that is over because the limit changed', () => {
  it('is kept as it is, flagged on every line of the product, and cannot be checked out', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 60 });
    await addItem(individual('alice'), { productId, variantId: variantB, quantity: 30 });
    await setLimit(50);

    const view = toCartView(await resolveCart(individual('alice')));
    expect(view.lines.map((line) => line.quantity).sort()).toEqual([30, 60]);
    expect(view.checkoutReady).toBe(false);
    for (const line of view.lines) {
      expect(line.b2cLimit).toMatchObject({ maxQuantity: 50, productQuantity: 90, applies: true, exceeded: true });
      expect(line.issues.find((issue) => issue.code === 'B2C_MAX_ORDER_QUANTITY_EXCEEDED')?.meta).toMatchObject({
        allowedQuantity: 50,
        requestedQuantity: 90,
      });
    }

    const refused = await refusal(
      submitCheckout({
        customerProfileId: individual('alice'),
        shippingAddressId: aliceAddressId,
        shippingMethodCode: 'B2C-STD',
        paymentMode: 'ONLINE',
        actor: { userId: users.alice.userId, email: EMAIL.alice, type: 'CUSTOMER' },
      }),
    );
    expect(refused?.code).toBe('CART_ITEM_UNAVAILABLE');
    // Still there: nothing was removed on the buyer's behalf.
    expect(await productQuantity(individual('alice'))).toBe(90);
  });

  it('can be reduced a line at a time, even while still over', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: 90 });
    await setLimit(50);
    const line = toCartView(await resolveCart(individual('alice'))).lines[0];
    await updateItemQuantity(individual('alice'), line?.itemId ?? '', 70);
    expect(await productQuantity(individual('alice'))).toBe(70);
  });
});

describe('placing an order', () => {
  it('freezes the limit and the buyer context on the order, and a later change does not touch it', async () => {
    await addItem(individual('alice'), { productId, variantId: variantA, quantity: LIMIT });
    const placed = await submitCheckout({
      customerProfileId: individual('alice'),
      shippingAddressId: aliceAddressId,
      shippingMethodCode: 'B2C-STD',
      paymentMode: 'ONLINE',
      actor: { userId: users.alice.userId, email: EMAIL.alice, type: 'CUSTOMER' },
    });

    await setLimit(10);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: placed.orderId },
      select: { buyerContextKind: true, buyerCompanyId: true, items: true },
    });
    expect(order.buyerContextKind).toBe('INDIVIDUAL');
    expect(order.buyerCompanyId).toBeNull();
    expect(order.items[0]).toMatchObject({
      quantity: LIMIT,
      b2cMaxOrderQuantityApplied: LIMIT,
      b2cCompanyExemptionApplied: false,
    });
  });

  it('records the exemption on an approved company order', async () => {
    await addItem(inCompany('bob', approvedCompanyId), { productId, variantId: variantA, quantity: 250 });
    const placed = await submitCheckout({
      customerProfileId: individual('bob'),
      buyerCompanyId: approvedCompanyId,
      shippingAddressId: bobCompanyAddressId,
      shippingMethodCode: 'B2C-STD',
      paymentMode: 'ONLINE',
      actor: { userId: users.bob.userId, email: EMAIL.bob, type: 'CUSTOMER' },
    });
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: placed.orderId },
      select: { buyerContextKind: true, buyerCompanyId: true, items: true },
    });
    expect(order).toMatchObject({ buyerContextKind: 'COMPANY', buyerCompanyId: approvedCompanyId });
    expect(order.items[0]).toMatchObject({
      quantity: 250,
      b2cMaxOrderQuantityApplied: LIMIT,
      b2cCompanyExemptionApplied: true,
    });
  });

  it('judges the lines about to be ordered against live limits and the live company status', async () => {
    const lines = [{ productId, sellerOfferId: null, quantity: 150 }];
    expect(
      (await refusal(assertOrderLinesWithinB2c(prisma, { customerProfileId: individual('alice'), buyerCompanyId: null, lines })))
        ?.code,
    ).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    await expect(
      assertOrderLinesWithinB2c(prisma, { customerProfileId: individual('bob'), buyerCompanyId: approvedCompanyId, lines }),
    ).resolves.toMatchObject({ perLine: [{ limitApplied: LIMIT, companyExempt: true }] });
    expect(
      (await refusal(assertOrderLinesWithinB2c(prisma, { customerProfileId: individual('carol'), buyerCompanyId: pendingCompanyId, lines })))
        ?.code,
    ).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
  });
});

describe('scheduled orders', () => {
  it('holds a delivery that asks for more than the limit, counting every line of the product', async () => {
    const quote = await quoteSchedule({
      customerProfileId: individual('alice'),
      items: [
        { productId, variantId: variantA, quantity: 60 },
        { productId, variantId: variantB, quantity: 60 },
      ],
    } as Parameters<typeof quoteSchedule>[0]);
    const problem = quote.problems.find((entry) => entry.code === 'B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    expect(problem?.severity).toBe('HOLD');
  });

  it('raises nothing for a delivery within the limit', async () => {
    const quote = await quoteSchedule({
      customerProfileId: individual('alice'),
      items: [{ productId, variantId: variantA, quantity: 60 }],
    } as Parameters<typeof quoteSchedule>[0]);
    expect(quote.problems.map((entry) => entry.code)).not.toContain('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
  });
});

describe('over HTTP', () => {
  it('returns a 409 in the standard envelope, with the figures in details[0].meta', async () => {
    const session = await signIn(EMAIL.alice);
    const response = await call(session, 'POST', '/api/v1/cart/items', { productId, variantId: variantA, quantity: 150 });
    expect(response.statusCode).toBe(409);
    const body = response.json<{ error: { code: string; message: string; details: { meta: Record<string, unknown> }[] } }>();
    expect(body.error.code).toBe('B2C_MAX_ORDER_QUANTITY_EXCEEDED');
    expect(body.error.message).toBe('Individual buyers can order up to 100 units of this product.');
    expect(body.error.details[0]?.meta).toMatchObject({ allowedQuantity: 100, requestedQuantity: 150 });
  });

  it('ignores an account type or company id smuggled into the request', async () => {
    const session = await signIn(EMAIL.alice);
    const response = await call(session, 'POST', '/api/v1/cart/items', {
      productId,
      variantId: variantA,
      quantity: 150,
      accountType: 'COMPANY',
      buyerCompanyId: approvedCompanyId,
      companyApproved: true,
    });
    // Refused one way or the other - never accepted.
    expect([400, 409]).toContain(response.statusCode);
    expect(await productQuantity(individual('alice'))).toBe(0);
  });

  it('refuses switching into a company the buyer does not belong to', async () => {
    const session = await signIn(EMAIL.alice);
    const response = await call(session, 'PUT', '/api/v1/auth/buyer-context', {
      kind: 'COMPANY',
      companyId: approvedCompanyId,
    });
    expect(response.statusCode).toBe(403);
  });

  it('tells the product page the limit, as a purchasing limit', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/products/${PREFIX}-glove` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ product: { purchaseRules: { b2cMaxOrderQuantity: number | null } } }>();
    expect(body.product.purchaseRules.b2cMaxOrderQuantity).toBe(LIMIT);
  });
});
