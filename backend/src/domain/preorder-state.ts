/**
 * The preorder state machine.
 *
 * The same rule as `order-state-machine.ts` and `schedule-state.ts`: nothing
 * writes `preorder_requests.status` except through `assertPreorderTransition`,
 * so what is legal lives in one table that can be read in one sitting and
 * tested exhaustively.
 *
 * Three invariants the table encodes, and they are the reason it exists:
 *
 *   1. **The seller cannot move a request to anything the buyer pays for.**
 *      There is no SELLER edge into BUYER_CONFIRMED or PAYMENT_REQUIRED. A
 *      seller accepting is an offer; only the buyer turns it into an
 *      obligation, and only a signed payment webhook (SYSTEM) turns that into
 *      a confirmed order.
 *
 *   2. **Nothing returns to negotiation once an order exists.** There is no
 *      edge out of PAYMENT_REQUIRED or anything after it back to SUBMITTED,
 *      SELLER_ACCEPTED or SELLER_COUNTERED. Changing agreed terms is an
 *      amendment, which is a new request, not a rewind of this one.
 *
 *   3. **CONFIRMED only comes from SYSTEM.** The webhook confirms the ORDER;
 *      the order's own transition confirms the preorder in the same
 *      transaction. No person and no browser redirect can.
 */
import { ErrorCode, conflict } from './errors.js';

export const PreorderStatusValues = [
  'SUBMITTED',
  'SELLER_REVIEW_REQUIRED',
  'SELLER_ACCEPTED',
  'SELLER_COUNTERED',
  'BUYER_CONFIRMED',
  'PAYMENT_REQUIRED',
  'CONFIRMED',
  'IN_PRODUCTION',
  'READY_FOR_FULFILLMENT',
  'CONVERTED_TO_ORDER',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type PreorderStatusName = (typeof PreorderStatusValues)[number];

export type PreorderActorKind = 'BUYER' | 'SELLER' | 'SYSTEM' | 'ADMIN';

interface Rule {
  to: PreorderStatusName;
  actors: readonly PreorderActorKind[];
  requiresReason?: boolean;
}

const TRANSITIONS: Readonly<Record<PreorderStatusName, readonly Rule[]>> = Object.freeze({
  SUBMITTED: [
    { to: 'SELLER_ACCEPTED', actors: ['SELLER'] },
    { to: 'SELLER_COUNTERED', actors: ['SELLER'] },
    { to: 'REJECTED', actors: ['SELLER'], requiresReason: true },
    { to: 'CANCELLED', actors: ['BUYER', 'ADMIN'] },
    { to: 'EXPIRED', actors: ['SYSTEM'] },
  ],

  // The buyer declined the seller's terms and asked again. The same answers
  // are open to the seller as on a fresh request.
  SELLER_REVIEW_REQUIRED: [
    { to: 'SELLER_ACCEPTED', actors: ['SELLER'] },
    { to: 'SELLER_COUNTERED', actors: ['SELLER'] },
    { to: 'REJECTED', actors: ['SELLER'], requiresReason: true },
    { to: 'CANCELLED', actors: ['BUYER', 'ADMIN'] },
    { to: 'EXPIRED', actors: ['SYSTEM'] },
  ],

  SELLER_ACCEPTED: [
    { to: 'BUYER_CONFIRMED', actors: ['BUYER'] },
    { to: 'SELLER_REVIEW_REQUIRED', actors: ['BUYER'] },
    // A seller may revise terms nobody has agreed to yet. The earlier
    // revision is SUPERSEDED, and the buyer's confirmation, which names a
    // terms hash, cannot land on the old one.
    { to: 'SELLER_COUNTERED', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['BUYER', 'SELLER', 'ADMIN'], requiresReason: true },
    { to: 'EXPIRED', actors: ['SYSTEM'] },
  ],

  SELLER_COUNTERED: [
    { to: 'BUYER_CONFIRMED', actors: ['BUYER'] },
    { to: 'SELLER_REVIEW_REQUIRED', actors: ['BUYER'] },
    { to: 'SELLER_COUNTERED', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['BUYER', 'SELLER', 'ADMIN'], requiresReason: true },
    { to: 'EXPIRED', actors: ['SYSTEM'] },
  ],

  // Transient: the same transaction reserves capacity, creates the order and
  // moves on. It is a status of its own so the history says the buyer agreed
  // before any order existed.
  BUYER_CONFIRMED: [{ to: 'PAYMENT_REQUIRED', actors: ['SYSTEM'] }],

  PAYMENT_REQUIRED: [
    // The order's own CONFIRMED transition, driven by a signed webhook.
    { to: 'CONFIRMED', actors: ['SYSTEM'] },
    // The buyer backs out before paying, or the order is cancelled.
    { to: 'CANCELLED', actors: ['BUYER', 'SYSTEM', 'ADMIN'], requiresReason: true },
    { to: 'EXPIRED', actors: ['SYSTEM'] },
  ],

  CONFIRMED: [
    { to: 'IN_PRODUCTION', actors: ['SELLER'] },
    { to: 'READY_FOR_FULFILLMENT', actors: ['SELLER'] },
    // The seller accepted the order itself - the goods were already on the
    // shelf. Driven by the order-group transition, never by a button here.
    { to: 'CONVERTED_TO_ORDER', actors: ['SYSTEM'] },
    // A paid order is cancelled through the order and its refund, and the
    // order's cancellation brings the preorder with it.
    { to: 'CANCELLED', actors: ['SYSTEM', 'ADMIN'], requiresReason: true },
  ],

  IN_PRODUCTION: [
    { to: 'READY_FOR_FULFILLMENT', actors: ['SELLER'] },
    { to: 'CONVERTED_TO_ORDER', actors: ['SYSTEM'] },
    { to: 'CANCELLED', actors: ['SYSTEM', 'ADMIN'], requiresReason: true },
  ],

  READY_FOR_FULFILLMENT: [
    // When the seller accepts the order - which is where stock at a named
    // location is reserved against it, exactly as for any marketplace order.
    { to: 'CONVERTED_TO_ORDER', actors: ['SYSTEM'] },
    { to: 'CANCELLED', actors: ['SYSTEM', 'ADMIN'], requiresReason: true },
  ],

  CONVERTED_TO_ORDER: [],
  REJECTED: [],
  CANCELLED: [],
  EXPIRED: [],
});

/** Statuses nothing further can happen to. */
export const TERMINAL_PREORDER_STATUSES: readonly PreorderStatusName[] = Object.freeze([
  'CONVERTED_TO_ORDER',
  'REJECTED',
  'CANCELLED',
  'EXPIRED',
]);

/** Statuses in which the seller owes an answer. */
export const AWAITING_SELLER: readonly PreorderStatusName[] = Object.freeze([
  'SUBMITTED',
  'SELLER_REVIEW_REQUIRED',
]);

/** Statuses in which the buyer owes an answer. */
export const AWAITING_BUYER: readonly PreorderStatusName[] = Object.freeze([
  'SELLER_ACCEPTED',
  'SELLER_COUNTERED',
]);

/**
 * Statuses in which production capacity is held. Capacity is reserved at the
 * buyer's confirmation and released on anything terminal except
 * CONVERTED_TO_ORDER, where it has been used.
 */
export const HOLDS_CAPACITY: readonly PreorderStatusName[] = Object.freeze([
  'PAYMENT_REQUIRED',
  'CONFIRMED',
  'IN_PRODUCTION',
  'READY_FOR_FULFILLMENT',
]);

export function isTerminalPreorderStatus(status: PreorderStatusName): boolean {
  return TERMINAL_PREORDER_STATUSES.includes(status);
}

export interface PreorderTransitionRequest {
  from: PreorderStatusName;
  to: PreorderStatusName;
  actor: PreorderActorKind;
  reason?: string | null;
}

export function canTransitionPreorder(request: PreorderTransitionRequest): boolean {
  return (TRANSITIONS[request.from] ?? []).some(
    (rule) => rule.to === request.to && rule.actors.includes(request.actor),
  );
}

export function allowedPreorderTransitions(
  from: PreorderStatusName,
  actor: PreorderActorKind,
): PreorderStatusName[] {
  return (TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => rule.to);
}

/**
 * Refuse anything the table does not allow.
 *
 * A 409 rather than a 403: the usual cause is not a forbidden actor but a
 * stale screen - the seller countered while the buyer's page was open - and
 * the right response is to reload, which is what a conflict tells a client.
 */
export function assertPreorderTransition(request: PreorderTransitionRequest): void {
  const rule = (TRANSITIONS[request.from] ?? []).find(
    (candidate) => candidate.to === request.to && candidate.actors.includes(request.actor),
  );

  if (rule === undefined) {
    throw conflict(
      ErrorCode.PREORDER_TRANSITION_NOT_ALLOWED,
      `A preorder that is ${humanStatus(request.from)} cannot be moved to ${humanStatus(request.to)}.`,
      [{ code: 'TRANSITION', meta: { from: request.from, to: request.to, actor: request.actor } }],
    );
  }

  if (rule.requiresReason === true && (request.reason ?? '').trim().length === 0) {
    throw conflict(
      ErrorCode.PREORDER_TRANSITION_NOT_ALLOWED,
      `Say why this preorder is being ${humanStatus(request.to)}.`,
      [{ field: 'reason', code: 'REQUIRED' }],
    );
  }
}

function humanStatus(status: PreorderStatusName): string {
  return status.toLowerCase().replace(/_/g, ' ');
}
