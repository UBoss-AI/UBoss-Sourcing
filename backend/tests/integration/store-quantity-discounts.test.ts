/**
 * Store-wide quantity discounts, end to end: the operator sets "from 10
 * pieces, 3% off", the product page's offer quotes it, and the basket charges
 * exactly what the offer promised.
 *
 * The table is global, so whatever was in it before is put back afterwards
 * - a later file pricing an operator product must not find a discount it
 * never set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';

import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { saveStoreDiscounts } from '../../src/modules/catalog/store-discount.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PREFIX = 'sqd-';
const EMAIL = 'sqd-buyer@test.local';
const PASSWORD = 'StoreDiscount!2026';
// The audit trail names a real user; the buyer stands in, set in beforeAll.
const ACTOR = {
  userId: '',
  email: 'sqd-staff@test.local',
  ipAddress: null,
  correlationId: null,
};

let productId = '';
let cookieHeader = '';
let csrfToken = '';
let previous: { minQuantity: number; discountBasisPoints: number; isActive: boolean }[] = [];

interface CartLineBody {
  unitPrice: { minor: string };
  quantityTier: { savingBasisPoints: number; listUnitPrice: { minor: string } } | null;
  nextQuantityTier: { addQuantity: number; savingPerPiece: { minor: string } } | null;
}

interface OfferBody {
  available: boolean;
  current: { unitPrice: { minor: string } };
  next: { addQuantity: number; savingPerPiece: { minor: string } } | null;
  ladder: { minQuantity: number; savingBasisPoints: number }[];
}

async function cleanUp(): Promise<void> {
  const profiles = { user: { emailNormalized: EMAIL } };
  await prisma.cartItem.deleteMany({ where: { cart: { customerProfile: profiles } } });
  await prisma.cart.deleteMany({ where: { customerProfile: profiles } });
  await prisma.customerProfile.deleteMany({ where: profiles });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.taxClass.deleteMany({ where: { code: { startsWith: 'SQD' } } });
  await prisma.inventoryLocation.deleteMany({ where: { code: 'SQD-MAIN' } });
}

function json<T>(response: LightMyRequestResponse): T {
  return JSON.parse(response.body) as T;
}

async function addToCart(quantity: number): Promise<CartLineBody | undefined> {
  await app.inject({
    method: 'DELETE',
    url: '/api/v1/cart',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/cart/items',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    payload: { productId, quantity },
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ cart: { lines: CartLineBody[] } }>(response).cart.lines[0];
}

async function offerFor(quantity: number): Promise<OfferBody> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/bulk-pricing?productId=${productId}&quantity=${String(quantity)}`,
    headers: { cookie: cookieHeader },
  });
  expect(response.statusCode, response.body).toBe(200);
  return json<OfferBody>(response);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  previous = await prisma.storeQuantityDiscount.findMany({
    select: { minQuantity: true, discountBasisPoints: true, isActive: true },
  });

  // The basket needs a default warehouse. Borrow the one that exists, or open
  // a temporary one and close it again afterwards.
  const existing = await prisma.inventoryLocation.findFirst({ where: { isDefault: true } });
  if (existing === null) {
    await prisma.inventoryLocation.create({
      data: { id: newId(), code: 'SQD-MAIN', name: 'SQD Main', isDefault: true, isActive: true },
    });
  }

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: 'SQD18', name: 'SQD 18%', ratePercent: '18.000000', isActive: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'SQD Fasteners', slug: `${PREFIX}fasteners`, isActive: true },
  });
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'SQD Hex Bolt',
      slug: `${PREFIX}hex-bolt`,
      sku: 'SQD-HEX',
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
  ACTOR.userId = user.id;
  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'SQD Buyer', activatedAt: new Date() },
  });
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': '10.77.0.21' },
    payload: { email: EMAIL, password: PASSWORD },
  });
  expect(signIn.statusCode, signIn.body).toBe(200);
  const jar = signIn.cookies as { name: string; value: string }[];
  cookieHeader = jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  csrfToken = jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '';
});

afterAll(async () => {
  await prisma.storeQuantityDiscount.deleteMany({});
  if (previous.length > 0) {
    await prisma.storeQuantityDiscount.createMany({
      data: previous.map((row) => ({ id: newId(), ...row })),
    });
  }
  await cleanUp();
  await app.close();
});

describe('store-wide quantity discounts', () => {
  it('prices at list when the store runs none', async () => {
    await saveStoreDiscounts(ACTOR, { discounts: [] });
    const line = await addToCart(20);
    expect(line?.unitPrice.minor).toBe('10000');
    expect(line?.quantityTier).toBeNull();
    expect(line?.nextQuantityTier).toBeNull();
  });

  it('promises the saving on the product page before the quantity reaches it', async () => {
    await saveStoreDiscounts(ACTOR, {
      discounts: [
        { minQuantity: 10, discountBasisPoints: 300, isActive: true },
        { minQuantity: 50, discountBasisPoints: 500, isActive: true },
      ],
    });
    const offer = await offerFor(4);
    expect(offer.available).toBe(true);
    expect(offer.current.unitPrice.minor).toBe('10000');
    expect(offer.next).toMatchObject({ addQuantity: 6, savingPerPiece: { minor: '300' } });
    expect(offer.ladder.map((band) => band.savingBasisPoints)).toEqual([300, 500]);
  });

  it('charges in the basket exactly what the offer promised', async () => {
    const offer = await offerFor(12);
    const line = await addToCart(12);
    expect(offer.current.unitPrice.minor).toBe('9700');
    expect(line?.unitPrice.minor).toBe(offer.current.unitPrice.minor);
    expect(line?.quantityTier).toMatchObject({
      savingBasisPoints: 300,
      listUnitPrice: { minor: '10000' },
    });
    // And tells the basket what the next rule saves.
    expect(line?.nextQuantityTier).toMatchObject({
      addQuantity: 38,
      savingPerPiece: { minor: '200' },
    });
  });

  it('stops applying a paused rule', async () => {
    await saveStoreDiscounts(ACTOR, {
      discounts: [{ minQuantity: 10, discountBasisPoints: 300, isActive: false }],
    });
    const line = await addToCart(12);
    expect(line?.unitPrice.minor).toBe('10000');
  });

  it('refuses a ladder that takes off less for more', async () => {
    await expect(
      saveStoreDiscounts(ACTOR, {
        discounts: [
          { minQuantity: 10, discountBasisPoints: 500, isActive: true },
          { minQuantity: 50, discountBasisPoints: 300, isActive: true },
        ],
      }),
    ).rejects.toMatchObject({ code: 'STORE_QUANTITY_DISCOUNTS_INVALID' });
  });

  it('keeps the setting behind staff sign-in', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/quantity-discounts',
      headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
      payload: { discounts: [] },
    });
    expect([401, 403]).toContain(response.statusCode);
  });
});
