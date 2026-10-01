/**
 * Marketplace reports for the Admin Panel: GMV, supplier quality, inspection,
 * disputes and settlement.
 *
 * Same rules as `report.service.ts`: every figure is a database aggregate over
 * a stated window, money is BigInt minor units serialised as strings, and an
 * amount is never summed across currencies - each currency is its own row.
 * Rates are returned as the two counts they are made of, so a rate over
 * nothing renders as a dash rather than as a reassuring zero.
 */
import { serialiseMoney } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import { REVENUE_STATUSES, type DateWindow } from './report.service.js';

type Money = ReturnType<typeof serialiseMoney>;

/** Bounds the per-row reads behind the supplier table. */
const ROW_CAP = 50_000;

// --- GMV -------------------------------------------------------------------

export interface GmvReport {
  window: { from: string; to: string };
  /**
   * Gross merchandise value: the goods value of every order placed in the
   * window that was not abandoned or cancelled, before tax, shipping and
   * discounts. One row per currency.
   */
  byCurrency: { currency: string; orders: number; gmv: Money; discount: Money }[];
  /** The part of GMV sold by marketplace sellers, from their own order slices. */
  sellerGmv: { currency: string; sellerOrders: number; gmv: Money; commission: Money }[];
}

export async function gmvReport(window: DateWindow): Promise<GmvReport> {
  const createdAt = { gte: window.from, lt: window.to };

  const [orders, sellers] = await Promise.all([
    prisma.order.groupBy({
      by: ['currency'],
      where: { status: { in: [...REVENUE_STATUSES] }, createdAt },
      _count: { _all: true },
      _sum: { subtotalMinor: true, discountMinor: true },
    }),
    prisma.sellerOrderGroup.groupBy({
      by: ['currency'],
      where: { status: { not: 'CANCELLED' }, createdAt },
      _count: { _all: true },
      _sum: { goodsTotalMinor: true, commissionMinor: true },
    }),
  ]);

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    byCurrency: orders.map((row) => ({
      currency: row.currency,
      orders: row._count._all,
      gmv: serialiseMoney(row._sum.subtotalMinor ?? 0n, row.currency),
      discount: serialiseMoney(row._sum.discountMinor ?? 0n, row.currency),
    })),
    sellerGmv: sellers.map((row) => ({
      currency: row.currency,
      sellerOrders: row._count._all,
      gmv: serialiseMoney(row._sum.goodsTotalMinor ?? 0n, row.currency),
      commission: serialiseMoney(row._sum.commissionMinor ?? 0n, row.currency),
    })),
  };
}

// --- Supplier quality --------------------------------------------------------

export interface SupplierQualityRow {
  sellerAccountId: string;
  displayName: string;
  /** Seller orders placed in the window. */
  orders: number;
  cancelled: number;
  /** Returns raised in the window against this seller's orders. */
  returns: number;
  /** Buyer claims (not chargebacks) opened in the window. */
  claims: number;
  /** Inspection reports signed in the window, and how many failed. */
  inspections: number;
  inspectionFails: number;
}

/**
 * Per seller, the worst first: sorted by returns + claims + failed
 * inspections, then by order count. Sellers with no orders but a quality event
 * in the window are included - a failed inspection is news even on a quiet
 * month.
 */
export async function supplierQualityReport(
  window: DateWindow,
  limit = 50,
): Promise<SupplierQualityRow[]> {
  const createdAt = { gte: window.from, lt: window.to };

  const [orderRows, returnRows, claimRows, reportRows] = await Promise.all([
    prisma.sellerOrderGroup.groupBy({
      by: ['sellerAccountId', 'status'],
      where: { createdAt },
      _count: { _all: true },
    }),
    prisma.returnRequest.findMany({
      where: { createdAt, sellerOrderGroupId: { not: null } },
      select: { sellerOrderGroup: { select: { sellerAccountId: true } } },
      take: ROW_CAP,
    }),
    prisma.dispute.groupBy({
      by: ['sellerAccountId'],
      where: { createdAt, kind: 'CLAIM', sellerAccountId: { not: null } },
      _count: { _all: true },
    }),
    prisma.inspectionReport.findMany({
      where: { status: 'SIGNED', signedAt: createdAt },
      select: { result: true, job: { select: { requirement: { select: { sellerAccountId: true } } } } },
      take: ROW_CAP,
    }),
  ]);

  const rows = new Map<string, Omit<SupplierQualityRow, 'displayName'>>();
  const rowFor = (sellerAccountId: string): Omit<SupplierQualityRow, 'displayName'> => {
    let row = rows.get(sellerAccountId);
    if (row === undefined) {
      row = { sellerAccountId, orders: 0, cancelled: 0, returns: 0, claims: 0, inspections: 0, inspectionFails: 0 };
      rows.set(sellerAccountId, row);
    }
    return row;
  };

  for (const entry of orderRows) {
    const row = rowFor(entry.sellerAccountId);
    row.orders += entry._count._all;
    if (entry.status === 'CANCELLED') row.cancelled += entry._count._all;
  }
  for (const entry of returnRows) {
    if (entry.sellerOrderGroup !== null) rowFor(entry.sellerOrderGroup.sellerAccountId).returns += 1;
  }
  for (const entry of claimRows) {
    if (entry.sellerAccountId !== null) rowFor(entry.sellerAccountId).claims += entry._count._all;
  }
  for (const entry of reportRows) {
    const row = rowFor(entry.job.requirement.sellerAccountId);
    row.inspections += 1;
    if (entry.result === 'FAIL') row.inspectionFails += 1;
  }

  const sorted = [...rows.values()]
    .sort((left, right) => {
      const badness = (row: typeof left): number => row.returns + row.claims + row.inspectionFails;
      return badness(right) - badness(left) || right.orders - left.orders;
    })
    .slice(0, limit);

  const names = await prisma.sellerAccount.findMany({
    where: { id: { in: sorted.map((row) => row.sellerAccountId) } },
    select: { id: true, displayName: true },
  });
  const nameOf = new Map(names.map((seller) => [seller.id, seller.displayName]));

  return sorted.map((row) => ({ ...row, displayName: nameOf.get(row.sellerAccountId) ?? '—' }));
}

// --- Inspection --------------------------------------------------------------

export interface InspectionReportSummary {
  /** Where every order needing inspection stands now (not windowed). */
  requirementsByStatus: { status: string; count: number }[];
  /** Inspections booked in the window, by where they have got to. */
  jobsByStatus: { status: string; count: number }[];
  /** Reports signed in the window. */
  signed: number;
  failed: number;
  /** Open NCRs now, by severity. */
  openNcrsBySeverity: { severity: string; count: number }[];
  /** Booked in the window and past the agency's report deadline without a signed report. */
  overdueReports: number;
}

export async function inspectionSummary(window: DateWindow): Promise<InspectionReportSummary> {
  const createdAt = { gte: window.from, lt: window.to };

  const [requirements, jobs, reports, ncrs, overdueReports] = await Promise.all([
    prisma.inspectionRequirement.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.inspectionJob.groupBy({ by: ['status'], where: { createdAt }, _count: { _all: true } }),
    prisma.inspectionReport.groupBy({
      by: ['result'],
      where: { status: 'SIGNED', signedAt: createdAt },
      _count: { _all: true },
    }),
    prisma.inspectionDefect.groupBy({
      by: ['severity'],
      where: { status: { not: 'VERIFIED_CLOSED' } },
      _count: { _all: true },
    }),
    prisma.inspectionJob.count({
      where: {
        createdAt,
        reportDueAt: { lt: new Date() },
        status: { in: ['ACCEPTED', 'INSPECTOR_ASSIGNED', 'IN_PROGRESS', 'REPORT_SUBMITTED'] },
      },
    }),
  ]);

  const passed = reports.find((row) => row.result === 'PASS')?._count._all ?? 0;
  const failed = reports.find((row) => row.result === 'FAIL')?._count._all ?? 0;

  return {
    requirementsByStatus: requirements.map((row) => ({ status: row.status, count: row._count._all })),
    jobsByStatus: jobs.map((row) => ({ status: row.status, count: row._count._all })),
    signed: passed + failed,
    failed,
    openNcrsBySeverity: ncrs.map((row) => ({ severity: row.severity, count: row._count._all })),
    overdueReports,
  };
}

// --- Disputes ----------------------------------------------------------------

export interface DisputeReport {
  /** Opened in the window, by kind and where they stand now. */
  byStatus: { kind: string; status: string; count: number }[];
  /** Decided in the window, by outcome. */
  byResolution: { resolution: string; count: number }[];
  /** Money awarded back to buyers by decisions in the window, per currency. */
  awarded: { currency: string; amount: Money }[];
  /** Open now with the seller's response deadline already past. */
  sellerResponseOverdue: number;
}

export async function disputeReport(window: DateWindow): Promise<DisputeReport> {
  const createdAt = { gte: window.from, lt: window.to };

  const [byStatus, byResolution, awarded, sellerResponseOverdue] = await Promise.all([
    prisma.dispute.groupBy({ by: ['kind', 'status'], where: { createdAt }, _count: { _all: true } }),
    prisma.dispute.groupBy({
      by: ['resolution'],
      where: { decidedAt: createdAt, resolution: { not: null } },
      _count: { _all: true },
    }),
    prisma.dispute.groupBy({
      by: ['currency'],
      where: { decidedAt: createdAt, resolutionAmountMinor: { not: null } },
      _sum: { resolutionAmountMinor: true },
    }),
    prisma.dispute.count({
      where: {
        status: 'AWAITING_SELLER',
        sellerRespondedAt: null,
        sellerResponseDueAt: { lt: new Date() },
      },
    }),
  ]);

  return {
    byStatus: byStatus.map((row) => ({ kind: row.kind, status: row.status, count: row._count._all })),
    byResolution: byResolution.map((row) => ({
      resolution: String(row.resolution),
      count: row._count._all,
    })),
    awarded: awarded.map((row) => ({
      currency: row.currency,
      amount: serialiseMoney(row._sum.resolutionAmountMinor ?? 0n, row.currency),
    })),
    sellerResponseOverdue,
  };
}

// --- Settlement --------------------------------------------------------------

export interface SettlementReport {
  /** Seller settlements whose period ended in the window, per status and currency. */
  settlements: {
    status: string;
    currency: string;
    count: number;
    gross: Money;
    commission: Money;
    refunds: Money;
    netPayable: Money;
  }[];
  /** Payouts created in the window, per status and currency. */
  payouts: { status: string; currency: string; count: number; amount: Money }[];
  /** Failed and not yet retried, now. The queue someone has to work. */
  failedPayoutsOpen: number;
  /** Settlements on hold now. */
  settlementsOnHold: number;
}

export async function settlementReport(window: DateWindow): Promise<SettlementReport> {
  const range = { gte: window.from, lt: window.to };

  const [settlements, payouts, failedPayoutsOpen, settlementsOnHold] = await Promise.all([
    prisma.sellerSettlement.groupBy({
      by: ['status', 'currency'],
      where: { periodEnd: range },
      _count: { _all: true },
      _sum: { grossMinor: true, commissionMinor: true, refundsMinor: true, netPayableMinor: true },
    }),
    prisma.sellerPayout.groupBy({
      by: ['status', 'currency'],
      where: { createdAt: range },
      _count: { _all: true },
      _sum: { amountMinor: true },
    }),
    prisma.sellerPayout.count({ where: { status: 'FAILED' } }),
    prisma.sellerSettlement.count({ where: { status: 'ON_HOLD' } }),
  ]);

  return {
    settlements: settlements.map((row) => ({
      status: row.status,
      currency: row.currency,
      count: row._count._all,
      gross: serialiseMoney(row._sum.grossMinor ?? 0n, row.currency),
      commission: serialiseMoney(row._sum.commissionMinor ?? 0n, row.currency),
      refunds: serialiseMoney(row._sum.refundsMinor ?? 0n, row.currency),
      netPayable: serialiseMoney(row._sum.netPayableMinor ?? 0n, row.currency),
    })),
    payouts: payouts.map((row) => ({
      status: row.status,
      currency: row.currency,
      count: row._count._all,
      amount: serialiseMoney(row._sum.amountMinor ?? 0n, row.currency),
    })),
    failedPayoutsOpen,
    settlementsOnHold,
  };
}
