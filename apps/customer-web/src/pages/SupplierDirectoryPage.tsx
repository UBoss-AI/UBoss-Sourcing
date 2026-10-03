import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { BuildingIcon } from '@/components/icons';
import { Button, ErrorState, Input, LoadingState, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { useStorefront } from '@/app/storefront-context';
import { api } from '@/lib/api';
import { countryName, ISO_COUNTRY_CODES } from '@/lib/iso-countries';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

function parsePublicSupplier(value: unknown): { slug: string; displayName: string; registrationCountry: string } {
  if (value === null || typeof value !== 'object' ||
      !('slug' in value) || typeof value.slug !== 'string' || value.slug.length > 180 || !/^[a-z0-9-]+$/.test(value.slug) ||
      !('displayName' in value) || typeof value.displayName !== 'string' || value.displayName.trim() === '' ||
      !('registrationCountry' in value) || typeof value.registrationCountry !== 'string' || !ISO_COUNTRY_CODES.includes(value.registrationCountry)) {
    throw new Error('Invalid supplier directory response');
  }
  return { slug: value.slug, displayName: value.displayName, registrationCountry: value.registrationCountry };
}

/** Public names only; the API retains approved/live-offer and own-shop guards. */
export function SupplierDirectoryPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { business } = useStorefront();
  const [params, setParams] = useSearchParams();
  const term = (params.get('q') ?? '').trim().slice(0, 120);
  const [words, setWords] = useState(term);
  useEffect(() => { setWords(term); }, [term]);
  useDocumentMeta({ title: t('sourcingShortcuts.directoryTitle') }, business.displayName);
  const query = useQuery({
    queryKey: ['supplier-directory', term],
    queryFn: async () => {
      const result = await api.get<unknown>('/catalog/suppliers', { query: { limit: 24, q: term || undefined } });
      if (result === null || typeof result !== 'object' || !('suppliers' in result) || !Array.isArray(result.suppliers) || result.suppliers.length > 24) throw new Error('Invalid supplier directory response');
      return { suppliers: result.suppliers.map(parsePublicSupplier) };
    },
    retry: false,
  });
  return <>
    <PageHeader title={t('sourcingShortcuts.directoryTitle')} description={t('sourcingShortcuts.directoryHint')} />
    <form className="my-4 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); const q = words.trim(); setParams(q === '' ? {} : { q }); }}>
      <label className="min-w-0 flex-1 text-sm text-ink">{t('sourcingShortcuts.nameSearch')}<Input maxLength={120} value={words} onChange={event => { setWords(event.target.value); }} /></label>
      <Button type="submit">{t('common.search')}</Button>
    </form>
    {query.isPending ? <LoadingState /> : query.isError ? <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /> : <>
      {query.data.suppliers.length === 0 ? <p role="status" className="text-sm text-ink-muted">{t('sourcingShortcuts.directoryEmpty')}</p> : <ul className="flex flex-wrap gap-3">{query.data.suppliers.map(supplier => <li key={supplier.slug} className="min-w-0 max-w-full"><Link to={'/suppliers/' + encodeURIComponent(supplier.slug)} className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-2 text-sm text-ink hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand">
        <BuildingIcon aria-hidden="true" className="h-4 w-4 shrink-0 text-brand" />
        <span className="truncate font-medium">{supplier.displayName}</span>
        <span className="shrink-0 text-xs text-ink-muted">{countryName(supplier.registrationCountry, language)}</span>
      </Link></li>)}</ul>}
    </>}
  </>;
}
