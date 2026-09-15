/**
 * A driver's day, on a phone.
 *
 * Designed for one hand, in a vehicle, in the rain. Large touch targets, one
 * stop per card, and the two things a person actually does at a door - navigate
 * and call - as the first two buttons.
 *
 * THIS IS THE ONLY SCREEN A DRIVER HAS
 *
 * A driver holds `logistics.driver.task.read` and nothing that can list
 * shipments, so their sidebar has one entry and this is it. The list comes
 * from their own driver profile, never from the carrier's shipment table -
 * which is what makes "a driver cannot see another driver's stops" a property
 * of the query rather than a filter somebody remembered to add.
 *
 * THE TELEPHONE NUMBER IS REAL HERE, AND NOWHERE ELSE
 *
 * The server unmasks it for the assigned driver on an active delivery and for
 * nobody else - see `revealPolicyFor`. The alternative is a courier standing
 * outside a locked loading bay with no way to ring the bell.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import {
  driverTasksKey,
  endTrip,
  fetchDriverTasks,
  setLocationConsent,
  startTrip,
} from '@/lib/logistics';
import { statusTone } from '@/lib/shipment-display';
import type { DriverTask } from '@/lib/types';

export function DriverTasksPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  /*
   * The trip, held in component state only.
   *
   * The device token is returned once when a shift starts and is never stored
   * anywhere that outlives the tab - not localStorage, not a cookie. It
   * authorises position ingestion for one trip, and a token that survived a
   * closed browser would be a token that survived the shift it belongs to.
   */
  const [trip, setTrip] = useState<{ tripId: string; deviceToken: string } | null>(null);

  const tasks = useQuery({
    queryKey: driverTasksKey,
    queryFn: fetchDriverTasks,
    // A round changes while somebody is driving it.
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
  });

  const consent = useMutation({
    mutationFn: (granted: boolean) => setLocationConsent(granted),
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const start = useMutation({
    mutationFn: () => startTrip({}),
    onSuccess: (result) => {
      setTrip({ tripId: result.tripId, deviceToken: result.deviceToken });
      toast.success(t('tasks.startTrip'));
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const finish = useMutation({
    mutationFn: (tripId: string) => endTrip(tripId),
    onSuccess: () => {
      setTrip(null);
      void queryClient.invalidateQueries({ queryKey: driverTasksKey });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <>
      <PageHeader title={t('tasks.heading')} description={t('tasks.today')} />

      <Card className="mb-4">
        <p className="text-sm text-ink-muted">{t('tasks.shareLocationBody')}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {trip === null ? (
            <Button
              disabled={start.isPending}
              onClick={() => {
                /*
                 * Consent first, then the shift.
                 *
                 * The server refuses to start a trip without it, so asking in
                 * this order means one press does the right thing rather than
                 * producing a refusal the driver has to read and act on.
                 */
                consent.mutate(true, {
                  onSuccess: () => {
                    start.mutate();
                  },
                });
              }}
            >
              {t('tasks.startTrip')}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                disabled={finish.isPending}
                onClick={() => {
                  finish.mutate(trip.tripId);
                }}
              >
                {t('tasks.endTrip')}
              </Button>

              <Button
                variant="ghost"
                onClick={() => {
                  // Withdrawing ends the live trip on the server too: consent
                  // that takes effect at the end of the shift has not been
                  // withdrawn.
                  consent.mutate(false, {
                    onSuccess: () => {
                      setTrip(null);
                    },
                  });
                }}
              >
                {t('tasks.shareLocation')}
              </Button>
            </>
          )}
        </div>
      </Card>

      {tasks.isLoading ? (
        <LoadingState />
      ) : tasks.isError ? (
        <ErrorState
          error={tasks.error}
          onRetry={() => {
            void tasks.refetch();
          }}
        />
      ) : (tasks.data?.tasks.length ?? 0) === 0 ? (
        <Card>
          <EmptyState title={t('tasks.emptyTitle')} description={t('tasks.emptyBody')} />
        </Card>
      ) : (
        <ul className="space-y-3">
          {tasks.data?.tasks.map((task) => (
            <li key={task.assignmentId}>
              <TaskCard task={task} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function TaskCard({ task }: { task: DriverTask }): React.JSX.Element {
  const { t } = useI18n();

  /*
   * A `geo:` link, which every phone hands to its own maps application.
   *
   * Deliberately not a Google Maps URL: the deployment's driver may be using
   * anything, and sending a courier's destination to a third party on every
   * tap is not a decision this software gets to make on the operator's behalf.
   * Where no coordinates were recorded it falls back to a plain address query,
   * which every maps application also understands.
   */
  const destination =
    task.latitude !== null && task.longitude !== null
      ? `geo:${task.latitude},${task.longitude}`
      : `geo:0,0?q=${encodeURIComponent(
          [...task.addressLines, task.city, task.postalCode, task.countryCode]
            .filter((part) => part !== null && part !== '')
            .join(', '),
        )}`;

  return (
    <article className="rounded-xl border border-border bg-surface p-4 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-xs">
            <Badge tone={task.leg === 'PICKUP' ? 'accent' : 'operational'}>
              {task.leg === 'PICKUP' ? t('tasks.pickup') : t('tasks.delivery')}
            </Badge>
            <Badge tone={statusTone(task.status)} dot>
              {t(`status.${task.status}` as never)}
            </Badge>
            {task.requiresColdChain ? <Badge tone="brand">{t('shipment.coldChain')}</Badge> : null}
            {task.isDangerousGoods ? (
              <Badge tone="danger">{t('shipment.dangerousGoods')}</Badge>
            ) : null}
          </p>

          <h2 className="mt-2 truncate text-base font-semibold text-ink">{task.companyName}</h2>

          <p className="mt-1 text-sm leading-relaxed text-ink-muted">
            {task.addressLines.map((line) => (
              <span key={line} className="block">
                {line}
              </span>
            ))}
            <span className="block">
              {[task.city, task.postalCode, task.countryCode]
                .filter((part) => part !== null && part !== '')
                .join(' ')}
            </span>
          </p>

          {task.contactName === null ? null : (
            <p className="mt-2 text-sm text-ink">{task.contactName}</p>
          )}

          {task.dueAt === null ? null : (
            <p className="mt-1 text-xs text-ink-subtle">{formatDateTime(task.dueAt)}</p>
          )}
        </div>

        <span className="shrink-0 text-right">
          <span className="block tabular text-title text-ink">{task.packageCount}</span>
          <span className="block text-xxs text-ink-subtle">{t('shipments.column.packages')}</span>
        </span>
      </div>

      {task.handlingNotes === null ? null : (
        <Callout tone="warning" className="mt-3">
          {task.handlingNotes}
        </Callout>
      )}

      {/*
        The two things a driver does at a door, as large targets. 44px minimum,
        which is the smallest a thumb reliably hits in a moving vehicle.
      */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <a
          href={destination}
          className="flex min-h-11 items-center justify-center rounded-lg bg-brand px-4 text-sm font-medium text-white"
        >
          {t('tasks.navigate')}
        </a>

        {task.contactPhone === null ? (
          <span className="flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-sm text-ink-subtle">
            {t('common.none')}
          </span>
        ) : (
          <a
            href={`tel:${task.contactPhone}`}
            className="flex min-h-11 items-center justify-center rounded-lg border border-border-strong bg-surface px-4 text-sm font-medium text-ink"
          >
            {t('tasks.call')}
          </a>
        )}
      </div>

      <Link
        to={`/shipments/${task.shipmentId}`}
        className="mt-2 flex min-h-11 items-center justify-center rounded-lg border border-border px-4 text-sm text-ink-muted"
      >
        {task.shipmentReference}
      </Link>
    </article>
  );
}
