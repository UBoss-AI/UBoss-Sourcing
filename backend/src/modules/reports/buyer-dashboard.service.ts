/**
 * What a buyer opens their dashboard for.
 *
 * EVERY FIGURE HERE IS A DATABASE AGGREGATE, and every one of them is scoped
 * to the signed-in customer's own profile before it is counted. Neither of
 * those is a convention:
 *
 *   - A dashboard that counts a page of rows is a dashboard that eventually
 *     disagrees with the list it links to, and the disagreement is always
 *     found by the person whose money it is.
 *   - The scope is a `where` clause on every single query in this file, taken
 *     from the session. There is no id parameter anywhere in it, so there is
 *     nowhere for another customer's id to come from.
 *
 * ONE REQUEST, NOT NINE. A screen that fires one request per card is a screen
 * whose cards populate at nine different moments, and on a hospital's
 * connection somebody reads the third figure before the first has arrived.
 *
 * ---
 *
 * WHAT "THE BUYER'S DATA" MEANS HERE, EXACTLY
 *
 * Orders, schedules, spend and deliveries belong to a CUSTOMER PROFILE. They
 * are not shared across a buyer organisation, because in this product they
 * never have been: `orders.customerProfileId` is the owner and
 * `assertOwnership` is written against it.
 *
 * The ERP block is the one exception, and it is not an inconsistency — a
 * connection to a buyer's own SAP belongs to their BuyerOrganization by
 * design, because several colleagues configure and watch one integration. So
 * that block is scoped to the organisation the profile belongs to, and to
 * nothing when the profile belongs to none.
 *
 * Reading those two scopes as one would be the bug. They are different
 * questions about different things and they are kept apart deliberately.
 */
import { Prisma } from '../../generated/prisma/client.js';
import type { OrderStatus } from '../../generated/prisma/enums.js';
import { serialiseMoney } from '../../domain/money.js';
import { prisma } from '../../infra/prisma.js';
import type { InsightMetric } from '../assistant/insights.service.js';
import type { DateWindow } from './report.service.js';

// ---------------------------------------------------------------------------
// The shape
// ---------------------------------------------------------------------------

export interface BuyerOrderStatusRow {
  status: OrderStatus;
  count: number;
}

export interface BuyerUpcomingDelivery {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  /** The promise made at checkout, not an estimate made now. */
  deliveryFrom: string | null;
  deliveryTo: string | null;
  carrier: string | null;
}

export interface BuyerScheduleRow {
  scheduleId: string;
  name: string;
  status: string;
  nextRunAt: string | null;
  /** True where the plan itself, or its next cycle, is waiting on the buyer. */
  needsAttention: boolean;
}

export interface BuyerPaymentAction {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  /** What is still owed on it. */
  outstanding: ReturnType<typeof serialiseMoney>;
  /**
   * Null on an order that never left DRAFT.
   *
   * `orders.placedAt` is nullable because a draft is a basket that was never
   * submitted. No order in one of the two statuses this card lists should have
   * a null here — but the column says it can, so the type says it can, and the
   * screen shows a dash rather than the epoch.
   */
  placedAt: string | null;
}

export interface BuyerErpHealth {
  /** Null where this buyer's account belongs to no organisation. */
  organizationName: string | null;
  connectionCount: number;
  activeCount: number;
  /** Connections in ACTION_REQUIRED or FAILED. The number that wants somebody. */
  unhealthyCount: number;
  /** Events in the dead-letter state, across the organisation's connections. */
  deadLetteredEvents: number;
  lastSyncAt: string | null;
}

export interface BuyerDashboard {
  window: { from: string; to: string };
  /**
   * When these figures were measured.
   *
   * Sent rather than taken from the clock in the browser, so "updated 2
   * minutes ago" measures the data's age rather than the page's.
   */
  generatedAt: string;
  /** Every order in the window, however it ended. The donut's denominator. */
  orderCount: number;
  ordersByStatus: BuyerOrderStatusRow[];
  spend: {
    currency: string;
    /** Settled money only. What was actually taken, not what was invoiced. */
    paid: ReturnType<typeof serialiseMoney>;
    /** Ordered, whether paid or not. */
    ordered: ReturnType<typeof serialiseMoney>;
    refunded: ReturnType<typeof serialiseMoney>;
    /** The same window, immediately before this one. For a change figure. */
    previousPaid: ReturnType<typeof serialiseMoney>;
  };
  schedules: {
    active: number;
    paused: number;
    /** Plans whose next cycle needs the cardholder, or that auto-paused. */
    needsAttention: number;
    upcoming: BuyerScheduleRow[];
  };
  deliveries: {
    /** Promised to arrive inside the next seven days. */
    arrivingSoon: BuyerUpcomingDelivery[];
    /** Shipped, and past the day they were promised for. */
    overdue: number;
  };
  paymentActions: BuyerPaymentAction[];
  erp: BuyerErpHealth;
  recentOrders: {
    orderId: string;
    orderNumber: string;
    status: OrderStatus;
    /** Never null in practice: the query filters drafts out. See the type note above. */
    placedAt: string | null;
    total: ReturnType<typeof serialiseMoney>;
  }[];
}

// ---------------------------------------------------------------------------
// Definitions the dashboard and its drill-downs must agree on
// ---------------------------------------------------------------------------

/**
 * Statuses a buyer has to do something about.
 *
 * `PENDING_PAYMENT` is money the shop is waiting for; `PENDING_APPROVAL` is a
 * colleague's signature. Both are "you", from the buyer's chair, which is why
 * they are one group here and two rows in the table underneath.
 */
export const BUYER_ACTION_STATUSES: readonly OrderStatus[] = Object.freeze([
  'PENDING_PAYMENT',
  'PENDING_APPROVAL',
]);

/** Statuses where the order is being got ready and nobody need do anything. */
export const BUYER_PROCESSING_STATUSES: readonly OrderStatus[] = Object.freeze([
  'CONFIRMED',
  'PROCESSING',
]);

/**
 * How many days ahead "arriving soon" looks.
 *
 * A week, because that is the horizon a procurement officer plans against —
 * and because the same seven days is what `recurringReport` uses for upcoming
 * schedules, so the two cards on this screen mean the same thing by "soon".
 */
const SOON_DAYS = 7;

/** The window of the same length immediately before this one. */
function precedingWindow(window: DateWindow): DateWindow {
  const span = window.to.getTime() - window.from.getTime();
  return { from: new Date(window.from.getTime() - span), to: window.from };
}

// ---------------------------------------------------------------------------
// The query
// ---------------------------------------------------------------------------

/**
 * Everything the buyer dashboard opens with, in one round trip.
 *
 * `customerProfileId` comes from the session and from nowhere else. The route
 * reads it off `request.auth`; nothing in the query string reaches this.
 */
export async function buyerDashboard(
  customerProfileId: string,
  window: DateWindow,
): Promise<BuyerDashboard> {
  const now = new Date();
  const soon = new Date(now.getTime() + SOON_DAYS * 86_400_000);
  const previous = precedingWindow(window);

  /*
   * The scope, written once.
   *
   * Every query below spreads this. Building it here rather than repeating the
   * clause nine times is not tidiness: it is what makes "is every query
   * scoped" answerable by reading one line instead of by auditing nine, and it
   * is why adding a tenth query cannot quietly omit it.
   */
  const mine = { customerProfileId } as const;
  const inWindow = { ...mine, placedAt: { gte: window.from, lte: window.to } };

  const [
    byStatus,
    orderCount,
    totals,
    previousTotals,
    scheduleCounts,
    occurrenceAttention,
    upcomingSchedules,
    arrivingSoon,
    overdue,
    paymentActions,
    recentOrders,
    organisation,
  ] = await Promise.all([
    prisma.order.groupBy({
      by: ['status'],
      where: inWindow,
      _count: { _all: true },
    }),

    prisma.order.count({ where: inWindow }),

    /*
     * Money, as BigInt minor units, summed in the database.
     *
     * `paidMinor` rather than `grandTotalMinor` for the spend figure: what a
     * finance team means by "what have we spent" is money that has left the
     * account, and an unpaid order is not spend. Both are returned, because
     * "what have we committed to" is the other real question.
     */
    prisma.order.aggregate({
      where: inWindow,
      _sum: { paidMinor: true, grandTotalMinor: true, refundedMinor: true },
    }),

    prisma.order.aggregate({
      where: { ...mine, placedAt: { gte: previous.from, lt: previous.to } },
      _sum: { paidMinor: true },
    }),

    prisma.recurringSchedule.groupBy({
      by: ['status'],
      where: mine,
      _count: { _all: true },
    }),

    /*
     * Cycles that cannot proceed without the cardholder.
     *
     * `ACTION_REQUIRED` is the state a 3-D Secure challenge or a bank's
     * re-authentication leaves an occurrence in. Nothing retries it on its
     * own — only the customer can clear it — so it is the single most
     * important number on this screen, and it is counted rather than inferred
     * from the plan's status, because the PLAN is still ACTIVE while one of
     * its cycles is stuck.
     */
    prisma.scheduleOccurrence.count({
      where: {
        status: 'ACTION_REQUIRED',
        schedule: mine,
      },
    }),

    prisma.recurringSchedule.findMany({
      where: { ...mine, status: { in: ['ACTIVE', 'PAUSED'] } },
      orderBy: [{ nextRunAt: 'asc' }],
      take: 6,
      select: {
        id: true,
        name: true,
        status: true,
        nextRunAt: true,
        failureCount: true,
        occurrences: {
          where: { status: 'ACTION_REQUIRED' },
          select: { id: true },
          take: 1,
        },
      },
    }),

    /*
     * Promised to arrive inside the next week.
     *
     * Against `fulfilmentDeliveryTo` — the promise copied onto the order at
     * checkout — rather than against anything computed now. The customer
     * agreed to a date; a dashboard that quietly recalculates it is a
     * dashboard that moves a delivery date without telling anybody.
     */
    prisma.order.findMany({
      where: {
        ...mine,
        status: { in: ['CONFIRMED', 'PROCESSING', 'SHIPPED'] },
        fulfilmentDeliveryTo: { not: null, gte: now, lte: soon },
      },
      orderBy: [{ fulfilmentDeliveryTo: 'asc' }],
      take: 8,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfilmentDeliveryFrom: true,
        fulfilmentDeliveryTo: true,
        fulfilmentCarrier: true,
      },
    }),

    prisma.order.count({
      where: {
        ...mine,
        status: 'SHIPPED',
        fulfilmentDeliveryTo: { not: null, lt: now },
      },
    }),

    /*
     * Orders the buyer has to pay for or get approved.
     *
     * NOT limited to the reporting window, deliberately. An unpaid order from
     * six weeks ago is more urgent than one from this morning, and a window
     * that hid it would mean the card emptied itself the longer the problem
     * went unattended.
     */
    prisma.order.findMany({
      where: { ...mine, status: { in: [...BUYER_ACTION_STATUSES] } },
      orderBy: [{ placedAt: 'asc' }],
      take: 8,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        currency: true,
        grandTotalMinor: true,
        paidMinor: true,
        placedAt: true,
      },
    }),

    prisma.order.findMany({
      // Placed, not drafted. A DRAFT order is a basket that was never
      // submitted, it has no `placedAt`, and listing it under "recent orders"
      // would show a buyer something they did not do.
      where: { ...mine, placedAt: { not: null } },
      orderBy: [{ placedAt: 'desc' }],
      take: 6,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        placedAt: true,
        currency: true,
        grandTotalMinor: true,
      },
    }),

    /*
     * The buyer's own organisation, for the ERP block only.
     *
     * A different scope from everything above — see the file header. `null`
     * for a customer who belongs to no organisation, which is the ordinary
     * case and not an error.
     */
    prisma.buyerOrganizationMember.findUnique({
      where: { customerProfileId },
      select: { organization: { select: { id: true, name: true } } },
    }),
  ]);

  const currency = recentOrders[0]?.currency ?? paymentActions[0]?.currency ?? 'EUR';

  const scheduleCount = (status: string): number =>
    scheduleCounts.find((row) => row.status === status)?._count._all ?? 0;

  const autoPaused = scheduleCounts
    .filter((row) => row.status === 'PAUSED' || row.status === 'FAILED')
    .reduce((sum, row) => sum + row._count._all, 0);

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    generatedAt: now.toISOString(),
    orderCount,
    ordersByStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),

    spend: {
      currency,
      paid: serialiseMoney(totals._sum.paidMinor ?? 0n, currency),
      ordered: serialiseMoney(totals._sum.grandTotalMinor ?? 0n, currency),
      refunded: serialiseMoney(totals._sum.refundedMinor ?? 0n, currency),
      previousPaid: serialiseMoney(previousTotals._sum.paidMinor ?? 0n, currency),
    },

    schedules: {
      active: scheduleCount('ACTIVE'),
      paused: scheduleCount('PAUSED'),
      // A plan auto-paused after repeated failures and a cycle waiting on a
      // bank challenge are both "this needs you", and both are counted.
      needsAttention: occurrenceAttention + autoPaused,
      upcoming: upcomingSchedules.map((schedule) => ({
        scheduleId: schedule.id,
        name: schedule.name,
        status: schedule.status,
        nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
        needsAttention: schedule.occurrences.length > 0 || schedule.failureCount > 0,
      })),
    },

    deliveries: {
      arrivingSoon: arrivingSoon.map((order) => ({
        orderId: order.id,
        orderNumber: order.orderNumber,
        status: order.status,
        deliveryFrom: order.fulfilmentDeliveryFrom?.toISOString() ?? null,
        deliveryTo: order.fulfilmentDeliveryTo?.toISOString() ?? null,
        carrier: order.fulfilmentCarrier,
      })),
      overdue,
    },

    paymentActions: paymentActions.map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      outstanding: serialiseMoney(
        // Floored at zero. An over-payment is a refund question and not a
        // negative amount owed, and "-€40 to pay" on a dashboard is a sentence
        // nobody can act on.
        order.grandTotalMinor - order.paidMinor > 0n
          ? order.grandTotalMinor - order.paidMinor
          : 0n,
        order.currency,
      ),
      placedAt: order.placedAt?.toISOString() ?? null,
    })),

    erp: await erpHealth(organisation?.organization ?? null),

    recentOrders: recentOrders.map((order) => ({
      orderId: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      placedAt: order.placedAt?.toISOString() ?? null,
      total: serialiseMoney(order.grandTotalMinor, order.currency),
    })),
  };
}

/**
 * Is the buyer's own ERP feed working?
 *
 * Scoped to the organisation, which is where a connection lives. A customer
 * who belongs to no organisation gets a block of nulls and zeroes, and the
 * screen says "not connected" rather than showing a grey light that reads as
 * broken.
 */
async function erpHealth(
  organization: { id: string; name: string } | null,
): Promise<BuyerErpHealth> {
  if (organization === null) {
    return {
      organizationName: null,
      connectionCount: 0,
      activeCount: 0,
      unhealthyCount: 0,
      deadLetteredEvents: 0,
      lastSyncAt: null,
    };
  }

  const [byState, deadLettered, lastEvent] = await Promise.all([
    prisma.customerErpConnection.groupBy({
      by: ['state'],
      where: { organizationId: organization.id },
      _count: { _all: true },
    }),

    prisma.customerErpSyncEvent.count({
      where: {
        connection: { organizationId: organization.id },
        // FAILED is this enum's dead-letter state - retries exhausted, or a
        // failure no retry can fix. SKIPPED sits beside it and is NOT one:
        // a paused connection or an outbound-only policy is a decision, not
        // a fault, and counting it would put a permanent number on this card
        // that nobody can clear.
        state: 'FAILED',
      },
    }),

    prisma.customerErpSyncEvent.findFirst({
      where: { connection: { organizationId: organization.id }, state: 'SUCCEEDED' },
      orderBy: { updatedAt: Prisma.SortOrder.desc },
      select: { updatedAt: true },
    }),
  ]);

  const count = (state: string): number =>
    byState.find((row) => row.state === state)?._count._all ?? 0;

  return {
    organizationName: organization.name,
    // DISCONNECTED rows are kept for their history and are not a connection
    // anybody has any more, so they are excluded from the total as well as
    // from the healthy count.
    connectionCount: byState
      .filter((row) => row.state !== 'DISCONNECTED')
      .reduce((sum, row) => sum + row._count._all, 0),
    activeCount: count('ACTIVE'),
    unhealthyCount: count('ACTION_REQUIRED') + count('FAILED'),
    deadLetteredEvents: deadLettered,
    lastSyncAt: lastEvent?.updatedAt.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// The AI's view of it
// ---------------------------------------------------------------------------

/**
 * The buyer dashboard, as metrics the insights panel may reason about.
 *
 * Derived from the dashboard object rather than queried again, and that is the
 * security property: the AI can only ever see figures that this buyer's own
 * screen is already showing them. There is no second query to get the scope
 * wrong on, and adding a metric here cannot widen what the model sees beyond
 * what `buyerDashboard` returned for this profile.
 *
 * NOTHING IDENTIFYING GOES IN. No order numbers, no names, no addresses, no
 * card details, no ERP credentials, no organisation name — counts and money
 * totals only. The panel's job is "what needs your attention", and that
 * question is answerable from quantities. A provider is a third party under
 * Art. 28, and the less that reaches them the smaller that relationship is.
 *
 * `href` is relative to the storefront and is copied onto a suggested action
 * by the insights service. The model never writes one.
 */
export function buyerInsightMetrics(dashboard: BuyerDashboard): InsightMetric[] {
  const status = (name: OrderStatus): number =>
    dashboard.ordersByStatus.find((row) => row.status === name)?.count ?? 0;

  const actionable = BUYER_ACTION_STATUSES.reduce((sum, name) => sum + status(name), 0);

  return [
    {
      key: 'orders.total',
      label: 'Orders placed in this period',
      value: dashboard.orderCount,
      unit: 'orders',
      severity: 'info',
      href: '/account/orders',
    },
    {
      key: 'orders.actionRequired',
      label: 'Orders awaiting your payment or an approval',
      value: actionable,
      unit: 'orders',
      severity: actionable > 0 ? 'urgent' : 'info',
      href: '/account/orders?status=PENDING_PAYMENT',
    },
    {
      key: 'orders.processing',
      label: 'Orders being prepared',
      value: BUYER_PROCESSING_STATUSES.reduce((sum, name) => sum + status(name), 0),
      unit: 'orders',
      severity: 'info',
      href: '/account/orders?status=PROCESSING',
    },
    {
      key: 'orders.shipped',
      label: 'Orders on their way',
      value: status('SHIPPED'),
      unit: 'orders',
      severity: 'info',
      href: '/account/orders?status=SHIPPED',
    },
    {
      key: 'orders.delivered',
      label: 'Orders delivered in this period',
      value: status('DELIVERED'),
      unit: 'orders',
      severity: 'info',
      href: '/account/orders?status=DELIVERED',
    },
    {
      key: 'orders.cancelledOrReturned',
      label: 'Orders cancelled, returned or refunded in this period',
      value: status('CANCELLED') + status('RETURNED') + status('REFUNDED'),
      unit: 'orders',
      severity: 'info',
      href: '/account/orders',
    },
    {
      key: 'deliveries.arrivingSoon',
      label: 'Deliveries promised inside the next seven days',
      value: dashboard.deliveries.arrivingSoon.length,
      unit: 'deliveries',
      severity: 'info',
      href: '/account/orders',
    },
    {
      key: 'deliveries.overdue',
      label: 'Shipped orders past the delivery date they were promised for',
      value: dashboard.deliveries.overdue,
      unit: 'orders',
      severity: dashboard.deliveries.overdue > 0 ? 'attention' : 'info',
      href: '/account/orders?status=SHIPPED',
    },
    {
      key: 'schedules.active',
      label: 'Active scheduled orders',
      value: dashboard.schedules.active,
      unit: 'schedules',
      severity: 'info',
      href: '/account/schedules',
    },
    {
      key: 'schedules.needsAttention',
      label: 'Scheduled orders that cannot run without you',
      value: dashboard.schedules.needsAttention,
      unit: 'schedules',
      severity: dashboard.schedules.needsAttention > 0 ? 'urgent' : 'info',
      href: '/account/schedules',
    },
    /*
     * Money as a MAJOR-unit number, and only here.
     *
     * Everywhere else in this product money is BigInt minor units and crosses
     * the API as a string, because a float cannot be trusted with it. This is
     * the one place that rule is deliberately relaxed and it is safe for a
     * narrow reason: the value is never stored, never compared and never added
     * to anything — it is handed to a model to say a sentence about, alongside
     * its currency, and the exact figure the buyer acts on is the formatted
     * string on the card beside it.
     *
     * Rounded to whole units on the way in, so no fraction of a cent can be
     * misread as a precise total by something that is not precise.
     */
    {
      key: 'spend.paid',
      label: `Money paid in this period, in ${dashboard.spend.currency}`,
      value: Math.round(Number(dashboard.spend.paid.minor) / 100),
      unit: dashboard.spend.currency,
      severity: 'info',
      href: '/account/billing',
    },
    {
      key: 'spend.previousPaid',
      label: `Money paid in the period immediately before this one, in ${dashboard.spend.currency}`,
      value: Math.round(Number(dashboard.spend.previousPaid.minor) / 100),
      unit: dashboard.spend.currency,
      severity: 'info',
      href: '/account/billing',
    },
    {
      key: 'erp.unhealthyConnections',
      label: "Connections to your own ERP that have stopped working or need a person",
      value: dashboard.erp.unhealthyCount,
      unit: 'connections',
      severity: dashboard.erp.unhealthyCount > 0 ? 'attention' : 'info',
      href: '/account/integrations/erp',
    },
    {
      key: 'erp.deadLetteredEvents',
      label: 'Messages to your ERP that failed and will not retry on their own',
      value: dashboard.erp.deadLetteredEvents,
      unit: 'events',
      severity: dashboard.erp.deadLetteredEvents > 0 ? 'attention' : 'info',
      href: '/account/integrations/erp',
    },
  ];
}
