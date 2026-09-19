/**
 * Curated shelves, between the department rail and the full catalogue.
 *
 * WHY THE LANDING PAGE NEEDED THESE
 *
 * It had two answers to "what is in this catalogue": a rail of department
 * names, which is a table of contents, and a paginated grid of the newest
 * twelve, which is a list. Neither shows a visitor what the shop actually
 * SELLS - a hospital buyer and a site foreman both landed on the same twelve
 * cards and neither saw anything from their trade unless it happened to be
 * published that week.
 *
 * A handful of shelves fixes that: four groups of departments, six products
 * each, so a visitor sees office supplies, industrial tooling, technology and
 * consumer goods in one screenful and can tell in three seconds whether this
 * catalogue is for them.
 *
 * WHAT IS NOT CLAIMED HERE
 *
 * Nothing on these shelves says popular, trending, recommended or best
 * selling. See `collections.ts`: this storefront has no sales figures to
 * support any of them, and a heading a shopper works out is arbitrary costs
 * more trust than the shelf buys. "New arrivals" is the one claim made, and it
 * is `sort=newest` - the publication date the API already sorts by.
 *
 * WHAT HAPPENS WHEN A DEPARTMENT IS MISSING
 *
 * An operator who has retired "Toys, Hobbies & Crafts" has done something
 * legitimate. The API drops a slug it cannot resolve, so the shelf narrows; a
 * shelf that comes back empty renders NOTHING, heading included, rather than a
 * titled box with a shrug in it. A fresh deployment with nothing published
 * therefore shows no shelves at all and still looks finished, which is the
 * constraint the whole landing page is designed under.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useLocale } from '@/app/locale-context';
import { ProductCard, ProductCardSkeleton } from '@/components/ProductCard';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import type { ProductListResponse } from '@/lib/types';
import { COLLECTION_SIZE, COLLECTIONS, type Collection } from './collections';

/** The grid every shelf on this page uses. Two up on a phone, three at `lg`. */
const GRID = 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6';

interface ShelfProps {
  readonly id: string;
  readonly titleKey: TranslationKey;
  readonly blurbKey: TranslationKey;
  /** Comma-separated department slugs, or undefined for the whole catalogue. */
  readonly categories: string | undefined;
  /** Where "See all" goes. */
  readonly href: string;
}

/**
 * One shelf: a heading, a link out, and six cards.
 *
 * Its own query, deliberately. Five shelves are five small reads that run
 * concurrently and land independently, so a slow department does not hold up
 * the four that are ready - and each one renders or disappears on its own.
 * Combining them into one request would mean one loading state, one failure
 * mode and one empty state for the whole band.
 */
function Shelf({ id, titleKey, blurbKey, categories, href }: ShelfProps): React.JSX.Element | null {
  const { t, language } = useI18n();
  const { currency, country } = useLocale();

  const query = useQuery({
    queryKey: ['home-shelf', { id, currency, country, language }],
    queryFn: () =>
      api.get<ProductListResponse>('/catalog/products', {
        query: {
          ...(categories === undefined ? {} : { category: categories }),
          limit: COLLECTION_SIZE,
          sort: 'newest',
          currency,
          country: country ?? undefined,
          language,
        },
      }),
    staleTime: 5 * 60_000,
  });

  const products = query.data?.products ?? [];

  /*
   * A failed or empty shelf renders nothing at all.
   *
   * Not an error box and not an empty grid: this band is an optional
   * enrichment of a landing page that works perfectly well without it. The
   * hero, the department rail and the full catalogue below are all still
   * there, and a visitor should never be shown the machinery of a shelf that
   * had nothing to put on it.
   */
  if (query.isError) return null;
  if (query.isSuccess && products.length === 0) return null;

  const headingId = `shelf-${id}`;

  return (
    <section aria-labelledby={headingId} className="reveal-rise mb-10">
      <header className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 id={headingId} className="text-title-lg text-ink">
            {t(titleKey)}
          </h2>
          <p className="mt-1 max-w-prose text-sm text-ink-muted">{t(blurbKey)}</p>
        </div>

        {/* The link is a real destination rather than a decoration: it opens
            the catalogue page pre-filtered to exactly the departments this
            shelf is drawn from, so "see all" shows all of what was sampled. */}
        <Link
          to={href}
          className="shrink-0 rounded text-sm font-medium text-brand underline-offset-2
                     hover:text-brand-hover hover:underline
                     focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
        >
          {t('home.seeAll')}
        </Link>
      </header>

      {query.isPending ? (
        <ul className={GRID}>
          {Array.from({ length: COLLECTION_SIZE }, (_, index) => (
            <li key={index}>
              <ProductCardSkeleton />
            </li>
          ))}
        </ul>
      ) : (
        <ul className={GRID}>
          {products.map((product) => (
            <li key={product.id}>
              <ProductCard product={product} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The catalogue URL that shows everything a collection samples from.
 *
 * `/products` and not `/catalog`: the listing page is mounted at `products`,
 * and a link to a path the router does not have renders a 404 under a heading
 * that promised the opposite.
 */
function hrefFor(collection: Collection): string {
  return `/products?category=${encodeURIComponent(collection.categories.join(','))}`;
}

export function CollectionShelves(): React.JSX.Element {
  return (
    <>
      {/* New arrivals leads, because it is the one shelf whose heading makes a
          claim the API can answer, and because on a catalogue that is being
          added to it is the shelf that changes between visits. */}
      <Shelf
        id="new-arrivals"
        titleKey="home.newArrivals"
        blurbKey="home.newArrivalsBlurb"
        categories={undefined}
        href="/products?sort=newest"
      />

      {COLLECTIONS.map((collection) => (
        <Shelf
          key={collection.id}
          id={collection.id}
          titleKey={collection.titleKey}
          blurbKey={collection.blurbKey}
          categories={collection.categories.join(',')}
          href={hrefFor(collection)}
        />
      ))}
    </>
  );
}
