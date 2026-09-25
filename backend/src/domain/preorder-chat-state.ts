/**
 * Where a preorder chat stands, and who may move it.
 *
 * The only place a conversation's `status` is decided. Every service that
 * changes one asks this module first, the same rule the order and schedule
 * state machines follow - a status written from two places is a status that
 * eventually disagrees with itself.
 *
 * Pure: no database, no clock. The service applies what this returns inside
 * its own transaction.
 *
 * TWO KINDS OF MOVE
 *
 *   - **Staff decide** (`assertStaffTransition`): open, waiting, resolved,
 *     closed, and the moderation states. A staff move needs a permission, and
 *     the moderation ones need a stronger one.
 *   - **Messages imply** (`onCustomerMessage`, `onStaffMessage`): a customer
 *     answering a question moves WAITING_FOR_CUSTOMER back to OPEN, and writing
 *     into a RESOLVED conversation reopens it. Nobody chose those moves, so
 *     they are not transitions anybody may request - they are consequences.
 *
 * ASSIGNMENT IS NOT A STATUS
 *
 * "Unassigned" is `assignedAdminId IS NULL`. A status that restated a column
 * would one day disagree with it, and the inbox filters on the column.
 */
import { ErrorCode, conflict, forbidden } from './errors.js';

export const PreorderChatStatusValues = [
  'NEW',
  'OPEN',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_INTERNAL',
  'RESOLVED',
  'CLOSED',
  'SPAM',
  'BLOCKED',
] as const;

export type PreorderChatStatusName = (typeof PreorderChatStatusValues)[number];

export const PreorderChatPriorityValues = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;
export type PreorderChatPriorityName = (typeof PreorderChatPriorityValues)[number];

/**
 * Everything except CLOSED keeps the conversation's `activeKey`, so the
 * customer writing about the same product again lands in the SAME thread.
 *
 * RESOLVED is included on purpose - "a resolved conversation is reopened when
 * the customer writes again" only works if the next message finds it. SPAM and
 * BLOCKED are included so that a new thread is not a way round either.
 */
export function holdsActiveKey(status: PreorderChatStatusName): boolean {
  return status !== 'CLOSED';
}

/** Statuses a member of staff is still expected to work. The queue. */
export const WORKING_STATUSES: readonly PreorderChatStatusName[] = Object.freeze([
  'NEW',
  'OPEN',
  'WAITING_FOR_CUSTOMER',
  'WAITING_FOR_INTERNAL',
]);

/** Moving INTO or OUT OF these needs the moderation permission. */
const MODERATION_STATUSES: ReadonlySet<PreorderChatStatusName> = new Set(['SPAM', 'BLOCKED']);

/**
 * Staff moves, from -> the statuses it may go to.
 *
 * NEW is never a target: it means "nobody from the business has answered",
 * which is a fact about the messages rather than something to set.
 * CLOSED -> OPEN is a reopen, and the service checks that no other live
 * conversation has taken the same product meanwhile.
 */
const STAFF_TRANSITIONS: Readonly<Record<PreorderChatStatusName, readonly PreorderChatStatusName[]>> =
  Object.freeze({
    NEW: ['OPEN', 'WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED', 'SPAM', 'BLOCKED'],
    OPEN: ['WAITING_FOR_CUSTOMER', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED', 'SPAM', 'BLOCKED'],
    WAITING_FOR_CUSTOMER: ['OPEN', 'WAITING_FOR_INTERNAL', 'RESOLVED', 'CLOSED', 'SPAM', 'BLOCKED'],
    WAITING_FOR_INTERNAL: ['OPEN', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED', 'SPAM', 'BLOCKED'],
    RESOLVED: ['OPEN', 'CLOSED', 'SPAM', 'BLOCKED'],
    CLOSED: ['OPEN'],
    SPAM: ['OPEN', 'CLOSED', 'BLOCKED'],
    BLOCKED: ['OPEN', 'CLOSED'],
  });

export interface StaffTransitionAuthority {
  /** Holds `preorder_chat.reply`. */
  canReply: boolean;
  /** Holds `preorder_chat.moderate`. */
  canModerate: boolean;
}

/** Whether this move needs the moderation permission rather than reply. */
export function isModerationMove(from: PreorderChatStatusName, to: PreorderChatStatusName): boolean {
  return MODERATION_STATUSES.has(from) || MODERATION_STATUSES.has(to);
}

export function canStaffTransition(from: PreorderChatStatusName, to: PreorderChatStatusName): boolean {
  return STAFF_TRANSITIONS[from].includes(to);
}

/**
 * Refuse a staff move that is not allowed, or not allowed for this person.
 *
 * 409 for a move the lifecycle does not have, 403 for one the caller lacks the
 * permission for. The two answers send the reader to different places - "you
 * cannot do that from here" against "ask somebody who can".
 */
export function assertStaffTransition(
  from: PreorderChatStatusName,
  to: PreorderChatStatusName,
  authority: StaffTransitionAuthority,
): void {
  if (from === to || !canStaffTransition(from, to)) {
    throw conflict(
      ErrorCode.PREORDER_CHAT_TRANSITION_NOT_ALLOWED,
      `A conversation cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION', meta: { from, to } }],
    );
  }

  const needed = isModerationMove(from, to) ? authority.canModerate : authority.canReply;
  if (!needed) {
    throw forbidden(ErrorCode.PERMISSION_DENIED, 'You do not have permission to perform this action.');
  }
}

export type CustomerMessageOutcome =
  | {
      accepted: true;
      next: PreorderChatStatusName;
      /** RESOLVED -> OPEN. Counted, because a resolution that did not hold is worth knowing about. */
      reopened: boolean;
      /**
       * Whether staff should be told. False for SPAM: the message is kept, so
       * the sender sees nothing unusual, and nobody's queue grows.
       */
      notifyStaff: boolean;
    }
  | { accepted: false; code: 'PREORDER_CHAT_CLOSED' | 'PREORDER_CHAT_BLOCKED' };

/** What a customer's message does to the conversation it lands in. */
export function onCustomerMessage(status: PreorderChatStatusName): CustomerMessageOutcome {
  switch (status) {
    case 'NEW':
    case 'OPEN':
    case 'WAITING_FOR_INTERNAL':
      return { accepted: true, next: status, reopened: false, notifyStaff: true };
    case 'WAITING_FOR_CUSTOMER':
      // The question staff were waiting on has been answered.
      return { accepted: true, next: 'OPEN', reopened: false, notifyStaff: true };
    case 'RESOLVED':
      return { accepted: true, next: 'OPEN', reopened: true, notifyStaff: true };
    case 'SPAM':
      return { accepted: true, next: 'SPAM', reopened: false, notifyStaff: false };
    case 'CLOSED':
      return { accepted: false, code: 'PREORDER_CHAT_CLOSED' };
    case 'BLOCKED':
      return { accepted: false, code: 'PREORDER_CHAT_BLOCKED' };
  }
}

export type StaffMessageOutcome =
  | { accepted: true; next: PreorderChatStatusName }
  | { accepted: false; code: 'PREORDER_CHAT_CLOSED' };

/**
 * What a staff reply does.
 *
 * The first answer takes a NEW conversation to OPEN. A reply into a RESOLVED
 * one reopens it for the same reason a customer's does: somebody is talking in
 * it again. A CLOSED conversation is reopened deliberately first - replying
 * into a finished record by accident is the mistake this refuses.
 */
export function onStaffMessage(status: PreorderChatStatusName): StaffMessageOutcome {
  switch (status) {
    case 'NEW':
    case 'RESOLVED':
      return { accepted: true, next: 'OPEN' };
    case 'CLOSED':
      return { accepted: false, code: 'PREORDER_CHAT_CLOSED' };
    default:
      return { accepted: true, next: status };
  }
}

/**
 * What the CUSTOMER is told the status is.
 *
 * Fewer words than staff use, and two statuses deliberately hidden: a customer
 * is never told their enquiry was filed as spam (they see it as open, which is
 * what it looks like from their side), and "waiting for an internal response"
 * is the business's own bookkeeping - to the customer it is simply being
 * handled.
 */
export type CustomerFacingChatStatus = 'OPEN' | 'AWAITING_YOU' | 'RESOLVED' | 'CLOSED' | 'BLOCKED';

export function customerFacingStatus(status: PreorderChatStatusName): CustomerFacingChatStatus {
  switch (status) {
    case 'WAITING_FOR_CUSTOMER':
      return 'AWAITING_YOU';
    case 'RESOLVED':
      return 'RESOLVED';
    case 'CLOSED':
      return 'CLOSED';
    case 'BLOCKED':
      return 'BLOCKED';
    default:
      return 'OPEN';
  }
}

/**
 * The uniqueness key for a live conversation.
 *
 * `variantKey` and `preorderKey` are '' rather than null for the base product
 * and for "no preorder yet", so the key is always four parts and two live
 * conversations about the same thing cannot both exist.
 */
export function activeKeyFor(parts: {
  customerProfileId: string;
  productId: string;
  variantKey: string;
  preorderKey: string;
}): string {
  return `${parts.customerProfileId}:${parts.productId}:${parts.variantKey}:${parts.preorderKey}`;
}
