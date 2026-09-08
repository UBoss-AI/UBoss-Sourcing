/**
 * Plan and occurrence state machines.
 *
 * The same rule as `order-state-machine.ts`, for the same reason: no service
 * writes `recurring_schedules.status` or `schedule_occurrences.status`
 * directly. Every change comes through `assertPlanTransition` or
 * `assertOccurrenceTransition`, so what is legal lives in one file that can be
 * read in one sitting and tested exhaustively.
 *
 * This matters more here than it does for orders. An order changes status
 * because somebody clicked something and is watching the result. An occurrence
 * changes status inside a worker at 06:00 with nobody watching, and the states
 * it moves between decide whether a card gets charged. A transition table that
 * is merely *usually* right produces a duplicate charge on a real card.
 *
 * Two invariants the table below encodes, both worth stating outright:
 *
 *   1. **Nothing returns to a pre-payment state from a paid one.** There is no
 *      edge out of PROCESSING, PAID_ERP_PENDING or COMPLETED back to
 *      PAYMENT_PENDING or AWAITING_VALIDATION. If such an edge existed, a
 *      retry could re-enter the charge path on an occurrence whose money has
 *      already moved - which is exactly the failure this whole module exists
 *      to make impossible.
 *
 *   2. **PAID_ERP_PENDING is not a failure state.** It is a paid occurrence
 *      with unfinished paperwork, and its only exits are COMPLETED (the ERP
 *      accepted it) or staying put (retry later). It never goes to FAILED,
 *      because "failed" would tell the customer their order did not happen
 *      when their money is gone and the order is real.
 */
import { ErrorCode, conflict } from './errors.js';

// ---------------------------------------------------------------------------
// Plan status
// ---------------------------------------------------------------------------

export const PlanStatusValues = [
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
  'COMPLETED',
  'FAILED',
] as const;

export type PlanStatusName = (typeof PlanStatusValues)[number];

export type ScheduleActorKind = 'SYSTEM' | 'ADMIN' | 'CUSTOMER';

interface PlanRule {
  to: PlanStatusName;
  actors: readonly ScheduleActorKind[];
  requiresReason?: boolean;
}

/**
 * Legal plan transitions.
 *
 * Deliberately absent:
 *   - Anything back to DRAFT. A plan the customer has authorised cannot become
 *     unauthorised; they cancel it and build another.
 *   - CANCELLED -> anything. Terminal, so a cancelled standing authority to
 *     charge cannot be revived by a bug or a stale request.
 *   - COMPLETED -> ACTIVE. A finished plan is finished. Extending one means
 *     changing its end date while it is still ACTIVE, not resurrecting it.
 *   - Anything -> ACTIVE by SYSTEM. A plan only ever becomes live because a
 *     person said so; nothing in a worker may resume one on its own.
 */
const PLAN_TRANSITIONS: Readonly<Record<PlanStatusName, readonly PlanRule[]>> = Object.freeze({
  DRAFT: [
    // The review screen's confirm button. CUSTOMER is the actor that matters:
    // consent has to come from the person being charged.
    { to: 'ACTIVE', actors: ['CUSTOMER', 'ADMIN'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
  ],

  ACTIVE: [
    { to: 'PAUSED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
    // End date passed, or maxOccurrences reached. A ONE_TIME plan lands here
    // the moment its single occurrence completes.
    { to: 'COMPLETED', actors: ['SYSTEM'] },
    // failureCount reached maxFailures.
    { to: 'FAILED', actors: ['SYSTEM'], requiresReason: true },
  ],

  PAUSED: [
    { to: 'ACTIVE', actors: ['CUSTOMER', 'ADMIN'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
    // A plan paused past its own end date has nothing left to run.
    { to: 'COMPLETED', actors: ['SYSTEM'] },
  ],

  // Somebody stopped it. Terminal.
  CANCELLED: [],

  // Ran its course. Terminal.
  COMPLETED: [],

  FAILED: [
    // The customer is allowed to restart their own subscription.
    //
    // Tempting to reserve this for staff - repeated failures suggest something
    // worth a look. But the thing that usually failed is the customer's card,
    // and the person who can fix that is the customer. Making them wait for
    // office hours to restart a delivery they are paying for is bad service in
    // exchange for very little: `resumeSchedule` revalidates the instrument
    // before it sets the plan ACTIVE, so a resume onto a still-dead card is
    // refused there rather than here.
    { to: 'ACTIVE', actors: ['CUSTOMER', 'ADMIN'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
  ],
});

/** Plan statuses from which nothing further can happen. */
export const TERMINAL_PLAN_STATUSES: readonly PlanStatusName[] = Object.freeze([
  'CANCELLED',
  'COMPLETED',
]);

/** The only status in which the worker will look at a plan. */
export function isRunnablePlanStatus(status: PlanStatusName): boolean {
  return status === 'ACTIVE';
}

export function isTerminalPlanStatus(status: PlanStatusName): boolean {
  return TERMINAL_PLAN_STATUSES.includes(status);
}

export interface PlanTransitionRequest {
  from: PlanStatusName;
  to: PlanStatusName;
  actor: ScheduleActorKind;
  reason?: string;
}

export function canTransitionPlan(request: PlanTransitionRequest): boolean {
  return (PLAN_TRANSITIONS[request.from] ?? []).some(
    (rule) => rule.to === request.to && rule.actors.includes(request.actor),
  );
}

/** What this actor may do with a plan in this status. Drives the UI's buttons. */
export function allowedPlanTransitions(
  from: PlanStatusName,
  actor: ScheduleActorKind,
): { to: PlanStatusName; requiresReason: boolean }[] {
  return (PLAN_TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => ({ to: rule.to, requiresReason: rule.requiresReason === true }));
}

export function assertPlanTransition(request: PlanTransitionRequest): void {
  const { from, to, actor, reason } = request;

  if (from === to) {
    throw conflict(ErrorCode.SCHEDULE_NOT_ACTIVE, `This schedule is already ${to.toLowerCase()}.`, [
      { code: 'SAME_STATUS', meta: { from, to } },
    ]);
  }

  // Said separately from "no such transition", because the customer-facing
  // sentence is different and this is the case they actually hit.
  if (from === 'CANCELLED') {
    throw conflict(
      ErrorCode.SCHEDULE_ALREADY_CANCELLED,
      'This schedule has already been cancelled.',
      [{ code: 'TERMINAL_STATUS', meta: { from, to } }],
    );
  }

  const rule = (PLAN_TRANSITIONS[from] ?? []).find((candidate) => candidate.to === to);

  if (rule === undefined) {
    throw conflict(
      ErrorCode.SCHEDULE_TRANSITION_NOT_ALLOWED,
      `A schedule cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.SCHEDULE_TRANSITION_NOT_ALLOWED,
      from === 'COMPLETED'
        ? 'This schedule has already finished. Create a new one instead.'
        : `You cannot move a schedule from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  if (rule.requiresReason === true && (reason === undefined || reason.trim().length === 0)) {
    throw conflict(
      ErrorCode.SCHEDULE_TRANSITION_NOT_ALLOWED,
      `Moving a schedule to ${to} requires a reason.`,
      [{ field: 'reason', code: 'REASON_REQUIRED', meta: { from, to } }],
    );
  }
}

// ---------------------------------------------------------------------------
// Occurrence status
// ---------------------------------------------------------------------------

export const OccurrenceStatusValues = [
  'SCHEDULED',
  'AWAITING_VALIDATION',
  'PAYMENT_PENDING',
  'ACTION_REQUIRED',
  'PROCESSING',
  'PAID_ERP_PENDING',
  'COMPLETED',
  'SKIPPED',
  'CANCELLED',
  'FAILED',
] as const;

export type OccurrenceStatusName = (typeof OccurrenceStatusValues)[number];

/**
 * Statuses written by the engine that shipped before this state machine.
 *
 * Still readable, never written. They are listed so that code which has to
 * cope with historical rows - the customer's list, the admin console, a report
 * - can say so explicitly instead of quietly falling through a switch.
 */
export const LEGACY_OCCURRENCE_STATUSES = Object.freeze(['PENDING', 'ORDER_CREATED', 'PAID']);

export type AnyOccurrenceStatus = OccurrenceStatusName | 'PENDING' | 'ORDER_CREATED' | 'PAID';

export function isLegacyOccurrenceStatus(status: string): boolean {
  return LEGACY_OCCURRENCE_STATUSES.includes(status);
}

interface OccurrenceRule {
  to: OccurrenceStatusName;
  actors: readonly ScheduleActorKind[];
}

/**
 * Legal occurrence transitions.
 *
 * Read the absent edges as carefully as the present ones - see the header. The
 * shape is a funnel with three ways out (COMPLETED, SKIPPED/CANCELLED, FAILED)
 * and no way back up past the point where money moved.
 */
const OCCURRENCE_TRANSITIONS: Readonly<
  Record<OccurrenceStatusName, readonly OccurrenceRule[]>
> = Object.freeze({
  SCHEDULED: [
    // The worker claiming the slot.
    { to: 'AWAITING_VALIDATION', actors: ['SYSTEM'] },
    // The customer skipping this cycle before it runs.
    { to: 'SKIPPED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
  ],

  AWAITING_VALIDATION: [
    // Revalidated; a charge is being started.
    { to: 'PAYMENT_PENDING', actors: ['SYSTEM'] },
    // Held: stock short, product withdrawn, price moved beyond tolerance.
    { to: 'SKIPPED', actors: ['SYSTEM', 'ADMIN'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
    { to: 'FAILED', actors: ['SYSTEM'] },
  ],

  PAYMENT_PENDING: [
    // Captured. Now the order and the ERP.
    { to: 'PROCESSING', actors: ['SYSTEM'] },
    // Stripe wants the cardholder. Only they can clear it.
    { to: 'ACTION_REQUIRED', actors: ['SYSTEM'] },
    { to: 'FAILED', actors: ['SYSTEM'] },
    // An admin stopping a charge that is out as a payment link.
    { to: 'CANCELLED', actors: ['ADMIN'] },
  ],

  ACTION_REQUIRED: [
    // The customer authenticated and the retry went through.
    { to: 'PROCESSING', actors: ['SYSTEM'] },
    // Re-attempted after they updated their card.
    { to: 'PAYMENT_PENDING', actors: ['SYSTEM', 'CUSTOMER'] },
    // The window closed with no authentication.
    { to: 'FAILED', actors: ['SYSTEM'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
  ],

  PROCESSING: [
    { to: 'COMPLETED', actors: ['SYSTEM'] },
    // Paid, order created, ERP refused or unreachable.
    { to: 'PAID_ERP_PENDING', actors: ['SYSTEM'] },
  ],

  PAID_ERP_PENDING: [
    // The ERP finally took it. The only forward exit.
    { to: 'COMPLETED', actors: ['SYSTEM'] },
  ],

  COMPLETED: [],
  SKIPPED: [],
  CANCELLED: [],

  FAILED: [
    // A bounded retry: the money did not move, so re-entering validation is
    // safe. `paymentAttemptCount` is what bounds it, not this table.
    { to: 'AWAITING_VALIDATION', actors: ['SYSTEM'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'] },
  ],
});

/** Occurrence statuses from which nothing further happens. */
export const TERMINAL_OCCURRENCE_STATUSES: readonly OccurrenceStatusName[] = Object.freeze([
  'COMPLETED',
  'SKIPPED',
  'CANCELLED',
]);

export function isTerminalOccurrenceStatus(status: string): boolean {
  return (TERMINAL_OCCURRENCE_STATUSES as readonly string[]).includes(status);
}

/**
 * Has this occurrence's money moved?
 *
 * The question every retry path has to ask before it does anything. A `true`
 * here means the charge path must not be re-entered under any circumstances.
 */
export function hasCapturedPayment(status: string): boolean {
  return (
    status === 'PROCESSING' ||
    status === 'PAID_ERP_PENDING' ||
    status === 'COMPLETED' ||
    // Legacy: the old engine's PAID meant the same thing.
    status === 'PAID'
  );
}

/**
 * May the customer still change or skip this occurrence?
 *
 * Only before the worker has touched it. Once it is AWAITING_VALIDATION the
 * engine is already pricing it, and an edit would race the charge.
 */
export function isCustomerEditable(status: string): boolean {
  return status === 'SCHEDULED';
}

export interface OccurrenceTransitionRequest {
  from: AnyOccurrenceStatus;
  to: OccurrenceStatusName;
  actor: ScheduleActorKind;
}

export function canTransitionOccurrence(request: OccurrenceTransitionRequest): boolean {
  if (isLegacyOccurrenceStatus(request.from)) return false;

  return (OCCURRENCE_TRANSITIONS[request.from as OccurrenceStatusName] ?? []).some(
    (rule) => rule.to === request.to && rule.actors.includes(request.actor),
  );
}

export function assertOccurrenceTransition(request: OccurrenceTransitionRequest): void {
  const { from, to, actor } = request;

  if (isLegacyOccurrenceStatus(from)) {
    throw conflict(
      ErrorCode.OCCURRENCE_TRANSITION_NOT_ALLOWED,
      'This order cycle was recorded by an earlier version and can no longer be changed.',
      [{ code: 'LEGACY_STATUS', meta: { from, to } }],
    );
  }

  if (from === to) {
    throw conflict(
      ErrorCode.OCCURRENCE_TRANSITION_NOT_ALLOWED,
      `This order cycle is already ${to.toLowerCase().replace(/_/g, ' ')}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  const rule = (OCCURRENCE_TRANSITIONS[from as OccurrenceStatusName] ?? []).find(
    (candidate) => candidate.to === to,
  );

  if (rule === undefined) {
    // Worth a distinct sentence: this is the guard that stops a paid
    // occurrence being pushed back into the charge path.
    if (hasCapturedPayment(from)) {
      throw conflict(
        ErrorCode.OCCURRENCE_TRANSITION_NOT_ALLOWED,
        `This order cycle has already been paid and cannot move to ${to}.`,
        [{ code: 'ALREADY_PAID', meta: { from, to } }],
      );
    }

    throw conflict(
      ErrorCode.OCCURRENCE_TRANSITION_NOT_ALLOWED,
      `An order cycle cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.OCCURRENCE_TRANSITION_NOT_ALLOWED,
      `You cannot move an order cycle from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

/**
 * The stable key for one occurrence and everything it causes.
 *
 * A pure function of the two fields that identify the slot, which is the whole
 * point: a retry, a second worker, a replayed job and a redelivered webhook all
 * recompute the *same* string rather than minting a new one. Every side effect
 * downstream - the Stripe charge, the platform order, the ERP push, the
 * inventory movement - derives its own key from this one, so they all collapse
 * together on a retry instead of half of them repeating.
 *
 * The format is fixed and mirrored in SQL by the backfill in
 * `20260908180000_scheduled_orders_and_subscriptions`. Changing it would orphan
 * every key already stored, so it must not be changed without a migration that
 * rewrites them.
 *
 *   occ:<26-char plan ULID>:<YYYYMMDDHHMMSSmmm>   -> 48 characters
 *
 * The timestamp is rendered from the UTC instant, never from local components:
 * the same slot has to produce the same key on a server in Kolkata and one in
 * Brussels.
 */
export function occurrenceIdempotencyKey(scheduleId: string, plannedRunAt: Date): string {
  const iso = plannedRunAt.toISOString(); // 2026-09-08T06:00:00.000Z
  const stamp = iso.slice(0, 23).replace(/[-:.TZ]/g, '');
  return `occ:${scheduleId}:${stamp}`;
}

/**
 * Derive a child key for one side effect of an occurrence.
 *
 * Kept as a function rather than string concatenation at each call site so
 * every derived key is visibly a child of the occurrence key, and so the set of
 * purposes is a closed list that can be read here.
 */
export function derivedIdempotencyKey(
  occurrenceKey: string,
  purpose: 'payment' | 'order' | 'erp' | 'stock',
): string {
  return `${occurrenceKey}:${purpose}`;
}
