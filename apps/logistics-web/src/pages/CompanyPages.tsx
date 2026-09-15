/**
 * The carrier's own record: its contract, its people, its fleet.
 *
 * WHAT A CARRIER MAY CHANGE ABOUT ITSELF
 *
 * Contact details, and nothing else. Its approved service regions, its
 * approved handling capabilities and its agreed service levels are the
 * CONTRACT between the marketplace and the carrier - a carrier that could
 * widen its own approved regions could assign itself work it is not licensed
 * to carry, and this is medical freight. They are shown here, plainly, marked
 * as the operator's to change.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { formatDate, formatRelative } from '@/lib/format';
import {
  driversKey,
  fetchDrivers,
  fetchOrganisation,
  fetchVehicles,
  membersKey,
  fetchMembers,
  organisationKey,
  updateOrganisation,
  vehiclesKey,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { useFocusOnMount } from '@/lib/use-focus-on-mount';
import { capabilityKindLabel } from '@/lib/shipment-display';
import { useSession } from '@/auth/session-context';
import type { DriverRow, MemberRow, VehicleRow } from '@/lib/types';

// ---------------------------------------------------------------------------
// The company
// ---------------------------------------------------------------------------

export function CompanyPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canAny } = useSession();

  const organisation = useQuery({ queryKey: organisationKey, queryFn: fetchOrganisation });
  const members = useQuery({
    queryKey: membersKey,
    queryFn: fetchMembers,
    enabled: canAny(Permission.MEMBER_READ),
    retry: false,
  });

  const [contactEmail, setContactEmail] = useState<string | null>(null);
  const focusEmail = useFocusOnMount();

  const save = useMutation({
    mutationFn: (email: string) => updateOrganisation({ contactEmail: email }),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setContactEmail(null);
      void queryClient.invalidateQueries({ queryKey: organisationKey });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (organisation.isLoading) return <LoadingState />;

  if (organisation.isError || organisation.data === undefined) {
    return (
      <ErrorState
        error={organisation.error}
        onRetry={() => {
          void organisation.refetch();
        }}
      />
    );
  }

  const data = organisation.data;

  const memberColumns: Column<MemberRow>[] = [
    { key: 'name', header: t('company.people'), render: (row) => row.fullName },
    { key: 'email', header: t('auth.email'), secondary: true, render: (row) => row.email },
    {
      key: 'role',
      header: t('company.role'),
      render: (row) => <Badge tone="neutral">{row.role}</Badge>,
    },
    {
      key: 'mfa',
      header: 'MFA',
      align: 'center',
      tertiary: true,
      render: (row) =>
        row.requiresMfa ? (
          // Whether they have enrolled - never the secret, and never a hint at
          // it. An owner who has not is an account one password away.
          <Badge tone={row.mfaEnrolled ? 'success' : 'warning'}>
            {row.mfaEnrolled ? t('common.yes') : t('common.no')}
          </Badge>
        ) : (
          '—'
        ),
    },
    {
      key: 'status',
      header: t('shipments.column.status'),
      render: (row) => (
        <Badge
          tone={
            row.status === 'ACTIVE' ? 'success' : row.status === 'INVITED' ? 'accent' : 'neutral'
          }
        >
          {row.status}
        </Badge>
      ),
    },
    {
      key: 'lastActive',
      header: t('shipments.column.lastEvent'),
      align: 'right',
      tertiary: true,
      render: (row) => formatRelative(row.lastActiveAt),
    },
  ];

  return (
    <>
      <PageHeader title={data.displayName} description={data.legalName} />

      {data.status === 'SUSPENDED' ? (
        <Callout tone="warning" className="mb-4">
          {t('company.suspended')}
          {data.suspensionReason === null ? null : (
            <span className="mt-1 block text-xs">
              {t('company.suspendedReason')}: {data.suspensionReason}
            </span>
          )}
        </Callout>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-2">
        <Card
          bodyClassName="px-5 py-4"
          title={t('company.contact')}
          actions={
            canAny(Permission.ORGANISATION_WRITE) && contactEmail === null ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setContactEmail(data.contactEmail);
                }}
              >
                {t('company.editContact')}
              </Button>
            ) : undefined
          }
        >
          {contactEmail === null ? (
            <DescriptionList
              items={[
                { label: t('auth.email'), value: data.contactEmail },
                { label: t('company.telephone'), value: data.contactPhone ?? '—' },
                { label: t('company.outOfHours'), value: data.emergencyPhone ?? '—' },
                { label: t('company.website'), value: data.websiteUrl ?? '—' },
                { label: t('company.country'), value: data.registrationCountry },
                { label: t('company.reference'), value: data.partnerCode },
              ]}
            />
          ) : (
            <>
              <Field label={t('auth.email')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    ref={focusEmail}
                    type="email"
                    value={contactEmail}
                    onChange={(event) => {
                      setContactEmail(event.target.value);
                    }}
                  />
                )}
              </Field>

              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => {
                    save.mutate(contactEmail);
                  }}
                >
                  {t('company.saveContact')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setContactEmail(null);
                  }}
                >
                  {t('modal.cancel')}
                </Button>
              </div>
            </>
          )}
        </Card>

        <Card
          title={t('company.regions')}
          description={t('company.setByUboss')}
          bodyClassName="px-5 py-4"
        >
          {data.regions.length === 0 ? (
            <p className="text-sm text-ink-subtle">{t('common.nothingHereYet')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {data.regions.map((region) => (
                <li key={region.id}>
                  <Badge tone={region.isActive ? 'accent' : 'neutral'}>
                    {region.countryCode}
                    {region.regionValue === '' ? '' : ` ${region.regionValue}`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t('company.capabilities')}
          description={t('company.setByUboss')}
          bodyClassName="px-5 py-4"
        >
          {data.capabilities.length === 0 ? (
            <p className="text-sm text-ink-subtle">{t('common.nothingHereYet')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {data.capabilities.map((capability) => (
                <li key={capability.id}>
                  <Badge
                    tone={
                      capability.state === 'APPROVED'
                        ? 'success'
                        : capability.state === 'REJECTED'
                          ? 'danger'
                          : 'neutral'
                    }
                    dot
                  >
                    {capabilityKindLabel(capability.kind, t)}
                    {capability.evidenceExpiresAt === null
                      ? ''
                      : ` · ${formatDate(capability.evidenceExpiresAt)}`}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title={t('company.sla')}
          description={t('company.setByUboss')}
          bodyClassName="px-5 py-4"
        >
          {data.slaPolicies.length === 0 ? (
            <p className="text-sm text-ink-subtle">{t('common.nothingHereYet')}</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {data.slaPolicies.map((policy) => (
                <li key={policy.id}>
                  {/* The badge is inline-flex, so without the gap it sat
                      hard against the last letter of the policy name. */}
                  <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                    {policy.name}
                    {policy.isDefault ? <Badge tone="accent">{policy.serviceType}</Badge> : null}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {policy.pickupHours === null ? '—' : `${String(policy.pickupHours)}h`} ·{' '}
                    {policy.deliveryHours === null ? '—' : `${String(policy.deliveryHours)}h`}
                  </p>
                  {/*
                    What this deployment accepts as proof. A business decision,
                    stated so a carrier can train its drivers to it rather than
                    discovering it at a door.
                  */}
                  <p className="mt-1 flex flex-wrap gap-1.5">
                    {policy.podRequiresRecipientName ? (
                      <Badge tone="neutral">{t('pod.recipientName')}</Badge>
                    ) : null}
                    {policy.podRequiresSignature ? (
                      <Badge tone="neutral">{t('pod.signature')}</Badge>
                    ) : null}
                    {policy.podRequiresPhoto ? (
                      <Badge tone="neutral">{t('pod.photo')}</Badge>
                    ) : null}
                    {policy.podRequiresOtp ? <Badge tone="neutral">{t('pod.otp')}</Badge> : null}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {canAny(Permission.MEMBER_READ) ? (
        <Card title={t('company.people')} className="mt-4">
          <DataTable
            caption={t('company.people')}
            columns={memberColumns}
            rows={members.data?.members}
            rowKey={(row) => row.id}
            isLoading={members.isLoading}
            minWidth="42rem"
          />
        </Card>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The fleet
// ---------------------------------------------------------------------------

export function DriversPage(): React.JSX.Element {
  const { t } = useI18n();
  const { canAny } = useSession();

  const drivers = useQuery({
    queryKey: driversKey,
    queryFn: fetchDrivers,
    enabled: canAny(Permission.DRIVER_READ),
    retry: false,
  });

  const vehicles = useQuery({
    queryKey: vehiclesKey,
    queryFn: fetchVehicles,
    enabled: canAny(Permission.VEHICLE_READ),
    retry: false,
  });

  const driverColumns: Column<DriverRow>[] = [
    { key: 'name', header: t('drivers.driverName'), render: (row) => row.fullName },
    {
      key: 'state',
      header: t('shipments.column.status'),
      render: (row) => (
        <Badge tone={row.state === 'ACTIVE' ? 'success' : 'neutral'} dot>
          {row.state}
        </Badge>
      ),
    },
    {
      key: 'clearedFor',
      header: t('drivers.clearedFor'),
      render: (row) => {
        const cleared: string[] = [];
        if (row.canCarryColdChain) cleared.push(t('shipment.coldChain'));
        if (row.canCarrySterile) cleared.push(t('shipment.sterile'));
        if (row.canCarryDangerousGoods) cleared.push(t('shipment.dangerousGoods'));
        return cleared.length === 0 ? '—' : cleared.join(' · ');
      },
    },
    {
      key: 'licence',
      header: t('drivers.licenceExpires'),
      align: 'right',
      nowrap: true,
      secondary: true,
      render: (row) => formatDate(row.licenceExpiresAt),
    },
    {
      key: 'consent',
      header: t('drivers.locationConsent'),
      align: 'center',
      tertiary: true,
      render: (row) => (
        <Badge tone={row.hasLocationConsent ? 'success' : 'neutral'}>
          {row.hasLocationConsent ? t('common.yes') : t('common.no')}
        </Badge>
      ),
    },
    {
      key: 'open',
      header: t('drivers.openTasks'),
      align: 'right',
      render: (row) => row.openTasks,
    },
  ];

  const vehicleColumns: Column<VehicleRow>[] = [
    { key: 'registration', header: t('drivers.registration'), render: (row) => row.registration },
    { key: 'kind', header: t('drivers.vehicleType'), render: (row) => row.kind },
    {
      key: 'refrigeration',
      header: t('shipment.coldChain'),
      align: 'center',
      render: (row) => (row.hasRefrigeration ? t('common.yes') : '—'),
    },
    {
      key: 'active',
      header: t('shipments.column.status'),
      render: (row) => (
        <Badge tone={row.isActive ? 'success' : 'neutral'}>
          {row.isActive ? t('common.yes') : t('common.no')}
        </Badge>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('drivers.heading')} />

      <div className="space-y-4">
        {canAny(Permission.DRIVER_READ) ? (
          <Card title={t('drivers.driversCard')}>
            {(drivers.data?.drivers.length ?? 0) === 0 && !drivers.isLoading ? (
              <EmptyState title={t('drivers.emptyTitle')} description={t('drivers.emptyBody')} />
            ) : (
              <DataTable
                caption={t('drivers.driversCard')}
                columns={driverColumns}
                rows={drivers.data?.drivers}
                rowKey={(row) => row.id}
                isLoading={drivers.isLoading}
                minWidth="44rem"
              />
            )}
          </Card>
        ) : null}

        {canAny(Permission.VEHICLE_READ) ? (
          <Card title={t('drivers.vehicles')}>
            <DataTable
              caption={t('drivers.vehicles')}
              columns={vehicleColumns}
              rows={vehicles.data?.vehicles}
              rowKey={(row) => row.id}
              isLoading={vehicles.isLoading}
              minWidth="32rem"
            />
          </Card>
        ) : null}
      </div>
    </>
  );
}
