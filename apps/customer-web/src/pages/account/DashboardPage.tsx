/**
 * The buyer's dashboard.
 *
 * What a procurement officer opens first: is anything waiting on me?
 * Everything else in the account area answers a question somebody already knows
 * they have; this answers the one they have not asked yet.
 *
 * It answers it as a SHAPE. One ring of every order the buyer has, grouped the
 * way a buyer thinks about them, and a short written summary of it beside. There
 * are no tiles and no lists under it — see the note at the foot of this file.
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
 * So a buyer can send a colleague "the orders waiting on us this month", and so
 * that Back from an order returns to the ring they clicked it from.
 * `useDashboardParams` owns that; this page only reads it.
 *
 * Changing the window changes the React Query key, which is also what protects
 * against a stale answer when somebody clicks through the ranges quickly: a
 * reply for the old window is cached under the old key and is never the one
 * rendered. There is no sequence number anywhere in this file.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BentoCell, BentoGrid, ConsoleGround, ConsoleHeader } from '@/components/dashboard/console';
import { RangeTabs, RefreshButton } from '@/components/dashboard/controls';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { AiInsightsCard } from '@/components/dashboard/AiInsightsCard';
import { ErrorState } from '@/components/ui';
import { formatDate, formatRelative } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useDashboardParams } from '@/lib/use-dashboard-params';
import { useInsightStream } from '@/lib/use-insight-stream';
import {
  buyerSegments,
  dashboardKey,
  fetchDashboard,
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
   * while it is still being written. The finished object that replaces it when
   * the stream closes is the validated one — the server checks every figure the
   * model cited against the metric bundle before it sends it.
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
   * Handled here rather than in the ring, because the whole screen is that one
   * request: a chart that cannot be drawn and an insights panel measured over
   * figures that never arrived are the same failure, and it is worth one
   * sentence with a retry rather than two half-states.
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
            placeholders={[
              t('buyerDashboard.ai.q1'),
              t('buyerDashboard.ai.q2'),
              t('buyerDashboard.ai.q3'),
              t('buyerDashboard.ai.q4'),
            ]}
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
              generated: t('aiInsights.generated'),
              disclosure: t('aiInsights.disclosure'),
              deterministic: t('aiInsights.deterministic'),
              unavailable: t('aiInsights.unavailable'),
              idle: t('aiInsights.idle'),
            }}
          />
        </BentoCell>
      </BentoGrid>
    </ConsoleGround>
  );
}

/*
 * The three stat tiles and the five cards under the ring are gone.
 *
 * Spend, what is arriving and how many plans are running; then recent orders,
 * arriving soon, what needs paying, upcoming schedules and the buyer's own ERP
 * health. This screen is the ring and the insights panel now, and the same
 * reasoning applies as on the operator and carrier dashboards before it: the
 * shape says what is waiting, and every list under it was a shorter, staler
 * copy of a screen that is in the account navigation anyway - Orders, Payments,
 * Schedules, Integrations.
 *
 * None of the DATA is gone. `GET /account/dashboard` still returns spend,
 * deliveries, payment actions, schedules and ERP health, `buyer-dashboard.ts`
 * still types all of it, and the insights panel is measured over the whole
 * bundle - so the paragraph beside the ring can still say that three orders
 * are waiting on payment. Their markup is in this file's history.
 */
