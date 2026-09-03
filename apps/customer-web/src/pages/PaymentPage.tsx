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
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { Badge, Button, ErrorState, LoadingState, Spinner } from '@/components/ui';
import { ApiError, NetworkError, api, newIdempotencyKey } from '@/lib/api';
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
      <div className="mx-auto max-w-lg py-12 text-center">
        <div className="rounded-lg border border-success/30 bg-success-soft p-8">
          <h1 className="text-xl font-semibold text-success">Payment confirmed</h1>
          <p className="mt-2 text-sm text-ink">
            Order {currentOrder.orderNumber} is paid. We have emailed your confirmation.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link
              to={`/account/orders/${currentOrder.id}`}
              className="inline-flex h-11 items-center rounded-md bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover"
            >
              View your order
            </Link>
            <Link
              to="/products"
              className="inline-flex h-11 items-center rounded-md border border-border-strong bg-surface px-5 text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Keep shopping
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const pollTimedOut = phase === 'processing' && pollSeconds >= MAX_POLL_SECONDS;

  return (
    <div className="mx-auto max-w-lg py-8">
      {wasReplayed && (
        <div
          role="status"
          className="mb-5 rounded-md border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-brand"
        >
          This order was already placed — we have not created a second one.
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-6">
        <h1 className="text-xl font-semibold tracking-tight text-ink">Pay for your order</h1>
        <p className="mt-1.5 text-sm text-ink-muted">
          Order {currentOrder.orderNumber} · placed just now
        </p>

        <div className="mt-5 flex items-baseline justify-between border-y border-border py-4">
          <span className="text-sm text-ink-muted">Amount due</span>
          <span className="text-2xl font-semibold tabular text-ink">{formatMoney(outstanding)}</span>
        </div>

        {/* --- Processing -------------------------------------------------- */}
        {phase === 'processing' && (
          <div className="mt-6" role="status" aria-live="polite">
            <div className="flex items-start gap-3 rounded-md border border-brand/30 bg-brand-soft px-4 py-3.5">
              <Spinner className="mt-0.5 h-5 w-5 text-brand" />
              <div className="text-sm">
                <p className="font-medium text-brand">Confirming your payment</p>
                <p className="mt-1 text-ink">
                  Your bank has accepted it. We are waiting for our payment provider to confirm,
                  which usually takes a few seconds. Please do not close this page or pay again.
                </p>
              </div>
            </div>

            {pollTimedOut && (
              <div className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm">
                <p className="font-medium text-warning">This is taking longer than usual</p>
                <p className="mt-1 text-ink">
                  Your payment has not been lost. It will be confirmed automatically, and you will
                  get an email when it is. You can safely leave this page and check your order.
                </p>
                <Link
                  to={`/account/orders/${currentOrder.id}`}
                  className="mt-2 inline-block font-semibold text-ink underline underline-offset-2"
                >
                  View the order
                </Link>
              </div>
            )}
          </div>
        )}

        {/* --- Not paid ----------------------------------------------------- */}
        {phase === 'unpaid' && message !== null && (
          <div
            role="alert"
            className="mt-6 rounded-md border border-warning/30 bg-warning-soft px-4 py-3 text-sm"
          >
            <p className="font-medium text-warning">Payment not completed</p>
            <p className="mt-1 text-ink">{message}</p>
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

            <Link
              to={`/account/orders/${currentOrder.id}`}
              className="inline-flex h-10 w-full items-center justify-center rounded-md border border-border-strong bg-surface text-sm font-medium text-ink hover:bg-surface-sunken"
            >
              Pay later — view the order
            </Link>
          </div>
        )}

        {(phase === 'opening' || phase === 'in-provider') && (
          <div className="mt-6 flex items-center justify-center gap-2 py-4 text-sm text-ink-muted">
            <Spinner />
            <span role="status">
              {phase === 'opening' ? 'Opening the secure payment window…' : 'Waiting for you to finish paying…'}
            </span>
          </div>
        )}

        <p className="mt-6 border-t border-border pt-4 text-xs text-ink-subtle">
          Card details are entered on our payment provider&rsquo;s own secure page and never reach
          this site. We only ever learn that a payment succeeded, never how it was made.
        </p>
      </div>

      <div className="mt-4 text-center">
        <button
          type="button"
          onClick={() => {
            void navigate('/cart');
          }}
          className="text-sm text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          Back to the cart
        </button>
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
