/**
 * The arithmetic behind the dashboard ring.
 *
 * Separated from the component and kept pure, because everything that can
 * quietly go wrong in a part-to-whole chart is arithmetic:
 *
 *   - A segment the ring draws but the legend does not add up to the total.
 *   - A slice too thin to see, so a status with work in it looks like zero.
 *   - A gap wider than the slice it borders, so the slice renders inside-out.
 *   - Percentages that each round to a sensible number and sum to 101%.
 *
 * None of those are visible in a screenshot of a healthy dataset, and all of
 * them are visible in a test. So the component below draws whatever this
 * returns and makes no decisions of its own.
 *
 * ---
 *
 * KEPT BYTE-IDENTICAL across apps/customer-web, apps/admin-web and
 * apps/logistics-web. The three dashboards map three different state models
 * onto this — orders, operational queues, consignments — but "what fraction of
 * the whole is this, and where does its arc start" is one question with one
 * answer, and a second implementation of it is how two dashboards end up
 * disagreeing about what 100% means.
 */

/**
 * Which colour a segment takes.
 *
 * A superset of `ProportionSegment['step']` in components/charts.tsx, and
 * deliberately the same vocabulary: a status drawn as step 4 in the ring and
 * step 4 in the bar underneath it has to be the same blue, or the two charts
 * on one screen are two systems.
 *
 * 1-6 are the ordinal ramp — six steps of one hue, for categories that have an
 * ORDER (a fulfilment pipeline, a delivery sequence). The four names sit
 * outside the ramp because they are not stages:
 *
 *   - `neutral`  — has not entered the sequence. Not step zero: a draft is not
 *                  early progress, it is no progress.
 *   - `warning`  — somebody should look at this today.
 *   - `danger`   — somebody should look at this now. NEVER shares a treatment
 *                  with `success`; that is the one substitution that would make
 *                  a failed delivery read as a completed one.
 *   - `success`  — finished, and it worked.
 */
export type ChartStep = 1 | 2 | 3 | 4 | 5 | 6 | 'neutral' | 'warning' | 'danger' | 'success';

/** What a caller hands in. One per status, already aggregated by the server. */
export interface DonutSegmentInput {
  /**
   * The backend's own status key, not a label. It goes in the URL, it is the
   * React key, and it is what the detail list filters on — so it must survive
   * a language change, which a translated label does not.
   */
  id: string;
  /** What a reader sees. Translated by the caller. */
  label: string;
  /** The count. Zero is legal and is drawn as nothing with a legend row. */
  value: number;
  step: ChartStep;
  /**
   * Where clicking this leads, when it leads anywhere.
   *
   * Absent means the segment only filters the list on this page. Present means
   * the queue lives on another screen, and the ring links to it rather than
   * pretending to filter something it cannot see.
   */
  to?: string | undefined;
  /** A second fact for the legend — a money total, an oldest-waiting age. */
  detail?: string | undefined;
}

/** One segment, with everything the ring and the legend need to draw it. */
export interface DonutSegment extends DonutSegmentInput {
  /** Share of `total`, 0-100, to one decimal place. */
  percentage: number;
  /**
   * `stroke-dasharray` for this arc: the drawn length, then the rest.
   *
   * The ring is one `<circle>` per segment, all concentric and all the same
   * circumference, each showing exactly one dash. That is why the geometry is
   * two numbers rather than a path: an arc drawn as a dash gets round caps and
   * sub-pixel accuracy from the renderer for free, where a hand-built `A`
   * command has to compute both and gets the large-arc flag wrong at 50%.
   */
  dashArray: string;
  /** `stroke-dashoffset`, placing the dash at the right angle. */
  dashOffset: number;
  /**
   * True when this arc had to be widened to stay visible.
   *
   * A 0.2% slice is a third of a pixel. Drawn honestly it is invisible, and a
   * status with work in it that looks like zero is worse than a slightly wrong
   * ring — so it is clamped to `MIN_ARC_DEGREES` and flagged here. The legend
   * still carries the true count and the true percentage, and the card says so
   * in its own footnote.
   */
  clamped: boolean;
}

/** What the ring adds up to, and whether that is the whole story. */
export interface DonutReconciliation {
  /** The segments, added up. */
  segmentTotal: number;
  /** The figure in the middle of the ring. */
  displayTotal: number;
  /** `displayTotal - segmentTotal`. Positive means something is not drawn. */
  remainder: number;
  /** True when the ring accounts for every unit of the total. */
  reconciles: boolean;
}

export interface DonutGeometry {
  segments: DonutSegment[];
  reconciliation: DonutReconciliation;
  /** The circle the arcs are drawn on. */
  radius: number;
  circumference: number;
  /** True when there is nothing to draw. */
  isEmpty: boolean;
}

export interface DonutOptions {
  /** Radius in user units of the circle the stroke is centred on. */
  radius?: number;
  /**
   * The gap between two touching arcs, in degrees.
   *
   * A gap rather than a stroke between segments: a stroke adds a ring of ink
   * that is not data and, at these widths, is most of what you see. Two
   * degrees is about 3px on a 96-unit radius, which is enough to read as
   * separation and not enough to cost a small segment its identity.
   */
  gapDegrees?: number;
  /**
   * The smallest arc that is worth drawing, in degrees.
   *
   * Below this the segment is widened and marked `clamped`. Four degrees is
   * roughly 1% of the ring, and at the stroke widths here that is the point a
   * round-capped arc stops being a slice and becomes a dot.
   */
  minDegrees?: number;
}

const DEFAULT_RADIUS = 96;
const DEFAULT_GAP_DEGREES = 2;
const DEFAULT_MIN_DEGREES = 4;

/**
 * A segment's share of the whole, to one decimal place.
 *
 * One decimal rather than none, because a dashboard with forty statuses on it
 * has several that round to 0% and one that rounds to 0% is indistinguishable
 * from one that IS 0% — which is the difference between "nothing is stuck" and
 * "three consignments are stuck".
 *
 * A total of zero gives zero rather than NaN. That is a real case and not an
 * error: it is what every tile says on the day a deployment goes live.
 */
export function donutPercentage(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 1000) / 10;
}

/**
 * Does the ring account for the number in the middle of it?
 *
 * Asked rather than assumed, because the two come from different places: the
 * total is a `count()` over a window and the segments are a `groupBy`. They
 * agree until somebody adds a status the grouping does not name, at which
 * point the ring silently under-draws and nothing on the screen says so. The
 * card renders the remainder in words when this returns `reconciles: false`.
 */
export function reconcileDonut(
  segments: readonly { value: number }[],
  displayTotal: number,
): DonutReconciliation {
  const segmentTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
  const remainder = displayTotal - segmentTotal;

  return {
    segmentTotal,
    displayTotal,
    remainder,
    reconciles: remainder === 0,
  };
}

/**
 * Turn counts into arcs.
 *
 * The denominator is `displayTotal`, passed in rather than summed, for the
 * same reason `ProportionBar` takes one: only the caller knows whether the
 * whole is "these segments" or "every order in the period, including the ones
 * this chart does not break out".
 *
 * Zero-valued segments are kept in the returned list and drawn as nothing.
 * Dropping them would take a status out of the legend the moment it emptied,
 * so a reader could not tell "no failed deliveries today" from "this build
 * does not track failed deliveries" — and those are very different days.
 */
export function buildDonut(
  input: readonly DonutSegmentInput[],
  displayTotal: number,
  options: DonutOptions = {},
): DonutGeometry {
  const radius = options.radius ?? DEFAULT_RADIUS;
  const gapDegrees = options.gapDegrees ?? DEFAULT_GAP_DEGREES;
  const minDegrees = options.minDegrees ?? DEFAULT_MIN_DEGREES;

  const circumference = 2 * Math.PI * radius;
  const reconciliation = reconcileDonut(input, displayTotal);

  const drawable = input.filter((segment) => segment.value > 0);

  // Nothing to draw. Every segment still comes back — with a zero percentage
  // and a zero-length arc — so the legend can list them and say so.
  if (drawable.length === 0 || displayTotal <= 0) {
    return {
      segments: input.map((segment) => ({
        ...segment,
        percentage: 0,
        dashArray: `0 ${String(circumference)}`,
        dashOffset: 0,
        clamped: false,
      })),
      reconciliation,
      radius,
      circumference,
      isEmpty: true,
    };
  }

  /*
   * One segment filling the ring gets no gap.
   *
   * With a gap it renders as a circle with a notch cut out of it at twelve
   * o'clock, which reads as a missing 1% rather than as a complete ring. There
   * is nothing for a separator to separate it from.
   */
  const gap = drawable.length === 1 ? 0 : gapDegrees;

  /*
   * Share out the 360 degrees.
   *
   * Two passes, because clamping a small slice up has to take that width from
   * somewhere: the first pass finds who needs clamping and how much they
   * borrow, the second shrinks everybody else proportionally to pay for it.
   * Without the second pass a ring of many tiny segments sums past 360 and the
   * last arc laps the first.
   */
  const rawDegrees = drawable.map((segment) => (segment.value / displayTotal) * 360);

  const clampedFlags = rawDegrees.map((degrees) => degrees < minDegrees);
  const borrowed = rawDegrees.reduce(
    (sum, degrees, index) => (clampedFlags[index] === true ? sum + (minDegrees - degrees) : sum),
    0,
  );
  const shrinkable = rawDegrees.reduce(
    (sum, degrees, index) => (clampedFlags[index] === true ? sum : sum + degrees),
    0,
  );

  /*
   * How much each un-clamped segment gives up, as a factor.
   *
   * Guarded two ways. `shrinkable <= 0` is a ring made entirely of slices too
   * small to draw — possible with many statuses each holding one row — and
   * there is nobody to borrow from, so nothing is clamped and the arcs stay
   * honest and tiny. A factor below zero would mean the borrowers want more
   * than the whole ring, which the same guard catches.
   */
  const canBorrow = shrinkable > 0 && borrowed < shrinkable;
  const shrink = canBorrow ? (shrinkable - borrowed) / shrinkable : 1;

  const degrees = rawDegrees.map((raw, index) =>
    clampedFlags[index] === true && canBorrow ? minDegrees : raw * shrink,
  );

  const byId = new Map<string, { dashArray: string; dashOffset: number; clamped: boolean }>();

  let cursor = 0;
  drawable.forEach((segment, index) => {
    const span = degrees[index] ?? 0;

    /*
     * The gap is taken out of the arc, half at each end, so the arc stays
     * centred on the angles it was given. Taking it off one end only walks
     * every subsequent segment round the ring by half a gap.
     *
     * An arc can be narrower than the gap — a clamped 4° slice beside a 2°
     * gap leaves 2° — so the drawn length is floored at zero rather than
     * allowed to go negative, which SVG renders as the FULL circle.
     */
    const drawnDegrees = Math.max(span - gap, 0);
    const drawnLength = (drawnDegrees / 360) * circumference;

    byId.set(segment.id, {
      dashArray: `${String(drawnLength)} ${String(Math.max(circumference - drawnLength, 0))}`,
      /*
       * Negative, because `stroke-dashoffset` shifts the pattern backwards
       * along the path. `+ gap/2` re-centres the shortened arc in its slot.
       *
       * `+ 0` normalises negative zero. Harmless in the rendered attribute,
       * but `-0` is not `Object.is`-equal to `0`, so without it the first
       * segment of every ring compares unequal to the origin in a test and in
       * any caller that checks "is this the first arc".
       */
      dashOffset: -(((cursor + gap / 2) / 360) * circumference) + 0,
      clamped: clampedFlags[index] === true && canBorrow,
    });

    cursor += span;
  });

  return {
    segments: input.map((segment) => {
      const geometry = byId.get(segment.id);

      return {
        ...segment,
        percentage: donutPercentage(segment.value, displayTotal),
        dashArray: geometry?.dashArray ?? `0 ${String(circumference)}`,
        dashOffset: geometry?.dashOffset ?? 0,
        clamped: geometry?.clamped ?? false,
      };
    }),
    reconciliation,
    radius,
    circumference,
    isEmpty: false,
  };
}

/**
 * The Tailwind stroke class for a step.
 *
 * The `-fill` steps rather than the bare ones. A bare token (`--danger`) is
 * tuned to be READ as text on a card; a `-fill` token is the solid plate a
 * shape is painted with, and in the dark theme they are deliberately different
 * values. An arc is a shape.
 *
 * Written out rather than composed, because Tailwind reads these files as
 * text: a computed `stroke-chart-seq-${step}` compiles to no CSS at all.
 */
export const STEP_STROKE: Readonly<Record<ChartStep, string>> = Object.freeze({
  1: 'stroke-chart-seq-1',
  2: 'stroke-chart-seq-2',
  3: 'stroke-chart-seq-3',
  4: 'stroke-chart-seq-4',
  5: 'stroke-chart-seq-5',
  6: 'stroke-chart-seq-6',
  neutral: 'stroke-border-strong',
  warning: 'stroke-warning-fill',
  danger: 'stroke-danger-fill',
  success: 'stroke-success-fill',
});

/** The same colours as a background, for the legend's swatch. */
export const STEP_SWATCH: Readonly<Record<ChartStep, string>> = Object.freeze({
  1: 'bg-chart-seq-1',
  2: 'bg-chart-seq-2',
  3: 'bg-chart-seq-3',
  4: 'bg-chart-seq-4',
  5: 'bg-chart-seq-5',
  6: 'bg-chart-seq-6',
  neutral: 'bg-border-strong',
  warning: 'bg-warning-fill',
  danger: 'bg-danger-fill',
  success: 'bg-success-fill',
});

/**
 * The shape a legend swatch takes.
 *
 * A SECOND channel beside the colour, and the reason it exists: about one man
 * in twelve cannot separate the red from the green, and a ring whose only
 * difference between "delivered" and "delivery failed" is a hue is a ring that
 * reads as fine to him on the worst day of the week.
 *
 * Every swatch also sits beside its label and its count, so the shape is a
 * third cue rather than the fallback. Nothing here is the only signal.
 */
export const STEP_SHAPE: Readonly<Record<ChartStep, 'square' | 'round' | 'diamond'>> =
  Object.freeze({
    1: 'round',
    2: 'round',
    3: 'round',
    4: 'round',
    5: 'round',
    6: 'round',
    neutral: 'square',
    warning: 'diamond',
    danger: 'diamond',
    success: 'square',
  });
