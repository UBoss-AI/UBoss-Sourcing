/**
 * One order, as its customer sees it.
 *
 * Three things this page is careful about:
 *
 *   - **Item names are snapshots.** They are what the product was called when
 *     the order was placed. A rename or a reprice afterwards must not rewrite
 *     history, so nothing here re-reads the catalogue.
 *   - **Cancellation is the server's decision.** This page offers the button
 *     and shows the server's refusal if the policy says no. It does not carry
 *     its own copy of "cancellable until dispatch", which would drift.
 *   - **Reorder never reuses historical prices.** It adds the same products to
 *     a fresh cart at today's prices, and says so — a customer who expects the
 *     old total and gets a new one has been misled by the button.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  ButtonLink,
  ErrorState,
  Field,
  LoadingState,
  Textarea,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { GrandTotalRow, TotalRow } from '@/components/Totals';
import { CheckIcon, DotIcon, RepeatIcon } from '@/components/icons';
import { ApiError, api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { orderStatusExplanation, orderStatusLabel, orderStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderAddress, OrderDetail } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

function AddressBlock({
  title,
  address,
}: {
  title: string;
  address: OrderAddress | null;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div>
      <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {address === null ? (
        <p className="mt-1 text-sm text-ink-muted">{t('orderDetail.notProvided')}</p>
      ) : (
        <address className="mt-1 text-sm not-italic text-ink">
          {address.contactName !== null && <div className="font-medium">{address.contactName}</div>}
          <div>{address.line1}</div>
          {address.line2 !== null && <div>{address.line2}</div>}
          <div>
            {address.city}
            {address.state !== null && `, ${address.state}`} {address.postalCode}
          </div>
          <div>{address.country}</div>
          {address.contactPhone !== null && (
            <div className="mt-1 text-ink-muted">{address.contactPhone}</div>
          )}
        </address>
      )}
    </div>
  );
}

export function OrderDetailPage(): React.JSX.Element {
  const { t } = useI18n();

  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { business } = useStorefront();

  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['order', id],
    queryFn: () => api.get<{ order: OrderDetail }>(`/orders/${String(id)}`),
    enabled: id !== undefined,
  });

  useDocumentMeta(
    { title: query.data?.order.orderNumber ?? 'Order', noIndex: true },
    business.displayName,
  );

  const cancel = useMutation({
    mutationFn: () => api.post(`/orders/${String(id)}/cancel`, { reason: cancelReason.trim() }),
    onSuccess: async () => {
      setIsCancelling(false);
      setCancelError(null);
      toast.success('Your order has been cancelled.');
      await queryClient.invalidateQueries({ queryKey: ['order', id] });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => {
      // The policy lives on the server. Its refusal explains itself — "an
      // order cannot be cancelled once it has shipped" — and repeating that
      // rule here would be a second copy waiting to drift.
      setCancelError(
        error instanceof ApiError ? error.message : 'This order could not be cancelled.',
      );
    },
  });

  const reorder = useMutation({
    mutationFn: async () => {
      const order = query.data?.order;
      if (order === undefined) return;

      // Added one at a time at *today's* price. The server prices every add,
      // so a reorder cannot resurrect a historical price even by accident.
      //
      // A product that has since been unpublished, or whose rules changed, is
      // refused here — which is the right outcome, and why the failure message
      // says some items may no longer be available.
      for (const item of order.items) {
        await api.post('/cart/items', {
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cart'] });
      toast.success('Added to your cart at current prices.');
      void navigate('/cart');
    },
    onError: (error) => {
      toast.error(
        error instanceof ApiError
          ? error.message
          : 'Some items could not be added. They may no longer be available.',
      );
      void queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
  });

  if (query.isPending) return <LoadingState label={t('orderDetail.loadingYourOrder')} />;

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
  const explanation = orderStatusExplanation(order.status, order.paymentMode);
  const isSettled = BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor);
  const canPayNow = order.status === 'PENDING_PAYMENT' && order.paymentMode !== 'PAYMENT_LINK';

  return (
    <>
      <nav aria-label={t('orderDetail.breadcrumb')} className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-muted">
          <li>
            <Link to="/account/orders" className="hover:text-brand hover:underline">
              {t('orderDetail.yourOrders')}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="font-mono font-medium text-ink" aria-current="page">
            {order.orderNumber}
          </li>
        </ol>
      </nav>

      {/* Same silhouette as `PageHeader`, with a monospace title: an order
          number is a reference to be read back digit by digit, and a
          proportional face makes 1 and l the same glyph. */}
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="font-mono text-title-xl text-ink">{order.orderNumber}</h1>
          <p className="mt-2 text-sm text-ink-muted">
            Placed {formatDateTime(order.placedAt ?? order.createdAt)}
          </p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {order.source === 'RECURRING' && (
            <Badge tone="operational">
              <RepeatIcon className="h-3 w-3" />
              {t('orderDetail.fromARepeatPurchase')}
            </Badge>
          )}
          <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
        </div>
      </header>

      {/*
       * Status, then the one action that status implies, in one panel.
       *
       * They were two stacked blocks with a gap between them, which read as
       * two unrelated announcements — a sentence about waiting for payment,
       * and separately, an orange button.
       */}
      {(explanation !== null || canPayNow) && (
        <div
          role="status"
          className="mb-6 flex flex-wrap items-center justify-between gap-x-6 gap-y-3 rounded-lg border border-border bg-surface p-4 shadow-card"
        >
          {explanation !== null && (
            <p className="min-w-0 max-w-prose text-sm text-ink">{explanation}</p>
          )}

          {canPayNow && (
            /* Orange: this one really does take money. */
            <ButtonLink
              to={`/checkout/payment/${order.id}`}
              variant="action"
              size="lg"
              className="shrink-0"
            >
              {t('orderDetail.payForThisOrder')}
            </ButtonLink>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {/* --- Items ------------------------------------------------------ */}
          <section
            aria-labelledby="items-heading"
            className="rounded-lg border border-border bg-surface shadow-card"
          >
            <h2
              id="items-heading"
              className="border-b border-border-subtle px-5 py-4 text-title-sm text-ink"
            >
              {t('orderDetail.items')}
            </h2>

            <ul className="divide-y divide-border-subtle">
              {order.items.map((item) => (
                <li key={item.id} className="flex gap-4 px-5 py-4">
                  {item.imageUrl === null ? (
                    <span
                      aria-hidden="true"
                      className="h-16 w-16 shrink-0 rounded-md border border-border bg-surface-sunken"
                    />
                  ) : (
                    <img
                      src={item.imageUrl}
                      alt=""
                      width={64}
                      height={64}
                      loading="lazy"
                      className="h-16 w-16 shrink-0 rounded-md border border-border bg-surface object-contain p-1"
                    />
                  )}

                  <div className="flex min-w-0 flex-1 flex-wrap justify-between gap-x-4 gap-y-1">
                    <div className="min-w-0">
                      {/* A snapshot from when the order was placed, not a live
                          catalogue lookup. */}
                      <p className="text-title-xs text-ink">{item.name}</p>
                      {item.variantName !== null && (
                        <p className="text-xs text-ink-muted">{item.variantName}</p>
                      )}
                      <p className="mt-0.5 font-mono text-xxs text-ink-subtle">{item.sku}</p>
                    </div>

                    <div className="text-right">
                      <p className="text-sm font-semibold tabular text-ink">
                        {formatMoney(item.lineTotal)}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {formatNumber(item.quantity)} × {formatMoney(item.unitPrice)}
                      </p>
                      <p className="text-xxs text-ink-subtle">incl. {formatMoney(item.tax)} tax</p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {/* The same breakdown component as the cart, checkout and
                confirmation, so a figure keeps its treatment all the way
                through the flow. */}
            <dl className="space-y-2.5 border-t border-border-subtle px-5 py-4 text-sm">
              <TotalRow
                label={t('orderDetail.subtotal')}
                value={formatMoney(order.totals.subtotal)}
              />
              {order.totals.discount.minor !== '0' && (
                <TotalRow
                  label={t('orderDetail.discount')}
                  tone="credit"
                  value={<>−{formatMoney(order.totals.discount)}</>}
                />
              )}
              <TotalRow label={t('orderDetail.tax')} value={formatMoney(order.totals.tax)} />
              <TotalRow
                label={t('orderDetail.delivery')}
                value={formatMoney(order.totals.shipping)}
              />
              <GrandTotalRow
                label={t('orderDetail.total')}
                value={formatMoney(order.totals.grandTotal)}
              />
              <TotalRow
                label={t('orderDetail.paid')}
                tone={isSettled ? 'settled' : 'outstanding'}
                value={formatMoney(order.totals.paid)}
              />
              {order.totals.refunded.minor !== '0' && (
                <TotalRow
                  label={t('orderDetail.refunded')}
                  value={formatMoney(order.totals.refunded)}
                />
              )}
            </dl>
          </section>

          {/* --- Progress --------------------------------------------------- */}
          <section
            aria-labelledby="progress-heading"
            className="rounded-lg border border-border bg-surface shadow-card"
          >
            <h2
              id="progress-heading"
              className="border-b border-border-subtle px-5 py-4 text-title-sm text-ink"
            >
              {t('orderDetail.progress')}
            </h2>

            {/*
             * A timeline, drawn as one.
             *
             * This was a divided list of rows, which said "here are some
             * events" rather than "here is where your order has got to". The
             * rail and the markers turn the same data into a shape you can
             * read at a glance: everything behind you is ticked, the most
             * recent entry — the order's current state — is the filled dot at
             * the bottom, and nothing beyond it is drawn, because the backend
             * has not told us what comes next and this page will not guess.
             */}
            <ol className="px-5 py-4">
              {order.timeline.map((entry, index) => {
                const isLatest = index === order.timeline.length - 1;

                return (
                  <li key={`${entry.at}:${String(index)}`} className="flex gap-3.5">
                    <div className="flex flex-col items-center">
                      <span
                        aria-hidden="true"
                        className={cx(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full border-2',
                          isLatest
                            ? 'border-brand bg-surface text-brand'
                            : 'border-brand bg-brand text-white',
                        )}
                      >
                        {isLatest ? (
                          <DotIcon className="h-3 w-3" />
                        ) : (
                          <CheckIcon className="h-3.5 w-3.5" />
                        )}
                      </span>
                      {!isLatest && <span aria-hidden="true" className="w-0.5 flex-1 bg-border" />}
                    </div>

                    <div className={cx('min-w-0', isLatest ? 'pb-0' : 'pb-5')}>
                      <p
                        className={cx('text-sm', isLatest ? 'font-semibold text-ink' : 'text-ink')}
                      >
                        {orderStatusLabel(entry.to)}
                        {isLatest && <span className="sr-only"> — current status</span>}
                      </p>
                      <p className="mt-0.5 text-xs text-ink-subtle">{formatDateTime(entry.at)}</p>
                      {entry.reason !== null && (
                        <p className="mt-1 text-xs text-ink-muted">{entry.reason}</p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          {/* --- Delivery ---------------------------------------------------- */}
          <section
            aria-labelledby="delivery-heading"
            className="rounded-lg border border-border bg-surface p-5 shadow-card"
          >
            <h2 id="delivery-heading" className="text-title-sm text-ink">
              {t('orderDetail.delivery')}
            </h2>

            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              <AddressBlock
                title={t('orderDetail.deliveryAddress')}
                address={order.shippingAddress}
              />
              <AddressBlock
                title={t('orderDetail.billingAddress')}
                address={order.billingAddress}
              />
            </div>

            {order.shippingMethodName !== null && (
              <p className="mt-4 text-sm text-ink-muted">
                {t('orderDetail.method')}
                <span className="text-ink">{order.shippingMethodName}</span>
              </p>
            )}

            {order.shipments.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  {t('orderDetail.tracking')}
                </h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {order.shipments.map((shipment, index) => (
                    <li key={`${shipment.trackingNumber ?? ''}:${String(index)}`}>
                      <span className="text-ink">{shipment.carrier ?? 'Courier'}</span>
                      {shipment.trackingNumber !== null && (
                        <span className="ml-2 font-mono text-xs text-ink-muted">
                          {shipment.trackingNumber}
                        </span>
                      )}
                      {shipment.trackingUrl !== null && (
                        <a
                          href={shipment.trackingUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="ml-2 font-medium text-brand hover:underline"
                        >
                          {t('orderDetail.trackIt')}
                        </a>
                      )}
                      {shipment.dispatchedAt !== null && (
                        <span className="ml-2 text-xs text-ink-subtle">
                          Dispatched {formatDateTime(shipment.dispatchedAt)}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {order.customerNote !== null && (
              <div className="mt-4 border-t border-border pt-4">
                <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  {t('orderDetail.yourNote')}
                </h3>
                <p className="mt-1 text-sm text-ink">{order.customerNote}</p>
              </div>
            )}
          </section>
        </div>

        {/* --- Actions --------------------------------------------------------- */}
        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 className="text-title-sm text-ink">{t('orderDetail.needSomething')}</h2>

            <div className="mt-3 space-y-2">
              <Button
                fullWidth
                isLoading={reorder.isPending}
                onClick={() => {
                  reorder.mutate();
                }}
              >
                {t('orderDetail.orderTheseAgain')}
              </Button>
              {/* Said plainly, because the alternative is a customer expecting
                  the old total and finding a new one at checkout. */}
              <p className="text-xs text-ink-muted">
                Adds the same products to your cart at today&rsquo;s prices, not the prices on this
                order.
              </p>

              <Button
                fullWidth
                variant="ghost"
                className="mt-2"
                onClick={() => {
                  setCancelError(null);
                  setIsCancelling(true);
                }}
              >
                {t('orderDetail.cancelThisOrder')}
              </Button>
              <p className="text-xs text-ink-muted">{t('orderDetail.whetherAnOrderCanStill')}</p>
            </div>
          </div>

          {order.cancelReason !== null && (
            <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
              <h2 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                {t('orderDetail.cancellationReason')}
              </h2>
              <p className="mt-1 text-sm text-ink">{order.cancelReason}</p>
            </div>
          )}

          {business.supportEmail !== null && (
            <div className="rounded-lg border border-border bg-surface p-5 text-sm shadow-card">
              <h2 className="font-medium text-ink">{t('orderDetail.somethingWrong')}</h2>
              <p className="mt-1 text-ink-muted">
                Email{' '}
                <a
                  href={`mailto:${business.supportEmail}?subject=Order%20${encodeURIComponent(order.orderNumber)}`}
                  className="font-medium text-brand hover:underline"
                >
                  {business.supportEmail}
                </a>{' '}
                quoting {order.orderNumber}.
              </p>
            </div>
          )}
        </aside>
      </div>

      <Modal
        isOpen={isCancelling}
        onClose={() => {
          setIsCancelling(false);
        }}
        title={`Cancel ${order.orderNumber}?`}
        description={t('orderDetail.tellUsWhySoWe')}
        footer={
          <>
            <Button
              onClick={() => {
                setIsCancelling(false);
              }}
              disabled={cancel.isPending}
            >
              {t('orderDetail.keepTheOrder')}
            </Button>
            <Button
              variant="danger"
              disabled={cancelReason.trim() === ''}
              isLoading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
            >
              {t('orderDetail.cancelTheOrder')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">{t('orderDetail.ifYouHaveAlreadyPaid')}</p>

          {cancelError !== null && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              {cancelError}
            </p>
          )}

          <Field label={t('orderDetail.reason')} required>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={3}
                value={cancelReason}
                onChange={(event) => {
                  setCancelReason(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      </Modal>
    </>
  );
}
