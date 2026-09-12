/**
 * Packaging and ordering, on the product page.
 *
 * A wholesale buyer's first question about a consumable is not what it costs,
 * it is how it is boxed — because that is the unit they order in, the unit
 * their store room counts in, and the unit their own purchase order is written
 * in. A page that shows a price per piece and nothing else makes them do the
 * arithmetic, and they will do it on a calculator beside the screen and
 * sometimes get it wrong.
 *
 * Three rules shape what is below.
 *
 *   **The inner box and the outer carton are never confused.** They are
 *   different words, different rows, and different numbers, and the formula
 *   spells out which multiplies into which. Getting them the wrong way round is
 *   a twentyfold error in what arrives on a pallet.
 *
 *   **Nothing is inferred in the browser.** Every figure here came off the
 *   server, which read it from the supplier's own text. Where the source said
 *   only "400 pieces per carton", the inner-box row is absent rather than
 *   filled with a plausible guess.
 *
 *   **Packing is not a minimum.** A carton of 2,000 does not mean 2,000 is the
 *   least somebody may buy. The minimum order quantity is a separate rule, set
 *   deliberately by the operator, and it is shown in the ordering panel where
 *   it belongs. This section offers a convenient way to count, not a floor.
 */
import { useState } from 'react';
import { formatNumber } from '@/lib/format';
import {
  availableUnits,
  piecesPerUnit,
  pluralisePack,
  unitLabel,
  type OrderingUnit,
} from '@/lib/packaging';
import type { ProductPackaging } from '@/lib/types';
import { useI18n } from '@/i18n/i18n-context';

/** The multipliers the ready-reckoner offers. Enough to see the shape of it. */
const LADDER = [1, 2, 5, 10];

/**
 * The unit a customer is counting in.
 *
 * A segmented control rather than a dropdown: there are at most three options,
 * they are the whole point of the section, and a closed dropdown hides the fact
 * that ordering by the carton is possible at all.
 *
 * Only units the catalogue can actually convert appear — see `availableUnits`.
 * Offering "carton" for a product whose carton quantity nobody recorded would
 * be offering a conversion that has to be refused at the basket.
 */
export function OrderingUnitTabs({
  packaging,
  value,
  onChange,
}: {
  packaging: ProductPackaging | null;
  value: OrderingUnit;
  onChange: (unit: OrderingUnit) => void;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const units = availableUnits(packaging);

  // One option is not a choice, and a control with a single button reads as
  // broken rather than as simple.
  if (units.length < 2) return null;

  return (
    <div>
      <span id="ordering-unit-label" className="text-xs font-medium text-ink-muted">
        {t('packaging.orderIn')}
      </span>
      <div
        role="radiogroup"
        aria-labelledby="ordering-unit-label"
        className="mt-1.5 inline-flex rounded-md border border-border bg-surface-sunken p-0.5"
      >
        {units.map((unit) => {
          const isActive = unit === value;
          const per = piecesPerUnit(unit, packaging) ?? 1;

          return (
            <button
              key={unit}
              type="button"
              role="radio"
              aria-checked={isActive}
              onClick={() => {
                onChange(unit);
              }}
              className={
                'rounded px-3 py-1.5 text-xs font-medium transition-colors ' +
                (isActive
                  ? 'bg-surface text-ink shadow-card'
                  : 'text-ink-muted hover:text-ink')
              }
            >
              {unitLabel(unit, packaging, t)}
              {unit !== 'PIECE' && (
                <span className="tabular text-ink-subtle"> {t('packaging.ofN', { n: formatNumber(per) })}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

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
 * How it is packed, what a carton holds, and what that comes to.
 *
 * The formula line is the centre of it: "100 pieces × 20 boxes = 2,000 pieces"
 * is the whole relationship in one glance, and it is built on the server so the
 * sentence here and the arithmetic in the basket cannot drift apart.
 */
export function PackagingSection({
  packaging,
}: {
  packaging: ProductPackaging | null;
}): React.JSX.Element | null {
  const { t } = useI18n();
  const [countedIn, setCountedIn] = useState<OrderingUnit>('OUTER_CARTON');

  if (packaging === null) return null;

  const perInner = packaging.piecesPerInnerPack;
  const perOuter = piecesPerUnit('OUTER_CARTON', packaging);
  const packsPerOuter = packaging.innerPacksPerOuterCarton;

  const units = availableUnits(packaging);
  // The ready-reckoner counts in the largest unit the catalogue knows, because
  // that is the one a buyer actually orders in. Pieces alone makes it a
  // multiplication table, which helps nobody.
  const ladderUnit: OrderingUnit = units.includes(countedIn)
    ? countedIn
    : (units[units.length - 1] ?? 'PIECE');
  const perLadderUnit = piecesPerUnit(ladderUnit, packaging) ?? 1;

  const hasFigures = perInner !== null || perOuter !== null;

  return (
    <section aria-labelledby="packaging-heading" className="min-w-0">
      <h2 id="packaging-heading" className="text-title-sm text-ink">
        {t('packaging.heading')}
      </h2>

      <dl className="mt-3">
        {packaging.packingType !== null && (
          <Row term={t('packaging.packedAs')} detail={packaging.packingType} />
        )}
        {perInner !== null && (
          <Row
            term={t('packaging.piecesPerInner', {
              pack: (packaging.innerPackType ?? t('packaging.innerPack')).toLowerCase(),
            })}
            detail={formatNumber(perInner)}
          />
        )}
        {packsPerOuter !== null && (
          <Row
            term={t('packaging.innersPerOuter', {
              // Capitalised, unlike the row above it: this one starts the
              // label, and "box per carton" reads as a typo in a term column.
              pack: packaging.innerPackType ?? t('packaging.innerPack'),
            })}
            detail={formatNumber(packsPerOuter)}
          />
        )}
        {perOuter !== null && (
          <Row term={t('packaging.piecesPerOuter')} detail={formatNumber(perOuter)} />
        )}
      </dl>

      {/* The relationship, spelled out.

          Built on the server rather than assembled here, so the sentence the
          customer reads and the multiplication the basket performs come from
          one place. A page that said "× 20 boxes" beside a basket that
          multiplied by 10 would be a dispute nobody could settle. */}
      {packaging.formula !== null && (
        <p
          className="mt-3 rounded-md bg-brand-soft px-3 py-2 text-center text-sm font-medium tabular text-brand"
          data-testid="packing-formula"
        >
          {packaging.formula}
        </p>
      )}

      {/* Where the supplier's own arithmetic did not add up.

          Said plainly rather than hidden, and the pack units are withheld from
          the calculator at the same time — see `isReliable`. A buyer deciding
          between two suppliers deserves to know the figure is unconfirmed, and
          an operator who sees this on their own storefront knows to go and fix
          the sheet. */}
      {!packaging.isReliable && packaging.sourceText !== null && (
        <p className="mt-3 rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">
          {t('packaging.needsConfirming', { source: packaging.sourceText })}
        </p>
      )}

      {/* The ready-reckoner.

          Not a form and not a stepper: it answers "if I order N, how many is
          that" for the handful of N a buyer actually types, without anybody
          having to type anything. The real quantity control is in the buy
          panel, where it belongs. */}
      {hasFigures && packaging.isReliable && ladderUnit !== 'PIECE' && (
        <div className="mt-4 overflow-hidden rounded-md border border-border">
          <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-sunken px-3 py-2">
            <h3 className="text-xs font-semibold text-ink">{t('packaging.howManyIsThat')}</h3>
            {units.length > 2 && (
              <label className="flex items-center gap-1.5 text-xxs text-ink-muted">
                {t('packaging.countIn')}
                <select
                  value={ladderUnit}
                  onChange={(event) => {
                    setCountedIn(event.target.value as OrderingUnit);
                  }}
                  className="rounded border border-border bg-surface px-1.5 py-0.5 text-xxs text-ink"
                >
                  {units
                    .filter((unit) => unit !== 'PIECE')
                    .map((unit) => (
                      <option key={unit} value={unit}>
                        {unitLabel(unit, packaging, t)}
                      </option>
                    ))}
                </select>
              </label>
            )}
          </div>

          {/* No <caption>: the heading directly above says the same words, and
              a screen reader would otherwise announce them twice before
              reaching the first row. */}
          <table className="w-full text-xs">
            <tbody>
              {LADDER.map((count) => (
                <tr key={count} className="border-b border-border-subtle last:border-0">
                  <th scope="row" className="px-3 py-1.5 text-left font-normal text-ink-muted">
                    {t('packaging.nUnits', {
                      n: formatNumber(count),
                      unit: pluralisePack(unitLabel(ladderUnit, packaging, t).toLowerCase(), count),
                    })}
                  </th>
                  <td className="px-3 py-1.5 text-right font-medium tabular text-ink">
                    {t('packaging.nPieces', { n: formatNumber(count * perLadderUnit) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Packing is not a minimum, and a B2B buyer who has met both will
          assume it is unless told otherwise. */}
      {hasFigures && (
        <p className="mt-3 text-xxs leading-relaxed text-ink-subtle">
          {t('packaging.notAMinimum')}
        </p>
      )}
    </section>
  );
}

/**
 * The three box sizes.
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
