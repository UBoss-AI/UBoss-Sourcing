/**
 * The notification centre (checklist JOURNEY-056).
 *
 *   - Unread is the recipient's own mark, set by POST /account/notifications/read
 *     for the ids given or for all, and never for somebody else's row.
 *   - Priority and a deep link come back with each row.
 *   - Muting a family on a channel stops that channel; a mandatory family
 *     (orders, payments, security, data rights) cannot be muted at all.
 *   - SMS: switched on for an event, an SMS row is written beside the email
 *     with its own dedupe key; with no gateway configured it is SUPPRESSED
 *     with the reason, never faked as sent.
 *   - A retried enqueue with the same dedupe key writes nothing new.
 *
 * Event keys are this file's own (`shipment.test-<run>` and `order.test-<run>`),
 * so no global notification setting is touched. Everything is removed in
 * afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// Types only: erased at runtime, so the modules still load after the env is set.
import type { buildApp as BuildApp } from '../../src/http/app.js';
import type { prisma as PrismaClient } from '../../src/infra/prisma.js';
import type { enqueueNotification as EnqueueNotification } from '../../src/modules/notifications/notification.service.js';

const RUN = `${Date.now().toString(36)}`;
const BUYER_EMAIL = `nc-buyer-${RUN}@test.local`;
const OTHER_EMAIL = `nc-other-${RUN}@test.local`;
const PASSWORD = 'NotifyCentre!2026';
const SHIPMENT_EVENT = `shipment.test-${RUN}`;
const ORDER_EVENT = `order.test-${RUN}`;

type App = Awaited<ReturnType<typeof BuildApp>>;
let app: App;
let prisma: typeof PrismaClient;
let enqueueNotification: typeof EnqueueNotification;
let SMS_NO_GATEWAY = '';
let cookie = '';
let csrf = '';
let buyerUserId = '';

async function makeUser(email: string): Promise<string> {
  const { hashPassword } = await import('../../src/infra/crypto.js');
  const { newId } = await import('../../src/infra/ids.js');
  const id = newId();
  await prisma.user.create({
    data: {
      id,
      type: 'CUSTOMER',
      email,
      emailNormalized: email,
      phone: '+491700000000',
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({ data: { id: newId(), userId: id, fullName: 'Centre Buyer', activatedAt: new Date() } });
  return id;
}

beforeAll(async () => {
  // No SMS gateway in this run, whatever the developer's .env says.
  process.env.SMS_HTTP_URL = '';
  ({ prisma } = await import('../../src/infra/prisma.js'));
  const service = await import('../../src/modules/notifications/notification.service.js');
  enqueueNotification = service.enqueueNotification;
  SMS_NO_GATEWAY = service.SMS_NO_GATEWAY;
  const { buildApp } = await import('../../src/http/app.js');
  app = await buildApp();
  await app.ready();

  buyerUserId = await makeUser(BUYER_EMAIL);
  await makeUser(OTHER_EMAIL);

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': '10.94.56.10' },
    payload: { email: BUYER_EMAIL, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ');
  csrf = jar.find((c) => c.name === 'uboss_shop_csrf')?.value ?? '';
});

afterAll(async () => {
  const emails = [BUYER_EMAIL, OTHER_EMAIL];
  await prisma.notificationOutbox.deleteMany({ where: { eventKey: { in: [SHIPMENT_EVENT, ORDER_EVENT] } } });
  await prisma.notificationSetting.deleteMany({ where: { eventKey: { in: [SHIPMENT_EVENT, ORDER_EVENT] } } });
  const users = await prisma.user.findMany({ where: { emailNormalized: { in: emails } }, select: { id: true } });
  const ids = users.map((row) => row.id);
  await prisma.notificationPreference.deleteMany({ where: { userId: { in: ids } } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
  await prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: ids } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: emails } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await app.close();
});

function call(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) {
  return app.inject({
    method,
    url: `/api/v1${url}`,
    headers: { cookie, 'x-csrf-token': csrf },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

/** Deliver what the worker would, for the email rows only: mark them SENT. */
async function sendAll(): Promise<void> {
  await prisma.notificationOutbox.updateMany({
    where: { eventKey: { in: [SHIPMENT_EVENT, ORDER_EVENT] }, channel: 'EMAIL', status: 'PENDING' },
    data: { status: 'SENT', sentAt: new Date() },
  });
}

describe('unread, priority and deep link', () => {
  it('lists an unread row with a link to its order, and marks only your own rows read', async () => {
    await enqueueNotification({
      eventKey: ORDER_EVENT,
      recipientEmail: BUYER_EMAIL,
      dedupeKey: `nc:${RUN}:order`,
      relatedType: 'order',
      relatedId: '01ORDERCENTRETEST000000000',
    });
    await enqueueNotification({ eventKey: ORDER_EVENT, recipientEmail: OTHER_EMAIL, dedupeKey: `nc:${RUN}:other` });
    await sendAll();

    const listed = await call('GET', '/account/notifications');
    expect(listed.statusCode, listed.body).toBe(200);
    const body = listed.json<{ unreadCount: number; notifications: { id: string; readAt: string | null; link: string | null; mandatory: boolean }[] }>();
    const mine = body.notifications.find((row) => row.link === '/account/orders/01ORDERCENTRETEST000000000');
    expect(mine?.readAt).toBeNull();
    expect(mine?.mandatory).toBe(true);
    expect(body.unreadCount).toBeGreaterThanOrEqual(1);

    const other = await prisma.notificationOutbox.findFirstOrThrow({ where: { recipientEmail: OTHER_EMAIL, eventKey: ORDER_EVENT } });
    const marked = await call('POST', '/account/notifications/read', { ids: [mine?.id ?? '', other.id] });
    expect(marked.statusCode, marked.body).toBe(200);
    expect(marked.json<{ updated: number }>().updated).toBe(1);
    const untouched = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: other.id } });
    expect(untouched.readAt).toBeNull();

    const all = await call('POST', '/account/notifications/read', { all: true });
    expect(all.statusCode).toBe(200);
  });

  it('suppresses a retried enqueue with the same dedupe key', async () => {
    const first = await enqueueNotification({ eventKey: ORDER_EVENT, recipientEmail: BUYER_EMAIL, dedupeKey: `nc:${RUN}:dup` });
    const second = await enqueueNotification({ eventKey: ORDER_EVENT, recipientEmail: BUYER_EMAIL, dedupeKey: `nc:${RUN}:dup` });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe('preferences', () => {
  it('refuses to mute a mandatory family', async () => {
    const response = await call('PUT', '/account/notification-preferences', { muted: [{ family: 'orders', channel: 'EMAIL' }] });
    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: { code: string } }>().error.code).toBe('NOTIFICATION_PREFERENCE_MANDATORY');
  });

  it('stops a muted channel and audits the choice', async () => {
    const saved = await call('PUT', '/account/notification-preferences', { muted: [{ family: 'shipments', channel: 'EMAIL' }] });
    expect(saved.statusCode, saved.body).toBe(200);
    const shipments = saved
      .json<{ families: { key: string; channels: Record<string, boolean> }[] }>()
      .families.find((family) => family.key === 'shipments');
    expect(shipments?.channels.EMAIL).toBe(false);
    expect(shipments?.channels.IN_APP).toBe(true);

    await enqueueNotification({ eventKey: SHIPMENT_EVENT, recipientEmail: BUYER_EMAIL, dedupeKey: `nc:${RUN}:muted` });
    const rows = await prisma.notificationOutbox.findMany({ where: { dedupeKey: `nc:${RUN}:muted` } });
    // Email muted, in-app still on: recorded for the centre only.
    expect(rows.map((row) => row.channel)).toEqual(['IN_APP']);

    const audit = await prisma.auditLog.findFirst({ where: { action: 'notification.preferences_changed', actorUserId: buyerUserId } });
    expect(audit).not.toBeNull();

    // Both channels muted: nothing is written at all.
    await call('PUT', '/account/notification-preferences', { muted: [{ family: 'shipments', channel: 'EMAIL' }, { family: 'shipments', channel: 'IN_APP' }] });
    await enqueueNotification({ eventKey: SHIPMENT_EVENT, recipientEmail: BUYER_EMAIL, dedupeKey: `nc:${RUN}:gone` });
    expect(await prisma.notificationOutbox.count({ where: { dedupeKey: `nc:${RUN}:gone` } })).toBe(0);
    await call('PUT', '/account/notification-preferences', { muted: [] });
  });
});

describe('SMS mapping', () => {
  it('writes an SMS row with its own key, SUPPRESSED when no gateway is configured', async () => {
    const { newId } = await import('../../src/infra/ids.js');
    await prisma.notificationSetting.create({
      data: {
        id: newId(),
        eventKey: SHIPMENT_EVENT,
        name: 'Test shipment event',
        emailEnabled: true,
        smsEnabled: true,
        subjectTemplate: 'Test {{recipientName}}',
        bodyTemplate: 'Your parcel moved.',
      },
    });
    await enqueueNotification({ eventKey: SHIPMENT_EVENT, recipientEmail: BUYER_EMAIL, dedupeKey: `nc:${RUN}:sms` });
    const sms = await prisma.notificationOutbox.findFirstOrThrow({ where: { dedupeKey: `nc:${RUN}:sms:sms` } });
    expect(sms.channel).toBe('SMS');
    expect(sms.recipientPhone).toBe('+491700000000');
    expect(sms.status).toBe('SUPPRESSED');
    expect(sms.lastError).toBe(SMS_NO_GATEWAY);
    expect(await prisma.notificationOutbox.count({ where: { dedupeKey: `nc:${RUN}:sms` } })).toBe(1);

    // Muting SMS for the family stops the SMS row, not the email.
    await call('PUT', '/account/notification-preferences', { muted: [{ family: 'shipments', channel: 'SMS' }] });
    await enqueueNotification({ eventKey: SHIPMENT_EVENT, recipientEmail: BUYER_EMAIL, dedupeKey: `nc:${RUN}:nosms` });
    expect(await prisma.notificationOutbox.count({ where: { dedupeKey: `nc:${RUN}:nosms:sms` } })).toBe(0);
    expect(await prisma.notificationOutbox.count({ where: { dedupeKey: `nc:${RUN}:nosms` } })).toBe(1);
    await call('PUT', '/account/notification-preferences', { muted: [] });
  });
});
