/**
 * Dashboard.
 *
 * The morning's work, and nothing else: one ring of everything waiting across
 * the queues this member of staff can act on, and the insights panel beside
 * it.
 *
 * ---
 *
 * WHAT USED TO BE HERE
 *
 * Five headline figures with sparklines and period-over-period deltas, the
 * order-status proportion bar and its table, the payments summary, the
 * low-stock queue and the recurring-order panels. All removed deliberately.
 *
 * None of the DATA is gone. `GET /admin/dashboard` still returns every one of
 * those aggregates, and each of them has a screen that owns it — Reports,
 * Orders, Payments, Inventory, Recurring — all unchanged and all still in the
 * navigation. What went is a second, thinner copy of them on a screen whose
 * job turned out to be a different question.
 *
 * ---
 *
 * WHY THERE IS NO REQUEST IN THIS FILE
 *
 * There is nothing left for it to fetch. `OperationsHero` owns the one query
 * this page makes, on its own one-minute cadence, and the refresh control here
 * invalidates that query rather than holding a second copy of it. A page-level
 * fetch whose result nothing rendered would be a request paid for on every
 * visit and read by nobody.
 *
 * The reporting window stays, and is still in the URL, because the insights
 * panel is measured over it — see `useDashboardParams`.
 */
import { useIsFetching, useQueryClient } from '@tanstack/react-query';
import { BentoGrid, ConsoleGround, ConsoleHeader } from '@/components/dashboard/console';
import { RangeTabs, RefreshButton } from '@/components/dashboard/controls';
import { useDashboardParams } from '@/lib/use-dashboard-params';
import { OPERATIONS_QUERY_KEY } from '@/lib/operations';
import { OperationsHero } from './dashboard/OperationsHero';
import { useI18n } from '@/i18n/i18n-context';

export function DashboardPage(): React.JSX.Element {
  const { t } = useI18n();
  const params = useDashboardParams();

  const queryClient = useQueryClient();

  /*
   * Whether the ring is refetching, asked of the cache rather than held here.
   *
   * `useIsFetching` counts in-flight queries matching the key, so the refresh
   * control reports the state of the query it actually triggers — including a
   * refetch the hero started on its own poll, which a local boolean here would
   * have missed.
   */
  const fetching = useIsFetching({ queryKey: OPERATIONS_QUERY_KEY }) > 0;

  return (
    <ConsoleGround>
      <ConsoleHeader title={t('dashboard.dashboard')} subtitle={t('operations.subtitle')}>
        <RangeTabs
          options={[
            { key: 'today', label: t('buyerDashboard.range.today') },
            { key: '7d', label: t('dashboard.last7Days') },
            { key: '30d', label: t('dashboard.last30Days') },
            { key: 'custom', label: t('buyerDashboard.range.custom') },
          ]}
          value={params.range}
          onChange={params.setRange}
          customFrom={params.customFrom}
          customTo={params.customTo}
          onCustomChange={params.setCustomRange}
          labels={{
            legend: t('dashboard.period'),
            from: t('buyerDashboard.range.from'),
            to: t('buyerDashboard.range.to'),
            // The tabs apply on selection; nothing renders this.
            apply: '',
          }}
        />

        {/* An operations screen that can only be refreshed by reloading the
            browser gets left open and stale. */}
        <RefreshButton
          busy={fetching}
          onClick={() => {
            void queryClient.invalidateQueries({ queryKey: OPERATIONS_QUERY_KEY });
          }}
          labels={{
            refresh: t('dashboard.refresh'),
            refreshing: t('dashboard.refreshing'),
          }}
        />
      </ConsoleHeader>

      <BentoGrid>
        <OperationsHero
          window={params.window}
          selectedGroup={params.segment}
          onSelectGroup={params.setSegment}
        />
      </BentoGrid>
    </ConsoleGround>
  );
}
