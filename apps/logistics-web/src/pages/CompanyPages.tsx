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
  CheckboxField,
  DescriptionList,
  EmptyState,
  ErrorState,
  Field,
  FieldGroup,
  Input,
  LoadingState,
  PageHeader,
  Select,
} from '@/components/ui';
import { DataTable, type Column } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { formatDate, formatRelative } from '@/lib/format';
import {
  createDriver,
  createVehicle,
  driversKey,
  fetchDrivers,
  fetchOrganisation,
  fetchVehicles,
  membersKey,
  fetchMembers,
  organisationKey,
  updateDriver,
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

/** What the driver form is working on. */
interface DriverDraft {
  /** Typed, not picked. This is the whole point of the screen. */
  fullName: string;
  phone: string;
  email: string;
  employeeReference: string;
  licenceNumber: string;
  /** `YYYY-MM-DD`, as a date input gives it. */
  licenceExpiresAt: string;
  canCarryColdChain: boolean;
  canCarrySterile: boolean;
  canCarryDangerousGoods: boolean;
  /** Optional: links a colleague's account so they can use the phone app. */
  partnerUserId: string;
}

const EMPTY_DRIVER_DRAFT: DriverDraft = {
  fullName: '',
  phone: '',
  email: '',
  employeeReference: '',
  licenceNumber: '',
  licenceExpiresAt: '',
  canCarryColdChain: false,
  canCarrySterile: false,
  canCarryDangerousGoods: false,
  partnerUserId: '',
};

/** What the vehicle form is working on. */
interface VehicleDraft {
  registration: string;
  kind: string;
  hasRefrigeration: boolean;
  hasTailLift: boolean;
  /** Degrees Celsius, as typed. Empty is "not recorded". */
  temperatureMinC: string;
  temperatureMaxC: string;
  /** Kilograms, as typed. Sent as grams, because weight is integer minor units. */
  maxWeightKg: string;
}

const EMPTY_VEHICLE_DRAFT: VehicleDraft = {
  registration: '',
  kind: 'VAN',
  hasRefrigeration: false,
  hasTailLift: false,
  temperatureMinC: '',
  temperatureMaxC: '',
  maxWeightKg: '',
};

const VEHICLE_KINDS = [
  'VAN',
  'TRUCK',
  'BIKE',
  'CAR',
  'REFRIGERATED_VAN',
  'REFRIGERATED_TRUCK',
] as const;

/**
 * The fleet: who drives, what they drive, and what each is cleared to carry.
 *
 * A DRIVER RECORD IS NOT A LOGIN
 *
 * The owner types the name. Nothing here creates an account, and nothing here
 * needs one: a carrier employs people who will never open this software - an
 * agency driver covering a round, a subcontractor's van, somebody who started
 * this morning - and a register that could only hold people with a login is a
 * register that does not describe the fleet. That was the old form's mistake,
 * and it meant a dispatcher could not put a real person on a real parcel until
 * an invitation email had been sent, opened and accepted.
 *
 * AN ACCOUNT IS OPTIONAL AND ADDITIVE
 *
 * Linking a colleague's account is offered, not required, and it says plainly
 * what it buys: the phone app, which is what gates the task list, the scanner,
 * proof of delivery and the trip a location ping belongs to. A driver with no
 * account is a name a dispatcher can put on a van, and that is most of a fleet.
 *
 * NOBODY IS DELETED
 *
 * A driver with delivery history is stood down, never removed: every
 * assignment they ever held points at the row, and the chain of who carried
 * what is the thing an operator reads after a bad delivery. Standing somebody
 * down while they are holding consignments asks first, and says how many.
 */
export function DriversPage(): React.JSX.Element {
  const { t } = useI18n();
  const { canAny } = useSession();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [search, setSearch] = useState('');
  const [stateFilter, setStateFilter] = useState('');
  /** The driver whose stand-down is waiting on an answer. */
  const [confirmStandDown, setConfirmStandDown] = useState<DriverRow | null>(null);
  /**
   * The open driver form, or null.
   *
   * `editing` is the record being changed; null with a draft open means a new
   * one. Holding the row rather than its id so the form can be filled from it
   * without waiting for a refetch.
   */
  const [draft, setDraft] = useState<DriverDraft | null>(null);
  const [editing, setEditing] = useState<DriverRow | null>(null);
  const [vehicleDraft, setVehicleDraft] = useState<VehicleDraft | null>(null);

  const canWriteDrivers = canAny(Permission.DRIVER_WRITE);
  const canWriteVehicles = canAny(Permission.VEHICLE_WRITE);

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

  /*
   * The team, for the optional account link.
   *
   * Only fetched for somebody who may both read the team and write a driver -
   * there is no other reason for this screen to hold it - and the form works
   * without it, because linking an account is the exception rather than the
   * rule.
   */
  const members = useQuery({
    queryKey: membersKey,
    queryFn: fetchMembers,
    enabled: canAny(Permission.MEMBER_READ) && canWriteDrivers,
    retry: false,
  });

  /*
   * Standing somebody down, and bringing them back.
   *
   * A patch of one field, which is the change the new endpoint makes possible:
   * the old whole-record upsert had to send the certifications back with it or
   * silently clear them, and getting that wrong took a driver's cold-chain
   * clearance away without anybody asking for it.
   */
  const setState = useMutation({
    mutationFn: (input: { driver: DriverRow; state: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' }) =>
      updateDriver(input.driver.id, { state: input.state }),
    onSuccess: async (_result, input) => {
      toast.success(input.state === 'ACTIVE' ? t('drivers.broughtBack') : t('drivers.stoodDown'));
      setConfirmStandDown(null);
      await queryClient.invalidateQueries({ queryKey: driversKey });
    },
    onError: () => {
      toast.error(t('drivers.couldNotSave'));
      setConfirmStandDown(null);
    },
  });

  /**
   * Create or change a driver record.
   *
   * One write either way. An empty field means "not recorded" and is sent as
   * null on an edit - so clearing a licence number clears it - and omitted on
   * a create, where there is nothing to clear.
   */
  const saveDriver = useMutation({
    mutationFn: async (input: DriverDraft) => {
      const trimmed = {
        fullName: input.fullName.trim(),
        phone: input.phone.trim(),
        email: input.email.trim(),
        employeeReference: input.employeeReference.trim(),
        licenceNumber: input.licenceNumber.trim(),
      };

      if (editing !== null) {
        return updateDriver(editing.id, {
          fullName: trimmed.fullName,
          phone: trimmed.phone === '' ? null : trimmed.phone,
          email: trimmed.email === '' ? null : trimmed.email,
          employeeReference: trimmed.employeeReference === '' ? null : trimmed.employeeReference,
          licenceNumber: trimmed.licenceNumber === '' ? null : trimmed.licenceNumber,
          licenceExpiresAt: input.licenceExpiresAt === '' ? null : input.licenceExpiresAt,
          canCarryColdChain: input.canCarryColdChain,
          canCarrySterile: input.canCarrySterile,
          canCarryDangerousGoods: input.canCarryDangerousGoods,
          // The account link is only sent when it changed, so an edit to a
          // licence number cannot quietly unlink somebody's phone app.
          ...(input.partnerUserId === (editing.partnerUserId ?? '')
            ? {}
            : { partnerUserId: input.partnerUserId === '' ? null : input.partnerUserId }),
        });
      }

      return createDriver({
        fullName: trimmed.fullName,
        ...(trimmed.phone === '' ? {} : { phone: trimmed.phone }),
        ...(trimmed.email === '' ? {} : { email: trimmed.email }),
        ...(trimmed.employeeReference === ''
          ? {}
          : { employeeReference: trimmed.employeeReference }),
        ...(trimmed.licenceNumber === '' ? {} : { licenceNumber: trimmed.licenceNumber }),
        ...(input.licenceExpiresAt === '' ? {} : { licenceExpiresAt: input.licenceExpiresAt }),
        canCarryColdChain: input.canCarryColdChain,
        canCarrySterile: input.canCarrySterile,
        canCarryDangerousGoods: input.canCarryDangerousGoods,
        ...(input.partnerUserId === '' ? {} : { partnerUserId: input.partnerUserId }),
        state: 'ACTIVE',
      });
    },
    onSuccess: async () => {
      toast.success(editing === null ? t('drivers.added') : t('common.saved'));
      setDraft(null);
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: driversKey });
      // An account may have been linked, which changes what the team list says
      // about that person.
      await queryClient.invalidateQueries({ queryKey: membersKey });
    },
    // The server's own message: it names the reason - already has a driver
    // record, not a member of this carrier - and each of those is something
    // the dispatcher can act on.
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  /**
   * Put a van on the fleet.
   *
   * Here rather than on a screen of its own because a dispatcher adding a
   * driver is usually adding the van they drive in the same five minutes, and
   * a vehicle is what carries the cold-chain range a consignment is matched
   * against.
   */
  const saveVehicle = useMutation({
    mutationFn: (input: VehicleDraft) => {
      const min = Number.parseFloat(input.temperatureMinC);
      const max = Number.parseFloat(input.temperatureMaxC);
      const kg = Number.parseFloat(input.maxWeightKg);

      return createVehicle({
        registration: input.registration.trim(),
        kind: input.kind,
        hasRefrigeration: input.hasRefrigeration,
        hasTailLift: input.hasTailLift,
        ...(Number.isFinite(min) ? { temperatureMinC: min } : {}),
        ...(Number.isFinite(max) ? { temperatureMaxC: max } : {}),
        // Typed in kilograms because that is what is written on the van;
        // stored in grams because a weight is an integer in minor units.
        ...(Number.isFinite(kg) ? { maxWeightGrams: Math.round(kg * 1000) } : {}),
      });
    },
    onSuccess: async () => {
      toast.success(t('drivers.vehicleAdded'));
      setVehicleDraft(null);
      await queryClient.invalidateQueries({ queryKey: vehiclesKey });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const openNewDriver = (): void => {
    setEditing(null);
    setDraft(EMPTY_DRIVER_DRAFT);
    saveDriver.reset();
  };

  const openEditDriver = (row: DriverRow): void => {
    setEditing(row);
    setDraft({
      fullName: row.fullName,
      phone: row.phone ?? '',
      email: row.email ?? '',
      employeeReference: row.employeeReference ?? '',
      licenceNumber: row.licenceNumber ?? '',
      // The date input wants `YYYY-MM-DD`; the API sends an instant.
      licenceExpiresAt: row.licenceExpiresAt === null ? '' : row.licenceExpiresAt.slice(0, 10),
      canCarryColdChain: row.canCarryColdChain,
      canCarrySterile: row.canCarrySterile,
      canCarryDangerousGoods: row.canCarryDangerousGoods,
      partnerUserId: row.partnerUserId ?? '',
    });
    saveDriver.reset();
  };

  /**
   * Whose account can be linked.
   *
   * Everybody in the organisation who does not already have a driver record,
   * plus - while editing - the person already linked to this one, so the form
   * can show who it is rather than an empty box.
   */
  const linkable = (members.data?.members ?? []).filter(
    (row) => row.status !== 'DISABLED' && (!row.isDriver || row.id === editing?.partnerUserId),
  );

  /*
   * Filtered in the browser, and that is the right call here where it is the
   * wrong one on the shipment list next door. A carrier's fleet is counted in
   * tens: the whole list is already in hand, and a round trip per keystroke
   * would be slower than the filter it replaced.
   */
  const visibleDrivers = (drivers.data?.drivers ?? []).filter((row) => {
    const term = search.trim().toLowerCase();

    if (stateFilter !== '' && row.state !== stateFilter) return false;
    if (term === '') return true;

    return (
      row.fullName.toLowerCase().includes(term) ||
      (row.employeeReference ?? '').toLowerCase().includes(term) ||
      (row.phone ?? '').toLowerCase().includes(term)
    );
  });

  const driverColumns: Column<DriverRow>[] = [
    {
      key: 'name',
      header: t('drivers.driverName'),
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{row.fullName}</p>
          {row.employeeReference !== null && (
            <p className="truncate font-mono text-xxs text-ink-subtle">{row.employeeReference}</p>
          )}
        </div>
      ),
    },
    {
      key: 'contact',
      header: t('drivers.contact'),
      secondary: true,
      render: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm text-ink-muted">{row.phone ?? '—'}</p>
          {/* Said on the row rather than in a tooltip, because it is the
              answer to "why can this driver not see their tasks?" and that
              question is asked at the moment somebody is looking at the list. */}
          <p className="truncate text-xxs text-ink-subtle">
            {row.hasPortalAccess ? t('drivers.hasApp') : t('drivers.recordOnly')}
          </p>
        </div>
      ),
    },
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
    ...(canWriteDrivers
      ? [
          {
            key: 'actions',
            header: t('drivers.actions'),
            align: 'right' as const,
            render: (row: DriverRow) => (
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    openEditDriver(row);
                  }}
                >
                  {t('common.edit')}
                </Button>
                {row.state === 'ACTIVE' ? (
                  <Button
                    size="sm"
                    disabled={setState.isPending}
                    onClick={() => {
                      /*
                       * Straight through when they are holding nothing, and a
                       * question when they are. Standing somebody down
                       * mid-round leaves consignments on a task list nobody
                       * will work, and the dispatcher is the only one who
                       * knows whether that is what they meant.
                       */
                      if (row.openTasks === 0) {
                        setState.mutate({ driver: row, state: 'INACTIVE' });
                        return;
                      }
                      setConfirmStandDown(row);
                    }}
                  >
                    {t('drivers.standDown')}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    disabled={setState.isPending}
                    onClick={() => {
                      setState.mutate({ driver: row, state: 'ACTIVE' });
                    }}
                  >
                    {t('drivers.bringBack')}
                  </Button>
                )}
              </div>
            ),
          },
        ]
      : []),
  ];

  const vehicleColumns: Column<VehicleRow>[] = [
    { key: 'registration', header: t('drivers.registration'), render: (row) => row.registration },
    { key: 'kind', header: t('drivers.vehicleType'), render: (row) => row.kind },
    {
      key: 'refrigeration',
      header: t('shipment.coldChain'),
      align: 'center',
      render: (row) =>
        row.hasRefrigeration
          ? row.temperatureMinC === null || row.temperatureMaxC === null
            ? t('common.yes')
            : `${row.temperatureMinC}–${row.temperatureMaxC} °C`
          : '—',
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
          <Card
            title={t('drivers.driversCard')}
            actions={
              canWriteDrivers ? (
                <Button size="sm" onClick={openNewDriver}>
                  {t('drivers.addDriver')}
                </Button>
              ) : undefined
            }
          >
            {(drivers.data?.drivers.length ?? 0) === 0 && !drivers.isLoading ? (
              <EmptyState
                title={t('drivers.emptyTitle')}
                description={t('drivers.emptyBody')}
                action={
                  canWriteDrivers ? (
                    <Button onClick={openNewDriver}>{t('drivers.addDriver')}</Button>
                  ) : undefined
                }
              />
            ) : (
              <>
                <div className="mb-3 flex flex-wrap items-end gap-3">
                  <Field label={t('drivers.findDriver')}>
                    {({ inputId }) => (
                      <Input
                        id={inputId}
                        type="search"
                        className="sm:w-56"
                        value={search}
                        placeholder={t('drivers.findDriverPlaceholder')}
                        onChange={(event) => {
                          setSearch(event.target.value);
                        }}
                      />
                    )}
                  </Field>

                  <Field label={t('shipments.column.status')}>
                    {({ inputId }) => (
                      <Select
                        id={inputId}
                        className="sm:w-44"
                        value={stateFilter}
                        onChange={(event) => {
                          setStateFilter(event.target.value);
                        }}
                      >
                        <option value="">{t('drivers.anyState')}</option>
                        <option value="ACTIVE">ACTIVE</option>
                        <option value="INACTIVE">INACTIVE</option>
                        <option value="SUSPENDED">SUSPENDED</option>
                      </Select>
                    )}
                  </Field>
                </div>

                {/* Standing somebody down while they are holding consignments
                    is a decision, not a click. It says how many, because "are
                    you sure" without a number is a question nobody can answer
                    properly. */}
                {confirmStandDown !== null && (
                  <Callout tone="warning" title={t('drivers.standDownTitle')}>
                    <p className="text-sm leading-relaxed">
                      {t('drivers.standDownBody', {
                        name: confirmStandDown.fullName,
                        count: confirmStandDown.openTasks,
                      })}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button
                        size="sm"
                        disabled={setState.isPending}
                        onClick={() => {
                          setState.mutate({ driver: confirmStandDown, state: 'INACTIVE' });
                        }}
                      >
                        {t('drivers.standDown')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => {
                          setConfirmStandDown(null);
                        }}
                      >
                        {t('modal.cancel')}
                      </Button>
                    </div>
                  </Callout>
                )}

                <DataTable
                  caption={t('drivers.driversCard')}
                  columns={driverColumns}
                  rows={visibleDrivers}
                  rowKey={(row) => row.id}
                  isLoading={drivers.isLoading}
                  minWidth="64rem"
                  emptyTitle={t('drivers.noMatchTitle')}
                  emptyDescription={t('drivers.noMatchBody')}
                />
              </>
            )}
          </Card>
        ) : null}

        {canAny(Permission.VEHICLE_READ) ? (
          <Card
            title={t('drivers.vehicles')}
            actions={
              canWriteVehicles ? (
                <Button
                  size="sm"
                  onClick={() => {
                    setVehicleDraft(EMPTY_VEHICLE_DRAFT);
                    saveVehicle.reset();
                  }}
                >
                  {t('drivers.addVehicle')}
                </Button>
              ) : undefined
            }
          >
            {(vehicles.data?.vehicles.length ?? 0) === 0 && !vehicles.isLoading ? (
              <EmptyState
                title={t('drivers.noVehiclesTitle')}
                description={t('drivers.noVehiclesBody')}
                action={
                  canWriteVehicles ? (
                    <Button
                      onClick={() => {
                        setVehicleDraft(EMPTY_VEHICLE_DRAFT);
                        saveVehicle.reset();
                      }}
                    >
                      {t('drivers.addVehicle')}
                    </Button>
                  ) : undefined
                }
              />
            ) : (
              <DataTable
                caption={t('drivers.vehicles')}
                columns={vehicleColumns}
                rows={vehicles.data?.vehicles}
                rowKey={(row) => row.id}
                isLoading={vehicles.isLoading}
                minWidth="32rem"
              />
            )}
          </Card>
        ) : null}
      </div>

      {/* Mounted only while open, so the form's own state starts clean each
          time rather than carrying the last driver's licence number into the
          next one. */}
      {draft !== null && (
        <Modal
          isOpen
          onClose={() => {
            setDraft(null);
            setEditing(null);
          }}
          title={editing === null ? t('drivers.addDriver') : t('drivers.editDriver')}
          description={editing === null ? t('drivers.addDriverHint') : editing.fullName}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setDraft(null);
                  setEditing(null);
                }}
              >
                {t('modal.cancel')}
              </Button>
              <Button
                disabled={draft.fullName.trim().length < 2 || saveDriver.isPending}
                onClick={() => {
                  saveDriver.mutate(draft);
                }}
              >
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            {/* The name, typed. The field the whole screen turns on: everything
                else on this form is optional, and a fleet can be built from
                nothing but these. */}
            <Field label={t('drivers.driverName')} required hint={t('drivers.driverNameHint')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  value={draft.fullName}
                  maxLength={160}
                  autoComplete="off"
                  placeholder={t('drivers.driverNamePlaceholder')}
                  onChange={(event) => {
                    setDraft({ ...draft, fullName: event.target.value });
                  }}
                />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('drivers.phone')} hint={t('drivers.phoneHint')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    type="tel"
                    value={draft.phone}
                    maxLength={32}
                    autoComplete="off"
                    onChange={(event) => {
                      setDraft({ ...draft, phone: event.target.value });
                    }}
                  />
                )}
              </Field>

              <Field label={t('drivers.email')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    type="email"
                    value={draft.email}
                    maxLength={320}
                    autoComplete="off"
                    onChange={(event) => {
                      setDraft({ ...draft, email: event.target.value });
                    }}
                  />
                )}
              </Field>
            </div>

            <Field label={t('drivers.employeeReference')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  value={draft.employeeReference}
                  maxLength={64}
                  onChange={(event) => {
                    setDraft({ ...draft, employeeReference: event.target.value });
                  }}
                />
              )}
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('drivers.licenceNumber')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={draft.licenceNumber}
                    maxLength={64}
                    onChange={(event) => {
                      setDraft({ ...draft, licenceNumber: event.target.value });
                    }}
                  />
                )}
              </Field>

              <Field label={t('drivers.licenceExpires')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    type="date"
                    value={draft.licenceExpiresAt}
                    onChange={(event) => {
                      setDraft({ ...draft, licenceExpiresAt: event.target.value });
                    }}
                  />
                )}
              </Field>
            </div>

            {/* What they are cleared to carry. These are checked against the
                consignment when a driver is put on one, which is why they are
                here rather than in a note somewhere: an unticked box is a
                refusal at assignment time, not a formality. */}
            <FieldGroup legend={t('drivers.clearedFor')} hint={t('drivers.clearedForHint')}>
              <div className="space-y-2">
                <CheckboxField
                  boxed
                  label={t('shipment.coldChain')}
                  checked={draft.canCarryColdChain}
                  onChange={(event) => {
                    setDraft({ ...draft, canCarryColdChain: event.target.checked });
                  }}
                />
                <CheckboxField
                  boxed
                  label={t('shipment.sterile')}
                  checked={draft.canCarrySterile}
                  onChange={(event) => {
                    setDraft({ ...draft, canCarrySterile: event.target.checked });
                  }}
                />
                <CheckboxField
                  boxed
                  tone="warning"
                  label={t('shipment.dangerousGoods')}
                  checked={draft.canCarryDangerousGoods}
                  onChange={(event) => {
                    setDraft({ ...draft, canCarryDangerousGoods: event.target.checked });
                  }}
                />
              </div>
            </FieldGroup>

            {/* Optional, and last, because it is the exception. Most of a
                fleet has no account and needs none; this is what to pick when
                the driver is also a colleague who will use the phone app. */}
            {canAny(Permission.MEMBER_READ) && (
              <Field label={t('drivers.linkAccount')} hint={t('drivers.linkAccountHint')}>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={draft.partnerUserId}
                    onChange={(event) => {
                      setDraft({ ...draft, partnerUserId: event.target.value });
                    }}
                  >
                    <option value="">{t('drivers.noAccount')}</option>
                    {linkable.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.fullName} · {member.role}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}

            {saveDriver.isError && (
              <p role="alert" className="text-xs leading-relaxed text-danger">
                {saveDriver.error.message}
              </p>
            )}
          </div>
        </Modal>
      )}

      {vehicleDraft !== null && (
        <Modal
          isOpen
          onClose={() => {
            setVehicleDraft(null);
          }}
          title={t('drivers.addVehicle')}
          description={t('drivers.addVehicleHint')}
          footer={
            <>
              <Button
                variant="ghost"
                onClick={() => {
                  setVehicleDraft(null);
                }}
              >
                {t('modal.cancel')}
              </Button>
              <Button
                disabled={vehicleDraft.registration.trim() === '' || saveVehicle.isPending}
                onClick={() => {
                  saveVehicle.mutate(vehicleDraft);
                }}
              >
                {t('common.save')}
              </Button>
            </>
          }
        >
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('drivers.registration')} required>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    value={vehicleDraft.registration}
                    maxLength={32}
                    autoComplete="off"
                    placeholder={t('drivers.registrationPlaceholder')}
                    onChange={(event) => {
                      setVehicleDraft({ ...vehicleDraft, registration: event.target.value });
                    }}
                  />
                )}
              </Field>

              <Field label={t('drivers.vehicleType')} required>
                {({ inputId }) => (
                  <Select
                    id={inputId}
                    value={vehicleDraft.kind}
                    onChange={(event) => {
                      setVehicleDraft({ ...vehicleDraft, kind: event.target.value });
                    }}
                  >
                    {VEHICLE_KINDS.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>

            <FieldGroup legend={t('drivers.fitted')} hint={t('drivers.fittedHint')}>
              <div className="space-y-2">
                <CheckboxField
                  boxed
                  label={t('shipment.coldChain')}
                  checked={vehicleDraft.hasRefrigeration}
                  onChange={(event) => {
                    setVehicleDraft({
                      ...vehicleDraft,
                      hasRefrigeration: event.target.checked,
                    });
                  }}
                />
                <CheckboxField
                  boxed
                  label={t('drivers.tailLift')}
                  checked={vehicleDraft.hasTailLift}
                  onChange={(event) => {
                    setVehicleDraft({ ...vehicleDraft, hasTailLift: event.target.checked });
                  }}
                />
              </div>
            </FieldGroup>

            {/* Only where the van is refrigerated. A temperature range on a
                van with no fridge is a number that will be believed by
                somebody matching a cold-chain consignment against it. */}
            {vehicleDraft.hasRefrigeration && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('drivers.temperatureMin')}>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      type="number"
                      step="0.1"
                      value={vehicleDraft.temperatureMinC}
                      onChange={(event) => {
                        setVehicleDraft({
                          ...vehicleDraft,
                          temperatureMinC: event.target.value,
                        });
                      }}
                    />
                  )}
                </Field>

                <Field label={t('drivers.temperatureMax')}>
                  {({ inputId }) => (
                    <Input
                      id={inputId}
                      type="number"
                      step="0.1"
                      value={vehicleDraft.temperatureMaxC}
                      onChange={(event) => {
                        setVehicleDraft({
                          ...vehicleDraft,
                          temperatureMaxC: event.target.value,
                        });
                      }}
                    />
                  )}
                </Field>
              </div>
            )}

            <Field label={t('drivers.maxWeight')} hint={t('drivers.maxWeightHint')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  type="number"
                  min="0"
                  step="1"
                  value={vehicleDraft.maxWeightKg}
                  onChange={(event) => {
                    setVehicleDraft({ ...vehicleDraft, maxWeightKg: event.target.value });
                  }}
                />
              )}
            </Field>

            {saveVehicle.isError && (
              <p role="alert" className="text-xs leading-relaxed text-danger">
                {saveVehicle.error.message}
              </p>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
