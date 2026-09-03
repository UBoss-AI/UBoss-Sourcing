/**
 * A product card.
 *
 * Used on the home page, category pages and search results, so it has to work
 * at every width without changing meaning.
 *
 * Three details that matter more than they look:
 *
 *   - **The whole card is not a link.** The product name is. A card-sized
 *     anchor swallows the text a screen reader reads out — "link, image,
 *     Hex Bolt M12, 45.50, minimum 10" as one blob — and makes selecting text
 *     impossible. One clear link, with the image marked decorative, reads
 *     properly and still gives a large click target via the name.
 *   - **Purchase rules are on the card.** A minimum of 10 discovered only in
 *     the cart wastes the customer twice.
 *   - **`loading="lazy"` and explicit dimensions.** The dimensions reserve
 *     space so the grid does not jump as images arrive, which is most of what
 *     Cumulative Layout Shift measures.
 */
import { Link } from 'react-router-dom';
import { Badge } from './ui';
import { formatMoney, formatNumber } from '@/lib/format';
import type { Product } from '@/lib/types';

/** A neutral placeholder for a product with no image yet. */
function ImageFallback(): React.JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="flex h-full w-full items-center justify-center bg-surface-sunken text-ink-subtle"
    >
      <svg viewBox="0 0 24 24" className="h-10 w-10" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export function ProductCard({ product }: { product: Product }): React.JSX.Element {
  const { purchaseRules: rules } = product;
  const hasDiscount =
    product.compareAtPrice !== null &&
    BigInt(product.compareAtPrice.minor) > BigInt(product.price.minor);

  return (
    <article className="group flex flex-col overflow-hidden rounded-lg border border-border bg-surface transition-shadow hover:shadow-lift">
      <div className="aspect-square w-full overflow-hidden bg-surface">
        {product.primaryImage === null ? (
          <ImageFallback />
        ) : (
          <img
            src={product.primaryImage.url}
            // The product name is already the link text right below. Repeating
            // it here makes a screen reader say it twice.
            alt={product.primaryImage.altText ?? ''}
            width={400}
            height={400}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain p-4 transition-transform group-hover:scale-105"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-1.5 border-t border-border p-3.5">
        <h3 className="text-sm font-medium leading-snug text-ink">
          <Link to={`/product/${product.slug}`} className="hover:text-brand hover:underline">
            {product.name}
          </Link>
        </h3>

        {product.shortDescription !== null && (
          <p className="line-clamp-2 text-xs text-ink-muted">{product.shortDescription}</p>
        )}

        <div className="mt-auto pt-1.5">
          <p className="flex items-baseline gap-2">
            <span className="text-base font-semibold tabular text-ink">
              {formatMoney(product.price)}
            </span>
            {hasDiscount && product.compareAtPrice !== null && (
              <span className="text-xs tabular text-ink-subtle line-through">
                {formatMoney(product.compareAtPrice)}
              </span>
            )}
          </p>

          <p className="mt-0.5 text-xxs text-ink-subtle">
            {product.tax.inclusive ? 'Tax included' : `+ ${product.tax.ratePercent}% ${product.tax.code}`}
          </p>

          <div className="mt-2 flex flex-wrap gap-1">
            {rules.minOrderQty > 1 && (
              <Badge>Min {formatNumber(rules.minOrderQty)}</Badge>
            )}
            {rules.qtyIncrement > 1 && (
              <Badge>In {formatNumber(rules.qtyIncrement)}s</Badge>
            )}
            {rules.isRecurringEligible && <Badge tone="brand">Repeat purchase</Badge>}
          </div>
        </div>
      </div>
    </article>
  );
}

/** Matches the card's shape, so the grid does not reflow when data arrives. */
export function ProductCardSkeleton(): React.JSX.Element {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface" aria-hidden="true">
      <div className="skeleton aspect-square w-full rounded-none" />
      <div className="space-y-2 border-t border-border p-3.5">
        <div className="skeleton h-4 w-4/5" />
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-5 w-1/3" />
      </div>
    </div>
  );
}
