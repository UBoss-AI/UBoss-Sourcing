/**
 * Buyer companies, end to end over HTTP: sign-in with a tab, the company
 * application from draft to approval, the review console, the purchasing
 * gate, and the isolation between one person's two buying contexts and
 * between companies.
 *
 * Each `it` builds on the one before - the application moves through its
 * states in order - so the file runs top to bottom and cleans up after
 * itself in `afterAll` (orders are ON DELETE RESTRICT and would break the
 * next file otherwise).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { currentTermsId } from '../support/legal.js';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { runAutomatedChecksJob } from '../../src/modules/buyer-companies/checks.service.js';
import { getOrCreateCart } from '../../src/modules/cart/cart.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'BuyerCompany!2026x';
const STAFF_PASSWORD = 'BuyerCompanyStaff!2026';
const EMAIL = {
  alice: 'bc-alice@test.local',
  bob: 'bc-bob@test.local',
  carol: 'bc-carol@test.local',
  owner: 'bc-owner@test.local',
  finance: 'bc-finance@test.local',
  orders: 'bc-orders@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);
const ADDRESS = { line1: 'ul. Test 1', city: 'Warszawa', postalCode: '00-001', country: 'PL' };

const users: Record<string, { userId: string; profileId: string }> = {};
let companyId = '';
let bobCompanyId = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Session {
  cookie: string;
  csrf: string;
  login: Record<string, unknown>;
}

function cookiesOf(response: LightMyRequestResponse): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return jar;
}

async function signIn(email: string, buyerType?: 'individual' | 'company'): Promise<Session> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    payload: { email, password: PASSWORD, ...(buyerType === undefined ? {} : { buyerType }) },
  });
  expect(response.statusCode, response.body).toBe(200);
  const jar = cookiesOf(response);
  return {
    cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    csrf: jar.get('uboss_shop_csrf') ?? '',
    login: response.json<Record<string, unknown>>(),
  };
}

async function call(
  session: Session | AdminSession,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const isAdmin = 'cookies' in session;
  return app.inject({
    method,
    url,
    headers: {
      cookie: isAdmin ? session.cookies : session.cookie,
      'x-csrf-token': isAdmin ? session.csrfToken : session.csrf,
      ...extraHeaders,
    },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function code(response: LightMyRequestResponse): string | undefined {
  return response.json<{ error?: { code: string } }>().error?.code;
}

/** A multipart body with the fields first and one file, as a browser sends it. */
function multipart(fields: Record<string, string>, file: { name: string; type: string; data: Buffer }): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----bcboundary${String(Date.now())}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function upload(session: Session, id: string, kind: string, file: { name: string; type: string; data: Buffer }): Promise<LightMyRequestResponse> {
  const body = multipart({ kind }, file);
  return app.inject({
    method: 'POST',
    url: `/api/v1/buyer-companies/${id}/documents`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, ...body.headers },
    payload: body.payload,
  });
}

const PLAIN_PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF\n', 'latin1');

/** A complete Polish KRS application. */
const COMPLETE = {
  business: {
    legalName: 'Acme Polska Sp. z o.o.',
    tradingName: '<img src=x onerror=alert(1)>',
    entityType: 'PRIVATE_LIMITED_COMPANY',
    registrationCountry: 'PL',
    registrationNumber: '0000019193',
    incorporationDate: '2001-06-11',
    industry: 'HEALTHCARE',
    website: 'acme.pl',
    businessPhone: '+48 22 123 45 67',
  },
  applicant: { jobTitle: 'Head of procurement', relationship: 'EMPLOYEE', authorityConfirmed: true },
  addresses: [
    { kind: 'REGISTERED_OFFICE', line1: 'Aleje Jerozolimskie 142A', city: 'Warszawa', postalCode: '02-305', countryCode: 'PL' },
    { kind: 'OPERATING', remove: true },
    { kind: 'BILLING', line1: 'Aleje Jerozolimskie 142A', city: 'Warszawa', postalCode: '02-305', countryCode: 'PL' },
    { kind: 'SHIPPING', line1: 'ul. Magazynowa 5', city: 'Pruszków', postalCode: '05-800', countryCode: 'PL' },
  ],
  identifiers: [
    { scheme: 'PL_NIP', value: '526-025-02-74', notApplicable: false, notApplicableReason: null },
    { scheme: 'PL_REGON', value: '000002217', notApplicable: false, notApplicableReason: null },
    { scheme: 'EU_VAT', value: null, notApplicable: true, notApplicableReason: 'EXEMPT' },
  ],
};

const CONSENTS = { ACCURACY_DECLARATION: true, BUSINESS_TERMS: true, PRIVACY_NOTICE: true, AUTHORITY_TO_ACT: true };

async function placeOrder(profileId: string, buyerCompanyId: string | null, reference: string): Promise<string> {
  const id = newId();
  await prisma.order.create({
    data: {
      id,
      orderNumber: reference,
      customerProfileId: profileId,
      buyerCompanyId,
      status: 'PENDING_PAYMENT',
      currency: 'EUR',
      subtotalMinor: 10_000n,
      grandTotalMinor: 10_000n,
      billingAddressJson: ADDRESS,
      shippingAddressJson: ADDRESS,
      placedAt: new Date(),
    },
  });
  return id;
}

async function cleanUp(): Promise<void> {
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })).map((row) => row.id);
  const companyIds = (await prisma.buyerCompany.findMany({ where: { createdByUserId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'UB-BCTEST-' } } });
  await prisma.cart.deleteMany({ where: { OR: [{ buyerCompanyId: { in: companyIds } }, { customerProfile: { userId: { in: userIds } } }] } });
  await prisma.address.deleteMany({ where: { OR: [{ buyerCompanyId: { in: companyIds } }, { customerProfile: { userId: { in: userIds } } }] } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.buyerCompany.deleteMany({ where: { id: { in: companyIds } } });
  await prisma.jobQueue.deleteMany({ where: { jobType: 'buyer_company.checks' } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: ALL_EMAILS } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

async function createCustomer(email: string): Promise<{ userId: string; profileId: string }> {
  const userId = newId();
  const profileId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'CUSTOMER', email, emailNormalized: email, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: email.split('@')[0] ?? 'Buyer' } });
  return { userId, profileId };
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

const staff = (email: string): Promise<AdminSession> => signInAdmin(app, { email, password: STAFF_PASSWORD });

async function version(id: string): Promise<number> {
  return (await prisma.buyerCompany.findUniqueOrThrow({ where: { id }, select: { version: true } })).version;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  for (const name of ['alice', 'bob', 'carol'] as const) users[name] = await createCustomer(EMAIL[name]);
  await createStaff(EMAIL.owner, Role.BUSINESS_OWNER);
  await createStaff(EMAIL.finance, Role.FINANCE_APPROVER);
  await createStaff(EMAIL.orders, Role.ORDER_MANAGER);
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('sign-in with an Individual and a Company tab', () => {
  it('gives the same generic refusal on either tab, for a wrong password and an unknown address', async () => {
    const attempts = [
      { email: EMAIL.alice, password: 'wrong-password-123', buyerType: 'individual' },
      { email: EMAIL.alice, password: 'wrong-password-123', buyerType: 'company' },
      { email: 'bc-nobody@test.local', password: 'wrong-password-123', buyerType: 'company' },
    ];
    const answers = await Promise.all(attempts.map((payload) => app.inject({ method: 'POST', url: '/api/v1/auth/login', payload })));
    for (const answer of answers) {
      expect(answer.statusCode).toBe(401);
      expect(answer.json<{ error: { code: string; message: string } }>().error).toMatchObject({ code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    }
  });

  it('signs a person with no company in on the Company tab as themselves, and says so', async () => {
    const session = await signIn(EMAIL.alice, 'company');
    expect(session.login['next']).toBe('NO_COMPANY');
    expect(session.login['buyerContext']).toEqual({ kind: 'INDIVIDUAL' });
    const me = await call(session, 'GET', '/api/v1/auth/me');
    expect(me.json<{ buyerContext: unknown; type: string }>()).toMatchObject({ buyerContext: { kind: 'INDIVIDUAL' }, type: 'CUSTOMER' });
  });

  it('refuses a buyer-context switch without the CSRF header', async () => {
    const session = await signIn(EMAIL.alice);
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/buyer-context',
      headers: { cookie: session.cookie },
      payload: { kind: 'INDIVIDUAL' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('the company application', () => {
  it('opens a draft with the applicant as OWNER and pre-fills their verified email', async () => {
    const session = await signIn(EMAIL.alice);
    const created = await call(session, 'POST', '/api/v1/buyer-companies', { registrationCountry: 'PL' });
    expect(created.statusCode, created.body).toBe(201);
    const body = created.json<{ id: string; status: string; role: string; reference: string; business: { businessEmail: string } }>();
    expect(body).toMatchObject({ status: 'DRAFT', role: 'OWNER', business: { businessEmail: EMAIL.alice } });
    expect(body.reference).toMatch(/^BC-[0-9A-Z]{8}$/);
    companyId = body.id;
  });

  it('refuses a malformed NIP on the step it was typed and saves nothing', async () => {
    const session = await signIn(EMAIL.alice);
    const refused = await call(session, 'PATCH', `/api/v1/buyer-companies/${companyId}`, {
      business: { legalName: 'Should not be saved', entityType: 'PRIVATE_LIMITED_COMPANY' },
      identifiers: [{ scheme: 'PL_NIP', value: '5260250275', notApplicable: false, notApplicableReason: null }],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json<{ error: { details: { field: string; code: string }[] } }>().error.details).toContainEqual({ field: 'identifiers.0.value', code: 'NIP_CHECKSUM' });
    expect((await prisma.buyerCompany.findUniqueOrThrow({ where: { id: companyId } })).legalName).toBeNull();
  });

  it('refuses "not applicable" on a number the law requires', async () => {
    const session = await signIn(EMAIL.alice);
    const refused = await call(session, 'PATCH', `/api/v1/buyer-companies/${companyId}`, {
      business: { entityType: 'PRIVATE_LIMITED_COMPANY' },
      identifiers: [{ scheme: 'PL_NIP', value: null, notApplicable: true, notApplicableReason: 'NOT_REGISTERED' }],
    });
    expect(refused.statusCode).toBe(400);
  });

  it('saves every step, and the saved draft reads back the same (save and resume)', async () => {
    const session = await signIn(EMAIL.alice);
    const saved = await call(session, 'PATCH', `/api/v1/buyer-companies/${companyId}`, COMPLETE);
    expect(saved.statusCode, saved.body).toBe(200);
    const resumed = await call(await signIn(EMAIL.alice), 'GET', `/api/v1/buyer-companies/${companyId}`);
    const body = resumed.json<{ problems: unknown[]; business: { tradingName: string; registrationNumber: string }; identifiers: { scheme: string; value: string | null }[]; addresses: unknown[] }>();
    expect(body.problems).toEqual([]);
    // Stored as the text that was typed - never interpreted as markup.
    expect(body.business.tradingName).toBe('<img src=x onerror=alert(1)>');
    expect(body.identifiers.find((row) => row.scheme === 'PL_NIP')?.value).toBe('526-025-02-74');
    expect(body.addresses).toHaveLength(3);
  });

  it('keeps the application private to its members', async () => {
    const carol = await signIn(EMAIL.carol);
    expect((await call(carol, 'GET', `/api/v1/buyer-companies/${companyId}`)).statusCode).toBe(404);
    expect((await call(carol, 'PATCH', `/api/v1/buyer-companies/${companyId}`, { business: { legalName: 'Hijacked' } })).statusCode).toBe(404);
    const hijack = await call(carol, 'PUT', '/api/v1/auth/buyer-context', { kind: 'COMPANY', companyId });
    expect(hijack.statusCode).toBe(403);
    expect(code(hijack)).toBe('BUYER_CONTEXT_INVALID');
  });

  it('needs every one of the four declarations, then submits and records each separately', async () => {
    const session = await signIn(EMAIL.alice);
    const missing = await call(session, 'POST', `/api/v1/buyer-companies/${companyId}/submit`, { consents: { ...CONSENTS, PRIVACY_NOTICE: false } });
    expect(missing.statusCode).toBe(400);

    const submitted = await call(session, 'POST', `/api/v1/buyer-companies/${companyId}/submit`, { consents: CONSENTS });
    expect(submitted.statusCode, submitted.body).toBe(200);
    // The business email is the verified sign-in address, so no code was needed.
    expect(submitted.json<{ status: string; business: { businessEmailVerified: boolean } }>()).toMatchObject({ status: 'SUBMITTED', business: { businessEmailVerified: true } });

    const consents = await prisma.consentRecord.findMany({ where: { companyId } });
    expect(consents.map((row) => row.purpose).sort()).toEqual(['ACCURACY_DECLARATION', 'AUTHORITY_TO_ACT', 'BUSINESS_TERMS', 'PRIVACY_NOTICE']);
    expect(consents.every((row) => row.textHash.length === 64 && row.textVersion.length > 0)).toBe(true);
    expect(await prisma.jobQueue.count({ where: { jobType: 'buyer_company.checks' } })).toBeGreaterThan(0);
  });

  it('cannot be changed while it is with a reviewer', async () => {
    const session = await signIn(EMAIL.alice);
    const refused = await call(session, 'PATCH', `/api/v1/buyer-companies/${companyId}`, { business: { legalName: 'Late edit' } });
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('BUYER_COMPANY_NOT_EDITABLE');
  });

  it('runs the registry checks and puts the application in front of a person, never deciding it', async () => {
    await runAutomatedChecksJob(companyId, null);
    const company = await prisma.buyerCompany.findUniqueOrThrow({ where: { id: companyId }, include: { checks: true, statusHistory: true } });
    expect(company.status).toBe('UNDER_REVIEW');
    expect(company.statusHistory.map((row) => row.toStatus)).toEqual(['SUBMITTED', 'AUTOMATED_CHECK_IN_PROGRESS', 'UNDER_REVIEW']);
    // Registries are switched off in tests: every one is an honest manual
    // check, none is a failure.
    expect(company.checks.some((check) => check.outcome === 'FAIL')).toBe(false);
    expect(company.checks.filter((check) => check.provider === 'PL_KRS' || check.provider === 'PL_VAT_REGISTER').every((check) => check.outcome === 'MANUAL_REQUIRED')).toBe(true);
  });
});

describe('buying for a company that is not approved yet', () => {
  it('signs the owner into the company context and refuses checkout with a reason the storefront can explain', async () => {
    const session = await signIn(EMAIL.alice, 'company');
    expect(session.login['next']).toBe('READY');
    expect(session.login['buyerContext']).toMatchObject({ kind: 'COMPANY', companyId, companyStatus: 'UNDER_REVIEW', role: 'OWNER' });

    const checkout = await call(session, 'POST', '/api/v1/cart/checkout', { shippingAddressId: newId(), paymentMode: 'ONLINE', acceptedTerms: true, termsDocumentId: await currentTermsId() }, { 'idempotency-key': newId() });
    expect(checkout.statusCode).toBe(403);
    const error = checkout.json<{ error: { code: string; details: { meta: { status: string } }[] } }>().error;
    expect(error.code).toBe('BUYER_COMPANY_NOT_APPROVED');
    expect(error.details[0]?.meta.status).toBe('UNDER_REVIEW');
  });

  it('keeps the company basket and the personal basket apart', async () => {
    const own = await getOrCreateCart(users['alice']?.profileId ?? '');
    const company = await getOrCreateCart({ customerProfileId: users['alice']?.profileId ?? '', buyerCompanyId: companyId });
    expect(own).not.toBe(company);
    expect(await getOrCreateCart({ customerProfileId: users['alice']?.profileId ?? '', buyerCompanyId: null })).toBe(own);
  });

  it('refuses recurring orders while buying for a company', async () => {
    const session = await signIn(EMAIL.alice, 'company');
    const response = await call(session, 'GET', '/api/v1/recurring-schedules');
    expect(response.statusCode).toBe(403);
    expect(code(response)).toBe('BUYER_CONTEXT_UNSUPPORTED');
  });
});

describe('the review console', () => {
  it('is closed to customers and to staff without the grant', async () => {
    const alice = await signIn(EMAIL.alice);
    const asCustomer = await app.inject({ method: 'GET', url: '/api/v1/admin/buyer-companies', headers: { cookie: alice.cookie } });
    expect(asCustomer.statusCode).toBe(401);

    const orders = await staff(EMAIL.orders);
    expect((await call(orders, 'GET', '/api/v1/admin/buyer-companies')).statusCode).toBe(200);
    const approve = await call(orders, 'POST', `/api/v1/admin/buyer-companies/${companyId}/approve`, { expectedVersion: await version(companyId) });
    expect(approve.statusCode).toBe(403);
    expect(code(approve)).toBe('PERMISSION_DENIED');
  });

  it('finds the application in the queue, and survives a hostile search string', async () => {
    const finance = await staff(EMAIL.finance);
    const queue = await call(finance, 'GET', '/api/v1/admin/buyer-companies?status=UNDER_REVIEW&country=PL&search=Acme');
    const body = queue.json<{ rows: { id: string }[]; counts: Record<string, number> }>();
    expect(body.rows.map((row) => row.id)).toContain(companyId);
    expect(body.counts['UNDER_REVIEW']).toBeGreaterThanOrEqual(1);
    const injection = await call(finance, 'GET', `/api/v1/admin/buyer-companies?search=${encodeURIComponent("' OR 1=1; DROP TABLE users; --")}`);
    expect(injection.statusCode).toBe(200);
    expect(injection.json<{ rows: unknown[] }>().rows).toEqual([]);
  });

  it('keeps internal notes out of the applicant\'s view', async () => {
    const finance = await staff(EMAIL.finance);
    const noted = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${companyId}/notes`, { note: 'SECRET: call the CFO before approving.' });
    expect(noted.statusCode, noted.body).toBe(200);
    expect(noted.body).toContain('SECRET');
    const applicant = await call(await signIn(EMAIL.alice), 'GET', `/api/v1/buyer-companies/${companyId}`);
    expect(applicant.body).not.toContain('SECRET');
    expect(applicant.body).not.toContain('"checks"');
  });

  it('refuses a decision made on a stale version', async () => {
    const finance = await staff(EMAIL.finance);
    const stale = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${companyId}/request-information`, {
      expectedVersion: (await version(companyId)) - 1,
      message: 'Please send an authorisation letter.',
      documentKinds: ['AUTHORIZATION_LETTER'],
    });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('BUYER_COMPANY_VERSION_CONFLICT');
  });

  it('sends the application back with a question and named documents', async () => {
    const finance = await staff(EMAIL.finance);
    const sent = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${companyId}/request-information`, {
      expectedVersion: await version(companyId),
      message: 'You are not listed on the KRS board. Please send an authorisation letter.',
      documentKinds: ['AUTHORIZATION_LETTER'],
    });
    expect(sent.statusCode, sent.body).toBe(200);
    expect(sent.json<{ status: string }>().status).toBe('MORE_INFORMATION_REQUIRED');
  });

  it('rejects a rejection without a reason code', async () => {
    const owner = await staff(EMAIL.owner);
    const refused = await call(owner, 'POST', `/api/v1/admin/buyer-companies/${companyId}/reject`, { expectedVersion: await version(companyId), reason: 'No.' });
    expect(refused.statusCode).toBe(400);
  });
});

describe('answering the reviewer', () => {
  it('refuses files that are not documents and kinds nobody asked for', async () => {
    const session = await signIn(EMAIL.alice);
    const text = await upload(session, companyId, 'AUTHORIZATION_LETTER', { name: 'letter.pdf', type: 'application/pdf', data: Buffer.from('this is not a pdf') });
    expect(text.statusCode).toBe(400);
    expect(code(text)).toBe('BUYER_COMPANY_DOCUMENT_REJECTED');

    const script = await upload(session, companyId, 'AUTHORIZATION_LETTER', {
      name: 'letter.pdf',
      type: 'application/pdf',
      data: Buffer.from('%PDF-1.7\n1 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>\n%%EOF\n', 'latin1'),
    });
    expect(script.statusCode).toBe(400);

    const identity = await upload(session, companyId, 'REPRESENTATIVE_IDENTITY', { name: 'id.pdf', type: 'application/pdf', data: PLAIN_PDF });
    expect(identity.statusCode).toBe(403);
  });

  it('accepts the requested document under a generated name', async () => {
    const session = await signIn(EMAIL.alice);
    const uploaded = await upload(session, companyId, 'AUTHORIZATION_LETTER', { name: '../../etc/passwd.pdf', type: 'text/html', data: PLAIN_PDF });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const document = await prisma.buyerCompanyDocument.findFirstOrThrow({ where: { companyId, kind: 'AUTHORIZATION_LETTER' } });
    expect(document.mimeType).toBe('application/pdf');
    expect(document.storageKey).not.toContain('passwd');
    expect(document.pageCount).toBe(1);
  });

  it('needs the request answered before resubmitting', async () => {
    const session = await signIn(EMAIL.alice);
    const early = await call(session, 'POST', `/api/v1/buyer-companies/${companyId}/resubmit`);
    expect(early.statusCode).toBe(400);

    const request = await prisma.buyerCompanyInfoRequest.findFirstOrThrow({ where: { companyId, status: 'OPEN' } });
    const answered = await call(session, 'POST', `/api/v1/buyer-companies/${companyId}/info-requests/${request.id}/answer`, { message: 'Letter signed by the board attached.' });
    expect(answered.statusCode, answered.body).toBe(200);
    const resubmitted = await call(session, 'POST', `/api/v1/buyer-companies/${companyId}/resubmit`);
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    expect(resubmitted.json<{ status: string }>().status).toBe('RESUBMITTED');
  });
});

describe('approval and after', () => {
  it('lets a reviewer start the review, see the document through a single-use link, and approve', async () => {
    const finance = await staff(EMAIL.finance);
    const started = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${companyId}/start-review`, {});
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json<{ status: string; currentCase: { assignedReviewer: { email: string } } }>()).toMatchObject({ status: 'UNDER_REVIEW', currentCase: { assignedReviewer: { email: EMAIL.finance } } });

    const document = await prisma.buyerCompanyDocument.findFirstOrThrow({ where: { companyId, status: 'PENDING_REVIEW' } });
    const link = (await call(finance, 'POST', `/api/v1/admin/buyer-company-documents/${document.id}/link`)).json<{ url: string }>();
    // Unscanned files are not served in tests (no ClamAV), so the link is
    // refused - which is the control working. Allow it for this check only.
    vi.spyOn(env, 'BUYER_COMPANY_ALLOW_UNSCANNED_DOCUMENTS', 'get').mockReturnValue(true);
    const again = (await call(finance, 'POST', `/api/v1/admin/buyer-company-documents/${document.id}/link`)).json<{ url: string }>();
    const path = again.url.replace(/^\/api\/v1/, '/api/v1');
    const first = await call(finance, 'GET', path);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-disposition']).toMatch(/^attachment;/);
    expect(first.headers['x-content-type-options']).toBe('nosniff');
    expect((await call(finance, 'GET', path)).statusCode).toBe(403);
    vi.restoreAllMocks();
    void link;

    const approved = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${companyId}/approve`, { expectedVersion: await version(companyId), reason: null });
    expect(approved.statusCode, approved.body).toBe(200);
    const company = await prisma.buyerCompany.findUniqueOrThrow({ where: { id: companyId }, include: { identifiers: true } });
    expect(company.status).toBe('APPROVED');
    expect(company.registrationClaimKey).toBe('PL:0000019193');
    expect(company.identifiers.filter((row) => row.claimKey !== null).map((row) => row.scheme).sort()).toEqual(['PL_NIP', 'PL_REGON']);
    // The verified billing and shipping addresses became the company's book.
    expect(await prisma.address.count({ where: { buyerCompanyId: companyId } })).toBe(2);
  });

  it('now lets the company past the purchasing gate', async () => {
    const session = await signIn(EMAIL.alice, 'company');
    const checkout = await call(session, 'POST', '/api/v1/cart/checkout', { shippingAddressId: newId(), paymentMode: 'ONLINE', acceptedTerms: true, termsDocumentId: await currentTermsId() }, { 'idempotency-key': newId() });
    // Refused for the basket (empty, or no such address), not for the company.
    expect(code(checkout)).not.toBe('BUYER_COMPANY_NOT_APPROVED');
  });

  it('keeps individual orders and company orders apart, and other buyers out of both', async () => {
    const profileId = users['alice']?.profileId ?? '';
    const own = await placeOrder(profileId, null, 'UB-BCTEST-OWN');
    const forCompany = await placeOrder(profileId, companyId, 'UB-BCTEST-COMPANY');

    const individual = await signIn(EMAIL.alice);
    const ownList = (await call(individual, 'GET', '/api/v1/orders')).json<{ orders: { id: string }[] }>().orders.map((row) => row.id);
    expect(ownList).toContain(own);
    expect(ownList).not.toContain(forCompany);
    expect((await call(individual, 'GET', `/api/v1/orders/${forCompany}`)).statusCode).toBe(404);

    const company = await signIn(EMAIL.alice, 'company');
    const companyList = (await call(company, 'GET', '/api/v1/orders')).json<{ orders: { id: string }[] }>().orders.map((row) => row.id);
    expect(companyList).toEqual([forCompany]);
    expect((await call(company, 'GET', `/api/v1/orders/${own}`)).statusCode).toBe(404);

    const carol = await signIn(EMAIL.carol);
    expect((await call(carol, 'GET', `/api/v1/orders/${forCompany}`)).statusCode).toBe(404);
  });

  it('offers a selector to somebody in two companies, and drops a context the moment its membership ends', async () => {
    const bob = await signIn(EMAIL.bob);
    const created = await call(bob, 'POST', '/api/v1/buyer-companies', { registrationCountry: 'PL' });
    bobCompanyId = created.json<{ id: string }>().id;
    await prisma.buyerCompanyMember.create({ data: { id: newId(), companyId, userId: users['bob']?.userId ?? '', role: 'BUYER' } });

    const signedIn = await signIn(EMAIL.bob, 'company');
    expect(signedIn.login['next']).toBe('CHOOSE_COMPANY');
    expect(signedIn.login['buyerContext']).toEqual({ kind: 'INDIVIDUAL' });

    const switched = await call(signedIn, 'PUT', '/api/v1/auth/buyer-context', { kind: 'COMPANY', companyId });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json<{ buyerContext: { role: string } }>().buyerContext.role).toBe('BUYER');

    // A BUYER sees only the company orders they placed - none.
    expect((await call(signedIn, 'GET', '/api/v1/orders')).json<{ orders: unknown[] }>().orders).toEqual([]);

    await prisma.buyerCompanyMember.updateMany({ where: { companyId, userId: users['bob']?.userId ?? '' }, data: { status: 'REMOVED', removedAt: new Date() } });
    const after = await call(signedIn, 'GET', '/api/v1/cart');
    expect(after.statusCode).toBe(403);
    expect(code(after)).toBe('BUYER_CONTEXT_INVALID');
    const me = await call(signedIn, 'GET', '/api/v1/auth/me');
    expect(me.json<{ buyerContext: unknown }>().buyerContext).toEqual({ kind: 'INDIVIDUAL' });
  });

  it('flags a second application for the same registration and refuses to approve it twice', async () => {
    const bob = await signIn(EMAIL.bob);
    const saved = await call(bob, 'PATCH', `/api/v1/buyer-companies/${bobCompanyId}`, { ...COMPLETE, business: { ...COMPLETE.business, legalName: 'ACME POLSKA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ' } });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await call(bob, 'POST', `/api/v1/buyer-companies/${bobCompanyId}/submit`, { consents: CONSENTS })).statusCode).toBe(200);

    vi.spyOn(env, 'BUYER_COMPANY_SECOND_REVIEW_RISK', 'get').mockReturnValue('HIGH');
    await runAutomatedChecksJob(bobCompanyId, (await prisma.buyerCompanyVerificationCase.findFirstOrThrow({ where: { companyId: bobCompanyId } })).id);
    vi.restoreAllMocks();

    const company = await prisma.buyerCompany.findUniqueOrThrow({ where: { id: bobCompanyId }, include: { checks: true } });
    expect(company.riskLevel).toBe('HIGH');
    const duplicates = company.checks.filter((check) => check.provider === 'DUPLICATES').map((check) => check.subject);
    expect(duplicates).toEqual(expect.arrayContaining(['REGISTRATION', 'PL_NIP']));

    // High risk needs two different reviewers.
    const finance = await staff(EMAIL.finance);
    const first = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${bobCompanyId}/approve`, { expectedVersion: await version(bobCompanyId), reason: null });
    expect(first.json<{ awaitingSecondReview?: boolean; status: string }>()).toMatchObject({ awaitingSecondReview: true, status: 'UNDER_REVIEW' });
    const same = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${bobCompanyId}/approve`, { expectedVersion: await version(bobCompanyId), reason: null });
    expect(code(same)).toBe('BUYER_COMPANY_SECOND_REVIEW_REQUIRED');

    // A second reviewer is not enough either: the registration is taken.
    const owner = await staff(EMAIL.owner);
    const second = await call(owner, 'POST', `/api/v1/admin/buyer-companies/${bobCompanyId}/approve`, { expectedVersion: await version(bobCompanyId), reason: null });
    expect(second.statusCode).toBe(409);
    expect(code(second)).toBe('BUYER_COMPANY_ALREADY_CLAIMED');
    expect((await prisma.buyerCompany.findUniqueOrThrow({ where: { id: bobCompanyId } })).status).toBe('UNDER_REVIEW');
  });

  it('lets only the suspend grant stop a trading company, and stops its checkout at once', async () => {
    const finance = await staff(EMAIL.finance);
    const refused = await call(finance, 'POST', `/api/v1/admin/buyer-companies/${companyId}/suspend`, { expectedVersion: await version(companyId), reason: 'Payment dispute.' });
    expect(refused.statusCode).toBe(403);

    const owner = await staff(EMAIL.owner);
    const suspended = await call(owner, 'POST', `/api/v1/admin/buyer-companies/${companyId}/suspend`, { expectedVersion: await version(companyId), reason: 'Payment dispute under investigation.' });
    expect(suspended.statusCode, suspended.body).toBe(200);

    const session = await signIn(EMAIL.alice, 'company');
    const checkout = await call(session, 'POST', '/api/v1/cart/checkout', { shippingAddressId: newId(), paymentMode: 'ONLINE', acceptedTerms: true, termsDocumentId: await currentTermsId() }, { 'idempotency-key': newId() });
    expect(code(checkout)).toBe('BUYER_COMPANY_NOT_APPROVED');
    // The individual context is untouched.
    const individual = await signIn(EMAIL.alice);
    const own = await call(individual, 'POST', '/api/v1/cart/checkout', { shippingAddressId: newId(), paymentMode: 'ONLINE', acceptedTerms: true, termsDocumentId: await currentTermsId() }, { 'idempotency-key': newId() });
    expect(code(own)).not.toBe('BUYER_COMPANY_NOT_APPROVED');
  });

  it('keeps every step on an append-only history', async () => {
    const history = await prisma.buyerCompanyStatusHistory.findMany({ where: { companyId }, orderBy: { createdAt: 'asc' } });
    expect(history.map((row) => row.toStatus)).toEqual([
      'SUBMITTED',
      'AUTOMATED_CHECK_IN_PROGRESS',
      'UNDER_REVIEW',
      'MORE_INFORMATION_REQUIRED',
      'RESUBMITTED',
      'UNDER_REVIEW',
      'APPROVED',
      'SUSPENDED',
    ]);
    expect(await prisma.auditLog.count({ where: { resourceId: companyId, action: 'buyer_company.status_changed' } })).toBe(8);
  });
});
