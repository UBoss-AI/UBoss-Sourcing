/** "What differs", above the comparison table (ENH-002): each line links to its source cell. */
import { useI18n } from '@/i18n/i18n-context';
import { compareCellId, summarise, type SummaryField } from '@/lib/compare-summary';
import { formatMoney } from '@/lib/format';
import type { ComparisonRow } from '@/lib/rfq-quote';

export function CompareSummary({ rows }: { rows: ComparisonRow[] }): React.JSX.Element | null {
  const { t } = useI18n();
  if (rows.length < 2) return null;
  const { comparablePrices, conclusions } = summarise(rows, formatMoney);
  const label: Record<SummaryField, string> = {
    total: t('rfq.compare.row.total'),
    landed: t('rfq.compare.row.landed'),
    leadTime: t('rfq.compare.row.leadTime'),
    moq: t('rfq.compare.row.moq'),
  };
  return (
    <section aria-labelledby="compare-summary" className="mb-4 rounded-lg border border-border bg-surface p-4 text-sm shadow-card">
      <h2 id="compare-summary" className="font-semibold">{t('rfq.compare.summary.title')}</h2>
      <p className="text-xs text-ink-muted">{t('rfq.compare.summary.note')}</p>
      <ul className="mt-2 space-y-1">
        {conclusions.map((c) => (
          <li key={c.field}>
            {t(`rfq.compare.summary.${c.field}`, { suppliers: c.suppliers.join(', '), value: c.value })}{' '}
            {c.quoteIds.map((quoteId) => (
              <a key={quoteId} href={`#${compareCellId(label[c.field], quoteId)}`} className="text-xs font-medium text-brand hover:underline">
                {t('rfq.compare.summary.source', { field: label[c.field] })}
              </a>
            ))}
            {c.unstated > 0 ? <span className="text-xs text-ink-muted"> {t('rfq.compare.summary.unstated', { quotes: String(c.unstated) })}</span> : null}
          </li>
        ))}
        {!comparablePrices ? <li className="text-ink-muted">{t('rfq.compare.summary.noPriceBasis')}</li> : null}
        {conclusions.length === 0 && comparablePrices ? <li className="text-ink-muted">{t('rfq.compare.summary.none')}</li> : null}
      </ul>
    </section>
  );
}
