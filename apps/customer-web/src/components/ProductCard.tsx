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
import { packSummary } from '@/lib/packaging';
import type { Product } from '@/lib/types';
import { useTilt } from '@/lib/pointer-tilt';
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

/**
 * One specification off the product, by name.
 *
 * The catalogue import writes Brand, Sterility, Packing type and the rest as
 * ordinary product specifications, so the card reads them the same way the
 * filter panel does rather than through a second, parallel field.
 */
function specification(product: Product, name: string): string | null {
  return product.attributes.find((attribute) => attribute.name === name)?.value ?? null;
}

export function ProductCard({ product }: { product: Product }): React.JSX.Element {
  const { t } = useI18n();

  const { purchaseRules: rules } = product;
  const hasDiscount =
    product.compareAtPrice !== null &&
    BigInt(product.compareAtPrice.minor) > BigInt(product.price.minor);

  // Absent on a response from a server that predates this, and "buyable" is
  // what every product was then.
  const purchasability = product.purchasability ?? null;
  const isPriceOnRequest = purchasability?.isPriceOnRequest ?? false;
  const isUnavailable = purchasability !== null && !purchasability.isOrderable;

  const brand = specification(product, 'Brand');
  const sterility = specification(product, 'Sterility');
  const model = product.variants.length === 1 ? (product.variants[0]?.name ?? null) : null;

  const packing = packSummary(product.packaging, {
    perPack: (count, pack) => t('productCard.perPack', { n: count, pack }),
    perCarton: (count) => t('productCard.perCarton', { n: count }),
  });

  /*
   * The bottom strip only earns its hairline when it has something in it.
   *
   * Recurring eligibility is deliberately NOT one of those things any more.
   * Every product a customer can buy can also be scheduled, so a chip saying
   * so appeared on every card in the grid — a badge that is always present
   * distinguishes nothing and only costs the row its scannability. What is
   * left here is the set of facts that genuinely vary between products.
   */
  const hasRuleChips = hasDiscount || rules.minOrderQty > 1 || rules.qtyIncrement > 1;

  // The lean towards the pointer. Mouse only, and nothing under reduced
  // motion — see lib/pointer-tilt.ts, which explains why this is four CSS
  // variables written through a ref rather than anything React re-renders.
  const tilt = useTilt();

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
      ref={tilt.ref}
      onPointerEnter={tilt.onPointerEnter}
      onPointerMove={tilt.onPointerMove}
      onPointerLeave={tilt.onPointerLeave}
      // `tilt` adds the lean and the highlight; everything else here is what
      // the card already did. The two are layered rather than merged on
      // purpose: the shadow and the border still carry the hover on a touch
      // screen, on a keyboard, and for anybody who has asked for less
      // motion, none of which get a tilt at all.
      className="tilt group relative flex h-full flex-col overflow-hidden rounded-lg border border-border
                 bg-surface shadow-card transition-[box-shadow,border-color,transform] hover:border-border-hover
                 hover:shadow-card-hover focus-within:border-brand/40 focus-within:shadow-card-hover"
    >
      {/* The media frame sits on the sunken ground with generous inset. Most
          of this catalogue is `object-contain` product photography on white,
          which on a white card has no edge at all — the frame is what makes it
          read as a photograph of a thing rather than as floating shapes. */}
      <div className="relative aspect-square w-full overflow-hidden border-b border-border-subtle bg-surface-sunken">
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

        {/* The specular, over the photograph and nowhere else.

            It was briefly over the whole card, which put an 18% blue veil
            across the price and the product code — a contrast cost for a
            decoration, and the one thing this card must never trade. On the
            media frame it is doing what a specular actually does: sliding
            across the surface of the thing being looked at. */}
        <span aria-hidden="true" className="tilt-sheen" />
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

        {/* What a buyer scanning a shelf of near-identical medical consumables
            actually tells them apart by. Three short facts on one line rather
            than three rows: the description underneath carries the same words
            in prose, and a card that repeats itself twice is a card nobody
            finishes reading.

            Each is dropped entirely when the catalogue does not have it — an
            em dash where a brand should be is worse than a shorter card. */}
        {(brand !== null || model !== null || sterility !== null) && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xxs text-ink-muted">
            {brand !== null && <span className="font-medium text-ink">{brand}</span>}
            {model !== null && (
              <>
                {brand !== null && <span aria-hidden="true">·</span>}
                <span>{model}</span>
              </>
            )}
            {sterility !== null && (
              <>
                {(brand !== null || model !== null) && <span aria-hidden="true">·</span>}
                <span>{sterility}</span>
              </>
            )}
          </p>
        )}

        {product.shortDescription !== null && (
          <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
            {product.shortDescription}
          </p>
        )}

        {/* How it is boxed, in one line. The full breakdown and the quantity
            calculator are on the product page; a card only has to answer "is
            this sold in the size I buy in". */}
        {packing !== null && (
          <p className="truncate text-xxs tabular text-ink-subtle">{packing}</p>
        )}

        <div className="mt-auto pt-1">
          {/* A price, or the reason there is not one.

              Never both, and never a figure of zero. A product whose price is
              negotiated per account genuinely has no number to show, and
              printing one would be quoting something nobody agreed to charge.
              The line keeps the same weight and position either way, so a grid
              of mixed products still scans down one column. */}
          {isPriceOnRequest ? (
            <p className="text-sm font-semibold text-brand">{t('productCard.requestAQuote')}</p>
          ) : (
            <>
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
                  ? t('productCard.taxIncluded')
                  : t('productCard.plusTaxRate', {
                      rate: product.tax.ratePercent,
                      code: product.tax.code,
                    })}
              </p>
            </>
          )}

          {(hasRuleChips || isUnavailable) && (
            <div className="mt-2.5 flex flex-wrap gap-1 border-t border-border-subtle pt-2.5">
              {/* First in the row, because it overrides everything else on the
                  card: a minimum order quantity is irrelevant on something
                  that cannot be ordered at all. */}
              {isUnavailable && <Badge tone="warning">{t('productCard.currentlyUnavailable')}</Badge>}
              {hasDiscount && !isPriceOnRequest && (
                <Badge tone="action">{t('productCard.reducedPrice')}</Badge>
              )}
              {rules.minOrderQty > 1 && <Badge>Min {formatNumber(rules.minOrderQty)}</Badge>}
              {rules.qtyIncrement > 1 && <Badge>In {formatNumber(rules.qtyIncrement)}s</Badge>}
            </div>
          )}

          {/* The affordance, not a second link.

              The whole card already follows the anchor on the name — see the
              header. A real button here would be a second tab stop and a
              second accessible name for one destination, which is exactly the
              blob that design avoids. This is inert text that inherits the
              card's hover state, so the card looks like what it is: one
              clickable thing. */}
          <p
            aria-hidden="true"
            className="mt-2.5 flex items-center gap-1 text-xxs font-medium text-ink-subtle
                       transition-colors group-hover:text-brand"
          >
            {t('productCard.viewDetails')}
            <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="m9 18 6-6-6-6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </p>
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
