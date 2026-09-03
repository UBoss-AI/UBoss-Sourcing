/**
 * Metrics.
 *
 * Prometheus text format on `/metrics`. The point is not to have numbers but
 * to be able to answer, at 3am, the questions the SOP's exception handling
 * asks: are payments failing, is the queue backing up, did the recurring engine
 * run, is a connector down.
 *
 * Two rules:
 *   - No unbounded label values. A label carrying an order id or an email would
 *     create a new time series per order and take the metrics store down.
 *   - Route labels use the registered PATH (`/orders/:id`), never the URL, for
 *     exactly that reason.
 */
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';

export const registry = new Registry();

registry.setDefaultLabels({ service: 'uboss-api' });

// Event loop lag, heap, GC. The first things to look at when latency rises
// without the database being slow.
collectDefaultMetrics({ register: registry, prefix: 'uboss_' });

// --- HTTP ------------------------------------------------------------------

export const httpRequestDuration = new Histogram({
  name: 'uboss_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  // Buckets chosen around the Dev Plan's suggested targets: 500ms for catalog,
  // 800ms for checkout. The 0.5 and 1 boundaries are the ones that matter.
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

export const httpRequestsTotal = new Counter({
  name: 'uboss_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'] as const,
  registers: [registry],
});

export const httpErrorsTotal = new Counter({
  name: 'uboss_http_errors_total',
  help: 'HTTP responses with a 4xx or 5xx status',
  labelNames: ['method', 'route', 'status', 'code'] as const,
  registers: [registry],
});

// --- Business events -------------------------------------------------------

export const ordersCreatedTotal = new Counter({
  name: 'uboss_orders_created_total',
  help: 'Orders created',
  labelNames: ['source'] as const,
  registers: [registry],
});

export const paymentEventsTotal = new Counter({
  name: 'uboss_payment_events_total',
  help: 'Payment provider events by outcome',
  // `outcome` is a closed set: captured, failed, duplicate, rejected.
  labelNames: ['provider', 'outcome'] as const,
  registers: [registry],
});

/**
 * A verified event we deliberately refused.
 *
 * Distinct from a failed payment: this is an amount mismatch, a currency
 * mismatch, or a forged signature - a security signal, not a declined card.
 */
export const paymentRejectionsTotal = new Counter({
  name: 'uboss_payment_rejections_total',
  help: 'Provider events rejected after verification',
  labelNames: ['reason'] as const,
  registers: [registry],
});

export const recurringOccurrencesTotal = new Counter({
  name: 'uboss_recurring_occurrences_total',
  help: 'Recurring schedule occurrences by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const jobsProcessedTotal = new Counter({
  name: 'uboss_jobs_processed_total',
  help: 'Background jobs by outcome',
  labelNames: ['job_type', 'outcome'] as const,
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'uboss_job_duration_seconds',
  help: 'Background job duration in seconds',
  labelNames: ['job_type'] as const,
  buckets: [0.05, 0.25, 1, 5, 15, 60, 300],
  registers: [registry],
});

export const connectorSyncsTotal = new Counter({
  name: 'uboss_connector_syncs_total',
  help: 'Connector sync runs by outcome',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

// --- Gauges, refreshed on scrape -------------------------------------------

const queueDepth = new Gauge({
  name: 'uboss_queue_depth',
  help: 'Jobs waiting to be processed',
  labelNames: ['state'] as const,
  registers: [registry],
});

const outboxDepth = new Gauge({
  name: 'uboss_notification_outbox_depth',
  help: 'Notifications waiting to be delivered',
  labelNames: ['state'] as const,
  registers: [registry],
});

const schedulesGauge = new Gauge({
  name: 'uboss_recurring_schedules',
  help: 'Recurring schedules by status',
  labelNames: ['status'] as const,
  registers: [registry],
});

const ordersAwaitingFulfilment = new Gauge({
  name: 'uboss_orders_awaiting_fulfilment',
  help: 'Orders confirmed or processing and not yet shipped',
  registers: [registry],
});

const paymentsUnreconciled = new Gauge({
  name: 'uboss_payments_unreconciled',
  help: 'Payments stuck below a terminal state for more than an hour',
  registers: [registry],
});

const lowStockProducts = new Gauge({
  name: 'uboss_low_stock_products',
  help: 'Stock-tracked products at or below their reorder threshold',
  registers: [registry],
});

/**
 * Refresh the gauges.
 *
 * Called on scrape rather than on a timer, so an unscraped instance costs
 * nothing. Every query here is indexed and counts only - none reads rows.
 */
export async function refreshGauges(): Promise<void> {
  try {
    const hourAgo = new Date(Date.now() - 3_600_000);

    const [
      pendingJobs,
      runningJobs,
      deadJobs,
      pendingOutbox,
      deadOutbox,
      schedulesByStatus,
      awaitingFulfilment,
      unreconciled,
      lowStock,
    ] = await Promise.all([
      prisma.jobQueue.count({ where: { status: 'PENDING' } }),
      prisma.jobQueue.count({ where: { status: 'RUNNING' } }),
      prisma.jobQueue.count({ where: { status: 'DEAD' } }),
      prisma.notificationOutbox.count({ where: { status: 'PENDING' } }),
      prisma.notificationOutbox.count({ where: { status: 'DEAD' } }),
      prisma.recurringSchedule.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.order.count({ where: { status: { in: ['CONFIRMED', 'PROCESSING'] } } }),
      prisma.paymentTransaction.count({
        where: {
          status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] },
          createdAt: { lt: hourAgo },
        },
      }),
      prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count
          FROM inventory_balances ib
          JOIN products p ON p.id = ib.productId
         WHERE p.isStockTracked = 1
           AND p.archivedAt IS NULL
           AND p.reorderThreshold > 0
           AND (ib.onHandQty - ib.reservedQty) <= p.reorderThreshold
      `,
    ]);

    queueDepth.set({ state: 'pending' }, pendingJobs);
    queueDepth.set({ state: 'running' }, runningJobs);
    queueDepth.set({ state: 'dead' }, deadJobs);

    outboxDepth.set({ state: 'pending' }, pendingOutbox);
    outboxDepth.set({ state: 'dead' }, deadOutbox);

    // Reset first: a status that dropped to zero must report zero, not keep
    // its last non-zero value forever.
    schedulesGauge.reset();
    for (const row of schedulesByStatus) {
      schedulesGauge.set({ status: row.status }, row._count._all);
    }

    ordersAwaitingFulfilment.set(awaitingFulfilment);
    paymentsUnreconciled.set(unreconciled);
    lowStockProducts.set(Number(lowStock[0]?.count ?? 0n));
  } catch (error) {
    // A metrics failure must never take the endpoint - or the process - down.
    // Stale numbers beat a 500 on the thing monitoring you.
    logger.error({ err: error }, 'failed to refresh metrics gauges');
  }
}

export async function renderMetrics(): Promise<string> {
  await refreshGauges();
  return registry.metrics();
}

export const metricsContentType = registry.contentType;
