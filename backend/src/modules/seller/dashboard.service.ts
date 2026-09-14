/**
 * The seller's home screen, from live data.
 *
 * Nothing here is hard-coded and nothing is sampled - the brief says "Use live
 * API data. Do not hard-code dashboard numbers", and the reason a marketplace
 * dashboard in particular must obey that is that sellers make stocking and
 * pricing decisions from it. A plausible-looking placeholder is worse than an
 * empty state, because an empty state gets fixed.
 *
 * Every figure comes back with the PERIOD it covers. "Sales: £8,600" answers
 * nothing on its own, and two tiles computed over silently different windows is
 * the classic way a dashboard becomes untrustworthy without becoming visibly
 * wrong.
 *
 * PARTIAL ANSWERS ARE ALLOWED
 *
 * The tiles are independent queries and one of them failing does not blank the
 * page: a failed tile comes back as `null` with the reason, and the interface
 * shows that tile as unavailable while the rest render. A dashboard that refuses
 * to load because the analytics table is slow is a dashboard nobody can use to
 * ship today's orders.
 */
import { SellerPermission } from '../../domain/seller-permissions.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { assertSellerPermission, type SellerMembership } from './account.service.js';
import { readOnboarding } from './onboarding.service.js';
import { readPayoutAccount } from './payout.service.js';

/** One status and how many rows carry it. */
interface StatusCount {
  status: string;
  count: number;
}

export type DashboardRange = 'today' | 'week' | 'month' | 'quarter';

function rangeBounds(range: DashboardRange): { from: Date; to: Date; previousFrom: Date } {
  const to = new Date();
  const days = range === 'today' ? 1 : range === 'week' ? 7 : range === 'month' ? 30 : 90;

  const from = new Date(to.getTime() - days * 86_400_000);
  // The same length again, immediately before, so "yesterday's total" and
  // "last month" compare like with like rather than against a calendar period
  // of a different length.
  const previousFrom = new Date(from.getTime() - days * 86_400_000);

  return { from, to, previousFrom };
}

export interface MoneyTile {
  currency: string;
  amountMinor: string;
  previousAmountMinor: string;
}

export interface SellerDashboard {
  range: DashboardRange;
  periodFrom: string;
  periodTo: string;

  /** Orders that have arrived and not yet been accepted. */
  newOrders: number;
  /** Accepted, not yet dispatched - the seller's actual work queue. */
  ordersToDispatch: number;
  /** Past their dispatch deadline. The number that should worry a seller. */
  overdueOrders: number;

  grossSales: MoneyTile | null;
  netEarnings: MoneyTile | null;
  upcomingPayout: { currency: string; amountMinor: string; scheduledFor: string | null } | null;

  returnsOpen: number;
  refundsInPeriod: number;

  activeListings: number;
  listingsNeedingChanges: number;
  listingsInReview: number;
  draftListings: number;

  lowStockSkus: number;
  outOfStockSkus: number;

  /** Null when nothing has been sold yet - which is not a score of zero. */
  qualityScore: number | null;

  documentsExpiringSoon: { id: string; kind: string; expiresOn: string }[];
  closedLocations: { id: string; name: string; reason: string | null }[];

  onboarding: {
    percentComplete: number;
    canSubmit: boolean;
    blockingSteps: { key: string; title: string }[];
  };

  payout: {
    state: string;
    isProviderConfigured: boolean;
    missingConfigurationKey: string | null;
    pendingRequirements: string[];
  };

  /** Which tiles could not be computed, and why. Rendered as "unavailable". */
  unavailable: { tile: string; reason: string }[];
}

/**
 * Run a tile, and let it fail without taking the page down.
 *
 * Errors are logged and named rather than swallowed: a tile that silently
 * returns zero is a tile that tells the seller they made no sales today.
 */
async function tile<T>(
  name: string,
  unavailable: { tile: string; reason: string }[],
  fallback: T,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    logger.error({ err: error, tile: name }, 'Seller dashboard tile failed');
    unavailable.push({ tile: name, reason: 'This figure could not be worked out just now.' });
    return fallback;
  }
}

export async function readDashboard(
  membership: SellerMembership,
  range: DashboardRange = 'today',
): Promise<SellerDashboard> {
  assertSellerPermission(membership, SellerPermission.ACCOUNT_READ);

  const sellerAccountId = membership.sellerAccountId;
  const { from, to, previousFrom } = rangeBounds(range);
  const unavailable: { tile: string; reason: string }[] = [];
  const now = new Date();

  const [
    orderCounts,
    overdueOrders,
    sales,
    previousSales,
    upcomingPayout,
    returnsOpen,
    refundsInPeriod,
    offerCounts,
    stockCounts,
    account,
    expiringDocuments,
    closedLocations,
    draftCounts,
    onboarding,
    payout,
  ] = await Promise.all([
    tile('orders', unavailable, [] as StatusCount[], async () => {
      const grouped = await prisma.sellerOrderGroup.groupBy({
        by: ['status'],
        where: { sellerAccountId },
        _count: { _all: true },
      });
      return grouped.map((entry) => ({ status: String(entry.status), count: entry._count._all }));
    }),

    tile('overdue', unavailable, 0, () =>
      prisma.sellerOrderGroup.count({
        where: {
          sellerAccountId,
          dispatchDueAt: { lt: now },
          status: { in: ['NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] },
        },
      }),
    ),

    tile('sales', unavailable, null, () =>
      prisma.sellerOrderGroup.groupBy({
        by: ['currency'],
        where: {
          sellerAccountId,
          createdAt: { gte: from, lte: to },
          // Cancelled groups are excluded from sales, which is the only honest
          // reading: a seller who rejected an order did not sell anything.
          status: { notIn: ['CANCELLED'] },
        },
        _sum: { goodsTotalMinor: true, sellerNetMinor: true },
      }),
    ),

    tile('previousSales', unavailable, null, () =>
      prisma.sellerOrderGroup.groupBy({
        by: ['currency'],
        where: {
          sellerAccountId,
          createdAt: { gte: previousFrom, lt: from },
          status: { notIn: ['CANCELLED'] },
        },
        _sum: { goodsTotalMinor: true, sellerNetMinor: true },
      }),
    ),

    tile('upcomingPayout', unavailable, null, () =>
      prisma.sellerPayout.findFirst({
        where: { sellerAccountId, status: { in: ['PENDING', 'IN_TRANSIT'] } },
        orderBy: { scheduledFor: 'asc' },
        select: { amountMinor: true, currency: true, scheduledFor: true },
      }),
    ),

    tile('returns', unavailable, 0, () =>
      prisma.sellerReturn.count({
        where: { sellerAccountId, status: { in: ['REQUESTED', 'APPROVED', 'RECEIVED'] } },
      }),
    ),

    tile('refunds', unavailable, 0, () =>
      prisma.sellerOrderGroup.count({
        where: { sellerAccountId, status: 'REFUNDED', updatedAt: { gte: from, lte: to } },
      }),
    ),

    tile('listings', unavailable, [] as StatusCount[], async () => {
      const grouped = await prisma.sellerOffer.groupBy({
        by: ['status'],
        where: { sellerAccountId, archivedAt: null },
        _count: { _all: true },
      });
      return grouped.map((entry) => ({ status: String(entry.status), count: entry._count._all }));
    }),

    tile('stock', unavailable, { low: 0, out: 0 }, async () => {
      // Two counts rather than one grouped query: "low" compares two columns,
      // which needs the rows. Bounded by `take` so a seller with 40,000 stock
      // rows does not pull them all to count a tile.
      const [out, candidates] = await Promise.all([
        prisma.sellerOffer.count({
          where: { sellerAccountId, archivedAt: null, status: 'ACTIVE', availableQuantity: { lte: 0 } },
        }),
        prisma.sellerInventory.findMany({
          where: { sellerAccountId, reorderThreshold: { gt: 0 } },
          select: { availableQuantity: true, reorderThreshold: true },
          take: 5000,
        }),
      ]);

      return {
        out,
        low: candidates.filter((row) => row.availableQuantity <= row.reorderThreshold).length,
      };
    }),

    tile('account', unavailable, null, () =>
      prisma.sellerAccount.findUnique({
        where: { id: sellerAccountId },
        select: { qualityScore: true },
      }),
    ),

    tile('documents', unavailable, [] as { id: string; kind: string; expiresOn: Date | null }[], () =>
      prisma.sellerDocument.findMany({
        where: {
          sellerAccountId,
          supersededAt: null,
          expiresOn: { not: null, lte: new Date(Date.now() + 60 * 86_400_000) },
        },
        orderBy: { expiresOn: 'asc' },
        take: 10,
        select: { id: true, kind: true, expiresOn: true },
      }),
    ),

    tile('locations', unavailable, [] as { id: string; name: string; closedReason: string | null }[], () =>
      prisma.sellerLocation.findMany({
        where: { sellerAccountId, archivedAt: null, isOperational: false },
        select: { id: true, name: true, closedReason: true },
        take: 10,
      }),
    ),

    tile('drafts', unavailable, [] as StatusCount[], async () => {
      const grouped = await prisma.sellerListingDraft.groupBy({
        by: ['status'],
        where: { sellerAccountId },
        _count: { _all: true },
      });
      return grouped.map((entry) => ({ status: String(entry.status), count: entry._count._all }));
    }),

    tile('onboarding', unavailable, null, () => readOnboarding(membership)),
    tile('payout', unavailable, null, () => readPayoutAccount(membership)),
  ]);

  const countOf = (rows: StatusCount[], status: string): number =>
    rows.find((entry) => entry.status === status)?.count ?? 0;

  const orderCount = (status: string): number => countOf(orderCounts, status);
  const offerCount = (status: string): number => countOf(offerCounts, status);
  const draftCount = (status: string): number => countOf(draftCounts, status);

  // The seller's own currency, taken from the biggest slice of their sales
  // rather than from a setting. A seller trading in two currencies gets the one
  // they mostly trade in, and the settlements page shows both.
  const primary = (sales ?? []).at(0);
  const previousPrimary = (previousSales ?? []).find(
    (entry) => entry.currency === primary?.currency,
  );

  return {
    range,
    periodFrom: from.toISOString(),
    periodTo: to.toISOString(),

    newOrders: orderCount('NEW'),
    ordersToDispatch:
      orderCount('ACCEPTED') + orderCount('PROCESSING') + orderCount('READY_FOR_DISPATCH'),
    overdueOrders,

    grossSales:
      primary === undefined
        ? null
        : {
            currency: primary.currency,
            amountMinor: (primary._sum.goodsTotalMinor ?? 0n).toString(),
            previousAmountMinor: (previousPrimary?._sum.goodsTotalMinor ?? 0n).toString(),
          },

    netEarnings:
      primary === undefined
        ? null
        : {
            currency: primary.currency,
            amountMinor: (primary._sum.sellerNetMinor ?? 0n).toString(),
            previousAmountMinor: (previousPrimary?._sum.sellerNetMinor ?? 0n).toString(),
          },

    upcomingPayout:
      upcomingPayout === null
        ? null
        : {
            currency: upcomingPayout.currency,
            amountMinor: upcomingPayout.amountMinor.toString(),
            scheduledFor: upcomingPayout.scheduledFor?.toISOString() ?? null,
          },

    returnsOpen,
    refundsInPeriod,

    activeListings: offerCount('ACTIVE'),
    listingsNeedingChanges: offerCount('NEEDS_CHANGES') + draftCount('ACTION_REQUIRED'),
    listingsInReview: draftCount('PENDING_REVIEW'),
    draftListings: draftCount('DRAFT') + draftCount('VALIDATION_FAILED'),

    lowStockSkus: stockCounts.low,
    outOfStockSkus: stockCounts.out,

    qualityScore: account?.qualityScore === null || account === null ? null : Number(account.qualityScore),

    documentsExpiringSoon: expiringDocuments
      .filter((document) => document.expiresOn !== null)
      .map((document) => ({
        id: document.id,
        kind: document.kind,
        expiresOn: (document.expiresOn as Date).toISOString().slice(0, 10),
      })),

    closedLocations: closedLocations.map((location) => ({
      id: location.id,
      name: location.name,
      reason: location.closedReason,
    })),

    onboarding: {
      percentComplete: onboarding?.percentComplete ?? 0,
      canSubmit: onboarding?.canSubmit ?? false,
      blockingSteps: onboarding?.blockingSteps ?? [],
    },

    payout: {
      state: payout?.state ?? 'NOT_STARTED',
      isProviderConfigured: payout?.isProviderConfigured ?? false,
      missingConfigurationKey: payout?.missingConfigurationKey ?? null,
      pendingRequirements: payout?.pendingRequirements ?? [],
    },

    unavailable,
  };
}
