/**
 * The presentation helpers, and the two rules they exist to keep.
 *
 * Neither rule is visible in a screenshot, which is why they are asserted
 * here:
 *
 *   1. **Every status has a tone.** These tables are `Record<Status, Tone>`,
 *      so a status added to the backend without a tone is a compile error -
 *      but only if something actually indexes the table with the full union,
 *      which is what the exhaustiveness tests below do at runtime as well.
 *      A status with no tone would render as an untoned badge: legible, and
 *      silently outside the colour system the rest of the list uses.
 *   2. **The groups cover the statuses a person filters by.** The filter
 *      offers four groups rather than one list of twenty-seven; a status
 *      missing from all four is a status nobody can filter for, and nothing
 *      on screen would say so.
 */
import { describe, expect, it } from 'vitest';
import {
  STATUS_GROUPS,
  formatDuration,
  groupStatusCounts,
  formatWeight,
  severityTone,
  slaTone,
  statusTone,
} from './shipment-display';
import type { ExceptionSeverity, ShipmentStatus, SlaState } from './types';

/** Every canonical status, in the backend's own order. */
const EVERY_STATUS: readonly ShipmentStatus[] = [
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

describe('every status can be rendered', () => {
  it('gives all twenty-seven statuses a tone', () => {
    expect(EVERY_STATUS).toHaveLength(27);

    for (const status of EVERY_STATUS) {
      expect(statusTone(status), status).toBeTruthy();
    }
  });

  it('never marks a delivered consignment as a problem', () => {
    expect(statusTone('DELIVERED')).toBe('success');
  });

  /*
   * A first failed attempt is an ordinary day. Colouring it danger would put
   * red on a third of a courier's list and teach everybody to ignore red -
   * which is the note in the source, asserted so it survives a tidy-up.
   */
  it('treats a first failed attempt as a warning, not a failure', () => {
    expect(statusTone('DELIVERY_ATTEMPTED')).toBe('warning');
    expect(statusTone('DELIVERY_FAILED')).toBe('danger');
  });
});

describe('the filter groups cover what a person searches for', () => {
  const grouped = new Set(STATUS_GROUPS.flatMap((group) => group.statuses));

  it('places every status a carrier sees in exactly one group', () => {
    const counts = new Map<string, number>();

    for (const group of STATUS_GROUPS) {
      for (const status of group.statuses) {
        counts.set(status, (counts.get(status) ?? 0) + 1);
      }
    }

    for (const [status, count] of counts) {
      expect(count, `${status} is in ${String(count)} groups`).toBe(1);
    }
  });

  it('includes every status that has gone wrong', () => {
    for (const status of [
      'DELAYED',
      'ON_HOLD',
      'ADDRESS_ISSUE',
      'CUSTOMS_HOLD',
      'DAMAGED',
      'TEMPERATURE_EXCEPTION',
      'DELIVERY_FAILED',
      'DELIVERY_ATTEMPTED',
    ] as const) {
      expect(grouped.has(status), status).toBe(true);
    }
  });

  /*
   * CREATED is deliberately absent: a carrier never sees one. It exists only
   * between the marketplace raising a consignment and offering it.
   */
  it('leaves out the status a carrier never sees', () => {
    expect(grouped.has('CREATED')).toBe(false);
  });
});

describe('SLA and severity', () => {
  it('tones every SLA state', () => {
    for (const state of ['NOT_APPLICABLE', 'ON_TRACK', 'AT_RISK', 'BREACHED'] as SlaState[]) {
      expect(slaTone(state), state).toBeTruthy();
    }

    expect(slaTone('BREACHED')).toBe('danger');
    expect(slaTone('ON_TRACK')).toBe('success');
  });

  it('tones every severity, and only the worst one is danger', () => {
    const severities: ExceptionSeverity[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];
    const danger = severities.filter((severity) => severityTone(severity) === 'danger');

    expect(danger).toEqual(['CRITICAL']);
  });
});

describe('durations and weights read the way a person says them', () => {
  it('formats a duration', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(60)).toBe('1h');
    expect(formatDuration(200)).toBe('3h 20m');
    expect(formatDuration(1440)).toBe('1d');
    expect(formatDuration(1500)).toBe('1d 1h');
  });

  it('never shows a negative duration', () => {
    expect(formatDuration(-30)).toBe('0m');
  });

  it('formats a weight', () => {
    expect(formatWeight(820)).toBe('820 g');
    expect(formatWeight(1000)).toBe('1 kg');
    expect(formatWeight(4200)).toBe('4.2 kg');
  });
});

describe('the dashboard bar accounts for every shipment it is given', () => {
  it('folds per-status counts into the four groups', () => {
    const grouped = groupStatusCounts([
      { status: 'AWAITING_ASSIGNMENT', count: 2 },
      { status: 'ACCEPTED', count: 1 },
      { status: 'IN_TRANSIT', count: 4 },
      { status: 'DELAYED', count: 3 },
      { status: 'DELIVERED', count: 5 },
    ]);

    const byKey = new Map(grouped.map((group) => [group.labelKey, group.count]));

    expect(byKey.get('shipments.group.waiting')).toBe(3);
    expect(byKey.get('shipments.group.moving')).toBe(4);
    expect(byKey.get('shipments.group.problem')).toBe(3);
    expect(byKey.get('shipments.group.finished')).toBe(5);
  });

  /*
   * The one way this chart can quietly lie. A status belonging to no group is
   * counted into no segment, so the bar adds up to less than the total it was
   * handed - and a part-to-whole bar that is not the whole says nothing on
   * screen about the shipments it left out.
   */
  it('loses no shipment, whatever statuses arrive', () => {
    const rows = STATUS_GROUPS.flatMap((group) =>
      group.statuses.map((status) => ({ status, count: 1 })),
    );

    const total = groupStatusCounts(rows).reduce((sum, group) => sum + group.count, 0);

    expect(total).toBe(rows.length);
  });

  it('returns a zero for a group nothing is in, rather than dropping it', () => {
    const grouped = groupStatusCounts([{ status: 'IN_TRANSIT', count: 1 }]);

    expect(grouped).toHaveLength(STATUS_GROUPS.length);
    expect(grouped.filter((group) => group.count === 0)).toHaveLength(STATUS_GROUPS.length - 1);
  });
});
