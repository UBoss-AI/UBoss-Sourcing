/**
 * Go-live check for reference data (LIVE-019).
 *
 * One row per master list the marketplace needs - categories, currencies and
 * rates, tax classes, countries, delivery prices, inspection rules, legal
 * documents, units and defect codes - each marked present, missing (a flow
 * breaks without it) or advised (part of the marketplace will be empty). A
 * second list names anything the demonstration seed left behind. Read-only:
 * each list is fixed on its own screen.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, LoadingState } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';

export interface MasterDataReadiness {
  generatedAt: string;
  ready: boolean;
  missingRequired: number;
  checks: { key: string; required: boolean; status: 'OK' | 'MISSING' | 'WARNING'; count: number }[];
  demo: { key: string; count: number }[];
}

export function MasterDataReadinessCard(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['master-data', 'readiness'],
    queryFn: () => api.get<MasterDataReadiness>('/admin/master-data-readiness'),
    retry: false,
  });

  const label = (key: string): string => t(`readiness.check.${key}` as TranslationKey, { defaultValue: key });
  const demoLabel = (key: string): string => t(`readiness.demo.${key}` as TranslationKey, { defaultValue: key });
  const leftovers = query.data?.demo.filter((entry) => entry.count > 0) ?? [];

  return (
    <Card title={t('readiness.title')} description={t('readiness.description')}>
      {query.isPending ? (
        <div className="px-5 py-4">
          <LoadingState label={t('readiness.loading')} />
        </div>
      ) : query.isError ? (
        <div className="px-5 py-4">
          <ErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        </div>
      ) : (
        <div className="space-y-4 px-5 py-4">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            {query.data.ready ? (
              <Badge tone="success">{t('readiness.ready')}</Badge>
            ) : (
              <Badge tone="warning">{t('readiness.notReady')}</Badge>
            )}
            <span className="text-ink-muted">
              {t('readiness.missingCount', { missing: formatNumber(query.data.missingRequired) })}
            </span>
          </div>

          <ul className="grid gap-2 sm:grid-cols-2">
            {query.data.checks.map((entry) => (
              <li key={entry.key} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <span className="text-ink">
                  {label(entry.key)}
                  {!entry.required && <span className="ml-1 text-xs text-ink-subtle">{t('readiness.advised')}</span>}
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular text-ink-muted">{formatNumber(entry.count)}</span>
                  <Badge tone={entry.status === 'OK' ? 'success' : entry.status === 'MISSING' ? 'danger' : 'warning'}>
                    {t(`readiness.status.${entry.status}`)}
                  </Badge>
                </span>
              </li>
            ))}
          </ul>

          <div>
            <h3 className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{t('readiness.demoTitle')}</h3>
            {leftovers.length === 0 ? (
              <p className="mt-2 text-sm text-ink-muted">{t('readiness.noDemo')}</p>
            ) : (
              <ul className="mt-2 space-y-1 text-sm">
                {leftovers.map((entry) => (
                  <li key={entry.key} className="flex items-center gap-2">
                    <Badge tone="warning">{formatNumber(entry.count)}</Badge>
                    <span className="text-ink">{demoLabel(entry.key)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
