/**
 * Sample requests on a request for quotation (checklist Master row 20).
 *
 * The buyer asks one invited seller - optionally against that seller's quote
 * - for a sample: a quantity, where to send it, by when, and what it must show
 * to be approved. The seller accepts (saying what it costs, if anything) or
 * declines with a reason, and records the courier and tracking number when it
 * ships. The buyer confirms it arrived and approves or rejects it against the
 * criteria, a rejection with a reason. An approved sample gets a reference
 * code: the reference sample a later inspection is measured against.
 *
 * Nothing is recorded as done that did not happen: SHIPPED needs the courier
 * and tracking number, DELIVERED needs the buyer, and payment is never marked
 * PAID - collecting money for samples is not built, so a sample with a cost
 * stays PAYMENT_PENDING. Both sides may attach evidence (purpose SAMPLE); only
 * the buyer and that seller see it. Every step is on the timeline, told to the
 * other side and audited.
 */
import { z } from 'zod';
import { ErrorCode, badRequest, conflict } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { isQuantity, normaliseQuantity } from '../../domain/rfq.js';
import { LIVE_INVITATION_STATUSES } from '../../domain/rfq-state.js';
import {
  allowedSampleTransitions,
  assertSampleTransition,
  TERMINAL_SAMPLE_STATUSES,
  type RfqSampleStatusName,
} from '../../domain/rfq-sample-state.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { dispatchPendingNotifications, enqueueNotification, NotificationEvent } from '../notifications/notification.service.js';
import { notifySeller } from '../seller/notification.service.js';
import { rfqNotFound, type RfqBuyer, type RfqSupplier } from './access.js';
import { ATTACHMENT_SELECT, attachmentView, type RfqAttachmentView } from './attachment.service.js';
import { tellBuyer } from './quote.service.js';
import { loadRfqForBuyer, recordEvent, sellerResponderEmails, sellerRfqUrl } from './rfq.service.js';
import { loadInvitation } from './supplier.service.js';

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((value) => (value === null || value.length === 0 ? null : value));

export const sampleCreateSchema = z
  .object({
    sellerAccountId: z.string().length(26),
    quoteId: z.string().length(26).nullable().default(null),
    quantity: z.string().trim().refine(isQuantity, { message: 'Enter a positive number with at most three decimal places.' }),
    unitOfMeasure: z.string().max(16).nullable().default(null),
    deliveryAddress: z.string().trim().min(5).max(500),
    requestedByDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
    approvalCriteria: z.string().trim().min(5).max(5000),
    notes: text(2000),
  })
  .strict();

export const sampleAcceptSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    costMinor: z.string().regex(/^(?:0|[1-9]\d{0,14})$/).nullable().default(null),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable().default(null),
    note: text(1000),
  })
  .strict();
export const sampleShipSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    courier: z.string().trim().min(2).max(80),
    trackingNumber: z.string().trim().min(3).max(80),
  })
  .strict();
export const sampleReasonSchema = z
  .object({ expectedVersion: z.number().int().min(0), reason: z.string().trim().max(1000).nullable().default(null) })
  .strict();

type SampleRow = Prisma.RfqSampleGetPayload<Record<string, never>>;

export interface SampleView {
  id: string;
  reference: string;
  rfqId: string;
  sellerAccountId: string;
  supplierName: string;
  quoteId: string | null;
  status: RfqSampleStatusName;
  version: number;
  quantity: string;
  unitOfMeasure: string | null;
  deliveryAddress: string;
  requestedByDate: string | null;
  approvalCriteria: string;
  notes: string | null;
  cost: ReturnType<typeof serialiseMoney> | null;
  paymentStatus: 'NOT_REQUIRED' | 'PAYMENT_PENDING' | 'PAID';
  supplierNote: string | null;
  courier: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  referenceCode: string | null;
  evidence: RfqAttachmentView[];
  actions: RfqSampleStatusName[];
  createdAt: string;
}

async function views(rows: SampleRow[], party: 'BUYER' | 'SUPPLIER'): Promise<SampleView[]> {
  if (rows.length === 0) return [];
  const [sellers, files] = await Promise.all([
    prisma.sellerAccount.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.sellerAccountId))] } }, select: { id: true, displayName: true } }),
    prisma.rfqAttachment.findMany({
      where: { sampleId: { in: rows.map((row) => row.id) }, purpose: 'SAMPLE' },
      orderBy: { createdAt: 'asc' },
      select: { ...ATTACHMENT_SELECT, quoteVersionId: true, sampleId: true },
    }),
  ]);
  const names = new Map(sellers.map((seller) => [seller.id, seller.displayName]));
  return rows.map((row) => ({
    id: row.id,
    reference: row.reference,
    rfqId: row.rfqId,
    sellerAccountId: row.sellerAccountId,
    supplierName: names.get(row.sellerAccountId) ?? '',
    quoteId: row.quoteId,
    status: row.status,
    version: row.version,
    quantity: normaliseQuantity(row.quantity.toFixed(3)),
    unitOfMeasure: row.unitOfMeasure,
    deliveryAddress: row.deliveryAddress,
    requestedByDate: row.requestedByDate?.toISOString().slice(0, 10) ?? null,
    approvalCriteria: row.approvalCriteria,
    notes: row.notes,
    cost: row.costMinor === null || row.currency === null ? null : serialiseMoney(row.costMinor, row.currency),
    paymentStatus: row.paymentStatus,
    supplierNote: row.supplierNote,
    courier: row.courier,
    trackingNumber: row.trackingNumber,
    shippedAt: row.shippedAt?.toISOString() ?? null,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    referenceCode: row.referenceCode,
    evidence: files.filter((file) => file.sampleId === row.id).map(attachmentView),
    actions: allowedSampleTransitions(row.status, party),
    createdAt: row.createdAt.toISOString(),
  }));
}

async function nextReference(tx: PrismaTransaction): Promise<string> {
  const year = new Date().getUTCFullYear();
  const key = `rfq-sample:${String(year)}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'SMP', padding: 6 },
  });
  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `SMP-${String(year)}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

// ---------------------------------------------------------------------------
// The buyer
// ---------------------------------------------------------------------------

export async function listBuyerSamples(buyer: RfqBuyer, rfqId: string): Promise<SampleView[]> {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  return views(await prisma.rfqSample.findMany({ where: { rfqId: rfq.id }, orderBy: { createdAt: 'asc' } }), 'BUYER');
}

/**
 * Ask a seller taking part in the request for a sample. The route needs an
 * Idempotency-Key, so a repeated press is one request.
 */
export async function requestSample(
  buyer: RfqBuyer,
  rfqId: string,
  input: z.infer<typeof sampleCreateSchema>,
): Promise<SampleView> {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  if (rfq.status !== 'OPEN' && rfq.status !== 'AWARDED') {
    throw conflict(ErrorCode.RFQ_SAMPLE_TRANSITION_NOT_ALLOWED, 'Samples can only be asked for on an open or awarded request.', [
      { code: rfq.status },
    ]);
  }
  const invitation = await prisma.rfqInvitation.findUnique({
    where: { rfqId_sellerAccountId: { rfqId: rfq.id, sellerAccountId: input.sellerAccountId } },
  });
  if (invitation === null || !LIVE_INVITATION_STATUSES.includes(invitation.status)) {
    throw conflict(ErrorCode.RFQ_SUPPLIER_NOT_ELIGIBLE, 'Only a supplier taking part in this request can be asked for a sample.', [
      { field: 'sellerAccountId', code: 'NOT_ELIGIBLE' },
    ]);
  }
  if (input.quoteId !== null) {
    const quote = await prisma.rfqQuote.findFirst({ where: { id: input.quoteId, rfqId: rfq.id, sellerAccountId: input.sellerAccountId } });
    if (quote === null) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'That quote is not this supplier’s quote on this request.', [{ field: 'quoteId', code: 'UNKNOWN' }]);
    }
  }
  const id = newId();
  await prisma.$transaction(async (tx) => {
    const reference = await nextReference(tx);
    await tx.rfqSample.create({
      data: {
        id,
        reference,
        rfqId: rfq.id,
        sellerAccountId: input.sellerAccountId,
        quoteId: input.quoteId,
        quantity: normaliseQuantity(input.quantity),
        unitOfMeasure: input.unitOfMeasure ?? rfq.unitOfMeasure,
        deliveryAddress: input.deliveryAddress,
        requestedByDate: input.requestedByDate === null ? null : new Date(`${input.requestedByDate}T00:00:00.000Z`),
        approvalCriteria: input.approvalCriteria,
        notes: input.notes,
        requestedByUserId: buyer.userId,
      },
    });
    await recordEvent(tx, {
      rfqId: rfq.id,
      kind: 'SAMPLE_REQUESTED',
      actorParty: 'BUYER',
      actorUserId: buyer.userId,
      sellerAccountId: input.sellerAccountId,
      meta: { sampleId: id, reference },
    });
    await tellSeller(tx, rfq, input.sellerAccountId, `sample ${reference} was requested`, `rfq:${rfq.id}:sample:${id}:requested`);
    await recordAudit(
      {
        action: AuditAction.RFQ_SAMPLE_REQUESTED,
        resourceType: 'rfq_request',
        resourceId: rfq.id,
        actorType: 'CUSTOMER',
        actorUserId: buyer.userId,
        actorEmail: buyer.email,
        after: { sampleId: id, reference, sellerAccountId: input.sellerAccountId, quoteId: input.quoteId },
      },
      tx,
    );
  });
  await dispatchPendingNotifications();
  const [view] = await views([await prisma.rfqSample.findUniqueOrThrow({ where: { id } })], 'BUYER');
  if (view === undefined) rfqNotFound();
  return view;
}

async function tellSeller(
  tx: PrismaTransaction,
  rfq: { id: string; reference: string; title: string },
  sellerAccountId: string,
  step: string,
  dedupeKey: string,
): Promise<void> {
  await notifySeller({
    sellerAccountId,
    kind: 'RFQ_UPDATE',
    title: `Request ${rfq.reference}: ${step}`,
    body: `On "${rfq.title}", ${step}.`,
    linkPath: `/seller/rfqs/${rfq.id}`,
    subjectType: 'rfq_request',
    subjectId: rfq.id,
    dedupeKey,
    tx,
  });
  for (const email of await sellerResponderEmails(sellerAccountId)) {
    await enqueueNotification(
      {
        eventKey: NotificationEvent.RFQ_UPDATE_FOR_SELLER,
        recipientEmail: email,
        variables: { rfqReference: rfq.reference, title: rfq.title, step, sellerUrl: sellerRfqUrl(rfq.id) },
        dedupeKey: `${dedupeKey}:${email}`,
        relatedType: 'rfq_request',
        relatedId: rfq.id,
      },
      tx,
    );
  }
}

// ---------------------------------------------------------------------------
// Moving a sample
// ---------------------------------------------------------------------------

interface Move {
  party: 'BUYER' | 'SUPPLIER';
  userId: string;
  email: string | null;
  to: RfqSampleStatusName;
  expectedVersion: number;
  reason?: string | null;
  data?: Prisma.RfqSampleUncheckedUpdateManyInput;
}

async function move(sample: SampleRow, rfq: { id: string; reference: string; title: string; customerProfileId: string }, change: Move): Promise<void> {
  assertSampleTransition({ from: sample.status, to: change.to, actor: change.party, reason: change.reason ?? null });
  if (sample.version !== change.expectedVersion) {
    throw conflict(ErrorCode.RFQ_SAMPLE_TRANSITION_NOT_ALLOWED, 'This sample changed while you had it open. Reload it.', [{ code: 'STALE' }]);
  }
  await prisma.$transaction(async (tx) => {
    const moved = await tx.rfqSample.updateMany({
      where: { id: sample.id, status: sample.status, version: sample.version },
      data: { ...(change.data ?? {}), status: change.to, version: { increment: 1 } },
    });
    if (moved.count !== 1) {
      throw conflict(ErrorCode.RFQ_SAMPLE_TRANSITION_NOT_ALLOWED, 'This sample changed while you had it open. Reload it.', [{ code: 'STALE' }]);
    }
    await recordEvent(tx, {
      rfqId: rfq.id,
      kind: `SAMPLE_${change.to}`,
      actorParty: change.party,
      actorUserId: change.userId,
      sellerAccountId: sample.sellerAccountId,
      meta: { sampleId: sample.id, reference: sample.reference },
    });
    const step = `sample ${sample.reference} is ${change.to.toLowerCase()}`;
    const key = `rfq:${rfq.id}:sample:${sample.id}:${change.to}`;
    if (change.party === 'SUPPLIER') await tellBuyer(tx, rfq, step, key);
    else await tellSeller(tx, rfq, sample.sellerAccountId, step, key);
    await recordAudit(
      {
        action: AuditAction.RFQ_SAMPLE_UPDATED,
        resourceType: 'rfq_request',
        resourceId: rfq.id,
        actorType: 'CUSTOMER',
        actorUserId: change.userId,
        actorEmail: change.email,
        before: { sampleId: sample.id, status: sample.status },
        after: { sampleId: sample.id, status: change.to, party: change.party, reason: change.reason ?? null },
      },
      tx,
    );
  });
  await dispatchPendingNotifications();
}

async function buyerSample(buyer: RfqBuyer, rfqId: string, sampleId: string) {
  const rfq = await loadRfqForBuyer(buyer, rfqId);
  const sample = await prisma.rfqSample.findFirst({ where: { id: sampleId, rfqId: rfq.id } });
  if (sample === null) rfqNotFound();
  return { rfq, sample };
}

async function one(id: string, party: 'BUYER' | 'SUPPLIER'): Promise<SampleView> {
  const [view] = await views([await prisma.rfqSample.findUniqueOrThrow({ where: { id } })], party);
  if (view === undefined) rfqNotFound();
  return view;
}

/** The buyer cancels, confirms receipt, approves or rejects. */
export async function buyerMoveSample(
  buyer: RfqBuyer,
  rfqId: string,
  sampleId: string,
  to: 'CANCELLED' | 'DELIVERED' | 'APPROVED' | 'REJECTED',
  input: z.infer<typeof sampleReasonSchema>,
): Promise<SampleView> {
  const { rfq, sample } = await buyerSample(buyer, rfqId, sampleId);
  const now = new Date();
  const data: Prisma.RfqSampleUncheckedUpdateManyInput =
    to === 'DELIVERED'
      ? { deliveredAt: now }
      : to === 'APPROVED'
        ? { decidedAt: now, decisionReason: input.reason, referenceCode: `REF-${sample.reference}` }
        : to === 'REJECTED'
          ? { decidedAt: now, decisionReason: input.reason }
          : { decisionReason: input.reason };
  await move(sample, rfq, { party: 'BUYER', userId: buyer.userId, email: buyer.email, to, expectedVersion: input.expectedVersion, reason: input.reason, data });
  return one(sample.id, 'BUYER');
}

// ---------------------------------------------------------------------------
// The seller
// ---------------------------------------------------------------------------

export async function listSupplierSamples(supplier: RfqSupplier, rfqId: string): Promise<SampleView[]> {
  await loadInvitation(supplier, rfqId);
  return views(
    await prisma.rfqSample.findMany({ where: { rfqId, sellerAccountId: supplier.sellerAccountId }, orderBy: { createdAt: 'asc' } }),
    'SUPPLIER',
  );
}

async function supplierSample(supplier: RfqSupplier, rfqId: string, sampleId: string) {
  const invitation = await loadInvitation(supplier, rfqId);
  const sample = await prisma.rfqSample.findFirst({ where: { id: sampleId, rfqId, sellerAccountId: supplier.sellerAccountId } });
  if (sample === null) rfqNotFound();
  return { rfq: invitation.rfq, sample };
}

/** The seller accepts, saying what the sample costs. No cost, or zero, is free. */
export async function acceptSample(
  supplier: RfqSupplier,
  rfqId: string,
  sampleId: string,
  input: z.infer<typeof sampleAcceptSchema>,
): Promise<SampleView> {
  const { rfq, sample } = await supplierSample(supplier, rfqId, sampleId);
  const charged = input.costMinor !== null && input.costMinor !== '0';
  if (charged && input.currency === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the currency of the sample cost.', [{ field: 'currency', code: 'PAIR_REQUIRED' }]);
  }
  if (charged && input.currency !== null) {
    const active = await prisma.currency.findFirst({ where: { code: input.currency, isActive: true }, select: { code: true } });
    if (active === null) throw badRequest(ErrorCode.VALIDATION_FAILED, 'That currency is not used here.', [{ field: 'currency', code: 'UNKNOWN' }]);
  }
  await move(sample, rfq, {
    party: 'SUPPLIER',
    userId: supplier.userId,
    email: null,
    to: 'ACCEPTED',
    expectedVersion: input.expectedVersion,
    data: {
      costMinor: charged ? BigInt(input.costMinor ?? '0') : null,
      currency: charged ? input.currency : null,
      // Charged means owed. Nothing here marks it paid: only a real payment would.
      paymentStatus: charged ? 'PAYMENT_PENDING' : 'NOT_REQUIRED',
      supplierNote: input.note,
    },
  });
  return one(sample.id, 'SUPPLIER');
}

export async function declineSample(
  supplier: RfqSupplier,
  rfqId: string,
  sampleId: string,
  input: z.infer<typeof sampleReasonSchema>,
): Promise<SampleView> {
  const { rfq, sample } = await supplierSample(supplier, rfqId, sampleId);
  await move(sample, rfq, {
    party: 'SUPPLIER',
    userId: supplier.userId,
    email: null,
    to: 'DECLINED',
    expectedVersion: input.expectedVersion,
    reason: input.reason,
    data: { supplierNote: input.reason },
  });
  return one(sample.id, 'SUPPLIER');
}

/** Shipped means the courier and tracking number are recorded - never before. */
export async function shipSample(
  supplier: RfqSupplier,
  rfqId: string,
  sampleId: string,
  input: z.infer<typeof sampleShipSchema>,
): Promise<SampleView> {
  const { rfq, sample } = await supplierSample(supplier, rfqId, sampleId);
  await move(sample, rfq, {
    party: 'SUPPLIER',
    userId: supplier.userId,
    email: null,
    to: 'SHIPPED',
    expectedVersion: input.expectedVersion,
    data: { courier: input.courier, trackingNumber: input.trackingNumber, shippedAt: new Date() },
  });
  return one(sample.id, 'SUPPLIER');
}

/** Whether files may still be added about a sample. */
export function sampleTakesEvidence(status: RfqSampleStatusName): boolean {
  // A decision may still be documented; a sample never sent may not.
  return !TERMINAL_SAMPLE_STATUSES.includes(status) || status === 'APPROVED' || status === 'REJECTED';
}

/** The sample row a file is being attached to, if the caller may reach it. */
export async function sampleForEvidence(rfqId: string, sampleId: string, sellerAccountId?: string): Promise<SampleRow> {
  const sample = await prisma.rfqSample.findFirst({
    where: { id: sampleId, rfqId, ...(sellerAccountId === undefined ? {} : { sellerAccountId }) },
  });
  if (sample === null) rfqNotFound();
  if (!sampleTakesEvidence(sample.status)) {
    throw conflict(ErrorCode.RFQ_SAMPLE_TRANSITION_NOT_ALLOWED, 'Files can no longer be added to this sample.', [{ code: sample.status }]);
  }
  return sample;
}

/** Link a stored SAMPLE file to its sample. */
export async function attachEvidence(attachmentId: string, sampleId: string): Promise<void> {
  await prisma.rfqAttachment.update({ where: { id: attachmentId }, data: { sampleId } });
}
