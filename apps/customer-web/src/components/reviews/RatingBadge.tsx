/**
 * A product's average and review count, in one line: ★★★★☆ 4.3 (12).
 *
 * On every product card and under the product page's title. Draws nothing at
 * all when there are no reviews, or when the deployment has reviews switched
 * off: five empty stars would read as "rated zero", which is a claim about
 * the product nobody made.
 *
 * The stars are one image with a sentence for a name, and the count is part
 * of that sentence, so a screen reader hears "Rated 4.3 out of 5, 12 reviews"
 * once rather than a number, a star, a star, a bracket.
 */
import { StarRating } from '@/components/ui/star-rating';
import { useStorefront } from '@/app/storefront-context';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { formatRating, type RatingBadge as Badge } from '@/lib/ratings';
import { useI18n } from '@/i18n/i18n-context';

export function RatingBadge({
  rating,
  size = 'xs',
  className,
}: {
  rating: Badge | null | undefined;
  size?: 'xs' | 'sm';
  className?: string;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { features } = useStorefront();

  if (features.productReviews !== true || rating === null || rating === undefined || rating.count === 0) {
    return null;
  }

  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5',
        size === 'xs' ? 'text-xxs' : 'text-xs',
        className,
      )}
    >
      <StarRating readOnly size={size} value={rating.average} label={t('rating.average')} />
      <span aria-hidden="true" className="font-semibold tabular-nums text-ink">
        {formatRating(rating.average)}
      </span>
      <span aria-hidden="true" className="tabular-nums text-ink-subtle">
        ({formatNumber(rating.count)})
      </span>
      <span className="sr-only">{t('rating.reviewCount', { count: rating.count })}</span>
    </span>
  );
}
