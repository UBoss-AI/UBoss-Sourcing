/**
 * Product analytics and its reconciliation (checklist LIVE-020, Section 17).
 *
 * The counters are anonymous daily totals sent by the storefront. They are
 * only worth reading if they agree with the business, so the first table
 * compares each client-reported business event with the table that IS that
 * business - confirmed checkouts with orders placed, RFQ submissions with
 * requests submitted, and so on. The source is always the authority; the
 * client figure is expected to be a little lower (browsers that ask not to be
 * counted send nothing), and a number above the source is a defect.
 */
import { useQuery } from '@tanstack/react-query';
import { DataTable, type Column } from '@/components/DataTable';
import { Badge, Card } from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';

export interface ReconciliationRow {
  event: string;
  source: string;
  analytics: number;
  sourceCount: number;
  difference: number;
  coverage: number | null;
  overReported: boolean;
}

interface Summary {
  topScreens: { screen: string; surface: string; views: number }[];
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

export function AnalyticsReconciliation({ range }: { range: { from: string; to: string } }): React.JSX.Element {
  const { t } = useI18n();
  const query = { from: day(range.from), to: day(range.to) };
  const reconciliation = useQuery({
    queryKey: ['analytics', 'reconciliation', query],
    queryFn: () => api.get<{ timeZone: string; rows: ReconciliationRow[] }>('/admin/analytics/reconciliation', { query }),
  });
  const summary = useQuery({
    queryKey: ['analytics', 'summary', query],
    queryFn: () => api.get<Summary>('/admin/analytics/summary', { query }),
  });

  const columns: Column<ReconciliationRow>[] = [
    { key: 'event', header: t('analytics.event'), render: (row) => t(`analytics.events.${row.event}` as 'analytics.events.checkout_completed', { defaultValue: row.event }) },
    { key: 'analytics', header: t('analytics.counted'), align: 'right', render: (row) => formatNumber(row.analytics) },
    { key: 'source', header: t('analytics.source'), align: 'right', render: (row) => formatNumber(row.sourceCount) },
    {
      key: 'coverage',
      header: t('analytics.coverage'),
      align: 'right',
      render: (row) =>
        row.coverage === null ? (
          '—'
        ) : (
          <Badge tone={row.overReported ? 'danger' : 'neutral'}>{`${String(row.coverage)}%`}</Badge>
        ),
    },
  ];

  const screenColumns: Column<Summary['topScreens'][number]>[] = [
    { key: 'screen', header: t('analytics.screen'), render: (row) => <span className="font-mono text-xxs">{row.screen}</span> },
    { key: 'surface', header: t('analytics.surface'), render: (row) => row.surface },
    { key: 'views', header: t('analytics.views'), align: 'right', render: (row) => formatNumber(row.views) },
  ];

  return (
    <Card title={t('analytics.title')} description={t('analytics.description')}>
      <DataTable
        caption={t('analytics.reconciliationCaption')}
        columns={columns}
        rows={reconciliation.data?.rows ?? []}
        rowKey={(row) => row.event}
        isLoading={reconciliation.isLoading}
        error={reconciliation.error}
        onRetry={() => { void reconciliation.refetch(); }}
        emptyTitle={t('analytics.empty')}
      />
      <p className="mt-2 text-xs text-ink-muted">{t('analytics.explanation')}</p>
      <h3 className="mt-5 text-sm font-semibold text-ink">{t('analytics.topScreens')}</h3>
      <DataTable
        caption={t('analytics.topScreens')}
        columns={screenColumns}
        rows={summary.data?.topScreens ?? []}
        rowKey={(row) => `${row.surface}:${row.screen}`}
        isLoading={summary.isLoading}
        error={summary.error}
        onRetry={() => { void summary.refetch(); }}
        emptyTitle={t('analytics.empty')}
      />
    </Card>
  );
}
