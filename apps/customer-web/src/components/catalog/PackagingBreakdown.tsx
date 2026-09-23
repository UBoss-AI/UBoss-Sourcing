/**
 * "2 UK pallets × 50 cartons × 24 units = 2,400 units", wherever a bulk line
 * is shown.
 *
 * One component for the basket, the checkout review, the order confirmation
 * and the order detail, because those four screens showing the same order four
 * slightly different ways is how a buyer starts checking whether the number
 * moved.
 *
 * READ OFF THE LINE'S OWN SNAPSHOT, never off the product. That is what makes
 * an order from last month still describe the pallet it was actually bought
 * as, after the seller has re-specified it - the same rule the order line's
 * price, name and SKU snapshots already follow.
 *
 * The sentence is composed from figures rather than translated as a frame:
 * the noun agrees with the number four different ways in Polish, and an
 * English sentence with slots would get every one of them wrong.
 */
import { Badge } from '@/components/ui';
import { formatMoneyMinor, formatNumber } from '@/lib/format';
import { useT, type TranslationKey } from '@/i18n/i18n-context';
import {
  breakdownParts,
  formatDimensions,
  formatWeight,
  packageTypeKey,
  type LinePackaging,
} from '@/lib/bulk-packaging';

interface PackagingBreakdownProps {
  packaging: LinePackaging;
  /**
   * Whether to show the per-package price and the freight note.
   *
   * On in the basket and at checkout, where the buyer is still deciding. Off
   * on a confirmation, where the line total beside it is the figure that
   * matters and a second price invites the reader to check one against the
   * other.
   */
  showPrice?: boolean;
  className?: string;
}

export function PackagingBreakdown({
  packaging,
  showPrice = true,
  className,
}: PackagingBreakdownProps): React.JSX.Element {
  const t = useT();

  const parts = breakdownParts({
    packageType: packaging.packageType,
    packageQuantity: packaging.packageQuantity,
    unitsPerCarton: packaging.unitsPerCarton,
    cartonsPerPallet: packaging.cartonsPerPallet,
    palletsPerContainer: packaging.palletsPerContainer,
  });

  const weight = formatWeight(packaging.grossWeightGrams);
  const size = formatDimensions(packaging.lengthMm, packaging.widthMm, packaging.heightMm);

  return (
    <div className={className} data-testid="packaging-line-breakdown">
      <Badge tone="operational">
        {t(packageTypeKey(packaging.packageType) as TranslationKey, {
          count: packaging.packageQuantity,
        })}
      </Badge>

      <p className="mt-1 text-sm">
        {parts
          .map((part) =>
            t(`packaging.part.${part.kind}` as TranslationKey, {
              count: part.value,
              value: part.formatted,
            }),
          )
          .join(' × ')}
        {' = '}
        <span className="font-semibold">
          {t('packaging.part.units', {
            count: packaging.totalBaseUnits,
            value: formatNumber(packaging.totalBaseUnits),
          })}
        </span>
      </p>

      {showPrice && (
        <p className="text-xs text-ink-muted">
          {t('packaging.perPackage', {
            price: formatMoneyMinor(packaging.packagePriceMinor, packaging.currency),
            package: t(packageTypeKey(packaging.packageType) as TranslationKey, { count: 1 }),
          })}
        </p>
      )}

      {(weight !== null || size !== null) && (
        <p className="text-xs text-ink-muted">
          {[
            size === null ? null : `${size.value} ${size.unit}`,
            weight === null ? null : `${weight.value} ${weight.unit}`,
          ]
            .filter((part): part is string => part !== null)
            .join(' · ')}
        </p>
      )}

      {/* Not an error, and not styled as one. A container's delivery genuinely
          is quoted rather than priced instantly; the goods are priced and the
          order can go through. */}
      {showPrice && packaging.requiresFreightQuote && (
        <p className="mt-1 text-xs font-medium text-operational">
          {t('packaging.freightPending')}
        </p>
      )}
    </div>
  );
}
