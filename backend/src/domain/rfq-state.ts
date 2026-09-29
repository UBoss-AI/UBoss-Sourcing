/**
 * The request-for-quotation state machines.
 *
 * The same rule as `order-state-machine.ts` and `preorder-state.ts`: nothing
 * writes `rfq_requests.status` or `rfq_invitations.status` except through the
 * assertions below, inside the transaction that performs the update, and every
 * such update is conditional on the status that was read - so a stale screen
 * gets a conflict rather than silently overturning somebody else.
 *
 * THE REQUEST
 *
 *   DRAFT ──submit──► OPEN ──accept a quote──► AWARDED
 *     │                 │
 *     └──cancel──┐      ├──close without award──► CLOSED
 *                ▼      └──cancel──► CANCELLED
 *            CANCELLED
 *
 * Three invariants:
 *
 *   1. **Only the buyer submits, closes or cancels.** A seller never moves the
 *      request itself; it moves its own invitation and its own quote.
 *   2. **AWARDED comes only from SYSTEM**, inside the acceptance transaction,
 *      which is also the only writer of `awardedQuoteId`. No button reaches it
 *      directly, so there is exactly one way a request is awarded.
 *   3. **Nothing leaves a terminal state.** A request that has to be asked
 *      again is a new request.
 */
import { ErrorCode, conflict } from './errors.js';

export const RfqStatusValues = ['DRAFT', 'OPEN', 'CLOSED', 'AWARDED', 'CANCELLED'] as const;
export type RfqStatusName = (typeof RfqStatusValues)[number];

export type RfqActor = 'BUYER' | 'SUPPLIER' | 'SYSTEM';

interface Rule<S extends string> {
  to: S;
  actors: readonly RfqActor[];
}

const RFQ_TRANSITIONS: Readonly<Record<RfqStatusName, readonly Rule<RfqStatusName>[]>> =
  Object.freeze({
    DRAFT: [
      { to: 'OPEN', actors: ['BUYER'] },
      { to: 'CANCELLED', actors: ['BUYER'] },
    ],
    OPEN: [
      { to: 'AWARDED', actors: ['SYSTEM'] },
      { to: 'CLOSED', actors: ['BUYER'] },
      { to: 'CANCELLED', actors: ['BUYER'] },
    ],
    AWARDED: [],
    CLOSED: [],
    CANCELLED: [],
  });

export const TERMINAL_RFQ_STATUSES: readonly RfqStatusName[] = Object.freeze([
  'AWARDED',
  'CLOSED',
  'CANCELLED',
]);

export function isTerminalRfqStatus(status: RfqStatusName): boolean {
  return TERMINAL_RFQ_STATUSES.includes(status);
}

export function assertRfqTransition(request: {
  from: RfqStatusName;
  to: RfqStatusName;
  actor: RfqActor;
}): void {
  const rule = RFQ_TRANSITIONS[request.from].find(
    (candidate) => candidate.to === request.to && candidate.actors.includes(request.actor),
  );
  if (rule === undefined) {
    throw conflict(
      ErrorCode.RFQ_TRANSITION_NOT_ALLOWED,
      `A request that is ${human(request.from)} cannot be moved to ${human(request.to)}.`,
      [{ code: 'TRANSITION', meta: { from: request.from, to: request.to, actor: request.actor } }],
    );
  }
}

// ---------------------------------------------------------------------------
// Invitations: one seller's place on one request
// ---------------------------------------------------------------------------

/**
 * Where one invited seller stands.
 *
 *   INVITED ──opened──► VIEWED ──quoted──► QUOTED ──withdrew──► WITHDRAWN
 *      │                  │
 *      ├────declined──────┴──► DECLINED
 *      └── deadline passed with no quote ──► EXPIRED ──deadline extended──► INVITED
 *
 * QUOTED is reachable straight from INVITED: a seller who quotes from the
 * notification without opening the page first has still quoted.
 *
 * EXPIRED is the only status that goes back: when the buyer moves the
 * deadline later, a seller who ran out of time is invited again. Every other
 * answer a seller gave stays given.
 */
export const RfqInvitationStatusValues = [
  'INVITED',
  'VIEWED',
  'QUOTED',
  'DECLINED',
  'WITHDRAWN',
  'EXPIRED',
] as const;
export type RfqInvitationStatusName = (typeof RfqInvitationStatusValues)[number];

const INVITATION_TRANSITIONS: Readonly<
  Record<RfqInvitationStatusName, readonly Rule<RfqInvitationStatusName>[]>
> = Object.freeze({
  INVITED: [
    { to: 'VIEWED', actors: ['SUPPLIER'] },
    { to: 'QUOTED', actors: ['SUPPLIER'] },
    { to: 'DECLINED', actors: ['SUPPLIER'] },
    { to: 'EXPIRED', actors: ['SYSTEM'] },
  ],
  VIEWED: [
    { to: 'QUOTED', actors: ['SUPPLIER'] },
    { to: 'DECLINED', actors: ['SUPPLIER'] },
    { to: 'EXPIRED', actors: ['SYSTEM'] },
  ],
  QUOTED: [{ to: 'WITHDRAWN', actors: ['SUPPLIER'] }],
  DECLINED: [],
  WITHDRAWN: [],
  EXPIRED: [{ to: 'INVITED', actors: ['SYSTEM'] }],
});

/** Statuses in which a seller may still ask, quote or decline. */
export const RESPONSIVE_INVITATION_STATUSES: readonly RfqInvitationStatusName[] = Object.freeze([
  'INVITED',
  'VIEWED',
]);

/** Statuses in which a seller still takes part and hears about changes. */
export const LIVE_INVITATION_STATUSES: readonly RfqInvitationStatusName[] = Object.freeze([
  'INVITED',
  'VIEWED',
  'QUOTED',
]);

export function canTransitionInvitation(
  from: RfqInvitationStatusName,
  to: RfqInvitationStatusName,
  actor: RfqActor,
): boolean {
  return INVITATION_TRANSITIONS[from].some(
    (rule) => rule.to === to && rule.actors.includes(actor),
  );
}

export function assertInvitationTransition(request: {
  from: RfqInvitationStatusName;
  to: RfqInvitationStatusName;
  actor: RfqActor;
}): void {
  if (!canTransitionInvitation(request.from, request.to, request.actor)) {
    throw conflict(
      ErrorCode.RFQ_RESPONSE_CLOSED,
      `This invitation is ${human(request.from)} and cannot be ${human(request.to)}.`,
      [{ code: request.from, meta: { from: request.from, to: request.to } }],
    );
  }
}

function human(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ');
}
