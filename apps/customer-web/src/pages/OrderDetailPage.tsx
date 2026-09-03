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
import { Badge, Button, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { Modal } from '@/components/Modal';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { orderStatusExplanation, orderStatusLabel, orderStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderAddress, OrderDetail } from '@/lib/types';

function AddressBlock({
  title,
  address,
}: {
  title: string;
  address: OrderAddress | null;
}): React.JSX.Element {
  return (
    <div>
      <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{title}</h3>
      {address === null ? (
        <p className="mt-1 text-sm text-ink-muted">Not provided</p>
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
  const explanation = orderStatusExplanation(order.status, order.paymentMode);
  const isSettled = BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor);
  const canPayNow = order.status === 'PENDING_PAYMENT' && order.paymentMode !== 'PAYMENT_LINK';

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-muted">
          <li>
            <Link to="/account/orders" className="hover:text-brand hover:underline">
              Your orders
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="font-mono font-medium text-ink" aria-current="page">
            {order.orderNumber}
          </li>
        </ol>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-mono text-2xl font-semibold tracking-tight text-ink">
            {order.orderNumber}
          </h1>
          <p className="mt-1 text-sm text-ink-muted">
            Placed {formatDateTime(order.placedAt ?? order.createdAt)}
            {order.source === 'RECURRING' && ' · from a repeat purchase'}
          </p>
        </div>

        <Badge tone={orderStatusTone(order.status)}>{orderStatusLabel(order.status)}</Badge>
      </div>

      {explanation !== null && (
        <div
          role="status"
          className="mb-6 rounded-lg border border-border bg-surface p-4 text-sm text-ink"
        >
          {explanation}
        </div>
      )}

      {canPayNow && (
        <div className="mb-6">
          <Link
            to={`/checkout/payment/${order.id}`}
            className="inline-flex h-12 items-center rounded-md bg-action px-6 text-base font-medium text-white hover:bg-action-hover"
          >
            Pay for this order
          </Link>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {/* --- Items ------------------------------------------------------ */}
          <section aria-labelledby="items-heading" className="rounded-lg border border-border bg-surface">
            <h2 id="items-heading" className="border-b border-border px-5 py-4 text-base font-semibold text-ink">
              Items
            </h2>

            <ul className="divide-y divide-border">
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
                      <p className="text-sm font-medium text-ink">{item.name}</p>
                      {item.variantName !== null && (
                        <p className="text-xs text-ink-muted">{item.variantName}</p>
                      )}
                      <p className="mt-0.5 font-mono text-xxs text-ink-subtle">{item.sku}</p>
                    </div>

                    <div className="text-right">
                      <p className="text-sm tabular text-ink">{formatMoney(item.lineTotal)}</p>
                      <p className="text-xs text-ink-muted">
                        {formatNumber(item.quantity)} × {formatMoney(item.unitPrice)}
                      </p>
                      <p className="text-xxs text-ink-subtle">
                        incl. {formatMoney(item.tax)} tax
                      </p>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <dl className="space-y-1.5 border-t border-border px-5 py-4 text-sm">
              <div className="flex justify-between">
                <dt className="text-ink-muted">Subtotal</dt>
                <dd className="tabular text-ink">{formatMoney(order.totals.subtotal)}</dd>
              </div>
              {order.totals.discount.minor !== '0' && (
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Discount</dt>
                  <dd className="tabular text-success">−{formatMoney(order.totals.discount)}</dd>
                </div>
              )}
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
                <dt className="text-ink-muted">Paid</dt>
                <dd className={`tabular ${isSettled ? 'text-success' : 'text-warning'}`}>
                  {formatMoney(order.totals.paid)}
                </dd>
              </div>
              {order.totals.refunded.minor !== '0' && (
                <div className="flex justify-between">
                  <dt className="text-ink-muted">Refunded</dt>
                  <dd className="tabular text-ink">{formatMoney(order.totals.refunded)}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* --- Progress --------------------------------------------------- */}
          <section aria-labelledby="progress-heading" className="rounded-lg border border-border bg-surface">
            <h2 id="progress-heading" className="border-b border-border px-5 py-4 text-base font-semibold text-ink">
              Progress
            </h2>

            <ol className="divide-y divide-border">
              {order.timeline.map((entry, index) => (
                <li key={`${entry.at}:${String(index)}`} className="flex flex-wrap gap-x-3 gap-y-1 px-5 py-3">
                  <span className="whitespace-nowrap text-xs text-ink-subtle">
                    {formatDateTime(entry.at)}
                  </span>
                  <span className="text-sm text-ink">{orderStatusLabel(entry.to)}</span>
                  {entry.reason !== null && (
                    <span className="w-full text-xs text-ink-muted">{entry.reason}</span>
                  )}
                </li>
              ))}
            </ol>
          </section>

          {/* --- Delivery ---------------------------------------------------- */}
          <section aria-labelledby="delivery-heading" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="delivery-heading" className="text-base font-semibold text-ink">
              Delivery
            </h2>

            <div className="mt-4 grid gap-6 sm:grid-cols-2">
              <AddressBlock title="Delivery address" address={order.shippingAddress} />
              <AddressBlock title="Billing address" address={order.billingAddress} />
            </div>

            {order.shippingMethodName !== null && (
              <p className="mt-4 text-sm text-ink-muted">
                Method: <span className="text-ink">{order.shippingMethodName}</span>
              </p>
            )}

            {order.shipments.length > 0 && (
              <div className="mt-4 border-t border-border pt-4">
                <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                  Tracking
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
                          Track it
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
                  Your note
                </h3>
                <p className="mt-1 text-sm text-ink">{order.customerNote}</p>
              </div>
            )}
          </section>
        </div>

        {/* --- Actions --------------------------------------------------------- */}
        <aside className="space-y-4 lg:sticky lg:top-40 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5">
            <h2 className="text-base font-semibold text-ink">Need something?</h2>

            <div className="mt-3 space-y-2">
              <Button
                fullWidth
                isLoading={reorder.isPending}
                onClick={() => {
                  reorder.mutate();
                }}
              >
                Order these again
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
                Cancel this order
              </Button>
              <p className="text-xs text-ink-muted">
                Whether an order can still be cancelled depends on how far along it is. We will tell
                you either way.
              </p>
            </div>
          </div>

          {order.cancelReason !== null && (
            <div className="rounded-lg border border-border bg-surface p-5">
              <h2 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                Cancellation reason
              </h2>
              <p className="mt-1 text-sm text-ink">{order.cancelReason}</p>
            </div>
          )}

          {business.supportEmail !== null && (
            <div className="rounded-lg border border-border bg-surface p-5 text-sm">
              <h2 className="font-medium text-ink">Something wrong?</h2>
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
        description="Tell us why, so we can put it right."
        footer={
          <>
            <Button
              onClick={() => {
                setIsCancelling(false);
              }}
              disabled={cancel.isPending}
            >
              Keep the order
            </Button>
            <Button
              variant="danger"
              disabled={cancelReason.trim() === ''}
              isLoading={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
            >
              Cancel the order
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-ink-muted">
            If you have already paid, the refund is arranged separately and we will email you about
            it.
          </p>

          {cancelError !== null && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
            >
              {cancelError}
            </p>
          )}

          <Field label="Reason" required>
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
