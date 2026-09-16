/**
 * Two ways the seller application used to lie to the person filling it in.
 *
 * Both were silent, and both left a seller stuck with no way to work out what
 * they had done wrong:
 *
 *   - **Store details could not be finished.** The step needs a description
 *     AND a support email. The form sent every field on every save, with the
 *     untouched ones as `null` - which means "clear this" - so entering the
 *     second wiped the first, the step never reached COMPLETE, and no tick
 *     ever appeared however many times they filled it in.
 *   - **The bookmark moved on every read.** The two standing steps are
 *     re-derived each time the application is read, and the derive wrote
 *     `lastStepKey` as it went. So "carry on where you were" pointed at
 *     whatever the derive touched last rather than at what the seller had
 *     actually been doing - and the screen never opened at the first step.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SellerRole, permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  readOnboarding,
  saveStoreProfile,
} from '../../src/modules/seller/onboarding.service.js';

const SLUG = 'onboarding-steps-co';

let sellerId = '';

function membership(): SellerMembership {
  return {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Onboarding Steps Co',
    legalName: 'Onboarding Steps Co Ltd',
    slug: SLUG,
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
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
}

beforeAll(async () => {
  await cleanUp();

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Onboarding Steps Co Ltd',
      displayName: 'Onboarding Steps Co',
      displayNameNormalized: 'onboarding steps co',
      slug: SLUG,
      kind: 'RESELLER',
      registrationCountry: 'IN',
      status: 'DRAFT',
    },
  });

  sellerId = seller.id;
});

afterAll(async () => {
  await cleanUp();
});

function stepState(steps: { key: string; state: string }[], key: string): string {
  return steps.find((step) => step.key === key)?.state ?? 'MISSING';
}

describe('the store details step', () => {
  it('keeps what was saved before, so filling it in twice finishes it', async () => {
    const seller = membership();

    const first = await saveStoreProfile(seller, {
      description: 'We pack and ship stationery to offices across the north.',
      supportEmail: null,
      supportPhone: null,
    });

    expect(first.state).toBe('IN_PROGRESS');
    expect(first.missing).toEqual(['A support email address']);

    // The second save carries the description back unchanged, the way the form
    // now sends what is on screen rather than a null for every untouched box.
    const second = await saveStoreProfile(seller, {
      description: 'We pack and ship stationery to offices across the north.',
      supportEmail: 'help@onboarding-steps.example',
      supportPhone: null,
    });

    expect(second.missing).toEqual([]);
    expect(second.state).toBe('COMPLETE');

    const view = await readOnboarding(seller);
    expect(stepState(view.steps, 'store_profile')).toBe('COMPLETE');
  });

  it('leaves a field alone when the save does not carry it', async () => {
    const seller = membership();

    await saveStoreProfile(seller, {
      description: 'We pack and ship stationery to offices across the north.',
      supportEmail: 'help@onboarding-steps.example',
    });

    // Only the phone. The two fields the step depends on are not in the patch
    // at all, and an absent field is not an instruction to clear one.
    const result = await saveStoreProfile(seller, { supportPhone: '+91 80 4000 1000' });

    expect(result.state).toBe('COMPLETE');

    const account = await prisma.sellerAccount.findUnique({
      where: { id: sellerId },
      select: { description: true, businessProfile: { select: { supportEmail: true } } },
    });

    expect(account?.description).toBe('We pack and ship stationery to offices across the north.');
    expect(account?.businessProfile?.supportEmail).toBe('help@onboarding-steps.example');
  });

  it('says what is still missing rather than only refusing the tick', async () => {
    const seller = membership();

    const result = await saveStoreProfile(seller, {
      description: null,
      supportEmail: 'help@onboarding-steps.example',
    });

    expect(result.state).toBe('IN_PROGRESS');
    expect(result.missing).toEqual(['A description of your business']);

    const view = await readOnboarding(seller);
    const step = view.steps.find((entry) => entry.key === 'store_profile');
    expect(step?.message).toBe('Still needed: A description of your business.');
  });
});

describe('where the application opens', () => {
  it('does not move the bookmark just because the application was read', async () => {
    const seller = membership();

    await saveStoreProfile(seller, {
      description: 'We pack and ship stationery to offices across the north.',
      supportEmail: 'help@onboarding-steps.example',
    });

    const saved = await readOnboarding(seller);
    expect(saved.lastStepKey).toBe('store_profile');

    // Reading it again is not the seller doing anything.
    const reread = await readOnboarding(seller);
    expect(reread.lastStepKey).toBe('store_profile');
  });

  it('has no bookmark at all for a seller who has not saved a step', async () => {
    const seller = membership();

    await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccountId: sellerId } });

    const view = await readOnboarding(seller);

    // Nothing to resume, so the screen opens where the application begins.
    expect(view.lastStepKey).toBeNull();
    expect(view.steps[0]?.key).toBe('account_verification');
  });
});
