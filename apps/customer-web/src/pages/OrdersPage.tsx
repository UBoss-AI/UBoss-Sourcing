/**
 * Your orders.
 *
 * Two money columns, never one: what the order came to, and what has actually
 * been paid. On a payment-link order those differ for as long as it takes the
 * approver to act, and collapsing them into a single "total" is how a customer
 * comes to believe they have paid for something they have not.
 *
 * An order that came from a repeat purchase says so in teal, the app's colour
 * for a standing arrangement. It is a label, not an alarm — the row is not
 * tinted, only the chip.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { PageEmptyState } from '@/components/PageEmptyState';
import { ChevronRightIcon, RepeatIcon } from '@/components/icons';
import { Badge, ButtonLink, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { orderStatusLabel, orderStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { OrderListItem, Pagination } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** One figure in the row's footer. Same shape for total, paid and refunded. */
function Figure({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'settled' | 'outstanding';
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd
        className={`tabular font-medium ${
          tone === 'settled' ? 'text-success' : tone === 'outstanding' ? 'text-warning' : 'text-ink'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

export function OrdersPage(): React.JSX.Element {
  const { t } = useI18n();

  const { business } = useStorefront();

  useDocumentMeta({ title: 'Your orders', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['orders'],
    queryFn: () =>
      api.get<{ orders: OrderListItem[]; pagination: Pagination }>('/orders', {
        query: { limit: 50 },
      }),
  });

  if (query.isPending) return <LoadingState label={t('orders.loadingYourOrders')} />;

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
      <PageEmptyState
        title={t('orders.noOrdersYet')}
        description={t('orders.onceYouPlaceAnOrder')}
        action={
          <ButtonLink to="/products" variant="primary" size="lg">
            {t('orders.browseProducts')}
          </ButtonLink>
        }
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('orders.yourOrders')}
        description={`${formatNumber(orders.length)} order${orders.length === 1 ? '' : 's'}, newest first.`}
      />

      <ul className="space-y-3">
        {orders.map((order) => {
          const isSettled =
            BigInt(order.totals.paid.minor) >= BigInt(order.totals.grandTotal.minor);

          return (
            <li key={order.id}>
              <Link
                to={`/account/orders/${order.id}`}
                className="group block rounded-lg border border-border bg-surface p-4 shadow-card transition-[box-shadow,border-color] hover:border-border-hover hover:shadow-card-hover"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 font-mono text-title-xs text-ink">
                      {order.orderNumber}
                      <ChevronRightIcon className="h-4 w-4 text-ink-subtle transition-transform group-hover:translate-x-0.5" />
                    </p>
                    <p className="mt-1 text-xs text-ink-muted">
                      {formatDateTime(order.placedAt ?? order.createdAt)} ·{' '}
                      {/*
                       * "products", not "items". The API's `itemCount` is
                       * `_count.items` — the number of order *lines*, not the
                       * number of units — so an order of 56 boxes across two
                       * products was being announced here as "2 items", which
                       * the cart had just called 56.
                       */}
                      {formatNumber(order.itemCount)} product
                      {order.itemCount === 1 ? '' : 's'}
                    </p>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {order.source === 'RECURRING' && (
                      <Badge tone="operational">
                        <RepeatIcon className="h-3 w-3" />
                        {t('orders.repeatPurchase')}
                      </Badge>
                    )}
                    <Badge tone={orderStatusTone(order.status)}>
                      {orderStatusLabel(order.status)}
                    </Badge>
                  </div>
                </div>

                <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-1 border-t border-border-subtle pt-3 text-sm">
                  <Figure label={t('orders.total')} value={formatMoney(order.totals.grandTotal)} />
                  <Figure
                    label={t('orders.paid')}
                    value={formatMoney(order.totals.paid)}
                    tone={isSettled ? 'settled' : 'outstanding'}
                  />
                  {order.totals.refunded.minor !== '0' && (
                    <Figure
                      label={t('orders.refunded')}
                      value={formatMoney(order.totals.refunded)}
                    />
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
