/**
 * The company directory, against a real MariaDB.
 *
 * The grouping rule itself is unit-tested in `tests/unit/company-directory`.
 * What this file exists for is the half that cannot be tested without a
 * database: a `groupBy` over a nullable column, ordered by it, with a relation
 * filter on the side — the kind of query that typechecks perfectly and then
 * fails at runtime on 10.4. If these pass, the screen loads.
 *
 * The three things asserted are the three the screen is for:
 *
 *   - one business that sells, buys and carries comes back as ONE company;
 *   - the person who owns the seller and buys with the same login is ONE row
 *     carrying both roles, not two rows;
 *   - an administrator without `logistics.read` is not shown carriers at all.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { readDirectory } from '../../src/modules/directory/directory.service.js';

const SELLER_SLUG = 'directory-north';
const PARTNER_CODE = 'LP-DIRTEST';
const ORGANISATION = 'Directory Northwind Ltd';
const OWNER_EMAIL = 'owner@directory-northwind.test';
const BUYER_EMAIL = 'buyer@directory-northwind.test';
const DISPATCHER_EMAIL = 'dispatcher@directory-northwind.test';

/** The searches below are narrow enough that nothing else can match them. */
const SEARCH = 'Directory Northwind';

let sellerAccountId = '';
let ownerProfileId = '';

async function cleanUp(): Promise<void> {
  await prisma.sellerMember.deleteMany({ where: { sellerAccount: { slug: SELLER_SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SELLER_SLUG } });

  await prisma.logisticsPartnerUser.deleteMany({
    where: { partner: { partnerCode: PARTNER_CODE } },
  });
  await prisma.logisticsPartner.deleteMany({ where: { partnerCode: PARTNER_CODE } });

  await prisma.customerProfile.deleteMany({
    where: { user: { emailNormalized: { in: [OWNER_EMAIL, BUYER_EMAIL] } } },
  });
  await prisma.user.deleteMany({
    where: { emailNormalized: { in: [OWNER_EMAIL, BUYER_EMAIL, DISPATCHER_EMAIL] } },
  });
}

async function createCustomer(email: string, fullName: string): Promise<string> {
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      status: 'ACTIVE',
    },
  });

  const profile = await prisma.customerProfile.create({
    data: {
      id: newId(),
      userId: user.id,
      fullName,
      organization: ORGANISATION,
    },
  });

  return profile.id;
}

beforeAll(async () => {
  await cleanUp();

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      legalName: ORGANISATION,
      // The trading name is deliberately NOT the legal name: matching a
      // buyer's typed employer against the legal name is the half of the rule
      // most likely to break unnoticed.
      displayName: 'Directory Northwind',
      displayNameNormalized: 'directory northwind',
      slug: SELLER_SLUG,
      kind: 'WHOLESALER',
      registrationCountry: 'DE',
      status: 'APPROVED',
    },
  });

  sellerAccountId = seller.id;

  ownerProfileId = await createCustomer(OWNER_EMAIL, 'Directory Owner');
  await createCustomer(BUYER_EMAIL, 'Directory Buyer');

  await prisma.sellerMember.create({
    data: {
      id: newId(),
      sellerAccountId,
      customerProfileId: ownerProfileId,
      role: 'OWNER',
    },
  });

  const partner = await prisma.logisticsPartner.create({
    data: {
      id: newId(),
      partnerCode: PARTNER_CODE,
      legalName: ORGANISATION,
      displayName: 'Directory Northwind',
      displayNameNormalized: 'directory northwind carriage',
      registrationCountry: 'DE',
      contactEmail: 'ops@directory-northwind.test',
      status: 'ACTIVE',
    },
  });

  const dispatcher = await prisma.user.create({
    data: {
      id: newId(),
      type: 'LOGISTICS',
      email: DISPATCHER_EMAIL,
      emailNormalized: DISPATCHER_EMAIL,
      status: 'ACTIVE',
    },
  });

  await prisma.logisticsPartnerUser.create({
    data: {
      id: newId(),
      logisticsPartnerId: partner.id,
      userId: dispatcher.id,
      role: 'DISPATCHER',
      status: 'ACTIVE',
      fullName: 'Directory Dispatcher',
    },
  });
});

afterAll(async () => {
  await cleanUp();
});

describe('readDirectory', () => {
  it('returns one company for a business that sells, buys and carries', async () => {
    const result = await readDirectory({
      search: SEARCH,
      page: 1,
      pageSize: 25,
      canReadCustomers: true,
      canReadLogistics: true,
    });

    const company = result.companies.find((entry) => entry.name === 'Directory Northwind');

    expect(company).toBeDefined();
    expect(company?.kinds).toEqual(['SELLER', 'BUYER', 'LOGISTICS']);
    expect(company?.seller?.id).toBe(sellerAccountId);
    expect(company?.logistics?.partnerCode).toBe(PARTNER_CODE);
    expect(company?.buyer?.profileCount).toBe(2);
  });

  it('lists the owner once, carrying both the roles they hold', async () => {
    const result = await readDirectory({
      search: SEARCH,
      page: 1,
      pageSize: 25,
      canReadCustomers: true,
      canReadLogistics: true,
    });

    const company = result.companies.find((entry) => entry.name === 'Directory Northwind');
    const owner = company?.people.filter((person) => person.email === OWNER_EMAIL) ?? [];

    expect(owner).toHaveLength(1);
    expect(owner[0]?.roles.map((role) => role.kind).sort()).toEqual(['BUYER', 'SELLER']);
  });

  it('hides carriers from an administrator who may not read them', async () => {
    const result = await readDirectory({
      search: SEARCH,
      page: 1,
      pageSize: 25,
      canReadCustomers: true,
      canReadLogistics: false,
    });

    const company = result.companies.find((entry) => entry.name === 'Directory Northwind');

    expect(company?.logistics).toBeNull();
    expect(company?.kinds).not.toContain('LOGISTICS');
    // Not merely hidden on screen: absent from the count as well.
    expect(result.counts.logistics).toBe(0);
    expect(
      company?.people.some((person) => person.email === DISPATCHER_EMAIL),
    ).toBe(false);
  });

  it('filtered to carriers, returns the carrier and no buying side', async () => {
    const result = await readDirectory({
      search: SEARCH,
      kind: 'LOGISTICS',
      page: 1,
      pageSize: 25,
      canReadCustomers: true,
      canReadLogistics: true,
    });

    const company = result.companies.find((entry) => entry.name === 'Directory Northwind');

    expect(company?.logistics?.partnerCode).toBe(PARTNER_CODE);
    expect(company?.seller).toBeNull();
    expect(company?.buyer).toBeNull();
    // The "no employer named" summary is a buyers' list, so it has no business
    // being computed at all when the operator asked for carriers.
    expect(result.unlistedBuyers).toBeNull();
  });
});
