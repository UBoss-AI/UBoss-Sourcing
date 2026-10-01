/**
 * Sourcing terms on a listing (JOURNEY-002, JOURNEY-004, JOURNEY-029).
 *
 * A seller sets samples, lead time, OEM / private label, Incoterms and links
 * their own verified, in-date certificates on their own listing only; the
 * product page shows the terms of the seller it is priced from; and the
 * catalogue's B2B filters narrow on exactly those terms.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { as, buildRfqWorld, cleanRfqWorld, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'lsrc8-';
let world: RfqWorld;
let alphaOffer = '';
let betaOffer = '';
let verifiedCert = '';
let pendingCert = '';

const TERMS = {
  sampleAvailable: true,
  sampleNote: 'Two boxes, courier paid by buyer',
  privateLabelAvailable: true,
  oemAvailable: false,
  leadTimeDaysMin: 15,
  leadTimeDaysMax: 25,
  incoterms: ['FOB', 'CIF', 'FOB'],
  certificationIds: [] as string[],
};

async function cert(sellerAccountId: string, state: 'VERIFIED' | 'PENDING'): Promise<string> {
  const id = newId();
  await prisma.sellerCertification.create({
    data: { id, sellerAccountId, standard: state === 'VERIFIED' ? 'ISO 13485' : 'ISO 9001', issuer: 'TUV', state, expiresOn: new Date(Date.now() + 365 * 86_400_000) },
  });
  return id;
}

async function list(query: string): Promise<string[]> {
  const response = await world.app.inject({ method: 'GET', url: `/api/v1/catalog/products?category=${PREFIX}gloves&currency=INR&${query}` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ products: { slug: string }[] }>().products.map((item) => item.slug);
}

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  await cleanRfqWorld(PREFIX);
  world = await buildRfqWorld(app, PREFIX);
  const offers = await prisma.sellerOffer.findMany({ where: { product: { slug: `${PREFIX}gloves-a` } }, select: { id: true, sellerAccountId: true } });
  alphaOffer = offers.find((row) => row.sellerAccountId === world.sellers.alpha.id)?.id ?? '';
  betaOffer = offers.find((row) => row.sellerAccountId === world.sellers.beta.id)?.id ?? '';
  // The fixture prices nothing; the catalogue lists a product only with a price row.
  const glovesA = await prisma.product.findUniqueOrThrow({ where: { slug: `${PREFIX}gloves-a` }, select: { id: true } });
  await prisma.productPrice.create({ data: { id: newId(), productId: glovesA.id, currencyCode: 'INR', variantKey: '', basePriceMinor: 10_000n } });
  verifiedCert = await cert(world.sellers.alpha.id, 'VERIFIED');
  pendingCert = await cert(world.sellers.alpha.id, 'PENDING');
}, 240_000);

afterAll(async () => {
  await prisma.sellerCertification.deleteMany({ where: { id: { in: [verifiedCert, pendingCert] } } });
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('a seller sets sourcing terms on their own listing', () => {
  it('validates, saves, de-duplicates Incoterms and audits', async () => {
    const url = `/seller/listings/${alphaOffer}/sourcing`;
    const bad = await as(world, world.sellers.alpha.owner, 'PUT', url, { ...TERMS, leadTimeDaysMin: 30 });
    expect(bad.statusCode).toBe(400);
    const unverified = await as(world, world.sellers.alpha.owner, 'PUT', url, { ...TERMS, certificationIds: [pendingCert] });
    expect(unverified.statusCode).toBe(400);
    const saved = await as(world, world.sellers.alpha.owner, 'PUT', url, { ...TERMS, certificationIds: [verifiedCert] });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<{ terms: { incoterms: string[]; certifications: { standard: string }[] } }>().terms).toMatchObject({
      incoterms: ['CIF', 'FOB'],
      certifications: [{ standard: 'ISO 13485' }],
    });
    const read = await as(world, world.sellers.alpha.owner, 'GET', url);
    expect(read.json<{ linkableCertifications: { id: string }[] }>().linkableCertifications.map((row) => row.id)).toEqual([verifiedCert]);
    expect(await prisma.sellerAuditLog.count({ where: { action: 'seller.listing.sourcing_updated', resourceId: alphaOffer } })).toBe(1);
  });

  it("refuses another seller's listing", async () => {
    const url = `/seller/listings/${alphaOffer}/sourcing`;
    expect([403, 404]).toContain((await as(world, world.sellers.beta.owner, 'PUT', url, TERMS)).statusCode);
    expect([403, 404]).toContain((await as(world, world.sellers.beta.owner, 'GET', url)).statusCode);
    expect((await as(world, world.sellers.beta.owner, 'GET', `/seller/listings/${betaOffer}/sourcing`)).json<{ terms: unknown }>().terms).toBeNull();
  });
});

describe('the product page and the catalogue', () => {
  it('shows the priced seller’s terms on the product page, never an unverified certificate', async () => {
    const response = await world.app.inject({ method: 'GET', url: `/api/v1/catalog/products/${PREFIX}gloves-a` });
    expect(response.statusCode, response.body).toBe(200);
    const sourcing = response.json<{ sourcing: { seller: { slug: string } | null; terms: { sampleAvailable: boolean; certifications: { standard: string }[] } | null } }>().sourcing;
    if (sourcing.seller?.slug === `${PREFIX}alpha`) {
      expect(sourcing.terms).toMatchObject({ sampleAvailable: true, certifications: [{ standard: 'ISO 13485' }] });
    } else {
      // Priced from BETA, who stated no terms.
      expect(sourcing.terms).toBeNull();
    }
    expect(response.body).not.toContain('ISO 9001');
  });

  it('filters on samples, Incoterm, lead time, certification, MOQ, origin and verified supplier', async () => {
    const glovesA = `${PREFIX}gloves-a`;
    expect(await list('inStock=false')).toContain(glovesA);
    expect(await list('sample=true')).toContain(glovesA);
    expect(await list('incoterm=CIF')).toContain(glovesA);
    expect(await list('incoterm=DDP')).not.toContain(glovesA);
    expect(await list('maxLeadTimeDays=25')).toContain(glovesA);
    expect(await list('maxLeadTimeDays=10')).not.toContain(glovesA);
    expect(await list('certified=true')).toContain(glovesA);
    expect(await list('verifiedSupplier=true')).toContain(glovesA);
    await prisma.sellerOffer.update({ where: { id: alphaOffer }, data: { minimumOrderQuantity: 50, countryOfOrigin: 'IN' } });
    await prisma.sellerOffer.update({ where: { id: betaOffer }, data: { minimumOrderQuantity: 500 } });
    expect(await list('maxMoq=100')).toContain(glovesA);
    expect(await list('maxMoq=10')).not.toContain(glovesA);
    expect(await list('origin=IN')).toContain(glovesA);
    expect(await list('origin=CN')).not.toContain(glovesA);
    expect((await world.app.inject({ method: 'GET', url: '/api/v1/catalog/products?incoterm=XYZ' })).statusCode).toBe(400);
  });
});
