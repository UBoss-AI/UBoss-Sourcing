/**
 * Platform operations: the shapes, the call, and how the queues group.
 *
 * The admin dashboard's hero chart answers one question — "what should the
 * team do first this morning" — and the grouping IS the answer. Twelve
 * counters in a flat row read as one texture and nobody finds "3 cold-chain
 * exceptions" in it.
 *
 * The grouping is decided on the SERVER, in
 * backend/src/modules/notifications/operations-overview.service.ts, and
 * arrives on each queue. This file only translates it and decides what colour
 * each group takes, so the panel cannot invent a grouping the server does not
 * have — which is the thing that would make the ring and the queues disagree.
 */
import { api } from './api';
import type { ChartStep, DonutSegmentInput } from './donut';
import type { TranslationKey } from '@/i18n/i18n-context';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Mirrors `OperationsGroup` on the backend. */
export type OperationsGroupName =
  | 'approvals'
  | 'payments'
  | 'inventory'
  | 'logistics'
  | 'platform';

export interface OperationsQueue {
  key: string;
  group: OperationsGroupName;
  count: number;
  severity: 'info' | 'attention' | 'urgent';
  /** Where the work is done. Relative to this app. */
  href: string;
}

export interface OperationsOverview {
  generatedAt: string;
  total: number;
  queues: OperationsQueue[];
  byGroup: { group: OperationsGroupName; count: number }[];
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export const OPERATIONS_QUERY_KEY = ['admin-operations'] as const;

export function fetchOperations(): Promise<OperationsOverview> {
  return api.get<OperationsOverview>('/admin/operations');
}

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/**
 * Which colour each group takes, and why it is not the ordinal ramp.
 *
 * These five are NOT a sequence. "Approvals" does not come before "payments"
 * in any process — they are different kinds of work happening at once — so
 * drawing them on a light-to-dark ramp would encode an order that does not
 * exist, which is exactly the misuse the ramp's own token comment warns about.
 *
 * So each takes a semantic colour instead, chosen from what the work IS:
 *
 *   - approvals  — somebody is WAITING on the team. Amber: it wants a person
 *                  today, and it is the only group here that is somebody
 *                  else's business being held up.
 *   - payments   — money did not settle. Red, always, at any count.
 *   - inventory  — stock is low. A step of the blue ramp: it is a level
 *                  crossing a threshold rather than a fault.
 *   - logistics  — a consignment is in trouble. Red: on this product that
 *                  usually means a cold chain.
 *   - platform   — the machinery. Grey, because it is nobody's business
 *                  process — and grey rather than absent, because a dead job
 *                  queue is how everything else quietly stops.
 *
 * `payments` and `logistics` share `danger` and that is deliberate: they are
 * the same urgency and the legend tells them apart in words. What none of them
 * shares is `success`, because nothing on this chart is a good outcome — every
 * segment is work that has not been done.
 */
const GROUP_STEP: Readonly<Record<OperationsGroupName, ChartStep>> = Object.freeze({
  approvals: 'warning',
  payments: 'danger',
  inventory: 3,
  logistics: 'danger',
  platform: 'neutral',
});

/** The label key for each group. */
export const GROUP_LABELS: Readonly<Record<OperationsGroupName, TranslationKey>> = Object.freeze({
  approvals: 'operations.group.approvals',
  payments: 'operations.group.payments',
  inventory: 'operations.group.inventory',
  logistics: 'operations.group.logistics',
  platform: 'operations.group.platform',
});

/** Where a group's segment leads, when a single screen covers it. */
const GROUP_HREF: Readonly<Record<OperationsGroupName, string | undefined>> = Object.freeze({
  approvals: undefined,
  payments: '/payments',
  inventory: '/inventory?filter=low-stock',
  logistics: '/logistics/shipments?exception=open',
  platform: undefined,
});

/**
 * The five ring segments.
 *
 * A group the caller can see NO queue in is dropped entirely rather than drawn
 * as zero. That is not the same decision the buyer's ring makes, and the
 * difference is the point: a buyer always has all five order groups, so a zero
 * there is a fact. Here, an absent group means "you do not hold the grant for
 * anything in it", and drawing it as zero would tell a warehouse manager that
 * no seller applications are waiting — which is a disclosure, and a false one.
 *
 * A group with queues that all happen to be empty IS drawn at zero, because
 * that genuinely is "nothing waiting".
 */
export function operationsSegments(
  overview: OperationsOverview,
  label: (group: OperationsGroupName) => string,
): DonutSegmentInput[] {
  const visible = new Set(overview.queues.map((queue) => queue.group));

  return overview.byGroup
    .filter((row) => visible.has(row.group))
    .map((row) => ({
      id: row.group,
      label: label(row.group),
      value: row.count,
      step: GROUP_STEP[row.group],
      to: GROUP_HREF[row.group],
    }));
}

/** The queues inside one group, largest first. For the drill-down list. */
export function queuesInGroup(
  overview: OperationsOverview,
  group: string | null,
): OperationsQueue[] {
  const rows =
    group === null
      ? [...overview.queues]
      : overview.queues.filter((queue) => queue.group === group);

  /*
   * Ordered by urgency and then by size, which is the order somebody works
   * down them — not alphabetically, and not by the order the server happened
   * to resolve its promises in.
   *
   * A queue holding nothing sorts last whatever its severity. It is still
   * listed, because "no data-subject requests are waiting" is worth seeing on
   * the screen that exists to tell you what is waiting.
   */
  const rank = { urgent: 0, attention: 1, info: 2 } as const;

  return rows.sort((a, b) => {
    if (a.count === 0 !== (b.count === 0)) return a.count === 0 ? 1 : -1;
    return rank[a.severity] - rank[b.severity] || b.count - a.count;
  });
}

/** The label key for one queue. A key this build does not know shows its id. */
export const QUEUE_LABELS: Readonly<Record<string, TranslationKey>> = Object.freeze({
  sellerApplications: 'operations.queue.sellerApplications',
  sellerDocuments: 'operations.queue.sellerDocuments',
  listingReview: 'operations.queue.listingReview',
  brandRequests: 'operations.queue.brandRequests',
  orderApprovals: 'operations.queue.orderApprovals',
  customerApprovals: 'operations.queue.customerApprovals',
  dataRequests: 'operations.queue.dataRequests',
  logisticsExceptions: 'operations.queue.logisticsExceptions',
  preorderChats: 'operations.queue.preorderChats',
  paymentsUnreconciled: 'operations.queue.paymentsUnreconciled',
  paymentWebhooksRejected: 'operations.queue.paymentWebhooksRejected',
  scheduleOccurrencesFailed: 'operations.queue.scheduleOccurrencesFailed',
  inventoryLowStock: 'operations.queue.inventoryLowStock',
  erpConnectionsUnhealthy: 'operations.queue.erpConnectionsUnhealthy',
  notificationsFailed: 'operations.queue.notificationsFailed',
  jobsDead: 'operations.queue.jobsDead',
});
