/**
 * Who belongs to a buyer company, and as what (checklist Master rows 11 and 14).
 *
 * THE RULES
 *
 *   - Seeing the team: any active member (VIEW). Seeing invitations and
 *     changing anything: MANAGE_MEMBERS - the OWNER and COMPANY_ADMINs - and
 *     only once the company is APPROVED (`companyCapabilityBlock`), because
 *     adding people to act in a company's name is acting in its name.
 *   - OWNER is never handed out: not by invitation, not by a role change. The
 *     owner cannot be removed or demoted here, so a company always keeps the
 *     one person who can manage it - that is the last-administrator rule.
 *   - Only the OWNER grants, changes or removes a COMPANY_ADMIN. An admin
 *     manages everybody else.
 *   - Nobody changes or removes themselves here.
 *   - Accepting needs a signed-in account whose VERIFIED email is the one
 *     invited. Every way an invitation can be unusable gets the same answer,
 *     so the endpoint cannot be used to learn who was invited where.
 *
 * Everything is scoped by the company id AND the caller's membership in it:
 * an id from another company reads as not found. Every change is audited, and
 * a removal or role change takes effect on the member's very next request,
 * because the buyer context is re-read on every request.
 */
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import {
  companyCapabilityBlock,
  type BuyerCompanyRoleName,
  type BuyerCompanyStatusName,
} from '../../domain/buyer-company-state.js';
import { AppError, ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { NotificationEvent, enqueueNotification } from '../notifications/notification.service.js';
import { renderInvitationEmail } from './invitation-email.js';
import { loadMembership, type Actor, type Membership, type Tx } from './shared.js';

/** Roles an invitation or a role change may give. Never OWNER. */
export const ASSIGNABLE_ROLES = ['COMPANY_ADMIN', 'BUYER', 'ORDER_APPROVER', 'FINANCE', 'VIEWER'] as const;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
/** Times one invitation email may be sent, the first included. */
export const INVITATION_MAX_SENDS = 5;

export interface TeamMemberView {
  id: string;
  name: string;
  email: string;
  role: BuyerCompanyRoleName;
  joinedAt: string;
  isYou: boolean;
  /** Whether the caller may change this member's role or remove them. */
  canChange: boolean;
}

export interface TeamInvitationView {
  id: string;
  email: string;
  role: BuyerCompanyRoleName;
  expiresAt: string;
  expired: boolean;
  sendCount: number;
  lastSentAt: string;
  canChange: boolean;
}

export interface TeamView {
  companyStatus: BuyerCompanyStatusName;
  yourRole: BuyerCompanyRoleName;
  /** Why the caller cannot manage the team, or null when they can. */
  manageBlocked: 'ROLE' | 'NOT_APPROVED' | null;
  /** The roles the caller may give. Empty when they cannot manage. */
  assignableRoles: AssignableRole[];
  members: TeamMemberView[];
  /** Live invitations; empty for anybody who cannot manage the team. */
  invitations: TeamInvitationView[];
}

const normalize = (email: string): string => email.trim().toLowerCase();
const liveKeyOf = (companyId: string, emailNormalized: string): string => `${companyId}:${emailNormalized}`;

async function context(userId: string, companyId: string, client: Tx | typeof prisma = prisma) {
  const membership = await loadMembership(userId, companyId, client);
  const company = await client.buyerCompany.findUniqueOrThrow({
    where: { id: companyId },
    select: { status: true, legalName: true, tradingName: true, applicationReference: true },
  });
  return { membership, company };
}

/** May an actor holding `actorRole` change somebody who holds (or would hold) `role`? */
function mayTouch(actorRole: BuyerCompanyRoleName, role: BuyerCompanyRoleName): boolean {
  if (role === 'OWNER') return false;
  if (role === 'COMPANY_ADMIN') return actorRole === 'OWNER';
  return true;
}

function assignableFor(actorRole: BuyerCompanyRoleName): AssignableRole[] {
  return ASSIGNABLE_ROLES.filter((role) => mayTouch(actorRole, role));
}

function assertCanManage(membership: Membership, status: BuyerCompanyStatusName): void {
  const block = companyCapabilityBlock(membership.role, status, 'MANAGE_MEMBERS');
  if (block === 'ROLE') {
    throw forbidden(ErrorCode.BUYER_COMPANY_ROLE_FORBIDDEN, 'Only the company owner or an administrator can manage the team.');
  }
  if (block === 'NOT_APPROVED') {
    throw new AppError({
      statusCode: 403,
      code: ErrorCode.BUYER_COMPANY_NOT_APPROVED,
      message: 'The team can be managed once the company is verified.',
      details: [{ code: 'NOT_APPROVED', meta: { status } }],
    });
  }
}

function protectedMember(code: 'OWNER' | 'SELF' | 'ADMIN_NEEDS_OWNER'): never {
  const message = {
    OWNER: 'The owner cannot be changed or removed here.',
    SELF: 'You cannot change or remove yourself. Ask another administrator.',
    ADMIN_NEEDS_OWNER: 'Only the owner can give, change or remove the administrator role.',
  }[code];
  throw new AppError({ statusCode: 403, code: ErrorCode.BUYER_COMPANY_MEMBER_PROTECTED, message, details: [{ code }] });
}

async function audit(
  client: Tx | typeof prisma,
  actor: Actor,
  action: (typeof AuditAction)[keyof typeof AuditAction],
  resourceType: string,
  resourceId: string,
  companyId: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await recordAudit(
    {
      action,
      resourceType,
      resourceId,
      actorType: 'CUSTOMER',
      actorUserId: actor.userId,
      actorEmail: actor.email ?? null,
      before: before === null ? null : { companyId, ...(before as object) },
      after: after === null ? null : { companyId, ...(after as object) },
      ipAddress: actor.ipAddress ?? null,
      correlationId: actor.correlationId ?? null,
    },
    client,
  );
}

export async function readTeam(userId: string, companyId: string): Promise<TeamView> {
  const { membership, company } = await context(userId, companyId);
  const manageBlocked = companyCapabilityBlock(membership.role, company.status, 'MANAGE_MEMBERS');
  const canManage = manageBlocked === null;

  const members = await prisma.buyerCompanyMember.findMany({
    where: { companyId, status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      userId: true,
      role: true,
      createdAt: true,
      user: { select: { email: true, customerProfile: { select: { fullName: true } } } },
    },
  });
  const invitations = canManage
    ? await prisma.buyerCompanyInvitation.findMany({
        where: { companyId, liveKey: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      })
    : [];
  const now = Date.now();

  return {
    companyStatus: company.status,
    yourRole: membership.role,
    manageBlocked,
    assignableRoles: canManage ? assignableFor(membership.role) : [],
    members: members.map((member) => ({
      id: member.id,
      name: member.user.customerProfile?.fullName ?? '',
      email: member.user.email,
      role: member.role,
      joinedAt: member.createdAt.toISOString(),
      isYou: member.userId === userId,
      canChange: canManage && member.userId !== userId && mayTouch(membership.role, member.role),
    })),
    invitations: invitations.map((invitation) => ({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt.toISOString(),
      expired: invitation.expiresAt.getTime() <= now,
      sendCount: invitation.sendCount,
      lastSentAt: invitation.lastSentAt.toISOString(),
      canChange: mayTouch(membership.role, invitation.role),
    })),
  };
}

function acceptUrl(token: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/account/join-company?token=${token}`;
}

async function sendInvitationEmail(
  tx: Tx,
  input: { companyId: string; companyName: string; inviterUserId: string; email: string; role: BuyerCompanyRoleName; token: string; expiresAt: Date; correlationId: string | null },
): Promise<void> {
  const inviter = await tx.user.findUnique({
    where: { id: input.inviterUserId },
    select: { email: true, preferredLanguage: true, customerProfile: { select: { fullName: true } } },
  });
  const message = renderInvitationEmail(inviter?.preferredLanguage, {
    company: input.companyName,
    inviter: inviter?.customerProfile?.fullName ?? inviter?.email ?? '',
    role: input.role,
    url: acceptUrl(input.token),
    expires: input.expiresAt.toISOString().slice(0, 10),
  });
  await enqueueNotification(
    {
      eventKey: NotificationEvent.BUYER_COMPANY_INVITATION,
      recipientEmail: input.email,
      variables: { subjectLine: message.subject, bodyText: message.body },
      relatedType: 'buyer_company',
      relatedId: input.companyId,
      correlationId: input.correlationId,
    },
    tx,
  );
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002';

export async function inviteMember(
  actor: Actor & { userId: string },
  companyId: string,
  input: { email: string; role: AssignableRole },
): Promise<TeamView> {
  const email = input.email.trim();
  const emailNormalized = normalize(email);
  const expiresAt = new Date(Date.now() + env.BUYER_COMPANY_INVITE_TTL_HOURS * 3_600_000);
  const token = randomBytes(32).toString('base64url');

  try {
    await prisma.$transaction(async (tx) => {
      const { membership, company } = await context(actor.userId, companyId, tx);
      assertCanManage(membership, company.status);
      if (!mayTouch(membership.role, input.role)) protectedMember('ADMIN_NEEDS_OWNER');

      const already = await tx.buyerCompanyMember.count({
        where: { companyId, status: 'ACTIVE', user: { emailNormalized } },
      });
      if (already > 0) {
        throw conflict(ErrorCode.BUYER_COMPANY_ALREADY_MEMBER, 'That person is already in the company. Change their role instead.');
      }

      const live = await tx.buyerCompanyInvitation.findUnique({ where: { liveKey: liveKeyOf(companyId, emailNormalized) } });
      if (live !== null) {
        if (live.expiresAt.getTime() > Date.now()) {
          throw conflict(ErrorCode.BUYER_COMPANY_INVITATION_EXISTS, 'That address already has an invitation. Resend it instead.', [
            { code: 'EXISTS', meta: { invitationId: live.id } },
          ]);
        }
        // Lapsed: retired, kept for the record, and replaced by this one.
        await tx.buyerCompanyInvitation.update({ where: { id: live.id }, data: { liveKey: null } });
      }

      const id = newId();
      const now = new Date();
      await tx.buyerCompanyInvitation.create({
        data: {
          id,
          companyId,
          email,
          emailNormalized,
          role: input.role,
          tokenHash: sha256Hex(token),
          liveKey: liveKeyOf(companyId, emailNormalized),
          expiresAt,
          lastSentAt: now,
          invitedByUserId: actor.userId,
        },
      });
      await audit(tx, actor, AuditAction.BUYER_COMPANY_MEMBER_INVITED, 'buyer_company_invitation', id, companyId, null, {
        email: emailNormalized,
        role: input.role,
        expiresAt: expiresAt.toISOString(),
      });
      await sendInvitationEmail(tx, {
        companyId,
        companyName: company.tradingName ?? company.legalName ?? company.applicationReference,
        inviterUserId: actor.userId,
        email,
        role: input.role,
        token,
        expiresAt,
        correlationId: actor.correlationId ?? null,
      });
    });
  } catch (error) {
    // Two invitations to the same address at the same moment: the UNIQUE
    // live key lets one through and this is the other.
    if (isUniqueViolation(error)) {
      throw conflict(ErrorCode.BUYER_COMPANY_INVITATION_EXISTS, 'That address already has an invitation. Resend it instead.');
    }
    throw error;
  }
  return readTeam(actor.userId, companyId);
}

async function liveInvitation(tx: Tx, companyId: string, invitationId: string) {
  const invitation = await tx.buyerCompanyInvitation.findFirst({ where: { id: invitationId, companyId, liveKey: { not: null } } });
  if (invitation === null) throw notFound('Invitation');
  return invitation;
}

/** Send the email again with a new link and a new expiry. The old link stops working. */
export async function resendInvitation(actor: Actor & { userId: string }, companyId: string, invitationId: string): Promise<TeamView> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.BUYER_COMPANY_INVITE_TTL_HOURS * 3_600_000);
  await prisma.$transaction(async (tx) => {
    const { membership, company } = await context(actor.userId, companyId, tx);
    assertCanManage(membership, company.status);
    const invitation = await liveInvitation(tx, companyId, invitationId);
    if (!mayTouch(membership.role, invitation.role)) protectedMember('ADMIN_NEEDS_OWNER');
    if (invitation.sendCount >= INVITATION_MAX_SENDS) {
      throw conflict(ErrorCode.BUYER_COMPANY_LIMIT_REACHED, 'This invitation has been sent as many times as it can be. Withdraw it and invite again.', [
        { code: 'MAX_SENDS', meta: { max: INVITATION_MAX_SENDS } },
      ]);
    }
    const resent = await tx.buyerCompanyInvitation.updateMany({
      where: { id: invitation.id, liveKey: { not: null }, sendCount: invitation.sendCount },
      data: { tokenHash: sha256Hex(token), expiresAt, sendCount: { increment: 1 }, lastSentAt: new Date() },
    });
    if (resent.count === 0) throw notFound('Invitation');
    await audit(tx, actor, AuditAction.BUYER_COMPANY_INVITATION_RESENT, 'buyer_company_invitation', invitation.id, companyId,
      { expiresAt: invitation.expiresAt.toISOString(), sendCount: invitation.sendCount },
      { expiresAt: expiresAt.toISOString(), sendCount: invitation.sendCount + 1 });
    await sendInvitationEmail(tx, {
      companyId,
      companyName: company.tradingName ?? company.legalName ?? company.applicationReference,
      inviterUserId: actor.userId,
      email: invitation.email,
      role: invitation.role,
      token,
      expiresAt,
      correlationId: actor.correlationId ?? null,
    });
  });
  return readTeam(actor.userId, companyId);
}

export async function revokeInvitation(actor: Actor & { userId: string }, companyId: string, invitationId: string): Promise<TeamView> {
  await prisma.$transaction(async (tx) => {
    const { membership, company } = await context(actor.userId, companyId, tx);
    assertCanManage(membership, company.status);
    const invitation = await liveInvitation(tx, companyId, invitationId);
    if (!mayTouch(membership.role, invitation.role)) protectedMember('ADMIN_NEEDS_OWNER');
    const revoked = await tx.buyerCompanyInvitation.updateMany({
      where: { id: invitation.id, liveKey: { not: null } },
      data: { liveKey: null, revokedAt: new Date(), revokedByUserId: actor.userId },
    });
    if (revoked.count === 0) throw notFound('Invitation');
    await audit(tx, actor, AuditAction.BUYER_COMPANY_INVITATION_REVOKED, 'buyer_company_invitation', invitation.id, companyId,
      { email: invitation.emailNormalized, role: invitation.role }, { revoked: true });
  });
  return readTeam(actor.userId, companyId);
}

async function changeableMember(tx: Tx, membership: Membership, memberId: string) {
  const target = await tx.buyerCompanyMember.findFirst({ where: { id: memberId, companyId: membership.companyId, status: 'ACTIVE' } });
  if (target === null) throw notFound('Member');
  if (target.userId === membership.userId) protectedMember('SELF');
  if (target.role === 'OWNER') protectedMember('OWNER');
  if (!mayTouch(membership.role, target.role)) protectedMember('ADMIN_NEEDS_OWNER');
  return target;
}

export async function changeMemberRole(
  actor: Actor & { userId: string },
  companyId: string,
  memberId: string,
  role: AssignableRole,
): Promise<TeamView> {
  await prisma.$transaction(async (tx) => {
    const { membership, company } = await context(actor.userId, companyId, tx);
    assertCanManage(membership, company.status);
    const target = await changeableMember(tx, membership, memberId);
    if (!mayTouch(membership.role, role)) protectedMember('ADMIN_NEEDS_OWNER');
    if (target.role === role) return;
    // On the role read: two administrators changing one person at once get one change each, never a mix.
    const changed = await tx.buyerCompanyMember.updateMany({ where: { id: target.id, status: 'ACTIVE', role: target.role }, data: { role } });
    if (changed.count === 0) {
      throw conflict(ErrorCode.BUYER_COMPANY_VERSION_CONFLICT, 'Somebody else changed this member meanwhile. Reload and try again.');
    }
    await audit(tx, actor, AuditAction.BUYER_COMPANY_MEMBER_ROLE_CHANGED, 'buyer_company_member', target.id, companyId,
      { userId: target.userId, role: target.role }, { userId: target.userId, role });
  });
  return readTeam(actor.userId, companyId);
}

export async function removeMember(actor: Actor & { userId: string }, companyId: string, memberId: string): Promise<TeamView> {
  await prisma.$transaction(async (tx) => {
    const { membership, company } = await context(actor.userId, companyId, tx);
    assertCanManage(membership, company.status);
    const target = await changeableMember(tx, membership, memberId);
    const removed = await tx.buyerCompanyMember.updateMany({
      where: { id: target.id, status: 'ACTIVE' },
      data: { status: 'REMOVED', removedAt: new Date() },
    });
    if (removed.count === 0) throw notFound('Member');
    await audit(tx, actor, AuditAction.BUYER_COMPANY_MEMBER_REMOVED, 'buyer_company_member', target.id, companyId,
      { userId: target.userId, role: target.role, status: 'ACTIVE' }, { userId: target.userId, status: 'REMOVED' });
  });
  return readTeam(actor.userId, companyId);
}

// --- The person invited -----------------------------------------------------

function invalidInvitation(): never {
  throw badRequest(
    ErrorCode.BUYER_COMPANY_INVITATION_INVALID,
    'This invitation cannot be used. It may have expired or been withdrawn, or it was sent to another email address. Ask for a new one.',
  );
}

async function usableInvitation(token: string, user: { emailNormalized: string; emailVerifiedAt: Date | null }) {
  if (token.length < 20 || token.length > 100) invalidInvitation();
  const invitation = await prisma.buyerCompanyInvitation.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { company: { select: { id: true, legalName: true, tradingName: true, applicationReference: true, archivedAt: true } } },
  });
  if (
    invitation === null ||
    invitation.liveKey === null ||
    invitation.expiresAt.getTime() <= Date.now() ||
    invitation.company.archivedAt !== null ||
    invitation.emailNormalized !== user.emailNormalized ||
    user.emailVerifiedAt === null
  ) {
    invalidInvitation();
  }
  return invitation;
}

async function signedInUser(userId: string) {
  return prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { emailNormalized: true, emailVerifiedAt: true } });
}

/** What the signed-in person is being asked to join, before they accept. */
export async function previewInvitation(
  userId: string,
  token: string,
): Promise<{ companyName: string; role: BuyerCompanyRoleName; expiresAt: string; inviterName: string }> {
  const invitation = await usableInvitation(token, await signedInUser(userId));
  const inviter = await prisma.user.findUnique({
    where: { id: invitation.invitedByUserId },
    select: { email: true, customerProfile: { select: { fullName: true } } },
  });
  return {
    companyName: invitation.company.tradingName ?? invitation.company.legalName ?? invitation.company.applicationReference,
    role: invitation.role,
    expiresAt: invitation.expiresAt.toISOString(),
    inviterName: inviter?.customerProfile?.fullName ?? inviter?.email ?? '',
  };
}

export async function acceptInvitation(actor: Actor & { userId: string }, token: string): Promise<{ companyId: string }> {
  const invitation = await usableInvitation(token, await signedInUser(actor.userId));

  await prisma.$transaction(async (tx) => {
    // Claimed conditionally: two clicks on one link make one membership.
    const claimed = await tx.buyerCompanyInvitation.updateMany({
      where: { id: invitation.id, liveKey: { not: null }, expiresAt: { gt: new Date() } },
      data: { liveKey: null, acceptedAt: new Date(), acceptedByUserId: actor.userId },
    });
    if (claimed.count === 0) invalidInvitation();

    const existing = await tx.buyerCompanyMember.findUnique({
      where: { companyId_userId: { companyId: invitation.companyId, userId: actor.userId } },
    });
    if (existing?.status === 'ACTIVE') {
      // Already in: the invitation is used up, and their role is left as it is.
      await audit(tx, actor, AuditAction.BUYER_COMPANY_INVITATION_ACCEPTED, 'buyer_company_invitation', invitation.id, invitation.companyId,
        null, { memberId: existing.id, role: existing.role, alreadyMember: true });
      return;
    }
    const memberId = existing?.id ?? newId();
    if (existing === null) {
      await tx.buyerCompanyMember.create({
        data: { id: memberId, companyId: invitation.companyId, userId: actor.userId, role: invitation.role, invitedByUserId: invitation.invitedByUserId },
      });
    } else {
      // A former member coming back: the same row, restored with the new role.
      await tx.buyerCompanyMember.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', role: invitation.role, removedAt: null, invitedByUserId: invitation.invitedByUserId },
      });
    }
    await audit(tx, actor, AuditAction.BUYER_COMPANY_INVITATION_ACCEPTED, 'buyer_company_invitation', invitation.id, invitation.companyId,
      existing === null ? null : { memberId, status: existing.status, role: existing.role },
      { memberId, role: invitation.role, status: 'ACTIVE' });
  });
  return { companyId: invitation.companyId };
}
