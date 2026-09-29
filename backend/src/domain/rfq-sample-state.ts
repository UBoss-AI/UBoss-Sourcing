/**
 * Sample requests on a request for quotation (checklist Master row 20).
 *
 *   REQUESTED ──supplier accepts──► ACCEPTED ──supplier ships (courier + tracking)──► SHIPPED
 *      │  └─supplier declines─► DECLINED          │                                    │
 *      └─buyer cancels─► CANCELLED ◄──────────────┘                     buyer confirms receipt
 *                                                                                      ▼
 *                                               APPROVED ◄──buyer decides── DELIVERED ──► REJECTED
 *
 * Nothing is marked done without the event that makes it true: SHIPPED needs
 * the supplier to record the courier and a tracking number; DELIVERED needs
 * the buyer to say it arrived; APPROVED and REJECTED are the buyer's decision
 * against the approval criteria, a rejection with a reason. Payment is never
 * marked PAID here - collecting money for a sample is not built, so a sample
 * with a cost stays PAYMENT_PENDING and the screens say so.
 */
import { ErrorCode, conflict } from './errors.js';

export const RfqSampleStatusValues = [
  'REQUESTED',
  'ACCEPTED',
  'DECLINED',
  'SHIPPED',
  'DELIVERED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
] as const;
export type RfqSampleStatusName = (typeof RfqSampleStatusValues)[number];

type Actor = 'BUYER' | 'SUPPLIER';

const TRANSITIONS: Readonly<Record<RfqSampleStatusName, readonly { to: RfqSampleStatusName; actor: Actor; reason?: true }[]>> =
  Object.freeze({
    REQUESTED: [
      { to: 'ACCEPTED', actor: 'SUPPLIER' },
      { to: 'DECLINED', actor: 'SUPPLIER', reason: true },
      { to: 'CANCELLED', actor: 'BUYER' },
    ],
    ACCEPTED: [
      { to: 'SHIPPED', actor: 'SUPPLIER' },
      { to: 'CANCELLED', actor: 'BUYER' },
    ],
    SHIPPED: [{ to: 'DELIVERED', actor: 'BUYER' }],
    DELIVERED: [
      { to: 'APPROVED', actor: 'BUYER' },
      { to: 'REJECTED', actor: 'BUYER', reason: true },
    ],
    DECLINED: [],
    APPROVED: [],
    REJECTED: [],
    CANCELLED: [],
  });

export const TERMINAL_SAMPLE_STATUSES: readonly RfqSampleStatusName[] = Object.freeze([
  'DECLINED',
  'APPROVED',
  'REJECTED',
  'CANCELLED',
]);

export function allowedSampleTransitions(from: RfqSampleStatusName, actor: Actor): RfqSampleStatusName[] {
  return TRANSITIONS[from].filter((rule) => rule.actor === actor).map((rule) => rule.to);
}

export function assertSampleTransition(request: {
  from: RfqSampleStatusName;
  to: RfqSampleStatusName;
  actor: Actor;
  reason?: string | null;
}): void {
  const rule = TRANSITIONS[request.from].find((candidate) => candidate.to === request.to && candidate.actor === request.actor);
  if (rule === undefined) {
    throw conflict(
      ErrorCode.RFQ_SAMPLE_TRANSITION_NOT_ALLOWED,
      `A sample that is ${request.from.toLowerCase()} cannot be ${request.to.toLowerCase()} by the ${request.actor.toLowerCase()}.`,
      [{ code: request.from, meta: { from: request.from, to: request.to, actor: request.actor } }],
    );
  }
  if (rule.reason === true && (request.reason ?? '').trim().length === 0) {
    throw conflict(ErrorCode.RFQ_SAMPLE_TRANSITION_NOT_ALLOWED, 'Give a reason the other side can read.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }
}
