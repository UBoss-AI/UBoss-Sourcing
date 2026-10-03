/**
 * Importer instructions and documents for the delivery country, at checkout
 * (ENH-022). Labels have their own notice; a blocked line is refused when the
 * order is placed. Shown only when the operator configured something.
 */
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

const guidanceResponse = z.object({
  country: z.string(),
  complianceNotes: z.string().nullable(),
  documentRequirements: z.array(z.object({ reason: z.string(), requiredDocuments: z.array(z.string()) })),
});

export function DestinationGuidanceNotice({
  country,
  productIds,
}: {
  country: string | null;
  productIds: string[];
}): React.JSX.Element | null {
  const { t } = useI18n();
  const ids = [...new Set(productIds)].sort();
  const enabled = country !== null && /^[A-Za-z]{2}$/.test(country) && ids.length > 0;

  const query = useQuery({
    queryKey: ['destination-guidance', country, ids.join(',')],
    queryFn: async () =>
      // Advisory only: an unreadable answer shows nothing; placing the order still enforces the rules.
      guidanceResponse.safeParse(await api.get<unknown>(`/catalog/destination-guidance?country=${encodeURIComponent(country ?? '')}&products=${encodeURIComponent(ids.join(','))}`)).data ?? null,
    enabled,
    staleTime: 60_000,
  });

  const data = query.data;
  if (!enabled || data === undefined || data === null || (data.complianceNotes === null && data.documentRequirements.length === 0)) return null;

  return (
    <section
      aria-labelledby="checkout-destination-guidance"
      role="note"
      className="rounded-lg border border-brand/30 bg-brand-soft p-4 text-sm text-ink"
    >
      <h2 id="checkout-destination-guidance" className="font-medium">
        {t('checkout.destinationGuidance.title', { country: data.country })}
      </h2>
      {data.complianceNotes === null ? null : (
        <div className="mt-2">
          <h3 className="font-medium">{t('checkout.destinationGuidance.importer')}</h3>
          <p className="whitespace-pre-wrap text-ink-muted">{data.complianceNotes}</p>
        </div>
      )}
      {data.documentRequirements.length === 0 ? null : (
        <div className="mt-2">
          <h3 className="font-medium">{t('checkout.destinationGuidance.documents')}</h3>
          <ul className="mt-1 space-y-2">
            {data.documentRequirements.map((row) => (
              <li key={`${row.reason}-${row.requiredDocuments.join('|')}`}>
                <span className="block">{row.reason}</span>
                <ul className="list-inside list-disc text-ink-muted">
                  {row.requiredDocuments.map((document) => (
                    <li key={document}>{document}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
