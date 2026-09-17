/**
 * The buyer's dashboard.
 *
 * What a procurement officer opens first: is anything waiting on me, what is
 * arriving, and what have we spent. Everything else in the account area
 * answers a question somebody already knows they have; this answers the one
 * they have not asked yet.
 *
 * EVERY FIGURE IS AGGREGATED ON THE SERVER, in one request. Nothing here counts
 * a list it was sent, because a dashboard that computes its own totals is a
 * dashboard that eventually disagrees with the screen it links to — and the
 * disagreement is always found by the person whose money it is.
 *
 * ONE thing on this screen does arithmetic, and it is the same exception the
 * carrier portal records: `buyerSegments` folds the server's per-status counts
 * into the five groups a buyer thinks in. That is arithmetic on aggregates it
 * was handed, which is a different act from counting a list — the rule is
 * about never deriving a total from a PAGE of rows, where the page is a window
 * onto data the screen cannot see all of.
 *
 * ---
 *
 * THE WINDOW AND THE SELECTION ARE IN THE URL
 *
 * So a buyer can send a colleague "our September spend", and so that Back from
 * an order returns to the ring they clicked it from. `useDashboardParams`
 * owns that; this page only reads it.
 *
 * Changing the window changes the React Query key, which is also what protects
 * against a stale answer when somebody clicks through the ranges quickly: a
 * reply for the old window is cached under the old key and is never the one
 * rendered. There is no sequence number anywhere in this file.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  BentoCell,
  BentoGrid,
  ConsoleCard,
  ConsoleGround,
  ConsoleHeader,
} from '@/components/dashboard/console';
import { RangeTabs, RefreshButton, StatTile } from '@/components/dashboard/controls';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { AiInsightsCard } from '@/components/dashboard/AiInsightsCard';
import { Badge, ErrorState } from '@/components/ui';
import { ChevronRightIcon } from '@/components/icons';
import { formatDate, formatDateTime, formatMoney, formatRelative } from '@/lib/format';
import { orderStatusLabel, orderStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useDashboardParams } from '@/lib/use-dashboard-params';
import { useInsightStream } from '@/lib/use-insight-stream';
import {
  buyerSegments,
  dashboardKey,
  fetchDashboard,
  segmentOrderQuery,
  type BuyerDashboard,
  type BuyerSegmentKey,
} from '@/lib/buyer-dashboard';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';

/**
 * How often the page refreshes itself.
 *
 * Two minutes, and only while the tab is in front — the same cadence and the
 * same reasoning as the carrier dashboard. A payment that failed two minutes
 * ago is worth knowing about inside the minute; anything tighter multiplies
 * into real load on a self-hosted box for no gain, and a background tab
 * polling all afternoon is work nobody asked for.
 *
 * Deliberately a poll rather than a socket. This product has no realtime
 * infrastructure, and adding a WebSocket stack so that a number can change
 * without being asked for is a large, permanent piece of machinery bought for
 * a visual effect.
 */
const REFRESH_MS = 120_000;

/** The five ring groups, and the key each one's label lives under. */
const SEGMENT_LABELS: Record<BuyerSegmentKey, TranslationKey> = {
  action: 'buyerDashboard.segment.action',
  processing: 'buyerDashboard.segment.processing',
  transit: 'buyerDashboard.segment.transit',
  delivered: 'buyerDashboard.segment.delivered',
  closed: 'buyerDashboard.segment.closed',
};

export function DashboardPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const params = useDashboardParams();
  const { business } = useStorefront();

  // `noIndex`, like every other account screen: this page is somebody's own
  // orders and spend, and it is behind a session anyway.
  useDocumentMeta({ title: t('buyerDashboard.pageTitle'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: dashboardKey(params.window),
    queryFn: () => fetchDashboard(params.window),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  /*
   * The insight arrives as Server-Sent Events, so the summary is on screen
   * while it is still being written. The findings underneath it appear only
   * once the stream closes — that is the server's doing, and it is the reason
   * a citation can be trusted: it has been checked against the metric bundle
   * before it is sent.
   */
  const insights = useInsightStream('/account/dashboard/insights/stream', () => ({
    from: params.window.from,
    to: params.window.to,
    language,
    ...(params.segment === null ? {} : { segment: params.segment }),
  }));

  const data = query.data;

  const segments = useMemo(
    () =>
      data === undefined ? [] : buyerSegments(data.ordersByStatus, (key) => t(SEGMENT_LABELS[key])),
    [data, t],
  );

  /*
   * A hard failure of the ONE request behind the page.
   *
   * Handled here rather than card by card, because there is one request: a
   * grid of nine cards each showing its own error is nine copies of the same
   * sentence. The donut carries its own error state for the case where this
   * page is later split.
   */
  if (query.isError && data === undefined) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  return (
    <ConsoleGround>
      <ConsoleHeader
        title={t('buyerDashboard.heading')}
        subtitle={t('buyerDashboard.subtitle')}
        lastUpdatedLabel={
          data === undefined
            ? t('buyerDashboard.loading')
            : t('buyerDashboard.updated', { when: formatRelative(data.generatedAt) })
        }
        lastUpdatedAt={data?.generatedAt ?? null}
      >
        <RangeTabs
          options={[
            { key: 'today', label: t('buyerDashboard.range.today') },
            { key: '7d', label: t('buyerDashboard.range.last7') },
            { key: '30d', label: t('buyerDashboard.range.last30') },
            { key: 'custom', label: t('buyerDashboard.range.custom') },
          ]}
          value={params.range}
          onChange={params.setRange}
          customFrom={params.customFrom}
          customTo={params.customTo}
          onCustomChange={params.setCustomRange}
          labels={{
            legend: t('buyerDashboard.range.legend'),
            from: t('buyerDashboard.range.from'),
            to: t('buyerDashboard.range.to'),
            apply: t('common.search'),
          }}
        />

        <RefreshButton
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
          labels={{
            refresh: t('buyerDashboard.refresh'),
            refreshing: t('buyerDashboard.refreshing'),
          }}
        />
      </ConsoleHeader>

      <BentoGrid>
        {/* --- The ring ------------------------------------------------- */}
        <BentoCell span={4} spanMd={3}>
          <ModernDonutCard
            title={t('buyerDashboard.myOrders')}
            description={t('buyerDashboard.myOrdersDescription')}
            total={data?.orderCount ?? 0}
            centerLabel={t('buyerDashboard.myOrdersCenter')}
            unitLabel={t('buyerDashboard.myOrdersUnit')}
            segments={segments}
            selectedSegment={params.segment}
            onSegmentSelect={params.setSegment}
            dateRangeLabel={
              data === undefined
                ? undefined
                : t('buyerDashboard.windowLabel', {
                    from: formatDate(data.window.from),
                    to: formatDate(data.window.to),
                  })
            }
            lastUpdatedAt={data?.generatedAt ?? null}
            loading={query.isLoading}
            labels={{
              status: t('buyerDashboard.table.status'),
              value: t('buyerDashboard.table.orders'),
              share: t('buyerDashboard.table.share'),
              viewAsTable: t('buyerDashboard.viewAsTable'),
              clearFilter: t('buyerDashboard.clearFilter'),
              filteredBy: t('buyerDashboard.filteredBy'),
              empty: t('buyerDashboard.noOrders'),
              error: t('common.somethingWentWrong'),
              retry: t('common.retry'),
              loading: t('common.loading'),
              remainder: t('buyerDashboard.remainder'),
              clampNote: t('buyerDashboard.clampNote'),
            }}
          />
        </BentoCell>

        {/* --- AI ------------------------------------------------------- */}
        <BentoCell span={2} spanMd={3}>
          <AiInsightsCard
            className="h-full"
            insight={insights.insight}
            streamedSummary={insights.streamedSummary}
            busy={insights.busy}
            failed={insights.failed}
            onExplain={() => {
              insights.ask();
            }}
            onAsk={(question) => {
              insights.ask(question);
            }}
            suggestions={[
              t('buyerDashboard.ai.q1'),
              t('buyerDashboard.ai.q2'),
              t('buyerDashboard.ai.q3'),
              t('buyerDashboard.ai.q4'),
            ]}
            placeholders={[
              t('buyerDashboard.ai.q1'),
              t('buyerDashboard.ai.q2'),
              t('buyerDashboard.ai.q3'),
            ]}
            renderLink={(href, children) => <Link to={href}>{children}</Link>}
            generatedLabel={
              insights.insight === null ? undefined : formatRelative(insights.insight.generatedAt)
            }
            labels={{
              title: t('aiInsights.title'),
              askLabel: t('aiInsights.askLabel'),
              ask: t('aiInsights.ask'),
              asking: t('aiInsights.asking'),
              asked: t('aiInsights.asked'),
              askFailed: t('aiInsights.askFailed'),
              explainChart: t('aiInsights.explainChart'),
              explaining: t('aiInsights.explaining'),
              explained: t('aiInsights.explained'),
              explainFailed: t('aiInsights.explainFailed'),
              suggestions: t('aiInsights.suggestions'),
              findings: t('aiInsights.findings'),
              nextSteps: t('aiInsights.nextSteps'),
              evidence: t('aiInsights.evidence'),
              generated: t('aiInsights.generated'),
              disclosure: t('aiInsights.disclosure'),
              deterministic: t('aiInsights.deterministic'),
              unavailable: t('aiInsights.unavailable'),
              idle: t('aiInsights.idle'),
              severity: {
                info: t('aiInsights.severity.info'),
                attention: t('aiInsights.severity.attention'),
                urgent: t('aiInsights.severity.urgent'),
              },
            }}
          />
        </BentoCell>

        {/* --- The figures ---------------------------------------------- */}
        <SupportingTiles data={data} />

        {/* --- The filtered detail -------------------------------------- */}
        <BentoCell span={3}>
          <FilteredOrders data={data} segment={params.segment} />
        </BentoCell>

        <BentoCell span={3}>
          <ArrivingSoon data={data} />
        </BentoCell>

        <BentoCell span={3}>
          <PaymentActions data={data} />
        </BentoCell>

        <BentoCell span={3}>
          <Schedules data={data} />
        </BentoCell>

        <BentoCell span={6}>
          <ErpHealth data={data} />
        </BentoCell>
      </BentoGrid>
    </ConsoleGround>
  );
}

// ---------------------------------------------------------------------------
// The figures
// ---------------------------------------------------------------------------

/**
 * The four headline tiles.
 *
 * A tile whose figure is still loading shows a dash rather than a zero. Zero is
 * a claim about the business — "nothing is waiting on you" — and making it
 * before the answer has arrived is the one thing a loading state must not do.
 */
function SupportingTiles({ data }: { data: BuyerDashboard | undefined }): React.JSX.Element {
  const { t } = useI18n();

  const dash = '—';
  const attention = data?.schedules.needsAttention ?? 0;
  const overdue = data?.deliveries.overdue ?? 0;

  return (
    <>
      <BentoCell span={2} spanMd={1}>
        <ConsoleCard bodyClassName="">
          <StatTile
            label={t('buyerDashboard.tile.spend')}
            value={data === undefined ? dash : formatMoney(data.spend.paid)}
            sub={
              data === undefined
                ? undefined
                : t('buyerDashboard.tile.spendPrevious', {
                    amount: formatMoney(data.spend.previousPaid),
                  })
            }
          />
        </ConsoleCard>
      </BentoCell>

      <BentoCell span={2} spanMd={1}>
        <ConsoleCard bodyClassName="">
          <StatTile
            label={t('buyerDashboard.tile.arriving')}
            value={data === undefined ? dash : String(data.deliveries.arrivingSoon.length)}
            sub={
              overdue > 0
                ? t('buyerDashboard.tile.overdue', { count: overdue })
                : t('buyerDashboard.tile.nextSevenDays')
            }
            tone={overdue > 0 ? 'warning' : 'neutral'}
          />
        </ConsoleCard>
      </BentoCell>

      <BentoCell span={2} spanMd={1}>
        <ConsoleCard bodyClassName="">
          <StatTile
            label={t('buyerDashboard.tile.schedules')}
            value={data === undefined ? dash : String(data.schedules.active)}
            sub={
              attention > 0
                ? t('buyerDashboard.tile.schedulesAttention', { count: attention })
                : t('buyerDashboard.tile.schedulesHealthy')
            }
            tone={attention > 0 ? 'warning' : 'neutral'}
          />
        </ConsoleCard>
      </BentoCell>
    </>
  );
}

// ---------------------------------------------------------------------------
// The lists
// ---------------------------------------------------------------------------

/**
 * The orders behind the selected slice.
 *
 * The selection filters `recentOrders`, which is the server's own list, and
 * the card says plainly that it is showing the most recent few rather than
 * everything — with a link to the full, filtered order list built from the
 * SAME status table the ring was drawn from.
 *
 * It does not silently page or count: "6 of 41" would need a total this card
 * was not given, and inventing one is exactly what the rest of this screen
 * refuses to do.
 */
function FilteredOrders({
  data,
  segment,
}: {
  data: BuyerDashboard | undefined;
  segment: string | null;
}): React.JSX.Element {
  const { t } = useI18n();

  const rows = (data?.recentOrders ?? []).filter((order) => {
    if (segment === null) return true;

    const query = segmentOrderQuery(segment as BuyerSegmentKey);
    if (query === '') return true;

    const statuses = new URLSearchParams(query).get('status')?.split(',') ?? [];
    return statuses.includes(order.status);
  });

  const query = segment === null ? '' : segmentOrderQuery(segment as BuyerSegmentKey);

  return (
    <ConsoleCard
      title={t('buyerDashboard.recentOrders')}
      description={segment === null ? undefined : t('buyerDashboard.recentOrdersFiltered')}
      actions={
        <Link
          to={query === '' ? '/account/orders' : `/account/orders?${query}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          {t('buyerDashboard.viewAll')}
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </Link>
      }
    >
      {data === undefined ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">
          {/*
            Two different sentences, because they are two different facts. The
            ring above already says "you have placed no orders" when that is
            the case; repeating it here is the same claim twice, and it leaves
            "no orders in this slice" with nothing of its own to say.
          */}
          {segment === null
            ? t('buyerDashboard.noRecentOrders')
            : t('buyerDashboard.noOrdersForFilter')}
        </p>
      ) : (
        <ul className="divide-y divide-console-border/60">
          {rows.map((order) => (
            <li key={order.orderId}>
              <Link
                to={`/account/orders/${order.orderId}`}
                className="group flex items-center justify-between gap-3 px-5 py-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink group-hover:text-brand">
                    {order.orderNumber}
                  </span>
                  <span className="mt-0.5 block text-xxs text-ink-subtle">
                    {order.placedAt === null ? '—' : formatDateTime(order.placedAt)}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-3">
                  <Badge tone={orderStatusTone(order.status)}>
                    {orderStatusLabel(t, order.status)}
                  </Badge>
                  <span className="tabular text-sm text-ink">{formatMoney(order.total)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsoleCard>
  );
}

function ArrivingSoon({ data }: { data: BuyerDashboard | undefined }): React.JSX.Element {
  const { t } = useI18n();
  const rows = data?.deliveries.arrivingSoon ?? [];

  return (
    <ConsoleCard
      title={t('buyerDashboard.arrivingSoon')}
      description={t('buyerDashboard.arrivingSoonDescription')}
    >
      {data === undefined ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">
          {t('buyerDashboard.nothingArriving')}
        </p>
      ) : (
        <ul className="divide-y divide-console-border/60">
          {rows.map((order) => (
            <li key={order.orderId}>
              <Link
                to={`/account/orders/${order.orderId}`}
                className="group flex items-baseline justify-between gap-3 px-5 py-3 text-sm"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium text-ink group-hover:text-brand">
                    {order.orderNumber}
                  </span>
                  {order.carrier === null ? null : (
                    <span className="text-ink-subtle"> · {order.carrier}</span>
                  )}
                </span>
                <span className="tabular shrink-0 text-xs text-ink-muted">
                  {formatDate(order.deliveryTo)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsoleCard>
  );
}

/**
 * What the buyer has to pay for or get signed off.
 *
 * Not limited to the reporting window — see the note on the query in
 * `buyer-dashboard.service.ts`. An unpaid order from six weeks ago is more
 * urgent than one from this morning, and a window that hid it would mean the
 * card emptied itself the longer the problem went unattended.
 */
function PaymentActions({ data }: { data: BuyerDashboard | undefined }): React.JSX.Element {
  const { t } = useI18n();
  const rows = data?.paymentActions ?? [];

  return (
    <ConsoleCard
      title={t('buyerDashboard.needsYou')}
      description={t('buyerDashboard.needsYouDescription')}
    >
      {data === undefined ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">
          {t('buyerDashboard.nothingNeedsYou')}
        </p>
      ) : (
        <ul className="divide-y divide-console-border/60">
          {rows.map((order) => (
            <li key={order.orderId}>
              <Link
                to={`/account/orders/${order.orderId}`}
                className="group flex items-center justify-between gap-3 px-5 py-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-ink group-hover:text-brand">
                    {order.orderNumber}
                  </span>
                  <span className="mt-0.5 block text-xxs text-ink-subtle">
                    {order.placedAt === null ? '—' : formatDateTime(order.placedAt)}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-3">
                  <Badge tone={orderStatusTone(order.status)}>
                    {orderStatusLabel(t, order.status)}
                  </Badge>
                  <span className="tabular text-sm text-warning">
                    {formatMoney(order.outstanding)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsoleCard>
  );
}

function Schedules({ data }: { data: BuyerDashboard | undefined }): React.JSX.Element {
  const { t } = useI18n();
  const rows = data?.schedules.upcoming ?? [];

  return (
    <ConsoleCard
      title={t('buyerDashboard.upcomingSchedules')}
      actions={
        <Link
          to="/account/schedules"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          {t('buyerDashboard.viewAll')}
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </Link>
      }
    >
      {data === undefined ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">
          {t('buyerDashboard.noSchedules')}
        </p>
      ) : (
        <ul className="divide-y divide-console-border/60">
          {rows.map((schedule) => (
            <li key={schedule.scheduleId}>
              <Link
                to={`/account/schedules/${schedule.scheduleId}`}
                className="group flex items-center justify-between gap-3 px-5 py-3 text-sm"
              >
                <span className="min-w-0 truncate font-medium text-ink group-hover:text-brand">
                  {schedule.name}
                </span>

                <span className="flex shrink-0 items-center gap-2">
                  {/*
                    A plan that cannot run without the cardholder says so here
                    as well as in the tile above. It is the one row on this
                    card somebody has to act on, and a reader scanning four
                    dates should not have to open each to find it.
                  */}
                  {schedule.needsAttention ? (
                    <Badge tone="warning">{t('buyerDashboard.actionNeeded')}</Badge>
                  ) : null}
                  <span className="tabular text-xs text-ink-muted">
                    {schedule.nextRunAt === null ? '—' : formatDate(schedule.nextRunAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </ConsoleCard>
  );
}

/**
 * Is the buyer's own ERP feed working?
 *
 * Every field is empty for a buyer who has not connected one, which is the
 * ordinary case and NOT an error state. It says so in words rather than
 * showing a grey light that reads as broken — the same treatment the carrier
 * portal gives a carrier with no API.
 */
function ErpHealth({ data }: { data: BuyerDashboard | undefined }): React.JSX.Element {
  const { t } = useI18n();

  if (data === undefined) {
    return (
      <ConsoleCard title={t('buyerDashboard.erpHealth')} bodyClassName="px-5 py-4">
        <p className="text-sm text-ink-subtle">{t('common.loading')}</p>
      </ConsoleCard>
    );
  }

  const erp = data.erp;

  if (erp.connectionCount === 0) {
    return (
      <ConsoleCard title={t('buyerDashboard.erpHealth')} bodyClassName="px-5 py-4">
        <p className="text-sm text-ink-muted">{t('buyerDashboard.noErp')}</p>
        <Link
          to="/account/integrations/erp"
          className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          {t('buyerDashboard.connectErp')}
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </Link>
      </ConsoleCard>
    );
  }

  const unhealthy = erp.unhealthyCount > 0 || erp.deadLetteredEvents > 0;

  return (
    <ConsoleCard
      title={t('buyerDashboard.erpHealth')}
      description={erp.organizationName ?? undefined}
      bodyClassName="px-5 py-4"
      actions={
        <Link
          to="/account/integrations/erp"
          className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
        >
          {t('buyerDashboard.viewAll')}
          <ChevronRightIcon className="h-3.5 w-3.5" />
        </Link>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={unhealthy ? 'warning' : 'success'}>
          {t('buyerDashboard.erpConnections', {
            active: erp.activeCount,
            total: erp.connectionCount,
          })}
        </Badge>

        <p className="text-sm text-ink-muted">
          {erp.lastSyncAt === null
            ? t('buyerDashboard.erpNeverSynced')
            : t('buyerDashboard.erpLastSync', { when: formatRelative(erp.lastSyncAt) })}
        </p>
      </div>

      {erp.deadLetteredEvents > 0 ? (
        <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
          {t('buyerDashboard.erpDeadLettered', { count: erp.deadLetteredEvents })}
        </p>
      ) : null}
    </ConsoleCard>
  );
}
