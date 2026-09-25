/**
 * One preorder, from the buyer's side.
 *
 * The page's single job is to make the buyer's decision unambiguous. When the
 * seller has answered, their terms are drawn in full - pieces, price per
 * piece, freight, the committed date, any split - and the Confirm button
 * confirms EXACTLY those terms: it sends the revision and its hash, so terms
 * the seller changed while the page was open are refused rather than accepted
 * unseen.
 *
 * Three answers: Accept offer, Reject offer (which ends the preorder), and
 * Request a change (which sends it back to the seller with the buyer's
 * message). The offer is shown with its full price from the server - goods,
 * tax, delivery and total - and, for a revised date or a split delivery, its
 * schedule with container equivalents. An offer whose stock has gone since it
 * was sent says so BEFORE the buyer presses Accept, and cannot be accepted.
 *
 * Accepting charges nothing. It creates the order, awaiting payment, and the
 * page then sends the buyer to that order to pay for it through the ordinary
 * payment flow - where the payment is confirmed by the signed webhook, never
 * by the redirect back.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStorefront } from '@/app/storefront-context';
import { Modal } from '@/components/Modal';
import { OfferTerms, PreorderHistory, PreorderStatusBadge, RequestSummary } from '@/components/preorder/PreorderParts';
import { useToast } from '@/components/toast-context';
import { Button, ButtonLink, Card, ErrorState, Field, LoadingState, PageHeader, Textarea } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoney } from '@/lib/format';
import {
  cancelPreorder,
  confirmPreorder,
  fetchMyPreorder,
  isQuote,
  requestPreorderChange,
  type Preorder,
} from '@/lib/preorders';
import { useDocumentMeta } from '@/lib/useDocumentMeta';

export function PreorderDetailPage(): React.JSX.Element {
  const { id = '' } = useParams<{ id: string }>();
  const { t } = useI18n();
  const { business } = useStorefront();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState<'change' | 'reject' | 'cancel' | null>(null);
  const [note, setNote] = useState('');

  const query = useQuery({ queryKey: ['preorder', id], queryFn: () => fetchMyPreorder(id) });

  useDocumentMeta(
    { title: query.data === undefined ? t('preorder.myPreorders') : query.data.requestNumber, noIndex: true },
    business.displayName,
  );

  const refresh = (preorder: Preorder): void => {
    queryClient.setQueryData(['preorder', id], preorder);
    void queryClient.invalidateQueries({ queryKey: ['preorders'] });
  };

  const confirm = useMutation({
    mutationFn: (preorder: Preorder) => {
      if (preorder.currentOffer === null) throw new Error(t('preorder.noTermsToConfirm'));
      return confirmPreorder(preorder.id, preorder.currentOffer);
    },
    onSuccess: (preorder) => {
      refresh(preorder);
      toast.success(t('preorder.confirmedToast'));
    },
    onError: (error) => {
      toast.error(errorMessage(t, error));
      // The usual cause is terms that changed under the page. Show the new ones.
      void query.refetch();
    },
  });

  const decline = useMutation({
    mutationFn: () => requestPreorderChange(id, note.trim()),
    onSuccess: (preorder) => {
      refresh(preorder);
      setDialog(null);
      setNote('');
    },
    onError: (error) => { toast.error(errorMessage(t, error)); },
  });

  const cancel = useMutation({
    mutationFn: () => cancelPreorder(id, note.trim()),
    onSuccess: (preorder) => {
      refresh(preorder);
      setDialog(null);
      setNote('');
    },
    onError: (error) => { toast.error(errorMessage(t, error)); },
  });

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

  const preorder = query.data;
  const offer = preorder.currentOffer;
  const offerOpen = offer !== null && offer.state === 'PROPOSED';
  const expired = offerOpen && offer.isExpired === true;
  const stockGone = offerOpen && offer.stockStillAvailable === false;
  const canConfirm =
    preorder.allowedActions.includes('BUYER_CONFIRMED') && offerOpen && !expired && !stockGone;
  const canDecline = preorder.allowedActions.includes('SELLER_REVIEW_REQUIRED') && offerOpen;
  const canCancel = preorder.allowedActions.includes('CANCELLED');
  const quote = offer?.quote;

  return (
    <>
      <p className="mb-3 text-sm">
        <Link to="/account/preorders" className="text-brand hover:underline">
          ← {t('preorder.myPreorders')}
        </Link>
      </p>

      <PageHeader
        title={preorder.product.name}
        description={`${preorder.requestNumber} · ${t('preorder.soldBy', { seller: preorder.seller.name })}`}
        actions={<PreorderStatusBadge status={preorder.status} />}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          {/* Whose turn it is, in words. */}
          <div role="status" className="rounded-md border border-border bg-surface-sunken p-4 text-sm text-ink">
            {t(`preorder.explain.${preorder.status}` as TranslationKey, {
              seller: preorder.seller.name,
              date: preorder.expiresAt === null ? '' : formatDateTime(preorder.expiresAt),
            })}
          </div>

          {preorder.status === 'PAYMENT_REQUIRED' && preorder.order !== null && (
            <Card title={t('preorder.payTitle')}>
              <p className="text-sm text-ink">
                {t('preorder.payBody', {
                  order: preorder.order.orderNumber,
                  total: formatMoney(preorder.order.grandTotal),
                })}
              </p>
              <div className="mt-3">
                <ButtonLink to={`/account/orders/${preorder.order.id}`} variant="action">
                  {t('preorder.goToPayment')}
                </ButtonLink>
              </div>
            </Card>
          )}

          {offer !== null && (
            <section aria-labelledby="terms-heading" className="space-y-3">
              <h2 id="terms-heading" className="text-title-xs text-ink">
                {t('preorder.sellersTerms')}
              </h2>
              <OfferTerms offer={offer} highlight />

              {offerOpen && quote !== undefined && quote !== null && (
                <Card>
                  {isQuote(quote) ? (
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                      <dt className="text-ink-muted">{t('preorder.productSubtotal')}</dt>
                      <dd className="text-right tabular-nums text-ink">{formatMoney(quote.subtotal)}</dd>
                      <dt className="text-ink-muted">{t('preorder.tax')}</dt>
                      <dd className="text-right tabular-nums text-ink">{formatMoney(quote.tax)}</dd>
                      <dt className="text-ink-muted">{t('preorder.estimatedLogistics')}</dt>
                      <dd className="text-right tabular-nums text-ink">
                        {quote.logisticsIncluded ? t('preorder.freightIncluded') : formatMoney(quote.shipping)}
                      </dd>
                      <dt className="font-semibold text-ink">{t('preorder.grandTotal')}</dt>
                      <dd className="text-right text-base font-semibold tabular-nums text-ink">
                        {formatMoney(quote.grandTotal)}
                      </dd>
                    </dl>
                  ) : (
                    <p className="text-sm text-ink-muted">{t('preorder.taxLater')}</p>
                  )}
                </Card>
              )}

              {expired && (
                <div role="alert" className="rounded-md border border-warning/40 bg-warning-soft p-3 text-sm text-ink">
                  <p className="font-semibold">{t('preorder.offerExpired')}</p>
                  <p className="mt-0.5">{t('preorder.offerExpiredBody')}</p>
                </div>
              )}
              {stockGone && !expired && (
                <div role="alert" className="rounded-md border border-danger/30 bg-danger-soft p-3 text-sm text-ink">
                  <p className="font-semibold">{t('preorder.stockChanged')}</p>
                  <p className="mt-0.5">{t('preorder.stockChangedBody')}</p>
                </div>
              )}

              {offerOpen && (canConfirm || canDecline || canCancel) && (
                <div className="flex flex-wrap items-center gap-2">
                  {canConfirm && (
                    <Button
                      variant="action"
                      isLoading={confirm.isPending}
                      onClick={() => {
                        confirm.mutate(preorder);
                      }}
                    >
                      {t('preorder.acceptOffer')}
                    </Button>
                  )}
                  {canDecline && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setNote('');
                        setDialog('change');
                      }}
                    >
                      {t('preorder.requestChange')}
                    </Button>
                  )}
                  {canCancel && (
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setNote('');
                        setDialog('reject');
                      }}
                    >
                      {t('preorder.rejectOffer')}
                    </Button>
                  )}
                  {canConfirm && <p className="w-full text-xs text-ink-muted">{t('preorder.acceptOfferNote')}</p>}
                </div>
              )}
            </section>
          )}

          <Card title={t('preorder.whatYouAskedFor')}>
            <RequestSummary preorder={preorder} />
          </Card>

          {preorder.offers.length > 1 && (
            <Card title={t('preorder.earlierTerms')}>
              <div className="space-y-3">
                {preorder.offers
                  .filter((entry) => entry.id !== offer?.id)
                  .reverse()
                  .map((entry) => (
                    <OfferTerms key={entry.id} offer={entry} />
                  ))}
              </div>
            </Card>
          )}
        </div>

        <aside className="space-y-4">
          {preorder.order !== null && (
            <Card title={t('preorder.order')}>
              <p className="text-sm">
                <Link to={`/account/orders/${preorder.order.id}`} className="font-medium text-brand hover:underline">
                  {preorder.order.orderNumber}
                </Link>
              </p>
            </Card>
          )}
          <Card title={t('preorder.history')}>
            <PreorderHistory preorder={preorder} />
          </Card>
          {canCancel && (
            <Button
              variant="danger"
              fullWidth
              onClick={() => {
                setDialog('cancel');
              }}
            >
              {t('preorder.cancelRequest')}
            </Button>
          )}
          <Button
            variant="ghost"
            fullWidth
            onClick={() => {
              if (preorder.product.slug !== null) void navigate(`/product/${preorder.product.slug}`);
            }}
          >
            {t('preorder.viewProduct')}
          </Button>
        </aside>
      </div>

      <Modal
        isOpen={dialog !== null}
        onClose={() => {
          setDialog(null);
        }}
        title={
          dialog === 'cancel'
            ? t('preorder.cancelRequest')
            : dialog === 'reject'
              ? t('preorder.rejectOffer')
              : t('preorder.requestChange')
        }
        description={
          dialog === 'cancel'
            ? t('preorder.cancelBody')
            : dialog === 'reject'
              ? t('preorder.rejectOfferBody')
              : t('preorder.requestChangeBody')
        }
        footer={
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setDialog(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant={dialog === 'change' ? 'primary' : 'danger'}
              disabled={note.trim().length < 3}
              isLoading={decline.isPending || cancel.isPending}
              onClick={() => {
                if (dialog === 'change') decline.mutate();
                else cancel.mutate();
              }}
            >
              {dialog === 'cancel'
                ? t('preorder.cancelRequest')
                : dialog === 'reject'
                  ? t('preorder.rejectOffer')
                  : t('preorder.sendChangeRequest')}
            </Button>
          </div>
        }
      >
        <Field label={dialog === 'change' ? t('preorder.yourMessage') : t('preorder.reason')}>
          {({ inputId }) => (
            <Textarea
              id={inputId}
              rows={3}
              maxLength={1000}
              value={note}
              onChange={(event) => {
                setNote(event.currentTarget.value);
              }}
            />
          )}
        </Field>
      </Modal>
    </>
  );
}
