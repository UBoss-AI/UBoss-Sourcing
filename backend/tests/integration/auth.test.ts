/**
 * Authentication and authorization - integration, against a real MariaDB.
 *
 * These are the tests that guard the boundary between the two applications. The
 * negative cases matter most: an admin credential must not work on the customer
 * site, a customer token must not reach an admin route, and a leaked refresh
 * token must cost the attacker the whole session family.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Permission, ROLE_DEFINITIONS, Role } from '../../src/domain/permissions.js';
import { hashPassword } from '../../src/infra/crypto.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { login, loadAuthenticatedUser } from '../../src/modules/identity/auth.service.js';
import {
  isSessionActive,
  issueSession,
  revokeAllUserSessions,
  rotateSession,
  verifyAccessToken,
} from '../../src/modules/identity/session.service.js';
import {
  acceptInvitation,
  completePasswordReset,
  issueToken,
  requestPasswordReset,
} from '../../src/modules/identity/token.service.js';

const ADMIN_PASSWORD = 'AdminTestPass!2026';
const CUSTOMER_PASSWORD = 'CustomerTestPass!2026';

let adminUserId: string;
let customerUserId: string;
let invitedUserId: string;

/** Wipe in FK-safe order. */
async function resetDatabase(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.session.deleteMany({});
  await prisma.authToken.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.userRole.deleteMany({});
  await prisma.user.deleteMany({});
}

async function seedRoles(): Promise<void> {
  for (const definition of ROLE_DEFINITIONS) {
    await prisma.role.upsert({
      where: { key: definition.key },
      update: {},
      create: {
        id: newId(),
        key: definition.key,
        name: definition.name,
        description: definition.description,
        isSystem: true,
      },
    });
  }
}

async function createUser(params: {
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  password: string | null;
  status: 'ACTIVE' | 'PENDING_INVITATION' | 'DEACTIVATED';
  roleKey: string;
  withProfile?: boolean;
}): Promise<string> {
  const id = newId();
  const role = await prisma.role.findUniqueOrThrow({ where: { key: params.roleKey } });

  await prisma.user.create({
    data: {
      id,
      type: params.type,
      email: params.email,
      emailNormalized: params.email.toLowerCase(),
      passwordHash: params.password === null ? null : await hashPassword(params.password),
      status: params.status,
      emailVerifiedAt: params.status === 'ACTIVE' ? new Date() : null,
      roles: { create: { roleId: role.id } },
    },
  });

  if (params.withProfile === true) {
    await prisma.customerProfile.create({
      data: { id: newId(), userId: id, fullName: 'Test Buyer' },
    });
  }

  return id;
}

beforeAll(async () => {
  await resetDatabase();
  await seedRoles();
});

beforeEach(async () => {
  await resetDatabase();
  await seedRoles();

  adminUserId = await createUser({
    email: 'admin@test.local',
    type: 'ADMIN',
    password: ADMIN_PASSWORD,
    status: 'ACTIVE',
    roleKey: Role.BUSINESS_OWNER,
  });

  customerUserId = await createUser({
    email: 'customer@test.local',
    type: 'CUSTOMER',
    password: CUSTOMER_PASSWORD,
    status: 'ACTIVE',
    roleKey: Role.CUSTOMER,
    withProfile: true,
  });

  invitedUserId = await createUser({
    email: 'invited@test.local',
    type: 'CUSTOMER',
    password: null,
    status: 'PENDING_INVITATION',
    roleKey: Role.CUSTOMER,
    withProfile: true,
  });
});

afterAll(async () => {
  await resetDatabase();
  await prisma.$disconnect();
});

describe('login', () => {
  it('authenticates an admin and returns their permission set', async () => {
    const result = await login({
      email: 'admin@test.local',
      password: ADMIN_PASSWORD,
      kind: 'ADMIN',
    });

    expect(result.user.id).toBe(adminUserId);
    expect(result.user.roles).toEqual([Role.BUSINESS_OWNER]);
    expect(result.user.permissions).toContain(Permission.REFUND_CREATE);
    expect(result.session.accessToken).toBeTruthy();
  });

  it('is case-insensitive on the email', async () => {
    const result = await login({
      email: '  ADMIN@Test.Local  ',
      password: ADMIN_PASSWORD,
      kind: 'ADMIN',
    });
    expect(result.user.id).toBe(adminUserId);
  });

  /**
   * The surface-separation rule. An admin password is a valid credential - it
   * just must not be one HERE. Rejecting it with the generic message keeps the
   * customer site from confirming that an admin account exists.
   */
  it('refuses an admin credential at the customer surface', async () => {
    await expect(
      login({ email: 'admin@test.local', password: ADMIN_PASSWORD, kind: 'CUSTOMER' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('refuses a customer credential at the admin surface', async () => {
    await expect(
      login({ email: 'customer@test.local', password: CUSTOMER_PASSWORD, kind: 'ADMIN' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('returns the same code for a wrong password and an unknown account', async () => {
    const wrongPassword = await login({
      email: 'admin@test.local',
      password: 'WrongPassword!2026',
      kind: 'ADMIN',
    }).catch((error: unknown) => error);

    const unknownAccount = await login({
      email: 'nobody@test.local',
      password: 'WrongPassword!2026',
      kind: 'ADMIN',
    }).catch((error: unknown) => error);

    // Identical code AND message: any difference enumerates the account list.
    expect((wrongPassword as { code: string }).code).toBe(
      (unknownAccount as { code: string }).code,
    );
    expect((wrongPassword as { message: string }).message).toBe(
      (unknownAccount as { message: string }).message,
    );
  });

  it('refuses an account that has not been activated', async () => {
    await expect(
      login({ email: 'invited@test.local', password: 'anything12345', kind: 'CUSTOMER' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_NOT_ACTIVATED' });
  });

  it('refuses a deactivated account', async () => {
    await prisma.user.update({ where: { id: customerUserId }, data: { status: 'DEACTIVATED' } });

    await expect(
      login({ email: 'customer@test.local', password: CUSTOMER_PASSWORD, kind: 'CUSTOMER' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_DEACTIVATED' });
  });

  it('locks an account after repeated failures, then refuses even the right password', async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await login({ email: 'admin@test.local', password: 'Wrong!2026', kind: 'ADMIN' }).catch(
        () => undefined,
      );
    }

    // The correct password must not bypass the lockout - otherwise the lockout
    // only inconveniences the legitimate owner.
    await expect(
      login({ email: 'admin@test.local', password: ADMIN_PASSWORD, kind: 'ADMIN' }),
    ).rejects.toMatchObject({ code: 'ACCOUNT_LOCKED' });
  });

  it('clears the failure counter after a successful sign-in', async () => {
    await login({ email: 'admin@test.local', password: 'Wrong!2026', kind: 'ADMIN' }).catch(
      () => undefined,
    );
    await login({ email: 'admin@test.local', password: ADMIN_PASSWORD, kind: 'ADMIN' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: adminUserId } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lastLoginAt).not.toBeNull();
  });

  it('records both successful and failed attempts', async () => {
    await login({ email: 'admin@test.local', password: ADMIN_PASSWORD, kind: 'ADMIN' });
    await login({ email: 'admin@test.local', password: 'Wrong!2026', kind: 'ADMIN' }).catch(
      () => undefined,
    );

    expect(await prisma.loginAttempt.count({ where: { success: true } })).toBe(1);
    expect(await prisma.loginAttempt.count({ where: { success: false } })).toBe(1);
  });
});

describe('access tokens', () => {
  it('carries the surface in the claims, and verifies', async () => {
    const session = await issueSession(adminUserId, 'ADMIN');
    const claims = verifyAccessToken(session.accessToken);

    expect(claims?.sub).toBe(adminUserId);
    expect(claims?.typ).toBe('ADMIN');
    expect(claims?.sid).toBe(session.sessionId);
  });

  it('rejects a tampered token', async () => {
    const session = await issueSession(adminUserId, 'ADMIN');
    const [payload] = session.accessToken.split('.');

    expect(verifyAccessToken(`${String(payload)}.forgedsignature`)).toBeNull();
    expect(verifyAccessToken('garbage')).toBeNull();
    expect(verifyAccessToken('')).toBeNull();
  });

  /**
   * There is no `alg` field to attack, so the classic "alg: none" JWT bypass
   * has no surface here. This asserts a re-signed payload is still rejected.
   */
  it('rejects a payload re-encoded without a valid signature', () => {
    const forgedClaims = Buffer.from(
      JSON.stringify({
        sub: adminUserId,
        sid: 'fake',
        typ: 'ADMIN',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      'utf8',
    ).toString('base64url');

    expect(verifyAccessToken(`${forgedClaims}.`)).toBeNull();
  });
});

describe('refresh rotation', () => {
  it('issues a new token and invalidates the old one', async () => {
    const first = await issueSession(customerUserId, 'CUSTOMER');
    const second = await rotateSession(first.refreshToken);

    expect(second.refreshToken).not.toBe(first.refreshToken);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(await isSessionActive(first.sessionId)).toBe(false);
    expect(await isSessionActive(second.sessionId)).toBe(true);
  });

  /**
   * The security-critical case. Presenting an already-rotated token means the
   * secret leaked. Since we cannot tell the thief from the victim, the whole
   * family dies and both must sign in again.
   */
  it('revokes the entire family when a rotated token is replayed', async () => {
    const first = await issueSession(customerUserId, 'CUSTOMER');
    const second = await rotateSession(first.refreshToken);

    await expect(rotateSession(first.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });

    // The legitimate client's current token is now dead too. That is intended.
    await expect(rotateSession(second.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
    });

    const active = await prisma.session.count({
      where: { userId: customerUserId, revokedAt: null },
    });
    expect(active).toBe(0);
  });

  it('records reuse detection in the audit trail', async () => {
    const first = await issueSession(customerUserId, 'CUSTOMER');
    await rotateSession(first.refreshToken);
    await rotateSession(first.refreshToken).catch(() => undefined);

    const entry = await prisma.auditLog.findFirst({
      where: { action: 'user.refresh_reuse_detected' },
    });
    expect(entry).not.toBeNull();
  });

  it('rejects an unknown token', async () => {
    await expect(rotateSession('never-issued')).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  it('rejects rotation once the account is deactivated', async () => {
    const session = await issueSession(customerUserId, 'CUSTOMER');
    await prisma.user.update({ where: { id: customerUserId }, data: { status: 'DEACTIVATED' } });

    await expect(rotateSession(session.refreshToken)).rejects.toMatchObject({
      code: 'ACCOUNT_DEACTIVATED',
    });
  });

  it('rejects an expired refresh token', async () => {
    const session = await issueSession(customerUserId, 'CUSTOMER');
    await prisma.session.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(rotateSession(session.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });
});

describe('session revocation', () => {
  it('takes effect immediately, not at token expiry', async () => {
    const session = await issueSession(adminUserId, 'ADMIN');
    expect(await isSessionActive(session.sessionId)).toBe(true);

    await revokeAllUserSessions(adminUserId, 'deactivated');

    // The access token is still cryptographically valid...
    expect(verifyAccessToken(session.accessToken)).not.toBeNull();
    // ...but the guard also checks the session, which is what makes
    // deactivation immediate rather than eventual.
    expect(await isSessionActive(session.sessionId)).toBe(false);
  });
});

describe('authorization context', () => {
  it('refuses to load a user for the wrong surface', async () => {
    expect(await loadAuthenticatedUser(adminUserId, 'ADMIN')).not.toBeNull();
    // A valid admin id, asked for as a customer. Must not resolve.
    expect(await loadAuthenticatedUser(adminUserId, 'CUSTOMER')).toBeNull();
    expect(await loadAuthenticatedUser(customerUserId, 'ADMIN')).toBeNull();
  });

  it('grants a customer no admin permissions at all', async () => {
    const user = await loadAuthenticatedUser(customerUserId, 'CUSTOMER');
    expect(user?.permissions).toEqual([]);
    expect(user?.customerProfileId).not.toBeNull();
  });

  it('refuses a deactivated user', async () => {
    await prisma.user.update({ where: { id: adminUserId }, data: { status: 'DEACTIVATED' } });
    expect(await loadAuthenticatedUser(adminUserId, 'ADMIN')).toBeNull();
  });
});

describe('invitations', () => {
  it('activates an account, sets the password and records consent', async () => {
    const { token } = await issueToken(invitedUserId, 'INVITATION');

    await acceptInvitation({
      token,
      password: 'BrandNewPass!2026',
      acceptedTerms: true,
      consentVersion: 'v1',
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: invitedUserId } });
    expect(user.status).toBe('ACTIVE');
    expect(user.passwordHash).not.toBeNull();
    expect(user.emailVerifiedAt).not.toBeNull();

    const profile = await prisma.customerProfile.findUniqueOrThrow({
      where: { userId: invitedUserId },
    });
    expect(profile.consentAcceptedAt).not.toBeNull();
    expect(profile.consentVersion).toBe('v1');

    // And the account genuinely works afterwards.
    const result = await login({
      email: 'invited@test.local',
      password: 'BrandNewPass!2026',
      kind: 'CUSTOMER',
    });
    expect(result.user.id).toBe(invitedUserId);
  });

  it('is single use', async () => {
    const { token } = await issueToken(invitedUserId, 'INVITATION');
    await acceptInvitation({
      token,
      password: 'BrandNewPass!2026',
      acceptedTerms: true,
      consentVersion: 'v1',
    });

    await expect(
      acceptInvitation({
        token,
        password: 'AnotherPass!2026',
        acceptedTerms: true,
        consentVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_ALREADY_USED' });
  });

  it('survives a concurrent double redemption, activating exactly once', async () => {
    const { token } = await issueToken(invitedUserId, 'INVITATION');

    const results = await Promise.allSettled([
      acceptInvitation({ token, password: 'PassOne!2026xx', acceptedTerms: true, consentVersion: 'v1' }),
      acceptInvitation({ token, password: 'PassTwo!2026xx', acceptedTerms: true, consentVersion: 'v1' }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });

  it('invalidates the previous invitation when a new one is issued', async () => {
    const first = await issueToken(invitedUserId, 'INVITATION');
    await issueToken(invitedUserId, 'INVITATION');

    // A resent invitation must make the older link unusable.
    await expect(
      acceptInvitation({
        token: first.token,
        password: 'BrandNewPass!2026',
        acceptedTerms: true,
        consentVersion: 'v1',
      }),
    ).rejects.toMatchObject({ code: 'TOKEN_ALREADY_USED' });
  });

  it('rejects an expired invitation', async () => {
    const { token } = await issueToken(invitedUserId, 'INVITATION');
    await prisma.authToken.updateMany({
      where: { userId: invitedUserId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(
      acceptInvitation({ token, password: 'BrandNewPass!2026', acceptedTerms: true, consentVersion: 'v1' }),
    ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' });
  });

  it('requires consent', async () => {
    const { token } = await issueToken(invitedUserId, 'INVITATION');
    await expect(
      acceptInvitation({ token, password: 'BrandNewPass!2026', acceptedTerms: false, consentVersion: 'v1' }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_CONSENT_REQUIRED' });
  });

  it('does not accept a reset token as an invitation', async () => {
    const { token } = await issueToken(customerUserId, 'PASSWORD_RESET');
    await expect(
      acceptInvitation({ token, password: 'BrandNewPass!2026', acceptedTerms: true, consentVersion: 'v1' }),
    ).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });
});

describe('password reset', () => {
  it('issues a token for an active account', async () => {
    const issued = await requestPasswordReset('customer@test.local');
    expect(issued?.userId).toBe(customerUserId);
    expect(issued?.token).toBeTruthy();
  });

  /**
   * Returning null rather than throwing is what lets the route answer
   * identically for a real and an unknown address.
   */
  it('returns null for an unknown or inactive account, without throwing', async () => {
    expect(await requestPasswordReset('nobody@test.local')).toBeNull();
    expect(await requestPasswordReset('invited@test.local')).toBeNull();
  });

  it('changes the password and revokes every existing session', async () => {
    const session = await issueSession(customerUserId, 'CUSTOMER');
    const issued = await requestPasswordReset('customer@test.local');

    await completePasswordReset({
      token: issued?.token ?? '',
      newPassword: 'ResetPass!2026xx',
    });

    // Anyone holding a session from before the reset is now signed out.
    expect(await isSessionActive(session.sessionId)).toBe(false);

    await expect(
      login({ email: 'customer@test.local', password: CUSTOMER_PASSWORD, kind: 'CUSTOMER' }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const result = await login({
      email: 'customer@test.local',
      password: 'ResetPass!2026xx',
      kind: 'CUSTOMER',
    });
    expect(result.user.id).toBe(customerUserId);
  });

  it('clears a lockout, so a locked-out owner can recover', async () => {
    await prisma.user.update({
      where: { id: customerUserId },
      data: { failedLoginCount: 8, lockedUntil: new Date(Date.now() + 900_000) },
    });

    const issued = await requestPasswordReset('customer@test.local');
    await completePasswordReset({ token: issued?.token ?? '', newPassword: 'ResetPass!2026xx' });

    const user = await prisma.user.findUniqueOrThrow({ where: { id: customerUserId } });
    expect(user.failedLoginCount).toBe(0);
    expect(user.lockedUntil).toBeNull();
  });

  it('is single use', async () => {
    const issued = await requestPasswordReset('customer@test.local');
    await completePasswordReset({ token: issued?.token ?? '', newPassword: 'ResetPass!2026xx' });

    await expect(
      completePasswordReset({ token: issued?.token ?? '', newPassword: 'Another!2026xx' }),
    ).rejects.toMatchObject({ code: 'TOKEN_ALREADY_USED' });
  });
});
