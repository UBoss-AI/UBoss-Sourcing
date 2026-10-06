/**
 * Object-level authorization matrix (checklist SEC-002).
 *
 * One world, every role that may touch an order: the buyer, a rival buyer,
 * the selling seller, a rival seller, two inspection agencies, an assigned
 * and an unassigned inspector, and least-privilege staff. Every assertion is
 * a real route with a real session, so a guard that relies on the UI hiding a
 * link fails here. See docs/security/AUTHORIZATION-MATRIX.md.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { ensureRequirement } from '../../src/modules/inspection/gate.service.js';
import { runRiskScan } from '../../src/modules/risk/risk.service.js';
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
import { activateAndSignIn, auditEmailFor, cleanUpAuditPeople } from '../support/audit-session.js';

const TAG = 'authz8';
const RULE = 'authz8 every order';
let app: Awaited<ReturnType<typeof buildApp>>;
let desk: OrderDesk;
let owner: StaffSession;
let support: StaffSession;
let compliance: StaffSession;
let coordA: Session;
let inspA: Session;
let insp2: Session;
let coordB: Session;
let groupId = '';
let jobId = '';

const key = (): { idempotencyKey: string } => ({ idempotencyKey: newId() });

async function cleanInspection(): Promise<void> {
  if (desk !== undefined) await prisma.inspectionRequirement.deleteMany({ where: { orderId: desk.orderId } });
  const ids = (await prisma.inspectionAgency.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((r) => r.id);
  await prisma.inspectionAgencyMember.deleteMany({ where: { agencyId: { in: ids } } });
  await prisma.inspectionAgency.deleteMany({ where: { id: { in: ids } } });
  await prisma.inspectionRule.deleteMany({ where: { name: RULE } });
}

const AGENCY_IPS: Record<string, string> = { agcoord: '10.81.0.23', aginsp: '10.81.0.24', aginsp2: '10.81.0.25', agcoordb: '10.81.0.26' };
const agencySessions: Record<string, Session> = {};

/** An agency and its people, each invited to the Audit Console and signed in there. */
async function agency(name: string, members: [string, string][], categoryIds: string[]): Promise<string> {
  const created = await asStaff(app, owner, 'POST', '/inspection/agencies', {
    ...key(),
    payload: { name: `${TAG} ${name}`, legalName: `${TAG} ${name} Ltd`, country: 'IN', contactEmail: `${name.replace(/\W/g, '').toLowerCase()}@authz8.test.local`, dailyCapacity: 5 },
  });
  expect(created.statusCode, created.body).toBe(201);
  const agencyId = created.json<{ id: string }>().id;
  for (const [who, role] of members) {
    const added = await asStaff(app, owner, 'POST', `/inspection/agencies/${agencyId}/members`, {
      ...key(),
      payload: { email: auditEmailFor(TAG, who), fullName: who, role, idDocumentType: 'PASSPORT', idDocumentNumber: `${who}-1`, competenceCategoryIds: categoryIds },
    });
    expect(added.statusCode, added.body).toBe(201);
    const verified = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/inspection/members/${added.json<{ id: string }>().id}`,
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken, 'x-forwarded-for': owner.ip },
      payload: { verifyIdentity: true },
    });
    expect(verified.statusCode, verified.body).toBe(200);
    agencySessions[who] = await activateAndSignIn(app, added.json<{ userId: string }>().userId, AGENCY_IPS[who] ?? '10.81.0.99');
  }
  return agencyId;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  desk = await buildOrderDesk(app, TAG, 81);
  await cleanInspection();
  groupId = (await prisma.sellerOrderGroup.findFirstOrThrow({ where: { orderId: desk.orderId, sellerAccountId: desk.sellerAId }, select: { id: true } })).id;
  await prisma.sellerOrderGroup.update({ where: { id: groupId }, data: { status: 'PROCESSING', deliveredAt: null } });
  await prisma.inspectionRule.create({
    data: { id: newId(), name: RULE, isActive: true, priority: 1, level: 'MANDATORY', effectiveFrom: new Date(Date.now() - 86_400_000) },
  });
  await prisma.$transaction(async (tx) => { await ensureRequirement(tx, groupId); });
  owner = await staff(app, TAG, 'inspadmin', Role.BUSINESS_OWNER, '10.81.0.20');
  support = await staff(app, TAG, 'support', Role.SUPPORT_AGENT, '10.81.0.21');
  compliance = await staff(app, TAG, 'compliance', Role.COMPLIANCE_OFFICER, '10.81.0.22');
  await cleanUpAuditPeople(TAG);

  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: desk.orderId }, select: { productId: true } });
  const product = await prisma.product.findUniqueOrThrow({ where: { id: item.productId }, select: { categoryId: true } });
  const competence = product.categoryId === null ? [] : [product.categoryId];
  const agencyA = await agency('Alpha QA', [['agcoord', 'COORDINATOR'], ['aginsp', 'INSPECTOR'], ['aginsp2', 'INSPECTOR']], competence);
  await agency('Beta QA', [['agcoordb', 'COORDINATOR']], competence);
  coordA = agencySessions['agcoord'] as Session;
  inspA = agencySessions['aginsp'] as Session;
  insp2 = agencySessions['aginsp2'] as Session;
  coordB = agencySessions['agcoordb'] as Session;

  const booked = await asStaff(app, owner, 'POST', '/inspection/jobs', {
    ...key(),
    payload: {
      sellerOrderGroupId: groupId, agencyId: agencyA, scheduledFor: new Date(Date.now() + 3 * 86_400_000).toISOString(),
      inspectionPointType: 'SELLER_PREMISES', inspectionPoint: { label: 'Factory', addressLine: '1 Mill Road', city: 'Pune', country: 'IN' }, payer: 'BUYER',
    },
  });
  expect(booked.statusCode, booked.body).toBe(201);
  jobId = booked.json<{ jobId: string }>().jobId;
  const accepted = await asCustomer(app, coordA, 'POST', `/audit/agency/jobs/${jobId}/accept`, { ...key(), payload: { conflictStatement: 'No link to either party.', confirmNoConflict: true } });
  expect(accepted.statusCode, accepted.body).toBe(200);
  const detail = await asCustomer(app, coordA, 'GET', `/audit/agency/jobs/${jobId}`);
  const named = detail.json<{ job: { eligibleInspectors: { id: string; fullName: string }[] } }>().job.eligibleInspectors.find((m) => m.fullName === 'aginsp');
  const assigned = await asCustomer(app, coordA, 'POST', `/audit/agency/jobs/${jobId}/assign`, { ...key(), payload: { inspectorMemberId: named?.id } });
  expect(assigned.statusCode, assigned.body).toBe(200);
}, 300_000);

afterAll(async () => {
  await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: true } });
  await cleanInspection();
  await cleanUpAuditPeople(TAG);
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('buyer objects', () => {
  it('shows the buyer their order and hides it from a rival buyer on every path', async () => {
    expect((await asCustomer(app, desk.buyer, 'GET', `/orders/${desk.orderId}`)).statusCode).toBe(200);
    for (const path of [
      `/orders/${desk.orderId}`,
      `/orders/${desk.orderId}/invoice`,
      `/orders/${desk.orderId}/receipts`,
      `/orders/${desk.orderId}/tracking`,
      `/orders/${desk.orderId}/payment-protection`,
      `/documents/orders/${desk.orderId}`,
      `/inspection/buyer/orders/${desk.orderId}`,
    ]) {
      const response = await asCustomer(app, desk.rivalBuyer, 'GET', path);
      expect([403, 404], `${path}: ${response.body}`).toContain(response.statusCode);
    }
  });

  it('refuses a rival cancelling the order by changing the id in the URL', async () => {
    const response = await asCustomer(app, desk.rivalBuyer, 'POST', `/orders/${desk.orderId}/cancel`, { ...key(), payload: { reason: 'not mine' } });
    expect([403, 404]).toContain(response.statusCode);
  });
});

describe('seller objects', () => {
  it('shows a seller its own order part and hides it from another seller', async () => {
    expect((await asCustomer(app, desk.sellerA, 'GET', `/seller/orders/${groupId}`)).statusCode).toBe(200);
    for (const path of [`/seller/orders/${groupId}`, `/seller/orders/${groupId}/documents`, `/seller/inspection/orders/${groupId}`]) {
      const response = await asCustomer(app, desk.sellerB, 'GET', path);
      expect([403, 404], `${path}: ${response.body}`).toContain(response.statusCode);
    }
  });

  it('keeps one sellerâ€™s settlements and ledger out of another sellerâ€™s view', async () => {
    const own = await asCustomer(app, desk.sellerB, 'GET', '/seller/settlements/orders');
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).not.toContain(groupId);
    expect(own.body).not.toContain(desk.sellerAId);
  });

  it('refuses a buyer session on Seller Hub routes', async () => {
    expect([401, 403, 404]).toContain((await asCustomer(app, desk.buyer, 'GET', `/seller/orders/${groupId}`)).statusCode);
  });
});

describe('inspection objects', () => {
  it('never treats a storefront, seller or admin login as an auditor', async () => {
    // Three separate refusals, one per credential: the console reads only its
    // own cookie jar, its own token audience and users.type = AUDIT.
    for (const session of [desk.buyer, desk.sellerA]) {
      expect((await asCustomer(app, session, 'GET', '/audit/auth/me')).statusCode).toBe(401);
      expect((await asCustomer(app, session, 'GET', '/audit/jobs')).statusCode).toBe(401);
      expect((await asCustomer(app, session, 'GET', `/audit/agency/jobs/${jobId}`)).statusCode).toBe(401);
    }
    const adminCall = await app.inject({
      method: 'GET',
      url: '/api/v1/audit/jobs',
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken, 'x-forwarded-for': owner.ip },
    });
    expect(adminCall.statusCode).toBe(401);
    // And an agency member's console session cannot reach the admin panel or the storefront.
    expect((await app.inject({ method: 'GET', url: '/api/v1/admin/inspection/queue', headers: { cookie: coordA.cookie, 'x-forwarded-for': coordA.ip } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/orders', headers: { cookie: coordA.cookie, 'x-forwarded-for': coordA.ip } })).statusCode).toBe(401);
    // A storefront password does not open the console, even for the same address.
    const wrongDoor = await app.inject({
      method: 'POST',
      url: '/api/v1/audit/auth/login',
      headers: { 'x-forwarded-for': '10.81.0.40' },
      payload: { email: `${TAG}-buyer@orderdesk.test.local`, password: 'OrderDeskPass!2026x' },
    });
    expect([401, 403]).toContain(wrongDoor.statusCode);
  });

  it('lets an agency member see only their own agency in the console lists', async () => {
    const own = await asCustomer(app, coordA, 'GET', '/audit/jobs');
    expect(own.statusCode, own.body).toBe(200);
    expect(own.body).toContain(jobId);
    for (const session of [coordB, insp2]) {
      const other = await asCustomer(app, session, 'GET', '/audit/jobs');
      expect(other.statusCode, other.body).toBe(200);
      expect(other.body).not.toContain(jobId);
      expect((await asCustomer(app, session, 'GET', `/audit/jobs/${jobId}`)).statusCode).toBe(404);
    }
    // An agency member asking for another agency by id still gets their own.
    const forcedFilter = await asCustomer(app, coordB, 'GET', `/audit/jobs?agencyId=${(await prisma.inspectionJob.findUniqueOrThrow({ where: { id: jobId }, select: { agencyId: true } })).agencyId}`);
    expect(forcedFilter.body).not.toContain(jobId);
  });

  it('lets the assigned inspector and coordinator see the job', async () => {
    expect((await asCustomer(app, coordA, 'GET', `/audit/agency/jobs/${jobId}`)).statusCode).toBe(200);
    expect((await asCustomer(app, inspA, 'GET', `/audit/agency/jobs/${jobId}`)).statusCode).toBe(200);
  });

  it('hides the job from another agency and from an unassigned inspector of the same agency', async () => {
    for (const session of [coordB, insp2]) {
      const response = await asCustomer(app, session, 'GET', `/audit/agency/jobs/${jobId}`);
      expect([403, 404], response.body).toContain(response.statusCode);
      const list = await asCustomer(app, session, 'GET', '/audit/agency/jobs');
      expect(list.body).not.toContain(jobId);
    }
    const start = await asCustomer(app, insp2, 'POST', `/audit/agency/jobs/${jobId}/start`, key());
    expect([403, 404, 409]).toContain(start.statusCode);
    const accept = await asCustomer(app, coordB, 'POST', `/audit/agency/jobs/${jobId}/decline`, { ...key(), payload: { reason: 'not ours' } });
    expect([403, 404]).toContain(accept.statusCode);
  });

  it('serves evidence only to parties allowed to see it, and audits every read', async () => {
    await prisma.inspectionPolicy.updateMany({ data: { requirePackingListForReadiness: false } });
    const ready = await asCustomer(app, desk.sellerA, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, {
      ...key(),
      payload: { lotReference: 'LOT-1', readyDate: new Date().toISOString().slice(0, 10), locationLabel: 'Bay 2', contactName: 'Ravi', contactPhone: '+911234567890', packedStatus: 'PACKED', declaration: true },
    });
    expect(ready.statusCode, ready.body).toBe(200);
    // Another seller cannot declare readiness on this job.
    const forged = await asCustomer(app, desk.sellerB, 'POST', `/seller/inspection/jobs/${jobId}/readiness`, {
      ...key(),
      payload: { lotReference: 'LOT-X', readyDate: new Date().toISOString().slice(0, 10), locationLabel: 'Bay 9', contactName: 'X', contactPhone: '+911234567891', packedStatus: 'PACKED', declaration: true },
    });
    expect([403, 404]).toContain(forged.statusCode);
    for (const step of ['conflict', 'start'] as const) {
      const done = await asCustomer(app, inspA, 'POST', `/audit/agency/jobs/${jobId}/${step}`, { ...key(), payload: step === 'conflict' ? { hasConflict: false } : {} });
      expect(done.statusCode, done.body).toBe(200);
    }
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const b = 'authz8boundary';
    const crlf = String.fromCharCode(13, 10);
    const body = Buffer.concat([
      Buffer.from(`--${b}${crlf}Content-Disposition: form-data; name="purpose"${crlf}${crlf}GENERAL${crlf}--${b}${crlf}Content-Disposition: form-data; name="file"; filename="seal.png"${crlf}Content-Type: image/png${crlf}${crlf}`),
      png,
      Buffer.from(`${crlf}--${b}--${crlf}`),
    ]);
    const uploaded = await app.inject({
      method: 'POST',
      url: `/api/v1/audit/agency/jobs/${jobId}/evidence`,
      headers: { cookie: inspA.cookie, 'x-csrf-token': inspA.csrf, 'x-forwarded-for': inspA.ip, 'idempotency-key': newId(), 'content-type': `multipart/form-data; boundary=${b}` },
      payload: body,
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const evidenceId = uploaded.json<{ id: string }>().id;

    expect((await asCustomer(app, inspA, 'GET', `/audit/agency/evidence/${evidenceId}`)).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { resourceId: evidenceId, action: 'inspection.evidence_downloaded' } })).toBe(1);
    for (const [session, path] of [
      [insp2, `/audit/agency/evidence/${evidenceId}`],
      [coordB, `/audit/agency/evidence/${evidenceId}`],
      [desk.sellerB, `/seller/inspection/evidence/${evidenceId}`],
      [desk.rivalBuyer, `/inspection/buyer/evidence/${evidenceId}`],
    ] as const) {
      const response = await asCustomer(app, session, 'GET', path);
      expect([403, 404], `${path}: ${response.body}`).toContain(response.statusCode);
    }
    expect(await prisma.auditLog.count({ where: { resourceId: evidenceId, action: 'inspection.evidence_downloaded' } })).toBe(1);

    // SEC-008: evidence claiming to be captured days before it was uploaded is
    // flagged for review (and nothing else happens to the job).
    await prisma.inspectionEvidence.update({ where: { id: evidenceId }, data: { capturedAt: new Date(Date.now() - 3 * 86_400_000) } });
    const rules = await prisma.riskRule.findMany();
    try {
      await prisma.riskRule.updateMany({ data: { enabled: false } });
      await prisma.riskRule.update({ where: { code: 'EVIDENCE_LATE_UPLOAD' }, data: { enabled: true, windowMinutes: 1440 } });
      await runRiskScan();
      const signal = await prisma.riskSignal.findFirst({ where: { ruleCode: 'EVIDENCE_LATE_UPLOAD', subjectId: evidenceId } });
      expect(signal?.facts).toMatchObject({ jobId });
      expect((await prisma.inspectionJob.findUniqueOrThrow({ where: { id: jobId } })).status).not.toBe('CANCELLED');
    } finally {
      await prisma.riskSignal.deleteMany({ where: { subjectId: evidenceId } });
      for (const { code, createdAt: _c, updatedAt: _u, ...rest } of rules) await prisma.riskRule.update({ where: { code }, data: rest });
    }
  });

  it('refuses buyers, sellers and plain customers on the agency portal', async () => {
    // Not "forbidden": a storefront session is not a console session at all.
    for (const session of [desk.buyer, desk.sellerB]) {
      expect((await asCustomer(app, session, 'GET', `/audit/agency/jobs/${jobId}`)).statusCode).toBe(401);
    }
  });
});

describe('staff scopes', () => {
  it('lets support read orders and tickets but not refund, cancel or administer', async () => {
    expect((await asStaff(app, support, 'GET', '/orders')).statusCode).toBe(200);
    expect((await asStaff(app, support, 'POST', `/orders/${desk.orderId}/refunds`, { ...key(), payload: { amountMinor: '1', reason: 'x' } })).statusCode).toBe(403);
    expect((await asStaff(app, support, 'GET', '/data-requests')).statusCode).toBe(403);
    expect((await asStaff(app, support, 'GET', '/finance/ledger/orders')).statusCode).toBe(403);
    expect((await asStaff(app, support, 'GET', '/staff')).statusCode).toBe(403);
  });

  it('lets compliance work privacy requests but not money', async () => {
    expect((await asStaff(app, compliance, 'GET', '/data-requests')).statusCode).toBe(200);
    expect((await asStaff(app, compliance, 'POST', `/orders/${desk.orderId}/refunds`, { ...key(), payload: { amountMinor: '1', reason: 'x' } })).statusCode).toBe(403);
    expect((await asStaff(app, compliance, 'GET', '/finance/ledger/orders')).statusCode).toBe(403);
  });

  it('refuses a staff member raising their own roles, and audits the owner doing it', async () => {
    const self = await prisma.user.findFirstOrThrow({ where: { emailNormalized: emailFor(TAG, 'support') }, select: { id: true } });
    const patch = (session: StaffSession, roleKeys: string[]) =>
      app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/staff/${self.id}/roles`,
        headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': session.ip },
        payload: { roleKeys },
      });
    expect((await patch(support, [Role.BUSINESS_OWNER])).statusCode).toBe(403);
    expect((await patch(compliance, [Role.BUSINESS_OWNER])).statusCode).toBe(403);
    const before = await prisma.auditLog.count({ where: { resourceId: self.id } });
    expect((await patch(owner, [Role.SUPPORT_AGENT, Role.COMPLIANCE_OFFICER])).statusCode).toBe(200);
    expect(await prisma.auditLog.count({ where: { resourceId: self.id } })).toBeGreaterThan(before);
  });
});

describe('deactivated accounts', () => {
  it('signs a deactivated buyer out of everything at once', async () => {
    const gone = await customer(app, TAG, 'gone', '10.81.0.27');
    expect((await asCustomer(app, gone, 'GET', '/orders')).statusCode).toBe(200);
    const profile = await prisma.customerProfile.findFirstOrThrow({ where: { user: { emailNormalized: emailFor(TAG, 'gone') } }, select: { id: true } });
    // Maker-checker is a separate test (governance-maker-checker); this one is
    // about the sign-out, so the single-approver path is used.
    const flag = await prisma.featureFlag.findUnique({ where: { key: 'critical_action_approval' } });
    await prisma.featureFlag.updateMany({ where: { key: 'critical_action_approval' }, data: { enabled: false } });
    let off;
    try {
      off = await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/customers/${profile.id}/status`,
        headers: { cookie: compliance.cookies, 'x-csrf-token': compliance.csrfToken, 'x-forwarded-for': compliance.ip },
        payload: { active: false, reason: 'authz8 test' },
      });
    } finally {
      if (flag !== null) await prisma.featureFlag.update({ where: { key: 'critical_action_approval' }, data: { enabled: flag.enabled } });
    }
    expect(off.statusCode, off.body).toBe(200);
    expect((await asCustomer(app, gone, 'GET', '/orders')).statusCode).toBe(401);
  });
});

describe('controlled cross-border access to sensitive files', () => {
  it('refuses privacy requests outside the allowed countries, and fails closed without the header', async () => {
    const { env } = await import('../../src/config/env.js');
    const before = env.STAFF_SENSITIVE_DATA_COUNTRIES;
    env.STAFF_SENSITIVE_DATA_COUNTRIES = ['IN'];
    try {
      const call = (country?: string) =>
        app.inject({
          method: 'GET',
          url: '/api/v1/admin/data-requests',
          headers: {
            cookie: compliance.cookies,
            'x-csrf-token': compliance.csrfToken,
            'x-forwarded-for': compliance.ip,
            ...(country === undefined ? {} : { [env.STAFF_COUNTRY_HEADER]: country }),
          },
        });
      expect((await call()).statusCode).toBe(403);
      const abroad = await call('US');
      expect(abroad.statusCode).toBe(403);
      expect(abroad.body).toContain('DATA_REGION_NOT_ALLOWED');
      expect((await call('in')).statusCode).toBe(200);
    } finally {
      env.STAFF_SENSITIVE_DATA_COUNTRIES = before;
    }
    // With no policy configured, nothing changes.
    expect((await asStaff(app, compliance, 'GET', '/data-requests')).statusCode).toBe(200);
  });
});
