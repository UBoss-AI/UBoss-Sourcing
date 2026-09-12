/**
 * A product with a long slug opens - integration, against a real MariaDB.
 *
 * The slug is a route parameter, and a router has an opinion about how long a
 * route parameter may be. Fastify's default is 100 characters, which is fine
 * for a hand-written catalogue and not fine for an imported one: a supplier
 * sheet names a line "In-line arterial blood sampling kit (syringe with /
 * without accessories) 3 ml, easy blood sampling kit with 27G x 1.5 safety
 * needle, blister pack", and the slug made from it is 145 characters.
 *
 * Over the limit the router answers 414 before the handler runs, so the shop
 * shows "the server returned an unexpected 414 response" on a product that is
 * published, priced and perfectly fine. This file is the guard: it asks for a
 * product by a slug as long as the column allows and expects the product back.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let categoryId: string;
let taxClassId: string;

/** 145 characters - the real imported slug that first showed the bug. */
const LONG_SLUG =
  'in-line-arterial-blood-sampling-kit-syringe-with-without-accessories-3-ml-air-pro-easy-blood-sampling-kit-with-27gx1-5-safety-needle-blister-pack';

/** The widest the column allows, which is the widest the route must accept. */
const MAX_SLUG = `max-${'a'.repeat(251)}`;

async function resetAll(): Promise<void> {
  await prisma.productPrice.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
}

async function makeProduct(slug: string, sku: string): Promise<void> {
  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId,
      taxClassId,
      name: 'In-line arterial blood sampling kit',
      slug,
      sku,
      basePriceMinor: 12_100n,
      currency: 'EUR',
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
    },
  });

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: product.id,
      variantKey: '',
      currencyCode: 'EUR',
      basePriceMinor: 12_100n,
    },
  });
}

beforeAll(async () => {
  app = await buildApp();

  // Shared reference data: upserted and never deleted, so this file does not
  // break whichever one runs after it.
  await prisma.currency.upsert({
    where: { code: 'EUR' },
    update: {},
    create: { code: 'EUR', name: 'Euro', symbol: '€', exponent: 2, sortOrder: 30 },
  });
});

beforeEach(async () => {
  await resetAll();

  const taxClass = await prisma.taxClass.create({
    data: {
      id: newId(),
      code: 'VAT-STD',
      name: 'Standard rate',
      ratePercent: '21.000000',
      isInclusive: true,
      isDefault: true,
      isActive: true,
    },
  });
  taxClassId = taxClass.id;

  const category = await prisma.category.create({
    data: { id: newId(), name: 'Consumables', slug: 'consumables', isActive: true },
  });
  categoryId = category.id;
});

afterAll(async () => {
  await resetAll();
  await app.close();
  await prisma.$disconnect();
});

describe('a slug longer than the router default', () => {
  it('opens the product instead of answering 414', async () => {
    await makeProduct(LONG_SLUG, 'SAMPLING-3ML');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${LONG_SLUG}?currency=EUR`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ product: { sku: string } }>().product.sku).toBe('SAMPLING-3ML');
  });

  it('accepts a slug as wide as the column', async () => {
    await makeProduct(MAX_SLUG, 'SAMPLING-MAX');

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${MAX_SLUG}?currency=EUR`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ product: { sku: string } }>().product.sku).toBe('SAMPLING-MAX');
  });

  it('still 404s a long slug that names nothing', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products/${LONG_SLUG}?currency=EUR`,
    });

    expect(response.statusCode).toBe(404);
  });
});
