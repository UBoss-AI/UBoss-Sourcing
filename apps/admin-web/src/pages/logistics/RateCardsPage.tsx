/**
 * The operator's own rate cards (checklist Master row 71).
 *
 * One card is a route (origin to destination country), a mode, a carrier, a
 * transit window, a currency, a minimum charge, a fuel surcharge and weight
 * bands. "Serviceable" switches a card off without deleting it. The "test a
 * rate" form prices a weight on a route with exactly the function the system
 * uses, so the operator can check a card before anyone relies on it. Sellers'
 * own rate cards live in Seller Hub; these are the operator's.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Callout, Card, CheckboxField, EmptyState, ErrorState, Field, Input, LoadingState, PageHeader, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { currencyExponent, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import { useI18n } from '@/i18n/i18n-context';

const MODES = ['ROAD', 'AIR', 'SEA', 'RAIL', 'COURIER', 'MULTIMODAL'] as const;
type Mode = (typeof MODES)[number];

interface Band {
  minWeightGrams: number;
  maxWeightGrams: number | null;
  amountMinor: string;
  perKgMinor: string;
}

export interface RateCard {
  id: string;
  name: string;
  originCountry: string;
  destinationCountry: string;
  destinationRegion: string;
  mode: Mode;
  carrierName: string;
  serviceLevel: string;
  transitDaysMin: number;
  transitDaysMax: number;
  isServiceable: boolean;
  currency: string;
  minimumChargeMinor: string;
  fuelSurchargeBasisPoints: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
  version: number;
  bands: Band[];
}

interface Quote {
  laneId: string;
  laneName: string;
  carrierName: string;
  mode: Mode;
  transitDaysMin: number;
  transitDaysMax: number;
  currency: string;
  baseMinor: string;
  fuelMinor: string;
  totalMinor: string;
}

interface BandDraft {
  fromKg: string;
  toKg: string;
  amount: string;
  perKg: string;
}

interface Draft {
  name: string;
  originCountry: string;
  destinationCountry: string;
  destinationRegion: string;
  mode: Mode;
  carrierName: string;
  serviceLevel: string;
  transitDaysMin: string;
  transitDaysMax: string;
  currency: string;
  minimumCharge: string;
  fuelPercent: string;
  validFrom: string;
  validTo: string;
  isServiceable: boolean;
  isActive: boolean;
  bands: BandDraft[];
}

/** The draft fields typed as plain text. */
type TextKey = { [K in keyof Draft]: Draft[K] extends string ? K : never }[keyof Draft];

const kg = (grams: number): string => String(grams / 1000);

function draftFrom(card: RateCard | null): Draft {
  const exponent = currencyExponent(card?.currency ?? 'INR');
  return {
    name: card?.name ?? '',
    originCountry: card?.originCountry ?? '',
    destinationCountry: card?.destinationCountry ?? '',
    destinationRegion: card?.destinationRegion ?? '',
    mode: card?.mode ?? 'ROAD',
    carrierName: card?.carrierName ?? '',
    serviceLevel: card?.serviceLevel ?? 'STANDARD',
    transitDaysMin: String(card?.transitDaysMin ?? 1),
    transitDaysMax: String(card?.transitDaysMax ?? 3),
    currency: card?.currency ?? '',
    minimumCharge: card === null ? '0' : minorToMajor(card.minimumChargeMinor, exponent),
    fuelPercent: card === null ? '0' : String(card.fuelSurchargeBasisPoints / 100),
    validFrom: (card?.validFrom ?? new Date().toISOString()).slice(0, 10),
    validTo: (card?.validTo ?? '').slice(0, 10),
    isServiceable: card?.isServiceable ?? true,
    isActive: card?.isActive ?? true,
    bands:
      card === null
        ? [{ fromKg: '0', toKg: '', amount: '', perKg: '0' }]
        : card.bands.map((band) => ({
            fromKg: kg(band.minWeightGrams),
            toKg: band.maxWeightGrams === null ? '' : kg(band.maxWeightGrams),
            amount: minorToMajor(band.amountMinor, exponent),
            perKg: minorToMajor(band.perKgMinor, exponent),
          })),
  };
}

/** Kilograms typed by a person to whole grams, or null when not a number. */
function grams(text: string): number | null {
  if (!/^\d+(\.\d{1,3})?$/.test(text.trim())) return null;
  return Math.round(Number(text.trim()) * 1000);
}

const money = (minor: string, currency: string): string => `${minorToMajor(minor, currencyExponent(currency))} ${currency}`;

export function RateCardsPage(): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const canWrite = can(Permission.LOGISTICS_WRITE);

  const [editing, setEditing] = useState<RateCard | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(draftFrom(null));
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState({ originCountry: '', destinationCountry: '', weightKg: '', mode: '' });
  const [testError, setTestError] = useState<string | null>(null);

  const lanes = useQuery({
    queryKey: ['logistics-lanes'],
    queryFn: () => api.get<{ lanes: RateCard[] }>('/admin/logistics/lanes'),
  });

  const set = (patch: Partial<Draft>): void => {
    setDraft((current) => ({ ...current, ...patch }));
  };
  const setBand = (index: number, patch: Partial<BandDraft>): void => {
    setDraft((current) => ({
      ...current,
      bands: current.bands.map((band, at) => (at === index ? { ...band, ...patch } : band)),
    }));
  };
  const open = (card: RateCard | 'new'): void => {
    setEditing(card);
    setDraft(draftFrom(card === 'new' ? null : card));
    setError(null);
  };

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      editing === 'new' || editing === null
        ? api.post('/admin/logistics/lanes', body)
        : api.put(`/admin/logistics/lanes/${editing.id}`, body),
    onSuccess: async () => {
      toast.success(t('rateCards.saved'));
      setEditing(null);
      await queryClient.invalidateQueries({ queryKey: ['logistics-lanes'] });
    },
    onError: (failure) => {
      setError(errorMessage(t, failure, t('rateCards.saveFailed')));
    },
  });

  const quote = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<{ quotes: Quote[] }>('/admin/logistics/lanes/quote', body),
    onError: (failure) => {
      setTestError(errorMessage(t, failure, t('rateCards.testFailed')));
    },
  });

  const submit = (): void => {
    const currency = draft.currency.trim().toUpperCase();
    const exponent = currencyExponent(currency);
    const minimum = majorToMinor(draft.minimumCharge, exponent);
    const fuel = Number(draft.fuelPercent);
    const bands = draft.bands.map((band) => ({
      minWeightGrams: grams(band.fromKg),
      maxWeightGrams: band.toKg.trim() === '' ? null : grams(band.toKg),
      amountMinor: majorToMinor(band.amount, exponent),
      perKgMinor: majorToMinor(band.perKg === '' ? '0' : band.perKg, exponent),
    }));
    const badBand = draft.bands.some((typed, index) => {
      const band = bands[index];
      return (
        band === undefined ||
        band.minWeightGrams === null ||
        band.amountMinor === null ||
        band.perKgMinor === null ||
        (typed.toKg.trim() !== '' && band.maxWeightGrams === null)
      );
    });
    if (currency.length !== 3 || minimum === null || !Number.isFinite(fuel) || fuel < 0 || fuel > 100 || badBand) {
      setError(t('rateCards.formInvalid'));
      return;
    }
    setError(null);
    save.mutate({
      name: draft.name.trim(),
      originCountry: draft.originCountry.trim(),
      destinationCountry: draft.destinationCountry.trim(),
      destinationRegion: draft.destinationRegion.trim(),
      mode: draft.mode,
      carrierName: draft.carrierName.trim(),
      serviceLevel: draft.serviceLevel.trim() || 'STANDARD',
      transitDaysMin: Number(draft.transitDaysMin),
      transitDaysMax: Number(draft.transitDaysMax),
      isServiceable: draft.isServiceable,
      currency,
      minimumChargeMinor: minimum,
      fuelSurchargeBasisPoints: Math.round(fuel * 100),
      validFrom: new Date(`${draft.validFrom}T00:00:00Z`).toISOString(),
      validTo: draft.validTo === '' ? null : new Date(`${draft.validTo}T00:00:00Z`).toISOString(),
      isActive: draft.isActive,
      bands,
    });
  };

  const runTest = (): void => {
    const weight = grams(test.weightKg);
    if (weight === null || weight <= 0) {
      setTestError(t('rateCards.testWeightInvalid'));
      return;
    }
    setTestError(null);
    quote.mutate({
      originCountry: test.originCountry.trim(),
      destinationCountry: test.destinationCountry.trim(),
      weightGrams: weight,
      ...(test.mode === '' ? {} : { mode: test.mode }),
    });
  };

  const text = (key: TextKey, label: string, extra: { maxLength?: number; required?: boolean; type?: string } = {}) => (
    <Field label={label} {...(extra.required === true ? { required: true } : {})}>
      {({ inputId }) => (
        <Input id={inputId} type={extra.type ?? 'text'} value={draft[key]} {...(extra.maxLength === undefined ? {} : { maxLength: extra.maxLength })} required={extra.required === true}
          onChange={(event) => { set({ [key]: event.target.value }); }} />
      )}
    </Field>
  );

  return (
    <>
      <PageHeader
        title={t('rateCards.title')}
        description={t('rateCards.description')}
        actions={canWrite ? <Button onClick={() => { open('new'); }}>{t('rateCards.add')}</Button> : undefined}
      />

      <div className="space-y-5">
        <Card title={t('rateCards.testTitle')} description={t('rateCards.testDescription')} bodyClassName="space-y-4 px-5 py-4">
          <form
            className="grid gap-4 sm:grid-cols-5"
            aria-label={t('rateCards.testTitle')}
            onSubmit={(event) => {
              event.preventDefault();
              runTest();
            }}
          >
            {(
              [
                ['originCountry', 'rateCards.origin'],
                ['destinationCountry', 'rateCards.destination'],
                ['weightKg', 'rateCards.weightKg'],
              ] as const
            ).map(([key, label]) => (
              <Field key={key} label={t(label)} required>
                {({ inputId }) => (
                  <Input id={inputId} value={test[key]} required maxLength={key === 'weightKg' ? 12 : 2}
                    onChange={(event) => { setTest((current) => ({ ...current, [key]: event.target.value.toUpperCase() })); }} />
                )}
              </Field>
            ))}
            <Field label={t('rateCards.mode')}>
              {({ inputId }) => (
                <Select id={inputId} value={test.mode}
                  onChange={(event) => { setTest((current) => ({ ...current, mode: event.target.value })); }}>
                  <option value="">{t('rateCards.anyMode')}</option>
                  {MODES.map((mode) => (
                    <option key={mode} value={mode}>{t(`rateCards.modes.${mode}`)}</option>
                  ))}
                </Select>
              )}
            </Field>
            <div className="flex items-end">
              <Button type="submit" disabled={quote.isPending}>{t('rateCards.testRun')}</Button>
            </div>
          </form>
          {testError !== null && <Callout tone="danger" role="alert">{testError}</Callout>}
          {quote.isSuccess && quote.data.quotes.length === 0 && (
            <Callout tone="warning">{t('rateCards.testNone')}</Callout>
          )}
          {quote.isSuccess && quote.data.quotes.length > 0 && (
            <ul className="divide-y divide-line" aria-label={t('rateCards.testResults')}>
              {quote.data.quotes.map((row) => (
                <li key={row.laneId} className="flex flex-wrap justify-between gap-2 py-2 text-sm">
                  <span>
                    {row.laneName} · {row.carrierName} · {t(`rateCards.modes.${row.mode}`)} ·{' '}
                    {t('rateCards.transit', { min: row.transitDaysMin, max: row.transitDaysMax })}
                  </span>
                  <span className="tabular font-medium">
                    {money(row.totalMinor, row.currency)}{' '}
                    <span className="text-xs text-ink-muted">
                      ({t('rateCards.fuelPart', { amount: money(row.fuelMinor, row.currency) })})
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {editing !== null && (
          <Card title={editing === 'new' ? t('rateCards.add') : t('rateCards.edit')} bodyClassName="px-5 py-4">
            <form
              className="grid gap-4 sm:grid-cols-3"
              onSubmit={(event) => {
                event.preventDefault();
                submit();
              }}
            >
              {error !== null && (
                <div className="sm:col-span-3">
                  <Callout tone="danger" role="alert">{error}</Callout>
                </div>
              )}
              {text('name', t('rateCards.name'), { maxLength: 160, required: true })}
              {text('originCountry', t('rateCards.origin'), { maxLength: 2, required: true })}
              {text('destinationCountry', t('rateCards.destination'), { maxLength: 2, required: true })}
              {text('destinationRegion', t('rateCards.region'), { maxLength: 64 })}
              <Field label={t('rateCards.mode')}>
                {({ inputId }) => (
                  <Select id={inputId} value={draft.mode} onChange={(event) => { set({ mode: event.target.value as Mode }); }}>
                    {MODES.map((mode) => (
                      <option key={mode} value={mode}>{t(`rateCards.modes.${mode}`)}</option>
                    ))}
                  </Select>
                )}
              </Field>
              {text('carrierName', t('rateCards.carrier'), { maxLength: 120, required: true })}
              {text('serviceLevel', t('rateCards.serviceLevel'), { maxLength: 48 })}
              {text('transitDaysMin', t('rateCards.transitMin'), { type: 'number', required: true })}
              {text('transitDaysMax', t('rateCards.transitMax'), { type: 'number', required: true })}
              {text('currency', t('rateCards.currency'), { maxLength: 3, required: true })}
              {text('minimumCharge', t('rateCards.minimumCharge'))}
              {text('fuelPercent', t('rateCards.fuelPercent'))}
              {text('validFrom', t('rateCards.validFrom'), { type: 'date', required: true })}
              {text('validTo', t('rateCards.validTo'), { type: 'date' })}
              <div className="flex flex-col gap-2 sm:col-span-3">
                <CheckboxField label={t('rateCards.serviceable')} checked={draft.isServiceable}
                  onChange={(event) => { set({ isServiceable: event.target.checked }); }} />
                <CheckboxField label={t('rateCards.active')} checked={draft.isActive}
                  onChange={(event) => { set({ isActive: event.target.checked }); }} />
              </div>

              <fieldset className="space-y-2 sm:col-span-3">
                <legend className="text-sm font-medium text-ink">{t('rateCards.bands')}</legend>
                <p className="text-xs text-ink-muted">{t('rateCards.bandsHint')}</p>
                {draft.bands.map((band, index) => (
                  <div key={index} className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {(
                      [
                        ['fromKg', 'rateCards.bandFrom'],
                        ['toKg', 'rateCards.bandTo'],
                        ['amount', 'rateCards.bandAmount'],
                        ['perKg', 'rateCards.bandPerKg'],
                      ] as const
                    ).map(([key, label]) => (
                      <Field key={key} label={t(label)}>
                        {({ inputId }) => (
                          <Input id={inputId} inputMode="decimal" value={band[key]}
                            onChange={(event) => { setBand(index, { [key]: event.target.value }); }} />
                        )}
                      </Field>
                    ))}
                    <div className="flex items-end">
                      <Button type="button" size="sm" variant="ghost" disabled={draft.bands.length === 1}
                        onClick={() => { set({ bands: draft.bands.filter((_, at) => at !== index) }); }}>
                        {t('rateCards.removeBand')}
                      </Button>
                    </div>
                  </div>
                ))}
                <Button type="button" size="sm" variant="secondary"
                  onClick={() => { set({ bands: [...draft.bands, { fromKg: '', toKg: '', amount: '', perKg: '0' }] }); }}>
                  {t('rateCards.addBand')}
                </Button>
              </fieldset>

              <div className="flex gap-2 sm:col-span-3">
                <Button type="submit" disabled={save.isPending}>{t('rateCards.save')}</Button>
                <Button type="button" variant="secondary" onClick={() => { setEditing(null); }}>{t('rateCards.cancel')}</Button>
              </div>
            </form>
          </Card>
        )}

        <Card title={t('rateCards.listTitle')} bodyClassName="px-5 py-4">
          {lanes.isPending && <LoadingState label={t('rateCards.loading')} />}
          {lanes.isError && <ErrorState error={lanes.error} onRetry={() => { void lanes.refetch(); }} />}
          {lanes.isSuccess && lanes.data.lanes.length === 0 && <EmptyState title={t('rateCards.empty')} />}
          {lanes.isSuccess && lanes.data.lanes.length > 0 && (
            <ul className="divide-y divide-line" aria-label={t('rateCards.listTitle')}>
              {lanes.data.lanes.map((card) => (
                <li key={card.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-1 text-sm">
                    <p className="flex flex-wrap items-center gap-2 font-medium text-ink">
                      <span>{card.name}</span>
                      <span className="tabular text-ink-muted">{card.originCountry} → {card.destinationCountry}</span>
                      <Badge tone="neutral">{t(`rateCards.modes.${card.mode}`)}</Badge>
                      {!card.isServiceable && <Badge tone="warning">{t('rateCards.notServiceable')}</Badge>}
                      {!card.isActive && <Badge tone="neutral">{t('rateCards.inactive')}</Badge>}
                    </p>
                    <p className="text-ink-muted">
                      {card.carrierName} · {t('rateCards.transit', { min: card.transitDaysMin, max: card.transitDaysMax })} ·{' '}
                      {t('rateCards.bandCount', { bands: String(card.bands.length) })} · v{card.version}
                    </p>
                  </div>
                  {canWrite && (
                    <Button size="sm" variant="secondary" onClick={() => { open(card); }}>{t('rateCards.edit')}</Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
