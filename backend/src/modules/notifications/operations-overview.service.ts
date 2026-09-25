/**
 * Platform operations, grouped: what is waiting, and who it is waiting for.
 *
 * The admin dashboard's hero chart. It answers one question — "what should the
 * team do first this morning" — and the grouping IS the answer: a flat list of
 * a dozen counters is a wall of numbers that reads as one texture, and nobody
 * finds "3 cold-chain exceptions" in it.
 *
 * ---
 *
 * BUILT ON `attention.service.ts`, NOT BESIDE IT
 *
 * The rail badges and this chart must never disagree, so the queues they share
 * are counted once, by `readAttention`, and this file groups what that
 * returns. What it adds are the operational faults that are not "a queue
 * somebody decides" and therefore have no badge: a payment nobody can
 * reconcile, an ERP that has stopped answering, a bin below its reorder point,
 * a job that died.
 *
 * ---
 *
 * THREE RULES CARRIED OVER FROM THE QUEUE COUNTS, BECAUSE THEY MATTER MORE HERE
 *
 *   - **A count is gated by the permission that makes it ACTIONABLE**, not by
 *     the one that makes a page visible. Somebody who may read orders but not
 *     approve them does not need a segment about approvals.
 *   - **A queue the caller may not see is ABSENT, not zero.** Zero is a fact
 *     about the business, and the difference between 0 and 12 pending
 *     data-subject requests is itself information. An absent segment also
 *     keeps the ring honest: the total is the sum of what this caller can see,
 *     so it always reconciles with the segments drawn.
 *   - **Resolved work is not waiting work.** Every count below is of something
 *     still outstanding. An exception somebody has acknowledged, a brand
 *     request sitting with the seller, a connection deliberately paused — none
 *     of them is counted, because a number nobody can clear is a number
 *     everybody learns to ignore.
 */
import { Permission, type PermissionKey } from '../../domain/permissions.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import type { InsightMetric } from '../assistant/insights.service.js';
import { readAttention, type AttentionKeyName } from './attention.service.js';

// ---------------------------------------------------------------------------
// The groups
// ---------------------------------------------------------------------------

/**
 * The five kinds of operational work, in the order the ring draws them.
 *
 * Ordered as a morning runs rather than alphabetically: decisions that unblock
 * other people first, money second, then stock, then the parcels already
 * moving, then the machinery. A chart whose segments are in a meaningful order
 * can be read without its legend after a week.
 */
export const OperationsGroup = {
  /// Somebody is waiting for a decision: a seller, a listing, a brand, a
  /// buyer's sign-up, an order held for an approver.
  APPROVALS: 'approvals',
  /// Money that did not settle cleanly, and the feeds that carry it.
  PAYMENTS: 'payments',
  /// Stock at or below its reorder point.
  INVENTORY: 'inventory',
  /// Consignments in trouble.
  LOGISTICS: 'logistics',
  /// The machinery: dead jobs, undelivered notifications, silent ERP feeds.
  PLATFORM: 'platform',
} as const;

export type OperationsGroupName = (typeof OperationsGroup)[keyof typeof OperationsGroup];

/** One counted queue inside a group. */
export interface OperationsQueue {
  /** Stable key. The Admin Panel translates it and links from it. */
  key: string;
  group: OperationsGroupName;
  count: number;
  /**
   * How much it wants somebody.
   *
   * Fixed per queue rather than derived from the count, because size and
   * urgency are different things: one lost consignment of cold-chain goods is
   * urgent at a count of one, and forty listings waiting review is a busy
   * Tuesday.
   */
  severity: 'info' | 'attention' | 'urgent';
  /** Where the work is done, relative to the Admin Panel. */
  href: string;
}

export interface OperationsOverview {
  /** When these were counted. */
  generatedAt: string;
  /**
   * Everything this caller can see, added up.
   *
   * The ring's denominator, and it reconciles by construction: it is the sum
   * of the queues below rather than a separate count, because a chart of
   * "operational work" has no other whole to measure against.
   */
  total: number;
  queues: OperationsQueue[];
  /** Per-group totals, so a chart can draw five segments rather than twelve. */
  byGroup: { group: OperationsGroupName; count: number }[];
}

// ---------------------------------------------------------------------------
// The queues that already have badges
// ---------------------------------------------------------------------------

/**
 * Where each `readAttention` queue belongs on this chart, and how loud it is.
 *
 * Every key in `AttentionKeyName` must appear here — a test holds that — so a
 * queue added to the rail cannot quietly go missing from the chart, which is
 * the failure mode a second hand-written list always eventually has.
 */
const ATTENTION_PLACEMENT: Readonly<
  Record<AttentionKeyName, { group: OperationsGroupName; severity: OperationsQueue['severity']; href: string }>
> = Object.freeze({
  sellerApplications: { group: 'approvals', severity: 'attention', href: '/sellers?status=SUBMITTED' },
  sellerDocuments: { group: 'approvals', severity: 'attention', href: '/sellers?documents=pending' },
  listingReview: { group: 'approvals', severity: 'attention', href: '/listing-review' },
  brandRequests: { group: 'approvals', severity: 'info', href: '/brand-requests' },
  orderApprovals: { group: 'approvals', severity: 'attention', href: '/orders?approval=PENDING' },
  customerApprovals: { group: 'approvals', severity: 'attention', href: '/customers?status=PENDING_APPROVAL' },
  // A statutory clock is running on these. That is what makes them urgent at
  // any count above zero, rather than attention like the queues around them.
  dataRequests: { group: 'approvals', severity: 'urgent', href: '/data-requests' },
  logisticsExceptions: { group: 'logistics', severity: 'urgent', href: '/logistics/shipments?exception=open' },
  // A customer waiting for an answer is somebody waiting on the business.
  preorderChats: { group: 'approvals', severity: 'attention', href: '/preorder-chats?sort=oldest_unanswered' },
});

// ---------------------------------------------------------------------------
// The faults that have no badge
// ---------------------------------------------------------------------------

interface FaultQueue {
  key: string;
  group: OperationsGroupName;
  permission: PermissionKey;
  severity: OperationsQueue['severity'];
  href: string;
  count: () => Promise<number>;
}

/**
 * How long a payment may sit un-captured before it is worth reconciling.
 *
 * An hour, and it is the same hour `paymentsReport` uses. A payment created
 * ninety seconds ago is a customer still on the provider's page, not a
 * problem, and counting those would put a permanently non-zero number on an
 * operations chart.
 */
const RECONCILE_AFTER_MS = 3_600_000;

/**
 * How many tracked lines are at or below their reorder point.
 *
 * The threshold lives on the PRODUCT and the quantities live on the BALANCE,
 * and available stock is `onHandQty - reservedQty`, which is not a column. So
 * this cannot be a `count()` with a where clause however much one would like
 * it to be: MariaDB 10.4 has no way to express "one column of this row minus
 * another, compared with a column of the joined row" through Prisma's filter
 * language.
 *
 * It is therefore the same walk `inventoryValuation` does, with the pricing
 * left out — `select` rather than `include`, so it fetches four small columns
 * instead of every product row, and it does no BigInt arithmetic. That is the
 * difference between a number this chart can refresh every minute and a
 * valuation report.
 *
 * The three exclusions are `inventoryValuation`'s and are kept identical on
 * purpose: an archived product is not stock anybody reorders, an untracked one
 * has no level to be low, and a threshold of zero means nobody set one. If the
 * two ever disagree, the chart and the Inventory screen it links to disagree.
 */
async function lowStockCount(): Promise<number> {
  const balances = await prisma.inventoryBalance.findMany({
    select: {
      onHandQty: true,
      reservedQty: true,
      product: {
        select: { reorderThreshold: true, archivedAt: true, isStockTracked: true },
      },
    },
  });

  return balances.filter((balance) => {
    const product = balance.product;
    if (product.archivedAt !== null || !product.isStockTracked) return false;
    if (product.reorderThreshold <= 0) return false;

    return balance.onHandQty - balance.reservedQty <= product.reorderThreshold;
  }).length;
}

const FAULTS: readonly FaultQueue[] = Object.freeze([
  {
    key: 'paymentsUnreconciled',
    group: 'payments',
    permission: Permission.PAYMENT_READ,
    severity: 'urgent',
    href: '/payments?state=unreconciled',
    count: () =>
      prisma.paymentTransaction.count({
        where: {
          status: { in: ['CREATED', 'PENDING', 'AUTHORIZED'] },
          createdAt: { lt: new Date(Date.now() - RECONCILE_AFTER_MS) },
        },
      }),
  },
  {
    key: 'paymentWebhooksRejected',
    group: 'payments',
    permission: Permission.PAYMENT_READ,
    severity: 'urgent',
    href: '/payments?state=rejected-webhooks',
    count: () => prisma.paymentEvent.count({ where: { processingStatus: 'REJECTED' } }),
  },
  {
    key: 'scheduleOccurrencesFailed',
    group: 'payments',
    permission: Permission.SCHEDULE_READ,
    severity: 'attention',
    href: '/recurring?status=FAILED',
    // A standing order that could not be charged. Money, not scheduling,
    // which is why it sits under payments rather than in its own group.
    count: () => prisma.scheduleOccurrence.count({ where: { status: 'FAILED' } }),
  },
  {
    key: 'inventoryLowStock',
    group: 'inventory',
    permission: Permission.INVENTORY_READ,
    severity: 'attention',
    href: '/inventory?filter=low-stock',
    count: lowStockCount,
  },
  {
    key: 'erpConnectionsUnhealthy',
    group: 'platform',
    permission: Permission.INTEGRATION_READ,
    severity: 'attention',
    href: '/integrations',
    // ERROR only. PAUSED is somebody's decision, DISABLED is history, and
    // DRAFT was never switched on; counting any of them would leave a number
    // on this chart that no action can clear.
    count: () => prisma.erpConnection.count({ where: { status: 'ERROR' } }),
  },
  {
    key: 'notificationsFailed',
    group: 'platform',
    permission: Permission.SETTINGS_READ,
    severity: 'attention',
    href: '/settings/notifications',
    count: () =>
      prisma.notificationOutbox.count({ where: { status: { in: ['FAILED', 'DEAD'] } } }),
  },
  {
    key: 'jobsDead',
    group: 'platform',
    permission: Permission.SETTINGS_READ,
    severity: 'urgent',
    href: '/settings/jobs',
    count: () => prisma.jobQueue.count({ where: { status: 'DEAD' } }),
  },
]);

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

export interface OperationsViewer {
  permissions: readonly string[];
}

/**
 * What is waiting across the platform, for this member of staff.
 *
 * A count that throws is logged and OMITTED rather than failing the call. A
 * dashboard is the screen somebody opens to find out whether anything is
 * wrong; taking the whole screen down because one of twelve counters could not
 * be computed is the worst possible answer to that question. An omitted queue
 * is absent from the ring exactly as an unpermitted one is, so the total still
 * reconciles with what is drawn.
 */
export async function readOperationsOverview(
  viewer: OperationsViewer,
): Promise<OperationsOverview> {
  const granted = new Set(viewer.permissions);

  const [attention, faults] = await Promise.all([
    readAttention(viewer),
    Promise.all(
      FAULTS.filter((fault) => granted.has(fault.permission)).map(async (fault) => {
        try {
          return { fault, count: await fault.count() };
        } catch (error) {
          logger.error({ err: error, queue: fault.key }, 'operations count failed');
          return null;
        }
      }),
    ),
  ]);

  const queues: OperationsQueue[] = [];

  for (const [key, count] of Object.entries(attention.counts)) {
    const placement = ATTENTION_PLACEMENT[key as AttentionKeyName];
    // A queue the rail knows about and this file does not is a programming
    // error, held by a test. At runtime it is skipped rather than crashing the
    // dashboard over a missing row in a lookup table.
    if (placement === undefined) continue;

    queues.push({ key, group: placement.group, count: count ?? 0, severity: placement.severity, href: placement.href });
  }

  for (const result of faults) {
    if (result === null) continue;
    queues.push({
      key: result.fault.key,
      group: result.fault.group,
      count: result.count,
      severity: result.fault.severity,
      href: result.fault.href,
    });
  }

  const byGroup = Object.values(OperationsGroup).map((group) => ({
    group,
    count: queues
      .filter((queue) => queue.group === group)
      .reduce((sum, queue) => sum + queue.count, 0),
  }));

  return {
    generatedAt: new Date().toISOString(),
    total: queues.reduce((sum, queue) => sum + queue.count, 0),
    queues,
    byGroup,
  };
}

/** Exported for the test that holds every rail queue to having a placement. */
export const ATTENTION_PLACEMENT_KEYS = Object.keys(ATTENTION_PLACEMENT);

// ---------------------------------------------------------------------------
// The AI's view of it
// ---------------------------------------------------------------------------

/**
 * Human-readable names for the queues, for the insights panel only.
 *
 * English, and deliberately not the Admin Panel's translated labels: the model
 * is asked to reason in one language and to answer in the reader's, and the
 * catalogue lives in the frontend anyway. A queue with no entry here falls
 * back to its key, which is ugly and honest.
 */
const QUEUE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  sellerApplications: 'Seller applications waiting for a decision',
  sellerDocuments: 'Seller documents waiting to be accepted or refused',
  listingReview: 'Product listings submitted for review',
  brandRequests: 'Brand requests waiting on the marketplace',
  orderApprovals: 'Orders held for an approver',
  customerApprovals: 'Buyer sign-ups waiting for approval',
  dataRequests: 'Data-subject requests inside their statutory clock',
  logisticsExceptions: 'Consignments in trouble with nobody holding them',
  paymentsUnreconciled: 'Payments taken that no order has recorded',
  paymentWebhooksRejected: 'Payment webhooks the server refused',
  scheduleOccurrencesFailed: 'Scheduled orders that could not be charged',
  inventoryLowStock: 'Stock lines at or below their reorder point',
  erpConnectionsUnhealthy: 'ERP connections out of service',
  notificationsFailed: 'Notifications that could not be delivered',
  jobsDead: 'Background jobs that exhausted their retries',
});

/**
 * The operations overview, as metrics the insights panel may reason about.
 *
 * Derived from the overview object rather than queried again, which is what
 * makes the AI's scope exactly the caller's: a queue this member of staff
 * lacks the grant for is not in `overview.queues`, so it is not in this list,
 * so it cannot be mentioned. The permission check happens once, upstream, and
 * the panel inherits it rather than repeating it.
 *
 * Counts only — no seller name, no company, no order number, no buyer. "Four
 * applications are waiting" is the whole of what the panel needs to say.
 */
export function operationsInsightMetrics(overview: OperationsOverview): InsightMetric[] {
  const metrics: InsightMetric[] = overview.queues.map((queue) => ({
    key: `ops.${queue.key}`,
    label: QUEUE_LABELS[queue.key] ?? queue.key,
    value: queue.count,
    unit: 'items',
    severity: queue.count > 0 ? queue.severity : 'info',
    href: queue.href,
  }));

  metrics.push({
    key: 'ops.total',
    label: 'Everything waiting across the queues you can see',
    value: overview.total,
    unit: 'items',
    severity: 'info',
    href: '/dashboard',
  });

  return metrics;
}
