/**
 * Setting what the marketplace keeps, per seller and as a standard.
 *
 * The rate is a commercial term, and the three things that make it one are the
 * three this file holds to.
 *
 *   - **Null is not zero.** Null means "whatever the marketplace charges" and
 *     follows the standard rate when it moves; zero is a decision to take
 *     nothing from this seller and stays at nothing. Collapsing them would
 *     re-rate every seller the day somebody set a standard rate.
 *   - **Nothing already sold moves.** The rate in force is copied onto each
 *     seller order group at confirmation, and changing a rate afterwards must
 *     not reach back through it.
 *   - **The seller is told.** A change to what a business is charged that
 *     arrives only as a smaller number on next month's statement is how a
 *     commercial relationship ends.
 *
 * The range is checked in both places on purpose: a rate above 100% would mean
 * the marketplace keeps more than the sale was worth and the seller owes money
 * for having sold something.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { setSellerCommission } from '../../src/modules/seller/moderation.service.js';
import { commissionBasisPointsFor } from '../../src/modules/seller/order-split.service.js';
import { updateBusinessProfile } from '../../src/modules/settings/settings.service.js';

const SLUG = 'commission-north';
const ADMIN_EMAIL = 'commission-admin@test.local';

let sellerId = '';
let adminUserId = '';

async function cleanUp(): Promise<void> {
  await prisma.sellerNotification.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.auditLog.deleteMany({ where: { resourceType: 'seller_account' } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
  await prisma.user.deleteMany({ where: { emailNormalized: ADMIN_EMAIL } });
}

async function rateOf(): Promise<number | null> {
  const account = await prisma.sellerAccount.findUniqueOrThrow({
    where: { id: sellerId },
    select: { commissionBasisPoints: true },
  });

  return account.commissionBasisPoints;
}

beforeAll(async () => {
  await cleanUp();

  const admin = await prisma.user.create({
    data: {
      id: newId(),
      email: ADMIN_EMAIL,
      emailNormalized: ADMIN_EMAIL,
      passwordHash: 'x',
      type: 'ADMIN',
      status: 'ACTIVE',
    },
  });
  adminUserId = admin.id;

  const existing = await prisma.businessProfile.findFirst({ select: { id: true } });

  if (existing === null) {
    await prisma.businessProfile.create({
      data: {
        id: newId(),
        legalName: 'Commission Test Operator',
        displayName: 'Commission Test',
        supportEmail: 'support@test.local',
        currency: 'INR',
        timezone: 'Asia/Kolkata',
        sellerCommissionBasisPoints: 500,
      },
    });
  } else {
    await prisma.businessProfile.update({
      where: { id: existing.id },
      data: { sellerCommissionBasisPoints: 500 },
    });
  }
});

beforeEach(async () => {
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Commission North Ltd',
      displayName: 'Commission North',
      displayNameNormalized: 'commission north',
      slug: SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  sellerId = seller.id;
});

afterAll(async () => {
  await cleanUp();
});

describe('setSellerCommission', () => {
  it('puts a seller on their own rate and tells them', async () => {
    await setSellerCommission({ sellerAccountId: sellerId, basisPoints: 250, adminUserId });

    expect(await rateOf()).toBe(250);

    const notification = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: sellerId },
      orderBy: { createdAt: 'desc' },
      select: { title: true, body: true },
    });

    expect(notification.title).toBe('Your commission rate has changed');
    // The figure, in the words the contract uses, and what it does not touch.
    expect(notification.body).toContain('2.50%');
    expect(notification.body).toContain('Orders already placed keep the rate');
  });

  it('records it on both trails, and names the operator as a role', async () => {
    await setSellerCommission({ sellerAccountId: sellerId, basisPoints: 250, adminUserId });

    const sellerEntry = await prisma.sellerAuditLog.findFirstOrThrow({
      where: { sellerAccountId: sellerId, action: 'seller.commission.changed' },
      select: { actorLabel: true, beforeJson: true, afterJson: true },
    });

    // Never a member of staff's name: a seller does not need to know which
    // individual set their rate, and telling them invites a conversation
    // round the process.
    expect(sellerEntry.actorLabel).toBe('Marketplace moderation');
    expect(sellerEntry.beforeJson).toEqual({ commissionBasisPoints: null });
    expect(sellerEntry.afterJson).toEqual({ commissionBasisPoints: 250 });

    const operatorEntry = await prisma.auditLog.findFirstOrThrow({
      where: { resourceType: 'seller_account', resourceId: sellerId },
      select: { actorUserId: true, afterJson: true },
    });

    // The operator's own log does carry the person, because that is the trail
    // that answers "who changed this".
    expect(operatorEntry.actorUserId).toBe(adminUserId);
    expect(operatorEntry.afterJson).toEqual({ commissionBasisPoints: 250 });
  });

  it('tells a seller put back on the standard rate what that rate is', async () => {
    await setSellerCommission({ sellerAccountId: sellerId, basisPoints: 250, adminUserId });
    await setSellerCommission({ sellerAccountId: sellerId, basisPoints: null, adminUserId });

    expect(await rateOf()).toBeNull();

    const notification = await prisma.sellerNotification.findFirstOrThrow({
      where: { sellerAccountId: sellerId },
      orderBy: { createdAt: 'desc' },
      select: { body: true },
    });

    // "You are back on the standard rate" without the figure is half an
    // answer, and the seller would have to ask what it is.
    expect(notification.body).toContain('5.00%');
  });

  it('keeps zero and null apart', async () => {
    await setSellerCommission({ sellerAccountId: sellerId, basisPoints: 0, adminUserId });

    expect(await rateOf()).toBe(0);

    // Zero is a promise to take nothing from this seller, so it survives the
    // marketplace charging everybody else more.
    expect(commissionBasisPointsFor(0, 500)).toBe(0);
    expect(commissionBasisPointsFor(null, 500)).toBe(500);
  });

  it('refuses a rate above the whole sale', async () => {
    await expect(
      setSellerCommission({ sellerAccountId: sellerId, basisPoints: 10_001, adminUserId }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await expect(
      setSellerCommission({ sellerAccountId: sellerId, basisPoints: -1, adminUserId }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    expect(await rateOf()).toBeNull();
  });

  it('says nothing when the rate has not actually changed', async () => {
    await setSellerCommission({ sellerAccountId: sellerId, basisPoints: null, adminUserId });

    // Already on the standard rate, so there is nothing to tell anybody. A
    // notification per save would train a seller to ignore them.
    const notifications = await prisma.sellerNotification.count({
      where: { sellerAccountId: sellerId },
    });

    expect(notifications).toBe(0);
  });
});

describe('the standard rate', () => {
  const actor = (): { userId: string; email: string; permissions: string[] } => ({
    userId: adminUserId,
    email: ADMIN_EMAIL,
    permissions: [],
  });

  it('is saved in basis points', async () => {
    await updateBusinessProfile({ sellerCommissionBasisPoints: 750 }, actor());

    const profile = await prisma.businessProfile.findFirstOrThrow({
      select: { sellerCommissionBasisPoints: true },
    });

    expect(profile.sellerCommissionBasisPoints).toBe(750);

    await updateBusinessProfile({ sellerCommissionBasisPoints: 500 }, actor());
  });

  it('refuses more than the whole sale rather than clamping it', async () => {
    await expect(
      updateBusinessProfile({ sellerCommissionBasisPoints: 20_000 }, actor()),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    const profile = await prisma.businessProfile.findFirstOrThrow({
      select: { sellerCommissionBasisPoints: true },
    });

    // Unchanged: a typed 200% is a mistake to be shown, not a rate to be
    // rounded down to something nobody meant either.
    expect(profile.sellerCommissionBasisPoints).toBe(500);
  });
});
