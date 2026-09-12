/**
 * The setup wizard: six steps from "which system" to "switched on".
 *
 * Used for creating a connection and for editing one, because they are the same
 * six questions and a separate edit form is how the two drift until the edit
 * screen is missing a field the create screen added.
 *
 * WHY THE CONNECTION IS SAVED AFTER STEP TWO RATHER THAN AT THE END
 *
 * Steps three to six all need a connection that exists: the endpoint step
 * validates paths against the saved base URL, the OAuth button needs somewhere
 * to put the tokens, and the mapping check needs a real response from a real
 * call. So the first two steps create a DRAFT, and everything after that edits
 * it. A draft is inert - it carries no traffic, runs no jobs and is not
 * selectable by anything - so an abandoned wizard leaves a row and no
 * consequences.
 *
 * ONLY THE RELEVANT FIELDS RENDER
 *
 * SAP's company code does not appear for monday.com. A client secret does not
 * appear for an API-key connection, and does not appear at all for a monday
 * production connection, where the app is the operator's and the buyer never
 * sees a secret. A form that showed every field for every system would be a
 * form nobody could fill in correctly, and the fields it showed in error would
 * be the ones people guessed at.
 *
 * SECRETS ARE WRITE-ONLY, AND SILENCE MEANS "KEEP IT"
 *
 * A secret input starts empty even when one is stored, with the hint beside it
 * saying which key is installed. Leaving it empty sends nothing and the stored
 * secret survives; typing into it replaces it. That is the only shape that lets
 * somebody change a timeout without retyping their SAP client secret.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  ButtonLink,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { AlertIcon, CheckIcon, ChevronRightIcon } from '@/components/icons';
import { ApiError } from '@/lib/api';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import {
  customerErpApi,
  erpKeys,
  inputToMinor,
  isFullConnection,
  minorToInput,
  type ConnectionInput,
  type ConnectionView,
  type EndpointView,
  type ErpAuthMethod,
  type ErpEnvironment,
  type ErpMappingEntity,
  type ErpRegion,
  type ErpSystem,
  type MappingRow,
  type SampleCheck,
  type SystemOption,
  type VendorPresetOption,
  type WarehouseMapView,
} from '@/lib/customer-erp';
import { AccountPanel } from '../AccountPanel';
import {
  AUTH_LABEL,
  AUTH_NOTE,
  ENDPOINT_LABEL,
  ENTITY_LABEL,
  NETWORK_LABEL,
  NETWORK_NOTE,
  SYSTEM_DESCRIPTION,
  SYSTEM_LABEL,
  isInteractiveOAuth,
  needsMondayPlacement,
  needsSapPlacement,
  secretFieldsFor,
} from './erp-labels';

type StepId = 'system' | 'connection' | 'network' | 'endpoints' | 'mapping' | 'rules';

const STEPS: readonly { id: StepId; labelKey: Parameters<ReturnType<typeof useI18n>['t']>[0] }[] = [
  { id: 'system', labelKey: 'erp.wizard.stepSystem' },
  { id: 'connection', labelKey: 'erp.wizard.stepConnection' },
  { id: 'network', labelKey: 'erp.wizard.stepNetwork' },
  { id: 'endpoints', labelKey: 'erp.wizard.stepEndpoints' },
  { id: 'mapping', labelKey: 'erp.wizard.stepMapping' },
  { id: 'rules', labelKey: 'erp.wizard.stepRules' },
];

export function ErpWizardPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  const { id } = useParams<{ id?: string }>();
  const isEditing = id !== undefined;

  const [step, setStep] = useState<StepId>(isEditing ? 'connection' : 'system');
  const [connectionId, setConnectionId] = useState<string | null>(id ?? null);

  // --- Step 1 ------------------------------------------------------------
  const [system, setSystem] = useState<ErpSystem>('SAP');
  const [vendorPreset, setVendorPreset] = useState<string | null>(null);
  const [presetSearch, setPresetSearch] = useState('');
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<ErpEnvironment>('SANDBOX');
  const [erpVersion, setErpVersion] = useState('');

  // --- Step 2 ------------------------------------------------------------
  const [baseUrl, setBaseUrl] = useState('');
  const [authMethod, setAuthMethod] = useState<ErpAuthMethod>('OAUTH2_CLIENT_CREDENTIALS');
  const [apiVersion, setApiVersion] = useState('');
  const [tenantIdentifier, setTenantIdentifier] = useState('');
  const [apiKeyName, setApiKeyName] = useState('');
  const [apiKeyLocation, setApiKeyLocation] = useState<'HEADER' | 'QUERY'>('HEADER');
  const [oauthTokenUrl, setOauthTokenUrl] = useState('');
  const [oauthAuthorizationUrl, setOauthAuthorizationUrl] = useState('');
  const [oauthScope, setOauthScope] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [headersText, setHeadersText] = useState('');

  // SAP placement
  const [sapCompanyCode, setSapCompanyCode] = useState('');
  const [sapPurchasingOrg, setSapPurchasingOrg] = useState('');
  const [sapPurchasingGroup, setSapPurchasingGroup] = useState('');
  const [sapPlant, setSapPlant] = useState('');
  const [sapStorageLocation, setSapStorageLocation] = useState('');

  // monday placement
  const [mondayWorkspaceId, setMondayWorkspaceId] = useState('');
  const [mondayBoardId, setMondayBoardId] = useState('');
  const [mondayGroupId, setMondayGroupId] = useState('');

  // --- Step 3 ------------------------------------------------------------
  const [networkMode, setNetworkMode] = useState<ConnectionInput['networkMode']>('PUBLIC_HTTPS');
  const [networkNotes, setNetworkNotes] = useState('');

  /*
   * Which market's ERPs to list first.
   *
   * Read from the currency this deployment is configured with rather than from
   * anything about the person: it is the operator who knows which systems their
   * customers run, and it decides ordering only - every preset is offered
   * whatever the answer, and the search box reaches all of them.
   */
  const region = regionForCurrency(business.currency);

  const options = useQuery({
    queryKey: erpKeys.options(environment, region),
    queryFn: () => customerErpApi.options(environment, region),
  });

  const existing = useQuery({
    queryKey: erpKeys.connection(id ?? ''),
    queryFn: () => customerErpApi.connection(id ?? ''),
    enabled: isEditing,
  });

  useDocumentMeta(
    { title: isEditing ? t('erp.wizard.editTitle') : t('erp.wizard.title'), noIndex: true },
    business.displayName,
  );

  /*
   * Fill the form from the connection being edited, once.
   *
   * Secrets are deliberately NOT filled: the server never returns one, and an
   * input pre-filled with dots would send those dots back as the new secret the
   * first time somebody saved an unrelated field.
   */
  const loaded = existing.data?.connection;

  useEffect(() => {
    if (loaded === undefined || !isFullConnection(loaded)) return;

    setSystem(loaded.system);
    setVendorPreset(loaded.vendorPreset);
    setName(loaded.name);
    setEnvironment(loaded.environment);
    setErpVersion(loaded.erpVersion ?? '');
    setBaseUrl(loaded.baseUrl);
    setAuthMethod(loaded.authMethod);
    setApiVersion(loaded.apiVersion ?? '');
    setTenantIdentifier(loaded.tenantIdentifier ?? '');
    setApiKeyName(loaded.apiKeyName ?? '');
    setApiKeyLocation(loaded.apiKeyLocation ?? 'HEADER');
    setOauthTokenUrl(loaded.oauthTokenUrl ?? '');
    setOauthAuthorizationUrl(loaded.oauthAuthorizationUrl ?? '');
    setOauthScope(loaded.oauthScope ?? '');
    setNetworkMode(loaded.networkMode);
    setNetworkNotes(loaded.networkNotes ?? '');
    setSapCompanyCode(loaded.sap.companyCode ?? '');
    setSapPurchasingOrg(loaded.sap.purchasingOrg ?? '');
    setSapPurchasingGroup(loaded.sap.purchasingGroup ?? '');
    setSapPlant(loaded.sap.plant ?? '');
    setSapStorageLocation(loaded.sap.storageLocation ?? '');
    setMondayWorkspaceId(loaded.monday.workspaceId ?? '');
    setMondayBoardId(loaded.monday.boardId ?? '');
    setMondayGroupId(loaded.monday.groupId ?? '');
    setHeadersText(
      Object.entries(loaded.customHeaders)
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n'),
    );
    setConnectionId(loaded.id);
  }, [loaded, isEditing]);

  const chosen: SystemOption | undefined = options.data?.systems.find(
    (entry) => entry.system === system,
  );

  /*
   * Memoised for the identity rather than the cost. `?? []` builds a new array
   * on every render, and an array that is a new object each time is a
   * dependency that changes each time - which would re-filter the catalogue on
   * every keystroke anywhere on the page.
   */
  const presets = useMemo(() => options.data?.presets ?? [], [options.data]);

  const preset: VendorPresetOption | undefined = presets.find(
    (entry) => entry.id === vendorPreset,
  );

  /*
   * The catalogue, narrowed by what was typed.
   *
   * Substring rather than fuzzy: a buyer typing "dyn" is looking for Dynamics,
   * and a match that also offered them Odoo because both contain a "d" and an
   * "n" would make the list less trustworthy, not more. The connector name is
   * searched too, so "custom" still finds the escape hatch.
   */
  const visiblePresets = useMemo(() => {
    const needle = presetSearch.trim().toLowerCase();
    if (needle.length === 0) return presets;

    return presets.filter(
      (entry) =>
        entry.label.toLowerCase().includes(needle) ||
        entry.id.includes(needle) ||
        entry.connector.toLowerCase().includes(needle),
    );
  }, [presets, presetSearch]);

  /**
   * Picking a brand.
   *
   * It sets three things: which catalogue entry this is, which connector speaks
   * to it, and - only where the buyer has not named the connection themselves -
   * a name. "Still called SAP S/4HANA" on a NetSuite connection is a small
   * error that survives into every screen, so a name this function put there is
   * replaced while one that was typed is left alone.
   */
  const choosePreset = (entry: VendorPresetOption): void => {
    const previousLabel = presets.find((row) => row.id === vendorPreset)?.label ?? '';

    setVendorPreset(entry.id);
    setSystem(entry.connector);
    setName((current) =>
      current.trim().length === 0 || current === previousLabel ? entry.label : current,
    );
  };

  /*
   * The default authentication method, applied whenever the choice changes and
   * never over something the buyer has already picked.
   *
   * The PRESET's list wins over the connector's where there is one, and it is
   * usually narrower for a good reason: the CUSTOM connector speaks five
   * methods, while SAP Business One's Service Layer offers exactly two. Showing
   * a buyer three ways to authenticate that their own system does not accept is
   * three ways to waste an afternoon.
   *
   * Both lists arrive already narrowed to the chosen ENVIRONMENT, which is why
   * the options query is keyed on it. An EMPTY list is therefore a real answer
   * and not a loading state: it means this vendor cannot be connected in this
   * environment on this deployment, and the screen says so where the choice was
   * made instead of letting the buyer fill in six more steps and be refused.
   */
  const offeredAuthMethods = preset?.authMethods ?? chosen?.authMethods;
  const noAuthMethodAvailable = offeredAuthMethods !== undefined && offeredAuthMethods.length === 0;

  useEffect(() => {
    if (offeredAuthMethods === undefined || isEditing) return;
    const first = offeredAuthMethods[0];

    if (first !== undefined && !offeredAuthMethods.includes(authMethod)) {
      setAuthMethod(first);
    }

    if (system === 'MONDAY' && baseUrl.length === 0) setBaseUrl('https://api.monday.com');
  }, [offeredAuthMethods, system, authMethod, baseUrl.length, isEditing]);

  /*
   * Addresses the buyer is not asked for, because there is only one right
   * answer and the server is going to use it regardless of what is typed here.
   *
   * Set for a SaaS that publishes one authorisation and one token endpoint -
   * monday - and null for everything self-hosted, where only the buyer knows.
   */
  const fixedAuthorizationUrl = chosen?.oauthAuthorizationUrl ?? null;
  const fixedTokenUrl = chosen?.oauthTokenUrl ?? null;

  /*
   * Whether this connection authorises through the STORE's registered
   * application rather than one of the buyer's own.
   *
   * The same condition the server derives `oauthUsesPlatformApp` from, minus
   * the half only the server can know - whether an application is registered at
   * all. It does not need to: where none is, monday's interactive OAuth is not
   * offered on this screen in the first place, so reaching this with both
   * halves true means the store has one. It decides which fields are the
   * buyer's to fill in: not the client secret, not the permissions, and not the
   * redirect address, because none of the three is theirs.
   */
  const usesPlatformApp = system === 'MONDAY' && isInteractiveOAuth(authMethod);

  useEffect(() => {
    if (fixedAuthorizationUrl !== null) setOauthAuthorizationUrl(fixedAuthorizationUrl);
    if (fixedTokenUrl !== null) setOauthTokenUrl(fixedTokenUrl);
  }, [fixedAuthorizationUrl, fixedTokenUrl]);

  const body = (): ConnectionInput => ({
    name: name.trim(),
    system,
    vendorPreset,
    environment,
    erpVersion: erpVersion.trim().length === 0 ? null : erpVersion.trim(),
    baseUrl: baseUrl.trim(),
    apiVersion: apiVersion.trim().length === 0 ? null : apiVersion.trim(),
    authMethod,
    apiKeyLocation: authMethod === 'API_KEY' ? apiKeyLocation : null,
    apiKeyName: authMethod === 'API_KEY' ? apiKeyName.trim() : null,
    oauthTokenUrl: oauthTokenUrl.trim().length === 0 ? null : oauthTokenUrl.trim(),
    oauthAuthorizationUrl:
      oauthAuthorizationUrl.trim().length === 0 ? null : oauthAuthorizationUrl.trim(),
    oauthScope: oauthScope.trim().length === 0 ? null : oauthScope.trim(),
    tenantIdentifier: tenantIdentifier.trim().length === 0 ? null : tenantIdentifier.trim(),
    ...(networkMode === undefined ? {} : { networkMode }),
    networkNotes: networkNotes.trim().length === 0 ? null : networkNotes.trim(),
    customHeaders: parseHeaders(headersText),
    ...(needsSapPlacement(system)
      ? {
          sapCompanyCode: blankToNull(sapCompanyCode),
          sapPurchasingOrg: blankToNull(sapPurchasingOrg),
          sapPurchasingGroup: blankToNull(sapPurchasingGroup),
          sapPlant: blankToNull(sapPlant),
          sapStorageLocation: blankToNull(sapStorageLocation),
        }
      : {}),
    ...(needsMondayPlacement(system)
      ? {
          mondayWorkspaceId: blankToNull(mondayWorkspaceId),
          mondayBoardId: blankToNull(mondayBoardId),
          mondayGroupId: blankToNull(mondayGroupId),
        }
      : {}),
    // Only what was actually typed. An untouched secret field sends nothing,
    // and the stored secret survives - see this file's header.
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  });

  const save = useMutation({
    mutationFn: async () => {
      if (connectionId === null) return customerErpApi.create(body());
      return customerErpApi.update(connectionId, body());
    },
    onSuccess: (connection) => {
      setConnectionId(connection.id);
      // Cleared after a successful save: they are in the vault now, and
      // holding them in component state for the rest of the session is a copy
      // with no reason to exist.
      setSecrets({});
      void queryClient.invalidateQueries({ queryKey: erpKeys.connections });
      void queryClient.invalidateQueries({ queryKey: erpKeys.connection(connection.id) });
      setStep((current) => nextStep(current));
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  if (options.isPending || (isEditing && existing.isPending)) {
    return <LoadingState label={t('erp.wizard.loading')} />;
  }

  if (options.isError) {
    return <ErrorState error={options.error} onRetry={() => void options.refetch()} />;
  }

  const stepIndex = STEPS.findIndex((entry) => entry.id === step);

  return (
    <>
      <PageHeader
        title={isEditing ? t('erp.wizard.editTitle') : t('erp.wizard.title')}
        description={t('erp.wizard.description')}
        actions={
          <ButtonLink
            to={connectionId === null ? '/account/integrations/erp' : `/account/integrations/erp/${connectionId}`}
            variant="ghost"
            size="sm"
          >
            {t('common.cancel')}
          </ButtonLink>
        }
      />

      {/*
       * The step rail. A list of where you are rather than a set of buttons:
       * steps after the current one are not reachable until the draft exists,
       * and a control that refuses to do anything reads as a fault.
       */}
      <ol className="mb-6 flex flex-wrap gap-x-1 gap-y-2" aria-label={t('erp.wizard.steps')}>
        {STEPS.map((entry, index) => {
          const done = index < stepIndex;
          const current = index === stepIndex;
          const reachable = connectionId !== null || index <= stepIndex;

          return (
            <li key={entry.id} className="flex items-center gap-1">
              <button
                type="button"
                disabled={!reachable}
                aria-current={current ? 'step' : undefined}
                onClick={() => { setStep(entry.id); }}
                className={cx(
                  'rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors',
                  current
                    ? 'bg-brand text-on-brand'
                    : done
                      ? 'bg-brand-soft text-brand hover:bg-brand-soft/80'
                      : 'text-ink-subtle',
                  !reachable && 'cursor-not-allowed opacity-60',
                )}
              >
                {done && <CheckIcon aria-hidden="true" className="mr-1 inline h-3 w-3" />}
                {index + 1}. {t(entry.labelKey)}
              </button>

              {index < STEPS.length - 1 && (
                <ChevronRightIcon aria-hidden="true" className="h-3 w-3 text-ink-subtle" />
              )}
            </li>
          );
        })}
      </ol>

      <div className="space-y-6">
        {step === 'system' && (
          <AccountPanel title={t('erp.wizard.stepSystem')} description={t('erp.wizard.systemBody')}>
            <Field label={t('erp.wizard.presetSearch')} hint={t('erp.wizard.presetSearchHint')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  type="search"
                  aria-describedby={describedBy}
                  value={presetSearch}
                  placeholder={t('erp.wizard.presetSearchPlaceholder')}
                  onChange={(event) => { setPresetSearch(event.target.value); }}
                />
              )}
            </Field>

            <fieldset className="mt-4">
              <legend className="sr-only">{t('erp.wizard.stepSystem')}</legend>

              {visiblePresets.length === 0 ? (
                /*
                 * Nothing matched. The escape hatch is the answer rather than an
                 * apology: an ERP that is not in the catalogue is still
                 * connectable, provided it has a documented API.
                 */
                <p className="rounded-lg border border-border bg-surface-muted p-4 text-sm text-ink-muted">
                  {t('erp.wizard.presetNoMatch')}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {visiblePresets.map((entry) => (
                    <label
                      key={entry.id}
                      className={cx(
                        'flex cursor-pointer flex-col rounded-lg border p-4 transition-colors',
                        vendorPreset === entry.id
                          ? 'border-brand bg-brand-soft'
                          : 'border-border bg-surface hover:border-border-hover',
                      )}
                    >
                      <span className="flex items-start gap-2">
                        <input
                          type="radio"
                          name="erp-vendor-preset"
                          value={entry.id}
                          checked={vendorPreset === entry.id}
                          onChange={() => { choosePreset(entry); }}
                          className="mt-0.5 h-4 w-4 shrink-0"
                        />
                        <span className="text-sm font-semibold text-ink">{entry.label}</span>
                      </span>

                      <span className="mt-2 flex flex-wrap gap-1.5">
                        {/*
                          The protocol, said plainly. A buyer does not need to
                          know that NetSuite and Zoho share a connector, but an
                          IT team reading over their shoulder very much does -
                          it is what tells them which API documentation to find.
                        */}
                        <Badge tone="neutral">{t(SYSTEM_LABEL[entry.connector])}</Badge>

                        {entry.onPremiseTypical && (
                          <Badge tone="warning">{t('erp.wizard.presetOnPremise')}</Badge>
                        )}

                        {entry.defaultsAreExamples && (
                          <Badge tone="neutral">{t('erp.wizard.presetExamples')}</Badge>
                        )}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>

            {preset !== undefined && (
              <div className="mt-4 space-y-3">
                {/*
                  How this one is spoken to, which is the same sentence for
                  every brand sharing a connector - and is exactly the sentence
                  an IT team needs before they go looking for documentation.
                */}
                <p className="text-xs leading-relaxed text-ink-muted">
                  {t(SYSTEM_DESCRIPTION[preset.connector])}
                </p>

                <p className="text-xs leading-relaxed text-ink-muted">{preset.notes}</p>

                {preset.defaultsAreExamples && (
                  /*
                   * Said once, plainly, on the step where the choice is made.
                   *
                   * For systems configured per customer - TCS iON, an Infor ION
                   * flow, a Tally gateway somebody wrote - the paths we fill in
                   * are a shape to start from, not that vendor's published API.
                   * A buyer who does not know that spends an afternoon pressing
                   * Test against addresses nobody promised.
                   */
                  <p className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-soft p-3 text-xs leading-relaxed text-ink">
                    <AlertIcon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{t('erp.wizard.presetExamplesNote')}</span>
                  </p>
                )}
              </div>
            )}

            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label={t('erp.wizard.name')} required hint={t('erp.wizard.nameHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={name}
                    onChange={(event) => { setName(event.target.value); }}
                  />
                )}
              </Field>

              <Field label={t('erp.wizard.erpVersion')} hint={t('erp.wizard.erpVersionHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={erpVersion}
                    placeholder={system === 'SAP' ? 'S/4HANA 2023' : ''}
                    onChange={(event) => { setErpVersion(event.target.value); }}
                  />
                )}
              </Field>

              <Field
                label={t('erp.wizard.environment')}
                required
                hint={t('erp.wizard.environmentHint')}
              >
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={environment}
                    onChange={(event) => { setEnvironment(event.target.value as ErpEnvironment); }}
                  >
                    <option value="SANDBOX">{t('erp.environment.sandbox')}</option>
                    <option value="PRODUCTION">{t('erp.environment.production')}</option>
                  </Select>
                )}
              </Field>
            </div>

            <StepNav
              onNext={() => { setStep('connection'); }}
              nextDisabled={name.trim().length === 0}
            />
          </AccountPanel>
        )}

        {step === 'connection' && (
          <AccountPanel
            title={t('erp.wizard.stepConnection')}
            description={t('erp.wizard.connectionBody')}
          >
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <Field label={t('erp.wizard.baseUrl')} required hint={t('erp.wizard.baseUrlHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      type="url"
                      inputMode="url"
                      placeholder={preset?.baseUrlExample ?? 'https://erp.example.com'}
                      value={baseUrl}
                      onChange={(event) => { setBaseUrl(event.target.value); }}
                    />
                  )}
                </Field>
              </div>

              <Field label={t('erp.wizard.authMethod')} required>
                {({ inputId, describedBy }) => (
                  <Select
                    id={inputId}
                    aria-describedby={describedBy}
                    value={authMethod}
                    disabled={noAuthMethodAvailable}
                    onChange={(event) => { setAuthMethod(event.target.value as ErpAuthMethod); }}
                  >
                    {(offeredAuthMethods ?? []).map((method) => (
                      <option key={method} value={method}>
                        {t(AUTH_LABEL[method])}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label={t('erp.wizard.apiVersion')} hint={t('erp.wizard.apiVersionHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={apiVersion}
                    onChange={(event) => { setApiVersion(event.target.value); }}
                  />
                )}
              </Field>
            </div>

            {/*
              * Nothing this vendor accepts is available here.
              *
              * Said where the buyer can act on it - the environment is two
              * fields up - and it names both ways out, because one of them is
              * theirs and one of them is their supplier's.
              */}
            {noAuthMethodAvailable ? (
              <p className="mt-3 flex items-start gap-2 rounded-md bg-warning-soft p-3 text-xs leading-relaxed text-ink">
                <AlertIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                {t('erp.wizard.noAuthMethod')}
              </p>
            ) : (
              /* What this method costs, said beside the choice. */
              <p className="mt-3 flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-xs leading-relaxed text-ink-muted">
                <AlertIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {t(AUTH_NOTE[authMethod])}
              </p>
            )}

            {authMethod === 'API_KEY' && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label={t('erp.wizard.apiKeyName')} required hint={t('erp.wizard.apiKeyNameHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      placeholder="X-API-Key"
                      value={apiKeyName}
                      onChange={(event) => { setApiKeyName(event.target.value); }}
                    />
                  )}
                </Field>

                <Field label={t('erp.wizard.apiKeyLocation')}>
                  {({ inputId, describedBy }) => (
                    <Select
                      id={inputId}
                      aria-describedby={describedBy}
                      value={apiKeyLocation}
                      onChange={(event) =>
                        { setApiKeyLocation(event.target.value as 'HEADER' | 'QUERY'); }
                      }
                    >
                      <option value="HEADER">{t('erp.wizard.inHeader')}</option>
                      <option value="QUERY">{t('erp.wizard.inQuery')}</option>
                    </Select>
                  )}
                </Field>
              </div>
            )}

            {(authMethod === 'OAUTH2_CLIENT_CREDENTIALS' ||
              authMethod === 'OAUTH2_AUTHORIZATION_CODE') && (
              <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/*
                  * Two addresses the buyer types only when they are the one who
                  * knows them.
                  *
                  * A self-hosted system serves OAuth wherever its administrator
                  * put it, so it has to be asked for. A SaaS with one published
                  * pair does not: asking there is offering somebody a chance to
                  * mistype one of two fixed strings, and the mistake surfaces
                  * as a broken consent screen rather than as a validation
                  * error. The server uses its connector's addresses for those
                  * systems regardless, so a field here would be a field that
                  * silently does nothing.
                  */}
                {fixedTokenUrl === null && (
                  <Field label={t('erp.wizard.tokenUrl')} required>
                    {({ inputId, describedBy }) => (
                      <Input
                        id={inputId}
                        aria-describedby={describedBy}
                        type="url"
                        value={oauthTokenUrl}
                        onChange={(event) => { setOauthTokenUrl(event.target.value); }}
                      />
                    )}
                  </Field>
                )}

                {isInteractiveOAuth(authMethod) && fixedAuthorizationUrl === null && (
                  <Field label={t('erp.wizard.authorizationUrl')} required>
                    {({ inputId, describedBy }) => (
                      <Input
                        id={inputId}
                        aria-describedby={describedBy}
                        type="url"
                        value={oauthAuthorizationUrl}
                        onChange={(event) => { setOauthAuthorizationUrl(event.target.value); }}
                      />
                    )}
                  </Field>
                )}

                {/*
                  * Which permissions to ask for - unless the store's own
                  * registered application decides that, as it does for monday,
                  * where the permissions are the operator's to set and are the
                  * same for every buyer. Leaving the field visible there would
                  * invite somebody to widen or narrow a list that is not read.
                  */}
                {!usesPlatformApp && (
                  <Field label={t('erp.wizard.scope')} hint={t('erp.wizard.scopeHint')}>
                    {({ inputId, describedBy }) => (
                      <Input
                        id={inputId}
                        aria-describedby={describedBy}
                        value={oauthScope}
                        onChange={(event) => { setOauthScope(event.target.value); }}
                      />
                    )}
                  </Field>
                )}

                {/*
                 * The redirect address the buyer registers with their own ERP.
                 * Shown here rather than after they have authorised, because
                 * registering it is the first thing they have to do on their
                 * side and discovering that afterwards means starting again.
                 *
                 * Not their job where the store's own application is used: that
                 * address was registered once by whoever runs this store, and
                 * showing it to a buyer who cannot act on it is an instruction
                 * to go and look for a settings screen they do not have.
                 */}
                {isInteractiveOAuth(authMethod) && !usesPlatformApp && (
                  <div className="sm:col-span-2">
                    <p className="rounded-md bg-surface-sunken p-3 text-xs leading-relaxed text-ink-muted">
                      {t('erp.wizard.redirectUriBody')}
                      <code className="mt-1 block font-mono text-ink">
                        {options.data.oauthRedirectUri}
                      </code>
                    </p>
                  </div>
                )}

                {/*
                  * Nothing else belongs in this block for a store-registered
                  * application: `SecretFields` below already says the one thing
                  * there is to say, which is that there is nothing to enter.
                  */}
              </div>
            )}

            <SecretFields
              authMethod={authMethod}
              /*
               * `usesPlatformApp` as well as the saved flag, so a monday
               * connection being created for the FIRST time stops asking for a
               * client id and secret too. The saved flag only answers for a
               * connection that already exists, which left the one case where
               * the buyer has nothing to paste asking them to paste something.
               */
              hidden={
                usesPlatformApp ||
                (loaded !== undefined && isFullConnection(loaded) && loaded.oauthUsesPlatformApp)
              }
              stored={loaded !== undefined && isFullConnection(loaded) ? loaded.credentials : []}
              values={secrets}
              onChange={(key, value) => { setSecrets((current) => ({ ...current, [key]: value })); }}
            />

            {needsSapPlacement(system) && (
              <fieldset className="mt-6 border-t border-border-subtle pt-6">
                <legend className="text-sm font-semibold text-ink">
                  {t('erp.wizard.sapPlacement')}
                </legend>

                <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                  {t('erp.wizard.sapPlacementBody')}
                </p>

                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label={t('erp.wizard.companyCode')} required>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={sapCompanyCode}
                        onChange={(event) => { setSapCompanyCode(event.target.value); }}
                      />
                    )}
                  </Field>
                  <Field label={t('erp.wizard.purchasingOrg')} required>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={sapPurchasingOrg}
                        onChange={(event) => { setSapPurchasingOrg(event.target.value); }}
                      />
                    )}
                  </Field>
                  <Field label={t('erp.wizard.purchasingGroup')}>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={sapPurchasingGroup}
                        onChange={(event) => { setSapPurchasingGroup(event.target.value); }}
                      />
                    )}
                  </Field>
                  <Field label={t('erp.wizard.plant')}>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={sapPlant}
                        onChange={(event) => { setSapPlant(event.target.value); }}
                      />
                    )}
                  </Field>
                  <Field label={t('erp.wizard.storageLocation')}>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={sapStorageLocation}
                        onChange={(event) => { setSapStorageLocation(event.target.value); }}
                      />
                    )}
                  </Field>
                </div>
              </fieldset>
            )}

            {needsMondayPlacement(system) && (
              <fieldset className="mt-6 border-t border-border-subtle pt-6">
                <legend className="text-sm font-semibold text-ink">
                  {t('erp.wizard.mondayPlacement')}
                </legend>

                <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
                  {t('erp.wizard.mondayPlacementBody')}
                </p>

                <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field label={t('erp.wizard.workspaceId')}>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={mondayWorkspaceId}
                        onChange={(event) => { setMondayWorkspaceId(event.target.value); }}
                      />
                    )}
                  </Field>
                  <Field label={t('erp.wizard.boardId')} required>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={mondayBoardId}
                        onChange={(event) => { setMondayBoardId(event.target.value); }}
                      />
                    )}
                  </Field>
                  <Field label={t('erp.wizard.groupId')}>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        value={mondayGroupId}
                        onChange={(event) => { setMondayGroupId(event.target.value); }}
                      />
                    )}
                  </Field>
                </div>
              </fieldset>
            )}

            <div className="mt-6">
              <Field
                label={t('erp.wizard.customHeaders')}
                hint={t('erp.wizard.customHeadersHint')}
              >
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    aria-describedby={describedBy}
                    rows={3}
                    placeholder={'X-Company-Code: 1000'}
                    value={headersText}
                    onChange={(event) => { setHeadersText(event.target.value); }}
                  />
                )}
              </Field>
            </div>

            <div className="mt-4">
              <Field
                label={t('erp.wizard.tenantIdentifier')}
                hint={t('erp.wizard.tenantIdentifierHint')}
              >
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={tenantIdentifier}
                    onChange={(event) => { setTenantIdentifier(event.target.value); }}
                  />
                )}
              </Field>
            </div>

            <StepNav
              onBack={() => { setStep('system'); }}
              onNext={() => { setStep('network'); }}
              nextDisabled={baseUrl.trim().length === 0}
            />
          </AccountPanel>
        )}

        {step === 'network' && (
          <AccountPanel title={t('erp.wizard.stepNetwork')} description={t('erp.wizard.networkBody')}>
            <fieldset>
              <legend className="sr-only">{t('erp.wizard.stepNetwork')}</legend>

              <div className="space-y-3">
                {(
                  ['PUBLIC_HTTPS', 'IP_ALLOWLIST', 'VPN_GATEWAY', 'SAP_CLOUD_CONNECTOR'] as const
                ).map((mode) => (
                  <label
                    key={mode}
                    className={cx(
                      'flex cursor-pointer gap-3 rounded-lg border p-4 transition-colors',
                      networkMode === mode
                        ? 'border-brand bg-brand-soft'
                        : 'border-border bg-surface hover:border-border-hover',
                    )}
                  >
                    <input
                      type="radio"
                      name="erp-network"
                      value={mode}
                      checked={networkMode === mode}
                      onChange={() => { setNetworkMode(mode); }}
                      className="mt-0.5 h-4 w-4 shrink-0"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-ink">
                        {t(NETWORK_LABEL[mode])}
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                        {t(NETWORK_NOTE[mode])}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            {/* HTTPS is not a choice, so it is stated rather than offered. */}
            <p className="mt-4 flex items-start gap-2 rounded-md bg-brand-soft p-3 text-xs leading-relaxed text-ink">
              <CheckIcon aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-brand" />
              {t('erp.wizard.httpsRequired')}
            </p>

            {/*
              What to ask their own IT team for. The BRAND's advice where there
              is one, because "ask your TCS iON implementation partner for the
              integration API documentation for your tenant" is a errand
              somebody can actually run, and the connector's generic version of
              the same sentence is not.
            */}
            {(preset?.notes ?? chosen?.networkNotes) !== undefined && (
              <p className="mt-3 max-w-prose rounded-md bg-surface-sunken p-3 text-xs leading-relaxed text-ink-muted">
                {preset?.notes ?? chosen?.networkNotes}
              </p>
            )}

            <div className="mt-4">
              <Field label={t('erp.wizard.networkNotes')} hint={t('erp.wizard.networkNotesHint')}>
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    aria-describedby={describedBy}
                    rows={3}
                    value={networkNotes}
                    onChange={(event) => { setNetworkNotes(event.target.value); }}
                  />
                )}
              </Field>
            </div>

            <StepNav
              onBack={() => { setStep('connection'); }}
              nextLabel={connectionId === null ? t('erp.wizard.saveAndContinue') : t('common.saveChanges')}
              onNext={() => { save.mutate(); }}
              isLoading={save.isPending}
            />
          </AccountPanel>
        )}

        {step === 'endpoints' && connectionId !== null && (
          <EndpointStep
            connectionId={connectionId}
            onBack={() => { setStep('network'); }}
            onNext={() => { setStep('mapping'); }}
          />
        )}

        {step === 'mapping' && connectionId !== null && (
          <MappingStep
            connectionId={connectionId}
            platformFields={options.data.platformFields}
            onBack={() => { setStep('endpoints'); }}
            onNext={() => { setStep('rules'); }}
          />
        )}

        {step === 'rules' && connectionId !== null && (
          <RulesStep
            connectionId={connectionId}
            onBack={() => { setStep('mapping'); }}
            onDone={() => {
              void queryClient.invalidateQueries({ queryKey: erpKeys.connections });
              void navigate(`/account/integrations/erp/${connectionId}`);
            }}
          />
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------

function StepNav({
  onBack,
  onNext,
  nextLabel,
  nextDisabled,
  isLoading,
}: {
  onBack?: () => void;
  onNext?: () => void;
  nextLabel?: string;
  nextDisabled?: boolean;
  isLoading?: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-5">
      {onBack === undefined ? (
        <span />
      ) : (
        <Button variant="ghost" onClick={onBack}>
          {t('common.back')}
        </Button>
      )}

      {onNext !== undefined && (
        <Button
          variant="primary"
          onClick={onNext}
          disabled={nextDisabled === true}
          isLoading={isLoading === true}
        >
          {nextLabel ?? t('common.continue')}
        </Button>
      )}
    </div>
  );
}

/**
 * The secret inputs for the chosen method, and nothing else.
 *
 * Each starts empty with the stored hint beside it. Leaving one empty sends
 * nothing and keeps what is stored; typing replaces it. `autoComplete="off"`
 * and `type="password"` on every one of them - a browser offering to save
 * somebody's SAP client secret into their personal password manager is not a
 * feature either of us wants.
 */
function SecretFields({
  authMethod,
  hidden,
  stored,
  values,
  onChange,
}: {
  authMethod: ErpAuthMethod;
  hidden: boolean;
  stored: { kind: string; hint: string | null }[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();

  if (hidden) {
    return (
      <p className="mt-4 rounded-md bg-brand-soft p-3 text-xs leading-relaxed text-ink">
        {t('erp.wizard.platformAppNote')}
      </p>
    );
  }

  const fields = secretFieldsFor(authMethod);
  const primaryHint = stored.find((entry) => entry.kind === 'PRIMARY')?.hint ?? null;

  const labelFor = (key: string): string => {
    switch (key) {
      case 'apiKey':
        return t('erp.wizard.apiKey');
      case 'bearerToken':
        return t('erp.wizard.bearerToken');
      case 'username':
        return t('erp.wizard.username');
      case 'password':
        return t('erp.wizard.password');
      case 'clientId':
        return t('erp.wizard.clientId');
      case 'clientSecret':
        return t('erp.wizard.clientSecret');
      default:
        return t('erp.wizard.personalToken');
    }
  };

  return (
    <fieldset className="mt-6 border-t border-border-subtle pt-6">
      <legend className="text-sm font-semibold text-ink">{t('erp.wizard.credentials')}</legend>

      {primaryHint !== null && (
        <p className="mt-1 text-xs leading-relaxed text-ink-muted">
          {t('erp.wizard.storedCredential', { hint: primaryHint })}
        </p>
      )}

      <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
        {fields.map((key) => (
          <Field
            key={key}
            label={labelFor(key)}
            {...(primaryHint === null ? {} : { hint: t('erp.wizard.leaveBlankToKeep') })}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                // The client id is not a secret and is worth being able to
                // read back; everything else here is.
                type={key === 'clientId' || key === 'username' ? 'text' : 'password'}
                autoComplete="off"
                value={values[key] ?? ''}
                onChange={(event) => { onChange(key, event.target.value); }}
              />
            )}
          </Field>
        ))}
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

/** Step 4. What to call, how, and where the records are in the answer. */
function EndpointStep({
  connectionId,
  onBack,
  onNext,
}: {
  connectionId: string;
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: erpKeys.connection(connectionId),
    queryFn: () => customerErpApi.connection(connectionId),
  });

  const [rows, setRows] = useState<EndpointView[] | null>(null);
  const [spec, setSpec] = useState('');

  const loaded = query.data?.connection;

  useEffect(() => {
    if (loaded !== undefined && isFullConnection(loaded) && rows === null) {
      setRows(loaded.endpoints);
    }
  }, [loaded, rows]);

  const save = useMutation({
    mutationFn: () => customerErpApi.saveEndpoints(connectionId, rows ?? []),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpKeys.connection(connectionId) });
      onNext();
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const importSpec = useMutation({
    mutationFn: () => customerErpApi.importSpec(spec),
    onSuccess: (imported) => {
      // Suggestions, confirmed on screen. Nothing here saves anything - an
      // importer that silently configured a connection from a file would be
      // trusting a document to decide which addresses this server calls.
      setRows((current) => {
        const existing = new Map((current ?? []).map((entry) => [entry.purpose, entry]));

        for (const suggestion of imported.endpoints) {
          if (suggestion.confidence !== 'high') continue;

          existing.set(suggestion.purpose, {
            purpose: suggestion.purpose,
            path: suggestion.path,
            method: suggestion.method,
            enabled: true,
            pagination: 'NONE',
            paginationConfig: {},
            recordsPath: null,
            requestTemplate: null,
            queryParams: {},
          });
        }

        return [...existing.values()];
      });

      setSpec('');
      toast.success(t('erp.wizard.specImported', { count: imported.endpoints.length }));
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  if (rows === null) return <LoadingState label={t('erp.wizard.loading')} />;

  const update = (index: number, patch: Partial<EndpointView>): void => {
    setRows((current) =>
      (current ?? []).map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      ),
    );
  };

  return (
    <AccountPanel title={t('erp.wizard.stepEndpoints')} description={t('erp.wizard.endpointsBody')}>
      <details className="mb-5 rounded-md border border-border-subtle p-3">
        <summary className="cursor-pointer text-sm font-medium text-ink">
          {t('erp.wizard.importSpec')}
        </summary>

        <p className="mt-2 max-w-prose text-xs leading-relaxed text-ink-muted">
          {t('erp.wizard.importSpecBody')}
        </p>

        <Textarea
          rows={4}
          className="mt-2 font-mono text-xs"
          value={spec}
          placeholder="openapi: 3.0.0"
          onChange={(event) => { setSpec(event.target.value); }}
        />

        <Button
          className="mt-2"
          size="sm"
          disabled={spec.trim().length === 0}
          isLoading={importSpec.isPending}
          onClick={() => { importSpec.mutate(); }}
        >
          {t('erp.wizard.readSpec')}
        </Button>
      </details>

      <ul className="space-y-4">
        {rows.map((endpoint, index) => (
          <li key={endpoint.purpose} className="rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-ink">
                {t(ENDPOINT_LABEL[endpoint.purpose])}
              </h3>

              <label className="flex items-center gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  checked={endpoint.enabled}
                  onChange={(event) => { update(index, { enabled: event.target.checked }); }}
                  className="h-4 w-4"
                />
                {t('erp.wizard.endpointEnabled')}
              </label>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
              <div className="sm:col-span-2">
                <Field label={t('erp.wizard.path')}>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      className="font-mono text-xs"
                      value={endpoint.path}
                      onChange={(event) => { update(index, { path: event.target.value }); }}
                    />
                  )}
                </Field>
              </div>

              <Field label={t('erp.wizard.method')}>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={endpoint.method}
                    onChange={(event) => { update(index, { method: event.target.value }); }}
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                      <option key={method} value={method}>
                        {method}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <Field label={t('erp.wizard.pagination')}>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={endpoint.pagination}
                    onChange={(event) =>
                      { update(index, {
                        pagination: event.target.value as EndpointView['pagination'],
                      }); }
                    }
                  >
                    {(
                      ['NONE', 'PAGE_NUMBER', 'OFFSET_LIMIT', 'CURSOR', 'ODATA_NEXT_LINK'] as const
                    ).map((value) => (
                      <option key={value} value={value}>
                        {value.replace(/_/g, ' ').toLowerCase()}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>

              <div className="sm:col-span-2">
                <Field label={t('erp.wizard.recordsPath')} hint={t('erp.wizard.recordsPathHint')}>
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      className="font-mono text-xs"
                      value={endpoint.recordsPath ?? ''}
                      onChange={(event) =>
                        { update(index, {
                          recordsPath:
                            event.target.value.trim().length === 0 ? null : event.target.value,
                        }); }
                      }
                    />
                  )}
                </Field>
              </div>
            </div>
          </li>
        ))}
      </ul>

      <StepNav onBack={onBack} onNext={() => { save.mutate(); }} isLoading={save.isPending} />
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------

/**
 * Step 5. Our field names against theirs, and a real record to check it with.
 *
 * The "Test and preview" button is the point of this screen. Until a real
 * response comes back, every mapping here is a guess about somebody else's
 * JSON - `Items.0.Material` is a perfectly well-formed path that finds nothing
 * if their field is called `Material_No`, and the first anybody would know of it
 * is a purchase order with no lines.
 */
function MappingStep({
  connectionId,
  platformFields,
  onBack,
  onNext,
}: {
  connectionId: string;
  platformFields: Record<ErpMappingEntity, { key: string; label: string; required: boolean }[]>;
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: erpKeys.connection(connectionId),
    queryFn: () => customerErpApi.connection(connectionId),
  });

  const [rows, setRows] = useState<MappingRow[] | null>(null);
  const [entity, setEntity] = useState<ErpMappingEntity>('ORDER');
  const [check, setCheck] = useState<SampleCheck | null>(null);
  const [sample, setSample] = useState<unknown>(null);

  const loaded = query.data?.connection;

  useEffect(() => {
    if (loaded !== undefined && isFullConnection(loaded) && rows === null) {
      setRows(loaded.mappings);
    }
  }, [loaded, rows]);

  /*
   * What the server said was wrong, field by field.
   *
   * The refusal carries a detail per offending row - which field, and why - and
   * showing only its one-line summary threw all of that away. "Some of the
   * field mapping needs attention" in a toast, over a table of twenty rows, is
   * a puzzle rather than a message.
   */
  const [issues, setIssues] = useState<string[]>([]);

  const save = useMutation({
    mutationFn: () =>
      customerErpApi.saveMappings(
        connectionId,
        /*
         * Rows the buyer emptied are dropped rather than sent.
         *
         * There is no delete button on this table - clearing the box IS the
         * gesture for "I do not have this field" - and a row with neither a
         * path nor a fixed value is refused by the server. So the two disagreed
         * about what an empty box meant, and the buyer got a validation error
         * for doing the only thing the screen let them do. Dropping them here
         * makes the gesture mean what it looks like; a REQUIRED field dropped
         * this way is still caught, by name, when the connection is switched
         * on.
         */
        (rows ?? []).filter((row) =>
          row.entity === 'STATUS'
            ? (row.erpValue ?? '').trim().length > 0
            : row.erpPath.trim().length > 0 || (row.constantValue ?? '').trim().length > 0,
        ),
      ),
    onSuccess: () => {
      setIssues([]);
      void queryClient.invalidateQueries({ queryKey: erpKeys.connection(connectionId) });
      onNext();
    },
    onError: (error: unknown) => {
      setIssues(
        error instanceof ApiError
          ? error.details
              .map((detail) => detail.message)
              .filter((message): message is string => message !== undefined)
          : [],
      );
      toast.error(errorMessage(t, error));
    },
  });

  const test = useMutation({
    mutationFn: () => customerErpApi.test(connectionId),
    onSuccess: (result) => {
      setCheck(result.mapping);
      setSample(result.sample);
      void queryClient.invalidateQueries({ queryKey: erpKeys.connection(connectionId) });

      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const visible = useMemo(
    () => (rows ?? []).filter((entry) => entry.entity === entity),
    [rows, entity],
  );

  if (rows === null) return <LoadingState label={t('erp.wizard.loading')} />;

  const setRow = (platformField: string, patch: Partial<MappingRow>): void => {
    setRows((current) => {
      const list = current ?? [];
      const index = list.findIndex(
        (entry) => entry.entity === entity && entry.platformField === platformField,
      );

      if (index === -1) {
        return [
          ...list,
          {
            entity,
            platformField,
            erpPath: '',
            constantValue: null,
            erpValue: null,
            transform: null,
            ...patch,
          },
        ];
      }

      return list.map((entry, position) =>
        position === index ? { ...entry, ...patch } : entry,
      );
    });
  };

  return (
    <AccountPanel title={t('erp.wizard.stepMapping')} description={t('erp.wizard.mappingBody')}>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="w-56">
          <Field label={t('erp.wizard.mappingFor')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={entity}
                onChange={(event) => { setEntity(event.target.value as ErpMappingEntity); }}
              >
                {(
                  ['ORDER', 'PRODUCT', 'INVENTORY', 'INVOICE', 'PAYMENT', 'STATUS'] as const
                ).map((value) => (
                  <option key={value} value={value}>
                    {t(ENTITY_LABEL[value])}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        <Button onClick={() => { test.mutate(); }} isLoading={test.isPending}>
          {t('erp.wizard.testAndPreview')}
        </Button>
      </div>

      {/*
       * The result of checking the mapping against a real record. Every mapped
       * field is reported, found or not - a buyer looking at this list is
       * checking their own work, and "not found" beside an optional field is
       * exactly what they spot and we never could.
       */}
      {check !== null && (
        <div
          className={cx(
            'mb-5 rounded-md p-3',
            check.ok ? 'bg-success-soft' : 'bg-warning-soft',
          )}
        >
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            {check.ok ? (
              <CheckIcon aria-hidden="true" className="h-4 w-4 text-success" />
            ) : (
              <AlertIcon aria-hidden="true" className="h-4 w-4 text-warning" />
            )}
            {check.ok
              ? t('erp.wizard.mappingOk')
              : t('erp.wizard.mappingMissing', { fields: check.missing.join(', ') })}
          </p>

          <ul className="mt-2 space-y-1">
            {check.fields.map((field) => (
              <li key={`${field.entity}:${field.platformField}`} className="text-xs text-ink-muted">
                <span className="font-medium text-ink">{field.label}</span>
                {' → '}
                <code className="font-mono">{field.erpPath}</code>
                {' · '}
                {field.found ? (
                  <span className="text-success">{field.sample ?? t('erp.wizard.found')}</span>
                ) : (
                  <span className="text-danger">{t('erp.wizard.notFound')}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {issues.length > 0 && (
        <div className="mb-5 rounded-md bg-warning-soft p-3">
          <p className="flex items-center gap-2 text-sm font-medium text-ink">
            <AlertIcon aria-hidden="true" className="h-4 w-4 text-warning" />
            {t('erp.wizard.mappingRejected')}
          </p>

          <ul className="mt-2 list-disc space-y-1 pl-5">
            {issues.map((issue) => (
              <li key={issue} className="text-xs leading-relaxed text-ink">
                {issue}
              </li>
            ))}
          </ul>
        </div>
      )}

      {sample !== null && (
        <details className="mb-5 rounded-md border border-border-subtle p-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">
            {t('erp.wizard.samplePayload')}
          </summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-sunken p-3 font-mono text-xxs text-ink">
            {JSON.stringify(sample, null, 2)}
          </pre>
        </details>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="text-xxs uppercase tracking-wider text-ink-subtle">
            <tr>
              <th className="pb-2 pr-3 font-semibold">{t('erp.wizard.ourField')}</th>
              <th className="pb-2 pr-3 font-semibold">
                {entity === 'STATUS' ? t('erp.wizard.theirWord') : t('erp.wizard.theirField')}
              </th>
              {entity !== 'STATUS' && (
                <th className="pb-2 font-semibold">{t('erp.wizard.conversion')}</th>
              )}
            </tr>
          </thead>

          <tbody className="divide-y divide-border-subtle">
            {platformFields[entity].map((spec) => {
              const row = visible.find((entry) => entry.platformField === spec.key);

              return (
                <tr key={spec.key}>
                  <td className="py-2 pr-3">
                    <span className="text-sm text-ink">{spec.label}</span>
                    {spec.required && (
                      <Badge tone="neutral">
                        <span className="text-xxs">{t('erp.wizard.required')}</span>
                      </Badge>
                    )}
                  </td>

                  <td className="py-2 pr-3">
                    <Input
                      aria-label={`${spec.label} — ${t('erp.wizard.theirField')}`}
                      className="font-mono text-xs"
                      value={entity === 'STATUS' ? (row?.erpValue ?? '') : (row?.erpPath ?? '')}
                      onChange={(event) =>
                        { setRow(
                          spec.key,
                          entity === 'STATUS'
                            ? { erpValue: event.target.value, erpPath: '' }
                            : { erpPath: event.target.value },
                        ); }
                      }
                    />
                  </td>

                  {entity !== 'STATUS' && (
                    <td className="py-2">
                      <Select
                        aria-label={`${spec.label} — ${t('erp.wizard.conversion')}`}
                        value={row?.transform ?? ''}
                        onChange={(event) =>
                          { setRow(spec.key, {
                            transform:
                              event.target.value === ''
                                ? null
                                : (event.target.value as MappingRow['transform']),
                          }); }
                        }
                      >
                        <option value="">{t('erp.wizard.noConversion')}</option>
                        {(
                          [
                            'TRIM',
                            'UPPERCASE',
                            'LOWERCASE',
                            'MINOR_TO_DECIMAL',
                            'DECIMAL_TO_MINOR',
                            'ISO_DATE',
                            'DATE_ONLY',
                          ] as const
                        ).map((value) => (
                          <option key={value} value={value}>
                            {value.replace(/_/g, ' ').toLowerCase()}
                          </option>
                        ))}
                      </Select>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <StepNav onBack={onBack} onNext={() => { save.mutate(); }} isLoading={save.isPending} />
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------

/**
 * Step 6. What may move, in which direction, and who has to say yes.
 *
 * The one screen on which somebody decides whether this integration is allowed
 * to change their stock figures without asking. The default is that it is not.
 */
function RulesStep({
  connectionId,
  onBack,
  onDone,
}: {
  connectionId: string;
  onBack: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: erpKeys.connection(connectionId),
    queryFn: () => customerErpApi.connection(connectionId),
  });

  const warehouses = useQuery({
    queryKey: erpKeys.warehouses,
    queryFn: () => customerErpApi.warehouses(),
  });

  const loaded = query.data?.connection;
  const full = loaded !== undefined && isFullConnection(loaded) ? loaded : null;

  const [policy, setPolicy] = useState<ConnectionView['policy'] | null>(null);
  const [maps, setMaps] = useState<WarehouseMapView[] | null>(null);
  const [threshold, setThreshold] = useState('');

  useEffect(() => {
    if (full === null) return;

    if (policy === null) {
      setPolicy(full.policy);
      setThreshold(minorToInput(full.policy.approvalThresholdMinor));
    }

    if (maps === null) setMaps(full.warehouseMaps);
  }, [full, policy, maps]);

  const savePolicy = useMutation({
    mutationFn: async () => {
      if (policy === null) return;

      await customerErpApi.saveWarehouses(connectionId, maps ?? []);

      await customerErpApi.savePolicy(connectionId, {
        ...policy,
        approvalThresholdMinor: inputToMinor(threshold),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: erpKeys.connection(connectionId) });
      toast.success(t('erp.wizard.rulesSaved'));
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const dryRun = useMutation({
    mutationFn: () => customerErpApi.dryRun(connectionId),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: erpKeys.connection(connectionId) });
      toast.success(result.message);
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  const activate = useMutation({
    mutationFn: () => customerErpApi.activate(connectionId),
    onSuccess: () => {
      toast.success(t('erp.action.activated'));
      onDone();
    },
    onError: (error: unknown) => { toast.error(errorMessage(t, error)); },
  });

  if (policy === null || full === null) return <LoadingState label={t('erp.wizard.loading')} />;

  const set = (patch: Partial<ConnectionView['policy']>): void => {
    setPolicy((current) => (current === null ? current : { ...current, ...patch }));
  };

  return (
    <AccountPanel title={t('erp.wizard.stepRules')} description={t('erp.wizard.rulesBody')}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('erp.rules.sourceOfTruth')} hint={t('erp.rules.sourceOfTruthHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={policy.sourceOfTruth}
              onChange={(event) => { set({ sourceOfTruth: event.target.value }); }}
            >
              <option value="PLATFORM">{t('erp.rules.platformWins')}</option>
              <option value="ERP">{t('erp.rules.erpWins')}</option>
            </Select>
          )}
        </Field>

        <Field label={t('erp.rules.direction')} hint={t('erp.rules.directionHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={policy.mode}
              onChange={(event) => { set({ mode: event.target.value }); }}
            >
              <option value="OUTBOUND">{t('erp.rules.outbound')}</option>
              <option value="INBOUND">{t('erp.rules.inbound')}</option>
              <option value="BIDIRECTIONAL">{t('erp.rules.bidirectional')}</option>
            </Select>
          )}
        </Field>

        <Field label={t('erp.rules.conflict')} hint={t('erp.rules.conflictHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={policy.conflictPolicy}
              onChange={(event) => { set({ conflictPolicy: event.target.value }); }}
            >
              <option value="MANUAL">{t('erp.rules.conflictManual')}</option>
              <option value="ERP_WINS">{t('erp.rules.conflictErp')}</option>
              <option value="PLATFORM_WINS">{t('erp.rules.conflictPlatform')}</option>
              <option value="NEWEST_WINS">{t('erp.rules.conflictNewest')}</option>
            </Select>
          )}
        </Field>

        <Field label={t('erp.rules.stockWrites')} hint={t('erp.rules.stockWritesHint')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={policy.inventoryWriteMode}
              disabled={full.environment === 'SANDBOX'}
              onChange={(event) => { set({ inventoryWriteMode: event.target.value }); }}
            >
              <option value="APPROVAL_REQUIRED">{t('erp.rules.approvalRequired')}</option>
              <option value="AUTOMATIC">{t('erp.rules.automatic')}</option>
            </Select>
          )}
        </Field>
      </div>

      {full.environment === 'SANDBOX' && (
        <p className="mt-3 rounded-md bg-surface-sunken p-3 text-xs leading-relaxed text-ink-muted">
          {t('erp.rules.sandboxLocked')}
        </p>
      )}

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label={t('erp.rules.threshold')} hint={t('erp.rules.thresholdHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={threshold}
              onChange={(event) => { setThreshold(event.target.value); }}
            />
          )}
        </Field>

        <Field label={t('erp.rules.thresholdCurrency')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              maxLength={3}
              className="uppercase"
              value={policy.approvalCurrency ?? ''}
              onChange={(event) =>
                { set({
                  approvalCurrency:
                    event.target.value.trim().length === 0
                      ? null
                      : event.target.value.toUpperCase(),
                }); }
              }
            />
          )}
        </Field>
      </div>

      <fieldset className="mt-6 border-t border-border-subtle pt-5">
        <legend className="text-sm font-semibold text-ink">{t('erp.rules.whatToSend')}</legend>

        <div className="mt-3 space-y-2">
          {(
            [
              ['sendPurchaseOrders', 'erp.rules.sendPurchaseOrders'],
              ['sendShipmentStatus', 'erp.rules.sendShipmentStatus'],
              ['sendGoodsReceipts', 'erp.rules.sendGoodsReceipts'],
              ['sendInvoices', 'erp.rules.sendInvoices'],
              ['sendPaymentReferences', 'erp.rules.sendPaymentReferences'],
              ['syncInventory', 'erp.rules.syncInventory'],
              ['receiptOnPlatformDelivery', 'erp.rules.receiptOnDelivery'],
            ] as const
          ).map(([key, labelKey]) => (
            <label key={key} className="flex items-start gap-2.5 text-sm text-ink">
              <input
                type="checkbox"
                checked={policy[key]}
                onChange={(event) => { set({ [key]: event.target.checked }); }}
                className="mt-0.5 h-4 w-4"
              />
              {t(labelKey)}
            </label>
          ))}
        </div>
      </fieldset>

      {/* Which of our warehouses is which of their plants. */}
      {warehouses.data !== undefined && warehouses.data.length > 0 && (
        <fieldset className="mt-6 border-t border-border-subtle pt-5">
          <legend className="text-sm font-semibold text-ink">{t('erp.rules.warehouses')}</legend>

          <p className="mt-1 max-w-prose text-xs leading-relaxed text-ink-muted">
            {t('erp.rules.warehousesHint')}
          </p>

          <ul className="mt-3 space-y-2">
            {warehouses.data.map((warehouse) => {
              const mapped = (maps ?? []).find(
                (entry) => entry.inventoryLocationId === warehouse.id,
              );

              return (
                <li key={warehouse.id} className="flex flex-wrap items-center gap-3">
                  <span className="min-w-[12rem] flex-1 text-sm text-ink">{warehouse.name}</span>

                  <Input
                    aria-label={t('erp.rules.plantFor', { warehouse: warehouse.name })}
                    placeholder={t('erp.rules.plantPlaceholder')}
                    className="w-40 font-mono text-xs"
                    value={mapped?.erpPlant ?? ''}
                    onChange={(event) => {
                      const value = event.target.value;

                      setMaps((current) => {
                        const list = current ?? [];
                        const index = list.findIndex(
                          (entry) => entry.inventoryLocationId === warehouse.id,
                        );

                        if (index === -1) {
                          return [
                            ...list,
                            {
                              inventoryLocationId: warehouse.id,
                              warehouseName: warehouse.name,
                              erpPlant: value,
                              erpStorageLocation: null,
                              erpBoardId: null,
                              erpGroupId: null,
                              isFallback: false,
                            },
                          ];
                        }

                        return list.map((entry, position) =>
                          position === index ? { ...entry, erpPlant: value } : entry,
                        );
                      });
                    }}
                  />
                </li>
              );
            })}
          </ul>
        </fieldset>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-border-subtle pt-5">
        <Button variant="ghost" onClick={onBack}>
          {t('common.back')}
        </Button>

        <Button onClick={() => { savePolicy.mutate(); }} isLoading={savePolicy.isPending}>
          {t('erp.wizard.saveRules')}
        </Button>

        <Button onClick={() => { dryRun.mutate(); }} isLoading={dryRun.isPending}>
          {t('erp.wizard.dryRun')}
        </Button>

        <Button
          variant="primary"
          className="ml-auto"
          onClick={() => { activate.mutate(); }}
          isLoading={activate.isPending}
        >
          {t('erp.action.activate')}
        </Button>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-ink-muted">
        {t('erp.wizard.activateHint')}
      </p>
    </AccountPanel>
  );
}

// ---------------------------------------------------------------------------

/**
 * Which market's ERPs to list first, from the currency this store runs on.
 *
 * Ordering only, and the catalogue is complete whatever this returns - the
 * search box reaches every entry. Read from the operator's configuration rather
 * than from the person signed in, because it is the operator who knows which
 * systems their customers run; a Dutch wholesaler's buyers are on Exact and
 * Dynamics whoever happens to be logged in that morning.
 *
 * The euro list covers the currencies of the markets this platform is sold
 * into. An unrecognised one gets the global order, which is the right answer
 * rather than a fallback: it leads with SAP, and SAP is everywhere.
 */
const EURO_AREA_CURRENCIES = new Set(['EUR', 'PLN', 'SEK', 'DKK', 'CZK', 'HUF', 'RON', 'CHF', 'GBP', 'NOK']);

function regionForCurrency(currency: string): ErpRegion {
  if (currency === 'INR') return 'india';
  return EURO_AREA_CURRENCIES.has(currency) ? 'eu' : 'global';
}

function nextStep(current: StepId): StepId {
  const index = STEPS.findIndex((entry) => entry.id === current);
  return STEPS[Math.min(index + 1, STEPS.length - 1)]?.id ?? current;
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * `Name: value` per line into an object.
 *
 * A textarea rather than a repeating row editor, because this is a field most
 * buyers never touch and the two who do are pasting from their own
 * documentation. Anything without a colon is ignored rather than rejected - a
 * stray blank line should not fail a save.
 */
function parseHeaders(text: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();

    if (key.length === 0 || value.length === 0) continue;
    result[key] = value;
  }

  return result;
}
