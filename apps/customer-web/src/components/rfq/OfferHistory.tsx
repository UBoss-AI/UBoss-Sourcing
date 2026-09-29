/**
 * Every offer version in a quote, newest first: who wrote it, its state, and
 * its terms. Each version is immutable, so this is the whole negotiation as
 * it happened. Missing terms read "Not provided".
 */
import { Badge, type BadgeTone } from '@/components/ui';
import { useI18n, type TranslationKey } from '@/i18n/i18n-context';
import { formatMoney } from '@/lib/format';
import { formatUtc } from '@/lib/rfq-format';
import type { OfferVersion } from '@/lib/rfq-quote';

const TONES: Record<OfferVersion['state'], BadgeTone> = {
  PROPOSED: 'brand',
  SUPERSEDED: 'neutral',
  ACCEPTED: 'success',
  REJECTED: 'danger',
  WITHDRAWN: 'warning',
  CLOSED: 'neutral',
};

export function OfferHistory({ versions, reader }: { versions: OfferVersion[]; reader: 'BUYER' | 'SUPPLIER' }): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const missing = t('rfq.notProvided');
  return (
    <ol className="space-y-3">
      {[...versions].reverse().map((version) => (
        <li key={version.id} className="rounded-md border border-border-subtle p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-medium text-ink">
              {t('rfq.offer.versionBy', {
                version: String(version.versionNumber),
                author: version.author === reader ? t('rfq.thread.you') : version.author === 'BUYER' ? t('rfq.offer.buyer') : t('rfq.offer.supplier'),
              })}
            </p>
            <span className="flex gap-2">
              <Badge tone={TONES[version.state]}>{t(`rfq.offerState.${version.state}` as TranslationKey)}</Badge>
              {version.isExpired && <Badge tone="danger">{t('rfq.compare.expired')}</Badge>}
            </span>
          </div>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="inline text-ink-muted">{t('rfq.quote.unitPrice')}: </dt>
              <dd className="inline tabular-nums text-ink">{formatMoney(version.unitPrice)}</dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">{t('rfq.field.quantity')}: </dt>
              <dd className="inline text-ink">{version.terms.quantity}</dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">{t('rfq.compare.row.moq')}: </dt>
              <dd className="inline text-ink">{version.terms.moq ?? missing}</dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">{t('rfq.compare.row.leadTime')}: </dt>
              <dd className="inline text-ink">
                {version.terms.leadTimeDays === null ? missing : t('rfq.compare.days', { days: String(version.terms.leadTimeDays) })}
              </dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">{t('rfq.field.incoterm')}: </dt>
              <dd className="inline text-ink">{version.terms.incoterm ?? missing}</dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">{t('rfq.compare.row.payment')}: </dt>
              <dd className="inline text-ink">{version.terms.paymentTerms ?? missing}</dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">{t('rfq.compare.row.inspection')}: </dt>
              <dd className="inline text-ink">{version.terms.inspectionTerms ?? missing}</dd>
            </div>
            <div>
              <dt className="inline text-ink-muted">{t('rfq.compare.row.validUntil')}: </dt>
              <dd className="inline text-ink">{formatUtc(version.terms.expiresAt, intlLocale)}</dd>
            </div>
          </dl>
          {version.comment !== null && <p className="mt-2 whitespace-pre-line text-sm text-ink">{version.comment}</p>}
          {version.responseNote !== null && (
            <p className="mt-1 text-xs text-ink-muted">{t('rfq.offer.answer', { note: version.responseNote })}</p>
          )}
          <p className="mt-1 text-xs text-ink-subtle">{formatUtc(version.createdAt, intlLocale)}</p>
        </li>
      ))}
    </ol>
  );
}
