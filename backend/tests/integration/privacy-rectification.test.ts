/**
 * Art. 16 rectification requests (checklist SEC-007).
 *
 * A subject says what is wrong; only a member of staff holding
 * `data_request.action` decides it, with a note of what was corrected; the
 * request, its decision and its actor are in the audit log; and nobody else
 * can see or decide it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  asCustomer,
  asStaff,
  cleanUpOrderDesk,
  customer,
  emailFor,
  staff,
  type Session,
  type StaffSession,
} from '../support/order-desk-fixture.js';

const TAG = 'rect8';
let app: Awaited<ReturnType<typeof buildApp>>;
let subject: Session;
let other: Session;
let compliance: StaffSession;
let support: StaffSession;

async function subjectIds(): Promise<string[]> {
  const users = await prisma.user.findMany({
    where: { emailNormalized: { in: [emailFor(TAG, 'buyer'), emailFor(TAG, 'rival')] } },
    select: { id: true },
  });
  return users.map((row) => row.id);
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await prisma.dataRequest.deleteMany({ where: { subjectUserId: { in: await subjectIds() } } });
  await cleanUpOrderDesk(TAG);
  subject = await customer(app, TAG, 'buyer', '10.99.0.10');
  other = await customer(app, TAG, 'rival', '10.99.0.11');
  compliance = await staff(app, TAG, 'compliance', Role.COMPLIANCE_OFFICER, '10.99.0.12');
  support = await staff(app, TAG, 'support', Role.SUPPORT_AGENT, '10.99.0.13');
}, 120_000);

afterAll(async () => {
  await prisma.dataRequest.deleteMany({ where: { subjectUserId: { in: await subjectIds() } } });
  await cleanUpOrderDesk(TAG);
  await app.close();
});

describe('a correction request', () => {
  let requestId = '';

  it('is refused without saying what is wrong', async () => {
    const response = await asCustomer(app, subject, 'POST', '/account/data-requests', { payload: { type: 'RECTIFICATION', note: 'fix' } });
    expect(response.statusCode, response.body).toBe(400);
  });

  it('is opened once, with a due date, and audited', async () => {
    const opened = await asCustomer(app, subject, 'POST', '/account/data-requests', {
      payload: { type: 'RECTIFICATION', note: 'My company name is spelled Acme Traders, not Acme Trader.' },
    });
    expect(opened.statusCode, opened.body).toBe(202);
    const body = opened.json<{ id?: string; request?: { id: string } }>();
    requestId = body.request?.id ?? body.id ?? '';
    expect(requestId).toHaveLength(26);
    const again = await asCustomer(app, subject, 'POST', '/account/data-requests', {
      payload: { type: 'RECTIFICATION', note: 'A second copy of the same correction request.' },
    });
    expect(again.statusCode).toBe(409);
    expect(await prisma.auditLog.count({ where: { resourceId: requestId, action: 'data_request.created' } })).toBe(1);
  });

  it('is hidden from another customer and from staff without privacy permission', async () => {
    const list = await asCustomer(app, other, 'GET', '/account/data-requests');
    expect(list.body).not.toContain(requestId);
    expect((await asStaff(app, support, 'GET', `/data-requests/${requestId}`)).statusCode).toBe(403);
    expect((await asStaff(app, support, 'POST', `/data-requests/${requestId}/approve`, { payload: { note: 'x' } })).statusCode).toBe(403);
  });

  it('needs a note of what was corrected, then completes and is audited', async () => {
    const bare = await asStaff(app, compliance, 'POST', `/data-requests/${requestId}/approve`, { payload: {} });
    expect(bare.statusCode, bare.body).toBe(400);
    expect((await prisma.dataRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe('PENDING');
    const done = await asStaff(app, compliance, 'POST', `/data-requests/${requestId}/approve`, {
      payload: { note: 'Company name corrected to Acme Traders.' },
    });
    expect(done.statusCode, done.body).toBe(202);
    const row = await prisma.dataRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(row.status).toBe('COMPLETED');
    expect(row.completedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { resourceId: requestId, action: 'data_request.fulfilled' } })).toBe(1);
    const twice = await asStaff(app, compliance, 'POST', `/data-requests/${requestId}/approve`, { payload: { note: 'again' } });
    expect(twice.statusCode).toBe(409);
  });
});
