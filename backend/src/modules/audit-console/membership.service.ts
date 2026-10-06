/**
 * Who may use the Audit Console, and as whom.
 *
 * An AUDIT account (`users.type = 'AUDIT'`) holds exactly one membership:
 *
 *   - an `AuditStaffMember` - the marketplace's own SUPERVISOR or
 *     COMPLIANCE_REVIEWER; or
 *   - an `InspectionAgencyMember` - one agency's AGENCY_ADMIN, COORDINATOR,
 *     INSPECTOR or QA_REVIEWER.
 *
 * The membership is resolved from the SESSION on every request. No route
 * takes an agency id, a member id or a role from the request to decide whose
 * data it shows: an agency member sees their agency, an inspector their own
 * assignments, and a staff member everything read-only plus what their role
 * decides.
 *
 * WHY A SEPARATE ACCOUNT AND NOT A FLAG ON A CUSTOMER
 *
 * Agency people used to sign in with an ordinary storefront account, which
 * meant a password that could buy things could also sign an inspection
 * report. Now nobody is an auditor by holding a customer, seller or carrier
 * login: the console's routes authenticate against the AUDIT audience only -
 * its own cookie jar, its own token audience and its own `users.type` - and
 * an account is created only by invitation. `users.emailNormalized` is unique
 * across every audience, so a person who also buys here uses a separate work
 * address for the console. Agency members who were attached to a storefront
 * account before this change keep their row and history; the operator moves
 * them to a console account with `moveAgencyMemberToConsole`.
 *
 * THE INDEPENDENCE CHECK THIS GIVES UP, AND WHAT REPLACES IT
 *
 * A storefront account could be compared with the seller's own members, so
 * "this inspector is a member of the seller" was a structural check. An AUDIT
 * account is not a storefront account, so that comparison now finds nothing.
 * What remains, and is enforced on every job: the agency's declared
 * affiliations (never offered those sellers' jobs), the agency's conflict
 * statement at acceptance, and each inspector's own per-job declaration,
 * which `startJob` requires before any finding can be recorded.
 */
import { env } from '../../config/env.js';
import {
  agencyConsoleKeys,
  staffConsoleKeys,
  type AuditConsoleKey,
  type AuditRoleName,
  type AuditStaffRoleName,
} from '../../domain/audit-console-permissions.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import type { InspectionAgencyRoleName } from '../../domain/inspection-permissions.js';
import { email as emailDriver } from '../../infra/email/index.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { withWriteConflictRetry } from '../../infra/write-conflict.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { normaliseEmail } from '../identity/auth.service.js';
import { buildTokenUrl, issueToken } from '../identity/token.service.js';
import {
  resolveInspectionMembership,
  type InspectionMembership,
} from '../inspection/agency.service.js';
import { getMarketplaceName } from '../settings/marketplace-name.js';

export interface AuditMember {
  userId: string;
  email: string;
  fullName: string;
  kind: 'STAFF' | 'AGENCY';
  role: AuditRoleName;
  permissions: ReadonlySet<AuditConsoleKey>;
  agency: { id: string; name: string; kind: 'THIRD_PARTY' | 'INTERNAL' | 'SELLER_SELF' } | null;
  /** Present for STAFF. */
  staffMemberId: string | null;
  /** Present for AGENCY: the existing inspection membership the job services take. */
  inspection: InspectionMembership | null;
}

function notAMember(): never {
  throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'This account does not have access to the Audit Console.');
}

/**
 * The member behind a console session. Refuses a disabled, invited or missing
 * membership, and an agency that the marketplace has suspended.
 */
export async function resolveAuditMember(userId: string): Promise<AuditMember> {
  const [user, staff, agencyMember] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, type: true, status: true } }),
    prisma.auditStaffMember.findUnique({ where: { userId } }),
    prisma.inspectionAgencyMember.findUnique({
      where: { userId },
      select: { id: true, status: true, agency: { select: { id: true, name: true, kind: true, status: true } } },
    }),
  ]);

  if (user === null || user.type !== 'AUDIT' || user.status !== 'ACTIVE') notAMember();

  if (staff !== null) {
    if (staff.status !== 'ACTIVE') notAMember();
    return {
      userId,
      email: user.email,
      fullName: staff.fullName,
      kind: 'STAFF',
      role: staff.role,
      permissions: staffConsoleKeys(staff.role),
      agency: null,
      staffMemberId: staff.id,
      inspection: null,
    };
  }

  if (agencyMember === null || agencyMember.status !== 'ACTIVE') notAMember();

  // The inspection service's own resolver, so the job rules see exactly the
  // membership they always have. It refuses a suspended agency.
  const inspection = await resolveInspectionMembership(userId);
  return {
    userId,
    email: user.email,
    fullName: inspection.fullName,
    kind: 'AGENCY',
    role: inspection.role,
    permissions: agencyConsoleKeys(inspection.role),
    agency: { id: agencyMember.agency.id, name: agencyMember.agency.name, kind: agencyMember.agency.kind },
    staffMemberId: null,
    inspection,
  };
}

export function assertAuditPermission(member: AuditMember, ...keys: AuditConsoleKey[]): void {
  for (const key of keys) {
    if (!member.permissions.has(key)) {
      throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Your role in the Audit Console does not allow this.');
    }
  }
}

/** The agency membership, or a refusal: for routes only agency people use. */
export function agencyOf(member: AuditMember): InspectionMembership {
  if (member.inspection === null) {
    throw forbidden(ErrorCode.INSPECTION_AGENCY_MEMBER_REQUIRED, 'This is for inspection agency members.');
  }
  return member.inspection;
}

/** A label for timelines and audit rows. */
export function memberLabel(member: AuditMember): string {
  return member.agency === null ? `${member.fullName} (audit team)` : `${member.fullName} (${member.agency.name})`;
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

export interface Inviter {
  party: 'ADMIN' | 'AUDIT';
  userId: string;
  label: string;
  /** For an agency admin inviting into their own agency. */
  agencyId?: string | null;
  correlationId?: string | null;
}

export type InviteTarget =
  | { kind: 'STAFF'; role: AuditStaffRoleName }
  | {
      kind: 'AGENCY';
      agencyId: string;
      role: InspectionAgencyRoleName;
      jobTitle?: string | null;
      idDocumentType?: string | null;
      idDocumentNumber?: string | null;
      competenceCategoryIds?: string[] | null;
      credentials?: string | null;
      credentialExpiresAt?: Date | null;
    };

async function assertEmailFree(emailNormalized: string): Promise<void> {
  const existing = await prisma.user.findUnique({ where: { emailNormalized }, select: { type: true } });
  if (existing !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      existing.type === 'AUDIT'
        ? 'That address already has an Audit Console account.'
        : 'That address is already used by another account on this marketplace. Audit Console users need a work address of their own.',
      [{ field: 'email', code: 'EMAIL_IN_USE' }],
    );
  }
}

async function sendInvitationEmail(params: {
  to: string;
  fullName: string;
  where: string;
  token: string;
  expiresAt: Date;
}): Promise<void> {
  const url = buildTokenUrl('INVITATION', params.token, 'AUDIT');
  const marketplace = await getMarketplaceName(prisma);
  try {
    await emailDriver.send({
      to: params.to,
      subject: `Set up your ${marketplace} Audit Console account`,
      text:
        `Hello ${params.fullName},\n\n` +
        `You have been given access to the ${marketplace} Audit Console as part of ${params.where}.\n\n` +
        `Open this link to choose a password. It works once and expires on ${params.expiresAt.toISOString()}.\n\n` +
        `${url}\n\n` +
        'You will be asked to set up two-step sign-in with an authenticator app.\n' +
        'If you were not expecting this, ignore it and tell your contact at the marketplace.\n',
    });
  } catch (error) {
    // The invitation exists and can be re-sent; a mail outage must not undo it.
    logger.warn({ err: error }, 'could not send an Audit Console invitation email');
  }
}

/** Invitation tokens for the console expire on the console's own clock. */
async function issueInvitation(userId: string, createdById: string | null, tx: Parameters<typeof issueToken>[3]) {
  const issued = await issueToken(userId, 'INVITATION', createdById, tx);
  const expiresAt = new Date(Date.now() + env.AUDIT_INVITE_TTL_HOURS * 3_600_000);
  if (tx !== undefined) {
    await tx.authToken.updateMany({ where: { userId, type: 'INVITATION', consumedAt: null }, data: { expiresAt } });
  }
  return { token: issued.token, expiresAt };
}

/**
 * Invite somebody to the console. Creates the AUDIT account (no password, so
 * it cannot be signed into), the membership (INVITED, so it holds nothing),
 * and a single-use activation link. No password is ever emailed.
 *
 * Who may invite whom:
 *   - the Admin Panel (operator staff holding audit_console.manage): anybody;
 *   - an agency admin in the console: their own agency's people only, never
 *     audit staff and never into another agency.
 */
export async function inviteToConsole(
  inviter: Inviter,
  input: { email: string; fullName: string; target: InviteTarget },
): Promise<{ userId: string; memberId: string; expiresAt: Date }> {
  if (inviter.party === 'AUDIT') {
    if (input.target.kind !== 'AGENCY' || inviter.agencyId === undefined || inviter.agencyId === null) {
      throw forbidden(ErrorCode.AUDIT_MEMBER_REQUIRED, 'Only the marketplace can invite members of its audit team.');
    }
    if (input.target.agencyId !== inviter.agencyId) throw notFound('Inspection agency');
  }

  const fullName = input.fullName.trim();
  if (fullName.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the person’s full name.', [{ field: 'fullName', code: 'REQUIRED' }]);
  }
  const emailNormalized = normaliseEmail(input.email);
  await assertEmailFree(emailNormalized);

  let where = 'the marketplace audit team';
  if (input.target.kind === 'AGENCY') {
    const agency = await prisma.inspectionAgency.findUnique({
      where: { id: input.target.agencyId },
      select: { name: true, status: true },
    });
    if (agency === null) throw notFound('Inspection agency');
    if (agency.status !== 'ACTIVE') {
      throw conflict(ErrorCode.INSPECTION_AGENCY_NOT_ELIGIBLE, 'That inspection agency is suspended.', [{ code: 'SUSPENDED' }]);
    }
    where = agency.name;
  }

  const userId = newId();
  const memberId = newId();
  let token = '';
  let expiresAt = new Date();

  await withWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: userId,
        type: 'AUDIT',
        email: input.email.trim(),
        emailNormalized,
        passwordHash: null,
        status: 'PENDING_INVITATION',
      },
    });

    if (input.target.kind === 'STAFF') {
      await tx.auditStaffMember.create({
        data: { id: memberId, userId, role: input.target.role, status: 'INVITED', fullName, invitedByUserId: inviter.userId },
      });
    } else {
      const target = input.target;
      await tx.inspectionAgencyMember.create({
        data: {
          id: memberId,
          agencyId: target.agencyId,
          userId,
          role: target.role,
          status: 'INVITED',
          fullName,
          jobTitle: target.jobTitle?.trim() || null,
          idDocumentType: target.idDocumentType?.trim() || null,
          idDocumentNumber: target.idDocumentNumber?.trim() || null,
          competenceCategoryIdsJson: target.competenceCategoryIds ?? undefined,
          credentials: target.credentials?.trim() || null,
          credentialExpiresAt: target.credentialExpiresAt ?? null,
          addedById: inviter.userId,
        },
      });
    }

    const issued = await issueInvitation(userId, inviter.party === 'ADMIN' ? inviter.userId : null, tx);
    token = issued.token;
    expiresAt = issued.expiresAt;

    await recordAudit(
      {
        action: AuditAction.AUDIT_MEMBER_INVITED,
        resourceType: input.target.kind === 'STAFF' ? 'audit_staff_member' : 'inspection_agency_member',
        resourceId: memberId,
        actorType: inviter.party,
        actorUserId: inviter.userId,
        after: {
          kind: input.target.kind,
          role: input.target.role,
          agencyId: input.target.kind === 'AGENCY' ? input.target.agencyId : null,
          fullName,
        },
        correlationId: inviter.correlationId ?? null,
      },
      tx,
    );
  }));

  await sendInvitationEmail({ to: input.email.trim(), fullName, where, token, expiresAt });
  return { userId, memberId, expiresAt };
}

/**
 * Send a fresh activation link to somebody who has not activated yet. The old
 * link stops working.
 */
export async function resendInvitation(inviter: Inviter, userId: string): Promise<{ expiresAt: Date }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, type: true, status: true },
  });
  if (user === null || user.type !== 'AUDIT') throw notFound('Audit Console account');
  if (user.status !== 'PENDING_INVITATION') {
    throw conflict(ErrorCode.CONFLICT, 'This account is already active.', [{ code: 'ALREADY_ACTIVE' }]);
  }
  const [staff, agencyMember] = await Promise.all([
    prisma.auditStaffMember.findUnique({ where: { userId }, select: { fullName: true } }),
    prisma.inspectionAgencyMember.findUnique({
      where: { userId },
      select: { fullName: true, agencyId: true, agency: { select: { name: true } } },
    }),
  ]);
  if (inviter.party === 'AUDIT' && agencyMember?.agencyId !== inviter.agencyId) throw notFound('Audit Console account');

  const issued = await prisma.$transaction((tx) => issueInvitation(userId, inviter.party === 'ADMIN' ? inviter.userId : null, tx));
  await sendInvitationEmail({
    to: user.email,
    fullName: staff?.fullName ?? agencyMember?.fullName ?? '',
    where: agencyMember?.agency.name ?? 'the marketplace audit team',
    token: issued.token,
    expiresAt: issued.expiresAt,
  });
  return { expiresAt: issued.expiresAt };
}

/**
 * Move an agency member whose login was a storefront account (the
 * arrangement before the console existed) onto a new console account. The
 * member row keeps its id, role, competence and job history; only the account
 * behind it changes. The storefront account itself is untouched and simply
 * stops being an inspector.
 */
export async function moveAgencyMemberToConsole(
  inviter: Inviter,
  memberId: string,
  input: { email: string },
): Promise<{ userId: string; expiresAt: Date }> {
  if (inviter.party !== 'ADMIN') {
    throw forbidden(ErrorCode.PERMISSION_DENIED, 'Only the marketplace moves an agency member to the console.');
  }
  const member = await prisma.inspectionAgencyMember.findUnique({
    where: { id: memberId },
    select: { id: true, userId: true, fullName: true, agency: { select: { name: true } } },
  });
  if (member === null) throw notFound('Agency member');
  const current = await prisma.user.findUnique({ where: { id: member.userId }, select: { type: true } });
  if (current?.type === 'AUDIT') {
    throw conflict(ErrorCode.CONFLICT, 'This member already signs in to the Audit Console.', [{ code: 'ALREADY_MOVED' }]);
  }

  const emailNormalized = normaliseEmail(input.email);
  await assertEmailFree(emailNormalized);

  const userId = newId();
  let token = '';
  let expiresAt = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: { id: userId, type: 'AUDIT', email: input.email.trim(), emailNormalized, passwordHash: null, status: 'PENDING_INVITATION' },
    });
    await tx.inspectionAgencyMember.update({ where: { id: member.id }, data: { userId, status: 'INVITED' } });
    const issued = await issueInvitation(userId, inviter.userId, tx);
    token = issued.token;
    expiresAt = issued.expiresAt;
    await recordAudit(
      {
        action: AuditAction.AUDIT_MEMBER_INVITED,
        resourceType: 'inspection_agency_member',
        resourceId: member.id,
        actorType: 'ADMIN',
        actorUserId: inviter.userId,
        before: { userId: member.userId },
        after: { userId, movedToConsole: true },
        correlationId: inviter.correlationId ?? null,
      },
      tx,
    );
  });

  await sendInvitationEmail({ to: input.email.trim(), fullName: member.fullName, where: member.agency.name, token, expiresAt });
  return { userId, expiresAt };
}

/** The invitation was redeemed: the membership becomes usable. */
export async function markConsoleInvitationAccepted(userId: string): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const staff = await tx.auditStaffMember.updateMany({
      where: { userId, status: 'INVITED' },
      data: { status: 'ACTIVE', activatedAt: now },
    });
    const agency = await tx.inspectionAgencyMember.updateMany({
      where: { userId, status: 'INVITED' },
      data: { status: 'ACTIVE' },
    });
    if (staff.count + agency.count > 0) {
      await recordAudit(
        {
          action: AuditAction.AUDIT_MEMBER_ACTIVATED,
          resourceType: staff.count > 0 ? 'audit_staff_member' : 'inspection_agency_member',
          resourceId: userId,
          actorType: 'AUDIT',
          actorUserId: userId,
          after: { status: 'ACTIVE' },
        },
        tx,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Staff membership changes (Admin Panel)
// ---------------------------------------------------------------------------

export async function updateStaffMember(
  admin: { userId: string; correlationId?: string | null },
  memberId: string,
  input: { role?: AuditStaffRoleName; status?: 'ACTIVE' | 'DISABLED'; disabledReason?: string | null; competenceCategoryIds?: string[] | null },
): Promise<void> {
  const member = await prisma.auditStaffMember.findUnique({ where: { id: memberId } });
  if (member === null) throw notFound('Audit team member');
  if (input.status === 'ACTIVE' && member.status === 'INVITED') {
    throw conflict(ErrorCode.CONFLICT, 'This person has not activated their account yet.', [{ code: 'NOT_ACTIVATED' }]);
  }
  if (input.status === 'DISABLED' && (input.disabledReason ?? '').trim().length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why access is being removed.', [{ field: 'disabledReason', code: 'REQUIRED' }]);
  }

  await prisma.$transaction(async (tx) => {
    await tx.auditStaffMember.update({
      where: { id: memberId },
      data: {
        ...(input.role === undefined ? {} : { role: input.role }),
        ...(input.competenceCategoryIds === undefined ? {} : { competenceCategoryIdsJson: input.competenceCategoryIds ?? undefined }),
        ...(input.status === undefined
          ? {}
          : input.status === 'DISABLED'
            ? { status: 'DISABLED', disabledAt: new Date(), disabledReason: input.disabledReason?.trim() ?? null }
            : { status: 'ACTIVE', disabledAt: null, disabledReason: null }),
      },
    });
    await recordAudit(
      {
        action: AuditAction.AUDIT_MEMBER_CHANGED,
        resourceType: 'audit_staff_member',
        resourceId: memberId,
        actorType: 'ADMIN',
        actorUserId: admin.userId,
        before: { role: member.role, status: member.status },
        after: input,
        correlationId: admin.correlationId ?? null,
      },
      tx,
    );
  });

  // Removing access ends every console session that person holds now, not
  // when their token next expires.
  if (input.status === 'DISABLED') {
    await prisma.session.updateMany({
      where: { userId: member.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: 'audit_access_removed' },
    });
  }
}

// ---------------------------------------------------------------------------
// Who is in the console (for the Admin Panel and the console's team screen)
// ---------------------------------------------------------------------------

export interface ConsolePerson {
  memberId: string;
  userId: string;
  kind: 'STAFF' | 'AGENCY';
  fullName: string;
  email: string;
  role: AuditRoleName;
  status: string;
  agency: { id: string; name: string } | null;
  accountType: string;
  activated: boolean;
  mfaEnrolled: boolean;
  identityVerified: boolean | null;
  credentialExpiresAt: string | null;
  competenceCategoryIds: string[];
}

function idsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

/**
 * Everybody with a console membership. `agencyId` narrows to one agency -
 * which is how an agency admin's team screen is built, with the id taken from
 * their session, never from the request.
 */
export async function listConsolePeople(scope: { agencyId: string | null; includeStaff: boolean }): Promise<ConsolePerson[]> {
  const [staff, agencyMembers] = await Promise.all([
    scope.includeStaff && scope.agencyId === null
      ? prisma.auditStaffMember.findMany({ orderBy: { fullName: 'asc' } })
      : Promise.resolve([]),
    prisma.inspectionAgencyMember.findMany({
      where: scope.agencyId === null ? {} : { agencyId: scope.agencyId },
      orderBy: [{ agencyId: 'asc' }, { fullName: 'asc' }],
      include: { agency: { select: { id: true, name: true } } },
    }),
  ]);
  const userIds = [...staff.map((row) => row.userId), ...agencyMembers.map((row) => row.userId)];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, email: true, type: true, status: true, mfaEnabledAt: true },
  });
  const byId = new Map(users.map((user) => [user.id, user]));

  return [
    ...staff.map((row): ConsolePerson => {
      const user = byId.get(row.userId);
      return {
        memberId: row.id,
        userId: row.userId,
        kind: 'STAFF',
        fullName: row.fullName,
        email: user?.email ?? '',
        role: row.role,
        status: row.status,
        agency: null,
        accountType: user?.type ?? 'AUDIT',
        activated: user?.status === 'ACTIVE',
        mfaEnrolled: (user?.mfaEnabledAt ?? null) !== null,
        identityVerified: null,
        credentialExpiresAt: null,
        competenceCategoryIds: idsOf(row.competenceCategoryIdsJson),
      };
    }),
    ...agencyMembers.map((row): ConsolePerson => {
      const user = byId.get(row.userId);
      return {
        memberId: row.id,
        userId: row.userId,
        kind: 'AGENCY',
        fullName: row.fullName,
        email: user?.email ?? '',
        role: row.role,
        status: row.status,
        agency: { id: row.agency.id, name: row.agency.name },
        // CUSTOMER here means a member still signing in with a storefront
        // account, from before the console: the Admin Panel offers to move them.
        accountType: user?.type ?? 'UNKNOWN',
        activated: user?.status === 'ACTIVE',
        mfaEnrolled: (user?.mfaEnabledAt ?? null) !== null,
        identityVerified: row.identityVerifiedAt !== null,
        credentialExpiresAt: row.credentialExpiresAt?.toISOString() ?? null,
        competenceCategoryIds: idsOf(row.competenceCategoryIdsJson),
      };
    }),
  ];
}
