/**
 * The tax invoices the sellers on this order issued to the buyer.
 *
 * Only issued ones: a draft is the seller's working copy and not yet a
 * document. A voided invoice stays listed with its credit note beside it,
 * because a buyer reconciling their books needs both. The packing list is the
 * carrier's document and is never offered here; the buyer sees only that the
 * goods were packed, and how many packages to expect.
 */
import { useMutation, useQuery } from '@tanstack/react-query';

import { useToast } from '@/components/toast-context';
import { Badge, Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import {
  buyerDocumentLink,
  fetchBuyerOrderDocuments,
  downloadWith,
  statusTone,
} from '@/lib/seller-documents';

export function OrderSellerInvoices({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['order', orderId, 'seller-documents'],
    queryFn: () => fetchBuyerOrderDocuments(orderId),
  });
  const download = useMutation({
    mutationFn: (id: string) => downloadWith(() => buyerDocumentLink(id)),
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  if (query.data === undefined) return null;
  const { invoices, packing } = query.data;
  if (invoices.length === 0 && packing.length === 0) return null;
  const packages = packing.reduce((sum, list) => sum + list.packageCount, 0);

  return (
    <section
      aria-labelledby="seller-invoices-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <h2 id="seller-invoices-heading" className="text-title-sm text-ink">
        {t('orderInvoices.title')}
      </h2>
      {invoices.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {invoices.map((invoice) => (
            <li key={invoice.id} className="space-y-1 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-ink">{invoice.number}</span>
                <Badge tone={statusTone(invoice.status)}>
                  {invoice.kind === 'CREDIT_NOTE'
                    ? t('orderInvoices.creditNote')
                    : t(`orderInvoices.status.${invoice.status}` as TranslationKey)}
                </Badge>
              </div>
              <p className="text-xs text-ink-muted">
                {t('orderInvoices.from', {
                  seller: invoice.sellerName ?? '',
                  total: invoice.totals.grandTotal.formatted,
                })}
              </p>
              <Button
                size="sm"
                variant="ghost"
                isLoading={download.isPending && download.variables === invoice.id}
                onClick={() => {
                  download.mutate(invoice.id);
                }}
              >
                {t('orderInvoices.download')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-ink-muted">{t('orderInvoices.none')}</p>
      )}
      {packages > 0 && (
        <p className="mt-3 border-t border-border-subtle pt-3 text-xs text-ink-muted">
          {t('orderInvoices.packed', { quantity: packages })}
        </p>
      )}
    </section>
  );
}
