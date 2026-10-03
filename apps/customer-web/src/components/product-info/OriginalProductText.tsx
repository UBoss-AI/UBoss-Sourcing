/** Original public catalogue copy, fetched only on the reader's explicit request. */
import { useId, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import type { ProductDetailResponse } from '@/lib/types';
import { SafeHtml } from '@/lib/safe-html';

export function OriginalProductText({ productId, slug, currency, country }: {
  productId: string; slug: string; currency: string; country: string | null;
}): React.JSX.Element {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const query = useQuery({
    queryKey: ['product-original-text', productId, slug, currency, country],
    // Omitting language asks the existing public route for its base copy.
    // Keep the same market and its ordinary catalogue visibility rules.
    queryFn: () => api.get<ProductDetailResponse>(`/catalog/products/${encodeURIComponent(slug)}`, {
      query: { currency, country: country ?? undefined },
    }),
    enabled: open, retry: false, refetchOnWindowFocus: false,
  });
  const original = query.isSuccess && query.data.product.id === productId ? query.data.product : undefined;
  return (
    <div className="mt-3">
      <Button variant="secondary" size="sm" aria-expanded={open} aria-controls={panelId} onClick={() => { setOpen(!open); }}>
        {open ? t('product.translation.hideOriginal') : t('product.translation.showOriginal')}
      </Button>
      {open && (
        <section id={panelId} aria-label={t('product.translation.originalTitle')} className="mt-3 min-w-0 rounded-xl border border-line bg-surface p-4 break-words">
          <h2 className="text-title-md text-ink">{t('product.translation.originalTitle')}</h2>
          <p className="mt-1 text-sm text-ink-muted">{t('product.translation.originalHint')}</p>
          {query.isPending ? <p role="status" className="mt-3 text-sm">{t('common.loading')}</p> : original === undefined ? (
            <div className="mt-3">
              <p role="alert" className="text-sm text-danger">{t('product.translation.unavailable')}</p>
              <Button variant="secondary" size="sm" className="mt-2" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('common.retry')}</Button>
            </div>
          ) : (
            <>
              <p className="mt-3 font-semibold text-ink">{original.name}</p>
              {original.shortDescription !== null && <p className="mt-1 whitespace-pre-line text-sm text-ink">{original.shortDescription}</p>}
              {original.descriptionHtml !== null ? <SafeHtml html={original.descriptionHtml} className="mt-3 text-sm break-words [&_img]:max-w-full [&_table]:block [&_table]:overflow-x-auto" /> : original.description !== null && <p className="mt-3 whitespace-pre-line text-sm">{original.description}</p>}
              {(original.descriptionSections ?? []).map((section, index) => <article key={index} className="mt-3"><h3 className="text-sm font-semibold">{section.heading}</h3><p className="whitespace-pre-line text-sm">{section.body}</p></article>)}
              {original.safety?.warnings && <div className="mt-3"><h3 className="text-sm font-semibold">{t('safety.warnings')}</h3><p className="whitespace-pre-line text-sm">{original.safety.warnings}</p></div>}
              {original.safety?.instructions && <div className="mt-3"><h3 className="text-sm font-semibold">{t('safety.instructions')}</h3><p className="whitespace-pre-line text-sm">{original.safety.instructions}</p></div>}
              {original.device?.intendedPurpose && <div className="mt-3"><h3 className="text-sm font-semibold">{t('device.intendedPurpose')}</h3><p className="whitespace-pre-line text-sm">{original.device.intendedPurpose}</p></div>}
            </>
          )}
        </section>
      )}
    </div>
  );
}
