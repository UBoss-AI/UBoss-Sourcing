/**
 * The chart primitives.
 *
 * Hand-built SVG and CSS on the theme's own tokens rather than a charting
 * library: both themes are token-driven and audited, and a library would need
 * theming twice and re-checking twice to draw four divs.
 *
 * Only the part-to-whole bar lives here. The console's copy of this file also
 * carries a sparkline and a period-over-period delta, which this portal has no
 * data to feed - the carrier dashboard is a snapshot of now, with no day series
 * and no previous window - so they are deliberately absent rather than present
 * and unused.
 *
 * Fixed specs, so two charts on one screen look like one system: a 2px surface
 * gap between touching fills, 4px rounding on the outer data-ends only, a fill
 * no taller than 10px in a 24px track, and a legend that always carries the
 * numbers. A value is never only in a hover.
 */
import { useState } from 'react';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// Proportion bar
// ---------------------------------------------------------------------------

export interface ProportionSegment {
  /** Stable key. Also the React key, so a language switch does not remount. */
  id: string;
  label: string;
  value: number;
  /**
   * Which step of the ordinal ramp, 1-6, or one of two colours that sit
   * outside it: `danger` for an outcome that is a problem rather than a
   * stage, and `neutral` for something that has not entered the sequence at
   * all. Never the segment's rank in the list: colour follows the thing, so
   * filtering the list does not repaint the survivors.
   */
  step: 1 | 2 | 3 | 4 | 5 | 6 | 'danger' | 'neutral';
  /** Optional second fact for the legend — a money total, say. */
  detail?: string | undefined;
}

const STEP_FILL: Record<ProportionSegment['step'], string> = {
  1: 'bg-chart-seq-1',
  2: 'bg-chart-seq-2',
  3: 'bg-chart-seq-3',
  4: 'bg-chart-seq-4',
  5: 'bg-chart-seq-5',
  6: 'bg-chart-seq-6',
  danger: 'bg-danger-fill',
  neutral: 'bg-border-strong',
};

/**
 * Part-to-whole, horizontally, with its own legend.
 *
 * Horizontal rather than a column or a pie for two reasons: the categories
 * here have long names ("Pending payment", "Awaiting approval"), which a
 * column chart cannot label without turning them sideways; and the reader's
 * question is "how much of the whole is stuck in the first stage", which is a
 * length comparison against a common baseline.
 *
 * The separation between segments is a 2px gap in the surface colour, not a
 * stroke. A stroke around every segment adds a ring of ink that is not data
 * and, at these widths, is most of what you see.
 *
 * Every number in the bar is also in the legend underneath it, so the chart is
 * never the only way to read a value, and each segment is focusable with the
 * same text a pointer gets from hovering.
 */
export function ProportionBar({
  segments,
  total,
  formatShare,
  className,
}: {
  segments: ProportionSegment[];
  /** The whole. Passed in rather than summed: the caller knows whether the
   *  denominator is "these segments" or "every order in the period". */
  total: number;
  /** Renders one segment's share, e.g. `(n) => '42%'`. */
  formatShare: (value: number, total: number) => string;
  className?: string;
}): React.JSX.Element | null {
  const [active, setActive] = useState<string | null>(null);

  const shown = segments.filter((segment) => segment.value > 0);
  if (shown.length === 0 || total <= 0) return null;

  return (
    <div className={className}>
      {/*
        The track is 24px tall while the fill is 10px, so a pointer has
        something it can actually land on without the bar becoming a slab.

        `aria-hidden`, like the Meter beside it on this page: the bar is a
        redundant encoding of the legend directly underneath it, which carries
        every label, count and share as text. Making each segment focusable
        would add six tab stops that announce exactly what the next six lines
        already say.
      */}
      <div aria-hidden="true" className="relative flex h-6 items-center gap-0.5">
        {shown.map((segment, index) => {
          const share = (segment.value / total) * 100;
          const isFirst = index === 0;
          const isLast = index === shown.length - 1;

          return (
            <span
              key={segment.id}
              onMouseEnter={() => {
                setActive(segment.id);
              }}
              onMouseLeave={() => {
                setActive(null);
              }}
              className={cx(
                'group flex h-6 shrink-0 cursor-default items-center',
                // A segment narrower than this is a sliver nobody can point
                // at. It stops being proportional below about 3% and that is
                // the right trade: the legend carries the exact figure.
                'min-w-[0.5rem]',
              )}
              style={{ width: `${String(Math.max(share, 2))}%` }}
            >
              <span
                className={cx(
                  'h-2.5 w-full transition-[height,opacity]',
                  STEP_FILL[segment.step],
                  // 4px rounding on the outer data-ends only. The interior
                  // joins stay square, so the bar reads as one measured length
                  // rather than a row of separate pills.
                  isFirst && 'rounded-l',
                  isLast && 'rounded-r',
                  active === segment.id && 'h-3.5',
                  active !== null && active !== segment.id && 'opacity-55',
                )}
              />
            </span>
          );
        })}
      </div>

      {/*
        The legend. Always present — this is two or more series, so identity
        never rests on colour-matching alone — and it carries the counts, which
        is what makes the bar an illustration of the numbers rather than the
        only place they exist.
      */}
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {shown.map((segment) => (
          <li
            key={segment.id}
            className={cx(
              'flex items-baseline gap-2 text-xxs transition-opacity',
              active !== null && active !== segment.id && 'opacity-55',
            )}
          >
            <span
              aria-hidden="true"
              className={cx('mt-[0.2rem] h-2 w-2 shrink-0 rounded-sm', STEP_FILL[segment.step])}
            />
            <span className="text-ink-muted">{segment.label}</span>
            <span className="tabular font-semibold text-ink">{segment.value}</span>
            <span className="tabular text-ink-subtle">
              {formatShare(segment.value, total)}
              {segment.detail === undefined ? '' : ` · ${segment.detail}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
