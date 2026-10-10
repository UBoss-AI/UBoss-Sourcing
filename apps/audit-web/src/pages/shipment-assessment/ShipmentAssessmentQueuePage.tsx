/**
 * Shipment Assessment: the queues between L1 and L2.
 *
 *   GET /api/v1/audit/shipment-assessments   a page of cases, with a count per queue
 *
 * One tab per question: what is ready to assess, what is in progress, what is
 * waiting for QA or a waiver decision, what is released, what is blocked, and
 * what was already waiting when the feature was switched on. Oldest L1 arrival
 * first. The tab lives in the address bar so a notification lands on it.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CardField, QueryBoundary, ResponsiveTable, Tabs } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { Badge, Button, Callout, Card, Input, LinkButton, PageHeader, Toolbar, ToolbarActions, ToolbarField } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { assessmentKeys, fetchAssessments, QUEUES, type AssessmentRow, type Queue } from '@/lib/shipment-assessment';
import { useDebounced } from '@/lib/use-debounced';
import { BadgeTierBadge, StatusBadge } from './status';

export function ShipmentAssessmentQueuePage(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());
  const [page, setPage] = useState(1);
  const queue: Queue = (QUEUES as readonly string[]).includes(params.get('queue') ?? '') ? (params.get('queue') as Queue) : 'ready';
  const filters = { queue, search: debounced, page };
  const query = useQuery({ queryKey: assessmentKeys.list(filters), queryFn: () => fetchAssessments(filters), placeholderData: keepPreviousData });
  const counts = query.data?.counts ?? {};

  const open = (row: AssessmentRow): React.JSX.Element => (
    <Link className="font-medium text-accent hover:underline" to={`/shipment-assessment/${row.id}`}>
      {row.number}
    </Link>
  );

  const decision = (row: AssessmentRow): React.JSX.Element => (
    <div className="flex flex-col items-start gap-1 text-xs">
      <StatusBadge status={row.status} />
      {row.releaseDeadline !== null && <span>{t('shipmentAssessment.dispatchBy', { date: formatDateTime(row.releaseDeadline) })}</span>}
      {row.certificate !== null && <span className="text-ink-muted">{t(`shipmentAssessment.docKind.${row.certificate}` as TranslationKey)}</span>}
    </div>
  );

  const columns: Column<AssessmentRow>[] = [
    {
      key: 'ref',
      header: t('shipmentAssessment.col.shipment'),
      render: (row) => (
        <div className="min-w-0">
          {open(row)}
          <p className="text-xs text-ink-muted">
            {row.orderNumber} · {row.sellerOrderNumber}
          </p>
          {row.existingAtRollout && <Badge tone="warning">{t('shipmentAssessment.existingAtRollout')}</Badge>}
        </div>
      ),
    },
    {
      key: 'seller',
      header: t('shipmentAssessment.col.seller'),
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <span className="break-words">{row.seller}</span>
          <BadgeTierBadge tier={row.badge} />
        </div>
      ),
    },
    {
      key: 'goods',
      header: t('shipmentAssessment.col.goods'),
      secondary: true,
      nowrap: true,
      render: (row) => t('shipmentAssessment.goodsSummary', { lines: String(row.lines), units: String(row.units) }),
    },
    {
      key: 'l1',
      header: t('shipmentAssessment.col.l1'),
      secondary: true,
      render: (row) => (row.l1CompletedAt === null ? <span className="text-ink-muted">{t('shipmentAssessment.l1Pending')}</span> : `${formatDateTime(row.l1CompletedAt)} · ${row.l1Location ?? '—'}`),
    },
    { key: 'l2', header: t('shipmentAssessment.col.plannedL2'), tertiary: true, nowrap: true, render: (row) => formatDateTime(row.plannedL2At) },
    {
      key: 'requirement',
      header: t('shipmentAssessment.col.requirement'),
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <Badge tone={row.requirement === 'ASSESSMENT_REQUIRED' ? 'neutral' : 'brand'}>{t(`shipmentAssessment.requirement.${row.requirement}` as TranslationKey)}</Badge>
          <span className="text-xs text-ink-muted">{row.requirementReason}</span>
        </div>
      ),
    },
    {
      key: 'people',
      header: t('shipmentAssessment.col.people'),
      tertiary: true,
      render: (row) => (
        <span className="text-xs">
          {row.assessor ?? '—'} / {row.qaReviewer ?? '—'}
        </span>
      ),
    },
    { key: 'decision', header: t('shipmentAssessment.col.decision'), render: decision },
  ];

  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <>
      <PageHeader
        title={t('shipmentAssessment.title')}
        description={t('shipmentAssessment.description')}
        actions={
          <LinkButton to="/shipment-assessment/policy" variant="secondary">
            {t('shipmentAssessment.policy.open')}
          </LinkButton>
        }
      />
      <Tabs
        label={t('shipmentAssessment.queues')}
        tabs={QUEUES.map((key) => ({
          key,
          label: t(`shipmentAssessment.queue.${key}` as TranslationKey),
          ...((counts[key] ?? 0) === 0 ? {} : { badge: <Badge tone={key === 'failed' || key === 'rollout' ? 'warning' : 'brand'}>{String(counts[key] ?? 0)}</Badge> }),
        }))}
        selected={queue}
        onSelect={(key) => {
          const copy = new URLSearchParams(params);
          copy.set('queue', key);
          setParams(copy, { replace: true });
          setPage(1);
        }}
      >
        {queue === 'rollout' && (
          <Callout tone="info" className="mb-4">
            {t('shipmentAssessment.rolloutHint')}
          </Callout>
        )}
        <Card>
          <Toolbar>
            <ToolbarField label={t('common.search')} grow>
              <Input
                type="search"
                value={search}
                placeholder={t('shipmentAssessment.searchPlaceholder')}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setPage(1);
                }}
              />
            </ToolbarField>
            {search !== '' && (
              <ToolbarActions>
                <Button
                  variant="ghost"
                  onClick={() => {
                    setSearch('');
                  }}
                >
                  {t('common.clearFilters')}
                </Button>
              </ToolbarActions>
            )}
          </Toolbar>
          <QueryBoundary query={query}>
            {(data) => (
              <ResponsiveTable
                caption={t('shipmentAssessment.title')}
                columns={columns}
                rows={data.rows}
                rowKey={(row) => row.id}
                minWidth="64rem"
                isRefreshing={query.isFetching}
                emptyTitle={search === '' ? t('shipmentAssessment.empty') : t('shipmentAssessment.emptyFiltered')}
                card={(row) => (
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      {open(row)}
                      <StatusBadge status={row.status} />
                    </div>
                    <CardField label={t('shipmentAssessment.col.seller')}>
                      {row.seller} <BadgeTierBadge tier={row.badge} />
                    </CardField>
                    <CardField label={t('shipmentAssessment.col.requirement')}>{t(`shipmentAssessment.requirement.${row.requirement}` as TranslationKey)}</CardField>
                    <CardField label={t('shipmentAssessment.col.l1')}>{formatDateTime(row.l1CompletedAt)}</CardField>
                    {row.releaseDeadline !== null && <CardField label={t('shipmentAssessment.col.deadline')}>{formatDateTime(row.releaseDeadline)}</CardField>}
                  </div>
                )}
              />
            )}
          </QueryBoundary>
          {pages > 1 && (
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-4 py-3 text-sm text-ink-muted">
              <span>{t('sellerVerification.pageOf', { page: String(page), pages: String(pages) })}</span>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => {
                    setPage((value) => Math.max(1, value - 1));
                  }}
                >
                  {t('sellerVerification.previous')}
                </Button>
                <Button
                  size="sm"
                  disabled={page >= pages}
                  onClick={() => {
                    setPage((value) => Math.min(pages, value + 1));
                  }}
                >
                  {t('sellerVerification.next')}
                </Button>
              </div>
            </div>
          )}
        </Card>
      </Tabs>
    </>
  );
}
