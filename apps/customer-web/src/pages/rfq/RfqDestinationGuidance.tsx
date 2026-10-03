import { useQuery } from '@tanstack/react-query';
import { ErrorState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatMoneyMinor } from '@/lib/format';
import { fetchRfqDestinationGuidance } from '@/lib/rfq';

/** Without currency enumeration, keep the rule qualified rather than guessing its amount. */
function isKnownCurrency(currency: string): boolean {
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    return typeof supported === 'function' && supported('currency').includes(currency);
  } catch {
    return false;
  }
}
/** Uses the form's unsaved fields; never edits or saves the requirement. */
export function RfqDestinationGuidance({ country, categoryId }: { country: string | null; categoryId: string | null }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['rfq', 'destination-guidance', country, categoryId],
    queryFn: () => fetchRfqDestinationGuidance(country ?? '', categoryId),
    enabled: country !== null,
    retry: false,
    staleTime: 0,
  });
  return <section aria-label={t('rfq.destinationGuidance.title')} className="rounded-lg border border-border bg-surface p-3 text-sm sm:col-span-2">
    <h3 className="font-semibold">{t('rfq.destinationGuidance.title')}</h3>
    {country === null ? <p>{t('rfq.destinationGuidance.choose')}</p> : query.isFetching || query.isPending ? <p role="status">{t('rfq.destinationGuidance.loading')}</p> : query.isError ? <ErrorState error={query.error} onRetry={() => { void query.refetch(); }} /> : <>
      {query.data.complianceNotes === null && query.data.notes.length === 0 ? <p role="status">{t('rfq.destinationGuidance.empty')}</p> : <>
        {query.data.complianceNotes === null ? null : <div className="mt-2"><h4 className="font-medium">{t('rfq.destinationGuidance.importer')}</h4><p className="whitespace-pre-wrap">{query.data.complianceNotes}</p></div>}
        {query.data.blockedReason === null ? null : <p className="mt-2 font-medium">{t('rfq.destinationGuidance.blocked', { reason: query.data.blockedReason })}</p>}
        <ul className="space-y-3">{query.data.notes.map((note, index) => <li key={index} className="mt-2">
          <p className="font-medium">{t('rfq.destinationGuidance.category', { name: note.categoryName })}</p>
          <p className="whitespace-pre-wrap">{note.reason}</p>
          {note.minOrderValueMinor === null ? null : <p>{/^\d+$/.test(note.minOrderValueMinor) && note.thresholdCurrency !== null && /^[A-Z]{3}$/.test(note.thresholdCurrency) && isKnownCurrency(note.thresholdCurrency)
            ? t('rfq.destinationGuidance.threshold', { amount: formatMoneyMinor(note.minOrderValueMinor, note.thresholdCurrency) })
            : t('rfq.destinationGuidance.thresholdUnknown')}</p>}
          {note.labelText === null ? null : <p className="whitespace-pre-wrap">{t('rfq.destinationGuidance.label', { text: note.labelText })}</p>}
          {note.requiredDocuments.length === 0 ? null : <><p className="font-medium">{t('rfq.destinationGuidance.documents')}</p><ul className="list-inside list-disc">{note.requiredDocuments.map((document, documentIndex) => <li key={documentIndex}>{document}</li>)}</ul></>}
        </li>)}</ul>
      </>}
    </>}
  </section>;
}