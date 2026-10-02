/**
 * Market eligibility in the catalogue - checklist Master row 2.
 *
 * A product the operator has blocked for a destination must not be offered to
 * a shopper there: not in the grid, not in search, not in the facet counts.
 * The claims:
 *
 *   - **A product rule hides that product**, for that destination only.
 *   - **A category rule hides everything beneath the category**, however deep.
 *   - **No destination, no rule**: a shopper who has not said where they are
 *     sees the whole catalogue.
 *   - **Only rules in force count**: inactive, not yet effective and expired
 *     rules hide nothing, and DOCUMENTS_REQUIRED informs rather than hides.
 *   - **A wholly blocked category lists nothing**, but still opens.
 *   - **Supplier search** matches the public name and nothing else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';

const PREFIX = 'mkt-elig-';
// Countries no other test file writes rules for.
const BLOCKED_IN = 'KI';
const ELSEWHERE = 'TV';

let app: Awaited<ReturnType<typeof buildApp>>;
let currency = '';
let taxClassId = '';
let parentId = '';
let childId = '';
let otherId = '';
const ids: Record<string, string> = {};

async function category(slug: string, parent: { id: string; path: string } | null): Promise<{ id: string; path: string }> {
  const id = newId();
  const path = parent === null ? '/' : `${parent.path}${parent.id}/`;
  await prisma.category.create({
    data: { id, name: `Market ${slug}`, slug: `${PREFIX}${slug}`, isActive: true, parentId: parent?.id ?? null, path },
  });
  return { id, path };
}

async function product(sku: string, categoryId: string): Promise<string> {
  const id = newId();
  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `Market eligibility ${sku}`,
      slug: `${PREFIX}${sku.toLowerCase()}`,
      sku,
      basePriceMinor: 1000n,
      currency,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
    },
  });
  await prisma.productPrice.create({
    data: { id: newId(), productId: id, currencyCode: currency, variantKey: '', basePriceMinor: 1000n },
  });
  ids[sku] = id;
  return id;
}

async function rule(input: {
  productId?: string;
  categoryId?: string;
  effect?: 'BLOCK' | 'DOCUMENTS_REQUIRED';
  isActive?: boolean;
  from?: Date;
  until?: Date | null;
  country?: string;
}): Promise<void> {
  await prisma.marketRule.create({
    data: {
      id: newId(),
      scope: input.productId === undefined ? 'CATEGORY' : 'PRODUCT',
      productId: input.productId ?? null,
      categoryId: input.categoryId ?? null,
      countryCode: input.country ?? BLOCKED_IN,
      effect: input.effect ?? 'BLOCK',
      reason: `${PREFIX}test rule`,
      source: 'test',
      version: '1',
      ownerName: 'Compliance',
      effectiveFrom: input.from ?? new Date(Date.now() - 86_400_000),
      effectiveUntil: input.until ?? null,
      isActive: input.isActive ?? true,
    },
  });
}

async function skus(query: string): Promise<string[]> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/products?limit=60&category=${PREFIX}root,${PREFIX}other&${query}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response
    .json<{ products: { sku: string }[] }>()
    .products.map((row) => row.sku)
    .sort();
}

async function cleanUp(): Promise<void> {
  await prisma.marketRule.deleteMany({ where: { reason: { startsWith: PREFIX } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  // Children first: a category row refers to its parent.
  await prisma.category.deleteMany({ where: { slug: { startsWith: `${PREFIX}child` } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.taxClass.deleteMany({ where: { code: 'MKTELIG' } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  currency = await getBaseCurrency();
  taxClassId = newId();
  await prisma.taxClass.create({ data: { id: taxClassId, code: 'MKTELIG', name: 'Market', ratePercent: '18' } });

  const root = await category('root', null);
  parentId = root.id;
  const child = await category('child', root);
  childId = child.id;
  const other = await category('other', null);
  otherId = other.id;

  await product('MKT-OPEN', otherId);
  const blockedProduct = await product('MKT-PRODUCT-BLOCK', otherId);
  await product('MKT-IN-PARENT', parentId);
  await product('MKT-IN-CHILD', childId);
  const docs = await product('MKT-DOCS', otherId);
  const inactive = await product('MKT-INACTIVE-RULE', otherId);
  const future = await product('MKT-FUTURE-RULE', otherId);
  const expired = await product('MKT-EXPIRED-RULE', otherId);
  const elsewhere = await product('MKT-BLOCKED-ELSEWHERE', otherId);

  await rule({ productId: blockedProduct });
  await rule({ categoryId: parentId });
  await rule({ productId: docs, effect: 'DOCUMENTS_REQUIRED' });
  await rule({ productId: inactive, isActive: false });
  await rule({ productId: future, from: new Date(Date.now() + 86_400_000) });
  await rule({ productId: expired, from: new Date(Date.now() - 2 * 86_400_000), until: new Date(Date.now() - 1000) });
  await rule({ productId: elsewhere, country: ELSEWHERE });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

const EVERYTHING = [
  'MKT-BLOCKED-ELSEWHERE',
  'MKT-DOCS',
  'MKT-EXPIRED-RULE',
  'MKT-FUTURE-RULE',
  'MKT-IN-CHILD',
  'MKT-IN-PARENT',
  'MKT-INACTIVE-RULE',
  'MKT-OPEN',
  'MKT-PRODUCT-BLOCK',
];

describe('market eligibility in the catalogue', () => {
  it('shows everything to a shopper who has not said where they are', async () => {
    expect(await skus('')).toEqual(EVERYTHING);
  });

  it('leaves out the blocked product and the whole blocked category for that destination', async () => {
    expect(await skus(`country=${BLOCKED_IN}`)).toEqual([
      'MKT-BLOCKED-ELSEWHERE',
      'MKT-DOCS',
      'MKT-EXPIRED-RULE',
      'MKT-FUTURE-RULE',
      'MKT-INACTIVE-RULE',
      'MKT-OPEN',
    ]);
  });

  it('accepts the destination in lower case', async () => {
    expect(await skus(`country=${BLOCKED_IN.toLowerCase()}`)).not.toContain('MKT-PRODUCT-BLOCK');
  });

  it('applies each rule only to its own destination', async () => {
    const elsewhere = await skus(`country=${ELSEWHERE}`);
    expect(elsewhere).not.toContain('MKT-BLOCKED-ELSEWHERE');
    expect(elsewhere).toContain('MKT-PRODUCT-BLOCK');
    expect(elsewhere).toContain('MKT-IN-CHILD');
  });

  it('keeps blocked products out of a search too', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products?limit=60&q=Market%20eligibility&country=${BLOCKED_IN}`,
    });
    const found = response.json<{ products: { sku: string }[] }>().products.map((row) => row.sku);
    expect(found).toContain('MKT-OPEN');
    expect(found).not.toContain('MKT-PRODUCT-BLOCK');
    expect(found).not.toContain('MKT-IN-CHILD');
  });

  it('lists nothing in a category blocked as a whole, while the category page itself still opens', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/categories/${PREFIX}root?country=${BLOCKED_IN}`,
    });
    // The category page itself still resolves; its grid is what is filtered.
    expect(response.statusCode).toBe(200);
    const listing = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/products?limit=60&category=${PREFIX}root&country=${BLOCKED_IN}`,
    });
    expect(listing.json<{ pagination: { total: number } }>().pagination.total).toBe(0);
  });
});

describe('GET /api/v1/catalog/suppliers?q=', () => {
  beforeAll(async () => {
    const offerProduct = ids['MKT-OPEN'] as string;
    for (const [slug, name] of [
      ['acme', 'Acme Precision Castings'],
      ['bharat', 'Bharat Textiles'],
    ] as const) {
      const id = newId();
      await prisma.sellerAccount.create({
        data: {
          id,
          legalName: `${name} Private Limited`,
          displayName: name,
          displayNameNormalized: name.toLowerCase(),
          slug: `${PREFIX}${slug}`,
          kind: 'MANUFACTURER',
          registrationCountry: 'IN',
          status: 'APPROVED',
          approvedAt: new Date(),
        },
      });
      await prisma.sellerOffer.create({
        data: { id: newId(), sellerAccountId: id, productId: offerProduct, variantKey: slug, sellerSku: slug, status: 'ACTIVE', priceMinor: 900n, currency },
      });
    }
  });

  async function names(q: string): Promise<string[]> {
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers?limit=24&q=${encodeURIComponent(q)}` });
    expect(response.statusCode).toBe(200);
    return response
      .json<{ suppliers: { displayName: string }[] }>()
      .suppliers.map((row) => row.displayName)
      .filter((name) => name === 'Acme Precision Castings' || name === 'Bharat Textiles');
  }

  it('matches words in the public name', async () => {
    expect(await names('castings')).toEqual(['Acme Precision Castings']);
    expect(await names('Bharat')).toEqual(['Bharat Textiles']);
  });

  it('never matches the legal name', async () => {
    expect(await names('Private Limited')).toEqual([]);
  });

  it('refuses an over-long search', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers?q=${'x'.repeat(121)}` });
    expect(response.statusCode).toBe(400);
  });
});

describe('category page: market notes and suppliers (Master row 3)', () => {
  interface Note {
    effect: string;
    reason: string;
    requiredDocuments: string[];
    categoryName: string;
  }

  async function notes(slug: string, country?: string): Promise<Note[]> {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/catalog/categories/${slug}${country === undefined ? '' : `?country=${country}`}`,
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<{ marketNotes: Note[] }>().marketNotes;
  }

  beforeAll(async () => {
    await prisma.marketRule.create({
      data: {
        id: newId(),
        scope: 'CATEGORY',
        categoryId: otherId,
        countryCode: BLOCKED_IN,
        effect: 'DOCUMENTS_REQUIRED',
        reason: `${PREFIX}An import licence is needed.`,
        requiredDocumentsJson: ['Import licence', 42],
        source: 'test',
        version: '1',
        ownerName: 'Compliance',
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
    });
  });

  it('tells a shopper there why a blocked shelf is empty - on the child of a blocked category too', async () => {
    const child = await notes(`${PREFIX}child`, BLOCKED_IN);
    expect(child).toEqual([
      { effect: 'BLOCK', reason: `${PREFIX}test rule`, requiredDocuments: [], labelText: null, categoryName: 'Market root', minOrderValueMinor: null, thresholdCurrency: null },
    ]);
  });

  it('lists the documents a buyer must hold, dropping anything that is not a name', async () => {
    expect(await notes(`${PREFIX}other`, BLOCKED_IN)).toEqual([
      {
        effect: 'DOCUMENTS_REQUIRED',
        reason: `${PREFIX}An import licence is needed.`,
        requiredDocuments: ['Import licence'],
        labelText: null,
        categoryName: 'Market other',
        minOrderValueMinor: null,
        thresholdCurrency: null,
      },
    ]);
  });

  it('says nothing without a destination, or for a destination with no rule', async () => {
    expect(await notes(`${PREFIX}child`)).toEqual([]);
    expect(await notes(`${PREFIX}child`, ELSEWHERE)).toEqual([]);
  });

  it('counts only suppliers selling something filed under the category', async () => {
    const inOther = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers?category=${PREFIX}other&limit=24` });
    const names = inOther.json<{ suppliers: { displayName: string }[] }>().suppliers.map((row) => row.displayName);
    // Both test suppliers offer MKT-OPEN, which is filed under "other".
    expect(names).toEqual(expect.arrayContaining(['Acme Precision Castings', 'Bharat Textiles']));

    const inRoot = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers?category=${PREFIX}root&limit=24` });
    const rootNames = inRoot.json<{ suppliers: { displayName: string }[] }>().suppliers.map((row) => row.displayName);
    expect(rootNames).not.toContain('Acme Precision Castings');
  });

  it('answers no suppliers for an unknown category, not every supplier', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers?category=${PREFIX}nope` });
    expect(response.json()).toEqual({ suppliers: [], countries: [], total: 0 });
  });
});
