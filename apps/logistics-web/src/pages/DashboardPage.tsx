/**
 * What a dispatcher opens the portal for.
 *
 * EVERY NUMBER HERE IS AGGREGATED ON THE SERVER. Nothing on this screen counts
 * a list it was sent, because a dashboard that computes its own totals is a
 * dashboard that eventually disagrees with the list it links to - and the
 * disagreement is always discovered by a customer.
 *
 * One request, not fourteen. A screen that fires one request per card is a
 * screen whose cards populate at fourteen different moments, and on a depot's
 * connection somebody reads the third number before the first has arrived.
 *
 * One thing on this screen does add up: `StatusDistribution` sums the
 * server's per-status counts into the four filter groups, because the server
 * sends the twenty-seven statuses and not the groups. That is arithmetic on
 * aggregates it was handed, which is a different act from counting a list -
 * the rule above is about never deriving a total from a *page* of rows, where
 * the page is a window onto data the screen cannot see all of.
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, Select } from '@/components/ui';
import { BentoCell, BentoGrid, ConsoleGround, ConsoleHeader } from '@/components/dashboard/console';
import { RangeTabs, RefreshButton } from '@/components/dashboard/controls';
import { ModernDonutCard } from '@/components/dashboard/ModernDonutCard';
import { AiInsightsCard } from '@/components/dashboard/AiInsightsCard';
import { useDashboardParams } from '@/lib/use-dashboard-params';
import { segmentStatuses, shipmentSegments } from '@/lib/shipment-donut';
import type { ShipmentSegmentKey } from '@/lib/shipment-donut';
import { useInsightStream } from '@/lib/use-insight-stream';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatRelative } from '@/lib/format';
import { dashboardKey, driversKey, fetchDashboard, fetchDrivers } from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { useSession } from '@/auth/session-context';

/** The eight ring groups, and the key each one's label lives under. */
const SEGMENT_LABELS: Record<ShipmentSegmentKey, TranslationKey> = {
  awaitingPickup: 'carrierDashboard.segment.awaitingPickup',
  assigned: 'carrierDashboard.segment.assigned',
  pickedUp: 'carrierDashboard.segment.pickedUp',
  inTransit: 'carrierDashboard.segment.inTransit',
  outForDelivery: 'carrierDashboard.segment.outForDelivery',
  delivered: 'carrierDashboard.segment.delivered',
  exception: 'carrierDashboard.segment.exception',
  returning: 'carrierDashboard.segment.returning',
};

export function DashboardPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { canAny } = useSession();
  const params = useDashboardParams();

  /*
   * One driver, of this carrier's own.
   *
   * Its own search parameter rather than component state, like the window and
   * the selected slice, so "how is Marek doing today" is a link a dispatcher
   * can send. It narrows EVERY figure on the screen and not just the list -
   * see the filter on `readDashboard`, where the same clause the shipment
   * list uses is ANDed into the scope every count shares.
   */
  const driverId = params.driverId;

  const filters = useMemo(
    () => ({
      from: params.window.from,
      to: params.window.to,
      ...(driverId === null ? {} : { driverProfileId: driverId }),
    }),
    [params.window.from, params.window.to, driverId],
  );

  const query = useQuery({
    queryKey: dashboardKey(filters),
    queryFn: () => fetchDashboard(filters),
    // A dispatcher leaves this open. Two minutes is often enough to notice a
    // new assignment and rare enough not to be a load problem on a self-hosted
    // box; the bell is what makes anything urgent arrive sooner.
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });

  /*
   * The driver list, for the filter.
   *
   * Its own query and its own permission: a dispatcher who may read
   * consignments but not the fleet register gets the dashboard with no driver
   * picker rather than an error. `enabled` keeps the request from being made
   * at all in that case.
   */
  const drivers = useQuery({
    queryKey: driversKey,
    queryFn: fetchDrivers,
    enabled: canAny(Permission.DRIVER_READ),
    retry: 1,
  });

  /*
   * The insight arrives as Server-Sent Events, so the summary is on screen
   * while it is still being written. The findings underneath it appear only
   * once the stream closes — that is the server's doing, and it is the reason
   * a citation can be trusted: it has been checked against the metric bundle
   * before it is sent.
   */
  const insights = useInsightStream('/logistics/dashboard/insights/stream', () => ({
    from: params.window.from,
    to: params.window.to,
    language,
    ...(params.segment === null ? {} : { segment: params.segment }),
  }));

  const data = query.data;

  const segments = useMemo(
    () =>
      data === undefined
        ? []
        : shipmentSegments(data.statusDistribution, (key) => t(SEGMENT_LABELS[key])),
    [data, t],
  );

  /*
   * The ring's denominator.
   *
   * Summed from the server's own per-status counts rather than taken from a
   * separate total, because there is no separate total on the wire: the
   * distribution IS every consignment assigned to this carrier. That is
   * arithmetic on aggregates it was handed, which is the one exception this
   * screen has always made - see the header.
   */
  const totalShipments = useMemo(
    () => (data?.statusDistribution ?? []).reduce((sum, row) => sum + row.count, 0),
    [data],
  );

  // A hard failure of the one request behind the page.
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
      <ConsoleHeader title={t('dashboard.heading')} subtitle={t('carrierDashboard.subtitle')}>
        <RangeTabs
          options={[
            { key: 'today', label: t('carrierDashboard.range.today') },
            { key: '7d', label: t('carrierDashboard.range.last7') },
            { key: '30d', label: t('carrierDashboard.range.last30') },
            { key: 'custom', label: t('carrierDashboard.range.custom') },
          ]}
          value={params.range}
          onChange={params.setRange}
          customFrom={params.customFrom}
          customTo={params.customTo}
          onCustomChange={params.setCustomRange}
          labels={{
            legend: t('carrierDashboard.range.legend'),
            from: t('carrierDashboard.range.from'),
            to: t('carrierDashboard.range.to'),
            // The tabs apply on selection; nothing renders this.
            apply: '',
          }}
        />

        {/*
          Only where the account may read the fleet. A picker listing nobody
          is worse than no picker: it reads as a failure to load.
        */}
        {canAny(Permission.DRIVER_READ) && (drivers.data?.drivers.length ?? 0) > 0 ? (
          <label className="flex items-center gap-2">
            <span className="sr-only">{t('carrierDashboard.driverFilter')}</span>
            <Select
              value={driverId ?? ''}
              onChange={(event) => {
                params.setDriver(event.target.value === '' ? null : event.target.value);
              }}
              className="w-48"
            >
              <option value="">{t('carrierDashboard.allDrivers')}</option>
              {(drivers.data?.drivers ?? []).map((driver) => (
                <option key={driver.id} value={driver.id}>
                  {driver.fullName}
                </option>
              ))}
            </Select>
          </label>
        ) : null}

        <RefreshButton
          busy={query.isFetching}
          onClick={() => {
            void query.refetch();
          }}
          labels={{
            refresh: t('carrierDashboard.refresh'),
            refreshing: t('carrierDashboard.refreshing'),
          }}
        />
      </ConsoleHeader>

      <BentoGrid className="mb-6">
        <BentoCell span={4} spanMd={3}>
          <ModernDonutCard
            title={t('carrierDashboard.assignedShipments')}
            description={t('carrierDashboard.assignedShipmentsDescription')}
            total={totalShipments}
            centerLabel={t('carrierDashboard.centerLabel')}
            unitLabel={t('carrierDashboard.unitLabel')}
            segments={segments}
            selectedSegment={params.segment}
            onSegmentSelect={params.setSegment}
            loading={query.isLoading}
            lastUpdatedAt={null}
            labels={{
              status: t('carrierDashboard.table.stage'),
              value: t('carrierDashboard.table.consignments'),
              share: t('carrierDashboard.table.share'),
              viewAsTable: t('carrierDashboard.viewAsTable'),
              clearFilter: t('carrierDashboard.clearFilter'),
              filteredBy: t('carrierDashboard.filteredBy'),
              empty: t('carrierDashboard.nothingAssigned'),
              error: t('common.theRequestFailed'),
              retry: t('common.retry'),
              loading: t('common.loading'),
              remainder: t('carrierDashboard.remainder'),
              clampNote: t('carrierDashboard.clampNote'),
            }}
            footer={
              params.segment === null ? undefined : (
                <Link
                  to={`/shipments?status=${segmentStatuses(params.segment).join(',')}${
                    driverId === null ? '' : `&driverProfileId=${driverId}`
                  }`}
                  className="inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline"
                >
                  {t('carrierDashboard.openInShipments')}
                </Link>
              )
            }
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
              t('carrierDashboard.ai.q1'),
              t('carrierDashboard.ai.q2'),
              t('carrierDashboard.ai.q3'),
              t('carrierDashboard.ai.q4'),
            ]}
            placeholders={[
              t('carrierDashboard.ai.q1'),
              t('carrierDashboard.ai.q2'),
              t('carrierDashboard.ai.q3'),
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
      </BentoGrid>

    </ConsoleGround>
  );
}

/*
 * The four-segment `ProportionBar` that used to sit here is gone, and what
 * replaced it is the ring at the top of the page.
 *
 * It folded the twenty-seven statuses into the same four groups the shipments
 * FILTER offers — waiting, moving, problem, finished — which is right for a
 * filter and too coarse for the question a dispatcher opens this screen with.
 * "Moving" held both a consignment sitting in an origin hub and one on a van
 * two streets away, and those are different mornings.
 *
 * The eight-group mapping is in `lib/shipment-donut.ts`, beside the four-group
 * one it deliberately does not replace, with a test holding both to covering
 * every status the backend can send.
 */

/*
 * The fourteen counters, the four service metrics, the exception feed, the
 * pickups, the deliveries due today, the activity list and the integration
 * health panel all used to live below the ring.
 *
 * They were removed deliberately: this screen is the ring and the insights
 * panel now, and nothing else. Every figure they showed is still on the API
 * — `readDashboard` returns all of it — and every one of them is still
 * reachable on the screen that owns it: Shipments, Collections, Dispatch and
 * Problems. Their markup is in this file's history if it is ever wanted back.
 */
