/**
 * "Ratings and reviews" at the foot of the product page.
 *
 * Three parts, in the order a buyer reads them:
 *
 *   1. **The summary.** The overall figure, how many reviews it is over, and
 *      how they spread across one to five stars. Then the way to add your
 *      own: a button for somebody who has received the product, a sign-in
 *      link for a guest, and a sentence explaining the rule for a signed-in
 *      buyer who has not received it yet - a missing button with no reason is
 *      a feature that looks broken.
 *   2. **The four categories, in depth.** Quality, delivery, experience and
 *      support as raised columns whose height IS the average out of five, so
 *      "strong product, slow delivery" is visible before a single number is
 *      read. The depth carries the information; the same figures are in text
 *      beside each column for anybody who cannot see it, and the columns stand
 *      still for somebody who has asked for reduced motion.
 *   3. **The reviews.** Newest first by default, ten at a time.
 *
 * Nothing renders when the deployment has reviews switched off.
 */
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { motion } from 'motion/react';
import { useSession } from '@/auth/session-context';
import { useStorefront } from '@/app/storefront-context';
import { Badge, Button, ErrorState, Select } from '@/components/ui';
import { StarRating } from '@/components/ui/star-rating';
import { cx } from '@/lib/cx';
import { formatDate, formatNumber } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/reduced-motion';
import {
  RATING_CATEGORIES,
  RATING_CATEGORY_KEYS,
  fetchOwnReview,
  fetchPublicReviews,
  formatRating,
  reviewKeys,
  type InspectionSummary,
  type PublicReview,
  type RatingSummary,
  type ReviewSort,
} from '@/lib/ratings';
import { useI18n } from '@/i18n/i18n-context';
import { ReviewDialog } from './ReviewDialog';

const PAGE_SIZE = 10;

export function ProductReviews({
  productId,
  productSlug,
  productName,
  inspection = null,
}: {
  productId: string;
  productSlug: string;
  productName: string;
  /**
   * The listed seller's signed inspections (JOURNEY-059). Drawn in its own
   * box beside the ratings and never averaged into them: an inspection is a
   * measured check of a consignment, a rating is a buyer's opinion.
   */
  inspection?: InspectionSummary | null;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const { features } = useStorefront();
  const [sort, setSort] = useState<ReviewSort>('recent');
  const [dialogOpen, setDialogOpen] = useState(false);
  const enabled = features.productReviews === true;

  const list = useInfiniteQuery({
    queryKey: [...reviewKeys.all, 'public', productSlug, sort],
    queryFn: ({ pageParam }) =>
      fetchPublicReviews(productSlug, { page: pageParam, sort, limit: PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.pagination.page < last.pagination.totalPages ? last.pagination.page + 1 : undefined,
    enabled,
  });

  if (!enabled) return null;

  const first = list.data?.pages[0];
  const summary = first?.summary ?? null;
  const reviews = list.data?.pages.flatMap((page) => page.reviews) ?? [];

  return (
    <section id="reviews" aria-labelledby="reviews-heading" className="mt-12 scroll-mt-24">
      <h2 id="reviews-heading" className="text-title-sm text-ink sm:text-title">
        {t('reviews.heading')}
      </h2>

      {list.isError ? (
        <div className="mt-4">
          <ErrorState
            error={list.error}
            onRetry={() => {
              void list.refetch();
            }}
          />
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)] lg:gap-8">
          <div className="space-y-5">
            <SummaryCard summary={summary} loading={list.isPending} />
            {inspection !== null && <InspectionResultsCard inspection={inspection} />}
            <WriteReviewPrompt
              productId={productId}
              onOpen={() => {
                setDialogOpen(true);
              }}
            />
          </div>

          <div className="min-w-0 space-y-6">
            {summary !== null && <CategoryColumns summary={summary} />}

            {summary !== null && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-ink-muted">
                  {t('reviews.showingCount', { count: first?.pagination.total ?? 0 })}
                </p>
                <label className="flex items-center gap-2 whitespace-nowrap text-sm text-ink-muted">
                  {t('reviews.sortLabel')}
                  <Select
                    value={sort}
                    className="w-auto"
                    onChange={(event) => {
                      setSort(event.target.value as ReviewSort);
                    }}
                  >
                    <option value="recent">{t('reviews.sort.recent')}</option>
                    <option value="highest">{t('reviews.sort.highest')}</option>
                    <option value="lowest">{t('reviews.sort.lowest')}</option>
                  </Select>
                </label>
              </div>
            )}

            {reviews.length > 0 && (
              <ul className="space-y-3">
                {reviews.map((review) => (
                  <ReviewCard key={review.id} review={review} />
                ))}
              </ul>
            )}

            {list.hasNextPage && (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  isLoading={list.isFetchingNextPage}
                  onClick={() => {
                    void list.fetchNextPage();
                  }}
                >
                  {t('reviews.showMore')}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}

      {dialogOpen && (
        <ReviewDialog
          productId={productId}
          productName={productName}
          onClose={() => {
            setDialogOpen(false);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function SummaryCard({
  summary,
  loading,
}: {
  summary: RatingSummary | null;
  loading: boolean;
}): React.JSX.Element {
  const { t } = useI18n();

  if (loading) {
    return (
      <div
        aria-busy="true"
        className="h-56 animate-pulse rounded-lg border border-border bg-surface-sunken motion-reduce:animate-none"
      />
    );
  }

  if (summary === null) {
    return (
      <div className="rounded-lg border border-border bg-surface px-5 py-6 shadow-card">
        <StarRating readOnly size="lg" value={0} label={t('rating.average')} />
        <p className="mt-3 text-sm font-medium text-ink">{t('reviews.noneYet')}</p>
        <p className="mt-1 text-sm text-ink-muted">{t('reviews.noneYetBody')}</p>
      </div>
    );
  }

  const largest = Math.max(...summary.distribution, 1);

  return (
    <div className="rounded-lg border border-border bg-surface px-5 py-5 shadow-card">
      <div className="flex items-end gap-3">
        <p className="text-5xl font-semibold leading-none tabular-nums text-ink">
          {formatRating(summary.average)}
        </p>
        <div className="pb-0.5">
          <StarRating readOnly size="md" value={summary.average} label={t('rating.average')} />
          <p className="mt-1 text-xs text-ink-muted">
            {t('reviews.basedOn', { count: summary.count })}
          </p>
        </div>
      </div>

      <ol className="mt-5 space-y-1.5" aria-label={t('reviews.distributionLabel')}>
        {[5, 4, 3, 2, 1].map((star) => {
          const count = summary.distribution[star - 1] ?? 0;
          const width = `${String(Math.round((count / largest) * 100))}%`;
          return (
            <li key={star} className="flex items-center gap-2 text-xs">
              <span aria-hidden="true" className="w-8 shrink-0 tabular-nums text-ink-muted">
                {formatNumber(star)} ★
              </span>
              <span aria-hidden="true" className="h-2 flex-1 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-inset ring-border">
                <span className="block h-full rounded-full bg-rating" style={{ width }} />
              </span>
              <span aria-hidden="true" className="w-8 shrink-0 text-right tabular-nums text-ink-subtle">
                {formatNumber(count)}
              </span>
              <span className="sr-only">
                {t('reviews.distributionRow', { stars: formatNumber(star), count })}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/**
 * The seller's inspection record, in a box of its own.
 *
 * Deliberately not part of the summary card: no star, no average, nothing
 * that could be read as a rating. Passed and failed are counts of signed
 * reports, and the sentence under them says why they are kept apart.
 */
function InspectionResultsCard({ inspection }: { inspection: InspectionSummary }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <section
      aria-labelledby="inspection-results-heading"
      data-testid="inspection-results"
      className="rounded-lg border border-border bg-surface-sunken/60 px-4 py-4 text-sm"
    >
      <h3 id="inspection-results-heading" className="font-medium text-ink">
        {t('reviews.inspection.title')}
      </h3>
      <p className="mt-1 text-ink">
        {t('reviews.inspection.counts', {
          passed: formatNumber(inspection.passed),
          failed: formatNumber(inspection.failed),
          months: formatNumber(inspection.months),
        })}
      </p>
      <p className="mt-2 text-xs text-ink-muted">{t('reviews.inspection.separate')}</p>
    </section>
  );
}

function WriteReviewPrompt({
  productId,
  onOpen,
}: {
  productId: string;
  onOpen: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { isCustomer } = useSession();
  const location = useLocation();

  const own = useQuery({
    queryKey: reviewKeys.own(productId),
    queryFn: () => fetchOwnReview(productId),
    enabled: isCustomer,
  });

  if (!isCustomer) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong px-4 py-4 text-sm">
        <p className="font-medium text-ink">{t('reviews.prompt.title')}</p>
        <p className="mt-1 text-ink-muted">{t('reviews.prompt.guest')}</p>
        <Link
          to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`}
          className="mt-3 inline-block font-medium text-brand hover:underline"
        >
          {t('reviews.prompt.signIn')}
        </Link>
      </div>
    );
  }

  if (own.isPending || own.isError) return <div />;

  if (!own.data.canReview) {
    return (
      <div className="rounded-lg border border-dashed border-border-strong px-4 py-4 text-sm">
        <p className="font-medium text-ink">{t('reviews.prompt.title')}</p>
        <p className="mt-1 text-ink-muted">{t('reviews.notEligible')}</p>
      </div>
    );
  }

  const review = own.data.review;

  return (
    <div className="rounded-lg border border-border bg-surface-sunken/60 px-4 py-4 text-sm">
      <p className="font-medium text-ink">
        {review === null ? t('reviews.prompt.title') : t('reviews.prompt.yours')}
      </p>
      {review === null ? (
        <p className="mt-1 text-ink-muted">{t('reviews.prompt.eligible')}</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <StarRating
            readOnly
            size="sm"
            value={
              (review.scores.quality +
                review.scores.delivery +
                review.scores.experience +
                review.scores.support) /
              4
            }
            label={t('reviews.prompt.yours')}
          />
          {review.status === 'HIDDEN' && <Badge tone="warning">{t('reviews.status.hidden')}</Badge>}
        </div>
      )}
      <Button className="mt-3" variant={review === null ? 'action' : 'secondary'} size="sm" onClick={onOpen}>
        {review === null ? t('reviews.write') : t('reviews.edit')}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The four categories, as raised columns
// ---------------------------------------------------------------------------

/** Tallest column, for a five. The others are in proportion. */
const COLUMN_MAX_PX = 132;
/** How far each column stands out from the page, in pixels. */
const DEPTH_PX = 14;

/**
 * Four isometric columns, one per category, each as tall as its average.
 *
 * Built from three flat faces - the front, a top skewed back and a side
 * skewed up - rather than 3D transforms, so it draws identically in every
 * browser and never needs a GPU layer. A faint full-height column stands
 * behind each one, so a 3.1 reads as "three fifths of the way", not as a
 * short bar with nothing to compare it to.
 *
 * The list items carry the facts in text ("Quality, 4.6 out of 5"); the
 * columns themselves are hidden from assistive technology.
 */
function CategoryColumns({ summary }: { summary: RatingSummary }): React.JSX.Element {
  const { t } = useI18n();
  const reduceMotion = usePrefersReducedMotion();

  return (
    <div className="rounded-lg border border-border bg-surface px-4 pb-4 pt-6 shadow-card sm:px-6">
      <p className="text-sm font-medium text-ink">{t('reviews.byCategory')}</p>
      <ul className="mt-5 grid grid-cols-4 gap-3 sm:gap-6">
        {RATING_CATEGORIES.map((category, index) => {
          const value = summary.categories[category];
          const height = Math.max(4, Math.round((value / 5) * COLUMN_MAX_PX));
          const label = t(RATING_CATEGORY_KEYS[category].label);

          return (
            <li key={category} className="flex min-w-0 flex-col items-center">
              <span className="sr-only">
                {t('reviews.categoryValue', { category: label, value: formatRating(value) })}
              </span>

              <div aria-hidden="true" className="flex w-full flex-col items-center">
                <span className="mb-2 text-sm font-semibold tabular-nums text-ink">
                  {formatRating(value)}
                </span>

                <div
                  className="relative w-10 sm:w-12"
                  style={{ height: COLUMN_MAX_PX + DEPTH_PX, paddingTop: DEPTH_PX }}
                >
                  {/* The full-height ghost: what a five would look like. */}
                  <Column height={COLUMN_MAX_PX} ghost />
                  <motion.div
                    className="absolute bottom-0 left-0 w-full"
                    initial={reduceMotion ? false : { height: 0 }}
                    animate={{ height }}
                    transition={
                      reduceMotion
                        ? { duration: 0 }
                        : { type: 'spring', stiffness: 140, damping: 20, delay: index * 0.08 }
                    }
                  >
                    <Column height="100%" />
                  </motion.div>
                </div>

                <span className="mt-3 w-full truncate text-center text-xs font-medium text-ink">
                  {label}
                </span>
              </div>

              <StarRating
                readOnly
                size="xs"
                value={value}
                label={label}
                className="mt-1 hidden sm:inline-flex"
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Column({ height, ghost = false }: { height: number | string; ghost?: boolean }): React.JSX.Element {
  return (
    <div
      className={cx('absolute bottom-0 left-0 w-full', ghost && 'opacity-60')}
      style={{ height }}
    >
      {/* Top face: skewed back and to the right. */}
      <div
        className={cx(
          'absolute bottom-full left-0 w-full origin-bottom-left',
          ghost ? 'bg-border-subtle' : 'bg-rating brightness-125',
        )}
        style={{ height: DEPTH_PX, transform: 'skewX(-45deg)' }}
      />
      {/* Side face: skewed up, in shadow. */}
      <div
        className={cx(
          'absolute left-full top-0 h-full origin-top-left',
          ghost ? 'bg-border' : 'bg-rating brightness-75',
        )}
        style={{ width: DEPTH_PX, transform: 'skewY(-45deg)' }}
      />
      {/* Front face. */}
      <div
        className={cx(
          'absolute inset-0',
          ghost
            ? 'border border-dashed border-border bg-surface-sunken'
            : 'bg-gradient-to-t from-rating to-rating/80',
        )}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// One review
// ---------------------------------------------------------------------------

function ReviewCard({ review }: { review: PublicReview }): React.JSX.Element {
  const { t } = useI18n();

  return (
    <li className="rounded-lg border border-border bg-surface px-4 py-4 shadow-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <StarRating readOnly size="sm" value={review.average} label={t('rating.average')} showValue />
        <p className="text-sm font-semibold text-ink">
          {review.reviewerName === '' ? t('reviews.anonymous') : review.reviewerName}
        </p>
        <Badge tone="success">{t('reviews.verifiedPurchase')}</Badge>
        <p className="ml-auto text-xs text-ink-subtle">
          <time dateTime={review.createdAt}>{formatDate(review.createdAt)}</time>
          {review.editedAt !== null && ` · ${t('reviews.edited')}`}
        </p>
      </div>

      <dl className="mt-3 flex flex-wrap gap-2">
        {RATING_CATEGORIES.map((category) => (
          <div
            key={category}
            className="inline-flex items-center gap-1.5 rounded-full bg-surface-sunken px-2.5 py-1 text-xs ring-1 ring-inset ring-border"
          >
            <dt className="text-ink-muted">{t(RATING_CATEGORY_KEYS[category].label)}</dt>
            <dd className="flex items-center gap-1 font-semibold tabular-nums text-ink">
              <span aria-hidden="true" className="text-rating">★</span>
              {formatNumber(review.scores[category])}
            </dd>
          </div>
        ))}
      </dl>

      {/* The seller's answer, signed with its trading name. Plain text. */}
      {review.response !== undefined && review.response !== null && (
        <div className="mt-3 rounded-md border-l-2 border-brand/40 bg-surface-sunken/60 px-3 py-2 text-sm">
          <p className="text-xs font-medium text-ink-muted">
            {t('reviews.response.from', { seller: review.response.sellerName })}
            {' · '}
            <time dateTime={review.response.at}>{formatDate(review.response.at)}</time>
          </p>
          <p className="mt-1 whitespace-pre-line text-ink [overflow-wrap:anywhere]">{review.response.body}</p>
        </div>
      )}
    </li>
  );
}
