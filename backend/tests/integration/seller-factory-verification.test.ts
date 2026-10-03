/**
 * Factory verification, end to end over HTTP (checklist Master row 13).
 *
 *   - A seller records a factory, its machines and evidence; bad coordinates,
 *     negative figures and unknown fields (a `status`) are refused.
 *   - Evidence must be the seller's OWN document; another seller's is a 404.
 *   - Submitting needs evidence; a reviewer verifies or refuses (with a
 *     reason the seller sees), and each decision APPENDS a check row.
 *   - Two reviewers deciding at once: one winner, one STALE refusal.
 *   - A material change to a verified factory sends it back to PENDING.
 *   - A verification past its end date is EXPIRED, recorded by the system.
 *   - Another seller cannot read or change it; a customer session and a
 *     read-only member of staff cannot decide.
 *   - The public supplier page shows only VERIFIED, unexpired factories.
 *   - Certificates: added with proof, verified or refused with a reason,
 *     back to PENDING when changed, EXPIRED past their date.
 *
 * The `it`s build on each other in order. Everything is removed in afterAll.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { getBaseCurrency } from '../../src/modules/settings/currency.service.js';
import { sweepExpiredFactories } from '../../src/modules/trust/factory.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PREFIX = 'sfv-';
const PASSWORD = 'FactoryVerify!2026x';
const HUB_PASSWORD = 'FactoryHub!2026yy';
const STAFF_PASSWORD = 'FactoryStaff!2026z';
const EMAIL = {
  ownerA: 'sfv-owner-a@test.local',
  ownerB: 'sfv-owner-b@test.local',
  buyer: 'sfv-buyer@test.local',
  reviewer: 'sfv-reviewer@test.local',
  reviewer2: 'sfv-reviewer2@test.local',
  reader: 'sfv-reader@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);
const IP = '203.0.113.131';

interface Session {
  cookie: string;
  csrf: string;
}

let sellerA = '';
let sellerB = '';
let docA = '';
let docA2 = '';
let docB = '';
let categoryId = '';
let taxClassId = '';
let a: Session;
let b: Session;
let buyer: Session;
let reviewer: AdminSession;
let reviewer2: AdminSession;
let reader: AdminSession;
let factoryId = '';
let certificateId = '';

function jarOf(response: LightMyRequestResponse, jar = new Map<string, string>()): Map<string, string> {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

const cookieOf = (jar: Map<string, string>): string => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

async function signIn(email: string, openHub: boolean): Promise<Session> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = jarOf(login);
  if (openHub) {
    const opened = await app.inject({
      method: 'POST',
      url: '/api/v1/sellers/lock/open',
      headers: { cookie: cookieOf(jar), 'x-csrf-token': jar.get('uboss_shop_csrf') ?? '', 'x-forwarded-for': IP },
      payload: { password: HUB_PASSWORD },
    });
    expect(opened.statusCode, opened.body).toBe(200);
    jarOf(opened, jar);
  }
  return { cookie: cookieOf(jar), csrf: jar.get('uboss_shop_csrf') ?? '' };
}

function call(
  session: Session | AdminSession,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const isAdmin = 'cookies' in session;
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      cookie: isAdmin ? session.cookies : session.cookie,
      'x-csrf-token': isAdmin ? session.csrfToken : session.csrf,
      'x-forwarded-for': IP,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const code = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code: string } }>().error?.code;
const detail = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { details?: { code?: string }[] } }>().error?.details?.[0]?.code;

interface FactoryBody {
  factory: {
    id: string;
    latitude: number | null;
    machines: { name: string }[];
    evidence: { id: string; documentId: string; document: { originalFileName: string } | null }[];
    verification: { status: string; checkId: string | null; reason: string | null; validUntil: string | null; isEditable: boolean };
    history: { state: string; reason: string | null; decidedBy?: unknown; internalNote?: unknown }[];
  };
}

async function currentCheckId(): Promise<string> {
  const response = await call(reviewer, 'GET', `/admin/sellers/${sellerA}/factories`);
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json<{ factories: FactoryBody['factory'][] }>();
  return body.factories.find((row) => row.id === factoryId)!.verification.checkId!;
}

const PLANT = {
  name: 'Pune plant',
  addressLine1: '12 MIDC Industrial Area',
  city: 'Pune',
  region: 'Maharashtra',
  postcode: '411019',
  countryCode: 'in',
  latitude: 18.5204303,
  longitude: 73.8567437,
  establishedYear: 2008,
  floorAreaSqm: 4200,
  workforceCount: 140,
  qcStaffCount: 12,
  monthlyCapacity: 50000,
  capacityUnit: 'pieces',
  productsMade: 'Valves and flanges',
  qcProcess: 'First-article inspection, then 1 in 50 sampling.',
};

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
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: email.split('@')[0] ?? 'Person' } });
  return profileId;
}

async function createSeller(slug: string, ownerProfileId: string): Promise<string> {
  const id = newId();
  await prisma.sellerAccount.create({
    data: {
      id,
      legalName: `${slug} Industries Private Limited`,
      displayName: `Supplier ${slug}`,
      displayNameNormalized: `supplier ${slug}`,
      slug: `${PREFIX}${slug}`,
      kind: 'MANUFACTURER',
      registrationCountry: 'IN',
      status: 'APPROVED',
      approvedAt: new Date('2026-02-01'),
    },
  });
  await prisma.sellerMember.create({
    data: {
      id: newId(),
      sellerAccountId: id,
      customerProfileId: ownerProfileId,
      role: 'OWNER',
      passwordHash: await hashPassword(HUB_PASSWORD),
      passwordSetAt: new Date(),
    },
  });
  return id;
}

async function createDocument(sellerAccountId: string, name: string): Promise<string> {
  const id = newId();
  await prisma.sellerDocument.create({
    data: {
      id,
      sellerAccountId,
      kind: 'OTHER',
      storageKey: `private/test/${id}.pdf`,
      originalFileName: name,
      contentType: 'application/pdf',
      byteSize: 1234,
      contentHash: 'a'.repeat(64),
      scanState: 'CLEAN',
    },
  });
  return id;
}

async function createStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
}

async function cleanUp(): Promise<void> {
  const sellers = (
    await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })
  ).map((row) => row.id);
  const userIds = (
    await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.auditLog.deleteMany({ where: { resourceType: { in: ['seller_factory', 'seller_certification'] }, actorType: 'SYSTEM' } });
  await prisma.sellerTrustCheck.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerCertification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerFactory.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerDocument.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerOffer.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellers } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellers } } });
  await prisma.product.deleteMany({ where: { slug: { startsWith: PREFIX } } });
  await prisma.category.deleteMany({ where: { slug: `${PREFIX}category` } });
  await prisma.taxClass.deleteMany({ where: { code: 'SFVTAX' } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  const profileIds = (
    await prisma.customerProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } })
  ).map((row) => row.id);
  await prisma.cart.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const ownerA = await createCustomer(EMAIL.ownerA);
  const ownerB = await createCustomer(EMAIL.ownerB);
  await createCustomer(EMAIL.buyer);
  sellerA = await createSeller('alpha', ownerA);
  sellerB = await createSeller('beta', ownerB);
  docA = await createDocument(sellerA, 'plant-photo.pdf');
  docA2 = await createDocument(sellerA, 'iso-certificate.pdf');
  docB = await createDocument(sellerB, 'rival-photo.pdf');

  // Something live to sell, so seller A has a public page.
  const currency = await getBaseCurrency();
  taxClassId = newId();
  await prisma.taxClass.create({ data: { id: taxClassId, code: 'SFVTAX', name: 'Factory', ratePercent: '18' } });
  categoryId = newId();
  await prisma.category.create({ data: { id: categoryId, name: 'Valves', slug: `${PREFIX}category`, isActive: true } });
  const productId = newId();
  await prisma.product.create({
    data: {
      id: productId,
      categoryId,
      taxClassId,
      name: 'Factory verification valve',
      slug: `${PREFIX}valve`,
      sku: 'SFV-VALVE',
      basePriceMinor: 1000n,
      currency,
      status: 'ACTIVE',
      isPublished: true,
      publishedAt: new Date(),
    },
  });
  await prisma.sellerOffer.create({
    data: { id: newId(), sellerAccountId: sellerA, productId, variantKey: 'V', sellerSku: 'V', status: 'ACTIVE', priceMinor: 900n, currency },
  });

  await createStaff(EMAIL.reviewer, Role.BUSINESS_OWNER);
  await createStaff(EMAIL.reviewer2, Role.BUSINESS_OWNER);
  await createStaff(EMAIL.reader, Role.ORDER_MANAGER);

  a = await signIn(EMAIL.ownerA, true);
  b = await signIn(EMAIL.ownerB, true);
  buyer = await signIn(EMAIL.buyer, false);
  reviewer = await signInAdmin(app, { email: EMAIL.reviewer, password: STAFF_PASSWORD, ip: IP });
  reviewer2 = await signInAdmin(app, { email: EMAIL.reviewer2, password: STAFF_PASSWORD, ip: IP });
  reader = await signInAdmin(app, { email: EMAIL.reader, password: STAFF_PASSWORD, ip: IP });
}, 120_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

async function publicFactories(): Promise<string[]> {
  const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers/${PREFIX}alpha` });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<{ supplier: { factories: { name: string }[] } }>().supplier.factories.map((row) => row.name);
}

describe('recording a factory', () => {
  it('refuses coordinates out of range, negative figures and a status field', async () => {
    for (const bad of [
      { ...PLANT, latitude: 91 },
      { ...PLANT, longitude: -181 },
      { ...PLANT, latitude: 18.5, longitude: undefined },
      { ...PLANT, monthlyCapacity: -5 },
      { ...PLANT, workforceCount: -1 },
      { ...PLANT, qcStaffCount: 500 },
      { ...PLANT, monthlyCapacity: 10, capacityUnit: '' },
      { ...PLANT, status: 'VERIFIED' },
    ]) {
      const response = await call(a, 'POST', '/seller/factories', bad);
      expect(response.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await prisma.sellerFactory.count({ where: { sellerAccountId: sellerA } })).toBe(0);
  });

  it('creates one, not yet submitted, and hides it from the public page', async () => {
    const response = await call(a, 'POST', '/seller/factories', PLANT);
    expect(response.statusCode, response.body).toBe(201);
    const { factory } = response.json<FactoryBody>();
    factoryId = factory.id;
    expect(factory.verification.status).toBe('NOT_SUBMITTED');
    expect(factory.latitude).toBeCloseTo(18.5204303, 6);
    expect(await publicFactories()).toEqual([]);
  });

  it('updates details and machines, and validates a patch against the stored row', async () => {
    const patched = await call(a, 'PATCH', `/seller/factories/${factoryId}`, { workforceCount: 150 });
    expect(patched.statusCode, patched.body).toBe(200);
    const tooManyQc = await call(a, 'PATCH', `/seller/factories/${factoryId}`, { qcStaffCount: 151 });
    expect(tooManyQc.statusCode).toBe(400);
    const halfPair = await call(a, 'PATCH', `/seller/factories/${factoryId}`, { latitude: null });
    expect(halfPair.statusCode).toBe(400);
    const machines = await call(a, 'PUT', `/seller/factories/${factoryId}/machines`, {
      machines: [
        { name: 'CNC lathe', quantity: 6, capacityNote: '300 pieces a shift' },
        { name: 'Pressure test rig', quantity: 2 },
      ],
    });
    expect(machines.statusCode, machines.body).toBe(200);
    expect(machines.json<FactoryBody>().factory.machines.map((row) => row.name)).toEqual(['CNC lathe', 'Pressure test rig']);
    const badMachine = await call(a, 'PUT', `/seller/factories/${factoryId}/machines`, { machines: [{ name: 'X', quantity: 0 }] });
    expect(badMachine.statusCode).toBe(400);
  });

  it('refuses to send it for review without evidence', async () => {
    const response = await call(a, 'POST', `/seller/factories/${factoryId}/submit`);
    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe('FACTORY_INCOMPLETE');
  });

  it('accepts only the seller’s own document as evidence', async () => {
    const rival = await call(a, 'POST', `/seller/factories/${factoryId}/evidence`, { documentId: docB });
    expect(rival.statusCode).toBe(404);
    const badPoint = await call(a, 'POST', `/seller/factories/${factoryId}/evidence`, { documentId: docA, capturedLatitude: 100, capturedLongitude: 10 });
    expect(badPoint.statusCode).toBe(400);
    const own = await call(a, 'POST', `/seller/factories/${factoryId}/evidence`, {
      documentId: docA,
      caption: 'Front gate',
      capturedLatitude: 18.52,
      capturedLongitude: 73.85,
    });
    expect(own.statusCode, own.body).toBe(201);
    expect(own.json<FactoryBody>().factory.evidence.map((row) => row.document?.originalFileName)).toEqual(['plant-photo.pdf']);
  });

  it('will not let a document in use as evidence be withdrawn', async () => {
    const response = await call(a, 'DELETE', `/seller/documents/${docA}`);
    expect(response.statusCode).toBe(409);
    expect(code(response)).toBe('TRUST_EVIDENCE_IN_USE');
  });
});

describe('another seller, a customer, and a read-only member of staff', () => {
  it('another seller cannot see, change, submit or attach to it', async () => {
    const list = await call(b, 'GET', '/seller/factories');
    expect(list.statusCode).toBe(200);
    expect(list.json<{ factories: unknown[] }>().factories).toEqual([]);
    for (const [method, url, payload] of [
      ['PATCH', `/seller/factories/${factoryId}`, { name: 'Taken over' }],
      ['PUT', `/seller/factories/${factoryId}/machines`, { machines: [] }],
      ['POST', `/seller/factories/${factoryId}/evidence`, { documentId: docB }],
      ['POST', `/seller/factories/${factoryId}/submit`, undefined],
      ['DELETE', `/seller/factories/${factoryId}`, undefined],
    ] as const) {
      const response = await call(b, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
  });

  it('a customer session cannot reach the review routes', async () => {
    const read = await call(buyer, 'GET', `/admin/sellers/${sellerA}/factories`);
    expect([401, 403]).toContain(read.statusCode);
    const decide = await call(a, 'POST', `/admin/seller-factories/${factoryId}/decision`, {
      decision: 'VERIFIED',
      expectedCheckId: newId(),
    });
    expect([401, 403]).toContain(decide.statusCode);
  });

  it('a seller has no route that decides', async () => {
    const response = await call(a, 'POST', `/seller/factories/${factoryId}/decision`, { decision: 'VERIFIED' });
    expect(response.statusCode).toBe(404);
  });
});

describe('verification', () => {
  it('sends the factory for review, and locks it while it is there', async () => {
    const submitted = await call(a, 'POST', `/seller/factories/${factoryId}/submit`);
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json<FactoryBody>().factory.verification.status).toBe('PENDING');
    const again = await call(a, 'POST', `/seller/factories/${factoryId}/submit`);
    expect(code(again)).toBe('FACTORY_TRANSITION_INVALID');
    const edit = await call(a, 'PATCH', `/seller/factories/${factoryId}`, { city: 'Nashik' });
    expect(edit.statusCode).toBe(409);
    expect(code(edit)).toBe('FACTORY_NOT_EDITABLE');
    expect(await publicFactories()).toEqual([]);
  });

  it('a reader can see the queue but not decide it', async () => {
    const list = await call(reader, 'GET', `/admin/sellers/${sellerA}/factories`);
    expect(list.statusCode).toBe(200);
    const decide = await call(reader, 'POST', `/admin/seller-factories/${factoryId}/decision`, {
      decision: 'VERIFIED',
      expectedCheckId: await currentCheckId(),
    });
    expect(decide.statusCode).toBe(403);
  });

  it('refuses a refusal without a reason', async () => {
    const response = await call(reviewer, 'POST', `/admin/seller-factories/${factoryId}/decision`, {
      decision: 'REJECTED',
      expectedCheckId: await currentCheckId(),
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses, with a reason the seller sees and an internal note they do not', async () => {
    const response = await call(reviewer, 'POST', `/admin/seller-factories/${factoryId}/decision`, {
      decision: 'REJECTED',
      expectedCheckId: await currentCheckId(),
      reason: 'The photograph does not show the plant’s signage. Add one that does.',
      internalNote: 'INTERNAL-ONLY-NOTE',
    });
    expect(response.statusCode, response.body).toBe(200);
    const mine = await call(a, 'GET', '/seller/factories');
    const { factories } = mine.json<{ factories: FactoryBody['factory'][] }>();
    expect(factories[0]!.verification.status).toBe('REJECTED');
    expect(factories[0]!.verification.reason).toContain('signage');
    expect(mine.body).not.toContain('INTERNAL-ONLY-NOTE');
    expect(mine.body).not.toContain(EMAIL.reviewer);
    expect(factories[0]!.history[0]).not.toHaveProperty('decidedBy');
  });

  it('keeps every check: submit, refusal, resubmit - the earlier rows are untouched', async () => {
    const resubmitted = await call(a, 'POST', `/seller/factories/${factoryId}/submit`);
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    const rows = await prisma.sellerTrustCheck.findMany({
      where: { sellerAccountId: sellerA, kind: 'FACTORY', subjectId: factoryId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((row) => row.state)).toEqual(['PENDING', 'REJECTED', 'PENDING']);
    expect(rows.map((row) => row.isCurrent)).toEqual([false, false, true]);
    expect(rows[1]!.sellerReason).toContain('signage');
    expect(rows[1]!.internalNote).toBe('INTERNAL-ONLY-NOTE');
  });

  it('two reviewers deciding at once: one wins, the other is told it is stale', async () => {
    const expectedCheckId = await currentCheckId();
    const results = await Promise.allSettled([
      call(reviewer, 'POST', `/admin/seller-factories/${factoryId}/decision`, { decision: 'VERIFIED', expectedCheckId }),
      call(reviewer2, 'POST', `/admin/seller-factories/${factoryId}/decision`, {
        decision: 'REJECTED',
        expectedCheckId,
        reason: 'Refused at the same moment by a colleague.',
      }),
    ]);
    const statuses = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(statuses).toEqual([200, 409]);
    const loser = results.find((result) => result.status === 'fulfilled' && result.value.statusCode === 409);
    expect(loser?.status === 'fulfilled' && detail(loser.value)).toBe('STALE');
    const current = await prisma.sellerTrustCheck.findMany({
      where: { sellerAccountId: sellerA, kind: 'FACTORY', subjectId: factoryId, isCurrent: true },
    });
    expect(current).toHaveLength(1);
    expect(await prisma.sellerTrustCheck.count({ where: { subjectId: factoryId } })).toBe(4);
  });

  it('makes sure the winner was the verification for the rest of the file', async () => {
    const current = await prisma.sellerTrustCheck.findFirstOrThrow({ where: { subjectId: factoryId, isCurrent: true } });
    if (current.state !== 'VERIFIED') {
      // The refusal won the race; send it again and verify it.
      await call(a, 'POST', `/seller/factories/${factoryId}/submit`);
      const verified = await call(reviewer, 'POST', `/admin/seller-factories/${factoryId}/decision`, {
        decision: 'VERIFIED',
        expectedCheckId: await currentCheckId(),
      });
      expect(verified.statusCode, verified.body).toBe(200);
    }
    const now = await prisma.sellerTrustCheck.findFirstOrThrow({ where: { subjectId: factoryId, isCurrent: true } });
    expect(now.state).toBe('VERIFIED');
    expect(now.decidedByUserId).not.toBeNull();
    expect(now.checkedValue).toMatch(/^sha256:/);
    // Defaulted from TrustSettings.reverificationDays.
    const settings = await prisma.trustSettings.findUnique({ where: { id: 'default' } });
    const days = (now.validUntil!.getTime() - now.checkedAt!.getTime()) / 86_400_000;
    expect(Math.round(days)).toBe(settings?.reverificationDays ?? 365);
    expect(await prisma.auditLog.count({ where: { action: 'seller_factory.decided', resourceId: factoryId } })).toBeGreaterThanOrEqual(2);
  });

  it('shows a verified factory on the public page, by city only', async () => {
    expect(await publicFactories()).toEqual(['Pune plant']);
    const response = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers/${PREFIX}alpha` });
    expect(response.body).not.toContain('MIDC');
    expect(response.body).not.toContain('411019');
  });

  it('a rename keeps the verification; a change of fact sends it back to review', async () => {
    const renamed = await call(a, 'PATCH', `/seller/factories/${factoryId}`, { name: 'Pune plant 1' });
    expect(renamed.json<FactoryBody>().factory.verification.status).toBe('VERIFIED');
    const addedProof = await call(a, 'POST', `/seller/factories/${factoryId}/evidence`, { documentId: docA2 });
    expect(addedProof.json<FactoryBody>().factory.verification.status).toBe('VERIFIED');

    const changed = await call(a, 'PATCH', `/seller/factories/${factoryId}`, { monthlyCapacity: 90000 });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json<FactoryBody>().factory.verification.status).toBe('PENDING');
    expect(await publicFactories()).toEqual([]);
    // The verification it replaced is still there, no longer current.
    const verified = await prisma.sellerTrustCheck.count({ where: { subjectId: factoryId, state: 'VERIFIED', isCurrent: false } });
    expect(verified).toBe(1);
  });

  it('a verification past its end date is EXPIRED, recorded by the system, and hidden', async () => {
    const verified = await call(reviewer, 'POST', `/admin/seller-factories/${factoryId}/decision`, {
      decision: 'VERIFIED',
      expectedCheckId: await currentCheckId(),
    });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(await publicFactories()).toEqual(['Pune plant 1']);

    await prisma.sellerTrustCheck.updateMany({
      where: { subjectId: factoryId, isCurrent: true },
      data: { validUntil: new Date(Date.now() - 60_000) },
    });
    // Hidden at once, before anything has written the EXPIRED row.
    expect(await publicFactories()).toEqual([]);

    expect(await sweepExpiredFactories()).toBeGreaterThanOrEqual(1);
    const current = await prisma.sellerTrustCheck.findFirstOrThrow({ where: { subjectId: factoryId, isCurrent: true } });
    expect(current.state).toBe('EXPIRED');
    expect(current.decidedByUserId).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'seller_factory.expired', resourceId: factoryId, actorType: 'SYSTEM' } })).toBe(1);

    const mine = await call(a, 'GET', '/seller/factories');
    expect(mine.json<{ factories: FactoryBody['factory'][] }>().factories[0]!.verification.status).toBe('EXPIRED');
    const back = await call(a, 'POST', `/seller/factories/${factoryId}/submit`);
    expect(back.json<FactoryBody>().factory.verification.status).toBe('PENDING');
  });

  it('shows the reviewer the full history, with who decided', async () => {
    const response = await call(reviewer, 'GET', `/admin/sellers/${sellerA}/factories`);
    const factory = response.json<{ factories: FactoryBody['factory'][] }>().factories[0]!;
    expect(factory.history.length).toBeGreaterThanOrEqual(7);
    expect(JSON.stringify(factory.history)).toContain(EMAIL.reviewer.split('@')[0]!);
    expect(factory.evidence.map((row) => row.documentId).sort()).toEqual([docA, docA2].sort());
  });
});

describe('certificates', () => {
  it('needs the seller’s own document, sensible dates and no state field', async () => {
    const base = { standard: 'ISO 9001', issuer: 'TÜV SÜD', certificateNumber: 'Q-1', documentId: docA2, factoryId, expiresOn: '2099-01-01' };
    expect((await call(a, 'POST', '/seller/certifications', { ...base, documentId: docB })).statusCode).toBe(404);
    expect((await call(a, 'POST', '/seller/certifications', { ...base, expiresOn: '2020-01-01' })).statusCode).toBe(400);
    expect((await call(a, 'POST', '/seller/certifications', { ...base, state: 'VERIFIED' })).statusCode).toBe(400);
    const created = await call(a, 'POST', '/seller/certifications', base);
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{ certification: { id: string; state: string } }>();
    certificateId = body.certification.id;
    expect(body.certification.state).toBe('PENDING');
  });

  it('is refused with a reason, corrected and sent again, then verified and shown', async () => {
    const noReason = await call(reviewer, 'POST', `/admin/seller-certifications/${certificateId}/decision`, {
      decision: 'REJECTED',
      expectedState: 'PENDING',
    });
    expect(noReason.statusCode).toBe(400);
    const refused = await call(reviewer, 'POST', `/admin/seller-certifications/${certificateId}/decision`, {
      decision: 'REJECTED',
      expectedState: 'PENDING',
      reason: 'The scope on the certificate does not name valves.',
    });
    expect(refused.statusCode, refused.body).toBe(200);
    const mine = await call(a, 'GET', '/seller/certifications');
    const [row] = mine.json<{ certifications: { state: string; rejectionReason: string | null }[] }>().certifications;
    expect(row).toMatchObject({ state: 'REJECTED', rejectionReason: 'The scope on the certificate does not name valves.' });

    const stale = await call(reviewer2, 'POST', `/admin/seller-certifications/${certificateId}/decision`, {
      decision: 'VERIFIED',
      expectedState: 'PENDING',
    });
    expect(stale.statusCode).toBe(409);

    expect((await call(a, 'PATCH', `/seller/certifications/${certificateId}`, { scope: 'Valves and flanges' })).statusCode).toBe(200);
    expect((await call(a, 'POST', `/seller/certifications/${certificateId}/submit`)).statusCode).toBe(200);
    const verified = await call(reviewer, 'POST', `/admin/seller-certifications/${certificateId}/decision`, {
      decision: 'VERIFIED',
      expectedState: 'PENDING',
    });
    expect(verified.statusCode, verified.body).toBe(200);
    const page = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers/${PREFIX}alpha` });
    expect(page.json<{ supplier: { certifications: { standard: string }[] } }>().supplier.certifications.map((c) => c.standard)).toEqual(['ISO 9001']);
  });

  it('goes back to PENDING when a verified certificate is changed, and is locked there', async () => {
    const changed = await call(a, 'PATCH', `/seller/certifications/${certificateId}`, { certificateNumber: 'Q-2' });
    expect(changed.json<{ certification: { state: string } }>().certification.state).toBe('PENDING');
    const locked = await call(a, 'PATCH', `/seller/certifications/${certificateId}`, { certificateNumber: 'Q-3' });
    expect(code(locked)).toBe('CERTIFICATION_NOT_EDITABLE');
    const other = await call(b, 'PATCH', `/seller/certifications/${certificateId}`, { certificateNumber: 'Q-4' });
    expect(other.statusCode).toBe(404);
  });

  it('expires once past its expiry date, recorded by the system', async () => {
    await call(reviewer, 'POST', `/admin/seller-certifications/${certificateId}/decision`, { decision: 'VERIFIED', expectedState: 'PENDING' });
    await prisma.sellerCertification.update({ where: { id: certificateId }, data: { expiresOn: new Date('2021-01-01') } });
    const mine = await call(a, 'GET', '/seller/certifications');
    expect(mine.json<{ certifications: { state: string }[] }>().certifications[0]!.state).toBe('EXPIRED');
    const row = await prisma.sellerCertification.findUniqueOrThrow({ where: { id: certificateId } });
    expect(row.state).toBe('EXPIRED');
    expect(await prisma.auditLog.count({ where: { action: 'seller_certification.expired', resourceId: certificateId, actorType: 'SYSTEM' } })).toBe(1);
  });
});

describe('configured certificate expiry policy (UAT-UI-013)', () => {
  let previousPolicy: 'WARN' | 'HOLD_LISTINGS' | null = null;
  let offerId = '';
  let linkedProductId = '';
  let certId = '';

  beforeEach(async () => {
    previousPolicy = (await prisma.trustSettings.findUnique({ where: { id: 'default' } }))?.certificateExpiryPolicy ?? null;
    await prisma.trustSettings.upsert({ where: { id: 'default' }, create: { id: 'default', certificateExpiryPolicy: 'HOLD_LISTINGS' }, update: { certificateExpiryPolicy: 'HOLD_LISTINGS' } });
    const currency = await getBaseCurrency();
    linkedProductId = newId();
    offerId = newId();
    certId = newId();
    await prisma.product.create({ data: { id: linkedProductId, categoryId, taxClassId, name: 'Expiry policy valve', slug: `${PREFIX}expiry-${linkedProductId}`, sku: `EXP-${linkedProductId}`, basePriceMinor: 1000n, currency, status: 'ACTIVE', isPublished: true, publishedAt: new Date(), isMarketplaceProduct: true } });
    await prisma.sellerOffer.create({ data: { id: offerId, sellerAccountId: sellerA, productId: linkedProductId, sellerSku: `EXP-${offerId}`, status: 'ACTIVE', priceMinor: 900n, currency, availableQuantity: 10 } });
    await prisma.sellerCertification.create({ data: { id: certId, sellerAccountId: sellerA, standard: `ISO expiry ${certId}`, issuer: 'Fixture certifier', documentId: docA2, state: 'VERIFIED', expiresOn: new Date('2099-01-01') } });
    await prisma.sellerListingTrust.create({ data: { id: newId(), sellerAccountId: sellerA, productId: linkedProductId, certifications: { create: { id: newId(), certificationId: certId } } } });
  });

  afterEach(async () => {
    if (previousPolicy === null) await prisma.trustSettings.deleteMany({ where: { id: 'default' } });
    else await prisma.trustSettings.update({ where: { id: 'default' }, data: { certificateExpiryPolicy: previousPolicy } });
  });

  async function expire(): Promise<void> {
    await prisma.sellerCertification.update({ where: { id: certId }, data: { expiresOn: new Date('2021-01-01') } });
    const response = await call(a, 'GET', '/seller/certifications');
    expect(response.statusCode, response.body).toBe(200);
  }

  async function renew(id = certId): Promise<void> {
    const changed = await call(a, 'PATCH', `/seller/certifications/${id}`, { expiresOn: '2099-01-01', documentId: docA2 });
    expect(changed.statusCode, changed.body).toBe(200);
    const submitted = await call(a, 'POST', `/seller/certifications/${id}/submit`);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const decision = await call(reviewer, 'POST', `/admin/seller-certifications/${id}/decision`, { decision: 'VERIFIED', expectedState: 'PENDING' });
    expect(decision.statusCode, decision.body).toBe(200);
  }

  it('WARN drops the expired public certificate, not the listing, and notifies only once', async () => {
    await prisma.trustSettings.update({ where: { id: 'default' }, data: { certificateExpiryPolicy: 'WARN' } });
    const before = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers/${PREFIX}alpha` });
    expect(before.json<{ supplier: { certifications: { standard: string }[] } }>().supplier.certifications.some(row => row.standard === `ISO expiry ${certId}`)).toBe(true);
    await expire();
    await call(a, 'GET', '/seller/certifications');
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('ACTIVE');
    expect(await prisma.sellerOfferComplianceHold.count({ where: { offerId } })).toBe(0);
    const after = await app.inject({ method: 'GET', url: `/api/v1/catalog/suppliers/${PREFIX}alpha` });
    expect(after.json<{ supplier: { certifications: { standard: string }[] } }>().supplier.certifications.some(row => row.standard === `ISO expiry ${certId}`)).toBe(false);
    expect(await prisma.sellerNotification.count({ where: { sellerAccountId: sellerA, subjectId: certId, kind: 'DOCUMENT_EXPIRING' } })).toBe(1);
  });

  it('holds only the linked seller offers, refuses another seller and pause/resume bypass, then preserves the seller pause after verification', async () => {
    const otherId = newId();
    const currency = await getBaseCurrency();
    await prisma.sellerOffer.create({ data: { id: otherId, sellerAccountId: sellerB, productId: linkedProductId, sellerSku: `OTHER-${otherId}`, status: 'ACTIVE', priceMinor: 800n, currency } });
    await expire();
    await call(a, 'GET', '/seller/certifications');
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('NEEDS_CHANGES');
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: otherId } })).status).toBe('ACTIVE');
    expect(await prisma.sellerOfferComplianceHold.count({ where: { offerId, releasedAt: null } })).toBe(1);
    expect((await call(b, 'PATCH', `/seller/listings/${offerId}/status`, { status: 'ACTIVE' })).statusCode).toBe(404);
    expect((await call(a, 'PATCH', `/seller/listings/${offerId}/status`, { status: 'PAUSED' })).statusCode).toBe(204);
    const bypass = await call(a, 'PATCH', `/seller/listings/${offerId}/status`, { status: 'ACTIVE' });
    expect(code(bypass)).toBe('LISTING_TRANSITION_NOT_ALLOWED');
    await renew();
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('PAUSED');
    expect(await prisma.sellerOfferComplianceHold.count({ where: { offerId, releasedAt: null } })).toBe(0);
  });

  it('does not restore an offer until every linked expired certificate is renewed', async () => {
    const second = newId();
    await prisma.sellerCertification.create({ data: { id: second, sellerAccountId: sellerA, standard: 'Second expiry certificate', issuer: 'Fixture certifier', documentId: docA2, state: 'VERIFIED', expiresOn: new Date('2021-01-01') } });
    const trust = await prisma.sellerListingTrust.findUniqueOrThrow({ where: { sellerAccountId_productId: { sellerAccountId: sellerA, productId: linkedProductId } } });
    await prisma.sellerListingCertification.create({ data: { id: newId(), listingTrustId: trust.id, certificationId: second } });
    await expire();
    expect(await prisma.sellerOfferComplianceHold.count({ where: { offerId, releasedAt: null } })).toBe(2);
    await renew();
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('NEEDS_CHANGES');
    await renew(second);
    expect((await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } })).status).toBe('ACTIVE');
  });

  it('keeps a later marketplace block and releases the certificate hold without putting it on sale', async () => {
    await expire();
    await prisma.sellerOffer.update({ where: { id: offerId }, data: { status: 'BLOCKED', statusReason: 'Fixture marketplace safety block' } });
    await renew();
    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe('BLOCKED');
    expect(offer.statusReason).toBe('Fixture marketplace safety block');
    expect(await prisma.sellerOfferComplianceHold.count({ where: { offerId, releasedAt: null } })).toBe(0);
  });

  it('refuses putting an idle listing on sale while its linked certificate has expired', async () => {
    await prisma.sellerOffer.update({ where: { id: offerId }, data: { status: 'PAUSED', statusReason: 'Seller holiday' } });
    await expire();
    expect(await prisma.sellerOfferComplianceHold.count({ where: { offerId } })).toBe(0);
    expect(code(await call(a, 'PATCH', `/seller/listings/${offerId}/status`, { status: 'ACTIVE' }))).toBe('LISTING_TRANSITION_NOT_ALLOWED');
    await renew();
    const offer = await prisma.sellerOffer.findUniqueOrThrow({ where: { id: offerId } });
    expect(offer.status).toBe('PAUSED');
    expect(offer.statusReason).toBe('Seller holiday');
    expect((await call(a, 'PATCH', `/seller/listings/${offerId}/status`, { status: 'ACTIVE' })).statusCode).toBe(204);
  });
});
