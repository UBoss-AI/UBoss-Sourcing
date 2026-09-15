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
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, LoadingState, Metric, PageHeader } from '@/components/ui';
import { ProportionBar } from '@/components/charts';
import type { ProportionSegment } from '@/components/charts';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatRelative } from '@/lib/format';
import { dashboardKey, fetchDashboard } from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { useSession } from '@/auth/session-context';
import {
  formatDuration,
  groupStatusCounts,
  severityTone,
  statusTone,
} from '@/lib/shipment-display';
import type { Dashboard } from '@/lib/types';

export function DashboardPage(): React.JSX.Element {
  const { t } = useI18n();
  const { canAny } = useSession();

  const query = useQuery({
    queryKey: dashboardKey({}),
    queryFn: () => fetchDashboard({}),
    // A dispatcher leaves this open. Two minutes is often enough to notice a
    // new assignment and rare enough not to be a load problem on a self-hosted
    // box; the bell is what makes anything urgent arrive sooner.
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });

  if (query.isLoading) return <LoadingState />;

  if (query.isError || query.data === undefined) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const data = query.data;

  return (
    <>
      <PageHeader title={t('dashboard.heading')} />

      <TodayCounts counts={data.counts} />

      <StatusDistribution data={data} />

      <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          label={t('dashboard.onTime')}
          value={
            data.metrics.onTimeDeliveryPercentage === null
              ? '—'
              : `${String(data.metrics.onTimeDeliveryPercentage)}%`
          }
          sub={
            data.metrics.onTimeDeliveryPercentage === null ? t('dashboard.noHistoryYet') : undefined
          }
        />
        <Metric
          label={t('dashboard.averageTransit')}
          value={
            data.metrics.averageTransitHours === null
              ? '—'
              : formatDuration(data.metrics.averageTransitHours * 60)
          }
          sub={data.metrics.averageTransitHours === null ? t('dashboard.noHistoryYet') : undefined}
        />
        <Metric
          label={t('dashboard.firstAttempt')}
          value={
            data.metrics.firstAttemptSuccessPercentage === null
              ? '—'
              : `${String(data.metrics.firstAttemptSuccessPercentage)}%`
          }
          sub={
            data.metrics.firstAttemptSuccessPercentage === null
              ? t('dashboard.noHistoryYet')
              : undefined
          }
        />
        <Metric
          label={t('dashboard.podPending')}
          value={String(data.metrics.proofOfDeliveryPending)}
        />
      </section>

      {/*
        `items-start`, so each card is the height of what it holds. Stretched,
        the short one beside the activity feed became a tall empty box with a
        single line of text adrift in the middle of it.
      */}
      <div className="mt-6 grid items-start gap-4 lg:grid-cols-2">
        <UrgentExceptions data={data} />
        <DueToday data={data} />
        <UpcomingPickups data={data} />
        <RecentActivity data={data} />
      </div>

      {canAny(Permission.INTEGRATION_READ, Permission.ORGANISATION_READ) ? (
        <div className="mt-4">
          <IntegrationHealth data={data} />
        </div>
      ) : null}
    </>
  );
}

/*
 * Which step of the ordinal ramp each group takes.
 *
 * Three of the four are a sequence - waiting, then moving, then finished - so
 * they take three ascending steps and the bar reads left to right as progress.
 * "Problem" is not a stage in that sequence: it sits outside the ramp in the
 * danger colour, where it is meant to be conspicuous.
 */
const GROUP_STEP: Record<string, ProportionSegment['step']> = {
  'shipments.group.waiting': 2,
  'shipments.group.moving': 4,
  'shipments.group.finished': 6,
  'shipments.group.problem': 'danger',
};

/**
 * Where everything is, as one bar.
 *
 * `statusDistribution` has been on the wire since this portal was built and
 * was never drawn - twenty-seven statuses with a count each, thrown away on
 * arrival. Twenty-seven segments is not a chart, so it is folded onto the same
 * four groups the shipments filter already offers, which a test holds to
 * covering every status exactly once. A carrier asking "where is my work"
 * means those four.
 */
function StatusDistribution({ data }: { data: Dashboard }): React.JSX.Element | null {
  const { t } = useI18n();

  const segments: ProportionSegment[] = groupStatusCounts(data.statusDistribution).map((group) => ({
    id: group.labelKey,
    label: t(group.labelKey),
    value: group.count,
    step: GROUP_STEP[group.labelKey] ?? 'neutral',
  }));

  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  // Nothing assigned to this carrier yet. An empty track with a legend of
  // four zeroes says less than the tiles above already do.
  if (total === 0) return null;

  return (
    <Card title={t('dashboard.statusDistribution')} className="mt-6" bodyClassName="px-5 py-4">
      <ProportionBar
        segments={segments}
        total={total}
        formatShare={(value, whole) => `${String(Math.round((value / whole) * 100))}%`}
      />
    </Card>
  );
}

/*
 * How many columns a band of tiles gets on a wide screen.
 *
 * One column per tile, so every band ends on the same right edge as the band
 * above it. A shared six-column lattice looks tidier in the abstract and is
 * worse on the screen: the bands hold three, five and six tiles, so two of
 * them stopped mid-row and the page had three different ragged edges down its
 * right-hand side, which reads as something having failed to load.
 *
 * Every class is written out because Tailwind reads these files as text - a
 * computed `lg:grid-cols-${n}` compiles to no CSS at all.
 */
const BAND_COLUMNS: Record<number, string> = {
  1: 'lg:grid-cols-1',
  2: 'lg:grid-cols-2',
  3: 'lg:grid-cols-3',
  4: 'lg:grid-cols-4',
  5: 'lg:grid-cols-5',
  6: 'lg:grid-cols-6',
};

/**
 * The fourteen counters.
 *
 * Grouped, and the grouping is the information: what needs an answer, what is
 * moving, what has gone wrong. A flat grid of fourteen equal tiles is a wall
 * of numbers that reads as one texture - nobody finds "SLA breached: 2" in it.
 */
function TodayCounts({ counts }: { counts: Dashboard['counts'] }): React.JSX.Element {
  const { t } = useI18n();

  const groups: {
    label: string;
    tiles: { label: string; value: number; to?: string; tone?: 'warning' | 'danger' | undefined }[];
  }[] = [
    {
      label: t('shipments.group.waiting'),
      tiles: [
        { label: t('dashboard.assignedToday'), value: counts.assignedToday, to: '/shipments' },
        {
          label: t('dashboard.acceptancePending'),
          value: counts.acceptancePending,
          to: '/shipments?status=ACCEPTANCE_PENDING',
          tone: counts.acceptancePending > 0 ? 'warning' : undefined,
        },
        { label: t('dashboard.pickupPending'), value: counts.pickupPending, to: '/pickups' },
      ],
    },
    {
      label: t('shipments.group.moving'),
      tiles: [
        { label: t('dashboard.pickedUp'), value: counts.pickedUp },
        { label: t('dashboard.dispatched'), value: counts.dispatched },
        { label: t('dashboard.inTransit'), value: counts.inTransit },
        { label: t('dashboard.outForDelivery'), value: counts.outForDelivery },
        { label: t('dashboard.deliveredToday'), value: counts.deliveredToday },
      ],
    },
    {
      label: t('shipments.group.problem'),
      tiles: [
        {
          label: t('dashboard.delayed'),
          value: counts.delayed,
          to: '/shipments?status=DELAYED',
          tone: counts.delayed > 0 ? 'warning' : undefined,
        },
        {
          label: t('dashboard.exceptions'),
          value: counts.exceptions,
          to: '/exceptions',
          tone: counts.exceptions > 0 ? 'warning' : undefined,
        },
        {
          label: t('dashboard.failedDeliveries'),
          value: counts.failedDeliveries,
          tone: counts.failedDeliveries > 0 ? 'danger' : undefined,
        },
        { label: t('dashboard.returns'), value: counts.returns },
        {
          label: t('dashboard.slaAtRisk'),
          value: counts.slaAtRisk,
          to: '/shipments?slaState=AT_RISK',
          tone: counts.slaAtRisk > 0 ? 'warning' : undefined,
        },
        {
          label: t('dashboard.slaBreached'),
          value: counts.slaBreached,
          to: '/shipments?slaState=BREACHED',
          tone: counts.slaBreached > 0 ? 'danger' : undefined,
        },
      ],
    },
  ];

  return (
    <div className="space-y-5">
      {groups.map((group) => (
        <section key={group.label}>
          <h2 className="mb-2 text-xxs font-semibold uppercase tracking-[0.12em] text-ink-subtle">
            {group.label}
          </h2>

          <div
            className={`grid grid-cols-2 gap-3 sm:grid-cols-3 ${BAND_COLUMNS[group.tiles.length]}`}
          >
            {group.tiles.map((tile) => {
              const body = (
                <>
                  <p
                    className={
                      tile.tone === 'danger'
                        ? 'tabular text-title text-danger'
                        : tile.tone === 'warning'
                          ? 'tabular text-title text-warning'
                          : 'tabular text-title text-ink'
                    }
                  >
                    {tile.value}
                  </p>
                  <p className="mt-1 text-xs leading-snug text-ink-muted">{tile.label}</p>
                </>
              );

              const className =
                'block rounded-lg border border-border bg-surface p-4 shadow-card transition-shadow';

              return tile.to === undefined ? (
                <div key={tile.label} className={className}>
                  {body}
                </div>
              ) : (
                <Link
                  key={tile.label}
                  to={tile.to}
                  className={`${className} hover:border-border-hover hover:shadow-md`}
                >
                  {body}
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function UrgentExceptions({ data }: { data: Dashboard }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('dashboard.urgentExceptions')}>
      {data.urgentExceptions.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">
          {t('exceptions.emptyTitle')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.urgentExceptions.map((entry) => (
            <li key={entry.id} className="px-5 py-3">
              <Link to={`/shipments/${entry.shipmentId}`} className="group block">
                <div className="flex items-center gap-2">
                  <Badge tone={severityTone(entry.severity)} dot>
                    {t(`severity.${entry.severity}` as never)}
                  </Badge>
                  <span className="truncate text-sm font-medium text-ink group-hover:text-brand">
                    {entry.shipmentReference}
                  </span>
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-ink-muted">{entry.reason}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function DueToday({ data }: { data: Dashboard }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('dashboard.deliveriesDueToday')}>
      {data.deliveriesDueToday.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">
          {t('common.nothingHereYet')}
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {data.deliveriesDueToday.map((entry) => (
            <li key={entry.shipmentId} className="px-5 py-3">
              <Link
                to={`/shipments/${entry.shipmentId}`}
                className="flex items-baseline justify-between gap-3 text-sm hover:text-brand"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium text-ink">{entry.receivingCompanyName}</span>
                  {entry.destinationCity === null ? null : (
                    <span className="text-ink-subtle">, {entry.destinationCity}</span>
                  )}
                </span>
                <span className="shrink-0 tabular text-xs text-ink-muted">
                  {formatDateTime(entry.estimatedDeliveryAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function UpcomingPickups({ data }: { data: Dashboard }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('dashboard.upcomingPickups')}>
      {data.upcomingPickups.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">{t('pickups.emptyTitle')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.upcomingPickups.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline justify-between gap-3 px-5 py-3 text-sm"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium text-ink">{entry.warehouseName ?? '—'}</span>
                {entry.shipmentReference === null ? null : (
                  <span className="text-ink-subtle"> · {entry.shipmentReference}</span>
                )}
              </span>
              <span className="shrink-0 tabular text-xs text-ink-muted">
                {formatDateTime(entry.windowStartAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecentActivity({ data }: { data: Dashboard }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('dashboard.recentActivity')}>
      {data.recentActivity.length === 0 ? (
        <p className="px-5 py-6 text-center text-sm text-ink-subtle">
          {t('common.nothingHereYet')}
        </p>
      ) : (
        /*
          A feed, so it scrolls in its own box rather than setting the height
          of the dashboard. Every entry for one busy shipment made this card
          three times the height of the other three put together.
        */
        <ul className="max-h-80 divide-y divide-border overflow-y-auto">
          {data.recentActivity.map((entry, index) => (
            <li key={`${entry.shipmentId}-${String(index)}`} className="px-5 py-3">
              <Link to={`/shipments/${entry.shipmentId}`} className="group block">
                <div className="flex items-center justify-between gap-3">
                  <Badge tone={statusTone(entry.status)} dot>
                    {t(`status.${entry.status}` as never)}
                  </Badge>
                  <span className="shrink-0 text-xxs text-ink-subtle">
                    {formatRelative(entry.occurredAt)}
                  </span>
                </div>
                <p className="mt-1 truncate text-sm text-ink group-hover:text-brand">
                  {entry.shipmentReference} · {entry.receivingCompanyName}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/**
 * Is the carrier feed working?
 *
 * Every field is null for a carrier that works entirely inside the portal,
 * which is the ordinary case and NOT an error state. It says so in words
 * rather than showing a grey light that reads as broken.
 */
function IntegrationHealth({ data }: { data: Dashboard }): React.JSX.Element {
  const { t } = useI18n();
  const integration = data.integration;

  if (integration.provider === null || integration.provider === 'MANUAL') {
    return (
      <Card title={t('dashboard.integrationHealth')} bodyClassName="px-5 py-4">
        <p className="text-sm text-ink-muted">{t('dashboard.noCarrierApi')}</p>
      </Card>
    );
  }

  const unhealthy = integration.consecutiveFailures > 0 || integration.deadLetteredEvents > 0;

  return (
    <Card title={t('dashboard.integrationHealth')} bodyClassName="px-5 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone={unhealthy ? 'warning' : 'success'} dot>
          {integration.provider} · {integration.state ?? '—'}
        </Badge>

        <p className="text-sm text-ink-muted">
          {integration.lastTrackingSyncAt === null
            ? t('dashboard.neverSynced')
            : `${t('dashboard.lastSync')}: ${formatRelative(integration.lastTrackingSyncAt)}`}
        </p>
      </div>

      {integration.deadLetteredEvents > 0 ? (
        <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
          {String(integration.deadLetteredEvents)} · {t('exceptionType.UNMAPPED_EXTERNAL_EVENT')}
        </p>
      ) : null}
    </Card>
  );
}
