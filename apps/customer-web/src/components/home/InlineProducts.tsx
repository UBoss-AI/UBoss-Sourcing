/**
 * The catalogue, on the greeting page, under the search module.
 *
 * It is on the page whenever the greeting page is, and it is not conditional
 * on anything. The bar above it searches the catalogue; this is the catalogue.
 *
 * Two earlier shapes are worth not repeating. It was once a grid of the eight
 * newest products with no search module above it at all. Then it came and went
 * with a tab, and was mounted only once that tab had been *pressed* — which
 * saved a catalogue read and bought a worse problem: the Products tab sat
 * visibly selected, blue underline and all, with nothing underneath it, and a
 * selected tab with no content reads as a broken page to exactly the person
 * least able to tell that it is not. There is no tab to be on the wrong side
 * of any more: AI Mode is a link to its own page, so Products is the only
 * thing the bar can be. `HomePage` records that where the decision lives.
 *
 * What it deliberately is not: a second catalogue. The facets, the price
 * bounds, the attribute filters and the category tree all live on
 * `CatalogPage`, and reimplementing any of them here would be a second answer
 * to "what is in this catalogue" that could disagree with the first. What this
 * has is the part a shopper on a landing page actually uses — a sort order, a
 * page, and the same `ProductCard` and the same `/catalog/products` read as
 * every other listing in the app, quoted in the same currency for the same
 * destination. Everything past that is one link away.
 *
 * Four states, and each of them is a state somebody will see:
 *
 *   - **Loading.** Skeleton cards, in the grid the results will land in, so
 *     the page does not jump when they arrive.
 *   - **Failed.** The reason and a Try again, not an empty grid. A landing
 *     page whose optional product strip could not load is still a landing
 *     page: the hero above it and the categories beside it work perfectly
 *     well, so this reports rather than throws.
 *   - **Empty.** A fresh deployment has nothing published, and that is an
 *     ordinary answer rather than a fault. It says so.
 *   - **Results.** Which is the interesting one, and the only one anybody
 *     designs for by default.
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useLocale } from '@/app/locale-context';
import { ProductCard, ProductCardSkeleton } from '@/components/ProductCard';
import { Button, ButtonLink, ErrorState, Select } from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber } from '@/lib/format';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import type { ProductListResponse } from '@/lib/types';

/**
 * The same orders the catalogue page offers, minus its two name sorts.
 *
 * A landing-page strip is a taste of the catalogue, and "products A to Z" is
 * not a taste of anything — somebody who wants the alphabet wants the whole
 * list, which is the link at the bottom of this section.
 */
const SORT_OPTIONS = [
  { value: 'newest', labelKey: 'catalog.sortNewest' },
  { value: 'price_asc', labelKey: 'catalog.sortPriceAsc' },
  { value: 'price_desc', labelKey: 'catalog.sortPriceDesc' },
] as const satisfies readonly { value: string; labelKey: TranslationKey }[];

/** Twelve: three full rows at `lg`, two at `sm`, six at `xs`. */
const PAGE_SIZE = 12;

export function InlineProducts(): React.JSX.Element {
  const { t, language } = useI18n();
  const { currency, country } = useLocale();

  const [sort, setSort] = useState<string>('newest');
  const [page, setPage] = useState(1);

  const query = useQuery({
    // The same key shape the catalogue page uses, so the two share a cache
    // entry where the parameters happen to agree. `currency` and `country` are
    // both in it and for different reasons: the currency decides which
    // products are in the result at all, the destination decides what the ones
    // that are in it cost.
    queryKey: ['products', { page, sort, limit: PAGE_SIZE, currency, country, language }],
    queryFn: () =>
      api.get<ProductListResponse>('/catalog/products', {
        query: {
          page,
          limit: PAGE_SIZE,
          sort,
          currency,
          country: country ?? undefined,
          language,
        },
      }),
    // Keep the previous page on screen while the next one loads, so paging
    // does not blink the whole grid back to skeletons.
    placeholderData: keepPreviousData,
  });

  const products = query.data?.products ?? [];
  const pagination = query.data?.pagination ?? null;
  const total = pagination?.total ?? 0;
  // The server's own figure, not one recomputed from the total: the two would
  // disagree the day the API changes its page size, and this is the copy that
  // decides whether Next is disabled.
  const totalPages = pagination?.totalPages ?? 1;

  return (
    <section
      aria-labelledby="inline-products"
      // `scroll-mt` so the sticky header does not sit on top of this heading
      // when an in-page anchor lands on it.
      className="reveal-rise mb-12 scroll-mt-20"
    >
      <header className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
            {t('home.catalogue')}
          </p>
          <h2 id="inline-products" className="mt-1.5 text-title-lg text-ink">
            {t('home.products')}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">
            {query.isSuccess && total > 0
              ? t('home.productCountPricedIn', { count: total, products: formatNumber(total), currency })
              : t('home.everythingPublishedPricedIn', { currency })}
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-2 text-sm text-ink-muted">
            <span className="whitespace-nowrap">{t('catalog.sortBy')}</span>
            <Select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                // A new order makes the current page number meaningless: page
                // 3 of "cheapest first" is not page 3 of "newest".
                setPage(1);
              }}
              className="h-9 w-auto"
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </header>

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
          {Array.from({ length: PAGE_SIZE }, (_, index) => (
            <li key={index}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ul>
      )}

      {query.isSuccess &&
        (products.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-6 py-14 text-center shadow-card">
            <p className="text-base font-medium text-ink">{t('home.nothingIsPublishedYet')}</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
              {t('home.productsAppearHereAsSoon')}
            </p>
          </div>
        ) : (
          <>
            <ul
              // `aria-busy` while a new page is in flight, because the grid on
              // screen is the previous one and a screen reader would otherwise
              // be told nothing had changed.
              aria-busy={query.isFetching}
              className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4"
            >
              {products.map((product) => (
                <li key={product.id}>
                  <ProductCard product={product} />
                </li>
              ))}
            </ul>

            {totalPages > 1 && (
              <nav
                aria-label={t('catalog.pagination')}
                className="mt-6 flex items-center justify-between gap-3"
              >
                <Button
                  variant="secondary"
                  disabled={page <= 1 || query.isFetching}
                  onClick={() => {
                    setPage((current) => Math.max(1, current - 1));
                  }}
                >
                  {t('catalog.previous')}
                </Button>

                <p className="text-sm tabular text-ink-muted">
                  {t('catalog.pageOf', { page, pages: totalPages })}
                </p>

                <Button
                  variant="secondary"
                  disabled={page >= totalPages || query.isFetching}
                  onClick={() => {
                    setPage((current) => current + 1);
                  }}
                >
                  {t('catalog.next')}
                </Button>
              </nav>
            )}

            {/*
             * The way to everything this section deliberately does not do.
             *
             * The facets, the price bounds and the category tree are on the
             * catalogue page, and this is the link to them rather than a
             * second copy of them here.
             */}
            <div className="mt-8 flex flex-col items-center gap-4 rounded-lg border border-border bg-surface px-6 py-8 text-center shadow-card">
              <div>
                <p className="text-title-sm text-ink">{t('home.lookingForSomethingSpecific')}</p>
                <p className="mx-auto mt-1.5 max-w-lg text-sm leading-relaxed text-ink-muted">
                  {t('home.theFullCatalogueCanBe')}
                </p>
              </div>
              <ButtonLink to="/products" variant="secondary" size="lg">
                {t('home.viewAllProducts')}
              </ButtonLink>
            </div>
          </>
        ))}
    </section>
  );
}
