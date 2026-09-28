/**
 * Finance → Commission Invoices.
 *
 * The operator's own invoices to sellers for the platform commission - not the
 * sellers' invoices to buyers, which are theirs and live on the order. Three
 * views of one job:
 *
 *   - **Invoices**: every commission invoice, searched and filtered on the
 *     server (number, seller, order, dates, status, collection, country,
 *     currency) and paged there too, because a marketplace issues one per
 *     seller order and the list grows without bound.
 *   - **Awaiting invoice**: seller orders with a commission and no live
 *     invoice, each saying why it cannot be invoiced yet or offering to start
 *     the draft.
 *   - **Settings**: who the invoices are issued by. Nothing is defaulted, and
 *     the list says what is still missing.
 *
 * The panel never computes a figure. It names a seller order and shows what
 * the server built.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Input, PageHeader, Select, Toolbar, ToolbarField } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatMoney } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  COLLECTION_STATUSES,
  INVOICE_STATUSES,
  commissionApi,
  newIdempotencyKey,
  type CandidateRow,
  type CommissionInvoiceRow,
  type ListFilters,
} from '@/lib/commission-invoices';
import { COLLECTION_TONE, STATUS_TONE, blockerText } from './commission-shared';
import { CommissionSettingsForm } from './CommissionSettingsForm';

type Tab = 'invoices' | 'candidates' | 'settings';
const PAGE_SIZE = 25;

export function CommissionInvoicesPage(): React.JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>('invoices');
  const tabs: { key: Tab; label: string }[] = [
    { key: 'invoices', label: t('commission.tab.invoices') },
    { key: 'candidates', label: t('commission.tab.candidates') },
    { key: 'settings', label: t('commission.tab.settings') },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('commission.title')} description={t('commission.intro')} />
      <div role="tablist" aria-label={t('commission.title')} className="flex flex-wrap gap-1 border-b border-border-subtle">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => {
              setTab(item.key);
            }}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors',
              tab === item.key ? 'border-accent text-accent' : 'border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      {tab === 'invoices' && <InvoiceList />}
      {tab === 'candidates' && <CandidateList />}
      {tab === 'settings' && <CommissionSettingsForm />}
    </div>
  );
}

function InvoiceList(): React.JSX.Element {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<ListFilters>({ page: 1, pageSize: PAGE_SIZE });
  const [search, setSearch] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'commission-invoices', filters],
    queryFn: () => commissionApi.list(filters),
    placeholderData: (previous) => previous,
  });

  function update(patch: Partial<ListFilters>): void {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  const columns: Column<CommissionInvoiceRow>[] = [
    {
      key: 'number',
      header: t('commission.column.number'),
      nowrap: true,
      render: (row) => (
        <Link to={`/finance/commission-invoices/${row.id}`} className="font-mono text-sm text-accent hover:underline">
          {row.number ?? t('commission.draftNumber')}
        </Link>
      ),
    },
    {
      key: 'seller',
      header: t('commission.column.seller'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.sellerName}</p>
          <p className="truncate font-mono text-xxs text-ink-subtle">{row.sellerAccountId}</p>
        </div>
      ),
    },
    {
      key: 'order',
      header: t('commission.column.order'),
      secondary: true,
      nowrap: true,
      render: (row) => (
        <Link to={`/orders/${row.orderId}`} className="text-sm text-ink hover:underline">
          {row.orderNumber}
          <span className="block text-xxs text-ink-subtle">{row.sellerOrderNumber}</span>
        </Link>
      ),
    },
    {
      key: 'status',
      header: t('commission.column.status'),
      align: 'center',
      render: (row) => (
        <div className="flex flex-col items-center gap-1">
          <Badge tone={STATUS_TONE[row.status] ?? 'neutral'}>{t(`commission.status.${row.status}` as TranslationKey)}</Badge>
          {row.hasIssues && row.status === 'DRAFT' && <span className="text-xxs text-warning">{t('commission.needsAttention')}</span>}
          {row.creditSuggestion !== null && <span className="text-xxs text-warning">{t('commission.creditDue')}</span>}
        </div>
      ),
    },
    {
      key: 'collection',
      header: t('commission.column.collection'),
      tertiary: true,
      secondary: true,
      align: 'center',
      render: (row) =>
        row.status === 'DRAFT' || row.status === 'VOID' ? (
          <span className="text-xs text-ink-subtle">—</span>
        ) : (
          <Badge tone={COLLECTION_TONE[row.collectionStatus] ?? 'neutral'}>{t(`commission.collection.${row.collectionStatus}` as TranslationKey)}</Badge>
        ),
    },
    {
      key: 'total',
      header: t('commission.column.total'),
      align: 'right',
      render: (row) => (
        <span className="text-sm text-ink">
          {formatMoney(row.grandTotal)}
          {row.credited.minor !== '0' && <span className="block text-xxs text-ink-subtle">{t('commission.creditedAmount', { amount: formatMoney(row.credited) })}</span>}
        </span>
      ),
    },
    {
      key: 'date',
      header: t('commission.column.date'),
      secondary: true,
      nowrap: true,
      render: (row) => <span className="text-xs text-ink-muted">{formatDate(row.issueDate ?? row.createdAt)}</span>,
    },
  ];

  const data = query.data;
  return (
    <div className="space-y-4">
      <Toolbar>
        <ToolbarField label={t('commission.filter.search')} grow>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              update({ q: search.trim() === '' ? undefined : search.trim() });
            }}
          >
            <Input
              type="search"
              value={search}
              placeholder={t('commission.filter.searchPlaceholder')}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </form>
        </ToolbarField>
        <ToolbarField label={t('commission.filter.status')}>
          <Select
            value={filters.status ?? ''}
            onChange={(event) => {
              update({ status: event.target.value === '' ? undefined : event.target.value });
            }}
          >
            <option value="">{t('commission.filter.any')}</option>
            {INVOICE_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`commission.status.${status}` as TranslationKey)}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('commission.filter.collection')}>
          <Select
            value={filters.collectionStatus ?? ''}
            onChange={(event) => {
              update({ collectionStatus: event.target.value === '' ? undefined : event.target.value });
            }}
          >
            <option value="">{t('commission.filter.any')}</option>
            {COLLECTION_STATUSES.map((status) => (
              <option key={status} value={status}>
                {t(`commission.collection.${status}` as TranslationKey)}
              </option>
            ))}
          </Select>
        </ToolbarField>
        <ToolbarField label={t('commission.filter.country')}>
          <Input
            maxLength={2}
            className="uppercase"
            placeholder="IN"
            value={filters.country ?? ''}
            onChange={(event) => {
              const value = event.target.value.toUpperCase();
              update({ country: value.length === 2 ? value : undefined });
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('commission.filter.currency')}>
          <Input
            maxLength={3}
            className="uppercase"
            placeholder="INR"
            onChange={(event) => {
              const value = event.target.value.toUpperCase();
              update({ currency: value.length === 3 ? value : undefined });
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('commission.filter.from')}>
          <Input
            type="date"
            value={filters.from ?? ''}
            onChange={(event) => {
              update({ from: event.target.value === '' ? undefined : event.target.value });
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('commission.filter.to')}>
          <Input
            type="date"
            value={filters.to ?? ''}
            onChange={(event) => {
              update({ to: event.target.value === '' ? undefined : event.target.value });
            }}
          />
        </ToolbarField>
      </Toolbar>
      <DataTable
        caption={t('commission.title')}
        columns={columns}
        rows={data?.items}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        isRefreshing={query.isFetching && !query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle={t('commission.empty.title')}
        emptyDescription={t('commission.empty.description')}
        onRowClick={(row: CommissionInvoiceRow) => {
          void navigate(`/finance/commission-invoices/${row.id}`);
        }}
      />
      {data !== undefined && (
        <Pager
          page={data.page}
          limit={data.pageSize}
          total={data.total}
          totalPages={Math.max(1, Math.ceil(data.total / data.pageSize))}
          onPageChange={(page) => {
            update({ page });
          }}
        />
      )}
    </div>
  );
}

function CandidateList(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const navigate = useNavigate();
  const client = useQueryClient();
  const { can } = useSession();
  const mayGenerate = can(Permission.COMMISSION_INVOICE_GENERATE);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const query = useQuery({
    queryKey: ['admin', 'commission-candidates', q, page],
    queryFn: () => commissionApi.candidates(q, page, PAGE_SIZE),
    placeholderData: (previous) => previous,
  });
  const generate = useMutation({
    mutationFn: (row: CandidateRow) => commissionApi.generate(row.sellerOrderGroupId, newIdempotencyKey()),
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: ['admin', 'commission-candidates'] });
      void client.invalidateQueries({ queryKey: ['admin', 'commission-invoices'] });
      void navigate(`/finance/commission-invoices/${result.invoice.id}`);
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error));
    },
  });

  const columns: Column<CandidateRow>[] = [
    {
      key: 'order',
      header: t('commission.column.order'),
      nowrap: true,
      render: (row) => (
        <Link to={`/orders/${row.orderId}`} className="text-sm text-ink hover:underline">
          {row.orderNumber}
          <span className="block text-xxs text-ink-subtle">{row.sellerOrderNumber}</span>
        </Link>
      ),
    },
    { key: 'seller', header: t('commission.column.seller'), render: (row) => <span className="text-sm text-ink">{row.sellerName}</span> },
    {
      key: 'fee',
      header: t('commission.column.commission'),
      align: 'right',
      render: (row) => (
        <span className="text-sm text-ink">
          {formatMoney(row.platformFee)}
          <span className="block text-xxs text-ink-subtle">{t('commission.plusTax', { amount: formatMoney(row.platformFeeTax) })}</span>
        </span>
      ),
    },
    {
      key: 'why',
      header: t('commission.column.eligibility'),
      render: (row) =>
        row.blockers.length === 0 ? (
          <Badge tone="success">{t('commission.ready')}</Badge>
        ) : (
          <ul className="space-y-0.5 text-xs text-ink-muted">
            {row.blockers.map((blocker) => (
              <li key={blocker.code}>{blockerText(t, blocker)}</li>
            ))}
          </ul>
        ),
    },
    {
      key: 'action',
      header: '',
      align: 'right',
      render: (row) =>
        mayGenerate ? (
          <Button
            size="sm"
            variant="primary"
            disabled={row.blockers.length > 0}
            isLoading={generate.isPending && generate.variables.sellerOrderGroupId === row.sellerOrderGroupId}
            onClick={() => {
              generate.mutate(row);
            }}
          >
            {t('commission.generate')}
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-4">
      <Callout tone="info">{t('commission.candidates.intro')}</Callout>
      <Toolbar>
        <ToolbarField label={t('commission.filter.search')} grow>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setPage(1);
              setQ(search.trim());
            }}
          >
            <Input
              type="search"
              value={search}
              placeholder={t('commission.filter.candidatePlaceholder')}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
            />
          </form>
        </ToolbarField>
      </Toolbar>
      <DataTable
        caption={t('commission.tab.candidates')}
        columns={columns}
        rows={query.data?.items}
        rowKey={(row) => row.sellerOrderGroupId}
        isLoading={query.isPending}
        isRefreshing={query.isFetching && !query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        emptyTitle={t('commission.candidates.emptyTitle')}
        emptyDescription={t('commission.candidates.emptyDescription')}
      />
      {query.data !== undefined && (
        <Pager
          page={query.data.page}
          limit={query.data.pageSize}
          total={query.data.total}
          totalPages={Math.max(1, Math.ceil(query.data.total / query.data.pageSize))}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
