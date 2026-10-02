/**
 * The admin outage banner (JOURNEY-065).
 *
 * Shown on every screen while an integration the member of staff can see is
 * down, or while payments are degraded: the two states where they should
 * expect customers to be affected and should not start chasing the symptom
 * one order at a time. It links to the integration monitor.
 *
 * Asked once a minute, and only while the tab is visible. A failed read shows
 * nothing: a banner that cries outage because its own request failed is
 * worse than none.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { INTEGRATION_HEALTH_KEY, fetchIntegrationHealth } from '@/lib/integration-health';

export function OutageBanner(): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: INTEGRATION_HEALTH_KEY,
    queryFn: fetchIntegrationHealth,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    retry: false,
  });

  const outage = query.data?.outage;
  if (outage === undefined || !outage.active) return null;

  const names = outage.sources.map((key) => t(`integrationHealth.source.${key}` as TranslationKey)).join(', ');

  return (
    <div role="alert" className="border-b border-danger/30 bg-danger-soft px-4 py-2 text-sm text-ink lg:px-6">
      <span className="font-medium text-danger">{t('integrationHealth.outageTitle')}</span>{' '}
      {t('integrationHealth.outageBody', { sources: names })}{' '}
      <Link to="/integrations" className="font-medium underline underline-offset-2">
        {t('integrationHealth.openMonitor')}
      </Link>
    </div>
  );
}
