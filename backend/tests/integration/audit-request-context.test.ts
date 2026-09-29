/**
 * Every audit row written during an HTTP request carries that request's
 * address and User-Agent, without the service passing them.
 *
 *   - A staff edit through the real route (a POST, whose body is parsed
 *     before the handler - the case AsyncLocalStorage loses without the
 *     preValidation re-entry, and a PATCH) records both.
 *   - A write outside any request - the worker, a script - records neither.
 *   - A value the caller passes wins over the request's.
 *   - Two requests at once never swap each other's device.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { runWithRequestContext } from '../../src/infra/request-context.js';
import { recordAudit } from '../../src/modules/audit/audit.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'AuditRequestContext!2026';
const OWNER_EMAIL = 'auditctx-owner@test.local';
const RESOURCE = 'auditctx_probe';
const PROBE = 'auditctx_probe.written';
const SLUG_PREFIX = 'auditctx-';

const FIREFOX_ON_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0';
const SAFARI_ON_IOS =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

let owner: AdminSession;
let ownerId = '';

async function cleanUp(): Promise<void> {
  const categories = await prisma.category.findMany({
    where: { slug: { startsWith: SLUG_PREFIX } },
    select: { id: true },
  });
  const ids = categories.map((category) => category.id);
  await prisma.auditLog.deleteMany({
    where: { OR: [{ resourceType: RESOURCE }, { resourceType: 'category', resourceId: { in: ids } }] },
  });
  await prisma.category.deleteMany({ where: { id: { in: ids } } });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: OWNER_EMAIL } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: OWNER_EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: OWNER_EMAIL } });
}

function createCategory(name: string, userAgent: string) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/categories',
    headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken, 'user-agent': userAgent },
    payload: { name, slug: `${SLUG_PREFIX}${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  const role = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER } });
  ownerId = newId();
  await prisma.user.create({
    data: {
      id: ownerId,
      type: 'ADMIN',
      email: OWNER_EMAIL,
      emailNormalized: OWNER_EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.userRole.create({ data: { userId: ownerId, roleId: role.id } });
  owner = await signInAdmin(app, { email: OWNER_EMAIL, password: PASSWORD, ip: '198.51.100.72' });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('audit rows written inside a request', () => {
  it('a category created and then renamed through the admin routes records address and device', async () => {
    const created = await createCategory('Auditctx Gloves', FIREFOX_ON_LINUX);
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json<{ id: string }>();

    const createdRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'category.created', resourceId: id },
    });
    // The category service passes the IP itself but never a User-Agent: this
    // one came from the request context.
    expect(createdRow.userAgent).toBe(FIREFOX_ON_LINUX);
    expect(createdRow.ipAddress).not.toBeNull();

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/categories/${id}`,
      headers: { cookie: owner.cookies, 'x-csrf-token': owner.csrfToken, 'user-agent': SAFARI_ON_IOS },
      payload: { name: 'Auditctx Gloves Nitrile' },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);

    const updatedRow = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'category.updated', resourceId: id },
    });
    expect(updatedRow.userAgent).toBe(SAFARI_ON_IOS);

    // And the screen reads it back as a device.
    const listed = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/audit-logs?resourceType=category&resourceId=${id}&action=category.updated`,
      headers: { cookie: owner.cookies },
    });
    expect(listed.json<{ entries: { device: unknown }[] }>().entries[0]?.device).toEqual({
      browser: 'Safari',
      os: 'iOS',
    });
  });

  it('never gives one request the other request’s device', async () => {
    const [first, second] = await Promise.allSettled([
      createCategory('Auditctx Masks', FIREFOX_ON_LINUX),
      createCategory('Auditctx Gowns', SAFARI_ON_IOS),
    ]);
    expect(first.status).toBe('fulfilled');
    expect(second.status).toBe('fulfilled');
    const ids = [first, second].map((result) =>
      result.status === 'fulfilled' ? result.value.json<{ id: string }>().id : '',
    );

    const rows = await prisma.auditLog.findMany({
      where: { action: 'category.created', resourceId: { in: ids } },
    });
    const byId = new Map(rows.map((row) => [row.resourceId, row.userAgent]));
    expect(byId.get(ids[0] ?? '')).toBe(FIREFOX_ON_LINUX);
    expect(byId.get(ids[1] ?? '')).toBe(SAFARI_ON_IOS);
  });
});

describe('audit rows written outside a request', () => {
  it('a worker or script write records no address and no device', async () => {
    const resourceId = newId();
    await recordAudit({
      action: PROBE as never,
      resourceType: RESOURCE,
      resourceId,
      actorType: 'SYSTEM',
    });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { resourceId } });
    expect(row.ipAddress).toBeNull();
    expect(row.userAgent).toBeNull();
  });

  it('a value the caller passes wins over the request context', async () => {
    const resourceId = newId();
    await runWithRequestContext({ ipAddress: '192.0.2.1', userAgent: FIREFOX_ON_LINUX }, () =>
      recordAudit({
        action: PROBE as never,
        resourceType: RESOURCE,
        resourceId,
        actorType: 'ADMIN',
        actorUserId: ownerId,
        ipAddress: '203.0.113.9',
        userAgent: SAFARI_ON_IOS,
      }),
    );
    const row = await prisma.auditLog.findFirstOrThrow({ where: { resourceId } });
    expect(row.ipAddress).toBe('203.0.113.9');
    expect(row.userAgent).toBe(SAFARI_ON_IOS);

    // And where the caller passes nothing, the context fills the gap.
    const filledId = newId();
    await runWithRequestContext({ ipAddress: '192.0.2.1', userAgent: FIREFOX_ON_LINUX }, () =>
      recordAudit({ action: PROBE as never, resourceType: RESOURCE, resourceId: filledId, actorType: 'SYSTEM' }),
    );
    const filled = await prisma.auditLog.findFirstOrThrow({ where: { resourceId: filledId } });
    expect(filled).toMatchObject({ ipAddress: '192.0.2.1', userAgent: FIREFOX_ON_LINUX });
  });
});
