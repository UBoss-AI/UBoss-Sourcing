/**
 * Two-step sign-in, step-up, new-device alerts and the bot check for buyers and
 * sellers - over HTTP with real cookies, against a real MariaDB.
 *
 * What is proven, each for success AND failure:
 *
 *   - a buyer can enrol (QR secret + recovery codes), a wrong code is refused,
 *     a right one switches it on;
 *   - once on, every sign-in owes a code: the session can reach nothing but
 *     the challenge until it is passed; a replayed code is refused; a recovery
 *     code works once and never again; too many wrong codes lock the account;
 *   - a seller OWNER and a FINANCE_VIEWER are refused every Seller Hub route -
 *     payouts and settlements included - with MFA_SETUP_REQUIRED until they
 *     enrol, a catalogue manager is not, and a required factor cannot be
 *     switched off;
 *   - step-up: email change, payout onboarding, team-role changes, AutoPay and
 *     switching two-step off all need a recent confirmation, which expires;
 *     AutoPay needs a real factor;
 *   - a sign-in from a new device is emailed, a familiar one is not;
 *   - the bot check is enforced on sign-in, sign-up and forgotten-password when
 *     a provider is configured, and not asked for when it is off.
 *
 * The flags that tests/setup.ts switches off for unrelated suites are switched
 * back on here, and restored in afterAll.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as PaymentService from '../../src/modules/payments/payment.service.js';

// AutoPay is offered only once Stripe is connected; that is not what is under
// test here, so the availability answer is pinned to yes for this file.
vi.mock('../../src/modules/payments/payment.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof PaymentService>()),
  isCustomerAutoPayAvailable: () => Promise.resolve(true),
}));

import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { ErrorCode } from '../../src/domain/errors.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { totpCodeAt } from '../../src/infra/totp.js';
import { assertRecentStepUp } from '../../src/modules/identity/customer-mfa.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const PASSWORD = 'MfaTestPassword!2026';
const HUB_PASSWORD = 'MfaHubPassword!2026';
const DOMAIN = 'mfa-suite.test';
const SLUG = 'mfa-suite-seller';
const UA_DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const UA_OTHER = 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

const EMAILS = {
  buyer: `buyer@${DOMAIN}`,
  plain: `plain@${DOMAIN}`,
  owner: `owner@${DOMAIN}`,
  finance: `finance@${DOMAIN}`,
  catalogue: `catalogue@${DOMAIN}`,
  alerts: `alerts@${DOMAIN}`,
  captcha: `captcha@${DOMAIN}`,
} as const;

const ids: Record<keyof typeof EMAILS, string> = {
  buyer: '', plain: '', owner: '', finance: '', catalogue: '', alerts: '', captcha: '',
};
let catalogueMemberId = '';

const saved = {
  SELLER_MFA_REQUIRED: env.SELLER_MFA_REQUIRED,
  FEATURE_STEP_UP: env.FEATURE_STEP_UP,
  FEATURE_LOGIN_ALERTS: env.FEATURE_LOGIN_ALERTS,
  FEATURE_CUSTOMER_AUTOPAY: env.FEATURE_CUSTOMER_AUTOPAY,
  CAPTCHA_PROVIDER: env.CAPTCHA_PROVIDER,
  CAPTCHA_SITE_KEY: env.CAPTCHA_SITE_KEY,
  CAPTCHA_SECRET_KEY: env.CAPTCHA_SECRET_KEY,
  CAPTCHA_VERIFY_URL: env.CAPTCHA_VERIFY_URL,
};

function setEnv(values: Partial<typeof saved>): void {
  Object.assign(env as unknown as typeof saved, values);
}

// --- A browser ------------------------------------------------------------

interface Browser {
  jar: Map<string, string>;
  ua: string;
}

function cookieHeader(browser: Browser): string {
  return [...browser.jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function absorb(browser: Browser, response: { cookies: { name: string; value: string }[] }): void {
  for (const cookie of response.cookies) {
    if (cookie.value === '') browser.jar.delete(cookie.name);
    else browser.jar.set(cookie.name, cookie.value);
  }
}

async function send(
  browser: Browser,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  const response = await app.inject({
    method,
    url,
    headers: {
      cookie: cookieHeader(browser),
      'user-agent': browser.ua,
      'x-csrf-token': [...browser.jar].find(([name]) => name.includes('csrf'))?.[1] ?? '',
    },
    ...(payload === undefined ? {} : { payload }),
  });
  absorb(browser, response);
  return response;
}

async function signIn(email: string, ua = UA_DESKTOP, extra: Record<string, unknown> = {}) {
  const browser: Browser = { jar: new Map(), ua };
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'user-agent': ua },
    payload: { email, password: PASSWORD, ...extra },
  });
  absorb(browser, response);
  return { browser, response };
}

async function signedIn(email: string, ua = UA_DESKTOP): Promise<Browser> {
  const { browser, response } = await signIn(email, ua);
  expect(response.statusCode, response.body).toBe(200);
  return browser;
}

async function openHub(browser: Browser): Promise<void> {
  const opened = await send(browser, 'POST', '/api/v1/sellers/lock/open', { password: HUB_PASSWORD });
  expect(opened.statusCode, opened.body).toBe(200);
}

function codeOf(response: { json: () => unknown }): string | undefined {
  return (response.json() as { error?: { code?: string } }).error?.code;
}

async function latestSession(userId: string) {
  return prisma.session.findFirstOrThrow({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
}

/** Pretend this session's last confirmation was long ago. */
async function ageStepUp(userId: string): Promise<void> {
  const session = await latestSession(userId);
  await prisma.session.update({
    where: { id: session.id },
    data: { reauthenticatedAt: new Date(Date.now() - (env.STEP_UP_WINDOW_SECONDS + 5) * 1000) },
  });
}

/**
 * A code the server will accept now. Clears the spent counter first, which
 * stands in for "thirty seconds have passed" - only where a test is NOT about
 * replay.
 */
async function freshCode(userId: string, secret: string): Promise<string> {
  await prisma.user.update({ where: { id: userId }, data: { mfaLastCounter: null } });
  return totpCodeAt(secret, Date.now());
}

/** Enrol a factor over HTTP for a signed-in browser; returns the secret. */
async function enrol(browser: Browser, userId: string): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await send(browser, 'POST', '/api/v1/auth/mfa/setup');
  expect(setup.statusCode, setup.body).toBe(200);
  const enrolment = setup.json<{ secret: string; uri: string; recoveryCodes: string[] }>();
  const confirmed = await send(browser, 'POST', '/api/v1/auth/mfa/confirm', {
    code: await freshCode(userId, enrolment.secret),
  });
  expect(confirmed.statusCode, confirmed.body).toBe(200);
  return enrolment;
}

// --- Fixtures -------------------------------------------------------------

async function makeUser(key: keyof typeof EMAILS): Promise<string> {
  const id = newId();
  await prisma.user.create({
    data: {
      id,
      type: 'CUSTOMER',
      email: EMAILS[key],
      emailNormalized: EMAILS[key],
      passwordHash: await hashPassword(PASSWORD),
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.customerProfile.create({
    data: { id: newId(), userId: id, fullName: `MFA ${key}`, activatedAt: new Date() },
  });
  ids[key] = id;
  return id;
}

async function cleanUp(): Promise<void> {
  const users = await prisma.user.findMany({
    where: { emailNormalized: { endsWith: `@${DOMAIN}` } },
    select: { id: true },
  });
  const userIds = users.map((user) => user.id);
  const emails = Object.values(EMAILS) as string[];
  await prisma.auditLog.deleteMany({ where: { OR: [{ actorUserId: { in: userIds } }, { resourceId: { in: userIds } }] } });
  await prisma.notificationDelivery.deleteMany({ where: { outbox: { recipientEmail: { in: emails } } } });
  await prisma.jobQueue.deleteMany({ where: { jobType: 'notification.send' } });
  await prisma.notificationOutbox.deleteMany({ where: { recipientEmail: { in: emails } } });
  await prisma.sellerAuditLog.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerMember.deleteMany({ where: { sellerAccount: { slug: SLUG } } });
  await prisma.sellerAccount.deleteMany({ where: { slug: SLUG } });
  await prisma.customerAutoPaySetting.deleteMany({ where: { customerProfile: { userId: { in: userIds } } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.authToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: emails } } });
  await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

// A stand-in for the provider's siteverify: "good-token" passes, anything
// else fails, and the secret must be the configured one.
let stub: Server;
let stubUrl = '';

beforeAll(async () => {
  app = await buildApp();
  await cleanUp();
  setEnv({ SELLER_MFA_REQUIRED: true, FEATURE_STEP_UP: true, FEATURE_CUSTOMER_AUTOPAY: true });

  for (const key of Object.keys(EMAILS) as (keyof typeof EMAILS)[]) await makeUser(key);

  const seller = await prisma.sellerAccount.create({
    data: {
      id: newId(),
      slug: SLUG,
      displayName: 'MFA Suite',
      displayNameNormalized: 'mfa suite',
      legalName: 'MFA Suite Ltd',
      registrationCountry: 'IN',
      status: 'APPROVED',
    },
  });
  const roles = { owner: 'OWNER', finance: 'FINANCE_VIEWER', catalogue: 'CATALOGUE_MANAGER' } as const;
  for (const [key, role] of Object.entries(roles) as [keyof typeof roles, (typeof roles)[keyof typeof roles]][]) {
    const profile = await prisma.customerProfile.findUniqueOrThrow({ where: { userId: ids[key] } });
    const memberId = newId();
    if (key === 'catalogue') catalogueMemberId = memberId;
    await prisma.sellerMember.create({
      data: {
        id: memberId,
        sellerAccountId: seller.id,
        customerProfileId: profile.id,
        role,
        passwordHash: await hashPassword(HUB_PASSWORD),
        passwordSetAt: new Date(),
      },
    });
  }

  stub = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString();
    });
    request.on('end', () => {
      const form = new URLSearchParams(raw);
      const ok = form.get('secret') === 'suite-secret' && form.get('response') === 'good-token';
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ success: ok }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  stubUrl = `http://127.0.0.1:${String((stub.address() as AddressInfo).port)}/siteverify`;
}, 120_000);

afterAll(async () => {
  setEnv(saved);
  await cleanUp();
  await app.close();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
});

// --- Tests ----------------------------------------------------------------

describe('two-step sign-in for a buyer', () => {
  let secret = '';
  let recoveryCodes: string[] = [];

  it('enrols: a QR secret and recovery codes, a wrong code refused, a right one switches it on', async () => {
    const browser = await signedIn(EMAILS.buyer);

    const before = await send(browser, 'GET', '/api/v1/auth/mfa');
    expect(before.json()).toMatchObject({ mfa: { enabled: false, required: false, available: true } });

    const setup = await send(browser, 'POST', '/api/v1/auth/mfa/setup');
    expect(setup.statusCode, setup.body).toBe(200);
    expect(setup.headers['cache-control']).toBe('no-store');
    const enrolment = setup.json<{ secret: string; uri: string; recoveryCodes: string[] }>();
    expect(enrolment.uri).toMatch(/^otpauth:\/\/totp\//);
    expect(enrolment.recoveryCodes).toHaveLength(10);

    const wrong = await send(browser, 'POST', '/api/v1/auth/mfa/confirm', { code: '000000' });
    expect(wrong.statusCode).toBe(400);
    expect(codeOf(wrong)).toBe(ErrorCode.MFA_INVALID);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.buyer } })).mfaEnabledAt).toBeNull();

    const right = await send(browser, 'POST', '/api/v1/auth/mfa/confirm', {
      code: await freshCode(ids.buyer, enrolment.secret),
    });
    expect(right.statusCode, right.body).toBe(200);

    // The secret is stored encrypted, never in the clear.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: ids.buyer } });
    expect(user.mfaEnabledAt).not.toBeNull();
    expect(user.mfaSecretEnc).not.toContain(enrolment.secret);

    // The enrolling session is verified; it can carry on shopping.
    const profile = await send(browser, 'GET', '/api/v1/account/profile');
    expect(profile.statusCode, profile.body).toBe(200);

    secret = enrolment.secret;
    recoveryCodes = enrolment.recoveryCodes;
  });

  it('challenges every later sign-in, and refuses a replayed code', async () => {
    const { browser, response } = await signIn(EMAILS.buyer);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ user: { mfaEnabled: true, mfaChallengeRequired: true } });

    // Signed in, and useless until the code is given.
    const blocked = await send(browser, 'GET', '/api/v1/account/profile');
    expect(blocked.statusCode).toBe(403);
    expect(codeOf(blocked)).toBe(ErrorCode.MFA_CHALLENGE_REQUIRED);
    const me = await send(browser, 'GET', '/api/v1/auth/me');
    expect(me.json()).toMatchObject({ mfaChallengeRequired: true });

    // The code that switched it on was spent; offering it again is a replay.
    const spent = (await prisma.user.findUniqueOrThrow({ where: { id: ids.buyer } })).mfaLastCounter;
    expect(spent).not.toBeNull();
    const replay = totpCodeAt(secret, Number(spent ?? 0n) * 30_000);
    const replayed = await send(browser, 'POST', '/api/v1/auth/mfa/challenge', { code: replay });
    expect(replayed.statusCode).toBe(400);
    expect(codeOf(replayed)).toBe(ErrorCode.MFA_INVALID);

    const passed = await send(browser, 'POST', '/api/v1/auth/mfa/challenge', {
      code: await freshCode(ids.buyer, secret),
    });
    expect(passed.statusCode, passed.body).toBe(200);
    expect(passed.json()).toMatchObject({ verified: true, usedRecoveryCode: false });

    // The same code a second time, straight after: refused.
    const again = await send(browser, 'POST', '/api/v1/auth/mfa/challenge', {
      code: totpCodeAt(secret, Date.now()),
    });
    expect(codeOf(again)).toBe(ErrorCode.MFA_INVALID);

    expect((await send(browser, 'GET', '/api/v1/account/profile')).statusCode).toBe(200);
  });

  it('accepts a recovery code exactly once', async () => {
    const first = (await signIn(EMAILS.buyer)).browser;
    const used = await send(first, 'POST', '/api/v1/auth/mfa/challenge', { code: recoveryCodes[0] });
    expect(used.statusCode, used.body).toBe(200);
    expect(used.json()).toMatchObject({ usedRecoveryCode: true, recoveryCodesRemaining: 9 });

    const second = (await signIn(EMAILS.buyer)).browser;
    const reused = await send(second, 'POST', '/api/v1/auth/mfa/challenge', { code: recoveryCodes[0] });
    expect(reused.statusCode).toBe(400);
    expect(codeOf(reused)).toBe(ErrorCode.MFA_INVALID);
  });

  it('locks the account and ends every session after too many wrong codes', async () => {
    const { browser } = await signIn(EMAILS.buyer);
    let last = await send(browser, 'POST', '/api/v1/auth/mfa/challenge', { code: '111111' });
    for (let attempt = 2; attempt <= env.LOGIN_LOCKOUT_THRESHOLD; attempt += 1) {
      last = await send(browser, 'POST', '/api/v1/auth/mfa/challenge', { code: '111111' });
    }
    expect(last.statusCode).toBe(401);
    expect(codeOf(last)).toBe(ErrorCode.ACCOUNT_LOCKED);
    expect(await prisma.session.count({ where: { userId: ids.buyer, revokedAt: null } })).toBe(0);

    const refused = await signIn(EMAILS.buyer);
    expect(codeOf(refused.response)).toBe(ErrorCode.ACCOUNT_LOCKED);

    await prisma.user.update({ where: { id: ids.buyer }, data: { lockedUntil: null, failedLoginCount: 0 } });
  });

  it('switches off only after a fresh step-up with a code, and emails the holder', async () => {
    const { browser } = await signIn(EMAILS.buyer);
    await send(browser, 'POST', '/api/v1/auth/mfa/challenge', { code: await freshCode(ids.buyer, secret) });
    await ageStepUp(ids.buyer);

    const stale = await send(browser, 'POST', '/api/v1/auth/mfa/disable');
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({
      error: { code: ErrorCode.STEP_UP_REQUIRED, details: [{ meta: { method: 'TOTP' } }] },
    });

    // A password is not a step-up for an account with a factor.
    const byPassword = await send(browser, 'POST', '/api/v1/auth/step-up', { password: PASSWORD });
    expect(byPassword.statusCode).toBe(400);

    const stepped = await send(browser, 'POST', '/api/v1/auth/step-up', {
      code: await freshCode(ids.buyer, secret),
    });
    expect(stepped.statusCode, stepped.body).toBe(200);
    expect(stepped.json()).toMatchObject({ method: 'TOTP' });

    const off = await send(browser, 'POST', '/api/v1/auth/mfa/disable');
    expect(off.statusCode, off.body).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.buyer } })).mfaEnabledAt).toBeNull();
    expect(
      await prisma.notificationOutbox.count({ where: { eventKey: 'user.mfa_disabled', recipientEmail: EMAILS.buyer } }),
    ).toBe(1);
  });
});

describe('step-up for a buyer without two-step sign-in', () => {
  it('lets a fresh sign-in change the email, then asks for the password once it has expired', async () => {
    const browser = await signedIn(EMAILS.plain);

    const fresh = await send(browser, 'POST', '/api/v1/account/email-change', { email: `plain-new@${DOMAIN}` });
    expect(fresh.statusCode, fresh.body).toBe(202);
    await send(browser, 'DELETE', '/api/v1/account/email-change');

    await ageStepUp(ids.plain);
    const expired = await send(browser, 'POST', '/api/v1/account/email-change', { email: `plain-new@${DOMAIN}` });
    expect(expired.statusCode).toBe(403);
    expect(expired.json()).toMatchObject({
      error: { code: ErrorCode.STEP_UP_REQUIRED, details: [{ meta: { method: 'PASSWORD' } }] },
    });

    const wrong = await send(browser, 'POST', '/api/v1/auth/step-up', { password: 'not the password' });
    expect(wrong.statusCode).toBe(400);
    expect(codeOf(wrong)).toBe(ErrorCode.INVALID_CREDENTIALS);

    const right = await send(browser, 'POST', '/api/v1/auth/step-up', { password: PASSWORD });
    expect(right.statusCode, right.body).toBe(200);

    const allowed = await send(browser, 'POST', '/api/v1/account/email-change', { email: `plain-new@${DOMAIN}` });
    expect(allowed.statusCode, allowed.body).toBe(202);
    await send(browser, 'DELETE', '/api/v1/account/email-change');
  });

  it('asks for a real second factor before AutoPay, and lets it through once there is one', async () => {
    const browser = await signedIn(EMAILS.plain);
    const body = { paymentMethodId: newId(), consentAccepted: true };

    const noFactor = await send(browser, 'POST', '/api/v1/account/autopay', body);
    expect(noFactor.statusCode).toBe(403);
    expect(codeOf(noFactor)).toBe(ErrorCode.MFA_SETUP_REQUIRED);

    await enrol(browser, ids.plain);

    // Past the gate: refused now only for the made-up card.
    const withFactor = await send(browser, 'POST', '/api/v1/account/autopay', body);
    expect(codeOf(withFactor)).toBe(ErrorCode.AUTOPAY_PAYMENT_METHOD_REQUIRED);

    await ageStepUp(ids.plain);
    const stale = await send(browser, 'PATCH', '/api/v1/account/autopay', { notifyOnCharge: false });
    expect(codeOf(stale)).toBe(ErrorCode.STEP_UP_REQUIRED);
  });

  it('is a no-op check while the deployment has step-up switched off', () => {
    setEnv({ FEATURE_STEP_UP: false });
    try {
      expect(() => {
        assertRecentStepUp({ mfaEnabled: false, sessionReauthenticatedAt: null }, { requireFactor: true });
      }).not.toThrow();
    } finally {
      setEnv({ FEATURE_STEP_UP: true });
    }
  });
});

describe('mandatory two-step sign-in in the Seller Hub', () => {
  let ownerSecret = '';

  it('shuts every Hub route to the owner and a finance viewer until they enrol', async () => {
    const owner = await signedIn(EMAILS.owner);
    await openHub(owner);

    const me = await send(owner, 'GET', '/api/v1/sellers/me');
    expect(me.json()).toMatchObject({ seller: { mfa: { required: true, enrolled: false, satisfied: false } } });

    const payouts = await send(owner, 'GET', '/api/v1/seller/payouts');
    expect(payouts.statusCode).toBe(403);
    expect(payouts.json()).toMatchObject({ error: { code: ErrorCode.MFA_SETUP_REQUIRED, details: [{ code: 'SELLER_OWNER' }] } });

    const finance = await signedIn(EMAILS.finance);
    await openHub(finance);
    const settlements = await send(finance, 'GET', '/api/v1/seller/settlements');
    expect(settlements.statusCode).toBe(403);
    expect(settlements.json()).toMatchObject({ error: { code: ErrorCode.MFA_SETUP_REQUIRED, details: [{ code: 'SELLER_FINANCE' }] } });

    // A role with no money in it is not asked.
    const catalogue = await signedIn(EMAILS.catalogue);
    await openHub(catalogue);
    const listings = await send(catalogue, 'GET', '/api/v1/seller/listings');
    expect(listings.statusCode, listings.body).toBe(200);

    // Setting it up is the way in - a prompt, not a lock-out.
    ownerSecret = (await enrol(owner, ids.owner)).secret;
    const opened = await send(owner, 'GET', '/api/v1/seller/payouts');
    expect(opened.statusCode, opened.body).toBe(200);

    await enrol(finance, ids.finance);
    expect((await send(finance, 'GET', '/api/v1/seller/settlements')).statusCode).toBe(200);
  });

  it('refuses to switch off a factor the role requires', async () => {
    const owner = await signedIn(EMAILS.owner);
    const state = await send(owner, 'GET', '/api/v1/auth/mfa');
    expect(state.json()).toMatchObject({
      mfa: { enabled: true, required: true, requiredReason: 'SELLER_OWNER', challengePending: true },
    });

    // Straight after sign-in, the owner owes a code.
    expect(codeOf(await send(owner, 'GET', '/api/v1/sellers/me'))).toBe(ErrorCode.MFA_CHALLENGE_REQUIRED);
    const passed = await send(owner, 'POST', '/api/v1/auth/mfa/challenge', {
      code: await freshCode(ids.owner, ownerSecret),
    });
    expect(passed.statusCode, passed.body).toBe(200);

    const off = await send(owner, 'POST', '/api/v1/auth/mfa/disable');
    expect(off.statusCode).toBe(409);
    expect(codeOf(off)).toBe(ErrorCode.MFA_REQUIRED_BY_ROLE);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: ids.owner } })).mfaEnabledAt).not.toBeNull();
  });

  it('needs a fresh step-up to connect payouts and to change a team role', async () => {
    const owner = await signedIn(EMAILS.owner);
    await send(owner, 'POST', '/api/v1/auth/mfa/challenge', { code: await freshCode(ids.owner, ownerSecret) });
    await openHub(owner);
    await ageStepUp(ids.owner);

    const onboarding = await send(owner, 'POST', '/api/v1/seller/payout-account/onboarding', {
      returnUrl: 'https://shop.example.test/seller/payments',
      refreshUrl: 'https://shop.example.test/seller/payments',
    });
    expect(onboarding.statusCode).toBe(403);
    expect(codeOf(onboarding)).toBe(ErrorCode.STEP_UP_REQUIRED);

    const role = await send(owner, 'PATCH', `/api/v1/seller/members/${catalogueMemberId}`, { role: 'ORDER_MANAGER' });
    expect(role.statusCode).toBe(403);
    expect(codeOf(role)).toBe(ErrorCode.STEP_UP_REQUIRED);

    // Once confirmed - by code, since the owner has a factor - it goes through.
    const stepped = await send(owner, 'POST', '/api/v1/auth/step-up', {
      code: await freshCode(ids.owner, ownerSecret),
    });
    expect(stepped.statusCode, stepped.body).toBe(200);
    const changed = await send(owner, 'PATCH', `/api/v1/seller/members/${catalogueMemberId}`, { role: 'ORDER_MANAGER' });
    expect(changed.statusCode, changed.body).toBe(204);
  });
});

describe('new-device sign-in alerts', () => {
  it('emails the holder for a new device, and not for the first or a familiar one', async () => {
    setEnv({ FEATURE_LOGIN_ALERTS: true });
    try {
      const count = () =>
        prisma.notificationOutbox.count({ where: { eventKey: 'user.new_sign_in', recipientEmail: EMAILS.alerts } });

      await signedIn(EMAILS.alerts, UA_DESKTOP);
      expect(await count()).toBe(0);

      await signedIn(EMAILS.alerts, UA_DESKTOP);
      expect(await count()).toBe(0);

      await signedIn(EMAILS.alerts, UA_OTHER);
      expect(await count()).toBe(1);
      const row = await prisma.notificationOutbox.findFirstOrThrow({
        where: { eventKey: 'user.new_sign_in', recipientEmail: EMAILS.alerts },
      });
      expect(row.payloadJson).toMatchObject({ device: 'Firefox on Linux' });
    } finally {
      setEnv({ FEATURE_LOGIN_ALERTS: false });
    }
  });
});

describe('the bot check', () => {
  it('is not asked for while the provider is off', async () => {
    const { response } = await signIn(EMAILS.captcha);
    expect(response.statusCode, response.body).toBe(200);
  });

  it('is enforced on sign-in, sign-up and forgotten password when configured', async () => {
    setEnv({
      CAPTCHA_PROVIDER: 'turnstile',
      CAPTCHA_SITE_KEY: 'suite-site',
      CAPTCHA_SECRET_KEY: 'suite-secret',
      CAPTCHA_VERIFY_URL: stubUrl,
    });
    try {
      const missing = await signIn(EMAILS.captcha);
      expect(missing.response.statusCode).toBe(400);
      expect(codeOf(missing.response)).toBe(ErrorCode.CAPTCHA_REQUIRED);

      const bad = await signIn(EMAILS.captcha, UA_DESKTOP, { captchaToken: 'bad-token' });
      expect(codeOf(bad.response)).toBe(ErrorCode.CAPTCHA_FAILED);

      const good = await signIn(EMAILS.captcha, UA_DESKTOP, { captchaToken: 'good-token' });
      expect(good.response.statusCode, good.response.body).toBe(200);

      const forgot = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        payload: { email: EMAILS.captcha },
      });
      expect(codeOf(forgot)).toBe(ErrorCode.CAPTCHA_REQUIRED);
      const forgotOk = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/password/forgot',
        payload: { email: EMAILS.captcha, captchaToken: 'good-token' },
      });
      expect(forgotOk.statusCode, forgotOk.body).toBe(202);

      const register = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        payload: {
          fullName: 'Robot',
          email: `robot@${DOMAIN}`,
          phone: '+441234567890',
          country: 'GB',
          password: PASSWORD,
          acceptedTerms: true,
        },
      });
      expect(codeOf(register)).toBe(ErrorCode.CAPTCHA_REQUIRED);

      // The public config tells the storefront which widget to draw.
      const config = await app.inject({ method: 'GET', url: '/api/v1/config' });
      expect(config.json()).toMatchObject({ captcha: { provider: 'turnstile', siteKey: 'suite-site' } });
    } finally {
      setEnv({
        CAPTCHA_PROVIDER: 'off',
        CAPTCHA_SITE_KEY: '',
        CAPTCHA_SECRET_KEY: '',
        CAPTCHA_VERIFY_URL: '',
      });
    }
  });
});
