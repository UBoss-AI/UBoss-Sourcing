/**
 * "Order by" — the panel where a buyer chooses a carton, a pallet or a
 * container instead of loose units.
 *
 * WHAT IT DRAWS, AND WHY THAT PARTICULAR LIST
 *
 * A hospital group buying gloves by the pallet is committing to a five-figure
 * order, and the questions they need answered before pressing the button are
 * not the questions a single-item buyer has. So this shows, always:
 *
 *   - the full breakdown - "2 UK pallets × 50 cartons × 24 units = 2,400 units"
 *   - the price per package AND the effective price per unit, because those
 *     are the two numbers a buyer compares against their existing supplier
 *   - how many WHOLE packages are actually available, rounded down: part of a
 *     pallet is not something a warehouse can pick, and telling somebody three
 *     are available and failing at checkout is worse than telling them two
 *   - the loaded size and weight, because somebody has to unload it
 *   - the lead time, because a pallet is not next-day
 *   - whether delivery can be priced at all, or needs a quotation
 *
 * NOTHING HERE IS TRUSTED. Every figure came off the server, which worked it
 * out from the seller's stored configuration and re-checks the lot on
 * add-to-cart. This does arithmetic for a display so the stepper responds
 * without a round trip; the moment it matters, the server decides.
 *
 * The panel does not render at all when the seller offers no packages, which
 * is most of the catalogue — `packagingOptions` comes back empty and the page
 * draws its ordinary quantity box with none of this on it.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card } from '@/components/ui';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatMoneyMinor, formatNumber } from '@/lib/format';
import { useToast } from '@/components/toast-context';
import { useT } from '@/i18n/i18n-context';
import {
  appliedTierAt,
  breakdownParts,
  clampPackages,
  formatDimensions,
  formatWeight,
  lineTotalMinor,
  nextTier,
  packagePriceAt,
  packageTypeKey,
  packagingUnavailable,
  type BuyablePackaging,
  type PackageType,
} from '@/lib/bulk-packaging';
import type { TranslationKey } from '@/i18n/i18n-context';

interface BulkOrderPanelProps {
  productId: string;
  variantId: string | null;
  options: BuyablePackaging[];
  /** The buyer's instruction for the line, shared with the ordinary control. */
  note: string | null;
  onAdded: () => void;
}

export function BulkOrderPanel({
  productId,
  variantId,
  options,
  note,
  onAdded,
}: BulkOrderPanelProps): React.JSX.Element | null {
  const t = useT();
  const toast = useToast();
  const queryClient = useQueryClient();

  const [selectedType, setSelectedType] = useState<PackageType | null>(
    options[0]?.packageType ?? null,
  );
  const [packages, setPackages] = useState<number>(options[0]?.minimumPackages ?? 1);
  const [addError, setAddError] = useState<string | null>(null);

  const selected = useMemo(
    () => options.find((option) => option.packageType === selectedType) ?? null,
    [options, selectedType],
  );

  /*
   * Everything shown, recomputed from the chosen package and quantity.
   *
   * One memo rather than six, so the breakdown, the price and the availability
   * message are always describing the same choice. Computed separately they
   * drift by one render whenever the stepper moves, which on a page quoting a
   * five-figure total is a number somebody screenshots.
   */
  const quote = useMemo(() => {
    if (selected === null) return null;

    const effective = clampPackages(packages, selected);
    const perPackage = packagePriceAt(selected, effective);

    return {
      effective,
      perPackage,
      total: lineTotalMinor(perPackage, effective),
      totalUnits: effective * selected.unitsPerPackage,
      tier: appliedTierAt(selected, effective),
      upcoming: nextTier(selected, effective),
      unavailable: packagingUnavailable(selected, effective),
      parts: breakdownParts({
        packageType: selected.packageType,
        packageQuantity: effective,
        unitsPerCarton: selected.unitsPerCarton,
        cartonsPerPallet: selected.cartonsPerPallet,
        palletsPerContainer: selected.palletsPerContainer,
      }),
      weight: formatWeight(selected.grossWeightGrams),
      size: formatDimensions(selected.lengthMm, selected.widthMm, selected.heightMm),
    };
  }, [selected, packages]);

  const addToCart = useMutation({
    mutationFn: () =>
      api.post('/cart/items/bulk', {
        items: [
          {
            productId,
            variantId,
            /*
             * `quantity` is required by the schema and IGNORED by the server
             * whenever a package is named - it recomputes the base-unit count
             * from its own stored figures. Sent as 1 rather than as our own
             * arithmetic precisely so nothing here can look like an attempt to
             * state what a pallet holds.
             */
            quantity: 1,
            packageType: selected?.packageType,
            packageQuantity: quote?.effective ?? 1,
            note,
          },
        ],
      }),
    onSuccess: async () => {
      setAddError(null);
      toast.success(t('packaging.addedToYourCart'));
      await queryClient.invalidateQueries({ queryKey: ['cart'] });
      onAdded();
    },
    onError: (error) => {
      // The server's message names the rule that was broken - a minimum, a
      // stock shortfall, a package the seller has since switched off. Replacing
      // it with "could not add" throws away the only thing that tells the
      // buyer what to change.
      setAddError(errorMessage(t, error, t('packaging.couldNotBeAdded')));
    },
  });

  if (options.length === 0 || selected === null || quote === null) return null;

  const choose = (option: BuyablePackaging): void => {
    setSelectedType(option.packageType);
    // Onto the new package's own minimum, not the old package's count. Two
    // pallets and two containers are wildly different orders, and carrying the
    // number across is how somebody buys forty tonnes by accident.
    setPackages(option.minimumPackages);
    setAddError(null);
  };

  return (
    <Card
      title={t('packaging.orderBy')}
      description={t('packaging.orderByHint')}
      className="mt-6"
    >
      <fieldset className="border-0 p-0">
        <legend className="sr-only">{t('packaging.orderBy')}</legend>

        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('packaging.orderBy')}>
          {options.map((option) => {
            const isSelected = option.packageType === selected.packageType;

            return (
              <button
                key={option.packageType}
                type="button"
                role="radio"
                aria-checked={isSelected}
                onClick={() => {
                  choose(option);
                }}
                className={[
                  'rounded-xl border px-4 py-3 text-left transition',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                  isSelected
                    ? 'border-brand bg-brand-soft ring-1 ring-brand'
                    : 'border-border hover:border-ink-muted',
                ].join(' ')}
              >
                <span className="block text-sm font-semibold">
                  {t(packageTypeKey(option.packageType) as TranslationKey, { count: 1 })}
                </span>
                <span className="block text-xs text-ink-muted">
                  {t('packaging.unitsPerPackage', {
                    units: formatNumber(option.unitsPerPackage),
                  })}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {/* The breakdown, assembled from figures rather than from a sentence.
          Each part carries its own plural-aware label, because "2 pallets ×
          50 cartons" does not translate by substituting words into an English
          frame - Polish needs four forms and picks between them by grammar the
          English source does not carry. */}
      <p className="mt-5 text-sm font-medium" data-testid="packaging-breakdown">
        {quote.parts
          .map((part) =>
            t(`packaging.part.${part.kind}` as TranslationKey, {
              count: part.value,
              value: part.formatted,
            }),
          )
          .join(' × ')}
        {' = '}
        {t('packaging.part.units', {
          count: quote.totalUnits,
          value: formatNumber(quote.totalUnits),
        })}
      </p>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium">
            {t('packaging.howMany', {
              package: t(packageTypeKey(selected.packageType) as TranslationKey, { count: 2 }),
            })}
          </span>
          <span className="inline-flex items-center gap-2">
            <Button
              size="sm"
              aria-label={t('packaging.decrease')}
              disabled={quote.effective <= selected.minimumPackages}
              onClick={() => {
                setPackages(Math.max(selected.minimumPackages, quote.effective - selected.packageIncrement));
              }}
            >
              −
            </Button>
            <input
              type="number"
              inputMode="numeric"
              min={selected.minimumPackages}
              step={selected.packageIncrement}
              value={packages}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                setPackages(Number.isFinite(next) && next > 0 ? next : selected.minimumPackages);
              }}
              className="w-24 rounded-lg border border-border bg-surface px-3 py-2 text-center"
              aria-describedby="packaging-rules"
            />
            <Button
              size="sm"
              aria-label={t('packaging.increase')}
              onClick={() => {
                setPackages(quote.effective + selected.packageIncrement);
              }}
            >
              +
            </Button>
          </span>
        </label>

        <div className="text-sm">
          <p className="text-2xl font-semibold" data-testid="packaging-total">
            {formatMoneyMinor(quote.total, selected.currency)}
          </p>
          <p className="text-ink-muted">
            {t('packaging.perPackage', {
              price: formatMoneyMinor(quote.perPackage, selected.currency),
              package: t(packageTypeKey(selected.packageType) as TranslationKey, { count: 1 }),
            })}
          </p>
          {/* The figure a buyer actually compares against their current
              supplier. Shown always, and derived on the server from the exact
              package price - the divisibility rule is what makes it exact
              rather than a rounded-back approximation. */}
          <p className="text-ink-muted">
            {t('packaging.perUnit', {
              price: formatMoneyMinor(selected.effectiveUnitPriceMinor, selected.currency),
            })}
          </p>
        </div>
      </div>

      <p id="packaging-rules" className="mt-2 text-xs text-ink-muted">
        {t('packaging.rules', {
          minimum: formatNumber(selected.minimumPackages),
          step: formatNumber(selected.packageIncrement),
        })}
      </p>

      {quote.upcoming !== null && (
        <p className="mt-2 text-xs font-medium text-success">
          {t('packaging.nextTier', {
            quantity: formatNumber(quote.upcoming.minPackages),
            price: formatMoneyMinor(quote.upcoming.pricePerPackageMinor, selected.currency),
          })}
        </p>
      )}

      {quote.tier !== null && (
        <span className="mt-2 inline-block"><Badge tone="success">
          {t('packaging.tierApplied', { quantity: formatNumber(quote.tier) })}
          </Badge></span>
      )}

      <dl className="mt-5 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        {quote.size !== null && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">{t('packaging.size')}</dt>
            <dd className="text-right font-medium">
              {quote.size.value} {quote.size.unit}
            </dd>
          </div>
        )}
        {quote.weight !== null && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">{t('packaging.grossWeight')}</dt>
            <dd className="text-right font-medium">
              {quote.weight.value} {quote.weight.unit}
            </dd>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <dt className="text-ink-muted">{t('packaging.available')}</dt>
          {/* Rounded DOWN, and the wording says "complete". Part of a pallet
              is not something anybody can pick, and a number that included one
              would fail at checkout. */}
          <dd className="text-right font-medium">
            {t('packaging.completePackages', {
              count: selected.wholePackagesAvailable,
              value: formatNumber(selected.wholePackagesAvailable),
            })}
          </dd>
        </div>
        {selected.leadTimeDays !== null && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">{t('packaging.leadTime')}</dt>
            <dd className="text-right font-medium">
              {t('packaging.workingDays', {
                count: selected.leadTimeDays,
                value: formatNumber(selected.leadTimeDays),
              })}
            </dd>
          </div>
        )}
        {selected.incoterm !== null && (
          <div className="flex justify-between gap-4">
            <dt className="text-ink-muted">{t('packaging.incoterm')}</dt>
            <dd className="text-right font-medium">{selected.incoterm}</dd>
          </div>
        )}
      </dl>

      {selected.isHazardous && (
        <p className="mt-3 text-sm font-medium text-warning">
          {t('packaging.hazardous')}
        </p>
      )}

      {/* Not an error, and deliberately not styled as one. A container's
          delivery genuinely is quoted rather than priced instantly, and saying
          so plainly is the honest answer - the goods can still be ordered. */}
      {selected.requiresFreightQuote && (
        <p className="mt-3 rounded-lg bg-operational-soft p-3 text-sm text-operational">
          {t('packaging.freightQuoteRequired')}
        </p>
      )}

      {quote.unavailable !== null && (
        <p role="status" className="mt-3 text-sm font-medium text-warning">
          {quote.unavailable.code === 'OUT_OF_STOCK'
            ? t('packaging.outOfStock')
            : quote.unavailable.code === 'NOT_ENOUGH_WHOLE_PACKAGES'
              ? t('packaging.onlyCompleteAvailable', {
                  count: quote.unavailable.available,
                  value: formatNumber(quote.unavailable.available),
                  package: t(packageTypeKey(selected.packageType) as TranslationKey, {
                    count: quote.unavailable.available,
                  }),
                })
              : t('packaging.aboveMaximum', {
                  value: formatNumber(quote.unavailable.maximum),
                })}
        </p>
      )}

      {addError !== null && (
        <p role="alert" className="mt-3 text-sm font-medium text-danger">
          {addError}
        </p>
      )}

      <Button
        variant="primary"
        fullWidth
        className="mt-5"
        isLoading={addToCart.isPending}
        disabled={quote.unavailable !== null}
        onClick={() => {
          addToCart.mutate();
        }}
      >
        {t('packaging.addToBasket')}
      </Button>
    </Card>
  );
}
