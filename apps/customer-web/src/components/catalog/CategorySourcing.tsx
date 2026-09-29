/**
 * The sourcing entry on a category page (checklist Master row 3).
 *
 * A category page answered "what is in here" and nothing else. A buyer
 * sourcing a line wants two more answers: **who sells it here**, and **can it
 * come to me**. So under the sub-categories this shows:
 *
 *   - **What the destination says.** A block on this category (or one above
 *     it) for the shopper's country, in the operator's own sentence, so an
 *     empty shelf explains itself; or the documents a buyer there must hold.
 *   - **Who sells it.** The number of verified suppliers with something live
 *     under this category, and up to six of them, each opening their products
 *     here - the category is kept, so the buyer does not start again.
 *   - **A way to ask.** When the assistant is on, a question about sourcing
 *     this category is parked in its composer, ready to edit, not sent.
 *
 * Every part is absent when it has nothing true to say, and the whole panel is
 * absent when no part does.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertIcon, InfoIcon, SparkIcon } from '@/components/icons';
import { SupplierPill } from '@/components/catalog/SupplierMatches';
import { useStorefront } from '@/app/storefront-context';
import { api } from '@/lib/api';
import { AI_MODE_PATH, setPendingQuestion } from '@/lib/ai-mode';
import { countryName } from '@/lib/iso-countries';
import { formatNumber } from '@/lib/format';
import type { SupplierListResponse } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

export interface CategoryMarketNote {
  effect: 'BLOCK' | 'DOCUMENTS_REQUIRED';
  reason: string;
  requiredDocuments: string[];
  categoryName: string;
}

const MAX_SHOWN = 6;

export function CategorySourcing({
  slug,
  categoryName,
  country,
  notes,
}: {
  slug: string;
  categoryName: string;
  country: string | null;
  notes: CategoryMarketNote[];
}): React.JSX.Element | null {
  const { t, language } = useI18n();
  const { features } = useStorefront();

  const suppliers = useQuery({
    queryKey: ['category-suppliers', slug],
    queryFn: () =>
      api.get<SupplierListResponse>('/catalog/suppliers', {
        query: { category: slug, limit: MAX_SHOWN },
      }),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const list = suppliers.isSuccess && Array.isArray(suppliers.data.suppliers) ? suppliers.data.suppliers : [];
  const total = suppliers.isSuccess && typeof suppliers.data.total === 'number' ? suppliers.data.total : 0;
  const destination = country === null ? '' : countryName(country, language);
  const safeNotes = Array.isArray(notes) ? notes : [];

  if (safeNotes.length === 0 && list.length === 0 && !features.assistant) return null;

  const askAssistant = (): void => {
    setPendingQuestion(t('catalog.sourcingQuestion', { category: categoryName }), 'compose');
  };

  return (
    <section aria-labelledby="category-sourcing" className="mb-6 rounded-lg border border-border bg-surface p-4 shadow-card">
      <h2 id="category-sourcing" className="text-title-sm text-ink">
        {t('catalog.sourcingHeading', { category: categoryName })}
      </h2>

      {safeNotes.map((note, index) => (
        <div
          // The notes are a fixed list from one read; the order is the key.
          key={index}
          role="note"
          className={
            note.effect === 'BLOCK'
              ? 'mt-3 flex gap-2 rounded-md border border-danger/30 bg-danger-soft p-3 text-sm text-ink'
              : 'mt-3 flex gap-2 rounded-md border border-warning/30 bg-warning-soft p-3 text-sm text-ink'
          }
        >
          {note.effect === 'BLOCK' ? (
            <AlertIcon className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          ) : (
            <InfoIcon className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          )}
          <div className="min-w-0">
            <p className="font-medium">
              {note.effect === 'BLOCK'
                ? t('catalog.marketBlocked', { country: destination })
                : t('catalog.marketDocumentsRequired', { country: destination })}
            </p>
            <p className="mt-0.5 text-ink-muted">{note.reason}</p>
            {note.requiredDocuments.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-ink-muted">
                {note.requiredDocuments.map((document) => (
                  <li key={document}>{document}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ))}

      {list.length > 0 && (
        <div className="mt-3">
          <p className="text-sm text-ink-muted">
            {t('catalog.verifiedSuppliersInCategory', {
              count: total,
              suppliers: formatNumber(total),
              category: categoryName,
            })}
          </p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {list.map((supplier) => (
              <li key={supplier.slug}>
                <SupplierPill
                  supplier={supplier}
                  href={`/category/${encodeURIComponent(slug)}?seller=${encodeURIComponent(supplier.slug)}`}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      {features.assistant && (
        <p className="mt-3 text-sm">
          <Link
            to={AI_MODE_PATH}
            onClick={askAssistant}
            className="inline-flex items-center gap-1.5 font-medium text-brand underline-offset-2 hover:text-brand-hover hover:underline
                       focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40"
          >
            <SparkIcon className="h-4 w-4" />
            {t('catalog.askAssistantToSource', { category: categoryName })}
          </Link>
        </p>
      )}
    </section>
  );
}
