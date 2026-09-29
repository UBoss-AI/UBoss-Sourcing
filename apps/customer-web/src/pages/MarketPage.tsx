/**
 * `/markets/:country` - shopping from one destination (checklist Master row 8).
 *
 * Two kinds of content, and the page keeps them visibly apart:
 *
 *   - **What the system knows** about this destination: the currency prices
 *     are quoted in, and what may not be sold there (or needs documents),
 *     with the operator's reason. Always shown.
 *   - **What the operator wrote** for this market - introduction, duties,
 *     delivery and compliance notes, featured categories - shown only once
 *     they publish it, and labelled as theirs.
 *
 * "Shop in this market" switches the shopper's country and currency through
 * the same locale choice the header menu makes, so the rest of the site
 * follows.
 */
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AlertIcon, CurrencyIcon, GlobeIcon, InfoIcon } from '@/components/icons';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { useLocale } from '@/app/locale-context';
import { useStorefront } from '@/app/storefront-context';
import { ApiError, api } from '@/lib/api';
import { countryName } from '@/lib/iso-countries';
import { formatDayRange } from '@/lib/duration';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import { NotFoundPage } from './NotFoundPage';

/** A shipping mode's label, from the fixed set the API can send. */
const MODE_LABEL = {
  ROAD: 'market.mode.ROAD',
  AIR: 'market.mode.AIR',
  SEA: 'market.mode.SEA',
  RAIL: 'market.mode.RAIL',
  COURIER: 'market.mode.COURIER',
  MULTIMODAL: 'market.mode.MULTIMODAL',
} as const;

interface MarketPageData {
  country: { code: string; name: string; currencyCode: string; languageCode?: string | null };
  /** Absent from an older API, and empty when no shipping route is in force. */
  lanes?: { originCountry: string; mode: string; transitDaysMin: number; transitDaysMax: number }[];
  profile: {
    headline: string | null;
    intro: string | null;
    dutiesGuidance: string | null;
    deliveryPromise: string | null;
    complianceNotes: string | null;
    featuredCategories: { slug: string; name: string }[];
  } | null;
  restrictions: {
    effect: 'BLOCK' | 'DOCUMENTS_REQUIRED';
    category: { slug: string; name: string } | null;
    product: { slug: string; name: string } | null;
    reason: string;
    requiredDocuments: string[];
  }[];
}

function Note({ title, text }: { title: string; text: string | null }): React.JSX.Element | null {
  if (text === null) return null;
  return (
    <div>
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 whitespace-pre-line text-sm leading-relaxed text-ink">{text}</p>
    </div>
  );
}

export function MarketPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { business } = useStorefront();
  const locale = useLocale();
  const { country: raw = '' } = useParams<{ country: string }>();
  const code = raw.toUpperCase();
  const valid = /^[A-Z]{2}$/.test(code);
  const [switching, setSwitching] = useState(false);

  const query = useQuery({
    queryKey: ['market-page', code],
    queryFn: () => api.get<MarketPageData>(`/catalog/markets/${code}`),
    enabled: valid,
    retry: false,
  });

  const name = valid ? countryName(code, language) : '';
  useDocumentMeta({ title: t('market.title', { country: name }), description: t('market.intro', { country: name }) }, business.displayName);

  if (!valid) return <NotFoundPage />;
  if (query.isPending) return <LoadingState label={t('market.loading')} />;
  if (query.isError) {
    if (query.error instanceof ApiError && query.error.status === 404) return <NotFoundPage />;
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  const data = query.data;
  const isCurrent = locale.country === code;
  const blocks = data.restrictions.filter((rule) => rule.effect === 'BLOCK');
  const documents = data.restrictions.filter((rule) => rule.effect === 'DOCUMENTS_REQUIRED');
  const profile = data.profile;
  const lanes = Array.isArray(data.lanes) ? data.lanes : [];
  const languageCode = data.country.languageCode ?? null;
  const languageLabel =
    languageCode === null || languageCode === ''
      ? null
      : (() => {
          try {
            return new Intl.DisplayNames([language], { type: 'language' }).of(languageCode) ?? null;
          } catch {
            return null;
          }
        })();

  const switchHere = async (): Promise<void> => {
    setSwitching(true);
    try {
      await locale.choose(code, data.country.currencyCode);
    } finally {
      setSwitching(false);
    }
  };

  const target = (rule: MarketPageData['restrictions'][number]): React.ReactNode =>
    rule.category !== null ? (
      <Link to={`/category/${encodeURIComponent(rule.category.slug)}`} className="font-medium text-brand hover:underline">
        {rule.category.name}
      </Link>
    ) : rule.product !== null ? (
      <Link to={`/product/${encodeURIComponent(rule.product.slug)}`} className="font-medium text-brand hover:underline">
        {rule.product.name}
      </Link>
    ) : null;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 sm:py-8">
      <h1 className="text-title-xl text-ink">{profile?.headline ?? t('market.title', { country: name })}</h1>
      <p className="mt-2 text-sm text-ink-muted">{t('market.intro', { country: name })}</p>

      <section aria-labelledby="market-basics" className="mt-6 rounded-lg border border-border bg-surface p-5 shadow-card">
        <h2 id="market-basics" className="flex items-center gap-2 text-title-sm text-ink">
          <CurrencyIcon className="h-5 w-5 text-brand" />
          {t('market.pricesTitle')}
        </h2>
        <p className="mt-2 text-sm text-ink">{t('market.pricesIn', { country: name, currency: data.country.currencyCode })}</p>
        {languageLabel !== null && (
          <p className="mt-1 text-sm text-ink">{t('market.languageLine', { country: name, language: languageLabel })}</p>
        )}
        <div className="mt-3">
          {isCurrent ? (
            <p className="text-sm font-medium text-success">{t('market.youAreShoppingHere', { country: name })}</p>
          ) : (
            <Button
              variant="primary"
              disabled={switching}
              onClick={() => {
                void switchHere();
              }}
            >
              {t('market.shopHere', { country: name })}
            </Button>
          )}
        </div>
      </section>

      {lanes.length > 0 && (
        <section aria-labelledby="market-shipping" className="mt-4 rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 id="market-shipping" className="flex items-center gap-2 text-title-sm text-ink">
            <GlobeIcon className="h-5 w-5 text-brand" />
            {t('market.shippingTitle', { country: name })}
          </h2>
          <ul className="mt-2 space-y-1 text-sm text-ink">
            {lanes.map((lane) => (
              <li key={`${lane.originCountry}:${lane.mode}`}>
                {t('market.shippingLane', {
                  origin: countryName(lane.originCountry, language),
                  mode: lane.mode in MODE_LABEL ? t(MODE_LABEL[lane.mode as keyof typeof MODE_LABEL]) : lane.mode,
                  transit: formatDayRange(lane.transitDaysMin, lane.transitDaysMax, language),
                })}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-muted">{t('market.shippingNote')}</p>
        </section>
      )}

      <section aria-labelledby="market-restrictions" className="mt-4 rounded-lg border border-border bg-surface p-5 shadow-card">
        <h2 id="market-restrictions" className="flex items-center gap-2 text-title-sm text-ink">
          <GlobeIcon className="h-5 w-5 text-brand" />
          {t('market.restrictionsTitle', { country: name })}
        </h2>
        {blocks.length === 0 && documents.length === 0 ? (
          <p className="mt-2 text-sm text-ink">{t('market.noRestrictions', { country: name })}</p>
        ) : (
          <ul className="mt-2 space-y-2 text-sm">
            {blocks.map((rule, index) => (
              <li key={`b-${String(index)}`} className="flex gap-2">
                <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
                <span>
                  {target(rule)} — {t('market.notSoldThere')} <span className="text-ink-muted">{rule.reason}</span>
                </span>
              </li>
            ))}
            {documents.map((rule, index) => (
              <li key={`d-${String(index)}`} className="flex gap-2">
                <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                <span>
                  {target(rule)} — {t('market.documentsNeeded')} <span className="text-ink-muted">{rule.reason}</span>
                  {rule.requiredDocuments.length > 0 && (
                    <span className="block text-ink-muted">
                      {t('product.sourcing.documentsList', { documents: rule.requiredDocuments.join(', ') })}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {profile !== null && (
        <section aria-labelledby="market-notes" className="mt-4 space-y-4 rounded-lg border border-border bg-surface p-5 shadow-card">
          <h2 id="market-notes" className="text-title-sm text-ink">
            {t('market.notesTitle', { marketplace: business.displayName })}
          </h2>
          <Note title={t('market.about')} text={profile.intro} />
          <Note title={t('market.duties')} text={profile.dutiesGuidance} />
          <Note title={t('market.delivery')} text={profile.deliveryPromise} />
          <Note title={t('market.compliance')} text={profile.complianceNotes} />
          {profile.featuredCategories.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-ink">{t('market.popular')}</h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {profile.featuredCategories.map((category) => (
                  <li key={category.slug}>
                    <Link
                      to={`/category/${encodeURIComponent(category.slug)}`}
                      className="inline-flex rounded-full border border-border px-3 py-1.5 text-sm text-ink hover:border-brand/40 hover:text-brand
                                 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                    >
                      {category.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-ink-muted">{t('market.writtenByOperator', { marketplace: business.displayName })}</p>
        </section>
      )}

      <p className="mt-4 text-sm">
        <Link to="/assurance" className="font-medium text-brand underline-offset-2 hover:underline">
          {t('assurance.link')}
        </Link>
      </p>
    </div>
  );
}
