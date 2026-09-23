/**
 * Configuring a delivery operation a seller runs themselves.
 *
 * Where it collects from, where it goes, what it may carry, what it charges.
 * Against a real database, because almost everything that can go wrong here is
 * a tenant boundary or a constraint and neither exists in a unit test.
 *
 * THE FIVE THAT MATTER, AND WHY
 *
 *   - **A seller configures what they OWN.** Not another seller's operation,
 *     and not the courier that merely works for them - that company sets its
 *     own coverage in its own portal, and a marketplace that let one business
 *     rewrite another's service promise would be broken in a way nobody
 *     notices until a parcel is refused.
 *   - **A pickup profile cannot point at somebody else's warehouse.** Two ids
 *     arrive in one request and a foreign key cannot say they belong to the
 *     same seller, so the service must.
 *   - **An exclusion is stored as an exclusion.** "All of India except the
 *     islands" is the shape real coverage takes, and an inclusion-only model
 *     silently loses the exception.
 *   - **A seller cannot approve their own capability.** There is no parameter
 *     that would let them, and a re-request after a refusal must go back to
 *     REQUESTED rather than stay approved on last year's certificate.
 *   - **A republished price list makes a new version.** Version 1 stays and
 *     stops being live, because a customer disputing a delivery charge six
 *     weeks later has to be shown the card as it stood on the day.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { chooseFulfilmentMethod, type SellerActor } from '../../src/modules/seller/fulfilment-method.service.js';
import {
  listCapabilities,
  listPickupProfiles,
  listRateCards,
  listServiceAreas,
  publishRateCard,
  removeServiceArea,
  requestCapability,
  savePickupProfile,
  saveServiceArea,
} from '../../src/modules/seller/self-managed-config.service.js';

const SLUG_A = 'selfconfig-co';
const SLUG_B = 'selfconfig-rival-co';

const PARTNER_CODE_A = 'LP-TEST-SELFCFG-A';
const PARTNER_CODE_B = 'LP-TEST-SELFCFG-B';
const PARTNER_CODE_HIRED = 'LP-TEST-SELFCFG-HIRED';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Self Config Co' };
const ACTOR_B: SellerActor = { memberId: null, userId: null, label: 'Self Config Rival Co' };

let sellerA = '';
let sellerB = '';
let locationA = '';
let locationB = '';
/** Seller A's own operation - the one they may configure. */
let methodA = '';
/** Seller B's own operation, used to prove the boundary. */
let methodB = '';
/** A courier that works FOR seller A but is not theirs to configure. */
let hiredMethodA = '';

async function cleanUp(): Promise<void> {
  const slugs = { in: [SLUG_A, SLUG_B] };
  const partnerCodes = { in: [PARTNER_CODE_A, PARTNER_CODE_B, PARTNER_CODE_HIRED] };

  await prisma.sellerLogisticsRateBand.deleteMany({
    where: { rateCard: { sellerAccount: { slug: slugs } } },
  });
  await prisma.sellerLogisticsRateCard.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerLogisticsPickupProfile.deleteMany({
    where: { sellerAccount: { slug: slugs } },
  });
  await prisma.logisticsServiceRegion.deleteMany({
    where: { partner: { partnerCode: partnerCodes } },
  });
  await prisma.logisticsCapability.deleteMany({
    where: { partner: { partnerCode: partnerCodes } },
  });
  await prisma.sellerFulfilmentMethod.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.logisticsPartner.deleteMany({ where: { partnerCode: partnerCodes } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerLocation.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: slugs } });
}

async function makeSeller(slug: string, displayName: string): Promise<string> {
  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'RESELLER',
      registrationCountry: 'IN',
      status: 'DRAFT',
    },
  });

  return seller.id;
}

async function makeLocation(sellerAccountId: string, code: string): Promise<string> {
  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId,
      code,
      name: `${code} warehouse`,
      addressLine1: '1 Depot Road',
      city: 'Delhi',
      postcode: '110001',
      countryCode: 'IN',
    },
  });

  return location.id;
}

/**
 * A method with a delivery company behind it, the way the real flow ends up.
 *
 * Not a bare UPDATE: `chk_seller_fulfilment_method_target` refuses an approved
 * self-managed method with nobody behind it, and it is right to.
 */
async function makeMethodWithOrganisation(
  sellerAccountId: string,
  actor: SellerActor,
  mode: 'SELF_MANAGED' | 'DEDICATED_PARTNER',
  partnerCode: string,
  displayName: string,
): Promise<string> {
  const method = await chooseFulfilmentMethod({
    sellerAccountId,
    actor,
    mode,
    provider: null,
    environment: null,
    publicDisplayName: displayName,
  });

  const partner = await prisma.logisticsPartner.create({
    data: {
      id: newId(),
      partnerCode,
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      registrationCountry: 'IN',
      contactEmail: `ops@${partnerCode.toLowerCase()}.example`,
      status: 'ACTIVE',
      partnerKind: mode === 'SELF_MANAGED' ? 'SELLER_SELF_MANAGED' : 'SELLER_DEDICATED',
      ownerSellerAccountId: sellerAccountId,
    },
  });

  await prisma.sellerFulfilmentMethod.update({
    where: { id: method.id },
    data: { status: 'APPROVED', logisticsPartnerId: partner.id },
  });

  return method.id;
}

beforeAll(async () => {
  await cleanUp();

  sellerA = await makeSeller(SLUG_A, 'Self Config Co');
  sellerB = await makeSeller(SLUG_B, 'Self Config Rival Co');

  locationA = await makeLocation(sellerA, 'SCC-1');
  locationB = await makeLocation(sellerB, 'SCR-1');

  methodA = await makeMethodWithOrganisation(
    sellerA,
    ACTOR,
    'SELF_MANAGED',
    PARTNER_CODE_A,
    'Self Config Vans',
  );
  methodB = await makeMethodWithOrganisation(
    sellerB,
    ACTOR_B,
    'SELF_MANAGED',
    PARTNER_CODE_B,
    'Rival Vans',
  );
  hiredMethodA = await makeMethodWithOrganisation(
    sellerA,
    ACTOR,
    'DEDICATED_PARTNER',
    PARTNER_CODE_HIRED,
    'Hired Courier',
  );
});

afterAll(async () => {
  // Leftovers here break the FIRST file of the next run, which is the hardest
  // failure in this suite to attribute to anything.
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('where goods are collected from', () => {
  it('records the window a courier calls in, per building per method', async () => {
    const profile = await savePickupProfile({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      sellerLocationId: locationA,
      pickupDaysMask: 10, // Tuesday and Thursday.
      windowStart: '09:00',
      windowEnd: '12:30',
      maxDailyShipments: 40,
      instructions: 'Bay 3, ring the bell on the left.',
    });

    expect(profile.locationName).toBe('SCC-1 warehouse');
    expect(profile.pickupDaysMask).toBe(10);
    expect(profile.windowEnd).toBe('12:30');
    expect(profile.maxDailyShipments).toBe(40);
  });

  it('replaces the profile rather than adding a second one', async () => {
    // A dispatcher saving the same screen twice has changed their mind, not
    // arranged a second collection from the same door.
    await savePickupProfile({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      sellerLocationId: locationA,
      windowStart: '14:00',
      windowEnd: '17:00',
    });

    const profiles = await listPickupProfiles(sellerA, methodA);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.windowStart).toBe('14:00');
  });

  it('refuses a warehouse belonging to somebody else', async () => {
    // Two ids in one request, and no foreign key can say they belong to the
    // same seller. If this ever passes, seller A is arranging collections from
    // seller B's building.
    await expect(
      savePickupProfile({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: methodA,
        sellerLocationId: locationB,
      }),
    ).rejects.toMatchObject({ code: 'SELLER_FULFILMENT_RULE_INVALID' });
  });

  it('refuses a method belonging to somebody else', async () => {
    await expect(
      savePickupProfile({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: methodB,
        sellerLocationId: locationA,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('where it delivers to', () => {
  it('stores a whole country with an empty region rather than a null one', async () => {
    const area = await saveServiceArea({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      scope: 'COUNTRY',
      countryCode: 'in',
      transitDaysMin: 2,
      transitDaysMax: 5,
    });

    expect(area.countryCode).toBe('IN');
    // Empty, not null: MariaDB treats every NULL in a UNIQUE index as
    // distinct, so a nullable column here would let one operation hold two
    // "the whole of India" rows.
    expect(area.regionValue).toBe('');
    expect(area.isExclusion).toBe(false);
  });

  it('stores an exclusion as an exclusion', async () => {
    // "All of India except the islands" is the shape real coverage takes.
    const area = await saveServiceArea({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      scope: 'STATE',
      countryCode: 'IN',
      regionValue: 'Andaman and Nicobar Islands',
      isExclusion: true,
    });

    expect(area.isExclusion).toBe(true);
    expect(area.regionValue).toBe('ANDAMAN AND NICOBAR ISLANDS');
  });

  it('keeps a surcharge as minor units on the wire', async () => {
    const area = await saveServiceArea({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      scope: 'POSTCODE_PREFIX',
      countryCode: 'IN',
      regionValue: '19',
      remoteAreaSurchargeMinor: 25000n,
    });

    // A string, never a number. A charge that passed through a float is a
    // charge that can disagree with the invoice by a cent.
    expect(area.remoteAreaSurchargeMinor).toBe('25000');
    expect(typeof area.remoteAreaSurchargeMinor).toBe('string');
  });

  it('refuses a transit range that runs backwards', async () => {
    await expect(
      saveServiceArea({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: methodA,
        scope: 'CITY',
        countryCode: 'IN',
        regionValue: 'Kochi',
        transitDaysMin: 7,
        transitDaysMax: 2,
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('will not let a seller set the coverage of a courier that works for them', async () => {
    // The hired company is owned by seller A in the data - that is what keeps
    // it off other sellers' pickers - and is still not theirs to configure. It
    // sets its own coverage in its own portal, and a marketplace that let a
    // client rewrite its service promise would be broken in a way nobody
    // notices until a parcel is refused at a depot.
    await expect(
      saveServiceArea({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: hiredMethodA,
        scope: 'COUNTRY',
        countryCode: 'IN',
      }),
    ).rejects.toMatchObject({ code: 'SELLER_LOGISTICS_PARTNER_NOT_YOURS' });
  });

  it('removes an area, and refuses to remove one that is not theirs', async () => {
    const areas = await listServiceAreas(sellerA, methodA);
    const kochi = areas.find((area) => area.regionValue === '19');

    expect(kochi).toBeDefined();

    await removeServiceArea({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      areaId: kochi?.id ?? '',
    });

    expect(await listServiceAreas(sellerA, methodA)).toHaveLength(2);

    // Seller B's area, named from seller A's session: the partner id comes
    // from seller A's own method, so this matches nothing.
    const rivalAreas = await saveServiceArea({
      sellerAccountId: sellerB,
      actor: ACTOR_B,
      fulfilmentMethodId: methodB,
      scope: 'COUNTRY',
      countryCode: 'IN',
    });

    await expect(
      removeServiceArea({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: methodA,
        areaId: rivalAreas.id,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('what it is allowed to carry', () => {
  it('records a request, never an approval', async () => {
    const capability = await requestCapability({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      kind: 'COLD_CHAIN_2_8',
      evidenceReference: 'CERT-2026-11',
    });

    // REQUESTED. There is no parameter on this function that would let a
    // seller approve their own capability, because the approval is the whole
    // difference between a claim and a fact.
    expect(capability.state).toBe('REQUESTED');
  });

  it('sends a re-request back to REQUESTED rather than leaving it approved', async () => {
    const existing = await listCapabilities(sellerA, methodA);
    const coldChain = existing.find((row) => row.kind === 'COLD_CHAIN_2_8');

    await prisma.logisticsCapability.update({
      where: { id: coldChain?.id ?? '' },
      data: { state: 'APPROVED', decisionNote: 'Certificate seen.' },
    });

    await requestCapability({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      kind: 'COLD_CHAIN_2_8',
      evidenceReference: 'CERT-2027-11',
    });

    const after = await listCapabilities(sellerA, methodA);

    // One row, back to REQUESTED. A seller who has re-sent their certificate
    // is asking again, and staying APPROVED would approve evidence nobody
    // looked at.
    expect(after).toHaveLength(1);
    expect(after[0]?.state).toBe('REQUESTED');
    expect(after[0]?.evidenceReference).toBe('CERT-2027-11');
    expect(after[0]?.decisionNote).toBeNull();
  });
});

describe('what it charges', () => {
  it('publishes version 1 with its lines', async () => {
    const card = await publishRateCard({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      name: 'Domestic standard',
      currency: 'inr',
      minimumChargeMinor: 5000n,
      bands: [
        { basis: 'WEIGHT', minValue: 0, maxValue: 1000, amountMinor: '9900' },
        { basis: 'WEIGHT', minValue: 1001, maxValue: null, amountMinor: '9900', perUnitMinor: '50' },
      ],
    });

    expect(card.version).toBe(1);
    expect(card.currency).toBe('INR');
    expect(card.isActive).toBe(true);
    expect(card.bands).toHaveLength(2);
    // Strings out, as they went in.
    expect(card.bands[1]?.perUnitMinor).toBe('50');
    expect(card.minimumChargeMinor).toBe('5000');
  });

  it('makes a new version on republish and leaves the old one on the record', async () => {
    const card = await publishRateCard({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodA,
      name: 'Domestic standard',
      currency: 'INR',
      bands: [{ basis: 'FLAT', amountMinor: '11900' }],
    });

    expect(card.version).toBe(2);

    const all = await listRateCards(sellerA, methodA);
    const versionOne = all.find((row) => row.version === 1);

    // Still there, no longer live. A quote points at the version it was priced
    // from, and a customer disputing a charge six weeks later has to be shown
    // the card as it stood on the day.
    expect(versionOne).toBeDefined();
    expect(versionOne?.isActive).toBe(false);
    expect(all.filter((row) => row.isActive)).toHaveLength(1);
  });

  it('refuses a price list with no lines', async () => {
    await expect(
      publishRateCard({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: methodA,
        name: 'Empty',
        currency: 'INR',
        bands: [],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('will not price the work of a courier that prices its own', async () => {
    await expect(
      publishRateCard({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: hiredMethodA,
        name: 'Not our prices to set',
        currency: 'INR',
        bands: [{ basis: 'FLAT', amountMinor: '100' }],
      }),
    ).rejects.toMatchObject({ code: 'SELLER_LOGISTICS_PARTNER_NOT_YOURS' });
  });

  it('keeps one seller price list out of another seller list', async () => {
    expect(await listRateCards(sellerB, methodA)).toHaveLength(0);
  });
});
