import { track } from '@/lib/analytics';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useLocale } from '@/app/locale-context';
import { useI18n } from '@/i18n/i18n-context';
import { Button } from '@/components/ui';
import { clearCatalogueSearches, recentCatalogueSearches, rememberCatalogueSearch } from '@/lib/recent-catalogue-searches';

interface DiscoveryItem { scope: 'product' | 'category' | 'supplier' | 'capability'; label: string; href: string; }
interface DiscoveryResult { query: string; terms: string[]; items: DiscoveryItem[]; suggestions: string[]; currency: string; country: string | null; }

/** Explicit labelled links remain usable by Tab/Enter without hijacking form Enter. */
export function DiscoveryMatches({ q, onRecentSelect }: { q: string; onRecentSelect?: (term: string) => void }): React.JSX.Element | null {
  const { t, language } = useI18n();
  const { currency, country } = useLocale();
  const [settled, setSettled] = useState(q.trim());
  const [recent, setRecent] = useState(recentCatalogueSearches);
  useEffect(() => {
    const timer = window.setTimeout(() => { setSettled(q.trim()); }, 300);
    return () => { window.clearTimeout(timer); };
  }, [q]);
  const term = q.trim();
  const query = useQuery({
    queryKey: ['catalogue-discovery', settled, currency, country, language],
    queryFn: async () => {
      const result = await api.get<DiscoveryResult>('/catalog/search', { query: { q: settled, currency, country: country ?? undefined, language } });
      if (!Array.isArray(result.items) || !Array.isArray(result.suggestions)) throw new Error('Invalid public search response');
      return result;
    },
    enabled: settled.length >= 2 && settled.length <= 120, retry: false, refetchOnWindowFocus: false,
  });
  if (term.length < 2) {
    if (onRecentSelect === undefined || recent.length === 0) return null;
    return <section aria-label={t('discovery.recent')} className="mt-3 text-sm">
      <div className="flex items-center justify-between gap-2"><h2 className="font-semibold">{t('discovery.recent')}</h2><button type="button" className="text-brand underline" onClick={() => { clearCatalogueSearches(); setRecent([]); }}>{t('discovery.clearRecent')}</button></div>
      <ul className="mt-2 flex flex-wrap gap-2">{recent.map(value => <li key={value}><button type="button" className="max-w-full break-words rounded-lg border border-line bg-surface p-2 text-ink" onClick={() => { onRecentSelect(value); }}>{value}</button></li>)}</ul>
    </section>;
  }
  if (term !== settled || term.length > 120) return null;
  const result = query.data;
  return <section aria-label={t('discovery.title')} className="my-3 min-w-0 rounded-xl border border-line bg-surface p-3 text-sm">
    <h2 className="font-semibold text-ink">{t('discovery.title')}</h2>
    {query.isPending ? <p role="status" className="mt-2 text-ink-muted">{t('common.loading')}</p> : query.isError ? <div className="mt-2"><p role="alert" className="text-danger">{t('discovery.unavailable')}</p><Button variant="secondary" size="sm" className="mt-2" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('common.retry')}</Button></div> : result !== undefined ? <>
      {result.items.length === 0 ? <p role="status" className="mt-2 text-ink-muted">{t('discovery.empty')}</p> : <ul className="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">{(onRecentSelect === undefined ? result.items : result.items.slice(0, 6)).map((item, index) => <li key={item.scope + item.href + String(index)} className="min-w-0"><Link to={item.href} onClick={() => { if (onRecentSelect !== undefined) { rememberCatalogueSearch(term); track('search_submitted', '/'); } }} className="block break-words rounded-lg border border-line p-2 text-ink hover:text-brand"><span className="block text-xs text-ink-muted">{t('discovery.' + item.scope as 'discovery.product' | 'discovery.category' | 'discovery.supplier' | 'discovery.capability')}</span>{item.label}</Link></li>)}</ul>}
      {result.suggestions.length > 0 && <div className="mt-3"><p className="text-ink-muted">{t('discovery.didYouMean')}</p><ul className="flex flex-wrap gap-2">{result.suggestions.map(value => <li key={value}><Link className="inline-block break-words p-2 text-brand underline" onClick={() => { rememberCatalogueSearch(value); track('search_submitted', '/search'); }} to={'/search?q=' + encodeURIComponent(value)}>{value}</Link></li>)}</ul></div>}
      {result.items.length === 0 && <Link className="mt-2 inline-block p-2 text-brand underline" to="/products">{t('discovery.browse')}</Link>}
      <p className="mt-3 text-xs text-ink-muted">{t('discovery.hint')}</p>
    </> : null}
  </section>;
}
