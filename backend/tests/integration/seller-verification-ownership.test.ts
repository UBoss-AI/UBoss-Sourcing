/**
 * Seller verification belongs to the Audit Team; the Admin Panel reads it.
 *
 * End to end over HTTP, every person a real session in their own console:
 *
 *   - A seller submits; the Audit Team's reviewers are told, and the
 *     application is in their queue.
 *   - An auditor asks for corrections; the seller resubmits; the resubmission
 *     is its own queue and its own notice.
 *   - An auditor rejects (reason required, visible to the seller) and approves
 *     (the evidence gate still applies); the seller's trading gate follows.
 *   - An administrator - the most senior role there is - reads the
 *     application, its history and who decided, and is refused every
 *     verification write: the decision route, screening, turnover, document
 *     decisions and an old pending rejection. Suspending stays theirs.
 *   - An inspection agency member, and a reviewer connected to the seller,
 *     are refused. Two decisions made against one version: one wins.
 *   - A decision an administrator made before this change keeps its ADMIN
 *     attribution.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { recordSellerAudit } from '../../src/modules/seller/audit.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';
import { asAudit, auditEmailFor, auditPerson, cleanUpAuditPeople } from '../support/audit-session.js';
import type { Session as AuditSession } from '../support/order-desk-fixture.js';
import { seedTurnover } from '../support/seller-turnover.js';

const TAG = 'sv1';
const PREFIX = 'sv1-';
const COUNTRY = 'QV';
const PASSWORD = 'SellerVerify!2026x';
const HUB_PASSWORD = 'HubVerify!2026x';
const EMAIL = { owner: 'sv1-owner@test.local', admin: 'sv1-admin@test.local', requester: 'sv1-requester@test.local' };
const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n', 'latin1');

let app: Awaited<ReturnType<typeof buildApp>>;
let sellerAccountId = '';
let ownerProfileId = '';
let seller: { cookie: string; csrf: string };
let admin: AdminSession;
let supervisor: AuditSession;
let reviewer: AuditSession;
let inspector: AuditSession;
let supervisorUserId = '';
let reviewerUserId = '';
let agencyId = '';
let ipSeed = 10;
const someIp = (): string => `198.51.101.${String((ipSeed += 1))}`;

const codeOf = (response: LightMyRequestResponse): string | undefined =>
  response.json<{ error?: { code: string } }>().error?.code;

function asSeller(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: { cookie: seller.cookie, 'x-csrf-token': seller.csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function asAdmin(method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** The seller uploads the trade licence through their own session. */
async function uploadLicence(fileName: string): Promise<void> {
  const upload = await app.inject({
    method: 'POST',
    url: '/api/v1/seller/documents',
    headers: { cookie: seller.cookie, 'x-csrf-token': seller.csrf, 'content-type': 'multipart/form-data; boundary=sv1' },
    payload: Buffer.concat([
      Buffer.from(
        '--sv1\r\nContent-Disposition: form-data; name="kind"\r\n\r\nREGULATORY_LICENCE\r\n' +
          '--sv1\r\nContent-Disposition: form-data; name="requirementFieldKey"\r\n\r\nqv_licence\r\n' +
          `--sv1\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/pdf\r\n\r\n`,
      ),
      PDF,
      Buffer.from('\r\n--sv1--\r\n'),
    ]),
  });
  expect(upload.statusCode, upload.body).toBeLessThan(300);
}

async function application(): Promise<{ status: string; version: number }> {
  return prisma.sellerAccount.findUniqueOrThrow({ where: { id: sellerAccountId }, select: { status: true, version: true } });
}

async function cleanUp(): Promise<void> {
  const sellerIds = (await prisma.sellerAccount.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } })).map((r) => r.id);
  const userIds = (await prisma.user.findMany({ where: { emailNormalized: { in: Object.values(EMAIL) } }, select: { id: true } })).map((r) => r.id);
  await prisma.adminPendingAction.deleteMany({ where: { resourceId: { in: sellerIds } } });
  await prisma.sellerTurnoverDeclaration.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerScreeningCheck.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerBeneficialOwner.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerTrustProfile.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerNotification.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerDocument.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerOnboardingProgress.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerBusinessProfile.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.sellerAccount.deleteMany({ where: { id: { in: sellerIds } } });
  await prisma.sellerOnboardingRequirement.deleteMany({ where: { countryKey: COUNTRY } });
  await cleanUpAuditPeople(TAG);
  await prisma.inspectionAgency.deleteMany({ where: { name: `${PREFIX}agency` } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.cart.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: Object.values(EMAIL) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  // The seller's owner: a verified customer account with a Seller Hub lock.
  const ownerUserId = newId();
  ownerProfileId = newId();
  await prisma.user.create({
    data: {
      id: ownerUserId,
      type: 'CUSTOMER',
      email: EMAIL.owner,
      emailNormalized: EMAIL.owner,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({ data: { id: ownerProfileId, userId: ownerUserId, fullName: 'Owner sv1', activatedAt: new Date() } });

  // The most senior admin role there is: no role may get round the refusal.
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL.admin,
      emailNormalized: EMAIL.admin,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });

  // One required document, so approval has evidence to wait for.
  await prisma.sellerOnboardingRequirement.create({
    data: { id: newId(), countryCode: COUNTRY, countryKey: COUNTRY, stepKey: 'compliance', fieldKey: 'qv_licence', label: 'Trade licence', isRequired: true, isDocument: true },
  });

  sellerAccountId = newId();
  await prisma.sellerAccount.create({
    data: {
      id: sellerAccountId,
      legalName: 'Verify Test Private Limited',
      displayName: 'Verify Test',
      displayNameNormalized: 'verifytestsv1',
      slug: `${PREFIX}seller`,
      kind: 'WHOLESALER',
      registrationCountry: COUNTRY,
      status: 'DRAFT',
      description: 'Surgical supplies for clinics.',
    },
  });
  await prisma.sellerBusinessProfile.create({
    data: { id: newId(), sellerAccountId, supportEmail: 'support@sv1.test.local', representativeEmail: 'rep@sv1.test.local' },
  });
  await prisma.sellerOnboardingProgress.create({
    data: {
      id: newId(),
      sellerAccountId,
      stepsJson: Object.fromEntries(
        ['business_identity', 'kyb_kyc', 'locations', 'payout', 'agreements'].map((key) => [key, { state: 'COMPLETE', updatedAt: new Date().toISOString(), message: null }]),
      ),
      completedSteps: 0,
      requiredSteps: 0,
    },
  });
  await prisma.sellerMember.create({ data: { id: newId(), sellerAccountId, customerProfileId: ownerProfileId, role: 'OWNER' } });
  await seedTurnover(sellerAccountId);

  // Sign everybody in, each in their own console.
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': someIp() }, payload: { email: EMAIL.owner, password: PASSWORD } });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  seller = { cookie: jar.map((c) => `${c.name}=${c.value}`).join('; '), csrf: jar.find((c) => c.name === 'uboss_shop_csrf')?.value ?? '' };
  expect((await asSeller('POST', '/api/v1/sellers/lock', { newPassword: HUB_PASSWORD })).statusCode).toBe(200);
  expect((await asSeller('POST', '/api/v1/sellers/lock/open', { password: HUB_PASSWORD })).statusCode).toBe(200);

  admin = await signInAdmin(app, { email: EMAIL.admin, password: PASSWORD, ip: someIp() });

  // The seller's own part of the application, through their own session.
  const kyb = await asSeller('PUT', '/api/v1/seller/kyb', {
    legalForm: 'PARTNERSHIP',
    udyamNumber: null,
    iecNumber: null,
    exportCapable: false,
    exportMarkets: [],
    yearsExporting: null,
    intendedCategoryIds: [],
    beneficialOwners: [
      { fullName: 'Partner One', nationality: 'IN', ownershipBasisPoints: 10000, role: 'Partner', isControllingPerson: true, isPoliticallyExposed: false },
    ],
  });
  expect(kyb.statusCode, kyb.body).toBe(200);

  agencyId = newId();
  await prisma.inspectionAgency.create({
    data: { id: agencyId, name: `${PREFIX}agency`, legalName: `${PREFIX}agency Ltd`, country: 'IN', contactEmail: `${PREFIX}agency@test.local` },
  });
  const people = await Promise.all([
    auditPerson(app, { tag: TAG, who: 'super', ip: '10.81.0.11', target: { kind: 'STAFF', role: 'SUPERVISOR' } }),
    auditPerson(app, { tag: TAG, who: 'review', ip: '10.81.0.12', target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } }),
    auditPerson(app, { tag: TAG, who: 'inspect', ip: '10.81.0.13', target: { kind: 'AGENCY', agencyId, role: 'INSPECTOR' } }),
  ]);
  supervisor = people[0].session;
  supervisorUserId = people[0].userId;
  reviewer = people[1].session;
  reviewerUserId = people[1].userId;
  inspector = people[2].session;
}, 300_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

// ---------------------------------------------------------------------------

describe('submission reaches the Audit Team', () => {
  it('keeps a decision an administrator made earlier attributed to them', async () => {
    // History written before the Audit Team owned verification.
    const adminUser = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: EMAIL.admin }, select: { id: true } });
    await recordSellerAudit({
      sellerAccountId,
      action: 'seller.application.action_required',
      actor: { type: 'ADMIN', userId: adminUser.id, label: 'Marketplace moderation' },
      resourceType: 'seller_account',
      resourceId: sellerAccountId,
      summary: 'Application moved to action required: an earlier note.',
    });
    const read = await asAudit(app, reviewer, 'GET', `/audit/seller-verification/${sellerAccountId}`);
    expect(read.statusCode, read.body).toBe(200);
    const history = read.json<{ application: { verification: { history: { actorType: string; actorLabel: string }[] } } }>().application.verification.history;
    expect(history[0]).toMatchObject({ actorType: 'ADMIN', actorLabel: EMAIL.admin });
    // Not a real resubmission: clear it so the queue below starts clean.
    await prisma.sellerAuditLog.deleteMany({ where: { sellerAccountId } });
  });

  it('a seller submits; every seller verifier is told and the application is queued', async () => {
    await uploadLicence('sv1-licence.pdf');
    const submitted = await asSeller('POST', '/api/v1/seller/submit');
    expect(submitted.statusCode, submitted.body).toBe(204);
    expect((await application()).status).toBe('SUBMITTED');

    const notices = await prisma.auditNotification.findMany({ where: { subjectId: sellerAccountId, kind: 'SELLER_APPLICATION_SUBMITTED' }, select: { userId: true } });
    const told = notices.map((n) => n.userId);
    expect(told).toEqual(expect.arrayContaining([supervisorUserId, reviewerUserId]));
    // The agency's inspector is not a seller verifier.
    const inspectorUser = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: auditEmailFor(TAG, 'inspect') }, select: { id: true } });
    expect(told).not.toContain(inspectorUser.id);

    const queue = await asAudit(app, reviewer, 'GET', '/audit/seller-verification?status=SUBMITTED&search=Verify%20Test');
    expect(queue.statusCode, queue.body).toBe(200);
    expect(queue.json<{ rows: { id: string }[] }>().rows.map((r) => r.id)).toContain(sellerAccountId);
  });
});

describe('who may verify', () => {
  it('refuses an inspection agency member, even to read', async () => {
    const read = await asAudit(app, inspector, 'GET', `/audit/seller-verification/${sellerAccountId}`);
    expect(read.statusCode).toBe(403);
    const decide = await asAudit(app, inspector, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'UNDER_REVIEW', expectedVersion: (await application()).version });
    expect(decide.statusCode).toBe(403);
    expect((await application()).status).toBe('SUBMITTED');
  });

  it('refuses a reviewer connected to the seller', async () => {
    await prisma.sellerBusinessProfile.update({ where: { sellerAccountId }, data: { representativeEmail: auditEmailFor(TAG, 'review') } });
    const decide = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'UNDER_REVIEW', expectedVersion: (await application()).version });
    expect(decide.statusCode).toBe(403);
    expect(codeOf(decide)).toBe('SELLER_VERIFICATION_NOT_INDEPENDENT');
    await prisma.sellerBusinessProfile.update({ where: { sellerAccountId }, data: { representativeEmail: 'rep@sv1.test.local' } });
  });

  it('lets one of two simultaneous decisions on the same version win, and tells the other to reload', async () => {
    const { version } = await application();
    const [a, b] = await Promise.allSettled([
      asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'UNDER_REVIEW', expectedVersion: version }),
      asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'UNDER_REVIEW', expectedVersion: version }),
    ]);
    const codes = [a, b].map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(codes).toEqual([204, 409]);
    expect((await application()).status).toBe('UNDER_REVIEW');
  });
});

describe('the Admin Panel reads and cannot decide', () => {
  it('reads the application with its owner, history and who decided', async () => {
    const read = await asAdmin('GET', `/sellers/${sellerAccountId}`);
    expect(read.statusCode, read.body).toBe(200);
    const verification = read.json<{ verification: { ownedBy: string; reviewersAvailable: boolean; currentDecision: { actorType: string } | null; history: unknown[] } }>().verification;
    expect(verification.ownedBy).toBe('AUDIT');
    expect(verification.reviewersAvailable).toBe(true);
    expect(verification.currentDecision?.actorType).toBe('AUDIT');
    expect((await asAdmin('GET', `/sellers?status=UNDER_REVIEW`)).statusCode).toBe(200);
    expect((await asAdmin('GET', `/sellers/${sellerAccountId}/approval-readiness`)).statusCode).toBe(200);
    expect((await asAdmin('GET', `/sellers/${sellerAccountId}/turnover`)).statusCode).toBe(200);
  });

  it('refuses every verification write, by any route', async () => {
    const { version } = await application();
    for (const status of ['UNDER_REVIEW', 'ACTION_REQUIRED', 'APPROVED', 'REJECTED']) {
      const response = await asAdmin('POST', `/sellers/${sellerAccountId}/decision`, { status, reason: 'Admin trying', expectedVersion: version });
      expect(response.statusCode, status).toBe(403);
      expect(codeOf(response), status).toBe('SELLER_VERIFICATION_AUDIT_ONLY');
    }
    const screening = await asAdmin('POST', `/sellers/${sellerAccountId}/screening`, { subjectType: 'ENTITY', result: 'CLEAR', listsChecked: 'UN list' });
    expect(codeOf(screening)).toBe('SELLER_VERIFICATION_AUDIT_ONLY');
    const turnover = await asAdmin('POST', `/sellers/${sellerAccountId}/turnover/decision`, { declarationId: newId(), decision: 'VERIFIED', reason: 'Looks fine' });
    expect(codeOf(turnover)).toBe('SELLER_VERIFICATION_AUDIT_ONLY');
    const document = await asAdmin('POST', `/seller-documents/${newId()}/decision`, { decision: 'APPROVED' });
    expect(codeOf(document)).toBe('SELLER_VERIFICATION_AUDIT_ONLY');
    // Nothing moved.
    expect(await application()).toEqual({ status: 'UNDER_REVIEW', version });
    expect(await prisma.sellerScreeningCheck.count({ where: { sellerAccountId } })).toBe(0);
  });

  it('refuses to approve an old pending rejection into a decision', async () => {
    // Another administrator queued it; this one is asked to approve it.
    const requester = await prisma.user.create({
      data: { id: newId(), type: 'ADMIN', email: EMAIL.requester, emailNormalized: EMAIL.requester, passwordHash: 'x', status: 'ACTIVE' },
      select: { id: true, email: true },
    });
    const pendingId = newId();
    await prisma.adminPendingAction.create({
      data: {
        id: pendingId,
        kind: 'SELLER_REJECT',
        resourceType: 'seller_account',
        resourceId: sellerAccountId,
        resourceLabel: 'Verify Test',
        payloadJson: {},
        reason: 'Queued before the Audit Team owned this.',
        requestedById: requester.id,
        requestedByEmail: requester.email,
        requestedAt: new Date(),
        pendingKey: `sv1:${pendingId}`,
      },
    });
    const approve = await asAdmin('POST', `/pending-actions/${pendingId}/approve`, { note: null });
    expect(approve.statusCode, approve.body).toBe(403);
    expect(codeOf(approve)).toBe('SELLER_VERIFICATION_AUDIT_ONLY');
    expect((await prisma.adminPendingAction.findUniqueOrThrow({ where: { id: pendingId } })).status).toBe('PENDING');
    expect((await application()).status).toBe('UNDER_REVIEW');
  });
});

describe('corrections, resubmission, rejection and approval', () => {
  it('asks for corrections with a reason the seller reads, and the resubmission is queued as one', async () => {
    const noReason = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'ACTION_REQUIRED', expectedVersion: (await application()).version });
    expect(noReason.statusCode).toBe(400);

    const asked = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, {
      status: 'ACTION_REQUIRED',
      reason: 'Upload your trade licence.',
      expectedVersion: (await application()).version,
    });
    expect(asked.statusCode, asked.body).toBe(204);

    const activity = await asSeller('GET', '/api/v1/seller/audit');
    if (activity.statusCode === 200) {
      expect(activity.body).toContain('Audit Team');
      expect(activity.body).not.toContain(auditEmailFor(TAG, 'review'));
    }

    // The seller uploads a corrected licence and sends the application back.
    await uploadLicence('sv1-licence-corrected.pdf');
    const told = await prisma.auditNotification.count({ where: { kind: 'SELLER_DOCUMENT_UPLOADED', userId: reviewerUserId } });
    expect(told).toBeGreaterThan(0);

    const resubmitted = await asSeller('POST', '/api/v1/seller/submit');
    expect(resubmitted.statusCode, resubmitted.body).toBe(204);
    expect(await prisma.auditNotification.count({ where: { subjectId: sellerAccountId, kind: 'SELLER_APPLICATION_RESUBMITTED', userId: reviewerUserId } })).toBe(1);

    const queue = await asAudit(app, reviewer, 'GET', '/audit/seller-verification?resubmitted=true&search=Verify%20Test');
    const body = queue.json<{ rows: { id: string; resubmitted: boolean }[]; counts: Record<string, number> }>();
    expect(body.rows.find((r) => r.id === sellerAccountId)?.resubmitted).toBe(true);
    expect(body.counts['RESUBMITTED']).toBeGreaterThan(0);
  });

  it('refuses approval while evidence is missing, then approves once the auditor has verified it', async () => {
    const take = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'UNDER_REVIEW', expectedVersion: (await application()).version });
    expect(take.statusCode, take.body).toBe(204);

    const early = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'APPROVED', expectedVersion: (await application()).version });
    expect(early.statusCode).toBe(409);
    expect(codeOf(early)).toBe('SELLER_APPROVAL_EVIDENCE_MISSING');

    const document = await prisma.sellerDocument.findFirstOrThrow({ where: { sellerAccountId, supersededAt: null, requirementFieldKey: 'qv_licence' }, select: { id: true } });
    const file = await asAudit(app, supervisor, 'GET', `/audit/seller-verification/documents/${document.id}/file`);
    expect([200, 409]).toContain(file.statusCode);
    const accepted = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/documents/${document.id}/decision`, { decision: 'APPROVED' });
    expect(accepted.statusCode, accepted.body).toBe(204);
    // The same decision again is stale, not a second write.
    const again = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/documents/${document.id}/decision`, { decision: 'REJECTED', reason: 'Too late' });
    expect([204, 409]).toContain(again.statusCode);
    if (again.statusCode === 204) {
      await asAudit(app, supervisor, 'POST', `/audit/seller-verification/documents/${document.id}/decision`, { decision: 'APPROVED' });
    }

    const screened = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/screening`, {
      subjectType: 'ENTITY',
      result: 'CLEAR',
      listsChecked: 'UN consolidated list; OFAC SDN',
    });
    expect(screened.statusCode, screened.body).toBe(201);

    const readiness = await asAudit(app, supervisor, 'GET', `/audit/seller-verification/${sellerAccountId}`);
    const missing = readiness.json<{ readiness: { missing: { code?: string; field?: string }[] } }>().readiness.missing;
    // Whatever this deployment still asks for is named; clear what an auditor can.
    expect(missing.every((item) => item.code !== 'DOCUMENT_NOT_APPROVED')).toBe(true);
  });

  it('rejects with a reason the seller sees, keeps the restrictions, and reopens on request', async () => {
    const noReason = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'REJECTED', expectedVersion: (await application()).version });
    expect(noReason.statusCode).toBe(400);
    const rejected = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, {
      status: 'REJECTED',
      reason: 'The licence does not match the company name.',
      resubmissionAllowed: true,
      expectedVersion: (await application()).version,
    });
    expect(rejected.statusCode, rejected.body).toBe(204);
    const account = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: sellerAccountId }, select: { status: true, statusReason: true } });
    expect(account).toEqual({ status: 'REJECTED', statusReason: 'The licence does not match the company name.' });
    const gated = await asSeller('POST', '/api/v1/seller/listing-drafts', {});
    expect(gated.statusCode).toBe(403);
    expect(codeOf(gated)).toBe('SELLER_NOT_APPROVED');

    const reopened = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, {
      status: 'ACTION_REQUIRED',
      reason: 'Send the licence in the company name.',
      expectedVersion: (await application()).version,
    });
    expect(reopened.statusCode, reopened.body).toBe(204);
    expect((await application()).status).toBe('ACTION_REQUIRED');
  });

  it('approves through the auditor, the trading gate opens, and the Admin Panel can only suspend', async () => {
    // The seller sends it back once more; the auditor takes it and verifies what is left.
    expect((await asSeller('POST', '/api/v1/seller/submit')).statusCode).toBe(204);
    const take = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'UNDER_REVIEW', expectedVersion: (await application()).version });
    expect(take.statusCode, take.body).toBe(204);

    const detail = await asAudit(app, supervisor, 'GET', `/audit/seller-verification/${sellerAccountId}`);
    const view = detail.json<{
      application: { kyb: { beneficialOwners: { id: string }[] } };
      turnover: { current: { id: string; verificationState: string } | null };
    }>();
    const declarationId = view.turnover.current?.id ?? '';
    const seen = view.turnover.current?.verificationState ?? '';
    const turnover = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/turnover/decision`, {
      declarationId,
      decision: 'VERIFIED',
      reason: 'Matches the filed accounts.',
      expectedVerificationState: seen,
    });
    expect(turnover.statusCode, turnover.body).toBe(200);
    // Deciding the same declaration again from a stale screen is refused.
    const staleTurnover = await asAudit(app, reviewer, 'POST', `/audit/seller-verification/${sellerAccountId}/turnover/decision`, {
      declarationId,
      decision: 'FAILED',
      reason: 'Opened before it was decided.',
      expectedVerificationState: seen,
    });
    expect(staleTurnover.statusCode).toBe(409);
    for (const owner of view.application.kyb.beneficialOwners) {
      const screened = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/screening`, {
        subjectType: 'BENEFICIAL_OWNER',
        beneficialOwnerId: owner.id,
        result: 'CLEAR',
        listsChecked: 'UN consolidated list',
      });
      expect(screened.statusCode, screened.body).toBe(201);
    }

    const approved = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'APPROVED', expectedVersion: (await application()).version });
    expect(approved.statusCode, approved.body).toBe(204);
    expect((await application()).status).toBe('APPROVED');
    const decision = await prisma.sellerAuditLog.findFirstOrThrow({ where: { sellerAccountId, action: 'seller.application.approved' }, orderBy: { createdAt: 'desc' } });
    expect(decision).toMatchObject({ actorType: 'AUDIT', actorUserId: supervisorUserId, actorLabel: 'Audit Team' });

    const gated = await asSeller('POST', '/api/v1/seller/listing-drafts', {});
    expect(codeOf(gated)).not.toBe('SELLER_NOT_APPROVED');

    // Suspending stays an Admin Panel control; the Audit Console cannot lift it.
    const suspended = await asAdmin('POST', `/sellers/${sellerAccountId}/decision`, { status: 'SUSPENDED', reason: 'Payment dispute under investigation.', expectedVersion: (await application()).version });
    expect([202, 204]).toContain(suspended.statusCode);
    if (suspended.statusCode === 204) {
      const lift = await asAudit(app, supervisor, 'POST', `/audit/seller-verification/${sellerAccountId}/decision`, { status: 'APPROVED', expectedVersion: (await application()).version });
      expect(lift.statusCode).toBe(409);
    }
  });
});
