/**
 * One repeat purchase.
 *
 * The distinction this page has to keep clear: **editing or cancelling a
 * schedule changes what happens next, never what already happened.** Orders it
 * has already produced are ordinary orders and stay exactly as they are — a
 * customer who cancels a schedule has not cancelled last month's delivery, and
 * the page says so before they confirm.
 *
 * Pausing and cancelling are different actions with different consequences, so
 * they are separate buttons with separate confirmations. Cancelling is final
 * and takes a reason; pausing is not and does not.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Modal } from '@/components/Modal';
import {
  Badge,
  Button,
  ButtonLink,
  ErrorState,
  Field,
  LoadingState,
  Textarea,
} from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatNumber, humanise } from '@/lib/format';
import {
  occurrenceStatusTone,
  scheduleStatusLabel,
  scheduleStatusTone,
} from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Schedule } from '@/lib/types';
import { translateKey, useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

type PendingAction = 'pause' | 'resume' | 'cancel';

// Keys, not words: this table is module state, built before any component can
// call `t`. Translated in the dialog that shows it.
const ACTION_COPY: Record<
  PendingAction,
  { title: TranslationKey; body: TranslationKey; confirm: TranslationKey }
> = {
  pause: {
    title: 'scheduleDetail.pauseThisQuestion',
    body: 'scheduleDetail.pauseExplain',
    confirm: 'scheduleDetail.pauseIt',
  },
  resume: {
    title: 'scheduleDetail.resumeThisQuestion',
    body: 'scheduleDetail.resumeExplain',
    confirm: 'scheduleDetail.resumeIt',
  },
  cancel: {
    title: 'scheduleDetail.cancelThisQuestion',
    body: 'scheduleDetail.cancelExplain',
    confirm: 'scheduleDetail.cancelIt',
  },
};

export function ScheduleDetailPage(): React.JSX.Element {
  const { t } = useI18n();

  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { business } = useStorefront();

  const [pending, setPending] = useState<PendingAction | null>(null);
  const [reason, setReason] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  const query = useQuery({
    queryKey: ['schedule', id],
    queryFn: () => api.get<{ schedule: Schedule }>(`/recurring-schedules/${String(id)}`),
    enabled: id !== undefined,
  });

  useDocumentMeta(
    { title: query.data?.schedule.name ?? t('scheduleDetail.repeatPurchase'), noIndex: true },
    business.displayName,
  );

  const act = useMutation({
    mutationFn: (action: PendingAction) => {
      const trimmed = reason.trim();

      if (action === 'cancel') {
        // A DELETE body is not reliably forwarded by every proxy, so the
        // reason travels as a query parameter.
        return api.delete(
          `/recurring-schedules/${String(id)}`,
          trimmed === '' ? {} : { query: { reason: trimmed } },
        );
      }

      return api.post(
        `/recurring-schedules/${String(id)}/${action}`,
        trimmed === '' ? undefined : { reason: trimmed },
      );
    },
    onSuccess: async (_result, action) => {
      setPending(null);
      setReason('');
      setActionError(null);

      toast.success(
        action === 'pause'
          ? t('scheduleDetail.pausedNoFurther')
          : action === 'resume'
            ? t('scheduleDetail.resumedStartsAgain')
            : t('scheduleDetail.cancelledAlreadyMade'),
      );

      await queryClient.invalidateQueries({ queryKey: ['schedule', id] });
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });

      if (action === 'cancel') void navigate('/account/schedules');
    },
    onError: (error) => {
      setActionError(errorMessage(t, error, t('scheduleDetail.thatCouldNotBeDone')));
    },
  });

  if (query.isPending)
    return <LoadingState label={t('scheduleDetail.loadingYourRepeatPurchase')} />;

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

  const schedule = query.data.schedule;
  const copy = pending === null ? null : ACTION_COPY[pending];

  return (
    <>
      <nav aria-label={t('scheduleDetail.breadcrumb')} className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-muted">
          <li>
            <Link to="/account/schedules" className="hover:text-brand hover:underline">
              {t('scheduleDetail.repeatPurchases')}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="font-medium text-ink" aria-current="page">
            {schedule.name}
          </li>
        </ol>
      </nav>

      {/* The same silhouette as `PageHeader`, with the status chip in the
          actions slot — one header shape across the whole account section. */}
      <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-title-xl text-ink">{schedule.name}</h1>
          <p className="mt-2 text-sm text-ink-muted">{schedule.summary}</p>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone={scheduleStatusTone(schedule.status)}>
            {scheduleStatusLabel(t, schedule.status)}
          </Badge>
        </div>
      </header>

      {schedule.pausedReason !== null && schedule.status === 'PAUSED' && (
        <div
          role="status"
          className="mb-6 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-ink"
        >
          Paused: {schedule.pausedReason}
        </div>
      )}

      {schedule.failureCount > 0 && schedule.status !== 'CANCELLED' && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-sm"
        >
          <p className="font-medium text-warning">
            {t('schedules.recentDeliveriesFailed', {
              count: schedule.failureCount,
              deliveries: formatNumber(schedule.failureCount),
            })}
          </p>
          <p className="mt-1 text-ink">
            {t('scheduleDetail.usuallyStockOrPayment', {
              failures: formatNumber(schedule.maxFailures),
            })}
          </p>
        </div>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-6">
          {/* --- The schedule ------------------------------------------------ */}
          <section
            aria-labelledby="cadence-heading"
            className="rounded-lg border border-border bg-surface p-5 shadow-card"
          >
            <h2 id="cadence-heading" className="text-title-sm text-ink">
              {t('scheduleDetail.schedule')}
            </h2>

            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">
                  {t('scheduleDetail.nextDelivery')}
                </dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.nextRunAt === null ? (
                    <span className="text-ink-muted">{t('scheduleDetail.notScheduled')}</span>
                  ) : (
                    <>
                      {formatDateTime(schedule.nextRunAt)}
                      {/* The zone matters: this runs on the customer's clock. */}
                      <span className="block text-xxs text-ink-subtle">{schedule.timezone}</span>
                    </>
                  )}
                </dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">
                  {t('scheduleDetail.lastDelivery')}
                </dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.lastRunAt === null ? (
                    <span className="text-ink-muted">{t('scheduleDetail.noneYet')}</span>
                  ) : (
                    formatDateTime(schedule.lastRunAt)
                  )}
                </dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">
                  {t('scheduleDetail.started')}
                </dt>
                <dd className="mt-0.5 text-ink">{schedule.startDate}</dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">
                  {t('scheduleDetail.ends')}
                </dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.endDate !== null
                    ? schedule.endDate
                    : schedule.maxOccurrences !== null
                      ? t('scheduleDetail.afterNDeliveries', {
                          count: schedule.maxOccurrences,
                          deliveries: formatNumber(schedule.maxOccurrences),
                        })
                      : t('scheduleDetail.whenYouCancel')}
                </dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">
                  {t('scheduleDetail.delivered')}
                </dt>
                <dd className="mt-0.5 text-ink">{formatNumber(schedule.occurrenceCount)}</dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">
                  {t('scheduleDetail.payment')}
                </dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.paymentMode === 'AUTO_PAY' ? t('scheduleDetail.chargedAutomatically') : t('scheduleDetail.paymentLink')}
                  {schedule.paymentMode === 'PAYMENT_LINK' && schedule.payerEmail !== null && (
                    <span className="block text-xxs text-ink-subtle">
                      Sent to {schedule.payerEmail}
                    </span>
                  )}
                  {schedule.paymentMode === 'AUTO_PAY' && !schedule.hasMandate && (
                    <span className="block text-xxs text-danger">
                      {t('scheduleDetail.noMandateAuthorisedYetDeliveries')}
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <p className="mt-4 border-t border-border pt-4 text-xs text-ink-muted">
              {t('scheduleDetail.everyDeliveryIsPricedFresh')}
            </p>
          </section>

          {/* --- Items ------------------------------------------------------- */}
          {schedule.items !== undefined && schedule.items.length > 0 && (
            <section
              aria-labelledby="items-heading"
              className="rounded-lg border border-border bg-surface p-5 shadow-card"
            >
              <h2 id="items-heading" className="text-title-sm text-ink">
                {t('scheduleDetail.whatIsDelivered')}
              </h2>

              <ul className="mt-3 divide-y divide-border text-sm">
                {schedule.items.map((item) => (
                  <li
                    key={`${item.productId}:${item.variantId ?? ''}`}
                    className="flex justify-between gap-4 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="block text-ink">{item.name ?? t('scheduleDetail.product')}</span>
                      {item.sku !== undefined && (
                        <span className="font-mono text-xxs text-ink-subtle">{item.sku}</span>
                      )}
                    </span>
                    <span className="shrink-0 tabular text-ink">
                      × {formatNumber(item.quantity)}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* --- History ------------------------------------------------------ */}
          {schedule.occurrences !== undefined && schedule.occurrences.length > 0 && (
            <section
              aria-labelledby="history-heading"
              className="rounded-lg border border-border bg-surface shadow-card"
            >
              <h2
                id="history-heading"
                className="border-b border-border px-5 py-4 text-base font-semibold text-ink"
              >
                {t('scheduleDetail.deliveryHistory')}
              </h2>

              <ul className="divide-y divide-border">
                {schedule.occurrences.map((occurrence) => (
                  <li
                    key={occurrence.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm"
                  >
                    <span className="whitespace-nowrap text-xs text-ink-subtle">
                      {/* `plannedRunAt`, which is what the API sends. This read
                          `scheduledFor` — a field no response has ever carried
                          — so every date in this list rendered as an invalid
                          one. */}
                      {formatDateTime(occurrence.plannedRunAt)}
                    </span>

                    {/* The shared tone table, rather than a local guess at
                        which statuses exist. The guess it replaced tested for
                        `SUCCEEDED`, which is not one of them, so a completed
                        delivery wore the same grey chip as a skipped one. */}
                    <Badge tone={occurrenceStatusTone(occurrence.status)}>
                      {humanise(occurrence.status)}
                    </Badge>

                    {occurrence.orderId !== null && (
                      <Link
                        to={`/account/orders/${occurrence.orderId}`}
                        className="font-mono text-xs font-medium text-brand hover:underline"
                      >
                        {occurrence.orderNumber ?? t('scheduleDetail.viewOrder')}
                      </Link>
                    )}

                    {occurrence.failureMessage !== null && (
                      <span className="w-full text-xs text-danger">
                        {occurrence.failureMessage}
                      </span>
                    )}

                    {/* A skip is not a failure and gets its own line in its
                        own colour: the plan carried on, and the customer is
                        owed the reason rather than a bare grey chip. */}
                    {occurrence.failureMessage === null && occurrence.skipReason !== null && (
                      <span className="w-full text-xs text-ink-muted">{occurrence.skipReason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* --- Actions --------------------------------------------------------- */}
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5 shadow-card">
            <h2 className="text-title-sm text-ink">{t('scheduleDetail.manage')}</h2>

            <div className="mt-3 space-y-2">
              {/* Where the products, the quantities and the cadence are
                  actually changed. This page explains a standing order and
                  can stop or pause it; Schedule Cart is where it is edited,
                  and pointing at it here is how somebody who came looking for
                  "change what is delivered" finds it. */}
              {schedule.status !== 'CANCELLED' && schedule.status !== 'COMPLETED' && (
                <ButtonLink
                  to={`/accounts/schedule?id=${schedule.id}`}
                  variant="primary"
                  fullWidth
                >
                  {t('scheduleDetail.changeWhatIsDelivered')}
                </ButtonLink>
              )}

              {schedule.status === 'ACTIVE' && (
                <Button
                  fullWidth
                  onClick={() => {
                    setActionError(null);
                    setReason('');
                    setPending('pause');
                  }}
                >
                  {t('scheduleDetail.pauseDeliveries')}
                </Button>
              )}

              {schedule.status === 'PAUSED' && (
                <Button
                  fullWidth
                  variant="primary"
                  onClick={() => {
                    setActionError(null);
                    setReason('');
                    setPending('resume');
                  }}
                >
                  {t('scheduleDetail.resumeDeliveries')}
                </Button>
              )}

              {schedule.status !== 'CANCELLED' && (
                <Button
                  fullWidth
                  variant="ghost"
                  onClick={() => {
                    setActionError(null);
                    setReason('');
                    setPending('cancel');
                  }}
                >
                  {t('scheduleDetail.cancelThisRepeatPurchase')}
                </Button>
              )}
            </div>

            {/* Stated wherever a destructive action is offered, not only inside
                the confirmation — someone deciding needs it before they click. */}
            <p className="mt-4 border-t border-border pt-4 text-xs text-ink-muted">
              {t('scheduleDetail.pausingOrCancellingOnlyAffects')}
            </p>
          </div>
        </aside>
      </div>

      <Modal
        isOpen={pending !== null}
        onClose={() => {
          setPending(null);
        }}
        title={copy === null ? '' : translateKey(t, copy.title)}
        footer={
          <>
            <Button
              onClick={() => {
                setPending(null);
              }}
              disabled={act.isPending}
            >
              {t('scheduleDetail.leaveItAsItIs')}
            </Button>
            <Button
              variant={pending === 'cancel' ? 'danger' : 'primary'}
              disabled={pending === 'cancel' && reason.trim() === ''}
              isLoading={act.isPending}
              onClick={() => {
                if (pending !== null) act.mutate(pending);
              }}
            >
              {copy === null ? t('scheduleDetail.confirm') : translateKey(t, copy.confirm)}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-ink-muted">{copy === null ? null : translateKey(t, copy.body)}</p>

          {actionError !== null && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-danger"
            >
              {actionError}
            </p>
          )}

          {pending !== 'resume' && (
            <Field
              label={t('scheduleDetail.reason')}
              hint={
                pending === 'cancel'
                  ? t('scheduleDetail.requiredSoWeKnow')
                  : t('scheduleDetail.optionalShownWhilePaused')
              }
              required={pending === 'cancel'}
            >
              {({ inputId, describedBy }) => (
                <Textarea
                  id={inputId}
                  rows={2}
                  value={reason}
                  aria-describedby={describedBy}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              )}
            </Field>
          )}
        </div>
      </Modal>
    </>
  );
}
