/** Legal documents must enforce read/write/publish permissions at the HTTP boundary. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { legalContentHash } from '../../src/domain/legal-document.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

const run = newId();
const password = 'LegalHttpFixture!2026';
const userIds: string[] = [];
const documentIds: string[] = [];
let app: Awaited<ReturnType<typeof buildApp>>;
type Jar = Map<string, string>;
let owner: Jar;
let reader: Jar;
let customer: Jar;

function absorb(jar: Jar, response: LightMyRequestResponse): Jar {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

function headers(jar: Jar, csrf = true): Record<string, string> {
  return {
    cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
    ...(csrf ? { 'x-csrf-token': jar.get('uboss_admin_csrf') ?? jar.get('uboss_csrf') ?? '' } : {}),
  };
}

async function person(type: 'ADMIN' | 'CUSTOMER', role?: string): Promise<Jar> {
  const id = newId();
  const email = `legal-http-${id}@test.local`;
  userIds.push(id);
  await prisma.user.create({ data: {
    id, type, email, emailNormalized: email, status: 'ACTIVE',
    passwordHash: await hashPassword(password), emailVerifiedAt: new Date(),
  } });
  if (role !== undefined) {
    const assigned = await prisma.role.findUniqueOrThrow({ where: { key: role } });
    await prisma.userRole.create({ data: { userId: id, roleId: assigned.id } });
  } else {
    await prisma.customerProfile.create({ data: { id: newId(), userId: id, fullName: 'Legal test buyer' } });
  }
  const login = await app.inject({
    method: 'POST', url: `/api/v1/${type === 'ADMIN' ? 'admin/' : ''}auth/login`,
    payload: { email, password },
  });
  expect(login.statusCode, login.body).toBe(200);
  const jar = absorb(new Map(), login);
  if (type === 'ADMIN') {
    const located = await app.inject({
      method: 'POST', url: '/api/v1/admin/auth/session/location', headers: headers(jar),
      payload: { latitude: 51.2194, longitude: 4.4025, accuracyM: 42 },
    });
    expect(located.statusCode, located.body).toBe(200);
    absorb(jar, located);
  }
  return jar;
}

const body = () => ({
  kind: 'RETURNS_POLICY', version: newId(), locale: 'en', title: `HTTP fixture ${run}`,
  body: 'Test-only policy text. Not approved legal wording.', effectiveAt: new Date().toISOString(),
});

async function draft(): Promise<string> {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/admin/legal-documents', headers: headers(owner), payload: body(),
  });
  expect(response.statusCode, response.body).toBe(201);
  const id = response.json<{ id: string }>().id;
  documentIds.push(id);
  return id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  owner = await person('ADMIN', Role.BUSINESS_OWNER);
  reader = await person('ADMIN', Role.CATALOG_MANAGER);
  customer = await person('CUSTOMER');
});

afterAll(async () => {
  // No fixture document is accepted; remove newest first for supersedes references.
  for (const id of [...documentIds].reverse()) await prisma.legalDocument.deleteMany({ where: { id } });
  await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app?.close();
});

describe('legal document HTTP permissions', () => {
  it('refuses anonymous, customer and staff without legal permissions on every admin route', async () => {
    const id = await draft();
    for (const jar of [null, customer, reader]) {
      for (const request of [
        { method: 'GET' as const, url: '/api/v1/admin/legal-documents' },
        { method: 'GET' as const, url: `/api/v1/admin/legal-documents/${id}` },
        { method: 'POST' as const, url: '/api/v1/admin/legal-documents', payload: body() },
        { method: 'PUT' as const, url: `/api/v1/admin/legal-documents/${id}`, payload: body() },
        { method: 'DELETE' as const, url: `/api/v1/admin/legal-documents/${id}` },
        { method: 'POST' as const, url: `/api/v1/admin/legal-documents/${id}/publish` },
      ]) {
        const response = await app.inject({ ...request, headers: jar === null ? {} : headers(jar) });
        expect([401, 403], `${request.method} ${request.url}: ${response.body}`).toContain(response.statusCode);
      }
    }
    expect(await prisma.legalDocument.findUnique({ where: { id } })).toMatchObject({ status: 'DRAFT' });
    expect(await prisma.legalDocument.count({ where: { title: `HTTP fixture ${run}` } })).toBe(1);
  });

  it('requires CSRF even for the business owner', async () => {
    const id = await draft();
    const response = await app.inject({
      method: 'POST', url: `/api/v1/admin/legal-documents/${id}/publish`, headers: headers(owner, false),
    });
    expect(response.statusCode).toBe(403);
    expect(await prisma.legalDocument.findUnique({ where: { id } })).toMatchObject({ status: 'DRAFT' });
  });

  it('never serves a draft through either public download route', async () => {
    const id = await draft();
    for (const suffix of ['', '/pdf']) {
      const response = await app.inject({ method: 'GET', url: `/api/v1/legal/documents/${id}${suffix}` });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.body).not.toContain('Test-only policy text');
    }
    const invalid = await app.inject({ method: 'GET', url: '/api/v1/legal/documents/invalid' });
    expect(invalid.statusCode).toBe(400);
  });

  it('publishes once under concurrent requests, preserves the hash and audits only the winner', async () => {
    const id = await draft();
    const publish = () => app.inject({
      method: 'POST', url: `/api/v1/admin/legal-documents/${id}/publish`, headers: headers(owner),
    });
    const responses = await Promise.all([publish(), publish()]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 409]);
    const stored = await prisma.legalDocument.findUniqueOrThrow({ where: { id } });
    expect(stored.contentSha256).toBe(legalContentHash(stored));
    expect(await prisma.auditLog.count({ where: { resourceId: id, action: 'legal_document.published' } })).toBe(1);
    const edit = await app.inject({ method: 'PUT', url: `/api/v1/admin/legal-documents/${id}`, headers: headers(owner), payload: body() });
    const remove = await app.inject({ method: 'DELETE', url: `/api/v1/admin/legal-documents/${id}`, headers: headers(owner) });
    expect(edit.statusCode).toBe(409);
    expect(remove.statusCode).toBe(409);
    const publicRead = await app.inject({ method: 'GET', url: `/api/v1/legal/documents/${id}` });
    expect(publicRead.statusCode).toBe(200);
    expect(publicRead.json()).toMatchObject({ contentSha256: stored.contentSha256, body: stored.body });
  });
});
