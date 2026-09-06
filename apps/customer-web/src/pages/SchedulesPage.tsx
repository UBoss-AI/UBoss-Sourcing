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
 *
 * Teal is used deliberately and sparingly here. A standing arrangement is the
 * capability this page is selling, so the header carries one teal panel
 * explaining it and each row carries a teal status chip — and that is all. A
 * page tinted teal throughout would read as an alert, which is the one thing a
 * schedule quietly doing its job is not.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { PageEmptyState } from '@/components/PageEmptyState';
import { ChevronRightIcon, RepeatIcon } from '@/components/icons';
import { Badge, ButtonLink, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber } from '@/lib/format';
import { scheduleStatusLabel, scheduleStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Schedule } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** One figure in a schedule row. */
function Figure({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 text-ink">{children}</dd>
    </div>
  );
}

export function SchedulesPage(): React.JSX.Element {
  const { t } = useI18n();

  const { business, features } = useStorefront();

  useDocumentMeta({ title: 'Repeat purchases', noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: ['schedules'],
    queryFn: () => api.get<{ schedules: Schedule[] }>('/recurring-schedules'),
  });

  if (query.isPending) return <LoadingState label={t('schedules.loadingYourRepeatPurchases')} />;

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
      <PageEmptyState
        title={t('schedules.noRepeatPurchasesYet')}
        description={
          features.recurringOrders
            ? 'Set one up and we will place the order for you on a schedule you choose. Look for the “Repeat purchase” label on a product.'
            : 'Repeat purchases are switched off at the moment.'
        }
        {...(features.recurringOrders
          ? {
              action: (
                <ButtonLink to="/products" variant="primary" size="lg">
                  {t('schedules.browseProducts')}
                </ButtonLink>
              ),
            }
          : {})}
      />
    );
  }

  return (
    <>
      <PageHeader
        title={t('schedules.repeatPurchases')}
        description={t('schedules.standingOrdersWePlaceFor')}
        {...(features.recurringOrders
          ? {
              actions: (
                /* Teal, not orange: committing to a schedule is neither a
                   navigation action nor a one-off purchase. */
                <ButtonLink to="/schedules/new" variant="operational">
                  <RepeatIcon className="h-4 w-4" />
                  {t('schedules.setUpANewOne')}
                </ButtonLink>
              ),
            }
          : {})}
      />

      <ul className="space-y-3">
        {schedules.map((schedule) => (
          <li key={schedule.id}>
            <Link
              to={`/account/schedules/${schedule.id}`}
              className="group block rounded-lg border border-border bg-surface p-4 shadow-card transition-[box-shadow,border-color] hover:border-border-hover hover:shadow-card-hover"
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-title-xs text-ink">
                    {schedule.name}
                    <ChevronRightIcon className="h-4 w-4 text-ink-subtle transition-transform group-hover:translate-x-0.5" />
                  </p>
                  {/* The server's own description of the recurrence. */}
                  <p className="mt-1 text-xs text-ink-muted">{schedule.summary}</p>
                </div>

                <Badge tone={scheduleStatusTone(schedule.status)}>
                  {scheduleStatusLabel(schedule.status)}
                </Badge>
              </div>

              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-border-subtle pt-3 text-sm">
                <Figure label={t('schedules.nextDelivery')}>
                  {schedule.nextRunAt === null ? (
                    <span className="text-ink-muted">{t('schedules.notScheduled')}</span>
                  ) : (
                    <>
                      {formatDateTime(schedule.nextRunAt)}
                      <span className="ml-1 text-xxs text-ink-subtle">{schedule.timezone}</span>
                    </>
                  )}
                </Figure>

                <Figure label={t('schedules.delivered')}>
                  {formatNumber(schedule.occurrenceCount)}
                  {schedule.maxOccurrences !== null &&
                    ` of ${formatNumber(schedule.maxOccurrences)}`}
                </Figure>

                <Figure label={t('schedules.payment')}>
                  {schedule.paymentMode === 'AUTO_PAY' ? 'Charged automatically' : 'Payment link'}
                </Figure>
              </dl>

              {schedule.failureCount > 0 && schedule.status !== 'CANCELLED' && (
                <p className="mt-2 text-xs text-warning">
                  {formatNumber(schedule.failureCount)} recent deliver
                  {schedule.failureCount === 1 ? 'y' : 'ies'} could not be placed.
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
