/**
 * The pieces a preorder is drawn from, shared by the buyer's account pages and
 * the Seller Hub inbox. The two sides read the same request; drawing its terms
 * twice would let the two screens describe one agreement differently.
 */
import { Badge } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import { formatIsoDate } from '@/lib/calendar-date';
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format';
import { preorderTone, type Preorder, type PreorderOffer, type PreorderStatus } from '@/lib/preorders';

export function PreorderStatusBadge({ status }: { status: PreorderStatus }): React.JSX.Element {
  const { t } = useI18n();
  return <Badge tone={preorderTone(status)}>{t(`preorder.status.${status}` as TranslationKey)}</Badge>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-right text-sm font-medium tabular-nums text-ink">{children}</dd>
    </div>
  );
}

/** One revision of terms: what the seller proposed, and what became of it. */
export function OfferTerms({ offer, highlight = false }: { offer: PreorderOffer; highlight?: boolean }): React.JSX.Element {
  const { t, intlLocale } = useI18n();

  return (
    <div
      className={
        highlight
          ? 'rounded-md border-2 border-brand/40 bg-surface p-4'
          : 'rounded-md border border-border-subtle bg-surface p-4'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold text-ink">
          {t(offer.kind === 'ACCEPT_AS_REQUESTED' ? 'preorder.terms.accepted' : 'preorder.terms.counter', {
            revision: String(offer.revision),
          })}
        </p>
        <Badge tone={offer.state === 'PROPOSED' ? 'warning' : offer.state === 'ACCEPTED' ? 'success' : 'neutral'}>
          {t(`preorder.offerState.${offer.state}` as TranslationKey)}
        </Badge>
      </div>

      <dl className="mt-2 divide-y divide-border-subtle">
        <Row label={t('preorder.pieces')}>{formatNumber(offer.quantityBaseUnits)}</Row>
        <Row label={t('preorder.perPiece')}>{formatMoney(offer.unitPrice)}</Row>
        <Row label={t('preorder.goodsTotal')}>{formatMoney(offer.goodsTotal)}</Row>
        <Row label={t('preorder.freight')}>
          {offer.freight.minor === '0' ? t('preorder.freightIncluded') : formatMoney(offer.freight)}
        </Row>
        <Row label={t('preorder.totalBeforeTax')}>{formatMoney(offer.total)}</Row>
        <Row label={t('preorder.committedDate')}>
          {formatIsoDate(offer.committedDeliveryDate, intlLocale, { dateStyle: 'long' })}
        </Row>
      </dl>

      {offer.deliverySplits !== null && offer.deliverySplits.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-ink">{t('preorder.splitDeliveries')}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
            {offer.deliverySplits.map((split) => (
              <li key={split.date}>
                {t('preorder.splitLine', {
                  date: formatIsoDate(split.date, intlLocale, { dateStyle: 'medium' }),
                  pieces: formatNumber(split.baseUnits),
                })}
              </li>
            ))}
          </ul>
        </div>
      )}

      {offer.note !== null && <p className="mt-2 whitespace-pre-line text-sm text-ink">{offer.note}</p>}

      <p className="mt-2 text-xs text-ink-muted">
        {offer.state === 'PROPOSED'
          ? t('preorder.openUntil', { date: formatDateTime(offer.expiresAt) })
          : offer.respondedAt !== null
            ? t('preorder.answeredAt', { date: formatDateTime(offer.respondedAt) })
            : t('preorder.proposedAt', { date: formatDateTime(offer.createdAt) })}
      </p>
      {offer.responseNote !== null && <p className="mt-1 text-xs text-ink-muted">“{offer.responseNote}”</p>}
      <p className="mt-1 break-all font-mono text-xxs text-ink-subtle" title={t('preorder.termsReference')}>
        {offer.termsHash.slice(0, 16)}
      </p>
    </div>
  );
}

/** What was asked for, as the buyer asked it. */
export function RequestSummary({ preorder }: { preorder: Preorder }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const address = preorder.shippingAddress;

  return (
    <dl className="divide-y divide-border-subtle">
      <Row label={t('preorder.requested')}>
        {preorder.quantity.orderingUnit === 'PIECE'
          ? t('preorder.piecesCount', { pieces: formatNumber(preorder.quantity.baseUnits) })
          : t('preorder.packagesCount', {
              quantity: formatNumber(preorder.quantity.unitQuantity),
              unit: t(`preorder.unit.${preorder.quantity.orderingUnit}` as TranslationKey),
              pieces: formatNumber(preorder.quantity.baseUnits),
            })}
      </Row>
      <Row label={t('preorder.requestedDate')}>
        {formatIsoDate(preorder.requestedDeliveryDate, intlLocale, { dateStyle: 'long' })}
      </Row>
      {preorder.indicative.unitPrice !== null && (
        <Row label={t('preorder.indicativePrice')}>
          {t('preorder.indicativeLine', {
            price: formatMoney(preorder.indicative.unitPrice),
            total: formatMoney(preorder.indicative.goodsTotal),
          })}
        </Row>
      )}
      <Row label={t('preorder.deliverTo')}>
        {[address['line1'], address['city'], address['postalCode'], address['country']].filter(Boolean).join(', ')}
      </Row>
      {preorder.destinationWarehouseLabel !== null && (
        <Row label={t('preorder.destinationWarehouse')}>{preorder.destinationWarehouseLabel}</Row>
      )}
      <Row label={t('preorder.transport')}>
        {t(`preorder.transportMode.${preorder.transportPreference}` as TranslationKey)}
      </Row>
      <Row label={t('preorder.allowPartial')}>{preorder.allowPartialDelivery ? t('preorder.yes') : t('preorder.no')}</Row>
      {preorder.purchaseOrderReference !== null && (
        <Row label={t('preorder.poReference')}>{preorder.purchaseOrderReference}</Row>
      )}
      {preorder.handlingInstructions !== null && (
        <Row label={t('preorder.handling')}>{preorder.handlingInstructions}</Row>
      )}
      {preorder.customerNotes !== null && (
        <div className="py-1.5">
          <dt className="text-sm text-ink-muted">{t('preorder.notes')}</dt>
          <dd className="mt-1 whitespace-pre-line text-sm text-ink">{preorder.customerNotes}</dd>
        </div>
      )}
    </dl>
  );
}

/** Every status the request has been through, oldest first. */
export function PreorderHistory({ preorder }: { preorder: Preorder }): React.JSX.Element {
  const { t } = useI18n();
  return (
    <ol className="space-y-2">
      {preorder.history.map((entry, index) => (
        <li key={`${entry.at}-${String(index)}`} className="flex gap-3 text-sm">
          <span aria-hidden="true" className="mt-1.5 size-2 shrink-0 rounded-full bg-brand/60" />
          <div className="min-w-0">
            <p className="text-ink">
              {t(`preorder.status.${entry.toStatus}` as TranslationKey)}
              <span className="ml-2 text-xs text-ink-muted">{formatDateTime(entry.at)}</span>
            </p>
            <p className="text-xs text-ink-muted">
              {entry.actorLabel}
              {entry.reason !== null && ` — ${entry.reason}`}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
