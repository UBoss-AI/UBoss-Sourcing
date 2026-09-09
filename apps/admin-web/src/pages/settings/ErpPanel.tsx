/**
 * Settings -> ERP, as a summary on the Settings page.
 *
 * Deliberately thin. The editor is thirty fields and a mapping table, which is
 * its own page; what belongs here is the one line somebody scrolling Settings
 * needs - is there a connection, is it carrying traffic, and when did it last
 * work - plus the way in.
 *
 * It renders nothing at all when the feature is off. A panel that says "ERP is
 * not enabled" on every installation that will never use one is noise on the
 * screen where the actual settings live.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, LinkButton } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
import { erpApi, erpKeys, type ErpConnectionStatus } from '@/lib/erp';
import { useI18n } from '@/i18n/i18n-context';

function tone(status: ErpConnectionStatus): 'success' | 'operational' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'ACTIVE':
      return 'success';
    case 'CONNECTED':
    case 'TESTING':
      return 'operational';
    case 'PAUSED':
      return 'warning';
    case 'ERROR':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function ErpPanel(): React.JSX.Element | null {
  const { t } = useI18n();

  const capabilities = useQuery({
    queryKey: erpKeys.capabilities,
    queryFn: () => erpApi.capabilities(),
  });

  const connections = useQuery({
    queryKey: erpKeys.connections,
    queryFn: () => erpApi.listConnections(),
    enabled: capabilities.data?.erpIntegration === true,
  });

  // Silent while unknown, and silent when off - see the header.
  if (capabilities.data?.erpIntegration !== true) return null;

  const rows = connections.data ?? [];

  return (
    <Card
      title={t('erp.heading')}
      description={t('erp.panelDescription')}
      actions={
        <LinkButton to="/settings/erp" variant={rows.length === 0 ? 'primary' : 'secondary'}>
          {rows.length === 0 ? t('erp.setUpConnection') : t('erp.manageConnection')}
        </LinkButton>
      }
      bodyClassName="px-5 py-4"
    >
      {rows.length === 0 ? (
        <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
          {t('erp.panelNothingYet')}
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((connection) => (
            <li key={connection.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span className="font-medium text-ink">{connection.name}</span>
              <Badge tone={tone(connection.status)} dot>
                {t(`erp.status.${connection.status}`)}
              </Badge>
              <span className="text-xs text-ink-muted">
                {t('erp.lastSuccessfulSync')}: {formatDateTime(connection.lastSyncSuccessAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
