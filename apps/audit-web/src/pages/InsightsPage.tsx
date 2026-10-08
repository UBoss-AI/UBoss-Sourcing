/**
 * Quality insights, for the audit team.
 *
 *   GET /api/v1/audit/insights
 *
 * Modelled on QIMA's quality-insights dashboard: how inspections came out
 * month by month, what the inspectors keep finding, which suppliers do best
 * and worst, and how each agency performs - plus the spread of seller health
 * ratings (Amazon's Account Health bands) for people who may read sellers.
 *
 * Every figure is the server's count over the last twelve months, and every
 * chart leads to the list it counts.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { QueryBoundary, ResponsiveTable, CardField } from '@/components/console';
import { BarListCard, KpiTile, type BarRow } from '@/components/dashboard/charts';
import { BentoCell, BentoGrid, ConsoleCard, ConsoleGround, ConsoleHeader } from '@/components/dashboard/console';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { type Column } from '@/components/DataTable';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchInsights } from '@/lib/console-api';
import type { InsightSupplier, InsightsResponse } from '@/lib/console-types';
import { cx } from '@/lib/cx';
import type { DonutSegmentInput } from '@/lib/donut';
import { displayLocaleOf, formatCalendarDate, formatNumber } from '@/lib/format';
import { agencyKindLabel } from '@/lib/labels';
import type { AgencyKind } from '@/lib/types';

export function InsightsPage(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: consoleKeys.insights(), queryFn: fetchInsights });

  return (
    <ConsoleGround>
      <ConsoleHeader
        title={t('screens.insights.title')}
        subtitle={t('screens.insights.description')}
        lastUpdatedLabel={query.data === undefined ? undefined : t('insights.window', { from: formatCalendarDate(query.data.from) })}
      >
        <Button
          variant="secondary"
          size="sm"
          disabled={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
        >
          {t('insights.refresh')}
        </Button>
      </ConsoleHeader>
      <QueryBoundary query={query}>{(data) => <Insights data={data} />}</QueryBoundary>
    </ConsoleGround>
  );
}

function Insights({ data }: { data: InsightsResponse }): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();

  const donutLabels = {
    status: t('common.status'),
    value: t('dashboard.staff.chart.number'),
    share: t('dashboard.staff.chart.share'),
    viewAsTable: t('dashboard.staff.chart.viewAsTable'),
    clearFilter: t('common.clearFilters'),
    filteredBy: t('dashboard.staff.chart.filteredBy'),
    empty: t('common.nothingHereYet'),
    error: t('common.theRequestFailed'),
    retry: t('dashboard.staff.chart.tryAgain'),
    loading: t('common.loading'),
    remainder: t('dashboard.staff.chart.remainder'),
    clampNote: t('dashboard.staff.chart.clampNote'),
  };
  const open = (segments: readonly DonutSegmentInput[]) => (id: string | null) => {
    const to = segments.find((segment) => segment.id === id)?.to;
    if (to !== undefined) void navigate(to);
  };

  const severitySegments: DonutSegmentInput[] = [
    { id: 'CRITICAL', label: t('enum.severity.CRITICAL'), value: data.defects.bySeverity.CRITICAL, step: 'danger', to: '/corrective-actions' },
    { id: 'MAJOR', label: t('enum.severity.MAJOR'), value: data.defects.bySeverity.MAJOR, step: 'warning', to: '/corrective-actions' },
    { id: 'MINOR', label: t('enum.severity.MINOR'), value: data.defects.bySeverity.MINOR, step: 3, to: '/corrective-actions' },
  ];
  const healthSegments: DonutSegmentInput[] =
    data.health === null
      ? []
      : [
          { id: 'HEALTHY', label: t('health.band.HEALTHY'), value: data.health.bands.HEALTHY, step: 'success', to: '/sellers?health=HEALTHY' },
          { id: 'AT_RISK', label: t('health.band.AT_RISK'), value: data.health.bands.AT_RISK, step: 'warning', to: '/sellers?health=AT_RISK&sort=risk' },
          { id: 'UNHEALTHY', label: t('health.band.UNHEALTHY'), value: data.health.bands.UNHEALTHY, step: 'danger', to: '/sellers?health=UNHEALTHY&sort=risk' },
        ];
  const findingRows: BarRow[] = data.topFindings.map((row, index) => ({
    id: `${String(index)}:${row.requirementRef}`,
    label: row.requirementRef === '' ? t('insights.noReference') : row.requirementRef,
    value: row.count,
    to: '/corrective-actions',
  }));
  const healthyShare = data.health === null || data.health.sellers === 0 ? null : Math.round((data.health.bands.HEALTHY * 100) / data.health.sellers);

  return (
    <BentoGrid>
      <BentoCell span={data.health === null ? 2 : 1} spanMd={1}>
        <KpiTile
          label={t('insights.kpi.passRate')}
          value={data.reports.passRatePercent === null ? '—' : `${formatNumber(data.reports.passRatePercent)}%`}
          sub={t('insights.kpi.passRateSub', { pass: formatNumber(data.reports.pass), total: formatNumber(data.reports.total) })}
          to="/reports"
          meter={data.reports.passRatePercent ?? undefined}
        />
      </BentoCell>
      <BentoCell span={data.health === null ? 2 : 1} spanMd={1}>
        <KpiTile
          label={t('insights.kpi.failed')}
          value={formatNumber(data.reports.fail + data.reports.inconclusive)}
          sub={t('insights.kpi.failedSub', { fail: formatNumber(data.reports.fail), inconclusive: formatNumber(data.reports.inconclusive) })}
          to="/reports"
          tone={data.reports.fail + data.reports.inconclusive > 0 ? 'danger' : 'default'}
        />
      </BentoCell>
      <BentoCell span={data.health === null ? 2 : 2} spanMd={1}>
        <KpiTile
          label={t('insights.kpi.openNcrs')}
          value={formatNumber(data.defects.byStatus.OPEN)}
          sub={t('insights.kpi.openNcrsSub', {
            capa: formatNumber(data.defects.byStatus.CAPA_SUBMITTED),
            closed: formatNumber(data.defects.byStatus.VERIFIED_CLOSED),
          })}
          to="/corrective-actions"
          tone={data.defects.byStatus.OPEN > 0 ? 'warning' : 'default'}
        />
      </BentoCell>
      {data.health === null ? null : (
        <BentoCell span={2} spanMd={3}>
          <KpiTile
            label={t('insights.kpi.healthy')}
            value={healthyShare === null ? '—' : `${formatNumber(healthyShare)}%`}
            sub={t('insights.kpi.healthySub', {
              atRisk: formatNumber(data.health.bands.AT_RISK),
              unhealthy: formatNumber(data.health.bands.UNHEALTHY),
            })}
            to="/sellers?sort=risk"
            tone={data.health.bands.UNHEALTHY > 0 ? 'danger' : 'success'}
            meter={healthyShare ?? undefined}
          />
        </BentoCell>
      )}

      <BentoCell span={6} spanMd={3}>
        <MonthlyResults months={data.months} />
      </BentoCell>

      {/* Rings take half the width, as on the dashboard: a third squeezes the legend. */}
      {data.health === null ? null : (
        <BentoCell span={3} spanMd={3}>
          <ModernDonutCard
            className="h-full"
            title={t('insights.health.title')}
            description={t('insights.health.description')}
            total={data.health.sellers}
            centerLabel={t('insights.health.center')}
            unitLabel={t('insights.health.unit')}
            segments={healthSegments}
            selectedSegment={null}
            onSegmentSelect={open(healthSegments)}
            labels={donutLabels}
          />
        </BentoCell>
      )}
      <BentoCell span={3} spanMd={3}>
        <ModernDonutCard
          className="h-full"
          title={t('insights.severity.title')}
          description={t('insights.severity.description')}
          total={data.defects.total}
          centerLabel={t('insights.severity.center')}
          unitLabel={t('insights.severity.unit')}
          segments={severitySegments}
          selectedSegment={null}
          onSegmentSelect={open(severitySegments)}
          labels={donutLabels}
          emptyState={<p className="text-sm text-ink-subtle">{t('insights.findings.empty')}</p>}
        />
      </BentoCell>
      <BentoCell span={data.health === null ? 3 : 6} spanMd={3}>
        <BarListCard title={t('insights.findings.title')} description={t('insights.findings.description')} rows={findingRows} empty={t('insights.findings.empty')} />
      </BentoCell>

      <BentoCell span={3} spanMd={3}>
        <SupplierList title={t('insights.suppliers.best')} description={t('insights.suppliers.bestHint')} rows={data.suppliers.best} tone="success" />
      </BentoCell>
      <BentoCell span={3} spanMd={3}>
        <SupplierList title={t('insights.suppliers.worst')} description={t('insights.suppliers.worstHint')} rows={data.suppliers.worst} tone="danger" />
      </BentoCell>

      <BentoCell span={6} spanMd={3}>
        <AgencyTable rows={data.agencies} />
      </BentoCell>
    </BentoGrid>
  );
}

// ---------------------------------------------------------------------------
// Pass, fail and inconclusive by month
// ---------------------------------------------------------------------------

const SERIES = [
  { key: 'pass', fill: 'bg-success-fill', labelKey: 'enum.reportResult.PASS' },
  { key: 'inconclusive', fill: 'bg-warning-fill', labelKey: 'enum.reportResult.INCONCLUSIVE' },
  { key: 'fail', fill: 'bg-danger-fill', labelKey: 'enum.reportResult.FAIL' },
] as const;

/**
 * Stacked columns, one per month. Status colours because the three series ARE
 * statuses; the legend names them, every column has a tooltip with exact
 * figures, and the table view gives the numbers without the picture.
 */
function MonthlyResults({ months }: { months: InsightsResponse['months'] }): React.JSX.Element {
  const { t } = useI18n();
  const [asTable, setAsTable] = useState(false);
  const monthName = new Intl.DateTimeFormat(displayLocaleOf(), { month: 'short', year: '2-digit', timeZone: 'UTC' });
  const label = (month: string): string => monthName.format(new Date(`${month}-01T00:00:00Z`));
  const max = months.reduce((top, row) => Math.max(top, row.pass + row.fail + row.inconclusive), 0);

  return (
    <ConsoleCard
      title={t('insights.monthly.title')}
      description={t('insights.monthly.description')}
      className="h-full"
      bodyClassName="px-4 pb-4 pt-2"
      actions={
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={asTable}
          onClick={() => {
            setAsTable((value) => !value);
          }}
        >
          {asTable ? t('insights.monthly.asChart') : t('dashboard.staff.chart.viewAsTable')}
        </Button>
      }
    >
      <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        {SERIES.map((series) => (
          <li key={series.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className={cx('h-2.5 w-2.5 rounded-sm', series.fill)} />
            {t(series.labelKey)}
          </li>
        ))}
      </ul>
      {asTable ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('insights.monthly.title')}</caption>
            <thead>
              <tr className="text-left text-xs text-ink-subtle">
                <th scope="col" className="py-1 pr-3 font-medium">{t('insights.monthly.month')}</th>
                {SERIES.map((series) => (
                  <th key={series.key} scope="col" className="py-1 pr-3 text-right font-medium">{t(series.labelKey)}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {months.map((row) => (
                <tr key={row.month}>
                  <th scope="row" className="py-1 pr-3 text-left font-normal text-ink">{label(row.month)}</th>
                  {SERIES.map((series) => (
                    <td key={series.key} className="py-1 pr-3 text-right tabular text-ink">{formatNumber(row[series.key])}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : max === 0 ? (
        <p className="py-16 text-center text-sm text-ink-subtle">{t('insights.monthly.empty')}</p>
      ) : (
        <div className="flex h-48 items-end gap-1.5 border-b border-console-border/70" role="img" aria-label={t('insights.monthly.aria')}>
          {months.map((row) => {
            const total = row.pass + row.fail + row.inconclusive;
            const tip = t('insights.monthly.tip', {
              month: label(row.month),
              pass: formatNumber(row.pass),
              fail: formatNumber(row.fail),
              inconclusive: formatNumber(row.inconclusive),
            });
            return (
              <div key={row.month} className="group relative flex h-full min-w-0 flex-1 flex-col items-center justify-end" title={tip}>
                <span className="mb-1 text-xxs tabular text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100">{total === 0 ? '' : formatNumber(total)}</span>
                <div className="flex w-full max-w-8 flex-col-reverse gap-0.5 overflow-hidden rounded-t" style={{ height: `${String((total / max) * 85)}%` }}>
                  {SERIES.map((series) =>
                    row[series.key] === 0 ? null : (
                      <span key={series.key} className={cx('w-full', series.fill)} style={{ flexGrow: row[series.key] }} />
                    ),
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {asTable || max === 0 ? null : (
        <div className="mt-1.5 flex gap-1.5" aria-hidden="true">
          {months.map((row) => (
            <span key={row.month} className="min-w-0 flex-1 truncate text-center text-xxs text-ink-subtle">
              {label(row.month)}
            </span>
          ))}
        </div>
      )}
    </ConsoleCard>
  );
}

// ---------------------------------------------------------------------------
// Suppliers and agencies
// ---------------------------------------------------------------------------

function SupplierList({
  title,
  description,
  rows,
  tone,
}: {
  title: string;
  description: string;
  rows: InsightSupplier[];
  tone: 'success' | 'danger';
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <ConsoleCard title={title} description={description} className="h-full" bodyClassName="px-3 py-3">
      {rows.length === 0 ? (
        <p className="px-2 py-8 text-center text-sm text-ink-subtle">{t('insights.suppliers.empty')}</p>
      ) : (
        <ol className="space-y-0.5">
          {rows.map((row, index) => (
            <li key={row.sellerAccountId}>
              <Link to={`/sellers/${row.sellerAccountId}`} className="group block rounded-md px-2 py-2 transition-colors hover:bg-surface-hover/60">
                <span className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-xs font-medium text-ink">
                    <span className="mr-2 tabular text-ink-subtle">{formatNumber(index + 1)}.</span>
                    {row.name}
                  </span>
                  <span className="shrink-0 tabular text-sm font-semibold text-ink">
                    {formatNumber(row.passRatePercent)}%
                    <span className="ml-1 text-xxs font-normal text-ink-subtle">
                      {t('insights.suppliers.of', { pass: formatNumber(row.pass), reports: formatNumber(row.reports) })}
                    </span>
                  </span>
                </span>
                <span className="mt-1.5 block h-2 w-full rounded-full bg-console-border/50" aria-hidden="true">
                  <span
                    className={cx('block h-full rounded-full', tone === 'success' ? 'bg-success-fill' : 'bg-danger-fill')}
                    style={{ width: `${String(Math.max(row.passRatePercent === 0 ? 0 : 2, row.passRatePercent))}%` }}
                  />
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </ConsoleCard>
  );
}

function AgencyTable({ rows }: { rows: InsightsResponse['agencies'] }): React.JSX.Element {
  const { t } = useI18n();
  const percent = (value: number | null): string => (value === null ? '—' : `${formatNumber(value)}%`);
  const columns: Column<InsightsResponse['agencies'][number]>[] = [
    {
      key: 'name',
      header: t('insights.agencies.agency'),
      render: (row) => (
        <Link className="font-medium text-accent hover:underline" to={`/jobs?agency=${row.agencyId}`}>
          {row.name}
        </Link>
      ),
    },
    { key: 'kind', header: t('insights.agencies.kind'), secondary: true, render: (row) => agencyKindLabel(t, row.kind as AgencyKind) },
    { key: 'completed', header: t('insights.agencies.completed'), align: 'right', render: (row) => formatNumber(row.completed) },
    {
      key: 'onTime',
      header: t('insights.agencies.onTime'),
      align: 'right',
      render: (row) => <span className={row.onTimePercent !== null && row.onTimePercent < 90 ? 'font-semibold text-warning' : ''}>{percent(row.onTimePercent)}</span>,
    },
    { key: 'passRate', header: t('insights.agencies.passRate'), align: 'right', render: (row) => percent(row.passRatePercent) },
  ];

  return (
    <ConsoleCard title={t('insights.agencies.title')} description={t('insights.agencies.description')}>
      <ResponsiveTable
        caption={t('insights.agencies.title')}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.agencyId}
        emptyTitle={t('insights.agencies.empty')}
        card={(row) => (
          <div className="space-y-1.5">
            <Link className="font-medium text-accent hover:underline" to={`/jobs?agency=${row.agencyId}`}>
              {row.name}
            </Link>
            <CardField label={t('insights.agencies.completed')}>{formatNumber(row.completed)}</CardField>
            <CardField label={t('insights.agencies.onTime')}>{percent(row.onTimePercent)}</CardField>
            <CardField label={t('insights.agencies.passRate')}>{percent(row.passRatePercent)}</CardField>
          </div>
        )}
      />
    </ConsoleCard>
  );
}
