/**
 * The Audit Console, end to end over HTTP.
 *
 *   1. Access: invitation-only accounts on their own audience, a mandatory
 *      second factor, console-only password resets, access removed at once.
 *   2. Module A: versioned rules approved by somebody other than their
 *      drafter; a seller's documents reviewed with a recorded method; a
 *      category qualification that covers its category and nothing else;
 *      unresolved applicability that stays unresolved; expiry that sends a
 *      qualification back for review; the listing gate.
 *   3. Module B: quantities in exact decimals, defects on named units, a
 *      laboratory result outstanding (INCONCLUSIVE, goods held), the report
 *      PDF behind each audience's rule, a correction that keeps the original,
 *      and a sub-lot release that can be used exactly once.
 *
 * Every person is a real session: agency and audit people activate their own
 * console accounts through the public invitation endpoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { totpCodeAt } from '../../src/infra/totp.js';
import { qualificationGate } from '../../src/modules/compliance/case.service.js';
import { expireComplianceDocuments } from '../../src/modules/compliance/document.service.js';
import { ensureRequirement } from '../../src/modules/inspection/gate.service.js';
import {
  asCustomer,
  asStaff,
  buildOrderDesk,
  cleanUpOrderDesk,
  emailFor,
  staff,
  type OrderDesk,
  type Session,
  type StaffSession,
} from '../support/order-desk-fixture.js';
import { activateAndSignIn, asAudit, auditEmailFor, auditPerson, cleanUpAuditPeople } from '../support/audit-session.js';

const TAG = 'audc5';
const RULE_PREFIX = 'AUDC5';
let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let admin: StaffSession;
let supervisor: Session;
let reviewer: Session;
let supervisorUserId = '';
let categoryRoot = '';
let categoryLeaf = '';
let categoryOther = '';
let groupId = '';

const saved = { FEATURE_AUDIT_MFA: env.FEATURE_AUDIT_MFA, COMPLIANCE_QUALIFICATION_ENFORCEMENT: env.COMPLIANCE_QUALIFICATION_ENFORCEMENT };
function setEnv(values: Partial<typeof saved>): void {
  Object.assign(env as unknown as typeof saved, values);
}

async function cleanCompliance(): Promise<void> {
  const sellerIds = desk === undefined ? [] : [desk.sellerAId, desk.sellerBId];
  await prisma.complianceCase.deleteMany({ where: { sellerAccountId: { in: sellerIds } } });
  await prisma.complianceEvent.deleteMany({ where: { OR: [{ sellerAccountId: { in: sellerIds } }, { summary: { contains: RULE_PREFIX } }] } });
  await prisma.complianceRequirement.deleteMany({ where: { code: { startsWith: RULE_PREFIX } } });
  await prisma.sellerCertification.deleteMany({ where: { sellerAccountId: { in: sellerIds }, standard: { startsWith: RULE_PREFIX } } });
  await prisma.sellerDocument.deleteMany({ where: { sellerAccountId: { in: sellerIds }, originalFileName: { startsWith: TAG } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `${TAG}cmp-` }, parentId: { not: null } } });
  await prisma.category.deleteMany({ where: { slug: { startsWith: `${TAG}cmp-` } } });
}

async function cleanInspection(): Promise<void> {
  if (desk !== undefined) {
    await prisma.inspectionSubLotRelease.deleteMany({ where: { requirement: { orderId: desk.orderId } } });
    await prisma.inspectionRequirement.deleteMany({ where: { orderId: desk.orderId } });
  }
  const ids = (await prisma.inspectionAgency.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((row) => row.id);
  await prisma.inspectionAgencyMember.deleteMany({ where: { agencyId: { in: ids } } });
  await prisma.inspectionAgency.deleteMany({ where: { id: { in: ids } } });
  await prisma.inspectionRule.deleteMany({ where: { name: `${TAG} every order` } });
}

async function category(slug: string, parentId: string | null): Promise<string> {
  const id = newId();
  const parent = parentId === null ? null : await prisma.category.findUniqueOrThrow({ where: { id: parentId }, select: { path: true, depth: true } });
  await prisma.category.create({
    data: {
      id,
      name: `${TAG} ${slug}`,
      slug: `${TAG}cmp-${slug}`,
      parentId,
      path: `${parent?.path ?? '/'}${id}/`,
      depth: parent === null ? 0 : parent.depth + 1,
      isActive: true,
    },
  });
  return id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 75);
  await cleanCompliance();
  await cleanInspection();
  await cleanUpAuditPeople(TAG);
  admin = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.75.0.10');
  const people = await Promise.all([
    auditPerson(app, { tag: TAG, who: 'super', ip: '10.75.0.11', target: { kind: 'STAFF', role: 'SUPERVISOR' } }),
    auditPerson(app, { tag: TAG, who: 'review', ip: '10.75.0.12', target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } }),
  ]);
  supervisor = people[0].session;
  supervisorUserId = people[0].userId;
  reviewer = people[1].session;
  categoryRoot = await category('medical', null);
  categoryLeaf = await category('cannula', categoryRoot);
  categoryOther = await category('tools', null);
  groupId = (await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: desk.orderId, sellerAccountId: desk.sellerAId }, select: { id: true } })).id;
}, 300_000);

afterAll(async () => {
  setEnv(saved);
  await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: true } });
  await cleanInspection();
  await cleanCompliance();
  await cleanUpAuditPeople(TAG);
  await cleanUpOrderDesk(TAG);
  await app.close();
});

// ---------------------------------------------------------------------------

describe('access to the console', () => {
  it('signs a console member in, and tells them who they are and what they may do', async () => {
    const me = await asAudit(app, supervisor, 'GET', '/audit/auth/me');
    expect(me.statusCode, me.body).toBe(200);
    const body = me.json<{ member: { kind: string; role: string; permissions: string[] }; mfa: { required: boolean } }>();
    expect(body.member).toMatchObject({ kind: 'STAFF', role: 'SUPERVISOR' });
    expect(body.member.permissions).toContain('audit.rule.approve');
    expect(body.mfa.required).toBe(false);
    const reviewerMe = await asAudit(app, reviewer, 'GET', '/audit/auth/me');
    expect(reviewerMe.json<{ member: { permissions: string[] } }>().member.permissions).not.toContain('audit.rule.approve');
  });

  it('refuses an invitation to an address another account already uses', async () => {
    const taken = await asStaff(app, admin, 'POST', '/audit-console/invitations', {
      idempotencyKey: newId(),
      payload: { email: emailFor(TAG, 'buyer'), fullName: 'Same person', target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } },
    });
    expect(taken.statusCode, taken.body).toBe(409);
    expect(taken.body).toContain('EMAIL_IN_USE');
  });

  it('requires the second factor before anything else when it is switched on', async () => {
    setEnv({ FEATURE_AUDIT_MFA: true });
    try {
      const person = await auditPerson(app, { tag: TAG, who: 'mfa', ip: '10.75.0.13', target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } });
      const blocked = await asAudit(app, person.session, 'GET', '/audit/dashboard');
      expect(blocked.statusCode, blocked.body).toBe(403);
      expect(blocked.body).toContain('AUDIT_MFA_SETUP_REQUIRED');
      const me = await asAudit(app, person.session, 'GET', '/audit/auth/me');
      expect(me.json<{ mfa: { required: boolean; enrolled: boolean } }>().mfa).toMatchObject({ required: true, enrolled: false });
      const setup = await asAudit(app, person.session, 'POST', '/audit/auth/mfa/setup');
      expect(setup.statusCode, setup.body).toBe(200);
      const secret = setup.json<{ secret: string }>().secret;
      const verified = await asAudit(app, person.session, 'POST', '/audit/auth/mfa/verify', { code: totpCodeAt(secret, Date.now()), mode: 'ENROL' });
      expect(verified.statusCode, verified.body).toBe(200);
      expect((await asAudit(app, person.session, 'GET', '/audit/dashboard')).statusCode).toBe(200);
    } finally {
      setEnv({ FEATURE_AUDIT_MFA: false });
    }
  });

  it('sends a password reset for a console account only from the console', async () => {
    const userId = (await prisma.user.findUniqueOrThrow({ where: { emailNormalized: auditEmailFor(TAG, 'review') }, select: { id: true } })).id;
    const resets = () => prisma.authToken.count({ where: { userId, type: 'PASSWORD_RESET' } });
    const before = await resets();
    const fromShop = await app.inject({ method: 'POST', url: '/api/v1/auth/password/forgot', headers: { 'x-forwarded-for': '10.75.0.30' }, payload: { email: auditEmailFor(TAG, 'review') } });
    expect(fromShop.statusCode).toBe(202);
    expect(await resets()).toBe(before);
    const fromConsole = await app.inject({ method: 'POST', url: '/api/v1/audit/auth/password/forgot', headers: { 'x-forwarded-for': '10.75.0.31' }, payload: { email: auditEmailFor(TAG, 'review') } });
    expect(fromConsole.statusCode).toBe(202);
    expect(await resets()).toBe(before + 1);
  });

  it('ends a removed member’s sessions at once', async () => {
    const person = await auditPerson(app, { tag: TAG, who: 'leaver', ip: '10.75.0.14', target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } });
    expect((await asAudit(app, person.session, 'GET', '/audit/dashboard')).statusCode).toBe(200);
    const removed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/audit-console/staff/${person.memberId}`,
      headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken, 'x-forwarded-for': admin.ip },
      payload: { status: 'DISABLED', disabledReason: 'Left the company.' },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await asAudit(app, person.session, 'GET', '/audit/dashboard')).statusCode).toBe(401);
  });
});

// ---------------------------------------------------------------------------

const ruleBody = (code: string, categoryIds: string[], overrides: Record<string, unknown> = {}) => ({
  code,
  name: `${code} rule`,
  description: `${RULE_PREFIX} test requirement description.`,
  requiredEvidence: 'The licence, as issued.',
  obligation: 'LEGAL',
  level: 'SELLER_CATEGORY',
  categoryIds,
  includeDescendants: true,
  supplyRoles: ['MANUFACTURER'],
  originCountries: [],
  destinationMarkets: [],
  riskClasses: [],
  applicability: 'APPLIES',
  expiryKind: 'DOCUMENT_EXPIRY',
  sourceUrl: 'https://cdsco.gov.in/opencms/opencms/en/Acts-and-rules/Medical-Devices-Rules/',
  sourceTitle: 'Medical Devices Rules, 2017',
  sourcePublisher: 'CDSCO',
  lastReviewedOn: '2026-10-06',
  confidence: 'MEDIUM',
  ...overrides,
});

async function approvedRule(code: string, categoryIds: string[], overrides: Record<string, unknown> = {}): Promise<string> {
  const drafted = await asAudit(app, reviewer, 'POST', '/audit/rules', ruleBody(code, categoryIds, overrides));
  expect(drafted.statusCode, drafted.body).toBe(201);
  const ruleId = drafted.json<{ id: string }>().id;
  expect((await asAudit(app, reviewer, 'POST', `/audit/rules/${ruleId}/submit`)).statusCode).toBe(200);
  const approved = await asAudit(app, supervisor, 'POST', `/audit/rules/${ruleId}/approve`, { note: 'Checked against the source.' });
  expect(approved.statusCode, approved.body).toBe(200);
  return ruleId;
}

describe('module A: rules, documents and qualifications', () => {
  let licenceDocumentId = '';
  let caseId = '';

  it('keeps a drafted rule out of force until somebody else approves it', async () => {
    const drafted = await asAudit(app, supervisor, 'POST', '/audit/rules', ruleBody(`${RULE_PREFIX}-SELF`, [categoryOther]));
    expect(drafted.statusCode, drafted.body).toBe(201);
    const ruleId = drafted.json<{ id: string }>().id;
    expect((await asAudit(app, supervisor, 'POST', `/audit/rules/${ruleId}/submit`)).statusCode).toBe(200);
    const self = await asAudit(app, supervisor, 'POST', `/audit/rules/${ruleId}/approve`, { note: 'Approving my own.' });
    expect(self.statusCode, self.body).toBe(409);
    expect(self.body).toContain('SAME_PERSON');
    // A reviewer cannot approve at all.
    expect((await asAudit(app, reviewer, 'POST', `/audit/rules/${ruleId}/approve`, { note: 'Not my call.' })).statusCode).toBe(403);
    // The coverage screen shows the category as still needing review.
    const coverage = await asAudit(app, reviewer, 'GET', '/audit/rules/coverage');
    const other = coverage.json<{ categories: { categoryId: string; needsReview: boolean; awaitingApproval: number }[] }>().categories.find((row) => row.categoryId === categoryOther);
    expect(other).toMatchObject({ needsReview: true, awaitingApproval: 1 });
  });

  it('approves a rule only once, under two concurrent approvals', async () => {
    const drafted = await asAudit(app, reviewer, 'POST', '/audit/rules', ruleBody(`${RULE_PREFIX}-RACE`, [categoryOther], { obligation: 'OPTIONAL_QUALIFICATION' }));
    const ruleId = drafted.json<{ id: string }>().id;
    await asAudit(app, reviewer, 'POST', `/audit/rules/${ruleId}/submit`);
    const second = await auditPerson(app, { tag: TAG, who: 'super2', ip: '10.75.0.15', target: { kind: 'STAFF', role: 'SUPERVISOR' } });
    const results = await Promise.allSettled([
      asAudit(app, supervisor, 'POST', `/audit/rules/${ruleId}/approve`, { note: 'Checked against the source.' }),
      asAudit(app, second.session, 'POST', `/audit/rules/${ruleId}/approve`, { note: 'Checked against the source too.' }),
    ]);
    const codes = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(codes).toEqual([200, 409]);
    expect(await prisma.complianceEvent.count({ where: { subjectId: ruleId, kind: 'approved' } })).toBe(1);
  });

  it('qualifies a seller for a category on reviewed evidence, and for nothing else', async () => {
    await approvedRule(`${RULE_PREFIX}-LICENCE`, [categoryRoot]);
    await approvedRule(`${RULE_PREFIX}-BORDER`, [categoryRoot], { applicability: 'UNRESOLVED', applicabilityNote: 'Drug or device: not settled.' });
    await approvedRule(`${RULE_PREFIX}-TOOLS`, [categoryOther]);

    // The seller's own uploaded file, as the Seller Hub stores it.
    const fileId = newId();
    await prisma.sellerDocument.create({
      data: {
        id: fileId,
        sellerAccountId: desk.sellerAId,
        kind: 'OTHER',
        originalFileName: `${TAG}-licence.pdf`,
        contentType: 'application/pdf',
        byteSize: 1234,
        storageKey: `private/${TAG}/${fileId}.pdf`,
        contentHash: 'a'.repeat(64),
        scanState: 'CLEAN',
      },
    });
    const created = await asCustomer(app, desk.sellerA, 'POST', '/seller/compliance/documents', {
      idempotencyKey: newId(),
      payload: {
        documentType: 'LICENCE',
        standard: `${RULE_PREFIX} manufacturing licence`,
        certificateNumber: 'MFG/2026/0001',
        issuer: 'State Licensing Authority',
        issuingCountry: 'IN',
        legalEntityName: 'Seller A Pvt Ltd',
        categoryScopeIds: [categoryRoot],
        requirementCodes: [`${RULE_PREFIX}-LICENCE`],
        issuedOn: '2025-01-01',
        expiresOn: '2029-12-31',
        documentId: fileId,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    licenceDocumentId = created.json<{ id: string }>().id;

    // Asking twice - even at the same moment - opens one case.
    const ask = () =>
      asCustomer(app, desk.sellerA, 'POST', '/seller/compliance/cases', {
        idempotencyKey: newId(),
        payload: { level: 'SELLER_CATEGORY', categoryId: categoryLeaf, supplyRole: 'MANUFACTURER' },
      });
    const [first, second] = await Promise.all([ask(), ask()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 201]);
    caseId = first.json<{ id: string }>().id;
    expect(second.json<{ id: string }>().id).toBe(caseId);
    expect(await prisma.auditNotification.count({ where: { subjectId: caseId, kind: 'CASE_REQUESTED' } })).toBeGreaterThan(0);

    const lock = async () => (await prisma.complianceCase.findUniqueOrThrow({ where: { id: caseId }, select: { lockVersion: true } })).lockVersion;
    expect((await asAudit(app, reviewer, 'POST', `/audit/cases/${caseId}/start`, { expectedLockVersion: await lock() })).statusCode).toBe(200);

    // Not yet: the licence is unreviewed and the borderline rule is undecided.
    const early = await asAudit(app, reviewer, 'POST', `/audit/cases/${caseId}/approve`, { expectedLockVersion: await lock() });
    expect(early.statusCode, early.body).toBe(409);
    expect(early.body).toContain('PENDING_REVIEW');
    expect(early.body).toContain('NEEDS_DETERMINATION');

    // The document: a method must be recorded, and a mismatch is never approved.
    expect((await asAudit(app, reviewer, 'POST', `/audit/documents/${licenceDocumentId}/start`, { expectedStatus: 'SUBMITTED' })).statusCode).toBe(200);
    expect((await asAudit(app, reviewer, 'POST', `/audit/documents/${licenceDocumentId}/approve`, { expectedStatus: 'UNDER_REVIEW' })).statusCode).toBe(400);
    const mismatch = await asAudit(app, reviewer, 'POST', `/audit/documents/${licenceDocumentId}/approve`, {
      expectedStatus: 'UNDER_REVIEW',
      verificationMethod: 'REGISTRY_LOOKUP',
      verificationOutcome: 'MISMATCH',
      verificationSource: 'https://registry.example',
    });
    expect(mismatch.statusCode, mismatch.body).toBe(409);
    const approved = await asAudit(app, reviewer, 'POST', `/audit/documents/${licenceDocumentId}/approve`, {
      expectedStatus: 'UNDER_REVIEW',
      verificationMethod: 'MANUAL_EVIDENCE',
      internalNote: 'Licence wording and dates checked against the file.',
    });
    expect(approved.statusCode, approved.body).toBe(200);
    const document = await asAudit(app, reviewer, 'GET', `/audit/documents/${licenceDocumentId}`);
    // "Evidence reviewed", never "authentic".
    expect(document.json<{ document: { badge: string } }>().document.badge).toBe('EVIDENCE_REVIEWED');

    // Unresolved applicability stays a blocker, even when a reviewer records it as unresolved.
    expect((await asAudit(app, reviewer, 'POST', `/audit/cases/${caseId}/determinations`, { code: `${RULE_PREFIX}-BORDER`, decision: 'UNRESOLVED', reason: 'Waiting for regulatory advice.' })).statusCode).toBe(200);
    const stillOpen = await asAudit(app, reviewer, 'POST', `/audit/cases/${caseId}/approve`, { expectedLockVersion: await lock() });
    expect(stillOpen.statusCode).toBe(409);
    expect(stillOpen.body).toContain('UNRESOLVED');
    expect((await asAudit(app, reviewer, 'POST', `/audit/cases/${caseId}/determinations`, { code: `${RULE_PREFIX}-BORDER`, decision: 'NOT_APPLICABLE', reason: 'This seller makes no drug-device combination products.' })).statusCode).toBe(200);
    const qualified = await asAudit(app, reviewer, 'POST', `/audit/cases/${caseId}/approve`, { expectedLockVersion: await lock(), internalNote: 'Reviewer-only note.' });
    expect(qualified.statusCode, qualified.body).toBe(200);
    expect(qualified.json<{ status: string }>().status).toBe('QUALIFIED');

    // The seller is told, and sees no internal note.
    expect(await prisma.sellerNotification.count({ where: { sellerAccountId: desk.sellerAId, subjectId: caseId } })).toBeGreaterThan(0);
    const sellerView = await asCustomer(app, desk.sellerA, 'GET', `/seller/compliance/cases/${caseId}`);
    expect(sellerView.statusCode, sellerView.body).toBe(200);
    expect(sellerView.body).not.toContain('Reviewer-only note.');
    // Another seller cannot see it at all.
    expect((await asCustomer(app, desk.sellerB, 'GET', `/seller/compliance/cases/${caseId}`)).statusCode).toBe(404);

    // The same seller asking for an unrelated category starts from nothing.
    const tools = await asCustomer(app, desk.sellerA, 'POST', '/seller/compliance/cases', {
      idempotencyKey: newId(),
      payload: { level: 'SELLER_CATEGORY', categoryId: categoryOther, supplyRole: 'MANUFACTURER' },
    });
    const toolsCase = tools.json<{ id: string }>().id;
    const toolsLock = (await prisma.complianceCase.findUniqueOrThrow({ where: { id: toolsCase }, select: { lockVersion: true } })).lockVersion;
    await asAudit(app, reviewer, 'POST', `/audit/cases/${toolsCase}/start`, { expectedLockVersion: toolsLock });
    const refused = await asAudit(app, reviewer, 'POST', `/audit/cases/${toolsCase}/approve`, { expectedLockVersion: toolsLock + 1 });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.body).toContain('MISSING');
  });

  it('applies the listing gate only where an approved rule reaches, and only when enforced', async () => {
    setEnv({ COMPLIANCE_QUALIFICATION_ENFORCEMENT: 'ENFORCE' });
    try {
      expect((await qualificationGate(desk.sellerAId, categoryLeaf)).allowed).toBe(true);
      expect((await qualificationGate(desk.sellerBId, categoryLeaf)).allowed).toBe(false);
      expect((await qualificationGate(desk.sellerAId, categoryOther)).allowed).toBe(false);
      setEnv({ COMPLIANCE_QUALIFICATION_ENFORCEMENT: 'WARN' });
      expect(await qualificationGate(desk.sellerBId, categoryLeaf)).toMatchObject({ allowed: true, missing: true });
      setEnv({ COMPLIANCE_QUALIFICATION_ENFORCEMENT: 'OFF' });
      expect((await qualificationGate(desk.sellerBId, categoryLeaf)).allowed).toBe(true);
    } finally {
      setEnv({ COMPLIANCE_QUALIFICATION_ENFORCEMENT: 'OFF' });
    }
  });

  it('sends a qualification back for review when its document expires', async () => {
    await prisma.sellerCertification.update({ where: { id: licenceDocumentId }, data: { expiresOn: new Date('2026-01-01T00:00:00.000Z') } });
    expect(await expireComplianceDocuments()).toBeGreaterThanOrEqual(1);
    const row = await prisma.complianceCase.findUniqueOrThrow({ where: { id: caseId }, select: { status: true } });
    expect(row.status).toBe('REREVIEW_REQUIRED');
    const detail = await asAudit(app, reviewer, 'GET', `/audit/cases/${caseId}`);
    const outcome = detail.json<{ evaluation: { outcomes: { code: string; state: string }[] } }>().evaluation.outcomes.find((entry) => entry.code === `${RULE_PREFIX}-LICENCE`);
    expect(outcome?.state).toBe('PENDING_REVIEW');
  });
});

// ---------------------------------------------------------------------------

describe('module B: quantities, holds, reports and sub-lots', () => {
  let jobId = '';
  let reportId = '';
  let coordinator: Session;
  let inspector: Session;
  let qa: Session;
  let rivalCoordinator: Session;

  it('records exact quantities and named defective units, and holds an inconclusive lot', async () => {
    await prisma.sellerOrderGroup.update({ where: { id: groupId }, data: { status: 'PROCESSING', deliveredAt: null } });
    await prisma.inspectionRule.create({
      data: { id: newId(), name: `${TAG} every order`, isActive: true, priority: 1, level: 'MANDATORY', effectiveFrom: new Date(Date.now() - 86_400_000) },
    });
    await prisma.$transaction(async (tx) => { await ensureRequirement(tx, groupId); });
    await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: false } });

    const agencyRow = await asStaff(app, admin, 'POST', '/inspection/agencies', {
      idempotencyKey: newId(),
      payload: { name: `${TAG} Lab QA`, legalName: `${TAG} Lab QA Ltd`, country: 'IN', contactEmail: 'qa@audc5.test.local', dailyCapacity: 5 },
    });
    expect(agencyRow.statusCode, agencyRow.body).toBe(201);
    const agencyId = agencyRow.json<{ id: string }>().id;
    const rival = await asStaff(app, admin, 'POST', '/inspection/agencies', {
      idempotencyKey: newId(),
      payload: { name: `${TAG} Rival QA`, legalName: `${TAG} Rival QA Ltd`, country: 'IN', contactEmail: 'rival@audc5.test.local', dailyCapacity: 5 },
    });
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: desk.orderId }, select: { productId: true } });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: item.productId }, select: { categoryId: true } });
    const people: Record<string, Session> = {};
    for (const [who, role, agency, ip] of [
      ['coord', 'COORDINATOR', agencyId, '10.75.1.1'],
      ['insp', 'INSPECTOR', agencyId, '10.75.1.2'],
      ['qa', 'QA_REVIEWER', agencyId, '10.75.1.3'],
      ['rival', 'COORDINATOR', rival.json<{ id: string }>().id, '10.75.1.4'],
    ] as const) {
      const added = await asStaff(app, admin, 'POST', `/inspection/agencies/${agency}/members`, {
        idempotencyKey: newId(),
        payload: { email: auditEmailFor(TAG, who), fullName: who, role, idDocumentType: 'PASSPORT', idDocumentNumber: `${who}-9`, competenceCategoryIds: [product.categoryId] },
      });
      expect(added.statusCode, added.body).toBe(201);
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/inspection/members/${added.json<{ id: string }>().id}`,
        headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken, 'x-forwarded-for': admin.ip },
        payload: { verifyIdentity: true },
      });
      people[who] = await activateAndSignIn(app, added.json<{ userId: string }>().userId, ip);
    }
    coordinator = people.coord as Session;
    inspector = people.insp as Session;
    qa = people.qa as Session;
    rivalCoordinator = people.rival as Session;

    const booked = await asStaff(app, admin, 'POST', '/inspection/jobs', {
      idempotencyKey: newId(),
      payload: {
        sellerOrderGroupId: groupId,
        agencyId,
        scheduledFor: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        inspectionPointType: 'SELLER_PREMISES',
        inspectionPoint: { label: 'Factory', addressLine: '1 Mill Road', city: 'Pune', country: 'IN' },
        payer: 'SELLER',
        stage: 'PRE_SHIPMENT',
        scopeMethod: 'SAMPLE',
        timezone: 'Asia/Kolkata',
      },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    jobId = booked.json<{ jobId: string }>().jobId;
    // The agency hears about it in the console.
    expect(await prisma.auditNotification.count({ where: { subjectId: jobId, kind: 'JOB_OFFERED' } })).toBe(1);

    expect((await asAudit(app, coordinator, 'POST', `/audit/agency/jobs/${jobId}/accept`, { conflictStatement: 'No link to either party.', confirmNoConflict: true })).statusCode).toBe(200);
    const detail = await asAudit(app, coordinator, 'GET', `/audit/agency/jobs/${jobId}`);
    const named = detail.json<{ job: { eligibleInspectors: { id: string; fullName: string }[] } }>().job.eligibleInspectors.find((member) => member.fullName === 'insp');
    expect((await asAudit(app, coordinator, 'POST', `/audit/agency/jobs/${jobId}/assign`, { inspectorMemberId: named?.id })).statusCode).toBe(200);
    const ready = await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, {
      idempotencyKey: newId(),
      payload: { lotReference: 'LOT-9', readyDate: new Date().toISOString().slice(0, 10), locationLabel: 'Bay 1', contactName: 'Ravi', contactPhone: '+911234567890', packedStatus: 'PACKED', declaration: true },
    });
    expect(ready.statusCode, ready.body).toBe(200);
    for (const [action, payload] of [
      ['conflict', { hasConflict: false }],
      ['start', {}],
      ['sampling', { lotReference: 'LOT-9', sampledQuantity: 3, acceptedQuantity: 3, rejectedQuantity: 0 }],
    ] as const) {
      const step = await asAudit(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/${action}`, payload);
      expect(step.statusCode, `${action}: ${step.body}`).toBe(200);
    }

    // Quantities: a fraction of a piece and counts that do not add up are refused.
    const quantities = `/audit/agency/jobs/${jobId}/quantities`;
    expect((await asAudit(app, inspector, 'POST', quantities, { unit: 'PIECE', verifiedQuantity: '2.5' })).statusCode).toBe(400);
    expect((await asAudit(app, inspector, 'POST', quantities, { unit: 'PIECE', verifiedQuantity: '3', functionallyTestedQuantity: '3', testedConformingQuantity: '3', testedNonconformingQuantity: '1' })).statusCode).toBe(400);
    const recorded = await asAudit(app, inspector, 'POST', quantities, {
      unit: 'PIECE',
      declaredQuantity: '3',
      verifiedQuantity: '3',
      countingMethod: 'FULL_COUNT',
      sampledQuantity: '3',
      functionallyTestedQuantity: '2',
      testedConformingQuantity: '2',
      testedNonconformingQuantity: '0',
    });
    expect(recorded.statusCode, recorded.body).toBe(200);
    expect(recorded.json<{ statement: string }>().statement).toBe('2 of 2 tested units passed; 1 units were not tested.');

    // A defect naming its units must count one occurrence per unit named.
    // (How occurrences and defective units are counted - one unit with three
    // defects is one defective unit - is the unit test's job; on a three-unit
    // lot any recorded defect would fail it, which is not this test's point.)
    const mismatch = await asAudit(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/defects`, {
      severity: 'MINOR', requirementRef: 'Label 3.1', description: 'Smudged print', defectQuantity: 1, unitRefs: ['U-1', 'U-2'],
    });
    expect(mismatch.statusCode, mismatch.body).toBe(400);
    expect(mismatch.body).toContain('UNITS_DO_NOT_MATCH');

    // A laboratory sample whose result is not back yet.
    const sample = await asAudit(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/lab-samples`, {
      sampleCode: 's-1', description: 'Three units for tensile testing', quantity: '3', unit: 'PIECE', sealNumber: 'SEAL-77', takenAt: new Date().toISOString(), laboratoryName: 'Test Lab',
    });
    expect(sample.statusCode, sample.body).toBe(200);
    expect((await asAudit(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/lab-samples`, { sampleCode: 'S-1', description: 'Again', takenAt: new Date().toISOString() })).statusCode).toBe(409);

    const view = await asAudit(app, inspector, 'GET', `/audit/agency/jobs/${jobId}`);
    for (const item of view.json<{ job: { checklist: { code: string }[] } }>().job.checklist) {
      await asAudit(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/checks`, { itemCode: item.code, outcome: 'CONFORM' });
    }
    const crlf = String.fromCharCode(13, 10);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    for (const fields of [{ purpose: 'GENERAL' }]) {
      const head = Object.entries(fields).map(([k, v]) => `--b${crlf}Content-Disposition: form-data; name="${k}"${crlf}${crlf}${v}${crlf}`).join('');
      const uploaded = await app.inject({
        method: 'POST',
        url: `/api/v1/audit/agency/jobs/${jobId}/evidence`,
        headers: { cookie: inspector.cookie, 'x-csrf-token': inspector.csrf, 'x-forwarded-for': inspector.ip, 'idempotency-key': newId(), 'content-type': 'multipart/form-data; boundary=b' },
        payload: Buffer.concat([Buffer.from(`${head}--b${crlf}Content-Disposition: form-data; name="file"; filename="p.png"${crlf}Content-Type: image/png${crlf}${crlf}`), png, Buffer.from(`${crlf}--b--${crlf}`)]),
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
    }
    const submitted = await asAudit(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/report/submit`, { summary: 'Everything checked conformed.', limitations: 'Tensile results pending from the laboratory.' });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json<{ result: string }>().result).toBe('INCONCLUSIVE');
    expect(await prisma.auditNotification.count({ where: { subjectId: jobId, kind: 'REPORT_SUBMITTED' } })).toBe(1);

    // The inspector can never sign; QA signs.
    expect((await asAudit(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/report/sign`)).statusCode).toBe(403);
    const signed = await asAudit(app, qa, 'POST', `/audit/agency/jobs/${jobId}/report/sign`);
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json<{ result: string }>().result).toBe('INCONCLUSIVE');
    reportId = signed.json<{ reportId: string }>().reportId;

    const requirement = await prisma.inspectionRequirement.findUniqueOrThrow({ where: { sellerOrderGroupId: groupId }, select: { status: true } });
    expect(requirement.status).toBe('ON_HOLD');
    const dispatch = await asCustomer(app, desk.sellerA, 'POST', `/seller/orders/${groupId}/shipments`, {
      idempotencyKey: newId(),
      payload: { carrierName: 'Test Carrier', trackingNumber: 'AUDC5-ALL' },
    });
    expect(dispatch.statusCode, dispatch.body).toBe(409);
    expect(dispatch.body).toContain('INCONCLUSIVE');
  });

  it('serves the report PDF only to those allowed to see it', async () => {
    const own = await asAudit(app, qa, 'GET', `/audit/agency/reports/${reportId}/pdf`);
    expect(own.statusCode, own.body).toBe(200);
    expect(own.headers['content-type']).toContain('application/pdf');
    expect(own.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await asAudit(app, rivalCoordinator, 'GET', `/audit/agency/reports/${reportId}/pdf`)).statusCode).toBe(404);
    expect((await asAudit(app, supervisor, 'GET', `/audit/reports/${reportId}/pdf`)).statusCode).toBe(200);
    expect((await asCustomer(app, desk.sellerA, 'GET', `/seller/inspection/reports/${reportId}/pdf`)).statusCode).toBe(200);
    expect((await asCustomer(app, desk.sellerB, 'GET', `/seller/inspection/reports/${reportId}/pdf`)).statusCode).toBe(404);
    expect((await asCustomer(app, desk.rivalBuyer, 'GET', `/inspection/buyer/reports/${reportId}/pdf`)).statusCode).toBe(404);
  });

  it('keeps the original report when it is corrected, and never lets an inspector correct it', async () => {
    const before = await prisma.inspectionReport.findUniqueOrThrow({ where: { id: reportId }, select: { contentHash: true, signature: true } });
    expect((await asAudit(app, inspector, 'POST', `/audit/agency/reports/${reportId}/correct`, { reason: 'Fixing the label clause reference.' })).statusCode).toBe(403);
    const corrected = await asAudit(app, qa, 'POST', `/audit/agency/reports/${reportId}/correct`, {
      reason: 'The defect was against label clause 3.2, not 3.1.',
      summary: 'Everything checked conformed; tensile results pending (sample S-1).',
    });
    expect(corrected.statusCode, corrected.body).toBe(201);
    const after = await prisma.inspectionReport.findUniqueOrThrow({ where: { id: reportId }, select: { contentHash: true, signature: true, supersededAt: true, supersededByReportId: true } });
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.signature).toBe(before.signature);
    expect(after.supersededByReportId).toBe(corrected.json<{ reportId: string }>().reportId);
    const correction = await prisma.inspectionReport.findUniqueOrThrow({ where: { id: after.supersededByReportId ?? '' }, select: { result: true, correctsReportId: true } });
    expect(correction).toEqual({ result: 'INCONCLUSIVE', correctsReportId: reportId });
    // A second correction of the same (now superseded) revision is refused.
    expect((await asAudit(app, qa, 'POST', `/audit/agency/reports/${reportId}/correct`, { reason: 'A second correction of the same revision.' })).statusCode).toBe(409);
  });

  it('releases an identified sub-lot exactly once, after somebody else approves it', async () => {
    const lines = await prisma.sellerOrderLine.findMany({ where: { orderGroupId: groupId }, select: { orderItemId: true, quantity: true } });
    const big = lines.find((line) => line.quantity === 2);
    expect(big).toBeDefined();
    const whole = await asAudit(app, supervisor, 'POST', `/audit/jobs/${jobId}/sublot-releases`, {
      subLotCode: 'SL-ALL', lotReference: 'LOT-9', quantity: '3', unit: 'PIECE',
      lines: lines.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity })),
      reason: 'Every unit was segregated and re-checked against the reference sample by the supervisor on site.',
    });
    expect(whole.statusCode, whole.body).toBe(409);
    expect(whole.body).toContain('WHOLE_LOT');
    expect((await asAudit(app, reviewer, 'POST', `/audit/jobs/${jobId}/sublot-releases`, {})).statusCode).toBe(403);

    const requested = await asAudit(app, supervisor, 'POST', `/audit/jobs/${jobId}/sublot-releases`, {
      subLotCode: 'SL-1', lotReference: 'LOT-9', quantity: '1', unit: 'PIECE',
      lines: [{ orderItemId: big?.orderItemId, quantity: 1 }],
      reason: 'Carton C1 was segregated, its unit re-labelled and re-checked; it is held apart under seal SEAL-78.',
    });
    expect(requested.statusCode, requested.body).toBe(201);
    const subLotId = requested.json<{ id: string }>().id;

    // Not usable until approved.
    const early = await asCustomer(app, desk.sellerA, 'POST', `/seller/orders/${groupId}/shipments`, {
      idempotencyKey: newId(),
      payload: { carrierName: 'Test Carrier', trackingNumber: 'AUDC5-EARLY', contents: [{ orderItemId: big?.orderItemId, quantity: 1 }] },
    });
    expect(early.statusCode, early.body).toBe(409);

    const decided = await asStaff(app, admin, 'POST', `/inspection/sublot-releases/${subLotId}/decision`, { idempotencyKey: newId(), payload: { decision: 'APPROVE', note: 'Checked the segregation photos.' } });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await asStaff(app, admin, 'POST', `/inspection/sublot-releases/${subLotId}/decision`, { idempotencyKey: newId(), payload: { decision: 'APPROVE' } })).statusCode).toBe(409);
    expect(supervisorUserId).not.toBe('');

    // More than the sub-lot covers is refused.
    const tooMuch = await asCustomer(app, desk.sellerA, 'POST', `/seller/orders/${groupId}/shipments`, {
      idempotencyKey: newId(),
      payload: { carrierName: 'Test Carrier', trackingNumber: 'AUDC5-MORE', contents: [{ orderItemId: big?.orderItemId, quantity: 2 }] },
    });
    expect(tooMuch.statusCode, tooMuch.body).toBe(409);

    // Two dispatches at once: exactly one uses it.
    const send = (tracking: string) =>
      asCustomer(app, desk.sellerA, 'POST', `/seller/orders/${groupId}/shipments`, {
        idempotencyKey: newId(),
        payload: { carrierName: 'Test Carrier', trackingNumber: tracking, contents: [{ orderItemId: big?.orderItemId, quantity: 1 }] },
      });
    const results = await Promise.allSettled([send('AUDC5-A'), send('AUDC5-B')]);
    const codes = results.map((result) => (result.status === 'fulfilled' ? result.value.statusCode : 0)).sort();
    expect(codes).toEqual([201, 409]);
    const used = await prisma.inspectionSubLotRelease.findUniqueOrThrow({ where: { id: subLotId }, select: { consumedAt: true } });
    expect(used.consumedAt).not.toBeNull();
    // The rest of the lot is still held, and the order did not become SHIPPED.
    const group = await prisma.sellerOrderGroup.findUniqueOrThrow({ where: { id: groupId }, select: { status: true } });
    expect(group.status).not.toBe('SHIPPED');
    const requirement = await prisma.inspectionRequirement.findUniqueOrThrow({ where: { sellerOrderGroupId: groupId }, select: { loadReleasedAt: true } });
    expect(requirement.loadReleasedAt).toBeNull();
  });

  it('shows the audit team every agency’s job, read-only, and agencies only their own', async () => {
    const staffList = await asAudit(app, supervisor, 'GET', '/audit/jobs');
    expect(staffList.statusCode, staffList.body).toBe(200);
    expect(staffList.body).toContain(jobId);
    expect((await asAudit(app, rivalCoordinator, 'GET', '/audit/jobs')).body).not.toContain(jobId);
    const detail = await asAudit(app, supervisor, 'GET', `/audit/jobs/${jobId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ extras: { quantities: { reconciliation: { status: string } }; defectUnits: { defectiveUnitsIdentified: number } } }>().extras).toMatchObject({
      quantities: { reconciliation: { status: 'MATCHES' } },
      defectUnits: { defectiveUnitsIdentified: 0 },
    });
    // Staff cannot perform agency actions.
    expect((await asAudit(app, supervisor, 'POST', `/audit/agency/jobs/${jobId}/start`)).statusCode).toBe(403);
  });

  it('rates each seller’s health on the Amazon scale, and lists the riskiest first', async () => {
    const list = await asAudit(app, supervisor, 'GET', '/audit/sellers?sort=risk');
    expect(list.statusCode, list.body).toBe(200);
    type Row = { id: string; health: { score: number; band: string; bySeverity: Record<string, number>; passRatePercent: number | null } };
    const rows = list.json<{ sellers: Row[] }>().sellers;
    const sellerA = rows.find((row) => row.id === desk.sellerAId);
    // Seller A's only signed report is INCONCLUSIVE, so its pass rate is 0%.
    expect(sellerA?.health.passRatePercent).toBe(0);
    for (const row of rows) expect(['HEALTHY', 'AT_RISK', 'UNHEALTHY']).toContain(row.health.band);
    const scores = rows.map((row) => row.health.score);
    expect(scores).toEqual([...scores].sort((a, b) => a - b));

    const healthy = await asAudit(app, supervisor, 'GET', '/audit/sellers?health=HEALTHY');
    expect(healthy.json<{ sellers: Row[] }>().sellers.every((row) => row.health.band === 'HEALTHY')).toBe(true);
    expect((await asAudit(app, supervisor, 'GET', '/audit/sellers?health=SICK')).statusCode).toBe(400);

    const detail = await asAudit(app, supervisor, 'GET', `/audit/sellers/${desk.sellerAId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const health = detail.json<{ health: { score: number; band: string; issues: { kind: string; severity: string; count: number }[]; inspection: { reports: number } } }>().health;
    expect(health.score).toBe(sellerA?.health.score);
    expect(health.inspection.reports).toBeGreaterThanOrEqual(1);
  });

  it('shows the audit team quality insights, and keeps them from agencies', async () => {
    const insights = await asAudit(app, supervisor, 'GET', '/audit/insights');
    expect(insights.statusCode, insights.body).toBe(200);
    const body = insights.json<{
      months: { month: string; pass: number; fail: number; inconclusive: number }[];
      reports: { total: number; inconclusive: number };
      suppliers: { worst: { sellerAccountId: string }[] };
      agencies: { name: string; completed: number }[];
      health: { sellers: number; bands: Record<string, number> } | null;
    }>();
    expect(body.months).toHaveLength(12);
    expect(body.reports.inconclusive).toBeGreaterThanOrEqual(1);
    expect(body.reports.total).toBe(body.months.reduce((sum, row) => sum + row.pass + row.fail + row.inconclusive, 0));
    expect(body.suppliers.worst.map((row) => row.sellerAccountId)).toContain(desk.sellerAId);
    expect(body.agencies.some((row) => row.name.startsWith(TAG) && row.completed >= 1)).toBe(true);
    expect(body.health?.sellers).toBe(Object.values(body.health?.bands ?? {}).reduce((sum, count) => sum + count, 0));
    expect((await asAudit(app, coordinator, 'GET', '/audit/insights')).statusCode).toBe(403);
  });
});
