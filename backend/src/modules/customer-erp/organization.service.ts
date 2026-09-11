/**
 * The buyer organisation: who it is, who is in it, and what each of them may do.
 *
 * This file is the ownership boundary for the whole customer-ERP feature. Every
 * connection, credential, mapping, event and log row in it is owned by an
 * organisation, and the only way to get an organisation id is through
 * `resolveMembership` below, which derives it from the SESSION and from nothing
 * else. There is no `?organizationId=` anywhere in the routes, no handler reads
 * an owner from a request body, and no service takes an organisation id from
 * its caller without having been handed a membership first.
 *
 * That is deliberate and it is the single control that makes tenant isolation
 * true rather than intended. A function that accepted an organisation id would
 * be one refactor away from accepting one an attacker chose.
 *
 * WHY AN ORGANISATION AT ALL
 *
 * A buyer here is a business, not a person. The person who sets up the SAP
 * connection is very often not the person who signs the purchase orders, and
 * neither of them is necessarily still employed there in two years. A
 * connection tied to an individual account dies with that account: their
 * successor cannot fix it, cannot see why it broke, and cannot rotate a
 * credential that is still working perfectly well against a system they now own.
 *
 * WHY NOT `customer_profiles.organization`
 *
 * Because it is free text somebody typed into a form. It is exactly right for
 * putting a company name on a delivery note and it is not an access-control
 * boundary. Grouping tenants by it would mean that typing "City Medical
 * Supplies" into a profile field granted access to City Medical Supplies'
 * purchase orders, credentials and stock figures. So an organisation is
 * provisioned per account holder, and the only way a second person gets in is
 * an invitation that somebody with authority sent to an address they control.
 */
import { randomBytes } from 'node:crypto';
import type { BuyerOrgRole } from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  NotificationEvent,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { recordOrgAudit, type OrgActor } from './audit.service.js';

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export type BuyerOrgRoleName = 'OWNER' | 'INTEGRATION_MANAGER' | 'MEMBER';

/**
 * What each role may do, as a rank rather than a matrix.
 *
 * A rank works here because the three roles genuinely nest: an owner can do
 * everything an integration manager can, and an integration manager everything
 * a member can. The moment that stops being true - a "billing approver" who may
 * approve purchase orders but not touch credentials - this becomes a matrix and
 * the call sites below are where it changes. Until then a matrix would be
 * ceremony around a `>=`.
 */
const RANK: Readonly<Record<BuyerOrgRoleName, number>> = Object.freeze({
  MEMBER: 1,
  INTEGRATION_MANAGER: 2,
  OWNER: 3,
});

/**
 * What a caller is trying to do, named for the decision rather than the route.
 *
 * `CONFIGURE` covers everything that changes what the connection is or does:
 * credentials, endpoints, mappings, policies, activation. `OPERATE` covers the
 * buttons that run it without changing it - test, dry run, sync now, retry.
 * They are separate because a buyer may legitimately want somebody who can
 * press Sync now without being able to repoint the connection at a different
 * SAP system, and because `OPERATE` is the one an approval flow needs.
 */
export type OrgCapability = 'VIEW' | 'OPERATE' | 'CONFIGURE' | 'ADMINISTER';

const REQUIRED_RANK: Readonly<Record<OrgCapability, number>> = Object.freeze({
  /// Connection health, sync history, the audit log. Everybody in the tenant.
  VIEW: RANK.MEMBER,
  /// Test, dry run, sync now, retry a failed event, decide an approval.
  OPERATE: RANK.INTEGRATION_MANAGER,
  /// Credentials, endpoints, mappings, sync rules, activate, disconnect.
  CONFIGURE: RANK.INTEGRATION_MANAGER,
  /// Membership, roles, invitations, and the organisation itself.
  ADMINISTER: RANK.OWNER,
});

export interface Membership {
  organizationId: string;
  organizationName: string;
  memberId: string;
  customerProfileId: string;
  role: BuyerOrgRoleName;
}

export function hasCapability(role: BuyerOrgRoleName, capability: OrgCapability): boolean {
  return RANK[role] >= REQUIRED_RANK[capability];
}

/**
 * Refuse unless the member's role permits this.
 *
 * Called at the top of every service function that changes anything, not only
 * in the route layer. A guard that lives only in the routes is a guard that the
 * next internal caller walks past.
 */
export function assertCapability(
  membership: Membership,
  capability: OrgCapability,
): void {
  if (hasCapability(membership.role, capability)) return;

  throw forbidden(
    ErrorCode.ORGANIZATION_ROLE_INSUFFICIENT,
    capability === 'ADMINISTER'
      ? 'Only an owner of this organisation can change who has access to it.'
      : 'Your role can see this integration but not change it. Ask an owner or an ' +
        'integration manager in your organisation.',
  );
}

/** Every capability this member holds, for a screen to render buttons from. */
export function capabilitiesFor(role: BuyerOrgRoleName): OrgCapability[] {
  return (Object.keys(REQUIRED_RANK) as OrgCapability[]).filter((capability) =>
    hasCapability(role, capability),
  );
}

// ---------------------------------------------------------------------------
// Resolving the caller's organisation
// ---------------------------------------------------------------------------

/** Lowercased, punctuation-stripped, collapsed. For finding, never for joining. */
export function normaliseOrgName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 255);
}

/**
 * The organisation this customer acts for, provisioning one if they have none.
 *
 * Lazy provisioning rather than a migration that walks every existing customer,
 * for two reasons. An installation where nobody ever opens the integrations
 * area ends up with an empty table rather than one row per customer it never
 * needed; and a row created at the moment somebody actually asks for it can be
 * named from what their profile says now rather than from what it said on the
 * day of the deploy.
 *
 * The founder becomes OWNER. Nobody else is placed in the organisation by any
 * automatic process, ever - see this file's header for why.
 */
export async function resolveMembership(customerProfileId: string): Promise<Membership> {
  const existing = await prisma.buyerOrganizationMember.findUnique({
    where: { customerProfileId },
    include: { organization: true },
  });

  if (existing !== null) {
    if (existing.organization.archivedAt !== null) {
      throw forbidden(
        ErrorCode.ORGANIZATION_REQUIRED,
        'This organisation has been closed. Contact support to reopen it.',
      );
    }

    return {
      organizationId: existing.organizationId,
      organizationName: existing.organization.name,
      memberId: existing.id,
      customerProfileId,
      role: existing.role,
    };
  }

  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: { id: true, fullName: true, organization: true },
  });

  if (profile === null) {
    throw forbidden(
      ErrorCode.ORGANIZATION_REQUIRED,
      'This account is not fully set up.',
    );
  }

  // The company name where they gave one, their own name where they did not.
  // "Organisation" as the heading over somebody's own screen is worse than
  // their name, and they can rename it.
  const name = (profile.organization ?? '').trim().length > 0
    ? (profile.organization as string).trim().slice(0, 255)
    : profile.fullName.slice(0, 255);

  const organizationId = newId();
  const memberId = newId();

  // `createMany` with `skipDuplicates` on the member, then read back: two tabs
  // opening the integrations page together would otherwise both insert, and
  // the unique on `customerProfileId` would turn the loser into a 500 rather
  // than into "you already have one".
  await prisma.$transaction(async (tx) => {
    await tx.buyerOrganization.create({
      data: {
        id: organizationId,
        name,
        nameNormalized: normaliseOrgName(name),
        createdByProfileId: customerProfileId,
      },
    });

    await tx.buyerOrganizationMember.createMany({
      data: [{ id: memberId, organizationId, customerProfileId, role: 'OWNER' }],
      skipDuplicates: true,
    });
  });

  const member = await prisma.buyerOrganizationMember.findUnique({
    where: { customerProfileId },
    include: { organization: true },
  });

  if (member === null) {
    // Cannot happen: the transaction above either created it or found the
    // other tab's. Thrown rather than asserted so it is a clear failure if it
    // ever does.
    throw conflict(
      ErrorCode.ORGANIZATION_REQUIRED,
      'Your organisation could not be set up. Try again.',
    );
  }

  // The loser of the race created an organisation nobody joined. Tidy it up
  // rather than leaving an orphan named after somebody who is not in it.
  if (member.organizationId !== organizationId) {
    await prisma.buyerOrganization
      .delete({ where: { id: organizationId } })
      .catch(() => undefined);
  }

  return {
    organizationId: member.organizationId,
    organizationName: member.organization.name,
    memberId: member.id,
    customerProfileId,
    role: member.role,
  };
}

// ---------------------------------------------------------------------------
// Reading and renaming
// ---------------------------------------------------------------------------

export interface OrganizationView {
  id: string;
  name: string;
  createdAt: string;
  role: BuyerOrgRoleName;
  capabilities: OrgCapability[];
  memberCount: number;
}

export async function getOrganization(membership: Membership): Promise<OrganizationView> {
  const [organization, memberCount] = await Promise.all([
    prisma.buyerOrganization.findUnique({ where: { id: membership.organizationId } }),
    prisma.buyerOrganizationMember.count({
      where: { organizationId: membership.organizationId },
    }),
  ]);

  if (organization === null) throw notFound('Organisation');

  return {
    id: organization.id,
    name: organization.name,
    createdAt: organization.createdAt.toISOString(),
    role: membership.role,
    capabilities: capabilitiesFor(membership.role),
    memberCount,
  };
}

export async function renameOrganization(
  membership: Membership,
  actor: OrgActor,
  name: string,
): Promise<OrganizationView> {
  assertCapability(membership, 'ADMINISTER');

  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 255) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter a name for your organisation.', [
      { field: 'name', code: 'INVALID_LENGTH' },
    ]);
  }

  const before = await prisma.buyerOrganization.findUnique({
    where: { id: membership.organizationId },
    select: { name: true },
  });

  await prisma.buyerOrganization.update({
    where: { id: membership.organizationId },
    data: { name: trimmed, nameNormalized: normaliseOrgName(trimmed) },
  });

  await recordOrgAudit({
    organizationId: membership.organizationId,
    action: 'organization.renamed',
    resourceType: 'organization',
    resourceId: membership.organizationId,
    actor,
    before: { name: before?.name ?? null },
    after: { name: trimmed },
  });

  return getOrganization({ ...membership, organizationName: trimmed });
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: BuyerOrgRoleName;
  joinedAt: string;
  /** True for the row belonging to whoever is asking. */
  isYou: boolean;
}

export async function listMembers(membership: Membership): Promise<MemberView[]> {
  assertCapability(membership, 'VIEW');

  const rows = await prisma.buyerOrganizationMember.findMany({
    where: { organizationId: membership.organizationId },
    include: {
      customerProfile: {
        select: { fullName: true, user: { select: { email: true } } },
      },
    },
    orderBy: [{ role: 'asc' }, { joinedAt: 'asc' }],
  });

  return rows.map((row) => ({
    id: row.id,
    name: row.customerProfile.fullName,
    email: row.customerProfile.user.email,
    role: row.role,
    joinedAt: row.joinedAt.toISOString(),
    isYou: row.customerProfileId === membership.customerProfileId,
  }));
}

/**
 * How many owners the organisation has, which is the only count anything
 * branches on.
 *
 * An organisation with no owner has nobody who can grant anybody access to it,
 * including support - so the last one cannot be removed or demoted. That is
 * checked here and enforced inside the same transaction as the change, because
 * two owners demoting each other simultaneously would otherwise both pass a
 * check taken beforehand.
 */
async function ownerCount(organizationId: string, tx: typeof prisma): Promise<number> {
  return tx.buyerOrganizationMember.count({
    where: { organizationId, role: 'OWNER' },
  });
}

export async function changeMemberRole(
  membership: Membership,
  actor: OrgActor,
  memberId: string,
  role: BuyerOrgRoleName,
): Promise<MemberView[]> {
  assertCapability(membership, 'ADMINISTER');

  await prisma.$transaction(async (tx) => {
    const target = await tx.buyerOrganizationMember.findFirst({
      // Scoped by organisation, not merely by id. A member id from another
      // tenant must read as "not found" rather than as "forbidden", and it
      // must certainly not be updatable.
      where: { id: memberId, organizationId: membership.organizationId },
    });

    if (target === null) throw notFound('Member');
    if (target.role === role) return;

    if (target.role === 'OWNER' && role !== 'OWNER') {
      const owners = await ownerCount(membership.organizationId, tx as typeof prisma);
      if (owners <= 1) {
        throw conflict(
          ErrorCode.ORGANIZATION_LAST_OWNER,
          'This is the only owner. Make somebody else an owner first, then change this ' +
            'one - an organisation with no owner is one nobody can grant access to.',
        );
      }
    }

    await tx.buyerOrganizationMember.update({ where: { id: memberId }, data: { role } });

    await recordOrgAudit(
      {
        organizationId: membership.organizationId,
        action: 'member.role_changed',
        resourceType: 'organization_member',
        resourceId: memberId,
        actor,
        before: { role: target.role },
        after: { role },
      },
      tx,
    );
  });

  return listMembers(membership);
}

export async function removeMember(
  membership: Membership,
  actor: OrgActor,
  memberId: string,
): Promise<MemberView[]> {
  assertCapability(membership, 'ADMINISTER');

  await prisma.$transaction(async (tx) => {
    const target = await tx.buyerOrganizationMember.findFirst({
      where: { id: memberId, organizationId: membership.organizationId },
    });

    if (target === null) throw notFound('Member');

    if (target.role === 'OWNER') {
      const owners = await ownerCount(membership.organizationId, tx as typeof prisma);
      if (owners <= 1) {
        throw conflict(
          ErrorCode.ORGANIZATION_LAST_OWNER,
          'This is the only owner, so removing them would leave the organisation with ' +
            'nobody who can manage it. Make somebody else an owner first.',
        );
      }
    }

    await tx.buyerOrganizationMember.delete({ where: { id: memberId } });

    await recordOrgAudit(
      {
        organizationId: membership.organizationId,
        action: 'member.removed',
        resourceType: 'organization_member',
        resourceId: memberId,
        actor,
        before: { role: target.role },
        after: null,
      },
      tx,
    );
  });

  return listMembers(membership);
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface InviteView {
  id: string;
  email: string;
  role: BuyerOrgRoleName;
  expiresAt: string;
  createdAt: string;
}

export async function listInvites(membership: Membership): Promise<InviteView[]> {
  assertCapability(membership, 'ADMINISTER');

  const rows = await prisma.buyerOrganizationInvite.findMany({
    where: {
      organizationId: membership.organizationId,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });

  return rows.map((row) => ({
    id: row.id,
    email: row.emailNormalized,
    role: row.role,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Invite somebody in.
 *
 * The token is 32 bytes of CSPRNG, sent by email, and stored only as its
 * SHA-256. A leaked database therefore hands somebody a list of hashes rather
 * than a set of working invitations, which is the same reasoning the
 * password-reset path uses and for the same reason.
 *
 * **The answer is the same whether or not the address has an account here.**
 * An endpoint that said "we have sent it" for a customer and "no such account"
 * for a stranger is an oracle for who buys from this supplier, and a
 * competitor would like that answered.
 */
export async function inviteMember(
  membership: Membership,
  actor: OrgActor,
  input: { email: string; role: BuyerOrgRoleName },
): Promise<{ invites: InviteView[] }> {
  assertCapability(membership, 'ADMINISTER');

  const emailNormalized = input.email.trim().toLowerCase();

  if (emailNormalized.length === 0 || !emailNormalized.includes('@')) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Enter an email address.', [
      { field: 'email', code: 'INVALID_EMAIL' },
    ]);
  }

  const already = await prisma.buyerOrganizationMember.findFirst({
    where: {
      organizationId: membership.organizationId,
      customerProfile: { user: { emailNormalized } },
    },
  });

  if (already !== null) {
    throw conflict(
      ErrorCode.ORGANIZATION_ALREADY_MEMBER,
      'That address is already in your organisation.',
    );
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + env.CUSTOMER_ERP_INVITE_TTL_HOURS * 3600 * 1000);

  await prisma.$transaction(async (tx) => {
    // One live invitation per address per organisation. Re-inviting replaces
    // the old one rather than stacking a second: two working links to the same
    // place is two things to remember to revoke.
    await tx.buyerOrganizationInvite.updateMany({
      where: {
        organizationId: membership.organizationId,
        emailNormalized,
        acceptedAt: null,
        revokedAt: null,
      },
      data: { revokedAt: new Date() },
    });

    await tx.buyerOrganizationInvite.create({
      data: {
        id: newId(),
        organizationId: membership.organizationId,
        emailNormalized,
        role: input.role,
        tokenHash: sha256Hex(token),
        expiresAt,
        invitedByProfileId: membership.customerProfileId,
      },
    });

    await recordOrgAudit(
      {
        organizationId: membership.organizationId,
        action: 'member.invited',
        resourceType: 'organization_invite',
        actor,
        after: { email: emailNormalized, role: input.role },
      },
      tx,
    );
  });

  await enqueueNotification({
    eventKey: NotificationEvent.ORGANIZATION_INVITATION,
    recipientEmail: emailNormalized,
    variables: {
      organizationName: membership.organizationName,
      inviterName: actor.email ?? '',
      roleLabel: roleLabel(input.role),
      acceptUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/account/integrations/erp/join?token=${token}`,
      expiresAt: expiresAt.toISOString().slice(0, 10),
    },
    relatedType: 'buyer_organization',
    relatedId: membership.organizationId,
    correlationId: actor.correlationId ?? null,
  });

  return { invites: await listInvites(membership) };
}

export async function revokeInvite(
  membership: Membership,
  actor: OrgActor,
  inviteId: string,
): Promise<InviteView[]> {
  assertCapability(membership, 'ADMINISTER');

  const updated = await prisma.buyerOrganizationInvite.updateMany({
    where: {
      id: inviteId,
      organizationId: membership.organizationId,
      acceptedAt: null,
      revokedAt: null,
    },
    data: { revokedAt: new Date() },
  });

  if (updated.count === 0) throw notFound('Invitation');

  await recordOrgAudit({
    organizationId: membership.organizationId,
    action: 'member.invite_revoked',
    resourceType: 'organization_invite',
    resourceId: inviteId,
    actor,
  });

  return listInvites(membership);
}

/**
 * Accept an invitation.
 *
 * Five ways this can fail - no such token, expired, revoked, already used, or
 * addressed to a different person - and one answer for all five. Distinguishing
 * them turns this endpoint into a way to test whether a given address has been
 * invited to a given organisation, and none of the five distinctions helps the
 * person holding a valid link.
 *
 * The email comparison is what stops a forwarded link working for the wrong
 * person. The token proves somebody read the message; the address check proves
 * it was the person it was addressed to.
 */
export async function acceptInvite(input: {
  token: string;
  customerProfileId: string;
  emailNormalized: string;
  actor: OrgActor;
}): Promise<Membership> {
  const invite = await prisma.buyerOrganizationInvite.findUnique({
    where: { tokenHash: sha256Hex(input.token) },
    include: { organization: true },
  });

  const invalid = (): never => {
    throw badRequest(
      ErrorCode.ORGANIZATION_INVITE_INVALID,
      'This invitation is no longer valid. Ask whoever invited you to send a new one.',
    );
  };

  if (
    invite === null ||
    invite.acceptedAt !== null ||
    invite.revokedAt !== null ||
    invite.expiresAt.getTime() <= Date.now() ||
    invite.organization.archivedAt !== null ||
    invite.emailNormalized !== input.emailNormalized
  ) {
    invalid();
    throw new Error('unreachable');
  }

  const existing = await prisma.buyerOrganizationMember.findUnique({
    where: { customerProfileId: input.customerProfileId },
  });

  if (existing !== null) {
    if (existing.organizationId === invite.organizationId) {
      // Already in, and the invitation was superfluous. Consume it and say so
      // as a success rather than an error: the person did what the email asked.
      await prisma.buyerOrganizationInvite.update({
        where: { id: invite.id },
        data: { acceptedAt: new Date(), acceptedByProfileId: input.customerProfileId },
      });

      return resolveMembership(input.customerProfileId);
    }

    throw conflict(
      ErrorCode.ORGANIZATION_ALREADY_MEMBER,
      'Your account already belongs to another organisation. Leave that one first, or ' +
        'ask for the invitation to be sent to a different account.',
    );
  }

  await prisma.$transaction(async (tx) => {
    // Claim the invitation with a conditional update, so two clicks on the same
    // link produce one membership. `updateMany` returns a count; `update` would
    // have succeeded twice.
    const claimed = await tx.buyerOrganizationInvite.updateMany({
      where: { id: invite.id, acceptedAt: null, revokedAt: null },
      data: { acceptedAt: new Date(), acceptedByProfileId: input.customerProfileId },
    });

    if (claimed.count === 0) {
      throw badRequest(
        ErrorCode.ORGANIZATION_INVITE_INVALID,
        'This invitation is no longer valid. Ask whoever invited you to send a new one.',
      );
    }

    await tx.buyerOrganizationMember.create({
      data: {
        id: newId(),
        organizationId: invite.organizationId,
        customerProfileId: input.customerProfileId,
        role: invite.role,
        invitedByProfileId: invite.invitedByProfileId,
      },
    });

    await recordOrgAudit(
      {
        organizationId: invite.organizationId,
        action: 'member.joined',
        resourceType: 'organization_member',
        actor: input.actor,
        after: { email: input.emailNormalized, role: invite.role },
      },
      tx,
    );
  });

  return resolveMembership(input.customerProfileId);
}

export function roleLabel(role: BuyerOrgRoleName): string {
  switch (role) {
    case 'OWNER':
      return 'Owner';
    case 'INTEGRATION_MANAGER':
      return 'Integration manager';
    case 'MEMBER':
      return 'Member';
  }
}

/** Narrow a database enum to the union this module uses. */
export function toRoleName(role: BuyerOrgRole): BuyerOrgRoleName {
  return role;
}
