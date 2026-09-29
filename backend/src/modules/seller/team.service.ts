/**
 * Who works on a seller account, and as what (checklist Master row 14).
 *
 * THE RULES
 *
 *   - Seeing the team, its invitations and the access-review facts needs
 *     `seller.member.read`; inviting, resending, withdrawing, changing a role,
 *     removing and recording a review need `seller.member.write`. Only OWNER
 *     and ADMIN hold either.
 *   - Nobody grants a role carrying a permission they do not hold
 *     (`canGrantSellerRole`), and nobody changes or removes a member whose
 *     current role carries one - so an admin can neither mint an owner nor
 *     touch one.
 *   - OWNER is never handed out by invitation. An owner makes somebody an
 *     owner by changing the role of a person already on the team.
 *   - The last owner cannot be removed or demoted (`SELLER_LAST_OWNER`). The
 *     owner holds `seller.member.write`, so this is also what guarantees that
 *     somebody can always manage the team.
 *   - Nobody changes or removes themselves.
 *   - Accepting needs a signed-in account whose VERIFIED email is the one
 *     invited. Every way a link can be unusable gets the same answer
 *     (`SELLER_INVITATION_INVALID`), so the endpoint cannot be used to learn
 *     who was invited where. Accepting twice is harmless.
 *
 * The seller account id always comes from the caller's membership, which
 * `requireSeller` resolved from the session: an invitation or member id from
 * another seller reads as not found. Every change is written to the
 * operator's audit log inside the same transaction - a change that cannot be
 * audited does not happen - and to the seller's own activity log in words for
 * the seller.
 */
import { randomBytes } from 'node:crypto';
import type { SellerMemberRole } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { AppError, ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  SellerPermission,
  canGrantSellerRole,
  type SellerRoleKey,
} from '../../domain/seller-permissions.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  accessReviewSummary,
  activityForUsers,
  hubActivityForSeller,
  insertAccessReview,
  namesForProfiles,
  type AccessReviewSummary,
} from '../access-review/access-review.service.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { NotificationEvent, enqueueNotification } from '../notifications/notification.service.js';
import { assertSellerPermission, type SellerMembership } from './account.service.js';
import { recordSellerAudit } from './audit.service.js';
import { renderSellerInvitationEmail } from './team-invitation-email.js';

type Tx = PrismaTransaction;

/** Roles an invitation may give. Never OWNER. */
export const SELLER_INVITABLE_ROLES = [
  'ADMIN',
  'CATALOGUE_MANAGER',
  'INVENTORY_MANAGER',
  'ORDER_MANAGER',
  'FINANCE_VIEWER',
  'SUPPORT_MEMBER',
] as const;
export type SellerInvitableRole = (typeof SELLER_INVITABLE_ROLES)[number];

/** Every role, in the order screens list them. */
export const SELLER_ROLES: readonly SellerRoleKey[] = ['OWNER', ...SELLER_INVITABLE_ROLES];

/** Times one invitation email may be sent, the first included. */
export const SELLER_INVITATION_MAX_SENDS = 5;

/** The signed-in person acting, as the routes hand them over. */
export interface SellerTeamActor {
  membership: SellerMembership;
  userId: string;
  email: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface SellerTeamMemberView {
  id: string;
  name: string;
  email: string;
  role: SellerMemberRole;
  joinedAt: string;
  isYou: boolean;
  /** Whether the caller may change this member's role or remove them. */
  canChange: boolean;
  /** Who invited them, or null for the person who opened the account. */
  invitedByName: string | null;
  lastSignInAt: string | null;
  lastActiveAt: string | null;
  /** Last deliberate use of this seller's Hub. */
  lastHubActivityAt: string | null;
}

export interface SellerTeamInvitationView {
  id: string;
  email: string;
  role: SellerMemberRole;
  expiresAt: string;
  expired: boolean;
  sendCount: number;
  lastSentAt: string;
  invitedByName: string | null;
  canChange: boolean;
}

export interface SellerTeamView {
  yourRole: SellerMemberRole;
  canManage: boolean;
  /** Roles the caller may give by role change. Empty when they cannot manage. */
  assignableRoles: SellerRoleKey[];
  /** Roles the caller may give by invitation. Never OWNER. */
  invitableRoles: SellerInvitableRole[];
  members: SellerTeamMemberView[];
  /** Live invitations, newest first. Empty for anybody who cannot manage. */
  invitations: SellerTeamInvitationView[];
  accessReview: AccessReviewSummary;
}

const normalize = (email: string): string => email.trim().toLowerCase();
const liveKeyOf = (sellerAccountId: string, emailNormalized: string): string => `${sellerAccountId}:${emailNormalized}`;
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

// ---------------------------------------------------------------------------
// Protection
// ---------------------------------------------------------------------------

export function protectedMember(code: 'SELF' | 'ROLE_ABOVE_YOURS'): never {
  const message = {
    SELF: 'You cannot change or remove yourself. Ask another owner or admin.',
    ROLE_ABOVE_YOURS: 'That person holds permissions you do not, so you cannot change or remove them.',
  }[code];
  throw new AppError({ statusCode: 403, code: ErrorCode.SELLER_MEMBER_PROTECTED, message, details: [{ code }] });
}

function assertCanGrant(membership: SellerMembership, role: SellerRoleKey): void {
  if (!canGrantSellerRole(membership.role, role)) {
    throw forbidden(ErrorCode.SELLER_ROLE_DENIED, 'You cannot grant a role that carries more than your own.');
  }
}

/**
 * Hold the owner rows until this transaction ends, and count them.
 *
 * `FOR UPDATE` so two owners demoting each other at the same moment cannot
 * both see "two owners" and leave none: the second waits, then counts one.
 */
export async function lockedOwnerCount(tx: Tx, sellerAccountId: string): Promise<number> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM seller_members
    WHERE sellerAccountId = ${sellerAccountId} AND role = 'OWNER' AND removedAt IS NULL
    FOR UPDATE`;
  return rows.length;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Who did it, as the two logs record it. */
export interface TeamAuditActor {
  sellerAccountId: string;
  customerProfileId: string;
  userId: string;
  email: string | null;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export function teamAuditActor(actor: SellerTeamActor): TeamAuditActor {
  return {
    sellerAccountId: actor.membership.sellerAccountId,
    customerProfileId: actor.membership.customerProfileId,
    userId: actor.userId,
    email: actor.email,
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  };
}

/** What the seller's own log shows as "who": the person's name, else their email. */
async function actorName(client: Tx | typeof prisma, customerProfileId: string): Promise<string | null> {
  const profile = await client.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: { fullName: true, user: { select: { email: true } } },
  });
  const name = profile?.fullName?.trim() ?? '';
  return name !== '' ? name : (profile?.user.email ?? null);
}

/**
 * Write one membership change to both logs.
 *
 * The operator's log first and inside the transaction, so a failure there
 * rolls the change back; the seller's own log never throws.
 */
export async function auditTeamChange(
  tx: Tx,
  actor: TeamAuditActor,
  entry: {
    action: (typeof AuditAction)[keyof typeof AuditAction];
    resourceType: 'seller_member' | 'seller_invitation' | 'team_access_review';
    resourceId: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
    summary: string;
  },
): Promise<void> {
  const sellerAccountId = actor.sellerAccountId;
  await recordAudit(
    {
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      actorType: 'CUSTOMER',
      actorUserId: actor.userId,
      actorEmail: actor.email,
      before: entry.before === null ? null : { sellerAccountId, ...entry.before },
      after: entry.after === null ? null : { sellerAccountId, ...entry.after },
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
  await recordSellerAudit({
    sellerAccountId,
    action: entry.action,
    actor: { type: 'CUSTOMER', userId: actor.userId, label: await actorName(tx, actor.customerProfileId) },
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    ...(entry.before === null ? {} : { before: entry.before }),
    ...(entry.after === null ? {} : { after: entry.after }),
    summary: entry.summary,
    correlationId: actor.correlationId ?? null,
    tx,
  });
}

// ---------------------------------------------------------------------------
// Reading the team
// ---------------------------------------------------------------------------

export async function readSellerTeam(actor: Pick<SellerTeamActor, 'membership'>): Promise<SellerTeamView> {
  const { membership } = actor;
  assertSellerPermission(membership, SellerPermission.MEMBER_READ);
  const sellerAccountId = membership.sellerAccountId;
  const canManage = membership.permissions.has(SellerPermission.MEMBER_WRITE);

  const [members, invitations] = await Promise.all([
    prisma.sellerMember.findMany({
      where: { sellerAccountId, removedAt: null },
      orderBy: { joinedAt: 'asc' },
      select: {
        id: true,
        role: true,
        joinedAt: true,
        customerProfileId: true,
        invitedByProfileId: true,
        customerProfile: { select: { fullName: true, userId: true, user: { select: { email: true } } } },
      },
    }),
    canManage
      ? prisma.sellerInvitation.findMany({
          where: { sellerAccountId, liveKey: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 100,
        })
      : Promise.resolve([]),
  ]);

  const userIds = members.map((member) => member.customerProfile.userId);
  const [activity, hub, inviters, accessReview] = await Promise.all([
    activityForUsers(userIds),
    hubActivityForSeller(sellerAccountId, userIds),
    namesForProfiles([...members.map((member) => member.invitedByProfileId), ...invitations.map((row) => row.invitedByProfileId)]),
    accessReviewSummary({ sellerAccountId }),
  ]);
  const now = Date.now();

  return {
    yourRole: membership.role,
    canManage,
    assignableRoles: canManage ? SELLER_ROLES.filter((role) => canGrantSellerRole(membership.role, role)) : [],
    invitableRoles: canManage ? SELLER_INVITABLE_ROLES.filter((role) => canGrantSellerRole(membership.role, role)) : [],
    members: members.map((member) => {
      const isYou = member.id === membership.memberId;
      const seen = activity.get(member.customerProfile.userId);
      return {
        id: member.id,
        name: member.customerProfile.fullName ?? '',
        email: member.customerProfile.user.email,
        role: member.role,
        joinedAt: member.joinedAt.toISOString(),
        isYou,
        canChange: canManage && !isYou && canGrantSellerRole(membership.role, member.role),
        invitedByName: member.invitedByProfileId === null ? null : (inviters.get(member.invitedByProfileId) ?? null),
        lastSignInAt: seen?.lastSignInAt ?? null,
        lastActiveAt: seen?.lastActiveAt ?? null,
        lastHubActivityAt: hub.get(member.customerProfile.userId) ?? null,
      };
    }),
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      expired: invitation.expiresAt.getTime() <= now,
      sendCount: invitation.sendCount,
      lastSentAt: invitation.lastSentAt.toISOString(),
      invitedByName: invitation.invitedByProfileId === null ? null : (inviters.get(invitation.invitedByProfileId) ?? null),
      canChange: canGrantSellerRole(membership.role, invitation.role),
    })),
    accessReview,
  };
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

function acceptUrl(token: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/join-seller?token=${token}`;
}

async function sendInvitationEmail(
  tx: Tx,
  actor: SellerTeamActor,
  input: { email: string; role: SellerRoleKey; token: string; expiresAt: Date },
): Promise<void> {
  const inviter = await tx.user.findUnique({
    where: { id: actor.userId },
    select: { email: true, preferredLanguage: true, customerProfile: { select: { fullName: true } } },
  });
  const message = renderSellerInvitationEmail(inviter?.preferredLanguage, {
    seller: actor.membership.displayName,
    inviter: inviter?.customerProfile?.fullName ?? inviter?.email ?? '',
    role: input.role,
    url: acceptUrl(input.token),
    expires: input.expiresAt.toISOString().slice(0, 10),
  });
  await enqueueNotification(
    {
      eventKey: NotificationEvent.SELLER_TEAM_INVITATION,
      recipientEmail: input.email,
      variables: { subjectLine: message.subject, bodyText: message.body },
      relatedType: 'seller_account',
      relatedId: actor.membership.sellerAccountId,
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
}

const expiryFromNow = (): Date => new Date(Date.now() + env.SELLER_INVITE_TTL_HOURS * 3_600_000);
const newToken = (): string => randomBytes(32).toString('base64url');

export async function inviteSellerMember(
  actor: SellerTeamActor,
  input: { email: string; role: SellerInvitableRole },
): Promise<SellerTeamView> {
  const { membership } = actor;
  assertSellerPermission(membership, SellerPermission.MEMBER_WRITE);
  assertCanGrant(membership, input.role);

  const sellerAccountId = membership.sellerAccountId;
  const email = input.email.trim();
  const emailNormalized = normalize(email);
  const liveKey = liveKeyOf(sellerAccountId, emailNormalized);
  const expiresAt = expiryFromNow();
  const token = newToken();

  try {
    await prisma.$transaction(async (tx) => {
      const already = await tx.sellerMember.count({
        where: { sellerAccountId, removedAt: null, customerProfile: { user: { emailNormalized } } },
      });
      if (already > 0) {
        throw conflict(ErrorCode.SELLER_ALREADY_MEMBER, 'That person is already on the team. Change their role instead.');
      }

      const live = await tx.sellerInvitation.findUnique({ where: { liveKey } });
      if (live !== null) {
        if (live.expiresAt.getTime() > Date.now()) {
          throw conflict(ErrorCode.SELLER_INVITATION_EXISTS, 'That address already has an invitation. Resend it instead.', [
            { code: 'EXISTS', meta: { invitationId: live.id } },
          ]);
        }
        // Lapsed: retired, kept for the record, and replaced by this one.
        await tx.sellerInvitation.update({ where: { id: live.id }, data: { liveKey: null } });
      }

      const id = newId();
      await tx.sellerInvitation.create({
        data: {
          id,
          sellerAccountId,
          email,
          emailNormalized,
          role: input.role,
          tokenHash: sha256Hex(token),
          liveKey,
          expiresAt,
          lastSentAt: new Date(),
          invitedByProfileId: membership.customerProfileId,
        },
      });
      await auditTeamChange(tx, teamAuditActor(actor), {
        action: AuditAction.SELLER_MEMBER_INVITED,
        resourceType: 'seller_invitation',
        resourceId: id,
        before: null,
        after: { email: emailNormalized, role: input.role, expiresAt: expiresAt.toISOString() },
        summary: `${email} was invited to the team as ${input.role}.`,
      });
      await sendInvitationEmail(tx, actor, { email, role: input.role, token, expiresAt });
    });
  } catch (error) {
    // Two invitations to one address at the same moment: the UNIQUE live key
    // lets one through, and this is the other.
    if (isUniqueViolation(error)) {
      throw conflict(ErrorCode.SELLER_INVITATION_EXISTS, 'That address already has an invitation. Resend it instead.');
    }
    throw error;
  }
  return readSellerTeam(actor);
}

async function liveInvitation(tx: Tx, membership: SellerMembership, invitationId: string) {
  const invitation = await tx.sellerInvitation.findFirst({
    where: { id: invitationId, sellerAccountId: membership.sellerAccountId, liveKey: { not: null } },
  });
  if (invitation === null) throw notFound('Invitation');
  if (!canGrantSellerRole(membership.role, invitation.role)) protectedMember('ROLE_ABOVE_YOURS');
  return invitation;
}

/** Send the email again with a new link and a new expiry. The old link stops working. */
export async function resendSellerInvitation(actor: SellerTeamActor, invitationId: string): Promise<SellerTeamView> {
  assertSellerPermission(actor.membership, SellerPermission.MEMBER_WRITE);
  const token = newToken();
  const expiresAt = expiryFromNow();

  await prisma.$transaction(async (tx) => {
    const invitation = await liveInvitation(tx, actor.membership, invitationId);
    if (invitation.sendCount >= SELLER_INVITATION_MAX_SENDS) {
      throw conflict(
        ErrorCode.SELLER_INVITATION_SEND_LIMIT,
        'This invitation has been sent as many times as it can be. Withdraw it and invite again.',
        [{ code: 'MAX_SENDS', meta: { max: SELLER_INVITATION_MAX_SENDS } }],
      );
    }
    // Conditional on the count read: two resends at once make one.
    const resent = await tx.sellerInvitation.updateMany({
      where: { id: invitation.id, liveKey: { not: null }, sendCount: invitation.sendCount },
      data: { tokenHash: sha256Hex(token), expiresAt, sendCount: { increment: 1 }, lastSentAt: new Date() },
    });
    if (resent.count === 0) throw notFound('Invitation');
    await auditTeamChange(tx, teamAuditActor(actor), {
      action: AuditAction.SELLER_INVITATION_RESENT,
      resourceType: 'seller_invitation',
      resourceId: invitation.id,
      before: { expiresAt: invitation.expiresAt.toISOString(), sendCount: invitation.sendCount },
      after: { expiresAt: expiresAt.toISOString(), sendCount: invitation.sendCount + 1 },
      summary: `The invitation to ${invitation.email} was sent again.`,
    });
    await sendInvitationEmail(tx, actor, { email: invitation.email, role: invitation.role, token, expiresAt });
  });
  return readSellerTeam(actor);
}

/** Withdraw an invitation nobody has accepted. Its link stops working at once. */
export async function revokeSellerInvitation(actor: SellerTeamActor, invitationId: string): Promise<SellerTeamView> {
  assertSellerPermission(actor.membership, SellerPermission.MEMBER_WRITE);
  await prisma.$transaction(async (tx) => {
    const invitation = await liveInvitation(tx, actor.membership, invitationId);
    const revoked = await tx.sellerInvitation.updateMany({
      where: { id: invitation.id, liveKey: { not: null } },
      data: { liveKey: null, revokedAt: new Date(), revokedByProfileId: actor.membership.customerProfileId },
    });
    if (revoked.count === 0) throw notFound('Invitation');
    await auditTeamChange(tx, teamAuditActor(actor), {
      action: AuditAction.SELLER_INVITATION_REVOKED,
      resourceType: 'seller_invitation',
      resourceId: invitation.id,
      before: { email: invitation.emailNormalized, role: invitation.role },
      after: { revoked: true },
      summary: `The invitation to ${invitation.email} was withdrawn.`,
    });
  });
  return readSellerTeam(actor);
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

/** A member of the caller's own seller whom the caller may change. */
async function changeableMember(tx: Tx, membership: SellerMembership, memberId: string) {
  const target = await tx.sellerMember.findFirst({
    where: { id: memberId, sellerAccountId: membership.sellerAccountId, removedAt: null },
    select: { id: true, role: true, customerProfileId: true, customerProfile: { select: { user: { select: { email: true } } } } },
  });
  if (target === null) throw notFound('Team member');
  if (target.id === membership.memberId) protectedMember('SELF');
  if (!canGrantSellerRole(membership.role, target.role)) protectedMember('ROLE_ABOVE_YOURS');
  return target;
}

/**
 * Change somebody's role, or refuse.
 *
 * Refused when it would grant a role carrying more than the caller's own
 * (`SELLER_ROLE_DENIED`), when the person is the caller or holds more than
 * the caller (`SELLER_MEMBER_PROTECTED`), or when it would demote the last
 * owner (`SELLER_LAST_OWNER`). The role is written conditionally on the one
 * read, so two admins changing one person at once make one change each.
 * Takes effect on the member's next request: `requireSeller` re-reads the
 * membership every time.
 */
export async function changeSellerMemberRole(
  actor: SellerTeamActor,
  targetMemberId: string,
  nextRole: SellerMemberRole,
): Promise<void> {
  const { membership } = actor;
  assertSellerPermission(membership, SellerPermission.MEMBER_WRITE);
  assertCanGrant(membership, nextRole);

  await prisma.$transaction(async (tx) => {
    const target = await changeableMember(tx, membership, targetMemberId);
    if (target.role === nextRole) return;

    if (target.role === 'OWNER' && (await lockedOwnerCount(tx, membership.sellerAccountId)) <= 1) {
      throw conflict(ErrorCode.SELLER_LAST_OWNER, 'This is the only owner of the account. Make somebody else an owner first.');
    }

    const changed = await tx.sellerMember.updateMany({
      where: { id: target.id, removedAt: null, role: target.role },
      data: { role: nextRole },
    });
    if (changed.count === 0) {
      throw conflict(ErrorCode.SELLER_STALE_VERSION, 'Somebody else changed this member meanwhile. Reload and try again.');
    }

    await auditTeamChange(tx, teamAuditActor(actor), {
      action: AuditAction.SELLER_MEMBER_ROLE_CHANGED,
      resourceType: 'seller_member',
      resourceId: target.id,
      before: { customerProfileId: target.customerProfileId, role: target.role },
      after: { customerProfileId: target.customerProfileId, role: nextRole },
      summary: `${target.customerProfile.user.email}'s role changed from ${target.role} to ${nextRole}.`,
    });
  });
}

/**
 * Remove somebody, keeping the row so their past actions still name a person.
 * Same protections as a role change; the last owner cannot be removed. Their
 * access ends on their next request.
 */
export async function removeSellerMember(actor: SellerTeamActor, targetMemberId: string): Promise<void> {
  const { membership } = actor;
  assertSellerPermission(membership, SellerPermission.MEMBER_WRITE);

  await prisma.$transaction(async (tx) => {
    const target = await changeableMember(tx, membership, targetMemberId);

    if (target.role === 'OWNER' && (await lockedOwnerCount(tx, membership.sellerAccountId)) <= 1) {
      throw conflict(ErrorCode.SELLER_LAST_OWNER, 'This is the only owner of the account and cannot be removed.');
    }

    const removed = await tx.sellerMember.updateMany({
      where: { id: target.id, removedAt: null },
      data: { removedAt: new Date() },
    });
    if (removed.count === 0) throw notFound('Team member');

    await auditTeamChange(tx, teamAuditActor(actor), {
      action: AuditAction.SELLER_MEMBER_REMOVED,
      resourceType: 'seller_member',
      resourceId: target.id,
      before: { customerProfileId: target.customerProfileId, role: target.role },
      after: { customerProfileId: target.customerProfileId, removed: true },
      summary: `${target.customerProfile.user.email} was removed from the team.`,
    });
  });
}

// ---------------------------------------------------------------------------
// Access review
// ---------------------------------------------------------------------------

/**
 * Record that the caller has checked who has access, as the team stands now.
 * The screen shows the facts first; this is the signature under them.
 */
export async function recordSellerAccessReview(actor: SellerTeamActor): Promise<SellerTeamView> {
  assertSellerPermission(actor.membership, SellerPermission.MEMBER_WRITE);
  const sellerAccountId = actor.membership.sellerAccountId;
  await prisma.$transaction(async (tx) => {
    const [memberCount, invitationCount] = await Promise.all([
      tx.sellerMember.count({ where: { sellerAccountId, removedAt: null } }),
      tx.sellerInvitation.count({ where: { sellerAccountId, liveKey: { not: null } } }),
    ]);
    const id = await insertAccessReview(tx, { sellerAccountId }, { reviewedByUserId: actor.userId, memberCount, invitationCount });
    await auditTeamChange(tx, teamAuditActor(actor), {
      action: AuditAction.SELLER_ACCESS_REVIEWED,
      resourceType: 'team_access_review',
      resourceId: id,
      before: null,
      after: { memberCount, invitationCount },
      summary: `Access to the team was reviewed: ${String(memberCount)} members, ${String(invitationCount)} open invitations.`,
    });
  });
  return readSellerTeam(actor);
}

// ---------------------------------------------------------------------------
// The person invited
// ---------------------------------------------------------------------------

function invalidInvitation(): never {
  throw badRequest(
    ErrorCode.SELLER_INVITATION_INVALID,
    'This invitation cannot be used. It may have expired or been withdrawn, or it was sent to another email address. Ask for a new one.',
  );
}

interface Invitee {
  userId: string;
  emailNormalized: string;
  emailVerifiedAt: Date | null;
  customerProfileId: string | null;
}

async function invitee(userId: string): Promise<Invitee> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { emailNormalized: true, emailVerifiedAt: true, customerProfile: { select: { id: true } } },
  });
  return { userId, emailNormalized: user.emailNormalized, emailVerifiedAt: user.emailVerifiedAt, customerProfileId: user.customerProfile?.id ?? null };
}

async function findByToken(token: string) {
  if (token.length < 20 || token.length > 100) invalidInvitation();
  return prisma.sellerInvitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { sellerAccount: { select: { id: true, displayName: true, archivedAt: true } } },
  });
}

type FoundInvitation = NonNullable<Awaited<ReturnType<typeof findByToken>>>;

function usable(invitation: FoundInvitation | null, person: Invitee): FoundInvitation {
  if (
    invitation === null ||
    invitation.liveKey === null ||
    invitation.expiresAt.getTime() <= Date.now() ||
    invitation.sellerAccount.archivedAt !== null ||
    invitation.emailNormalized !== person.emailNormalized ||
    person.emailVerifiedAt === null ||
    person.customerProfileId === null
  ) {
    invalidInvitation();
  }
  return invitation;
}

/** What the signed-in person is being asked to join, before they accept. */
export async function previewSellerInvitation(
  userId: string,
  token: string,
): Promise<{ sellerName: string; role: SellerMemberRole; expiresAt: string; inviterName: string }> {
  const invitation = usable(await findByToken(token), await invitee(userId));
  const inviter =
    invitation.invitedByProfileId === null ? new Map<string, string>() : await namesForProfiles([invitation.invitedByProfileId]);
  return {
    sellerName: invitation.sellerAccount.displayName,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    inviterName: invitation.invitedByProfileId === null ? '' : (inviter.get(invitation.invitedByProfileId) ?? ''),
  };
}

/**
 * Join the team the invitation is for.
 *
 * One person, one seller (`uq_seller_member_profile`): somebody who already
 * belongs to another seller - or once did - is told so
 * (`SELLER_MEMBERSHIP_EXISTS`) and the invitation is left usable, since the
 * remedy is theirs, not the inviter's. A former member of THIS seller is
 * restored on their old row with the new role and must choose a new Seller
 * Hub password. Pressing Accept twice returns the same answer the second
 * time and changes nothing.
 */
export async function acceptSellerInvitation(
  actor: { userId: string; email: string | null; ipAddress?: string | null; correlationId?: string | null },
  token: string,
): Promise<{ sellerAccountId: string }> {
  const person = await invitee(actor.userId);
  const found = await findByToken(token);

  // The second press of a double click: already accepted by this very person.
  if (
    found !== null &&
    found.acceptedAt !== null &&
    person.customerProfileId !== null &&
    found.acceptedByProfileId === person.customerProfileId
  ) {
    return { sellerAccountId: found.sellerAccountId };
  }

  const invitation = usable(found, person);
  const profileId = person.customerProfileId ?? '';
  const sellerAccountId = invitation.sellerAccountId;

  const existing = await prisma.sellerMember.findUnique({ where: { customerProfileId: profileId } });
  if (existing !== null && existing.sellerAccountId !== sellerAccountId) {
    throw conflict(
      ErrorCode.SELLER_MEMBERSHIP_EXISTS,
      'This account already belongs to another seller. Sign in with a different account to join this team.',
    );
  }

  const audited: TeamAuditActor = {
    sellerAccountId,
    customerProfileId: profileId,
    userId: actor.userId,
    email: actor.email,
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  };

  try {
    await prisma.$transaction(async (tx) => acceptInside(tx, audited, invitation));
  } catch (error) {
    // Somebody made this account a member elsewhere at the same moment.
    if (isUniqueViolation(error)) {
      throw conflict(ErrorCode.SELLER_MEMBERSHIP_EXISTS, 'This account already belongs to another seller.');
    }
    throw error;
  }
  return { sellerAccountId };
}

async function acceptInside(tx: Tx, audited: TeamAuditActor, invitation: FoundInvitation): Promise<void> {
  const { sellerAccountId, customerProfileId: profileId } = audited;

  // Claimed conditionally: two clicks on one link make one membership.
  const claimed = await tx.sellerInvitation.updateMany({
    where: { id: invitation.id, liveKey: { not: null }, expiresAt: { gt: new Date() } },
    data: { liveKey: null, acceptedAt: new Date(), acceptedByProfileId: profileId },
  });
  if (claimed.count === 0) {
    // The other press of a double click got there first and has committed:
    // same person, same answer, nothing more to do.
    const now = await tx.sellerInvitation.findUnique({ where: { id: invitation.id }, select: { acceptedByProfileId: true } });
    if (now?.acceptedByProfileId === profileId) return;
    invalidInvitation();
  }

  const current = await tx.sellerMember.findUnique({ where: { customerProfileId: profileId } });
  if (current !== null && current.sellerAccountId !== sellerAccountId) {
    throw conflict(ErrorCode.SELLER_MEMBERSHIP_EXISTS, 'This account already belongs to another seller.');
  }
  const memberId = current?.id ?? newId();

  if (current !== null && current.removedAt === null) {
    // Already in: the invitation is used up, and their role is left alone.
    await auditTeamChange(tx, audited, {
      action: AuditAction.SELLER_INVITATION_ACCEPTED,
      resourceType: 'seller_invitation',
      resourceId: invitation.id,
      before: null,
      after: { memberId, role: current.role, alreadyMember: true },
      summary: `${invitation.email} accepted an invitation and was already on the team.`,
    });
    return;
  }

  if (current === null) {
    await tx.sellerMember.create({
      data: {
        id: memberId,
        sellerAccountId,
        customerProfileId: profileId,
        role: invitation.role,
        invitedByProfileId: invitation.invitedByProfileId,
      },
    });
  } else {
    // A former member coming back: the same row, so their history still
    // names them. Their old Hub password is not brought back with them.
    await tx.sellerMember.update({
      where: { id: current.id },
      data: {
        removedAt: null,
        role: invitation.role,
        invitedByProfileId: invitation.invitedByProfileId,
        joinedAt: new Date(),
        passwordHash: null,
        passwordSetAt: null,
      },
    });
  }
  await auditTeamChange(tx, audited, {
    action: AuditAction.SELLER_INVITATION_ACCEPTED,
    resourceType: 'seller_invitation',
    resourceId: invitation.id,
    before: current === null ? null : { memberId, role: current.role, removed: true },
    after: { memberId, role: invitation.role },
    summary: `${invitation.email} joined the team as ${invitation.role}.`,
  });
}
