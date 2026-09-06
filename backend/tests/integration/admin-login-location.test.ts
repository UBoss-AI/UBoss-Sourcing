/**
 * The sign-in location gate - integration, over HTTP.
 *
 * The claims under test:
 *   - A password alone opens nothing. A session that has not said where it is
 *     gets 403 LOCATION_REQUIRED from an admin route, and the code is distinct
 *     so the panel can tell it apart from a permission refusal.
 *   - The three routes that must stay reachable do: `/me` (or the panel cannot
 *     learn why it is blocked), `/session/location` (or nothing could ever lift
 *     the block) and `/logout` (or somebody who will not share is stuck).
 *   - Posting a position lifts it, records what was sent, and rings the bell
 *     once - for staff who may read staff records, and for nobody else.
 *   - A token refresh carries the position forward. Sessions rotate every few
 *     minutes; re-asking on each one would put the screen in front of somebody
 *     several times an hour.
 *   - Signing in again asks again. The gate is per sign-in, which is the whole
 *     point of it.
 *
 * `GEOCODE_REVERSE_URL` is empty in tests (see tests/setup.ts), so no lookup
 * leaves the machine and `place` falls back to the coordinates - itself a
 * supported deployment setting.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { Permission, Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { listAdminNotifications } from '../../src/modules/notifications/admin-notification.service.js';
import { recordSessionLocation } from '../../src/modules/identity/session-location.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const EMAIL = 'location-gate@test.local';
const PASSWORD = 'LocationGate!2026';
const IP = '203.0.113.77';

/** Somewhere in Pune. Any valid pair does; these are only ever read back. */
const LATITUDE = 18.5204;
const LONGITUDE = 73.8567;

interface Session {
  cookies: string;
  csrfToken: string;
  userId: string;
}

async function signIn(): Promise<Session> {
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email: EMAIL, password: PASSWORD },
  });

  expect(login.statusCode, login.body).toBe(200);

  const jar = login.cookies as { name: string; value: string }[];

  return {
    cookies: jar.map((cookie) => `${cookie.name}=${cookie.value}`).join('; '),
    csrfToken: jar.find((cookie) => cookie.name === 'uboss_admin_csrf')?.value ?? '',
    userId: login.json<{ user: { id: string } }>().user.id,
  };
}

function shareLocation(
  session: Session,
  payload: Record<string, unknown> = {
    latitude: LATITUDE,
    longitude: LONGITUDE,
    accuracyM: 42,
  },
) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/admin/auth/session/location',
    headers: {
      'x-forwarded-for': IP,
      cookie: session.cookies,
      'x-csrf-token': session.csrfToken,
    },
    payload,
  });
}

/** An ordinary admin route. Staff, because this account is a Business Owner. */
function readStaff(cookies: string) {
  return app.inject({
    method: 'GET',
    url: '/api/v1/admin/staff',
    headers: { cookie: cookies },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });

  const ownerRole = await prisma.role.findUniqueOrThrow({
    where: { key: Role.BUSINESS_OWNER },
    select: { id: true },
  });

  await prisma.user.create({
    data: {
      id: newId(),
      type: 'ADMIN',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      roles: { create: { roleId: ownerRole.id } },
    },
  });
});

afterAll(async () => {
  await prisma.adminNotificationRead.deleteMany({});
  await prisma.adminNotification.deleteMany({ where: { kind: 'admin.signed_in' } });
  await prisma.userRole.deleteMany({ where: { user: { emailNormalized: EMAIL } } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
  await app.close();
});

describe('an admin session that has not said where it is', () => {
  it('is refused by an admin route, with a code the panel can act on', async () => {
    const session = await signIn();

    const staff = await readStaff(session.cookies);

    expect(staff.statusCode).toBe(403);
    expect(staff.json<{ error: { code: string } }>().error.code).toBe('LOCATION_REQUIRED');
  });

  it('can still read itself, and is told what is missing', async () => {
    const session = await signIn();

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth/me',
      headers: { cookie: session.cookies },
    });

    expect(me.statusCode).toBe(200);

    const body = me.json<{ locationRequired: boolean; locationGranted: boolean }>();
    expect(body.locationRequired).toBe(true);
    expect(body.locationGranted).toBe(false);
  });

  it('can still sign out', async () => {
    const session = await signIn();

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/logout',
      headers: { cookie: session.cookies, 'x-csrf-token': session.csrfToken },
    });

    expect(logout.statusCode).toBe(204);
  });
});

describe('sharing the position', () => {
  it('lifts the block and is reported by /me', async () => {
    const session = await signIn();

    const shared = await shareLocation(session);
    expect(shared.statusCode, shared.body).toBe(200);
    // No geocoder in tests, so the place falls back to the coordinates.
    expect(shared.json<{ place: string }>().place).toBe('18.5204, 73.8567');

    expect((await readStaff(session.cookies)).statusCode).toBe(200);

    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/auth/me',
      headers: { cookie: session.cookies },
    });

    expect(me.json<{ locationGranted: boolean }>().locationGranted).toBe(true);
  });

  it('records the coordinates on the session row', async () => {
    const session = await signIn();
    await shareLocation(session);

    const row = await prisma.session.findFirstOrThrow({
      where: { userId: session.userId, revokedAt: null, locationCapturedAt: { not: null } },
      orderBy: { createdAt: 'desc' },
    });

    expect(Number(row.locationLatitude)).toBeCloseTo(LATITUDE, 6);
    expect(Number(row.locationLongitude)).toBeCloseTo(LONGITUDE, 6);
    expect(row.locationAccuracyM).toBe(42);
    // Empty GEOCODE_REVERSE_URL means no lookup was attempted.
    expect(row.locationLabel).toBeNull();
    // And with no lookup there is no country, which is what leaves the console
    // quoting the seller's own market rather than guessing at one.
    expect(row.locationCountry).toBeNull();
  });

  it('records the country a geocoder names, because the console prices for it', async () => {
    /**
     * A stub geocoder rather than a mocked `fetch`.
     *
     * What is under test is the parsing of somebody else's JSON, and a mock
     * that returns an object this file wrote proves only that this file can
     * write an object. The body below is Nominatim's shape, `country_code`
     * lower case exactly as it arrives on the wire.
     */
    const geocoder = createServer((request, response) => {
      // The address block only comes back when it is asked for, and asking is
      // the service's own job - so the request must carry it.
      expect(request.url ?? '').toContain('addressdetails=1');

      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          display_name: 'Pune, Maharashtra, India',
          address: { city: 'Pune', country: 'India', country_code: 'in' },
        }),
      );
    });

    await new Promise<void>((resolve) => geocoder.listen(0, '127.0.0.1', resolve));
    const { port } = geocoder.address() as AddressInfo;

    const previous = env.GEOCODE_REVERSE_URL;
    env.GEOCODE_REVERSE_URL = `http://127.0.0.1:${String(port)}/reverse?lat={lat}&lon={lon}`;

    try {
      // Recorded against a session made here rather than through a sign-in:
      // the login route is rate limited per address and this file is already
      // near its budget, and what is under test is the write, not the gate
      // that every other test in this file exercises.
      const user = await prisma.user.findUniqueOrThrow({
        where: { emailNormalized: EMAIL },
        select: { id: true },
      });

      const sessionId = newId();
      await prisma.session.create({
        data: {
          id: sessionId,
          userId: user.id,
          refreshTokenHash: sessionId.padEnd(64, '0'),
          familyId: newId(),
          expiresAt: new Date(Date.now() + 60_000),
        },
      });

      await recordSessionLocation({
        sessionId,
        userId: user.id,
        userEmail: EMAIL,
        latitude: LATITUDE,
        longitude: LONGITUDE,
        accuracyM: 42,
      });

      const row = await prisma.session.findUniqueOrThrow({ where: { id: sessionId } });

      expect(row.locationLabel).toBe('Pune, Maharashtra, India');
      // Upper case, which is how every other country code in this system is
      // written and how the pricing engine compares them. The console reads it
      // from `/me`: it is the market every price in the panel is quoted for,
      // and the only market it can be quoted for.
      expect(row.locationCountry).toBe('IN');
    } finally {
      env.GEOCODE_REVERSE_URL = previous;
      await new Promise<void>((resolve) => geocoder.close(() => { resolve(); }));
    }
  });

  it('rings the bell once, for staff who may read staff records', async () => {
    await prisma.adminNotification.deleteMany({ where: { kind: 'admin.signed_in' } });

    const session = await signIn();
    await shareLocation(session);
    // A retried post - a flaky network, a double click - must not ring twice.
    await shareLocation(session);

    const forOwner = await listAdminNotifications({
      userId: session.userId,
      permissions: [Permission.STAFF_READ],
    });

    const rows = forOwner.items.filter((item) => item.kind === 'admin.signed_in');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.variables.email).toBe(EMAIL);
    expect(rows[0]?.variables.place).toBe('18.5204, 73.8567');

    // Somebody who cannot read staff records cannot read a colleague's
    // whereabouts through the bell either.
    const forCatalogManager = await listAdminNotifications({
      userId: session.userId,
      permissions: [Permission.PRODUCT_READ],
    });

    expect(forCatalogManager.items.filter((item) => item.kind === 'admin.signed_in')).toEqual([]);
  });

  it('refuses coordinates that are not coordinates', async () => {
    const session = await signIn();

    const response = await shareLocation(session, { latitude: 91, longitude: 73.8567 });

    expect(response.statusCode).toBe(400);
    // Still blocked: a rejected payload must not count as an answer.
    expect((await readStaff(session.cookies)).statusCode).toBe(403);
  });
});

describe('what happens next', () => {
  it('carries the position through a token refresh', async () => {
    const session = await signIn();
    await shareLocation(session);

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/auth/refresh',
      headers: { 'x-forwarded-for': IP, cookie: session.cookies },
    });

    expect(refreshed.statusCode, refreshed.body).toBe(200);

    const rotated = (refreshed.cookies as { name: string; value: string }[])
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join('; ');

    // The rotated session is a different row. Asking again here would put the
    // location screen in front of somebody mid-task, several times an hour.
    expect((await readStaff(rotated)).statusCode).toBe(200);
  });

  it('asks again at the next sign-in', async () => {
    const first = await signIn();
    await shareLocation(first);
    expect((await readStaff(first.cookies)).statusCode).toBe(200);

    const second = await signIn();

    expect((await readStaff(second.cookies)).statusCode).toBe(403);
  });
});
