/**
 * One carrier, in full.
 *
 * Six things live here and they are deliberately on one page rather than
 * behind tabs: deciding whether a haulier may carry refrigerated stock means
 * reading its capabilities, its regions, its contract and its open work
 * together, and a tab strip turns that into four clicks and a memory test.
 *
 * Two of them are consequential enough to be worth naming:
 *
 *   - **Suspending a carrier is not a flag.** It stops new offers reaching
 *     them, and it optionally withdraws the consignments they have not yet
 *     accepted so somebody else can be found. The dialog says how many that
 *     is, because "suspend" with the box ticked can move a day's work.
 *   - **Approving a capability is a safety decision.** Cold chain, sterile
 *     handling and dangerous goods are matched against a consignment's own
 *     requirements by the assignment engine, so approving one here is what
 *     lets a temperature-controlled parcel be offered to this carrier at all.
 *
 * The internal note panel is marked as internal on screen, because the same
 * field on a seller's record has already taught this codebase that an
 * unlabelled note box eventually gets something in it that was meant for the
 * other party.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
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
  SummaryTiles,
  Textarea,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { formatDate, formatDateTime, formatNumber, humanise } from '@/lib/format';
import {
  capabilityKey,
  contractKey,
  decideCapability,
  fetchPartner,
  invitePartnerUser,
  partnerStatusTone,
  roleKey,
  saveSlaPolicy,
  scopeKey,
  setPartnerRegions,
  setPartnerStatus,
  statusKey,
  type CapabilityState,
  type LogisticsRole,
  type PartnerCapability,
  type PartnerDetail,
  type PartnerRegion,
  type PartnerSlaPolicy,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';

const ROLES: readonly LogisticsRole[] = [
  'LOGISTICS_PARTNER_OWNER',
  'LOGISTICS_PARTNER_ADMIN',
  'DISPATCHER',
  'DRIVER',
  'OPERATIONS_AGENT',
  'READ_ONLY_TRACKING_USER',
];

export function LogisticsPartnerDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams<{ id: string }>();

  const query = useQuery({
    queryKey: ['admin', 'logistics', 'partner', id],
    queryFn: () => fetchPartner(id),
    enabled: id.length > 0,
  });

  if (query.isPending) return <LoadingState label={t('logistics.partner.loading')} />;

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

  const partner = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={partner.displayName}
        description={partner.legalName}
        back={{ to: '/logistics/partners', label: t('logistics.partners.heading') }}
        meta={
          <>
            <Badge tone={partnerStatusTone(partner.status)} dot>
              {t(statusKey(partner.status))}
            </Badge>
            <Badge tone="neutral">{partner.partnerCode}</Badge>
            <Badge tone="neutral">{t(contractKey(partner.contractStatus))}</Badge>
          </>
        }
        actions={<StatusActions partner={partner} />}
      />

      {partner.status === 'SUSPENDED' && (
        <Callout tone="danger" title={t('logistics.partner.suspendedTitle')} role="status">
          <p>
            {partner.suspensionReason === null
              ? t('logistics.partner.suspendedNoReason')
              : partner.suspensionReason}
          </p>
          {partner.suspendedAt !== null && (
            <p className="mt-1 text-xs">
              {t('logistics.partner.suspendedSince', {
                date: formatDateTime(partner.suspendedAt),
              })}
            </p>
          )}
        </Callout>
      )}

      <SummaryTiles
        items={[
          { label: t('logistics.partner.tile.people'), value: formatNumber(partner.users.length) },
          {
            label: t('logistics.partner.tile.regions'),
            value: formatNumber(partner.regions.length),
          },
          {
            label: t('logistics.partner.tile.approvedCapabilities'),
            value: formatNumber(
              partner.capabilities.filter((entry) => entry.state === 'APPROVED').length,
            ),
          },
          {
            label: t('logistics.partner.tile.ceiling'),
            value:
              partner.maxOpenShipments === null
                ? t('logistics.partner.noCeiling')
                : formatNumber(partner.maxOpenShipments),
          },
        ]}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t('logistics.partner.registration')}>
          <DescriptionList
            items={[
              { label: t('logistics.partner.field.legalName'), value: partner.legalName },
              {
                label: t('logistics.partner.field.country'),
                value: partner.registrationCountry,
              },
              {
                label: t('logistics.partner.field.registrationNumber'),
                value: partner.registrationNumber ?? '—',
              },
              { label: t('logistics.partner.field.taxNumber'), value: partner.taxNumber ?? '—' },
              {
                label: t('logistics.partner.field.licence'),
                value:
                  partner.licenceNumber === null
                    ? '—'
                    : `${partner.licenceNumber}${
                        partner.licenceExpiresAt === null
                          ? ''
                          : ` · ${formatDate(partner.licenceExpiresAt)}`
                      }`,
              },
              {
                label: t('logistics.partner.field.contract'),
                value: `${t(contractKey(partner.contractStatus))}${
                  partner.contractReference === null ? '' : ` · ${partner.contractReference}`
                }`,
              },
              {
                label: t('logistics.partner.field.contractPeriod'),
                value:
                  partner.contractStartsAt === null && partner.contractEndsAt === null
                    ? '—'
                    : `${formatDate(partner.contractStartsAt)} – ${formatDate(partner.contractEndsAt)}`,
              },
            ]}
          />
        </Card>

        <Card title={t('logistics.partner.contactsAndLimits')}>
          <DescriptionList
            items={[
              { label: t('logistics.partner.field.contactEmail'), value: partner.contactEmail },
              {
                label: t('logistics.partner.field.contactPhone'),
                value: partner.contactPhone ?? '—',
              },
              {
                label: t('logistics.partner.field.emergencyPhone'),
                value: partner.emergencyPhone ?? '—',
              },
              { label: t('logistics.partner.field.website'), value: partner.websiteUrl ?? '—' },
              {
                label: t('logistics.partner.field.maxOpen'),
                value:
                  partner.maxOpenShipments === null
                    ? t('logistics.partner.noCeiling')
                    : formatNumber(partner.maxOpenShipments),
              },
              {
                label: t('logistics.partner.field.maxDaily'),
                value:
                  partner.maxDailyAssignments === null
                    ? t('logistics.partner.noCeiling')
                    : formatNumber(partner.maxDailyAssignments),
              },
              {
                label: t('logistics.partner.field.autoAssign'),
                value: partner.autoAssignEnabled ? t('common.yes') : t('common.no'),
              },
              {
                label: t('logistics.partner.field.integration'),
                value:
                  partner.carrierIntegration === null
                    ? t('logistics.partner.noIntegration')
                    : `${partner.carrierIntegration.name} · ${partner.carrierIntegration.provider}`,
              },
            ]}
          />
        </Card>
      </div>

      {partner.internalNotes !== null && partner.internalNotes.length > 0 && (
        <Card title={t('logistics.partner.internalNotes')} tone="danger">
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-danger">
            {t('logistics.partner.internalOnly')}
          </p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
            {partner.internalNotes}
          </p>
        </Card>
      )}

      <CapabilitiesCard partner={partner} />
      <RegionsCard partner={partner} />
      <SlaPoliciesCard partner={partner} />
      <MembersCard partner={partner} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

function StatusActions({ partner }: { partner: PartnerDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isOpen, setIsOpen] = useState(false);
  const [status, setStatus] = useState<PartnerDetail['status']>(partner.status);
  const [reason, setReason] = useState('');
  const [handover, setHandover] = useState(true);

  const change = useMutation({
    mutationFn: () =>
      setPartnerStatus(partner.id, {
        status,
        ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
        handoverShipments: handover,
      }),
    onSuccess: (result) => {
      toast.success(
        result.withdrawn > 0
          ? t('logistics.partner.statusChangedWithdrew', { withdrawn: result.withdrawn })
          : t('logistics.partner.statusChanged'),
      );
      setIsOpen(false);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (!can(Permission.LOGISTICS_WRITE)) return null;

  const isStopping = status === 'SUSPENDED' || status === 'DEACTIVATED';

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => {
          setStatus(partner.status);
          setIsOpen(true);
        }}
      >
        {t('logistics.partner.changeStatus')}
      </Button>

      <Modal
        isOpen={isOpen}
        onClose={() => {
          setIsOpen(false);
        }}
        title={t('logistics.partner.changeStatus')}
        description={t('logistics.partner.changeStatusIntro')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setIsOpen(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant={isStopping ? 'danger' : 'primary'}
              disabled={change.isPending || (isStopping && reason.trim().length < 4)}
              onClick={() => {
                change.mutate();
              }}
            >
              {t('common.save')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t('logistics.partner.field.status')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={status}
                onChange={(event) => {
                  setStatus(event.currentTarget.value as PartnerDetail['status']);
                }}
              >
                {(['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED'] as const).map(
                  (value) => (
                    <option key={value} value={value}>
                      {t(statusKey(value))}
                    </option>
                  ),
                )}
              </Select>
            )}
          </Field>

          <Field
            label={t('logistics.partner.field.reason')}
            {...(isStopping ? { hint: t('logistics.partner.reasonRequired') } : {})}
          >
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={2}
                value={reason}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          {isStopping && (
            <CheckboxField
              boxed
              tone="warning"
              label={t('logistics.partner.handover')}
              description={t('logistics.partner.handoverHint')}
              checked={handover}
              onChange={(event) => {
                setHandover(event.currentTarget.checked);
              }}
            />
          )}
        </div>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

function CapabilitiesCard({ partner }: { partner: PartnerDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const decide = useMutation({
    mutationFn: (input: { capability: PartnerCapability; state: CapabilityState }) =>
      decideCapability(partner.id, { kind: input.capability.kind, state: input.state }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'partner'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const mayDecide = can(Permission.LOGISTICS_WRITE);

  return (
    <Card
      title={t('logistics.partner.capabilities')}
      description={t('logistics.partner.capabilitiesIntro')}
    >
      {partner.capabilities.length === 0 ? (
        <EmptyState
          title={t('logistics.partner.noCapabilitiesTitle')}
          description={t('logistics.partner.noCapabilitiesBody')}
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {partner.capabilities.map((capability) => (
            <li
              key={capability.id}
              className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                  {humanise(capability.kind)}
                  <Badge tone={capabilityTone(capability.state)}>
                    {t(capabilityKey(capability.state))}
                  </Badge>
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {capability.evidenceReference === null
                    ? t('logistics.partner.noEvidence')
                    : t('logistics.partner.evidence', {
                        reference: capability.evidenceReference,
                      })}
                  {capability.evidenceExpiresAt !== null &&
                    ` · ${t('logistics.partner.evidenceExpires', {
                      date: formatDate(capability.evidenceExpiresAt),
                    })}`}
                </p>
                {capability.decisionNote !== null && (
                  <p className="mt-0.5 text-xs text-ink-subtle">{capability.decisionNote}</p>
                )}
              </div>

              {mayDecide && (
                <div className="flex shrink-0 gap-2">
                  {capability.state !== 'APPROVED' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({ capability, state: 'APPROVED' });
                      }}
                    >
                      {t('logistics.partner.approve')}
                    </Button>
                  )}
                  {capability.state === 'APPROVED' && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({ capability, state: 'SUSPENDED' });
                      }}
                    >
                      {t('logistics.partner.suspendCapability')}
                    </Button>
                  )}
                  {capability.state !== 'REJECTED' && (
                    <Button
                      size="sm"
                      variant="danger"
                      disabled={decide.isPending}
                      onClick={() => {
                        decide.mutate({ capability, state: 'REJECTED' });
                      }}
                    >
                      {t('logistics.partner.reject')}
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Service regions
// ---------------------------------------------------------------------------

function RegionsCard({ partner }: { partner: PartnerDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isAdding, setIsAdding] = useState(false);
  const [scope, setScope] = useState<PartnerRegion['scope']>('COUNTRY');
  const [countryCode, setCountryCode] = useState('');
  const [regionValue, setRegionValue] = useState('');
  const [supportsPickup, setSupportsPickup] = useState(true);
  const [supportsDelivery, setSupportsDelivery] = useState(true);

  /*
   * The endpoint REPLACES the whole set, so adding one means sending the
   * existing rows back with the new one appended. Sending only the addition
   * would silently delete everything else - a shape worth being explicit
   * about, because it is the kind of API that reads as "add" at a glance.
   */
  const save = useMutation({
    mutationFn: (next: PartnerRegion[]) =>
      setPartnerRegions(
        partner.id,
        next.map((region) => ({
          scope: region.scope,
          countryCode: region.countryCode,
          ...(region.regionValue === null ? {} : { regionValue: region.regionValue }),
          supportsPickup: region.supportsPickup,
          supportsDelivery: region.supportsDelivery,
        })),
      ),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setIsAdding(false);
      setCountryCode('');
      setRegionValue('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'partner'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const mayEdit = can(Permission.LOGISTICS_WRITE);

  return (
    <Card
      title={t('logistics.partner.regions')}
      description={t('logistics.partner.regionsIntro')}
      actions={
        mayEdit ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setIsAdding(true);
            }}
          >
            {t('logistics.partner.addRegion')}
          </Button>
        ) : undefined
      }
    >
      {partner.regions.length === 0 ? (
        <EmptyState
          title={t('logistics.partner.noRegionsTitle')}
          description={t('logistics.partner.noRegionsBody')}
        />
      ) : (
        <ul className="flex flex-wrap gap-2">
          {partner.regions.map((region) => (
            <li
              key={region.id}
              className="flex items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 py-1.5"
            >
              <span className="text-xs font-medium text-ink">
                {region.countryCode}
                {region.regionValue === null ? '' : ` · ${region.regionValue}`}
              </span>
              <span className="text-xxs text-ink-subtle">
                {region.supportsPickup && region.supportsDelivery
                  ? t('logistics.partner.bothWays')
                  : region.supportsPickup
                    ? t('logistics.partner.pickupOnly')
                    : t('logistics.partner.deliveryOnly')}
              </span>
              {mayEdit && (
                <button
                  type="button"
                  className="rounded text-xxs text-ink-subtle hover:text-danger"
                  disabled={save.isPending}
                  onClick={() => {
                    save.mutate(partner.regions.filter((entry) => entry.id !== region.id));
                  }}
                >
                  {t('common.remove')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={isAdding}
        onClose={() => {
          setIsAdding(false);
        }}
        title={t('logistics.partner.addRegion')}
        description={t('logistics.partner.addRegionIntro')}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setIsAdding(false);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={countryCode.trim().length !== 2 || save.isPending}
              onClick={() => {
                save.mutate([
                  ...partner.regions,
                  {
                    id: 'new',
                    scope,
                    countryCode: countryCode.trim().toUpperCase(),
                    regionValue: regionValue.trim().length === 0 ? null : regionValue.trim(),
                    supportsPickup,
                    supportsDelivery,
                    isActive: true,
                  },
                ]);
              }}
            >
              {t('common.add')}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label={t('logistics.partner.field.scope')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={scope}
                onChange={(event) => {
                  setScope(event.currentTarget.value as PartnerRegion['scope']);
                }}
              >
                {(['COUNTRY', 'STATE', 'CITY', 'POSTCODE_PREFIX'] as const).map((value) => (
                  <option key={value} value={value}>
                    {t(scopeKey(value))}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label={t('logistics.partner.field.country')}
            hint={t('logistics.partners.field.countryHint')}
          >
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                maxLength={2}
                className="uppercase"
                value={countryCode}
                onChange={(event) => {
                  setCountryCode(event.currentTarget.value);
                }}
              />
            )}
          </Field>

          {scope !== 'COUNTRY' && (
            <Field
              label={t('logistics.partner.field.regionValue')}
              hint={t('logistics.partner.field.regionValueHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={regionValue}
                  onChange={(event) => {
                    setRegionValue(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}

          <div className="space-y-2">
            <CheckboxField
              label={t('logistics.partner.supportsPickup')}
              checked={supportsPickup}
              onChange={(event) => {
                setSupportsPickup(event.currentTarget.checked);
              }}
            />
            <CheckboxField
              label={t('logistics.partner.supportsDelivery')}
              checked={supportsDelivery}
              onChange={(event) => {
                setSupportsDelivery(event.currentTarget.checked);
              }}
            />
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// SLA policies
// ---------------------------------------------------------------------------

function SlaPoliciesCard({ partner }: { partner: PartnerDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [editing, setEditing] = useState<PartnerSlaPolicy | 'new' | null>(null);

  const blank: PartnerSlaPolicy = {
    id: '',
    name: '',
    serviceType: 'STANDARD',
    pickupHours: 24,
    deliveryHours: 72,
    riskWindowMinutes: 120,
    maxDeliveryAttempts: 3,
    podRequiresRecipientName: true,
    podRequiresSignature: false,
    podRequiresPhoto: false,
    podRequiresOtp: false,
    podRequiresDesignation: false,
    isDefault: partner.slaPolicies.length === 0,
    isActive: true,
  };

  const [draft, setDraft] = useState<PartnerSlaPolicy>(blank);

  const save = useMutation({
    mutationFn: () =>
      saveSlaPolicy(partner.id, {
        ...(draft.id.length > 0 ? { id: draft.id } : {}),
        name: draft.name.trim(),
        serviceType: draft.serviceType,
        pickupHours: draft.pickupHours,
        deliveryHours: draft.deliveryHours,
        riskWindowMinutes: draft.riskWindowMinutes,
        maxDeliveryAttempts: draft.maxDeliveryAttempts,
        podRequiresRecipientName: draft.podRequiresRecipientName,
        podRequiresSignature: draft.podRequiresSignature,
        podRequiresPhoto: draft.podRequiresPhoto,
        podRequiresOtp: draft.podRequiresOtp,
        podRequiresDesignation: draft.podRequiresDesignation,
        isDefault: draft.isDefault,
        isActive: draft.isActive,
      }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setEditing(null);
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'partner'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const mayEdit = can(Permission.LOGISTICS_WRITE);

  const open = (policy: PartnerSlaPolicy | 'new'): void => {
    setDraft(policy === 'new' ? blank : policy);
    setEditing(policy);
  };

  return (
    <Card
      title={t('logistics.partner.sla')}
      description={t('logistics.partner.slaIntro')}
      actions={
        mayEdit ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              open('new');
            }}
          >
            {t('logistics.partner.addSla')}
          </Button>
        ) : undefined
      }
    >
      {partner.slaPolicies.length === 0 ? (
        <EmptyState
          title={t('logistics.partner.noSlaTitle')}
          description={t('logistics.partner.noSlaBody')}
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {partner.slaPolicies.map((policy) => (
            <li
              key={policy.id}
              className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                  {policy.name}
                  {policy.isDefault && (
                    <Badge tone="accent">{t('logistics.partner.default')}</Badge>
                  )}
                  {!policy.isActive && (
                    <Badge tone="neutral">{t('logistics.partner.inactive')}</Badge>
                  )}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {humanise(policy.serviceType)} ·{' '}
                  {t('logistics.partner.slaWindows', {
                    pickup: policy.pickupHours === null ? '—' : `${String(policy.pickupHours)}h`,
                    delivery:
                      policy.deliveryHours === null ? '—' : `${String(policy.deliveryHours)}h`,
                  })}
                </p>
                <p className="mt-0.5 text-xxs text-ink-subtle">
                  {t('logistics.partner.podNeeds', { list: podSummary(policy, t) })}
                </p>
              </div>

              {mayEdit && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    open(policy);
                  }}
                >
                  {t('common.edit')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={editing !== null}
        onClose={() => {
          setEditing(null);
        }}
        title={editing === 'new' ? t('logistics.partner.addSla') : t('logistics.partner.editSla')}
        description={t('logistics.partner.slaDialogIntro')}
        size="lg"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              disabled={draft.name.trim().length === 0 || save.isPending}
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
            <Field label={t('logistics.partner.field.slaName')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={draft.name}
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.currentTarget.value });
                  }}
                />
              )}
            </Field>

            <Field label={t('logistics.partner.field.serviceType')}>
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={draft.serviceType}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      serviceType: event.currentTarget.value as PartnerSlaPolicy['serviceType'],
                    });
                  }}
                >
                  {(
                    [
                      'STANDARD',
                      'EXPRESS',
                      'SAME_DAY',
                      'ECONOMY',
                      'FREIGHT',
                      'WHITE_GLOVE',
                    ] as const
                  ).map((value) => (
                    <option key={value} value={value}>
                      {humanise(value)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>

            <Field
              label={t('logistics.partner.field.pickupHours')}
              hint={t('logistics.partner.field.hoursHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  min={0}
                  value={draft.pickupHours ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft({ ...draft, pickupHours: value === '' ? null : Number(value) });
                  }}
                />
              )}
            </Field>

            <Field
              label={t('logistics.partner.field.deliveryHours')}
              hint={t('logistics.partner.field.hoursHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  min={0}
                  value={draft.deliveryHours ?? ''}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft({ ...draft, deliveryHours: value === '' ? null : Number(value) });
                  }}
                />
              )}
            </Field>

            <Field
              label={t('logistics.partner.field.riskWindow')}
              hint={t('logistics.partner.field.riskWindowHint')}
            >
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  min={0}
                  value={draft.riskWindowMinutes}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      riskWindowMinutes: Number(event.currentTarget.value),
                    });
                  }}
                />
              )}
            </Field>

            <Field label={t('logistics.partner.field.maxAttempts')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  type="number"
                  min={1}
                  max={10}
                  value={draft.maxDeliveryAttempts}
                  onChange={(event) => {
                    setDraft({
                      ...draft,
                      maxDeliveryAttempts: Number(event.currentTarget.value),
                    });
                  }}
                />
              )}
            </Field>
          </div>

          <fieldset className="rounded-lg border border-border bg-surface-sunken p-4">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              {t('logistics.partner.podLegend')}
            </legend>
            <p className="mb-3 text-xs leading-relaxed text-ink-muted">
              {t('logistics.partner.podHint')}
            </p>

            <div className="space-y-2">
              {(
                [
                  ['podRequiresRecipientName', 'logistics.partner.pod.recipientName'],
                  ['podRequiresSignature', 'logistics.partner.pod.signature'],
                  ['podRequiresPhoto', 'logistics.partner.pod.photo'],
                  ['podRequiresOtp', 'logistics.partner.pod.otp'],
                  ['podRequiresDesignation', 'logistics.partner.pod.designation'],
                ] as const
              ).map(([key, labelKey]) => (
                <CheckboxField
                  key={key}
                  label={t(labelKey)}
                  checked={draft[key]}
                  onChange={(event) => {
                    setDraft({ ...draft, [key]: event.currentTarget.checked });
                  }}
                />
              ))}
            </div>
          </fieldset>

          <div className="space-y-2">
            <CheckboxField
              label={t('logistics.partner.makeDefault')}
              description={t('logistics.partner.makeDefaultHint')}
              checked={draft.isDefault}
              onChange={(event) => {
                setDraft({ ...draft, isDefault: event.currentTarget.checked });
              }}
            />
            <CheckboxField
              label={t('logistics.partner.slaActive')}
              checked={draft.isActive}
              onChange={(event) => {
                setDraft({ ...draft, isActive: event.currentTarget.checked });
              }}
            />
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

function MembersCard({ partner }: { partner: PartnerDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [isInviting, setIsInviting] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState<LogisticsRole>('DISPATCHER');
  const [sent, setSent] = useState<{ email: string; expiresAt: string } | null>(null);

  const invite = useMutation({
    mutationFn: () =>
      invitePartnerUser(partner.id, {
        email: email.trim(),
        fullName: fullName.trim(),
        role,
      }),
    onSuccess: (result) => {
      setSent(result);
      setEmail('');
      setFullName('');
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics', 'partner'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const mayInvite = can(Permission.LOGISTICS_WRITE);

  return (
    <Card
      title={t('logistics.partner.people')}
      description={t('logistics.partner.peopleIntro')}
      actions={
        mayInvite ? (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setSent(null);
              setIsInviting(true);
            }}
          >
            {t('logistics.partner.invite')}
          </Button>
        ) : undefined
      }
    >
      {partner.users.length === 0 ? (
        <EmptyState
          title={t('logistics.partner.noPeopleTitle')}
          description={t('logistics.partner.noPeopleBody')}
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {partner.users.map((member) => (
            <li
              key={member.id}
              className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{member.fullName}</p>
                <p className="truncate text-xs text-ink-muted">{member.user.email}</p>
              </div>

              <Badge tone="neutral">{t(roleKey(member.role))}</Badge>

              <Badge tone={member.status === 'ACTIVE' ? 'success' : 'warning'}>
                {humanise(member.status)}
              </Badge>

              <Badge tone={member.user.mfaEnabledAt === null ? 'warning' : 'success'}>
                {member.user.mfaEnabledAt === null
                  ? t('logistics.partner.mfaMissing')
                  : t('logistics.partner.mfaOn')}
              </Badge>

              <span className="w-32 shrink-0 text-right text-xxs text-ink-subtle">
                {member.lastActiveAt === null
                  ? t('logistics.partner.neverSignedIn')
                  : formatDateTime(member.lastActiveAt)}
              </span>
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={isInviting}
        onClose={() => {
          setIsInviting(false);
        }}
        title={t('logistics.partner.invite')}
        {...(sent === null ? { description: t('logistics.partner.inviteIntro') } : {})}
        footer={
          sent === null ? (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  setIsInviting(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                disabled={
                  email.trim().length === 0 || fullName.trim().length < 2 || invite.isPending
                }
                onClick={() => {
                  invite.mutate();
                }}
              >
                {t('logistics.partner.sendInvitation')}
              </Button>
            </>
          ) : (
            <Button
              onClick={() => {
                setIsInviting(false);
              }}
            >
              {t('common.done')}
            </Button>
          )
        }
      >
        {sent !== null ? (
          <Callout tone="success" title={t('logistics.partners.invited.title')} role="status">
            <p>{t('logistics.partners.invited.body', { email: sent.email })}</p>
            <p className="mt-2">
              {t('logistics.partners.invited.expires', { date: formatDate(sent.expiresAt) })}
            </p>
            <p className="mt-2">{t('logistics.partners.invited.noPassword')}</p>
          </Callout>
        ) : (
          <div className="space-y-4">
            <Field label={t('logistics.partner.field.personName')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={fullName}
                  onChange={(event) => {
                    setFullName(event.currentTarget.value);
                  }}
                />
              )}
            </Field>

            <Field label={t('logistics.partner.field.personEmail')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  type="email"
                  aria-describedby={describedBy}
                  value={email}
                  onChange={(event) => {
                    setEmail(event.currentTarget.value);
                  }}
                />
              )}
            </Field>

            <Field
              label={t('logistics.partner.field.role')}
              hint={t('logistics.partner.field.roleHint')}
            >
              {({ inputId, describedBy }) => (
                <Select
                  id={inputId}
                  aria-describedby={describedBy}
                  value={role}
                  onChange={(event) => {
                    setRole(event.currentTarget.value as LogisticsRole);
                  }}
                >
                  {ROLES.map((value) => (
                    <option key={value} value={value}>
                      {t(roleKey(value))}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function capabilityTone(state: CapabilityState): 'success' | 'warning' | 'danger' | 'neutral' {
  switch (state) {
    case 'APPROVED':
      return 'success';
    case 'REQUESTED':
      return 'warning';
    case 'REJECTED':
      return 'danger';
    case 'SUSPENDED':
      return 'neutral';
  }
}

/** The proof a delivery needs, as a short list rather than five booleans. */
function podSummary(policy: PartnerSlaPolicy, t: Translate): string {
  const parts: string[] = [];

  if (policy.podRequiresRecipientName) parts.push(t('logistics.partner.pod.recipientName'));
  if (policy.podRequiresSignature) parts.push(t('logistics.partner.pod.signature'));
  if (policy.podRequiresPhoto) parts.push(t('logistics.partner.pod.photo'));
  if (policy.podRequiresOtp) parts.push(t('logistics.partner.pod.otp'));
  if (policy.podRequiresDesignation) parts.push(t('logistics.partner.pod.designation'));

  return parts.length === 0 ? t('logistics.partner.pod.nothing') : parts.join(', ');
}
