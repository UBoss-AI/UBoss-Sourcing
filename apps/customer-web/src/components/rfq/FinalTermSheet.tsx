import { Badge } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatMoneyMinor } from '@/lib/format';
import { formatUtc } from '@/lib/rfq-format';
import type { OfferTerms, OfferVersion } from '@/lib/rfq-quote';

/** The exact immutable offer being confirmed, compared with its preceding version. */
export function FinalTermSheet({ current, previous }: { current: OfferVersion; previous: OfferVersion | null }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const missing = t('rfq.notProvided');
  const text = (value: string | number | null): string => value === null || value === '' ? missing : String(value);
  const money = (terms: OfferTerms, key: 'unitPriceMinor' | 'toolingMinor' | 'sampleCostMinor' | 'shippingEstimateMinor'): string =>
    terms[key] === null ? missing : formatMoneyMinor(terms[key], terms.currency);
  const rows: { key: keyof OfferTerms; label: TranslationKey; show: (terms: OfferTerms) => string; monetary?: boolean }[] = [
    { key: 'currency', label: 'rfq.field.currency', show: terms => terms.currency },
    { key: 'unitPriceMinor', label: 'rfq.compare.row.unitPrice', show: terms => money(terms, 'unitPriceMinor'), monetary: true },
    { key: 'quantity', label: 'rfq.field.quantity', show: terms => terms.quantity },
    { key: 'moq', label: 'rfq.compare.row.moq', show: terms => text(terms.moq) },
    { key: 'leadTimeDays', label: 'rfq.compare.row.leadTime', show: terms => terms.leadTimeDays === null ? missing : t('rfq.compare.days', { days: String(terms.leadTimeDays) }) },
    { key: 'capacityPerMonth', label: 'rfq.compare.row.capacity', show: terms => text(terms.capacityPerMonth) },
    { key: 'incoterm', label: 'rfq.field.incoterm', show: terms => text(terms.incoterm) },
    { key: 'incotermPlace', label: 'rfq.quote.incotermPlace', show: terms => text(terms.incotermPlace) },
    { key: 'paymentTerms', label: 'rfq.compare.row.payment', show: terms => text(terms.paymentTerms) },
    { key: 'inspectionTerms', label: 'rfq.compare.row.inspection', show: terms => text(terms.inspectionTerms) },
    { key: 'warranty', label: 'rfq.compare.row.warranty', show: terms => text(terms.warranty) },
    { key: 'toolingMinor', label: 'rfq.compare.row.tooling', show: terms => money(terms, 'toolingMinor'), monetary: true },
    { key: 'sampleCostMinor', label: 'rfq.compare.row.sample', show: terms => money(terms, 'sampleCostMinor'), monetary: true },
    { key: 'shippingEstimateMinor', label: 'rfq.compare.row.shipping', show: terms => money(terms, 'shippingEstimateMinor'), monetary: true },
    { key: 'taxesDisclosure', label: 'rfq.compare.row.taxes', show: terms => text(terms.taxesDisclosure) },
    { key: 'tiers', label: 'rfq.compare.row.tiers', show: terms => terms.tiers.length === 0 ? missing : terms.tiers.map(tier => `${tier.minQuantity}: ${formatMoneyMinor(tier.unitPriceMinor, terms.currency)}`).join('\n'), monetary: true },
    { key: 'exportDocuments', label: 'rfq.compare.row.exportDocuments', show: terms => (terms.exportDocuments ?? []).length === 0 ? missing : (terms.exportDocuments ?? []).map(code => t(`rfq.exportDocument.${code}`)).join('\n') },
    { key: 'expiresAt', label: 'rfq.compare.row.validUntil', show: terms => formatUtc(terms.expiresAt, intlLocale) },
  ];
  const value = (terms: OfferTerms, key: keyof OfferTerms): unknown => key === 'exportDocuments' ? [...(terms.exportDocuments ?? [])].sort() : terms[key];
  return (
    <section aria-label={t('rfq.offer.summaryTitle')} className="space-y-3 text-ink">
      <h3 className="font-semibold">{t('rfq.offer.summaryTitle')}</h3>
      <p>{t('rfq.detail.versionN', { version: String(current.versionNumber) })}</p>
      {previous === null && <p className="text-ink-muted">{t('rfq.offer.summaryFirst')}</p>}
      <dl className="divide-y divide-border-subtle">
        {rows.map(row => {
          const changed = previous !== null && (JSON.stringify(value(current.terms, row.key)) !== JSON.stringify(value(previous.terms, row.key)) || row.monetary === true && current.terms.currency !== previous.terms.currency);
          return (
            <div key={row.key} className="py-2" data-term={row.key}>
              <dt className="flex flex-wrap items-center gap-2 font-medium">{t(row.label)}{changed && <Badge tone="warning">{t('rfq.offer.summaryChanged')}</Badge>}</dt>
              <dd className="break-words whitespace-pre-wrap">{row.show(current.terms)}</dd>
              {changed && <dd className="mt-1 break-words whitespace-pre-wrap text-ink-muted">{t('rfq.offer.summaryPrevious', { value: row.show(previous.terms) })}</dd>}
            </div>
          );
        })}
      </dl>
      {current.comment !== null && <p className="whitespace-pre-wrap">{current.comment}</p>}
      <p className="break-all font-mono text-xs text-ink-muted">{t('rfq.offer.hash', { hash: current.termsHash })}</p>
    </section>
  );
}
