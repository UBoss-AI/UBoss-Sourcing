/**
 * The Commission Invoices routes, over HTTP, as the console calls them: who may
 * reach them, and that the server - not the panel - is what refuses.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { signInAdmin, type AdminSession } from '../support/admin-session.js';

let app: Awaited<ReturnType<typeof buildApp>>;
let finance: AdminSession;
let catalog: AdminSession;

const FINANCE_EMAIL = 'cinv-http-finance@test.local';
const CATALOG_EMAIL = 'cinv-http-catalog@test.local';
const PASSWORD = 'CommissionHttp!2026';

async function staff(email: string, role: string): Promise<void> {
  const roleRow = await prisma.role.findUniqueOrThrow({ where: { key: role }, select: { id: true } });
  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email,
      emailNormalized: email,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: roleRow.id } },
    },
  });
}

async function cleanUp(): Promise<void> {
  const emails = [FINANCE_EMAIL, CATALOG_EMAIL];
  await prisma.session.deleteMany({ where: { user: { emailNormalized: { in: emails } } } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: { in: emails } } } });
  await prisma.auditLog.deleteMany({ where: { actorEmail: { in: emails } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: emails } } });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  await cleanUp();
  await staff(FINANCE_EMAIL, Role.FINANCE_APPROVER);
  await staff(CATALOG_EMAIL, Role.CATALOG_MANAGER);
  finance = await signInAdmin(app, { email: FINANCE_EMAIL, password: PASSWORD, ip: '203.0.113.141' });
  catalog = await signInAdmin(app, { email: CATALOG_EMAIL, password: PASSWORD, ip: '203.0.113.142' });
});

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('Commission Invoices over HTTP', () => {
  it('lets finance read the list, paginated', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/admin/commission-invoices?page=1&pageSize=5', headers: { cookie: finance.cookies } });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<{ page: number; pageSize: number; total: number; items: unknown[] }>();
    expect(body).toMatchObject({ page: 1, pageSize: 5 });
    expect(body.items.length).toBeLessThanOrEqual(5);
  });

  it('refuses a member of staff without the permission, and anybody signed out', async () => {
    const forbidden = await app.inject({ method: 'GET', url: '/api/v1/admin/commission-invoices', headers: { cookie: catalog.cookies } });
    expect(forbidden.statusCode).toBe(403);
    const generate = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/seller-orders/${newId()}/commission-invoice`,
      headers: { cookie: catalog.cookies, 'x-csrf-token': catalog.csrfToken, 'idempotency-key': 'cinv-http-0001' },
    });
    expect(generate.statusCode).toBe(403);
    const signedOut = await app.inject({ method: 'GET', url: '/api/v1/admin/commission-invoices' });
    expect(signedOut.statusCode).toBe(401);
    const download = await app.inject({ method: 'GET', url: `/api/v1/admin/commission-invoices/documents/${newId()}/download?token=${'x'.repeat(40)}` });
    expect(download.statusCode).toBe(401);
  });

  it('insists on the CSRF token and an Idempotency-Key for a write', async () => {
    const noCsrf = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/seller-orders/${newId()}/commission-invoice`,
      headers: { cookie: finance.cookies, 'idempotency-key': 'cinv-http-0002' },
    });
    expect(noCsrf.statusCode).toBe(403);
    const noKey = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/seller-orders/${newId()}/commission-invoice`,
      headers: { cookie: finance.cookies, 'x-csrf-token': finance.csrfToken },
    });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json<{ error: { code: string } }>().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  });

  it('rejects client-supplied figures on a credit note', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/commission-invoices/${newId()}/credit-notes`,
      headers: { cookie: finance.cookies, 'x-csrf-token': finance.csrfToken, 'idempotency-key': 'cinv-http-0003' },
      payload: { reason: 'FULL_REFUND', basis: 'FULL', grandTotalMinor: '1' },
    });
    expect(response.statusCode).toBe(400);
  });
});
