/**
 * Seller Hub → Settings → ERP Integrations → TallyPrime.
 *
 * THE ONE RULE THIS SCREEN SERVES
 *
 * It never says "Connected" unless the server has concluded it, from a live
 * health check: a bridge heartbeat inside the freshness window, a passing test
 * recently enough to still mean something, the configured company actually
 * open in Tally, and every mapping a sync would need confirmed. Thirteen
 * states exist because each one is a different thing for the seller to DO, and
 * collapsing any two of them wastes somebody's afternoon - "the bridge is off"
 * and "Tally is closed" and "the wrong company is open" look identical from
 * here and are three different walks to the same machine.
 *
 * So every claim on this page carries its own timestamp, and the page shows
 * them. A status with no time beside it is a status nobody can check.
 *
 * WHY THE SETUP IS A CHECKLIST AND NOT A WIZARD WITH PAGES
 *
 * Because it is not linear. A seller pairs a machine on Monday, chooses a
 * company on Tuesday, and comes back in a fortnight to map a ledger they
 * forgot. A paged wizard makes them walk the whole thing again to change one
 * answer; a checklist shows what is done, what is not, and lets them start
 * anywhere.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { useT, type TranslationKey } from '@/i18n/i18n-context';
import { SellerErpMappingPanel } from './SellerErpMappingPanel';
import {
  cancelErpJob,
  createErpConnection,
  fetchBridgeDevices,
  fetchErpConnections,
  fetchErpJobs,
  fetchErpMappings,
  fetchErpPolicy,
  fetchTallyCompanies,
  issuePairingCode,
  refreshTallyMasters,
  retryErpJob,
  revokeBridgeDevice,
  runInitialSync,
  selectTallyCompany,
  setAutoCreateMasters,
  setErpConnectionEnabled,
  testErpConnection,
  updateErpPolicy,
  validateErpConnection,
  type ErpConnection,
  type IssuedPairingCode,
  type SellerErpState,
} from '@/lib/seller-erp';

/**
 * How a state is drawn.
 *
 * `success` is reserved for the two that genuinely mean it works. Everything
 * else is a warning or neutral, including the several that are not failures -
 * "waiting to be paired" is not a problem, but it is not "connected" either,
 * and a green dot beside it would say it was.
 */
function toneFor(state: SellerErpState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'CONNECTED':
    case 'SYNCING':
      return 'success';
    case 'CONNECTED_WITH_WARNINGS':
    case 'MAPPING_INCOMPLETE':
    case 'AWAITING_PAIRING':
      return 'warning';
    case 'BRIDGE_OFFLINE':
    case 'TALLY_UNAVAILABLE':
    case 'COMPANY_NOT_LOADED':
    case 'VALIDATION_FAILED':
    case 'PAIRING_EXPIRED':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function SellerErpPage(): React.JSX.Element {
  const t = useT();
  const toast = useToast();
  const client = useQueryClient();

  const [newName, setNewName] = useState('');

  const query = useQuery({
    queryKey: ['seller', 'erp', 'connections'],
    queryFn: fetchErpConnections,
    /*
     * Polled, because most of what this page shows changes WITHOUT a request
     * from here: a heartbeat arriving, a test the bridge answered, a job that
     * posted. Fifteen seconds is often enough that a seller watching after
     * pairing sees it come alive, and rare enough that a screen left open in a
     * tab is not a request every second.
     */
    refetchInterval: 15_000,
  });

  const create = useMutation({
    mutationFn: () => createErpConnection({ name: newName.trim() }),
    onSuccess: async () => {
      setNewName('');
      await client.invalidateQueries({ queryKey: ['seller', 'erp', 'connections'] });
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotConnect')));
    },
  });

  if (query.isPending) return <LoadingState label={t('sellerErp.title')} />;
  if (query.isError) return <ErrorState error={query.error} />;

  const data = query.data;

  return (
    <div className="space-y-6">
      <PageHeader title={t('sellerErp.title')} description={t('sellerErp.intro')} />

      {/* The feature gate, said plainly rather than as a failure. A seller
          whose marketplace has not switched this on is not doing anything
          wrong and there is nothing for them to fix. */}
      {!data.available ? (
        <EmptyState title={t('sellerErp.title')} description={t('sellerErp.notAvailable')} />
      ) : (
        <>
          {data.connections.length === 0 && (
            <Card title={t('sellerErp.addConnection')} bodyClassName="px-6 py-5">
              <p className="max-w-prose text-sm text-ink-muted">{t('sellerErp.firstIntro')}</p>

              <div className="mt-4 max-w-sm">
                <Field label={t('sellerErp.connectionName')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={newName}
                      onChange={(event) => {
                        setNewName(event.target.value);
                      }}
                      placeholder={t('sellerErp.connectionNamePlaceholder')}
                    />
                  )}
                </Field>
              </div>

              <Button
                variant="primary"
                className="mt-4"
                isLoading={create.isPending}
                disabled={newName.trim() === ''}
                onClick={() => {
                  create.mutate();
                }}
              >
                {t('sellerErp.addConnection')}
              </Button>
            </Card>
          )}

          {data.connections.map((connection) => (
            <ConnectionPanel key={connection.id} connection={connection} />
          ))}
        </>
      )}
    </div>
  );
}

function ConnectionPanel({ connection }: { connection: ErpConnection }): React.JSX.Element {
  const t = useT();
  const toast = useToast();
  const client = useQueryClient();

  const [deviceLabel, setDeviceLabel] = useState('');
  const [issued, setIssued] = useState<IssuedPairingCode | null>(null);

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['seller', 'erp'] });
  };

  const devices = useQuery({
    queryKey: ['seller', 'erp', 'devices', connection.id],
    queryFn: () => fetchBridgeDevices(connection.id),
  });

  const companies = useQuery({
    queryKey: ['seller', 'erp', 'companies', connection.id],
    queryFn: () => fetchTallyCompanies(connection.id),
  });

  const mappings = useQuery({
    queryKey: ['seller', 'erp', 'mappings', connection.id],
    queryFn: () => fetchErpMappings(connection.id),
  });

  const policy = useQuery({
    queryKey: ['seller', 'erp', 'policy', connection.id],
    queryFn: () => fetchErpPolicy(connection.id),
  });

  const jobs = useQuery({
    queryKey: ['seller', 'erp', 'jobs', connection.id],
    queryFn: () => fetchErpJobs(connection.id),
    refetchInterval: 20_000,
  });

  const pair = useMutation({
    mutationFn: () => issuePairingCode(connection.id, deviceLabel.trim()),
    onSuccess: async (result) => {
      // Held in state and shown ONCE. It is not stored in plaintext anywhere
      // and no read returns it; a seller who loses it generates another.
      setIssued(result);
      setDeviceLabel('');
      await refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotPair')));
    },
  });

  const test = useMutation({
    mutationFn: () => testErpConnection(connection.id),
    onSuccess: () => {
      // 202, not a verdict. The bridge pulls work, so nothing has been tested
      // when this returns - the panel polls and the status moves when it has.
      toast.info(t('sellerErp.testQueued'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotTest')));
    },
  });

  const chooseCompany = useMutation({
    mutationFn: (name: string) => selectTallyCompany(connection.id, name),
    onSuccess: refresh,
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotChooseCompany')));
    },
  });

  const savePolicy = useMutation({
    mutationFn: (patch: Parameters<typeof updateErpPolicy>[1]) =>
      updateErpPolicy(connection.id, patch),
    onSuccess: refresh,
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotSavePolicy')));
    },
  });

  const toggleMasters = useMutation({
    mutationFn: (enabled: boolean) => setAutoCreateMasters(connection.id, enabled),
    onSuccess: refresh,
  });

  const validate = useMutation({
    mutationFn: () => validateErpConnection(connection.id),
    onSuccess: (result) => {
      if (result.ok) toast.success(t('sellerErp.validateOk'));
      else toast.info(result.stateReason ?? t('sellerErp.state.MAPPING_INCOMPLETE'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotValidate')));
    },
  });

  const initial = useMutation({
    mutationFn: () => runInitialSync(connection.id),
    onSuccess: async (result) => {
      toast.success(t('sellerErp.initialSyncQueued', { queued: String(result.queued) }));
      await refresh();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotSync')));
    },
  });

  const refreshMasters = useMutation({
    mutationFn: () => refreshTallyMasters(connection.id),
    onSuccess: () => {
      toast.info(t('sellerErp.testQueued'));
    },
  });

  const toggleConnection = useMutation({
    mutationFn: (enabled: boolean) => setErpConnectionEnabled(connection.id, enabled),
    onSuccess: refresh,
  });

  const revoke = useMutation({
    mutationFn: (deviceId: string) => revokeBridgeDevice(deviceId, null),
    onSuccess: async () => {
      toast.success(t('sellerErp.revoked'));
      await refresh();
    },
  });

  const retry = useMutation({
    mutationFn: (jobId: string) => retryErpJob(jobId),
    onSuccess: refresh,
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotRetry')));
    },
  });

  const cancel = useMutation({
    mutationFn: (jobId: string) => cancelErpJob(jobId),
    onSuccess: refresh,
    onError: (error) => {
      toast.error(errorMessage(t, error, t('sellerErp.couldNotRetry')));
    },
  });

  const when = (value: string | null): string =>
    value === null ? t('sellerErp.never') : formatDateTime(value);

  return (
    <Card
      title={connection.name}
      actions={
        <Badge tone={toneFor(connection.state)}>
          {t(`sellerErp.state.${connection.state}` as TranslationKey)}
        </Badge>
      }
      bodyClassName="px-6 py-5 space-y-6"
    >
      {/* The reason, always. The state word alone tells a seller something is
          wrong; the reason tells them which machine to walk to. */}
      {connection.stateReason !== null && (
        <p className="text-sm text-ink-muted">{connection.stateReason}</p>
      )}

      {/* Every claim with its own timestamp beside it. */}
      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('sellerErp.lastHeartbeat')}</dt>
          <dd className="text-right font-medium">{when(connection.lastHeartbeatAt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('sellerErp.lastTest')}</dt>
          <dd className="text-right font-medium">{when(connection.lastTestAt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('sellerErp.lastSync')}</dt>
          <dd className="text-right font-medium">{when(connection.lastSuccessfulSyncAt)}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('sellerErp.company')}</dt>
          <dd className="text-right font-medium">{connection.companyName ?? '—'}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('sellerErp.pendingJobs')}</dt>
          <dd className="text-right font-medium">{connection.pendingJobs}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('sellerErp.failedJobs')}</dt>
          <dd className="text-right font-medium">{connection.failedJobs}</dd>
        </div>
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('sellerErp.missingMappings')}</dt>
          <dd className="text-right font-medium">{connection.missingMappingCount}</dd>
        </div>
      </dl>

      {/* --- Setting it up ---------------------------------------------- */}
      <section>
        <h3 className="text-sm font-semibold">{t('sellerErp.steps')}</h3>

        <ol className="mt-2 space-y-1 text-sm text-ink-muted">
          <li>1. {t('sellerErp.step.install')}</li>
          <li>2. {t('sellerErp.step.running')}</li>
          <li>3. {t('sellerErp.step.code')}</li>
          <li>4. {t('sellerErp.step.pair')}</li>
          <li>5. {t('sellerErp.step.company')}</li>
          <li>6. {t('sellerErp.step.test')}</li>
          <li>7. {t('sellerErp.step.mapping')}</li>
          <li>8. {t('sellerErp.step.policy')}</li>
          <li>9. {t('sellerErp.step.validate')}</li>
          <li>10. {t('sellerErp.step.initial')}</li>
        </ol>
      </section>

      {/* --- Pairing ------------------------------------------------------ */}
      <section>
        <h3 className="text-sm font-semibold">{t('sellerErp.devices')}</h3>

        <div className="mt-2 flex flex-wrap items-end gap-3">
          <div className="max-w-xs flex-1">
            <Field label={t('sellerErp.deviceLabel')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={deviceLabel}
                  onChange={(event) => {
                    setDeviceLabel(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Button
            isLoading={pair.isPending}
            disabled={deviceLabel.trim() === ''}
            onClick={() => {
              pair.mutate();
            }}
          >
            {t('sellerErp.generateCode')}
          </Button>
        </div>

        {/* Shown once. The wording says so, because a seller who closes this
            without copying it has to generate another - which is safe and
            costs nothing, but they should know before they close it. */}
        {issued !== null && (
          <div className="mt-3 rounded-lg border border-brand bg-brand-soft p-4">
            <p className="font-mono text-title-sm tracking-widest">{issued.code}</p>
            <p className="mt-1 text-xs text-ink-muted">
              {t('sellerErp.codeShownOnce', { expires: formatDateTime(issued.expiresAt) })}
            </p>
          </div>
        )}

        {(devices.data?.devices ?? []).length > 0 && (
          <ul className="mt-4 space-y-2">
            {(devices.data?.devices ?? []).map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <span>
                  <span className="font-medium">{device.label}</span>
                  <Badge tone={device.isOnline ? 'success' : 'neutral'}>
                    {device.isOnline ? t('sellerErp.online') : t('sellerErp.offline')}
                  </Badge>
                  <span className="block text-xs text-ink-muted">
                    {device.reportedTallyAddress ?? '—'} · {when(device.lastHeartbeatAt)}
                  </span>
                </span>

                {device.state !== 'REVOKED' && (
                  <Button
                    size="sm"
                    variant="danger"
                    isLoading={revoke.isPending}
                    onClick={() => {
                      revoke.mutate(device.id);
                    }}
                  >
                    {t('sellerErp.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Company and test --------------------------------------------- */}
      <section className="flex flex-wrap items-end gap-3">
        <div className="max-w-sm flex-1">
          <Field label={t('sellerErp.chooseCompany')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={connection.companyName ?? ''}
                onChange={(event) => {
                  if (event.target.value !== '') chooseCompany.mutate(event.target.value);
                }}
              >
                <option value="">—</option>
                {(companies.data?.companies ?? []).map((company) => (
                  <option key={company.name} value={company.name}>
                    {company.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Button
          isLoading={test.isPending}
          onClick={() => {
            test.mutate();
          }}
        >
          {t('sellerErp.testConnection')}
        </Button>

        <Button
          isLoading={refreshMasters.isPending}
          onClick={() => {
            refreshMasters.mutate();
          }}
        >
          {t('sellerErp.refreshMasters')}
        </Button>
      </section>

      {/* --- What is still to match ----------------------------------------
       *
       * Its own panel rather than a list here, because seeing what is missing
       * and being able to fix it are the same errand. A screen that named the
       * unmatched ledgers and then left the seller to find the mapping form
       * somewhere else is a screen that produces a support ticket.
       */}
      <SellerErpMappingPanel
        connectionId={connection.id}
        missing={mappings.data?.missing ?? []}
      />

      {/* --- What gets posted --------------------------------------------- */}
      {policy.data !== undefined && (
        <section>
          <h3 className="text-sm font-semibold">{t('sellerErp.policy')}</h3>

          <div className="mt-2 space-y-2 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.data.postSalesOrder}
                onChange={(event) => {
                  savePolicy.mutate({ postSalesOrder: event.target.checked });
                }}
              />
              {t('sellerErp.postSalesOrder')}
            </label>

            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={policy.data.postSalesInvoice}
                onChange={(event) => {
                  savePolicy.mutate({ postSalesInvoice: event.target.checked });
                }}
              />
              <span>
                {t('sellerErp.postSalesInvoice')}
                {/* The distinction that matters most here, said where the
                    switch is: an order and the revenue from it are two
                    different accounting events. */}
                <span className="block text-xs text-ink-muted">
                  {t('sellerErp.postSalesInvoiceHint')}
                </span>
              </span>
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.data.invoiceOnDispatch}
                onChange={(event) => {
                  savePolicy.mutate({ invoiceOnDispatch: event.target.checked });
                }}
              />
              {t('sellerErp.invoiceOnDispatch')}
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.data.postReceipt}
                onChange={(event) => {
                  savePolicy.mutate({ postReceipt: event.target.checked });
                }}
              />
              {t('sellerErp.postReceipt')}
            </label>

            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={policy.data.postCreditNote}
                onChange={(event) => {
                  savePolicy.mutate({ postCreditNote: event.target.checked });
                }}
              />
              {t('sellerErp.postCreditNote')}
            </label>

            {/* Its own decision, visually separated, because it is the one
                setting that lets this software write to somebody's chart of
                accounts unprompted. */}
            <label className="flex items-start gap-2 border-t border-border-subtle pt-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={connection.autoCreateMasters}
                onChange={(event) => {
                  toggleMasters.mutate(event.target.checked);
                }}
              />
              <span>
                {t('sellerErp.autoCreateMasters')}
                <span className="block text-xs text-ink-muted">
                  {t('sellerErp.autoCreateMastersHint')}
                </span>
              </span>
            </label>

            <div className="max-w-sm pt-2">
              <Field label={t('sellerErp.inventoryAuthority')}>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={policy.data.inventoryAuthority}
                    onChange={(event) => {
                      savePolicy.mutate({
                        inventoryAuthority: event.target
                          .value as typeof policy.data.inventoryAuthority,
                      });
                    }}
                  >
                    <option value="DISABLED">{t('sellerErp.authority.DISABLED')}</option>
                    <option value="GLOVIA">{t('sellerErp.authority.GLOVIA')}</option>
                    <option value="TALLY">{t('sellerErp.authority.TALLY')}</option>
                    <option value="MANUAL">{t('sellerErp.authority.MANUAL')}</option>
                  </Select>
                )}
              </Field>
            </div>
          </div>
        </section>
      )}

      {/* --- Check, then run ---------------------------------------------- */}
      <section className="flex flex-wrap gap-3">
        <Button
          isLoading={validate.isPending}
          onClick={() => {
            validate.mutate();
          }}
        >
          {t('sellerErp.validate')}
        </Button>

        <Button
          variant="primary"
          isLoading={initial.isPending}
          disabled={!connection.canSync}
          onClick={() => {
            initial.mutate();
          }}
        >
          {t('sellerErp.runInitialSync')}
        </Button>

        <Button
          variant="secondary"
          onClick={() => {
            toggleConnection.mutate(connection.state === 'DISABLED');
          }}
        >
          {connection.state === 'DISABLED'
            ? t('sellerErp.reconnect')
            : t('sellerErp.disconnect')}
        </Button>
      </section>

      {/* --- History ------------------------------------------------------ */}
      {(jobs.data?.rows ?? []).length > 0 && (
        <section>
          <h3 className="text-sm font-semibold">{t('sellerErp.jobs')}</h3>

          <ul className="mt-2 space-y-2">
            {(jobs.data?.rows ?? []).slice(0, 25).map((job) => (
              <li
                key={job.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"
              >
                <span>
                  <span className="font-medium">{job.eventType}</span>{' '}
                  <Badge
                    tone={
                      job.status === 'SUCCEEDED'
                        ? 'success'
                        : job.status === 'FAILED' || job.status === 'DEAD_LETTER'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {t(`sellerErp.job.status.${job.status}` as TranslationKey)}
                  </Badge>
                  {/* Tally's own words about what it refused, redacted of
                      anything from the seller's file system. Replacing it with
                      "failed" would throw away the only thing that says which
                      ledger to go and create. */}
                  {job.sanitizedError !== null && (
                    <span className="block text-xs text-danger">{job.sanitizedError}</span>
                  )}
                  <span className="block text-xs text-ink-muted">
                    {formatDateTime(job.createdAt)} ·{' '}
                    {job.externalVoucherNumber ?? `${String(job.attemptCount)}/${String(job.maxAttempts)}`}
                  </span>
                </span>

                <span className="flex gap-2">
                  {(job.status === 'FAILED' || job.status === 'DEAD_LETTER') && (
                    <Button
                      size="sm"
                      onClick={() => {
                        retry.mutate(job.id);
                      }}
                    >
                      {t('sellerErp.retry')}
                    </Button>
                  )}

                  {(job.status === 'PENDING' ||
                    job.status === 'RETRY_SCHEDULED' ||
                    job.status === 'FAILED') && (
                    <Button
                      size="sm"
                      onClick={() => {
                        cancel.mutate(job.id);
                      }}
                    >
                      {t('sellerErp.cancel')}
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Card>
  );
}
