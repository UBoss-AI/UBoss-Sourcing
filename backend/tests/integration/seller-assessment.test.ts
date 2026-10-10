/**
 * Seller Assessment and Onboarding, end to end with real Seller Hub, Audit
 * Console and Admin sessions: one complete eligible application-to-release
 * journey, one blocked journey, and the controls around them - capabilities,
 * independence, Admin read-only, cross-seller isolation, scope isolation,
 * certificate and expiry enforcement with no job run, dispositions for placed
 * orders, appeals without restoration, bank-change dual approval, concurrent
 * releases and the surveillance sweep. All fixtures are synthetic; nothing
 * here is a real verification.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { CHECKLIST, CONTRACT_KINDS, DIMENSIONS, MOCK_ORDER_STEPS, SITE_AUDIT_AREAS } from '../../src/domain/seller-assessment.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { startApplication } from '../../src/modules/seller-assessment/application.service.js';
import { sweepSurveillance } from '../../src/modules/seller-assessment/lifecycle.service.js';
import { assertDispatchAllowed, assertOffersEligible, assertOrderEligible, evaluateScope, recheckOrderAfterCapture } from '../../src/modules/seller-assessment/purchase-gate.service.js';
import { releaseGaps } from '../../src/modules/seller-assessment/release.service.js';
import { asAudit, auditPerson, cleanUpAuditPeople } from '../support/audit-session.js';
import { asStaff, buildOrderDesk, cleanUpOrderDesk, errorCode, staff, type OrderDesk, type Session, type StaffSession } from '../support/order-desk-fixture.js';

type AuditSession = Awaited<ReturnType<typeof auditPerson>>['session'];
type App = Awaited<ReturnType<typeof buildApp>>;

const TAG = 'sellerassess';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const MIN = 30_000_000_000n;
const saved = { gate: env.SELLER_ASSESSMENT_PURCHASE_GATE, draft: env.SELLER_ASSESSMENT_ALLOW_DRAFT_POLICY };

let app: App;
let desk: OrderDesk;
let admin: StaffSession;
let offerId: string;
const people: Record<string, { session: AuditSession; userId: string }> = {};
let assessmentId = '';
let approvalId = '';

const CAPS: Record<string, string[]> = {
  head: ['HEAD_OF_ASSURANCE'],
  assessor: ['ASSESS'],
  regulatory: ['REGULATORY'],
  finance1: ['FINANCE'],
  finance2: ['FINANCE'],
  legalops: ['LEGAL', 'OPERATIONS'],
  releaser: ['RELEASE'],
  multi: ['ASSESS', 'RELEASE'],
  appeal: ['APPEAL_REVIEW'],
  nobody: [],
};

const audit = (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const p = people[who];
  if (p === undefined) throw new Error(who);
  return asAudit(app, p.session, method, `/audit${url}`, payload);
};

function sellerCall(session: Session, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url: `/api/v1/seller${url}`,
    remoteAddress: session.ip,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-for': session.ip, 'idempotency-key': newId() },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

function multipart(fields: Record<string, string>, bytes: Buffer) {
  const boundary = `----sa${newId()}`;
  const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  const body = Buffer.concat([Buffer.from(parts.join('')), Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evidence.pdf"\r\nContent-Type: application/pdf\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

async function sellerUpload(session: Session, id: string, evidenceKey: string, category = 'FINANCIAL') {
  const m = multipart({ category, evidenceKey, label: evidenceKey }, PDF);
  const res = await app.inject({ method: 'POST', url: `/api/v1/seller/assessment/${id}/evidence`, remoteAddress: session.ip, headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-for': session.ip, 'idempotency-key': newId(), 'content-type': m.type }, payload: m.body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

const code = (r: LightMyRequestResponse) => errorCode(r);
const details = (r: LightMyRequestResponse) => (r.json<{ error?: { details?: { code: string }[] } }>().error?.details ?? []).map((d) => d.code);

function application(revenueMinor: bigint, over: Record<string, unknown> = {}) {
  return {
    applicantType: 'MANUFACTURER',
    entity: { legalName: `${TAG} Industries Pvt Ltd`, registrationNumber: 'U12345MH2010PTC123456', entityType: 'PRIVATE_LIMITED', country: 'IN', registeredAddress: { line1: '1 Test Road', city: 'Pune', state: 'MH', postcode: '411001', country: 'IN' }, operatingAddresses: [{ line1: '2 Plant Road', city: 'Pune', state: 'MH', postcode: '411002', country: 'IN' }] },
    directors: [{ name: 'Test Director', din: '01234567', designation: 'Director' }],
    beneficialOwners: [{ name: 'Test Owner', nationality: 'IN', ownershipPercent: '60', controlling: true }],
    signatory: { name: 'Test Director', designation: 'Director', isDirector: true },
    financial: { financialYearStart: '2025-04-01', financialYearEnd: '2026-03-31', revenueMinor: revenueMinor.toString(), currency: 'INR', measure: 'ENTITY_REVENUE_FROM_OPERATIONS_EX_GST', basis: 'AUDITED_LATEST', auditedStatementsKey: 'audited', caConfirmationKey: 'ca' },
    taxIds: { pan: 'AAACT1234A', gstin: '27AAACT1234A1Z5', iec: 'AAACT1234A', licences: [] },
    bank: { beneficiaryName: `${TAG} Industries Pvt Ltd`, accountLast4: '1234', bankCode: 'HDFC0000001', evidenceKey: 'bank' },
    brands: [{ ref: 'B1', name: 'TestBrand', trademarkNumber: 'TM1', rightsBasis: 'OWNED', evidenceKey: 'brand' }],
    facilities: [{ ref: 'F1', name: 'Pune plant', address: { line1: '2 Plant Road', city: 'Pune', state: 'MH', postcode: '411002', country: 'IN' }, countryCode: 'IN', ownedByApplicant: true, processes: 'Moulding, assembly, QC', agreementEvidenceKey: 'qa1', qualityAgreementEvidenceKey: 'qa2' }],
    outsourced: [],
    products: [{ key: 'P1', name: 'Test product', version: 'v1', sku: 'SKU-1', offerId, intendedUse: 'General purpose', facilityRef: 'F1', madeInCountry: 'IN', countries: ['IN', 'DE'], channels: ['B2B', 'B2C'] }],
    fulfilment: { model: 'SELLER_FULFILLED', monthlyCapacity: '10,000 units', leadTimeDays: 14, insurance: [{ kind: 'PRODUCT_LIABILITY', insurer: 'Test Insurer', policyNumber: 'PL-1', limitMinor: '1000000000', currency: 'INR', territories: 'IN, DE', expiresOn: '2027-09-30', evidenceKey: 'insurance' }] },
    consent: { personalDataChecks: true, auditAccess: true },
    ...over,
  };
}

async function save(id: string, patch: unknown) {
  const row = await prisma.sellerAssessment.findUniqueOrThrow({ where: { id } });
  const res = await sellerCall(desk.sellerA, 'PATCH', `/assessment/${id}/application`, { patch, expectedRevision: row.applicationRevision });
  expect(res.statusCode, res.body).toBe(200);
}

const version = async () => (await prisma.sellerAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).version;
const scopeId = async (country: string, channel: string) => (await prisma.sellerAssessmentScopeItem.findFirstOrThrow({ where: { assessmentId, countryCode: country, channel } })).id;
const paper = (who: string, kind: string, payload: unknown, subjectRef: string | null = null) => audit(who, 'POST', `/seller-assessments/${assessmentId}/workpapers`, { kind, subjectRef, payload });
const today = new Date().toISOString().slice(0, 10);

async function dropAdmin(): Promise<void> {
  const user = await prisma.user.findFirst({ where: { emailNormalized: `${TAG}-admin@orderdesk.test.local` }, select: { id: true } });
  if (user === null) return;
  await prisma.session.deleteMany({ where: { userId: user.id } });
  await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
}

async function cleanUp(): Promise<void> {
  const sellers = desk === undefined ? [] : [desk.sellerAId, desk.sellerBId];
  if (sellers.length === 0) return;
  const where = { sellerAccountId: { in: sellers } };
  await prisma.sellerOrderDisposition.deleteMany({ where });
  await prisma.sellerSurveillanceTask.deleteMany({ where });
  await prisma.sellerBankChangeRequest.deleteMany({ where });
  await prisma.sellerIncidentReport.deleteMany({ where });
  await prisma.sellerAssessmentChangeRequest.deleteMany({ where });
  await prisma.sellerAssessmentAppeal.deleteMany({ where });
  await prisma.sellerAssessmentNotice.deleteMany({ where });
  await prisma.sellerAssessmentEvent.deleteMany({ where });
  await prisma.sellerTradingApproval.deleteMany({ where });
  await prisma.auditDocument.deleteMany({ where: { ...where, kind: 'SELLER_TRADING_APPROVAL' } });
  await prisma.sellerAssessment.deleteMany({ where });
  await prisma.sellerNotification.deleteMany({ where: { ...where, kind: 'SELLER_ASSESSMENT' } });
}

beforeAll(async () => {
  Object.assign(env, { SELLER_ASSESSMENT_PURCHASE_GATE: 'enforce', SELLER_ASSESSMENT_ALLOW_DRAFT_POLICY: true });
  app = await buildApp();
  await app.ready();
  await cleanUpOrderDesk(TAG);
  await dropAdmin();
  desk = await buildOrderDesk(app, TAG, 93);
  await cleanUp();
  await cleanUpAuditPeople(TAG);
  admin = await staff(app, TAG, 'admin', Role.BUSINESS_OWNER, '10.93.0.40');
  offerId = (await prisma.sellerOffer.findFirstOrThrow({ where: { sellerAccountId: desk.sellerAId } })).id;
  let n = 20;
  for (const [who, caps] of Object.entries(CAPS)) {
    n += 1;
    const p = await auditPerson(app, { tag: TAG, who, ip: `10.93.0.${String(n)}`, target: { kind: 'STAFF', role: 'COMPLIANCE_REVIEWER' } });
    await prisma.auditStaffMember.update({ where: { userId: p.userId }, data: { assessmentCapabilitiesJson: caps } });
    people[who] = { session: p.session, userId: p.userId };
  }
}, 300_000);

afterAll(async () => {
  await cleanUp();
  Object.assign(env, { SELLER_ASSESSMENT_PURCHASE_GATE: saved.gate, SELLER_ASSESSMENT_ALLOW_DRAFT_POLICY: saved.draft });
  await cleanUpAuditPeople(TAG);
  await cleanUpOrderDesk(TAG);
  await dropAdmin();
  await app.close();
});

describe('application (Gate 1)', () => {
  it('saves and resumes, refuses an incomplete or ineligible file, accepts exactly INR 30 crore', async () => {
    const start = await sellerCall(desk.sellerA, 'POST', '/assessment', { kind: 'INITIAL' });
    expect(start.statusCode, start.body).toBe(201);
    assessmentId = start.json<{ id: string }>().id;
    // Starting again returns the open one.
    expect((await sellerCall(desk.sellerA, 'POST', '/assessment', { kind: 'INITIAL' })).json<{ id: string }>().id).toBe(assessmentId);

    await save(assessmentId, { applicantType: 'MANUFACTURER' });
    let submit = await sellerCall(desk.sellerA, 'POST', `/assessment/${assessmentId}/submit`);
    expect(submit.statusCode).toBe(409);
    expect(details(submit)).toEqual(expect.arrayContaining(['TURNOVER_MISSING', 'FACILITIES_MISSING']));

    for (const k of ['audited', 'ca', 'bank', 'brand', 'qa1', 'qa2', 'insurance']) await sellerUpload(desk.sellerA, assessmentId, k);

    await save(assessmentId, application(MIN - 1n));
    submit = await sellerCall(desk.sellerA, 'POST', `/assessment/${assessmentId}/submit`);
    expect(details(submit)).toEqual(['TURNOVER_BELOW_MINIMUM']);

    await save(assessmentId, application(MIN, { applicantType: 'TRADER' }));
    expect(details(await sellerCall(desk.sellerA, 'POST', `/assessment/${assessmentId}/submit`))).toEqual(['APPLICANT_TYPE_NOT_ELIGIBLE']);

    const foreign = application(MIN);
    foreign.facilities = [{ ...foreign.facilities[0]!, countryCode: 'CN' }];
    await save(assessmentId, foreign);
    expect(details(await sellerCall(desk.sellerA, 'POST', `/assessment/${assessmentId}/submit`))).toContain('FACILITY_OUTSIDE_INDIA');

    // A region is not a country.
    const region = application(MIN);
    region.products = [{ ...region.products[0]!, countries: ['EU'] }];
    const bad = await sellerCall(desk.sellerA, 'PATCH', `/assessment/${assessmentId}/application`, { patch: region, expectedRevision: (await prisma.sellerAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).applicationRevision });
    expect(bad.statusCode).toBe(400);

    await save(assessmentId, application(MIN));
    submit = await sellerCall(desk.sellerA, 'POST', `/assessment/${assessmentId}/submit`);
    expect(submit.statusCode, submit.body).toBe(204);
  });

  it('Admin reads but cannot decide; another seller cannot see it; a member without the capability is refused', async () => {
    const list = await asStaff(app, admin, 'GET', '/seller-assessments');
    expect(list.statusCode).toBe(200);
    const view = await asStaff(app, admin, 'GET', `/seller-assessments/${assessmentId}`);
    expect(view.json<{ assessment: { application: unknown } }>().assessment.application).toBeNull();
    expect((await asStaff(app, admin, 'POST', `/seller-assessments/${assessmentId}/accept-file`, { payload: { reason: 'admin tries' } })).statusCode).toBe(404);
    // Admin cookies do not open the Audit Console.
    const viaAudit = await app.inject({ method: 'POST', url: `/api/v1/audit/seller-assessments/${assessmentId}/accept-file`, headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken }, payload: { reason: 'admin tries' } });
    expect([401, 403]).toContain(viaAudit.statusCode);

    const other = await sellerCall(desk.sellerB, 'GET', '/assessment');
    expect(other.json<{ current: unknown }>().current).toBeNull();
    const ev = await prisma.sellerAssessmentEvidence.findFirstOrThrow({ where: { assessmentId } });
    expect((await sellerCall(desk.sellerB, 'GET', `/assessment/${assessmentId}/evidence/${ev.id}`)).statusCode).toBe(404);

    const refused = await audit('nobody', 'POST', `/seller-assessments/${assessmentId}/accept-file`, { reason: 'no capability' });
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('SELLER_ASSESSMENT_CAPABILITY_REQUIRED');
  });

  it('a correction request returns the file; resubmission and acceptance lay out the scope matrix', async () => {
    const back = await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/correction`, { note: 'Please confirm the operating address.' });
    expect(back.statusCode, back.body).toBe(204);
    expect((await sellerCall(desk.sellerA, 'POST', `/assessment/${assessmentId}/submit`)).statusCode).toBe(204);
    const accept = await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/accept-file`, { reason: 'File complete.' });
    expect(accept.statusCode, accept.body).toBe(204);
    const row = await prisma.sellerAssessment.findUniqueOrThrow({ where: { id: assessmentId } });
    expect(row.status).toBe('IN_REVIEW');
    expect(row.reviewTargetAt).not.toBeNull();
    // 1 product x 2 countries x 2 channels, each its own row.
    expect(await prisma.sellerAssessmentScopeItem.count({ where: { assessmentId } })).toBe(4);
  });
});

describe('gates 2-7', () => {
  it('refuses a gate before its prerequisites', async () => {
    const early = await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/gates/4`, { status: 'PASSED', reason: 'too early' });
    expect(code(early)).toBe('SELLER_ASSESSMENT_NOT_ALLOWED');
    expect(details(early)).toContain('PREREQUISITE_3');
  });

  it('records the checklist; N/A needs a second, authorised person; mandatory items cannot be N/A', async () => {
    const mandatory = await audit('assessor', 'PUT', `/seller-assessments/${assessmentId}/checklist/C07`, { outcome: 'NOT_APPLICABLE', evidenceRef: 'x', comment: null, expiresOn: null, naReason: 'not needed here at all' });
    expect(details(mandatory)).toContain('NA_NOT_ALLOWED');
    const reviewerFor = (gate: number) => (gate === 2 ? 'finance1' : gate === 3 ? 'regulatory' : gate === 7 ? 'legalops' : 'assessor');
    for (const item of CHECKLIST.filter((c) => c.code !== 'C23')) {
      const na = item.code === 'C19';
      const res = await audit(reviewerFor(item.gate), 'PUT', `/seller-assessments/${assessmentId}/checklist/${item.code}`, { outcome: na ? 'NOT_APPLICABLE' : 'PASS', evidenceRef: `ev-${item.code}`, comment: 'synthetic test record', expiresOn: item.expiryExpected ? '2027-08-31' : null, naReason: na ? 'Domestic only route for this synthetic test' : null });
      expect(res.statusCode, `${item.code} ${res.body}`).toBe(204);
    }
    const self = await audit('regulatory', 'POST', `/seller-assessments/${assessmentId}/checklist/C19/approve-na`, { note: 'approving my own' });
    expect(code(self)).toBe('SELLER_ASSESSMENT_CAPABILITY_REQUIRED');
    expect((await audit('head', 'POST', `/seller-assessments/${assessmentId}/checklist/C19/approve-na`, { note: 'Reviewed and agreed.' })).statusCode).toBe(204);
  });

  it('Gate 2: bank, sanctions, finance review', async () => {
    expect((await paper('finance1', 'BANK_VERIFICATION', { method: 'Call to the bank branch on its published number', knownContact: 'Branch manager', beneficiaryMatchesEntity: true, outcome: 'CONFIRMED', note: 'synthetic' })).statusCode).toBe(201);
    expect((await paper('finance1', 'SANCTIONS_SCREENING', { lists: 'UN, OFAC SDN, EU', source: 'Manual list search', provider: 'MANUAL', subjects: 'Entity, owner, director', outcome: 'NO_MATCH', note: 'synthetic' })).statusCode).toBe(201);
    expect((await paper('finance1', 'SPECIALIST_REVIEW', { area: 'FINANCE', outcome: 'SATISFACTORY', note: 'Turnover, bank and insurance reviewed (synthetic).' })).statusCode).toBe(201);
    const g = await audit('finance1', 'POST', `/seller-assessments/${assessmentId}/gates/2`, { status: 'PASSED', reason: 'Identity and finance verified.' });
    expect(g.statusCode, g.body).toBe(204);
  });

  it('Gate 3: classify each combination separately; approve only IN B2B', async () => {
    const base = { catalogueCategory: 'Test category', hsProposal: '392690', regulatoryClass: 'General product', requiredTests: 'Visual, dimensional', authorisations: 'None required (synthetic)', authorisationExpiresOn: null, localResponsible: 'Seller (domestic)', importerLicence: 'Not applicable', labelsLanguages: 'en, hi', warnings: 'Standard', restrictions: '', recallObligations: 'Seller recall plan', shippingInsurance: 'Domestic cargo cover', nextReviewAt: null };
    for (const [country, channel] of [['IN', 'B2B'], ['IN', 'B2C'], ['DE', 'B2B'], ['DE', 'B2C']] as const) {
      const approve = country === 'IN' && channel === 'B2B';
      const res = await audit('regulatory', 'PUT', `/seller-assessments/${assessmentId}/scope/${await scopeId(country, channel)}`, { ...base, decision: approve ? 'APPROVED' : 'BLOCKED', decisionReason: approve ? 'Domestic B2B cleared.' : 'Not assessed for this market.' });
      expect(res.statusCode, res.body).toBe(204);
    }
    await paper('regulatory', 'SPECIALIST_REVIEW', { area: 'REGULATORY', outcome: 'SATISFACTORY', note: 'Destination requirements recorded (synthetic).' });
    expect((await audit('regulatory', 'POST', `/seller-assessments/${assessmentId}/gates/3`, { status: 'PASSED', reason: 'Classified.' })).statusCode).toBe(204);
  });

  it('Gate 4: site audit, sample plan, lab competence', async () => {
    await paper('assessor', 'SITE_AUDIT', { facilityRef: 'F1', visitDate: today, auditors: 'Synthetic auditor', reportId: 'SAR-1', areas: Object.fromEntries(SITE_AUDIT_AREAS.map((a) => [a, 'SATISFACTORY'])), outsourcedProcessesCovered: 'None', notes: 'SYNTHETIC TEST - no visit took place' }, 'F1');
    await paper('assessor', 'SAMPLE_PLAN', { basis: 'RISK_BASED', justification: 'Single SKU, low risk (synthetic)', method: 'Random from finished goods', quantities: '5 units', acceptanceCriteria: 'Zero critical defects', laboratory: 'Synthetic Lab', testScope: 'Dimensional', selectedBy: 'Synthetic auditor', sealNumbers: 'S-1', custody: [{ at: new Date().toISOString(), from: 'Plant', to: 'Lab', sealIntact: true }], results: 'Pass (synthetic)', resultOutcome: 'PASS' });
    await paper('assessor', 'LAB_COMPETENCE', { laboratory: 'Synthetic Lab', iso17025Accreditation: null, accreditationScopeCoversTests: false, legalRecognitionRequired: false, legalRecognitionReference: null, verifiedAgainst: 'Not verified - synthetic fixture', evidenceRef: 'lab-1' });
    const g = await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/gates/4`, { status: 'PASSED', reason: 'Site and samples.' });
    expect(g.statusCode, g.body).toBe(204);
  });

  it('Gate 5: a seller upload is not authentication; the marketplace-appointed body must be authenticated', async () => {
    const appoint = await audit('head', 'POST', `/seller-assessments/${assessmentId}/certifications`, { bodyName: 'Synthetic Body', scheme: 'Synthetic Scheme', procurementRef: 'PO-1', paymentRef: 'PAY-1', accreditationBody: 'Synthetic AB', accreditationNumber: 'AB-1', sectorScope: 'Test', legalRecognition: 'None', conflictCheck: 'No conflict found (synthetic)', facilityRefs: ['F1'], productKeys: [`offer:${offerId}`], surveillanceConditions: 'Annual' });
    expect(appoint.statusCode, appoint.body).toBe(201);
    const certId = appoint.json<{ id: string }>().id;
    expect(details(await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/gates/5`, { status: 'PASSED', reason: 'premature pass' }))).toContain('CERT_NOT_AUTHENTICATED');
    const rec = await audit('assessor', 'PUT', `/seller-assessments/certifications/${certId}`, { certificateNumber: 'SYN-001', issuer: 'Synthetic Body', issuedOn: today, expiresOn: '2027-06-30', authenticityMethod: 'Synthetic issuer register lookup', authenticityReference: 'SYN-REG-001', accreditationVerified: true, independenceVerified: true, status: 'AUTHENTICATED', expectedVersion: 0 });
    expect(rec.statusCode, rec.body).toBe(204);
    expect((await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/gates/5`, { status: 'PASSED', reason: 'Certificate authenticated.' })).statusCode).toBe(204);
  });

  it('Gate 6: a major finding blocks until an auditor closes it on evidence', async () => {
    const raised = await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/findings`, { classification: 'MAJOR', requirement: 'Calibration records incomplete', evidence: 'Two gauges without certificates', ownerName: null });
    expect(raised.statusCode, raised.body).toBe(201);
    const findingId = raised.json<{ id: string }>().id;
    expect(details(await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/gates/6`, { status: 'PASSED', reason: 'premature pass' }))).toContain('CRITICAL_OR_MAJOR_OPEN');
    const closureEvidence = await sellerUpload(desk.sellerA, assessmentId, 'capa-1', 'CAPA');
    const respond = await sellerCall(desk.sellerA, 'PUT', `/assessment/findings/${findingId}`, { containment: 'Gauges quarantined', rootCause: 'No calibration schedule', correctiveAction: 'Calibrated both gauges', preventiveAction: 'Calibration schedule in QMS', ownerName: 'QA lead', closureEvidenceIds: [closureEvidence], expectedVersion: 0 });
    expect(respond.statusCode, respond.body).toBe(204);
    const close = await audit('assessor', 'POST', `/seller-assessments/findings/${findingId}/close`, { effectivenessVerification: 'Certificates checked against the lab register (synthetic).', decision: 'CLOSE', expectedVersion: 1 });
    expect(close.statusCode, close.body).toBe(204);
    expect((await audit('assessor', 'POST', `/seller-assessments/${assessmentId}/gates/6`, { status: 'PASSED', reason: 'Closed.' })).statusCode).toBe(204);
  });

  it('Gate 7: contracts and a mock order; a disabled integration cannot be marked provider-verified', async () => {
    for (const k of CONTRACT_KINDS) expect((await paper('legalops', 'CONTRACT', { contractKind: k, executedOn: today, counterpartySignatory: 'Synthetic signatory', evidenceRef: `c-${k}` })).statusCode).toBe(201);
    const steps = (mode: string, integration: string) => MOCK_ORDER_STEPS.map((step) => ({ step, mode, integration, outcome: 'PASS', note: 'synthetic' }));
    if (env.STRIPE_SECRET_KEY === '' && env.RAZORPAY_KEY_ID === '') {
      const fake = await paper('legalops', 'MOCK_ORDER', { reference: 'MOCK-1', steps: steps('PROVIDER_VERIFIED', 'PAYMENTS') });
      expect(details(fake)).toContain('INTEGRATION_NOT_ENABLED');
    }
    expect((await paper('legalops', 'MOCK_ORDER', { reference: 'MOCK-1', steps: steps('SIMULATED', 'NONE') })).statusCode).toBe(201);
    expect((await prisma.sellerAssessmentWorkpaper.findFirstOrThrow({ where: { assessmentId, kind: 'MOCK_ORDER' } })).mode).toBe('SIMULATED');
    await paper('legalops', 'SPECIALIST_REVIEW', { area: 'LEGAL', outcome: 'SATISFACTORY', note: 'Agreements executed (synthetic).' });
    await paper('legalops', 'SPECIALIST_REVIEW', { area: 'OPERATIONS', outcome: 'SATISFACTORY', note: 'Fulfilment readiness (synthetic).' });
    const g7 = await audit('legalops', 'POST', `/seller-assessments/${assessmentId}/gates/7`, { status: 'PASSED', reason: 'Ready.' });
    expect(g7.statusCode, g7.body).toBe(204);
  });

  it('scores: all dimensions rated with evidence and reasoning', async () => {
    for (const d of DIMENSIONS) {
      const who = d.code === 'INTEGRITY_CAPA' ? 'multi' : 'assessor';
      expect((await audit(who, 'PUT', `/seller-assessments/${assessmentId}/scores/${d.code}`, { rating: 4, evidenceRef: `score-${d.code}`, reasoning: 'Adequately implemented (synthetic).' })).statusCode).toBe(204);
    }
    expect((await prisma.sellerAssessment.findUniqueOrThrow({ where: { id: assessmentId } })).scoreBand).toBe('RELEASE_ELIGIBLE');
  });
});

describe('Gate 8 release', () => {
  it('nothing is purchasable before release', async () => {
    const blocks = await evaluateScope(prisma, [{ sellerAccountId: desk.sellerAId, offerId }], 'IN', 'B2B');
    expect(blocks.get(offerId)).toBe('NO_APPROVAL');
    await expect(assertOffersEligible(prisma, [offerId], 'IN', 'B2B', 'test')).rejects.toMatchObject({ code: 'SELLER_SCOPE_NOT_APPROVED' });
  });

  it('refuses an approver who took part, even holding RELEASE', async () => {
    const r = await audit('multi', 'POST', `/seller-assessments/${assessmentId}/release`, { scopeItemIds: [await scopeId('IN', 'B2B')], reason: 'Release by a participant.', nextReviewAt: null, expectedVersion: await version() });
    expect(r.statusCode).toBe(403);
    expect(code(r)).toBe('SELLER_ASSESSMENT_INDEPENDENCE_REQUIRED');
  });

  it('refuses under a draft policy when drafts are not allowed', async () => {
    Object.assign(env, { SELLER_ASSESSMENT_ALLOW_DRAFT_POLICY: false });
    const r = await audit('releaser', 'POST', `/seller-assessments/${assessmentId}/release`, { scopeItemIds: [await scopeId('IN', 'B2B')], reason: 'Release.', nextReviewAt: null, expectedVersion: await version() });
    Object.assign(env, { SELLER_ASSESSMENT_ALLOW_DRAFT_POLICY: true });
    expect(code(r)).toBe('SELLER_ASSESSMENT_POLICY_NOT_ADOPTED');
  });

  it('refuses releasing a blocked scope row', async () => {
    const r = await audit('releaser', 'POST', `/seller-assessments/${assessmentId}/release`, { scopeItemIds: [await scopeId('DE', 'B2C')], reason: 'Release.', nextReviewAt: null, expectedVersion: await version() });
    expect(details(r)).toContain('SCOPE_NOT_APPROVED_AT_GATE_3');
  });

  it('two concurrent releases: exactly one succeeds', async () => {
    const body = { scopeItemIds: [await scopeId('IN', 'B2B')], reason: 'Independent release (synthetic test).', nextReviewAt: null, expectedVersion: await version() };
    const results = await Promise.allSettled([audit('releaser', 'POST', `/seller-assessments/${assessmentId}/release`, body), audit('releaser', 'POST', `/seller-assessments/${assessmentId}/release`, body)]);
    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.statusCode : 0)).sort();
    expect(statuses).toEqual([201, 409]);
    const approval = await prisma.sellerTradingApproval.findFirstOrThrow({ where: { assessmentId }, include: { scopes: true } });
    approvalId = approval.id;
    expect(approval.scopes).toHaveLength(1);
    expect(approval.validUntil.toISOString().slice(0, 10) <= '2027-06-30').toBe(true);
    expect(approval.auditDocumentId).not.toBeNull();
    expect((await prisma.sellerAssessmentChecklistItem.findFirstOrThrow({ where: { assessmentId, code: 'C23' } })).outcome).toBe('PASS');
  });
});

describe('purchase gate after release', () => {
  it('isolates country and channel', async () => {
    const at = (country: string, channel: 'B2B' | 'B2C') => evaluateScope(prisma, [{ sellerAccountId: desk.sellerAId, offerId }], country, channel).then((m) => m.get(offerId) ?? null);
    expect(await at('IN', 'B2B')).toBeNull();
    expect(await at('IN', 'B2C')).toBe('NOT_IN_SCOPE');
    expect(await at('DE', 'B2B')).toBe('NOT_IN_SCOPE');
    // Another offer of the same seller is not covered.
    expect((await evaluateScope(prisma, [{ sellerAccountId: desk.sellerAId, offerId: newId() }], 'IN', 'B2B')).size).toBe(1);
  });

  it('a withdrawn certificate blocks at once', async () => {
    const approval = await prisma.sellerTradingApproval.findUniqueOrThrow({ where: { id: approvalId } });
    await prisma.sellerExternalCertification.update({ where: { id: approval.externalCertificationId }, data: { status: 'WITHDRAWN' } });
    expect((await evaluateScope(prisma, [{ sellerAccountId: desk.sellerAId, offerId }], 'IN', 'B2B')).get(offerId)).toBe('CERTIFICATE_NOT_CURRENT');
    await prisma.sellerExternalCertification.update({ where: { id: approval.externalCertificationId }, data: { status: 'AUTHENTICATED' } });
  });

  it('an expired approval is refused even though no job has marked it', async () => {
    const approval = await prisma.sellerTradingApproval.findUniqueOrThrow({ where: { id: approvalId } });
    await prisma.sellerTradingApproval.update({ where: { id: approvalId }, data: { validUntil: new Date(Date.now() - 1000) } });
    expect((await prisma.sellerTradingApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('ACTIVE');
    expect((await evaluateScope(prisma, [{ sellerAccountId: desk.sellerAId, offerId }], 'IN', 'B2B')).get(offerId)).toBe('APPROVAL_EXPIRED');
    await prisma.sellerTradingApproval.update({ where: { id: approvalId }, data: { validUntil: approval.validUntil } });
  });

  it('the surveillance sweep is idempotent and sends the reminder once', async () => {
    const first = await sweepSurveillance();
    const second = await sweepSurveillance();
    expect(first.created).toBeGreaterThan(0);
    expect(second.created).toBe(0);
    const later = new Date(Date.now() + 200 * 86_400_000);
    await sweepSurveillance(new Date(Math.min(later.getTime(), (await prisma.sellerTradingApproval.findUniqueOrThrow({ where: { id: approvalId } })).validUntil.getTime() - 10 * 86_400_000)));
    expect(await prisma.sellerSurveillanceTask.count({ where: { approvalId, kind: 'EXPIRY_REMINDER' } })).toBeGreaterThan(0);
    expect(await prisma.sellerSurveillanceTask.count({ where: { approvalId, kind: 'SANCTIONS_SCREENING', status: 'DONE' } })).toBe(0);
  });
});

describe('suspension, dispositions and appeals', () => {
  let noticeId = '';
  const groupId = async () => (await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: desk.orderId, sellerAccountId: desk.sellerAId } })).id;

  it('suspension blocks purchase and holds placed orders for a disposition; nothing ships by itself', async () => {
    const res = await audit('head', 'POST', `/seller-assessments/approvals/${approvalId}/suspend`, { kind: 'SUSPENSION', hardStop: 'INSURER_CANCELLATION', scopeIds: null, reason: 'Insurer cancelled the product liability policy.', shareableEvidence: 'Insurer cancellation notice dated today.', settlementTreatment: 'Settlement for held orders paused pending disposition.', correctiveActions: 'Provide replacement cover.', reviewRoute: 'Appeal within 7 days via the Seller Hub.', riskContainmentNote: null });
    expect(res.statusCode, res.body).toBe(201);
    noticeId = res.json<{ id: string }>().id;
    expect((await prisma.sellerTradingApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('SUSPENDED');
    await expect(assertOffersEligible(prisma, [offerId], 'IN', 'B2B', 'test')).rejects.toMatchObject({ code: 'SELLER_SCOPE_NOT_APPROVED' });
    await expect(assertOrderEligible(prisma, desk.orderId, 'payment-start')).rejects.toMatchObject({ code: 'SELLER_SCOPE_NOT_APPROVED' });
    const g = await groupId();
    await expect(assertDispatchAllowed(prisma, g)).rejects.toMatchObject({ code: 'SELLER_ORDER_DISPOSITION_REQUIRED' });
    await recheckOrderAfterCapture(prisma, desk.orderId);
    const held = await prisma.sellerOrderDisposition.findMany({ where: { sellerOrderGroupId: g } });
    expect(held.length).toBeGreaterThanOrEqual(1);
    for (const d of held) expect((await audit('regulatory', 'POST', `/seller-assessments/dispositions/${d.id}`, { status: 'RELEASE_APPROVED', note: 'Goods inspected and safe (synthetic).' })).statusCode).toBe(204);
    await expect(assertDispatchAllowed(prisma, g)).resolves.toBeUndefined();
  });

  it('an appeal is reviewed by somebody uninvolved and never restores selling', async () => {
    const appeal = await sellerCall(desk.sellerA, 'POST', `/assessment/notices/${noticeId}/appeal`, { grounds: 'Replacement cover was bound the same day.', evidenceRef: null });
    expect(appeal.statusCode, appeal.body).toBe(201);
    const appealId = appeal.json<{ id: string }>().id;
    await prisma.auditStaffMember.update({ where: { userId: people['assessor']!.userId }, data: { assessmentCapabilitiesJson: ['ASSESS', 'APPEAL_REVIEW'] } });
    const involved = await audit('assessor', 'POST', `/seller-assessments/appeals/${appealId}/decision`, { status: 'UPHELD', outcomeReason: 'Involved reviewer tries.' });
    expect(code(involved)).toBe('SELLER_ASSESSMENT_INDEPENDENCE_REQUIRED');
    expect((await audit('appeal', 'POST', `/seller-assessments/appeals/${appealId}/decision`, { status: 'UPHELD', outcomeReason: 'Cover evidenced; reinstatement needs revalidation.' })).statusCode).toBe(204);
    expect((await prisma.sellerTradingApproval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe('SUSPENDED');
    expect((await evaluateScope(prisma, [{ sellerAccountId: desk.sellerAId, offerId }], 'IN', 'B2B')).size).toBe(1);
  });
});

describe('bank change, evidence and retention', () => {
  it('needs the known contact and two different Finance approvers', async () => {
    const req = await sellerCall(desk.sellerA, 'POST', '/assessment/bank-changes', { beneficiaryName: `${TAG} Industries Pvt Ltd`, accountLast4: '9876', bankCode: 'ICIC0000001', evidenceRef: null });
    expect(req.statusCode, req.body).toBe(201);
    const id = req.json<{ id: string }>().id;
    const step = async (who: string, body: Record<string, unknown>) => audit(who, 'POST', `/seller-assessments/bank-changes/${id}`, { reason: 'synthetic step', expectedVersion: (await prisma.sellerBankChangeRequest.findUniqueOrThrow({ where: { id } })).version, ...body });
    expect(details(await step('finance1', { step: 'APPROVE' }))).toEqual([]);
    expect((await prisma.sellerBankChangeRequest.findUniqueOrThrow({ where: { id } })).status).toBe('SUBMITTED');
    expect((await step('finance1', { step: 'CONFIRM_CONTACT', knownContactName: 'Finance head', knownContactSource: 'Contact on file since onboarding' })).statusCode).toBe(204);
    expect((await step('finance1', { step: 'APPROVE' })).statusCode).toBe(204);
    expect(code(await step('finance1', { step: 'APPROVE' }))).toBe('SELLER_ASSESSMENT_INDEPENDENCE_REQUIRED');
    expect((await step('finance2', { step: 'APPROVE' })).statusCode).toBe(204);
    expect((await prisma.sellerBankChangeRequest.findUniqueOrThrow({ where: { id } })).status).toBe('APPROVED');
  });

  it('Admin cannot download banking evidence; legal hold and retention categories are recorded', async () => {
    const bank = await prisma.sellerAssessmentEvidence.findFirstOrThrow({ where: { assessmentId, evidenceKey: 'bank' } });
    await prisma.sellerAssessmentEvidence.update({ where: { id: bank.id }, data: { category: 'BANKING', retentionCategory: 'BANKING' } });
    expect((await asStaff(app, admin, 'GET', `/seller-assessments/${assessmentId}/evidence/${bank.id}`)).statusCode).toBe(404);
    expect((await audit('assessor', 'GET', `/seller-assessments/${assessmentId}/evidence/${bank.id}`)).statusCode).toBe(200);
    expect((await audit('head', 'POST', `/seller-assessments/evidence/${bank.id}/legal-hold`, { hold: true, reason: 'Synthetic dispute hold.' })).statusCode).toBe(204);
    const report = (await audit('assessor', 'GET', '/seller-assessments/retention')).json<{ categories: { category: string; years: number | null; onLegalHold: number }[] }>().categories;
    expect(report.find((c) => c.category === 'GENERAL_ASSESSMENT')?.years).toBe(7);
    expect(report.find((c) => c.category === 'IDENTITY')?.years).toBeNull();
    expect(report.find((c) => c.category === 'BANKING')?.onLegalHold).toBeGreaterThanOrEqual(1);
  });
});

describe('a blocked journey', () => {
  it('a critical finding blocks release despite a perfect score', async () => {
    const row = await startApplication({ sellerAccountId: desk.sellerBId, profileId: newId() }, 'INITIAL');
    await prisma.sellerAssessment.update({ where: { id: row.id }, data: { status: 'IN_REVIEW' } });
    for (const d of DIMENSIONS) await audit('assessor', 'PUT', `/seller-assessments/${row.id}/scores/${d.code}`, { rating: 5, evidenceRef: 'x', reasoning: 'Strong (synthetic).' });
    const f = await audit('assessor', 'POST', `/seller-assessments/${row.id}/findings`, { classification: 'CRITICAL', requirement: 'Counterfeit material found', evidence: 'Synthetic', ownerName: null });
    expect(f.statusCode).toBe(201);
    const { gaps, score } = await releaseGaps(prisma, row.id, null);
    expect(score.display).toBe('100.00');
    expect(gaps).toEqual(expect.arrayContaining(['HARD_STOP:CRITICAL_FINDING', expect.stringMatching(/^FINDING_OPEN:/), 'CERT_MISSING']));
  });
});
