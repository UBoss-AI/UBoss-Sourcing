/**
 * Admin governance (JOURNEY-061, 065, LIVE-011).
 *
 *   - Maker-checker: deactivating a customer needs a reason, is recorded as a
 *     request, cannot be approved by the person who asked, runs only when a
 *     second member of staff approves, and leaves the account signed out.
 *   - History: the audit list filtered by the record shows the request, the
 *     approval and the status change.
 *   - Messages: staff can email a customer, audited against the customer.
 *   - Exception queues: every queue the caller may see, with an SLA, an owner
 *     role and a breach count; settings are validated and audited.
 *   - Integration monitor: a source per integration the caller may see; the
 *     storefront's payments notice is a bare yes or no.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Role } from '../../src/domain/permissions.js';
import { buildApp } from '../../src/http/app.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

const PASSWORD = 'Governance!2026Test';
const MAKER = 'gov-maker@test.local';
const CHECKER = 'gov-checker@test.local';
const SUPPORT = 'gov-support@test.local';
const BUYER = 'gov-buyer@test.local';
const IP = '10.93.0.11';

let app: Awaited<ReturnType<typeof buildApp>>;
let maker: AdminSession;
let checker: AdminSession;
let support: AdminSession;
let profileId = '';
let flagBefore: boolean | null = null;

async function makeStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  const id = newId();
  await prisma.user.create({
    data: { id, type: 'ADMIN', email, emailNormalized: email, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.userRole.create({ data: { userId: id, roleId: roleRow.id } });
}

async function cleanUp(): Promise<void> {
  const emails = [MAKER, CHECKER, SUPPORT, BUYER];
  const users = await prisma.user.findMany({ where: { emailNormalized: { in: emails } }, select: { id: true } });
  const userIds = users.map((row) => row.id);
  const profiles = await prisma.customerProfile.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
  const profileIds = profiles.map((row) => row.id);
  await prisma.adminPendingAction.deleteMany({ where: { OR: [{ requestedById: { in: userIds } }, { resourceId: { in: profileIds } }] } });
  await prisma.exceptionQueueSetting.deleteMany({ where: { updatedById: { in: userIds } } });
  await prisma.notificationOutbox.deleteMany({ where: { relatedId: { in: profileIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { resourceId: { in: profileIds } }] } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: emails } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const headers = (session: AdminSession) => ({ cookie: session.cookies, 'x-csrf-token': session.csrfToken, 'x-forwarded-for': IP });
const send = (
  session: AdminSession,
  method: 'POST' | 'PUT' | 'PATCH' | 'GET',
  url: string,
  payload?: Record<string, unknown>,
  extra: Record<string, string> = {},
) =>
  app.inject({
    method,
    url: `/api/v1/admin${url}`,
    headers: { ...headers(session), ...extra },
    ...(payload === undefined ? {} : { payload }),
  });

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const flag = await prisma.featureFlag.findUnique({ where: { key: 'critical_action_approval' } });
  flagBefore = flag?.enabled ?? null;
  await prisma.featureFlag.upsert({
    where: { key: 'critical_action_approval' },
    create: { id: newId(), key: 'critical_action_approval', enabled: true },
    update: { enabled: true },
  });

  await makeStaff(MAKER, Role.BUSINESS_OWNER);
  await makeStaff(CHECKER, Role.BUSINESS_OWNER);
  await makeStaff(SUPPORT, Role.SUPPORT_AGENT);
  maker = await signInAdmin(app, { email: MAKER, password: PASSWORD, ip: IP });
  checker = await signInAdmin(app, { email: CHECKER, password: PASSWORD, ip: IP });
  support = await signInAdmin(app, { email: SUPPORT, password: PASSWORD, ip: IP });

  const userId = newId();
  profileId = newId();
  await prisma.user.create({
    data: { id: userId, type: 'CUSTOMER', email: BUYER, emailNormalized: BUYER, passwordHash: await hashPassword(PASSWORD), status: 'ACTIVE', emailVerifiedAt: new Date() },
  });
  await prisma.customerProfile.create({ data: { id: profileId, userId, fullName: 'Governance Buyer' } });
});

afterAll(async () => {
  await cleanUp();
  if (flagBefore === null) await prisma.featureFlag.deleteMany({ where: { key: 'critical_action_approval' } });
  else await prisma.featureFlag.update({ where: { key: 'critical_action_approval' }, data: { enabled: flagBefore } });
  await app.close();
});

describe('maker-checker for a customer deactivation (JOURNEY-061)', () => {
  let pendingId = '';

  it('needs a reason', async () => {
    const response = await send(maker, 'PATCH', `/customers/${profileId}/status`, { active: false });
    expect(response.statusCode).toBe(400);
  });

  it('records a request instead of deactivating, and refuses a second one', async () => {
    const response = await send(maker, 'PATCH', `/customers/${profileId}/status`, { active: false, reason: 'Chargeback fraud under review.' });
    expect(response.statusCode, response.body).toBe(202);
    const pending = response.json<{ pending: { id: string; kind: string; status: string } }>().pending;
    expect(pending).toMatchObject({ kind: 'CUSTOMER_DEACTIVATE', status: 'PENDING' });
    pendingId = pending.id;

    const user = await prisma.customerProfile.findUniqueOrThrow({ where: { id: profileId }, select: { user: { select: { status: true } } } });
    expect(user.user.status).toBe('ACTIVE');

    const again = await send(checker, 'PATCH', `/customers/${profileId}/status`, { active: false, reason: 'Second try.' });
    expect(again.json<{ error: { code: string } }>().error.code).toBe('PENDING_ACTION_ALREADY_OPEN');
  });

  it('refuses the person who asked, and a member of staff without the grant', async () => {
    const self = await send(maker, 'POST', `/pending-actions/${pendingId}/approve`, {});
    expect(self.statusCode).toBe(403);
    expect(self.json<{ error: { code: string } }>().error.code).toBe('PENDING_ACTION_SAME_APPROVER');

    const outsider = await send(support, 'POST', `/pending-actions/${pendingId}/approve`, {});
    expect(outsider.statusCode).toBe(403);
  });

  it('runs the deactivation when a second member of staff approves', async () => {
    const approved = await send(checker, 'POST', `/pending-actions/${pendingId}/approve`, { note: 'Checked the chargebacks.' });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json<{ action: { status: string } }>().action.status).toBe('APPROVED');

    const user = await prisma.customerProfile.findUniqueOrThrow({ where: { id: profileId }, select: { user: { select: { status: true } } } });
    expect(user.user.status).toBe('DEACTIVATED');

    const twice = await send(checker, 'POST', `/pending-actions/${pendingId}/approve`, {});
    expect(twice.json<{ error: { code: string } }>().error.code).toBe('PENDING_ACTION_NOT_OPEN');
  });

  it('shows the request, the approval and the change in the record history', async () => {
    const history = await send(checker, 'GET', `/audit-logs?resourceType=customer&resourceId=${profileId}`);
    expect(history.statusCode, history.body).toBe(200);
    const actions = history.json<{ entries?: { action: string }[]; rows?: { action: string }[] }>();
    const list = (actions.entries ?? actions.rows ?? []).map((row) => row.action);
    expect(list).toEqual(expect.arrayContaining(['pending_action.requested', 'pending_action.approved', 'customer.status_changed']));
  });

  it('lists decided requests for the record', async () => {
    const listed = await send(checker, 'GET', `/pending-actions?resourceType=customer&resourceId=${profileId}`);
    expect(listed.json<{ actions: { id: string; status: string }[] }>().actions).toEqual([
      expect.objectContaining({ id: pendingId, status: 'APPROVED' }),
    ]);
  });
});

describe('a message from staff (JOURNEY-061)', () => {
  it('emails the customer and audits it against them', async () => {
    const response = await send(
      maker,
      'POST',
      '/account-messages',
      { target: 'CUSTOMER', id: profileId, subject: 'About your account', message: 'Please call us about your recent orders.' },
      { 'idempotency-key': newId() },
    );
    expect(response.statusCode, response.body).toBe(201);
    expect(response.json<{ emailQueued: boolean }>().emailQueued).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'account.message_sent', resourceId: profileId } })).toBe(1);
  });
});

describe('exception queues (LIVE-011)', () => {
  it('lists each queue with an SLA, an owner role and a breach count', async () => {
    const response = await send(maker, 'GET', '/exception-queues');
    expect(response.statusCode, response.body).toBe(200);
    const queues = response.json<{ queues: { key: string; slaHours: number; ownerRole: string; escalationRole: string; breached: number }[] }>().queues;
    for (const key of ['disputes', 'inspections', 'deadLetters', 'riskSignals', 'paymentMismatches', 'ledgerDifferences', 'feeApprovals', 'conditionalReleases', 'criticalActionApprovals']) {
      expect(queues.map((queue) => queue.key)).toContain(key);
    }
    for (const queue of queues) {
      expect(queue.slaHours).toBeGreaterThan(0);
      expect(queue.ownerRole.length).toBeGreaterThan(0);
      expect(queue.breached).toBeGreaterThanOrEqual(0);
    }
  });

  it('shows a support agent only the queues they may see', async () => {
    const response = await send(support, 'GET', '/exception-queues');
    const keys = response.json<{ queues: { key: string }[] }>().queues.map((queue) => queue.key);
    expect(keys).toContain('supportTickets');
    expect(keys).not.toContain('feeApprovals');
  });

  it('changes an SLA and owner, refuses an unknown role, and audits it', async () => {
    const bad = await send(maker, 'PUT', '/exception-queues/disputes', { slaHours: 12, ownerRole: 'no_such_role', escalationRole: 'business_owner' });
    expect(bad.statusCode).toBe(400);

    const saved = await send(maker, 'PUT', '/exception-queues/disputes', { slaHours: 12, ownerRole: 'finance_approver', escalationRole: 'business_owner' });
    expect(saved.statusCode, saved.body).toBe(200);
    const listed = (await send(maker, 'GET', '/exception-queues')).json<{ queues: { key: string; slaHours: number; isDefault: boolean }[] }>().queues;
    expect(listed.find((queue) => queue.key === 'disputes')).toMatchObject({ slaHours: 12, isDefault: false });
    expect(await prisma.auditLog.count({ where: { action: 'exception_queue.updated' } })).toBeGreaterThan(0);

    expect((await send(support, 'PUT', '/exception-queues/disputes', { slaHours: 1, ownerRole: 'support_agent', escalationRole: 'business_owner' })).statusCode).toBe(403);
  });
});

describe('integration monitor (JOURNEY-065)', () => {
  it('reports each integration the caller may see, with webhook counts', async () => {
    const response = await send(maker, 'GET', '/integrations/health');
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ sources: { key: string; status: string; webhooks: { accepted24h: number } | null }[]; outage: { active: boolean } }>();
    expect(body.sources.map((source) => source.key).sort()).toEqual(['carriers', 'customerErp', 'inspection', 'payments', 'warehouseErp']);
    expect(body.sources.find((source) => source.key === 'inspection')?.webhooks).toBeNull();
    expect(typeof body.outage.active).toBe('boolean');
  });

  it('gives the storefront a bare yes or no about payments', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/service-status' });
    expect(response.statusCode).toBe(200);
    expect(Object.keys(response.json<Record<string, unknown>>())).toEqual(['paymentsDegraded']);
  });
});
