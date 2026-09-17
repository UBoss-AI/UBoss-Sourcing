/**
 * The top of the admin dashboard: what is waiting, and what to do about it.
 *
 * Its own component rather than three hundred more lines inside
 * `DashboardPage.tsx`, because it answers a different question from everything
 * below it. The panels underneath are the month's SALES; this is the morning's
 * WORK, and the two want different data, a different refresh cadence and a
 * different permission model.
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
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BentoCell } from '@/components/dashboard/console';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { AiInsightsCard } from '@/components/dashboard/AiInsightsCard';
import { Badge } from '@/components/ui';
import { ChevronRightIcon } from '@/components/icons';
import { useInsightStream } from '@/lib/use-insight-stream';
import { formatRelative } from '@/lib/format';
import {
  GROUP_LABELS,
  OPERATIONS_QUERY_KEY,
  QUEUE_LABELS,
  fetchOperations,
  operationsSegments,
  queuesInGroup,
  type OperationsGroupName,
  type OperationsOverview,
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
   * while it is still being written. The findings underneath it appear only
   * once the stream closes — that is the server's doing, and it is the reason
   * a citation can be trusted: it has been checked against the metric bundle
   * before it is sent.
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
          footer={<QueueList data={data} group={selectedGroup} />}
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
          suggestions={[
            t('operations.ai.q1'),
            t('operations.ai.q2'),
            t('operations.ai.q3'),
            t('operations.ai.q4'),
          ]}
          placeholders={[t('operations.ai.q1'), t('operations.ai.q2'), t('operations.ai.q3')]}
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
    </>
  );
}

/**
 * The queues behind the ring, filtered by the selected group.
 *
 * Every row links to the screen the work is decided on, and the link comes
 * from the SERVER — `queue.href` — rather than from a table in this file. That
 * is what makes "clicking a segment opens the right queue" true by
 * construction: the thing that counted the rows is the thing that says where
 * they live, so a queue cannot be counted from one place and linked to
 * another.
 *
 * Domains are never merged. Selecting "payments" shows payment queues; it does
 * not roll a failed schedule charge in with a rejected webhook and call the
 * total "money problems", because they are fixed on different screens by
 * different people.
 */
function QueueList({
  data,
  group,
}: {
  data: OperationsOverview | undefined;
  group: string | null;
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (data === undefined) return null;

  const rows = queuesInGroup(data, group);
  if (rows.length === 0) return null;

  return (
    <div className="border-t border-console-border/70 pt-3">
      <h3 className="mb-2 text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
        {group === null
          ? t('operations.everyQueue')
          : translateKey(t, GROUP_LABELS[group as OperationsGroupName])}
      </h3>

      <ul className="space-y-0.5">
        {rows.map((queue) => {
          const label = QUEUE_LABELS[queue.key];

          return (
            <li key={queue.key}>
              <Link
                to={queue.href}
                className="group flex min-h-[2.25rem] items-center justify-between gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-surface-hover/60"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {/*
                    The count first, because that is what is being scanned. A
                    queue holding nothing is muted rather than hidden — "no
                    data-subject requests are waiting" is worth seeing on the
                    screen that exists to say what is waiting.
                  */}
                  <span
                    className={
                      queue.count === 0
                        ? 'tabular w-8 shrink-0 text-right text-sm text-ink-subtle'
                        : queue.severity === 'urgent'
                          ? 'tabular w-8 shrink-0 text-right text-sm font-semibold text-danger'
                          : queue.severity === 'attention'
                            ? 'tabular w-8 shrink-0 text-right text-sm font-semibold text-warning'
                            : 'tabular w-8 shrink-0 text-right text-sm font-semibold text-ink'
                    }
                  >
                    {queue.count}
                  </span>
                  <span className="min-w-0 truncate text-xs text-ink-muted group-hover:text-ink">
                    {label === undefined ? queue.key : translateKey(t, label)}
                  </span>
                </span>

                <span className="flex shrink-0 items-center gap-1.5">
                  {/*
                    A word as well as a colour, and only where it is non-zero.
                    An "urgent" chip on a queue holding nothing teaches people
                    to ignore the word.
                  */}
                  {queue.count > 0 && queue.severity === 'urgent' ? (
                    <Badge tone="danger">{t('aiInsights.severity.urgent')}</Badge>
                  ) : null}
                  <ChevronRightIcon className="h-3.5 w-3.5 text-ink-subtle" />
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
