/**
 * Dashboard.
 *
 * One request fills the whole page - `GET /admin/dashboard` returns sales,
 * orders by status, payments, low stock, recurring and alerts together. Six
 * separate panel requests would show six independent spinners and six chances
 * to disagree about the reporting window.
 *
 * The window is in the URL, not in component state. An administrator who wants
 * to send someone "last week's numbers" sends the address bar.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, Card, ErrorState, LoadingState, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatMoney, formatNumber, humanise, minorToMajor } from '@/lib/format';
import type { BadgeTone } from '@/components/ui';
import type { DashboardResponse, LowStockItem, OrdersByStatusRow, UpcomingOccurrence } from '@/lib/types';

/** Named windows, so the common cases are one click and not a date picker. */
const WINDOWS = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last 12 months' },
] as const;

function windowRange(days: number): { from: string; to: string } {
  const to = new Date();
  const from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * Status colour.
 *
 * Colour is a second channel here, never the only one - every badge also
 * carries its text, so the meaning survives a monochrome screen and the eight
 * percent of men who cannot separate red from green.
 */
function orderStatusTone(status: string): BadgeTone {
  if (status === 'DELIVERED' || status === 'CONFIRMED') return 'success';
  if (status === 'CANCELLED' || status === 'PAYMENT_FAILED') return 'danger';
  if (status === 'PENDING_PAYMENT' || status === 'PENDING_APPROVAL') return 'warning';
  return 'neutral';
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3.5 shadow-card">
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{label}</p>
      <p className="mt-1.5 text-xl font-semibold tabular tracking-tight text-ink">{value}</p>
      {sub !== undefined && <p className="mt-0.5 text-xs text-ink-muted">{sub}</p>}
    </div>
  );
}

/**
 * The alert strip.
 *
 * Rendered only when something is actually wrong. A permanent row of green
 * ticks trains people to stop looking at it, and then the one red item that
 * matters is invisible too.
 */
function Alerts({ alerts }: { alerts: DashboardResponse['alerts'] }): React.JSX.Element | null {
  const items = [
    {
      count: alerts.rejectedWebhooks,
      label: 'webhook deliveries rejected',
      detail: 'A rejected webhook means a signature did not verify. Check the gateway secret.',
      to: '/payments',
    },
    {
      count: alerts.unreconciledPayments,
      label: 'payments not reconciled',
      detail: 'The gateway and this system disagree about these payments.',
      to: '/payments',
    },
    {
      count: alerts.schedulesNeedingAttention,
      label: 'recurring schedules need attention',
      detail: 'These schedules have stopped producing orders.',
      to: '/recurring',
    },
    {
      count: alerts.failedNotifications,
      label: 'notifications failed to send',
      detail: 'Customers were not told about something they should have been.',
      to: null,
    },
    {
      count: alerts.deadJobs,
      label: 'background jobs gave up',
      detail: 'A job exhausted its retries. The work it represents did not happen.',
      to: null,
    },
  ].filter((item) => item.count > 0);

  if (items.length === 0) return null;

  return (
    <div className="mb-5 space-y-2">
      {items.map((item) => (
        <div
          key={item.label}
          role="status"
          className="flex flex-wrap items-baseline gap-x-2 gap-y-1 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm"
        >
          <span className="font-semibold text-warning">
            {formatNumber(item.count)} {item.label}
          </span>
          <span className="text-ink-muted">{item.detail}</span>
          {item.to !== null && (
            <Link to={item.to} className="font-medium text-accent underline underline-offset-2">
              Open
            </Link>
          )}
        </div>
      ))}
    </div>
  );
}

export function DashboardPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const days = Number(searchParams.get('days') ?? '30');
  const range = useMemo(() => windowRange(Number.isFinite(days) && days > 0 ? days : 30), [days]);

  const query = useQuery({
    queryKey: ['dashboard', range.from, range.to],
    queryFn: () => api.get<DashboardResponse>('/admin/dashboard', { query: range }),
  });

  const statusColumns: Column<OrdersByStatusRow>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={orderStatusTone(row.status)}>{humanise(row.status)}</Badge>,
    },
    { key: 'count', header: 'Orders', align: 'right', render: (row) => formatNumber(row.count) },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      render: (row) =>
        formatMoney({
          minor: row.value,
          formatted: minorToMajor(row.value),
          currency: query.data?.sales.currency ?? 'INR',
        }),
    },
  ];

  const lowStockColumns: Column<LowStockItem>[] = [
    {
      key: 'name',
      header: 'Product',
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.name}</p>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku}</p>
        </div>
      ),
    },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      render: (row) => (
        <span className={row.availableQty <= 0 ? 'font-semibold text-danger' : 'text-ink'}>
          {formatNumber(row.availableQty)}
        </span>
      ),
    },
    {
      key: 'threshold',
      header: 'Reorder at',
      align: 'right',
      secondary: true,
      render: (row) => formatNumber(row.reorderThreshold),
    },
  ];

  const upcomingColumns: Column<UpcomingOccurrence>[] = [
    {
      key: 'name',
      header: 'Schedule',
      render: (row) => (
        <div>
          <p className="font-medium text-ink">{row.name}</p>
          <p className="text-xxs text-ink-subtle">{row.customerName ?? 'Unknown customer'}</p>
        </div>
      ),
    },
    { key: 'next', header: 'Next run', render: (row) => formatDateTime(row.nextRunAt) },
    {
      key: 'mode',
      header: 'Payment',
      secondary: true,
      render: (row) => <Badge>{humanise(row.paymentMode)}</Badge>,
    },
  ];

  const sales = query.data?.sales;

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Sales, orders and anything that needs attention."
        actions={
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <span className="sr-only sm:not-sr-only">Period</span>
            <Select
              value={String(days)}
              onChange={(event) => {
                setSearchParams({ days: event.target.value }, { replace: true });
              }}
              className="w-40"
            >
              {WINDOWS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
        }
      />

      {query.isError && (
        <Card>
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </Card>
      )}

      {query.isPending && (
        <Card>
          <LoadingState label="Loading the dashboard" />
        </Card>
      )}

      {query.data !== undefined && (
        <>
          <Alerts alerts={query.data.alerts} />

          <div className="mb-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label="Orders" value={formatNumber(sales?.orderCount ?? 0)} />
            <StatCard
              label="Gross sales"
              value={formatMoney(sales?.grossSales)}
              sub={`incl. ${formatMoney(sales?.tax)} tax`}
            />
            <StatCard
              label="Collected"
              value={formatMoney(sales?.collected)}
              sub="Verified payments only"
            />
            <StatCard
              label="Net revenue"
              value={formatMoney(sales?.netRevenue)}
              sub={`after ${formatMoney(sales?.refunded)} refunded`}
            />
            <StatCard label="Average order" value={formatMoney(sales?.averageOrderValue)} />
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <Card
              title="Orders by status"
              description="Where every order in this period currently sits."
            >
              <DataTable
                caption="Orders by status"
                columns={statusColumns}
                rows={query.data.ordersByStatus}
                rowKey={(row) => row.status}
                emptyTitle="No orders in this period"
              />
            </Card>

            <Card
              title="Low stock"
              description="Available quantity at or below the reorder threshold."
              actions={
                <Link
                  to="/inventory"
                  className="text-xs font-medium text-accent underline underline-offset-2"
                >
                  Open inventory
                </Link>
              }
            >
              <DataTable
                caption="Low stock"
                columns={lowStockColumns}
                rows={query.data.lowStock.items}
                rowKey={(row) => `${row.productId}:${row.variantId ?? ''}`}
                emptyTitle="Nothing is running low"
                emptyDescription="Every tracked product is above its reorder threshold."
              />
            </Card>

            <Card
              title="Upcoming recurring orders"
              description="The next scheduled run for each active schedule."
              actions={
                <Link
                  to="/recurring"
                  className="text-xs font-medium text-accent underline underline-offset-2"
                >
                  Open schedules
                </Link>
              }
            >
              <DataTable
                caption="Upcoming recurring orders"
                columns={upcomingColumns}
                rows={query.data.recurring.upcoming}
                rowKey={(row) => row.scheduleId}
                emptyTitle="No upcoming runs"
                emptyDescription="No active schedule has a run due."
              />
            </Card>

            <Card title="Payments" description="Money that actually moved in this period.">
              <dl className="grid grid-cols-2 gap-px bg-border">
                {[
                  ['Captured', query.data.payments.captured],
                  ['Refunded', query.data.payments.refunded],
                  ['Failed', query.data.payments.failed],
                ].map(([label, minor]) => (
                  <div key={label} className="bg-surface px-4 py-3">
                    <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      {label}
                    </dt>
                    <dd className="mt-1 text-sm font-medium tabular text-ink">
                      {formatMoney({
                        minor: minor ?? '0',
                        formatted: minorToMajor(minor ?? '0'),
                        currency: query.data.payments.currency,
                      })}
                    </dd>
                  </div>
                ))}
                <div className="bg-surface px-4 py-3">
                  <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                    Refunds issued
                  </dt>
                  <dd className="mt-1 text-sm font-medium tabular text-ink">
                    {formatNumber(query.data.payments.refundCount)}
                  </dd>
                </div>
              </dl>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
