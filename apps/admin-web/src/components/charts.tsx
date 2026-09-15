/**
 * The chart primitives.
 *
 * Hand-built SVG and CSS on the theme's own tokens, deliberately, rather than
 * a charting library. Three reasons, in order of how much they mattered:
 *
 *   1. Both themes are token-driven and audited. A library brings its own
 *      colour model, and every one of these would then need theming twice and
 *      re-checking twice.
 *   2. Nothing here needs axes, zooming, brushing or a legend engine. A
 *      sparkline is a polyline and a part-to-whole bar is six divs.
 *   3. It is the same reasoning the rest of the panel already follows: the map
 *      is MapLibre because nothing else draws a map, and there is no second
 *      implementation of anything that a `<div>` can do.
 *
 * The specs below are fixed across every chart in the panel, so two charts on
 * one screen look like one system: 2px lines, a ~10% area wash, markers of at
 * least 8px carrying a 2px surface ring, a 2px surface gap between touching
 * fills, 4px rounding only on a bar's outer data-ends, and hairline chrome one
 * step off the surface. The data is the only thing allowed to be loud.
 *
 * Three rules that are not negotiable here, because breaking any of them makes
 * a chart lie:
 *
 *   - **A value is never only in a tooltip.** Every chart on this screen has a
 *     legend carrying its numbers and, under it, the table the figures came
 *     from. Hover is an enhancement.
 *   - **A gap in time is a zero, not a missing point.** The sales series only
 *     contains days that had orders, so a sparkline drawn straight from it
 *     would space eight days evenly across a month and invent a shape. The
 *     series is filled against the window before it is plotted.
 *   - **No comparison is not zero per cent.** A period whose predecessor had
 *     nothing to compare against says so, rather than showing an infinite or
 *     invented rise.
 */
import { useId, useState } from 'react';
import { cx } from '@/lib/cx';

// ---------------------------------------------------------------------------
// Sparkline
// ---------------------------------------------------------------------------

/**
 * The shape of the period behind a headline figure.
 *
 * No axes, no gridlines, no labels: a stat tile's job is the number, and the
 * line is there to say whether the number arrived steadily or in one day. The
 * exact values live in the tile's own caption and in the report the tile links
 * to, so nothing is readable only from the curve.
 *
 * `viewBox` plus `preserveAspectRatio="none"` lets one path stretch to whatever
 * width the tile turns out to be, which is what keeps it from needing a resize
 * observer. The stroke is drawn with `vector-effect="non-scaling-stroke"` so
 * that stretch does not make the 2px line 5px wide at one end of the card.
 */
export function Sparkline({
  points,
  label,
  className,
}: {
  /** One value per bucket, already gap-filled and in time order. */
  points: number[];
  /** What the line is, for a reader who cannot see it. */
  label: string;
  className?: string;
}): React.JSX.Element | null {
  const gradientId = useId();

  // Fewer than two points is not a trend. A tile showing one day of history
  // renders no line at all rather than a dot floating in an empty box.
  if (points.length < 2) return null;

  const width = 100;
  const height = 28;
  const max = Math.max(...points);
  const min = Math.min(...points);
  // A flat series sits on the baseline rather than dividing by zero and
  // landing every point at NaN. All-equal values are a real case: thirty days
  // of exactly one order a day is flat, and it should look flat.
  const span = max - min || 1;

  const x = (index: number): number => (index / (points.length - 1)) * width;
  const y = (value: number): number => height - ((value - min) / span) * (height - 3) - 1.5;

  const line = points.map((value, index) => `${String(x(index))},${String(y(value))}`).join(' ');
  const area = `${String(x(0))},${String(height)} ${line} ${String(width)},${String(height)}`;

  const lastIndex = points.length - 1;

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      className={cx('h-7 w-full overflow-visible', className)}
    >
      <defs>
        {/*
          The wash fades out downwards. A flat ~10% block reads as a second
          filled shape competing with the line; a fade reads as the line's own
          shadow, which is what it is meant to be.
        */}
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--brand))" stopOpacity="0.16" />
          <stop offset="100%" stopColor="rgb(var(--brand))" stopOpacity="0" />
        </linearGradient>
      </defs>

      <polygon points={area} fill={`url(#${gradientId})`} />

      <polyline
        points={line}
        fill="none"
        stroke="rgb(var(--brand))"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {/*
        The end marker, ringed in the surface colour so it stays a dot where
        the line runs underneath it. It marks *now*, which is the one point on
        a sparkline anybody looks for.
      */}
      <circle
        cx={x(lastIndex)}
        cy={y(points[lastIndex] ?? 0)}
        r="2.5"
        fill="rgb(var(--brand))"
        stroke="rgb(var(--surface))"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

/**
 * The change against the period before this one.
 *
 * Carries an arrow as well as a colour, because "up" must survive being read
 * by somebody who cannot tell the green from the red — and being printed.
 *
 * `higherIsBetter` exists because direction and goodness are not the same
 * thing. Sales rising is good; refunds rising is not, and colouring both green
 * would be actively misleading.
 */
export function Delta({
  current,
  previous,
  higherIsBetter = true,
  periodLabel,
  noComparisonLabel,
}: {
  current: number;
  previous: number;
  higherIsBetter?: boolean;
  /** "vs previous 30 days" — the comparison is named, never implied. */
  periodLabel: string;
  /** Shown where the previous period holds nothing to compare against. */
  noComparisonLabel: string;
}): React.JSX.Element {
  /*
   * A previous period of zero has no percentage. "Up 100%" from nothing is
   * arithmetic, not information, and "up infinity per cent" is what a
   * dashboard prints the day after go-live on every tile at once. So the tile
   * says there is nothing to compare with and stops.
   */
  if (previous === 0) {
    return <p className="mt-1.5 text-xxs text-ink-subtle">{noComparisonLabel}</p>;
  }

  const change = ((current - previous) / Math.abs(previous)) * 100;
  // Below a tenth of a per cent, a signed arrow overstates it. Flat is flat.
  const flat = Math.abs(change) < 0.1;
  const up = change > 0;
  const good = up === higherIsBetter;

  return (
    <p
      className={cx(
        'mt-1.5 flex flex-wrap items-baseline gap-x-1.5 text-xxs font-medium',
        flat ? 'text-ink-muted' : good ? 'text-success' : 'text-danger',
      )}
    >
      <span className="inline-flex items-baseline gap-0.5">
        <span aria-hidden="true">{flat ? '→' : up ? '▲' : '▼'}</span>
        <span className="tabular">
          {flat ? '' : up ? '+' : '−'}
          {Math.abs(change) >= 1000
            ? `${String(Math.round(Math.abs(change) / 100) * 100)}%`
            : `${Math.abs(change).toFixed(Math.abs(change) < 10 ? 1 : 0)}%`}
        </span>
      </span>
      <span className="font-normal text-ink-subtle">{periodLabel}</span>
    </p>
  );
}

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
