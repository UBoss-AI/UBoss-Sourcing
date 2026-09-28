/**
 * The buyer-company verification state machine.
 *
 * Same rule as `order-state-machine.ts`, `schedule-state.ts` and
 * `seller-state.ts`: no service writes `BuyerCompany.status` directly. Every
 * change goes through `assertBuyerCompanyTransition`, inside the same
 * transaction as the update, and the admin console renders its buttons from
 * `allowedBuyerCompanyTransitions` - one table, so a button that appears is a
 * button that works.
 *
 * What is at stake: APPROVED is the one status in which a member may spend
 * money in the company's name. "How did this company become approved?" must
 * always have an answer, and the answer must never be "it approved itself".
 */
import { ErrorCode, conflict } from './errors.js';

/**
 * The three parties.
 *
 * APPLICANT is a member of the company acting on its own application (the
 * route layer checks they hold MANAGE_APPLICATION in it). REVIEWER is this
 * marketplace's staff. SYSTEM is the automated-check runner.
 *
 * An applicant is never a reviewer. That is enforced by the `actors` list on
 * each rule below, not by remembering to check - there is no rule that lets
 * an APPLICANT reach APPROVED from anywhere.
 */
export type BuyerCompanyActor = 'APPLICANT' | 'REVIEWER' | 'SYSTEM';

export const BuyerCompanyStatusValues = [
  'DRAFT',
  'EMAIL_VERIFICATION_PENDING',
  'SUBMITTED',
  'AUTOMATED_CHECK_IN_PROGRESS',
  'UNDER_REVIEW',
  'MORE_INFORMATION_REQUIRED',
  'RESUBMITTED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'REVERIFICATION_REQUIRED',
] as const;

export type BuyerCompanyStatusName = (typeof BuyerCompanyStatusValues)[number];

interface Rule {
  to: BuyerCompanyStatusName;
  actors: readonly BuyerCompanyActor[];
  /**
   * A reason the APPLICANT will read. Required on every refusal, every
   * request for more, and every stop - "rejected" with no words is a screen
   * nobody can act on.
   */
  requiresReason?: boolean;
}

/**
 * Legal transitions.
 *
 * The absences are the interesting part:
 *
 *   - **Nothing reaches APPROVED except from UNDER_REVIEW, SUSPENDED or
 *     REVERIFICATION_REQUIRED, and only by a REVIEWER.** A submission is
 *     opened for review before it can be approved, so the case has an
 *     assignee and a timeline entry saying somebody looked. SYSTEM never
 *     approves: an automated registry match informs a person, it does not
 *     replace one.
 *
 *   - **Registry trouble never reaches REJECTED.** AUTOMATED_CHECK_IN_PROGRESS
 *     can only go on to UNDER_REVIEW. A registry that is down, slow or
 *     inconclusive puts the application in front of a person; it does not
 *     turn a company away.
 *
 *   - **APPROVED -> REJECTED is not a transition.** An approved company has
 *     orders and invoices; it is stopped with SUSPENDED. Rejecting it would
 *     be a decision about an application reused for something that has to
 *     treat live orders.
 *
 *   - **REJECTED -> DRAFT is the applicant's**, and the service also checks
 *     `resubmissionAllowed` - a reviewer can close the door.
 */
const TRANSITIONS: Readonly<Record<BuyerCompanyStatusName, readonly Rule[]>> = Object.freeze({
  DRAFT: [
    // The business email is not the account's verified email, so a code has
    // gone to it. Submission completes when the code is entered.
    { to: 'EMAIL_VERIFICATION_PENDING', actors: ['APPLICANT'] },
    // The business email is already proven (it is the verified sign-in
    // address, or its code was entered earlier).
    { to: 'SUBMITTED', actors: ['APPLICANT'] },
  ],

  EMAIL_VERIFICATION_PENDING: [
    { to: 'SUBMITTED', actors: ['APPLICANT'] },
    // Went back to change something - often the email address itself.
    { to: 'DRAFT', actors: ['APPLICANT'] },
  ],

  SUBMITTED: [
    { to: 'AUTOMATED_CHECK_IN_PROGRESS', actors: ['SYSTEM'] },
    { to: 'UNDER_REVIEW', actors: ['REVIEWER', 'SYSTEM'] },
    { to: 'MORE_INFORMATION_REQUIRED', actors: ['REVIEWER'], requiresReason: true },
    { to: 'REJECTED', actors: ['REVIEWER'], requiresReason: true },
  ],

  AUTOMATED_CHECK_IN_PROGRESS: [{ to: 'UNDER_REVIEW', actors: ['SYSTEM', 'REVIEWER'] }],

  UNDER_REVIEW: [
    { to: 'MORE_INFORMATION_REQUIRED', actors: ['REVIEWER'], requiresReason: true },
    { to: 'APPROVED', actors: ['REVIEWER'] },
    { to: 'REJECTED', actors: ['REVIEWER'], requiresReason: true },
  ],

  MORE_INFORMATION_REQUIRED: [
    { to: 'RESUBMITTED', actors: ['APPLICANT'] },
    // Nobody answered.
    { to: 'REJECTED', actors: ['REVIEWER'], requiresReason: true },
  ],

  RESUBMITTED: [
    { to: 'AUTOMATED_CHECK_IN_PROGRESS', actors: ['SYSTEM'] },
    { to: 'UNDER_REVIEW', actors: ['REVIEWER', 'SYSTEM'] },
    { to: 'MORE_INFORMATION_REQUIRED', actors: ['REVIEWER'], requiresReason: true },
    { to: 'REJECTED', actors: ['REVIEWER'], requiresReason: true },
  ],

  APPROVED: [
    { to: 'SUSPENDED', actors: ['REVIEWER', 'SYSTEM'], requiresReason: true },
    { to: 'REVERIFICATION_REQUIRED', actors: ['REVIEWER', 'SYSTEM'], requiresReason: true },
  ],

  REJECTED: [
    // Correct it and start again, where the reviewer left that open.
    { to: 'DRAFT', actors: ['APPLICANT'] },
  ],

  SUSPENDED: [
    // Restored. A reason is required: lifting a suspension is a decision
    // somebody will ask about.
    { to: 'APPROVED', actors: ['REVIEWER'], requiresReason: true },
    { to: 'REVERIFICATION_REQUIRED', actors: ['REVIEWER'], requiresReason: true },
    { to: 'REJECTED', actors: ['REVIEWER'], requiresReason: true },
  ],

  REVERIFICATION_REQUIRED: [
    { to: 'RESUBMITTED', actors: ['APPLICANT'] },
    // Restored after the re-check passed (or was satisfied another way).
    { to: 'APPROVED', actors: ['REVIEWER'], requiresReason: true },
    { to: 'SUSPENDED', actors: ['REVIEWER', 'SYSTEM'], requiresReason: true },
  ],
});

/** The one status in which a member may buy in the company's name. */
export const BUYER_COMPANY_PURCHASING_STATUSES: readonly BuyerCompanyStatusName[] = Object.freeze([
  'APPROVED',
]);

/**
 * Statuses in which the applicant may change the application's data.
 *
 * REVERIFICATION_REQUIRED is here because correcting what changed is the
 * whole point of it; MORE_INFORMATION_REQUIRED because the reviewer may have
 * asked for a correction rather than a document.
 */
export const BUYER_COMPANY_EDITABLE_STATUSES: readonly BuyerCompanyStatusName[] = Object.freeze([
  'DRAFT',
  'EMAIL_VERIFICATION_PENDING',
  'MORE_INFORMATION_REQUIRED',
  'REVERIFICATION_REQUIRED',
]);

/** Statuses in which a reviewer is working the case and the applicant waits. */
export const BUYER_COMPANY_IN_REVIEW_STATUSES: readonly BuyerCompanyStatusName[] = Object.freeze([
  'SUBMITTED',
  'AUTOMATED_CHECK_IN_PROGRESS',
  'UNDER_REVIEW',
  'RESUBMITTED',
]);

export function isPurchasingStatus(status: BuyerCompanyStatusName): boolean {
  return BUYER_COMPANY_PURCHASING_STATUSES.includes(status);
}

export function isEditableStatus(status: BuyerCompanyStatusName): boolean {
  return BUYER_COMPANY_EDITABLE_STATUSES.includes(status);
}

export interface AllowedBuyerCompanyTransition {
  to: BuyerCompanyStatusName;
  requiresReason: boolean;
}

/** What this actor may do with a company in this status. */
export function allowedBuyerCompanyTransitions(
  from: BuyerCompanyStatusName,
  actor: BuyerCompanyActor,
): AllowedBuyerCompanyTransition[] {
  return (TRANSITIONS[from] ?? [])
    .filter((rule) => rule.actors.includes(actor))
    .map((rule) => ({ to: rule.to, requiresReason: rule.requiresReason === true }));
}

export interface BuyerCompanyTransitionRequest {
  from: BuyerCompanyStatusName;
  to: BuyerCompanyStatusName;
  actor: BuyerCompanyActor;
  reason?: string | null;
}

/**
 * Throws unless the transition is legal for this actor. Call inside the same
 * transaction that performs the update.
 */
export function assertBuyerCompanyTransition(request: BuyerCompanyTransitionRequest): void {
  const { from, to, actor } = request;
  const reason = request.reason?.trim() ?? '';

  if (from === to) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_TRANSITION_NOT_ALLOWED,
      `This company is already ${to.toLowerCase().replace(/_/g, ' ')}.`,
      [{ code: 'SAME_STATUS', meta: { from, to } }],
    );
  }

  const rule = (TRANSITIONS[from] ?? []).find((candidate) => candidate.to === to);

  if (rule === undefined) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_TRANSITION_NOT_ALLOWED,
      `A company cannot move from ${from} to ${to}.`,
      [{ code: 'TRANSITION_UNDEFINED', meta: { from, to } }],
    );
  }

  if (!rule.actors.includes(actor)) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_TRANSITION_NOT_ALLOWED,
      `That change can only be made by ${rule.actors.join(' or ').toLowerCase()}.`,
      [{ code: 'ACTOR_NOT_PERMITTED', meta: { from, to, actor } }],
    );
  }

  if (rule.requiresReason === true && reason.length === 0) {
    throw conflict(
      ErrorCode.BUYER_COMPANY_TRANSITION_NOT_ALLOWED,
      'Give a reason the applicant can read.',
      [{ code: 'REASON_REQUIRED', field: 'reason', meta: { from, to } }],
    );
  }
}

// ---------------------------------------------------------------------------
// Authority inside a company
// ---------------------------------------------------------------------------

export const BuyerCompanyRoleValues = [
  'OWNER',
  'COMPANY_ADMIN',
  'BUYER',
  'ORDER_APPROVER',
  'FINANCE',
  'VIEWER',
] as const;

export type BuyerCompanyRoleName = (typeof BuyerCompanyRoleValues)[number];

/**
 * What a member may do in the company, independent of its status.
 *
 * Company-level only. None of these is a platform permission - every member
 * is a platform Buyer (`users.type = CUSTOMER`) with no admin key at all, and
 * a platform permission is never derived from a company role.
 */
export type BuyerCompanyCapability =
  /** Edit the application, upload documents, answer a reviewer. */
  | 'MANAGE_APPLICATION'
  /** Put things in the company's cart and check out. */
  | 'PURCHASE'
  /** Approve another member's order. */
  | 'APPROVE_ORDERS'
  /** Invoices, payment methods, payment-terms requests. */
  | 'FINANCE'
  /** Invite and remove members. */
  | 'MANAGE_MEMBERS'
  /** See the company's orders, application and status. */
  | 'VIEW';

const CAPABILITIES: Readonly<Record<BuyerCompanyRoleName, readonly BuyerCompanyCapability[]>> =
  Object.freeze({
    OWNER: [
      'MANAGE_APPLICATION',
      'PURCHASE',
      'APPROVE_ORDERS',
      'FINANCE',
      'MANAGE_MEMBERS',
      'VIEW',
    ],
    COMPANY_ADMIN: [
      'MANAGE_APPLICATION',
      'PURCHASE',
      'APPROVE_ORDERS',
      'FINANCE',
      'MANAGE_MEMBERS',
      'VIEW',
    ],
    BUYER: ['PURCHASE', 'VIEW'],
    ORDER_APPROVER: ['APPROVE_ORDERS', 'VIEW'],
    FINANCE: ['FINANCE', 'VIEW'],
    VIEWER: ['VIEW'],
  });

export function roleHasCapability(
  role: BuyerCompanyRoleName,
  capability: BuyerCompanyCapability,
): boolean {
  return CAPABILITIES[role].includes(capability);
}

/**
 * Capabilities that represent the business as verified, and so wait for
 * APPROVED whatever the member's role. Everything else - browsing, the
 * application itself, answering a reviewer - is open before approval.
 */
const REQUIRES_APPROVAL: readonly BuyerCompanyCapability[] = Object.freeze([
  'PURCHASE',
  'APPROVE_ORDERS',
  'FINANCE',
  'MANAGE_MEMBERS',
]);

export function capabilityRequiresApproval(capability: BuyerCompanyCapability): boolean {
  return REQUIRES_APPROVAL.includes(capability);
}

/**
 * The single answer to "may this member do this, in this company, now?".
 *
 * Returns the reason it may not, rather than a boolean, so the caller can
 * say which: a VIEWER is told it is their role, a BUYER in a pending company
 * is told it is the verification.
 */
export function companyCapabilityBlock(
  role: BuyerCompanyRoleName,
  status: BuyerCompanyStatusName,
  capability: BuyerCompanyCapability,
): 'ROLE' | 'NOT_APPROVED' | null {
  if (!roleHasCapability(role, capability)) return 'ROLE';
  if (capabilityRequiresApproval(capability) && !isPurchasingStatus(status)) return 'NOT_APPROVED';
  return null;
}
