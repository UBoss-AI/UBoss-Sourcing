/**
 * A verified supplier's public page - checklist Master row 5.
 *
 *   - **Only a listed supplier has a page**; anyone else is a plain 404.
 *   - **Only verified, unexpired certifications are shown.**
 *   - **Factories are published by city, never by street address.**
 *   - **Nothing private leaks**: legal name, registration and tax numbers,
 *     contact people, internal notes.
 *   - **A website is linked only if it is http(s).**
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';

const PREFIX = 'sup-prof-';

let app: Awaited<ReturnType<typeof buildApp>>;
let currency = '';
let taxClassId = '';
let categoryId = '';
let sellerId = '';

async function seller(slug: string, status: 'APPROVED' | 'SUBMITTED' | 'SUSPENDED', extra: Record<string, unknown> = {}): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${slug} Industries Private Limited`,
      displayName: `Supplier ${slug}`,
      displayNameNormalized: `supplier ${slug}`,
      slug: `${PREFIX}${slug}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status,
      approvedAt: new Date('2026-02-01'),
      internalNotes: 'INTERNAL-NOTE-DO-NOT-PUBLISH',
      description: 'We make precision castings.',
      ...(status === 'SUSPENDED' ? { suspendedAt: new Date() } : {}),
      ...extra,
    },
  });
  return id;
}

async function product(sku: string): Promise<string> {
  const id = newId();
  await prisma.product.create({
    data: {
      id,
      categoryId,
      taxClassId,
      name: `Supplier profile ${sku}`,
      slug: `${PREFIX}${sku.toLowerCase()}`,
      sku: `${PREFIX}${sku}`.toUpperCase(),
      basePriceMinor: 1000n,
      currency,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
    },
  });
  return id;
}

async function offer(sellerAccountId: string, productId: string, key: string): Promise<void> {
  await prisma.sellerOffer.create({
    data: { id: newId(), sellerAccountId, productId, variantKey: key, sellerSku: key, status: 'ACTIVE', priceMinor: 900n, currency },
  });
}

async function cleanUp(): Promise<void> {
  const ids = (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })).map((row) => row.id);
  await prisma.sellerCertification.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerFactory.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerTrustProfile.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: ids } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: ids } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}castings` } });
  await prisma.taxClass.deleteMany({ where: { code: 'SUPPROF' } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  currency = await getBaseCurrency();
  taxClassId = newId();
  await prisma.taxClass.create({ data: { id: taxClassId, code: 'SUPPROF', name: 'Profile', ratePercent: '18' } });
  categoryId = newId();
  await prisma.category.create({ data: { id: categoryId, name: 'Castings', slug: `${PREFIX}castings`, isActive: true } });

  sellerId = await seller('acme', 'APPROVED');
  const valve = await product('VALVE');
  const flange = await product('FLANGE');
  await offer(sellerId, valve, 'V-S');
  await offer(sellerId, valve, 'V-M');
  await offer(sellerId, flange, 'F');

  await prisma.sellerBusinessProfile.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      websiteUrl: 'https://acme.example.com',
      yearsInBusiness: 18,
      companyRegistrationNumber: 'U12345MH2008PTC000000',
      taxRegistrationNumber: '27AAACA1234A1Z5',
      representativeName: 'Private Person',
      representativeEmail: 'private.person@example.com',
    },
  });
  await prisma.sellerTrustProfile.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      exportCapable: true,
      exportMarketsJson: ['DE', 'US', 42],
      yearsExporting: 7,
      responseSlaHours: 24,
      capabilitiesJson: ['CNC machining', 'Investment casting'],
      udyamNumber: 'UDYAM-MH-00-0000000',
      iecNumber: '0000000000',
    },
  });
  const factoryId = newId();
  await prisma.sellerFactory.create({
    data: {
      id: factoryId,
      sellerAccountId: sellerId,
      name: 'Pune plant',
      addressLine1: '12 SECRET STREET',
      city: 'Pune',
      region: 'Maharashtra',
      postcode: '411001',
      countryCode: 'IN',
      latitude: '18.5204303',
      longitude: '73.8567437',
      establishedYear: 2008,
      workforceCount: 140,
      monthlyCapacity: 50000,
      capacityUnit: 'pieces',
      productsMade: 'Valves and flanges',
    },
  });
  await prisma.sellerFactory.create({
    data: { id: newId(), sellerAccountId: sellerId, name: 'Closed plant', addressLine1: 'x', city: 'Nashik', postcode: '1', countryCode: 'IN', archivedAt: new Date() },
  });

  const cert = (standard: string, state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED', expiresOn: Date | null) =>
    prisma.sellerCertification.create({
      data: {
        id: newId(),
        sellerAccountId: sellerId,
        factoryId,
        standard,
        issuer: 'TÜV',
        certificateNumber: `${standard}-1`,
        state,
        issuedOn: new Date('2025-01-01'),
        expiresOn,
        verifiedAt: state === 'VERIFIED' ? new Date('2026-01-15') : null,
      },
    });
  await cert('ISO 9001', 'VERIFIED', new Date('2099-01-01'));
  await cert('ISO 14001', 'VERIFIED', null);
  await cert('CE', 'PENDING', null);
  await cert('ISO 13485', 'REJECTED', null);
  await cert('ISO 45001', 'EXPIRED', null);
  await cert('ISO 27001', 'VERIFIED', new Date('2020-01-01'));

  const pending = await seller('pending', 'SUBMITTED');
  await offer(pending, flange, 'P');
  const suspended = await seller('suspended', 'SUSPENDED');
  await offer(suspended, flange, 'S');
  await seller('nothing-to-sell', 'APPROVED');
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

async function profile(slug: string) {
  return app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers/${PREFIX}${slug}` });
}

describe('GET /api/v1/catalog/suppliers/:slug', () => {
  it('publishes the company, what it sells and its stated capabilities', async () => {
    const response = await profile('acme');
    expect(response.statusCode, response.body).toBe(200);
    const { supplier } = response.json<{ supplier: Record<string, unknown> }>();
    expect(supplier).toMatchObject({
      slug: `${PREFIX}acme`,
      displayName: 'Supplier acme',
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      verifiedAt: '2026-02-01T00:00:00.000Z',
      description: 'We make precision castings.',
      websiteUrl: 'https://acme.example.com/',
      yearsInBusiness: 18,
      productCount: 2,
      categories: [{ slug: `${PREFIX}castings`, name: 'Castings', productCount: 2 }],
      exportCapable: true,
      exportMarkets: ['DE', 'US'],
      yearsExporting: 7,
      responseSlaHours: 24,
      capabilities: ['CNC machining', 'Investment casting'],
    });
  });

  it('shows only certifications the operator verified and that are still in date', async () => {
    const { supplier } = (await profile('acme')).json<{ supplier: { certifications: { standard: string }[] } }>();
    expect(supplier.certifications.map((row) => row.standard)).toEqual(['ISO 14001', 'ISO 9001']);
  });

  it('publishes a factory by city, never by street, postcode or coordinates, and skips a closed one', async () => {
    const response = await profile('acme');
    const { supplier } = response.json<{ supplier: { factories: Record<string, unknown>[] } }>();
    expect(supplier.factories).toEqual([
      {
        name: 'Pune plant',
        city: 'Pune',
        region: 'Maharashtra',
        countryCode: 'IN',
        establishedYear: 2008,
        workforceCount: 140,
        monthlyCapacity: 50000,
        capacityUnit: 'pieces',
        productsMade: 'Valves and flanges',
      },
    ]);
    for (const secret of ['SECRET STREET', '411001', '18.52', '73.85']) expect(response.body).not.toContain(secret);
  });

  it('never publishes the legal name, identifiers, contacts or notes', async () => {
    const body = (await profile('acme')).body;
    for (const secret of [
      'Private Limited',
      'U12345MH2008PTC000000',
      '27AAACA1234A1Z5',
      'Private Person',
      'private.person@example.com',
      'INTERNAL-NOTE',
      'UDYAM',
      '0000000000',
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it('is a plain 404 for anyone who is not a listed supplier', async () => {
    for (const slug of ['pending', 'suspended', 'nothing-to-sell', 'nobody']) {
      const response = await profile(slug);
      expect(response.statusCode, slug).toBe(404);
    }
  });

  it('refuses a malformed slug', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/catalog/suppliers/%3Cscript%3E' });
    expect(response.statusCode).toBe(400);
  });

  it('drops a website that is not http(s)', async () => {
    await prisma.sellerBusinessProfile.update({ where: { sellerAccountId: sellerId }, data: { websiteUrl: 'javascript:alert(1)' } });
    try {
      const { supplier } = (await profile('acme')).json<{ supplier: { websiteUrl: string | null } }>();
      expect(supplier.websiteUrl).toBeNull();
    } finally {
      await prisma.sellerBusinessProfile.update({ where: { sellerAccountId: sellerId }, data: { websiteUrl: 'https://acme.example.com' } });
    }
  });
});
