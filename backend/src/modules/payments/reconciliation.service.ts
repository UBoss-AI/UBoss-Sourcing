/**
 * Payment reconciliation (checklist Master row 77).
 *
 * Compares, for every order with money movement in the window, what the order
 * row says was paid and refunded with what the payment and refund ledgers
 * say actually happened: captured transactions and succeeded refunds. A
 * difference means a webhook was missed, applied twice or applied to the
 * wrong order, and is listed for a person to look at. Nothing is corrected
 * here - reconciliation reports, it never writes.
 */
import { prisma } from '../../infra/prisma.js';
import { serialiseMoney } from '../../domain/money.js';

/** How far back to look. Older orders were reconciled when they were current. */
const WINDOW_DAYS = 90;
/** At most this many differences are listed; the count is always complete. */
const LIST_LIMIT = 50;

export interface ReconciliationReport {
  windowDays: number;
  checkedOrders: number;
  mismatchCount: number;
  mismatches: {
    orderId: string;
    orderNumber: string;
    recordedPaid: ReturnType<typeof serialiseMoney>;
    capturedPaid: ReturnType<typeof serialiseMoney>;
    recordedRefunded: ReturnType<typeof serialiseMoney>;
    succeededRefunds: ReturnType<typeof serialiseMoney>;
  }[];
  generatedAt: string;
}

/** The orders whose recorded totals differ from the ledgers. Pure, so it is tested on its own. */
export function findMismatches<T extends { id: string; paidMinor: bigint; refundedMinor: bigint }>(
  orders: readonly T[],
  capturedBy: ReadonlyMap<string, bigint>,
  refundedBy: ReadonlyMap<string, bigint>,
): T[] {
  return orders.filter(
    (order) =>
      (capturedBy.get(order.id) ?? 0n) !== order.paidMinor || (refundedBy.get(order.id) ?? 0n) !== order.refundedMinor,
  );
}

export async function reconcilePayments(now = new Date()): Promise<ReconciliationReport> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const [captured, refunded] = await Promise.all([
    prisma.paymentTransaction.groupBy({
      by: ['orderId'],
      where: { status: 'CAPTURED', capturedAt: { gte: since } },
      _sum: { amountMinor: true },
    }),
    prisma.refund.groupBy({
      by: ['orderId'],
      where: { status: 'SUCCEEDED', createdAt: { gte: since } },
      _sum: { amountMinor: true },
    }),
  ]);
  const capturedBy = new Map(captured.map((row) => [row.orderId, row._sum.amountMinor ?? 0n]));
  const refundedBy = new Map(refunded.map((row) => [row.orderId, row._sum.amountMinor ?? 0n]));

  const orders = await prisma.order.findMany({
    where: {
      OR: [
        { id: { in: [...new Set([...capturedBy.keys(), ...refundedBy.keys()])] } },
        { placedAt: { gte: since }, OR: [{ paidMinor: { gt: 0 } }, { refundedMinor: { gt: 0 } }] },
      ],
    },
    select: { id: true, orderNumber: true, currency: true, paidMinor: true, refundedMinor: true },
    orderBy: { id: 'desc' },
  });

  const mismatches = findMismatches(orders, capturedBy, refundedBy);

  return {
    windowDays: WINDOW_DAYS,
    checkedOrders: orders.length,
    mismatchCount: mismatches.length,
    mismatches: mismatches.slice(0, LIST_LIMIT).map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      recordedPaid: serialiseMoney(order.paidMinor, order.currency),
      capturedPaid: serialiseMoney(capturedBy.get(order.id) ?? 0n, order.currency),
      recordedRefunded: serialiseMoney(order.refundedMinor, order.currency),
      succeededRefunds: serialiseMoney(refundedBy.get(order.id) ?? 0n, order.currency),
    })),
    generatedAt: now.toISOString(),
  };
}
