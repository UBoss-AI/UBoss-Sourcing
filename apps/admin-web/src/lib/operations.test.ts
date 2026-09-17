/**
 * Guards on the operations ring.
 *
 * Two of these are about authorization showing through correctly, which is the
 * property most likely to be broken by an innocent-looking change to the
 * chart: a group drawn at zero because its queues are absent would tell a
 * warehouse manager that no seller applications are waiting, which is both a
 * disclosure and a false statement.
 */
import { describe, expect, it } from 'vitest';
import {
  operationsSegments,
  queuesInGroup,
  type OperationsOverview,
  type OperationsQueue,
} from './operations';

const label = (group: string): string => group;

function queue(overrides: Partial<OperationsQueue> & Pick<OperationsQueue, 'key' | 'group'>): OperationsQueue {
  return { count: 0, severity: 'info', href: '/', ...overrides };
}

/** What a member of staff with every grant is sent. */
function fullOverview(): OperationsOverview {
  const queues: OperationsQueue[] = [
    queue({ key: 'listingReview', group: 'approvals', count: 12, severity: 'attention', href: '/listing-review' }),
    queue({ key: 'dataRequests', group: 'approvals', count: 2, severity: 'urgent', href: '/data-requests' }),
    queue({ key: 'paymentsUnreconciled', group: 'payments', count: 3, severity: 'urgent', href: '/payments' }),
    queue({ key: 'inventoryLowStock', group: 'inventory', count: 7, severity: 'attention', href: '/inventory' }),
    queue({ key: 'logisticsExceptions', group: 'logistics', count: 1, severity: 'urgent', href: '/logistics' }),
    queue({ key: 'jobsDead', group: 'platform', count: 0, severity: 'urgent', href: '/settings' }),
  ];

  return {
    generatedAt: '2026-09-17T09:00:00.000Z',
    total: queues.reduce((sum, row) => sum + row.count, 0),
    queues,
    byGroup: [
      { group: 'approvals', count: 14 },
      { group: 'payments', count: 3 },
      { group: 'inventory', count: 7 },
      { group: 'logistics', count: 1 },
      { group: 'platform', count: 0 },
    ],
  };
}

describe('operationsSegments', () => {
  it('draws one segment per group the caller can see', () => {
    const segments = operationsSegments(fullOverview(), label);

    expect(segments.map((segment) => segment.id)).toEqual([
      'approvals',
      'payments',
      'inventory',
      'logistics',
      'platform',
    ]);
  });

  it('omits a group the caller holds no queue in, rather than drawing a zero', () => {
    /*
     * The authorization property. `/admin/operations` leaves a queue out
     * entirely when the caller lacks the acting grant — absent, not zero —
     * and the chart has to carry that through. Drawing "Approvals: 0" for a
     * warehouse manager would state that nothing is waiting in a queue they
     * are not allowed to know about.
     */
    const overview = fullOverview();
    const restricted: OperationsOverview = {
      ...overview,
      queues: overview.queues.filter((row) => row.group === 'inventory'),
      byGroup: overview.byGroup,
    };

    const segments = operationsSegments(restricted, label);

    expect(segments.map((segment) => segment.id)).toEqual(['inventory']);
  });

  it('still draws a visible group whose queues happen to be empty', () => {
    // The other half of the same rule. `platform` holds one queue at zero,
    // which genuinely is "nothing waiting" and must be shown as such.
    const segments = operationsSegments(fullOverview(), label);
    const platform = segments.find((segment) => segment.id === 'platform');

    expect(platform).toBeDefined();
    expect(platform?.value).toBe(0);
  });

  it('never gives an operational queue the colour of a completed thing', () => {
    // Nothing on this chart is a good outcome — every segment is work that has
    // not been done — so `success` must never appear on it.
    const segments = operationsSegments(fullOverview(), label);

    expect(segments.every((segment) => segment.step !== 'success')).toBe(true);
  });

  it('keeps payment and delivery trouble at the same urgency', () => {
    const segments = operationsSegments(fullOverview(), label);

    expect(segments.find((segment) => segment.id === 'payments')?.step).toBe('danger');
    expect(segments.find((segment) => segment.id === 'logistics')?.step).toBe('danger');
  });

  it('reconciles with the total the ring is measured against', () => {
    const overview = fullOverview();
    const segments = operationsSegments(overview, label);

    // The server sums the queues it returned, so the ring accounts for the
    // whole of its own denominator by construction.
    expect(segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(overview.total);
  });
});

describe('queuesInGroup', () => {
  it('lists only the chosen group, never merging domains', () => {
    /*
     * A failed scheduled charge and a rejected payment webhook are both money,
     * and they are fixed on different screens by different people. The chart
     * may group them; the list must not roll them together into one row.
     */
    const rows = queuesInGroup(fullOverview(), 'approvals');

    expect(rows.map((row) => row.key)).toEqual(['dataRequests', 'listingReview']);
  });

  it('puts the urgent work first, largest first within a severity', () => {
    const rows = queuesInGroup(fullOverview(), null);

    // The three urgent queues lead, ordered by size among themselves: 3
    // payments, then 2 data requests, then 1 exception. Severity decides the
    // band; size decides the order inside it.
    expect(rows.slice(0, 3).map((row) => row.key)).toEqual([
      'paymentsUnreconciled',
      'dataRequests',
      'logisticsExceptions',
    ]);

    // Then the `attention` band, again largest first.
    expect(rows.slice(3, 5).map((row) => row.key)).toEqual(['listingReview', 'inventoryLowStock']);

    // `jobsDead` is urgent AND empty, so it sorts behind everything holding
    // something: a red chip on a queue with nothing in it teaches people to
    // ignore red.
    expect(rows.at(-1)?.key).toBe('jobsDead');
  });

  it('keeps an empty queue in the list rather than hiding it', () => {
    // "No data-subject requests are waiting" is worth seeing on the screen
    // whose whole job is to say what is waiting.
    const rows = queuesInGroup(fullOverview(), 'platform');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(0);
  });

  it('takes every destination from the server, not from a table here', () => {
    // Which is what makes "clicking a segment opens the right queue" true by
    // construction: the thing that counted the rows says where they live.
    const overview = fullOverview();
    const rows = queuesInGroup(overview, null);

    for (const row of rows) {
      expect(row.href).toBe(overview.queues.find((q) => q.key === row.key)?.href);
    }
  });

  it('shows everything when nothing is selected', () => {
    expect(queuesInGroup(fullOverview(), null)).toHaveLength(6);
  });
});
