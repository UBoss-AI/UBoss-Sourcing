/**
 * Order state machine.
 *
 * Every status change in the system goes through `assertTransition`. Services
 * never write `status` directly. This is the single place that decides what is
 * legal, so the Admin Panel can ask "what can I do with this order?" and get an
 * answer that is guaranteed to match what the API will accept.
 *
 * The ten statuses are fixed by the SOP (section 9.1) and must not be extended
 * without a matching business decision.
 */
import { ErrorCode, conflict } from './errors.js';

export const OrderStatusValues = [
  'DRAFT',
  'PENDING_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
  'CANCELLED',
  'RETURNED',
  'REFUNDED',
] as const;

export type OrderStatusName = (typeof OrderStatusValues)[number];

/** Who is allowed to request a transition. Guards layer on top of this. */
export type TransitionActor = 'SYSTEM' | 'ADMIN' | 'CUSTOMER';

interface TransitionRule {
  to: OrderStatusName;
  actors: readonly TransitionActor[];
  /** Permission key an ADMIN actor must hold. Undefined = any admin role. */
  permission?: string;
  /** Free-text reason required from the actor (cancellations, rejections). */
  requiresReason?: boolean;
}

/**
 * Adjacency list of legal transitions.
 *
 * Deliberately absent, and the reasons why:
 *   - CONFIRMED -> PENDING_PAYMENT: money already settled; re-opening payment
 *     would let a second charge attach to a paid order.
 *   - DELIVERED -> CANCELLED: after delivery the only route back is RETURNED.
 *   - Anything out of REFUNDED: it is terminal by design.
 */
const TRANSITIONS: Readonly<Record<OrderStatusName, readonly TransitionRule[]>> = Object.freeze({
  DRAFT: [
    { to: 'PENDING_APPROVAL', actors: ['SYSTEM'] },
    { to: 'PENDING_PAYMENT', actors: ['SYSTEM'] },
    { to: 'CANCELLED', actors: ['CUSTOMER', 'ADMIN', 'SYSTEM'], requiresReason: true },
  ],

  PENDING_APPROVAL: [
    { to: 'PENDING_PAYMENT', actors: ['ADMIN', 'SYSTEM'], permission: 'order.approve' },
    // An approved order with a zero balance (fully covered) skips payment.
    { to: 'CONFIRMED', actors: ['SYSTEM'] },
    {
      to: 'CANCELLED',
      actors: ['ADMIN', 'CUSTOMER', 'SYSTEM'],
      permission: 'order.approve',
      requiresReason: true,
    },
  ],

  PENDING_PAYMENT: [
    // Reached ONLY from a signature-verified provider event, never from a
    // client redirect. See the payments module.
    { to: 'CONFIRMED', actors: ['SYSTEM'] },
    { to: 'CANCELLED', actors: ['ADMIN', 'CUSTOMER', 'SYSTEM'], requiresReason: true },
  ],

  CONFIRMED: [
    { to: 'PROCESSING', actors: ['ADMIN'], permission: 'order.fulfil' },
    { to: 'CANCELLED', actors: ['ADMIN'], permission: 'order.cancel', requiresReason: true },
  ],

  PROCESSING: [
    { to: 'SHIPPED', actors: ['ADMIN'], permission: 'order.fulfil' },
    { to: 'CANCELLED', actors: ['ADMIN'], permission: 'order.cancel', requiresReason: true },
  ],

  SHIPPED: [
    { to: 'DELIVERED', actors: ['ADMIN', 'SYSTEM'], permission: 'order.fulfil' },
    { to: 'RETURNED', actors: ['ADMIN'], permission: 'order.return', requiresReason: true },
  ],

  DELIVERED: [{ to: 'RETURNED', actors: ['ADMIN'], permission: 'order.return', requiresReason: true }],

  CANCELLED: [
    // Money captured before cancellation still has to come back.
    { to: 'REFUNDED', actors: ['ADMIN', 'SYSTEM'], permission: 'refund.create' },
  ],

  RETURNED: [{ to: 'REFUNDED', actors: ['ADMIN', 'SYSTEM'], permission: 'refund.create' }],

  REFUNDED: [],
});

/** Statuses from which no further transition exists. */
export const TERMINAL_STATUSES: readonly OrderStatusName[] = Object.freeze(['REFUNDED']);

/** Statuses where the customer has committed and stock must be held. */
export const STOCK_COMMITTED_STATUSES: readonly OrderStatusName[] = Object.freeze([
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
]);

/** Statuses that release previously committed stock back to available. */
export const STOCK_RELEASING_STATUSES: readonly OrderStatusName[] = Object.freeze([
  'CANCELLED',
  'RETURNED',
]);

export interface TransitionRequest {
  from: OrderStatusName;
  to: OrderStatusName;
  actor: TransitionActor;
  /** Permission keys the actor holds. Ignored for SYSTEM and CUSTOMER actors. */
  permissions?: readonly string[];
  reason?: string;
}

export interface AllowedTransition {
  to: OrderStatusName;
  requiresReason: boolean;
  permission: string | null;
}

/**
 * What this actor may do with an order in this status.
 *
 * The Admin Panel renders exactly these as buttons, which is why the shape is
 * returned rather than a bare list: the UI needs to know upfront whether a
 * reason prompt is required.
 */
export function allowedTransitions(
  from: OrderStatusName,
  actor: TransitionActor,
  permissions: readonly string[] = [],
): AllowedTransition[] {
  const rules = TRANSITIONS[from] ?? [];

  return rules
    .filter((rule) => {
      if (!rule.actors.includes(actor)) return false;
      if (actor === 'ADMIN' && rule.permission !== undefined) {
        return permissions.includes(rule.permission);
      }
      return true;
    })
    .map((rule) => ({
      to: rule.to,
      requiresReason: rule.requiresReason === true,
      permission: rule.permission ?? null,
    }));
}

export function canTransition(request: TransitionRequest): boolean {
  return allowedTransitions(request.from, request.actor, request.permissions ?? []).some(
    (allowed) => allowed.to === request.to,
  );
}

/**
 * Throws unless the transition is legal for this actor. Call inside the same
 * transaction that performs the update.
 */
export function assertTransition(request: TransitionRequest): void {
  const { from, to, actor, reason } = request;

  if (from === to) {
    throw conflict(
      ErrorCode.ORDER_TRANSITION_NOT_ALLOWED,
      `Order is already ${to}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  const rules = TRANSITIONS[from] ?? [];
  const rule = rules.find((candidate) => candidate.to === to);

  if (!rule) {
    throw conflict(
      ErrorCode.ORDER_TRANSITION_NOT_ALLOWED,
      `An order cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.ORDER_TRANSITION_NOT_ALLOWED,
      // "An admin" / "a customer" - the article has to match the word.
      `${actor === 'ADMIN' ? 'An admin' : actor === 'SYSTEM' ? 'The system' : 'A customer'} cannot move an order from ${from} to ${to}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  if (actor === 'ADMIN' && rule.permission !== undefined) {
    const held = request.permissions ?? [];
    if (!held.includes(rule.permission)) {
      throw conflict(
        ErrorCode.PERMISSION_DENIED,
        `This action requires the ${rule.permission} permission.`,
        [{ code: 'PERMISSION_REQUIRED', meta: { permission: rule.permission } }],
      );
    }
  }

  if (rule.requiresReason === true && (reason === undefined || reason.trim().length === 0)) {
    throw conflict(
      ErrorCode.ORDER_TRANSITION_NOT_ALLOWED,
      `Moving an order to ${to} requires a reason.`,
      [{ field: 'reason', code: 'REASON_REQUIRED', meta: { from, to } }],
    );
  }
}

export function isTerminal(status: OrderStatusName): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function holdsCommittedStock(status: OrderStatusName): boolean {
  return STOCK_COMMITTED_STATUSES.includes(status);
}
