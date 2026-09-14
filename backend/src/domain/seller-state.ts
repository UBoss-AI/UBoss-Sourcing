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
import { zonedCalendarDate, zonedTimeToUtc } from './recurrence.js';

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

  /*
   * Straight to SHIPPED from here, and from PROCESSING, on purpose.
   *
   * "Picking" and "ready to go" are a seller telling their own staff where a
   * box has got to. Plenty of sellers accept an order, pack it and hand it to
   * a courier without touching either, and a shipment recorded with a carrier
   * and a tracking number is evidence the goods have gone - refusing it
   * because a bookkeeping step was skipped would leave the buyer with no
   * tracking and the seller marked as never having dispatched.
   *
   * It is the recorded dispatch that makes the move, never a button that
   * simply says SHIPPED: `recordShipment` asserts this transition once every
   * line is accounted for.
   */
  ACCEPTED: [
    { to: 'PROCESSING', actors: ['SELLER'] },
    { to: 'SHIPPED', actors: ['SELLER'] },
    { to: 'CANCELLED', actors: ['SELLER', 'OPERATOR'], requiresReason: true },
  ],

  PROCESSING: [
    { to: 'READY_FOR_DISPATCH', actors: ['SELLER'] },
    { to: 'SHIPPED', actors: ['SELLER'] },
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

// ---------------------------------------------------------------------------
// The dispatch clock
// ---------------------------------------------------------------------------

/** What a seller's building says about when it can get a box out. */
export interface DispatchSchedule {
  /** IANA zone. A cut-off is a wall-clock time and means nothing without it. */
  timezone: string;
  /** Bitmask, Monday = 1. 31 is Mon-Fri. */
  workingDaysMask: number;
  /** `HH:MM` local. Null means the day counts however late it is. */
  dispatchCutoff: string | null;
  /** Working days between the order and the box leaving. */
  handlingTimeDays: number;
}

/** Monday = 1 … Sunday = 7, in the given zone. */
function isoWeekday(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(instant);
  const index = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);

  // An unrecognised abbreviation would otherwise silently mean "Sunday" and
  // move every deadline. Treat it as a working day rather than guessing.
  return index === -1 ? 1 : index + 1;
}

function isWorkingDay(instant: Date, schedule: DispatchSchedule): boolean {
  // A mask of zero would mean "this place never works", which no operator
  // means and which would loop forever below. Read it as the default week.
  const mask = schedule.workingDaysMask === 0 ? 31 : schedule.workingDaysMask;

  return (mask & (1 << (isoWeekday(instant, schedule.timezone) - 1))) !== 0;
}

/** `HH:MM` as minutes past midnight, or null when it is not one. */
function minutesOfDay(cutoff: string | null): number | null {
  if (cutoff === null) return null;

  const match = /^(\d{1,2}):(\d{2})$/.exec(cutoff.trim());
  if (match === null) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes;
}

/**
 * When this order has to be out of the door.
 *
 * Counted on the seller's own clock, in working days their own calendar
 * decides, and it is what the overdue list and every SLA figure are measured
 * against - so it is computed once, here, rather than in the screen that
 * happens to be drawing a badge.
 *
 * An order accepted after the cut-off has missed today's van: the count starts
 * tomorrow, because pretending otherwise gives the seller a deadline they
 * could never have met. The deadline itself lands at the cut-off on the last
 * working day counted, or at the end of that day where a building has never
 * stated one - a deadline of "some time on Thursday" is honestly the end of
 * Thursday, not the start of it.
 *
 * Public holidays are deliberately not modelled, for the reason given in
 * `addBusinessDays`: a hard-coded list that is wrong is worse than a seller
 * widening their own handling time on purpose.
 */
export function dispatchDeadline(schedule: DispatchSchedule, acceptedAt: Date): Date {
  const cutoffMinutes = minutesOfDay(schedule.dispatchCutoff);
  const endOfDayMinutes = 23 * 60 + 59;

  const dayMs = 24 * 60 * 60 * 1000;
  let cursor = acceptedAt;

  /*
   * Today only counts if the building is open and the van has not gone.
   *
   * Both halves matter: accepted at 9am on a Saturday the count starts on
   * Monday, and accepted at 6pm on a Tuesday with a 5pm cut-off it starts on
   * Wednesday.
   */
  const past =
    cutoffMinutes !== null &&
    afterCutoff(acceptedAt, schedule.timezone, cutoffMinutes);

  if (past) cursor = new Date(cursor.getTime() + dayMs);

  while (!isWorkingDay(cursor, schedule)) {
    cursor = new Date(cursor.getTime() + dayMs);
  }

  let remaining = Math.max(0, Math.trunc(schedule.handlingTimeDays));

  while (remaining > 0) {
    cursor = new Date(cursor.getTime() + dayMs);
    if (isWorkingDay(cursor, schedule)) remaining -= 1;
  }

  const { year, month, day } = zonedCalendarDate(cursor, schedule.timezone);

  return zonedTimeToUtc(
    year,
    month,
    day,
    cutoffMinutes ?? endOfDayMinutes,
    schedule.timezone,
  );
}

/** Is this instant past `HH:MM` on its own day, in that zone? */
function afterCutoff(instant: Date, timeZone: string, cutoffMinutes: number): boolean {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }

  const hours = Number(parts['hour'] ?? '0');
  const minutes = Number(parts['minute'] ?? '0');

  return hours * 60 + minutes > cutoffMinutes;
}
