/**
 * "My reviews": what you have received but not rated yet, and what you wrote.
 *
 * Two panels, the waiting list first. The reviews a buyer most wants to write
 * are the ones about something that just arrived, and a list of those is the
 * nudge that turns "I should say something about that" into a review. Each
 * row opens the same dialog the product page and the order page open.
 *
 * A review staff have hidden says so here, with the reason they gave, so the
 * buyer is not left wondering why it is missing from the product page.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { ReviewDialog } from '@/components/reviews/ReviewDialog';
import {
  Badge,
  Button,
  ButtonLink,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
} from '@/components/ui';
import { BoxIcon } from '@/components/icons';
import { StarRating } from '@/components/ui/star-rating';
import { formatDate, formatNumber } from '@/lib/format';
import {
  RATING_CATEGORIES,
  RATING_CATEGORY_KEYS,
  fetchMyReviews,
  reviewKeys,
} from '@/lib/ratings';
import { useDocumentMeta } from '@/lib/useDocumentMeta';
import { useI18n } from '@/i18n/i18n-context';
import { AccountPanel } from './AccountPanel';

function ProductThumb({ imageUrl }: { imageUrl: string | null }): React.JSX.Element {
  return imageUrl === null ? (
    <span
      aria-hidden="true"
      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md bg-brand-soft text-brand ring-1 ring-inset ring-brand/15"
    >
      <BoxIcon className="h-5 w-5" />
    </span>
  ) : (
    <img
      src={imageUrl}
      alt=""
      width={56}
      height={56}
      loading="lazy"
      className="h-14 w-14 shrink-0 rounded-md border border-border bg-surface-media object-contain p-1"
    />
  );
}

export function MyReviewsPage(): React.JSX.Element {
  const { t, language } = useI18n();
  const { business, features } = useStorefront();
  const { isCustomer } = useSession();
  const [reviewing, setReviewing] = useState<{ productId: string; name: string } | null>(null);

  useDocumentMeta({ title: t('account.nav.reviews'), noIndex: true }, business.displayName);

  const query = useQuery({
    queryKey: reviewKeys.mine(language),
    queryFn: () => fetchMyReviews(language),
    enabled: isCustomer && features.productReviews === true,
  });

  if (features.productReviews !== true) {
    return (
      <>
        <PageHeader title={t('account.nav.reviews')} />
        <EmptyState title={t('reviews.disabledTitle')} description={t('reviews.disabledBody')} />
      </>
    );
  }

  if (query.isPending) return <LoadingState label={t('reviews.loading')} />;

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

  const { reviews, awaiting } = query.data;

  return (
    <>
      <PageHeader title={t('account.nav.reviews')} description={t('reviews.mine.description')} />

      <div className="space-y-6">
        <AccountPanel title={t('reviews.mine.awaitingHeading')}>
          {awaiting.length === 0 ? (
            <p className="text-sm text-ink-muted">{t('reviews.mine.awaitingEmpty')}</p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {awaiting.map((item) => (
                <li
                  key={item.productId}
                  className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3 first:pt-0 last:pb-0"
                >
                  <ProductThumb imageUrl={item.imageUrl} />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/product/${item.productSlug}`}
                      className="text-sm font-medium text-ink hover:text-brand hover:underline"
                    >
                      {item.productName}
                    </Link>
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {t('reviews.mine.fromOrder', {
                        order: item.orderNumber,
                        date: formatDate(item.orderedAt),
                      })}
                    </p>
                  </div>
                  <Button
                    variant="action"
                    size="sm"
                    onClick={() => {
                      setReviewing({ productId: item.productId, name: item.productName });
                    }}
                  >
                    <span aria-hidden="true">★</span>
                    {t('reviews.rateThisProduct')}
                    <span className="sr-only"> {item.productName}</span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </AccountPanel>

        <AccountPanel title={t('reviews.mine.writtenHeading')}>
          {reviews.length === 0 ? (
            <EmptyState
              title={t('reviews.mine.writtenEmptyTitle')}
              description={t('reviews.mine.writtenEmptyBody')}
              action={
                <ButtonLink to="/account/orders" variant="secondary">
                  {t('account.nav.myOrders')}
                </ButtonLink>
              }
            />
          ) : (
            <ul className="divide-y divide-border-subtle">
              {reviews.map((review) => {
                const average =
                  (review.scores.quality +
                    review.scores.delivery +
                    review.scores.experience +
                    review.scores.support) /
                  4;

                return (
                  <li key={review.id} className="flex flex-wrap gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0">
                    <ProductThumb imageUrl={review.imageUrl} />

                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2">
                        <Link
                          to={`/product/${review.productSlug}`}
                          className="text-sm font-medium text-ink hover:text-brand hover:underline"
                        >
                          {review.productName}
                        </Link>
                        {review.status === 'HIDDEN' && (
                          <Badge tone="warning">{t('reviews.status.hidden')}</Badge>
                        )}
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                        <StarRating
                          readOnly
                          size="sm"
                          showValue
                          value={average}
                          label={t('rating.average')}
                        />
                        <span className="text-xs text-ink-subtle">
                          {t('reviews.mine.updatedOn', { date: formatDate(review.updatedAt) })}
                        </span>
                      </div>

                      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                        {RATING_CATEGORIES.map((category) => (
                          <div key={category} className="flex items-center gap-1">
                            <dt className="text-ink-muted">{t(RATING_CATEGORY_KEYS[category].label)}</dt>
                            <dd className="font-semibold tabular-nums text-ink">
                              {formatNumber(review.scores[category])}/5
                            </dd>
                          </div>
                        ))}
                      </dl>

                      {review.status === 'HIDDEN' && review.moderationReason !== null && (
                        <p className="mt-2 rounded-md bg-warning-soft px-2.5 py-1.5 text-xs text-warning">
                          {t('reviews.hiddenReason', { reason: review.moderationReason })}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0">
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          setReviewing({ productId: review.productId, name: review.productName });
                        }}
                      >
                        {t('reviews.edit')}
                        <span className="sr-only"> {review.productName}</span>
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </AccountPanel>
      </div>

      {reviewing !== null && (
        <ReviewDialog
          productId={reviewing.productId}
          productName={reviewing.name}
          onClose={() => {
            setReviewing(null);
          }}
        />
      )}
    </>
  );
}
