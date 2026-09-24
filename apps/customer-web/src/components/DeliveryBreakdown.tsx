/**
 * What delivery costs, level by level, as the buyer is shown it.
 *
 *   L1 - First-mile delivery
 *   L2 - International transport
 *   L3 - Destination inland transport
 *   L4 - Last-mile delivery
 *   Total delivery charges
 *
 * Every figure is the server's; this component never adds anything up. When
 * the operator has chosen to show one delivery line instead of four, the
 * server sends no per-level amounts and only the total is drawn - the order
 * still keeps every level either way.
 *
 * A level with no price for this address is drawn as "Quote required", never
 * as zero, and the checkout button is held by the server's `checkoutReady`.
 */
import { useI18n } from '@/i18n/i18n-context';
import { formatMoneyMinor } from '@/lib/format';
import type { DeliveryQuote } from '@/lib/types';

export function DeliveryBreakdown({ delivery }: { delivery: DeliveryQuote }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <div className="space-y-3 rounded-md border border-border-subtle bg-surface-sunken px-3 py-3 text-sm" aria-label={t('delivery.breakdownLabel')}>
      {delivery.sellers.map((seller) => (
        <div key={seller.sellerAccountId} className="space-y-1.5">
          {delivery.sellers.length > 1 && <p className="text-xs font-semibold text-ink">{seller.sellerName}</p>}
          {delivery.showLevels &&
            seller.levels.map((level) => (
              <div key={level.level} className="flex items-baseline justify-between gap-3">
                <span className="text-ink-muted">
                  {level.level} — {t(`delivery.level.${level.level}`)}
                  {level.transitDaysMin !== null && level.transitDaysMax !== null && (
                    <span className="ml-1 text-xxs">
                      ({t('delivery.transitDays', { min: String(level.transitDaysMin), max: String(level.transitDaysMax) })})
                    </span>
                  )}
                </span>
                <span className={level.amount === null ? 'text-warning' : 'text-ink'}>
                  {level.amount === null
                    ? t('delivery.quoteRequired')
                    : level.isFree
                      ? t('delivery.free')
                      : formatMoneyMinor(level.amount, delivery.currency)}
                </span>
              </div>
            ))}
          <div className="flex items-baseline justify-between gap-3 border-t border-border-subtle pt-1.5 font-medium">
            <span className="text-ink">{t('delivery.totalCharges')}</span>
            <span className={seller.total === null ? 'text-warning' : 'text-ink'}>
              {seller.total === null ? t('delivery.quoteRequired') : formatMoneyMinor(seller.total, delivery.currency)}
            </span>
          </div>
          {seller.status === 'QUOTE_REQUIRED' && (
            <p role="status" className="text-xs text-warning">
              {t('delivery.quoteRequiredBody', { seller: seller.sellerName })}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}
