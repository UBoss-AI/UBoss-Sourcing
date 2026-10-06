/**
 * The whole inspection over HTTP (checklist Master rows 23, 41, 45-55, 70, 94, 95).
 *
 * An operator registers an agency and its three members, a mandatory rule
 * applies, the operator books the job, the coordinator accepts and assigns,
 * the seller declares readiness, the inspector declares no conflict, starts,
 * samples and logs a major defect, submits, and QA signs. The report comes out
 * FAIL, the seller cannot dispatch, and the buyer and seller both see the NCR.
 * Every step is a real route with a real session, so an unguarded or
 * mis-wired route fails here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { inspectionSummaryFor } from '../../src/modules/catalog/supplier-profile.service.js';
import { ensureRequirement } from '../../src/modules/inspection/gate.service.js';
import {
  asCustomer as customerCall,
  asStaff as staffCall,
  buildOrderDesk,
  cleanUpOrderDesk,
  staff,
  type OrderDesk,
  type Session,
  type StaffSession,
  type CallOptions,
} from '../support/order-desk-fixture.js';
import { activateAndSignIn, auditEmailFor, cleanUpAuditPeople } from '../support/audit-session.js';

const TAG = 'ihttp7';
const AGENCY_IPS = { agcoord: '10.97.0.21', aginsp: '10.97.0.22', agqa: '10.97.0.23' } as const;
const RULE_NAME = 'ihttp7 every order';

let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let admin: StaffSession;
let coordinator: Session;
let inspector: Session;
let qa: Session;
let groupId = '';
let agencyId = '';
let jobId = '';

const asCustomer: typeof customerCall = (app, session, method, path, options: CallOptions = {}) =>
  customerCall(app, session, method, path, { idempotencyKey: newId(), ...options });
const asStaff: typeof staffCall = (app, session, method, path, options: CallOptions = {}) =>
  staffCall(app, session, method, path, { idempotencyKey: newId(), ...options });

/** A 1x1 PNG, the smallest real image the evidence store will accept. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function uploadEvidence(session: Session, url: string, fields: Record<string, string>) {
  const boundary = 'ihttp7boundary';
  const crlf = String.fromCharCode(13, 10);
  const head = Object.entries(fields)
    .map(([key, value]) => `--${boundary}${crlf}Content-Disposition: form-data; name="${key}"${crlf}${crlf}${value}${crlf}`)
    .join('');
  const body = Buffer.concat([
    Buffer.from(`${head}--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="seal.png"${crlf}Content-Type: image/png${crlf}${crlf}`),
    PNG,
    Buffer.from(`${crlf}--${boundary}--${crlf}`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-for': session.ip, 'idempotency-key': newId(), 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });
}

async function cleanInspection(): Promise<void> {
  await prisma.inspectionRequirement.deleteMany({ where: { orderId: desk.orderId } });
  const agencies = await prisma.inspectionAgency.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = agencies.map((row) => row.id);
  await prisma.inspectionAgencyMember.deleteMany({ where: { agencyId: { in: ids } } });
  await prisma.inspectionAgency.deleteMany({ where: { id: { in: ids } } });
  await prisma.inspectionRule.deleteMany({ where: { name: RULE_NAME } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 97);
  groupId = (await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: desk.orderId }, select: { id: true } })).id;
  await prisma.sellerOrderGroup.update({ where: { id: groupId }, data: { status: 'PROCESSING', deliveredAt: null } });
  await cleanInspection();
  await prisma.inspectionRule.create({
    data: { id: newId(), name: RULE_NAME, isActive: true, priority: 1, level: 'MANDATORY', effectiveFrom: new Date(Date.now() - 86_400_000) },
  });
  // The order was placed before the rule existed: decide its requirement now.
  await prisma.$transaction(async (tx) => { await ensureRequirement(tx, groupId); });
  admin = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.97.0.20');
  // Agency people sign in to the Audit Console, not the storefront: they are
  // invited by the operator below and activate their own console accounts.
  await cleanUpAuditPeople(TAG);
}, 240_000);

afterAll(async () => {
  await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: true } });
  await cleanInspection();
  await cleanUpAuditPeople(TAG);
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('an inspection from booking to a signed FAIL', () => {
  it('refuses the agency and admin routes without the right session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/audit/agency/jobs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/inspection/queue' })).statusCode).toBe(401);
    expect((await asCustomer(app, desk.rivalBuyer, 'GET', '/audit/agency/me')).statusCode).toBe(401);
  });

  it('runs end to end through every role', async () => {
    const created = await asStaff(app, admin, 'POST', '/inspection/agencies', {
      payload: { name: `${TAG} Independent QA`, legalName: `${TAG} Independent QA Ltd`, country: 'IN', contactEmail: 'qa@ihttp7.test.local', dailyCapacity: 5 },
    });
    expect(created.statusCode, created.body).toBe(201);
    agencyId = created.json<{ id: string }>().id;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: desk.orderId }, select: { productId: true } });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: item.productId }, select: { categoryId: true } });
    const competence = product.categoryId === null ? [] : [product.categoryId];
    for (const [who, role] of [['agcoord', 'COORDINATOR'], ['aginsp', 'INSPECTOR'], ['agqa', 'QA_REVIEWER']] as const) {
      const added = await asStaff(app, admin, 'POST', `/inspection/agencies/${agencyId}/members`, {
        payload: { email: auditEmailFor(TAG, who), fullName: who, role, idDocumentType: 'PASSPORT', idDocumentNumber: `${who}-1`, competenceCategoryIds: competence },
      });
      expect(added.statusCode, added.body).toBe(201);
      const verified = await app.inject({ method: 'PATCH', url: `/api/v1/admin/inspection/members/${added.json<{ id: string }>().id}`, headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken, 'x-forwarded-for': admin.ip }, payload: { verifyIdentity: true } });
      expect(verified.statusCode, verified.body).toBe(200);
      const session = await activateAndSignIn(app, added.json<{ userId: string }>().userId, AGENCY_IPS[who]);
      if (who === 'agcoord') coordinator = session;
      else if (who === 'aginsp') inspector = session;
      else qa = session;
    }

    const booking = {
        sellerOrderGroupId: groupId, agencyId, scheduledFor: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        inspectionPointType: 'SELLER_PREMISES', inspectionPoint: { label: 'Factory', addressLine: '1 Mill Road', city: 'Pune', country: 'IN' }, payer: 'BUYER',
    };
    const missingKey = await staffCall(app, admin, 'POST', '/inspection/jobs', { payload: booking });
    expect(missingKey.statusCode, missingKey.body).toBe(400);
    const bookingKey = newId();
    const booked = await asStaff(app, admin, 'POST', '/inspection/jobs', {
      payload: booking, idempotencyKey: bookingKey,
    });
    expect(booked.statusCode, booked.body).toBe(201);
    jobId = booked.json<{ jobId: string }>().jobId;
    const replay = await asStaff(app, admin, 'POST', '/inspection/jobs', { payload: booking, idempotencyKey: bookingKey });
    expect(replay.statusCode, replay.body).toBe(201);
    expect(replay.json()).toEqual(booked.json());
    expect(await prisma.inspectionJob.count({ where: { requirement: { orderId: desk.orderId } } })).toBe(1);

    const queue = await asStaff(app, admin, 'GET', '/inspection/queue');
    expect(queue.statusCode, queue.body).toBe(200);

    const accepted = await asCustomer(app, coordinator, 'POST', `/audit/agency/jobs/${jobId}/accept`, {
      payload: { conflictStatement: 'No financial or family link to the seller or buyer.', confirmNoConflict: true },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const detail = await asCustomer(app, coordinator, 'GET', `/audit/agency/jobs/${jobId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json<{ job: { job: { report: unknown } } }>().job.job.report).toBeNull();
    const eligible = detail.json<{ job: { eligibleInspectors: { id: string; fullName: string }[] } }>().job.eligibleInspectors;
    const inspectorMember = eligible.find((member) => member.fullName === 'aginsp');
    expect(inspectorMember, detail.body).toBeDefined();
    const assigned = await asCustomer(app, coordinator, 'POST', `/audit/agency/jobs/${jobId}/assign`, { payload: { inspectorMemberId: inspectorMember?.id } });
    expect(assigned.statusCode, assigned.body).toBe(200);

    const ready = await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, {
      payload: { lotReference: 'LOT-1', readyDate: null, locationLabel: 'Factory bay 2', contactName: 'Ravi', contactPhone: '+911234567890', packedStatus: 'PACKED', declaration: true },
    });
    // UAT-UI-008: readiness without the packing list is refused, and says why.
    expect(ready.statusCode, ready.body).toBe(409);
    expect(ready.body).toContain('PACKING_LIST_MISSING');
    // With the packing-list rule off (a policy setting), a complete declaration is accepted.
    await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: false } });
    const readyAgain = await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, {
      payload: { lotReference: 'LOT-1', readyDate: new Date().toISOString().slice(0, 10), locationLabel: 'Factory bay 2', contactName: 'Ravi', contactPhone: '+911234567890', packedStatus: 'PACKED', declaration: true },
    });
    expect(readyAgain.statusCode, readyAgain.body).toBe(200);

    const answer = async (): Promise<void> => {
      const view = await asCustomer(app, inspector, 'GET', `/audit/agency/jobs/${jobId}`);
      const items = view.json<{ job: { checklist: { code?: string; itemCode?: string }[] } }>().job.checklist;
      for (const item of items) {
        const code = item.code ?? item.itemCode ?? '';
        const check = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/checks`, { payload: { itemCode: code, outcome: 'CONFORM' } });
        expect(check.statusCode, `check ${code}: ${check.body}`).toBe(200);
      }
    };
    for (const [action, payload] of [
      ['conflict', { hasConflict: false }],
      ['start', {}],
      ['sampling', { lotReference: 'LOT-1', sampledQuantity: 3, acceptedQuantity: 2, rejectedQuantity: 1 }],
      ['defects', { severity: 'MAJOR', requirementRef: 'Spec 4.2 seal', description: 'Outer seal torn on one carton', defectQuantity: 1 }],
    ] as const) {
      const step = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/${action}`, { payload });
      expect(step.statusCode, `${action}: ${step.body}`).toBe(200);
    }

    await answer();
    const checkPath = `/audit/agency/jobs/${jobId}/checks`;
    expect((await asCustomer(app, coordinator, 'POST', checkPath, { payload: { itemCode: 'PACK.CARTON_QTY', outcome: 'CONFORM' } })).statusCode).toBe(403);
    expect((await asCustomer(app, inspector, 'POST', checkPath, { payload: { itemCode: 'PACK.CARTON_QTY', outcome: 'NONCONFORM' } })).statusCode).toBe(400);
    const observed = await asCustomer(app, inspector, 'POST', checkPath, { payload: { itemCode: 'PACK.CARTON_QTY', outcome: 'CONFORM', measuredValue: '24', note: 'Count verified' } });
    expect(observed.statusCode, observed.body).toBe(200);
    const packaging = await uploadEvidence(inspector, `/audit/agency/jobs/${jobId}/evidence`, { purpose: 'PACKAGING', checkItemCode: 'PACK.CARTON_QTY' });
    expect(packaging.statusCode, packaging.body).toBe(201);
    expect((await uploadEvidence(inspector, `/audit/agency/jobs/${jobId}/evidence`, { purpose: 'PACKAGING', checkItemCode: 'NOT.IN.PLAN' })).statusCode).toBe(400);
    expect((await uploadEvidence(desk.rivalBuyer, `/audit/agency/jobs/${jobId}/evidence`, { purpose: 'PACKAGING', checkItemCode: 'PACK.CARTON_QTY' })).statusCode).toBe(401);
    const findings = await asCustomer(app, inspector, 'GET', `/audit/agency/jobs/${jobId}`);
    const packagingView = findings.json<{ job: { job: { checks: { itemCode: string; measuredValue: string; note: string }[]; evidence: { checkItemCode: string; purpose: string }[] } } }>().job.job;
    expect(packagingView.checks).toContainEqual(expect.objectContaining({ itemCode: 'PACK.CARTON_QTY', measuredValue: '24', note: 'Count verified' }));
    expect(packagingView.evidence).toContainEqual(expect.objectContaining({ checkItemCode: 'PACK.CARTON_QTY', purpose: 'PACKAGING' }));
    const defectId = (await prisma.inspectionDefect.findFirstOrThrow({ where: { jobId }, select: { id: true } })).id;
    const evidenceFields: Record<string, string>[] = [{ purpose: 'GENERAL', capturedAt: new Date().toISOString() }, { purpose: 'DEFECT', defectId, capturedAt: new Date().toISOString() }];
    for (const fields of evidenceFields) {
      const stored = await uploadEvidence(inspector, `/audit/agency/jobs/${jobId}/evidence`, fields);
      expect(stored.statusCode, stored.body).toBe(201);
    }
    const submitted = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/report/submit`, { payload: { summary: 'One carton with a torn seal.' } });
    expect(submitted.statusCode, submitted.body).toBe(200);

    const signed = await asCustomer(app, qa, 'POST', `/audit/agency/jobs/${jobId}/report/sign`);
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json<{ result: string }>().result).toBe('FAIL');
    // JOURNEY-005: the supplier's public inspection summary counts the signed report.
    expect(await inspectionSummaryFor(desk.sellerAId)).toMatchObject({ months: 12, reports: 1, passed: 0, failed: 1 });
    expect((await asCustomer(app, inspector, 'POST', checkPath, { payload: { itemCode: 'PACK.CARTON_QTY', outcome: 'CONFORM' } })).statusCode).toBe(409);

    const dispatch = await asCustomer(app, desk.sellerA, 'PATCH', `/seller/orders/${groupId}/status`, { payload: { status: 'READY_FOR_DISPATCH' } });
    expect(dispatch.statusCode, dispatch.body).toBe(409);

    const buyerView = await asCustomer(app, desk.buyer, 'GET', `/inspection/buyer/orders/${desk.orderId}`);
    expect(buyerView.statusCode, buyerView.body).toBe(200);
    expect(buyerView.json<{ inspections: unknown[] }>().inspections.length).toBe(1);
    const failedGate = buyerView.json<{ inspections: { requirement: { gate: { allowed: boolean; sentence: string } } }[] }>().inspections[0]?.requirement.gate;
    expect(failedGate?.allowed).toBe(false);
    expect(typeof failedGate?.sentence).toBe('string');
    const savedVisibility = await prisma.inspectionPolicy.findFirstOrThrow({ select: { buyerReportAccess: true } });
    try {
      await prisma.inspectionPolicy.updateMany({ data: { buyerReportAccess: 'NONE' } });
      const hidden = await asCustomer(app, desk.buyer, 'GET', `/inspection/buyer/orders/${desk.orderId}`);
      expect(hidden.statusCode, hidden.body).toBe(200);
      expect(hidden.json<{ inspections: { jobs: { report: unknown }[] }[] }>().inspections[0]?.jobs.every((job) => job.report === null)).toBe(true);
    } finally {
      await prisma.inspectionPolicy.updateMany({ data: savedVisibility });
    }
    const sellerView = await asCustomer(app, desk.sellerA, 'GET', `/seller/inspection/orders/${groupId}`);
    expect(sellerView.statusCode, sellerView.body).toBe(200);
    expect(sellerView.body).toContain('Outer seal torn on one carton');

    const rival = await asCustomer(app, desk.rivalBuyer, 'GET', `/inspection/buyer/orders/${desk.orderId}`);
    // Somebody else's order: not found, never another buyer's inspection.
    expect(rival.statusCode, rival.body).toBe(404);

    // The dashboard uses the same agency and assignment boundaries as job reads.
    const invoiced = await asCustomer(app, coordinator, 'POST', `/audit/agency/jobs/${jobId}/invoice`, {
      payload: { invoiceNumber: 'ihttp7-INV', amountMinor: '12345', currency: 'INR' },
    });
    expect(invoiced.statusCode, invoiced.body).toBe(200);
    const dashboard = await asCustomer(app, coordinator, 'GET', '/audit/agency/dashboard');
    expect(dashboard.statusCode, dashboard.body).toBe(200);
    const data = dashboard.json<{ counts: { completed: number }; jobs: { id: string; acceptDueAt: string; reportDueAt: string }[]; inspectors: { fullName: string }[]; invoices: { amountMinor: string }[] }>();
    expect(data.counts.completed).toBe(1);
    expect(data.jobs.map((job) => job.id)).toEqual([jobId]);
    expect(data.jobs[0]?.acceptDueAt).toBeTruthy();
    expect(data.jobs[0]?.reportDueAt).toBeTruthy();
    expect(data.inspectors.map((member) => member.fullName)).toContain('aginsp');
    expect(data.invoices[0]?.amountMinor).toBe('12345');
    const reports = dashboard.json<{ reports: { jobId: string; status: string; result: string | null }[] }>().reports;
    expect(reports).toContainEqual(expect.objectContaining({ jobId, result: 'FAIL' }));
    const scoped = await asCustomer(app, inspector, 'GET', '/audit/agency/dashboard');
    expect(scoped.statusCode, scoped.body).toBe(200);
    expect(scoped.json<{ inspectors: unknown[]; invoices: unknown[] }>().inspectors).toEqual([]);
    expect(scoped.json<{ invoices: unknown[] }>().invoices).toEqual([]);
    expect((await asCustomer(app, desk.rivalBuyer, 'GET', '/audit/agency/dashboard')).statusCode).toBe(401);

    // Corrective evidence and repeat inspection stay linked to the immutable failed report.
    const originalJobId = jobId;
    const originalReport = await prisma.inspectionReport.findFirstOrThrow({ where: { jobId: originalJobId, status: 'SIGNED' }, select: { id: true, contentHash: true, result: true } });
    const repeatBooking = { ...booking, reinspectionOfJobId: originalJobId, scheduledFor: new Date(Date.now() + 4 * 86_400_000).toISOString() };
    expect((await asStaff(app, admin, 'POST', '/inspection/jobs', { payload: repeatBooking })).statusCode).toBe(409);
    const capa = { sellerResponse: 'Packaging seal was damaged', correctiveAction: 'Repacked the affected carton and verified all seals' };
    expect((await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/defects/${defectId}/capa`, { payload: capa })).statusCode).toBe(400);
    expect((await uploadEvidence(desk.sellerB, `/seller/inspection/jobs/${originalJobId}/evidence`, { purpose: 'CAPA', defectId })).statusCode).toBe(404);
    const correction = await uploadEvidence(desk.sellerA, `/seller/inspection/jobs/${originalJobId}/evidence`, { purpose: 'CAPA', defectId });
    expect(correction.statusCode, correction.body).toBe(201);
    const corrected = await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/defects/${defectId}/capa`, { payload: capa });
    expect(corrected.statusCode, corrected.body).toBe(200);
    expect((await asStaff(app, admin, 'POST', '/inspection/jobs', { payload: { ...repeatBooking, reinspectionOfJobId: newId() } })).statusCode).toBe(404);
    const repeat = await asStaff(app, admin, 'POST', '/inspection/jobs', { payload: repeatBooking });
    expect(repeat.statusCode, repeat.body).toBe(201);
    jobId = repeat.json<{ jobId: string }>().jobId;
    expect(await prisma.inspectionJob.findUnique({ where: { id: jobId }, select: { kind: true, reinspectionOfJobId: true } })).toEqual({ kind: 'REINSPECTION', reinspectionOfJobId: originalJobId });
    for (const [session, path, payload] of [
      [coordinator, 'accept', { conflictStatement: 'No financial or family link to the seller or buyer.', confirmNoConflict: true }],
      [coordinator, 'assign', { inspectorMemberId: inspectorMember?.id }],
    ] as const) {
      const response = await asCustomer(app, session, 'POST', `/audit/agency/jobs/${jobId}/${path}`, { payload });
      expect(response.statusCode, response.body).toBe(200);
    }
    const repeatReady = await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, { payload: { lotReference: 'LOT-1', readyDate: new Date().toISOString().slice(0, 10), locationLabel: 'Factory bay 2', contactName: 'Ravi', contactPhone: '+911234567890', packedStatus: 'PACKED', declaration: true } });
    expect(repeatReady.statusCode, repeatReady.body).toBe(200);
    for (const [action, payload] of [
      ['conflict', { hasConflict: false }], ['start', {}],
      ['sampling', { lotReference: 'LOT-1', sampledQuantity: 3, acceptedQuantity: 3, rejectedQuantity: 0 }],
    ] as const) {
      const response = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/${action}`, { payload });
      expect(response.statusCode, response.body).toBe(200);
    }
    await answer();
    expect((await uploadEvidence(inspector, `/audit/agency/jobs/${jobId}/evidence`, { purpose: 'GENERAL' })).statusCode).toBe(201);
    expect((await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/report/submit`, { payload: { summary: 'Correction verified; all packaging checks conform.' } })).statusCode).toBe(200);
    const repeatSign = await asCustomer(app, qa, 'POST', `/audit/agency/jobs/${jobId}/report/sign`);
    expect(repeatSign.statusCode, repeatSign.body).toBe(200);
    expect(repeatSign.json<{ result: string }>().result).toBe('PASS');
    expect(await prisma.inspectionDefect.findUnique({ where: { id: defectId }, select: { status: true } })).toEqual({ status: 'VERIFIED_CLOSED' });
    expect(await prisma.inspectionReport.findUnique({ where: { id: originalReport.id }, select: { id: true, contentHash: true, result: true } })).toEqual(originalReport);
    const linked = await asCustomer(app, desk.sellerA, 'GET', `/seller/inspection/orders/${groupId}`);
    expect(linked.json<{ inspection: { requirement: { gate: { allowed: boolean } } } }>().inspection.requirement.gate.allowed).toBe(true);
    expect(linked.json<{ inspection: { jobs: { id: string; reinspectionOfJobId: string | null; report: { result: string } | null }[] } }>().inspection.jobs).toContainEqual(expect.objectContaining({ id: jobId, reinspectionOfJobId: originalJobId, report: expect.objectContaining({ result: 'PASS' }) }));
  }, 120_000);
});

describe('the buyer books an inspection themselves', () => {
  let buyerMayRequestBefore = true;

  beforeAll(async () => {
    // Start this order part again with no rule asking for an inspection, so
    // the buyer's own booking is what makes it inspectable.
    await prisma.inspectionRequirement.deleteMany({ where: { orderId: desk.orderId } });
    await prisma.inspectionRule.deleteMany({ where: { name: RULE_NAME } });
    await prisma.sellerOrderGroup.update({ where: { id: groupId }, data: { status: 'PROCESSING', deliveredAt: null } });
    const policy = await prisma.inspectionPolicy.findFirst({ select: { buyerMayRequest: true } });
    buyerMayRequestBefore = policy?.buyerMayRequest ?? true;
    await prisma.inspectionPolicy.updateMany({ data: { buyerMayRequest: true } });
  });

  afterAll(async () => {
    await prisma.inspectionPolicy.updateMany({ data: { buyerMayRequest: buyerMayRequestBefore } });
  });

  it('lists eligible agencies, books with the buyer paying, and refuses a second booking', async () => {
    expect(agencyId).not.toBe('');
    const scheduledFor = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const listPath = `/inspection/buyer/orders/${desk.orderId}/agencies?sellerOrderGroupId=${groupId}&country=IN&scheduledFor=${encodeURIComponent(scheduledFor)}`;

    expect((await app.inject({ method: 'GET', url: `/api/v1${listPath}` })).statusCode).toBe(401);
    expect((await asCustomer(app, desk.rivalBuyer, 'GET', listPath)).statusCode).toBe(404);
    const listed = await asCustomer(app, desk.buyer, 'GET', listPath);
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json<{ agencies: { id: string; eligible: boolean }[] }>().agencies).toContainEqual(expect.objectContaining({ id: agencyId, eligible: true }));

    const booking = {
      sellerOrderGroupId: groupId, agencyId, scheduledFor, inspectionPointType: 'WAREHOUSE',
      inspectionPoint: { label: 'Seller warehouse', addressLine: '2 Dock Road', city: 'Pune', country: 'IN' },
      payer: 'SELLER',
    };
    const bookPath = `/inspection/buyer/orders/${desk.orderId}/book`;
    expect((await asCustomer(app, desk.rivalBuyer, 'POST', bookPath, { payload: { ...booking, payer: 'BUYER' } })).statusCode).toBe(404);
    expect((await asCustomer(app, desk.buyer, 'POST', bookPath, { payload: { ...booking, payer: 'PLATFORM' } })).statusCode).toBe(400);
    // Nothing requires an inspection here, so the buyer asked for it and pays for it.
    const sellerPays = await asCustomer(app, desk.buyer, 'POST', bookPath, { payload: booking });
    expect(sellerPays.statusCode, sellerPays.body).toBe(400);

    const booked = await asCustomer(app, desk.buyer, 'POST', bookPath, { payload: { ...booking, payer: 'BUYER', reinspectionOfJobId: jobId } });
    expect(booked.statusCode, booked.body).toBe(201);
    const buyerJobId = booked.json<{ jobId: string }>().jobId;
    expect(await prisma.inspectionJob.findUnique({
      where: { id: buyerJobId },
      select: { kind: true, reinspectionOfJobId: true, bookedByParty: true, payer: true, agencyId: true, inspectionPointType: true },
    })).toEqual({ kind: 'INITIAL', reinspectionOfJobId: null, bookedByParty: 'BUYER', payer: 'BUYER', agencyId, inspectionPointType: 'WAREHOUSE' });
    expect(await prisma.inspectionRequirement.findUnique({ where: { sellerOrderGroupId: groupId }, select: { level: true, buyerRequested: true } }))
      .toEqual({ level: 'BUYER_REQUESTED', buyerRequested: true });

    const again = await asCustomer(app, desk.buyer, 'POST', bookPath, { payload: { ...booking, payer: 'BUYER' } });
    expect(again.statusCode, again.body).toBe(409);

    const view = await asCustomer(app, desk.buyer, 'GET', `/inspection/buyer/orders/${desk.orderId}`);
    expect(view.json<{ inspections: { jobs: { id: string; payer: string }[] }[] }>().inspections[0]?.jobs).toContainEqual(expect.objectContaining({ id: buyerJobId, payer: 'BUYER' }));
  }, 60_000);
});
