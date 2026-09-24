/**
 * The bulk-savings popover, anchored under the product page's quantity box.
 *
 * WHAT IT SAYS
 *
 * One headline, chosen in this order, because each is more useful than the
 * next: "only N in stock - preorder the rest", "add 20 more to pay 9.20 each",
 * "you are saving 5% at this quantity". Beneath it, what one piece costs in
 * each way of buying it - loose, by the carton, by the pallet, by the
 * container - so a buyer can see a pallet is cheaper per piece without doing
 * the division. Every figure is the server's (`GET /catalog/bulk-pricing`),
 * priced by the function the basket uses: what it promises is what the
 * checkout charges.
 *
 * HOW IT BEHAVES
 *
 *   - Non-modal. It never takes focus and never covers the Add button; it is
 *     a card with a caret pointing at the box it describes.
 *   - The headline is an `aria-live="polite"` region, so a screen reader hears
 *     the new saving when the quantity changes, once, after typing settles.
 *   - It springs in and cross-fades its figures. Under `prefers-reduced-motion`
 *     it simply appears and changes, with nothing lost but movement.
 *   - Dismissed with ×, for this product and version, for the session.
 *
 * THE GALAXY
 *
 * Every time the buyer INCREASES the quantity, a small rotating galaxy springs
 * out of the quantity box first - the page visibly "working out" the price -
 * and hands over to the card once the new figures are in (at least
 * `GALAXY_MIN_MS`, at most `GALAXY_MAX_MS`). After an increase the card is
 * always shown: the saving where there is one, and otherwise the price per
 * piece and the line total, saying plainly that this product has no bulk
 * discount yet. Lowering the quantity goes straight to the figures. Under
 * reduced motion there is no galaxy at all; the card still appears. It announces "checking bulk prices" politely, so
 * a screen reader hears the step, then the saving.
 *
 * Original work, in the manner of Aceternity UI's "animated tooltip" (a
 * spring-scaled card that follows its anchor). No third-party code is copied.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useSearchParams } from 'react-router-dom';

import { PREORDER_INTENT_PARAM } from '@/components/preorder/PreorderButton';
import { useI18n } from '@/i18n/i18n-context';
import type { TranslationKey } from '@/i18n/i18n-context';
import {
  type BulkPricing,
  formatBasisPoints,
  hasSomethingToSay,
  isDismissed,
  rememberDismissed,
} from '@/lib/bulk-pricing';
import { cx } from '@/lib/cx';
import { Button } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import { useBulkPricing } from '@/lib/use-bulk-pricing';
import { GalaxyCanvas } from '@/components/ui/galaxy-canvas';

/** The galaxy stays at least this long, so it reads as a moment rather than a flicker. */
const GALAXY_MIN_MS = 900;
/** And never longer than this, even if the network is slow. */
const GALAXY_MAX_MS = 2600;

export function BulkSavingsPopover({
  productId,
  variantId,
  pieces,
  displayCurrency,
  onSetPieces,
  className,
}: {
  productId: string;
  variantId: string | null;
  /** The pieces the buyer has chosen. */
  pieces: number;
  displayCurrency: string | null;
  /**
   * Set the quantity, in pieces, when the buyer takes the suggestion. Omitted
   * where the page counts in something else (cartons of the operator's own,
   * or several versions at once) - the suggestion is then shown, not offered.
   */
  onSetPieces?: ((pieces: number) => void) | undefined;
  className?: string | undefined;
}): React.JSX.Element | null {
  const { t, intlLocale } = useI18n();
  const reduced = useReducedMotion() ?? false;
  const headingId = useId();
  const [, setSearchParams] = useSearchParams();
  const [dismissed, setDismissed] = useState(() => isDismissed(productId, variantId));

  // The galaxy: shown on every increase, until the new price is in. Then the
  // card, whatever it has to say - `interacted` keeps it up after an increase
  // even on a product with no bulk discount.
  const [galaxy, setGalaxy] = useState(false);
  const [interacted, setInteracted] = useState(false);
  const previousPieces = useRef(pieces);
  const galaxyShownAt = useRef(0);
  const latest = useRef<BulkPricing | undefined>(undefined);
  useEffect(() => {
    const increased = pieces > previousPieces.current;
    previousPieces.current = pieces;
    const known = latest.current;
    // Not on a product that cannot be bought at all (price on request, off
    // sale): there would be nothing to hand over to.
    const purchasable = known === undefined || known.available;
    if (increased && purchasable && !dismissed) {
      setInteracted(true);
      if (!reduced) {
        galaxyShownAt.current = Date.now();
        setGalaxy(true);
      }
    }
  }, [pieces, reduced, dismissed]);

  useEffect(() => {
    setDismissed(isDismissed(productId, variantId));
  }, [productId, variantId]);

  // Shared with the page's price summary: one fetch, one set of figures.
  const { query, quantity } = useBulkPricing({
    productId,
    variantId,
    pieces,
    displayCurrency,
    enabled: !dismissed,
  });

  const pricing = query.data;
  latest.current = pricing;
  const settledOnCurrent = quantity === Math.max(1, pieces) && !query.isFetching;
  useEffect(() => {
    if (!galaxy) return undefined;
    const check = window.setInterval(() => {
      const shownFor = Date.now() - galaxyShownAt.current;
      if ((shownFor >= GALAXY_MIN_MS && settledOnCurrent) || shownFor >= GALAXY_MAX_MS) {
        setGalaxy(false);
      }
    }, 100);
    return () => {
      window.clearInterval(check);
    };
  }, [galaxy, settledOnCurrent]);

  const visible =
    !dismissed &&
    !galaxy &&
    pricing !== undefined &&
    pricing.available &&
    (interacted || hasSomethingToSay(pricing));

  const headline = (() => {
    if (pricing === undefined || !pricing.available) return null;
    if (pricing.exceedsStock) {
      return t('bulkSavings.overStock', {
        count: pricing.stockBaseUnits,
        stock: pricing.stockBaseUnits.toLocaleString(intlLocale),
      });
    }
    if (pricing.next !== null && pricing.current.savingBasisPoints > 0) {
      // A band already applies AND a better one is in reach: say both.
      return t('bulkSavings.appliedAndNext', {
        count: pricing.next.addQuantity,
        price: formatMoney(pricing.current.unitPrice),
        percent: formatBasisPoints(pricing.current.savingBasisPoints, intlLocale),
        more: pricing.next.addQuantity.toLocaleString(intlLocale),
        nextPrice: formatMoney(pricing.next.unitPrice),
      });
    }
    if (pricing.next !== null) {
      return t('bulkSavings.addMore', {
        count: pricing.next.addQuantity,
        more: pricing.next.addQuantity.toLocaleString(intlLocale),
        price: formatMoney(pricing.next.unitPrice),
        saving: formatMoney(pricing.next.savingPerPiece),
      });
    }
    if (pricing.current.savingBasisPoints > 0) {
      return t('bulkSavings.saving', {
        percent: formatBasisPoints(pricing.current.savingBasisPoints, intlLocale),
        amount: formatMoney(pricing.current.saving),
      });
    }
    if (pricing.units.some((unit) => unit.unit !== 'PIECE' && unit.savingBasisPoints > 0)) {
      return t('bulkSavings.cheaperInBulk');
    }
    return t('bulkSavings.noDiscount', {
      count: pricing.quantity,
      quantity: pricing.quantity.toLocaleString(intlLocale),
      price: formatMoney(pricing.current.unitPrice),
      total: formatMoney(pricing.current.lineTotal),
    });
  })();

  const spring = reduced
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 30, mass: 0.7 };

  return (
    <AnimatePresence initial={!reduced} mode="wait">
      {galaxy && !dismissed && (
        <motion.section
          key="galaxy"
          aria-label={t('bulkSavings.title')}
          initial={{ opacity: 0, y: -8, scale: 0.9, rotate: -2 }}
          animate={{ opacity: 1, y: 0, scale: 1, rotate: 0 }}
          // Short, fixed fades: with mode="wait" the card cannot enter until
          // the galaxy has fully left, and a spring on opacity takes seconds
          // to come to rest - which showed as an empty gap.
          exit={{ opacity: 0, scale: 1.03, filter: 'blur(3px)', transition: { duration: 0.18 } }}
          transition={{
            default: { type: 'spring', stiffness: 380, damping: 26, mass: 0.7 },
            opacity: { duration: 0.15 },
          }}
          style={{ transformOrigin: '2.5rem 0' }}
          className={cx('relative mt-3', className)}
        >
          <span
            aria-hidden="true"
            className="absolute -top-1.5 left-8 h-3 w-3 rotate-45 bg-[#140f2e]"
          />
          <div
            className={cx(
              'relative h-32 overflow-hidden rounded-lg',
              'bg-[radial-gradient(ellipse_at_center,#3b2a86_0%,#1a1242_50%,#090617_100%)]',
              'shadow-[0_1px_2px_rgba(15,23,42,0.2),0_18px_40px_-14px_rgba(40,20,120,0.55)]',
            )}
          >
            <GalaxyCanvas className="absolute inset-0 h-full w-full" />
            <div className="relative flex h-full flex-col items-center justify-center px-4 text-center [text-shadow:0_1px_2px_rgba(0,0,0,0.9),0_0_14px_rgba(9,6,23,0.95)]">
              <p className="text-xxs font-semibold uppercase tracking-[0.2em] text-white/70">
                {t('bulkSavings.title')}
              </p>
              <p role="status" className="mt-1 text-sm font-medium text-white">
                {t('bulkSavings.checking', {
                  count: Math.max(1, pieces),
                  quantity: Math.max(1, pieces).toLocaleString(intlLocale),
                })}
              </p>
            </div>
          </div>
        </motion.section>
      )}
      {visible && (
        <motion.section
          key="bulk-savings"
          aria-labelledby={headingId}
          initial={reduced ? { opacity: 1 } : { opacity: 0, y: -6, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={
            reduced
              ? { opacity: 0 }
              : { opacity: 0, y: -4, scale: 0.97, transition: { duration: 0.15 } }
          }
          transition={reduced ? spring : { default: spring, opacity: { duration: 0.18 } }}
          style={{ transformOrigin: '2.5rem 0' }}
          className={cx('relative mt-3', className)}
        >
          {/* The caret: points at the quantity box this card describes. */}
          <span
            aria-hidden="true"
            className="absolute -top-1.5 left-8 h-3 w-3 rotate-45 border-l border-t border-brand/30 bg-surface"
          />
          <div
            className={cx(
              'rounded-lg border border-brand/30 bg-surface px-4 py-3',
              // Layered shadows: a close contact shadow and a wide soft one,
              // so the card reads as lifted off the page rather than printed on it.
              'shadow-[0_1px_2px_rgba(15,23,42,0.08),0_12px_32px_-12px_rgba(15,23,42,0.28)]',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <h3
                id={headingId}
                className="text-xxs font-semibold uppercase tracking-wider text-brand"
              >
                {t('bulkSavings.title')}
              </h3>
              <button
                type="button"
                className="-m-1 rounded p-1 text-ink-subtle hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
                aria-label={t('bulkSavings.dismiss')}
                onClick={() => {
                  rememberDismissed(productId, variantId);
                  setDismissed(true);
                }}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <div aria-live="polite" aria-atomic="true" className="mt-1 min-h-[1.25rem]">
              <AnimatePresence mode="wait" initial={false}>
                <motion.p
                  key={headline ?? ''}
                  initial={reduced ? { opacity: 1 } : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? { opacity: 1 } : { opacity: 0, y: -4 }}
                  transition={reduced ? { duration: 0 } : { duration: 0.18 }}
                  className="text-sm font-medium text-ink"
                >
                  {headline}
                </motion.p>
              </AnimatePresence>
            </div>

            {pricing.approximate !== null && (
              <p className="mt-0.5 text-xs text-ink-muted">
                {t('bulkSavings.approximate', {
                  price: formatMoney(pricing.approximate.unitPrice),
                })}
              </p>
            )}

            <div className="mt-2 flex flex-wrap gap-2">
              {pricing.exceedsStock && pricing.preorderAvailable && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => {
                    setSearchParams(
                      (current) => {
                        const next = new URLSearchParams(current);
                        next.set(PREORDER_INTENT_PARAM, '1');
                        return next;
                      },
                      { replace: true },
                    );
                  }}
                >
                  {t('bulkSavings.preorderRest')}
                </Button>
              )}
              {!pricing.exceedsStock && pricing.next !== null && onSetPieces !== undefined && (
                <button
                  type="button"
                  className="rounded-md border border-brand/40 px-3 py-1.5 text-xs font-semibold text-brand hover:bg-brand-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  onClick={() => {
                    if (pricing.next !== null) onSetPieces(pricing.next.minQuantity);
                  }}
                >
                  {t('bulkSavings.takeIt', {
                    quantity: pricing.next.minQuantity.toLocaleString(intlLocale),
                  })}
                </button>
              )}
            </div>

            {pricing.units.length > 1 && (
              <table className="mt-3 w-full text-xs tabular">
                <caption className="sr-only">{t('bulkSavings.perPieceCaption')}</caption>
                <thead>
                  <tr className="text-left text-ink-subtle">
                    <th scope="col" className="pb-1 font-medium">
                      {t('bulkSavings.buyBy')}
                    </th>
                    <th scope="col" className="pb-1 text-right font-medium">
                      {t('bulkSavings.perPiece')}
                    </th>
                    <th scope="col" className="pb-1 text-right font-medium">
                      {t('bulkSavings.save')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {pricing.units.map((unit) => (
                    <tr key={unit.unit} className="border-t border-border-subtle">
                      <th scope="row" className="py-1 text-left font-normal text-ink">
                        {unit.unit === 'PIECE'
                          ? t('bulkSavings.unit.PIECE')
                          : t(`bulkSavings.unit.${unit.unit}` as TranslationKey, {
                              pieces: unit.piecesPerUnit.toLocaleString(intlLocale),
                            })}
                      </th>
                      <td className="py-1 text-right text-ink">{formatMoney(unit.perPiece)}</td>
                      <td className="py-1 text-right text-success">
                        {unit.savingBasisPoints > 0
                          ? formatBasisPoints(unit.savingBasisPoints, intlLocale)
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {pricing.preorderBands.length > 0 && (
              <p className="mt-2 text-xs text-ink-muted">
                {t('bulkSavings.preorderBand', {
                  quantity: (pricing.preorderBands[0]?.minQuantity ?? 0).toLocaleString(intlLocale),
                  price: formatMoney(pricing.preorderBands[0]?.unitPrice),
                })}
              </p>
            )}
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
