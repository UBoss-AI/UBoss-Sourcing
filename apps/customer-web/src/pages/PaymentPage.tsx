/**
 * Payment.
 *
 * The rule this page exists to hold: **the browser never decides whether an
 * order is paid.** Razorpay's success callback fires in the customer's own
 * tab; anyone can fire it. So when the sheet closes, this page does not say
 * "paid" — it starts asking the backend, and only the backend's answer, which
 * comes from a signature-verified webhook, changes what the customer is told.
 *
 * That produces a genuine Processing state, and it is honest: for a few
 * seconds nobody knows yet, including us.
 *
 * Retrying is safe. A retry asks for a payment session on the *same order*
 * with the same idempotency key, so a customer who fails once, closes the
 * sheet, and tries again ends up with one order and one payment — never two
 * orders.
 *
 * Every visible state on this page is derived from `phase`, and `phase` moves
 * to `paid` in exactly one place: the effect that reads the backend's verdict.
 * The status strip, the progress indicator and the heading all read from it,
 * so there is no second path by which the UI could claim a payment the server
 * has not confirmed.
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
import { openRazorpayCheckout } from '@/lib/razorpay';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderDetail, PaymentSession, PaymentStatus } from '@/lib/types';

/** How long to keep asking the backend before offering a way out. */
const MAX_POLL_SECONDS = 90;
const POLL_INTERVAL_MS = 2000;

type Phase =
  /** Nothing started yet — the customer has to press Pay. */
  | 'idle'
  /** Asking the backend for a session and opening the provider sheet. */
  | 'opening'
  /** The sheet is open; the customer is inside the provider's UI. */
  | 'in-provider'
  /** Sheet closed after submission. Waiting for the backend to confirm. */
  | 'processing'
  /** The backend says the order is paid. */
  | 'paid'
  /** The provider or the customer ended it without payment. */
  | 'unpaid';

/**
 * The one-line state of this payment, as a chip beside the amount.
 *
 * Five distinct things can be true, and a customer who refreshes, or comes
 * back to the tab, needs to know which one without reading a paragraph.
 * `paid` is the only entry that says anything has succeeded, and only the
 * backend can put the page into it.
 */
const PHASE_CHIP: Record<Phase, { tone: BadgeTone; label: string }> = {
  idle: { tone: 'warning', label: 'Payment pending' },
  opening: { tone: 'brand', label: 'Opening payment window' },
  'in-provider': { tone: 'brand', label: 'Action needed in the payment window' },
  processing: { tone: 'brand', label: 'Processing' },
  paid: { tone: 'success', label: 'Paid' },
  // "Not paid", not "Payment not completed": the panel below already carries
  // that sentence, and a chip repeating it word for word reads as two separate
  // failures rather than one.
  unpaid: { tone: 'danger', label: 'Not paid' },
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
}: {
  tone: 'brand' | 'warning' | 'danger' | 'success';
  icon: React.JSX.Element;
  title: string;
  children: React.ReactNode;
  role?: 'status' | 'alert';
}): React.JSX.Element {
  const tones = {
    brand: 'border-brand/30 bg-brand-soft text-brand',
    warning: 'border-warning/30 bg-warning-soft text-warning',
    danger: 'border-danger/30 bg-danger-soft text-danger',
    success: 'border-success/30 bg-success-soft text-success',
  } as const;

  return (
    <div
      role={role}
      {...(role === 'status' ? { 'aria-live': 'polite' as const } : {})}
      className={cx('flex items-start gap-3 rounded-md border px-4 py-3.5', tones[tone])}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0 text-sm">
        <p className="font-medium">{title}</p>
        <div className="mt-1 text-ink">{children}</div>
      </div>
    </div>
  );
}

export function PaymentPage(): React.JSX.Element {
  const { orderId } = useParams<{ orderId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const { business } = useStorefront();

  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState<string | null>(null);
  const [pollSeconds, setPollSeconds] = useState(0);

  const wasReplayed = (location.state as { replayed?: boolean } | null)?.replayed === true;

  useDocumentMeta({ title: 'Payment', noIndex: true }, business.displayName);

  /**
   * One key for every payment attempt on this order from this page.
   *
   * Reused across retries on purpose: the backend then hands back the *same*
   * payment session rather than creating a second one, so a customer who tries
   * three times still has one payment against one order.
   */
  const idempotencyKey = useMemo(() => newIdempotencyKey(), []);

  const order = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.get<{ order: OrderDetail }>(`/orders/${String(orderId)}`),
    enabled: orderId !== undefined,
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

  // The backend's verdict is the only thing that moves this to "paid".
  useEffect(() => {
    if (phase !== 'processing' || status.data === undefined) return;

    if (status.data.paid) {
      setPhase('paid');
      setMessage(null);
    }
  }, [phase, status.data]);

  const startPayment = useCallback(async (): Promise<void> => {
    setMessage(null);
    setPhase('opening');

    try {
      const session = await api.post<PaymentSession>(
        `/payments/orders/${String(orderId)}/session`,
        undefined,
        { idempotencyKey },
      );

      if (session.provider !== 'RAZORPAY') {
        setPhase('unpaid');
        setMessage(
          'This order needs a payment method we cannot open here. Please contact us and we will send you a payment link.',
        );
        return;
      }

      setPhase('in-provider');

      const outcome = await openRazorpayCheckout(session.checkoutPayload);

      if (outcome.kind === 'dismissed') {
        setPhase('unpaid');
        setMessage('You closed the payment window. Your order is saved and still awaiting payment.');
        return;
      }

      if (outcome.kind === 'failed') {
        setPhase('unpaid');
        setMessage(outcome.message);
        return;
      }

      // Submitted — which is a claim, not a confirmation. Now we ask the
      // backend, and keep asking until its webhook has been verified.
      setPhase('processing');
    } catch (error) {
      setPhase('unpaid');

      if (error instanceof NetworkError) {
        setMessage(error.message);
        return;
      }

      setMessage(
        error instanceof ApiError ? error.message : 'The payment could not be started. Please try again.',
      );
    }
  }, [orderId, idempotencyKey]);

  if (order.isPending) return <LoadingState label="Loading your order" />;

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
  const outstanding = currentOrder.totals.grandTotal;

  // Already settled before this page even opened — a webhook can land while
  // the customer is still on the provider's screen.
  const alreadyPaid =
    BigInt(currentOrder.totals.paid.minor) >= BigInt(currentOrder.totals.grandTotal.minor) &&
    currentOrder.totals.grandTotal.minor !== '0';

  if (alreadyPaid || phase === 'paid') {
    return (
      <div className="mx-auto max-w-2xl py-4">
        <CheckoutSteps states={paymentSteps(true)} />

        <div className="rounded-lg border border-success/30 bg-success-soft p-8 text-center shadow-card">
          <span
            aria-hidden="true"
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success text-white"
          >
            <CheckIcon className="h-6 w-6" />
          </span>

          {/* Said only here, and only because the backend has said it first. */}
          <h1 className="mt-4 text-title-lg text-success">Payment confirmed</h1>
          <p className="mt-2 text-sm text-ink">
            Order{' '}
            <span className="font-mono font-medium">{currentOrder.orderNumber}</span> is paid. We
            have emailed your confirmation.
          </p>

          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <ButtonLink to={`/account/orders/${currentOrder.id}`} variant="primary" size="lg">
              View your order
            </ButtonLink>
            <ButtonLink to="/products" size="lg">
              Keep shopping
            </ButtonLink>
          </div>

          <p className="mt-4 text-xs text-ink-muted">
            <Link to="/account/orders" className="font-medium text-brand hover:underline">
              All your orders
            </Link>
          </p>
        </div>
      </div>
    );
  }

  const pollTimedOut = phase === 'processing' && pollSeconds >= MAX_POLL_SECONDS;
  const chip = PHASE_CHIP[phase];

  return (
    <div className="mx-auto max-w-2xl py-4">
      <CheckoutSteps states={paymentSteps(false)} />

      {wasReplayed && (
        <div
          role="status"
          className="mb-5 rounded-md border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-brand"
        >
          This order was already placed — we have not created a second one.
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-6 shadow-card">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h1 className="text-title-lg text-ink">Pay for your order</h1>
            <p className="mt-1 text-sm text-ink-muted">
              Order{' '}
              <span className="font-mono font-medium text-ink">{currentOrder.orderNumber}</span> ·
              placed just now
            </p>
          </div>

          {/* The state of the payment itself, always on screen, never ahead of
              the backend. `idle` says pending, not "ready" — nothing has been
              paid and the chip should not imply otherwise. */}
          <Badge tone={chip.tone}>{chip.label}</Badge>
        </div>

        <div className="mt-5 flex items-baseline justify-between border-y border-border py-4">
          <span className="text-sm text-ink-muted">Amount due</span>
          <span className="text-title-lg tabular text-ink">{formatMoney(outstanding)}</span>
        </div>

        {/* --- Processing -------------------------------------------------- */}
        {phase === 'processing' && (
          <div className="mt-6 space-y-3">
            <StatusPanel
              tone="brand"
              icon={<Spinner className="h-5 w-5" />}
              title="Confirming your payment"
            >
              Your bank has accepted it. We are waiting for our payment provider to confirm,
              which usually takes a few seconds. Please do not close this page or pay again.
            </StatusPanel>

            {pollTimedOut && (
              <StatusPanel
                tone="warning"
                icon={<ClockIcon className="h-5 w-5" />}
                title="This is taking longer than usual"
              >
                <p>
                  Your payment has not been lost. It will be confirmed automatically, and you will
                  get an email when it is. You can safely leave this page and check your order.
                </p>
                <Link
                  to={`/account/orders/${currentOrder.id}`}
                  className="mt-2 inline-block font-semibold underline underline-offset-2"
                >
                  View the order
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
              icon={<AlertIcon className="h-5 w-5" />}
              title="Payment not completed"
            >
              {message}
            </StatusPanel>
          </div>
        )}

        {/* --- Actions ------------------------------------------------------ */}
        {(phase === 'idle' || phase === 'unpaid') && (
          <div className="mt-6 space-y-3">
            <Button
              variant="action"
              size="lg"
              fullWidth
              onClick={() => {
                void startPayment();
              }}
            >
              {phase === 'unpaid' ? 'Try the payment again' : 'Pay securely now'}
            </Button>

            {/* Retrying reuses the same order and the same idempotency key, so
                there is no way to end up with two orders. Saying so removes
                the main reason a customer would hesitate. */}
            <p className="text-center text-xs text-ink-muted">
              Retrying uses this same order — it will never create a second one.
            </p>

            <ButtonLink to={`/account/orders/${currentOrder.id}`} fullWidth>
              Pay later — view the order
            </ButtonLink>
          </div>
        )}

        {/* --- Requires action in the provider's window ---------------------- */}
        {(phase === 'opening' || phase === 'in-provider') && (
          <div className="mt-6">
            <StatusPanel
              tone="brand"
              icon={<Spinner className="h-5 w-5" />}
              title={
                phase === 'opening'
                  ? 'Opening the secure payment window'
                  : 'Finish paying in the payment window'
              }
            >
              {phase === 'opening'
                ? 'One moment — we are asking our payment provider for a secure session for this order.'
                : 'The payment window is open. Complete the payment there and this page will pick it up. Nothing is charged until you finish.'}
            </StatusPanel>
          </div>
        )}

        <div className="mt-6 flex gap-2.5 border-t border-border pt-4 text-xs leading-relaxed text-ink-subtle">
          <ShieldIcon className="mt-px h-4 w-4 shrink-0 text-ink-muted" />
          <p>
            Card details are entered on our payment provider&rsquo;s own secure page and never reach
            this site. We only ever learn that a payment succeeded, never how it was made.
          </p>
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
          Back to the cart
        </button>
        <Link
          to="/account/orders"
          className="text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          All your orders
        </Link>
      </div>

      {currentOrder.status === 'PENDING_APPROVAL' && (
        <div className="mt-4 rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
          <Badge tone="warning">Awaiting approval</Badge>
          <p className="mt-1.5 text-ink">
            This order is with your approver. Payment opens once it is approved.
          </p>
        </div>
      )}
    </div>
  );
}
