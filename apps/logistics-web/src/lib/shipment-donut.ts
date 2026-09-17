/**
 * How twenty-seven consignment statuses become a ring a dispatcher can read.
 *
 * Pure, and here rather than in the component, for the same reason
 * `groupStatusCounts` next door is: the one thing that can go quietly wrong is
 * a status belonging to no group, which would be counted in no segment and
 * leave the ring adding up to less than the total with nothing on screen
 * saying so. That is testable here and invisible in a screenshot.
 *
 * ---
 *
 * WHY EIGHT GROUPS AND NOT THE FOUR THE FILTER USES
 *
 * `STATUS_GROUPS` in `shipment-display.ts` folds the twenty-seven into four —
 * waiting, moving, problem, finished — and that is right for a FILTER, where
 * the question is "show me anything that has gone wrong" and the answer should
 * be one click.
 *
 * A dispatcher's ring is a different question: "where is my work, right now".
 * Four segments cannot answer it, because "moving" contains both a consignment
 * sitting in an origin hub and one on a van two streets from the recipient,
 * and those are different mornings. So this is eight, and each one is a stage
 * somebody does something about.
 *
 * The two vocabularies are kept separate rather than reconciled, deliberately.
 * They answer different questions and forcing one to serve both would make the
 * filter coarser or the ring unreadable. What they are NOT allowed to do is
 * disagree about which statuses exist — a test holds both to covering all
 * twenty-seven exactly once.
 */
import type { ChartStep, DonutSegmentInput } from './donut';
import type { ShipmentStatus } from './types';

/** The eight stages, in the order a consignment passes through them. */
export type ShipmentSegmentKey =
  | 'awaitingPickup'
  | 'assigned'
  | 'pickedUp'
  | 'inTransit'
  | 'outForDelivery'
  | 'delivered'
  | 'exception'
  | 'returning';

export const SHIPMENT_SEGMENTS: readonly {
  key: ShipmentSegmentKey;
  statuses: readonly ShipmentStatus[];
  step: ChartStep;
}[] = [
  /*
   * Nobody has answered yet. Neutral rather than step one: a consignment
   * offered and not accepted has not entered the sequence, and colouring it as
   * early progress would say work is under way when it is not.
   */
  {
    key: 'awaitingPickup',
    statuses: ['AWAITING_ASSIGNMENT', 'ACCEPTANCE_PENDING'],
    step: 'neutral',
  },
  { key: 'assigned', statuses: ['ASSIGNED', 'ACCEPTED'], step: 1 },
  {
    key: 'pickedUp',
    statuses: ['PICKUP_SCHEDULED', 'READY_FOR_PICKUP', 'PICKED_UP', 'DISPATCHED'],
    step: 2,
  },
  { key: 'inTransit', statuses: ['AT_ORIGIN_HUB', 'IN_TRANSIT', 'AT_DESTINATION_HUB'], step: 4 },
  { key: 'outForDelivery', statuses: ['OUT_FOR_DELIVERY'], step: 5 },
  { key: 'delivered', statuses: ['DELIVERED'], step: 'success' },
  /*
   * Everything that has gone wrong, as ONE segment.
   *
   * Eight red slivers touching each other in a ring are one red to every
   * reader, and the table under the chart is where a breakdown belongs.
   *
   * `DELIVERY_ATTEMPTED` is in here even though `shipment-display.ts` colours
   * its badge amber rather than red, and the difference is deliberate: in a
   * list of a hundred rows a first failed attempt is an ordinary day and must
   * not be red, while on a ring of eight segments it belongs with the work
   * that needs chasing rather than with the parcels moving to plan.
   */
  {
    key: 'exception',
    statuses: [
      'DELIVERY_ATTEMPTED',
      'DELAYED',
      'ON_HOLD',
      'ADDRESS_ISSUE',
      'CUSTOMS_HOLD',
      'DAMAGED',
      'TEMPERATURE_EXCEPTION',
      'DELIVERY_FAILED',
      'LOST',
    ],
    step: 'danger',
  },
  /*
   * Going back. Amber rather than red: a return is not a failure in progress,
   * it is a job with a different destination — and it is still work.
   *
   * `CANCELLED` sits here rather than in `exception` because nothing is wrong
   * with it; the consignment was withdrawn and there is nothing to chase.
   */
  {
    key: 'returning',
    statuses: ['RETURN_REQUESTED', 'RETURN_IN_TRANSIT', 'RETURNED', 'CANCELLED'],
    step: 'warning',
  },
];

/**
 * The one status no group holds, and why.
 *
 * `CREATED` exists only between the marketplace raising a consignment and
 * offering it to anybody. No carrier is assigned yet, so `assignedPartnerId`
 * is unset and one can never appear in a carrier's own figures — which is why
 * `STATUS_GROUPS` next door leaves it out too, and why leaving it out here is
 * agreement rather than an omission.
 *
 * Written down rather than simply absent, so the coverage test can assert that
 * every status is either grouped or deliberately not.
 */
export const UNGROUPED_SHIPMENT_STATUSES: readonly ShipmentStatus[] = ['CREATED'];

/**
 * Fold the server's per-status counts into the eight groups.
 *
 * Every group is returned, including the empty ones. A group that vanished
 * when it emptied would mean a dispatcher could not tell "nothing failed
 * today" from "this build does not track failures", and those are very
 * different days.
 */
export function shipmentSegments(
  rows: readonly { status: ShipmentStatus; count: number }[],
  label: (key: ShipmentSegmentKey) => string,
): DonutSegmentInput[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.status, (counts.get(row.status) ?? 0) + row.count);

  return SHIPMENT_SEGMENTS.map((segment) => ({
    id: segment.key,
    label: label(segment.key),
    value: segment.statuses.reduce((sum, status) => sum + (counts.get(status) ?? 0), 0),
    step: segment.step,
  }));
}

/**
 * The statuses a segment drills into.
 *
 * Read from the SAME table the ring is drawn from, so a segment showing eleven
 * consignments cannot open a list showing nine. That property is the reason
 * this function exists rather than each caller writing its own status list.
 */
export function segmentStatuses(key: string): ShipmentStatus[] {
  return [...(SHIPMENT_SEGMENTS.find((segment) => segment.key === key)?.statuses ?? [])];
}
