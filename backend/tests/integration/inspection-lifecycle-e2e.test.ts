/**
 * A first-time inspection PASS, end to end, with its trail (LIVE-007, LIVE-009).
 *
 * `inspection-http.test.ts` walks FAIL -> NCR -> re-inspection -> PASS. This
 * is the other half of LIVE-007: an inspection that passes the first time,
 * carried through to the goods leaving:
 *
 *   rule -> booking -> agency accepts and assigns -> seller readiness ->
 *   inspector inspects and submits -> QA signs PASS -> release recorded
 *   automatically -> seller may mark the order ready for dispatch ->
 *   consignment -> the inspector binds the goods to a container and seal
 *
 * and LIVE-009's checks on the way:
 *
 *   - the inspector cannot sign (no permission), and nobody on the job can
 *     sign its report even with the permission (INSPECTION_SELF_APPROVAL_FORBIDDEN);
 *   - every step leaves an InspectionEvent, and every audited step an
 *     AuditLog row on the order that names the same event;
 *   - stored evidence carries the SHA-256 of its bytes, and reading it back
 *     writes an audit row naming who read it;
 *   - the signed report carries a content hash and a signature by the QA
 *     member who signed it.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { ensureRequirement } from '../../src/modules/inspection/gate.service.js';
import { createShipmentsForOrder } from '../../src/modules/logistics/shipment-create.service.js';
import {
  asCustomer as customerCall,
  asStaff as staffCall,
  buildOrderDesk,
  cleanUpOrderDesk,
  errorCode,
  staff,
  type CallOptions,
  type OrderDesk,
  type Session,
  type StaffSession,
} from '../support/order-desk-fixture.js';
import { activateAndSignIn, auditEmailFor, cleanUpAuditPeople } from '../support/audit-session.js';

const TAG = 'insp9';
const AGENCY_IPS = { agcoord: '10.92.7.21', aginsp: '10.92.7.22', agqa: '10.92.7.23' } as const;
const RULE_NAME = 'insp9 every order';
const CONTAINER = 'MSCU1234565';
const SEAL = 'SEAL-INSP9-01';

let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let admin: StaffSession;
let coordinator: Session;
let inspector: Session;
let qa: Session;
let groupId = '';
let agencyId = '';
let jobId = '';
let packingRuleBefore = true;

const asCustomer: typeof customerCall = (target, session, method, path, options: CallOptions = {}) =>
  customerCall(target, session, method, path, { idempotencyKey: newId(), ...options });
const asStaff: typeof staffCall = (target, session, method, path, options: CallOptions = {}) =>
  staffCall(target, session, method, path, { idempotencyKey: newId(), ...options });

/** A 1x1 PNG, the smallest real image the evidence store will accept. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function uploadEvidence(session: Session, url: string, fields: Record<string, string>) {
  const boundary = 'insp9boundary';
  const crlf = String.fromCharCode(13, 10);
  const head = Object.entries(fields)
    .map(([key, value]) => `--${boundary}${crlf}Content-Disposition: form-data; name="${key}"${crlf}${crlf}${value}${crlf}`)
    .join('');
  const body = Buffer.concat([
    Buffer.from(
      `${head}--${boundary}${crlf}Content-Disposition: form-data; name="file"; filename="photo.png"${crlf}Content-Type: image/png${crlf}${crlf}`,
    ),
    PNG,
    Buffer.from(`${crlf}--${boundary}--${crlf}`),
  ]);
  return app.inject({
    method: 'POST',
    url: `/api/v1${url}`,
    headers: {
      cookie: session.cookie,
      'x-csrf-token': session.csrf,
      'x-forwarded-for': session.ip,
      'idempotency-key': newId(),
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: body,
  });
}

async function cleanInspection(): Promise<void> {
  if (desk !== undefined) {
    const shipmentIds = (
      await prisma.logisticsShipment.findMany({ where: { orderId: desk.orderId }, select: { id: true } })
    ).map((row) => row.id);
    await prisma.inspectionRequirement.deleteMany({ where: { orderId: desk.orderId } });
    await prisma.logisticsShipmentEvent.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
    await prisma.logisticsShipmentPackage.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
    await prisma.logisticsShipmentAssignment.deleteMany({ where: { shipmentId: { in: shipmentIds } } });
    await prisma.logisticsShipment.deleteMany({ where: { id: { in: shipmentIds } } });
    await prisma.sellerOrderGroup.updateMany({ where: { orderId: desk.orderId }, data: { locationId: null } });
    await prisma.sellerLocation.deleteMany({ where: { sellerAccountId: desk.sellerAId, code: 'INSP9-WH' } });
  }
  const agencies = await prisma.inspectionAgency.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } });
  const ids = agencies.map((row) => row.id);
  await prisma.inspectionAgencyMember.deleteMany({ where: { agencyId: { in: ids } } });
  await prisma.inspectionAgency.deleteMany({ where: { id: { in: ids } } });
  await prisma.inspectionRule.deleteMany({ where: { name: RULE_NAME } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 92, 7);
  await cleanInspection();
  groupId = (
    await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: desk.orderId }, select: { id: true } })
  ).id;

  // Where the seller ships from, so a consignment can be raised later.
  const location = await prisma.sellerLocation.create({
    data: {
      id: newId(),
      sellerAccountId: desk.sellerAId,
      code: 'INSP9-WH',
      name: 'Pune works',
      addressLine1: '1 Mill Road',
      city: 'Pune',
      postcode: '411001',
      countryCode: 'IN',
      timezone: 'Asia/Kolkata',
      dispatchCutoff: '16:00',
      workingDaysMask: 31,
      handlingTimeDays: 1,
      isOperational: true,
    },
  });
  await prisma.sellerOrderGroup.update({
    where: { id: groupId },
    data: { status: 'PROCESSING', deliveredAt: null, locationId: location.id },
  });

  await prisma.inspectionRule.create({
    data: {
      id: newId(),
      name: RULE_NAME,
      isActive: true,
      priority: 1,
      level: 'MANDATORY',
      effectiveFrom: new Date(Date.now() - 86_400_000),
    },
  });
  await prisma.$transaction(async (tx) => {
    await ensureRequirement(tx, groupId);
  });

  const policy = await prisma.inspectionPolicy.findFirst({ select: { requirePackingListForReadiness: true } });
  packingRuleBefore = policy?.requirePackingListForReadiness ?? true;
  await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: false } });

  admin = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.92.7.20');
  // Agency people are invited to the Audit Console below and sign in there.
  await cleanUpAuditPeople(TAG);
}, 240_000);

afterAll(async () => {
  await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: packingRuleBefore } });
  await cleanInspection();
  await cleanUpAuditPeople(TAG);
  await cleanUpOrderDesk(TAG);
  await app.close();
});

const eventKinds = async (): Promise<string[]> =>
  (
    await prisma.inspectionEvent.findMany({
      where: { orderId: desk.orderId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { kind: true },
    })
  ).map((row) => row.kind);

describe('a first-time PASS, from the rule to the goods bound to a container', () => {
  it('runs end to end, leaving an event and an audit row for each step', async () => {
    // --- The agency and its three members -----------------------------------
    const created = await asStaff(app, admin, 'POST', '/inspection/agencies', {
      payload: {
        name: `${TAG} Independent QA`,
        legalName: `${TAG} Independent QA Ltd`,
        country: 'IN',
        contactEmail: 'qa@insp9.test.local',
        dailyCapacity: 5,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    agencyId = created.json<{ id: string }>().id;
    const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: desk.orderId }, select: { productId: true } });
    const product = await prisma.product.findUniqueOrThrow({ where: { id: item.productId }, select: { categoryId: true } });
    const competence = product.categoryId === null ? [] : [product.categoryId];
    const memberIds: Record<string, string> = {};
    for (const [who, role] of [
      ['agcoord', 'COORDINATOR'],
      ['aginsp', 'INSPECTOR'],
      ['agqa', 'QA_REVIEWER'],
    ] as const) {
      const added = await asStaff(app, admin, 'POST', `/inspection/agencies/${agencyId}/members`, {
        payload: {
          email: auditEmailFor(TAG, who),
          fullName: who,
          role,
          idDocumentType: 'PASSPORT',
          idDocumentNumber: `${who}-1`,
          competenceCategoryIds: competence,
        },
      });
      expect(added.statusCode, added.body).toBe(201);
      memberIds[who] = added.json<{ id: string }>().id;
      const verified = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/inspection/members/${memberIds[who] ?? ''}`,
        headers: { cookie: admin.cookies, 'x-csrf-token': admin.csrfToken, 'x-forwarded-for': admin.ip },
        payload: { verifyIdentity: true },
      });
      expect(verified.statusCode, verified.body).toBe(200);
      const session = await activateAndSignIn(app, added.json<{ userId: string }>().userId, AGENCY_IPS[who]);
      if (who === 'agcoord') coordinator = session;
      else if (who === 'aginsp') inspector = session;
      else qa = session;
    }

    // --- Booking, acceptance, assignment, readiness -------------------------
    const booked = await asStaff(app, admin, 'POST', '/inspection/jobs', {
      payload: {
        sellerOrderGroupId: groupId,
        agencyId,
        scheduledFor: new Date(Date.now() + 2 * 86_400_000).toISOString(),
        inspectionPointType: 'SELLER_PREMISES',
        inspectionPoint: { label: 'Factory', addressLine: '1 Mill Road', city: 'Pune', country: 'IN' },
        payer: 'BUYER',
      },
    });
    expect(booked.statusCode, booked.body).toBe(201);
    jobId = booked.json<{ jobId: string }>().jobId;
    expect(await eventKinds()).toContain('booked');

    const accepted = await asCustomer(app, coordinator, 'POST', `/audit/agency/jobs/${jobId}/accept`, {
      payload: { conflictStatement: 'No financial or family link to the seller or buyer.', confirmNoConflict: true },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(await eventKinds()).toContain('job_accepted');

    const assigned = await asCustomer(app, coordinator, 'POST', `/audit/agency/jobs/${jobId}/assign`, {
      payload: { inspectorMemberId: memberIds['aginsp'] },
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    expect(await eventKinds()).toContain('inspector_assigned');

    const ready = await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, {
      payload: {
        lotReference: 'LOT-9',
        readyDate: new Date().toISOString().slice(0, 10),
        locationLabel: 'Factory bay 1',
        contactName: 'Ravi',
        contactPhone: '+911234567890',
        packedStatus: 'PACKED',
        declaration: true,
      },
    });
    expect(ready.statusCode, ready.body).toBe(200);
    expect(await eventKinds()).toContain('readiness_submitted');

    // Before a signed PASS the goods may not move.
    const tooEarly = await asCustomer(app, desk.sellerA, 'PATCH', `/seller/orders/${groupId}/status`, {
      payload: { status: 'READY_FOR_DISPATCH' },
    });
    expect(tooEarly.statusCode, tooEarly.body).toBe(409);

    // --- The inspection itself ----------------------------------------------
    for (const [action, payload] of [
      ['conflict', { hasConflict: false }],
      ['start', {}],
      ['sampling', { lotReference: 'LOT-9', sampledQuantity: 3, acceptedQuantity: 3, rejectedQuantity: 0 }],
    ] as const) {
      const step = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/${action}`, { payload });
      expect(step.statusCode, `${action}: ${step.body}`).toBe(200);
    }
    expect(await eventKinds()).toEqual(expect.arrayContaining(['conflict_declared', 'job_in_progress']));

    const view = await asCustomer(app, inspector, 'GET', `/audit/agency/jobs/${jobId}`);
    const checklist = view.json<{ job: { checklist: { code?: string; itemCode?: string }[] } }>().job.checklist;
    for (const entry of checklist) {
      const code = entry.code ?? entry.itemCode ?? '';
      const check = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/checks`, {
        payload: { itemCode: code, outcome: 'CONFORM' },
      });
      expect(check.statusCode, `check ${code}: ${check.body}`).toBe(200);
    }

    const photo = await uploadEvidence(inspector, `/audit/agency/jobs/${jobId}/evidence`, {
      purpose: 'GENERAL',
      capturedAt: new Date().toISOString(),
    });
    expect(photo.statusCode, photo.body).toBe(201);
    const photoId = photo.json<{ id: string }>().id;

    // The stored hash is the SHA-256 of exactly the bytes that were sent.
    const stored = await prisma.inspectionEvidence.findUniqueOrThrow({ where: { id: photoId } });
    expect(stored.contentHash).toBe(createHash('sha256').update(PNG).digest('hex'));
    expect(await eventKinds()).toContain('evidence_added');

    const submitted = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/report/submit`, {
      payload: { summary: 'All checks conform; no defects found.' },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    // --- Who may sign -------------------------------------------------------
    // The inspector has no signing permission at all.
    const byInspector = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/report/sign`);
    expect(byInspector.statusCode, byInspector.body).toBe(403);

    // And somebody named on the job cannot sign its report even with it: put
    // the QA reviewer on as backup inspector and the signature is refused.
    await prisma.inspectionJob.update({ where: { id: jobId }, data: { backupInspectorMemberId: memberIds['agqa'] ?? null } });
    const ownJob = await asCustomer(app, qa, 'POST', `/audit/agency/jobs/${jobId}/report/sign`);
    expect(ownJob.statusCode, ownJob.body).toBe(409);
    expect(errorCode(ownJob)).toBe('INSPECTION_SELF_APPROVAL_FORBIDDEN');
    expect(await prisma.inspectionReport.count({ where: { jobId, status: 'SIGNED' } })).toBe(0);
    await prisma.inspectionJob.update({ where: { id: jobId }, data: { backupInspectorMemberId: null } });

    const signed = await asCustomer(app, qa, 'POST', `/audit/agency/jobs/${jobId}/report/sign`);
    expect(signed.statusCode, signed.body).toBe(200);
    expect(signed.json<{ result: string }>().result).toBe('PASS');

    const report = await prisma.inspectionReport.findFirstOrThrow({ where: { jobId, status: 'SIGNED' } });
    expect(report.result).toBe('PASS');
    expect(report.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(report.signature).toBeTruthy();
    expect(report.signedByMemberId).toBe(memberIds['agqa']);

    // --- The release, recorded by the signature itself ----------------------
    const release = await prisma.inspectionRelease.findFirstOrThrow({
      where: { requirement: { sellerOrderGroupId: groupId }, state: 'ACTIVE' },
    });
    expect(release).toMatchObject({ kind: 'PASS', reportId: report.id });
    expect(await eventKinds()).toEqual(expect.arrayContaining(['report_signed', 'release_recorded', 'job_completed']));

    // ...so the seller may now mark the order ready for dispatch.
    const readyToGo = await asCustomer(app, desk.sellerA, 'PATCH', `/seller/orders/${groupId}/status`, {
      payload: { status: 'READY_FOR_DISPATCH' },
    });
    expect(readyToGo.statusCode, readyToGo.body).toBe(204);

    // --- A consignment, and the goods bound to it ---------------------------
    const raised = await createShipmentsForOrder(desk.orderId, null);
    expect(raised.length).toBeGreaterThanOrEqual(1);
    const shipment = await prisma.logisticsShipment.findFirstOrThrow({ where: { sellerOrderGroupId: groupId } });
    // The packing step is the seller's, and not what this file is about: the
    // packages the consignment was raised with are given their container and
    // seal directly.
    const sealed = await prisma.logisticsShipmentPackage.updateMany({
      where: { shipmentId: shipment.id },
      data: { containerNumber: CONTAINER, sealNumber: SEAL },
    });
    if (sealed.count === 0) {
      await prisma.logisticsShipmentPackage.create({
        data: {
          id: newId(),
          shipmentId: shipment.id,
          packageReference: `INSP9-${newId().slice(-10)}`,
          containerNumber: CONTAINER,
          sealNumber: SEAL,
        },
      });
    }

    const stuffing = await uploadEvidence(inspector, `/audit/agency/jobs/${jobId}/evidence`, {
      purpose: 'BINDING',
      capturedAt: new Date().toISOString(),
    });
    expect(stuffing.statusCode, stuffing.body).toBe(201);

    const ordered = await prisma.sellerOrderLine.aggregate({ where: { orderGroupId: groupId }, _sum: { quantity: true } });
    const quantity = ordered._sum.quantity ?? 0;

    // A seal that is not the one on the consignment is refused.
    const wrongSeal = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/binding`, {
      payload: { logisticsShipmentId: shipment.id, containerNumber: CONTAINER, sealNumber: 'SEAL-OTHER', stuffedQuantity: quantity, stuffedAt: new Date().toISOString() },
    });
    expect(wrongSeal.statusCode, wrongSeal.body).toBe(409);
    expect(errorCode(wrongSeal)).toBe('INSPECTION_BINDING_MISMATCH');

    const bound = await asCustomer(app, inspector, 'POST', `/audit/agency/jobs/${jobId}/binding`, {
      payload: {
        logisticsShipmentId: shipment.id,
        containerNumber: CONTAINER,
        sealNumber: SEAL,
        stuffedQuantity: quantity,
        stuffedAt: new Date().toISOString(),
        witnessName: 'Plant supervisor',
      },
    });
    expect(bound.statusCode, bound.body).toBe(200);

    const binding = await prisma.inspectionShipmentBinding.findFirstOrThrow({ where: { jobId } });
    expect(binding).toMatchObject({
      logisticsShipmentId: shipment.id,
      containerNumber: CONTAINER,
      sealNumber: SEAL,
      stuffedQuantity: quantity,
      recordedByMemberId: memberIds['aginsp'],
    });
    expect(binding.scopeHash).toMatch(/^[0-9a-f]{64}$/);
    // The PASS release is replaced by one bound to the loaded goods.
    const live = await prisma.inspectionRelease.findMany({
      where: { requirement: { sellerOrderGroupId: groupId }, state: 'ACTIVE' },
    });
    expect(live).toHaveLength(1);
    expect(live[0]?.id).not.toBe(release.id);
    expect(live[0]?.bindingId).toBe(binding.id);
    expect(await eventKinds()).toContain('goods_bound');

    // --- The trail ------------------------------------------------------------
    // Every audit row the inspection wrote on this order names an event that
    // is on the timeline, and the audited steps are all there.
    const audits = await prisma.auditLog.findMany({
      where: { resourceType: 'order', resourceId: desk.orderId, action: { startsWith: 'inspection.' } },
      select: { action: true, afterJson: true, actorUserId: true },
    });
    const kinds = new Set(await eventKinds());
    for (const entry of audits) {
      const kind = (entry.afterJson as { kind?: string } | null)?.kind;
      expect(kind, entry.action).toBeDefined();
      expect(kinds.has(kind ?? ''), `${entry.action} -> ${String(kind)}`).toBe(true);
    }
    const actions = new Set(audits.map((entry) => entry.action));
    for (const action of [
      'inspection.booked',
      'inspection.job_status_changed',
      'inspection.report_signed',
      'inspection.release_recorded',
    ]) {
      expect(actions.has(action), action).toBe(true);
    }
    // The signature's audit row is by the QA reviewer's own account.
    const qaUser = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: auditEmailFor(TAG, 'agqa') }, select: { id: true } });
    expect(audits.some((entry) => entry.action === 'inspection.report_signed' && entry.actorUserId === qaUser.id)).toBe(true);

    // Reading evidence back is itself audited, with who read it.
    const download = await asCustomer(app, inspector, 'GET', `/audit/agency/evidence/${photoId}`);
    expect(download.statusCode).toBe(200);
    const inspectorUser = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: auditEmailFor(TAG, 'aginsp') }, select: { id: true } });
    const reads = await prisma.auditLog.findMany({
      where: { action: 'inspection.evidence_downloaded', resourceId: photoId },
      select: { actorUserId: true, afterJson: true },
    });
    expect(reads).toHaveLength(1);
    expect(reads[0]?.actorUserId).toBe(inspectorUser.id);
    expect(reads[0]?.afterJson).toMatchObject({ party: 'AGENCY', jobId });
  }, 180_000);
});
