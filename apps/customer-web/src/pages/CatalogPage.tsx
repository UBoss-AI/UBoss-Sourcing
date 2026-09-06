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
 *   - **What is filtering the list is stated above the list.** Every applied
 *     filter is a chip that removes itself, so a customer looking at four
 *     results does not have to go hunting through a sidebar — or, on a phone,
 *     open a drawer — to find out why there are only four. The chips write to
 *     the same URL parameters as the controls; there is one source of truth
 *     and it is the address bar.
 *   - **The filter controls exist once.** `FilterFields` is rendered in the
 *     desktop sidebar and inside the mobile dialog. Two copies of a price
 *     validator is how the two quietly stop agreeing.
 */
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useLocale } from '@/app/locale-context';
import { ProductCard, ProductCardSkeleton } from '@/components/ProductCard';
import { Modal } from '@/components/Modal';
import { Button, ErrorState, Field, Input, Select } from '@/components/ui';
import { api } from '@/lib/api';
import {
  currencySymbol,
  formatMoney,
  formatNumber,
  majorToMinor,
  minorToMajor,
} from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { CatalogFilterFacets, CategoryNode, ProductListResponse } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

const SORT_OPTIONS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'price_asc', label: 'Price: low to high' },
  { value: 'price_desc', label: 'Price: high to low' },
  { value: 'name_asc', label: 'Name: A to Z' },
  { value: 'name_desc', label: 'Name: Z to A' },
] as const;

const PAGE_SIZE = 24;

/** One applied filter, and the one thing it can do: take itself off. */
interface AppliedFilter {
  key: string;
  label: string;
  remove: () => void;
}

/**
 * How many values a facet shows before it offers to unfold.
 *
 * A sidebar is 16rem wide and there may be four facets in it. A brand list
 * forty long, opened by default, pushes every other filter off the screen.
 */
const FACET_VALUES_SHOWN = 6;

/** How recently added, as a filter. */
const ADDED_WITHIN_OPTIONS = [7, 30, 90] as const;

/** One ticked facet value, in the form the API and the URL both carry. */
function attrToken(name: string, value: string): string {
  return `${name}:${value}`;
}

/**
 * The ticked facet values, grouped by attribute name.
 *
 * Only the first colon separates: a value may contain one of its own ("Ratio:
 * 1:2"), and splitting on every colon would quietly corrupt it. A token
 * without a name is skipped rather than shown as a nameless chip — it can only
 * come from an edited URL, and the backend ignores it too.
 */
function parseAttrTokens(tokens: string[]): Map<string, string[]> {
  const byName = new Map<string, string[]>();

  for (const token of tokens) {
    const separator = token.indexOf(':');
    if (separator <= 0) continue;

    const name = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (value === '') continue;

    byName.set(name, [...(byName.get(name) ?? []), value]);
  }

  return byName;
}

/**
 * A tick box whose whole row is the target.
 *
 * On a phone the label is what a thumb actually hits, and an explanation of
 * what the filter means has to travel with it rather than sit beside it as a
 * caption that scrolls away on its own.
 */
function ToggleRow({
  checked,
  onChange,
  label,
  hint,
  count,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint?: string;
  count?: number;
}): React.JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md p-2 -mx-2 text-sm text-ink transition-colors hover:bg-surface-hover">
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 rounded border-border-strong text-brand"
        checked={checked}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{label}</span>
          {/* How many products carry this value, under the other filters
              already applied. A zero is shown rather than hidden: a value that
              vanishes the moment the panel is used reads as a fault. */}
          {count !== undefined && (
            <span className="shrink-0 text-xs tabular text-ink-subtle">{formatNumber(count)}</span>
          )}
        </span>
        {hint !== undefined && (
          <span className="mt-0.5 block text-xs leading-relaxed text-ink-muted">{hint}</span>
        )}
      </span>
    </label>
  );
}

/**
 * One attribute facet — a heading and its values.
 *
 * Which facets exist is the administrator's choice, taken per product by
 * marking an attribute filterable, so nothing about Brand or Finish is written
 * into this page. It renders whatever the catalogue says it has.
 */
function FacetGroup({
  name,
  values,
  selected,
  onToggle,
}: {
  name: string;
  values: { value: string; count: number }[];
  selected: string[];
  onToggle: (value: string, checked: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const [isExpanded, setIsExpanded] = useState(false);

  // A ticked value always shows, however far down the list it sits. Otherwise
  // a filter that is doing something is invisible until the group is unfolded.
  const visible = isExpanded
    ? values
    : values.filter((entry, index) => index < FACET_VALUES_SHOWN || selected.includes(entry.value));

  const hidden = values.length - visible.length;

  return (
    <div className="pt-4">
      <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">{name}</p>

      <div className="mt-2.5">
        {visible.map((entry) => (
          <ToggleRow
            key={entry.value}
            checked={selected.includes(entry.value)}
            onChange={(checked) => {
              onToggle(entry.value, checked);
            }}
            label={entry.value}
            count={entry.count}
          />
        ))}
      </div>

      {(hidden > 0 || isExpanded) && (
        <button
          type="button"
          onClick={() => {
            setIsExpanded(!isExpanded);
          }}
          className="mt-1 text-xs font-medium text-brand hover:underline"
        >
          {isExpanded ? t('catalog.showFewer') : t('catalog.showAll', { count: values.length })}
        </button>
      )}
    </div>
  );
}

/**
 * The filter controls themselves, with no chrome of their own.
 *
 * Rendered inside the desktop sidebar card and inside the mobile dialog, which
 * supply their own heading and Clear all — so this owns the controls and
 * nothing about where they sit.
 *
 * Price is a real `<form>`: typing a value and pressing Enter applies it. A
 * price box that only reacts to a blur or a separate button is a trap on a
 * phone keyboard, where "done" is the natural action. Everything else applies
 * on the spot — two boxes needing confirmation and eight controls not needing
 * it is a panel a shopper stops trusting.
 */
function FilterFields({
  searchParams,
  setParam,
  currency,
  facets,
}: {
  searchParams: URLSearchParams;
  setParam: (updates: Record<string, string | string[] | null>) => void;
  currency: string;
  facets: CatalogFilterFacets | undefined;
}): React.JSX.Element {
  const { t } = useI18n();

  const minMinor = searchParams.get('minPrice');
  const maxMinor = searchParams.get('maxPrice');

  // Local, so typing stays responsive; committed to the URL on submit.
  const [minText, setMinText] = useState(minMinor === null ? '' : minorToMajor(minMinor));
  const [maxText, setMaxText] = useState(maxMinor === null ? '' : minorToMajor(maxMinor));
  const [priceError, setPriceError] = useState<string | null>(null);

  // Keep the boxes in step with the URL, so Back, Clear all or a removed chip
  // resets them too.
  useEffect(() => {
    setMinText(minMinor === null ? '' : minorToMajor(minMinor));
    setMaxText(maxMinor === null ? '' : minorToMajor(maxMinor));
  }, [minMinor, maxMinor]);

  const recurringOnly = searchParams.get('recurringOnly') === 'true';
  const inStockOnly = searchParams.get('inStock') === 'true';
  const onSaleOnly = searchParams.get('onSale') === 'true';
  const addedWithin = searchParams.get('added') ?? '';

  const attrTokens = searchParams.getAll('attr');
  const selectedAttrs = parseAttrTokens(attrTokens);

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

  const toggleAttr = (name: string, value: string, checked: boolean): void => {
    const token = attrToken(name, value);

    setParam({
      attr: checked ? [...attrTokens, token] : attrTokens.filter((existing) => existing !== token),
    });
  };

  const range = facets?.priceRange;

  return (
    <div className="divide-y divide-border-subtle">
      <form
        className="pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          applyPrice();
        }}
      >
        <fieldset>
          {/* The currency is in the legend rather than in each box: it applies
              to both, and repeating it twice in a 16rem column is noise. */}
          <legend className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
            Price ({currencySymbol(currency).trim()} {currency})
          </legend>

          <div className="mt-2.5 flex items-start gap-2">
            <Field label={t('catalog.lowest')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  placeholder={t('catalog.any')}
                  className="tabular"
                  value={minText}
                  onChange={(event) => {
                    setMinText(event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label={t('catalog.highest')}>
              {({ inputId }) => (
                <Input
                  id={inputId}
                  inputMode="decimal"
                  placeholder={t('catalog.any')}
                  className="tabular"
                  value={maxText}
                  onChange={(event) => {
                    setMaxText(event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          {/* What this catalogue actually holds, so the boxes are not a guess.
              It ignores the price filter itself — a range that narrowed to
              whatever was last typed would tell the shopper nothing. */}
          {range?.min != null && range.max != null && (
            <p className="mt-2 text-xs text-ink-muted">
              {t('catalog.priceRangeHint', {
                min: formatMoney(range.min),
                max: formatMoney(range.max),
              })}
            </p>
          )}

          {priceError !== null && (
            <p role="alert" className="mt-2 text-xs font-medium text-danger">
              {priceError}
            </p>
          )}

          <Button type="submit" size="sm" className="mt-3" fullWidth>
            {t('catalog.applyPrice')}
          </Button>
        </fieldset>
      </form>

      {/* One plainly worded group, not three headings in shop language.
          "Availability", "Offers" and "Purchasing" are what a merchandiser
          calls these; "Show only" is what everybody else calls them, and each
          row says in ordinary words what ticking it does.

          A whole tappable row rather than a bare checkbox with a caption
          beside it: on a phone the label is the target, and the sentence
          explaining the filter has to travel with it. */}
      <div className="pt-4">
        <p className="text-xxs font-semibold uppercase tracking-wider text-ink-subtle">
          {t('catalog.showOnly')}
        </p>

        <div className="mt-2.5">
          <ToggleRow
            checked={inStockOnly}
            onChange={(checked) => {
              setParam({ inStock: checked ? 'true' : null });
            }}
            label={t('catalog.inStock')}
            hint={t('catalog.inStockHint')}
          />
          <ToggleRow
            checked={onSaleOnly}
            onChange={(checked) => {
              setParam({ onSale: checked ? 'true' : null });
            }}
            label={t('catalog.onOffer')}
            hint={t('catalog.onOfferHint')}
          />
          <ToggleRow
            checked={recurringOnly}
            onChange={(checked) => {
              setParam({ recurringOnly: checked ? 'true' : null });
            }}
            label={t('catalog.repeatPurchaseOnly')}
            hint={t('catalog.productsThatCanBePut')}
          />
        </div>
      </div>

      <div className="pt-4">
        <Field label={t('catalog.whenItWasAdded')}>
          {({ inputId }) => (
            <Select
              id={inputId}
              value={addedWithin}
              onChange={(event) => {
                setParam({ added: event.target.value === '' ? null : event.target.value });
              }}
            >
              <option value="">{t('catalog.anyTime')}</option>
              {ADDED_WITHIN_OPTIONS.map((days) => (
                <option key={days} value={String(days)}>
                  {t('catalog.lastDays', { days })}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      {/* Whatever this catalogue says it can be filtered by. Nothing is
          rendered while that is unknown, rather than a row of empty groups. */}
      {facets?.attributes.map((facet) => (
        <FacetGroup
          key={facet.name}
          name={facet.name}
          values={facet.values}
          selected={selectedAttrs.get(facet.name) ?? []}
          onToggle={(value, checked) => {
            toggleAttr(facet.name, value, checked);
          }}
        />
      ))}
    </div>
  );
}

/**
 * The applied-filter chips.
 *
 * Each one names the filter in the shopper's own terms and removes exactly the
 * URL parameters it represents. Clear all sits at the end of the same row, so
 * "take one off" and "start again" are the same gesture at two scales.
 */
function AppliedFilters({
  applied,
  clearAll,
}: {
  applied: AppliedFilter[];
  clearAll: () => void;
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (applied.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium text-ink-muted">{t('catalog.filteredBy')}</span>

      <ul className="flex flex-wrap items-center gap-1.5">
        {applied.map((filter) => (
          <li key={filter.key}>
            <button
              type="button"
              onClick={filter.remove}
              aria-label={`Remove filter: ${filter.label}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-brand/25 bg-brand-soft
                         py-1 pl-2.5 pr-2 text-xs font-medium text-brand transition-colors
                         hover:border-brand/40 hover:bg-brand-soft-hover"
            >
              {filter.label}
              {/* Decoration: the button's accessible name already says what
                  pressing it does. */}
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="h-3 w-3"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              >
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </li>
        ))}
      </ul>

      <Button size="sm" variant="ghost" onClick={clearAll}>
        {t('catalog.clearAll')}
      </Button>
    </div>
  );
}

export function CatalogPage(): React.JSX.Element {
  const { t } = useI18n();

  const { slug } = useParams<{ slug: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { business } = useStorefront();

  // Mobile only. Desktop keeps the sidebar, so this never opens there.
  const [isFilterDrawerOpen, setIsFilterDrawerOpen] = useState(false);

  const page = Number(searchParams.get('page') ?? '1');
  const sort = searchParams.get('sort') ?? 'newest';
  const q = searchParams.get('q') ?? '';
  const minPrice = searchParams.get('minPrice');
  const maxPrice = searchParams.get('maxPrice');
  const recurringOnly = searchParams.get('recurringOnly') === 'true';
  const inStockOnly = searchParams.get('inStock') === 'true';
  const onSaleOnly = searchParams.get('onSale') === 'true';
  const addedWithin = searchParams.get('added');
  const attrTokens = searchParams.getAll('attr');

  // The category comes from the path on /category/:slug and is absent
  // elsewhere. One source, so the two cannot disagree.
  const category = slug ?? null;

  const setParam = (updates: Record<string, string | string[] | null>): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);

      for (const [key, value] of Object.entries(updates)) {
        // An array replaces every occurrence of the key: a facet with three
        // values ticked is three `attr=` parameters, and an empty array is the
        // facet being cleared.
        if (Array.isArray(value)) {
          next.delete(key);
          for (const entry of value) next.append(key, entry);
          continue;
        }

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
  const { language } = useI18n();

  const products = useQuery({
    // `currency` is part of the key: the same filters in another market are a
    // different result set, because a product priced only in INR is simply not
    // in the USD grid. `language` is part of it for a smaller reason - the
    // names come back translated, so a cached English grid would be wrong.
    queryKey: [
      'products',
      {
        page,
        sort,
        q,
        category,
        minPrice,
        maxPrice,
        recurringOnly,
        inStockOnly,
        onSaleOnly,
        addedWithin,
        attrTokens,
        currency,
        language,
      },
    ],
    queryFn: () =>
      api.get<ProductListResponse>('/catalog/products', {
        query: {
          page,
          limit: PAGE_SIZE,
          sort,
          currency,
          language,
          q: q === '' ? undefined : q,
          category: category ?? undefined,
          minPrice: minPrice ?? undefined,
          maxPrice: maxPrice ?? undefined,
          recurringOnly: recurringOnly ? 'true' : undefined,
          inStockOnly: inStockOnly ? 'true' : undefined,
          onSaleOnly: onSaleOnly ? 'true' : undefined,
          addedWithinDays: addedWithin ?? undefined,
          attr: attrTokens,
        },
      }),
    // Keeps the previous page on screen while the next one loads, so paging
    // does not flash an empty grid.
    placeholderData: keepPreviousData,
  });

  /*
   * What this catalogue can be filtered by.
   *
   * A separate request from the grid, because the answer is different: the
   * grid is one page of products, this is every filter that would do something
   * to the whole result. Which attributes are offered is the administrator's
   * decision — an attribute becomes a facet when they mark it filterable — so
   * the panel asks rather than hard-coding names that would be wrong for the
   * next business to install this.
   *
   * The ticked facet values are deliberately absent from both the key and the
   * request: the counts are taken with the attribute filters left off, so
   * ticking a brand must not make the list of brands reload and shuffle under
   * the cursor.
   */
  const facets = useQuery({
    queryKey: [
      'catalog-filters',
      {
        q,
        category,
        minPrice,
        maxPrice,
        recurringOnly,
        inStockOnly,
        onSaleOnly,
        addedWithin,
        currency,
      },
    ],
    queryFn: () =>
      api.get<CatalogFilterFacets>('/catalog/filters', {
        query: {
          currency,
          q: q === '' ? undefined : q,
          category: category ?? undefined,
          minPrice: minPrice ?? undefined,
          maxPrice: maxPrice ?? undefined,
          recurringOnly: recurringOnly ? 'true' : undefined,
          inStockOnly: inStockOnly ? 'true' : undefined,
          onSaleOnly: onSaleOnly ? 'true' : undefined,
          addedWithinDays: addedWithin ?? undefined,
        },
      }),
    // The panel keeps the filters it already has while the next counts load.
    // A sidebar that empties itself on every tick is unusable.
    placeholderData: keepPreviousData,
  });

  const categoryName = categoryDetail.data?.category.name ?? null;

  const heading =
    q !== ''
      ? `Results for “${q}”`
      : (categoryName ?? (category === null ? 'All products' : 'Category'));

  // What kind of listing this is, above the title. A search result and a
  // department are not the same thing arrived at the same way, and the
  // eyebrow is cheaper than saying so in the heading.
  const eyebrow = q !== '' ? 'Search' : categoryName === null ? 'Catalogue' : 'Category';

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

  const pagination = products.data?.pagination;
  const total = pagination?.total ?? 0;
  const totalPages = pagination?.totalPages ?? 0;

  /*
   * The applied filters, in the order they read.
   *
   * Only the ones a chip can actually take off. The search term is the
   * customer's intent rather than a filter — `clearAll` keeps it, so offering
   * a chip that claimed to remove it would be a lie — and the category is
   * already stated by the breadcrumb and the heading.
   */
  const applied: AppliedFilter[] = [];

  if (minPrice !== null || maxPrice !== null) {
    const symbol = currencySymbol(currency);
    const low = minPrice === null ? null : `${symbol}${minorToMajor(minPrice)}`;
    const high = maxPrice === null ? null : `${symbol}${minorToMajor(maxPrice)}`;

    applied.push({
      key: 'price',
      label:
        low !== null && high !== null
          ? `${low} – ${high}`
          : low !== null
            ? `From ${low}`
            : `Up to ${high ?? ''}`,
      remove: () => {
        setParam({ minPrice: null, maxPrice: null });
      },
    });
  }

  if (inStockOnly) {
    applied.push({
      key: 'inStock',
      label: t('catalog.inStock'),
      remove: () => {
        setParam({ inStock: null });
      },
    });
  }

  if (onSaleOnly) {
    applied.push({
      key: 'onSale',
      label: t('catalog.onOffer'),
      remove: () => {
        setParam({ onSale: null });
      },
    });
  }

  if (addedWithin !== null) {
    applied.push({
      key: 'added',
      label: t('catalog.addedInTheLastDays', { days: addedWithin }),
      remove: () => {
        setParam({ added: null });
      },
    });
  }

  if (recurringOnly) {
    applied.push({
      key: 'recurringOnly',
      label: t('catalog.repeatPurchaseOnly'),
      remove: () => {
        setParam({ recurringOnly: null });
      },
    });
  }

  // One chip per ticked facet value, not one per attribute: "Brand: Acme" and
  // "Brand: Bosch" are two separate things to have changed your mind about,
  // and a single chip that removed both would take away more than it says.
  for (const token of attrTokens) {
    const separator = token.indexOf(':');
    if (separator <= 0) continue;

    applied.push({
      key: `attr:${token}`,
      label: `${token.slice(0, separator)}: ${token.slice(separator + 1)}`,
      remove: () => {
        setParam({ attr: attrTokens.filter((existing) => existing !== token) });
      },
    });
  }

  /*
   * The result count, as a sentence.
   *
   * A range ("25–48 of 312") rather than a bare total once the list is paged:
   * on page 3 of a filtered catalogue, "312 products" is the least useful true
   * thing this line could say. Both numbers come from the server's own
   * pagination block, so nothing here is estimated.
   */
  const countLabel = ((): string => {
    if (products.isPending) return 'Loading…';
    if (total === 0) return 'No products';

    const noun = `product${total === 1 ? '' : 's'}`;

    if (pagination === undefined || pagination.totalPages <= 1) {
      return `${formatNumber(total)} ${noun}`;
    }

    const first = (pagination.page - 1) * pagination.limit + 1;
    const last = Math.min(pagination.page * pagination.limit, total);

    return `Showing ${formatNumber(first)}–${formatNumber(last)} of ${formatNumber(total)} ${noun}`;
  })();

  const sortControl = (
    <label className="flex items-center gap-2 text-sm text-ink-muted">
      <span className="whitespace-nowrap">{t('catalog.sortBy')}</span>
      <Select
        value={sort}
        onChange={(event) => {
          setParam({ sort: event.target.value });
        }}
        className="w-44 sm:w-48"
      >
        {SORT_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    </label>
  );

  return (
    <>
      <nav aria-label={t('catalog.breadcrumb')} className="mb-4 text-sm">
        <ol className="flex flex-wrap items-center gap-1.5 text-ink-muted">
          <li>
            <Link to="/" className="hover:text-brand hover:underline">
              {t('catalog.home')}
            </Link>
          </li>
          <li aria-hidden="true">/</li>
          <li>
            <Link to="/products" className="hover:text-brand hover:underline">
              {t('catalog.products')}
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

      <header className="mb-5">
        <p className="text-xxs font-semibold uppercase tracking-[0.14em] text-ink-subtle">
          {eyebrow}
        </p>
        <h1 className="mt-1.5 text-title-xl text-ink">{heading}</h1>
        {/* aria-live, so a screen reader hears the count change when a filter
            is applied rather than being left to go and look. */}
        <p className="mt-1.5 text-sm text-ink-muted" aria-live="polite">
          {countLabel}
        </p>
      </header>

      {/*
       * The toolbar.
       *
       * One strip carrying everything that changes the shape of the list:
       * the mobile filters trigger, the applied chips, and the sort. Its own
       * surface, so it reads as controls rather than as the first row of the
       * results — which is what a bare sort dropdown floating above a grid
       * always looked like.
       */}
      <div className="mb-5 rounded-lg border border-border bg-surface px-4 py-3 shadow-card">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            {/* Desktop keeps the sidebar; this is the phone's way in. The
                count on the button is what tells someone with the drawer shut
                that the list is filtered at all. */}
            <Button
              className="lg:hidden"
              onClick={() => {
                setIsFilterDrawerOpen(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={isFilterDrawerOpen}
            >
              <svg
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="h-4 w-4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
              >
                <path d="M4 6h16M7 12h10M10 18h4" />
              </svg>
              Filters
              {applied.length > 0 && (
                <span className="ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1.5 text-xxs font-semibold text-white">
                  {applied.length}
                </span>
              )}
            </Button>

            {/* Chips are useful at every width, so they are not inside the
                drawer: the whole point is to be readable without opening it. */}
            <AppliedFilters applied={applied} clearAll={clearAll} />
          </div>

          <div className="ml-auto shrink-0">{sortControl}</div>
        </div>
      </div>

      {/* Mounted only while open, so the controls exist once at a time and the
          price boxes always open reading the current URL. */}
      {isFilterDrawerOpen && (
        <Modal
          isOpen
          onClose={() => {
            setIsFilterDrawerOpen(false);
          }}
          title={t('catalog.filters')}
          description={t('catalog.changesApplyStraightAway')}
          footer={
            <>
              {applied.length > 0 && (
                <Button
                  variant="ghost"
                  onClick={() => {
                    clearAll();
                  }}
                >
                  {t('catalog.clearAll')}
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => {
                  setIsFilterDrawerOpen(false);
                }}
              >
                {products.isPending
                  ? 'Show results'
                  : `Show ${formatNumber(total)} product${total === 1 ? '' : 's'}`}
              </Button>
            </>
          }
        >
          <FilterFields
            searchParams={searchParams}
            setParam={setParam}
            currency={currency}
            facets={facets.data}
          />
        </Modal>
      )}

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        {/* Desktop keeps the sidebar: on a wide screen the filters are cheap
            to show and expensive to hide, and a sticky column means they stay
            reachable however far down the grid you are.

            The price filter is labelled and applied in the shopper's own
            currency, not the business's: it runs against the amounts that are
            actually on screen. */}
        <aside
          aria-labelledby="filters-heading"
          className="hidden lg:block lg:sticky lg:top-40 lg:self-start"
        >
          <div className="rounded-lg border border-border bg-surface shadow-card">
            <div className="flex items-center justify-between gap-2 border-b border-border-subtle px-4 py-3">
              <h2 id="filters-heading" className="text-title-xs text-ink">
                {t('catalog.filters')}
              </h2>
              {applied.length > 0 && (
                <Button size="sm" variant="ghost" onClick={clearAll}>
                  {t('catalog.clearAll')}
                </Button>
              )}
            </div>

            <div className="px-4 py-4">
              <FilterFields
                searchParams={searchParams}
                setParam={setParam}
                currency={currency}
                facets={facets.data}
              />
            </div>
          </div>
        </aside>

        <div className="min-w-0">
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
            <div className="rounded-lg border border-border bg-surface px-6 py-16 text-center shadow-card">
              <p className="text-title-sm text-ink">
                {q === '' ? 'Nothing here yet' : `Nothing matches “${q}”`}
              </p>
              <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-ink-muted">
                {q === ''
                  ? 'Products appear here as soon as they are published.'
                  : 'Try a shorter search, check the spelling, or clear the filters.'}
              </p>
              <div className="mt-5 flex flex-wrap justify-center gap-2">
                {/* Only offered when it would do something. On a search page
                    with no filters set, `clearAll` keeps the search term and
                    removes nothing — a button that visibly changes nothing
                    reads as broken. */}
                {applied.length > 0 && (
                  <Button variant="primary" onClick={clearAll}>
                    {t('catalog.clearFilters')}
                  </Button>
                )}
                <Link
                  to="/products"
                  className="inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink shadow-card hover:bg-surface-hover"
                >
                  {t('catalog.browseEverything')}
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
                  aria-label={t('catalog.pagination')}
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
                    {t('catalog.previous')}
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
                    {t('catalog.next')}
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
