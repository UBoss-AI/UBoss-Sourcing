/**
 * Purchasing-rule arithmetic, shared by the product page, the cart and the
 * recurring-schedule builder.
 *
 * Kept out of the component file so that one exports only components — a
 * module mixing the two cannot keep its state across a Fast Refresh edit.
 *
 * Everything here is a convenience for the customer. The backend re-checks
 * every rule on add-to-cart and again at checkout, so nothing computed here is
 * trusted by anything that matters.
 */
import { formatNumber } from './format';
import type { PurchaseRules } from './types';

/**
 * The nearest valid quantity at or above `desired`, within the rules.
 *
 * Steps are counted from the minimum, not from zero: a product with a minimum
 * of 10 and a step of 5 allows 10, 15, 20 — not 5, and not 25 only.
 */
export function clampToRules(desired: number, rules: PurchaseRules): number {
  const min = Math.max(1, rules.minOrderQty);
  const step = Math.max(1, rules.qtyIncrement);

  const stepsAbove = Math.max(0, Math.ceil((desired - min) / step));
  let candidate = min + stepsAbove * step;

  if (rules.maxOrderQty !== null && candidate > rules.maxOrderQty) {
    // Step back down to the largest valid quantity that fits under the cap.
    const stepsUnder = Math.floor((rules.maxOrderQty - min) / step);
    candidate = min + Math.max(0, stepsUnder) * step;
  }

  return candidate;
}

/** Human wording for the rules, or null when there is nothing unusual to say. */
export function describeRules(rules: PurchaseRules): string | null {
  const parts: string[] = [];

  if (rules.minOrderQty > 1) parts.push(`minimum ${formatNumber(rules.minOrderQty)}`);
  if (rules.qtyIncrement > 1) parts.push(`in multiples of ${formatNumber(rules.qtyIncrement)}`);
  if (rules.maxOrderQty !== null) parts.push(`maximum ${formatNumber(rules.maxOrderQty)}`);

  if (parts.length === 0) return null;

  return `Ordered ${parts.join(', ')}.`;
}
