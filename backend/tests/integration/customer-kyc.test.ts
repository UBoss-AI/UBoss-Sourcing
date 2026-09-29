/**
 * An individual buyer's identity check, importer details and marketing
 * choices, end to end over HTTP (checklist Master row 11).
 *
 * Each `it` builds on the one before - the check moves through its states in
 * order - and the file cleans up after itself in `afterAll`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'CustomerKyc!2026x';
const STAFF_PASSWORD = 'CustomerKycStaff!2026';
const EMAIL = {
  dana: 'kyc-dana@test.local',
  erik: 'kyc-erik@test.local',
  finance: 'kyc-finance@test.local',
  orders: 'kyc-orders@test.local',
};
const ALL_EMAILS = Object.values(EMAIL);
const users: Record<string, { userId: string; profileId: string }> = {};

interface Session {
  cookie: string;
  csrf: string;
}

function cookiesOf(response: LightMyRequestResponse): Map<string, string> {
  const jar = new Map<string, string>();
  for (const cookie of response.cookies as { name: string; value: string }[]) jar.set(cookie.name, cookie.value);
  return jar;
}

async function signIn(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: PASSWORD } });
  expect(response.statusCode, response.body).toBe(200);
  const jar = cookiesOf(response);
  return { cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '), csrf: jar.get('uboss_shop_csrf') ?? '' };
}

function call(session: Session | AdminSession, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  const isAdmin = 'cookies' in session;
  return app.inject({
    method,
    url,
    headers: { cookie: isAdmin ? session.cookies : session.cookie, 'x-csrf-token': isAdmin ? session.csrfToken : session.csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

const code = (response: LightMyRequestResponse): string | undefined => response.json<{ error?: { code: string } }>().error?.code;

function upload(session: Session, kind: string, data: Buffer, name = 'passport.pdf'): Promise<LightMyRequestResponse> {
  const boundary = `----kycboundary${String(Date.now())}`;
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="kind"\r\n\r\n${kind}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return app.inject({
    method: 'POST',
    url: '/api/v1/account/kyc/documents',
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload,
  });
}

const PLAIN_PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Page >> endobj\n%%EOF\n', 'latin1');

const IDENTITY = {
  legalName: 'Dana Kowalska',
  dateOfBirth: '1988-04-02',
  nationality: 'pl',
  residenceCountry: 'DE',
  idDocumentType: 'PASSPORT',
  idDocumentNumber: 'EA1234567',
  idDocumentExpiresOn: '2031-01-31',
};

async function cleanUp(): Promise<void> {
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: ALL_EMAILS } }, select: { id: true } })).map((row) => row.id);
  const profileIds = (await prisma.customerProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } })).map((row) => row.id);
  await prisma.customerKycDocument.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.customerKyc.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.customerPreference.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.cart.deleteMany({ where: { customerProfileId: { in: profileIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profileIds } } });
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

const staff = (email: string): Promise<AdminSession> => signInAdmin(app, { email, password: STAFF_PASSWORD, ip: '203.0.113.111' });

let dana: Session;
let erik: Session;
let identityDocumentId = '';

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  users.dana = await createCustomer(EMAIL.dana);
  users.erik = await createCustomer(EMAIL.erik);
  await createStaff(EMAIL.finance, Role.FINANCE_APPROVER);
  await createStaff(EMAIL.orders, Role.ORDER_MANAGER);
  dana = await signIn(EMAIL.dana);
  erik = await signIn(EMAIL.erik);
});

afterAll(async () => {
  vi.restoreAllMocks();
  await cleanUp();
  await app.close();
});

describe('the buyer’s own identity check', () => {
  it('starts empty and not started, and refuses anyone signed out', async () => {
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/account/kyc' });
    expect(anonymous.statusCode).toBe(401);

    const response = await call(dana, 'GET', '/api/v1/account/kyc');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toMatchObject({ status: 'NOT_STARTED', editable: true, documents: [] });
  });

  it('keeps the document number masked, never whole', async () => {
    const response = await call(dana, 'PUT', '/api/v1/account/kyc/identity', IDENTITY);
    expect(response.statusCode, response.body).toBe(200);
    const identity = response.json<{ identity: Record<string, string> }>().identity;
    expect(identity).toMatchObject({ legalName: 'Dana Kowalska', nationality: 'PL', residenceCountry: 'DE', dateOfBirth: '1988-04-02' });
    expect(identity.idDocumentNumberMasked).not.toContain('1234567'.slice(0, 5));
    expect(identity.idDocumentNumberMasked?.endsWith('567')).toBe(true);
    expect(response.body).not.toContain('EA1234567');

    const stored = await prisma.customerKyc.findUniqueOrThrow({ where: { customerProfileId: users.dana?.profileId ?? '' } });
    expect(JSON.stringify(stored)).not.toContain('EA1234567');
  });

  it('refuses to submit without an identity document, naming what is missing', async () => {
    const response = await call(dana, 'POST', '/api/v1/account/kyc/submit');
    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe('CUSTOMER_KYC_INCOMPLETE');
    const details = response.json<{ error: { details: { field: string }[] } }>().error.details;
    expect(details.map((detail) => detail.field)).toEqual(['identityDocument']);
  });

  it('refuses a file that is not a document', async () => {
    vi.spyOn(env, 'BUYER_COMPANY_ALLOW_UNSCANNED_DOCUMENTS', 'get').mockReturnValue(true);
    const response = await upload(dana, 'IDENTITY', Buffer.from('MZ this is an executable, not a PDF'), 'passport.pdf');
    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe('MEDIA_TYPE_NOT_ALLOWED');
  });

  it('refuses a file over the size limit and an empty file', async () => {
    vi.spyOn(env, 'BUYER_COMPANY_DOCUMENT_MAX_BYTES', 'get').mockReturnValue(40);
    const large = await upload(dana, 'IDENTITY', Buffer.concat([PLAIN_PDF, Buffer.alloc(200, 32)]));
    expect([400, 413]).toContain(large.statusCode);
    vi.restoreAllMocks();
    vi.spyOn(env, 'BUYER_COMPANY_ALLOW_UNSCANNED_DOCUMENTS', 'get').mockReturnValue(true);
    const empty = await upload(dana, 'IDENTITY', Buffer.alloc(0));
    expect(empty.statusCode).toBe(400);
    expect(await prisma.customerKycDocument.count({ where: { customerProfileId: users.dana?.profileId ?? '' } })).toBe(0);
  });

  it('takes an identity document and then accepts the submission', async () => {
    const uploaded = await upload(dana, 'IDENTITY', PLAIN_PDF);
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const documents = uploaded.json<{ documents: { id: string; kind: string; status: string }[] }>().documents;
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ kind: 'IDENTITY', status: 'PENDING' });
    identityDocumentId = documents[0]?.id ?? '';

    const submitted = await call(dana, 'POST', '/api/v1/account/kyc/submit');
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json()).toMatchObject({ status: 'SUBMITTED', editable: false });
  });

  it('locks identity details and identity documents while with a reviewer, but not importer details', async () => {
    const identity = await call(dana, 'PUT', '/api/v1/account/kyc/identity', { legalName: 'Someone Else' });
    expect(identity.statusCode).toBe(409);
    expect(code(identity)).toBe('CUSTOMER_KYC_NOT_EDITABLE');

    const another = await upload(dana, 'IDENTITY', PLAIN_PDF);
    expect(code(another)).toBe('CUSTOMER_KYC_NOT_EDITABLE');

    const importer = await call(dana, 'PUT', '/api/v1/account/kyc/importer', {
      isImporter: true,
      importerName: 'Dana Kowalska Import',
      eoriNumber: 'de123456789012345',
      preferredIncoterm: 'DAP',
    });
    expect(importer.statusCode, importer.body).toBe(200);
    expect(importer.json<{ importer: Record<string, unknown> }>().importer).toMatchObject({ isImporter: true, preferredIncoterm: 'DAP' });

    const badEori = await call(dana, 'PUT', '/api/v1/account/kyc/importer', { isImporter: true, eoriNumber: 'not an eori!' });
    expect(badEori.statusCode).toBe(400);
  });

  it('never shows one buyer another’s check, and will not let them withdraw another’s file', async () => {
    const own = await call(erik, 'GET', '/api/v1/account/kyc');
    expect(own.json()).toMatchObject({ status: 'NOT_STARTED', documents: [] });

    const withdraw = await call(erik, 'DELETE', `/api/v1/account/kyc/documents/${identityDocumentId}`);
    expect(withdraw.statusCode).toBe(404);
    expect(await prisma.customerKycDocument.count({ where: { id: identityDocumentId, status: 'PENDING' } })).toBe(1);
  });
});

describe('staff review', () => {
  it('lets a customer reader see the check, but not decide it or open the file', async () => {
    const orders = await staff(EMAIL.orders);
    const read = await call(orders, 'GET', `/api/v1/admin/customers/${users.dana?.profileId ?? ''}/kyc`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({ status: 'SUBMITTED' });

    const decide = await call(orders, 'POST', `/api/v1/admin/customers/${users.dana?.profileId ?? ''}/kyc/decision`, { decision: 'VERIFIED', expectedStatus: 'SUBMITTED' });
    expect(decide.statusCode).toBe(403);
    const file = await call(orders, 'GET', `/api/v1/admin/customers/${users.dana?.profileId ?? ''}/kyc/documents/${identityDocumentId}/file`);
    expect(file.statusCode).toBe(403);
  });

  it('refuses the buyer’s own session on every staff route: nobody approves their own check', async () => {
    const profileId = users.dana?.profileId ?? '';
    for (const [method, url, payload] of [
      ['GET', `/api/v1/admin/customers/${profileId}/kyc`, undefined],
      ['POST', `/api/v1/admin/customers/${profileId}/kyc/decision`, { decision: 'VERIFIED', expectedStatus: 'SUBMITTED' }],
      ['POST', `/api/v1/admin/customers/${profileId}/kyc/documents/${identityDocumentId}/decision`, { decision: 'ACCEPTED' }],
      ['GET', `/api/v1/admin/customers/${profileId}/kyc/documents/${identityDocumentId}/file`, undefined],
    ] as const) {
      const response = await call(dana, method, url, payload);
      expect([401, 403], `${method} ${url}`).toContain(response.statusCode);
    }
    expect(await prisma.customerKyc.count({ where: { customerProfileId: profileId, status: 'SUBMITTED' } })).toBe(1);
    expect(await prisma.customerKycDocument.count({ where: { id: identityDocumentId, status: 'PENDING' } })).toBe(1);
  });

  it('will not verify before the identity document is accepted, nor refuse without a reason', async () => {
    const finance = await staff(EMAIL.finance);
    const early = await call(finance, 'POST', `/api/v1/admin/customers/${users.dana?.profileId ?? ''}/kyc/decision`, { decision: 'VERIFIED', expectedStatus: 'SUBMITTED' });
    expect(early.statusCode).toBe(409);
    expect(code(early)).toBe('CUSTOMER_KYC_INCOMPLETE');

    const silent = await call(finance, 'POST', `/api/v1/admin/customers/${users.dana?.profileId ?? ''}/kyc/decision`, { decision: 'REJECTED', expectedStatus: 'SUBMITTED' });
    expect(silent.statusCode).toBe(400);
  });

  it('does not reach a document through another customer’s record', async () => {
    const finance = await staff(EMAIL.finance);
    const crossed = await call(finance, 'GET', `/api/v1/admin/customers/${users.erik?.profileId ?? ''}/kyc/documents/${identityDocumentId}/file`);
    expect(crossed.statusCode).toBe(404);
  });

  it('opens the file with safe headers and audits every opening', async () => {
    const finance = await staff(EMAIL.finance);
    const file = await call(finance, 'GET', `/api/v1/admin/customers/${users.dana?.profileId ?? ''}/kyc/documents/${identityDocumentId}/file`);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.headers['content-type']).toContain('application/pdf');
    expect(file.headers['cache-control']).toBe('no-store, private');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.headers['content-security-policy']).toBe("sandbox; default-src 'none'");
    expect(String(file.headers['content-disposition'])).toMatch(/^inline; filename="[A-Za-z0-9._-]+"$/);
    expect(file.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(await prisma.auditLog.count({ where: { action: 'customer_kyc.document_viewed', resourceId: identityDocumentId } })).toBe(1);
  });

  it('accepts the document, verifies the check, and a verified check cannot be verified twice', async () => {
    const finance = await staff(EMAIL.finance);
    const profileId = users.dana?.profileId ?? '';
    const accepted = await call(finance, 'POST', `/api/v1/admin/customers/${profileId}/kyc/documents/${identityDocumentId}/decision`, { decision: 'ACCEPTED' });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(accepted.json<{ documents: { status: string }[] }>().documents[0]?.status).toBe('ACCEPTED');

    const verified = await call(finance, 'POST', `/api/v1/admin/customers/${profileId}/kyc/decision`, { decision: 'VERIFIED', expectedStatus: 'SUBMITTED' });
    expect(verified.statusCode, verified.body).toBe(200);
    expect(verified.json()).toMatchObject({ status: 'VERIFIED', editable: false });

    const again = await call(finance, 'POST', `/api/v1/admin/customers/${profileId}/kyc/decision`, { decision: 'VERIFIED', expectedStatus: 'SUBMITTED' });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('CUSTOMER_KYC_TRANSITION_INVALID');

    const decisions = await prisma.auditLog.count({ where: { action: 'customer_kyc.decided', resourceId: profileId } });
    expect(decisions).toBe(1);
  });

  it('shows a refused buyer the reason and lets them correct and resubmit', async () => {
    const finance = await staff(EMAIL.finance);
    const profileId = users.erik?.profileId ?? '';
    await call(erik, 'PUT', '/api/v1/account/kyc/identity', { ...IDENTITY, legalName: 'Erik Berg' });
    expect((await upload(erik, 'IDENTITY', PLAIN_PDF)).statusCode).toBe(201);
    expect((await call(erik, 'POST', '/api/v1/account/kyc/submit')).statusCode).toBe(200);

    const refused = await call(finance, 'POST', `/api/v1/admin/customers/${profileId}/kyc/decision`, { decision: 'REJECTED', expectedStatus: 'SUBMITTED', note: 'The photo is unreadable.' });
    expect(refused.statusCode, refused.body).toBe(200);

    const seen = await call(erik, 'GET', '/api/v1/account/kyc');
    expect(seen.json()).toMatchObject({ status: 'REJECTED', editable: true, reviewNote: 'The photo is unreadable.' });
    const corrected = await call(erik, 'PUT', '/api/v1/account/kyc/identity', { legalName: 'Erik Johan Berg' });
    expect(corrected.statusCode).toBe(200);
  });

  it('lets only one of two reviewers deciding from the same screen win; the other is told it changed', async () => {
    const [first, second] = await Promise.all([staff(EMAIL.finance), staff(EMAIL.finance)]);
    const profileId = users.erik?.profileId ?? '';
    expect((await call(erik, 'POST', '/api/v1/account/kyc/submit')).statusCode).toBe(200);
    const documentId = (await prisma.customerKycDocument.findFirstOrThrow({ where: { customerProfileId: profileId, kind: 'IDENTITY' } })).id;
    expect((await call(first, 'POST', `/api/v1/admin/customers/${profileId}/kyc/documents/${documentId}/decision`, { decision: 'ACCEPTED' })).statusCode).toBe(200);

    const results = await Promise.allSettled([
      call(first, 'POST', `/api/v1/admin/customers/${profileId}/kyc/decision`, { decision: 'VERIFIED', expectedStatus: 'SUBMITTED' }),
      call(second, 'POST', `/api/v1/admin/customers/${profileId}/kyc/decision`, { decision: 'REJECTED', expectedStatus: 'SUBMITTED', note: 'Name does not match.' }),
    ]);
    const statuses = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await prisma.auditLog.count({ where: { action: 'customer_kyc.decided', resourceId: profileId } })).toBe(2); // the earlier refusal + one winner

    // A decision that does not say what the reviewer saw is not accepted at all.
    const blind = await call(first, 'POST', `/api/v1/admin/customers/${profileId}/kyc/decision`, { decision: 'REJECTED', note: 'No status given.' });
    expect(blind.statusCode).toBe(400);
  });
});

describe('an identity document that expires', () => {
  it('moves a verified check to expired once the document lapses, audited as the system', async () => {
    const profileId = users.dana?.profileId ?? '';
    await prisma.customerKyc.update({ where: { customerProfileId: profileId }, data: { idDocumentExpiresOn: new Date(Date.now() - 2 * 86_400_000) } });

    const seen = await call(dana, 'GET', '/api/v1/account/kyc');
    expect(seen.json()).toMatchObject({ status: 'EXPIRED', editable: true });
    const again = await call(dana, 'GET', '/api/v1/account/kyc');
    expect(again.json()).toMatchObject({ status: 'EXPIRED' });
    expect(await prisma.auditLog.count({ where: { action: 'customer_kyc.expired', resourceId: profileId, actorType: 'SYSTEM' } })).toBe(1);
  });

  it('will not resubmit with the lapsed document, and does with a valid one', async () => {
    const lapsed = await call(dana, 'POST', '/api/v1/account/kyc/submit');
    expect(lapsed.statusCode).toBe(400);
    expect(lapsed.json<{ error: { details: { field: string; code: string }[] } }>().error.details).toEqual([
      { field: 'idDocumentExpiresOn', code: 'EXPIRED' },
    ]);

    expect((await call(dana, 'PUT', '/api/v1/account/kyc/identity', { idDocumentExpiresOn: '2034-06-30' })).statusCode).toBe(200);
    const resubmitted = await call(dana, 'POST', '/api/v1/account/kyc/submit');
    expect(resubmitted.statusCode, resubmitted.body).toBe(200);
    expect(resubmitted.json()).toMatchObject({ status: 'SUBMITTED' });
  });
});

describe('marketing choices', () => {
  it('are all off until switched on, and each change is audited', async () => {
    const before = await call(dana, 'GET', '/api/v1/account/preferences/marketing');
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ marketingEmailOptIn: false, marketingSmsOptIn: false, productNewsOptIn: false });

    const changed = await call(dana, 'PUT', '/api/v1/account/preferences/marketing', { marketingEmailOptIn: true, marketingSmsOptIn: false, productNewsOptIn: true });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ marketingEmailOptIn: true, productNewsOptIn: true });

    const others = await call(erik, 'GET', '/api/v1/account/preferences/marketing');
    expect(others.json()).toMatchObject({ marketingEmailOptIn: false });

    expect(
      await prisma.auditLog.count({ where: { action: 'customer.marketing_preferences_updated', actorUserId: users.dana?.userId ?? '' } }),
    ).toBe(1);
  });

  it('refuses a change without the CSRF header', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/account/preferences/marketing',
      headers: { cookie: dana.cookie },
      payload: { marketingEmailOptIn: false, marketingSmsOptIn: false, productNewsOptIn: false },
    });
    expect(response.statusCode).toBe(403);
  });
});
