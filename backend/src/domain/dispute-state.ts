/**
 * Where a dispute stands, and how it moves.
 *
 * The only place a dispute's `status` is decided. Every service that changes
 * one asks this module first - the same rule the order, schedule, preorder
 * chat and support ticket state machines follow.
 *
 * Pure: no database, no clock. The service applies what this returns inside
 * its own transaction, conditionally on the status it read.
 *
 * TWO KINDS OF DISPUTE, ONE ENTITY
 *
 *   - **A claim** (`CLAIM`) is raised by the buyer on an order or one line of
 *     it: not received, damaged, not as described, and so on. The seller is
 *     asked to answer first; the operator decides.
 *
 *         AWAITING_SELLER --(seller answers / buyer escalates / staff take it)--> UNDER_REVIEW
 *         AWAITING_SELLER | UNDER_REVIEW | APPEALED --(decide)--> RESOLVED | REJECTED
 *         ... --(decide, refund above the approval threshold)--> PENDING_APPROVAL
 *         PENDING_APPROVAL --(a second member of staff approves)--> RESOLVED | REJECTED
 *         PENDING_APPROVAL --(the second member of staff refuses)--> UNDER_REVIEW
 *         RESOLVED | REJECTED --(one appeal, inside the window)--> APPEALED
 *         AWAITING_SELLER | UNDER_REVIEW --(buyer withdraws)--> WITHDRAWN
 *
 *   - **A chargeback** (`CHARGEBACK`) is the buyer's bank asking for the money
 *     back. Nobody here decides it: the card network does, and the payment
 *     provider tells us in signature-verified webhooks. Its moves are the
 *     provider's own statuses, translated by `chargebackStatusFor`.
 *
 *         CHARGEBACK_OPEN | NEEDS_RESPONSE | CHARGEBACK_UNDER_REVIEW --> any of those, WON or LOST
 *
 * FINAL IS FINAL
 *
 * WITHDRAWN, WON and LOST never move again. RESOLVED and REJECTED move only to
 * APPEALED, and only once (`appealCount`). A provider event that arrives late
 * and out of order - "under review" after "lost" - is refused here and the
 * service ignores it, so a redelivered or reordered webhook cannot reopen a
 * closed chargeback.
 */
import { ErrorCode, conflict } from './errors.js';

export const DisputeKindValues = ['CLAIM', 'CHARGEBACK'] as const;
export type DisputeKindName = (typeof DisputeKindValues)[number];

export const DisputeStatusValues = [
  'AWAITING_SELLER',
  'UNDER_REVIEW',
  'PENDING_APPROVAL',
  'RESOLVED',
  'REJECTED',
  'APPEALED',
  'WITHDRAWN',
  'CHARGEBACK_OPEN',
  'NEEDS_RESPONSE',
  'CHARGEBACK_UNDER_REVIEW',
  'WON',
  'LOST',
] as const;
export type DisputeStatusName = (typeof DisputeStatusValues)[number];

/** How a claim was, or may be, settled. `REJECT` is only ever a decision. */
export const DisputeResolutionValues = [
  'REFUND_FULL',
  'REFUND_PARTIAL',
  'REPLACEMENT',
  'REJECT',
] as const;
export type DisputeResolutionName = (typeof DisputeResolutionValues)[number];

/** What a buyer may ask for, or a seller offer. Everything but a rejection. */
export const DisputeRemedyValues = ['REFUND_FULL', 'REFUND_PARTIAL', 'REPLACEMENT'] as const;
export type DisputeRemedyName = (typeof DisputeRemedyValues)[number];

/**
 * Why a buyer raises a claim. The operator chooses which are offered, in
 * Settings; the names are fixed so every screen can say them in its language.
 */
export const DisputeReasonValues = [
  'NOT_RECEIVED',
  'DAMAGED',
  'NOT_AS_DESCRIBED',
  'QUALITY',
  'SHORT_QUANTITY',
  'OTHER',
] as const;
export type DisputeReasonName = (typeof DisputeReasonValues)[number];

/** Statuses somebody is still expected to act on. The console's default view. */
export const OPEN_CLAIM_STATUSES: readonly DisputeStatusName[] = Object.freeze([
  'AWAITING_SELLER',
  'UNDER_REVIEW',
  'PENDING_APPROVAL',
  'APPEALED',
]);

export const OPEN_CHARGEBACK_STATUSES: readonly DisputeStatusName[] = Object.freeze([
  'CHARGEBACK_OPEN',
  'NEEDS_RESPONSE',
  'CHARGEBACK_UNDER_REVIEW',
]);

export const OPEN_STATUSES: readonly DisputeStatusName[] = Object.freeze([
  ...OPEN_CLAIM_STATUSES,
  ...OPEN_CHARGEBACK_STATUSES,
]);

const FINAL: ReadonlySet<DisputeStatusName> = new Set(['WITHDRAWN', 'WON', 'LOST']);

/** Every move of a claim, from -> to. */
const CLAIM_TRANSITIONS: Readonly<Partial<Record<DisputeStatusName, readonly DisputeStatusName[]>>> =
  Object.freeze({
    AWAITING_SELLER: ['UNDER_REVIEW', 'PENDING_APPROVAL', 'RESOLVED', 'REJECTED', 'WITHDRAWN'],
    UNDER_REVIEW: ['PENDING_APPROVAL', 'RESOLVED', 'REJECTED', 'WITHDRAWN'],
    PENDING_APPROVAL: ['RESOLVED', 'REJECTED', 'UNDER_REVIEW'],
    RESOLVED: ['APPEALED'],
    REJECTED: ['APPEALED'],
    APPEALED: ['PENDING_APPROVAL', 'RESOLVED', 'REJECTED'],
    WITHDRAWN: [],
  });

const CHARGEBACK_TRANSITIONS: Readonly<
  Partial<Record<DisputeStatusName, readonly DisputeStatusName[]>>
> = Object.freeze({
  CHARGEBACK_OPEN: ['NEEDS_RESPONSE', 'CHARGEBACK_UNDER_REVIEW', 'WON', 'LOST'],
  NEEDS_RESPONSE: ['CHARGEBACK_UNDER_REVIEW', 'WON', 'LOST'],
  CHARGEBACK_UNDER_REVIEW: ['NEEDS_RESPONSE', 'WON', 'LOST'],
  WON: [],
  LOST: [],
});

export function canTransition(
  kind: DisputeKindName,
  from: DisputeStatusName,
  to: DisputeStatusName,
): boolean {
  const table = kind === 'CLAIM' ? CLAIM_TRANSITIONS : CHARGEBACK_TRANSITIONS;
  return (table[from] ?? []).includes(to);
}

/** Refuse a move the lifecycle does not have. 409, with both ends. */
export function assertDisputeTransition(
  kind: DisputeKindName,
  from: DisputeStatusName,
  to: DisputeStatusName,
): void {
  if (from === to || !canTransition(kind, from, to)) {
    throw conflict(
      ErrorCode.DISPUTE_TRANSITION_NOT_ALLOWED,
      FINAL.has(from)
        ? 'This dispute is closed and cannot change any more.'
        : `A dispute cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION', meta: { from, to, kind } }],
    );
  }
}

export function isFinal(status: DisputeStatusName): boolean {
  return FINAL.has(status);
}

export function isOpen(status: DisputeStatusName): boolean {
  return OPEN_STATUSES.includes(status);
}

/** Whether the parties may still write on it, add evidence, or be written to. */
export function acceptsMessages(status: DisputeStatusName): boolean {
  return !FINAL.has(status);
}

/** Where a decision lands: a rejection is REJECTED, every remedy RESOLVED. */
export function statusForDecision(resolution: DisputeResolutionName): DisputeStatusName {
  return resolution === 'REJECT' ? 'REJECTED' : 'RESOLVED';
}

/** Whether a resolution moves money back to the buyer. */
export function isRefund(resolution: DisputeResolutionName | null): boolean {
  return resolution === 'REFUND_FULL' || resolution === 'REFUND_PARTIAL';
}

/**
 * Whether a refund decision needs a second member of staff.
 *
 * Above the threshold, or in a different currency from it: comparing a figure
 * in euros against a threshold in rupees would be a guess, and a guess is the
 * wrong way round for a control. Pure; the threshold is a setting.
 */
export function needsSecondApproval(input: {
  resolution: DisputeResolutionName;
  amountMinor: bigint;
  currency: string;
  thresholdMinor: bigint;
  thresholdCurrency: string;
}): boolean {
  if (!isRefund(input.resolution)) return false;
  if (input.currency !== input.thresholdCurrency) return true;
  return input.amountMinor > input.thresholdMinor;
}

/**
 * Stripe's dispute status, as ours.
 *
 * Stripe's `warning_*` statuses are an inquiry (no money withdrawn yet) and
 * move the same way. `warning_closed` ended with no chargeback, which is a
 * win for the business. Anything Stripe has not announced is left open: open
 * is the state that takes no money from anybody's settlement.
 */
export function chargebackStatusFor(providerStatus: string | null | undefined): DisputeStatusName {
  switch (providerStatus) {
    case 'needs_response':
    case 'warning_needs_response':
      return 'NEEDS_RESPONSE';
    case 'under_review':
    case 'warning_under_review':
      return 'CHARGEBACK_UNDER_REVIEW';
    case 'won':
    case 'warning_closed':
      return 'WON';
    case 'lost':
      return 'LOST';
    default:
      return 'CHARGEBACK_OPEN';
  }
}

/**
 * The next status for a chargeback given what the provider now says, or null
 * when nothing should change: the same status again, or a late event that
 * would move a closed chargeback.
 */
export function nextChargebackStatus(
  current: DisputeStatusName,
  reported: DisputeStatusName,
): DisputeStatusName | null {
  if (current === reported) return null;
  return canTransition('CHARGEBACK', current, reported) ? reported : null;
}

/** Whether an SLA deadline has passed without the thing it waits for. */
export function isBreached(dueAt: Date | null, doneAt: Date | null, now: Date): boolean {
  if (dueAt === null) return false;
  if (doneAt !== null) return doneAt.getTime() > dueAt.getTime();
  return now.getTime() > dueAt.getTime();
}

/** A deadline `hours` after `from`. */
export function addHours(from: Date, hours: number): Date {
  return new Date(from.getTime() + hours * 3_600_000);
}
