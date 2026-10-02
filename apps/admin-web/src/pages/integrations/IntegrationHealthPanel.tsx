/**
 * The integration monitor (JOURNEY-065).
 *
 * One card per outside connection the member of staff may see, with its
 * status, the facts behind it, when its webhooks last arrived and how many
 * were accepted and refused in the last day - and the action that deals with
 * each kind of trouble: retry the carrier dead-letter queue, open the dead
 * jobs and failed notifications, reconcile payments by hand.
 *
 * Inspection has no outside API: agencies work in the in-app portal, so its
 * health is the portal's own service level, and the card says so.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, ErrorState, LoadingState } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  INTEGRATION_HEALTH_KEY,
  fetchIntegrationHealth,
  healthTone,
  type IntegrationSource,
  type IntegrationSourceKey,
} from '@/lib/integration-health';
import { Permission } from '@/lib/permissions';

function SourceCard({ source }: { source: IntegrationSource }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const requeue = useMutation({
    mutationFn: () => api.post<{ requeued: number }>('/admin/integrations/carrier-webhooks/requeue', {}),
    onSuccess: async (result) => {
      toast.success(t('integrationHealth.requeued', { requeued: formatNumber(result.requeued) }));
      await queryClient.invalidateQueries({ queryKey: INTEGRATION_HEALTH_KEY });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const facts = Object.entries(source.facts).filter(([, value]) => value !== null);

  return (
    <li className="rounded-lg border border-border-subtle p-4" aria-label={t(`integrationHealth.source.${source.key}` as TranslationKey)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={source.href} className="font-medium text-ink underline-offset-2 hover:underline">
          {t(`integrationHealth.source.${source.key}` as TranslationKey)}
        </Link>
        <Badge dot tone={healthTone(source.status)}>
          {t(`integrationHealth.status.${source.status}` as TranslationKey)}
        </Badge>
      </div>

      {facts.length > 0 && (
        <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xxs">
          {facts.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="text-ink-muted">{t(`integrationHealth.fact.${key}` as TranslationKey)}</dt>
              <dd className="text-right font-medium tabular-nums text-ink">
                {typeof value === 'number' ? formatNumber(value) : key.endsWith('At') ? formatDateTime(value) : value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {source.webhooks === null ? (
        source.key === 'inspection' && <p className="mt-2 text-xxs text-ink-muted">{t('integrationHealth.inspectionNote')}</p>
      ) : (
        <p className="mt-2 text-xxs text-ink-muted">
          {t('integrationHealth.webhooks', {
            last: source.webhooks.lastReceivedAt === null ? t('integrationHealth.never') : formatDateTime(source.webhooks.lastReceivedAt),
            accepted: formatNumber(source.webhooks.accepted24h),
            rejected: formatNumber(source.webhooks.rejected24h),
          })}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        {source.key === 'payments' && (
          <Link className="text-xxs font-medium text-accent underline" to="/payments?state=unreconciled">
            {t('integrationHealth.reconcile')}
          </Link>
        )}
        {source.key === 'carriers' && can(Permission.LOGISTICS_INTEGRATION_WRITE) && Number(source.facts.deadLetters ?? 0) > 0 && (
          <Button
            size="sm"
            variant="secondary"
            isLoading={requeue.isPending}
            onClick={() => {
              requeue.mutate();
            }}
          >
            {t('integrationHealth.requeue')}
          </Button>
        )}
        {(source.key === 'warehouseErp' || source.key === 'customerErp') && (
          <Link className="text-xxs font-medium text-accent underline" to={source.href}>
            {t('integrationHealth.openConnections')}
          </Link>
        )}
      </div>
    </li>
  );
}

export function IntegrationHealthPanel({ only }: { only?: IntegrationSourceKey[] }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const query = useQuery({
    queryKey: INTEGRATION_HEALTH_KEY,
    queryFn: fetchIntegrationHealth,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });

  const sources = (query.data?.sources ?? []).filter((source) => only === undefined || only.includes(source.key));

  return (
    <Card
      title={t('integrationHealth.title')}
      description={t('integrationHealth.description')}
      actions={
        can(Permission.SETTINGS_READ) ? (
          <span className="flex gap-3 text-xxs">
            <Link className="underline" to="/operations/dead-jobs">
              {t('integrationHealth.deadJobs')}
            </Link>
            <Link className="underline" to="/operations/failed-notifications">
              {t('integrationHealth.failedNotifications')}
            </Link>
          </span>
        ) : undefined
      }
    >
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <ul className="grid gap-3 px-5 pb-5 md:grid-cols-2 xl:grid-cols-3">
          {sources.map((source) => (
            <SourceCard key={source.key} source={source} />
          ))}
        </ul>
      )}
    </Card>
  );
}
