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
import { OrderDeliveryLevels } from '@/components/OrderDeliveryLevels';
import { OrderSellerInvoices } from '@/components/OrderSellerInvoices';
import { CheckIcon, DotIcon, RepeatIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import { formatDateTime, formatMoney, formatMoneyMinor, formatNumber } from '@/lib/format';
import {
  SELLER_SELLING_UNIT,
  SELLING_UNIT,
  cartonPriceMinor,
  cartonsOfLine,
} from '@/lib/packaging';
import { orderStatusExplanation, orderStatusLabel, orderStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderAddress, OrderDetail, OrderItem } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

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

/**
 * One line's quantity and unit price, in the unit it was bought in.
 *
 * Cartons and the carton price for anything bought since the shop settled on
 * the carton; pieces and the piece price for the older lines, which keep
 * describing themselves the way they were agreed. Both prints show the piece
 * count, because that is what was picked, shipped and taxed.
 */
function LineQuantity({ item }: { item: OrderItem }): React.JSX.Element {
  const { t } = useI18n();
  const cartons = cartonsOfLine(item.ordering);

  if (cartons === null) {
    return (
      <p className="text-xs text-ink-muted">
        {formatNumber(item.quantity)} × {formatMoney(item.unitPrice)}
      </p>
    );
  }

  return (
    <>
      <p className="text-xs text-ink-muted">
        {t('packaging.nCartons', { count: cartons.cartons })} ×{' '}
        {formatMoneyMinor(
          cartonPriceMinor(item.unitPrice.minor, cartons.piecesPerCarton),
          item.unitPrice.currency,
        )}
      </p>
      <p className="text-xxs tabular text-ink-subtle">
        {t('cart.piecesTotal', { n: formatNumber(item.quantity) })}
      </p>
    </>
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
    { title: query.data?.order.orderNumber ?? t('orderDetail.orderLabel'), noIndex: true },
    business.displayName,
  );

  const cancel = useMutation({
    mutationFn: () => api.post(`/orders/${String(id)}/cancel`, { reason: cancelReason.trim() }),
    onSuccess: async () => {
      setIsCancelling(false);
      setCancelError(null);
      toast.success(t('orderDetail.orderCancelled'));
      await queryClient.invalidateQueries({ queryKey: ['order', id] });
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
    onError: (error) => {
      // The policy lives on the server. Its refusal explains itself — "an
      // order cannot be cancelled once it has shipped" — and repeating that
      // rule here would be a second copy waiting to drift.
      setCancelError(
        errorMessage(t, error, t('orderDetail.couldNotBeCancelled')),
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
        /*
         * The unit the line was BOUGHT in, not the shop's own.
         *
         * A seller's line was bought by the piece, and asking for it by the
         * carton is refused - rightly, because reading it generously would
         * reorder five hundred of something they bought one of. Naming the
         * line's own unit is what makes Reorder work on a marketplace order
         * as well as on the shop's own.
         *
         * A line from before the shop settled on these two units names
         * neither, and says only how many pieces. The server takes that up to
         * whole sell units, which is the documented route for exactly this.
         */
        const ordering = item.ordering ?? null;
        const asBought =
          ordering !== null &&
          (ordering.unit === SELLING_UNIT || ordering.unit === SELLER_SELLING_UNIT)
            ? { orderingUnit: ordering.unit, unitQuantity: ordering.unitQuantity }
            : {};

        await api.post('/cart/items', {
          productId: item.productId,
          variantId: item.variantId,
          ...asBought,
          quantity: item.quantity,
        });
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['cart'] });
      toast.success(t('orderDetail.addedAtCurrentPrices'));
      void navigate('/cart');
    },
    onError: (error) => {
      toast.error(
        errorMessage(t, error, t('orderDetail.someItemsCouldNotBeAdded')),
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
  const explanation = orderStatusExplanation(t, order.status, order.paymentMode);
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
          <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(t, order.status)}</Badge>
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

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
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

                      {/* What they asked for on this line, shown back to them.
                          An instruction somebody cannot re-read on their own
                          order is one they cannot check was received — and
                          this is the screen they open when they ring up to
                          ask whether it was. */}
                      {item.note != null && item.note !== '' && (
                        <div className="mt-1.5 rounded-md border border-border-subtle bg-surface-sunken px-2.5 py-1.5">
                          <p className="text-xxs font-medium uppercase tracking-wide text-ink-subtle">
                            {t('order.lineInstructions')}
                          </p>
                          {/* `whitespace-pre-line`: three lines typed are
                              three lines meant. */}
                          <p className="mt-0.5 whitespace-pre-line text-xs leading-relaxed text-ink">
                            {item.note}
                          </p>
                        </div>
                      )}
                    </div>

                    <div className="text-right">
                      <p className="text-sm font-semibold tabular text-ink">
                        {formatMoney(item.lineTotal)}
                      </p>
                      {/* Counted the way it was ordered, with the pieces under
                          it. An order that said "1,000 × ₹12.50" to somebody
                          who bought two cartons is a dispute nobody can
                          settle; one that said only "2 cartons" cannot be
                          checked against the total beside it. */}
                      <LineQuantity item={item} />
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
              <OrderDeliveryLevels orderId={order.id} />
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
                            : 'border-brand bg-brand-fill text-white',
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
                        {orderStatusLabel(t, entry.to)}
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

            <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-2">
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
                      <span className="text-ink">{shipment.carrier ?? t('orderDetail.courier')}</span>
                      {shipment.deliveryStage !== undefined && (
                        <span className="ml-2 inline-flex rounded-full bg-brand-soft px-2 py-0.5 text-xxs font-medium text-brand">
                          {t(`orderDetail.stage.${shipment.deliveryStage}`)}
                        </span>
                      )}
                      {shipment.sentBy !== null && (
                        <span className="ml-2 text-xs text-ink-muted">
                          {t('orderDetail.sentBy', { seller: shipment.sentBy })}
                        </span>
                      )}
                      {shipment.trackingNumber !== null && (
                        <span className="ml-2 font-mono text-xs text-ink-muted">
                          {shipment.trackingNumber}
                        </span>
                      )}
                      {shipment.carrierTrackingNumber !== undefined &&
                        shipment.carrierTrackingNumber !== null && (
                          <span className="ml-2 text-xs text-ink-muted">
                            {t('orderDetail.carrierTrackingNumber', {
                              number: shipment.carrierTrackingNumber,
                            })}
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

                      {/*
                        Said plainly where updates will NOT appear here on
                        their own - the India Post case, and any carrier
                        followed by hand.

                        A buyer who is not told refreshes this page waiting for
                        movement that was never going to show up on it, and
                        then telephones somebody. One line is cheaper for
                        everybody than that call.
                      */}
                      {shipment.trackingIsAutomatic === false && (
                        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                          {t('orderDetail.trackingByHand')}
                        </p>
                      )}

                      {/* The consignment's own journey, in the words written for the buyer. */}
                      {shipment.events !== undefined && shipment.events.length > 0 && (
                        <ol className="mt-2 space-y-1 border-l border-border pl-3">
                          {shipment.events
                            .filter((event) => event.description !== null)
                            .map((event, eventIndex) => (
                              <li key={`${event.occurredAt}:${String(eventIndex)}`} className="text-xs text-ink-muted">
                                <span className="text-ink-subtle">{formatDateTime(event.occurredAt)}</span>{' '}
                                {event.description}
                              </li>
                            ))}
                        </ol>
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
          {/* The sellers' tax invoices, once issued. Renders nothing before. */}
          <OrderSellerInvoices orderId={order.id} />
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
        title={t('orderDetail.cancelOrderQuestion', { order: order.orderNumber })}
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
