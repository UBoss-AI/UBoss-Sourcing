/**
 * Documents and expiry: every seller's compliance documents, filterable by
 * review status and by how soon an approved one stops being valid.
 *
 *   GET /api/v1/audit/documents      the list
 *   GET /api/v1/audit/documents/:id  one document, opened over the list
 *
 * The address bar carries the filters and the open document, so a
 * notification (`/documents?document=<id>`) or a dashboard tile
 * (`?status=SUBMITTED`, `?expiring=30`) lands on exactly that view.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CardField, EnumBadge, QueryBoundary, ResponsiveTable } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { Button, Card, Input, PageHeader, Select, Toolbar, ToolbarActions, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchDocuments } from '@/lib/console-api';
import type { DocumentRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatCalendarDate } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { DOCUMENT_STATUSES, EXPIRY_WINDOWS, pick } from './compliance/compliance-constants';
import { DocumentDetailDialog } from './compliance/DocumentDetail';

export function DocumentsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search.trim());

  const status = pick(params.get('status'), DOCUMENT_STATUSES);
  const expiring = pick(params.get('expiring'), EXPIRY_WINDOWS.map(String));
  const openId = params.get('document');

  const setParam = (name: string, value: string | null): void => {
    const copy = new URLSearchParams(params);
    if (value === null || value === '') copy.delete(name);
    else copy.set(name, value);
    setParams(copy, { replace: name !== 'document' });
  };

  const filters = {
    ...(status === '' ? {} : { status }),
    ...(expiring === '' ? {} : { expiringWithinDays: Number(expiring) }),
    ...(debounced === '' ? {} : { search: debounced }),
  };
  const query = useQuery({
    queryKey: consoleKeys.documents(filters),
    queryFn: () => fetchDocuments(filters),
    placeholderData: keepPreviousData,
  });

  const openButton = (row: DocumentRow): React.JSX.Element => (
    <button
      type="button"
      className="text-left font-medium text-accent hover:underline"
      onClick={() => {
        setParam('document', row.id);
      }}
    >
      {row.standard}
    </button>
  );

  const columns: Column<DocumentRow>[] = [
    {
      key: 'document',
      header: t('documents.col.document'),
      render: (row) => (
        <div className="min-w-0">
          {openButton(row)}
          <p className="text-xs text-ink-muted">{enumLabel(t, 'documentType', row.documentType)}</p>
        </div>
      ),
    },
    { key: 'seller', header: t('documents.col.seller'), render: (row) => row.sellerName },
    { key: 'issuer', header: t('documents.issuer'), secondary: true, render: (row) => row.issuer },
    {
      key: 'status',
      header: t('common.status'),
      render: (row) => (
        <div className="flex flex-col items-start gap-1">
          <EnumBadge family="documentStatus" value={row.reviewStatus} />
          {row.badge !== null && <EnumBadge family="documentBadge" value={row.badge} dot={false} />}
        </div>
      ),
    },
    {
      key: 'codes',
      header: t('documents.col.requirements'),
      tertiary: true,
      render: (row) => (row.requirementCodes.length === 0 ? '—' : <span className="font-mono text-xs">{row.requirementCodes.join(', ')}</span>),
    },
    { key: 'expires', header: t('documents.col.expires'), nowrap: true, render: (row) => formatCalendarDate(row.expiresOn) },
  ];

  const filtered = search !== '' || status !== '' || expiring !== '';

  return (
    <>
      <PageHeader title={t('screens.documents.title')} description={t('screens.documents.description')} />

      <Card>
        <Toolbar>
          <ToolbarField label={t('common.search')} grow>
            <Input
              type="search"
              value={search}
              placeholder={t('documents.searchPlaceholder')}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </ToolbarField>
          <ToolbarField label={t('common.status')}>
            <Select
              value={status}
              onChange={(event) => {
                setParam('status', event.target.value);
              }}
            >
              <option value="">{t('common.all')}</option>
              {DOCUMENT_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'documentStatus', value)}
                </option>
              ))}
            </Select>
          </ToolbarField>
          <ToolbarField label={t('documents.expiringFilter')}>
            <Select
              value={expiring}
              onChange={(event) => {
                setParam('expiring', event.target.value);
              }}
            >
              <option value="">{t('documents.anyExpiry')}</option>
              {EXPIRY_WINDOWS.map((days) => (
                <option key={days} value={String(days)}>
                  {t('documents.withinDays', { days: String(days) })}
                </option>
              ))}
            </Select>
          </ToolbarField>
          {filtered && (
            <ToolbarActions>
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  const copy = new URLSearchParams(params);
                  copy.delete('status');
                  copy.delete('expiring');
                  setParams(copy, { replace: true });
                }}
              >
                {t('common.clearFilters')}
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>
        {expiring !== '' && (
          <p className="border-b border-border-subtle px-4 py-2 text-xs text-ink-muted">{t('documents.expiringNote')}</p>
        )}
        <QueryBoundary query={query}>
          {(data) => (
            <ResponsiveTable
              caption={t('screens.documents.title')}
              columns={columns}
              rows={data.documents}
              rowKey={(row) => row.id}
              minWidth="52rem"
              isRefreshing={query.isFetching}
              emptyTitle={filtered ? t('documents.emptyFiltered') : t('documents.empty')}
              card={(row) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    {openButton(row)}
                    <EnumBadge family="documentStatus" value={row.reviewStatus} />
                  </div>
                  <CardField label={t('documents.col.seller')}>{row.sellerName}</CardField>
                  <CardField label={t('documents.col.type')}>{enumLabel(t, 'documentType', row.documentType)}</CardField>
                  <CardField label={t('documents.col.expires')}>{formatCalendarDate(row.expiresOn)}</CardField>
                  {row.badge !== null && <EnumBadge family="documentBadge" value={row.badge} dot={false} />}
                </div>
              )}
            />
          )}
        </QueryBoundary>
      </Card>

      {openId !== null && openId !== '' && (
        <DocumentDetailDialog
          key={openId}
          documentId={openId}
          onClose={() => {
            setParam('document', null);
          }}
        />
      )}
    </>
  );
}
