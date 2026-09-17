/**
 * Guards on the buyer ring's mapping.
 *
 * The failure these exist for is invisible on screen: a status that belongs to
 * no segment is counted in no segment, so the ring adds up to less than the
 * total and nothing says so. It looks like a chart.
 */
import { describe, expect, it } from 'vitest';
import {
  BUYER_SEGMENTS,
  UNGROUPED_BUYER_STATUSES,
  buyerSegments,
  segmentOrderQuery,
  type BuyerOrderStatus,
} from './buyer-dashboard';

/**
 * Every status the backend can send, from `OrderStatusValues` in
 * backend/src/domain/order-state-machine.ts.
 *
 * Written out rather than derived, deliberately: this list is the test's
 * independent statement of what the backend has, so a status added to the
 * mapping and not to the state machine fails here rather than passing
 * vacuously.
 */
const EVERY_STATUS: BuyerOrderStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
  'REFUNDED',
];

const label = (key: string): string => key;

describe('the buyer segment mapping', () => {
  it('covers every order status exactly once', () => {
    const seen = new Map<string, number>();

    for (const segment of BUYER_SEGMENTS) {
      for (const status of segment.statuses) {
        seen.set(status, (seen.get(status) ?? 0) + 1);
      }
    }
    for (const status of UNGROUPED_BUYER_STATUSES) {
      seen.set(status, (seen.get(status) ?? 0) + 1);
    }

    const missing = EVERY_STATUS.filter((status) => !seen.has(status));
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([status]) => status);
    const unknown = [...seen.keys()].filter(
      (status) => !EVERY_STATUS.includes(status as BuyerOrderStatus),
    );

    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('never colours a cancelled order the way it colours a delivered one', () => {
    /*
     * The one substitution that would actively mislead. A buyer glancing at
     * this ring has to be able to tell "arrived" from "did not arrive" without
     * reading the legend, and green for both is how a refund looks like a
     * success.
     */
    const delivered = BUYER_SEGMENTS.find((segment) => segment.key === 'delivered');
    const closed = BUYER_SEGMENTS.find((segment) => segment.key === 'closed');

    expect(delivered?.step).toBe('success');
    expect(closed?.step).toBe('danger');
    expect(delivered?.step).not.toBe(closed?.step);
  });

  it('does not treat "waiting on you" as a stage of progress', () => {
    // `warning`, not step 1. An order awaiting payment is stopped, and the
    // ordinal ramp means "this far along" — which would be a lie here.
    expect(BUYER_SEGMENTS.find((segment) => segment.key === 'action')?.step).toBe('warning');
  });
});

describe('buyerSegments', () => {
  it('sums the statuses of each group', () => {
    const segments = buyerSegments(
      [
        { status: 'PENDING_PAYMENT', count: 2 },
        { status: 'PENDING_APPROVAL', count: 1 },
        { status: 'SHIPPED', count: 4 },
        { status: 'DELIVERED', count: 10 },
      ],
      label,
    );

    expect(segments.find((segment) => segment.id === 'action')?.value).toBe(3);
    expect(segments.find((segment) => segment.id === 'transit')?.value).toBe(4);
    expect(segments.find((segment) => segment.id === 'delivered')?.value).toBe(10);
  });

  it('returns every group, including the empty ones', () => {
    const segments = buyerSegments([{ status: 'DELIVERED', count: 3 }], label);

    // A group that vanishes when it empties means a buyer cannot tell "nothing
    // is waiting on me" from "this screen does not track that".
    expect(segments).toHaveLength(BUYER_SEGMENTS.length);
    expect(segments.find((segment) => segment.id === 'action')?.value).toBe(0);
  });

  it('ignores a draft, which is a basket rather than an order', () => {
    const segments = buyerSegments(
      [
        { status: 'DRAFT', count: 7 },
        { status: 'DELIVERED', count: 1 },
      ],
      label,
    );

    expect(segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(1);
  });

  it('copes with an empty response', () => {
    const segments = buyerSegments([], label);

    expect(segments).toHaveLength(BUYER_SEGMENTS.length);
    expect(segments.every((segment) => segment.value === 0)).toBe(true);
  });
});

describe('segmentOrderQuery', () => {
  it('filters the list on exactly the statuses the segment counted', () => {
    /*
     * The property that keeps a drill-down honest: the ring says four and the
     * list it opens shows four. Both come from `BUYER_SEGMENTS`, so they
     * cannot agree today and diverge next month.
     */
    for (const segment of BUYER_SEGMENTS) {
      const query = new URLSearchParams(segmentOrderQuery(segment.key));
      expect(query.get('status')?.split(',')).toEqual([...segment.statuses]);
    }
  });

  it('is empty for a segment key that does not exist', () => {
    // What a stale URL from an older build carries. It must clear the filter
    // rather than build a query for a group nobody defined.
    expect(segmentOrderQuery('nonsense' as never)).toBe('');
  });
});
