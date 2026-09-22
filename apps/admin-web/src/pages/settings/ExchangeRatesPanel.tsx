/**
 * Exchange rates: where they come from, what they may be used for, and whether
 * they are actually arriving.
 *
 * TWO SWITCHES THAT GOVERN DIFFERENT THINGS, AND THE PANEL SAYS SO
 *
 *   - **Automatic price updates** rewrites the stored price rows that a bulk
 *     conversion produced. Between runs the catalogue is as fixed as a
 *     hand-typed one, and a shopper is charged exactly what the page showed.
 *   - **Automatic conversion** prices a currency nobody has typed a figure in,
 *     at read time, and marks the result approximate.
 *
 * They are independent. A deployment can want the second without the first,
 * and that combination used to be unreachable.
 *
 * WHY THE HEALTH IS ON THE SAME CARD AS THE SWITCH
 *
 * A scheduled job that quietly stopped working is worse than one that never
 * ran - nobody goes looking for a log they have no reason to suspect. So the
 * age of the live rate set, the last success and the last failure sit in front
 * of whoever turns it on, and the history below says what the feed has
 * actually been sending, including the sets that were refused.
 *
 * Plain controlled state rather than react-hook-form: a handful of fields, and
 * the resolver in this repo is currently mismatched with its zod version.
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

interface ProviderChoice {
  key: string;
  label: string;
  description: string;
  pivotCurrency: string;
}

interface FxSettings {
  isEnabled: boolean;
  marginPercent: string;
  rounding: Rounding;
  maxDriftPercent: string;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  lastRunMessage: string | null;
  lastRunUpdated: number;

  provider: string;
  providerChoices: ProviderChoice[];
  deriveMissingPrices: boolean;
  displayMaxAgeHours: number;
  checkoutMaxAgeHours: number;
  alertMaxAgeHours: number;
  quoteTtlSeconds: number;
}

interface FxHealth {
  provider: string;
  hasActiveSet: boolean;
  asOf: string | null;
  ageHours: number | null;
  stale: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  displayMaxAgeHours: number;
  checkoutMaxAgeHours: number;
  alertMaxAgeHours: number;
  deriveMissingPrices: boolean;
}

interface Snapshot {
  id: string;
  provider: string;
  pivotCurrency: string;
  asOf: string;
  fetchedAt: string;
  retrievalStatus: string;
  validationStatus: string;
  failureReason: string | null;
  rateCount: number;
  rejectedCount: number;
  maxDriftPercent: string | null;
  maxDriftCurrency: string | null;
  isActive: boolean;
}

const STATUS_TONES: Record<RunStatus, BadgeTone> = {
  ok: 'success',
  skipped: 'neutral',
  failed: 'danger',
};

/** A whole number of hours, or the value left as typed so a field can be cleared. */
function toHours(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function ExchangeRatesPanel(): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [draft, setDraft] = useState<FxSettings | null>(null);

  const query = useQuery({
    queryKey: ['exchange-rate-settings'],
    queryFn: () =>
      api.get<{ settings: FxSettings; health: FxHealth }>('/admin/settings/exchange-rates'),
  });

  const history = useQuery({
    queryKey: ['exchange-rate-snapshots'],
    queryFn: () =>
      api.get<{ snapshots: Snapshot[] }>('/admin/settings/exchange-rates/snapshots?limit=10'),
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
        provider: next.provider,
        deriveMissingPrices: next.deriveMissingPrices,
        displayMaxAgeHours: next.displayMaxAgeHours,
        checkoutMaxAgeHours: next.checkoutMaxAgeHours,
        alertMaxAgeHours: next.alertMaxAgeHours,
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

      // The prices themselves may have moved, so anything showing one is stale.
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
  const health = query.data?.health ?? null;

  const chosenProvider = draft?.providerChoices.find((choice) => choice.key === draft.provider);

  /*
   * The three windows must stay in order, and the panel says so before the
   * server has to. Saving an out-of-order set is refused either way - this is
   * the same rule shown early rather than a second implementation of it.
   */
  const windowsOutOfOrder =
    draft !== null &&
    (draft.alertMaxAgeHours > draft.checkoutMaxAgeHours ||
      draft.checkoutMaxAgeHours > draft.displayMaxAgeHours);

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
        <div className="space-y-6">
          <Callout tone="info">{t('exchangeRates.howItWorks')}</Callout>

          {/* --- Health ---------------------------------------------------- */}
          {health !== null && (
            <div className="rounded-lg border border-border bg-surface-subtle p-4">
              <div className="flex flex-wrap items-center gap-2">
                {!health.hasActiveSet ? (
                  <Badge tone="danger">{t('exchangeRates.health.none')}</Badge>
                ) : health.stale ? (
                  <Badge tone="warning">{t('exchangeRates.health.stale')}</Badge>
                ) : (
                  <Badge tone="success">{t('exchangeRates.health.current')}</Badge>
                )}

                <span className="text-sm text-ink">
                  {health.asOf === null
                    ? t('exchangeRates.health.neverFetched')
                    : t('exchangeRates.health.asOf', {
                        when: new Date(health.asOf).toLocaleString(intlLocale),
                        hours: health.ageHours ?? 0,
                      })}
                </span>
              </div>

              <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-ink-muted sm:grid-cols-3">
                <div>
                  <dt className="inline">{t('exchangeRates.health.lastSuccess')}: </dt>
                  <dd className="inline">
                    {health.lastSuccessAt === null
                      ? t('exchangeRates.health.never')
                      : new Date(health.lastSuccessAt).toLocaleString(intlLocale)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t('exchangeRates.health.lastFailure')}: </dt>
                  <dd className="inline">
                    {health.lastFailureAt === null
                      ? t('exchangeRates.health.never')
                      : new Date(health.lastFailureAt).toLocaleString(intlLocale)}
                  </dd>
                </div>
                <div>
                  <dt className="inline">{t('exchangeRates.health.consecutiveFailures')}: </dt>
                  <dd className="inline">{health.consecutiveFailures}</dd>
                </div>
              </dl>
            </div>
          )}

          {/* --- Where the rates come from --------------------------------- */}
          <Field label={t('exchangeRates.providerLabel')} hint={t('exchangeRates.providerHint')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={draft.provider}
                disabled={!canWrite || busy}
                onChange={(event) => {
                  setDraft({ ...draft, provider: event.target.value });
                }}
              >
                {draft.providerChoices.map((choice) => (
                  <option key={choice.key} value={choice.key}>
                    {choice.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {/*
           * The provider's own caveat, shown verbatim at the moment somebody
           * chooses it. The ECB publishes reference rates for information and
           * says plainly they are not transaction rates; an administrator
           * should read that here rather than find it in a document later.
           */}
          {chosenProvider !== undefined && (
            <Callout tone="warning">{chosenProvider.description}</Callout>
          )}

          {/* --- What the rates may be used for ---------------------------- */}
          <div className="space-y-3 border-t border-border pt-5">
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

            <label className="flex items-start gap-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={draft.deriveMissingPrices}
                disabled={!canWrite || busy}
                onChange={(event) => {
                  setDraft({ ...draft, deriveMissingPrices: event.target.checked });
                }}
                className="mt-0.5 h-4 w-4 rounded border-border-strong"
              />
              <span>
                {t('exchangeRates.deriveLabel')}
                <span className="mt-0.5 block text-xs text-ink-muted">
                  {t('exchangeRates.deriveHint')}
                </span>
              </span>
            </label>
          </div>

          {draft.deriveMissingPrices && (
            <Callout tone="info">{t('exchangeRates.deriveExplainer')}</Callout>
          )}

          {/* --- The arithmetic -------------------------------------------- */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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

          {/* --- How old a rate may be ------------------------------------- */}
          <div className="space-y-3 border-t border-border pt-5">
            <h3 className="text-sm font-medium text-ink">{t('exchangeRates.agesHeading')}</h3>
            <p className="text-xs text-ink-muted">{t('exchangeRates.agesHint')}</p>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field label={t('exchangeRates.alertAgeLabel')} hint={t('exchangeRates.alertAgeHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="numeric"
                    value={String(draft.alertMaxAgeHours)}
                    disabled={!canWrite || busy}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        alertMaxAgeHours: toHours(event.target.value, draft.alertMaxAgeHours),
                      });
                    }}
                  />
                )}
              </Field>

              <Field
                label={t('exchangeRates.checkoutAgeLabel')}
                hint={t('exchangeRates.checkoutAgeHint')}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="numeric"
                    value={String(draft.checkoutMaxAgeHours)}
                    disabled={!canWrite || busy}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        checkoutMaxAgeHours: toHours(event.target.value, draft.checkoutMaxAgeHours),
                      });
                    }}
                  />
                )}
              </Field>

              <Field
                label={t('exchangeRates.displayAgeLabel')}
                hint={t('exchangeRates.displayAgeHint')}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="numeric"
                    value={String(draft.displayMaxAgeHours)}
                    disabled={!canWrite || busy}
                    onChange={(event) => {
                      setDraft({
                        ...draft,
                        displayMaxAgeHours: toHours(event.target.value, draft.displayMaxAgeHours),
                      });
                    }}
                  />
                )}
              </Field>
            </div>

            {windowsOutOfOrder && (
              <Callout tone="danger">{t('exchangeRates.agesOutOfOrder')}</Callout>
            )}
          </div>

          {/* --- The run ---------------------------------------------------- */}
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
                  disabled={busy || (!draft.isEnabled && !draft.deriveMissingPrices)}
                  onClick={() => {
                    refresh.mutate();
                  }}
                >
                  {refresh.isPending ? t('exchangeRates.running') : t('exchangeRates.refreshNow')}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || windowsOutOfOrder}
                  onClick={() => {
                    save.mutate(draft);
                  }}
                >
                  {save.isPending ? t('exchangeRates.saving') : t('exchangeRates.save')}
                </Button>
              </div>
            )}
          </div>

          {/* --- What the feed has been sending ----------------------------- */}
          <div className="border-t border-border pt-5">
            <h3 className="text-sm font-medium text-ink">{t('exchangeRates.historyHeading')}</h3>
            <p className="mt-1 text-xs text-ink-muted">{t('exchangeRates.historyHint')}</p>

            {history.isPending && <LoadingState label={t('exchangeRates.historyLoading')} />}

            {history.data !== undefined && history.data.snapshots.length === 0 && (
              <p className="mt-3 text-sm text-ink-muted">{t('exchangeRates.historyEmpty')}</p>
            )}

            {history.data !== undefined && history.data.snapshots.length > 0 && (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[40rem] text-left text-xs">
                  <thead className="text-ink-muted">
                    <tr className="border-b border-border-subtle">
                      <th scope="col" className="py-2 pr-3 font-medium">
                        {t('exchangeRates.historyAsOf')}
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        {t('exchangeRates.historyFetched')}
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        {t('exchangeRates.historyOutcome')}
                      </th>
                      <th scope="col" className="py-2 pr-3 font-medium">
                        {t('exchangeRates.historyRates')}
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        {t('exchangeRates.historyDrift')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.data.snapshots.map((snapshot) => (
                      <tr key={snapshot.id} className="border-b border-border-subtle last:border-0">
                        <td className="py-2 pr-3 text-ink">
                          {new Date(snapshot.asOf).toLocaleDateString(intlLocale)}
                          {snapshot.isActive && (
                            <span className="ml-2 inline-block"><Badge tone="success">
                              {t('exchangeRates.historyLive')}</Badge></span>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-ink-muted">
                          {new Date(snapshot.fetchedAt).toLocaleString(intlLocale)}
                        </td>
                        <td className="py-2 pr-3">
                          {snapshot.validationStatus === 'VALID' ? (
                            <Badge tone="success">{t('exchangeRates.historyAccepted')}</Badge>
                          ) : (
                            <>
                              <Badge tone="danger">{t('exchangeRates.historyRefused')}</Badge>
                              {snapshot.failureReason !== null && (
                                <span className="mt-1 block text-ink-muted">
                                  {snapshot.failureReason}
                                </span>
                              )}
                            </>
                          )}
                        </td>
                        <td className="py-2 pr-3 text-ink-muted">
                          {snapshot.rateCount}
                          {snapshot.rejectedCount > 0 && (
                            <span className="text-danger">
                              {' '}
                              {t('exchangeRates.historyDropped', {
                                dropped: snapshot.rejectedCount,
                              })}
                            </span>
                          )}
                        </td>
                        <td className="py-2 text-ink-muted">
                          {snapshot.maxDriftPercent === null
                            ? '—'
                            : `${snapshot.maxDriftPercent}% ${snapshot.maxDriftCurrency ?? ''}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
