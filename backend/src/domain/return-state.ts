/**
 * Where a return stands, and how it moves.
 *
 * The only place a return's `status` is decided - the same rule the order,
 * schedule and support-ticket state machines follow. Every service that
 * changes one calls `assertReturnTransition` first and writes the result in
 * the same transaction.
 *
 * Pure: no database, no clock.
 *
 *   REQUESTED --approve--> APPROVED --receive--> RECEIVED --inspect--> INSPECTED --refund/replace--> COMPLETED
 *       |                     |                                          |
 *       +------reject---------+-------------------reject-----------------+--> REJECTED
 *
 * A rejection always carries a reason, because the buyer is told it. REJECTED
 * and COMPLETED are final: a problem that comes back is a new return.
 *
 * Who may move it:
 *   - approve / reject: staff only. The seller answers (accept or contest),
 *     and the operator decides with that answer in front of them.
 *   - receive / inspect: staff, or the seller of those goods - a marketplace
 *     return goes back to the seller's own building, so they are the one who
 *     opens the box.
 *   - complete: staff (a replacement) or the system (the refund went out).
 */
import { ErrorCode, conflict } from './errors.js';

export const ReturnStatusValues = [
  'REQUESTED',
  'APPROVED',
  'REJECTED',
  'RECEIVED',
  'INSPECTED',
  'COMPLETED',
] as const;

export type ReturnStatusName = (typeof ReturnStatusValues)[number];

export type ReturnActor = 'STAFF' | 'SELLER' | 'SYSTEM';

/** Statuses a return is still being worked in. */
export const OPEN_RETURN_STATUSES: readonly ReturnStatusName[] = Object.freeze([
  'REQUESTED',
  'APPROVED',
  'RECEIVED',
  'INSPECTED',
]);

interface Rule {
  to: ReturnStatusName;
  actors: readonly ReturnActor[];
  requiresReason?: boolean;
}

const TRANSITIONS: Readonly<Record<ReturnStatusName, readonly Rule[]>> = Object.freeze({
  REQUESTED: [
    { to: 'APPROVED', actors: ['STAFF'] },
    { to: 'REJECTED', actors: ['STAFF'], requiresReason: true },
  ],
  APPROVED: [
    { to: 'RECEIVED', actors: ['STAFF', 'SELLER'] },
    { to: 'REJECTED', actors: ['STAFF'], requiresReason: true },
  ],
  RECEIVED: [
    { to: 'INSPECTED', actors: ['STAFF', 'SELLER'] },
    { to: 'REJECTED', actors: ['STAFF'], requiresReason: true },
  ],
  INSPECTED: [
    { to: 'COMPLETED', actors: ['STAFF', 'SYSTEM'] },
    { to: 'REJECTED', actors: ['STAFF'], requiresReason: true },
  ],
  REJECTED: [],
  COMPLETED: [],
});

/** What this actor may do next - the buttons a screen shows. */
export function allowedReturnTransitions(
  from: ReturnStatusName,
  actor: ReturnActor,
): { to: ReturnStatusName; requiresReason: boolean }[] {
  return (TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => ({ to: rule.to, requiresReason: rule.requiresReason === true }));
}

/** Throws RETURN_TRANSITION_NOT_ALLOWED unless the move is legal for this actor. */
export function assertReturnTransition(input: {
  from: ReturnStatusName;
  to: ReturnStatusName;
  actor: ReturnActor;
  reason?: string | null;
}): void {
  const rule = (TRANSITIONS[input.from] ?? []).find((candidate) => candidate.to === input.to);
  if (rule === undefined || !rule.actors.includes(input.actor)) {
    throw conflict(
      ErrorCode.RETURN_TRANSITION_NOT_ALLOWED,
      `A return that is ${input.from.toLowerCase()} cannot be moved to ${input.to.toLowerCase()}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from: input.from, to: input.to } }],
    );
  }
  if (rule.requiresReason === true && (input.reason ?? '').trim().length === 0) {
    throw conflict(ErrorCode.RETURN_TRANSITION_NOT_ALLOWED, 'A reason is required.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Reason codes
// ---------------------------------------------------------------------------

/**
 * Every reason a buyer may give. The operator chooses which of these their
 * buyers see, and which need a photograph; the words for each are in the
 * storefront's eight languages, keyed by the code.
 *
 * Add a code at the end; never rename or reuse one - stored returns keep it.
 */
export const RETURN_REASON_CODES = Object.freeze([
  'DAMAGED_IN_TRANSIT',
  'DEFECTIVE',
  'WRONG_ITEM',
  'NOT_AS_DESCRIBED',
  'MISSING_PARTS',
  'EXPIRED_OR_SHORT_DATED',
  'ORDERED_BY_MISTAKE',
  'NO_LONGER_NEEDED',
  'OTHER',
] as const);

export type ReturnReasonCode = (typeof RETURN_REASON_CODES)[number];

export function isReturnReasonCode(value: string): value is ReturnReasonCode {
  return (RETURN_REASON_CODES as readonly string[]).includes(value);
}

/** What a fresh installation starts with. Every code, and proof for the physical faults. */
export const DEFAULT_RETURN_POLICY = Object.freeze({
  windowDays: 14,
  reasonCodes: RETURN_REASON_CODES,
  evidenceRequired: [
    'DAMAGED_IN_TRANSIT',
    'DEFECTIVE',
    'WRONG_ITEM',
    'NOT_AS_DESCRIBED',
    'MISSING_PARTS',
  ] as readonly ReturnReasonCode[],
  replacementEnabled: false,
});

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/**
 * What `quantity` units of one order line cost the buyer, tax and discount
 * included. The whole line returns its exact total; a part of it is the
 * line total pro rata, rounded down, so the parts of a line returned in
 * several goes can never add up to more than the line.
 */
export function returnedLineValueMinor(
  line: { lineTotalMinor: bigint; quantity: number },
  returnedQuantity: number,
): bigint {
  if (returnedQuantity <= 0 || line.quantity <= 0) return 0n;
  if (returnedQuantity >= line.quantity) return line.lineTotalMinor;
  return (line.lineTotalMinor * BigInt(returnedQuantity)) / BigInt(line.quantity);
}
