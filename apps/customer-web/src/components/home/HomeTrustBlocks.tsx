/**
 * Two home-page blocks that each say something true about THIS deployment,
 * and vanish when there is nothing true to say:
 *
 *   - **How buying here is protected** - a short read of `GET /catalog/assurance`,
 *     the same facts the assurance page shows, each line only when the setting
 *     behind it is on.
 *   - **Buying from your country** - what the selected market means: currency,
 *     whether anything cannot be sold there or needs documents, and the
 *     operator's own delivery note. From `GET /catalog/markets/:country`.
 *
 * Every block renders nothing while loading and nothing on an error, so a
 * shopper never sees a heading that is then withdrawn.
 *
 * "Newly verified suppliers" used to be a third block here. It is on the admin
 * console's Sellers screen now, beside the full verified-supplier list.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ShieldIcon } from '@/components/icons';
import { useLocale } from '@/app/locale-context';
import { api } from '@/lib/api';
import { formatDays } from '@/lib/duration';
import { countryName } from '@/lib/iso-countries';
import { useI18n } from '@/i18n/i18n-context';

interface AssuranceFacts {
  verifiedSuppliers?: number;
  inspection?: { inUse?: boolean };
  returns?: { windowDays?: number };
  claims?: { claimWindowDays?: number };
}

export function AssuranceExplainer(): React.JSX.Element | null {
  const { t, language } = useI18n();
  // The same key and function as the assurance page, so the two share a cache entry.
  const query = useQuery({
    queryKey: ['assurance'],
    queryFn: () => api.get<AssuranceFacts>('/catalog/assurance'),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!query.isSuccess) return null;
  const facts = query.data;
  const returnDays = facts.returns?.windowDays ?? 0;
  const claimDays = facts.claims?.claimWindowDays ?? 0;

  const lines: string[] = [];
  if ((facts.verifiedSuppliers ?? 0) > 0) lines.push(t('home.assuranceReviewed'));
  // Always true of this software: an order is confirmed only by the provider.
  if (typeof facts.claims?.claimWindowDays === 'number') lines.push(t('home.assurancePayment'));
  if (facts.inspection?.inUse === true) lines.push(t('home.assuranceInspection'));
  if (returnDays > 0) lines.push(t('home.assuranceReturns', { window: formatDays(returnDays, language) }));
  if (claimDays > 0) lines.push(t('home.assuranceClaims', { window: formatDays(claimDays, language) }));
  // A response that says nothing usable leaves no block, not a heading over nothing.
  if (lines.length === 0) return null;

  return (
    <section aria-labelledby="home-assurance" className="mb-12 rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <h2 id="home-assurance" className="flex items-center gap-2 text-title-lg text-ink">
        <ShieldIcon aria-hidden="true" className="h-5 w-5 text-brand" />
        {t('home.assuranceTitle')}
      </h2>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">{t('home.assuranceBlurb')}</p>
      <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <Link
        to="/assurance"
        className="mt-3 inline-block text-sm font-medium text-brand underline-offset-2 hover:underline"
      >
        {t('assurance.link')}
      </Link>
    </section>
  );
}

interface MarketFacts {
  country?: { code?: string; currencyCode?: string };
  profile?: { headline?: string | null; deliveryPromise?: string | null } | null;
  restrictions?: { effect?: string }[];
}

export function YourMarketBlock(): React.JSX.Element | null {
  const { t, language } = useI18n();
  const { country } = useLocale();
  const code = country ?? '';
  const valid = /^[A-Za-z]{2}$/.test(code);

  const query = useQuery({
    queryKey: ['market-page', code.toUpperCase()],
    queryFn: () => api.get<MarketFacts>(`/catalog/markets/${code.toUpperCase()}`),
    enabled: valid,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!valid || !query.isSuccess) return null;
  const currency = query.data.country?.currencyCode;
  if (typeof currency !== 'string' || currency === '') return null;

  const name = countryName(code.toUpperCase(), language);
  const restrictions = Array.isArray(query.data.restrictions) ? query.data.restrictions : [];
  const anyBlocked = restrictions.some((rule) => rule.effect === 'BLOCK');
  const anyDocuments = restrictions.some((rule) => rule.effect === 'DOCUMENTS_REQUIRED');
  const promise = query.data.profile?.deliveryPromise ?? null;

  return (
    <section aria-labelledby="home-market" className="mb-12 rounded-2xl border border-line bg-surface p-5 shadow-sm">
      <h2 id="home-market" className="text-title-lg text-ink">
        {query.data.profile?.headline ?? t('market.title', { country: name })}
      </h2>
      <ul className="mt-2 space-y-1 text-sm text-ink">
        <li>{t('market.pricesIn', { country: name, currency })}</li>
        {anyBlocked && <li>{t('home.marketBlocked', { country: name })}</li>}
        {anyDocuments && <li>{t('home.marketDocuments', { country: name })}</li>}
        {promise !== null && promise.trim() !== '' && <li className="whitespace-pre-line">{promise}</li>}
      </ul>
      <Link
        to={`/markets/${code.toLowerCase()}`}
        className="mt-3 inline-block text-sm font-medium text-brand underline-offset-2 hover:underline"
      >
        {t('home.marketGuide', { country: name })}
      </Link>
    </section>
  );
}
