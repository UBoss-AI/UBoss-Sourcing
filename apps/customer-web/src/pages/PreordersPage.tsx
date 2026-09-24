/**
 * Your preorders: every bulk request sent to a seller, and where each stands.
 *
 * The list says whose turn it is. A preorder waiting on the buyer - the seller
 * has answered - is the one row on this page that needs doing something about,
 * and it carries the time the seller's terms run out.
 */
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { PageEmptyState } from '@/components/PageEmptyState';
import { ChevronRightIcon } from '@/components/icons';
import { PreorderStatusBadge } from '@/components/preorder/PreorderParts';
import { ButtonLink, ErrorState, LoadingState, PageHeader } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatIsoDate } from '@/lib/calendar-date';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { fetchMyPreorders } from '@/lib/preorders';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

const WAITING_ON_BUYER = new Set(['SELLER_ACCEPTED', 'SELLER_COUNTERED', 'PAYMENT_REQUIRED']);

export function PreordersPage(): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const { business } = useStorefront();

  useDocumentMeta({ title: t('preorder.myPreorders'), noIndex: true }, business.displayName);

  const query = useQuery({ queryKey: ['preorders'], queryFn: fetchMyPreorders });

  if (query.isPending) return <LoadingState label={t('preorder.loading')} />;
  if (query.isError) {
    return (
      <ErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.data.length === 0) {
    return (
      <PageEmptyState
        title={t('preorder.noneYet')}
        description={t('preorder.noneYetBody')}
        action={
          <ButtonLink to="/products" variant="primary" size="lg">
            {t('preorder.browse')}
          </ButtonLink>
        }
      />
    );
  }

  return (
    <>
      <PageHeader title={t('preorder.myPreorders')} description={t('preorder.myPreordersBody')} />
      <ul className="space-y-3">
        {query.data.map((preorder) => (
          <li key={preorder.id}>
            <Link
              to={`/account/preorders/${preorder.id}`}
              className="group block rounded-lg border border-border bg-surface p-4 shadow-card transition-[box-shadow,border-color] hover:border-border-hover hover:shadow-card-hover"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 text-title-xs text-ink">
                    {preorder.productName}
                    <ChevronRightIcon className="h-4 w-4 text-ink-subtle transition-transform group-hover:translate-x-0.5" />
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    {preorder.requestNumber} · {preorder.sellerName}
                  </p>
                </div>
                <PreorderStatusBadge status={preorder.status} />
              </div>
              <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-2 border-t border-border-subtle pt-3 text-sm">
                <div>
                  <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('preorder.pieces')}</dt>
                  <dd className="mt-0.5 text-ink tabular-nums">{formatNumber(preorder.baseUnits)}</dd>
                </div>
                <div>
                  <dt className="text-xxs uppercase tracking-wider text-ink-subtle">
                    {preorder.committedDeliveryDate === null ? t('preorder.requestedDate') : t('preorder.committedDate')}
                  </dt>
                  <dd className="mt-0.5 text-ink">
                    {formatIsoDate(preorder.committedDeliveryDate ?? preorder.requestedDeliveryDate, intlLocale, {
                      dateStyle: 'medium',
                    })}
                  </dd>
                </div>
                {preorder.value !== null && (
                  <div>
                    <dt className="text-xxs uppercase tracking-wider text-ink-subtle">{t('preorder.value')}</dt>
                    <dd className="mt-0.5 text-ink tabular-nums">{formatMoney(preorder.value)}</dd>
                  </div>
                )}
              </dl>
              {WAITING_ON_BUYER.has(preorder.status) && preorder.expiresAt !== null && (
                <p className="mt-2 text-xs font-medium text-warning">
                  {t('preorder.yourTurnUntil', { date: formatDateTime(preorder.expiresAt) })}
                </p>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
