/**
 * Sending this tab to Stripe Checkout, and finding the way back.
 *
 * The page the customer pays on is Stripe's. This storefront never mounts a
 * card field, never sees a card number or a CVC, and never runs 3-D Secure -
 * it asks the server for the page, checks the address it was given, and
 * navigates. Same tab, not a popup: a popup opened after an `await` is blocked
 * by every modern browser, and a customer who is told "your payment window is
 * open" when it is not has been told something untrue.
 */

/**
 * Whether an address is a secure Stripe Checkout page for this session.
 *
 * The server already checked it. Checked again here because this is the line
 * that actually navigates, and a navigation to anything but an https page for
 * THIS session would be an open redirect with a payment page's credibility.
 * Not pinned to checkout.stripe.com: an operator may give Checkout their own
 * domain, and the session id in the path is what every hosted page carries.
 */
export function isSafeCheckoutUrl(
  url: string | null | undefined,
  sessionId: string | null | undefined,
): url is string {
  if (typeof url !== 'string' || typeof sessionId !== 'string' || sessionId.length === 0) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.pathname.includes(sessionId);
  } catch {
    return false;
  }
}

/**
 * Leave for Stripe's page.
 *
 * `assign`, not `replace`: the customer's Back button from Stripe should bring
 * them back to the payment page, which then offers the same session again.
 * A separate function so a test can stand in for a real navigation.
 */
export function goToCheckout(url: string): void {
  window.location.assign(url);
}

/** Where Stripe's success URL lands, for an order and a session. */
export function confirmationPath(orderId: string, sessionId: string): string {
  return `/checkout/payment/${orderId}/confirmation?session_id=${encodeURIComponent(sessionId)}`;
}
