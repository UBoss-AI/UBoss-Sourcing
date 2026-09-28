/**
 * Write, edit or take back your review of one product.
 *
 * Opened from three places - the product page, a delivered order, and the
 * "My reviews" page - and the same dialog in all three, so a buyer learns it
 * once. It loads what they wrote last time, because a form that came up empty
 * over a review they wrote last month would have them write it again.
 *
 * Four scores, all required: quality, delivery, experience and support. They
 * are separate because they are separate questions - a well-made part that
 * arrived three weeks late is a five and a one, and averaging those into a
 * three tells the next buyer nothing. Scores only - there is no comment box.
 *
 * Whether they may review at all is the server's call (a delivered order
 * containing the product). The callers only open this for somebody who may,
 * and a refusal that slips through - a page left open while an order was
 * cancelled - arrives as REVIEW_NOT_ELIGIBLE and is said in their language.
 */
import { useEffect, useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Modal } from '@/components/Modal';
import { useToast } from '@/components/toast-context';
import { Button, ErrorState, LoadingState } from '@/components/ui';
import { StarRating } from '@/components/ui/star-rating';
import { errorMessage } from '@/lib/errors';
import {
  RATING_CATEGORIES,
  RATING_CATEGORY_KEYS as CATEGORY_KEYS,
  deleteOwnReview,
  fetchOwnReview,
  reviewKeys,
  saveOwnReview,
  type OwnReview,
  type RatingScores,
} from '@/lib/ratings';
import { useI18n } from '@/i18n/i18n-context';

const EMPTY_SCORES: RatingScores = { quality: 0, delivery: 0, experience: 0, support: 0 };

export function ReviewDialog({
  productId,
  productName,
  onClose,
}: {
  productId: string;
  productName: string;
  onClose: () => void;
}): React.JSX.Element {
  const { t } = useI18n();

  const query = useQuery({
    queryKey: reviewKeys.own(productId),
    queryFn: () => fetchOwnReview(productId),
  });

  return (
    <Modal
      isOpen
      onClose={onClose}
      size="lg"
      title={query.data?.review ? t('reviews.dialog.editTitle') : t('reviews.dialog.title')}
      description={t('reviews.dialog.intro', { product: productName })}
    >
      {query.isPending ? (
        <LoadingState label={t('reviews.loading')} />
      ) : query.isError ? (
        <ErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : query.data.canReview ? (
        <ReviewForm productId={productId} existing={query.data.review} onDone={onClose} />
      ) : (
        <p className="text-sm text-ink-muted">{t('reviews.notEligible')}</p>
      )}
    </Modal>
  );
}

function ReviewForm({
  productId,
  existing,
  onDone,
}: {
  productId: string;
  existing: OwnReview | null;
  onDone: () => void;
}): React.JSX.Element {
  const { t } = useI18n();
  const toast = useToast();
  const queryClient = useQueryClient();
  const formId = useId();

  const [scores, setScores] = useState<RatingScores>(existing?.scores ?? EMPTY_SCORES);
  const [submitted, setSubmitted] = useState(false);

  // The dialog's query can resolve after first paint; take the saved values
  // when they arrive rather than keeping the empty ones.
  useEffect(() => {
    if (existing !== null) {
      setScores(existing.scores);
    }
  }, [existing]);

  const missing = RATING_CATEGORIES.filter((category) => scores[category] < 1);

  const refresh = async (): Promise<void> => {
    // Everything that shows a review or an average: this product's page, the
    // account list, the order page's buttons and every card's stars.
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: reviewKeys.all }),
      queryClient.invalidateQueries({ queryKey: ['product'] }),
      queryClient.invalidateQueries({ queryKey: ['products'] }),
      queryClient.invalidateQueries({ queryKey: ['home-shelf'] }),
    ]);
  };

  const save = useMutation({
    mutationFn: () => saveOwnReview(productId, { scores }),
    onSuccess: async (review) => {
      toast.success(
        review.status === 'HIDDEN' ? t('reviews.savedStillHidden') : t('reviews.saved'),
      );
      await refresh();
      onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('reviews.couldNotSave')));
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteOwnReview(existing?.id ?? ''),
    onSuccess: async () => {
      toast.success(t('reviews.deleted'));
      await refresh();
      onDone();
    },
    onError: (error) => {
      toast.error(errorMessage(t, error, t('reviews.couldNotDelete')));
    },
  });

  const busy = save.isPending || remove.isPending;

  return (
    <form
      id={formId}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        setSubmitted(true);
        if (missing.length === 0) save.mutate();
      }}
      className="space-y-5"
    >
      {existing?.status === 'HIDDEN' && (
        <div role="status" className="rounded-md border border-warning/40 bg-warning-soft px-3 py-2.5 text-sm text-warning">
          <p className="font-medium">{t('reviews.hiddenNotice')}</p>
          {existing.moderationReason !== null && (
            <p className="mt-1">{t('reviews.hiddenReason', { reason: existing.moderationReason })}</p>
          )}
        </div>
      )}

      <fieldset>
        <legend className="text-sm font-medium text-ink">{t('reviews.scoresLegend')}</legend>
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {RATING_CATEGORIES.map((category) => {
            const invalid = submitted && scores[category] < 1;
            const errorId = `${formId}-${category}-error`;
            const hintId = `${formId}-${category}-hint`;

            return (
              <li
                key={category}
                className="rounded-lg border border-border bg-surface-sunken/60 px-3.5 py-3"
              >
                <p className="text-sm font-semibold text-ink">{t(CATEGORY_KEYS[category].label)}</p>
                <p id={hintId} className="mt-0.5 text-xs text-ink-muted">
                  {t(CATEGORY_KEYS[category].hint)}
                </p>
                <StarRating
                  className="mt-2"
                  size="md"
                  showValue
                  value={scores[category]}
                  disabled={busy}
                  invalid={invalid}
                  describedBy={invalid ? `${hintId} ${errorId}` : hintId}
                  label={t(CATEGORY_KEYS[category].label)}
                  onValueChange={(value) => {
                    setScores((current) => ({ ...current, [category]: value }));
                  }}
                />
                {invalid && (
                  <p id={errorId} className="mt-1 text-xs font-medium text-danger">
                    {t('reviews.scoreRequired')}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      <p className="text-xs text-ink-subtle">{t('reviews.publicNote')}</p>

      {/* flex-wrap: at 320px the three buttons do not fit on one line. */}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border-subtle pt-4">
        {existing !== null && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto text-danger"
            isLoading={remove.isPending}
            disabled={busy}
            onClick={() => {
              remove.mutate();
            }}
          >
            {t('reviews.delete')}
          </Button>
        )}
        <Button type="button" variant="secondary" disabled={busy} onClick={onDone}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" variant="action" isLoading={save.isPending} disabled={busy}>
          {existing === null ? t('reviews.submit') : t('reviews.update')}
        </Button>
      </div>
    </form>
  );
}
