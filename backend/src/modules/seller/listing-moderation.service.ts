/**
 * Listing moderation tools (JOURNEY-062).
 *
 *   - **Prohibited terms.** The operator keeps a list of words a listing may
 *     not contain. When a seller submits, the listing's text is scanned and
 *     every hit is saved on it as an automated flag, which the moderator sees
 *     under "Already flagged". A flag is a prompt for human review, never an
 *     automatic refusal: the moderator decides.
 *   - **Appeals.** A seller whose listing was refused may appeal once per
 *     refusal, with a reason. A moderator OTHER than the one who refused it
 *     decides: upheld sends it back to the review queue, refused keeps it
 *     refused. Both are audited and the seller is told.
 *   - **Destination restrictions on approval** live in `decideListing`; the
 *     rules they write are ordinary PRODUCT-scope country rules.
 */
import { z } from 'zod';
import { ErrorCode, conflict, forbidden, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { assertListingTransition } from '../../domain/seller-state.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { assertSellerOwnership, assertSellerPermission, type SellerMembership } from './account.service.js';
import { OPERATOR_LABEL, recordSellerAudit } from './audit.service.js';
import { notifySeller } from './notification.service.js';

export interface ModerationActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

// ---------------------------------------------------------------------------
// Prohibited terms
// ---------------------------------------------------------------------------

export const prohibitedTermInput = z
  .object({
    term: z.string().trim().min(2).max(120),
    reason: z.string().trim().min(3).max(512),
    severity: z.enum(['BLOCKER', 'WARNING', 'ADVISORY']).default('WARNING'),
    isActive: z.boolean().default(true),
  })
  .strict();
export type ProhibitedTermInput = z.infer<typeof prohibitedTermInput>;

export interface ProhibitedTermView {
  id: string;
  term: string;
  reason: string;
  severity: string;
  isActive: boolean;
  updatedAt: string;
}

function termView(row: {
  id: string;
  term: string;
  reason: string;
  severity: string;
  isActive: boolean;
  updatedAt: Date;
}): ProhibitedTermView {
  return {
    id: row.id,
    term: row.term,
    reason: row.reason,
    severity: row.severity,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listProhibitedTerms(): Promise<ProhibitedTermView[]> {
  const rows = await prisma.listingProhibitedTerm.findMany({ orderBy: { term: 'asc' }, take: 2000 });
  return rows.map(termView);
}

export async function saveProhibitedTerm(
  id: string | null,
  input: ProhibitedTermInput,
  actor: ModerationActor,
): Promise<ProhibitedTermView> {
  const term = input.term.toLowerCase();
  const clash = await prisma.listingProhibitedTerm.findUnique({ where: { term }, select: { id: true } });
  if (clash !== null && clash.id !== id) {
    throw conflict(ErrorCode.LISTING_PROHIBITED_TERM_EXISTS, 'That term is already on the list.', [
      { field: 'term', code: 'EXISTS' },
    ]);
  }
  return prisma.$transaction(async (tx) => {
    const before = id === null ? null : await tx.listingProhibitedTerm.findUnique({ where: { id } });
    if (id !== null && before === null) throw notFound('Prohibited term');
    const data = { term, reason: input.reason, severity: input.severity, isActive: input.isActive, updatedById: actor.userId };
    const row =
      id === null
        ? await tx.listingProhibitedTerm.create({ data: { id: newId(), createdById: actor.userId, ...data } })
        : await tx.listingProhibitedTerm.update({ where: { id }, data });
    await recordAudit(
      {
        action: AuditAction.LISTING_TERM_SAVED,
        resourceType: 'listing_prohibited_term',
        resourceId: row.id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: before === null ? null : { term: before.term, severity: before.severity, isActive: before.isActive },
        after: { term: row.term, severity: row.severity, isActive: row.isActive },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
    return termView(row);
  });
}

export async function deleteProhibitedTerm(id: string, actor: ModerationActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const before = await tx.listingProhibitedTerm.findUnique({ where: { id } });
    if (before === null) throw notFound('Prohibited term');
    await tx.listingProhibitedTerm.delete({ where: { id } });
    await recordAudit(
      {
        action: AuditAction.LISTING_TERM_DELETED,
        resourceType: 'listing_prohibited_term',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { term: before.term, severity: before.severity },
        after: null,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/** Every string inside a JSON value, depth-first. */
function strings(value: unknown, into: string[] = [], depth = 0): string[] {
  if (depth > 8) return into;
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) for (const entry of value) strings(entry, into, depth + 1);
  else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value as Record<string, unknown>)) strings(entry, into, depth + 1);
  }
  return into;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, (match) => `\\${match}`);
}

/**
 * The terms a piece of text contains, matched on whole words, ignoring case.
 *
 * "Whole word" means letters and digits on either side end the match, so a
 * term "cure" does not flag "secure". Exported for the unit test.
 */
export function matchProhibitedTerms<T extends { term: string }>(text: string, terms: readonly T[]): T[] {
  return terms.filter((candidate) => {
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(candidate.term)}(?=$|[^\\p{L}\\p{N}])`, 'iu');
    return pattern.test(text);
  });
}

/**
 * Scan a submitted listing and save each hit as an automated flag.
 *
 * Runs inside the submission's transaction. The flags are ordinary listing
 * issues not marked as the moderator's, so the seller's next edit clears them
 * and the next submission scans again - a flag always describes the text the
 * moderator is about to read.
 */
export async function flagProhibitedTerms(tx: Prisma.TransactionClient, draftId: string): Promise<number> {
  const terms = await tx.listingProhibitedTerm.findMany({
    where: { isActive: true },
    select: { term: true, reason: true, severity: true },
  });
  if (terms.length === 0) return 0;
  const draft = await tx.sellerListingDraft.findUnique({
    where: { id: draftId },
    select: {
      generatedTitle: true,
      sellerEditedTitle: true,
      attributesJson: true,
      listingContentJson: true,
      variantsJson: true,
    },
  });
  if (draft === null) return 0;
  const text = strings([
    draft.generatedTitle,
    draft.sellerEditedTitle,
    draft.attributesJson,
    draft.listingContentJson,
    draft.variantsJson,
  ]).join('\n');
  const hits = matchProhibitedTerms(text, terms);
  await tx.sellerListingIssue.deleteMany({ where: { draftId, code: 'PROHIBITED_TERM' } });
  if (hits.length === 0) return 0;
  await tx.sellerListingIssue.createMany({
    data: hits.slice(0, 50).map((hit) => ({
      id: newId(),
      draftId,
      severity: hit.severity,
      code: 'PROHIBITED_TERM',
      message: `Contains "${hit.term}": ${hit.reason}`.slice(0, 512),
      isFromModerator: false,
    })),
  });
  return hits.length;
}

// ---------------------------------------------------------------------------
// Appeals
// ---------------------------------------------------------------------------

/** The seller appeals a refused listing. */
export async function appealListing(
  membership: SellerMembership,
  draftId: string,
  reason: string,
  correlationId?: string | null,
): Promise<{ id: string; status: string }> {
  assertSellerPermission(membership, SellerPermission.LISTING_SUBMIT);

  await prisma.$transaction(async (tx) => {
    const row = await tx.sellerListingDraft.findUnique({
      where: { id: draftId },
      select: { status: true, sellerAccountId: true },
    });
    if (row === null) throw notFound('Listing');
    assertSellerOwnership(membership, row.sellerAccountId, 'Listing');
    assertListingTransition({ from: row.status, to: 'APPEALED', actor: 'SELLER', reason });

    const moved = await tx.sellerListingDraft.updateMany({
      where: { id: draftId, status: 'REJECTED' },
      data: {
        status: 'APPEALED',
        appealReason: reason,
        appealedAt: new Date(),
        appealDecidedById: null,
        appealDecidedAt: null,
        appealOutcome: null,
      },
    });
    if (moved.count !== 1) {
      throw conflict(ErrorCode.LISTING_TRANSITION_NOT_ALLOWED, 'This listing is no longer refused.');
    }

    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.listing.appealed',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_listing_draft',
      resourceId: draftId,
      before: { status: 'REJECTED' },
      after: { status: 'APPEALED' },
      summary: `Appeal against the refusal: ${reason.slice(0, 200)}`,
      correlationId: correlationId ?? null,
      tx,
    });
  });

  return { id: draftId, status: 'APPEALED' };
}

export interface AppealDecisionInput {
  draftId: string;
  outcome: 'UPHELD' | 'REFUSED';
  comment: string;
  actor: ModerationActor;
}

/**
 * A moderator decides an appeal. Refused if they are the one who refused the
 * listing in the first place: an appeal heard by the same person is not one.
 */
export async function decideListingAppeal(input: AppealDecisionInput): Promise<{ id: string; status: string }> {
  const to = input.outcome === 'UPHELD' ? 'PENDING_REVIEW' : 'REJECTED';

  await prisma.$transaction(async (tx) => {
    const draft = await tx.sellerListingDraft.findUnique({
      where: { id: input.draftId },
      select: { status: true, sellerAccountId: true, reviewedByUserId: true, version: true },
    });
    if (draft === null) throw notFound('Listing');
    if (draft.reviewedByUserId !== null && draft.reviewedByUserId === input.actor.userId) {
      throw forbidden(
        ErrorCode.LISTING_APPEAL_SAME_MODERATOR,
        'You refused this listing, so a different moderator has to decide the appeal.',
      );
    }
    assertListingTransition({ from: draft.status, to, actor: 'OPERATOR', reason: input.comment });

    const now = new Date();
    const moved = await tx.sellerListingDraft.updateMany({
      where: { id: input.draftId, status: 'APPEALED' },
      data:
        to === 'PENDING_REVIEW'
          ? {
              status: to,
              appealOutcome: 'UPHELD',
              appealDecidedById: input.actor.userId,
              appealDecidedAt: now,
              // Back in the queue as a fresh submission of the same revision.
              submittedAt: now,
              submittedVersion: draft.version,
              reviewComment: input.comment,
            }
          : {
              status: to,
              appealOutcome: 'REFUSED',
              appealDecidedById: input.actor.userId,
              appealDecidedAt: now,
              reviewComment: input.comment,
            },
    });
    if (moved.count !== 1) {
      throw conflict(ErrorCode.SELLER_STALE_VERSION, 'Another moderator has already decided this appeal.');
    }

    await notifySeller({
      sellerAccountId: draft.sellerAccountId,
      kind: 'LISTING_DECISION',
      title: input.outcome === 'UPHELD' ? 'Your appeal was upheld' : 'Your appeal was not upheld',
      body:
        input.outcome === 'UPHELD'
          ? `Your listing is back in the review queue. ${input.comment}`
          : input.comment,
      linkPath: '/seller/listings',
      severity: input.outcome === 'UPHELD' ? 'SUCCESS' : 'WARNING',
      subjectType: 'seller_listing_draft',
      subjectId: input.draftId,
      tx,
    });

    await recordSellerAudit({
      sellerAccountId: draft.sellerAccountId,
      action: `seller.listing.appeal_${input.outcome.toLowerCase()}`,
      actor: { type: 'ADMIN', userId: input.actor.userId, label: OPERATOR_LABEL },
      resourceType: 'seller_listing_draft',
      resourceId: input.draftId,
      before: { status: 'APPEALED' },
      after: { status: to },
      summary: `Appeal ${input.outcome === 'UPHELD' ? 'upheld' : 'refused'}: ${input.comment.slice(0, 200)}`,
      correlationId: input.actor.correlationId ?? null,
      tx,
    });

    await recordAudit(
      {
        action: AuditAction.LISTING_APPEAL_DECIDED,
        resourceType: 'seller_listing_draft',
        resourceId: input.draftId,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { status: 'APPEALED' },
        after: { status: to, outcome: input.outcome, comment: input.comment },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id: input.draftId, status: to };
}
