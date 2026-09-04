/**
 * Purchasing limits.
 *
 * Four independent rules, checked together so the customer sees every problem
 * at once rather than fixing one and hitting the next:
 *
 *   1. Per-product quantity  - min, max and increment (product row)
 *   2. Per-order value       - min and max (customer profile)
 *   3. Monthly spend cap     - sum of this month's committed orders
 *   4. Approval threshold    - routes the order to an approver rather than
 *                              blocking it
 *
 * Every check runs server-side on cart mutation AND again at checkout, because
 * a limit can change between the two.
 */
import { ErrorCode, unprocessable, type ErrorDetail } from '../../domain/errors.js';
import { formatMinorToMajor, type Minor } from '../../domain/money.js';
import { checkOrderValue, checkQuantity, type QuantityRules } from '../../domain/pricing.js';
import { prisma } from '../../infra/prisma.js';

/**
 * Order statuses that count toward the monthly spend cap.
 *
 * A cancelled or failed order must not consume the customer's budget for the
 * month; a shipped one must. PENDING_PAYMENT is deliberately included - an
 * order awaiting payment has committed the customer, and excluding it would let
 * someone place unlimited unpaid orders and blow through the cap on settlement.
 */
const SPEND_COUNTING_STATUSES = [
  'PENDING_APPROVAL',
  'PENDING_PAYMENT',
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
] as const;

/**
 * The limits that apply to one customer in one currency.
 *
 * `requiresOrderApproval` comes from the profile - whether an account needs
 * sign-off is a policy about the account. The amounts come from that currency's
 * `customer_limits` row, because an amount without its currency is meaningless.
 */
export interface CustomerLimits {
  perOrderMinMinor: Minor | null;
  perOrderMaxMinor: Minor | null;
  monthlySpendCapMinor: Minor | null;
  requiresOrderApproval: boolean;
  approvalThresholdMinor: Minor | null;
  /** True when the account has terms in some currency, but not this one. */
  currencyNotAgreed: boolean;
}

export interface LineToCheck {
  productId: string;
  variantId?: string | null;
  productName: string;
  quantity: number;
  rules: QuantityRules;
}

export interface LimitCheckInput {
  customerProfileId: string;
  lines: readonly LineToCheck[];
  grandTotalMinor: Minor;
  currency: string;
  /** Excluded from the month-to-date sum when re-checking an existing order. */
  excludeOrderId?: string;
}

export interface LimitCheckResult {
  ok: boolean;
  violations: ErrorDetail[];
  /** True when the order must go to an approver before payment. */
  requiresApproval: boolean;
  approvalReason: string | null;
  monthToDateMinor: Minor;
}

export async function loadCustomerLimits(
  customerProfileId: string,
  currency: string,
): Promise<CustomerLimits | null> {
  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: {
      requiresOrderApproval: true,
      limits: {
        select: {
          currencyCode: true,
          perOrderMinMinor: true,
          perOrderMaxMinor: true,
          monthlySpendCapMinor: true,
          approvalThresholdMinor: true,
        },
      },
    },
  });

  if (profile === null) return null;

  const forCurrency = profile.limits.find((row) => row.currencyCode === currency);

  if (forCurrency !== undefined) {
    return {
      perOrderMinMinor: forCurrency.perOrderMinMinor,
      perOrderMaxMinor: forCurrency.perOrderMaxMinor,
      monthlySpendCapMinor: forCurrency.monthlySpendCapMinor,
      approvalThresholdMinor: forCurrency.approvalThresholdMinor,
      requiresOrderApproval: profile.requiresOrderApproval,
      currencyNotAgreed: false,
    };
  }

  // No row for this currency. If the account has terms elsewhere, those terms
  // are a credit control and must not evaporate because the shopper switched
  // market - so the order is refused rather than run unlimited. An account with
  // no limits anywhere buys freely in any currency, which is the same freedom
  // it had before.
  return {
    perOrderMinMinor: null,
    perOrderMaxMinor: null,
    monthlySpendCapMinor: null,
    approvalThresholdMinor: null,
    requiresOrderApproval: profile.requiresOrderApproval,
    currencyNotAgreed: profile.limits.length > 0,
  };
}

/**
 * Committed spend so far this calendar month.
 *
 * The window is the business timezone's calendar month, not a rolling 30 days -
 * "monthly cap" means the month a finance team reports on.
 */
export async function monthToDateSpend(
  customerProfileId: string,
  currency: string,
  excludeOrderId?: string,
): Promise<Minor> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));

  const result = await prisma.order.aggregate({
    where: {
      customerProfileId,
      // Scoped to one currency: summing rupee and dollar totals into a single
      // figure and comparing it to a cap would be arithmetic on two different
      // units. Each market's cap counts only that market's orders.
      currency,
      status: { in: [...SPEND_COUNTING_STATUSES] },
      createdAt: { gte: monthStart },
      ...(excludeOrderId !== undefined ? { id: { not: excludeOrderId } } : {}),
    },
    _sum: { grandTotalMinor: true },
  });

  return result._sum.grandTotalMinor ?? 0n;
}

/**
 * Check every purchasing rule at once.
 *
 * Collects violations rather than throwing on the first, so a cart with three
 * problems reports three - fixing them one round-trip at a time is a genuinely
 * bad buying experience for a B2B customer with a 40-line order.
 */
export async function checkPurchasingLimits(input: LimitCheckInput): Promise<LimitCheckResult> {
  const violations: ErrorDetail[] = [];

  // --- 1. Per-product quantity rules ---
  for (const [index, line] of input.lines.entries()) {
    const violation = checkQuantity(line.quantity, line.rules);
    if (violation === null) continue;

    switch (violation.code) {
      case 'QUANTITY_BELOW_MINIMUM':
        violations.push({
          field: `items.${String(index)}.quantity`,
          code: ErrorCode.QUANTITY_BELOW_MINIMUM,
          message: `${line.productName}: the minimum order quantity is ${String(violation.minimum)}.`,
          meta: { productId: line.productId, minimum: violation.minimum, requested: line.quantity },
        });
        break;

      case 'QUANTITY_ABOVE_MAXIMUM':
        violations.push({
          field: `items.${String(index)}.quantity`,
          code: ErrorCode.QUANTITY_ABOVE_MAXIMUM,
          message: `${line.productName}: the maximum order quantity is ${String(violation.maximum)}.`,
          meta: { productId: line.productId, maximum: violation.maximum, requested: line.quantity },
        });
        break;

      case 'QUANTITY_INCREMENT_INVALID':
        violations.push({
          field: `items.${String(index)}.quantity`,
          code: ErrorCode.QUANTITY_INCREMENT_INVALID,
          // The increment counts from the minimum, not from zero, so the
          // message names both - otherwise "multiples of 5" is misleading for
          // a product whose minimum is 10.
          message: `${line.productName}: order in multiples of ${String(violation.increment)} starting from ${String(violation.minimum)}.`,
          meta: {
            productId: line.productId,
            increment: violation.increment,
            minimum: violation.minimum,
            requested: line.quantity,
          },
        });
        break;
    }
  }

  const limits = await loadCustomerLimits(input.customerProfileId, input.currency);

  if (limits === null) {
    return {
      ok: violations.length === 0,
      violations,
      requiresApproval: false,
      approvalReason: null,
      monthToDateMinor: 0n,
    };
  }

  // --- 2. Terms in this currency ---
  //
  // An account with agreed limits somewhere but none here has no terms for
  // this market. Running the order unlimited would drop a credit control
  // because the shopper changed currency; refusing says so plainly, and staff
  // can add terms for the market from the customer's record.
  if (limits.currencyNotAgreed) {
    const agreed = await prisma.customerLimit.findMany({
      where: { customerProfileId: input.customerProfileId },
      select: { currencyCode: true },
      orderBy: { currencyCode: 'asc' },
    });
    const codes = agreed.map((row) => row.currencyCode);

    violations.push({
      field: 'grandTotal',
      code: ErrorCode.CART_CURRENCY_MISMATCH,
      message:
        `Your account has agreed purchasing terms in ${codes.join(', ')}, not ${input.currency}. ` +
        `Switch to ${codes[0] ?? 'a supported currency'} to place this order.`,
      meta: { agreedCurrencies: codes.join(','), cartCurrency: input.currency },
    });

    return {
      ok: false,
      violations,
      requiresApproval: false,
      approvalReason: null,
      monthToDateMinor: 0n,
    };
  }

  // --- 3. Per-order value ---
  const valueViolation = checkOrderValue(input.grandTotalMinor, {
    perOrderMinMinor: limits.perOrderMinMinor,
    perOrderMaxMinor: limits.perOrderMaxMinor,
  });

  if (valueViolation !== null) {
    if (valueViolation.code === 'ORDER_BELOW_MINIMUM_VALUE') {
      violations.push({
        field: 'grandTotal',
        code: ErrorCode.ORDER_BELOW_MINIMUM_VALUE,
        message: `Orders must be at least ${formatMinorToMajor(valueViolation.minimumMinor, input.currency)} ${input.currency}.`,
        meta: { minimumMinor: valueViolation.minimumMinor.toString(), currency: input.currency },
      });
    } else {
      violations.push({
        field: 'grandTotal',
        code: ErrorCode.ORDER_ABOVE_MAXIMUM_VALUE,
        message: `Orders cannot exceed ${formatMinorToMajor(valueViolation.maximumMinor, input.currency)} ${input.currency}.`,
        meta: { maximumMinor: valueViolation.maximumMinor.toString(), currency: input.currency },
      });
    }
  }

  // --- 4. Monthly spend cap ---
  const monthToDateMinor = await monthToDateSpend(
    input.customerProfileId,
    input.currency,
    input.excludeOrderId,
  );

  if (limits.monthlySpendCapMinor !== null) {
    const projected = monthToDateMinor + input.grandTotalMinor;

    if (projected > limits.monthlySpendCapMinor) {
      const remaining = limits.monthlySpendCapMinor - monthToDateMinor;
      violations.push({
        field: 'grandTotal',
        code: ErrorCode.CUSTOMER_SPEND_CAP_EXCEEDED,
        // Naming the remaining budget lets the customer trim the order rather
        // than guess.
        message:
          remaining > 0n
            ? `This order would exceed your monthly limit. ${formatMinorToMajor(remaining, input.currency)} ${input.currency} remains this month.`
            : `Your monthly purchasing limit of ${formatMinorToMajor(limits.monthlySpendCapMinor, input.currency)} ${input.currency} has been reached.`,
        meta: {
          capMinor: limits.monthlySpendCapMinor.toString(),
          monthToDateMinor: monthToDateMinor.toString(),
          remainingMinor: (remaining > 0n ? remaining : 0n).toString(),
          currency: input.currency,
        },
      });
    }
  }

  // --- 5. Approval routing ---
  //
  // Not a violation: the order is allowed, it just goes to an approver first.
  let requiresApproval = false;
  let approvalReason: string | null = null;

  if (limits.requiresOrderApproval) {
    if (limits.approvalThresholdMinor === null) {
      requiresApproval = true;
      approvalReason = 'This account requires approval for every order.';
    } else if (input.grandTotalMinor >= limits.approvalThresholdMinor) {
      requiresApproval = true;
      approvalReason = `Orders of ${formatMinorToMajor(limits.approvalThresholdMinor, input.currency)} ${input.currency} or more require approval.`;
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    requiresApproval,
    approvalReason,
    monthToDateMinor,
  };
}

/**
 * Throw if any limit is violated.
 *
 * Used at checkout, where proceeding is not an option. Cart mutations call
 * `checkPurchasingLimits` directly and surface the violations as warnings, so
 * the customer can keep building the order.
 */
export function assertLimitsSatisfied(result: LimitCheckResult): void {
  if (result.ok) return;

  throw unprocessable(
    // The first violation's code carries the most specific meaning; the full
    // list travels in `details` for field-level display.
    (result.violations[0]?.code as (typeof ErrorCode)[keyof typeof ErrorCode]) ??
      ErrorCode.VALIDATION_FAILED,
    'This order does not meet the purchasing rules for your account.',
    result.violations,
  );
}

export interface SpendSummary {
  monthToDateMinor: string;
  capMinor: string | null;
  remainingMinor: string | null;
  currency: string;
}

/** Spend summary for the customer's account page and the admin detail view. */
export async function getSpendSummary(
  customerProfileId: string,
  currency: string,
): Promise<SpendSummary> {
  // Both sides of the comparison are scoped to the same currency, so the
  // summary means what it says.
  const [limits, monthToDate] = await Promise.all([
    loadCustomerLimits(customerProfileId, currency),
    monthToDateSpend(customerProfileId, currency),
  ]);

  const cap = limits?.monthlySpendCapMinor ?? null;
  const remaining = cap === null ? null : cap - monthToDate;

  return {
    monthToDateMinor: monthToDate.toString(),
    capMinor: cap?.toString() ?? null,
    // Clamped at zero: a negative "remaining" is confusing, and the cap can be
    // lowered after orders were already placed.
    remainingMinor: remaining === null ? null : (remaining > 0n ? remaining : 0n).toString(),
    currency,
  };
}
