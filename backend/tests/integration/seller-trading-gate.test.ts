/**
 * The seller application review over HTTP (checklist Master row 12).
 *
 *   - **The trading gate.** Every route that changes what a buyer can see or
 *     pay - a price, a quantity band, packaging, container loading, a listing
 *     draft, a listing's photos - refuses a seller who is not approved
 *     (SELLER_NOT_APPROVED) or is suspended (SELLER_SUSPENDED). Several of them
 *     only checked "is this a seller", so a suspended business could still
 *     reprice a live offer.
 *   - **Only staff decide.** A seller's own customer session cannot reach the
 *     admin decision route, so a seller cannot approve itself.
 *   - **The ownership section's own routes**, and who may use them.
 *   - **Manual screening and the evidence gate**, as the console calls them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'SellerGate!2026x';
const HUB_PASSWORD = 'HubGate!2026x';
const PREFIX = 'r12gate-';
const EMAIL = {
  owner: 'r12gate-owner@test.local',
  catalogue: 'r12gate-catalogue@test.local',
  staff: 'r12gate-staff@test.local',
  cataloguer: 'r12gate-cataloguer@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);

interface Session {
  cookie: string;
  csrf: string;
}

let sellerAccountId = '';
let owner: Session;
let catalogue: Session;
let staff: AdminSession;
let cataloguer: AdminSession;
let ipSeed = 40;

const someIp = (): string => `198.51.100.${String((ipSeed += 1))}`;

function call(
  session: Session | AdminSession,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const isAdmin = 'cookies' in session;
  return app.inject({
    method,
    url,
    headers: {
      cookie: isAdmin ? session.cookies : session.cookie,
      'x-csrf-token': isAdmin ? session.csrfToken : session.csrf,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const codeOf = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code: string } }>().error?.code;

async function signInSeller(email: string): Promise<Session> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': someIp() },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  const session = {
    cookie: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrf: jar.find((cookie) => cookie.name === 'uboss_shop_csrf')?.value ?? '',
  };
  const set = await call(session, 'POST', '/api/v1/sellers/lock', { newPassword: HUB_PASSWORD });
  expect(set.statusCode, set.body).toBe(200);
  const open = await call(session, 'POST', '/api/v1/sellers/lock/open', { password: HUB_PASSWORD });
  expect(open.statusCode, open.body).toBe(200);
  return session;
}

async function createCustomer(email: string): Promise<string> {
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
    data: { id: profileId, userId, fullName: email.split('@')[0] ?? 'Seller', activatedAt: new Date() },
  });
  return profileId;
}

async function createStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
}

async function setStatus(status: 'DRAFT' | 'APPROVED' | 'SUSPENDED' | 'UNDER_REVIEW' | 'ACTION_REQUIRED'): Promise<void> {
  await prisma.sellerAccount.update({ where: { id: sellerAccountId }, data: { status } });
}

async function cleanUp(): Promise<void> {
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  const sellerIds = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.sellerScreeningCheck.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerBeneficialOwner.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerTrustProfile.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const ownerProfile = await createCustomer(EMAIL.owner);
  const catalogueProfile = await createCustomer(EMAIL.catalogue);
  await createStaff(EMAIL.staff, Role.BUSINESS_OWNER);
  await createStaff(EMAIL.cataloguer, Role.CATALOG_MANAGER);

  sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'Gate Test Private Limited',
      displayName: 'Gate Test',
      displayNameNormalized: 'gatetestr12',
      slug: `${PREFIX}seller`,
      kind: 'WHOLESALER',
      registrationCountry: 'QZ',
      status: 'DRAFT',
    },
  });
  await prisma.sellerBusinessProfile.create({ data: { id: newId(), sellerAccountId } });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId, customerProfileId: ownerProfile, role: 'OWNER' },
  });
  await prisma.sellerMember.create({
    data: { id: newId(), sellerAccountId, customerProfileId: catalogueProfile, role: 'CATALOGUE_MANAGER' },
  });

  owner = await signInSeller(EMAIL.owner);
  catalogue = await signInSeller(EMAIL.catalogue);
  staff = await signInAdmin(app, { email: EMAIL.staff, password: PASSWORD, ip: someIp() });
  cataloguer = await signInAdmin(app, { email: EMAIL.cataloguer, password: PASSWORD, ip: someIp() });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

// ---------------------------------------------------------------------------

const ID = '01K6R12GATE000000000000000';

/** Every route that changes what a buyer sees or pays, with a body the guard never reads. */
const GATED: readonly [method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body: unknown][] = [
  ['POST', '/api/v1/seller/listing-drafts', {}],
  ['PATCH', `/api/v1/seller/listings/${ID}/price`, { priceMinor: '100' }],
  ['PUT', `/api/v1/seller/offers/${ID}/quantity-tiers`, { tiers: [] }],
  ['PUT', `/api/v1/seller/offers/${ID}/packaging/profile`, {}],
  ['PUT', `/api/v1/seller/offers/${ID}/packaging/options`, {}],
  ['POST', `/api/v1/seller/offers/${ID}/packaging/options/CARTON/enabled`, { enabled: true }],
  ['PUT', `/api/v1/seller/offers/${ID}/container-loading`, {}],
  ['POST', `/api/v1/seller/listings/${ID}/pause-for-edit`, {}],
  ['PATCH', `/api/v1/seller/listing-drafts/${ID}`, {}],
  ['PUT', `/api/v1/seller/listing-drafts/${ID}/content`, {}],
  ['POST', `/api/v1/seller/listing-drafts/${ID}/variants/generate`, {}],
  ['PATCH', `/api/v1/seller/listings/${ID}/photos/${ID}`, {}],
  ['DELETE', `/api/v1/seller/listings/${ID}/photos/${ID}`, undefined],
  ['PATCH', `/api/v1/seller/listing-drafts/${ID}/media/${ID}`, {}],
  ['DELETE', `/api/v1/seller/listing-drafts/${ID}/media/${ID}`, undefined],
];

describe('the trading gate', () => {
  it('refuses a seller whose application is not approved, on every route that changes an offer', async () => {
    await setStatus('DRAFT');
    for (const [method, url, body] of GATED) {
      const response = await call(owner, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(codeOf(response), `${method} ${url}`).toBe('SELLER_NOT_APPROVED');
    }
  });

  it('refuses a suspended seller with its own code', async () => {
    await setStatus('SUSPENDED');
    for (const [method, url, body] of GATED) {
      const response = await call(owner, method, url, body);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(codeOf(response), `${method} ${url}`).toBe('SELLER_SUSPENDED');
    }
  });

  it('lets an approved seller through the gate to the route itself', async () => {
    await setStatus('APPROVED');
    // Past the guard, the unknown offer answers for itself: not a trading refusal.
    const response = await call(owner, 'PATCH', `/api/v1/seller/listings/${ID}/price`, { priceMinor: '100' });
    expect(['SELLER_NOT_APPROVED', 'SELLER_SUSPENDED']).not.toContain(codeOf(response));
  });
});

describe('who decides an application', () => {
  it("refuses the seller's own customer session on the admin decision route", async () => {
    await setStatus('UNDER_REVIEW');
    const response = await call(owner, 'POST', `/api/v1/admin/sellers/${sellerAccountId}/decision`, {
      status: 'APPROVED',
    });
    expect([401, 403]).toContain(response.statusCode);
    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: sellerAccountId } });
    expect(account.status).toBe('UNDER_REVIEW');
  });
});

describe('the ownership section', () => {
  it('is for owners and administrators only', async () => {
    await setStatus('DRAFT');
    const denied = await call(catalogue, 'GET', '/api/v1/seller/kyb');
    expect(denied.statusCode).toBe(403);
    expect(codeOf(denied)).toBe('SELLER_ROLE_DENIED');
  });

  it('saves the whole section and answers with what is still needed', async () => {
    await setStatus('DRAFT');
    const saved = await call(owner, 'PUT', '/api/v1/seller/kyb', {
      legalForm: 'PARTNERSHIP',
      udyamNumber: null,
      iecNumber: null,
      exportCapable: false,
      exportMarkets: [],
      yearsExporting: null,
      intendedCategoryIds: [],
      beneficialOwners: [
        { fullName: 'Partner One', nationality: 'IN', ownershipBasisPoints: 5000, role: 'Partner', isControllingPerson: true, isPoliticallyExposed: false },
        { fullName: 'Partner Two', nationality: null, ownershipBasisPoints: 5000, role: 'Partner', isControllingPerson: false, isPoliticallyExposed: false },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const view = saved.json<{ legalForm: string; beneficialOwners: unknown[]; outstanding: unknown[]; isEditable: boolean }>();
    expect(view.legalForm).toBe('PARTNERSHIP');
    expect(view.beneficialOwners).toHaveLength(2);
    expect(view.outstanding).toEqual([]);
    expect(view.isEditable).toBe(true);

    const fraction = await call(owner, 'PUT', '/api/v1/seller/kyb', {
      legalForm: 'PARTNERSHIP',
      udyamNumber: null,
      iecNumber: null,
      exportCapable: false,
      exportMarkets: [],
      yearsExporting: null,
      intendedCategoryIds: [],
      beneficialOwners: [{ fullName: 'Half', nationality: null, ownershipBasisPoints: 33.5, role: null, isControllingPerson: false, isPoliticallyExposed: false }],
    });
    expect(fraction.statusCode).toBe(400);
  });
});

describe('manual screening and the evidence gate, from the console', () => {
  it('records a manual screening, and refuses approval while evidence is missing', async () => {
    await setStatus('UNDER_REVIEW');

    const noRight = await call(cataloguer, 'POST', `/api/v1/admin/sellers/${sellerAccountId}/screening`, {
      subjectType: 'ENTITY',
      result: 'CLEAR',
      listsChecked: 'UN list',
    });
    expect(noRight.statusCode).toBe(403);

    const recorded = await call(staff, 'POST', `/api/v1/admin/sellers/${sellerAccountId}/screening`, {
      subjectType: 'ENTITY',
      result: 'CLEAR',
      listsChecked: 'UN consolidated list; OFAC SDN',
      note: 'No match.',
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    expect(recorded.json<{ provider: string; automated: boolean }>()).toMatchObject({ provider: 'manual', automated: false });

    const refused = await call(staff, 'POST', `/api/v1/admin/sellers/${sellerAccountId}/decision`, { status: 'APPROVED' });
    expect(refused.statusCode).toBe(409);
    expect(codeOf(refused)).toBe('SELLER_APPROVAL_EVIDENCE_MISSING');
    const details = refused.json<{ error: { details: { code: string; field?: string }[] } }>().error.details;
    // Both partners are still unscreened; the business itself is clear.
    expect(details.filter((detail) => detail.code === 'SCREENING_REQUIRED')).toHaveLength(2);
    expect(details.some((detail) => detail.field === 'entity')).toBe(false);

    const readiness = await call(staff, 'GET', `/api/v1/admin/sellers/${sellerAccountId}/approval-readiness`);
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json<{ ready: boolean }>().ready).toBe(false);

    const detail = await call(staff, 'GET', `/api/v1/admin/sellers/${sellerAccountId}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain('signatureStorageKey');
    expect(detail.body).not.toContain('pendingRequirementsJson');
    expect(detail.json<{ kyb: { screening: { entity: { state: string } | null } } }>().kyb.screening.entity?.state).toBe('CLEAR');
  });
});
