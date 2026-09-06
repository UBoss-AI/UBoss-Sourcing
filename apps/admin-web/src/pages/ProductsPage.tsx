/**
 * Product list.
 *
 * Filters live in the URL. A product list is the screen an administrator most
 * often sends to a colleague ("these three are still drafts"), and state held
 * in a component cannot be sent.
 *
 * The two status columns are deliberately separate. **Catalogue** is a
 * catalogue decision (draft, active, inactive); **storefront** is a visibility
 * decision, and the backend requires both before a customer can see a product.
 * Collapsing them into one "Live" column would hide the most common confusion
 * on this screen - an ACTIVE product that nobody can find because it was never
 * published.
 *
 * The two supporting columns are there for the same reason: publication needs
 * at least one image, so a product with none can be spotted before somebody
 * tries to publish it and is refused.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { DataTable, Pager } from '@/components/DataTable';
import type { Column } from '@/components/DataTable';
import {
  Badge,
  Button,
  Callout,
  Card,
  Input,
  LinkButton,
  PageHeader,
  Select,
  Toolbar,
  ToolbarActions,
  ToolbarField,
  ToolbarToggle,
} from '@/components/ui';
import type { BadgeTone } from '@/components/ui';
import { api } from '@/lib/api';
import { formatMoney, formatNumber, majorToMinor, minorToMajor } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import type {
  CategoryNode,
  ProductFilterFacets,
  ProductListItem,
  ProductListResponse,
} from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';
import { BulkCurrencyPricingDialog } from './product/BulkCurrencyPricingDialog';

function flatten(nodes: CategoryNode[], into: CategoryNode[] = []): CategoryNode[] {
  for (const node of nodes) {
    into.push(node);
    flatten(node.children, into);
  }
  return into;
}

/** How recently added, as a filter. */
const ADDED_WITHIN_OPTIONS = [7, 30, 90] as const;

const CATALOGUE_STATUS: Record<ProductListItem['status'], { label: string; tone: BadgeTone }> = {
  ACTIVE: { label: 'Active', tone: 'success' },
  DRAFT: { label: 'Draft', tone: 'neutral' },
  INACTIVE: { label: 'Inactive', tone: 'warning' },
};

export function ProductsPage(): React.JSX.Element {
  const { t } = useI18n();

  const { can } = useSession();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const page = Number(searchParams.get('page') ?? '1');
  const status = searchParams.get('status') ?? '';
  const published = searchParams.get('published') ?? '';
  const categoryId = searchParams.get('categoryId') ?? '';
  const includeArchived = searchParams.get('includeArchived') === 'true';
  const q = searchParams.get('q') ?? '';
  const minPrice = searchParams.get('minPrice') ?? '';
  const maxPrice = searchParams.get('maxPrice') ?? '';
  const stock = searchParams.get('stock') ?? '';
  const onSale = searchParams.get('onSale') === 'true';
  const recurring = searchParams.get('recurring') === 'true';
  const added = searchParams.get('added') ?? '';
  /**
   * One attribute at a time, as `Name:Value`.
   *
   * The storefront lets a shopper tick several values at once, because they
   * are browsing. This screen is a work queue - "show me the Bosch ones so I
   * can price them" - and one pair keeps the toolbar to two selects instead of
   * a column of tick boxes that would push the table off the screen.
   */
  const attr = searchParams.get('attr') ?? '';

  const hasFilters =
    status !== '' ||
    published !== '' ||
    categoryId !== '' ||
    includeArchived ||
    q !== '' ||
    minPrice !== '' ||
    maxPrice !== '' ||
    stock !== '' ||
    onSale ||
    recurring ||
    added !== '' ||
    attr !== '';

  // Local mirror of the search box so typing stays responsive, debounced into
  // the URL. Writing every keystroke to the URL floods the history stack.
  const [searchText, setSearchText] = useState(q);

  /** The bulk currency pricing dialog, raised from the page header. */
  const [pricingOpen, setPricingOpen] = useState(false);

  useEffect(() => {
    setSearchText(q);
  }, [q]);

  useEffect(() => {
    if (searchText === q) return undefined;

    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (searchText === '') next.delete('q');
          else next.set('q', searchText);
          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 300);

    return () => {
      window.clearTimeout(timer);
    };
  }, [searchText, q, setSearchParams]);

  const setParam = (key: string, value: string): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (value === '') next.delete(key);
      else next.set(key, value);
      // Any filter change invalidates the page number - page 7 of the old
      // result set is very unlikely to exist in the new one.
      next.delete('page');
      return next;
    });
  };

  const categories = useQuery({
    queryKey: ['categories'],
    queryFn: () => api.get<{ categories: CategoryNode[] }>('/admin/categories'),
  });

  /**
   * The filters this catalogue can offer, and what it costs.
   *
   * Which attributes appear is not written into this screen: an attribute
   * becomes a filter when somebody ticks "filterable" on the product, so the
   * toolbar asks rather than hard-coding names that would be wrong for the
   * next catalogue. Drafts count here, unlike on the storefront - this screen
   * exists to work on them.
   *
   * The ticked attribute is left out of the key and the request on purpose:
   * the counts are taken without it, so asking again would only reload the
   * same answer while the select is open.
   *
   * These stay in listed terms while the table gains a customer-facing column
   * beside the listed one, and deliberately: the price boxes filter the price
   * list, which is the column they sit above, and the range that labels them
   * has to be in the same terms. Quoting these in customer terms while the
   * input still filtered listed figures is how a filter starts hiding rows it
   * displays inside its own bounds - the storefront translates both ends
   * precisely to avoid it, and here there is nothing to translate.
   */
  const filters = useQuery({
    queryKey: [
      'product-filters',
      {
        status,
        published,
        categoryId,
        includeArchived,
        q,
        minPrice,
        maxPrice,
        stock,
        onSale,
        recurring,
        added,
      },
    ],
    queryFn: () =>
      api.get<ProductFilterFacets>('/admin/products/filters', {
        query: {
          status: status === '' ? undefined : status,
          published: published === '' ? undefined : published,
          categoryId: categoryId === '' ? undefined : categoryId,
          includeArchived: includeArchived ? 'true' : undefined,
          q: q === '' ? undefined : q,
          minPrice: minPrice === '' ? undefined : minPrice,
          maxPrice: maxPrice === '' ? undefined : maxPrice,
          stock: stock === '' ? undefined : stock,
          onSaleOnly: onSale ? 'true' : undefined,
          recurringOnly: recurring ? 'true' : undefined,
          addedWithinDays: added === '' ? undefined : added,
        },
      }),
  });

  const query = useQuery({
    // No market in the key: the server quotes for the country this session
    // signed in from, which cannot change without signing in again.
    queryKey: [
      'products',
      {
        page,
        status,
        published,
        categoryId,
        includeArchived,
        q,
        minPrice,
        maxPrice,
        stock,
        onSale,
        recurring,
        added,
        attr,
      },
    ],
    queryFn: () =>
      api.get<ProductListResponse>('/admin/products', {
        query: {
          page,
          limit: 25,
          status: status === '' ? undefined : status,
          published: published === '' ? undefined : published,
          categoryId: categoryId === '' ? undefined : categoryId,
          includeArchived: includeArchived ? 'true' : undefined,
          q: q === '' ? undefined : q,
          minPrice: minPrice === '' ? undefined : minPrice,
          maxPrice: maxPrice === '' ? undefined : maxPrice,
          stock: stock === '' ? undefined : stock,
          onSaleOnly: onSale ? 'true' : undefined,
          recurringOnly: recurring ? 'true' : undefined,
          addedWithinDays: added === '' ? undefined : added,
          attr: attr === '' ? undefined : attr,
        },
      }),
  });

  /*
   * The price boxes.
   *
   * Typed in major units and held in the URL as minor, the same way the
   * storefront does it: a manager types 500 meaning ₹500, and the conversion
   * is digit shifting, never × 100.
   *
   * Local state, debounced into the URL like the search box beside it, so
   * typing four digits does not fire four queries and leave four entries in
   * the history stack. Text that cannot be read as an amount is simply not
   * applied - the box says so by going red rather than the list going empty.
   */
  const [priceFromText, setPriceFromText] = useState(minPrice === '' ? '' : minorToMajor(minPrice));
  const [priceToText, setPriceToText] = useState(maxPrice === '' ? '' : minorToMajor(maxPrice));

  const priceFromInvalid = priceFromText.trim() !== '' && majorToMinor(priceFromText) === null;
  const priceToInvalid = priceToText.trim() !== '' && majorToMinor(priceToText) === null;

  /*
   * Keep the boxes in step with the URL, so Clear filters resets them too.
   *
   * A box already saying the same amount is left exactly as it was typed. The
   * naive version of this rewrites "500" as "500.00" the moment the debounce
   * fires - under the cursor, mid-number, so the next keystroke lands in
   * "500.005".
   */
  useEffect(() => {
    const sync = (urlMinor: string) => (current: string) => {
      const asMinor = current.trim() === '' ? '' : majorToMinor(current);
      if (asMinor === urlMinor) return current;
      return urlMinor === '' ? '' : minorToMajor(urlMinor);
    };

    setPriceFromText(sync(minPrice));
    setPriceToText(sync(maxPrice));
  }, [minPrice, maxPrice]);

  useEffect(() => {
    const nextMin = priceFromText.trim() === '' ? '' : (majorToMinor(priceFromText) ?? minPrice);
    const nextMax = priceToText.trim() === '' ? '' : (majorToMinor(priceToText) ?? maxPrice);

    if (nextMin === minPrice && nextMax === maxPrice) return undefined;

    const timer = window.setTimeout(() => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);

          if (nextMin === '') next.delete('minPrice');
          else next.set('minPrice', nextMin);

          if (nextMax === '') next.delete('maxPrice');
          else next.set('maxPrice', nextMax);

          next.delete('page');
          return next;
        },
        { replace: true },
      );
    }, 400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [priceFromText, priceToText, minPrice, maxPrice, setSearchParams]);

  /*
   * The attribute pair.
   *
   * The name lives in component state and only the finished `Name:Value` pair
   * reaches the URL: a half-made selection is not a filter, and putting it in
   * the address bar would mean sharing a link that filters by nothing while
   * looking as though it filters by something.
   */
  const [attrName, setAttrName] = useState(() => {
    const separator = attr.indexOf(':');
    return separator <= 0 ? '' : attr.slice(0, separator);
  });

  useEffect(() => {
    const separator = attr.indexOf(':');
    if (separator > 0) setAttrName(attr.slice(0, separator));
  }, [attr]);

  const attrValue = ((): string => {
    const separator = attr.indexOf(':');
    return separator <= 0 ? '' : attr.slice(separator + 1);
  })();

  const facets = filters.data?.attributes ?? [];
  const facetValues = facets.find((facet) => facet.name === attrName)?.values ?? [];
  const priceRange = filters.data?.priceRange;

  /**
   * Whether the customer-facing column has anything to say.
   *
   * It appears when a figure on this page differs from the one beside it,
   * which is exactly when the business has a second market to say it about.
   * Where every quote equals its listed price - no EU VAT configured, a
   * catalogue authored net of tax, or a market that happens to charge the
   * seller's own rate - a column repeating the number to its left is noise on
   * a table that is already eight columns wide.
   */
  const showsQuoted = (query.data?.products ?? []).some(
    (row) => row.quoted.minor !== row.price.minor,
  );

  const columns: Column<ProductListItem>[] = [
    {
      key: 'name',
      header: 'Product',
      render: (row) => (
        <div className="min-w-48">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Link
              to={`/products/${row.id}`}
              className="font-medium text-ink hover:text-accent hover:underline"
            >
              {row.name}
            </Link>
            {/* Archived rows only appear when the filter asks for them, and
                without this they are indistinguishable from live ones. */}
            {row.archivedAt !== null && <Badge tone="danger">{t('products.archived')}</Badge>}
          </div>
          <p className="font-mono text-xxs text-ink-subtle">{row.sku}</p>
        </div>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      secondary: true,
      render: (row) => row.category?.name ?? <span className="text-ink-subtle">—</span>,
    },
    {
      key: 'price',
      header: 'Price',
      align: 'right',
      nowrap: true,
      render: (row) => formatMoney(row.price),
    },
    // Read-only, and deliberately so - the same rule as on the per-currency
    // panel. The column to the left is the price list; this one is what the
    // engine makes of it for the market in the header. Somewhere to type would
    // mean storing a figure with one country's VAT baked in.
    ...(showsQuoted
      ? [
          {
            key: 'quoted',
            header: t('market.customerPays'),
            align: 'right' as const,
            nowrap: true,
            render: (row: ProductListItem) => (
              <>
                <span className="font-medium">{formatMoney(row.quoted)}</span>
                <span className="ml-2 text-xxs text-ink-muted">
                  {row.quotedTax.inclusive
                    ? t('market.inclusiveOfRate', { rate: row.quotedTax.ratePercent })
                    : t('market.plusRate', { rate: row.quotedTax.ratePercent })}
                </span>
              </>
            ),
          },
        ]
      : []),
    {
      key: 'status',
      header: 'Catalogue',
      render: (row) => {
        const state = CATALOGUE_STATUS[row.status];
        return (
          <Badge dot tone={state.tone}>
            {state.label}
          </Badge>
        );
      },
    },
    {
      key: 'published',
      header: 'Storefront',
      render: (row) =>
        row.isPublished ? (
          <Badge dot tone="success">
            {t('products.live')}
          </Badge>
        ) : (
          <Badge dot tone="neutral">
            {t('products.notPublished')}
          </Badge>
        ),
    },
    {
      key: 'variants',
      header: 'Variants',
      align: 'right',
      secondary: true,
      render: (row) =>
        row.variantCount > 0 ? (
          formatNumber(row.variantCount)
        ) : (
          <span className="text-ink-subtle">—</span>
        ),
    },
    {
      key: 'media',
      header: 'Images',
      align: 'right',
      secondary: true,
      tertiary: true,
      render: (row) =>
        row.mediaCount === 0 ? (
          // Publication requires at least one image, so a zero here explains
          // why a product cannot go live before anyone tries.
          <Badge tone="warning">{t('products.none')}</Badge>
        ) : (
          formatNumber(row.mediaCount)
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('products.products')}
        description={t('products.aProductReachesCustomersOnly')}
        actions={
          <>
            {can(Permission.PRODUCT_IMPORT) && (
              <LinkButton to="/products/import">Bulk import</LinkButton>
            )}
            {/* Next to bulk import because it is the same kind of job: filling
                the catalogue in one pass rather than product by product. A
                currency with no prices is a market shoppers cannot see. */}
            {can(Permission.PRODUCT_WRITE) && (
              <Button
                onClick={() => {
                  setPricingOpen(true);
                }}
              >
                {t('products.currencyPricing')}
              </Button>
            )}
            {can(Permission.PRODUCT_WRITE) && (
              <LinkButton to="/products/new" variant="primary">
                {t('products.newProduct')}
              </LinkButton>
            )}
          </>
        }
      />

      <BulkCurrencyPricingDialog
        isOpen={pricingOpen}
        onClose={() => {
          setPricingOpen(false);
        }}
      />

      <Card>
        <Toolbar>
          <ToolbarField label={t('products.search')} grow>
            <Input
              type="search"
              value={searchText}
              placeholder={t('products.nameOrSku')}
              onChange={(event) => {
                setSearchText(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('products.category')}>
            <Select
              value={categoryId}
              onChange={(event) => {
                setParam('categoryId', event.target.value);
              }}
              className="w-48"
            >
              <option value="">{t('products.allCategories')}</option>
              {flatten(categories.data?.categories ?? []).map((node) => (
                <option key={node.id} value={node.id}>
                  {'— '.repeat(node.depth)}
                  {node.name}
                </option>
              ))}
            </Select>
          </ToolbarField>

          <ToolbarField label={t('products.catalogue')}>
            <Select
              value={status}
              onChange={(event) => {
                setParam('status', event.target.value);
              }}
              className="w-36"
            >
              <option value="">{t('products.anyStatus')}</option>
              <option value="DRAFT">{t('products.draft')}</option>
              <option value="ACTIVE">{t('products.active')}</option>
              <option value="INACTIVE">{t('products.inactive')}</option>
            </Select>
          </ToolbarField>

          <ToolbarField label={t('products.storefront')}>
            <Select
              value={published}
              onChange={(event) => {
                setParam('published', event.target.value);
              }}
              className="w-40"
            >
              <option value="">{t('products.anyVisibility')}</option>
              <option value="true">{t('products.published')}</option>
              <option value="false">{t('products.notPublished')}</option>
            </Select>
          </ToolbarField>

          {/* Typed in whole currency, not minor units: nobody filters a list
              by paise. The placeholders are the cheapest and dearest products
              this filter set can reach, so the boxes are not a guess. */}
          <ToolbarField label={t('products.priceFrom')}>
            <Input
              inputMode="decimal"
              className="w-28 tabular"
              value={priceFromText}
              invalid={priceFromInvalid}
              placeholder={
                priceRange?.min == null ? t('products.any') : minorToMajor(priceRange.min.minor)
              }
              onChange={(event) => {
                setPriceFromText(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('products.priceTo')}>
            <Input
              inputMode="decimal"
              className="w-28 tabular"
              value={priceToText}
              invalid={priceToInvalid}
              placeholder={
                priceRange?.max == null ? t('products.any') : minorToMajor(priceRange.max.minor)
              }
              onChange={(event) => {
                setPriceToText(event.target.value);
              }}
            />
          </ToolbarField>

          <ToolbarField label={t('products.stock')}>
            <Select
              value={stock}
              onChange={(event) => {
                setParam('stock', event.target.value);
              }}
              className="w-36"
            >
              <option value="">{t('products.anyStock')}</option>
              <option value="in">{t('products.inStock')}</option>
              <option value="out">{t('products.outOfStock')}</option>
            </Select>
          </ToolbarField>

          <ToolbarField label={t('products.added')}>
            <Select
              value={added}
              onChange={(event) => {
                setParam('added', event.target.value);
              }}
              className="w-36"
            >
              <option value="">{t('products.anyTime')}</option>
              {ADDED_WITHIN_OPTIONS.map((days) => (
                <option key={days} value={String(days)}>
                  {t('products.lastDays', { days })}
                </option>
              ))}
            </Select>
          </ToolbarField>

          {/* Only offered when this catalogue has something to offer. An empty
              pair of selects would read as a feature that is broken rather
              than one nobody has set up yet. */}
          {facets.length > 0 && (
            <>
              <ToolbarField label={t('products.attribute')}>
                <Select
                  value={attrName}
                  onChange={(event) => {
                    setAttrName(event.target.value);
                    // Changing the attribute abandons the old pair: "Zinc" is
                    // not a value Brand has, and leaving it would filter the
                    // list down to nothing with both boxes looking sensible.
                    setParam('attr', '');
                  }}
                  className="w-40"
                >
                  <option value="">{t('products.anyAttribute')}</option>
                  {facets.map((facet) => (
                    <option key={facet.name} value={facet.name}>
                      {facet.name}
                    </option>
                  ))}
                </Select>
              </ToolbarField>

              <ToolbarField label={t('products.value')}>
                <Select
                  value={attrValue}
                  disabled={attrName === ''}
                  onChange={(event) => {
                    setParam(
                      'attr',
                      event.target.value === '' ? '' : `${attrName}:${event.target.value}`,
                    );
                  }}
                  className="w-44"
                >
                  <option value="">{t('products.anyValue')}</option>
                  {facetValues.map((entry) => (
                    <option key={entry.value} value={entry.value}>
                      {entry.value} ({formatNumber(entry.count)})
                    </option>
                  ))}
                </Select>
              </ToolbarField>
            </>
          )}

          <ToolbarToggle
            label={t('products.onOffer')}
            checked={onSale}
            onChange={(checked) => {
              setParam('onSale', checked ? 'true' : '');
            }}
          />

          <ToolbarToggle
            label={t('products.repeatOrders')}
            checked={recurring}
            onChange={(checked) => {
              setParam('recurring', checked ? 'true' : '');
            }}
          />

          <ToolbarToggle
            label={t('products.includeArchived')}
            checked={includeArchived}
            onChange={(checked) => {
              setParam('includeArchived', checked ? 'true' : '');
            }}
          />

          {hasFilters && (
            <ToolbarActions>
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('products.clearFilters')}
              </Button>
            </ToolbarActions>
          )}
        </Toolbar>

        {/* Which rate produced the column, in the engine's own words. It says
            what a shopper is told at checkout, so it is worth reading before
            deciding a price looks wrong. */}
        {showsQuoted && query.data !== undefined && (
          <Callout tone="info" className="mx-4 my-3">
            {query.data.taxNote}
          </Callout>
        )}

        <DataTable
          caption="Products"
          columns={columns}
          rows={query.data?.products}
          rowKey={(row) => row.id}
          isLoading={query.isPending}
          isRefreshing={query.isFetching && !query.isPending}
          error={query.isError ? query.error : undefined}
          loadingLabel="Loading products"
          // A ninth column needs the room. Below this the table scrolls inside
          // its own container rather than squeezing the SKU onto three lines.
          minWidth={showsQuoted ? '68rem' : '60rem'}
          onRetry={() => {
            void query.refetch();
          }}
          onRowClick={(row) => {
            void navigate(`/products/${row.id}`);
          }}
          emptyTitle={hasFilters ? 'Nothing matches these filters' : 'No products yet'}
          emptyDescription={
            hasFilters
              ? 'Try a different search, or clear the filters.'
              : 'Add products one at a time, or import a spreadsheet.'
          }
          emptyAction={
            hasFilters ? (
              <Button
                onClick={() => {
                  setSearchParams({});
                }}
              >
                {t('products.clearFilters')}
              </Button>
            ) : can(Permission.PRODUCT_WRITE) ? (
              <LinkButton to="/products/new" variant="primary">
                {t('products.newProduct')}
              </LinkButton>
            ) : undefined
          }
        />

        {query.data !== undefined && (
          <Pager
            page={query.data.pagination.page}
            limit={query.data.pagination.limit}
            total={query.data.pagination.total}
            totalPages={query.data.pagination.totalPages}
            onPageChange={(next) => {
              setSearchParams((current) => {
                const params = new URLSearchParams(current);
                params.set('page', String(next));
                return params;
              });
            }}
          />
        )}
      </Card>
    </>
  );
}
