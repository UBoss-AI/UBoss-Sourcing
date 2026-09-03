/**
 * Reports.
 *
 * Two rules shape every query here:
 *
 *   1. Aggregation happens in the database, never in the browser. The Admin
 *      Panel must not sum a paginated page and call it revenue.
 *   2. Money stays BigInt and leaves as a string. A JS number loses precision
 *      above 2^53 paise, and a financial report is exactly where that matters.
 *
 * Date windows are half-open [from, to) so adjacent periods never double-count
 * a row that lands exactly on a boundary.
 */
import { serialiseMoney } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';

/**
 * Order statuses that represent real, countable business.
 *
 * DRAFT is an abandoned cart and CANCELLED never happened, so neither belongs
 * in a revenue figure. PENDING_PAYMENT is included because the customer has
 * committed - a sales report that ignored unpaid orders would understate the
 * pipeline the operations team is working.
 */
const REVENUE_STATUSES = [
  'PENDING_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
] as const;

export interface DateWindow {
  from: Date;
  to: Date;
}

/** Default to the last 30 days, which is what a dashboard opens on. */
export function resolveWindow(from?: string, to?: string): DateWindow {
  const end = to === undefined ? new Date() : new Date(to);
  const start =
    from === undefined ? new Date(end.getTime() - 30 * 86_400_000) : new Date(from);

  return { from: start, to: end };
}

async function businessCurrency(): Promise<string> {
  const business = await prisma.businessProfile.findFirst({ select: { currency: true } });
  return business?.currency ?? 'INR';
}

// --- Sales -----------------------------------------------------------------

export interface SalesSummary {
  currency: string;
  window: { from: string; to: string };
  orderCount: number;
  grossSales: ReturnType<typeof serialiseMoney>;
  tax: ReturnType<typeof serialiseMoney>;
  shipping: ReturnType<typeof serialiseMoney>;
  discount: ReturnType<typeof serialiseMoney>;
  collected: ReturnType<typeof serialiseMoney>;
  refunded: ReturnType<typeof serialiseMoney>;
  netRevenue: ReturnType<typeof serialiseMoney>;
  averageOrderValue: ReturnType<typeof serialiseMoney>;
}

export async function salesSummary(window: DateWindow): Promise<SalesSummary> {
  const currency = await businessCurrency();

  const totals = await prisma.order.aggregate({
    where: {
      status: { in: [...REVENUE_STATUSES] },
      createdAt: { gte: window.from, lt: window.to },
    },
    _count: { _all: true },
    _sum: {
      subtotalMinor: true,
      taxMinor: true,
      shippingMinor: true,
      discountMinor: true,
      grandTotalMinor: true,
      paidMinor: true,
      refundedMinor: true,
    },
  });

  const orderCount = totals._count._all;
  const gross = totals._sum.grandTotalMinor ?? 0n;
  const collected = totals._sum.paidMinor ?? 0n;
  const refunded = totals._sum.refundedMinor ?? 0n;

  return {
    currency,
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    orderCount,
    grossSales: serialiseMoney(gross, currency),
    tax: serialiseMoney(totals._sum.taxMinor ?? 0n, currency),
    shipping: serialiseMoney(totals._sum.shippingMinor ?? 0n, currency),
    discount: serialiseMoney(totals._sum.discountMinor ?? 0n, currency),
    collected: serialiseMoney(collected, currency),
    refunded: serialiseMoney(refunded, currency),
    // What the business actually kept.
    netRevenue: serialiseMoney(collected - refunded, currency),
    // Integer division in BigInt: no float creeps into an average.
    averageOrderValue: serialiseMoney(
      orderCount === 0 ? 0n : gross / BigInt(orderCount),
      currency,
    ),
  };
}

export interface SalesBucket {
  period: string;
  orderCount: number;
  grossSales: string;
  collected: string;
}

/**
 * Sales grouped by day or month.
 *
 * Grouped with raw SQL because Prisma's groupBy cannot express a date
 * truncation. The interpolated values are the two dates and a fixed format
 * string chosen from a closed set, so there is no injection surface.
 */
export async function salesByPeriod(
  window: DateWindow,
  granularity: 'day' | 'month',
): Promise<SalesBucket[]> {
  const format = granularity === 'day' ? '%Y-%m-%d' : '%Y-%m';

  const rows = await prisma.$queryRaw<
    { period: string; orderCount: bigint; gross: bigint | null; collected: bigint | null }[]
  >`
    SELECT DATE_FORMAT(createdAt, ${format})            AS period,
           COUNT(*)                                     AS orderCount,
           SUM(grandTotalMinor)                         AS gross,
           SUM(paidMinor)                               AS collected
      FROM orders
     WHERE createdAt >= ${window.from}
       AND createdAt <  ${window.to}
       AND status IN ('PENDING_APPROVAL','PENDING_PAYMENT','CONFIRMED','PROCESSING','SHIPPED','DELIVERED')
     GROUP BY period
     ORDER BY period ASC
  `;

  return rows.map((row) => ({
    period: row.period,
    orderCount: Number(row.orderCount),
    grossSales: (row.gross ?? 0n).toString(),
    collected: (row.collected ?? 0n).toString(),
  }));
}

export interface ProductSalesRow {
  productId: string;
  name: string;
  sku: string;
  quantitySold: number;
  revenue: string;
  orderCount: number;
}

/**
 * Top products by revenue.
 *
 * Reads the order-item SNAPSHOTS, not the catalog. A product renamed or
 * repriced since must still report what was actually sold under the name it
 * was sold as.
 */
export async function topProducts(window: DateWindow, limit = 20): Promise<ProductSalesRow[]> {
  const rows = await prisma.$queryRaw<
    {
      productId: string;
      name: string;
      sku: string;
      quantitySold: bigint;
      revenue: bigint | null;
      orderCount: bigint;
    }[]
  >`
    SELECT oi.productId                        AS productId,
           MAX(oi.nameSnapshot)                AS name,
           MAX(oi.skuSnapshot)                 AS sku,
           SUM(oi.quantity)                    AS quantitySold,
           SUM(oi.lineTotalMinor)              AS revenue,
           COUNT(DISTINCT oi.orderId)          AS orderCount
      FROM order_items oi
      JOIN orders o ON o.id = oi.orderId
     WHERE o.createdAt >= ${window.from}
       AND o.createdAt <  ${window.to}
       AND o.status IN ('PENDING_APPROVAL','PENDING_PAYMENT','CONFIRMED','PROCESSING','SHIPPED','DELIVERED')
     GROUP BY oi.productId
     ORDER BY revenue DESC
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    productId: row.productId,
    name: row.name,
    sku: row.sku,
    quantitySold: Number(row.quantitySold),
    revenue: (row.revenue ?? 0n).toString(),
    orderCount: Number(row.orderCount),
  }));
}

export interface CustomerSalesRow {
  customerProfileId: string;
  fullName: string;
  organization: string | null;
  orderCount: number;
  revenue: string;
}

export async function topCustomers(window: DateWindow, limit = 20): Promise<CustomerSalesRow[]> {
  const rows = await prisma.$queryRaw<
    {
      customerProfileId: string;
      fullName: string;
      organization: string | null;
      orderCount: bigint;
      revenue: bigint | null;
    }[]
  >`
    SELECT o.customerProfileId          AS customerProfileId,
           MAX(cp.fullName)             AS fullName,
           MAX(cp.organization)         AS organization,
           COUNT(*)                     AS orderCount,
           SUM(o.grandTotalMinor)       AS revenue
      FROM orders o
      JOIN customer_profiles cp ON cp.id = o.customerProfileId
     WHERE o.createdAt >= ${window.from}
       AND o.createdAt <  ${window.to}
       AND o.status IN ('PENDING_APPROVAL','PENDING_PAYMENT','CONFIRMED','PROCESSING','SHIPPED','DELIVERED')
     GROUP BY o.customerProfileId
     ORDER BY revenue DESC
     LIMIT ${limit}
  `;

  return rows.map((row) => ({
    customerProfileId: row.customerProfileId,
    fullName: row.fullName,
    organization: row.organization,
    orderCount: Number(row.orderCount),
    revenue: (row.revenue ?? 0n).toString(),
  }));
}

export async function salesByCategory(
  window: DateWindow,
): Promise<{ categoryId: string; name: string; revenue: string; quantitySold: number }[]> {
  const rows = await prisma.$queryRaw<
    { categoryId: string; name: string; revenue: bigint | null; quantitySold: bigint }[]
  >`
    SELECT c.id                   AS categoryId,
           MAX(c.name)            AS name,
           SUM(oi.lineTotalMinor) AS revenue,
           SUM(oi.quantity)       AS quantitySold
      FROM order_items oi
      JOIN orders o     ON o.id = oi.orderId
      JOIN products p   ON p.id = oi.productId
      JOIN categories c ON c.id = p.categoryId
     WHERE o.createdAt >= ${window.from}
       AND o.createdAt <  ${window.to}
       AND o.status IN ('PENDING_APPROVAL','PENDING_PAYMENT','CONFIRMED','PROCESSING','SHIPPED','DELIVERED')
     GROUP BY c.id
     ORDER BY revenue DESC
  `;

  return rows.map((row) => ({
    categoryId: row.categoryId,
    name: row.name,
    revenue: (row.revenue ?? 0n).toString(),
    quantitySold: Number(row.quantitySold),
  }));
}

// --- Orders ----------------------------------------------------------------

export interface OrderStatusRow {
  status: string;
  count: number;
  value: string;
}

export async function ordersByStatus(window: DateWindow): Promise<OrderStatusRow[]> {
  const grouped = await prisma.order.groupBy({
    by: ['status'],
    where: { createdAt: { gte: window.from, lt: window.to } },
    _count: { _all: true },
    _sum: { grandTotalMinor: true },
  });

  return grouped.map((row) => ({
    status: row.status,
    count: row._count._all,
    value: (row._sum.grandTotalMinor ?? 0n).toString(),
  }));
}

export interface AgeingBucket {
  bucket: string;
  count: number;
  oldestOrderNumber: string | null;
  oldestAgeDays: number | null;
}

/**
 * How long confirmed orders have been waiting to ship.
 *
 * The operations question the SOP's daily routine asks: what is overdue? An
 * order sitting in PROCESSING for two weeks is the thing worth surfacing.
 */
export async function fulfilmentAgeing(): Promise<AgeingBucket[]> {
  const pending = await prisma.order.findMany({
    where: { status: { in: ['CONFIRMED', 'PROCESSING'] } },
    select: { orderNumber: true, confirmedAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const buckets: Record<string, { count: number; oldest: { number: string; days: number } | null }> =
    {
      '0-1 days': { count: 0, oldest: null },
      '2-3 days': { count: 0, oldest: null },
      '4-7 days': { count: 0, oldest: null },
      'over 7 days': { count: 0, oldest: null },
    };

  const now = Date.now();

  for (const order of pending) {
    const since = (order.confirmedAt ?? order.createdAt).getTime();
    const days = Math.floor((now - since) / 86_400_000);

    const key =
      days <= 1 ? '0-1 days' : days <= 3 ? '2-3 days' : days <= 7 ? '4-7 days' : 'over 7 days';

    const bucket = buckets[key];
    if (bucket === undefined) continue;

    bucket.count += 1;
    if (bucket.oldest === null || days > bucket.oldest.days) {
      bucket.oldest = { number: order.orderNumber, days };
    }
  }

  return Object.entries(buckets).map(([bucket, data]) => ({
    bucket,
    count: data.count,
    oldestOrderNumber: data.oldest?.number ?? null,
    oldestAgeDays: data.oldest?.days ?? null,
  }));
}

// --- Payments --------------------------------------------------------------

export interface PaymentsReport {
  currency: string;
  byStatus: { status: string; count: number; amount: string }[];
  captured: string;
  failed: string;
  refunded: string;
  refundCount: number;
  /** Verified events we deliberately refused - a security and finance signal. */
  rejectedWebhooks: number;
  unreconciled: number;
}

export async function paymentsReport(window: DateWindow): Promise<PaymentsReport> {
  const currency = await businessCurrency();
  const createdIn = { gte: window.from, lt: window.to };

  const [byStatus, refunds, rejectedWebhooks, unreconciled] = await Promise.all([
    prisma.paymentTransaction.groupBy({
      by: ['status'],
      where: { createdAt: createdIn },
      _count: { _all: true },
      _sum: { amountMinor: true, capturedMinor: true },
    }),
    prisma.refund.aggregate({
      where: { createdAt: createdIn, status: { in: ['SUCCEEDED', 'PROCESSING'] } },
      _count: { _all: true },
      _sum: { amountMinor: true },
    }),
    prisma.paymentEvent.count({
      where: { receivedAt: createdIn, processingStatus: 'REJECTED' },
    }),
    // Money the provider says it took that no order has recorded, or a payment
    // stuck pending long enough to be worth a look. The SOP's daily
    // reconciliation list.
    prisma.paymentTransaction.count({
      where: {
        status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] },
        // Inside the window AND older than an hour: a payment that has sat
        // un-captured that long is worth reconciling, but a brand-new one is
        // just a customer still on the provider's page.
        createdAt: {
          gte: window.from,
          lt: new Date(Math.min(window.to.getTime(), Date.now() - 3_600_000)),
        },
      },
    }),
  ]);

  const captured = byStatus
    .filter((row) => row.status === 'CAPTURED')
    .reduce((sum, row) => sum + (row._sum.capturedMinor ?? 0n), 0n);

  const failed = byStatus
    .filter((row) => row.status === 'FAILED')
    .reduce((sum, row) => sum + (row._sum.amountMinor ?? 0n), 0n);

  return {
    currency,
    byStatus: byStatus.map((row) => ({
      status: row.status,
      count: row._count._all,
      amount: (row._sum.amountMinor ?? 0n).toString(),
    })),
    captured: captured.toString(),
    failed: failed.toString(),
    refunded: (refunds._sum.amountMinor ?? 0n).toString(),
    refundCount: refunds._count._all,
    rejectedWebhooks,
    unreconciled,
  };
}

// --- Inventory -------------------------------------------------------------

export interface InventoryValuationRow {
  productId: string;
  name: string;
  sku: string;
  onHandQty: number;
  reservedQty: number;
  availableQty: number;
  unitPrice: string;
  /** on-hand x current selling price. A retail, not a cost, valuation. */
  valuation: string;
  reorderThreshold: number;
  isLowStock: boolean;
}

export async function inventoryValuation(
  options: { lowStockOnly?: boolean } = {},
): Promise<{ rows: InventoryValuationRow[]; totalValuation: string; currency: string }> {
  const currency = await businessCurrency();

  const balances = await prisma.inventoryBalance.findMany({
    include: {
      product: {
        select: {
          id: true,
          name: true,
          sku: true,
          basePriceMinor: true,
          reorderThreshold: true,
          archivedAt: true,
          isStockTracked: true,
        },
      },
    },
  });

  let total = 0n;
  const rows: InventoryValuationRow[] = [];

  for (const balance of balances) {
    const product = balance.product;
    if (product.archivedAt !== null || !product.isStockTracked) continue;

    const available = balance.onHandQty - balance.reservedQty;
    const valuation = product.basePriceMinor * BigInt(balance.onHandQty);
    const isLowStock = product.reorderThreshold > 0 && available <= product.reorderThreshold;

    if (options.lowStockOnly === true && !isLowStock) continue;

    total += valuation;

    rows.push({
      productId: product.id,
      name: product.name,
      sku: product.sku,
      onHandQty: balance.onHandQty,
      reservedQty: balance.reservedQty,
      availableQty: available,
      unitPrice: product.basePriceMinor.toString(),
      valuation: valuation.toString(),
      reorderThreshold: product.reorderThreshold,
      isLowStock,
    });
  }

  rows.sort((a, b) => (BigInt(b.valuation) > BigInt(a.valuation) ? 1 : -1));

  return { rows, totalValuation: total.toString(), currency };
}

export interface MovementRow {
  type: string;
  count: number;
  netQuantity: number;
}

export async function inventoryMovementSummary(window: DateWindow): Promise<MovementRow[]> {
  const grouped = await prisma.inventoryMovement.groupBy({
    by: ['type'],
    where: { createdAt: { gte: window.from, lt: window.to } },
    _count: { _all: true },
    _sum: { quantityDelta: true },
  });

  return grouped.map((row) => ({
    type: row.type,
    count: row._count._all,
    netQuantity: row._sum.quantityDelta ?? 0,
  }));
}

// --- Customers -------------------------------------------------------------

export interface CustomerReport {
  total: number;
  byStatus: { status: string; count: number }[];
  newInWindow: number;
  activatedInWindow: number;
  /** Customers with at least one order in the window. */
  orderingInWindow: number;
}

export async function customerReport(window: DateWindow): Promise<CustomerReport> {
  const [total, byStatus, newInWindow, activatedInWindow, ordering] = await Promise.all([
    prisma.customerProfile.count(),
    prisma.user.groupBy({
      by: ['status'],
      where: { type: 'CUSTOMER' },
      _count: { _all: true },
    }),
    prisma.customerProfile.count({ where: { createdAt: { gte: window.from, lt: window.to } } }),
    prisma.customerProfile.count({ where: { activatedAt: { gte: window.from, lt: window.to } } }),
    prisma.order.findMany({
      where: { createdAt: { gte: window.from, lt: window.to } },
      distinct: ['customerProfileId'],
      select: { customerProfileId: true },
    }),
  ]);

  return {
    total,
    byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
    newInWindow,
    activatedInWindow,
    orderingInWindow: ordering.length,
  };
}

// --- Recurring -------------------------------------------------------------

export interface RecurringReport {
  byStatus: { status: string; count: number }[];
  upcoming: {
    scheduleId: string;
    name: string;
    customerName: string;
    nextRunAt: string;
    paymentMode: string;
  }[];
  failedOccurrences: number;
  /** Schedules auto-paused after repeated failures - these need a human. */
  needsAttention: {
    scheduleId: string;
    name: string;
    customerName: string;
    failureCount: number;
    reason: string | null;
  }[];
}

export async function recurringReport(daysAhead = 7): Promise<RecurringReport> {
  const horizon = new Date(Date.now() + daysAhead * 86_400_000);

  const [byStatus, upcoming, failedOccurrences, needsAttention] = await Promise.all([
    prisma.recurringSchedule.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.recurringSchedule.findMany({
      where: { status: 'ACTIVE', nextRunAt: { not: null, lte: horizon } },
      orderBy: { nextRunAt: 'asc' },
      take: 50,
      include: { customerProfile: { select: { fullName: true } } },
    }),
    prisma.scheduleOccurrence.count({ where: { status: 'FAILED' } }),
    prisma.recurringSchedule.findMany({
      where: { status: { in: ['FAILED', 'PAUSED'] }, failureCount: { gt: 0 } },
      orderBy: { failureCount: 'desc' },
      take: 50,
      include: { customerProfile: { select: { fullName: true } } },
    }),
  ]);

  return {
    byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
    upcoming: upcoming.map((schedule) => ({
      scheduleId: schedule.id,
      name: schedule.name,
      customerName: schedule.customerProfile.fullName,
      nextRunAt: schedule.nextRunAt?.toISOString() ?? '',
      paymentMode: schedule.paymentMode,
    })),
    failedOccurrences,
    needsAttention: needsAttention.map((schedule) => ({
      scheduleId: schedule.id,
      name: schedule.name,
      customerName: schedule.customerProfile.fullName,
      failureCount: schedule.failureCount,
      reason: schedule.pausedReason,
    })),
  };
}

// --- Dashboard -------------------------------------------------------------

/**
 * Everything the admin dashboard opens with, in one round trip.
 *
 * Every figure is a database aggregate. The Admin Panel renders these; it does
 * not compute authoritative totals from paginated data.
 */
export async function dashboard(window: DateWindow): Promise<Record<string, unknown>> {
  const [sales, orders, payments, lowStock, recurring, failedNotifications, deadJobs] =
    await Promise.all([
      salesSummary(window),
      ordersByStatus(window),
      paymentsReport(window),
      inventoryValuation({ lowStockOnly: true }),
      recurringReport(7),
      prisma.notificationOutbox.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
      prisma.jobQueue.count({ where: { status: 'DEAD' } }),
    ]);

  return {
    sales,
    ordersByStatus: orders,
    payments,
    lowStock: { count: lowStock.rows.length, items: lowStock.rows.slice(0, 10) },
    recurring,
    // Operational health, so a broken email provider or a stuck job is visible
    // on the dashboard rather than discovered by a customer complaint.
    alerts: {
      failedNotifications,
      deadJobs,
      rejectedWebhooks: payments.rejectedWebhooks,
      unreconciledPayments: payments.unreconciled,
      schedulesNeedingAttention: recurring.needsAttention.length,
    },
  };
}
