/**
 * The places on the globe.
 *
 * Two silent failures live in this data, and neither one breaks a build:
 *
 *   - **A lane that names a hub that is not there** is dropped when the scene
 *     builds, so a mistyped id is nine arcs instead of ten and nothing says
 *     so. The hero looks slightly emptier than it was designed to, which is
 *     not a thing anybody notices in a review.
 *   - **Two hubs sharing an id** makes one of them unreachable, because the
 *     lanes address a hub by its id and the first match wins.
 *
 * Both are cheap to hold still, so they are held still here.
 */
import { describe, expect, it } from 'vitest';
import { HUBS, LANES, hub } from './hubs';

describe('the sourcing hubs', () => {
  it('gives every lane two ends that exist', () => {
    for (const [from, to] of LANES) {
      expect(hub(from), `lane from "${from}"`).toBeDefined();
      expect(hub(to), `lane to "${to}"`).toBeDefined();
    }
  });

  it('never runs a lane from a place to itself', () => {
    for (const [from, to] of LANES) {
      expect(from).not.toBe(to);
    }
  });

  it('keeps every id unique, since the lanes address hubs by it', () => {
    expect(new Set(HUBS.map((place) => place.id)).size).toBe(HUBS.length);
  });

  it('puts every hub somewhere real', () => {
    for (const place of HUBS) {
      expect(Math.abs(place.lat), place.city).toBeLessThanOrEqual(90);
      expect(Math.abs(place.lng), place.city).toBeLessThanOrEqual(180);
    }
  });
});
