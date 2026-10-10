/**
 * The seller turnover declaration: how a seller states it, how a reviewer
 * decides it, and how changing it sends it back for review.
 *
 * Three facts stay apart here, and every function keeps them apart:
 *
 *   - **Declared** - the amount, the currency, the financial year, and when the
 *     seller ticked the accuracy declaration. Whether it is ABOVE the minimum
 *     is worked out from the amount, never taken from the tick.
 *   - **Verified** - a member of staff with seller-review rights looked at the
 *     evidence and recorded VERIFIED or FAILED, with a reason.
 *   - **Approved** - the seller's application status. Nothing in this file
 *     approves anybody; `approvalReadiness` only refuses approval until the
 *     figure is verified.
 *
 * The figures are business financial data. Seller routes read them with
 * ACCOUNT_WRITE (owners and administrators, not every member); staff routes
 * with seller-review rights. The operator's internal note never reaches a
 * seller route.
 */
import type { SellerVerificationState } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound, type ErrorDetail } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  financialYearProblem,
  isoDate,
  parseIsoDate,
  parseTurnoverMinor,
  turnoverStanding,
  type TurnoverStanding,
} from '../../domain/seller-turnover.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { AUDIT_TEAM_LABEL, recordSellerAudit } from './audit.service.js';
import {
  assertApplicationEditable,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { markRequirementSteps } from './onboarding.service.js';
import {
  TURNOVER_EVIDENCE_FIELD_KEY,
  currentDeclaration,
  turnoverFactsFor,
  turnoverPolicy,
  turnoverPolicyView,
  type ParsedTurnover,
  type TurnoverPolicyView,
  notEligible,
  pendingStateFor,
  recordTurnoverDeclaration,
} from './turnover-facts.service.js';

export { assertTurnoverEligibleForSubmission } from './turnover-facts.service.js';

export type { ParsedTurnover } from './turnover-facts.service.js';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface TurnoverInput {
  /** Whole minor units as a string of digits, e.g. "30000000001". */
  amountMinor?: unknown;
  currency?: unknown;
  financialYearStart?: unknown;
  financialYearEnd?: unknown;
  /** The accuracy declaration. Must be literally true. */
  declarationAccepted?: unknown;
}


/**
 * Check a declaration's shape, refusing with one detail per field so the form
 * can put each message beside its own input.
 *
 * Shape only. Whether the amount is ABOVE the minimum is a separate question
 * (`assertAboveMinimum`), because a seller below it is allowed to save what
 * they entered - the policy blocks the application, not the typing.
 */
export function parseTurnoverInput(input: TurnoverInput, today: Date = new Date()): ParsedTurnover {
  const policy = turnoverPolicy();
  const details: ErrorDetail[] = [];

  const amount = parseTurnoverMinor(input.amountMinor);
  if (!amount.ok) details.push({ field: 'amountMinor', code: amount.problem });

  const currency = typeof input.currency === 'string' ? input.currency.trim().toUpperCase() : '';
  if (currency !== policy.currency) {
    details.push({ field: 'currency', code: 'CURRENCY_MISMATCH', meta: { currency: policy.currency } });
  }

  const yearProblem = financialYearProblem(input.financialYearStart, input.financialYearEnd, today);
  if (yearProblem !== null) details.push({ field: 'financialYearStart', code: yearProblem });

  if (input.declarationAccepted !== true) {
    details.push({ field: 'declarationAccepted', code: 'REQUIRED' });
  }

  if (details.length > 0 || !amount.ok) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Check the turnover details.', details);
  }

  return {
    amountMinor: amount.minor,
    currency,
    // Both parse: `financialYearProblem` returned null.
    financialYearStart: parseIsoDate(input.financialYearStart) as Date,
    financialYearEnd: parseIsoDate(input.financialYearEnd) as Date,
  };
}

/** Refuse a parsed declaration that does not meet the minimum. */
export function assertAboveMinimum(parsed: ParsedTurnover, today: Date = new Date()): void {
  const policy = turnoverPolicy();
  if (!policy.required) return;
  const standing = turnoverStanding(parsed, policy, today);
  if (standing !== 'ELIGIBLE') notEligible(standing);
}

// ---------------------------------------------------------------------------
// Recording a declaration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The seller's view
// ---------------------------------------------------------------------------

export interface SellerTurnoverView {
  policy: TurnoverPolicyView;
  /** False when the rule is off or the seller was approved before it existed. */
  applies: boolean;
  standing: TurnoverStanding;
  declaration: {
    id: string;
    amountMinor: string;
    currency: string;
    financialYearStart: string;
    financialYearEnd: string;
    policyVersion: string;
    declaredAt: string;
    verificationState: SellerVerificationState;
    /** The reviewer's seller-visible reason. Never the internal note. */
    decisionReason: string | null;
    reviewedAt: string | null;
  } | null;
  isEditable: boolean;
}

export async function readSellerTurnover(membership: SellerMembership): Promise<SellerTurnoverView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  const facts = await turnoverFactsFor(membership.sellerAccountId);
  const row = facts.current;

  return {
    policy: turnoverPolicyView(),
    applies: facts.applies,
    standing: facts.standing,
    declaration:
      row === null
        ? null
        : {
            id: row.id,
            amountMinor: row.amountMinor.toString(),
            currency: row.currency,
            financialYearStart: isoDate(row.financialYearStart),
            financialYearEnd: isoDate(row.financialYearEnd),
            policyVersion: row.policyVersion,
            declaredAt: row.declaredAt.toISOString(),
            verificationState: row.verificationState,
            decisionReason: row.decisionReason,
            reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
          },
    isEditable: membership.isApplicationEditable,
  };
}

/**
 * Save the seller's declaration from the onboarding form.
 *
 * A figure at or below the minimum is SAVED, so the seller's entry is kept,
 * and the business-identity step then says what is missing and the submit
 * gate refuses. The response says where they stand either way.
 */
export async function declareTurnover(
  membership: SellerMembership,
  input: TurnoverInput,
  correlationId?: string | null,
): Promise<SellerTurnoverView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  assertApplicationEditable(membership);

  const parsed = parseTurnoverInput(input);

  const recorded = await prisma.$transaction((tx) =>
    recordTurnoverDeclaration({
      sellerAccountId: membership.sellerAccountId,
      declaredByProfileId: membership.customerProfileId,
      parsed,
      tx,
    }),
  );

  await markRequirementSteps(
    { sellerAccountId: membership.sellerAccountId, registrationCountry: membership.registrationCountry },
    correlationId,
  );

  // Names what happened, never the figure.
  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: 'seller.turnover.declared',
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_turnover_declaration',
    resourceId: recorded.id,
    summary: recorded.changed
      ? 'Annual turnover was declared. It needs to be verified again.'
      : 'Annual turnover declaration was confirmed again, unchanged.',
    correlationId: correlationId ?? null,
  });

  return readSellerTurnover(membership);
}

/**
 * The supporting evidence changed - a document uploaded against the turnover
 * requirement, or one withdrawn. A decided declaration is reopened as a new
 * row (`EVIDENCE_CHANGED`), because a verification made against one set of
 * evidence is not a verification of another. An undecided one just follows
 * whether there is now anything to review.
 */
export async function turnoverEvidenceChanged(sellerAccountId: string, correlationId?: string | null): Promise<void> {
  const reopened = await prisma.$transaction(async (tx) => {
    const current = await tx.sellerTurnoverDeclaration.findFirst({
      where: { sellerAccountId, isCurrent: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (current === null) return false;

    const pending = await pendingStateFor(sellerAccountId, tx);

    if (current.verificationState === 'VERIFIED' || current.verificationState === 'FAILED') {
      await tx.sellerTurnoverDeclaration.update({
        where: { id: current.id },
        data: { isCurrent: false, supersededReason: 'EVIDENCE_CHANGED' },
      });
      await tx.sellerTurnoverDeclaration.create({
        data: {
          id: newId(),
          sellerAccountId,
          amountMinor: current.amountMinor,
          currency: current.currency,
          financialYearStart: current.financialYearStart,
          financialYearEnd: current.financialYearEnd,
          minimumMinor: current.minimumMinor,
          policyVersion: current.policyVersion,
          declaredAt: current.declaredAt,
          declaredByProfileId: current.declaredByProfileId,
          verificationState: pending,
          isCurrent: true,
        },
      });
      return true;
    }

    if (current.verificationState !== pending) {
      await tx.sellerTurnoverDeclaration.update({ where: { id: current.id }, data: { verificationState: pending } });
    }
    return false;
  });

  if (reopened) {
    await recordSellerAudit({
      sellerAccountId,
      action: 'seller.turnover.reopened',
      actor: { type: 'SYSTEM', label: 'Turnover evidence changed' },
      resourceType: 'seller_turnover_declaration',
      summary: 'The turnover evidence changed, so the turnover needs to be verified again.',
      correlationId: correlationId ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// The reviewer's view and decision
// ---------------------------------------------------------------------------

export interface TurnoverReviewDeclaration {
  id: string;
  amountMinor: string;
  currency: string;
  financialYearStart: string;
  financialYearEnd: string;
  minimumMinor: string;
  policyVersion: string;
  declaredAt: string;
  verificationState: SellerVerificationState;
  decisionReason: string | null;
  internalNote: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
  supersededReason: string | null;
  isCurrent: boolean;
  /** Whether this figure meets (is at least) the minimum in force when it was declared. */
  meetsMinimum: boolean;
}

export interface TurnoverReview {
  policy: TurnoverPolicyView;
  applies: boolean;
  grandfathered: boolean;
  standing: TurnoverStanding;
  current: TurnoverReviewDeclaration | null;
  history: TurnoverReviewDeclaration[];
  /** Documents uploaded against the turnover requirement, newest first. Open them through the document routes. */
  evidence: {
    id: string;
    originalFileName: string;
    scanState: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    uploadedAt: string;
    isCurrent: boolean;
  }[];
}

export async function readTurnoverReview(sellerAccountId: string): Promise<TurnoverReview> {
  const account = await prisma.sellerAccount.findUnique({ where: { id: sellerAccountId }, select: { id: true } });
  if (account === null) throw notFound('Seller');

  const [facts, rows, documents] = await Promise.all([
    turnoverFactsFor(sellerAccountId),
    prisma.sellerTurnoverDeclaration.findMany({
      where: { sellerAccountId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 50,
    }),
    prisma.sellerDocument.findMany({
      where: { sellerAccountId, requirementFieldKey: TURNOVER_EVIDENCE_FIELD_KEY },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      select: {
        id: true,
        originalFileName: true,
        scanState: true,
        approvedAt: true,
        rejectedReason: true,
        createdAt: true,
        supersededAt: true,
      },
    }),
  ]);

  const reviewerIds = [...new Set(rows.map((row) => row.reviewedByUserId).filter((id): id is string => id !== null))];
  const reviewers = new Map(
    (reviewerIds.length === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, email: true } })
    ).map((user) => [user.id, user.email]),
  );

  const toView = (row: (typeof rows)[number]): TurnoverReviewDeclaration => ({
    id: row.id,
    amountMinor: row.amountMinor.toString(),
    currency: row.currency,
    financialYearStart: isoDate(row.financialYearStart),
    financialYearEnd: isoDate(row.financialYearEnd),
    minimumMinor: row.minimumMinor.toString(),
    policyVersion: row.policyVersion,
    declaredAt: row.declaredAt.toISOString(),
    verificationState: row.verificationState,
    decisionReason: row.decisionReason,
    internalNote: row.internalNote,
    reviewedAt: row.reviewedAt === null ? null : row.reviewedAt.toISOString(),
    reviewedBy: row.reviewedByUserId === null ? null : (reviewers.get(row.reviewedByUserId) ?? null),
    supersededReason: row.supersededReason,
    isCurrent: row.isCurrent,
    meetsMinimum: row.amountMinor >= row.minimumMinor,
  });

  const current = rows.find((row) => row.isCurrent) ?? null;

  return {
    policy: turnoverPolicyView(),
    applies: facts.applies,
    grandfathered: facts.grandfathered,
    standing: facts.standing,
    current: current === null ? null : toView(current),
    history: rows.filter((row) => !row.isCurrent).map(toView),
    evidence: documents.map((document) => ({
      id: document.id,
      originalFileName: document.originalFileName,
      scanState: document.scanState,
      status: document.approvedAt !== null ? 'APPROVED' : document.rejectedReason !== null ? 'REJECTED' : 'PENDING',
      uploadedAt: document.createdAt.toISOString(),
      isCurrent: document.supersededAt === null,
    })),
  };
}

export interface DecideTurnoverInput {
  sellerAccountId: string;
  /** The declaration the reviewer was looking at. A newer one refuses the decision. */
  declarationId: string;
  decision: 'VERIFIED' | 'FAILED';
  /** Required, and shown to the seller. */
  reason: string;
  internalNote?: string | null;
  adminUserId: string;
  adminEmail?: string | null;
  /** Which console decided. Verification decisions come from AUDIT. */
  actorType?: 'ADMIN' | 'AUDIT';
  /**
   * The state the reviewer saw. When given, a declaration somebody else has
   * decided since (its state moved) is refused instead of re-decided, so a
   * stale screen cannot overwrite a colleague's decision.
   */
  expectedVerificationState?: string | null;
  correlationId?: string | null;
}

/**
 * Record a reviewer's decision on the current declaration.
 *
 * Refused when the seller has changed the declaration since the reviewer
 * loaded it, so a figure is never verified that the reviewer did not see. A
 * second decision on an already-decided row keeps the first as history.
 */
export async function decideTurnover(input: DecideTurnoverInput): Promise<TurnoverReview> {
  const reason = input.reason.trim();
  if (reason.length < 3) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the reason for the decision.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }
  const internalNote =
    input.internalNote === null || input.internalNote === undefined || input.internalNote.trim().length === 0
      ? null
      : input.internalNote.trim();

  const current = await currentDeclaration(input.sellerAccountId);
  if (current === null) throw notFound('Turnover declaration');
  if (current.id !== input.declarationId) {
    throw conflict(
      ErrorCode.SELLER_STALE_VERSION,
      'The seller changed their turnover declaration after you opened it. Reload and review the new one.',
    );
  }

  if (
    input.expectedVerificationState !== undefined &&
    input.expectedVerificationState !== null &&
    current.verificationState !== input.expectedVerificationState &&
    current.verificationState !== input.decision
  ) {
    throw conflict(
      ErrorCode.SELLER_STALE_VERSION,
      'Somebody else decided this turnover declaration while you had it open. Reload to see their decision.',
    );
  }

  // The same decision twice - a double click, a retried request - is one decision.
  if (
    current.reviewedAt !== null &&
    current.verificationState === input.decision &&
    current.decisionReason === reason &&
    current.internalNote === internalNote
  ) {
    return readTurnoverReview(input.sellerAccountId);
  }

  const now = new Date();
  const decidedId = await prisma.$transaction(async (tx) => {
    const decision = {
      verificationState: input.decision,
      decisionReason: reason,
      internalNote,
      reviewedByUserId: input.adminUserId,
      reviewedAt: now,
    } as const;

    /*
     * Conditional on what was read, so two reviewers deciding the same
     * declaration at once cannot both win: the second finds it already
     * decided (or superseded) and is told to reload.
     */
    const stale = (): never => {
      throw conflict(
        ErrorCode.SELLER_STALE_VERSION,
        'Somebody else decided this turnover declaration while you had it open. Reload to see their decision.',
      );
    };

    if (current.reviewedAt === null) {
      const written = await tx.sellerTurnoverDeclaration.updateMany({
        where: { id: current.id, isCurrent: true, reviewedAt: null },
        data: decision,
      });
      if (written.count !== 1) stale();
      return current.id;
    }

    const retired = await tx.sellerTurnoverDeclaration.updateMany({
      where: { id: current.id, isCurrent: true, reviewedAt: current.reviewedAt },
      data: { isCurrent: false, supersededReason: 'REDECIDED' },
    });
    if (retired.count !== 1) stale();
    const id = newId();
    await tx.sellerTurnoverDeclaration.create({
      data: {
        id,
        sellerAccountId: current.sellerAccountId,
        amountMinor: current.amountMinor,
        currency: current.currency,
        financialYearStart: current.financialYearStart,
        financialYearEnd: current.financialYearEnd,
        minimumMinor: current.minimumMinor,
        policyVersion: current.policyVersion,
        declaredAt: current.declaredAt,
        declaredByProfileId: current.declaredByProfileId,
        isCurrent: true,
        ...decision,
      },
    });
    return id;
  });

  await recordAudit({
    action: AuditAction.SELLER_TURNOVER_DECIDED,
    resourceType: 'seller_turnover_declaration',
    resourceId: decidedId,
    actorType: input.actorType ?? 'ADMIN',
    actorUserId: input.adminUserId,
    actorEmail: input.adminEmail ?? null,
    after: { sellerAccountId: input.sellerAccountId, decision: input.decision },
    correlationId: input.correlationId ?? null,
  });

  await recordSellerAudit({
    sellerAccountId: input.sellerAccountId,
    action: 'seller.turnover.decided',
    actor: {
      type: input.actorType ?? 'ADMIN',
      userId: input.adminUserId,
      label: input.actorType === 'AUDIT' ? AUDIT_TEAM_LABEL : 'Marketplace review',
    },
    resourceType: 'seller_turnover_declaration',
    resourceId: decidedId,
    summary: input.decision === 'VERIFIED' ? 'Annual turnover was verified.' : 'Annual turnover could not be verified.',
    correlationId: input.correlationId ?? null,
  });

  return readTurnoverReview(input.sellerAccountId);
}
