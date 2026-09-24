/**
 * Quantity price bands on one listing: "from 500 pieces, 9.20 each".
 *
 * These are what the basket charges a loose quantity and what the product
 * page's bulk-savings popover shows buyers - the same function prices both.
 * Saved as one set, because a band only means something beside the others;
 * the server checks the whole set and this panel shows each problem against
 * the band it belongs to.
 *
 * Prices are typed in major units and sent as minor-unit strings by digit
 * shifting (`majorToMinor`) - never through a float.
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { ApiError } from '@/lib/api';
import { formatBasisPoints } from '@/lib/bulk-pricing';
import { errorMessage } from '@/lib/errors';
import { majorToMinor, minorToMajor } from '@/lib/format';
import {
  fetchQuantityTiers,
  saveQuantityTiers,
  type QuantityTierInput,
} from '@/lib/quantity-tiers';

interface DraftBand {
  minQuantity: string;
  maxQuantity: string;
  price: string;
  isActive: boolean;
  startsAt: string;
  endsAt: string;
  businessBuyersOnly: boolean;
  countries: string;
  preorderOnly: boolean;
}

const EMPTY_BAND: DraftBand = {
  minQuantity: '',
  maxQuantity: '',
  price: '',
  isActive: true,
  startsAt: '',
  endsAt: '',
  businessBuyersOnly: false,
  countries: '',
  preorderOnly: false,
};

/** `datetime-local` has no zone; the seller means their own clock. */
const toLocalInput = (iso: string | null): string => {
  if (iso === null) return '';
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
const fromLocalInput = (value: string): string | null =>
  value === '' ? null : new Date(value).toISOString();

export function SellerQuantityTiersPanel({
  offerId,
  currencyExponent,
}: {
  offerId: string;
  currencyExponent: number;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const key = ['seller', 'offer', offerId, 'quantity-tiers'];
  const query = useQuery({ queryKey: key, queryFn: () => fetchQuantityTiers(offerId) });
  const [bands, setBands] = useState<DraftBand[]>([]);
  const [problems, setProblems] = useState<Map<number, string[]>>(new Map());
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (query.data === undefined) return;
    setBands(
      query.data.tiers.map((tier) => ({
        minQuantity: String(tier.minQuantity),
        maxQuantity: tier.maxQuantity === null ? '' : String(tier.maxQuantity),
        price: minorToMajor(tier.priceMinor, currencyExponent),
        isActive: tier.isActive,
        startsAt: toLocalInput(tier.startsAt),
        endsAt: toLocalInput(tier.endsAt),
        businessBuyersOnly: tier.businessBuyersOnly,
        countries: (tier.countryCodes ?? []).join(', '),
        preorderOnly: tier.preorderOnly,
      })),
    );
  }, [query.data, currencyExponent]);

  const save = useMutation({
    mutationFn: (tiers: QuantityTierInput[]) => saveQuantityTiers(offerId, tiers),
    onSuccess: (saved) => {
      client.setQueryData(key, saved);
      setProblems(new Map());
      toast.success(t('quantityTiers.saved'));
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'QUANTITY_TIERS_INVALID') {
        const byBand = new Map<number, string[]>();
        for (const detail of error.details) {
          const index = typeof detail.meta?.index === 'number' ? detail.meta.index : -1;
          byBand.set(index, [...(byBand.get(index) ?? []), detail.code ?? 'INVALID']);
        }
        setProblems(byBand);
      }
      toast.error(errorMessage(t, error));
    },
  });

  const submit = (): void => {
    setLocalError(null);
    const tiers: QuantityTierInput[] = [];
    for (const band of bands) {
      const priceMinor = majorToMinor(band.price, currencyExponent);
      const minQuantity = Number(band.minQuantity);
      if (priceMinor === null || !Number.isInteger(minQuantity) || minQuantity < 1) {
        setLocalError(t('quantityTiers.fillEveryBand'));
        return;
      }
      const countries = band.countries
        .split(/[\s,]+/)
        .map((code) => code.trim().toUpperCase())
        .filter((code) => code !== '');
      tiers.push({
        minQuantity,
        maxQuantity: band.maxQuantity.trim() === '' ? null : Number(band.maxQuantity),
        priceMinor,
        isActive: band.isActive,
        startsAt: fromLocalInput(band.startsAt),
        endsAt: fromLocalInput(band.endsAt),
        businessBuyersOnly: band.businessBuyersOnly,
        countryCodes: countries.length === 0 ? null : countries,
        preorderOnly: band.preorderOnly,
      });
    }
    save.mutate(tiers);
  };

  const update = (index: number, patch: Partial<DraftBand>): void => {
    setBands((current) => current.map((band, at) => (at === index ? { ...band, ...patch } : band)));
  };

  const listPrice = query.data?.listUnitPrice;

  return (
    <Card
      title={t('quantityTiers.title')}
      description={t('quantityTiers.intro', { price: listPrice?.formatted ?? '' })}
      bodyClassName="space-y-4 px-6 py-5"
    >
      {bands.length === 0 && <p className="text-sm text-ink-muted">{t('quantityTiers.none')}</p>}

      {problems.get(-1) !== undefined && (
        <p role="alert" className="text-sm text-danger">
          {problems
            .get(-1)
            ?.map((code) => t(`quantityTiers.problem.${code}` as TranslationKey))
            .join(' ')}
        </p>
      )}

      {bands.map((band, index) => {
        const saved = query.data?.tiers[index];
        const bandProblems = problems.get(index) ?? [];
        return (
          <fieldset
            key={index}
            className={`space-y-3 rounded-md border p-3 ${bandProblems.length > 0 ? 'border-danger/50' : 'border-border-subtle'}`}
          >
            <legend className="flex items-center gap-2 px-1 text-sm font-medium text-ink">
              {t('quantityTiers.band', { number: index + 1 })}
              {saved !== undefined && saved.savingBasisPoints > 0 && (
                <Badge tone="success">
                  {t('quantityTiers.saves', {
                    percent: formatBasisPoints(saved.savingBasisPoints, intlLocale),
                  })}
                </Badge>
              )}
              {!band.isActive && <Badge tone="neutral">{t('quantityTiers.paused')}</Badge>}
            </legend>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('quantityTiers.from')} required>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="numeric"
                    value={band.minQuantity}
                    onChange={(event) => {
                      update(index, { minQuantity: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('quantityTiers.to')} hint={t('quantityTiers.toHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    inputMode="numeric"
                    value={band.maxQuantity}
                    onChange={(event) => {
                      update(index, { maxQuantity: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('quantityTiers.price')} required>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    value={band.price}
                    onChange={(event) => {
                      update(index, { price: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label={t('quantityTiers.startsAt')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    type="datetime-local"
                    value={band.startsAt}
                    onChange={(event) => {
                      update(index, { startsAt: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('quantityTiers.endsAt')}>
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    type="datetime-local"
                    value={band.endsAt}
                    onChange={(event) => {
                      update(index, { endsAt: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
              <Field label={t('quantityTiers.countries')} hint={t('quantityTiers.countriesHint')}>
                {({ inputId, describedBy }) => (
                  <Input
                    id={inputId}
                    aria-describedby={describedBy}
                    value={band.countries}
                    onChange={(event) => {
                      update(index, { countries: event.currentTarget.value });
                    }}
                  />
                )}
              </Field>
            </div>
            <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-ink">
              {(
                [
                  ['isActive', 'quantityTiers.active'],
                  ['businessBuyersOnly', 'quantityTiers.businessOnly'],
                  ['preorderOnly', 'quantityTiers.preorderOnly'],
                ] as const
              ).map(([field, label]) => (
                <label key={field} className="inline-flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border"
                    checked={band[field]}
                    onChange={(event) => {
                      update(index, { [field]: event.currentTarget.checked });
                    }}
                  />
                  {t(label)}
                </label>
              ))}
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setBands((current) => current.filter((_, at) => at !== index));
                  setProblems(new Map());
                }}
              >
                {t('quantityTiers.remove')}
              </Button>
            </div>
            {bandProblems.length > 0 && (
              <ul role="alert" className="list-disc pl-5 text-sm text-danger">
                {bandProblems.map((code) => (
                  <li key={code}>{t(`quantityTiers.problem.${code}` as TranslationKey)}</li>
                ))}
              </ul>
            )}
          </fieldset>
        );
      })}

      {localError !== null && (
        <p role="alert" className="text-sm text-danger">
          {localError}
        </p>
      )}

      <div className="flex flex-wrap justify-between gap-2">
        <Button
          size="sm"
          disabled={bands.length >= 20}
          onClick={() => {
            setBands((current) => [...current, EMPTY_BAND]);
          }}
        >
          {t('quantityTiers.add')}
        </Button>
        <Button
          variant="primary"
          size="sm"
          isLoading={save.isPending}
          disabled={query.isPending}
          onClick={submit}
        >
          {t('quantityTiers.save')}
        </Button>
      </div>
    </Card>
  );
}
