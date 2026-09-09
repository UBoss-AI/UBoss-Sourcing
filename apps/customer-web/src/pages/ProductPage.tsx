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
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import { QuantityInput } from '@/components/QuantityInput';
import { clampToRules, describeRules } from '@/lib/quantity-rules';
import { Badge, Button, ButtonLink, ErrorState, LoadingState } from '@/components/ui';
import { BoxIcon, CurrencyIcon, TruckIcon } from '@/components/icons';
import { ApiError, api } from '@/lib/api';
import { formatMoney, formatNumber } from '@/lib/format';
import { SafeHtml } from '@/lib/safe-html';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { NotFoundPage } from './NotFoundPage';
import type {
  Money,
  Product,
  ProductDetailResponse,
  ProductVariant,
  PurchaseRules,
  TaxInfo,
} from '@/lib/types';
import { ProductSafetyPanel } from '@/components/ProductSafetyPanel';
import { ProductDevicePanel } from '@/components/ProductDevicePanel';
import { useI18n } from '@/i18n/i18n-context';
import type { Translate } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';

/**
 * The image gallery.
 *
 * The hero sits on the sunken ground inside a hairline frame, because almost
 * every product photograph in this catalogue is `object-contain` on white —
 * on a white card there is no edge at all, and the product reads as floating
 * shapes rather than as a photograph of a thing.
 */
function Gallery({ product }: { product: Product }): React.JSX.Element {
  const { t } = useI18n();

  const images = product.images;
  const [activeIndex, setActiveIndex] = useState(0);
  const active = images[activeIndex] ?? product.primaryImage;

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
      <div className="overflow-hidden rounded-xl border border-border bg-surface-sunken shadow-card">
        <img
          src={active.url}
          alt={active.altText ?? product.name}
          // The hero image is the largest paint on this page, so it is not
          // lazy — deferring it delays the metric it defines.
          loading="eager"
          decoding="async"
          width={800}
          height={800}
          className="aspect-square w-full object-contain p-6 sm:p-8"
        />
      </div>

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
function VariantPicker({
  variants,
  chosen,
  rules,
  onToggle,
  onQuantityChange,
}: {
  variants: ProductVariant[];
  /** Option id to the quantity wanted. An absent id is an option not chosen. */
  chosen: ReadonlyMap<string, number>;
  rules: PurchaseRules;
  onToggle: (variant: ProductVariant) => void;
  onQuantityChange: (variant: ProductVariant, quantity: number) => void;
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
          const optionText = Object.entries(variant.options)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');

          return (
            <li
              key={variant.id}
              className={`rounded-lg border transition-colors ${
                isChosen
                  ? 'border-brand bg-brand-soft ring-1 ring-inset ring-brand/30'
                  : 'border-border-strong bg-surface hover:border-brand/40 hover:bg-surface-hover'
              }`}
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-3 p-2.5 sm:flex-nowrap">
                <button
                  type="button"
                  aria-pressed={isChosen}
                  onClick={() => {
                    onToggle(variant);
                  }}
                  className="flex min-w-0 flex-1 items-center gap-3 rounded text-left"
                >
                  {/* A box that fills, rather than a tick that appears. With
                      five options on screen, "which of these are on?" has to
                      be answerable from the corner of the eye. */}
                  <span
                    aria-hidden="true"
                    className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${
                      isChosen
                        ? 'border-brand bg-brand text-white'
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
                      className={`block text-sm font-medium ${isChosen ? 'text-brand' : 'text-ink'}`}
                    >
                      {variant.name}
                    </span>
                    {optionText !== '' && (
                      <span className="mt-0.5 block text-xxs text-ink-muted">{optionText}</span>
                    )}
                  </span>

                  {variant.price !== null && (
                    <span className="ml-auto shrink-0 pl-2 text-sm tabular text-ink-muted">
                      {formatMoney(variant.price)}
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

      <dl className="mt-3 grid gap-x-5 gap-y-3.5 sm:grid-cols-2">
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
  const { t, language } = useI18n();

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

    const only = product.variants.length === 1 ? product.variants[0] : undefined;
    setChosen(only === undefined ? new Map() : new Map([[only.id, opening]]));
  }, [product]);

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
    },
    business.displayName,
  );

  /**
   * What Add to Cart is going to send.
   *
   * One entry per option turned on, or a single entry with no option for a
   * product that has none. Derived once and read by the request, the button
   * label, the price panel and the schedule link, so there is one description
   * of "what the customer chose" rather than four that can disagree.
   */
  const chosenLines = useMemo((): { variantId: string | null; quantity: number }[] => {
    if (product === undefined) return [];

    if (!product.hasVariants || product.variants.length === 0) {
      return [{ variantId: null, quantity }];
    }

    return product.variants.flatMap((variant) => {
      const wanted = chosen.get(variant.id);
      return wanted === undefined ? [] : [{ variantId: variant.id, quantity: wanted }];
    });
  }, [product, chosen, quantity]);

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
        })),
      }),
    onSuccess: async () => {
      setAddError(null);
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

  const needsVariant = product.hasVariants && product.variants.length > 0;
  const chosenVariants = product.variants.filter((variant) => chosen.has(variant.id));
  const isReady = chosenLines.length > 0;

  const rules = product.purchaseRules;

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
  const chosenPrices: Money[] = chosenVariants.map((variant) => variant.price ?? product.price);
  const openingPrice = chosenPrices[0] ?? product.price;
  const lowestPrice = chosenPrices.reduce(
    (lowest, price) => (BigInt(price.minor) < BigInt(lowest.minor) ? price : lowest),
    openingPrice,
  );
  const highestPrice = chosenPrices.reduce(
    (highest, price) => (BigInt(price.minor) > BigInt(highest.minor) ? price : highest),
    openingPrice,
  );

  const displayPrice = chosenPrices.length === 0 ? product.price : lowestPrice;
  const isPriceRange = BigInt(highestPrice.minor) > BigInt(lowestPrice.minor);
  const onlyChosen = chosenVariants.length === 1 ? chosenVariants[0] : undefined;

  // Against the lowest of the chosen options, which is the figure printed
  // beside it. A strike-through over the top of a band is not a comparison.
  const hasDiscount =
    product.compareAtPrice !== null &&
    BigInt(product.compareAtPrice.minor) > BigInt(displayPrice.minor);

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

  const hasDetail =
    product.description !== null ||
    product.descriptionHtml !== null ||
    product.attributes.length > 0;

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

      <div className="grid gap-8 lg:grid-cols-2 lg:gap-10">
        <Gallery product={product} />

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
          <div className="mt-5 rounded-lg border border-border bg-surface px-4 py-4 shadow-card">
            <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-3xl font-semibold tabular tracking-tight text-ink">
                {isPriceRange
                  ? t('product.priceFromTo', {
                      from: formatMoney(lowestPrice),
                      to: formatMoney(highestPrice),
                    })
                  : formatMoney(displayPrice)}
              </span>
              {hasDiscount && product.compareAtPrice !== null && (
                <span className="text-base tabular text-ink-subtle">
                  <span className="sr-only">{t('product.was')}</span>
                  <s>{formatMoney(product.compareAtPrice)}</s>
                </span>
              )}
              {hasDiscount && <Badge tone="action">{t('product.reducedPrice')}</Badge>}
            </p>

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
          </div>

          {/* --- The buy path ----------------------------------------------
              Variants, quantity and the actions in one panel, in the order
              they have to be done. On a phone this is the whole screen after
              the gallery, so it has to read as one task. */}
          <div className="mt-5 rounded-lg border border-border bg-surface px-4 py-4 shadow-card sm:px-5 sm:py-5">
            <div className="space-y-5">
              {needsVariant ? (
                <VariantPicker
                  variants={product.variants}
                  chosen={chosen}
                  rules={rules}
                  onToggle={toggleVariant}
                  onQuantityChange={setVariantQuantity}
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
                  rules={rules}
                />
              )}

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
                    <Button
                      variant="action"
                      size="lg"
                      disabled={!isReady}
                      isLoading={addToCart.isPending}
                      onClick={() => {
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

                    {canSchedule && scheduleLine !== undefined && (
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
                  </div>

                  {!isReady && (
                    <p className="text-sm text-ink-muted">
                      {t('product.chooseAnOptionToContinue')}
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
                </div>
              ) : (
                <div className="rounded-md border border-border bg-surface-sunken p-4">
                  <p className="text-sm text-ink">{t('product.signInToAddThis')}</p>
                  <Button
                    variant="primary"
                    className="mt-3"
                    onClick={() => {
                      void navigate('/login', {
                        state: { from: `/product/${product.slug}` },
                      });
                    }}
                  >
                    {t('product.signInToOrder')}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {/* Everything in here is a fact the API already sent. See the
              component's own note. */}
          <OrderingInformation product={product} />
        </div>
      </div>

      {/* --- Description and specifications ---------------------------------
          Full width below the fold rather than squeezed into the right column:
          a specification table and a supplier's HTML description are both
          long, and neither survives a 22rem column. The description takes the
          wider half and is capped at a reading measure; the specifications sit
          beside it on a desktop and stack underneath on a phone. */}
      {hasDetail && (
        <div className="mt-12 grid gap-8 border-t border-border pt-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-10">
          {(product.description !== null || product.descriptionHtml !== null) && (
            <section aria-labelledby="description-heading" className="min-w-0">
              <h2 id="description-heading" className="text-title-sm text-ink">
                {t('product.description')}
              </h2>

              {product.descriptionHtml === null ? (
                <p className="mt-3 max-w-prose whitespace-pre-wrap break-words text-sm leading-relaxed text-ink-muted">
                  {product.description}
                </p>
              ) : (
                // A supplier's HTML can contain a wide table or an unbroken
                // part number. `[&_table]:block` with its own overflow makes
                // the table scroll inside itself instead of pushing the page
                // sideways, and `break-words` handles the part number.
                <SafeHtml
                  html={product.descriptionHtml}
                  className="prose-sm mt-3 max-w-prose break-words text-sm leading-relaxed text-ink-muted [&_a]:text-brand [&_a]:underline [&_h2]:mt-4 [&_h2]:font-semibold [&_h2]:text-ink [&_h3]:mt-3 [&_h3]:font-medium [&_h3]:text-ink [&_img]:h-auto [&_img]:max-w-full [&_li]:ml-5 [&_li]:list-disc [&_p]:mt-2 [&_table]:mt-3 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1"
                />
              )}
            </section>
          )}

          {product.attributes.length > 0 && (
            <section aria-labelledby="specifications-heading" className="min-w-0">
              <h2 id="specifications-heading" className="text-title-sm text-ink">
                {t('product.specifications')}
              </h2>

              {/* Two columns from `sm` up, stacked below it. The fixed 10rem
                  label column this replaced left a two-word value wrapping in
                  a 4rem gutter on every phone. */}
              <dl className="mt-3 divide-y divide-border-subtle overflow-hidden rounded-lg border border-border bg-surface shadow-card">
                {product.attributes.map((attribute) => (
                  <div
                    key={attribute.name}
                    className="grid gap-0.5 px-4 py-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4"
                  >
                    <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle sm:text-sm sm:normal-case sm:tracking-normal sm:text-ink-muted">
                      {attribute.name}
                    </dt>
                    <dd className="break-words text-ink">{attribute.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* GPSR Art. 19. Below the specifications because it is reference
              material rather than a selling point, but on the page and not
              behind a tab: the regulation is about what a buyer can see before
              they buy, and a panel nobody opens is not something they saw. */}
          <ProductSafetyPanel safety={product.safety} />

          {/* Below the GPSR block: a buyer reads "what is it and is it safe"
              before "what class is it and who certified it". Both are on the
              page rather than behind a tab, because a panel nobody opens is
              not something they saw. */}
          <ProductDevicePanel device={product.device} />
        </div>
      )}
    </>
  );
}
