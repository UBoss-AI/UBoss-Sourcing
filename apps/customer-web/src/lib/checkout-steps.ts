/**
 * What each page of the purchase flow says about its own progress.
 *
 * Kept beside the flow rather than inside the component that draws it, for the
 * same reason `order-status.ts` sits here: this is a statement about the
 * *domain* — what "done" means at each point in buying something — and four
 * pages have to agree on it. A component file would also make every page that
 * imports a helper from it opt out of fast refresh.
 *
 * The rule these functions exist to enforce: **a step is only complete when it
 * actually is.** Nothing here infers payment from arriving at the payment
 * page, and nothing infers it from the provider's own callback. `isPaid`
 * always comes from the backend.
 */

export type CheckoutStepId = 'cart' | 'address' | 'payment' | 'confirmation';

/**
 * `waiting` is the state that keeps this honest: reached, but not finished.
 * An order placed on a payment link is exactly that, and it is neither a tick
 * nor an empty circle.
 */
export type CheckoutStepState = 'complete' | 'current' | 'waiting' | 'upcoming';

export type CheckoutStepStates = Record<CheckoutStepId, CheckoutStepState>;

/** Optional short caption under a step — "Awaiting payment", say. */
export type CheckoutStepNotes = Partial<Record<CheckoutStepId, string>>;

/** On the cart. Nothing after it has happened yet. */
export const CART_STEPS: CheckoutStepStates = {
  cart: 'current',
  address: 'upcoming',
  payment: 'upcoming',
  confirmation: 'upcoming',
};

/**
 * On checkout.
 *
 * The address step stays *current* while the customer is choosing, and is only
 * marked complete once one is actually selected. Payment is never touched
 * here: this page creates an order, it does not take money.
 */
export function checkoutSteps(hasAddress: boolean): CheckoutStepStates {
  return {
    cart: 'complete',
    address: hasAddress ? 'complete' : 'current',
    payment: 'upcoming',
    confirmation: 'upcoming',
  };
}

/**
 * On the payment page.
 *
 * `isPaid` comes from the backend and from nowhere else — the provider's own
 * success callback fires in the customer's tab and does not move this.
 */
export function paymentSteps(isPaid: boolean): CheckoutStepStates {
  return {
    cart: 'complete',
    address: 'complete',
    payment: isPaid ? 'complete' : 'current',
    confirmation: isPaid ? 'current' : 'upcoming',
  };
}

/**
 * On the confirmation page.
 *
 * The order exists, so Confirmation is current whatever happened. Payment is
 * `complete` only when the order is settled; otherwise it is `waiting`, which
 * is the honest state for a payment-link order that nobody has paid yet.
 */
export function confirmationSteps(isPaid: boolean): CheckoutStepStates {
  return {
    cart: 'complete',
    address: 'complete',
    payment: isPaid ? 'complete' : 'waiting',
    confirmation: 'current',
  };
}
