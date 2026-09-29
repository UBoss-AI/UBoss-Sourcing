/**
 * "Verified suppliers" on the home page, and the one sentence of value
 * proposition under the headline that depends on it.
 *
 * Both read `GET /catalog/suppliers`, which lists only sellers the marketplace
 * operator reviewed and approved and who have something live to sell. So the
 * word "verified" on this page is exactly as true as that review, and a
 * deployment with no approved sellers says nothing about suppliers at all —
 * the section disappears and the sentence falls back to a neutral one.
 *
 * "FROM INDIA" IS READ, NEVER WRITTEN
 *
 * The heading names a country only when every verified supplier is registered
 * in that one country, which the API reports across all of them rather than
 * just the page shown. A marketplace of Indian manufacturers says "from
 * India"; the same software run by somebody else, with sellers in three
 * countries, says "Verified suppliers" and makes no claim it cannot keep.
 */
import { Link } from 'react-router-dom';
import { BuildingIcon, ShieldIcon } from '@/components/icons';
import { countryName } from '@/lib/iso-countries';
import { formatNumber } from '@/lib/format';
import type { VerifiedSupplier } from '@/lib/types';
import { soleSupplierCountry, useVerifiedSuppliers } from '@/lib/verified-suppliers';
import { useI18n } from '@/i18n/i18n-context';

/**
 * The sentence under the headline.
 *
 * All three wordings sit in the same grid cell and the two not in use are
 * invisible, so the line is as tall as the tallest of them from the first
 * frame — the answer arriving never pushes the search bar down. The hidden
 * copies are `aria-hidden`, so a screen reader hears only the one shown.
 */
export function ValueProposition(): React.JSX.Element {
  const { t, language } = useI18n();
  const query = useVerifiedSuppliers();

  const country = soleSupplierCountry(query.data);
  const hasSuppliers =
    Array.isArray(query.data?.suppliers) && query.data.suppliers.length > 0;
  const countryLabel = country === null ? '' : countryName(country, language);

  const wordings = [
    { id: 'neutral', text: t('home.everythingYourBusinessOrdersIn') },
    { id: 'suppliers', text: t('home.valuePropositionSuppliers') },
    {
      id: 'country',
      text: t('home.valuePropositionSuppliersFrom', { country: countryLabel || '—' }),
    },
  ];
  const shown = !hasSuppliers ? 'neutral' : country === null ? 'suppliers' : 'country';

  return (
    <p className="mt-3 grid max-w-xl text-sm leading-relaxed text-ink sm:text-base">
      {wordings.map((wording) => (
        <span
          key={wording.id}
          aria-hidden={wording.id === shown ? undefined : 'true'}
          data-testid={wording.id === shown ? 'value-proposition' : undefined}
          className={
            wording.id === shown
              ? 'col-start-1 row-start-1'
              : 'invisible col-start-1 row-start-1'
          }
        >
          {wording.text}
        </span>
      ))}
    </p>
  );
}

function kindLabel(
  kind: VerifiedSupplier['kind'],
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (kind) {
    case 'MANUFACTURER':
      return t('home.supplierKind.MANUFACTURER');
    case 'AUTHORISED_DISTRIBUTOR':
      return t('home.supplierKind.AUTHORISED_DISTRIBUTOR');
    case 'WHOLESALER':
      return t('home.supplierKind.WHOLESALER');
    case 'RESELLER':
      return t('home.supplierKind.RESELLER');
  }
}

function SupplierCard({ supplier }: { supplier: VerifiedSupplier }): React.JSX.Element {
  const { t, language } = useI18n();

  const verifiedOn =
    supplier.verifiedAt === null
      ? null
      : new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(
          new Date(supplier.verifiedAt),
        );

  return (
    <Link
      to={`/products?seller=${encodeURIComponent(supplier.slug)}`}
      className="group flex h-full flex-col gap-3 rounded-2xl border border-line bg-surface p-4
                 shadow-sm transition-colors hover:border-brand/40
                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
    >
      <div className="flex items-center gap-3">
        {supplier.logoUrl === null ? (
          <span
            aria-hidden="true"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand"
          >
            <BuildingIcon className="h-5 w-5" />
          </span>
        ) : (
          <img
            src={supplier.logoUrl}
            alt=""
            loading="lazy"
            className="h-11 w-11 shrink-0 rounded-xl border border-line object-contain"
          />
        )}
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink group-hover:text-brand">
            {supplier.displayName}
          </p>
          <p className="truncate text-xs text-ink-muted">
            {kindLabel(supplier.kind, t)} · {countryName(supplier.registrationCountry, language)}
          </p>
        </div>
      </div>

      <p className="flex items-center gap-1.5 text-xs font-medium text-success">
        <ShieldIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
        {verifiedOn === null
          ? t('home.supplierVerified')
          : t('home.supplierVerifiedSince', { date: verifiedOn })}
      </p>

      <p className="mt-auto text-sm text-ink-muted">
        {t('home.supplierProducts', {
          count: supplier.productCount,
          products: formatNumber(supplier.productCount),
        })}
      </p>
    </Link>
  );
}

const GRID = 'grid grid-cols-1 gap-4 min-[420px]:grid-cols-2 lg:grid-cols-4';

export function VerifiedSuppliers(): React.JSX.Element | null {
  const { t, language } = useI18n();
  const query = useVerifiedSuppliers();

  /*
   * Nothing until the answer is in - not even a skeleton under a heading.
   * A "Verified suppliers" heading shown while loading, on a deployment that
   * turns out to have none, is a claim made and then withdrawn. The section
   * sits below the categories, out of the first screen, so its arrival moves
   * nothing anybody is reading.
   */
  if (!query.isSuccess) return null;
  const suppliers = Array.isArray(query.data.suppliers) ? query.data.suppliers : [];
  if (suppliers.length === 0) return null;

  const country = soleSupplierCountry(query.data);

  return (
    <section aria-labelledby="verified-suppliers" className="mb-12">
      <header className="mb-4">
        <h2 id="verified-suppliers" className="text-title-lg text-ink">
          {country === null
            ? t('home.verifiedSuppliers')
            : t('home.verifiedSuppliersFrom', { country: countryName(country, language) })}
        </h2>
        <p className="mt-1 max-w-prose text-sm text-ink-muted">
          {t('home.verifiedSuppliersBlurb')}
        </p>
      </header>

      <ul className={GRID}>
        {suppliers.map((supplier) => (
          <li key={supplier.slug}>
            <SupplierCard supplier={supplier} />
          </li>
        ))}
      </ul>
    </section>
  );
}
