/**
 * Shipment Assessment, end to end, with real console, admin and Seller Hub
 * sessions: the badge requirement, the physical round, QA by a second person,
 * the waiver path, and the L2 gate refusing every way round it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { COMMON_CHECKLIST } from '../../src/domain/shipment-assessment.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { transitionLeg } from '../../src/modules/logistics/shipment-leg.service.js';
import { sweepShipmentAssessments, uploadEvidence } from '../../src/modules/shipment-assessment/assessment.service.js';
import { asAudit, auditPerson, cleanUpAuditPeople } from '../support/audit-session.js';

type AuditSession = Awaited<ReturnType<typeof auditPerson>>['session'];
import { asCustomer, asStaff, buildOrderDesk, cleanUpOrderDesk, errorCode, staff, type OrderDesk, type StaffSession } from '../support/order-desk-fixture.js';

const TAG = 'shipassess';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
const saved = { FEATURE_SHIPMENT_ASSESSMENT: env.FEATURE_SHIPMENT_ASSESSMENT };

let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let admin: StaffSession;
let supervisor: AuditSession;
let reviewer: AuditSession;
let reviewerId: string;
let supervisorId: string;
const groups: { a: string; b: string } = { a: '', b: '' };
const legs: Record<string, { l1: string; l2: string }> = {};

async function makeLegs(groupId: string, sellerAccountId: string): Promise<{ l1: string; l2: string }> {
  const l1 = newId();
  const l2 = newId();
  await prisma.shipmentLeg.createMany({
    data: [
      { id: l1, orderId: desk.orderId, sellerOrderGroupId: groupId, sellerAccountId, level: 'L1', sequence: 1, owner: 'SELLER', status: 'ASSIGNED' },
      { id: l2, orderId: desk.orderId, sellerOrderGroupId: groupId, sellerAccountId, level: 'L2', sequence: 2, owner: 'SELLER', status: 'PENDING' },
    ],
  });
  return { l1, l2 };
}

const sellerEditor = (sellerAccountId: string) => ({ kind: 'SELLER' as const, sellerAccountId, userId: null, label: 'test seller' });

async function finishL1(groupKey: 'a' | 'b', sellerAccountId: string): Promise<void> {
  const leg = legs[groupKey];
  if (leg === undefined) throw new Error('no legs');
  await transitionLeg(sellerEditor(sellerAccountId), leg.l1, { to: 'IN_PROGRESS' });
  await transitionLeg(sellerEditor(sellerAccountId), leg.l1, { to: 'COMPLETED' });
  // The test books L2 by hand so it is the owner's to start.
  await prisma.shipmentLeg.update({ where: { id: leg.l2 }, data: { status: 'ASSIGNED' } });
}

async function caseOf(groupId: string) {
  return prisma.shipmentAssessment.findUniqueOrThrow({ where: { sellerOrderGroupId: groupId } });
}

async function startL2(groupKey: 'a' | 'b', sellerAccountId: string) {
  const leg = legs[groupKey];
  if (leg === undefined) throw new Error('no legs');
  return transitionLeg(sellerEditor(sellerAccountId), leg.l2, { to: 'IN_PROGRESS' });
}

async function refusalOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    const typed = error as { code?: string; details?: { code?: string }[] };
    return `${typed.code ?? ''}:${typed.details?.[0]?.code ?? ''}`;
  }
}

async function cleanUp(): Promise<void> {
  const groupIds = [groups.a, groups.b].filter((id) => id !== '');
  if (groupIds.length === 0) return;
  const cases = await prisma.shipmentAssessment.findMany({ where: { sellerOrderGroupId: { in: groupIds } }, select: { id: true } });
  await prisma.auditDocument.deleteMany({ where: { OR: [{ assessmentId: { in: cases.map((row) => row.id) } }, { sellerAccountId: { in: [desk.sellerAId, desk.sellerBId] } }] } });
  await prisma.shipmentAssessment.deleteMany({ where: { sellerOrderGroupId: { in: groupIds } } });
  await prisma.shipmentLeg.deleteMany({ where: { sellerOrderGroupId: { in: groupIds } } });
  await prisma.sellerBadgeChange.deleteMany({ where: { sellerAccountId: { in: [desk.sellerAId, desk.sellerBId] } } });
  await prisma.inspectionRequirement.deleteMany({ where: { sellerOrderGroupId: { in: groupIds } } });
  await prisma.sellerAccount.updateMany({ where: { id: { in: [desk.sellerAId, desk.sellerBId] } }, data: { auditBadge: null, auditBadgeVersion: 0 } });
}

beforeAll(async () => {
  Object.assign(env, { FEATURE_SHIPMENT_ASSESSMENT: true });
  app = await buildApp();
  await app.ready();
  await cleanUpOrderDesk(TAG);
  await prisma.user.deleteMany({ where: { emailNormalized: `${TAG}-admin@orderdesk.test.local` } }).catch(() => undefined);
  desk = await buildOrderDesk(app, TAG, 91);
  await cleanUpAuditPeople(TAG);
  admin = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.91.0.10');
  const people = await Promise.all([
    auditPerson(app, { tag: TAG, who: 'super', ip: '10.91.0.11', target: { kind: 'STAFF', role: 'SUPERVISOR' } }),
    auditPerson(app, { tag: TAG, who: 'review', ip: '10.91.0.12', target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } }),
  ]);
  [supervisor, reviewer] = [people[0].session, people[1].session];
  [supervisorId, reviewerId] = [people[0].userId, people[1].userId];
  groups.a = (await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: desk.orderId, sellerAccountId: desk.sellerAId } })).id;
  const existingB = await prisma.sellerOrderGroup.findFirst({ where: { orderId: desk.orderId, sellerAccountId: desk.sellerBId } });
  groups.b =
    existingB?.id ??
    (await prisma.sellerOrderGroup.create({ data: { id: newId(), orderId: desk.orderId, sellerAccountId: desk.sellerBId, sellerOrderNumber: `SAB-${newId().slice(-8)}`, currency: 'INR' } })).id;
  await cleanUp();
  legs['a'] = await makeLegs(groups.a, desk.sellerAId);
  legs['b'] = await makeLegs(groups.b, desk.sellerBId);
}, 300_000);

afterAll(async () => {
  await cleanUp();
  Object.assign(env, saved);
  await cleanUpAuditPeople(TAG);
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('physical assessment (no badge)', () => {
  it('opens a case awaiting L1, and nothing can be assessed before L1', async () => {
    await sweepShipmentAssessments();
    const row = await caseOf(groups.a);
    expect(row).toMatchObject({ status: 'AWAITING_L1', requirement: 'ASSESSMENT_REQUIRED', existingAtRollout: false });
    const start = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/rounds`, { expectedVersion: row.version });
    expect(start.statusCode).toBe(409);
    expect(errorCode(start)).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED');
  });

  it('L1 completion opens the assessment queue; L2 is refused by the service and the Seller Hub route', async () => {
    await finishL1('a', desk.sellerAId);
    const row = await caseOf(groups.a);
    expect(row.status).toBe('READY_FOR_ASSESSMENT');
    expect(row.l1CompletedAt).not.toBeNull();
    expect(await refusalOf(startL2('a', desk.sellerAId))).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED:NOT_APPROVED');
    const http = await asCustomer(app, desk.sellerA, 'POST', `/seller/orders/${groups.a}/legs/L2/transition`, { payload: { to: 'IN_PROGRESS' } });
    expect(http.statusCode, http.body).toBe(409);
    expect(errorCode(http)).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED');
    expect((await prisma.shipmentLeg.findUniqueOrThrow({ where: { id: legs['a']?.l2 ?? '' } })).status).toBe('ASSIGNED');
  });

  it('no badge means no waiver', async () => {
    const row = await caseOf(groups.a);
    const response = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/waiver-review`, { expectedVersion: row.version });
    expect(errorCode(response)).toBe('SHIPMENT_WAIVER_NOT_ALLOWED');
  });

  it('admin reads but cannot decide', async () => {
    const row = await caseOf(groups.a);
    const read = await asStaff(app, admin, 'GET', `/shipment-assessments/${row.id}`);
    expect(read.statusCode).toBe(200);
    const write = await asStaff(app, admin, 'POST', `/shipment-assessments/${row.id}/rounds`, { payload: { expectedVersion: row.version } });
    expect(write.statusCode).toBe(404);
    // An admin cookie is not an Audit Console session.
    const audit = await app.inject({ method: 'POST', url: `/api/v1/audit/shipment-assessments/${row.id}/rounds`, headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken }, payload: { expectedVersion: row.version } });
    expect([401, 403]).toContain(audit.statusCode);
  });

  it('a hold blocks the whole shipment and issues a findings report, not a certificate', async () => {
    let row = await caseOf(groups.a);
    expect((await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/rounds`, { expectedVersion: row.version })).statusCode).toBe(204);
    row = await caseOf(groups.a);
    const incomplete = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/submit`, { findingsSummary: 'Nothing recorded yet', expectedVersion: row.version });
    expect(errorCode(incomplete)).toBe('SHIPMENT_ASSESSMENT_INCOMPLETE');
    for (const item of COMMON_CHECKLIST.filter((entry) => entry.evidenceRequired)) {
      await uploadEvidence({ userId: reviewerId, role: 'AUDIT' }, row.id, { itemCode: item.code, note: null, fileName: `${item.code}.png`, bytes: PNG });
    }
    const checks = COMMON_CHECKLIST.filter((item) => item.phase === 'PRE_LOADING').map((item) => ({ itemCode: item.code, outcome: item.code === 'F1' ? 'HOLD' : 'PASS', note: item.code === 'F1' ? 'Two cartons wet' : null }));
    expect((await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/checks`, { checks })).statusCode).toBe(204);
    const submitted = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/submit`, { findingsSummary: 'Outer cartons wet on two packages.', expectedVersion: row.version });
    expect(submitted.statusCode, submitted.body).toBe(204);
    row = await caseOf(groups.a);
    expect(row.status).toBe('ON_HOLD');
    const docs = await prisma.auditDocument.findMany({ where: { assessmentId: row.id } });
    expect(docs.map((doc) => doc.kind)).toEqual(['SHIPMENT_FINDINGS_REPORT']);
    expect(await refusalOf(startL2('a', desk.sellerAId))).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED:NOT_APPROVED');
  });

  it('the seller answers; reassessment keeps the first round', async () => {
    let row = await caseOf(groups.a);
    const answered = await asCustomer(app, desk.sellerA, 'POST', `/seller/shipment-assessments/${row.id}/response`, { payload: { correctiveResponse: 'Cartons replaced and re-labelled.' } });
    expect(answered.statusCode, answered.body).toBe(204);
    // The seller cannot reach an audit decision route.
    const sellerTry = await asCustomer(app, desk.sellerA, 'POST', `/audit/shipment-assessments/${row.id}/qa`, { payload: { decision: 'APPROVED', expectedVersion: row.version } });
    expect([401, 403]).toContain(sellerTry.statusCode);
    row = await caseOf(groups.a);
    expect((await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/reassessment`, { reason: 'Cartons replaced; repeat the round.', expectedVersion: row.version })).statusCode).toBe(204);
    row = await caseOf(groups.a);
    expect(row.status).toBe('REASSESSMENT_REQUIRED');
    expect((await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/rounds`, { expectedVersion: row.version })).statusCode).toBe(204);
    row = await caseOf(groups.a);
    expect(row.currentRound).toBe(2);
    expect(await prisma.shipmentAssessmentCheck.count({ where: { assessmentId: row.id, round: 1, itemCode: 'F1', outcome: 'HOLD' } })).toBe(1);
  });

  it('passes, needs a second person for QA, and describes the sample as a sample', async () => {
    let row = await caseOf(groups.a);
    for (const item of COMMON_CHECKLIST.filter((entry) => entry.evidenceRequired)) {
      await uploadEvidence({ userId: reviewerId, role: 'AUDIT' }, row.id, { itemCode: item.code, note: null, fileName: `${item.code}.png`, bytes: PNG });
    }
    const checks = COMMON_CHECKLIST.filter((item) => item.phase === 'PRE_LOADING').map((item) => ({ itemCode: item.code, outcome: 'PASS', sampled: item.section === 'C' }));
    await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/checks`, { checks });
    const ordered = row.currentRound > 0 ? (await prisma.shipmentAssessmentRound.findUniqueOrThrow({ where: { assessmentId_round: { assessmentId: row.id, round: 2 } } })).orderedQuantity ?? 0 : 0;
    const quantities = await asAudit(app, reviewer, 'PUT', `/audit/shipment-assessments/${row.id}/quantities`, {
      declaredQuantity: ordered,
      presentedQuantity: ordered,
      countedQuantity: ordered,
      sampledQuantity: 1,
      approvedQuantity: ordered,
      samplingMethod: 'Approved plan sample',
      countingMethod: 'Full carton count',
    });
    expect(quantities.statusCode, quantities.body).toBe(204);
    const submitted = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/submit`, { findingsSummary: 'No findings.', expectedVersion: row.version });
    expect(submitted.statusCode, submitted.body).toBe(204);
    row = await caseOf(groups.a);
    expect(row.status).toBe('AWAITING_QA');

    const noKey = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/qa`, { decision: 'APPROVED', expectedVersion: row.version });
    expect(noKey.statusCode).toBe(403);
    const noDeadline = await asAudit(app, supervisor, 'POST', `/audit/shipment-assessments/${row.id}/qa`, { decision: 'APPROVED', expectedVersion: row.version });
    expect(errorCode(noDeadline)).toBe('SHIPMENT_ASSESSMENT_POLICY_INVALID');
    const deadline = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const approved = await asAudit(app, supervisor, 'POST', `/audit/shipment-assessments/${row.id}/qa`, { decision: 'APPROVED', expectedVersion: row.version, dispatchDeadline: deadline, deadlineJustification: 'Vessel cut-off in five days; goods are stable.' });
    expect(approved.statusCode, approved.body).toBe(204);
    row = await caseOf(groups.a);
    expect(row.status).toBe('APPROVED_FOR_L2');
    const certificate = await prisma.auditDocument.findFirstOrThrow({ where: { assessmentId: row.id, kind: 'SHIPMENT_ASSESSMENT_CERTIFICATE' } });
    expect(certificate.signedByUserId).toBe(supervisorId);
    expect(JSON.stringify(certificate.scopeJson)).not.toMatch(/address|street/i);
  });

  it('refuses L2 until the loading checks pass, and after the shipment changes', async () => {
    const row = await caseOf(groups.a);
    expect(await refusalOf(startL2('a', desk.sellerAId))).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED:LOADING_CHECKS_PENDING');
    for (const code of ['K1', 'K3']) await uploadEvidence({ userId: reviewerId, role: 'AUDIT' }, row.id, { itemCode: code, note: null, fileName: `${code}.png`, bytes: PNG });
    const loading = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/checks`, { checks: ['K1', 'K2', 'K3', 'K4'].map((itemCode) => ({ itemCode, outcome: 'PASS' })) });
    expect(loading.statusCode, loading.body).toBe(204);
    expect((await caseOf(groups.a)).loadingChecksCompletedAt).not.toBeNull();

    const line = await prisma.sellerOrderLine.findFirstOrThrow({ where: { orderGroupId: groups.a } });
    await prisma.sellerOrderLine.update({ where: { id: line.id }, data: { quantity: line.quantity + 1 } });
    expect(await refusalOf(startL2('a', desk.sellerAId))).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED:SHIPMENT_CHANGED');
    await prisma.sellerOrderLine.update({ where: { id: line.id }, data: { quantity: line.quantity } });
  });

  it('two departures at once: exactly one consumes the release', async () => {
    const results = await Promise.allSettled([startL2('a', desk.sellerAId), startL2('a', desk.sellerAId)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const row = await caseOf(groups.a);
    expect(row.status).toBe('DISPATCHED');
    const releases = await prisma.shipmentReleaseAuthorization.findMany({ where: { assessmentId: row.id } });
    expect(releases.filter((release) => release.status === 'CONSUMED')).toHaveLength(1);
    expect((await prisma.auditDocument.findFirstOrThrow({ where: { assessmentId: row.id, kind: 'SHIPMENT_ASSESSMENT_CERTIFICATE' } })).status).toBe('USED');
  });

  it('the public check shows status and scope only', async () => {
    const row = await caseOf(groups.a);
    const doc = await prisma.auditDocument.findFirstOrThrow({ where: { assessmentId: row.id, kind: 'SHIPMENT_ASSESSMENT_CERTIFICATE' } });
    const { verificationCode } = await import('../../src/modules/documents/document-format.js');
    const response = await app.inject({ method: 'GET', url: `/api/v1/documents/verify?kind=audit-document&number=${doc.number}&code=${verificationCode('audit-document', doc.number)}` });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({ valid: true, status: 'USED' });
    expect(JSON.stringify(body)).not.toMatch(/storageKey|evidence|address/i);
    const wrong = await app.inject({ method: 'GET', url: `/api/v1/documents/verify?kind=audit-document&number=${doc.number}&code=AAAAAAAAAAAAAAAA` });
    expect(wrong.json<{ valid: boolean }>().valid).toBe(false);
  });
});

describe('badge waiver (seller B)', () => {
  it('Gold is eligible, but only an auditor with a written history review can waive', async () => {
    const seller = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: desk.sellerBId } });
    const sellerSets = await asCustomer(app, desk.sellerB, 'POST', `/audit/sellers/${desk.sellerBId}/badge`, { payload: { tier: 'PLATINUM' } });
    expect([401, 403, 404]).toContain(sellerSets.statusCode);
    const set = await asAudit(app, supervisor, 'PUT', `/audit/sellers/${desk.sellerBId}/badge`, { tier: 'GOLD', reason: 'Twelve months without findings.', expectedVersion: seller.auditBadgeVersion });
    expect(set.statusCode, set.body).toBe(204);
    await sweepShipmentAssessments();
    await finishL1('b', desk.sellerBId);
    let row = await caseOf(groups.b);
    expect(row).toMatchObject({ status: 'WAIVER_REVIEW', requirement: 'WAIVER_ELIGIBLE_WITH_REVIEW' });
    // Eligibility alone does not release L2.
    expect(await refusalOf(startL2('b', desk.sellerBId))).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED:NOT_APPROVED');

    const history = await asAudit(app, reviewer, 'GET', `/audit/shipment-assessments/${row.id}/waiver-history`);
    expect(history.json<{ available: boolean }>().available).toBe(true);
    const deadline = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const noReview = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/waiver`, { decision: 'APPROVED', reason: 'Gold seller with a clean record.', expectedVersion: row.version, dispatchDeadline: deadline, deadlineJustification: 'Booked sailing in three days.' });
    expect(errorCode(noReview)).toBe('SHIPMENT_WAIVER_NOT_ALLOWED');
    const approved = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/waiver`, {
      decision: 'APPROVED',
      reason: 'Gold seller with a clean record.',
      historyReviewNote: 'Reviewed the last inspections (none failed) and open complaints (none).',
      expectedVersion: row.version,
      dispatchDeadline: deadline,
      deadlineJustification: 'Booked sailing in three days.',
    });
    expect(approved.statusCode, approved.body).toBe(204);
    const replay = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/waiver`, { decision: 'APPROVED', reason: 'Gold seller with a clean record.', historyReviewNote: 'Same review submitted twice by accident.', expectedVersion: row.version, dispatchDeadline: deadline, deadlineJustification: 'Booked sailing in three days.' });
    expect(replay.statusCode).toBe(409);
    row = await caseOf(groups.b);
    expect(row.status).toBe('APPROVED_FOR_L2');
    const waiver = await prisma.shipmentWaiverDecision.findFirstOrThrow({ where: { assessmentId: row.id } });
    expect(waiver).toMatchObject({ decision: 'APPROVED', badgeAtDecision: 'GOLD', policyVersion: 1, decidedByUserId: reviewerId });
    expect(await prisma.auditDocument.count({ where: { assessmentId: row.id, kind: 'SHIPMENT_WAIVER_AUTHORIZATION' } })).toBe(1);
    // Waivers do not remove the loading checks.
    expect(await refusalOf(startL2('b', desk.sellerBId))).toBe('SHIPMENT_ASSESSMENT_NOT_RELEASED:LOADING_CHECKS_PENDING');
  });

  it('a downgrade withdraws the unused waiver; an upgrade does not create one', async () => {
    const seller = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: desk.sellerBId } });
    const down = await asAudit(app, supervisor, 'PUT', `/audit/sellers/${desk.sellerBId}/badge`, { tier: 'SILVER', reason: 'Two complaints upheld this month.', expectedVersion: seller.auditBadgeVersion });
    expect(down.statusCode, down.body).toBe(204);
    let row = await caseOf(groups.b);
    expect(row.status).toBe('READY_FOR_ASSESSMENT');
    expect(await prisma.shipmentReleaseAuthorization.count({ where: { assessmentId: row.id, status: 'ACTIVE' } })).toBe(0);
    expect((await prisma.shipmentWaiverDecision.findFirstOrThrow({ where: { assessmentId: row.id } })).invalidatedAt).not.toBeNull();
    const again = await prisma.sellerAccount.findUniqueOrThrow({ where: { id: desk.sellerBId } });
    await asAudit(app, supervisor, 'PUT', `/audit/sellers/${desk.sellerBId}/badge`, { tier: 'PLATINUM', reason: 'Complaints resolved in the seller favour.', expectedVersion: again.auditBadgeVersion });
    row = await caseOf(groups.b);
    expect(row.status).toBe('READY_FOR_ASSESSMENT');
  });

  it('a mandatory inspection cannot be waived, whatever the badge', async () => {
    await prisma.inspectionRequirement.updateMany({ where: { sellerOrderGroupId: groups.b }, data: { level: 'MANDATORY' } });
    const row = await caseOf(groups.b);
    const response = await asAudit(app, reviewer, 'POST', `/audit/shipment-assessments/${row.id}/waiver-review`, { expectedVersion: row.version });
    expect(errorCode(response)).toBe('SHIPMENT_WAIVER_NOT_ALLOWED');
  });
});
