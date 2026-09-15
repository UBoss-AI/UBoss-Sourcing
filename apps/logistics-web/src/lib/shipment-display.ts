/**
 * How a status, an SLA state and a severity look on screen.
 *
 * One place, because the same status appears on the dashboard, in the list, on
 * the detail page, on the timeline and on a driver's phone - and a status that
 * is amber in one of them and grey in another is a status nobody learns to
 * read.
 *
 * COLOUR IS NEVER THE ONLY SIGNAL. Every one of these is rendered inside a
 * `Badge`, which always carries its own text, and the dot is a shape cue for
 * scanning rather than the information itself. That is the accessibility rule
 * this file exists to make easy to keep.
 */
import type { BadgeTone } from '@/components/ui';
import type { ExceptionSeverity, ShipmentStatus, SlaState } from './types';

/**
 * A status's tone.
 *
 * Four groups, and the grouping is the point:
 *
 *   - **neutral** - nothing is wrong and nothing has happened yet.
 *   - **brand**   - moving, as planned.
 *   - **success** - finished, well.
 *   - **warning** - somebody should look at this today.
 *   - **danger**  - somebody should look at this now.
 *
 * `DELIVERY_ATTEMPTED` is warning rather than danger on purpose: a first
 * attempt that failed is an ordinary day, and colouring it red would put a red
 * badge on a third of a courier's list and teach everybody to ignore red.
 */
const STATUS_TONES: Readonly<Record<ShipmentStatus, BadgeTone>> = {
  CREATED: 'neutral',
  AWAITING_ASSIGNMENT: 'neutral',
  ASSIGNED: 'accent',
  ACCEPTANCE_PENDING: 'action',
  ACCEPTED: 'accent',
  PICKUP_SCHEDULED: 'accent',
  READY_FOR_PICKUP: 'accent',
  PICKED_UP: 'brand',
  DISPATCHED: 'brand',
  AT_ORIGIN_HUB: 'brand',
  IN_TRANSIT: 'brand',
  AT_DESTINATION_HUB: 'brand',
  OUT_FOR_DELIVERY: 'operational',
  DELIVERY_ATTEMPTED: 'warning',
  DELIVERED: 'success',
  DELAYED: 'warning',
  ON_HOLD: 'warning',
  ADDRESS_ISSUE: 'warning',
  CUSTOMS_HOLD: 'warning',
  DAMAGED: 'danger',
  TEMPERATURE_EXCEPTION: 'danger',
  DELIVERY_FAILED: 'danger',
  RETURN_REQUESTED: 'warning',
  RETURN_IN_TRANSIT: 'warning',
  RETURNED: 'neutral',
  LOST: 'danger',
  CANCELLED: 'neutral',
};

export function statusTone(status: ShipmentStatus): BadgeTone {
  return STATUS_TONES[status];
}

const SLA_TONES: Readonly<Record<SlaState, BadgeTone>> = {
  NOT_APPLICABLE: 'neutral',
  ON_TRACK: 'success',
  AT_RISK: 'warning',
  BREACHED: 'danger',
};

export function slaTone(state: SlaState): BadgeTone {
  return SLA_TONES[state];
}

const SEVERITY_TONES: Readonly<Record<ExceptionSeverity, BadgeTone>> = {
  LOW: 'neutral',
  MEDIUM: 'accent',
  HIGH: 'warning',
  CRITICAL: 'danger',
};

export function severityTone(severity: ExceptionSeverity): BadgeTone {
  return SEVERITY_TONES[severity];
}

/**
 * The statuses a filter offers, grouped the way a dispatcher thinks.
 *
 * Not one flat list of twenty-seven: a person filtering for "anything that has
 * gone wrong" wants one click, and scanning an alphabetical list for eight
 * scattered members is not one click.
 */
export const STATUS_GROUPS: readonly {
  labelKey:
    | 'shipments.group.waiting'
    | 'shipments.group.moving'
    | 'shipments.group.problem'
    | 'shipments.group.finished';
  statuses: readonly ShipmentStatus[];
}[] = [
  {
    labelKey: 'shipments.group.waiting',
    statuses: ['AWAITING_ASSIGNMENT', 'ASSIGNED', 'ACCEPTANCE_PENDING', 'ACCEPTED'],
  },
  {
    labelKey: 'shipments.group.moving',
    statuses: [
      'PICKUP_SCHEDULED',
      'READY_FOR_PICKUP',
      'PICKED_UP',
      'DISPATCHED',
      'AT_ORIGIN_HUB',
      'IN_TRANSIT',
      'AT_DESTINATION_HUB',
      'OUT_FOR_DELIVERY',
    ],
  },
  {
    labelKey: 'shipments.group.problem',
    statuses: [
      'DELIVERY_ATTEMPTED',
      'DELAYED',
      'ON_HOLD',
      'ADDRESS_ISSUE',
      'CUSTOMS_HOLD',
      'DAMAGED',
      'TEMPERATURE_EXCEPTION',
      'DELIVERY_FAILED',
    ],
  },
  {
    labelKey: 'shipments.group.finished',
    statuses: [
      'DELIVERED',
      'RETURN_REQUESTED',
      'RETURN_IN_TRANSIT',
      'RETURNED',
      'LOST',
      'CANCELLED',
    ],
  },
];

/**
 * "3h 20m", from a count of minutes.
 *
 * Deliberately not a relative-time formatter: an SLA is a duration rather than
 * a moment, and "in 3 hours" reads as an estimate where "3h 20m" reads as the
 * figure it is.
 */
export function formatDuration(minutes: number): string {
  const total = Math.max(0, Math.round(minutes));

  if (total < 60) return `${String(total)}m`;

  const hours = Math.floor(total / 60);
  const rest = total % 60;

  if (hours < 24) return rest === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(rest)}m`;

  const days = Math.floor(hours / 24);
  const spareHours = hours % 24;

  return spareHours === 0 ? `${String(days)}d` : `${String(days)}d ${String(spareHours)}h`;
}

/** Grams as a person reads them: "4.2 kg", or "820 g" below a kilogram. */
export function formatWeight(grams: number): string {
  if (grams < 1000) return `${String(grams)} g`;
  return `${(grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 1)} kg`;
}
