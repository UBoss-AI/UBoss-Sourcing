/**
 * This carrier's own coverage, fleet and integration health.
 *
 * THE SCOPED HALF OF A SPLIT, and worth saying plainly because the absence is
 * the design. The marketplace operator has a catalogue listing every provider
 * and every delivery company across every seller. This screen deliberately is
 * not that, and cannot become it.
 *
 * The portal's tenant is one carrier. Its id comes from the session and from
 * nowhere else - the endpoint behind this page takes no parameter at all, so
 * there is nothing a request could carry that would point it at another
 * company. A page here showing the count of other carriers, their sellers or
 * their integration health would cross the boundary the whole portal is built
 * to hold.
 *
 * So: everything below is this company's own. Who it works for, where it
 * covers, what it is approved to carry, how many drivers it has on, and
 * whether the interface its consignments are tracked through is working.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatRelative } from '@/lib/format';
import { fetchOwnIntegration, type OwnIntegration } from '@/lib/logistics';

export function IntegrationPage(): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({
    queryKey: ['logistics', 'integration'],
    queryFn: fetchOwnIntegration,
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('integration.title')}
        description={t('integration.description')}
      />

      {query.isPending && <LoadingState label={t('integration.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.data !== undefined && <IntegrationBody integration={query.data.integration} />}
    </div>
  );
}

function IntegrationBody({ integration }: { integration: OwnIntegration }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="space-y-5">
      {/* --- Who we are --------------------------------------------------- */}
      <Card title={t('integration.companyTitle')}>
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2 xl:grid-cols-4">
          <Fact label={t('integration.code')} value={integration.partnerCode} />
          <Fact label={t('integration.name')} value={integration.displayName} />
          <Fact
            label={t('integration.status')}
            value={integration.status}
            tone={integration.status === 'ACTIVE' ? 'success' : 'warning'}
          />
          <Fact
            label={t('integration.kind')}
            value={t(`integration.kind.${integration.partnerKind}`)}
          />
        </div>
      </Card>

      {/* --- The interface ------------------------------------------------ */}
      <Card title={t('integration.trackingTitle')} description={t('integration.trackingBody')}>
        <div className="px-6 py-5">
          {integration.provider === null ? (
            /*
              No integration at all is the ORDINARY case, not a fault.
              A carrier working inside this portal types its own events; there
              is nothing to connect, and a red "not configured" here would
              tell most carriers they had a problem they do not have.
            */
            <p className="text-sm leading-relaxed text-ink-muted">
              {t('integration.noneBody')}
            </p>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-ink">{integration.provider}</p>
                <Badge
                  tone={
                    integration.integrationState === 'ACTIVE'
                      ? 'success'
                      : integration.integrationState === 'ERROR'
                        ? 'danger'
                        : 'neutral'
                  }
                >
                  {integration.integrationState ?? t('integration.unknown')}
                </Badge>
              </div>

              <dl className="space-y-1.5 border-t border-border-subtle pt-3 text-xxs">
                <Row
                  label={t('integration.lastSuccess')}
                  value={
                    integration.lastSuccessAt === null
                      ? t('integration.never')
                      : formatRelative(integration.lastSuccessAt)
                  }
                />
                <Row
                  label={t('integration.lastFailure')}
                  value={
                    integration.lastFailureAt === null
                      ? t('integration.never')
                      : formatRelative(integration.lastFailureAt)
                  }
                />
              </dl>

              {/*
                Read-only, and it says so. The credentials behind an
                integration are rotated by the marketplace, not here - a
                carrier that could change them could point its own feed
                somewhere else.
              */}
              <p className="text-xxs text-ink-subtle">{t('integration.readOnly')}</p>
            </div>
          )}
        </div>
      </Card>

      {/* --- What we carry, and where ------------------------------------- */}
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t('integration.coverageTitle')}>
          <div className="px-6 py-5">
            {integration.serviceCountries.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('integration.noCoverage')}</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {integration.serviceCountries.map((country) => (
                  <Badge key={country} tone="neutral">
                    {country}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card title={t('integration.capabilitiesTitle')}>
          <div className="px-6 py-5">
            {integration.capabilities.length === 0 ? (
              <p className="text-sm text-ink-muted">{t('integration.noCapabilities')}</p>
            ) : (
              <ul className="space-y-2">
                {integration.capabilities.map((capability) => (
                  <li
                    key={capability.kind}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span className="text-ink">{capability.kind}</span>
                    {/*
                      Approved is the only state that means anything
                      operationally. A requested or suspended capability is
                      shown so the carrier knows where it stands, and is
                      visibly not the same thing.
                    */}
                    <Badge tone={capability.state === 'APPROVED' ? 'success' : 'warning'}>
                      {capability.state}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>
      </div>

      {/* --- Today --------------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t('integration.activeDrivers')} value={integration.activeDrivers} />
        <Stat label={t('integration.carrying')} value={integration.activeShipments} />
        <Stat
          label={t('integration.openProblems')}
          value={integration.openExceptions}
          alert={integration.openExceptions > 0}
        />
      </div>

      {/* --- Who we work for ----------------------------------------------- */}
      <Card title={t('integration.sellersTitle')} description={t('integration.sellersBody')}>
        <div className="px-6 py-5">
          {integration.sellerNames.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('integration.noSellers')}</p>
          ) : (
            <ul className="space-y-1.5">
              {integration.sellerNames.map((name) => (
                <li key={name} className="text-sm text-ink">
                  {name}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function Fact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'success' | 'warning';
}): React.JSX.Element {
  return (
    <div>
      <p className="text-xxs uppercase tracking-wide text-ink-subtle">{label}</p>
      {tone === undefined ? (
        <p className="mt-1 text-sm font-medium text-ink">{value}</p>
      ) : (
        <p className="mt-1">
          <Badge tone={tone}>{value}</Badge>
        </p>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

function Stat({
  label,
  value,
  alert,
}: {
  label: string;
  value: number;
  alert?: boolean;
}): React.JSX.Element {
  return (
    <div
      className={cx(
        'rounded-xl border bg-surface px-4 py-3',
        alert === true && value > 0 ? 'border-danger/40 bg-danger-soft/30' : 'border-border',
      )}
    >
      <p className="text-xxs uppercase tracking-wide text-ink-subtle">{label}</p>
      <p
        className={cx(
          'mt-1 text-title-sm tabular-nums',
          alert === true && value > 0 ? 'text-danger' : 'text-ink',
        )}
      >
        {value}
      </p>
    </div>
  );
}
