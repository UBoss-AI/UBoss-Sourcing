/**
 * A seller's own delivery arm, and inviting a courier that works for them.
 *
 * The two ways a real logistics organisation gets behind a seller's fulfilment
 * method, against a real database - because everything that can go wrong here
 * is a transaction, a unique index or a tenant boundary.
 *
 * THE FOUR THAT MATTER MOST
 *
 *   - **A seller cannot conjure a courier into existence.** Inviting one
 *     creates an invitation and nothing else; the company itself appears only
 *     when somebody holding the emailed token says yes.
 *   - **The token is never stored in readable form.** A database read must not
 *     yield something redeemable, and this asserts the row holds a digest.
 *   - **Single use.** Two people clicking the same link must produce one
 *     company, not two.
 *   - **One seller's delivery arm is invisible to every other seller.** It is
 *     on the same `logistics_partners` table as the marketplace's own
 *     carriers, and the only thing keeping it off a competitor's picker is the
 *     owner filter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256Hex } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { chooseFulfilmentMethod, type SellerActor } from '../../src/modules/seller/fulfilment-method.service.js';
import {
  acceptPartnerInvitation,
  createSelfManagedOrganisation,
  describePartnerInvitation,
  inviteDedicatedPartner,
  readRelationshipHistory,
  requestExistingPartner,
  revokePartnerInvitation,
  searchPartnersForSeller,
  transitionRelationship,
} from '../../src/modules/seller/logistics-organisation.service.js';

const SLUG_A = 'org-owner-co';
const SLUG_B = 'org-rival-co';

/** Everything this file creates carries one of these, so cleanup is exact. */
const MARK = 'orgtest';

let sellerA = '';
let sellerB = '';

const ACTOR: SellerActor = { memberId: null, userId: null, label: 'Org Owner Co' };

async function cleanUp(): Promise<void> {
  const slugs = { in: [SLUG_A, SLUG_B] };

  await prisma.sellerLogisticsRelationshipEvent.deleteMany({
    where: { relationship: { sellerAccount: { slug: slugs } } },
  });
  await prisma.sellerLogisticsPartnerInvitation.deleteMany({
    where: { sellerAccount: { slug: slugs } },
  });
  await prisma.sellerLogisticsPartner.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerFulfilmentMethod.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: slugs } } });
  await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccount: { slug: slugs } } });

  // The portal users invited along the way, then the organisations.
  const partners = await prisma.logisticsPartner.findMany({
    where: { displayName: { contains: MARK } },
    select: { id: true },
  });

  const partnerIds = partners.map((partner) => partner.id);

  if (partnerIds.length > 0) {
    const users = await prisma.logisticsPartnerUser.findMany({
      where: { logisticsPartnerId: { in: partnerIds } },
      select: { userId: true },
    });

    await prisma.logisticsPartnerInvitation.deleteMany({
      where: { logisticsPartnerId: { in: partnerIds } },
    });
    await prisma.logisticsPartnerUser.deleteMany({
      where: { logisticsPartnerId: { in: partnerIds } },
    });
    await prisma.authToken.deleteMany({
      where: { userId: { in: users.map((user) => user.userId) } },
    });
    await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.userId) } } });
    await prisma.logisticsPartner.deleteMany({ where: { id: { in: partnerIds } } });
  }

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

/** A seller's SELF_MANAGED or DEDICATED_PARTNER method, ready to be filled in. */
async function methodFor(
  sellerAccountId: string,
  mode: 'SELF_MANAGED' | 'DEDICATED_PARTNER',
): Promise<string> {
  const method = await chooseFulfilmentMethod({ sellerAccountId, actor: ACTOR, mode });
  return method.id;
}

beforeAll(async () => {
  await cleanUp();
  sellerA = await makeSeller(SLUG_A, 'Org Owner Co');
  sellerB = await makeSeller(SLUG_B, 'Org Rival Co');
});

afterAll(async () => {
  await cleanUp();
});

// ---------------------------------------------------------------------------

describe('a seller creating their own delivery arm', () => {
  let partnerId = '';

  it('creates the organisation and links the method to it', async () => {
    const methodId = await methodFor(sellerA, 'SELF_MANAGED');

    const organisation = await createSelfManagedOrganisation({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      displayName: `${MARK} Owner Vans`,
      legalName: 'Org Owner Logistics Ltd',
      registrationCountry: 'IN',
      contactEmail: 'ops@org-owner.test',
      operationsOwnerEmail: `fleet.${MARK}@org-owner.test`,
      operationsOwnerName: 'Fleet Manager',
    });

    partnerId = organisation.logisticsPartnerId;
    expect(organisation.partnerCode).toMatch(/^LP-/);

    const method = await prisma.sellerFulfilmentMethod.findUniqueOrThrow({
      where: { id: methodId },
    });

    expect(method.logisticsPartnerId).toBe(partnerId);
    // Not APPROVED. A seller declaring what their vans can carry is a sales
    // statement until the marketplace has looked at it.
    expect(method.status).toBe('PENDING_APPROVAL');
    // The placeholder key is replaced by the real one, so uniqueness is now
    // about the organisation rather than about the mode.
    expect(method.methodKey).toBe(`PARTNER:${partnerId}`);
  });

  it('marks the organisation as the seller own, and not the marketplace', async () => {
    const partner = await prisma.logisticsPartner.findUniqueOrThrow({ where: { id: partnerId } });

    expect(partner.partnerKind).toBe('SELLER_SELF_MANAGED');
    expect(partner.ownerSellerAccountId).toBe(sellerA);
    // PENDING_ACTIVATION: nobody has accepted the portal invitation yet, and
    // accepting an email is not the marketplace finishing its checks.
    expect(partner.status).toBe('PENDING_ACTIVATION');
  });

  it('invites one named person rather than granting the seller team a fleet', async () => {
    // The distinction the brief is most insistent about. The seller's own
    // members gain no logistics permission; one person gets a portal account.
    const users = await prisma.logisticsPartnerUser.findMany({
      where: { logisticsPartnerId: partnerId },
      select: { role: true },
    });

    expect(users).toHaveLength(1);
    expect(users[0]?.role).toBe('LOGISTICS_PARTNER_OWNER');
  });

  it('refuses a second organisation on the same method', async () => {
    const method = await prisma.sellerFulfilmentMethod.findFirstOrThrow({
      where: { sellerAccountId: sellerA, mode: 'SELF_MANAGED' },
      select: { id: true },
    });

    await expect(
      createSelfManagedOrganisation({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: method.id,
        displayName: `${MARK} Second Vans`,
        legalName: 'Second Ltd',
        registrationCountry: 'IN',
        contactEmail: 'ops2@org-owner.test',
        operationsOwnerEmail: `fleet2.${MARK}@org-owner.test`,
        operationsOwnerName: 'Another Manager',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('keeps it off every other seller picker', async () => {
    // Same table as the marketplace's own carriers. The owner filter is the
    // only thing between this row and a competitor's dropdown.
    const mine = await searchPartnersForSeller(sellerA, MARK);
    const theirs = await searchPartnersForSeller(sellerB, MARK);

    expect(theirs.find((partner) => partner.id === partnerId)).toBeUndefined();
    // Not even on the owner's own list yet: it is PENDING_ACTIVATION, and the
    // search returns only ACTIVE companies.
    expect(mine.find((partner) => partner.id === partnerId)).toBeUndefined();
  });

  it('refuses to reach it from the other seller by id', async () => {
    const methodId = await methodFor(sellerB, 'DEDICATED_PARTNER');

    await expect(
      requestExistingPartner({
        sellerAccountId: sellerB,
        actor: ACTOR,
        fulfilmentMethodId: methodId,
        logisticsPartnerId: partnerId,
      }),
    ).rejects.toMatchObject({ code: 'SELLER_LOGISTICS_PARTNER_NOT_YOURS' });
  });
});

describe('inviting a delivery company that is not here yet', () => {
  let invitationId = '';
  let rawToken = '';
  let methodId = '';

  it('creates an invitation and no company', async () => {
    methodId = await methodFor(sellerA, 'DEDICATED_PARTNER');

    const before = await prisma.logisticsPartner.count({
      where: { displayName: { contains: `${MARK} Courier` } },
    });

    const invitation = await inviteDedicatedPartner({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      proposedLegalName: 'Courier Partner Ltd',
      proposedDisplayName: `${MARK} Courier`,
      businessEmail: `hello.${MARK}@courier.test`,
      countryCode: 'IN',
      expectedServiceCountries: ['IN'],
      requiredCapabilities: ['COLD_CHAIN_2_8'],
    });

    invitationId = invitation.invitationId;
    rawToken = invitation.rawToken;

    const after = await prisma.logisticsPartner.count({
      where: { displayName: { contains: `${MARK} Courier` } },
    });

    // A seller describing a courier must not bring one into existence.
    expect(after).toBe(before);
  });

  it('stores only a digest of the token', async () => {
    const row = await prisma.sellerLogisticsPartnerInvitation.findUniqueOrThrow({
      where: { id: invitationId },
    });

    expect(row.tokenHash).toBe(sha256Hex(rawToken));
    expect(row.tokenHash).not.toBe(rawToken);
    // Nothing anywhere on the row is the token itself.
    expect(JSON.stringify(row)).not.toContain(rawToken);
  });

  it('refuses a second outstanding invitation to the same address', async () => {
    // Two tokens to one address means the first stops working the moment the
    // second is redeemed, and whoever clicked the older link is told their
    // invitation is invalid - which reads as the marketplace being broken.
    await expect(
      inviteDedicatedPartner({
        sellerAccountId: sellerA,
        actor: ACTOR,
        fulfilmentMethodId: methodId,
        proposedLegalName: 'Courier Partner Ltd',
        proposedDisplayName: `${MARK} Courier Again`,
        businessEmail: `hello.${MARK}@courier.test`,
        countryCode: 'IN',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('tells the invited company who is asking, and nothing more', async () => {
    const described = await describePartnerInvitation(rawToken);

    expect(described.sellerDisplayName).toBe('Org Owner Co');
    expect(described.requiredCapabilities).toEqual(['COLD_CHAIN_2_8']);
    // The holder of this link has agreed to nothing and may be the wrong
    // person. They learn the seller's trading name and no more about them.
    expect(JSON.stringify(described)).not.toContain(sellerA);
  });

  it('creates the company and the arrangement when the company accepts', async () => {
    const organisation = await acceptPartnerInvitation({
      rawToken,
      contactName: 'Courier Owner',
      contactEmail: `owner.${MARK}@courier.test`,
    });

    const partner = await prisma.logisticsPartner.findUniqueOrThrow({
      where: { id: organisation.logisticsPartnerId },
    });

    expect(partner.partnerKind).toBe('SELLER_DEDICATED');
    // Exclusive to the seller who introduced them, which is what keeps them
    // off every other seller's picker.
    expect(partner.ownerSellerAccountId).toBe(sellerA);

    const link = await prisma.sellerLogisticsPartner.findFirstOrThrow({
      where: { sellerAccountId: sellerA, logisticsPartnerId: partner.id },
    });

    // REQUESTED, not APPROVED: the company has agreed, and the marketplace is
    // the third party that has not.
    expect(link.status).toBe('REQUESTED');
    expect(link.invitationId).toBe(invitationId);
  });

  it('records both halves of what happened', async () => {
    const link = await prisma.sellerLogisticsPartner.findFirstOrThrow({
      where: { sellerAccountId: sellerA, invitationId },
      select: { id: true },
    });

    const history = await readRelationshipHistory(sellerA, link.id);

    // A history showing only the acceptance could not answer "did they ever
    // actually agree?" - which is the question a dispute asks.
    expect(history.map((row) => row.toStatus)).toEqual(['INVITED', 'REQUESTED']);
    expect(history[0]?.actorLabel).toBe('Org Owner Co');
  });

  it('cannot be redeemed twice', async () => {
    await expect(
      acceptPartnerInvitation({
        rawToken,
        contactName: 'Somebody Else',
        contactEmail: `second.${MARK}@courier.test`,
      }),
    ).rejects.toMatchObject({ code: 'SELLER_PARTNER_INVITATION_INVALID' });
  });

  it('gives one refusal for every kind of bad token', async () => {
    // Unknown, spent, withdrawn and expired share a message. Telling them
    // apart tells somebody probing which addresses have been invited.
    await expect(describePartnerInvitation('not-a-real-token-at-all')).rejects.toMatchObject({
      code: 'SELLER_PARTNER_INVITATION_INVALID',
    });
  });

  it('lets a seller withdraw one nobody took up', async () => {
    const pending = await inviteDedicatedPartner({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      proposedLegalName: 'Withdrawn Ltd',
      proposedDisplayName: `${MARK} Withdrawn`,
      businessEmail: `withdraw.${MARK}@courier.test`,
      countryCode: 'IN',
    });

    await revokePartnerInvitation({
      sellerAccountId: sellerA,
      actor: ACTOR,
      invitationId: pending.invitationId,
    });

    await expect(describePartnerInvitation(pending.rawToken)).rejects.toMatchObject({
      code: 'SELLER_PARTNER_INVITATION_INVALID',
    });
  });

  it('will not let another seller withdraw it', async () => {
    const mine = await inviteDedicatedPartner({
      sellerAccountId: sellerA,
      actor: ACTOR,
      fulfilmentMethodId: methodId,
      proposedLegalName: 'Not Yours Ltd',
      proposedDisplayName: `${MARK} Not Yours`,
      businessEmail: `notyours.${MARK}@courier.test`,
      countryCode: 'IN',
    });

    await expect(
      revokePartnerInvitation({
        sellerAccountId: sellerB,
        actor: ACTOR,
        invitationId: mine.invitationId,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('moving an arrangement', () => {
  let linkId = '';

  beforeAll(async () => {
    const link = await prisma.sellerLogisticsPartner.findFirstOrThrow({
      where: { sellerAccountId: sellerA, status: 'REQUESTED' },
      select: { id: true },
    });

    linkId = link.id;
  });

  it('refuses a move the state machine does not define', async () => {
    await expect(
      transitionRelationship({
        sellerLogisticsPartnerId: linkId,
        toStatus: 'INVITED',
        reason: null,
        actorLabel: 'Marketplace',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('demands a reason for a refusal', async () => {
    await expect(
      transitionRelationship({
        sellerLogisticsPartnerId: linkId,
        toStatus: 'REJECTED',
        reason: '   ',
        actorLabel: 'Marketplace',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('records the approval with who and when', async () => {
    await transitionRelationship({
      sellerLogisticsPartnerId: linkId,
      toStatus: 'APPROVED',
      reason: null,
      actorLabel: 'Marketplace',
    });

    const history = await readRelationshipHistory(sellerA, linkId);
    const last = history[history.length - 1];

    expect(last?.toStatus).toBe('APPROVED');
    expect(last?.fromStatus).toBe('REQUESTED');
    expect(last?.actorLabel).toBe('Marketplace');
  });

  it('lets a suspended arrangement be restored, with the trail intact', async () => {
    await transitionRelationship({
      sellerLogisticsPartnerId: linkId,
      toStatus: 'SUSPENDED',
      reason: 'Licence lapsed.',
      actorLabel: 'Marketplace',
    });

    await transitionRelationship({
      sellerLogisticsPartnerId: linkId,
      toStatus: 'APPROVED',
      reason: null,
      actorLabel: 'Marketplace',
    });

    const history = await readRelationshipHistory(sellerA, linkId);

    // Append-only: restoring does not erase the suspension, which is the
    // whole reason this table is not a status column with a timestamp.
    expect(history.map((row) => row.toStatus)).toEqual([
      'INVITED',
      'REQUESTED',
      'APPROVED',
      'SUSPENDED',
      'APPROVED',
    ]);
    expect(history.find((row) => row.toStatus === 'SUSPENDED')?.reason).toBe('Licence lapsed.');
  });

  it('will not show another seller the history', async () => {
    await expect(readRelationshipHistory(sellerB, linkId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
