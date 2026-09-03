/**
 * Your orders.
 *
 * Two money columns, never one: what the order came to, and what has actually
 * been paid. On a payment-link order those differ for as long as it takes the
 * approver to act, and collapsing them into a single "total" is how a customer
 * comes to believe they have paid for something they have not.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { Badge, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { orderStatusLabel, orderStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderListItem, Pagination } from '@/lib/types';

export function OrdersPage(): React.JSX.Element {
  const { business } = useStorefront();

  useDocumentMeta({ title: 'Your orders', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['orders'],
    queryFn: () =>
      api.get<{ orders: OrderListItem[]; pagination: Pagination }>('/orders', {
        query: { limit: 50 },
      }),
  });

  if (query.isPending) return <LoadingState label="Loading your orders" />;

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

  const orders = query.data.orders;

  if (orders.length === 0) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">No orders yet</h1>
        <p className="mt-3 text-sm text-ink-muted">
          Once you place an order it will appear here, with its progress and delivery details.
        </p>
        <Link
          to="/products"
          className="mt-6 inline-flex h-12 items-center rounded-md bg-action px-6 text-base font-medium text-white hover:bg-action-hover"
        >
          Browse products
        </Link>
      </div>
    );
  }

  return (
    <>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight text-ink">Your orders</h1>

      <ul className="space-y-3">
        {orders.map((order) => {
          const isSettled =
            BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor);

          return (
            <li key={order.id}>
              <Link
                to={`/account/orders/${order.id}`}
                className="block rounded-lg border border-border bg-surface p-4 transition-shadow hover:shadow-lift"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div>
                    <p className="font-mono text-sm font-medium text-ink">{order.orderNumber}</p>
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {formatDateTime(order.placedAt ?? order.createdAt)} ·{' '}
                      {formatNumber(order.itemCount)} item{order.itemCount === 1 ? '' : 's'}
                      {order.source === 'RECURRING' && ' · repeat purchase'}
                    </p>
                  </div>

                  <Badge tone={orderStatusTone(order.status)}>
                    {orderStatusLabel(order.status)}
                  </Badge>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1 border-t border-border pt-3 text-sm">
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Total</dt>
                    <dd className="tabular font-medium text-ink">
                      {formatMoney(order.totals.grandTotal)}
                    </dd>
                  </div>

                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Paid</dt>
                    <dd className={`tabular font-medium ${isSettled ? 'text-success' : 'text-warning'}`}>
                      {formatMoney(order.totals.paid)}
                    </dd>
                  </div>

                  {order.totals.refunded.minor !== '0' && (
                    <div>
                      <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Refunded</dt>
                      <dd className="tabular font-medium text-ink">
                        {formatMoney(order.totals.refunded)}
                      </dd>
                    </div>
                  )}
                </dl>
              </Link>
            </li>
          );
        })}
      </ul>
    </>
  );
}
