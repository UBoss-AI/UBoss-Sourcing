/**
 * What this order paid for delivery, level by level, and where each level is.
 *
 * Read from the order's own frozen record (`/orders/:id/price-breakdown`),
 * never from today's prices: a seller who changed a price last week does not
 * change what this buyer was charged. Nothing is drawn for an order that was
 * not priced on four levels.
 */
import { useQuery } from '@tanstack/react-query';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { api } from '@/lib/api';
import { formatMoney, type Money } from '@/lib/format';

interface Breakdown {
  currency: string;
  sellerDelivery: Money;
  showLevels: boolean;
  sellers: {
    sellerName: string;
    total: Money;
    levels: {
      level: 'L1' | 'L2' | 'L3' | 'L4';
      amount: Money | null;
      isFree: boolean;
      progress: {
        status: string;
        carrier: string | null;
        trackingNumber: string | null;
      } | null;
    }[];
  }[];
}

export function OrderDeliveryLevels({ orderId }: { orderId: string }): React.JSX.Element | null {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['order', orderId, 'price-breakdown'],
    queryFn: () => api.get<{ breakdown: Breakdown }>(`/orders/${orderId}/price-breakdown`),
  });

  const breakdown = query.data?.breakdown;
  if (breakdown === undefined || breakdown.sellers.length === 0) return null;

  return (
    <div className="space-y-2 rounded-md border border-border-subtle bg-surface-sunken px-3 py-3 text-sm" aria-label={t('delivery.breakdownLabel')}>
      {breakdown.sellers.map((seller) => (
        <div key={seller.sellerName} className="space-y-1.5">
          {breakdown.sellers.length > 1 && <p className="text-xs font-semibold text-ink">{seller.sellerName}</p>}
          {seller.levels.map((level) => (
            <div key={level.level} className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span className="text-ink-muted">
                {level.level} — {t(`delivery.level.${level.level}`)}
                {level.progress !== null && (
                  <span className="ml-1 text-xxs">
                    · {t(`delivery.progress.${level.progress.status}` as TranslationKey)}
                    {level.progress.carrier !== null && ` · ${level.progress.carrier}`}
                    {level.progress.trackingNumber !== null && ` · ${level.progress.trackingNumber}`}
                  </span>
                )}
              </span>
              {breakdown.showLevels && (
                <span className="text-ink">
                  {level.isFree ? t('delivery.free') : level.amount === null ? '' : formatMoney(level.amount)}
                </span>
              )}
            </div>
          ))}
          <div className="flex items-baseline justify-between gap-3 border-t border-border-subtle pt-1.5 font-medium">
            <span className="text-ink">{t('delivery.totalCharges')}</span>
            <span className="text-ink">{formatMoney(seller.total)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}
