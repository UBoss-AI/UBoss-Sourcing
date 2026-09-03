/**
 * Order placed.
 *
 * Reached after checkout when there is nothing more for the customer to do
 * right now — a payment-link order, or one waiting for approval.
 *
 * The heading never says "paid". It says the order was placed, and then states
 * the order's actual status as the backend reports it. On a payment-link order
 * that status is Pending payment, and pretending otherwise would be the single
 * most damaging thing this page could do.
 *
 * The emailed payment token is never shown here, and the customer order API
 * carries no payment-link detail at all — the link exists only in the
 * approver's inbox. This page says a link was sent, and nothing more, which is
 * exactly what makes emailing it a safe way to delegate payment.
 */
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { Badge, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, humanise } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderDetail } from '@/lib/types';

/** What happens next, in the customer's terms, per order status. */
function nextStepFor(order: OrderDetail): { title: string; body: string } {
  if (order.status === 'PENDING_APPROVAL') {
    return {
      title: 'Waiting for approval',
      body: 'Your order has gone to your approver. Once they approve it, we will confirm it and arrange payment. You will get an email at each step.',
    };
  }

  if (order.status === 'PENDING_PAYMENT' && order.paymentMode === 'PAYMENT_LINK') {
    return {
      title: 'Payment link sent',
      body: 'A secure payment link has been emailed to the address you chose. The order is confirmed once the payment goes through — you will get an email when that happens.',
    };
  }

  if (order.status === 'PENDING_PAYMENT') {
    return {
      title: 'Awaiting payment',
      body: 'Your order is saved and waiting for payment. You can pay from the order page whenever you are ready.',
    };
  }

  if (order.status === 'CONFIRMED') {
    return {
      title: 'Confirmed',
      body: 'Payment has been received and your order is confirmed. We will let you know when it ships.',
    };
  }

  return {
    title: humanise(order.status),
    body: 'We will email you as your order progresses.',
  };
}

export function OrderConfirmationPage(): React.JSX.Element {
  const { orderId } = useParams<{ orderId: string }>();
  const location = useLocation();
  const { business } = useStorefront();

  const wasReplayed = (location.state as { replayed?: boolean } | null)?.replayed === true;

  useDocumentMeta({ title: 'Order placed', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['order', orderId],
    queryFn: () => api.get<{ order: OrderDetail }>(`/orders/${String(orderId)}`),
    enabled: orderId !== undefined,
  });

  if (query.isPending) return <LoadingState label="Loading your order" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const order = query.data.order;
  const next = nextStepFor(order);
  const awaitingLinkPayment =
    order.status === 'PENDING_PAYMENT' && order.paymentMode === 'PAYMENT_LINK';

  return (
    <div className="mx-auto max-w-2xl py-8">
      {wasReplayed && (
        <div
          role="status"
          className="mb-5 rounded-md border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-brand"
        >
          This order had already been placed — we have not created a second one.
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-6 text-center">
        <span
          aria-hidden="true"
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2.5">
            <path d="m5 13 4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>

        {/* Deliberately "placed", never "paid". What is actually true about
            payment is stated below, from the order's own status. */}
        <h1 className="mt-4 text-2xl font-semibold tracking-tight text-ink">
          Your order has been placed
        </h1>
        <p className="mt-2 text-sm text-ink-muted">
          Order <span className="font-mono font-medium text-ink">{order.orderNumber}</span> ·{' '}
          {formatDateTime(order.placedAt ?? order.createdAt)}
        </p>

        <div className="mt-4 flex justify-center">
          <Badge
            tone={
              order.status === 'CONFIRMED'
                ? 'success'
                : order.status === 'PENDING_PAYMENT' || order.status === 'PENDING_APPROVAL'
                  ? 'warning'
                  : 'neutral'
            }
          >
            {humanise(order.status)}
          </Badge>
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-base font-semibold text-ink">{next.title}</h2>
        <p className="mt-1.5 text-sm text-ink-muted">{next.body}</p>

        {awaitingLinkPayment && (
          <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm">
            <p className="text-ink">
              The link is time-limited, so it is worth paying it soon. If it expires before anyone
              acts on it, contact us and we will send a new one.
            </p>
            {/* The token is never rendered here and is not in any account API —
                it exists only inside that email, which is what makes emailing
                it a safe way to delegate payment. */}
            <p className="mt-2 text-xs text-ink-subtle">
              For security the link appears only in that email. We cannot show it here, and neither
              can anyone signed in to this account.
            </p>
          </div>
        )}
      </div>

      <div className="mt-4 rounded-lg border border-border bg-surface p-6">
        <h2 className="text-base font-semibold text-ink">What you ordered</h2>

        <ul className="mt-3 divide-y divide-border text-sm">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-4 py-2.5">
              <span className="min-w-0">
                <span className="block text-ink">{item.name}</span>
                <span className="text-xs text-ink-muted">
                  {item.quantity} × {formatMoney(item.unitPrice)}
                </span>
              </span>
              <span className="shrink-0 tabular text-ink">{formatMoney(item.lineTotal)}</span>
            </li>
          ))}
        </ul>

        <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-ink-muted">Subtotal</dt>
            <dd className="tabular text-ink">{formatMoney(order.totals.subtotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-muted">Tax</dt>
            <dd className="tabular text-ink">{formatMoney(order.totals.tax)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-muted">Delivery</dt>
            <dd className="tabular text-ink">{formatMoney(order.totals.shipping)}</dd>
          </div>
          <div className="flex justify-between border-t border-border pt-1.5 text-base font-semibold">
            <dt>Total</dt>
            <dd className="tabular">{formatMoney(order.totals.grandTotal)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-ink-muted">Paid so far</dt>
            <dd
              className={`tabular ${
                BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor)
                  ? 'text-success'
                  : 'text-warning'
              }`}
            >
              {formatMoney(order.totals.paid)}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <Link
          to={`/account/orders/${order.id}`}
          className="inline-flex h-11 items-center rounded-md bg-brand px-5 text-sm font-medium text-white hover:bg-brand-hover"
        >
          Track this order
        </Link>
        <Link
          to="/products"
          className="inline-flex h-11 items-center rounded-md border border-border-strong bg-surface px-5 text-sm font-medium text-ink hover:bg-surface-sunken"
        >
          Keep shopping
        </Link>
      </div>
    </div>
  );
}
