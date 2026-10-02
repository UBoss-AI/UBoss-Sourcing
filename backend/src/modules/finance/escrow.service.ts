/**
 * Held funds (D13: the operator is a facilitator).
 *
 *   capture  -> the buyer's payment is on the platform balance (PAYMENT_CAPTURED)
 *   allocate -> each seller order's share is HELD for it; the platform's fee
 *               and the tax on it, the tax the buyer paid on top of the
 *               price, the delivery for levels the operator controls and any
 *               discount the platform carries are recognised; the operator's
 *               own goods and shipping get their own entry once the order is
 *               paid in full (SALE_ALLOCATED). Clearing then nets to zero.
 *               Inspection moves no money here: no fee is charged to the
 *               buyer, and an agency's invoice is paid outside the platform.
 *   refund   -> money back to the buyer; the seller's share is reduced by
 *               what the refund attributes to it (REFUND_ISSUED,
 *               REFUND_CHARGED_TO_SELLER)
 *   release  -> when the seller order meets its disclosed terms - delivered,
 *               the acceptance window over, no open dispute, inspection
 *               passed where one is required - the share moves to the
 *               seller's available balance, less any reserve (FUNDS_RELEASED)
 *   payout   -> available money is sent to the seller's Stripe Connect
 *               account (PAYOUT_INITIATED, then PAYOUT_SETTLED, or a
 *               REVERSAL if the provider refuses)
 *
 * Everything here is a sweep that can run twice: each step's ledger entry has
 * an idempotency key derived from what caused it. Nothing here confirms an
 * order - only the signed payment webhook does that; this reads the payment
 * rows it wrote.
 */
import { env } from '../../config/env.js';
import { ErrorCode, conflict, forbidden, notFound } from '../../domain/errors.js';
import type { DisputeStatus, SellerFundHoldStatus } from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { assertPayable, payoutAdapter, PayoutProviderRejectedError } from '../seller/payout.service.js';
import { reconcileLedgerPayouts, unresolvedPayoutWhere, settleLedgerPayout, rejectLedgerPayout, markPayoutUnknown, PAYOUT_UNKNOWN_MESSAGE } from './ledger-payout-recovery.service.js';
import { postEntry, sumLines, total } from './ledger.service.js';

/** Dispute statuses that stop a release. */
export const OPEN_DISPUTE_STATUSES: DisputeStatus[] = [
  'AWAITING_SELLER',
  'UNDER_REVIEW',
  'PENDING_APPROVAL',
  'APPEALED',
  'CHARGEBACK_OPEN',
  'NEEDS_RESPONSE',
  'CHARGEBACK_UNDER_REVIEW',
];

/** Inspection statuses that count as a pass for releasing money. */
const INSPECTION_PASSED = new Set(['NOT_REQUIRED', 'RELEASED', 'RELEASED_CONDITIONALLY', 'DISPATCHED']);

export function assertEscrowEnabled(): void {
  if (!env.FEATURE_ESCROW_LEDGER) {
    throw conflict(ErrorCode.ESCROW_LEDGER_DISABLED, 'Held funds and the transaction ledger are switched off here.');
  }
}

/** The release terms disclosed for new sales, from settings. */
export interface ReleaseTerms {
  requiresDelivery: true;
  releaseAfterDays: number;
  disputeBlocksRelease: true;
  inspectionRequired: boolean;
  reserveBps: number;
  reserveDays: number;
}

export function currentReleaseTerms(inspectionRequired = false): ReleaseTerms {
  return {
    requiresDelivery: true,
    releaseAfterDays: env.SELLER_FUNDS_RELEASE_AFTER_DAYS ?? 0,
    disputeBlocksRelease: true,
    inspectionRequired,
    reserveBps: env.SELLER_FUNDS_RESERVE_BPS,
    reserveDays: env.SELLER_FUNDS_RESERVE_DAYS,
  };
}

function termsOf(json: unknown): ReleaseTerms {
  const value = (json ?? {}) as Partial<ReleaseTerms>;
  return {
    requiresDelivery: true,
    releaseAfterDays: Number(value.releaseAfterDays ?? 0),
    disputeBlocksRelease: true,
    inspectionRequired: value.inspectionRequired === true,
    reserveBps: Number(value.reserveBps ?? 0),
    reserveDays: Number(value.reserveDays ?? 0),
  };
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Capture and allocation
// ---------------------------------------------------------------------------

/** Record an order's captured payments and allocate each seller order's share. Idempotent. */
export async function allocateOrder(orderId: string): Promise<{ captured: number; allocated: number }> {
  return prisma.$transaction(async (tx) => {
    const payments = await tx.paymentTransaction.findMany({
      where: { orderId, status: 'CAPTURED', capturedMinor: { gt: 0n } },
      select: { id: true, capturedMinor: true, currency: true, providerPaymentId: true, capturedAt: true },
    });
    if (payments.length === 0) return { captured: 0, allocated: 0 };

    let captured = 0;
    for (const payment of payments) {
      const result = await postEntry(tx, {
        kind: 'PAYMENT_CAPTURED',
        idempotencyKey: `capture:${payment.id}`,
        currency: payment.currency,
        memo: 'Buyer payment received and held',
        orderId,
        paymentTransactionId: payment.id,
        providerReference: payment.providerPaymentId,
        occurredAt: payment.capturedAt ?? new Date(),
        lines: [
          { code: 'PROVIDER_BALANCE', amountMinor: payment.capturedMinor },
          { code: 'BUYER_FUNDS_CLEARING', amountMinor: -payment.capturedMinor },
        ],
      });
      if (result.created) captured += 1;
    }

    const currencies = new Set(payments.map((payment) => payment.currency));
    const settlements = await tx.sellerOrderSettlement.findMany({
      where: { sellerOrderGroup: { orderId } },
      include: {
        sellerOrderGroup: { select: { id: true, inspectionRequirement: { select: { level: true } } } },
      },
    });

    const order = await tx.order.findUnique({
      where: { id: orderId },
      select: { currency: true, shippingMinor: true, grandTotalMinor: true },
    });
    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: {
        lineTotalMinor: true,
        taxAmountMinor: true,
        taxInclusive: true,
        discountMinor: true,
        sellerOffer: { select: { sellerAccountId: true } },
      },
    });
    const legs = await tx.orderLogisticsLeg.findMany({ where: { orderId }, select: { amountMinor: true } });

    let allocated = 0;
    for (const row of settlements) {
      // A share is only allocated out of money received in its own currency.
      if (!currencies.has(row.currency)) continue;
      const gross = row.grossProceedsMinor + row.sellerDeliveryProceedsMinor;
      const share = gross - row.platformFeeMinor - row.platformFeeTaxMinor;
      const parts = sellerLineParts(items.filter((item) => item.sellerOffer?.sellerAccountId === row.sellerAccountId));
      const result = await postEntry(tx, {
        kind: 'SALE_ALLOCATED',
        idempotencyKey: `allocate:${row.sellerOrderGroupId}`,
        currency: row.currency,
        memo: 'Sale allocated: seller share held; fee, tax and operator delivery recognised',
        orderId,
        sellerOrderGroupId: row.sellerOrderGroupId,
        sellerAccountId: row.sellerAccountId,
        lines: [
          // What the buyer paid for this seller's part leaves clearing...
          { code: 'BUYER_FUNDS_CLEARING', amountMinor: gross + parts.exclusiveTaxMinor + row.ubossDeliveryMinor - parts.discountMinor },
          // ...the seller's share is held...
          { code: 'SELLER_HELD', amountMinor: -share },
          { code: 'PLATFORM_COMMISSION', amountMinor: -row.platformFeeMinor },
          { code: 'PLATFORM_FEE_TAX', amountMinor: -row.platformFeeTaxMinor },
          // ...tax added on top of the price is not the seller's revenue...
          { code: 'ORDER_TAX_COLLECTED', amountMinor: -parts.exclusiveTaxMinor },
          // ...delivery for the levels the operator controls is the operator's...
          { code: 'PLATFORM_LOGISTICS_REVENUE', amountMinor: -row.ubossDeliveryMinor },
          // ...and a discount is carried by the platform: the share above is
          // worked out on the undiscounted price.
          { code: 'PLATFORM_DISCOUNTS_FUNDED', amountMinor: parts.discountMinor },
        ],
      });
      if (!result.created) continue;
      allocated += 1;
      const level = row.sellerOrderGroup.inspectionRequirement?.level ?? 'NOT_REQUIRED';
      await tx.sellerFundHold.create({
        data: {
          id: newId(),
          sellerOrderGroupId: row.sellerOrderGroupId,
          sellerAccountId: row.sellerAccountId,
          orderId,
          currency: row.currency,
          allocatedMinor: share,
          termsJson: currentReleaseTerms(level !== 'NOT_REQUIRED') as never,
        },
      });
    }

    // The operator's own part of the order: its own goods (no seller), the
    // tax on them, and its own shipping charge. Posted once the order is paid
    // in full, so a part-payment is never booked as the operator's revenue.
    if (order !== null && currencies.has(order.currency)) {
      const capturedTotal = payments
        .filter((payment) => payment.currency === order.currency)
        .reduce((sum, payment) => sum + payment.capturedMinor, 0n);
      const own = operatorParts(
        items.filter((item) => item.sellerOffer === null),
        order.shippingMinor,
        legs.reduce((sum, leg) => sum + leg.amountMinor, 0n),
      );
      const ownTotal = own.goodsMinor + own.taxMinor + own.shippingMinor;
      if (capturedTotal >= order.grandTotalMinor && ownTotal > 0n) {
        await postEntry(tx, {
          kind: 'SALE_ALLOCATED',
          idempotencyKey: `allocate-operator:${orderId}`,
          currency: order.currency,
          memo: "Operator's own goods, tax and shipping recognised",
          orderId,
          lines: [
            { code: 'BUYER_FUNDS_CLEARING', amountMinor: ownTotal },
            { code: 'PLATFORM_DIRECT_SALES', amountMinor: -own.goodsMinor },
            { code: 'ORDER_TAX_COLLECTED', amountMinor: -own.taxMinor },
            { code: 'PLATFORM_LOGISTICS_REVENUE', amountMinor: -own.shippingMinor },
          ],
        });
      }
    }

    // Refunds already made before allocation are charged now.
    await chargeSellerRefunds(tx, orderId);
    return { captured, allocated };
  });
}

interface AllocatedItem {
  lineTotalMinor: bigint;
  taxAmountMinor: bigint;
  taxInclusive: boolean;
  discountMinor: bigint;
}

/**
 * The parts of one seller's lines the settlement does not carry.
 *
 * The seller's gross is the undiscounted line subtotal, which already holds
 * any tax-inclusive tax. So what the buyer paid beyond it is the tax added
 * on top (exclusive lines only), less the discount.
 */
export function sellerLineParts(items: readonly AllocatedItem[]): { exclusiveTaxMinor: bigint; discountMinor: bigint } {
  return {
    exclusiveTaxMinor: items.filter((item) => !item.taxInclusive).reduce((sum, item) => sum + item.taxAmountMinor, 0n),
    discountMinor: items.reduce((sum, item) => sum + item.discountMinor, 0n),
  };
}

/**
 * The operator's own part of an order: its goods net of tax, all the tax on
 * them (inclusive or not - the operator is the seller of record), and the
 * shipping charge that is not a seller's delivery level.
 */
export function operatorParts(
  items: readonly AllocatedItem[],
  orderShippingMinor: bigint,
  sellerLegsMinor: bigint,
): { goodsMinor: bigint; taxMinor: bigint; shippingMinor: bigint } {
  const paid = items.reduce((sum, item) => sum + item.lineTotalMinor, 0n);
  const taxMinor = items.reduce((sum, item) => sum + item.taxAmountMinor, 0n);
  const shippingMinor = orderShippingMinor - sellerLegsMinor;
  return { goodsMinor: paid - taxMinor, taxMinor, shippingMinor: shippingMinor > 0n ? shippingMinor : 0n };
}

// ---------------------------------------------------------------------------
// Refunds and chargebacks
// ---------------------------------------------------------------------------

/**
 * Record a refund that has succeeded, then charge each seller the part of it
 * their order carries. `kind` is CHARGEBACK_LOST when the money was taken by
 * a lost chargeback rather than given back by the operator.
 */
export async function recordRefund(
  tx: PrismaTransaction,
  refundId: string,
  kind: 'REFUND_ISSUED' | 'CHARGEBACK_LOST' = 'REFUND_ISSUED',
  disputeId: string | null = null,
): Promise<void> {
  const refund = await tx.refund.findUnique({
    where: { id: refundId },
    select: { id: true, orderId: true, amountMinor: true, currency: true, status: true, providerRefundId: true, completedAt: true },
  });
  if (refund === null || refund.status !== 'SUCCEEDED' || refund.amountMinor <= 0n) return;
  // Either way the money leaves the platform balance and comes out of the
  // buyer's clearing account; what the sellers carry is charged below.
  const lines = [
    { code: 'BUYER_FUNDS_CLEARING' as const, amountMinor: refund.amountMinor },
    { code: 'PROVIDER_BALANCE' as const, amountMinor: -refund.amountMinor },
  ];
  await postEntry(tx, {
    kind,
    idempotencyKey: `refund:${refund.id}`,
    currency: refund.currency,
    memo: kind === 'CHARGEBACK_LOST' ? 'Chargeback lost: money taken back by the card issuer' : 'Refund to buyer',
    orderId: refund.orderId,
    refundId: refund.id,
    disputeId,
    providerReference: refund.providerRefundId,
    occurredAt: refund.completedAt ?? new Date(),
    lines,
  });
  await chargeSellerRefunds(tx, refund.orderId);
}

/**
 * Bring each seller order's refund charge up to what its settlement says it
 * carries (`refundsAdjustmentsMinor`, kept by the refund attribution).
 */
export async function chargeSellerRefunds(tx: PrismaTransaction, orderId: string): Promise<number> {
  const holds = await tx.sellerFundHold.findMany({ where: { orderId } });
  if (holds.length === 0) return 0;
  const settlements = await tx.sellerOrderSettlement.findMany({
    where: { sellerOrderGroupId: { in: holds.map((hold) => hold.sellerOrderGroupId) } },
    select: { sellerOrderGroupId: true, refundsAdjustmentsMinor: true },
  });
  const rows = await sumLines('sellerOrderGroupId', holds.map((hold) => hold.sellerOrderGroupId), tx);
  let written = 0;
  for (const hold of holds) {
    const target = settlements.find((row) => row.sellerOrderGroupId === hold.sellerOrderGroupId)?.refundsAdjustmentsMinor ?? 0n;
    const charged = -total(rows, {
      code: 'BUYER_FUNDS_CLEARING',
      kinds: ['REFUND_CHARGED_TO_SELLER'],
      key: hold.sellerOrderGroupId,
    });
    const delta = target - charged;
    if (delta === 0n) continue;
    const from = hold.status === 'RELEASED' ? 'SELLER_AVAILABLE' : 'SELLER_HELD';
    const result = await postEntry(tx, {
      kind: 'REFUND_CHARGED_TO_SELLER',
      idempotencyKey: `refund-charge:${hold.sellerOrderGroupId}:${target.toString()}`,
      currency: hold.currency,
      memo: 'Refund charged to the seller order',
      orderId,
      sellerOrderGroupId: hold.sellerOrderGroupId,
      sellerAccountId: hold.sellerAccountId,
      lines: [
        { code: from, amountMinor: delta },
        { code: 'BUYER_FUNDS_CLEARING', amountMinor: -delta },
      ],
    });
    if (result.created) written += 1;
  }
  return written;
}

/** Find captured payments and succeeded refunds not yet in the ledger, and post them. */
export async function sweepPaymentsAndRefunds(limit = 500): Promise<{ orders: number; refunds: number }> {
  const payments = await prisma.paymentTransaction.findMany({
    where: { status: 'CAPTURED', capturedMinor: { gt: 0n } },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true, orderId: true },
  });
  const posted = new Set(
    (
      await prisma.ledgerEntry.findMany({
        where: { idempotencyKey: { in: payments.map((row) => `capture:${row.id}`) } },
        select: { paymentTransactionId: true },
      })
    ).map((row) => row.paymentTransactionId),
  );
  const orderIds = [...new Set(payments.filter((row) => !posted.has(row.id)).map((row) => row.orderId))];
  for (const orderId of orderIds) await allocateOrder(orderId);

  const refunds = await prisma.refund.findMany({
    where: { status: 'SUCCEEDED' },
    orderBy: { updatedAt: 'desc' },
    take: limit,
    select: { id: true },
  });
  const done = new Set(
    (
      await prisma.ledgerEntry.findMany({
        where: { idempotencyKey: { in: refunds.map((row) => `refund:${row.id}`) } },
        select: { refundId: true },
      })
    ).map((row) => row.refundId),
  );
  let refundCount = 0;
  for (const refund of refunds) {
    if (done.has(refund.id)) continue;
    await prisma.$transaction(async (tx) => {
      await recordRefund(tx, refund.id);
    });
    refundCount += 1;
  }
  return { orders: orderIds.length, refunds: refundCount };
}

// ---------------------------------------------------------------------------
// Release conditions
// ---------------------------------------------------------------------------

export interface ReleaseCondition {
  key: 'DELIVERED' | 'ACCEPTANCE_WINDOW' | 'NO_OPEN_DISPUTE' | 'INSPECTION_PASSED';
  met: boolean;
  /** When the condition is (or will be) met, where that is a date. */
  at: string | null;
}

async function conditionsFor(
  tx: PrismaTransaction,
  hold: { sellerOrderGroupId: string; orderId: string; termsJson: unknown },
  now: Date,
): Promise<{ conditions: ReleaseCondition[]; openDispute: boolean }> {
  const terms = termsOf(hold.termsJson);
  const group = await tx.sellerOrderGroup.findUnique({
    where: { id: hold.sellerOrderGroupId },
    select: { deliveredAt: true, status: true, inspectionRequirement: { select: { level: true, status: true } } },
  });
  const openDisputes = await tx.dispute.count({
    where: {
      orderId: hold.orderId,
      status: { in: OPEN_DISPUTE_STATUSES },
      OR: [{ sellerOrderGroupId: hold.sellerOrderGroupId }, { sellerOrderGroupId: null }],
    },
  });
  const deliveredAt = group?.deliveredAt ?? null;
  const windowEnds = deliveredAt === null ? null : new Date(deliveredAt.getTime() + terms.releaseAfterDays * DAY_MS);
  const inspection = group?.inspectionRequirement ?? null;
  const inspectionNeeded = terms.inspectionRequired || (inspection !== null && inspection.level !== 'NOT_REQUIRED');
  return {
    openDispute: openDisputes > 0,
    conditions: [
      { key: 'DELIVERED', met: deliveredAt !== null, at: deliveredAt?.toISOString() ?? null },
      { key: 'ACCEPTANCE_WINDOW', met: windowEnds !== null && windowEnds <= now, at: windowEnds?.toISOString() ?? null },
      { key: 'NO_OPEN_DISPUTE', met: openDisputes === 0, at: null },
      {
        key: 'INSPECTION_PASSED',
        met: !inspectionNeeded || (inspection !== null && INSPECTION_PASSED.has(inspection.status)),
        at: null,
      },
    ],
  };
}

/** The seller's held balance for one seller order, as a positive number. */
async function heldFor(tx: PrismaTransaction, groupId: string): Promise<bigint> {
  const rows = await sumLines('sellerOrderGroupId', [groupId], tx);
  return -total(rows, { code: 'SELLER_HELD', key: groupId });
}

async function release(
  tx: PrismaTransaction,
  hold: { id: string; sellerOrderGroupId: string; sellerAccountId: string; orderId: string; currency: string; termsJson: unknown },
  kind: 'AUTOMATIC' | 'MANUAL',
  reason: string | null,
  actorLabel: string,
  now: Date,
  fromStatuses: SellerFundHoldStatus[] = ['HELD'],
): Promise<boolean> {
  const terms = termsOf(hold.termsJson);
  const amount = await heldFor(tx, hold.sellerOrderGroupId);
  const releasable = amount > 0n ? amount : 0n;
  const reserve = (releasable * BigInt(terms.reserveBps)) / 10_000n;
  const claimed = await tx.sellerFundHold.updateMany({
    where: { id: hold.id, status: { in: fromStatuses } },
    data: {
      status: 'RELEASED',
      holdCode: null,
      releasedMinor: releasable - reserve,
      reserveMinor: reserve,
      releaseKind: kind,
      releaseReason: reason,
      releasedAt: now,
      reserveReleaseAt: reserve > 0n ? new Date(now.getTime() + terms.reserveDays * DAY_MS) : null,
    },
  });
  if (claimed.count !== 1) return false;
  if (releasable > 0n) {
    await postEntry(tx, {
      kind: 'FUNDS_RELEASED',
      idempotencyKey: `release:${hold.id}`,
      currency: hold.currency,
      memo: kind === 'AUTOMATIC' ? 'Release terms met' : `Released early: ${reason ?? ''}`,
      actorLabel,
      orderId: hold.orderId,
      sellerOrderGroupId: hold.sellerOrderGroupId,
      sellerAccountId: hold.sellerAccountId,
      occurredAt: now,
      lines: [
        { code: 'SELLER_HELD', amountMinor: releasable },
        { code: 'SELLER_AVAILABLE', amountMinor: -(releasable - reserve) },
        { code: 'SELLER_RESERVE', amountMinor: -reserve },
      ],
    });
  }
  return true;
}

/** Re-check every unreleased hold: dispute holds on and off, and release what is due. */
export async function evaluateHolds(now: Date = new Date()): Promise<{ released: number; onHold: number; reserves: number }> {
  const holds = await prisma.sellerFundHold.findMany({
    where: { status: { in: ['HELD', 'ON_HOLD'] } },
    orderBy: { lastEvaluatedAt: 'asc' },
    take: 500,
  });
  let released = 0;
  let onHold = 0;
  for (const hold of holds) {
    await prisma.$transaction(async (tx) => {
      const { conditions, openDispute } = await conditionsFor(tx, hold, now);
      await tx.sellerFundHold.update({
        where: { id: hold.id },
        data: { conditionsJson: conditions as never, lastEvaluatedAt: now },
      });
      if (openDispute && hold.status === 'HELD') {
        await tx.sellerFundHold.updateMany({
          where: { id: hold.id, status: 'HELD' },
          data: { status: 'ON_HOLD', holdCode: 'DISPUTE', holdReason: 'A dispute is open on this order.', holdPlacedBy: 'System', holdPlacedAt: now },
        });
        onHold += 1;
        return;
      }
      if (!openDispute && hold.status === 'ON_HOLD' && hold.holdCode === 'DISPUTE') {
        await tx.sellerFundHold.updateMany({
          where: { id: hold.id, status: 'ON_HOLD', holdCode: 'DISPUTE' },
          data: { status: 'HELD', holdCode: null, holdReason: null, holdPlacedBy: null, holdPlacedAt: null },
        });
        hold.status = 'HELD';
      }
      if (hold.status === 'HELD' && conditions.every((condition) => condition.met)) {
        if (await release(tx, hold, 'AUTOMATIC', null, 'System', now)) released += 1;
      }
    });
  }

  const due = await prisma.sellerFundHold.findMany({
    where: { status: 'RELEASED', reserveMinor: { gt: 0n }, reserveReleasedAt: null, reserveReleaseAt: { lte: now } },
    take: 500,
  });
  let reserves = 0;
  for (const hold of due) {
    await prisma.$transaction(async (tx) => {
      const claimed = await tx.sellerFundHold.updateMany({
        where: { id: hold.id, reserveReleasedAt: null },
        data: { reserveReleasedAt: now },
      });
      if (claimed.count !== 1) return;
      await postEntry(tx, {
        kind: 'RESERVE_RELEASED',
        idempotencyKey: `reserve:${hold.id}`,
        currency: hold.currency,
        memo: 'Reserve period over',
        orderId: hold.orderId,
        sellerOrderGroupId: hold.sellerOrderGroupId,
        sellerAccountId: hold.sellerAccountId,
        occurredAt: now,
        lines: [
          { code: 'SELLER_RESERVE', amountMinor: hold.reserveMinor },
          { code: 'SELLER_AVAILABLE', amountMinor: -hold.reserveMinor },
        ],
      });
      reserves += 1;
    });
  }
  return { released, onHold, reserves };
}

// ---------------------------------------------------------------------------
// Manual holds and early release (two people)
// ---------------------------------------------------------------------------

export interface StaffActor {
  userId: string;
  label: string;
}

export async function placeManualHold(holdId: string, reason: string, actor: StaffActor): Promise<void> {
  const changed = await prisma.sellerFundHold.updateMany({
    where: { id: holdId, status: 'HELD' },
    data: { status: 'ON_HOLD', holdCode: 'MANUAL', holdReason: reason, holdPlacedBy: actor.label, holdPlacedAt: new Date() },
  });
  if (changed.count === 1) return;
  if ((await prisma.sellerFundHold.count({ where: { id: holdId } })) === 0) throw notFound('Held funds');
  throw conflict(ErrorCode.FUND_HOLD_STATE_CONFLICT, 'Only money that is still held can be put on hold.');
}

export async function liftManualHold(holdId: string): Promise<void> {
  const changed = await prisma.sellerFundHold.updateMany({
    where: { id: holdId, status: 'ON_HOLD', holdCode: 'MANUAL' },
    data: { status: 'HELD', holdCode: null, holdReason: null, holdPlacedBy: null, holdPlacedAt: null },
  });
  if (changed.count === 1) return;
  if ((await prisma.sellerFundHold.count({ where: { id: holdId } })) === 0) throw notFound('Held funds');
  throw conflict(
    ErrorCode.FUND_HOLD_STATE_CONFLICT,
    'Only a hold placed by staff can be lifted here. A dispute hold lifts itself when the dispute closes.',
  );
}

export async function requestEarlyRelease(holdId: string, reason: string, actor: StaffActor): Promise<{ id: string }> {
  const hold = await prisma.sellerFundHold.findUnique({ where: { id: holdId } });
  if (hold === null) throw notFound('Held funds');
  if (hold.status === 'RELEASED' || hold.holdCode === 'DISPUTE') {
    throw conflict(ErrorCode.FUND_HOLD_STATE_CONFLICT, 'Money released already, or held by an open dispute, cannot be released early.');
  }
  const id = newId();
  try {
    await prisma.sellerFundReleaseRequest.create({
      data: {
        id,
        fundHoldId: holdId,
        sellerOrderGroupId: hold.sellerOrderGroupId,
        reason,
        requestedById: actor.userId,
        requestedByLabel: actor.label,
        requestedAt: new Date(),
        pendingKey: holdId,
      },
    });
  } catch (error) {
    if ((error as { code?: string }).code === 'P2002') {
      throw conflict(ErrorCode.FUND_RELEASE_ALREADY_PENDING, 'An early release is already waiting for a decision.');
    }
    throw error;
  }
  return { id };
}

export async function decideEarlyRelease(
  requestId: string,
  approve: boolean,
  note: string | null,
  actor: StaffActor,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const request = await tx.sellerFundReleaseRequest.findUnique({ where: { id: requestId } });
    if (request === null) throw notFound('Release request');
    if (request.status !== 'PENDING') {
      throw conflict(ErrorCode.FUND_HOLD_STATE_CONFLICT, 'This request has already been decided.');
    }
    if (request.requestedById === actor.userId) {
      throw forbidden(ErrorCode.FUND_RELEASE_SAME_APPROVER, 'A different member of staff must approve this release.');
    }
    const decided = await tx.sellerFundReleaseRequest.updateMany({
      where: { id: requestId, status: 'PENDING' },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        decidedById: actor.userId,
        decidedByLabel: actor.label,
        decidedAt: new Date(),
        decisionNote: note,
        pendingKey: null,
      },
    });
    if (decided.count !== 1 || !approve) return;
    const hold = await tx.sellerFundHold.findUniqueOrThrow({ where: { id: request.fundHoldId } });
    if (hold.holdCode === 'DISPUTE') {
      throw conflict(ErrorCode.FUND_HOLD_STATE_CONFLICT, 'A dispute opened since the request; the money stays held.');
    }
    const done = await release(tx, hold, 'MANUAL', request.reason, actor.label, new Date(), ['HELD', 'ON_HOLD']);
    if (!done) throw conflict(ErrorCode.FUND_HOLD_STATE_CONFLICT, 'This money has already been released.');
  });
}

// ---------------------------------------------------------------------------
// Payouts to connected accounts
// ---------------------------------------------------------------------------

export interface PayoutRunResult {
  paid: { sellerAccountId: string; payoutId: string; amountMinor: string; currency: string }[];
  failed: { sellerAccountId: string; payoutId: string; reason: string }[];
  skipped: { sellerAccountId: string; reason: string }[];
}

/** Send every seller's available balance to their connected account. */
export async function runPayouts(actorLabel = 'System', onlySellerAccountId?: string): Promise<PayoutRunResult> {
  const result: PayoutRunResult = { paid: [], failed: [], skipped: [] };
  const accounts = await prisma.ledgerAccount.findMany({
    where: { code: 'SELLER_AVAILABLE', ...(onlySellerAccountId !== undefined ? { sellerAccountId: onlySellerAccountId } : {}) },
    select: { id: true, sellerAccountId: true, currency: true },
  });
  const adapter = payoutAdapter();
  for (const account of accounts) {
    const sellerAccountId = account.sellerAccountId;
    if (sellerAccountId === null) continue;
    // Reconcile before eligibility: a disabled account may still have received
    // the original transfer. Never submit an unresolved operation again.
    const recovery = await reconcileLedgerPayouts(sellerAccountId, account.currency, adapter, actorLabel);
    result.paid.push(...recovery.paid);
    result.failed.push(...recovery.failed);
    if (recovery.unresolved > 0) {
      result.skipped.push({ sellerAccountId, reason: PAYOUT_UNKNOWN_MESSAGE });
      continue;
    }
    // A confirmed failure releases funds, but a new send requires a later run.
    if (recovery.paid.length > 0 || recovery.failed.length > 0) continue;
    try {
      await assertPayable(sellerAccountId);
    } catch (error) {
      result.skipped.push({ sellerAccountId, reason: (error as Error).message });
      continue;
    }
    const reference = await prisma.sellerPayoutAccountReference.findUniqueOrThrow({
      where: { sellerAccountId }, select: { providerAccountId: true },
    });
    const claim = await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM ledger_accounts WHERE id = ${account.id} FOR UPDATE`;
      // Recheck under the account lock: concurrent callers cannot mint another
      // business key while the first request is in flight or unknown.
      if (await tx.sellerPayout.count({ where: unresolvedPayoutWhere(sellerAccountId, account.currency) }) > 0) return null;
      const sum = await tx.ledgerLine.aggregate({ where: { accountId: account.id }, _sum: { amountMinor: true } });
      const available = -(sum._sum.amountMinor ?? 0n);
      if (available <= 0n) return null;
      const payoutId = newId();
      const ref = `PO-${payoutId}`;
      const key = `ledger-payout:${payoutId}`;
      await tx.sellerPayout.create({ data: {
        id: payoutId, sellerAccountId, reference: ref, status: 'PENDING', providerStatusRaw: 'SUBMITTING',
        amountMinor: available, currency: account.currency, provider: adapter.name, idempotencyKey: key, scheduledFor: new Date(),
      } });
      await postEntry(tx, {
        kind: 'PAYOUT_INITIATED', idempotencyKey: `payout:${payoutId}`, currency: account.currency,
        memo: `Payout ${ref} to the seller's connected account`, actorLabel, sellerAccountId, payoutId,
        lines: [{ code: 'SELLER_AVAILABLE', amountMinor: available }, { code: 'PAYOUTS_IN_TRANSIT', amountMinor: -available }],
      });
      await tx.sellerFundHold.updateMany({
        where: { sellerAccountId, currency: account.currency, status: 'RELEASED', payoutId: null }, data: { payoutId },
      });
      return { payoutId, ref, available, key };
    });
    if (claim === null) continue;
    let providerAccepted = false;
    try {
      const sent = await adapter.sendPayout({
        providerAccountId: reference.providerAccountId ?? '', amountMinor: claim.available,
        currency: account.currency, idempotencyKey: claim.key, reference: claim.ref,
      });
      providerAccepted = true;
      const changed = await prisma.$transaction(tx => settleLedgerPayout(tx, claim.payoutId, sent, actorLabel));
      if (changed) result.paid.push({ sellerAccountId, payoutId: claim.payoutId, amountMinor: claim.available.toString(), currency: account.currency });
    } catch (error) {
      const definitive = !providerAccepted && error instanceof PayoutProviderRejectedError;
      const reason = definitive ? error.message.slice(0, 500) : PAYOUT_UNKNOWN_MESSAGE;
      logger.warn({ sellerAccountId, payoutId: claim.payoutId, definitive }, 'seller payout attempt requires recovery');
      if (definitive) await prisma.$transaction(tx => rejectLedgerPayout(tx, claim.payoutId, reason, actorLabel));
      else await markPayoutUnknown(claim.payoutId);
      // This reports a failed ATTEMPT. An unknown payout itself stays PENDING.
      result.failed.push({ sellerAccountId, payoutId: claim.payoutId, reason });
    }
  }
  return result;
}

/** One pass of the worker: post, evaluate, release, and pay when automatic payouts are on. */
export async function runEscrowSweep(now: Date = new Date()): Promise<void> {
  if (!env.FEATURE_ESCROW_LEDGER) return;
  await sweepPaymentsAndRefunds();
  await evaluateHolds(now);
  if (env.SELLER_FUNDS_AUTO_PAYOUT && payoutAdapter().isConfigured) await runPayouts();
}
