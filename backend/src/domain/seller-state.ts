/**
 * Seller application and listing state machines.
 *
 * Same rule as `order-state-machine.ts` and `schedule-state.ts`, and it matters
 * here for the same reason: no service writes `SellerAccount.status` or
 * `SellerListingDraft.status` directly. Every change goes through an assertion
 * in this file.
 *
 * What is at stake is not bookkeeping. The step to APPROVED is what lets a
 * business put medical devices in front of hospitals, and the step to
 * PENDING_REVIEW is what hands a device to a moderator. If those columns could
 * be set from anywhere, "how did this seller become approved" would eventually
 * have no answer, and that is a question that gets asked after something has
 * gone wrong rather than before.
 *
 * Both machines follow the shape the order machine established: an adjacency
 * list of rules, an `allowed*` reader the interface renders buttons from, and
 * an `assert*` writer called inside the same transaction as the update. The
 * reader and the writer consult one table, so a button that appears is a
 * button that works.
 */
import { ErrorCode, conflict } from './errors.js';

// ---------------------------------------------------------------------------
// Who is asking
// ---------------------------------------------------------------------------

/**
 * The three parties, and they are genuinely different.
 *
 * SELLER is the business itself. OPERATOR is this marketplace's staff, who
 * decide applications and moderate listings. SYSTEM is a worker - an expiring
 * certificate that moves an approved seller back to ACTION_REQUIRED, a
 * scheduled sweep that archives an abandoned draft.
 *
 * A seller can never be its own operator. That is the whole point of splitting
 * them, and it is enforced by the `actors` list on every rule rather than by
 * remembering to check.
 */
export type SellerActor = 'SELLER' | 'OPERATOR' | 'SYSTEM';

// ---------------------------------------------------------------------------
// The application
// ---------------------------------------------------------------------------

export const SellerApplicationStatusValues = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'ACTION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
] as const;

export type SellerApplicationStatusName = (typeof SellerApplicationStatusValues)[number];

interface ApplicationRule {
  to: SellerApplicationStatusName;
  actors: readonly SellerActor[];
  /**
   * A reason the SELLER will read. Required on every refusal and every stop,
   * because "action required" with no text is a screen a seller cannot act on
   * and will open a support ticket about.
   */
  requiresReason?: boolean;
}

/**
 * Legal application transitions.
 *
 * Three absences are deliberate and are the interesting part of this table:
 *
 *   - **APPROVED -> REJECTED.** An approved seller is stopped with SUSPENDED,
 *     never rejected. They have live listings, open orders and money owed;
 *     "rejected" is a decision about an application, and reusing it here would
 *     put an operator one click from a state whose meaning does not cover
 *     anything that has to happen to those orders.
 *
 *   - **REJECTED -> APPROVED.** A refused application is reopened to
 *     ACTION_REQUIRED and reviewed again. Approving straight from rejection
 *     would mean approving the version that was refused.
 *
 *   - **SUSPENDED -> anything by the SELLER.** Lifting a suspension is the
 *     operator's decision. A seller who could reactivate themselves is not
 *     suspended.
 */
const APPLICATION_TRANSITIONS: Readonly<
  Record<SellerApplicationStatusName, readonly ApplicationRule[]>
> = Object.freeze({
  DRAFT: [{ to: 'SUBMITTED', actors: ['SELLER'] }],

  SUBMITTED: [
    { to: 'UNDER_REVIEW', actors: ['OPERATOR', 'SYSTEM'] },
    { to: 'ACTION_REQUIRED', actors: ['OPERATOR'], requiresReason: true },
    { to: 'APPROVED', actors: ['OPERATOR'] },
    { to: 'REJECTED', actors: ['OPERATOR'], requiresReason: true },
    // The seller changed their mind before anybody looked. Only from
    // SUBMITTED: once a reviewer has it, withdrawing it out from under them
    // loses their work.
    { to: 'DRAFT', actors: ['SELLER'] },
  ],

  UNDER_REVIEW: [
    { to: 'ACTION_REQUIRED', actors: ['OPERATOR'], requiresReason: true },
    { to: 'APPROVED', actors: ['OPERATOR'] },
    { to: 'REJECTED', actors: ['OPERATOR'], requiresReason: true },
  ],

  ACTION_REQUIRED: [
    { to: 'SUBMITTED', actors: ['SELLER'] },
    // The operator gave up waiting.
    { to: 'REJECTED', actors: ['OPERATOR', 'SYSTEM'], requiresReason: true },
  ],

  APPROVED: [
    { to: 'SUSPENDED', actors: ['OPERATOR', 'SYSTEM'], requiresReason: true },
    // A certificate expired, a registration lapsed. The worker does this, and
    // the seller can fix it and resubmit without losing their approval history.
    { to: 'ACTION_REQUIRED', actors: ['OPERATOR', 'SYSTEM'], requiresReason: true },
  ],

  REJECTED: [
    // Reopened, only where resubmission was left open. The service checks
    // `resubmissionAllowed` as well - see `assertResubmissionAllowed`.
    { to: 'ACTION_REQUIRED', actors: ['OPERATOR'] },
  ],

  SUSPENDED: [
    { to: 'APPROVED', actors: ['OPERATOR'] },
    { to: 'ACTION_REQUIRED', actors: ['OPERATOR'], requiresReason: true },
    { to: 'REJECTED', actors: ['OPERATOR'], requiresReason: true },
  ],
});

/** States in which a seller may submit listings and receive orders. */
export const SELLER_TRADING_STATUSES: readonly SellerApplicationStatusName[] = Object.freeze([
  'APPROVED',
]);

/** States in which the seller may still edit their own application. */
export const SELLER_EDITABLE_STATUSES: readonly SellerApplicationStatusName[] = Object.freeze([
  'DRAFT',
  'ACTION_REQUIRED',
]);

export interface AllowedApplicationTransition {
  to: SellerApplicationStatusName;
  requiresReason: boolean;
}

/** What this actor may do with an application in this state. */
export function allowedApplicationTransitions(
  from: SellerApplicationStatusName,
  actor: SellerActor,
): AllowedApplicationTransition[] {
  return (APPLICATION_TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => ({ to: rule.to, requiresReason: rule.requiresReason === true }));
}

export interface ApplicationTransitionRequest {
  from: SellerApplicationStatusName;
  to: SellerApplicationStatusName;
  actor: SellerActor;
  reason?: string | null;
}

function actorPhrase(actor: SellerActor): string {
  if (actor === 'OPERATOR') return 'An administrator';
  if (actor === 'SYSTEM') return 'The system';
  return 'A seller';
}

/**
 * Throws unless the application transition is legal. Call inside the same
 * transaction that performs the update.
 */
export function assertSellerApplicationTransition(request: ApplicationTransitionRequest): void {
  const { from, to, actor } = request;
  const reason = request.reason ?? null;

  if (from === to) {
    throw conflict(
      ErrorCode.SELLER_APPLICATION_TRANSITION_NOT_ALLOWED,
      `This application is already ${to.toLowerCase().replace(/_/g, ' ')}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  const rule = (APPLICATION_TRANSITIONS[from] ?? []).find((candidate) => candidate.to === to);

  if (rule === undefined) {
    throw conflict(
      ErrorCode.SELLER_APPLICATION_TRANSITION_NOT_ALLOWED,
      `An application cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.SELLER_APPLICATION_TRANSITION_NOT_ALLOWED,
      `${actorPhrase(actor)} cannot move an application from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  if (rule.requiresReason === true && (reason === null || reason.trim().length === 0)) {
    throw conflict(
      ErrorCode.SELLER_APPLICATION_TRANSITION_NOT_ALLOWED,
      `Moving an application to ${to} needs a reason the seller can read.`,
      [{ field: 'reason', code: 'REASON_REQUIRED', meta: { from, to } }],
    );
  }
}

// ---------------------------------------------------------------------------
// The listing
// ---------------------------------------------------------------------------

export const ListingDraftStatusValues = [
  'DRAFT',
  'VALIDATION_FAILED',
  'READY_FOR_SUBMISSION',
  'PENDING_REVIEW',
  'ACTION_REQUIRED',
  'APPROVED',
  'REJECTED',
  'ARCHIVED',
] as const;

export type ListingDraftStatusName = (typeof ListingDraftStatusValues)[number];

interface ListingRule {
  to: ListingDraftStatusName;
  actors: readonly SellerActor[];
  requiresReason?: boolean;
}

/**
 * Legal listing transitions.
 *
 * The shape to notice is that **nothing reaches APPROVED except from
 * PENDING_REVIEW, and only an operator can do it.** That is the one guarantee
 * this table exists to make: a listing cannot become publicly buyable without
 * having been looked at. Every other rule here is convenience; that one is the
 * product requirement, and it is why VALIDATION_FAILED and
 * READY_FOR_SUBMISSION - which a seller moves between freely by editing - have
 * no path to APPROVED at all.
 *
 * VALIDATION_FAILED and READY_FOR_SUBMISSION are both written by the SYSTEM
 * rather than by the seller: they are the result of running the checks, not a
 * choice. A seller who could set READY_FOR_SUBMISSION could submit an
 * incomplete listing.
 */
const LISTING_TRANSITIONS: Readonly<Record<ListingDraftStatusName, readonly ListingRule[]>> =
  Object.freeze({
    DRAFT: [
      { to: 'VALIDATION_FAILED', actors: ['SYSTEM'] },
      { to: 'READY_FOR_SUBMISSION', actors: ['SYSTEM'] },
      { to: 'ARCHIVED', actors: ['SELLER', 'SYSTEM'] },
    ],

    VALIDATION_FAILED: [
      // Editing anything sends it back to DRAFT so the failure is not sticky.
      { to: 'DRAFT', actors: ['SELLER', 'SYSTEM'] },
      { to: 'READY_FOR_SUBMISSION', actors: ['SYSTEM'] },
      { to: 'ARCHIVED', actors: ['SELLER', 'SYSTEM'] },
    ],

    READY_FOR_SUBMISSION: [
      { to: 'PENDING_REVIEW', actors: ['SELLER'] },
      { to: 'DRAFT', actors: ['SELLER', 'SYSTEM'] },
      { to: 'VALIDATION_FAILED', actors: ['SYSTEM'] },
      { to: 'ARCHIVED', actors: ['SELLER', 'SYSTEM'] },
    ],

    PENDING_REVIEW: [
      { to: 'APPROVED', actors: ['OPERATOR'] },
      { to: 'ACTION_REQUIRED', actors: ['OPERATOR'], requiresReason: true },
      { to: 'REJECTED', actors: ['OPERATOR'], requiresReason: true },
      // Withdrawn before a moderator opened it.
      { to: 'DRAFT', actors: ['SELLER'] },
    ],

    ACTION_REQUIRED: [
      { to: 'DRAFT', actors: ['SELLER', 'SYSTEM'] },
      { to: 'ARCHIVED', actors: ['SELLER', 'SYSTEM'] },
      { to: 'REJECTED', actors: ['OPERATOR', 'SYSTEM'], requiresReason: true },
    ],

    // Terminal for the draft. The listing now lives as a `SellerOffer`; pausing
    // and republishing happen on the offer, not here. A second edit starts a
    // new draft, which is what keeps "what exactly was approved" answerable.
    APPROVED: [],

    REJECTED: [{ to: 'DRAFT', actors: ['SELLER'] }, { to: 'ARCHIVED', actors: ['SELLER', 'SYSTEM'] }],

    ARCHIVED: [{ to: 'DRAFT', actors: ['SELLER'] }],
  });

/** Statuses in which the seller may edit the draft's content. */
export const LISTING_EDITABLE_STATUSES: readonly ListingDraftStatusName[] = Object.freeze([
  'DRAFT',
  'VALIDATION_FAILED',
  'READY_FOR_SUBMISSION',
  'ACTION_REQUIRED',
  'REJECTED',
]);

export interface AllowedListingTransition {
  to: ListingDraftStatusName;
  requiresReason: boolean;
}

export function allowedListingTransitions(
  from: ListingDraftStatusName,
  actor: SellerActor,
): AllowedListingTransition[] {
  return (LISTING_TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => ({ to: rule.to, requiresReason: rule.requiresReason === true }));
}

export interface ListingTransitionRequest {
  from: ListingDraftStatusName;
  to: ListingDraftStatusName;
  actor: SellerActor;
  reason?: string | null;
}

/** Throws unless the listing transition is legal. */
export function assertListingTransition(request: ListingTransitionRequest): void {
  const { from, to, actor } = request;
  const reason = request.reason ?? null;

  if (from === to) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      `This listing is already ${to.toLowerCase().replace(/_/g, ' ')}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  const rule = (LISTING_TRANSITIONS[from] ?? []).find((candidate) => candidate.to === to);

  if (rule === undefined) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      `A listing cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      `${actorPhrase(actor)} cannot move a listing from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  if (rule.requiresReason === true && (reason === null || reason.trim().length === 0)) {
    throw conflict(
      ErrorCode.LISTING_TRANSITION_NOT_ALLOWED,
      `Moving a listing to ${to} needs a comment the seller can act on.`,
      [{ field: 'reason', code: 'REASON_REQUIRED', meta: { from, to } }],
    );
  }
}

// ---------------------------------------------------------------------------
// The seller's part of an order
// ---------------------------------------------------------------------------

export const SellerOrderGroupStatusValues = [
  'NEW',
  'ACCEPTED',
  'PROCESSING',
  'READY_FOR_DISPATCH',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURN_REQUESTED',
  'RETURNED',
  'REFUNDED',
  'DISPUTED',
] as const;

export type SellerOrderGroupStatusName = (typeof SellerOrderGroupStatusValues)[number];

interface OrderGroupRule {
  to: SellerOrderGroupStatusName;
  actors: readonly SellerActor[];
  requiresReason?: boolean;
}

/**
 * Legal transitions for one seller's part of a buyer's order.
 *
 * This is NOT the buyer's order status and must not be confused with it. The
 * buyer's `Order` moves through `assertTransition` in
 * `order-state-machine.ts`; one seller shipping their two lines does not make
 * a three-seller order "shipped", and the fulfilment service is what decides
 * when enough groups have moved for the buyer's order to follow.
 *
 * A seller cannot cancel after dispatch, and cannot refund at all: money
 * leaving is the operator's action through the existing refund path, because
 * the marketplace took the payment.
 */
const ORDER_GROUP_TRANSITIONS: Readonly<
  Record<SellerOrderGroupStatusName, readonly OrderGroupRule[]>
> = Object.freeze({
  NEW: [
    { to: 'ACCEPTED', actors: ['SELLER', 'SYSTEM'] },
    { to: 'CANCELLED', actors: ['SELLER', 'OPERATOR'], requiresReason: true },
  ],

  ACCEPTED: [
    { to: 'PROCESSING', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['SELLER', 'OPERATOR'], requiresReason: true },
  ],

  PROCESSING: [
    { to: 'READY_FOR_DISPATCH', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['SELLER', 'OPERATOR'], requiresReason: true },
  ],

  READY_FOR_DISPATCH: [
    { to: 'SHIPPED', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['OPERATOR'], requiresReason: true },
  ],

  SHIPPED: [
    { to: 'DELIVERED', actors: ['SELLER', 'OPERATOR', 'SYSTEM'] },
    { to: 'RETURN_REQUESTED', actors: ['OPERATOR', 'SYSTEM'] },
  ],

  DELIVERED: [{ to: 'RETURN_REQUESTED', actors: ['OPERATOR', 'SYSTEM'] }],

  RETURN_REQUESTED: [
    { to: 'RETURNED', actors: ['SELLER', 'OPERATOR'] },
    { to: 'DISPUTED', actors: ['SELLER', 'OPERATOR'], requiresReason: true },
    // The buyer changed their mind about returning it.
    { to: 'DELIVERED', actors: ['OPERATOR'] },
  ],

  RETURNED: [{ to: 'REFUNDED', actors: ['OPERATOR', 'SYSTEM'] }],

  DISPUTED: [
    { to: 'RETURNED', actors: ['OPERATOR'] },
    { to: 'DELIVERED', actors: ['OPERATOR'], requiresReason: true },
    { to: 'REFUNDED', actors: ['OPERATOR'] },
  ],

  CANCELLED: [{ to: 'REFUNDED', actors: ['OPERATOR', 'SYSTEM'] }],

  REFUNDED: [],
});

/** Statuses in which the seller's stock is committed to this order. */
export const SELLER_ORDER_STOCK_HELD: readonly SellerOrderGroupStatusName[] = Object.freeze([
  'NEW',
  'ACCEPTED',
  'PROCESSING',
  'READY_FOR_DISPATCH',
]);

export function allowedSellerOrderTransitions(
  from: SellerOrderGroupStatusName,
  actor: SellerActor,
): { to: SellerOrderGroupStatusName; requiresReason: boolean }[] {
  return (ORDER_GROUP_TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => ({ to: rule.to, requiresReason: rule.requiresReason === true }));
}

export interface SellerOrderTransitionRequest {
  from: SellerOrderGroupStatusName;
  to: SellerOrderGroupStatusName;
  actor: SellerActor;
  reason?: string | null;
}

/** Throws unless the seller order transition is legal. */
export function assertSellerOrderTransition(request: SellerOrderTransitionRequest): void {
  const { from, to, actor } = request;
  const reason = request.reason ?? null;

  if (from === to) {
    throw conflict(
      ErrorCode.SELLER_ORDER_TRANSITION_NOT_ALLOWED,
      `This order is already ${to.toLowerCase().replace(/_/g, ' ')}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  const rule = (ORDER_GROUP_TRANSITIONS[from] ?? []).find((candidate) => candidate.to === to);

  if (rule === undefined) {
    throw conflict(
      ErrorCode.SELLER_ORDER_TRANSITION_NOT_ALLOWED,
      `A seller order cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.SELLER_ORDER_TRANSITION_NOT_ALLOWED,
      `${actorPhrase(actor)} cannot move a seller order from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  if (rule.requiresReason === true && (reason === null || reason.trim().length === 0)) {
    throw conflict(
      ErrorCode.SELLER_ORDER_TRANSITION_NOT_ALLOWED,
      `Moving a seller order to ${to} needs a reason.`,
      [{ field: 'reason', code: 'REASON_REQUIRED', meta: { from, to } }],
    );
  }
}
