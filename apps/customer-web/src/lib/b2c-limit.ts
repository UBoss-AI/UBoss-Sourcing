/**
 * The B2C maximum order quantity, as the storefront needs it.
 *
 * The server decides. Every basket change, checkout, plan and preorder is
 * judged there against the buyer context the SESSION holds, never against
 * anything this file works out - so a browser that got any of this wrong
 * could not buy more than it may. What this file is for is saying so before
 * the buyer presses the button, and offering the right next step when they
 * are told no: sign in, switch to their approved company, open the company's
 * verification status, or register one.
 *
 * "Company" here means the buyer companies on the session. Only an APPROVED
 * company's context is exempt; one still being checked, sent back, rejected
 * or suspended is held to the limit exactly as the person is.
 */
import { ApiError } from './api';
import type { BuyerContext, CompanyContextOption } from '@/auth/session-context';

export const B2C_LIMIT_CODE = 'B2C_MAX_ORDER_QUANTITY_EXCEEDED';

/** Whether this viewer is held to the limit. Guests are, until they sign in as an approved company. */
export function isB2cLimitApplicable(input: { isCustomer: boolean; buyerContext: BuyerContext }): boolean {
  if (!input.isCustomer) return true;
  return !(input.buyerContext.kind === 'COMPANY' && input.buyerContext.companyStatus === 'APPROVED');
}

/**
 * Who is being told no, which decides what they are offered.
 *
 * - GUEST: sign in as a company, or register one.
 * - HAS_APPROVED: an individual who already belongs to an approved company -
 *   offer to switch to it (or to choose, when there are several).
 * - HAS_PENDING: their only companies are still being checked (or were sent
 *   back, rejected, suspended) - offer the verification status, not a switch
 *   that would not help.
 * - NO_COMPANY: offer to register one.
 * - COMPANY_NOT_APPROVED: buying for a company that is not approved - say so
 *   and link to its status.
 */
export type B2cAudience =
  | { kind: 'GUEST' }
  | { kind: 'HAS_APPROVED'; companies: CompanyContextOption[] }
  | { kind: 'HAS_PENDING'; company: CompanyContextOption }
  | { kind: 'NO_COMPANY' }
  | { kind: 'COMPANY_NOT_APPROVED'; company: CompanyContextOption };

export function b2cAudience(input: {
  isCustomer: boolean;
  buyerContext: BuyerContext;
  companies: readonly CompanyContextOption[];
}): B2cAudience {
  if (!input.isCustomer) return { kind: 'GUEST' };
  if (input.buyerContext.kind === 'COMPANY') {
    // An approved company context is never told no; the caller does not ask.
    const { companyId, companyName, companyStatus, role, applicationReference } = input.buyerContext;
    return {
      kind: 'COMPANY_NOT_APPROVED',
      company: { companyId, companyName, companyStatus, role, applicationReference },
    };
  }
  const approved = input.companies.filter((company) => company.companyStatus === 'APPROVED');
  if (approved.length > 0) return { kind: 'HAS_APPROVED', companies: approved };
  const [pending] = input.companies;
  if (pending !== undefined) return { kind: 'HAS_PENDING', company: pending };
  return { kind: 'NO_COMPANY' };
}

/** The figures of a refusal from the server, or null when it was something else. */
export interface B2cRefusal {
  productId: string | null;
  allowedQuantity: number;
  requestedQuantity: number | null;
  currentCartQuantity: number | null;
}

export function b2cRefusalOf(error: unknown): B2cRefusal | null {
  if (!(error instanceof ApiError)) return null;
  const detail =
    error.code === B2C_LIMIT_CODE
      ? error.details[0]
      : // A checkout refused over basket lines carries the B2C line among them.
        error.details.find((entry) => entry.code === B2C_LIMIT_CODE);
  if (detail === undefined) return null;
  const meta = detail.meta ?? {};
  const allowed = meta['allowedQuantity'];
  if (typeof allowed !== 'number') return null;
  const number = (key: string): number | null => {
    const value = meta[key];
    return typeof value === 'number' ? value : null;
  };
  const productId = meta['productId'];
  return {
    productId: typeof productId === 'string' ? productId : null,
    allowedQuantity: allowed,
    requestedQuantity: number('requestedQuantity'),
    currentCartQuantity: number('currentCartQuantity'),
  };
}

/**
 * The largest amount that can still be added on top of what the basket
 * already holds, never below zero. "Reduce to" offers this, so pressing it
 * adds exactly what fits rather than failing again.
 */
export function remainingUnderLimit(limit: number, alreadyInBasket: number): number {
  return Math.max(0, limit - alreadyInBasket);
}

/**
 * The largest quantity at or below `atMost` that the product's own rules
 * accept - its minimum, its step and its per-line maximum - or null when
 * even the minimum is more than that.
 *
 * What "Reduce to" offers. Rounding UP, as the quantity box does on blur,
 * would offer a figure that is over the limit again.
 */
export function largestValidAtMost(
  atMost: number,
  rules: { minOrderQty: number; maxOrderQty: number | null; qtyIncrement: number },
): number | null {
  const min = Math.max(1, rules.minOrderQty);
  const step = Math.max(1, rules.qtyIncrement);
  const cap = rules.maxOrderQty === null ? atMost : Math.min(atMost, rules.maxOrderQty);
  if (cap < min) return null;
  return min + Math.floor((cap - min) / step) * step;
}

// ---------------------------------------------------------------------------
// Seller Hub: the figure a seller types
// ---------------------------------------------------------------------------

/**
 * The largest limit a seller may type. The same figure the server refuses
 * above (`B2C_MAX_ORDER_QUANTITY_CEILING`), so the form and the server agree.
 */
export const B2C_LIMIT_CEILING = 1_000_000;

export type B2cLimitInputProblem = 'REQUIRED' | 'NOT_A_WHOLE_NUMBER' | 'NOT_POSITIVE' | 'TOO_LARGE' | 'BELOW_MINIMUM';

/**
 * Read the box exactly as typed. Refused, never "corrected": "1e2", "2.5",
 * "100abc" and "-3" are each a problem to show the seller, not a number to
 * quietly store. The server applies the same rules.
 */
export function parseB2cLimitInput(
  text: string,
  options: { minimumOrderQuantity?: number } = {},
): { ok: true; value: number } | { ok: false; problem: B2cLimitInputProblem } {
  const typed = text.trim();
  if (typed.length === 0) return { ok: false, problem: 'REQUIRED' };
  if (/^-\d+$/.test(typed)) return { ok: false, problem: 'NOT_POSITIVE' };
  if (!/^\d+$/.test(typed)) return { ok: false, problem: 'NOT_A_WHOLE_NUMBER' };
  const value = Number(typed);
  if (value === 0) return { ok: false, problem: 'NOT_POSITIVE' };
  if (value > B2C_LIMIT_CEILING) return { ok: false, problem: 'TOO_LARGE' };
  if (options.minimumOrderQuantity !== undefined && value < options.minimumOrderQuantity) {
    return { ok: false, problem: 'BELOW_MINIMUM' };
  }
  return { ok: true, value };
}
