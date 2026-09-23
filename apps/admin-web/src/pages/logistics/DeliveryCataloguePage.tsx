/**
 * Every way anything gets delivered on this installation.
 *
 * The operator's view across every tenant: which providers exist, which
 * delivery companies are carrying work, which sellers have connected what, and
 * which of it needs somebody to do something.
 *
 * WHY THIS IS HERE AND NOT IN THE LOGISTICS PORTAL
 *
 * It was specified as a portal page and it cannot be one. The portal's tenant
 * is a single carrier, and a page showing one carrier the count of other
 * carriers, their linked sellers and their integration health crosses exactly
 * the boundary the portal is built to hold. Everything on this screen is
 * operator information, so it lives with the operator; a carrier sees its own
 * at Portal → Integration.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * Any credential. The operator sees whether a seller's carrier account is
 * working, when it last worked, and the sanitised message from when it did
 * not. They do not see the key, and the endpoint behind this screen has no
 * field that could carry one - a marketplace holding its sellers' carrier keys
 * is what storing them per seller exists to prevent.
 *
 * NO CARRIER LOGOS. Text and the panel's own neutral treatment until somebody
 * confirms permitted use of the marks; a logo is a trademark and shipping one
 * is the deployment owner's decision, not this file's.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DataTable } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Card,
  PageHeader,
  Toolbar,
  ToolbarField,
  Select,
  Input,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatRelative } from '@/lib/format';
import {
  fetchCataloguePartners,
  fetchDeliveryCatalogue,
  partnerKindKey,
  type CataloguePartnerRow,
  type ConnectionHealthRow,
  type ProviderCard,
} from '@/lib/logistics';

export function DeliveryCataloguePage(): React.JSX.Element {
  const { t } = useI18n();

  const [failingOnly, setFailingOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');

  const catalogue = useQuery({
    queryKey: ['logistics', 'delivery-catalogue', failingOnly],
    queryFn: () => fetchDeliveryCatalogue(failingOnly),
  });

  const params = new URLSearchParams();
  if (search.trim().length > 0) params.set('search', search.trim());
  if (kind.length > 0) params.set('partnerKind', kind);
  if (status.length > 0) params.set('status', status);

  const partners = useQuery({
    queryKey: ['logistics', 'catalogue-partners', params.toString()],
    queryFn: () => fetchCataloguePartners(params),
  });

  const summary = catalogue.data?.summary;

  const partnerColumns: Column<CataloguePartnerRow>[] = [
    {
      key: 'name',
      header: t('deliveryCatalogue.column.partner'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-ink">{row.displayName}</p>
          <p className="mt-0.5 text-xxs text-ink-subtle">
            {row.partnerCode} · {t(partnerKindKey(row.partnerKind))}
          </p>
        </div>
      ),
    },
    {
      key: 'owner',
      header: t('deliveryCatalogue.column.sellers'),
      secondary: true,
      render: (row) => {
        // The owner first, because for the two seller-scoped kinds it is the
        // whole point: this company belongs to that business.
        const names =
          row.ownerSellerName !== null
            ? [row.ownerSellerName, ...row.linkedSellerNames]
            : row.linkedSellerNames;

        return names.length === 0 ? (
          <span className="text-ink-subtle">{t('deliveryCatalogue.noSellers')}</span>
        ) : (
          <span className="text-xs text-ink-muted">{[...new Set(names)].join(', ')}</span>
        );
      },
    },
    {
      key: 'status',
      header: t('deliveryCatalogue.column.status'),
      align: 'center',
      render: (row) => (
        <Badge tone={row.status === 'ACTIVE' ? 'success' : row.status === 'SUSPENDED' ? 'danger' : 'neutral'}>
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'countries',
      header: t('deliveryCatalogue.column.covers'),
      secondary: true,
      render: (row) =>
        row.serviceCountries.length === 0 ? (
          <span className="text-ink-subtle">{row.registrationCountry}</span>
        ) : (
          <span className="text-xs text-ink-muted">{row.serviceCountries.join(' ')}</span>
        ),
    },
    {
      key: 'drivers',
      header: t('deliveryCatalogue.column.drivers'),
      align: 'right',
      secondary: true,
      render: (row) => row.activeDrivers,
    },
    {
      key: 'shipments',
      header: t('deliveryCatalogue.column.carrying'),
      align: 'right',
      render: (row) => row.activeShipments,
    },
    {
      key: 'exceptions',
      header: t('deliveryCatalogue.column.problems'),
      align: 'right',
      render: (row) => (
        <span className={cx(row.openExceptions > 0 && 'font-semibold text-danger')}>
          {row.openExceptions}
        </span>
      ),
    },
    {
      key: 'activity',
      header: t('deliveryCatalogue.column.lastActivity'),
      secondary: true,
      render: (row) =>
        row.lastActivityAt === null ? (
          <span className="text-ink-subtle">{t('deliveryCatalogue.never')}</span>
        ) : (
          formatRelative(row.lastActivityAt)
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('deliveryCatalogue.title')}
        description={t('deliveryCatalogue.description')}
      />

      {/* --- The counters -------------------------------------------------- */}
      {summary !== undefined && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat label={t('deliveryCatalogue.stat.activePartners')} value={summary.activePartners} />
          <Stat
            label={t('deliveryCatalogue.stat.selfManaged')}
            value={summary.selfManagedOrganisations}
          />
          <Stat
            label={t('deliveryCatalogue.stat.dedicated')}
            value={summary.dedicatedPartners}
          />
          <Stat
            label={t('deliveryCatalogue.stat.liveConnections')}
            value={summary.liveCarrierConnections}
          />

          {/*
            The four that are queues or faults are drawn as alerts when they
            are not zero. A dashboard where everything looks the same is one
            people stop reading.
          */}
          <Stat
            label={t('deliveryCatalogue.stat.methodsWaiting')}
            value={summary.methodsAwaitingApproval}
            alert={summary.methodsAwaitingApproval > 0}
          />
          <Stat
            label={t('deliveryCatalogue.stat.arrangementsWaiting')}
            value={summary.arrangementsAwaitingApproval}
            alert={summary.arrangementsAwaitingApproval > 0}
          />
          <Stat
            label={t('deliveryCatalogue.stat.failing')}
            value={summary.failingConnections}
            alert={summary.failingConnections > 0}
          />
          <Stat
            label={t('deliveryCatalogue.stat.unassigned')}
            value={summary.unassignedShipments}
            alert={summary.unassignedShipments > 0}
          />
        </div>
      )}

      {/* --- The providers ------------------------------------------------- */}
      <Card
        title={t('deliveryCatalogue.providersTitle')}
        description={t('deliveryCatalogue.providersBody')}
      >
        <div className="grid gap-4 px-6 py-5 sm:grid-cols-2 xl:grid-cols-3">
          {(catalogue.data?.providers ?? []).map((provider) => (
            <ProviderPanel key={provider.provider} provider={provider} />
          ))}
        </div>
      </Card>

      {/* --- The partners -------------------------------------------------- */}
      <div className="space-y-3">
        <Toolbar>
          <ToolbarField label={t('deliveryCatalogue.filter.search')}>
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
              }}
              placeholder={t('deliveryCatalogue.filter.searchPlaceholder')}
            />
          </ToolbarField>

          <ToolbarField label={t('deliveryCatalogue.filter.kind')}>
            <Select
              value={kind}
              onChange={(event) => {
                setKind(event.target.value);
              }}
            >
              <option value="">{t('deliveryCatalogue.filter.any')}</option>
              <option value="MARKETPLACE_CARRIER">
                {t('logistics.partnerKind.MARKETPLACE_CARRIER')}
              </option>
              <option value="SELLER_SELF_MANAGED">
                {t('logistics.partnerKind.SELLER_SELF_MANAGED')}
              </option>
              <option value="SELLER_DEDICATED">
                {t('logistics.partnerKind.SELLER_DEDICATED')}
              </option>
            </Select>
          </ToolbarField>

          <ToolbarField label={t('deliveryCatalogue.filter.status')}>
            <Select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value);
              }}
            >
              <option value="">{t('deliveryCatalogue.filter.any')}</option>
              <option value="ACTIVE">ACTIVE</option>
              <option value="PENDING_ACTIVATION">PENDING_ACTIVATION</option>
              <option value="SUSPENDED">SUSPENDED</option>
              <option value="DEACTIVATED">DEACTIVATED</option>
            </Select>
          </ToolbarField>
        </Toolbar>

        <DataTable
          caption={t('deliveryCatalogue.partnersTitle')}
          columns={partnerColumns}
          rows={partners.data?.rows}
          rowKey={(row) => row.id}
          isLoading={partners.isPending}
          isRefreshing={partners.isFetching && !partners.isPending}
          error={partners.error}
          onRetry={() => {
            void partners.refetch();
          }}
          emptyTitle={t('deliveryCatalogue.emptyTitle')}
          emptyDescription={t('deliveryCatalogue.emptyBody')}
        />
      </div>

      {/* --- Seller carrier accounts --------------------------------------- */}
      <Card
        title={t('deliveryCatalogue.healthTitle')}
        description={t('deliveryCatalogue.healthBody')}
        actions={
          <label className="flex items-center gap-2 text-xs text-ink-muted">
            <input
              type="checkbox"
              checked={failingOnly}
              onChange={(event) => {
                setFailingOnly(event.target.checked);
              }}
              className="h-4 w-4 rounded border-border-strong"
            />
            {t('deliveryCatalogue.onlyFailing')}
          </label>
        }
      >
        <ul className="divide-y divide-border-subtle">
          {(catalogue.data?.connections ?? []).map((connection) => (
            <ConnectionRow key={connection.id} connection={connection} />
          ))}
        </ul>

        {catalogue.data !== undefined && catalogue.data.connections.length === 0 && (
          <p className="px-6 py-10 text-center text-sm text-ink-muted">
            {t('deliveryCatalogue.noConnections')}
          </p>
        )}
      </Card>
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

function ProviderPanel({ provider }: { provider: ProviderCard }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        {/* Text, not a logo. See the file header. */}
        <h3 className="text-sm font-semibold text-ink">{provider.provider}</h3>

        {provider.hasVerifiedApi ? (
          <Badge tone="brand">{t('deliveryCatalogue.hasApi')}</Badge>
        ) : (
          <Badge tone="warning">{t('deliveryCatalogue.noApi')}</Badge>
        )}
      </div>

      {/*
        The honesty line, and WHICH honesty line.

        A carrier working inside this portal has nothing to connect, which is
        how it is meant to be. India Post has nothing to connect because
        nobody has found an interface. Both end up with the same badge and
        they are not the same fact, so they do not get the same sentence.
      */}
      {provider.noApiReason !== null && (
        <p className="mt-2 text-xxs leading-relaxed text-ink-muted">
          {provider.noApiReason === 'INSIDE_PORTAL'
            ? t('deliveryCatalogue.insidePortalBody')
            : t('deliveryCatalogue.noApiBody')}
        </p>
      )}

      <dl className="mt-3 space-y-1.5 border-t border-border-subtle pt-3 text-xxs">
        <Row
          label={t('deliveryCatalogue.sellerAccounts')}
          value={String(provider.sellerConnections.total)}
        />
        <Row
          label={t('deliveryCatalogue.inUse')}
          value={String(provider.sellerConnections.active)}
        />
        {provider.sellerConnections.failing > 0 && (
          <Row
            label={t('deliveryCatalogue.notWorking')}
            value={String(provider.sellerConnections.failing)}
            danger
          />
        )}
        <Row
          label={t('deliveryCatalogue.operatorIntegrations')}
          value={String(provider.operatorIntegrations)}
        />
      </dl>

      {provider.requires.length > 0 && (
        <p className="mt-3 text-xxs text-ink-subtle">
          {t('deliveryCatalogue.requires', { list: provider.requires.join(', ') })}
        </p>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  danger,
}: {
  label: string;
  value: string;
  danger?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-subtle">{label}</dt>
      <dd className={cx('font-medium tabular-nums', danger === true ? 'text-danger' : 'text-ink')}>
        {value}
      </dd>
    </div>
  );
}

function ConnectionRow({ connection }: { connection: ConnectionHealthRow }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li className="px-6 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">
            {connection.sellerName} · {connection.provider}
          </p>
          <p className="mt-0.5 text-xxs text-ink-subtle">
            {connection.environment}
            {connection.lastSuccessAt !== null && (
              <> · {t('deliveryCatalogue.lastWorked', { when: formatRelative(connection.lastSuccessAt) })}</>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {connection.consecutiveFailures > 0 && (
            <Badge tone="danger">
              {t('deliveryCatalogue.failures', { total: String(connection.consecutiveFailures) })}
            </Badge>
          )}
          <Badge tone={connection.state === 'ACTIVE' ? 'success' : 'neutral'}>
            {connection.state}
          </Badge>
        </div>
      </div>

      {/*
        The carrier's own refusal, sanitised on the way in. Never a header,
        never a token - the server strips anything that looks like a
        credential before it is stored, because a failure message is the
        commonest place one leaks.
      */}
      {connection.lastFailureMessage !== null && (
        <p className="mt-2 rounded-lg bg-surface-sunken px-3 py-2 text-xxs text-ink-muted">
          {connection.lastFailureMessage}
        </p>
      )}
    </li>
  );
}
