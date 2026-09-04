/**
 * Authentication.
 *
 * One identity service, two sign-in contexts. An admin credential presented at
 * the customer endpoint fails, and vice versa - the check is on `users.type`,
 * before the password is even compared, so the two surfaces cannot be used to
 * probe each other's account list.
 *
 * Failure responses are deliberately uniform: unknown email, wrong password and
 * unverified account all return INVALID_CREDENTIALS with the same shape and a
 * comparable timing profile. Only a locked account is disclosed, because the
 * user genuinely needs to know why waiting will help.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, unauthorized } from '../../domain/errors.js';
import { permissionsForRoles, type PermissionKey } from '../../domain/permissions.js';
import { hashPassword, needsRehash, verifyPassword } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { issueSession, revokeAllUserSessions, type IssuedSession } from './session.service.js';

export type UserKind = 'ADMIN' | 'CUSTOMER';

export interface LoginInput {
  email: string;
  password: string;
  kind: UserKind;
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  type: UserKind;
  roles: string[];
  permissions: PermissionKey[];
  customerProfileId: string | null;
  mfaEnabled: boolean;
  /**
   * Signed in on a system-issued temporary password. The session is real, but
   * `requireAdmin` refuses every route until a password of their own is set.
   */
  mustChangePassword: boolean;
}

export interface LoginResult {
  user: AuthenticatedUser;
  session: IssuedSession;
}

/** Emails are compared case-insensitively; `emailNormalized` is the unique key. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * A dummy Argon2id digest, verified against when the account does not exist.
 *
 * Without this, "unknown email" returns in ~1ms while "wrong password" takes
 * ~50ms, and the difference enumerates the customer list. Generated once at
 * module load with the same cost parameters as real hashes.
 */
let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(`timing-equaliser-${newId()}`);
  return dummyHashPromise;
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const emailNormalized = normaliseEmail(input.email);

  const user = await prisma.user.findUnique({
    where: { emailNormalized },
    include: {
      roles: { include: { role: { select: { key: true } } } },
      customerProfile: { select: { id: true } },
    },
  });

  // Wrong surface entirely: an admin at the customer login, or the reverse.
  // Treated exactly like an unknown account so neither surface can enumerate
  // the other's users.
  const wrongContext = user !== null && user.type !== input.kind;

  if (user === null || wrongContext) {
    await verifyPassword(await dummyHash(), input.password);
    await recordFailedAttempt(emailNormalized, input, 'unknown_account');
    throw unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.');
  }

  if (user.lockedUntil !== null && user.lockedUntil.getTime() > Date.now()) {
    const minutes = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    await recordFailedAttempt(emailNormalized, input, 'locked');
    throw unauthorized(
      ErrorCode.ACCOUNT_LOCKED,
      `Too many failed attempts. Try again in ${String(minutes)} minute(s).`,
    );
  }

  if (user.archivedAt !== null || user.status === 'DEACTIVATED') {
    await recordFailedAttempt(emailNormalized, input, 'deactivated');
    throw unauthorized(ErrorCode.ACCOUNT_DEACTIVATED, 'This account has been deactivated.');
  }

  if (user.status === 'PENDING_INVITATION') {
    await recordFailedAttempt(emailNormalized, input, 'not_activated');
    throw unauthorized(
      ErrorCode.ACCOUNT_NOT_ACTIVATED,
      'This account has not been activated yet. Please use the invitation link that was emailed to you.',
    );
  }

  if (user.status === 'PENDING_APPROVAL') {
    await recordFailedAttempt(emailNormalized, input, 'pending_approval');
    throw unauthorized(
      ErrorCode.ACCOUNT_NOT_ACTIVATED,
      'This account is awaiting approval by an administrator.',
    );
  }

  // An active account always has a password hash; the null branch means the
  // row is inconsistent, and it must not be treated as "no password required".
  if (user.passwordHash === null) {
    await verifyPassword(await dummyHash(), input.password);
    await recordFailedAttempt(emailNormalized, input, 'no_credential');
    throw unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.');
  }

  const passwordMatches = await verifyPassword(user.passwordHash, input.password);

  if (!passwordMatches) {
    await registerFailure(user.id, user.failedLoginCount);
    await recordFailedAttempt(emailNormalized, input, 'wrong_password');
    throw unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Email or password is incorrect.');
  }

  // Checked AFTER the password, on purpose. Disclosing "that temporary password
  // has expired" to somebody who does not know it would confirm the account
  // exists and that it has never been used - two things worth knowing to an
  // attacker and to nobody else.
  if (
    user.mustChangePassword &&
    user.temporaryPasswordExpiresAt !== null &&
    user.temporaryPasswordExpiresAt.getTime() <= Date.now()
  ) {
    await recordFailedAttempt(emailNormalized, input, 'temporary_password_expired');
    throw unauthorized(
      ErrorCode.TEMPORARY_PASSWORD_EXPIRED,
      'This temporary password has expired. Ask whoever set the account up to issue a new one.',
    );
  }

  // Transparent upgrade when the cost policy has been raised since sign-up.
  if (needsRehash(user.passwordHash)) {
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.password) },
    });
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
  });

  const roleKeys = user.roles.map((assignment) => assignment.role.key);

  const session = await issueSession(user.id, input.kind, {
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    correlationId: input.correlationId ?? null,
  });

  await prisma.loginAttempt.create({
    data: {
      id: newId(),
      emailNormalized,
      userType: input.kind,
      ipAddress: input.ipAddress ?? null,
      success: true,
    },
  });

  await recordAudit({
    action: AuditAction.USER_LOGIN,
    resourceType: 'user',
    resourceId: user.id,
    actorType: input.kind,
    actorUserId: user.id,
    actorEmail: user.email,
    after: { sessionId: session.sessionId, roles: roleKeys },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    correlationId: input.correlationId ?? null,
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      type: input.kind,
      roles: roleKeys,
      permissions: [...permissionsForRoles(roleKeys)],
      customerProfileId: user.customerProfile?.id ?? null,
      mfaEnabled: user.mfaEnabledAt !== null,
      mustChangePassword: user.mustChangePassword,
    },
    session,
  };
}

/**
 * Count a failed attempt and lock the account once the threshold is reached.
 *
 * This is per-account and complements the per-IP rate limit on the route: one
 * stops a single account being ground down from many addresses, the other stops
 * one address spraying many accounts.
 */
async function registerFailure(userId: string, currentCount: number): Promise<void> {
  const nextCount = currentCount + 1;
  const shouldLock = nextCount >= env.LOGIN_LOCKOUT_THRESHOLD;

  await prisma.user.update({
    where: { id: userId },
    data: {
      failedLoginCount: nextCount,
      lockedUntil: shouldLock
        ? new Date(Date.now() + env.LOGIN_LOCKOUT_MINUTES * 60_000)
        : null,
    },
  });
}

async function recordFailedAttempt(
  emailNormalized: string,
  input: LoginInput,
  reason: string,
): Promise<void> {
  await prisma.loginAttempt.create({
    data: {
      id: newId(),
      emailNormalized,
      userType: input.kind,
      ipAddress: input.ipAddress ?? null,
      success: false,
      failureReason: reason,
    },
  });

  await recordAudit({
    action: AuditAction.USER_LOGIN_FAILED,
    resourceType: 'user',
    actorType: 'SYSTEM',
    // The reason is recorded for operators; it is never returned to the client.
    after: { emailNormalized, reason, kind: input.kind },
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
    correlationId: input.correlationId ?? null,
  });
}

/** Load the authorization context for an already-authenticated request. */
export async function loadAuthenticatedUser(
  userId: string,
  expectedKind: UserKind,
): Promise<AuthenticatedUser | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      roles: { include: { role: { select: { key: true } } } },
      customerProfile: { select: { id: true } },
    },
  });

  if (user === null || user.archivedAt !== null || user.status !== 'ACTIVE') return null;
  // Guards against an access token minted for one surface being replayed at the
  // other, even though the signature is valid.
  if (user.type !== expectedKind) return null;

  const roleKeys = user.roles.map((assignment) => assignment.role.key);

  return {
    id: user.id,
    email: user.email,
    type: user.type,
    roles: roleKeys,
    permissions: [...permissionsForRoles(roleKeys)],
    customerProfileId: user.customerProfile?.id ?? null,
    mfaEnabled: user.mfaEnabledAt !== null,
    mustChangePassword: user.mustChangePassword,
  };
}

export interface ChangePasswordInput {
  userId: string;
  currentPassword: string;
  newPassword: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * Change a password and end every other session.
 *
 * Revoking all sessions is the point: if the password is being changed because
 * it leaked, leaving old sessions alive defeats the change entirely.
 */
export async function changePassword(input: ChangePasswordInput): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true, email: true, type: true, passwordHash: true, mustChangePassword: true },
  });

  if (user === null || user.passwordHash === null) {
    throw unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect.');
  }

  if (!(await verifyPassword(user.passwordHash, input.currentPassword))) {
    throw unauthorized(ErrorCode.INVALID_CREDENTIALS, 'Current password is incorrect.');
  }

  if (input.currentPassword === input.newPassword) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The new password must be different from the current one.',
      [{ field: 'newPassword', code: 'PASSWORD_UNCHANGED' }],
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(input.newPassword),
      // Whatever this account was before, it now has a password of its own.
      // Clearing both is what lifts the block in `requireAdmin`.
      mustChangePassword: false,
      temporaryPasswordExpiresAt: null,
    },
  });

  const revoked = await revokeAllUserSessions(user.id, 'password_changed');

  await recordAudit({
    action: AuditAction.USER_PASSWORD_CHANGED,
    resourceType: 'user',
    resourceId: user.id,
    actorType: user.type,
    actorUserId: user.id,
    actorEmail: user.email,
    after: { sessionsRevoked: revoked, wasTemporaryPassword: user.mustChangePassword },
    ipAddress: input.ipAddress ?? null,
    correlationId: input.correlationId ?? null,
  });
}
