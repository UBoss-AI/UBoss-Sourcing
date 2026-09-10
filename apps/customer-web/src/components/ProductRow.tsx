/**
 * A product as a wide row, for a listing that is being read rather than
 * scanned.
 *
 * The catalogue used to be a grid of `ProductCard`. A grid is the right shape
 * for a strip on the front page, where the job is "here are some products" and
 * the photograph does the talking. It is the wrong shape for a department: a
 * card 240px wide can hold a name, a code and a price, and a buyer choosing
 * between eleven infusion sets needs the *differences* — the bore, the length,
 * the filter, the minimum order — which is four more facts than a card has
 * room for.
 *
 * So the listing is rows, in three columns, in the order the decision is made:
 *
 *   1. **The photograph**, fixed width, so every row lines up and the eye can
 *      run down the column.
 *   2. **What it is**: the name, the product code, and up to four of the
 *      product's own attributes as a list. Those come from the catalogue, not
 *      from a template — an administrator marks which attributes matter, and
 *      this shows the first four of them.
 *   3. **What it costs**, right-aligned and last, because a price nobody has
 *      read the specification for is a number without a question.
 *
 * `ProductCard` is untouched and still used by the front page strip, the
 * related-products rail and the wishlist. Two presentations of one product is
 * not duplication when the two answer different questions; one component with
 * a `layout` prop and eleven conditionals would be.
 *
 * ---
 *
 * **What this row deliberately does not have**, because the data does not
 * exist and inventing it would be a lie a buyer might act on:
 *
 *   - **A star rating and a review count.** There is no reviews system. A
 *     rating is the single most persuasive thing on a listing row, and a
 *     fabricated one is the single most dishonest.
 *   - **A "Sponsored" flag.** Nothing in this catalogue is paid placement.
 *   - **A trust badge.** Assurance is the operator's to claim, not this
 *     software's to assert on their behalf.
 *   - **A bank offer.** Discounts here are a price and a compare-at price;
 *     card-issuer promotions are not a thing this product models.
 *   - **Add to Compare.** There is no comparison view to add to.
 *
 * What replaces the space they would have taken is the specification list and
 * the purchase rules, which are the facts this catalogue actually holds and
 * the ones a purchasing decision turns on.
 */
import { Link } from 'react-router-dom';
import { Badge } from './ui';
import { SaveForLaterButton } from './SaveForLaterButton';
import { formatMoney, formatNumber } from '@/lib/format';
import type { Product } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** How many of a product's attributes the row lists before it stops. */
const SPECS_SHOWN = 4;

/**
 * The saving, as a whole percentage.
 *
 * `BigInt` throughout, and the division last: these are minor units, and the
 * moment a price touches a float this app has a rounding bug it will find out
 * about from a customer. Truncating rather than rounding is deliberate — 33%
 * off is a claim, and claiming 34 because the arithmetic came to 33.6 is the
 * wrong direction to be wrong in.
 */
function discountPercent(product: Product): number | null {
  if (product.compareAtPrice === null) return null;

  const was = BigInt(product.compareAtPrice.minor);
  const now = BigInt(product.price.minor);
  if (was <= now) return null;

  const percent = Number(((was - now) * 100n) / was);
  // Under 1% is arithmetic, not an offer. Showing "0% off" beside a struck
  // price is worse than showing neither.
  return percent < 1 ? null : percent;
}

/**
 * A neutral placeholder for a product with no image yet.
 *
 * The same reasoning as `ProductCard`'s, at row scale: an empty white square
 * beside a photograph reads as an image that failed to load, and this reads as
 * "there is no photograph", which is what is true.
 */
function ImageFallback(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div
      aria-hidden="true"
      className="flex h-full w-full items-center justify-center bg-surface-sunken text-ink-subtle"
    >
      <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.4">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <path d="m21 15-5-5L5 21" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span className="sr-only">{t('productCard.noImageYet')}</span>
    </div>
  );
}

export function ProductRow({ product }: { product: Product }): React.JSX.Element {
  const { t } = useI18n();

  const { purchaseRules: rules } = product;
  const discount = discountPercent(product);
  const specs = product.attributes.slice(0, SPECS_SHOWN);

  return (
    /*
     * `relative`, for the stretched link on the name — the same pattern the
     * card uses, and for the same reason: one anchor, whose accessible name is
     * the product and nothing else, with a row-sized hit area laid over the
     * top of it. Wrapping the row in an anchor instead would announce the
     * photograph, the specification and the price as one run of link text.
     *
     * `group` so the name can respond to the pointer being anywhere on the
     * row, which is the whole point of the hit area.
     */
    <article className="group relative flex flex-col gap-4 p-4 transition-colors hover:bg-surface-hover sm:flex-row sm:gap-5 sm:p-5">
      {/* Fixed, not fluid: a column of photographs that each choose their own
          width is a column with no edge to run the eye down. */}
      <div className="h-40 w-40 shrink-0 self-center overflow-hidden rounded-lg border border-border-subtle bg-surface-sunken sm:h-44 sm:w-44 sm:self-start">
        {product.primaryImage === null ? (
          <ImageFallback />
        ) : (
          <img
            src={product.primaryImage.url}
            // The name is the link text immediately beside it; repeating it
            // here makes a screen reader say the product twice.
            alt={product.primaryImage.altText ?? ''}
            width={400}
            height={400}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-contain p-3 transition-transform duration-200 group-hover:scale-[1.04]"
          />
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold leading-snug text-ink">
              <Link
                to={`/product/${product.slug}`}
                // The stretched link. See ProductCard for the long version of
                // why it is a pseudo-element on the anchor rather than a
                // wrapper around the row.
                className="rounded transition-colors after:absolute after:inset-0 after:content-['']
                           hover:text-brand hover:underline hover:decoration-brand/40 hover:underline-offset-2
                           group-hover:text-brand group-hover:underline group-hover:decoration-brand/40
                           group-hover:underline-offset-2"
              >
                {product.name}
              </Link>
            </h3>

            {/* In B2B purchasing the code is how a line is identified — a
                buyer checking this against a purchase order is looking for
                the code, not the name. Raised above the stretched link so it
                can still be selected and copied. */}
            <p className="mt-1 truncate font-mono text-xxs uppercase tracking-wide text-ink-subtle">
              <span className="relative z-[1] select-text">{product.sku}</span>
            </p>
          </div>

          {/* Above the overlay, or the stretched link would swallow it. */}
          <div className="relative z-[1] shrink-0">
            <SaveForLaterButton productId={product.id} productSlug={product.slug} />
          </div>
        </div>

        {product.shortDescription !== null && (
          <p className="line-clamp-2 text-sm leading-relaxed text-ink-muted">
            {product.shortDescription}
          </p>
        )}

        {/*
         * The specification, and the reason this layout exists.
         *
         * `name: value` per line rather than value alone: "1 ml" on its own
         * says nothing, and this catalogue's attributes are things like
         * Volume, Bore and Needle where the name carries half the meaning.
         */}
        {specs.length > 0 && (
          <ul className="space-y-1 text-sm text-ink-muted">
            {specs.map((spec) => (
              <li key={spec.name} className="flex gap-2">
                <span aria-hidden="true" className="mt-2 h-1 w-1 shrink-0 rounded-full bg-ink-subtle" />
                <span className="min-w-0">
                  <span className="text-ink-subtle">{spec.name}:</span> {spec.value}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(rules.minOrderQty > 1 || rules.qtyIncrement > 1) && (
          <div className="flex flex-wrap gap-1.5">
            {rules.minOrderQty > 1 && (
              <Badge>{t('catalog.rowMinimum', { qty: formatNumber(rules.minOrderQty) })}</Badge>
            )}
            {rules.qtyIncrement > 1 && (
              <Badge>
                {t('catalog.rowIncrement', { qty: formatNumber(rules.qtyIncrement) })}
              </Badge>
            )}
          </div>
        )}
      </div>

      {/*
       * The price column. Right-aligned from `sm`, and left-aligned under the
       * specification on a phone, where a third column would be 90px wide.
       */}
      <div className="shrink-0 sm:w-40 sm:text-right lg:w-48">
        <p className="text-xl font-semibold tabular text-ink">{formatMoney(product.price)}</p>

        {discount !== null && product.compareAtPrice !== null && (
          <p className="mt-0.5 flex flex-wrap items-baseline gap-x-2 sm:justify-end">
            <span className="text-sm tabular text-ink-subtle">
              {/* The strikethrough is all a sighted reader gets; a screen
                  reader is given the word. */}
              <span className="sr-only">{t('productCard.was')}</span>
              <s>{formatMoney(product.compareAtPrice)}</s>
            </span>
            <span className="text-sm font-semibold text-success">
              {t('catalog.rowPercentOff', { percent: formatNumber(discount) })}
            </span>
          </p>
        )}

        <p className="mt-1 text-xxs text-ink-subtle">
          {product.tax.inclusive
            ? t('productCard.taxIncluded')
            : t('productCard.plusTaxRate', {
                rate: product.tax.ratePercent,
                code: product.tax.code,
              })}
        </p>
      </div>
    </article>
  );
}

/**
 * The row's shape while the read is in flight.
 *
 * The same three columns at the same sizes, so the list does not jump when the
 * products arrive — which is most of what Cumulative Layout Shift measures.
 */
export function ProductRowSkeleton(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4 p-4 sm:flex-row sm:gap-5 sm:p-5">
      <div className="h-40 w-40 shrink-0 self-center rounded-lg bg-surface-sunken sm:h-44 sm:w-44 sm:self-start" />

      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="h-5 w-3/5 rounded bg-surface-sunken" />
        <div className="h-3 w-24 rounded bg-surface-sunken" />
        <div className="h-4 w-full rounded bg-surface-sunken" />
        <div className="h-4 w-4/5 rounded bg-surface-sunken" />
        <div className="h-4 w-2/3 rounded bg-surface-sunken" />
      </div>

      <div className="shrink-0 space-y-2 sm:w-40 lg:w-48">
        <div className="h-6 w-24 rounded bg-surface-sunken sm:ml-auto" />
        <div className="h-3 w-20 rounded bg-surface-sunken sm:ml-auto" />
      </div>
    </div>
  );
}
