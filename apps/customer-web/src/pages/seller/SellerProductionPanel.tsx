/**
 * Production milestones and exceptions on one seller order (checklist Master
 * row 40).
 *
 * The four stages are recorded in order. Only the next one has a button, and
 * the server decides again. Recording a stage never changes the order's
 * status: accepting, packing and ready-for-dispatch stay the order's own
 * buttons in "What next".
 *
 * Two notes per action, kept visibly apart: an internal note the buyer never
 * sees, and a message the buyer is shown on their order.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, ErrorState, Field, Input, LoadingState, Select, Textarea } from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format';
import {
  PRODUCTION_DELAY_REASONS,
  completeProductionStage,
  delayReasonKey,
  stageKey,
  fetchProduction,
  planProductionStage,
  raiseProductionDelay,
  resolveProductionDelay,
  type ProductionDelayReason,
  type ProductionStage,
} from '@/lib/seller-workbench';

export function SellerProductionPanel({ sellerOrderId }: { sellerOrderId: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const key = ['seller', 'order', sellerOrderId, 'production'];
  const query = useQuery({ queryKey: key, queryFn: () => fetchProduction(sellerOrderId), retry: false });

  const [buyerNote, setBuyerNote] = useState('');
  const [internalNote, setInternalNote] = useState('');
  const [raising, setRaising] = useState(false);

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: key });
  };

  const complete = useMutation({
    mutationFn: (stage: ProductionStage) =>
      completeProductionStage(sellerOrderId, {
        stage,
        buyerNote: buyerNote.trim() === '' ? null : buyerNote.trim(),
        internalNote: internalNote.trim() === '' ? null : internalNote.trim(),
      }),
    onSuccess: async () => {
      setBuyerNote('');
      setInternalNote('');
      toast.success(t('sellerProduction.recorded'));
      await refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const plan = useMutation({
    mutationFn: (input: { stage: ProductionStage; plannedFor: string }) => planProductionStage(sellerOrderId, input),
    onSuccess: refresh,
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const resolve = useMutation({
    mutationFn: (delayId: string) => resolveProductionDelay(sellerOrderId, delayId, null),
    onSuccess: refresh,
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (query.isPending) return <LoadingState />;
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

  const view = query.data;

  return (
    <Card
      title={t('sellerProduction.title')}
      description={view.open ? t('sellerProduction.description') : t('sellerProduction.closed')}
      bodyClassName="px-6 py-5 space-y-5"
    >
      <ol className="space-y-3" aria-label={t('sellerProduction.title')}>
        {view.stages.map((row) => {
          const isNext = view.nextStage === row.stage;
          return (
            <li
              key={row.stage}
              data-testid={`stage-${row.stage}`}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
            >
              <div className="min-w-0">
                <p className="font-medium text-ink">{t(stageKey(row.stage))}</p>
                <p className="text-sm text-ink-muted">
                  {row.completedAt !== null
                    ? t('sellerProduction.completedOn', {
                        when: formatDateTime(row.completedAt),
                        who: row.completedByLabel ?? '',
                      })
                    : row.plannedFor !== null
                      ? t('sellerProduction.plannedFor', { date: formatDate(row.plannedFor) })
                      : t('sellerProduction.notPlanned')}
                </p>
                {row.buyerNote !== null && (
                  <p className="text-sm text-ink">{t('sellerProduction.toldBuyer', { note: row.buyerNote })}</p>
                )}
                {row.internalNote !== null && (
                  <p className="text-sm text-ink-muted">{t('sellerProduction.internal', { note: row.internalNote })}</p>
                )}
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-2">
                {row.completedAt !== null ? (
                  <Badge tone="success">{t('sellerProduction.done')}</Badge>
                ) : (
                  view.open && (
                    <Input
                      type="date"
                      aria-label={t('sellerProduction.planLabel', { stage: t(stageKey(row.stage)) })}
                      defaultValue={row.plannedFor ?? ''}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        if (value !== '') plan.mutate({ stage: row.stage, plannedFor: value });
                      }}
                    />
                  )
                )}
                {isNext && view.open && (
                  <Button
                    size="sm"
                    isLoading={complete.isPending}
                    onClick={() => {
                      complete.mutate(row.stage);
                    }}
                  >
                    {t('sellerProduction.record', { stage: t(stageKey(row.stage)) })}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ol>

      {view.open && view.nextStage !== null && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('sellerProduction.buyerNote')} hint={t('sellerProduction.buyerNoteHint')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                maxLength={1000}
                value={buyerNote}
                onChange={(event) => {
                  setBuyerNote(event.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field label={t('sellerProduction.internalNote')} hint={t('sellerProduction.internalNoteHint')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                maxLength={2000}
                value={internalNote}
                onChange={(event) => {
                  setInternalNote(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-medium text-ink">{t('sellerProduction.exceptions')}</h3>
          {view.open && view.nextStage !== null && !raising && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setRaising(true);
              }}
            >
              {t('sellerProduction.raise')}
            </Button>
          )}
        </div>

        {raising && view.nextStage !== null && (
          <RaiseDelayForm
            sellerOrderId={sellerOrderId}
            stages={view.stages.filter((row) => row.completedAt === null).map((row) => row.stage)}
            onDone={async () => {
              setRaising(false);
              await refresh();
            }}
          />
        )}

        {view.delays.length === 0 ? (
          <p className="text-sm text-ink-muted">{t('sellerProduction.noExceptions')}</p>
        ) : (
          <ul className="space-y-2">
            {view.delays.map((delay) => (
              <li key={delay.id} className="rounded-lg border border-border px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium text-ink">
                    {t(stageKey(delay.stage))} · {t(delayReasonKey(delay.reason))}
                  </p>
                  {delay.resolvedAt === null ? (
                    <Badge tone="warning">{t('sellerProduction.open')}</Badge>
                  ) : (
                    <Badge tone="neutral">{t('sellerProduction.resolved')}</Badge>
                  )}
                </div>
                <p className="text-ink-muted">
                  {t('sellerProduction.revisedDate', { date: formatDate(delay.revisedDate) })}
                </p>
                {delay.buyerMessage !== null && (
                  <p className="text-ink">{t('sellerProduction.toldBuyer', { note: delay.buyerMessage })}</p>
                )}
                {delay.detail !== null && (
                  <p className="text-ink-muted">{t('sellerProduction.internal', { note: delay.detail })}</p>
                )}
                {delay.resolvedAt === null && view.open && (
                  <Button
                    size="sm"
                    variant="ghost"
                    isLoading={resolve.isPending}
                    onClick={() => {
                      resolve.mutate(delay.id);
                    }}
                  >
                    {t('sellerProduction.resolve')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </Card>
  );
}

function RaiseDelayForm({
  sellerOrderId,
  stages,
  onDone,
}: {
  sellerOrderId: string;
  stages: ProductionStage[];
  onDone: () => Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const [stage, setStage] = useState<ProductionStage>(stages[0] ?? 'RAW_MATERIAL');
  const [reason, setReason] = useState<ProductionDelayReason>('RAW_MATERIAL_SHORTAGE');
  const [revisedDate, setRevisedDate] = useState('');
  const [buyerMessage, setBuyerMessage] = useState('');
  const [detail, setDetail] = useState('');

  const raise = useMutation({
    mutationFn: () =>
      raiseProductionDelay(sellerOrderId, {
        stage,
        reason,
        revisedDate,
        detail: detail.trim() === '' ? null : detail.trim(),
        buyerMessage: buyerMessage.trim() === '' ? null : buyerMessage.trim(),
      }),
    onSuccess: async () => {
      toast.success(t('sellerProduction.raised'));
      await onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  return (
    <form
      className="grid gap-3 rounded-lg border border-border px-4 py-4 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        raise.mutate();
      }}
    >
      <Field label={t('sellerProduction.stage')}>
        {({ inputId }) => (
          <Select
            id={inputId}
            value={stage}
            onChange={(event) => {
              setStage(event.currentTarget.value as ProductionStage);
            }}
          >
            {stages.map((value) => (
              <option key={value} value={value}>
                {t(stageKey(value))}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('sellerProduction.reason')}>
        {({ inputId }) => (
          <Select
            id={inputId}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value as ProductionDelayReason);
            }}
          >
            {PRODUCTION_DELAY_REASONS.map((value) => (
              <option key={value} value={value}>
                {t(delayReasonKey(value))}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('sellerProduction.newDate')} required>
        {({ inputId }) => (
          <Input
            id={inputId}
            type="date"
            required
            value={revisedDate}
            onChange={(event) => {
              setRevisedDate(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      <Field label={t('sellerProduction.buyerNote')} hint={t('sellerProduction.buyerNoteHint')}>
        {({ inputId, describedBy }) => (
          <Input
            id={inputId}
            aria-describedby={describedBy}
            maxLength={1000}
            value={buyerMessage}
            onChange={(event) => {
              setBuyerMessage(event.currentTarget.value);
            }}
          />
        )}
      </Field>
      <div className="sm:col-span-2">
        <Field label={t('sellerProduction.internalNote')} hint={t('sellerProduction.internalNoteHint')}>
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              maxLength={2000}
              value={detail}
              onChange={(event) => {
                setDetail(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Button type="submit" isLoading={raise.isPending} disabled={revisedDate === ''}>
          {t('sellerProduction.raise')}
        </Button>
      </div>
    </form>
  );
}
