/**
 * Seller Hub -> Payments: the fee rules that can change this seller's fee
 * (checklist JOURNEY-054, "no retroactive surprise").
 *
 * Read-only. Lists the published rules live now and the ones starting later,
 * so a seller sees a fee change before it reaches them. A rule only ever
 * applies to orders confirmed after it starts; an order already settled keeps
 * the fee it was given. Never shows another seller's own rule.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card, EmptyState, ErrorState, LoadingState } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { fetchSellerFeeRules, type SellerFeeRule } from '@/lib/finance';
import { formatDate, formatMoney } from '@/lib/format';

export function SellerFeeRulesCard(): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({ queryKey: ['seller', 'fee-rules'], queryFn: fetchSellerFeeRules });

  function terms(rule: SellerFeeRule): string {
    const rate = rule.percentRate ?? '';
    switch (rule.kind) {
      case 'VALUE_BAND':
        return rule.maxValue === null
          ? t('seller.feeRules.terms.VALUE_BAND_OPEN', { from: formatMoney(rule.minValue), rate })
          : t('seller.feeRules.terms.VALUE_BAND', { from: formatMoney(rule.minValue), to: formatMoney(rule.maxValue), rate });
      case 'VOLUME_TIER':
        return t('seller.feeRules.terms.VOLUME_TIER', {
          threshold: formatMoney(rule.volumeThreshold),
          days: String(rule.volumeWindowDays ?? ''),
          rate,
        });
      case 'SELLER_TIER':
        return t('seller.feeRules.terms.SELLER_TIER', { tier: rule.sellerTier ?? '', rate });
      case 'PROMOTION':
        return t('seller.feeRules.terms.PROMOTION', { discount: rule.discountPercent ?? '' });
    }
  }

  function where(rule: SellerFeeRule): string {
    if (rule.scope === 'MARKET') return t('seller.feeRules.where.MARKET', { market: rule.marketCountry ?? '' });
    if (rule.scope === 'CATEGORY') return t('seller.feeRules.where.CATEGORY', { category: rule.categoryName ?? '' });
    return t(`seller.feeRules.where.${rule.scope}` as TranslationKey);
  }

  return (
    <Card title={t('seller.feeRules.title')} description={t('seller.feeRules.intro')}>
      {query.isPending && <LoadingState label={t('seller.feeRules.loading')} />}
      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}
      {query.data !== undefined && (
        <div className="space-y-3">
          <p className="text-sm text-ink-muted">
            {query.data.feeTier === null
              ? t('seller.feeRules.noTier')
              : t('seller.feeRules.yourTier', { tier: query.data.feeTier })}
          </p>
          {query.data.rules.length === 0 ? (
            <EmptyState title={t('seller.feeRules.emptyTitle')} description={t('seller.feeRules.emptyBody')} />
          ) : (
            <ul className="divide-y divide-border-subtle" aria-label={t('seller.feeRules.title')}>
              {query.data.rules.map((rule) => (
                <li key={rule.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="text-sm font-medium text-ink">{rule.name}</p>
                    <p className="text-sm text-ink-muted">
                      {terms(rule)} · {where(rule)}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {rule.effectiveTo === null
                        ? t('seller.feeRules.from', { from: formatDate(rule.effectiveFrom) })
                        : t('seller.feeRules.fromTo', {
                            from: formatDate(rule.effectiveFrom),
                            to: formatDate(rule.effectiveTo),
                          })}
                    </p>
                  </div>
                  <Badge tone={rule.upcoming ? 'warning' : 'success'}>
                    {rule.upcoming ? t('seller.feeRules.upcoming') : t('seller.feeRules.live')}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-ink-muted">{t('seller.feeRules.noRetroactive')}</p>
        </div>
      )}
    </Card>
  );
}
