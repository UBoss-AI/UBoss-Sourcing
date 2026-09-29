/**
 * Seller Hub -> Requests for quotation: the requests this seller was asked to
 * quote on, and nothing else. The default view is the one that needs an
 * answer before its deadline.
 */
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { InvitationStatusBadge, RfqStatusBadge } from '@/components/rfq/RfqParts';
import { EmptyState, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { cx } from '@/lib/cx';
import { formatNumber } from '@/lib/format';
import { countryName } from '@/lib/iso-countries';
import { formatUtc, useQuantityLabel } from '@/lib/rfq-format';
import { SELLER_RFQ_FILTERS, fetchSellerRfqs, type SellerRfqFilter } from '@/lib/rfq-seller';
import { ApprovalRequiredNotice, type SellerOutletContext } from './SellerLayout';

export function SellerRfqsPage(): React.JSX.Element {
  const seller = useOutletContext<SellerOutletContext>();
  const { t, intlLocale, language } = useI18n();
  const quantityLabel = useQuantityLabel();
  const [params, setParams] = useSearchParams();
  const raw = params.get('filter');
  const filter: SellerRfqFilter = (SELLER_RFQ_FILTERS as readonly string[]).includes(raw ?? '')
    ? (raw as SellerRfqFilter)
    : 'action';

  const query = useQuery({
    queryKey: ['seller', 'rfqs', filter],
    queryFn: () => fetchSellerRfqs(filter),
    enabled: seller.isTrading,
    refetchInterval: 60_000,
  });

  if (!seller.isTrading) return <ApprovalRequiredNotice seller={seller} />;

  return (
    <>
      <PageHeader title={t('sellerRfq.title')} description={t('sellerRfq.description')} />
      <div role="group" aria-label={t('sellerRfq.filters')} className="mb-4 flex flex-wrap gap-2">
        {SELLER_RFQ_FILTERS.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => {
              const next = new URLSearchParams(params);
              next.set('filter', key);
              setParams(next, { replace: true });
            }}
            className={cx(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors',
              filter === key ? 'border-brand bg-brand/10 font-semibold text-brand' : 'border-border bg-surface text-ink hover:border-border-hover',
            )}
          >
            {t(`sellerRfq.filter.${key}` as TranslationKey)}
            {(query.data?.counts[key] ?? 0) > 0 && (
              <span className="rounded-full bg-surface-sunken px-1.5 text-xxs tabular-nums text-ink-muted">
                {formatNumber(query.data?.counts[key] ?? 0)}
              </span>
            )}
          </button>
        ))}
      </div>

      {query.isPending ? (
        <LoadingState label={t('sellerRfq.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.items.length === 0 ? (
        <EmptyState title={t('sellerRfq.emptyTitle')} description={t('sellerRfq.emptyBody')} />
      ) : (
        <ul className="space-y-3">
          {query.data.items.map((item) => (
            <li key={item.id}>
              <Link
                to={`/seller/rfqs/${item.id}`}
                className="block rounded-lg border border-border bg-surface p-4 shadow-card hover:border-border-hover"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-title-xs text-ink">{item.title}</p>
                    <p className="text-xs text-ink-muted">
                      {item.reference}
                      {item.categoryName !== null && ` · ${item.categoryName}`}
                      {` · ${t('rfq.detail.versionN', { version: String(item.currentRequirementVersion) })}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <RfqStatusBadge status={item.status} />
                    <InvitationStatusBadge status={item.invitationStatus} />
                  </div>
                </div>
                <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-border-subtle pt-3 text-sm">
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.quantity')}</dt>
                    <dd className="text-ink">{quantityLabel(item.quantity, item.unitOfMeasure)}</dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.destination')}</dt>
                    <dd className="text-ink">{item.destinationCountry === null ? t('rfq.notProvided') : countryName(item.destinationCountry, language)}</dd>
                  </div>
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('rfq.field.deadline')}</dt>
                    <dd className={item.isPastDeadline ? 'text-warning' : 'text-ink'}>{formatUtc(item.responseDeadline, intlLocale)}</dd>
                  </div>
                </dl>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
