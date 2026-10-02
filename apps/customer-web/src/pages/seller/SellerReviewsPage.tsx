/**
 * Seller Hub -> Reviews (checklist JOURNEY-059).
 *
 * What buyers said about this seller's sales: the service score (delivery and
 * support, across every published review of goods it sold), each review with
 * its four scores, and the seller's own public answer under it.
 *
 * A seller may write one answer per review and edit it, up to 1000
 * characters. It is published at once, signed with the seller's trading name.
 * Staff can hide an answer that breaks the rules; the seller then sees it
 * marked hidden, with the reason, and editing it does not republish it. The
 * scores are never the seller's to touch.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { useToast } from '@/components/toast-context';
import { Badge, Button, Card, EmptyState, ErrorState, Field, LoadingState, PageHeader, Textarea } from '@/components/ui';
import { StarRating } from '@/components/ui/star-rating';
import { useI18n } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDate, formatNumber } from '@/lib/format';
import {
  RATING_CATEGORIES,
  RATING_CATEGORY_KEYS,
  SELLER_RESPONSE_MAX_LENGTH,
  fetchSellerReviews,
  formatRating,
  saveSellerResponse,
  type SellerReview,
} from '@/lib/ratings';

const sellerReviewKeys = { list: (page: number) => ['seller-product-reviews', page] as const };

export function SellerReviewsPage(): React.JSX.Element {
  const { t } = useI18n();
  const { features } = useStorefront();
  const [page, setPage] = useState(1);
  const enabled = features.productReviews === true;
  const query = useQuery({
    queryKey: sellerReviewKeys.list(page),
    queryFn: () => fetchSellerReviews(page),
    enabled,
  });

  if (!enabled) {
    return (
      <>
        <PageHeader title={t('sellerReviews.title')} />
        <EmptyState title={t('sellerReviews.offTitle')} description={t('sellerReviews.offBody')} />
      </>
    );
  }

  return (
    <>
      <PageHeader title={t('sellerReviews.title')} description={t('sellerReviews.description')} />
      {query.isPending ? (
        <LoadingState />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <div className="space-y-4">
          <Card bodyClassName="px-5 py-4">
            <p className="text-sm font-medium text-ink">{t('sellerReviews.scoreTitle')}</p>
            {query.data.score === null ? (
              <p className="mt-1 text-sm text-ink-muted">{t('sellerReviews.noScore')}</p>
            ) : (
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-3xl font-semibold tabular-nums text-ink">{formatRating(query.data.score.average)}</span>
                <StarRating readOnly size="md" value={query.data.score.average} label={t('sellerReviews.scoreTitle')} />
                <span className="text-sm text-ink-muted">
                  {t('sellerReviews.scoreBasis', { reviews: formatNumber(query.data.score.count) })}
                </span>
              </div>
            )}
            <p className="mt-2 text-xs text-ink-muted">{t('sellerReviews.scoreMeaning')}</p>
          </Card>

          {query.data.reviews.length === 0 ? (
            <EmptyState title={t('sellerReviews.emptyTitle')} description={t('sellerReviews.emptyBody')} />
          ) : (
            <ul className="space-y-3">
              {query.data.reviews.map((review) => (
                <SellerReviewCard key={review.id} review={review} page={page} />
              ))}
            </ul>
          )}

          {query.data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                disabled={page <= 1}
                onClick={() => {
                  setPage((current) => Math.max(1, current - 1));
                }}
              >
                {t('sellerReviews.previous')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                disabled={page >= query.data.pagination.totalPages}
                onClick={() => {
                  setPage((current) => current + 1);
                }}
              >
                {t('sellerReviews.next')}
              </Button>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function SellerReviewCard({ review, page }: { review: SellerReview; page: number }): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(review.response?.body ?? '');

  const save = useMutation({
    mutationFn: (body: string) => saveSellerResponse(review.id, body),
    onSuccess: async () => {
      toast.success(t('sellerReviews.saved'));
      setEditing(false);
      await queryClient.invalidateQueries({ queryKey: sellerReviewKeys.list(page) });
    },
    onError: (failure) => {
      toast.error(errorMessage(t, failure));
    },
  });

  const trimmed = draft.trim();
  const ready = trimmed.length > 0 && trimmed.length <= SELLER_RESPONSE_MAX_LENGTH && !save.isPending;

  return (
    <li className="rounded-lg border border-border bg-surface px-4 py-4 shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StarRating readOnly size="sm" value={review.average} label={t('rating.average')} showValue />
        <p className="text-sm font-semibold text-ink">
          {review.reviewerName === '' ? t('reviews.anonymous') : review.reviewerName}
        </p>
        <Link to={`/product/${review.product.slug}`} className="text-sm text-brand hover:underline">
          {review.product.name}
        </Link>
        <p className="ml-auto text-xs text-ink-subtle">
          <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
        </p>
      </div>

      <dl className="mt-3 flex flex-wrap gap-2">
        {RATING_CATEGORIES.map((category) => (
          <div
            key={category}
            className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1 text-xs ring-1 ring-inset ring-border"
          >
            <dt className="text-ink-muted">{t(RATING_CATEGORY_KEYS[category].label)}</dt>
            <dd className="font-semibold tabular-nums text-ink">{formatNumber(review.scores[category])}</dd>
          </div>
        ))}
      </dl>

      {review.response !== null && !editing && (
        <div className="mt-3 rounded-md border-l-2 border-brand/40 bg-surface-sunken/60 px-3 py-2 text-sm">
          <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-ink-muted">
            {t('sellerReviews.yourResponse')}
            {review.response.status === 'HIDDEN' && <Badge tone="warning">{t('sellerReviews.hidden')}</Badge>}
          </p>
          <p className="mt-1 whitespace-pre-line text-ink [overflow-wrap:anywhere]">{review.response.body}</p>
          {review.response.status === 'HIDDEN' && review.response.hiddenReason !== null && (
            <p className="mt-1 text-xs text-warning">
              {t('sellerReviews.hiddenReason', { reason: review.response.hiddenReason })}
            </p>
          )}
        </div>
      )}

      {editing ? (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save.mutate(trimmed);
          }}
        >
          <Field label={t('sellerReviews.responseLabel')} hint={t('sellerReviews.responseHint')} required>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={4}
                maxLength={SELLER_RESPONSE_MAX_LENGTH}
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                }}
              />
            )}
          </Field>
          <p className="text-xs text-ink-subtle tabular-nums">
            {t('sellerReviews.counter', {
              used: formatNumber(draft.length),
              max: formatNumber(SELLER_RESPONSE_MAX_LENGTH),
            })}
          </p>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!ready} isLoading={save.isPending}>
              {t('sellerReviews.publish')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setEditing(false);
                setDraft(review.response?.body ?? '');
              }}
            >
              {t('sellerReviews.cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          className="mt-3"
          size="sm"
          variant="secondary"
          onClick={() => {
            setEditing(true);
          }}
        >
          {review.response === null ? t('sellerReviews.respond') : t('sellerReviews.editResponse')}
        </Button>
      )}
    </li>
  );
}
