/**
 * The public verified-supplier list, and the catalogue filtered to one
 * supplier - what the home page's "Verified suppliers" section is built on.
 *
 * The claims that have to hold, because the word "verified" is on the page:
 *
 *   - **Only an approved seller is listed.** A draft, a submitted application,
 *     a rejected one, a suspended one and an archived one never appear.
 *   - **Only a seller with something to sell is listed.** An approved seller
 *     whose only offer is paused, or whose product is unpublished, is absent -
 *     a card that opens an empty catalogue is a broken promise.
 *   - **The product count counts products, not offers.**
 *   - **The country breakdown covers every verified supplier**, whatever the
 *     page size, so the home page can only say "from India" when it is true.
 *   - **The filtered catalogue shows exactly that supplier's live products**,
 *     and a suspended supplier's old link shows nothing.
 *   - **Bad input is refused**, and the page size is capped.
 *
 * Suppliers here are registered in Zimbabwe (ZW), which no other test uses,
 * so the counts are this file's own even on a shared test database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';

const PREFIX = 'supdir-';
const COUNTRY = 'ZW';

let app: Awaited<ReturnType<typeof buildApp>>;
let currency = '';
let categoryId = '';
let taxClassId = '';
const productIds: string[] = [];

interface SupplierResponse {
  suppliers: {
    slug: string;
    displayName: string;
    kind: string;
    registrationCountry: string;
    verifiedAt: string | null;
    productCount: number;
    logoUrl: string | null;
  }[];
  countries: { country: string; count: number }[];
  total: number;
}

async function suppliers(query: string): Promise<SupplierResponse> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers?${query}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<SupplierResponse>();
}

async function makeSeller(input: {
  slug: string;
  status: 'DRAFT' | 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  approvedAt?: Date | null;
  suspendedAt?: Date | null;
  archivedAt?: Date | null;
}): Promise<string> {
  const id = newId();
  const displayName = `Supdir ${input.slug}`;
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Pvt Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug: `${PREFIX}${input.slug}`,
      kind: 'MANUFACTURER',
      registrationCountry: COUNTRY,
      status: input.status,
      approvedAt: input.approvedAt ?? null,
      suspendedAt: input.suspendedAt ?? null,
      archivedAt: input.archivedAt ?? null,
    },
  });
  return id;
}

async function makeProduct(sku: string, published = true): Promise<string> {
  const id = newId();
  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `Supplier directory ${sku}`,
      slug: `${PREFIX}${sku.toLowerCase()}`,
      sku,
      basePriceMinor: 1000n,
      currency,
      status: 'ACTIVE',
      isPublished: published,
      publishedAt: new Date(),
    },
  });
  await prisma.productPrice.create({
    data: { id: newId(), productId: id, currencyCode: currency, variantKey: '', basePriceMinor: 1000n },
  });
  productIds.push(id);
  return id;
}

async function offer(
  sellerAccountId: string,
  productId: string,
  sku: string,
  status: 'ACTIVE' | 'PAUSED' = 'ACTIVE',
): Promise<void> {
  await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId,
      productId,
      variantKey: sku,
      sellerSku: sku,
      status,
      priceMinor: 900n,
      currency,
    },
  });
}

async function cleanUp(): Promise<void> {
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.taxClass.deleteMany({ where: { code: 'SUPDIR' } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  currency = await getBaseCurrency();

  taxClassId = newId();
  await prisma.taxClass.create({
    data: { id: taxClassId, code: 'SUPDIR', name: 'Supplier directory', ratePercent: '18' },
  });
  categoryId = newId();
  await prisma.category.create({
    data: { id: categoryId, name: 'Supplier directory', slug: `${PREFIX}category`, isActive: true },
  });

  const gloves = await makeProduct('SUPDIR-GLOVE');
  const masks = await makeProduct('SUPDIR-MASK');
  const hidden = await makeProduct('SUPDIR-HIDDEN', false);

  // Listed: approved, two products (one of them offered twice, in two sizes).
  const acme = await makeSeller({ slug: 'acme', status: 'APPROVED', approvedAt: new Date('2026-01-10') });
  await offer(acme, gloves, 'ACME-G-S');
  await offer(acme, gloves, 'ACME-G-M');
  await offer(acme, masks, 'ACME-M');

  // Listed: approved before the approval date was recorded.
  const older = await makeSeller({ slug: 'older', status: 'APPROVED', approvedAt: null });
  await offer(older, masks, 'OLDER-M');

  // Never listed, whatever they offer.
  for (const status of ['DRAFT', 'SUBMITTED', 'REJECTED'] as const) {
    const id = await makeSeller({ slug: status.toLowerCase(), status });
    await offer(id, gloves, `${status}-G`);
  }
  const suspended = await makeSeller({
    slug: 'suspended',
    status: 'SUSPENDED',
    approvedAt: new Date('2026-01-01'),
    suspendedAt: new Date('2026-02-01'),
  });
  await offer(suspended, gloves, 'SUSP-G');
  const archived = await makeSeller({
    slug: 'archived',
    status: 'APPROVED',
    approvedAt: new Date('2026-01-01'),
    archivedAt: new Date('2026-02-01'),
  });
  await offer(archived, gloves, 'ARCH-G');

  // Approved, but nothing live: a paused offer, and an unpublished product.
  const paused = await makeSeller({ slug: 'paused', status: 'APPROVED', approvedAt: new Date() });
  await offer(paused, gloves, 'PAUSED-G', 'PAUSED');
  const unpublished = await makeSeller({ slug: 'unpublished', status: 'APPROVED', approvedAt: new Date() });
  await offer(unpublished, hidden, 'UNPUB-H');
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('GET /api/v1/catalog/suppliers', () => {
  it('lists only approved suppliers with something live to sell', async () => {
    const body = await suppliers(`country=${COUNTRY}&limit=24`);

    // Longest-verified first. A supplier approved before the date was recorded
    // sorts ahead of every dated one: a NULL is lowest in ascending order.
    expect(body.suppliers.map((row) => row.slug)).toEqual([`${PREFIX}older`, `${PREFIX}acme`]);
    expect(body.total).toBe(2);
  });

  it('sort=newest puts the most recently verified first and drops undated approvals', async () => {
    const body = await suppliers(`country=${COUNTRY}&limit=24&sort=newest`);

    // `older` has no approval date, so it cannot be "recently verified".
    expect(body.suppliers.map((row) => row.slug)).toEqual([`${PREFIX}acme`]);
  });

  it('counts products, not offers, and never invents an approval date', async () => {
    const body = await suppliers(`country=${COUNTRY}&limit=24`);
    const acme = body.suppliers.find((row) => row.slug === `${PREFIX}acme`);
    const older = body.suppliers.find((row) => row.slug === `${PREFIX}older`);

    expect(acme).toMatchObject({
      displayName: 'Supdir acme',
      kind: 'MANUFACTURER',
      registrationCountry: COUNTRY,
      productCount: 2,
      verifiedAt: '2026-01-10T00:00:00.000Z',
      logoUrl: null,
    });
    expect(older).toMatchObject({ productCount: 1, verifiedAt: null });
  });

  it('never exposes the legal name, notes or internal identifiers', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/suppliers?country=${COUNTRY}`,
    });
    expect(response.body).not.toContain('Pvt Ltd');
    expect(response.body).not.toContain('"id"');
    expect(response.body).not.toContain('internalNotes');
  });

  it('reports every verified country with its full count, whatever the page size', async () => {
    const body = await suppliers(`country=${COUNTRY}&limit=1`);

    expect(body.suppliers).toHaveLength(1);
    expect(body.total).toBe(2);
    // The breakdown is of every verified supplier, not only this country's.
    expect(body.countries).toContainEqual({ country: COUNTRY, count: 2 });
  });

  it('answers exactly one supplier by slug, and nothing for an unlisted one', async () => {
    expect((await suppliers(`slug=${PREFIX}acme`)).suppliers.map((row) => row.slug)).toEqual([
      `${PREFIX}acme`,
    ]);
    expect((await suppliers(`slug=${PREFIX}suspended`)).suppliers).toEqual([]);
    expect((await suppliers(`slug=${PREFIX}draft`)).suppliers).toEqual([]);
  });

  it('accepts a lower-case country code', async () => {
    expect((await suppliers(`country=${COUNTRY.toLowerCase()}`)).total).toBe(2);
  });

  it.each([
    ['limit=0'],
    ['limit=25'],
    ['limit=abc'],
    ['country=ZWE'],
    ['country=1'],
    ['slug=Not%20A%20Slug'],
    [`slug=${'a'.repeat(181)}`],
  ])('refuses %s', async (query) => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers?${query}` });
    expect(response.statusCode).toBe(400);
  });
});

describe('GET /api/v1/catalog/products?seller=', () => {
  async function skus(seller: string): Promise<string[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products?limit=60&category=${PREFIX}category&seller=${seller}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response
      .json<{ products: { sku: string }[] }>()
      .products.map((product) => product.sku)
      .sort();
  }

  it('shows exactly the products that supplier has a live offer on', async () => {
    expect(await skus(`${PREFIX}acme`)).toEqual(['SUPDIR-GLOVE', 'SUPDIR-MASK']);
    expect(await skus(`${PREFIX}older`)).toEqual(['SUPDIR-MASK']);
  });

  it('shows nothing for a supplier who is suspended, unapproved or only paused', async () => {
    expect(await skus(`${PREFIX}suspended`)).toEqual([]);
    expect(await skus(`${PREFIX}draft`)).toEqual([]);
    expect(await skus(`${PREFIX}paused`)).toEqual([]);
    expect(await skus(`${PREFIX}nobody`)).toEqual([]);
  });

  it('refuses a malformed supplier slug', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/catalog/products?seller=%3Cscript%3E',
    });
    expect(response.statusCode).toBe(400);
  });
});
