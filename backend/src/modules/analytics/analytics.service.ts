/**
 * Privacy-first product analytics (checklist Section 17 and LIVE-020).
 *
 * WHAT IS COUNTED
 *
 * The storefront and the Seller Hub send event names from a fixed list, with
 * the ROUTE PATTERN they happened on ("/product/:slug"). This service adds
 * one to a per-day counter and keeps nothing else: no user, no session, no
 * cookie, no IP address. A pattern that still looks like it carries an id is
 * refused, so a slip in a client cannot turn a counter into a trail.
 *
 * WHY IT CAN BE TRUSTED
 *
 * `reconcileAnalytics` compares the client-reported events that stand for a
 * business transaction with the tables that ARE the transaction: confirmed
 * checkouts against one-time orders placed, RFQ submissions against requests
 * submitted, return and dispute submissions against those rows. The source
 * table is always the authority. The client count is expected to be lower -
 * a browser with Do Not Track sends nothing, a closed tab loses its last
 * batch - and the report says how much lower, so a sudden gap (a broken page,
 * a client release that stopped sending) is visible rather than silent.
 *
 * Days are UTC days, for both sides of every comparison.
 */
import { badRequest, ErrorCode } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';

/** Every event a client may send. Anything else is refused. */
export const ANALYTICS_EVENTS = [
  'screen_view',
  'search_submitted',
  'filter_applied',
  'checkout_started',
  'checkout_completed',
  'rfq_started',
  'rfq_submitted',
  'return_requested',
  'dispute_opened',
  'quick_start_used',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

export interface IncomingEvent {
  event: AnalyticsEventName;
  screen: string;
}

/** A route pattern: lower-case path segments or `:params`, nothing that looks like an id. */
const PATTERN = /^(\/[a-z0-9._:-]{0,60})*\/?$/;
const LOOKS_LIKE_ID = /\/([0-9A-HJKMNP-TV-Z]{26}|\d{3,}|[0-9a-f]{8}-[0-9a-f-]{27})(\/|$)/i;

export function surfaceOf(screen: string): 'STOREFRONT' | 'SELLER_HUB' | 'AGENCY' {
  if (screen.startsWith('/seller')) return 'SELLER_HUB';
  if (screen.startsWith('/inspection') || screen.startsWith('/agency')) return 'AGENCY';
  return 'STOREFRONT';
}

function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** Count a batch. Returns how many events were accepted. */
export async function recordEvents(events: IncomingEvent[], now: Date = new Date()): Promise<number> {
  for (const { screen } of events) {
    if (screen !== '' && (!PATTERN.test(screen) || LOOKS_LIKE_ID.test(screen))) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A screen must be a route pattern, not an address.', [
        { field: 'screen', code: 'NOT_A_PATTERN' },
      ]);
    }
  }
  const grouped = new Map<string, { event: string; screen: string; count: number }>();
  for (const { event, screen } of events) {
    const key = `${event}\u0000${screen}`;
    const entry = grouped.get(key) ?? { event, screen, count: 0 };
    entry.count += 1;
    grouped.set(key, entry);
  }
  const day = utcDay(now);
  for (const { event, screen, count } of grouped.values()) {
    await prisma.$executeRaw`
      INSERT INTO analytics_daily_counts (day, event, screen, surface, count, createdAt, updatedAt)
      VALUES (${day}, ${event}, ${screen}, ${surfaceOf(screen)}, ${count}, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE count = count + VALUES(count), updatedAt = CURRENT_TIMESTAMP(3)`;
  }
  return events.length;
}

export interface DayRange {
  from: Date;
  /** Inclusive. */
  to: Date;
}

function rangeOf(range: DayRange): { gte: Date; lt: Date } {
  const gte = utcDay(range.from);
  const lt = new Date(utcDay(range.to).getTime() + 86_400_000);
  if (lt.getTime() - gte.getTime() > 366 * 86_400_000 || lt <= gte) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Choose a range of one day to one year.', [{ field: 'from', code: 'RANGE' }]);
  }
  return { gte, lt };
}

/** Totals per event and the most viewed screens, for the range. */
export async function analyticsSummary(range: DayRange) {
  const { gte, lt } = rangeOf(range);
  const rows = await prisma.analyticsDailyCount.groupBy({
    by: ['event', 'surface'],
    where: { day: { gte, lt } },
    _sum: { count: true },
  });
  const screens = await prisma.analyticsDailyCount.groupBy({
    by: ['screen', 'surface'],
    where: { day: { gte, lt }, event: 'screen_view' },
    _sum: { count: true },
    orderBy: { _sum: { count: 'desc' } },
    take: 20,
  });
  return {
    from: gte.toISOString().slice(0, 10),
    to: new Date(lt.getTime() - 86_400_000).toISOString().slice(0, 10),
    events: rows.map((row) => ({ event: row.event, surface: row.surface, count: row._sum.count ?? 0 })),
    topScreens: screens.map((row) => ({ screen: row.screen, surface: row.surface, views: row._sum.count ?? 0 })),
  };
}

async function eventCount(event: AnalyticsEventName, gte: Date, lt: Date): Promise<number> {
  const sum = await prisma.analyticsDailyCount.aggregate({ where: { event, day: { gte, lt } }, _sum: { count: true } });
  return sum._sum.count ?? 0;
}

/**
 * Client-reported events against the source transactions, for the range.
 * `coverage` is analytics / source as a whole percentage, null when the source
 * had nothing. A value above 100 means the client over-reported (a page that
 * sends twice), which is a defect to fix; a value far below the usual is a
 * page that stopped sending.
 */
export async function reconcileAnalytics(range: DayRange) {
  const { gte, lt } = rangeOf(range);
  const created = { gte, lt };
  const pairs: [AnalyticsEventName, string, Promise<number>][] = [
    ['checkout_completed', 'orders.ONE_TIME', prisma.order.count({ where: { source: 'ONE_TIME', createdAt: created } })],
    ['rfq_submitted', 'rfq_requests.submittedAt', prisma.rfqRequest.count({ where: { submittedAt: created } })],
    ['return_requested', 'return_requests', prisma.returnRequest.count({ where: { createdAt: created } })],
    ['dispute_opened', 'disputes', prisma.dispute.count({ where: { createdAt: created } })],
  ];
  const rows = [];
  for (const [event, source, sourceCount] of pairs) {
    const analytics = await eventCount(event, gte, lt);
    const actual = await sourceCount;
    rows.push({
      event,
      source,
      analytics,
      sourceCount: actual,
      difference: analytics - actual,
      coverage: actual === 0 ? null : Math.round((analytics / actual) * 100),
      overReported: analytics > actual,
    });
  }
  return { from: gte.toISOString().slice(0, 10), to: new Date(lt.getTime() - 86_400_000).toISOString().slice(0, 10), timeZone: 'UTC', rows };
}
