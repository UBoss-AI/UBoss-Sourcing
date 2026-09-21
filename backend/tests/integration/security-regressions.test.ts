/**
 * Regressions for the findings of the September 2026 security audit.
 *
 * Every test here failed before the fix it guards and passes after it. They
 * are grouped by finding rather than by module, because what makes each one
 * worth keeping is the attack it closes, not the file it happens to live in.
 *
 * The findings, in the order they appear below:
 *
 *   SEC-01  A cookie-authenticated state change skipped the CSRF check
 *           whenever the request also carried a non-Bearer `Authorization`
 *           header, because the guard inferred "this is a header credential"
 *           from the header's mere presence rather than from where the token
 *           it actually used came from.
 *
 *   SEC-02  Two simultaneous presentations of one refresh token both
 *           succeeded. Rotation read `revokedAt` and wrote it in two separate
 *           statements, so the reuse alarm - the entire point of the token
 *           family - never fired on the case it exists for.
 *
 *   SEC-03  A refresh-token family had no maximum age. Thirty days, sliding,
 *           renewed on every rotation, is unlimited for anybody who keeps
 *           using it.
 *
 *   SEC-04  The sign-in form named an account's status - deactivated,
 *           unapproved, unconfirmed - to anybody who posted the address with
 *           any password at all, which turned it into a directory of who has
 *           an account here.
 *
 *   SEC-05  `/health/ready` returned the database driver's own error text to
 *           unauthenticated callers, which names the host, the port and the
 *           database user during exactly the outage when somebody is watching.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { buildApp } from '../../src/http/app.js';
import { env } from '../../src/config/env.js';
import { Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { AuditAction } from '../../src/modules/audit/audit.service.js';
import { login } from '../../src/modules/identity/auth.service.js';
import { issueSession, rotateSession } from '../../src/modules/identity/session.service.js';

let app: Awaited<ReturnType<typeof buildApp>>;

const STAFF_EMAIL = 'secreg-staff@test.local';
const STAFF_PASSWORD = 'SecRegStaff!2026';
const BUYER_EMAIL = 'secreg-buyer@test.local';
const BUYER_PASSWORD = 'SecRegBuyer!2026';
/** Every address this file creates, so the cleanup cannot miss one. */
const EMAILS = [
  STAFF_EMAIL,
  BUYER_EMAIL,
  'secreg-closed@test.local',
  'secreg-unapproved@test.local',
  'secreg-unconfirmed@test.local',
];

let buyerUserId: string;

type Jar = Map<string, string>;

function absorb(jar: Jar, response: LightMyRequestResponse): Jar {
  for (const cookie of response.cookies as { name: string; value: string }[]) {
    if (cookie.value === '') jar.delete(cookie.name);
    else jar.set(cookie.name, cookie.value);
  }
  return jar;
}

function cookieHeader(jar: Jar): string {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function removeTestUsers(): Promise<void> {
  const owned = { where: { user: { emailNormalized: { in: EMAILS } } } };
  await prisma.session.deleteMany(owned);
  await prisma.userRole.deleteMany(owned);
  await prisma.customerProfile.deleteMany(owned);
  await prisma.loginAttempt.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
  await prisma.user.deleteMany({ where: { emailNormalized: { in: EMAILS } } });
}

async function createCustomer(params: {
  email: string;
  password: string | null;
  status: 'ACTIVE' | 'DEACTIVATED' | 'PENDING_APPROVAL' | 'PENDING_INVITATION';
  emailVerified: boolean;
}): Promise<string> {
  const id = newId();

  await prisma.user.create({
    data: {
      id,
      type: 'CUSTOMER',
      email: params.email,
      emailNormalized: params.email,
      passwordHash: params.password === null ? null : await hashPassword(params.password),
      status: params.status,
      emailVerifiedAt: params.emailVerified ? new Date() : null,
    },
  });

  await prisma.customerProfile.create({
    data: { id: newId(), userId: id, fullName: 'Regression Buyer' },
  });

  return id;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();

  await removeTestUsers();

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

  buyerUserId = await createCustomer({
    email: BUYER_EMAIL,
    password: BUYER_PASSWORD,
    status: 'ACTIVE',
    emailVerified: true,
  });
});

afterAll(async () => {
  await removeTestUsers();
  await app.close();
});

// ---------------------------------------------------------------------------
// SEC-01 - CSRF is decided by where the token came from
// ---------------------------------------------------------------------------

describe('SEC-01 CSRF applies to every cookie-authenticated change', () => {
  /**
   * The bug, precisely: the guard asked `request.headers.authorization ===
   * undefined` to decide whether a cookie had been used. A request carrying
   * `Authorization: Basic ...` answers "no" to that and still authenticates
   * from the cookie, so the double-submit check was skipped on a request the
   * browser's own cookie jar had authorised.
   *
   * Logout is the mutation used here because it needs no fixture and its
   * effect is unambiguous: 204 means the change went through.
   */
  it('refuses a cookie-authenticated POST that carries a non-Bearer Authorization header and no CSRF token', async () => {
    const jar: Jar = new Map();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: BUYER_EMAIL, password: BUYER_PASSWORD },
    });
    expect(signIn.statusCode, signIn.body).toBe(200);
    absorb(jar, signIn);

    const forged = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: {
        cookie: cookieHeader(jar),
        // Not a Bearer token, so the cookie is what authenticates this - and
        // the CSRF header is deliberately absent.
        authorization: 'Basic ' + Buffer.from('nobody:nothing').toString('base64'),
      },
    });

    expect(forged.statusCode).toBe(403);
    expect(forged.json<{ error: { code: string } }>().error.code).toBe('FORBIDDEN');

    // And the session it tried to end is still alive, which is the part that
    // would have been a real change.
    const stillIn = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { cookie: cookieHeader(jar) },
    });
    expect(stillIn.statusCode, stillIn.body).toBe(200);
  });

  it('still lets the same request through with the CSRF token present', async () => {
    const jar: Jar = new Map();
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: BUYER_EMAIL, password: BUYER_PASSWORD },
    });
    absorb(jar, signIn);

    const csrf = jar.get('uboss_shop_csrf') ?? '';
    expect(csrf.length).toBeGreaterThan(0);

    const logout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { cookie: cookieHeader(jar), 'x-csrf-token': csrf },
    });

    expect(logout.statusCode, logout.body).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// SEC-02 / SEC-03 - refresh-token families
// ---------------------------------------------------------------------------

describe('SEC-02 one refresh token cannot be spent twice', () => {
  afterEach(async () => {
    await prisma.session.deleteMany({ where: { userId: buyerUserId } });
  });

  /**
   * Both callers present the SAME token at the same moment - a stolen copy
   * racing the real browser. Exactly one may win, and the loser must be
   * treated as reuse rather than quietly handed a second working session.
   *
   * Before the fix both `rotateSession` calls read `revokedAt: null`, both
   * created a replacement, and the family survived with two live branches and
   * no alarm.
   */
  it('lets exactly one of two simultaneous rotations win and revokes the family', async () => {
    const issued = await issueSession(buyerUserId, 'CUSTOMER');
    const { familyId } = await prisma.session.findUniqueOrThrow({
      where: { id: issued.sessionId },
      select: { familyId: true },
    });

    const outcomes = await Promise.allSettled([
      rotateSession(issued.refreshToken),
      rotateSession(issued.refreshToken),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failure = rejected[0];
    expect(failure?.status).toBe('rejected');
    if (failure?.status === 'rejected') {
      expect((failure.reason as { code?: string }).code).toBe('REFRESH_TOKEN_REUSED');
    }

    /*
     * Reuse costs the whole family, INCLUDING the replacement the winner was
     * just given. Both parties sign in again, which is the only safe answer
     * when you cannot tell which of them is the thief.
     *
     * Counted within the family rather than across the user, because other
     * tests in this file sign the same buyer in through the HTTP surface and
     * a count by user would be measuring those as well.
     */
    const live = await prisma.session.count({ where: { familyId, revokedAt: null } });
    expect(live).toBe(0);

    const replacement = await prisma.session.findFirstOrThrow({
      where: { familyId, id: { not: issued.sessionId } },
      select: { revokedReason: true },
    });
    expect(replacement.revokedReason).toBe('refresh_token_reuse_detected');
  });

  it('records the reuse in the audit trail', async () => {
    const issued = await issueSession(buyerUserId, 'CUSTOMER');
    // The stored value, not the enum member name - see audit.service.ts.
    const where = { action: AuditAction.USER_REFRESH_REUSE_DETECTED };
    const before = await prisma.auditLog.count({ where });

    await Promise.allSettled([
      rotateSession(issued.refreshToken),
      rotateSession(issued.refreshToken),
    ]);

    expect(await prisma.auditLog.count({ where })).toBeGreaterThan(before);
  });

  it('still rotates normally when the token is presented once', async () => {
    const issued = await issueSession(buyerUserId, 'CUSTOMER');
    const rotated = await rotateSession(issued.refreshToken);

    expect(rotated.refreshToken).not.toBe(issued.refreshToken);

    const replaced = await prisma.session.findUniqueOrThrow({
      where: { id: issued.sessionId },
      select: { revokedAt: true, revokedReason: true, replacedBySessionId: true },
    });
    expect(replaced.revokedAt).not.toBeNull();
    expect(replaced.revokedReason).toBe('rotated');
    expect(replaced.replacedBySessionId).toBe(rotated.sessionId);
  });
});

describe('SEC-03 a sign-in has a maximum age', () => {
  afterEach(async () => {
    await prisma.session.deleteMany({ where: { userId: buyerUserId } });
  });

  it('carries the original start time across a rotation instead of resetting it', async () => {
    const issued = await issueSession(buyerUserId, 'CUSTOMER');
    const first = await prisma.session.findUniqueOrThrow({
      where: { id: issued.sessionId },
      select: { familyStartedAt: true },
    });

    const rotated = await rotateSession(issued.refreshToken);
    const second = await prisma.session.findUniqueOrThrow({
      where: { id: rotated.sessionId },
      select: { familyStartedAt: true },
    });

    expect(first.familyStartedAt).not.toBeNull();
    expect(second.familyStartedAt?.getTime()).toBe(first.familyStartedAt?.getTime());
  });

  /**
   * The ceiling itself. Backdating the family start past
   * SESSION_ABSOLUTE_TTL_SECONDS is the same state the clock would reach on
   * its own after ninety days of diligent refreshing.
   */
  it('refuses a rotation once the family is older than the absolute ceiling', async () => {
    const issued = await issueSession(buyerUserId, 'CUSTOMER');

    await prisma.session.update({
      where: { id: issued.sessionId },
      data: {
        familyStartedAt: new Date(Date.now() - (env.SESSION_ABSOLUTE_TTL_SECONDS + 60) * 1000),
      },
    });

    await expect(rotateSession(issued.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });

    const family = await prisma.session.findMany({
      where: { userId: buyerUserId },
      select: { revokedAt: true, revokedReason: true },
    });
    expect(family.every((row) => row.revokedAt !== null)).toBe(true);
    expect(family.some((row) => row.revokedReason === 'absolute_lifetime_reached')).toBe(true);
  });

  /**
   * Sessions written before the column existed have no start time, and an
   * upgrade must not sign everybody out at the moment it is deployed.
   */
  it('leaves a pre-existing session with no recorded start alone', async () => {
    const issued = await issueSession(buyerUserId, 'CUSTOMER');
    await prisma.session.update({
      where: { id: issued.sessionId },
      data: { familyStartedAt: null },
    });

    await expect(rotateSession(issued.refreshToken)).resolves.toMatchObject({
      sessionId: expect.any(String) as unknown as string,
    });
  });
});

// ---------------------------------------------------------------------------
// SEC-04 - the sign-in form is not a directory
// ---------------------------------------------------------------------------

describe('SEC-04 account status is disclosed only to somebody who knows the password', () => {
  const CLOSED = 'secreg-closed@test.local';
  const UNAPPROVED = 'secreg-unapproved@test.local';
  const UNCONFIRMED = 'secreg-unconfirmed@test.local';
  const REAL_PASSWORD = 'RegressionReal!2026';
  const WRONG_PASSWORD = 'RegressionWrong!2026';

  beforeAll(async () => {
    await createCustomer({
      email: CLOSED,
      password: REAL_PASSWORD,
      status: 'DEACTIVATED',
      emailVerified: true,
    });
    await createCustomer({
      email: UNAPPROVED,
      password: REAL_PASSWORD,
      status: 'PENDING_APPROVAL',
      emailVerified: true,
    });
    await createCustomer({
      email: UNCONFIRMED,
      password: REAL_PASSWORD,
      status: 'PENDING_APPROVAL',
      emailVerified: false,
    });
  });

  async function codeFor(email: string, password: string): Promise<string> {
    const error = await login({ email, password, kind: 'CUSTOMER' }).then(
      () => null,
      (reason: unknown) => reason,
    );
    expect(error, `login for ${email} should have been refused`).not.toBeNull();
    return (error as { code: string }).code;
  }

  /**
   * The decisive assertion. Three accounts in three different closed states,
   * plus an address that has never existed, and a wrong password against each
   * one. All four answers must be the same string - otherwise the differences
   * between them are the directory.
   */
  it('gives one identical answer for every closed account when the password is wrong', async () => {
    const unknown = await codeFor('secreg-nobody-at-all@test.local', WRONG_PASSWORD);
    const closed = await codeFor(CLOSED, WRONG_PASSWORD);
    const unapproved = await codeFor(UNAPPROVED, WRONG_PASSWORD);
    const unconfirmed = await codeFor(UNCONFIRMED, WRONG_PASSWORD);

    expect(unknown).toBe('INVALID_CREDENTIALS');
    expect(closed).toBe(unknown);
    expect(unapproved).toBe(unknown);
    expect(unconfirmed).toBe(unknown);
  });

  it('still tells the holder of the right password exactly what is wrong', async () => {
    expect(await codeFor(CLOSED, REAL_PASSWORD)).toBe('ACCOUNT_DEACTIVATED');
    expect(await codeFor(UNAPPROVED, REAL_PASSWORD)).toBe('ACCOUNT_PENDING_APPROVAL');
    expect(await codeFor(UNCONFIRMED, REAL_PASSWORD)).toBe('EMAIL_NOT_VERIFIED');
  });

  /**
   * A wrong password against a closed account must still count towards the
   * lockout. Otherwise "deactivate the account" would become a way to get
   * unlimited free guesses at its password.
   */
  it('counts a failed attempt against a closed account towards the lockout', async () => {
    const before = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: CLOSED },
      select: { failedLoginCount: true },
    });

    await codeFor(CLOSED, WRONG_PASSWORD);

    const after = await prisma.user.findUniqueOrThrow({
      where: { emailNormalized: CLOSED },
      select: { failedLoginCount: true },
    });
    expect(after.failedLoginCount).toBe(before.failedLoginCount + 1);
  });
});

// ---------------------------------------------------------------------------
// SEC-05 - the readiness probe says whether, never why
// ---------------------------------------------------------------------------

describe('SEC-05 the public readiness probe discloses no internals', () => {
  it('answers with a status and a latency and nothing else', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);

    const body = response.json<{
      status: string;
      dependencies: Record<string, Record<string, unknown>>;
    }>();

    expect(body.status).toBe('ready');

    for (const [name, dependency] of Object.entries(body.dependencies)) {
      expect(Object.keys(dependency).sort(), `${name} exposes more than ok/latencyMs`).toEqual([
        'latencyMs',
        'ok',
      ]);
    }

    /*
     * A blunt second check on the serialised body, because the shape assertion
     * above only covers the keys this version happens to emit. The strings
     * below are the ones a MariaDB or Prisma failure message actually
     * contains, and none of them may ever appear here.
     */
    for (const leak of ['error', 'Prisma', 'mysql', '3306', 'ECONNREFUSED', 'Can’t reach']) {
      expect(response.body, `readiness body mentions ${leak}`).not.toContain(leak);
    }
  });
});
