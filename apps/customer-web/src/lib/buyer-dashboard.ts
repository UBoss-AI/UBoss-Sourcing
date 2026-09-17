/**
 * The buyer dashboard: its shapes, its calls, and how its statuses map onto
 * the ring.
 *
 * Two things live here rather than in the page:
 *
 *   1. **Every path and query key in one place**, the same way
 *      `lib/logistics.ts` does it in the portal. There is no customer id in
 *      any of these paths — the server resolves the profile from the session —
 *      and that absence is the tenant boundary, which is easier to see when
 *      every path is on one screen.
 *   2. **The status-to-segment mapping**, because it is the one thing on the
 *      dashboard that can silently stop being true. It is pure, so a test can
 *      hold it to covering every status the backend can send exactly once.
 */
import { api } from './api';
import type { ChartStep, DonutSegmentInput } from './donut';
import type { Money } from './format';
import type { Insight } from '@/components/dashboard/AiInsightsCard';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * The ten order statuses, exactly as `OrderStatusValues` in
 * backend/src/domain/order-state-machine.ts lists them.
 *
 * Fixed by the SOP and not extendable without a business decision, which is
 * what makes an exhaustive mapping below safe to write.
 */
export type BuyerOrderStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'PENDING_PAYMENT'
  | 'CONFIRMED'
  | 'PROCESSING'
  | 'SHIPPED'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'RETURNED'
  | 'REFUNDED';

export interface BuyerDashboard {
  window: { from: string; to: string };
  generatedAt: string;
  orderCount: number;
  ordersByStatus: { status: BuyerOrderStatus; count: number }[];
  spend: {
    currency: string;
    paid: Money;
    ordered: Money;
    refunded: Money;
    previousPaid: Money;
  };
  schedules: {
    active: number;
    paused: number;
    needsAttention: number;
    upcoming: {
      scheduleId: string;
      name: string;
      status: string;
      nextRunAt: string | null;
      needsAttention: boolean;
    }[];
  };
  deliveries: {
    arrivingSoon: {
      orderId: string;
      orderNumber: string;
      status: BuyerOrderStatus;
      deliveryFrom: string | null;
      deliveryTo: string | null;
      carrier: string | null;
    }[];
    overdue: number;
  };
  paymentActions: {
    orderId: string;
    orderNumber: string;
    status: BuyerOrderStatus;
    outstanding: Money;
    placedAt: string | null;
  }[];
  erp: {
    organizationName: string | null;
    connectionCount: number;
    activeCount: number;
    unhealthyCount: number;
    deadLetteredEvents: number;
    lastSyncAt: string | null;
  };
  recentOrders: {
    orderId: string;
    orderNumber: string;
    status: BuyerOrderStatus;
    placedAt: string | null;
    total: Money;
  }[];
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export function dashboardKey(window: { from: string; to: string }): readonly unknown[] {
  /*
   * The window is IN the key, which is what protects against a stale response
   * when somebody changes the range twice quickly.
   *
   * A reply for the old window is cached under the old key and is never the
   * one rendered, because the component reads the key it is currently asking
   * for. There is no request-sequence number and no `isLatest` flag anywhere
   * in this dashboard, and there does not need to be.
   */
  return ['buyer-dashboard', window.from, window.to] as const;
}

export function fetchDashboard(window: { from: string; to: string }): Promise<BuyerDashboard> {
  const query = new URLSearchParams({ from: window.from, to: window.to });
  return api.get<BuyerDashboard>(`/account/dashboard?${query.toString()}`);
}

export interface InsightAsk {
  window: { from: string; to: string };
  question?: string | undefined;
  language?: string | undefined;
  segment?: string | null | undefined;
}

export function requestInsight(ask: InsightAsk): Promise<Insight> {
  return api.post<Insight>('/account/dashboard/insights', {
    from: ask.window.from,
    to: ask.window.to,
    ...(ask.question === undefined ? {} : { question: ask.question }),
    ...(ask.language === undefined ? {} : { language: ask.language }),
    ...(ask.segment === undefined || ask.segment === null ? {} : { segment: ask.segment }),
  });
}

// ---------------------------------------------------------------------------
// The ring
// ---------------------------------------------------------------------------

/**
 * The five groups a buyer's orders fall into, from a buyer's chair.
 *
 * NOT the ten database statuses. A customer does not think in terms of
 * `PENDING_PAYMENT` and `PENDING_APPROVAL`; they think "you are waiting for
 * something from me". And ten segments is not a chart — three of them would be
 * slivers on any real dataset, and the reader's question is "is anything stuck
 * on me", which is one segment.
 *
 * Keyed by group rather than by status, and the key is what goes in the URL
 * and into the order list's filter, so the ring and the list it filters agree
 * about what each group contains.
 */
export type BuyerSegmentKey = 'action' | 'processing' | 'transit' | 'delivered' | 'closed';

/**
 * Which statuses each group holds.
 *
 * Exhaustive over `BuyerOrderStatus` and held to that by a test, because the
 * failure is invisible: a status in no group is counted in no segment, and the
 * ring simply adds up to less than the total with nothing on screen saying so.
 *
 * `DRAFT` is deliberately absent from every group AND from the dashboard's
 * denominator — the backend's window filters on `placedAt`, which a draft does
 * not have. A draft is a basket somebody abandoned, not an order.
 */
export const BUYER_SEGMENTS: readonly {
  key: BuyerSegmentKey;
  statuses: readonly BuyerOrderStatus[];
  step: ChartStep;
}[] = [
  /*
   * Waiting on the buyer. Amber, and first, because it is the only group on
   * this ring the reader can do anything about.
   *
   * `warning` rather than a step of the ordinal ramp: this is not an early
   * stage of a pipeline, it is a stop. Colouring it as "step one" would say
   * the order is progressing when it is not.
   */
  { key: 'action', statuses: ['PENDING_PAYMENT', 'PENDING_APPROVAL'], step: 'warning' },
  { key: 'processing', statuses: ['CONFIRMED', 'PROCESSING'], step: 3 },
  { key: 'transit', statuses: ['SHIPPED'], step: 5 },
  { key: 'delivered', statuses: ['DELIVERED'], step: 'success' },
  /*
   * Cancelled, returned and refunded, as one segment.
   *
   * Three outcomes that are the same fact for this chart — the order did not
   * complete — and three reds touching each other in a ring are one red to
   * every reader. The table under the chart keeps them apart, which is where
   * a breakdown belongs.
   *
   * `danger`, and never the same treatment as `delivered`. That is the one
   * substitution that would make a refund read as a successful delivery.
   */
  { key: 'closed', statuses: ['CANCELLED', 'RETURNED', 'REFUNDED'], step: 'danger' },
];

/** `DRAFT` belongs to no segment, on purpose. See `BUYER_SEGMENTS`. */
export const UNGROUPED_BUYER_STATUSES: readonly BuyerOrderStatus[] = ['DRAFT'];

/**
 * Fold the server's per-status counts into the five groups.
 *
 * Pure, and here rather than in the component, so the one thing that can go
 * quietly wrong is testable. Same reasoning and same shape as
 * `groupStatusCounts` in the carrier portal.
 */
export function buyerSegments(
  rows: readonly { status: BuyerOrderStatus; count: number }[],
  label: (key: BuyerSegmentKey) => string,
): DonutSegmentInput[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + row.count);

  return BUYER_SEGMENTS.map((segment) => ({
    id: segment.key,
    label: label(segment.key),
    value: segment.statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0),
    step: segment.step,
  }));
}

/**
 * The order-list query a segment drills into.
 *
 * Built from the SAME `BUYER_SEGMENTS` table the ring is drawn from, so a
 * segment showing four orders cannot link to a list showing three. That is the
 * property the prompt calls "equivalent filter definitions", and the way to
 * guarantee it is to have one definition rather than two that agree today.
 */
export function segmentOrderQuery(key: BuyerSegmentKey): string {
  const segment = BUYER_SEGMENTS.find((entry) => entry.key === key);
  if (segment === undefined) return '';

  return new URLSearchParams({ status: segment.statuses.join(',') }).toString();
}
