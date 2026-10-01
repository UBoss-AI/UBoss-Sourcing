/**
 * The marketplace's review of the HS codes sellers declare on their listings
 * (JOURNEY-049).
 *
 * A seller's code starts DECLARED. Staff verify it - optionally correcting it
 * to the code customs will actually accept - or reject it with a note the
 * seller can act on. Changing the code on the listing sends it back to
 * DECLARED (`saveTradeCodes`), because a verification is of a code, not of a
 * listing. Every decision is audited and the seller is told.
 *
 * Where a trade rule requires a verified code, an unverified or rejected one
 * holds the goods before dispatch (`domain/compliance-hold.ts`).
 */
import { z } from 'zod';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { notifySeller } from '../seller/notification.service.js';
import type { SettingsActor } from '../settings/settings.service.js';

export const hsDecisionInput = z
  .object({
    decision: z.enum(['VERIFIED', 'REJECTED']),
    /** The code staff confirm customs will accept, when it differs from the declared one. */
    correctedCode: z
      .string()
      .trim()
      .regex(/^\d{4,10}$/)
      .nullable()
      .optional(),
    note: z.string().trim().max(1000).nullable().optional(),
    /** The declared code the reviewer looked at; refused if the seller changed it since. */
    declaredCode: z.string().trim().max(10),
  })
  .strict();
export type HsDecisionInput = z.infer<typeof hsDecisionInput>;

export interface HsReviewRow {
  offerId: string;
  sellerName: string;
  sellerSku: string;
  productName: string;
  declaredCode: string;
  countryOfOrigin: string | null;
  state: 'DECLARED' | 'VERIFIED' | 'REJECTED';
  verifiedCode: string | null;
  note: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

const SELECT = {
  id: true,
  sellerAccountId: true,
  sellerSku: true,
  hsnCode: true,
  countryOfOrigin: true,
  hsVerificationState: true,
  hsVerifiedCode: true,
  hsVerificationNote: true,
  hsVerifiedAt: true,
  updatedAt: true,
  product: { select: { name: true } },
  sellerAccount: { select: { displayName: true } },
} as const;

type Row = {
  id: string;
  sellerSku: string;
  hsnCode: string | null;
  countryOfOrigin: string | null;
  hsVerificationState: 'DECLARED' | 'VERIFIED' | 'REJECTED';
  hsVerifiedCode: string | null;
  hsVerificationNote: string | null;
  hsVerifiedAt: Date | null;
  updatedAt: Date;
  product: { name: string };
  sellerAccount: { displayName: string };
};

function view(row: Row): HsReviewRow {
  return {
    offerId: row.id,
    sellerName: row.sellerAccount.displayName,
    sellerSku: row.sellerSku,
    productName: row.product.name,
    declaredCode: row.hsnCode ?? '',
    countryOfOrigin: row.countryOfOrigin,
    state: row.hsVerificationState,
    verifiedCode: row.hsVerifiedCode,
    note: row.hsVerificationNote,
    verifiedAt: row.hsVerifiedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Listings with a declared HS code in one review state, oldest change first. */
export async function listHsReviews(state: 'DECLARED' | 'VERIFIED' | 'REJECTED'): Promise<HsReviewRow[]> {
  const rows = await prisma.sellerOffer.findMany({
    where: { hsVerificationState: state, hsnCode: { not: null }, status: { not: 'ARCHIVED' } },
    orderBy: { updatedAt: state === 'DECLARED' ? 'asc' : 'desc' },
    select: SELECT,
    take: 200,
  });
  return rows.map(view);
}

export async function decideHsCode(offerId: string, input: HsDecisionInput, actor: SettingsActor): Promise<HsReviewRow> {
  const note = input.note?.trim() ?? '';
  if (input.decision === 'REJECTED' && note === '') {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the HS code is rejected.', [{ field: 'note', code: 'REQUIRED' }]);
  }
  const corrected = input.decision === 'VERIFIED' ? (input.correctedCode ?? null) : null;

  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.sellerOffer.findUnique({ where: { id: offerId }, select: SELECT });
    if (before === null) throw notFound('Listing');
    if ((before.hsnCode ?? '') === '') {
      throw conflict(ErrorCode.CONFLICT, 'This listing has no HS code to review.', [{ code: 'NO_CODE' }]);
    }
    if (before.hsnCode !== input.declaredCode) {
      throw conflict(ErrorCode.CONFLICT, 'The seller changed this HS code while you were reviewing it.', [
        { code: 'STALE', meta: { declaredCode: before.hsnCode } },
      ]);
    }

    const row = await tx.sellerOffer.update({
      where: { id: offerId },
      data: {
        hsVerificationState: input.decision,
        hsVerifiedCode: corrected === null || corrected === before.hsnCode ? null : corrected,
        hsVerificationNote: note === '' ? null : note.slice(0, 1000),
        hsVerifiedAt: new Date(),
        hsVerifiedByUserId: actor.userId,
      },
      select: SELECT,
    });

    await recordAudit(
      {
        action: input.decision === 'VERIFIED' ? AuditAction.HS_CODE_VERIFIED : AuditAction.HS_CODE_REJECTED,
        resourceType: 'seller_offer',
        resourceId: offerId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { hsnCode: before.hsnCode, state: before.hsVerificationState, verifiedCode: before.hsVerifiedCode },
        after: { hsnCode: row.hsnCode, state: row.hsVerificationState, verifiedCode: row.hsVerifiedCode, note: row.hsVerificationNote },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    const code = row.hsVerifiedCode ?? row.hsnCode ?? '';
    await notifySeller({
      sellerAccountId: before.sellerAccountId,
      kind: 'LISTING_DECISION',
      title:
        input.decision === 'VERIFIED'
          ? `HS code ${code} on ${row.sellerSku} was verified`
          : `HS code ${row.hsnCode ?? ''} on ${row.sellerSku} was rejected`,
      body:
        input.decision === 'VERIFIED'
          ? row.hsVerifiedCode === null
            ? 'The marketplace confirmed the HS code you declared.'
            : `The marketplace verified it as ${row.hsVerifiedCode}, which is the code your export documents will use.`
          : `Reason: ${note}. Correct the code on the listing and it goes back for review.`,
      linkPath: '/seller/listings',
      severity: input.decision === 'VERIFIED' ? 'SUCCESS' : 'WARNING',
      subjectType: 'seller_offer',
      subjectId: offerId,
      tx,
    });
    return row;
  });

  return view(updated);
}
