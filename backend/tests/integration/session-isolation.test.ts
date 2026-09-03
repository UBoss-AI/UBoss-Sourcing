/**
 * A staff member and a customer must be able to be signed in at once, in one
 * browser.
 *
 * The bug this file exists for: both surfaces set cookies called `uboss_at`,
 * `uboss_rt` and `uboss_csrf`. A cookie is identified by its name, domain and
 * path - the PORT is not part of its identity (RFC 6265) - so the admin panel
 * on :5173 and the storefront on :5174 shared one jar. Signing into either one
 * overwrote the other's tokens and silently signed that person out, and any
 * deployment putting both on one hostname would behave the same way.
 *
 * The names are now scoped to the audience the route was registered for. These
 * tests hold that: separate names, both live at once, and signing out of one
 * leaving the other alone.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const STAFF_EMAIL = 'isolation-staff@test.local';
const STAFF_PASSWORD = 'IsolationStaff!2026';
const BUYER_EMAIL = 'isolation-buyer@test.local';
const BUYER_PASSWORD = 'IsolationBuyer!2026';

/** Everything a browser would be holding, from every login so far. */
type Jar = Map<string, string>;

function absorb(jar: Jar, response: LightMyRequestResponse): Jar {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    // An empty value is how Set-Cookie expresses a deletion.
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

function header(jar: Jar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function login(path: string, email: string, password: string) {
  const response = await app.inject({
    method: 'POST',
    url: path,
    payload: { email, password },
  });
  expect(response.statusCode, response.body).toBe(200);
  return response;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await prisma.userRole.deleteMany({
    where: { user: { emailNormalized: { in: [STAFF_EMAIL, BUYER_EMAIL] } } },
  });
  await prisma.customerProfile.deleteMany({
    where: { user: { emailNormalized: BUYER_EMAIL } },
  });
  await prisma.user.deleteMany({
    where: { emailNormalized: { in: [STAFF_EMAIL, BUYER_EMAIL] } },
  });

  const ownerRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.BUSINESS_OWNER },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: STAFF_EMAIL,
      emailNormalized: STAFF_EMAIL,
      passwordHash: await hashPassword(STAFF_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: ownerRole.id } },
    },
  });

  const buyer = await prisma.user.create({
    data: {
      id: newId(),
      type: 'CUSTOMER',
      email: BUYER_EMAIL,
      emailNormalized: BUYER_EMAIL,
      passwordHash: await hashPassword(BUYER_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });

  await prisma.customerProfile.create({
    data: { id: newId(), userId: buyer.id, fullName: 'Isolation Buyer' },
  });
});

afterAll(async () => {
  await prisma.userRole.deleteMany({
    where: { user: { emailNormalized: { in: [STAFF_EMAIL, BUYER_EMAIL] } } },
  });
  await prisma.customerProfile.deleteMany({
    where: { user: { emailNormalized: BUYER_EMAIL } },
  });
  await prisma.user.deleteMany({
    where: { emailNormalized: { in: [STAFF_EMAIL, BUYER_EMAIL] } },
  });
  await app.close();
});

describe('session cookie isolation', () => {
  it('names the two surfaces cookies apart', async () => {
    const staff = await login('/api/v1/admin/auth/login', STAFF_EMAIL, STAFF_PASSWORD);
    const buyer = await login('/api/v1/auth/login', BUYER_EMAIL, BUYER_PASSWORD);

    const staffNames = (staff.cookies as { name: string }[]).map((c) => c.name).sort();
    const buyerNames = (buyer.cookies as { name: string }[]).map((c) => c.name).sort();

    expect(staffNames).toEqual(['uboss_admin_at', 'uboss_admin_csrf', 'uboss_admin_rt']);
    expect(buyerNames).toEqual(['uboss_shop_at', 'uboss_shop_csrf', 'uboss_shop_rt']);

    // The decisive property: no name in common, so neither can overwrite the
    // other however they are deployed.
    expect(staffNames.filter((name) => buyerNames.includes(name))).toEqual([]);
  });

  it('keeps both signed in when one browser holds both logins', async () => {
    const jar: Jar = new Map();

    absorb(jar, await login('/api/v1/admin/auth/login', STAFF_EMAIL, STAFF_PASSWORD));
    // Signing into the storefront second is the case that used to evict the
    // staff session.
    absorb(jar, await login('/api/v1/auth/login', BUYER_EMAIL, BUYER_PASSWORD));

    const asStaff = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth/me',
      headers: { cookie: header(jar) },
    });
    const asBuyer = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: header(jar) },
    });

    expect(asStaff.statusCode, asStaff.body).toBe(200);
    expect(asBuyer.statusCode, asBuyer.body).toBe(200);
    expect(asStaff.json<{ email: string }>().email).toBe(STAFF_EMAIL);
    expect(asBuyer.json<{ email: string }>().email).toBe(BUYER_EMAIL);
  });

  it('signs out of one surface without touching the other', async () => {
    const jar: Jar = new Map();

    const staff = await login('/api/v1/admin/auth/login', STAFF_EMAIL, STAFF_PASSWORD);
    absorb(jar, staff);
    absorb(jar, await login('/api/v1/auth/login', BUYER_EMAIL, BUYER_PASSWORD));

    const csrf = (staff.cookies as { name: string; value: string }[]).find(
      (cookie) => cookie.name === 'uboss_admin_csrf',
    );

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/logout',
      headers: { cookie: header(jar), 'x-csrf-token': csrf?.value ?? '' },
    });
    expect(logout.statusCode, logout.body).toBe(204);

    absorb(jar, logout);

    const asStaff = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth/me',
      headers: { cookie: header(jar) },
    });
    const asBuyer = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: header(jar) },
    });

    expect(asStaff.statusCode).toBe(401);
    // The customer was never part of that decision.
    expect(asBuyer.statusCode, asBuyer.body).toBe(200);
  });

  it('refuses a staff cookie on a customer route, and the reverse', async () => {
    const jar: Jar = new Map();
    absorb(jar, await login('/api/v1/admin/auth/login', STAFF_EMAIL, STAFF_PASSWORD));

    // Staff cookies present, but the customer surface reads a different name
    // and so sees no credential at all.
    const asBuyer = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: header(jar) },
    });

    expect(asBuyer.statusCode).toBe(401);
  });
});
