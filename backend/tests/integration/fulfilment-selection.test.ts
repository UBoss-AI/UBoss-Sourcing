/**
 * Which of a seller's methods actually carried the parcel, recorded on it.
 *
 * The domain rules are unit-tested without a database in
 * `tests/unit/seller-fulfilment.test.ts`. What this file tests is the part
 * that only exists against real rows: that the answer is LOADED from the
 * seller's configuration, WRITTEN onto the consignment, and then left alone
 * when the configuration changes.
 *
 * THE ONE THAT MATTERS MOST is the last of those. A seller switches carrier in
 * March; every consignment they sent in February has to go on saying what
 * actually happened. A system that recomputed it would tell a customer
 * disputing a February delivery something false, with complete confidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  chooseFulfilmentMethod,
  setMethodRole,
  upsertFulfilmentRule,
  type SellerActor,
} from '../../src/modules/seller/fulfilment-method.service.js';
import { chooseMethodForConsignment } from '../../src/modules/seller/fulfilment-selection.service.js';

const SLUG = 'selection-co';
const PARTNER_CODE = 'LP-TEST-SELECTION';

let sellerId = '';
let locationId = '';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Selection Co' };

const NEEDS = {
  originCountry: 'IN',
  destinationCountry: 'IN',
  requiredCapabilities: [] as string[],
  weightGrams: 1500,
};

async function cleanUp(): Promise<void> {
  await prisma.sellerFulfilmentRule.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerFulfilmentMethod.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.logisticsServiceRegion.deleteMany({
    where: { partner: { partnerCode: PARTNER_CODE } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { partnerCode: PARTNER_CODE } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
}

beforeAll(async () => {
  await cleanUp();

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Selection Co Ltd',
      displayName: 'Selection Co',
      displayNameNormalized: 'selection co',
      slug: SLUG,
      kind: 'RESELLER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  sellerId = seller.id;

  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId: sellerId,
      code: 'SEL-1',
      name: 'Delhi depot',
      addressLine1: '1 Depot Road',
      city: 'Delhi',
      postcode: '110001',
      countryCode: 'IN',
    },
  });

  locationId = location.id;
});

afterAll(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('a seller with nothing set up', () => {
  it('is parked for a person rather than refused', async () => {
    // A paid order sitting nowhere because its seller had not finished a
    // settings screen is worse than one waiting visibly for somebody.
    const outcome = await chooseMethodForConsignment({
      sellerAccountId: sellerId,
      sellerOfferIds: [],
      sellerLocationId: locationId,
      destinationPostalCode: '110001',
      needs: NEEDS,
    });

    expect(outcome.source).toBe('MANUAL_REVIEW');
    expect(outcome.fulfilmentMethodId).toBeNull();
    expect(outcome.reason).toContain('not set up any way of delivering');
  });
});

describe('a seller with one approved method', () => {
  let operatorMethodId = '';

  beforeAll(async () => {
    const method = await chooseFulfilmentMethod({
      sellerAccountId: sellerId,
      actor: ACTOR,
      mode: 'OPERATOR_FULFILLED',
    });

    operatorMethodId = method.id;
  });

  it('uses it, and says so in words the seller wrote or would recognise', async () => {
    const outcome = await chooseMethodForConsignment({
      sellerAccountId: sellerId,
      sellerOfferIds: [],
      sellerLocationId: locationId,
      destinationPostalCode: '110001',
      needs: NEEDS,
    });

    expect(outcome.fulfilmentMethodId).toBe(operatorMethodId);
    expect(outcome.source).toBe('SELLER_DEFAULT');
    expect(outcome.reason).toContain('default');
  });

  it('stops using it the moment it is paused', async () => {
    await prisma.sellerFulfilmentMethod.update({
      where: { id: operatorMethodId },
      data: { status: 'PAUSED', role: 'ADDITIONAL', primaryForSellerAccountId: null },
    });

    const outcome = await chooseMethodForConsignment({
      sellerAccountId: sellerId,
      sellerOfferIds: [],
      sellerLocationId: locationId,
      destinationPostalCode: '110001',
      needs: NEEDS,
    });

    expect(outcome.source).toBe('MANUAL_REVIEW');
    // The seller reading this sees which of their own methods was tried and
    // what stopped it, rather than "no carrier available".
    expect(outcome.reason).toContain('not ready to use');

    await prisma.sellerFulfilmentMethod.update({
      where: { id: operatorMethodId },
      data: { status: 'APPROVED' },
    });

    await setMethodRole({
      sellerAccountId: sellerId,
      actor: ACTOR,
      methodId: operatorMethodId,
      role: 'PRIMARY',
    });
  });
});

describe('a warehouse rule beating the default', () => {
  let vanMethodId = '';

  beforeAll(async () => {
    const method = await chooseFulfilmentMethod({
      sellerAccountId: sellerId,
      actor: ACTOR,
      mode: 'SELF_MANAGED',
      publicDisplayName: 'Selection Co vans',
    });

    vanMethodId = method.id;

    // A real organisation behind it, because the CHECK constraint refuses an
    // approved self-managed method that names nobody - and because the picker
    // reads the organisation's own service regions.
    const partner = await prisma.logisticsPartner.create({
      data: {
        id: newId(),
        partnerCode: PARTNER_CODE,
        legalName: 'Selection Co Logistics Ltd',
        displayName: 'Selection Co vans',
        displayNameNormalized: 'selectioncovans',
        registrationCountry: 'IN',
        contactEmail: 'ops@selection.test',
        status: 'ACTIVE',
        partnerKind: 'SELLER_SELF_MANAGED',
        ownerSellerAccountId: sellerId,
      },
    });

    await prisma.logisticsServiceRegion.create({
      data: {
        id: newId(),
        logisticsPartnerId: partner.id,
        scope: 'COUNTRY',
        countryCode: 'IN',
        isActive: true,
      },
    });

    await prisma.sellerFulfilmentMethod.update({
      where: { id: vanMethodId },
      data: { status: 'APPROVED', logisticsPartnerId: partner.id },
    });

    await upsertFulfilmentRule({
      sellerAccountId: sellerId,
      actor: ACTOR,
      scope: 'WAREHOUSE',
      fulfilmentMethodId: vanMethodId,
      sellerLocationId: locationId,
      note: 'Everything from the Delhi depot goes on our own vans.',
    });
  });

  it('routes a parcel leaving that place by the rule', async () => {
    const outcome = await chooseMethodForConsignment({
      sellerAccountId: sellerId,
      sellerOfferIds: [],
      sellerLocationId: locationId,
      destinationPostalCode: '110001',
      needs: NEEDS,
    });

    expect(outcome.fulfilmentMethodId).toBe(vanMethodId);
    expect(outcome.source).toBe('AUTOMATIC_RULE');
    // The seller's own words come back, so "why did this go by van?" reads as
    // something they wrote rather than something the system decided.
    expect(outcome.reason).toBe('Everything from the Delhi depot goes on our own vans.');
  });

  it('falls back to the default for a parcel leaving somewhere else', async () => {
    const outcome = await chooseMethodForConsignment({
      sellerAccountId: sellerId,
      sellerOfferIds: [],
      sellerLocationId: null,
      destinationPostalCode: '110001',
      needs: NEEDS,
    });

    expect(outcome.source).toBe('SELLER_DEFAULT');
    expect(outcome.fulfilmentMethodId).not.toBe(vanMethodId);
  });

  it('refuses the vans for a parcel crossing a border', async () => {
    // `allowsInternational` is false until the marketplace has seen the
    // customs paperwork, and a parcel stopped at a border is worse than one
    // that was never offered the option.
    const outcome = await chooseMethodForConsignment({
      sellerAccountId: sellerId,
      sellerOfferIds: [],
      sellerLocationId: locationId,
      destinationPostalCode: 'SW1A 1AA',
      needs: { ...NEEDS, destinationCountry: 'GB' },
    });

    expect(outcome.fulfilmentMethodId).not.toBe(vanMethodId);
  });

  it('refuses the vans for handling the organisation is not approved for', async () => {
    const outcome = await chooseMethodForConsignment({
      sellerAccountId: sellerId,
      sellerOfferIds: [],
      sellerLocationId: locationId,
      destinationPostalCode: '110001',
      needs: { ...NEEDS, requiredCapabilities: ['COLD_CHAIN_2_8'] },
    });

    // The organisation has a service region and no approved capabilities, so
    // a cold-chain consignment finds nothing - which is correct, and is the
    // difference between a claim and an approval.
    expect(outcome.fulfilmentMethodId).not.toBe(vanMethodId);
  });
});
