/**
 * What AI Mode understood from a sourcing question (ENH-001), shown as chips,
 * with two ways on: the catalogue with those filters, or an editable RFQ draft.
 * Nothing is sent from here.
 */
import { Link } from 'react-router-dom';
import { useI18n } from '@/i18n/i18n-context';
import { parseSourcing, rfqHref, searchHref } from '@/lib/sourcing-parse';

export function DescribedSourcing({ text }: { text: string }): React.JSX.Element {
  const { t } = useI18n();
  const p = parseSourcing(text);
  const chips = [
    p.quantity === null ? null : t('aiMode.chip.quantity', { quantity: p.quantity, unit: p.unit ?? '' }),
    p.destinationCountry === null ? null : t('aiMode.chip.destination', { country: p.destinationCountry }),
    p.incoterm,
    ...p.certifications,
    p.maxLeadTimeDays === null ? null : t('aiMode.chip.leadTime', { days: String(p.maxLeadTimeDays) }),
    p.targetPrice === null ? null : t('aiMode.chip.price', { amount: p.targetPrice.amount, currency: p.targetPrice.currency }),
  ].filter((chip): chip is string => chip !== null);
  return (
    <span className="flex flex-col gap-1">
      {chips.length === 0 ? null : (
        <span className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-ink-muted">{t('aiMode.understood')}</span>
          {chips.map((chip) => (
            <span key={chip} className="rounded-full border border-border px-2 py-0.5">{chip}</span>
          ))}
        </span>
      )}
      <span className="flex flex-wrap gap-3">
        {p.product === '' ? null : (
          <Link to={searchHref(p)} className="font-medium text-brand underline-offset-2 hover:underline">{t('aiMode.searchFiltered')}</Link>
        )}
        <Link to={rfqHref(p)} className="font-medium text-brand underline-offset-2 hover:underline">{t('aiMode.draftRfq')}</Link>
      </span>
    </span>
  );
}
