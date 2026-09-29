/**
 * `/compare` - products or suppliers side by side (checklist Master row 6).
 *
 * The page keeps only which items were picked (`lib/compare.ts`); every value
 * in the table is read now, from the same product and supplier reads their
 * own pages use, so the comparison shows today's price, today's delivery
 * answer for the chosen country and today's verified certificates. An item
 * that has since been unpublished says so in its column and can be removed;
 * it is never shown with remembered figures.
 *
 * A real table with row and column headers, so a screen reader can move
 * across it cell by cell and hear which product and which property each value
 * belongs to. On a phone the table scrolls sideways inside its own frame and
 * the first column stays in place.
 */
import { useQueries } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useLocale } from '@/app/locale-context';
import { useStorefront } from '@/app/storefront-context';
import { ApiError, api } from '@/lib/api';
import { clearCompare, removeFromCompare, useCompareList, type CompareEntry, type CompareKind } from '@/lib/compare';
import { countryName } from '@/lib/iso-countries';
import { formatMoney, formatMoneyMinor, formatNumber } from '@/lib/format';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import type { ProductDetailResponse, SupplierProfile } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';
import { TrashIcon } from '@/components/icons';

type Cell = React.ReactNode;

function CompareTable({
  caption,
  columns,
  rows,
  onRemove,
}: {
  caption: string;
  columns: { key: string; header: React.ReactNode; name: string }[];
  rows: { label: string; cells: Cell[] }[];
  onRemove: (key: string) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  return (
    <div className="relative overflow-x-auto rounded-lg border border-border bg-surface shadow-card">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border">
            <td className="sticky left-0 z-10 w-40 bg-surface p-3" />
            {columns.map((column) => (
              <th key={column.key} scope="col" className="min-w-[11rem] p-3 align-top font-semibold text-ink">
                {column.header}
                <button
                  type="button"
                  onClick={() => {
                    onRemove(column.key);
                  }}
                  className="mt-2 inline-flex items-center gap-1 text-xs font-normal text-ink-muted hover:text-danger
                             focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                >
                  <TrashIcon className="h-3.5 w-3.5" />
                  {t('compare.remove', { name: column.name })}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.label} className="border-b border-border-subtle last:border-b-0">
              <th scope="row" className="sticky left-0 z-10 bg-surface p-3 align-top text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {row.label}
              </th>
              {row.cells.map((cell, index) => (
                <td key={columns[index]?.key ?? index} className="p-3 align-top text-ink">
                  {cell ?? <span className="text-ink-subtle">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useProducts(list: CompareEntry[]) {
  const { currency, country } = useLocale();
  const { language } = useI18n();
  return useQueries({
    queries: list.map((entry) => ({
      queryKey: ['compare-product', entry.slug, currency, country, language],
      queryFn: () =>
        api.get<ProductDetailResponse>(`/catalog/products/${encodeURIComponent(entry.slug)}`, {
          query: { currency, country: country ?? undefined, language },
        }),
      retry: false,
      staleTime: 60_000,
    })),
  });
}

function useSuppliers(list: CompareEntry[]) {
  return useQueries({
    queries: list.map((entry) => ({
      queryKey: ['supplier-profile', entry.slug],
      queryFn: () => api.get<{ supplier: SupplierProfile }>(`/catalog/suppliers/${encodeURIComponent(entry.slug)}`),
      retry: false,
      staleTime: 60_000,
    })),
  });
}

function Unavailable({ error }: { error: unknown }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <span className="text-xs text-ink-muted">
      {error instanceof ApiError && error.status === 404 ? t('compare.noLongerAvailable') : t('compare.couldNotLoad')}
    </span>
  );
}

function ProductComparison({ list }: { list: CompareEntry[] }): React.JSX.Element {
  const { t, language } = useI18n();
  const results = useProducts(list);

  const loaded = results.map((result) => result.data);
  const cell = (index: number, render: (data: ProductDetailResponse) => Cell): Cell => {
    const result = results[index];
    if (result === undefined) return null;
    if (result.isPending) return <span className="text-ink-subtle">…</span>;
    // Said once, in the column header; the cells below stay empty.
    if (result.isError) return null;
    return render(result.data);
  };

  // The specification rows every loaded product can be read against: the union
  // of labels, in the order the first product lists them.
  const specLabels: string[] = [];
  for (const data of loaded) {
    for (const group of data?.product.specifications ?? []) {
      for (const row of group.rows) if (!specLabels.includes(row.label)) specLabels.push(row.label);
    }
  }
  const specOf = (data: ProductDetailResponse, label: string): Cell => {
    for (const group of data.product.specifications ?? []) {
      const row = group.rows.find((entry) => entry.label === label);
      if (row !== undefined) return row.unit === null ? row.value : `${row.value} ${row.unit}`;
    }
    return null;
  };

  const deliveryText = (data: ProductDetailResponse): Cell => {
    const sourcing = data.sourcing;
    if (sourcing === undefined) return null;
    const destination = sourcing.destination === null ? '' : countryName(sourcing.destination, language);
    switch (sourcing.delivery.status) {
      case 'AVAILABLE':
        return t('product.sourcing.deliverable', { country: destination });
      case 'DOCUMENTS_REQUIRED':
        return t('product.sourcing.documentsRequired', { country: destination });
      case 'BLOCKED':
        return t('product.sourcing.blocked', { country: destination });
      case 'SELLER_DOES_NOT_DELIVER':
        return t('product.sourcing.sellerDoesNotDeliver', { country: destination });
      case 'CHOOSE_DESTINATION':
        return t('compare.chooseCountry');
    }
  };

  const inspectionText = (data: ProductDetailResponse): Cell => {
    const inspection = data.sourcing?.inspection;
    if (inspection === undefined) return null;
    switch (inspection.outlook) {
      case 'REQUIRED':
        return t('compare.inspectionRequired');
      case 'REQUIRED_FROM_VALUE':
        return t('compare.inspectionFromValue', {
          amount: formatMoneyMinor(inspection.fromValueMinor, inspection.currency ?? ''),
        });
      case 'DEPENDS_ON_DESTINATION':
        return t('compare.inspectionDepends');
      case 'NOT_REQUIRED':
        return t('compare.inspectionNotRequired');
      case 'NOT_APPLICABLE':
        return null;
    }
  };

  const columns = list.map((entry, index) => ({
    key: entry.slug,
    name: entry.name,
    header: (() => {
      const data = loaded[index];
      const image = data?.product.primaryImage ?? null;
      return (
        <Link to={`/product/${encodeURIComponent(entry.slug)}`} className="block text-brand hover:underline">
          {image !== null && (
            <img src={image.url} alt="" loading="lazy" className="mb-2 h-20 w-20 rounded-md border border-border object-contain" />
          )}
          {data?.product.name ?? entry.name}
          {results[index]?.isError === true && (
            <span className="mt-1 block">
              <Unavailable error={results[index].error} />
            </span>
          )}
        </Link>
      );
    })(),
  }));

  const rows: { label: string; cells: Cell[] }[] = [
    {
      label: t('compare.price'),
      cells: list.map((_, index) =>
        cell(index, (data) =>
          data.product.purchasability?.isPriceOnRequest === true ? t('compare.priceOnRequest') : formatMoney(data.product.price),
        ),
      ),
    },
    {
      label: t('compare.minimumOrder'),
      cells: list.map((_, index) => cell(index, (data) => formatNumber(data.product.purchaseRules.minOrderQty))),
    },
    {
      label: t('compare.orderIn'),
      cells: list.map((_, index) =>
        cell(index, (data) => t('compare.multiplesOf', { quantity: formatNumber(data.product.purchaseRules.qtyIncrement) })),
      ),
    },
    {
      label: t('product.sourcing.soldBy'),
      cells: list.map((_, index) =>
        cell(index, (data) =>
          data.sourcing?.seller == null ? (
            t('product.sourcing.soldByMarketplace')
          ) : (
            <Link to={`/suppliers/${encodeURIComponent(data.sourcing.seller.slug)}`} className="text-brand hover:underline">
              {data.sourcing.seller.displayName}
            </Link>
          ),
        ),
      ),
    },
    { label: t('product.sourcing.delivery'), cells: list.map((_, index) => cell(index, deliveryText)) },
    {
      label: t('compare.leadTime'),
      cells: list.map((_, index) =>
        cell(index, (data) =>
          data.sourcing?.handlingTimeDays == null
            ? null
            : t('compare.days', { count: data.sourcing.handlingTimeDays, days: formatNumber(data.sourcing.handlingTimeDays) }),
        ),
      ),
    },
    {
      label: t('compare.origin'),
      cells: list.map((_, index) =>
        cell(index, (data) =>
          data.sourcing?.countryOfOrigin == null ? null : countryName(data.sourcing.countryOfOrigin, language),
        ),
      ),
    },
    { label: t('product.sourcing.inspection'), cells: list.map((_, index) => cell(index, inspectionText)) },
    ...specLabels.map((label) => ({ label, cells: list.map((_, index) => cell(index, (data) => specOf(data, label))) })),
  ];

  return (
    <CompareTable
      caption={t('compare.productsCaption')}
      columns={columns}
      rows={rows}
      onRemove={(slug) => {
        removeFromCompare('products', slug);
      }}
    />
  );
}

function SupplierComparison({ list }: { list: CompareEntry[] }): React.JSX.Element {
  const { t, language } = useI18n();
  const results = useSuppliers(list);
  const month = new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' });

  const cell = (index: number, render: (supplier: SupplierProfile) => Cell): Cell => {
    const result = results[index];
    if (result === undefined) return null;
    if (result.isPending) return <span className="text-ink-subtle">…</span>;
    // Said once, in the column header; the cells below stay empty.
    if (result.isError) return null;
    return render(result.data.supplier);
  };

  const columns = list.map((entry, index) => ({
    key: entry.slug,
    name: entry.name,
    header: (
      <>
        <Link to={`/suppliers/${encodeURIComponent(entry.slug)}`} className="text-brand hover:underline">
          {results[index]?.data?.supplier.displayName ?? entry.name}
        </Link>
        {results[index]?.isError === true && (
          <span className="mt-1 block">
            <Unavailable error={results[index].error} />
          </span>
        )}
      </>
    ),
  }));

  const rows: { label: string; cells: Cell[] }[] = [
    { label: t('compare.kind'), cells: list.map((_, i) => cell(i, (s) => t(`home.supplierKind.${s.kind}`))) },
    { label: t('compare.country'), cells: list.map((_, i) => cell(i, (s) => countryName(s.registrationCountry, language))) },
    {
      label: t('compare.verifiedSince'),
      cells: list.map((_, i) => cell(i, (s) => (s.verifiedAt === null ? t('home.supplierVerified') : month.format(new Date(s.verifiedAt))))),
    },
    {
      label: t('compare.yearsInBusiness'),
      cells: list.map((_, i) => cell(i, (s) => (s.yearsInBusiness === null ? null : formatNumber(s.yearsInBusiness)))),
    },
    { label: t('compare.productsHere'), cells: list.map((_, i) => cell(i, (s) => formatNumber(s.productCount))) },
    {
      label: t('compare.mainCategories'),
      cells: list.map((_, i) =>
        cell(i, (s) => (s.categories.length === 0 ? null : s.categories.slice(0, 3).map((c) => c.name).join(', '))),
      ),
    },
    {
      label: t('supplier.certifications'),
      cells: list.map((_, i) =>
        cell(i, (s) => (s.certifications.length === 0 ? t('compare.noneVerified') : s.certifications.map((c) => c.standard).join(', '))),
      ),
    },
    {
      label: t('supplier.factories'),
      cells: list.map((_, i) =>
        cell(i, (s) =>
          s.factories.length === 0
            ? null
            : s.factories.map((f) => `${f.city}, ${countryName(f.countryCode, language)}`).join('; '),
        ),
      ),
    },
    {
      label: t('compare.monthlyCapacity'),
      cells: list.map((_, i) =>
        cell(i, (s) => {
          const stated = s.factories.filter((f) => f.monthlyCapacity !== null);
          if (stated.length === 0) return null;
          return stated
            .map((f) => `${formatNumber(f.monthlyCapacity)}${f.capacityUnit === null ? '' : ` ${f.capacityUnit}`}`)
            .join('; ');
        }),
      ),
    },
    {
      label: t('compare.exportsTo'),
      cells: list.map((_, i) =>
        cell(i, (s) =>
          s.exportMarkets.length > 0
            ? s.exportMarkets.map((code) => countryName(code, language)).join(', ')
            : s.exportCapable
              ? t('supplier.exports')
              : null,
        ),
      ),
    },
    {
      label: t('compare.responseTime'),
      cells: list.map((_, i) =>
        cell(i, (s) =>
          s.responseSlaHours === null ? null : t('compare.hours', { count: s.responseSlaHours, hours: formatNumber(s.responseSlaHours) }),
        ),
      ),
    },
  ];

  return (
    <CompareTable
      caption={t('compare.suppliersCaption')}
      columns={columns}
      rows={rows}
      onRemove={(slug) => {
        removeFromCompare('suppliers', slug);
      }}
    />
  );
}

export function ComparePage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const [searchParams] = useSearchParams();
  const tab: CompareKind = searchParams.get('tab') === 'suppliers' ? 'suppliers' : 'products';
  const products = useCompareList('products');
  const suppliers = useCompareList('suppliers');
  const list = tab === 'products' ? products : suppliers;

  useDocumentMeta({ title: t('compare.title'), description: '' }, business.displayName);

  return (
    <div className="mx-auto max-w-content px-4 py-6 sm:py-8">
      <h1 className="text-title-xl text-ink">{t('compare.title')}</h1>
      <p className="mt-1 text-sm text-ink-muted">{t('compare.intro')}</p>

      <nav aria-label={t('compare.title')} className="mt-5 flex gap-2 border-b border-border">
        {(['products', 'suppliers'] as const).map((kind) => (
          <Link
            key={kind}
            to={`/compare?tab=${kind}`}
            aria-current={tab === kind ? 'page' : undefined}
            className="-mb-px border-b-2 border-transparent px-3 py-2 text-sm font-medium text-ink-muted aria-[current=page]:border-brand aria-[current=page]:text-brand
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            {kind === 'products'
              ? t('compare.tabProducts', { count: products.length, items: products.length })
              : t('compare.tabSuppliers', { count: suppliers.length, items: suppliers.length })}
          </Link>
        ))}
      </nav>

      <div className="mt-5">
        {list.length === 0 ? (
          <div className="rounded-lg border border-border bg-surface px-6 py-12 text-center shadow-card">
            <p className="text-title-sm text-ink">{t('compare.emptyTitle')}</p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-ink-muted">
              {tab === 'products' ? t('compare.emptyProducts') : t('compare.emptySuppliers')}
            </p>
            <Link
              to="/products"
              className="mt-5 inline-flex h-10 items-center rounded-md border border-border-strong bg-surface px-4 text-sm font-medium text-ink shadow-card hover:bg-surface-hover"
            >
              {t('catalog.browseEverything')}
            </Link>
          </div>
        ) : (
          <>
            {list.length === 1 && <p className="mb-3 text-sm text-ink-muted">{t('compare.addAnother')}</p>}
            {tab === 'products' ? <ProductComparison list={list} /> : <SupplierComparison list={list} />}
            <button
              type="button"
              onClick={() => {
                clearCompare(tab);
              }}
              className="mt-3 text-sm font-medium text-ink-muted underline-offset-2 hover:text-danger hover:underline"
            >
              {t('compare.clearAll')}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
