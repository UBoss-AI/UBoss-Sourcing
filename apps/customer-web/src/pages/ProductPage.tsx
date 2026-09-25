/**
 * Product detail — the page a purchasing decision is made on.
 *
 * Five things it must get right:
 *
 *   - **The purchasing rules are visible before Add to Cart.** Minimum,
 *     increment and maximum are part of the product, not a surprise at the
 *     cart. The quantity control enforces them as a convenience; the server
 *     enforces them as a rule.
 *   - **Stock is not claimed.** The public API deliberately does not publish
 *     quantities — a competitor should not be able to read stock levels off a
 *     storefront. So this page says stock is confirmed when the item is added,
 *     which is exactly what happens, rather than inventing a number.
 *   - **Price and tax are shown as the server states them.** Nothing here
 *     multiplies, adds tax or computes a discount; a line total on this page
 *     would be a second pricing engine, and it would eventually disagree.
 *   - **A product that has been unpublished 404s cleanly.** The API stops
 *     serving it the moment the admin unpublishes, and this page treats that
 *     as a normal outcome with a way onward.
 *   - **Everything reassuring on this page is already true.** The ordering
 *     panel below the buy button restates facts the API sent — how tax is
 *     handled, what quantities are allowed, the fulfilment wording, whether a
 *     schedule is possible. There are no ratings, no review counts, no
 *     delivery dates and no stock figures, because this storefront has none
 *     of those to tell the truth about.
 *
 * The right column is ordered as the decision is made: what it is, what it
 * costs, which one, how many, buy — and only then the detail that supports the
 * choice. The buy path lives in its own bordered panel so that on a phone,
 * where the gallery has just taken a full screen, the controls read as one
 * thing to work through rather than as four stacked fragments.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import { QuantityInput } from '@/components/QuantityInput';
import { BulkOrderPanel } from '@/components/catalog/BulkOrderPanel';
import { SaveForLaterButton } from '@/components/SaveForLaterButton';
import { PreorderButton } from '@/components/preorder/PreorderButton';
import { BulkSavingsPopover } from '@/components/BulkSavingsPopover';
import { BulkOffersDialog } from '@/components/BulkOffersDialog';
import { useQuantityDecision } from '@/lib/use-quantity-decision';
import type { QuantityCommitSource } from '@/components/QuantityInput';
import { BandPriceValue } from '@/components/BandPriceValue';
import { ProductInstructionsButton } from '@/components/ProductInstructionsButton';
import { ImageLightbox } from '@/components/ImageLightbox';
import { clampToRules, describeRules } from '@/lib/quantity-rules';
import { MAX_LINE_NOTE_CHARS, noteForWire } from '@/lib/line-note';
import {
  Badge,
  Button,
  ButtonAnchor,
  ButtonLink,
  ErrorState,
  Field,
  LoadingState,
  Textarea,
} from '@/components/ui';
import { BoxIcon, CurrencyIcon, TruckIcon } from '@/components/icons';
import { ApiError, api } from '@/lib/api';
import { formatMoneyMinor, formatNumber, multiplyMinor } from '@/lib/format';
import { useDocumentMeta, useJsonLd } from '@/lib/useDocumentMeta';
import { canonicalUrl, productJsonLd } from '@/lib/seo';
import { ApproximatePrice } from '@/components/ApproximatePrice';
import { NotFoundPage } from './NotFoundPage';
import type {
  Product,
  ProductDetailResponse,
  ProductPackaging,
  ProductVariant,
  PurchaseRules,
  TaxInfo,
} from '@/lib/types';
import { VariantSelector } from '@/components/VariantSelector';
import { useVariantAxes } from '@/lib/use-variant-axes';
import {
  lineContent,
  resolveVariants,
  rulesForVariant,
  selectionFromParams,
  selectionToParams,
  summarisePack,
} from '@/lib/variants';
import { ProductSafetyPanel } from '@/components/ProductSafetyPanel';
import { ProductDevicePanel } from '@/components/ProductDevicePanel';
import { ProductInformation } from '@/components/product-info/ProductInformation';
import { DimensionsSection, PackagingSection } from '@/components/ProductPackagingPanel';
import {
  isSoldByThePiece,
  sellUnitOf,
  sellUnitPriceMinor,
  usePiecesPerCarton,
  type OrderingUnit,
} from '@/lib/packaging';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { usePointerZoom } from '@/lib/pointer-zoom';

/**
 * The image gallery.
 *
 * The hero sits on the sunken ground inside a hairline frame, because almost
 * every product photograph in this catalogue is `object-contain` on white —
 * on a white card there is no edge at all, and the product reads as floating
 * shapes rather than as a photograph of a thing.
 *
 * **Hovering it magnifies the part under the pointer.** A consumables
 * catalogue is photographs of things with printed scales, gauge markings and
 * product codes on them, and a 500px square is not enough to read those —
 * so the one thing a buyer most wants to do with this image is look closer at
 * a particular bit of it. See `.zoom-layer` in index.css for how, and
 * `lib/pointer-zoom.ts` for why it is two CSS variables rather than anything
 * React re-renders.
 */
function Gallery({
  product,
  variant,
}: {
  product: Product;
  /** The size or colour currently chosen, where the page has narrowed to one. */
  variant?: ProductVariant | null;
}): React.JSX.Element {
  const { t } = useI18n();

  /**
   * The chosen variant's own photographs, falling back to the product's.
   *
   * A fallback rather than a merge: a seller who photographed the brown boot
   * means those to be the pictures of the brown boot, and appending the black
   * ones after them shows the buyer a colour they did not choose. A variant
   * with no photographs of its own shows the family's, which is the ordinary
   * case and is why the fallback exists at all.
   */
  const variantImages = variant?.images ?? [];
  const images = variantImages.length > 0 ? variantImages : product.images;

  const [activeIndex, setActiveIndex] = useState(0);

  /**
   * Whether the full-screen view is up.
   *
   * The hover magnifier and this are not alternatives — they answer different
   * questions. The magnifier answers "what does that bit say?" without leaving
   * the page; the lightbox answers "let me actually look at this", which needs
   * the whole window, a zoom that stays where it is put and somewhere to drag
   * to. Both are on the same photograph, and the second is reached by pressing
   * it, which is what a photograph that grows when you click it has meant on
   * every catalogue since catalogues had photographs.
   */
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);

  // Back to the first photograph whenever the set changes. Holding index 3
  // across a switch to a variant with two pictures shows the fallback, which
  // reads as the gallery having failed.
  useEffect(() => {
    setActiveIndex(0);
  }, [variant?.id]);

  const active = images[activeIndex] ?? product.primaryImage;

  // Where the pointer is over the photograph, for the magnifier. Called
  // before the early return below, because a hook cannot be conditional —
  // and harmless there, since nothing reads it on the no-image path.
  const zoom = usePointerZoom();

  if (active == null) {
    return (
      <div
        aria-hidden="true"
        className="flex aspect-square w-full flex-col items-center justify-center gap-3 rounded-xl border border-border bg-surface-sunken text-ink-subtle"
      >
        <span className="flex h-20 w-20 items-center justify-center rounded-full bg-surface ring-1 ring-inset ring-border">
          <svg
            viewBox="0 0 24 24"
            className="h-10 w-10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="m21 15-5-5L5 21" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="text-xs font-medium uppercase tracking-wider">
          {t('product.noImageYet')}
        </span>
      </div>
    );
  }

  return (
    <div>
      {/*
       * The padding is on the frame, not on the image.
       *
       * It used to be `p-6 sm:p-8` on the `<img>`, which was fine until the
       * zoom layer arrived: two images with different padding have different
       * content boxes, and the magnified point is then near the point that was
       * hovered rather than the point that was hovered. On the frame, both
       * fill the same box and the mapping is exact.
       */}
      <div className="overflow-hidden rounded-xl border border-border bg-surface-sunken p-6 shadow-card sm:p-8">
        {/*
         * A real `<button>` around the photograph, not a click handler on the
         * `<img>`.
         *
         * Pressing the picture is the gesture, and a gesture that only a mouse
         * can perform is half a feature. Wrapping it in a button gives it a tab
         * stop, Enter and Space, a focus ring and an accessible name that says
         * what pressing it does — none of which a `<div onClick>` has, and all
         * of which somebody buying from a keyboard needs.
         *
         * The zoom handlers stay on the element inside it: the magnifier is a
         * hover effect and the button is a press, so they never contend for
         * the same event.
         */}
        <button
          type="button"
          onClick={() => {
            setIsLightboxOpen(true);
          }}
          aria-label={t('product.openFullScreenImage')}
          className="block w-full rounded-lg focus-visible:outline focus-visible:outline-2
                     focus-visible:outline-offset-4 focus-visible:outline-brand"
        >
        <div
          ref={zoom.ref}
          onPointerEnter={zoom.onPointerEnter}
          onPointerMove={zoom.onPointerMove}
          onPointerLeave={zoom.onPointerLeave}
          className="zoom-viewport aspect-square w-full"
        >
          <img
            src={active.url}
            alt={active.altText ?? product.name}
            // The hero image is the largest paint on this page, so it is not
            // lazy — deferring it delays the metric it defines.
            loading="eager"
            decoding="async"
            width={800}
            height={800}
            className="h-full w-full object-contain"
          />

          {/*
           * The magnifier: the same file again at 2.5x, slid so the part
           * under the cursor stays under the cursor. Same `src`, so it is
           * already in the cache and costs no request — and `aria-hidden`,
           * because it is the image above it, and a screen reader being told
           * about a product photograph twice is worse than not being told
           * about the zoom.
           */}
          <img
            aria-hidden="true"
            src={active.url}
            alt=""
            loading="eager"
            decoding="async"
            className="zoom-layer"
          />
        </div>
        </button>

        {/* Said in words under the picture, because the `zoom-in` cursor says
            it only to a mouse and says the wrong thing about what a press
            does. `aria-hidden`: the button above it already carries the same
            sentence as its accessible name, and hearing it twice is worse
            than hearing it once. */}
        <p aria-hidden="true" className="mt-2 text-center text-xxs text-ink-subtle">
          {t('product.clickToEnlarge')}
        </p>
      </div>

      {/* `images` and not `[active]`: the full-screen view steps between the
          photographs too, so it needs the set rather than the one currently
          shown. The fallback covers the product whose only picture is
          `primaryImage` with an empty `images` — rare, but it is the case
          where `active` above is non-null and the list is not. */}
      <ImageLightbox
        images={images.length > 0 ? images : [active]}
        startIndex={activeIndex}
        isOpen={isLightboxOpen}
        onClose={() => {
          setIsLightboxOpen(false);
        }}
        title={product.name}
      />

      {images.length > 1 && (
        <ul className="mt-3 flex snap-x gap-2 overflow-x-auto pb-1">
          {images.map((image, index) => {
            const isActive = index === activeIndex;

            return (
              <li key={image.url} className="snap-start">
                <button
                  type="button"
                  onClick={() => {
                    setActiveIndex(index);
                  }}
                  aria-label={t('product.viewImageOf', {
                    index: String(index + 1),
                    total: String(images.length),
                  })}
                  aria-current={isActive}
                  // The selected thumbnail carries a ring as well as a border.
                  // A 2px border colour change alone is the kind of state that
                  // disappears on a phone in daylight.
                  className={`block h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 bg-surface transition-colors ${
                    isActive
                      ? 'border-brand ring-2 ring-brand/20'
                      : 'border-border hover:border-border-hover'
                  }`}
                >
                  <img
                    src={image.url}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    width={64}
                    height={64}
                    className="h-full w-full object-contain p-1"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Variant picker — a multiple choice, not a single one.
 *
 * A hospital buyer does not choose between 3 ml and 5 ml syringes; they need
 * both, and until this page let them say so the only way to buy both was to
 * add one, navigate back, and add the other. So every option can be turned on,
 * and each one that is on carries its own quantity beside it — "two boxes of
 * the 3 ml and ten of the 5 ml" is the ordinary request in this trade, not the
 * unusual one.
 *
 * Each option's own price is printed in its row. The panel above can show only
 * one figure, and the moment two options are chosen that figure is a band, so
 * the per-option price has to live somewhere — and the row it belongs to is
 * where it is looked for.
 *
 * Toggle buttons with `aria-pressed` rather than checkboxes: each row holds a
 * number input of its own, and a checkbox whose label contains a spinbutton is
 * not a shape assistive technology reads well.
 *
 * The purchasing rules are stated once, under the legend, rather than under
 * every stepper. They are the product's, so they are the same on each row; the
 * same grey sentence four times is noise where one copy of it was guidance.
 */
/**
 * The option list.
 *
 * `hidePrices` is set for a product quoted per account. Its options are stored
 * at zero - the figure exists only so the listing query can reach the product
 * at all - and printing "₹0.00" beside every size would offer several hundred
 * medical items for nothing. The choice is still a real choice: the sizes have
 * different barcodes, different cartons and different lead times, and the
 * quotation is written against whichever one is asked for.
 */
function VariantPicker({
  variants,
  chosen,
  rules,
  hidePrices,
  priceOf,
  currency,
  onToggle,
  onQuantityChange,
  onQuantityCommit,
}: {
  variants: ProductVariant[];
  /** Option id to the quantity wanted. An absent id is an option not chosen. */
  chosen: ReadonlyMap<string, number>;
  rules: PurchaseRules;
  hidePrices: boolean;
  /**
   * This option's price in the unit being counted, as minor units.
   *
   * A function rather than a figure, because the answer depends on the option
   * AND on the control above the list - and two sizes of one product are not
   * always boxed the same, so the factor is per row.
   */
  priceOf: (variant: ProductVariant) => string;
  currency: string;
  onToggle: (variant: ProductVariant) => void;
  onQuantityChange: (variant: ProductVariant, quantity: number) => void;
  /** A settled quantity for one option - see QuantityInput's onCommit. */
  onQuantityCommit?: (
    variant: ProductVariant,
    quantity: number,
    source: QuantityCommitSource,
    previous: number,
  ) => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const ruleText = describeRules(t, rules);

  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">{t('product.chooseAnOption')}</legend>

      <p className="mt-1 text-xs text-ink-muted">{t('product.pickAsManyAsYouNeed')}</p>
      {ruleText !== null && <p className="mt-0.5 text-xs text-ink-muted">{ruleText}</p>}

      <ul className="mt-2.5 space-y-2">
        {variants.map((variant) => {
          const wanted = chosen.get(variant.id);
          const isChosen = wanted !== undefined;
          /*
           * Whether this one can be had now.
           *
           * `isInStock` is a boolean the server sends - never a quantity,
           * because this storefront does not publish warehouse figures.
           * Null or absent means the question has no answer here (an
           * untracked product), and that is purchasable: stock is confirmed
           * when the item goes in the basket.
           */
          const isSoldOut = variant.isInStock === false;
          const optionText = Object.entries(variant.options)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');

          return (
            <li
              key={variant.id}
              className={`rounded-lg border transition-colors ${
                isChosen
                  ? 'border-brand bg-brand-soft ring-1 ring-inset ring-brand/30'
                  : isSoldOut
                    ? 'border-border bg-surface-sunken'
                    : 'border-border-strong bg-surface hover:border-brand/40 hover:bg-surface-hover'
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-2.5 sm:flex-nowrap">
                <button
                  type="button"
                  aria-pressed={isChosen}
                  // Nothing useful to do with an option that has nothing
                  // behind it. Ticking it only defers the refusal to the cart.
                  disabled={isSoldOut}
                  aria-label={
                    isSoldOut
                      ? `${variant.name}, ${t('variants.outOfStock')}`
                      : undefined
                  }
                  onClick={() => {
                    onToggle(variant);
                  }}
                  className={`flex min-w-0 flex-1 items-center gap-3 rounded text-left ${
                    isSoldOut ? 'cursor-not-allowed' : ''
                  }`}
                >
                  {/* A box that fills, rather than a tick that appears. With
                      five options on screen, "which of these are on?" has to
                      be answerable from the corner of the eye. */}
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
                      isChosen
                        ? 'border-brand bg-brand-fill text-white'
                        : isSoldOut
                          ? 'border-border bg-surface-sunken'
                          : 'border-border-strong bg-surface'
                    }`}
                  >
                    {isChosen && (
                      <svg
                        viewBox="0 0 16 16"
                        className="h-3.5 w-3.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                      >
                        <path
                          d="m3 8.5 3.5 3.5L13 5"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </span>

                  <span className="min-w-0">
                    <span
                      className={`block text-sm font-medium ${
                        isChosen
                          ? 'text-brand'
                          : isSoldOut
                            ? 'text-ink-subtle line-through decoration-ink-subtle/70'
                            : 'text-ink'
                      }`}
                    >
                      {variant.name}
                    </span>

                    {/* Said in words as well as drawn, because roughly one
                        man in twelve cannot rely on the grey. */}
                    {isSoldOut && (
                      <span className="mt-0.5 block text-xxs font-medium uppercase tracking-wide text-ink-subtle">
                        {t('variants.outOfStock')}
                      </span>
                    )}
                    {optionText !== '' && (
                      <span className="mt-0.5 block text-xxs text-ink-muted">{optionText}</span>
                    )}
                  </span>

                  {variant.price !== null && !hidePrices && (
                    <span className="ml-auto shrink-0 pl-2 text-sm tabular text-ink-muted">
                      {formatMoneyMinor(priceOf(variant), currency)}
                    </span>
                  )}
                </button>

                {/* Beside the option it counts, not in one box below the list:
                    with two options chosen, a single quantity field cannot say
                    which of the two numbers belongs to which. */}
                {isChosen && (
                  <div className="w-full border-t border-border-subtle pt-3 sm:w-auto sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
                    <QuantityInput
                      value={wanted}
                      onChange={(next) => {
                        onQuantityChange(variant, next);
                      }}
                      onCommit={(next, source, previous) => {
                        onQuantityCommit?.(variant, next, source, previous);
                      }}
                      rules={rules}
                      label={t('product.quantityFor', { variant: variant.name })}
                      itemName={variant.name}
                      ruleHint={false}
                    />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}

/**
 * One thing the customer has chosen, and how they are counting it.
 *
 * `quantity` is pieces. Always pieces - it is what the basket, the warehouse
 * and the invoice count in, and the pack figures beside it exist so the same
 * choice can be shown back in the words the customer used.
 */
interface ChosenLine {
  variantId: string | null;
  quantity: number;
  orderingUnit: OrderingUnit;
  unitQuantity: number;
  piecesPerUnit: number;
}

/**
 * This size's own packing, falling back to the product's.
 *
 * A size whose packing was never recorded separately is boxed like the product
 * it belongs to, which is both the honest default and what the server does
 * when it converts the same line.
 */
function packagingFor(product: Product, variantId: string | null): ProductPackaging | null {
  if (variantId === null) return product.packaging ?? null;
  const variant = product.variants.find((candidate) => candidate.id === variantId);
  return variant?.packaging ?? product.packaging ?? null;
}

/** One line of the ordering panel. */
interface OrderingFact {
  key: string;
  icon: React.JSX.Element;
  term: string;
  detail: string;
}

/**
 * The sentence under the price.
 *
 * The rate the server sends is the one it used, which in a deployment selling
 * across the EU is the destination member state's rather than the tax class's
 * own. Naming the country is the point: a shopper who has just switched from
 * Germany to Ireland sees the number move, and "23% Irish VAT" is the
 * difference between a price they trust and one they suspect.
 *
 * Where the supply carries no tax at all — an export, or a reverse charge —
 * there is no country and no rate to name, so it says so plainly instead of
 * printing "0%", which reads as a rounding error rather than as a rule.
 */
function taxLine(
  t: Translate,
  tax: TaxInfo,
  countryNames: ReadonlyMap<string, string>,
): string {
  if (tax.country === null) {
    if (tax.treatment === 'EXPORT') return t('product.noVatOutsideEu');
    if (tax.treatment === 'INTRA_EU_REVERSE_CHARGE') {
      return t('product.reverseCharge');
    }

    return tax.inclusive
      ? t('product.includesRate', { rate: tax.ratePercent, code: tax.code })
      : t('product.rateAddedAtCheckout', { rate: tax.ratePercent, code: tax.code });
  }

  // The full name where the deployment has one for this country, the ISO code
  // where it does not — never a bare code when a name is available, because
  // "23% IE VAT" is a worse sentence than "23% Ireland VAT" for no reason.
  const where = countryNames.get(tax.country) ?? tax.country;

  return tax.inclusive
    ? t('product.includesVatWhere', { rate: tax.ratePercent, where })
    : t('product.vatWhereAddedAtCheckout', { rate: tax.ratePercent, where });
}

/**
 * Ordering information — the purchase-confidence panel.
 *
 * Every fact here is something the API already stated about this product,
 * and every one of them VARIES between products. Nothing is inferred,
 * averaged or aspirational: the tax treatment comes from `tax`, the quantity
 * rules from `purchaseRules`, the fulfilment wording from `isStockTracked` —
 * which is the same sentence this page has always shown.
 *
 * A "Repeat purchase" row used to sit here too. It went when scheduling
 * became true of everything the store sells: a fact that is the same on every
 * product page is not a fact this panel is for.
 *
 * Compact by construction: a two-column grid of short term/detail pairs, so
 * it supports the decision from the corner of the eye instead of becoming
 * another block of prose to read before buying.
 */
function OrderingInformation({ product }: { product: Product }): React.JSX.Element {
  const { t } = useI18n();

  const rules = product.purchaseRules;
  const facts: OrderingFact[] = [];

  facts.push({
    key: 'tax',
    icon: <CurrencyIcon className="h-4 w-4" />,
    term: t('product.tax'),
    detail: product.tax.inclusive
      ? t('product.includedInThePriceShown')
      : t('product.addedAtCheckoutAtRate', { rate: product.tax.ratePercent }),
  });

  const quantityParts: string[] = [];
  if (rules.minOrderQty > 1)
    quantityParts.push(t('product.minimumQuantity', { quantity: formatNumber(rules.minOrderQty) }));
  if (rules.qtyIncrement > 1)
    quantityParts.push(t('product.inMultiplesOf', { step: formatNumber(rules.qtyIncrement) }));
  if (rules.maxOrderQty !== null)
    quantityParts.push(t('product.upToQuantity', { quantity: formatNumber(rules.maxOrderQty) }));

  facts.push({
    key: 'quantity',
    icon: <BoxIcon className="h-4 w-4" />,
    term: t('product.orderQuantity'),
    detail:
      quantityParts.length === 0
        ? t('product.anyQuantityFromOne')
        : `${quantityParts.join(', ')}.`,
  });

  facts.push({
    key: 'availability',
    icon: <TruckIcon className="h-4 w-4" />,
    term: t('product.availability'),
    // Deliberately not a stock number. The public catalogue does not publish
    // quantities, and inventing "In stock" would be a claim this page cannot
    // back.
    detail: product.isStockTracked
      ? t('product.availabilityConfirmedInCart')
      : t('product.madeToOrder'),
  });

  /*
   * No "Repeat purchase" row in the ordering facts.
   *
   * This panel is for what is true of THIS product and not of the next one —
   * its minimum, its increment, whether stock is tracked. Scheduling is true
   * of everything the store sells, so the row appeared on every product page
   * and told the reader nothing they could not assume.
   *
   * The capability itself is not hidden: `canSchedule` still gates the
   * "Schedule your Cart" button further down, which is where a customer can
   * actually do something about it.
   */

  return (
    <section
      aria-labelledby="ordering-information-heading"
      className="mt-5 rounded-lg border border-border bg-surface-sunken px-4 py-4"
    >
      <h2 id="ordering-information-heading" className="text-title-xs text-ink">
        {t('product.orderingInformation')}
      </h2>

      <dl className="mt-3 grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2">
        {facts.map((fact) => (
          <div key={fact.key} className="flex gap-2.5">
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-surface text-ink-muted ring-1 ring-inset ring-border"
            >
              {fact.icon}
            </span>
            <div className="min-w-0">
              <dt className="text-xs font-semibold text-ink">{fact.term}</dt>
              <dd className="mt-0.5 text-xs leading-relaxed text-ink-muted">{fact.detail}</dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function ProductPage(): React.JSX.Element {
  const { t, language, intlLocale } = useI18n();

  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isCustomer } = useSession();
  const { business, features } = useStorefront();

  /**
   * The options turned on, and how many of each.
   *
   * A map rather than one selected id, because the whole point of this page is
   * that a customer can want the 3 ml *and* the 5 ml, and each of those needs
   * a number of its own. Insertion order is never read — the picker renders in
   * catalogue order, so the list does not reshuffle as options are clicked.
   */
  const [chosen, setChosen] = useState<ReadonlyMap<string, number>>(new Map());
  /** The quantity for a product that has no options to choose between. */
  const [quantity, setQuantity] = useState(1);
  const [addError, setAddError] = useState<string | null>(null);

  /**
   * What the buyer needs done to this product, in their own words.
   *
   * Sent with the add and stored on the basket line, not held here: a note
   * that lived only in this component would be gone the moment they carried
   * on browsing, which is the worst possible behaviour for a box somebody has
   * typed a paragraph into.
   *
   * ONE box for the whole add, even when several options are being added at
   * once. A hospital buying 3 ml and 5 ml of the same syringe is placing one
   * instruction about one product - "sterile packs, split across two boxes" -
   * and asking them to type it twice, into two boxes that look identical, is
   * how one of the two ends up blank. The server puts the same words on each
   * line it writes, which is what the buyer meant.
   */
  const [lineNote, setLineNote] = useState('');

  /**
   * The guided selection: axis key to the value chosen, for a product whose
   * seller declared the dimensions it sells along.
   *
   * Held in the URL rather than only in state, so a shared link opens on the
   * black size 8 the sender was looking at, and a refresh does not throw the
   * choice away. The parameters are the axis keys themselves —
   * `?colour=black&size=8` — which is readable, and which is why the keys are
   * stable enough that renaming one is a migration.
   */
  const [searchParams, setSearchParams] = useSearchParams();
  const [selection, setSelection] = useState<Readonly<Record<string, string>>>({});
  /** Set after a failed Add to Basket, to put the caret on the first gap. */
  const [focusAxisKey, setFocusAxisKey] = useState<string | null>(null);

  /**
   * What the numbers on this page are counting.
   *
   * There is no control for this and no state behind it, and there must not
   * be: it is a fact about WHO IS SELLING the product, not a choice the
   * shopper gets. The operator sells cartons; a third-party seller sells
   * pieces. Every quantity box on the page counts in whichever it is, and
   * every price on the page is the price of one of it.
   *
   * Decided by the server and sent on the product. This page multiplies by the
   * factor it is given and never works one out - the basket is priced on the
   * same basis by the same rule, and a page that derived its own would
   * eventually quote a figure the basket disagreed with.
   */
  const piecesPerCarton = usePiecesPerCarton();

  const { currency, country, countries } = useLocale();

  // For turning the ISO code the server names its rate country by into
  // something readable. The list is already in context for the picker.
  const countryNames = useMemo(
    () => new Map(countries.map((entry) => [entry.code, entry.name])),
    [countries],
  );

  // `country` sits in the key beside `currency`: it does not change which
  // product comes back, it changes what it costs, because the server quotes
  // the price under the destination's VAT rather than the seller's.
  const query = useQuery({
    queryKey: ['product', slug, currency, country, language],
    queryFn: () =>
      api.get<ProductDetailResponse>(`/catalog/products/${String(slug)}`, {
        query: { currency, country: country ?? undefined, language },
      }),
    enabled: slug !== undefined,
    retry: false,
  });

  const product = query.data?.product;

  /*
   * The packages this seller sells this in.
   *
   * An empty array while the query is in flight and for the overwhelming
   * majority of products afterwards, and the panel renders nothing at all for
   * an empty one - so a product with no bulk packaging draws exactly the page
   * it drew before any of this existed.
   */
  const packagingOptions = query.data?.packagingOptions ?? [];

  // What this product is counted and priced in. Derived here rather than with
  // the rest of the storefront context above because it depends on the product
  // itself - see the note on the carton size. An empty object while the query
  // is in flight, which falls back to the operator's carton and renders
  // nothing anyway.
  const sellUnit = sellUnitOf(product ?? {}, piecesPerCarton);
  const soldByThePiece = isSoldByThePiece(sellUnit);

  // Set the opening quantity to the lowest the rules allow, and turn on the
  // only option when there is exactly one — an unnecessary choice is friction.
  //
  // Nothing is turned on when there are several. With a single choice a
  // preselection saves a click; with a multiple choice it is a decision made
  // on the customer's behalf, and the one it would make is "you want the first
  // one", which is a guess.
  useEffect(() => {
    if (product === undefined) return;

    const opening = clampToRules(product.purchaseRules.minOrderQty, product.purchaseRules);
    setQuantity(opening);

    // The only option is switched on for them - unless there is nothing
    // behind it, in which case switching it on would only defer the refusal
    // to the cart.
    const only = product.variants.length === 1 ? product.variants[0] : undefined;
    const usable = only !== undefined && only.isInStock !== false ? only : undefined;
    setChosen(usable === undefined ? new Map() : new Map([[usable.id, opening]]));
  }, [product]);

  /**
   * The axes this product is chosen along, and their definitions.
   *
   * Empty for everything that has always been sold off a list of options, and
   * that is the ordinary case — the request below is not even made for one.
   */
  const axisKeys = useMemo(() => product?.variantAxisKeys ?? [], [product]);
  const isGuided = axisKeys.length > 0 && (product?.variants.length ?? 0) > 0;
  const { axes: axisDefinitions, isLoading: axesLoading } = useVariantAxes(
    isGuided ? (product?.variantTemplateSlug ?? null) : null,
  );

  /**
   * Seed the selection from the URL, or from the only thing on offer.
   *
   * A link is honoured first, because somebody followed it to see a particular
   * thing. What it cannot name — an axis the seller has since removed, a
   * colour no longer stocked — is dropped rather than carried, so a stale
   * bookmark opens partly filled instead of on an impossible state.
   *
   * An axis with exactly one value is answered automatically. Asking somebody
   * to choose between one option is not a choice, it is a click.
   */
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (product === undefined || axisKeys.length === 0) return;
    // Once per product. Choosing a value writes to the URL, so re-running on
    // every `searchParams` change would feed the shopper's own choice back in
    // and fight the state it just set.
    if (seededFor.current === product.id) return;
    seededFor.current = product.id;

    const fromLink = selectionFromParams(axisKeys, searchParams, product.variants);

    const seeded: Record<string, string> = { ...fromLink };
    for (const axisKey of axisKeys) {
      if (seeded[axisKey] !== undefined) continue;

      const values = new Set(
        product.variants
          .filter((variant) => variant.isActive !== false)
          .map((variant) => variant.options[axisKey])
          .filter((value): value is string => value !== undefined && value !== ''),
      );

      const only = [...values][0];
      if (values.size === 1 && only !== undefined) seeded[axisKey] = only;
    }

    setSelection(seeded);
  }, [product, axisKeys, searchParams]);

  /**
   * What the current selection resolves to.
   *
   * One derived value rather than several pieces of state that have to be kept
   * in step: which values are still possible, which variant is identified,
   * what is still unanswered and what the price band is all come out of the
   * same pass over the variant list.
   */
  const resolution = useMemo(
    () =>
      product === undefined || !isGuided
        ? null
        : resolveVariants(axisKeys, axisDefinitions, product.variants, selection),
    [product, isGuided, axisKeys, axisDefinitions, selection],
  );

  const selectedVariant = resolution?.variant ?? null;

  /**
   * Bring the quantity onto the chosen size's own terms.
   *
   * A product sold in ones can have a pallet size sold in twenty-fours. Leaving
   * the box on 1 after somebody picks the pallet means Add to Basket is
   * refused by the server for a rule the page had already been told about —
   * which reads as the page being broken rather than as the seller's terms.
   *
   * Only ever upward, to the nearest permitted step. It never reduces what
   * somebody typed.
   */
  useEffect(() => {
    if (product === undefined || selectedVariant === null) return;

    const variantRules = {
      ...product.purchaseRules,
      ...rulesForVariant(product.purchaseRules, selectedVariant),
    };

    setQuantity((current) => {
      const clamped = clampToRules(current, variantRules);
      return clamped === current ? current : clamped;
    });
  }, [product, selectedVariant]);

  /** Record a choice, and put it in the URL so the page can be shared. */
  const chooseAxisValue = (axisKey: string, label: string): void => {
    setSelection((current) => {
      // Tapping the chosen value again clears it, which is the only way back
      // to "show me everything" once a colour has narrowed the size run.
      const isClearing = current[axisKey] === label || label === '';

      const next = Object.fromEntries(
        Object.entries(current).filter(([key]) => key !== axisKey),
      );
      if (!isClearing) next[axisKey] = label;

      setSearchParams(
        (params) => {
          const updated = new URLSearchParams(params);
          for (const key of axisKeys) updated.delete(key);
          for (const [key, value] of Object.entries(selectionToParams(next))) {
            updated.set(key, value);
          }
          return updated;
        },
        // A variant choice is not a page somebody wants to press Back through
        // four times to leave.
        { replace: true },
      );

      return next;
    });

    setFocusAxisKey(null);
    setAddError(null);
  };

  // `exactOptionalPropertyTypes` means an absent description is an absent key,
  // not a key holding undefined — so the object is built before it is passed.
  const description =
    product === undefined
      ? null
      : (product.shortDescription ??
        t('product.availableFrom', { product: product.name, store: business.displayName }));

  useDocumentMeta(
    {
      title: product?.name ?? t('product.productLabel'),
      ...(description === null ? {} : { description }),
      // The primary photograph is what a pasted link previews with, and
      // `product` is the Open Graph type that gets a product card rather than
      // a plain summary.
      imageUrl: product?.primaryImage?.url ?? null,
      type: 'product',
    },
    business.displayName,
  );

  /*
   * The rich result: a Product with an Offer.
   *
   * Built from the same figures the page renders, never from a second fetch,
   * so a price in a search result cannot disagree with the price on the page -
   * which Google treats as a commitment and penalises a mismatch on.
   *
   * `price` is passed as the exact decimal STRING the API sent. schema.org
   * permits a number and Google accepts one, but putting it through `Number`
   * here would reintroduce, in the last hundred lines of the stack, the float
   * error the whole money design exists to avoid.
   */
  useJsonLd(
    'product',
    product === undefined
      ? null
      : productJsonLd({
          name: product.name,
          description: product.shortDescription,
          sku: product.sku,
          // GPSR Art. 19 carries the manufacturer where the catalogue has it.
          // Absent for most of a catalogue, and a Brand with no name is worse
          // than no Brand at all.
          brand:
            product.safety?.manufacturer?.tradeName ??
            product.safety?.manufacturer?.legalName ??
            null,
          imageUrls: product.images.map((image) => image.url).slice(0, 6),
          url: canonicalUrl(`/product/${product.slug}`),
          price: product.price.formatted,
          currency: product.price.currency,
          // Null means "the question has no answer", and the page treats that
          // as purchasable: stock is confirmed when the item reaches the
          // basket. Publishing OutOfStock for it would be a claim nobody made.
          inStock: product.isInStock !== false,
          // A worked-out figure publishes no offer at all - see productJsonLd.
          priceIsApproximate: product.priceConversion != null,
        }),
  );

  /**
   * What Add to Cart is going to send.
   *
   * One entry per option turned on, or a single entry with no option for a
   * product that has none. Derived once and read by the request, the button
   * label, the price panel and the schedule link, so there is one description
   * of "what the customer chose" rather than four that can disagree.
   */
  const chosenLines = useMemo((): ChosenLine[] => {
    if (product === undefined) return [];

    /**
     * One line: a number of sell units, and the pieces they come to.
     *
     * `quantity` is always pieces, because that is what the server, the
     * basket, the warehouse and the invoice all count in. On a seller's line
     * the factor is 1, so the two are the same number - which is the whole of
     * what "sold by the piece" means here.
     *
     * The unit travels beside it so the basket can show the choice back, and
     * naming it is no longer a formality: the server refuses a request that
     * asks for a seller's piece offer by the carton, because reading it
     * generously would hand the shopper five hundred pieces at the price of
     * one. The server recomputes the pieces from its own figures regardless,
     * so a browser that got this arithmetic wrong cannot buy at the wrong
     * price.
     */
    const lineFor = (variantId: string | null, typed: number): ChosenLine => ({
      variantId,
      quantity: typed * sellUnit.piecesPerUnit,
      orderingUnit: sellUnit.unit,
      unitQuantity: typed,
      piecesPerUnit: sellUnit.piecesPerUnit,
    });

    if (!product.hasVariants || product.variants.length === 0) {
      return [lineFor(null, quantity)];
    }

    /**
     * A guided product buys ONE thing: the combination the shopper narrowed
     * down to. Nothing at all until they have finished narrowing, which is
     * what keeps Add to Basket from sending an incomplete choice.
     */
    if (isGuided) {
      return selectedVariant === null ? [] : [lineFor(selectedVariant.id, quantity)];
    }

    return product.variants.flatMap((variant) => {
      const wanted = chosen.get(variant.id);
      return wanted === undefined ? [] : [lineFor(variant.id, wanted)];
    });
  }, [
    product,
    chosen,
    quantity,
    isGuided,
    selectedVariant,
    sellUnit.piecesPerUnit,
    sellUnit.unit,
  ]);


  const addToCart = useMutation({
    // The bulk route even for a single line. It takes the same shape either
    // way, and one code path is one thing that can be wrong — a second,
    // single-line path would be the one that quietly stops matching this one.
    mutationFn: () =>
      api.post('/cart/items/bulk', {
        items: chosenLines.map((line) => ({
          productId: product?.id,
          variantId: line.variantId,
          quantity: line.quantity,
          // Sent as the unit and the carton count, never as the conversion:
          // the server looks that up for itself. See cart.customer.ts.
          orderingUnit: line.orderingUnit,
          unitQuantity: line.unitQuantity,
          // The same instruction on every line this add writes. Null rather
          // than '' for an untouched box: an empty string would be a value,
          // and a value overwrites an instruction already on the line.
          note: noteForWire(lineNote),
        })),
      }),
    onSuccess: async () => {
      setAddError(null);
      // Cleared only on success, and only here. The words are now on the
      // basket line, where they can be re-read and edited; leaving them in
      // the box as well would invite the buyer to press Add again and wonder
      // why nothing changed. A FAILED add leaves the box exactly as it is,
      // because retyping a paragraph after a dropped connection is the fastest
      // way to lose a customer.
      setLineNote('');
      toast.success(
        chosenLines.length > 1
          ? t('product.optionsAddedToYourCart', { options: formatNumber(chosenLines.length) })
          : t('product.addedToYourCart'),
      );
      await queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (error) => {
      // The server's message names the rule that was broken — a minimum, a
      // stock shortfall, a spend cap. Replacing it with "could not add" throws
      // away the only thing that tells the customer what to change.
      setAddError(
        errorMessage(t, error, t('product.couldNotBeAdded')),
      );
    },
  });

  /*
   * The quantity decision: which dialog, if any, a settled quantity opens -
   * every bulk offer together, or the stock prompt. One place decides, so the
   * page never shows two; see lib/quantity-decision.ts. Only where exactly one
   * thing is chosen, because offers and stock are per version.
   */
  const decisionLine = chosenLines.length === 1 ? chosenLines[0] : undefined;
  const decisionPieces = decisionLine?.quantity ?? 0;
  const [preorderDialogOpen, setPreorderDialogOpen] = useState(false);
  const quantityBoxRef = useRef<HTMLInputElement | null>(null);
  const viewOffersRef = useRef<HTMLButtonElement | null>(null);
  /**
   * Where focus goes when the decision's dialog has gone. Set on close and
   * applied only once no dialog is open - while a modal <dialog> is up the
   * page behind it is inert and refuses focus. PreorderButton does the same.
   */
  const focusAfterDialog = useRef<HTMLElement | null>(null);
  const quantityDecision = useQuantityDecision({
    productId: product?.id ?? '',
    variantId: decisionLine?.variantId ?? null,
    pieces: decisionPieces,
    displayCurrency: currency,
    enabled:
      product !== undefined &&
      decisionLine !== undefined &&
      decisionPieces > 0 &&
      !(product.purchasability?.isPriceOnRequest ?? false),
    otherDialogOpen: preorderDialogOpen,
  });
  /** A settled quantity, in whatever the box counts, handed on in pieces. */
  const commitQuantity = (typed: number, source: QuantityCommitSource, previous: number): void => {
    quantityDecision.commit(typed * sellUnit.piecesPerUnit, source, previous * sellUnit.piecesPerUnit);
  };
  const closeStockPrompt = useCallback(
    (outcome: 'preorder' | 'change' | 'dismiss'): void => {
      if (outcome === 'change') focusAfterDialog.current = quantityBoxRef.current;
      quantityDecision.closePreorderPrompt();
    },
    [quantityDecision],
  );
  const decisionDialogOpen = quantityDecision.dialog !== null;
  useEffect(() => {
    if (decisionDialogOpen || preorderDialogOpen) return;
    const target = focusAfterDialog.current;
    focusAfterDialog.current = null;
    if (target?.isConnected !== true) return;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
  }, [decisionDialogOpen, preorderDialogOpen]);

  if (query.isPending) return <LoadingState label={t('product.loadingTheProduct')} />;

  // An unpublished or unknown product is a 404, which is a normal outcome here
  // rather than a fault: the admin may have unpublished it a second ago.
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) {
      return <NotFoundPage />;
    }

    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (product === undefined) return <NotFoundPage />;

  // The option LIST — the multiple choice this catalogue has always offered,
  // where a hospital buys three sizes of syringe in one go. A guided product
  // uses the narrowing selector instead, so the two never appear together.
  const needsVariant = product.hasVariants && product.variants.length > 0 && !isGuided;
  const chosenVariants = isGuided
    ? selectedVariant === null
      ? []
      : [selectedVariant]
    : product.variants.filter((variant) => chosen.has(variant.id));
  const isReady = chosenLines.length > 0;

  /**
   * The rules the quantity control enforces.
   *
   * The chosen size's own where it has them, the product's otherwise. A pallet
   * quantity sold in tens and a single sold in ones are two different terms of
   * trade on one product, and the box has to snap to whichever one the shopper
   * is actually buying.
   */
  const rules: PurchaseRules = isGuided
    ? { ...product.purchaseRules, ...rulesForVariant(product.purchaseRules, selectedVariant) }
    : product.purchaseRules;

  /**
   * What is in one of these, and what the whole line comes to.
   *
   * "500 g · Pack of 10 · 5 kg in each pack" — and with a quantity of 2,
   * "20 packets, 10 kg in total". The arithmetic a catalogue most often leaves
   * to the reader, and the one a shopper most often gets wrong. Null wherever
   * the seller stated no net content, because the honest thing to print then
   * is nothing.
   */
  const pack = selectedVariant === null ? null : summarisePack(selectedVariant);
  const packLineTotal = pack === null ? null : lineContent(pack, quantity);

  const toggleVariant = (variant: ProductVariant): void => {
    setChosen((current) => {
      const next = new Map(current);
      if (next.has(variant.id)) next.delete(variant.id);
      else next.set(variant.id, clampToRules(rules.minOrderQty, rules));
      return next;
    });
    setAddError(null);
  };

  const setVariantQuantity = (variant: ProductVariant, wanted: number): void => {
    setChosen((current) => new Map(current).set(variant.id, wanted));
    setAddError(null);
  };

  /*
   * The figure in the price panel.
   *
   * Nothing chosen shows the product's own price and one option chosen shows
   * that option's, both as before. Several options chosen shows a band: the
   * lowest and the highest of the figures the SERVER sent for them, picked by
   * comparing, never by adding up.
   *
   * A total across the chosen options is the one thing this must not print. It
   * would be a second pricing engine on a page whose whole rule is that it has
   * none — no tax, no discount, no line total — and the number it produced
   * would eventually disagree with the cart, which is the only place that
   * total is actually worked out.
   */
  /**
   * The price, in the unit the customer has chosen to count in.
   *
   * The catalogue prices a piece; the shop sells a carton. A buyer is thinking
   * in cartons because that is the only thing they can put in a basket, and a
   * page that answers them with the price of one syringe is making them do the
   * multiplication - which they will do on a calculator beside the screen, and
   * sometimes get wrong.
   *
   * Two things keep this from becoming a second pricing engine, which is the
   * thing this page must never grow. It multiplies ONE catalogue price by ONE
   * carton size, both of which came off the server; and it still prints no
   * total - no tax, no discount, no sum across the options chosen. Restating a
   * unit price in a bigger unit is not a total, and the line underneath says
   * what the figure is the price of, so neither number can be misread.
   */
  interface UnitPrice {
    /** Minor units for one carton. */
    minor: string;
    /** What one piece costs, kept for the line printed underneath. */
    pieceMinor: string;
    /** How many pieces that carton holds, for the same line. */
    pieces: number;
  }

  const unitPriceOf = (variant: ProductVariant | null): UnitPrice => {
    const price = variant?.price ?? product.price;
    return {
      minor: sellUnitPriceMinor(price.minor, sellUnit),
      pieceMinor: price.minor,
      pieces: sellUnit.piecesPerUnit,
    };
  };

  // The currency the server quoted these figures in, which is what they must
  // be formatted as. Not `currency` from useLocale() - that is what was ASKED
  // for, and the two differ for a product not sold in the shopper's market.
  const priceCurrency = product.price.currency;
  const chosenUnitPrices: UnitPrice[] = chosenVariants.map((variant) => unitPriceOf(variant));
  const openingUnitPrice = chosenUnitPrices[0] ?? unitPriceOf(null);

  const lowestUnitPrice = chosenUnitPrices.reduce(
    (lowest, price) => (BigInt(price.minor) < BigInt(lowest.minor) ? price : lowest),
    openingUnitPrice,
  );
  const highestUnitPrice = chosenUnitPrices.reduce(
    (highest, price) => (BigInt(price.minor) > BigInt(highest.minor) ? price : highest),
    openingUnitPrice,
  );

  const displayUnitPrice = chosenUnitPrices.length === 0 ? unitPriceOf(null) : lowestUnitPrice;
  const isPriceRange = BigInt(highestUnitPrice.minor) > BigInt(lowestUnitPrice.minor);
  const onlyChosen = chosenVariants.length === 1 ? chosenVariants[0] : undefined;

  /*
   * The strike-through, scaled by the same factor as the price beside it.
   *
   * Multiplying both sides by the same whole number leaves the comparison
   * exactly as the catalogue stated it - a tenth off a piece is a tenth off a
   * carton. Scaling only one of them would invent a saving.
   */
  const compareAtUnitMinor =
    product.compareAtPrice === null
      ? null
      : multiplyMinor(product.compareAtPrice.minor, displayUnitPrice.pieces);

  const hasDiscount =
    compareAtUnitMinor !== null && BigInt(compareAtUnitMinor) > BigInt(displayUnitPrice.minor);


  // The schedule path is offered only where it can actually be walked: the
  // store has the feature on, and this product is eligible for it.
  const canSchedule = features.recurringOrders && rules.isRecurringEligible;

  /**
   * The one line the schedule builder can be handed.
   *
   * `/schedules/new?productId=...` builds a plan around one product and one
   * option, so it can only be offered where the customer has chosen exactly
   * one thing. Undefined otherwise - the panel then says which way round to do
   * it, rather than a link that would quietly drop an option.
   */
  const scheduleLine = chosenLines.length === 1 ? chosenLines[0] : undefined;

  // Absent on a response from a server that predates this, and every product
  // was buyable then.
  const purchasability = product.purchasability ?? null;
  const isPriceOnRequest = purchasability?.isPriceOnRequest ?? false;
  const isUnavailable = purchasability !== null && !purchasability.isOrderable;

  // Where "Request a quote" goes. The subject names the product and its SKU so
  // whoever reads the inbox knows what is being asked about.
  const quoteHref =
    business.supportEmail !== null
      ? `mailto:${business.supportEmail}?subject=${encodeURIComponent(`${product.name} (${product.sku})`)}`
      : business.supportPhone !== null
        ? `tel:${business.supportPhone.replace(/[^\d+]/g, '')}`
        : null;

  /**
   * What the chosen quantity comes to, in goods.
   *
   * ## This is a multiplication, not a second pricing engine
   *
   * The note further up says a total across the chosen options is the one
   * thing this page must not print, and that reasoning still stands — for the
   * figure it was about. What it must not print is a figure somebody could
   * mistake for what they will be CHARGED: that needs tax, the coupon, the
   * delivery fee, the account's own terms and the order of operations between
   * them, and there is exactly one implementation of that in this codebase.
   * A second one here would eventually disagree with it, and the customer
   * would be the one to find out.
   *
   * This is a different figure and it is labelled as one. It is the catalogue's
   * own per-piece price, which came off the server, multiplied by the number
   * of pieces in the box on screen — the same arithmetic as the "per carton"
   * line above it, done once more. A buyer typing 40 cartons is doing that
   * multiplication on a calculator beside the screen, and sometimes getting it
   * wrong; doing it for them is the whole point of the line.
   *
   * What keeps it honest is the sentence printed under it, which says in
   * words that this is goods only and that the basket works out what is
   * actually owed. Both are shown, neither is hidden, and the larger, final
   * figure is never invented here.
   *
   * ## The arithmetic
   *
   * `BigInt` throughout, like every money path in this codebase. A price is
   * minor units and it crosses the API as a string precisely so that nothing
   * can turn it into a float on the way past.
   *
   * Per LINE rather than per product, because a shopper choosing 3 ml and
   * 5 ml is choosing two things at two prices, and each line is multiplied by
   * its own.
   */
  const goodsSubtotalMinor = isPriceOnRequest
    ? null
    : chosenLines
        .reduce((sum, line) => {
          const variant =
            line.variantId === null
              ? null
              : (product.variants.find((candidate) => candidate.id === line.variantId) ?? null);

          // `pieceMinor` is the catalogue's price for one piece, and
          // `line.quantity` is pieces. Multiplying the two needs no knowledge
          // of cartons at all, which is what makes it right for both a
          // seller's piece line and the operator's carton line.
          return sum + BigInt(unitPriceOf(variant).pieceMinor) * BigInt(line.quantity);
        }, 0n)
        .toString();
  // The operator's own sentence where they wrote one; a plain statement of
  // fact where they did not. Never an empty notice.
  const unavailabilityReason =
    purchasability?.unavailabilityReason ?? t('product.currentlyUnavailable');
  /**
   * A product with no options at all, and nothing behind it.
   *
   * Only for a product sold as a single item: where there are options, the
   * answer is per option and the picker says it on each row. `isInStock` is a
   * boolean the server sends and null means "no answer" — an untracked product
   * — which is purchasable.
   */
  const isSimpleAndSoldOut = !product.hasVariants && product.isInStock === false;

  const canBuy =
    !isSimpleAndSoldOut && (purchasability === null ? true : purchasability.canAddToCart);

  // The packing of whatever is currently chosen. One option chosen shows that
  // option's carton; none or several fall back to the product's, which is the
  // row the import writes for exactly this.
  const shownPackaging = packagingFor(product, onlyChosen?.id ?? null);

  // The pieces the current choice comes to, for the line under the quantity
  // boxes. Only shown when it is not simply the number already typed.
  const totalPieces = chosenLines.reduce((sum, line) => sum + line.quantity, 0);

  const hasDetail =
    product.description !== null ||
    product.descriptionHtml !== null ||
    product.attributes.length > 0 ||
    (product.descriptionSections?.length ?? 0) > 0 ||
    product.packaging !== null ||
    (product.safety ?? null) !== null ||
    (product.device ?? null) !== null;

  // Facts the page already holds that a buyer scans for first. Only what is
  // true of this listing: a minimum above one, a carton that is not a piece.
  const infoHighlights = [
    ...(product.purchaseRules.minOrderQty > 1
      ? [{ label: t('product.info.minimumOrder'), value: formatNumber(product.purchaseRules.minOrderQty) }]
      : []),
    ...(!soldByThePiece && sellUnit.piecesPerUnit > 1
      ? [{ label: t('product.info.piecesPerCarton'), value: formatNumber(sellUnit.piecesPerUnit) }]
      : []),
  ];

  return (
    <>
      <nav aria-label={t('product.breadcrumb')} className="mb-5 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-muted">
          <li>
            <Link to="/" className="hover:text-brand hover:underline">
              {t('product.home')}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link to="/products" className="hover:text-brand hover:underline">
              {t('product.products')}
            </Link>
          </li>
          {product.category !== null && (
            <>
              <li aria-hidden="true">/</li>
              <li>
                <Link
                  to={`/category/${product.category.slug}`}
                  className="hover:text-brand hover:underline"
                >
                  {product.category.name}
                </Link>
              </li>
            </>
          )}
          <li aria-hidden="true">/</li>
          <li className="font-medium text-ink" aria-current="page">
            {product.name}
          </li>
        </ol>
      </nav>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2 lg:gap-10">
        <Gallery product={product} variant={selectedVariant} />

        <div className="min-w-0">
          <h1 className="text-title-lg text-ink sm:text-title-xl">{product.name}</h1>

          {/* The product code as a chip rather than a grey line: in B2B this
              is the string that gets typed into a purchase order, so it needs
              to look like something you can select and copy. */}
          <p className="mt-2.5">
            <span className="inline-block rounded bg-surface-sunken px-2 py-1 font-mono text-xxs text-ink-muted ring-1 ring-inset ring-border">
              Product code {product.sku}
            </span>
          </p>

          {product.shortDescription !== null && (
            <p className="mt-3.5 max-w-prose text-base leading-relaxed text-ink-muted">
              {product.shortDescription}
            </p>
          )}

          {/* --- Price ------------------------------------------------------
              Its own panel rather than a pair of hairlines: the price is the
              single most-looked-at thing on this page, and a bordered block
              is what stops the eye at it on the way down. */}
          {/* A named region, and it is not decoration.

              The page now carries the same currency figure in two places for
              a good reason — the price of one unit here, and what the chosen
              quantity comes to further down — and "₹6,250.00" on its own is
              ambiguous between them to a screen reader moving through the
              page, exactly as it was ambiguous to the tests that first caught
              this. Naming the two regions is what tells them apart, for both. */}
          <div
            role="group"
            aria-label={t('product.priceRegion')}
            className="mt-5 rounded-lg border border-border bg-surface px-4 py-4 shadow-card"
          >
            {/* A price, or the reason there is not one - never both, and never
                a figure of zero.

                A product whose price is negotiated per account genuinely has
                no number, and printing one would quote something nobody agreed
                to charge. The panel keeps its size and position either way, so
                the page does not reflow between two products in a range. */}
            {isPriceOnRequest ? (
              <>
                <p className="text-2xl font-semibold tracking-tight text-brand">
                  {t('product.priceOnRequest')}
                </p>
                <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-ink-muted">
                  {t('product.priceOnRequestBody', { store: business.displayName })}
                </p>
              </>
            ) : (
              <>
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular tracking-tight text-ink">
                {isPriceRange
                  ? t('product.priceFromTo', {
                      from: formatMoneyMinor(lowestUnitPrice.minor, priceCurrency),
                      to: formatMoneyMinor(highestUnitPrice.minor, priceCurrency),
                    })
                  : formatMoneyMinor(displayUnitPrice.minor, priceCurrency)}
              </span>
              {/* No null check: `hasDiscount` is a const boolean that already
                  tests it, and TypeScript narrows through it. */}
              {hasDiscount && (
                <span className="text-base tabular text-ink-subtle">
                  <span className="sr-only">{t('product.was')}</span>
                  <s>{formatMoneyMinor(compareAtUnitMinor, priceCurrency)}</s>
                </span>
              )}
              {hasDiscount && <Badge tone="action">{t('product.reducedPrice')}</Badge>}
            </p>

            {/* Under the figure, not beside it: this qualifies the price, it
                does not compete with it. Renders nothing at all for the
                ordinary case of a price somebody typed for this market. */}
            <ApproximatePrice conversion={product.priceConversion} className="mt-1.5" />

            {/* What that figure is the price OF.

                Never omitted on the operator's own goods. The number above is
                the price of a carton of five hundred, and a buyer who reads it
                as the price of one syringe has misread the only figure on the
                page that matters.

                OMITTED WHEN THE THING IS SOLD BY THE PIECE, which is every
                third-party seller's listing. There the headline figure is
                already the price of one, so the line says the same thing
                twice - and says it wrongly: a carton of one is not a carton,
                and "per carton of 1 pieces" reads as a bug to the buyer and
                is one. "Sold by the piece" below the price is what carries
                the unit for these, and it carries it correctly. */}
            {!soldByThePiece && (
              <p className="mt-1 text-sm font-medium text-brand">
                {t('product.pricePerCarton', {
                  pieces: formatNumber(displayUnitPrice.pieces),
                  each: formatMoneyMinor(displayUnitPrice.pieceMinor, priceCurrency),
                })}
              </p>
            )}

            <p className="mt-1.5 text-sm text-ink-muted">
              {taxLine(t, product.tax, countryNames)}
            </p>

            {onlyChosen?.price != null && (
              <p className="mt-1 text-xs text-ink-subtle">
                {t('product.priceShownFor', { variant: onlyChosen.name })}
              </p>
            )}

            {isPriceRange && (
              <p className="mt-1 text-xs text-ink-subtle">
                {t('product.priceShownForOptions', {
                  options: formatNumber(chosenVariants.length),
                })}
              </p>
            )}
              </>
            )}

            {/* Listed, readable, and not for sale this week. Said here rather
                than only on the disabled button, because somebody who scrolled
                straight to the price should not have to find out lower down. */}
            {isUnavailable && (
              <p
                role="status"
                className="mt-3 rounded-md border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
              >
                {unavailabilityReason}
              </p>
            )}
          </div>

          {/* --- The buy path ----------------------------------------------
              Variants, quantity and the actions in one panel, in the order
              they have to be done. On a phone this is the whole screen after
              the gallery, so it has to read as one task. */}
          <div className="mt-5 rounded-lg border border-border bg-surface px-4 py-4 shadow-card sm:px-5 sm:py-5">
            <div className="space-y-5">
              {/* What the quantity boxes below are counting, said before they
                  are reached rather than after. There is no control here
                  because there is no choice - what this is sold in is a fact
                  about who is selling it, not something the shopper picks.

                  A seller's line adds their minimum and step, because those
                  are what the box below will actually snap to, and a control
                  that silently corrects what was typed is one the shopper
                  stops trusting. */}
              <p className="text-xs font-medium text-ink-muted">
                {soldByThePiece
                  ? t('packaging.soldByThePiece')
                  : t('packaging.orderingInCartons', { n: formatNumber(piecesPerCarton) })}
                {soldByThePiece && sellUnit.minimumOrderQuantity > 1 && (
                  <>
                    {' · '}
                    {t('packaging.minimumNPieces', {
                      n: formatNumber(sellUnit.minimumOrderQuantity),
                    })}
                  </>
                )}
                {soldByThePiece && sellUnit.orderIncrement > 1 && (
                  <>
                    {' · '}
                    {t('packaging.inMultiplesOfNPieces', {
                      n: formatNumber(sellUnit.orderIncrement),
                    })}
                  </>
                )}
              </p>

              {/* The narrowing selector, for a product whose seller declared
                  the dimensions it sells along. Colour, then size, with the
                  combinations nobody stocks disabled — and the quantity box
                  below it, because a guided product buys one thing. */}
              {/* A skeleton while the axis labels are on their way. Without
                  it the selector draws for half a second with raw keys
                  (`size_system`) where the labels go, and a page that flashes
                  machine names at somebody reads as broken. Fixed heights, so
                  nothing below it jumps when the real thing arrives. */}
              {isGuided && axesLoading && (
                <div aria-hidden="true" className="space-y-4">
                  {[0, 1].map((row) => (
                    <div key={row}>
                      <div className="h-4 w-24 rounded bg-surface-sunken" />
                      <div className="mt-2 flex gap-2">
                        {[0, 1, 2, 3].map((chip) => (
                          <div key={chip} className="h-11 w-16 rounded-lg bg-surface-sunken" />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {isGuided && !axesLoading && resolution !== null && (
                <VariantSelector
                  axes={resolution.axes}
                  onChoose={chooseAxisValue}
                  focusKey={focusAxisKey}
                  missingMessage={
                    focusAxisKey === null
                      ? null
                      : t('variants.selectToContinue', {
                          axis:
                            resolution.axes.find((axis) => axis.key === focusAxisKey)?.label ??
                            focusAxisKey,
                        })
                  }
                />
              )}

              {/* What is actually in one of these, before the button rather
                  than on the delivery note. "Pack of 10" and "5 kg in each"
                  are the two figures a shopper most often has to multiply for
                  themselves, and the one they most often get wrong. */}
              {pack !== null && (pack.netContent !== null || pack.multipackCount > 1) && (
                <div className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2 text-sm text-ink-muted">
                  <p className="font-medium text-ink">
                    {[
                      pack.netContent === null
                        ? null
                        : `${pack.netContent.value} ${pack.netContent.unit}`,
                      pack.multipackCount > 1
                        ? t('variants.packOf', { n: formatNumber(pack.multipackCount) })
                        : null,
                      pack.manufacturerPackLabel,
                    ]
                      .filter((part): part is string => part !== null && part !== '')
                      .join(' · ')}
                  </p>

                  {pack.totalContent !== null && pack.multipackCount > 1 && (
                    <p className="mt-0.5 text-xs">
                      {t('variants.eachPackContains', {
                        amount: `${pack.totalContent.value} ${pack.totalContent.unit}`,
                      })}
                    </p>
                  )}

                  {packLineTotal !== null && quantity > 1 && (
                    <p className="mt-0.5 text-xs">
                      {t('variants.lineTotalContent', {
                        packs: formatNumber(quantity),
                        units: formatNumber(pack.multipackCount * quantity),
                        amount: `${packLineTotal.value} ${packLineTotal.unit}`,
                      })}
                    </p>
                  )}
                </div>
              )}

              {needsVariant ? (
                <VariantPicker
                  variants={product.variants}
                  chosen={chosen}
                  rules={rules}
                  hidePrices={isPriceOnRequest}
                  // Each row priced by the carton, or the list would read in
                  // pieces under a page that prices everything else in
                  // cartons.
                  priceOf={(variant) => unitPriceOf(variant).minor}
                  currency={priceCurrency}
                  onToggle={toggleVariant}
                  onQuantityChange={setVariantQuantity}
                  onQuantityCommit={(variant, next, source, previous) => {
                    if (decisionLine?.variantId === variant.id) commitQuantity(next, source, previous);
                  }}
                />
              ) : (
                // Only where there is nothing to choose between. Where there
                // is, every quantity lives in the picker beside the option it
                // counts, and a second box here would be a number with no
                // option attached to it.
                <QuantityInput
                  value={quantity}
                  onChange={(next) => {
                    setQuantity(next);
                    setAddError(null);
                  }}
                  onCommit={commitQuantity}
                  inputRef={quantityBoxRef}
                  rules={rules}
                />
              )}

              {/* What the cartons come to.

                  This is the figure the basket, the warehouse and the invoice
                  will all use, so seeing it here is what stops "2" meaning two
                  syringes to the customer and a thousand to everybody else.

                  Only where there is a conversion to show. On a product sold
                  one at a time the sentence restates the number in the box
                  directly above it - "That comes to 1 pieces" under a quantity
                  of 1 - which is noise, and ungrammatical noise at that. */}
              {!soldByThePiece && totalPieces > 0 && (
                <p className="rounded-md bg-surface-sunken px-3 py-2 text-sm tabular text-ink-muted">
                  {t('packaging.comesTo', { n: formatNumber(totalPieces) })}
                </p>
              )}

              {/* Bulk savings: what one piece costs at this quantity and in
                  each way of buying it, and what the next band saves. Renders
                  nothing for a product no seller bands, and nothing on a
                  price-on-request page. The suggestion is only pressable where
                  the box above counts in pieces for one version. */}
              {!isPriceOnRequest && scheduleLine !== undefined && totalPieces > 0 && (
                <BulkSavingsPopover
                  productId={product.id}
                  variantId={scheduleLine.variantId}
                  pieces={totalPieces}
                  displayCurrency={currency}
                  onSetPieces={
                    needsVariant || !soldByThePiece
                      ? undefined
                      : (next) => {
                          setQuantity(next);
                          setAddError(null);
                        }
                  }
                />
              )}

              {/* Every bulk offer together, on request - and opened by the
                  quantity decision on the first increase that has offers to
                  show. Only where the seller has set genuine offers. */}
              {quantityDecision.pricing !== null && quantityDecision.pricing.offers.length > 0 && (
                <button
                  ref={viewOffersRef}
                  type="button"
                  aria-haspopup="dialog"
                  onClick={quantityDecision.openOffers}
                  className="mt-2 inline-flex min-h-11 items-center gap-1.5 rounded-md px-1 text-sm font-semibold text-brand underline-offset-4 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                >
                  {t('bulkOffers.viewAll', {
                    offers: quantityDecision.pricing.offers.length.toLocaleString(intlLocale),
                  })}
                </button>
              )}
              {/* Mounted while there are offers and opened by the decision, so
                  the dialog closes through <dialog>.close() and the browser
                  puts focus back where it was. */}
              {quantityDecision.pricing !== null && quantityDecision.pricing.offers.length > 0 && (
                <BulkOffersDialog
                  isOpen={quantityDecision.dialog?.kind === 'offers'}
                  pricing={quantityDecision.pricing}
                  onClose={() => {
                    // Back to whatever opened it: the button, or for an
                    // automatic opening the quantity box the buyer was using.
                    const back =
                      quantityDecision.dialog?.kind === 'offers' && quantityDecision.dialog.trigger === 'explicit'
                        ? viewOffersRef.current
                        : quantityBoxRef.current;
                    focusAfterDialog.current = back;
                    quantityDecision.dismissOffers();
                  }}
                  onSelect={
                    needsVariant || !soldByThePiece
                      ? undefined
                      : (pieces) => {
                          setQuantity(pieces);
                          setAddError(null);
                          quantityDecision.chooseOffer(pieces, decisionPieces);
                          // The box now shows the chosen quantity; the stock
                          // prompt, if it follows, takes focus from here.
                          focusAfterDialog.current = quantityBoxRef.current;
                        }
                  }
                />
              )}

              {/* --- What it comes to --------------------------------------

                  Three rows, and each one answers a question a buyer asks out
                  loud in front of this panel.

                  "What does ONE cost?" is the first, and it is the one this
                  page used to answer only obliquely — the headline figure is
                  the price of a carton of five hundred on the operator's
                  goods, and a buyer comparing two suppliers is comparing the
                  price of a piece. It is stated here in the same words on
                  every product, whichever unit the product is sold in, so the
                  comparison is possible without arithmetic.

                  "How many pieces is that?" is the second, and it is shown
                  only where it is not simply the number already in the box.

                  "What is that going to cost me?" is the third, and the note
                  on `goodsSubtotalMinor` sets out at length why it is safe to
                  answer it here and what it is not. The short version is on
                  screen, under the figure, in words: goods only, and the
                  basket is what works out the rest. Nothing on this panel
                  pretends to be the final bill.

                  Absent entirely on a product priced per account, where there
                  is no figure to multiply and inventing one would quote
                  something nobody agreed to charge. */}
              {goodsSubtotalMinor !== null && totalPieces > 0 && (
                <div
                  role="group"
                  aria-label={t('product.totalRegion')}
                  className="rounded-md border border-border-subtle bg-surface-sunken px-3 py-2.5"
                >
                  <dl className="space-y-1 text-sm">
                    <div className="flex items-baseline justify-between gap-3">
                      <dt className="text-ink-muted">{t('product.pricePerPiece')}</dt>
                      <dd className="shrink-0 tabular font-medium text-ink">
                        {/* The seller's quantity band, where one prices this
                            quantity - the figure the basket will charge. */}
                        <BandPriceValue
                          productId={product.id}
                          variantId={scheduleLine?.variantId ?? null}
                          pieces={totalPieces}
                          displayCurrency={currency}
                          priceCurrency={priceCurrency}
                          enabled={scheduleLine !== undefined && soldByThePiece && !isPriceOnRequest}
                          kind="unit"
                          fallback={formatMoneyMinor(displayUnitPrice.pieceMinor, priceCurrency)}
                        />
                      </dd>
                    </div>

                    {totalPieces !== quantity && (
                      <div className="flex items-baseline justify-between gap-3">
                        <dt className="text-ink-muted">{t('product.piecesLabel')}</dt>
                        <dd className="shrink-0 tabular text-ink">{formatNumber(totalPieces)}</dd>
                      </div>
                    )}

                    <div className="flex items-baseline justify-between gap-3 border-t border-border-subtle pt-1.5">
                      <dt className="font-medium text-ink">{t('product.totalCost')}</dt>
                      {/*
                        `aria-live="polite"`, because this number changes
                        without the page navigating and a figure that updates
                        silently is a figure a screen-reader user never learns
                        changed. Polite rather than assertive: it should be
                        announced after the quantity they just typed, not over
                        the top of it.
                      */}
                      <dd
                        aria-live="polite"
                        className="shrink-0 text-base font-semibold tabular text-ink"
                      >
                        <BandPriceValue
                          productId={product.id}
                          variantId={scheduleLine?.variantId ?? null}
                          pieces={totalPieces}
                          displayCurrency={currency}
                          priceCurrency={priceCurrency}
                          enabled={scheduleLine !== undefined && soldByThePiece && !isPriceOnRequest}
                          kind="total"
                          fallback={formatMoneyMinor(goodsSubtotalMinor, priceCurrency)}
                        />
                      </dd>
                    </div>
                  </dl>

                  <p className="mt-1.5 text-xxs leading-relaxed text-ink-subtle">
                    {t('product.totalCostBasis')}
                  </p>
                </div>
              )}

              {/* --- Special instructions -----------------------------------

                  Per product, and this is the field a trade buyer has been
                  writing into the order note for want of anywhere better.

                  It belongs here rather than at checkout because it is about
                  THIS product: "the 316 grade, not 304", "match the batch on
                  our PO 4471", "engrave both ends". Written at checkout those
                  words arrive attached to nothing — on a basket of nine lines
                  from four sellers, an order note saying "the blue one"
                  reaches every seller and identifies none of them. Written
                  here it travels on the line, and the person picking that line
                  is the person who reads it.

                  Optional, and said so in the label rather than only by the
                  absence of an asterisk. Most orders have nothing to add, and
                  a field that looks required is a field people invent an
                  answer for.

                  It survives a failed add and is cleared on a successful one —
                  see the mutation. */}
              <Field
                label={t('product.specialInstructions')}
                hint={t('product.specialInstructionsHint')}
              >
                {({ inputId, describedBy }) => (
                  <Textarea
                    id={inputId}
                    aria-describedby={describedBy}
                    value={lineNote}
                    // The same 500 the column and the API schema hold, so the
                    // box stops where the server would have refused. A limit
                    // discovered as a rejected save is a limit discovered too
                    // late to be useful.
                    maxLength={MAX_LINE_NOTE_CHARS}
                    rows={2}
                    className="min-h-[4.5rem]"
                    placeholder={t('product.specialInstructionsPlaceholder')}
                    onChange={(event) => {
                      const { value } = event.currentTarget;
                      setLineNote(value);
                    }}
                  />
                )}
              </Field>

              {addError !== null && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
                >
                  {addError}
                </p>
              )}

              {isCustomer ? (
                <div className="space-y-2.5">
                  <div className="flex flex-col gap-2.5 sm:flex-row sm:flex-wrap">
                    {/* Priced on request has no basket path at all - there
                        is no figure to charge - so the button is replaced
                        rather than disabled. A greyed-out Add to Cart invites
                        somebody to keep clicking it looking for the reason. */}
                    {/* A quote goes to the store's own support address, or its
                        phone when there is no address, because that is where a
                        person reads it. With neither configured the button is
                        left out; Preorder and Add instructions in this row
                        still let the buyer ask. */}
                    {isPriceOnRequest ? (
                      quoteHref !== null && (
                        <ButtonAnchor
                          href={quoteHref}
                          variant="action"
                          size="lg"
                          className="w-full sm:w-auto"
                        >
                          {t('product.requestAQuote')}
                        </ButtonAnchor>
                      )
                    ) : (
                      <Button
                        variant="action"
                        size="lg"
                        /*
                         * On a guided product the button stays live while the
                         * choice is incomplete, and says what is missing when
                         * it is pressed.
                         *
                         * A disabled button is the obvious implementation and
                         * the worse one: it cannot take focus, screen readers
                         * skip it, and it answers "why can't I buy this?" with
                         * silence. Pressing it and being told "choose a size"
                         * — with the caret landing on the size buttons — is
                         * the same guard and an answer.
                         */
                        disabled={(!isGuided && !isReady) || !canBuy}
                        isLoading={addToCart.isPending}
                        onClick={() => {
                          if (isGuided && !isReady) {
                            const missing = resolution?.missingAxisKeys[0] ?? null;
                            setFocusAxisKey(missing);
                            return;
                          }
                          addToCart.mutate();
                        }}
                        // Full width on a phone, where a half-width primary
                        // action beside nothing reads as unfinished.
                        className="w-full sm:w-auto"
                      >
                        {chosenLines.length > 1
                          ? t('product.addOptionsToCart', {
                              options: formatNumber(chosenLines.length),
                            })
                          : t('product.addToCart')}
                      </Button>
                    )}

                    {canBuy && canSchedule && scheduleLine !== undefined && (
                      // Teal, beside the orange Add to Cart: two real choices,
                      // each visibly its own kind of commitment, and neither
                      // mistakable for the other.
                      <ButtonLink
                        to={`/schedules/new?productId=${product.id}&quantity=${String(scheduleLine.quantity)}${
                          scheduleLine.variantId === null ? '' : `&variantId=${scheduleLine.variantId}`
                        }`}
                        variant="operational"
                        size="lg"
                        className="w-full sm:w-auto"
                      >
                        {t('product.setUpARepeatPurchase')}
                      </ButtonLink>
                    )}

                    {/*
                     * The third thing you can do with a product, beside the
                     * two ways of buying it rather than below them.
                     *
                     * It belongs in this row because it is an alternative to
                     * pressing Add to Cart, not an afterthought once you
                     * have: the shopper reading this panel has the
                     * specification in front of them and the thing stopping
                     * them is a question — "do you do this in 8 mm?" — which
                     * they will only ask if asking is offered where the
                     * decision is being made.
                     *
                     * `secondary`, not `action` or `operational`. Those two
                     * hues are the two commitments and a third filled button
                     * beside them would read as a third way to buy this. This
                     * is the quiet option in the same row, at the same height,
                     * so it is plainly available without competing.
                     *
                     * `w-full sm:w-auto` matches its neighbours: the row is a
                     * column on a phone, and a half-width button under two
                     * full-width ones reads as unfinished.
                     */}
                    {/*
                     * Preorder: the third way to buy, for a quantity the seller has to
                     * make. On every product page - the server decides whether it is
                     * open, and it says why underneath when it is not. See the
                     * component for why it is neither hidden nor a scheduled cart.
                     */}
                    <PreorderButton
                      productId={product.id}
                      productName={product.name}
                      imageUrl={product.primaryImage?.url ?? null}
                      variantId={scheduleLine?.variantId ?? null}
                      variantName={
                        scheduleLine?.variantId === null || scheduleLine === undefined
                          ? null
                          : (product.variants.find((candidate) => candidate.id === scheduleLine.variantId)?.name ?? null)
                      }
                      isReady={scheduleLine !== undefined}
                      pieces={totalPieces}
                      stockPrompt={quantityDecision.dialog?.kind === 'preorder' ? quantityDecision.dialog : null}
                      onStockPromptClose={closeStockPrompt}
                      // The minimum-order suggestion waits while a decision dialog
                      // is up, and stands aside when this quantity is over stock:
                      // the stock prompt says the same and more.
                      blocked={quantityDecision.dialog !== null || quantityDecision.overStockNow}
                      onDialogChange={setPreorderDialogOpen}
                      // Add to Cart takes this quantity exactly when it is
                      // live: the quantity box already holds it inside the
                      // product's own ordering rules, and the server applies
                      // the same rules to the cart.
                      regularOrderAllowed={canBuy && !isPriceOnRequest}
                      className="w-full sm:w-auto"
                    />
                    <ProductInstructionsButton
                      productId={product.id}
                      productName={product.name}
                      variantId={scheduleLine?.variantId ?? null}
                      size="lg"
                      variant="secondary"
                      className="w-full sm:w-auto"
                    />
                  </div>

                  {!isReady && (
                    <p className="text-sm text-ink-muted">
                      {isGuided && resolution !== null && resolution.missingAxisKeys.length > 0
                        ? t('variants.selectToContinue', {
                            axis:
                              resolution.axes.find(
                                (axis) => axis.key === resolution.missingAxisKeys[0],
                              )?.label ?? resolution.missingAxisKeys[0],
                          })
                        : t('product.chooseAnOptionToContinue')}
                    </p>
                  )}

                  {/* The schedule builder takes one product and one option, so
                      with two options chosen there is no link to offer that
                      would not silently drop one of them. It says which way
                      round to do it instead of disappearing: the cart holds
                      both, and a whole cart can be scheduled from there. */}
                  {canSchedule && scheduleLine === undefined && isReady && (
                    <p className="text-sm text-ink-muted">
                      {t('product.scheduleOneOptionAtATime')}
                    </p>
                  )}

                  {/*
                   * Save for later, under the two commitments rather than
                   * beside them: it is not a commitment, and a third
                   * full-height button in that row would read as a third way
                   * to buy this.
                   *
                   * `scheduleLine` is reused for the option, and it is the
                   * right value for the same reason it is right there — it is
                   * the single chosen line, or undefined when there is not
                   * exactly one. With two options chosen the base product is
                   * saved, which is the honest answer: the wishlist holds one
                   * line per option and picking one of two arbitrarily would
                   * be a guess.
                   */}
                  <div className="border-t border-border-subtle pt-2.5">
                    <SaveForLaterButton
                      productId={product.id}
                      productSlug={product.slug}
                      variantId={scheduleLine?.variantId ?? null}
                    />
                  </div>

                  {/*
                   * Bulk ordering, BELOW the ordinary controls rather than
                   * instead of them.
                   *
                   * Both ways of buying stay available: a seller who ships
                   * pallets still sells a single box, and a buyer who wanted
                   * one and found only pallets would leave. The panel renders
                   * nothing at all when the seller has configured no packages,
                   * which is most of the catalogue.
                   *
                   * It manages its own quantity and its own add, because a
                   * pallet count and a piece count are two different numbers
                   * and a single stepper serving both would have to decide
                   * which the buyer meant.
                   */}
                  <BulkOrderPanel
                    productId={product.id}
                    variantId={scheduleLine?.variantId ?? null}
                    options={packagingOptions}
                    note={noteForWire(lineNote)}
                    onAdded={() => {
                      setLineNote('');
                    }}
                  />
                </div>
              ) : (
                <div className="rounded-md border border-border bg-surface-sunken p-4">
                  <p className="text-sm text-ink">{t('product.signInToAddThis')}</p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button
                      variant="primary"
                      onClick={() => {
                        void navigate('/login', {
                          state: { from: `/product/${product.slug}` },
                        });
                      }}
                    >
                      {t('product.signInToOrder')}
                    </Button>

                    {/* Offered to a guest too. Somebody browsing without an
                        account is exactly who wants to keep a line for later,
                        and the control explains what signing in buys them
                        rather than being absent. */}
                    <SaveForLaterButton productId={product.id} productSlug={product.slug} />

                    {/* Same reasoning again, and it applies harder here: the
                        shopper who has not signed in is the one most likely to
                        have a question rather than an order. Pressing it takes
                        them to sign-in and back to this product. */}
                    <ProductInstructionsButton
                      productId={product.id}
                      productName={product.name}
                    />
                  </div>
                  {/* A guest sees Preorder too; pressing it goes to sign-in
                      and comes back here with the form open. */}
                  <div className="mt-3">
                    {/*
                     * Preorder: the third way to buy, for a quantity the seller has to
                     * make. On every product page - the server decides whether it is
                     * open, and it says why underneath when it is not. See the
                     * component for why it is neither hidden nor a scheduled cart.
                     */}
                    <PreorderButton
                      productId={product.id}
                      productName={product.name}
                      imageUrl={product.primaryImage?.url ?? null}
                      variantId={scheduleLine?.variantId ?? null}
                      variantName={
                        scheduleLine?.variantId === null || scheduleLine === undefined
                          ? null
                          : (product.variants.find((candidate) => candidate.id === scheduleLine.variantId)?.name ?? null)
                      }
                      isReady={scheduleLine !== undefined}
                      pieces={totalPieces}
                      stockPrompt={quantityDecision.dialog?.kind === 'preorder' ? quantityDecision.dialog : null}
                      onStockPromptClose={closeStockPrompt}
                      // The minimum-order suggestion waits while a decision dialog
                      // is up, and stands aside when this quantity is over stock:
                      // the stock prompt says the same and more.
                      blocked={quantityDecision.dialog !== null || quantityDecision.overStockNow}
                      onDialogChange={setPreorderDialogOpen}
                      className="w-full sm:w-auto"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Everything in here is a fact the API already sent. See the
              component's own note. */}
          <OrderingInformation product={product} />
        </div>
      </div>

      {/* --- Everything a buyer reads below the buy panel --------------------
          In one fixed order - highlights, description, specifications,
          packaging and bulk ordering, compliance, warranty, manufacturer and
          seller - each only when it has something to say. The chosen option's
          own specifications replace the product's, so changing size never
          leaves the previous size's values on the page. */}
      {hasDetail && (
        <ProductInformation
          specifications={onlyChosen?.specifications ?? product.specifications ?? []}
          descriptionSections={product.descriptionSections ?? []}
          description={product.description}
          descriptionHtml={product.descriptionHtml}
          extraHighlights={infoHighlights}
          packaging={
            <>
              {/* How it is boxed, and what the boxes measure: how it arrives
                  on a pallet, asked by a different person from "what is it". */}
              <PackagingSection
                packaging={shownPackaging}
                soldByThePiece={soldByThePiece}
                piecesPerCarton={sellUnit.piecesPerUnit}
              />
              <DimensionsSection packaging={shownPackaging} />
            </>
          }
          compliance={<ProductDevicePanel device={product.device} />}
          // GPSR Art. 19: on the page and not behind a tab - a panel nobody
          // opens is not something a buyer saw before they bought.
          manufacturer={<ProductSafetyPanel safety={product.safety} />}
        />
      )}
    </>
  );
}
