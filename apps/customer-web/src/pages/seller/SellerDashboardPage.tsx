/**
 * The seller's home screen.
 *
 * Every number is live and every number says what period it covers. A tile with
 * a figure and no window is not information - "Sales: £8,600" is unanswerable
 * without "today" beside it, and two tiles quietly computed over different
 * windows is how a dashboard becomes untrustworthy without becoming visibly
 * wrong.
 *
 * **A tile that could not be computed says so.** The API returns `unavailable`
 * per tile and this renders those as a dash with an explanation rather than as
 * zero, because a seller who reads "0 new orders" and goes home is worse off
 * than one who reads "we could not work this out".
 *
 * The layout follows the work rather than the data: what needs doing now sits
 * at the top in the widest tiles, money next, catalogue health below that. A
 * seller opens this page to find out what to pack.
 */
import { useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { cx } from '@/lib/cx';
import { formatMinor, fetchDashboard, type SellerDashboard } from '@/lib/seller';
import type { SellerOutletContext } from './SellerLayout';

type Range = 'today' | 'week' | 'month' | 'quarter';

const RANGES: readonly { value: Range; label: string; comparison: string }[] = Object.freeze([
  { value: 'today', label: 'Today', comparison: 'yesterday' },
  { value: 'week', label: '7 days', comparison: 'the 7 days before' },
  { value: 'month', label: '30 days', comparison: 'the 30 days before' },
  { value: 'quarter', label: '90 days', comparison: 'the 90 days before' },
]);

/**
 * One headline figure.
 *
 * `tabular` on the number so a row of tiles keeps its digits on a grid and the
 * figures do not shuffle sideways when one ticks over from 9 to 10.
 */
function Metric({
  label,
  value,
  hint,
  tone,
  to,
  isUnavailable,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'default' | 'warning' | 'danger' | 'success';
  to?: string;
  isUnavailable?: boolean;
}): React.JSX.Element {
  const body = (
    <>
      <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{label}</p>
      <p
        className={cx(
          'tabular mt-2 text-title-lg font-semibold',
          isUnavailable === true
            ? 'text-ink-subtle'
            : tone === 'warning'
              ? 'text-warning'
              : tone === 'danger'
                ? 'text-danger'
                : tone === 'success'
                  ? 'text-success'
                  : 'text-ink',
        )}
      >
        {isUnavailable === true ? '—' : value}
      </p>
      {hint !== undefined && (
        <p className="mt-1 text-xxs leading-relaxed text-ink-subtle">{hint}</p>
      )}
    </>
  );

  const shell =
    'rounded-lg border border-border bg-surface px-5 py-4 shadow-card transition-colors';

  if (to !== undefined && isUnavailable !== true) {
    return (
      <Link to={to} className={cx(shell, 'block hover:border-border-hover hover:bg-surface-hover')}>
        {body}
      </Link>
    );
  }

  return <div className={shell}>{body}</div>;
}

/**
 * "Up £400 on yesterday", or nothing.
 *
 * Deliberately silent when the previous period was zero rather than showing
 * "+∞%" or "+100%": a first sale is not a hundred percent increase on nothing,
 * and a percentage against zero is the classic dashboard lie.
 */
function Comparison({
  currentMinor,
  previousMinor,
  currency,
  periodLabel,
}: {
  currentMinor: string;
  previousMinor: string;
  currency: string;
  periodLabel: string;
}): React.JSX.Element | null {
  const current = BigInt(currentMinor);
  const previous = BigInt(previousMinor);

  if (previous === 0n) return null;

  const difference = current - previous;
  if (difference === 0n) return <span className="text-ink-subtle">Level with {periodLabel}</span>;

  const isUp = difference > 0n;
  const magnitude = (isUp ? difference : -difference).toString();

  return (
    <span className={isUp ? 'text-success' : 'text-danger'}>
      {isUp ? '↑' : '↓'} {formatMinor(magnitude, currency)} on {periodLabel}
    </span>
  );
}

/** A row in the "what needs doing" list. */
function ActionRow({
  title,
  detail,
  count,
  to,
  tone,
}: {
  title: string;
  detail: string;
  count: number;
  to: string;
  tone: 'danger' | 'warning' | 'brand';
}): React.JSX.Element | null {
  if (count === 0) return null;

  return (
    <Link
      to={to}
      className="flex items-center justify-between gap-4 border-b border-border-subtle px-6 py-4 last:border-b-0 hover:bg-surface-hover"
    >
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-xxs text-ink-muted">{detail}</p>
      </div>
      <Badge tone={tone === 'brand' ? 'brand' : tone}>{count}</Badge>
    </Link>
  );
}

export function SellerDashboardPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();
  const [range, setRange] = useState<Range>('today');

  const query = useQuery({
    queryKey: ['seller', 'dashboard', range],
    queryFn: () => fetchDashboard(range),
    // Stale quickly: an order that arrived two minutes ago is the reason the
    // seller is looking at this page.
    staleTime: 30_000,
  });

  const comparison = RANGES.find((entry) => entry.value === range)?.comparison ?? 'the period before';

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Good day, ${seller.displayName}`}
        description="Everything that needs your attention, and how the last period went."
        actions={
          <div
            role="group"
            aria-label="Time range"
            className="inline-flex rounded-md border border-border-strong bg-surface p-0.5"
          >
            {RANGES.map((entry) => (
              <button
                key={entry.value}
                type="button"
                aria-pressed={range === entry.value}
                onClick={() => {
                  setRange(entry.value);
                }}
                className={cx(
                  'rounded px-3 py-1.5 text-xs font-medium transition-colors',
                  range === entry.value
                    ? 'bg-brand-soft text-brand'
                    : 'text-ink-muted hover:text-ink',
                )}
              >
                {entry.label}
              </button>
            ))}
          </div>
        }
      />

      {query.isPending && <LoadingState label="Working out your figures" />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
          />
      )}

      {query.data !== undefined && (
        <DashboardBody data={query.data} comparison={comparison} isTrading={seller.isTrading} />
      )}
    </div>
  );
}

/**
 * A seller who has not listed anything yet.
 *
 * Shown INSTEAD of the tiles, not above them, and that is the whole point.
 * Twenty figures all reading zero is not an empty state: it is a full screen
 * that says nothing, it takes a moment to work out that none of it applies
 * yet, and a "£0.00 in sales" tile is a discouraging thing to hand somebody on
 * the day they joined. What a new seller needs is the next three things to do.
 *
 * Their setup progress stays visible below this, because for most sellers
 * arriving here the answer to "why can I not add a listing" is in it.
 */
function FirstSteps({ isTrading }: { isTrading: boolean }): React.JSX.Element {
  const steps: readonly { title: string; body: string }[] = Object.freeze([
    {
      title: 'Finish your account',
      body: 'Your business details, your documents and where you ship from. The marketplace reviews these before you can sell.',
    },
    {
      title: 'Add your first product',
      body: 'Describe what you sell, set your price and say how many you have. It goes to the marketplace for a look before it appears to buyers.',
    },
    {
      title: 'Get ready for orders',
      body: 'Set your dispatch times and check your stock. Orders arrive here, and the clock starts when you accept one.',
    },
  ]);

  return (
    <Card
      title="Nothing here yet"
      description="You have not listed anything, so there is nothing to report on. Here is how to start."
    >
      <div className="px-6 py-5">
        <ol className="space-y-5">
          {steps.map((step, index) => (
            <li key={step.title} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{step.title}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-6 flex flex-wrap gap-3">
          {/*
            Only an approved seller is offered the listing form. Before that the
            honest next step is their application, and a button that opens a
            form the server will refuse is worse than no button.
          */}
          {isTrading ? (
            <Link to="/seller/listings/new">
              <Button variant="primary">Add your first listing</Button>
            </Link>
          ) : (
            <Link to="/seller/onboarding">
              <Button variant="primary">Continue your application</Button>
            </Link>
          )}
          <Link to="/seller/profile">
            <Button variant="secondary">Your company profile</Button>
          </Link>
        </div>
      </div>
    </Card>
  );
}

/**
 * How far through setup this account is.
 *
 * Its own component because it is rendered in two places: beside the work
 * queue on an established seller's dashboard, and directly under the first
 * steps on a brand-new one. Duplicating it would be how the two quietly start
 * disagreeing about what is still outstanding.
 */
function SetupCard({ data }: { data: SellerDashboard }): React.JSX.Element {
  return (
      <Card
        title="Setup"
        description="What is left before your account is fully open."
        actions={
          data.onboarding.percentComplete < 100 ? (
            <Link to="/seller/onboarding">
              <Button size="sm" variant="primary">
                Continue
              </Button>
            </Link>
          ) : undefined
        }
      >
        <div className="px-6 py-5">
          <div className="flex items-center gap-3">
            <div
              className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-valuenow={data.onboarding.percentComplete}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label="Setup completed"
            >
              <div
                className="h-full rounded-full bg-brand-fill transition-[width]"
                style={{ width: `${String(data.onboarding.percentComplete)}%` }}
              />
            </div>
            <span className="tabular shrink-0 text-sm font-semibold text-ink">
              {data.onboarding.percentComplete}%
            </span>
          </div>

          {data.onboarding.blockingSteps.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">
              Every required step is finished.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {data.onboarding.blockingSteps.map((step) => (
                <li key={step.key} className="flex items-center gap-2 text-sm text-ink-muted">
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning"
                  />
                  {step.title}
                </li>
              ))}
            </ul>
          )}

          {data.qualityScore !== null && (
            <div className="mt-6 border-t border-border-subtle pt-4">
              <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                Seller quality score
              </p>
              <p className="tabular mt-1 text-title-md font-semibold text-ink">
                {data.qualityScore.toFixed(1)}
              </p>
              <p className="mt-1 text-xxs text-ink-subtle">
                From on-time dispatch, cancellations, returns and listing quality.
              </p>
            </div>
          )}
        </div>
      </Card>
  );
}

function DashboardBody({
  data,
  comparison,
  isTrading,
}: {
  data: SellerDashboard;
  comparison: string;
  isTrading: boolean;
}): React.JSX.Element {
  const unavailable = new Set(data.unavailable.map((entry) => entry.tile));

  const actionsOutstanding =
    data.newOrders + data.overdueOrders + data.listingsNeedingChanges + data.outOfStockSkus;

  /*
   * Nothing listed, nothing ordered: the tiles are not drawn at all.
   *
   * The flag comes from the server rather than being inferred from the zeroes
   * on this page, for the reason given where it is computed - a failed tile
   * also reads zero, and this branch hides the seller's whole catalogue.
   */
  if (data.hasNothingYet) {
    return (
      <div className="space-y-6">
        <FirstSteps isTrading={isTrading} />
        <SetupCard data={data} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Partial data is stated, not hidden. A dashboard silently missing a
          tile is a dashboard that has quietly started lying. */}
      {data.unavailable.length > 0 && (
        <div
          role="status"
          className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          Some figures could not be worked out just now
          {data.unavailable.length === 1 ? '' : ` (${String(data.unavailable.length)} of them)`}. The
          rest of this page is up to date.
        </div>
      )}

      {/* ---- Work queue ---------------------------------------------------- */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label="New orders"
          value={String(data.newOrders)}
          hint="Waiting for you to accept"
          tone={data.newOrders > 0 ? 'warning' : 'default'}
          to="/seller/orders?status=NEW"
          isUnavailable={unavailable.has('orders')}
        />
        <Metric
          label="To dispatch"
          value={String(data.ordersToDispatch)}
          hint="Accepted and not yet shipped"
          to="/seller/orders"
          isUnavailable={unavailable.has('orders')}
        />
        <Metric
          label="Past dispatch time"
          value={String(data.overdueOrders)}
          hint="These are late"
          tone={data.overdueOrders > 0 ? 'danger' : 'default'}
          to="/seller/orders?overdueOnly=true"
          isUnavailable={unavailable.has('overdue')}
        />
        <Metric
          label="Open returns"
          value={String(data.returnsOpen)}
          hint={`${String(data.refundsInPeriod)} refunded in this period`}
          to="/seller/orders?status=RETURN_REQUESTED"
          isUnavailable={unavailable.has('returns')}
        />
      </section>

      {/* ---- Money --------------------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card title="Sales" description={`Between ${formatDay(data.periodFrom)} and ${formatDay(data.periodTo)}`}>
          {/*
            Stacked, never two columns.

            These were side by side, and a figure like ₹400,000.00 does not fit
            in half of a card that is itself a third of the row: the two amounts
            ran into each other, and `sm:` could not help because it measures the
            viewport while the card is a third of it. One under the other always
            fits, in every currency and every window width.
          */}
          <div className="space-y-5 px-6 py-5">
            <div className="min-w-0">
              <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                Gross sales
              </p>
              <p className="tabular mt-2 text-title-lg font-semibold text-ink">
                {data.grossSales === null
                  ? '—'
                  : formatMinor(data.grossSales.amountMinor, data.grossSales.currency)}
              </p>
              {data.grossSales !== null && (
                <p className="mt-1 text-xxs">
                  <Comparison
                    currentMinor={data.grossSales.amountMinor}
                    previousMinor={data.grossSales.previousAmountMinor}
                    currency={data.grossSales.currency}
                    periodLabel={comparison}
                  />
                </p>
              )}
            </div>

            <div className="min-w-0">
              <p className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">
                Your earnings
              </p>
              <p className="tabular mt-2 text-title-lg font-semibold text-ink">
                {data.netEarnings === null
                  ? '—'
                  : formatMinor(data.netEarnings.amountMinor, data.netEarnings.currency)}
              </p>
              <p className="mt-1 text-xxs text-ink-subtle">After marketplace commission</p>
            </div>
          </div>
        </Card>

        <Card title="Next payout">
          <div className="px-6 py-5">
            {/*
              The configuration-required state. Rendered INSTEAD of a figure
              when the marketplace has no payout provider, never alongside a
              reassuring one - a seller told "£14,700 due tomorrow" by a system
              that cannot send money has been misled about their own cash flow.
            */}
            {!data.payout.isProviderConfigured ? (
              <div className="space-y-2">
                <Badge tone="warning">Not set up yet</Badge>
                <p className="text-sm leading-relaxed text-ink-muted">
                  The marketplace has not finished setting up payouts, so nothing can be paid out
                  yet. Your earnings are still being recorded in full.
                </p>
                {data.payout.missingConfigurationKey !== null && (
                  <p className="text-xxs text-ink-subtle">
                    Operator: set{' '}
                    <code className="rounded bg-surface-sunken px-1 py-0.5 font-mono">
                      {data.payout.missingConfigurationKey}
                    </code>
                    .
                  </p>
                )}
              </div>
            ) : data.upcomingPayout === null ? (
              <div className="space-y-2">
                <p className="tabular text-title-lg font-semibold text-ink-subtle">—</p>
                <p className="text-sm text-ink-muted">Nothing is scheduled at the moment.</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="tabular text-title-lg font-semibold text-ink">
                  {formatMinor(data.upcomingPayout.amountMinor, data.upcomingPayout.currency)}
                </p>
                <p className="text-sm text-ink-muted">
                  {data.upcomingPayout.scheduledFor === null
                    ? 'Date not set yet'
                    : `Due ${formatDay(data.upcomingPayout.scheduledFor)}`}
                </p>
              </div>
            )}

            <div className="mt-4">
              <Link
                to="/seller/payments"
                className="text-sm font-medium text-brand hover:text-brand-hover"
              >
                Payments and statements →
              </Link>
            </div>
          </div>
        </Card>

        <Card title="Catalogue health">
          <dl className="divide-y divide-border-subtle">
            <HealthRow
              label="Live listings"
              value={String(data.activeListings)}
              to="/seller/listings?status=ACTIVE"
            />
            <HealthRow
              label="Being reviewed"
              value={String(data.listingsInReview)}
              to="/seller/listings?tab=PENDING_REVIEW"
            />
            <HealthRow
              label="Need changes"
              value={String(data.listingsNeedingChanges)}
              {...(data.listingsNeedingChanges > 0 ? { tone: 'warning' as const } : {})}
              to="/seller/listings?status=NEEDS_CHANGES"
            />
            <HealthRow
              label="Drafts"
              value={String(data.draftListings)}
              to="/seller/listings?tab=DRAFT"
            />
          </dl>
        </Card>
      </section>

      {/* ---- What needs doing ---------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card
          title="What needs doing"
          description={
            actionsOutstanding === 0
              ? 'Nothing is waiting on you right now.'
              : 'In the order it matters.'
          }
        >
          {actionsOutstanding === 0 &&
          data.documentsExpiringSoon.length === 0 &&
          data.closedLocations.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-ink-muted">
              You are up to date. New orders will appear here as they arrive.
            </p>
          ) : (
            <div>
              <ActionRow
                title="Orders past their dispatch time"
                detail="These count against your dispatch record"
                count={data.overdueOrders}
                to="/seller/orders?overdueOnly=true"
                tone="danger"
              />
              <ActionRow
                title="Orders waiting to be accepted"
                detail="Accept them to start the clock on picking"
                count={data.newOrders}
                to="/seller/orders?status=NEW"
                tone="warning"
              />
              <ActionRow
                title="Listings that need changes"
                detail="They are not on sale until these are fixed"
                count={data.listingsNeedingChanges}
                to="/seller/listings?status=NEEDS_CHANGES"
                tone="warning"
              />
              <ActionRow
                title="Products out of stock"
                detail="Live listings with nothing left to sell"
                count={data.outOfStockSkus}
                to="/seller/inventory?lowOnly=true"
                tone="warning"
              />
              <ActionRow
                title="Products running low"
                detail="At or below the level you set"
                count={data.lowStockSkus}
                to="/seller/inventory?lowOnly=true"
                tone="brand"
              />
              <ActionRow
                title="Documents expiring soon"
                detail="A lapsed certificate pauses the listings that rely on it"
                count={data.documentsExpiringSoon.length}
                to="/seller/profile"
                tone="warning"
              />
              <ActionRow
                title="Closed locations"
                detail="Stock at a closed place cannot be sold"
                count={data.closedLocations.length}
                to="/seller/profile"
                tone="brand"
              />
            </div>
          )}
        </Card>

        <SetupCard data={data} />
      </section>
    </div>
  );
}

function HealthRow({
  label,
  value,
  tone,
  to,
}: {
  label: string;
  value: string;
  tone?: 'warning';
  to: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between px-6 py-3">
      <dt className="text-sm text-ink-muted">
        <Link to={to} className="hover:text-ink">
          {label}
        </Link>
      </dt>
      <dd className={cx('tabular text-sm font-semibold', tone === 'warning' ? 'text-warning' : 'text-ink')}>
        {value}
      </dd>
    </div>
  );
}

/** A date, short. Invalid input renders as a dash rather than "Invalid Date". */
function formatDay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
