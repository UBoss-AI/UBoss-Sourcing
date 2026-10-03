/**
 * One search across everything a visitor may see (ENH-004): products and
 * suppliers for anyone; the buyer's own orders, invoices, shipments and
 * requests when signed in (the server scopes those to them); and help pages.
 * Each group loads and fails on its own, so one slow source never hides the rest.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Input, PageHeader } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

interface Hit { key: string; label: string; to: string }
interface AccountResults {
  orders: { id: string; orderNumber: string }[];
  invoices: { id: string; number: string; orderId: string }[];
  shipments: { id: string; trackingNumber: string; orderId: string }[];
  rfqs: { id: string; reference: string; title: string }[];
}

const HELP: { key: TranslationKey; to: string }[] = [
  { key: 'find.help.support', to: '/support' },
  { key: 'find.help.policies', to: '/legal' },
  { key: 'find.help.returns', to: '/account/returns' },
  { key: 'find.help.orders', to: '/account/orders' },
  { key: 'find.help.landedCost', to: '/tools/landed-cost' },
];

function Group({ title, state, hits, empty }: { title: string; state: 'loading' | 'error' | 'ready'; hits: Hit[]; empty: string }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section aria-label={title} className="rounded-lg border border-border-subtle bg-surface p-3 text-sm">
      <h2 className="font-semibold">{title}</h2>
      {state === 'loading' ? <p role="status">{t('find.loading')}</p> : state === 'error' ? <p role="alert" className="text-danger">{t('find.failed')}</p> : hits.length === 0 ? <p className="text-ink-muted">{empty}</p> : (
        <ul className="mt-1 space-y-1">
          {hits.map((hit) => <li key={hit.key}><Link to={hit.to} className="text-brand hover:underline">{hit.label}</Link></li>)}
        </ul>
      )}
    </section>
  );
}

const stateOf = (q: { isPending: boolean; isError: boolean }): 'loading' | 'error' | 'ready' => (q.isPending ? 'loading' : q.isError ? 'error' : 'ready');

export function UniversalSearchPage(): React.JSX.Element {
  const { t } = useI18n();
  const { business } = useStorefront();
  const { isCustomer } = useSession();
  const [params, setParams] = useSearchParams();
  const term = (params.get('q') ?? '').trim();
  const [text, setText] = useState(term);
  useDocumentMeta({ title: t('find.title'), noIndex: true }, business.displayName);
  const ready = term.length >= 2;
  const products = useQuery({
    queryKey: ['find', 'products', term],
    queryFn: () => api.get<{ products: { slug: string; name: string }[] }>('/catalog/products', { query: { q: term, limit: 5, page: 1 } }),
    enabled: ready,
  });
  const suppliers = useQuery({
    queryKey: ['find', 'suppliers', term],
    queryFn: () => api.get<{ suppliers: { slug: string; displayName: string }[] }>('/catalog/suppliers', { query: { q: term, limit: 5 } }),
    enabled: ready,
  });
  const mine = useQuery({
    queryKey: ['find', 'account', term],
    queryFn: () => api.get<AccountResults>('/account/search', { query: { q: term } }),
    enabled: ready && isCustomer,
  });
  const help = HELP.filter((entry) => t(entry.key).toLowerCase().includes(term.toLowerCase()) || term.length < 2);
  const records: Hit[] = mine.data === undefined ? [] : [
    ...mine.data.orders.map((o) => ({ key: `o-${o.id}`, label: t('find.order', { number: o.orderNumber }), to: `/account/orders/${o.id}` })),
    ...mine.data.invoices.map((i) => ({ key: `i-${i.id}`, label: t('find.invoice', { number: i.number }), to: `/account/orders/${i.orderId}` })),
    ...mine.data.shipments.map((s) => ({ key: `s-${s.id}`, label: t('find.shipment', { number: s.trackingNumber }), to: `/account/orders/${s.orderId}` })),
    ...mine.data.rfqs.map((r) => ({ key: `r-${r.id}`, label: t('find.rfq', { reference: r.reference, title: r.title }), to: `/account/rfqs/${r.id}` })),
  ];
  return (
    <div className="space-y-4">
      <PageHeader title={t('find.title')} description={t('find.description')} />
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setParams(text.trim() === '' ? {} : { q: text.trim() });
        }}
      >
        <label htmlFor="find-q" className="sr-only">{t('find.title')}</label>
        <Input id="find-q" type="search" value={text} maxLength={100} placeholder={t('find.placeholder')} onChange={(event) => { setText(event.target.value); }} />
      </form>
      {!ready ? <p className="text-sm text-ink-muted">{t('find.tooShort')}</p> : (
        <div className="grid gap-3 md:grid-cols-2">
          <Group title={t('find.products')} state={stateOf(products)} empty={t('find.none')} hits={(products.data?.products ?? []).map((p) => ({ key: p.slug, label: p.name, to: `/product/${p.slug}` }))} />
          <Group title={t('find.suppliers')} state={stateOf(suppliers)} empty={t('find.none')} hits={(suppliers.data?.suppliers ?? []).map((s) => ({ key: s.slug, label: s.displayName, to: `/suppliers/${s.slug}` }))} />
          {isCustomer ? <Group title={t('find.records')} state={stateOf(mine)} empty={t('find.none')} hits={records} /> : null}
          <Group title={t('find.helpTitle')} state="ready" empty={t('find.none')} hits={help.map((h) => ({ key: h.to, label: t(h.key), to: h.to }))} />
        </div>
      )}
    </div>
  );
}
