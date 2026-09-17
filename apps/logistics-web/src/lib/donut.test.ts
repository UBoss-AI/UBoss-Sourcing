/**
 * Guards on the ring's arithmetic.
 *
 * Every one of these is a way a part-to-whole chart can lie while looking
 * perfectly healthy in a screenshot, which is why they are here rather than
 * left to a visual check.
 */
import { describe, expect, it } from 'vitest';
import { buildDonut, donutPercentage, reconcileDonut, type DonutSegmentInput } from './donut';

/** Four statuses of a size that needs no clamping. */
const FOUR: DonutSegmentInput[] = [
  { id: 'AWAITING_PICKUP', label: 'Awaiting pickup', value: 10, step: 2 },
  { id: 'IN_TRANSIT', label: 'In transit', value: 30, step: 4 },
  { id: 'DELIVERED', label: 'Delivered', value: 55, step: 'success' },
  { id: 'DELIVERY_FAILED', label: 'Delivery failed', value: 5, step: 'danger' },
];

const TOTAL = 100;

/** The drawn length of an arc, back out of its dash array. */
function drawnLength(dashArray: string): number {
  return Number(dashArray.split(' ')[0]);
}

describe('donutPercentage', () => {
  it('is the share of the total, to one decimal', () => {
    expect(donutPercentage(30, 100)).toBe(30);
    expect(donutPercentage(1, 3)).toBe(33.3);
  });

  it('keeps a small non-zero share distinguishable from zero', () => {
    // The whole reason for the decimal place. At no decimals both of these
    // are "0%", and "nothing is stuck" and "three are stuck" are very
    // different days.
    expect(donutPercentage(3, 1000)).toBe(0.3);
    expect(donutPercentage(0, 1000)).toBe(0);
  });

  it('is zero rather than NaN against an empty total', () => {
    // A real case, not an error: it is what every tile says on go-live day.
    expect(donutPercentage(0, 0)).toBe(0);
    expect(donutPercentage(5, 0)).toBe(0);
  });
});

describe('reconcileDonut', () => {
  it('reconciles when the segments account for the total', () => {
    const result = reconcileDonut(FOUR, TOTAL);

    expect(result.segmentTotal).toBe(100);
    expect(result.remainder).toBe(0);
    expect(result.reconciles).toBe(true);
  });

  it('reports the shortfall when the ring does not draw everything', () => {
    // What happens the day a status is added to the backend and not to the
    // grouping. Nothing on screen would otherwise say the ring is short.
    const result = reconcileDonut(FOUR, 120);

    expect(result.remainder).toBe(20);
    expect(result.reconciles).toBe(false);
  });
});

describe('buildDonut', () => {
  it('gives every segment its percentage of the passed total', () => {
    const { segments } = buildDonut(FOUR, TOTAL);

    expect(segments.map((segment) => segment.percentage)).toEqual([10, 30, 55, 5]);
  });

  it('measures against the passed total, not the sum of the segments', () => {
    // The denominator is the caller's decision — "every order in the period"
    // rather than "the ones this chart breaks out". Summing here instead
    // would silently redefine what 100% means.
    const { segments } = buildDonut(FOUR, 200);

    expect(segments.map((segment) => segment.percentage)).toEqual([5, 15, 27.5, 2.5]);
  });

  it('keeps the arcs inside one turn of the ring', () => {
    const { segments, circumference } = buildDonut(FOUR, TOTAL);

    // Every arc plus every gap has to fit in one circumference. An arc that
    // laps the first one is the classic part-to-whole failure and it looks
    // entirely plausible.
    const drawn = segments.reduce((sum, segment) => sum + drawnLength(segment.dashArray), 0);

    expect(drawn).toBeLessThanOrEqual(circumference + 0.000001);
  });

  it('starts the first arc at the top and walks clockwise', () => {
    const { segments } = buildDonut(FOUR, TOTAL, { gapDegrees: 0 });

    expect(segments[0]?.dashOffset).toBe(0);

    // Each subsequent offset is further round the ring than the one before.
    const offsets = segments.map((segment) => segment.dashOffset);
    expect(offsets[1]).toBeLessThan(offsets[0] ?? 0);
    expect(offsets[2]).toBeLessThan(offsets[1] ?? 0);
  });

  it('never returns a negative drawn length', () => {
    /*
     * The failure this exists for: SVG renders a negative `stroke-dasharray`
     * length as the FULL circle, so one segment too narrow for its own gap
     * paints over the entire ring — and it looks like a deliberate solid
     * donut rather than a bug.
     */
    const tiny: DonutSegmentInput[] = [
      { id: 'a', label: 'A', value: 1, step: 1 },
      { id: 'b', label: 'B', value: 1, step: 2 },
      { id: 'c', label: 'C', value: 998, step: 3 },
    ];

    const { segments } = buildDonut(tiny, 1000, { gapDegrees: 8, minDegrees: 4 });

    for (const segment of segments) {
      expect(drawnLength(segment.dashArray)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('buildDonut — the edges', () => {
  it('draws nothing and says so for an empty dataset', () => {
    const { isEmpty, segments } = buildDonut([], 0);

    expect(isEmpty).toBe(true);
    expect(segments).toEqual([]);
  });

  it('is empty when every segment is zero, and still lists them', () => {
    const zeroes: DonutSegmentInput[] = [
      { id: 'a', label: 'A', value: 0, step: 1 },
      { id: 'b', label: 'B', value: 0, step: 'danger' },
    ];

    const { isEmpty, segments } = buildDonut(zeroes, 0);

    expect(isEmpty).toBe(true);
    // Listed, not dropped. A status that vanishes the moment it empties means
    // a reader cannot tell "no failures today" from "this build does not
    // track failures".
    expect(segments).toHaveLength(2);
    expect(segments.every((segment) => segment.percentage === 0)).toBe(true);
  });

  it('keeps a zero segment in the legend beside non-zero ones', () => {
    const mixed: DonutSegmentInput[] = [
      { id: 'open', label: 'Open', value: 7, step: 2 },
      { id: 'failed', label: 'Failed', value: 0, step: 'danger' },
    ];

    const { segments, isEmpty } = buildDonut(mixed, 7);

    expect(isEmpty).toBe(false);
    expect(segments).toHaveLength(2);
    expect(segments[1]?.percentage).toBe(0);
    expect(drawnLength(segments[1]?.dashArray ?? '0 0')).toBe(0);
  });

  it('draws a single full segment as a closed ring, with no gap notch', () => {
    const only: DonutSegmentInput[] = [{ id: 'delivered', label: 'Delivered', value: 12, step: 'success' }];

    const { segments, circumference } = buildDonut(only, 12);

    // A gap here would cut a notch at twelve o'clock, which reads as a
    // missing 1% rather than as a complete ring.
    expect(drawnLength(segments[0]?.dashArray ?? '0 0')).toBeCloseTo(circumference, 6);
    expect(segments[0]?.percentage).toBe(100);
  });

  it('widens a slice too thin to see, and admits it', () => {
    const lopsided: DonutSegmentInput[] = [
      { id: 'bulk', label: 'Bulk', value: 999, step: 3 },
      { id: 'stuck', label: 'Stuck', value: 1, step: 'danger' },
    ];

    const { segments } = buildDonut(lopsided, 1000, { minDegrees: 4 });

    const stuck = segments.find((segment) => segment.id === 'stuck');

    // Drawn wider than its true share, flagged so the card can footnote it,
    // and the true figures are untouched.
    expect(stuck?.clamped).toBe(true);
    expect(stuck?.value).toBe(1);
    expect(stuck?.percentage).toBe(0.1);
  });

  it('leaves the arcs honest when everything is too thin to clamp', () => {
    // A hundred statuses holding one row each. There is nobody to borrow the
    // width from, so nothing is widened rather than the ring lapping itself.
    const many: DonutSegmentInput[] = Array.from({ length: 100 }, (_, index) => ({
      id: `s${String(index)}`,
      label: `S${String(index)}`,
      value: 1,
      step: 1 as const,
    }));

    const { segments, circumference } = buildDonut(many, 100, { minDegrees: 4, gapDegrees: 0 });

    expect(segments.every((segment) => !segment.clamped)).toBe(true);

    const drawn = segments.reduce((sum, segment) => sum + drawnLength(segment.dashArray), 0);
    expect(drawn).toBeLessThanOrEqual(circumference + 0.000001);
  });

  it('reports partial data rather than silently under-drawing', () => {
    const { reconciliation } = buildDonut(FOUR, 140);

    expect(reconciliation.reconciles).toBe(false);
    expect(reconciliation.remainder).toBe(40);
  });
});
