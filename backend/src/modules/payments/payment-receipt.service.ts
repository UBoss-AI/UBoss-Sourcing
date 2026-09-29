/**
 * Payment and refund receipts for buyers.
 *
 * A buyer who has paid can download a receipt for that payment, and one for
 * every refund the provider has confirmed. Staff can download the same
 * receipts from the order screen. The receipt says money moved, so it exists
 * only once it has: a payment that is not CAPTURED, or a refund that has not
 * SUCCEEDED, is refused with RECEIPT_NOT_AVAILABLE.
 *
 * NUMBERING. The first download issues the receipt a number from
 * `NumberSequence` (`RCP-2026-000001`), inside the same transaction that
 * inserts the `payment_receipts` row. A second download - or two at once -
 * collides on `uq_payment_receipt_source`, rolls its increment back and reads
 * the existing row, so every payment has one number for ever and the series
 * has no gaps.
 *
 * WHAT IS FROZEN. Amount, currency, method, card brand and last four, the
 * provider's reference and the operator's name and support contact are copied
 * onto the row when it is issued, so a reprint says what the first copy said.
 * The payer's name is read from the order each time, because an erased account
 * must not live on inside a receipt row.
 *
 * OWNERSHIP is the caller's: the customer route passes an order it found with
 * `orderScopeWhere`, the admin route one it found by id behind PAYMENT_READ.
 * This module never decides who may see an order.
 */
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { renderPaymentReceipt, type PaymentReceiptDocument } from '../documents/payment-receipt-pdf.js';
import type { SupportedLanguage } from '../identity/language.service.js';
import { marketplaceNameFrom } from '../settings/marketplace-name.js';

type Tx = Prisma.TransactionClient;

export type ReceiptKind = 'payment' | 'refund';

export interface ReceiptListItem {
  kind: ReceiptKind;
  /** The payment transaction or refund id; with `kind`, the download path. */
  sourceId: string;
  amount: ReturnType<typeof serialiseMoney>;
  occurredAt: string | null;
  /** Null until somebody first downloads it. */
  receiptNumber: string | null;
  cardBrand: string | null;
  cardLast4: string | null;
}

/** Every receipt this order can offer: its captured payments and succeeded refunds. */
export async function listOrderReceipts(orderId: string): Promise<ReceiptListItem[]> {
  const [payments, refunds, issued] = await Promise.all([
    prisma.paymentTransaction.findMany({
      where: { orderId, status: 'CAPTURED' },
      orderBy: { capturedAt: 'asc' },
      select: { id: true, capturedMinor: true, amountMinor: true, currency: true, capturedAt: true, cardBrand: true, cardLast4: true },
    }),
    prisma.refund.findMany({
      where: { orderId, status: 'SUCCEEDED' },
      orderBy: { completedAt: 'asc' },
      select: { id: true, amountMinor: true, currency: true, completedAt: true },
    }),
    prisma.paymentReceipt.findMany({ where: { orderId }, select: { sourceKey: true, receiptNumber: true } }),
  ]);
  const numberOf = new Map(issued.map((row) => [row.sourceKey, row.receiptNumber]));

  return [
    ...payments.map((row) => ({
      kind: 'payment' as const,
      sourceId: row.id,
      amount: serialiseMoney(row.capturedMinor > 0n ? row.capturedMinor : row.amountMinor, row.currency),
      occurredAt: row.capturedAt?.toISOString() ?? null,
      receiptNumber: numberOf.get(`payment:${row.id}`) ?? null,
      cardBrand: row.cardBrand,
      cardLast4: row.cardLast4,
    })),
    ...refunds.map((row) => ({
      kind: 'refund' as const,
      sourceId: row.id,
      amount: serialiseMoney(row.amountMinor, row.currency),
      occurredAt: row.completedAt?.toISOString() ?? null,
      receiptNumber: numberOf.get(`refund:${row.id}`) ?? null,
      cardBrand: null,
      cardLast4: null,
    })),
  ];
}

const snapshotSchema = z.object({
  orderNumber: z.string(),
  occurredAt: z.string(),
  method: z.string().nullable(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  providerReference: z.string().nullable(),
  originalPaymentReference: z.string().nullable(),
  issuer: z.object({
    marketplaceName: z.string(),
    legalName: z.string(),
    supportEmail: z.string(),
    supportPhone: z.string().nullable(),
    timezone: z.string(),
  }),
});

type Snapshot = z.infer<typeof snapshotSchema>;

/** `RCP-2026-000123`, allocated inside the caller's transaction. */
async function nextReceiptNumber(tx: Tx, at: Date): Promise<string> {
  const year = String(at.getUTCFullYear());
  const key = `payment-receipt:${year}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: 'RCP', padding: 6 },
  });
  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${sequence.prefix}-${year}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}

async function issuerNow(): Promise<Snapshot['issuer']> {
  const profile = await prisma.businessProfile.findFirst({
    select: { displayName: true, legalName: true, supportEmail: true, supportPhone: true, timezone: true },
  });
  const name = marketplaceNameFrom(profile?.displayName);
  return {
    marketplaceName: name,
    legalName: profile?.legalName.trim() || name,
    supportEmail: profile?.supportEmail ?? '',
    supportPhone: profile?.supportPhone ?? null,
    timezone: profile?.timezone ?? 'UTC',
  };
}

interface Source {
  kind: 'PAYMENT' | 'REFUND';
  sourceKey: string;
  paymentTransactionId: string;
  refundId: string | null;
  amountMinor: bigint;
  currency: string;
  snapshot: Omit<Snapshot, 'issuer'>;
}

/** The money movement behind a receipt, or a refusal saying why there is none. */
async function loadSource(orderId: string, kind: ReceiptKind, sourceId: string): Promise<Source> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { orderNumber: true } });
  if (order === null) throw notFound('Order');

  if (kind === 'payment') {
    const payment = await prisma.paymentTransaction.findFirst({ where: { id: sourceId, orderId } });
    if (payment === null) throw notFound('Payment');
    if (payment.status !== 'CAPTURED' || payment.capturedAt === null) {
      throw conflict(
        ErrorCode.RECEIPT_NOT_AVAILABLE,
        'This payment has not been completed, so there is no receipt for it yet.',
      );
    }
    return {
      kind: 'PAYMENT',
      sourceKey: `payment:${payment.id}`,
      paymentTransactionId: payment.id,
      refundId: null,
      amountMinor: payment.capturedMinor > 0n ? payment.capturedMinor : payment.amountMinor,
      currency: payment.currency,
      snapshot: {
        orderNumber: order.orderNumber,
        occurredAt: payment.capturedAt.toISOString(),
        method: payment.method,
        cardBrand: payment.cardBrand,
        cardLast4: payment.cardLast4,
        providerReference: payment.providerPaymentId ?? payment.providerOrderId,
        originalPaymentReference: null,
      },
    };
  }

  const refund = await prisma.refund.findFirst({
    where: { id: sourceId, orderId },
    include: { paymentTransaction: true },
  });
  if (refund === null) throw notFound('Refund');
  if (refund.status !== 'SUCCEEDED') {
    throw conflict(
      ErrorCode.RECEIPT_NOT_AVAILABLE,
      'This refund has not been confirmed by the payment provider yet, so there is no receipt for it.',
    );
  }
  return {
    kind: 'REFUND',
    sourceKey: `refund:${refund.id}`,
    paymentTransactionId: refund.paymentTransactionId,
    refundId: refund.id,
    amountMinor: refund.amountMinor,
    currency: refund.currency,
    snapshot: {
      orderNumber: order.orderNumber,
      occurredAt: (refund.completedAt ?? refund.updatedAt).toISOString(),
      method: refund.paymentTransaction.method,
      cardBrand: refund.paymentTransaction.cardBrand,
      cardLast4: refund.paymentTransaction.cardLast4,
      providerReference: refund.providerRefundId,
      originalPaymentReference: refund.paymentTransaction.providerPaymentId,
    },
  };
}

/** Read the receipt row, issuing it (and its number) if this is the first ask. */
export async function issueReceipt(
  orderId: string,
  kind: ReceiptKind,
  sourceId: string,
  actor: { type: 'CUSTOMER' | 'ADMIN'; userId: string; email: string | null },
): Promise<{ id: string; receiptNumber: string; issuedAt: Date; amountMinor: bigint; currency: string; kind: 'PAYMENT' | 'REFUND'; snapshotJson: unknown }> {
  const source = await loadSource(orderId, kind, sourceId);

  const existing = await prisma.paymentReceipt.findUnique({ where: { sourceKey: source.sourceKey } });
  if (existing !== null) return existing;

  const issuer = await issuerNow();
  const issuedAt = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const receiptNumber = await nextReceiptNumber(tx, issuedAt);
      const row = await tx.paymentReceipt.create({
        data: {
          id: newId(),
          receiptNumber,
          kind: source.kind,
          sourceKey: source.sourceKey,
          orderId,
          paymentTransactionId: source.paymentTransactionId,
          refundId: source.refundId,
          amountMinor: source.amountMinor,
          currency: source.currency,
          snapshotJson: { ...source.snapshot, issuer },
          issuedAt,
        },
      });
      await recordAudit(
        {
          action: AuditAction.PAYMENT_RECEIPT_ISSUED,
          resourceType: 'payment_receipt',
          resourceId: row.id,
          actorType: actor.type,
          actorUserId: actor.userId,
          actorEmail: actor.email,
          after: { receiptNumber, kind: source.kind, orderId, amountMinor: source.amountMinor, currency: source.currency },
        },
        tx,
      );
      return row;
    });
  } catch (error) {
    // Somebody else issued it a moment ago. Their number is the number, and
    // this transaction's increment rolled back with it.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return prisma.paymentReceipt.findUniqueOrThrow({ where: { sourceKey: source.sourceKey } });
    }
    throw error;
  }
}

/** Issue if needed, then render in the reader's language. */
export async function renderReceipt(input: {
  orderId: string;
  kind: ReceiptKind;
  sourceId: string;
  language: SupportedLanguage;
  actor: { type: 'CUSTOMER' | 'ADMIN'; userId: string; email: string | null };
}): Promise<{ bytes: Buffer; fileName: string; receiptNumber: string }> {
  const row = await issueReceipt(input.orderId, input.kind, input.sourceId, input.actor);
  const snapshot = snapshotSchema.parse(row.snapshotJson);

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { customerProfile: { select: { fullName: true } } },
  });

  const document: PaymentReceiptDocument = {
    kind: row.kind,
    receiptNumber: row.receiptNumber,
    issuedAt: row.issuedAt,
    orderNumber: snapshot.orderNumber,
    occurredAt: new Date(snapshot.occurredAt),
    amountMinor: row.amountMinor,
    currency: row.currency,
    method: snapshot.method,
    cardBrand: snapshot.cardBrand,
    cardLast4: snapshot.cardLast4,
    providerReference: snapshot.providerReference,
    originalPaymentReference: snapshot.originalPaymentReference,
    payerName: order?.customerProfile.fullName.trim() || null,
    issuer: snapshot.issuer,
  };

  const { bytes } = await renderPaymentReceipt(document, input.language);
  return { bytes, fileName: `${row.receiptNumber}.pdf`, receiptNumber: row.receiptNumber };
}
