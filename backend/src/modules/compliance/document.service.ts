/**
 * Compliance documents: certificates, licences, registrations, declarations of
 * conformity, test reports and authorisations - and their review.
 *
 * Held on the existing `seller_certifications` row, so there is ONE record of
 * a seller's certificate whether it is looked at in the Seller Hub's factory
 * page, the Admin Panel or the Audit Console. The review workflow:
 *
 *   DRAFT → SUBMITTED → UNDER_REVIEW → CHANGES_REQUESTED → (resubmit) → …
 *                                    → APPROVED → SUSPENDED / EXPIRED
 *                                    → REJECTED
 *
 * and the older `state` column is kept in step by `stateFor`, so the supplier
 * badge, listing holds and expiry sweep keep reading what they always read.
 *
 * WHAT APPROVAL MEANS, AND WHAT IT DOES NOT. A reviewer approves a document
 * with a recorded verification METHOD and OUTCOME:
 *   - MANUAL_EVIDENCE: the reviewer examined the file. Shown as "evidence
 *     reviewed", never as "authentic" - an uploaded PDF, or text read out of
 *     it, proves nothing about who issued it.
 *   - REGISTRY_LOOKUP / ISSUER_CONFIRMATION: checked with the issuer or an
 *     official register. VERIFIED is shown as such.
 *   - A registry check that could not be completed is UNABLE_TO_VERIFY - never
 *     "fraudulent". A MISMATCH can never be approved.
 * And it approves a SCOPE: the categories, products and site it covers and the
 * requirement codes it satisfies. A document with no category scope satisfies
 * nothing; a seller approved for one category is not thereby approved for any
 * other.
 *
 * When an approved document stops standing - replaced, suspended, expired, or
 * its scope or dates changed - every qualification that relied on it is sent
 * back for re-review (REREVIEW_REQUIRED). Nothing else is suspended with it.
 */
import { z } from 'zod';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { withWriteConflictRetry } from '../../infra/write-conflict.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifyAuditUsers, staffUserIds } from '../audit-console/notification.service.js';
import { isServable } from '../seller/document.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { holdCertificateListings, releaseCertificateListings } from '../trust/certificate-listing-holds.service.js';
import { usableOwnDocument } from '../trust/factory.service.js';
import { recordComplianceEvent, type ComplianceActor } from './events.js';

type Tx = PrismaTransaction;
export type DocumentStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'CHANGES_REQUESTED'
  | 'APPROVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'SUSPENDED';

/** The older state the rest of the system reads, for each review status. */
export function stateFor(status: DocumentStatus): 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' {
  switch (status) {
    case 'SUBMITTED':
    case 'UNDER_REVIEW':
      return 'PENDING';
    case 'APPROVED':
      return 'VERIFIED';
    case 'EXPIRED':
      return 'EXPIRED';
    default:
      // DRAFT, CHANGES_REQUESTED, REJECTED and SUSPENDED are all "not
      // verified, and the seller may change it".
      return 'REJECTED';
  }
}

const TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['UNDER_REVIEW', 'CHANGES_REQUESTED', 'REJECTED'],
  UNDER_REVIEW: ['CHANGES_REQUESTED', 'APPROVED', 'REJECTED'],
  CHANGES_REQUESTED: ['SUBMITTED'],
  APPROVED: ['SUSPENDED', 'EXPIRED', 'SUBMITTED'],
  REJECTED: ['SUBMITTED'],
  EXPIRED: ['SUBMITTED'],
  SUSPENDED: ['UNDER_REVIEW', 'SUBMITTED'],
};

export function assertDocumentTransition(from: DocumentStatus, to: DocumentStatus): void {
  if (!(TRANSITIONS[from] ?? []).includes(to)) {
    throw conflict(ErrorCode.COMPLIANCE_DOCUMENT_TRANSITION_NOT_ALLOWED, `A document cannot move from ${from} to ${to}.`, [
      { code: 'TRANSITION', meta: { from, to } },
    ]);
  }
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.array(z.string().length(26)).max(200);
const toDate = (value: string | null | undefined): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null);
const today = (): string => new Date().toISOString().slice(0, 10);

export const complianceDocumentInput = z.strictObject({
  documentType: z.enum(['CERTIFICATE', 'LICENCE', 'REGISTRATION', 'DECLARATION_OF_CONFORMITY', 'TEST_REPORT', 'AUTHORISATION', 'OTHER']),
  /** "ISO 13485", "CDSCO MD-5 manufacturing licence", "EU declaration of conformity". */
  standard: z.string().trim().min(2).max(80),
  certificateNumber: z.string().trim().max(120).nullable().optional(),
  issuer: z.string().trim().min(2).max(160),
  issuingCountry: z.string().trim().regex(/^[A-Z]{2}$/).nullable().optional(),
  legalEntityName: z.string().trim().max(255).nullable().optional(),
  factoryId: z.string().length(26).nullable().optional(),
  categoryScopeIds: ids.min(1),
  productScopeIds: ids.default([]),
  modelScope: z.string().trim().max(4000).nullable().optional(),
  scope: z.string().trim().max(4000).nullable().optional(),
  requirementCodes: z.array(z.string().trim().regex(/^[A-Z0-9-]{2,64}$/)).max(40).default([]),
  issuedOn: isoDate.nullable().optional(),
  expiresOn: isoDate.nullable().optional(),
  noExpiryReason: z.string().trim().max(1024).nullable().optional(),
  /** The seller's own uploaded file that carries it. */
  documentId: z.string().length(26),
  /** A replacement of an earlier version, kept as history. */
  replacesId: z.string().length(26).nullable().optional(),
  /** False keeps it as a draft the seller can still change. */
  submit: z.boolean().default(true),
});
export type ComplianceDocumentInput = z.infer<typeof complianceDocumentInput>;

function assertDates(input: Pick<ComplianceDocumentInput, 'issuedOn' | 'expiresOn' | 'noExpiryReason'>): void {
  const issued = input.issuedOn ?? null;
  const expires = input.expiresOn ?? null;
  if (issued !== null && issued > today()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The issue date is in the future.', [{ field: 'issuedOn', code: 'IN_FUTURE' }]);
  }
  if (expires !== null && expires < today()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This document has already expired. Add the renewed one.', [{ field: 'expiresOn', code: 'IN_PAST' }]);
  }
  if (issued !== null && expires !== null && expires < issued) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The expiry date is before the issue date.', [{ field: 'expiresOn', code: 'BEFORE_ISSUED' }]);
  }
  if (expires === null && (input.noExpiryReason ?? '').trim().length < 10) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Give the expiry date, or explain why this document has none (for example: valid while the retention fee is paid).',
      [{ field: 'noExpiryReason', code: 'REQUIRED' }],
    );
  }
}

async function assertScopeBelongs(sellerAccountId: string, input: Pick<ComplianceDocumentInput, 'categoryScopeIds' | 'productScopeIds' | 'factoryId'>): Promise<void> {
  const categories = await prisma.category.count({ where: { id: { in: input.categoryScopeIds }, archivedAt: null } });
  if (categories !== new Set(input.categoryScopeIds).size) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'One of those categories does not exist.', [{ field: 'categoryScopeIds', code: 'UNKNOWN' }]);
  }
  if (input.productScopeIds.length > 0) {
    // A seller can name only products they sell.
    const offered = await prisma.sellerOffer.findMany({
      where: { sellerAccountId, productId: { in: input.productScopeIds } },
      select: { productId: true },
      distinct: ['productId'],
    });
    if (offered.length !== new Set(input.productScopeIds).size) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'You can only name products you sell.', [{ field: 'productScopeIds', code: 'NOT_YOURS' }]);
    }
  }
  if (input.factoryId) {
    const factory = await prisma.sellerFactory.count({ where: { id: input.factoryId, sellerAccountId, archivedAt: null } });
    if (factory === 0) throw notFound('Factory');
  }
}

export interface SellerDocActor {
  sellerAccountId: string;
  userId: string;
  label: string;
  correlationId?: string | null;
}

/** The seller adds a compliance document, as a draft or straight to review. */
export async function createComplianceDocument(actor: SellerDocActor, input: ComplianceDocumentInput): Promise<{ id: string }> {
  assertDates(input);
  await usableOwnDocument(actor.sellerAccountId, input.documentId);
  await assertScopeBelongs(actor.sellerAccountId, input);

  let revision = 1;
  if (input.replacesId) {
    const previous = await prisma.sellerCertification.findFirst({
      where: { id: input.replacesId, sellerAccountId: actor.sellerAccountId, supersededAt: null },
      select: { revision: true },
    });
    if (previous === null) throw notFound('Document to replace');
    const open = await prisma.sellerCertification.count({
      where: { supersedesId: input.replacesId, archivedAt: null, reviewStatus: { in: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'CHANGES_REQUESTED'] } },
    });
    if (open > 0) {
      throw conflict(ErrorCode.CONFLICT, 'A replacement for this document is already being reviewed.', [{ code: 'REPLACEMENT_OPEN' }]);
    }
    revision = previous.revision + 1;
  }

  const status: DocumentStatus = input.submit ? 'SUBMITTED' : 'DRAFT';
  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerCertification.create({
      data: {
        id,
        sellerAccountId: actor.sellerAccountId,
        factoryId: input.factoryId ?? null,
        standard: input.standard,
        certificateNumber: input.certificateNumber ?? null,
        issuer: input.issuer,
        scope: input.scope ?? null,
        issuedOn: toDate(input.issuedOn),
        expiresOn: toDate(input.expiresOn),
        documentId: input.documentId,
        state: stateFor(status),
        reviewStatus: status,
        documentType: input.documentType,
        issuingCountry: input.issuingCountry ?? null,
        legalEntityName: input.legalEntityName ?? null,
        categoryScopeIdsJson: [...new Set(input.categoryScopeIds)],
        productScopeIdsJson: [...new Set(input.productScopeIds)],
        modelScope: input.modelScope ?? null,
        requirementCodesJson: [...new Set(input.requirementCodes)],
        noExpiryReason: input.expiresOn ? null : input.noExpiryReason?.trim() ?? null,
        revision,
        supersedesId: input.replacesId ?? null,
      },
    });
    await recordComplianceEvent(tx, {
      subjectType: 'DOCUMENT',
      subjectId: id,
      sellerAccountId: actor.sellerAccountId,
      kind: status === 'DRAFT' ? 'drafted' : 'submitted',
      actor: { type: 'SELLER', userId: actor.userId, label: actor.label, correlationId: actor.correlationId ?? null },
      summary: `${input.standard} ${input.replacesId ? `(replacement, revision ${String(revision)}) ` : ''}${status === 'DRAFT' ? 'saved as a draft' : 'sent for review'}.`,
      sellerVisible: true,
    });
    if (status === 'SUBMITTED') await tellReviewersAboutDocument(tx, id, input.standard, actor.sellerAccountId);
  });
  return { id };
}

async function tellReviewersAboutDocument(tx: Tx, id: string, standard: string, sellerAccountId: string): Promise<void> {
  const reviewers = await staffUserIds(tx, ['SUPERVISOR', 'COMPLIANCE_REVIEWER']);
  await notifyAuditUsers(tx, reviewers, {
    kind: 'DOCUMENT_SUBMITTED',
    title: `Document to review: ${standard}`,
    link: `/documents?document=${id}`,
    subjectType: 'compliance_document',
    subjectId: id,
    dedupeKey: `document-submitted:${id}:${String(Date.now())}`,
  });
  void sellerAccountId;
}

/** The seller sends a draft, a returned or an expired document (back) for review. */
export async function submitComplianceDocument(actor: SellerDocActor, id: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerCertification.findFirst({ where: { id, sellerAccountId: actor.sellerAccountId, archivedAt: null } });
    if (row === null) throw notFound('Document');
    assertDocumentTransition(row.reviewStatus, 'SUBMITTED');
    if (row.documentId === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach the file first.', [{ field: 'documentId', code: 'REQUIRED' }]);
    }
    await usableOwnDocument(actor.sellerAccountId, row.documentId);
    if (row.expiresOn !== null && row.expiresOn.toISOString().slice(0, 10) < today()) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'This document has expired. Add the renewed one.', [{ field: 'expiresOn', code: 'IN_PAST' }]);
    }
    const moved = await tx.sellerCertification.updateMany({
      where: { id, reviewStatus: row.reviewStatus, updatedAt: row.updatedAt },
      data: { reviewStatus: 'SUBMITTED', state: 'PENDING', rejectionReason: null, expiredAt: null, expiryWarnedAt: null },
    });
    if (moved.count !== 1) throw stale();
    if (row.reviewStatus === 'APPROVED') await sendCasesBackForReview(tx, id, 'The seller changed and resubmitted a document this decision relied on.');
    await recordComplianceEvent(tx, {
      subjectType: 'DOCUMENT',
      subjectId: id,
      sellerAccountId: actor.sellerAccountId,
      kind: 'submitted',
      actor: { type: 'SELLER', userId: actor.userId, label: actor.label },
      summary: `${row.standard} sent for review.`,
      sellerVisible: true,
    });
    await tellReviewersAboutDocument(tx, id, row.standard, actor.sellerAccountId);
  });
}

const stale = () =>
  conflict(ErrorCode.COMPLIANCE_DOCUMENT_TRANSITION_NOT_ALLOWED, 'This document changed while you were looking at it. Reload it.', [{ code: 'STALE' }]);

// ---------------------------------------------------------------------------
// Re-review: a document stopped standing, so the decisions on it are reopened
// ---------------------------------------------------------------------------

/**
 * Every QUALIFIED case whose decision relied on this document goes back for
 * review. Only those cases: a seller qualified in another category on other
 * documents is untouched.
 */
export async function sendCasesBackForReview(tx: Tx, documentId: string, reason: string): Promise<number> {
  const qualified = await tx.complianceCase.findMany({
    where: { status: 'QUALIFIED' },
    select: { id: true, sellerAccountId: true, caseNumber: true, decisionSnapshotJson: true, lockVersion: true },
  });
  let reopened = 0;
  for (const row of qualified) {
    const snapshot = row.decisionSnapshotJson as { documents?: string[] } | null;
    if (!(snapshot?.documents ?? []).includes(documentId)) continue;
    const moved = await tx.complianceCase.updateMany({
      where: { id: row.id, status: 'QUALIFIED', lockVersion: row.lockVersion },
      data: { status: 'REREVIEW_REQUIRED', lockVersion: { increment: 1 } },
    });
    if (moved.count !== 1) continue;
    reopened += 1;
    await recordComplianceEvent(tx, {
      subjectType: 'CASE',
      subjectId: row.id,
      sellerAccountId: row.sellerAccountId,
      kind: 'rereview_required',
      actor: { type: 'SYSTEM', userId: null, label: 'The system' },
      summary: `${row.caseNumber} needs another review: ${reason}`,
      sellerVisible: true,
    });
  }
  if (reopened > 0) {
    const reviewers = await staffUserIds(tx, ['SUPERVISOR', 'COMPLIANCE_REVIEWER']);
    await notifyAuditUsers(tx, reviewers, {
      kind: 'CASE_REREVIEW',
      title: `${String(reopened)} qualification${reopened === 1 ? '' : 's'} need another review`,
      body: reason,
      link: '/sellers?status=REREVIEW_REQUIRED',
      dedupeKey: `rereview:${documentId}:${String(Date.now())}`,
    });
  }
  return reopened;
}

// ---------------------------------------------------------------------------
// The reviewer's side
// ---------------------------------------------------------------------------

export const documentDecisionInput = z.strictObject({
  expectedStatus: z.enum(['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SUSPENDED']),
  /** Seller-visible. Required for every decision except a start. */
  message: z.string().trim().max(4000).nullable().optional(),
  /** Operator-only. */
  internalNote: z.string().trim().max(4000).nullable().optional(),
  // For an approval:
  verificationMethod: z.enum(['MANUAL_EVIDENCE', 'REGISTRY_LOOKUP', 'ISSUER_CONFIRMATION']).optional(),
  verificationOutcome: z.enum(['NOT_CHECKED', 'VERIFIED', 'UNABLE_TO_VERIFY', 'MISMATCH']).optional(),
  verificationSource: z.string().trim().max(1024).nullable().optional(),
  /** The scope the reviewer confirms. Defaults to what the seller claimed. */
  categoryScopeIds: ids.optional(),
  productScopeIds: ids.optional(),
  requirementCodes: z.array(z.string().trim().regex(/^[A-Z0-9-]{2,64}$/)).max(40).optional(),
});
export type DocumentDecision = z.infer<typeof documentDecisionInput>;

export type ReviewAction = 'START' | 'REQUEST_CHANGES' | 'APPROVE' | 'REJECT' | 'SUSPEND';

const TARGET: Record<ReviewAction, DocumentStatus> = {
  START: 'UNDER_REVIEW',
  REQUEST_CHANGES: 'CHANGES_REQUESTED',
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  SUSPEND: 'SUSPENDED',
};

export async function reviewComplianceDocument(
  actor: ComplianceActor & { userId: string },
  id: string,
  action: ReviewAction,
  input: DocumentDecision,
): Promise<void> {
  const target = TARGET[action];
  const message = input.message?.trim() || null;
  if (action !== 'START' && action !== 'APPROVE' && (message === null || message.length < 10)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Tell the seller what to do, in at least ten characters.', [{ field: 'message', code: 'REQUIRED' }]);
  }

  const notice = await withWriteConflictRetry(() => prisma.$transaction(async (tx) => {
    const row = await tx.sellerCertification.findFirst({ where: { id, archivedAt: null } });
    if (row === null) throw notFound('Document');
    if (row.reviewStatus !== input.expectedStatus) throw stale();
    assertDocumentTransition(row.reviewStatus, target);

    let approval = {};
    if (action === 'APPROVE') {
      const method = input.verificationMethod;
      const outcome = input.verificationOutcome ?? 'NOT_CHECKED';
      if (method === undefined) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Record how the document was checked.', [{ field: 'verificationMethod', code: 'REQUIRED' }]);
      }
      if (outcome === 'MISMATCH') {
        throw conflict(ErrorCode.COMPLIANCE_DOCUMENT_TRANSITION_NOT_ALLOWED, 'The issuer or register said something different. A mismatched document cannot be approved.', [{ code: 'MISMATCH' }]);
      }
      if (method !== 'MANUAL_EVIDENCE' && outcome === 'NOT_CHECKED') {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Record what the register or issuer said.', [{ field: 'verificationOutcome', code: 'REQUIRED' }]);
      }
      if (method !== 'MANUAL_EVIDENCE' && (input.verificationSource ?? '').trim().length === 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Record where it was checked.', [{ field: 'verificationSource', code: 'REQUIRED' }]);
      }
      if (outcome === 'UNABLE_TO_VERIFY' && (input.internalNote ?? '').trim().length < 10) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why you approve on the evidence alone when the check could not be completed.', [
          { field: 'internalNote', code: 'REQUIRED' },
        ]);
      }
      if (row.documentId === null) {
        throw conflict(ErrorCode.COMPLIANCE_DOCUMENT_TRANSITION_NOT_ALLOWED, 'There is no file attached.', [{ code: 'NO_FILE' }]);
      }
      if (row.expiresOn !== null && row.expiresOn.toISOString().slice(0, 10) < today()) {
        throw conflict(ErrorCode.COMPLIANCE_DOCUMENT_TRANSITION_NOT_ALLOWED, 'This document has expired.', [{ code: 'EXPIRED' }]);
      }
      if (row.expiresOn === null && (row.noExpiryReason ?? '').trim().length === 0) {
        throw conflict(ErrorCode.COMPLIANCE_DOCUMENT_TRANSITION_NOT_ALLOWED, 'A document with no expiry date needs the reason it has none.', [{ code: 'NO_EXPIRY_REASON' }]);
      }
      const categories = input.categoryScopeIds ?? (row.categoryScopeIdsJson as string[] | null) ?? [];
      if (categories.length === 0) {
        throw badRequest(ErrorCode.VALIDATION_FAILED, 'Confirm which categories the document covers. A document that covers nothing satisfies nothing.', [
          { field: 'categoryScopeIds', code: 'REQUIRED' },
        ]);
      }
      approval = {
        verificationMethod: method,
        verificationOutcome: outcome,
        verificationSource: input.verificationSource?.trim() || null,
        categoryScopeIdsJson: categories,
        ...(input.productScopeIds === undefined ? {} : { productScopeIdsJson: input.productScopeIds }),
        ...(input.requirementCodes === undefined ? {} : { requirementCodesJson: input.requirementCodes }),
        verifiedAt: new Date(),
        verifiedByUserId: actor.userId,
        lastCheckedAt: new Date(),
      };
    }

    const now = new Date();
    const moved = await tx.sellerCertification.updateMany({
      where: { id, reviewStatus: row.reviewStatus, updatedAt: row.updatedAt },
      data: {
        reviewStatus: target,
        state: stateFor(target),
        reviewerUserId: actor.userId,
        reviewerLabel: actor.label.slice(0, 160),
        ...(action === 'START' ? { reviewStartedAt: now } : {}),
        ...(message === null ? {} : { reviewMessage: message }),
        ...(action === 'REQUEST_CHANGES' || action === 'REJECT' ? { rejectionReason: message } : {}),
        ...(action === 'SUSPEND' ? { suspendedAt: now, suspendedReason: message } : {}),
        ...(input.internalNote === undefined ? {} : { internalNote: input.internalNote?.trim() || null }),
        ...approval,
      },
    });
    if (moved.count !== 1) throw stale();

    if (action === 'APPROVE') {
      await releaseCertificateListings(tx, id);
      // A replacement, once approved, supersedes the version it replaces.
      if (row.supersedesId !== null) {
        await tx.sellerCertification.updateMany({ where: { id: row.supersedesId, supersededAt: null }, data: { supersededAt: now } });
        await sendCasesBackForReview(tx, row.supersedesId, `${row.standard} was replaced by a newer version.`);
      }
    }
    if (action === 'SUSPEND') {
      await holdCertificateListings(tx, { id, sellerAccountId: row.sellerAccountId });
      await sendCasesBackForReview(tx, id, `${row.standard} was suspended: ${message ?? ''}`);
    }

    await recordComplianceEvent(tx, {
      subjectType: 'DOCUMENT',
      subjectId: id,
      sellerAccountId: row.sellerAccountId,
      kind: target.toLowerCase(),
      actor,
      summary: `${row.standard}: ${target.replace('_', ' ').toLowerCase()}${message ? ` - ${message}` : '.'}`,
      sellerVisible: action !== 'START',
      data: action === 'APPROVE' ? { approval } : null,
    });
    await recordAudit(
      {
        action: AuditAction.COMPLIANCE_DOCUMENT_DECIDED,
        resourceType: 'seller_certification',
        resourceId: id,
        actorType: actor.type === 'ADMIN' ? 'ADMIN' : 'AUDIT',
        actorUserId: actor.userId,
        before: { reviewStatus: row.reviewStatus },
        after: { reviewStatus: target, ...(action === 'APPROVE' ? { verificationMethod: input.verificationMethod, verificationOutcome: input.verificationOutcome } : {}) },
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return action === 'START' ? null : { sellerAccountId: row.sellerAccountId, standard: row.standard };
  }));

  if (notice !== null) {
    await notifySeller({
      sellerAccountId: notice.sellerAccountId,
      kind: 'APPLICATION_STATUS',
      title:
        action === 'APPROVE'
          ? `${notice.standard} was approved`
          : action === 'REQUEST_CHANGES'
            ? `${notice.standard}: changes requested`
            : action === 'SUSPEND'
              ? `${notice.standard} was suspended`
              : `${notice.standard} was not approved`,
      body: message ?? 'See Compliance in the Seller Hub.',
      linkPath: '/seller/compliance',
      severity: action === 'APPROVE' ? 'SUCCESS' : 'WARNING',
      subjectType: 'seller_certification',
      subjectId: id,
    }).catch((error: unknown) => {
      logger.warn({ err: error }, 'could not notify the seller of a document decision');
    });
  }
}

/**
 * The expiry sweep's half: an approved document past its date becomes
 * EXPIRED, and the decisions on it go back for review. The existing
 * certification sweep moves `state`; this keeps the review status with it.
 */
export async function expireComplianceDocuments(limit = 500): Promise<number> {
  const lapsed = await prisma.sellerCertification.findMany({
    where: { reviewStatus: 'APPROVED', archivedAt: null, expiresOn: { lt: new Date(`${today()}T00:00:00.000Z`) } },
    select: { id: true, standard: true, sellerAccountId: true },
    take: limit,
  });
  let count = 0;
  for (const row of lapsed) {
    await prisma.$transaction(async (tx) => {
      const moved = await tx.sellerCertification.updateMany({
        where: { id: row.id, reviewStatus: 'APPROVED' },
        data: { reviewStatus: 'EXPIRED', state: 'EXPIRED', expiredAt: new Date() },
      });
      if (moved.count !== 1) return;
      count += 1;
      await sendCasesBackForReview(tx, row.id, `${row.standard} passed its expiry date.`);
      await recordComplianceEvent(tx, {
        subjectType: 'DOCUMENT',
        subjectId: row.id,
        sellerAccountId: row.sellerAccountId,
        kind: 'expired',
        actor: { type: 'SYSTEM', userId: null, label: 'The system' },
        summary: `${row.standard} passed its expiry date. Upload the renewed document.`,
        sellerVisible: true,
      });
    });
  }
  return count;
}

/**
 * Documents approved and expiring within `days`: tell the reviewers once, by
 * dedupe key. The seller's own warnings are the existing trust expiry alerts
 * (thirty and seven days out), which own `expiryWarnedAt`; this never touches it.
 */
export async function warnExpiringDocuments(days = 30): Promise<number> {
  const horizon = new Date(Date.now() + days * 86_400_000);
  const soon = await prisma.sellerCertification.findMany({
    where: { reviewStatus: 'APPROVED', archivedAt: null, expiresOn: { lte: horizon, gte: new Date(`${today()}T00:00:00.000Z`) } },
    select: { id: true, standard: true, sellerAccountId: true, expiresOn: true },
    take: 500,
  });
  let told = 0;
  for (const row of soon) {
    const reviewers = await staffUserIds(prisma, ['SUPERVISOR', 'COMPLIANCE_REVIEWER']);
    told += await notifyAuditUsers(prisma, reviewers, {
      kind: 'DOCUMENT_EXPIRING',
      title: `${row.standard} expires on ${row.expiresOn?.toISOString().slice(0, 10) ?? ''}`,
      link: `/documents?document=${row.id}`,
      subjectType: 'compliance_document',
      subjectId: row.id,
      dedupeKey: `document-expiring:${row.id}:${row.expiresOn?.toISOString().slice(0, 10) ?? ''}`,
    });
  }
  return told;
}

// ---------------------------------------------------------------------------
// Reading, and the file
// ---------------------------------------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

export type CertRow = Awaited<ReturnType<typeof prisma.sellerCertification.findMany>>[number];

/** One document. `audience` decides whether the internal note is included. */
export function documentView(row: CertRow, audience: 'seller' | 'staff') {
  const badge =
    row.reviewStatus !== 'APPROVED'
      ? null
      : row.verificationOutcome === 'VERIFIED'
        ? 'VERIFIED_WITH_ISSUER_OR_REGISTER'
        : row.verificationOutcome === 'UNABLE_TO_VERIFY'
          ? 'EVIDENCE_REVIEWED_REGISTER_UNAVAILABLE'
          : 'EVIDENCE_REVIEWED';
  return {
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    documentType: row.documentType,
    standard: row.standard,
    certificateNumber: row.certificateNumber,
    issuer: row.issuer,
    issuingCountry: row.issuingCountry,
    legalEntityName: row.legalEntityName,
    factoryId: row.factoryId,
    categoryScopeIds: strings(row.categoryScopeIdsJson),
    productScopeIds: strings(row.productScopeIdsJson),
    modelScope: row.modelScope,
    scope: row.scope,
    requirementCodes: strings(row.requirementCodesJson),
    issuedOn: row.issuedOn?.toISOString().slice(0, 10) ?? null,
    expiresOn: row.expiresOn?.toISOString().slice(0, 10) ?? null,
    noExpiryReason: row.noExpiryReason,
    reviewStatus: row.reviewStatus,
    /** What may be said about it: never "authentic", only what was checked. */
    badge,
    verificationMethod: row.verificationMethod,
    verificationOutcome: row.verificationOutcome,
    verificationSource: audience === 'staff' ? row.verificationSource : null,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    reviewMessage: row.reviewMessage ?? row.rejectionReason,
    internalNote: audience === 'staff' ? row.internalNote : undefined,
    reviewerLabel: audience === 'staff' ? row.reviewerLabel : null,
    revision: row.revision,
    supersedesId: row.supersedesId,
    supersededAt: row.supersededAt?.toISOString() ?? null,
    suspendedReason: row.suspendedReason,
    hasFile: row.documentId !== null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listComplianceDocuments(filters: {
  sellerAccountId?: string | null;
  status?: string | null;
  expiringWithinDays?: number | null;
  search?: string | null;
}) {
  const horizon = filters.expiringWithinDays ? new Date(Date.now() + filters.expiringWithinDays * 86_400_000) : null;
  const rows = await prisma.sellerCertification.findMany({
    where: {
      archivedAt: null,
      ...(filters.sellerAccountId ? { sellerAccountId: filters.sellerAccountId } : {}),
      ...(filters.status ? { reviewStatus: filters.status as never } : {}),
      ...(horizon === null ? {} : { expiresOn: { lte: horizon }, reviewStatus: 'APPROVED' }),
      ...(filters.search
        ? { OR: [{ standard: { contains: filters.search } }, { certificateNumber: { contains: filters.search } }, { issuer: { contains: filters.search } }] }
        : {}),
    },
    orderBy: [{ updatedAt: 'desc' }],
    take: 300,
  });
  const sellers = await prisma.sellerAccount.findMany({
    where: { id: { in: [...new Set(rows.map((row) => row.sellerAccountId))] } },
    select: { id: true, displayName: true },
  });
  const names = new Map(sellers.map((seller) => [seller.id, seller.displayName]));
  return rows.map((row) => ({ ...documentView(row, 'staff'), sellerName: names.get(row.sellerAccountId) ?? '' }));
}

export async function complianceDocumentDetail(id: string, audience: 'seller' | 'staff', sellerAccountId?: string) {
  const row = await prisma.sellerCertification.findFirst({
    where: { id, ...(sellerAccountId === undefined ? {} : { sellerAccountId }) },
  });
  if (row === null) throw notFound('Document');
  const [history, versions, file] = await Promise.all([
    prisma.complianceEvent.findMany({
      where: { subjectType: 'DOCUMENT', subjectId: id, ...(audience === 'seller' ? { sellerVisible: true } : {}) },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.sellerCertification.findMany({
      where: { sellerAccountId: row.sellerAccountId, OR: [{ id: row.supersedesId ?? '' }, { supersedesId: id }] },
      select: { id: true, revision: true, reviewStatus: true, supersededAt: true },
    }),
    row.documentId === null
      ? null
      : prisma.sellerDocument.findUnique({ where: { id: row.documentId }, select: { originalFileName: true, contentType: true, byteSize: true, scanState: true } }),
  ]);
  return {
    document: documentView(row, audience),
    file: file === null ? null : { fileName: file.originalFileName, contentType: file.contentType, byteSize: file.byteSize, scanState: file.scanState },
    versions: versions.map((version) => ({ ...version, supersededAt: version.supersededAt?.toISOString() ?? null })),
    history: history.map((event) => ({ kind: event.kind, actorLabel: event.actorLabel, summary: event.summary, at: event.createdAt.toISOString() })),
  };
}

/**
 * The file itself, for a reviewer. Private storage, a scan state that allows
 * serving, and an audit row per read. A seller reads their own files through
 * the Seller Hub's existing single-use links, never through this.
 */
export async function readComplianceFile(
  id: string,
  reader: { userId: string; actorType: 'AUDIT' | 'ADMIN'; ipAddress: string; correlationId: string },
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const row = await prisma.sellerCertification.findUnique({ where: { id }, select: { documentId: true, sellerAccountId: true } });
  if (row === null || row.documentId === null) throw notFound('Document');
  const file = await prisma.sellerDocument.findFirst({
    where: { id: row.documentId, sellerAccountId: row.sellerAccountId },
    select: { storageKey: true, contentType: true, originalFileName: true, scanState: true },
  });
  if (file === null) throw notFound('Document');
  if (!isServable(file.scanState)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_REJECTED, 'This file cannot be downloaded: it has not passed its security scan.');
  }
  await recordAudit({
    action: AuditAction.COMPLIANCE_DOCUMENT_DOWNLOADED,
    resourceType: 'seller_certification',
    resourceId: id,
    actorType: reader.actorType,
    actorUserId: reader.userId,
    ipAddress: reader.ipAddress,
    correlationId: reader.correlationId,
  });
  return { body: await storage.get(file.storageKey), contentType: file.contentType, fileName: file.originalFileName };
}
