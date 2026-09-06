/**
 * Automatic refresh of rate-converted prices.
 *
 * What this panel is careful to say, because it is the thing people assume
 * wrongly: the storefront never converts at read time. This keeps the *stored*
 * prices current on a schedule, so a shopper is still quoted a real figure and
 * is charged exactly what the page showed. Between runs the catalogue is as
 * fixed as a hand-typed one.
 *
 * The last run's outcome sits on the same card as the switch on purpose. A
 * scheduled job that quietly stopped working is worse than one that never ran -
 * nobody goes looking for a log they have no reason to suspect - so its status
 * is in front of whoever turns it on.
 *
 * Plain controlled state rather than react-hook-form: four fields, and the
 * resolver in this repo is currently mismatched with its zod version.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Select,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type Rounding = 'exact' | 'whole' | 'charm';
type RunStatus = 'ok' | 'skipped' | 'failed';

interface FxSettings {
  isEnabled: boolean;
  marginPercent: string;
  rounding: Rounding;
  maxDriftPercent: string;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  lastRunMessage: string | null;
  lastRunUpdated: number;
}

const STATUS_TONES: Record<RunStatus, BadgeTone> = {
  ok: 'success',
  skipped: 'neutral',
  failed: 'danger',
};

export function ExchangeRatesPanel(): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [draft, setDraft] = useState<FxSettings | null>(null);

  const query = useQuery({
    queryKey: ['exchange-rate-settings'],
    queryFn: () => api.get<{ settings: FxSettings }>('/admin/settings/exchange-rates'),
  });

  useEffect(() => {
    if (query.data !== undefined) setDraft(query.data.settings);
  }, [query.data]);

  const save = useMutation({
    mutationFn: (next: FxSettings) =>
      api.put<{ settings: FxSettings }>('/admin/settings/exchange-rates', {
        isEnabled: next.isEnabled,
        marginPercent: next.marginPercent,
        rounding: next.rounding,
        maxDriftPercent: next.maxDriftPercent,
      }),
    onSuccess: async ({ settings }) => {
      setDraft(settings);
      toast.success(t('exchangeRates.saved'));
      await queryClient.invalidateQueries({ queryKey: ['exchange-rate-settings'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('exchangeRates.saveFailed'));
    },
  });

  const refresh = useMutation({
    mutationFn: () =>
      api.post<{ settings: FxSettings }>('/admin/settings/exchange-rates/refresh', {}),
    onSuccess: async ({ settings }) => {
      setDraft(settings);

      // The prices themselves have moved, so anything showing one is stale.
      await queryClient.invalidateQueries();

      if (settings.lastRunStatus === 'failed') {
        toast.error(settings.lastRunMessage ?? t('exchangeRates.runFailed'));
        return;
      }

      toast.success(settings.lastRunMessage ?? t('exchangeRates.runFinished'));
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('exchangeRates.runFailed'));
    },
  });

  const canWrite = can(Permission.SETTINGS_WRITE);
  const busy = save.isPending || refresh.isPending;

  return (
    <Card title={t('exchangeRates.title')} description={t('exchangeRates.description')}>
      {query.isPending && <LoadingState label={t('exchangeRates.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {draft !== null && (
        <div className="space-y-5">
          <Callout tone="info">{t('exchangeRates.howItWorks')}</Callout>

          <label className="flex items-start gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              checked={draft.isEnabled}
              disabled={!canWrite || busy}
              onChange={(event) => {
                setDraft({ ...draft, isEnabled: event.target.checked });
              }}
              className="mt-0.5 h-4 w-4 rounded border-border-strong"
            />
            <span>
              {t('exchangeRates.enableLabel')}
              <span className="mt-0.5 block text-xs text-ink-muted">
                {t('exchangeRates.enableHint')}
              </span>
            </span>
          </label>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={t('exchangeRates.marginLabel')} hint={t('exchangeRates.marginHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  value={draft.marginPercent}
                  disabled={!canWrite || busy}
                  onChange={(event) => {
                    setDraft({ ...draft, marginPercent: event.target.value });
                  }}
                />
              )}
            </Field>

            <Field label={t('exchangeRates.roundingLabel')} hint={t('exchangeRates.roundingHint')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={draft.rounding}
                  disabled={!canWrite || busy}
                  onChange={(event) => {
                    setDraft({ ...draft, rounding: event.target.value as Rounding });
                  }}
                >
                  <option value="charm">{t('bulkPricing.roundingCharm')}</option>
                  <option value="whole">{t('bulkPricing.roundingWhole')}</option>
                  <option value="exact">{t('bulkPricing.roundingExact')}</option>
                </Select>
              )}
            </Field>

            <Field label={t('exchangeRates.driftLabel')} hint={t('exchangeRates.driftHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  inputMode="decimal"
                  value={draft.maxDriftPercent}
                  disabled={!canWrite || busy}
                  onChange={(event) => {
                    setDraft({ ...draft, maxDriftPercent: event.target.value });
                  }}
                />
              )}
            </Field>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-ink-muted">
              {draft.lastRunAt === null ? (
                t('exchangeRates.neverRun')
              ) : (
                <>
                  <Badge tone={STATUS_TONES[draft.lastRunStatus ?? 'skipped']}>
                    {t(`exchangeRates.status.${draft.lastRunStatus ?? 'skipped'}`)}
                  </Badge>{' '}
                  {t('exchangeRates.lastRun', {
                    when: new Date(draft.lastRunAt).toLocaleString(intlLocale),
                  })}{' '}
                  <span className="block">{draft.lastRunMessage}</span>
                </>
              )}
            </p>

            {canWrite && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={busy || !draft.isEnabled}
                  onClick={() => {
                    refresh.mutate();
                  }}
                >
                  {refresh.isPending ? t('exchangeRates.running') : t('exchangeRates.refreshNow')}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    save.mutate(draft);
                  }}
                >
                  {save.isPending ? t('exchangeRates.saving') : t('exchangeRates.save')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
