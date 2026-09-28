/**
 * A buyer company and a seller account for the same legal entity: starting
 * one from the other, what the reviewer is shown, and - the point of the
 * file - that neither approval ever grants the other's capabilities.
 *
 * Also the representative's relationship to the business, which decides
 * whether an authorisation letter is needed up front.
 *
 * Self-contained: its own people, its own seller account, and everything it
 * made removed in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { isB2cLimitApplicable } from '../../src/domain/b2c-order-limit.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { riskLevelFor, sellerAccountSignals } from '../../src/modules/buyer-companies/checks.service.js';
import { resolveB2cBuyer } from '../../src/modules/cart/b2c-limit.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'SellerLink!2026xx';
const SELLER_OWNER = 'bcsl-seller-owner@test.local';
const BUYER_ONLY = 'bcsl-buyer-only@test.local';
const ALL_EMAILS = [SELLER_OWNER, BUYER_ONLY];
// A KRS number of the right shape that no other test uses.
const KRS = '0000777001';

let sellerAccountId = '';
const people = {} as Record<'seller' | 'buyer', { userId: string; profileId: string }>;

interface Session {
  cookie: string;
  csrf: string;
}

async function signIn(email: string): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
  };
}

function call(
  session: Session,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function createCustomer(email: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  const profileId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({
    data: { id: profileId, userId, fullName: 'Representative Person', phone: '+48221234567' },
  });
  return { userId, profileId };
}

async function signalCompany(id: string) {
  return prisma.buyerCompany.findUniqueOrThrow({
    where: { id },
    include: {
      identifiers: true,
      addresses: true,
      documents: { select: { contentHash: true, status: true } },
    },
  });
}

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerCompany.deleteMany({ where: { createdByUserId: { in: userIds } } });
  await prisma.jobQueue.deleteMany({ where: { jobType: 'buyer_company.checks' } });
  await prisma.sellerAccount.deleteMany({ where: { slug: 'bcsl-seller' } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  people.seller = await createCustomer(SELLER_OWNER);
  people.buyer = await createCustomer(BUYER_ONLY);

  // An APPROVED seller - as far as the seller side goes, fully trusted.
  sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'Nordwerk Sp. z o.o.',
      displayName: 'Nordwerk',
      displayNameNormalized: 'nordwerk',
      slug: 'bcsl-seller',
      registrationCountry: 'PL',
      status: 'APPROVED',
      approvedAt: new Date(),
      members: { create: { id: newId(), customerProfileId: people.seller.profileId, role: 'OWNER' } },
      businessProfile: {
        create: {
          id: newId(),
          companyRegistrationNumber: KRS,
          websiteUrl: 'nordwerk.pl',
          registeredAddressLine1: 'ul. Fabryczna 7',
          registeredCity: 'Poznań',
          registeredPostcode: '60-001',
          registeredCountry: 'PL',
          // Deliberately unusable on the buyer side (a Polish postcode must
          // be NN-NNN), so it must be left out rather than copied in error.
          billingAddressLine1: 'ul. Księgowa 1',
          billingCity: 'Poznań',
          billingPostcode: '60001',
          billingCountry: 'PL',
        },
      },
    },
  });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

let sellerDraftId = '';
let buyerCompanyId = '';

describe('starting a buyer company from a seller account', () => {
  it('offers the seller owner their own seller account as a source, and nobody else anything', async () => {
    const owner = await signIn(SELLER_OWNER);
    const own = await call(owner, 'GET', '/api/v1/buyer-companies');
    expect(own.statusCode).toBe(200);
    expect(own.json<{ sellerSource: unknown }>().sellerSource).toMatchObject({
      id: sellerAccountId,
      legalName: 'Nordwerk Sp. z o.o.',
      registrationCountry: 'PL',
    });

    const other = await call(await signIn(BUYER_ONLY), 'GET', '/api/v1/buyer-companies');
    expect(other.json<{ sellerSource: unknown }>().sellerSource).toBeNull();
  });

  it('answers somebody else\'s seller account and a made-up one with the same 404', async () => {
    const stranger = await signIn(BUYER_ONLY);
    const theirs = await call(stranger, 'POST', '/api/v1/buyer-companies', { fromSellerAccountId: sellerAccountId });
    const madeUp = await call(stranger, 'POST', '/api/v1/buyer-companies', { fromSellerAccountId: newId() });
    expect(theirs.statusCode).toBe(404);
    expect(madeUp.statusCode).toBe(404);
    // The same words either way - only the per-request correlation id differs.
    const essence = (response: LightMyRequestResponse): unknown => {
      const { code, message } = response.json<{ error: { code: string; message: string } }>().error;
      return { code, message };
    };
    expect(essence(theirs)).toEqual(essence(madeUp));
    expect(await prisma.buyerCompany.count({ where: { createdByUserId: people.buyer.userId } })).toBe(0);
  });

  it('pre-fills a DRAFT from the seller details, copies no approval, and leaves out an address that would not pass', async () => {
    const owner = await signIn(SELLER_OWNER);
    const response = await call(owner, 'POST', '/api/v1/buyer-companies', { fromSellerAccountId: sellerAccountId });
    expect(response.statusCode, response.body).toBe(201);
    const draft = response.json<{
      id: string;
      status: string;
      prefilledFromSeller: boolean;
      business: Record<string, unknown>;
      addresses: { kind: string }[];
      applicant: { fullName: string | null; phone: string | null };
    }>();
    sellerDraftId = draft.id;

    expect(draft.status).toBe('DRAFT');
    expect(draft.prefilledFromSeller).toBe(true);
    expect(draft.business).toMatchObject({
      legalName: 'Nordwerk Sp. z o.o.',
      registrationCountry: 'PL',
      registrationNumber: KRS,
      website: 'nordwerk.pl',
    });
    expect(draft.addresses.map((address) => address.kind)).toEqual(['REGISTERED_OFFICE']);
    // The representative's own name and number are shown back to them.
    expect(draft.applicant).toMatchObject({ fullName: 'Representative Person', phone: '+48221234567' });

    const row = await prisma.buyerCompany.findUniqueOrThrow({ where: { id: draft.id } });
    expect(row.linkedSellerAccountId).toBe(sellerAccountId);
    expect(row.approvedAt).toBeNull();
  });

  it('shows the reviewer that the two agree, as information - not as a duplicate that raises the risk', async () => {
    const rows = await sellerAccountSignals(await signalCompany(sellerDraftId));
    expect(rows).toEqual([
      expect.objectContaining({ provider: 'SELLER_ACCOUNT', subject: 'LINKED_SELLER', outcome: 'PASS' }),
    ]);
    expect(riskLevelFor(rows)).toBe('NONE');
  });

  it('flags a different applicant naming the same registration as that seller, without calling it HIGH risk', async () => {
    const buyer = await signIn(BUYER_ONLY);
    const created = await call(buyer, 'POST', '/api/v1/buyer-companies', {});
    buyerCompanyId = created.json<{ id: string }>().id;
    const saved = await call(buyer, 'PATCH', `/api/v1/buyer-companies/${buyerCompanyId}`, {
      business: { legalName: 'Nordwerk', entityType: 'PRIVATE_LIMITED_COMPANY', registrationCountry: 'PL', registrationNumber: KRS },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const rows = await sellerAccountSignals(await signalCompany(buyerCompanyId));
    expect(rows).toEqual([
      expect.objectContaining({ provider: 'SELLER_ACCOUNT', subject: 'REGISTRATION', outcome: 'SIGNAL' }),
    ]);
    expect(riskLevelFor(rows)).toBe('ELEVATED');
    // The applicant never sees it: it is a reviewer-only check.
    const view = await call(buyer, 'GET', `/api/v1/buyer-companies/${buyerCompanyId}`);
    expect(view.body).not.toContain('Nordwerk (approved)');
    expect(view.json<Record<string, unknown>>()).not.toHaveProperty('checks');
    expect(view.json<Record<string, unknown>>()).not.toHaveProperty('linkedSeller');
  });
});

describe('the two approvals stay independent', () => {
  it('an approved seller buying for its unapproved buyer company is still held to the B2C limit', async () => {
    const buyer = await resolveB2cBuyer(prisma, {
      customerProfileId: people.seller.profileId,
      buyerCompanyId: sellerDraftId,
    });
    expect(buyer).toEqual({ kind: 'COMPANY', companyId: sellerDraftId, companyStatus: 'DRAFT' });
    expect(isB2cLimitApplicable(buyer)).toBe(true);
  });

  it('an approved buyer company gives its member no way into Seller Hub', async () => {
    // Approval as a fixture, not through the console: what is under test is
    // what an APPROVED company grants, not how it got there.
    await prisma.buyerCompany.update({
      where: { id: buyerCompanyId },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    const approved = await resolveB2cBuyer(prisma, {
      customerProfileId: people.buyer.profileId,
      buyerCompanyId,
    });
    expect(isB2cLimitApplicable(approved)).toBe(false);

    const session = await signIn(BUYER_ONLY);
    const me = await call(session, 'GET', '/api/v1/sellers/me');
    expect(me.statusCode).toBe(200);
    expect(me.json<{ seller: unknown }>().seller).toBeNull();

    const hub = await call(session, 'GET', '/api/v1/seller/session');
    expect([401, 403, 404]).toContain(hub.statusCode);
    expect(await prisma.sellerMember.count({ where: { customerProfileId: people.buyer.profileId } })).toBe(0);
  });

  it('the seller account kept its own status through all of it', async () => {
    const seller = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: sellerAccountId } });
    expect(seller.status).toBe('APPROVED');
  });
});

describe('the representative\'s relationship to the business', () => {
  it('refuses a relationship that is not on the list', async () => {
    const owner = await signIn(SELLER_OWNER);
    const response = await call(owner, 'PATCH', `/api/v1/buyer-companies/${sellerDraftId}`, {
      applicant: { relationship: 'CEO' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('asks an outside agent for an authorisation letter, and stops asking when they say they are staff', async () => {
    const owner = await signIn(SELLER_OWNER);
    const agent = await call(owner, 'PATCH', `/api/v1/buyer-companies/${sellerDraftId}`, {
      applicant: { relationship: 'AUTHORISED_AGENT' },
    });
    expect(agent.statusCode, agent.body).toBe(200);
    const asAgent = agent.json<{
      applicant: { relationship: string };
      problems: { field: string; code: string }[];
      requirements: { documents: { kinds: string[]; required: boolean }[] };
    }>();
    expect(asAgent.applicant.relationship).toBe('AUTHORISED_AGENT');
    expect(asAgent.problems).toContainEqual({ field: 'documents.AUTHORIZATION_LETTER', code: 'DOCUMENT_REQUIRED' });
    expect(asAgent.requirements.documents.find((row) => row.kinds.includes('BUSINESS_LICENCE'))?.required).toBe(false);

    const staffMember = await call(owner, 'PATCH', `/api/v1/buyer-companies/${sellerDraftId}`, {
      applicant: { relationship: 'DIRECTOR_OR_OFFICER' },
    });
    const asStaff = staffMember.json<{ problems: { field: string }[] }>();
    expect(asStaff.problems.map((problem) => problem.field)).not.toContain('documents.AUTHORIZATION_LETTER');
    expect(asStaff.problems.map((problem) => problem.field)).not.toContain('applicantRelationship');
  });
});
