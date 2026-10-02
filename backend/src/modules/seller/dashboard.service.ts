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
import { env } from '../../config/env.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { sellerOrderCompliance } from '../compliance/destination-compliance.service.js';
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

  /**
   * This seller has not put anything here yet: no listing, no draft, no order.
   *
   * Computed here rather than inferred in the screen from a row of zeroes,
   * because those two things are not the same. A seller whose listings tile
   * failed to load also sees zeroes, and a screen that read them as "you have
   * nothing" would tell a seller with four hundred products that they have
   * none. This is false unless the counts it rests on were actually read - see
   * where it is set.
   */
  hasNothingYet: boolean;

  documentsExpiringSoon: { id: string; kind: string; expiresOn: string }[];
  closedLocations: { id: string; name: string; reason: string | null }[];

  /**
   * Requests for quotation waiting on this seller: invited or opened, on a
   * request that is still open and whose deadline has not passed.
   * `closingSoon` is the part of that whose deadline is within two days.
   */
  rfqs: { awaitingResponse: number; closingSoon: number };

  /**
   * Inspection work only the seller can move. `readinessDue` is a booked
   * inspection whose lot has not been declared ready; `capaDue` is a defect
   * (NCR) still open and waiting for the seller's corrective action. Each item
   * names the order it belongs to, because that is where the action is taken.
   */
  inspection: {
    readinessDue: number;
    capaDue: number;
    items: {
      kind: 'READINESS' | 'CAPA';
      sellerOrderGroupId: string;
      sellerOrderNumber: string;
      dueAt: string | null;
    }[];
  };

  /**
   * Compliance the seller has to act on: certificates about to lapse or
   * already lapsed or refused, listings held because a certificate lapsed, and
   * verification checks waiting on the seller's input.
   */
  compliance: {
    certificatesExpiringSoon: number;
    certificatesLapsed: number;
    listingsOnHold: number;
    verificationNeedsInput: number;
  };

  /**
   * Open orders the destination rules hold before dispatch: a document the
   * seller must produce is missing or not valid, or the goods are held for an
   * HS code or a prohibition. Only the seller's own holds are counted as the
   * seller's work; holds waiting on the buyer or the forwarder are counted
   * apart so the seller knows the order is stuck but not on them.
   */
  shipmentDocs: {
    ordersHeld: number;
    sellerActionNeeded: number;
    items: {
      sellerOrderGroupId: string;
      sellerOrderNumber: string;
      missingDocuments: string[];
      holdCodes: string[];
      onSeller: boolean;
    }[];
  };

  /**
   * Money the seller has earned and cannot have yet because something stopped
   * it: a sale's protected funds on hold (an open dispute or the operator), a
   * statement on hold, or the operator pausing payouts altogether. Per
   * currency, minor units.
   */
  settlementHolds: {
    fundsOnHold: number;
    statementsOnHold: number;
    amounts: { currency: string; amountMinor: string }[];
    payoutsPausedByOperator: boolean;
    payoutHoldReason: string | null;
  };

  /**
   * Orders that are not late yet but are about to go wrong: dispatch due
   * within `withinHours`, an open dispute, or a payment problem. Each order is
   * listed once with every reason that applies.
   */
  ordersAtRisk: {
    withinHours: number;
    count: number;
    items: {
      sellerOrderGroupId: string;
      sellerOrderNumber: string;
      dispatchDueAt: string | null;
      reasons: ('DISPATCH_DUE_SOON' | 'OPEN_DISPUTE' | 'PAYMENT_ISSUE')[];
    }[];
  };

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
    rfqs,
    inspection,
    compliance,
    shipmentDocs,
    settlementHolds,
    ordersAtRisk,
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
      // Buyer returns of this seller's goods still being worked. The older
      // `seller_returns` table is no longer written.
      prisma.returnRequest.count({
        where: {
          sellerOrderGroup: { sellerAccountId },
          status: { in: ['REQUESTED', 'APPROVED', 'RECEIVED', 'INSPECTED'] },
        },
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
    tile('rfqs', unavailable, { awaitingResponse: 0, closingSoon: 0 }, () =>
      rfqsAwaiting(sellerAccountId, now),
    ),
    tile(
      'inspection',
      unavailable,
      { readinessDue: 0, capaDue: 0, items: [] },
      () => inspectionActions(sellerAccountId),
    ),
    tile(
      'compliance',
      unavailable,
      {
        certificatesExpiringSoon: 0,
        certificatesLapsed: 0,
        listingsOnHold: 0,
        verificationNeedsInput: 0,
      },
      () => complianceActions(sellerAccountId, now),
    ),
    tile(
      'shipmentDocs',
      unavailable,
      { ordersHeld: 0, sellerActionNeeded: 0, items: [] },
      () => shipmentDocumentActions(sellerAccountId),
    ),
    tile(
      'settlementHolds',
      unavailable,
      {
        fundsOnHold: 0,
        statementsOnHold: 0,
        amounts: [],
        payoutsPausedByOperator: false,
        payoutHoldReason: null,
      },
      () => settlementHoldSummary(sellerAccountId),
    ),
    tile(
      'ordersAtRisk',
      unavailable,
      { withinHours: env.SELLER_ORDER_AT_RISK_HOURS, count: 0, items: [] },
      () => ordersAtRiskOf(sellerAccountId, now, env.SELLER_ORDER_AT_RISK_HOURS),
    ),
  ]);

  const countOf = (rows: StatusCount[], status: string): number =>
    rows.find((entry) => entry.status === status)?.count ?? 0;

  const orderCount = (status: string): number => countOf(orderCounts, status);
  const offerCount = (status: string): number => countOf(offerCounts, status);
  const draftCount = (status: string): number => countOf(draftCounts, status);

  /*
   * Has this seller ever put anything here?
   *
   * Every count that could say otherwise has to have been READ, not merely
   * come back zero: `countOf` cannot tell a seller with no listings from a
   * listings query that failed, and the difference decides whether the Hub
   * greets them with "here is how to start" or hides their catalogue behind
   * it.
   */
  const failed = new Set(unavailable.map((entry) => entry.tile));
  const countsAreKnown = !failed.has('orders') && !failed.has('listings') && !failed.has('drafts');

  const totalOf = (rows: StatusCount[]): number =>
    rows.reduce((sum, entry) => sum + entry.count, 0);

  const hasNothingYet =
    countsAreKnown &&
    totalOf(orderCounts) === 0 &&
    totalOf(offerCounts) === 0 &&
    totalOf(draftCounts) === 0;

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

    hasNothingYet,

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

    rfqs,
    inspection,
    compliance,
    shipmentDocs,
    settlementHolds,
    ordersAtRisk,

    unavailable,
  };
}

/** Invitations still waiting for this seller's quote or decline. */
async function rfqsAwaiting(
  sellerAccountId: string,
  now: Date,
): Promise<SellerDashboard['rfqs']> {
  const open = {
    sellerAccountId,
    status: { in: ['INVITED', 'VIEWED'] as ('INVITED' | 'VIEWED')[] },
    // One the seller hid as not for them is not waiting on them (JOURNEY-030).
    hiddenAt: null,
  };
  const [awaitingResponse, closingSoon] = await Promise.all([
    prisma.rfqInvitation.count({
      where: {
        ...open,
        rfq: {
          status: 'OPEN',
          OR: [{ responseDeadline: null }, { responseDeadline: { gt: now } }],
        },
      },
    }),
    prisma.rfqInvitation.count({
      where: {
        ...open,
        rfq: {
          status: 'OPEN',
          responseDeadline: { gt: now, lte: new Date(now.getTime() + 2 * 86_400_000) },
        },
      },
    }),
  ]);
  return { awaitingResponse, closingSoon };
}

/** Booked inspections waiting for the lot to be declared ready, and open NCRs. */
async function inspectionActions(sellerAccountId: string): Promise<SellerDashboard['inspection']> {
  const groupSelect = { sellerOrderGroup: { select: { id: true, sellerOrderNumber: true } } };

  const [readinessDue, capaDue, readinessJobs, openDefects] = await Promise.all([
    prisma.inspectionJob.count({
      where: {
        requirement: { sellerAccountId },
        status: { in: ['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED'] },
        readinessSubmittedAt: null,
      },
    }),
    prisma.inspectionDefect.count({
      where: { status: 'OPEN', job: { requirement: { sellerAccountId } } },
    }),
    prisma.inspectionJob.findMany({
      where: {
        requirement: { sellerAccountId },
        status: { in: ['REQUESTED', 'ACCEPTED', 'INSPECTOR_ASSIGNED'] },
        readinessSubmittedAt: null,
      },
      orderBy: { scheduledFor: 'asc' },
      take: 5,
      select: { scheduledFor: true, requirement: { select: groupSelect } },
    }),
    prisma.inspectionDefect.findMany({
      where: { status: 'OPEN', job: { requirement: { sellerAccountId } } },
      orderBy: { recordedAt: 'asc' },
      take: 5,
      select: { job: { select: { requirement: { select: groupSelect } } } },
    }),
  ]);

  const items: SellerDashboard['inspection']['items'] = [];
  for (const job of readinessJobs) {
    items.push({
      kind: 'READINESS',
      sellerOrderGroupId: job.requirement.sellerOrderGroup.id,
      sellerOrderNumber: job.requirement.sellerOrderGroup.sellerOrderNumber,
      dueAt: job.scheduledFor.toISOString(),
    });
  }
  // One row per order for CAPA: three NCRs on one order are one place to go.
  const seen = new Set<string>();
  for (const defect of openDefects) {
    const group = defect.job.requirement.sellerOrderGroup;
    if (seen.has(group.id)) continue;
    seen.add(group.id);
    items.push({
      kind: 'CAPA',
      sellerOrderGroupId: group.id,
      sellerOrderNumber: group.sellerOrderNumber,
      dueAt: null,
    });
  }

  return { readinessDue, capaDue, items };
}

/** Certificates, compliance holds and verification checks needing the seller. */
async function complianceActions(
  sellerAccountId: string,
  now: Date,
): Promise<SellerDashboard['compliance']> {
  const [certificatesExpiringSoon, certificatesLapsed, listingsOnHold, verificationNeedsInput] =
    await Promise.all([
      prisma.sellerCertification.count({
        where: {
          sellerAccountId,
          archivedAt: null,
          state: 'VERIFIED',
          expiresOn: { gte: now, lte: new Date(now.getTime() + 60 * 86_400_000) },
        },
      }),
      prisma.sellerCertification.count({
        where: { sellerAccountId, archivedAt: null, state: { in: ['EXPIRED', 'REJECTED'] } },
      }),
      prisma.sellerOfferComplianceHold.count({
        where: { releasedAt: null, offer: { sellerAccountId } },
      }),
      prisma.sellerVerificationCase.count({
        where: { sellerAccountId, isCurrent: true, state: { in: ['AWAITING_INPUT', 'FAILED'] } },
      }),
    ]);

  return { certificatesExpiringSoon, certificatesLapsed, listingsOnHold, verificationNeedsInput };
}

/** The seller-order statuses in which goods have still to leave. */
const NOT_YET_DISPATCHED = ['NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] as const;

/**
 * How many open orders the shipment-documents tile evaluates. Each one is a
 * full destination-rule evaluation, so the tile looks at the orders due
 * soonest rather than at every open order a large seller has.
 */
const SHIPMENT_DOCS_SCAN_LIMIT = 40;

/**
 * Open orders the destination rules hold (JOURNEY-026, "shipment docs").
 *
 * The answer comes from the same evaluation the order's documents page and
 * the dispatch gate use (`sellerOrderCompliance`), so the home screen can
 * never say an order is clear while dispatch refuses it.
 */
async function shipmentDocumentActions(sellerAccountId: string): Promise<SellerDashboard['shipmentDocs']> {
  const groups = await prisma.sellerOrderGroup.findMany({
    where: { sellerAccountId, status: { in: [...NOT_YET_DISPATCHED] } },
    orderBy: [{ dispatchDueAt: 'asc' }, { createdAt: 'asc' }],
    take: SHIPMENT_DOCS_SCAN_LIMIT,
    select: { id: true, sellerOrderNumber: true },
  });

  const items: SellerDashboard['shipmentDocs']['items'] = [];
  for (const group of groups) {
    const { verdict } = await sellerOrderCompliance(sellerAccountId, group.id);
    if (verdict.open) continue;
    const uncovered = verdict.holds.filter((hold) => !hold.covered);
    const missingDocuments = [
      ...new Set(
        verdict.items
          .filter(
            (item) =>
              item.documentKind !== null &&
              item.status !== 'VALID' &&
              item.status !== 'PENDING_REVIEW' &&
              item.status !== 'NO_DOCUMENT',
          )
          .map((item) => item.documentName ?? (item.documentKind as string)),
      ),
    ];
    items.push({
      sellerOrderGroupId: group.id,
      sellerOrderNumber: group.sellerOrderNumber,
      missingDocuments,
      holdCodes: [...new Set(uncovered.map((hold) => hold.code))],
      onSeller: uncovered.some((hold) => hold.responsibleParty === 'SELLER'),
    });
  }

  return {
    ordersHeld: items.length,
    sellerActionNeeded: items.filter((item) => item.onSeller).length,
    items: items.slice(0, 10),
  };
}

/** Funds, statements and payouts held, with the amounts per currency. */
async function settlementHoldSummary(sellerAccountId: string): Promise<SellerDashboard['settlementHolds']> {
  const [fundHolds, heldStatements, payoutAccount] = await Promise.all([
    prisma.sellerFundHold.groupBy({
      by: ['currency'],
      where: { sellerAccountId, status: 'ON_HOLD' },
      _count: { _all: true },
      _sum: { allocatedMinor: true },
    }),
    prisma.sellerSettlement.groupBy({
      by: ['currency'],
      where: { sellerAccountId, status: 'ON_HOLD' },
      _count: { _all: true },
      _sum: { netPayableMinor: true },
    }),
    prisma.sellerPayoutAccountReference.findFirst({
      where: { sellerAccountId },
      select: { payoutsHeldByOperator: true, payoutHoldReason: true },
    }),
  ]);

  const byCurrency = new Map<string, bigint>();
  for (const row of fundHolds) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0n) + (row._sum.allocatedMinor ?? 0n));
  }
  for (const row of heldStatements) {
    byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0n) + (row._sum.netPayableMinor ?? 0n));
  }

  return {
    fundsOnHold: fundHolds.reduce((sum, row) => sum + row._count._all, 0),
    statementsOnHold: heldStatements.reduce((sum, row) => sum + row._count._all, 0),
    amounts: [...byCurrency.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amountMinor: amount.toString() })),
    payoutsPausedByOperator: payoutAccount?.payoutsHeldByOperator ?? false,
    payoutHoldReason: payoutAccount?.payoutsHeldByOperator === true ? payoutAccount.payoutHoldReason : null,
  };
}

/** Dispute states still open and waiting on somebody. */
const OPEN_CLAIM_STATES = ['AWAITING_SELLER', 'UNDER_REVIEW', 'PENDING_APPROVAL', 'APPEALED'] as const;
/** Chargeback states still open: the buyer's bank has the payment in question. */
const OPEN_CHARGEBACK_STATES = ['CHARGEBACK_OPEN', 'NEEDS_RESPONSE', 'CHARGEBACK_UNDER_REVIEW'] as const;

/**
 * Orders at risk before they are late (JOURNEY-026).
 *
 * Three reasons, each from the record that decides it: the dispatch deadline
 * falls inside the window and has not passed (a passed one is already in the
 * overdue tile), a claim is open on the order, or the payment is in question -
 * a chargeback, or a buyer order still waiting for its payment.
 */
async function ordersAtRiskOf(
  sellerAccountId: string,
  now: Date,
  withinHours: number,
): Promise<SellerDashboard['ordersAtRisk']> {
  const horizon = new Date(now.getTime() + withinHours * 3_600_000);
  const rows = await prisma.sellerOrderGroup.findMany({
    where: {
      sellerAccountId,
      OR: [
        { status: { in: [...NOT_YET_DISPATCHED] }, dispatchDueAt: { gte: now, lte: horizon } },
        { disputes: { some: { status: { in: [...OPEN_CLAIM_STATES, ...OPEN_CHARGEBACK_STATES] } } } },
        { status: { in: [...NOT_YET_DISPATCHED] }, order: { status: 'PENDING_PAYMENT' } },
      ],
    },
    orderBy: [{ dispatchDueAt: 'asc' }, { createdAt: 'asc' }],
    take: 50,
    select: {
      id: true,
      sellerOrderNumber: true,
      status: true,
      dispatchDueAt: true,
      order: { select: { status: true } },
      disputes: {
        where: { status: { in: [...OPEN_CLAIM_STATES, ...OPEN_CHARGEBACK_STATES] } },
        select: { status: true },
      },
    },
  });

  const items = rows.map((row) => {
    const reasons: SellerDashboard['ordersAtRisk']['items'][number]['reasons'] = [];
    const notDispatched = (NOT_YET_DISPATCHED as readonly string[]).includes(row.status);
    if (
      notDispatched &&
      row.dispatchDueAt !== null &&
      row.dispatchDueAt >= now &&
      row.dispatchDueAt <= horizon
    ) {
      reasons.push('DISPATCH_DUE_SOON');
    }
    const states = row.disputes.map((dispute) => String(dispute.status));
    if (states.some((state) => (OPEN_CLAIM_STATES as readonly string[]).includes(state))) {
      reasons.push('OPEN_DISPUTE');
    }
    if (
      states.some((state) => (OPEN_CHARGEBACK_STATES as readonly string[]).includes(state)) ||
      (notDispatched && row.order.status === 'PENDING_PAYMENT')
    ) {
      reasons.push('PAYMENT_ISSUE');
    }
    return {
      sellerOrderGroupId: row.id,
      sellerOrderNumber: row.sellerOrderNumber,
      dispatchDueAt: row.dispatchDueAt?.toISOString() ?? null,
      reasons,
    };
  });

  return { withinHours, count: items.length, items: items.slice(0, 10) };
}
