/**
 * Catalogue filters - integration, against a real MariaDB.
 *
 * These filters are the shopper's only way to make a large catalogue usable,
 * so what is asserted here is that each one *excludes* the right things. A
 * filter that quietly matches everything looks like it is working right up
 * until somebody buys the wrong thing.
 *
 * Two of them are expressed as column-against-column comparisons - stock on
 * hand against stock reserved, and compare-at price against the price now -
 * which no unit test can stand in for. They either translate to SQL MariaDB
 * accepts or they do not, and that is what this file is for.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
import { prisma } from '../../src/infra/prisma.js';
import { newId } from '../../src/infra/ids.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let currency: string;
let categoryId: string;
let categorySlug: string;
let taxClassId: string;
let locationId: string;

interface ListResponse {
  products: { sku: string; name: string }[];
  currency: string;
  pagination: { total: number };
}

interface FacetResponse {
  currency: string;
  priceRange: { min: { minor: string } | null; max: { minor: string } | null };
  attributes: { name: string; values: { value: string; count: number }[] }[];
}

/** The SKUs a listing came back with, sorted so order is not under test here. */
async function list(query: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/products?limit=60&category=${categorySlug}&${query}`,
  });

  expect(response.statusCode).toBe(200);
  return response
    .json<ListResponse>()
    .products.map((product) => product.sku)
    .sort();
}

/** The facet response for this file's own category. */
async function facets(query = ''): Promise<FacetResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/filters?category=${categorySlug}&${query}`,
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<FacetResponse>();
}

/**
 * A published product, priced in the base currency.
 *
 * Rows are written directly rather than through the admin services: this file
 * is about the read path, and going through publish() would drag in media
 * requirements that have nothing to do with filtering.
 */
async function makeProduct(options: {
  sku: string;
  priceMinor: bigint;
  compareAtMinor?: bigint | null;
  publishedAt?: Date;
  isRecurringEligible?: boolean;
  isStockTracked?: boolean;
  stock?: { onHand: number; reserved: number };
  attributes?: { name: string; value: string; isFilterable: boolean }[];
}): Promise<string> {
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      categoryId,
      name: `Product ${options.sku}`,
      slug: `product-${options.sku.toLowerCase()}`,
      sku: options.sku,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: options.publishedAt ?? new Date(),
      taxClassId,
      basePriceMinor: options.priceMinor,
      currency,
      compareAtPriceMinor: options.compareAtMinor ?? null,
      isStockTracked: options.isStockTracked ?? true,
      isRecurringEligible: options.isRecurringEligible ?? false,
    },
  });

  await prisma.productPrice.create({
    data: {
      id: newId(),
      productId: id,
      variantKey: '',
      currencyCode: currency,
      basePriceMinor: options.priceMinor,
      compareAtPriceMinor: options.compareAtMinor ?? null,
    },
  });

  if (options.stock !== undefined) {
    await prisma.inventoryBalance.create({
      data: {
        id: newId(),
        productId: id,
        variantKey: '',
        locationId,
        onHandQty: options.stock.onHand,
        reservedQty: options.stock.reserved,
      },
    });
  }

  for (const attribute of options.attributes ?? []) {
    await prisma.productAttribute.create({
      data: {
        id: newId(),
        productId: id,
        name: attribute.name,
        value: attribute.value,
        isFilterable: attribute.isFilterable,
      },
    });
  }

  return id;
}

/**
 * Remove only what this file made.
 *
 * The suite shares one database and every file seeds its own catalogue, so a
 * blanket delete here would pull the ground out from under the others - and it
 * did: emptying the category table left the first file of the *next* run with
 * nothing to attach a product to.
 */
async function removeOwnProducts(): Promise<void> {
  const own = await prisma.product.findMany({ where: { categoryId }, select: { id: true } });
  const ids = own.map((product) => product.id);
  if (ids.length === 0) return;

  await prisma.cartItem.deleteMany({ where: { productId: { in: ids } } });
  await prisma.inventoryBalance.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productAttribute.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productPrice.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productVariant.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  currency = await getBaseCurrency();

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: 'FILT', name: 'Filter test', ratePercent: '18' },
  });

  categoryId = newId();
  categorySlug = 'filter-test';
  await prisma.category.create({
    data: {
      id: categoryId,
      name: 'Filter test',
      slug: categorySlug,
      path: categorySlug,
      depth: 0,
      isActive: true,
    },
  });

  locationId = newId();
  await prisma.inventoryLocation.create({
    data: { id: locationId, code: 'FILT-WH', name: 'Filter warehouse' },
  });
});

afterAll(async () => {
  await removeOwnProducts();
  await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.taxClass.deleteMany({ where: { id: taxClassId } });
  await app.close();
});

beforeEach(async () => {
  await removeOwnProducts();
});

describe('GET /api/v1/catalog/products - stock', () => {
  it('keeps only what can actually be bought', async () => {
    await makeProduct({ sku: 'IN-STOCK', priceMinor: 1000n, stock: { onHand: 5, reserved: 0 } });
    await makeProduct({ sku: 'SOLD-OUT', priceMinor: 1000n, stock: { onHand: 0, reserved: 0 } });

    expect(await list('inStockOnly=true')).toEqual(['IN-STOCK']);
  });

  it('counts reserved stock as gone, not as available', async () => {
    // Five on the shelf, all five in somebody else's cart. On hand alone would
    // say this is buyable; it is not.
    await makeProduct({ sku: 'RESERVED', priceMinor: 1000n, stock: { onHand: 5, reserved: 5 } });
    await makeProduct({ sku: 'PARTIAL', priceMinor: 1000n, stock: { onHand: 5, reserved: 4 } });

    expect(await list('inStockOnly=true')).toEqual(['PARTIAL']);
  });

  it('keeps products whose stock is not tracked', async () => {
    // "We do not count these" is not a statement that there are none. Hiding
    // them would empty the catalogue of a business that never used stock
    // control - the most common case in a fresh install.
    await makeProduct({ sku: 'UNTRACKED', priceMinor: 1000n, isStockTracked: false });

    expect(await list('inStockOnly=true')).toEqual(['UNTRACKED']);
  });
});

describe('GET /api/v1/catalog/products - offers', () => {
  it('keeps only products priced below their compare-at price', async () => {
    await makeProduct({ sku: 'REDUCED', priceMinor: 800n, compareAtMinor: 1000n });
    await makeProduct({ sku: 'FULL-PRICE', priceMinor: 1000n });

    expect(await list('onSaleOnly=true')).toEqual(['REDUCED']);
  });

  it('does not call an equal compare-at price an offer', async () => {
    // A compare-at equal to the price is no saving. Listing it under "on
    // offer" would be a lie told to everyone who ticked the box.
    await makeProduct({ sku: 'NOT-REDUCED', priceMinor: 1000n, compareAtMinor: 1000n });

    expect(await list('onSaleOnly=true')).toEqual([]);
  });
});

describe('GET /api/v1/catalog/products - recently added', () => {
  it('keeps only what was published inside the window', async () => {
    const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    await makeProduct({ sku: 'NEW', priceMinor: 1000n, publishedAt: daysAgo(3) });
    await makeProduct({ sku: 'OLD', priceMinor: 1000n, publishedAt: daysAgo(90) });

    expect(await list('addedWithinDays=7')).toEqual(['NEW']);
  });
});

describe('GET /api/v1/catalog/products - attribute facets', () => {
  beforeEach(async () => {
    await makeProduct({
      sku: 'ACME-ZINC',
      priceMinor: 1000n,
      attributes: [
        { name: 'Brand', value: 'Acme', isFilterable: true },
        { name: 'Finish', value: 'Zinc', isFilterable: true },
      ],
    });
    await makeProduct({
      sku: 'ACME-PLAIN',
      priceMinor: 1000n,
      attributes: [
        { name: 'Brand', value: 'Acme', isFilterable: true },
        { name: 'Finish', value: 'Plain', isFilterable: true },
      ],
    });
    await makeProduct({
      sku: 'BOSCH-ZINC',
      priceMinor: 1000n,
      attributes: [
        { name: 'Brand', value: 'Bosch', isFilterable: true },
        { name: 'Finish', value: 'Zinc', isFilterable: true },
      ],
    });
    await makeProduct({
      sku: 'SECRET-SUPPLIER',
      priceMinor: 1000n,
      attributes: [{ name: 'Supplier', value: 'Internal', isFilterable: false }],
    });
  });

  it('matches a single ticked value', async () => {
    expect(await list('attr=Brand:Bosch')).toEqual(['BOSCH-ZINC']);
  });

  it('reads two values of one attribute as either', async () => {
    expect(await list('attr=Brand:Acme&attr=Brand:Bosch')).toEqual([
      'ACME-PLAIN',
      'ACME-ZINC',
      'BOSCH-ZINC',
    ]);
  });

  it('reads two different attributes as both', async () => {
    // The failure this guards against is folding both names into one `some`,
    // which matches a product carrying either - so a Bosch product would come
    // back from a search for Acme in zinc.
    expect(await list('attr=Brand:Acme&attr=Finish:Zinc')).toEqual(['ACME-ZINC']);
  });

  it('ignores an attribute the administrator has not made filterable', async () => {
    // Otherwise any internal specification becomes a public filter by URL, and
    // the catalogue can be enumerated by supplier.
    expect(await list('attr=Supplier:Internal')).toEqual([]);
  });

  it('ignores a malformed pair rather than failing the page', async () => {
    // These arrive from URLs shoppers edit and links that have aged past a
    // renamed attribute. An unreadable filter should narrow nothing.
    expect(await list('attr=nonsense')).toHaveLength(4);
  });
});

describe('GET /api/v1/catalog/filters', () => {
  it('offers only the attributes marked filterable', async () => {
    // Both attributes carry two values, so the only thing separating them is
    // the administrator's decision about which one is a filter.
    await makeProduct({
      sku: 'A',
      priceMinor: 1200n,
      attributes: [
        { name: 'Brand', value: 'Acme', isFilterable: true },
        { name: 'Supplier', value: 'North yard', isFilterable: false },
      ],
    });
    await makeProduct({
      sku: 'B',
      priceMinor: 1200n,
      attributes: [
        { name: 'Brand', value: 'Bosch', isFilterable: true },
        { name: 'Supplier', value: 'South yard', isFilterable: false },
      ],
    });

    const body = await facets();

    expect(body.attributes.map((facet) => facet.name)).toEqual(['Brand']);
  });

  it('does not offer an attribute every product answers the same way', async () => {
    // "Latex: latex-free" across the whole catalogue is a fact about the
    // range, not a way to narrow it: ticking it would remove nothing. A real
    // catalogue has a dozen of these, and offered, they bury the filters that
    // do work.
    await makeProduct({
      sku: 'A',
      priceMinor: 1000n,
      attributes: [{ name: 'Latex', value: 'Latex-free', isFilterable: true }],
    });
    await makeProduct({
      sku: 'B',
      priceMinor: 1000n,
      attributes: [{ name: 'Latex', value: 'Latex-free', isFilterable: true }],
    });

    expect((await facets()).attributes).toEqual([]);
  });

  it('counts each value under the other filters, not the whole catalogue', async () => {
    await makeProduct({
      sku: 'CHEAP',
      priceMinor: 500n,
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });
    await makeProduct({
      sku: 'DEAR',
      priceMinor: 9000n,
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });
    await makeProduct({
      sku: 'OTHER',
      priceMinor: 700n,
      attributes: [{ name: 'Brand', value: 'Bosch', isFilterable: true }],
    });

    // One Acme under a maximum of ten, not the two the catalogue holds: a
    // count taken before the filters would promise results the grid then does
    // not show.
    expect((await facets('maxPrice=1000')).attributes[0]?.values).toEqual([
      { value: 'Acme', count: 1 },
      { value: 'Bosch', count: 1 },
    ]);
  });

  it('counts a value as though it were not itself ticked', async () => {
    // The panel would be unusable otherwise: ticking Acme would drive every
    // other brand to nothing, so a shopper could never widen their choice
    // without clearing the filter first and losing their place.
    await makeProduct({
      sku: 'ACME',
      priceMinor: 1000n,
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });
    await makeProduct({
      sku: 'BOSCH',
      priceMinor: 1000n,
      attributes: [{ name: 'Brand', value: 'Bosch', isFilterable: true }],
    });

    expect((await facets('attr=Brand:Acme')).attributes[0]?.values).toEqual([
      { value: 'Acme', count: 1 },
      { value: 'Bosch', count: 1 },
    ]);
  });

  it('reports the price range the catalogue holds, not the one asked for', async () => {
    await makeProduct({ sku: 'CHEAP', priceMinor: 500n });
    await makeProduct({ sku: 'DEAR', priceMinor: 9000n });

    const body = await facets('minPrice=1000&maxPrice=2000');

    // The hint exists to tell the shopper what is out there. Echoing their own
    // boxes back at them would say nothing at all.
    expect(body.priceRange.min?.minor).toBe('500');
    expect(body.priceRange.max?.minor).toBe('9000');
  });

  it('is empty, not an error, for a category that no longer exists', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/filters?category=gone-away',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<FacetResponse>().attributes).toEqual([]);
  });
});

describe('GET /api/v1/catalog/products - filters together', () => {
  it('narrows by every filter at once', async () => {
    await makeProduct({
      sku: 'WANTED',
      priceMinor: 800n,
      compareAtMinor: 1200n,
      isRecurringEligible: true,
      stock: { onHand: 3, reserved: 0 },
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });
    // Identical but out of stock, so only the stock filter rejects it.
    await makeProduct({
      sku: 'OUT-OF-STOCK',
      priceMinor: 800n,
      compareAtMinor: 1200n,
      isRecurringEligible: true,
      stock: { onHand: 0, reserved: 0 },
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });
    // Identical but full price, so only the offers filter rejects it.
    await makeProduct({
      sku: 'FULL-PRICE',
      priceMinor: 800n,
      isRecurringEligible: true,
      stock: { onHand: 3, reserved: 0 },
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });

    const query = [
      'minPrice=500',
      'maxPrice=1000',
      'inStockOnly=true',
      'onSaleOnly=true',
      'recurringOnly=true',
      'addedWithinDays=30',
      'attr=Brand:Acme',
    ].join('&');

    expect(await list(query)).toEqual(['WANTED']);
  });

  it('reports a total that matches the filtered list', async () => {
    await makeProduct({ sku: 'REDUCED', priceMinor: 800n, compareAtMinor: 1000n });
    await makeProduct({ sku: 'FULL-PRICE', priceMinor: 1000n });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products?category=${categorySlug}&onSaleOnly=true`,
    });
    const body = response.json<ListResponse>();

    // The count sits above the grid and is what a shopper reads first. A total
    // taken before the filters would contradict what they can see.
    expect(body.pagination.total).toBe(1);
    expect(body.products).toHaveLength(1);
  });
});
