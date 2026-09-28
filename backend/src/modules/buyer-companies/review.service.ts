/**
 * Buyer-company review, from the console's side.
 *
 * Every action here is taken by a named member of staff, goes through
 * `transitionCompany` (and so the state machine, the status history, the
 * timeline and the audit log), and every decision that the applicant must act
 * on carries a reason written for them. Internal notes are written to the
 * timeline as INTERNAL and never leave the console.
 *
 * Decisions take `expectedVersion`: the version of the application the
 * reviewer was looking at. Two reviewers deciding at once cannot both win -
 * the second is told the application changed under them.
 */
import { permissionsForRoles, Permission } from '../../domain/permissions.js';
import type { BuyerCompanyStatusName } from '../../domain/buyer-company-state.js';
import {
  BuyerCompanyDocumentKindValues,
  type BuyerCompanyDocumentKindName,
} from '../../domain/buyer-company-requirements.js';
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { dispatchPendingNotifications } from '../notifications/notification.service.js';
import { openVerificationCase } from './application.service.js';
import { runChecks } from './checks.service.js';
import { sendCompanyEmail } from './notifications.js';
import {
  loadCompanyRecord,
  reviewerView,
  transitionCompany,
  writeEvent,
  type Actor,
  type Tx,
} from './shared.js';

/** Why an application was refused. Codes, so the storefront can phrase them. */
export const REJECTION_REASON_CODES = [
  'REGISTRATION_NOT_FOUND',
  'DETAILS_DO_NOT_MATCH',
  'DOCUMENTS_INSUFFICIENT',
  'AUTHORITY_NOT_SHOWN',
  'NOT_A_REGISTERED_BUSINESS',
  'DUPLICATE_APPLICATION',
  'UNSUPPORTED_JURISDICTION',
  'NO_RESPONSE',
  'OTHER',
] as const;

export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

export interface Reviewer {
  userId: string;
  email: string;
  permissions: ReadonlySet<string>;
  ipAddress?: string | null;
  correlationId?: string | null;
}

function actorOf(reviewer: Reviewer): Actor {
  return {
    type: 'ADMIN',
    userId: reviewer.userId,
    email: reviewer.email,
    ipAddress: reviewer.ipAddress ?? null,
    correlationId: reviewer.correlationId ?? null,
  };
}

function requireGrant(reviewer: Reviewer, permission: string): void {
  if (!reviewer.permissions.has(permission)) {
    throw forbidden(
      ErrorCode.PERMISSION_DENIED,
      'You do not have permission to perform this action.',
    );
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

export interface QueueQuery {
  statuses?: BuyerCompanyStatusName[];
  country?: string;
  search?: string;
  /** 'me', 'unassigned', or a staff user id. */
  assignee?: string;
  risk?: 'NONE' | 'LOW' | 'ELEVATED' | 'HIGH';
  sort?: 'oldest' | 'newest' | 'recent_activity' | 'risk';
  page: number;
  pageSize: number;
}

/** Everything a reviewer works, by default: submitted and not yet closed. */
const DEFAULT_QUEUE_STATUSES: BuyerCompanyStatusName[] = [
  'SUBMITTED',
  'AUTOMATED_CHECK_IN_PROGRESS',
  'UNDER_REVIEW',
  'MORE_INFORMATION_REQUIRED',
  'RESUBMITTED',
  'REVERIFICATION_REQUIRED',
];

const RISK_ORDER: Record<string, number> = { HIGH: 0, ELEVATED: 1, LOW: 2, NONE: 3 };

export async function listReviewQueue(
  reviewer: Reviewer,
  query: QueueQuery,
): Promise<Record<string, unknown>> {
  const statuses =
    query.statuses !== undefined && query.statuses.length > 0
      ? query.statuses
      : DEFAULT_QUEUE_STATUSES;
  const search = query.search?.trim() ?? '';
  const searchNormalised = search.toUpperCase().replace(/[\s.\-/_]/g, '');

  const assigneeFilter: Prisma.BuyerCompanyWhereInput =
    query.assignee === undefined
      ? {}
      : query.assignee === 'unassigned'
        ? { cases: { none: { state: 'OPEN', assignedReviewerId: { not: null } } } }
        : {
            cases: {
              some: {
                state: 'OPEN',
                assignedReviewerId: query.assignee === 'me' ? reviewer.userId : query.assignee,
              },
            },
          };

  const where: Prisma.BuyerCompanyWhereInput = {
    archivedAt: null,
    status: { in: statuses },
    ...(query.country !== undefined && query.country.length === 2
      ? { registrationCountry: query.country.toUpperCase() }
      : {}),
    ...(query.risk !== undefined ? { riskLevel: query.risk } : {}),
    ...assigneeFilter,
    ...(search.length > 0
      ? {
          OR: [
            { applicationReference: { contains: search.toUpperCase() } },
            { legalName: { contains: search } },
            { tradingName: { contains: search } },
            ...(searchNormalised.length >= 3
              ? [{ registrationNumberNormalized: { contains: searchNormalised } }]
              : []),
            { businessEmailNormalized: { contains: search.toLowerCase() } },
          ],
        }
      : {}),
  };

  const orderBy: Prisma.BuyerCompanyOrderByWithRelationInput[] =
    query.sort === 'newest'
      ? [{ submittedAt: 'desc' }]
      : query.sort === 'recent_activity'
        ? [{ updatedAt: 'desc' }]
        : // The oldest submission first: a queue sorted newest-first starves
          // the applicant who has been waiting longest.
          [{ submittedAt: 'asc' }, { createdAt: 'asc' }];

  const [total, rows, grouped] = await Promise.all([
    prisma.buyerCompany.count({ where }),
    prisma.buyerCompany.findMany({
      where,
      orderBy,
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
      include: {
        cases: {
          where: { state: 'OPEN' },
          take: 1,
          include: { assignedReviewer: { select: { id: true, email: true } } },
        },
        members: {
          where: { role: 'OWNER' },
          take: 1,
          include: {
            user: { select: { email: true, customerProfile: { select: { fullName: true } } } },
          },
        },
        checks: {
          where: { outcome: { in: ['FAIL', 'SIGNAL', 'INCONCLUSIVE'] } },
          select: { outcome: true, provider: true },
        },
      },
    }),
    prisma.buyerCompany.groupBy({
      by: ['status'],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
  ]);

  const now = Date.now();
  const mapped = rows.map((row) => {
    const openCase = row.cases[0] ?? null;
    const owner = row.members[0] ?? null;
    const since = row.firstSubmittedAt ?? row.createdAt;
    return {
      id: row.id,
      reference: row.applicationReference,
      legalName: row.legalName,
      tradingName: row.tradingName,
      registrationCountry: row.registrationCountry,
      entityType: row.entityType,
      registrationNumber: row.registrationNumber,
      applicant:
        owner === null
          ? null
          : { email: owner.user.email, fullName: owner.user.customerProfile?.fullName ?? null },
      status: row.status,
      riskLevel: row.riskLevel,
      flags: {
        failed: row.checks.filter((check) => check.outcome === 'FAIL').length,
        duplicates: row.checks.filter((check) => check.provider === 'DUPLICATES').length,
        signals: row.checks.filter(
          (check) => check.outcome !== 'FAIL' && check.provider !== 'DUPLICATES',
        ).length,
      },
      assignedReviewer: openCase?.assignedReviewer ?? null,
      submittedAt: row.submittedAt?.toISOString() ?? null,
      ageDays: Math.floor((now - since.getTime()) / 86_400_000),
      lastActivityAt: row.updatedAt.toISOString(),
    };
  });

  if (query.sort === 'risk') {
    mapped.sort((a, b) => (RISK_ORDER[a.riskLevel] ?? 9) - (RISK_ORDER[b.riskLevel] ?? 9));
  }

  const counts: Record<string, number> = {};
  for (const group of grouped) counts[group.status] = group._count._all;

  return { rows: mapped, total, page: query.page, pageSize: query.pageSize, counts };
}

export async function readForReview(
  reviewer: Reviewer,
  companyId: string,
): Promise<Record<string, unknown>> {
  requireGrant(reviewer, Permission.BUYER_COMPANY_READ);
  const company = await loadCompanyRecord(companyId);
  return reviewerView(company, {
    canReview: reviewer.permissions.has(Permission.BUYER_COMPANY_REVIEW),
    canSuspend: reviewer.permissions.has(Permission.BUYER_COMPANY_SUSPEND),
  });
}

// ---------------------------------------------------------------------------
// Working a case
// ---------------------------------------------------------------------------

async function openCaseOf(
  tx: Tx,
  companyId: string,
): Promise<{
  id: string;
  assignedReviewerId: string | null;
  requiresSecondReview: boolean;
  firstApprovalById: string | null;
} | null> {
  return tx.buyerCompanyVerificationCase.findFirst({
    where: { companyId, state: 'OPEN' },
    orderBy: { round: 'desc' },
    select: {
      id: true,
      assignedReviewerId: true,
      requiresSecondReview: true,
      firstApprovalById: true,
    },
  });
}

async function assignCase(
  tx: Tx,
  companyId: string,
  caseId: string,
  reviewerId: string | null,
  actor: Actor,
): Promise<void> {
  await tx.buyerCompanyVerificationCase.update({
    where: { id: caseId },
    data: { assignedReviewerId: reviewerId, assignedAt: reviewerId === null ? null : new Date() },
  });
  await writeEvent(tx, {
    companyId,
    caseId,
    kind: 'ASSIGNED',
    visibility: 'INTERNAL',
    actor,
    data: { reviewerId },
  });
  await recordAudit(
    {
      action: AuditAction.BUYER_COMPANY_ASSIGNED,
      resourceType: 'buyer_company',
      resourceId: companyId,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      after: { reviewerId },
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
}

/** Open the application for review and take it, if nobody has. */
export async function startReview(
  reviewer: Reviewer,
  companyId: string,
  expectedVersion?: number,
): Promise<Record<string, unknown>> {
  requireGrant(reviewer, Permission.BUYER_COMPANY_REVIEW);
  const actor = actorOf(reviewer);
  let movedToReview = false;

  await prisma.$transaction(async (tx) => {
    const company = await tx.buyerCompany.findUnique({
      where: { id: companyId },
      select: { status: true },
    });
    if (company === null) throw notFound('Company');

    if (
      company.status === 'SUBMITTED' ||
      company.status === 'RESUBMITTED' ||
      company.status === 'AUTOMATED_CHECK_IN_PROGRESS'
    ) {
      await transitionCompany(tx, {
        companyId,
        to: 'UNDER_REVIEW',
        actor,
        as: 'REVIEWER',
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
      });
      movedToReview = true;
    } else if (company.status !== 'UNDER_REVIEW') {
      throw conflict(
        ErrorCode.BUYER_COMPANY_TRANSITION_NOT_ALLOWED,
        'This application is not waiting for review.',
        [{ code: 'TRANSITION_UNDEFINED', meta: { from: company.status, to: 'UNDER_REVIEW' } }],
      );
    }

    const openCase = await openCaseOf(tx, companyId);
    if (openCase !== null && openCase.assignedReviewerId === null) {
      await assignCase(tx, companyId, openCase.id, reviewer.userId, actor);
    }

    if (movedToReview) await sendCompanyEmail({ kind: 'REVIEW_STARTED', companyId, tx });
  });

  if (movedToReview) await dispatchPendingNotifications();
  return readForReview(reviewer, companyId);
}

/** Give the open case to a colleague who may review, or take it off everyone. */
export async function assignReviewer(
  reviewer: Reviewer,
  companyId: string,
  assigneeId: string | null,
): Promise<Record<string, unknown>> {
  requireGrant(reviewer, Permission.BUYER_COMPANY_REVIEW);

  if (assigneeId !== null) {
    const assignee = await prisma.user.findUnique({
      where: { id: assigneeId },
      select: {
        type: true,
        status: true,
        archivedAt: true,
        roles: { select: { role: { select: { key: true } } } },
      },
    });
    const grants =
      assignee === null
        ? new Set<string>()
        : permissionsForRoles(assignee.roles.map((row) => row.role.key));
    if (
      assignee === null ||
      assignee.type !== 'ADMIN' ||
      assignee.status !== 'ACTIVE' ||
      assignee.archivedAt !== null ||
      !grants.has(Permission.BUYER_COMPANY_REVIEW)
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Choose a colleague who can review company applications.',
        [{ field: 'reviewerId', code: 'NOT_A_REVIEWER' }],
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    const openCase = await openCaseOf(tx, companyId);
    if (openCase === null)
      throw conflict(ErrorCode.CONFLICT, 'There is no open review for this application.');
    await assignCase(tx, companyId, openCase.id, assigneeId, actorOf(reviewer));
  });

  return readForReview(reviewer, companyId);
}

/** A note for colleagues. Never shown to the applicant. */
export async function addInternalNote(
  reviewer: Reviewer,
  companyId: string,
  text: string,
): Promise<Record<string, unknown>> {
  requireGrant(reviewer, Permission.BUYER_COMPANY_REVIEW);
  const note = text.trim();
  if (note.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Write the note first.', [
      { field: 'note', code: 'REQUIRED' },
    ]);
  }

  await prisma.$transaction(async (tx) => {
    await loadCompanyRecord(companyId, tx);
    const openCase = await openCaseOf(tx, companyId);
    await writeEvent(tx, {
      companyId,
      caseId: openCase?.id ?? null,
      kind: 'NOTE',
      visibility: 'INTERNAL',
      actor: actorOf(reviewer),
      message: note.slice(0, 5000),
    });
    await recordAudit(
      {
        action: AuditAction.BUYER_COMPANY_NOTE_ADDED,
        resourceType: 'buyer_company',
        resourceId: companyId,
        actorType: 'ADMIN',
        actorUserId: reviewer.userId,
        // The note's words stay in the company's own timeline; the platform
        // trail records only that one was written.
        after: { length: note.length },
        correlationId: reviewer.correlationId ?? null,
      },
      tx,
    );
  });

  return readForReview(reviewer, companyId);
}

function validDocumentKinds(kinds: readonly string[]): BuyerCompanyDocumentKindName[] {
  const allowed = new Set<string>(BuyerCompanyDocumentKindValues);
  const bad = kinds.filter((kind) => !allowed.has(kind));
  if (bad.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Unknown document kind.', [
      { field: 'documentKinds', code: 'UNKNOWN_KIND', meta: { kinds: bad.join(',') } },
    ]);
  }
  return [...new Set(kinds)] as BuyerCompanyDocumentKindName[];
}

async function createInfoRequest(
  tx: Tx,
  companyId: string,
  caseId: string | null,
  message: string,
  documentKinds: BuyerCompanyDocumentKindName[],
  actor: Actor,
): Promise<void> {
  await tx.buyerCompanyInfoRequest.create({
    data: {
      id: newId(),
      companyId,
      caseId,
      message: message.slice(0, 5000),
      requestedDocumentKindsJson: documentKinds,
      createdByUserId: actor.userId ?? '',
    },
  });
  await recordAudit(
    {
      action: AuditAction.BUYER_COMPANY_INFO_REQUESTED,
      resourceType: 'buyer_company',
      resourceId: companyId,
      actorType: 'ADMIN',
      actorUserId: actor.userId,
      after: { documentKinds },
      correlationId: actor.correlationId ?? null,
    },
    tx,
  );
}

export interface DecisionInput {
  companyId: string;
  expectedVersion: number;
  reason?: string | null;
  reasonCode?: string | null;
  documentKinds?: string[];
  resubmissionAllowed?: boolean;
}

/** Send it back to the applicant with a question they can answer. */
export async function requestMoreInformation(
  reviewer: Reviewer,
  input: DecisionInput,
): Promise<Record<string, unknown>> {
  requireGrant(reviewer, Permission.BUYER_COMPANY_REVIEW);
  const message = input.reason?.trim() ?? '';
  const kinds = validDocumentKinds(input.documentKinds ?? []);
  const actor = actorOf(reviewer);

  await prisma.$transaction(async (tx) => {
    await transitionCompany(tx, {
      companyId: input.companyId,
      to: 'MORE_INFORMATION_REQUIRED',
      actor,
      as: 'REVIEWER',
      reason: message,
      expectedVersion: input.expectedVersion,
    });
    const openCase = await openCaseOf(tx, input.companyId);
    await createInfoRequest(tx, input.companyId, openCase?.id ?? null, message, kinds, actor);
    await sendCompanyEmail({
      kind: 'INFO_REQUESTED',
      companyId: input.companyId,
      reason: message,
      tx,
    });
  });

  await dispatchPendingNotifications();
  return readForReview(reviewer, input.companyId);
}

/** A unique-index collision on one of the claim keys. */
function isClaimCollision(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Approve - or, from SUSPENDED / REVERIFICATION_REQUIRED, restore.
 *
 * Claims the registration number and every given identifier for this company
 * in the same transaction, so a second company cannot be approved with them.
 * With a second review required, the first approval is recorded and the
 * company stays where it is until a different reviewer approves too.
 */
export async function approveCompany(
  reviewer: Reviewer,
  input: DecisionInput,
): Promise<Record<string, unknown> & { awaitingSecondReview?: boolean }> {
  const company = await loadCompanyRecord(input.companyId);
  const restoring = company.status === 'SUSPENDED' || company.status === 'REVERIFICATION_REQUIRED';
  requireGrant(
    reviewer,
    company.status === 'SUSPENDED'
      ? Permission.BUYER_COMPANY_SUSPEND
      : Permission.BUYER_COMPANY_REVIEW,
  );

  const actor = actorOf(reviewer);
  let awaitingSecondReview = false;

  try {
    await prisma.$transaction(async (tx) => {
      const openCase = await openCaseOf(tx, input.companyId);

      if (!restoring && openCase?.requiresSecondReview === true) {
        if (openCase.firstApprovalById === null) {
          if (input.expectedVersion !== company.version) {
            throw conflict(
              ErrorCode.BUYER_COMPANY_VERSION_CONFLICT,
              'Somebody else changed this application since you opened it. Reload it and decide again.',
            );
          }
          await tx.buyerCompanyVerificationCase.update({
            where: { id: openCase.id },
            data: { firstApprovalById: reviewer.userId, firstApprovalAt: new Date() },
          });
          await writeEvent(tx, {
            companyId: input.companyId,
            caseId: openCase.id,
            kind: 'FIRST_APPROVAL',
            visibility: 'INTERNAL',
            actor,
            message: input.reason?.trim() ?? null,
          });
          awaitingSecondReview = true;
          return;
        }
        if (openCase.firstApprovalById === reviewer.userId) {
          throw conflict(
            ErrorCode.BUYER_COMPANY_SECOND_REVIEW_REQUIRED,
            'This application needs a second reviewer. Ask a colleague to approve it.',
          );
        }
      }

      await transitionCompany(tx, {
        companyId: input.companyId,
        to: 'APPROVED',
        actor,
        as: 'REVIEWER',
        reason: input.reason ?? null,
        expectedVersion: input.expectedVersion,
        extra: {
          registrationClaimKey:
            company.registrationCountry !== null && company.registrationNumberNormalized !== null
              ? `${company.registrationCountry}:${company.registrationNumberNormalized}`
              : null,
          resubmissionAllowed: true,
        },
      });

      for (const identifier of company.identifiers) {
        if (identifier.notApplicable || identifier.valueNormalized === null) continue;
        await tx.buyerCompanyIdentifier.update({
          where: { id: identifier.id },
          data: {
            claimKey: `${company.registrationCountry ?? '--'}:${identifier.scheme}:${identifier.valueNormalized}`,
          },
        });
      }

      if (openCase !== null) {
        await tx.buyerCompanyVerificationCase.update({
          where: { id: openCase.id },
          data: { state: 'CLOSED', closedAt: new Date(), outcome: 'APPROVED' },
        });
      }

      if (!restoring) await seedCompanyAddressBook(tx, company);

      await sendCompanyEmail({
        kind: restoring ? 'RESTORED' : 'APPROVED',
        companyId: input.companyId,
        reason: input.reason ?? '',
        tx,
      });
    });
  } catch (error) {
    if (isClaimCollision(error)) {
      throw conflict(
        ErrorCode.BUYER_COMPANY_ALREADY_CLAIMED,
        'Another approved company already holds this registration number or tax identifier. Resolve the duplicate first.',
      );
    }
    throw error;
  }

  await dispatchPendingNotifications();
  const view = await readForReview(reviewer, input.companyId);
  return awaitingSecondReview ? { ...view, awaitingSecondReview: true } : view;
}

/**
 * Give a newly approved company a checkout address book.
 *
 * The billing and shipping addresses it was verified with become its first
 * delivery and invoice addresses, so an approved company can check out at
 * once. Only when its book is empty - a company approved a second time keeps
 * whatever its members have added since. Owned, like every address, by a
 * person: the company's owner.
 */
async function seedCompanyAddressBook(
  tx: Tx,
  company: Awaited<ReturnType<typeof loadCompanyRecord>>,
): Promise<void> {
  const existing = await tx.address.count({
    where: { buyerCompanyId: company.id, archivedAt: null },
  });
  if (existing > 0) return;

  const owner = company.members.find(
    (member) => member.role === 'OWNER' && member.status === 'ACTIVE',
  );
  const ownerProfile =
    owner === undefined
      ? null
      : await tx.customerProfile.findUnique({
          where: { userId: owner.userId },
          select: { id: true, fullName: true, phone: true },
        });
  if (ownerProfile === null) return;

  const billing = company.addresses.find((address) => address.kind === 'BILLING');
  const shipping = company.addresses.find((address) => address.kind === 'SHIPPING');
  const same =
    billing !== undefined && shipping !== undefined && billing.fingerprint === shipping.fingerprint;

  const rows = same
    ? [{ source: billing, kind: 'BOTH' as const }]
    : [
        ...(billing !== undefined ? [{ source: billing, kind: 'BILLING' as const }] : []),
        ...(shipping !== undefined ? [{ source: shipping, kind: 'SHIPPING' as const }] : []),
      ];

  for (const row of rows) {
    await tx.address.create({
      data: {
        id: newId(),
        customerProfileId: ownerProfile.id,
        buyerCompanyId: company.id,
        kind: row.kind,
        label: company.tradingName ?? company.legalName ?? null,
        contactName: ownerProfile.fullName,
        contactPhone: company.businessPhone ?? ownerProfile.phone ?? '',
        line1: row.source.line1,
        line2: row.source.line2,
        city: row.source.city,
        state: row.source.region ?? '',
        postalCode: row.source.postalCode ?? '',
        country: row.source.countryCode,
        isDefaultBilling: row.kind !== 'SHIPPING',
        isDefaultShipping: row.kind !== 'BILLING',
      },
    });
  }
}

/** Refuse, with a code and words for the applicant. Releases any claims. */
export async function rejectCompany(
  reviewer: Reviewer,
  input: DecisionInput,
): Promise<Record<string, unknown>> {
  const company = await prisma.buyerCompany.findUnique({
    where: { id: input.companyId },
    select: { status: true },
  });
  if (company === null) throw notFound('Company');
  requireGrant(
    reviewer,
    company.status === 'SUSPENDED'
      ? Permission.BUYER_COMPANY_SUSPEND
      : Permission.BUYER_COMPANY_REVIEW,
  );

  if (
    input.reasonCode === undefined ||
    input.reasonCode === null ||
    !(REJECTION_REASON_CODES as readonly string[]).includes(input.reasonCode)
  ) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose why the application is refused.', [
      { field: 'reasonCode', code: 'REQUIRED' },
    ]);
  }

  const actor = actorOf(reviewer);
  const resubmissionAllowed = input.resubmissionAllowed ?? true;

  await prisma.$transaction(async (tx) => {
    await transitionCompany(tx, {
      companyId: input.companyId,
      to: 'REJECTED',
      actor,
      as: 'REVIEWER',
      reason: input.reason ?? null,
      reasonCode: input.reasonCode ?? null,
      expectedVersion: input.expectedVersion,
      extra: { registrationClaimKey: null, resubmissionAllowed },
    });
    await tx.buyerCompanyIdentifier.updateMany({
      where: { companyId: input.companyId },
      data: { claimKey: null },
    });
    await tx.buyerCompanyInfoRequest.updateMany({
      where: { companyId: input.companyId, status: 'OPEN' },
      data: { status: 'CANCELLED' },
    });
    await tx.buyerCompanyVerificationCase.updateMany({
      where: { companyId: input.companyId, state: 'OPEN' },
      data: { state: 'CLOSED', closedAt: new Date(), outcome: 'REJECTED' },
    });
    await sendCompanyEmail({
      kind: 'REJECTED',
      companyId: input.companyId,
      reason: input.reason ?? '',
      canResubmit: resubmissionAllowed,
      tx,
    });
  });

  await dispatchPendingNotifications();
  return readForReview(reviewer, input.companyId);
}

/** Stop an approved company buying, at once. */
export async function suspendCompany(
  reviewer: Reviewer,
  input: DecisionInput,
): Promise<Record<string, unknown>> {
  requireGrant(reviewer, Permission.BUYER_COMPANY_SUSPEND);
  const actor = actorOf(reviewer);

  await prisma.$transaction(async (tx) => {
    await transitionCompany(tx, {
      companyId: input.companyId,
      to: 'SUSPENDED',
      actor,
      as: 'REVIEWER',
      reason: input.reason ?? null,
      reasonCode: input.reasonCode ?? null,
      expectedVersion: input.expectedVersion,
    });
    await sendCompanyEmail({
      kind: 'SUSPENDED',
      companyId: input.companyId,
      reason: input.reason ?? '',
      tx,
    });
  });

  await dispatchPendingNotifications();
  return readForReview(reviewer, input.companyId);
}

/** Ask an approved (or suspended) company to prove itself again. Purchasing stops meanwhile. */
export async function requestReverification(
  reviewer: Reviewer,
  input: DecisionInput,
): Promise<Record<string, unknown>> {
  const company = await prisma.buyerCompany.findUnique({
    where: { id: input.companyId },
    select: { status: true },
  });
  if (company === null) throw notFound('Company');
  requireGrant(
    reviewer,
    company.status === 'SUSPENDED'
      ? Permission.BUYER_COMPANY_SUSPEND
      : Permission.BUYER_COMPANY_REVIEW,
  );

  const kinds = validDocumentKinds(input.documentKinds ?? []);
  const message = input.reason?.trim() ?? '';
  const actor = actorOf(reviewer);

  await prisma.$transaction(async (tx) => {
    await transitionCompany(tx, {
      companyId: input.companyId,
      to: 'REVERIFICATION_REQUIRED',
      actor,
      as: 'REVIEWER',
      reason: message,
      reasonCode: input.reasonCode ?? null,
      expectedVersion: input.expectedVersion,
    });
    const caseId = await openVerificationCase(tx, input.companyId, 'REVERIFICATION');
    await createInfoRequest(tx, input.companyId, caseId, message, kinds, actor);
    await sendCompanyEmail({
      kind: 'REVERIFICATION',
      companyId: input.companyId,
      reason: message,
      tx,
    });
  });

  await dispatchPendingNotifications();
  return readForReview(reviewer, input.companyId);
}

/** Ask every registry again, now. A new set of rows; the old ones stay. */
export async function rerunChecks(
  reviewer: Reviewer,
  companyId: string,
): Promise<Record<string, unknown>> {
  requireGrant(reviewer, Permission.BUYER_COMPANY_REVIEW);
  await loadCompanyRecord(companyId);
  const openCase = await prisma.buyerCompanyVerificationCase.findFirst({
    where: { companyId, state: 'OPEN' },
    orderBy: { round: 'desc' },
    select: { id: true },
  });
  await runChecks(companyId, openCase?.id ?? null, actorOf(reviewer));
  return readForReview(reviewer, companyId);
}

/** Staff who may be given a case, for the assignment picker. */
export async function listReviewers(): Promise<{ id: string; email: string }[]> {
  const staff = await prisma.user.findMany({
    where: { type: 'ADMIN', status: 'ACTIVE', archivedAt: null },
    select: { id: true, email: true, roles: { select: { role: { select: { key: true } } } } },
    orderBy: { email: 'asc' },
    take: 500,
  });
  return staff
    .filter((user) =>
      permissionsForRoles(user.roles.map((row) => row.role.key)).has(
        Permission.BUYER_COMPANY_REVIEW,
      ),
    )
    .map((user) => ({ id: user.id, email: user.email }));
}
