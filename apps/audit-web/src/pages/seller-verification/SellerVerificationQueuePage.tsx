/**
 * Seller Verification: the Audit Team's queue of seller applications.
 *
 *   GET /api/v1/audit/seller-verification   a page of applications, with a count per queue
 *
 * One tab per question a reviewer is answering: what is new, what am I in the
 * middle of, what is with the seller, and what has come back with
 * corrections. Oldest submission first, because the seller who has waited
 * longest is the one the queue exists to serve. The tab lives in the address
 * bar, so a notification or a link lands on the right queue.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CardField, QueryBoundary, ResponsiveTable, Tabs } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { Badge, Button, Callout, Card, Input, PageHeader, Toolbar, ToolbarActions, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import {
  fetchVerificationQueue,
  verificationKeys,
  type SellerApplicationRow,
  type SellerApplicationStatus,
} from '@/lib/seller-verification';
import { useDebounced } from '@/lib/use-debounced';
import { STATUS_TONE } from './status';

type Queue = 'pending' | 'review' | 'corrections' | 'resubmitted' | 'approved' | 'rejected' | 'all';

const QUEUES: readonly { key: Queue; status: SellerApplicationStatus | null; resubmitted?: true; countKey: string | null }[] = [
  { key: 'pending', status: 'SUBMITTED', countKey: 'SUBMITTED' },
  { key: 'review', status: 'UNDER_REVIEW', countKey: 'UNDER_REVIEW' },
  { key: 'corrections', status: 'ACTION_REQUIRED', countKey: 'ACTION_REQUIRED' },
  { key: 'resubmitted', status: null, resubmitted: true, countKey: 'RESUBMITTED' },
  { key: 'approved', status: 'APPROVED', countKey: null },
  { key: 'rejected', status: 'REJECTED', countKey: null },
  { key: 'all', status: null, countKey: null },
];

export function SellerVerificationQueuePage(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());
  const [page, setPage] = useState(1);

  const queue = QUEUES.find((entry) => entry.key === params.get('queue')) ?? QUEUES[0];
  const filters = {
    status: queue?.status ?? null,
    ...(queue?.resubmitted === true ? { resubmitted: true } : {}),
    search: debounced,
    page,
  };
  const query = useQuery({
    queryKey: verificationKeys.list(filters),
    queryFn: () => fetchVerificationQueue(filters),
    placeholderData: keepPreviousData,
  });
  const counts = query.data?.counts ?? {};

  const openLink = (row: SellerApplicationRow): React.JSX.Element => (
    <Link className="font-medium text-accent hover:underline" to={`/seller-verification/${row.id}`}>
      {row.displayName}
    </Link>
  );

  const statusBadge = (row: SellerApplicationRow): React.JSX.Element => (
    <div className="flex flex-col items-start gap-1">
      <Badge tone={STATUS_TONE[row.status]}>{t(`sellerVerification.status.${row.status}` as TranslationKey)}</Badge>
      {row.resubmitted && <Badge tone="brand">{t('sellerVerification.resubmittedBadge')}</Badge>}
    </div>
  );

  const columns: Column<SellerApplicationRow>[] = [
    {
      key: 'seller',
      header: t('sellerVerification.col.seller'),
      render: (row) => (
        <div className="min-w-0">
          {openLink(row)}
          <p className="break-words text-xs text-ink-muted">{row.legalName}</p>
        </div>
      ),
    },
    { key: 'status', header: t('common.status'), render: statusBadge },
    { key: 'country', header: t('sellerVerification.col.country'), nowrap: true, render: (row) => row.registrationCountry },
    {
      key: 'steps',
      header: t('sellerVerification.col.steps'),
      secondary: true,
      nowrap: true,
      render: (row) => t('sellerVerification.stepsOf', { done: String(row.completedSteps), total: String(row.requiredSteps) }),
    },
    { key: 'documents', header: t('sellerVerification.col.documents'), tertiary: true, render: (row) => String(row.documentCount) },
    { key: 'submitted', header: t('sellerVerification.col.submitted'), nowrap: true, render: (row) => formatDateTime(row.submittedAt) },
  ];

  const total = query.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 25));

  return (
    <>
      <PageHeader title={t('sellerVerification.title')} description={t('sellerVerification.description')} />

      <Tabs
        label={t('sellerVerification.queues')}
        tabs={QUEUES.map((entry) => ({
          key: entry.key,
          label: t(`sellerVerification.queue.${entry.key}` as TranslationKey),
          ...(entry.countKey === null || (counts[entry.countKey] ?? 0) === 0
            ? {}
            : { badge: <Badge tone="brand">{String(counts[entry.countKey] ?? 0)}</Badge> }),
        }))}
        selected={queue?.key ?? 'pending'}
        onSelect={(key) => {
          const copy = new URLSearchParams(params);
          copy.set('queue', key);
          setParams(copy, { replace: true });
          setPage(1);
        }}
      >
        {queue?.key === 'resubmitted' && (
          <Callout tone="info" className="mb-4">
            {t('sellerVerification.resubmittedHint')}
          </Callout>
        )}
        <Card>
          <Toolbar>
            <ToolbarField label={t('common.search')} grow>
              <Input
                type="search"
                value={search}
                placeholder={t('sellerVerification.searchPlaceholder')}
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
                caption={t('sellerVerification.title')}
                columns={columns}
                rows={data.rows}
                rowKey={(row) => row.id}
                minWidth="48rem"
                isRefreshing={query.isFetching}
                emptyTitle={
                  search === ''
                    ? t(`sellerVerification.empty.${queue?.key ?? 'pending'}` as TranslationKey)
                    : t('sellerVerification.emptyFiltered')
                }
                card={(row) => (
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2">
                      {openLink(row)}
                      {statusBadge(row)}
                    </div>
                    <CardField label={t('sellerVerification.col.country')}>{row.registrationCountry}</CardField>
                    <CardField label={t('sellerVerification.col.submitted')}>{formatDateTime(row.submittedAt)}</CardField>
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
