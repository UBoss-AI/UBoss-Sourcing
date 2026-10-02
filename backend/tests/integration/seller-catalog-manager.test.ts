/**
 * Seller Hub catalogue manager (JOURNEY-028).
 *
 *   - capacity: units per week and the lead time, saved on the listing with
 *     the sourcing terms, and a lead time without a weekly figure refused;
 *   - market eligibility: every country rule touching the product, on the
 *     product or on a category above it, with its reason;
 *   - change history: the activity log narrowed to one listing;
 *   - clone: a copy is a new listing draft with the terms filled in, under a
 *     new code, never a second offer on the same product.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../src/infra/prisma.js';
import { buildApp } from '../../src/http/app.js';
import { as, buildRfqWorld, cleanRfqWorld, errorCode, type RfqWorld } from '../support/rfq-fixture.js';

const PREFIX = 'catm-';
let world: RfqWorld;

async function offerOf(sellerAccountId: string): Promise<{ id: string; sellerSku: string; productId: string }> {
  return prisma.sellerOffer.findFirstOrThrow({
    where: { sellerAccountId },
    select: { id: true, sellerSku: true, productId: true },
  });
}

const SOURCING = {
  sampleAvailable: false,
  sampleNote: null,
  privateLabelAvailable: false,
  oemAvailable: false,
  leadTimeDaysMin: null,
  leadTimeDaysMax: null,
  incoterms: [],
  certificationIds: [],
};

beforeAll(async () => {
  const app = await buildApp();
  await app.ready();
  world = await buildRfqWorld(app, PREFIX);
});

afterAll(async () => {
  const sellers = Object.values(world.sellers).map((seller) => seller.id);
  await prisma.sellerListingDraft.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerListingTrust.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await cleanRfqWorld(PREFIX);
  await world.app.close();
});

describe('capacity on a listing', () => {
  it('saves units per week and the lead time, and refuses a lead time on its own', async () => {
    const seller = world.sellers.alpha;
    const offer = await offerOf(seller.id);

    const lonely = await as(world, seller.owner, 'PUT', `/seller/listings/${offer.id}/sourcing`, {
      ...SOURCING,
      capacityUnitsPerWeek: null,
      capacityLeadTimeDays: 10,
    });
    expect(lonely.statusCode).toBe(400);
    expect(errorCode(lonely)).toBe('VALIDATION_FAILED');

    const saved = await as(world, seller.owner, 'PUT', `/seller/listings/${offer.id}/sourcing`, {
      ...SOURCING,
      capacityUnitsPerWeek: 2_500,
      capacityLeadTimeDays: 10,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json<{ terms: { capacity: unknown } }>().terms.capacity).toEqual({
      capacityUnitsPerWeek: 2_500,
      capacityLeadTimeDays: 10,
    });

    const read = await as(world, seller.owner, 'GET', `/seller/listings/${offer.id}/sourcing`);
    expect(read.json<{ capacity: unknown }>().capacity).toEqual({ capacityUnitsPerWeek: 2_500, capacityLeadTimeDays: 10 });

    // Left out, the stored figures are kept.
    await as(world, seller.owner, 'PUT', `/seller/listings/${offer.id}/sourcing`, SOURCING);
    const stored = await prisma.sellerOffer.findUniqueOrThrow({
      where: { id: offer.id },
      select: { capacityUnitsPerWeek: true, capacityLeadTimeDays: true },
    });
    expect(stored).toEqual({ capacityUnitsPerWeek: 2_500, capacityLeadTimeDays: 10 });
  });
});

describe('market eligibility of a listing', () => {
  it('lists every rule touching the product with its reason, and blocks by country', async () => {
    const seller = world.sellers.delta;
    const offer = await offerOf(seller.id);
    const response = await as(world, seller.owner, 'GET', `/seller/listings/${offer.id}/market-eligibility`);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{
      rules: { countryCode: string; scope: string; effect: string; reason: string }[];
      blockedCountries: string[];
      complianceHolds: unknown[];
    }>();
    // A product rule for DE and a category rule for BR, from the fixture.
    expect(body.blockedCountries).toEqual(['BR', 'DE']);
    expect(body.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ countryCode: 'DE', scope: 'PRODUCT', effect: 'BLOCK' }),
        expect.objectContaining({ countryCode: 'BR', scope: 'CATEGORY', effect: 'BLOCK' }),
      ]),
    );
    expect(body.rules.every((rule) => rule.reason.length > 0)).toBe(true);
    expect(body.complianceHolds).toEqual([]);
  });

  it('is not found for another seller\'s listing', async () => {
    const offer = await offerOf(world.sellers.delta.id);
    const response = await as(world, world.sellers.gamma.owner, 'GET', `/seller/listings/${offer.id}/market-eligibility`);
    expect(response.statusCode).toBe(404);
  });
});

describe('clone', () => {
  it('copies a listing into a new draft under a new code, terms filled in, stock not', async () => {
    const seller = world.sellers.alpha;
    const offer = await offerOf(seller.id);
    const offersBefore = await prisma.sellerOffer.count({ where: { sellerAccountId: seller.id } });

    const response = await as(world, seller.owner, 'POST', `/seller/listings/${offer.id}/duplicate`, {
      sellerSku: `${offer.sellerSku}-COPY`,
    });
    expect(response.statusCode, response.body).toBe(201);
    const { draftId } = response.json<{ draftId: string }>();

    const draft = await prisma.sellerListingDraft.findUniqueOrThrow({
      where: { id: draftId },
      select: { sellerAccountId: true, status: true, sellerSku: true, categoryId: true, offerJson: true, stockJson: true },
    });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: offer.productId }, select: { categoryId: true } });
    expect(draft).toMatchObject({
      sellerAccountId: seller.id,
      status: 'DRAFT',
      sellerSku: `${offer.sellerSku}-COPY`,
      categoryId: product.categoryId,
      stockJson: [],
    });
    const source = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offer.id }, select: { priceMinor: true, currency: true } });
    expect(draft.offerJson).toMatchObject({ priceMinor: source.priceMinor.toString(), currency: source.currency });
    // No second offer on the same product: the copy becomes a product of its own on approval.
    expect(await prisma.sellerOffer.count({ where: { sellerAccountId: seller.id } })).toBe(offersBefore);

    // The same code again is refused, against the draft as well as live listings.
    const again = await as(world, seller.owner, 'POST', `/seller/listings/${offer.id}/duplicate`, {
      sellerSku: `${offer.sellerSku}-COPY`,
    });
    expect(again.statusCode).toBe(409);
    expect(errorCode(again)).toBe('SELLER_SKU_ALREADY_EXISTS');
  });

  it('refuses another seller\'s listing', async () => {
    const offer = await offerOf(world.sellers.alpha.id);
    const response = await as(world, world.sellers.gamma.owner, 'POST', `/seller/listings/${offer.id}/duplicate`, {
      sellerSku: 'STOLEN-1',
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('change history of a listing', () => {
  it('narrows the activity log to one listing', async () => {
    const seller = world.sellers.alpha;
    const offer = await offerOf(seller.id);
    const response = await as(world, seller.owner, 'GET', `/seller/audit?resourceId=${offer.id}`);
    expect(response.statusCode, response.body).toBe(200);
    const entries = response.json<{ entries: { resourceId: string | null; action: string }[] }>().entries;
    // The capacity save and the clone above both wrote one.
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((entry) => entry.resourceId === offer.id)).toBe(true);
    expect(entries.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['seller.listing.sourcing_updated', 'seller.offer.duplicated']),
    );
  });
});
