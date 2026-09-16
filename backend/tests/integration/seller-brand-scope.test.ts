/**
 * Whose brands a seller can see, and what they can do about the rest.
 *
 * The distinction this file exists to hold in place: a BRAND is
 * marketplace-wide, and PERMISSION TO SELL ONE is per company. Those two facts
 * pull in opposite directions and a change to either one quietly breaks the
 * other, which is why they are asserted together.
 *
 * What each case is really checking:
 *
 *   - A seller's picker shows the brands THEY are approved for, and nobody
 *     else's - including brands the marketplace has approved for a competitor.
 *   - Their own undecided request is visible to them, so they can attach it to
 *     a draft and carry on while they wait.
 *   - A brand that exists is still requestable by a second seller, attached to
 *     the SAME brand row, so the catalogue never grows two "B. Braun"s.
 *   - Asking twice is refused, and so is asking for one already approved for
 *     you - both with a message that says which.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/domain/errors.js';
import { permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  isBrandApprovedForSeller,
  requestBrand,
  searchBrands,
} from '../../src/modules/seller/brand.service.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';

let acmeId = '';
let rivalId = '';
let acme: SellerMembership;
let rival: SellerMembership;

async function makeSeller(slug: string, displayName: string): Promise<string> {
  const id = newId();

  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${displayName} Ltd`,
      displayName,
      displayNameNormalized: displayName.toLowerCase(),
      slug,
      kind: 'AUTHORISED_DISTRIBUTOR',
      registrationCountry: 'DE',
      status: 'APPROVED',
    },
  });

  return id;
}

function membershipFor(accountId: string, displayName: string, slug: string): SellerMembership {
  return {
    sellerAccountId: accountId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName,
    legalName: `${displayName} Ltd`,
    slug,
    status: 'APPROVED',
    role: 'OWNER',
    permissions: permissionsForSellerRole('OWNER'),
    hasLock: false,
    isTrading: true,
    isApplicationEditable: false,
    registrationCountry: 'DE',
    logoStorageKey: null,
  };
}

/** An approved brand, and one seller's approved request for it. */
async function approveBrandFor(name: string, sellerAccountId: string): Promise<string> {
  const brandId = newId();
  const normalised = name.toLowerCase().replace(/[^a-z0-9]+/g, '');

  await prisma.brand.create({
    data: { id: brandId, name, nameNormalized: normalised, slug: normalised, status: 'APPROVED' },
  });

  await prisma.brandRequest.create({
    data: {
      id: newId(),
      sellerAccountId,
      brandId,
      requestedName: name,
      status: 'APPROVED',
      decidedAt: new Date(),
    },
  });

  return brandId;
}

async function cleanUp(): Promise<void> {
  await prisma.sellerOffer.deleteMany({ where: { sellerAccount: { slug: { startsWith: 'scope-' } } } });
  await prisma.brandRequest.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'scope-' } } },
  });
  await prisma.brand.deleteMany({ where: { slug: { in: ['aesculap', 'kimberlite', 'novafix'] } } });
  await prisma.sellerAuditLog.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'scope-' } } },
  });
  await prisma.sellerAccount.deleteMany({ where: { slug: { startsWith: 'scope-' } } });
}

beforeAll(async () => {
  await cleanUp();

  acmeId = await makeSeller('scope-acme', 'Scope Acme');
  rivalId = await makeSeller('scope-rival', 'Scope Rival');

  acme = membershipFor(acmeId, 'Scope Acme', 'scope-acme');
  rival = membershipFor(rivalId, 'Scope Rival', 'scope-rival');
});

beforeEach(async () => {
  await prisma.brandRequest.deleteMany({
    where: { sellerAccount: { slug: { startsWith: 'scope-' } } },
  });
  await prisma.brand.deleteMany({ where: { slug: { in: ['aesculap', 'kimberlite', 'novafix'] } } });
});

afterAll(async () => {
  await cleanUp();
});

describe('searchBrands', () => {
  it('shows a seller the brands they are approved for', async () => {
    await approveBrandFor('Aesculap', acmeId);

    const mine = await searchBrands(acme, '');
    expect(mine.map((brand) => brand.name)).toEqual(['Aesculap']);
  });

  it('hides a brand approved for somebody else, even though it is in the catalogue', async () => {
    await approveBrandFor('Aesculap', acmeId);

    // The brand row is APPROVED marketplace-wide. That is a fact about the
    // catalogue and says nothing about whether this business may sell it - and
    // a dropdown that offered it would read as permission.
    expect(await searchBrands(rival, 'Aes')).toEqual([]);
    expect(await isBrandApprovedForSeller(rivalId, (await approvedBrandId('Aesculap')) ?? '')).toBe(
      false,
    );
  });

  it('shows a seller their own undecided request so they can draft against it', async () => {
    const { brandId } = await requestBrand({
      membership: acme,
      requestedName: 'Kimberlite',
      justification: 'We are the authorised distributor for Benelux.',
    });

    const mine = await searchBrands(acme, 'Kim');
    expect(mine.map((brand) => brand.id)).toEqual([brandId]);
    expect(mine[0]?.status).toBe('PENDING');

    // And nobody else's.
    expect(await searchBrands(rival, 'Kim')).toEqual([]);

    // Visible in the picker is NOT permission to publish under it.
    expect(await isBrandApprovedForSeller(acmeId, brandId)).toBe(false);
  });
});

describe('requestBrand', () => {
  it('lets a second seller ask for a brand that already exists, on the same row', async () => {
    const existingId = await approveBrandFor('Aesculap', acmeId);

    const { brandId } = await requestBrand({
      membership: rival,
      requestedName: 'aesculap',
      justification: 'We hold a distribution agreement for Bavaria.',
    });

    // The SAME brand row. A second row would show buyers "Aesculap" twice and
    // give each one a fraction of the products.
    expect(brandId).toBe(existingId);

    const rows = await prisma.brand.findMany({ where: { nameNormalized: 'aesculap' } });
    expect(rows).toHaveLength(1);
  });

  it('refuses a second ask while the first is undecided', async () => {
    await requestBrand({ membership: acme, requestedName: 'Novafix' });

    await expect(requestBrand({ membership: acme, requestedName: 'Nova fix' })).rejects.toMatchObject(
      { code: ErrorCode.BRAND_ALREADY_EXISTS },
    );
  });

  it('refuses an ask for a brand this seller is already approved for', async () => {
    await approveBrandFor('Aesculap', acmeId);

    await expect(requestBrand({ membership: acme, requestedName: 'Aesculap' })).rejects.toMatchObject(
      { code: ErrorCode.BRAND_ALREADY_EXISTS },
    );
  });
});

async function approvedBrandId(name: string): Promise<string | null> {
  const row = await prisma.brand.findFirst({
    where: { nameNormalized: name.toLowerCase().replace(/[^a-z0-9]+/g, '') },
    select: { id: true },
  });

  return row?.id ?? null;
}
