/**
 * Seller applications — the review queue.
 *
 * Sorted oldest submission first, and that is deliberate: a queue sorted
 * newest-first starves the seller who has been waiting longest, which is the
 * one the queue exists to serve.
 *
 * The columns are chosen to let a reviewer triage without opening anything:
 * how far through the application is, how many documents are attached, and
 * where the business is registered — which decides what it was asked for in
 * the first place.
 */
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, PageHeader, Toolbar, ToolbarField } from '@/components/ui';
import { Input, Select } from '@/components/ui';
import { cx } from '@/lib/cx';
import {
  applicationStatusLabel,
  applicationStatusTone,
  fetchSellerApplications,
  type SellerApplicationRow,
} from '@/lib/sellers';
import { useNavigate } from 'react-router-dom';

const STATUSES = [
  { value: '', label: 'Every application' },
  { value: 'SUBMITTED', label: 'Waiting for review' },
  { value: 'UNDER_REVIEW', label: 'Being reviewed' },
  { value: 'ACTION_REQUIRED', label: 'Sent back' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'DRAFT', label: 'Not submitted yet' },
] as const;

const PAGE_SIZE = 25;

export function SellersPage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const status = params.get('status') ?? '';
  const search = params.get('search') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1'));

  const query = useQuery({
    queryKey: ['admin', 'sellers', status, search, page],
    queryFn: () => {
      const next = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status.length > 0) next.set('status', status);
      if (search.length > 0) next.set('search', search);
      return fetchSellerApplications(next);
    },
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    // A filter change invalidates the page number it was paired with.
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const columns: Column<SellerApplicationRow>[] = [
    {
      key: 'business',
      header: 'Business',
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.displayName}</p>
          <p className="truncate text-xxs text-ink-subtle">{row.legalName}</p>
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Type',
      secondary: true,
      render: (row) => (
        <span className="text-xs capitalize text-ink-muted">
          {row.kind.replace(/_/g, ' ').toLowerCase()}
        </span>
      ),
    },
    {
      key: 'country',
      header: 'Registered in',
      secondary: true,
      render: (row) => <span className="text-xs text-ink-muted">{row.registrationCountry}</span>,
    },
    {
      key: 'progress',
      header: 'Application',
      align: 'right',
      render: (row) => {
        const done = row.requiredSteps === 0 ? 0 : (row.completedSteps / row.requiredSteps) * 100;

        return (
          <div className="ml-auto w-28">
            <p className="text-xs text-ink">
              {row.completedSteps}/{row.requiredSteps} steps
            </p>
            <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
              <div
                className={cx(
                  'h-full rounded-full',
                  done >= 100 ? 'bg-success' : done > 0 ? 'bg-warning' : 'bg-border-strong',
                )}
                style={{ width: `${String(Math.min(100, done))}%` }}
              />
            </div>
          </div>
        );
      },
    },
    {
      key: 'documents',
      header: 'Documents',
      align: 'right',
      tertiary: true,
      render: (row) => <span className="text-xs text-ink-muted">{row.documentCount}</span>,
    },
    {
      key: 'submitted',
      header: 'Submitted',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">
          {row.submittedAt === null ? '—' : new Date(row.submittedAt).toLocaleDateString()}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      align: 'center',
      render: (row) => (
        <Badge tone={applicationStatusTone(row.status)}>
          {applicationStatusLabel(row.status)}
        </Badge>
      ),
    },
  ];

  const waiting = (query.data?.counts['SUBMITTED'] ?? 0) + (query.data?.counts['UNDER_REVIEW'] ?? 0);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Sellers"
        description={
          waiting === 0
            ? 'Businesses applying to sell on the marketplace.'
            : `${String(waiting)} ${waiting === 1 ? 'application is' : 'applications are'} waiting for a decision.`
        }
      />

      <Toolbar>
        <ToolbarField label="Status">
          <Select
            value={status}
            onChange={(event) => {
              update('status', event.currentTarget.value);
            }}
          >
            {STATUSES.map((entry) => (
              <option key={entry.value} value={entry.value}>
                {entry.label}
                {entry.value.length > 0 && query.data !== undefined
                  ? ` (${String(query.data.counts[entry.value] ?? 0)})`
                  : ''}
              </option>
            ))}
          </Select>
        </ToolbarField>

        <ToolbarField label="Search">
          <Input
            type="search"
            defaultValue={search}
            placeholder="Trading or registered name"
            onChange={(event) => {
              const value = event.currentTarget.value;
              window.clearTimeout(timer);
              timer = window.setTimeout(() => {
                update('search', value.trim());
              }, 350);
            }}
          />
        </ToolbarField>
      </Toolbar>

      <DataTable
        caption="Seller applications"
        columns={columns}
        rows={query.data?.rows ?? []}
        rowKey={(row) => row.id}
        isLoading={query.isPending}
        isRefreshing={query.isFetching && !query.isPending}
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
        emptyTitle="No applications here"
        emptyDescription={
          status.length === 0
            ? 'Businesses that apply to sell on the marketplace will appear here.'
            : 'No application is in that state at the moment.'
        }
        onRowClick={(row) => {
          void navigate(`/sellers/${row.id}`);
        }}
      />

      {query.data !== undefined && query.data.total > PAGE_SIZE && (
        <Pager
          page={page}
          limit={PAGE_SIZE}
          total={query.data.total}
          totalPages={Math.ceil(query.data.total / PAGE_SIZE)}
          onPageChange={(next: number) => {
            update('page', String(next));
          }}
        />
      )}
    </div>
  );
}

/** Module-level so the debounce survives a re-render without a ref. */
let timer = 0;
