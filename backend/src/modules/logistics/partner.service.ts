/**
 * The logistics organisation: who it is, who is in it, and what each may do.
 *
 * This file is the ownership boundary for the entire portal. Every shipment
 * assignment, event, pickup, manifest, driver, vehicle, trip, exception,
 * document and audit row is owned by a logistics partner, and the ONLY way any
 * other service obtains a partner id is `resolveLogisticsMembership` below,
 * which derives it from the session.
 *
 * There is no `?logisticsPartnerId=` in any route, no handler reads an owner
 * from a request body, and no service in this module accepts a partner id from
 * its caller without having been handed a `LogisticsMembership` first. That is
 * the one control that makes tenant isolation true rather than intended: a
 * function taking a partner id as a plain string is one refactor away from
 * taking one an attacker chose.
 *
 * It is the same discipline `seller/account.service.ts` and
 * `customer-erp/organization.service.ts` follow, and the shape is deliberately
 * recognisable from both.
 *
 * ONE THING THIS BOUNDARY DOES THAT THEIRS DOES NOT
 *
 * Tenancy is necessary here and not sufficient. A carrier may only reach a
 * consignment an assignment currently joins to it - see
 * `shipment.service.ts`'s `assertShipmentAccess`. A seller owns its listings
 * for ever; a carrier is lent somebody else's delivery address for the length
 * of one job, and must stop being able to read it when the job ends.
 */
import type {
  LogisticsMemberStatus,
  LogisticsPartnerRole,
  LogisticsPartnerStatus,
} from '../../generated/prisma/enums.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  LogisticsPermission,
  canGrantLogisticsRole,
  logisticsRoleDefinition,
  logisticsRoleRequiresMfa,
  permissionsForLogisticsRole,
  type LogisticsPermissionKey,
} from '../../domain/logistics-permissions.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { normaliseEmail } from '../identity/auth.service.js';
import { issueToken } from '../identity/token.service.js';
import { recordLogisticsAudit } from './audit.service.js';

// ---------------------------------------------------------------------------
// Names and references
// ---------------------------------------------------------------------------

/**
 * Lowercased, punctuation-stripped, collapsed.
 *
 * Backs the UNIQUE index on the display name, which is what makes "Swift
 * Freight", "SwiftFreight" and "swift-freight." one carrier rather than three
 * on an operator's assignment dropdown - where picking the wrong one sends a
 * consignment to a company that is not expecting it.
 */
export function normaliseLogisticsName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface LogisticsMembership {
  logisticsPartnerId: string;
  partnerCode: string;
  displayName: string;
  legalName: string;
  partnerStatus: LogisticsPartnerStatus;
  registrationCountry: string;

  partnerUserId: string;
  userId: string;
  fullName: string;
  role: LogisticsPartnerRole;
  permissions: ReadonlySet<LogisticsPermissionKey>;

  /**
   * Whether new work may be offered to this carrier right now.
   *
   * False for a SUSPENDED partner, and a suspended partner is deliberately
   * still able to sign in and work what it is holding. Cutting off a carrier
   * mid-journey would leave parcels it has in a van untrackable, which
   * punishes the customer rather than the carrier.
   */
  canAcceptNewWork: boolean;

  /** Whether this role's sessions must pass a TOTP challenge. */
  requiresMfa: boolean;

  /**
   * The approved service regions this person may work, as region ids. Null
   * means "all of the partner's regions", which is the ordinary case for an
   * office role.
   */
  regionScope: readonly string[] | null;

  /** Their driver profile, where they have one. Null for everybody else. */
  driverProfileId: string | null;
}

interface MembershipRow {
  id: string;
  userId: string;
  role: LogisticsPartnerRole;
  status: LogisticsMemberStatus;
  fullName: string;
  regionScopeJson: unknown;
  partner: {
    id: string;
    partnerCode: string;
    displayName: string;
    legalName: string;
    status: LogisticsPartnerStatus;
    registrationCountry: string;
  };
  driverProfile: { id: string } | null;
}

/**
 * Region scope, defensively.
 *
 * The column is JSON, so what comes back is whatever was written - including,
 * on a row edited by hand, something that is not an array of strings. An
 * unreadable scope resolves to null, which means "all of this partner's
 * regions", and that is the safe direction here rather than the dangerous one:
 * the regions in question are already the ones the MARKETPLACE approved for
 * this carrier, so the worst case is a dispatcher seeing their own company's
 * other depot. Failing closed would lock somebody out of their whole job over
 * a malformed column.
 */
function parseRegionScope(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;

  const ids = value.filter((entry): entry is string => typeof entry === 'string');
  return ids.length === 0 ? null : Object.freeze(ids);
}

function toMembership(row: MembershipRow): LogisticsMembership {
  return {
    logisticsPartnerId: row.partner.id,
    partnerCode: row.partner.partnerCode,
    displayName: row.partner.displayName,
    legalName: row.partner.legalName,
    partnerStatus: row.partner.status,
    registrationCountry: row.partner.registrationCountry,

    partnerUserId: row.id,
    userId: row.userId,
    fullName: row.fullName,
    role: row.role,
    permissions: permissionsForLogisticsRole(row.role),

    canAcceptNewWork: row.partner.status === 'ACTIVE',
    requiresMfa: logisticsRoleRequiresMfa(row.role),
    regionScope: parseRegionScope(row.regionScopeJson),
    driverProfileId: row.driverProfile?.id ?? null,
  };
}

const MEMBERSHIP_SELECT = {
  id: true,
  userId: true,
  role: true,
  status: true,
  fullName: true,
  regionScopeJson: true,
  partner: {
    select: {
      id: true,
      partnerCode: true,
      displayName: true,
      legalName: true,
      status: true,
      registrationCountry: true,
    },
  },
  driverProfile: { select: { id: true } },
} as const;

/**
 * The caller's logistics organisation, or a refusal explaining what to do.
 *
 * Three different refusals, and they are separate codes because the person's
 * next action is different in each case: talk to the marketplace, wait for the
 * marketplace, or talk to their own manager. One generic "no access" would
 * send all three to the wrong conversation.
 *
 * Note what is NOT a refusal: a SUSPENDED partner resolves normally. Its
 * membership simply reports `canAcceptNewWork: false`, and the routes that
 * offer new work check that. A carrier holding twelve parcels when the
 * marketplace suspends it must still be able to deliver them.
 */
export async function resolveLogisticsMembership(userId: string): Promise<LogisticsMembership> {
  const row = await prisma.logisticsPartnerUser.findUnique({
    where: { userId },
    select: MEMBERSHIP_SELECT,
  });

  if (row === null || row.partner === null) {
    throw forbidden(
      ErrorCode.LOGISTICS_PARTNER_REQUIRED,
      'This account is not attached to a logistics company.',
    );
  }

  if (row.status === 'DISABLED') {
    throw forbidden(
      ErrorCode.LOGISTICS_MEMBER_DISABLED,
      'Your access to this logistics account has been turned off. Ask an administrator at your company to restore it.',
    );
  }

  if (row.partner.status === 'DEACTIVATED') {
    throw forbidden(
      ErrorCode.LOGISTICS_PARTNER_NOT_ACTIVE,
      'This logistics account is closed. Contact the marketplace operations team.',
    );
  }

  if (row.partner.status === 'PENDING_ACTIVATION') {
    throw forbidden(
      ErrorCode.LOGISTICS_PARTNER_NOT_ACTIVE,
      'This logistics account has not been activated by the marketplace yet.',
    );
  }

  return toMembership(row);
}

/**
 * The caller's organisation, or null.
 *
 * Null is a normal answer rather than an error, for the same reason
 * `findSellerMembership` returns one: something has to be able to ask "does
 * this account belong to a carrier?" without catching an exception - the
 * activation screen, and the `/auth/me` response the portal boots from.
 */
export async function findLogisticsMembership(
  userId: string,
): Promise<LogisticsMembership | null> {
  const row = await prisma.logisticsPartnerUser.findUnique({
    where: { userId },
    select: MEMBERSHIP_SELECT,
  });

  return row === null ? null : toMembership(row);
}

/** Throws unless the member holds the permission. */
export function assertLogisticsPermission(
  membership: LogisticsMembership,
  permission: LogisticsPermissionKey,
): void {
  if (!membership.permissions.has(permission)) {
    throw forbidden(
      ErrorCode.PERMISSION_DENIED,
      'You do not have permission to perform this action.',
    );
  }
}

/**
 * Throws unless the carrier may take on new work.
 *
 * Separate from the permission check because the two refuse for different
 * reasons and offer different remedies: the owner of a suspended carrier holds
 * every permission in the catalogue and still may not accept a consignment.
 * Called by everything that takes on an obligation - accepting an assignment,
 * scheduling a pickup - and by nothing that discharges one.
 */
export function assertPartnerCanAcceptWork(membership: LogisticsMembership): void {
  if (!membership.canAcceptNewWork) {
    throw conflict(
      ErrorCode.LOGISTICS_PARTNER_NOT_ACTIVE,
      'This logistics account is suspended and cannot take on new work. Shipments already ' +
        'assigned to it can still be completed.',
    );
  }
}

/**
 * The whole feature's master switch.
 *
 * Checked at the top of every logistics route rather than only at
 * registration, so an installation that turns the flag off mid-flight stops
 * answering rather than serving a half-configured portal.
 */
export function assertLogisticsEnabled(): void {
  if (!env.FEATURE_LOGISTICS_PORTAL) {
    throw forbidden(
      ErrorCode.FEATURE_DISABLED,
      'The logistics partner portal is not enabled on this installation.',
    );
  }
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

export interface InviteLogisticsUserInput {
  logisticsPartnerId: string;
  email: string;
  fullName: string;
  role: LogisticsPartnerRole;
  jobTitle?: string | null;
  phone?: string | null;
  /** Null when the marketplace itself is inviting - the first owner. */
  invitedByPartnerUserId: string | null;
  invitedByAdminUserId: string | null;
  actorLabel: string;
  correlationId?: string | null;
}

export interface InvitedLogisticsUser {
  invitationId: string;
  partnerUserId: string;
  userId: string;
  email: string;
  /** The raw activation token. Goes into exactly one email and is never stored. */
  token: string;
  expiresAt: Date;
}

/**
 * Invite somebody into a logistics organisation.
 *
 * NO PASSWORD IS EVER EMAILED. The invitation carries a 32-byte single-use
 * token whose SHA-256 is all that is stored, it expires, and the person
 * chooses their own password when they redeem it. That rule is not new to this
 * feature - it is what `token.service.ts` has always done - and it is restated
 * here because a carrier onboarding flow is exactly where somebody would be
 * tempted to send a temporary password "to make it easier".
 *
 * The `User` row is created PENDING_INVITATION with a null password hash, so
 * the account cannot be signed into at all until the token is redeemed. The
 * whole thing is one transaction: a rolled-back membership must not leave a
 * live invitation behind, and an invitation nobody can accept is worse than
 * none.
 */
export async function inviteLogisticsUser(
  input: InviteLogisticsUserInput,
): Promise<InvitedLogisticsUser> {
  const emailNormalized = normaliseEmail(input.email);

  if (logisticsRoleDefinition(input.role) === undefined) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'That is not a role this portal knows.', [
      { field: 'role', code: 'UNKNOWN_ROLE' },
    ]);
  }

  /*
   * An address that already has an account of ANY kind.
   *
   * Refused rather than reused, and this is the one place the three audiences
   * genuinely have to be kept apart by hand. `users.emailNormalized` is unique
   * across all of them, so a shopper's address cannot also become a carrier's
   * dispatcher - and that is the correct answer. A person who buys here and
   * also drives for a haulier needs two accounts, because the two are two
   * different legal relationships with two different sets of data behind them.
   */
  const existing = await prisma.user.findUnique({
    where: { emailNormalized },
    select: { id: true, type: true },
  });

  if (existing !== null) {
    throw conflict(
      ErrorCode.CONFLICT,
      existing.type === 'LOGISTICS'
        ? 'That address already has a logistics account.'
        : 'That address is already used by an account on this marketplace. Logistics users ' +
          'need an address of their own.',
      [{ field: 'email', code: 'EMAIL_IN_USE' }],
    );
  }

  const partner = await prisma.logisticsPartner.findFirst({
    where: { id: input.logisticsPartnerId, archivedAt: null },
    select: { id: true, displayName: true, status: true },
  });

  if (partner === null) throw notFound('Logistics partner');

  const userId = newId();
  const partnerUserId = newId();
  const invitationId = newId();

  /*
   * Filled in inside the transaction, from the token `issueToken` mints.
   *
   * They were generated HERE once, separately from the credential, and that was
   * the bug: the link that went out in the email hashed to the invitation's
   * business record, while the row the activation endpoint actually reads -
   * `AuthToken` - held the hash of a different token nobody had ever seen. Every
   * carrier invitation was therefore a dead link, answering "This link is not
   * valid" on a first, unused click. One token now, hashed into both rows.
   */
  let invitationToken = '';
  let expiresAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.user.create({
      data: {
        id: userId,
        type: 'LOGISTICS',
        email: input.email.trim(),
        emailNormalized,
        phone: input.phone ?? null,
        // Null, deliberately. There is nothing to sign in with until the
        // token is redeemed and a password is chosen.
        passwordHash: null,
        status: 'PENDING_INVITATION',
      },
    });

    await tx.logisticsPartnerUser.create({
      data: {
        id: partnerUserId,
        logisticsPartnerId: partner.id,
        userId,
        role: input.role,
        status: 'INVITED',
        fullName: input.fullName.trim(),
        jobTitle: input.jobTitle ?? null,
        phone: input.phone ?? null,
      },
    });

    /*
     * The credential, minted first so the business record beside it can be
     * written from the same token.
     *
     * `issueToken` also supersedes any outstanding invitation this person
     * already holds, which is why it is called rather than an `AuthToken` row
     * being written here by hand.
     */
    const issued = await issueToken(userId, 'INVITATION', input.invitedByAdminUserId, tx);

    invitationToken = issued.token;
    expiresAt = issued.expiresAt;

    await tx.logisticsPartnerInvitation.create({
      data: {
        id: invitationId,
        logisticsPartnerId: partner.id,
        email: input.email.trim(),
        emailNormalized,
        fullName: input.fullName.trim(),
        role: input.role,
        tokenHash: sha256Hex(issued.token),
        expiresAt,
        invitedByPartnerUserId: input.invitedByPartnerUserId,
        invitedByAdminUserId: input.invitedByAdminUserId,
      },
    });

    /*
     * Two rows for one invitation, and they are not redundant. `AuthToken` is
     * the CREDENTIAL, redeemed by the shared `acceptInvitation` machinery every
     * other invitation in this system goes through. The
     * `LogisticsPartnerInvitation` row above is the BUSINESS RECORD: who was
     * asked, to what role, by whom, and whether they ever answered. They now
     * carry the hash of the same token, which is what makes the emailed link
     * redeemable at all.
     */

    await recordLogisticsAudit(
      {
        logisticsPartnerId: partner.id,
        actorUserId: input.invitedByAdminUserId,
        actorLabel: input.actorLabel,
        action: 'logistics.member.invited',
        resourceType: 'logistics_partner_user',
        resourceId: partnerUserId,
        after: { email: emailNormalized, role: input.role },
        summary: `${input.fullName.trim()} was invited as ${input.role}.`,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );
  });

  return {
    invitationId,
    partnerUserId,
    userId,
    email: input.email.trim(),
    token: invitationToken,
    expiresAt,
  };
}

/**
 * Mark the business record accepted, once the credential has been redeemed.
 *
 * Called by the activation route AFTER `acceptInvitation` has succeeded, never
 * instead of it. The order matters: the credential is what proves the person
 * holds the emailed link, and this only records that it happened.
 */
export async function markInvitationAccepted(userId: string): Promise<void> {
  const membership = await prisma.logisticsPartnerUser.findUnique({
    where: { userId },
    select: { id: true, logisticsPartnerId: true, fullName: true, role: true },
  });

  if (membership === null) return;

  const emailNormalized = (
    await prisma.user.findUnique({ where: { id: userId }, select: { emailNormalized: true } })
  )?.emailNormalized;

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartnerUser.update({
      where: { id: membership.id },
      data: { status: 'ACTIVE' },
    });

    if (emailNormalized !== undefined) {
      await tx.logisticsPartnerInvitation.updateMany({
        where: {
          logisticsPartnerId: membership.logisticsPartnerId,
          emailNormalized,
          acceptedAt: null,
          revokedAt: null,
        },
        data: { acceptedAt: new Date() },
      });
    }

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: userId,
        actorLabel: membership.fullName,
        action: 'logistics.member.activated',
        resourceType: 'logistics_partner_user',
        resourceId: membership.id,
        summary: `${membership.fullName} activated their account.`,
      },
      tx,
    );
  });
}

export interface ListedLogisticsMember {
  id: string;
  fullName: string;
  email: string;
  role: LogisticsPartnerRole;
  status: LogisticsMemberStatus;
  jobTitle: string | null;
  phone: string | null;
  isDriver: boolean;
  requiresMfa: boolean;
  mfaEnrolled: boolean;
  lastActiveAt: Date | null;
  createdAt: Date;
}

export async function listLogisticsMembers(
  membership: LogisticsMembership,
): Promise<ListedLogisticsMember[]> {
  assertLogisticsPermission(membership, LogisticsPermission.MEMBER_READ);

  const rows = await prisma.logisticsPartnerUser.findMany({
    where: { logisticsPartnerId: membership.logisticsPartnerId },
    orderBy: [{ status: 'asc' }, { fullName: 'asc' }],
    select: {
      id: true,
      fullName: true,
      role: true,
      status: true,
      jobTitle: true,
      phone: true,
      lastActiveAt: true,
      createdAt: true,
      driverProfile: { select: { id: true } },
      user: { select: { email: true, mfaEnabledAt: true } },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    fullName: row.fullName,
    email: row.user.email,
    role: row.role,
    status: row.status,
    jobTitle: row.jobTitle,
    phone: row.phone,
    isDriver: row.driverProfile !== null,
    requiresMfa: logisticsRoleRequiresMfa(row.role),
    // Whether they have enrolled, never the secret and never a hint at it.
    mfaEnrolled: row.user.mfaEnabledAt !== null,
    lastActiveAt: row.lastActiveAt,
    createdAt: row.createdAt,
  }));
}

/**
 * Change a colleague's role, or turn their access off.
 *
 * Two refusals worth stating, because both are privilege escalations that look
 * like ordinary administration:
 *
 *   - **Nobody may grant a role they do not themselves hold.**
 *     `canGrantLogisticsRole` is what stops an ADMIN minting an OWNER and
 *     thereby granting themselves the keys ADMIN deliberately lacks.
 *   - **Nobody may change their own role or disable themselves.** A person
 *     who could demote themselves could not be audited as the person who did
 *     the thing before it, and a company whose last owner disables their own
 *     account has no way back in.
 */
export async function updateLogisticsMember(
  membership: LogisticsMembership,
  partnerUserId: string,
  changes: {
    role?: LogisticsPartnerRole;
    status?: LogisticsMemberStatus;
    jobTitle?: string | null;
    phone?: string | null;
    disabledReason?: string | null;
  },
  correlationId?: string | null,
): Promise<ListedLogisticsMember> {
  assertLogisticsPermission(membership, LogisticsPermission.MEMBER_WRITE);

  if (partnerUserId === membership.partnerUserId) {
    throw conflict(
      ErrorCode.CONFLICT,
      'You cannot change your own role or turn off your own access. Ask a colleague, or the ' +
        'marketplace operations team.',
    );
  }

  const target = await prisma.logisticsPartnerUser.findFirst({
    // Tenant filter first, always. An id alone is an id an attacker chose.
    where: { id: partnerUserId, logisticsPartnerId: membership.logisticsPartnerId },
    select: { id: true, role: true, status: true, fullName: true },
  });

  if (target === null) throw notFound('Member');

  if (changes.role !== undefined && changes.role !== target.role) {
    if (!canGrantLogisticsRole(membership.role, changes.role)) {
      throw forbidden(
        ErrorCode.PERMISSION_DENIED,
        'You cannot grant a role that holds more than your own.',
      );
    }
  }

  const disabling = changes.status === 'DISABLED' && target.status !== 'DISABLED';

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartnerUser.update({
      where: { id: target.id },
      data: {
        ...(changes.role !== undefined ? { role: changes.role } : {}),
        ...(changes.status !== undefined ? { status: changes.status } : {}),
        ...(changes.jobTitle !== undefined ? { jobTitle: changes.jobTitle } : {}),
        ...(changes.phone !== undefined ? { phone: changes.phone } : {}),
        ...(disabling
          ? { disabledAt: new Date(), disabledReason: changes.disabledReason ?? null }
          : {}),
        ...(changes.status === 'ACTIVE' ? { disabledAt: null, disabledReason: null } : {}),
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: disabling ? 'logistics.member.disabled' : 'logistics.member.updated',
        resourceType: 'logistics_partner_user',
        resourceId: target.id,
        before: { role: target.role, status: target.status },
        after: { role: changes.role ?? target.role, status: changes.status ?? target.status },
        summary: disabling
          ? `${target.fullName}'s access was turned off.`
          : `${target.fullName}'s account was updated.`,
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  /*
   * End their sessions immediately.
   *
   * Outside the transaction on purpose: revoking a session is not part of the
   * membership change and must not be able to roll it back. A disabled member
   * whose sessions survived would keep working until their refresh token
   * expired, which on this deployment is thirty days.
   */
  if (disabling) {
    const account = await prisma.logisticsPartnerUser.findUnique({
      where: { id: target.id },
      select: { userId: true },
    });

    if (account !== null) {
      await prisma.session.updateMany({
        where: { userId: account.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'logistics_member_disabled' },
      });
    }
  }

  const refreshed = await listLogisticsMembers(membership);
  const updated = refreshed.find((row) => row.id === target.id);
  if (updated === undefined) throw notFound('Member');
  return updated;
}

// ---------------------------------------------------------------------------
// The organisation's own record
// ---------------------------------------------------------------------------

export interface LogisticsPartnerProfile {
  id: string;
  partnerCode: string;
  legalName: string;
  displayName: string;
  registrationNumber: string | null;
  taxNumber: string | null;
  licenceNumber: string | null;
  licenceExpiresAt: Date | null;
  registrationCountry: string;
  contactEmail: string;
  contactPhone: string | null;
  emergencyPhone: string | null;
  websiteUrl: string | null;
  status: LogisticsPartnerStatus;
  contractStatus: string;
  contractReference: string | null;
  contractStartsAt: Date | null;
  contractEndsAt: Date | null;
  suspensionReason: string | null;
  regions: {
    id: string;
    scope: string;
    countryCode: string;
    regionValue: string;
    supportsPickup: boolean;
    supportsDelivery: boolean;
    isActive: boolean;
  }[];
  capabilities: { id: string; kind: string; state: string; evidenceExpiresAt: Date | null }[];
  slaPolicies: {
    id: string;
    name: string;
    serviceType: string;
    pickupHours: number | null;
    deliveryHours: number | null;
    riskWindowMinutes: number;
    maxDeliveryAttempts: number;
    isDefault: boolean;
    podRequiresRecipientName: boolean;
    podRequiresSignature: boolean;
    podRequiresPhoto: boolean;
    podRequiresOtp: boolean;
    podRequiresDesignation: boolean;
  }[];
}

/**
 * The carrier's own record, as the carrier sees it.
 *
 * Note what is absent: `internalNotes`. It is the operator's free-text field
 * about this company, it routinely names other people, and it is never
 * selected on a path a partner can reach - the same line
 * `CustomerProfile.internalNotes` draws. Absent rather than stripped, because
 * a column that is never selected cannot be leaked by a query somebody forgets
 * to narrow.
 */
export async function readLogisticsPartnerProfile(
  membership: LogisticsMembership,
): Promise<LogisticsPartnerProfile> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_READ);

  const partner = await prisma.logisticsPartner.findUnique({
    where: { id: membership.logisticsPartnerId },
    select: {
      id: true,
      partnerCode: true,
      legalName: true,
      displayName: true,
      registrationNumber: true,
      taxNumber: true,
      licenceNumber: true,
      licenceExpiresAt: true,
      registrationCountry: true,
      contactEmail: true,
      contactPhone: true,
      emergencyPhone: true,
      websiteUrl: true,
      status: true,
      contractStatus: true,
      contractReference: true,
      contractStartsAt: true,
      contractEndsAt: true,
      suspensionReason: true,
      regions: {
        orderBy: [{ countryCode: 'asc' }, { regionValue: 'asc' }],
        select: {
          id: true,
          scope: true,
          countryCode: true,
          regionValue: true,
          supportsPickup: true,
          supportsDelivery: true,
          isActive: true,
        },
      },
      capabilities: {
        orderBy: { kind: 'asc' },
        select: { id: true, kind: true, state: true, evidenceExpiresAt: true },
      },
      slaPolicies: {
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          serviceType: true,
          pickupHours: true,
          deliveryHours: true,
          riskWindowMinutes: true,
          maxDeliveryAttempts: true,
          isDefault: true,
          podRequiresRecipientName: true,
          podRequiresSignature: true,
          podRequiresPhoto: true,
          podRequiresOtp: true,
          podRequiresDesignation: true,
        },
      },
    },
  });

  if (partner === null) throw notFound('Logistics partner');

  return partner;
}

/**
 * What a partner may change about itself.
 *
 * Contact details and nothing else. Regions, capabilities, SLA and contract
 * status are the CONTRACT between the marketplace and the carrier, and a
 * carrier that could widen its own approved regions could assign itself work
 * it is not licensed to carry. On a catalogue of medical goods that is not a
 * theoretical objection.
 */
export async function updateLogisticsPartnerContact(
  membership: LogisticsMembership,
  changes: {
    contactEmail?: string;
    contactPhone?: string | null;
    emergencyPhone?: string | null;
    websiteUrl?: string | null;
  },
  correlationId?: string | null,
): Promise<LogisticsPartnerProfile> {
  assertLogisticsPermission(membership, LogisticsPermission.ORGANISATION_WRITE);

  const before = await prisma.logisticsPartner.findUnique({
    where: { id: membership.logisticsPartnerId },
    select: { contactEmail: true, contactPhone: true, emergencyPhone: true, websiteUrl: true },
  });

  if (before === null) throw notFound('Logistics partner');

  await prisma.$transaction(async (tx) => {
    await tx.logisticsPartner.update({
      where: { id: membership.logisticsPartnerId },
      data: {
        ...(changes.contactEmail !== undefined ? { contactEmail: changes.contactEmail } : {}),
        ...(changes.contactPhone !== undefined ? { contactPhone: changes.contactPhone } : {}),
        ...(changes.emergencyPhone !== undefined
          ? { emergencyPhone: changes.emergencyPhone }
          : {}),
        ...(changes.websiteUrl !== undefined ? { websiteUrl: changes.websiteUrl } : {}),
      },
    });

    await recordLogisticsAudit(
      {
        logisticsPartnerId: membership.logisticsPartnerId,
        actorUserId: membership.userId,
        actorLabel: membership.fullName,
        action: 'logistics.organisation.updated',
        resourceType: 'logistics_partner',
        resourceId: membership.logisticsPartnerId,
        before,
        after: changes,
        summary: 'Company contact details were updated.',
        correlationId: correlationId ?? null,
      },
      tx,
    );
  });

  return readLogisticsPartnerProfile(membership);
}

/**
 * Note that this person did something, for the "last active" column.
 *
 * Deliberately fire-and-forget and deliberately coarse - written at most once
 * an hour per member. A column updated on every request turns a read-heavy
 * portal into a write-heavy one and puts a row lock in front of the busiest
 * query in the product.
 */
const LAST_ACTIVE_RESOLUTION_MS = 3_600_000;

export async function touchLogisticsMember(membership: LogisticsMembership): Promise<void> {
  const cutoff = new Date(Date.now() - LAST_ACTIVE_RESOLUTION_MS);

  await prisma.logisticsPartnerUser.updateMany({
    where: {
      id: membership.partnerUserId,
      OR: [{ lastActiveAt: null }, { lastActiveAt: { lt: cutoff } }],
    },
    data: { lastActiveAt: new Date() },
  });
}

/**
 * Hash an invitation token the same way it was stored.
 *
 * Exported so the activation route can look the business record up without
 * importing the crypto module and getting the algorithm subtly wrong.
 */
export function logisticsInvitationTokenHash(rawToken: string): string {
  return sha256Hex(rawToken);
}

/** Used by the admin service, which already holds its own tenant authority. */
export async function countActiveOwners(
  logisticsPartnerId: string,
  tx?: PrismaTransaction,
): Promise<number> {
  const client = tx ?? prisma;

  return client.logisticsPartnerUser.count({
    where: {
      logisticsPartnerId,
      role: 'LOGISTICS_PARTNER_OWNER',
      status: { in: ['ACTIVE', 'INVITED'] },
    },
  });
}
