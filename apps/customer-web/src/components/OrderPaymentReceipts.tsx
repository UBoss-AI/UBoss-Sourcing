/**
 * The buyer's payment and refund receipts for one order.
 *
 * One row per captured payment and per confirmed refund, each with a
 * "Download receipt" button. Renders nothing while the order has neither -
 * an unpaid order has no receipt to offer, and an empty box would suggest one
 * is missing.
 */
import { useMutation, useQuery } from '@tanstack/react-query';

import { useToast } from '@/components/toast-context';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { downloadReceipt, fetchOrderReceipts, type OrderReceipt } from '@/lib/receipts';

export function OrderPaymentReceipts({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t, language } = useI18n();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['order', orderId, 'receipts'],
    queryFn: () => fetchOrderReceipts(orderId),
  });
  const download = useMutation({
    mutationFn: (receipt: OrderReceipt) => downloadReceipt(orderId, receipt, language),
    onSuccess: () => {
      // The first download issues the number; show it.
      void query.refetch();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
    },
  });

  const receipts = query.data?.receipts ?? [];
  if (receipts.length === 0) return null;

  return (
    <section
      aria-labelledby="payment-receipts-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <h2 id="payment-receipts-heading" className="text-title-sm text-ink">
        {t('receipts.title')}
      </h2>
      <ul className="mt-3 space-y-3">
        {receipts.map((receipt) => (
          <li key={`${receipt.kind}:${receipt.sourceId}`} className="space-y-1 text-sm">
            <p className="text-ink">
              {receipt.kind === 'payment'
                ? t('receipts.payment', { amount: receipt.amount.formatted })
                : t('receipts.refund', { amount: receipt.amount.formatted })}
            </p>
            <p className="text-xs text-ink-muted">
              {receipt.occurredAt === null ? null : formatDateTime(receipt.occurredAt)}
              {receipt.receiptNumber === null ? null : (
                <span className="ms-2 font-mono">{receipt.receiptNumber}</span>
              )}
            </p>
            <Button
              size="sm"
              variant="ghost"
              isLoading={download.isPending && download.variables.sourceId === receipt.sourceId}
              onClick={() => {
                download.mutate(receipt);
              }}
            >
              {t('receipts.download')}
            </Button>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-border-subtle pt-3 text-xs text-ink-muted">{t('receipts.hint')}</p>
    </section>
  );
}
