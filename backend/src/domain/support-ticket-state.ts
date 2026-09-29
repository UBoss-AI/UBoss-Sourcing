/**
 * Where a support request stands, and how it moves.
 *
 * The only place a ticket's `status` is decided. Every service that changes
 * one asks this module first - the same rule the order, schedule and preorder
 * chat state machines follow. A status written from two places is a status
 * that eventually disagrees with itself.
 *
 * Pure: no database, no clock. The service applies what this returns inside
 * its own transaction.
 *
 * TWO KINDS OF MOVE
 *
 *   - **Staff decide** (`assertStaffTransition`): in progress, waiting for the
 *     sender, resolved, closed, and reopening a resolved one.
 *   - **Messages imply** (`onRequesterMessage`): the sender answering a
 *     question moves WAITING_FOR_CUSTOMER back to IN_PROGRESS, and writing on
 *     a RESOLVED request reopens it. Nobody chose those moves, so they are not
 *     transitions anybody may request - they are consequences.
 *
 * CLOSED IS FINAL
 *
 * Nothing leaves CLOSED, and nobody writes on a closed request. A problem that
 * comes back is a new request with its own reference - the closed one stays
 * exactly as it was answered, which is what makes it worth reading later.
 */
import { ErrorCode, conflict } from './errors.js';

export const SupportTicketStatusValues = [
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
  'RESOLVED',
  'CLOSED',
] as const;

export type SupportTicketStatusName = (typeof SupportTicketStatusValues)[number];

export const SupportTicketPriorityValues = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type SupportTicketPriorityName = (typeof SupportTicketPriorityValues)[number];

export const SupportTicketCategoryValues = [
  'ORDERS',
  'PAYMENTS',
  'PREORDERS',
  'PRODUCTS',
  'SELLER_HUB',
  'LOGISTICS',
  'COMPANY_VERIFICATION',
  'ERP_INTEGRATION',
  'ACCOUNT_SECURITY',
  'OTHER',
] as const;

export type SupportTicketCategoryName = (typeof SupportTicketCategoryValues)[number];

/** Statuses somebody is still expected to work. The inbox's default view. */
export const WORKING_STATUSES: readonly SupportTicketStatusName[] = Object.freeze([
  'OPEN',
  'IN_PROGRESS',
  'WAITING_FOR_CUSTOMER',
]);

/**
 * Staff moves, from -> the statuses it may go to.
 *
 * OPEN is never a target: it means "nobody has picked this up", which is a
 * fact about what happened rather than something to set. A resolved request
 * reopens to IN_PROGRESS, because the person reopening it is working it.
 */
const STAFF_TRANSITIONS: Readonly<
  Record<SupportTicketStatusName, readonly SupportTicketStatusName[]>
> = Object.freeze({
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
});

export function canStaffTransition(
  from: SupportTicketStatusName,
  to: SupportTicketStatusName,
): boolean {
  return STAFF_TRANSITIONS[from].includes(to);
}

/** Refuse a staff move the lifecycle does not have. 409, with both ends. */
export function assertStaffTransition(
  from: SupportTicketStatusName,
  to: SupportTicketStatusName,
): void {
  if (from === 'CLOSED') assertWritable(from);

  if (from === to || !canStaffTransition(from, to)) {
    throw conflict(
      ErrorCode.SUPPORT_TICKET_TRANSITION_NOT_ALLOWED,
      `A support request cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION', meta: { from, to } }],
    );
  }
}

/** Nobody - sender or staff - writes on a closed request. */
export function assertWritable(status: SupportTicketStatusName): void {
  if (status === 'CLOSED') {
    throw conflict(
      ErrorCode.SUPPORT_TICKET_CLOSED,
      'This support request is closed. Send a new request if you still need help.',
    );
  }
}

/**
 * What the sender writing again does to the status.
 *
 * Returns the new status, or null when it stays where it is. OPEN and
 * IN_PROGRESS are unchanged - somebody is already on it, or about to be.
 */
export function onRequesterMessage(
  status: SupportTicketStatusName,
): SupportTicketStatusName | null {
  assertWritable(status);
  if (status === 'WAITING_FOR_CUSTOMER') return 'IN_PROGRESS';
  if (status === 'RESOLVED') return 'IN_PROGRESS';
  return null;
}

/**
 * What a staff reply does to the status.
 *
 * Answering an OPEN request means somebody has picked it up, so it becomes
 * IN_PROGRESS. Every other status is left as staff set it - a reply that
 * also asks a question is followed by an explicit move to WAITING, chosen in
 * the same action.
 */
export function onStaffReply(status: SupportTicketStatusName): SupportTicketStatusName | null {
  assertWritable(status);
  return status === 'OPEN' ? 'IN_PROGRESS' : null;
}

/** How a request ended. Staff choose one when they resolve or close it. */
export const SupportResolutionCodeValues = [
  'ANSWERED',
  'FIXED',
  'REFUNDED',
  'REPLACED',
  'REFERRED',
  'DUPLICATE',
  'NO_RESPONSE',
  'NO_ACTION',
] as const;
export type SupportResolutionCodeName = (typeof SupportResolutionCodeValues)[number];

/**
 * Whether moving to `to` needs a resolution code. Resolving or closing a
 * request says how it ended; a request that already carries a code (resolved,
 * then closed) keeps it.
 */
export function requiresResolutionCode(
  to: SupportTicketStatusName,
  current: SupportResolutionCodeName | null,
): boolean {
  return (to === 'RESOLVED' || to === 'CLOSED') && current === null;
}

/** A request moved back into work no longer has an outcome. */
export function clearsResolutionCode(to: SupportTicketStatusName): boolean {
  return to === 'IN_PROGRESS' || to === 'WAITING_FOR_CUSTOMER';
}

/**
 * The timestamps a status carries. RESOLVED stamps `resolvedAt`, CLOSED
 * stamps `closedAt`, and leaving RESOLVED clears `resolvedAt` so a reopened
 * request does not still claim to have been answered.
 */
export function timestampsFor(
  to: SupportTicketStatusName,
  now: Date,
): { resolvedAt?: Date | null; closedAt?: Date } {
  if (to === 'RESOLVED') return { resolvedAt: now };
  if (to === 'CLOSED') return { closedAt: now };
  return { resolvedAt: null };
}
