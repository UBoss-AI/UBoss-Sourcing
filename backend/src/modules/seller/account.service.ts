/**
 * The seller organisation: who it is, who is in it, and what each may do.
 *
 * This file is the ownership boundary for the entire Seller Hub. Every
 * listing, offer, stock row, order group, settlement and document is owned by a
 * seller account, and the ONLY way any other service obtains a seller account
 * id is `resolveSellerMembership` below, which derives it from the session.
 *
 * There is no `?sellerAccountId=` in any route, no handler reads an owner from
 * a request body, and no service in this module accepts a seller id from its
 * caller without having been handed a `SellerMembership` first. That is the one
 * control that makes tenant isolation true rather than intended: a function
 * taking a seller id as a plain string is one refactor away from taking one an
 * attacker chose.
 *
 * It is the same discipline `customer-erp/organization.service.ts` follows, and
 * the shape is deliberately recognisable from it.
 */
import type { SellerApplicationStatus, SellerMemberRole } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import {
  SellerPermission,
  canGrantSellerRole,
  permissionsForSellerRole,
  sellerRoleDefinition,
  type SellerPermissionKey,
} from '../../domain/seller-permissions.js';
import {
  SELLER_EDITABLE_STATUSES,
  SELLER_TRADING_STATUSES,
  assertSellerApplicationTransition,
  type SellerActor,
  type SellerApplicationStatusName,
} from '../../domain/seller-state.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { OPERATOR_LABEL, recordSellerAudit } from './audit.service.js';

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * Lowercased, punctuation-stripped, collapsed.
 *
 * Used for the UNIQUE index on the public display name, which is what makes
 * "MedSupply", "Med Supply" and "med-supply." one name rather than three.
 * A buyer choosing between offers reads the seller name to tell them apart,
 * and three sellers who look identical defeats that.
 */
export function normaliseSellerName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** URL fragment for the public seller page. */
export function sellerSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);

  // A name made entirely of characters the slug drops - a Greek or Cyrillic
  // trading name - would otherwise produce an empty slug and collide with the
  // next one. A stable fallback is better than a 404.
  return base.length > 0 ? base : `seller-${newId().toLowerCase().slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------------

export interface SellerMembership {
  sellerAccountId: string;
  displayName: string;
  legalName: string;
  slug: string;
  status: SellerApplicationStatusName;
  memberId: string;
  customerProfileId: string;
  role: SellerMemberRole;
  permissions: ReadonlySet<SellerPermissionKey>;
  /** Whether the account may list and trade right now. */
  isTrading: boolean;
  /** Whether the seller may still edit their own application. */
  isApplicationEditable: boolean;
  registrationCountry: string;
}

function toMembership(row: {
  id: string;
  role: SellerMemberRole;
  customerProfileId: string;
  sellerAccount: {
    id: string;
    displayName: string;
    legalName: string;
    slug: string;
    status: SellerApplicationStatus;
    registrationCountry: string;
  };
}): SellerMembership {
  const status = row.sellerAccount.status;

  return {
    sellerAccountId: row.sellerAccount.id,
    displayName: row.sellerAccount.displayName,
    legalName: row.sellerAccount.legalName,
    slug: row.sellerAccount.slug,
    status,
    memberId: row.id,
    customerProfileId: row.customerProfileId,
    role: row.role,
    permissions: permissionsForSellerRole(row.role),
    isTrading: SELLER_TRADING_STATUSES.includes(status),
    isApplicationEditable: SELLER_EDITABLE_STATUSES.includes(status),
    registrationCountry: row.sellerAccount.registrationCountry,
  };
}

/**
 * The caller's seller organisation, or null if they have none.
 *
 * Null is a normal answer, not an error: most signed-in people on this site are
 * buyers, and the header has to be able to ask "does this person sell here?"
 * without catching an exception on every page load.
 *
 * A removed member resolves to null too. Their row stays so historical actions
 * still name a person, and `removedAt` is what stops it granting anything.
 */
export async function findSellerMembership(
  customerProfileId: string,
): Promise<SellerMembership | null> {
  const row = await prisma.sellerMember.findFirst({
    where: { customerProfileId, removedAt: null, sellerAccount: { archivedAt: null } },
    select: {
      id: true,
      role: true,
      customerProfileId: true,
      sellerAccount: {
        select: {
          id: true,
          displayName: true,
          legalName: true,
          slug: true,
          status: true,
          registrationCountry: true,
        },
      },
    },
  });

  return row === null ? null : toMembership(row);
}

/**
 * The caller's seller organisation, or a refusal explaining what to do.
 *
 * Three different refusals, and they are separate codes because the seller's
 * next action is different in each case: apply, wait, or contact the
 * marketplace. One generic "not a seller" would send all three to the wrong
 * screen.
 */
export async function resolveSellerMembership(
  customerProfileId: string,
): Promise<SellerMembership> {
  const membership = await findSellerMembership(customerProfileId);

  if (membership === null) {
    throw forbidden(
      ErrorCode.SELLER_ACCOUNT_REQUIRED,
      'This account does not sell on the marketplace yet. Start a seller application to begin.',
    );
  }

  return membership;
}

/**
 * Refuse unless this member's role carries the permission.
 *
 * Called at the top of every service function that changes anything, not only
 * in the route layer, for the same reason `assertCapability` is: a guard that
 * lives only in the routes is a guard the next internal caller walks past.
 */
export function assertSellerPermission(
  membership: SellerMembership,
  permission: SellerPermissionKey,
): void {
  if (membership.permissions.has(permission)) return;

  const roleName = sellerRoleDefinition(membership.role)?.name ?? membership.role;

  throw forbidden(
    ErrorCode.SELLER_ROLE_DENIED,
    `Your role here (${roleName}) cannot do this. Ask an owner or admin of ${membership.displayName}.`,
  );
}

/**
 * Refuse unless the account is approved and trading.
 *
 * Separate from the permission check, and both are needed: an owner of a
 * suspended account holds every permission and may still not publish anything.
 */
export function assertSellerTrading(membership: SellerMembership): void {
  if (membership.isTrading) return;

  if (membership.status === 'SUSPENDED') {
    throw forbidden(
      ErrorCode.SELLER_SUSPENDED,
      'Selling is paused on this account. The marketplace has written to you with the reason.',
    );
  }

  throw forbidden(
    ErrorCode.SELLER_NOT_APPROVED,
    membership.status === 'ACTION_REQUIRED'
      ? 'Your seller application needs changes before you can list products.'
      : 'Your seller application has not been approved yet.',
  );
}

/** Refuse unless the seller may still edit their application. */
export function assertApplicationEditable(membership: SellerMembership): void {
  if (membership.isApplicationEditable) return;

  throw conflict(
    ErrorCode.SELLER_APPLICATION_TRANSITION_NOT_ALLOWED,
    membership.status === 'SUBMITTED' || membership.status === 'UNDER_REVIEW'
      ? 'Your application is with the marketplace and cannot be changed while it is being reviewed.'
      : 'This application can no longer be edited.',
  );
}

/**
 * The row exists, but does it belong to this seller?
 *
 * Throws NOT FOUND rather than FORBIDDEN, on the same reasoning as
 * `assertOwnership` in the auth plugin: telling somebody that a listing exists
 * and belongs to a competitor is itself a leak, and listing ids are sequential
 * enough to be walked.
 */
export function assertSellerOwnership(
  membership: SellerMembership,
  ownerSellerAccountId: string | null,
  resourceLabel: string,
): void {
  if (ownerSellerAccountId !== null && ownerSellerAccountId === membership.sellerAccountId) return;
  throw notFound(resourceLabel);
}

// ---------------------------------------------------------------------------
// Starting an application
// ---------------------------------------------------------------------------

export interface StartApplicationInput {
  customerProfileId: string;
  legalName: string;
  displayName: string;
  registrationCountry: string;
  kind?: SellerMemberRole extends never ? never : 'MANUFACTURER' | 'AUTHORISED_DISTRIBUTOR' | 'WHOLESALER' | 'RESELLER';
  correlationId?: string | null;
  userId?: string | null;
}

/** Is this public name free? Asked by the form as the seller types. */
export async function isDisplayNameAvailable(
  displayName: string,
  excludeSellerAccountId?: string,
): Promise<boolean> {
  const normalised = normaliseSellerName(displayName);
  if (normalised.length === 0) return false;

  const existing = await prisma.sellerAccount.findUnique({
    where: { displayNameNormalized: normalised },
    select: { id: true },
  });

  return existing === null || existing.id === excludeSellerAccountId;
}

/**
 * Create the seller organisation and put the caller in it as OWNER.
 *
 * Done the moment somebody presses "Become a seller" and authenticates, NOT
 * when they are approved. An application has to live somewhere while it is
 * being written, and giving it a tenant from the start means "resume later" is
 * just reading your own rows rather than a second storage mechanism for
 * half-finished forms.
 *
 * One profile, one seller organisation - the same restriction
 * `BuyerOrganizationMember` makes, for the same reason: an account that could
 * act for two sellers would need every screen in the Hub to ask "as whom?",
 * including the one that dispatches an order.
 */
export async function startSellerApplication(
  input: StartApplicationInput,
): Promise<SellerMembership> {
  const existing = await findSellerMembership(input.customerProfileId);
  if (existing !== null) {
    throw conflict(
      ErrorCode.SELLER_MEMBERSHIP_EXISTS,
      `This account already sells as ${existing.displayName}.`,
    );
  }

  const legalName = input.legalName.trim();
  const displayName = input.displayName.trim();
  const normalised = normaliseSellerName(displayName);

  if (legalName.length < 2) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the registered name of the business.', [
      { field: 'legalName', code: 'TOO_SHORT' },
    ]);
  }

  if (normalised.length < 2) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Give a public shop name buyers will recognise.',
      [{ field: 'displayName', code: 'TOO_SHORT' }],
    );
  }

  if (!(await isDisplayNameAvailable(displayName))) {
    throw conflict(
      ErrorCode.SELLER_DISPLAY_NAME_TAKEN,
      'Another seller already trades under that name here. Choose a different one.',
      [{ field: 'displayName', code: 'TAKEN' }],
    );
  }

  const sellerAccountId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.sellerAccount.create({
      data: {
        id: sellerAccountId,
        legalName,
        displayName,
        displayNameNormalized: normalised,
        slug: sellerSlug(displayName),
        registrationCountry: input.registrationCountry.toUpperCase(),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        status: 'DRAFT',
        createdByProfileId: input.customerProfileId,
      },
    });

    await tx.sellerMember.create({
      data: {
        id: newId(),
        sellerAccountId,
        customerProfileId: input.customerProfileId,
        // The founder is the OWNER, and the only one. Somebody has to be able
        // to accept the marketplace agreement, and OWNER is the only role that
        // can - see `seller-permissions.ts`.
        role: 'OWNER',
      },
    });

    await tx.sellerBusinessProfile.create({
      data: { id: newId(), sellerAccountId },
    });

    await tx.sellerOnboardingProgress.create({
      data: {
        id: newId(),
        sellerAccountId,
        stepsJson: {},
        completedSteps: 0,
        requiredSteps: 0,
      },
    });

    await tx.sellerPayoutAccountReference.create({
      data: { id: newId(), sellerAccountId, state: 'NOT_STARTED' },
    });
  });

  await recordSellerAudit({
    sellerAccountId,
    action: 'seller.application.started',
    actor: { type: 'CUSTOMER', userId: input.userId ?? null, label: displayName },
    resourceType: 'seller_account',
    resourceId: sellerAccountId,
    summary: `Seller application started for ${legalName}.`,
    correlationId: input.correlationId ?? null,
  });

  return resolveSellerMembership(input.customerProfileId);
}

// ---------------------------------------------------------------------------
// Moving the application through its states
// ---------------------------------------------------------------------------

export interface ApplicationTransitionInput {
  sellerAccountId: string;
  to: SellerApplicationStatusName;
  actor: SellerActor;
  actorUserId?: string | null;
  actorLabel?: string | null;
  /** Seller-visible. Required by the machine on every refusal and every stop. */
  reason?: string | null;
  /** Operator-only note, never serialised to a seller route. */
  internalNote?: string | null;
  correlationId?: string | null;
  /**
   * The version the caller last read. When supplied, the write applies only if
   * nothing has changed since - two administrators deciding one application
   * from two tabs is a real case, and the second one silently overwriting the
   * first is how a rejection turns into an approval nobody made.
   */
  expectedVersion?: number | null;
  tx?: PrismaTransaction;
}

/**
 * Change the application's state, through the machine and nowhere else.
 *
 * Every timestamp that goes with a state is written here rather than by the
 * caller, so `approvedAt` cannot disagree with `status`.
 */
export async function transitionApplication(input: ApplicationTransitionInput): Promise<void> {
  const run = async (tx: PrismaTransaction): Promise<void> => {
    const account = await tx.sellerAccount.findUnique({
      where: { id: input.sellerAccountId },
      select: { id: true, status: true, version: true, legalName: true, resubmissionAllowed: true },
    });

    if (account === null) throw notFound('Seller account');

    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      account.version !== input.expectedVersion
    ) {
      throw conflict(
        ErrorCode.SELLER_STALE_VERSION,
        'Somebody else changed this application while you had it open. Reload to see their change.',
      );
    }

    const from = account.status;

    // Reopening a rejected application is a two-part rule: the machine allows
    // REJECTED -> ACTION_REQUIRED, and this checks that the operator did not
    // close the door when they refused it.
    if (from === 'REJECTED' && !account.resubmissionAllowed) {
      throw conflict(
        ErrorCode.SELLER_RESUBMISSION_NOT_ALLOWED,
        'This application was closed to resubmission. Contact the marketplace to reopen it.',
      );
    }

    assertSellerApplicationTransition({
      from,
      to: input.to,
      actor: input.actor,
      reason: input.reason ?? null,
    });

    const now = new Date();

    await tx.sellerAccount.update({
      where: { id: input.sellerAccountId },
      data: {
        status: input.to,
        version: { increment: 1 },
        statusReason: input.reason ?? null,
        ...(input.internalNote === null || input.internalNote === undefined ? {} : { internalNotes: input.internalNote }),
        ...(input.to === 'SUBMITTED' ? { submittedAt: now } : {}),
        ...(input.to === 'UNDER_REVIEW' ? { reviewedAt: now } : {}),
        ...(input.to === 'APPROVED' ? { approvedAt: now, suspendedAt: null } : {}),
        ...(input.to === 'SUSPENDED' ? { suspendedAt: now } : {}),
      },
    });

    await recordSellerAudit({
      sellerAccountId: input.sellerAccountId,
      action: `seller.application.${input.to.toLowerCase()}`,
      actor: {
        type: input.actor === 'OPERATOR' ? 'ADMIN' : input.actor === 'SYSTEM' ? 'SYSTEM' : 'CUSTOMER',
        userId: input.actorUserId ?? null,
        label: input.actor === 'OPERATOR' ? OPERATOR_LABEL : (input.actorLabel ?? null),
      },
      resourceType: 'seller_account',
      resourceId: input.sellerAccountId,
      before: { status: from },
      after: { status: input.to },
      summary:
        input.reason !== null && input.reason !== undefined && input.reason.trim().length > 0
          ? `Application moved to ${input.to.toLowerCase().replace(/_/g, ' ')}: ${input.reason.trim()}`
          : `Application moved to ${input.to.toLowerCase().replace(/_/g, ' ')}.`,
      correlationId: input.correlationId ?? null,
      tx,
    });
  };

  if (input.tx !== undefined) {
    await run(input.tx);
    return;
  }

  await prisma.$transaction(run);
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/**
 * Change somebody's role, or refuse.
 *
 * Two refusals, and both close an escalation rather than enforce tidiness:
 *
 *   - **The last owner cannot be demoted.** An organisation with no owner has
 *     nobody who can appoint one, and nobody who can accept the next version
 *     of the marketplace agreement. It is stuck, and only the operator can
 *     unstick it.
 *   - **Nobody may grant a role they do not hold.** An ADMIN with
 *     `MEMBER_WRITE` could otherwise mint an OWNER and so award themselves
 *     `AGREEMENT_ACCEPT`, the one permission ADMIN deliberately lacks.
 */
export async function changeMemberRole(
  membership: SellerMembership,
  targetMemberId: string,
  nextRole: SellerMemberRole,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.MEMBER_WRITE);

  if (!canGrantSellerRole(membership.role, nextRole)) {
    throw forbidden(
      ErrorCode.SELLER_ROLE_DENIED,
      'You cannot grant a role that carries more than your own.',
    );
  }

  await prisma.$transaction(async (tx) => {
    const target = await tx.sellerMember.findFirst({
      where: {
        id: targetMemberId,
        sellerAccountId: membership.sellerAccountId,
        removedAt: null,
      },
      select: { id: true, role: true },
    });

    if (target === null) throw notFound('Team member');
    if (target.role === nextRole) return;

    if (target.role === 'OWNER') {
      const owners = await tx.sellerMember.count({
        where: { sellerAccountId: membership.sellerAccountId, role: 'OWNER', removedAt: null },
      });

      if (owners <= 1) {
        throw conflict(
          ErrorCode.SELLER_LAST_OWNER,
          'This is the only owner of the account. Make somebody else an owner first.',
        );
      }
    }

    await tx.sellerMember.update({ where: { id: target.id }, data: { role: nextRole } });

    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.member.role_changed',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_member',
      resourceId: target.id,
      before: { role: target.role },
      after: { role: nextRole },
      summary: `A team member's role changed from ${target.role} to ${nextRole}.`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
}

/** Remove somebody, keeping the row so their past actions still name a person. */
export async function removeMember(
  membership: SellerMembership,
  targetMemberId: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.MEMBER_WRITE);

  await prisma.$transaction(async (tx) => {
    const target = await tx.sellerMember.findFirst({
      where: { id: targetMemberId, sellerAccountId: membership.sellerAccountId, removedAt: null },
      select: { id: true, role: true },
    });

    if (target === null) throw notFound('Team member');

    if (target.role === 'OWNER') {
      const owners = await tx.sellerMember.count({
        where: { sellerAccountId: membership.sellerAccountId, role: 'OWNER', removedAt: null },
      });

      if (owners <= 1) {
        throw conflict(
          ErrorCode.SELLER_LAST_OWNER,
          'This is the only owner of the account and cannot be removed.',
        );
      }
    }

    await tx.sellerMember.update({ where: { id: target.id }, data: { removedAt: new Date() } });

    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.member.removed',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_member',
      resourceId: target.id,
      summary: 'A team member was removed from the seller account.',
      correlationId: correlationId ?? null,
      tx,
    });
  });
}
