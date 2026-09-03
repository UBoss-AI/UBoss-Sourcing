/**
 * Product detail — the page a purchasing decision is made on.
 *
 * Four things it must get right:
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
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { useLocale } from '@/app/locale-context';
import { useToast } from '@/components/toast-context';
import { QuantityInput } from '@/components/QuantityInput';
import { clampToRules } from '@/lib/quantity-rules';
import { Badge, Button, ErrorState, LoadingState } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatMoney } from '@/lib/format';
import { SafeHtml } from '@/lib/safe-html';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { NotFoundPage } from './NotFoundPage';
import type { Product, ProductDetailResponse, ProductVariant } from '@/lib/types';

function Gallery({ product }: { product: Product }): React.JSX.Element {
  const images = product.images;
  const [activeIndex, setActiveIndex] = useState(0);
  const active = images[activeIndex] ?? product.primaryImage;

  if (active == null) {
    return (
      <div
        aria-hidden="true"
        className="flex aspect-square w-full items-center justify-center rounded-lg border border-border bg-surface text-ink-subtle"
      >
        <svg viewBox="0 0 24 24" className="h-16 w-16" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-hidden rounded-lg border border-border bg-surface">
        <img
          src={active.url}
          alt={active.altText ?? product.name}
          // The hero image is the largest paint on this page, so it is not
          // lazy — deferring it delays the metric it defines.
          loading="eager"
          decoding="async"
          width={800}
          height={800}
          className="aspect-square w-full object-contain p-6"
        />
      </div>

      {images.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto">
          {images.map((image, index) => (
            <li key={image.url}>
              <button
                type="button"
                onClick={() => {
                  setActiveIndex(index);
                }}
                aria-label={`View image ${String(index + 1)} of ${String(images.length)}`}
                aria-current={index === activeIndex}
                className={`block h-16 w-16 shrink-0 overflow-hidden rounded-md border-2 bg-surface ${
                  index === activeIndex ? 'border-brand' : 'border-border'
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
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Variant picker.
 *
 * Grouped by option name ("Size", "Pack") so the choices read the way a
 * catalogue reads, rather than as a flat list of SKU names.
 */
function VariantPicker({
  variants,
  selectedId,
  onSelect,
}: {
  variants: ProductVariant[];
  selectedId: string | null;
  onSelect: (variant: ProductVariant) => void;
}): React.JSX.Element {
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink">Choose an option</legend>

      <div className="mt-2 flex flex-wrap gap-2">
        {variants.map((variant) => {
          const isSelected = variant.id === selectedId;
          const optionText = Object.entries(variant.options)
            .map(([key, value]) => `${key}: ${value}`)
            .join(', ');

          return (
            <button
              key={variant.id}
              type="button"
              // A radio group in spirit; aria-pressed carries the state that
              // the border colour shows sighted users.
              aria-pressed={isSelected}
              onClick={() => {
                onSelect(variant);
              }}
              className={`rounded-md border px-3.5 py-2 text-left text-sm transition-colors ${
                isSelected
                  ? 'border-brand bg-brand-soft text-brand'
                  : 'border-border-strong bg-surface text-ink hover:border-brand/40'
              }`}
            >
              <span className="block font-medium">{variant.name}</span>
              {optionText !== '' && (
                <span className="mt-0.5 block text-xxs text-ink-muted">{optionText}</span>
              )}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ProductPage(): React.JSX.Element {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { isCustomer } = useSession();
  const { business, features } = useStorefront();

  const [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [addError, setAddError] = useState<string | null>(null);

  const { currency } = useLocale();

  const query = useQuery({
    queryKey: ['product', slug, currency],
    queryFn: () =>
      api.get<ProductDetailResponse>(`/catalog/products/${String(slug)}`, {
        query: { currency },
      }),
    enabled: slug !== undefined,
    retry: false,
  });

  const product = query.data?.product;

  // Set the opening quantity to the lowest the rules allow, and preselect the
  // only variant when there is exactly one — an unnecessary choice is friction.
  useEffect(() => {
    if (product === undefined) return;

    setQuantity(clampToRules(product.purchaseRules.minOrderQty, product.purchaseRules));

    if (product.variants.length === 1) {
      setSelectedVariantId(product.variants[0]?.id ?? null);
    }
  }, [product]);

  // `exactOptionalPropertyTypes` means an absent description is an absent key,
  // not a key holding undefined — so the object is built before it is passed.
  const description =
    product === undefined
      ? null
      : (product.shortDescription ?? `${product.name} — available from ${business.displayName}.`);

  useDocumentMeta(
    {
      title: product?.name ?? 'Product',
      ...(description === null ? {} : { description }),
    },
    business.displayName,
  );

  const addToCart = useMutation({
    mutationFn: () =>
      api.post('/cart/items', {
        productId: product?.id,
        variantId: selectedVariantId,
        quantity,
      }),
    onSuccess: async () => {
      setAddError(null);
      toast.success('Added to your cart.');
      await queryClient.invalidateQueries({ queryKey: ['cart'] });
    },
    onError: (error) => {
      // The server's message names the rule that was broken — a minimum, a
      // stock shortfall, a spend cap. Replacing it with "could not add" throws
      // away the only thing that tells the customer what to change.
      setAddError(
        error instanceof ApiError ? error.message : 'This item could not be added to your cart.',
      );
    },
  });

  if (query.isPending) return <LoadingState label="Loading the product" />;

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

  const selectedVariant = product.variants.find((variant) => variant.id === selectedVariantId);
  const displayPrice = selectedVariant?.price ?? product.price;
  const needsVariant = product.hasVariants && product.variants.length > 0;
  const isReady = !needsVariant || selectedVariantId !== null;

  const hasDiscount =
    product.compareAtPrice !== null &&
    BigInt(product.compareAtPrice.minor) > BigInt(displayPrice.minor);

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-5 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-muted">
          <li>
            <Link to="/" className="hover:text-brand hover:underline">
              Home
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link to="/products" className="hover:text-brand hover:underline">
              Products
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

      <div className="grid gap-8 lg:grid-cols-2">
        <Gallery product={product} />

        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">
            {product.name}
          </h1>

          <p className="mt-1.5 font-mono text-xs text-ink-subtle">Product code {product.sku}</p>

          {product.shortDescription !== null && (
            <p className="mt-3 text-base text-ink-muted">{product.shortDescription}</p>
          )}

          {/* --- Price ------------------------------------------------------ */}
          <div className="mt-6 border-y border-border py-5">
            <p className="flex flex-wrap items-baseline gap-3">
              <span className="text-3xl font-semibold tabular tracking-tight text-ink">
                {formatMoney(displayPrice)}
              </span>
              {hasDiscount && product.compareAtPrice !== null && (
                <span className="text-base tabular text-ink-subtle line-through">
                  {formatMoney(product.compareAtPrice)}
                </span>
              )}
            </p>

            <p className="mt-1.5 text-sm text-ink-muted">
              {product.tax.inclusive
                ? `Includes ${product.tax.ratePercent}% ${product.tax.code}.`
                : `${product.tax.ratePercent}% ${product.tax.code} is added at checkout.`}
            </p>

            {selectedVariant?.price != null && (
              <p className="mt-1 text-xs text-ink-subtle">
                Price shown for {selectedVariant.name}.
              </p>
            )}
          </div>

          {/* --- Choices ---------------------------------------------------- */}
          <div className="mt-6 space-y-5">
            {needsVariant && (
              <VariantPicker
                variants={product.variants}
                selectedId={selectedVariantId}
                onSelect={(variant) => {
                  setSelectedVariantId(variant.id);
                  setAddError(null);
                }}
              />
            )}

            <QuantityInput
              value={quantity}
              onChange={(next) => {
                setQuantity(next);
                setAddError(null);
              }}
              rules={product.purchaseRules}
            />

            {addError !== null && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-sm text-danger"
              >
                {addError}
              </p>
            )}

            {isCustomer ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="action"
                  size="lg"
                  disabled={!isReady}
                  isLoading={addToCart.isPending}
                  onClick={() => {
                    addToCart.mutate();
                  }}
                >
                  Add to cart
                </Button>

                {features.recurringOrders && product.purchaseRules.isRecurringEligible && (
                  <Link
                    to={`/schedules/new?productId=${product.id}&quantity=${String(quantity)}${
                      selectedVariantId === null ? '' : `&variantId=${selectedVariantId}`
                    }`}
                    className="inline-flex h-12 items-center rounded-md border border-border-strong bg-surface px-6 text-base font-medium text-ink hover:bg-surface-sunken"
                  >
                    Set up a repeat purchase
                  </Link>
                )}
              </div>
            ) : (
              <div className="rounded-md border border-border bg-surface-sunken p-4">
                <p className="text-sm text-ink">Sign in to add this to your cart.</p>
                <Button
                  variant="primary"
                  className="mt-3"
                  onClick={() => {
                    void navigate('/login', {
                      state: { from: `/product/${product.slug}` },
                    });
                  }}
                >
                  Sign in to order
                </Button>
              </div>
            )}

            {!isReady && (
              <p className="text-sm text-ink-muted">Choose an option to continue.</p>
            )}

            {/* Deliberately not a stock number. The public catalogue does not
                publish quantities, and inventing "In stock" would be a claim
                this page cannot back. */}
            <p className="text-xs text-ink-subtle">
              {product.isStockTracked
                ? 'Availability is confirmed when the item is added to your cart.'
                : 'Made to order — lead time confirmed after your order is placed.'}
            </p>
          </div>

          {product.purchaseRules.isRecurringEligible && (
            <p className="mt-5">
              <Badge tone="brand">Available as a repeat purchase</Badge>
            </p>
          )}
        </div>
      </div>

      {/* --- Description and specifications --------------------------------- */}
      {(product.description !== null ||
        product.descriptionHtml !== null ||
        product.attributes.length > 0) && (
        <div className="mt-12 grid gap-8 border-t border-border pt-8 lg:grid-cols-2">
          {(product.description !== null || product.descriptionHtml !== null) && (
            <section aria-labelledby="description-heading">
              <h2 id="description-heading" className="text-lg font-semibold text-ink">
                Description
              </h2>

              {product.descriptionHtml === null ? (
                <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-ink-muted">
                  {product.description}
                </p>
              ) : (
                <SafeHtml
                  html={product.descriptionHtml}
                  className="prose-sm mt-3 text-sm leading-relaxed text-ink-muted [&_a]:text-brand [&_a]:underline [&_h2]:mt-4 [&_h2]:font-semibold [&_h2]:text-ink [&_h3]:mt-3 [&_h3]:font-medium [&_h3]:text-ink [&_li]:ml-5 [&_li]:list-disc [&_p]:mt-2 [&_table]:mt-3 [&_table]:w-full [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1"
                />
              )}
            </section>
          )}

          {product.attributes.length > 0 && (
            <section aria-labelledby="specifications-heading">
              <h2 id="specifications-heading" className="text-lg font-semibold text-ink">
                Specifications
              </h2>

              <dl className="mt-3 divide-y divide-border rounded-lg border border-border">
                {product.attributes.map((attribute) => (
                  <div key={attribute.name} className="flex gap-4 px-4 py-2.5 text-sm">
                    <dt className="w-40 shrink-0 text-ink-muted">{attribute.name}</dt>
                    <dd className="text-ink">{attribute.value}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}
        </div>
      )}
    </>
  );
}
