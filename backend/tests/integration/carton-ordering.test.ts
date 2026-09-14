/**
 * The carton, end to end, at the size a real deployment uses.
 *
 * The rest of this suite runs with a carton of one piece, so that its prices,
 * stock figures and totals stay the size a person can check by hand - see the
 * note in `tests/setup.ts`. That leaves one thing unproven, and it is the one
 * thing a buyer would notice: that asking for two cartons actually puts a
 * thousand pieces in the basket, at a thousand times the piece price, and that
 * nothing anywhere lets a part carton through.
 *
 * So this file sets `PIECES_PER_CARTON` to 500 itself and loads the app
 * afterwards. The dynamic imports in `beforeAll` are the whole reason it can:
 * a static import is evaluated before any statement in the file body, and
 * `config/env.ts` reads the environment once, when it is first imported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

process.env.PIECES_PER_CARTON = '500';

const PER_CARTON = 500;
/** Minor units for one piece. A carton is a thousand times this, at two. */
const PIECE_PRICE = 40n;

// Type-only, so nothing here loads a module before the line above has run:
// TypeScript erases these entirely, and the values arrive by `await import`
// inside `beforeAll`.
import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { newId as NewId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof BuildApp>>;
let prisma: typeof PrismaClient;
let newId: typeof NewId;

const EMAIL = 'carton-buyer@test.local';
const PASSWORD = 'CartonBuyer!2026';

let productId = '';
let cookieHeader = '';
let csrfToken = '';

interface CartBody {
  cart?: {
    itemCount?: number;
    lines?: {
      quantity: number;
      unitPrice: { minor: string };
      lineSubtotal: { minor: string };
      ordering?: { unit: string; unitQuantity: number; piecesPerUnit: number };
    }[];
  };
}

async function resetAll(): Promise<void> {
  await prisma.stockReservation.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.address.deleteMany({});
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

async function emptyCart(): Promise<void> {
  await app.inject({
    method: 'DELETE',
    url: '/api/v1/cart',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
  });
}

beforeAll(async () => {
  const { buildApp } = await import('../../src/http/app.js');
  ({ prisma } = await import('../../src/infra/prisma.js'));
  ({ newId } = await import('../../src/infra/ids.js'));
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const { Role } = await import('../../src/domain/permissions.js');

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
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Disposable Syringe 5ml',
      slug: 'disposable-syringe-5ml',
      sku: 'SYR-5ML',
      basePriceMinor: PIECE_PRICE,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      // Untracked: what is under test is the conversion, not availability.
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
    data: { id: newId(), userId: user.id, fullName: 'Carton Buyer', activatedAt: new Date() },
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

describe('a shop that sells cartons of 500', () => {
  it('publishes the carton size, so the storefront can price one', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/config' });
    const body = response.json<{ ordering: { piecesPerCarton: number } }>();

    expect(body.ordering.piecesPerCarton).toBe(PER_CARTON);
  });

  it('turns two cartons into a thousand pieces at a thousand times the price', async () => {
    await emptyCart();

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, orderingUnit: 'OUTER_CARTON', unitQuantity: 2, quantity: 1 },
    });
    expect(response.statusCode, response.body).toBe(201);

    const line = (JSON.parse(response.body) as CartBody).cart?.lines?.[0];

    // The pieces, which is what the warehouse picks and what the price is per.
    expect(line?.quantity).toBe(2 * PER_CARTON);
    // The cartons, which is what the buyer chose and what they are shown back.
    expect(line?.ordering).toEqual({
      unit: 'OUTER_CARTON',
      unitQuantity: 2,
      piecesPerUnit: PER_CARTON,
    });

    // And the money follows the pieces. 40 minor units a piece, a thousand
    // pieces: the line is 40,000 before tax, whatever the buyer typed into
    // `quantity`.
    expect(line?.unitPrice.minor).toBe(PIECE_PRICE.toString());
    expect(line?.lineSubtotal.minor).toBe((PIECE_PRICE * BigInt(2 * PER_CARTON)).toString());
  });

  it('ignores the piece count a client sends beside its carton count', async () => {
    await emptyCart();

    // A client posting "2 cartons, which is 1 piece" is either broken or
    // trying it on. Either way the server converts from its own setting.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, orderingUnit: 'OUTER_CARTON', unitQuantity: 2, quantity: 999_999 },
    });
    expect(response.statusCode, response.body).toBe(201);

    const line = (JSON.parse(response.body) as CartBody).cart?.lines?.[0];
    expect(line?.quantity).toBe(2 * PER_CARTON);
  });

  it('takes a caller that still speaks in pieces up to whole cartons', async () => {
    await emptyCart();

    // 600 pieces is two cartons. Rounding down would ship 500 to somebody who
    // asked for 600, and say nothing about it.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, quantity: 600 },
    });
    expect(response.statusCode, response.body).toBe(201);

    const line = (JSON.parse(response.body) as CartBody).cart?.lines?.[0];
    expect(line?.quantity).toBe(2 * PER_CARTON);
    expect(line?.ordering?.unitQuantity).toBe(2);
  });

  it('refuses to sell a piece or an inner box at all', async () => {
    await emptyCart();

    for (const orderingUnit of ['PIECE', 'INNER_PACK']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cart/items',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { productId, orderingUnit, unitQuantity: 3, quantity: 3 },
      });

      // Refused rather than quietly reinterpreted. A client asking for three
      // pieces should be told the shop does not sell them, not handed three
      // cartons.
      expect(response.statusCode, response.body).toBe(400);
    }
  });

  it('keeps a line on whole cartons when its quantity is edited in pieces', async () => {
    await emptyCart();

    const added = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, orderingUnit: 'OUTER_CARTON', unitQuantity: 1, quantity: 1 },
    });
    const itemId = (
      JSON.parse(added.body) as { cart?: { lines?: { itemId: string }[] } }
    ).cart?.lines?.[0]?.itemId;
    expect(itemId).toBeDefined();

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cart/items/${String(itemId)}`,
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { quantity: 501 },
    });
    expect(patched.statusCode, patched.body).toBe(200);

    // 501 pieces is not something this shop can ship. Two cartons is.
    const line = (JSON.parse(patched.body) as CartBody).cart?.lines?.[0];
    expect(line?.quantity).toBe(2 * PER_CARTON);
    expect(line?.ordering?.unitQuantity).toBe(2);
  });

  it('counts cartons, not pieces, when the same line is added twice', async () => {
    await emptyCart();

    for (const unitQuantity of [2, 3]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/cart/items',
        headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
        payload: { productId, orderingUnit: 'OUTER_CARTON', unitQuantity, quantity: 1 },
      });
      expect(response.statusCode, response.body).toBe(201);
    }

    const cart = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: { cookie: cookieHeader },
    });

    const body = JSON.parse(cart.body) as CartBody;
    expect(body.cart?.lines).toHaveLength(1);
    expect(body.cart?.lines?.[0]?.ordering?.unitQuantity).toBe(5);
    expect(body.cart?.lines?.[0]?.quantity).toBe(5 * PER_CARTON);
  });

  it('carries the cartons onto the order, beside the pieces', async () => {
    await emptyCart();

    await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { productId, orderingUnit: 'OUTER_CARTON', unitQuantity: 2, quantity: 1 },
    });

    const profile = await prisma.customerProfile.findFirstOrThrow({
      where: { user: { emailNormalized: EMAIL } },
      select: { id: true },
    });

    const address = await prisma.address.create({
      data: {
        id: newId(),
        customerProfileId: profile.id,
        contactName: 'Carton Buyer',
        contactPhone: '+91 90000 00000',
        line1: '1 Test Road',
        city: 'Mumbai',
        state: 'MH',
        postalCode: '400001',
        country: 'IN',
        isDefaultBilling: true,
        isDefaultShipping: true,
      },
    });

    const checkout = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/checkout',
      headers: {
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        'idempotency-key': newId(),
      },
      payload: { shippingAddressId: address.id },
    });
    expect(checkout.statusCode, checkout.body).toBe(201);

    const { orderId } = JSON.parse(checkout.body) as { orderId: string };
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId } });

    // An invoice that said 1,000 pieces where the buyer ordered 2 cartons is
    // a dispute waiting to be had. Both numbers are on the line.
    expect(item.quantity).toBe(2 * PER_CARTON);
    expect(item.orderingUnit).toBe('OUTER_CARTON');
    expect(item.unitQuantity).toBe(2);
    // Snapshotted, so re-specifying the carton later cannot reword this order.
    expect(item.piecesPerUnitSnapshot).toBe(PER_CARTON);
  });
});
