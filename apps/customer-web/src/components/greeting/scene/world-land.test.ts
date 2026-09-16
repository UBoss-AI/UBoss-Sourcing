/**
 * The world the globe is drawn from.
 *
 * What can and cannot be asserted here is worth stating plainly, for the same
 * reason `HeroStage.test.tsx` says it: jsdom has no 2D canvas, so nothing here
 * can check what the continents LOOK like. A person looking at a browser is how
 * this project answers that, and the note at the top of `world-land.ts` says
 * what to look for.
 *
 * What this suite guards is the set of rules the data has to obey for the
 * rasteriser not to produce nonsense — and every one of them is a rule that
 * fails *silently* and far away from its cause:
 *
 *   - **No ring crosses the antimeridian.** The projection is a straight linear
 *     map from longitude to x with no wrapping in it, so a ring running from
 *     179 to -179 is drawn as a band straight back across the whole world. It
 *     does not throw; it just puts a stripe through the Pacific.
 *   - **Every ring is closed.** An open ring is filled anyway, by an implicit
 *     straight line from its last point to its first, so a forgotten final
 *     point silently amputates a coastline.
 *   - **Every coordinate is on the planet.** A latitude past 90 folds over the
 *     pole and a longitude past 180 lands outside the texture entirely.
 *
 * `lonLatToVector` is tested separately because it is the join between the two
 * halves of the globe — the texture and the geometry placed on top of it. When
 * it disagrees with the projection, the glowing nodes sit in the sea on the far
 * side of the world from the coast they belong to, which looks like a bug in
 * the land data rather than in a sign.
 */
import { describe, expect, it } from 'vitest';
import { LAND, SEAS, lonLatToVector } from './world-land';

const RINGS = [...LAND, ...SEAS];

describe('the coastline data', () => {
  it('has rings for every continent', () => {
    // Seven continents plus Greenland is the floor; anything under it means a
    // landmass was dropped rather than simplified.
    expect(LAND.length).toBeGreaterThanOrEqual(8);
  });

  it('closes every ring', () => {
    for (const ring of RINGS) {
      const first = ring[0];
      const last = ring[ring.length - 1];

      expect(first).toBeDefined();
      expect(last).toEqual(first);
    }
  });

  it('gives every ring enough points to be a shape', () => {
    for (const ring of RINGS) {
      // Three corners and the repeated first point.
      expect(ring.length).toBeGreaterThanOrEqual(4);
    }
  });

  it('keeps every coordinate on the planet', () => {
    for (const ring of RINGS) {
      for (const [lon, lat] of ring) {
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThanOrEqual(180);
        expect(lat).toBeGreaterThanOrEqual(-90);
        expect(lat).toBeLessThanOrEqual(90);
      }
    }
  });

  it('never steps across the antimeridian', () => {
    /*
     * Tested as a step between CONSECUTIVE points rather than as a ring's
     * total span, because that is the thing that actually goes wrong: the
     * rasteriser draws a straight line between each pair, so one leap of more
     * than half the world is one stripe across the texture. Antarctica spans
     * the full 360 legitimately and passes this, because it walks there.
     *
     * 180 rather than something tighter: Antarctica's coarsest step is 20
     * degrees and Siberia's is 9, so there is an order of magnitude of headroom
     * before this could fire on a legitimate edit.
     *
     * **A step along a pole is exempt, and has to be.** Equirectangular smears
     * each pole across an entire edge of the texture, so every point at
     * latitude -90 is the same point on the sphere — the one at the bottom.
     * Antarctica closes itself by running the full width along that edge, which
     * is a 360-degree step in longitude and zero distance on the globe. It is
     * how the shape is drawn rather than a mistake in it.
     */
    for (const ring of RINGS) {
      for (let i = 1; i < ring.length; i += 1) {
        const previous = ring[i - 1];
        const current = ring[i];
        if (previous === undefined || current === undefined) continue;

        const alongAPole = Math.abs(previous[1]) === 90 && Math.abs(current[1]) === 90;
        if (alongAPole) continue;

        expect(Math.abs(current[0] - previous[0])).toBeLessThan(180);
      }
    }
  });
});

describe('placing a point on the sphere', () => {
  const length = (v: { x: number; y: number; z: number }): number =>
    Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);

  it('puts every point on the sphere it was given', () => {
    for (const [lon, lat] of [
      [0, 0],
      [-180, 0],
      [90, 45],
      [-73, -33],
    ] as const) {
      expect(length(lonLatToVector(lon, lat, 1.5))).toBeCloseTo(1.5, 6);
    }
  });

  it('puts the north pole up and the south pole down', () => {
    // Longitude is meaningless at a pole, so any value must give the same
    // answer. A sign error in `phi` shows up here before it shows up as
    // Antarctica glowing at the top of the globe.
    expect(lonLatToVector(0, 90, 1).y).toBeCloseTo(1, 6);
    expect(lonLatToVector(137, 90, 1).y).toBeCloseTo(1, 6);
    expect(lonLatToVector(0, -90, 1).y).toBeCloseTo(-1, 6);
  });

  it('agrees with the texture about which way round the world goes', () => {
    /*
     * The one assertion that catches a mirrored globe.
     *
     * `SphereGeometry`'s `u` starts at the positive x-axis and runs the
     * opposite way round from longitude, which is why the formula carries the
     * signs it does. If somebody "tidies" those away, longitude 90 east and
     * longitude 90 west swap places — the coastlines are unchanged, because
     * they come from the texture, and only the glowing nodes move. The globe
     * then looks right until you notice the lights are all at sea.
     */
    const east = lonLatToVector(90, 0, 1);
    const west = lonLatToVector(-90, 0, 1);

    expect(east.z).toBeCloseTo(-west.z, 6);
    expect(Math.abs(east.z)).toBeCloseTo(1, 6);

    // And the two ends of the prime meridian's great circle are opposite.
    const zero = lonLatToVector(0, 0, 1);
    const anti = lonLatToVector(180, 0, 1);
    expect(zero.x).toBeCloseTo(-anti.x, 6);
  });
});
