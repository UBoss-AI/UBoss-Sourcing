/**
 * Signed inspection reports, newest first: the agency's own, or every
 * agency's for audit staff. A correction and a superseded revision are marked
 * in words, so nobody quotes an old revision as the current one.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CardField, DownloadButton, EnumBadge, QueryBoundary, ResponsiveTable } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { Badge, Card, Input, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchReports, reportPdfPath } from '@/lib/console-api';
import type { ReportRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDateTime, formatNumber } from '@/lib/format';
import { agencyKindLabel } from '@/lib/labels';
import { useDebounced } from '@/lib/use-debounced';

export function ReportsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [result, setResult] = useState('');
  const [search, setSearch] = useState('');
  const settled = useDebounced(search.trim());
  const filters = { ...(result === '' ? {} : { result }), ...(settled === '' ? {} : { search: settled }) };

  const query = useQuery({
    queryKey: consoleKeys.reports(filters),
    queryFn: () => fetchReports(filters),
    placeholderData: keepPreviousData,
  });

  const markers = (row: ReportRow): React.JSX.Element | null =>
    row.isCorrection || row.superseded ? (
      <span className="flex flex-wrap gap-1">
        {row.isCorrection && <Badge tone="accent">{t('reports.correction')}</Badge>}
        {row.superseded && <Badge tone="warning">{t('reports.superseded')}</Badge>}
      </span>
    ) : null;

  const pdf = (row: ReportRow): React.JSX.Element => (
    <DownloadButton
      path={reportPdfPath(row.id)}
      fileName={`${row.jobNumber}-r${String(row.revision)}.pdf`}
      label={t('reports.pdf')}
      variant="ghost"
    />
  );

  const columns: Column<ReportRow>[] = [
    {
      key: 'job',
      header: t('reports.column.job'),
      nowrap: true,
      render: (row) => (
        <Link to={`/jobs/${encodeURIComponent(row.jobId)}`} className="font-medium text-accent hover:underline">
          {row.jobNumber}
        </Link>
      ),
    },
    {
      key: 'seller',
      header: t('reports.column.seller'),
      render: (row) => (
        <div>
          <p>{row.sellerName}</p>
          <p className="text-xs text-ink-muted">{row.sellerOrderNumber}</p>
        </div>
      ),
    },
    { key: 'result', header: t('reports.column.result'), render: (row) => <EnumBadge family="reportResult" value={row.result} /> },
    {
      key: 'stage',
      header: t('reports.column.stageMethod'),
      secondary: true,
      render: (row) => (
        <div className="text-xs">
          <p>{enumLabel(t, 'stage', row.stage)}</p>
          <p className="text-ink-muted">{enumLabel(t, 'scopeMethod', row.scopeMethod)}</p>
        </div>
      ),
    },
    {
      key: 'agency',
      header: t('reports.column.agency'),
      tertiary: true,
      render: (row) => (
        <div className="text-xs">
          <p className="text-sm">{row.agencyName}</p>
          <p className="text-ink-muted">{agencyKindLabel(t, row.agencyKind)}</p>
        </div>
      ),
    },
    {
      key: 'revision',
      header: t('reports.column.revision'),
      render: (row) => (
        <div className="space-y-1">
          <span className="tabular">{formatNumber(row.revision)}</span>
          {markers(row)}
        </div>
      ),
    },
    {
      key: 'signed',
      header: t('reports.column.signedOff'),
      secondary: true,
      render: (row) => (
        <div className="text-xs">
          <p>{formatDateTime(row.signedAt)}</p>
          {row.signedByName !== null && <p className="text-ink-muted">{t('reports.signedOffBy', { name: row.signedByName })}</p>}
        </div>
      ),
    },
    { key: 'pdf', header: <span className="sr-only">{t('reports.pdf')}</span>, align: 'right', render: pdf },
  ];

  return (
    <>
      <PageHeader title={t('screens.reports.title')} description={t('screens.reports.description')} />
      <Card>
        <Toolbar>
          <ToolbarField label={t('common.search')} grow>
            <Input
              type="search"
              value={search}
              placeholder={t('reports.searchPlaceholder')}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </ToolbarField>
          <ToolbarField label={t('reports.column.result')}>
            <Select
              value={result}
              onChange={(event) => {
                setResult(event.target.value);
              }}
            >
              <option value="">{t('common.all')}</option>
              {['PASS', 'FAIL', 'INCONCLUSIVE'].map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'reportResult', value)}
                </option>
              ))}
            </Select>
          </ToolbarField>
        </Toolbar>
        <QueryBoundary query={query}>
          {(data) => (
            <ResponsiveTable
              caption={t('screens.reports.title')}
              rows={data.reports}
              rowKey={(row) => row.id}
              columns={columns}
              minWidth="56rem"
              isRefreshing={query.isFetching && query.isPlaceholderData}
              emptyTitle={t('reports.empty')}
              emptyDescription={t('reports.emptyHint')}
              card={(row) => (
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <Link to={`/jobs/${encodeURIComponent(row.jobId)}`} className="font-medium text-accent hover:underline">
                        {row.jobNumber}
                      </Link>
                      <p className="text-sm">{row.sellerName}</p>
                    </div>
                    <EnumBadge family="reportResult" value={row.result} />
                  </div>
                  {markers(row)}
                  <CardField label={t('reports.column.revision')}>{formatNumber(row.revision)}</CardField>
                  <CardField label={t('reports.column.signedOff')}>{formatDateTime(row.signedAt)}</CardField>
                  <CardField label={t('reports.column.agency')}>{row.agencyName}</CardField>
                  {pdf(row)}
                </div>
              )}
            />
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}
