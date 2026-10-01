/**
 * `/suppliers/:slug` - one verified supplier's public page (checklist Master
 * row 5).
 *
 * A buyer deciding whether to source from somebody wants to know who they
 * are, what they make and where, what they are certified for, and what they
 * sell here. Every section is read from `GET /catalog/suppliers/:slug`, and a
 * section with nothing in it is not drawn - a heading over an empty list reads
 * as a supplier who is hiding something.
 *
 * The page claims exactly what the marketplace checked: that the operator
 * approved this supplier, and which certificates the operator verified. The
 * rest is stated as the supplier's own description ("as stated by the
 * supplier"), because the marketplace has not verified it.
 */
import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { recordViewed } from '@/lib/recently-viewed';
import { Link, useParams } from 'react-router-dom';
import { BuildingIcon, CheckIcon, GlobeIcon, ShieldIcon } from '@/components/icons';
import { ButtonLink, ErrorState, LoadingState } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { countryName } from '@/lib/iso-countries';
import { formatNumber } from '@/lib/format';
import { useDocumentMeta, useJsonLd } from '@/lib/useDocumentMeta';
import { canonicalUrl, supplierJsonLd } from '@/lib/seo';
import type { SupplierProfile } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';
import { NotFoundPage } from './NotFoundPage';
import { CompareButton } from '@/components/compare/CompareButton';

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-surface p-5 shadow-card">
      <h2 id={id} className="text-title-sm text-ink">
        {title}
      </h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

export function SupplierPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { slug = '' } = useParams<{ slug: string }>();
  const valid = /^[a-z0-9-]{1,180}$/.test(slug);

  const query = useQuery({
    queryKey: ['supplier-profile', slug],
    queryFn: () => api.get<{ supplier: SupplierProfile }>(`/catalog/suppliers/${encodeURIComponent(slug)}`),
    enabled: valid,
    retry: false,
  });

  const supplier = query.data?.supplier;
  useEffect(() => {
    if (supplier !== undefined) recordViewed({ kind: 'supplier', slug, name: supplier.displayName });
  }, [supplier, slug]);
  useDocumentMeta(
    { title: supplier?.displayName ?? '', description: supplier?.description ?? '' },
    supplier?.displayName ?? '',
  );
  useJsonLd(
    'supplier',
    supplier === undefined
      ? null
      : supplierJsonLd({
          name: supplier.displayName,
          description: supplier.description,
          url: canonicalUrl(`/suppliers/${supplier.slug}`),
          websiteUrl: supplier.websiteUrl,
          countryCode: supplier.registrationCountry,
          logoUrl: supplier.logoUrl,
        }),
  );

  if (!valid) return <NotFoundPage />;
  if (query.isPending) return <LoadingState label={t('supplier.loading')} />;
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

  const profile = query.data.supplier;
  const verifiedOn =
    profile.verifiedAt === null
      ? null
      : new Intl.DateTimeFormat(language, { month: 'long', year: 'numeric' }).format(new Date(profile.verifiedAt));
  const dateFormat = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' });
  const productsHref = `/products?seller=${encodeURIComponent(profile.slug)}`;
  const stated =
    profile.capabilities.length > 0 ||
    profile.exportCapable ||
    profile.exportMarkets.length > 0 ||
    profile.responseSlaHours !== null ||
    profile.yearsExporting !== null;

  return (
    <div className="mx-auto max-w-content px-4 py-6 sm:py-8">
      <nav aria-label={t('supplier.breadcrumb')} className="mb-4 text-sm text-ink-muted">
        <Link to="/" className="hover:text-brand">
          {t('heroSearch.home')}
        </Link>
        <span aria-hidden="true"> / </span>
        <span>{t('home.verifiedSuppliers')}</span>
      </nav>

      <header className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5 shadow-card sm:flex-row sm:items-center">
        {profile.logoUrl === null ? (
          <span aria-hidden="true" className="flex h-16 w-16 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
            <BuildingIcon className="h-8 w-8" />
          </span>
        ) : (
          <img src={profile.logoUrl} alt="" className="h-16 w-16 shrink-0 rounded-xl border border-border object-contain" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="break-words text-title-xl text-ink">{profile.displayName}</h1>
          {typeof profile.legalName === 'string' && profile.legalName !== profile.displayName && (
            <p className="mt-0.5 text-sm text-ink-muted">{t('supplier.legalName', { name: profile.legalName })}</p>
          )}
          <p className="mt-1 text-sm text-ink-muted">
            {t(`home.supplierKind.${profile.kind}`)} · {countryName(profile.registrationCountry, language)}
            {profile.yearsInBusiness !== null && <> · {t('supplier.yearsInBusiness', { count: profile.yearsInBusiness, years: formatNumber(profile.yearsInBusiness) })}</>}
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-sm font-medium text-success">
            <ShieldIcon className="h-4 w-4 shrink-0" />
            {verifiedOn === null ? t('home.supplierVerified') : t('home.supplierVerifiedSince', { date: verifiedOn })}
          </p>
          <p className="mt-1 text-xs text-ink-muted">{t('supplier.verificationMeaning')}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:items-end">
          <CompareButton kind="suppliers" slug={profile.slug} name={profile.displayName} />
          <ButtonLink to={productsHref} variant="primary">
            {t('supplier.seeProducts', { count: profile.productCount, products: formatNumber(profile.productCount) })}
          </ButtonLink>
          {profile.websiteUrl !== null && (
            <a
              href={profile.websiteUrl}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="inline-flex items-center gap-1.5 text-sm text-brand underline-offset-2 hover:underline"
            >
              <GlobeIcon className="h-4 w-4" />
              {t('supplier.website')}
              <span className="sr-only">{t('supplier.opensInNewTab')}</span>
            </a>
          )}
        </div>
      </header>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {profile.description !== null && profile.description.trim() !== '' && (
          <Section id="supplier-about" title={t('supplier.about')}>
            <p className="whitespace-pre-line text-sm leading-relaxed text-ink">{profile.description}</p>
            <p className="mt-2 text-xs text-ink-muted">{t('supplier.statedBySupplier')}</p>
          </Section>
        )}

        {profile.categories.length > 0 && (
          <Section id="supplier-categories" title={t('supplier.whatTheySell')}>
            <ul className="flex flex-wrap gap-2">
              {profile.categories.map((category) => (
                <li key={category.slug}>
                  <Link
                    to={`/category/${encodeURIComponent(category.slug)}?seller=${encodeURIComponent(profile.slug)}`}
                    className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm text-ink hover:border-brand/40 hover:text-brand
                               focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
                  >
                    {category.name}
                    <span className="text-xs text-ink-muted">{formatNumber(category.productCount)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {profile.certifications.length > 0 && (
          <Section id="supplier-certifications" title={t('supplier.certifications')}>
            <p className="mb-3 text-xs text-ink-muted">{t('supplier.certificationsMeaning')}</p>
            <ul className="divide-y divide-border-subtle">
              {profile.certifications.map((certificate, index) => (
                <li key={`${certificate.standard}-${String(index)}`} className="py-2.5 text-sm">
                  <p className="flex items-center gap-1.5 font-medium text-ink">
                    <CheckIcon className="h-4 w-4 shrink-0 text-success" />
                    {certificate.standard}
                  </p>
                  <p className="mt-0.5 text-ink-muted">
                    {t('supplier.issuedBy', { issuer: certificate.issuer })}
                    {certificate.certificateNumber !== null && <> · {certificate.certificateNumber}</>}
                  </p>
                  {certificate.expiresOn !== null && (
                    <p className="text-ink-muted">
                      {t('supplier.validUntil', { date: dateFormat.format(new Date(certificate.expiresOn)) })}
                    </p>
                  )}
                  {certificate.scope !== null && <p className="mt-0.5 text-ink-muted">{certificate.scope}</p>}
                </li>
              ))}
            </ul>
          </Section>
        )}

        {profile.factories.length > 0 && (
          <Section id="supplier-factories" title={t('supplier.factories')}>
            <ul className="divide-y divide-border-subtle">
              {profile.factories.map((factory, index) => (
                <li key={`${factory.name}-${String(index)}`} className="py-2.5 text-sm">
                  <p className="font-medium text-ink">{factory.name}</p>
                  <p className="text-ink-muted">
                    {[factory.city, factory.region, countryName(factory.countryCode, language)].filter(Boolean).join(', ')}
                  </p>
                  <dl className="mt-1 grid grid-cols-1 gap-x-4 gap-y-0.5 text-ink-muted sm:grid-cols-2">
                    {factory.establishedYear !== null && (
                      <div className="flex gap-1">
                        <dt>{t('supplier.established')}</dt>
                        <dd className="text-ink">{factory.establishedYear}</dd>
                      </div>
                    )}
                    {factory.workforceCount !== null && (
                      <div className="flex gap-1">
                        <dt>{t('supplier.workforce')}</dt>
                        <dd className="text-ink">{formatNumber(factory.workforceCount)}</dd>
                      </div>
                    )}
                    {factory.monthlyCapacity !== null && (
                      <div className="flex gap-1">
                        <dt>{t('supplier.monthlyCapacity')}</dt>
                        <dd className="text-ink">
                          {formatNumber(factory.monthlyCapacity)}
                          {factory.capacityUnit !== null && ` ${factory.capacityUnit}`}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {factory.productsMade !== null && <p className="mt-1 text-ink-muted">{factory.productsMade}</p>}
                  {(factory.machines ?? []).length > 0 && (
                    <p className="mt-1 text-ink-muted">
                      <span className="font-medium text-ink">{t('supplier.machines')}</span>{' '}
                      {(factory.machines ?? [])
                        .map((machine) => (machine.quantity === null ? machine.name : `${machine.name} × ${formatNumber(machine.quantity)}`))
                        .join(', ')}
                    </p>
                  )}
                  {typeof factory.verifiedAt === 'string' && (
                    <p className="mt-1 text-xs text-success">
                      {t('supplier.factoryVerifiedOn', { date: dateFormat.format(new Date(factory.verifiedAt)) })}
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-ink-muted">{t('supplier.factoriesMeaning')}</p>
          </Section>
        )}

        {profile.inspectionSummary !== undefined && profile.inspectionSummary !== null && (
          <Section id="supplier-inspections" title={t('supplier.inspectionHistory')}>
            <p className="text-sm text-ink">
              {t('supplier.inspectionHistorySummary', {
                reports: formatNumber(profile.inspectionSummary.reports),
                passed: formatNumber(profile.inspectionSummary.passed),
                failed: formatNumber(profile.inspectionSummary.failed),
                months: formatNumber(profile.inspectionSummary.months),
              })}
            </p>
            <p className="mt-1 text-xs text-ink-muted">{t('supplier.inspectionHistoryMeaning')}</p>
          </Section>
        )}

        {stated && (
          <Section id="supplier-capabilities" title={t('supplier.capabilities')}>
            {profile.capabilities.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {profile.capabilities.map((capability) => (
                  <li key={capability} className="rounded-full bg-surface-sunken px-3 py-1 text-sm text-ink">
                    {capability}
                  </li>
                ))}
              </ul>
            )}
            <ul className="mt-3 space-y-1 text-sm text-ink">
              {profile.exportCapable && (
                <li>
                  {profile.exportMarkets.length > 0
                    ? t('supplier.exportsTo', {
                        countries: profile.exportMarkets.map((code) => countryName(code, language)).join(', '),
                      })
                    : t('supplier.exports')}
                </li>
              )}
              {profile.yearsExporting !== null && (
                <li>{t('supplier.yearsExporting', { count: profile.yearsExporting, years: formatNumber(profile.yearsExporting) })}</li>
              )}
              {profile.responseSlaHours !== null && (
                <li>{t('supplier.respondsWithin', { count: profile.responseSlaHours, hours: formatNumber(profile.responseSlaHours) })}</li>
              )}
            </ul>
            <p className="mt-2 text-xs text-ink-muted">{t('supplier.statedBySupplier')}</p>
          </Section>
        )}
      </div>
    </div>
  );
}
