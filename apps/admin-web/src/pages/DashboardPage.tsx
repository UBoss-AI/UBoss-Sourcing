/**
 * Dashboard.
 *
 * One request fills the whole page - `GET /admin/dashboard` returns sales,
 * orders by status, payments, low stock and recurring together. Six separate
 * panel requests would show six independent spinners and six chances to
 * disagree about the reporting window.
 *
 * What used to sit at the top of this page and no longer does: the "needs
 * attention" alert panel. Something you must be told about is something you
 * must be told about wherever you happen to be standing, not only on the one
 * screen you may not have open - so that job moved to the bell in the top bar,
 * which is on every page. See `layout/NotificationBell.tsx`.
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
 * Trends ARE drawn here now, and every one of them is a figure the server
 * measured. `/admin/dashboard` returns three things beyond this window's
 * aggregates: the same aggregate over the window of equal length before it,
 * and the day-by-day series behind the headline numbers. So "+18% on the
 * previous 30 days" is a comparison of two database aggregates, and a
 * sparkline is the days the orders actually fell on.
 *
 * Three things this page still refuses to do, because each of them is a way of
 * drawing a number nobody measured:
 *
 *   - **It does not invent a percentage from nothing.** Where the previous
 *     period holds no orders, the tile says there is nothing to compare with.
 *     A rise from zero is not a percentage, and on the day after go-live it
 *     would be on every tile at once.
 *   - **It does not plot a sparse series as if it were dense.** The day series
 *     only contains days that had orders, so it is filled against the window
 *     before it is drawn - otherwise eight days would spread themselves evenly
 *     across a month and describe a shape that never happened.
 *   - **It does not compute an authoritative total from a list.** The
 *     proportions drawn - a status's share of the period, collected against
 *     gross - are arithmetic on figures already on the screen, and the table
 *     under every chart is where the exact numbers live.
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
import { ChevronRightIcon, RefreshIcon } from '@/components/icons';
import { Delta, ProportionBar, Sparkline } from '@/components/charts';
import type { ProportionSegment } from '@/components/charts';
import { fillDailySeries } from '@/lib/series';
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
import type {
  DashboardResponse,
  LowStockItem,
  OrdersByStatusRow,
  UpcomingOccurrence,
} from '@/lib/types';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

/**
 * Named windows, so the common cases are one click and not a date picker.
 *
 * Keys rather than words: this list is module state, built before any
 * component has rendered and therefore before there is a `t` to call. The
 * label is translated where it is shown.
 */
const WINDOWS = [
  { value: '7', labelKey: 'dashboard.last7Days' },
  { value: '30', labelKey: 'dashboard.last30Days' },
  { value: '90', labelKey: 'dashboard.last90Days' },
  { value: '365', labelKey: 'dashboard.last12Months' },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[];

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

/*
 * Where a status sits in the fulfilment sequence.
 *
 * The bar is an ORDINAL chart, so this is the information it encodes: a step
 * number, in pipeline order, from "somebody has to approve it" to "it arrived".
 * Two things sit outside the sequence on purpose:
 *
 *   - `DRAFT` has not entered it. Neutral grey, not step zero — a draft is not
 *     early progress, it is no progress.
 *   - `CANCELLED`, `RETURNED` and `REFUNDED` are outcomes rather than stages,
 *     and all three are the same fact for this chart: the order did not
 *     complete. They are folded into ONE danger segment, because three reds
 *     touching each other in a 10px bar are one red to every reader. The table
 *     underneath keeps them apart, which is where the breakdown belongs.
 *
 * Deliberately NOT `orderStatusTone`. That maps CONFIRMED and DELIVERED both
 * to green, which is right for two chips in separate table rows and useless
 * for two segments sharing an edge.
 */
const PIPELINE_STEP: Record<string, ProportionSegment['step']> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 1,
  PENDING_PAYMENT: 2,
  CONFIRMED: 3,
  PROCESSING: 4,
  SHIPPED: 5,
  DELIVERED: 6,
};

/** The three statuses folded into the single "did not complete" segment. */
const NOT_COMPLETED = ['CANCELLED', 'RETURNED', 'REFUNDED'];

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
      <span
        className={cx('block h-full rounded-full', METER_TONES[tone])}
        style={{ width: `${percent}%` }}
      />
    </span>
  );
}

/** The header action on a queue panel: "here is the whole list". */
function PanelLink({ to, children }: { to: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <Link
      to={to}
      className="-mx-1 inline-flex min-h-[1.75rem] items-center gap-0.5 rounded px-1 text-xs font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
    >
      {children}
      <ChevronRightIcon className="h-3.5 w-3.5" />
    </Link>
  );
}

/** The per-row action on a queue panel: "take me to this one". */
function RowLink({ to, label }: { to: string; label: string }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Link
      to={to}
      className="-mx-1 inline-flex min-h-[1.75rem] items-center rounded px-1 text-xs font-medium text-accent underline-offset-2 transition-colors hover:text-accent-hover hover:underline"
    >
      {t('dashboard.open')}
      <span className="sr-only"> {label}</span>
    </Link>
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
  const { t } = useI18n();

  const [searchParams, setSearchParams] = useSearchParams();
  const days = Number(searchParams.get('days') ?? '30');
  const effectiveDays = Number.isFinite(days) && days > 0 ? days : 30;
  const range = useMemo(() => windowRange(effectiveDays), [effectiveDays]);

  const query = useQuery({
    queryKey: ['dashboard', range.from, range.to],
    queryFn: () => api.get<DashboardResponse>('/admin/dashboard', { query: range }),
  });

  const namedWindow = WINDOWS.find((option) => option.value === String(effectiveDays));

  // A hand-edited `?days=` is a supported way to arrive here, so the label has
  // to be able to say a number that is not in the list.
  const windowLabel =
    namedWindow === undefined
      ? t('dashboard.lastNDays', { count: effectiveDays, days: formatNumber(effectiveDays) })
      : translateKey(t, namedWindow.labelKey);

  const sales = query.data?.sales;
  const currency = sales?.currency ?? 'INR';

  /** Minor units, as this endpoint sends them for anything but `Money`. */
  const money = (minor: string | undefined, inCurrency: string): string =>
    formatMoney({
      minor: minor ?? '0',
      formatted: minorToMajor(minor ?? '0'),
      currency: inCurrency,
    });

  const collectedShare = shareOfMinor(sales?.collected.minor, sales?.grossSales.minor);

  // The denominator for the share column, taken from the rows on screen rather
  // than from `sales.orderCount`: the two are aggregates of different things,
  // and a bar that can exceed its own track is worse than no bar.
  const ordersInStatuses = (query.data?.ordersByStatus ?? []).reduce(
    (sum, row) => sum + row.count,
    0,
  );

  /*
   * The series behind the tiles, gap-filled against the window.
   *
   * `useMemo` on the response rather than on the query object: the filling
   * walks a day at a time, and re-walking thirty days on every unrelated
   * re-render of a page this size is waste for no gain.
   */
  const trend = useMemo(() => {
    const buckets = query.data?.salesSeries ?? [];
    const from = new Date(range.from);
    const to = new Date(range.to);

    return {
      orders: fillDailySeries(
        buckets.map((bucket) => ({ period: bucket.period, value: bucket.orderCount })),
        from,
        to,
      ),
      gross: fillDailySeries(
        // Minor units are a string on the wire because a paisa-precise total
        // can exceed 2^53. A sparkline only needs the *shape*, so it is safe
        // to come down to a number here — and only here, for the plot. No
        // figure on this screen is computed from it.
        buckets.map((bucket) => ({ period: bucket.period, value: Number(bucket.grossSales) })),
        from,
        to,
      ),
      collected: fillDailySeries(
        buckets.map((bucket) => ({ period: bucket.period, value: Number(bucket.collected) })),
        from,
        to,
      ),
    };
  }, [query.data?.salesSeries, range.from, range.to]);

  const previous = query.data?.previousSales;

  /** "vs previous 30 days" — the comparison names its own period. */
  const vsPrevious = t('dashboard.vsPrevious', {
    days: formatNumber(effectiveDays),
    count: effectiveDays,
  });
  const noPriorPeriod = t('dashboard.noPriorPeriod');

  /*
   * The bar's segments: the pipeline in order, then one folded segment for
   * every order that did not complete.
   */
  const statusSegments = useMemo((): ProportionSegment[] => {
    const rows = query.data?.ordersByStatus ?? [];

    const staged = rows
      .filter((row) => PIPELINE_STEP[row.status] !== undefined)
      .map((row) => ({
        id: row.status,
        // `humanise`, the same as the table's own status column. The panel has
        // no translated catalogue of order statuses, and inventing one here
        // would leave the bar and the table underneath it disagreeing.
        label: humanise(row.status),
        value: row.count,
        step: PIPELINE_STEP[row.status] ?? 'neutral',
      }))
      // Pipeline order, not the order the database happened to group them in,
      // so the bar reads left to right as the sequence it represents.
      .sort((a, b) => {
        const rank = (step: ProportionSegment['step']): number =>
          typeof step === 'number' ? step : -1;
        return rank(a.step) - rank(b.step);
      });

    const notCompleted = rows
      .filter((row) => NOT_COMPLETED.includes(row.status))
      .reduce((sum, row) => sum + row.count, 0);

    return notCompleted === 0
      ? staged
      : [
          ...staged,
          {
            id: 'not-completed',
            label: t('dashboard.didNotComplete'),
            value: notCompleted,
            step: 'danger' as const,
          },
        ];
  }, [query.data?.ordersByStatus, t]);

  const statusColumns: Column<OrdersByStatusRow>[] = [
    {
      key: 'status',
      header: t('label.status'),
      render: (row) => <Badge tone={orderStatusTone(row.status)}>{humanise(row.status)}</Badge>,
    },
    {
      key: 'count',
      header: t('label.orders'),
      align: 'right',
      render: (row) => formatNumber(row.count),
    },
    {
      key: 'share',
      header: t('dashboard.share'),
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
      header: t('label.value'),
      align: 'right',
      render: (row) => money(row.value, currency),
    },
    {
      key: 'open',
      header: <span className="sr-only">{t('dashboard.actions')}</span>,
      align: 'right',
      render: (row) => (
        <RowLink
          to={`/orders?status=${row.status}`}
          label={t('dashboard.statusOrders', { status: humanise(row.status) })}
        />
      ),
    },
  ];

  const paymentColumns: Column<{ status: string; count: number; amount?: string }>[] = [
    {
      key: 'status',
      header: t('label.status'),
      render: (row) => <Badge tone={paymentStatusTone(row.status)}>{humanise(row.status)}</Badge>,
    },
    {
      key: 'count',
      header: t('dashboard.transactions'),
      align: 'right',
      render: (row) => formatNumber(row.count),
    },
    {
      key: 'amount',
      header: t('label.amount'),
      align: 'right',
      render: (row) => money(row.amount, query.data?.payments.currency ?? currency),
    },
    {
      key: 'open',
      header: <span className="sr-only">{t('dashboard.actions')}</span>,
      align: 'right',
      render: (row) => (
        <RowLink
          to={`/payments?status=${row.status}`}
          label={t('dashboard.statusPayments', { status: humanise(row.status) })}
        />
      ),
    },
  ];

  const lowStockColumns: Column<LowStockItem>[] = [
    {
      key: 'name',
      header: t('label.product'),
      render: (row) => (
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="font-medium text-ink">{row.name}</p>
            {row.availableQty <= 0 && <Badge tone="danger">{t('dashboard.outOfStock')}</Badge>}
          </div>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku}</p>
        </div>
      ),
    },
    {
      key: 'available',
      header: t('label.available'),
      align: 'right',
      render: (row) => (
        <span className={row.availableQty <= 0 ? 'font-semibold text-danger' : 'text-ink'}>
          {formatNumber(row.availableQty)}
        </span>
      ),
    },
    {
      key: 'cover',
      header: t('label.reorderAt'),
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
            {t('dashboard.ofThreshold', { threshold: formatNumber(row.reorderThreshold) })}
          </span>
        </div>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">{t('dashboard.actions')}</span>,
      align: 'right',
      render: (row) => (
        <RowLink to={`/inventory?q=${encodeURIComponent(row.sku)}`} label={row.name} />
      ),
    },
  ];

  const upcomingColumns: Column<UpcomingOccurrence>[] = [
    {
      key: 'name',
      header: t('label.schedule'),
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{row.name}</p>
          <p className="text-xxs text-ink-subtle">
            {row.customerName ?? t('dashboard.unknownCustomer')}
          </p>
        </div>
      ),
    },
    {
      key: 'next',
      header: t('label.nextRun'),
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
      header: t('label.payment'),
      secondary: true,
      render: (row) => <Badge tone="operational">{humanise(row.paymentMode)}</Badge>,
    },
  ];

  const attentionColumns: Column<DashboardResponse['recurring']['needsAttention'][number]>[] = [
    {
      key: 'name',
      header: t('label.schedule'),
      render: (row) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{row.name}</p>
          <p className="text-xxs text-ink-subtle">
            {row.customerName ?? t('dashboard.unknownCustomer')}
          </p>
        </div>
      ),
    },
    {
      key: 'failures',
      header: t('dashboard.failures'),
      align: 'right',
      render: (row) => (
        <span className="font-semibold text-danger">{formatNumber(row.failureCount)}</span>
      ),
    },
    {
      key: 'reason',
      header: t('label.reason'),
      secondary: true,
      render: (row) => (
        <span className="text-ink-muted">{row.reason ?? t('dashboard.noReasonRecorded')}</span>
      ),
    },
  ];

  const lowStockCount = query.data?.lowStock.count ?? 0;
  const lowStockShown = query.data?.lowStock.items.length ?? 0;

  /**
   * What the low-stock panel says about itself.
   *
   * Three sentences, not one with two optional clauses: none at all, a count,
   * and a count that is more than the table can show. Assembling it here keeps
   * the JSX below readable and keeps the plural in the catalogue where a
   * translator can see it - Polish needs four forms of this sentence and
   * English needs two.
   */
  const lowStockDescription =
    lowStockCount === 0
      ? t('dashboard.lowStockThreshold')
      : t(
          lowStockCount > lowStockShown
            ? 'dashboard.lowStockAtThresholdShown'
            : 'dashboard.lowStockAtThreshold',
          {
            count: lowStockCount,
            products: formatNumber(lowStockCount),
            shown: formatNumber(lowStockShown),
          },
        );
  const needsAttention = query.data?.recurring.needsAttention ?? [];

  return (
    <>
      <PageHeader
        title={t('dashboard.dashboard')}
        description={t('dashboard.salesOrdersAndAnythingThat')}
        actions={
          <>
            <label className="flex items-center gap-2 text-sm text-ink-muted">
              <span className="sr-only sm:not-sr-only">{t('dashboard.period')}</span>
              <Select
                value={String(days)}
                onChange={(event) => {
                  setSearchParams({ days: event.target.value }, { replace: true });
                }}
                className="w-40"
              >
                {WINDOWS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {translateKey(t, option.labelKey)}
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
              {query.isFetching ? t('dashboard.refreshing') : t('dashboard.refresh')}
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
          <LoadingState label={t('dashboard.loadingTheDashboard')} />
        </Card>
      )}

      {query.data !== undefined && (
        <>
          {/*
           * Five figures, two tiers.
           *
           * Orders, gross and collected are what the page is opened for and
           * take the wide row at the larger step; net revenue and average
           * order value are the follow-up questions and sit below at the
           * smaller one. Six columns divide cleanly into 2+2+2 and 3+3, so the
           * two tiers stay aligned to one grid instead of two.
           */}
          <section
            aria-label={t('dashboard.keyFigures')}
            className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-6"
          >
            <Metric
              label={t('label.orders')}
              emphasis="primary"
              className="xl:col-span-2"
              value={formatNumber(sales?.orderCount ?? 0)}
              sub={windowLabel}
            >
              <Delta
                current={sales?.orderCount ?? 0}
                previous={previous?.orderCount ?? 0}
                periodLabel={vsPrevious}
                noComparisonLabel={noPriorPeriod}
              />
              <div className="mt-3">
                <Sparkline
                  points={trend.orders}
                  label={t('dashboard.trendOf', { metric: t('label.orders') })}
                />
              </div>
            </Metric>

            <Metric
              label={t('dashboard.grossSales')}
              emphasis="primary"
              className="xl:col-span-2"
              value={formatMoney(sales?.grossSales)}
              sub={t('dashboard.inclTax', { amount: formatMoney(sales?.tax) })}
            >
              <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-border-subtle pt-2.5 text-xxs">
                <div className="flex gap-1.5">
                  <dt className="text-ink-subtle">{t('dashboard.shipping')}</dt>
                  <dd className="tabular font-medium text-ink-muted">
                    {formatMoney(sales?.shipping)}
                  </dd>
                </div>
                <div className="flex gap-1.5">
                  <dt className="text-ink-subtle">{t('dashboard.discount')}</dt>
                  <dd className="tabular font-medium text-ink-muted">
                    {formatMoney(sales?.discount)}
                  </dd>
                </div>
              </dl>

              <Delta
                current={Number(sales?.grossSales.minor ?? '0')}
                previous={Number(previous?.grossSales.minor ?? '0')}
                periodLabel={vsPrevious}
                noComparisonLabel={noPriorPeriod}
              />
              <div className="mt-3">
                <Sparkline
                  points={trend.gross}
                  label={t('dashboard.trendOf', { metric: t('dashboard.grossSales') })}
                />
              </div>
            </Metric>

            <Metric
              label={t('dashboard.collected')}
              emphasis="primary"
              className="xl:col-span-2"
              value={formatMoney(sales?.collected)}
              sub={t('dashboard.verifiedPaymentsOnly')}
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
                    {/* The phrase alone, so the figure keeps its weight - it is
                        what the line is for. Every language this panel ships
                        puts it after the number; one that did not would need
                        the two joined into a single interpolated key. */}
                    {t('dashboard.ofGrossSales')}
                  </p>
                </div>
              )}

              {/* The meter already carries the shape of this one, so it gets
                  the change and no sparkline — three plots in one tile is
                  where a dashboard stops being readable. */}
              <Delta
                current={Number(sales?.collected.minor ?? '0')}
                previous={Number(previous?.collected.minor ?? '0')}
                periodLabel={vsPrevious}
                noComparisonLabel={noPriorPeriod}
              />
            </Metric>

            <Metric
              label={t('dashboard.netRevenue')}
              className="xl:col-span-3"
              value={formatMoney(sales?.netRevenue)}
              sub={t('dashboard.afterRefunded', { amount: formatMoney(sales?.refunded) })}
            >
              <Delta
                current={Number(sales?.netRevenue.minor ?? '0')}
                previous={Number(previous?.netRevenue.minor ?? '0')}
                periodLabel={vsPrevious}
                noComparisonLabel={noPriorPeriod}
              />
            </Metric>

            <Metric
              label={t('dashboard.averageOrderValue')}
              className="xl:col-span-3"
              value={formatMoney(sales?.averageOrderValue)}
              // `count` picks the plural form, `orders` is what gets printed:
              // i18next interpolates a raw number, and a four-figure order
              // count belongs in the reader's own digit grouping.
              sub={t('dashboard.acrossOrders', {
                count: sales?.orderCount ?? 0,
                orders: formatNumber(sales?.orderCount ?? 0),
              })}
            >
              <Delta
                current={Number(sales?.averageOrderValue.minor ?? '0')}
                previous={Number(previous?.averageOrderValue.minor ?? '0')}
                periodLabel={vsPrevious}
                noComparisonLabel={noPriorPeriod}
              />
            </Metric>
          </section>

          <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
            <Card
              title={t('dashboard.ordersByStatus')}
              description={t('dashboard.whereEveryOrderInThis')}
              actions={<PanelLink to="/orders">{t('dashboard.allOrders')}</PanelLink>}
            >
              {/*
                The composition first, then the rows.
                One bar answers "where is the period sitting" at a glance,
                which a column of per-row meters cannot: those each have their
                own track, so they compare a status against the total but
                never against each other. The table underneath is unchanged and
                is still where the exact figures are read.
              */}
              {statusSegments.length > 1 && (
                <div className="border-b border-border-subtle px-5 py-4">
                  <ProportionBar
                    segments={statusSegments}
                    total={ordersInStatuses}
                    formatShare={(value, total) => `${String(Math.round((value / total) * 100))}%`}
                  />
                </div>
              )}

              <DataTable
                caption={t('dashboard.ordersByStatus')}
                columns={statusColumns}
                rows={query.data.ordersByStatus}
                rowKey={(row) => row.status}
                emptyTitle={t('dashboard.noOrdersInThisPeriod')}
              />
            </Card>

            <Card
              title={t('label.payments')}
              description={t('dashboard.everyTransactionRaisedInThis')}
              actions={<PanelLink to="/payments">{t('dashboard.allPayments')}</PanelLink>}
            >
              {/*
               * The three totals first, then the queue. Captured, refunded
               * and failed answer "did the money move"; the table underneath
               * answers "what is stuck and how much of it".
               */}
              <dl className="grid grid-cols-2 gap-px border-b border-border-subtle bg-border">
                {[
                  {
                    id: 'captured',
                    label: t('label.captured'),
                    value: money(query.data.payments.captured, query.data.payments.currency),
                    tone: 'text-success',
                  },
                  {
                    id: 'refunded',
                    label: t('label.refunded'),
                    value: money(query.data.payments.refunded, query.data.payments.currency),
                    tone: 'text-ink',
                  },
                  {
                    id: 'failed',
                    label: t('dashboard.failed'),
                    value: money(query.data.payments.failed, query.data.payments.currency),
                    tone: 'text-danger',
                  },
                  {
                    id: 'refundCount',
                    label: t('dashboard.refundsIssued'),
                    value: formatNumber(query.data.payments.refundCount),
                    tone: 'text-ink',
                  },
                  // Keyed on the id rather than the label: the label changes
                  // with the language, and React would tear all four cells
                  // down and rebuild them on a switch.
                ].map((cell) => (
                  <div key={cell.id} className="bg-surface px-4 py-3">
                    <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
                      {cell.label}
                    </dt>
                    <dd className={cx('mt-1 text-sm font-semibold tabular', cell.tone)}>
                      {cell.value}
                    </dd>
                  </div>
                ))}
              </dl>

              <DataTable
                caption={t('dashboard.paymentsByStatus')}
                columns={paymentColumns}
                rows={query.data.payments.byStatus}
                rowKey={(row) => row.status}
                emptyTitle={t('dashboard.noPaymentsInThisPeriod')}
              />
            </Card>

            <Card
              title={t('dashboard.lowStock')}
              description={lowStockDescription}
              actions={
                <PanelLink to="/inventory?lowStockOnly=true">
                  {t('dashboard.allLowStock')}
                </PanelLink>
              }
            >
              <DataTable
                caption={t('dashboard.lowStock')}
                columns={lowStockColumns}
                rows={query.data.lowStock.items}
                rowKey={(row) => `${row.productId}:${row.variantId ?? ''}`}
                emptyTitle={t('dashboard.nothingIsRunningLow')}
                emptyDescription={t('common.everyTrackedProductIsAbove')}
              />
            </Card>

            <Card
              title={t('dashboard.upcomingRecurringOrders')}
              description={t('dashboard.theNextScheduledRunFor')}
              actions={
                <PanelLink to="/recurring?status=ACTIVE">{t('dashboard.allSchedules')}</PanelLink>
              }
            >
              <DataTable
                caption={t('dashboard.upcomingRecurringOrders')}
                columns={upcomingColumns}
                rows={query.data.recurring.upcoming}
                rowKey={(row) => row.scheduleId}
                emptyTitle={t('dashboard.noUpcomingRuns')}
                emptyDescription={t('dashboard.noActiveScheduleHasARun')}
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
                title={t('dashboard.schedulesThatHaveStopped')}
                description={t('dashboard.stoppedSchedules', {
                  count: query.data.recurring.failedOccurrences,
                  occurrences: formatNumber(query.data.recurring.failedOccurrences),
                })}
                actions={
                  <PanelLink to="/recurring?status=PAUSED">
                    {t('dashboard.pausedSchedules')}
                  </PanelLink>
                }
              >
                <DataTable
                  caption={t('dashboard.schedulesThatHaveStopped')}
                  columns={attentionColumns}
                  rows={needsAttention}
                  rowKey={(row) => row.scheduleId}
                  emptyTitle={t('dashboard.everyScheduleIsRunning')}
                />
              </Card>
            )}
          </div>
        </>
      )}
    </>
  );
}
