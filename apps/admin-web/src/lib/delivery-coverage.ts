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
  /**
   * True when the operator has closed this country for this warehouse.
   *
   * **Shown rather than hidden, and that is the point of the field.** The
   * radius decides what geometry can reach; the exclusion list decides what
   * the business will serve. A closed country dropped from this list would be
   * indistinguishable from one 40 km too far away - and the first is a
   * decision somebody made and may want to undo, where the second is a fact
   * about the ground. So it stays on the map, drawn in the refusing colour,
   * with the reason beside it.
   *
   * The storefront's own option list is what actually withholds it from a
   * buyer. See `delivery-options.service.ts` on the server.
   */
  isExcluded: boolean;
  /** Why it was closed, in the operator's words. Null when they gave none. */
  exclusionReason: string | null;
}

/**
 * Where the radius that was measured came from.
 *
 * `REQUEST` is the panel's own slider - somebody trying a radius before
 * committing to it. `WAREHOUSE` is the warehouse's stored promise.
 * `DEPLOYMENT_DEFAULT` is `DELIVERY_COVERAGE_RADIUS_KM`, for a warehouse
 * nobody has given a radius of its own. The three are the same number and
 * three different statements, which is why the panel says which it is.
 */
export type RadiusSource = 'REQUEST' | 'WAREHOUSE' | 'DEPLOYMENT_DEFAULT';

export interface DeliveryCoverage {
  warehouse: {
    id: string;
    code: string;
    name: string;
    latitude: number;
    longitude: number;
  };
  radiusKm: number;
  /** Which of the three places `radiusKm` came from. */
  radiusSource: RadiusSource;
  /**
   * The country the warehouse stands in, by geometry. Null over water.
   *
   * It carries the exclusion flags too, because a warehouse may legitimately
   * be told not to deliver in its own country - a bonded site serving export
   * markets only, or one whose domestic sales go through a distributor.
   */
  home: {
    code: string | null;
    name: string;
    flag: string;
    isExcluded: boolean;
    exclusionReason: string | null;
  } | null;
  /** Foreign countries within the radius, nearest border first. */
  countries: CoveredCountry[];
  /**
   * Countries the operator closed which this radius does *not* reach.
   *
   * The exclusions currently doing nothing. Listed rather than dropped: a
   * radius grows, and somebody who closed Switzerland at 300 km has said
   * something that must still hold at 800. It is also how an exclusion added
   * to the wrong warehouse gets found.
   */
  dormantExclusions: { code: string; name: string; flag: string; reason: string | null }[];
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

/**
 * Ask what this warehouse reaches.
 *
 * **`radiusKm` is deliberately optional, and the panel does not pass it.**
 * Omitted, the server measures the radius the warehouse actually promises -
 * its own `deliveryRadiusKm`, and the deployment's default where it has none -
 * and says which of the two it used. Passing one asks a *hypothetical*: it is
 * for a control that lets somebody try a radius before committing to it, and
 * the answer comes back marked `REQUEST` so the panel can say so rather than
 * presenting a figure nobody has agreed to as this warehouse's promise.
 *
 * This used to always pass the deployment-wide figure, which was wrong in a
 * way that only showed up once warehouses could carry their own: the panel
 * drew a 500 km ring over a warehouse promising 800 and labelled it as that
 * warehouse's coverage.
 */
export function fetchDeliveryCoverage(
  warehouseId: string,
  radiusKm?: number,
): Promise<DeliveryCoverage> {
  const query = radiusKm === undefined ? '' : `?radiusKm=${String(radiusKm)}`;

  return api.get<DeliveryCoverage>(
    `/admin/inventory/warehouses/${warehouseId}/delivery-coverage${query}`,
  );
}

/**
 * The query key, shared by the map and the panel.
 *
 * Both of them want the same answer for the same warehouse at the same moment
 * - the map to draw the ring, the panel to list the flags - and one key is
 * what makes that one request.
 *
 * The radius is in the key even when it is not sent, and that is what keeps
 * the cache honest: the answer for a warehouse changes when *its* radius
 * changes, so the number that went into producing it has to be part of the
 * key. Editing a warehouse from 500 to 800 km would otherwise serve the old
 * ring out of the cache.
 */
export function coverageQueryKey(warehouseId: string, radiusKm: number): readonly unknown[] {
  return ['delivery-coverage', warehouseId, radiusKm];
}
