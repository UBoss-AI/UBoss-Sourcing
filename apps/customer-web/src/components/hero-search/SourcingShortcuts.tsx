import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import { CameraIcon } from '@/components/icons';
/** Where a typed search can go next: products, suppliers, an RFQ, or image search. */
export function SourcingShortcuts({ term, onImageSearch }: { term: string; onImageSearch: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const words = term.trim();
  const suffix = words === '' ? '' : '?q=' + encodeURIComponent(words);
  const chip = 'inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
  return <section aria-label={t('sourcingShortcuts.label')} className="mb-3">
    <div className="flex flex-wrap gap-2">
      <Link to={'/products' + suffix} className={chip}>{t('sourcingShortcuts.product')}</Link>
      <Link to={'/suppliers' + suffix} className={chip}>{t('sourcingShortcuts.supplier')}</Link>
      {features.rfq === true ? <Link to={'/account/rfqs/new' + (words === '' ? '' : '?title=' + encodeURIComponent(words))} className={chip}>{t('sourcingShortcuts.rfq')}</Link> : <span className="inline-flex min-h-11 items-center px-3 text-sm text-ink-muted">{t('sourcingShortcuts.rfqUnavailable')}</span>}
      {features.imageSearch === true ? <button type="button" onClick={onImageSearch} className={chip}><CameraIcon aria-hidden="true" className="mr-2 h-4 w-4" />{t('heroSearch.imageSearch')}</button> : <span className="inline-flex min-h-11 items-center px-3 text-sm text-ink-muted">{t('sourcingShortcuts.imageUnavailable')}</span>}
    </div>
  </section>;
}
