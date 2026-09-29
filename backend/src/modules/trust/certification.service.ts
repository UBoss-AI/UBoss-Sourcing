/**
 * The certificates a supplier holds - ISO 9001, CE, WHO-GMP - and the
 * operator's check of each one (checklist Master row 13).
 *
 * A certificate is added WITH its proof (one of the seller's own documents)
 * and adding it is asking for it to be checked, so it starts PENDING. An
 * operator with `customer.status.write` verifies or refuses it, with a
 * seller-visible reason on a refusal. The seller never sets `state`: the
 * input schemas are strict and have no such field.
 *
 *   - Refused or expired: the seller corrects it and sends it again.
 *   - Verified, then changed: it goes back to PENDING in the same write.
 *   - Verified, then past its expiry date: EXPIRED, on the first read after
 *     that day and by the worker's sweep - written by the system, audited.
 *
 * Every state write is conditional on the state and `updatedAt` that were
 * read, so a reviewer on a stale screen, or two reviewers at once, get one
 * winner and one STALE refusal.
 */
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  assertCertificationTransition,
  effectiveCertificationState,
  isCertificationEditable,
  type CertificationStateName,
} from '../../domain/factory-verification-state.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { assertSellerPermission, type SellerMembership } from '../seller/account.service.js';
import { OPERATOR_LABEL, recordSellerAudit } from '../seller/audit.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { trustTimings, usableOwnDocument, type StaffActor } from './factory.service.js';

export const MAX_CERTIFICATIONS_PER_SELLER = 100;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const certificationFields = {
  standard: z.string().trim().min(1).max(80),
  certificateNumber: z.string().trim().max(120).nullable().optional(),
  issuer: z.string().trim().min(1).max(160),
  scope: z.string().trim().max(4000).nullable().optional(),
  issuedOn: isoDate.nullable().optional(),
  expiresOn: isoDate.nullable().optional(),
  /** The seller's own document that proves it. Required. */
  documentId: z.string().length(26),
  /** One of the seller's factories, when the certificate covers a single plant. */
  factoryId: z.string().length(26).nullable().optional(),
};

export const certificationInput = z.strictObject(certificationFields);
export const certificationPatch = z.strictObject(
  Object.fromEntries(Object.entries(certificationFields).map(([key, schema]) => [key, schema.optional()])) as {
    [K in keyof typeof certificationFields]: z.ZodOptional<(typeof certificationFields)[K]>;
  },
);

export const certificationDecisionInput = z.strictObject({
  decision: z.enum(['VERIFIED', 'REJECTED']),
  /** The state the reviewer was looking at. */
  expectedState: z.enum(['PENDING', 'VERIFIED']),
  reason: z.string().trim().max(2000).nullable().optional(),
});

const today = (): string => new Date().toISOString().slice(0, 10);
const dateOnly = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10));
const toDate = (value: string | null | undefined): Date | null | undefined =>
  value === undefined ? undefined : value === null ? null : new Date(`${value}T00:00:00.000Z`);

export interface CertificationView {
  id: string;
  factoryId: string | null;
  factoryName: string | null;
  standard: string;
  certificateNumber: string | null;
  issuer: string;
  scope: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  documentId: string | null;
  document: { originalFileName: string; contentType: string; byteSize: number; isReplaced: boolean } | null;
  state: CertificationStateName;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  rejectionReason: string | null;
  /** Within the deployment's warning window of its expiry date. */
  expiresSoon: boolean;
  isEditable: boolean;
  /** Needed by the reviewer's decision, as the stale-screen guard. */
  updatedAt: string;
  /** Operator-only. */
  verifiedBy?: { id: string; email: string | null } | null;
}

const CERT_INCLUDE = { factory: { select: { name: true, archivedAt: true } } } as const;

type CertRow = Prisma.SellerCertificationGetPayload<{ include: typeof CERT_INCLUDE }>;

async function views(sellerAccountId: string, rows: CertRow[], audience: 'seller' | 'staff'): Promise<CertificationView[]> {
  const { expiryWarningDays } = await trustTimings();
  const documentIds = rows.map((row) => row.documentId).filter((id): id is string => id !== null);
  const [documents, reviewers] = await Promise.all([
    documentIds.length === 0
      ? Promise.resolve([])
      : prisma.sellerDocument.findMany({
          where: { id: { in: documentIds }, sellerAccountId },
          select: { id: true, originalFileName: true, contentType: true, byteSize: true, supersededAt: true },
        }),
    audience === 'staff'
      ? prisma.user.findMany({
          where: { id: { in: rows.map((row) => row.verifiedByUserId).filter((id): id is string => id !== null) } },
          select: { id: true, email: true },
        })
      : Promise.resolve([]),
  ]);
  const byId = new Map(documents.map((row) => [row.id, row]));
  const emails = new Map(reviewers.map((row) => [row.id, row.email]));
  const now = today();
  const warnFrom = new Date(Date.now() + expiryWarningDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  return rows.map((row) => {
    const state = effectiveCertificationState(row, now);
    const document = row.documentId === null ? undefined : byId.get(row.documentId);
    const expires = dateOnly(row.expiresOn);
    return {
      id: row.id,
      factoryId: row.factory === null || row.factory.archivedAt !== null ? null : row.factoryId,
      factoryName: row.factory === null || row.factory.archivedAt !== null ? null : row.factory.name,
      standard: row.standard,
      certificateNumber: row.certificateNumber,
      issuer: row.issuer,
      scope: row.scope,
      issuedOn: dateOnly(row.issuedOn),
      expiresOn: expires,
      documentId: row.documentId,
      document:
        document === undefined
          ? null
          : {
              originalFileName: document.originalFileName,
              contentType: document.contentType,
              byteSize: document.byteSize,
              isReplaced: document.supersededAt !== null,
            },
      state,
      verifiedAt: row.verifiedAt?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      rejectionReason: state === 'REJECTED' ? row.rejectionReason : null,
      expiresSoon: state === 'VERIFIED' && expires !== null && expires <= warnFrom,
      isEditable: isCertificationEditable(state),
      updatedAt: row.updatedAt.toISOString(),
      ...(audience === 'staff'
        ? {
            verifiedBy:
              row.verifiedByUserId === null ? null : { id: row.verifiedByUserId, email: emails.get(row.verifiedByUserId) ?? null },
          }
        : {}),
    };
  });
}

/** Record every lapsed certificate as EXPIRED. Conditional, so it is safe to race. */
async function expireLapsed(where: { sellerAccountId?: string; id?: string }, limit = 500): Promise<number> {
  const lapsed = await prisma.sellerCertification.findMany({
    where: { ...where, state: 'VERIFIED', archivedAt: null, expiresOn: { lt: new Date(`${today()}T00:00:00.000Z`) } },
    select: { id: true, sellerAccountId: true, standard: true, expiresOn: true },
    take: limit,
  });
  let expired = 0;
  for (const row of lapsed) {
    assertCertificationTransition({ from: 'VERIFIED', to: 'EXPIRED', actor: 'SYSTEM' });
    const moved = await prisma.$transaction(async (tx) => {
      const result = await tx.sellerCertification.updateMany({
        where: { id: row.id, state: 'VERIFIED' },
        data: { state: 'EXPIRED', expiredAt: new Date() },
      });
      if (result.count === 0) return false;
      await recordAudit(
        {
          action: AuditAction.SELLER_CERTIFICATION_EXPIRED,
          resourceType: 'seller_certification',
          resourceId: row.id,
          actorType: 'SYSTEM',
          before: { state: 'VERIFIED' },
          after: { state: 'EXPIRED', expiresOn: dateOnly(row.expiresOn) },
        },
        tx,
      );
      await recordSellerAudit({
        sellerAccountId: row.sellerAccountId,
        action: 'seller.certification.expired',
        actor: { type: 'SYSTEM', label: OPERATOR_LABEL },
        resourceType: 'seller_certification',
        resourceId: row.id,
        summary: `The ${row.standard} certificate passed its expiry date. Upload the renewed certificate and send it for review.`,
        tx,
      });
      return true;
    });
    if (moved) expired += 1;
  }
  return expired;
}

/** For the worker. */
export async function sweepExpiredCertifications(limit = 500): Promise<number> {
  try {
    return await expireLapsed({}, limit);
  } catch (error) {
    logger.error({ err: error }, 'certificate expiry sweep failed');
    return 0;
  }
}

async function ownCertification(membership: SellerMembership, id: string): Promise<CertRow> {
  const row = await prisma.sellerCertification.findFirst({
    where: { id, sellerAccountId: membership.sellerAccountId, archivedAt: null },
    include: CERT_INCLUDE,
  });
  if (row === null) throw notFound('Certificate');
  return row;
}

async function oneView(membership: SellerMembership, id: string): Promise<CertificationView> {
  const [view] = await views(membership.sellerAccountId, [await ownCertification(membership, id)], 'seller');
  return view!;
}

export async function listCertifications(membership: SellerMembership): Promise<CertificationView[]> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);
  await expireLapsed({ sellerAccountId: membership.sellerAccountId });
  const rows = await prisma.sellerCertification.findMany({
    where: { sellerAccountId: membership.sellerAccountId, archivedAt: null },
    orderBy: [{ standard: 'asc' }, { createdAt: 'asc' }],
    include: CERT_INCLUDE,
  });
  return views(membership.sellerAccountId, rows, 'seller');
}

async function assertOwnFactory(sellerAccountId: string, factoryId: string | null | undefined): Promise<void> {
  if (factoryId === null || factoryId === undefined) return;
  const found = await prisma.sellerFactory.count({ where: { id: factoryId, sellerAccountId, archivedAt: null } });
  if (found === 0) throw notFound('Factory');
}

function assertDates(issuedOn: string | null | undefined, expiresOn: string | null | undefined): void {
  if (expiresOn !== null && expiresOn !== undefined && expiresOn < today()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This certificate has already expired. Add the renewed one.', [
      { field: 'expiresOn', code: 'IN_PAST' },
    ]);
  }
  if (issuedOn !== null && issuedOn !== undefined && issuedOn > today()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The issue date is in the future.', [{ field: 'issuedOn', code: 'IN_FUTURE' }]);
  }
  if (issuedOn && expiresOn && expiresOn < issuedOn) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'The expiry date is before the date it was issued.', [
      { field: 'expiresOn', code: 'BEFORE_ISSUED' },
    ]);
  }
}

const actorOf = (membership: SellerMembership) => ({ type: 'CUSTOMER' as const, label: membership.displayName });

/** Add a certificate with its proof. It goes straight to the review queue. */
export async function createCertification(
  membership: SellerMembership,
  input: z.infer<typeof certificationInput>,
  correlationId?: string | null,
): Promise<CertificationView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  const held = await prisma.sellerCertification.count({ where: { sellerAccountId: membership.sellerAccountId, archivedAt: null } });
  if (held >= MAX_CERTIFICATIONS_PER_SELLER) {
    throw conflict(ErrorCode.CONFLICT, `You can hold up to ${String(MAX_CERTIFICATIONS_PER_SELLER)} certificates. Archive one you no longer need.`);
  }
  assertDates(input.issuedOn, input.expiresOn);
  await usableOwnDocument(membership.sellerAccountId, input.documentId);
  await assertOwnFactory(membership.sellerAccountId, input.factoryId);

  const id = newId();
  await prisma.$transaction(async (tx) => {
    await tx.sellerCertification.create({
      data: {
        id,
        sellerAccountId: membership.sellerAccountId,
        factoryId: input.factoryId ?? null,
        standard: input.standard,
        certificateNumber: input.certificateNumber ?? null,
        issuer: input.issuer,
        scope: input.scope ?? null,
        issuedOn: toDate(input.issuedOn) ?? null,
        expiresOn: toDate(input.expiresOn) ?? null,
        documentId: input.documentId,
        state: 'PENDING',
      },
    });
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.certification.created',
      actor: actorOf(membership),
      resourceType: 'seller_certification',
      resourceId: id,
      after: { standard: input.standard, issuer: input.issuer, expiresOn: input.expiresOn ?? null },
      summary: `Added the ${input.standard} certificate and sent it for review.`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
  return oneView(membership, id);
}

/**
 * Change a certificate. Refused while it is with a reviewer; a VERIFIED one
 * goes back to PENDING, because a verification covers exactly what was checked.
 */
export async function updateCertification(
  membership: SellerMembership,
  id: string,
  patch: z.infer<typeof certificationPatch>,
  correlationId?: string | null,
): Promise<CertificationView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  await expireLapsed({ id, sellerAccountId: membership.sellerAccountId });
  const row = await ownCertification(membership, id);
  if (!isCertificationEditable(row.state)) {
    throw conflict(ErrorCode.CERTIFICATION_NOT_EDITABLE, 'This certificate is with a reviewer. Wait for their decision before you change it.');
  }
  const nextIssued = patch.issuedOn === undefined ? dateOnly(row.issuedOn) : patch.issuedOn;
  const nextExpires = patch.expiresOn === undefined ? dateOnly(row.expiresOn) : patch.expiresOn;
  if (patch.issuedOn !== undefined || patch.expiresOn !== undefined) assertDates(nextIssued, nextExpires);
  if (patch.documentId !== undefined && patch.documentId !== row.documentId) {
    await usableOwnDocument(membership.sellerAccountId, patch.documentId);
  }
  if (patch.factoryId !== undefined) await assertOwnFactory(membership.sellerAccountId, patch.factoryId);

  const data = {
    ...(patch.standard === undefined ? {} : { standard: patch.standard }),
    ...(patch.certificateNumber === undefined ? {} : { certificateNumber: patch.certificateNumber }),
    ...(patch.issuer === undefined ? {} : { issuer: patch.issuer }),
    ...(patch.scope === undefined ? {} : { scope: patch.scope }),
    ...(patch.issuedOn === undefined ? {} : { issuedOn: toDate(patch.issuedOn) ?? null }),
    ...(patch.expiresOn === undefined ? {} : { expiresOn: toDate(patch.expiresOn) ?? null }),
    ...(patch.documentId === undefined ? {} : { documentId: patch.documentId }),
    ...(patch.factoryId === undefined ? {} : { factoryId: patch.factoryId }),
  };
  if (Object.keys(data).length === 0) return oneView(membership, id);

  const reverify = row.state === 'VERIFIED';
  if (reverify) assertCertificationTransition({ from: 'VERIFIED', to: 'PENDING', actor: 'SELLER' });
  await prisma.$transaction(async (tx) => {
    const moved = await tx.sellerCertification.updateMany({
      where: { id, state: row.state, updatedAt: row.updatedAt },
      data: {
        ...data,
        ...(reverify ? { state: 'PENDING' as const, verifiedAt: null, verifiedByUserId: null, expiryWarnedAt: null } : {}),
      },
    });
    if (moved.count === 0) throw staleCertification();
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.certification.updated',
      actor: actorOf(membership),
      resourceType: 'seller_certification',
      resourceId: id,
      after: { fields: Object.keys(data), state: reverify ? 'PENDING' : row.state },
      summary: reverify
        ? `Changed the ${row.standard} certificate. It was verified, so it has gone back for review.`
        : `Changed the ${row.standard} certificate.`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
  return oneView(membership, id);
}

/** Send a refused or expired certificate for review again. */
export async function submitCertification(
  membership: SellerMembership,
  id: string,
  correlationId?: string | null,
): Promise<CertificationView> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_SUBMIT);
  await expireLapsed({ id, sellerAccountId: membership.sellerAccountId });
  const row = await ownCertification(membership, id);
  if (row.state === 'PENDING' || row.state === 'VERIFIED') {
    throw conflict(
      ErrorCode.CERTIFICATION_TRANSITION_INVALID,
      row.state === 'PENDING' ? 'This certificate is already with a reviewer.' : 'This certificate is verified.',
      [{ code: 'TRANSITION', meta: { from: row.state, to: 'PENDING', actor: 'SELLER' } }],
    );
  }
  assertCertificationTransition({ from: row.state, to: 'PENDING', actor: 'SELLER' });
  if (row.expiresOn !== null && dateOnly(row.expiresOn)! < today()) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This certificate has already expired. Enter the renewed certificate’s dates and document first.', [
      { field: 'expiresOn', code: 'IN_PAST' },
    ]);
  }
  if (row.documentId === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Attach the document that proves this certificate first.', [
      { field: 'documentId', code: 'REQUIRED' },
    ]);
  }
  await usableOwnDocument(membership.sellerAccountId, row.documentId);

  await prisma.$transaction(async (tx) => {
    const moved = await tx.sellerCertification.updateMany({
      where: { id, state: row.state, updatedAt: row.updatedAt },
      data: { state: 'PENDING', rejectionReason: null, expiredAt: null, expiryWarnedAt: null },
    });
    if (moved.count === 0) throw staleCertification();
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.certification.submitted',
      actor: actorOf(membership),
      resourceType: 'seller_certification',
      resourceId: id,
      before: { state: row.state },
      after: { state: 'PENDING' },
      summary: `Sent the ${row.standard} certificate for review again.`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
  return oneView(membership, id);
}

export async function archiveCertification(
  membership: SellerMembership,
  id: string,
  correlationId?: string | null,
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_WRITE);
  const row = await ownCertification(membership, id);
  await prisma.$transaction(async (tx) => {
    await tx.sellerCertification.update({ where: { id }, data: { archivedAt: new Date() } });
    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'seller.certification.archived',
      actor: actorOf(membership),
      resourceType: 'seller_certification',
      resourceId: id,
      summary: `Archived the ${row.standard} certificate.`,
      correlationId: correlationId ?? null,
      tx,
    });
  });
}

// --- The operator's side -----------------------------------------------------

export async function listCertificationsForReview(sellerAccountId: string): Promise<CertificationView[]> {
  const exists = await prisma.sellerAccount.count({ where: { id: sellerAccountId } });
  if (exists === 0) throw notFound('Seller');
  await expireLapsed({ sellerAccountId });
  const rows = await prisma.sellerCertification.findMany({
    where: { sellerAccountId, archivedAt: null },
    orderBy: [{ standard: 'asc' }, { createdAt: 'asc' }],
    include: CERT_INCLUDE,
  });
  return views(sellerAccountId, rows, 'staff');
}

const staleCertification = () =>
  conflict(ErrorCode.CERTIFICATION_TRANSITION_INVALID, 'This certificate changed while you were looking at it. Reload it and decide again.', [
    { code: 'STALE' },
  ]);

/** Verify or refuse a certificate, or withdraw a verification that turned out wrong. */
export async function decideCertification(input: {
  certificationId: string;
  decision: 'VERIFIED' | 'REJECTED';
  expectedState: 'PENDING' | 'VERIFIED';
  reason: string | null;
  actor: StaffActor;
}): Promise<CertificationView> {
  const found = await prisma.sellerCertification.findFirst({
    where: { id: input.certificationId, archivedAt: null },
    select: { sellerAccountId: true },
  });
  if (found === null) throw notFound('Certificate');
  await expireLapsed({ id: input.certificationId });
  const row = (await prisma.sellerCertification.findFirst({ where: { id: input.certificationId }, include: CERT_INCLUDE }))!;

  if (row.state !== input.expectedState) throw staleCertification();
  assertCertificationTransition({ from: row.state, to: input.decision, actor: 'STAFF' });

  const reason = input.reason === null || input.reason.trim() === '' ? null : input.reason.trim();
  if (input.decision === 'REJECTED' && (reason === null || reason.length < 5)) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say why the certificate is refused; the seller is shown the reason.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }
  if (input.decision === 'VERIFIED') {
    if (row.documentId === null) {
      throw conflict(ErrorCode.FACTORY_INCOMPLETE, 'This certificate has no document attached. Refuse it and ask for the certificate.', [
        { field: 'documentId', code: 'REQUIRED' },
      ]);
    }
    if (row.expiresOn !== null && dateOnly(row.expiresOn)! < today()) {
      throw conflict(ErrorCode.CERTIFICATION_TRANSITION_INVALID, 'This certificate has expired. Refuse it so the seller can add the renewed one.', [
        { field: 'expiresOn', code: 'EXPIRED' },
      ]);
    }
  }

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    const moved = await tx.sellerCertification.updateMany({
      where: { id: row.id, state: row.state, updatedAt: row.updatedAt },
      data:
        input.decision === 'VERIFIED'
          ? { state: 'VERIFIED', verifiedAt: now, verifiedByUserId: input.actor.userId, lastCheckedAt: now, rejectionReason: null }
          : { state: 'REJECTED', rejectionReason: reason, lastCheckedAt: now, verifiedByUserId: input.actor.userId },
    });
    if (moved.count === 0) throw staleCertification();
    await recordAudit(
      {
        action: AuditAction.SELLER_CERTIFICATION_DECIDED,
        resourceType: 'seller_certification',
        resourceId: row.id,
        actorType: 'ADMIN',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { state: row.state },
        after: { state: input.decision, sellerAccountId: row.sellerAccountId, reason },
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );
    await recordSellerAudit({
      sellerAccountId: row.sellerAccountId,
      action: 'seller.certification.decided',
      actor: { type: 'ADMIN', userId: input.actor.userId, label: OPERATOR_LABEL },
      resourceType: 'seller_certification',
      resourceId: row.id,
      before: { state: row.state },
      after: { state: input.decision },
      summary:
        input.decision === 'VERIFIED'
          ? `The ${row.standard} certificate was verified.`
          : `The ${row.standard} certificate was not verified: ${reason ?? ''}`,
      correlationId: input.actor.correlationId ?? null,
      tx,
    });
  });

  await notifySeller({
    sellerAccountId: row.sellerAccountId,
    kind: 'APPLICATION_STATUS',
    title: input.decision === 'VERIFIED' ? 'Your certificate was verified' : 'Your certificate was not verified',
    body:
      input.decision === 'VERIFIED'
        ? `${row.standard} is now shown on your supplier page.`
        : `${row.standard}: ${reason ?? ''}`,
    linkPath: '/seller/factories',
    severity: input.decision === 'VERIFIED' ? 'SUCCESS' : 'WARNING',
    subjectType: 'seller_certification',
    subjectId: row.id,
  }).catch((error: unknown) => {
    logger.warn({ err: error, certificationId: row.id }, 'could not notify the seller of a certificate decision');
  });

  const fresh = (await prisma.sellerCertification.findFirst({ where: { id: row.id }, include: CERT_INCLUDE }))!;
  const [view] = await views(row.sellerAccountId, [fresh], 'staff');
  return view!;
}
