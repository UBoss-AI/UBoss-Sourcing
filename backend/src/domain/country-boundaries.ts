/**
 * The world's country boundaries, as geometry.
 *
 * This exists so that a question like "which countries does a 100 km radius
 * around this warehouse reach" can be answered from the actual shape of the
 * ground rather than from a table of neighbours or a centroid. Those two
 * shortcuts are the reason this module is worth its weight:
 *
 *   - **A neighbour table lies about distance.** Belgium borders Germany, so a
 *     neighbour lookup puts Germany in the answer for a warehouse in Antwerp -
 *     which is 150 km from the German border and cannot be reached inside 100.
 *     The same table drops the Netherlands from a warehouse in Kent, and it has
 *     nothing at all to say about which of two neighbours is nearer.
 *   - **A country centroid lies about everything.** The centroid of France is
 *     450 km from Basel; the border is 2 km away. Any calculation that reduces
 *     a country to a point gets a 100 km promise wrong by an order of
 *     magnitude, and gets it wrong in the direction that matters - it refuses
 *     deliveries that are twenty minutes down the road.
 *
 * **The resolution is Natural Earth 1:50m, and that is a decision.** The same
 * dataset ships at 1:110m and 1:10m. At 1:110m a border is drawn to about
 * 30 km of accuracy, which is a third of the radius being measured - useless.
 * At 1:10m it is drawn to about 3 km, costs roughly four times the memory and
 * four times the geometry to walk, and is more precision than a delivery
 * promise made in whole kilometres can use. 1:50m lands at roughly 5 km, which
 * is inside the noise of "how far is that by road anyway".
 *
 * **Nothing is loaded until something asks.** The parsed boundaries are about
 * 14 MB of heap, which is a real cost on a small box and a pointless one for
 * the many deployments that never open the coverage panel. `boundaries()`
 * parses on first call and memoises; the API process starts, and the worker
 * runs its whole life, without touching it.
 *
 * **The data travels with the repository.** It is an npm dependency
 * (`world-atlas`, from Natural Earth, public domain) rather than a URL fetched
 * at runtime, because this software is installed behind other companies'
 * firewalls and a map of the world that needs an outbound request is a map of
 * the world that is sometimes missing.
 */
import { createRequire } from 'node:module';
import bbox from '@turf/bbox';
import { feature as topoFeature } from 'topojson-client';
import type { BBox, Feature, MultiPolygon, Polygon } from 'geojson';
import type { Topology } from 'topojson-specification';
import type { Country } from 'world-countries';

/**
 * Both datasets are read with `require`, not imported.
 *
 * Two reasons, and they are different for the two files.
 *
 * The boundaries are 739 KB of nested coordinate arrays. `resolveJsonModule`
 * would let that be an ordinary import, and TypeScript types a JSON module by
 * reading the literal - so every `tsc` run in the repository, plus the editor,
 * would pay to infer a type for a million numbers no code here looks at.
 * `require` hands back a value this module types once, by hand.
 *
 * The ISO list is required rather than imported because both calls sit inside
 * `load()`, which is what keeps the promise in this file's header: **a process
 * that never asks for a coverage radius never parses either dataset.** A
 * top-level `import` would load both at startup, in the API and in the worker,
 * for a feature most requests never touch.
 *
 * Both resolve through their package rather than a relative path, so the files
 * are found identically under `tsx` and in `dist`, with no copy step.
 */
const require = createRequire(import.meta.url);

/** One country, with the box that lets it be skipped cheaply. */
export interface CountryBoundary {
  /**
   * ISO 3166-1 alpha-2, upper case - the code the rest of this product keys
   * countries by, including the `countries` table and the flags the panel
   * draws.
   *
   * Null for the handful of shapes in the dataset with no alpha-2 of their
   * own: disputed areas, and territories carried separately from the state
   * that administers them. They keep their geometry and their name, so a
   * radius that reaches one is still reported honestly rather than silently
   * dropped - `code` being null is what tells a caller it has no flag and no
   * row in the `countries` table.
   */
  code: string | null;
  /** ISO 3166-1 numeric, which is what the boundary dataset keys on. */
  numeric: string;
  /**
   * The country's name in English.
   *
   * From `world-countries` where the alpha-2 matched, and from the boundary
   * dataset otherwise. The two disagree in the cases where a name has changed
   * and one of them has not caught up - the boundary dataset still says
   * "Macedonia" where ISO says "North Macedonia" - and the ISO list is the one
   * to trust for that. A deployment's own `countries` table overrides both;
   * see `resolveName` in delivery-coverage.service.ts.
   */
  name: string;
  /** The emoji flag, for API consumers. Empty where there is no alpha-2. */
  flag: string;
  geometry: Feature<Polygon | MultiPolygon>;
  /** `[west, south, east, north]`, precomputed once. */
  box: BBox;
}

interface Loaded {
  countries: CountryBoundary[];
  byCode: Map<string, CountryBoundary>;
}

let loaded: Loaded | null = null;

/**
 * ISO numeric to the alpha-2, name and flag that go with it.
 *
 * Built from `world-countries` rather than written out here: it is the ISO
 * 3166-1 list itself, it carries all three fields, and a hand-maintained copy
 * of 250 rows in this repository is 250 rows to get wrong.
 */
function isoIndex(): Map<string, { code: string; name: string; flag: string }> {
  const index = new Map<string, { code: string; name: string; flag: string }>();
  const countryList = require('world-countries') as Country[];

  for (const entry of countryList) {
    index.set(entry.ccn3, {
      code: entry.cca2.toUpperCase(),
      name: entry.name.common,
      flag: entry.flag,
    });
  }

  return index;
}

/**
 * Parse the dataset, once.
 *
 * TopoJSON rather than GeoJSON on disk because that is what shares the arcs
 * between two countries that touch - the file is 739 KB where the same
 * boundaries as GeoJSON are several megabytes - and `topojson-client` is what
 * turns it back into polygons the geometry functions can use.
 */
function load(): Loaded {
  // The one cast in this module, and the reason the check below exists: what
  // comes back from `require` is `any`, so the shape is asserted rather than
  // assumed.
  const topo = require('world-atlas/countries-50m.json') as Topology;
  const countryObject = topo.objects['countries'];

  if (countryObject === undefined) {
    throw new Error('country boundaries: world-atlas is missing its `countries` object');
  }

  const collection = topoFeature(topo, countryObject);

  if (collection.type !== 'FeatureCollection') {
    throw new Error('country boundaries: expected a FeatureCollection of countries');
  }

  const iso = isoIndex();
  const countries: CountryBoundary[] = [];
  const byCode = new Map<string, CountryBoundary>();

  for (const shape of collection.features) {
    if (shape.geometry.type !== 'Polygon' && shape.geometry.type !== 'MultiPolygon') continue;

    const numeric = String(shape.id ?? '');
    const match = iso.get(numeric);
    const geometry = {
      type: 'Feature' as const,
      properties: {},
      geometry: shape.geometry,
    };

    // `properties.name` is the dataset's own English name, and the fallback
    // for a shape with no ISO row - Kosovo, Somaliland, the disputed areas.
    const datasetName =
      typeof shape.properties?.['name'] === 'string' ? shape.properties['name'] : numeric;

    const entry: CountryBoundary = {
      code: match?.code ?? null,
      numeric,
      name: match?.name ?? datasetName,
      flag: match?.flag ?? '',
      geometry,
      box: bbox(geometry),
    };

    countries.push(entry);
    if (entry.code !== null) byCode.set(entry.code, entry);
  }

  return { countries, byCode };
}

/** Every country's boundary, parsed on first use and kept. */
export function boundaries(): Loaded {
  loaded ??= load();
  return loaded;
}

/** One country in the ISO 3166-1 list, with no geometry attached. */
export interface IsoCountry {
  /** ISO 3166-1 alpha-2, upper case. */
  code: string;
  /** English name, from the ISO list. */
  name: string;
  /** The emoji flag. */
  flag: string;
}

let isoList: IsoCountry[] | null = null;

/**
 * Every country there is, by ISO code and name, with no boundaries loaded.
 *
 * This exists because the geofencing screens ask a question the `countries`
 * table cannot answer. That table is the list of markets the deployment
 * *prices in* - a few dozen rows, each with a currency behind it - and it is
 * the right list for a price, a VAT treatment and an interface language. It is
 * the wrong list for "which countries may this warehouse be told not to
 * deliver to", because a 500 km circle reaches countries a deployment has
 * never sold into, and those are exactly the ones an operator most wants to
 * close. A picker built from `countries` would offer forty rows and hide the
 * other two hundred.
 *
 * Separate from `boundaries()` on purpose: this is 250 short rows built from
 * `world-countries` alone, where `boundaries()` parses 739 KB of TopoJSON into
 * about 14 MB of heap. The exclusion picker and the country-code validation
 * need the names and nothing else, and they should not drag the geometry in
 * behind them.
 *
 * Sorted by English name, because that is the order a picker reads in.
 */
export function isoCountries(): IsoCountry[] {
  isoList ??= (require('world-countries') as Country[])
    .map((entry) => ({
      code: entry.cca2.toUpperCase(),
      name: entry.name.common,
      flag: entry.flag,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'));

  return isoList;
}

/**
 * Is this a real ISO 3166-1 alpha-2 code?
 *
 * The check `warehouse_country_exclusions` has instead of a foreign key. The
 * column's CHECK constraint holds the shape - two upper-case letters - and
 * this holds the meaning, so "XX" is refused with a message about the country
 * rather than accepted as a row that will never match anything.
 */
export function isIsoCountryCode(code: string): boolean {
  const upper = code.trim().toUpperCase();
  return isoCountries().some((country) => country.code === upper);
}

/**
 * Do two boxes overlap at all?
 *
 * The whole reason the boxes are precomputed. Testing a 100 km circle against
 * 241 real polygons is tens of milliseconds of geometry; testing it against
 * 241 rectangles first leaves four or five polygons actually worth walking.
 *
 * Deliberately inclusive at the edges - two boxes that merely touch are
 * "overlapping" here - because this only ever decides whether to run the exact
 * test afterwards, and the cheap answer must never be the one that loses a
 * country.
 */
export function boxesOverlap(a: BBox, b: BBox): boolean {
  return !(a[0] > b[2] || a[2] < b[0] || a[1] > b[3] || a[3] < b[1]);
}
