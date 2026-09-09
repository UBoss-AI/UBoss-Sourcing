/**
 * Saving a card for later.
 *
 * Enrolment in three steps, and the third one is why this is worth a component
 * rather than a form:
 *
 *   1. `POST /account/payment-methods/setup-intent` — the server asks Stripe to
 *      begin, and answers with a client secret and a publishable key.
 *   2. The browser confirms the SetupIntent directly with Stripe. The card
 *      number goes from the customer to Stripe and nowhere else; it does not
 *      pass through this origin, and nothing in this file could read it.
 *   3. `POST /account/payment-methods` — the server RE-READS the intent from
 *      Stripe and stores what Stripe says.
 *
 * Step 3 not trusting step 2 is the point. This dialog sends an intent id and
 * a consent flag; every display detail of the stored card comes from the
 * provider. A page claiming a card was enrolled when it was not gets a
 * refusal, not a row.
 *
 * What is being agreed to is stated in the tick, not in the button. Saving a
 * card that may be charged when nobody is watching is a different thing from
 * typing a card into a checkout, and a customer who did not notice the
 * difference has not consented to it.
 */
import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { AlertIcon } from '@/components/icons';
import { Button, Spinner } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import {
  loadStripeJs,
  stripeAppearance,
  stripeReturnUrl,
  type StripeElement,
  type StripeElements,
  type StripeJs,
} from '@/lib/stripe';
import { useI18n } from '@/i18n/i18n-context';

/** What the server hands back to begin enrolment. No secret key, ever. */
interface SetupIntentResponse {
  setupIntentId: string;
  clientSecret: string;
  publishableKey: string;
  provider: 'STRIPE';
}

interface CardSetupDialogProps {
  /** Called once the SERVER has confirmed the card, never on Stripe's word alone. */
  onSaved: (card: { id: string; label: string | null }) => void;
  onCancel: () => void;
  /**
   * Make this the account's default card.
   *
   * True from the auto-pay flow, where the card is being added in order to be
   * charged and there is nothing else for "default" to mean.
   */
  makeDefault?: boolean;
}

export function CardSetupDialog({
  onSaved,
  onCancel,
  makeDefault = false,
}: CardSetupDialogProps): React.JSX.Element {
  const { t } = useI18n();

  const mountRef = useRef<HTMLDivElement>(null);
  const stripeRef = useRef<StripeJs | null>(null);
  const elementsRef = useRef<StripeElements | null>(null);

  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);

  /**
   * Set when the dialog unmounts mid-load.
   *
   * A ref rather than a local, because it is written by the effect's cleanup
   * and read after an `await` — different turns of the event loop, so a local
   * captured by the closure would still hold the value it had at load time.
   */
  const cancelled = useRef(false);

  const begin = useMutation({
    mutationFn: () => api.post<SetupIntentResponse>('/account/payment-methods/setup-intent'),
    onError: (cause: unknown) => {
      setError(errorMessage(t, cause, t('cardSetup.couldNotStart')));
    },
  });

  const finish = useMutation({
    mutationFn: (setupIntentId: string) =>
      api.post<{ paymentMethod: { id: string; brand: string | null; last4: string | null } }>(
        '/account/payment-methods',
        { setupIntentId, consentAccepted: true, makeDefault },
      ),
    onSuccess: (result) => {
      const card = result.paymentMethod;
      onSaved({
        id: card.id,
        label:
          card.last4 === null ? null : `${card.brand ?? t('cardSetup.card')} ···· ${card.last4}`,
      });
    },
    onError: (cause: unknown) => {
      setError(errorMessage(t, cause, t('cardSetup.couldNotBeSaved')));
    },
  });

  // Ask the server to begin, exactly once. `begin.mutate` is stable across
  // renders, so this cannot re-fire and create a second SetupIntent.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    begin.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setup = begin.data;

  // Mount the card fields once the secret has arrived and the container
  // exists. Re-running this would tear down a form being typed into.
  useEffect(() => {
    if (setup === undefined) return;

    cancelled.current = false;
    // Held out here so the cleanup can tear the iframes down even if the
    // dialog closes while the script is still loading. Without it, React's
    // Strict Mode double-mount alone leaves an orphaned form behind.
    let mounted: StripeElement | null = null;

    void (async () => {
      let factory;
      try {
        factory = await loadStripeJs(t);
      } catch (loadError) {
        if (!cancelled.current) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : t('common.paymentProviderUnreachable'),
          );
        }
        return;
      }

      if (cancelled.current) return;

      const container = mountRef.current;
      if (container === null) return;

      const stripe = factory(setup.publishableKey);
      const elements = stripe.elements({
        clientSecret: setup.clientSecret,
        appearance: stripeAppearance(),
        loader: 'auto',
      });

      const element = elements.create('payment');

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
  }, [setup, t]);

  const confirm = async (): Promise<void> => {
    const stripe = stripeRef.current;
    const elements = elementsRef.current;
    const intentId = setup?.setupIntentId;
    if (stripe === null || elements === null || intentId === undefined) return;

    setError(null);
    setIsConfirming(true);

    let result;
    try {
      result = await stripe.confirmSetup({
        elements,
        // Required even with `if_required`: a full-page 3-D Secure challenge
        // navigates away on enrolment exactly as it does on a payment.
        confirmParams: { return_url: stripeReturnUrl() },
        redirect: 'if_required',
      });
    } catch {
      setIsConfirming(false);
      setError(t('cardSetup.couldNotBeSaved'));
      return;
    }

    setIsConfirming(false);

    if (result.error !== undefined) {
      // Stripe writes these for the cardholder — "Your card was declined",
      // "Your card's security code is incorrect" — and they are more useful
      // than anything this app could substitute. The form stays open so the
      // customer can correct it in place.
      setError(result.error.message ?? t('cardSetup.couldNotBeSaved'));
      return;
    }

    // Stripe's answer is not the record. The id goes to the server, which
    // re-reads the intent and decides what was actually enrolled.
    finish.mutate(intentId);
  };

  const busy = isConfirming || finish.isPending;
  const canConfirm = isReady && consentAccepted && !busy;

  return (
    <Modal
      isOpen
      onClose={onCancel}
      title={t('cardSetup.title')}
      description={t('cardSetup.description')}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="action"
            disabled={!canConfirm}
            isLoading={busy}
            onClick={() => {
              void confirm();
            }}
          >
            {t('cardSetup.saveThisCard')}
          </Button>
        </>
      }
    >
      {error !== null && (
        <div
          role="alert"
          className="mb-4 flex items-start gap-3 rounded-md border border-danger/30 bg-danger-soft px-4 py-3 text-sm"
        >
          <AlertIcon className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <p className="text-ink">{error}</p>
        </div>
      )}

      {(begin.isPending || (!isReady && !begin.isError)) && (
        <div className="flex items-center gap-3 py-6 text-sm text-ink-muted">
          <Spinner className="h-5 w-5" />
          <span>{t('cardSetup.loadingTheSecureForm')}</span>
        </div>
      )}

      {/* Stripe's iframes mount in here. Kept in the tree while loading rather
          than rendered conditionally, because the element needs a container to
          mount into before it can announce that it is ready. */}
      <div ref={mountRef} className={isReady ? '' : 'hidden'} />

      {/*
       * The consent, in its own paragraph and never pre-ticked.
       *
       * This is not the "agree to be charged" tick — that one lives on the
       * auto-pay step, because they are different agreements. This one says
       * only that the card may be kept on file in a form that CAN be charged
       * later, which is the thing a customer typing a card into a checkout has
       * not agreed to.
       */}
      {isReady && (
        <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-md bg-surface-sunken px-4 py-3 text-xs leading-relaxed text-ink">
          <input
            type="checkbox"
            checked={consentAccepted}
            onChange={(event) => {
              setConsentAccepted(event.target.checked);
            }}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-border text-brand focus:ring-brand"
          />
          <span>{t('cardSetup.consent')}</span>
        </label>
      )}

      <p className="mt-4 text-xs leading-relaxed text-ink-subtle">
        {t('payment.cardDetailsInSecureFields')}
      </p>
    </Modal>
  );
}
