/**
 * The audit log screen and its CSV export.
 *
 * What this file holds the routes to:
 *
 *   - Reading returns who acted, the role they held WHEN they acted (recorded
 *     on the row at write time, not joined from today's grants), the reason
 *     where the entry states one, the address, and the device - the full
 *     User-Agent plus a summary of it.
 *   - Every filter the screen sends is honoured - including the actor email,
 *     which the panel sent for months and the route silently dropped.
 *   - Reading needs audit.read. Exporting needs audit.read AND export.create.
 *     Anonymous callers and customer sessions get neither.
 *   - The export holds the same fields as the screen, is capped, and is itself
 *     on the trail before the file is produced.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  AUDIT_CSV_HEADER,
  AUDIT_EXPORT_MAX_ROWS,
  exportAuditEntries,
  summariseUserAgent,
} from '../../src/modules/audit/audit-log.read.js';
import { recordAudit } from '../../src/modules/audit/audit.service.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'AuditTrailScreen!2026';
const OWNER_EMAIL = 'auditlog-owner@test.local';
const FINANCE_EMAIL = 'auditlog-finance@test.local';
const CATALOG_EMAIL = 'auditlog-catalog@test.local';
const ORDERS_EMAIL = 'auditlog-orders@test.local';
const CUSTOMER_EMAIL = 'auditlog-customer@test.local';
const EMAILS = [OWNER_EMAIL, FINANCE_EMAIL, CATALOG_EMAIL, ORDERS_EMAIL, CUSTOMER_EMAIL];

/** Every row this file writes carries one of these, so clean-up is exact. */
const PROBE = 'auditlog_probe.changed';
const LEGACY = 'auditlog_probe.legacy';
const RESOURCE = 'auditlog_probe';
const IP = '203.0.113.71';

const CHROME_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

const userIds: Record<string, string> = {};

type Jar = Map<string, string>;

function absorb(jar: Jar, response: LightMyRequestResponse): Jar {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

async function makeUser(email: string, type: 'ADMIN' | 'CUSTOMER', role: string): Promise<string> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  const id = newId();
  await prisma.user.create({
    data: {
      id,
      type,
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.userRole.create({ data: { userId: id, roleId: roleRow.id } });
  if (type === 'CUSTOMER') {
    await prisma.customerProfile.create({ data: { id: newId(), userId: id, fullName: 'Audit Customer' } });
  }
  userIds[email] = id;
  return id;
}

async function cleanUp(): Promise<void> {
  await prisma.auditLog.deleteMany({
    where: {
      OR: [
        { resourceType: RESOURCE },
        { action: 'audit.exported', actorEmail: { in: EMAILS } },
      ],
    },
  });
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.customerProfile.deleteMany({ where: { user: { emailNormalized: { in: EMAILS } } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

const headersOf = (session: AdminSession, extra: Record<string, string> = {}) => ({
  cookie: session.cookies,
  'x-csrf-token': session.csrfToken,
  'x-forwarded-for': IP,
  ...extra,
});

function list(session: AdminSession | null, query: string) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/admin/audit-logs?${query}`,
    headers: session === null ? {} : headersOf(session),
  });
}

function exportCsv(session: AdminSession | null, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/audit-logs/export',
    headers: session === null ? {} : headersOf(session, { 'user-agent': CHROME_ON_WINDOWS }),
    payload: body,
  });
}

interface EntryView {
  id: string;
  action: string;
  actorEmail: string | null;
  actorRoles: string[] | null;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  device: { browser: string | null; os: string | null } | null;
  before: unknown;
  after: unknown;
}

let owner: AdminSession;
let finance: AdminSession;
let catalog: AdminSession;
let orders: AdminSession;

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();

  await makeUser(OWNER_EMAIL, 'ADMIN', Role.BUSINESS_OWNER);
  // audit.read + export.create.
  await makeUser(FINANCE_EMAIL, 'ADMIN', Role.FINANCE_APPROVER);
  // Neither.
  await makeUser(CATALOG_EMAIL, 'ADMIN', Role.CATALOG_MANAGER);
  // export.create without audit.read.
  await makeUser(ORDERS_EMAIL, 'ADMIN', Role.ORDER_MANAGER);
  await makeUser(CUSTOMER_EMAIL, 'CUSTOMER', Role.CUSTOMER);

  const ip = '198.51.100.71';
  owner = await signInAdmin(app, { email: OWNER_EMAIL, password: PASSWORD, ip });
  finance = await signInAdmin(app, { email: FINANCE_EMAIL, password: PASSWORD, ip });
  catalog = await signInAdmin(app, { email: CATALOG_EMAIL, password: PASSWORD, ip });
  orders = await signInAdmin(app, { email: ORDERS_EMAIL, password: PASSWORD, ip });

  // Written the way every service writes: through recordAudit, which looks
  // the actor's role up itself.
  await recordAudit({
    action: PROBE as never,
    resourceType: RESOURCE,
    resourceId: newId(),
    actorType: 'ADMIN',
    actorUserId: userIds[FINANCE_EMAIL],
    actorEmail: FINANCE_EMAIL,
    before: { status: 'ACTIVE' },
    after: { status: 'SUSPENDED', reason: 'Chargeback pattern', apiKey: 'sk_live_should_not_leak' },
    ipAddress: IP,
    userAgent: CHROME_ON_WINDOWS,
    correlationId: 'corr-auditlog-1',
  });
  await recordAudit({
    action: PROBE as never,
    resourceType: RESOURCE,
    actorType: 'ADMIN',
    actorUserId: userIds[OWNER_EMAIL],
    actorEmail: OWNER_EMAIL,
    after: { reasonCode: 'DUPLICATE' },
  });

  // A row from before roles were recorded: no role, no device. Must say so,
  // never borrow today's role.
  await prisma.auditLog.create({
    data: {
      id: newId(),
      action: LEGACY,
      resourceType: RESOURCE,
      actorType: 'ADMIN',
      actorUserId: userIds[FINANCE_EMAIL] ?? null,
      actorEmail: FINANCE_EMAIL,
      afterJson: { status: 'ARCHIVED' },
    },
  });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('GET /admin/audit-logs', () => {
  it('returns the role at the time, the reason, the address and the device', async () => {
    const response = await list(finance, `resourceType=${RESOURCE}&action=${PROBE}&actorEmail=${FINANCE_EMAIL}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');

    const body = response.json<{ entries: EntryView[]; pagination: { total: number } }>();
    expect(body.pagination.total).toBe(1);
    const [entry] = body.entries;
    expect(entry).toMatchObject({
      action: PROBE,
      actorEmail: FINANCE_EMAIL,
      actorRoles: [Role.FINANCE_APPROVER],
      reason: 'Chargeback pattern',
      ipAddress: IP,
      userAgent: CHROME_ON_WINDOWS,
      device: { browser: 'Chrome', os: 'Windows' },
      before: { status: 'ACTIVE' },
    });
    // Redacted on write, and still redacted on read.
    expect(response.body).not.toContain('sk_live_should_not_leak');
    expect((entry?.after as Record<string, unknown>).apiKey).toBe('[REDACTED]');
  });

  it('keeps the role recorded then, even after the person is given another', async () => {
    const promoted = await prisma.role.findUniqueOrThrow({ where: { key: Role.BUSINESS_OWNER } });
    await prisma.userRole.create({ data: { userId: userIds[FINANCE_EMAIL] ?? '', roleId: promoted.id } });
    try {
      const response = await list(owner, `action=${PROBE}&actorEmail=${FINANCE_EMAIL}`);
      expect(response.json<{ entries: EntryView[] }>().entries[0]?.actorRoles).toEqual([
        Role.FINANCE_APPROVER,
      ]);
    } finally {
      await prisma.userRole.delete({
        where: { userId_roleId: { userId: userIds[FINANCE_EMAIL] ?? '', roleId: promoted.id } },
      });
    }
  });

  it('says no role and no device for an entry that never recorded them', async () => {
    const response = await list(owner, `action=${LEGACY}`);
    const [entry] = response.json<{ entries: EntryView[] }>().entries;
    expect(entry).toMatchObject({ actorRoles: null, device: null, userAgent: null, reason: null });
  });

  it('reads a reason recorded as a code', async () => {
    const response = await list(owner, `action=${PROBE}&actorEmail=${OWNER_EMAIL}`);
    const [entry] = response.json<{ entries: EntryView[] }>().entries;
    expect(entry).toMatchObject({ reason: 'DUPLICATE', actorRoles: [Role.BUSINESS_OWNER] });
  });

  it('filters by resource type, action, actor and date range', async () => {
    const all = await list(owner, `resourceType=${RESOURCE}&limit=100`);
    expect(all.json<{ pagination: { total: number } }>().pagination.total).toBe(3);

    const byActor = await list(owner, `resourceType=${RESOURCE}&actorUserId=${userIds[OWNER_EMAIL] ?? ''}`);
    expect(byActor.json<{ entries: EntryView[] }>().entries.map((entry) => entry.actorEmail)).toEqual([
      OWNER_EMAIL,
    ]);

    const future = new Date(Date.now() + 86_400_000).toISOString();
    const none = await list(owner, `resourceType=${RESOURCE}&from=${encodeURIComponent(future)}`);
    expect(none.json<{ pagination: { total: number } }>().pagination.total).toBe(0);
  });

  it('refuses anonymous callers, customer sessions and staff without audit.read', async () => {
    expect((await list(null, 'limit=1')).statusCode).toBe(401);

    const customerLogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: CUSTOMER_EMAIL, password: PASSWORD },
    });
    expect(customerLogin.statusCode, customerLogin.body).toBe(200);
    const jar = absorb(new Map(), customerLogin);
    const asCustomer = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/audit-logs?limit=1',
      headers: { cookie: [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ') },
    });
    expect(asCustomer.statusCode).toBe(401);

    const asCatalog = await list(catalog, 'limit=1');
    expect(asCatalog.statusCode).toBe(403);
    expect(asCatalog.json<{ error: { code: string } }>().error.code).toBe('PERMISSION_DENIED');
  });
});

function parseCsv(text: string): string[][] {
  // Enough of RFC 4180 for these fixtures: quoted cells with "" escapes.
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\r' && text[index + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      index += 1;
    } else cell += char;
  }
  return rows;
}

describe('POST /admin/audit-logs/export', () => {
  it('downloads the filtered entries with the same fields the screen shows', async () => {
    const response = await exportCsv(finance, { resourceType: RESOURCE });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['x-audit-export-rows']).toBe('3');
    expect(response.headers['x-audit-export-total']).toBe('3');

    const [header, ...rows] = parseCsv(response.body);
    expect(header).toEqual([...AUDIT_CSV_HEADER]);
    expect(rows).toHaveLength(3);

    const column = (name: (typeof AUDIT_CSV_HEADER)[number]) => AUDIT_CSV_HEADER.indexOf(name);
    const probe = rows.find((row) => row[column('reason')] === 'Chargeback pattern');
    expect(probe?.[column('actorEmail')]).toBe(FINANCE_EMAIL);
    expect(probe?.[column('actorRoles')]).toBe(Role.FINANCE_APPROVER);
    expect(probe?.[column('ipAddress')]).toBe(IP);
    expect(probe?.[column('device')]).toBe('Chrome on Windows');
    expect(probe?.[column('userAgent')]).toBe(CHROME_ON_WINDOWS);
    expect(JSON.parse(probe?.[column('before')] ?? 'null')).toEqual({ status: 'ACTIVE' });
    // The screen shows [REDACTED]; so does the file.
    expect(response.body).not.toContain('sk_live_should_not_leak');
    expect(response.body).toContain('[REDACTED]');
  });

  it('is itself on the trail, with the filter, the count, the role and the device', async () => {
    await exportCsv(finance, { resourceType: RESOURCE, action: PROBE });

    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'audit.exported', actorEmail: FINANCE_EMAIL },
      orderBy: { createdAt: 'desc' },
    });
    expect(entry).toMatchObject({
      resourceType: 'audit_log',
      actorType: 'ADMIN',
      actorRoles: Role.FINANCE_APPROVER,
      userAgent: CHROME_ON_WINDOWS,
    });
    expect(entry.afterJson).toMatchObject({
      filter: { resourceType: RESOURCE, action: PROBE },
      rowCount: 2,
      matched: 2,
      truncated: false,
      maxRows: AUDIT_EXPORT_MAX_ROWS,
    });

    // And the next export of the whole trail can find it.
    const listed = await list(owner, `action=audit.exported&actorEmail=${FINANCE_EMAIL}`);
    expect(listed.json<{ pagination: { total: number } }>().pagination.total).toBeGreaterThanOrEqual(1);
  });

  it('stops at the row cap and says how many matched', async () => {
    const file = await exportAuditEntries(
      { resourceType: RESOURCE },
      { userId: userIds[OWNER_EMAIL] ?? '', email: OWNER_EMAIL, ipAddress: IP, userAgent: null, correlationId: null },
      { maxRows: 2 },
    );
    expect(file.total).toBe(3);
    expect(file.rowCount).toBe(2);

    let text = '';
    for await (const chunk of file.stream) text += String(chunk);
    // Header plus two rows, newest first.
    expect(parseCsv(text)).toHaveLength(3);

    const recorded = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'audit.exported', actorEmail: OWNER_EMAIL },
      orderBy: { createdAt: 'desc' },
    });
    expect(recorded.afterJson).toMatchObject({ rowCount: 2, matched: 3, truncated: true, maxRows: 2 });
  });

  it('never raises the cap above the published maximum', async () => {
    const file = await exportAuditEntries(
      { resourceType: RESOURCE },
      { userId: userIds[OWNER_EMAIL] ?? '', email: OWNER_EMAIL, ipAddress: null, userAgent: null, correlationId: null },
      { maxRows: AUDIT_EXPORT_MAX_ROWS * 10 },
    );
    file.stream.destroy();
    const recorded = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'audit.exported', actorEmail: OWNER_EMAIL },
      orderBy: { createdAt: 'desc' },
    });
    expect(recorded.afterJson).toMatchObject({ maxRows: AUDIT_EXPORT_MAX_ROWS });
  });

  it('needs audit.read and export.create, and refuses anonymous and customer callers', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'audit.exported' } });

    // Order Manager: export.create, but not audit.read.
    const asOrders = await exportCsv(orders, { resourceType: RESOURCE });
    expect(asOrders.statusCode).toBe(403);
    expect(asOrders.json<{ error: { code: string } }>().error.code).toBe('PERMISSION_DENIED');

    // Catalog Manager: neither.
    expect((await exportCsv(catalog, { resourceType: RESOURCE })).statusCode).toBe(403);
    expect((await exportCsv(null, { resourceType: RESOURCE })).statusCode).toBe(401);

    // A refused export leaves no claim on the trail that it happened.
    expect(await prisma.auditLog.count({ where: { action: 'audit.exported' } })).toBe(before);
  });

  it('refuses a write without the CSRF token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/audit-logs/export',
      headers: { cookie: owner.cookies },
      payload: {},
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('summariseUserAgent', () => {
  it('names the common browsers and systems, and admits when it cannot', () => {
    expect(summariseUserAgent(CHROME_ON_WINDOWS)).toEqual({ browser: 'Chrome', os: 'Windows' });
    expect(
      summariseUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
      ),
    ).toEqual({ browser: 'Safari', os: 'macOS' });
    expect(
      summariseUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36 Edg/129.0',
      ),
    ).toEqual({ browser: 'Edge', os: 'Windows' });
    expect(summariseUserAgent('Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0')).toEqual({
      browser: 'Firefox',
      os: 'Android',
    });
    expect(summariseUserAgent('curl/8.4.0')).toEqual({ browser: 'curl', os: null });
    expect(summariseUserAgent('something-unheard-of')).toEqual({ browser: null, os: null });
    expect(summariseUserAgent(null)).toBeNull();
    expect(summariseUserAgent('  ')).toBeNull();
  });
});
