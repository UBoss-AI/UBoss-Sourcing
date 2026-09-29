/**
 * Pick an approved seller by name: on a draft (added to the request when it is
 * sent) or on an open request (invited at once). Says for each result whether
 * it would have matched on its own, so "not usually in this category" is a
 * choice the buyer makes knowingly rather than a surprise.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, Input } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { searchRfqSuppliers, type SupplierCard } from '@/lib/rfq';

export function SupplierPicker({
  categoryId,
  country,
  picked,
  onPick,
  onRemove,
  pickLabel,
}: {
  categoryId: string | null;
  country: string | null;
  picked: SupplierCard[];
  onPick: (supplier: SupplierCard) => void;
  onRemove?: (supplier: SupplierCard) => void;
  pickLabel?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const results = useQuery({
    queryKey: ['rfq', 'suppliers', submitted, categoryId, country],
    queryFn: () => searchRfqSuppliers({ q: submitted ?? '', categoryId, country }),
    enabled: submitted !== null,
  });
  const pickedIds = new Set(picked.map((supplier) => supplier.sellerAccountId));

  return (
    <div className="space-y-3">
      {picked.length > 0 && (
        <div>
          <p className="text-sm font-medium text-ink">{t('rfq.picker.picked')}</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {picked.map((supplier) => (
              <li key={supplier.sellerAccountId} className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-sm">
                {supplier.displayName}
                {onRemove !== undefined && (
                  <button
                    type="button"
                    className="text-xs font-medium text-danger hover:underline"
                    aria-label={t('rfq.picker.removeNamed', { name: supplier.displayName })}
                    onClick={() => {
                      onRemove(supplier);
                    }}
                  >
                    {t('rfq.form.remove')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field label={t('rfq.picker.search')} hint={t('rfq.picker.hint')}>
            {({ inputId, describedBy }) => (
              <Input
                id={inputId}
                aria-describedby={describedBy}
                value={q}
                maxLength={80}
                onChange={(event) => {
                  setQ(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    setSubmitted(q.trim());
                  }
                }}
              />
            )}
          </Field>
        </div>
        <Button
          type="button"
          onClick={() => {
            setSubmitted(q.trim());
          }}
        >
          {t('rfq.picker.find')}
        </Button>
      </div>
      {submitted !== null && (
        <div aria-live="polite">
          {results.isPending ? (
            <p className="text-sm text-ink-muted">{t('rfq.picker.searching')}</p>
          ) : results.isError ? (
            <p role="alert" className="text-sm text-danger">
              {t('rfq.picker.failed')}
            </p>
          ) : results.data.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('rfq.picker.none')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle rounded-md border border-border-subtle">
              {results.data.map((supplier) => (
                <li key={supplier.sellerAccountId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                  <span className="min-w-0 text-sm text-ink">
                    <span className="font-medium">{supplier.displayName}</span>
                    <span className="ml-2 text-xs text-ink-muted">
                      {supplier.matchesCategory ? t('rfq.picker.matches') : t('rfq.picker.notMatching')}
                    </span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    disabled={pickedIds.has(supplier.sellerAccountId)}
                    aria-label={`${pickLabel ?? t('rfq.picker.add')}: ${supplier.displayName}`}
                    onClick={() => {
                      onPick(supplier);
                    }}
                  >
                    {pickedIds.has(supplier.sellerAccountId) ? t('rfq.picker.added') : (pickLabel ?? t('rfq.picker.add'))}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
