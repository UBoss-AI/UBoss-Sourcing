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
import { ErrorCode, notFound, unprocessable } from '../../domain/errors.js';
import { boundaries, boxesOverlap } from '../../domain/country-boundaries.js';
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
  /**
   * The country the warehouse itself stands in, by geometry rather than by the
   * `countryCode` somebody typed into the form.
   *
   * Null over international waters, and null for a warehouse whose coordinates
   * fall in a gap between polygons at this resolution. Reported separately
   * from `countries` so that an empty `countries` means exactly one thing:
   * no *foreign* border within the radius.
   */
  home: { code: string | null; name: string; flag: string } | null;
  /** Foreign countries within the radius, nearest border first. */
  countries: CoveredCountry[];
  /** The measured circle itself, so the browser draws what the server measured. */
  ring: Polygon;
  computedAt: string;
}

export interface DeliveryCoverageOptions {
  warehouseId: string;
  radiusKm: number;
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
    select: { id: true, code: true, name: true, latitude: true, longitude: true },
  });

  if (row === null) throw notFound('Warehouse');

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
  const ring = circle([longitude, latitude], options.radiusKm, {
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
    // ring can round to a hair over it, and a list headed "within 100 km" may
    // not contain 100.3.
    if (border.distanceKm > options.radiusKm) continue;

    reached.push({ country, distanceKm: border.distanceKm, position: border.position });
  }

  reached.sort((a, b) => a.distanceKm - b.distanceKm);

  const names = await operatorNames(
    [...reached.map((hit) => hit.country.code), home?.code ?? null].filter(
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
  }));

  return {
    warehouse: {
      id: row.id,
      code: row.code,
      name: row.name,
      latitude,
      longitude,
    },
    radiusKm: options.radiusKm,
    home:
      home === null
        ? null
        : {
            code: home.code,
            name: (home.code === null ? undefined : names.get(home.code)) ?? home.name,
            flag: home.flag,
          },
    countries,
    ring: ring.geometry,
    computedAt: new Date().toISOString(),
  };
}
