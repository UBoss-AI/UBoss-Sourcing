/**
 * One connection's dashboard.
 *
 * Health at the top, then whichever of four views the buyer asked for:
 * what has crossed, what is in the log, what is waiting on somebody, and where
 * the deliveries from their ERP arrive.
 *
 * WHY THE ACTIONS COME FROM THE SERVER
 *
 * `connection.actions` is the output of the state machine in
 * `customer-erp-state.ts`, not a list this page computes. So the buttons offered
 * are exactly the moves the API would accept, and the two cannot drift apart the
 * way a hand-written `state === 'ACTIVE' && ...` eventually does. A member sees
 * no actions at all, because the server does not send them any.
 *
 * ONE THING IS SAID IN THREE PLACES ON PURPOSE
 *
 * That a retry cannot produce a second purchase order. It is on the Retry
 * button's hint, on the failed-event row, and in the reconnect confirmation -
 * because the person deciding whether to press Retry is usually worried about
 * exactly that, and one mention buried on another screen does not reach them.
 */
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  CopyIcon,
  RefreshIcon,
  SearchIcon,
} from '@/components/icons';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import {
  customerErpApi,
  erpKeys,
  eventStateTone,
  isFullConnection,
  stateTone,
  type ConnectionHealth,
  type ConnectionView,
  type ErpEventState,
} from '@/lib/customer-erp';
import { AccountPanel } from '../AccountPanel';
import { ErpMatchingTab } from './ErpMatchingTab';
import {
  ENVIRONMENT_LABEL,
  EVENT_STATE_LABEL,
  EVENT_TYPE_LABEL,
  STATE_LABEL,
  SYSTEM_LABEL,
} from './erp-labels';

type Tab = 'overview' | 'matching' | 'activity' | 'approvals' | 'deliveries';

const TABS: readonly { id: Tab; labelKey: Parameters<ReturnType<typeof useI18n>['t']>[0] }[] = [
  { id: 'overview', labelKey: 'erp.tab.overview' },
  // Second, not last: "do the two systems hold the same products" is the
  // question a buyer has on day one, and burying it behind the audit trail
  // makes them ask a person instead.
  { id: 'matching', labelKey: 'erp.tab.matching' },
  { id: 'activity', labelKey: 'erp.tab.activity' },
  { id: 'approvals', labelKey: 'erp.tab.approvals' },
  { id: 'deliveries', labelKey: 'erp.tab.deliveries' },
];

export function ErpConnectionPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { id = '' } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const toast = useToast();
  const queryClient = useQueryClient();

  const tab = (searchParams.get('tab') ?? 'overview') as Tab;

  const query = useQuery({
    queryKey: erpKeys.connection(id),
    queryFn: () => customerErpApi.connection(id),
    enabled: id.length > 0,
  });

  useDocumentMeta(
    { title: query.data?.connection.name ?? t('erp.hub.title'), noIndex: true },
    business.displayName,
  );

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: erpKeys.connection(id) });
    void queryClient.invalidateQueries({ queryKey: erpKeys.connections });
  };

  const lifecycle = useMutation({
    mutationFn: (action: 'pause' | 'resume' | 'reconnect' | 'disconnect') =>
      customerErpApi.lifecycle(id, action),
    onSuccess: (connection) => {
      refresh();
      toast.success(t('erp.action.done', { state: t(STATE_LABEL[connection.state]) }));
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const test = useMutation({
    mutationFn: () => customerErpApi.test(id),
    onSuccess: (result) => {
      refresh();
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const activate = useMutation({
    mutationFn: () => customerErpApi.activate(id),
    onSuccess: () => {
      refresh();
      toast.success(t('erp.action.activated'));
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  /*
   * Send the buyer to their own ERP's consent screen.
   *
   * A full-page assignment rather than a router navigation or a new window:
   * the destination is a third party, and it has to be the top-level document
   * so the buyer can see the address they are signing in to. A popup would also
   * be blocked about half the time, which for a once-per-connection act is a
   * worse trade than leaving the page.
   *
   * Nothing is remembered across the redirect. The server issued the `state`
   * and can recover the connection from it, so the callback page has no
   * bookkeeping of its own to lose.
   */
  const authorize = useMutation({
    mutationFn: () => customerErpApi.startOAuth(id),
    onSuccess: (authorization) => {
      window.location.assign(authorization.authorizationUrl);
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const sync = useMutation({
    mutationFn: () => customerErpApi.syncNow(id),
    onSuccess: (result) => {
      refresh();
      void queryClient.invalidateQueries({ queryKey: erpKeys.jobs(id) });
      if (result.status === 'FAILED') toast.error(result.message);
      else toast.success(result.message);
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  if (query.isPending) return <LoadingState label={t('erp.hub.loading')} />;
  if (query.isError) {
    return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  }

  const connection = query.data.connection;
  const full = isFullConnection(connection) ? connection : null;
  const actions = full?.actions ?? [];

  /*
   * Whether this connection is waiting on somebody to go and authorise it.
   *
   * Authorising is not a state transition and deliberately has no entry in the
   * connection state machine - it changes credentials, not what the connection
   * is allowed to do - so the button is derived from the two facts that decide
   * it: the method needs a consent screen, and no tokens have come back from
   * one yet. Once they have, the same button re-authorises, which is what a
   * buyer needs after their ERP administrator revokes access or the refresh
   * token finally expires.
   */
  const needsInteractiveOAuth = full?.authMethod === 'OAUTH2_AUTHORIZATION_CODE';
  const isAuthorized = full?.credentials.some((entry) => entry.kind === 'OAUTH_TOKENS') ?? false;

  return (
    <>
      <PageHeader
        title={connection.name}
        description={t('erp.detail.description', {
          system:
            connection.vendorLabel === connection.system
              ? t(SYSTEM_LABEL[connection.system])
              : connection.vendorLabel,
        })}
        actions={
          <>
            <ButtonLink to="/account/integrations/erp" variant="ghost" size="sm">
              {t('erp.detail.backToList')}
            </ButtonLink>

            {/*
              * Ahead of Test, because on an unauthorised connection a test has
              * nothing to test with, and the buyer pressing buttons left to
              * right should meet them in the order they are meant to happen.
              */}
            {needsInteractiveOAuth && (
              <Button
                size="sm"
                variant={isAuthorized ? 'ghost' : 'primary'}
                onClick={() => { authorize.mutate(); }}
                isLoading={authorize.isPending}
              >
                {isAuthorized
                  ? t('erp.action.reauthorize')
                  : t('erp.action.authorize', {
                      system:
                        connection.vendorLabel === connection.system
                          ? t(SYSTEM_LABEL[connection.system])
                          : connection.vendorLabel,
                    })}
              </Button>
            )}

            {actions.includes('START_TEST') && (
              <Button size="sm" onClick={() => { test.mutate(); }} isLoading={test.isPending}>
                {t('erp.action.test')}
              </Button>
            )}

            {connection.state === 'ACTIVE' && (
              <Button size="sm" onClick={() => { sync.mutate(); }} isLoading={sync.isPending}>
                <RefreshIcon aria-hidden="true" className="h-4 w-4" />
                {t('erp.action.syncNow')}
              </Button>
            )}

            {actions.includes('ACTIVATE') && (
              <Button
                size="sm"
                variant="primary"
                onClick={() => { activate.mutate(); }}
                isLoading={activate.isPending}
              >
                {t('erp.action.activate')}
              </Button>
            )}

            {actions.includes('PAUSE') && (
              <Button size="sm" onClick={() => { lifecycle.mutate('pause'); }}>
                {t('erp.action.pause')}
              </Button>
            )}

            {actions.includes('RESUME') && (
              <Button size="sm" onClick={() => { lifecycle.mutate('resume'); }}>
                {t('erp.action.resume')}
              </Button>
            )}

            {actions.includes('RECONNECT') && (
              <Button size="sm" onClick={() => { lifecycle.mutate('reconnect'); }}>
                {t('erp.action.reconnect')}
              </Button>
            )}

            {actions.includes('EDIT') && (
              <ButtonLink to={`/account/integrations/erp/${id}/edit`} size="sm">
                {t('erp.action.edit')}
              </ButtonLink>
            )}

            {actions.includes('DISCONNECT') && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => { lifecycle.mutate('disconnect'); }}
                title={t('erp.action.disconnectHint')}
              >
                {t('erp.action.disconnect')}
              </Button>
            )}
          </>
        }
      />

      <div className="space-y-6">
        <HealthPanel connection={connection} />

        <nav aria-label={t('erp.detail.sections')} className="flex flex-wrap gap-1">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-current={tab === entry.id ? 'page' : undefined}
              onClick={() => {
                setSearchParams(entry.id === 'overview' ? {} : { tab: entry.id });
              }}
              className={cx(
                'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                tab === entry.id
                  ? 'bg-brand-soft text-brand'
                  : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
              )}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </nav>

        {tab === 'overview' && <OverviewTab connection={connection} full={full} />}
        {tab === 'matching' && (
          <ErpMatchingTab
            connectionId={id}
            systemLabel={
              connection.vendorLabel === connection.system
                ? t(SYSTEM_LABEL[connection.system])
                : connection.vendorLabel
            }
          />
        )}
        {tab === 'activity' && <ActivityTab connectionId={id} canOperate={full !== null} />}
        {tab === 'approvals' && <ApprovalsTab connectionId={id} />}
        {tab === 'deliveries' && <DeliveriesTab connectionId={id} full={full} />}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

/**
 * The health strip.
 *
 * Five facts, in the order somebody scanning for a problem needs them: is it
 * on, why not, when did it last work, when will it try again, and how much is
 * stuck. Rendered for every role, because that is the part a read-only member
 * is entitled to and is usually all they came for.
 */
function HealthPanel({
  connection,
}: {
  connection: ConnectionHealth | ConnectionView;
}): React.JSX.Element {
  const { t } = useI18n();

  const failed = connection.eventCounts.FAILED ?? 0;
  const queued = (connection.eventCounts.QUEUED ?? 0) + (connection.eventCounts.RETRYING ?? 0);
  const succeeded = connection.eventCounts.SUCCEEDED ?? 0;

  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-card sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={stateTone(connection.state)}>{t(STATE_LABEL[connection.state])}</Badge>
        <Badge tone="neutral">{t(ENVIRONMENT_LABEL[connection.environment])}</Badge>
        <Badge tone="neutral">{t(SYSTEM_LABEL[connection.system])}</Badge>
        {/* The brand, where it is something other than the protocol itself. */}
        {connection.vendorLabel !== connection.system && (
          <Badge tone="neutral">{connection.vendorLabel}</Badge>
        )}
      </div>

      {connection.stateReason !== null && (
        <p className="mt-3 flex items-start gap-2 rounded-md bg-warning-soft p-3 text-sm leading-relaxed text-ink">
          <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          {connection.stateReason}
        </p>
      )}

      <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Fact
          label={t('erp.detail.lastSuccess')}
          value={
            connection.lastSuccessAt === null
              ? t('erp.hub.neverSynced')
              : formatDateTime(connection.lastSuccessAt)
          }
        />
        <Fact
          label={t('erp.detail.nextSync')}
          value={
            connection.nextPollAt === null
              ? t('erp.detail.noScheduledSync')
              : formatDateTime(connection.nextPollAt)
          }
        />
        <Fact
          label={t('erp.detail.lastTest')}
          value={
            connection.lastTestAt === null
              ? t('erp.detail.neverTested')
              : `${formatDateTime(connection.lastTestAt)} · ${
                  connection.lastTestOk === true ? t('erp.detail.passed') : t('erp.detail.failed')
                }`
          }
        />
        <Fact
          label={t('erp.detail.queue')}
          value={t('erp.detail.queueSummary', { succeeded, queued, failed })}
          tone={failed > 0 ? 'danger' : queued > 0 ? 'warning' : 'default'}
        />
      </dl>
    </section>
  );
}

function Fact({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning' | 'danger';
}): React.JSX.Element {
  return (
    <div>
      <dt className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{label}</dt>
      <dd
        className={cx(
          'mt-1 text-sm font-medium',
          tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}

// ---------------------------------------------------------------------------

function OverviewTab({
  connection,
  full,
}: {
  connection: ConnectionHealth | ConnectionView;
  full: ConnectionView | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();

  const links = useQuery({
    queryKey: erpKeys.links(connection.id),
    queryFn: () => customerErpApi.links(connection.id),
  });

  return (
    <div className="space-y-6">
      {/*
       * Configuration, for the roles entitled to it. A read-only member gets
       * the health strip above and nothing here - not a greyed-out copy of it,
       * because the endpoints a connection calls are not theirs to see.
       */}
      {full !== null && (
        <AccountPanel title={t('erp.detail.configuration')}>
          <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Fact label={t('erp.wizard.baseUrl')} value={full.baseUrl} />
            <Fact
              label={t('erp.wizard.authMethod')}
              value={full.authMethod.replace(/_/g, ' ').toLowerCase()}
            />
            <Fact
              label={t('erp.detail.endpointsConfigured')}
              value={String(full.endpoints.filter((entry) => entry.enabled).length)}
            />
            <Fact
              label={t('erp.detail.mappingChecked')}
              value={
                full.mappingVerifiedAt === null
                  ? t('erp.detail.mappingUnchecked')
                  : formatDateTime(full.mappingVerifiedAt)
              }
              tone={full.mappingVerifiedAt === null ? 'warning' : 'default'}
            />
          </dl>

          {/*
           * The credential hints. Never a secret - see `credential.service.ts`
           * - and present so somebody can tell which key is installed without
           * going to find a password manager.
           */}
          {full.credentials.length > 0 && (
            <div className="mt-5 border-t border-border-subtle pt-5">
              <h3 className="text-sm font-semibold text-ink">{t('erp.detail.credentials')}</h3>

              <ul className="mt-2 space-y-2">
                {full.credentials.map((credential) => (
                  <li
                    key={credential.kind}
                    className="flex flex-wrap items-center gap-2 rounded-md bg-surface-sunken px-3 py-2 text-sm"
                  >
                    <span className="font-medium text-ink">
                      {credential.kind.replace(/_/g, ' ').toLowerCase()}
                    </span>
                    <code className="font-mono text-xs text-ink-muted">
                      {credential.hint ?? t('erp.detail.credentialSet')}
                    </code>
                    {credential.expired && <Badge tone="danger">{t('erp.detail.expired')}</Badge>}
                    {credential.grantedScope !== null && (
                      <span className="text-xxs text-ink-subtle">{credential.grantedScope}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/*
           * The inbound address, for the buyer to register with their ERP.
           * Public and unguessable rather than secret - the signature is the
           * authentication - so it is safe to show and to copy.
           */}
          {full.webhookUrl !== null && (
            <div className="mt-5 border-t border-border-subtle pt-5">
              <h3 className="text-sm font-semibold text-ink">{t('erp.detail.webhookUrl')}</h3>

              <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                {t('erp.detail.webhookUrlBody', { header: full.webhookSignatureHeader })}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-md bg-surface-sunken px-3 py-2 font-mono text-xs text-ink">
                  {full.webhookUrl}
                </code>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(full.webhookUrl ?? '')
                      .then(() => { toast.success(t('erp.detail.copied')); })
                      // A clipboard that refuses is a browser permission, not a
                      // fault: the address is on screen and selectable either way.
                      .catch(() => { toast.info(t('erp.detail.copyFailed')); });
                  }}
                >
                  <CopyIcon aria-hidden="true" className="h-4 w-4" />
                  {t('erp.detail.copy')}
                </Button>
              </div>
            </div>
          )}
        </AccountPanel>
      )}

      <AccountPanel title={t('erp.detail.orders')}>
        {links.data === undefined || links.data.orderLinks.length === 0 ? (
          <EmptyState
            title={t('erp.detail.noOrdersTitle')}
            description={t('erp.detail.noOrdersBody')}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[42rem] text-left text-sm">
              <thead className="text-xxs uppercase tracking-wider text-ink-subtle">
                <tr>
                  <th className="pb-2 pr-4 font-semibold">{t('erp.detail.order')}</th>
                  <th className="pb-2 pr-4 font-semibold">{t('erp.detail.purchaseOrder')}</th>
                  <th className="pb-2 pr-4 font-semibold">{t('erp.detail.onOrder')}</th>
                  <th className="pb-2 pr-4 font-semibold">{t('erp.detail.received')}</th>
                  <th className="pb-2 font-semibold">{t('erp.detail.lastSynced')}</th>
                </tr>
              </thead>

              <tbody className="divide-y divide-border-subtle">
                {links.data.orderLinks.map((link) => (
                  <tr key={link.orderId}>
                    <td className="py-2.5 pr-4">
                      <Link
                        to={`/account/orders/${link.orderId}`}
                        className="font-medium text-brand hover:underline"
                      >
                        {link.orderNumber ?? link.orderId.slice(-8)}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-4 font-mono text-xs text-ink-muted">
                      {link.erpPurchaseOrderId ?? '—'}
                    </td>
                    {/*
                     * On order and received, side by side. The distinction is
                     * the whole point of the feature: ordering something does
                     * not put it on the shelf.
                     */}
                    <td className="py-2.5 pr-4">{link.onOrderQty}</td>
                    <td className="py-2.5 pr-4">
                      {link.receivedQty > 0 ? (
                        <span className="inline-flex items-center gap-1 text-success">
                          <CheckIcon aria-hidden="true" className="h-3.5 w-3.5" />
                          {link.receivedQty}
                        </span>
                      ) : (
                        link.receivedQty
                      )}
                    </td>
                    <td className="py-2.5 text-xs text-ink-muted">
                      {link.lastSyncedAt === null ? '—' : formatDateTime(link.lastSyncedAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AccountPanel>

      {links.data !== undefined && links.data.invoiceLinks.length > 0 && (
        <AccountPanel title={t('erp.detail.invoices')}>
          <ul className="divide-y divide-border-subtle">
            {links.data.invoiceLinks.map((link) => (
              <li key={link.invoiceId} className="flex flex-wrap items-center gap-3 py-2.5">
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {link.erpInvoiceNumber ?? link.invoiceId.slice(-8)}
                </span>
                <span className="text-sm text-ink-muted">
                  {link.currency} {minorToDisplay(link.grandTotalMinor)}
                </span>
                {link.paymentReference !== null && (
                  <Badge tone="success">{t('erp.detail.paid')}</Badge>
                )}
              </li>
            ))}
          </ul>
        </AccountPanel>
      )}
    </div>
  );
}

/** Minor units as a decimal, by string arithmetic. Never `value / 100`. */
function minorToDisplay(minor: string, exponent = 2): string {
  if (exponent === 0) return minor;
  const digits = minor.replace(/\D/g, '').padStart(exponent + 1, '0');

  return `${digits.slice(0, digits.length - exponent)}.${digits.slice(digits.length - exponent)}`;
}

// ---------------------------------------------------------------------------

/**
 * The searchable log.
 *
 * Searched on the correlation id, the ERP reference and the order id, because
 * those are the three things somebody actually has in front of them when they
 * come here - an email quoting a correlation id, a purchase order number from
 * their SAP, or an order number from ours.
 */
function ActivityTab({
  connectionId,
  canOperate,
}: {
  connectionId: string;
  canOperate: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [state, setState] = useState<ErpEventState | ''>('');

  const filters = { connectionId, search: search.trim(), state: state === '' ? undefined : state };

  const events = useQuery({
    queryKey: erpKeys.events(filters),
    queryFn: () =>
      customerErpApi.events({
        connectionId,
        ...(search.trim().length > 0 ? { search: search.trim() } : {}),
        ...(state === '' ? {} : { state }),
        limit: 50,
      }),
  });

  const retry = useMutation({
    mutationFn: (eventId: string) => customerErpApi.retryEvent(eventId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customer-erp', 'events'] });
      toast.success(t('erp.log.retryQueued'));
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  return (
    <AccountPanel title={t('erp.log.title')} description={t('erp.log.description')}>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[14rem] flex-1">
          <label htmlFor="erp-log-search" className="mb-1.5 block text-sm font-medium text-ink">
            {t('erp.log.search')}
          </label>
          <div className="relative">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-subtle"
            />
            <Input
              id="erp-log-search"
              value={search}
              placeholder={t('erp.log.searchPlaceholder')}
              className="pl-9"
              onChange={(event) => { setSearch(event.target.value); }}
            />
          </div>
        </div>

        <div className="w-52">
          <label htmlFor="erp-log-state" className="mb-1.5 block text-sm font-medium text-ink">
            {t('erp.log.state')}
          </label>
          <Select
            id="erp-log-state"
            value={state}
            onChange={(event) => { setState(event.target.value as ErpEventState | ''); }}
          >
            <option value="">{t('erp.log.anyState')}</option>
            {(
              ['QUEUED', 'PROCESSING', 'SUCCEEDED', 'RETRYING', 'FAILED', 'SKIPPED'] as const
            ).map((value) => (
              <option key={value} value={value}>
                {t(EVENT_STATE_LABEL[value])}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {events.isPending ? (
        <LoadingState label={t('erp.log.loading')} />
      ) : events.data === undefined || events.data.rows.length === 0 ? (
        <EmptyState title={t('erp.log.emptyTitle')} description={t('erp.log.emptyBody')} />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {events.data.rows.map((event) => (
            <li key={event.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={eventStateTone(event.state)}>{t(EVENT_STATE_LABEL[event.state])}</Badge>

                {/*
                 * The raw name where we have no words for it. The server's
                 * list of event types can grow, and a log row reading
                 * "purchase order create" is ugly but honest - where a crash
                 * on an unrecognised type would lose the whole page.
                 */}
                <span className="text-sm font-medium text-ink">
                  {eventTypeLabel(t, event.eventType)}
                </span>

                <span className="text-xs text-ink-subtle">{formatDateTime(event.createdAt)}</span>

                {event.attemptCount > 1 && (
                  <span className="text-xs text-ink-subtle">
                    {t('erp.log.attempts', { count: event.attemptCount })}
                  </span>
                )}

                {canOperate && (event.state === 'FAILED' || event.state === 'SKIPPED') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    // Said here as well as on the row below, because this is
                    // the moment somebody is deciding whether it is safe.
                    title={t('erp.log.retryHint')}
                    onClick={() => { retry.mutate(event.id); }}
                    isLoading={retry.isPending}
                  >
                    {t('erp.log.retry')}
                  </Button>
                )}
              </div>

              {event.errorMessage !== null && (
                <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-danger">
                  {event.errorMessage}
                </p>
              )}

              {event.skipReason !== null && (
                <p className="mt-1.5 max-w-prose text-xs leading-relaxed text-ink-muted">
                  {event.skipReason}
                </p>
              )}

              <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 font-mono text-xxs text-ink-subtle">
                <span>{event.correlationId}</span>
                {event.erpReference !== null && <span>→ {event.erpReference}</span>}
                {event.nextRetryAt !== null && (
                  <span className="font-sans">
                    {t('erp.log.nextRetry', { when: formatDateTime(event.nextRetryAt) })}
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </AccountPanel>
  );
}

/** Words for an event type, falling back to the raw name. See the call site. */
function eventTypeLabel(t: ReturnType<typeof useI18n>['t'], eventType: string): string {
  const key = EVENT_TYPE_LABEL[eventType];
  return key === undefined ? eventType.replace(/_/g, ' ').toLowerCase() : t(key);
}

// ---------------------------------------------------------------------------

function ApprovalsTab({ connectionId }: { connectionId: string }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const approvals = useQuery({
    queryKey: erpKeys.approvals(connectionId),
    queryFn: () => customerErpApi.approvals(connectionId),
  });

  const decide = useMutation({
    mutationFn: (input: { id: string; decision: 'APPROVED' | 'REJECTED' }) =>
      customerErpApi.decideApproval(input.id, input.decision),
    onSuccess: (approval) => {
      void queryClient.invalidateQueries({ queryKey: erpKeys.approvals(connectionId) });
      void queryClient.invalidateQueries({ queryKey: erpKeys.approvals(null) });
      toast.success(
        approval.state === 'APPROVED' ? t('erp.approval.approved') : t('erp.approval.rejected'),
      );
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  return (
    <AccountPanel title={t('erp.approval.title')} description={t('erp.approval.description')}>
      {approvals.data === undefined || approvals.data.length === 0 ? (
        <EmptyState
          title={t('erp.approval.emptyTitle')}
          description={t('erp.approval.emptyBody')}
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {approvals.data.map((approval) => (
            <li key={approval.id} className="py-3">
              <div className="flex flex-wrap items-start gap-3">
                <ClockIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-warning" />

                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed text-ink">{approval.summary}</p>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {approval.state === 'PENDING'
                      ? t('erp.approval.expires', {
                          when: formatDateTime(approval.expiresAt),
                        })
                      : t('erp.approval.decided', {
                          state: approval.state.toLowerCase(),
                          when:
                            approval.decidedAt === null
                              ? ''
                              : formatDateTime(approval.decidedAt),
                        })}
                  </p>
                </div>

                {approval.state === 'PENDING' && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => { decide.mutate({ id: approval.id, decision: 'APPROVED' }); }}
                      isLoading={decide.isPending}
                    >
                      {t('erp.approval.approve')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => { decide.mutate({ id: approval.id, decision: 'REJECTED' }); }}
                    >
                      {t('erp.approval.decline')}
                    </Button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------

/**
 * What the buyer's ERP has sent us, verified and refused alike.
 *
 * A refused delivery is shown rather than hidden. Dropping it silently is how
 * somebody spends a week wondering why their webhooks never arrive, and the
 * reason recorded here - a signature that did not verify, a timestamp outside
 * the window - is the one they can act on.
 */
function DeliveriesTab({
  connectionId,
  full,
}: {
  connectionId: string;
  full: ConnectionView | null;
}): React.JSX.Element {
  const { t } = useI18n();

  const deliveries = useQuery({
    queryKey: erpKeys.webhookEvents(connectionId),
    queryFn: () => customerErpApi.webhookEvents(connectionId),
  });

  const jobs = useQuery({
    queryKey: erpKeys.jobs(connectionId),
    queryFn: () => customerErpApi.jobs(connectionId),
  });

  return (
    <div className="space-y-6">
      <AccountPanel title={t('erp.deliveries.title')} description={t('erp.deliveries.description')}>
        {full !== null && !full.webhookEnabled && (
          <p className="mb-4 rounded-md bg-surface-sunken p-3 text-sm leading-relaxed text-ink-muted">
            {t('erp.deliveries.disabled')}
          </p>
        )}

        {deliveries.data === undefined || deliveries.data.length === 0 ? (
          <EmptyState
            title={t('erp.deliveries.emptyTitle')}
            description={t('erp.deliveries.emptyBody')}
          />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {deliveries.data.map((delivery) => (
              <li key={delivery.id} className="flex flex-wrap items-center gap-2 py-2.5">
                <Badge tone={delivery.verified ? 'success' : 'danger'}>
                  {delivery.verified ? t('erp.deliveries.accepted') : t('erp.deliveries.refused')}
                </Badge>

                <span className="text-sm text-ink">
                  {delivery.externalEventType ?? t('erp.deliveries.unnamed')}
                </span>

                <span className="text-xs text-ink-subtle">
                  {formatDateTime(delivery.receivedAt)}
                </span>

                {delivery.rejectionReason !== null && (
                  <span className="w-full text-xs leading-relaxed text-danger">
                    {delivery.rejectionReason}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </AccountPanel>

      <AccountPanel title={t('erp.jobs.title')} description={t('erp.jobs.description')}>
        {jobs.data === undefined || jobs.data.length === 0 ? (
          <EmptyState title={t('erp.jobs.emptyTitle')} description={t('erp.jobs.emptyBody')} />
        ) : (
          <ul className="divide-y divide-border-subtle">
            {jobs.data.map((job) => (
              <li key={job.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <Badge
                  tone={
                    job.status === 'SUCCEEDED'
                      ? 'success'
                      : job.status === 'FAILED'
                        ? 'danger'
                        : 'warning'
                  }
                >
                  {job.status.toLowerCase()}
                </Badge>

                {job.isDryRun && <Badge tone="neutral">{t('erp.jobs.dryRun')}</Badge>}

                <span className="text-ink">
                  {t('erp.jobs.summary', {
                    processed: job.processedCount,
                    applied: job.succeededCount,
                    failed: job.failedCount,
                  })}
                </span>

                <span className="text-xs text-ink-subtle">{formatDateTime(job.startedAt)}</span>

                {job.errorMessage !== null && (
                  <span className="w-full text-xs leading-relaxed text-danger">
                    {job.errorMessage}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </AccountPanel>
    </div>
  );
}
