/**
 * Payment.
 *
 * The rule this page exists to hold: **the browser never decides whether an
 * order is paid.** Neither a gateway's success callback nor a return from
 * Stripe's page is proof of anything - both arrive through the customer's own
 * tab, and anyone can produce them. Only the backend's answer, which comes from
 * a signature-verified webhook or from the gateway's own API asked by the
 * server, changes what the customer is told.
 *
 * Two gateways, two shapes:
 *
 *   Stripe    This tab is sent to Stripe Checkout, Stripe's own page. The card
 *             is typed or chosen there, 3-D Secure is answered there, and the
 *             option to save the card for next time is Stripe's own unticked
 *             box. The customer comes back to the confirmation page, which
 *             waits for the backend.
 *   Razorpay  Razorpay's sheet opens over this page, and when it closes this
 *             page waits for the backend in the same way.
 *
 * Retrying is safe on both. Stripe allows ONE open payment per order, held by
 * the server - a second tab or a second click is handed the same Stripe page,
 * not a new one. Razorpay reuses one idempotency key from this page, so a
 * customer who fails once and tries again still has one payment.
 *
 * Every visible state is derived from `phase`, and `phase` moves to `paid` in
 * exactly one place: the effect that reads the backend's verdict.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { CheckoutSteps } from '@/components/CheckoutSteps';
import { paymentSteps } from '@/lib/checkout-steps';
import { AlertIcon, CheckIcon, ClockIcon, ShieldIcon } from '@/components/icons';
import { Badge, Button, ButtonLink, ErrorState, LoadingState, Spinner } from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, NetworkError, api, newIdempotencyKey } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatMoney } from '@/lib/format';
import { openRazorpayCheckout, type CheckoutOutcome } from '@/lib/razorpay';
import { confirmationPath, goToCheckout, isSafeCheckoutUrl } from '@/lib/stripe-checkout';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type {
  OrderDetail,
  PaymentInstruments,
  PaymentSession,
  PaymentStatus,
} from '@/lib/types';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

/** How long to keep asking the backend before offering a way out. */
const MAX_POLL_SECONDS = 90;
const POLL_INTERVAL_MS = 2000;

/**
 * How often to ask again when another tab is still opening this order's
 * Stripe page. The server answers PAYMENT_ATTEMPT_IN_PROGRESS for a few
 * seconds while that happens; after this, the customer is told and can retry.
 */
const IN_PROGRESS_RETRIES = 3;
const IN_PROGRESS_DELAY_MS = 1500;

type Phase =
  /** Nothing started yet — the customer has to press Pay. */
  | 'idle'
  /** Asking the backend for a session. The button is disabled. */
  | 'opening'
  /** Leaving for Stripe's page. The tab is navigating. */
  | 'redirecting'
  /** Razorpay's sheet is open over this page. */
  | 'in-provider'
  /** Sheet closed after submission. Waiting for the backend to confirm. */
  | 'processing'
  /** The backend says the order is paid. */
  | 'paid'
  /** The provider or the customer ended it without payment. */
  | 'unpaid'
  /** Back from Stripe through Cancel; the server is closing that page. */
  | 'cancelling'
  /** Back from Stripe through Cancel. Nothing was charged. */
  | 'cancelled';

/**
 * The one-line state of this payment, as a chip beside the heading.
 *
 * `paid` is the only entry that says anything has succeeded, and only the
 * backend can put the page into it.
 */
const PHASE_CHIP: Record<Phase, { tone: BadgeTone; labelKey: TranslationKey }> = {
  idle: { tone: 'warning', labelKey: 'payment.phasePending' },
  opening: { tone: 'brand', labelKey: 'payment.phaseOpening' },
  redirecting: { tone: 'brand', labelKey: 'payment.phaseOpening' },
  'in-provider': { tone: 'brand', labelKey: 'payment.phaseInProvider' },
  processing: { tone: 'brand', labelKey: 'payment.phaseProcessing' },
  paid: { tone: 'success', labelKey: 'payment.phasePaid' },
  // "Not paid", not "Payment not completed": the panel below already carries
  // that sentence, and a chip repeating it word for word reads as two separate
  // failures rather than one.
  unpaid: { tone: 'danger', labelKey: 'payment.phaseUnpaid' },
  cancelling: { tone: 'warning', labelKey: 'payment.phasePending' },
  cancelled: { tone: 'warning', labelKey: 'payment.phaseUnpaid' },
};

/**
 * A status panel. Icon, heading, body — the same shape whatever is being
 * reported, so the page does not reflow into a different layout each time the
 * payment changes state.
 */
function StatusPanel({
  tone,
  icon,
  title,
  children,
  role = 'status',
  panelRef,
}: {
  tone: 'brand' | 'warning' | 'danger' | 'success';
  icon: React.JSX.Element;
  title: string;
  children: React.ReactNode;
  role?: 'status' | 'alert';
  /** Given to the error panel so it can take focus when it appears. */
  panelRef?: React.Ref<HTMLDivElement>;
}): React.JSX.Element {
  const tones = {
    brand: 'border-brand/30 bg-brand-soft text-brand',
    warning: 'border-warning/30 bg-warning-soft text-warning',
    danger: 'border-danger/30 bg-danger-soft text-danger',
    success: 'border-success/30 bg-success-soft text-success',
  } as const;

  return (
    <div
      ref={panelRef}
      role={role}
      tabIndex={panelRef === undefined ? undefined : -1}
      {...(role === 'status' ? { 'aria-live': 'polite' as const } : {})}
      className={cx(
        'flex items-start gap-3 rounded-md border px-4 py-3.5 outline-none focus-visible:ring-2 focus-visible:ring-brand',
        tones[tone],
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 text-sm">
        <p className="font-medium">{title}</p>
        <div className="mt-1 text-ink">{children}</div>
      </div>
    </div>
  );
}

/** One row of the order summary. */
function SummaryRow({
  label,
  value,
  emphasis = false,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className={emphasis ? 'text-sm font-medium text-ink' : 'text-sm text-ink-muted'}>
        {label}
      </dt>
      <dd className={cx('tabular text-ink', emphasis ? 'text-title-lg' : 'text-sm')}>{value}</dd>
    </div>
  );
}

/** A server refusal that says "wait", not "no". */
function isAttemptInProgress(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'PAYMENT_ATTEMPT_IN_PROGRESS';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export function PaymentPage(): React.JSX.Element {
  const { t } = useI18n();

  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { business } = useStorefront();

  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [pollSeconds, setPollSeconds] = useState(0);

  /**
   * Whether to keep the card being entered — Razorpay only.
   *
   * Stripe asks on its own page, with its own unticked box, so this tick is
   * never shown for a Stripe payment: the same question asked twice in two
   * places is a promise that could be kept in one and broken in the other.
   *
   * Starts false and stays false unless they tick it. A pre-ticked consent is
   * not consent under the GDPR.
   */
  const [saveCard, setSaveCard] = useState(false);

  /**
   * A synchronous latch against a double click.
   *
   * `phase` disables the button, but only after React re-renders; two clicks
   * inside one frame both see it enabled. This ref is set on the first and
   * read by the second before either has rendered anything.
   */
  const starting = useRef(false);

  /** The alert that says why a payment did not go through, focused when it appears. */
  const errorPanel = useRef<HTMLDivElement | null>(null);

  const replayState = location.state as { replayed?: boolean } | null;
  const wasReplayed = replayState?.replayed === true;

  useDocumentMeta({ title: t('payment.pageTitle'), noIndex: true }, business.displayName);

  /**
   * One key for every payment attempt on this order from this page.
   *
   * Reused across retries on purpose: for Razorpay the backend hands back the
   * *same* payment session rather than creating a second one. Stripe goes
   * further and deduplicates per order on the server, so a second tab with a
   * different key still lands on the same Stripe page.
   */
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.get<{ order: OrderDetail }>(`/orders/${String(orderId)}`),
    enabled: orderId !== undefined,
  });

  const orderCurrency = order.data?.order.currency ?? null;

  /**
   * What this order's chosen instrument allows: whether a card can be saved,
   * and whether it is paid on Stripe's hosted page.
   */
  const instruments = useQuery({
    queryKey: ['payment-instruments', orderCurrency],
    queryFn: () =>
      api.get<PaymentInstruments>(
        `/payments/instruments?currency=${encodeURIComponent(orderCurrency ?? '')}`,
      ),
    enabled: orderCurrency !== null,
    retry: false,
  });

  /**
   * The backend's view of payment.
   *
   * Polled only while we are waiting for a webhook — the rest of the time it
   * would be asking a question nobody has raised.
   */
  const status = useQuery({
    queryKey: ['payment-status', orderId],
    queryFn: () => api.get<PaymentStatus>(`/payments/orders/${String(orderId)}/status`),
    enabled: orderId !== undefined && phase === 'processing',
    refetchInterval: phase === 'processing' ? POLL_INTERVAL_MS : false,
    // A blip while polling should not abandon the wait.
    retry: 3,
  });

  // Count how long the wait has run, so it can be given an honest limit
  // instead of spinning forever.
  const pollStartedAt = useRef<number | null>(null);

  useEffect(() => {
    if (phase !== 'processing') {
      pollStartedAt.current = null;
      setPollSeconds(0);
      return undefined;
    }

    pollStartedAt.current ??= Date.now();

    const timer = window.setInterval(() => {
      if (pollStartedAt.current === null) return;
      setPollSeconds(Math.floor((Date.now() - pollStartedAt.current) / 1000));
    }, 1000);

    return () => {
      window.clearInterval(timer);
    };
  }, [phase]);

  /**
   * Back from Stripe's page by the browser's own Back button.
   *
   * The browser may restore this page exactly as it was left - mid-redirect,
   * button disabled - from its back-forward cache. `pageshow` with `persisted`
   * is that restore; the page goes back to where the customer can press Pay,
   * which hands them the same Stripe session if it is still open.
   */
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent): void => {
      if (!event.persisted) return;
      starting.current = false;
      setPhase((current) => (current === 'redirecting' || current === 'opening' ? 'idle' : current));
    };

    window.addEventListener('pageshow', onPageShow);
    return () => {
      window.removeEventListener('pageshow', onPageShow);
    };
  }, []);

  /**
   * Coming back from Stripe's Cancel link.
   *
   * The server closes this order's Stripe page at Stripe, so a tab left open
   * behind it cannot take money, and frees the order for a fresh attempt. If
   * the customer had in fact paid in that other tab a moment earlier, the
   * server says so and this page goes to the confirmation instead.
   *
   * The `payment` parameter is read and dropped. It came through the
   * customer's browser and says only where they clicked - never whether
   * money moved.
   */
  const cancelHandled = useRef(false);

  useEffect(() => {
    if (new URLSearchParams(location.search).get('payment') !== 'cancelled') return;
    if (cancelHandled.current || orderId === undefined) return;
    cancelHandled.current = true;

    setPhase('cancelling');
    void navigate(location.pathname, { replace: true, state: replayState });

    void api
      .post<{ state: string; checkoutSessionId: string | null }>(
        `/payments/orders/${orderId}/checkout/cancel`,
        {},
      )
      .then((result) => {
        if (
          result.checkoutSessionId !== null &&
          (result.state === 'SUCCEEDED' || result.state === 'PROCESSING')
        ) {
          void navigate(confirmationPath(orderId, result.checkoutSessionId), { replace: true });
          return;
        }
        setPhase('cancelled');
      })
      .catch(() => {
        // The page at Stripe expires on its own; the order is still saved.
        setPhase('cancelled');
      });
  }, [location.pathname, location.search, replayState, navigate, orderId]);

  /**
   * Returning from a Stripe redirect made by the older in-page form.
   *
   * Kept for a payment that was already under way when this storefront moved
   * to Stripe Checkout. Stripe's own parameters on the URL are not read: they
   * come through the customer's browser.
   */
  useEffect(() => {
    if (new URLSearchParams(location.search).get('stripe_return') !== '1') return;

    setPhase('processing');
    void navigate(location.pathname, { replace: true, state: replayState });
  }, [location.pathname, location.search, replayState, navigate]);

  // The backend's verdict is the only thing that moves this to "paid".
  useEffect(() => {
    if (phase !== 'processing' || status.data === undefined) return;

    if (status.data.paid) {
      setPhase('paid');
      setMessage(null);
    }
  }, [phase, status.data]);

  // An error summary takes focus when it appears, so a keyboard or screen
  // reader user is not left on a button that has just been re-enabled.
  useEffect(() => {
    if (phase === 'unpaid' && message !== null) errorPanel.current?.focus();
  }, [phase, message]);

  /**
   * Whether this installation settles payments on request, with no gateway.
   *
   * A development fixture, and the backend decides it - the environment it
   * needs refuses to boot in production, so a browser cannot talk itself into
   * this being true. Read from the instruments call the page already makes.
   */
  const mockPayments = instruments.data?.mockPayments === true;

  /**
   * Settle this order without a gateway.
   *
   * It does NOT put the page into `paid` - it puts it into the same wait every
   * other payment ends in, and the poll reports the verdict.
   */
  const settleWithoutGateway = useCallback(async (): Promise<void> => {
    setMessage(null);
    setPhase('processing');

    try {
      await api.post(`/payments/orders/${String(orderId)}/mock-capture`, {});
    } catch (error) {
      setPhase('unpaid');
      setMessage(errorMessage(t, error, t('payment.testPaymentDidNotApply')));
    }
  }, [orderId, t]);

  /**
   * What to do once Razorpay's sheet has closed.
   *
   * `submitted` deliberately does not mean paid - it means the customer is
   * finished and the backend has yet to say what happened.
   */
  const handleOutcome = useCallback(
    (outcome: CheckoutOutcome): void => {
      if (outcome.kind === 'dismissed') {
        setPhase('unpaid');
        setMessage(t('payment.youClosedTheWindow'));
        return;
      }

      if (outcome.kind === 'failed') {
        setPhase('unpaid');
        setMessage(outcome.message);
        return;
      }

      setPhase('processing');

      // In test mode, finish the job the webhook would have. Only on
      // `submitted`: a decline somebody is deliberately testing stays a decline.
      if (mockPayments) void settleWithoutGateway();
    },
    [t, mockPayments, settleWithoutGateway],
  );

  /**
   * Ask for the payment, and ask again while another tab is opening it.
   *
   * The body carries no amount, currency, discount, tax or delivery charge -
   * all of those are on the order, and the server reads them from there.
   */
  const requestSession = useCallback(async (): Promise<PaymentSession> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await api.post<PaymentSession>(
          `/payments/orders/${String(orderId)}/session`,
          { saveCard },
          { idempotencyKey },
        );
      } catch (error) {
        if (!isAttemptInProgress(error) || attempt >= IN_PROGRESS_RETRIES) throw error;
        await sleep(IN_PROGRESS_DELAY_MS);
      }
    }
  }, [orderId, idempotencyKey, saveCard]);

  const startPayment = useCallback(async (): Promise<void> => {
    if (starting.current) return;
    starting.current = true;

    setMessage(null);
    setPhase('opening');

    try {
      const session = await requestSession();

      /*
       * Stripe Checkout: leave for Stripe's page.
       *
       * The latch stays set - the tab is navigating away, and nothing on this
       * page should respond to another click in the meantime.
       */
      if (session.next === 'REDIRECT') {
        if (!isSafeCheckoutUrl(session.redirectUrl, session.checkoutSessionId)) {
          throw new Error(t('payment.unableToOpenSecurePayment'));
        }

        setPhase('redirecting');
        goToCheckout(session.redirectUrl);
        return;
      }

      /*
       * Already paid, or submitted and settling - in another tab, most likely.
       * Nothing to open; the confirmation page waits for the backend.
       */
      if (session.next === 'AWAIT_CONFIRMATION') {
        if (typeof session.checkoutSessionId === 'string' && orderId !== undefined) {
          void navigate(confirmationPath(orderId, session.checkoutSessionId));
          return;
        }

        starting.current = false;
        setPhase('processing');
        return;
      }

      if (session.provider !== 'RAZORPAY') {
        starting.current = false;
        setPhase('unpaid');
        setMessage(t('payment.needsAMethodWeCannotOpen'));
        return;
      }

      setPhase('in-provider');
      const outcome = await openRazorpayCheckout(t, session.checkoutPayload);
      starting.current = false;
      handleOutcome(outcome);
    } catch (error) {
      starting.current = false;
      setPhase('unpaid');

      if (error instanceof NetworkError) {
        setMessage(errorMessage(t, error));
        return;
      }

      if (error instanceof ApiError && error.code === 'PAYMENT_PROVIDER_ERROR') {
        // Our own sentence. The gateway's is logged on the server and has no
        // business in front of a customer.
        setMessage(t('payment.unableToOpenSecurePayment'));
        return;
      }

      setMessage(errorMessage(t, error, t('payment.couldNotBeStarted')));
    }
  }, [orderId, requestSession, handleOutcome, navigate, t]);

  if (order.isPending) return <LoadingState label={t('payment.loadingYourOrder')} />;

  if (order.isError) {
    return (
      <ErrorState
        error={order.error}
        onRetry={() => {
          void order.refetch();
        }}
      />
    );
  }

  const currentOrder = order.data.order;
  const totals = currentOrder.totals;
  const outstanding = totals.grandTotal;

  const chosenOffer =
    (instruments.data?.instruments ?? []).find(
      (offer) => offer.instrument === currentOrder.preferredPaymentInstrument,
    ) ?? null;

  /** Paid on Stripe's hosted page, which asks about saving the card itself. */
  const hostedCheckout = chosenOffer?.hostedCheckout === true;

  /**
   * Whether to offer our own save tick. Razorpay only, and only where it can
   * be honoured: a card payment, not already using a saved card, on a gateway
   * that can store one.
   */
  const canOfferToSaveCard =
    !hostedCheckout &&
    currentOrder.preferredPaymentInstrument !== null &&
    currentOrder.preferredPaymentInstrument !== 'UPI' &&
    currentOrder.preferredPaymentMethodId === null &&
    chosenOffer?.canSaveCard === true;

  // Already settled before this page even opened — a webhook can land while
  // the customer is still on the provider's screen.
  const alreadyPaid =
    BigInt(totals.paid.minor) >= BigInt(totals.grandTotal.minor) && totals.grandTotal.minor !== '0';

  if (alreadyPaid || phase === 'paid') {
    return (
      <div className="mx-auto max-w-2xl py-4">
        <CheckoutSteps states={paymentSteps(true)} />

        <div className="rounded-lg border border-success/30 bg-success-soft p-8 text-center shadow-card">
          <span
            aria-hidden="true"
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-fill text-white"
          >
            <CheckIcon className="h-6 w-6" />
          </span>

          {/* Said only here, and only because the backend has said it first. */}
          <h1 className="mt-4 text-title-lg text-success">{t('payment.paymentConfirmed')}</h1>
          <p className="mt-2 text-sm text-ink">
            {t('payment.orderIsPaid').split('{{order}}')[0]}
            <span className="font-mono font-medium">{currentOrder.orderNumber}</span>
            {t('payment.orderIsPaid').split('{{order}}')[1]}
          </p>

          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <ButtonLink to={`/account/orders/${currentOrder.id}`} variant="primary" size="lg">
              {t('payment.viewYourOrder')}
            </ButtonLink>
            <ButtonLink to="/products" size="lg">
              {t('payment.keepShopping')}
            </ButtonLink>
          </div>

          <p className="mt-4 text-xs text-ink-muted">
            <Link to="/account/orders" className="font-medium text-brand hover:underline">
              {t('payment.allYourOrders')}
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const pollTimedOut = phase === 'processing' && pollSeconds >= MAX_POLL_SECONDS;
  const chip = PHASE_CHIP[phase];
  const busy = phase === 'opening' || phase === 'redirecting' || phase === 'in-provider' || phase === 'cancelling';
  const canStart = phase === 'idle' || phase === 'unpaid' || phase === 'cancelled';
  const itemCount = currentOrder.items.reduce((sum, item) => sum + item.quantity, 0);
  const billing = currentOrder.billingAddress;
  const hasDiscount = totals.discount.minor !== '0';

  return (
    <div className="mx-auto max-w-2xl py-4">
      <CheckoutSteps states={paymentSteps(false)} />

      {wasReplayed && (
        <div
          role="status"
          className="mb-5 rounded-md border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-brand"
        >
          {t('payment.thisOrderWasAlreadyPlaced')}
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-5 shadow-card sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-title-lg text-ink">{t('payment.payForYourOrder')}</h1>
            <p className="mt-1 text-sm text-ink-muted">
              {t('payment.orderLabel')}{' '}
              <span className="font-mono font-medium text-ink">{currentOrder.orderNumber}</span>
            </p>
          </div>

          {/* The state of the payment itself, always on screen, never ahead of
              the backend. */}
          <Badge tone={chip.tone}>{translateKey(t, chip.labelKey)}</Badge>
        </div>

        {/*
          The order summary, exactly as the server priced it.

          Every figure is read from the order - nothing here is computed from
          the lines, because a second calculation in the browser is a second
          answer that could disagree with the one the customer is charged.
        */}
        <section aria-labelledby="payment-summary-heading" className="mt-5 border-y border-border py-4">
          <h2 id="payment-summary-heading" className="sr-only">
            {t('payment.summaryTitle')}
          </h2>
          <dl className="space-y-2">
            {itemCount > 0 && (
              <SummaryRow
                label={t('payment.itemCount', { count: itemCount })}
                value={formatMoney(totals.subtotal)}
              />
            )}
            {itemCount === 0 && (
              <SummaryRow label={t('payment.subtotal')} value={formatMoney(totals.subtotal)} />
            )}
            {hasDiscount && (
              <SummaryRow label={t('payment.discount')} value={`−${formatMoney(totals.discount)}`} />
            )}
            <SummaryRow label={t('payment.delivery')} value={formatMoney(totals.shipping)} />
            <SummaryRow label={t('payment.tax')} value={formatMoney(totals.tax)} />
            <div className="border-t border-border-subtle pt-2">
              <SummaryRow label={t('payment.amountDue')} value={formatMoney(outstanding)} emphasis />
            </div>
          </dl>
          <p className="mt-2 text-right text-xs text-ink-subtle">
            {t('payment.chargedIn', { currency: currentOrder.currency })}
          </p>
        </section>

        {billing !== null && (
          <section aria-labelledby="payment-billing-heading" className="mt-4 text-sm">
            <h2 id="payment-billing-heading" className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
              {t('payment.billingTo')}
            </h2>
            <address className="mt-1 not-italic leading-relaxed text-ink">
              {billing.contactName !== null && <span className="block font-medium">{billing.contactName}</span>}
              <span className="block">
                {[billing.line1, billing.line2].filter((part) => part !== null && part.length > 0).join(', ')}
              </span>
              <span className="block text-ink-muted">
                {[billing.postalCode, billing.city, billing.country].filter((part) => part.length > 0).join(' · ')}
              </span>
            </address>
          </section>
        )}

        {/* --- Processing -------------------------------------------------- */}
        {phase === 'processing' && (
          <div className="mt-6 space-y-3">
            <StatusPanel
              tone="brand"
              icon={<Spinner className="h-5 w-5" />}
              title={t('payment.confirmingYourPayment')}
            >
              {t('payment.yourBankHasAcceptedIt')}
            </StatusPanel>

            {pollTimedOut && (
              <StatusPanel
                tone="warning"
                icon={<ClockIcon className="h-5 w-5" />}
                title={t('payment.thisIsTakingLongerThan')}
              >
                <p>{t('payment.yourPaymentHasNotBeen')}</p>
                <Link
                  to={`/account/orders/${currentOrder.id}`}
                  className="mt-2 inline-block font-semibold underline underline-offset-2"
                >
                  {t('payment.viewTheOrder')}
                </Link>
              </StatusPanel>
            )}
          </div>
        )}

        {/* --- Not paid ----------------------------------------------------- */}
        {phase === 'unpaid' && message !== null && (
          <div className="mt-6">
            <StatusPanel
              tone="warning"
              role="alert"
              panelRef={errorPanel}
              icon={<AlertIcon className="h-5 w-5" />}
              title={t('payment.paymentNotCompleted')}
            >
              {message}
            </StatusPanel>
          </div>
        )}

        {/* --- Back from Stripe through Cancel ------------------------------ */}
        {(phase === 'cancelled' || phase === 'cancelling') && (
          <div className="mt-6">
            <StatusPanel
              tone="warning"
              icon={
                phase === 'cancelling' ? <Spinner className="h-5 w-5" /> : <AlertIcon className="h-5 w-5" />
              }
              title={t('payment.cancelledTitle')}
            >
              {t('payment.cancelledBody')}
            </StatusPanel>
          </div>
        )}

        {/*
          Test mode, said out loud.

          A deployment that quietly confirms orders nobody paid for is worse
          than one that refuses to confirm them at all, because sooner or later
          somebody demonstrates it to a customer.
        */}
        {mockPayments && (
          <div className="mt-6 space-y-3">
            <StatusPanel
              tone="warning"
              icon={<AlertIcon className="h-5 w-5" />}
              title={t('payment.testModeTitle')}
            >
              <p>{t('payment.testModeBody')}</p>

              <Button
                size="sm"
                className="mt-3"
                disabled={busy}
                onClick={() => {
                  void settleWithoutGateway();
                }}
              >
                {t('payment.markThisOrderPaid')}
              </Button>
            </StatusPanel>
          </div>
        )}

        {/* --- Actions ------------------------------------------------------ */}
        {(canStart || busy) && phase !== 'in-provider' && (
          <div className="mt-6 space-y-3">
            {/*
              Keep this card for next time — Razorpay only.

              Never pre-ticked. What gets stored is a token held by the
              gateway, never a card number: since October 2022 the RBI forbids
              a merchant storing one.
            */}
            {canOfferToSaveCard && canStart && (
              <label className="flex cursor-pointer items-start gap-3 rounded-md bg-surface-sunken px-4 py-3 text-xs">
                <input
                  type="checkbox"
                  className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-brand"
                  checked={saveCard}
                  onChange={(event) => {
                    setSaveCard(event.target.checked);
                  }}
                />
                <span className="min-w-0">
                  <span className="block font-medium text-ink">{t('payment.saveThisCard')}</span>
                  <span className="mt-0.5 block leading-relaxed text-ink-muted">
                    {t('payment.saveThisCardHint')}
                  </span>
                </span>
              </label>
            )}

            <Button
              variant="action"
              size="lg"
              fullWidth
              isLoading={busy}
              disabled={!canStart}
              aria-busy={busy}
              onClick={() => {
                void startPayment();
              }}
            >
              {busy
                ? t('payment.openingSecurePayment')
                : phase === 'unpaid' || phase === 'cancelled'
                  ? t('payment.tryThePaymentAgain')
                  : t('payment.paySecurelyNow')}
            </Button>

            {/* Announced once, when the tab is about to leave for Stripe. */}
            <p className="sr-only" role="status" aria-live="polite">
              {phase === 'redirecting' ? t('payment.redirectingToStripe') : ''}
            </p>

            {/* Retrying can never create a second order or a second payment.
                Saying so removes the main reason a customer would hesitate. */}
            <p className="text-center text-xs text-ink-muted">
              {t('payment.retryingUsesThisSameOrder')}
            </p>

            <ButtonLink to={`/account/orders/${currentOrder.id}`} fullWidth>
              {t('payment.payLaterViewTheOrder')}
            </ButtonLink>
          </div>
        )}

        {/* --- Razorpay's sheet is open over this page ----------------------- */}
        {phase === 'in-provider' && (
          <div className="mt-6">
            <StatusPanel
              tone="brand"
              icon={<Spinner className="h-5 w-5" />}
              title={t('payment.finishPayingInWindow')}
            >
              {t('payment.theWindowIsOpen')}
            </StatusPanel>
          </div>
        )}

        <div className="mt-6 flex gap-2.5 border-t border-border pt-4 text-xs leading-relaxed text-ink-subtle">
          <ShieldIcon className="mt-px h-4 w-4 shrink-0 text-ink-muted" />
          <div className="space-y-1">
            <p>{t('payment.cardDetailsOnProviderPage')}</p>
            {hostedCheckout && (
              <>
                <p className="font-medium text-ink-muted">{t('payment.securedByStripe')}</p>
                <p>{t('payment.stripeHostedNote')}</p>
              </>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
        <button
          type="button"
          onClick={() => {
            void navigate('/cart');
          }}
          className="text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          {t('payment.backToTheCart')}
        </button>
        <Link
          to="/account/orders"
          className="text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          {t('payment.allYourOrders')}
        </Link>
      </div>

      {currentOrder.status === 'PENDING_APPROVAL' && (
        <div className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
          <Badge tone="warning">{t('payment.awaitingApproval')}</Badge>
          <p className="mt-1.5 text-ink">{t('payment.thisOrderIsWithYour')}</p>
        </div>
      )}
    </div>
  );
}
