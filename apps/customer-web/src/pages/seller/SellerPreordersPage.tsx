/**
 * Seller Hub -> Orders -> Preorders.
 *
 * Bulk requests that are not orders yet. The default view is the one that
 * needs the seller - requests awaiting their answer - because a request left
 * unanswered EXPIRES and the buyer goes elsewhere. The filters are the
 * server's own groupings, and so are the counts beside them.
 */
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PreorderStatusBadge } from '@/components/preorder/PreorderParts';
import { Card, EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatIsoDate } from '@/lib/calendar-date';
import { cx } from '@/lib/cx';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { SELLER_PREORDER_FILTERS, fetchSellerPreorders, type SellerPreorderFilter } from '@/lib/preorders';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

export function SellerPreordersPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();
  const { t, intlLocale } = useI18n();
  const [params, setParams] = useSearchParams();

  const raw = params.get('filter');
  const filter: SellerPreorderFilter | null =
    raw === 'all' ? null : ((SELLER_PREORDER_FILTERS as readonly string[]).includes(raw ?? '') ? (raw as SellerPreorderFilter) : 'awaiting_seller');

  const query = useQuery({
    queryKey: ['seller', 'preorders', filter ?? 'all'],
    queryFn: () => fetchSellerPreorders(filter),
    enabled: seller.isTrading,
    refetchInterval: 60_000,
  });

  if (!seller.isTrading) return <ApprovalRequiredNotice seller={seller} />;

  return (
    <>
      <PageHeader title={t('sellerPreorders.title')} description={t('sellerPreorders.description')} />

      <div role="tablist" aria-label={t('sellerPreorders.filters')} className="mb-4 flex flex-wrap gap-2">
        {[...SELLER_PREORDER_FILTERS, 'all' as const].map((key) => {
          const selected = (filter ?? 'all') === key;
          const count = key === 'all' ? null : (query.data?.counts[key] ?? null);
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => {
                const next = new URLSearchParams(params);
                next.set('filter', key);
                setParams(next, { replace: true });
              }}
              className={cx(
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
                selected
                  ? 'border-brand bg-brand/10 font-semibold text-brand'
                  : 'border-border bg-surface text-ink hover:border-border-hover',
              )}
            >
              {t(`sellerPreorders.filter.${key}` as TranslationKey)}
              {count !== null && count > 0 && (
                <span className="rounded-full bg-surface-sunken px-1.5 text-xxs tabular-nums text-ink-muted">
                  {formatNumber(count)}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {query.isPending ? (
        <LoadingState label={t('sellerPreorders.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.preorders.length === 0 ? (
        <EmptyState title={t('sellerPreorders.empty')} description={t('sellerPreorders.emptyBody')} />
      ) : (
        <Card bodyClassName="p-0">
          <ul className="divide-y divide-border-subtle">
            {query.data.preorders.map((preorder) => (
              <li key={preorder.id}>
                <Link
                  to={`/seller/preorders/${preorder.id}`}
                  className="flex flex-col gap-2 px-4 py-3 hover:bg-surface-sunken sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">{preorder.productName}</p>
                    <p className="text-xs text-ink-muted">
                      {preorder.requestNumber} · {preorder.buyerOrganization}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
                    <span className="tabular-nums text-ink">
                      {t('sellerPreorders.pieces', { pieces: formatNumber(preorder.baseUnits) })}
                    </span>
                    <span className="text-ink-muted">
                      {formatIsoDate(preorder.committedDeliveryDate ?? preorder.requestedDeliveryDate, intlLocale, {
                        dateStyle: 'medium',
                      })}
                    </span>
                    {preorder.value !== null && (
                      <span className="tabular-nums text-ink">{formatMoney(preorder.value)}</span>
                    )}
                    <PreorderStatusBadge status={preorder.status} />
                    {(preorder.status === 'SUBMITTED' || preorder.status === 'SELLER_REVIEW_REQUIRED') &&
                      preorder.expiresAt !== null && (
                        <span className="text-xs font-medium text-warning">
                          {t('sellerPreorders.answerBy', { date: formatDateTime(preorder.expiresAt) })}
                        </span>
                      )}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
