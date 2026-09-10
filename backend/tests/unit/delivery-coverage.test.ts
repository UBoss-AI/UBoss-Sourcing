/**
 * Which countries a delivery radius really reaches - unit, no database.
 *
 * These are the tests that make the feature worth shipping. A "delivers to"
 * list is a commercial claim, and the two ways to get it wrong both produce
 * something that *looks* right on screen:
 *
 *   - **Too generous.** A neighbour table, or a country centroid, puts Germany
 *     in the list for a warehouse in Antwerp. Somebody quotes a customer on it.
 *   - **Too shy.** A radius measured to a capital city instead of a border
 *     drops France from a warehouse in Basel, 2 km from the French border.
 *
 * So the cases below are real coordinates with answers checked against the
 * ground rather than against the implementation: a warehouse that reaches one
 * country, one that reaches two, one that reaches none, and one in the middle
 * of an ocean.
 *
 * The geometry is tested through the exported pieces of
 * `domain/country-boundaries.ts` plus Turf, rather than through
 * `deliveryCoverage()`, which needs Prisma for the warehouse row and for the
 * operator's country names. The integration test alongside this one covers the
 * endpoint; this covers the part that can be wrong quietly.
 */
import { describe, expect, it } from 'vitest';
import booleanIntersects from '@turf/boolean-intersects';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import circle from '@turf/circle';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import polygonToLine from '@turf/polygon-to-line';
import { lineString, point } from '@turf/helpers';
import type { Feature, LineString } from 'geojson';
import { boundaries, boxesOverlap } from '../../src/domain/country-boundaries.js';

/**
 * The same walk `delivery-coverage.service.ts` does, kept deliberately
 * separate.
 *
 * A test that imported the service's own private helper would pass for a
 * service that had stopped measuring anything. This re-states the intended
 * geometry - circle, intersect, nearest border - so the numbers below are
 * checked against Turf and Natural Earth rather than against our own code.
 */
function reach(
  latitude: number,
  longitude: number,
  radiusKm: number,
): { home: string | null; countries: { code: string | null; name: string; distanceKm: number }[] } {
  const origin = point([longitude, latitude]);
  const ring = circle([longitude, latitude], radiusKm, { steps: 180, units: 'kilometers' });
  const ringBox = bbox(ring);

  let home: string | null = null;
  const countries: { code: string | null; name: string; distanceKm: number }[] = [];

  for (const country of boundaries().countries) {
    if (!boxesOverlap(country.box, ringBox)) continue;
    if (!booleanIntersects(ring, country.geometry)) continue;

    if (booleanPointInPolygon(origin, country.geometry)) {
      home = country.code;
      continue;
    }

    const outline = polygonToLine(country.geometry);
    const parts = outline.type === 'FeatureCollection' ? outline.features : [outline];
    let nearest = Number.POSITIVE_INFINITY;

    for (const part of parts) {
      const rings: Feature<LineString>[] =
        part.geometry.type === 'MultiLineString'
          ? part.geometry.coordinates.map((coordinates) => lineString(coordinates))
          : [part as Feature<LineString>];

      for (const ringLine of rings) {
        const snapped = nearestPointOnLine(ringLine, origin, { units: 'kilometers' });
        const distance = snapped.properties.dist;
        if (distance !== undefined && distance < nearest) nearest = distance;
      }
    }

    if (nearest > radiusKm) continue;

    countries.push({
      code: country.code,
      name: country.name,
      distanceKm: Math.round(nearest * 10) / 10,
    });
  }

  countries.sort((a, b) => a.distanceKm - b.distanceKm);
  return { home, countries };
}

const codes = (result: ReturnType<typeof reach>): (string | null)[] =>
  result.countries.map((country) => country.code);

describe('the dataset itself', () => {
  it('carries every country with a box and an English name', () => {
    const { countries, byCode } = boundaries();

    expect(countries.length).toBeGreaterThan(200);
    expect(byCode.get('NL')?.name).toBe('Netherlands');
    expect(byCode.get('DE')?.name).toBe('Germany');
    expect(byCode.get('NL')?.box).toHaveLength(4);
  });

  /**
   * The name has to be the current one, not the one the boundary file shipped
   * with. Natural Earth still says "Macedonia"; the flap on the map would then
   * say it too, next to a filter dropdown reading "North Macedonia".
   */
  it('takes its names from the ISO list rather than the boundary file', () => {
    const { byCode } = boundaries();

    expect(byCode.get('MK')?.name).toBe('North Macedonia');
    expect(byCode.get('CZ')?.name).toBe('Czechia');
  });

  it('is parsed once and handed back the same object', () => {
    expect(boundaries()).toBe(boundaries());
  });
});

describe('boxesOverlap', () => {
  it('keeps two boxes that only touch', () => {
    // Inclusive on purpose: this decides whether the exact test runs, and the
    // cheap answer must never be the one that loses a country.
    expect(boxesOverlap([0, 0, 10, 10], [10, 10, 20, 20])).toBe(true);
  });

  it('drops boxes that miss in one axis alone', () => {
    expect(boxesOverlap([0, 0, 10, 10], [11, 0, 20, 10])).toBe(false);
    expect(boxesOverlap([0, 0, 10, 10], [0, 11, 10, 20])).toBe(false);
  });
});

/**
 * Antwerp: the case a neighbour table gets wrong.
 *
 * Belgium borders Germany, France, Luxembourg and the Netherlands. From
 * Antwerp only one of those is inside 100 km - the Dutch border is about
 * 15 km north. Germany is roughly 150 km east and must not appear.
 */
describe('a warehouse 15 km from one border (Antwerp)', () => {
  const result = reach(51.2194, 4.4025, 100);

  it('stands in Belgium', () => {
    expect(result.home).toBe('BE');
  });

  it('reaches the Netherlands and nothing else', () => {
    expect(codes(result)).toEqual(['NL']);
  });

  it('measures the Dutch border, not the Dutch capital', () => {
    expect(result.countries[0]?.distanceKm).toBeGreaterThan(5);
    expect(result.countries[0]?.distanceKm).toBeLessThan(30);
  });

  it('leaves Germany out, though Belgium borders it', () => {
    expect(codes(result)).not.toContain('DE');
  });
});

/**
 * Basel: the case a centroid gets wrong.
 *
 * Two borders within five kilometres. A radius measured to either country's
 * centre would put France at ~450 km and drop it entirely.
 */
describe('a warehouse in a corner of three countries (Basel)', () => {
  const result = reach(47.5596, 7.5886, 100);

  it('stands in Switzerland', () => {
    expect(result.home).toBe('CH');
  });

  it('reaches both neighbours', () => {
    expect(codes(result)).toContain('FR');
    expect(codes(result)).toContain('DE');
  });

  it('puts them in order of their nearest border', () => {
    const distances = result.countries.map((country) => country.distanceKm);
    expect([...distances]).toEqual([...distances].sort((a, b) => a - b));
    expect(distances[0]).toBeLessThan(10);
  });
});

/**
 * Central Spain: the case the whole feature is judged on.
 *
 * The nearest foreign border to Madrid is Portugal, 244 km west. The answer
 * inside 100 km is *nothing*, and the screen has to say so rather than
 * offering Portugal because it is the nearest thing to hand.
 */
describe('a warehouse with no foreign border in range (Madrid)', () => {
  const result = reach(40.4168, -3.7038, 100);

  it('stands in Spain', () => {
    expect(result.home).toBe('ES');
  });

  it('reaches no other country at all', () => {
    expect(result.countries).toEqual([]);
  });

  /**
   * The border is at 244 km, so 200 finds nothing and 250 finds Portugal. Both
   * halves matter: the first says the empty answer is real, the second says it
   * is a measurement rather than a bug that never returns anything.
   */
  it('reaches Portugal only once the radius is honestly that big', () => {
    expect(codes(reach(40.4168, -3.7038, 200))).toEqual([]);
    expect(codes(reach(40.4168, -3.7038, 250))).toContain('PT');
  });
});

describe('a warehouse over open water', () => {
  const result = reach(30, -40, 100);

  it('has no home country and reaches nothing', () => {
    expect(result.home).toBeNull();
    expect(result.countries).toEqual([]);
  });
});

/**
 * The radius is the contract. A country one kilometre outside it is outside
 * it, and a list headed "within 100 km" may not quietly contain 104.
 */
describe('the radius bounds the answer', () => {
  it('adds countries as it grows and never loses one', () => {
    const near = codes(reach(51.2194, 4.4025, 100));
    const far = codes(reach(51.2194, 4.4025, 200));

    for (const code of near) expect(far).toContain(code);
    expect(far.length).toBeGreaterThan(near.length);
  });

  it('reports every distance inside the radius it was given', () => {
    for (const radius of [50, 100, 250]) {
      for (const country of reach(47.5596, 7.5886, radius).countries) {
        expect(country.distanceKm).toBeLessThanOrEqual(radius);
      }
    }
  });
});
