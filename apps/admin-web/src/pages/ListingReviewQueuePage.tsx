/**
 * Listings waiting for quality review — the queue.
 *
 * Oldest submission first, and the sort is not configurable. A moderator who
 * can sort newest-first will, and the seller who submitted on Monday is then
 * still waiting on Friday behind everything that arrived since.
 *
 * The columns triage: who sent it, what it is, which brand it claims, and how
 * many open issues it already carries. The last one is the useful one — a
 * listing arriving with six unresolved issues is a different piece of work from
 * one arriving clean, and knowing which before opening it is how a queue gets
 * worked in a sensible order.
 *
 * Nothing is decided from this screen. A decision is made on the listing
 * itself, where the photographs and the answers are, because approving from a
 * queue row is approving something you have not seen.
 */
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import { Badge, PageHeader } from '@/components/ui';
import { formatRelative } from '@/lib/format';
import { fetchListingReviewQueue, type ListingReviewRow } from '@/lib/sellers';

const PAGE_SIZE = 25;

export function ListingReviewQueuePage(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();

  const page = Math.max(1, Number(params.get('page') ?? '1'));

  const query = useQuery({
    queryKey: ['admin', 'listing-review', page],
    queryFn: () =>
      fetchListingReviewQueue(
        new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) }),
      ),
  });

  const columns: Column<ListingReviewRow>[] = [
    {
      key: 'listing',
      header: 'Listing',
      // A real link, not only the row's click handler: it is what a keyboard
      // and a screen reader use to get to the listing.
      render: (row) => (
        <div className="min-w-0">
          <Link
            to={`/listing-review/${row.id}`}
            className="block truncate font-medium text-ink hover:text-brand"
          >
            {row.title ?? <span className="text-ink-subtle">No title yet</span>}
          </Link>
          <p className="truncate text-xxs text-ink-subtle">
            {row.sellerSku ?? 'No seller code'}
          </p>
        </div>
      ),
    },
    {
      key: 'seller',
      header: 'Seller',
      render: (row) => <span className="text-xs text-ink-muted">{row.sellerName}</span>,
    },
    {
      key: 'brand',
      header: 'Brand',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{row.brandName ?? '—'}</span>
      ),
    },
    {
      key: 'submitted',
      header: 'Waiting',
      secondary: true,
      render: (row) => (
        <span className="text-xs text-ink-muted">{formatRelative(row.submittedAt)}</span>
      ),
    },
    {
      key: 'issues',
      header: 'Open issues',
      align: 'center',
      render: (row) =>
        row.openIssues === 0 ? (
          <Badge tone="success">Clean</Badge>
        ) : (
          <Badge tone="warning">{row.openIssues}</Badge>
        ),
    },
  ];

  const total = query.data?.total ?? 0;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Listing review"
        description={
          total === 0
            ? 'Listings sellers have submitted for quality review.'
            : `${String(total)} ${total === 1 ? 'listing is' : 'listings are'} waiting for a decision.`
        }
      />

      <DataTable
        caption="Listings waiting for quality review"
        columns={columns}
        rows={query.data?.rows ?? []}
        isLoading={query.isPending}
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
        rowKey={(row) => row.id}
        onRowClick={(row) => {
          void navigate(`/listing-review/${row.id}`);
        }}
        emptyTitle="Nothing waiting"
        emptyDescription="When a seller submits a listing, it appears here for review."
      />

      <Pager
        page={page}
        limit={PAGE_SIZE}
        total={total}
        totalPages={Math.max(1, Math.ceil(total / PAGE_SIZE))}
        onPageChange={(next) => {
          const updated = new URLSearchParams(params);
          updated.set('page', String(next));
          setParams(updated, { replace: true });
        }}
      />
    </div>
  );
}
