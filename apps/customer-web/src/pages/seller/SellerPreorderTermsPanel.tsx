/**
 * Preorder terms for one listing.
 *
 * Three levels, most specific first, and the first that exists applies WHOLE:
 *
 *   This version  ->  every version of this product  ->  my default
 *
 * The panel says which one is applying today, and what a buyer is held to in
 * pieces under it - "minimum 12,000 pieces, in steps of 2,400" for a minimum of
 * ten pallets - so a seller setting a pallet minimum sees the piece figure
 * their buyers will see. It never invents a minimum: a level with none set is
 * reported as incomplete, and the product page's Preorder button says
 * preorders are unavailable until it is.
 *
 * Saves on its own, like the packaging panel above it: preorder terms are a
 * separate decision from re-pricing the listing.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input, Select, Spinner, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatMoneyMinor, formatNumber, majorToMinor, minorToMajor } from '@/lib/format';
import {
  PREORDER_UNITS,
  isContainerSize,
  fetchPolicyChain,
  savePreorderPolicy,
  type PolicyChain,
  type PreorderPolicy,
  type PreorderUnit,
  type ProductOption,
} from '@/lib/preorders';
import { MinimumQuantities } from '@/components/preorder/PreorderInfoDialog';

type Scope = 'OFFER' | 'PRODUCT' | 'SELLER_DEFAULT';

interface Draft {
  isEnabled: boolean;
  moqUnit: PreorderUnit;
  originalBrandEnabled: boolean;
  originalBrandMoqQuantity: string;
  oemEnabled: boolean;
  oemMoqQuantity: string;
  incrementQuantity: string;
  maxQuantity: string;
  capacityBaseUnits: string;
  safetyStockBaseUnits: string;
  capacityPeriod: 'DAY' | 'WEEK' | 'MONTH';
  minLeadTimeDays: string;
  maxAdvanceDays: string;
  deliveryCountries: string;
  pricingMode: 'FIXED' | 'QUOTE_REQUIRED';
  allowPartialFulfilment: boolean;
  allowSplitDelivery: boolean;
  requestExpiryHours: string;
  offerExpiryHours: string;
  cancellationTerms: string;
  specialInstructions: string;
  tiers: { minBaseUnits: string; priceMajor: string }[];
}

const EMPTY: Draft = {
  isEnabled: false,
  moqUnit: 'PIECE',
  // Neither is offered until the seller says so.
  originalBrandEnabled: false,
  originalBrandMoqQuantity: '',
  oemEnabled: false,
  oemMoqQuantity: '',
  incrementQuantity: '1',
  maxQuantity: '',
  capacityBaseUnits: '',
  safetyStockBaseUnits: '',
  capacityPeriod: 'MONTH',
  minLeadTimeDays: '',
  maxAdvanceDays: '',
  deliveryCountries: '',
  pricingMode: 'QUOTE_REQUIRED',
  allowPartialFulfilment: false,
  allowSplitDelivery: false,
  requestExpiryHours: '',
  offerExpiryHours: '',
  cancellationTerms: '',
  specialInstructions: '',
  tiers: [],
};

function draftFrom(policy: PreorderPolicy | null, exponent: number): Draft {
  if (policy === null) return EMPTY;
  const text = (value: number | null): string => (value === null ? '' : String(value));
  return {
    isEnabled: policy.isEnabled,
    moqUnit: policy.moqUnit,
    originalBrandEnabled: policy.originalBrandEnabled,
    originalBrandMoqQuantity: text(policy.originalBrandMoqQuantity),
    oemEnabled: policy.oemEnabled,
    oemMoqQuantity: text(policy.oemMoqQuantity),
    incrementQuantity: String(policy.incrementQuantity),
    maxQuantity: text(policy.maxQuantity),
    capacityBaseUnits: text(policy.capacityBaseUnits),
    safetyStockBaseUnits: text(policy.safetyStockBaseUnits ?? null),
    capacityPeriod: policy.capacityPeriod,
    minLeadTimeDays: text(policy.minLeadTimeDays),
    maxAdvanceDays: text(policy.maxAdvanceDays),
    deliveryCountries: policy.deliveryCountries.join(', '),
    pricingMode: policy.pricingMode,
    allowPartialFulfilment: policy.allowPartialFulfilment,
    allowSplitDelivery: policy.allowSplitDelivery,
    requestExpiryHours: text(policy.requestExpiryHours),
    offerExpiryHours: text(policy.offerExpiryHours),
    cancellationTerms: policy.cancellationTerms ?? '',
    specialInstructions: policy.specialInstructions ?? '',
    tiers: policy.tiers.map((tier) => ({
      minBaseUnits: String(tier.minBaseUnits),
      priceMajor: minorToMajor(tier.unitPriceMinor, exponent),
    })),
  };
}

function intOrNull(value: string): number | null {
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}

function policyFor(chain: PolicyChain, scope: Scope): PreorderPolicy | null {
  return scope === 'OFFER' ? chain.offer : scope === 'PRODUCT' ? chain.product : chain.sellerDefault;
}

export function SellerPreorderTermsPanel({
  offerId,
  currency,
  currencyExponent,
}: {
  offerId: string;
  currency: string;
  currencyExponent: number;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();

  const chain = useQuery({
    queryKey: ['seller', 'preorder-policy', offerId],
    queryFn: () => fetchPolicyChain(offerId),
  });

  const [scope, setScope] = useState<Scope>('OFFER');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [touched, setTouched] = useState(false);

  const current = chain.data === undefined ? null : policyFor(chain.data, scope);

  // Load the level being edited whenever it, or what is stored, changes -
  // but never over something the seller is halfway through typing.
  useEffect(() => {
    if (chain.data === undefined || touched) return;
    setDraft(draftFrom(policyFor(chain.data, scope), currencyExponent));
  }, [chain.data, scope, touched, currencyExponent]);

  // Open on the level that applies today, so the form shows what buyers see.
  useEffect(() => {
    if (chain.data?.applies !== null && chain.data?.applies !== undefined) setScope(chain.data.applies);
  }, [chain.data?.applies]);

  const update = (patch: Partial<Draft>): void => {
    setTouched(true);
    setDraft((previous) => ({ ...previous, ...patch }));
  };

  const sizes = chain.data?.unitSizes ?? {};
  const unitSize = draft.moqUnit === 'PIECE' ? 1 : (sizes[draft.moqUnit] ?? null);
  const step = intOrNull(draft.incrementQuantity);
  // At least one option on offer, and every offered option with its own minimum.
  const optionsValid =
    (draft.originalBrandEnabled || draft.oemEnabled) &&
    (!draft.originalBrandEnabled || (intOrNull(draft.originalBrandMoqQuantity) ?? 0) > 0) &&
    (!draft.oemEnabled || (intOrNull(draft.oemMoqQuantity) ?? 0) > 0);

  const tierRows = useMemo(
    () =>
      draft.tiers.map((row) => ({
        minBaseUnits: intOrNull(row.minBaseUnits),
        unitPriceMinor: majorToMinor(row.priceMajor, currencyExponent),
      })),
    [draft.tiers, currencyExponent],
  );
  const tiersValid = tierRows.every((row) => row.minBaseUnits !== null && row.minBaseUnits > 0 && row.unitPriceMinor !== null && row.unitPriceMinor !== '0');

  const save = useMutation({
    mutationFn: () =>
      savePreorderPolicy({
        scope,
        offerId: scope === 'SELLER_DEFAULT' ? null : offerId,
        isEnabled: draft.isEnabled,
        moqUnit: draft.moqUnit,
        originalBrandEnabled: draft.originalBrandEnabled,
        originalBrandMoqQuantity: intOrNull(draft.originalBrandMoqQuantity),
        oemEnabled: draft.oemEnabled,
        oemMoqQuantity: intOrNull(draft.oemMoqQuantity),
        incrementQuantity: step ?? 1,
        maxQuantity: intOrNull(draft.maxQuantity),
        capacityBaseUnits: intOrNull(draft.capacityBaseUnits),
        safetyStockBaseUnits: intOrNull(draft.safetyStockBaseUnits) ?? 0,
        capacityPeriod: draft.capacityPeriod,
        minLeadTimeDays: intOrNull(draft.minLeadTimeDays),
        maxAdvanceDays: intOrNull(draft.maxAdvanceDays),
        deliveryCountries: draft.deliveryCountries
          .split(/[\s,]+/)
          .map((code) => code.trim().toUpperCase())
          .filter((code) => /^[A-Z]{2}$/.test(code)),
        eligibleLocationIds: current?.eligibleLocationIds ?? [],
        packagingTypes: null,
        pricingMode: draft.pricingMode,
        allowPartialFulfilment: draft.allowPartialFulfilment,
        allowSplitDelivery: draft.allowSplitDelivery,
        requestExpiryHours: intOrNull(draft.requestExpiryHours),
        offerExpiryHours: intOrNull(draft.offerExpiryHours),
        cancellationTerms: draft.cancellationTerms.trim() === '' ? null : draft.cancellationTerms.trim(),
        specialInstructions: draft.specialInstructions.trim() === '' ? null : draft.specialInstructions.trim(),
        tiers: tierRows.map((row) => ({ minBaseUnits: row.minBaseUnits ?? 0, unitPriceMinor: row.unitPriceMinor ?? '0' })),
        expectedVersion: current?.version ?? null,
      }),
    onSuccess: () => {
      setTouched(false);
      toast.success(t('sellerPreorderTerms.saved'));
      void queryClient.invalidateQueries({ queryKey: ['seller', 'preorder-policy', offerId] });
    },
    onError: (error) => { toast.error(errorMessage(t, error)); },
  });

  if (chain.isPending) {
    return (
      <Card title={t('sellerPreorderTerms.title')}>
        <Spinner />
      </Card>
    );
  }

  if (chain.isError) {
    return (
      <Card title={t('sellerPreorderTerms.title')}>
        <p className="text-sm text-danger">{errorMessage(t, chain.error)}</p>
      </Card>
    );
  }

  const effective = chain.data.effective ?? null;

  return (
    <Card title={t('sellerPreorderTerms.title')} description={t('sellerPreorderTerms.description')}>
      {/* What buyers are held to today. */}
      <div role="status" className="mb-4 rounded-md border border-border-subtle bg-surface-sunken p-3 text-sm">
        {chain.data.applies === null ? (
          <p className="text-ink">
            {chain.data.platformDefault === true
              ? t('sellerPreorderTerms.platformDefaultApplies')
              : t('sellerPreorderTerms.noneApply')}
          </p>
        ) : (
          <>
            <p className="text-ink">
              {t('sellerPreorderTerms.applying', {
                level: t(`sellerPreorderTerms.scope.${chain.data.applies}` as TranslationKey),
              })}
            </p>
            {effective?.rules !== null && effective?.rules !== undefined ? (
              <>
                <p className="mt-1 text-ink-muted">
                  {t('sellerPreorderTerms.buyersSeeStep', {
                    increment: formatNumber(effective.rules.incrementBaseUnits),
                  })}
                </p>
                {(chain.data.productOptions ?? null) !== null && (
                  <div className="mt-2">
                    <MinimumQuantities options={chain.data.productOptions ?? []} />
                  </div>
                )}
              </>
            ) : (
              <ul className="mt-1 list-disc pl-5 text-warning">
                {(effective?.issues ?? []).map((issue) => (
                  <li key={issue.field}>{issue.message}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {current?.productOptionsReviewRequired === true && (
        <p
          role="note"
          className="mb-4 rounded-md border border-warning/40 bg-warning-soft px-3 py-2 text-sm text-ink"
        >
          {t('sellerPreorderTerms.options.reviewRequired')}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('sellerPreorderTerms.editing')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={scope}
              onChange={(event) => {
                setTouched(false);
                setScope(event.currentTarget.value as Scope);
              }}
            >
              {(['OFFER', 'PRODUCT', 'SELLER_DEFAULT'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`sellerPreorderTerms.scope.${value}` as TranslationKey)}
                  {policyFor(chain.data, value) === null ? ` — ${t('sellerPreorderTerms.notSet')}` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <label className="flex items-center gap-2 self-end pb-2 text-sm font-medium text-ink">
          <input
            type="checkbox"
            className="size-4 rounded border-border"
            checked={draft.isEnabled}
            onChange={(event) => {
              update({ isEnabled: event.currentTarget.checked });
            }}
          />
          {t('sellerPreorderTerms.enabled')}
          {current !== null && <Badge tone={current.isEnabled ? 'success' : 'neutral'}>v{current.version}</Badge>}
        </label>

        <Field label={t('sellerPreorderTerms.moqUnit')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={draft.moqUnit}
              onChange={(event) => {
                update({ moqUnit: event.currentTarget.value as PreorderUnit });
              }}
            >
              {PREORDER_UNITS.filter((unit) => !isContainerSize(unit)).map((unit) => (
                <option key={unit} value={unit} disabled={unit !== 'PIECE' && sizes[unit] === undefined}>
                  {t(`preorder.unit.${unit}` as TranslationKey)}
                  {unit !== 'PIECE' && sizes[unit] !== undefined ? ` (${formatNumber(sizes[unit])})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {/*
          B2B preorder minimums: OEM and Original Brand, each its own card with
          its own switch and minimum. Separate from the B2C purchase limit, the
          ordinary purchase minimum, stock and bulk price bands.
        */}
        <fieldset className="space-y-3 sm:col-span-2">
          <legend className="flex flex-wrap items-center gap-2 text-sm font-semibold text-ink">
            {t('sellerPreorderTerms.options.legend')}
            <Badge tone="brand">B2B</Badge>
          </legend>
          <p className="text-xs text-ink-muted">{t('sellerPreorderTerms.options.help')}</p>
          <div className="grid gap-3 md:grid-cols-2">
            {(['OEM', 'ORIGINAL_BRAND'] as const).map((option: ProductOption) => {
              const enabledKey = option === 'OEM' ? 'oemEnabled' : 'originalBrandEnabled';
              const moqKey = option === 'OEM' ? 'oemMoqQuantity' : 'originalBrandMoqQuantity';
              const enabled = draft[enabledKey];
              const minimum = intOrNull(draft[moqKey]);
              const missing = enabled && draft.isEnabled && minimum === null;
              const unitName = t(`preorder.unit.${draft.moqUnit}` as TranslationKey);
              const switchId = `preorder-option-${option}`;
              return (
                <div
                  key={option}
                  className={
                    enabled
                      ? 'relative flex flex-col gap-3 rounded-xl border border-brand/40 bg-surface p-4 shadow-[0_1px_0_rgb(255_255_255/0.06)_inset,0_8px_24px_-12px_rgb(var(--brand)/0.45)] ring-1 ring-brand/20 transition'
                      : 'relative flex flex-col gap-3 rounded-xl border border-dashed border-border bg-surface-sunken p-4 transition'
                  }
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <label htmlFor={switchId} className="text-base font-semibold text-ink">
                          {t(`preorder.option.${option}` as TranslationKey)}
                        </label>
                        <Badge tone={enabled ? (missing ? 'warning' : 'success') : 'neutral'}>
                          {enabled
                            ? missing
                              ? t('sellerPreorderTerms.options.needsMinimum')
                              : t('sellerPreorderTerms.options.offered')
                            : t('sellerPreorderTerms.options.notOffered')}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {t(`preorder.option.${option}.hint` as TranslationKey)}
                      </p>
                    </div>
                    {/* A switch: a real checkbox, so keyboard and screen readers get it for free. */}
                    <span className="relative inline-flex shrink-0 items-center">
                      <input
                        id={switchId}
                        type="checkbox"
                        role="switch"
                        aria-label={t(`sellerPreorderTerms.options.offer.${option}` as TranslationKey)}
                        className="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
                        checked={enabled}
                        onChange={(event) => {
                          update({ [enabledKey]: event.currentTarget.checked });
                        }}
                      />
                      <span
                        aria-hidden="true"
                        className="h-6 w-11 rounded-full bg-border-strong transition peer-checked:bg-brand peer-focus-visible:ring-2 peer-focus-visible:ring-brand peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-surface"
                      />
                      <span
                        aria-hidden="true"
                        className="pointer-events-none absolute left-0.5 top-0.5 size-5 rounded-full bg-white shadow transition peer-checked:translate-x-5"
                      />
                    </span>
                  </div>

                  <Field
                    label={t('sellerPreorderTerms.options.minimum', {
                      option: t(`preorder.option.${option}` as TranslationKey),
                      unit: unitName,
                    })}
                    {...(missing
                      ? { error: t('sellerPreorderTerms.options.minimumRequired') }
                      : minimum !== null && unitSize !== null && draft.moqUnit !== 'PIECE'
                        ? { hint: t('sellerPreorderTerms.inPieces', { pieces: formatNumber(minimum * unitSize) }) }
                        : {})}
                  >
                    {({ inputId, describedBy }) => (
                      <div className="relative">
                        <Input
                          id={inputId}
                          aria-describedby={describedBy}
                          inputMode="numeric"
                          disabled={!enabled}
                          className="pr-24 text-lg font-semibold tabular-nums"
                          value={draft[moqKey]}
                          onChange={(event) => {
                            // Whole units only: the seller's unit has no fractions.
                            update({ [moqKey]: event.currentTarget.value.replace(/[^\d]/g, '') });
                          }}
                        />
                        <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs font-medium text-ink-muted">
                          {unitName}
                        </span>
                      </div>
                    )}
                  </Field>
                </div>
              );
            })}
          </div>
          <p className="text-xs text-ink-muted">{t('sellerPreorderTerms.options.separateFromB2c')}</p>
        </fieldset>

        <Field label={t('sellerPreorderTerms.increment')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              value={draft.incrementQuantity}
              onChange={(event) => {
                update({ incrementQuantity: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.max')} hint={t('preorder.optional')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              value={draft.maxQuantity}
              onChange={(event) => {
                update({ maxQuantity: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.capacity')} hint={t('sellerPreorderTerms.capacityHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="numeric"
              value={draft.capacityBaseUnits}
              onChange={(event) => {
                update({ capacityBaseUnits: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.safetyStock')} hint={t('sellerPreorderTerms.safetyStockHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="numeric"
              value={draft.safetyStockBaseUnits}
              onChange={(event) => {
                update({ safetyStockBaseUnits: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.capacityPeriod')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={draft.capacityPeriod}
              onChange={(event) => {
                update({ capacityPeriod: event.currentTarget.value as Draft['capacityPeriod'] });
              }}
            >
              {(['DAY', 'WEEK', 'MONTH'] as const).map((period) => (
                <option key={period} value={period}>
                  {t(`sellerPreorderTerms.period.${period}` as TranslationKey)}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.leadTime')} hint={t('sellerPreorderTerms.days')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              value={draft.minLeadTimeDays}
              onChange={(event) => {
                update({ minLeadTimeDays: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.maxAdvance')} hint={t('sellerPreorderTerms.days')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              value={draft.maxAdvanceDays}
              onChange={(event) => {
                update({ maxAdvanceDays: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.countries')} hint={t('sellerPreorderTerms.countriesHint')}>
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              value={draft.deliveryCountries}
              onChange={(event) => {
                update({ deliveryCountries: event.currentTarget.value });
              }}
            />
          )}
        </Field>

        <Field label={t('sellerPreorderTerms.pricingMode')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={draft.pricingMode}
              onChange={(event) => {
                update({ pricingMode: event.currentTarget.value as Draft['pricingMode'] });
              }}
            >
              <option value="QUOTE_REQUIRED">{t('sellerPreorders.quoted')}</option>
              <option value="FIXED">{t('sellerPreorders.fixed')}</option>
            </Select>
          )}
        </Field>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="size-4 rounded border-border"
            checked={draft.allowPartialFulfilment}
            onChange={(event) => {
              update({ allowPartialFulfilment: event.currentTarget.checked });
            }}
          />
          {t('sellerPreorderTerms.partial')}
        </label>
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            type="checkbox"
            className="size-4 rounded border-border"
            checked={draft.allowSplitDelivery}
            onChange={(event) => {
              update({ allowSplitDelivery: event.currentTarget.checked });
            }}
          />
          {t('sellerPreorderTerms.split')}
        </label>

        <Field label={t('sellerPreorderTerms.requestExpiry')} hint={t('sellerPreorderTerms.hours')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              value={draft.requestExpiryHours}
              onChange={(event) => {
                update({ requestExpiryHours: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>
        <Field label={t('sellerPreorderTerms.offerExpiry')} hint={t('sellerPreorderTerms.hours')}>
          {({ inputId }) => (
            <Input
              id={inputId}
              inputMode="numeric"
              value={draft.offerExpiryHours}
              onChange={(event) => {
                update({ offerExpiryHours: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

        <div className="sm:col-span-2">
          <Field label={t('sellerPreorderTerms.cancellation')} hint={t('preorder.optional')}>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={2}
                maxLength={1000}
                value={draft.cancellationTerms}
                onChange={(event) => {
                  update({ cancellationTerms: event.currentTarget.value });
                }}
              />
            )}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={t('sellerPreorderTerms.instructions')} hint={t('preorder.optional')}>
            {({ inputId }) => (
              <Textarea
                id={inputId}
                rows={2}
                maxLength={1000}
                value={draft.specialInstructions}
                onChange={(event) => {
                  update({ specialInstructions: event.currentTarget.value });
                }}
              />
            )}
          </Field>
        </div>
      </div>

      {/* Price bands, used under fixed pricing. */}
      <div className="mt-4 space-y-2">
        <p className="text-sm font-medium text-ink">{t('sellerPreorderTerms.bands', { currency })}</p>
        {draft.tiers.map((row, index) => (
          <div key={index} className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
            <Field label={t('sellerPreorderTerms.bandFrom')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="numeric"
                  value={row.minBaseUnits}
                  onChange={(event) => {
                    const value = event.currentTarget.value.replace(/[^\d]/g, '');
                    update({ tiers: draft.tiers.map((tier, at) => (at === index ? { ...tier, minBaseUnits: value } : tier)) });
                  }}
                />
              )}
            </Field>
            <Field label={t('sellerPreorderTerms.bandPrice')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  value={row.priceMajor}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    update({ tiers: draft.tiers.map((tier, at) => (at === index ? { ...tier, priceMajor: value } : tier)) });
                  }}
                />
              )}
            </Field>
            <Button
              variant="ghost"
              onClick={() => {
                update({ tiers: draft.tiers.filter((_, at) => at !== index) });
              }}
            >
              {t('sellerPreorders.remove')}
            </Button>
          </div>
        ))}
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            update({ tiers: [...draft.tiers, { minBaseUnits: '', priceMajor: '' }] });
          }}
        >
          {t('sellerPreorderTerms.addBand')}
        </Button>
        {tierRows.length > 0 && tiersValid && (
          <ul className="text-xs text-ink-muted">
            {tierRows
              .slice()
              .sort((a, b) => (a.minBaseUnits ?? 0) - (b.minBaseUnits ?? 0))
              .map((row) => (
                <li key={row.minBaseUnits}>
                  {t('preorder.bandLine', {
                    pieces: formatNumber(row.minBaseUnits ?? 0),
                    price: formatMoneyMinor(row.unitPriceMinor ?? '0', currency),
                  })}
                </li>
              ))}
          </ul>
        )}
      </div>

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button
          variant="primary"
          disabled={!tiersValid || (draft.isEnabled && !optionsValid)}
          isLoading={save.isPending}
          onClick={() => {
            save.mutate();
          }}
        >
          {t('sellerPreorderTerms.save')}
        </Button>
      </div>
    </Card>
  );
}
