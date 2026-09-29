/**
 * The product page's sourcing facts - checklist Master row 4.
 *
 * `GET /catalog/products/:slug` carries `sourcing`: who sells it, whether it
 * can be delivered to the destination, lead time, origin, and whether an
 * inspection applies before dispatch. The claims:
 *
 *   - **The seller is the one the basket binds**, and only an approved one.
 *     A product with no seller offer is the marketplace's own (seller null).
 *   - **Delivery**: no destination asks for one; a BLOCK rule on a parent
 *     category blocks; a seller's own region list excludes other countries;
 *     DOCUMENTS_REQUIRED informs; otherwise available.
 *   - **Inspection**, from the operator's rules: required on every order,
 *     required from a value, required for this supplier's risk, not required, or not
 *     applicable to the marketplace's own stock.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';

const PREFIX = 'pdp-src-';
const BLOCKED = 'KI';
const DOCS = 'TV';
const OPEN = 'NR';
const MANDATORY_DEST = 'PW';
const VALUE_DEST = 'MH';
const RISK_DEST = 'FM';

let app: Awaited<ReturnType<typeof buildApp>>;
let currency = '';
let taxClassId = '';
let parent = { id: '', path: '/' };
let child = { id: '', path: '/' };
let sellerId = '';

interface Sourcing {
  seller: { slug: string; displayName: string; kind: string; registrationCountry: string; verifiedAt: string | null } | null;
  destination: string | null;
  delivery: { status: string; notes: { effect: string; reason: string; requiredDocuments: string[] }[] };
  handlingTimeDays: number | null;
  countryOfOrigin: string | null;
  inspection: { outlook: string; fromValueMinor: string | null; currency: string | null };
}

async function sourcing(slug: string, country?: string): Promise<Sourcing> {
  const response = await app.inject({
    method: 'GET',
    url: `/api/v1/catalog/products/${PREFIX}${slug}${country === undefined ? '' : `?country=${country}`}`,
  });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ sourcing: Sourcing }>().sourcing;
}

async function product(slug: string, categoryId: string, isMarketplaceProduct = true): Promise<string> {
  const id = newId();
  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `PDP sourcing ${slug}`,
      slug: `${PREFIX}${slug}`,
      sku: `${PREFIX}${slug}`.toUpperCase(),
      basePriceMinor: 1000n,
      currency,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
      // Sold through sellers' offers, which is what makes the page bind one.
      isMarketplaceProduct,
    },
  });
  await prisma.productPrice.create({
    data: { id: newId(), productId: id, currencyCode: currency, variantKey: '', basePriceMinor: 1000n },
  });
  return id;
}

async function offer(productId: string, extra: { sellingRegionsJson?: string[]; handlingTimeDays?: number; countryOfOrigin?: string; variantKey?: string } = {}): Promise<void> {
  await prisma.sellerOffer.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      productId,
      variantKey: extra.variantKey ?? '',
      sellerSku: `${productId.slice(-8)}${extra.variantKey ?? ''}`,
      status: 'ACTIVE',
      priceMinor: 900n,
      currency,
      ...(extra.sellingRegionsJson === undefined ? {} : { sellingRegionsJson: extra.sellingRegionsJson }),
      ...(extra.handlingTimeDays === undefined ? {} : { handlingTimeDays: extra.handlingTimeDays }),
      ...(extra.countryOfOrigin === undefined ? {} : { countryOfOrigin: extra.countryOfOrigin }),
    },
  });
}

async function inspectionRule(input: {
  level: 'MANDATORY' | 'RISK_TRIGGERED';
  destination: string;
  minOrderValueMinor?: bigint;
  supplierRiskAtLeast?: 'HIGH';
}): Promise<void> {
  await prisma.inspectionRule.create({
    data: {
      id: newId(),
      name: `${PREFIX}${input.level}-${input.destination}`,
      level: input.level,
      categoryId: parent.id,
      destinationCountriesJson: [input.destination],
      minOrderValueMinor: input.minOrderValueMinor ?? null,
      currency: input.minOrderValueMinor === undefined ? null : currency,
      supplierRiskAtLeast: input.supplierRiskAtLeast ?? null,
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
}

async function cleanUp(): Promise<void> {
  await prisma.inspectionRule.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await prisma.inspectionSupplierRisk.deleteMany({ where: { reason: 'test', sellerAccountId: { in: (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })).map((row) => row.id) } } });
  await prisma.marketRule.deleteMany({ where: { reason: { startsWith: PREFIX } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { startsWith: PREFIX } } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.productPrice.deleteMany({ where: { product: { slug: { startsWith: PREFIX } } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}child` } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.taxClass.deleteMany({ where: { code: 'PDPSRC' } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  currency = await getBaseCurrency();
  taxClassId = newId();
  await prisma.taxClass.create({ data: { id: taxClassId, code: 'PDPSRC', name: 'PDP', ratePercent: '18' } });

  parent = { id: newId(), path: '/' };
  await prisma.category.create({ data: { id: parent.id, name: 'PDP parent', slug: `${PREFIX}parent`, isActive: true, path: '/' } });
  child = { id: newId(), path: `/${parent.id}/` };
  await prisma.category.create({
    data: { id: child.id, name: 'PDP child', slug: `${PREFIX}child`, isActive: true, parentId: parent.id, path: child.path },
  });

  sellerId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerId,
      legalName: 'PDP Castings Private Limited',
      displayName: 'PDP Castings',
      displayNameNormalized: 'pdp castings',
      slug: `${PREFIX}castings`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
      approvedAt: new Date('2026-03-01'),
    },
  });

  const sold = await product('sold', child.id);
  await offer(sold, { handlingTimeDays: 12, countryOfOrigin: 'IN' });
  const regional = await product('regional', child.id);
  await offer(regional, { sellingRegionsJson: ['IN', OPEN] });
  await product('own-stock', child.id, false);
  // Sold only in sizes: no base-product offer at all.
  const sized = await product('sized', child.id);
  await offer(sized, { variantKey: 'SIZE-M', handlingTimeDays: 3 });

  for (const [country, effect] of [
    [BLOCKED, 'BLOCK'],
    [DOCS, 'DOCUMENTS_REQUIRED'],
  ] as const) {
    await prisma.marketRule.create({
      data: {
        id: newId(),
        scope: 'CATEGORY',
        categoryId: parent.id,
        countryCode: country,
        effect,
        reason: `${PREFIX}${effect}`,
        requiredDocumentsJson: effect === 'DOCUMENTS_REQUIRED' ? ['Import permit'] : undefined,
        source: 'test',
        version: '1',
        ownerName: 'Compliance',
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
    });
  }

  await inspectionRule({ level: 'MANDATORY', destination: MANDATORY_DEST });
  await inspectionRule({ level: 'MANDATORY', destination: VALUE_DEST, minOrderValueMinor: 5_000_000n });
  await inspectionRule({ level: 'RISK_TRIGGERED', destination: RISK_DEST, supplierRiskAtLeast: 'HIGH' });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('product page sourcing', () => {
  it('names the approved seller whose offer the basket binds, with lead time and origin', async () => {
    const result = await sourcing('sold', OPEN);
    expect(result.seller).toEqual({
      slug: `${PREFIX}castings`,
      displayName: 'PDP Castings',
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      verifiedAt: '2026-03-01T00:00:00.000Z',
    });
    expect(result.handlingTimeDays).toBe(12);
    expect(result.countryOfOrigin).toBe('IN');
  });

  it('never exposes the seller legal name', async () => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/products/${PREFIX}sold` });
    expect(response.body).not.toContain('Private Limited');
  });

  it('names the seller of a product sold only in sizes, never "own stock"', async () => {
    const result = await sourcing('sized', OPEN);
    expect(result.seller?.displayName).toBe('PDP Castings');
    expect(result.handlingTimeDays).toBe(3);
  });

  it('treats a product with no seller offer as the marketplace’s own', async () => {
    const result = await sourcing('own-stock', OPEN);
    expect(result.seller).toBeNull();
    expect(result.inspection.outlook).toBe('NOT_APPLICABLE');
  });

  it('asks for a destination instead of guessing one', async () => {
    const result = await sourcing('sold');
    expect(result.destination).toBeNull();
    expect(result.delivery.status).toBe('CHOOSE_DESTINATION');
  });

  it('blocks delivery under a rule on a parent category, giving the reason', async () => {
    const result = await sourcing('sold', BLOCKED);
    expect(result.delivery.status).toBe('BLOCKED');
    expect(result.delivery.notes).toEqual([{ effect: 'BLOCK', reason: `${PREFIX}BLOCK`, requiredDocuments: [] }]);
  });

  it('lists the documents a buyer there must hold', async () => {
    const result = await sourcing('sold', DOCS);
    expect(result.delivery.status).toBe('DOCUMENTS_REQUIRED');
    expect(result.delivery.notes[0]?.requiredDocuments).toEqual(['Import permit']);
  });

  it('respects the countries a seller says they sell to', async () => {
    expect((await sourcing('regional', OPEN)).delivery.status).toBe('AVAILABLE');
    expect((await sourcing('regional', MANDATORY_DEST)).delivery.status).toBe('SELLER_DOES_NOT_DELIVER');
    // An empty region list means everywhere.
    expect((await sourcing('sold', MANDATORY_DEST)).delivery.status).toBe('AVAILABLE');
  });

  it('reports inspection the way the dispatch gate would decide it', async () => {
    expect((await sourcing('sold', MANDATORY_DEST)).inspection).toEqual({
      outlook: 'REQUIRED',
      fromValueMinor: null,
      currency: null,
    });
    expect((await sourcing('sold', VALUE_DEST)).inspection).toEqual({
      outlook: 'REQUIRED_FROM_VALUE',
      fromValueMinor: '5000000',
      currency,
    });
    // The risk rule needs a HIGH-risk supplier: not required while they are
    // rated low, required once the operator rates them high.
    expect((await sourcing('sold', RISK_DEST)).inspection.outlook).toBe('NOT_REQUIRED');
    await prisma.inspectionSupplierRisk.create({ data: { sellerAccountId: sellerId, tier: 'HIGH', reason: 'test' } });
    try {
      expect((await sourcing('sold', RISK_DEST)).inspection.outlook).toBe('REQUIRED');
    } finally {
      await prisma.inspectionSupplierRisk.deleteMany({ where: { sellerAccountId: sellerId } });
    }
    expect((await sourcing('sold', OPEN)).inspection.outlook).toBe('NOT_REQUIRED');
    // No country chosen, and rules exist for some countries: it depends.
    expect((await sourcing('sold')).inspection.outlook).toBe('DEPENDS_ON_DESTINATION');
  });

  it('drops a seller who is suspended, and with them the inspection outlook', async () => {
    await prisma.sellerAccount.update({ where: { id: sellerId }, data: { status: 'SUSPENDED', suspendedAt: new Date() } });
    try {
      const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/products/${PREFIX}sold?country=${OPEN}` });
      // The page may still exist for the marketplace's other offers, or be
      // gone; either way a suspended seller is never named on it.
      if (response.statusCode === 200) {
        expect(response.json<{ sourcing: Sourcing }>().sourcing.seller).toBeNull();
      } else {
        expect(response.statusCode).toBe(404);
      }
    } finally {
      await prisma.sellerAccount.update({ where: { id: sellerId }, data: { status: 'APPROVED', suspendedAt: null } });
    }
  });
});
