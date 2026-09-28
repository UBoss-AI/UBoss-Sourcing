/**
 * Product reviews: every review buyers have written, and the power to hide one.
 *
 * A buyer who received a product scores it 1 to 5 for quality, delivery,
 * experience and support. A review goes live the moment it is written - the
 * buyer proved they bought it - so this screen is not a queue to clear. It is
 * where staff look when something is reported, or when they want to see what
 * buyers are unhappy about.
 *
 * A review is scores only - there is no comment - so what staff act on is a
 * pattern: a buyer who scored every product 1, or ratings left on an order
 * that is known to be disputed. Each card puts the four scores beside the
 * buyer and the order that qualified them, which is what that judgement needs.
 *
 * Hiding needs a reason, and the buyer who wrote the review is shown it. A
 * decision nobody can see the reason for is one nobody can learn from or
 * challenge. The server refuses to hide without one; the dialog says so first.
 *
 * The "2 or below" filter looks for any category at or under the score, not
 * the average: a five for quality and a one for delivery is exactly the
 * review the delivery team needs to find, and its average of three hides it.
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pager } from '@/components/DataTable';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import {
  Badge,
  Button,
  Callout,
  Card,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LoadingState,
  PageHeader,
  Select,
  Textarea,
  Toolbar,
  ToolbarField,
} from '@/components/ui';
import { useSession } from '@/auth/session-context';
import { ApiError } from '@/lib/api';
import { formatDate, formatNumber } from '@/lib/format';
import { Permission } from '@/lib/permissions';
import {
  MAX_MODERATION_REASON_CHARS,
  RATING_CATEGORIES,
  fetchReviews,
  moderateReview,
  type AdminReview,
} from '@/lib/product-reviews';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';

const PAGE_SIZE = 20;

const CATEGORY_LABEL: Record<(typeof RATING_CATEGORIES)[number], TranslationKey> = {
  quality: 'productReviews.category.quality',
  delivery: 'productReviews.category.delivery',
  experience: 'productReviews.category.experience',
  support: 'productReviews.category.support',
};

const STAR_PATH =
  'M12 2L14.65 8.36L21.51 8.91L16.28 13.39L17.88 20.09L12 16.5L6.12 20.09L7.72 13.39L2.49 8.91L9.35 8.36Z';

/**
 * Five stars, filled to the value, for reading only.
 *
 * The storefront's animated input is not needed here; a member of staff never
 * scores anything. Fractions are drawn by clipping the filled star, and the
 * group is one image with a sentence for a name.
 */
function Stars({ value, label, size = 14 }: { value: number; label: string; size?: number }): React.JSX.Element {
  return (
    <span role="img" aria-label={label} className="inline-flex items-center gap-px">
      {[0, 1, 2, 3, 4].map((index) => {
        const fill = Math.max(0, Math.min(1, value - index)) * 100;
        return (
          <span key={index} className="relative block" style={{ width: size, height: size }}>
            <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="block text-border-strong" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
              <path d={STAR_PATH} />
            </svg>
            {fill > 0 && (
              <span className="absolute inset-0 text-rating" style={{ clipPath: `inset(0 ${String(100 - fill)}% 0 0)` }}>
                <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" className="block" fill="currentColor" stroke="currentColor" strokeWidth="2" strokeLinejoin="round">
                  <path d={STAR_PATH} />
                </svg>
              </span>
            )}
          </span>
        );
      })}
    </span>
  );
}

function formatScore(value: number): string {
  return formatNumber(Math.round(value * 10) / 10);
}

export function ProductReviewsPage(): React.JSX.Element {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();
  const [deciding, setDeciding] = useState<{ review: AdminReview; hide: boolean } | null>(null);
  const [searchDraft, setSearchDraft] = useState(params.get('search') ?? '');

  const page = Math.max(1, Number(params.get('page') ?? '1'));

  const query = useQuery({
    queryKey: ['admin', 'product-reviews', params.toString()],
    queryFn: () => {
      const next = new URLSearchParams(params);
      next.set('page', String(page));
      next.set('limit', String(PAGE_SIZE));
      return fetchReviews(next);
    },
  });

  const update = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value.length === 0) next.delete(key);
    else next.set(key, value);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const reviews = query.data?.reviews ?? [];

  return (
    <div className="space-y-5">
      <PageHeader title={t('productReviews.title')} description={t('productReviews.description')} />

      <Toolbar>
        <ToolbarField label={t('productReviews.filter.search')} grow>
          <Input
            type="search"
            value={searchDraft}
            placeholder={t('productReviews.filter.searchPlaceholder')}
            onChange={(event) => {
              setSearchDraft(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') update('search', searchDraft.trim());
            }}
            onBlur={() => {
              update('search', searchDraft.trim());
            }}
          />
        </ToolbarField>
        <ToolbarField label={t('productReviews.filter.status')}>
          <Select
            value={params.get('status') ?? ''}
            onChange={(event) => {
              update('status', event.currentTarget.value);
            }}
          >
            <option value="">{t('productReviews.filter.allStatuses')}</option>
            <option value="PUBLISHED">{t('productReviews.status.PUBLISHED')}</option>
            <option value="HIDDEN">{t('productReviews.status.HIDDEN')}</option>
          </Select>
        </ToolbarField>
        <ToolbarField label={t('productReviews.filter.score')}>
          <Select
            value={params.get('maxScore') ?? ''}
            onChange={(event) => {
              update('maxScore', event.currentTarget.value);
            }}
          >
            <option value="">{t('productReviews.filter.anyScore')}</option>
            <option value="2">{t('productReviews.filter.twoOrBelow')}</option>
            <option value="1">{t('productReviews.filter.oneOnly')}</option>
          </Select>
        </ToolbarField>
      </Toolbar>

      {query.isPending && <LoadingState label={t('productReviews.loading')} />}

      {query.isError && (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      )}

      {query.isSuccess && reviews.length === 0 && (
        <EmptyState
          title={t('productReviews.emptyTitle')}
          description={
            params.toString().length > 0 ? t('productReviews.emptyFiltered') : t('productReviews.emptyBody')
          }
        />
      )}

      {reviews.length > 0 && (
        <ul className="space-y-4">
          {reviews.map((review) => (
            <li key={review.id}>
              <ReviewCard
                review={review}
                onDecide={(hide) => {
                  setDeciding({ review, hide });
                }}
              />
            </li>
          ))}
        </ul>
      )}

      {query.data !== undefined && (
        <Pager
          page={query.data.pagination.page}
          limit={query.data.pagination.limit}
          total={query.data.pagination.total}
          totalPages={query.data.pagination.totalPages}
          onPageChange={(next) => {
            update('page', String(next));
          }}
        />
      )}

      {deciding !== null && (
        <ModerationDialog
          review={deciding.review}
          hide={deciding.hide}
          onClose={() => {
            setDeciding(null);
          }}
        />
      )}
    </div>
  );
}

function ReviewCard({
  review,
  onDecide,
}: {
  review: AdminReview;
  onDecide: (hide: boolean) => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const { can } = useSession();
  const hidden = review.status === 'HIDDEN';

  return (
    <Card
      title={review.product.name}
      description={`${review.product.sku} · ${formatDate(review.createdAt)}`}
      actions={
        <Badge tone={hidden ? 'warning' : 'success'} dot>
          {t(`productReviews.status.${review.status}` as TranslationKey)}
        </Badge>
      }
      bodyClassName="px-5 py-4"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="flex items-center gap-2">
            <Stars
              value={review.average}
              size={18}
              label={t('productReviews.averageLabel', { value: formatScore(review.average) })}
            />
            <span className="text-sm font-semibold tabular-nums text-ink">{formatScore(review.average)}</span>
          </span>
          <dl className="flex flex-wrap gap-2">
            {RATING_CATEGORIES.map((category) => (
              <div
                key={category}
                className={
                  'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ring-1 ring-inset ' +
                  (review.scores[category] <= 2
                    ? 'bg-danger-soft text-danger ring-danger/30'
                    : 'bg-surface-sunken text-ink ring-border')
                }
              >
                <dt className="text-ink-muted">{t(CATEGORY_LABEL[category])}</dt>
                <dd className="font-semibold tabular-nums">{formatNumber(review.scores[category])}/5</dd>
              </div>
            ))}
          </dl>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-3">
          <div className="min-w-0">
            <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{t('productReviews.buyer')}</dt>
            <dd className="mt-1 min-w-0">
              {can(Permission.CUSTOMER_READ) ? (
                <Link to={`/customers/${review.customer.id}`} className="font-medium text-brand hover:underline">
                  {review.customer.name}
                </Link>
              ) : (
                <span className="font-medium text-ink">{review.customer.name}</span>
              )}
              <p className="truncate text-xs text-ink-subtle">{review.customer.email}</p>
            </dd>
          </div>
          <div>
            <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{t('productReviews.order')}</dt>
            <dd className="mt-1 font-mono text-xs">
              {review.orderId === null || review.orderNumber === null ? (
                <span className="text-ink-subtle">—</span>
              ) : can(Permission.ORDER_READ) ? (
                <Link to={`/orders/${review.orderId}`} className="text-brand hover:underline">
                  {review.orderNumber}
                </Link>
              ) : (
                review.orderNumber
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xxs font-medium uppercase tracking-wider text-ink-subtle">{t('productReviews.product')}</dt>
            <dd className="mt-1 text-xs">
              {can(Permission.PRODUCT_READ) ? (
                <Link to={`/products/${review.product.id}`} className="text-brand hover:underline">
                  {t('productReviews.openProduct')}
                </Link>
              ) : (
                <span className="font-mono">{review.product.sku}</span>
              )}
            </dd>
          </div>
        </dl>

        {hidden && (
          <Callout tone="warning" title={t('productReviews.hiddenTitle')}>
            <p className="text-sm">{review.moderationReason ?? '—'}</p>
            {review.moderatedAt !== null && (
              <p className="mt-1 text-xs text-ink-muted">
                {t('productReviews.hiddenBy', {
                  person: review.moderatedBy ?? '—',
                  date: formatDate(review.moderatedAt),
                })}
              </p>
            )}
          </Callout>
        )}

        {can(Permission.REVIEW_MODERATE) && (
          <div className="flex justify-end border-t border-border-subtle pt-4">
            {hidden ? (
              <Button
                variant="primary"
                onClick={() => {
                  onDecide(false);
                }}
              >
                {t('productReviews.show')}
              </Button>
            ) : (
              <Button
                variant="danger"
                onClick={() => {
                  onDecide(true);
                }}
              >
                {t('productReviews.hide')}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function ModerationDialog({
  review,
  hide,
  onClose,
}: {
  review: AdminReview;
  hide: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      moderateReview(review.id, {
        status: hide ? 'HIDDEN' : 'PUBLISHED',
        reason: hide ? reason.trim() : null,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['admin', 'product-reviews'] });
      toast.success(hide ? t('productReviews.hiddenToast') : t('productReviews.shownToast'));
      onClose();
    },
    onError: (error: unknown) => {
      toast.error(error instanceof ApiError ? error.message : t('productReviews.couldNotSave'));
    },
  });

  const canSubmit = !hide || reason.trim().length > 0;

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={hide ? t('productReviews.hideTitle') : t('productReviews.showTitle')}
      description={review.product.name}
    >
      <div className="space-y-4">
        <Callout tone={hide ? 'warning' : 'info'}>
          <p className="text-sm">{hide ? t('productReviews.hideExplain') : t('productReviews.showExplain')}</p>
        </Callout>

        {hide && (
          <Field label={t('productReviews.reasonLabel')} hint={t('productReviews.reasonHint')} required>
            {({ inputId, describedBy }) => (
              <Textarea
                id={inputId}
                aria-describedby={describedBy}
                rows={3}
                maxLength={MAX_MODERATION_REASON_CHARS}
                value={reason}
                placeholder={t('productReviews.reasonPlaceholder')}
                onChange={(event) => {
                  setReason(event.currentTarget.value);
                }}
              />
            )}
          </Field>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button
            variant={hide ? 'danger' : 'primary'}
            isLoading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => {
              mutation.mutate();
            }}
          >
            {hide ? t('productReviews.hide') : t('productReviews.show')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
