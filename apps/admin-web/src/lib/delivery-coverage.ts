/**
 * What a warehouse delivers to, as the panel reads it.
 *
 * The types mirror `backend/src/modules/inventory/delivery-coverage.service.ts`
 * exactly, and the two things that look redundant in them are the point of the
 * whole feature:
 *
 *   - **`home` is separate from `countries`.** So an empty `countries` means
 *     one thing and one thing only: no *foreign* border inside the radius. The
 *     screen has a state for that and says it in words rather than padding the
 *     list out with the country the warehouse is already standing in.
 *   - **`ring` is geometry, not a radius.** The browser draws the circle the
 *     server measured rather than deriving its own. A ring drawn from a radius
 *     in projected degrees and a list computed from a geodesic circle disagree
 *     by kilometres at European latitudes, and a ring that does not match the
 *     flags beside it is worse than no ring at all.
 *
 * Nothing here is hard-coded, including the radius: the warehouses response
 * carries the one this deployment promises. See `DELIVERY_COVERAGE_RADIUS_KM`
 * in `backend/src/config/env.ts`.
 */
import type { MultiPolygon, Polygon } from 'geojson';
import { api } from '@/lib/api';

/** A country the radius reaches. */
export interface CoveredCountry {
  /**
   * ISO 3166-1 alpha-2, or null for a shape with no code of its own -
   * a disputed area, or a territory carried separately from the state that
   * administers it. Null is what tells the card to draw a letter plate rather
   * than look up a flag that does not exist.
   */
  code: string | null;
  /** English name. The deployment's own `countries` table wins where it has a row. */
  name: string;
  /**
   * The emoji flag, part of the API's contract for other consumers.
   *
   * **The cards do not use it.** Windows ships no font that composes regional
   * indicator pairs, so on the platform most operators run this on it renders
   * as two letters in boxes - see the note at the top of `CountryFlag.tsx`,
   * which draws its own instead. Carried in the type because the field is
   * really there, and dropping it here would hide it from anyone reading this
   * file to learn what the endpoint returns.
   */
  flag: string;
  /** Kilometres to this country's nearest border, one decimal. */
  distanceKm: number;
  /** The point on that border which is nearest - where a route is drawn to. */
  nearestPoint: { latitude: number; longitude: number };
  /** The part of this country inside the radius. Null where the overlap is a line. */
  area: Polygon | MultiPolygon | null;
}

export interface DeliveryCoverage {
  warehouse: {
    id: string;
    code: string;
    name: string;
    latitude: number;
    longitude: number;
  };
  radiusKm: number;
  /** The country the warehouse stands in, by geometry. Null over water. */
  home: { code: string | null; name: string; flag: string } | null;
  /** Foreign countries within the radius, nearest border first. */
  countries: CoveredCountry[];
  /** The measured circle. Drawn as sent - see the note above. */
  ring: Polygon;
  computedAt: string;
}

/**
 * The error code for a warehouse that exists with nowhere on the map.
 *
 * Its own state on screen rather than a generic failure, because the fix is
 * different and it is a fix the reader can perform: add the coordinates, or
 * look them up from the address. See `LOCATION_NOT_PLACED` in
 * `backend/src/domain/errors.ts`.
 */
export const NOT_PLACED = 'LOCATION_NOT_PLACED';

/**
 * How long the panel takes to leave, in milliseconds.
 *
 * Two things have to agree on this number and they are in different files:
 * the page keeps the panel mounted for exactly this long after nobody is
 * pointing at a warehouse any more (`useLingering`), and the panel fades and
 * slides over exactly this long (`duration-200` on its own root). Written
 * down once here because the failure when they disagree is quiet: too short
 * and the panel is cut off mid-fade, too long and a panel nobody can see sits
 * over the map for a moment doing nothing.
 *
 * Shorter than the 260ms grace before it starts, deliberately. By the time
 * anything fades the reader has already looked away.
 */
export const COVERAGE_EXIT_MS = 200;

export function fetchDeliveryCoverage(
  warehouseId: string,
  radiusKm: number,
): Promise<DeliveryCoverage> {
  return api.get<DeliveryCoverage>(
    `/admin/inventory/warehouses/${warehouseId}/delivery-coverage?radiusKm=${String(radiusKm)}`,
  );
}

/**
 * The query key, shared by the map and the panel.
 *
 * Both of them want the same answer for the same warehouse at the same moment
 * - the map to draw the ring, the panel to list the flags - and one key is
 * what makes that one request. The radius is in the key because changing it
 * changes the answer.
 */
export function coverageQueryKey(warehouseId: string, radiusKm: number): readonly unknown[] {
  return ['delivery-coverage', warehouseId, radiusKm];
}
