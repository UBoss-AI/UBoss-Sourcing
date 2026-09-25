/**
 * Payment attempt states, and which may follow which.
 *
 * `payment_transactions.status` is written from several places - a webhook, a
 * reconciliation, a Checkout Session opening or closing - and every one of
 * them writes it with a conditional UPDATE so that two of them racing cannot
 * both win. This module is where the conditions come from, so they are stated
 * once instead of being re-derived at each call site.
 *
 * THE STORED STATES ARE THE MONEY'S OWN LIFECYCLE, AND NOTHING ELSE.
 *
 *   CREATED     The attempt exists. For Stripe Checkout, the session may or
 *               may not have been opened yet - `providerSessionId` says which.
 *   PENDING     The customer has submitted and the bank has not answered:
 *               a delayed method still settling, or 3-D Secure outstanding.
 *   AUTHORIZED  Held but not taken. Never treated as paid.
 *   CAPTURED    The money moved. Terminal.
 *   FAILED      This attempt will not take money.
 *   CANCELLED   Closed by the customer or by us before any money moved.
 *   EXPIRED     The gateway closed it unpaid.
 *
 * Refunds and disputes are NOT stored here, on purpose. A captured payment
 * that is later refunded still captured; the refund is a second fact with its
 * own row, its own status and its own amount, and a partial refund is not a
 * state a payment can be "in" at all. `lifecycleState` below derives the
 * richer vocabulary - REFUNDED, PARTIALLY_REFUNDED, DISPUTED - from those
 * facts for anybody who wants to read it, without ever writing it.
 *
 * THE ONE RULE THAT OVERRIDES THE REST: a capture is always recorded.
 * Money that Stripe says moved has moved, whatever this system believed about
 * the attempt a moment earlier. So CAPTURED may follow every other state,
 * including the closed ones - and when it follows a closed one, the caller
 * alerts finance, because a customer has paid for an attempt this system had
 * given up on.
 */
import type { PaymentTransactionStatus } from '../generated/prisma/enums.js';

export type PaymentStatus = PaymentTransactionStatus;

export const PAYMENT_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'CREATED',
  'PENDING',
  'AUTHORIZED',
  'CAPTURED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

/** Where each state may go next. CAPTURED goes nowhere. */
const TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = Object.freeze({
  CREATED: ['PENDING', 'AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PENDING: ['AUTHORIZED', 'CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  AUTHORIZED: ['CAPTURED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  CAPTURED: [],
  // A PaymentIntent that declined can still succeed on the same intent when
  // the customer tries another card, so FAILED is not the end of it.
  FAILED: ['PENDING', 'CAPTURED'],
  // Only a capture may follow a closed attempt. See the header.
  CANCELLED: ['CAPTURED'],
  EXPIRED: ['CAPTURED'],
});

/** Attempts that may still take money, and so still hold the order's slot. */
export const OPEN_PAYMENT_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'CREATED',
  'PENDING',
  'AUTHORIZED',
]);

/** Closed attempts that took nothing. The order may be paid by another. */
export const UNPAID_CLOSED_STATUSES: readonly PaymentStatus[] = Object.freeze([
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

export class PaymentTransitionError extends Error {
  constructor(
    readonly from: PaymentStatus,
    readonly to: PaymentStatus,
  ) {
    super(`A payment cannot move from ${from} to ${to}.`);
    this.name = 'PaymentTransitionError';
  }
}

export function canTransitionPayment(from: PaymentStatus, to: PaymentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) throw new PaymentTransitionError(from, to);
}

/**
 * Every state that may move INTO `to`.
 *
 * What a conditional UPDATE puts in its `where`: `status: { in: sourcesOf(x) }`
 * matches exactly the rows allowed to become `x`, so a row that has already
 * moved on - captured by the other route, say - matches nothing and the caller
 * can tell from the count.
 */
export function paymentSourcesOf(to: PaymentStatus): PaymentStatus[] {
  return PAYMENT_STATUSES.filter((from) => TRANSITIONS[from].includes(to));
}

export function isOpenPayment(status: PaymentStatus): boolean {
  return OPEN_PAYMENT_STATUSES.includes(status);
}

/**
 * The full vocabulary, derived rather than stored.
 *
 * What an administrator or a report means by "the state of this payment":
 * the stored status, refined by the facts kept beside it. The mapping, in the
 * words the integration was specified in:
 *
 *   CREATED                   stored CREATED, no Checkout Session yet
 *   CHECKOUT_SESSION_CREATED  stored CREATED, with a session
 *   PROCESSING                stored PENDING, the bank is settling it
 *   REQUIRES_ACTION           stored PENDING, the bank wants the cardholder
 *   AUTHORIZED                stored AUTHORIZED
 *   SUCCEEDED                 stored CAPTURED
 *   PARTIALLY_REFUNDED        CAPTURED, some but not all of it refunded
 *   REFUNDED                  CAPTURED, all of it refunded
 *   DISPUTED                  CAPTURED, a chargeback has been opened
 *   FAILED / CANCELLED / EXPIRED   as stored
 *
 * DISPUTED outranks the refund states: a disputed payment needs somebody's
 * attention whatever else has happened to it.
 */
export type PaymentLifecycleState =
  | 'CREATED'
  | 'CHECKOUT_SESSION_CREATED'
  | 'PROCESSING'
  | 'REQUIRES_ACTION'
  | 'AUTHORIZED'
  | 'SUCCEEDED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'DISPUTED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export function lifecycleState(input: {
  status: PaymentStatus;
  providerSessionId: string | null;
  failureCode: string | null;
  capturedMinor: bigint;
  refundedMinor: bigint;
  disputedAt: Date | null;
}): PaymentLifecycleState {
  switch (input.status) {
    case 'CREATED':
      return input.providerSessionId === null ? 'CREATED' : 'CHECKOUT_SESSION_CREATED';
    case 'PENDING':
      return input.failureCode === 'authentication_required' ? 'REQUIRES_ACTION' : 'PROCESSING';
    case 'AUTHORIZED':
      return 'AUTHORIZED';
    case 'CAPTURED':
      if (input.disputedAt !== null) return 'DISPUTED';
      if (input.refundedMinor > 0n && input.refundedMinor >= input.capturedMinor) return 'REFUNDED';
      if (input.refundedMinor > 0n) return 'PARTIALLY_REFUNDED';
      return 'SUCCEEDED';
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return input.status;
    default: {
      const exhaustive: never = input.status;
      return exhaustive;
    }
  }
}
