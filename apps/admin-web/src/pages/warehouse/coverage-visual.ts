/**
 * The delivery-coverage layers on the map: the ring, the covered countries,
 * the routes, and the camera move that shows them.
 *
 * Kept out of `WarehouseMapLibre.tsx` because none of it is React. It is a
 * controller with `show`, `hide` and `dispose`, holding the sources and layers
 * it added and the one animation frame it runs. A component that tried to
 * express "seven map layers and a camera flight" as JSX would re-add them on
 * every render, and MapLibre throws on a duplicate layer id.
 *
 * **The ring is drawn from the geometry the server sent.** Not from a radius
 * and a centre. A circle drawn in projected degrees is not the circle a
 * geodesic measurement produced - at 52°N the difference is tens of kilometres
 * on the east-west axis - and a ring that disagrees with the list of countries
 * beside it is worse than no ring at all.
 *
 * **The colours are read from the panel's own tokens**, once, when the layers
 * are built. MapLibre paint properties take real colours and cannot read a CSS
 * variable, so the alternative is a second palette in this file that drifts
 * from the first time somebody adjusts the brand blue.
 *
 * **Motion is one `requestAnimationFrame` loop setting three paint
 * properties.** Not seven layers each with their own timer, and not a CSS
 * animation over a canvas that cannot have one. Under
 * `prefers-reduced-motion: reduce` the loop never starts: every layer is drawn
 * at its resting value, the camera jumps instead of flying, and the feature
 * still works completely - which is the test of whether the motion was
 * decoration or information.
 */
import type { ExpressionSpecification, GeoJSONSource, Map as MapLibreMap } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Polygon, Position } from 'geojson';
import type { DeliveryCoverage } from '@/lib/delivery-coverage';

/** Every id this module owns, so teardown can be exhaustive rather than hopeful. */
const SOURCE = {
  ring: 'uboss-coverage-ring',
  areas: 'uboss-coverage-areas',
  /**
   * The countries in range that the operator has closed.
   *
   * A source of its own rather than a flag on `areas`, because the two are
   * drawn by different layers in different colours - and one source filtered
   * twice means every paint change has to be made in two `filter` expressions
   * that can drift apart.
   */
  excluded: 'uboss-coverage-excluded',
  routes: 'uboss-coverage-routes',
  targets: 'uboss-coverage-targets',
} as const;

const LAYER = {
  ringFill: 'uboss-coverage-ring-fill',
  ringGlow: 'uboss-coverage-ring-glow',
  ringEdge: 'uboss-coverage-ring-edge',
  areaFill: 'uboss-coverage-area-fill',
  areaEdge: 'uboss-coverage-area-edge',
  /** The served slices, standing up. Height is proximity - see `areasFor`. */
  areaExtrude: 'uboss-coverage-area-extrude',
  excludedFill: 'uboss-coverage-excluded-fill',
  excludedEdge: 'uboss-coverage-excluded-edge',
  excludedExtrude: 'uboss-coverage-excluded-extrude',
  route: 'uboss-coverage-route',
  target: 'uboss-coverage-target',
} as const;

/** Ordered outermost-first, because layers are removed in reverse of adding. */
const LAYER_ORDER = [
  LAYER.ringFill,
  LAYER.ringGlow,
  LAYER.ringEdge,
  LAYER.areaFill,
  LAYER.areaEdge,
  LAYER.excludedFill,
  LAYER.excludedEdge,
  // The extrusions last, so they stand in front of every flat wash. Removed
  // first, which is what `[...LAYER_ORDER].reverse()` in `clear` relies on.
  LAYER.areaExtrude,
  LAYER.excludedExtrude,
  LAYER.route,
  LAYER.target,
] as const;

/** The tilt that makes the ring read as a dome rather than a circle. */
const PITCH = 52;

/**
 * How much of the map the ring should fill when the camera settles.
 *
 * Padding in pixels around the ring's box. Generous, because at a 52° pitch
 * the far edge of the ring sits much higher up the screen than an unpitched
 * fit would put it, and a ring clipped by the top of the map looks like a bug.
 */
const FIT_PADDING = 64;

/** How long the camera takes to arrive, and to go back. */
const FLIGHT_MS = 1100;
const RETURN_MS = 900;

/**
 * The bow in a delivery route, as a fraction of its own length.
 *
 * Straight lines between two points on a map are read as measurements; a bowed
 * one is read as a journey, which is what this is. 0.22 is enough to be
 * obviously deliberate and not enough to leave the corridor the van would
 * actually drive.
 */
const ROUTE_BOW = 0.22;

/** Samples along each arc. Past this the curve is smooth and the payload is not. */
const ROUTE_STEPS = 48;

interface Palette {
  brand: string;
  brandSoft: string;
  edge: string;
  /** The refusing colour, for a country the operator has closed. */
  danger: string;
}

/**
 * The panel's own blue, as MapLibre needs it.
 *
 * The tokens are stored as unquoted RGB triplets ("29 78 216") so Tailwind can
 * put an alpha into them; `rgb()` accepts exactly that syntax, so no parsing is
 * needed. The fallbacks are the light theme's values, for the one case this
 * cannot happen in - a detached container with no computed style.
 */
function palette(): Palette {
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string, fallback: string): string => {
    const value = styles.getPropertyValue(name).trim();
    return value === '' ? fallback : `rgb(${value})`;
  };

  return {
    brand: token('--brand', '29 78 216'),
    brandSoft: token('--operational', '15 118 110'),
    edge: token('--brand-hover', '30 64 175'),
    danger: token('--danger', '185 28 28'),
  };
}

/**
 * One delivery route, as a curve.
 *
 * A quadratic Bézier whose control point is pushed off the midpoint at right
 * angles to the line. The offset is scaled by `cos(latitude)` on the x axis so
 * the bow looks the same on screen as it does in degrees - without it an arc
 * across Finland is visibly flatter than the same arc across Spain.
 */
function arc(from: Position, to: Position): Feature<LineString> {
  const [x1, y1] = [from[0] ?? 0, from[1] ?? 0];
  const [x2, y2] = [to[0] ?? 0, to[1] ?? 0];

  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const stretch = Math.max(Math.cos((midY * Math.PI) / 180), 0.1);

  // Perpendicular to the chord, in screen-ish proportions.
  const dx = (x2 - x1) * stretch;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy) || 1;
  const controlX = midX + ((-dy / length) * length * ROUTE_BOW) / stretch;
  const controlY = midY + (dx / length) * length * ROUTE_BOW;

  const coordinates: Position[] = [];
  for (let step = 0; step <= ROUTE_STEPS; step += 1) {
    const t = step / ROUTE_STEPS;
    const inverse = 1 - t;
    coordinates.push([
      inverse * inverse * x1 + 2 * inverse * t * controlX + t * t * x2,
      inverse * inverse * y1 + 2 * inverse * t * controlY + t * t * y2,
    ]);
  }

  return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } };
}

/**
 * The delivery routes: one bowed arc per country the radius reaches.
 *
 * **Closed countries get no arc, and that is the one place on this map where
 * an exclusion is hidden rather than shown.** Everything else here draws a
 * closed country in the refusing colour, because an operator has to be able to
 * see the decision they made. An arc is different: it carries a light that
 * travels out along it, which reads as a van leaving - and animating a
 * delivery to a country this warehouse will not deliver to is the map telling
 * a lie about the thing it is for. The country is still shaded, still edged in
 * red and still listed in the panel; it simply has no journey drawn to it.
 */
function routesFor(coverage: DeliveryCoverage): FeatureCollection<LineString> {
  const origin: Position = [coverage.warehouse.longitude, coverage.warehouse.latitude];

  return {
    type: 'FeatureCollection',
    features: coverage.countries
      .filter((country) => !country.isExcluded)
      .map((country) =>
        arc(origin, [country.nearestPoint.longitude, country.nearestPoint.latitude]),
      ),
  };
}

/** Where each arc lands. Same rule as the arcs: no target for a closed country. */
function targetsFor(coverage: DeliveryCoverage): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: coverage.countries
      .filter((country) => !country.isExcluded)
      .map((country) => ({
        type: 'Feature',
        properties: { code: country.code ?? '' },
        geometry: {
          type: 'Point',
          coordinates: [country.nearestPoint.longitude, country.nearestPoint.latitude],
        },
      })),
  };
}

/**
 * How tall the tallest covered slice stands, in metres.
 *
 * The extrusion is the one thing on this map that is genuinely three
 * dimensional, and what it encodes is *proximity*: the nearest country stands
 * highest. That is the right way round for a delivery map - the tall block is
 * the one a van reaches first - and it means the reader can rank the answer by
 * looking at it rather than by reading six distances.
 *
 * 90 km, which sounds enormous and is not: at the zoom a 500 km ring fits into,
 * a 90 km column is about the height of a modest building on screen. Anything
 * shorter is invisible under a 52° pitch; anything taller starts hiding the
 * countries behind it, which is the one thing a coverage map may not do.
 */
const EXTRUDE_MAX_M = 90_000;

/** The shortest a slice gets, so a country at the very edge is still a block. */
const EXTRUDE_MIN_M = 12_000;

/**
 * The covered slices, split by whether the operator will serve them.
 *
 * Two collections rather than one with a flag, because they are drawn by
 * different layers in different colours - and a single source filtered twice
 * would mean every paint change had to be made in two `filter` expressions
 * that could drift apart.
 *
 * Each feature carries its own `height`, computed here rather than as a
 * MapLibre expression over `distanceKm`. The scale needs the radius to divide
 * by, which the expression would have to be rebuilt for on every answer -
 * at which point it is a number this function may as well work out.
 */
function areasFor(coverage: DeliveryCoverage): {
  served: FeatureCollection;
  excluded: FeatureCollection;
} {
  const served: Feature[] = [];
  const excluded: Feature[] = [];

  for (const country of coverage.countries) {
    // A country whose overlap with the ring is a line rather than an area has
    // nothing to shade. It still belongs in the list beside the map.
    if (country.area === null) continue;

    // 1 at the warehouse's own doorstep, 0 at the edge of the radius. Clamped
    // because a border can measure a hair over the radius - see the note on
    // the same rounding in the service.
    const nearness = Math.max(0, Math.min(1, 1 - country.distanceKm / coverage.radiusKm));

    const feature: Feature = {
      type: 'Feature',
      properties: {
        code: country.code ?? '',
        height: EXTRUDE_MIN_M + nearness * (EXTRUDE_MAX_M - EXTRUDE_MIN_M),
      },
      geometry: country.area,
    };

    if (country.isExcluded) excluded.push(feature);
    else served.push(feature);
  }

  return {
    served: { type: 'FeatureCollection', features: served },
    excluded: { type: 'FeatureCollection', features: excluded },
  };
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

/** How much of a route the travelling light covers, as a fraction of its length. */
const ROUTE_LIGHT_WINDOW = 0.22;

/**
 * A light travelling along a route, as a gradient.
 *
 * `line-gradient` over a source with `lineMetrics` is the only way to move
 * something along a line at 60fps: the alternative, animating
 * `line-dasharray`, re-tessellates the line every frame and stutters.
 *
 * **Every stop has to be strictly greater than the one before it**, and that
 * is the whole reason this function is as careful as it is. An `interpolate`
 * with two stops at the same position is an invalid expression, and MapLibre's
 * response to an invalid paint property is to reject the *layer* - not to
 * throw, not to draw it badly. The first version of this clamped the window's
 * edges into range, so at `head === 0` three stops landed on 0 and the routes
 * layer was silently dropped from the style while every other layer appeared:
 * arcs that were simply never drawn, with nothing anywhere saying why.
 *
 * So the window is *travelled through* the range rather than clamped inside
 * it: it starts entirely before the line and ends entirely after it, which is
 * also what makes the light enter and leave rather than appear in the middle.
 * Where the clamp leaves it too thin to interpolate across, the answer is a
 * plain line - which is exactly right, because that is the moment the light is
 * off the end of it.
 */
function routeGradient(head: number, palette: Palette): ExpressionSpecification {
  const plain: ExpressionSpecification = [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0,
    palette.brand,
    1,
    palette.brand,
  ];

  const start = head * (1 + ROUTE_LIGHT_WINDOW) - ROUTE_LIGHT_WINDOW;
  const from = Math.max(start, 0);
  const to = Math.min(start + ROUTE_LIGHT_WINDOW, 1);

  // Off the line, or squeezed by the clamp into less than the width a gradient
  // can be seen across.
  if (to - from < 0.02) return plain;

  const stops: (number | string)[] = [0, palette.brand];

  // Each edge is skipped when it has collapsed onto the endpoint next to it,
  // which is what keeps the sequence strictly ascending at both ends.
  if (from > 0.001) stops.push(from, palette.brand);
  stops.push((from + to) / 2, '#ffffff');
  if (to < 0.999) stops.push(to, palette.brand);
  stops.push(1, palette.brand);

  return ['interpolate', ['linear'], ['line-progress'], ...stops] as ExpressionSpecification;
}

export interface CoverageVisual {
  /** Draw a coverage answer and fly to it. Replaces whatever was shown. */
  show: (coverage: DeliveryCoverage) => void;
  /**
   * Take the ring down but leave the camera where it is.
   *
   * For the moment between pointing at a second warehouse and its answer
   * arriving. Without it that moment is either a ring belonging to the
   * *previous* warehouse sitting under a panel naming the new one, or - worse -
   * a full flight back to the overview and a second flight straight back in,
   * which is two seconds of camera work to answer a question the reader asked
   * once.
   */
  clearLayers: () => void;
  /** Clear the layers and return the camera to the overview. */
  hide: () => void;
  /** Clear everything without moving the camera, for unmount. */
  dispose: () => void;
}

/**
 * Build the controller for one map.
 *
 * Nothing is added to the style here - a coverage answer has to arrive first -
 * so calling this for every map, including the ones nobody ever hovers, costs
 * an object.
 */
export function coverageVisual(map: MapLibreMap): CoverageVisual {
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let colours: Palette | null = null;
  let built = false;
  let frame: number | null = null;

  interface Camera {
    center: [number, number];
    zoom: number;
    pitch: number;
    bearing: number;
  }

  /**
   * Is a coverage view up, or on its way up or down?
   *
   * The flag that keeps `overview` honest. Everything the camera does while
   * this is true was done by this module, and must never be mistaken for where
   * the reader had the map.
   */
  let active = false;

  /**
   * The camera to come back to.
   *
   * **Observed, not captured on the way in**, and that distinction is a bug
   * this file had. The first version read the camera inside `show`, which is
   * wrong the moment two `show`s are separated by a `hide`: pointing from one
   * marker to another meant the second `show` read the camera *during the
   * first one's return flight* and recorded a half-tilted, half-zoomed
   * intermediate as the overview. Moving the pointer away then "returned" to
   * that - a map left at 30° over nothing, which no amount of moving the mouse
   * would put right.
   *
   * So it is recorded from `moveend`, and only while `active` is false: the
   * places the *reader* left the camera, never the places this module flew it
   * to. It is not cleared on `hide`, because the overview outlives any one
   * coverage view - and re-reading it would be the same mistake again.
   */
  let overview: Camera = readCamera();

  function readCamera(): Camera {
    const centre = map.getCenter();
    return {
      center: [centre.lng, centre.lat],
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    };
  }

  const rememberOverview = (): void => {
    if (!active) overview = readCamera();
  };

  map.on('moveend', rememberOverview);

  function build(): void {
    if (built) return;
    colours ??= palette();

    for (const [key, id] of Object.entries(SOURCE)) {
      map.addSource(id, {
        type: 'geojson',
        data: EMPTY,
        // Only the routes need it, and only they pay for it: `lineMetrics`
        // makes `line-progress` available, which is what moves the light along
        // the arc.
        ...(key === 'routes' ? { lineMetrics: true } : {}),
      });
    }

    // The ring, from the inside out: a wash over the ground, a soft halo, then
    // a crisp edge. `line-blur` is what makes the halo a glow rather than a
    // second, fatter line.
    map.addLayer({
      id: LAYER.ringFill,
      type: 'fill',
      source: SOURCE.ring,
      paint: { 'fill-color': colours.brand, 'fill-opacity': 0.08 },
    });

    map.addLayer({
      id: LAYER.ringGlow,
      type: 'line',
      source: SOURCE.ring,
      paint: {
        'line-color': colours.brand,
        'line-width': 16,
        'line-blur': 14,
        'line-opacity': 0.35,
      },
    });

    map.addLayer({
      id: LAYER.ringEdge,
      type: 'line',
      source: SOURCE.ring,
      paint: { 'line-color': colours.edge, 'line-width': 1.6, 'line-opacity': 0.9 },
    });

    // The covered countries. Shaded in the second accent rather than the brand
    // blue, so "the part of the Netherlands we reach" is distinguishable from
    // "the radius" where the two overlap - which is everywhere.
    map.addLayer({
      id: LAYER.areaFill,
      type: 'fill',
      source: SOURCE.areas,
      paint: { 'fill-color': colours.brandSoft, 'fill-opacity': 0.22 },
    });

    map.addLayer({
      id: LAYER.areaEdge,
      type: 'line',
      source: SOURCE.areas,
      paint: { 'line-color': colours.brandSoft, 'line-width': 1.4, 'line-opacity': 0.85 },
    });

    // The closed countries, in the refusing colour. Flat wash and edge first,
    // the standing block below - the same three-layer build as the served
    // slices so the two read as the same kind of thing in two states.
    map.addLayer({
      id: LAYER.excludedFill,
      type: 'fill',
      source: SOURCE.excluded,
      paint: { 'fill-color': colours.danger, 'fill-opacity': 0.2 },
    });

    map.addLayer({
      id: LAYER.excludedEdge,
      type: 'line',
      source: SOURCE.excluded,
      paint: {
        'line-color': colours.danger,
        'line-width': 1.6,
        'line-opacity': 0.9,
        // Dashed, because a dash is a refusal in every map convention there
        // is - and because it survives being read by somebody who cannot tell
        // this red from the teal beside it.
        'line-dasharray': [2, 1.5],
      },
    });

    /*
     * The slices, standing up.
     *
     * This is the one genuinely three-dimensional thing on the map, and what
     * it encodes is proximity: the nearest country stands highest, so the
     * answer can be ranked by looking at it. `height` is a per-feature
     * property computed in `areasFor` rather than an expression over
     * `distanceKm`, because the scale needs the radius to divide by.
     *
     * `fill-extrusion-vertical-gradient` is what stops a block reading as a
     * flat coloured slab: it shades the sides away from the light, which is
     * the only cue that says "this has sides" at all.
     */
    map.addLayer({
      id: LAYER.areaExtrude,
      type: 'fill-extrusion',
      source: SOURCE.areas,
      paint: {
        'fill-extrusion-color': colours.brandSoft,
        'fill-extrusion-height': ['get', 'height'],
        'fill-extrusion-base': 0,
        // Translucent, because a coverage map may never hide the country
        // behind the one in front of it.
        'fill-extrusion-opacity': 0.45,
        'fill-extrusion-vertical-gradient': true,
      },
    });

    map.addLayer({
      id: LAYER.excludedExtrude,
      type: 'fill-extrusion',
      source: SOURCE.excluded,
      paint: {
        'fill-extrusion-color': colours.danger,
        // Deliberately shorter than the served blocks, and not by a scale
        // anybody has to read: a closed country is not part of the promise, so
        // it sits low. Half of what its distance would otherwise earn it.
        'fill-extrusion-height': ['*', ['get', 'height'], 0.5],
        'fill-extrusion-base': 0,
        'fill-extrusion-opacity': 0.4,
        'fill-extrusion-vertical-gradient': true,
      },
    });

    map.addLayer({
      id: LAYER.route,
      type: 'line',
      source: SOURCE.routes,
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': 2.4,
        'line-opacity': 0.95,
        // Replaced every frame while animating. Set here so a reduced-motion
        // reader still gets a coloured route rather than a black default.
        'line-gradient': routeGradient(reduceMotion ? 1 : 0, colours),
      },
    });

    map.addLayer({
      id: LAYER.target,
      type: 'circle',
      source: SOURCE.targets,
      paint: {
        'circle-radius': 4.5,
        'circle-color': '#ffffff',
        'circle-stroke-color': colours.brandSoft,
        'circle-stroke-width': 2.5,
      },
    });

    // Every layer this module believes it added, verified once.
    //
    // MapLibre rejects a layer whose paint is invalid by firing an error and
    // carrying on, which is how the routes layer went missing for a while
    // while every other layer drew perfectly: a feature that was simply absent
    // and a console that said nothing. This makes that failure mode loud
    // instead, in the one place it can be detected.
    for (const id of LAYER_ORDER) {
      if (map.getLayer(id) === undefined) {
        console.error(
          `Delivery coverage: MapLibre rejected the layer "${id}". Its paint or layout is invalid, so that part of the coverage will not be drawn.`,
        );
      }
    }

    built = true;
  }

  function animate(): void {
    if (reduceMotion || colours === null) return;

    // Captured, not read through the closure. TypeScript's narrowing does not
    // survive into the frame callback below - `colours` is a mutable binding
    // of the enclosing scope - and a local const is both correct and one less
    // property read per frame.
    const paint = colours;
    const started = performance.now();

    const step = (now: number): void => {
      if (!built) return;

      const elapsed = (now - started) / 1000;
      const wave = 0.5 + 0.5 * Math.sin(elapsed * 1.9);

      // Each layer is checked before it is painted, and that is not
      // belt-and-braces: MapLibre answers `setPaintProperty` on a layer that
      // is not in the style by firing an error, so one missing layer at 60fps
      // is 60 errors a second drowning whatever else the console had to say.
      // Checking is also what keeps a torn-down map quiet on the frame between
      // `clear()` and this loop noticing.
      if (map.getLayer(LAYER.ringGlow) !== undefined) {
        // The halo breathes. A sine rather than a linear ramp so there is no
        // visible restart at the loop point.
        map.setPaintProperty(LAYER.ringGlow, 'line-opacity', 0.28 + 0.16 * wave);
        map.setPaintProperty(LAYER.ringGlow, 'line-width', 14 + 5 * wave);
      }

      // The light runs out to the border and repeats. 2.6 seconds is slow
      // enough to read as a journey rather than a strobe.
      if (map.getLayer(LAYER.route) !== undefined) {
        map.setPaintProperty(
          LAYER.route,
          'line-gradient',
          routeGradient((elapsed / 2.6) % 1, paint),
        );
      }

      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
  }

  function stop(): void {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
  }

  function clear(): void {
    stop();
    if (!built) return;

    // Layers first, then their sources: MapLibre refuses to remove a source
    // that a layer still points at.
    for (const id of [...LAYER_ORDER].reverse()) {
      if (map.getLayer(id) !== undefined) map.removeLayer(id);
    }
    for (const id of Object.values(SOURCE)) {
      if (map.getSource(id) !== undefined) map.removeSource(id);
    }

    built = false;
  }

  function show(coverage: DeliveryCoverage): void {
    // The style has to be up before a layer can be added to it. The panel only
    // reaches this once the map reports ready, so this is the guard for a
    // style that was swapped underneath us rather than an expected path.
    if (!map.isStyleLoaded()) return;

    build();

    const ring: Feature<Polygon> = {
      type: 'Feature',
      properties: {},
      geometry: coverage.ring,
    };

    // `build()` above added all four, so the optional call is for the one case
    // that can still happen: a style swapped underneath us between the guard
    // and here.
    map.getSource<GeoJSONSource>(SOURCE.ring)?.setData({
      type: 'FeatureCollection',
      features: [ring],
    });
    const areas = areasFor(coverage);
    map.getSource<GeoJSONSource>(SOURCE.areas)?.setData(areas.served);
    map.getSource<GeoJSONSource>(SOURCE.excluded)?.setData(areas.excluded);
    map.getSource<GeoJSONSource>(SOURCE.routes)?.setData(routesFor(coverage));
    map.getSource<GeoJSONSource>(SOURCE.targets)?.setData(targetsFor(coverage));

    active = true;

    // The zoom that fits the ring is asked of MapLibre rather than computed
    // from the radius: it knows the container's size, and the answer changes
    // when the detail panel opens beside it.
    const box = ringBounds(coverage.ring);
    const camera = map.cameraForBounds(box, { padding: FIT_PADDING });
    const target = {
      center: camera?.center ?? [coverage.warehouse.longitude, coverage.warehouse.latitude],
      // A little back from the exact fit, because the pitch pushes the far
      // edge of the ring up and out of a fit computed flat.
      zoom: (camera?.zoom ?? 7) - 0.35,
      pitch: reduceMotion ? 0 : PITCH,
      bearing: 0,
    };

    if (reduceMotion) {
      map.jumpTo(target);
    } else {
      map.flyTo({ ...target, duration: FLIGHT_MS, essential: true, curve: 1.2 });
    }

    stop();
    animate();
  }

  function hide(): void {
    clear();

    // Nothing of ours is on the map and nothing of ours moved the camera, so
    // there is nothing to undo. Flying anyway would take a reader who had
    // panned somewhere back to where they started for no reason.
    if (!active) return;

    active = false;

    if (reduceMotion) map.jumpTo(overview);
    else map.flyTo({ ...overview, duration: RETURN_MS, essential: true });
  }

  return {
    show,
    clearLayers: clear,
    hide,
    dispose: () => {
      map.off('moveend', rememberOverview);
      clear();
      active = false;
    },
  };
}

/**
 * The ring's bounding box, in the `[[w, s], [e, n]]` shape `cameraForBounds`
 * wants.
 *
 * Walked by hand rather than with a geometry library: this is the only place
 * the panel needs a bounding box, and one loop over a ring of 180 points is
 * not worth a dependency the browser has to download.
 */
function ringBounds(ring: Polygon): [[number, number], [number, number]] {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;

  for (const position of ring.coordinates[0] ?? []) {
    const longitude = position[0] ?? 0;
    const latitude = position[1] ?? 0;
    west = Math.min(west, longitude);
    east = Math.max(east, longitude);
    south = Math.min(south, latitude);
    north = Math.max(north, latitude);
  }

  return [
    [west, south],
    [east, north],
  ];
}
