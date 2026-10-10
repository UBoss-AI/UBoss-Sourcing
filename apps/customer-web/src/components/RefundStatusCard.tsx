/**
 * The refunds on one order, as the payment provider reports them (Doc 07).
 *
 * A refund is only ever called confirmed when the provider has confirmed it:
 * "instructed" is a fact about this marketplace, "credited" is a fact about the
 * buyer's bank, and this card never says the second on the strength of the
 * first. Renders nothing while there are no refunds.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, type BadgeTone } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { commercialKeys, fetchRefundStatus } from '@/lib/commercial-policy';
import { formatDateTime, formatMoneyMinor } from '@/lib/format';

const KNOWN_STATES = new Set(['REQUESTED', 'SUBMITTED', 'PENDING_PROVIDER', 'SUCCEEDED', 'FAILED', 'CANCELLED']);

const TONES: Record<string, BadgeTone> = {
  SUCCEEDED: 'success',
  FAILED: 'danger',
  CANCELLED: 'neutral',
};

export function RefundStatusCard({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({ queryKey: commercialKeys.refunds(orderId), queryFn: () => fetchRefundStatus(orderId) });
  if (query.isPending || query.isError || query.data.length === 0) return null;
  return (
    <section className="rounded-lg border border-border bg-surface p-5 shadow-card" aria-labelledby="refunds-heading">
      <h2 id="refunds-heading" className="text-title-sm text-ink">
        {t('commercial.refunds.title')}
      </h2>
      <ul className="mt-3 space-y-3 text-sm">
        {query.data.map((refund) => {
          // An unknown state reads as "requested", never as anything stronger.
          const state = KNOWN_STATES.has(refund.state) ? refund.state : 'REQUESTED';
          return (
            <li key={refund.id} className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium text-ink">{formatMoneyMinor(refund.amountMinor, refund.currency)}</span>
                <Badge tone={TONES[state] ?? 'warning'}>{t(`commercial.refundState.${state}` as TranslationKey)}</Badge>
              </div>
              <p className="text-xs text-ink-muted">{t('commercial.refunds.instructed', { when: formatDateTime(refund.instructedAt) })}</p>
              {state === 'SUCCEEDED' && refund.providerConfirmedAt !== null && (
                <p className="text-xs text-ink-muted">{t('commercial.refunds.confirmedAt', { when: formatDateTime(refund.providerConfirmedAt) })}</p>
              )}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-ink-muted">{t('commercial.refunds.bankNote')}</p>
    </section>
  );
}
