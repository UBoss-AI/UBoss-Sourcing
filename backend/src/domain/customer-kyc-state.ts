/**
 * Where an individual buyer's identity check may move, and who may move it
 * (checklist Master row 11). Pure; the service asks before every write.
 *
 *   NOT_STARTED ──buyer submits──▶ SUBMITTED ──staff──▶ VERIFIED ──expiry──▶ EXPIRED
 *        ▲                            │                                       │
 *        └──────── REJECTED ◀──staff──┘      REJECTED / EXPIRED ──buyer resubmits──▶ SUBMITTED
 *
 * The identity details are editable only where the buyer may submit from:
 * NOT_STARTED, REJECTED and EXPIRED. While SUBMITTED they are with a reviewer,
 * and a VERIFIED check describes exactly the details that were checked.
 */
import { ErrorCode, conflict } from './errors.js';

export type CustomerKycStatusName = 'NOT_STARTED' | 'SUBMITTED' | 'VERIFIED' | 'REJECTED' | 'EXPIRED';
export type CustomerKycActor = 'BUYER' | 'STAFF' | 'SYSTEM';

const MOVES: Record<CustomerKycStatusName, { to: CustomerKycStatusName; actors: CustomerKycActor[] }[]> = {
  NOT_STARTED: [{ to: 'SUBMITTED', actors: ['BUYER'] }],
  SUBMITTED: [
    { to: 'VERIFIED', actors: ['STAFF'] },
    { to: 'REJECTED', actors: ['STAFF'] },
  ],
  VERIFIED: [
    { to: 'EXPIRED', actors: ['SYSTEM', 'STAFF'] },
    // Staff can withdraw a verification that turned out wrong.
    { to: 'REJECTED', actors: ['STAFF'] },
  ],
  REJECTED: [{ to: 'SUBMITTED', actors: ['BUYER'] }],
  EXPIRED: [{ to: 'SUBMITTED', actors: ['BUYER'] }],
};

export function canMoveCustomerKyc(from: CustomerKycStatusName, to: CustomerKycStatusName, actor: CustomerKycActor): boolean {
  return MOVES[from].some((move) => move.to === to && move.actors.includes(actor));
}

export function assertCustomerKycTransition(input: {
  from: CustomerKycStatusName;
  to: CustomerKycStatusName;
  actor: CustomerKycActor;
}): void {
  if (!canMoveCustomerKyc(input.from, input.to, input.actor)) {
    throw conflict(
      ErrorCode.CUSTOMER_KYC_TRANSITION_INVALID,
      `An identity check that is ${input.from.toLowerCase().replace('_', ' ')} cannot be moved to ${input.to.toLowerCase().replace('_', ' ')}.`,
      [{ code: 'TRANSITION', meta: { from: input.from, to: input.to, actor: input.actor } }],
    );
  }
}

/** The identity details may be changed only where the buyer could submit from. */
export function isKycEditable(status: CustomerKycStatusName): boolean {
  return status === 'NOT_STARTED' || status === 'REJECTED' || status === 'EXPIRED';
}

/**
 * The only form an identity-document number is ever kept in: its last four
 * characters, the rest replaced. Spaces and dashes are ignored for counting.
 */
export function maskDocumentNumber(raw: string): string {
  const compact = raw.replace(/[\s-]/g, '');
  const tail = compact.slice(-4);
  return `${'•'.repeat(Math.max(4, Math.min(compact.length - tail.length, 12)))}${tail}`;
}
