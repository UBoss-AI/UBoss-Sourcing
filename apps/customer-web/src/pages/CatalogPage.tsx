/**
 * Catalogue: category browsing and search.
 *
 * One component serves `/products`, `/category/:slug` and `/search`, because
 * they are the same list with a different starting filter. Splitting them
 * would mean three copies of the filter, sort and pagination logic, drifting
 * apart.
 *
 * Decisions that matter:
 *
 *   - **All state lives in the URL.** A filtered, sorted, paged result is the
 *     thing a customer sends to a colleague ("these are the ones we need").
 *     State held in a component cannot be sent, bookmarked, or survive a Back.
 *   - **Price filters are typed in major units and sent in minor.** The API
 *     takes `minPrice`/`maxPrice` as whole minor units; a customer types 500,
 *     meaning ₹500, and the conversion is digit shifting, never `× 100`.
 *   - **Sorting is stable server-side.** Every sort ends with `id`, so a
 *     product cannot appear on two pages while another is never shown. This
 *     page must not re-sort what it receives.
 *   - **An unknown category is an empty result, not a 404.** The backend
 *     already decided that — a category may simply have nothing published.
 */
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useLocale } from '@/app/locale-context';
import { ProductCard, ProductCardSkeleton } from '@/components/ProductCard';
import { Button, ErrorState, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { majorToMinor, minorToMajor } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { CategoryNode, ProductListResponse } from '@/lib/types';

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'name_asc', label: 'Name: A to Z' },
  { value: 'name_desc', label: 'Name: Z to A' },
] as const;

const PAGE_SIZE = 24;

/**
 * The filter panel.
 *
 * Price is a real `<form>`: typing a value and pressing Enter applies it. A
 * price box that only reacts to a blur or a separate button is a trap on a
 * phone keyboard, where "done" is the natural action.
 */
function Filters({
  searchParams,
  setParam,
  clearAll,
  currency,
}: {
  searchParams: URLSearchParams;
  setParam: (updates: Record<string, string | null>) => void;
  clearAll: () => void;
  currency: string;
}): React.JSX.Element {
  const minMinor = searchParams.get('minPrice');
  const maxMinor = searchParams.get('maxPrice');

  // Local, so typing stays responsive; committed to the URL on submit.
  const [minText, setMinText] = useState(minMinor === null ? '' : minorToMajor(minMinor));
  const [maxText, setMaxText] = useState(maxMinor === null ? '' : minorToMajor(maxMinor));
  const [priceError, setPriceError] = useState<string | null>(null);

  // Keep the boxes in step with the URL, so Back or Clear resets them too.
  useEffect(() => {
    setMinText(minMinor === null ? '' : minorToMajor(minMinor));
    setMaxText(maxMinor === null ? '' : minorToMajor(maxMinor));
  }, [minMinor, maxMinor]);

  const recurringOnly = searchParams.get('recurringOnly') === 'true';
  const hasFilters =
    minMinor !== null || maxMinor !== null || recurringOnly || searchParams.get('q') !== null;

  const applyPrice = (): void => {
    setPriceError(null);

    const min = minText.trim() === '' ? null : majorToMinor(minText);
    const max = maxText.trim() === '' ? null : majorToMinor(maxText);

    if ((minText.trim() !== '' && min === null) || (maxText.trim() !== '' && max === null)) {
      setPriceError('Enter amounts like 500 or 499.50.');
      return;
    }

    if (min !== null && max !== null && BigInt(max) < BigInt(min)) {
      // Otherwise the result is silently always empty and looks like a fault.
      setPriceError('The highest price cannot be below the lowest.');
      return;
    }

    setParam({ minPrice: min, maxPrice: max });
  };

  return (
    <aside aria-labelledby="filters-heading" className="lg:sticky lg:top-40">
      <div className="rounded-lg border border-border bg-surface p-4">
        <div className="flex items-center justify-between gap-2">
          <h2 id="filters-heading" className="text-sm font-semibold text-ink">
            Filters
          </h2>
          {hasFilters && (
            <Button size="sm" variant="ghost" onClick={clearAll}>
              Clear all
            </Button>
          )}
        </div>

        <form
          className="mt-4 space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            applyPrice();
          }}
        >
          <fieldset>
            <legend className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              Price ({currency})
            </legend>

            <div className="mt-2 flex items-end gap-2">
              <Field label="Lowest">
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    placeholder="Any"
                    className="tabular"
                    value={minText}
                    onChange={(event) => {
                      setMinText(event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="Highest">
                {({ inputId }) => (
                  <Input
                    id={inputId}
                    inputMode="decimal"
                    placeholder="Any"
                    className="tabular"
                    value={maxText}
                    onChange={(event) => {
                      setMaxText(event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            {priceError !== null && (
              <p role="alert" className="mt-1.5 text-xs font-medium text-danger">
                {priceError}
              </p>
            )}

            <Button type="submit" size="sm" className="mt-2" fullWidth>
              Apply price
            </Button>
          </fieldset>
        </form>

        <div className="mt-4 border-t border-border pt-4">
          <label className="flex items-start gap-2.5 text-sm text-ink">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 rounded border-border-strong text-brand"
              checked={recurringOnly}
              onChange={(event) => {
                setParam({ recurringOnly: event.target.checked ? 'true' : null });
              }}
            />
            <span>
              Repeat purchase only
              <span className="mt-0.5 block text-xs text-ink-muted">
                Products that can be put on a schedule.
              </span>
            </span>
          </label>
        </div>
      </div>
    </aside>
  );
}

export function CatalogPage(): React.JSX.Element {
  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { business } = useStorefront();

  const page = Number(searchParams.get('page') ?? '1');
  const sort = searchParams.get('sort') ?? 'newest';
  const q = searchParams.get('q') ?? '';
  const minPrice = searchParams.get('minPrice');
  const maxPrice = searchParams.get('maxPrice');
  const recurringOnly = searchParams.get('recurringOnly') === 'true';

  // The category comes from the path on /category/:slug and is absent
  // elsewhere. One source, so the two cannot disagree.
  const category = slug ?? null;

  const setParam = (updates: Record<string, string | null>): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      for (const [key, value] of Object.entries(updates)) {
        if (value === null || value === '') next.delete(key);
        else next.set(key, value);
      }

      // Any filter change invalidates the page number — page 7 of the old
      // result set very likely does not exist in the new one.
      next.delete('page');
      return next;
    });
  };

  const clearAll = (): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams();
      // The search term is the customer's intent, not a filter, so a "clear
      // filters" on a search page keeps the search.
      const term = current.get('q');
      if (term !== null && term !== '') next.set('q', term);
      return next;
    });
  };

  const categoryDetail = useQuery({
    queryKey: ['category', category],
    queryFn: () => api.get<{ category: CategoryNode }>(`/catalog/categories/${String(category)}`),
    enabled: category !== null,
    // A missing category is an empty list, not an error page.
    retry: false,
  });

  const { currency } = useLocale();

  const products = useQuery({
    // `currency` is part of the key: the same filters in another market are a
    // different result set, because a product priced only in INR is simply not
    // in the USD grid.
    queryKey: [
      'products',
      { page, sort, q, category, minPrice, maxPrice, recurringOnly, currency },
    ],
    queryFn: () =>
      api.get<ProductListResponse>('/catalog/products', {
        query: {
          page,
          limit: PAGE_SIZE,
          sort,
          currency,
          q: q === '' ? undefined : q,
          category: category ?? undefined,
          minPrice: minPrice ?? undefined,
          maxPrice: maxPrice ?? undefined,
          recurringOnly: recurringOnly ? 'true' : undefined,
        },
      }),
    // Keeps the previous page on screen while the next one loads, so paging
    // does not flash an empty grid.
    placeholderData: keepPreviousData,
  });

  const categoryName = categoryDetail.data?.category.name ?? null;

  const heading =
    q !== '' ? `Results for “${q}”` : (categoryName ?? (category === null ? 'All products' : 'Category'));

  useDocumentMeta(
    {
      title: heading,
      description:
        q !== ''
          ? `Search results for ${q} at ${business.displayName}.`
          : categoryName === null
            ? `Browse every product available from ${business.displayName}.`
            : `Browse ${categoryName} at ${business.displayName}.`,
      // A search results page is thin, per-visitor content. Categories and the
      // full catalogue are the pages worth indexing.
      noIndex: q !== '',
    },
    business.displayName,
  );

  const total = products.data?.pagination.total ?? 0;
  const totalPages = products.data?.pagination.totalPages ?? 0;

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-4 text-sm">
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
          {categoryName !== null && (
            <>
              <li aria-hidden="true">/</li>
              <li className="font-medium text-ink" aria-current="page">
                {categoryName}
              </li>
            </>
          )}
        </ol>
      </nav>

      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-ink">{heading}</h1>
          {/* aria-live, so a screen reader hears the count change when a
              filter is applied rather than being left to go and look. */}
          <p className="mt-1 text-sm text-ink-muted" aria-live="polite">
            {products.isPending
              ? 'Loading…'
              : `${String(total)} product${total === 1 ? '' : 's'}`}
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink-muted">
          <span className="whitespace-nowrap">Sort by</span>
          <Select
            value={sort}
            onChange={(event) => {
              setParam({ sort: event.target.value });
            }}
            className="w-48"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </label>
      </div>

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        {/* The price filter is labelled and applied in the shopper's own
            currency, not the business's: it runs against the amounts that
            are actually on screen. */}
        <Filters
          searchParams={searchParams}
          setParam={setParam}
          clearAll={clearAll}
          currency={currency}
        />

        <div>
          {products.isError && (
            <ErrorState
              error={products.error}
              onRetry={() => {
                void products.refetch();
              }}
            />
          )}

          {products.isPending && (
            <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }, (_, index) => (
                <li key={index}>
                  <ProductCardSkeleton />
                </li>
              ))}
            </ul>
          )}

          {products.data !== undefined && products.data.products.length === 0 && (
            <div className="rounded-lg border border-border bg-surface px-6 py-16 text-center">
              <p className="text-base font-medium text-ink">
                {q === '' ? 'Nothing here yet' : `Nothing matches “${q}”`}
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
                {q === ''
                  ? 'Products appear here as soon as they are published.'
                  : 'Try a shorter search, check the spelling, or clear the filters.'}
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Button variant="primary" onClick={clearAll}>
                  Clear filters
                </Button>
                <Link
                  to="/products"
                  className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink hover:bg-surface-sunken"
                >
                  Browse everything
                </Link>
              </div>
            </div>
          )}

          {products.data !== undefined && products.data.products.length > 0 && (
            <>
              <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-4">
                {products.data.products.map((product) => (
                  <li key={product.id}>
                    <ProductCard product={product} />
                  </li>
                ))}
              </ul>

              {totalPages > 1 && (
                <nav
                  aria-label="Pagination"
                  className="mt-8 flex items-center justify-between gap-3 border-t border-border pt-5"
                >
                  <Button
                    disabled={page <= 1}
                    onClick={() => {
                      setSearchParams((current) => {
                        const next = new URLSearchParams(current);
                        next.set('page', String(page - 1));
                        return next;
                      });
                    }}
                  >
                    Previous
                  </Button>

                  <p className="text-sm text-ink-muted" aria-live="polite">
                    Page {page} of {totalPages}
                  </p>

                  <Button
                    disabled={page >= totalPages}
                    onClick={() => {
                      setSearchParams((current) => {
                        const next = new URLSearchParams(current);
                        next.set('page', String(page + 1));
                        return next;
                      });
                    }}
                  >
                    Next
                  </Button>
                </nav>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
