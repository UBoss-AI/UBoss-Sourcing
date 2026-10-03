/** The escalated alerts above the list and the bundled low-priority news below it (ENH-020). */
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import type { LowBundle, UrgentAlert } from '@/lib/notification-bundles';

export function UrgentAlerts({ urgent }: { urgent: UrgentAlert[] }): React.JSX.Element | null {
  const { t } = useI18n();
  if (urgent.length === 0) return null;
  return (
    <section aria-labelledby="urgent-alerts" role="alert" className="mb-4 rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm">
      <h2 id="urgent-alerts" className="font-semibold">{t('notifications.urgent.title')}</h2>
      <ul className="mt-2 space-y-2">
        {urgent.map(({ entry, count }) => (
          <li key={entry.id} className="flex flex-wrap items-center gap-2">
            {entry.escalation == null ? null : <Badge tone="danger">{t(`notifications.escalation.${entry.escalation}`)}</Badge>}
            {entry.link == null ? <span className="font-medium">{entry.subject}</span> : <Link to={entry.link} className="font-medium text-brand hover:underline">{entry.subject}</Link>}
            {count > 1 ? <span className="text-ink-muted">{t('notifications.urgent.repeat', { times: String(count) })}</span> : null}
            {entry.sentAt === null ? null : <span className="text-xs text-ink-muted">{formatDateTime(entry.sentAt)}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LowBundles({ bundles }: { bundles: LowBundle[] }): React.JSX.Element | null {
  const { t } = useI18n();
  if (bundles.length === 0) return null;
  return (
    <div className="mt-4 space-y-2">
      {bundles.map((bundle) => (
        <details key={bundle.family} className="rounded-lg border border-border-subtle p-3 text-sm">
          <summary className="cursor-pointer font-medium">{t('notifications.bundle.summary', { updates: String(bundle.entries.length) })}</summary>
          <ul className="mt-2 space-y-1">
            {bundle.entries.map((entry) => (
              <li key={entry.id}>
                {entry.link == null ? entry.subject : <Link to={entry.link} className="text-brand hover:underline">{entry.subject}</Link>}
              </li>
            ))}
          </ul>
        </details>
      ))}
    </div>
  );
}
