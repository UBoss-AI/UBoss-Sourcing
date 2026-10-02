/**
 * The RFQ purchase order an order was made from (LIVE-004): its reference,
 * the Incoterm, the payment and inspection terms, and the export documents
 * the supplier promised. Read only - the contract does not change here.
 */
import { Card } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { OrderPurchaseOrderLink } from '@/lib/seller';

export function PurchaseOrderTermsCard({ purchaseOrder }: { purchaseOrder: OrderPurchaseOrderLink }): React.JSX.Element {
  const { t } = useI18n();
  const missing = t('rfq.notProvided');
  const incoterm =
    purchaseOrder.incoterm === null
      ? missing
      : `${purchaseOrder.incoterm}${purchaseOrder.incotermPlace === null ? '' : ` · ${purchaseOrder.incotermPlace}`}`;
  const rows: { label: string; value: string }[] = [
    { label: t('rfq.po.orderFrom.rfq'), value: purchaseOrder.rfqReference },
    { label: t('rfq.po.buyerSku'), value: purchaseOrder.buyerSku ?? missing },
    { label: t('rfq.field.incoterm'), value: incoterm },
    { label: t('rfq.po.paymentTerms'), value: purchaseOrder.paymentTerms ?? missing },
    { label: t('rfq.po.inspection'), value: purchaseOrder.inspectionTerms ?? missing },
    {
      label: t('rfq.compare.row.exportDocuments'),
      value:
        purchaseOrder.exportDocuments.length === 0
          ? missing
          : purchaseOrder.exportDocuments.map((code) => t(`rfq.exportDocument.${code}` as 'rfq.exportDocument.PACKING_LIST')).join(', '),
    },
  ];
  return (
    <Card title={t('rfq.po.orderFrom.title', { reference: purchaseOrder.reference })} bodyClassName="px-5 py-4">
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label}>
            <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{row.label}</dt>
            <dd className="mt-1 whitespace-pre-wrap break-words text-ink">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
