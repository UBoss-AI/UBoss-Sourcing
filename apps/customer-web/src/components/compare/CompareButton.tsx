/**
 * "Compare" on a product or supplier page: a toggle that adds it to, or takes
 * it off, this visitor's comparison list. When the list is full it says so
 * rather than silently doing nothing.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckIcon, PlusIcon } from '@/components/icons';
import {
  COMPARE_LIMIT,
  addToCompare,
  removeFromCompare,
  useCompareList,
  type CompareKind,
} from '@/lib/compare';
import { useI18n } from '@/i18n/i18n-context';

export function CompareButton({
  kind,
  slug,
  name,
}: {
  kind: CompareKind;
  slug: string;
  name: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const list = useCompareList(kind);
  const [full, setFull] = useState(false);
  const selected = list.some((item) => item.slug === slug);

  const toggle = (): void => {
    if (selected) {
      removeFromCompare(kind, slug);
      setFull(false);
      return;
    }
    setFull(!addToCompare(kind, { slug, name }));
  };

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        aria-pressed={selected}
        onClick={toggle}
        className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium text-ink
                   shadow-card hover:bg-surface-hover aria-pressed:border-brand/50 aria-pressed:text-brand
                   focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
      >
        {selected ? <CheckIcon className="h-4 w-4" /> : <PlusIcon className="h-4 w-4" />}
        {selected ? t('compare.inComparison') : t('compare.addToCompare')}
      </button>
      {selected && list.length > 1 && (
        <Link to={`/compare?tab=${kind}`} className="text-xs font-medium text-brand underline-offset-2 hover:underline">
          {t('compare.compareNow', { count: list.length, items: list.length })}
        </Link>
      )}
      {full && (
        <p role="status" className="text-xs text-warning">
          {t('compare.listFull', { limit: COMPARE_LIMIT })}
        </p>
      )}
    </div>
  );
}
