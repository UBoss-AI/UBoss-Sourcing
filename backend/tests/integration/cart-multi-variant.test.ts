/**
 * More than one option of the same product, in one request.
 *
 * A hospital buyer ordering syringes needs the 3 ml and the 5 ml. The cart
 * always had room for both - `unique(cartId, productId, variantKey)` makes
 * each option its own line - but the only way to ask for both was to add one,
 * go back, and add the other. `POST /cart/items/bulk` is how they are asked
 * for together, and this file holds the four things that has to get right:
 *
 *   - Every option becomes its own line, carrying its own quantity and its own
 *     price. Two lines, not one line of six.
 *   - It is all or nothing. A request with one bad option writes none of it,
 *     because "added to your cart" must never be true of half of what the
 *     customer chose.
 *   - The refusal says WHICH option was wrong. `items.1.variantId` is the
 *     difference between a customer fixing their basket and a customer
 *     starting again.
 *   - The cart can tell the lines apart. Both carry the same product name and
 *     the same photograph, so `variantName` is the only thing on the row that
 *     distinguishes them - and a cart that cannot be read is a cart that gets
 *     ordered wrong.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const EMAIL = 'cart-multi-variant@test.local';
const PASSWORD = 'MultiVariant!2026';

let productId = '';
/** A second product, for the "that option belongs to something else" case. */
let otherProductId = '';
let smallVariantId = '';
let largeVariantId = '';
let otherVariantId = '';
let cookieHeader = '';
let csrfToken = '';

interface CartBody {
  cart?: {
    lines?: {
      variantId: string | null;
      variantName: string | null;
      name: string;
      sku: string;
      quantity: number;
      unitPrice: { minor: string };
    }[];
    itemCount?: number;
  };
  error?: { code?: string; details?: { field?: string; code?: string }[] };
}

async function resetAll(): Promise<void> {
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.productPrice.deleteMany({});
  await prisma.productVariant.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

/** Empty the cart between cases, so each one starts from nothing. */
async function emptyCart(): Promise<void> {
  await prisma.cartItem.deleteMany({});
}

async function bulkAdd(items: unknown): Promise<{ statusCode: number; body: CartBody; raw: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/cart/items/bulk',
    headers: { cookie: cookieHeader, 'x-csrf-token': csrfToken },
    payload: { items },
  });

  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as CartBody,
    raw: response.body,
  };
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
      code: 'GST12',
      name: 'GST 12%',
      ratePercent: '12.000000',
      isDefault: true,
      isActive: true,
    },
  });

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });

  // Untracked stock, so the lines need no inventory ledger behind them. What is
  // under test is which lines exist and what they say, not availability.
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Disposable Syringe',
      slug: 'disposable-syringe',
      sku: 'SYR',
      basePriceMinor: 1000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      hasVariants: true,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  productId = product.id;

  const small = await prisma.productVariant.create({
    data: {
      id: newId(),
      productId: product.id,
      sku: 'SYR-3ML',
      name: '3 ml',
      optionsJson: { Size: '3 ml' },
      isActive: true,
      sortOrder: 1,
    },
  });
  smallVariantId = small.id;

  const large = await prisma.productVariant.create({
    data: {
      id: newId(),
      productId: product.id,
      sku: 'SYR-5ML',
      name: '5 ml',
      optionsJson: { Size: '5 ml' },
      isActive: true,
      sortOrder: 2,
    },
  });
  largeVariantId = large.id;

  // Different figures per option, so a test that mixed the two lines up could
  // not pass by coincidence.
  await prisma.productPrice.createMany({
    data: [
      {
        id: newId(),
        productId: product.id,
        variantId: small.id,
        variantKey: small.id,
        currencyCode: 'INR',
        basePriceMinor: 1000n,
      },
      {
        id: newId(),
        productId: product.id,
        variantId: large.id,
        variantKey: large.id,
        currencyCode: 'INR',
        basePriceMinor: 1450n,
      },
    ],
  });

  const other = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Examination Glove',
      slug: 'examination-glove',
      sku: 'GLV',
      basePriceMinor: 2000n,
      currency: 'INR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      isStockTracked: false,
      hasVariants: true,
      minOrderQty: 1,
      qtyIncrement: 1,
    },
  });
  otherProductId = other.id;

  const otherVariant = await prisma.productVariant.create({
    data: {
      id: newId(),
      productId: other.id,
      sku: 'GLV-M',
      name: 'Medium',
      optionsJson: { Size: 'M' },
      isActive: true,
    },
  });
  otherVariantId = otherVariant.id;

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: other.id,
      variantId: otherVariant.id,
      variantKey: otherVariant.id,
      currencyCode: 'INR',
      basePriceMinor: 2000n,
    },
  });

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
    data: { id: newId(), userId: user.id, fullName: 'Ward Sister', activatedAt: new Date() },
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

describe('adding several options of one product', () => {
  it('gives every option its own line, its own quantity and its own price', async () => {
    await emptyCart();

    const result = await bulkAdd([
      { productId, variantId: smallVariantId, quantity: 4 },
      { productId, variantId: largeVariantId, quantity: 10 },
    ]);

    expect(result.statusCode, result.raw).toBe(201);

    const lines = result.body.cart?.lines ?? [];
    expect(lines).toHaveLength(2);

    const small = lines.find((line) => line.variantId === smallVariantId);
    const large = lines.find((line) => line.variantId === largeVariantId);

    expect(small?.quantity).toBe(4);
    expect(large?.quantity).toBe(10);

    // Not one line of fourteen, and not both at the same price. Each option is
    // priced from its own row, which is the whole reason they are two lines.
    expect(small?.unitPrice.minor).toBe('1000');
    expect(large?.unitPrice.minor).toBe('1450');
    expect(result.body.cart?.itemCount).toBe(14);
  });

  it('names the option on the line, because the product name cannot tell them apart', async () => {
    await emptyCart();

    const result = await bulkAdd([
      { productId, variantId: smallVariantId, quantity: 1 },
      { productId, variantId: largeVariantId, quantity: 1 },
    ]);
    expect(result.statusCode, result.raw).toBe(201);

    const lines = result.body.cart?.lines ?? [];

    // Both lines say "Disposable Syringe". Without the option name the cart is
    // two identical rows, and the customer has no way to check their own order.
    expect(lines.map((line) => line.name)).toEqual([
      'Disposable Syringe',
      'Disposable Syringe',
    ]);
    expect([...lines.map((line) => line.variantName)].sort()).toEqual(['3 ml', '5 ml']);
    expect([...lines.map((line) => line.sku)].sort()).toEqual(['SYR-3ML', 'SYR-5ML']);
  });

  it('adds up the same option sent twice rather than refusing the request', async () => {
    await emptyCart();

    // What a client retrying half a batch looks like. Six is what a customer
    // who asked for two and four meant, and the unique index means a second
    // line for the same option was never possible anyway.
    const result = await bulkAdd([
      { productId, variantId: smallVariantId, quantity: 2 },
      { productId, variantId: smallVariantId, quantity: 4 },
    ]);

    expect(result.statusCode, result.raw).toBe(201);
    expect(result.body.cart?.lines).toHaveLength(1);
    expect(result.body.cart?.lines?.[0]?.quantity).toBe(6);
  });

  it('increases an option already in the cart instead of making a second line', async () => {
    await emptyCart();

    const first = await bulkAdd([{ productId, variantId: smallVariantId, quantity: 3 }]);
    expect(first.statusCode, first.raw).toBe(201);

    const second = await bulkAdd([
      { productId, variantId: smallVariantId, quantity: 2 },
      { productId, variantId: largeVariantId, quantity: 5 },
    ]);
    expect(second.statusCode, second.raw).toBe(201);

    const lines = second.body.cart?.lines ?? [];
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.variantId === smallVariantId)?.quantity).toBe(5);
    expect(lines.find((line) => line.variantId === largeVariantId)?.quantity).toBe(5);
  });

  it('takes options of different products in one request', async () => {
    await emptyCart();

    const result = await bulkAdd([
      { productId, variantId: smallVariantId, quantity: 1 },
      { productId: otherProductId, variantId: otherVariantId, quantity: 2 },
    ]);

    expect(result.statusCode, result.raw).toBe(201);
    expect(result.body.cart?.lines).toHaveLength(2);
  });
});

describe('a bulk add that cannot be honoured', () => {
  it('writes nothing at all when one option is wrong', async () => {
    await emptyCart();

    // The second entry names a variant of the OTHER product, which is not an
    // option of this one however active it is.
    const result = await bulkAdd([
      { productId, variantId: smallVariantId, quantity: 4 },
      { productId, variantId: otherVariantId, quantity: 4 },
    ]);

    expect(result.statusCode, result.raw).toBe(400);
    expect(result.body.error?.code).toBe('VARIANT_MISMATCH');

    // The point of the whole transaction: the good line is not sitting in the
    // cart under a message that said the add failed.
    expect(await prisma.cartItem.count()).toBe(0);
  });

  it('says which option was wrong', async () => {
    await emptyCart();

    const result = await bulkAdd([
      { productId, variantId: largeVariantId, quantity: 1 },
      { productId, variantId: otherVariantId, quantity: 1 },
    ]);

    expect(result.statusCode, result.raw).toBe(400);

    // Not "variantId". A customer with six options chosen needs to know it was
    // the second one, and a client that highlights a field needs the index to
    // find it.
    expect(result.body.error?.details?.[0]?.field).toBe('items.1.variantId');
  });

  it('still insists on an option for a product that has them', async () => {
    await emptyCart();

    const result = await bulkAdd([{ productId, quantity: 1 }]);

    expect(result.statusCode, result.raw).toBe(400);
    expect(result.body.error?.code).toBe('VARIANT_MISMATCH');
    expect(result.body.error?.details?.[0]?.field).toBe('items.0.variantId');
    expect(await prisma.cartItem.count()).toBe(0);
  });

  it('refuses an empty request rather than answering an unchanged cart', async () => {
    await emptyCart();

    const result = await bulkAdd([]);

    // Zod's own floor. An add that adds nothing is a client bug, and answering
    // 201 would hide it behind a success the customer can see no result of.
    expect(result.statusCode, result.raw).toBe(400);
  });

  it('refuses more options than any product page could offer', async () => {
    await emptyCart();

    const items = Array.from({ length: 51 }, () => ({
      productId,
      variantId: smallVariantId,
      quantity: 1,
    }));

    const result = await bulkAdd(items);

    expect(result.statusCode, result.raw).toBe(400);
    expect(await prisma.cartItem.count()).toBe(0);
  });
});
