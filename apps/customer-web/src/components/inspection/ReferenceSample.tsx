/**
 * The contract an inspection is measured against (LIVE-004, JOURNEY-019).
 *
 * For an order made from an RFQ purchase order: the purchase order and its
 * inspection terms, and the reference sample the buyer approved - its code,
 * the criteria it met and the evidence on file. Shown to the buyer, the
 * seller and the inspector alike, so all three are reading the same standard.
 */
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import type { InspectionReferenceSample, InspectionPurchaseOrder } from '@/lib/inspection';

export function ReferenceSample({
  purchaseOrder,
  referenceSample,
}: {
  purchaseOrder?: InspectionPurchaseOrder | null | undefined;
  referenceSample?: InspectionReferenceSample | null | undefined;
}): React.JSX.Element | null {
  const { t } = useI18n();
  if ((purchaseOrder ?? null) === null && (referenceSample ?? null) === null) return null;
  return (
    <section aria-label={t('inspection.contract.title')} className="space-y-2 rounded-md border border-border-subtle bg-surface-sunken p-3 text-sm">
      <p className="font-medium text-ink">{t('inspection.contract.title')}</p>
      {purchaseOrder != null && (
        <p>
          {t('inspection.contract.purchaseOrder', { reference: purchaseOrder.reference })}
          {purchaseOrder.inspectionTerms !== null && (
            <span className="block text-ink-muted">{t('inspection.contract.terms', { terms: purchaseOrder.inspectionTerms })}</span>
          )}
        </p>
      )}
      {referenceSample != null ? (
        <div>
          <p>
            {t('inspection.contract.sample', { code: referenceSample.referenceCode ?? referenceSample.reference })}
            {referenceSample.approvedAt !== null && <span className="text-ink-muted"> · {formatDateTime(referenceSample.approvedAt)}</span>}
          </p>
          <p className="whitespace-pre-wrap break-words text-ink-muted">
            {t('inspection.contract.criteria', { criteria: referenceSample.approvalCriteria })}
          </p>
          {referenceSample.decisionReason !== null && (
            <p className="whitespace-pre-wrap break-words text-ink-muted">
              {t('inspection.contract.buyerNote', { note: referenceSample.decisionReason })}
            </p>
          )}
          {referenceSample.files.length > 0 && (
            <p className="break-words text-xs text-ink-muted">{t('inspection.contract.files', { files: referenceSample.files.join(', ') })}</p>
          )}
        </div>
      ) : (
        <p className="text-ink-muted">{t('inspection.contract.noSample')}</p>
      )}
    </section>
  );
}
