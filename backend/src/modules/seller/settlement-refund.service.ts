/**
 * Carrying a buyer's refund into the sellers' settlements.
 *
 * Called whenever a refund's status becomes final - the provider confirmed it
 * or reported it failed - never when a refund is merely requested. It
 * re-derives each seller's refund figure from every succeeded refund on the
 * order (see `domain/settlement-refunds.ts` for the rule and for what cannot
 * be attributed), then rewrites the estimated settlement from its stored
 * parts. Running it twice for one event changes nothing the second time.
 *
 * The fee and the tax on it are left as they were calculated at confirmation.
 * Whether a refund should give a seller part of the fee back is a finance
 * policy question this does not answer on their behalf.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { estimatedSettlement } from '../../domain/platform-fee.js';
import { serialiseMoney } from '../../domain/money.js';
import { attributeRefundsToSellers } from '../../domain/settlement-refunds.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { notifySeller } from './notification.service.js';

type Tx = Prisma.TransactionClient;

export interface SettlementRefundSync {
  /** Settlement rows whose refund figure changed. */
  updated: number;
  /** Refunded money no single seller could be charged with. */
  unattributedMinor: bigint;
}

/** Re-derive the refund figure on every seller settlement of one order. */
export async function syncSettlementRefunds(orderId: string, tx: Tx): Promise<SettlementRefundSync> {
  // Serialise against another refund on the same order settling at the same
  // moment: both read the sum of succeeded refunds, and the second must see
  // the first.
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${orderId} FOR UPDATE`;

  const settlements = await tx.sellerOrderSettlement.findMany({
    where: { sellerOrderGroup: { orderId } },
    select: {
      id: true,
      sellerOrderGroupId: true,
      sellerAccountId: true,
      currency: true,
      grossProceedsMinor: true,
      sellerDeliveryProceedsMinor: true,
      platformFeeMinor: true,
      platformFeeTaxMinor: true,
      refundsAdjustmentsMinor: true,
      sellerOrderGroup: { select: { sellerOrderNumber: true } },
    },
  });
  if (settlements.length === 0) return { updated: 0, unattributedMinor: 0n };

  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { orderNumber: true, currency: true, paidMinor: true, grandTotalMinor: true },
  });
  const succeeded = await tx.refund.aggregate({
    where: { orderId, status: 'SUCCEEDED', currency: order.currency },
    _sum: { amountMinor: true },
  });
  const operatorLineCount = await tx.orderItem.count({ where: { orderId, sellerOfferId: null } });

  const attribution = attributeRefundsToSellers({
    succeededRefundsMinor: succeeded._sum.amountMinor ?? 0n,
    paidMinor: order.paidMinor,
    grandTotalMinor: order.grandTotalMinor,
    operatorLineCount,
    groups: settlements.map((row) => ({
      id: row.sellerOrderGroupId,
      proceedsMinor: row.grossProceedsMinor + row.sellerDeliveryProceedsMinor,
    })),
  });

  if (attribution.basis === 'AMBIGUOUS') {
    logger.warn(
      { orderId, orderNumber: order.orderNumber, unattributedMinor: attribution.unattributedMinor.toString() },
      'a partial refund on an order shared between sellers names no lines; no seller settlement was changed',
    );
    return { updated: 0, unattributedMinor: attribution.unattributedMinor };
  }

  let updated = 0;
  for (const row of settlements) {
    const refunds = attribution.byGroup.get(row.sellerOrderGroupId) ?? 0n;
    if (refunds === row.refundsAdjustmentsMinor) continue;

    const estimated = estimatedSettlement({
      goodsMinor: row.grossProceedsMinor,
      sellerDeliveryMinor: row.sellerDeliveryProceedsMinor,
      platformFeeMinor: row.platformFeeMinor,
      platformFeeTaxMinor: row.platformFeeTaxMinor,
      refundsAdjustmentsMinor: refunds,
    });
    await tx.sellerOrderSettlement.update({
      where: { id: row.id },
      data: { refundsAdjustmentsMinor: refunds, estimatedSettlementMinor: estimated },
    });
    updated += 1;

    await notifySeller({
      sellerAccountId: row.sellerAccountId,
      kind: 'SETTLEMENT_CALCULATED',
      title: `Settlement updated for ${row.sellerOrderGroup.sellerOrderNumber}`,
      body: `A refund to the buyer brings refunds on this order to ${serialiseMoney(refunds, row.currency).formatted}. Estimated settlement is now ${serialiseMoney(estimated, row.currency).formatted}.`,
      linkPath: `/seller/orders/${row.sellerOrderGroupId}`,
      severity: 'INFO',
      subjectType: 'seller_order_group',
      subjectId: row.sellerOrderGroupId,
      dedupeKey: `settlement-refund:${row.sellerOrderGroupId}:${refunds.toString()}`,
      tx,
    });
  }

  return { updated, unattributedMinor: 0n };
}

/** The same, in its own transaction. */
export async function syncSettlementRefundsFor(orderId: string): Promise<SettlementRefundSync> {
  return prisma.$transaction((tx) => syncSettlementRefunds(orderId, tx));
}
