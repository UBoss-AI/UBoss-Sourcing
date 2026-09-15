/**
 * The Seller Hub's second password, end to end.
 *
 * Selling shares the account somebody buys with, so the only thing separating
 * "signed in to the shop" from "may reprice a catalogue" is this lock. That
 * makes it worth a test that walks the whole path rather than one that checks a
 * hash was written: choose a password, find the Hub still shut in a second
 * browser, open it in the first, and confirm that changing it shuts every
 * other browser.
 *
 * The sessions here are real `Session` rows rather than HTTP cookies. What is
 * under test is the rule, not the cookie machinery — and building two signed-in
 * browsers over the login route would make this a test of sign-in that happens
 * to set a seller password.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { hashPassword, sha256Hex } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  assertSellerUnlocked,
  lockSeller,
  setSellerLock,
  unlockSeller,
} from '../../src/modules/seller/lock.service.js';

const EMAIL = 'owner@lock-test-seller.test';
const SLUG = 'lock-test-seller';

const SHOP_PASSWORD = 'ShopPassword!2026';
const HUB_PASSWORD = 'HubPassword!2026';
const NEW_HUB_PASSWORD = 'HubPasswordTwo!2026';

let userId = '';
let sellerId = '';
let memberId = '';
/** The browser the seller is working in. */
let thisSession = '';
/** A second browser they are also signed in on. */
let otherSession = '';

function membershipOf(hasLock: boolean): SellerMembership {
  return {
    sellerAccountId: sellerId,
    memberId,
    customerProfileId: 'unused-in-this-test',
    displayName: 'Lock Test',
    legalName: 'Lock Test Ltd',
    slug: SLUG,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
    logoStorageKey: null,
  };
}

/** The session row as the guard reads it. */
async function sessionState(
  id: string,
): Promise<{ sellerUnlockedAt: Date | null; sellerUnlockedForId: string | null }> {
  const row = await prisma.session.findUniqueOrThrow({
    where: { id },
    select: { sellerUnlockedAt: true, sellerUnlockedForId: true },
  });

  return row;
}

async function cleanUp(): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { emailNormalized: EMAIL },
    select: { id: true, customerProfile: { select: { id: true } } },
  });

  await prisma.auditLog.deleteMany({ where: { actorUserId: user?.id ?? '' } });
  await prisma.session.deleteMany({ where: { userId: user?.id ?? '' } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
  await prisma.customerProfile.deleteMany({ where: { userId: user?.id ?? '' } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

async function newSession(): Promise<string> {
  const id = newId();

  await prisma.session.create({
    data: {
      id,
      userId,
      refreshTokenHash: sha256Hex(id),
      familyId: newId(),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  return id;
}

beforeAll(async () => {
  await cleanUp();

  userId = newId();

  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(SHOP_PASSWORD),
      status: 'ACTIVE',
    },
  });

  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Lock Test Owner' },
  });

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      slug: SLUG,
      displayName: 'Lock Test',
      displayNameNormalized: 'lock test',
      legalName: 'Lock Test Ltd',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });

  sellerId = seller.id;
  memberId = newId();

  await prisma.sellerMember.create({
    data: { id: memberId, sellerAccountId: sellerId, customerProfileId: profile.id, role: 'OWNER' },
  });

  thisSession = await newSession();
  otherSession = await newSession();
});

afterAll(async () => {
  await cleanUp();
});

describe('the Seller Hub lock', () => {
  it('refuses the Hub before a password has been chosen', () => {
    expect(() => {
      assertSellerUnlocked(membershipOf(false), {
        sellerUnlockedAt: null,
        sellerUnlockedForId: null,
      });
    }).toThrow(/Choose a Seller Hub password/);
  });

  it('refuses the shop password as the Hub password', async () => {
    // Two identical secrets are one secret with two prompts, and a seller who
    // reuses it has the separation they were promised in name only.
    await expect(
      setSellerLock(membershipOf(false), thisSession, userId, { newPassword: SHOP_PASSWORD }),
    ).rejects.toThrow(/different password/);
  });

  it('opens the Hub for the browser that chose the password, and no other', async () => {
    const state = await setSellerLock(membershipOf(false), thisSession, userId, {
      newPassword: HUB_PASSWORD,
    });

    expect(state).toEqual({ isSet: true, isOpen: true });

    // The browser that set it walks straight in - being asked for a password
    // one keystroke after choosing it is how somebody concludes it did not save.
    const here = await sessionState(thisSession);

    expect(() => {
      assertSellerUnlocked(membershipOf(true), here);
    }).not.toThrow();

    // The other browser is asked. That is the whole point of a lock.
    const there = await sessionState(otherSession);

    expect(() => {
      assertSellerUnlocked(membershipOf(true), there);
    }).toThrow(/Enter your Seller Hub password/);
  });

  it('refuses a wrong password and opens on the right one', async () => {
    await expect(
      unlockSeller(membershipOf(true), otherSession, userId, 'not the password'),
    ).rejects.toThrow(/not right/);

    await unlockSeller(membershipOf(true), otherSession, userId, HUB_PASSWORD);

    expect((await sessionState(otherSession)).sellerUnlockedForId).toBe(sellerId);
  });

  it('never unlocks a different seller with the same session', () => {
    // The session carries WHICH seller it opened. A person selling for two
    // businesses who opens one must still be asked for the other.
    const someoneElse = { ...membershipOf(true), sellerAccountId: newId() };

    expect(() => {
      assertSellerUnlocked(someoneElse, {
        sellerUnlockedAt: new Date(),
        sellerUnlockedForId: sellerId,
      });
    }).toThrow(/Enter your Seller Hub password/);
  });

  it('shuts every other browser when the password is changed', async () => {
    await setSellerLock(membershipOf(true), thisSession, userId, {
      currentPassword: HUB_PASSWORD,
      newPassword: NEW_HUB_PASSWORD,
    });

    // The browser that made the change stays in; every other one is asked
    // again, because "I think somebody knows it" is why people change a
    // password.
    expect((await sessionState(thisSession)).sellerUnlockedForId).toBe(sellerId);
    expect((await sessionState(otherSession)).sellerUnlockedAt).toBeNull();

    // And the shop sign-in is untouched: they keep their basket.
    const other = await prisma.session.findUniqueOrThrow({
      where: { id: otherSession },
      select: { revokedAt: true },
    });

    expect(other.revokedAt).toBeNull();
  });

  it('demands the current password before changing it', async () => {
    await expect(
      setSellerLock(membershipOf(true), thisSession, userId, {
        currentPassword: HUB_PASSWORD,
        newPassword: 'SomethingElse!2026',
      }),
    ).rejects.toThrow(/current Seller Hub password/);
  });

  it('shuts the Hub without touching the shop session', async () => {
    await lockSeller(thisSession);

    const state = await sessionState(thisSession);

    expect(state.sellerUnlockedAt).toBeNull();
    expect(state.sellerUnlockedForId).toBeNull();

    const session = await prisma.session.findUniqueOrThrow({
      where: { id: thisSession },
      select: { revokedAt: true },
    });

    expect(session.revokedAt).toBeNull();
  });
});
