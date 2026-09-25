/**
 * A structured preorder proposal, drawn as a card of its own - in the thread
 * and in the details panel alike, so it never reads as an ordinary message.
 * Its price is labelled indicative: a proposal reserves and charges nothing.
 */
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { currencyExponent, formatDate, formatDateTime, formatNumber, minorToMajor } from '@/lib/format';
import type { ChatProposal } from '@/lib/preorder-chats';

export function ProposalSummary({ proposal, currency }: { proposal: ChatProposal; currency: string }): React.JSX.Element {
  const { t } = useI18n();
  const expired = proposal.state === 'PROPOSED' && new Date(proposal.expiresAt).getTime() <= Date.now();
  const state = expired ? 'EXPIRED' : proposal.state;
  return (
    <div className="mx-auto mt-1 w-full max-w-md rounded-lg border border-brand/30 bg-brand-soft/40 p-3 text-xs">
      <p className="flex items-center justify-between gap-2">
        <span className="font-semibold text-ink">
          {t('preorderChats.proposalRevision', { revision: String(proposal.revision) })}
        </span>
        <span className="text-ink-muted">{t(`preorderChats.proposalState.${state}` as TranslationKey)}</span>
      </p>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-ink-muted">{t('preorderChats.ctx.quantity')}</dt>
        <dd className="text-ink">
          {formatNumber(proposal.unitQuantity)} × {t(`preorderChats.unit.${proposal.orderingUnit}` as TranslationKey)} ={' '}
          {t('preorderChats.ctx.piecesValue', { pieces: formatNumber(proposal.equivalentBaseUnits) })}
        </dd>
        <dt className="text-ink-muted">{t('preorderChats.ctx.date')}</dt>
        <dd className="text-ink">{formatDate(proposal.deliveryDate)}</dd>
        {proposal.indicativeUnitPriceMinor !== null && (
          <>
            <dt className="text-ink-muted">{t('preorderChats.ctx.price')}</dt>
            <dd className="text-ink">
              {t('preorderChats.ctx.priceIndicative', {
                price: `${minorToMajor(proposal.indicativeUnitPriceMinor, currencyExponent(proposal.currency || currency))} ${proposal.currency || currency}`,
              })}
            </dd>
          </>
        )}
      </dl>
      <p className="mt-1.5 text-xxs text-ink-muted">{t('preorderChats.ctx.expires', { date: formatDateTime(proposal.expiresAt) })}</p>
    </div>
  );
}
