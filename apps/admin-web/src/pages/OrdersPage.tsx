/**
 * Order queue.
 *
 * Two status columns, kept apart on purpose. **Fulfilment** is where the order
 * is in the state machine; **payment** is whether the money arrived. They move
 * independently — a CONFIRMED order can be unpaid, a PENDING_PAYMENT one can
 * be part paid — and collapsing them into a single "status" is how unpaid
 * orders get shipped.
 *
 * Money columns show the grand total and, separately, what has actually been
 * paid. They are not the same number until a verified payment says so.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Card,
  Input,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber, humanise } from '@/lib/format';
import { ORDER_STATUSES, orderStatusTone } from '@/lib/orders';
import type { OrderListItem, OrderListResponse, OrderTotals } from '@/lib/orders';

/**
 * Where the money is, in one word.
 *
 * Derived from the two amounts already in the row rather than from a new
 * field: the backend's truth about payment is the totals, and a second
 * opinion computed here could only ever disagree with it.
 */
function paymentState(totals: OrderTotals): { label: string; tone: BadgeTone } {
  const paid = BigInt(totals.paid.minor);
  const due = BigInt(totals.grandTotal.minor);
  const refunded = BigInt(totals.refunded.minor);

  if (refunded > 0n) return { label: refunded >= paid ? 'Refunded' : 'Part refunded', tone: 'danger' };
  if (paid <= 0n) return { label: 'Unpaid', tone: 'neutral' };
  if (paid >= due) return { label: 'Paid', tone: 'success' };
  return { label: 'Part paid', tone: 'warning' };
}

export function OrdersPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';
  const source = searchParams.get('source') ?? '';
  const q = searchParams.get('q') ?? '';

  const [searchText, setSearchText] = useState(q);

  const hasFilters = status !== '' || source !== '' || q !== '';

  useEffect(() => {
    setSearchText(q);
  }, [q]);

  useEffect(() => {
    if (searchText === q) return undefined;

    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (searchText === '') next.delete('q');
          else next.set('q', searchText);
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchText, q, setSearchParams]);

  const setParam = (key: string, value: string): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '') next.delete(key);
      else next.set(key, value);
      next.delete('page');
      return next;
    });
  };

  const query = useQuery({
    queryKey: ['orders', { page, status, source, q }],
    queryFn: () =>
      api.get<OrderListResponse>('/admin/orders', {
        query: {
          page,
          limit: 25,
          status: status === '' ? undefined : status,
          source: source === '' ? undefined : source,
          q: q === '' ? undefined : q,
        },
      }),
  });

  const columns: Column<OrderListItem>[] = [
    {
      key: 'order',
      header: 'Order',
      nowrap: true,
      render: (row) => (
        <div>
          <Link
            to={`/orders/${row.id}`}
            className="font-mono font-medium text-ink hover:text-accent hover:underline"
          >
            {row.orderNumber}
          </Link>
          <p className="text-xxs text-ink-subtle">
            {formatNumber(row.itemCount)} item{row.itemCount === 1 ? '' : 's'}
            {row.source === 'RECURRING' && ' · recurring'}
          </p>
        </div>
      ),
    },
    {
      key: 'customer',
      header: 'Customer',
      render: (row) => (
        <div className="min-w-40">
          <p className="text-ink">{row.customer?.fullName ?? '—'}</p>
          {row.customer?.organization !== null && row.customer?.organization !== undefined && (
            <p className="truncate text-xxs text-ink-subtle">{row.customer.organization}</p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Fulfilment',
      render: (row) => (
        <Badge dot tone={orderStatusTone(row.status)}>
          {humanise(row.status)}
        </Badge>
      ),
    },
    {
      key: 'payment',
      header: 'Payment',
      render: (row) => {
        const state = paymentState(row.totals);
        return (
          <Badge dot tone={state.tone}>
            {state.label}
          </Badge>
        );
      },
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      nowrap: true,
      render: (row) => formatMoney(row.totals.grandTotal),
    },
    {
      key: 'paid',
      header: 'Paid',
      align: 'right',
      nowrap: true,
      render: (row) => {
        const paid = BigInt(row.totals.paid.minor);
        const due = BigInt(row.totals.grandTotal.minor);

        return (
          <span
            className={
              paid >= due
                ? 'text-success'
                : paid <= 0n
                  ? 'text-ink-subtle'
                  : 'font-medium text-warning'
            }
          >
            {formatMoney(row.totals.paid)}
          </span>
        );
      },
    },
    {
      key: 'placed',
      header: 'Placed',
      secondary: true,
      nowrap: true,
      render: (row) => (
        <span className="text-ink-muted">{formatDateTime(row.placedAt ?? row.createdAt)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Orders"
        description="Fulfilment and payment are separate columns because they move separately. Total is what was ordered; paid is what actually arrived."
      />

      <Card>
        <Toolbar>
          <ToolbarField label="Search" grow>
            <Input
              type="search"
              value={searchText}
              placeholder="Order number or customer"
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label="Fulfilment status">
            <Select
              value={status}
              onChange={(event) => {
                setParam('status', event.target.value);
              }}
              className="w-48"
            >
              <option value="">Any status</option>
              {ORDER_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {humanise(value)}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label="Source">
            <Select
              value={source}
              onChange={(event) => {
                setParam('source', event.target.value);
              }}
              className="w-40"
            >
              <option value="">Any source</option>
              <option value="WEB">Website</option>
              <option value="RECURRING">Recurring</option>
              <option value="ADMIN">Created by staff</option>
            </Select>
          </ToolbarField>

          {hasFilters && (
            <ToolbarActions>
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Clear filters
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        <DataTable
          caption="Orders"
          columns={columns}
          rows={query.data?.orders}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading orders"
          minWidth="64rem"
          onRetry={() => {
            void query.refetch();
          }}
          onRowClick={(row) => {
            void navigate(`/orders/${row.id}`);
          }}
          emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No orders yet'}
          emptyDescription={
            hasFilters
              ? 'Widen the search, or clear the filters to see the whole queue.'
              : 'Orders appear here as customers place them.'
          }
          emptyAction={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                Clear filters
              </Button>
            ) : undefined
          }
        />

        {query.data !== undefined && (
          <Pager
            page={query.data.pagination.page}
            limit={query.data.pagination.limit}
            total={query.data.pagination.total}
            totalPages={query.data.pagination.totalPages}
            onPageChange={(next) => {
              setSearchParams((current) => {
                const params = new URLSearchParams(current);
                params.set('page', String(next));
                return params;
              });
            }}
          />
        )}
      </Card>
    </>
  );
}
