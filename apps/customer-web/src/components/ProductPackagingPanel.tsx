/**
 * Packaging, on the product page.
 *
 * A wholesale buyer's first question about a consumable is not what it costs,
 * it is how it arrives — because that is the unit they order in, the unit their
 * store room counts in, and the unit their own purchase order is written in.
 *
 * The answer is the same for everything in this shop: **one carton, and one
 * carton has 500 pieces.** There is no inner box to get confused with, no
 * per-product carton size to check, and no arithmetic for the buyer to do on a
 * calculator beside the screen. The price above is the price of one of these.
 *
 * Two rules shape what is below.
 *
 *   **The carton is stated, not implied.** Every screen that shows a price
 *   says what the price is the price of, in pieces, in words.
 *
 *   **Nothing here is a piece count from the supplier's sheet.** The server
 *   stopped sending them — see `packaging.service.ts`. A supplier's "2,000 to
 *   a carton" printed beside this shop's carton of 500 is a buyer deciding
 *   which of the two their order was priced at, and one answer is always wrong.
 */
import { formatNumber } from '@/lib/format';
import { usePiecesPerCarton } from '@/lib/packaging';
import type { ProductPackaging } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** The multipliers the ready-reckoner offers. Enough to see the shape of it. */
const LADDER = [1, 2, 5, 10];

/** One term/detail row of the packing breakdown. */
function Row({ term, detail }: { term: string; detail: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-border-subtle py-2 last:border-0">
      <dt className="text-xs text-ink-muted">{term}</dt>
      <dd className="text-right text-xs font-medium tabular text-ink">{detail}</dd>
    </div>
  );
}

/**
 * How it is sold, and what that comes to.
 *
 * The carton line is the centre of it on the OPERATOR's products, and it is
 * shown whether or not the supplier's sheet said anything about packing — it
 * is a fact about this shop, not about the row the importer read.
 *
 * On a third-party seller's product almost none of it applies. There is no
 * carton, so there is no carton size, no "one carton has 500 pieces" and
 * nothing for the ready-reckoner to reckon: one piece is one piece, and a
 * table converting it would be a column of identical numbers. Worse, every
 * one of those lines would be a claim about the seller's listing that is
 * simply untrue, on the page where a buyer goes to check exactly that. So the
 * section says the one thing that IS true about it, plus whatever the seller
 * recorded about their own packing.
 */
export function PackagingSection({
  packaging,
  soldByThePiece = false,
}: {
  packaging: ProductPackaging | null;
  /** True for a third-party seller's product. See above. */
  soldByThePiece?: boolean;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const piecesPerCarton = usePiecesPerCarton();

  if (soldByThePiece) {
    return (
      <section aria-labelledby="packaging-heading" className="min-w-0">
        <h2 id="packaging-heading" className="text-title-sm text-ink">
          {t('packaging.heading')}
        </h2>

        <dl className="mt-3">
          <Row term={t('packaging.soldIn')} detail={t('packaging.soldByThePiece')} />
          {packaging?.packingType != null && (
            <Row term={t('packaging.packedAs')} detail={packaging.packingType} />
          )}
        </dl>

        {/* The same prominence the carton rule gets on the operator's own
            products, because it is answering the same question. */}
        <p
          className="mt-3 rounded-md bg-brand-soft px-3 py-2 text-center text-sm font-medium tabular text-brand"
          data-testid="packing-formula"
        >
          {t('packaging.soldByThePiece')}
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby="packaging-heading" className="min-w-0">
      <h2 id="packaging-heading" className="text-title-sm text-ink">
        {t('packaging.heading')}
      </h2>

      <dl className="mt-3">
        <Row term={t('packaging.soldIn')} detail={t('packaging.outerCarton')} />
        <Row
          term={t('packaging.piecesPerOuter')}
          detail={formatNumber(piecesPerCarton)}
        />
        {packaging?.packingType != null && (
          <Row term={t('packaging.packedAs')} detail={packaging.packingType} />
        )}
      </dl>

      {/* The rule, spelled out.

          The same sentence the cards, the basket and the checkout print, from
          the same number, so a buyer who reads it four times reads it the same
          way four times. */}
      <p
        className="mt-3 rounded-md bg-brand-soft px-3 py-2 text-center text-sm font-medium tabular text-brand"
        data-testid="packing-formula"
      >
        {t('packaging.oneCartonHas', { n: formatNumber(piecesPerCarton) })}
      </p>

      {/* The ready-reckoner.

          Not a form and not a stepper: it answers "if I order N cartons, how
          many pieces is that" for the handful of N a buyer actually types,
          without anybody having to type anything. The real quantity control is
          in the buy panel, where it belongs. */}
      <div className="mt-4 overflow-hidden rounded-md border border-border">
        <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-sunken px-3 py-2">
          <h3 className="text-xs font-semibold text-ink">{t('packaging.howManyIsThat')}</h3>
        </div>

        {/* No <caption>: the heading directly above says the same words, and
            a screen reader would otherwise announce them twice before
            reaching the first row. */}
        <table className="w-full text-xs">
          <tbody>
            {LADDER.map((count) => (
              <tr key={count} className="border-b border-border-subtle last:border-0">
                <th scope="row" className="px-3 py-1.5 text-left font-normal text-ink-muted">
                  {t('packaging.nCartons', { n: formatNumber(count) })}
                </th>
                <td className="px-3 py-1.5 text-right font-medium tabular text-ink">
                  {t('packaging.nPieces', { n: formatNumber(count * piecesPerCarton) })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* A carton is not a minimum, and a B2B buyer who has met both will
          assume it is unless told otherwise. */}
      <p className="mt-3 text-xxs leading-relaxed text-ink-subtle">
        {t('packaging.notAMinimum')}
      </p>
    </section>
  );
}

/**
 * The box sizes.
 *
 * Shown as the source gave them. Where no unit was written down, the number is
 * shown with the fact that it has no unit rather than with an assumed "mm" —
 * assuming millimetres onto a measurement given in inches is a twenty-five-fold
 * error in a figure somebody sizes a shelf or a pallet against.
 *
 * The sticker artwork size never reaches here: the server does not send it. It
 * is a print specification for the operator's label supplier, and a buyer
 * reading it in a list of box sizes would measure a shelf against a label.
 */
export function DimensionsSection({
  packaging,
}: {
  packaging: ProductPackaging | null;
}): React.JSX.Element | null {
  const { t } = useI18n();

  if (packaging === null || packaging.dimensions.length === 0) return null;

  const anyWithoutUnit = packaging.dimensions.some((dimension) => !dimension.hasUnit);

  return (
    <section aria-labelledby="dimensions-heading" className="min-w-0">
      <h2 id="dimensions-heading" className="text-title-sm text-ink">
        {t('packaging.dimensionsHeading')}
      </h2>

      <dl className="mt-3">
        {packaging.dimensions.map((dimension) => (
          <Row
            key={dimension.kind}
            term={t(`packaging.dimension.${dimension.kind}` as 'packaging.dimension.PRIMARY_PACK')}
            detail={dimension.value}
          />
        ))}
      </dl>

      {anyWithoutUnit && (
        <p className="mt-2 text-xxs leading-relaxed text-ink-subtle">
          {t('packaging.unitNotStated')}
        </p>
      )}
    </section>
  );
}
