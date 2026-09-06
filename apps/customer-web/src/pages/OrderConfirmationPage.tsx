/**
 * Order placed.
 *
 * Reached after checkout when there is nothing more for the customer to do
 * right now — a payment-link order, or one waiting for approval.
 *
 * The heading never says "paid". It says the order was placed, and then states
 * the order's actual status as the backend reports it. On a payment-link order
 * that status is Pending payment, and pretending otherwise would be the single
 * most damaging thing this page could do. The progress indicator obeys the
 * same rule: its Payment step is a tick only when the order is settled, and a
 * dashed "waiting" marker otherwise.
 *
 * The emailed payment token is never shown here, and the customer order API
 * carries no payment-link detail at all — the link exists only in the
 * approver's inbox. This page says a link was sent, and nothing more, which is
 * exactly what makes emailing it a safe way to delegate payment.
 */
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { CheckoutSteps } from '@/components/CheckoutSteps';
import { confirmationSteps } from '@/lib/checkout-steps';
import { GrandTotalRow, TotalRow } from '@/components/Totals';
import { CheckIcon } from '@/components/icons';
import { Badge, ButtonLink, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney } from '@/lib/format';
import { orderStatusLabel, orderStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderDetail } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/**
 * What happens next, in the customer's terms, per order status.
 *
 * `steps` is the sequence still ahead of them. Kept as a list rather than a
 * paragraph because "what do I do now" is a question with an ordered answer,
 * and a customer scanning for their own next move should not have to parse
 * prose to find it.
 */
function nextStepFor(order: OrderDetail): {
  title: string;
  body: string;
  steps: string[];
} {
  if (order.status === 'PENDING_APPROVAL') {
    return {
      title: 'Waiting for approval',
      body: 'Your order has gone to your approver. You will get an email at each step.',
      steps: [
        'Your approver reviews the order.',
        'Once approved, we confirm it and arrange payment.',
        'We email you when it is confirmed, and again when it ships.',
      ],
    };
  }

  if (order.status === 'PENDING_PAYMENT' && order.paymentMode === 'PAYMENT_LINK') {
    return {
      title: 'Payment link sent',
      body: 'A secure payment link has been emailed to the address you chose.',
      steps: [
        'Whoever received the link opens it and pays.',
        'The order is confirmed once that payment goes through.',
        'We email you when it is confirmed, and again when it ships.',
      ],
    };
  }

  if (order.status === 'PENDING_PAYMENT') {
    return {
      title: 'Awaiting payment',
      body: 'Your order is saved and waiting for payment.',
      steps: [
        'Pay from the order page whenever you are ready.',
        'The order is confirmed once the payment is verified.',
        'We email you when it is confirmed, and again when it ships.',
      ],
    };
  }

  if (order.status === 'CONFIRMED') {
    return {
      title: 'Confirmed',
      body: 'Payment has been received and your order is confirmed.',
      steps: ['We pick and pack your order.', 'We email you a tracking link when it ships.'],
    };
  }

  return {
    title: orderStatusLabel(order.status),
    body: 'We will email you as your order progresses.',
    steps: [],
  };
}

export function OrderConfirmationPage(): React.JSX.Element {
  const { t } = useI18n();

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

  if (query.isPending) return <LoadingState label={t('orderConfirmation.loadingYourOrder')} />;

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
  const isSettled = BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor);
  const canPayNow = order.status === 'PENDING_PAYMENT' && order.paymentMode !== 'PAYMENT_LINK';

  return (
    <div className="mx-auto max-w-2xl py-4">
      {/* Payment is a tick only if the money has actually arrived. */}
      <CheckoutSteps
        states={confirmationSteps(isSettled)}
        {...(isSettled ? {} : { notes: { payment: 'Not paid yet' } })}
      />

      {wasReplayed && (
        <div
          role="status"
          className="mb-5 rounded-md border border-brand/30 bg-brand-soft px-4 py-3 text-sm text-brand"
        >
          {t('orderConfirmation.thisOrderHadAlreadyBeen')}
        </div>
      )}

      <div className="rounded-lg border border-border bg-surface p-6 text-center shadow-card">
        <span
          aria-hidden="true"
          className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-success-soft text-success"
        >
          <CheckIcon className="h-6 w-6" />
        </span>

        {/* Deliberately "placed", never "paid". What is actually true about
            payment is stated below, from the order's own status. */}
        <h1 className="mt-4 text-title-xl text-ink">
          {t('orderConfirmation.yourOrderHasBeenPlaced')}
        </h1>

        {/*
         * The reference, given the weight it earns.
         *
         * This is the one string a customer will be asked to quote — on the
         * phone, in an email, to their own finance team — so it is set as a
         * selectable chip in a monospace face rather than as another line of
         * grey metadata they have to hunt for.
         */}
        <p className="mt-4 text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
          {t('orderConfirmation.yourOrderReference')}
        </p>
        <p className="mt-1.5 inline-block select-all rounded-md border border-border bg-surface-sunken px-4 py-2 font-mono text-title-sm text-ink">
          {order.orderNumber}
        </p>
        <p className="mt-2 text-xs text-ink-muted">
          Placed {formatDateTime(order.placedAt ?? order.createdAt)}
        </p>

        <div className="mt-4 flex justify-center">
          <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
        </div>
      </div>

      {/* --- What happens next ----------------------------------------------- */}
      <div className="mt-4 rounded-lg border border-border bg-surface p-6 shadow-card">
        <h2 className="text-title-sm text-ink">{next.title}</h2>
        <p className="mt-1.5 text-sm text-ink-muted">{next.body}</p>

        {next.steps.length > 0 && (
          <ol className="mt-4 space-y-3">
            {next.steps.map((step, index) => (
              <li key={step} className="flex gap-3 text-sm text-ink">
                <span
                  aria-hidden="true"
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xxs font-semibold text-ink-muted"
                >
                  {index + 1}
                </span>
                <span className="min-w-0 leading-relaxed">{step}</span>
              </li>
            ))}
          </ol>
        )}

        {canPayNow && (
          <div className="mt-5">
            {/* Orange: this one really does take money. */}
            <ButtonLink to={`/checkout/payment/${order.id}`} variant="action" size="lg">
              {t('orderConfirmation.payForThisOrder')}
            </ButtonLink>
          </div>
        )}

        {awaitingLinkPayment && (
          <div className="mt-4 rounded-md border border-border bg-surface-sunken p-4 text-sm">
            <p className="text-ink">{t('orderConfirmation.theLinkIsTimeLimited')}</p>
            {/* The token is never rendered here and is not in any account API —
                it exists only inside that email, which is what makes emailing
                it a safe way to delegate payment. */}
            <p className="mt-2 text-xs text-ink-subtle">
              {t('orderConfirmation.forSecurityTheLinkAppears')}
            </p>
          </div>
        )}
      </div>

      {/* --- What you ordered ------------------------------------------------- */}
      <div className="mt-4 rounded-lg border border-border bg-surface p-6 shadow-card">
        <h2 className="text-title-sm text-ink">{t('orderConfirmation.whatYouOrdered')}</h2>

        <ul className="mt-3 divide-y divide-border-subtle text-sm">
          {order.items.map((item) => (
            <li key={item.id} className="flex justify-between gap-4 py-3">
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

        <dl className="mt-4 space-y-2.5 border-t border-border-subtle pt-4 text-sm">
          <TotalRow
            label={t('orderConfirmation.subtotal')}
            value={formatMoney(order.totals.subtotal)}
          />
          {order.totals.discount.minor !== '0' && (
            <TotalRow
              label={t('orderConfirmation.discount')}
              tone="credit"
              value={<>−{formatMoney(order.totals.discount)}</>}
            />
          )}
          <TotalRow label={t('orderConfirmation.tax')} value={formatMoney(order.totals.tax)} />
          <TotalRow
            label={t('orderConfirmation.delivery')}
            value={formatMoney(order.totals.shipping)}
          />
          <GrandTotalRow
            label={t('orderConfirmation.total')}
            value={formatMoney(order.totals.grandTotal)}
          />
          {/* Two figures, never one. What the order came to, and what has
              actually been paid — collapsing them is how somebody comes to
              believe they have paid for something they have not. */}
          <TotalRow
            label={t('orderConfirmation.paidSoFar')}
            tone={isSettled ? 'settled' : 'outstanding'}
            value={formatMoney(order.totals.paid)}
          />
        </dl>
      </div>

      {/* --- Where to go next -------------------------------------------------- */}
      <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
        <ButtonLink to={`/account/orders/${order.id}`} variant="primary" size="lg">
          {t('orderConfirmation.trackThisOrder')}
        </ButtonLink>
        <ButtonLink to="/account/orders" size="lg">
          {t('orderConfirmation.allYourOrders')}
        </ButtonLink>
        <ButtonLink to="/products" size="lg">
          {t('orderConfirmation.keepShopping')}
        </ButtonLink>
      </div>

      <p className="mt-4 text-center text-xs text-ink-muted">
        A copy of this confirmation is on its way to your email.{' '}
        <Link to="/account/orders" className="font-medium text-brand hover:underline">
          {t('orderConfirmation.yourOrderHistory')}
        </Link>{' '}
        always has the latest status.
      </p>
    </div>
  );
}
