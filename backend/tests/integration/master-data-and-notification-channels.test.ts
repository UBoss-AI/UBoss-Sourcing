/**
 * Master rows 75 and 76.
 *
 * 75: units of measure, Incoterms and defect codes are admin-managed lists -
 * seeded, readable with settings.read, editable only with settings.write,
 * codes unique per list.
 *
 * 76: notification channels. Email off + in-app on records an IN_APP row the
 * notification centre lists; WhatsApp on records a SUPPRESSED row saying no
 * provider is configured (nothing is faked as sent); in-app off hides the
 * event from the customer's notification centre.
 *
 * Every event key here is this file's own, so no global setting is touched.
 * Everything written is removed in afterAll.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signInAdmin } from '../support/admin-session.js';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  enqueueNotification,
  WHATSAPP_NO_PROVIDER,
} from '../../src/modules/notifications/notification.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let owner: { cookies: string; csrfToken: string };
let reader: { cookies: string; csrfToken: string };
let customer: { cookies: string };

const RUN = newId().slice(-6).toLowerCase();
const OWNER_EMAIL = `md-owner-${RUN}@test.local`;
const READER_EMAIL = `md-reader-${RUN}@test.local`;
const CUSTOMER_EMAIL = `md-customer-${RUN}@test.local`;
const PASSWORD = 'MasterData!2026';
const EVENT_IN_APP = `test.m76.inapp.${RUN}`;
const EVENT_HIDDEN = `test.m76.hidden.${RUN}`;
const EVENT_OFF = `test.m76.off.${RUN}`;
const CODE = `ZT${RUN.toUpperCase()}`;

async function staff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: role === Role.CUSTOMER ? 'CUSTOMER' : 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await staff(OWNER_EMAIL, Role.BUSINESS_OWNER);
  await staff(READER_EMAIL, Role.CATALOG_MANAGER);
  await staff(CUSTOMER_EMAIL, Role.CUSTOMER);
  const user = await prisma.user.findUniqueOrThrow({ where: { emailNormalized: CUSTOMER_EMAIL } });
  await prisma.customerProfile.create({
    data: { id: newId(), userId: user.id, fullName: 'Channel Buyer', activatedAt: new Date() },
  });

  owner = await signInAdmin(app, { email: OWNER_EMAIL, password: PASSWORD, ip: '203.0.113.175' });
  reader = await signInAdmin(app, { email: READER_EMAIL, password: PASSWORD, ip: '203.0.113.176' });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': '203.0.113.177' },
    payload: { email: CUSTOMER_EMAIL, password: PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = login.cookies as { name: string; value: string }[];
  customer = { cookies: jar.map((c) => `${c.name}=${c.value}`).join('; ') };
});

afterAll(async () => {
  const events = [EVENT_IN_APP, EVENT_HIDDEN, EVENT_OFF];
  await prisma.notificationOutbox.deleteMany({ where: { eventKey: { in: events } } });
  await prisma.notificationSetting.deleteMany({ where: { eventKey: { in: events } } });
  await prisma.masterDataEntry.deleteMany({ where: { code: { startsWith: CODE } } });
  const emails = [OWNER_EMAIL, READER_EMAIL, CUSTOMER_EMAIL];
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: CUSTOMER_EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: emails } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: emails } } });
  await app.close();
});

describe('master data (row 75)', () => {
  it('ships the Incoterms 2020, common units and defect codes', async () => {
    for (const [kind, code] of [
      ['INCOTERM', 'FOB'],
      ['UOM', 'KG'],
      ['DEFECT_CODE', 'DIM'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/admin/master-data/${kind}`,
        headers: { cookie: reader.cookies },
      });
      expect(response.statusCode, response.body).toBe(200);
      const { entries } = response.json<{ entries: { code: string }[] }>();
      expect(entries.map((entry) => entry.code)).toContain(code);
    }
  });

  it('lets settings.write add, rename and switch off an entry, and refuses a duplicate code', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/master-data/UOM',
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken },
      payload: { code: CODE.toLowerCase(), name: 'Test unit' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const entry = created.json<{ entry: { id: string; code: string } }>().entry;
    expect(entry.code).toBe(CODE);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/master-data/UOM',
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken },
      payload: { code: CODE, name: 'Again' },
    });
    expect(duplicate.statusCode).toBe(409);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/master-data/UOM/${entry.id}`,
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken },
      payload: { name: 'Renamed unit', isActive: false },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json<{ entry: { name: string; isActive: boolean } }>().entry).toMatchObject({
      name: 'Renamed unit',
      isActive: false,
    });

    // The same id under another list is not found there.
    const wrongKind = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/master-data/INCOTERM/${entry.id}`,
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken },
      payload: { name: 'x' },
    });
    expect(wrongKind.statusCode).toBe(404);
  });

  it('refuses a write from somebody with settings.read only', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/master-data/INCOTERM',
      headers: { cookie: reader.cookies, 'x-csrf-token': reader.csrfToken },
      payload: { code: `${CODE}X`, name: 'Nope' },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('notification channels (row 76)', () => {
  it('saves and lists the WhatsApp and in-app channels, with the built-in catalogue', async () => {
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/v1/admin/settings/notifications',
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken },
      payload: {
        eventKey: EVENT_IN_APP,
        emailEnabled: false,
        inAppEnabled: true,
        whatsappEnabled: true,
        whatsappTemplate: 'Hi {{recipientName}}',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/settings/notifications',
      headers: { cookie: reader.cookies },
    });
    expect(list.statusCode).toBe(200);
    const body = list.json<{
      notifications: { eventKey: string; whatsappEnabled: boolean; inAppEnabled: boolean; whatsappTemplate: string }[];
      catalogue: { eventKey: string }[];
    }>();
    expect(body.notifications.find((row) => row.eventKey === EVENT_IN_APP)).toMatchObject({
      whatsappEnabled: true,
      inAppEnabled: true,
      whatsappTemplate: 'Hi {{recipientName}}',
    });
    expect(body.catalogue.map((row) => row.eventKey)).toContain('user.password_reset');
  });

  it('records in-app only when email is off, and WhatsApp as not sent', async () => {
    const id = await enqueueNotification({
      eventKey: EVENT_IN_APP,
      recipientEmail: CUSTOMER_EMAIL,
      recipientName: 'Asha',
    });
    expect(id).not.toBeNull();

    const rows = await prisma.notificationOutbox.findMany({ where: { eventKey: EVENT_IN_APP } });
    const inApp = rows.find((row) => row.channel === 'IN_APP');
    const whatsapp = rows.find((row) => row.channel === 'WHATSAPP');
    expect(rows.some((row) => row.channel === 'EMAIL')).toBe(false);
    expect(inApp).toMatchObject({ status: 'SENT' });
    expect(whatsapp).toMatchObject({ status: 'SUPPRESSED', lastError: WHATSAPP_NO_PROVIDER, body: 'Hi Asha' });
  });

  it('sends nothing when every channel is off', async () => {
    await prisma.notificationSetting.create({
      data: {
        id: newId(),
        eventKey: EVENT_OFF,
        name: 'off',
        emailEnabled: false,
        inAppEnabled: false,
        subjectTemplate: 's',
        bodyTemplate: 'b',
      },
    });
    const id = await enqueueNotification({ eventKey: EVENT_OFF, recipientEmail: CUSTOMER_EMAIL });
    expect(id).toBeNull();
  });

  it('hides an event with in-app off from the customer notification centre', async () => {
    await prisma.notificationSetting.create({
      data: {
        id: newId(),
        eventKey: EVENT_HIDDEN,
        name: 'hidden',
        inAppEnabled: false,
        subjectTemplate: 's',
        bodyTemplate: 'b',
      },
    });
    await prisma.notificationOutbox.create({
      data: {
        id: newId(),
        eventKey: EVENT_HIDDEN,
        recipientEmail: CUSTOMER_EMAIL,
        subject: 'Hidden one',
        body: 'b',
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/account/notifications',
      headers: { cookie: customer.cookies },
    });
    expect(response.statusCode, response.body).toBe(200);
    const keys = response.json<{ notifications: { eventKey: string }[] }>().notifications.map((n) => n.eventKey);
    expect(keys).toContain(EVENT_IN_APP);
    expect(keys).not.toContain(EVENT_HIDDEN);
  });
});
