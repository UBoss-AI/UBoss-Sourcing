/**
 * Adding or changing the price of one delivery level on one route.
 *
 * The fields are the ones THIS level uses - a port of loading for L1, two
 * ports for L2, a destination warehouse for L3, a delivery area for L4 - and
 * the price is the last field, as the brief asks, with its currency, whether
 * it includes tax, and whether the level is free.
 *
 * EMPTY IS NOT ZERO. A blank price saves a draft that is "not priced yet"; it
 * never becomes a free level. Free is its own tick box, and it needs a second
 * tick confirming it, because a blank field read as zero is international
 * freight nobody agreed to give away.
 *
 * Changing a PUBLISHED price saves a new version that replaces it when
 * published. Orders already placed keep the price they were charged.
 */
import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Button, Field, Input, Select } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, majorToMinor, minorToMajor } from '@/lib/format';
import {
  createRate,
  fetchLogisticsPartners,
  updateRate,
  type LogisticsLevel,
  type ManagedProvider,
  type PolicyView,
  type RateInput,
  type RateView,
  type TransportMode,
} from '@/lib/seller-logistics';

const LEVEL_MODES: Record<LogisticsLevel, TransportMode[]> = {
  L1: ['ROAD', 'RAIL'],
  L2: ['AIR', 'SEA', 'ROAD', 'RAIL', 'POSTAL'],
  L3: ['ROAD', 'RAIL'],
  L4: ['ROAD', 'POSTAL'],
};

interface FormState {
  originLocationId: string;
  originPortCode: string;
  destinationPortCode: string;
  destinationHubCode: string;
  destinationHubName: string;
  destinationCountry: string;
  destinationPostalPrefix: string;
  isWorldwideFlat: boolean;
  transportMode: TransportMode;
  /** 'DHL' | 'FEDEX' | 'INDIA_POST' | 'MANUAL' | 'partner:<id>' | '' */
  carrier: string;
  providerLabel: string;
  serviceName: string;
  trackingReferenceKind: '' | 'AWB' | 'BOL' | 'CONTAINER' | 'TRACKING';
  requiresCustomsRelease: boolean;
  transitDaysMin: string;
  transitDaysMax: string;
  price: string;
  currency: string;
  taxInclusive: boolean;
  isFree: boolean;
  confirmFree: boolean;
  effectiveFrom: string;
}

function initialState(level: LogisticsLevel, rate: RateView | null, currency: string): FormState {
  const exponent = currencyExponent(rate?.currency ?? currency);
  return {
    originLocationId: rate?.originLocationId ?? '',
    originPortCode: rate?.originPortCode ?? '',
    destinationPortCode: rate?.destinationPortCode ?? '',
    destinationHubCode: rate?.destinationHubCode ?? '',
    destinationHubName: rate?.destinationHubName ?? '',
    destinationCountry: rate?.destinationCountry ?? '',
    destinationPostalPrefix: rate?.destinationPostalPrefix ?? '',
    isWorldwideFlat: rate?.isWorldwideFlat ?? false,
    transportMode: rate?.transportMode ?? LEVEL_MODES[level][0] ?? 'ROAD',
    carrier:
      rate === null
        ? ''
        : rate.logisticsPartnerId !== null
          ? `partner:${rate.logisticsPartnerId}`
          : (rate.provider ?? ''),
    providerLabel: rate?.provider === 'MANUAL' ? (rate.providerLabel ?? '') : '',
    serviceName: rate?.serviceName ?? '',
    trackingReferenceKind: (rate?.trackingReferenceKind ?? '') as FormState['trackingReferenceKind'],
    requiresCustomsRelease: rate?.requiresCustomsRelease ?? false,
    transitDaysMin: rate?.transitDaysMin === null || rate?.transitDaysMin === undefined ? '' : String(rate.transitDaysMin),
    transitDaysMax: rate?.transitDaysMax === null || rate?.transitDaysMax === undefined ? '' : String(rate.transitDaysMax),
    price: rate?.price === null || rate?.price === undefined || rate.isFree ? '' : minorToMajor(rate.price.minor, exponent),
    currency: rate?.currency ?? currency,
    taxInclusive: rate?.taxInclusive ?? false,
    isFree: rate?.isFree ?? false,
    confirmFree: rate?.isFree ?? false,
    effectiveFrom: (rate?.effectiveFrom ?? new Date().toISOString()).slice(0, 10),
  };
}

export function LogisticsRateDialog({
  level,
  rate,
  policy,
  onClose,
  onSaved,
}: {
  level: LogisticsLevel;
  rate: RateView | null;
  policy: PolicyView;
  onClose: () => void;
  onSaved: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const { currencies } = useLocale();
  const formId = useId();
  const [form, setForm] = useState<FormState>(() => initialState(level, rate, policy.settlementCurrency));
  const [priceError, setPriceError] = useState<string | undefined>(undefined);

  const partners = useQuery({ queryKey: ['seller', 'logistics', 'partners'], queryFn: fetchLogisticsPartners });
  const enabledProviders = policy.providers.filter((provider) => provider.enabled);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((current) => ({ ...current, [key]: value }));
  }

  const save = useMutation({
    mutationFn: (input: RateInput) => (rate === null || rate.status === 'INACTIVE' ? createRate(input) : updateRate(rate.id, input)),
    onSuccess: () => {
      toast.success(t('sellerLogistics.rateSaved'));
      onSaved();
    },
    onError: (error: unknown) => {
      toast.error(errorMessage(t, error, t('sellerLogistics.rateFailed')));
    },
  });

  function submit(event: React.SyntheticEvent<HTMLFormElement>): void {
    event.preventDefault();
    setPriceError(undefined);

    let amountMinor: string | null = null;
    if (!form.isFree && form.price.trim() !== '') {
      amountMinor = majorToMinor(form.price, currencyExponent(form.currency));
      if (amountMinor === null) {
        setPriceError(t('sellerLogistics.priceInvalid'));
        return;
      }
    }

    const partnerId = form.carrier.startsWith('partner:') ? form.carrier.slice('partner:'.length) : null;
    const provider = partnerId === null && form.carrier !== '' ? (form.carrier as ManagedProvider) : null;
    const toNumber = (value: string): number | null => (value.trim() === '' ? null : Number.parseInt(value, 10));

    save.mutate({
      level,
      originLocationId: level === 'L1' && form.originLocationId !== '' ? form.originLocationId : null,
      originPortCode: level === 'L1' || level === 'L2' ? emptyToNull(form.originPortCode) : null,
      destinationPortCode: level === 'L2' || level === 'L3' ? emptyToNull(form.destinationPortCode) : null,
      destinationHubCode: level === 'L3' || level === 'L4' ? emptyToNull(form.destinationHubCode) : null,
      destinationHubName: level === 'L3' ? emptyToNull(form.destinationHubName) : null,
      destinationCountry: level === 'L1' ? null : emptyToNull(form.destinationCountry.toUpperCase()),
      destinationPostalPrefix: level === 'L4' ? emptyToNull(form.destinationPostalPrefix) : null,
      isWorldwideFlat: level !== 'L1' && form.destinationCountry.trim() === '' && form.isWorldwideFlat,
      transportMode: form.transportMode,
      provider,
      logisticsPartnerId: partnerId,
      providerLabel: provider === 'MANUAL' ? emptyToNull(form.providerLabel) : null,
      serviceName: emptyToNull(form.serviceName),
      trackingReferenceKind: level === 'L2' && form.trackingReferenceKind !== '' ? form.trackingReferenceKind : null,
      requiresCustomsRelease: level === 'L3' && form.requiresCustomsRelease,
      transitDaysMin: toNumber(form.transitDaysMin),
      transitDaysMax: toNumber(form.transitDaysMax),
      amountMinor,
      currency: form.currency,
      isFree: form.isFree,
      confirmFree: form.isFree && form.confirmFree,
      taxInclusive: form.taxInclusive,
      effectiveFrom: form.effectiveFrom === '' ? null : new Date(`${form.effectiveFrom}T00:00:00`).toISOString(),
    });
  }

  const showsDestination = level !== 'L1';

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={t(rate === null ? 'sellerLogistics.addPriceTitle' : 'sellerLogistics.changePriceTitle', {
        level: t(`sellerLogistics.level.${level}.name`),
      })}
      description={
        rate?.status === 'PUBLISHED' ? t('sellerLogistics.newVersionNote') : t(`sellerLogistics.level.${level}.route`)
      }
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} isLoading={save.isPending}>
            {t('sellerLogistics.saveDraftPrice')}
          </Button>
        </div>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4" noValidate>
        {/* --- Route ------------------------------------------------------- */}
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-ink">{t('sellerLogistics.routeLegend')}</legend>

          {level === 'L1' && (
            <Field label={t('sellerLogistics.field.originLocation')} hint={t('sellerLogistics.hint.originLocation')}>
              {({ inputId, describedBy }) => (
                <Select id={inputId} aria-describedby={describedBy} value={form.originLocationId} onChange={(event) => { set('originLocationId', event.target.value); }}>
                  <option value="">{t('sellerLogistics.anyWarehouse')}</option>
                  {policy.locations.map((location) => (
                    <option key={location.id} value={location.id}>
                      {location.name} ({location.code})
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}

          {(level === 'L1' || level === 'L2') && (
            <Field label={t('sellerLogistics.field.loadingPort')} hint={t('sellerLogistics.hint.portCode')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={form.originPortCode} maxLength={5} placeholder="INNSA" onChange={(event) => { set('originPortCode', event.target.value.toUpperCase()); }} />
              )}
            </Field>
          )}

          {(level === 'L2' || level === 'L3') && (
            <Field label={t('sellerLogistics.field.destinationPort')} hint={t('sellerLogistics.hint.portCode')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={form.destinationPortCode} maxLength={5} placeholder="NLRTM" onChange={(event) => { set('destinationPortCode', event.target.value.toUpperCase()); }} />
              )}
            </Field>
          )}

          {(level === 'L3' || level === 'L4') && (
            <Field label={t('sellerLogistics.field.destinationHub')} hint={t('sellerLogistics.hint.destinationHub')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={form.destinationHubCode} maxLength={64} placeholder="RTM-DC" onChange={(event) => { set('destinationHubCode', event.target.value.toUpperCase()); }} />
              )}
            </Field>
          )}

          {level === 'L3' && (
            <Field label={t('sellerLogistics.field.destinationHubName')}>
              {({ inputId }) => (
                <Input id={inputId} value={form.destinationHubName} maxLength={160} onChange={(event) => { set('destinationHubName', event.target.value); }} />
              )}
            </Field>
          )}

          {showsDestination && (
            <Field label={t('sellerLogistics.field.destinationCountry')} hint={t('sellerLogistics.hint.destinationCountry')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={form.destinationCountry} maxLength={2} placeholder="NL" onChange={(event) => { set('destinationCountry', event.target.value.toUpperCase()); }} />
              )}
            </Field>
          )}

          {level === 'L4' && (
            <Field label={t('sellerLogistics.field.postalPrefix')} hint={t('sellerLogistics.hint.postalPrefix')}>
              {({ inputId, describedBy }) => (
                <Input id={inputId} aria-describedby={describedBy} value={form.destinationPostalPrefix} maxLength={16} onChange={(event) => { set('destinationPostalPrefix', event.target.value); }} />
              )}
            </Field>
          )}

          {showsDestination && form.destinationCountry.trim() === '' && (
            <label className="flex items-start gap-2 text-sm text-ink sm:col-span-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.isWorldwideFlat} onChange={(event) => { set('isWorldwideFlat', event.target.checked); }} />
              <span>
                {t('sellerLogistics.field.worldwideFlat')}
                <span className="block text-xs text-ink-muted">{t('sellerLogistics.hint.worldwideFlat')}</span>
              </span>
            </label>
          )}
        </fieldset>

        {/* --- Carrier ----------------------------------------------------- */}
        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-semibold text-ink">{t('sellerLogistics.carrierLegend')}</legend>

          <Field label={t('sellerLogistics.field.transportMode')}>
            {({ inputId }) => (
              <Select id={inputId} value={form.transportMode} onChange={(event) => { set('transportMode', event.target.value as TransportMode); }}>
                {LEVEL_MODES[level].map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`sellerLogistics.transport.${mode}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field label={t('sellerLogistics.field.carrier')} {...(enabledProviders.length === 0 ? { hint: t('sellerLogistics.hint.noCarriers') } : {})}>
            {({ inputId, describedBy }) => (
              <Select id={inputId} aria-describedby={describedBy} value={form.carrier} onChange={(event) => { set('carrier', event.target.value); }}>
                <option value="">{t('sellerLogistics.chooseCarrier')}</option>
                {enabledProviders.map((provider) => (
                  <option key={provider.provider} value={provider.provider}>
                    {t(`sellerLogistics.provider.${provider.provider}.name`)} · {t(`sellerLogistics.connection.${provider.connectionState}`)}
                  </option>
                ))}
                {(partners.data?.partners ?? []).map((partner) => (
                  <option key={partner.id} value={`partner:${partner.id}`}>
                    {partner.displayName}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          {form.carrier === 'MANUAL' && (
            <Field label={t('sellerLogistics.field.forwarderName')}>
              {({ inputId }) => (
                <Input id={inputId} value={form.providerLabel} maxLength={160} onChange={(event) => { set('providerLabel', event.target.value); }} />
              )}
            </Field>
          )}

          <Field label={t('sellerLogistics.field.serviceName')}>
            {({ inputId }) => (
              <Input id={inputId} value={form.serviceName} maxLength={120} onChange={(event) => { set('serviceName', event.target.value); }} />
            )}
          </Field>

          {level === 'L2' && (
            <Field label={t('sellerLogistics.field.trackingKind')}>
              {({ inputId }) => (
                <Select id={inputId} value={form.trackingReferenceKind} onChange={(event) => { set('trackingReferenceKind', event.target.value as FormState['trackingReferenceKind']); }}>
                  <option value="">—</option>
                  <option value="AWB">{t('sellerLogistics.trackingKind.AWB')}</option>
                  <option value="BOL">{t('sellerLogistics.trackingKind.BOL')}</option>
                  <option value="CONTAINER">{t('sellerLogistics.trackingKind.CONTAINER')}</option>
                </Select>
              )}
            </Field>
          )}

          {level === 'L3' && (
            <label className="flex items-start gap-2 text-sm text-ink sm:col-span-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.requiresCustomsRelease} onChange={(event) => { set('requiresCustomsRelease', event.target.checked); }} />
              <span>{t('sellerLogistics.field.customsRelease')}</span>
            </label>
          )}

          <Field label={t('sellerLogistics.field.transitMin')}>
            {({ inputId }) => (
              <Input id={inputId} type="number" min={0} max={365} inputMode="numeric" value={form.transitDaysMin} onChange={(event) => { set('transitDaysMin', event.target.value); }} />
            )}
          </Field>
          <Field label={t('sellerLogistics.field.transitMax')}>
            {({ inputId }) => (
              <Input id={inputId} type="number" min={0} max={365} inputMode="numeric" value={form.transitDaysMax} onChange={(event) => { set('transitDaysMax', event.target.value); }} />
            )}
          </Field>
        </fieldset>

        {/* --- Price, at the bottom ----------------------------------------- */}
        <fieldset className="grid gap-4 rounded-md border border-border-subtle p-4 sm:grid-cols-2">
          <legend className="px-1 text-sm font-semibold text-ink">{t('sellerLogistics.field.price')}</legend>

          <Field label={t('sellerLogistics.field.price')} hint={t('sellerLogistics.hint.price')} error={priceError}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                inputMode="decimal"
                value={form.price}
                disabled={form.isFree}
                invalid={priceError !== undefined}
                onChange={(event) => {
                  set('price', event.target.value);
                }}
              />
            )}
          </Field>

          <Field label={t('sellerLogistics.field.currency')}>
            {({ inputId }) => (
              <Select id={inputId} value={form.currency} onChange={(event) => { set('currency', event.target.value); }}>
                {[...new Set([policy.settlementCurrency, ...currencies.map((currency) => currency.code)])].map((code) => (
                  <option key={code} value={code}>
                    {code}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <label className="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" className="h-4 w-4" checked={form.taxInclusive} disabled={form.isFree} onChange={(event) => { set('taxInclusive', event.target.checked); }} />
            {t('sellerLogistics.field.taxInclusive')}
          </label>

          <Field label={t('sellerLogistics.field.effectiveFrom')}>
            {({ inputId }) => (
              <Input id={inputId} type="date" value={form.effectiveFrom} onChange={(event) => { set('effectiveFrom', event.target.value); }} />
            )}
          </Field>

          <div className="space-y-2 sm:col-span-2">
            <label className="flex items-center gap-2 text-sm text-ink">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={form.isFree}
                onChange={(event) => {
                  setForm((current) => ({ ...current, isFree: event.target.checked, confirmFree: false, price: '' }));
                }}
              />
              {t('sellerLogistics.field.free')}
            </label>
            {form.isFree && (
              <label className="flex items-start gap-2 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={form.confirmFree} onChange={(event) => { set('confirmFree', event.target.checked); }} />
                {t('sellerLogistics.field.confirmFree')}
              </label>
            )}
            <p className="text-xs text-ink-muted">
              {t('sellerLogistics.priceSourceNote', { source: t('sellerLogistics.priceSource.MANUAL') })}
            </p>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
