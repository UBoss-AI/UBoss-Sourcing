/**
 * A carrier's activation link has to actually work.
 *
 * This file exists because it did not. An invitation minted one token for the
 * email and a *different* one for the credential row the activation endpoint
 * reads, so every carrier invitation this product has ever sent was a dead
 * link: the first, unused click answered "This link is not valid", the account
 * stayed `PENDING_INVITATION`, and nobody could sign in to the portal at all.
 * Nothing caught it because the development seed writes its carrier logins
 * directly and never walks this path.
 *
 * So the assertion is deliberately end to end and deliberately blunt: take the
 * token the invitation hands back, redeem it exactly as the activation route
 * does, and require an account that can sign in at the end of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { sha256Hex } from '../../src/infra/crypto.js';
import { prisma } from '../../src/infra/prisma.js';
import { acceptInvitation } from '../../src/modules/identity/token.service.js';
import {
  inviteLogisticsUser,
  markInvitationAccepted,
} from '../../src/modules/logistics/partner.service.js';

const PARTNER_CODE = 'LP-TEST-INVITE';
const OWNER_EMAIL = 'owner@invite-test-carrier.test';
const SECOND_EMAIL = 'dispatcher@invite-test-carrier.test';

let partnerId = '';

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({
      where: { emailNormalized: { in: [OWNER_EMAIL, SECOND_EMAIL] } },
      select: { id: true },
    })
  ).map((row) => row.id);

  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.logisticsAuditLog.deleteMany({
    where: { partner: { partnerCode: PARTNER_CODE } },
  });
  await prisma.logisticsPartnerInvitation.deleteMany({
    where: { partner: { partnerCode: PARTNER_CODE } },
  });
  await prisma.logisticsPartnerUser.deleteMany({
    where: { partner: { partnerCode: PARTNER_CODE } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { partnerCode: PARTNER_CODE } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  await cleanUp();

  const partner = await prisma.logisticsPartner.create({
    data: {
      id: newId(),
      partnerCode: PARTNER_CODE,
      legalName: 'Invite Test Carriage Ltd',
      displayName: 'Invite Test Carriage',
      displayNameNormalized: 'invite test carriage',
      registrationCountry: 'IE',
      contactEmail: 'ops@invite-test-carrier.test',
      status: 'PENDING_ACTIVATION',
    },
  });

  partnerId = partner.id;
});

afterAll(async () => {
  await cleanUp();
});

describe('a carrier invitation', () => {
  it('hands back a token that the activation path accepts', async () => {
    const invited = await inviteLogisticsUser({
      logisticsPartnerId: partnerId,
      email: OWNER_EMAIL,
      fullName: 'Aoife Byrne',
      role: 'LOGISTICS_PARTNER_OWNER',
      invitedByPartnerUserId: null,
      invitedByAdminUserId: null,
      actorLabel: 'Marketplace operations',
    });

    expect(invited.token.length).toBeGreaterThan(20);

    // Exactly what the route does. A failure here is a dead link in somebody's
    // inbox, which is the whole point of the file.
    const consumed = await acceptInvitation({
      token: invited.token,
      password: 'CarrierActivate!2026',
      acceptedTerms: true,
      consentVersion: 'test',
    });

    expect(consumed.userType).toBe('LOGISTICS');
    expect(consumed.email).toBe(OWNER_EMAIL);

    await markInvitationAccepted(consumed.userId);

    const user = await prisma.user.findUnique({
      where: { id: consumed.userId },
      select: { status: true, passwordHash: true },
    });

    expect(user?.status).toBe('ACTIVE');
    expect(user?.passwordHash).not.toBeNull();

    const member = await prisma.logisticsPartnerUser.findUnique({
      where: { userId: consumed.userId },
      select: { status: true },
    });

    expect(member?.status).toBe('ACTIVE');
  });

  it('records the same token on the credential and on the business record', async () => {
    /*
     * The two rows are not redundant - one is the credential, one is the
     * record of who was asked and by whom - but they must describe the SAME
     * link. Two hashes drifting apart is exactly how the original bug read at
     * the database: both rows present, both plausible, neither redeemable.
     */
    const invited = await inviteLogisticsUser({
      logisticsPartnerId: partnerId,
      email: SECOND_EMAIL,
      fullName: 'Cormac Walsh',
      role: 'DISPATCHER',
      invitedByPartnerUserId: null,
      invitedByAdminUserId: null,
      actorLabel: 'Marketplace operations',
    });

    const hash = sha256Hex(invited.token);

    const credential = await prisma.authToken.findUnique({
      where: { tokenHash: hash },
      select: { type: true, consumedAt: true, expiresAt: true },
    });

    expect(credential).not.toBeNull();
    expect(credential?.type).toBe('INVITATION');
    expect(credential?.consumedAt).toBeNull();

    const record = await prisma.logisticsPartnerInvitation.findFirst({
      where: { emailNormalized: SECOND_EMAIL },
      select: { tokenHash: true, expiresAt: true },
    });

    expect(record?.tokenHash).toBe(hash);
    // The seller reads "your link expires on ..." from the business record, so
    // the two dates have to be the same date.
    expect(record?.expiresAt.toISOString()).toBe(credential?.expiresAt.toISOString());
  });

  it('refuses the same link twice', async () => {
    const invited = await inviteLogisticsUser({
      logisticsPartnerId: partnerId,
      email: 'third@invite-test-carrier.test',
      fullName: 'Niamh Doyle',
      role: 'DISPATCHER',
      invitedByPartnerUserId: null,
      invitedByAdminUserId: null,
      actorLabel: 'Marketplace operations',
    });

    await acceptInvitation({
      token: invited.token,
      password: 'CarrierActivate!2026',
      acceptedTerms: true,
      consentVersion: 'test',
    });

    await expect(
      acceptInvitation({
        token: invited.token,
        password: 'CarrierActivate!2026',
        acceptedTerms: true,
        consentVersion: 'test',
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_ALREADY_USED' });

    const user = await prisma.user.findFirst({
      where: { emailNormalized: 'third@invite-test-carrier.test' },
      select: { id: true },
    });

    if (user !== null) {
      await prisma.authToken.deleteMany({ where: { userId: user.id } });
      await prisma.logisticsPartnerInvitation.deleteMany({
        where: { emailNormalized: 'third@invite-test-carrier.test' },
      });
      await prisma.logisticsPartnerUser.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  });
});
