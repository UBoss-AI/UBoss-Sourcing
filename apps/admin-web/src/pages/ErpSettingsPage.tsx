/**
 * Settings -> ERP.
 *
 * One screen for the whole thing: the connection, the field mapping, the two
 * buttons that prove it works, and what has happened since. A page of its own
 * rather than a panel on Settings, because the form is thirty fields.
 *
 * The order is the order somebody actually does it in - address and
 * credentials, then endpoints, then the mapping, then Test and Dry run, then
 * switch on. The switch-on button stays disabled with the server's own list of
 * blockers printed beside it, so nobody presses it to find out what is missing.
 *
 * **A secret left blank on an edit keeps what is stored.** The server never
 * sends a credential back, so this form never holds one; if blank meant "clear
 * it", editing the timeout would silently break a working connection. The
 * placeholder says so, and `buildConnectionBody` omits the field rather than
 * sending an empty string.
 */
import { useEffect, useState, type SyntheticEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  type BadgeTone,
} from '@/components/ui';
import { ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  type ConnectionFormValues,
  type ErpConnection,
  type ErpConnectionStatus,
  type ErpCredentialsInput,
  type ErpDryRunResult,
  type ErpEndpointKey,
  type ErpEndpointTest,
  type ErpHttpMethod,
  type ErpTestResult,
  buildConnectionBody,
  connectionToForm,
  emptyConnectionForm,
  erpApi,
  erpKeys,
} from '@/lib/erp';
import { useI18n, type Translate, type TranslationKey } from '@/i18n/i18n-context';

const ENDPOINT_KEYS: ErpEndpointKey[] = [
  'product',
  'inventory',
  'warehouse',
  'orderCreate',
  'orderStatus',
];

/** The panel's standard card body. Written once so the six cards agree. */
const BODY = 'space-y-4 px-5 py-4';

/**
 * The badge tone for a status.
 *
 * ERROR and DISABLED are deliberately different tones: one is a fault somebody
 * has to act on, the other is a decision somebody made.
 */
function statusTone(status: ErpConnectionStatus): BadgeTone {
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

function runTone(status: string): BadgeTone {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'PARTIAL' || status === 'RATE_LIMITED') return 'warning';
  if (status === 'FAILED') return 'danger';
  return 'neutral';
}

/**
 * The name of an event kind, translated.
 *
 * The list is repeated here rather than imported because the server sends the
 * type as a string: an installation on a newer backend can send a kind this
 * build has no name for, and showing the raw token beats showing a missing
 * key.
 */
const EVENT_TYPES = [
  'CONNECTION_TEST',
  'DRY_RUN',
  'ORDER_PUSH',
  'INVENTORY_SYNC',
  'INVENTORY_WEBHOOK',
  'ORDER_STATUS_POLL',
  'AUTOPAY_CHARGE',
] as const;

function eventLabel(t: Translate, eventType: string): string {
  return (EVENT_TYPES as readonly string[]).includes(eventType)
    ? t(`erp.event.${eventType as (typeof EVENT_TYPES)[number]}`)
    : eventType;
}

function eventTone(status: string): BadgeTone {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'ABANDONED') return 'danger';
  if (status === 'FAILED' || status === 'RETRY_SCHEDULED') return 'warning';
  return 'operational';
}

/**
 * The server's own message where there is one.
 *
 * The backend writes errors an administrator can act on - "Field mapping
 * problems: SKU: nothing was found at `sku`" - and replacing those with a
 * generic apology throws away the only useful part.
 */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError && error.message.length > 0 ? error.message : fallback;
}

export function ErpSettingsPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<ConnectionFormValues>(emptyConnectionForm);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<ErpTestResult | null>(null);
  const [dryRunResult, setDryRunResult] = useState<ErpDryRunResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const capabilities = useQuery({
    queryKey: erpKeys.capabilities,
    queryFn: () => erpApi.capabilities(),
  });

  const connections = useQuery({
    queryKey: erpKeys.connections,
    queryFn: () => erpApi.listConnections(),
    enabled: capabilities.data?.erpIntegration === true,
  });

  const selected =
    connections.data?.find((connection) => connection.id === selectedId) ??
    connections.data?.[0] ??
    null;

  const runs = useQuery({
    queryKey: erpKeys.syncRuns(selected?.id ?? ''),
    queryFn: () => erpApi.syncRuns(selected?.id ?? ''),
    enabled: selected !== null,
  });

  const inventory = useQuery({
    queryKey: erpKeys.inventory(selected?.id),
    queryFn: () => erpApi.inventory({ connectionId: selected?.id ?? '' }),
    enabled: selected !== null,
  });

  const events = useQuery({
    queryKey: erpKeys.events(selected?.id),
    queryFn: () => erpApi.events({ connectionId: selected?.id ?? '', limit: 15 }),
    enabled: selected !== null,
    // A retry booked for two minutes' time should appear without a reload.
    refetchInterval: 30_000,
  });

  // Follow the server's copy while not editing, so a Test or an Activate is
  // reflected in the form without a reload - and never while editing, which
  // would overwrite what somebody is halfway through typing.
  useEffect(() => {
    if (selected === null || editing) return;
    setValues(connectionToForm(selected));
  }, [selected, editing]);

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['erp'] });
  };

  const isEditingExisting = editing && selected !== null;

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      isEditingExisting ? erpApi.updateConnection(selected.id, body) : erpApi.createConnection(body),
    onSuccess: (connection) => {
      toast.success(t('erp.savedRunTestBeforeActivating'));
      setEditing(false);
      setSelectedId(connection.id);
      setFieldErrors({});
      setFormError(null);
      // An edit puts the connection back into Draft, so a result from before
      // the edit no longer describes it.
      setTestResult(null);
      setDryRunResult(null);
      refresh();
    },
    onError: (error: unknown) => {
      // Field-keyed where the server sent details, so the input that is wrong
      // is the one that lights up; a bare message goes to the top of the form.
      if (error instanceof ApiError && error.details.length > 0) {
        setFieldErrors(error.fieldErrors());
        setFormError(null);
      } else {
        setFieldErrors({});
        setFormError(messageOf(error, t('erp.theConnectionCouldNotBeSaved')));
      }
      toast.error(messageOf(error, t('erp.theConnectionCouldNotBeSaved')));
    },
  });

  const test = useMutation({
    mutationFn: () => erpApi.test(selected?.id ?? ''),
    onSuccess: (result) => {
      setTestResult(result);
      setDryRunResult(null);
      // A failed test is a RESULT, not an error: the request worked, and the
      // answer is in the body.
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(messageOf(error, t('erp.theTestCouldNotBeRun')));
    },
  });

  const dryRun = useMutation({
    mutationFn: () => erpApi.dryRun(selected?.id ?? ''),
    onSuccess: (result) => {
      setDryRunResult(result);
      setTestResult(null);
      if (result.ok) toast.success(result.message);
      else toast.info(result.message);
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(messageOf(error, t('erp.theDryRunCouldNotBeRun')));
    },
  });

  const sync = useMutation({
    mutationFn: () => erpApi.sync(selected?.id ?? ''),
    onSuccess: (result) => {
      if (result.status === 'SUCCEEDED') toast.success(result.message);
      else toast.info(result.message);
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(messageOf(error, t('erp.theSyncCouldNotBeRun')));
    },
  });

  const action = useMutation({
    mutationFn: (next: 'ACTIVATE' | 'PAUSE' | 'RESUME' | 'DISABLE' | 'REOPEN') =>
      erpApi.action(selected?.id ?? '', next),
    onSuccess: (connection) => {
      toast.success(t('erp.statusIsNow', { status: t(`erp.status.${connection.status}`) }));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(messageOf(error, t('common.statusCouldNotBeChanged')));
    },
  });

  const remove = useMutation({
    mutationFn: () => erpApi.deleteConnection(selected?.id ?? ''),
    onSuccess: () => {
      toast.success(t('erp.connectionDeleted'));
      setSelectedId(null);
      setConfirmDelete(false);
      setTestResult(null);
      setDryRunResult(null);
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(messageOf(error, t('erp.theConnectionCouldNotBeDeleted')));
    },
  });

  const retry = useMutation({
    mutationFn: (eventId: string) => erpApi.retryEvent(eventId),
    onSuccess: () => {
      toast.success(t('erp.queuedForAnotherAttempt'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(messageOf(error, t('erp.thatCouldNotBeRetried')));
    },
  });

  if (capabilities.isPending) return <LoadingState label={t('common.loading')} />;

  if (capabilities.isError) {
    return (
      <ErrorState
        error={capabilities.error}
        onRetry={() => {
          void capabilities.refetch();
        }}
      />
    );
  }

  if (!capabilities.data.erpIntegration) {
    return (
      <div>
        <PageHeader
          title={t('erp.heading')}
          description={t('erp.description')}
          back={{ to: '/settings', label: t('erp.backToSettings') }}
        />
        <Callout tone="info" title={t('erp.notEnabledTitle')}>
          {t('erp.notEnabledBody')}
        </Callout>
      </div>
    );
  }

  const rows = connections.data ?? [];
  const mappingFields = capabilities.data.mappingFields;
  const busy =
    test.isPending || dryRun.isPending || sync.isPending || action.isPending || remove.isPending;

  const set = <K extends keyof ConnectionFormValues>(
    key: K,
    value: ConnectionFormValues[K],
  ): void => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const setCredential = (key: keyof ErpCredentialsInput, value: string): void => {
    setValues((current) => ({
      ...current,
      credentials: { ...current.credentials, [key]: value },
    }));
  };

  const setMappingField = (fieldKey: string, path: string): void => {
    setValues((current) => {
      const trimmed = path.trim();

      // An emptied box means "do not map this field", which is an ABSENT key
      // rather than one holding an empty string - the server's validator reads
      // a present key as a mapping somebody intended.
      const fields = Object.fromEntries(
        Object.entries(current.fieldMapping.fields).filter(([key]) => key !== fieldKey),
      );

      if (trimmed !== '') fields[fieldKey] = trimmed;

      return { ...current, fieldMapping: { ...current.fieldMapping, fields } };
    });
  };

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault();
    setFieldErrors({});
    setFormError(null);
    save.mutate(buildConnectionBody(values, isEditingExisting));
  };

  const startEditing = (connection: ErpConnection | null): void => {
    setValues(connection === null ? emptyConnectionForm() : connectionToForm(connection));
    if (connection === null) setSelectedId(null);
    setFieldErrors({});
    setFormError(null);
    setEditing(true);
  };

  const secretPlaceholder = isEditingExisting ? t('erp.leaveBlankToKeep') : '';
  const showForm = editing || rows.length === 0;

  return (
    <div>
      <PageHeader
        title={t('erp.heading')}
        description={t('erp.description')}
        back={{ to: '/settings', label: t('erp.backToSettings') }}
        meta={
          selected !== null && !showForm ? (
            <Badge tone={statusTone(selected.status)} dot>
              {t(`erp.status.${selected.status}`)}
            </Badge>
          ) : undefined
        }
        actions={
          showForm ? undefined : (
            <>
              <Button
                onClick={() => {
                  startEditing(selected);
                }}
              >
                {t('erp.edit')}
              </Button>
              {rows.length < capabilities.data.maxConnections && (
                <Button
                  variant="primary"
                  onClick={() => {
                    startEditing(null);
                  }}
                >
                  {t('erp.addConnection')}
                </Button>
              )}
            </>
          )
        }
      />

      {/* --- Which connection --------------------------------------------- */}
      {rows.length > 1 && !showForm && (
        <div className="mb-6 flex flex-wrap gap-2">
          {rows.map((connection) => (
            <Button
              key={connection.id}
              variant={connection.id === selected?.id ? 'primary' : 'secondary'}
              size="sm"
              onClick={() => {
                setSelectedId(connection.id);
                setTestResult(null);
                setDryRunResult(null);
              }}
            >
              {connection.name}
              <Badge tone={statusTone(connection.status)}>
                {t(`erp.status.${connection.status}`)}
              </Badge>
            </Button>
          ))}
        </div>
      )}

      {showForm ? (
        <form onSubmit={submit} className="space-y-6" noValidate>
          {formError !== null && (
            <Callout tone="danger" role="alert" title={t('erp.theConnectionCouldNotBeSaved')}>
              {formError}
            </Callout>
          )}

          {/* --- Address --------------------------------------------------- */}
          <Card title={t('erp.form.basics')} bodyClassName={BODY}>
            <Field label={t('erp.form.name')} required error={fieldErrors['name']}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.name}
                  invalid={fieldErrors['name'] !== undefined}
                  placeholder="Production"
                  onChange={(event) => {
                    set('name', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field
              label={t('erp.form.baseUrl')}
              hint={t('erp.form.baseUrlHint')}
              required
              error={fieldErrors['baseUrl']}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={values.baseUrl}
                  invalid={fieldErrors['baseUrl'] !== undefined}
                  placeholder="https://erp.example.com/api/v2"
                  onChange={(event) => {
                    set('baseUrl', event.target.value);
                  }}
                />
              )}
            </Field>

            <Field label={t('erp.form.timeout')} hint={t('erp.form.timeoutHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  min={1}
                  max={60}
                  className="w-32"
                  value={values.timeoutSeconds}
                  onChange={(event) => {
                    set('timeoutSeconds', Number(event.target.value));
                  }}
                />
              )}
            </Field>
          </Card>

          {/* --- Authentication -------------------------------------------- */}
          <Card
            title={t('erp.form.authentication')}
            description={isEditingExisting ? t('erp.form.secretsAreHidden') : undefined}
            bodyClassName={BODY}
          >
            <Field label={t('erp.form.authMethod')} required>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  className="sm:max-w-xs"
                  value={values.authMethod}
                  onChange={(event) => {
                    set('authMethod', event.target.value as ConnectionFormValues['authMethod']);
                  }}
                >
                  <option value="API_KEY">{t('erp.auth.API_KEY')}</option>
                  <option value="BEARER_TOKEN">{t('erp.auth.BEARER_TOKEN')}</option>
                  <option value="BASIC">{t('erp.auth.BASIC')}</option>
                  <option value="OAUTH2">{t('erp.auth.OAUTH2')}</option>
                </Select>
              )}
            </Field>

            {isEditingExisting && selected.credentialHint !== null && (
              <p className="rounded bg-surface-sunken px-3 py-2 font-mono text-xs text-ink-muted">
                {t('erp.form.currentCredential')}: {selected.credentialHint}
              </p>
            )}

            {values.authMethod === 'API_KEY' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('erp.form.headerName')} hint={t('erp.form.headerNameHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={values.credentials.headerName ?? ''}
                      placeholder="X-API-Key"
                      onChange={(event) => {
                        setCredential('headerName', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  label={t('erp.form.apiKey')}
                  required={!isEditingExisting}
                  error={fieldErrors['credentials.apiKey']}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      type="password"
                      autoComplete="off"
                      placeholder={secretPlaceholder}
                      value={values.credentials.apiKey ?? ''}
                      onChange={(event) => {
                        setCredential('apiKey', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            {values.authMethod === 'BEARER_TOKEN' && (
              <Field
                label={t('erp.form.token')}
                required={!isEditingExisting}
                error={fieldErrors['credentials.token']}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    type="password"
                    autoComplete="off"
                    placeholder={secretPlaceholder}
                    value={values.credentials.token ?? ''}
                    onChange={(event) => {
                      setCredential('token', event.target.value);
                    }}
                  />
                )}
              </Field>
            )}

            {values.authMethod === 'BASIC' && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field
                  label={t('erp.form.username')}
                  required={!isEditingExisting}
                  error={fieldErrors['credentials.username']}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      autoComplete="off"
                      value={values.credentials.username ?? ''}
                      onChange={(event) => {
                        setCredential('username', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  label={t('erp.form.password')}
                  required={!isEditingExisting}
                  error={fieldErrors['credentials.password']}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      type="password"
                      autoComplete="off"
                      placeholder={secretPlaceholder}
                      value={values.credentials.password ?? ''}
                      onChange={(event) => {
                        setCredential('password', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            {values.authMethod === 'OAUTH2' && (
              <>
                <Field
                  label={t('erp.form.tokenUrl')}
                  hint={t('erp.form.tokenUrlHint')}
                  required
                  error={fieldErrors['oauthTokenUrl']}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={values.oauthTokenUrl}
                      invalid={fieldErrors['oauthTokenUrl'] !== undefined}
                      placeholder="https://id.example.com/oauth/token"
                      onChange={(event) => {
                        set('oauthTokenUrl', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label={t('erp.form.clientId')}
                    required={!isEditingExisting}
                    error={fieldErrors['credentials.clientId']}
                  >
                    {({ inputId, describedBy }) => (
                      <Input
                        id={inputId}
                        aria-describedby={describedBy}
                        autoComplete="off"
                        value={values.credentials.clientId ?? ''}
                        onChange={(event) => {
                          setCredential('clientId', event.target.value);
                        }}
                      />
                    )}
                  </Field>

                  <Field
                    label={t('erp.form.clientSecret')}
                    required={!isEditingExisting}
                    error={fieldErrors['credentials.clientSecret']}
                  >
                    {({ inputId, describedBy }) => (
                      <Input
                        id={inputId}
                        aria-describedby={describedBy}
                        type="password"
                        autoComplete="off"
                        placeholder={secretPlaceholder}
                        value={values.credentials.clientSecret ?? ''}
                        onChange={(event) => {
                          setCredential('clientSecret', event.target.value);
                        }}
                      />
                    )}
                  </Field>
                </div>

                <Field label={t('erp.form.scope')} hint={t('erp.form.scopeHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={values.oauthScope}
                      placeholder="inventory.read orders.write"
                      onChange={(event) => {
                        set('oauthScope', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </>
            )}
          </Card>

          {/* --- Endpoints -------------------------------------------------- */}
          <Card
            title={t('erp.form.endpoints')}
            description={t('erp.form.endpointsDescription')}
            bodyClassName={BODY}
          >
            {ENDPOINT_KEYS.map((key) => (
              <div key={key} className="grid gap-3 sm:grid-cols-[1fr_8rem]">
                <Field label={t(`erp.endpoint.${key}`)} error={fieldErrors[`endpoints.${key}`]}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      className="font-mono text-xs"
                      value={values.endpoints[key]}
                      invalid={fieldErrors[`endpoints.${key}`] !== undefined}
                      placeholder="/api/v2/stock"
                      onChange={(event) => {
                        setValues((current) => ({
                          ...current,
                          endpoints: { ...current.endpoints, [key]: event.target.value },
                        }));
                      }}
                    />
                  )}
                </Field>

                <Field label={t('erp.form.httpMethod')}>
                  {({ inputId }) => (
                    <Select
                      id={inputId}
                      value={values.methods[key] ?? (key === 'orderCreate' ? 'POST' : 'GET')}
                      onChange={(event) => {
                        set('methods', {
                          ...values.methods,
                          [key]: event.target.value as ErpHttpMethod,
                        });
                      }}
                    >
                      <option value="GET">GET</option>
                      <option value="POST">POST</option>
                      <option value="PUT">PUT</option>
                      <option value="PATCH">PATCH</option>
                    </Select>
                  )}
                </Field>
              </div>
            ))}
          </Card>

          {/* --- Field mapping ---------------------------------------------- */}
          <Card
            title={t('erp.form.fieldMapping')}
            description={t('erp.form.fieldMappingDescription')}
            bodyClassName={BODY}
          >
            <Field
              label={t('erp.form.itemsPath')}
              hint={t('erp.form.itemsPathHint')}
              error={fieldErrors['fieldMapping.itemsPath']}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  className="font-mono text-xs"
                  value={values.fieldMapping.itemsPath ?? ''}
                  placeholder="d.results"
                  onChange={(event) => {
                    set('fieldMapping', {
                      ...values.fieldMapping,
                      itemsPath: event.target.value,
                    });
                  }}
                />
              )}
            </Field>

            {/* Generated from what the server says it can read, so a field
                added to MAPPING_FIELDS appears here without a redeploy. */}
            <div className="grid gap-4 sm:grid-cols-2">
              {mappingFields.map((field) => (
                <Field
                  key={field.key}
                  label={field.label}
                  error={fieldErrors[`fieldMapping.fields.${field.key}`]}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      className="font-mono text-xs"
                      value={values.fieldMapping.fields[field.key] ?? ''}
                      invalid={fieldErrors[`fieldMapping.fields.${field.key}`] !== undefined}
                      placeholder={t('erp.form.pathPlaceholder')}
                      onChange={(event) => {
                        setMappingField(field.key, event.target.value);
                      }}
                    />
                  )}
                </Field>
              ))}
            </div>
          </Card>

          {/* --- Automation -------------------------------------------------- */}
          <Card
            title={t('erp.form.automation')}
            description={t('erp.form.automationDescription')}
            bodyClassName={BODY}
          >
            <label className="flex items-start gap-2.5 text-sm text-ink">
              <Checkbox
                className="mt-0.5"
                checked={values.orderPushEnabled}
                onChange={(event) => {
                  set('orderPushEnabled', event.target.checked);
                }}
              />
              <span>
                {t('erp.form.sendOrders')}
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {t('erp.form.sendOrdersHint')}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-2.5 text-sm text-ink">
              <Checkbox
                className="mt-0.5"
                checked={values.webhookEnabled}
                onChange={(event) => {
                  set('webhookEnabled', event.target.checked);
                }}
              />
              <span>
                {t('erp.form.useWebhooks')}
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {t('erp.form.useWebhooksHint')}
                </span>
              </span>
            </label>

            {values.webhookEnabled && (
              <div className="grid gap-4 border-l-2 border-border-subtle pl-4 sm:grid-cols-2">
                <Field label={t('erp.form.signingSecret')} hint={t('erp.form.signingSecretHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      type="password"
                      autoComplete="off"
                      placeholder={
                        isEditingExisting && selected.hasWebhookSecret ? secretPlaceholder : ''
                      }
                      value={values.webhookSecret}
                      onChange={(event) => {
                        set('webhookSecret', event.target.value);
                      }}
                    />
                  )}
                </Field>

                <Field
                  label={t('erp.form.signatureHeader')}
                  hint={t('erp.form.signatureHeaderHint')}
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      value={values.webhookSignatureHeader}
                      onChange={(event) => {
                        set('webhookSignatureHeader', event.target.value);
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            <label className="flex items-start gap-2.5 text-sm text-ink">
              <Checkbox
                className="mt-0.5"
                checked={values.pollingEnabled}
                onChange={(event) => {
                  set('pollingEnabled', event.target.checked);
                }}
              />
              <span>
                {t('erp.form.checkOnSchedule')}
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {t('erp.form.checkOnScheduleHint')}
                </span>
              </span>
            </label>

            {values.pollingEnabled && (
              <div className="border-l-2 border-border-subtle pl-4">
                <Field label={t('erp.form.checkEvery')} hint={t('erp.form.checkEveryHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      type="number"
                      min={5}
                      max={1440}
                      className="w-32"
                      value={values.pollingIntervalMinutes}
                      onChange={(event) => {
                        set('pollingIntervalMinutes', Number(event.target.value));
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            <Field label={t('erp.form.authority')} hint={t('erp.form.authorityHint')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  className="sm:max-w-xs"
                  value={values.inventoryAuthority}
                  onChange={(event) => {
                    set(
                      'inventoryAuthority',
                      event.target.value as ConnectionFormValues['inventoryAuthority'],
                    );
                  }}
                >
                  <option value="ERP">{t('erp.authority.ERP')}</option>
                  <option value="PLATFORM">{t('erp.authority.PLATFORM')}</option>
                  <option value="MANUAL">{t('erp.authority.MANUAL')}</option>
                </Select>
              )}
            </Field>

            <label className="flex items-start gap-2.5 text-sm text-ink">
              <Checkbox
                className="mt-0.5"
                checked={values.allowManualOverride}
                onChange={(event) => {
                  set('allowManualOverride', event.target.checked);
                }}
              />
              <span>
                {t('erp.form.allowManualOverride')}
                <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">
                  {t('erp.form.allowManualOverrideHint')}
                </span>
              </span>
            </label>

            <Callout tone="info" title={t('erp.stockIsAReportTitle')}>
              {t('erp.stockIsAReportBody')}
            </Callout>
          </Card>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" variant="primary" isLoading={save.isPending}>
              {isEditingExisting ? t('common.save') : t('erp.createConnection')}
            </Button>

            {rows.length > 0 && (
              <Button
                onClick={() => {
                  setEditing(false);
                  setFieldErrors({});
                  setFormError(null);
                }}
              >
                {t('common.cancel')}
              </Button>
            )}

            {isEditingExisting && (
              <p className="text-xs text-ink-muted">{t('erp.savingReturnsToDraft')}</p>
            )}
          </div>
        </form>
      ) : selected === null ? (
        <Card>
          <EmptyState
            title={t('erp.noConnectionTitle')}
            description={t('erp.noConnectionDescription')}
            action={
              <Button
                variant="primary"
                onClick={() => {
                  startEditing(null);
                }}
              >
                {t('erp.addConnection')}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {/* --- Status, and the buttons that change it -------------------- */}
          <Card title={t('erp.statusHeading')} bodyClassName={BODY}>
            <p className="truncate font-mono text-xs text-ink-muted">{selected.baseUrl}</p>

            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={statusTone(selected.status)} dot>
                {t(`erp.status.${selected.status}`)}
              </Badge>
              {selected.mappingVerifiedAt !== null && (
                <Badge tone="operational">{t('erp.mappingChecked')}</Badge>
              )}
              {selected.orderPushEnabled && <Badge tone="neutral">{t('erp.ordersSent')}</Badge>}
              {selected.webhookEnabled && <Badge tone="neutral">{t('erp.webhooksOn')}</Badge>}
              {selected.consecutiveFailures > 0 && (
                <Badge tone="warning">
                  {t('erp.consecutiveFailures', { count: selected.consecutiveFailures })}
                </Badge>
              )}
            </div>

            {selected.statusReason !== null && (
              <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
                {selected.statusReason}
              </p>
            )}

            {selected.status !== 'ACTIVE' && selected.activationBlockers.length > 0 && (
              <Callout tone="warning" title={t('erp.beforeSwitchingOn')}>
                <ul className="list-disc space-y-0.5 pl-5">
                  {selected.activationBlockers.map((blocker) => (
                    <li key={blocker}>{blocker}</li>
                  ))}
                </ul>
              </Callout>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                isLoading={test.isPending}
                disabled={busy}
                onClick={() => {
                  test.mutate();
                }}
              >
                {t('erp.testConnection')}
              </Button>

              <Button
                isLoading={dryRun.isPending}
                disabled={busy}
                onClick={() => {
                  dryRun.mutate();
                }}
              >
                {t('erp.dryRun')}
              </Button>

              {selected.availableActions.includes('ACTIVATE') && (
                <Button
                  variant="primary"
                  disabled={busy || selected.activationBlockers.length > 0}
                  onClick={() => {
                    action.mutate('ACTIVATE');
                  }}
                >
                  {t('erp.switchOn')}
                </Button>
              )}

              {selected.availableActions.includes('PAUSE') && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    action.mutate('PAUSE');
                  }}
                >
                  {t('erp.pause')}
                </Button>
              )}

              {selected.availableActions.includes('RESUME') && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    action.mutate('RESUME');
                  }}
                >
                  {t('erp.resume')}
                </Button>
              )}

              {selected.availableActions.includes('REOPEN') && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    action.mutate('REOPEN');
                  }}
                >
                  {t('erp.reopen')}
                </Button>
              )}

              {selected.availableActions.includes('DISABLE') && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    action.mutate('DISABLE');
                  }}
                >
                  {t('erp.switchOff')}
                </Button>
              )}

              {selected.status === 'ACTIVE' && (
                <Button
                  isLoading={sync.isPending}
                  disabled={busy}
                  onClick={() => {
                    sync.mutate();
                  }}
                >
                  {t('erp.syncNow')}
                </Button>
              )}
            </div>

            <p className="text-xs leading-relaxed text-ink-muted">{t('erp.testChangesNothing')}</p>

            <dl className="grid gap-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs text-ink-muted">{t('erp.lastSuccessfulSync')}</dt>
                <dd className="text-ink">{formatDateTime(selected.lastSyncSuccessAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">{t('erp.lastFailure')}</dt>
                <dd className="text-ink">{formatDateTime(selected.lastSyncFailureAt)}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-muted">{t('erp.nextCheck')}</dt>
                <dd className="text-ink">
                  {selected.pollingEnabled
                    ? formatDateTime(selected.nextPollAt)
                    : t('erp.pollingOff')}
                </dd>
              </div>
            </dl>

            {selected.webhookUrl !== null && (
              <div className="rounded-md bg-surface-sunken px-4 py-3">
                <p className="text-sm font-medium text-ink">{t('erp.webhookUrl')}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                  {t('erp.webhookUrlDescription')}
                </p>
                <code className="mt-2 block break-all rounded bg-surface px-2 py-1 font-mono text-xs text-ink">
                  {selected.webhookUrl}
                </code>
              </div>
            )}
          </Card>

          {testResult !== null && <TestResultCard result={testResult} />}
          {dryRunResult !== null && <DryRunCard result={dryRunResult} />}

          {/* --- What the last runs did ------------------------------------ */}
          {runs.isSuccess && runs.data.length > 0 && (
            <Card title={t('erp.recentSyncRuns')}>
              <ul className="divide-y divide-border-subtle">
                {runs.data.slice(0, 8).map((run) => (
                  <li
                    key={run.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-xs"
                  >
                    <Badge tone={runTone(run.status)}>{run.status}</Badge>
                    <span className="text-ink-muted">{formatDateTime(run.startedAt)}</span>
                    <span className="text-ink">
                      {t('erp.runCounts', {
                        processed: run.processedCount,
                        applied: run.appliedCount,
                        failed: run.failedCount,
                      })}
                    </span>
                    {run.isDryRun && <Badge tone="neutral">{t('erp.dryRun')}</Badge>}
                    {run.errorMessage !== null && (
                      <span className="w-full leading-relaxed text-ink-muted">
                        {run.errorMessage}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* --- What the ERP last said the stock was ---------------------- */}
          <Card title={t('erp.stockFromErp')} description={t('erp.stockFromErpDescription')}>
            {inventory.isPending ? (
              <LoadingState label={t('common.loading')} />
            ) : (inventory.data?.length ?? 0) === 0 ? (
              <EmptyState title={t('erp.noStockYet')} description={t('erp.noStockYetHint')} />
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-surface-sunken text-xs text-ink-muted">
                    <tr>
                      <th className="px-5 py-2 text-left font-medium">{t('erp.column.sku')}</th>
                      <th className="px-3 py-2 text-left font-medium">
                        {t('erp.column.warehouse')}
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        {t('erp.column.available')}
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        {t('erp.column.reserved')}
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        {t('erp.column.effective')}
                      </th>
                      <th className="px-5 py-2 text-left font-medium">{t('erp.column.lastSeen')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {(inventory.data ?? []).slice(0, 50).map((line) => (
                      <tr key={`${line.sku}:${line.warehouseKey}`}>
                        <td className="px-5 py-2">
                          <span className="flex items-center gap-2">
                            <span className="font-mono text-xs text-ink">{line.sku}</span>
                            {line.hasConflict && (
                              <Badge tone="warning">{t('erp.disagrees')}</Badge>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-ink-muted">
                          {line.warehouseKey === '' ? '—' : line.warehouseKey}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink">
                          {line.availableQuantity}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                          {line.reservedQuantity}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <span className="flex items-center justify-end gap-2">
                            <span className="tabular-nums font-medium text-ink">
                              {line.effectiveQuantity}
                            </span>
                            {line.manualQuantity !== null && (
                              <Badge tone="accent">{t('erp.setByHand')}</Badge>
                            )}
                          </span>
                        </td>
                        <td className="px-5 py-2 text-xs text-ink-muted">
                          {formatDateTime(line.lastSyncedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          {/* --- Activity ---------------------------------------------------- */}
          <Card title={t('erp.activity')} description={t('erp.activityDescription')}>
            {events.isPending ? (
              <LoadingState label={t('common.loading')} />
            ) : (events.data?.events.length ?? 0) === 0 ? (
              <EmptyState title={t('erp.noActivity')} />
            ) : (
              <ul className="divide-y divide-border-subtle">
                {(events.data?.events ?? []).map((event) => (
                  <li key={event.id} className="flex flex-wrap gap-x-4 gap-y-2 px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-ink">
                          {eventLabel(t, event.eventType)}
                        </span>
                        <Badge tone={eventTone(event.status)}>{event.status}</Badge>
                        {event.attemptCount > 1 && (
                          <span className="text-xs text-ink-muted">
                            {t('erp.attemptCount', { count: event.attemptCount })}
                          </span>
                        )}
                        {event.erpOrderReference !== null && (
                          <span className="font-mono text-xs text-ink-muted">
                            {event.erpOrderReference}
                          </span>
                        )}
                      </div>

                      {event.errorMessage !== null && (
                        <p className="mt-1 max-w-prose text-sm leading-relaxed text-ink-muted">
                          {event.errorMessage}
                        </p>
                      )}

                      <p className="mt-1 text-xs text-ink-subtle">
                        {formatDateTime(event.createdAt)}
                        {event.durationMs !== null && ` · ${event.durationMs} ms`}
                        {event.httpStatus !== null && ` · HTTP ${event.httpStatus}`}
                        {event.nextRetryAt !== null &&
                          ` · ${t('erp.nextAttempt', { when: formatDateTime(event.nextRetryAt) })}`}
                      </p>
                    </div>

                    {event.retryable && (
                      <Button
                        size="sm"
                        isLoading={retry.isPending && retry.variables === event.id}
                        onClick={() => {
                          retry.mutate(event.id);
                        }}
                      >
                        {t('erp.tryAgain')}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* --- Removal ----------------------------------------------------- */}
          <Card title={t('erp.deleteConnection')} tone="danger" bodyClassName={BODY}>
            <p className="max-w-prose text-sm leading-relaxed text-ink-muted">
              {t('erp.deleteConnectionDescription')}
            </p>

            {/* The name is named here rather than on the button, so the button
                label stays one short phrase in every language. */}
            <p className="text-sm font-medium text-ink">{selected.name}</p>

            {confirmDelete ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="danger"
                  isLoading={remove.isPending}
                  onClick={() => {
                    remove.mutate();
                  }}
                >
                  {t('erp.confirmDelete')}
                </Button>
                <Button
                  onClick={() => {
                    setConfirmDelete(false);
                  }}
                >
                  {t('common.cancel')}
                </Button>
              </div>
            ) : (
              <div>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmDelete(true);
                  }}
                >
                  {t('erp.delete')}
                </Button>
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

/**
 * How one endpoint fared.
 *
 * Three outcomes, not two. The order-creation endpoint comes back
 * `ok: true` with no status and no timing because it was deliberately NOT
 * called - and badging that "Reached" would be the one line on this card that
 * is not true.
 */
function endpointLabel(endpoint: ErpEndpointTest): TranslationKey {
  if (!endpoint.configured) return 'erp.notConfigured';
  if (endpoint.httpStatus === null && endpoint.durationMs === null) return 'erp.notCalled';
  return endpoint.ok ? 'erp.reached' : 'erp.failed';
}

function endpointTone(endpoint: ErpEndpointTest): BadgeTone {
  if (!endpoint.configured) return 'neutral';
  if (endpoint.httpStatus === null && endpoint.durationMs === null) return 'neutral';
  return endpoint.ok ? 'success' : 'danger';
}

/** What a test found, in the terms an administrator needs. */
function TestResultCard({ result }: { result: ErpTestResult }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('erp.testResult')} bodyClassName={BODY}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.ok ? 'success' : 'danger'} dot>
          {result.ok ? t('erp.testPassed') : t('erp.testFailed')}
        </Badge>
        {result.httpStatus !== null && <Badge tone="neutral">HTTP {result.httpStatus}</Badge>}
        {result.durationMs !== null && <Badge tone="neutral">{result.durationMs} ms</Badge>}
      </div>

      <p className="max-w-prose text-sm leading-relaxed text-ink">{result.message}</p>

      <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle text-sm">
        {result.endpoints.map((endpoint) => (
          <li key={endpoint.endpoint} className="flex flex-wrap items-center gap-3 px-3 py-2">
            <span className="w-32 font-medium text-ink">
              {t(`erp.endpoint.${endpoint.endpoint}`)}
            </span>
            <Badge tone={endpointTone(endpoint)}>{t(endpointLabel(endpoint))}</Badge>
            {endpoint.httpStatus !== null && (
              <span className="text-xs text-ink-muted">HTTP {endpoint.httpStatus}</span>
            )}
            {endpoint.durationMs !== null && (
              <span className="text-xs text-ink-muted">{endpoint.durationMs} ms</span>
            )}
            {endpoint.message !== null && (
              <span className="w-full text-xs leading-relaxed text-ink-muted">
                {endpoint.message}
              </span>
            )}
          </li>
        ))}
      </ul>

      {result.mapping.checked && result.mapping.issues.length > 0 && (
        <Callout tone="warning" title={t('erp.mappingProblems')}>
          <ul className="list-disc space-y-0.5 pl-5">
            {result.mapping.issues.map((issue) => (
              <li key={`${issue.field}:${issue.code}`}>{issue.message}</li>
            ))}
          </ul>
        </Callout>
      )}
    </Card>
  );
}

/**
 * What a dry run read, and what the mapping made of it.
 *
 * The preview table is the point: seeing "Price: EA" in a column is how
 * somebody discovers in two seconds that their price field is reading the
 * unit-of-measure column.
 */
function DryRunCard({ result }: { result: ErpDryRunResult }): React.JSX.Element {
  const { t } = useI18n();
  const columns = Object.keys(result.preview[0] ?? {});

  return (
    <Card title={t('erp.dryRunResult')} bodyClassName={BODY}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={result.ok ? 'success' : 'warning'} dot>
          {result.ok ? t('erp.mappingMatches') : t('erp.mappingDoesNotMatch')}
        </Badge>
        <Badge tone="neutral">{t('erp.recordsRead', { count: result.recordsFound })}</Badge>
        {result.itemsPath !== '' && (
          <Badge tone="neutral">{t('erp.readFrom', { path: result.itemsPath })}</Badge>
        )}
      </div>

      <p className="max-w-prose text-sm leading-relaxed text-ink">{result.message}</p>

      {result.issues.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-ink-muted">
          {result.issues.map((issue) => (
            <li key={`${issue.field}:${issue.code}`}>{issue.message}</li>
          ))}
        </ul>
      )}

      {columns.length > 0 && (
        // Its own scroll container: fourteen mapped fields is wider than a
        // laptop, and the page must never scroll sideways as a whole.
        <div className="overflow-x-auto rounded-md border border-border-subtle">
          <table className="min-w-full text-sm">
            <thead className="bg-surface-sunken text-xs text-ink-muted">
              <tr>
                {columns.map((column) => (
                  <th key={column} className="whitespace-nowrap px-3 py-2 text-left font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {result.preview.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column} className="whitespace-nowrap px-3 py-2 text-ink">
                      {row[column] ?? '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
