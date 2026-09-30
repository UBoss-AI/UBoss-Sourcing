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
import { ensureRequirement } from '../../src/modules/inspection/gate.service.js';
import {
  asCustomer,
  asStaff,
  buildOrderDesk,
  cleanUpOrderDesk,
  customer,
  emailFor,
  staff,
  type OrderDesk,
  type Session,
  type StaffSession,
} from '../support/order-desk-fixture.js';

const TAG = 'ihttp7';
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
    headers: { cookie: session.cookie, 'x-csrf-token': session.csrf, 'x-forwarded-for': session.ip, 'content-type': `multipart/form-data; boundary=${boundary}` },
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
  coordinator = await customer(app, TAG, 'agcoord', '10.97.0.21');
  inspector = await customer(app, TAG, 'aginsp', '10.97.0.22');
  qa = await customer(app, TAG, 'agqa', '10.97.0.23');
}, 240_000);

afterAll(async () => {
  await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: true } });
  await cleanInspection();
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('an inspection from booking to a signed FAIL', () => {
  it('refuses the agency and admin routes without the right session', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/v1/inspection/agency/jobs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/inspection/queue' })).statusCode).toBe(401);
    expect((await asCustomer(app, desk.rivalBuyer, 'GET', '/inspection/agency/me')).statusCode).toBe(403);
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
        payload: { email: emailFor(TAG, who), fullName: who, role, idDocumentType: 'PASSPORT', idDocumentNumber: `${who}-1`, competenceCategoryIds: competence },
      });
      expect(added.statusCode, added.body).toBe(201);
      const verified = await app.inject({ method: 'PATCH', url: `/api/v1/admin/inspection/members/${added.json<{ id: string }>().id}`, headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken, 'x-forwarded-for': admin.ip }, payload: { verifyIdentity: true } });
      expect(verified.statusCode, verified.body).toBe(200);
    }

    const booked = await asStaff(app, admin, 'POST', '/inspection/jobs', {
      payload: {
        sellerOrderGroupId: groupId, agencyId, scheduledFor: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        inspectionPointType: 'SELLER_PREMISES', inspectionPoint: { label: 'Factory', addressLine: '1 Mill Road', city: 'Pune', country: 'IN' }, payer: 'BUYER',
      },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    jobId = booked.json<{ jobId: string }>().jobId;

    const queue = await asStaff(app, admin, 'GET', '/inspection/queue');
    expect(queue.statusCode, queue.body).toBe(200);

    const accepted = await asCustomer(app, coordinator, 'POST', `/inspection/agency/jobs/${jobId}/accept`, {
      payload: { conflictStatement: 'No financial or family link to the seller or buyer.', confirmNoConflict: true },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const detail = await asCustomer(app, coordinator, 'GET', `/inspection/agency/jobs/${jobId}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const eligible = detail.json<{ job: { eligibleInspectors: { id: string; fullName: string }[] } }>().job.eligibleInspectors;
    const inspectorMember = eligible.find((member) => member.fullName === 'aginsp');
    expect(inspectorMember, detail.body).toBeDefined();
    const assigned = await asCustomer(app, coordinator, 'POST', `/inspection/agency/jobs/${jobId}/assign`, { payload: { inspectorMemberId: inspectorMember?.id } });
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
      const view = await asCustomer(app, inspector, 'GET', `/inspection/agency/jobs/${jobId}`);
      const items = view.json<{ job: { checklist: { code?: string; itemCode?: string }[] } }>().job.checklist;
      for (const item of items) {
        const code = item.code ?? item.itemCode ?? '';
        const check = await asCustomer(app, inspector, 'POST', `/inspection/agency/jobs/${jobId}/checks`, { payload: { itemCode: code, outcome: 'CONFORM' } });
        expect(check.statusCode, `check ${code}: ${check.body}`).toBe(200);
      }
    };
    for (const [action, payload] of [
      ['conflict', { hasConflict: false }],
      ['start', {}],
      ['sampling', { lotReference: 'LOT-1', sampledQuantity: 3, acceptedQuantity: 2, rejectedQuantity: 1 }],
      ['defects', { severity: 'MAJOR', requirementRef: 'Spec 4.2 seal', description: 'Outer seal torn on one carton', defectQuantity: 1 }],
    ] as const) {
      const step = await asCustomer(app, inspector, 'POST', `/inspection/agency/jobs/${jobId}/${action}`, { payload });
      expect(step.statusCode, `${action}: ${step.body}`).toBe(200);
    }

    await answer();
    const defectId = (await prisma.inspectionDefect.findFirstOrThrow({ where: { jobId }, select: { id: true } })).id;
    for (const fields of [{ purpose: 'GENERAL', capturedAt: new Date().toISOString() }, { purpose: 'DEFECT', defectId, capturedAt: new Date().toISOString() }]) {
      const stored = await uploadEvidence(inspector, `/inspection/agency/jobs/${jobId}/evidence`, fields);
      expect(stored.statusCode, stored.body).toBe(201);
    }
    const submitted = await asCustomer(app, inspector, 'POST', `/inspection/agency/jobs/${jobId}/report/submit`, { payload: { summary: 'One carton with a torn seal.' } });
    expect(submitted.statusCode, submitted.body).toBe(200);

    const signed = await asCustomer(app, qa, 'POST', `/inspection/agency/jobs/${jobId}/report/sign`);
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json<{ result: string }>().result).toBe('FAIL');

    const dispatch = await asCustomer(app, desk.sellerA, 'PATCH', `/seller/orders/${groupId}/status`, { payload: { status: 'READY_FOR_DISPATCH' } });
    expect(dispatch.statusCode, dispatch.body).toBe(409);

    const buyerView = await asCustomer(app, desk.buyer, 'GET', `/inspection/buyer/orders/${desk.orderId}`);
    expect(buyerView.statusCode, buyerView.body).toBe(200);
    expect(buyerView.json<{ inspections: unknown[] }>().inspections.length).toBe(1);
    const sellerView = await asCustomer(app, desk.sellerA, 'GET', `/seller/inspection/orders/${groupId}`);
    expect(sellerView.statusCode, sellerView.body).toBe(200);
    expect(sellerView.body).toContain('Outer seal torn on one carton');

    const rival = await asCustomer(app, desk.rivalBuyer, 'GET', `/inspection/buyer/orders/${desk.orderId}`);
    // Somebody else's order: not found, never another buyer's inspection.
    expect(rival.statusCode, rival.body).toBe(404);
  }, 120_000);
});
