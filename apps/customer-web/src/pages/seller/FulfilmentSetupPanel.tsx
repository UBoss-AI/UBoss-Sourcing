/**
 * Finishing the setup of a delivery method the seller has chosen.
 *
 * Three shapes behind one question. Which one is drawn follows the method's
 * mode, and they share a panel because a seller moves between them - somebody
 * who set up their own vans in March connects DHL in June, and two separate
 * screens would make that feel like two separate products.
 *
 *   INTEGRATED_CARRIER  connect the seller's OWN account: the account number,
 *                       the key, a real test, and then a deliberate switch to
 *                       live.
 *   SELF_MANAGED        describe the delivery operation and name the person
 *                       who will run it.
 *   DEDICATED_PARTNER   find a company already here, or invite one that is
 *                       not.
 *
 * THE RULE THIS FILE KEEPS
 *
 * A green "Connected" state is never rendered from anything the seller typed.
 * It follows `connection.state`, which the server moves to ACTIVE only after a
 * call genuinely reached the carrier AND a person confirmed it. The button
 * that confirms is disabled until the test has passed, so the two gates are
 * visible in the interface rather than only enforced behind it.
 *
 * India Post has no test button at all, because there is nothing to test - the
 * card says so in words instead.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import {
  SETUP_STATUS_TONE,
  carrierDefinition,
  type CarrierDefinition,
} from '@/lib/carrier-providers';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import {
  activateCarrierConnection,
  createCarrierConnection,
  createSelfManagedOrganisation,
  disconnectCarrier,
  fetchCarrierConnections,
  fetchCredentialFields,
  inviteDeliveryPartner,
  requestDeliveryPartner,
  searchDeliveryPartners,
  storeCarrierCredentials,
  testCarrierConnection,
  type CarrierConnection,
  type CarrierConnectionState,
  type FulfilmentMethod,
} from '@/lib/seller';

/**
 * A labelled text input.
 *
 * `Field` generates the id and the `aria-describedby` and hands them to its
 * child as a render function, so the label, the hint and the error are wired
 * to the input for a screen reader. Almost every field on this screen is a
 * plain text box, and writing that render function out a dozen times is noise
 * that hides the one field where something different happens.
 */
function TextField({
  label,
  hint,
  required,
  ...input
}: {
  label: string;
  hint?: string;
  required?: boolean;
} & React.ComponentPropsWithoutRef<typeof Input>): React.JSX.Element {
  return (
    /*
      `hint` and `required` are SPREAD rather than passed as `undefined`.

      This project runs `exactOptionalPropertyTypes`, under which an absent
      optional property and one explicitly set to `undefined` are different
      types - and the second is not assignable to the first.
    */
    <Field
      label={label}
      {...(hint === undefined ? {} : { hint })}
      {...(required === undefined ? {} : { required })}
    >
      {({ inputId, describedBy }) => (
        <Input id={inputId} aria-describedby={describedBy} {...input} />
      )}
    </Field>
  );
}

/**
 * The label for one credential box, in THIS carrier's words.
 *
 * From the carrier's own definition, so FedEx's form says "FedEx client ID"
 * and never borrows DHL's label. A field the server asks for that this build
 * has no definition for shows its own name rather than nothing.
 */
function credentialFieldLabel(t: Translate, carrier: CarrierDefinition, field: string): string {
  const known = carrier.credentialFields.find((entry) => entry.name === field);
  return known === undefined ? field : t(known.labelKey);
}

const CONNECTION_TONE: Record<
  CarrierConnectionState,
  'neutral' | 'brand' | 'success' | 'warning' | 'danger'
> = {
  NOT_CONFIGURED: 'neutral',
  CREDENTIALS_SET: 'warning',
  TEST_PASSED: 'brand',
  ACTIVE: 'success',
  PAUSED: 'neutral',
  ERROR: 'danger',
  DISCONNECTED: 'neutral',
};

export function FulfilmentSetupPanel({
  method,
  isEditable,
  onClose,
}: {
  method: FulfilmentMethod;
  isEditable: boolean;
  /** Close the panel without finishing. Setup can always be left for later. */
  onClose?: () => void;
}): React.JSX.Element {
  switch (method.mode) {
    case 'INTEGRATED_CARRIER': {
      const carrier = carrierDefinition(method.provider);

      // No guess. A carrier method whose carrier this build does not know is
      // said to be so, rather than drawn as some other carrier's form.
      if (carrier === null) {
        return (
          <Card>
            <p className="px-6 py-8 text-center text-sm text-ink-muted">
              {t_unknownCarrier(method.provider)}
            </p>
          </Card>
        );
      }

      /*
       * KEYED on the method and the carrier. Switching from the FedEx panel to
       * the DHL one mounts a fresh panel with empty fields, so nothing typed
       * for one carrier - an account number, half a key - survives into the
       * other.
       */
      return (
        <CarrierAccountPanel
          key={`${method.id}:${carrier.provider}`}
          method={method}
          carrier={carrier}
          isEditable={isEditable}
          {...(onClose === undefined ? {} : { onClose })}
        />
      );
    }
    case 'SELF_MANAGED':
      return <SelfManagedPanel method={method} isEditable={isEditable} />;
    case 'DEDICATED_PARTNER':
      return <DedicatedPartnerPanel method={method} isEditable={isEditable} />;
    case 'OPERATOR_FULFILLED':
      // Nothing to set up. Saying so is better than an empty panel.
      return <NothingToSetUp />;
  }
}

function NothingToSetUp(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card>
      <p className="px-6 py-8 text-center text-sm text-ink-muted">
        {t('sellerSetup.nothingToDo')}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A carrier account of the seller's own
// ---------------------------------------------------------------------------

function CarrierAccountPanel({
  method,
  carrier,
  isEditable,
  onClose,
}: {
  method: FulfilmentMethod;
  carrier: CarrierDefinition;
  isEditable: boolean;
  onClose?: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const provider = carrier.provider;

  const connections = useQuery({
    queryKey: ['seller', 'carrier-connections'],
    queryFn: fetchCarrierConnections,
  });

  const fields = useQuery({
    queryKey: ['seller', 'credential-fields', provider],
    queryFn: () => fetchCredentialFields(provider),
    // A carrier with no API has nothing to ask for.
    enabled: carrier.hasApi,
  });

  const [accountNumber, setAccountNumber] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  function refresh(): void {
    void client.invalidateQueries({ queryKey: ['seller', 'carrier-connections'] });
    void client.invalidateQueries({ queryKey: ['seller', 'fulfilment-options'] });
  }

  const environment = method.environment ?? 'SANDBOX';
  const connection: CarrierConnection | undefined = connections.data?.connections.find(
    (row) => row.provider === provider && row.environment === environment,
  );
  const setupStatus = method.carrierSetupStatus ?? 'NOT_CONFIGURED';

  const create = useMutation({
    mutationFn: createCarrierConnection,
    onSuccess: () => {
      toast.success(t('sellerSetup.connectionCreated'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.connectionFailed')));
    },
  });

  const storeKey = useMutation({
    mutationFn: storeCarrierCredentials,
    onSuccess: () => {
      // Cleared immediately. A secret typed into a form has no business
      // sitting in React state after it has been sent.
      setSecrets({});
      toast.success(t('sellerSetup.credentialsStored'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.credentialsFailed')));
    },
  });

  const test = useMutation({
    mutationFn: testCarrierConnection,
    onSuccess: (result) => {
      // The carrier's own answer, whichever way it went. A failed test is a
      // state this screen has, not an error to hide.
      if (result.passed) toast.success(result.message);
      else toast.error(result.message);
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.testFailed')));
    },
  });

  const activate = useMutation({
    mutationFn: activateCarrierConnection,
    onSuccess: () => {
      toast.success(t('sellerSetup.nowLive'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.activateFailed')));
    },
  });

  const disconnect = useMutation({
    mutationFn: disconnectCarrier,
    onSuccess: () => {
      toast.success(t('sellerSetup.disconnected'));
      refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.disconnectFailed')));
    },
  });

  if (connections.isPending) {
    return (
      <Card>
        <div className="px-6 py-5">
          <LoadingState label={t('sellerSetup.loading')} />
        </div>
      </Card>
    );
  }

  return (
    <Card title={t(carrier.titleKey)} description={t(carrier.descriptionKey)}>
      <div className="space-y-5 px-6 py-5" data-carrier={carrier.provider}>
        {/* --- Whose account, and the one honest status line ---------------- */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className={cx(
                'inline-flex h-9 min-w-9 items-center justify-center rounded-lg px-2 text-xs font-bold',
                carrier.badgeClass,
              )}
            >
              {carrier.monogram}
            </span>
            <p className="text-sm font-semibold text-ink">{carrier.displayName}</p>
          </div>
          <Badge tone={SETUP_STATUS_TONE[setupStatus]}>
            {t(`carrier.setupStatus.${setupStatus}`)}
          </Badge>
        </div>

        {/*
          What works WITHOUT an account, said before the form rather than
          after it. A seller with no DHL account reads this and closes the
          panel; nothing about onboarding waits on it.
        */}
        {setupStatus !== 'CONNECTED' && (
          <p
            role="status"
            className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-xs leading-relaxed text-ink"
          >
            {carrier.hasApi ? t('carrier.notConnectedNotice') : t('carrier.INDIA_POST.noApiNotice')}
          </p>
        )}

        <ol className="list-decimal space-y-1 pl-5 text-xxs leading-relaxed text-ink-muted">
          {carrier.setupStepKeys.map((key) => (
            <li key={key}>{t(key)}</li>
          ))}
        </ol>

        {carrier.hasApi && connection === undefined && carrier.accountNumber !== null && (
          <div className="space-y-4">
            <TextField label={t(carrier.accountNumber.labelKey)} hint={t(carrier.accountNumber.hintKey)}
                value={accountNumber}
                onChange={(event) => {
                  setAccountNumber(event.target.value);
                }}
                autoComplete="off"
              />

            <Button
              variant="primary"
              size="sm"
              disabled={!isEditable || create.isPending || accountNumber.trim().length === 0}
              onClick={() => {
                create.mutate({
                  provider,
                  environment,
                  accountNumber: accountNumber.trim(),
                });
              }}
            >
              {t('carrier.addAccount', { carrier: carrier.displayName })}
            </Button>
          </div>
        )}

        {carrier.hasApi && connection !== undefined && (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-ink">
                  {carrier.displayName} · {t(`sellerSetup.env.${connection.environment}`)}
                </p>
                {connection.accountNumberHint !== null && (
                  <p className="mt-0.5 text-xxs text-ink-muted">
                    {t('sellerSetup.account', { hint: connection.accountNumberHint })}
                  </p>
                )}
              </div>

              <Badge tone={CONNECTION_TONE[connection.state]}>
                {t(`sellerSetup.state.${connection.state}`)}
              </Badge>
            </div>

            {connection.lastFailureMessage !== null && (
              <p className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-xs text-ink">
                {connection.lastFailureMessage}
              </p>
            )}

            {connection.hasVerifiedApi && (
              <>
                {/* --- The key ------------------------------------------- */}
                <div className="space-y-3 border-t border-border-subtle pt-4">
                  <p className="text-xs font-semibold text-ink">
                    {connection.hasCredential
                      ? t('sellerSetup.rotateTitle')
                      : t('sellerSetup.keyTitle')}
                  </p>

                  {connection.credentialHint !== null && (
                    <p className="text-xxs text-ink-muted">
                      {t('sellerSetup.currentKey', { hint: connection.credentialHint })}
                    </p>
                  )}

                  {(fields.data?.fields ?? []).map((field) => (
                    <TextField key={field} label={credentialFieldLabel(t, carrier, field)}
                        type="password"
                        value={secrets[field] ?? ''}
                        onChange={(event) => {
                          setSecrets((previous) => ({ ...previous, [field]: event.target.value }));
                        }}
                        // Never offered to a password manager and never
                        // restored on a back navigation.
                        autoComplete="off"
                        spellCheck={false}
                      />
                  ))}

                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={
                      !isEditable ||
                      storeKey.isPending ||
                      (fields.data?.fields ?? []).some(
                        (field) => (secrets[field] ?? '').trim().length === 0,
                      )
                    }
                    onClick={() => {
                      storeKey.mutate({ connectionId: connection.id, fields: secrets });
                    }}
                  >
                    {connection.hasCredential
                      ? t('sellerSetup.rotate')
                      : t('sellerSetup.storeKey')}
                  </Button>
                </div>

                {/* --- The two gates ------------------------------------- */}
                <div className="space-y-3 border-t border-border-subtle pt-4">
                  <p className="text-xs font-semibold text-ink">{t('sellerSetup.gatesTitle')}</p>
                  <p className="text-xxs leading-relaxed text-ink-muted">
                    {t('sellerSetup.gatesBody')}
                  </p>

                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={!isEditable || !connection.hasCredential || test.isPending}
                      onClick={() => {
                        test.mutate(connection.id);
                      }}
                    >
                      {t('sellerSetup.test')}
                    </Button>

                    <Button
                      variant="primary"
                      size="sm"
                      /*
                       * Disabled until a real call has passed.
                       *
                       * The server refuses it too. Disabling here means the
                       * seller learns the order of the two gates from the
                       * screen rather than from a refusal after pressing.
                       */
                      disabled={
                        !isEditable ||
                        connection.lastTestPassedAt === null ||
                        connection.state === 'ACTIVE' ||
                        activate.isPending
                      }
                      onClick={() => {
                        activate.mutate(connection.id);
                      }}
                    >
                      {t('sellerSetup.goLive')}
                    </Button>

                    {connection.hasCredential && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!isEditable || disconnect.isPending}
                        onClick={() => {
                          disconnect.mutate(connection.id);
                        }}
                      >
                        {t('sellerSetup.disconnect')}
                      </Button>
                    )}
                  </div>

                  {connection.lastTestMessage !== null && (
                    <p
                      className={cx(
                        'rounded-lg px-3 py-2 text-xxs',
                        connection.lastTestPassedAt === null
                          ? 'bg-surface-sunken text-ink-muted'
                          : 'bg-success-soft text-success',
                      )}
                    >
                      {connection.lastTestMessage}
                    </p>
                  )}
                </div>
              </>
            )}
          </>
        )}

        {onClose !== undefined && (
          <div className="flex justify-end border-t border-border-subtle pt-4">
            <Button variant="ghost" size="sm" onClick={onClose}>
              {t('carrier.closeForNow')}
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/** Said in English on purpose: it only appears for a carrier this build predates. */
function t_unknownCarrier(provider: string | null): string {
  return `This delivery method is for a carrier this version of the Seller Hub does not recognise (${provider ?? 'none'}).`;
}

// ---------------------------------------------------------------------------
// The seller's own delivery arm
// ---------------------------------------------------------------------------

function SelfManagedPanel({
  method,
  isEditable,
}: {
  method: FulfilmentMethod;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [form, setForm] = useState({
    displayName: '',
    legalName: '',
    registrationCountry: '',
    contactEmail: '',
    operationsOwnerName: '',
    operationsOwnerEmail: '',
  });

  const create = useMutation({
    mutationFn: createSelfManagedOrganisation,
    onSuccess: (result) => {
      toast.success(
        t('sellerSetup.orgCreated', { email: result.organisation.invitedEmail }),
      );
      void client.invalidateQueries({ queryKey: ['seller', 'fulfilment-options'] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.orgFailed')));
    },
  });

  if (method.partner !== null) {
    return (
      <Card title={t('sellerSetup.orgExistsTitle')}>
        <div className="px-6 py-5">
          <p className="text-sm text-ink">{method.partner.displayName}</p>
          <p className="mt-1 text-xxs text-ink-muted">
            {t('sellerSetup.orgExistsBody', { status: method.partner.status })}
          </p>
        </div>
      </Card>
    );
  }

  const incomplete = Object.values(form).some((value) => value.trim().length === 0);

  return (
    <Card title={t('sellerSetup.orgTitle')} description={t('sellerSetup.orgBody')}>
      <div className="space-y-4 px-6 py-5">
        <TextField label={t('sellerSetup.orgDisplayName')} hint={t('sellerSetup.orgDisplayNameHint')} required
            value={form.displayName}
            onChange={(event) => {
              setForm((previous) => ({ ...previous, displayName: event.target.value }));
            }}
          />

        <TextField label={t('sellerSetup.orgLegalName')} required
            value={form.legalName}
            onChange={(event) => {
              setForm((previous) => ({ ...previous, legalName: event.target.value }));
            }}
          />

        <TextField label={t('sellerSetup.orgCountry')} hint={t('sellerSetup.orgCountryHint')} required
            value={form.registrationCountry}
            maxLength={2}
            onChange={(event) => {
              setForm((previous) => ({
                ...previous,
                registrationCountry: event.target.value.toUpperCase(),
              }));
            }}
          />

        <TextField label={t('sellerSetup.orgContactEmail')} required
            type="email"
            value={form.contactEmail}
            onChange={(event) => {
              setForm((previous) => ({ ...previous, contactEmail: event.target.value }));
            }}
          />

        {/*
          The separation the whole design rests on, explained where the seller
          is about to trip over it: this address gets its OWN portal account,
          and it cannot be one that already exists here.
        */}
        <div className="rounded-lg border border-border bg-surface-sunken px-4 py-3">
          <p className="text-xs font-semibold text-ink">{t('sellerSetup.ownerTitle')}</p>
          <p className="mt-1 text-xxs leading-relaxed text-ink-muted">
            {t('sellerSetup.ownerBody')}
          </p>

          <div className="mt-3 space-y-3">
            <TextField label={t('sellerSetup.ownerName')} required
                value={form.operationsOwnerName}
                onChange={(event) => {
                  setForm((previous) => ({
                    ...previous,
                    operationsOwnerName: event.target.value,
                  }));
                }}
              />

            <TextField label={t('sellerSetup.ownerEmail')} required
                type="email"
                value={form.operationsOwnerEmail}
                onChange={(event) => {
                  setForm((previous) => ({
                    ...previous,
                    operationsOwnerEmail: event.target.value,
                  }));
                }}
              />
          </div>
        </div>

        <Button
          variant="primary"
          size="sm"
          disabled={!isEditable || incomplete || create.isPending}
          onClick={() => {
            create.mutate({ fulfilmentMethodId: method.id, ...form });
          }}
        >
          {t('sellerSetup.createOrg')}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// A delivery company that works for this seller
// ---------------------------------------------------------------------------

function DedicatedPartnerPanel({
  method,
  isEditable,
}: {
  method: FulfilmentMethod;
  isEditable: boolean;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();

  const [term, setTerm] = useState('');
  const [invite, setInvite] = useState({
    proposedDisplayName: '',
    proposedLegalName: '',
    businessEmail: '',
    countryCode: '',
  });

  const search = useQuery({
    queryKey: ['seller', 'partner-search', term],
    queryFn: () => searchDeliveryPartners(term),
  });

  const request = useMutation({
    mutationFn: requestDeliveryPartner,
    onSuccess: () => {
      toast.success(t('sellerSetup.partnerRequested'));
      void client.invalidateQueries({ queryKey: ['seller', 'fulfilment-options'] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.partnerRequestFailed')));
    },
  });

  const sendInvite = useMutation({
    mutationFn: inviteDeliveryPartner,
    onSuccess: (result) => {
      toast.success(t('sellerSetup.invited', { email: result.invitation.businessEmail }));
      setInvite({
        proposedDisplayName: '',
        proposedLegalName: '',
        businessEmail: '',
        countryCode: '',
      });
      void client.invalidateQueries({ queryKey: ['seller', 'fulfilment-options'] });
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerSetup.inviteFailed')));
    },
  });

  if (method.partner !== null) {
    return (
      <Card title={t('sellerSetup.partnerChosenTitle')}>
        <div className="px-6 py-5">
          <p className="text-sm text-ink">{method.partner.displayName}</p>
          <p className="mt-1 text-xxs text-ink-muted">
            {t('sellerSetup.orgExistsBody', { status: method.partner.status })}
          </p>
        </div>
      </Card>
    );
  }

  const inviteIncomplete = Object.values(invite).some((value) => value.trim().length === 0);

  return (
    <div className="space-y-5">
      <Card title={t('sellerSetup.findTitle')} description={t('sellerSetup.findBody')}>
        <div className="space-y-4 px-6 py-5">
          <TextField label={t('sellerSetup.searchLabel')}
              value={term}
              onChange={(event) => {
                setTerm(event.target.value);
              }}
              // A searchable list needs to announce itself to a screen reader
              // as one, not as a text box beside some rows.
              role="searchbox"
              aria-controls="partner-results"
            />

          {search.isPending && <LoadingState label={t('sellerSetup.searching')} />}

          <ul id="partner-results" className="divide-y divide-border-subtle">
            {(search.data?.partners ?? []).map((partner) => (
              <li key={partner.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">{partner.displayName}</p>
                  <p className="mt-0.5 text-xxs text-ink-muted">
                    {partner.partnerCode} · {partner.serviceCountries.join(', ') || partner.registrationCountry}
                  </p>
                </div>

                {partner.existingStatus === null ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={!isEditable || request.isPending}
                    onClick={() => {
                      request.mutate({
                        fulfilmentMethodId: method.id,
                        logisticsPartnerId: partner.id,
                      });
                    }}
                  >
                    {t('sellerSetup.askThem')}
                  </Button>
                ) : (
                  <Badge tone="neutral">{partner.existingStatus}</Badge>
                )}
              </li>
            ))}
          </ul>

          {search.data !== undefined && search.data.partners.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-muted">{t('sellerSetup.noPartners')}</p>
          )}
        </div>
      </Card>

      <Card title={t('sellerSetup.inviteTitle')} description={t('sellerSetup.inviteBody')}>
        <div className="space-y-4 px-6 py-5">
          <TextField label={t('sellerSetup.inviteDisplayName')} required
              value={invite.proposedDisplayName}
              onChange={(event) => {
                setInvite((previous) => ({
                  ...previous,
                  proposedDisplayName: event.target.value,
                }));
              }}
            />

          <TextField label={t('sellerSetup.inviteLegalName')} required
              value={invite.proposedLegalName}
              onChange={(event) => {
                setInvite((previous) => ({ ...previous, proposedLegalName: event.target.value }));
              }}
            />

          <TextField label={t('sellerSetup.inviteEmail')} hint={t('sellerSetup.inviteEmailHint')} required
              type="email"
              value={invite.businessEmail}
              onChange={(event) => {
                setInvite((previous) => ({ ...previous, businessEmail: event.target.value }));
              }}
            />

          <TextField label={t('sellerSetup.orgCountry')} required
              value={invite.countryCode}
              maxLength={2}
              onChange={(event) => {
                setInvite((previous) => ({
                  ...previous,
                  countryCode: event.target.value.toUpperCase(),
                }));
              }}
            />

          <Button
            variant="secondary"
            size="sm"
            disabled={!isEditable || inviteIncomplete || sendInvite.isPending}
            onClick={() => {
              sendInvite.mutate({ fulfilmentMethodId: method.id, ...invite });
            }}
          >
            {t('sellerSetup.sendInvite')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
