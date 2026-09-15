/**
 * One consignment, from the marketplace's side.
 *
 * Three things can be done here that cannot be done anywhere else, and each is
 * deliberately a little awkward:
 *
 *   - **Offering it to a carrier.** The list of carriers is scored on the
 *     server - coverage, approved capabilities, spare capacity, on-time record
 *     - and each one carries the reasons it is or is not offerable, shown
 *     verbatim. An ineligible carrier can still be chosen, because an
 *     operations desk sometimes knows something the score does not, but it
 *     takes a second click and the reason is on screen while they make it.
 *   - **Taking it back.** A written reason of at least four characters, which
 *     the carrier sees.
 *   - **Correcting a status.** The only way out of DELIVERED, RETURNED, LOST
 *     or CANCELLED in the wrong direction. It demands eight characters of
 *     explanation and is written into the timeline flagged as a correction, so
 *     a parcel that appears to have gone backwards reads as corrected months
 *     later instead of as a bug.
 *
 * The timeline shows the carrier's own status code beside the status it was
 * mapped to, whenever an event came from a carrier feed. That pairing is what
 * makes a mis-mapped code findable; dropping the original would leave nothing
 * to compare against.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  DescriptionList,
  EmptyState,
  ErrorState,
  Field,
  LoadingState,
  PageHeader,
  Select,
  SummaryTiles,
  Textarea,
} from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime, formatNumber, humanise } from '@/lib/format';
import {
  assignShipment,
  correctShipmentStatus,
  fetchAdminShipment,
  fetchEligiblePartners,
  severityKey,
  severityTone,
  shipmentStatusTone,
  slaKey,
  slaTone,
  sourceKey,
  statusLabelKey,
  withdrawShipment,
  type AdminShipmentDetail,
  type ShipmentStatus,
  type ShipmentTimelineEvent,
} from '@/lib/logistics';
import { Permission } from '@/lib/permissions';

export function LogisticsShipmentDetailPage(): React.JSX.Element {
  const { t } = useI18n();
  const { id = '' } = useParams<{ id: string }>();

  const query = useQuery({
    queryKey: ['admin', 'logistics', 'shipment', id],
    queryFn: () => fetchAdminShipment(id),
    enabled: id.length > 0,
  });

  if (query.isPending) return <LoadingState label={t('logistics.shipment.loading')} />;

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

  const shipment = query.data;

  return (
    <div className="space-y-5">
      <PageHeader
        title={shipment.shipmentReference}
        description={t('logistics.shipment.subtitle', {
          seller: shipment.sellerCompanyName,
          receiver: shipment.receivingCompanyName,
        })}
        back={{ to: '/logistics/shipments', label: t('logistics.shipments.heading') }}
        meta={
          <>
            <Badge tone={shipmentStatusTone(shipment.status)} dot>
              {t(statusLabelKey(shipment.status))}
            </Badge>
            <Badge tone={slaTone(shipment.slaState)} dot>
              {t(slaKey(shipment.slaState))}
            </Badge>
            <Badge tone="neutral">{shipment.trackingNumber}</Badge>
            {shipment.order !== null && (
              <Link
                to={`/orders/${shipment.order.id}`}
                className="rounded text-xs font-medium text-accent hover:underline"
              >
                {shipment.order.orderNumber}
              </Link>
            )}
          </>
        }
        actions={<Actions shipment={shipment} />}
      />

      <HandlingWarnings shipment={shipment} />

      <SummaryTiles
        items={[
          {
            label: t('logistics.shipment.tile.carrier'),
            value:
              shipment.assignedPartner === null
                ? t('logistics.shipments.unassigned')
                : shipment.assignedPartner.displayName,
            tone: shipment.assignedPartner === null ? 'warning' : 'default',
          },
          {
            label: t('logistics.shipment.tile.packages'),
            value: formatNumber(shipment.packageCount),
          },
          {
            label: t('logistics.shipment.tile.attempts'),
            value: formatNumber(shipment.deliveryAttemptCount),
            tone: shipment.deliveryAttemptCount > 1 ? 'warning' : 'default',
          },
          {
            label: t('logistics.shipment.tile.openExceptions'),
            value: formatNumber(
              shipment.exceptions.filter((entry) => entry.resolvedAt === null).length,
            ),
            tone: shipment.exceptions.some((entry) => entry.resolvedAt === null)
              ? 'danger'
              : 'default',
          },
        ]}
      />

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title={t('logistics.shipment.route')} bodyClassName="px-5 py-4">
          <DescriptionList
            items={[
              {
                label: t('logistics.shipment.field.from'),
                value: `${shipment.sellerCompanyName} · ${shipment.originCountry}`,
              },
              {
                label: t('logistics.shipment.field.to'),
                value: [
                  shipment.receivingCompanyName,
                  shipment.destinationCity,
                  shipment.destinationPostalCode,
                  shipment.destinationCountry,
                ]
                  .filter((part) => part !== null && part.length > 0)
                  .join(', '),
              },
              {
                label: t('logistics.shipment.field.pickupContact'),
                value: contactLine(
                  shipment.pickupContactName,
                  shipment.pickupContactPhone,
                  shipment.pickupContactEmail,
                ),
              },
              {
                label: t('logistics.shipment.field.deliveryContact'),
                value: contactLine(
                  shipment.deliveryContactName,
                  shipment.deliveryContactPhone,
                  shipment.deliveryContactEmail,
                ),
              },
              {
                label: t('logistics.shipment.field.service'),
                value: humanise(shipment.serviceType),
              },
              {
                label: t('logistics.shipment.field.contents'),
                value: shipment.productCategorySummary ?? '—',
              },
            ]}
          />
        </Card>

        <Card title={t('logistics.shipment.promise')} bodyClassName="px-5 py-4">
          <DescriptionList
            items={[
              {
                label: t('logistics.shipment.field.expectedPickup'),
                value: formatDateTime(shipment.expectedPickupAt),
              },
              {
                label: t('logistics.shipment.field.pickupDue'),
                value: formatDateTime(shipment.pickupDueAt),
              },
              {
                label: t('logistics.shipment.field.estimatedDelivery'),
                value: formatDateTime(shipment.estimatedDeliveryAt),
              },
              {
                label: t('logistics.shipment.field.deliveryDue'),
                value: formatDateTime(shipment.deliveryDueAt),
              },
              {
                label: t('logistics.shipment.field.pickedUp'),
                value: formatDateTime(shipment.pickedUpAt),
              },
              {
                label: t('logistics.shipment.field.delivered'),
                value: formatDateTime(shipment.deliveredAt),
              },
            ]}
          />
        </Card>
      </div>

      <CarrierConnection shipment={shipment} />
      <Exceptions shipment={shipment} />
      <Assignments shipment={shipment} />
      <Timeline events={shipment.events} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Handling
// ---------------------------------------------------------------------------

/**
 * The requirements that decide who may carry this at all.
 *
 * At the top, in words, and never as an icon strip: cold chain and dangerous
 * goods are the two facts on this page that somebody must not be able to miss
 * while scanning it.
 */
function HandlingWarnings({
  shipment,
}: {
  shipment: AdminShipmentDetail;
}): React.JSX.Element | null {
  const { t } = useI18n();

  const needs: string[] = [];

  if (shipment.requiresColdChain) needs.push(t('logistics.shipment.needs.coldChain'));
  if (shipment.requiresTemperatureRange) {
    needs.push(
      t('logistics.shipment.needs.temperature', {
        min: shipment.temperatureMinC ?? '—',
        max: shipment.temperatureMaxC ?? '—',
      }),
    );
  }
  if (shipment.requiresSterileHandling) needs.push(t('logistics.shipment.needs.sterile'));
  if (shipment.isDangerousGoods) {
    needs.push(
      t('logistics.shipment.needs.dangerous', {
        class: shipment.dangerousGoodsClass ?? '—',
      }),
    );
  }
  if (shipment.isFragile) needs.push(t('logistics.shipment.needs.fragile'));

  if (needs.length === 0 && shipment.handlingNotes === null) return null;

  return (
    <Callout tone="warning" title={t('logistics.shipment.handling')} role="status">
      {needs.length > 0 && (
        <ul className="list-inside list-disc space-y-0.5">
          {needs.map((need) => (
            <li key={need}>{need}</li>
          ))}
        </ul>
      )}
      {shipment.handlingNotes !== null && (
        <p className={needs.length > 0 ? 'mt-2' : undefined}>{shipment.handlingNotes}</p>
      )}
    </Callout>
  );
}

// ---------------------------------------------------------------------------
// Carrier connection
// ---------------------------------------------------------------------------

function CarrierConnection({
  shipment,
}: {
  shipment: AdminShipmentDetail;
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (shipment.carrierIntegration === null && shipment.carrierTrackingNumber === null) return null;

  /*
   * A feed that has not been read for a day is a stale feed, and saying so is
   * the honest version of a tracking page that simply stops updating. The
   * threshold is generous on purpose: a carrier that polls nightly is normal.
   */
  const isStale =
    shipment.lastCarrierSyncAt !== null &&
    Date.now() - new Date(shipment.lastCarrierSyncAt).getTime() > 24 * 60 * 60 * 1000;

  return (
    <Card title={t('logistics.shipment.carrierFeed')} bodyClassName="px-5 py-4">
      {isStale && (
        <Callout tone="warning" role="status" className="mb-3">
          {t('logistics.shipment.staleFeed', {
            when: formatDateTime(shipment.lastCarrierSyncAt),
          })}
        </Callout>
      )}

      <DescriptionList
        items={[
          {
            label: t('logistics.shipment.field.connection'),
            value:
              shipment.carrierIntegration === null
                ? t('logistics.shipment.noConnection')
                : `${shipment.carrierIntegration.name} · ${shipment.carrierIntegration.provider} · ${humanise(shipment.carrierIntegration.state)}`,
          },
          {
            label: t('logistics.shipment.field.carrierTracking'),
            value:
              shipment.carrierTrackingNumber === null ? (
                '—'
              ) : shipment.carrierTrackingUrl === null ? (
                shipment.carrierTrackingNumber
              ) : (
                <a
                  href={shipment.carrierTrackingUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded text-accent hover:underline"
                >
                  {shipment.carrierTrackingNumber}
                </a>
              ),
          },
          {
            label: t('logistics.shipment.field.lastSync'),
            value: formatDateTime(shipment.lastCarrierSyncAt),
          },
          {
            label: t('logistics.shipment.field.lastEvent'),
            value: formatDateTime(shipment.lastEventAt),
          },
        ]}
      />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Exceptions and assignments
// ---------------------------------------------------------------------------

function Exceptions({ shipment }: { shipment: AdminShipmentDetail }): React.JSX.Element | null {
  const { t } = useI18n();

  if (shipment.exceptions.length === 0) return null;

  return (
    <Card title={t('logistics.shipment.exceptions')}>
      <ul className="divide-y divide-border-subtle">
        {shipment.exceptions.map((exception) => (
          <li key={exception.id} className="px-5 py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
              {humanise(exception.type)}
              <Badge tone={severityTone(exception.severity)} dot>
                {t(severityKey(exception.severity))}
              </Badge>
              <Badge tone={exception.resolvedAt === null ? 'warning' : 'success'}>
                {humanise(exception.state)}
              </Badge>
            </p>
            {exception.reason !== null && (
              <p className="mt-1 text-xs leading-relaxed text-ink-muted">{exception.reason}</p>
            )}
            <p className="mt-1 text-xxs text-ink-subtle">
              {formatDateTime(exception.createdAt)}
              {exception.resolutionDueAt !== null &&
                ` · ${t('logistics.shipment.resolveBy', {
                  when: formatDateTime(exception.resolutionDueAt),
                })}`}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Assignments({ shipment }: { shipment: AdminShipmentDetail }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('logistics.shipment.assignments')}>
      {shipment.assignments.length === 0 ? (
        <EmptyState
          title={t('logistics.shipment.noAssignmentsTitle')}
          description={t('logistics.shipment.noAssignmentsBody')}
        />
      ) : (
        <ul className="divide-y divide-border-subtle">
          {shipment.assignments.map((assignment) => (
            <li key={assignment.id} className="px-5 py-3">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {assignment.partner.displayName}
                <Badge tone={assignmentTone(assignment.state)}>{humanise(assignment.state)}</Badge>
                {assignment.assignedAutomatically && (
                  <Badge tone="neutral">{t('logistics.shipment.automatic')}</Badge>
                )}
              </p>
              <p className="mt-1 text-xxs text-ink-subtle">
                {t('logistics.shipment.offeredAt', { when: formatDateTime(assignment.offeredAt) })}
                {assignment.respondBy !== null &&
                  ` · ${t('logistics.shipment.respondBy', {
                    when: formatDateTime(assignment.respondBy),
                  })}`}
              </p>
              {(assignment.responseReason ?? assignment.withdrawnReason) !== null && (
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">
                  {assignment.responseReason ?? assignment.withdrawnReason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function Timeline({ events }: { events: ShipmentTimelineEvent[] }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <Card title={t('logistics.shipment.timeline')} bodyClassName="px-5 py-4">
      {events.length === 0 ? (
        <EmptyState
          title={t('logistics.shipment.noEventsTitle')}
          description={t('logistics.shipment.noEventsBody')}
        />
      ) : (
        <ol className="space-y-4">
          {events.map((event) => (
            <li key={event.id} className="relative pl-6">
              <span
                className={`absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full ${
                  event.isCorrection ? 'bg-warning' : 'bg-accent'
                }`}
                aria-hidden="true"
              />

              <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                {t(statusLabelKey(event.status))}
                {event.isCorrection && (
                  <Badge tone="warning">{t('logistics.shipment.correction')}</Badge>
                )}
                <Badge tone="neutral">{t(sourceKey(event.source))}</Badge>
              </p>

              {event.publicDescription !== null && (
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">
                  {event.publicDescription}
                </p>
              )}

              {event.reason !== null && (
                <p className="mt-0.5 text-xs leading-relaxed text-ink-muted">{event.reason}</p>
              )}

              {event.internalNote !== null && (
                <p className="mt-0.5 text-xs leading-relaxed text-ink-subtle">
                  {event.internalNote}
                </p>
              )}

              <p className="mt-0.5 text-xxs text-ink-subtle">
                {formatDateTime(event.occurredAt)}
                {event.locationLabel !== null && ` · ${event.locationLabel}`}
                {/* The carrier's own code, kept beside what it was mapped to.
                    Without it a mis-mapped code is invisible. */}
                {event.externalStatusCode !== null &&
                  ` · ${t('logistics.shipment.carrierCode', { code: event.externalStatusCode })}`}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function Actions({ shipment }: { shipment: AdminShipmentDetail }): React.JSX.Element | null {
  const { t } = useI18n();
  const { can } = useSession();

  const [dialog, setDialog] = useState<'assign' | 'withdraw' | 'correct' | null>(null);

  if (!can(Permission.LOGISTICS_ASSIGN)) return null;

  return (
    <>
      {shipment.assignedPartner === null ? (
        <Button
          onClick={() => {
            setDialog('assign');
          }}
        >
          {t('logistics.shipment.assign')}
        </Button>
      ) : (
        <Button
          variant="secondary"
          onClick={() => {
            setDialog('withdraw');
          }}
        >
          {t('logistics.shipment.withdraw')}
        </Button>
      )}

      <Button
        variant="secondary"
        onClick={() => {
          setDialog('correct');
        }}
      >
        {t('logistics.shipment.correct')}
      </Button>

      <AssignDialog
        shipment={shipment}
        isOpen={dialog === 'assign'}
        onClose={() => {
          setDialog(null);
        }}
      />
      <WithdrawDialog
        shipment={shipment}
        isOpen={dialog === 'withdraw'}
        onClose={() => {
          setDialog(null);
        }}
      />
      <CorrectDialog
        shipment={shipment}
        isOpen={dialog === 'correct'}
        onClose={() => {
          setDialog(null);
        }}
      />
    </>
  );
}

function AssignDialog({
  shipment,
  isOpen,
  onClose,
}: {
  shipment: AdminShipmentDetail;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState<string | null>(null);

  const candidates = useQuery({
    queryKey: ['admin', 'logistics', 'eligible', shipment.id],
    queryFn: () => fetchEligiblePartners(shipment.id),
    enabled: isOpen,
  });

  const assign = useMutation({
    mutationFn: (logisticsPartnerId: string) => assignShipment(shipment.id, { logisticsPartnerId }),
    onSuccess: () => {
      toast.success(t('logistics.shipment.offered'));
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('logistics.shipment.assign')}
      description={t('logistics.shipment.assignIntro')}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={chosen === null || assign.isPending}
            onClick={() => {
              if (chosen !== null) assign.mutate(chosen);
            }}
          >
            {t('logistics.shipment.sendOffer')}
          </Button>
        </>
      }
    >
      {candidates.isPending ? (
        <LoadingState label={t('logistics.shipment.findingCarriers')} />
      ) : candidates.isError ? (
        <ErrorState
          error={candidates.error}
          onRetry={() => {
            void candidates.refetch();
          }}
        />
      ) : candidates.data.partners.length === 0 ? (
        <EmptyState
          title={t('logistics.shipment.noCarriersTitle')}
          description={t('logistics.shipment.noCarriersBody')}
        />
      ) : (
        <ul className="space-y-2">
          {candidates.data.partners.map((partner) => (
            <li key={partner.id}>
              <label
                className={`flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                  chosen === partner.id
                    ? 'border-accent/40 bg-accent-soft'
                    : 'border-border hover:border-border-hover'
                }`}
              >
                <input
                  type="radio"
                  name="carrier"
                  className="mt-1 h-4 w-4 accent-accent"
                  checked={chosen === partner.id}
                  onChange={() => {
                    setChosen(partner.id);
                  }}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink">
                    {partner.displayName}
                    <Badge tone={partner.isEligible ? 'success' : 'warning'}>
                      {partner.isEligible
                        ? t('logistics.shipment.eligible')
                        : t('logistics.shipment.notEligible')}
                    </Badge>
                  </span>

                  <span className="mt-0.5 block text-xs text-ink-muted">
                    {t('logistics.shipment.openWork', {
                      open: formatNumber(partner.openShipments),
                      ceiling:
                        partner.maxOpenShipments === null
                          ? t('logistics.partner.noCeiling')
                          : formatNumber(partner.maxOpenShipments),
                    })}
                    {' · '}
                    {partner.onTimePercentage === null
                      ? t('logistics.shipment.noOnTimeHistory')
                      : t('logistics.shipment.onTime', {
                          percent: String(partner.onTimePercentage),
                        })}
                  </span>

                  {/* The server's own reasons, verbatim. They are written to be
                      read by the person making this decision. */}
                  {partner.reasons.length > 0 && (
                    <span className="mt-1 block text-xxs leading-relaxed text-ink-subtle">
                      {partner.reasons.join(' · ')}
                    </span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function WithdrawDialog({
  shipment,
  isOpen,
  onClose,
}: {
  shipment: AdminShipmentDetail;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');

  const withdraw = useMutation({
    mutationFn: () => withdrawShipment(shipment.id, reason.trim()),
    onSuccess: () => {
      toast.success(t('logistics.shipment.withdrawn'));
      setReason('');
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('logistics.shipment.withdraw')}
      description={t('logistics.shipment.withdrawIntro')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={reason.trim().length < 4 || withdraw.isPending}
            onClick={() => {
              withdraw.mutate();
            }}
          >
            {t('logistics.shipment.withdraw')}
          </Button>
        </>
      }
    >
      <Field
        label={t('logistics.shipment.field.reason')}
        hint={t('logistics.shipment.withdrawReasonHint')}
      >
        {({ inputId, describedBy }) => (
          <Textarea
            id={inputId}
            aria-describedby={describedBy}
            rows={3}
            value={reason}
            onChange={(event) => {
              setReason(event.currentTarget.value);
            }}
          />
        )}
      </Field>
    </Modal>
  );
}

function CorrectDialog({
  shipment,
  isOpen,
  onClose,
}: {
  shipment: AdminShipmentDetail;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ShipmentStatus | ''>('');
  const [reason, setReason] = useState('');

  const correct = useMutation({
    mutationFn: () =>
      correctShipmentStatus(shipment.id, {
        status: status as ShipmentStatus,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success(t('logistics.shipment.corrected'));
      setStatus('');
      setReason('');
      onClose();
      void queryClient.invalidateQueries({ queryKey: ['admin', 'logistics'] });
    },
    onError: (error: Error) => {
      toast.error(error.message);
    },
  });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t('logistics.shipment.correct')}
      description={t('logistics.shipment.correctIntro')}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="danger"
            disabled={status === '' || reason.trim().length < 8 || correct.isPending}
            onClick={() => {
              correct.mutate();
            }}
          >
            {t('logistics.shipment.recordCorrection')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Callout tone="warning" role="status">
          {t('logistics.shipment.correctWarning')}
        </Callout>

        <Field label={t('logistics.shipment.field.newStatus')}>
          {({ inputId, describedBy }) => (
            <Select
              id={inputId}
              aria-describedby={describedBy}
              value={status}
              onChange={(event) => {
                setStatus(event.currentTarget.value as ShipmentStatus | '');
              }}
            >
              <option value="">{t('common.choose')}</option>
              {STATUS_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {t(statusLabelKey(value))}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label={t('logistics.shipment.field.reason')}
          hint={t('logistics.shipment.correctReasonHint')}
        >
          {({ inputId, describedBy }) => (
            <Textarea
              id={inputId}
              aria-describedby={describedBy}
              rows={3}
              value={reason}
              onChange={(event) => {
                setReason(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </div>
    </Modal>
  );
}

/**
 * Every status, for the correction dialog only.
 *
 * Deliberately not `shipment.allowedTransitions`: a correction exists precisely
 * to reach a status the state machine would refuse, and offering only the legal
 * next steps would make the one screen that can fix a mistake unable to. The
 * server still refuses a value that is not a status at all.
 */
const STATUS_OPTIONS: readonly ShipmentStatus[] = [
  'CREATED',
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'ACCEPTANCE_PENDING',
  'ACCEPTED',
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
  'CANCELLED',
];

// ---------------------------------------------------------------------------
// Presentation, for this screen only
// ---------------------------------------------------------------------------

/** A contact as one line, with the parts that are missing simply absent. */
function contactLine(name: string | null, phone: string | null, email: string | null): string {
  const parts = [name, phone, email].filter(
    (part): part is string => part !== null && part.length > 0,
  );

  return parts.length === 0 ? '—' : parts.join(' · ');
}

function assignmentTone(
  state: AdminShipmentDetail['assignments'][number]['state'],
): 'success' | 'warning' | 'danger' | 'neutral' | 'accent' {
  switch (state) {
    case 'ACCEPTED':
      return 'success';
    case 'OFFERED':
      return 'accent';
    case 'REJECTED':
    case 'EXPIRED':
      return 'danger';
    case 'WITHDRAWN':
      return 'warning';
    case 'COMPLETED':
      return 'neutral';
  }
}
