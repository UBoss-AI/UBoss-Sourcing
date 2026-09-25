/**
 * A preorder proposal the UBOSS team sent in the chat.
 *
 * A suggestion, and the card says so twice: the price is INDICATIVE (the
 * supplier confirms the real one when they answer the preorder request), and
 * nothing is ordered, reserved or charged by this card. "Review proposal"
 * opens the ordinary preorder form with these figures filled in; the customer
 * accepts the preorder terms and sends the request there. Replying "yes" in
 * the chat does nothing to it.
 */
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Badge, Button } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatIsoDate } from '@/lib/calendar-date';
import { errorMessage } from '@/lib/errors';
import { formatDateTime, formatMoneyMinor, formatNumber } from '@/lib/format';
import { declineProposal, type ChatProposal } from '@/lib/preorder-chat';

export function ProposalCard({
  proposal,
  conversationId,
  onReview,
}: {
  proposal: ChatProposal;
  conversationId: string;
  onReview: () => void;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const decline = useMutation({
    mutationFn: () => declineProposal(conversationId, proposal.id, reason.trim() === '' ? null : reason.trim()),
    onSuccess: () => {
      setDeclining(false);
    },
  });

  const expired = proposal.state === 'PROPOSED' && new Date(proposal.expiresAt).getTime() <= Date.now();
  const state = expired ? 'EXPIRED' : proposal.state;
  const open = state === 'PROPOSED';
  const unit = t(`preorderChat.unit.${proposal.orderingUnit}` as TranslationKey);

  return (
    <article
      aria-label={t('preorderChat.proposal.title', { revision: String(proposal.revision) })}
      className="mx-auto my-1 w-full max-w-md rounded-lg border border-brand/30 bg-surface p-3 text-sm shadow-card"
    >
      <header className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-ink">
          {t('preorderChat.proposal.title', { revision: String(proposal.revision) })}
        </h3>
        <Badge tone={open ? 'brand' : 'neutral'}>{t(`preorderChat.proposal.state.${state}` as TranslationKey)}</Badge>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-ink-muted">{t('preorderChat.proposal.quantity')}</dt>
        <dd className="text-ink">
          {t('preorderChat.requestSummary', { quantity: formatNumber(proposal.unitQuantity), unit })}
        </dd>
        <dt className="text-ink-muted">{t('preorderChat.proposal.pieces')}</dt>
        <dd className="text-ink">{formatNumber(proposal.equivalentBaseUnits)}</dd>
        <dt className="text-ink-muted">{t('preorderChat.proposal.price')}</dt>
        <dd className="text-ink">
          {proposal.indicativeUnitPriceMinor === null
            ? t('preorderChat.proposal.priceNone')
            : formatMoneyMinor(proposal.indicativeUnitPriceMinor, proposal.currency)}
        </dd>
        {proposal.availabilityNote !== null && (
          <>
            <dt className="text-ink-muted">{t('preorderChat.proposal.availability')}</dt>
            <dd className="whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{proposal.availabilityNote}</dd>
          </>
        )}
        <dt className="text-ink-muted">{t('preorderChat.proposal.delivery')}</dt>
        <dd className="text-ink">{formatIsoDate(proposal.deliveryDate, intlLocale, { dateStyle: 'long' })}</dd>
        {proposal.splitDeliveries.length > 0 && (
          <>
            <dt className="text-ink-muted">{t('preorderChat.proposal.splits')}</dt>
            <dd>
              <ul className="text-ink">
                {proposal.splitDeliveries.map((part) => (
                  <li key={part.date}>
                    {t('preorderChat.proposal.split', {
                      date: formatIsoDate(part.date, intlLocale),
                      pieces: formatNumber(part.baseUnits),
                    })}
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {proposal.termsNote !== null && (
          <>
            <dt className="text-ink-muted">{t('preorderChat.proposal.terms')}</dt>
            <dd className="whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">{proposal.termsNote}</dd>
          </>
        )}
      </dl>

      {proposal.indicativeUnitPriceMinor !== null && (
        <p className="mt-2 text-[11px] text-ink-muted">{t('preorderChat.proposal.priceNote')}</p>
      )}
      <p className="mt-1 text-[11px] text-ink-muted">{t('preorderChat.proposal.notBinding')}</p>
      {open && (
        <p className="mt-1 text-[11px] text-ink-muted">
          {t('preorderChat.proposal.expires', { date: formatDateTime(proposal.expiresAt) })}
        </p>
      )}

      {open && !declining && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" variant="primary" onClick={onReview}>
            {t('preorderChat.proposal.review')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDeclining(true);
            }}
          >
            {t('preorderChat.proposal.decline')}
          </Button>
        </div>
      )}

      {open && declining && (
        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            decline.mutate();
          }}
        >
          <label className="block text-xs text-ink-muted">
            {t('preorderChat.proposal.declineReason')}
            <textarea
              value={reason}
              maxLength={500}
              rows={2}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className="mt-1 block w-full rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
            />
          </label>
          {decline.isError && (
            <p role="alert" className="text-xs text-danger">
              {errorMessage(t, decline.error)}
            </p>
          )}
          <div className="flex gap-2">
            <Button size="sm" type="submit" variant="secondary" isLoading={decline.isPending}>
              {t('preorderChat.proposal.declineConfirm')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDeclining(false);
              }}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </article>
  );
}
