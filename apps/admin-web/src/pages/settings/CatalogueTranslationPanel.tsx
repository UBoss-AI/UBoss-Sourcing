/**
 * Machine-translating the shop's own product copy.
 *
 * The interface ships translated; a shop's catalogue cannot. Twenty products
 * across seven languages is a hundred and forty pieces of copy, and the reason
 * multilingual storefronts still show English product names is that nobody
 * types them. This does it from here.
 *
 * The key is write-only. It goes to the server, is encrypted at rest, and only
 * its last four characters ever come back — so this panel can say *which* key
 * is stored without being able to show it, and a screen-share of the settings
 * page does not leak a billable credential.
 *
 * Estimate before translating, because the provider bills per character and a
 * number is more honest than a promise. Both buttons call the same endpoint;
 * one of them just does not send anything.
 */
import { useState } from 'react';
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
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

type RunStatus = 'ok' | 'skipped' | 'failed';

interface Settings {
  hasApiKey: boolean;
  apiKeyHint: string | null;
  isRunning: boolean;
  lastRunAt: string | null;
  lastRunStatus: RunStatus | null;
  lastRunMessage: string | null;
  lastRunTranslated: number;
}

interface CoverageRow {
  language: string;
  products: number;
  categories: number;
}

interface RunResult {
  status: RunStatus;
  message: string;
  translated: number;
  remaining: number;
  characters: number;
}

interface Response {
  settings: Settings;
  coverage: CoverageRow[];
}

const STATUS_TONES: Record<RunStatus, BadgeTone> = {
  ok: 'success',
  skipped: 'neutral',
  failed: 'danger',
};

export function CatalogueTranslationPanel(): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  const queryClient = useQueryClient();
  const toast = useToast();
  const { can } = useSession();

  const [apiKey, setApiKey] = useState('');
  const [estimate, setEstimate] = useState<RunResult | null>(null);

  const query = useQuery({
    queryKey: ['catalogue-translation'],
    queryFn: () => api.get<Response>('/admin/settings/catalogue-translation'),
  });

  const saveKey = useMutation({
    mutationFn: (key: string | null) =>
      api.put<{ settings: Settings }>('/admin/settings/catalogue-translation', { apiKey: key }),
    onSuccess: async (_data, key) => {
      setApiKey('');
      toast.success(key === null ? t('catalogueTranslation.keyRemoved') : t('catalogueTranslation.keySaved'));
      await queryClient.invalidateQueries({ queryKey: ['catalogue-translation'] });
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('catalogueTranslation.keyFailed'));
    },
  });

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<{ result: RunResult } & Response>('/admin/settings/catalogue-translation/run', {
        dryRun,
        overwrite: false,
      }),
    onSuccess: async ({ result }, dryRun) => {
      if (dryRun) {
        setEstimate(result);
        return;
      }

      setEstimate(null);

      // Product copy has changed everywhere it is read.
      await queryClient.invalidateQueries();

      if (result.status === 'failed') {
        toast.error(result.message);
        return;
      }

      toast.success(result.message);
    },
    onError: (error) => {
      toast.error(error instanceof ApiError ? error.message : t('catalogueTranslation.runFailed'));
    },
  });

  const canWrite = can(Permission.SETTINGS_WRITE);
  const settings = query.data?.settings ?? null;
  const coverage = query.data?.coverage ?? [];
  const outstanding = coverage.reduce((total, row) => total + row.products + row.categories, 0);
  const busy = saveKey.isPending || run.isPending;

  return (
    <Card
      title={t('catalogueTranslation.title')}
      description={t('catalogueTranslation.description')}
    >
      {query.isPending && <LoadingState label={t('catalogueTranslation.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {settings !== null && (
        <div className="space-y-5">
          <Callout tone="info">{t('catalogueTranslation.howItWorks')}</Callout>

          <Field
            label={t('catalogueTranslation.keyLabel')}
            hint={
              settings.hasApiKey
                ? t('catalogueTranslation.keyStored', { hint: settings.apiKeyHint ?? '' })
                : t('catalogueTranslation.keyHint')
            }
          >
            {({ inputId, describedBy }) => (
              <div className="flex gap-2">
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="password"
                  autoComplete="off"
                  placeholder={settings.hasApiKey ? '••••••••' : 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx'}
                  value={apiKey}
                  disabled={!canWrite || busy}
                  onChange={(event) => {
                    setApiKey(event.target.value);
                  }}
                />
                {canWrite && (
                  <>
                    <Button
                      variant="secondary"
                      disabled={busy || apiKey.trim() === ''}
                      onClick={() => {
                        saveKey.mutate(apiKey.trim());
                      }}
                    >
                      {t('catalogueTranslation.saveKey')}
                    </Button>
                    {settings.hasApiKey && (
                      <Button
                        variant="secondary"
                        disabled={busy}
                        onClick={() => {
                          saveKey.mutate(null);
                        }}
                      >
                        {t('catalogueTranslation.removeKey')}
                      </Button>
                    )}
                  </>
                )}
              </div>
            )}
          </Field>

          <div>
            <p className="mb-2 text-sm font-medium text-ink">
              {t('catalogueTranslation.coverage')}
            </p>

            {outstanding === 0 ? (
              <p className="text-sm text-ink-muted">{t('catalogueTranslation.allTranslated')}</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {coverage.map((row) => (
                  <li key={row.language}>
                    <Badge tone={row.products + row.categories === 0 ? 'success' : 'warning'}>
                      {row.language.toUpperCase()}{' '}
                      {row.products + row.categories === 0
                        ? t('catalogueTranslation.complete')
                        : t('catalogueTranslation.missing', {
                            count: row.products + row.categories,
                          })}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {estimate !== null && (
            <Callout tone="warning" title={t('catalogueTranslation.estimateTitle')}>
              {t('catalogueTranslation.estimateBody', {
                rows: estimate.translated,
                characters: estimate.characters.toLocaleString(intlLocale),
              })}
            </Callout>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-xs text-ink-muted">
              {settings.lastRunAt === null ? (
                t('catalogueTranslation.neverRun')
              ) : (
                <>
                  <Badge tone={STATUS_TONES[settings.lastRunStatus ?? 'skipped']}>
                    {t(`exchangeRates.status.${settings.lastRunStatus ?? 'skipped'}`)}
                  </Badge>{' '}
                  {t('exchangeRates.lastRun', {
                    when: new Date(settings.lastRunAt).toLocaleString(intlLocale),
                  })}
                  <span className="block">{settings.lastRunMessage}</span>
                </>
              )}
            </p>

            {canWrite && settings.hasApiKey && (
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={busy || outstanding === 0}
                  onClick={() => {
                    run.mutate(true);
                  }}
                >
                  {t('catalogueTranslation.estimate')}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || outstanding === 0}
                  onClick={() => {
                    run.mutate(false);
                  }}
                >
                  {run.isPending && !run.variables
                    ? t('catalogueTranslation.translating')
                    : t('catalogueTranslation.translate')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
