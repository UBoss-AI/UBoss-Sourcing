/**
 * Carrier connections.
 *
 * THE HONEST SCREEN. This is where a deployment finds out that DHL is not
 * actually connected, and it is written so that it cannot say otherwise:
 *
 *   - A provider with no credentials reads "Not configured", names the exact
 *     environment variables this build wants, and refuses to pretend a test
 *     succeeded. There is no state in which a green tick appears because a
 *     connection was never attempted.
 *   - `MANUAL` is the one that works out of the box, because it is not a
 *     connection at all - the carrier works inside the portal and every status
 *     comes from a person. It says that rather than claiming a healthy API.
 *   - The webhook signing secret is shown ONCE, when it is minted, in a dialog
 *     that says so. Nothing stores it, nothing caches it, and there is no
 *     endpoint that reads it back. Losing it means rotating again, which is
 *     the correct trade and is stated on screen.
 *   - The stored credential is summarised by a hint taken from the ENCRYPTED
 *     envelope, never from the plaintext. Enough to tell two saved keys apart,
 *     useless to anybody who copies it out of a screenshot.
 *
 * Status mapping sits underneath each connection. A carrier code this build
 * does not recognise is not dropped and does not crash anything - it is saved
 * whole, queued as unmapped, and turns up here to be given a meaning.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  CheckboxField,
  DescriptionList,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  fetchIntegrations,
  fetchKnownCodes,
  integrationStateKey,
  integrationStateTone,
  rotateWebhookSecret,
  saveIntegration,
  saveStatusMapping,
  statusLabelKey,
  testIntegration,
  type CarrierIntegrationRow,
  type CarrierProvider,
  type ProviderRequirement,
  type ShipmentStatus,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';

const PROVIDERS: readonly CarrierProvider[] = ['MANUAL', 'CUSTOM', 'DHL', 'FEDEX', 'UPS'];

export function LogisticsIntegrationsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const [isAdding, setIsAdding] = useState(false);

  const query = useQuery({
    queryKey: ['admin', 'logistics', 'integrations'],
    queryFn: fetchIntegrations,
  });

  const mayWrite = can(Permission.LOGISTICS_INTEGRATION_WRITE);

  if (query.isPending) return <LoadingState label={t('logistics.integrations.loading')} />;

  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const { integrations, providers } = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('logistics.integrations.heading')}
        description={t('logistics.integrations.intro')}
        actions={
          mayWrite ? (
            <Button
              onClick={() => {
                setIsAdding(true);
              }}
            >
              {t('logistics.integrations.add')}
            </Button>
          ) : undefined
        }
      />

      <Callout tone="info" title={t('logistics.integrations.whereCredentialsLive')}>
        {t('logistics.integrations.credentialsPolicy')}
      </Callout>

      {integrations.length === 0 ? (
        <EmptyState
          title={t('logistics.integrations.emptyTitle')}
          description={t('logistics.integrations.emptyBody')}
        />
      ) : (
        <div className="space-y-5">
          {integrations.map((integration) => (
            <IntegrationCard
              key={integration.id}
              integration={integration}
              requirement={providers.find((entry) => entry.provider === integration.provider)}
              mayWrite={mayWrite}
            />
          ))}
        </div>
      )}

      <Card title={t('logistics.integrations.whatEachNeeds')}>
        <ul className="divide-y divide-border-subtle">
          {providers.map((provider) => (
            <li key={provider.provider} className="px-5 py-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {provider.provider}
                {provider.worksOutOfTheBox && (
                  <Badge tone="success">{t('logistics.integrations.noSetupNeeded')}</Badge>
                )}
              </p>
              <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                {provider.requires.length === 0
                  ? t('logistics.integrations.requiresNothing')
                  : t('logistics.integrations.requires', {
                      list: provider.requires.join(', '),
                    })}
              </p>
            </li>
          ))}
        </ul>
      </Card>

      <IntegrationDialog
        isOpen={isAdding}
        onClose={() => {
          setIsAdding(false);
        }}
        providers={providers}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One connection
// ---------------------------------------------------------------------------

function IntegrationCard({
  integration,
  requirement,
  mayWrite,
}: {
  integration: CarrierIntegrationRow;
  requirement: ProviderRequirement | undefined;
  mayWrite: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [rotated, setRotated] = useState<{ secret: string; notice: string } | null>(null);
  const [isMapping, setIsMapping] = useState(false);

  const test = useMutation({
    mutationFn: () => testIntegration(integration.id),
    onSuccess: (result) => {
      // The server's own verdict, verbatim, whichever way it went. A test that
      // failed is reported as a failure - never softened into "check your
      // settings", which is how a deployment ends up believing it is connected.
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'integrations'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const rotate = useMutation({
    mutationFn: () => rotateWebhookSecret(integration.id),
    onSuccess: (result) => {
      setRotated({ secret: result.secret, notice: result.notice });
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'integrations'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const isUnconfigured = integration.state === 'UNCONFIGURED';

  return (
    <Card
      title={integration.name}
      description={t('logistics.integrations.provider', { provider: integration.provider })}
      bodyClassName="px-5 py-4"
      actions={
        <div className="flex flex-wrap gap-2">
          {mayWrite && (
            <>
              <Button
                size="sm"
                variant="secondary"
                disabled={test.isPending}
                onClick={() => {
                  test.mutate();
                }}
              >
                {t('logistics.integrations.test')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setIsMapping(true);
                }}
              >
                {t('logistics.integrations.mapCodes')}
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={rotate.isPending}
                onClick={() => {
                  rotate.mutate();
                }}
              >
                {t('logistics.integrations.rotate')}
              </Button>
            </>
          )}
        </div>
      }
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={integrationStateTone(integration.state)} dot>
          {t(integrationStateKey(integration.state))}
        </Badge>
        {!integration.isActive && (
          <Badge tone="neutral">{t('logistics.integrations.switchedOff')}</Badge>
        )}
        {integration.deadLetteredEvents > 0 && (
          <Badge tone="danger">
            {t('logistics.integrations.deadLettered', {
              events: formatNumber(integration.deadLetteredEvents),
            })}
          </Badge>
        )}
      </div>

      {isUnconfigured && (
        <Callout
          tone="warning"
          title={t('logistics.integrations.notConfiguredTitle')}
          role="status"
          className="mb-3"
        >
          <p>{t('logistics.integrations.notConfiguredBody')}</p>
          {requirement !== undefined && requirement.requires.length > 0 && (
            <p className="mt-2 font-mono text-xs">{requirement.requires.join(', ')}</p>
          )}
        </Callout>
      )}

      {integration.consecutiveFailures > 0 && integration.lastFailureMessage !== null && (
        <Callout tone="danger" title={t('logistics.integrations.failingTitle')} className="mb-3">
          <p>{integration.lastFailureMessage}</p>
          <p className="mt-1 text-xs">
            {t('logistics.integrations.failingSince', {
              failures: formatNumber(integration.consecutiveFailures),
              when: formatDateTime(integration.lastFailureAt),
            })}
          </p>
        </Callout>
      )}

      <DescriptionList
        columns={2}
        items={[
          {
            label: t('logistics.integrations.field.webhookUrl'),
            value: <code className="break-all text-xs">{integration.webhookUrl}</code>,
          },
          {
            label: t('logistics.integrations.field.signingSecret'),
            value: integration.hasWebhookSecret
              ? t('logistics.integrations.secretSet')
              : t('logistics.integrations.secretMissing'),
          },
          {
            label: t('logistics.integrations.field.credential'),
            value:
              integration.credentialHint === null
                ? t('logistics.integrations.noCredential')
                : integration.credentialHint,
          },
          {
            label: t('logistics.integrations.field.baseUrl'),
            value: integration.baseUrl ?? '—',
          },
          {
            label: t('logistics.integrations.field.polling'),
            value: integration.pollingEnabled
              ? t('logistics.integrations.pollingEvery', {
                  minutes: formatNumber(integration.pollingIntervalMinutes),
                })
              : t('logistics.integrations.pollingOff'),
          },
          {
            label: t('logistics.integrations.field.lastSuccess'),
            value: formatDateTime(integration.lastSuccessAt),
          },
        ]}
      />

      <SecretDialog
        rotated={rotated}
        webhookUrl={integration.webhookUrl}
        onClose={() => {
          setRotated(null);
        }}
      />

      <MappingDialog
        integration={integration}
        isOpen={isMapping}
        onClose={() => {
          setIsMapping(false);
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The one sighting of a secret
// ---------------------------------------------------------------------------

function SecretDialog({
  rotated,
  webhookUrl,
  onClose,
}: {
  rotated: { secret: string; notice: string } | null;
  webhookUrl: string;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Modal
      isOpen={rotated !== null}
      onClose={onClose}
      title={t('logistics.integrations.newSecret')}
      size="lg"
      footer={<Button onClick={onClose}>{t('logistics.integrations.copiedIt')}</Button>}
    >
      {rotated !== null && (
        <div className="space-y-4">
          {/* The server's own wording. It is written to be read once, by
              somebody about to close a dialog they cannot reopen. */}
          <Callout tone="warning" role="alert">
            {rotated.notice}
          </Callout>

          <Field label={t('logistics.integrations.field.signingSecret')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                readOnly
                value={rotated.secret}
                className="font-mono"
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
              />
            )}
          </Field>

          <Field label={t('logistics.integrations.field.webhookUrl')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                readOnly
                value={webhookUrl}
                className="font-mono"
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
              />
            )}
          </Field>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

function MappingDialog({
  integration,
  isOpen,
  onClose,
}: {
  integration: CarrierIntegrationRow;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [providerCode, setProviderCode] = useState('');
  const [canonicalStatus, setCanonicalStatus] = useState<ShipmentStatus | ''>('');
  const [publicDescription, setPublicDescription] = useState('');

  const known = useQuery({
    queryKey: ['admin', 'logistics', 'known-codes', integration.provider],
    queryFn: () => fetchKnownCodes(integration.provider),
    enabled: isOpen,
  });

  const save = useMutation({
    mutationFn: () =>
      saveStatusMapping(integration.id, {
        providerCode: providerCode.trim(),
        // Null is a real choice: it means "this code is noise, ignore it"
        // rather than "no mapping yet".
        canonicalStatus: canonicalStatus === '' ? null : canonicalStatus,
        ...(publicDescription.trim().length > 0
          ? { publicDescription: publicDescription.trim() }
          : {}),
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setProviderCode('');
      setCanonicalStatus('');
      setPublicDescription('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'integrations'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('logistics.integrations.mapCodes')}
      description={t('logistics.integrations.mapIntro')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button
            disabled={providerCode.trim().length === 0 || save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('logistics.integrations.field.providerCode')}
            hint={t('logistics.integrations.field.providerCodeHint')}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={providerCode}
                onChange={(event) => {
                  setProviderCode(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          <Field
            label={t('logistics.integrations.field.mapsTo')}
            hint={t('logistics.integrations.field.mapsToHint')}
          >
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={canonicalStatus}
                onChange={(event) => {
                  setCanonicalStatus(event.currentTarget.value as ShipmentStatus | '');
                }}
              >
                <option value="">{t('logistics.integrations.ignoreCode')}</option>
                {MAPPABLE_STATUSES.map((value) => (
                  <option key={value} value={value}>
                    {t(statusLabelKey(value))}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Field
          label={t('logistics.integrations.field.publicDescription')}
          hint={t('logistics.integrations.field.publicDescriptionHint')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={publicDescription}
              onChange={(event) => {
                setPublicDescription(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
            {t('logistics.integrations.knownCodes')}
          </h3>

          {known.isPending ? (
            <LoadingState />
          ) : (known.data?.codes.length ?? 0) === 0 ? (
            <p className="text-xs text-ink-muted">{t('logistics.integrations.noKnownCodes')}</p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border bg-surface-sunken p-2">
              {(known.data?.codes ?? []).map((entry) => (
                <li key={entry.code} className="flex items-baseline gap-2 text-xs">
                  <button
                    type="button"
                    className="rounded font-mono text-accent hover:underline"
                    onClick={() => {
                      setProviderCode(entry.code);
                      setCanonicalStatus(entry.status ?? '');
                    }}
                  >
                    {entry.code}
                  </button>
                  <span className="text-ink-muted">
                    {entry.status === null
                      ? t('logistics.integrations.ignored')
                      : t(statusLabelKey(entry.status))}
                  </span>
                  <span className="truncate text-ink-subtle">{entry.description}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Adding a connection
// ---------------------------------------------------------------------------

function IntegrationDialog({
  isOpen,
  onClose,
  providers,
}: {
  isOpen: boolean;
  onClose: () => void;
  providers: ProviderRequirement[];
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [provider, setProvider] = useState<CarrierProvider>('MANUAL');
  const [name, setName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [pollingEnabled, setPollingEnabled] = useState(false);
  const [isActive, setIsActive] = useState(true);

  const requirement = providers.find((entry) => entry.provider === provider);

  const save = useMutation({
    mutationFn: () =>
      saveIntegration({
        provider,
        name: name.trim(),
        ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
        pollingEnabled,
        isActive,
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setName('');
      setBaseUrl('');
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'integrations'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('logistics.integrations.add')}
      description={t('logistics.integrations.addIntro')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={name.trim().length < 2 || save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('logistics.integrations.field.provider')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={provider}
              onChange={(event) => {
                setProvider(event.currentTarget.value as CarrierProvider);
              }}
            >
              {PROVIDERS.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {requirement !== undefined && !requirement.worksOutOfTheBox && (
          <Callout tone="info" title={t('logistics.integrations.willNeedCredentials')}>
            <p>{t('logistics.integrations.credentialsAfterwards')}</p>
            {requirement.requires.length > 0 && (
              <p className="mt-2 font-mono text-xs">{requirement.requires.join(', ')}</p>
            )}
          </Callout>
        )}

        <Field label={t('logistics.integrations.field.name')} required>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={name}
              onChange={(event) => {
                setName(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <Field
          label={t('logistics.integrations.field.baseUrl')}
          hint={t('logistics.integrations.field.baseUrlHint')}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={baseUrl}
              onChange={(event) => {
                setBaseUrl(event.currentTarget.value);
              }}
            />
          )}
        </Field>

        <CheckboxField
          label={t('logistics.integrations.field.polling')}
          description={t('logistics.integrations.field.pollingHint')}
          checked={pollingEnabled}
          onChange={(event) => {
            setPollingEnabled(event.currentTarget.checked);
          }}
        />

        <CheckboxField
          label={t('logistics.integrations.field.active')}
          checked={isActive}
          onChange={(event) => {
            setIsActive(event.currentTarget.checked);
          }}
        />
      </div>
    </Modal>
  );
}

/**
 * The statuses a carrier code may be mapped onto.
 *
 * Everything except the ones only this marketplace can decide: a carrier does
 * not get to tell us a consignment was CREATED, assigned, or cancelled by us.
 */
const MAPPABLE_STATUSES: readonly ShipmentStatus[] = [
  'PICKUP_SCHEDULED',
  'READY_FOR_PICKUP',
  'PICKED_UP',
  'DISPATCHED',
  'AT_ORIGIN_HUB',
  'IN_TRANSIT',
  'AT_DESTINATION_HUB',
  'OUT_FOR_DELIVERY',
  'DELIVERY_ATTEMPTED',
  'DELIVERED',
  'DELAYED',
  'ON_HOLD',
  'ADDRESS_ISSUE',
  'CUSTOMS_HOLD',
  'DAMAGED',
  'TEMPERATURE_EXCEPTION',
  'DELIVERY_FAILED',
  'RETURN_REQUESTED',
  'RETURN_IN_TRANSIT',
  'RETURNED',
  'LOST',
];
