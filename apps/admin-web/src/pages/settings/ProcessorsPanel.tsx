/**
 * Who this deployment shares data with, read from the configuration.
 *
 * GDPR Art. 30(1)(d) asks a controller to record the categories of recipient
 * their data goes to. That record is normally a document somebody wrote
 * eighteen months ago — and the trouble with it is that it is a claim about
 * configuration, kept somewhere configuration cannot reach. Somebody sets an
 * AI key to try the chat widget, visitors' questions start going to a third
 * country, and the register still says the only processor is the payment
 * gateway.
 *
 * So this panel is not a list anyone maintains. Every row is derived from the
 * environment, and says which setting switches it on.
 *
 * Two display decisions carry the weight:
 *
 *   - **Inactive recipients are shown too**, greyed rather than hidden. The
 *     point of the screen is that it can be read side by side with a register,
 *     and a row that vanishes when it is switched off is a row nobody can
 *     confirm the absence of.
 *
 *   - **The transfer count excludes anything carrying no personal data.** The
 *     exchange-rate feed is a third-country call that sends currency codes.
 *     Counting it would put a harmless entry at the top of the Art. 44 list
 *     and teach whoever reads that list to skim it.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Callout, Card, ErrorState, LoadingState } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';

interface ProcessorEntry {
  key: string;
  name: string;
  purpose: string;
  dataShared: string;
  /** ISO alpha-2, 'SELF_HOSTED', or 'UNKNOWN' where the setting is a URL. */
  location: string;
  carriesPersonalData: boolean;
  outsideEea: boolean;
  configuredBy: string;
  active: boolean;
  note?: string;
}

interface ProcessorReport {
  generatedAt: string;
  entries: ProcessorEntry[];
  transfersOutsideEea: number;
}

function LocationBadge({ entry }: { entry: ProcessorEntry }): React.JSX.Element {
  const { t } = useI18n();

  if (entry.location === 'SELF_HOSTED') {
    return <Badge tone="neutral">{t('processors.selfHosted')}</Badge>;
  }

  if (entry.location === 'UNKNOWN') {
    // Not "probably fine". A URL pointed somewhere this cannot resolve is
    // exactly the case that needs a person to look.
    return <Badge tone="warning">{t('processors.unknownLocation')}</Badge>;
  }

  return (
    <Badge tone={entry.outsideEea ? 'warning' : 'success'}>
      {entry.location}
      {entry.outsideEea ? ` · ${t('processors.outsideEea')}` : ''}
    </Badge>
  );
}

export function ProcessorsPanel(): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({
    queryKey: ['processors'],
    queryFn: () => api.get<ProcessorReport>('/admin/settings/processors'),
  });

  if (query.isPending) {
    return (
      <Card title={t('processors.title')}>
        <LoadingState label={t('processors.loading')} />
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card title={t('processors.title')}>
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </Card>
    );
  }

  const report = query.data;

  return (
    <Card title={t('processors.title')} description={t('processors.description')}>
      <div className="space-y-4 px-5 py-4">
        {report.transfersOutsideEea > 0 && (
          <Callout tone="warning" title={t('processors.transfersTitle')}>
            {t('processors.transfersBody', { count: report.transfersOutsideEea })}
          </Callout>
        )}

        {/* Said plainly rather than left to be discovered. A register that
            claims completeness it does not have is worse than one that names
            its own edges. */}
        <Callout tone="neutral" title={t('processors.limitsTitle')}>
          {t('processors.limitsBody')}
        </Callout>

        <ul className="divide-y divide-border-subtle">
          {report.entries.map((entry) => (
            <li
              key={entry.key}
              // Inactive rows stay, dimmed. The screen is meant to be read
              // beside a register, and a row that disappears when switched off
              // is an absence nobody can confirm.
              className={entry.active ? 'py-4' : 'py-4 opacity-60'}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-ink">{entry.name}</p>
                    <Badge tone={entry.active ? 'success' : 'neutral'}>
                      {entry.active ? t('processors.active') : t('processors.notConfigured')}
                    </Badge>
                    {entry.active && <LocationBadge entry={entry} />}
                    {!entry.carriesPersonalData && (
                      <Badge tone="neutral">{t('processors.noPersonalData')}</Badge>
                    )}
                  </div>

                  <p className="mt-1 text-sm text-ink-muted">{entry.purpose}</p>
                </div>

                <p className="shrink-0 font-mono text-xxs text-ink-subtle">{entry.configuredBy}</p>
              </div>

              <dl className="mt-2 text-sm">
                <dt className="text-xxs uppercase tracking-wide text-ink-subtle">
                  {t('processors.dataShared')}
                </dt>
                <dd className="mt-0.5 text-ink-muted">{entry.dataShared}</dd>
              </dl>

              {entry.note !== undefined && (
                <p className="mt-2 rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
                  {entry.note}
                </p>
              )}
            </li>
          ))}
        </ul>

        <p className="text-xxs text-ink-subtle">
          {t('processors.generatedAt', { when: formatDateTime(report.generatedAt) })}
        </p>
      </div>
    </Card>
  );
}
