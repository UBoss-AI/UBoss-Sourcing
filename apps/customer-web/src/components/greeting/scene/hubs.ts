/**
 * The places on the globe.
 *
 * Thirteen cities and the lanes between them. The cities themselves are not
 * drawn — the globe carries no pins — but every lane needs two ends, and these
 * are them. Europe-centred because that is where this product is sold, and
 * every one is somewhere with a port or an airport that goods genuinely move
 * through: invented coordinates in the middle of an ocean are the detail that
 * gives a globe away.
 *
 * These are the hero's illustration of what the software is *for*, not a claim
 * about any particular deployment — a lane is a route this kind of trade runs
 * on, the same way the categories on a brochure are categories rather than
 * inventory. Nothing here is read from the API and nothing here says a
 * specific operator ships anywhere.
 *
 * The country code is not used by the globe. It is kept because it is a fact
 * about the hub rather than a detail of how one was once drawn.
 */
export interface SourcingHub {
  /** Stable key, and what the lanes below refer to. */
  id: string;
  city: string;
  /** ISO 3166-1 alpha-2. Not drawn anywhere; see the note above. */
  country: string;
  lat: number;
  lng: number;
}

export const HUBS: readonly SourcingHub[] = [
  { id: 'antwerp', city: 'Antwerp', country: 'BE', lat: 51.2, lng: 4.4 },
  { id: 'london', city: 'London', country: 'GB', lat: 51.5, lng: -0.1 },
  { id: 'frankfurt', city: 'Frankfurt', country: 'DE', lat: 50.1, lng: 8.7 },
  { id: 'amsterdam', city: 'Amsterdam', country: 'NL', lat: 52.4, lng: 4.9 },
  { id: 'paris', city: 'Paris', country: 'FR', lat: 48.9, lng: 2.3 },
  { id: 'madrid', city: 'Madrid', country: 'ES', lat: 40.4, lng: -3.7 },
  { id: 'rome', city: 'Rome', country: 'IT', lat: 41.9, lng: 12.5 },
  { id: 'athens', city: 'Athens', country: 'GR', lat: 38.0, lng: 23.7 },
  { id: 'warsaw', city: 'Warsaw', country: 'PL', lat: 52.2, lng: 21.0 },
  { id: 'new-york', city: 'New York', country: 'US', lat: 40.7, lng: -74.0 },
  { id: 'mumbai', city: 'Mumbai', country: 'IN', lat: 19.1, lng: 72.9 },
  { id: 'singapore', city: 'Singapore', country: 'SG', lat: 1.4, lng: 103.8 },
  { id: 'shanghai', city: 'Shanghai', country: 'CN', lat: 31.2, lng: 121.5 },
];

/**
 * The lanes, as pairs of hub ids.
 *
 * Ten of them, ordered so the short European hops come first: the reduced
 * tier draws the first few and stops, and the ones worth keeping at a third of
 * the size are the ones that stay inside the visible hemisphere for most of a
 * rotation.
 */
export const LANES: readonly (readonly [string, string])[] = [
  ['antwerp', 'london'],
  ['antwerp', 'frankfurt'],
  ['frankfurt', 'rome'],
  ['amsterdam', 'athens'],
  ['paris', 'madrid'],
  ['warsaw', 'antwerp'],
  ['antwerp', 'mumbai'],
  ['frankfurt', 'singapore'],
  ['london', 'new-york'],
  ['amsterdam', 'shanghai'],
];

/** The hub with this id, or `undefined` — the lanes above are hand-written. */
export function hub(id: string): SourcingHub | undefined {
  return HUBS.find((entry) => entry.id === id);
}
