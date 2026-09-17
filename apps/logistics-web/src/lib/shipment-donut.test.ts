/**
 * Guards on the carrier ring's mapping.
 *
 * The failure these exist for is invisible: a status in no group is counted in
 * no segment, so the ring adds up to less than the total and nothing on the
 * screen says why. It still looks like a chart.
 */
import { describe, expect, it } from 'vitest';
import {
  SHIPMENT_SEGMENTS,
  UNGROUPED_SHIPMENT_STATUSES,
  segmentStatuses,
  shipmentSegments,
} from './shipment-donut';
import { STATUS_GROUPS } from './shipment-display';
import type { ShipmentStatus } from './types';

/**
 * Every status the backend can send, from `LogisticsShipmentStatus` in
 * backend/prisma/schema.prisma.
 *
 * Written out rather than derived, deliberately: this is the test's own
 * independent statement of what the backend has, so a status added to the
 * mapping and not to the schema fails here rather than passing vacuously.
 */
const EVERY_STATUS: ShipmentStatus[] = [
  'CREATED',
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTANCE_PENDING',
  'ACCEPTED',
  'PICKUP_SCHEDULED',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELIVERED',
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
  'LOST',
  'CANCELLED',
];

const label = (key: string): string => key;

describe('the carrier segment mapping', () => {
  it('covers every consignment status exactly once', () => {
    const seen = new Map<string, number>();

    for (const segment of SHIPMENT_SEGMENTS) {
      for (const status of segment.statuses) seen.set(status, (seen.get(status) ?? 0) + 1);
    }
    // Counted too, so "deliberately ungrouped" is a positive statement rather
    // than a hole this test happens not to look at.
    for (const status of UNGROUPED_SHIPMENT_STATUSES) {
      seen.set(status, (seen.get(status) ?? 0) + 1);
    }

    const missing = EVERY_STATUS.filter((status) => !seen.has(status));
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1).map(([status]) => status);
    const unknown = [...seen.keys()].filter(
      (status) => !EVERY_STATUS.includes(status as ShipmentStatus),
    );

    expect(missing).toEqual([]);
    expect(duplicated).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('agrees with the filter groups about which statuses exist', () => {
    /*
     * The ring has eight groups and the filter has four, and that difference
     * is deliberate — see the header of shipment-donut.ts. What they must
     * never do is disagree about the SET of statuses, because that would mean
     * one of them was written against a schema the other had moved on from.
     */
    const ring = new Set(SHIPMENT_SEGMENTS.flatMap((segment) => segment.statuses));
    const filter = new Set(STATUS_GROUPS.flatMap((group) => group.statuses));

    expect([...ring].sort()).toEqual([...filter].sort());
  });

  it('leaves out the one status a carrier never sees, exactly as the filter does', () => {
    /*
     * `CREATED` exists only between the marketplace raising a consignment and
     * offering it, so no carrier is assigned and it can never appear in these
     * figures. Both vocabularies leave it out; this asserts they agree about
     * WHICH one, rather than each quietly omitting a different status.
     */
    const ring = new Set(SHIPMENT_SEGMENTS.flatMap((segment) => segment.statuses));
    const filter = new Set(STATUS_GROUPS.flatMap((group) => group.statuses));

    expect(UNGROUPED_SHIPMENT_STATUSES).toEqual(['CREATED']);
    expect(ring.has('CREATED')).toBe(false);
    expect(filter.has('CREATED')).toBe(false);
  });

  it('never gives a failed delivery the treatment of a completed one', () => {
    // The one substitution that would actively mislead a dispatcher, and the
    // reason `DELIVERY_FAILED` and `DELIVERED` are in different segments with
    // different steps rather than in one "finished" bucket.
    const delivered = SHIPMENT_SEGMENTS.find((segment) => segment.key === 'delivered');
    const exception = SHIPMENT_SEGMENTS.find((segment) => segment.key === 'exception');

    expect(delivered?.step).toBe('success');
    expect(exception?.step).toBe('danger');
    expect(exception?.statuses).toContain('DELIVERY_FAILED');
    expect(delivered?.statuses).toEqual(['DELIVERED']);
  });

  it('keeps a return out of the exception segment', () => {
    // A return is a job with a different destination, not a fault to chase.
    const returning = SHIPMENT_SEGMENTS.find((segment) => segment.key === 'returning');

    expect(returning?.step).toBe('warning');
    expect(returning?.statuses).toContain('RETURNED');
    expect(returning?.statuses).toContain('CANCELLED');
  });

  it('does not treat an unanswered offer as progress', () => {
    const awaiting = SHIPMENT_SEGMENTS.find((segment) => segment.key === 'awaitingPickup');

    expect(awaiting?.step).toBe('neutral');
    expect(awaiting?.statuses).toContain('ACCEPTANCE_PENDING');
  });
});

describe('shipmentSegments', () => {
  it('sums the statuses of each group', () => {
    const segments = shipmentSegments(
      [
        { status: 'IN_TRANSIT', count: 5 },
        { status: 'AT_ORIGIN_HUB', count: 2 },
        { status: 'DELIVERED', count: 11 },
        { status: 'DELIVERY_FAILED', count: 1 },
      ],
      label,
    );

    expect(segments.find((segment) => segment.id === 'inTransit')?.value).toBe(7);
    expect(segments.find((segment) => segment.id === 'delivered')?.value).toBe(11);
    expect(segments.find((segment) => segment.id === 'exception')?.value).toBe(1);
  });

  it('returns every group, including the empty ones', () => {
    const segments = shipmentSegments([{ status: 'DELIVERED', count: 3 }], label);

    expect(segments).toHaveLength(SHIPMENT_SEGMENTS.length);
    expect(segments.find((segment) => segment.id === 'exception')?.value).toBe(0);
  });

  it('copes with an empty response', () => {
    const segments = shipmentSegments([], label);

    expect(segments).toHaveLength(SHIPMENT_SEGMENTS.length);
    expect(segments.every((segment) => segment.value === 0)).toBe(true);
  });

  it('accounts for every row a carrier can actually be sent', () => {
    /*
     * The reconciliation property, from the other direction: a per-status
     * response the carrier's own backend sent must be fully represented in the
     * ring, or the total and the segments disagree.
     *
     * `CREATED` is excluded from the fixture rather than from the assertion,
     * because it is excluded from reality: a consignment in that status has no
     * assigned partner, so it cannot appear in a carrier's own figures. If one
     * ever did, the card's own reconciliation line would say so on screen.
     */
    const reachable = EVERY_STATUS.filter(
      (status) => !UNGROUPED_SHIPMENT_STATUSES.includes(status),
    );
    const segments = shipmentSegments(
      reachable.map((status) => ({ status, count: 1 })),
      label,
    );

    expect(segments.reduce((sum, segment) => sum + segment.value, 0)).toBe(reachable.length);
    expect(reachable).toHaveLength(26);
  });
});

describe('segmentStatuses', () => {
  it('drills into exactly the statuses the segment counted', () => {
    for (const segment of SHIPMENT_SEGMENTS) {
      expect(segmentStatuses(segment.key)).toEqual([...segment.statuses]);
    }
  });

  it('is empty for a segment key this build does not know', () => {
    // What a stale link from an older deploy carries. It must clear the filter
    // rather than build a query for a group nobody defined.
    expect(segmentStatuses('nonsense')).toEqual([]);
  });
});
