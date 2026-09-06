/**
 * A product card.
 *
 * Used on the home page, category pages and search results, so it has to work
 * at every width without changing meaning.
 *
 * Details that matter more than they look:
 *
 *   - **The whole card is clickable, but only the name is the link.** There is
 *     still exactly one `<a>`, and its accessible name is still just the
 *     product name — a screen reader says "link, Hex Bolt M12", not "link,
 *     image, Hex Bolt M12, 45.50, minimum 10" as one blob. The card-sized hit
 *     area comes from a `::after` overlay on that anchor (the stretched-link
 *     pattern), not from wrapping the card in an anchor. Wrapping is what
 *     produces the blob, swallows the heading structure, and makes the
 *     card-sized link the only thing in the tab order.
 *   - **The SKU stays selectable.** It sits above the overlay, because a buyer
 *     checking a card against a purchase order needs to copy it, and a
 *     stretched link otherwise turns every drag into a click. It is the one
 *     part of the card that does not navigate; that is the trade, and the SKU
 *     is the right place to spend it.
 *   - **Purchase rules are on the card.** A minimum of 10 discovered only in
 *     the cart wastes the customer twice.
 *   - **`loading="lazy"` and explicit dimensions.** The dimensions reserve
 *     space so the grid does not jump as images arrive, which is most of what
 *     Cumulative Layout Shift measures.
 *   - **No Add to Cart button here, deliberately.** Three of this catalogue's
 *     rules cannot be satisfied from a card: a product with variants needs a
 *     choice before anything can be added, a minimum order quantity means the
 *     button would have to silently pick a number on the customer's behalf,
 *     and a guest has no cart to add to. A button that sometimes adds, some-
 *     times jumps to the product page and sometimes bounces to sign-in is
 *     three behaviours wearing one label. The name is the link; the product
 *     page is where the decision is made.
 *
 * The card reads top to bottom in the order a buyer scans it: what it is
 * (name, code), what it is for (description), what it costs (price, tax), and
 * what the rules are (minimum, increment, repeat purchase) — the last group
 * fenced off by a hairline so it can be found without being read.
 */
import { Link } from 'react-router-dom';
import { Badge } from './ui';
import { formatMoney, formatNumber } from '@/lib/format';
import type { Product } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/**
 * A neutral placeholder for a product with no image yet.
 *
 * A plated icon on the sunken ground rather than a bare glyph on white: an
 * empty white square in a grid of photographs reads as an image that failed to
 * load, which invites a reload. This reads as "there is no photograph", which
 * is what is true. `aria-hidden`, because a missing image is not information a
 * screen reader needs read out.
 */
function ImageFallback(): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div
      aria-hidden="true"
      className="flex h-full w-full flex-col items-center justify-center gap-2 bg-surface-sunken text-ink-subtle"
    >
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-surface ring-1 ring-inset ring-border">
        <svg
          viewBox="0 0 24 24"
          className="h-6 w-6"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="text-xxs font-medium uppercase tracking-wider">
        {t('productCard.noImageYet')}
      </span>
    </div>
  );
}

export function ProductCard({ product }: { product: Product }): React.JSX.Element {
  const { t } = useI18n();

  const { purchaseRules: rules } = product;
  const hasDiscount =
    product.compareAtPrice !== null &&
    BigInt(product.compareAtPrice.minor) > BigInt(product.price.minor);

  // The bottom strip only earns its hairline when it has something in it.
  const hasRuleChips =
    hasDiscount || rules.minOrderQty > 1 || rules.qtyIncrement > 1 || rules.isRecurringEligible;

  return (
    // Rests on the page at `shadow-card` and rises to `shadow-card-hover` —
    // two adjacent rungs of the shared elevation ladder, rather than the jump
    // from flat to `shadow-lift`, which made a hovered card in a grid look
    // like it had been picked up. The border darkens by one step at the same
    // time, so the lift is felt rather than performed.
    //
    // `focus-within` gets the same treatment as `hover`: tabbing through the
    // grid should move the same highlight a pointer does, or a keyboard user
    // is left tracking a focus ring with no context around it.
    // `relative` is load-bearing: it is the containing block the stretched
    // link's overlay resolves against, so the anchor below covers this card
    // and nothing outside it.
    <article
      className="group relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-surface
                 shadow-card transition-[box-shadow,border-color] hover:border-border-hover
                 hover:shadow-card-hover focus-within:border-brand/40 focus-within:shadow-card-hover"
    >
      {/* The media frame sits on the sunken ground with generous inset. Most
          of this catalogue is `object-contain` product photography on white,
          which on a white card has no edge at all — the frame is what makes it
          read as a photograph of a thing rather than as floating shapes. */}
      <div className="aspect-square w-full overflow-hidden border-b border-border-subtle bg-surface-sunken">
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
            className="h-full w-full object-contain p-5 transition-transform duration-200 group-hover:scale-[1.03]"
          />
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold leading-snug text-ink">
            <Link
              to={`/product/${product.slug}`}
              // Two things are happening here.
              //
              // `line-clamp-2` keeps a long industrial name from pushing the
              // price off the bottom of one card and leaving the row ragged.
              //
              // `after:absolute after:inset-0` is the stretched link: an empty
              // pseudo-element that covers the whole `relative` card above, so
              // a click anywhere on it follows this anchor. The anchor itself
              // is unchanged — same href, same text, same one entry in the tab
              // order — so middle-click, open-in-new-tab and the screen-reader
              // announcement all behave exactly as they did.
              //
              // The hover styling keys off `group-hover` as well as `hover`,
              // or the name would sit inert while the pointer is plainly over
              // its own card.
              className="line-clamp-2 rounded transition-colors after:absolute after:inset-0 after:content-['']
                         hover:text-brand hover:underline hover:decoration-brand/40 hover:underline-offset-2
                         group-hover:text-brand group-hover:underline group-hover:decoration-brand/40
                         group-hover:underline-offset-2"
            >
              {product.name}
            </Link>
          </h3>

          {/* The product code, which in B2B purchasing is how a line is
              actually identified — a buyer checking a card against a purchase
              order is looking for this and not for the name.

              The inner span is raised above the stretched link so the code can
              still be selected and copied. Only the glyphs are raised, not the
              whole line, so the empty space beside a short SKU still navigates
              with the rest of the card. */}
          <p className="mt-1 truncate font-mono text-xxs uppercase tracking-wide text-ink-subtle">
            <span className="relative z-[1] select-text">{product.sku}</span>
          </p>
        </div>

        {product.shortDescription !== null && (
          <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
            {product.shortDescription}
          </p>
        )}

        <div className="mt-auto pt-1">
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="text-base font-semibold tabular text-ink">
              {formatMoney(product.price)}
            </span>
            {hasDiscount && product.compareAtPrice !== null && (
              <span className="text-xs tabular text-ink-subtle">
                {/* The strikethrough is the only thing that says "was" to a
                    sighted reader; a screen reader gets the word itself. */}
                <span className="sr-only">{t('productCard.was')}</span>
                <s>{formatMoney(product.compareAtPrice)}</s>
              </span>
            )}
          </p>

          <p className="mt-1 text-xxs text-ink-subtle">
            {product.tax.inclusive
              ? 'Tax included'
              : `+ ${product.tax.ratePercent}% ${product.tax.code}`}
          </p>

          {hasRuleChips && (
            <div className="mt-2.5 flex flex-wrap gap-1 border-t border-border-subtle pt-2.5">
              {hasDiscount && <Badge tone="action">{t('productCard.reducedPrice')}</Badge>}
              {rules.minOrderQty > 1 && <Badge>Min {formatNumber(rules.minOrderQty)}</Badge>}
              {rules.qtyIncrement > 1 && <Badge>In {formatNumber(rules.qtyIncrement)}s</Badge>}
              {rules.isRecurringEligible && (
                <Badge tone="operational">{t('productCard.repeatPurchase')}</Badge>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

/** Matches the card's shape, so the grid does not reflow when data arrives. */
export function ProductCardSkeleton(): React.JSX.Element {
  return (
    <div
      className="h-full overflow-hidden rounded-lg border border-border bg-surface"
      aria-hidden="true"
    >
      <div className="skeleton aspect-square w-full rounded-none" />
      <div className="space-y-2 border-t border-border-subtle p-4">
        <div className="skeleton h-4 w-4/5" />
        <div className="skeleton h-3 w-1/3" />
        <div className="skeleton h-3 w-full" />
        <div className="skeleton h-5 w-1/3" />
      </div>
    </div>
  );
}
