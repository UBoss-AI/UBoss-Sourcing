/**
 * The seller's registered business address, checked on the server.
 *
 * The Seller Hub used to ask for this in one text box and write the whole
 * sentence into `registeredAddressLine1`. It is now six fields, and a form
 * that asks for six fields is a form somebody will bypass — with curl, with a
 * stale bundle, or with an ERP integration that predates the change. So every
 * rule the browser enforces is enforced again here, and these are the ones
 * that matter:
 *
 *   - A country has to be a country THIS DEPLOYMENT knows. `.length(2)` is not
 *     a check: "XX" passes it.
 *   - A postal code is checked against ITS OWN country's rule, and against a
 *     permissive shape check where no rule is known. Applying India's six
 *     digits globally is the single easiest way to make this field unfillable
 *     for most of the world.
 *   - A patch that touches only the postcode is checked against the country
 *     ALREADY STORED, not against nothing.
 *   - A leading zero survives. The whole reason this is a string.
 *   - The old single-line address is never destroyed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../src/domain/errors.js';
import { SellerRole, permissionsForSellerRole } from '../../src/domain/seller-permissions.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import type { SellerMembership } from '../../src/modules/seller/account.service.js';
import { saveBusinessProfile } from '../../src/modules/seller/onboarding.service.js';

const SLUG = 'registered-address-co';

let sellerId = '';

function membership(): SellerMembership {
  return {
    sellerAccountId: sellerId,
    memberId: newId(),
    customerProfileId: newId(),
    displayName: 'Registered Address Co',
    legalName: 'Registered Address Co Ltd',
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

/** The stored profile, or null where none has been written yet. */
async function stored() {
  return prisma.sellerBusinessProfile.findUnique({
    where: { sellerAccountId: sellerId },
    select: {
      registeredAddressLine1: true,
      registeredAddressLine2: true,
      registeredCity: true,
      registeredRegion: true,
      registeredPostcode: true,
      registeredCountry: true,
    },
  });
}

/** Wipe the profile between cases, so each one starts from nothing stored. */
async function clearProfile(): Promise<void> {
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccountId: sellerId } });
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
      legalName: 'Registered Address Co Ltd',
      displayName: 'Registered Address Co',
      displayNameNormalized: 'registered address co',
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

describe('saving a structured registered address', () => {
  it('stores all six fields', async () => {
    await clearProfile();

    await saveBusinessProfile(membership(), {
      registeredAddressLine1: '42 Industrial Estate',
      registeredAddressLine2: 'Phase 2',
      registeredCity: 'Noida',
      registeredRegion: 'Uttar Pradesh (UP)',
      registeredPostcode: '201301',
      registeredCountry: 'IN',
    });

    expect(await stored()).toEqual({
      registeredAddressLine1: '42 Industrial Estate',
      registeredAddressLine2: 'Phase 2',
      registeredCity: 'Noida',
      registeredRegion: 'Uttar Pradesh (UP)',
      registeredPostcode: '201301',
      registeredCountry: 'IN',
    });
  });

  it('keeps a leading zero exactly as it was given', async () => {
    await clearProfile();

    // 01234 is a real ZIP in Massachusetts, and 1234 is somewhere else
    // entirely. This is the whole reason a postal code is a string in every
    // layer of this system.
    await saveBusinessProfile(membership(), {
      registeredPostcode: '01234',
      registeredCountry: 'US',
    });

    expect((await stored())?.registeredPostcode).toBe('01234');
  });

  it('keeps the spaces and hyphens a postal code is written with', async () => {
    await clearProfile();

    await saveBusinessProfile(membership(), {
      registeredPostcode: 'K1A 0B1',
      registeredCountry: 'CA',
    });

    expect((await stored())?.registeredPostcode).toBe('K1A 0B1');
  });
});

describe('the country', () => {
  it('refuses a code this deployment does not know', async () => {
    await clearProfile();

    // "XX" is two letters and passes the schema's `.length(2)`. It is not a
    // country, it did not come from the picker, and the only thing that can
    // tell is the `countries` table.
    await expect(
      saveBusinessProfile(membership(), { registeredCountry: 'XX' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // And nothing was written. The check runs before the upsert precisely so a
    // refused address leaves the stored one untouched.
    expect(await stored()).toBeNull();
  });

  it('names the field it refused, so a form can put the message on it', async () => {
    await clearProfile();

    const error = await saveBusinessProfile(membership(), {
      registeredCountry: 'XX',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).details[0]).toMatchObject({
      field: 'registeredCountry',
      code: 'UNKNOWN_COUNTRY',
    });
  });

  it('accepts a country the deployment serves', async () => {
    await clearProfile();

    // Seeded in every deployment; the test would be meaningless if it were not.
    const india = await prisma.country.findUnique({ where: { code: 'IN' } });
    expect(india).not.toBeNull();

    await saveBusinessProfile(membership(), { registeredCountry: 'IN' });
    expect((await stored())?.registeredCountry).toBe('IN');
  });
});

describe('the postal code', () => {
  it("holds India's six digits", async () => {
    await clearProfile();

    await expect(
      saveBusinessProfile(membership(), {
        registeredCountry: 'IN',
        registeredPostcode: '3801',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    await saveBusinessProfile(membership(), {
      registeredCountry: 'IN',
      registeredPostcode: '380015',
    });
    expect((await stored())?.registeredPostcode).toBe('380015');
  });

  /*
   * The most important case in this file.
   *
   * A six-digit rule applied everywhere makes this field unfillable for most
   * of the world, and the seller it blocks has no way to find out why.
   */
  it("never applies one country's rule to another's address", async () => {
    await clearProfile();

    // A Dutch postcode is alphanumeric and is not six digits. It must be
    // accepted, and a six-digit PIN must NOT be accepted for the Netherlands.
    await saveBusinessProfile(membership(), {
      registeredCountry: 'NL',
      registeredPostcode: '1012 AB',
    });
    expect((await stored())?.registeredPostcode).toBe('1012 AB');

    await expect(
      saveBusinessProfile(membership(), {
        registeredCountry: 'NL',
        registeredPostcode: '380015',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('is permissive but safe where the deployment knows no rule', async () => {
    await clearProfile();

    /*
     * A country with no pattern of its own.
     *
     * The excluded list is every key of `POSTAL_PATTERNS` in
     * `onboarding.service.ts`, spelled out rather than imported: the constant
     * is private, and a test that reached into it would pass by construction
     * whatever the map said. Writing it out means adding a country to the map
     * without adding it here makes this test pick that country and fail, which
     * is the reminder worth having.
     */
    const KNOWN = [
      'IN', 'US', 'CA', 'AU', 'DE', 'FR', 'ES', 'IT', 'NL', 'PL', 'GR', 'BE',
      'AT', 'CH', 'PT', 'SE', 'DK', 'NO', 'FI', 'IE', 'JP', 'SG', 'BR', 'ZA', 'GB',
    ];

    const country = await prisma.country.findFirst({
      where: { code: { notIn: KNOWN } },
      select: { code: true },
    });

    // Only meaningful where the deployment serves such a country. Skipped
    // rather than failed if it does not — that is a fact about the seed, not
    // about this rule.
    if (country === null) return;

    await saveBusinessProfile(membership(), {
      registeredCountry: country.code,
      registeredPostcode: 'AB-1234',
    });
    expect((await stored())?.registeredPostcode).toBe('AB-1234');

    await expect(
      saveBusinessProfile(membership(), {
        registeredCountry: country.code,
        registeredPostcode: 'not a postcode; <script>',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('checks a postcode-only patch against the country already stored', async () => {
    await clearProfile();

    await saveBusinessProfile(membership(), {
      registeredCountry: 'NL',
      registeredPostcode: '1012 AB',
    });

    // The patch carries no country at all — the seller is fixing a typo. The
    // rule applied has to be the Netherlands', read off the stored row, not
    // "no country known, so anything goes".
    await expect(
      saveBusinessProfile(membership(), { registeredPostcode: '380015' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });

    // And the stored one is untouched by the refusal.
    expect((await stored())?.registeredPostcode).toBe('1012 AB');
  });
});

describe('an address entered before the fields existed', () => {
  it('is never destroyed by a save that does not mention it', async () => {
    await clearProfile();

    // The shape of every row written by the old single-box form.
    await saveBusinessProfile(membership(), {
      registeredAddressLine1: '42 Industrial Estate Phase 2 Noida UP 201301',
    });

    // A later save of something else entirely — the tax number, which is what
    // the same step asks for beside the address.
    await saveBusinessProfile(membership(), { taxRegistrationNumber: '24AAACC1206D1ZM' });

    const after = await stored();
    expect(after?.registeredAddressLine1).toBe('42 Industrial Estate Phase 2 Noida UP 201301');
    // And nothing was invented for the fields nobody filled in. Guessing which
    // word is the state is how a business is approved against the wrong
    // jurisdiction.
    expect(after?.registeredCity).toBeNull();
    expect(after?.registeredRegion).toBeNull();
    expect(after?.registeredPostcode).toBeNull();
    expect(after?.registeredCountry).toBeNull();
  });

  it('is replaced field by field once the seller completes it', async () => {
    await clearProfile();

    await saveBusinessProfile(membership(), {
      registeredAddressLine1: '42 Industrial Estate Phase 2 Noida UP 201301',
    });

    await saveBusinessProfile(membership(), {
      registeredAddressLine1: '42 Industrial Estate',
      registeredAddressLine2: 'Phase 2',
      registeredCity: 'Noida',
      registeredRegion: 'Uttar Pradesh (UP)',
      registeredPostcode: '201301',
      registeredCountry: 'IN',
    });

    expect(await stored()).toEqual({
      registeredAddressLine1: '42 Industrial Estate',
      registeredAddressLine2: 'Phase 2',
      registeredCity: 'Noida',
      registeredRegion: 'Uttar Pradesh (UP)',
      registeredPostcode: '201301',
      registeredCountry: 'IN',
    });
  });
});

describe('authorisation', () => {
  it('refuses a member without permission to write the account', async () => {
    await clearProfile();

    // A FINANCE_VIEWER is a real role with real access to the Hub and no
    // business editing the registered address of the company they work for.
    const viewer: SellerMembership = {
      ...membership(),
      role: SellerRole.FINANCE_VIEWER,
      permissions: permissionsForSellerRole(SellerRole.FINANCE_VIEWER),
    };

    await expect(
      saveBusinessProfile(viewer, { registeredCity: 'Noida' }),
    ).rejects.toBeInstanceOf(AppError);

    expect(await stored()).toBeNull();
  });
});
