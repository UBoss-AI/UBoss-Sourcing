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
import { Badge, Button, ErrorState, Field, LoadingState, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDateTime, formatNumber, humanise } from '@/lib/format';
import { scheduleStatusLabel, scheduleStatusTone } from '@/lib/order-status';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { Schedule } from '@/lib/types';

type PendingAction = 'pause' | 'resume' | 'cancel';

const ACTION_COPY: Record<PendingAction, { title: string; body: string; confirm: string }> = {
  pause: {
    title: 'Pause this repeat purchase?',
    body: 'It stops producing deliveries and keeps its place. Resume it whenever you are ready and it carries on from its next scheduled date. Deliveries already made are unaffected.',
    confirm: 'Pause it',
  },
  resume: {
    title: 'Resume this repeat purchase?',
    body: 'Deliveries start again from the next scheduled date.',
    confirm: 'Resume it',
  },
  cancel: {
    title: 'Cancel this repeat purchase?',
    body: 'This is final — the schedule cannot be restarted, and you would need to set up a new one. Deliveries already made are unaffected and keep their own orders.',
    confirm: 'Cancel it',
  },
};

export function ScheduleDetailPage(): React.JSX.Element {
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
    { title: query.data?.schedule.name ?? 'Repeat purchase', noIndex: true },
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
          ? 'Paused. No further deliveries until you resume it.'
          : action === 'resume'
            ? 'Resumed. Deliveries start again from the next scheduled date.'
            : 'Cancelled. Deliveries already made are unaffected.',
      );

      await queryClient.invalidateQueries({ queryKey: ['schedule', id] });
      await queryClient.invalidateQueries({ queryKey: ['schedules'] });

      if (action === 'cancel') void navigate('/account/schedules');
    },
    onError: (error) => {
      setActionError(error instanceof ApiError ? error.message : 'That could not be done.');
    },
  });

  if (query.isPending) return <LoadingState label="Loading your repeat purchase" />;

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
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-muted">
          <li>
            <Link to="/account/schedules" className="hover:text-brand hover:underline">
              Repeat purchases
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li className="font-medium text-ink" aria-current="page">
            {schedule.name}
          </li>
        </ol>
      </nav>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{schedule.name}</h1>
          <p className="mt-1 text-sm text-ink-muted">{schedule.summary}</p>
        </div>

        <Badge tone={scheduleStatusTone(schedule.status)}>
          {scheduleStatusLabel(schedule.status)}
        </Badge>
      </div>

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
            {formatNumber(schedule.failureCount)} recent delivery
            {schedule.failureCount === 1 ? '' : 'ies'} could not be placed
          </p>
          <p className="mt-1 text-ink">
            Usually a stock or payment problem. After{' '}
            {formatNumber(schedule.maxFailures)} failures in a row the schedule stops on its own so
            it does not keep trying — get in touch and we will sort it out.
          </p>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          {/* --- The schedule ------------------------------------------------ */}
          <section aria-labelledby="cadence-heading" className="rounded-lg border border-border bg-surface p-5">
            <h2 id="cadence-heading" className="text-base font-semibold text-ink">
              Schedule
            </h2>

            <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Next delivery</dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.nextRunAt === null ? (
                    <span className="text-ink-muted">Not scheduled</span>
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
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Last delivery</dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.lastRunAt === null ? (
                    <span className="text-ink-muted">None yet</span>
                  ) : (
                    formatDateTime(schedule.lastRunAt)
                  )}
                </dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Started</dt>
                <dd className="mt-0.5 text-ink">{schedule.startDate}</dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Ends</dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.endDate !== null
                    ? schedule.endDate
                    : schedule.maxOccurrences !== null
                      ? `After ${formatNumber(schedule.maxOccurrences)} deliveries`
                      : 'When you cancel'}
                </dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Delivered</dt>
                <dd className="mt-0.5 text-ink">{formatNumber(schedule.occurrenceCount)}</dd>
              </div>

              <div>
                <dt className="text-xxs uppercase tracking-wider text-ink-subtle">Payment</dt>
                <dd className="mt-0.5 text-ink">
                  {schedule.paymentMode === 'AUTO_PAY' ? 'Charged automatically' : 'Payment link'}
                  {schedule.paymentMode === 'PAYMENT_LINK' && schedule.payerEmail !== null && (
                    <span className="block text-xxs text-ink-subtle">
                      Sent to {schedule.payerEmail}
                    </span>
                  )}
                  {schedule.paymentMode === 'AUTO_PAY' && !schedule.hasMandate && (
                    <span className="block text-xxs text-danger">
                      No mandate authorised yet — deliveries cannot be charged.
                    </span>
                  )}
                </dd>
              </div>
            </dl>

            <p className="mt-4 border-t border-border pt-4 text-xs text-ink-muted">
              Every delivery is priced fresh against the catalogue, tax, stock and your account
              limits on the day it runs, so the amount can change between deliveries.
            </p>
          </section>

          {/* --- Items ------------------------------------------------------- */}
          {schedule.items !== undefined && schedule.items.length > 0 && (
            <section aria-labelledby="items-heading" className="rounded-lg border border-border bg-surface p-5">
              <h2 id="items-heading" className="text-base font-semibold text-ink">
                What is delivered
              </h2>

              <ul className="mt-3 divide-y divide-border text-sm">
                {schedule.items.map((item) => (
                  <li
                    key={`${item.productId}:${item.variantId ?? ''}`}
                    className="flex justify-between gap-4 py-2.5"
                  >
                    <span className="min-w-0">
                      <span className="block text-ink">{item.name ?? 'Product'}</span>
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
            <section aria-labelledby="history-heading" className="rounded-lg border border-border bg-surface">
              <h2
                id="history-heading"
                className="border-b border-border px-5 py-4 text-base font-semibold text-ink"
              >
                Delivery history
              </h2>

              <ul className="divide-y divide-border">
                {schedule.occurrences.map((occurrence) => (
                  <li key={occurrence.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
                    <span className="whitespace-nowrap text-xs text-ink-subtle">
                      {formatDateTime(occurrence.scheduledFor)}
                    </span>

                    <Badge
                      tone={
                        occurrence.status === 'SUCCEEDED'
                          ? 'success'
                          : occurrence.status === 'FAILED'
                            ? 'danger'
                            : 'neutral'
                      }
                    >
                      {humanise(occurrence.status)}
                    </Badge>

                    {occurrence.orderId !== null && (
                      <Link
                        to={`/account/orders/${occurrence.orderId}`}
                        className="font-mono text-xs font-medium text-brand hover:underline"
                      >
                        {occurrence.orderNumber ?? 'View order'}
                      </Link>
                    )}

                    {occurrence.failureReason !== null && (
                      <span className="w-full text-xs text-danger">{occurrence.failureReason}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        {/* --- Actions --------------------------------------------------------- */}
        <aside className="lg:sticky lg:top-40 lg:self-start">
          <div className="rounded-lg border border-border bg-surface p-5">
            <h2 className="text-base font-semibold text-ink">Manage</h2>

            <div className="mt-3 space-y-2">
              {schedule.status === 'ACTIVE' && (
                <Button
                  fullWidth
                  onClick={() => {
                    setActionError(null);
                    setReason('');
                    setPending('pause');
                  }}
                >
                  Pause deliveries
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
                  Resume deliveries
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
                  Cancel this repeat purchase
                </Button>
              )}
            </div>

            {/* Stated wherever a destructive action is offered, not only inside
                the confirmation — someone deciding needs it before they click. */}
            <p className="mt-4 border-t border-border pt-4 text-xs text-ink-muted">
              Pausing or cancelling only affects future deliveries. Orders already placed keep
              their own status and are not changed.
            </p>
          </div>
        </aside>
      </div>

      <Modal
        isOpen={pending !== null}
        onClose={() => {
          setPending(null);
        }}
        title={copy?.title ?? ''}
        footer={
          <>
            <Button
              onClick={() => {
                setPending(null);
              }}
              disabled={act.isPending}
            >
              Leave it as it is
            </Button>
            <Button
              variant={pending === 'cancel' ? 'danger' : 'primary'}
              disabled={pending === 'cancel' && reason.trim() === ''}
              isLoading={act.isPending}
              onClick={() => {
                if (pending !== null) act.mutate(pending);
              }}
            >
              {copy?.confirm ?? 'Confirm'}
            </Button>
          </>
        }
      >
        <div className="space-y-4 text-sm">
          <p className="text-ink-muted">{copy?.body}</p>

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
              label="Reason"
              hint={
                pending === 'cancel'
                  ? 'Required, so we know what went wrong.'
                  : 'Optional. Shown on the schedule while it is paused.'
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
