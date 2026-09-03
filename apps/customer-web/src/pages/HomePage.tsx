/**
 * Home.
 *
 * Everything on this page comes from the API — categories with products in
 * them, and the newest published products. Nothing is hard-coded, so the
 * storefront reflects whatever the admin has published without a redeploy.
 *
 * Guests see all of it. A storefront that asks a stranger to sign in before
 * showing a price has already lost them; the sign-in wall belongs at the cart,
 * which is exactly where the backend puts it.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { ProductCard, ProductCardSkeleton } from '@/components/ProductCard';
import { ErrorState } from '@/components/ui';
import { api } from '@/lib/api';
import { useLocale } from '@/app/locale-context';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { CategoryNode, ProductListResponse } from '@/lib/types';

function Hero(): React.JSX.Element {
  const { business } = useStorefront();
  const { isCustomer, isLoading } = useSession();

  return (
    <section className="mb-8 overflow-hidden rounded-xl bg-surface-inverse px-6 py-12 text-ink-inverse sm:px-10 sm:py-16">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Everything your business orders, in one place
        </h1>
        <p className="mt-3 text-base text-ink-inverse/80">
          Browse the {business.displayName} catalogue, order online, and set repeat purchases to
          arrive on a schedule you choose.
        </p>

        <div className="mt-7 flex flex-wrap gap-3">
          <Link
            to="/products"
            className="inline-flex h-12 items-center rounded-md bg-action px-6 text-base font-medium text-white hover:bg-action-hover"
          >
            Browse the catalogue
          </Link>

          {/* Only offered while genuinely signed out, and never during the
              first moment when the session is still unknown - a Sign in button
              that flashes for a signed-in customer looks broken. */}
          {!isLoading && !isCustomer && (
            <Link
              to="/login"
              className="inline-flex h-12 items-center rounded-md border border-white/25 px-6 text-base font-medium text-ink-inverse hover:bg-white/10"
            >
              Sign in to order
            </Link>
          )}
        </div>
      </div>
    </section>
  );
}

function CategoryStrip(): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/catalog/categories'),
    staleTime: 5 * 60_000,
  });

  // A category with nothing published in it is a dead end, so it is not shown.
  const categories = (query.data?.categories ?? []).filter((node) => node.productCount > 0);

  if (categories.length === 0) return null;

  return (
    <section aria-labelledby="shop-by-category" className="mb-10">
      <h2 id="shop-by-category" className="mb-4 text-lg font-semibold tracking-tight text-ink">
        Shop by category
      </h2>

      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {categories.map((category) => (
          <li key={category.id}>
            <Link
              to={`/category/${category.slug}`}
              className="flex h-full flex-col justify-between rounded-lg border border-border bg-surface p-4 transition-shadow hover:shadow-lift"
            >
              <span className="text-sm font-medium text-ink">{category.name}</span>
              <span className="mt-2 text-xs text-ink-muted">
                {category.productCount} product{category.productCount === 1 ? '' : 's'}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewestProducts(): React.JSX.Element {
  const { currency } = useLocale();

  const query = useQuery({
    queryKey: ['products', { sort: 'newest', limit: 8, currency }],
    queryFn: () =>
      api.get<ProductListResponse>('/catalog/products', {
        query: { limit: 8, sort: 'newest', currency },
      }),
  });

  return (
    <section aria-labelledby="latest-products">
      <div className="mb-4 flex items-end justify-between gap-3">
        <h2 id="latest-products" className="text-lg font-semibold tracking-tight text-ink">
          Latest products
        </h2>
        <Link
          to="/products"
          className="text-sm font-medium text-brand hover:underline"
        >
          See all
        </Link>
      </div>

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isPending && (
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <li key={index}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ul>
      )}

      {query.data !== undefined &&
        (query.data.products.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-6 py-14 text-center">
            <p className="text-base font-medium text-ink">Nothing is published yet</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
              Products appear here as soon as they are published. Check back shortly.
            </p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {query.data.products.map((product) => (
              <li key={product.id}>
                <ProductCard product={product} />
              </li>
            ))}
          </ul>
        ))}
    </section>
  );
}

export function HomePage(): React.JSX.Element {
  const { business } = useStorefront();

  useDocumentMeta(
    {
      title: '',
      description: `Browse the ${business.displayName} catalogue. Industrial and business supplies, ordered online with repeat purchase scheduling.`,
    },
    business.displayName,
  );

  return (
    <>
      <Hero />
      <CategoryStrip />
      <NewestProducts />
    </>
  );
}
