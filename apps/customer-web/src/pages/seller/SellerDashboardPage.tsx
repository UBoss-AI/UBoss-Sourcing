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
import { useI18n } from '@/i18n/i18n-context';
import { formatMinor, fetchDashboard, type SellerDashboard } from '@/lib/seller';
import type { SellerOutletContext } from './SellerLayout';

type Range = 'today' | 'week' | 'month' | 'quarter';

const RANGES = Object.freeze([
  { value: 'today', labelKey: 'seller.dashboard.range.today', comparisonKey: 'seller.dashboard.against.today' },
  { value: 'week', labelKey: 'seller.dashboard.range.week', comparisonKey: 'seller.dashboard.against.week' },
  { value: 'month', labelKey: 'seller.dashboard.range.month', comparisonKey: 'seller.dashboard.against.month' },
  { value: 'quarter', labelKey: 'seller.dashboard.range.quarter', comparisonKey: 'seller.dashboard.against.quarter' },
] as const);

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
  const { t } = useI18n();

  const current = BigInt(currentMinor);
  const previous = BigInt(previousMinor);

  if (previous === 0n) return null;

  const difference = current - previous;
  if (difference === 0n)
    return (
      <span className="text-ink-subtle">
        {t('seller.dashboard.levelWith', { period: periodLabel })}
      </span>
    );

  const isUp = difference > 0n;
  const magnitude = (isUp ? difference : -difference).toString();

  return (
    <span className={isUp ? 'text-success' : 'text-danger'}>
      {isUp ? '↑' : '↓'}{' '}
      {t('seller.dashboard.onPeriod', {
        amount: formatMinor(magnitude, currency),
        period: periodLabel,
      })}
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
  const { t } = useI18n();
  const seller = useOutletContext<SellerOutletContext>();
  const [range, setRange] = useState<Range>('today');

  const query = useQuery({
    queryKey: ['seller', 'dashboard', range],
    queryFn: () => fetchDashboard(range),
    // Stale quickly: an order that arrived two minutes ago is the reason the
    // seller is looking at this page.
    staleTime: 30_000,
  });

  const found = RANGES.find((entry) => entry.value === range);
  const comparison = t(found?.comparisonKey ?? 'seller.dashboard.against.generic');

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('seller.dashboard.greeting', { name: seller.displayName })}
        description={t('seller.dashboard.intro')}
        actions={
          <div
            role="group"
            aria-label={t('seller.dashboard.timeRange')}
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
                {t(entry.labelKey)}
              </button>
            ))}
          </div>
        }
      />

      {query.isPending && <LoadingState label={t('seller.dashboard.loading')} />}

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
  const { t } = useI18n();

  const steps = ['account', 'product', 'orders'] as const;

  return (
    <Card
      title={t('seller.dashboard.nothingYet')}
      description={t('seller.dashboard.nothingYetBody')}
    >
      <div className="px-6 py-5">
        <ol className="space-y-5">
          {steps.map((step, index) => (
            <li key={step} className="flex gap-4">
              <span
                aria-hidden="true"
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand"
              >
                {index + 1}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium text-ink">{t(firstStepTitleKey(step))}</p>
                <p className="mt-0.5 text-sm leading-relaxed text-ink-muted">
                  {t(firstStepBodyKey(step))}
                </p>
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
              <Button variant="primary">{t('seller.dashboard.addFirstListing')}</Button>
            </Link>
          ) : (
            <Link to="/seller/onboarding">
              <Button variant="primary">{t('seller.dashboard.continueApplication')}</Button>
            </Link>
          )}
          <Link to="/seller/profile">
            <Button variant="secondary">{t('seller.dashboard.companyProfile')}</Button>
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
  const { t } = useI18n();

  return (
      <Card
        title={t('seller.dashboard.setup')}
        description={t('seller.dashboard.setupIntro')}
        actions={
          data.onboarding.percentComplete < 100 ? (
            <Link to="/seller/onboarding">
              <Button size="sm" variant="primary">
                {t('seller.dashboard.continue')}
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
              aria-label={t('seller.dashboard.setupProgress')}
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
              {t('seller.dashboard.setupDone')}
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
                {t('seller.dashboard.qualityScore')}
              </p>
              <p className="tabular mt-1 text-title-md font-semibold text-ink">
                {data.qualityScore.toFixed(1)}
              </p>
              <p className="mt-1 text-xxs text-ink-subtle">
                {t('seller.dashboard.qualityScoreHint')}
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
  const { t } = useI18n();

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
          {data.unavailable.length === 1
            ? t('seller.dashboard.someMissingOne')
            : t('seller.dashboard.someMissing', { count: data.unavailable.length })}
        </div>
      )}

      {/* ---- Work queue ---------------------------------------------------- */}
      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label={t('seller.dashboard.newOrders')}
          value={String(data.newOrders)}
          hint={t('seller.dashboard.newOrdersHint')}
          tone={data.newOrders > 0 ? 'warning' : 'default'}
          to="/seller/orders?status=NEW"
          isUnavailable={unavailable.has('orders')}
        />
        <Metric
          label={t('seller.dashboard.toDispatch')}
          value={String(data.ordersToDispatch)}
          hint={t('seller.dashboard.toDispatchHint')}
          to="/seller/orders"
          isUnavailable={unavailable.has('orders')}
        />
        <Metric
          label={t('seller.dashboard.pastDispatch')}
          value={String(data.overdueOrders)}
          hint={t('seller.dashboard.pastDispatchHint')}
          tone={data.overdueOrders > 0 ? 'danger' : 'default'}
          to="/seller/orders?overdueOnly=true"
          isUnavailable={unavailable.has('overdue')}
        />
        <Metric
          label={t('seller.dashboard.openReturns')}
          value={String(data.returnsOpen)}
          hint={t('seller.dashboard.refundedInPeriod', { count: data.refundsInPeriod })}
          to="/seller/orders?status=RETURN_REQUESTED"
          isUnavailable={unavailable.has('returns')}
        />
      </section>

      {/* ---- Money --------------------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-3">
        <Card
          title={t('seller.dashboard.sales')}
          description={t('seller.dashboard.between', {
            from: formatDay(data.periodFrom),
            to: formatDay(data.periodTo),
          })}
        >
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
                {t('seller.dashboard.grossSales')}
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
                {t('seller.dashboard.yourEarnings')}
              </p>
              <p className="tabular mt-2 text-title-lg font-semibold text-ink">
                {data.netEarnings === null
                  ? '—'
                  : formatMinor(data.netEarnings.amountMinor, data.netEarnings.currency)}
              </p>
              <p className="mt-1 text-xxs text-ink-subtle">
                {t('seller.dashboard.afterCommission')}
              </p>
            </div>
          </div>
        </Card>

        <Card title={t('seller.dashboard.nextPayout')}>
          <div className="px-6 py-5">
            {/*
              The configuration-required state. Rendered INSTEAD of a figure
              when the marketplace has no payout provider, never alongside a
              reassuring one - a seller told "£14,700 due tomorrow" by a system
              that cannot send money has been misled about their own cash flow.
            */}
            {!data.payout.isProviderConfigured ? (
              <div className="space-y-2">
                <Badge tone="warning">{t('seller.payments.notSetUp')}</Badge>
                <p className="text-sm leading-relaxed text-ink-muted">
                  {t('seller.dashboard.noPayoutProvider')}
                </p>
                {data.payout.missingConfigurationKey !== null && (
                  <p className="text-xxs text-ink-subtle">
                    {t('seller.dashboard.operatorSet')}{' '}
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
                <p className="text-sm text-ink-muted">{t('seller.dashboard.nothingScheduled')}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="tabular text-title-lg font-semibold text-ink">
                  {formatMinor(data.upcomingPayout.amountMinor, data.upcomingPayout.currency)}
                </p>
                <p className="text-sm text-ink-muted">
                  {data.upcomingPayout.scheduledFor === null
                    ? t('seller.dashboard.dateNotSet')
                    : t('seller.payments.dueOn', {
                        date: formatDay(data.upcomingPayout.scheduledFor),
                      })}
                </p>
              </div>
            )}

            <div className="mt-4">
              <Link
                to="/seller/payments"
                className="text-sm font-medium text-brand hover:text-brand-hover"
              >
                {t('seller.dashboard.paymentsLink')}
              </Link>
            </div>
          </div>
        </Card>

        <Card title={t('seller.dashboard.catalogueHealth')}>
          <dl className="divide-y divide-border-subtle">
            <HealthRow
              label={t('seller.dashboard.liveListings')}
              value={String(data.activeListings)}
              to="/seller/listings?status=ACTIVE"
            />
            <HealthRow
              label={t('seller.dashboard.beingReviewed')}
              value={String(data.listingsInReview)}
              to="/seller/listings?tab=PENDING_REVIEW"
            />
            <HealthRow
              label={t('seller.dashboard.needChanges')}
              value={String(data.listingsNeedingChanges)}
              {...(data.listingsNeedingChanges > 0 ? { tone: 'warning' as const } : {})}
              to="/seller/listings?status=NEEDS_CHANGES"
            />
            <HealthRow
              label={t('seller.dashboard.drafts')}
              value={String(data.draftListings)}
              to="/seller/listings?tab=DRAFT"
            />
          </dl>
        </Card>
      </section>

      {/* ---- What needs doing ---------------------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <Card
          title={t('seller.dashboard.whatNeedsDoing')}
          description={
            actionsOutstanding === 0
              ? t('seller.dashboard.nothingWaiting')
              : t('seller.dashboard.inOrderItMatters')
          }
        >
          {actionsOutstanding === 0 &&
          data.documentsExpiringSoon.length === 0 &&
          data.closedLocations.length === 0 ? (
            <p className="px-6 py-8 text-center text-sm text-ink-muted">
              {t('seller.dashboard.upToDate')}
            </p>
          ) : (
            <div>
              <ActionRow
                title={t('seller.dashboard.action.overdueTitle')}
                detail={t('seller.dashboard.action.overdueDetail')}
                count={data.overdueOrders}
                to="/seller/orders?overdueOnly=true"
                tone="danger"
              />
              <ActionRow
                title={t('seller.dashboard.action.newTitle')}
                detail={t('seller.dashboard.action.newDetail')}
                count={data.newOrders}
                to="/seller/orders?status=NEW"
                tone="warning"
              />
              <ActionRow
                title={t('seller.dashboard.action.changesTitle')}
                detail={t('seller.dashboard.action.changesDetail')}
                count={data.listingsNeedingChanges}
                to="/seller/listings?status=NEEDS_CHANGES"
                tone="warning"
              />
              <ActionRow
                title={t('seller.dashboard.action.outOfStockTitle')}
                detail={t('seller.dashboard.action.outOfStockDetail')}
                count={data.outOfStockSkus}
                to="/seller/inventory?lowOnly=true"
                tone="warning"
              />
              <ActionRow
                title={t('seller.dashboard.action.lowStockTitle')}
                detail={t('seller.dashboard.action.lowStockDetail')}
                count={data.lowStockSkus}
                to="/seller/inventory?lowOnly=true"
                tone="brand"
              />
              <ActionRow
                title={t('seller.dashboard.action.documentsTitle')}
                detail={t('seller.dashboard.action.documentsDetail')}
                count={data.documentsExpiringSoon.length}
                to="/seller/profile"
                tone="warning"
              />
              <ActionRow
                title={t('seller.dashboard.action.closedTitle')}
                detail={t('seller.dashboard.action.closedDetail')}
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

/**
 * The three things a brand-new seller is pointed at.
 *
 * Keys rather than sentences, and derived from the step's own name so the two
 * halves of a step cannot drift apart.
 */
type FirstStep = 'account' | 'product' | 'orders';

function firstStepTitleKey(step: FirstStep): `seller.dashboard.firstStep.${FirstStep}.title` {
  return `seller.dashboard.firstStep.${step}.title`;
}

function firstStepBodyKey(step: FirstStep): `seller.dashboard.firstStep.${FirstStep}.body` {
  return `seller.dashboard.firstStep.${step}.body`;
}
