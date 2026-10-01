/**
 * Book one consignment (checklist Master row 56): how it travels, on what
 * Incoterm, between which ports, when it is collected, and by whom.
 *
 * The carrier choice here is the hand booking only - DHL, FedEx or India Post
 * booked on the carrier's own site and recorded - because the other two
 * routes already have their own controls on this page: offering the
 * consignment to a delivery company, and buying a label through the seller's
 * own carrier account. Nothing here calls a carrier.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, ErrorState, Field, Input, LoadingState, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, formatDate, formatMoneyMinor, majorToMinor, minorToMajor } from '@/lib/format';
import {
  BOOKING_CARRIERS,
  INCOTERMS,
  TRANSPORT_MODES,
  fetchFreightOptions,
  fetchShipmentBooking,
  saveShipmentBooking,
  type BookingInput,
  type SellerShipmentBooking,
} from '@/lib/shipment-paperwork';

/** Basis points as a percentage for display, by digit shifting: 35 is "0.35". */
function basisPointsAsPercent(basisPoints: number): string {
  return minorToMajor(String(basisPoints), 2).replace(/\.?0+$/, '');
}

interface FormState {
  mode: string;
  incoterm: string;
  incotermPlace: string;
  originPort: string;
  destinationPort: string;
  routeNote: string;
  pickupDate: string;
  pickupWindowFrom: string;
  pickupWindowTo: string;
  manualCarrier: string;
  insured: boolean;
  /** Major units, as typed. */
  insuredValue: string;
}

function formFrom(booking: SellerShipmentBooking): FormState {
  const terms = booking.terms;
  const currency = terms?.insuranceCurrency ?? booking.insurance?.currency ?? '';
  return {
    insured: terms?.insured ?? false,
    insuredValue:
      terms?.insuredValueMinor == null ? '' : minorToMajor(terms.insuredValueMinor, currencyExponent(currency)),
    mode: terms?.mode ?? (booking.crossBorder ? 'SEA' : 'ROAD'),
    incoterm: terms?.incoterm ?? (booking.crossBorder ? 'FOB' : 'DAP'),
    incotermPlace: terms?.incotermPlace ?? '',
    originPort: terms?.originPort ?? '',
    destinationPort: terms?.destinationPort ?? '',
    routeNote: terms?.routeNote ?? '',
    pickupDate: terms?.pickupDate ?? '',
    pickupWindowFrom: terms?.pickupWindowFrom ?? '',
    pickupWindowTo: terms?.pickupWindowTo ?? '',
    manualCarrier: '',
  };
}

const orNull = (value: string): string | null => (value.trim() === '' ? null : value.trim());

export function ShipmentBookingPanel({ shipmentId }: { shipmentId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const key = ['seller', 'consignment', shipmentId, 'booking'];
  const query = useQuery({ queryKey: key, queryFn: () => fetchShipmentBooking(shipmentId) });

  if (query.isLoading) return <LoadingState />;
  if (query.data?.booking === undefined) {
    if (!query.isError) return null;
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const booking = query.data.booking;
  return (
    <section aria-label={t('shipmentBooking.title')} className="space-y-3 rounded-lg border border-border p-4">
      <BookingForm key={booking.terms?.updatedAt ?? 'new'} booking={booking} queryKey={key} />
    </section>
  );
}

function BookingForm({
  booking,
  queryKey,
}: {
  booking: SellerShipmentBooking;
  queryKey: string[];
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [form, setForm] = useState<FormState>(() => formFrom(booking));
  const insurance = booking.insurance;
  const insuranceCurrency = insurance?.currency ?? '';

  const save = useMutation({
    mutationFn: () => {
      let insuredValueMinor: string | null = null;
      if (form.insured) {
        insuredValueMinor = majorToMinor(form.insuredValue, currencyExponent(insuranceCurrency));
        if (insuredValueMinor === null) throw new Error(t('shipmentBooking.insurance.valueInvalid'));
      }
      const input: BookingInput = {
        // Only sent where the marketplace offers insurance; otherwise left as it is.
        ...(insurance?.offered === true || booking.terms?.insured === true
          ? { insured: form.insured, insuredValueMinor }
          : {}),
        mode: form.mode,
        incoterm: form.incoterm,
        incotermPlace: orNull(form.incotermPlace),
        originPort: orNull(form.originPort),
        destinationPort: orNull(form.destinationPort),
        routeNote: orNull(form.routeNote),
        pickupDate: orNull(form.pickupDate),
        pickupWindowFrom: orNull(form.pickupWindowFrom),
        pickupWindowTo: orNull(form.pickupWindowTo),
        manualCarrier: BOOKING_CARRIERS.find((carrier) => carrier === form.manualCarrier) ?? null,
      };
      return saveShipmentBooking(booking.shipmentId, input);
    },
    onSuccess: async (result) => {
      client.setQueryData(queryKey, result);
      // A hand booking changes the carrier panel too.
      await client.invalidateQueries({ queryKey: ['seller', 'order'] });
      toast.success(t('shipmentBooking.saved'));
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('shipmentBooking.saveFailed')));
    },
  });

  const set = (field: keyof FormState) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = event.currentTarget.value;
    setForm((prev) => ({ ...prev, [field]: value }));
  };
  const portsRequired = booking.crossBorder && (form.mode === 'AIR' || form.mode === 'SEA');
  const disabled = !booking.canEdit;

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold text-ink">{t('shipmentBooking.title')}</h4>
        <Badge tone={booking.terms === null ? 'warning' : 'success'}>
          {booking.terms === null ? t('shipmentBooking.notBooked') : t('shipmentBooking.booked')}
        </Badge>
        {booking.crossBorder && <Badge tone="brand">{t('shipmentBooking.crossBorder')}</Badge>}
      </div>
      <p className="text-xs text-ink-muted" data-testid="booking-carrier">
        {booking.carrier.name === null
          ? t('shipmentBooking.noCarrier')
          : t('shipmentBooking.carriedBy', { carrier: booking.carrier.name })}
        {booking.carrier.trackingNumber !== null &&
          ` · ${t('shipmentBooking.tracking', { number: booking.carrier.trackingNumber })}`}
      </p>
      {booking.originCountry !== undefined && booking.destinationCountry !== undefined && (
        <p className="text-xs text-ink-muted" data-testid="booking-route">
          {t('shipmentBooking.routeCountries', {
            origin: booking.originCountry,
            destination: booking.destinationCountry,
          })}
        </p>
      )}
      <DispatchReadinessNote booking={booking} />

      <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('shipmentBooking.field.mode')} required>
          {({ inputId }) => (
            <Select id={inputId} value={form.mode} onChange={set('mode')}>
              {TRANSPORT_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {t(`shipmentBooking.mode.${mode}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('shipmentBooking.field.incoterm')} required>
          {({ inputId }) => (
            <Select id={inputId} value={form.incoterm} onChange={set('incoterm')}>
              {INCOTERMS.map((code) => (
                <option key={code} value={code}>
                  {code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('shipmentBooking.field.incotermPlace')} hint={t('shipmentBooking.field.incotermPlaceHint')}>
          {({ inputId, describedBy }) => (
            <Input id={inputId} aria-describedby={describedBy} value={form.incotermPlace} maxLength={120} onChange={set('incotermPlace')} />
          )}
        </Field>
        <Field label={t('shipmentBooking.field.carrier')} hint={t('shipmentBooking.field.carrierHint')}>
          {({ inputId, describedBy }) => (
            <Select id={inputId} aria-describedby={describedBy} value={form.manualCarrier} onChange={set('manualCarrier')}>
              <option value="">{t('shipmentBooking.keepCarrier')}</option>
              {BOOKING_CARRIERS.map((carrier) => (
                <option key={carrier} value={carrier}>
                  {t(`shipmentBooking.carrier.${carrier}`)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('shipmentBooking.field.originPort')} hint={t('shipmentBooking.field.portHint')} required={portsRequired}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={form.originPort}
              maxLength={5}
              autoComplete="off"
              spellCheck={false}
              onChange={set('originPort')}
            />
          )}
        </Field>
        <Field label={t('shipmentBooking.field.destinationPort')} hint={t('shipmentBooking.field.portHint')} required={portsRequired}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={form.destinationPort}
              maxLength={5}
              autoComplete="off"
              spellCheck={false}
              onChange={set('destinationPort')}
            />
          )}
        </Field>
        <Field label={t('shipmentBooking.field.pickupDate')}>
          {({ inputId }) => <Input id={inputId} type="date" value={form.pickupDate} onChange={set('pickupDate')} />}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('shipmentBooking.field.windowFrom')}>
            {({ inputId }) => <Input id={inputId} type="time" value={form.pickupWindowFrom} onChange={set('pickupWindowFrom')} />}
          </Field>
          <Field label={t('shipmentBooking.field.windowTo')}>
            {({ inputId }) => <Input id={inputId} type="time" value={form.pickupWindowTo} onChange={set('pickupWindowTo')} />}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={t('shipmentBooking.field.route')}>
            {({ inputId }) => <Input id={inputId} value={form.routeNote} maxLength={500} onChange={set('routeNote')} />}
          </Field>
        </div>
        <div className="space-y-2 sm:col-span-2" data-testid="booking-insurance">
          <h5 className="text-xs font-semibold text-ink">{t('shipmentBooking.insurance.title')}</h5>
          {insurance?.offered === true ? (
            <>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input
                  type="checkbox"
                  checked={form.insured}
                  onChange={(event) => {
                    const checked = event.currentTarget.checked;
                    setForm((prev) => ({ ...prev, insured: checked }));
                  }}
                />
                {t('shipmentBooking.insurance.insure')}
              </label>
              {form.insured && (
                <Field
                  label={t('shipmentBooking.insurance.value', { currency: insuranceCurrency })}
                  hint={t('shipmentBooking.insurance.hint', {
                    rate: basisPointsAsPercent(insurance.basisPoints),
                    max: formatMoneyMinor(insurance.maxInsuredValueMinor, insuranceCurrency),
                  })}
                  required
                >
                  {({ inputId, describedBy }) => (
                    <Input
                      id={inputId}
                      aria-describedby={describedBy}
                      inputMode="decimal"
                      value={form.insuredValue}
                      onChange={set('insuredValue')}
                    />
                  )}
                </Field>
              )}
            </>
          ) : (
            <p className="text-xs text-ink-muted">{t('shipmentBooking.insurance.notOffered')}</p>
          )}
          {booking.terms?.insured === true && booking.terms.insurancePremiumMinor != null && (
            <p className="text-xs text-ink-muted" data-testid="booking-premium">
              {t('shipmentBooking.insurance.premium', {
                amount: formatMoneyMinor(booking.terms.insurancePremiumMinor, booking.terms.insuranceCurrency ?? insuranceCurrency),
              })}
            </p>
          )}
        </div>
      </fieldset>

      <FreightOptionsList shipmentId={booking.shipmentId} />

      {disabled ? (
        <p className="text-xs text-ink-muted">{t('shipmentBooking.locked')}</p>
      ) : (
        <Button type="submit" variant="primary" isLoading={save.isPending}>
          {t('shipmentBooking.save')}
        </Button>
      )}
    </form>
  );
}

/**
 * Why the goods may not leave yet: the inspection release and the
 * destination documents hold. Both are enforced on the server; this only
 * says so before the seller tries.
 */
function DispatchReadinessNote({ booking }: { booking: SellerShipmentBooking }): React.JSX.Element | null {
  const { t } = useI18n();
  const readiness = booking.dispatchReadiness;
  if (readiness === undefined) return null;
  const waitsForInspection = readiness.inspection !== null && !readiness.inspection.open;
  const waitsForDocuments = !readiness.compliance.open;
  if (!waitsForInspection && !waitsForDocuments && !readiness.compliance.overridden) return null;
  return (
    <ul className="space-y-1 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-ink" data-testid="booking-readiness">
      {waitsForInspection && <li>{t('shipmentBooking.readiness.inspection')}</li>}
      {waitsForDocuments && (
        <li>{t('shipmentBooking.readiness.documents', { holds: String(readiness.compliance.holds) })}</li>
      )}
      {readiness.compliance.overridden && readiness.compliance.open && <li>{t('shipmentBooking.readiness.overridden')}</li>}
    </ul>
  );
}

/** The marketplace's rate cards for this route and weight, each with how long its price holds. */
function FreightOptionsList({ shipmentId }: { shipmentId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['seller', 'consignment', shipmentId, 'freight-options'],
    queryFn: () => fetchFreightOptions(shipmentId),
  });
  if (query.data === undefined) return null;
  const freight = query.data;
  return (
    <section className="space-y-2" aria-label={t('shipmentBooking.freight.title')} data-testid="freight-options">
      <h5 className="text-xs font-semibold text-ink">{t('shipmentBooking.freight.title')}</h5>
      <p className="text-xs text-ink-muted">{t('shipmentBooking.freight.intro')}</p>
      {freight.weightGrams === 0 ? (
        <p className="text-xs text-ink-muted">{t('shipmentBooking.freight.noWeight')}</p>
      ) : freight.options.length === 0 ? (
        <p className="text-xs text-ink-muted">{t('shipmentBooking.freight.none')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {freight.options.map((option) => (
            <li key={option.laneId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
              <span className="min-w-0">
                <span className="font-medium text-ink">{option.carrierName}</span>
                <span className="text-xs text-ink-muted">
                  {' · '}
                  {t(`shipmentBooking.mode.${option.mode}`)}
                  {' · '}
                  {t('shipmentBooking.freight.transit', {
                    min: String(option.transitDaysMin),
                    max: String(option.transitDaysMax),
                  })}
                </span>
                <span className="block text-xs text-ink-muted">
                  {option.validTo === null
                    ? t('shipmentBooking.freight.openEnded')
                    : t('shipmentBooking.freight.validUntil', { date: formatDate(option.validTo) })}
                </span>
              </span>
              <span className="font-medium text-ink">{formatMoneyMinor(option.totalMinor, option.currency)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
