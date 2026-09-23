/**
 * The states a collection moves between, and which moves are legal.
 *
 * The same rule order status and occurrence status follow in this codebase: no
 * service writes `state` directly, every change goes through
 * `assertPickupTransition`, and a move nobody listed is refused rather than
 * accepted quietly.
 *
 * It matters here for a specific reason. A collection can be cancelled from a
 * seller's screen, completed from a driver's phone and failed by a carrier's
 * webhook, and those three arrive in any order over a flaky mobile connection.
 * Without a single place that says what may follow what, a late "cancelled"
 * silently un-completes a collection that already happened - and the parcels
 * are on a van that the system now believes never came.
 *
 * TERMINAL MEANS TERMINAL. Nothing leaves COMPLETED, FAILED or CANCELLED. A
 * collection that failed and was rebooked is a NEW collection, because it is: a
 * different van, a different window, and usually a different driver.
 */
import type { LogisticsPickupState } from '../generated/prisma/enums.js';
import { ErrorCode, conflict } from './errors.js';

/**
 * What may follow what.
 *
 * REQUESTED  - written, nobody has committed to it yet. A self-managed
 *              operation's own board starts here.
 * SCHEDULED  - a carrier accepted it and gave a reference back.
 * CONFIRMED  - the warehouse said the goods are actually ready. The single
 *              most common pickup failure is a van at an unready dock, and
 *              this is the handshake that prevents it.
 * COMPLETED  - the driver took the parcels.
 * FAILED     - the van came and could not.
 * CANCELLED  - somebody called it off before it happened.
 */
export const PICKUP_TRANSITIONS: Readonly<
  Record<LogisticsPickupState, readonly LogisticsPickupState[]>
> = {
  REQUESTED: ['SCHEDULED', 'CONFIRMED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  SCHEDULED: ['CONFIRMED', 'COMPLETED', 'FAILED', 'CANCELLED'],
  // A confirmed collection can still be cancelled: the goods being ready does
  // not mean the van has left, and a seller who has just been told their
  // customer cancelled should not have to let the collection happen anyway.
  CONFIRMED: ['COMPLETED', 'FAILED', 'CANCELLED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

/** States a collection can still change from. Everything else is over. */
export const LIVE_PICKUP_STATES: readonly LogisticsPickupState[] = [
  'REQUESTED',
  'SCHEDULED',
  'CONFIRMED',
];

export function isLivePickupState(state: LogisticsPickupState): boolean {
  return LIVE_PICKUP_STATES.includes(state);
}

/**
 * Refuse a move nobody listed.
 *
 * A 409 rather than a 400: the request was well formed and the answer depends
 * on what has happened since, which is exactly what a conflict is. A driver's
 * phone retrying "completed" against a collection that was already cancelled
 * gets told the truth rather than silently winning.
 */
export function assertPickupTransition(
  from: LogisticsPickupState,
  to: LogisticsPickupState,
): void {
  if (from === to) return;

  if (!PICKUP_TRANSITIONS[from].includes(to)) {
    throw conflict(
      ErrorCode.PICKUP_TRANSITION_INVALID,
      `A collection that is ${from.toLowerCase()} cannot become ${to.toLowerCase()}.`,
      [{ code: 'INVALID_TRANSITION', meta: { from, to } }],
    );
  }
}
