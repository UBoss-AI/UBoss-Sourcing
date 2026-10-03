/**
 * Help on the RFQ form (ENH-032): plain explanations of the hard fields, and
 * values suggested from the buyer's own most recent submitted request. A
 * suggestion is only ever applied by pressing "Use this"; nothing is filled in
 * on its own, and a field the buyer has already filled is not offered.
 */
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { fetchMyRfqs, fetchRfq, type RfqDraftInput } from '@/lib/rfq';

type Suggestible = 'destinationCountry' | 'destinationPort' | 'incoterm' | 'unitOfMeasure' | 'targetCurrency' | 'inspectionRequirement';
const SUGGESTIBLE: readonly Suggestible[] = ['destinationCountry', 'destinationPort', 'incoterm', 'unitOfMeasure', 'targetCurrency', 'inspectionRequirement'];
const EXPLAINED = ['incoterm', 'inspection', 'sample', 'certifications', 'targetPrice'] as const;

const empty = (value: unknown): boolean => value === null || value === undefined || value === '';

export function RfqFormAssist({
  draft,
  onApply,
}: {
  draft: RfqDraftInput;
  onApply: <K extends Suggestible>(field: K, value: RfqDraftInput[K]) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const previous = useQuery({
    queryKey: ['rfq', 'assist', 'previous'],
    queryFn: async () => {
      const { items } = await fetchMyRfqs(null);
      const last = items.filter((item) => item.submittedAt !== null).sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)))[0];
      return last === undefined ? null : fetchRfq(last.id);
    },
    staleTime: 60_000,
    retry: false,
  });
  const source = previous.data ?? null;
  const offers = source === null ? [] : SUGGESTIBLE.filter((field) => empty(draft[field]) && !empty(source.requirement[field]));
  return (
    <details className="rounded-lg border border-border-subtle bg-surface p-3 text-sm">
      <summary className="cursor-pointer font-medium">{t('rfqAssist.title')}</summary>
      <dl className="mt-2 space-y-2">
        {EXPLAINED.map((key) => (
          <div key={key}>
            <dt className="font-medium">{t(`rfqAssist.explain.${key}.term`)}</dt>
            <dd className="text-ink-muted">{t(`rfqAssist.explain.${key}.body`)}</dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-3 font-medium">{t('rfqAssist.suggestTitle')}</h3>
      {previous.isPending ? <p role="status">{t('rfqAssist.loading')}</p> : source === null || offers.length === 0 ? (
        <p className="text-ink-muted">{t('rfqAssist.none')}</p>
      ) : (
        <>
          <p className="text-ink-muted">{t('rfqAssist.from', { reference: source.reference })}</p>
          <ul className="mt-1 space-y-1">
            {offers.map((field) => (
              <li key={field} className="flex flex-wrap items-center gap-2">
                <span>{t(`rfqAssist.field.${field}`)}: <strong>{String(source.requirement[field])}</strong></span>
                <Button size="sm" onClick={() => { onApply(field, source.requirement[field]); }}>{t('rfqAssist.use')}</Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </details>
  );
}
