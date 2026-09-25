/**
 * The Seller Hub's idle session, over HTTP with real cookies.
 *
 * What is proven:
 *
 *   - the open Hub survives a refresh-token rotation (it used to re-lock on
 *     every rotation, which is what "the Seller Hub keeps logging me out" was);
 *   - it re-locks on the SERVER after SELLER_HUB_IDLE_TIMEOUT_SECONDS without
 *     deliberate activity, with its own error code, and the shop session is
 *     untouched;
 *   - a background GET does not keep it open; a change, or a GET marked as a
 *     person's own, does;
 *   - "Stay signed in" renews it, needs CSRF, and cannot revive a Hub that has
 *     already re-locked;
 *   - closing the Hub and signing out end it immediately;
 *   - the deployment's other session settings are what they were.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const EMAIL = 'owner@hub-idle-seller.test';
const SLUG = 'hub-idle-seller';
const SHOP_PASSWORD = 'ShopPassword!2026';
const HUB_PASSWORD = 'HubPassword!2026';
const IP = '10.62.0.1';

let userId = '';

interface Browser {
  jar: Map<string, string>;
}

function cookieHeader(browser: Browser): string {
  return [...browser.jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function csrf(browser: Browser): string {
  return [...browser.jar].find(([name]) => name.includes('csrf'))?.[1] ?? '';
}

function absorb(browser: Browser, response: { cookies: { name: string; value: string }[] }): void {
  for (const cookie of response.cookies) {
    if (cookie.value === '') browser.jar.delete(cookie.name);
    else browser.jar.set(cookie.name, cookie.value);
  }
}

async function send(
  browser: Browser,
  method: 'GET' | 'POST',
  url: string,
  options: { payload?: unknown; activity?: boolean; noCsrf?: boolean } = {},
) {
  const response = await app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(browser),
      'x-forwarded-for': IP,
      ...(options.noCsrf === true ? {} : { 'x-csrf-token': csrf(browser) }),
      ...(options.activity === true ? { 'x-seller-activity': '1' } : {}),
    },
    ...(options.payload === undefined ? {} : { payload: options.payload as Record<string, unknown> }),
  });
  absorb(browser, response);
  return response;
}

async function signIn(): Promise<Browser> {
  const browser: Browser = { jar: new Map() };
  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-forwarded-for': IP },
    payload: { email: EMAIL, password: SHOP_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  absorb(browser, login);
  const opened = await send(browser, 'POST', '/api/v1/sellers/lock/open', { payload: { password: HUB_PASSWORD } });
  expect(opened.statusCode, opened.body).toBe(200);
  return browser;
}

async function liveSession(): Promise<{ id: string; sellerLastActivityAt: Date | null; sellerUnlockedAt: Date | null }> {
  return prisma.session.findFirstOrThrow({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, sellerLastActivityAt: true, sellerUnlockedAt: true },
  });
}

/** Pretend the last deliberate activity was this long ago. */
async function idleFor(seconds: number): Promise<void> {
  const session = await liveSession();
  await prisma.session.update({
    where: { id: session.id },
    data: { sellerLastActivityAt: new Date(Date.now() - seconds * 1000) },
  });
}

async function cleanUp(): Promise<void> {
  const user = await prisma.user.findUnique({ where: { emailNormalized: EMAIL }, select: { id: true } });
  const id = user?.id ?? '';
  await prisma.auditLog.deleteMany({ where: { actorUserId: id } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.session.deleteMany({ where: { userId: id } });
  await prisma.authToken.deleteMany({ where: { userId: id } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
  await prisma.customerProfile.deleteMany({ where: { userId: id } });
  await prisma.user.deleteMany({ where: { emailNormalized: EMAIL } });
}

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();

  userId = newId();
  await prisma.user.create({
    data: {
      id: userId,
      type: 'CUSTOMER',
      email: EMAIL,
      emailNormalized: EMAIL,
      passwordHash: await hashPassword(SHOP_PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId, fullName: 'Hub Idle Owner' },
  });
  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      slug: SLUG,
      displayName: 'Hub Idle',
      displayNameNormalized: 'hub idle',
      legalName: 'Hub Idle Ltd',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  await prisma.sellerMember.create({
    data: {
      id: newId(),
      sellerAccountId: seller.id,
      customerProfileId: profile.id,
      role: 'OWNER',
      passwordHash: await hashPassword(HUB_PASSWORD),
      passwordSetAt: new Date(),
    },
  });
}, 60_000);

afterAll(async () => {
  await cleanUp();
  await app.close();
});

describe('Seller Hub idle session', () => {
  it('reports when the open Hub re-locks, from the server’s own settings', async () => {
    const browser = await signIn();
    const response = await send(browser, 'GET', '/api/v1/sellers/session');
    expect(response.statusCode, response.body).toBe(200);
    const { session } = response.json<{ session: { expiresAt: string; idleTimeoutSeconds: number; warningSeconds: number } }>();
    expect(session.idleTimeoutSeconds).toBe(3_600);
    expect(session.warningSeconds).toBe(300);
    const left = new Date(session.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(3_590_000);
    expect(left).toBeLessThanOrEqual(3_600_000);
    expect(response.headers['x-seller-session-expires-at']).toBe(session.expiresAt);
  });

  it('stays open across a refresh-token rotation', async () => {
    const browser = await signIn();
    const before = await liveSession();
    const refreshed = await send(browser, 'POST', '/api/v1/auth/refresh');
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    const after = await liveSession();
    expect(after.id).not.toBe(before.id);
    expect(after.sellerUnlockedAt?.getTime()).toBe(before.sellerUnlockedAt?.getTime());

    const hub = await send(browser, 'GET', '/api/v1/sellers/session');
    expect(hub.statusCode, hub.body).toBe(200);
  });

  it('is not kept open by a background request, and is by a deliberate one', async () => {
    const browser = await signIn();
    await idleFor(600);
    const before = (await liveSession()).sellerLastActivityAt?.getTime() ?? 0;

    await send(browser, 'GET', '/api/v1/sellers/session');
    expect((await liveSession()).sellerLastActivityAt?.getTime()).toBe(before);

    await send(browser, 'GET', '/api/v1/sellers/session', { activity: true });
    const touched = (await liveSession()).sellerLastActivityAt?.getTime() ?? 0;
    expect(touched).toBeGreaterThan(before + 590_000);
  });

  it('re-locks on the server after the idle limit, and leaves the shop signed in', async () => {
    const browser = await signIn();
    await idleFor(env.SELLER_HUB_IDLE_TIMEOUT_SECONDS + 1);

    const hub = await send(browser, 'GET', '/api/v1/sellers/session', { activity: true });
    expect(hub.statusCode).toBe(403);
    expect(hub.json<{ error: { code: string } }>().error.code).toBe('SELLER_SESSION_EXPIRED');

    const row = await liveSession();
    expect(row.sellerUnlockedAt).toBeNull();

    // Every later Hub request asks for the password again.
    const again = await send(browser, 'GET', '/api/v1/sellers/session');
    expect(again.json<{ error: { code: string } }>().error.code).toBe('SELLER_LOCK_REQUIRED');

    // The shop is untouched.
    const me = await send(browser, 'GET', '/api/v1/auth/me');
    expect(me.statusCode, me.body).toBe(200);

    const audit = await prisma.auditLog.findFirst({ where: { actorUserId: userId, action: 'seller.session.expired' } });
    expect(audit).not.toBeNull();
  });

  it('is kept open just short of the limit by a deliberate request', async () => {
    const browser = await signIn();
    await idleFor(env.SELLER_HUB_IDLE_TIMEOUT_SECONDS - 60);
    const hub = await send(browser, 'GET', '/api/v1/sellers/session', { activity: true });
    expect(hub.statusCode, hub.body).toBe(200);
    expect((await liveSession()).sellerUnlockedAt).not.toBeNull();
  });

  it('renews on “Stay signed in”, which needs CSRF and an open Hub', async () => {
    const browser = await signIn();
    await idleFor(env.SELLER_HUB_IDLE_TIMEOUT_SECONDS - 120);

    const forged = await send(browser, 'POST', '/api/v1/sellers/session/renew', { noCsrf: true });
    expect(forged.statusCode).toBe(403);

    const renewed = await send(browser, 'POST', '/api/v1/sellers/session/renew');
    expect(renewed.statusCode, renewed.body).toBe(200);
    const left = new Date(renewed.json<{ session: { expiresAt: string } }>().session.expiresAt).getTime() - Date.now();
    expect(left).toBeGreaterThan(3_590_000);

    await idleFor(env.SELLER_HUB_IDLE_TIMEOUT_SECONDS + 5);
    const late = await send(browser, 'POST', '/api/v1/sellers/session/renew');
    expect(late.statusCode).toBe(403);
    expect(late.json<{ error: { code: string } }>().error.code).toBe('SELLER_SESSION_EXPIRED');
  });

  it('ends at once when the Hub is closed, or the person signs out', async () => {
    const browser = await signIn();
    const closed = await send(browser, 'POST', '/api/v1/sellers/lock/close', { payload: {} });
    expect(closed.statusCode, closed.body).toBe(200);
    const hub = await send(browser, 'GET', '/api/v1/sellers/session');
    expect(hub.json<{ error: { code: string } }>().error.code).toBe('SELLER_LOCK_REQUIRED');

    const second = await signIn();
    const out = await send(second, 'POST', '/api/v1/auth/logout', { payload: {} });
    expect(out.statusCode, out.body).toBeLessThan(300);
    const after = await send(second, 'GET', '/api/v1/sellers/session');
    expect(after.statusCode).toBe(401);
  });

  it('cannot be kept alive by a disabled account, and an old refresh token cannot be replayed', async () => {
    const browser = await signIn();
    const oldRefresh = new Map(browser.jar);
    const rotated = await send(browser, 'POST', '/api/v1/auth/refresh');
    expect(rotated.statusCode, rotated.body).toBe(200);

    // The refresh token before rotation is spent: replaying it fails and ends
    // the whole family, Hub included.
    const replay = await send({ jar: oldRefresh }, 'POST', '/api/v1/auth/refresh');
    expect(replay.statusCode).toBe(401);
    expect((await send(browser, 'GET', '/api/v1/sellers/session')).statusCode).toBe(401);

    const again = await signIn();
    await prisma.user.update({ where: { id: userId }, data: { status: 'DEACTIVATED' } });
    try {
      const refused = await send(again, 'POST', '/api/v1/auth/refresh');
      expect(refused.statusCode).toBe(401);
    } finally {
      await prisma.user.update({ where: { id: userId }, data: { status: 'ACTIVE' } });
    }
  });

  it('leaves the shop, console and logistics session settings as they were', () => {
    expect(env.ACCESS_TOKEN_TTL_SECONDS).toBe(Number(process.env['ACCESS_TOKEN_TTL_SECONDS'] ?? 3_600));
    expect(env.ADMIN_ACCESS_TOKEN_TTL_SECONDS).toBe(Number(process.env['ADMIN_ACCESS_TOKEN_TTL_SECONDS'] ?? 900));
    expect(env.REFRESH_TOKEN_TTL_SECONDS).toBe(Number(process.env['REFRESH_TOKEN_TTL_SECONDS'] ?? 2_592_000));
  });
});
