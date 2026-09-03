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
import { hashPassword } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { normaliseEmail } from './auth.service.js';
import { revokeAllUserSessions } from './session.service.js';
import { buildTokenUrl, issueToken } from './token.service.js';
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
  /**
   * Optional. Omitted, the account is created pending and an invitation is
   * emailed - the same path customers use, so no administrator ever types
   * another person's password.
   */
  temporaryPassword?: string | null;
}

export async function createStaff(
  input: CreateStaffInput,
  actor: StaffActor,
): Promise<{ userId: string; invitationSent: boolean }> {
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
  const sendInvitation = input.temporaryPassword === null || input.temporaryPassword === undefined;

  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: userId,
        type: 'ADMIN',
        email: input.email.trim(),
        emailNormalized,
        passwordHash:
          input.temporaryPassword === null || input.temporaryPassword === undefined
            ? null
            : await hashPassword(input.temporaryPassword),
        status: sendInvitation ? 'PENDING_INVITATION' : 'ACTIVE',
        emailVerifiedAt: sendInvitation ? null : new Date(),
        roles: {
          create: roles.map((role) => ({ roleId: role.id, assignedById: actor.userId })),
        },
      },
    });

    if (sendInvitation) {
      const invitation = await issueToken(userId, 'INVITATION', actor.userId, tx);

      await enqueueNotification(
        {
          eventKey: NotificationEvent.CUSTOMER_INVITATION,
          recipientEmail: input.email.trim(),
          variables: {
            // Staff activate on the ADMIN origin, not the storefront.
            activationUrl: buildTokenUrl('INVITATION', invitation.token, 'ADMIN'),
            expiresAt: invitation.expiresAt.toISOString(),
          },
          dedupeKey: `staff_invitation:${userId}:${invitation.expiresAt.getTime()}`,
          relatedType: 'user',
          relatedId: userId,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }

    await recordAudit(
      {
        action: AuditAction.ROLE_ASSIGNED,
        resourceType: 'user',
        resourceId: userId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { email: input.email, roles: input.roleKeys, invitationSent: sendInvitation },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  if (sendInvitation) await dispatchPendingNotifications();

  return { userId, invitationSent: sendInvitation };
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
