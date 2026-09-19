/**
 * The warehouse map, drawn with MapLibre GL.
 *
 * One of two implementations - `WarehouseMapGoogle.tsx` is the other, and
 * `WarehouseMap.tsx` picks between them from the operator's settings. This one
 * covers three of the four providers: a vector style, raster tiles from
 * whatever XYZ service the operator pointed at, and no background at all.
 *
 * MapLibre is loaded by dynamic `import()` inside the effect below rather than
 * at the top of the file, which is most of why this is its own module: the
 * router already splits every page into its own chunk, and this pushes the map
 * library one level further down again. A member of staff who opens Warehouses
 * to correct a postcode never downloads it, and a deployment running on Google
 * never downloads it at all.
 *
 * **Why MapLibre rather than a raster tile library: the labels.** A raster
 * tile arrives as a finished picture with the place names already drawn into
 * it, and they are drawn in whatever language is local to that place - so a
 * panel used from Pune reads Ελλάς for Greece and 中国 for China, and no amount
 * of work in the browser can change a word of it. A vector tile arrives as
 * data instead: every place carries `name`, `name:en`, `name:de`, and the
 * renderer decides which to draw. `labelInEnglish` below is that decision, and
 * it is the reason this component exists in the shape it does. Point
 * `MAP_STYLE_URL` at a vector style and every country, sea and city on the map
 * reads in English wherever the panel is opened.
 *
 * The raster path stays because it is the one that works everywhere: an
 * installation behind a firewall with an XYZ tile server and no vector style,
 * or one already configured that way and not ready to move. It gets the same
 * markers, the same scale bar and the same chrome - it just cannot have its
 * labels translated, and the setting that changes that is documented where the
 * operator will be looking.
 *
 * **A background is the operator's decision, and the default is none.** A tile
 * request tells whoever serves it which part of the world is being looked at,
 * and in this product that is where the buyer's warehouses are. With nothing
 * configured the map still works - it pans, zooms, carries a scale bar and
 * places every marker correctly relative to the others - it simply has no
 * picture of the ground behind it. The screen says so rather than looking
 * broken.
 *
 * **Markers are our own elements, not MapLibre's default pin.** A `Marker`
 * takes an `element`, so what one looks like lives in `warehouse-marker.ts`,
 * shared with the Google implementation so the two maps cannot drift apart -
 * and an element takes the panel's own palette, so a warehouse that is low on
 * stock can be a different colour from one that is fine. MapLibre anchors a
 * marker at its centre by default, which is what this marker wants: it is a
 * ring centred on the coordinate, not a pin whose point is the position.
 *
 * **Delivery coverage is driven from here, and it is two gestures rather
 * than one.** On a device with a real pointer, moving onto a marker asks the
 * server which countries that warehouse reaches and the map flies in to show
 * them. It then stays: pointing at another warehouse swaps the answer, and
 * taking the pointer off the map puts the camera back. Nothing smaller ends
 * it, because the flight itself moves the marker out from under a pointer
 * that has not gone anywhere - see the effect that owns the close. On a touch
 * device there is no pointer to move at all, so the tap that selects a
 * warehouse opens the coverage too and a close button on the panel is what
 * ends it. Which of the two applies is read from `(hover: hover) and
 * (pointer: fine)` rather than from the width of the window - a laptop with a
 * narrow window still has a mouse, and a large tablet still does not.
 *
 * The layers, the arcs and the camera live in `coverage-visual.ts`, which is
 * not React and should not pretend to be. This component owns *when* they
 * are shown; that module owns *what* they look like.
 *
 * **On accessibility.** The whole wrapper is `aria-hidden`, and that is a
 * decision rather than an omission. Everything the map shows is also in the
 * table underneath it - name, code, stock, state, coordinates - in a real
 * `<table>` that a screen reader can navigate and this canvas never could.
 * Exposing both would make every warehouse appear twice, and the second copy
 * would be the useless one. The sighted-only content is the geography, and
 * geography is what the coordinates column says in words.
 *
 * The one thing inside this component that is *not* hidden is the delivery
 * coverage panel. It is the accessible copy of what the ring and the arcs
 * draw - a list of country names and distances, in real buttons - so hiding it
 * would leave that answer available to sighted readers only. It is reached by
 * keyboard from the detail panel rather than from a marker, because a marker
 * inside an `aria-hidden` subtree cannot be focused and should not be.
 */
import { useEffect, useRef, useState } from 'react';
import type {
  ExpressionSpecification,
  Map as MapLibreMap,
  Marker,
  StyleSpecification,
} from 'maplibre-gl';
import { Spinner } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { MAP_HEIGHT, isPlaced } from '@/lib/warehouses';
import type { MapConfig, MapTiles, MappablePlace } from '@/lib/warehouses';
import type { DeliveryCoverage } from '@/lib/delivery-coverage';
import { PLAIN_LOOK, markerElement, setMarkerPulse, setMarkerSelected } from './warehouse-marker';
import type { MarkerLook } from './warehouse-marker';
import { coverageVisual } from './coverage-visual';
import type { CoverageVisual } from './coverage-visual';

interface WarehouseMapLibreProps<T extends MappablePlace> {
  warehouses: T[];
  /**
   * How each place is drawn. Defaults to plain, which is what a place with no
   * operational state of its own looks like.
   */
  look?: (place: T) => MarkerLook;
  /**
   * Everything except Google, which has an implementation of its own.
   *
   * The narrowed union rather than a pair of optional props: `NONE` is a
   * working state and has to be as expressible as the other two, and a shape
   * that allowed a style *and* tiles at once would put the operator's
   * precedence back in the frontend.
   */
  background: Exclude<MapConfig, { provider: 'GOOGLE' }>;
  /** The row the table has selected, drawn larger and in front. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * The warehouse whose coverage is being shown, and the answer for it.
   *
   * Both are owned by the page rather than by this component, because the
   * request they come from is shared: the flap panel lists the same countries
   * this map is drawing rings and arcs for, and two components asking
   * separately would be two requests for one answer.
   */
  coverageId?: string | null;
  coverage?: DeliveryCoverage | null;
  /**
   * "The pointer moved onto this marker", or off every marker with null.
   *
   * Only ever called where the device has a real pointer. On touch the tap
   * that selects is what opens the coverage, and it arrives through
   * `onSelect`.
   */
  onPointAt?: ((id: string | null) => void) | undefined;
  /** Rendered over the map, top-right. The page decides what goes in it. */
  overlay?: React.ReactNode;
  /**
   * How tall the map is, where the full-screen panel's height is wrong for it.
   *
   * The default is that panel's. A preview inside a form dialog is confirming
   * one pin rather than surveying a network, and a map that tall pushes the
   * fields underneath it off the screen.
   */
  heightClassName?: string;
}

/**
 * Escaped by hand, because MapLibre's attribution control takes markup and
 * writes it with `innerHTML`.
 *
 * The one remaining place in this file where a configured string reaches the
 * DOM as HTML: `MAP_TILE_ATTRIBUTION` and `MAP_STYLE_ATTRIBUTION` are free
 * text an operator sets, and they are printed in the corner of the map.
 * Escaping them costs a licence its link and keeps the text, which is the
 * right way round for a value that arrives from a settings file.
 *
 * A vector style's *own* attribution - the line its sources declare - is not
 * escaped here and cannot be: it never passes through this app. It is part of
 * the style JSON that MapLibre fetches, from the same host serving the tiles,
 * and a deployment that does not trust that host has a bigger problem than
 * its attribution line.
 *
 * The markers need none of this. They are built with `textContent` in
 * `warehouse-marker.ts`, so a warehouse called `Pune <b>2</b>` reads as its
 * own name without anything here having to stay correct.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Which of a place's names to draw.
 *
 * The whole point of the vector path. Every label on the map is pointed at
 * this instead of whatever the style shipped, so a country is called the same
 * thing whether the panel is opened in Pune, Athens or Warsaw.
 *
 * Four fields in order, because tile schemas disagree about the spelling and a
 * deployment's style is not this software's to choose:
 *
 *   - `name:en` - what OpenMapTiles and Shortbread carry, and what nearly
 *     every public style is built on.
 *   - `name_en` - the underscore spelling, used by Tilezen and by some
 *     hand-built exports.
 *   - `name:latin` - not English, but Latin script. A fair second-best for a
 *     place with no English name at all: "Kraków" beats a row of boxes.
 *   - `name` - the local name, which is what a raster tile would have given.
 *     Better a label in Greek than an unlabelled country.
 *
 * `coalesce` skips a field that is absent *or* empty, so a tile that carries
 * `name:en` as an empty string falls through rather than drawing nothing.
 */
const ENGLISH_NAME: ExpressionSpecification = [
  'coalesce',
  ['get', 'name:en'],
  ['get', 'name_en'],
  ['get', 'name:latin'],
  ['get', 'name'],
];

/**
 * Repoint every place label in a style at its English name.
 *
 * Operates on the style *document*, before MapLibre has ever seen it, and that
 * is the whole point. The obvious implementation - let MapLibre load the
 * style, then walk its layers calling `setLayoutProperty` - looks equivalent
 * and is not: symbol placement happens in a worker when a **tile** is parsed,
 * against whatever the layer's `text-field` was at that moment. Tiles already
 * in flight, or served from the browser's cache, get parsed with the old field
 * and keep their old labels until something evicts them. The visible result is
 * a country labelled twice, a few pixels apart - "Serbia" from the new field
 * and "Србија" from the old - on some countries and not others, differently on
 * every reload. Handing MapLibre a style that already says `name:en` means no
 * tile is ever parsed with anything else.
 *
 * It reads the layers the style actually declared rather than any list kept
 * here, so a deployment can point `MAP_STYLE_URL` at any style in the world
 * and this works without knowing a single layer name in advance.
 *
 * **Only layers whose label already mentions a name are touched**, and that
 * test is what stops this breaking the map. A style's symbol layers are not
 * all place names: a motorway shield draws `ref`, a building layer draws
 * `housenumber`, a contour line draws `ele`. Rewriting those to a name they do
 * not carry would blank them - so the existing `text-field` is serialised and
 * checked for the word first. It is a heuristic and it is the honest one
 * available: a style is data, and nothing in it declares "this layer is a
 * place name".
 *
 * The formatting a style put in its own `text-field` does go: a two-line
 * label, a font stack chosen per script, an uppercase transform expression.
 * That is the trade being made deliberately - one language everywhere is worth
 * more to an operator reading this screen than the style author's typography.
 */
function labelInEnglish(style: StyleSpecification): StyleSpecification {
  for (const layer of style.layers) {
    if (layer.type !== 'symbol') continue;

    const field = layer.layout?.['text-field'];
    if (field === undefined) continue;
    if (!JSON.stringify(field).includes('name')) continue;

    layer.layout = { ...layer.layout, 'text-field': ENGLISH_NAME };
  }

  return style;
}

/**
 * The operator's style, fetched and relabelled.
 *
 * This app fetches the style rather than handing MapLibre the URL, for the
 * reason `labelInEnglish` explains - and it is the same single request
 * MapLibre would have made, so it costs nothing but a line of code.
 *
 * `credentials: 'omit'` because the tile host is somebody else's server. The
 * panel's session cookie has no business travelling to it, and on a deployment
 * whose style happens to be served from the panel's own origin it would be
 * sent by default.
 */
async function vectorStyle(url: string): Promise<StyleSpecification> {
  const response = await fetch(url, { credentials: 'omit' });

  if (!response.ok) {
    throw new Error(`map style ${url} answered ${String(response.status)}`);
  }

  return labelInEnglish((await response.json()) as StyleSpecification);
}

/**
 * What MapLibre is given to draw, for each provider the operator can choose.
 *
 * Every one of them is a style *document*, never a URL: the vector one is
 * fetched and relabelled by `vectorStyle` above, raster tiles are a one-layer
 * style over an XYZ source, and no background is a style with no sources at
 * all - a real, working map with nothing in it, which is what makes `NONE` a
 * state rather than a special case threaded through the rest of this file.
 */
async function styleFor(
  background: WarehouseMapLibreProps<MappablePlace>['background'],
): Promise<StyleSpecification> {
  if (background.provider === 'VECTOR') {
    const style = await vectorStyle(background.style.url);
    return background.satellite === null ? style : overImagery(style, background.satellite);
  }

  if (background.provider === 'RASTER') {
    return {
      version: 8,
      sources: {
        tiles: {
          type: 'raster',
          tiles: [background.tiles.urlTemplate],
          tileSize: 256,
          // Past this the tiles run out on most services and the map would go
          // blank; MapLibre stretches the last level instead, which is blurry
          // but keeps the markers where they belong.
          maxzoom: 19,
          attribution: escapeHtml(background.tiles.attribution),
        },
      },
      layers: [{ id: 'tiles', type: 'raster', source: 'tiles' }],
    };
  }

  if (background.satellite !== null) return imageryStyle(background.satellite);

  return { version: 8, sources: {}, layers: [] };
}

/** The source and layer ids the imagery is added under, kept out of the way. */
const IMAGERY_SOURCE = 'uboss-satellite';

/** Imagery and nothing else, for a deployment that configured no style. */
function imageryStyle(satellite: MapTiles): StyleSpecification {
  return {
    version: 8,
    sources: {
      [IMAGERY_SOURCE]: {
        type: 'raster',
        tiles: [satellite.urlTemplate],
        tileSize: 256,
        maxzoom: 19,
        attribution: escapeHtml(satellite.attribution),
      },
    },
    layers: [{ id: IMAGERY_SOURCE, type: 'raster', source: IMAGERY_SOURCE }],
  };
}

/**
 * The operator's style, redrawn over satellite imagery.
 *
 * The hybrid view, and the reason it is worth having: a warehouse on a vector
 * basemap sits on a beige rectangle, and a warehouse on imagery sits on the
 * roof it is actually in - which is the difference between believing a
 * coordinate and checking it. Nobody reads 51.219, 4.402 and knows whether it
 * is the right side of the dock.
 *
 * **Which layers survive is by type, not by name**, and that is what makes
 * this work with any style rather than with the one it was written against.
 * Imagery already shows the ground - the water, the fields, the buildings - so
 * everything that *paints* ground is what would hide it: the background, every
 * fill, the style's own hillshade and its low-zoom relief raster. What is kept
 * is `line` and `symbol`: the roads, the borders and every label. A style's
 * layer names are its author's business and change between versions; the
 * layer's `type` is in the specification.
 *
 * The relabelling in `labelInEnglish` has already run by here, so the labels
 * that survive are the English ones - which is the whole point of pairing the
 * two. Imagery carries no place names at all, so a hybrid built any other way
 * would be a beautiful map nobody can navigate.
 */
function overImagery(style: StyleSpecification, satellite: MapTiles): StyleSpecification {
  const kept = style.layers.filter((layer) => layer.type === 'line' || layer.type === 'symbol');

  return {
    ...style,
    sources: {
      ...style.sources,
      [IMAGERY_SOURCE]: {
        type: 'raster',
        tiles: [satellite.urlTemplate],
        tileSize: 256,
        // Past this most imagery services run out and the map would go blank;
        // MapLibre stretches the last level instead, which is soft but keeps
        // the markers where they belong.
        maxzoom: 19,
        attribution: escapeHtml(satellite.attribution),
      },
    },
    // First in the array is lowest on the screen. The imagery is the ground.
    layers: [{ id: IMAGERY_SOURCE, type: 'raster', source: IMAGERY_SOURCE }, ...kept],
  };
}

/** Past this, a fitted view of two nearby warehouses reads as a street map. */
const MAX_FIT_ZOOM = 13;

/** What one warehouse gets, since a single point has no extent to fit. */
const SINGLE_WAREHOUSE_ZOOM = 11;

/**
 * Where the map opens, decided *before* it is built rather than flown to after.
 *
 * This is a correctness fix rather than a nicety, and the failure it prevents
 * is worth writing down because the screen it produces looks like a bug in
 * this file.
 *
 * A map constructed at zoom 2 immediately asks its style's sources for the
 * whole world. On a planet-wide vector style - OpenFreeMap's `liberty`, which
 * is the one the documentation recommends - a single zoom-2 tile is about
 * 1.5 MB, and the opening view needs several. Until every one of them arrives
 * MapLibre does not fire `load`, because `load` means "the first complete
 * rendering has happened". On an ordinary office connection that is tens of
 * seconds; on a slow one it effectively never comes. The visible result was a
 * map stuck under its own "Loading the map" overlay, showing the style's
 * low-zoom relief layer and no labels, with the camera never moving to the
 * warehouses - and none of it reported as an error, because nothing had
 * failed.
 *
 * Opening on the warehouses means the only tiles ever requested are the ones
 * somebody is going to look at. The world view is kept for the one case that
 * genuinely has no answer: an installation where nothing has been placed yet.
 */
function openingCamera(
  places: readonly MappablePlace[],
): { center: [number, number]; zoom: number } | { bounds: [number, number, number, number] } {
  const placed = places.filter(isPlaced);

  if (placed.length === 0) return { center: [0, 20], zoom: 2 };

  if (placed.length === 1) {
    const only = placed[0];
    if (only !== undefined) {
      return { center: [only.longitude, only.latitude], zoom: SINGLE_WAREHOUSE_ZOOM };
    }
  }

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;

  for (const place of placed) {
    west = Math.min(west, place.longitude);
    east = Math.max(east, place.longitude);
    south = Math.min(south, place.latitude);
    north = Math.max(north, place.latitude);
  }

  return { bounds: [west, south, east, north] };
}

type Status = 'loading' | 'ready' | 'failed';

/**
 * Does this device have a pointer that can hover?
 *
 * Asked of the input device, not of the screen. A laptop with a 900px window
 * still has a mouse and should get the hover gesture; a 1,200px tablet has no
 * pointer at all and a `mouseenter` on it fires once, on the tap, and then
 * never leaves - which would strand the map tilted with a panel open and no
 * way to close it. Hence the close button appearing only where this is false.
 */
function canHover(): boolean {
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
}

/**
 * How long the pointer has to rest on a marker before anything happens.
 *
 * A map with five markers on it is a map somebody drags across, and every
 * marker the cursor crosses on the way would otherwise fire a request and
 * start a camera flight. 140ms is under the threshold at which a deliberate
 * hover feels laggy and comfortably over an accidental pass.
 */
const HOVER_INTENT_MS = 140;

/**
 * How long the coverage stays up after the pointer leaves the map.
 *
 * Leaving only *schedules* the close, so a pointer that clips the edge of the
 * map on the way somewhere else inside it does not blank the screen, and
 * coming back within this cancels it. 260ms is longer than either of those
 * and shorter than the pause of somebody who has moved on.
 */
const HOVER_LEAVE_MS = 260;

/**
 * Cancel one of the hover timers, if it is running.
 *
 * At module scope so the effects below can call it without it becoming a
 * dependency of theirs: it touches nothing but the ref it is handed.
 */
function cancelTimer(timer: React.RefObject<number | null>): void {
  if (timer.current === null) return;
  window.clearTimeout(timer.current);
  timer.current = null;
}

/**
 * Arm the close, cancelling whatever was already pending.
 *
 * At module scope for the same reason `cancelTimer` is: it touches nothing
 * but the two refs it is handed, so the effect that calls it does not have to
 * carry it as a dependency.
 */
function scheduleClose(
  timer: React.RefObject<number | null>,
  onPointAt: React.RefObject<((id: string | null) => void) | undefined>,
): void {
  cancelTimer(timer);
  timer.current = window.setTimeout(() => {
    timer.current = null;
    onPointAt.current?.(null);
  }, HOVER_LEAVE_MS);
}

export function WarehouseMapLibre<T extends MappablePlace>({
  warehouses,
  look = () => PLAIN_LOOK,
  background,
  selectedId,
  onSelect,
  coverageId = null,
  coverage = null,
  onPointAt,
  overlay,
  heightClassName,
}: WarehouseMapLibreProps<T>): React.JSX.Element {
  const { t } = useI18n();

  const containerRef = useRef<HTMLDivElement>(null);
  /** The map and the panel over it - what the close gesture is measured from. */
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());
  /** The library, kept so the later effects need not re-import it. */
  const libRef = useRef<typeof import('maplibre-gl') | null>(null);
  /** The coverage layers and the camera, built on the first `show`. */
  const visualRef = useRef<CoverageVisual | null>(null);
  /** The pending hover-intent timer, so leaving cancels it. */
  const hoverTimerRef = useRef<number | null>(null);
  /**
   * The pending close, so arriving anywhere that counts cancels it.
   *
   * A second timer rather than the one above reused, because through most of
   * the gesture both are meaningful at once: the pointer has left marker A,
   * which armed this one, and has landed on marker B, which armed that one.
   * One timer would mean B's arrival cancelled its own opening.
   */
  const leaveTimerRef = useRef<number | null>(null);

  /**
   * Whether this device hovers, decided once.
   *
   * In a ref rather than state because nothing re-renders when it changes -
   * and it does not change: a mouse is not plugged in halfway through reading
   * a warehouse list, and treating it as reactive would mean a media-query
   * listener for an event that never fires.
   */
  const hoverCapableRef = useRef<boolean | null>(null);
  hoverCapableRef.current ??= canHover();

  /** Through a ref for the reason `onSelect` is: a fresh closure per render. */
  const onPointAtRef = useRef(onPointAt);
  useEffect(() => {
    onPointAtRef.current = onPointAt;
  }, [onPointAt]);

  const [status, setStatus] = useState<Status>('loading');

  const placed = warehouses.filter(isPlaced);

  /**
   * `onSelect` through a ref, so a parent that hands down a fresh closure on
   * every render does not tear the markers down and rebuild them.
   */
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  // The identity of the placed set. Refitting the view on every render would
  // fight whoever is panning it; refitting when the warehouses themselves
  // change is what somebody expects after adding one.
  const placedKey = placed
    .map(
      (warehouse) => `${warehouse.id}:${String(warehouse.latitude)}:${String(warehouse.longitude)}`,
    )
    .join('|');

  /*
   * The warehouses, readable from inside an effect that runs once.
   *
   * The map is built in an effect with no dependencies, and it needs to know
   * where it is going *before* it is constructed - see `openingCamera`. A ref
   * rather than a dependency, because adding `placed` to that effect's list
   * would rebuild the whole map every time a warehouse is edited.
   */
  const placedRef = useRef(placed);
  placedRef.current = placed;

  // --- Create the map, once -------------------------------------------------
  useEffect(() => {
    const markers = markersRef.current;

    /**
     * Whether *this run* of the effect has been torn down.
     *
     * It has to be per-run rather than a component-wide ref, and getting that
     * wrong is a real bug rather than a tidiness point. StrictMode mounts every
     * effect twice in development: run 1 starts loading MapLibre, is cleaned
     * up, and run 2 starts. With one shared flag, run 2 resets it to false
     * before run 1's `await` resumes - so run 1 believes it is still live and
     * builds a second map on the same container, which leaves two WebGL
     * contexts fighting over one element and only one of them ever removed.
     *
     * Read through a function for the reason `isMounted` in
     * `auth/LocationGate.tsx` is: the flag is written by the cleanup while the
     * awaits are in flight, which is what these checks are *for*, and
     * TypeScript's narrowing cannot see that - it reads the initialiser and
     * calls every check dead code. A call it cannot see through keeps them
     * honest.
     */
    const run = { cancelled: false };
    const isCancelled = (): boolean => run.cancelled;

    void (async () => {
      try {
        // The stylesheet travels with the library - it is what positions the
        // markers, the zoom buttons and the scale bar. Importing it here
        // rather than in index.css is what keeps it out of the panel's main
        // bundle.
        const [maplibre] = await Promise.all([
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);

        if (isCancelled()) return;

        // Before the map, because for the vector provider this is a fetch that
        // can fail - and a style that never arrives has to reach the `catch`
        // below as a failure rather than leaving a blank map on the screen.
        const style = await styleFor(background);

        if (isCancelled() || containerRef.current === null) return;

        const attribution =
          background.provider === 'VECTOR' ? background.style.attribution : '';

        const map = new maplibre.Map({
          container: containerRef.current,
          style,
          // Opened on the warehouses, not on the world and flown in
          // afterwards. See `openingCamera` for why that distinction decides
          // whether this map ever finishes loading at all.
          ...openingCamera(placedRef.current),
          fitBoundsOptions: { padding: 48, maxZoom: MAX_FIT_ZOOM },
          maxZoom: 19,
          // Scroll-wheel zoom off. This map sits in a scrolling page, and a
          // wheel that zooms instead of scrolling traps the reader on it.
          // Double-click, pinch and the +/- buttons all still zoom.
          //
          // Not MapLibre's `cooperativeGestures`, which does the same job by
          // asking for ctrl+wheel: it puts its own English sentence on top of
          // the map, and this panel is read in eight languages.
          scrollZoom: false,
          // North stays up. A rotated map would make the scale bar and the
          // coordinates column in the table describe something the reader is
          // not looking at, and nobody opens a warehouse list to check a
          // bearing.
          dragRotate: false,
          pitchWithRotate: false,
          /*
           * A globe, not a flat rectangle - where there is a basemap to draw
           * on one.
           *
           * This is the projection the screen's question deserves. "Which
           * countries can this warehouse reach" is a question about a sphere,
           * and Mercator answers it while lying about the answer: it inflates
           * everything away from the equator, so a 500 km radius drawn near
           * Gdansk covers visibly more of the picture than the same 500 km
           * drawn near Athens. The list beside the map is measured
           * geodesically and is right either way; the *picture* was the part
           * that disagreed with it.
           *
           * It also solves the thing an operator notices first: on a flat
           * world at the zoom that fits four European warehouses, most
           * countries are off the edge. On a globe the whole world is there,
           * and turning it is how you find the rest of it.
           *
           * **Mercator when there is no basemap**, and that is not caution: a
           * globe is a sphere lit against a background, and with an empty
           * style there is nothing to draw on it. What the reader would get is
           * a dark ball with four markers on it and no way to tell which way
           * up it is. Flat and blank at least keeps the markers in the
           * relative positions the scale bar describes.
           *
           * MapLibre eases into Mercator on its own as the zoom passes about
           * 12, so the coverage flight lands on a flat, pitched view with the
           * extrusions standing up correctly. Nothing here has to manage that.
           *
           * Set through `setProjection` below rather than here: `MapOptions`
           * carries no `projection` field in this version - the projection
           * belongs to the *style*, and a style loaded from a URL is one this
           * app never sees the object for.
           */
          // A style with nothing in it has nothing to credit, and an empty
          // attribution box in the corner reads as a map that half-loaded.
          attributionControl:
            background.provider === 'NONE'
              ? false
              : { customAttribution: attribution.length > 0 ? escapeHtml(attribution) : [] },
        });

        map.touchZoomRotate.disableRotation();

        // Unmounted while the library was in flight. The cleanup below already
        // ran and found no map to remove, so this has to remove its own.
        if (isCancelled()) {
          map.remove();
          return;
        }

        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-left');

        // Globe or flat, as a button. The globe is the default where there is
        // a basemap - see the constructor - and this is how somebody who
        // wants the familiar rectangle gets it back. Offered only where the
        // globe is, because a toggle whose other state is a blank sphere is a
        // toggle nobody should be given.
        if (background.provider !== 'NONE') {
          map.addControl(new maplibre.GlobeControl(), 'top-left');
        }

        // A scale bar, and it earns its place most when there is no basemap:
        // without it a cluster of markers on a blank ground says nothing about
        // whether these warehouses are ten kilometres or a thousand apart.
        map.addControl(new maplibre.ScaleControl({ unit: 'metric' }), 'bottom-left');

        // Held before the style has loaded, so an unmount in the next
        // millisecond has something to tear down. A map that is never removed
        // leaves its WebGL context and its workers behind, and a browser
        // allows a small number of contexts before it starts dropping the
        // oldest - a leak here is a screen that stops drawing after a few
        // visits, which is a horrible thing to have to find later.
        mapRef.current = map;
        libRef.current = maplibre;

        /**
         * Whether the style is up. Not the same question as "is there a map",
         * which is what `mapRef` answers, and the error handler below needs
         * this one.
         */
        let styleLoaded = false;


        /**
         * Ready is the style having been applied - `style.load` - and not
         * `load`.
         *
         * The two sound interchangeable and are not, and the difference is
         * what used to leave this map permanently under its own loading
         * overlay. `load` means the first *complete* rendering has happened,
         * which waits for every tile in the opening view; on a planet-wide
         * vector style those are megabytes each and can take a minute, or on
         * a poor connection never arrive at all. `style.load` means the style
         * document is up: there are layers to relabel, the camera is where it
         * belongs, and a marker has something to sit on. Everything this
         * component does on becoming ready is true at that moment, and the
         * tiles paint themselves in underneath as they arrive - which is what
         * a map is supposed to look like while it loads.
         *
         * `on` rather than `once`, which would say the intent better and does
         * not typecheck as cleanly: MapLibre's `once` doubles as a promise
         * when its listener is omitted, so its return type is a union with a
         * `Promise` in it and every call site is a floating promise. The event
         * fires once per style, and the style is set once here.
         */
        map.on('style.load', () => {
          if (isCancelled()) return;

          styleLoaded = true;

          /*
           * The globe, set here rather than at construction.
           *
           * `MapOptions` has no `projection` field in this version, and
           * `setProjection` reaches into the style - so calling it on a map
           * whose style has not arrived fires the `error` event, which the
           * handler below reads, correctly, as "the map is broken". The whole
           * map then rendered as the failure state.
           *
           * See the long note in the constructor for why this is a globe at
           * all, and why only where there is a basemap to draw on one.
           */
          if (background.provider !== 'NONE') map.setProjection({ type: 'globe' });

          setStatus('ready');
        });

        /**
         * A failure *before* the style loaded is a broken map; one after it is
         * a missing tile.
         *
         * MapLibre reports both on the same event, and telling them apart is
         * the whole reason `styleLoaded` exists. A style URL that 404s or
         * comes back with no CORS header leaves a map with no sources, no
         * glyphs and no layers, and the reader needs to be told. A tile that
         * fails once the map is up leaves one grey square somebody can pan
         * away from, and writing "the map could not be loaded" across a
         * working map for it would be a lie.
         */
        map.on('error', () => {
          if (!isCancelled() && !styleLoaded) setStatus('failed');
        });
      } catch {
        if (!isCancelled()) setStatus('failed');
      }
    })();

    return () => {
      run.cancelled = true;
      // The markers hold listeners on their own elements; MapLibre's `remove`
      // takes the container's children with it either way, but dropping them
      // explicitly is what keeps this teardown readable.
      for (const marker of markers.values()) marker.remove();
      markers.clear();
      mapRef.current?.remove();
      mapRef.current = null;
      libRef.current = null;
    };
    // The background arrives with the first response and does not change while
    // the screen is open; rebuilding the map for it is not a case worth
    // carrying.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Sync the markers -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const maplibre = libRef.current;
    if (map === null || maplibre === null || status !== 'ready') return;

    for (const marker of markersRef.current.values()) marker.remove();
    markersRef.current.clear();

    for (const warehouse of placed) {
      const element = markerElement(
        warehouse,
        look(warehouse),
        warehouse.id === selectedId,
        warehouse.id === coverageId,
      );

      // The browser's own tooltip, which costs nothing and answers "which one
      // is this" on hover. The full record is one click away in the detail
      // panel; a MapLibre popup carrying fifteen fields would have to cover
      // the markers around it to fit.
      element.title = `${warehouse.name} (${warehouse.code})`;
      // MapLibre's marker class carries no cursor of its own, and a ring that
      // opens a panel on click has to look like it will.
      element.style.cursor = 'pointer';
      // In front of the rest where it is the selected one, which matters
      // where two warehouses are in the same city and overlap at low zoom. A
      // z-index on the element rather than a marker option: MapLibre has
      // none, because every marker is a positioned sibling in one container.
      // Kept in step afterwards by the selection effect below.
      element.style.zIndex = warehouse.id === selectedId ? '1000' : '0';

      const marker = new maplibre.Marker({ element })
        .setLngLat([warehouse.longitude, warehouse.latitude])
        .addTo(map);

      marker.getElement().addEventListener('click', () => {
        onSelectRef.current(warehouse.id);
      });

      // The hover gesture, and only where there is a pointer to hover with.
      // On a touch device `mouseenter` fires once on the tap and never
      // leaves, which would strand the map tilted with a panel open.
      if (hoverCapableRef.current === true) {
        element.addEventListener('mouseenter', () => {
          cancelTimer(hoverTimerRef);
          // Whatever is open stays open until this marker's own answer is
          // ready. Cancelling the pending close here is what makes moving
          // from one marker to the next a single change of subject rather
          // than a close followed by an open with a blank map in between.
          cancelTimer(leaveTimerRef);

          // Intent, not arrival. A map being dragged past five markers must
          // not fire five requests and five camera flights.
          hoverTimerRef.current = window.setTimeout(() => {
            hoverTimerRef.current = null;
            onPointAtRef.current?.(warehouse.id);
          }, HOVER_INTENT_MS);
        });

        // Leaving a marker cancels an opening that has not happened yet, and
        // does nothing else. It deliberately does *not* close what is already
        // open, because most of the time the pointer has not gone anywhere:
        // showing the coverage flies the camera in and pitches it, which
        // slides the marker out from under a cursor that never moved, and the
        // browser reports that as a `mouseleave` like any other. Closing on
        // it was the panel appearing and then taking itself away a quarter of
        // a second later, every time. What ends the gesture is the effect
        // below; what changes its subject is a `mouseenter` on another
        // marker.
        element.addEventListener('mouseleave', () => {
          cancelTimer(hoverTimerRef);
        });
      }

      markersRef.current.set(warehouse.id, marker);
    }
    // Which warehouses there are, and nothing else.
    //
    // `selectedId` and `coverageId` are both read here, for the state each
    // marker is built in, and neither is a dependency: the two effects below
    // move the selection and the pulse in place instead. That is not a
    // micro-optimisation. Rebuilding every marker destroys the element the
    // pointer is on, and the browser hands the replacement no hover until the
    // pointer moves again - so with these in the list, clicking a marker
    // (which selects it) or moving to its neighbour (which changes the
    // coverage) dropped the hover that had opened the panel, and the whole
    // map blinked while it happened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey, status]);

  // --- Move the selection, without rebuilding anything ----------------------
  //
  // After the marker effect in source order, which is also the order they run
  // in: when both fire in the same commit, the markers exist by the time this
  // one goes looking for them.
  useEffect(() => {
    if (status !== 'ready') return;

    for (const [id, marker] of markersRef.current) {
      const element = marker.getElement();
      setMarkerSelected(element, id === selectedId);
      // The selected marker sits in front of the rest, which matters where
      // two warehouses are in the same city and overlap at low zoom.
      element.style.zIndex = id === selectedId ? '1000' : '0';
    }
  }, [selectedId, placedKey, status]);

  // --- Move the pulse, without rebuilding anything --------------------------
  useEffect(() => {
    if (status !== 'ready') return;

    for (const [id, marker] of markersRef.current) {
      setMarkerPulse(marker.getElement(), id === coverageId);
    }
  }, [coverageId, placedKey, status]);

  // --- Draw the coverage, and fly to it -------------------------------------
  //
  // One effect for every direction, which is what guarantees the camera cannot
  // be left tilted over nothing - the failure two effects racing each other
  // eventually produce.
  //
  // Three states rather than two, and the middle one is the one that is easy
  // to miss: a warehouse is being pointed at but its answer has not arrived.
  // Treating that as "hide" makes moving from one marker to the next a flight
  // back to the overview followed immediately by a flight back in; treating it
  // as "show" is impossible, there is nothing to show. So the ring comes down
  // and the camera stays where it is until the new answer lands.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || status !== 'ready') return;

    visualRef.current ??= coverageVisual(map);

    if (coverageId === null) visualRef.current.hide();
    else if (coverage === null) visualRef.current.clearLayers();
    else visualRef.current.show(coverage);
  }, [coverageId, coverage, status]);

  // --- What closes the coverage ---------------------------------------------
  //
  // The pointer leaving the map, and nothing smaller than that.
  //
  // Anything smaller is wrong here, because the ground moves. Showing the
  // coverage flies the camera in and pitches it, so the marker the pointer is
  // resting on travels out from under it while the pointer sits still - a
  // close armed by leaving the marker fires on the map's own animation, and
  // the answer flashes up and vanishes.
  //
  // The panel counts as part of the map for this. It is a corner of glass
  // with a button on every country in it, the marker that opened it is
  // somewhere else, and the pointer has to cross open map to reach it.
  //
  // So once the map is showing one warehouse's coverage it keeps showing it
  // until somebody says otherwise, in one of the two ways somebody can:
  // pointing at a different warehouse, which swaps the subject, or taking the
  // pointer off the map, which ends the gesture.
  //
  // Native listeners on the wrapper rather than React props on the overlay:
  // the pointer arrives from and leaves for elements MapLibre owns, outside
  // React's tree, and React derives enter and leave from the same two events
  // it does everywhere else - it was measured not raising them for that
  // journey. `pointerenter`/`pointerleave` bound to the element itself are
  // indifferent to which tree the other end of the journey belongs to.
  //
  // Hover devices only, like the marker listeners: a touch `pointerleave`
  // fires when the finger lifts, which would close the coverage the tap had
  // just opened.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper === null || hoverCapableRef.current !== true) return undefined;

    const onEnter = (): void => {
      cancelTimer(leaveTimerRef);
    };
    const onLeave = (): void => {
      cancelTimer(hoverTimerRef);
      scheduleClose(leaveTimerRef, onPointAtRef);
    };

    wrapper.addEventListener('pointerenter', onEnter);
    wrapper.addEventListener('pointerleave', onLeave);
    return () => {
      wrapper.removeEventListener('pointerenter', onEnter);
      wrapper.removeEventListener('pointerleave', onLeave);
    };
    // The element is the same one for the life of the component, and
    // everything else in here is a ref.
  }, []);

  // The layers and the pending hover timer both outlive a re-render and
  // neither outlives the component. `dispose` rather than `hide`: on unmount
  // there is no camera left to fly back.
  useEffect(
    () => () => {
      cancelTimer(hoverTimerRef);
      cancelTimer(leaveTimerRef);
      visualRef.current?.dispose();
      visualRef.current = null;
    },
    [],
  );

  // --- Frame the warehouses -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const maplibre = libRef.current;
    if (map === null || maplibre === null || status !== 'ready' || placed.length === 0) return;

    // A single warehouse has no extent to fit, and fitting a zero-size box
    // zooms to the maximum - a street corner, which says nothing. A fixed
    // regional zoom is the honest answer for one marker.
    if (placed.length === 1) {
      const only = placed[0];
      if (only !== undefined) {
        map.jumpTo({ center: [only.longitude, only.latitude], zoom: SINGLE_WAREHOUSE_ZOOM });
      }
      return;
    }

    const bounds = new maplibre.LngLatBounds();
    for (const warehouse of placed) bounds.extend([warehouse.longitude, warehouse.latitude]);

    // `duration: 0` rather than a flight. This runs when the screen opens and
    // when a warehouse is added, and an animation from the middle of the
    // Atlantic is a second of nothing on the way to the answer.
    map.fitBounds(bounds, { padding: 48, maxZoom: MAX_FIT_ZOOM, duration: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey, status]);

  /**
   * MapLibre measures its container when the map is created and then watches
   * the window, not the box.
   *
   * This one is created inside a card that can still be settling - a callout
   * above it wrapping to two lines, a scrollbar appearing - and a canvas that
   * measured the wrong height renders into the wrong place and stops dragging
   * correctly, with no window resize to correct it. Watching the box is what
   * fixes it for good, rather than a timeout that is right on one machine.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || status !== 'ready') return undefined;

    const observer = new ResizeObserver(() => {
      mapRef.current?.resize();
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [status]);

  return (
    <div ref={wrapperRef} className="relative">
      {/* The accessible copy of everything below. See the note at the top of
          this file for why the map itself is hidden rather than described. */}
      <p className="sr-only">
        {t('warehouses.map.screenReaderNote', { count: placed.length })}
      </p>

      {/* Outside the `aria-hidden` wrapper below, and that is the point: this
          is the one thing over the map that a screen reader must reach, because
          it is the only place the coverage answer exists in words.
          `pointer-events-none` on the positioning layer so the map can still
          be dragged everywhere the panel is not; the panel itself turns them
          back on.

          No hover handlers of its own, either. The panel is inside the
          wrapper, and the wrapper is what the close is measured from, so
          reading a country in here and opening its flap is not a departure at
          all - there is no pending close for it to have to cancel. */}
      {overlay !== undefined && (
        <div className="pointer-events-none absolute inset-0 z-10">
          {overlay}
        </div>
      )}

      <div aria-hidden="true">
        <div
          ref={containerRef}
          className={cx(
            'w-full overflow-hidden rounded-lg border border-border',
            heightClassName ?? MAP_HEIGHT,
            // The ground under a map with no basemap. Deliberately the sunken
            // surface rather than a renderer's own grey, which reads as a map
            // that failed to load rather than one with nothing behind it.
            'bg-surface-sunken',
          )}
        />
      </div>

      {status === 'loading' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2.5 text-sm text-ink-muted">
          <Spinner className="h-4 w-4 shrink-0 text-ink-subtle" />
          <span role="status">{t('warehouses.map.loading')}</span>
        </div>
      )}

      {status === 'failed' && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <p role="alert" className="text-center text-sm text-ink-muted">
            {t('warehouses.map.failed')}
          </p>
        </div>
      )}
    </div>
  );
}
