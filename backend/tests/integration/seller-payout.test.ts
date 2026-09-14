/**
 * What this deployment can honestly say about a seller's money.
 *
 * There is no payout provider configured here and no bank-verification
 * provider at all, and the brief is explicit that this must not be papered
 * over: no fake success state, no simulated verification. So the tests that
 * matter are the ones that would pass just as well if somebody quietly added
 * a happy path — and fail the moment they did.
 *
 *   - **The refusal is a refusal**, with the code and the missing setting
 *     named, rather than an onboarding link to nowhere.
 *   - **Nothing claims an account exists.** `payoutsEnabled` is false, the
 *     bank fields are empty, and the state is `PROVIDER_UNCONFIGURED` rather
 *     than the reassuring `NOT_STARTED`.
 *   - **No money can be sent**, however the caller reaches for it.
 *   - **Where the money goes is finance's business.** The answer carries the
 *     bank's name and the last four digits of the account, so it is behind
 *     `FINANCE_READ` — not `ACCOUNT_READ`, which every role in the building
 *     holds, including a support member answering buyers.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SellerRole, permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import {
  assertPayable,
  createPayout,
  readPayoutAccount,
  startPayoutOnboarding,
} from '../../src/modules/seller/payout.service.js';

const SLUG = 'payout-north';

let sellerId = '';

function membershipFor(role: keyof typeof SellerRole): SellerMembership {
  return {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Payout North',
    legalName: 'Payout North Ltd',
    slug: SLUG,
    status: 'APPROVED',
    role: SellerRole[role],
    permissions: permissionsForSellerRole(SellerRole[role]),
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'IN',
  };
}

async function cleanUp(): Promise<void> {
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerPayoutAccountReference.deleteMany({
    where: { sellerAccount: { slug: SLUG } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
}

beforeAll(async () => {
  await cleanUp();

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: 'Payout North Ltd',
      displayName: 'Payout North',
      displayNameNormalized: 'payout north',
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

describe('with no payout provider configured', () => {
  it('says so, rather than saying the seller has not got round to it', async () => {
    const account = await readPayoutAccount(membershipFor('OWNER'));

    expect(account.state).toBe('PROVIDER_UNCONFIGURED');
    expect(account.isProviderConfigured).toBe(false);
    // The operator is told which setting is missing. "Payouts are unavailable"
    // with no next step is a support ticket.
    expect(account.missingConfigurationKey).toBe('STRIPE_CONNECT_CLIENT_ID');
    expect(account.pendingRequirements).toHaveLength(1);
  });

  it('claims no account and no bank', async () => {
    const account = await readPayoutAccount(membershipFor('OWNER'));

    expect(account.payoutsEnabled).toBe(false);
    expect(account.providerAccountId).toBeNull();
    expect(account.bankName).toBeNull();
    expect(account.accountLast4).toBeNull();
  });

  it('refuses to start onboarding, naming the setting', async () => {
    await expect(
      startPayoutOnboarding(membershipFor('OWNER'), {
        returnUrl: 'https://example.test/return',
        refreshUrl: 'https://example.test/refresh',
      }),
    ).rejects.toMatchObject({ code: 'SELLER_PAYOUT_PROVIDER_UNCONFIGURED' });
  });

  it('refuses to pay anybody, by either route', async () => {
    await expect(assertPayable(sellerId)).rejects.toMatchObject({
      code: 'SELLER_PAYOUT_PROVIDER_UNCONFIGURED',
    });

    // Even handed a settlement id, which is the call that would move money.
    await expect(createPayout(sellerId, newId(), 'PO-TEST-1')).rejects.toMatchObject({
      code: 'SELLER_PAYOUT_PROVIDER_UNCONFIGURED',
    });

    expect(await prisma.sellerPayout.count({ where: { sellerAccountId: sellerId } })).toBe(0);
  });
});

describe('who may see where the money goes', () => {
  it('lets the roles that run the money read it', async () => {
    for (const role of ['OWNER', 'ADMIN', 'FINANCE_VIEWER'] as const) {
      const account = await readPayoutAccount(membershipFor(role));
      expect(account.state).toBe('PROVIDER_UNCONFIGURED');
    }
  });

  it('refuses everybody else, including the roles that read orders all day', async () => {
    for (const role of [
      'SUPPORT_MEMBER',
      'CATALOGUE_MANAGER',
      'INVENTORY_MANAGER',
      'ORDER_MANAGER',
    ] as const) {
      await expect(readPayoutAccount(membershipFor(role))).rejects.toMatchObject({
        code: 'SELLER_ROLE_DENIED',
      });
    }
  });
});
