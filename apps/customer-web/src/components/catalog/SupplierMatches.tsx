/**
 * Verified suppliers whose public name matches the search, above the products.
 *
 * A search for "Acme" is as often a search for the company as for something it
 * makes, and a results page that only ever answered with products would send
 * that buyer nowhere. The same `GET /catalog/suppliers` read the home page
 * uses, with the search words: only sellers the operator approved who have
 * something live to sell, matched on the name the public sees and never the
 * legal name.
 *
 * Nothing at all when there is no search, no match, or the read fails: the
 * product results are the page, and this is an extra line above them.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BuildingIcon, ShieldIcon } from '@/components/icons';
import { api } from '@/lib/api';
import { countryName } from '@/lib/iso-countries';
import type { SupplierListResponse } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** How many matches are shown. A strip, not a second results list. */
const MAX_MATCHES = 6;

export function SupplierMatches({ q }: { q: string }): React.JSX.Element | null {
  const { t, language } = useI18n();
  const term = q.trim();

  const query = useQuery({
    queryKey: ['supplier-matches', term],
    queryFn: () =>
      api.get<SupplierListResponse>('/catalog/suppliers', { query: { q: term, limit: MAX_MATCHES } }),
    enabled: term.length >= 2,
    staleTime: 60_000,
    retry: false,
  });

  if (term.length < 2 || !query.isSuccess) return null;
  const suppliers = Array.isArray(query.data.suppliers) ? query.data.suppliers : [];
  if (suppliers.length === 0) return null;

  return (
    <section aria-labelledby="supplier-matches" className="mb-4">
      <h2 id="supplier-matches" className="mb-2 text-sm font-semibold text-ink">
        {t('catalog.suppliersMatching', { query: term })}
      </h2>
      <ul className="flex flex-wrap gap-2">
        {suppliers.map((supplier) => (
          <li key={supplier.slug}>
            <Link
              to={`/products?seller=${encodeURIComponent(supplier.slug)}`}
              className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface py-1.5 pl-2 pr-3
                         text-sm text-ink shadow-card hover:border-brand/40 hover:text-brand
                         focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
            >
              <BuildingIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-brand" />
              <span className="truncate font-medium">{supplier.displayName}</span>
              <span className="shrink-0 text-xs text-ink-muted">
                {countryName(supplier.registrationCountry, language)}
              </span>
              <ShieldIcon className="h-4 w-4 shrink-0 text-success" />
              <span className="sr-only">{t('home.supplierVerified')}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
