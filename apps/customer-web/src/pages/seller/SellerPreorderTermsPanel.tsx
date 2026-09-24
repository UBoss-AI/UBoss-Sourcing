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
  fetchPolicyChain,
  savePreorderPolicy,
  type PolicyChain,
  type PreorderPolicy,
  type PreorderUnit,
} from '@/lib/preorders';

type Scope = 'OFFER' | 'PRODUCT' | 'SELLER_DEFAULT';

interface Draft {
  isEnabled: boolean;
  moqUnit: PreorderUnit;
  moqQuantity: string;
  incrementQuantity: string;
  maxQuantity: string;
  capacityBaseUnits: string;
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
  moqQuantity: '',
  incrementQuantity: '1',
  maxQuantity: '',
  capacityBaseUnits: '',
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
    moqQuantity: text(policy.moqQuantity),
    incrementQuantity: String(policy.incrementQuantity),
    maxQuantity: text(policy.maxQuantity),
    capacityBaseUnits: text(policy.capacityBaseUnits),
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
  const moq = intOrNull(draft.moqQuantity);
  const step = intOrNull(draft.incrementQuantity);

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
        moqQuantity: moq,
        incrementQuantity: step ?? 1,
        maxQuantity: intOrNull(draft.maxQuantity),
        capacityBaseUnits: intOrNull(draft.capacityBaseUnits),
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
              <p className="mt-1 text-ink-muted">
                {t('sellerPreorderTerms.buyersSee', {
                  minimum: formatNumber(effective.rules.minimumBaseUnits),
                  increment: formatNumber(effective.rules.incrementBaseUnits),
                })}
              </p>
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
              {PREORDER_UNITS.map((unit) => (
                <option key={unit} value={unit} disabled={unit !== 'PIECE' && sizes[unit] === undefined}>
                  {t(`preorder.unit.${unit}` as TranslationKey)}
                  {unit !== 'PIECE' && sizes[unit] !== undefined ? ` (${formatNumber(sizes[unit])})` : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>

        <Field
          label={t('sellerPreorderTerms.moq')}
          {...(moq !== null && unitSize !== null && draft.moqUnit !== 'PIECE'
            ? { hint: t('sellerPreorderTerms.inPieces', { pieces: formatNumber(moq * unitSize) }) }
            : {})}
        >
          {({ inputId, describedBy }) => (
            <Input
              id={inputId}
              aria-describedby={describedBy}
              inputMode="numeric"
              value={draft.moqQuantity}
              onChange={(event) => {
                update({ moqQuantity: event.currentTarget.value.replace(/[^\d]/g, '') });
              }}
            />
          )}
        </Field>

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
          disabled={!tiersValid || (draft.isEnabled && moq === null)}
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
