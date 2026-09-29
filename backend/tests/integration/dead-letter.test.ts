/**
 * The dead-letter screens: dead background jobs and undeliverable emails.
 *
 * Until these routes existed the operations dashboard counted both queues and
 * linked each to a page that was not there. What this file holds the routes
 * to:
 *
 *   - Reading shows what is needed to decide, and never a job payload, an
 *     email body or an unmasked address.
 *   - A retry is one more attempt, exactly once, however many times it is
 *     pressed - and retrying an email also re-arms the job that delivers it,
 *     which is the step that silently did nothing when done by hand.
 *   - Reading needs settings.read; retrying needs settings.write.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Permission, Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { readOperationsOverview } from '../../src/modules/notifications/operations-overview.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const OWNER_EMAIL = 'deadletter-owner@test.local';
const READER_EMAIL = 'deadletter-reader@test.local';
const CUSTOMER_EMAIL = 'deadletter-customer@test.local';
const PASSWORD = 'DeadLetterScreens!2026';
const EMAILS = [OWNER_EMAIL, READER_EMAIL, CUSTOMER_EMAIL];

const jobIds: string[] = [];
const outboxIds: string[] = [];

type Jar = Map<string, string>;

function absorb(jar: Jar, response: LightMyRequestResponse): Jar {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

const cookieHeader = (jar: Jar): string =>
  [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');

async function signInAsStaff(email: string): Promise<Jar> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = absorb(new Map(), login);

  // Every admin route but three refuses a session that has not said where it is from.
  const located = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/session/location',
    headers: { cookie: cookieHeader(jar), 'x-csrf-token': jar.get('uboss_admin_csrf') ?? '' },
    payload: { latitude: 51.2194, longitude: 4.4025, accuracyM: 42 },
  });
  expect(located.statusCode, located.body).toBe(200);
  return absorb(jar, located);
}

function call(jar: Jar | null, method: 'GET' | 'POST', url: string) {
  return app.inject({
    method,
    url,
    headers:
      jar === null
        ? {}
        : { cookie: cookieHeader(jar), 'x-csrf-token': jar.get('uboss_admin_csrf') ?? '' },
  });
}

async function makeStaff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  const user = await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.userRole.create({ data: { userId: user.id, roleId: roleRow.id } });
}

async function deadJob(overrides: { lastError?: string } = {}): Promise<string> {
  const id = newId();
  jobIds.push(id);
  await prisma.jobQueue.create({
    data: {
      id,
      jobType: 'export.generate',
      payloadJson: { data: { exportJobId: 'SECRET-PAYLOAD-VALUE' }, correlationId: null },
      status: 'DEAD',
      attemptCount: 5,
      maxAttempts: 5,
      lastError: overrides.lastError ?? 'connect ETIMEDOUT',
      completedAt: new Date(),
    },
  });
  return id;
}

async function deadEmail(recipientEmail = 'jane.buyer@hospital.example'): Promise<string> {
  const id = newId();
  outboxIds.push(id);
  await prisma.notificationOutbox.create({
    data: {
      id,
      eventKey: 'payment.link',
      recipientEmail,
      recipientName: 'Jane Buyer',
      subject: 'Your payment link, Jane',
      body: 'Pay here: https://pay.example/SINGLE-USE-TOKEN',
      status: 'DEAD',
      attemptCount: 5,
      maxAttempts: 5,
      lastError: `550 mailbox ${recipientEmail} unavailable`,
    },
  });
  return id;
}

async function cleanUp(): Promise<void> {
  await prisma.jobQueue.deleteMany({
    where: {
      OR: [{ id: { in: jobIds } }, { dedupeKey: { in: outboxIds.map((id) => `notification:${id}`) } }],
    },
  });
  await prisma.notificationOutbox.deleteMany({ where: { id: { in: outboxIds } } });
  await prisma.auditLog.deleteMany({ where: { action: { in: ['job.retried', 'notification.retried'] } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

let owner: Jar;
let reader: Jar;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  await makeStaff(OWNER_EMAIL, Role.BUSINESS_OWNER);
  // A catalogue manager holds settings.read but not settings.write.
  await makeStaff(READER_EMAIL, Role.CATALOG_MANAGER);

  const customer = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: CUSTOMER_EMAIL,
      emailNormalized: CUSTOMER_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({ data: { id: newId(), userId: customer.id, fullName: 'A Customer' } });

  owner = await signInAsStaff(OWNER_EMAIL);
  reader = await signInAsStaff(READER_EMAIL);
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('reading the dead-letter queues', () => {
  it('lists a dead job without its payload', async () => {
    const id = await deadJob();
    const response = await call(reader, 'GET', '/api/v1/admin/operations/dead-jobs?pageSize=100');

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain('SECRET-PAYLOAD-VALUE');

    const row = response.json<{ jobs: { id: string; jobType: string; attemptCount: number }[] }>().jobs.find(
      (job) => job.id === id,
    );
    expect(row).toMatchObject({ jobType: 'export.generate', attemptCount: 5 });
  });

  it('lists an undeliverable email with the address masked and no body or subject', async () => {
    const id = await deadEmail();
    const response = await call(reader, 'GET', '/api/v1/admin/operations/failed-notifications?pageSize=100');

    expect(response.statusCode, response.body).toBe(200);
    // The body carries a single-use link; the subject and error carry the person.
    expect(response.body).not.toContain('SINGLE-USE-TOKEN');
    expect(response.body).not.toContain('Your payment link');
    expect(response.body).not.toContain('jane.buyer@hospital.example');
    expect(response.body).not.toContain('Jane Buyer');

    const row = response
      .json<{ notifications: { id: string; recipient: string; lastError: string; retryable: boolean }[] }>()
      .notifications.find((entry) => entry.id === id);
    expect(row?.recipient).toMatch(/^j•+@hospital\.example$/);
    expect(row?.lastError).toContain('@hospital.example');
    expect(row?.retryable).toBe(true);
  });

  it('refuses a customer and an anonymous caller', async () => {
    const customer = absorb(
      new Map(),
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: CUSTOMER_EMAIL, password: PASSWORD },
      }),
    );
    expect((await call(customer, 'GET', '/api/v1/admin/operations/dead-jobs')).statusCode).toBe(401);
    expect((await call(null, 'GET', '/api/v1/admin/operations/failed-notifications')).statusCode).toBe(401);
  });

  it('is what the dashboard queues now link to', async () => {
    const overview = await readOperationsOverview({ permissions: [Permission.SETTINGS_READ] });
    const hrefs = Object.fromEntries(overview.queues.map((queue) => [queue.key, queue.href]));
    expect(hrefs.jobsDead).toBe('/operations/dead-jobs');
    expect(hrefs.notificationsFailed).toBe('/operations/failed-notifications');
  });
});

describe('retrying a dead job', () => {
  it('queues exactly one more attempt, audited, and refuses a second press', async () => {
    const id = await deadJob();

    const first = await call(owner, 'POST', `/api/v1/admin/operations/dead-jobs/${id}/retry`);
    expect(first.statusCode, first.body).toBe(202);

    const job = await prisma.jobQueue.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe('PENDING');
    expect(job.completedAt).toBeNull();
    // One more go, not a reset counter.
    expect(job.attemptCount).toBe(5);
    expect(job.maxAttempts).toBe(6);

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'job.retried', resourceId: id } });
    expect(audit.actorEmail).toBe(OWNER_EMAIL);

    const second = await call(owner, 'POST', `/api/v1/admin/operations/dead-jobs/${id}/retry`);
    expect(second.statusCode).toBe(409);
    expect(second.json<{ error: { code: string } }>().error.code).toBe('CONFLICT');
    expect((await prisma.jobQueue.findUniqueOrThrow({ where: { id } })).maxAttempts).toBe(6);
  });

  it('is refused to a member of staff who may only read settings', async () => {
    const id = await deadJob();
    const response = await call(reader, 'POST', `/api/v1/admin/operations/dead-jobs/${id}/retry`);

    expect(response.statusCode).toBe(403);
    expect((await prisma.jobQueue.findUniqueOrThrow({ where: { id } })).status).toBe('DEAD');
  });

  it('answers 404 for a job that does not exist', async () => {
    const response = await call(owner, 'POST', `/api/v1/admin/operations/dead-jobs/${newId()}/retry`);
    expect(response.statusCode).toBe(404);
  });
});

describe('retrying an undeliverable email', () => {
  it('re-arms the delivery job that already exists, rather than leaving the email stuck', async () => {
    const id = await deadEmail();
    // The finished job that sent (and failed) it: its unique key would make a
    // fresh enqueue a silent no-op.
    const oldJob = newId();
    jobIds.push(oldJob);
    await prisma.jobQueue.create({
      data: {
        id: oldJob,
        jobType: 'notification.send',
        payloadJson: { data: { outboxId: id }, correlationId: null },
        status: 'SUCCEEDED',
        dedupeKey: `notification:${id}`,
        completedAt: new Date(),
      },
    });

    const response = await call(owner, 'POST', `/api/v1/admin/operations/failed-notifications/${id}/retry`);
    expect(response.statusCode, response.body).toBe(202);

    const email = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id } });
    expect(email.status).toBe('PENDING');
    expect(email.maxAttempts).toBe(6);

    const job = await prisma.jobQueue.findUniqueOrThrow({ where: { id: oldJob } });
    expect(job.status).toBe('PENDING');
    expect(job.completedAt).toBeNull();
    expect(await prisma.jobQueue.count({ where: { dedupeKey: `notification:${id}` } })).toBe(1);

    expect(
      await prisma.auditLog.count({ where: { action: 'notification.retried', resourceId: id } }),
    ).toBe(1);

    const again = await call(owner, 'POST', `/api/v1/admin/operations/failed-notifications/${id}/retry`);
    expect(again.statusCode).toBe(409);
  });

  it('queues a delivery job when none is left to re-arm', async () => {
    const id = await deadEmail();

    const response = await call(owner, 'POST', `/api/v1/admin/operations/failed-notifications/${id}/retry`);
    expect(response.statusCode, response.body).toBe(202);

    const job = await prisma.jobQueue.findFirstOrThrow({ where: { dedupeKey: `notification:${id}` } });
    expect(job.status).toBe('PENDING');
    expect(job.jobType).toBe('notification.send');
  });

  it('refuses a message to an erased person, and says so in the list', async () => {
    const id = await deadEmail('erased-01abcdefghjkmnpqrstvwxyz0@erased.invalid');

    const list = await call(owner, 'GET', '/api/v1/admin/operations/failed-notifications?pageSize=100');
    const row = list
      .json<{ notifications: { id: string; retryable: boolean }[] }>()
      .notifications.find((entry) => entry.id === id);
    expect(row?.retryable).toBe(false);

    const response = await call(owner, 'POST', `/api/v1/admin/operations/failed-notifications/${id}/retry`);
    expect(response.statusCode).toBe(409);
    expect((await prisma.notificationOutbox.findUniqueOrThrow({ where: { id } })).status).toBe('DEAD');
  });
});
