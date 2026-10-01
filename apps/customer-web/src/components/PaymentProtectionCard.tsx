/**
 * How the buyer's payment on this order is protected (D13 facilitator model):
 * the method and status of the payment, the disclosed release terms, and for
 * each seller where their money is - held, on hold for a dispute, or released.
 * Receipts are the card below it. Renders nothing until the order is paid.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { conditionKey, fetchPaymentProtection, fundsStatusKey, fundsTone } from '@/lib/finance';
import { formatMinor } from '@/lib/seller';

const k = (key: string): TranslationKey => key as TranslationKey;

export function PaymentProtectionCard({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t, language } = useI18n();
  const query = useQuery({
    queryKey: ['order', orderId, 'payment-protection'],
    queryFn: () => fetchPaymentProtection(orderId),
  });
  const data = query.data;
  if (data === undefined || data.payment === null) return null;
  const terms = data.releaseTerms;

  return (
    <section
      aria-labelledby="payment-protection-heading"
      className="rounded-lg border border-border bg-surface p-5 shadow-card"
    >
      <h2 id="payment-protection-heading" className="text-title-sm text-ink">
        {t(k('finance.protection.title'))}
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="text-xs text-ink-muted">{t(k('finance.protection.method'))}</dt>
          <dd className="text-ink">
            {data.payment.cardBrand !== null && data.payment.cardLast4 !== null
              ? `${data.payment.cardBrand} ···· ${data.payment.cardLast4}`
              : (data.payment.method ?? data.payment.provider)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{t(k('finance.protection.currency'))}</dt>
          <dd className="text-ink">{data.payment.currency}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{t(k('finance.protection.paid'))}</dt>
          <dd className="text-ink">{formatMinor(data.paidMinor, data.currency, language)}</dd>
        </div>
        <div>
          <dt className="text-xs text-ink-muted">{t(k('finance.protection.status'))}</dt>
          <dd className="text-ink">{t(k(`finance.payment.${data.payment.status}`))}</dd>
        </div>
      </dl>

      {data.protectionEnabled && (
        <>
          <p className="mt-4 text-sm text-ink-muted">
            {t(k('finance.protection.terms'), { days: terms.releaseAfterDays })}
            {terms.inspectionRequired ? ` ${t(k('finance.protection.termsInspection'))}` : ''}
          </p>
          <ul className="mt-3 space-y-3" aria-label={t(k('finance.protection.milestones'))}>
            {data.sellers.map((seller) => (
              <li key={seller.sellerOrderNumber} className="rounded-md border border-border-subtle p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-ink">
                    {seller.sellerName} · <span className="font-mono">{seller.sellerOrderNumber}</span>
                  </span>
                  <Badge tone={fundsTone(seller.fundsStatus)}>{t(k(fundsStatusKey(seller.fundsStatus)))}</Badge>
                </div>
                {seller.onHoldForDispute && (
                  <p className="mt-1 text-xs text-ink-muted">{t(k('finance.protection.disputeHold'))}</p>
                )}
                {seller.conditions.length > 0 && (
                  <ul className="mt-2 space-y-1 text-xs">
                    {seller.conditions.map((condition) => (
                      <li key={condition.key} className={condition.met ? 'text-success' : 'text-ink-muted'}>
                        {condition.met ? '✓ ' : '○ '}
                        {t(k(conditionKey(condition.key)))}
                        {condition.at !== null && !condition.met ? ` · ${formatDateTime(condition.at)}` : ''}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
