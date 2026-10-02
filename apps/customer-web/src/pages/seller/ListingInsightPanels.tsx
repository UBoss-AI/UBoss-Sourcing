/**
 * Two read-only panels on a Seller Hub listing (JOURNEY-028).
 *
 * - Where it may be sold: every country rule the operator has in force that
 *   touches this product, with the operator's reason, plus any certificate
 *   hold that takes it off sale everywhere. A country not listed is open.
 * - What changed: this listing's own entries from the seller's activity log,
 *   newest first, so "who changed the price on Tuesday" has an answer.
 */
import { useQuery } from '@tanstack/react-query';
import { Badge, Card } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatDateTime } from '@/lib/format';
import { countryName } from '@/lib/iso-countries';
import { fetchListingMarketEligibility, fetchSellerAudit, formatMinor } from '@/lib/seller';

export function ListingMarketPanel({ offerId }: { offerId: string }): React.JSX.Element {
  const { t, language } = useI18n();
  const query = useQuery({
    queryKey: ['seller', 'listing-market', offerId],
    queryFn: () => fetchListingMarketEligibility(offerId),
    enabled: offerId !== '',
  });

  return (
    <Card title={t('seller.listingMarket.title')} description={t('seller.listingMarket.intro')} bodyClassName="px-6 py-5">
      {query.isPending ? (
        <p className="text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : query.isError ? (
        <p className="text-sm text-ink-subtle">{t('seller.listingMarket.loadFailed')}</p>
      ) : (
        <div className="space-y-3 text-sm">
          {query.data.status !== 'ACTIVE' && (
            <p className="text-ink-muted">{t('seller.listingMarket.notOnSale')}</p>
          )}
          {query.data.complianceHolds.map((hold) => (
            <p key={hold.certificationId} role="status" className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-danger">
              {t('seller.listingMarket.held', { standard: hold.standard })}
            </p>
          ))}
          {query.data.rules.length === 0 ? (
            <p className="text-ink">{t('seller.listingMarket.open')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {query.data.rules.map((rule, index) => (
                <li key={`${rule.countryCode}-${String(index)}`} className="flex flex-wrap items-start gap-2 py-2">
                  <Badge tone={rule.effect === 'BLOCK' ? 'danger' : 'warning'}>
                    {rule.effect === 'BLOCK' ? t('seller.listingMarket.blocked') : t('seller.listingMarket.documents')}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-ink">{countryName(rule.countryCode, language)}</p>
                    <p className="text-ink-muted">{rule.reason}</p>
                    {rule.requiredDocuments.length > 0 && (
                      <p className="text-xs text-ink-muted">
                        {t('seller.listingMarket.requires', { documents: rule.requiredDocuments.join(', ') })}
                      </p>
                    )}
                    {rule.minOrderValueMinor !== null && rule.thresholdCurrency !== null && (
                      <p className="text-xs text-ink-muted">
                        {t('seller.listingMarket.threshold', {
                          amount: formatMinor(rule.minOrderValueMinor, rule.thresholdCurrency),
                        })}
                      </p>
                    )}
                    {rule.scope === 'CATEGORY' && rule.categoryName !== '' && (
                      <p className="text-xs text-ink-subtle">{t('seller.listingMarket.fromCategory', { category: rule.categoryName })}</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

export function ListingHistoryPanel({ offerId }: { offerId: string }): React.JSX.Element {
  const { t } = useI18n();
  const query = useQuery({
    queryKey: ['seller', 'listing-history', offerId],
    queryFn: () => fetchSellerAudit(50, offerId),
    enabled: offerId !== '',
    // A member without the activity-log permission is refused; that is not a fault to retry.
    retry: false,
  });

  return (
    <Card title={t('seller.listingHistory.title')} description={t('seller.listingHistory.intro')} bodyClassName="px-6 py-5">
      {query.isPending ? (
        <p className="text-sm text-ink-subtle">{t('common.loading')}</p>
      ) : query.isError ? (
        <p className="text-sm text-ink-subtle">{t('seller.listingHistory.loadFailed')}</p>
      ) : query.data.entries.length === 0 ? (
        <p className="text-sm text-ink-muted">{t('seller.listingHistory.empty')}</p>
      ) : (
        <ol className="divide-y divide-border-subtle text-sm">
          {query.data.entries.map((entry) => (
            <li key={entry.id} className="py-2">
              <p className="text-ink">{entry.summary ?? entry.action}</p>
              <p className="text-xs text-ink-muted">
                {formatDateTime(entry.createdAt)} · {entry.actorLabel}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
