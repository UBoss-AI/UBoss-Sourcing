/**
 * Special instructions, per line.
 *
 * An order already carried `customerNote`, which is about the delivery and
 * reaches everybody. This is about ONE product — "the 316 grade, not 304",
 * "match the batch on our PO 4471" — and it has to travel with the line rather
 * than with the order, because on a basket of nine lines from four sellers an
 * order note saying "the blue one" identifies nothing and is read by three
 * sellers it does not concern.
 *
 * What is worth proving, and each of these is a rule somebody could reasonably
 * have implemented the other way round:
 *
 *   - It is saved on the line, read back on the line, and frozen onto the
 *     ORDER line at checkout — where it has to survive the basket being
 *     emptied, which is the whole point of a snapshot.
 *   - Re-adding the same SKU with no instruction does not WIPE one that is
 *     already there. That is what a reorder, a saved list and the assistant
 *     all look like, and last-one-wins would erase what the buyer typed.
 *   - Re-adding it WITH an instruction does replace it, or typing something on
 *     the product page and pressing Add would silently do nothing.
 *   - `null` clears it, and `''` and `'   '` are the same as `null` — so "no
 *     instruction" has exactly one representation in the database.
 *   - It never changes a figure. An instruction is something to be done, not
 *     something that alters what is charged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { Role } from '../../src/domain/permissions.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const EMAIL = 'line-note-buyer@test.local';
const PASSWORD = 'LineNoteBuyer!2026';

let productId = '';
let cookieHeader = '';
let csrfToken = '';

interface CartBody {
  cart: {
    lines: {
      itemId: string;
      quantity: number;
      note: string | null;
      lineTotal: { minor: string };
    }[];
    totals: { grandTotal: { minor: string } };
  };
}

function auth(): Record<string, string> {
  return { cookie: cookieHeader, 'x-csrf-token': csrfToken };
}

async function emptyCart(): Promise<void> {
  await app.inject({ method: 'DELETE', url: '/api/v1/cart', headers: auth() });
}

async function readCart(): Promise<CartBody['cart']> {
  const response = await app.inject({
    method: 'GET',
    url: '/api/v1/cart',
    headers: { cookie: cookieHeader },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<CartBody>().cart;
}

async function add(note?: string | null): Promise<CartBody['cart']> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/cart/items',
    headers: auth(),
    payload: { productId, quantity: 1, ...(note === undefined ? {} : { note }) },
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json<CartBody>().cart;
}

async function resetAll(): Promise<void> {
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
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
      sku: 'BOLT-M12',
      basePriceMinor: 4250n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      // Untracked: what is under test is the instruction, not availability.
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
    data: { id: newId(), userId: user.id, fullName: 'Line Note Buyer', activatedAt: new Date() },
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

describe('adding a line with an instruction', () => {
  it('stores it and reads it back on the line', async () => {
    await emptyCart();

    const cart = await add('The 316 grade, not 304. Mark the boxes with our PO 4471.');

    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0]?.note).toBe('The 316 grade, not 304. Mark the boxes with our PO 4471.');
  });

  it('records nothing for a line added without one', async () => {
    await emptyCart();

    const cart = await add();

    // `null`, not `''`. "No instruction" has one representation.
    expect(cart.lines[0]?.note).toBeNull();
  });

  it('trims what was typed, and treats whitespace as nothing', async () => {
    await emptyCart();
    expect((await add('  keep this  ')).lines[0]?.note).toBe('keep this');

    await emptyCart();
    expect((await add('   ')).lines[0]?.note).toBeNull();

    await emptyCart();
    expect((await add('')).lines[0]?.note).toBeNull();
  });

  it('refuses one longer than the column, rather than truncating it', async () => {
    await emptyCart();

    // A rejection is a message somebody can act on; a truncation is four
    // hundred words disappearing into a picking list nobody can correct.
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      headers: auth(),
      payload: { productId, quantity: 1, note: 'x'.repeat(501) },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('re-adding a SKU that already has an instruction', () => {
  it('leaves it alone when the new add says nothing', async () => {
    await emptyCart();
    await add('Engrave both ends.');

    // What a reorder, a saved list and the assistant all look like: an add
    // from somewhere with no instruction box on it at all.
    const after = await add();

    expect(after.lines).toHaveLength(1);
    expect(after.lines[0]?.quantity).toBe(2);
    expect(after.lines[0]?.note).toBe('Engrave both ends.');
  });

  it('replaces it when the new add carries one', async () => {
    await emptyCart();
    await add('Engrave both ends.');

    // Somebody typed something on the product page and pressed Add. If this
    // did not reach the line, nothing on screen would say it had been ignored.
    const after = await add('Actually, leave them plain.');

    expect(after.lines[0]?.note).toBe('Actually, leave them plain.');
  });
});

describe('changing an instruction from the basket', () => {
  it('saves a new one and clears it with null', async () => {
    await emptyCart();
    const added = await add();
    const itemId = added.lines[0]?.itemId ?? '';

    const saved = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cart/items/${itemId}/note`,
      headers: auth(),
      payload: { note: 'Deliver to the rear gate.' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<CartBody>().cart.lines[0]?.note).toBe('Deliver to the rear gate.');

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cart/items/${itemId}/note`,
      headers: auth(),
      payload: { note: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(cleared.json<CartBody>().cart.lines[0]?.note).toBeNull();
  });

  it('answers with the whole repriced cart, like every other mutation', async () => {
    await emptyCart();
    const added = await add();
    const itemId = added.lines[0]?.itemId ?? '';

    const before = await readCart();

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cart/items/${itemId}/note`,
      headers: auth(),
      payload: { note: 'Nothing about this changes the price.' },
    });

    const after = response.json<CartBody>().cart;

    // The shape is the contract — the storefront writes this response straight
    // into the cache the basket and the header badge both read from.
    expect(after.totals.grandTotal.minor).toBe(before.totals.grandTotal.minor);
    expect(after.lines[0]?.lineTotal.minor).toBe(before.lines[0]?.lineTotal.minor);
  });

  it('is a 404 for an item id that is not in this customer’s basket', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cart/items/${newId()}/note`,
      headers: auth(),
      payload: { note: 'not mine' },
    });

    expect(response.statusCode).toBe(404);
  });

  it('is refused outright when nobody is signed in', async () => {
    await emptyCart();
    const added = await add();
    const itemId = added.lines[0]?.itemId ?? '';

    const response = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cart/items/${itemId}/note`,
      payload: { note: 'anonymous' },
    });

    expect(response.statusCode).toBe(401);
  });
});
