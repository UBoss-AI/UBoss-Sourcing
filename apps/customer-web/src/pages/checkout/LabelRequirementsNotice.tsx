/**
 * The labelling rules for the delivery country, at checkout (JOURNEY-064).
 *
 * A LABEL_REQUIRED country rule never stops a sale. It says what the goods
 * must carry in that country - a language, a symbol, an importer's name - so
 * the buyer knows what will arrive and is not surprised at customs. Shown only
 * when a rule applies to something in the basket; nothing otherwise.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useI18n } from '@/i18n/i18n-context';

interface LabelRequirement {
  productId: string;
  reason: string;
  labelText: string;
}

export function LabelRequirementsNotice({
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
    queryKey: ['label-requirements', country, ids.join(',')],
    queryFn: () =>
      api.get<{ requirements: LabelRequirement[] }>(
        `/catalog/label-requirements?country=${encodeURIComponent(country ?? '')}&products=${encodeURIComponent(ids.join(','))}`,
      ),
    enabled,
    staleTime: 60_000,
  });

  const requirements = query.data?.requirements ?? [];
  if (!enabled || requirements.length === 0) return null;

  // One line per distinct rule: a rule on a category covers several lines.
  const distinct = [...new Map(requirements.map((row) => [`${row.reason}\n${row.labelText}`, row])).values()];

  return (
    <section
      aria-labelledby="checkout-label-rules"
      role="note"
      className="rounded-lg border border-brand/30 bg-brand-soft p-4 text-sm text-ink"
    >
      <h2 id="checkout-label-rules" className="font-medium">
        {t('checkout.labelRulesTitle', { country })}
      </h2>
      <ul className="mt-2 space-y-2">
        {distinct.map((row) => (
          <li key={`${row.reason}-${row.labelText}`}>
            <span className="block">{row.reason}</span>
            <span className="block whitespace-pre-wrap text-ink-muted">{row.labelText}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
