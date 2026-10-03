import { Link } from 'react-router-dom';
import { useStorefront } from '@/app/storefront-context';
import { useI18n } from '@/i18n/i18n-context';
import { useVerifiedSuppliers } from '@/lib/verified-suppliers';
import { CameraIcon } from '@/components/icons';
/** The public API records dates as ISO UTC strings. Reject missing or malformed facts. */
function isIndianManufacturer(value: unknown): boolean {
  if (value === null || typeof value !== 'object' ||
      !('kind' in value) || value.kind !== 'MANUFACTURER' ||
      !('registrationCountry' in value) || value.registrationCountry !== 'IN' ||
      !('verifiedAt' in value) || typeof value.verifiedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.verifiedAt)) return false;
  const timestamp = Date.parse(value.verifiedAt);
  const normalized = value.verifiedAt.length === 20 ? value.verifiedAt.replace('Z', '.000Z') : value.verifiedAt;
  return Number.isFinite(timestamp) && timestamp <= Date.now() && new Date(timestamp).toISOString() === normalized;
}

/** Claims depend on public approved manufacturers, never on a brand name. */
export function SourcingShortcuts({ term, onImageSearch }: { term: string; onImageSearch: () => void }): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const facts = useVerifiedSuppliers();
  const data: unknown = facts.data;
  const manufacturers = data !== null && typeof data === 'object' && 'suppliers' in data && Array.isArray(data.suppliers) && data.suppliers.some(isIndianManufacturer);
  const words = term.trim();
  const suffix = words === '' ? '' : '?q=' + encodeURIComponent(words);
  const chip = 'inline-flex min-h-11 items-center rounded-full border border-border bg-surface px-3 py-2 text-sm font-medium text-ink hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand';
  return <section aria-label={t('sourcingShortcuts.label')} className="mb-3">
    <div className="mb-2 grid"><p aria-hidden={!(facts.isSuccess && manufacturers)} style={{ visibility: facts.isSuccess && manufacturers ? 'visible' : 'hidden' }} className="col-start-1 row-start-1 text-sm font-semibold text-ink">{t('sourcingShortcuts.manufacturers')}<span className="mt-1 block text-xs font-normal text-ink-muted">{t('sourcingShortcuts.reviewBasis')}</span></p></div>
    <div className="flex flex-wrap gap-2">
      <Link to={'/products' + suffix} className={chip}>{t('sourcingShortcuts.product')}</Link>
      <Link to={'/suppliers' + suffix} className={chip}>{t('sourcingShortcuts.supplier')}</Link>
      {features.rfq === true ? <Link to={'/account/rfqs/new' + (words === '' ? '' : '?title=' + encodeURIComponent(words))} className={chip}>{t('sourcingShortcuts.rfq')}</Link> : <span className="inline-flex min-h-11 items-center px-3 text-sm text-ink-muted">{t('sourcingShortcuts.rfqUnavailable')}</span>}
      {features.imageSearch === true ? <button type="button" onClick={onImageSearch} className={chip}><CameraIcon aria-hidden="true" className="mr-2 h-4 w-4" />{t('heroSearch.imageSearch')}</button> : <span className="inline-flex min-h-11 items-center px-3 text-sm text-ink-muted">{t('sourcingShortcuts.imageUnavailable')}</span>}
    </div>
  </section>;
}
