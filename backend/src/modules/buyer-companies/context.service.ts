/**
 * The buyer context: which buyer a storefront session is acting as.
 *
 * Every signed-in buyer can act as themselves (INDIVIDUAL). A buyer who
 * belongs to one or more companies can also act for one of them (COMPANY).
 * The choice lives on the server-side session row and nowhere else - never in
 * a cookie, a header or a request body - and this file is the only writer of
 * it.
 *
 * Three rules, each of which a test holds in place:
 *
 *   1. **The sign-in tab chooses nothing.** It says which context the person
 *      intends. `contextAfterSignIn` only ever selects a company the user has
 *      an ACTIVE membership in.
 *   2. **A company id from the client is a request, not a fact.**
 *      `switchBuyerContext` loads the membership for (company, user) and
 *      refuses one that is missing, removed or suspended with the same
 *      answer, so a guessed id learns nothing.
 *   3. **Every request re-checks.** `resolveBuyerContext` runs inside the
 *      customer guard. A member removed at 10:00 cannot act for the company
 *      at 10:01 on a session opened at 09:00.
 */
import { env } from '../../config/env.js';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import type {
  BuyerCompanyRoleName,
  BuyerCompanyStatusName,
} from '../../domain/buyer-company-state.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export type BuyerContext =
  | { kind: 'INDIVIDUAL' }
  | {
      kind: 'COMPANY';
      companyId: string;
      companyName: string;
      companyStatus: BuyerCompanyStatusName;
      role: BuyerCompanyRoleName;
      applicationReference: string;
    };

export const INDIVIDUAL_CONTEXT: BuyerContext = Object.freeze({ kind: 'INDIVIDUAL' });

export interface CompanyContextOption {
  companyId: string;
  companyName: string;
  companyStatus: BuyerCompanyStatusName;
  role: BuyerCompanyRoleName;
  applicationReference: string;
}

/**
 * The name a company is shown under before it has one.
 *
 * A draft saved after step one has no legal name yet. Showing its reference
 * rather than an empty string keeps the selector and the banner readable.
 */
function displayName(company: {
  tradingName: string | null;
  legalName: string | null;
  applicationReference: string;
}): string {
  return company.tradingName ?? company.legalName ?? company.applicationReference;
}

const MEMBERSHIP_SELECT = {
  role: true,
  company: {
    select: {
      id: true,
      status: true,
      legalName: true,
      tradingName: true,
      applicationReference: true,
    },
  },
} as const;

/** Every company this person may act for, oldest membership first. */
export async function listCompanyContexts(userId: string): Promise<CompanyContextOption[]> {
  if (!env.FEATURE_BUYER_COMPANIES) return [];

  const memberships = await prisma.buyerCompanyMember.findMany({
    where: { userId, status: 'ACTIVE', company: { archivedAt: null } },
    select: MEMBERSHIP_SELECT,
    orderBy: { createdAt: 'asc' },
  });

  return memberships.map((membership) => ({
    companyId: membership.company.id,
    companyName: displayName(membership.company),
    companyStatus: membership.company.status,
    role: membership.role,
    applicationReference: membership.company.applicationReference,
  }));
}

/**
 * Turn what the session row says into a context the request may act in.
 *
 * Returns null when the session names a company the user no longer belongs
 * to; the guard then resets the session and refuses the request with
 * BUYER_CONTEXT_INVALID. Null is deliberately not the same as INDIVIDUAL - a
 * request made while the person *thought* they were buying for the company
 * must not quietly land in their own basket.
 */
export async function resolveBuyerContext(
  userId: string,
  session: { buyerContextKind: 'INDIVIDUAL' | 'COMPANY' | null; buyerCompanyId: string | null },
): Promise<BuyerContext | null> {
  if (session.buyerContextKind !== 'COMPANY') return INDIVIDUAL_CONTEXT;
  if (session.buyerCompanyId === null || !env.FEATURE_BUYER_COMPANIES) return null;

  const membership = await prisma.buyerCompanyMember.findFirst({
    where: {
      companyId: session.buyerCompanyId,
      userId,
      status: 'ACTIVE',
      company: { archivedAt: null },
    },
    select: MEMBERSHIP_SELECT,
  });

  if (membership === null) return null;

  return {
    kind: 'COMPANY',
    companyId: membership.company.id,
    companyName: displayName(membership.company),
    companyStatus: membership.company.status,
    role: membership.role,
    applicationReference: membership.company.applicationReference,
  };
}

/** Put a session back in the individual context. Used when its company went away. */
export async function resetSessionToIndividual(sessionId: string): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId },
    data: { buyerContextKind: 'INDIVIDUAL', buyerCompanyId: null },
  });
}

export interface SwitchContextInput {
  userId: string;
  sessionId: string;
  target: { kind: 'INDIVIDUAL' } | { kind: 'COMPANY'; companyId: string };
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * Move this session to another buyer context.
 *
 * No second sign-in: the person has already proven who they are, and which
 * of their own authorities they are using is not a new credential. The switch
 * is audited, because "who placed this order for the company" is answered by
 * which context the session was in.
 */
export async function switchBuyerContext(input: SwitchContextInput): Promise<BuyerContext> {
  let context: BuyerContext = INDIVIDUAL_CONTEXT;

  if (input.target.kind === 'COMPANY') {
    const resolved = await resolveBuyerContext(input.userId, {
      buyerContextKind: 'COMPANY',
      buyerCompanyId: input.target.companyId,
    });

    // One answer for "not a member", "removed", "suspended" and "no such
    // company", so the id is not an oracle.
    if (resolved === null) {
      throw forbidden(
        ErrorCode.BUYER_CONTEXT_INVALID,
        'You cannot buy for that company from this account.',
      );
    }

    context = resolved;
  }

  await prisma.session.update({
    where: { id: input.sessionId },
    data:
      context.kind === 'COMPANY'
        ? { buyerContextKind: 'COMPANY', buyerCompanyId: context.companyId }
        : { buyerContextKind: 'INDIVIDUAL', buyerCompanyId: null },
  });

  await recordAudit({
    action: AuditAction.BUYER_CONTEXT_SWITCHED,
    resourceType: 'session',
    resourceId: input.sessionId,
    actorType: 'CUSTOMER',
    actorUserId: input.userId,
    after:
      context.kind === 'COMPANY'
        ? { kind: 'COMPANY', companyId: context.companyId }
        : { kind: 'INDIVIDUAL' },
    ipAddress: input.ipAddress ?? null,
    correlationId: input.correlationId ?? null,
  });

  return context;
}

export type SignInIntent = 'individual' | 'company';

export interface SignInContextOutcome {
  context: BuyerContext;
  /** Every company the person may choose from. */
  companies: CompanyContextOption[];
  /**
   * What the storefront should do next:
   *   - READY: go to /home in `context`.
   *   - CHOOSE_COMPANY: the person belongs to several; show the selector.
   *   - NO_COMPANY: they asked for Company but belong to none; offer to
   *     register one. Only ever said to somebody who has just proven the
   *     password, so it discloses nothing to a stranger.
   */
  next: 'READY' | 'CHOOSE_COMPANY' | 'NO_COMPANY';
}

/**
 * Decide the context a brand-new session starts in, from the tab the person
 * signed in on. Runs AFTER the password has been accepted.
 */
export async function contextAfterSignIn(
  userId: string,
  sessionId: string,
  intent: SignInIntent,
): Promise<SignInContextOutcome> {
  const companies = await listCompanyContexts(userId);

  if (intent === 'individual') {
    return { context: INDIVIDUAL_CONTEXT, companies, next: 'READY' };
  }

  if (companies.length === 0) {
    return { context: INDIVIDUAL_CONTEXT, companies, next: 'NO_COMPANY' };
  }

  if (companies.length > 1) {
    // Stays INDIVIDUAL until the person picks one. Guessing would be how an
    // order lands on the wrong company's account.
    return { context: INDIVIDUAL_CONTEXT, companies, next: 'CHOOSE_COMPANY' };
  }

  const only = companies[0];
  if (only === undefined) return { context: INDIVIDUAL_CONTEXT, companies, next: 'NO_COMPANY' };

  await prisma.session.update({
    where: { id: sessionId },
    data: { buyerContextKind: 'COMPANY', buyerCompanyId: only.companyId },
  });

  return {
    context: {
      kind: 'COMPANY',
      companyId: only.companyId,
      companyName: only.companyName,
      companyStatus: only.companyStatus,
      role: only.role,
      applicationReference: only.applicationReference,
    },
    companies,
    next: 'READY',
  };
}

/** The wire shape of a context, for /auth/me and the sign-in response. */
export function toContextView(context: BuyerContext): Record<string, unknown> {
  return context.kind === 'COMPANY'
    ? {
        kind: 'COMPANY',
        companyId: context.companyId,
        companyName: context.companyName,
        companyStatus: context.companyStatus,
        role: context.role,
        applicationReference: context.applicationReference,
      }
    : { kind: 'INDIVIDUAL' };
}
