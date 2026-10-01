/**
 * Seller performance: how well this seller converts, delivers and holds up on
 * quality, over a window the seller picks.
 *
 * Every rate is returned as a numerator and a denominator, never as a
 * percentage. A rate over nothing is not zero - "0% on-time" for a seller who
 * delivered nothing is a lie - and the screen renders a dash when the
 * denominator is zero. Each figure also says exactly what it counts, because a
 * metric whose definition the reader has to guess is a metric they cannot act
 * on.
 *
 * Definitions (all scoped to this seller, all over the window):
 *
 *   - RFQ conversion: of the requests for quotation this seller was invited to
 *     in the window, how many they quoted, and how many of those quotes became
 *     a purchase order. Conversion is purchase orders / quotes.
 *   - Order fulfilment rate: orders placed in the window that were delivered,
 *     out of those not cancelled.
 *   - On time: orders delivered in the window, on or before the latest
 *     delivery date the buyer was promised at checkout. Orders with no promised
 *     date are counted separately and left out of the rate.
 *   - In full: delivered in the window with no return raised against it.
 *   - OTIF: both of the above on the same order.
 *   - Dispatch on time: dispatched in the window by the dispatch deadline.
 *   - Return rate: orders delivered in the window that have a return.
 *   - Inspection fail rate: inspection reports signed in the window that
 *     failed, out of all signed.
 *   - Cancellations: orders placed in the window that were cancelled.
 *   - Claims: buyer claims (disputes of kind CLAIM) opened in the window;
 *     chargebacks are counted apart because the seller did not start them.
 */
import { SellerPermission } from '../../domain/seller-permissions.js';
import { prisma } from '../../infra/prisma.js';
import { assertSellerPermission, type SellerMembership } from './account.service.js';

/** A rate, as the two counts it is made of. */
export interface Ratio {
  numerator: number;
  denominator: number;
}

export interface SellerPerformance {
  days: number;
  periodFrom: string;
  periodTo: string;

  rfq: { invited: number; quoted: number; won: number; conversion: Ratio; quoteRate: Ratio };
  orders: {
    placed: number;
    cancelled: number;
    delivered: number;
    fulfilmentRate: Ratio;
    cancellationRate: Ratio;
  };
  delivery: {
    deliveredInPeriod: number;
    withoutPromisedDate: number;
    onTime: Ratio;
    inFull: Ratio;
    otif: Ratio;
    dispatchOnTime: Ratio;
  };
  quality: {
    returns: number;
    returnRate: Ratio;
    inspectionsSigned: number;
    inspectionsFailed: number;
    inspectionFailRate: Ratio;
    openNcrs: number;
  };
  claims: { opened: number; open: number; chargebacks: number; claimRate: Ratio };
}

export const PERFORMANCE_WINDOWS = [30, 90, 365] as const;
export type PerformanceWindow = (typeof PERFORMANCE_WINDOWS)[number];

/** Bounded so a seller with a very large history cannot make one page scan it all. */
const ROW_CAP = 20_000;

const OPEN_CLAIM_STATUSES = [
  'AWAITING_SELLER',
  'UNDER_REVIEW',
  'PENDING_APPROVAL',
  'APPEALED',
] as const;

const ratio = (numerator: number, denominator: number): Ratio => ({ numerator, denominator });

/** The end of the promised day: a promise of "by the 12th" is kept on the 12th. */
function endOfDay(date: Date): Date {
  return new Date(date.getTime() + 86_400_000 - 1);
}

export async function readPerformance(
  membership: SellerMembership,
  days: PerformanceWindow = 90,
): Promise<SellerPerformance> {
  assertSellerPermission(membership, SellerPermission.ANALYTICS_READ);

  const sellerAccountId = membership.sellerAccountId;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  const window = { gte: from, lte: to };

  const [invitations, placedGroups, deliveredGroups, dispatchedGroups, signedReports, openNcrs, claims] =
    await Promise.all([
      prisma.rfqInvitation.findMany({
        where: { sellerAccountId, invitedAt: window },
        select: { rfqId: true },
        take: ROW_CAP,
      }),
      prisma.sellerOrderGroup.groupBy({
        by: ['status'],
        where: { sellerAccountId, createdAt: window },
        _count: { _all: true },
      }),
      prisma.sellerOrderGroup.findMany({
        where: { sellerAccountId, deliveredAt: window },
        select: {
          deliveredAt: true,
          order: { select: { fulfilmentDeliveryTo: true } },
          _count: { select: { returnRequests: true } },
        },
        take: ROW_CAP,
      }),
      prisma.sellerOrderGroup.findMany({
        where: { sellerAccountId, dispatchedAt: window, dispatchDueAt: { not: null } },
        select: { dispatchedAt: true, dispatchDueAt: true },
        take: ROW_CAP,
      }),
      prisma.inspectionReport.groupBy({
        by: ['result'],
        where: { status: 'SIGNED', signedAt: window, job: { requirement: { sellerAccountId } } },
        _count: { _all: true },
      }),
      prisma.inspectionDefect.count({
        where: { status: 'OPEN', job: { requirement: { sellerAccountId } } },
      }),
      prisma.dispute.groupBy({
        by: ['kind', 'status'],
        where: { sellerAccountId, createdAt: window },
        _count: { _all: true },
      }),
    ]);

  // RFQ conversion, over the invitations received in the window.
  const rfqIds = invitations.map((row) => row.rfqId);
  const [quoted, won] =
    rfqIds.length === 0
      ? [0, 0]
      : await Promise.all([
          prisma.rfqQuote.count({ where: { sellerAccountId, rfqId: { in: rfqIds } } }),
          prisma.rfqPurchaseOrder.count({ where: { sellerAccountId, rfqId: { in: rfqIds } } }),
        ]);

  // Orders placed in the window.
  const byStatus = new Map(placedGroups.map((row) => [String(row.status), row._count._all]));
  const placed = placedGroups.reduce((sum, row) => sum + row._count._all, 0);
  const cancelled = byStatus.get('CANCELLED') ?? 0;
  const reachedBuyer = [
    'DELIVERED',
    'RETURN_REQUESTED',
    'RETURNED',
    'REFUNDED',
    'DISPUTED',
  ].reduce((sum, status) => sum + (byStatus.get(status) ?? 0), 0);

  // Delivered in the window: on time, in full, both.
  let promised = 0;
  let onTime = 0;
  let inFull = 0;
  let otif = 0;
  let returned = 0;
  for (const group of deliveredGroups) {
    const isInFull = group._count.returnRequests === 0;
    if (isInFull) inFull += 1;
    else returned += 1;
    const promise = group.order.fulfilmentDeliveryTo;
    if (promise === null || group.deliveredAt === null) continue;
    promised += 1;
    const isOnTime = group.deliveredAt.getTime() <= endOfDay(promise).getTime();
    if (isOnTime) onTime += 1;
    if (isOnTime && isInFull) otif += 1;
  }
  const delivered = deliveredGroups.length;

  const dispatchedOnTime = dispatchedGroups.filter(
    (group) =>
      group.dispatchedAt !== null &&
      group.dispatchDueAt !== null &&
      group.dispatchedAt.getTime() <= group.dispatchDueAt.getTime(),
  ).length;

  const passed = signedReports.find((row) => row.result === 'PASS')?._count._all ?? 0;
  const failed = signedReports.find((row) => row.result === 'FAIL')?._count._all ?? 0;

  let claimsOpened = 0;
  let claimsOpen = 0;
  let chargebacks = 0;
  for (const row of claims) {
    if (row.kind === 'CHARGEBACK') {
      chargebacks += row._count._all;
      continue;
    }
    claimsOpened += row._count._all;
    if ((OPEN_CLAIM_STATUSES as readonly string[]).includes(row.status)) {
      claimsOpen += row._count._all;
    }
  }

  return {
    days,
    periodFrom: from.toISOString(),
    periodTo: to.toISOString(),
    rfq: {
      invited: invitations.length,
      quoted,
      won,
      conversion: ratio(won, quoted),
      quoteRate: ratio(quoted, invitations.length),
    },
    orders: {
      placed,
      cancelled,
      delivered: reachedBuyer,
      fulfilmentRate: ratio(reachedBuyer, placed - cancelled),
      cancellationRate: ratio(cancelled, placed),
    },
    delivery: {
      deliveredInPeriod: delivered,
      withoutPromisedDate: delivered - promised,
      onTime: ratio(onTime, promised),
      inFull: ratio(inFull, delivered),
      otif: ratio(otif, promised),
      dispatchOnTime: ratio(dispatchedOnTime, dispatchedGroups.length),
    },
    quality: {
      returns: returned,
      returnRate: ratio(returned, delivered),
      inspectionsSigned: passed + failed,
      inspectionsFailed: failed,
      inspectionFailRate: ratio(failed, passed + failed),
      openNcrs,
    },
    claims: {
      opened: claimsOpened,
      open: claimsOpen,
      chargebacks,
      claimRate: ratio(claimsOpened, placed),
    },
  };
}
