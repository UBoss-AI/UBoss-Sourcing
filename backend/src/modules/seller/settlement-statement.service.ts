/**
 * Seller settlement statements: closing a period into one statement per seller
 * and currency.
 *
 * Off unless the operator turns it on (FEATURE_SELLER_SETTLEMENT_STATEMENTS).
 * What a period is (SELLER_SETTLEMENT_PERIOD) and when a delivered order
 * counts (SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS, the return window, which has
 * no default) are the operator's commercial policy, so they are settings. A
 * statement is arithmetic: it records what was earned and what was kept, and
 * moves no money. Payouts are a separate, unconfigured decision (D13), and a
 * statement closed here is PENDING_PAYOUT, which `createPayout` still refuses
 * while no payout provider exists.
 *
 * WHERE THE FIGURES COME FROM. Every amount is copied from the order's
 * `SellerOrderSettlement`, which was calculated once, when the order was
 * confirmed, and whose refunds are re-derived by `syncSettlementRefunds`.
 * Nothing is recalculated here - a second implementation of "what a seller is
 * owed" is how two screens come to disagree about the same order.
 *
 * WHAT A STATEMENT HOLDS, per seller order:
 *
 *   SALE              + goods proceeds
 *   SHIPPING_CHARGE   + delivery the seller controlled and was paid for
 *   COMMISSION        - the platform fee
 *   COMMISSION        - tax on the platform fee
 *   REFUND            - refunds recorded since the order was last on a
 *                       statement (or + when a refund was later given back)
 *
 * Each order is SOLD on exactly one statement. Refunds that arrive after that
 * statement are carried on the next one, as the difference between what the
 * order's settlement now says and what earlier statements already deducted, so
 * a refund is never deducted twice and never lost.
 *
 * The header identity the schema promises holds by construction and is
 * checked before anything is written:
 *
 *     gross - commission - processingFee - refunds + adjustments = net
 *
 * with gross = goods + seller delivery, commission = fee + tax on the fee,
 * refunds = new refunds, adjustments = refunds given back. Tax and shipping
 * header columns stay 0 (the seller's delivery is inside gross, and its own
 * line), which is what makes the data-validation query's longer form of the
 * same identity (scripts/db/validate-data.sql) agree with it.
 *
 * IDEMPOTENT, TWICE OVER. `uq_seller_settlement_period_currency` allows one
 * statement per seller, period and currency, so a retried or concurrent close
 * of the same period collides instead of duplicating. And the orders going on
 * a statement are locked (`FOR UPDATE`) and re-checked inside its
 * transaction, so a close of one period and a late close of the previous one
 * cannot both sell the same order.
 *
 * Line descriptions are the seller order number and nothing else, because the
 * statement is read in eight languages: the Seller Hub labels each line by its
 * kind, translated, and the number is the same in all of them.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

type Tx = Prisma.TransactionClient;

export interface SettlementPeriod {
  start: Date;
  end: Date;
}

/**
 * The most recent period that has fully ended by `now`, in UTC.
 *
 * MONTHLY runs 1st 00:00 to the next 1st 00:00; WEEKLY runs Monday 00:00 to
 * the next Monday 00:00. The end is exclusive, which is what makes
 * `periodEnd > periodStart` true and adjacent periods share no instant.
 */
export function lastClosedPeriod(now: Date, period: 'WEEKLY' | 'MONTHLY'): SettlementPeriod {
  if (period === 'MONTHLY') {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 1, 1));
    return { start, end };
  }
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  const end = new Date(midnight - sinceMonday * 86_400_000);
  const start = new Date(end.getTime() - 7 * 86_400_000);
  return { start, end };
}

export interface CloseOutcome {
  skipped: boolean;
  period: SettlementPeriod | null;
  statementsCreated: number;
  alreadyClosed: number;
  ordersSold: number;
}

interface Candidate {
  groupId: string;
  sellerAccountId: string;
  sellerOrderNumber: string;
  currency: string;
  deliveredAt: Date | null;
}

/** Close the last finished period. Safe to call any number of times. */
export async function closeSettlementPeriod(now: Date = new Date()): Promise<CloseOutcome> {
  if (!env.FEATURE_SELLER_SETTLEMENT_STATEMENTS || env.SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS === undefined) {
    return { skipped: true, period: null, statementsCreated: 0, alreadyClosed: 0, ordersSold: 0 };
  }

  const period = lastClosedPeriod(now, env.SELLER_SETTLEMENT_PERIOD);
  // Delivered at least this long before the period ended, so its return
  // window had closed by then.
  const deliveredBefore = new Date(period.end.getTime() - env.SELLER_SETTLEMENT_PAYABLE_AFTER_DAYS * 86_400_000);

  // Orders ready to be sold on a statement: delivered, past the window, with a
  // settlement record, and never sold on one before. Catching up on older
  // orders is deliberate - an order delivered before the feature was switched
  // on is still owed to its seller.
  const unsold = await prisma.sellerOrderGroup.findMany({
    where: {
      status: 'DELIVERED',
      deliveredAt: { lt: deliveredBefore },
      settlement: { isNot: null },
      settlementLines: { none: { kind: 'SALE' } },
    },
    select: { id: true, sellerAccountId: true, sellerOrderNumber: true, currency: true, deliveredAt: true },
  });

  // Orders already sold whose refunds may have moved since.
  const sold = await prisma.sellerOrderGroup.findMany({
    where: { settlementLines: { some: { kind: 'SALE' } }, settlement: { isNot: null } },
    select: { id: true, sellerAccountId: true, sellerOrderNumber: true, currency: true, deliveredAt: true },
  });

  const bySellerCurrency = new Map<string, { unsold: Candidate[]; sold: Candidate[] }>();
  const bucket = (row: Candidate) => {
    const key = `${row.sellerAccountId}|${row.currency}`;
    let entry = bySellerCurrency.get(key);
    if (entry === undefined) bySellerCurrency.set(key, (entry = { unsold: [], sold: [] }));
    return entry;
  };
  for (const row of unsold) bucket({ ...row, groupId: row.id }).unsold.push({ ...row, groupId: row.id });
  for (const row of sold) bucket({ ...row, groupId: row.id }).sold.push({ ...row, groupId: row.id });

  const outcome: CloseOutcome = { skipped: false, period, statementsCreated: 0, alreadyClosed: 0, ordersSold: 0 };

  for (const [key, groups] of bySellerCurrency) {
    const [sellerAccountId, currency] = key.split('|') as [string, string];
    try {
      const result = await prisma.$transaction((tx) =>
        writeStatement(tx, { sellerAccountId, currency, period, now, ...groups }),
      );
      if (result === 'EXISTS') outcome.alreadyClosed += 1;
      else if (result !== 'NOTHING') {
        outcome.statementsCreated += 1;
        outcome.ordersSold += result.ordersSold;
      }
    } catch (error) {
      // A concurrent close of the same period won the unique key: that
      // statement is the one, and this is not a failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        outcome.alreadyClosed += 1;
        continue;
      }
      throw error;
    }
  }

  logger.info(
    { periodStart: period.start, periodEnd: period.end, ...outcome, period: undefined },
    'seller settlement period closed',
  );
  return outcome;
}

async function writeStatement(
  tx: Tx,
  input: {
    sellerAccountId: string;
    currency: string;
    period: SettlementPeriod;
    now: Date;
    unsold: Candidate[];
    sold: Candidate[];
  },
): Promise<'EXISTS' | 'NOTHING' | { ordersSold: number }> {
  const existing = await tx.sellerSettlement.findFirst({
    where: {
      sellerAccountId: input.sellerAccountId,
      currency: input.currency,
      periodStart: input.period.start,
      periodEnd: input.period.end,
    },
    select: { id: true },
  });
  if (existing !== null) return 'EXISTS';

  const ids = [...input.unsold, ...input.sold].map((row) => row.groupId);
  if (ids.length === 0) return 'NOTHING';

  // Lock these orders' settlement rows for the rest of the transaction, then
  // re-read what has already been put on a statement. A second close that got
  // here first has committed by the time this lock is granted.
  await tx.$queryRaw`SELECT id FROM seller_order_settlements WHERE sellerOrderGroupId IN (${Prisma.join(ids)}) FOR UPDATE`;

  const settlements = await tx.sellerOrderSettlement.findMany({
    where: { sellerOrderGroupId: { in: ids } },
    select: {
      sellerOrderGroupId: true,
      grossProceedsMinor: true,
      sellerDeliveryProceedsMinor: true,
      platformFeeMinor: true,
      platformFeeTaxMinor: true,
      refundsAdjustmentsMinor: true,
    },
  });
  const settlementOf = new Map(settlements.map((row) => [row.sellerOrderGroupId, row]));

  const earlier = await tx.sellerSettlementLine.findMany({
    where: { orderGroupId: { in: ids }, kind: { in: ['SALE', 'REFUND'] } },
    select: { orderGroupId: true, kind: true, amountMinor: true },
  });
  const alreadySold = new Set(earlier.filter((line) => line.kind === 'SALE').map((line) => line.orderGroupId));
  const refundsDeducted = new Map<string, bigint>();
  for (const line of earlier) {
    if (line.kind !== 'REFUND' || line.orderGroupId === null) continue;
    refundsDeducted.set(line.orderGroupId, (refundsDeducted.get(line.orderGroupId) ?? 0n) - line.amountMinor);
  }

  const lines: Prisma.SellerSettlementLineCreateManyInput[] = [];
  const settlementId = newId();
  let gross = 0n;
  let commission = 0n;
  let refunds = 0n;
  let adjustments = 0n;
  let ordersSold = 0;
  const line = (group: Candidate, kind: Prisma.SellerSettlementLineCreateManyInput['kind'], amountMinor: bigint, occurredAt: Date) => {
    lines.push({
      id: newId(),
      settlementId,
      orderGroupId: group.groupId,
      kind,
      amountMinor,
      currency: input.currency,
      description: group.sellerOrderNumber,
      occurredAt,
    });
  };

  for (const group of input.unsold) {
    const figures = settlementOf.get(group.groupId);
    // Sold elsewhere meanwhile (the lock above is what makes this answer true).
    if (figures === undefined || alreadySold.has(group.groupId)) continue;
    const at = group.deliveredAt ?? input.now;

    line(group, 'SALE', figures.grossProceedsMinor, at);
    if (figures.sellerDeliveryProceedsMinor !== 0n) line(group, 'SHIPPING_CHARGE', figures.sellerDeliveryProceedsMinor, at);
    line(group, 'COMMISSION', -figures.platformFeeMinor, at);
    if (figures.platformFeeTaxMinor !== 0n) line(group, 'COMMISSION', -figures.platformFeeTaxMinor, at);
    gross += figures.grossProceedsMinor + figures.sellerDeliveryProceedsMinor;
    commission += figures.platformFeeMinor + figures.platformFeeTaxMinor;

    // A refund made before this statement is deducted on it.
    if (figures.refundsAdjustmentsMinor > 0n) {
      line(group, 'REFUND', -figures.refundsAdjustmentsMinor, input.now);
      refunds += figures.refundsAdjustmentsMinor;
    }
    ordersSold += 1;
  }

  for (const group of input.sold) {
    const figures = settlementOf.get(group.groupId);
    if (figures === undefined) continue;
    // What the order's settlement says has been refunded, against what
    // earlier statements already took off. Only the difference is new.
    const delta = figures.refundsAdjustmentsMinor - (refundsDeducted.get(group.groupId) ?? 0n);
    if (delta === 0n) continue;
    line(group, 'REFUND', -delta, input.now);
    if (delta > 0n) refunds += delta;
    else adjustments += -delta; // a refund that failed and was given back
  }

  if (lines.length === 0) return 'NOTHING';

  const net = lines.reduce((sum, entry) => sum + BigInt(entry.amountMinor as bigint), 0n);
  if (gross - commission - refunds + adjustments !== net) {
    // Unreachable by construction; refused rather than written, because a
    // statement that does not add up is a dispute nobody can settle.
    throw new Error(`settlement statement does not add up for seller ${input.sellerAccountId}`);
  }

  await tx.sellerSettlement.create({
    data: {
      id: settlementId,
      sellerAccountId: input.sellerAccountId,
      reference: await nextReference(tx, input.period.start),
      status: 'PENDING_PAYOUT',
      periodStart: input.period.start,
      periodEnd: input.period.end,
      currency: input.currency,
      grossMinor: gross,
      commissionMinor: commission,
      refundsMinor: refunds,
      adjustmentsMinor: adjustments,
      netPayableMinor: net,
      closedAt: input.now,
    },
  });
  await tx.sellerSettlementLine.createMany({ data: lines });

  return { ordersSold };
}

/** `STL-2026-09-0007`: numbered like documents, gapless within the period's month. */
async function nextReference(tx: Tx, periodStart: Date): Promise<string> {
  const month = periodStart.toISOString().slice(0, 7);
  const key = `seller-settlement:${month}`;
  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix: `STL-${month}`, padding: 4 },
  });
  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  return `${sequence.prefix}-${sequence.value.toString().padStart(sequence.padding, '0')}`;
}
