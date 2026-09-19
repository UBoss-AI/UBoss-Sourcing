/**
 * All listings.
 *
 * Two kinds of row live under one set of tabs, because a seller thinks of them
 * as one list: live OFFERS (things buyers can see) and DRAFTS (things still
 * being written or reviewed). They are separate tables in the database for a
 * good reason - a draft is allowed to be invalid and an offer is not - and
 * hiding that split from the seller is the right call, because "where is the
 * listing I started yesterday" should not require knowing about it.
 *
 * Everything that filters or pages lives in the URL. A seller who finds the
 * three listings that need changing and sends the link to a colleague should
 * be sending that view, not the default one; and the browser's back button
 * should undo a filter rather than leaving the page.
 *
 * The table collapses to cards below `lg`. A fourteen-column table on a phone
 * is a horizontal scroll nobody can use, and the columns that matter on a
 * phone - what it is, what it costs, how many are left - are the first three.
 */
import { useState } from 'react';
import { Link, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { Modal } from '@/components/Modal';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { useI18n } from '@/i18n/i18n-context';
import {
  fetchDrafts,
  fetchOffers,
  formatMinor,
  offerStatusTone,
  duplicateListing,
  setOfferStatus,
  withdrawDraft,
  type DraftListRow,
  type OfferRow,
} from '@/lib/seller';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

/**
 * The tabs, in the order a seller works through them.
 *
 * `ACTIVE` first because it is the answer to "what am I selling", not because
 * it is alphabetically first or the biggest. The two that need action -
 * `NEEDS_CHANGES` and `ACTION_REQUIRED` - sit next to each other so a seller
 * scanning for work finds both without reading the whole row.
 */
const TABS = [
  { key: 'ACTIVE', label: 'Active', source: 'offers' },
  { key: 'INACTIVE', label: 'Ready to switch on', source: 'offers' },
  { key: 'NEEDS_CHANGES', label: 'Needs changes', source: 'offers' },
  { key: 'PAUSED', label: 'Paused', source: 'offers' },
  { key: 'DRAFT', label: 'Drafts', source: 'drafts' },
  { key: 'PENDING_REVIEW', label: 'In review', source: 'drafts' },
  { key: 'ACTION_REQUIRED', label: 'Sent back', source: 'drafts' },
  { key: 'ARCHIVED', label: 'Archived', source: 'offers' },
] as const;

type TabKey = (typeof TABS)[number]['key'];

function isTab(value: string | null): value is TabKey {
  return value !== null && TABS.some((tab) => tab.key === value);
}

export function SellerListingsPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();

  // The gate lives here, ABOVE any hook, and the body below owns all of them.
  // Returning early from a component that had already called useQuery would
  // change the hook order between an approved seller and an unapproved one,
  // which React reports as a crash rather than as a missing panel.
  if (!seller.isTrading) {
    return (
      <>
        <PageHeader title="Listings" />
        <ApprovalRequiredNotice seller={seller} />
      </>
    );
  }

  return <ListingsBody />;
}

function ListingsBody(): React.JSX.Element {
  const [params, setParams] = useSearchParams();

  const tab: TabKey = isTab(params.get('tab')) ? (params.get('tab') as TabKey) : 'ACTIVE';
  const search = params.get('search') ?? '';
  const stockState = params.get('stockState') ?? '';
  const page = Number(params.get('page') ?? '1');

  const source = TABS.find((entry) => entry.key === tab)?.source ?? 'offers';

  /** Change one query parameter and reset paging, because the page it named is gone. */
  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="All listings"
        description="Everything you sell here, and everything still being written."
        actions={
          <Link to="/seller/listings/new">
            <Button variant="primary">Add a listing</Button>
          </Link>
        }
      />

      {/* ---- Tabs ---------------------------------------------------------- */}
      <TabStrip
        active={tab}
        onSelect={(next) => {
          update('tab', next);
        }}
      />

      {/* ---- Filters ------------------------------------------------------- */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="listing-search">
          Search your listings
        </label>
        <input
          id="listing-search"
          type="search"
          defaultValue={search}
          placeholder="Search by product name or your own code"
          onChange={(event) => {
            // Debounced by hand rather than on every keystroke: a seller with
            // 1,200 listings typing "cannula" would otherwise send seven
            // queries and see the results of the fourth.
            const value = event.currentTarget.value;
            window.clearTimeout(searchTimer);
            searchTimer = window.setTimeout(() => {
              update('search', value.trim());
            }, 350);
          }}
          className="h-10 min-w-0 flex-1 rounded-md border border-border-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle sm:max-w-sm"
        />

        {source === 'offers' && (
          <div role="group" aria-label="Stock" className="flex gap-1.5">
            {[
              { value: '', label: 'Any stock' },
              { value: 'in', label: 'In stock' },
              { value: 'low', label: 'Running low' },
              { value: 'out', label: 'Out of stock' },
            ].map((chip) => (
              <button
                key={chip.value}
                type="button"
                aria-pressed={stockState === chip.value}
                onClick={() => {
                  update('stockState', chip.value);
                }}
                className={cx(
                  'h-10 rounded-full border px-3.5 text-xs font-medium transition-colors',
                  stockState === chip.value
                    ? 'border-brand/30 bg-brand-soft text-brand'
                    : 'border-border-strong bg-surface text-ink-muted hover:bg-surface-hover',
                )}
              >
                {chip.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {source === 'offers' ? (
        <OfferTable
          status={tab}
          search={search}
          stockState={stockState}
          page={page}
          onPage={(next) => {
            update('page', String(next));
          }}
        />
      ) : (
        <DraftTable status={tab} search={search} />
      )}
    </div>
  );
}

/** Module-level so the debounce survives a re-render without a ref per input. */
let searchTimer = 0;

function TabStrip({
  active,
  onSelect,
}: {
  active: TabKey;
  onSelect: (tab: TabKey) => void;
}): React.JSX.Element {
  // Counts for both sources in one place, so the strip does not flicker as two
  // separate queries land at different times.
  const offers = useQuery({
    queryKey: ['seller', 'offers', 'counts'],
    queryFn: () => fetchOffers(new URLSearchParams({ pageSize: '1' })),
    staleTime: 30_000,
  });

  const drafts = useQuery({
    queryKey: ['seller', 'drafts', 'counts'],
    queryFn: () => fetchDrafts(new URLSearchParams({ pageSize: '1' })),
    staleTime: 30_000,
  });

  const countFor = (tab: (typeof TABS)[number]): number | null => {
    const counts = tab.source === 'offers' ? offers.data?.counts : drafts.data?.counts;
    if (counts === undefined) return null;
    // Two draft states read as one tab to the seller: a listing that failed
    // validation and one nobody has finished are both "a draft".
    if (tab.key === 'DRAFT') {
      return (
        (counts['DRAFT'] ?? 0) +
        (counts['VALIDATION_FAILED'] ?? 0) +
        (counts['READY_FOR_SUBMISSION'] ?? 0)
      );
    }
    return counts[tab.key] ?? 0;
  };

  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div
        role="tablist"
        aria-label="Listing status"
        className="flex min-w-max gap-1 border-b border-border"
      >
        {TABS.map((tab) => {
          const count = countFor(tab);
          const isActive = tab.key === active;

          return (
            <button
              key={tab.key}
              role="tab"
              type="button"
              aria-selected={isActive}
              onClick={() => {
                onSelect(tab.key);
              }}
              className={cx(
                'flex items-center gap-2 whitespace-nowrap border-b-2 px-3.5 py-2.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-brand text-brand'
                  : 'border-transparent text-ink-muted hover:border-border-strong hover:text-ink',
              )}
            >
              {tab.label}
              {count !== null && count > 0 && (
                <span
                  className={cx(
                    'tabular rounded-full px-1.5 py-0.5 text-xxs font-semibold',
                    isActive ? 'bg-brand-soft text-brand' : 'bg-surface-sunken text-ink-muted',
                  )}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Live offers
// ---------------------------------------------------------------------------

function OfferTable({
  status,
  search,
  stockState,
  page,
  onPage,
}: {
  status: string;
  search: string;
  stockState: string;
  page: number;
  onPage: (page: number) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const params = new URLSearchParams({ status, page: String(page), pageSize: '25' });
  if (search.length > 0) params.set('search', search);
  if (stockState.length > 0) params.set('stockState', stockState);

  const query = useQuery({
    queryKey: ['seller', 'offers', status, search, stockState, page],
    queryFn: () => fetchOffers(params),
  });

  const statusMutation = useMutation({
    mutationFn: ({
      id,
      next,
      reason,
    }: {
      id: string;
      next: 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
      reason?: string | null;
    }) => setOfferStatus(id, next, reason ?? null),
    onSuccess: async () => {
      // Every offer query, not just this page's: pausing a listing changes the
      // tab counts as well as the row.
      await client.invalidateQueries({ queryKey: ['seller', 'offers'] });
      toast.success('Listing updated.');
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, 'That listing could not be updated.'));
    },
  });

  if (query.isPending) return <LoadingState label="Loading your listings" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <Card>
        <EmptyState
          title="Nothing here yet"
          description={
            search.length > 0
              ? 'No listing matches that search. Try a shorter term, or clear the filters.'
              : 'Listings you add will appear here once they have been through quality review.'
          }
          action={
            <Link to="/seller/listings/new">
              <Button variant="primary">Add a listing</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  const pageCount = Math.max(1, Math.ceil(query.data.total / 25));

  return (
    <div className="space-y-4">
      <Card className="overflow-hidden">
        {/* Desktop table */}
        <div className="hidden overflow-x-auto lg:block">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle bg-surface-sunken text-left">
                <Th>Product</Th>
                <Th>Price</Th>
                <Th align="right">Stock</Th>
                <Th>Quality</Th>
                <Th>Status</Th>
                <Th align="right">Actions</Th>
              </tr>
            </thead>
            <tbody>
              {query.data.rows.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border-subtle last:border-b-0 hover:bg-surface-hover"
                >
                  <td className="px-4 py-3">
                    <ProductCell row={row} />
                  </td>
                  <td className="px-4 py-3">
                    <p className="tabular font-medium text-ink">
                      {formatMinor(row.priceMinor, row.currency)}
                    </p>
                    <p className="text-xxs text-ink-subtle">Minimum {row.minimumOrderQuantity}</p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <StockCell row={row} />
                  </td>
                  <td className="px-4 py-3">
                    <QualityCell score={row.qualityScore} />
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={offerStatusTone(row.status)}>{offerStatusLabel(row.status)}</Badge>
                    {row.statusReason !== null && (
                      <p className="mt-1 max-w-xs text-xxs leading-relaxed text-ink-muted">
                        {row.statusReason}
                      </p>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RowActions
                      row={row}
                      isBusy={statusMutation.isPending}
                      onStatus={(next) => {
                        statusMutation.mutate({ id: row.id, next });
                      }}
                      onPause={(reason) => {
                        statusMutation.mutate({ id: row.id, next: 'PAUSED', reason });
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Cards below lg */}
        <ul className="divide-y divide-border-subtle lg:hidden">
          {query.data.rows.map((row) => (
            <li key={row.id} className="space-y-3 px-4 py-4">
              <ProductCell row={row} />
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="tabular text-sm font-medium text-ink">
                  {formatMinor(row.priceMinor, row.currency)}
                </p>
                <StockCell row={row} />
                <Badge tone={offerStatusTone(row.status)}>{offerStatusLabel(row.status)}</Badge>
              </div>
              <RowActions
                row={row}
                isBusy={statusMutation.isPending}
                onStatus={(next) => {
                  statusMutation.mutate({ id: row.id, next });
                }}
                onPause={(reason) => {
                  statusMutation.mutate({ id: row.id, next: 'PAUSED', reason });
                }}
              />
            </li>
          ))}
        </ul>
      </Card>

      {pageCount > 1 && (
        <nav className="flex items-center justify-between" aria-label="Pages">
          <Button
            size="sm"
            disabled={page <= 1}
            onClick={() => {
              onPage(page - 1);
            }}
          >
            Previous
          </Button>
          <p className="tabular text-xs text-ink-muted">
            Page {page} of {pageCount} · {query.data.total} listings
          </p>
          <Button
            size="sm"
            disabled={page >= pageCount}
            onClick={() => {
              onPage(page + 1);
            }}
          >
            Next
          </Button>
        </nav>
      )}
    </div>
  );
}

function Th({
  children,
  align,
}: {
  children: React.ReactNode;
  align?: 'right';
}): React.JSX.Element {
  return (
    <th
      scope="col"
      className={cx(
        'px-4 py-2.5 text-xxs font-semibold uppercase tracking-wider text-ink-subtle',
        align === 'right' && 'text-right',
      )}
    >
      {children}
    </th>
  );
}

function ProductCell({ row }: { row: OfferRow }): React.JSX.Element {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <div className="h-11 w-11 shrink-0 overflow-hidden rounded-md border border-border bg-surface-media">
        {row.imageUrl === null ? (
          <div className="flex h-full w-full items-center justify-center text-xxs text-ink-subtle">
            —
          </div>
        ) : (
          <img src={row.imageUrl} alt="" className="h-full w-full object-contain" loading="lazy" />
        )}
      </div>
      <div className="min-w-0">
        <Link
          to={`/seller/listings/${row.id}`}
          className="line-clamp-2 text-sm font-medium text-ink hover:text-brand"
        >
          {row.productName}
        </Link>
        <p className="mt-0.5 truncate text-xxs text-ink-subtle">
          {row.sellerSku}
          {row.brandName !== null && ` · ${row.brandName}`}
        </p>
      </div>
    </div>
  );
}

function StockCell({ row }: { row: OfferRow }): React.JSX.Element {
  const isOut = row.availableQuantity <= 0;

  return (
    <div>
      <p
        className={cx(
          'tabular text-sm font-medium',
          isOut ? 'text-danger' : row.availableQuantity <= 10 ? 'text-warning' : 'text-ink',
        )}
      >
        {isOut ? 'Out of stock' : `${row.availableQuantity} units`}
      </p>
      {row.reservedQuantity > 0 && (
        <p className="text-xxs text-ink-subtle">{row.reservedQuantity} held for orders</p>
      )}
    </div>
  );
}

/**
 * A quality score as a bar plus its number.
 *
 * Never colour alone. The score is one of the things a seller acts on, and a
 * green-or-amber pip carries no information for somebody who cannot separate
 * the two - so the figure is always beside it.
 */
function QualityCell({ score }: { score: number | null }): React.JSX.Element {
  if (score === null) {
    return <span className="text-xxs text-ink-subtle">Not scored yet</span>;
  }

  const tone = score >= 80 ? 'bg-success' : score >= 50 ? 'bg-warning' : 'bg-danger';
  const label = score >= 80 ? 'Good' : score >= 50 ? 'Average' : 'Needs work';

  return (
    <div className="w-24">
      <div className="flex items-center justify-between">
        <span className="text-xxs font-medium text-ink">{label}</span>
        <span className="tabular text-xxs text-ink-muted">{score}</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <div className={cx('h-full rounded-full', tone)} style={{ width: `${String(score)}%` }} />
      </div>
    </div>
  );
}

/**
 * Pausing, with the consequences said out loud first.
 *
 * Pausing is not a small action: it takes the listing off the storefront and
 * it will be rejected in the basket of anybody who already had it there. A
 * seller who meant "stop taking new orders while I fix the price" and a
 * seller who meant "we have stopped selling this" press the same button, and
 * only one of them expects the second thing. So the dialog says what will
 * happen, and - just as important - what will NOT: orders already placed are
 * untouched and still have to be shipped.
 *
 * The reason is optional and seller-only. It is what the listings table shows
 * three weeks later when somebody else in the same business is looking at a
 * paused row and cannot tell whether it is waiting for stock or withdrawn.
 */
function PauseButton({
  row,
  isBusy,
  onPause,
}: {
  row: OfferRow;
  isBusy: boolean;
  onPause: (reason: string | null) => void;
}): React.JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [reason, setReason] = useState('');

  return (
    <>
      <Button
        size="sm"
        disabled={isBusy}
        onClick={() => {
          setIsOpen(true);
        }}
      >
        Pause
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={() => {
          setIsOpen(false);
        }}
        title={`Pause ${row.sellerSku}?`}
        description="Buyers will not be able to order it until you put it back on sale."
        footer={
          <>
            <Button
              onClick={() => {
                setIsOpen(false);
              }}
            >
              Keep it on sale
            </Button>
            <Button
              variant="primary"
              isLoading={isBusy}
              onClick={() => {
                onPause(reason.trim() === '' ? null : reason.trim());
                setIsOpen(false);
                setReason('');
              }}
            >
              Pause this listing
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-subtle">
            <li>It disappears from search and cannot be added to a basket.</li>
            <li>Anyone who already has it in a basket is told it is unavailable.</li>
            <li>
              <strong className="text-ink">Orders already placed are not affected.</strong> You
              still need to pack and ship them.
            </li>
            <li>Your stock, product code and sales history are all kept.</li>
            <li>You can edit everything about it while it is paused.</li>
          </ul>

          <Field label="Why are you pausing it? (optional)" hint="Only your team sees this.">
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={reason}
                placeholder="Waiting for stock, price under review…"
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      </Modal>
    </>
  );
}

/**
 * "Edit", and the question a live listing has to be asked first.
 *
 * A listing that is not on sale opens straight into the editor - there is
 * nobody looking at it and nothing to warn about. One that IS on sale is asked
 * before anything happens, because the seller is about to take it off sale and
 * the two things they will worry about - "do I lose my orders" and "do I lose
 * my stock" - are answered in the dialog rather than discovered afterwards.
 *
 * The pause itself is the editor's job, not this button's. Pressing "Pause &
 * Edit" navigates with the intent carried in the URL, and the editor pauses on
 * arrival: a pause that happened here would leave a listing off sale if the
 * navigation failed, or if the seller closed the tab in between.
 */
function EditButton({ row, isBusy }: { row: OfferRow; isBusy: boolean }): React.JSX.Element {
  const navigate = useNavigate();
  const [isAsking, setIsAsking] = useState(false);

  const open = (pause: boolean): void => {
    void navigate(`/seller/listings/${row.id}/edit${pause ? '?pause=1' : ''}`);
  };

  return (
    <>
      <Button
        size="sm"
        variant="primary"
        disabled={isBusy}
        onClick={() => {
          if (row.status === 'ACTIVE') {
            setIsAsking(true);
            return;
          }
          open(false);
        }}
      >
        Edit
      </Button>

      <Modal
        isOpen={isAsking}
        title="Pause this product to edit?"
        onClose={() => {
          setIsAsking(false);
        }}
        footer={
          <>
            <Button
              onClick={() => {
                setIsAsking(false);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setIsAsking(false);
                open(true);
              }}
            >
              Pause &amp; Edit
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-ink">
            This product is currently on sale. Structural changes require the listing to be paused
            temporarily. Existing orders will not be affected.
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-subtle">
            <li>It disappears from search and cannot be added to a basket.</li>
            <li>
              <strong className="text-ink">Orders already placed are not affected.</strong> You
              still pack and send them as normal.
            </li>
            <li>Your stock, product codes and sales history are all kept.</li>
            <li>Put it back on sale yourself with “Save &amp; resume sale”.</li>
          </ul>
        </div>
      </Modal>
    </>
  );
}

function RowActions({
  row,
  isBusy,
  onStatus,
  onPause,
}: {
  row: OfferRow;
  isBusy: boolean;
  onStatus: (next: 'ACTIVE' | 'PAUSED' | 'ARCHIVED') => void;
  onPause: (reason: string | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <EditButton row={row} isBusy={isBusy} />

      <Link to={`/seller/listings/${row.id}`}>
        <Button size="sm" variant="ghost">
          Versions
        </Button>
      </Link>

      {row.status === 'ACTIVE' && <PauseButton row={row} isBusy={isBusy} onPause={onPause} />}

      {(row.status === 'PAUSED' || row.status === 'INACTIVE') && (
        <Button
          size="sm"
          variant="primary"
          disabled={isBusy}
          onClick={() => {
            onStatus('ACTIVE');
          }}
        >
          Put on sale
        </Button>
      )}

      {/*
        Deliberately no "put on sale" for NEEDS_CHANGES. That state exists to
        stop something being sold - an expired certificate, a withdrawn brand -
        and a button that overrode it would make the state decorative. The
        server refuses it too; this is so the seller is not offered it.
      */}
      {row.status === 'NEEDS_CHANGES' && (
        <span className="text-xxs text-ink-subtle">Fix the issues to sell again</span>
      )}

      {/*
        Duplicating is how a seller lists the next size of the same thing. It
        copies everything except the code, which has to be new — two listings
        under one seller SKU is an order nobody can pick.
      */}
      <DuplicateButton row={row} />
    </div>
  );
}

function DuplicateButton({ row }: { row: OfferRow }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [sellerSku, setSellerSku] = useState(`${row.sellerSku}-COPY`);

  const mutation = useMutation({
    mutationFn: () => duplicateListing(row.id, sellerSku.trim()),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'offers'] });
      toast.success(`Copied as ${sellerSku.trim()}. It is paused until you put it on sale.`);
      setIsOpen(false);
    },
    onError: (error: unknown) => {
      // A code already in use is the common failure, and the server names it.
      toast.error(errorMessage(t, error, 'That listing could not be copied.'));
    },
  });

  return (
    <>
      <Button
        size="sm"
        onClick={() => {
          setIsOpen(true);
        }}
      >
        Copy
      </Button>

      {isOpen && (
        <Modal
          isOpen
          title={`Copy ${row.sellerSku}`}
          onClose={() => {
            setIsOpen(false);
          }}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">
              Everything is copied — the description, the photographs, the packing and the price.
              The new listing starts paused, so nothing goes on sale until you say so.
            </p>

            <Field
              label="Your code for the copy"
              hint="Must be different from every other code you use."
              required
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={sellerSku}
                  onChange={(event) => {
                    setSellerSku(event.currentTarget.value);
                  }}
                />
              )}
            </Field>

            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setIsOpen(false);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                isLoading={mutation.isPending}
                disabled={sellerSku.trim().length === 0 || sellerSku.trim() === row.sellerSku}
                onClick={() => {
                  mutation.mutate();
                }}
              >
                Copy it
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

function offerStatusLabel(status: OfferRow['status']): string {
  switch (status) {
    case 'ACTIVE':
      return 'On sale';
    case 'INACTIVE':
      return 'Ready to switch on';
    case 'PAUSED':
      return 'Paused';
    case 'NEEDS_CHANGES':
      return 'Needs changes';
    case 'ARCHIVED':
      return 'Archived';
  }
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function DraftTable({ status, search }: { status: string; search: string }): React.JSX.Element {
  // "Drafts" is one tab over three server states, because the distinction
  // between "not finished", "failed validation" and "ready to send" is about
  // what the seller does next rather than about where it lives.
  const statuses =
    status === 'DRAFT' ? ['DRAFT', 'VALIDATION_FAILED', 'READY_FOR_SUBMISSION'] : [status];

  const query = useQuery({
    queryKey: ['seller', 'drafts', status, search],
    queryFn: async () => {
      const pages = await Promise.all(
        statuses.map((entry) => {
          const params = new URLSearchParams({ status: entry, pageSize: '50' });
          if (search.length > 0) params.set('search', search);
          return fetchDrafts(params);
        }),
      );

      return {
        rows: pages.flatMap((entry) => entry.rows),
        total: pages.reduce((sum, entry) => sum + entry.total, 0),
      };
    },
  });

  if (query.isPending) return <LoadingState label="Loading your drafts" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.data.rows.length === 0) {
    return (
      <Card>
        <EmptyState
          title={status === 'PENDING_REVIEW' ? 'Nothing is being reviewed' : 'No drafts'}
          description={
            status === 'PENDING_REVIEW'
              ? 'Listings you send for quality review will appear here while we look at them.'
              : 'Start a listing and it will be saved here as you go, even if you close the tab.'
          }
          action={
            <Link to="/seller/listings/new">
              <Button variant="primary">Start a listing</Button>
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border-subtle">
        {query.data.rows.map((row) => (
          /*
            The link covers the text and the actions sit outside it. A button
            inside an anchor is invalid markup and, more to the point, a seller
            aiming at "Take it back" would open the wizard instead.
          */
          <li
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-4 px-4 py-4 hover:bg-surface-hover"
          >
            <Link to={`/seller/listings/new?draft=${row.id}`} className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-ink">
                {row.title ?? 'Untitled listing'}
              </p>
              <p className="mt-0.5 truncate text-xxs text-ink-subtle">
                {row.sellerSku ?? 'No code yet'}
                {row.brandName !== null && ` · ${row.brandName}`}
                {' · last saved '}
                {new Date(row.updatedAt).toLocaleDateString()}
              </p>
              <SectionProgress sections={row.sections} />
            </Link>

            <div className="flex shrink-0 items-center gap-3">
              {row.openIssues > 0 && (
                <Badge tone="warning">
                  {row.openIssues} {row.openIssues === 1 ? 'issue' : 'issues'}
                </Badge>
              )}
              <Badge tone={draftStatusTone(row.status)}>{draftStatusLabel(row.status)}</Badge>

              {/*
                Only while it is with us. A seller who spots a mistake after
                submitting has, without this, one option: wait for a moderator
                to read it, refuse it, and hand it back — which wastes their day
                and ours.
              */}
              {row.status === 'PENDING_REVIEW' && <WithdrawDraftButton draftId={row.id} />}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The five section counters, inline.
 *
 * The same numbers the wizard shows, so a seller scanning the drafts list can
 * see which one is nearly finished without opening it. They come from the
 * server, computed once - see `evaluateListing` - rather than being counted
 * twice in two places that would eventually disagree.
 */
function SectionProgress({
  sections,
}: {
  sections: DraftListRow['sections'];
}): React.JSX.Element | null {
  const entries = Object.entries(sections);
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
      {entries.map(([key, value]) => (
        <span key={key} className="flex items-center gap-1.5 text-xxs">
          <span
            aria-hidden="true"
            className={cx(
              'h-1.5 w-1.5 rounded-full',
              value.state === 'COMPLETE'
                ? 'bg-success'
                : value.state === 'ERROR'
                  ? 'bg-danger'
                  : value.state === 'IN_PROGRESS'
                    ? 'bg-warning'
                    : 'bg-border-strong',
            )}
          />
          <span className="text-ink-muted">{shortSectionLabel(key)}</span>
          <span className="tabular text-ink-subtle">
            {value.completed}/{value.total}
          </span>
        </span>
      ))}
    </div>
  );
}

function shortSectionLabel(key: string): string {
  switch (key) {
    case 'PRODUCT_PHOTOS':
      return 'Photos';
    case 'PRICE_STOCK_SHIPPING':
      return 'Price & stock';
    case 'PRODUCT_DESCRIPTION':
      return 'Description';
    case 'ADDITIONAL_INFORMATION':
      return 'Extra';
    case 'MEDICAL_COMPLIANCE':
      return 'Compliance';
    default:
      return key;
  }
}

/**
 * Take a listing back out of the review queue.
 *
 * No confirmation dialog, because nothing is lost: the draft returns to exactly
 * the state it was in when it was sent, with everything the seller wrote still
 * on it. The only cost is losing its place in the queue, which the toast says.
 */
function WithdrawDraftButton({ draftId }: { draftId: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => withdrawDraft(draftId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['seller', 'drafts'] });
      await client.invalidateQueries({ queryKey: ['seller', 'dashboard'] });
      toast.success('Taken back. You can change it and send it again.');
    },
    onError: (error: unknown) => {
      // A listing a moderator has already decided cannot be withdrawn, and the
      // server says which. Its sentence beats ours.
      toast.error(errorMessage(t, error, 'That listing could not be taken back.'));
    },
  });

  return (
    <Button
      isLoading={mutation.isPending}
      onClick={() => {
        mutation.mutate();
      }}
    >
      Take it back
    </Button>
  );
}

function draftStatusLabel(status: DraftListRow['status']): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft';
    case 'VALIDATION_FAILED':
      return 'Needs fixing';
    case 'READY_FOR_SUBMISSION':
      return 'Ready to send';
    case 'PENDING_REVIEW':
      return 'Being reviewed';
    case 'ACTION_REQUIRED':
      return 'Sent back';
    case 'APPROVED':
      return 'Approved';
    case 'REJECTED':
      return 'Not approved';
    case 'ARCHIVED':
      return 'Archived';
  }
}

function draftStatusTone(
  status: DraftListRow['status'],
): 'neutral' | 'brand' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'READY_FOR_SUBMISSION':
    case 'APPROVED':
      return 'success';
    case 'VALIDATION_FAILED':
    case 'ACTION_REQUIRED':
      return 'warning';
    case 'REJECTED':
      return 'danger';
    case 'PENDING_REVIEW':
      return 'brand';
    default:
      return 'neutral';
  }
}
