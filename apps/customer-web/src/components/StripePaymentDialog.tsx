/**
 * The Stripe payment form.
 *
 * Razorpay ships its own hosted sheet, so `openRazorpayCheckout` is a single
 * function call. Stripe hands back an *Element* that has to be mounted into
 * this page's DOM, so its equivalent is a component — but the contract it
 * reports back through is the same `CheckoutOutcome`, and the payment page
 * treats both providers identically once it has one.
 *
 * The card fields render inside Stripe's own cross-origin iframes. This
 * component holds the box they sit in and nothing else; it cannot read what is
 * typed there, and the client secret it uses authorises confirming this one
 * payment and nothing else.
 *
 * `submitted` is not `paid`. Stripe's own answer is a claim made in the
 * customer's browser, so it is not forwarded anywhere — the payment page goes
 * on to ask the backend, which only knows a payment succeeded because it
 * verified a webhook signature.
 */
import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/Modal';
import { AlertIcon } from '@/components/icons';
import { Button, Spinner } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import {
  loadStripeJs,
  stripeAppearance,
  stripeReturnUrl,
  type CheckoutOutcome,
  type StripeElement,
  type StripeElements,
  type StripeJs,
} from '@/lib/stripe';
import type { Money } from '@/lib/types';

/**
 * The customer's own message for a failure that is theirs to fix.
 *
 * Stripe writes these for the cardholder — "Your card was declined", "Your
 * card's security code is incorrect" — and they are more useful than anything
 * this app could substitute.
 */
const GENERIC_FAILURE = 'The payment did not go through. No money has been taken.';

interface StripePaymentDialogProps {
  /** The backend's `checkoutPayload`. Public values only; no secret key. */
  payload: Record<string, string | number>;
  amount: Money;
  orderNumber: string;
  /** Called exactly once, with how the form closed. */
  onOutcome: (outcome: CheckoutOutcome) => void;
}

export function StripePaymentDialog({
  payload,
  amount,
  orderNumber,
  onOutcome,
}: StripePaymentDialogProps): React.JSX.Element {
  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<StripeJs | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Report the outcome at most once.
   *
   * Escape, the close button and a terminal failure can all fire in quick
   * succession, and a second report would move the payment page out of a state
   * it has already left.
   */
  const settled = useRef(false);
  /**
   * Set when this dialog unmounts mid-load.
   *
   * A ref rather than a local, because the flag is written by the effect's
   * cleanup and read after an `await` - the two are different turns of the
   * event loop, and a local captured by the closure would be read as the value
   * it had when the load started.
   */
  const cancelled = useRef(false);
  const settle = (outcome: CheckoutOutcome): void => {
    if (settled.current) return;
    settled.current = true;
    onOutcome(outcome);
  };

  const publishableKey = String(payload.key ?? '');
  const clientSecret = String(payload.client_secret ?? '');
  const prefillEmail = String(payload.prefill_email ?? '');
  const prefillName = String(payload.prefill_name ?? '');
  const prefillContact = String(payload.prefill_contact ?? '');

  // Mount the Payment Element once, when the script and the container are both
  // ready. Re-running it would tear down a form the customer is typing into.
  useEffect(() => {
    cancelled.current = false;
    // Held out here so the cleanup can tear the iframes down even if the
    // customer closes the dialog while the script is still loading. Without
    // it, React's Strict Mode double-mount alone leaves an orphaned form.
    let mounted: StripeElement | null = null;

    void (async () => {
      if (publishableKey.length === 0 || clientSecret.length === 0) {
        settle({
          kind: 'failed',
          message: 'The payment session was incomplete. Please try again.',
        });
        return;
      }

      let factory;
      try {
        factory = await loadStripeJs();
      } catch (loadError) {
        settle({
          kind: 'failed',
          message:
            loadError instanceof Error
              ? loadError.message
              : 'The payment provider could not be reached.',
        });
        return;
      }

      if (cancelled.current) return;

      const container = mountRef.current;
      if (container === null) return;

      const stripe = factory(publishableKey);
      const elements = stripe.elements({
        clientSecret,
        appearance: stripeAppearance(),
        loader: 'auto',
      });

      const element = elements.create('payment', {
        // Prefilled from the account, not collected again. `never` on the
        // fields we already hold keeps the form to what Stripe actually needs.
        fields: { billingDetails: { email: 'never', name: 'never', phone: 'never' } },
        defaultValues: {
          billingDetails: {
            ...(prefillEmail.length > 0 ? { email: prefillEmail } : {}),
            ...(prefillName.length > 0 ? { name: prefillName } : {}),
            ...(prefillContact.length > 0 ? { phone: prefillContact } : {}),
          },
        },
      });

      element.on('ready', () => {
        if (!cancelled.current) setIsReady(true);
      });

      element.mount(container);
      mounted = element;

      stripeRef.current = stripe;
      elementsRef.current = elements;
    })();

    return () => {
      cancelled.current = true;
      mounted?.destroy();
    };
    // Mount once. The payload for one payment attempt does not change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirm = async (): Promise<void> => {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    if (stripe === null || elements === null) return;

    setError(null);
    setIsConfirming(true);

    let result;
    try {
      result = await stripe.confirmPayment({
        elements,
        // Required even with `if_required`: iDEAL, Bancontact and a full-page
        // 3-D Secure challenge navigate away, and Stripe refuses to start one
        // it cannot bring the customer back from.
        confirmParams: {
          return_url: stripeReturnUrl(),
          payment_method_data: {
            billing_details: {
              ...(prefillEmail.length > 0 ? { email: prefillEmail } : {}),
              ...(prefillName.length > 0 ? { name: prefillName } : {}),
              ...(prefillContact.length > 0 ? { phone: prefillContact } : {}),
            },
          },
        },
        redirect: 'if_required',
      });
    } catch {
      setIsConfirming(false);
      settle({ kind: 'failed', message: GENERIC_FAILURE });
      return;
    }

    setIsConfirming(false);

    if (result.error !== undefined) {
      const { type, message } = result.error;

      // The customer's to fix: a declined card, a wrong CVC, a field left
      // blank. The form stays open so they can correct it in place, which is
      // the whole reason Elements is mounted here rather than on a hosted page.
      if (type === 'validation_error' || type === 'card_error') {
        setError(message ?? GENERIC_FAILURE);
        return;
      }

      settle({ kind: 'failed', message: message ?? GENERIC_FAILURE });
      return;
    }

    const status = result.paymentIntent?.status;

    // `requires_payment_method` means the attempt ended without one being
    // charged — the customer needs to choose again.
    if (status === 'requires_payment_method') {
      setError('That payment method did not work. Please try another one.');
      return;
    }

    // `succeeded` and `processing` are both "the customer is done here".
    // Neither means paid: a SEPA debit sits in `processing` for days, and even
    // `succeeded` is only Stripe telling this browser so. The payment page
    // asks the backend next.
    settle({ kind: 'submitted' });
  };

  return (
    <Modal
      isOpen
      onClose={() => {
        settle({ kind: 'dismissed' });
      }}
      title="Pay securely"
      description={`Order ${orderNumber} · ${formatMoney(amount)}`}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              settle({ kind: 'dismissed' });
            }}
            disabled={isConfirming}
          >
            Cancel
          </Button>
          <Button
            variant="action"
            onClick={() => {
              void confirm();
            }}
            disabled={!isReady || isConfirming}
          >
            {isConfirming ? 'Confirming…' : `Pay ${formatMoney(amount)}`}
          </Button>
        </>
      }
    >
      {error !== null && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
        >
          <AlertIcon className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="text-ink">{error}</p>
        </div>
      )}

      {!isReady && (
        <div className="flex items-center gap-3 py-6 text-sm text-ink-muted">
          <Spinner className="h-5 w-5" />
          <span>Loading the secure payment form…</span>
        </div>
      )}

      {/* Stripe's iframes mount in here. Kept in the tree while loading rather
          than rendered conditionally, because the element needs a container to
          mount into before it can announce that it is ready. */}
      <div ref={mountRef} className={isReady ? '' : 'hidden'} />

      <p className="mt-4 text-xs leading-relaxed text-ink-subtle">
        Card details are entered inside our payment provider&rsquo;s own secure fields and never
        reach this site. Nothing is charged until you press Pay.
      </p>
    </Modal>
  );
}
