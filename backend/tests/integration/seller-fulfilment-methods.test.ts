/**
 * A seller choosing how their goods get delivered.
 *
 * The delivery methods behind Seller Hub -> Logistics and the rules behind
 * them, against a real database - because most of what can go wrong here is a
 * constraint, a transaction or a tenant boundary, and none of those exist in a
 * unit test.
 *
 * The four that matter most, and why each is here:
 *
 *   - **Delivery is not an onboarding step any more.** It used to be a
 *     required one. A seller now finishes their application without choosing
 *     a carrier, and everything they chose before is kept and shown under
 *     Logistics - so nothing here may block submission, and nothing may be
 *     lost.
 *   - **One primary, enforced by the database.** Two dispatchers pressing save
 *     in the same second must not produce two defaults, and the check that
 *     prevents it is a UNIQUE index rather than a read-then-write.
 *   - **Seller A must not reach Seller B's anything.** A method, a listing and
 *     a warehouse, each checked against the session's seller in the query that
 *     finds it.
 *   - **A rule cannot contradict itself.** The scope and the match column are
 *     tied together by a CHECK constraint, and the service must refuse before
 *     it gets there so the seller sees a sentence rather than a 500.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  archiveFulfilmentRule,
  changeMethodStatus,
  chooseFulfilmentMethod,
  describeFulfilmentOptions,
  listFulfilmentMethods,
  listFulfilmentRules,
  setMethodRole,
  upsertFulfilmentRule,
  type SellerActor,
} from '../../src/modules/seller/fulfilment-method.service.js';
import { readOnboarding } from '../../src/modules/seller/onboarding.service.js';
import { SellerRole, permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

const SLUG_A = 'fulfilment-method-co';
const SLUG_B = 'fulfilment-rival-co';

let sellerA = '';
let sellerB = '';
let locationA = '';
let locationB = '';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Fulfilment Method Co' };

const PARTNER_CODE_A = 'LP-TEST-FULFIL-A';
const PARTNER_CODE_B = 'LP-TEST-FULFIL-B';

/**
 * Approve a method the way the marketplace would, target and all.
 *
 * NOT a bare `UPDATE ... SET status = 'APPROVED'`. The database refuses that
 * for a self-managed or dedicated method with no organisation behind it -
 * `chk_seller_fulfilment_method_target` - and it is right to: an approved
 * method that names nobody is a method the picker would choose and then be
 * unable to hand a parcel to.
 *
 * So the helper creates the organisation first, exactly as the real flow will
 * in the dedicated-partner stage, and links it. That the shortcut does not
 * work is the constraint doing its job, and writing round it in a test would
 * throw away the one check that catches this in production.
 */
async function approveMethod(
  sellerAccountId: string,
  methodId: string,
  partnerCode: string,
  displayName: string,
): Promise<void> {
  const method = await prisma.sellerFulfilmentMethod.findUniqueOrThrow({
    where: { id: methodId },
    select: { mode: true, logisticsPartnerId: true },
  });

  const needsPartner = method.mode === 'SELF_MANAGED' || method.mode === 'DEDICATED_PARTNER';

  let partnerId = method.logisticsPartnerId;

  if (needsPartner && partnerId === null) {
    const partner = await prisma.logisticsPartner.upsert({
      where: { partnerCode },
      update: {},
      create: {
        id: newId(),
        partnerCode,
        legalName: `${displayName} Ltd`,
        displayName,
        displayNameNormalized: displayName.toLowerCase().replace(/[^a-z0-9]/g, ''),
        registrationCountry: 'IN',
        contactEmail: `ops@${partnerCode.toLowerCase()}.example`,
        status: 'ACTIVE',
        partnerKind: method.mode === 'SELF_MANAGED' ? 'SELLER_SELF_MANAGED' : 'SELLER_DEDICATED',
        ownerSellerAccountId: sellerAccountId,
      },
      select: { id: true },
    });

    partnerId = partner.id;
  }

  await prisma.sellerFulfilmentMethod.update({
    where: { id: methodId },
    data: { status: 'APPROVED', logisticsPartnerId: partnerId },
  });
}

function membership(sellerAccountId: string, slug: string, displayName: string): SellerMembership {
  return {
    sellerAccountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName,
    legalName: `${displayName} Ltd`,
    slug,
    status: 'DRAFT',
    role: SellerRole.OWNER,
    permissions: permissionsForSellerRole(SellerRole.OWNER),
    hasLock: false,
    isTrading: false,
    isApplicationEditable: true,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
}

async function cleanUp(): Promise<void> {
  const slugs = { in: [SLUG_A, SLUG_B] };

  // Children before parents: the rules and methods are ON DELETE CASCADE from
  // the seller account, but the audit rows are not, and a leftover audit row
  // blocks nothing while a leftover seller account collides on its slug.
  await prisma.sellerFulfilmentRule.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerFulfilmentMethod.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.logisticsPartner.deleteMany({
    where: { partnerCode: { in: [PARTNER_CODE_A, PARTNER_CODE_B] } },
  });
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

beforeAll(async () => {
  await cleanUp();

  sellerA = await makeSeller(SLUG_A, 'Fulfilment Method Co');
  sellerB = await makeSeller(SLUG_B, 'Fulfilment Rival Co');

  locationA = await makeLocation(sellerA, 'FMC-1');
  locationB = await makeLocation(sellerB, 'FRC-1');
});

afterAll(async () => {
  // Integration tests must clean up after themselves: a leftover row here
  // breaks the FIRST file of the next run, which is the hardest failure in
  // this suite to attribute.
  await cleanUp();
});

function stepState(steps: { key: string; state: string }[], key: string): string {
  return steps.find((step) => step.key === key)?.state ?? 'MISSING';
}

// ---------------------------------------------------------------------------

describe('delivery, outside onboarding', () => {
  it('is no longer a step of the seller application', async () => {
    const view = await readOnboarding(membership(sellerA, SLUG_A, 'Fulfilment Method Co'));

    expect(view.steps.map((step) => step.key as string)).not.toContain('logistics_partner');
    expect(stepState(view.steps, 'logistics_partner')).toBe('MISSING');
  });

  it('never blocks submission, whatever the seller has or has not chosen', async () => {
    const view = await readOnboarding(membership(sellerA, SLUG_A, 'Fulfilment Method Co'));

    expect(view.blockingSteps.map((step) => step.key as string)).not.toContain('logistics_partner');
  });

  it('offers five ways of delivering plus the marketplace default', async () => {
    const { options } = await describeFulfilmentOptions(sellerA);

    expect(options.map((option) => option.key)).toEqual([
      'dhl',
      'fedex',
      'india_post',
      'self_managed',
      'dedicated_partner',
      'operator_fulfilled',
    ]);
  });

  it('never offers driver management for an external carrier', async () => {
    const { options } = await describeFulfilmentOptions(sellerA);

    for (const key of ['dhl', 'fedex', 'india_post']) {
      const option = options.find((candidate) => candidate.key === key);
      expect(option?.driversManagedHere).toBe(false);
    }
  });

  it('does not claim an API for India Post, and asks for no credentials', async () => {
    const { options } = await describeFulfilmentOptions(sellerA);
    const indiaPost = options.find((option) => option.key === 'india_post');

    expect(indiaPost?.hasVerifiedApi).toBe(false);
    expect(indiaPost?.requiresApiCredentials).toBe(false);
    expect(indiaPost?.trackingMode).toBe('EXTERNAL_LINK');
  });

  it('still approves marketplace delivery in one call', async () => {
    const method = await chooseFulfilmentMethod({
      sellerAccountId: sellerA,
      actor: ACTOR,
      mode: 'OPERATOR_FULFILLED',
    });

    expect(method.status).toBe('APPROVED');

    // Choosing a method writes no onboarding step, for either answer.
    const view = await readOnboarding(membership(sellerA, SLUG_A, 'Fulfilment Method Co'));
    expect(stepState(view.steps, 'logistics_partner')).toBe('MISSING');
  });

  it('makes the first approved method the default without being asked', async () => {
    // A seller who sets up one method and never presses "make this primary"
    // still has to be able to ship.
    const methods = await listFulfilmentMethods(sellerA);
    const operator = methods.find((method) => method.mode === 'OPERATOR_FULFILLED');

    expect(operator?.role).toBe('PRIMARY');
  });

  it('does not go green on a carrier the seller has only started', async () => {
    const method = await chooseFulfilmentMethod({
      sellerAccountId: sellerB,
      actor: ACTOR,
      mode: 'INTEGRATED_CARRIER',
      provider: 'DHL',
    });

    // PENDING_SETUP, not APPROVED: they have said what they want and
    // configured none of it. No credential exists, so nothing can ship.
    expect(method.status).toBe('PENDING_SETUP');

    // An unfinished carrier does not hold the application back.
    const view = await readOnboarding(membership(sellerB, SLUG_B, 'Fulfilment Rival Co'));
    expect(view.blockingSteps.map((step) => step.key as string)).not.toContain('logistics_partner');
  });

  it('keeps what the seller chose before, after reading the application', async () => {
    await readOnboarding(membership(sellerB, SLUG_B, 'Fulfilment Rival Co'));
    const methods = await listFulfilmentMethods(sellerB);

    expect(methods.some((method) => method.mode === 'INTEGRATED_CARRIER')).toBe(true);
  });

  it('treats pressing the same card twice as one method', async () => {
    await chooseFulfilmentMethod({
      sellerAccountId: sellerB,
      actor: ACTOR,
      mode: 'INTEGRATED_CARRIER',
      provider: 'DHL',
    });

    const methods = await listFulfilmentMethods(sellerB);
    const dhl = methods.filter((method) => method.connection?.provider === 'DHL');

    // `methodKey` is unique per seller, so a seller pressing DHL twice moves
    // one row rather than creating a second.
    expect(methods.filter((method) => method.mode === 'INTEGRATED_CARRIER')).toHaveLength(1);
    expect(dhl.length).toBeLessThanOrEqual(1);
  });
});

describe('defaults and fallbacks', () => {
  it('refuses to make an unapproved method the default', async () => {
    const methods = await listFulfilmentMethods(sellerB);
    const pending = methods.find((method) => method.status === 'PENDING_SETUP');

    await expect(
      setMethodRole({
        sellerAccountId: sellerB,
        actor: ACTOR,
        methodId: pending?.id ?? '',
        role: 'PRIMARY',
      }),
    ).rejects.toMatchObject({ code: 'SELLER_FULFILMENT_METHOD_NOT_APPROVED' });
  });

  it('moves the default rather than ending up with two', async () => {
    // The database holds this, not a check in the service: one UNIQUE index
    // over a column that is the seller's id while the row is primary and NULL
    // when it is not.
    const second = await chooseFulfilmentMethod({
      sellerAccountId: sellerA,
      actor: ACTOR,
      mode: 'SELF_MANAGED',
      publicDisplayName: 'Our own vans',
    });

    // Approve it the way the marketplace would - organisation and all. A bare
    // status update is refused by `chk_seller_fulfilment_method_target`.
    await approveMethod(sellerA, second.id, PARTNER_CODE_A, 'Fulfilment Method Vans');

    await setMethodRole({
      sellerAccountId: sellerA,
      actor: ACTOR,
      methodId: second.id,
      role: 'PRIMARY',
    });

    const primaries = await prisma.sellerFulfilmentMethod.count({
      where: { sellerAccountId: sellerA, role: 'PRIMARY' },
    });

    expect(primaries).toBe(1);

    const holders = await prisma.sellerFulfilmentMethod.count({
      where: { sellerAccountId: sellerA, primaryForSellerAccountId: { not: null } },
    });

    // The enum and the uniqueness column are written together and must never
    // disagree.
    expect(holders).toBe(1);
  });

  it('stops a paused method being the default', async () => {
    const methods = await listFulfilmentMethods(sellerA);
    const primary = methods.find((method) => method.role === 'PRIMARY');

    const paused = await changeMethodStatus({
      sellerAccountId: sellerA,
      actor: ACTOR,
      methodId: primary?.id ?? '',
      status: 'PAUSED',
      reason: 'Vans off the road until Friday.',
    });

    // Leaving it primary would make the picker try it first on every order and
    // fall through on every order, which reads as "the marketplace ignores my
    // settings".
    expect(paused.status).toBe('PAUSED');
    expect(paused.role).toBe('ADDITIONAL');
  });

  it('refuses to pause without a reason', async () => {
    const other = await chooseFulfilmentMethod({
      sellerAccountId: sellerA,
      actor: ACTOR,
      mode: 'DEDICATED_PARTNER',
      publicDisplayName: 'MediCourier',
    });

    await approveMethod(sellerA, other.id, PARTNER_CODE_B, 'MediCourier');

    await expect(
      changeMethodStatus({
        sellerAccountId: sellerA,
        actor: ACTOR,
        methodId: other.id,
        status: 'PAUSED',
        reason: '   ',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('the rules that route a parcel', () => {
  it('computes the precedence from the scope', async () => {
    const methods = await listFulfilmentMethods(sellerA);
    const approved = methods.find((method) => method.status === 'APPROVED');

    const rule = await upsertFulfilmentRule({
      sellerAccountId: sellerA,
      actor: ACTOR,
      scope: 'WAREHOUSE',
      fulfilmentMethodId: approved?.id ?? '',
      sellerLocationId: locationA,
    });

    // The client never sends this. The database also refuses a row whose
    // precedence is not its scope's, so the two can never disagree.
    expect(rule.precedence).toBe(20);
  });

  it('normalises a postcode prefix so formatting cannot stop it matching', async () => {
    const methods = await listFulfilmentMethods(sellerA);
    const approved = methods.find((method) => method.status === 'APPROVED');

    const rule = await upsertFulfilmentRule({
      sellerAccountId: sellerA,
      actor: ACTOR,
      scope: 'DESTINATION',
      fulfilmentMethodId: approved?.id ?? '',
      destinationCountry: 'in',
      destinationPostalPrefix: '110 0',
    });

    expect(rule.destinationCountry).toBe('IN');
    expect(rule.destinationPostalPrefix).toBe('1100');
  });

  it('saves the same rule twice as one rule', async () => {
    const methods = await listFulfilmentMethods(sellerA);
    const approved = methods.find((method) => method.status === 'APPROVED');

    await upsertFulfilmentRule({
      sellerAccountId: sellerA,
      actor: ACTOR,
      scope: 'WAREHOUSE',
      fulfilmentMethodId: approved?.id ?? '',
      sellerLocationId: locationA,
      note: 'Everything from the Delhi depot.',
    });

    const rules = await listFulfilmentRules(sellerA);
    const warehouseRules = rules.filter((rule) => rule.scope === 'WAREHOUSE');

    expect(warehouseRules).toHaveLength(1);
    expect(warehouseRules[0]?.note).toBe('Everything from the Delhi depot.');
  });

  it('refuses a product rule that names no listing', async () => {
    const methods = await listFulfilmentMethods(sellerA);
    const approved = methods.find((method) => method.status === 'APPROVED');

    // The CHECK constraint would refuse it too. This is what stops it reaching
    // the constraint, so the seller sees a sentence rather than a 500.
    await expect(
      upsertFulfilmentRule({
        sellerAccountId: sellerA,
        actor: ACTOR,
        scope: 'PRODUCT',
        fulfilmentMethodId: approved?.id ?? '',
      }),
    ).rejects.toMatchObject({ code: 'SELLER_FULFILMENT_RULE_INVALID' });
  });

  it('archives a rule rather than deleting it', async () => {
    const rules = await listFulfilmentRules(sellerA);
    const target = rules[0];

    await archiveFulfilmentRule({
      sellerAccountId: sellerA,
      actor: ACTOR,
      ruleId: target?.id ?? '',
    });

    // Gone from the seller's list...
    const after = await listFulfilmentRules(sellerA);
    expect(after.find((rule) => rule.id === target?.id)).toBeUndefined();

    // ...and still on the record, because consignments point at it.
    const row = await prisma.sellerFulfilmentRule.findUnique({ where: { id: target?.id ?? '' } });
    expect(row).not.toBeNull();
    expect(row?.archivedAt).not.toBeNull();
  });
});

describe('one seller cannot reach another', () => {
  it('cannot see the other seller methods', async () => {
    const mine = await listFulfilmentMethods(sellerA);
    const theirs = await listFulfilmentMethods(sellerB);

    const overlap = mine.filter((method) => theirs.some((other) => other.id === method.id));
    expect(overlap).toEqual([]);
  });

  it('cannot make another seller method its default', async () => {
    const theirs = await listFulfilmentMethods(sellerB);

    await expect(
      setMethodRole({
        sellerAccountId: sellerA,
        actor: ACTOR,
        methodId: theirs[0]?.id ?? '',
        role: 'PRIMARY',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('cannot route a parcel out of another seller warehouse', async () => {
    // A foreign key cannot express "these two ids must belong to the same
    // third row", which is exactly what a cross-tenant write needs checking.
    const methods = await listFulfilmentMethods(sellerA);
    const approved = methods.find((method) => method.status === 'APPROVED');

    await expect(
      upsertFulfilmentRule({
        sellerAccountId: sellerA,
        actor: ACTOR,
        scope: 'WAREHOUSE',
        fulfilmentMethodId: approved?.id ?? '',
        sellerLocationId: locationB,
      }),
    ).rejects.toMatchObject({ code: 'SELLER_FULFILMENT_RULE_INVALID' });
  });

  it('cannot route a parcel to another seller method', async () => {
    const theirs = await listFulfilmentMethods(sellerB);

    await expect(
      upsertFulfilmentRule({
        sellerAccountId: sellerA,
        actor: ACTOR,
        scope: 'SELLER_DEFAULT',
        fulfilmentMethodId: theirs[0]?.id ?? '',
      }),
    ).rejects.toMatchObject({ code: 'SELLER_FULFILMENT_RULE_INVALID' });
  });

  it('cannot archive another seller rule', async () => {
    // Seller B's own marketplace-delivery method: approved on creation,
    // needs no organisation, and is the one mode a bare approve is honest for.
    const theirs = await chooseFulfilmentMethod({
      sellerAccountId: sellerB,
      actor: ACTOR,
      mode: 'OPERATOR_FULFILLED',
    });

    const pending = { id: theirs.id };

    const theirRule = await upsertFulfilmentRule({
      sellerAccountId: sellerB,
      actor: ACTOR,
      scope: 'SELLER_DEFAULT',
      fulfilmentMethodId: pending?.id ?? '',
    });

    await expect(
      archiveFulfilmentRule({ sellerAccountId: sellerA, actor: ACTOR, ruleId: theirRule.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
