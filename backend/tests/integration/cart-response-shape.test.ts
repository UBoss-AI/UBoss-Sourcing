/**
 * Every cart route answers with a full cart.
 *
 * The bug this file exists for: `DELETE /cart` answered `{ removed: 3 }` - the
 * count `clearCart()` happens to return - while its five siblings all answered
 * `{ cart }`. The storefront writes a cart response straight into the React
 * Query cache keyed `['cart']`, and both the cart page and the header basket
 * read from that key. So emptying the cart put a body with no `cart` in it into
 * the cache, and the very next render reached for `undefined.itemCount` and
 * threw - taking down not just the cart page but the header, which is on every
 * page. One inconsistent route, and the whole storefront white-screened.
 *
 * The lesson is in the route file's own docstring, which the route was
 * breaking: "Every response is a full repriced cart, not a delta." These tests
 * hold that shape for every mutation, so the next route added here cannot
 * quietly invent a different one.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const EMAIL = 'cart-shape@test.local';
const PASSWORD = 'CartShape!2026';

let productId = '';
let cookieHeader = '';
let csrfToken = '';

async function resetAll(): Promise<void> {
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

/** The body of any cart response, with only what these tests assert on. */
interface CartBody {
  cart?: { lines?: unknown[]; itemCount?: number };
}

function parse(response: LightMyRequestResponse): CartBody {
  return JSON.parse(response.body) as CartBody;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await resetAll();

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
      basePriceMinor: 4550n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      // Untracked, so the cart needs no stock ledger to accept a line. What is
      // under test is the shape of the answer, not availability.
      isStockTracked: false,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  productId = product.id;

  const customerRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.CUSTOMER },
    select: { id: true },
  });

  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: customerRole.id } },
    },
  });

  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Cart Shape Buyer', activatedAt: new Date() },
  });

  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);

  const jar = signIn.cookies as { name: string; value: string }[];
  cookieHeader = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  csrfToken = jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '';
  expect(csrfToken).not.toBe('');
});

afterAll(async () => {
  await resetAll();
  await app.close();
});

describe('cart response shape', () => {
  it('answers an added item with the whole cart', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, quantity: 2 },
    });

    // 201: the line is a new subresource. The shape is what matters here.
    expect(response.statusCode, response.body).toBe(201);

    const body = parse(response);
    expect(body.cart).toBeDefined();
    expect(body.cart?.lines).toHaveLength(1);
    expect(body.cart?.itemCount).toBe(2);
  });

  it('answers a bulk add with the whole cart, like its five siblings', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items/bulk',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { items: [{ productId, quantity: 2 }] },
    });

    // The newest route on this prefix, and the reason this file says what it
    // says: the storefront writes any cart response straight into the
    // `['cart']` cache that the cart page and the header basket both read, so
    // a route answering a delta here white-screens the whole storefront.
    expect(response.statusCode, response.body).toBe(201);

    const body = parse(response);
    expect(body.cart, response.body).toBeDefined();
    expect(body.cart?.lines).toHaveLength(1);
    expect(body.cart?.itemCount).toBe(4);
  });

  it('answers an emptied cart with the whole cart, not a count', async () => {
    // Something has to be in it, or the regression cannot show: the old code
    // answered `{ removed: 0 }` here, which is falsy-looking but still the
    // wrong shape, and a test on an already-empty cart would pass either way.
    const add = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, quantity: 3 },
    });
    expect(add.statusCode, add.body).toBe(201);

    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/cart',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    });

    expect(response.statusCode, response.body).toBe(200);

    const body = parse(response);

    // The assertion that would have caught it. `cart` present, and no bare
    // `removed` standing in for it.
    expect(body.cart, response.body).toBeDefined();
    expect(Object.keys(body)).toContain('cart');

    // And it is genuinely empty, repriced, rather than merely present.
    expect(body.cart?.lines).toHaveLength(0);
    expect(body.cart?.itemCount).toBe(0);
  });

  it('leaves the cart readable afterwards', async () => {
    // The client treats a mutation's answer as the truth and stops asking. So
    // the emptied cart it was handed has to match what a fresh read returns,
    // or the page and the server disagree until something forces a refetch.
    const read = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { cookie: cookieHeader },
    });

    expect(read.statusCode, read.body).toBe(200);

    const body = parse(read);
    expect(body.cart?.lines).toHaveLength(0);
    expect(body.cart?.itemCount).toBe(0);
  });
});
