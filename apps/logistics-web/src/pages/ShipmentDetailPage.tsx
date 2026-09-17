/**
 * One consignment, and everything a carrier may do to it.
 *
 * THE MAP TELLS THE TRUTH OR SAYS NOTHING
 *
 * There is no map library here and no tile request. What there is: the three
 * places that matter, in words, and a plain schematic of the route. Where the
 * server sent a last-known position it is shown with its age; where it did not,
 * the panel says "Live location unavailable" and stops. Nothing interpolates,
 * nothing animates, and no marker moves because software guessed - see
 * `trip.service.ts` for why that rule exists.
 *
 * The textual route is also the accessible alternative the brief asks for: the
 * schematic is `aria-hidden` and the same three places are a description list
 * above it, so a screen reader gets the whole of the information.
 *
 * EVERY ACTION IS THE SERVER'S TO ALLOW
 *
 * The Update Status form offers exactly `allowedTransitions`, which the server
 * computed from the transition matrix for THIS caller's permissions. The
 * endpoint behind the button asks the same function again - a UI restriction
 * is not a security control, and this screen is written as though the person
 * reading it can edit the JavaScript, because they can.
 */
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { useToast } from '@/components/toast-context';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatRelative } from '@/lib/format';
import {
  acceptShipment,
  assignDriver,
  documentsKey,
  driverHistoryKey,
  driversKey,
  fetchDocuments,
  fetchDriverHistory,
  fetchDrivers,
  fetchLiveLocation,
  fetchShipment,
  fetchTimeline,
  fetchVehicles,
  liveLocationKey,
  rejectShipment,
  shipmentKey,
  timelineKey,
  unassignDriver,
  updateStatus,
  vehiclesKey,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';
import { useSession } from '@/auth/session-context';
import { formatDuration, formatWeight, slaTone, statusTone } from '@/lib/shipment-display';
import type { ShipmentDetail, ShipmentStatus } from '@/lib/types';

/**
 * The forward moves that count as "sending it on the way", in road order.
 *
 * The first of these the state machine currently allows is what the button on
 * the driver card offers. Listed rather than derived so the order is a
 * decision somebody made and can read - a consignment that has been collected
 * but not yet loaded is PICKED_UP, and offering OUT_FOR_DELIVERY there would
 * be telling a customer the van is at their door when it is in a depot.
 */
const DISPATCH_ORDER: readonly ShipmentStatus[] = [
  'PICKUP_SCHEDULED',
  'PICKED_UP',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
];

export function ShipmentDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams<{ id: string }>();

  const shipment = useQuery({
    queryKey: shipmentKey(id),
    queryFn: () => fetchShipment(id),
    enabled: id.length > 0,
  });

  if (shipment.isLoading) return <LoadingState />;

  if (shipment.isError || shipment.data === undefined) {
    return (
      <ErrorState
        error={shipment.error}
        onRetry={() => {
          void shipment.refetch();
        }}
      />
    );
  }

  const data = shipment.data;

  return (
    <>
      <PageHeader
        back={{ to: '/shipments', label: t('shipments.heading') }}
        title={data.shipmentReference}
        description={`${data.sellerCompanyName} → ${data.receivingCompanyName}`}
        meta={
          <>
            <Badge tone={statusTone(data.status)} dot>
              {t(`status.${data.status}` as never)}
            </Badge>
            <Badge tone={slaTone(data.sla.state)} dot>
              {t(`sla.${data.sla.state}` as never)}
            </Badge>
            {data.handling.requiresColdChain ? (
              <Badge tone="brand">{t('shipment.coldChain')}</Badge>
            ) : null}
            {data.handling.isDangerousGoods ? (
              <Badge tone="danger">{t('shipment.dangerousGoods')}</Badge>
            ) : null}
          </>
        }
      />

      {data.isReadOnly ? (
        <Callout tone="warning" className="mb-4">
          {t('shipment.readOnly')}
        </Callout>
      ) : null}

      <AssignmentPrompt shipment={data} />

      <div className="grid gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <RouteCard shipment={data} />
          <TimelineCard shipmentId={id} />
          <PackagesCard shipment={data} />
        </div>

        <div className="space-y-4">
          <StatusCard shipment={data} />
          <DriverCard shipment={data} />
          <FactsCard shipment={data} />
          <ContactsCard shipment={data} />
          <DocumentsCard shipmentId={id} />
        </div>
      </div>
    </>
  );
}

/**
 * Accept or decline, when the offer is still open.
 *
 * Rendered above everything because it is the only thing on the page that has
 * a deadline: `respondBy` is when the offer lapses back to the pool.
 */
function AssignmentPrompt({ shipment }: { shipment: ShipmentDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canAny } = useSession();

  const [reason, setReason] = useState('');
  const [declining, setDeclining] = useState(false);

  const accept = useMutation({
    mutationFn: () => acceptShipment(shipment.id),
    onSuccess: () => {
      toast.success(t('shipment.accepted'));
      void queryClient.invalidateQueries({ queryKey: shipmentKey(shipment.id) });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const reject = useMutation({
    mutationFn: () => rejectShipment(shipment.id, reason),
    onSuccess: () => {
      toast.success(t('shipment.rejected'));
      void queryClient.invalidateQueries({ queryKey: shipmentKey(shipment.id) });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (shipment.assignment.state !== 'OFFERED') return null;
  if (!canAny(Permission.SHIPMENT_ACCEPT)) return null;

  return (
    <Card className="mb-4" tone="default" bodyClassName="px-5 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium text-ink">{t('dashboard.acceptancePending')}</p>
          {shipment.assignment.respondBy === null ? null : (
            <p className="mt-0.5 text-xs text-ink-muted">
              {formatDateTime(shipment.assignment.respondBy)}
            </p>
          )}
        </div>

        <div className="flex gap-2">
          <Button
            onClick={() => {
              accept.mutate();
            }}
            disabled={accept.isPending}
          >
            {t('shipment.accept')}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setDeclining((value) => !value);
            }}
          >
            {t('shipment.reject')}
          </Button>
        </div>
      </div>

      {declining ? (
        <div className="mt-4 border-t border-border pt-4">
          <Field label={t('shipment.rejectReason')} hint={t('shipment.rejectHint')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={2}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
          <Button
            className="mt-3"
            variant="danger"
            disabled={reason.trim().length < 4 || reject.isPending}
            onClick={() => {
              reject.mutate();
            }}
          >
            {t('shipment.reject')}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The route: three places, in words, and a schematic beside them.
 *
 * The schematic is decoration and is marked as such. The description list
 * above it carries the same three places, so a screen reader and a sighted
 * reader get identical information - which is the accessible alternative the
 * brief asks for, done by having the words be the primary thing rather than an
 * afterthought bolted to a picture.
 */
function RouteCard({ shipment }: { shipment: ShipmentDetail }): React.JSX.Element {
  const { t } = useI18n();
  const { canAny } = useSession();

  const live = useQuery({
    queryKey: liveLocationKey(shipment.id),
    queryFn: () => fetchLiveLocation(shipment.id),
    enabled: canAny(Permission.TRIP_LOCATION_READ),
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    // A carrier without the permission gets a refusal, not an empty map. Not
    // retried, because it will not start being allowed.
    retry: false,
  });

  const pickup = shipment.pickupAddress;
  const delivery = shipment.deliveryAddress;

  const position = live.data?.location ?? null;
  const stale =
    position !== null &&
    live.data !== undefined &&
    position.ageSeconds > live.data.staleAfterSeconds;

  return (
    <Card title={t('shipment.route')} bodyClassName="px-5 py-4">
      <DescriptionList
        columns={2}
        items={[
          {
            label: t('shipment.origin'),
            value: (
              <>
                {shipment.originWarehouse?.name ?? shipment.sellerCompanyName}
                <span className="block text-xs text-ink-muted">
                  {[pickup.line1, pickup.city, pickup.postalCode, shipment.originCountry]
                    .filter((part) => part !== undefined && part !== '')
                    .join(', ')}
                </span>
              </>
            ),
          },
          {
            label: t('shipment.destination'),
            value: (
              <>
                {shipment.receivingCompanyName}
                <span className="block text-xs text-ink-muted">
                  {[
                    delivery.line1,
                    shipment.destinationCity,
                    shipment.destinationPostalCode,
                    shipment.destinationCountry,
                  ]
                    .filter((part) => part !== undefined && part !== null && part !== '')
                    .join(', ')}
                </span>
              </>
            ),
          },
        ]}
      />

      {/* The schematic. Decoration: the words above carry the information. */}
      <div aria-hidden="true" className="mt-5 flex items-center gap-2">
        <Dot tone="brand" />
        <Rail />
        <Dot tone={position === null ? 'muted' : 'operational'} />
        <Rail />
        <Dot tone={shipment.status === 'DELIVERED' ? 'success' : 'muted'} />
      </div>

      <p className="sr-only">{t('shipment.mapTextAlternative')}</p>

      <div className="mt-4 rounded-lg bg-surface-sunken px-4 py-3 text-sm">
        {!canAny(Permission.TRIP_LOCATION_READ) || position === null ? (
          shipment.lastKnownPosition === null ? (
            /*
             * Nothing has been reported. Said plainly and never dressed up:
             * a marker that moves because the software guessed is worse than
             * no marker at all.
             */
            <p className="text-ink-muted">{t('shipment.liveLocationUnavailable')}</p>
          ) : (
            <p className="text-ink-muted">
              {t('shipment.lastKnownCheckpoint')} ·{' '}
              <span className="tabular">
                {shipment.lastKnownPosition.latitude}, {shipment.lastKnownPosition.longitude}
              </span>{' '}
              · {formatRelative(shipment.lastKnownPosition.at)}
            </p>
          )
        ) : (
          <>
            <p className="text-ink">
              {position.driverName} ·{' '}
              <span className="tabular">
                {position.latitude}, {position.longitude}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-ink-muted">
              {formatRelative(position.at)}
              {position.accuracyM === null ? '' : ` · ±${String(position.accuracyM)} m`}
            </p>
            {stale ? (
              <p className="mt-2 rounded bg-warning-soft px-2 py-1 text-xs text-warning">
                {t('shipment.staleTracking', {
                  minutes: Math.round(position.ageSeconds / 60),
                })}
              </p>
            ) : null}
          </>
        )}
      </div>

      {shipment.distanceKm === null ? null : (
        <p className="mt-3 text-xs text-ink-subtle">
          {t('shipment.distance')}: <span className="tabular">{shipment.distanceKm} km</span>
        </p>
      )}
    </Card>
  );
}

function Dot({ tone }: { tone: 'brand' | 'operational' | 'success' | 'muted' }): React.JSX.Element {
  const className =
    tone === 'brand'
      ? 'bg-brand'
      : tone === 'operational'
        ? 'bg-operational'
        : tone === 'success'
          ? 'bg-success'
          : 'bg-border-strong';

  return <span className={`h-3 w-3 shrink-0 rounded-full ${className}`} />;
}

function Rail(): React.JSX.Element {
  return <span className="h-0.5 flex-1 rounded-full bg-border-strong" />;
}

/** The timeline, oldest first, with the source of every entry. */
function TimelineCard({ shipmentId }: { shipmentId: string }): React.JSX.Element {
  const { t } = useI18n();

  const timeline = useQuery({
    queryKey: timelineKey(shipmentId),
    queryFn: () => fetchTimeline(shipmentId),
  });

  return (
    <Card title={t('shipment.timeline')} bodyClassName="px-5 py-4">
      {timeline.isLoading ? (
        <LoadingState />
      ) : timeline.isError ? (
        <ErrorState
          error={timeline.error}
          onRetry={() => {
            void timeline.refetch();
          }}
        />
      ) : (
        <ol className="relative space-y-4 border-l border-border pl-5">
          {timeline.data?.events.map((entry) => (
            <li key={entry.id} className="relative">
              <span
                aria-hidden="true"
                className="absolute -left-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full border-2 border-surface bg-border-strong"
              />

              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(entry.status)} dot>
                  {t(`status.${entry.status}` as never)}
                </Badge>
                {entry.isCorrection ? (
                  <Badge tone="warning">{t('source.UBOSS_ADMIN')}</Badge>
                ) : null}
                <span className="text-xxs text-ink-subtle">
                  {t(`source.${entry.source}` as never)}
                </span>
              </div>

              <p className="mt-1 text-sm text-ink">
                {entry.publicDescription ?? entry.reason ?? '—'}
              </p>

              {entry.internalNote === null ? null : (
                <p className="mt-1 rounded bg-surface-sunken px-2 py-1 text-xs text-ink-muted">
                  {entry.internalNote}
                </p>
              )}

              <p className="mt-1 text-xxs text-ink-subtle">
                <time dateTime={entry.occurredAt}>{formatDateTime(entry.occurredAt)}</time>
                {entry.locationLabel === null ? '' : ` · ${entry.locationLabel}`}
                {/*
                    The carrier's own code, kept even after it was mapped. An
                    operator arguing with a carrier about a scan needs their
                    reference, not our translation of it.
                  */}
                {entry.externalStatusCode === null ? '' : ` · ${entry.externalStatusCode}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * Who is carrying this, who has carried it, and the way to change that.
 *
 * ONE CONTROL FOR ASSIGN AND REASSIGN
 *
 * From a dispatcher's point of view it is one action - "this parcel is Anja's
 * now" - and the difference between the two is a fact about what was already
 * there. So the picker is the same either way, and the reason box appears only
 * when somebody is being taken off, because that is the only case where there
 * is anything to explain.
 *
 * THE CHAIN IS THE POINT
 *
 * Every handover, oldest first, with who made it and why. It reads forwards
 * because it is a chain rather than a feed: "Anja, then Bram because Anja was
 * sick" is a sentence, and reversed it is a puzzle. This is what somebody
 * opens after a delivery has gone wrong.
 */
function DriverCard({
  shipment,
}: {
  shipment: ShipmentDetail;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { canAny } = useSession();

  const shipmentId = shipment.id;
  const isReadOnly = shipment.isReadOnly;

  const [chosen, setChosen] = useState('');
  const [chosenVehicle, setChosenVehicle] = useState('');
  const [reason, setReason] = useState('');

  /*
   * One key per dispatch, reused on a retry.
   *
   * A dispatcher on a bad line who presses "on the way" twice sends the van
   * out once. The key is replaced after a success, so a consignment that
   * genuinely moves twice - picked up, then in transit - writes two events.
   */
  const [dispatchKey, setDispatchKey] = useState(() => crypto.randomUUID());

  const canRead = canAny(Permission.DRIVER_READ);
  const canAssign = canAny(Permission.DRIVER_ASSIGN) && !isReadOnly;

  const history = useQuery({
    queryKey: driverHistoryKey(shipmentId),
    queryFn: () => fetchDriverHistory(shipmentId),
    enabled: canAny(Permission.SHIPMENT_READ),
    retry: false,
  });

  const drivers = useQuery({
    queryKey: driversKey,
    queryFn: fetchDrivers,
    // Only fetched by somebody who could act on it. A read-only viewer has no
    // use for the fleet register and no business being handed one.
    enabled: canAssign && canRead,
    retry: false,
  });

  /*
   * The vans, for the same form.
   *
   * Which vehicle went out matters after the fact and during: a cold-chain
   * consignment in a van with no fridge is the failure this list exists to
   * prevent somebody from arranging by accident.
   */
  const vehicles = useQuery({
    queryKey: vehiclesKey,
    queryFn: fetchVehicles,
    enabled: canAssign && canAny(Permission.VEHICLE_READ),
    retry: false,
  });

  const entries = history.data?.assignments ?? [];
  const live = entries.find((entry) => entry.isActive) ?? null;
  const isReassignment = live !== null;

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: driverHistoryKey(shipmentId) });
    // The fleet's open-task counts moved too.
    await queryClient.invalidateQueries({ queryKey: driversKey });
  };

  const assign = useMutation({
    mutationFn: () =>
      assignDriver(shipmentId, {
        driverProfileId: chosen,
        ...(chosenVehicle === '' ? {} : { vehicleId: chosenVehicle }),
        ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
      }),
    onSuccess: async () => {
      toast.success(t('drivers.assigned'));
      setChosen('');
      setChosenVehicle('');
      setReason('');
      await refresh();
    },
    // The server's own message, not a generic apology: it names the
    // certification the driver is missing, or says the consignment is
    // finished, and either is what the dispatcher has to act on.
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  const unassign = useMutation({
    mutationFn: () => unassignDriver(shipmentId, reason.trim()),
    onSuccess: async () => {
      toast.success(t('drivers.takenOff'));
      setReason('');
      await refresh();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  /**
   * Send them on the way.
   *
   * The one move a dispatcher makes over and over, on the card where they
   * have just put somebody on the van - rather than four fields down a
   * status form on the other side of the screen. It writes the SAME event
   * that form writes, through the same endpoint and the same state machine:
   * a shortcut to a transition, never a second way to change a status.
   */
  const dispatch = useMutation({
    mutationFn: (to: ShipmentStatus) =>
      updateStatus(shipmentId, { status: to }, dispatchKey),
    onSuccess: async () => {
      toast.success(t('drivers.onTheWay'));
      setDispatchKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: shipmentKey(shipmentId) });
      await queryClient.invalidateQueries({ queryKey: timelineKey(shipmentId) });
      await refresh();
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (!canAny(Permission.SHIPMENT_READ)) return null;

  const active = (drivers.data?.drivers ?? []).filter((row) => row.state === 'ACTIVE');
  const usable = (vehicles.data?.vehicles ?? []).filter((row) => row.isActive);
  const isBusy = assign.isPending || unassign.isPending || dispatch.isPending;

  /*
   * The next step on the road, if there is one.
   *
   * Read from `allowedTransitions`, which the SERVER filled from the
   * transition matrix for this reader. Never assembled here: a button that
   * offers a move the state machine is about to refuse teaches people to
   * stop trusting the screen.
   */
  const onTheWay = DISPATCH_ORDER.find((step) =>
    shipment.allowedTransitions.some(
      (entry) => entry.to === step && !entry.requiresReason && !entry.requiresProofOfDelivery,
    ),
  );

  return (
    <Card title={t('drivers.assignmentHistory')} bodyClassName="px-5 py-4">
      {live === null ? (
        <p className="text-sm text-ink-muted">{t('drivers.noDriverYet')}</p>
      ) : (
        <div className="rounded-md border border-border bg-surface-sunken px-3 py-2">
          <p className="text-sm font-semibold text-ink">{live.driverName}</p>
          <p className="text-xxs text-ink-subtle">
            {t('drivers.stillOn')}
            {live.vehicleRegistration === null ? '' : ` · ${live.vehicleRegistration}`}
          </p>

          {/* Only where the state machine allows it, and only for somebody
              who may write a status. A driver on a consignment that has
              already gone out has nothing left to dispatch. */}
          {canAssign &&
            canAny(Permission.SHIPMENT_STATUS_WRITE) &&
            onTheWay !== undefined && (
              <Button
                size="sm"
                className="mt-2"
                disabled={isBusy}
                onClick={() => {
                  dispatch.mutate(onTheWay);
                }}
              >
                {t('drivers.sendOnTheWay', { status: t(`status.${onTheWay}` as never) })}
              </Button>
            )}
        </div>
      )}

      {canAssign && (
        <div className="mt-3 space-y-2">
          <Field label={isReassignment ? t('drivers.moveTo') : t('drivers.assignTo')}>
            {({ inputId }) => (
              <Select
                id={inputId}
                value={chosen}
                disabled={isBusy}
                onChange={(event) => {
                  setChosen(event.target.value);
                }}
              >
                <option value="">{t('drivers.chooseDriver')}</option>
                {active.map((row) => (
                  <option key={row.id} value={row.id}>
                    {/* The open-task count is beside the name, because
                        "which of my drivers is free" is the question being
                        asked and the register is the only place it is
                        answered. */}
                    {row.fullName} · {t('drivers.openTasks')}: {row.openTasks}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {/* Which van. Optional, because a bike courier has no
              registration to record and a carrier that does not track
              vehicles should not be made to invent one. */}
          {usable.length > 0 && (
            <Field label={t('drivers.vehicle')} hint={t('drivers.vehicleHint')}>
              {({ inputId }) => (
                <Select
                  id={inputId}
                  value={chosenVehicle}
                  disabled={isBusy}
                  onChange={(event) => {
                    setChosenVehicle(event.target.value);
                  }}
                >
                  <option value="">{t('drivers.noVehicle')}</option>
                  {usable.map((row) => (
                    <option key={row.id} value={row.id}>
                      {row.registration} · {row.kind}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {/* Only when somebody is coming off. A reason box on a first
              assignment is a question with no answer. */}
          {isReassignment && (
            <Field label={t('drivers.whyComingOff')}>
              {({ inputId }) => (
                <Textarea
                  id={inputId}
                  rows={2}
                  maxLength={512}
                  value={reason}
                  disabled={isBusy}
                  onChange={(event) => {
                    setReason(event.target.value);
                  }}
                />
              )}
            </Field>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={
                chosen === '' || isBusy || (isReassignment && reason.trim().length < 4)
              }
              onClick={() => {
                assign.mutate();
              }}
            >
              {isReassignment ? t('drivers.moveDriver') : t('drivers.assignDriver')}
            </Button>

            {isReassignment && (
              <Button
                size="sm"
                variant="ghost"
                disabled={isBusy || reason.trim().length < 4}
                onClick={() => {
                  unassign.mutate();
                }}
              >
                {t('drivers.takeOff')}
              </Button>
            )}
          </div>

          {active.length === 0 && drivers.isSuccess && (
            <p className="text-xxs leading-relaxed text-ink-muted">
              {t('drivers.noActiveDrivers')}
            </p>
          )}
        </div>
      )}

      {entries.length > 1 && (
        <ol className="mt-4 space-y-2 border-t border-border pt-3">
          {entries.map((entry) => (
            <li key={entry.id} className="text-xs leading-relaxed">
              <p className={entry.isActive ? 'font-semibold text-ink' : 'text-ink-muted'}>
                {entry.driverName}
              </p>
              <p className="text-xxs text-ink-subtle">
                {formatDateTime(entry.assignedAt)}
                {entry.assignedByName === null
                  ? ''
                  : ` · ${t('drivers.assignedBy', { name: entry.assignedByName })}`}
              </p>
              {entry.unassignedReason !== null && (
                <p className="text-xxs text-ink-muted">
                  {t('drivers.cameOff', { reason: entry.unassignedReason })}
                </p>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/** The Update Status form: exactly the moves the server said are legal. */
function StatusCard({ shipment }: { shipment: ShipmentDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [status, setStatus] = useState<ShipmentStatus | ''>('');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');

  /*
   * One key per submission, generated when the form is opened and reused on a
   * retry. A dispatcher who presses the button twice writes one event; two
   * genuinely separate scans open the form twice and get two keys.
   */
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());

  const chosen = shipment.allowedTransitions.find((entry) => entry.to === status);

  const submit = useMutation({
    mutationFn: () =>
      updateStatus(
        shipment.id,
        {
          status: status as ShipmentStatus,
          ...(reason.trim().length > 0 ? { reason: reason.trim() } : {}),
          ...(note.trim().length > 0 ? { internalNote: note.trim() } : {}),
        },
        idempotencyKey,
      ),
    onSuccess: () => {
      toast.success(t('common.saved'));
      setStatus('');
      setReason('');
      setNote('');
      setIdempotencyKey(crypto.randomUUID());

      void queryClient.invalidateQueries({ queryKey: shipmentKey(shipment.id) });
      void queryClient.invalidateQueries({ queryKey: timelineKey(shipment.id) });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  if (shipment.isReadOnly || shipment.allowedTransitions.length === 0) return null;

  return (
    <Card title={t('shipment.updateStatus')} bodyClassName="px-5 py-4">
      <Field label={t('shipment.newStatus')}>
        {({ inputId, describedBy }) => (
          <Select
            id={inputId}
            aria-describedby={describedBy}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as ShipmentStatus | '');
            }}
          >
            <option value="">{t('common.none')}</option>
            {shipment.allowedTransitions.map((entry) => (
              <option key={entry.to} value={entry.to}>
                {t(`status.${entry.to}` as never)}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {chosen?.requiresProofOfDelivery === true ? (
        <Callout tone="warning" className="mt-3">
          {t('pod.required')}
        </Callout>
      ) : null}

      {chosen?.requiresReason === true ? (
        <div className="mt-3">
          <Field label={t('shipment.reason')}>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={2}
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
      ) : null}

      <div className="mt-3">
        <Field label={t('shipment.internalNote')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
              }}
            />
          )}
        </Field>
      </div>

      <Button
        className="mt-4 w-full"
        disabled={
          status === '' ||
          submit.isPending ||
          (chosen?.requiresReason === true && reason.trim().length === 0) ||
          chosen?.requiresProofOfDelivery === true
        }
        onClick={() => {
          submit.mutate();
        }}
      >
        {t('shipment.updateStatus')}
      </Button>
    </Card>
  );
}

function FactsCard({ shipment }: { shipment: ShipmentDetail }): React.JSX.Element {
  const { t } = useI18n();

  const handling: string[] = [];
  if (shipment.handling.requiresColdChain) handling.push(t('shipment.coldChain'));
  if (shipment.handling.requiresSterileHandling) handling.push(t('shipment.sterile'));
  if (shipment.handling.isFragile) handling.push(t('shipment.fragile'));
  if (shipment.handling.isDangerousGoods) handling.push(t('shipment.dangerousGoods'));

  return (
    <Card title={t('shipment.handling')} bodyClassName="px-5 py-4">
      <DescriptionList
        columns={1}
        items={[
          { label: t('shipments.column.reference'), value: shipment.shipmentReference },
          { label: t('shipments.column.order'), value: shipment.orderReference ?? '—' },
          { label: 'Tracking', value: shipment.trackingNumber },
          { label: t('shipments.column.packages'), value: shipment.packageCount },
          { label: 'Weight', value: formatWeight(shipment.totalWeightGrams) },
          {
            label: t('shipments.column.pickup'),
            value: formatDateTime(shipment.expectedPickupAt),
          },
          {
            label: t('shipments.column.delivery'),
            value: formatDateTime(shipment.estimatedDeliveryAt),
          },
          {
            label: t('shipment.handling'),
            value: handling.length === 0 ? t('common.none') : handling.join(' · '),
          },
          ...(shipment.handling.requiresTemperatureRange &&
          shipment.handling.temperatureMinC !== null &&
          shipment.handling.temperatureMaxC !== null
            ? [
                {
                  label: t('shipment.coldChain'),
                  value: t('shipment.temperatureRange', {
                    min: shipment.handling.temperatureMinC,
                    max: shipment.handling.temperatureMaxC,
                  }),
                },
              ]
            : []),
          ...(shipment.productCategorySummary === null
            ? []
            : [{ label: 'Contents', value: shipment.productCategorySummary }]),
          ...(shipment.sla.minutesRemaining === null
            ? []
            : [
                {
                  label: t('shipments.column.sla'),
                  value: t('sla.dueIn', {
                    time: formatDuration(shipment.sla.minutesRemaining),
                  }),
                },
              ]),
        ]}
      />
    </Card>
  );
}

/**
 * Contacts, as the server decided to show them.
 *
 * `display` is already masked where it should be — the masking happens on the
 * server, before the value reaches this process, so there is no full number in
 * the network tab to un-mask. Where it is masked, the portal offers a secure
 * contact action instead of a `tel:` link.
 */
function ContactsCard({ shipment }: { shipment: ShipmentDetail }): React.JSX.Element {
  const { t } = useI18n();

  const rows: { label: string; value: React.ReactNode }[] = [];

  function add(
    label: string,
    name: string | null,
    contact: ShipmentDetail['contacts']['pickup']['phone'],
  ): void {
    rows.push({
      label,
      value: (
        <>
          {name ?? '—'}
          {contact.display === null ? null : (
            <span className="mt-0.5 block text-xs">
              {contact.isMasked ? (
                <>
                  <span className="tabular text-ink-muted">{contact.display}</span>
                  <span className="ml-2 text-ink-subtle">{t('shipment.maskedContact')}</span>
                </>
              ) : (
                <a href={`tel:${contact.display}`} className="tabular text-brand hover:underline">
                  {contact.display}
                </a>
              )}
            </span>
          )}
        </>
      ),
    });
  }

  add(t('shipment.origin'), shipment.contacts.pickup.name, shipment.contacts.pickup.phone);
  add(t('shipment.destination'), shipment.contacts.delivery.name, shipment.contacts.delivery.phone);

  if (shipment.assignedDriver !== null) {
    add(t('shipments.column.driver'), shipment.assignedDriver.name, shipment.assignedDriver.phone);
  }

  return (
    <Card title={t('shipment.contacts')} bodyClassName="px-5 py-4">
      <DescriptionList columns={1} items={rows} />
    </Card>
  );
}

function PackagesCard({ shipment }: { shipment: ShipmentDetail }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('shipment.packages')}>
      <ul className="divide-y divide-border text-sm">
        {shipment.packages.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center justify-between gap-2 px-5 py-3"
          >
            <span className="font-mono text-xs text-ink">{entry.packageReference}</span>

            <span className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span className="tabular">{formatWeight(entry.weightGrams)}</span>
              {entry.packagingType === null ? null : <span>{entry.packagingType}</span>}
              {entry.batchReference === null ? null : (
                <span className="font-mono">{entry.batchReference}</span>
              )}
              {entry.scannedOutAt === null ? null : (
                <Badge tone="brand">{t('status.PICKED_UP')}</Badge>
              )}
              {entry.scannedInAt === null ? null : (
                <Badge tone="success">{t('status.DELIVERED')}</Badge>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function DocumentsCard({ shipmentId }: { shipmentId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const { canAny } = useSession();

  const documents = useQuery({
    queryKey: documentsKey(shipmentId),
    queryFn: () => fetchDocuments(shipmentId),
    enabled: canAny(Permission.DOCUMENT_READ),
    retry: false,
  });

  if (!canAny(Permission.DOCUMENT_READ)) return null;

  return (
    <Card title={t('shipment.documents')} bodyClassName="px-5 py-4">
      {(documents.data?.documents.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-subtle">{t('common.nothingHereYet')}</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {documents.data?.documents.map((entry) => (
            <li key={entry.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate text-ink">{entry.fileName}</span>
              {entry.isDownloadable ? (
                <span className="shrink-0 text-xxs text-ink-subtle">{entry.kind}</span>
              ) : (
                /*
                 * A file nothing has scanned. The deployment refuses to serve
                 * it, and saying so is better than a download that 409s.
                 */
                <Badge tone="warning">{entry.scanState}</Badge>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
