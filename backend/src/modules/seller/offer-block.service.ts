/**
 * The marketplace taking a live listing off sale, and putting it back.
 *
 * `BLOCKED` is the one offer status the SELLER can never set. It is for the
 * cases where waiting for the seller to pause their own listing is not an
 * option: a safety alert, a legal complaint, a counterfeit report.
 *
 * What it does, and what it deliberately does not:
 *
 *   - Blocking needs a REASON. The seller sees it (it is the listing's status
 *     note), so it has to be written for them, and the audit entry keeps it
 *     after the note changes.
 *   - The shelf is re-projected in the same transaction as the status, so a
 *     blocked listing leaves every category and every search at once.
 *   - The status it had before is remembered, so lifting the block returns it
 *     there. A listing that was ON SALE comes back PAUSED, never straight to
 *     ACTIVE: the seller resumes it and the resume checks run, exactly as they
 *     do after any pause.
 *   - Orders already placed are not touched. They still have to be shipped.
 *   - Both directions write an admin audit entry AND a seller audit entry, and
 *     tell the seller. Neither a block nor a lift is ever silent.
 *
 * Order status, not offer status, is the state machine this repository guards
 * with `assertTransition`; an offer has no such machine, so the allowed moves
 * are the two below and nothing else writes `BLOCKED`.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { syncMarketplacePriceForOffer } from '../catalog/marketplace-price.service.js';
import { OPERATOR_LABEL, recordSellerAudit } from './audit.service.js';
import { notifySeller } from './notification.service.js';

/** The statuses a listing can be blocked from. Not ARCHIVED (finished) or BLOCKED (already). */
const BLOCKABLE = new Set(['ACTIVE', 'PAUSED', 'INACTIVE', 'NEEDS_CHANGES']);

export interface BlockOfferInput {
  offerId: string;
  reason: string;
  adminUserId: string;
  correlationId?: string | null;
}

export interface OfferModerationResult {
  id: string;
  status: string;
}

/**
 * Take a listing off sale on the marketplace's authority.
 *
 * Refused (409 `LISTING_TRANSITION_NOT_ALLOWED`) when the listing is already
 * blocked or archived. Refused (400) when the reason is blank.
 */
export async function blockOffer(input: BlockOfferInput): Promise<OfferModerationResult> {
  const reason = input.reason.trim();

  if (reason === '') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why this listing is being blocked. The seller will read it.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }

  const offer = await prisma.sellerOffer.findUnique({
    where: { id: input.offerId },
    select: { id: true, sellerAccountId: true, sellerSku: true, status: true, statusReason: true },
  });

  if (offer === null) throw notFound('Listing');

  if (!BLOCKABLE.has(offer.status)) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      offer.status === 'BLOCKED'
        ? 'This listing is already blocked.'
        : 'This listing has been withdrawn by the seller, so there is nothing to block.',
    );
  }

  const blockedAt = new Date();

  await prisma.$transaction(async (tx) => {
    await tx.sellerOffer.update({
      where: { id: offer.id },
      data: {
        status: 'BLOCKED',
        // The seller's listings page shows `statusReason` beside the status.
        statusReason: reason.slice(0, 2000),
        blockedReason: reason.slice(0, 1000),
        blockedAt,
        blockedByUserId: input.adminUserId,
        statusBeforeBlock: offer.status as 'ACTIVE' | 'PAUSED' | 'INACTIVE' | 'NEEDS_CHANGES',
        version: { increment: 1 },
      },
    });

    // Off the shelf in the same transaction as the status.
    await syncMarketplacePriceForOffer(tx, offer.id);
  });

  await recordAudit({
    action: AuditAction.SELLER_OFFER_BLOCKED,
    resourceType: 'seller_offer',
    resourceId: offer.id,
    actorType: 'ADMIN',
    actorUserId: input.adminUserId,
    actorEmail: null,
    before: { status: offer.status },
    after: { status: 'BLOCKED', reason },
    correlationId: input.correlationId ?? null,
  });

  await recordSellerAudit({
    sellerAccountId: offer.sellerAccountId,
    action: 'seller.offer.blocked',
    actor: { type: 'ADMIN', label: OPERATOR_LABEL },
    resourceType: 'seller_offer',
    resourceId: offer.id,
    before: { status: offer.status },
    after: { status: 'BLOCKED', reason },
    summary: `${offer.sellerSku} was taken off sale by the marketplace.`,
    correlationId: input.correlationId ?? null,
  });

  await notifySeller({
    sellerAccountId: offer.sellerAccountId,
    kind: 'LISTING_DECISION',
    title: `${offer.sellerSku} was taken off sale`,
    body: `The marketplace has blocked this listing: ${reason} Orders already placed still need to be shipped.`,
    linkPath: '/seller/listings?tab=BLOCKED',
    severity: 'CRITICAL',
    subjectType: 'seller_offer',
    subjectId: offer.id,
  });

  return { id: offer.id, status: 'BLOCKED' };
}

export interface UnblockOfferInput {
  offerId: string;
  adminUserId: string;
  note?: string | null;
  correlationId?: string | null;
}

/**
 * Lift a block. The listing returns to where it was, except that one which was
 * on sale returns PAUSED so the seller's own resume checks run.
 */
export async function unblockOffer(input: UnblockOfferInput): Promise<OfferModerationResult> {
  const offer = await prisma.sellerOffer.findUnique({
    where: { id: input.offerId },
    select: {
      id: true,
      sellerAccountId: true,
      sellerSku: true,
      status: true,
      statusBeforeBlock: true,
      blockedReason: true,
    },
  });

  if (offer === null) throw notFound('Listing');

  if (offer.status !== 'BLOCKED') {
    throw conflict(ErrorCode.LISTING_TRANSITION_NOT_ALLOWED, 'This listing is not blocked.');
  }

  const before = offer.statusBeforeBlock ?? 'PAUSED';
  const returnsTo = before === 'ACTIVE' ? 'PAUSED' : before;
  const note = input.note?.trim() ?? '';

  await prisma.$transaction(async (tx) => {
    await tx.sellerOffer.update({
      where: { id: offer.id },
      data: {
        status: returnsTo,
        statusReason:
          returnsTo === 'PAUSED' ? 'The marketplace lifted a block. Put it back on sale when you are ready.' : null,
        blockedReason: null,
        blockedAt: null,
        blockedByUserId: null,
        statusBeforeBlock: null,
        version: { increment: 1 },
      },
    });

    await syncMarketplacePriceForOffer(tx, offer.id);
  });

  await recordAudit({
    action: AuditAction.SELLER_OFFER_UNBLOCKED,
    resourceType: 'seller_offer',
    resourceId: offer.id,
    actorType: 'ADMIN',
    actorUserId: input.adminUserId,
    actorEmail: null,
    before: { status: 'BLOCKED', reason: offer.blockedReason },
    after: { status: returnsTo, ...(note === '' ? {} : { note }) },
    correlationId: input.correlationId ?? null,
  });

  await recordSellerAudit({
    sellerAccountId: offer.sellerAccountId,
    action: 'seller.offer.unblocked',
    actor: { type: 'ADMIN', label: OPERATOR_LABEL },
    resourceType: 'seller_offer',
    resourceId: offer.id,
    before: { status: 'BLOCKED' },
    after: { status: returnsTo },
    summary: `${offer.sellerSku} is no longer blocked.`,
    correlationId: input.correlationId ?? null,
  });

  await notifySeller({
    sellerAccountId: offer.sellerAccountId,
    kind: 'LISTING_DECISION',
    title: `${offer.sellerSku} is no longer blocked`,
    body:
      returnsTo === 'PAUSED'
        ? 'The marketplace lifted the block. The listing is paused; put it back on sale when you are ready.'
        : 'The marketplace lifted the block.',
    linkPath: '/seller/listings',
    severity: 'SUCCESS',
    subjectType: 'seller_offer',
    subjectId: offer.id,
  });

  return { id: offer.id, status: returnsTo };
}

export interface AdminOfferRow {
  id: string;
  sellerSku: string;
  productName: string;
  status: string;
  statusReason: string | null;
  blockedReason: string | null;
  blockedAt: string | null;
  priceMinor: string;
  currency: string;
  updatedAt: string;
}

/** A seller's listings as staff see them, newest change first, a page at a time. */
export async function listOffersForAdmin(
  sellerAccountId: string,
  page: number,
  pageSize: number,
  status?: string,
): Promise<{ rows: AdminOfferRow[]; total: number }> {
  const where = {
    sellerAccountId,
    ...(status === undefined ? {} : { status: status as never }),
  };

  const [rows, total] = await Promise.all([
    prisma.sellerOffer.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        sellerSku: true,
        status: true,
        statusReason: true,
        blockedReason: true,
        blockedAt: true,
        priceMinor: true,
        currency: true,
        updatedAt: true,
        product: { select: { name: true } },
      },
    }),
    prisma.sellerOffer.count({ where }),
  ]);

  return {
    total,
    rows: rows.map((row) => ({
      id: row.id,
      sellerSku: row.sellerSku,
      productName: row.product.name,
      status: row.status,
      statusReason: row.statusReason,
      blockedReason: row.blockedReason,
      blockedAt: row.blockedAt === null ? null : row.blockedAt.toISOString(),
      // BigInt minor units cross the API as a string.
      priceMinor: row.priceMinor.toString(),
      currency: row.currency,
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}
