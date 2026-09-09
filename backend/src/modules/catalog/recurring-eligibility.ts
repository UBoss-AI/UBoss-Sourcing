/**
 * Whether a product may be put on a repeat purchase.
 *
 * One question, asked in one place, for the same reason `publicProductWhere`
 * exists: this decides what a customer is offered on the product page, what
 * the cart badges, what the schedule builder loads, what `quoteSchedule`
 * prices and what `createSchedule` accepts. Six answers computed separately is
 * six chances for a storefront to offer a schedule the API then refuses -
 * which is the specific bug this replaces.
 *
 * Two inputs:
 *
 *   - `FEATURE_SCHEDULE_ANY_PRODUCT`, the deployment's answer to "do we repeat
 *     everything we sell?". On by default.
 *   - `Product.isRecurringEligible`, the administrator's answer for one
 *     product. Consulted only when the flag above is off.
 *
 * The per-product column is deliberately still read rather than dropped. A
 * store that curates its repeatable range has already filled it in, and the
 * flag is how they keep that curation; deleting the column would throw their
 * answer away to save one boolean.
 */
import { env } from '../../config/env.js';

/** The shape any caller already has to hand. */
export interface RecurringEligibilityFields {
  isRecurringEligible: boolean;
}

/**
 * Whether this product may be scheduled.
 *
 * Says nothing about whether the product is *buyable* - it is not a visibility
 * check, and every caller composes it with `publicProductWhere()` or with a
 * cart line the server already validated.
 */
export function isScheduleEligible(product: RecurringEligibilityFields): boolean {
  if (env.FEATURE_SCHEDULE_ANY_PRODUCT) return true;
  return product.isRecurringEligible;
}

/**
 * The `where` fragment for "only things that can be scheduled".
 *
 * Returns an empty object when every product qualifies, so a caller can spread
 * it into a filter unconditionally. An empty fragment narrows nothing, which
 * is exactly right: with the flag on there is nothing to narrow by.
 */
export function scheduleEligibleWhere(): { isRecurringEligible?: true } {
  return env.FEATURE_SCHEDULE_ANY_PRODUCT ? {} : { isRecurringEligible: true };
}
