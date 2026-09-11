/**
 * The products an assistant answer is about.
 *
 * The rule that shapes this whole file: **nothing on a card comes from the
 * model.** The reply supplies identifiers and nothing else — see
 * `lib/ai-products.ts` — and every pixel drawn here is read back from
 * `/catalog/product-cards`, which is the same public catalogue read the grid
 * and the product page use, under the same visibility filter. So an invented
 * product code produces no card, an unpublished product cannot appear, and
 * there is no route by which a URL that arrived in generated text reaches an
 * `img src`.
 *
 * That is worth the extra request. This catalogue is cannulae, feeding tubes
 * and flush syringes; a hallucinated product code with a confident price
 * beside it is somebody ordering the wrong device.
 *
 * Four states, all of them real and all of them said out loud:
 *
 *   - **Loading** is a skeleton the size of the cards, so the transcript does
 *     not jump when they land under an answer somebody is already reading.
 *   - **Nothing resolved** says so. An answer that named three products and
 *     then showed no cards would read as a failed render; "these are no longer
 *     listed" is information, and it is true.
 *   - **The read failed** offers Retry and leaves the written answer alone —
 *     the words above are still the reply, and they are still useful.
 *   - **Some resolved and some did not** says how many are missing rather than
 *     quietly showing fewer cards than the reply mentioned.
 *
 * The actions are the storefront's own, not new ones. The image and the name
 * open the existing product route; "View specifications" is the same
 * destination anchored at the specifications block; Add to cart posts to the
 * same cart API as everywhere else, and steps aside to the product page for
 * the two cases a card genuinely cannot decide — a product with options, and
 * a visitor with no account to have a cart on.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { useSession } from '@/auth/session-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, ButtonLink } from '@/components/ui';
import { AlertIcon, BoxIcon, CartIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { errorMessage } from '@/lib/errors';
import { formatMoney, formatNumber } from '@/lib/format';
import { clampToRules } from '@/lib/quantity-rules';
import { useI18n } from '@/i18n/i18n-context';
import type { Money, Product } from '@/lib/types';

/** One verified card: the public product shape, plus what there is to sell. */
export interface AiProductCard extends Omit<Product, 'price'> {
  /**
   * Null where this store does not sell the product in the shopper's own
   * currency.
   *
   * `Product` types this non-null because the pages that use it have already
   * refused to render an unpriced product. A card cannot: the reference came
   * from an answer, and the answer was written against the catalogue rather
   * than against one market's price list. So the state is admitted here and
   * the card says "not sold in this market" instead of quoting another one's
   * figure — which would price a JPY 5,000 item at USD 5,000.
   */
  price: Money | null;
  /** Which reference resolved to this product. Null for a fuzzy hit. */
  matchedRef: string | null;
  availability: {
    isStockTracked: boolean;
    inStock: boolean;
    /** Null for an untracked product: "not counted", never "none left". */
    availableQty: number | null;
  };
}

interface CardsResponse {
  products: AiProductCard[];
  /** References the catalogue could not resolve. Named, not hidden. */
  unresolved: string[];
  currency: string;
  country: string | null;
}

/**
 * The frame a photograph sits in, and what goes there when there is none.
 *
 * It sits down the right-hand edge of the card rather than across its top: a
 * reply names products in a line of prose, and a stack of tall photographs
 * under one answer pushes the rest of the transcript off the screen. A fixed
 * square beside the words keeps each product to one glanceable row — the name
 * and what it is on the left, the thing itself on the right.
 *
 * `onError` matters more here than anywhere else in the storefront: a card is
 * drawn under a chat answer, often minutes after the reply arrived, and a
 * media file that has since been moved would otherwise leave a broken-image
 * glyph where the product should be. Falling back to the plated icon says
 * "there is no photograph", which is a true statement and not an alarming one.
 */
function CardImage({ product }: { product: AiProductCard }): React.JSX.Element {
  const { t } = useI18n();
  const [failed, setFailed] = useState(false);

  const image = product.primaryImage;
  const showFallback = image === null || failed;

  return (
    <div className="relative aspect-square w-24 shrink-0 self-start overflow-hidden rounded-md border border-border-subtle bg-surface-sunken sm:w-32">
      {showFallback ? (
        <span
          aria-hidden="true"
          className="flex h-full w-full flex-col items-center justify-center gap-1.5 text-ink-subtle"
        >
          <span className="flex h-9 w-9 items-center justify-center rounded-full bg-surface ring-1 ring-inset ring-border">
            <BoxIcon className="h-4 w-4" />
          </span>
          <span className="hidden text-xxs font-medium uppercase tracking-wider sm:block">
            {t('productCard.noImageYet')}
          </span>
        </span>
      ) : (
        <img
          src={image.url}
          // The name is the link directly below. Repeating it here makes a
          // screen reader read the product twice for one card.
          alt={image.altText ?? ''}
          width={256}
          height={256}
          loading="lazy"
          decoding="async"
          onError={() => {
            setFailed(true);
          }}
          className="h-full w-full object-contain p-2 transition-transform duration-200 group-hover:scale-[1.03] motion-reduce:transition-none motion-reduce:group-hover:scale-100 sm:p-3"
        />
      )}
    </div>
  );
}

/** In stock, sold out, or a product this store does not count. */
function StockLine({ product }: { product: AiProductCard }): React.JSX.Element | null {
  const { t } = useI18n();
  const { availability } = product;

  // Untracked is not a stock statement. Rendering "in stock" for a product
  // nobody counts would be a promise this store has not made.
  if (!availability.isStockTracked) return null;

  if (!availability.inStock) {
    return (
      <span className="text-xxs font-medium text-danger">{t('aiProducts.outOfStock')}</span>
    );
  }

  return (
    <span className="text-xxs font-medium text-success">
      {availability.availableQty === null
        ? t('catalog.inStock')
        : t('aiProducts.availableCount', {
            count: availability.availableQty,
            quantity: formatNumber(availability.availableQty),
          })}
    </span>
  );
}

function ProductTile({ product }: { product: AiProductCard }): React.JSX.Element {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isCustomer } = useSession();

  const [addError, setAddError] = useState<string | null>(null);

  const rules = product.purchaseRules;
  const needsOptions = product.hasVariants && product.variants.length > 0;
  const soldOut = product.availability.isStockTracked && !product.availability.inStock;
  const unpriced = product.price === null;

  const add = useMutation({
    mutationFn: () =>
      api.post('/cart/items', {
        productId: product.id,
        variantId: null,
        // The minimum, clamped to the increment. A card cannot ask for a
        // quantity, so it asks for the smallest legal one — and clamping is
        // what stops a minimum of 10 with an increment of 4 sending a number
        // the server would only flag.
        quantity: clampToRules(rules.minOrderQty, rules),
      }),
    onSuccess: async () => {
      setAddError(null);
      toast.success(t('product.addedToYourCart'));
      await queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (error) => {
      // The server names the rule that was broken — a spend cap, a stock
      // shortfall, a minimum. Replacing that with "could not add" throws away
      // the only part that tells the customer what to change.
      setAddError(errorMessage(t, error, t('product.couldNotBeAdded')));
    },
  });

  return (
    <li className="min-w-0">
      {/* `relative` is the containing block for the stretched link below, so
          the whole tile is clickable while the only anchor in the tab order is
          the product name. See `components/ProductCard.tsx`, which explains
          the pattern at length; this is the same one at card scale. */}
      <article
        className="group relative flex h-full items-start gap-3.5 overflow-hidden rounded-lg border border-border bg-surface
                   p-3.5 shadow-card transition-[box-shadow,border-color] hover:border-border-hover hover:shadow-card-hover
                   focus-within:border-brand/40 focus-within:shadow-card-hover motion-reduce:transition-none"
      >
        {/* Words first in the source, photograph second — the card reads left
            to right on screen and top to bottom to a screen reader, and both
            orders put the product's name before its picture. */}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 self-stretch">
          <h4 className="text-sm font-semibold leading-snug text-ink">
            <Link
              to={`/product/${product.slug}`}
              className="line-clamp-2 rounded after:absolute after:inset-0 after:content-[''] hover:text-brand
                         hover:underline hover:decoration-brand/40 hover:underline-offset-2
                         group-hover:text-brand focus-visible:outline-none"
            >
              {product.name}
            </Link>
          </h4>

          {/* The product code, raised above the stretched link so a buyer
              checking a card against a purchase order can still select it. */}
          <p className="truncate font-mono text-xxs uppercase tracking-wide text-ink-subtle">
            <span className="relative z-[1] select-text">{product.sku}</span>
          </p>

          {product.shortDescription !== null && (
            <p className="line-clamp-2 text-xs leading-relaxed text-ink-muted">
              {product.shortDescription}
            </p>
          )}

          <div className="mt-auto space-y-1 pt-1.5">
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              {product.price === null ? (
                // Not sold in the shopper's market is a real state, and the
                // honest answer is to say so rather than quote another
                // market's figure — which would price a JPY 5,000 item at
                // USD 5,000.
                <span className="text-xs text-ink-muted">{t('aiProducts.notPricedHere')}</span>
              ) : (
                <>
                  <span className="text-sm font-semibold tabular text-ink">
                    {formatMoney(product.price)}
                  </span>
                  <span className="text-xxs text-ink-subtle">
                    {product.tax.inclusive
                      ? t('productCard.taxIncluded')
                      : t('productCard.plusTaxRate', {
                          rate: product.tax.ratePercent,
                          code: product.tax.code,
                        })}
                  </span>
                </>
              )}
            </p>

            <StockLine product={product} />

            {(rules.minOrderQty > 1 || rules.qtyIncrement > 1) && (
              <p className="flex flex-wrap gap-1 pt-0.5">
                {rules.minOrderQty > 1 && <Badge>Min {formatNumber(rules.minOrderQty)}</Badge>}
                {rules.qtyIncrement > 1 && <Badge>In {formatNumber(rules.qtyIncrement)}s</Badge>}
              </p>
            )}
          </div>

          {addError !== null && (
            <p
              role="alert"
              className="relative z-[1] rounded-md border border-danger/30 bg-danger-soft px-2.5 py-2 text-xxs text-danger"
            >
              {addError}
            </p>
          )}

          {/* Above the stretched link, or none of it would be clickable.
              Side by side rather than stacked: the card is a wide row now, and
              two full-width buttons down a column that also holds the name and
              the description would be the tallest thing in the transcript. */}
          <div className="relative z-[1] mt-2 flex flex-wrap gap-1.5 border-t border-border-subtle pt-2.5">
            <ButtonLink
              // The specifications heading, which is the anchor the product
              // page actually carries. A product with no attributes has no
              // specifications block and lands at the top of its own page,
              // which is the honest destination rather than a dead fragment.
              to={`/product/${product.slug}#specifications-heading`}
              size="sm"
              aria-label={t('aiProducts.viewSpecificationsOf', { product: product.name })}
            >
              {t('aiProducts.viewSpecifications')}
            </ButtonLink>

            {!isCustomer ? (
              // A guest has no cart to add to. The product page is where
              // signing in is offered in context, rather than a button here
              // that can only bounce them.
              <ButtonLink to={`/product/${product.slug}`} variant="primary" size="sm">
                {t('product.signInToOrder')}
              </ButtonLink>
            ) : needsOptions ? (
              // A product with options cannot be added from a card without
              // choosing one on the customer's behalf. It says which step is
              // next instead of guessing.
              <ButtonLink to={`/product/${product.slug}`} variant="primary" size="sm">
                {t('product.chooseAnOption')}
              </ButtonLink>
            ) : (
              <Button
                variant="action"
                size="sm"
                disabled={soldOut || unpriced}
                isLoading={add.isPending}
                onClick={() => {
                  add.mutate();
                }}
                aria-label={t('aiProducts.addToCartLabel', { product: product.name })}
              >
                <CartIcon className="h-4 w-4" aria-hidden="true" />
                {t('product.addToCart')}
              </Button>
            )}
          </div>
        </div>

        <CardImage product={product} />
      </article>
    </li>
  );
}

/** The card list's own silhouette, so nothing reflows when data arrives. */
function CardsSkeleton({ count }: { count: number }): React.JSX.Element {
  return (
    <div aria-hidden="true" className="grid gap-3">
      {Array.from({ length: Math.min(count, 3) }, (_unused, index) => (
        <div
          key={index}
          className="flex items-start gap-3.5 overflow-hidden rounded-lg border border-border bg-surface p-3.5"
        >
          <div className="flex-1 space-y-2">
            <div className="skeleton h-4 w-4/5" />
            <div className="skeleton h-3 w-1/3" />
            <div className="skeleton h-3 w-full" />
            <div className="skeleton h-7 w-2/3" />
          </div>
          <div className="skeleton aspect-square w-24 shrink-0 sm:w-32" />
        </div>
      ))}
    </div>
  );
}

/**
 * Verified cards for the references in one reply.
 *
 * Renders nothing at all when the reply named no products — most answers do
 * not, and a heading over an empty row would read as a failed render.
 */
export function AiProductCards({ refs }: { refs: readonly string[] }): React.JSX.Element | null {
  const { t, language } = useI18n();
  const { currency, country } = useLocale();
  const headingId = useId();

  const query = useQuery({
    // The market is part of the key: the same references priced for Germany
    // and for India are two different answers, and sharing one cache entry
    // would show a shopper the other market's figures.
    queryKey: ['ai-product-cards', refs.join(','), currency, country, language],
    queryFn: () =>
      api.get<CardsResponse>('/catalog/product-cards', {
        query: {
          refs: refs.join(','),
          currency,
          country: country ?? undefined,
          language,
        },
      }),
    enabled: refs.length > 0,
    // The catalogue does not move while somebody reads one answer, and this
    // component mounts once per assistant message in the transcript.
    staleTime: 5 * 60_000,
  });

  if (refs.length === 0) return null;

  return (
    <section aria-labelledby={headingId} className="mt-3">
      <h3
        id={headingId}
        className="mb-2 text-xxs font-semibold uppercase tracking-wider text-ink-subtle"
      >
        {t('aiProducts.heading')}
      </h3>

      {query.isPending && <CardsSkeleton count={refs.length} />}

      {query.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2.5 rounded-lg border border-border bg-surface-sunken px-3.5 py-3"
        >
          <AlertIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-muted" />
          <p className="min-w-0 flex-1 text-xs text-ink-muted">{t('aiProducts.couldNotLoad')}</p>
          <Button
            size="sm"
            onClick={() => {
              void query.refetch();
            }}
          >
            {t('aiMode.retry')}
          </Button>
        </div>
      )}

      {query.isSuccess && query.data.products.length === 0 && (
        <p
          role="status"
          className="rounded-lg border border-border bg-surface-sunken px-3.5 py-3 text-xs text-ink-muted"
        >
          {t('aiProducts.noneListed')}
        </p>
      )}

      {query.isSuccess && query.data.products.length > 0 && (
        <>
          {/* One per row, whatever the width.
              A card is a wide row now — name, description and actions beside
              the photograph — so two of them side by side would be two narrow
              columns of clipped text rather than two readable cards. */}
          <ul className="grid gap-3">
            {query.data.products.map((product) => (
              <ProductTile key={product.id} product={product} />
            ))}
          </ul>

          {query.data.unresolved.length > 0 && (
            <p role="status" className="mt-2 text-xxs text-ink-subtle">
              {t('aiProducts.someNoLongerListed', {
                count: query.data.unresolved.length,
                quantity: formatNumber(query.data.unresolved.length),
              })}
            </p>
          )}
        </>
      )}
    </section>
  );
}
