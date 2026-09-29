/**
 * The command centre's key figures and system health (checklist SCREEN-065).
 *
 * The dashboard's ring says what is WAITING. This says how the business and the
 * machinery are doing: orders and sales against the previous period of the same
 * length, and the five things that mean something is stuck - emails that did not
 * go, background jobs that gave up, payment messages the server refused,
 * payments nobody could match, and repeat-order plans that stopped.
 *
 * Everything comes from `GET /admin/dashboard`, which returns it already. That
 * endpoint needs `report.read`; a member of staff without it sees the ring and
 * the insights panel and nothing here - the request is not even made, because a
 * 403 on every visit is noise, not information.
 *
 * Money stays in minor units: the change figure is worked out in BigInt
 * (basis points) and only turned into text at the end.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { BentoCell } from '@/components/dashboard/console';
import { Badge, Card, ErrorState, LoadingState, Metric } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import type { ReportingWindow } from '@/lib/dashboard-range';
import { formatMoney, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { KPI_QUERY_KEY, changeBetween, changeBetweenCounts } from '@/lib/command-centre';
import type { DashboardResponse } from '@/lib/types';

/** Same cadence as the ring next to it: a minute, only while the tab is in front. */
const REFRESH_MS = 60_000;

const HEALTH_ROWS: {
  field: keyof DashboardResponse['alerts'];
  label: TranslationKey;
  to: string;
}[] = [
  { field: 'failedNotifications', label: 'commandCentre.health.failedNotifications', to: '/operations/failed-notifications' },
  { field: 'deadJobs', label: 'commandCentre.health.deadJobs', to: '/operations/dead-jobs' },
  { field: 'rejectedWebhooks', label: 'commandCentre.health.rejectedWebhooks', to: '/payments' },
  { field: 'unreconciledPayments', label: 'commandCentre.health.unreconciledPayments', to: '/payments' },
  { field: 'schedulesNeedingAttention', label: 'commandCentre.health.schedulesNeedingAttention', to: '/recurring' },
];

export function CommandCentreTiles({ window: reportingWindow }: { window: ReportingWindow }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const allowed = can(Permission.REPORT_READ);

  const query = useQuery({
    queryKey: [...KPI_QUERY_KEY, reportingWindow.from, reportingWindow.to],
    queryFn: () =>
      api.get<DashboardResponse>(
        `/admin/dashboard?from=${encodeURIComponent(reportingWindow.from)}&to=${encodeURIComponent(reportingWindow.to)}`,
      ),
    enabled: allowed,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  if (!allowed) return null;

  if (query.isPending) {
    return (
      <BentoCell span={6} spanMd={3}>
        <Card>
          <LoadingState label={t('commandCentre.loading')} />
        </Card>
      </BentoCell>
    );
  }

  if (query.isError) {
    return (
      <BentoCell span={6} spanMd={3}>
        <Card>
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </Card>
      </BentoCell>
    );
  }

  const { sales, previousSales, alerts, lowStock } = query.data;
  const noPrior = t('dashboard.noPriorPeriod');
  const sub = (change: string | null): string =>
    change === null ? noPrior : t('commandCentre.change', { change });

  const stuck = HEALTH_ROWS.reduce((total, row) => total + alerts[row.field], 0);

  return (
    <>
      <BentoCell span={4} spanMd={3}>
        <section aria-label={t('dashboard.keyFigures')} className="h-full">
          <h2 className="mb-3 text-title-xs text-ink">{t('dashboard.keyFigures')}</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <Metric
              emphasis="primary"
              label={t('commandCentre.orders')}
              value={formatNumber(sales.orderCount)}
              sub={sub(changeBetweenCounts(sales.orderCount, previousSales.orderCount))}
            />
            <Metric
              emphasis="primary"
              label={t('dashboard.grossSales')}
              value={formatMoney(sales.grossSales)}
              sub={sub(changeBetween(sales.grossSales, previousSales.grossSales))}
            />
            <Metric
              emphasis="primary"
              label={t('dashboard.averageOrderValue')}
              value={formatMoney(sales.averageOrderValue)}
              sub={sub(changeBetween(sales.averageOrderValue, previousSales.averageOrderValue))}
            />
            <Metric
              label={t('dashboard.collected')}
              value={formatMoney(sales.collected)}
              sub={sub(changeBetween(sales.collected, previousSales.collected))}
            />
            <Metric
              label={t('dashboard.netRevenue')}
              value={formatMoney(sales.netRevenue)}
              sub={sub(changeBetween(sales.netRevenue, previousSales.netRevenue))}
            />
            <Link to="/inventory" className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
              <Metric
                className="h-full"
                label={t('dashboard.lowStock')}
                value={formatNumber(lowStock.count)}
                sub={t('commandCentre.lowStockHint')}
              />
            </Link>
          </div>
        </section>
      </BentoCell>

      <BentoCell span={2} spanMd={3}>
        <div className="h-full">
          <Card
            title={t('commandCentre.health.title')}
            description={t('commandCentre.health.description')}
            className="h-full"
          >
            <ul className="divide-y divide-border-subtle px-5 pb-3">
              {HEALTH_ROWS.map((row) => {
                const count = alerts[row.field];
                return (
                  <li key={row.field} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="min-w-0 text-ink">{t(row.label)}</span>
                    {count > 0 ? (
                      <Link to={row.to} className="shrink-0" aria-label={`${t(row.label)}: ${String(count)}`}>
                        <Badge tone="danger">{formatNumber(count)}</Badge>
                      </Link>
                    ) : (
                      <Badge tone="success">{t('commandCentre.health.ok')}</Badge>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="px-5 pb-4 text-xs text-ink-muted" role="status">
              {stuck === 0 ? t('commandCentre.health.allClear') : t('commandCentre.health.needAttention')}
            </p>
          </Card>
        </div>
      </BentoCell>
    </>
  );
}
