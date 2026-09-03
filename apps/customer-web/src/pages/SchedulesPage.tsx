/**
 * Your repeat purchases.
 *
 * The `summary` string is the server's ("Every 7 days at 06:00 (Asia/Kolkata)").
 * Rebuilding it here from frequency + interval + weekday + timezone would be a
 * second implementation of the recurrence rules, and the two would disagree the
 * first time either changed.
 *
 * The timezone stays visible next to the next run, because a schedule runs on
 * the customer's chosen wall clock — someone reading this from another country
 * needs to know which clock is meant.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { Badge, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { scheduleStatusLabel, scheduleStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Schedule } from '@/lib/types';

export function SchedulesPage(): React.JSX.Element {
  const { business, features } = useStorefront();

  useDocumentMeta({ title: 'Repeat purchases', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get<{ schedules: Schedule[] }>('/recurring-schedules'),
  });

  if (query.isPending) return <LoadingState label="Loading your repeat purchases" />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const schedules = query.data.schedules;

  if (schedules.length === 0) {
    return (
      <div className="mx-auto max-w-lg py-16 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">No repeat purchases yet</h1>
        <p className="mt-3 text-sm text-ink-muted">
          {features.recurringOrders
            ? 'Set one up and we will place the order for you on a schedule you choose. Look for the “Repeat purchase” label on a product.'
            : 'Repeat purchases are switched off at the moment.'}
        </p>
        {features.recurringOrders && (
          <Link
            to="/products"
            className="mt-6 inline-flex h-12 items-center rounded-md bg-action px-6 text-base font-medium text-white hover:bg-action-hover"
          >
            Browse products
          </Link>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">Repeat purchases</h1>
        {features.recurringOrders && (
          <Link
            to="/schedules/new"
            className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
          >
            Set up a new one
          </Link>
        )}
      </div>

      <ul className="space-y-3">
        {schedules.map((schedule) => (
          <li key={schedule.id}>
            <Link
              to={`/account/schedules/${schedule.id}`}
              className="block rounded-lg border border-border bg-surface p-4 transition-shadow hover:shadow-lift"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{schedule.name}</p>
                  {/* The server's own description of the recurrence. */}
                  <p className="mt-0.5 text-xs text-ink-muted">{schedule.summary}</p>
                </div>

                <Badge tone={scheduleStatusTone(schedule.status)}>
                  {scheduleStatusLabel(schedule.status)}
                </Badge>
              </div>

              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-border pt-3 text-sm">
                <div>
                  <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Next delivery</dt>
                  <dd className="text-ink">
                    {schedule.nextRunAt === null ? (
                      <span className="text-ink-muted">Not scheduled</span>
                    ) : (
                      <>
                        {formatDateTime(schedule.nextRunAt)}
                        <span className="ml-1 text-xxs text-ink-subtle">{schedule.timezone}</span>
                      </>
                    )}
                  </dd>
                </div>

                <div>
                  <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Delivered</dt>
                  <dd className="text-ink">
                    {formatNumber(schedule.occurrenceCount)}
                    {schedule.maxOccurrences !== null &&
                      ` of ${formatNumber(schedule.maxOccurrences)}`}
                  </dd>
                </div>

                <div>
                  <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Payment</dt>
                  <dd className="text-ink">
                    {schedule.paymentMode === 'AUTO_PAY' ? 'Charged automatically' : 'Payment link'}
                  </dd>
                </div>
              </dl>

              {schedule.failureCount > 0 && schedule.status !== 'CANCELLED' && (
                <p className="mt-2 text-xs text-warning">
                  {formatNumber(schedule.failureCount)} recent delivery
                  {schedule.failureCount === 1 ? '' : 'ies'} could not be placed.
                </p>
              )}

              {schedule.pausedReason !== null && (
                <p className="mt-2 text-xs text-ink-muted">Paused: {schedule.pausedReason}</p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
