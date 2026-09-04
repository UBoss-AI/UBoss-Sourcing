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
 *
 * What this page is *for*: deciding what to do next. So every panel below the
 * figures is a queue with a way into the screen that fixes it - a status row
 * links to that status filtered on the Orders page, a low-stock row links to
 * that SKU in Inventory. A dashboard that can only be read is a dashboard you
 * stop opening.
 *
 * What it deliberately does not do: trends. The endpoint returns one window's
 * aggregates and nothing about the window before it, so there is no honest
 * "+12% on last month" to draw and none is invented. The proportions that *are*
 * drawn - a status's share of the period's orders, collected against gross -
 * are arithmetic on figures already on the screen, not a second data source.
 */
import { useMemo } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  Metric,
  PageHeader,
  Select,
} from '@/components/ui';
import { AlertCircleIcon, AlertTriangleIcon, ChevronRightIcon, RefreshIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { cx } from '@/lib/cx';
import {
  formatDateTime,
  formatMoney,
  formatNumber,
  formatRelative,
  humanise,
  minorToMajor,
} from '@/lib/format';
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

/**
 * Payment status colour.
 *
 * The three pending-ish states are amber rather than neutral on purpose: a
 * transaction sitting in CREATED, PENDING or AUTHORIZED is money the gateway
 * may believe it has and this system does not, which is the reconciliation
 * queue and not a resting state.
 */
function paymentStatusTone(status: string): BadgeTone {
  if (status === 'CAPTURED') return 'success';
  if (status === 'FAILED' || status === 'CANCELLED' || status === 'EXPIRED') return 'danger';
  if (status === 'CREATED' || status === 'PENDING' || status === 'AUTHORIZED') return 'warning';
  return 'neutral';
}

// ---------------------------------------------------------------------------
// Small visual primitives
// ---------------------------------------------------------------------------

const METER_TONES: Record<BadgeTone, string> = {
  neutral: 'bg-ink-subtle',
  accent: 'bg-accent',
  brand: 'bg-brand',
  action: 'bg-action',
  operational: 'bg-operational',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/**
 * A proportion, as a bar.
 *
 * `aria-hidden`, and unapologetically so: every meter on this page sits beside
 * the two numbers it is drawn from. It is a redundant encoding for the eye,
 * and a screen reader that also read it out would be reading the same fact
 * three times.
 */
function Meter({
  value,
  max,
  tone = 'brand',
  className,
}: {
  value: number;
  max: number;
  tone?: BadgeTone;
  className?: string | undefined;
}): React.JSX.Element {
  const percent = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;

  return (
    <span
      aria-hidden="true"
      className={cx('block h-1.5 overflow-hidden rounded-full bg-border', className)}
    >
      <span className={cx('block h-full rounded-full', METER_TONES[tone])} style={{ width: `${percent}%` }} />
    </span>
  );
}

/** The header action on a queue panel: "here is the whole list". */
function PanelLink({ to, children }: { to: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Link
      to={to}
      className="inline-flex items-center gap-0.5 rounded text-xs font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
    >
      {children}
      <ChevronRightIcon className="h-3.5 w-3.5" />
    </Link>
  );
}

/** The per-row action on a queue panel: "take me to this one". */
function RowLink({ to, label }: { to: string; label: string }): React.JSX.Element {
  return (
    <Link
      to={to}
      className="rounded text-xs font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
    >
      Open<span className="sr-only"> {label}</span>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

type Severity = 'critical' | 'warning';

interface AlertRow {
  key: string;
  severity: Severity;
  count: number;
  /** The thing that happened, in as few words as carry it. */
  title: string;
  /** Why it matters, in one line. */
  detail: string;
  /** Where the work gets done. Null where this panel has no screen for it. */
  to: string | null;
  /** Names the destination for a screen reader, since "Open" alone does not. */
  actionLabel: string;
}

const SEVERITY_STYLES: Record<Severity, { row: string; chip: string; count: string }> = {
  critical: {
    row: 'border-l-2 border-danger',
    chip: 'bg-danger-soft text-danger ring-1 ring-inset ring-danger/25',
    count: 'text-danger',
  },
  warning: {
    row: 'border-l-2 border-warning',
    chip: 'bg-warning-soft text-warning ring-1 ring-inset ring-warning/25',
    count: 'text-warning',
  },
};

/**
 * The alert panel.
 *
 * Rendered only when something is actually wrong. A permanent row of green
 * ticks trains people to stop looking at it, and then the one red item that
 * matters is invisible too.
 *
 * Two severities, not five. Critical means work that did not happen or money
 * this system cannot account for; warning means a queue that needs a person
 * today. Anything finer than that is a taxonomy nobody reads under pressure.
 * The severity is carried by the icon's silhouette as well as its colour -
 * triangle for critical, circle for warning - so it survives a monochrome
 * screen.
 *
 * Two of these have no destination, because the panel has no screen for a
 * dead job or a failed notification. They render without an action rather than
 * with a link that goes somewhere unhelpful: a control that does not lead to
 * the fix is worse than no control.
 */
function Alerts({ alerts }: { alerts: DashboardResponse['alerts'] }): React.JSX.Element | null {
  const all: AlertRow[] = [
    {
      key: 'rejectedWebhooks',
      severity: 'critical',
      count: alerts.rejectedWebhooks,
      title: 'webhook deliveries rejected',
      detail:
        'A signature did not verify, so the gateway event was not applied. Check the webhook secret.',
      to: '/payments',
      actionLabel: 'payments and webhook health',
    },
    {
      key: 'deadJobs',
      severity: 'critical',
      count: alerts.deadJobs,
      title: 'background jobs gave up',
      detail: 'A job exhausted its retries. The work it represents did not happen.',
      to: null,
      actionLabel: '',
    },
    {
      key: 'unreconciledPayments',
      severity: 'warning',
      count: alerts.unreconciledPayments,
      title: 'payments not reconciled',
      detail: 'The gateway and this system disagree about these payments.',
      to: '/payments',
      actionLabel: 'payments',
    },
    {
      key: 'schedulesNeedingAttention',
      severity: 'warning',
      count: alerts.schedulesNeedingAttention,
      title: 'recurring schedules need attention',
      detail: 'These schedules have stopped producing orders.',
      to: '/recurring',
      actionLabel: 'recurring schedules',
    },
    {
      key: 'failedNotifications',
      severity: 'warning',
      count: alerts.failedNotifications,
      title: 'notifications failed to send',
      detail: 'Customers were not told about something they should have been.',
      to: null,
      actionLabel: '',
    },
  ];

  const rows = all.filter((row) => row.count > 0);

  if (rows.length === 0) return null;

  const critical = rows.filter((row) => row.severity === 'critical').length;
  const warnings = rows.length - critical;

  const summary = [
    critical > 0 ? `${critical} critical` : null,
    warnings > 0 ? `${warnings} to review` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');

  return (
    <section
      role="status"
      aria-label="Needs attention"
      className={cx(
        'mb-6 overflow-hidden rounded-lg border bg-surface shadow-card',
        critical > 0 ? 'border-danger/35' : 'border-warning/35',
      )}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-border-subtle px-5 py-3.5">
        <h2 className="text-title-xs text-ink">Needs attention</h2>
        <p className="text-xs font-medium text-ink-muted">{summary}</p>
      </header>

      <ul className="divide-y divide-border-subtle">
        {rows.map((row) => {
          const style = SEVERITY_STYLES[row.severity];
          const SeverityIcon = row.severity === 'critical' ? AlertTriangleIcon : AlertCircleIcon;

          return (
            <li
              key={row.key}
              className={cx('flex flex-wrap items-start gap-x-4 gap-y-2 px-5 py-3.5', style.row)}
            >
              <span
                className={cx(
                  'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
                  style.chip,
                )}
              >
                <SeverityIcon className="h-[1.05rem] w-[1.05rem]" />
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink">
                  <span className={cx('tabular', style.count)}>{formatNumber(row.count)}</span>{' '}
                  {row.title}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{row.detail}</p>
              </div>

              {row.to !== null && (
                <div className="shrink-0 self-center">
                  <RowLink to={row.to} label={row.actionLabel} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * Collected as a share of gross, in percent.
 *
 * BigInt throughout: money arrives as a minor-unit *string* precisely because
 * a paisa-precise total can exceed 2^53, and `Number(minor)` is the bug that
 * string exists to prevent. Only the final ratio - which is between 0 and a
 * few hundred - becomes a Number.
 */
function shareOfMinor(part: string | undefined, whole: string | undefined): number | null {
  if (part === undefined || whole === undefined) return null;

  try {
    const wholeMinor = BigInt(whole);
    if (wholeMinor <= 0n) return null;

    return Number((BigInt(part) * 10_000n) / wholeMinor) / 100;
  } catch {
    return null;
  }
}

export function DashboardPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const days = Number(searchParams.get('days') ?? '30');
  const effectiveDays = Number.isFinite(days) && days > 0 ? days : 30;
  const range = useMemo(() => windowRange(effectiveDays), [effectiveDays]);

  const query = useQuery({
    queryKey: ['dashboard', range.from, range.to],
    queryFn: () => api.get<DashboardResponse>('/admin/dashboard', { query: range }),
  });

  const windowLabel =
    WINDOWS.find((option) => option.value === String(effectiveDays))?.label ??
    `Last ${effectiveDays} days`;

  const sales = query.data?.sales;
  const currency = sales?.currency ?? 'INR';

  /** Minor units, as this endpoint sends them for anything but `Money`. */
  const money = (minor: string | undefined, inCurrency: string): string =>
    formatMoney({ minor: minor ?? '0', formatted: minorToMajor(minor ?? '0'), currency: inCurrency });

  const collectedShare = shareOfMinor(sales?.collected.minor, sales?.grossSales.minor);

  // The denominator for the share column, taken from the rows on screen rather
  // than from `sales.orderCount`: the two are aggregates of different things,
  // and a bar that can exceed its own track is worse than no bar.
  const ordersInStatuses = (query.data?.ordersByStatus ?? []).reduce((sum, row) => sum + row.count, 0);

  const statusColumns: Column<OrdersByStatusRow>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={orderStatusTone(row.status)}>{humanise(row.status)}</Badge>,
    },
    { key: 'count', header: 'Orders', align: 'right', render: (row) => formatNumber(row.count) },
    {
      key: 'share',
      header: 'Share',
      width: '9rem',
      secondary: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <Meter
            value={row.count}
            max={ordersInStatuses}
            tone={orderStatusTone(row.status)}
            className="min-w-0 flex-1"
          />
          <span className="w-9 shrink-0 text-right tabular text-xxs text-ink-subtle">
            {ordersInStatuses > 0 ? Math.round((row.count / ordersInStatuses) * 100) : 0}%
          </span>
        </div>
      ),
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      render: (row) => money(row.value, currency),
    },
    {
      key: 'open',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <RowLink to={`/orders?status=${row.status}`} label={`${humanise(row.status)} orders`} />
      ),
    },
  ];

  const paymentColumns: Column<{ status: string; count: number; amount?: string }>[] = [
    {
      key: 'status',
      header: 'Status',
      render: (row) => <Badge tone={paymentStatusTone(row.status)}>{humanise(row.status)}</Badge>,
    },
    {
      key: 'count',
      header: 'Transactions',
      align: 'right',
      render: (row) => formatNumber(row.count),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      render: (row) => money(row.amount, query.data?.payments.currency ?? currency),
    },
    {
      key: 'open',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <RowLink to={`/payments?status=${row.status}`} label={`${humanise(row.status)} payments`} />
      ),
    },
  ];

  const lowStockColumns: Column<LowStockItem>[] = [
    {
      key: 'name',
      header: 'Product',
      render: (row) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-medium text-ink">{row.name}</p>
            {row.availableQty <= 0 && <Badge tone="danger">Out of stock</Badge>}
          </div>
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
      key: 'cover',
      header: 'Reorder at',
      width: '11rem',
      secondary: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <Meter
            value={row.availableQty}
            max={row.reorderThreshold}
            tone={row.availableQty <= 0 ? 'danger' : 'warning'}
            className="min-w-0 flex-1"
          />
          <span className="w-14 shrink-0 text-right tabular text-xxs text-ink-subtle">
            of {formatNumber(row.reorderThreshold)}
          </span>
        </div>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      render: (row) => (
        <RowLink to={`/inventory?q=${encodeURIComponent(row.sku)}`} label={row.name} />
      ),
    },
  ];

  const upcomingColumns: Column<UpcomingOccurrence>[] = [
    {
      key: 'name',
      header: 'Schedule',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{row.name}</p>
          <p className="text-xxs text-ink-subtle">{row.customerName ?? 'Unknown customer'}</p>
        </div>
      ),
    },
    {
      key: 'next',
      header: 'Next run',
      render: (row) => {
        // Due inside a day is the one that changes what somebody does this
        // morning, so it is the one that gets a colour.
        const dueSoon = new Date(row.nextRunAt).getTime() - Date.now() < 86_400_000;

        return (
          <div>
            <p className={cx('font-medium', dueSoon ? 'text-warning' : 'text-ink')}>
              {formatRelative(row.nextRunAt)}
            </p>
            <p className="text-xxs text-ink-subtle">{formatDateTime(row.nextRunAt)}</p>
          </div>
        );
      },
    },
    {
      key: 'mode',
      header: 'Payment',
      secondary: true,
      render: (row) => <Badge tone="operational">{humanise(row.paymentMode)}</Badge>,
    },
  ];

  const attentionColumns: Column<DashboardResponse['recurring']['needsAttention'][number]>[] = [
    {
      key: 'name',
      header: 'Schedule',
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{row.name}</p>
          <p className="text-xxs text-ink-subtle">{row.customerName ?? 'Unknown customer'}</p>
        </div>
      ),
    },
    {
      key: 'failures',
      header: 'Failures',
      align: 'right',
      render: (row) => <span className="font-semibold text-danger">{formatNumber(row.failureCount)}</span>,
    },
    {
      key: 'reason',
      header: 'Reason',
      secondary: true,
      render: (row) => (
        <span className="text-ink-muted">{row.reason ?? 'No reason recorded'}</span>
      ),
    },
  ];

  const lowStockCount = query.data?.lowStock.count ?? 0;
  const lowStockShown = query.data?.lowStock.items.length ?? 0;
  const needsAttention = query.data?.recurring.needsAttention ?? [];

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Sales, orders and anything that needs attention."
        actions={
          <>
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

            {/* The same request, on demand. An operations screen that can only
                be refreshed by reloading the browser gets left open and stale. */}
            <Button
              isLoading={query.isFetching}
              onClick={() => {
                void query.refetch();
              }}
            >
              {!query.isFetching && <RefreshIcon className="h-4 w-4" />}
              {query.isFetching ? 'Refreshing…' : 'Refresh'}
            </Button>
          </>
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

          {/*
           * Five figures, two tiers.
           *
           * Orders, gross and collected are what the page is opened for and
           * take the wide row at the larger step; net revenue and average
           * order value are the follow-up questions and sit below at the
           * smaller one. Six columns divide cleanly into 2+2+2 and 3+3, so the
           * two tiers stay aligned to one grid instead of two.
           */}
          <section aria-label="Key figures" className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            <Metric
              label="Orders"
              emphasis="primary"
              className="xl:col-span-2"
              value={formatNumber(sales?.orderCount ?? 0)}
              sub={windowLabel}
            />

            <Metric
              label="Gross sales"
              emphasis="primary"
              className="xl:col-span-2"
              value={formatMoney(sales?.grossSales)}
              sub={`incl. ${formatMoney(sales?.tax)} tax`}
            >
              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border-subtle pt-2.5 text-xxs">
                <div className="flex gap-1.5">
                  <dt className="text-ink-subtle">Shipping</dt>
                  <dd className="tabular font-medium text-ink-muted">{formatMoney(sales?.shipping)}</dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-ink-subtle">Discount</dt>
                  <dd className="tabular font-medium text-ink-muted">{formatMoney(sales?.discount)}</dd>
                </div>
              </dl>
            </Metric>

            <Metric
              label="Collected"
              emphasis="primary"
              className="xl:col-span-2"
              value={formatMoney(sales?.collected)}
              sub="Verified payments only"
            >
              {collectedShare !== null && (
                <div className="mt-3 border-t border-border-subtle pt-2.5">
                  <Meter
                    value={collectedShare}
                    max={100}
                    tone={collectedShare >= 95 ? 'success' : 'warning'}
                  />
                  <p className="mt-1.5 text-xxs text-ink-muted">
                    <span className="tabular font-medium text-ink">
                      {Math.round(collectedShare)}%
                    </span>{' '}
                    of gross sales
                  </p>
                </div>
              )}
            </Metric>

            <Metric
              label="Net revenue"
              className="xl:col-span-3"
              value={formatMoney(sales?.netRevenue)}
              sub={`after ${formatMoney(sales?.refunded)} refunded`}
            />

            <Metric
              label="Average order value"
              className="xl:col-span-3"
              value={formatMoney(sales?.averageOrderValue)}
              sub={`across ${formatNumber(sales?.orderCount ?? 0)} orders`}
            />
          </section>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card
              title="Orders by status"
              description="Where every order in this period currently sits. Open a row to work that status."
              actions={<PanelLink to="/orders">All orders</PanelLink>}
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
              title="Payments"
              description="Every transaction raised in this period, by the state it stopped in."
              actions={<PanelLink to="/payments">All payments</PanelLink>}
            >
              {/*
               * The three totals first, then the queue. Captured, refunded
               * and failed answer "did the money move"; the table underneath
               * answers "what is stuck and how much of it".
               */}
              <dl className="grid grid-cols-2 gap-px border-b border-border-subtle bg-border">
                {[
                  { label: 'Captured', value: money(query.data.payments.captured, query.data.payments.currency), tone: 'text-success' },
                  { label: 'Refunded', value: money(query.data.payments.refunded, query.data.payments.currency), tone: 'text-ink' },
                  { label: 'Failed', value: money(query.data.payments.failed, query.data.payments.currency), tone: 'text-danger' },
                  { label: 'Refunds issued', value: formatNumber(query.data.payments.refundCount), tone: 'text-ink' },
                ].map((cell) => (
                  <div key={cell.label} className="bg-surface px-4 py-3">
                    <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      {cell.label}
                    </dt>
                    <dd className={cx('mt-1 text-sm font-semibold tabular', cell.tone)}>{cell.value}</dd>
                  </div>
                ))}
              </dl>

              <DataTable
                caption="Payments by status"
                columns={paymentColumns}
                rows={query.data.payments.byStatus}
                rowKey={(row) => row.status}
                emptyTitle="No payments in this period"
              />
            </Card>

            <Card
              title="Low stock"
              description={
                lowStockCount === 0
                  ? 'Available quantity at or below the reorder threshold.'
                  : `${formatNumber(lowStockCount)} product${lowStockCount === 1 ? '' : 's'} at or below the reorder threshold${lowStockCount > lowStockShown ? `, showing the first ${formatNumber(lowStockShown)}` : ''}.`
              }
              actions={<PanelLink to="/inventory?lowStockOnly=true">All low stock</PanelLink>}
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
              description="The next scheduled run for each active schedule, over the coming week."
              actions={<PanelLink to="/recurring?status=ACTIVE">All schedules</PanelLink>}
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

            {/*
             * Only when there is something in it. A permanently-present empty
             * panel is the fastest way to teach people to stop reading this
             * half of the page.
             */}
            {needsAttention.length > 0 && (
              <Card
                className="xl:col-span-2"
                title="Schedules that have stopped"
                description={`Paused or failed after repeated errors. ${formatNumber(query.data.recurring.failedOccurrences)} occurrence${query.data.recurring.failedOccurrences === 1 ? ' has' : 's have'} failed in total.`}
                actions={<PanelLink to="/recurring?status=PAUSED">Paused schedules</PanelLink>}
              >
                <DataTable
                  caption="Schedules that have stopped"
                  columns={attentionColumns}
                  rows={needsAttention}
                  rowKey={(row) => row.scheduleId}
                  emptyTitle="Every schedule is running"
                />
              </Card>
            )}
          </div>
        </>
      )}
    </>
  );
}
