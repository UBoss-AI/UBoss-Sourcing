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
import {
  BOOKING_CARRIERS,
  INCOTERMS,
  TRANSPORT_MODES,
  fetchShipmentBooking,
  saveShipmentBooking,
  type BookingInput,
  type SellerShipmentBooking,
} from '@/lib/shipment-paperwork';

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
}

function formFrom(booking: SellerShipmentBooking): FormState {
  const terms = booking.terms;
  return {
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

  const save = useMutation({
    mutationFn: () => {
      const input: BookingInput = {
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
      </fieldset>

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
