/**
 * Staff administration.
 *
 * The rule that shapes this file: **an administrator may only grant a role
 * whose permissions they already hold.** Without it, an Order Manager holding
 * `role.assign` could mint a Business Owner and escalate to everything. The
 * check is `canGrantRole` in domain/permissions.ts, which is already tested.
 *
 * A second rule follows from it: a role change takes effect immediately.
 * Sessions carry no permission snapshot - they are resolved per request - but
 * revoking access is a security action, so the affected sessions are revoked
 * anyway rather than trusting that.
 */
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  ADMIN_ROLE_KEYS,
  Role,
  canGrantRole,
  permissionsForRoles,
  roleDefinition,
  type PermissionKey,
} from '../../domain/permissions.js';
import { env } from '../../config/env.js';
import { generateTemporaryPassword, hashPassword } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { normaliseEmail } from './auth.service.js';
import { revokeAllUserSessions } from './session.service.js';

import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';

export interface StaffActor {
  userId: string;
  email: string;
  permissions: readonly PermissionKey[];
  ipAddress?: string | null;
  correlationId?: string | null;
}

export async function listStaff(): Promise<Record<string, unknown>[]> {
  const rows = await prisma.user.findMany({
    where: { type: 'ADMIN' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { roles: { include: { role: true } } },
  });

  return rows.map((user) => {
    const roleKeys = user.roles.map((assignment) => assignment.role.key);

    return {
      id: user.id,
      email: user.email,
      status: user.status,
      roles: user.roles.map((assignment) => ({
        key: assignment.role.key,
        name: assignment.role.name,
        assignedAt: assignment.assignedAt.toISOString(),
        assignedById: assignment.assignedById,
      })),
      // Resolved so the UI can show effective access, not just role names.
      permissions: [...permissionsForRoles(roleKeys)],
      mfaEnabled: user.mfaEnabledAt !== null,
      // Still on the emailed temporary password, so the panel can show the
      // account as pending and offer to send a new one.
      mustChangePassword: user.mustChangePassword,
      /// Never signed in and has no password of its own - either still holding
      /// a temporary one or invited under the old link flow. Drives the
      /// "Resend password" action, which the API gates on the same rule.
      owesAPassword: owesAPassword(user),
      temporaryPasswordExpiresAt: user.temporaryPasswordExpiresAt?.toISOString() ?? null,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      lockedUntil: user.lockedUntil?.toISOString() ?? null,
      archivedAt: user.archivedAt?.toISOString() ?? null,
      createdAt: user.createdAt.toISOString(),
    };
  });
}

/**
 * The roles this administrator may assign.
 *
 * Returned so the UI offers only what the API will accept - a dropdown listing
 * Business Owner to an Order Manager is a dead end and an invitation to try.
 */
export async function assignableRoles(
  actor: StaffActor,
): Promise<{ key: string; name: string; description: string; assignable: boolean }[]> {
  const held = new Set(actor.permissions);

  const roles = await prisma.role.findMany({
    where: { key: { in: [...ADMIN_ROLE_KEYS] } },
    orderBy: { key: 'asc' },
  });

  return roles.map((role) => ({
    key: role.key,
    name: role.name,
    description: role.description ?? '',
    assignable: canGrantRole(held, role.key),
  }));
}

export interface CreateStaffInput {
  email: string;
  roleKeys: string[];
}

/**
 * How long an emailed temporary password stays usable.
 *
 * Shorter than the invitation link it replaces (7 days), because a password is
 * a standing credential sitting in an inbox rather than a single-use link. Long
 * enough that somebody added on a Friday can still get in on Monday.
 */
const TEMPORARY_PASSWORD_TTL_HOURS = 72;

export async function createStaff(
  input: CreateStaffInput,
  actor: StaffActor,
): Promise<{ userId: string; temporaryPasswordExpiresAt: Date }> {
  const emailNormalized = normaliseEmail(input.email);

  const existing = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true },
  });

  if (existing !== null) {
    throw conflict(ErrorCode.CONFLICT, 'An account already exists for that email address.', [
      { field: 'email', code: 'DUPLICATE_EMAIL' },
    ]);
  }

  if (input.roleKeys.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Assign at least one role.', [
      { field: 'roleKeys', code: 'REQUIRED' },
    ]);
  }

  const held = new Set(actor.permissions);

  for (const key of input.roleKeys) {
    if (key === Role.CUSTOMER) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'The customer role cannot be assigned to a staff account.',
        [{ field: 'roleKeys', code: 'INVALID_ROLE' }],
      );
    }

    if (!canGrantRole(held, key)) {
      const definition = roleDefinition(key);
      throw forbidden(
        ErrorCode.PERMISSION_DENIED,
        definition === undefined
          ? `Unknown role: ${key}`
          : `You cannot grant "${definition.name}" - it includes permissions you do not hold.`,
      );
    }
  }

  const roles = await prisma.role.findMany({ where: { key: { in: input.roleKeys } } });
  if (roles.length !== input.roleKeys.length) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'One or more roles were not found.', [
      { field: 'roleKeys', code: 'NOT_FOUND' },
    ]);
  }

  const userId = newId();

  // Generated here, never accepted from the administrator creating the account.
  // The rule the invitation link used to enforce still holds: nobody chooses
  // another person's password. The difference is only that this one is usable
  // once, immediately, instead of being a link.
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const temporaryPasswordExpiresAt = new Date(
    Date.now() + TEMPORARY_PASSWORD_TTL_HOURS * 3_600_000,
  );

  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: userId,
        type: 'ADMIN',
        email: input.email.trim(),
        emailNormalized,
        passwordHash,
        // ACTIVE, because the temporary password has to actually sign in. What
        // stops it being a usable account is `mustChangePassword`, which every
        // admin route refuses until a real password is set.
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
        mustChangePassword: true,
        temporaryPasswordExpiresAt,
        roles: {
          create: roles.map((role) => ({ roleId: role.id, assignedById: actor.userId })),
        },
      },
    });

    // Inside the transaction, so a rolled-back account cannot leave a live
    // password sitting in somebody's inbox.
    await enqueueNotification(
      {
        eventKey: NotificationEvent.STAFF_TEMPORARY_PASSWORD,
        recipientEmail: input.email.trim(),
        variables: {
          email: input.email.trim(),
          temporaryPassword,
          // Staff sign in on the ADMIN origin, not the storefront.
          signInUrl: `${env.ADMIN_WEB_PUBLIC_URL.replace(/\/$/, '')}/login`,
          expiresAt: temporaryPasswordExpiresAt.toISOString(),
        },
        dedupeKey: `staff_temp_password:${userId}:${String(temporaryPasswordExpiresAt.getTime())}`,
        relatedType: 'user',
        relatedId: userId,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.ROLE_ASSIGNED,
        resourceType: 'user',
        resourceId: userId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        // The password itself is deliberately absent. An audit row an operator
        // can read is not a place to put a live credential.
        after: {
          email: input.email,
          roles: input.roleKeys,
          temporaryPasswordSent: true,
          temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  await dispatchPendingNotifications();

  // The password is not returned. It exists in exactly two places: the hash in
  // the database and the one email that was just queued.
  return { userId, temporaryPasswordExpiresAt };
}

/**
 * Whether a staff account may be handed a temporary password.
 *
 * The question is only ever "does this person already have a password of their
 * own?" - and two quite different rows answer no. One is an account still
 * holding the temporary password we emailed. The other is an account created
 * before this flow existed, invited by link and never activated, which has no
 * password at all. Both have never been signed into, and issuing a credential
 * to either takes nothing away from anybody.
 *
 * An account that HAS its own password is refused, whatever its status: from
 * that point the way back in is the reset its holder starts themselves, not a
 * credential a colleague can mint.
 */
function owesAPassword(user: { passwordHash: string | null; mustChangePassword: boolean }): boolean {
  return user.passwordHash === null || user.mustChangePassword;
}

/**
 * Issue a fresh temporary password for a staff account that never signed in.
 *
 * The email went to spam, the 72 hours lapsed, or the account predates this
 * flow entirely and is still waiting on an invitation link that nobody clicked.
 */
export async function reissueTemporaryPassword(
  targetUserId: string,
  actor: StaffActor,
): Promise<{ temporaryPasswordExpiresAt: Date }> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roles: { include: { role: true } } },
  });

  if (target === null || target.type !== 'ADMIN') throw notFound('Staff account');

  if (!owesAPassword(target)) {
    throw conflict(
      ErrorCode.CONFLICT,
      'This account already has a password of its own. Ask the holder to use "Forgot your password" instead.',
      [{ field: 'userId', code: 'PASSWORD_ALREADY_SET' }],
    );
  }

  // Same authority check as re-roling them: handing a new credential to an
  // account more privileged than yours is the same escalation.
  const held = new Set(actor.permissions);
  for (const assignment of target.roles) {
    if (!canGrantRole(held, assignment.role.key)) {
      throw forbidden(
        ErrorCode.PERMISSION_DENIED,
        'You cannot issue a password for an account whose roles include permissions you do not hold.',
      );
    }
  }

  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const temporaryPasswordExpiresAt = new Date(
    Date.now() + TEMPORARY_PASSWORD_TTL_HOURS * 3_600_000,
  );

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: targetUserId },
      data: {
        passwordHash,
        // An account invited under the old link flow is still
        // PENDING_INVITATION and would be refused at sign-in. Handing it a
        // password is what activates it; the block that keeps it harmless
        // until a real password is set is mustChangePassword, not the status.
        status: 'ACTIVE',
        emailVerifiedAt: target.emailVerifiedAt ?? new Date(),
        mustChangePassword: true,
        temporaryPasswordExpiresAt,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    // Any invitation link still outstanding for this account is now a second
    // way in to the same account. One credential at a time.
    await tx.authToken.updateMany({
      where: { userId: targetUserId, type: 'INVITATION', consumedAt: null },
      data: { consumedAt: new Date() },
    });

    await enqueueNotification(
      {
        eventKey: NotificationEvent.STAFF_TEMPORARY_PASSWORD,
        recipientEmail: target.email,
        variables: {
          email: target.email,
          temporaryPassword,
          signInUrl: `${env.ADMIN_WEB_PUBLIC_URL.replace(/\/$/, '')}/login`,
          expiresAt: temporaryPasswordExpiresAt.toISOString(),
        },
        dedupeKey: `staff_temp_password:${targetUserId}:${String(temporaryPasswordExpiresAt.getTime())}`,
        relatedType: 'user',
        relatedId: targetUserId,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.USER_PASSWORD_CHANGED,
        resourceType: 'user',
        resourceId: targetUserId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          via: 'temporary_password_reissued',
          temporaryPasswordExpiresAt: temporaryPasswordExpiresAt.toISOString(),
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // The old temporary password is gone; any session opened with it must go too.
  await revokeAllUserSessions(targetUserId, 'temporary_password_reissued');
  await dispatchPendingNotifications();

  return { temporaryPasswordExpiresAt };
}

/**
 * Replace a staff member's roles.
 *
 * Every role being added AND every role being removed must be within the
 * actor's authority. Without the removal check, a lesser admin could strip a
 * Business Owner's roles and then re-grant their own - a lateral escalation.
 */
export async function setStaffRoles(
  targetUserId: string,
  roleKeys: string[],
  actor: StaffActor,
): Promise<{ sessionsRevoked: number }> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roles: { include: { role: true } } },
  });

  if (target === null || target.type !== 'ADMIN') throw notFound('Staff account');

  if (roleKeys.length === 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A staff account must keep at least one role. Deactivate it instead.',
      [{ field: 'roleKeys', code: 'REQUIRED' }],
    );
  }

  const held = new Set(actor.permissions);
  const currentKeys = target.roles.map((assignment) => assignment.role.key);

  const added = roleKeys.filter((key) => !currentKeys.includes(key));
  const removed = currentKeys.filter((key) => !roleKeys.includes(key));

  for (const key of [...added, ...removed]) {
    if (!canGrantRole(held, key)) {
      const definition = roleDefinition(key);
      throw forbidden(
        ErrorCode.PERMISSION_DENIED,
        `You cannot change "${definition?.name ?? key}" - it includes permissions you do not hold.`,
      );
    }
  }

  /**
   * An administrator must not remove their own last privileged role. Locking
   * yourself out of the only account that can grant roles needs a database fix.
   */
  if (targetUserId === actor.userId && !roleKeys.includes(Role.BUSINESS_OWNER)) {
    if (currentKeys.includes(Role.BUSINESS_OWNER)) {
      const otherOwners = await prisma.userRole.count({
        where: { role: { key: Role.BUSINESS_OWNER }, userId: { not: actor.userId } },
      });

      if (otherOwners === 0) {
        throw conflict(
          ErrorCode.CONFLICT,
          'You are the only Business Owner. Promote someone else before removing your own role.',
          [{ field: 'roleKeys', code: 'LAST_OWNER' }],
        );
      }
    }
  }

  const roles = await prisma.role.findMany({ where: { key: { in: roleKeys } } });
  if (roles.length !== roleKeys.length) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'One or more roles were not found.', [
      { field: 'roleKeys', code: 'NOT_FOUND' },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    await tx.userRole.deleteMany({ where: { userId: targetUserId } });
    await tx.userRole.createMany({
      data: roles.map((role) => ({
        userId: targetUserId,
        roleId: role.id,
        assignedById: actor.userId,
      })),
    });

    await recordAudit(
      {
        action: removed.length > 0 ? AuditAction.ROLE_REVOKED : AuditAction.ROLE_ASSIGNED,
        resourceType: 'user',
        resourceId: targetUserId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { roles: currentKeys },
        after: { roles: roleKeys, added, removed },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // Permissions are resolved per request, so a change is already live. Sessions
  // are revoked anyway when access was REMOVED: an in-flight request holding a
  // stale context is not a risk worth reasoning about.
  const sessionsRevoked =
    removed.length > 0 ? await revokeAllUserSessions(targetUserId, 'roles_changed') : 0;

  return { sessionsRevoked };
}

export async function setStaffStatus(
  targetUserId: string,
  active: boolean,
  actor: StaffActor,
  reason?: string,
): Promise<{ sessionsRevoked: number }> {
  const target = await prisma.user.findUnique({
    where: { id: targetUserId },
    include: { roles: { include: { role: true } } },
  });

  if (target === null || target.type !== 'ADMIN') throw notFound('Staff account');

  if (targetUserId === actor.userId && !active) {
    throw conflict(ErrorCode.CONFLICT, 'You cannot deactivate your own account.', [
      { field: 'active', code: 'SELF_DEACTIVATION' },
    ]);
  }

  const targetKeys = target.roles.map((assignment) => assignment.role.key);
  const held = new Set(actor.permissions);

  // Deactivating someone more privileged than you is the same escalation risk
  // as re-roling them.
  for (const key of targetKeys) {
    if (!canGrantRole(held, key)) {
      throw forbidden(
        ErrorCode.PERMISSION_DENIED,
        'You cannot change an account whose roles include permissions you do not hold.',
      );
    }
  }

  if (!active && targetKeys.includes(Role.BUSINESS_OWNER)) {
    const otherOwners = await prisma.userRole.count({
      where: {
        role: { key: Role.BUSINESS_OWNER },
        userId: { not: targetUserId },
        user: { status: 'ACTIVE', archivedAt: null },
      },
    });

    if (otherOwners === 0) {
      throw conflict(
        ErrorCode.CONFLICT,
        'This is the only active Business Owner. Promote someone else first.',
        [{ field: 'active', code: 'LAST_OWNER' }],
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: targetUserId },
      data: {
        status: active ? (target.passwordHash === null ? 'PENDING_INVITATION' : 'ACTIVE') : 'DEACTIVATED',
      },
    });

    await recordAudit(
      {
        action: AuditAction.CUSTOMER_STATUS_CHANGED,
        resourceType: 'user',
        resourceId: targetUserId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: target.status },
        after: { status: active ? 'ACTIVE' : 'DEACTIVATED', reason: reason ?? null },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  const sessionsRevoked = active
    ? 0
    : await revokeAllUserSessions(targetUserId, reason ?? 'deactivated_by_admin');

  return { sessionsRevoked };
}
