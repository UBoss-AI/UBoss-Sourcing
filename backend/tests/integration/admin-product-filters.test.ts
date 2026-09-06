/**
 * The admin product list's filters - integration, over HTTP.
 *
 * The list an administrator works from must be able to answer the questions
 * the storefront can answer, and answer them the same way: "in stock" cannot
 * mean one thing on the shop and another on the screen used to check the shop.
 * Both sides now share one set of rules, so what is asserted here is that this
 * route really uses them.
 *
 * Two of the filters compare one column against another - stock on hand
 * against stock reserved, compare-at price against the price now, one of them
 * inside a NOT - which no unit test can stand in for. They either translate to
 * SQL MariaDB accepts or they do not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let cookies: string;
let categoryId: string;
let taxClassId: string;
let locationId: string;

const EMAIL = 'product-filters@test.local';
const PASSWORD = 'ProductFilters!2026';

interface ListResponse {
  products: { sku: string }[];
  pagination: { total: number };
}

interface FilterResponse {
  currency: string;
  priceRange: { min: { minor: string } | null; max: { minor: string } | null };
  attributes: { name: string; values: { value: string; count: number }[] }[];
}

/** The SKUs the list came back with, sorted — order is not under test here. */
async function list(query: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/products?limit=100&${query}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response
    .json<ListResponse>()
    .products.map((product) => product.sku)
    .sort();
}

async function filters(query = ''): Promise<FilterResponse> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/admin/products/filters?${query}`,
    headers: { cookie: cookies },
  });

  expect(response.statusCode, response.body).toBe(200);
  return response.json<FilterResponse>();
}

async function makeProduct(options: {
  sku: string;
  priceMinor: bigint;
  compareAtMinor?: bigint | null;
  status?: 'DRAFT' | 'ACTIVE' | 'INACTIVE';
  isPublished?: boolean;
  createdAt?: Date;
  isRecurringEligible?: boolean;
  isStockTracked?: boolean;
  stock?: { onHand: number; reserved: number };
  attributes?: { name: string; value: string; isFilterable: boolean }[];
}): Promise<void> {
  const id = newId();

  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `Product ${options.sku}`,
      slug: `admin-filter-${options.sku.toLowerCase()}`,
      sku: options.sku,
      status: options.status ?? 'ACTIVE',
      isPublished: options.isPublished ?? false,
      basePriceMinor: options.priceMinor,
      currency: 'INR',
      compareAtPriceMinor: options.compareAtMinor ?? null,
      isStockTracked: options.isStockTracked ?? true,
      isRecurringEligible: options.isRecurringEligible ?? false,
      ...(options.createdAt === undefined ? {} : { createdAt: options.createdAt }),
      ...(options.attributes === undefined
        ? {}
        : {
            attributes: {
              create: options.attributes.map((attribute, index) => ({
                id: newId(),
                name: attribute.name,
                value: attribute.value,
                sortOrder: index,
                isFilterable: attribute.isFilterable,
              })),
            },
          }),
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
}

/**
 * Remove only what this file made.
 *
 * The suite shares one database and other files seed their own catalogue, so a
 * blanket delete here would pull the ground out from under them.
 */
async function removeOwnProducts(): Promise<void> {
  const own = await prisma.product.findMany({
    where: { categoryId },
    select: { id: true },
  });
  const ids = own.map((product) => product.id);
  if (ids.length === 0) return;

  await prisma.inventoryBalance.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productAttribute.deleteMany({ where: { productId: { in: ids } } });
  await prisma.productPrice.deleteMany({ where: { productId: { in: ids } } });
  await prisma.product.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });

  const catalogRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.CATALOG_MANAGER },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: catalogRole.id } },
    },
  });

  // A distinct IP, so a neighbouring test cannot spend this file's login budget.
  ({ cookies } = await signInAdmin(app, {
    email: EMAIL,
    password: PASSWORD,
    ip: '203.0.113.92',
  }));

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: 'AFILT', name: 'Admin filter test', ratePercent: '18' },
  });

  categoryId = newId();
  await prisma.category.create({
    data: {
      id: categoryId,
      name: 'Admin filter test',
      slug: 'admin-filter-test',
      path: 'admin-filter-test',
      depth: 0,
      isActive: true,
    },
  });

  locationId = newId();
  await prisma.inventoryLocation.create({
    data: { id: locationId, code: 'AFILT-WH', name: 'Admin filter warehouse' },
  });
});

afterAll(async () => {
  await removeOwnProducts();
  await prisma.inventoryLocation.deleteMany({ where: { id: locationId } });
  await prisma.category.deleteMany({ where: { id: categoryId } });
  await prisma.taxClass.deleteMany({ where: { id: taxClassId } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await app.close();
});

beforeEach(async () => {
  await removeOwnProducts();
});

/** Scoped to this file's own category, so other files' products cannot answer. */
function inThisCategory(query = ''): string {
  return `categoryId=${categoryId}${query === '' ? '' : `&${query}`}`;
}

describe('GET /admin/products - price', () => {
  it('narrows to a band of base prices', async () => {
    await makeProduct({ sku: 'AF-CHEAP', priceMinor: 500n });
    await makeProduct({ sku: 'AF-MID', priceMinor: 5000n });
    await makeProduct({ sku: 'AF-DEAR', priceMinor: 90_000n });

    expect(await list(inThisCategory('minPrice=1000&maxPrice=10000'))).toEqual(['AF-MID']);
  });
});

describe('GET /admin/products - stock', () => {
  it('finds what can still be sold, counting reserved stock as gone', async () => {
    await makeProduct({ sku: 'AF-HAS', priceMinor: 1000n, stock: { onHand: 5, reserved: 0 } });
    await makeProduct({ sku: 'AF-RESERVED', priceMinor: 1000n, stock: { onHand: 5, reserved: 5 } });

    expect(await list(inThisCategory('stock=in'))).toEqual(['AF-HAS']);
  });

  it('finds what has run out, and does not call untracked products empty', async () => {
    await makeProduct({ sku: 'AF-EMPTY', priceMinor: 1000n, stock: { onHand: 0, reserved: 0 } });
    await makeProduct({ sku: 'AF-NO-ROW', priceMinor: 1000n });
    await makeProduct({ sku: 'AF-HAS', priceMinor: 1000n, stock: { onHand: 5, reserved: 0 } });
    // Not counted at all, so "out of stock" is not a true thing to say about
    // it — and saying it would send somebody to reorder what they already have.
    await makeProduct({ sku: 'AF-UNTRACKED', priceMinor: 1000n, isStockTracked: false });

    // A tracked product with no balance row anywhere has none of it, the same
    // as one whose row says zero.
    expect(await list(inThisCategory('stock=out'))).toEqual(['AF-EMPTY', 'AF-NO-ROW']);
  });
});

describe('GET /admin/products - offers and repeat orders', () => {
  it('finds products marked down below their compare-at price', async () => {
    await makeProduct({ sku: 'AF-REDUCED', priceMinor: 800n, compareAtMinor: 1000n });
    await makeProduct({ sku: 'AF-LEVEL', priceMinor: 1000n, compareAtMinor: 1000n });
    await makeProduct({ sku: 'AF-PLAIN', priceMinor: 1000n });

    expect(await list(inThisCategory('onSaleOnly=true'))).toEqual(['AF-REDUCED']);
  });

  it('finds products customers can put on a schedule', async () => {
    await makeProduct({ sku: 'AF-REPEAT', priceMinor: 1000n, isRecurringEligible: true });
    await makeProduct({ sku: 'AF-ONCE', priceMinor: 1000n });

    expect(await list(inThisCategory('recurringOnly=true'))).toEqual(['AF-REPEAT']);
  });
});

describe('GET /admin/products - recently added', () => {
  it('measures from when the product was created, not published', async () => {
    const daysAgo = (days: number): Date => new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // A draft has never been published, and it is exactly the row somebody
    // comes to this screen to find. Measuring on publishedAt would hide it.
    await makeProduct({
      sku: 'AF-NEW-DRAFT',
      priceMinor: 1000n,
      status: 'DRAFT',
      createdAt: daysAgo(2),
    });
    await makeProduct({ sku: 'AF-OLD', priceMinor: 1000n, createdAt: daysAgo(120) });

    expect(await list(inThisCategory('addedWithinDays=7'))).toEqual(['AF-NEW-DRAFT']);
  });
});

describe('GET /admin/products - attributes', () => {
  beforeEach(async () => {
    await makeProduct({
      sku: 'AF-ACME-ZINC',
      priceMinor: 1000n,
      attributes: [
        { name: 'Brand', value: 'Acme', isFilterable: true },
        { name: 'Finish', value: 'Zinc', isFilterable: true },
      ],
    });
    await makeProduct({
      sku: 'AF-ACME-PLAIN',
      priceMinor: 1000n,
      attributes: [
        { name: 'Brand', value: 'Acme', isFilterable: true },
        { name: 'Finish', value: 'Plain', isFilterable: true },
      ],
    });
    await makeProduct({
      sku: 'AF-BOSCH-ZINC',
      priceMinor: 1000n,
      attributes: [
        { name: 'Brand', value: 'Bosch', isFilterable: true },
        { name: 'Finish', value: 'Zinc', isFilterable: true },
      ],
    });
  });

  it('reads two different attributes as both', async () => {
    expect(await list(inThisCategory('attr=Brand:Acme&attr=Finish:Zinc'))).toEqual([
      'AF-ACME-ZINC',
    ]);
  });

  it('reads two values of one attribute as either', async () => {
    expect(await list(inThisCategory('attr=Finish:Zinc&attr=Finish:Plain'))).toEqual([
      'AF-ACME-PLAIN',
      'AF-ACME-ZINC',
      'AF-BOSCH-ZINC',
    ]);
  });
});

describe('GET /admin/products - filters together', () => {
  it('narrows by every filter at once and reports a matching total', async () => {
    await makeProduct({
      sku: 'AF-WANTED',
      priceMinor: 800n,
      compareAtMinor: 1200n,
      status: 'DRAFT',
      isRecurringEligible: true,
      stock: { onHand: 4, reserved: 1 },
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });
    // Identical, but published — so only the storefront filter rejects it.
    await makeProduct({
      sku: 'AF-LIVE',
      priceMinor: 800n,
      compareAtMinor: 1200n,
      status: 'ACTIVE',
      isPublished: true,
      isRecurringEligible: true,
      stock: { onHand: 4, reserved: 1 },
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });

    const query = inThisCategory(
      [
        'published=false',
        'minPrice=500',
        'maxPrice=1000',
        'stock=in',
        'onSaleOnly=true',
        'recurringOnly=true',
        'addedWithinDays=30',
        'attr=Brand:Acme',
      ].join('&'),
    );

    expect(await list(query)).toEqual(['AF-WANTED']);

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/products?${query}`,
      headers: { cookie: cookies },
    });

    // The pager reads this. A total taken before the filters would say two
    // pages of results exist behind a list showing one row.
    expect(response.json<ListResponse>().pagination.total).toBe(1);
  });
});

describe('GET /admin/products/filters', () => {
  it('offers filterable attributes of drafts too', async () => {
    // The storefront cannot see a draft. This screen exists to work on them,
    // so a facet that ignored them would be useless on a catalogue being set
    // up for the first time.
    await makeProduct({
      sku: 'AF-DRAFT-A',
      priceMinor: 1000n,
      status: 'DRAFT',
      attributes: [
        { name: 'Brand', value: 'Acme', isFilterable: true },
        { name: 'Supplier', value: 'North yard', isFilterable: false },
      ],
    });
    await makeProduct({
      sku: 'AF-DRAFT-B',
      priceMinor: 1000n,
      status: 'DRAFT',
      attributes: [
        { name: 'Brand', value: 'Bosch', isFilterable: true },
        { name: 'Supplier', value: 'South yard', isFilterable: false },
      ],
    });

    const body = await filters(`categoryId=${categoryId}`);
    const brand = body.attributes.find((facet) => facet.name === 'Brand');

    expect(brand?.values).toEqual([
      { value: 'Acme', count: 1 },
      { value: 'Bosch', count: 1 },
    ]);
    // Marked unfilterable, so it stays internal — an administrator's own
    // supplier notes are not a filter somebody can enumerate.
    expect(body.attributes.map((facet) => facet.name)).not.toContain('Supplier');
  });

  it('reports the price range the catalogue holds, not the one asked for', async () => {
    await makeProduct({ sku: 'AF-CHEAP', priceMinor: 500n });
    await makeProduct({ sku: 'AF-DEAR', priceMinor: 90_000n });

    const body = await filters(`categoryId=${categoryId}&minPrice=1000&maxPrice=2000`);

    expect(body.priceRange.min?.minor).toBe('500');
    expect(body.priceRange.max?.minor).toBe('90000');
  });

  it('counts a value as though it were not itself ticked', async () => {
    await makeProduct({
      sku: 'AF-ACME',
      priceMinor: 1000n,
      attributes: [{ name: 'Brand', value: 'Acme', isFilterable: true }],
    });
    await makeProduct({
      sku: 'AF-BOSCH',
      priceMinor: 1000n,
      attributes: [{ name: 'Brand', value: 'Bosch', isFilterable: true }],
    });

    const body = await filters(`categoryId=${categoryId}&attr=Brand:Acme`);

    expect(body.attributes.find((facet) => facet.name === 'Brand')?.values).toEqual([
      { value: 'Acme', count: 1 },
      { value: 'Bosch', count: 1 },
    ]);
  });

  it('needs the same permission as the list it describes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/products/filters' });

    // Without this, the attribute vocabulary of an entire private catalogue is
    // readable by anyone who guesses the path.
    expect(response.statusCode).toBe(401);
  });
});
