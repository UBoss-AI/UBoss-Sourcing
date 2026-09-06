/**
 * Loading Stripe.js and describing the slice of it this app uses.
 *
 * The card number, expiry and CVC live inside Stripe's own cross-origin
 * iframes. This origin never sees them, cannot read them, and there is nothing
 * in this file that could — which is precisely what keeps the deployment out
 * of PCI scope.
 *
 * Stripe.js is loaded from Stripe's CDN rather than bundled, because Stripe
 * require the live script for fraud signals and it must be able to update
 * without a redeploy. That mirrors how `razorpay.ts` loads its provider.
 *
 * What Stripe hands back on success is a *claim*, not proof. It is forwarded
 * nowhere: the order is settled by a webhook whose signature the backend
 * verifies over the raw body. This module's only job is to render the payment
 * form and report which way it closed.
 */

const SCRIPT_URL = 'https://js.stripe.com/v3/';
const SCRIPT_ID = 'stripe-js';

/** A mounted Element. Only what this app calls is described. */
export interface StripeElement {
  mount: (target: HTMLElement) => void;
  unmount: () => void;
  destroy: () => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
}

export interface StripeElements {
  create: (type: 'payment', options?: Record<string, unknown>) => StripeElement;
}

/**
 * A Stripe.js error.
 *
 * `type` is the field that matters: `validation_error` and `card_error` are
 * the customer's to fix and the form stays open, anything else has ended the
 * attempt.
 */
export interface StripeJsError {
  type?: string;
  code?: string;
  message?: string;
}

export interface StripeConfirmResult {
  error?: StripeJsError;
  paymentIntent?: { id: string; status: string };
}

export interface StripeJs {
  elements: (options: {
    clientSecret: string;
    appearance?: Record<string, unknown>;
    loader?: 'auto' | 'always' | 'never';
  }) => StripeElements;
  confirmPayment: (options: {
    elements: StripeElements;
    confirmParams?: { return_url?: string; payment_method_data?: Record<string, unknown> };
    redirect?: 'if_required' | 'always';
  }) => Promise<StripeConfirmResult>;
}

type StripeConstructor = (publishableKey: string, options?: Record<string, unknown>) => StripeJs;

declare global {
  interface Window {
    Stripe?: StripeConstructor;
  }
}

let loadPromise: Promise<StripeConstructor> | null = null;

/**
 * Load the provider script once, sharing the promise.
 *
 * A second call while the first is in flight waits on the same load rather
 * than injecting a second `<script>`.
 */
export function loadStripeJs(): Promise<StripeConstructor> {
  if (window.Stripe !== undefined) return Promise.resolve(window.Stripe);

  loadPromise ??= new Promise<StripeConstructor>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);

    const onReady = (): void => {
      if (window.Stripe === undefined) {
        reject(new Error('The payment provider loaded but did not initialise.'));
        return;
      }
      resolve(window.Stripe);
    };

    if (existing !== null) {
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener(
        'error',
        () => {
          reject(new Error('The payment provider could not be reached.'));
        },
        { once: true },
      );
      return;
    }

    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_URL;
    script.async = true;
    script.addEventListener('load', onReady, { once: true });
    script.addEventListener(
      'error',
      () => {
        // Reset, so a later attempt can retry rather than waiting forever on a
        // promise that will never settle.
        loadPromise = null;
        reject(new Error('The payment provider could not be reached. Check your connection.'));
      },
      { once: true },
    );

    document.head.appendChild(script);
  });

  return loadPromise;
}

/**
 * Read one of the theme's colour tokens as a CSS colour.
 *
 * They are stored as bare `r g b` triples so Tailwind can apply its own alpha,
 * which is not a value Stripe's appearance API understands. Falls back rather
 * than throwing: a mis-themed payment form is a blemish, a payment form that
 * failed to render is lost revenue.
 */
function themeColour(name: string, fallback: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return /^\d{1,3} \d{1,3} \d{1,3}$/.test(raw) ? `rgb(${raw})` : fallback;
}

/**
 * Dress Stripe's Elements in this storefront's theme.
 *
 * Read at open time rather than at module load, so it follows whatever theme
 * is active on the page right now.
 */
export function stripeAppearance(): Record<string, unknown> {
  return {
    theme: 'stripe',
    variables: {
      colorPrimary: themeColour('--brand', 'rgb(29 78 216)'),
      colorBackground: themeColour('--surface', 'rgb(255 255 255)'),
      colorText: themeColour('--ink', 'rgb(15 23 42)'),
      colorDanger: themeColour('--danger', 'rgb(185 28 28)'),
      fontFamily: getComputedStyle(document.body).fontFamily,
      borderRadius: '6px',
    },
  };
}

/**
 * How the payment form closed.
 *
 * Re-exported rather than redeclared: the payment page branches on the
 * provider only to decide what to open, and handles the answer in one place.
 * Two structurally identical declarations would let the two drift apart with
 * nothing to catch it.
 */
export type { CheckoutOutcome } from './razorpay';

/**
 * Where Stripe sends the customer back to for a method that leaves the page.
 *
 * iDEAL, Bancontact and a full-page 3-D Secure challenge all navigate away, so
 * `redirect: 'if_required'` cannot avoid a round trip for them. The marker is
 * what lets the payment page know, on the way back, that it should be waiting
 * for a webhook rather than showing the Pay button again.
 *
 * Stripe appends `payment_intent`, `payment_intent_client_secret` and
 * `redirect_status` to this URL. All three are ignored: they arrive through
 * the customer's own browser, which is not a trusted reporter of whether money
 * moved.
 */
export function stripeReturnUrl(): string {
  const url = new URL(window.location.href);
  url.searchParams.set('stripe_return', '1');
  return url.toString();
}
