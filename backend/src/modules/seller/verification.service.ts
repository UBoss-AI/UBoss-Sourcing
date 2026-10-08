/**
 * Who verifies a seller, and what the record of that verification says.
 *
 * Seller onboarding verification belongs to the Audit Team. The decisions
 * themselves still run through the services that always made them -
 * `decideApplication`, `decideSellerDocument`, `decideTurnover`,
 * `recordScreening` - so the state machine, the evidence gate, idempotency and
 * the audit trail are the same ones. What this file adds:
 *
 *   - **The reviewer pool.** Active audit staff whose role carries
 *     `audit.seller.verify`. Inspection agencies never do; their keys are the
 *     inspection keys and nothing else.
 *   - **Independence.** A reviewer whose email is one of the seller's members
 *     or its named representative cannot decide that seller.
 *   - **The history** both panels show: every verification decision, newest
 *     first, with which console made it and who. Earlier decisions keep the
 *     attribution they were written with - an approval an administrator made
 *     before the Audit Team owned this still says ADMIN.
 *   - **Telling reviewers** a new application or a resubmission is waiting.
 *   - **Reading a document's file** straight from the Audit Console, with the
 *     read audited, rather than through the Admin Panel's token links.
 */
import {
  AUDIT_STAFF_ROLES,
  AuditPermission,
  type AuditStaffRoleName,
} from '../../domain/audit-console-permissions.js';
import { ErrorCode, conflict, forbidden, notFound } from '../../domain/errors.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { storage } from '../../infra/storage/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifyAuditUsers, staffUserIds } from '../audit-console/notification.service.js';
import { isServable } from './document.service.js';

type Client = PrismaTransaction | typeof prisma;

/** The audit staff roles that verify sellers. Derived, so the catalogue is the one place it is decided. */
export const SELLER_VERIFIER_ROLES: readonly AuditStaffRoleName[] = Object.freeze(
  (Object.keys(AUDIT_STAFF_ROLES) as AuditStaffRoleName[]).filter((role) =>
    AUDIT_STAFF_ROLES[role].includes(AuditPermission.SELLER_VERIFY),
  ),
);

/** Active console users who may verify sellers. */
export function sellerVerifierUserIds(client: Client = prisma): Promise<string[]> {
  return staffUserIds(client, SELLER_VERIFIER_ROLES);
}

/**
 * How many active reviewers there are. Zero is a setup state the Admin Panel
 * shows plainly: applications wait, nobody falls back to approving them.
 */
export function countSellerVerifiers(): Promise<number> {
  return prisma.auditStaffMember.count({ where: { status: 'ACTIVE', role: { in: [...SELLER_VERIFIER_ROLES] } } });
}

/**
 * Refuse a reviewer who is connected to the seller they are deciding.
 *
 * Matched on email, because a console account and a seller member are
 * separate sign-ins: the same person holding both is the case this exists for.
 */
export async function assertIndependentReviewer(sellerAccountId: string, reviewerEmail: string): Promise<void> {
  const email = reviewerEmail.trim().toLowerCase();
  const account = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: {
      businessProfile: { select: { representativeEmail: true } },
      members: {
        where: { removedAt: null },
        select: { customerProfile: { select: { user: { select: { email: true } } } } },
      },
    },
  });
  if (account === null) throw notFound('Seller application');

  const connected = [
    account.businessProfile?.representativeEmail ?? null,
    ...account.members.map((member) => member.customerProfile.user.email),
  ].some((value) => value !== null && value.trim().toLowerCase() === email);

  if (connected) {
    throw forbidden(
      ErrorCode.SELLER_VERIFICATION_NOT_INDEPENDENT,
      'You are connected to this seller, so somebody else on the Audit Team has to decide it.',
    );
  }
}

/** The seller of one onboarding document, refusing one that has been replaced. */
export async function sellerOfCurrentDocument(documentId: string): Promise<string> {
  const document = await prisma.sellerDocument.findUnique({
    where: { id: documentId },
    select: { sellerAccountId: true, supersededAt: true },
  });
  if (document === null) throw notFound('Document');
  if (document.supersededAt !== null) {
    throw conflict(ErrorCode.CONFLICT, 'The seller has replaced this document. Decide the newer one instead.');
  }
  return document.sellerAccountId;
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

const VERIFICATION_ACTIONS = [
  'seller.application.submitted',
  'seller.application.under_review',
  'seller.application.action_required',
  'seller.application.approved',
  'seller.application.rejected',
  'seller.application.suspended',
  'seller.document.approved',
  'seller.document.rejected',
  'seller.turnover.decided',
];

export interface VerificationHistoryEntry {
  id: string;
  action: string;
  at: string;
  summary: string | null;
  /** Which console, or SELLER / SYSTEM. Kept exactly as written at the time. */
  actorType: 'ADMIN' | 'AUDIT' | 'SELLER' | 'SYSTEM';
  /** The reviewer's email for a staff decision; the seller's own label for a seller's step. */
  actorLabel: string | null;
}

/**
 * Every verification step for one seller, newest first. Staff-only: it names
 * the individual reviewer, which a seller route never does.
 */
export async function verificationHistory(sellerAccountId: string, limit = 100): Promise<VerificationHistoryEntry[]> {
  const [rows, screenings] = await Promise.all([
    prisma.sellerAuditLog.findMany({
      where: { sellerAccountId, action: { in: VERIFICATION_ACTIONS } },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: { id: true, action: true, actorType: true, actorUserId: true, actorLabel: true, summary: true, createdAt: true },
    }),
    prisma.sellerScreeningCheck.findMany({
      where: { sellerAccountId },
      orderBy: { reviewedAt: 'desc' },
      take: limit,
      select: { id: true, subjectName: true, state: true, reviewedAt: true, reviewedByUserId: true, createdAt: true },
    }),
  ]);

  const screeningIds = screenings.map((row) => row.id);
  const screeningActors =
    screeningIds.length === 0
      ? []
      : await prisma.auditLog.findMany({
          where: { resourceType: 'seller_screening_check', resourceId: { in: screeningIds } },
          select: { resourceId: true, actorType: true },
        });
  const screeningType = new Map(screeningActors.map((row) => [row.resourceId, row.actorType]));

  const userIds = [
    ...new Set(
      [...rows.map((row) => row.actorUserId), ...screenings.map((row) => row.reviewedByUserId)].filter(
        (value): value is string => value !== null,
      ),
    ),
  ];
  const users =
    userIds.length === 0
      ? []
      : await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } });
  const emailOf = new Map(users.map((user) => [user.id, user.email]));

  const typeOf = (value: string): VerificationHistoryEntry['actorType'] =>
    value === 'AUDIT' ? 'AUDIT' : value === 'ADMIN' ? 'ADMIN' : value === 'SYSTEM' ? 'SYSTEM' : 'SELLER';

  const entries: VerificationHistoryEntry[] = [
    ...rows.map((row) => {
      const actorType = typeOf(row.actorType);
      return {
        id: row.id,
        action: row.action,
        at: row.createdAt.toISOString(),
        summary: row.summary,
        actorType,
        actorLabel:
          actorType === 'ADMIN' || actorType === 'AUDIT'
            ? ((row.actorUserId === null ? null : emailOf.get(row.actorUserId)) ?? row.actorLabel)
            : row.actorLabel,
      };
    }),
    ...screenings.map((row) => ({
      id: row.id,
      action: 'seller.screening.recorded',
      at: (row.reviewedAt ?? row.createdAt).toISOString(),
      summary: `Screening of ${row.subjectName}: ${row.state.toLowerCase().replace(/_/g, ' ')}.`,
      actorType: typeOf(screeningType.get(row.id) ?? 'ADMIN'),
      actorLabel: row.reviewedByUserId === null ? null : (emailOf.get(row.reviewedByUserId) ?? null),
    })),
  ];

  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
}

/** Who made the decision the application now stands on, for the read-only Admin Panel. */
export function currentDecisionOf(history: VerificationHistoryEntry[]): VerificationHistoryEntry | null {
  return history.find((entry) => entry.action.startsWith('seller.application.') && entry.actorType !== 'SELLER') ?? null;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Tell every seller verifier that an application is waiting. Inside the caller's transaction when there is one. */
export async function notifyVerifiersOfSubmission(
  client: Client,
  input: { sellerAccountId: string; displayName: string; resubmission: boolean; version: number },
): Promise<number> {
  return notifyAuditUsers(client, await sellerVerifierUserIds(client), {
    kind: input.resubmission ? 'SELLER_APPLICATION_RESUBMITTED' : 'SELLER_APPLICATION_SUBMITTED',
    title: input.resubmission
      ? `${input.displayName} sent their seller application back with corrections`
      : `${input.displayName} applied to sell`,
    body: 'Their application is waiting for verification.',
    link: `/seller-verification/${input.sellerAccountId}`,
    subjectType: 'seller_account',
    subjectId: input.sellerAccountId,
    dedupeKey: `seller-application:${input.sellerAccountId}:${String(input.version)}`,
  });
}

/** Tell every seller verifier a document was uploaded. */
export async function notifyVerifiersOfDocument(input: {
  sellerAccountId: string;
  displayName: string;
  documentId: string;
  documentKind: string;
  fileName: string;
}): Promise<number> {
  return notifyAuditUsers(prisma, await sellerVerifierUserIds(), {
    kind: 'SELLER_DOCUMENT_UPLOADED',
    title: `${input.displayName} uploaded ${input.documentKind}`,
    body: input.fileName.slice(0, 120),
    link: `/seller-verification/${input.sellerAccountId}`,
    subjectType: 'seller_document',
    subjectId: input.documentId,
    dedupeKey: `seller-document:${input.documentId}`,
  });
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** One onboarding document's bytes for an Audit Team reviewer. Every read is audited. */
export async function readSellerDocumentForAudit(
  documentId: string,
  actor: { userId: string; correlationId?: string | null },
): Promise<{ body: Buffer; contentType: string; fileName: string }> {
  const document = await prisma.sellerDocument.findUnique({
    where: { id: documentId },
    select: { id: true, sellerAccountId: true, storageKey: true, contentType: true, originalFileName: true, scanState: true },
  });
  if (document === null) throw notFound('Document');
  if (!isServable(document.scanState)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_REJECTED, 'This file cannot be downloaded.');
  }

  await recordAudit({
    action: AuditAction.SELLER_DOCUMENT_VIEWED,
    resourceType: 'seller_document',
    resourceId: document.id,
    actorType: 'AUDIT',
    actorUserId: actor.userId,
    actorEmail: null,
    after: { sellerAccountId: document.sellerAccountId, fileName: document.originalFileName },
    correlationId: actor.correlationId ?? null,
  });

  return { body: await storage.get(document.storageKey), contentType: document.contentType, fileName: document.originalFileName };
}
