/**
 * Loading and opening the Razorpay hosted checkout.
 *
 * The customer's card details are entered inside Razorpay's own iframe and
 * never touch this origin. Nothing in this file reads, stores or logs a card
 * number, a CVV or an OTP — there is nothing here that could.
 *
 * What Razorpay hands back on success is a *claim*, not proof. It is passed to
 * nobody and trusted by nothing: the order is settled by a webhook whose
 * signature the backend verifies over the raw body. This module's only job is
 * to open the sheet and report which way it closed.
 */

const SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
const SCRIPT_ID = 'razorpay-checkout-js';

/** Razorpay's constructor, once its script has run. */
interface RazorpayInstance {
  open: () => void;
  close: () => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
}

type RazorpayConstructor = new (options: Record<string, unknown>) => RazorpayInstance;

declare global {
  interface Window {
    Razorpay?: RazorpayConstructor;
  }
}

let loadPromise: Promise<RazorpayConstructor> | null = null;

/**
 * Load the provider script once, sharing the promise.
 *
 * A second call while the first is in flight waits on the same load rather
 * than injecting a second `<script>`.
 */
export function loadRazorpay(): Promise<RazorpayConstructor> {
  if (window.Razorpay !== undefined) return Promise.resolve(window.Razorpay);

  loadPromise ??= new Promise<RazorpayConstructor>((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID);

    const onReady = (): void => {
      if (window.Razorpay === undefined) {
        reject(new Error('The payment provider loaded but did not initialise.'));
        return;
      }
      resolve(window.Razorpay);
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
 * Pull the provider's own wording out of a failure payload.
 *
 * The shape is the provider's to change, so it is treated as unknown and
 * narrowed step by step. A failure to parse must never throw — this runs
 * inside an event handler, and an exception there would leave the customer
 * looking at a spinner that never resolves.
 */
function readFailureMessage(payload: unknown): string {
  const fallback = 'The payment did not go through. No money has been taken.';

  if (typeof payload !== 'object' || payload === null || !('error' in payload)) return fallback;

  const { error } = payload;

  if (typeof error !== 'object' || error === null || !('description' in error)) return fallback;

  const { description } = error;

  return typeof description === 'string' && description.trim() !== '' ? description : fallback;
}

/** How the provider sheet closed. */
export type CheckoutOutcome =
  /** The customer completed the flow. Says nothing about whether money moved. */
  | { kind: 'submitted' }
  /** They closed the sheet without paying. Their order is untouched. */
  | { kind: 'dismissed' }
  /** The provider reported a failure, with its own wording. */
  | { kind: 'failed'; message: string };

/**
 * Open the hosted checkout and resolve with how it closed.
 *
 * `submitted` explicitly does not mean "paid". The caller's next step is to
 * ask the *backend* what happened, because only a verified webhook settles an
 * order — a browser is not a trusted reporter of whether money moved.
 */
export async function openRazorpayCheckout(
  checkoutPayload: Record<string, string | number>,
): Promise<CheckoutOutcome> {
  const Razorpay = await loadRazorpay();

  return new Promise<CheckoutOutcome>((resolve) => {
    let settled = false;

    const settle = (outcome: CheckoutOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const {
      key,
      order_id: orderId,
      amount,
      currency,
      name,
      description,
      prefill_email: prefillEmail,
      prefill_name: prefillName,
      prefill_contact: prefillContact,
    } = checkoutPayload;

    const instance = new Razorpay({
      key,
      order_id: orderId,
      amount,
      currency,
      name,
      description,
      prefill: {
        email: prefillEmail,
        name: prefillName,
        contact: prefillContact,
      },
      // The provider's own success callback. Its payload — payment id,
      // signature — is deliberately *not* forwarded anywhere: the backend
      // learns the same facts from a webhook it can verify, and accepting them
      // from the browser would make the whole verification pointless.
      handler: () => {
        settle({ kind: 'submitted' });
      },
      modal: {
        ondismiss: () => {
          settle({ kind: 'dismissed' });
        },
      },
      retry: { enabled: false },
    });

    instance.on('payment.failed', (payload: unknown) => {
      settle({ kind: 'failed', message: readFailureMessage(payload) });
    });

    instance.open();
  });
}
