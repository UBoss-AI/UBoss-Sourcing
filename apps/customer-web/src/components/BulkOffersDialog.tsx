/**
 * Every bulk offer on this product, together, in one dialog.
 *
 * Not a carousel and not a list of one headline at a time: the buyer sees
 * every band side by side - how many, what each piece costs, what that saves
 * per piece and in total - and picks one. Every figure is the server's
 * (`offers` on `GET /catalog/bulk-pricing`), worked out by the functions that
 * price the basket, so what a card promises is what checkout charges. The
 * basket re-prices on every add and at checkout; this dialog locks nothing.
 *
 * What it marks, and only when it is true:
 *   - "Your quantity" on the band the chosen quantity is priced by now;
 *   - "Next saving" on the nearest band above it that lowers the price;
 *   - "Best value" on the one band strictly cheaper than every other.
 *
 * Built on the app's own accessible <dialog>: focus moves in and comes back,
 * Escape and the backdrop close it, the page behind does not scroll. The cards
 * rise in one after another and lift under the pointer - the "card hover
 * effect" pattern, in `motion`, which the app already ships. With reduced
 * motion asked for they simply appear.
 */
import { motion, useReducedMotion } from 'motion/react';

import { Modal } from '@/components/Modal';
import { Button } from '@/components/ui';
import { useI18n } from '@/i18n/i18n-context';
import { formatBasisPoints, type BulkOfferCard, type BulkPricing } from '@/lib/bulk-pricing';
import { cx } from '@/lib/cx';
import { formatMoney } from '@/lib/format';

type Available = Extract<BulkPricing, { available: true }>;

export function BulkOffersDialog({
  isOpen,
  pricing,
  onSelect,
  onClose,
}: {
  isOpen: boolean;
  /** The figures for the quantity on the page. */
  pricing: Available;
  /** Undefined where the page counts in something other than pieces. */
  onSelect: ((pieces: number) => void) | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const number = (value: number): string => value.toLocaleString(intlLocale);

  const progress =
    pricing.next === null
      ? null
      : t('bulkOffers.progress', {
          more: number(pricing.next.addQuantity),
          price: formatMoney(pricing.next.unitPrice),
        });

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      title={t('bulkOffers.title')}
      description={t('bulkOffers.description', {
        price: formatMoney(pricing.listUnitPrice),
        seller: pricing.sellerName,
      })}
      footer={
        <Button variant="ghost" onClick={onClose} className="w-full sm:w-auto">
          {t('bulkOffers.close')}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-sunken px-3 py-2 text-sm">
          <p className="text-ink">
            {t('bulkOffers.yourQuantity', {
              quantity: number(pricing.quantity),
              price: formatMoney(pricing.current.unitPrice),
            })}
          </p>
          {progress === null ? null : (
            <p className="font-medium text-brand" aria-live="polite">
              {progress}
            </p>
          )}
        </div>

        <motion.ul
          // Keyed on opening, so the cards rise in each time it opens rather
          // than once while it sat closed.
          key={isOpen ? 'open' : 'closed'}
          className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3"
          initial={reduced ? false : 'hidden'}
          animate="shown"
          variants={{ hidden: {}, shown: { transition: { staggerChildren: 0.05 } } }}
        >
          {pricing.offers.map((offer) => (
            <motion.li
              key={offer.minQuantity}
              {...(reduced
                ? {}
                : {
                    variants: {
                      hidden: { opacity: 0, y: 10 },
                      shown: { opacity: 1, y: 0, transition: { duration: 0.26, ease: [0.22, 1, 0.36, 1] } },
                    },
                  })}
            >
              <OfferCard
                offer={offer}
                stockKnown={pricing.stockBaseUnits}
                preorderAvailable={pricing.preorderAvailable}
                onSelect={onSelect}
              />
            </motion.li>
          ))}
        </motion.ul>

        {pricing.preorderOffers.length > 0 && (
          <section aria-labelledby="bulk-offers-preorder" className="rounded-lg border border-border px-3 py-2.5">
            <h3 id="bulk-offers-preorder" className="text-xs font-semibold uppercase tracking-wider text-ink-subtle">
              {t('bulkOffers.preorderOnlyTitle')}
            </h3>
            <ul className="mt-1.5 space-y-1 text-sm">
              {pricing.preorderOffers.map((offer) => (
                <li key={offer.minQuantity} className="flex flex-wrap justify-between gap-2 tabular">
                  <span className="text-ink">
                    {t('bulkOffers.buyPieces', { quantity: number(offer.minQuantity) })}
                  </span>
                  <span className="text-ink-muted">
                    {t('bulkOffers.perPiece', { price: formatMoney(offer.unitPrice) })} ·{' '}
                    {t('bulkOffers.savePercent', {
                      percent: formatBasisPoints(offer.savingBasisPoints, intlLocale),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <p className="text-xs leading-relaxed text-ink-muted">{t('bulkOffers.footnote')}</p>
      </div>
    </Modal>
  );
}

function OfferCard({
  offer,
  stockKnown,
  preorderAvailable,
  onSelect,
}: {
  offer: BulkOfferCard;
  stockKnown: number;
  preorderAvailable: boolean;
  onSelect: ((pieces: number) => void) | undefined;
}): React.JSX.Element {
  const { t, intlLocale } = useI18n();
  const number = (value: number): string => value.toLocaleString(intlLocale);

  return (
    <article
      aria-label={t('bulkOffers.cardLabel', { quantity: number(offer.minQuantity) })}
      className={cx(
        'group relative flex h-full flex-col rounded-xl border bg-surface p-4 shadow-card',
        'transition-[box-shadow,transform,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-card-hover',
        'motion-reduce:transform-none motion-reduce:transition-none',
        offer.isCurrent
          ? 'border-brand ring-1 ring-brand/40'
          : offer.isBestValue
            ? 'border-success/50'
            : 'border-border',
      )}
    >
      <div className="flex min-h-6 flex-wrap gap-1.5">
        {offer.isCurrent && <Tag tone="brand">{t('bulkOffers.tag.current')}</Tag>}
        {offer.isNext && <Tag tone="action">{t('bulkOffers.tag.next')}</Tag>}
        {offer.isBestValue && <Tag tone="success">{t('bulkOffers.tag.best')}</Tag>}
        {offer.businessBuyersOnly && <Tag tone="neutral">{t('bulkOffers.tag.business')}</Tag>}
      </div>

      <p className="mt-2 text-sm font-semibold text-ink">
        {t('bulkOffers.buyPieces', { quantity: number(offer.minQuantity) })}
      </p>
      <p className="mt-1 text-2xl font-semibold tabular text-ink">
        {formatMoney(offer.unitPrice)}
        <span className="ml-1 text-sm font-normal text-ink-muted">{t('bulkOffers.eachPiece')}</span>
      </p>
      <p className="text-xs tabular text-ink-subtle">
        <span className="sr-only">{t('bulkOffers.wasLabel')} </span>
        <s>{formatMoney(offer.listUnitPrice)}</s>
        {offer.approximateUnitPrice === null ? null : (
          <span className="ml-2">
            {t('bulkOffers.approximately', { price: formatMoney(offer.approximateUnitPrice) })}
          </span>
        )}
      </p>

      <dl className="mt-3 space-y-1 text-sm tabular">
        <Row label={t('bulkOffers.savePerPiece')} value={formatMoney(offer.savingPerPiece)} highlight />
        <Row
          label={t('bulkOffers.discount')}
          value={formatBasisPoints(offer.savingBasisPoints, intlLocale)}
        />
        <Row
          label={t('bulkOffers.totalFor', { quantity: number(offer.minQuantity) })}
          value={formatMoney(offer.lineTotal)}
        />
        <Row label={t('bulkOffers.totalSaving')} value={formatMoney(offer.totalSaving)} highlight />
      </dl>

      <p className={cx('mt-3 text-xs', offer.withinStock ? 'text-success' : 'text-warning')}>
        {offer.withinStock
          ? t('bulkOffers.inStock')
          : preorderAvailable
            ? t('bulkOffers.needsPreorder', { stock: number(stockKnown) })
            : t('bulkOffers.overStock', { stock: number(stockKnown) })}
      </p>
      {offer.endsAt === null ? null : (
        <p className="text-xs text-ink-muted">
          {t('bulkOffers.endsAt', {
            date: new Date(offer.endsAt).toLocaleDateString(intlLocale, { dateStyle: 'medium' }),
          })}
        </p>
      )}

      <div className="mt-auto pt-3">
        {onSelect === undefined ? null : (
          <Button
            size="md"
            variant={offer.isCurrent ? 'secondary' : 'primary'}
            className="w-full"
            onClick={() => {
              onSelect(offer.minQuantity);
            }}
          >
            {t('bulkOffers.select', { quantity: number(offer.minQuantity) })}
          </Button>
        )}
      </div>
    </article>
  );
}

function Row({ label, value, highlight = false }: { label: string; value: string; highlight?: boolean }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cx('font-medium', highlight ? 'text-success' : 'text-ink')}>{value}</dd>
    </div>
  );
}

const TAG_TONES = {
  brand: 'bg-brand-soft text-brand ring-brand/25',
  action: 'bg-action-soft text-action-strong ring-action/25',
  success: 'bg-success-soft text-success ring-success/25',
  neutral: 'bg-surface-sunken text-ink-muted ring-border',
} as const;

function Tag({ tone, children }: { tone: keyof typeof TAG_TONES; children: React.ReactNode }): React.JSX.Element {
  return (
    <span className={cx('rounded-full px-2 py-0.5 text-xxs font-semibold ring-1 ring-inset', TAG_TONES[tone])}>
      {children}
    </span>
  );
}
