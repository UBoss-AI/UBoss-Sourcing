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
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, LoadingState, Metric, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatRelative } from '@/lib/format';
import { dashboardKey, fetchDashboard } from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { useSession } from '@/auth/session-context';
import { formatDuration, severityTone, statusTone } from '@/lib/shipment-display';
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

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
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

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
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
        <p className="py-6 text-center text-sm text-ink-subtle">{t('exceptions.emptyTitle')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.urgentExceptions.map((entry) => (
            <li key={entry.id} className="py-3 first:pt-0 last:pb-0">
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
        <p className="py-6 text-center text-sm text-ink-subtle">{t('common.nothingHereYet')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.deliveriesDueToday.map((entry) => (
            <li key={entry.shipmentId} className="py-3 first:pt-0 last:pb-0">
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
        <p className="py-6 text-center text-sm text-ink-subtle">{t('pickups.emptyTitle')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.upcomingPickups.map((entry) => (
            <li
              key={entry.id}
              className="flex items-baseline justify-between gap-3 py-3 text-sm first:pt-0 last:pb-0"
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
        <p className="py-6 text-center text-sm text-ink-subtle">{t('common.nothingHereYet')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {data.recentActivity.map((entry, index) => (
            <li key={`${entry.shipmentId}-${String(index)}`} className="py-3 first:pt-0 last:pb-0">
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
      <Card title={t('dashboard.integrationHealth')}>
        <p className="text-sm text-ink-muted">{t('dashboard.noCarrierApi')}</p>
      </Card>
    );
  }

  const unhealthy = integration.consecutiveFailures > 0 || integration.deadLetteredEvents > 0;

  return (
    <Card title={t('dashboard.integrationHealth')}>
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
