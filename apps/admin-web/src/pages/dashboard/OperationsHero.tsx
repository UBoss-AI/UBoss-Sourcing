/**
 * The admin dashboard: what is waiting, drawn as a ring, with the insights
 * panel beside it.
 *
 * Its own component rather than a hundred more lines inside `DashboardPage.tsx`,
 * which owns the page heading, the reporting window and the refresh control and
 * nothing else. This file owns the one request the screen makes.
 *
 * There is nothing under the ring. Every figure it draws belongs to a queue
 * screen that is in the navigation rail already, and a second, thinner list of
 * those screens under the chart was a copy that could only ever go stale.
 *
 * ---
 *
 * THE PERMISSION MODEL IS THE SERVER'S, AND IT SHOWS THROUGH
 *
 * `/admin/operations` counts only the queues the caller holds the ACTING
 * grant for, and omits the rest — absent, not zero, because the difference
 * between "0 pending data-subject requests" and "you may not see that" is
 * itself information.
 *
 * So this component draws whatever it is sent and never reasons about roles.
 * A warehouse manager sees a two-segment ring and a finance approver sees a
 * different two, and neither of them learns anything about the other's queues.
 * There is no permission check in this file at all, and there must not be one:
 * a second opinion about who may see what is a second opinion that eventually
 * disagrees with the first.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BentoCell } from '@/components/dashboard/console';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { AiInsightsCard } from '@/components/dashboard/AiInsightsCard';
import { useInsightStream } from '@/lib/use-insight-stream';
import { formatRelative } from '@/lib/format';
import {
  GROUP_LABELS,
  OPERATIONS_QUERY_KEY,
  fetchOperations,
  operationsSegments,
} from '@/lib/operations';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import type { ReportingWindow } from '@/lib/dashboard-range';

/**
 * How often the queues refresh.
 *
 * A minute, and only while the tab is in front — the same cadence as the
 * navigation badges next door, deliberately, so the number on the rail and the
 * number in the ring are never more than a poll apart. Anything tighter
 * multiplies into real load on a self-hosted box for no operational gain.
 */
const REFRESH_MS = 60_000;

export function OperationsHero({
  window: reportingWindow,
  selectedGroup,
  onSelectGroup,
}: {
  /** The dashboard's reporting window. Passed to the AI for context only. */
  window: ReportingWindow;
  selectedGroup: string | null;
  onSelectGroup: (group: string | null) => void;
}): React.JSX.Element {
  const { t, language } = useI18n();

  const query = useQuery({
    queryKey: OPERATIONS_QUERY_KEY,
    queryFn: fetchOperations,
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: false,
  });

  /*
   * The insight arrives as Server-Sent Events, so the summary is on screen
   * while it is still being written. The finished object that replaces it when
   * the stream closes is the validated one — the server checks every figure the
   * model cited against the metric bundle before it sends it.
   */
  const insights = useInsightStream('/admin/dashboard/insights/stream', () => ({
    from: reportingWindow.from,
    to: reportingWindow.to,
    language,
    ...(selectedGroup === null ? {} : { segment: `ops.${selectedGroup}` }),
  }));

  const data = query.data;

  const segments = useMemo(
    () =>
      data === undefined
        ? []
        : operationsSegments(data, (group) => translateKey(t, GROUP_LABELS[group])),
    [data, t],
  );

  return (
    <>
      <BentoCell span={4} spanMd={3}>
        <ModernDonutCard
          title={t('operations.platformOperations')}
          description={t('operations.platformOperationsDescription')}
          total={data?.total ?? 0}
          centerLabel={t('operations.centerLabel')}
          unitLabel={t('operations.unitLabel')}
          segments={segments}
          selectedSegment={selectedGroup}
          onSegmentSelect={onSelectGroup}
          loading={query.isLoading}
          error={query.isError ? query.error : undefined}
          onRetry={() => {
            void query.refetch();
          }}
          lastUpdatedAt={data?.generatedAt ?? null}
          dateRangeLabel={
            data === undefined
              ? undefined
              : t('operations.countedAt', { when: formatRelative(data.generatedAt) })
          }
          labels={{
            status: t('operations.table.queue'),
            value: t('operations.table.waiting'),
            share: t('operations.table.share'),
            viewAsTable: t('operations.viewAsTable'),
            clearFilter: t('operations.clearFilter'),
            filteredBy: t('operations.filteredBy'),
            empty: t('operations.allClear'),
            error: t('common.somethingWentWrong'),
            retry: t('common.retry'),
            loading: t('common.loading'),
            remainder: t('operations.remainder'),
            clampNote: t('operations.clampNote'),
          }}
        />
      </BentoCell>

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
            t('operations.ai.q1'),
            t('operations.ai.q2'),
            t('operations.ai.q3'),
            t('operations.ai.q4'),
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
    </>
  );
}

/*
 * The queue list that used to hang under the ring is gone.
 *
 * It repeated, as a column of rows with counts and chevrons, exactly what the
 * ring above it had just drawn — and every row went to a screen that is in the
 * navigation rail anyway. This dashboard is the chart and the insights panel
 * now: the shape carries the information, and the queue it names is one click
 * away wherever you were already going to click.
 *
 * `queuesInGroup` and `QUEUE_LABELS` in lib/operations.ts are untouched, and
 * the server still returns every queue. Its markup is in this file's history.
 */
