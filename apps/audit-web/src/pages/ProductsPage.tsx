/**
 * Product compliance: every PRODUCT-level case, and one case in detail.
 *
 *   ProductsPage:     GET /api/v1/audit/products
 *   ProductCasePage:  GET /api/v1/audit/cases/:id (the same screen as a qualification case)
 */
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CardField, EnumBadge, QueryBoundary, ResponsiveTable } from '@/components/console';
import type { Column } from '@/components/DataTable';
import { Button, Card, Input, PageHeader, Select, Toolbar, ToolbarActions, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { consoleKeys, fetchProductCases } from '@/lib/console-api';
import type { CaseRow } from '@/lib/console-types';
import { enumLabel } from '@/lib/enum-labels';
import { formatDateTime } from '@/lib/format';
import { useDebounced } from '@/lib/use-debounced';
import { CaseDetailView } from './compliance/CaseDetailView';
import { CASE_STATUSES } from './compliance/compliance-constants';

export function ProductsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const debounced = useDebounced(search.trim());
  const filters = { ...(status === '' ? {} : { status }), ...(debounced === '' ? {} : { search: debounced }) };
  const query = useQuery({
    queryKey: consoleKeys.products(filters),
    queryFn: () => fetchProductCases(filters),
    placeholderData: keepPreviousData,
  });

  const columns: Column<CaseRow>[] = [
    {
      key: 'case',
      header: t('products.col.case'),
      nowrap: true,
      render: (row) => (
        <Link className="font-mono text-xs font-semibold text-accent hover:underline" to={`/products/${row.id}`}>
          {row.caseNumber}
        </Link>
      ),
    },
    { key: 'product', header: t('products.col.product'), render: (row) => row.productName ?? t('products.unknownProduct') },
    { key: 'seller', header: t('products.col.seller'), render: (row) => row.sellerName },
    { key: 'category', header: t('products.col.category'), secondary: true, render: (row) => row.categoryName },
    { key: 'role', header: t('products.col.role'), tertiary: true, render: (row) => enumLabel(t, 'supplyRole', row.supplyRole) },
    { key: 'status', header: t('common.status'), render: (row) => <EnumBadge family="caseStatus" value={row.status} /> },
    { key: 'updated', header: t('products.col.updated'), secondary: true, nowrap: true, render: (row) => formatDateTime(row.updatedAt) },
  ];

  return (
    <>
      <PageHeader title={t('screens.products.title')} description={t('screens.products.description')} />
      <Card>
        <Toolbar>
          <ToolbarField label={t('common.search')} grow>
            <Input
              type="search"
              value={search}
              placeholder={t('products.searchPlaceholder')}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </ToolbarField>
          <ToolbarField label={t('common.status')}>
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            >
              <option value="">{t('common.all')}</option>
              {CASE_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {enumLabel(t, 'caseStatus', value)}
                </option>
              ))}
            </Select>
          </ToolbarField>
          {(search !== '' || status !== '') && (
            <ToolbarActions>
              <Button
                variant="ghost"
                onClick={() => {
                  setSearch('');
                  setStatus('');
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
              caption={t('screens.products.title')}
              columns={columns}
              rows={data.cases}
              rowKey={(row) => row.id}
              minWidth="52rem"
              isRefreshing={query.isFetching}
              emptyTitle={t('products.empty')}
              emptyDescription={t('products.emptyBody')}
              card={(row) => (
                <div className="space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <Link className="font-medium text-accent hover:underline" to={`/products/${row.id}`}>
                      {row.productName ?? t('products.unknownProduct')}
                    </Link>
                    <EnumBadge family="caseStatus" value={row.status} />
                  </div>
                  <CardField label={t('products.col.case')}>
                    <span className="font-mono">{row.caseNumber}</span>
                  </CardField>
                  <CardField label={t('products.col.seller')}>{row.sellerName}</CardField>
                  <CardField label={t('products.col.category')}>{row.categoryName}</CardField>
                </div>
              )}
            />
          )}
        </QueryBoundary>
      </Card>
    </>
  );
}

export function ProductCasePage(): React.JSX.Element {
  const { t } = useI18n();
  const { caseId = '' } = useParams();

  return <CaseDetailView caseId={caseId} back={{ to: '/products', label: t('screens.productCase.back') }} />;
}
