/**
 * Order queue.
 *
 * Money columns show the grand total and, separately, what has actually been
 * paid. They are not the same number until a verified payment says so, and an
 * order queue that shows only the total is how unpaid orders get shipped.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, Card, Input, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber, humanise } from '@/lib/format';
import { ORDER_STATUSES, orderStatusTone } from '@/lib/orders';
import type { OrderListItem, OrderListResponse } from '@/lib/orders';

export function OrdersPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';
  const source = searchParams.get('source') ?? '';
  const q = searchParams.get('q') ?? '';

  const [searchText, setSearchText] = useState(q);

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
        <div>
          <p className="text-ink">{row.customer?.fullName ?? '—'}</p>
          {row.customer?.organization !== null && row.customer?.organization !== undefined && (
            <p className="text-xxs text-ink-subtle">{row.customer.organization}</p>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={orderStatusTone(row.status)}>{humanise(row.status)}</Badge>,
    },
    {
      key: 'total',
      header: 'Total',
      align: 'right',
      render: (row) => formatMoney(row.totals.grandTotal),
    },
    {
      key: 'paid',
      header: 'Paid',
      align: 'right',
      render: (row) => {
        const isSettled = BigInt(row.totals.paid.minor) >= BigInt(row.totals.grandTotal.minor);
        const isUnpaid = row.totals.paid.minor === '0';

        return (
          <span
            className={
              isSettled ? 'text-success' : isUnpaid ? 'text-ink-subtle' : 'font-medium text-warning'
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
      render: (row) => (
        <span className="whitespace-nowrap">{formatDateTime(row.placedAt ?? row.createdAt)}</span>
      ),
    },
  ];

  return (
    <>
      <PageHeader title="Orders" description="Total is what was ordered. Paid is what actually arrived." />

      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-border px-4 py-3">
          <label className="min-w-56 flex-1">
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Search
            </span>
            <Input
              type="search"
              value={searchText}
              placeholder="Order number or customer"
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
            />
          </label>

          <label>
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Status
            </span>
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
          </label>

          <label>
            <span className="mb-1 block text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
              Source
            </span>
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
          </label>
        </div>

        <DataTable
          caption="Orders"
          columns={columns}
          rows={query.data?.orders}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          error={query.isError ? query.error : undefined}
          onRetry={() => {
            void query.refetch();
          }}
          onRowClick={(row) => {
            void navigate(`/orders/${row.id}`);
          }}
          emptyTitle={status === '' && q === '' ? 'No orders yet' : 'Nothing matches these filters'}
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
