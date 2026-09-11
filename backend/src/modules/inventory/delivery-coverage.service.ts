/**
 * Which countries a warehouse can deliver to inside a given radius.
 *
 * The Warehouses screen draws this as a glowing ring with a list of flags
 * beside it, and the whole value of the feature is that the list is *true*. A
 * delivery promise is a commercial statement - somebody reads "delivers to the
 * Netherlands" and quotes a customer on it - so every rule below exists to
 * stop this answering with something plausible instead of something measured.
 *
 * **The measurement is geodesic, from the warehouse's own coordinates.** Not
 * from the centroid of its country, not from the city in its address, and not
 * from a table of which countries border which. The radius is a real circle on
 * the sphere, the countries are real polygons, and the two are intersected.
 * See `domain/country-boundaries.ts` for why the two shortcuts are worse than
 * they look.
 *
 * **The home country is separated from the rest**, and that is what makes the
 * empty answer meaningful. A warehouse in central Spain reaches no foreign
 * border inside 100 km, and the honest response is a `countries` array with
 * nothing in it - not Portugal because it is next door, and not Spain padded
 * in to make the list look populated. The screen has a state for that and it
 * says so in words.
 *
 * **A country's distance is the distance to its nearest border**, which is the
 * only distance a delivery radius cares about. France is 2 km from a warehouse
 * in Basel and its capital is 400 km away; the first number is the one that
 * decides whether a van can get there.
 *
 * **The circle the browser draws is the circle the server measured.** It is
 * returned as geometry rather than as a radius for the frontend to re-derive,
 * because two implementations of "a 100 km circle" drift - one in metres on a
 * sphere, one in degrees on a Mercator projection - and a ring that does not
 * match the list beside it is worse than no ring. Same for each country's
 * covered area: the shape sent is the actual intersection that put that
 * country in the list.
 *
 * **Nothing here is cached against a warehouse id.** The coordinates are read
 * fresh every call, because a warehouse that has just been dragged 200 km must
 * not answer with yesterday's countries. What is cached is the parsed boundary
 * dataset, which is the expensive part and never changes.
 *
 * **Reachable and offered are two separate answers, and this module gives the
 * first one.** The radius is geometry and geometry knows nothing about
 * business: a 500 km circle around Antwerp reaches Luxembourg whether or not
 * this deployment has the paperwork to ship there. So an operator can close a
 * country on a warehouse, and a closed country still appears in this answer -
 * marked `isExcluded`, with the reason - rather than being filtered out. A map
 * that silently omits a road does not help anybody decide anything, and the
 * difference between "40 km too far" and "somebody closed this last March" is
 * the difference between a fact and a decision that can be undone.
 * `delivery-options.service.ts` is what actually withholds an excluded country
 * from a buyer.
 *
 * **The radius belongs to the warehouse.** `options.radiusKm` is for the
 * panel's slider - trying a promise before making it. Left absent, the
 * warehouse's own `deliveryRadiusKm` applies, and `DELIVERY_COVERAGE_RADIUS_KM`
 * where it has none. Every caller that has to be *right* rather than
 * exploratory - the storefront's delivery options above all - omits it.
 */
import booleanIntersects from '@turf/boolean-intersects';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import bbox from '@turf/bbox';
import circle from '@turf/circle';
import intersect from '@turf/intersect';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import polygonToLine from '@turf/polygon-to-line';
import simplify from '@turf/simplify';
import { featureCollection, lineString, point } from '@turf/helpers';
import type { Feature, LineString, MultiPolygon, Point, Polygon, Position } from 'geojson';
import { prisma } from '../../infra/prisma.js';
import { env } from '../../config/env.js';
import { ErrorCode, notFound, unprocessable } from '../../domain/errors.js';
import { boundaries, boxesOverlap, isoCountries } from '../../domain/country-boundaries.js';
import type { CountryBoundary } from '../../domain/country-boundaries.js';
import { classifyCoordinates } from './location.service.js';

/**
 * How round the circle is.
 *
 * 180 segments puts a vertex every two degrees, which at 100 km is a chord
 * error of about 15 metres - far inside the ~5 km the boundaries themselves are
 * drawn to. Raising it makes the payload bigger and the answer no truer.
 */
const CIRCLE_STEPS = 180;

/**
 * How hard the covered slices are simplified before being sent.
 *
 * Douglas-Peucker in degrees. 0.004° is roughly 400 m, which is invisible at
 * the zoom this is drawn at and takes a country's covered slice from tens of
 * kilobytes to a few. **Only the shape sent to the browser is simplified** -
 * every distance and every intersection test above runs on the full-resolution
 * polygon, so simplification can never add or drop a country.
 */
const SIMPLIFY_TOLERANCE = 0.004;

/** A country the radius reaches, as the API reports it. */
export interface CoveredCountry {
  /** ISO 3166-1 alpha-2, or null for a shape with no code of its own. */
  code: string | null;
  /** English name. The deployment's own `countries` table wins where it has a row. */
  name: string;
  /** The emoji flag, for consumers of this API. The panel draws its own - see below. */
  flag: string;
  /** Kilometres from the warehouse to this country's nearest border, one decimal. */
  distanceKm: number;
  /** The point on that border which is nearest, so a route can be drawn to it. */
  nearestPoint: { latitude: number; longitude: number };
  /** The part of this country inside the radius, simplified for drawing. */
  area: Polygon | MultiPolygon | null;
  /**
   * True when the operator has closed this country for this warehouse.
   *
   * **Reported rather than filtered out, and that is the point.** The radius
   * decides what geometry can reach; the exclusion list decides what the
   * business will serve. Dropping an excluded country from the answer would
   * make the two indistinguishable on screen - a country missing because it is
   * 40 km too far and a country missing because somebody closed it last March
   * would look identical, and the second one is a decision a person made and
   * may want to undo. So it stays in the list, drawn in the refusing colour,
   * with the reason beside it.
   *
   * `delivery-options.service.ts` is what actually withholds it from a buyer.
   * This is the map, and a map that hides a road does not help anybody.
   */
  isExcluded: boolean;
  /** Why it was closed, in the operator's words. Null when they gave no reason. */
  exclusionReason: string | null;
}

/** Where the radius that was measured came from. */
export type RadiusSource =
  /** The caller named a radius - the panel's own slider. */
  | 'REQUEST'
  /** The warehouse's stored `deliveryRadiusKm`. */
  | 'WAREHOUSE'
  /** `DELIVERY_COVERAGE_RADIUS_KM`, for a warehouse with no radius of its own. */
  | 'DEPLOYMENT_DEFAULT';

export interface DeliveryCoverage {
  warehouse: {
    id: string;
    code: string;
    name: string;
    latitude: number;
    longitude: number;
  };
  radiusKm: number;
  /**
   * Which of the three places the radius came from.
   *
   * On screen this is the difference between "this warehouse promises 500 km"
   * and "nobody has said, so the deployment's 500 applies". They are the same
   * number and not the same statement, and an operator setting up a second
   * warehouse needs to know which one they are looking at.
   */
  radiusSource: RadiusSource;
  /**
   * The country the warehouse itself stands in, by geometry rather than by the
   * `countryCode` somebody typed into the form.
   *
   * Null over international waters, and null for a warehouse whose coordinates
   * fall in a gap between polygons at this resolution. Reported separately
   * from `countries` so that an empty `countries` means exactly one thing:
   * no *foreign* border within the radius.
   */
  home: {
    code: string | null;
    name: string;
    flag: string;
    /**
     * A warehouse may be told not to deliver in its own country.
     *
     * Rare and entirely legitimate: a bonded warehouse serving export markets
     * only, or a site whose domestic sales go through a distributor. The home
     * country is not automatically served, so it carries the same flag as
     * every other.
     */
    isExcluded: boolean;
    exclusionReason: string | null;
  } | null;
  /** Foreign countries within the radius, nearest border first. */
  countries: CoveredCountry[];
  /**
   * Countries the operator has closed which the radius does *not* reach.
   *
   * The exclusions that are currently doing nothing, because they name a
   * country outside the circle. Kept and reported rather than deleted: a
   * radius grows, and an operator who closed Switzerland at 300 km has said
   * something that must still hold at 800. A list of them on screen is also
   * how somebody finds the exclusion they added to the wrong warehouse.
   */
  dormantExclusions: { code: string; name: string; flag: string; reason: string | null }[];
  /** The measured circle itself, so the browser draws what the server measured. */
  ring: Polygon;
  computedAt: string;
}

export interface DeliveryCoverageOptions {
  warehouseId: string;
  /**
   * The radius to measure, in kilometres.
   *
   * Absent means "whatever this warehouse promises" - its own
   * `deliveryRadiusKm`, and `DELIVERY_COVERAGE_RADIUS_KM` where it has none.
   * That is the shape the storefront needs, because a buyer's delivery options
   * must come from the warehouse's real geofence and never from a number a
   * caller passed in. The panel still passes one, because its slider is how an
   * operator tries a radius before committing to it.
   */
  radiusKm?: number;
}

/**
 * The nearest point on a country's border, and how far away it is.
 *
 * A country is a polygon or a pile of them, each with an outer ring and
 * possibly holes, so this walks every ring rather than trusting the first.
 * Skipping the rest would put the Netherlands' Caribbean islands ahead of its
 * land border for a warehouse in Antwerp.
 */
function nearestBorder(
  country: Feature<Polygon | MultiPolygon>,
  origin: Feature<Point>,
): { distanceKm: number; position: Position } | null {
  const outline = polygonToLine(country);
  const parts = outline.type === 'FeatureCollection' ? outline.features : [outline];

  let best: { distanceKm: number; position: Position } | null = null;

  for (const part of parts) {
    const rings: Feature<LineString>[] =
      part.geometry.type === 'MultiLineString'
        ? part.geometry.coordinates.map((coordinates) => lineString(coordinates))
        : [part as Feature<LineString>];

    for (const ring of rings) {
      const snapped = nearestPointOnLine(ring, origin, { units: 'kilometers' });
      const distanceKm = snapped.properties.dist;

      if (distanceKm === undefined) continue;
      if (best === null || distanceKm < best.distanceKm) {
        best = { distanceKm, position: snapped.geometry.coordinates };
      }
    }
  }

  return best;
}

/**
 * The part of a country inside the ring, small enough to send.
 *
 * Null rather than an error when the intersection comes back empty. Two
 * polygons that only touch along a line intersect for `booleanIntersects` and
 * produce no *area*, which is a real case on a shared border - the country
 * still belongs in the list, it simply has no slice to shade.
 */
function coveredArea(
  country: Feature<Polygon | MultiPolygon>,
  ring: Feature<Polygon>,
): Polygon | MultiPolygon | null {
  const clipped = intersect(featureCollection([ring, country]));
  if (clipped === null) return null;

  const thinned = simplify(clipped, { tolerance: SIMPLIFY_TOLERANCE, highQuality: false });
  return thinned.geometry;
}

/**
 * How far one warehouse is from one country, in kilometres.
 *
 * The narrow question, for the storefront. `deliveryCoverage` answers the
 * broad one - "which of the world's countries does this circle reach" - and
 * walks two hundred and forty polygons to do it. A buyer standing in Belgium
 * does not need that: the destination is known, so the work is one country's
 * geometry against one point, and the answer is the same number
 * `deliveryCoverage` would have reported for it.
 *
 * Zero when the warehouse stands inside the country, which is what makes
 * "delivers to its own country" fall out of the same comparison as everything
 * else rather than needing a special case at the call site.
 *
 * Null for a country the boundary dataset does not carry a shape for under
 * that code. Null rather than Infinity, because the two mean different things:
 * Infinity would say "measured, and out of range", and this says "not
 * measurable" - which is a question about the data, not about the distance,
 * and the caller has to be able to say so.
 */
export function distanceToCountryKm(
  origin: { latitude: number; longitude: number },
  countryCode: string,
): number | null {
  const country = boundaries().byCode.get(countryCode.trim().toUpperCase());
  if (country === undefined) return null;

  const from = point([origin.longitude, origin.latitude]);

  if (booleanPointInPolygon(from, country.geometry)) return 0;

  const border = nearestBorder(country.geometry, from);
  if (border === null) return null;

  return Math.round(border.distanceKm * 10) / 10;
}

/**
 * How far apart two points on the planet are, in kilometres.
 *
 * The haversine formula on a spherical earth. Good to about 0.3% against the
 * WGS-84 ellipsoid, which at 500 km is a kilometre and a half - irrelevant for
 * telling a buyer roughly how far their goods are travelling, and this is the
 * only thing it is ever used for.
 *
 * It lives here, beside `distanceToCountryKm`, because the rule this module's
 * header sets out applies to it too: **the measurement is the same
 * measurement**. Two implementations of "how far is Antwerp from here" is how
 * a checkout comes to disagree with the map an operator is looking at.
 *
 * What it measures is not what decides anything. Eligibility at checkout is
 * the delivery zones' business - see `WarehouseDeliveryZone` - and this is a
 * number printed beside an option so a buyer knows whether their box is coming
 * from the next town or the next continent.
 */
export function greatCircleKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_KM = 6371.0088;
  const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      Math.sin(dLon / 2) ** 2;

  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a))) * 10) / 10;
}

/**
 * Names, from the deployment's own table where it has them.
 *
 * The `countries` table is what already decides a country's currency, its
 * interface language and its VAT treatment, and it is a table an operator can
 * correct. If they have renamed one, the flap on the map has to agree with the
 * filter dropdown three inches below it. Where there is no row - most of the
 * world, for most deployments - the ISO English name from
 * `country-boundaries.ts` stands.
 */
async function operatorNames(codes: string[]): Promise<Map<string, string>> {
  if (codes.length === 0) return new Map();

  const rows = await prisma.country.findMany({
    where: { code: { in: codes } },
    select: { code: true, name: true },
  });

  return new Map(rows.map((row) => [row.code.toUpperCase(), row.name]));
}

/**
 * Which countries this warehouse reaches, measured rather than assumed.
 *
 * Throws `NOT_FOUND` for a warehouse that does not exist and
 * `LOCATION_NOT_PLACED` for one that exists with no plottable position -
 * two different situations with two different fixes, and the panel says
 * something different about each.
 */
export async function deliveryCoverage(
  options: DeliveryCoverageOptions,
): Promise<DeliveryCoverage> {
  const row = await prisma.inventoryLocation.findUnique({
    where: { id: options.warehouseId },
    select: {
      id: true,
      code: true,
      name: true,
      latitude: true,
      longitude: true,
      deliveryRadiusKm: true,
      exclusions: { select: { countryCode: true, reason: true } },
    },
  });

  if (row === null) throw notFound('Warehouse');

  // The three places a radius can come from, in the order that respects who
  // said it: the caller's slider, then the warehouse's own promise, then the
  // deployment's default. `radiusSource` travels with the answer so the screen
  // can say which of the three it is looking at.
  const radiusKm = options.radiusKm ?? row.deliveryRadiusKm ?? env.DELIVERY_COVERAGE_RADIUS_KM;
  const radiusSource: RadiusSource =
    options.radiusKm !== undefined
      ? 'REQUEST'
      : row.deliveryRadiusKm !== null
        ? 'WAREHOUSE'
        : 'DEPLOYMENT_DEFAULT';

  /**
   * The closed countries, by code.
   *
   * Read here rather than joined into the loop below because the loop walks
   * geometry and this is a lookup: an exclusion names a country whether or not
   * the circle reaches it, and the ones it does not reach have to survive to
   * `dormantExclusions` at the bottom.
   */
  const excluded = new Map<string, string | null>(
    row.exclusions.map((entry) => [entry.countryCode.toUpperCase(), entry.reason]),
  );

  // The same reader the list endpoint uses, so "placed" means one thing across
  // the module: coordinates that are present *and* inside the range each axis
  // actually has. A stored latitude of 999 is not a position.
  const position = classifyCoordinates(row);

  if (position.latitude === null || position.longitude === null) {
    throw unprocessable(
      ErrorCode.LOCATION_NOT_PLACED,
      position.coordinatesInvalid
        ? `Warehouse ${row.code} has coordinates that cannot be plotted, so its delivery coverage cannot be measured. Correct them on the warehouse.`
        : `Warehouse ${row.code} has no coordinates yet, so its delivery coverage cannot be measured. Add them on the warehouse, or look them up from its address.`,
    );
  }

  const { latitude, longitude } = position;
  const origin = point([longitude, latitude]);
  const ring = circle([longitude, latitude], radiusKm, {
    steps: CIRCLE_STEPS,
    units: 'kilometers',
  });
  const ringBox = bbox(ring);

  // Rectangles first, polygons second. See `boxesOverlap`.
  const candidates = boundaries().countries.filter((country) =>
    boxesOverlap(country.box, ringBox),
  );

  let home: CountryBoundary | null = null;
  const reached: { country: CountryBoundary; distanceKm: number; position: Position }[] = [];

  for (const country of candidates) {
    if (!booleanIntersects(ring, country.geometry)) continue;

    // The country the warehouse stands in. Taken out of the list rather than
    // reported at distance zero: "delivers to" is a list of places the radius
    // *reaches*, and the building's own country is not news.
    if (booleanPointInPolygon(origin, country.geometry)) {
      home = country;
      continue;
    }

    const border = nearestBorder(country.geometry, origin);
    if (border === null) continue;

    // Belt to the intersection test's braces. The warehouse is outside this
    // country and the country overlaps the ring, so its nearest border point
    // is necessarily inside the radius - but a polygon that only grazes the
    // ring can round to a hair over it, and a list headed "within 500 km" may
    // not contain 500.3.
    if (border.distanceKm > radiusKm) continue;

    reached.push({ country, distanceKm: border.distanceKm, position: border.position });
  }

  reached.sort((a, b) => a.distanceKm - b.distanceKm);

  /**
   * Which of the closed countries the circle never reached.
   *
   * Everything the geometry found is taken out, and what is left is an
   * exclusion that is currently doing nothing. It is still reported - see
   * `dormantExclusions` on the response type.
   */
  const dormantCodes = new Set(excluded.keys());
  for (const hit of reached) if (hit.country.code !== null) dormantCodes.delete(hit.country.code);
  if (home?.code !== null && home?.code !== undefined) dormantCodes.delete(home.code);

  const names = await operatorNames(
    [...reached.map((hit) => hit.country.code), home?.code ?? null, ...dormantCodes].filter(
      (code): code is string => code !== null,
    ),
  );

  const countries: CoveredCountry[] = reached.map((hit) => ({
    code: hit.country.code,
    name: (hit.country.code === null ? undefined : names.get(hit.country.code)) ?? hit.country.name,
    flag: hit.country.flag,
    // One decimal. The boundaries are drawn to about 5 km, so a metre-precise
    // figure here would be a lie told to three more digits.
    distanceKm: Math.round(hit.distanceKm * 10) / 10,
    nearestPoint: { latitude: hit.position[1] ?? latitude, longitude: hit.position[0] ?? longitude },
    area: coveredArea(hit.country.geometry, ring),
    isExcluded: hit.country.code !== null && excluded.has(hit.country.code),
    exclusionReason: hit.country.code === null ? null : (excluded.get(hit.country.code) ?? null),
  }));

  // Named from the ISO list rather than from the boundary dataset, because a
  // dormant exclusion has no shape in this answer to take a name from.
  const isoByCode = new Map(isoCountries().map((country) => [country.code, country]));

  const dormantExclusions = [...dormantCodes]
    .map((code) => {
      const iso = isoByCode.get(code);
      return {
        code,
        name: names.get(code) ?? iso?.name ?? code,
        flag: iso?.flag ?? '',
        reason: excluded.get(code) ?? null,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  return {
    warehouse: {
      id: row.id,
      code: row.code,
      name: row.name,
      latitude,
      longitude,
    },
    radiusKm,
    radiusSource,
    home:
      home === null
        ? null
        : {
            code: home.code,
            name: (home.code === null ? undefined : names.get(home.code)) ?? home.name,
            flag: home.flag,
            isExcluded: home.code !== null && excluded.has(home.code),
            exclusionReason: home.code === null ? null : (excluded.get(home.code) ?? null),
          },
    countries,
    dormantExclusions,
    ring: ring.geometry,
    computedAt: new Date().toISOString(),
  };
}
