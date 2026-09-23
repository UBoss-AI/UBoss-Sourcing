/**
 * Who is carrying one consignment, and the seller's controls over that.
 *
 * Replaces the bare carrier dropdown. The seller confirms an order, and this
 * is where they hand its consignment on - to a delivery company on the
 * platform, which is offered it and puts its own driver on it, or to DHL,
 * FedEx or India Post, which the seller books themselves and records here.
 *
 * WHAT THIS SCREEN NEVER CLAIMS. That Glovia booked a carrier, printed a
 * label, quoted a rate, or knows where a hand-booked parcel is beyond what the
 * seller typed. A hand-made booking is badged "Manual booking" wherever it
 * appears, its tracking number is the one the seller entered, and the link
 * beside it goes to the carrier's own tracking page.
 *
 * WHAT THIS SCREEN NEVER OFFERS. A driver. The seller sees that the carrier
 * has put somebody on it, with a masked name, and nothing else of the fleet.
 *
 * Every decision - who is eligible, what stage it is at, whether the seller
 * may still move it - comes from the server. After every action the order is
 * re-read, so the page shows the new state without a reload.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Badge, Button, ErrorState, Field, Input, LoadingState, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { CARRIERS, SETUP_STATUS_TONE, type OutsideCarrier } from '@/lib/carrier-providers';
import {
  MILESTONES_NEEDING_REASON,
  NEXT_MANUAL_MILESTONES,
  SELLER_DOCUMENT_KINDS,
  assignPartner,
  attachDocument,
  createManualBooking,
  fetchLogisticsOptions,
  recordMilestone,
  updateManualBooking,
  withdrawCarrier,
  type ConsignmentLogisticsState,
  type LogisticsOptions,
  type LogisticsStage,
  type ManualBooking,
  type ManualMilestone,
  type PartnerRefusal,
  type SellerDocumentKind,
} from '@/lib/consignment-logistics';
import { cx } from '@/lib/cx';
import { errorMessage } from '@/lib/errors';
import { majorToMinor } from '@/lib/format';

const STAGE_TONE: Readonly<Record<LogisticsStage, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'>> =
  Object.freeze({
    AWAITING_LOGISTICS_ASSIGNMENT: 'warning',
    PARTNER_REJECTED: 'danger',
    ASSIGNMENT_PENDING: 'brand',
    CARRIER_BOOKING_PENDING: 'warning',
    DRIVER_ASSIGNMENT_REQUIRED: 'brand',
    DRIVER_ASSIGNED: 'brand',
    PICKUP_SCHEDULED: 'brand',
    PICKED_UP: 'brand',
    IN_TRANSIT: 'brand',
    OUT_FOR_DELIVERY: 'brand',
    DELIVERED: 'success',
    DELIVERY_FAILED: 'danger',
    RETURNING: 'warning',
    RETURNED: 'neutral',
    CANCELLED: 'neutral',
  });

/** Re-read everything that shows this consignment. */
function useRefresh(sellerOrderId: string): () => Promise<void> {
  const client = useQueryClient();
  return async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['seller', 'order', sellerOrderId] }),
      client.invalidateQueries({ queryKey: ['seller', 'orders'] }),
      client.invalidateQueries({ queryKey: ['seller', 'logistics-options'] }),
      client.invalidateQueries({ queryKey: ['seller', 'notifications'] }),
    ]);
  };
}

export function ConsignmentLogisticsPanel({
  sellerOrderId,
  state,
}: {
  sellerOrderId: string;
  state: ConsignmentLogisticsState;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh(sellerOrderId);

  const [isAssigning, setIsAssigning] = useState(false);
  const [isWithdrawing, setIsWithdrawing] = useState(false);
  const [withdrawReason, setWithdrawReason] = useState('');

  const withdraw = useMutation({
    mutationFn: () => withdrawCarrier({ shipmentId: state.id, reason: withdrawReason.trim() }),
    onSuccess: async () => {
      toast.success(t('logistics.withdrawn'));
      setIsWithdrawing(false);
      setWithdrawReason('');
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('logistics.actionFailed')));
    },
  });

  const hasCarrier = state.mode !== 'NONE';

  return (
    <div className="rounded-lg border border-border bg-surface p-4" data-testid={`consignment-${state.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-ink">{state.reference}</p>
        <div className="flex flex-wrap items-center gap-1.5">
          {state.mode === 'MANUAL_CARRIER' && <Badge tone="warning">{t('logistics.badge.manual')}</Badge>}
          {state.manualBooking !== null && state.manualBooking.carrierTrackingNumber === null && (
            <Badge tone="warning">{t('logistics.badge.trackingPending')}</Badge>
          )}
          <Badge tone={STAGE_TONE[state.stage]}>{t(`logistics.stage.${state.stage}`)}</Badge>
        </div>
      </div>

      <dl className="mt-3 space-y-1.5 text-sm">
        {state.partner !== null && (
          <Row label={t('logistics.partner')} value={state.partner.displayName} />
        )}
        {state.manualBooking !== null && (
          <Row label={t('logistics.carrier')} value={state.manualBooking.carrierName} />
        )}
        {state.mode === 'PARTNER' && (
          <Row
            label={t('logistics.driver')}
            value={
              state.driver.isAssigned
                ? t('logistics.driverAssigned', { name: state.driver.maskedName ?? '' })
                : t('logistics.driverNotYet')
            }
          />
        )}
        {state.carrierTrackingNumber !== null && (
          <Row
            label={t('logistics.trackingNumber')}
            value={
              state.trackingPageUrl === null ? (
                state.carrierTrackingNumber
              ) : (
                <a
                  href={state.trackingPageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-brand hover:underline"
                >
                  {state.carrierTrackingNumber}
                </a>
              )
            }
          />
        )}
      </dl>

      {/* The one next action, or why there is none. */}
      <div className="mt-4 space-y-2">
        {state.assignBlock === 'SELLER_ORDER_NOT_CONFIRMED' && (
          <p className="rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
            {t('logistics.confirmFirst')}
          </p>
        )}
        {state.assignBlock === 'COLLECTED' && (
          <p className="rounded-lg bg-surface-sunken px-3 py-2 text-xs text-ink-muted">
            {t('logistics.lockedAfterPickup')}
          </p>
        )}
        {state.stage === 'PARTNER_REJECTED' && (
          <p className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-xs text-ink">
            {t('logistics.partnerRejected', { reason: state.history[0]?.reason ?? '' })}
          </p>
        )}

        {state.canAssign && (
          <div className="flex flex-wrap gap-2">
            <Button
              variant={hasCarrier ? 'secondary' : 'primary'}
              size="sm"
              onClick={() => {
                setIsAssigning(true);
              }}
            >
              {hasCarrier ? t('logistics.changeCarrier') : t('logistics.assign')}
            </Button>
            {hasCarrier && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsWithdrawing(true);
                }}
              >
                {state.mode === 'MANUAL_CARRIER' ? t('logistics.cancelBooking') : t('logistics.withdraw')}
              </Button>
            )}
          </div>
        )}
      </div>

      {state.manualBooking !== null && (
        <ManualBookingPanel
          sellerOrderId={sellerOrderId}
          shipmentId={state.id}
          status={state.status}
          booking={state.manualBooking}
        />
      )}

      {state.history.length > 0 && (
        <details className="mt-4 text-xs">
          <summary className="cursor-pointer text-ink-muted">{t('logistics.history')}</summary>
          <ul className="mt-2 space-y-1">
            {state.history.map((entry, index) => (
              <li key={`${entry.at}-${String(index)}`} className="text-ink-muted">
                {new Date(entry.at).toLocaleString()} · {entry.carrierName} ·{' '}
                {t(`logistics.historyState.${entry.state}`)}
                {entry.reason !== null && entry.reason !== '' ? ` — ${entry.reason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      )}

      {isAssigning && (
        <AssignDialog
          sellerOrderId={sellerOrderId}
          shipmentId={state.id}
          current={state}
          onClose={() => {
            setIsAssigning(false);
          }}
        />
      )}

      {isWithdrawing && (
        <Modal
          isOpen
          title={state.mode === 'MANUAL_CARRIER' ? t('logistics.cancelBooking') : t('logistics.withdraw')}
          onClose={() => {
            setIsWithdrawing(false);
          }}
        >
          <div className="space-y-4">
            <p className="text-sm text-ink-muted">{t('logistics.withdrawBody')}</p>
            <Field label={t('logistics.reasonLabel')} hint={t('logistics.reasonHint')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={withdrawReason}
                  onChange={(event) => {
                    setWithdrawReason(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  setIsWithdrawing(false);
                }}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                isLoading={withdraw.isPending}
                disabled={withdrawReason.trim().length < 4}
                onClick={() => {
                  withdraw.mutate();
                }}
              >
                {t('logistics.confirmWithdraw')}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 break-all text-right text-ink">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Choosing who carries it
// ---------------------------------------------------------------------------

type Choice = { kind: 'PARTNER'; id: string } | { kind: 'CARRIER'; provider: OutsideCarrier } | null;

function AssignDialog({
  sellerOrderId,
  shipmentId,
  current,
  onClose,
}: {
  sellerOrderId: string;
  shipmentId: string;
  current: ConsignmentLogisticsState;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh(sellerOrderId);

  const [choice, setChoice] = useState<Choice>(null);
  const [reason, setReason] = useState('');

  const options = useQuery({
    queryKey: ['seller', 'logistics-options', shipmentId],
    queryFn: () => fetchLogisticsOptions(shipmentId),
  });

  const replacing = current.mode !== 'NONE';

  const submit = useMutation({
    mutationFn: async () => {
      if (choice === null) return;
      const why = replacing ? reason.trim() : null;
      if (choice.kind === 'PARTNER') {
        await assignPartner({ shipmentId, logisticsPartnerId: choice.id, reason: why });
      } else {
        await createManualBooking({ shipmentId, provider: choice.provider, reason: why });
      }
    },
    onSuccess: async () => {
      toast.success(choice?.kind === 'CARRIER' ? t('logistics.manualCreated') : t('logistics.offered'));
      await refresh();
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('logistics.actionFailed')));
    },
  });

  return (
    <Modal isOpen size="lg" title={t('logistics.assignTitle', { reference: current.reference })} onClose={onClose}>
      {options.isPending && <LoadingState label={t('logistics.loadingOptions')} />}

      {options.isError && (
        <ErrorState
          error={options.error}
          onRetry={() => {
            void options.refetch();
          }}
        />
      )}

      {options.isSuccess && (
        <div className="space-y-5">
          <Summary options={options.data} />

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink">{t('logistics.partnersHeading')}</legend>
            <p className="text-xs text-ink-muted">{t('logistics.partnersBody')}</p>

            {options.data.partners.length === 0 && (
              <p className="text-sm text-ink-muted">
                {t('logistics.noPartners')}{' '}
                <Link to="/seller/carriers" className="text-brand underline">
                  {t('sellerCarriers.title')}
                </Link>
              </p>
            )}

            {options.data.partners.map((partner) => (
              <ChoiceRow
                key={partner.logisticsPartnerId}
                name="logistics-choice"
                checked={choice?.kind === 'PARTNER' && choice.id === partner.logisticsPartnerId}
                disabled={!partner.isEligible}
                onSelect={() => {
                  setChoice({ kind: 'PARTNER', id: partner.logisticsPartnerId });
                }}
                title={partner.displayName}
                subtitle={t('logistics.partnerMode')}
                notes={
                  partner.isEligible
                    ? [t('logistics.partnerEligible')]
                    : [partnerReason(t, partner.refusal, partner.serviceability)]
                }
                tone={partner.isEligible ? 'neutral' : 'danger'}
              />
            ))}
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold text-ink">{t('logistics.carriersHeading')}</legend>
            <p className="text-xs text-ink-muted">{t('logistics.carriersBody')}</p>

            {options.data.carriers.map((carrier) => (
              <ChoiceRow
                key={carrier.provider}
                name="logistics-choice"
                checked={choice?.kind === 'CARRIER' && choice.provider === carrier.provider}
                disabled={!carrier.isAvailable}
                onSelect={() => {
                  setChoice({ kind: 'CARRIER', provider: carrier.provider });
                }}
                title={CARRIERS[carrier.provider].displayName}
                monogram={CARRIERS[carrier.provider].monogram}
                monogramClass={CARRIERS[carrier.provider].badgeClass}
                subtitle={t('logistics.manualMode')}
                badge={
                  <Badge tone={SETUP_STATUS_TONE[carrier.setupStatus]}>
                    {t(`carrier.setupStatus.${carrier.setupStatus}`)}
                  </Badge>
                }
                notes={carrier.notes.map((note) => t(`logistics.note.${note}`))}
                tone={carrier.isAvailable ? 'neutral' : 'danger'}
              />
            ))}
          </fieldset>

          {choice?.kind === 'CARRIER' && (
            <p role="status" className="rounded-lg border border-warning/30 bg-warning-soft px-4 py-3 text-xs text-ink">
              {t('logistics.manualWarning', { carrier: CARRIERS[choice.provider].displayName })}
            </p>
          )}

          {replacing && choice !== null && (
            <Field label={t('logistics.reasonLabel')} hint={t('logistics.reasonHint')} required>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}

          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button
              variant="primary"
              isLoading={submit.isPending}
              disabled={choice === null || (replacing && reason.trim().length < 4)}
              onClick={() => {
                submit.mutate();
              }}
            >
              {choice?.kind === 'CARRIER' ? t('logistics.submitManual') : t('logistics.submitPartner')}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** A partner's reason for being unavailable, in the seller's language. */
function partnerReason(
  t: Translate,
  refusal: PartnerRefusal | null,
  serviceability: readonly string[],
): string {
  if (refusal !== null) return t(`logistics.refusal.${refusal}`);
  const first = serviceability[0] ?? '';
  if (first === 'MISSING_CAPABILITY:PALLET') return t('logistics.service.PALLET');
  if (first.startsWith('MISSING_CAPABILITY:')) return t('logistics.service.CAPABILITY');
  switch (first) {
    case 'NO_COVERAGE_ORIGIN':
    case 'NO_COVERAGE_DESTINATION':
      return t('logistics.service.ROUTE');
    case 'AT_CAPACITY':
      return t('logistics.service.AT_CAPACITY');
    case 'CONTAINER_NOT_SUPPORTED':
      return t('logistics.service.CONTAINER');
    default:
      return t('logistics.service.INACTIVE');
  }
}

function ChoiceRow({
  name,
  checked,
  disabled,
  onSelect,
  title,
  subtitle,
  notes,
  tone,
  badge,
  monogram,
  monogramClass,
}: {
  name: string;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
  title: string;
  subtitle: string;
  notes: string[];
  tone: 'neutral' | 'danger';
  badge?: React.ReactNode;
  monogram?: string;
  monogramClass?: string;
}): React.JSX.Element {
  return (
    <label
      className={cx(
        'flex cursor-pointer items-start gap-3 rounded-lg border p-3',
        checked ? 'border-brand bg-brand-soft/30' : 'border-border',
        disabled && 'cursor-not-allowed opacity-70',
      )}
    >
      <input
        type="radio"
        name={name}
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      {monogram !== undefined && (
        <span
          aria-hidden="true"
          className={cx(
            'inline-flex h-8 min-w-8 items-center justify-center rounded-md px-1.5 text-xxs font-bold',
            monogramClass,
          )}
        >
          {monogram}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-medium text-ink">{title}</span>
          {badge}
        </span>
        <span className="mt-0.5 block text-xxs text-ink-subtle">{subtitle}</span>
        {notes.map((note) => (
          <span
            key={note}
            className={cx('mt-1 block text-xs', tone === 'danger' ? 'text-danger' : 'text-ink-muted')}
          >
            {note}
          </span>
        ))}
      </span>
    </label>
  );
}

function Summary({ options }: { options: LogisticsOptions }): React.JSX.Element {
  const { t } = useI18n();
  const c = options.consignment;
  const handling = [
    c.handling.coldChain && t('logistics.handling.coldChain'),
    c.handling.temperatureControlled && t('logistics.handling.temperature'),
    c.handling.sterile && t('logistics.handling.sterile'),
    c.handling.dangerousGoods && t('logistics.handling.dangerous'),
    c.handling.fragile && t('logistics.handling.fragile'),
  ].filter((entry): entry is string => typeof entry === 'string');

  return (
    <dl className="grid gap-x-6 gap-y-1.5 rounded-lg bg-surface-sunken p-4 text-xs sm:grid-cols-2">
      <Row label={t('logistics.summary.reference')} value={`${c.reference}${c.sellerOrderNumber === null ? '' : ` · ${c.sellerOrderNumber}`}`} />
      <Row label={t('logistics.summary.from')} value={[c.origin.city, c.origin.countryCode].filter(Boolean).join(', ')} />
      <Row
        label={t('logistics.summary.to')}
        value={[c.destination.city, c.destination.postalCode, c.destination.countryCode].filter(Boolean).join(', ')}
      />
      <Row label={t('logistics.summary.load')} value={t(`logistics.load.${c.loadType}`)} />
      <Row
        label={t('logistics.summary.packages')}
        value={t('logistics.summary.packagesValue', {
          count: c.packageCount,
          weight: (c.totalWeightGrams / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 }),
        })}
      />
      {c.packages
        .filter((pkg) => pkg.lengthMm !== null && pkg.widthMm !== null && pkg.heightMm !== null)
        .map((pkg) => (
          <Row
            key={pkg.sequence}
            label={t('logistics.summary.package', { number: pkg.sequence })}
            value={`${String((pkg.lengthMm ?? 0) / 10)} × ${String((pkg.widthMm ?? 0) / 10)} × ${String((pkg.heightMm ?? 0) / 10)} cm`}
          />
        ))}
      <Row
        label={t('logistics.summary.pickupBy')}
        value={c.pickupBy === null ? t('logistics.summary.notSet') : new Date(c.pickupBy).toLocaleString()}
      />
      <Row
        label={t('logistics.summary.deliverBy')}
        value={c.deliverBy === null ? t('logistics.summary.notSet') : new Date(c.deliverBy).toLocaleString()}
      />
      {(handling.length > 0 || c.handling.notes !== null) && (
        <Row
          label={t('logistics.summary.handling')}
          value={[...handling, c.handling.notes].filter(Boolean).join(' · ')}
        />
      )}
    </dl>
  );
}

// ---------------------------------------------------------------------------
// A booking the seller made themselves
// ---------------------------------------------------------------------------

function ManualBookingPanel({
  sellerOrderId,
  shipmentId,
  status,
  booking,
}: {
  sellerOrderId: string;
  shipmentId: string;
  status: string;
  booking: ManualBooking;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const refresh = useRefresh(sellerOrderId);
  const carrier = CARRIERS[booking.provider];

  const [form, setForm] = useState({
    carrierTrackingNumber: booking.carrierTrackingNumber ?? '',
    serviceName: booking.serviceName ?? '',
    pickupReference: booking.pickupReference ?? '',
    expectedPickupAt: booking.expectedPickupAt?.slice(0, 10) ?? '',
    expectedDeliveryAt: booking.expectedDeliveryAt?.slice(0, 10) ?? '',
    cost: booking.shippingCostMinor === null ? '' : minorToMajorText(booking.shippingCostMinor),
  });
  const [milestoneReason, setMilestoneReason] = useState('');
  const [docKind, setDocKind] = useState<SellerDocumentKind>('PROOF_OF_DELIVERY');

  const save = useMutation({
    mutationFn: () => {
      const costMinor = form.cost.trim() === '' ? null : majorToMinor(form.cost.trim());
      if (form.cost.trim() !== '' && costMinor === null) throw new Error(t('logistics.costInvalid'));

      return updateManualBooking({
        shipmentId,
        details: {
          serviceName: form.serviceName.trim() || null,
          pickupReference: form.pickupReference.trim() || null,
          ...(form.carrierTrackingNumber.trim() === ''
            ? {}
            : { carrierTrackingNumber: form.carrierTrackingNumber.trim() }),
          expectedPickupAt: form.expectedPickupAt === '' ? null : new Date(form.expectedPickupAt).toISOString(),
          expectedDeliveryAt: form.expectedDeliveryAt === '' ? null : new Date(form.expectedDeliveryAt).toISOString(),
          shippingCostMinor: costMinor,
        },
      });
    },
    onSuccess: async () => {
      toast.success(t('logistics.bookingSaved'));
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('logistics.actionFailed')));
    },
  });

  const milestone = useMutation({
    mutationFn: (next: ManualMilestone) =>
      recordMilestone({
        shipmentId,
        status: next,
        reason: MILESTONES_NEEDING_REASON.has(next) ? milestoneReason.trim() : null,
        idempotencyKey: `${next}-from-${status}`,
      }),
    onSuccess: async () => {
      setMilestoneReason('');
      toast.success(t('logistics.milestoneSaved'));
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('logistics.actionFailed')));
    },
  });

  const upload = useMutation({
    mutationFn: (file: File) => attachDocument({ shipmentId, kind: docKind, file }),
    onSuccess: async () => {
      toast.success(t('logistics.documentSaved'));
      await refresh();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('logistics.actionFailed')));
    },
  });

  const next = booking.status === 'BOOKED' ? (NEXT_MANUAL_MILESTONES[status] ?? []) : [];
  const needsReason = next.some((entry) => MILESTONES_NEEDING_REASON.has(entry));

  return (
    <div className="mt-4 space-y-4 border-t border-border-subtle pt-4">
      <p className="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs leading-relaxed text-ink">
        {booking.status === 'BOOKED'
          ? t('logistics.manualBookedNote', { carrier: carrier.displayName })
          : t('logistics.manualPendingNote', { carrier: carrier.displayName })}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('logistics.field.tracking', { carrier: carrier.displayName })} hint={t('logistics.field.trackingHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={form.carrierTrackingNumber}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((prev) => ({ ...prev, carrierTrackingNumber: value }));
              }}
            />
          )}
        </Field>
        <Field label={t('logistics.field.service')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={form.serviceName}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((prev) => ({ ...prev, serviceName: value }));
              }}
            />
          )}
        </Field>
        <Field label={t('logistics.field.pickupReference')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={form.pickupReference}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((prev) => ({ ...prev, pickupReference: value }));
              }}
            />
          )}
        </Field>
        <Field label={t('logistics.field.cost')} hint={t('logistics.field.costHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={form.cost}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((prev) => ({ ...prev, cost: value }));
              }}
            />
          )}
        </Field>
        <Field label={t('logistics.field.pickupDate')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="date"
              value={form.expectedPickupAt}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((prev) => ({ ...prev, expectedPickupAt: value }));
              }}
            />
          )}
        </Field>
        <Field label={t('logistics.field.deliveryDate')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              type="date"
              value={form.expectedDeliveryAt}
              onChange={(event) => {
                const value = event.currentTarget.value;
                setForm((prev) => ({ ...prev, expectedDeliveryAt: value }));
              }}
            />
          )}
        </Field>
      </div>

      <Button
        variant="primary"
        size="sm"
        isLoading={save.isPending}
        onClick={() => {
          save.mutate();
        }}
      >
        {t('logistics.saveBooking')}
      </Button>

      {next.length > 0 && (
        <div className="space-y-2 border-t border-border-subtle pt-4">
          <p className="text-xs font-semibold text-ink">{t('logistics.milestonesTitle')}</p>
          <p className="text-xxs text-ink-muted">{t('logistics.milestonesBody', { carrier: carrier.displayName })}</p>
          {needsReason && (
            <Field label={t('logistics.milestoneReason')}>
              {({ inputId, describedBy }) => (
                <Input
                  id={inputId}
                  aria-describedby={describedBy}
                  value={milestoneReason}
                  onChange={(event) => {
                    setMilestoneReason(event.currentTarget.value);
                  }}
                />
              )}
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            {next.map((entry) => (
              <Button
                key={entry}
                variant="secondary"
                size="sm"
                disabled={
                  milestone.isPending ||
                  (MILESTONES_NEEDING_REASON.has(entry) && milestoneReason.trim().length === 0)
                }
                onClick={() => {
                  milestone.mutate(entry);
                }}
              >
                {t(`logistics.milestone.${entry}`)}
              </Button>
            ))}
          </div>
          {next.includes('DELIVERED') && (
            <p className="text-xxs text-ink-muted">{t('logistics.deliveredNeedsProof')}</p>
          )}
        </div>
      )}

      <div className="space-y-2 border-t border-border-subtle pt-4">
        <p className="text-xs font-semibold text-ink">{t('logistics.documentsTitle')}</p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('logistics.documentKind')}>
            {({ inputId, describedBy }) => (
              <Select
                id={inputId}
                aria-describedby={describedBy}
                value={docKind}
                onChange={(event) => {
                  const value = event.currentTarget.value;
                  const kind = SELLER_DOCUMENT_KINDS.find((entry) => entry === value);
                  if (kind !== undefined) setDocKind(kind);
                }}
              >
                {SELLER_DOCUMENT_KINDS.map(
                  (kind) => (
                    <option key={kind} value={kind}>
                      {t(`logistics.documentKind.${kind}`)}
                    </option>
                  ),
                )}
              </Select>
            )}
          </Field>
          <label className="relative inline-flex cursor-pointer items-center rounded-lg border border-border px-3 py-2 text-sm text-ink hover:bg-surface-sunken">
            {upload.isPending ? t('logistics.uploading') : t('logistics.chooseFile')}
            <input
              type="file"
              accept="image/*"
              className="sr-only"
              disabled={upload.isPending}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file !== undefined) upload.mutate(file);
                event.currentTarget.value = '';
              }}
            />
          </label>
        </div>
        <p className="text-xxs text-ink-muted">{t('logistics.documentsHint')}</p>
      </div>
    </div>
  );
}

/** Minor units as a plain decimal string, without ever becoming a number. */
function minorToMajorText(minor: string): string {
  const digits = minor.replace(/^-/, '').padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
