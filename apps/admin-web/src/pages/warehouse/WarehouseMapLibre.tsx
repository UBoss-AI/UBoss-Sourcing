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
 * them; moving off puts the camera back. On a touch device there is no
 * "moving off", so the tap that selects a warehouse opens the coverage too
 * and a close button on the panel is what ends it. Which of the two applies
 * is read from `(hover: hover) and (pointer: fine)` rather than from the
 * width of the window - a laptop with a narrow window still has a mouse, and
 * a large tablet still does not.
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
import { isPlaced } from '@/lib/warehouses';
import type { MapConfig, Warehouse } from '@/lib/warehouses';
import type { DeliveryCoverage } from '@/lib/delivery-coverage';
import { markerElement, setMarkerPulse, setMarkerSelected } from './warehouse-marker';
import { coverageVisual } from './coverage-visual';
import type { CoverageVisual } from './coverage-visual';

interface WarehouseMapLibreProps {
  warehouses: Warehouse[];
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
  background: WarehouseMapLibreProps['background'],
): Promise<StyleSpecification> {
  if (background.provider === 'VECTOR') return vectorStyle(background.style.url);

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

  return { version: 8, sources: {}, layers: [] };
}

/** Past this, a fitted view of two nearby warehouses reads as a street map. */
const MAX_FIT_ZOOM = 13;

/** What one warehouse gets, since a single point has no extent to fit. */
const SINGLE_WAREHOUSE_ZOOM = 11;

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
 * How long the coverage stays up after the pointer leaves a marker.
 *
 * The panel is 250 pixels of glass in the top-right corner with a real button
 * on every country in it, and the marker it belongs to is somewhere else on
 * the map. Closing the instant the pointer leaves the marker means the answer
 * cannot be read - it is taken away during the journey towards it - and it
 * also means that moving from one marker to its neighbour blanks the screen
 * in between, which is the flicker this delay exists to remove.
 *
 * So leaving only *schedules* the close, and three things cancel it: arriving
 * at another marker, coming back to the same one, and the pointer reaching
 * the panel itself. 260ms is longer than the gap between two markers a cursor
 * is crossing and shorter than the pause of somebody who has moved on.
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
 * Shared by the two places that decide the pointer has gone: leaving a
 * marker, and leaving the panel. Also at module scope, for the same reason
 * `cancelTimer` is.
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

export function WarehouseMapLibre({
  warehouses,
  background,
  selectedId,
  onSelect,
  coverageId = null,
  coverage = null,
  onPointAt,
  overlay,
}: WarehouseMapLibreProps): React.JSX.Element {
  const { t } = useI18n();

  const containerRef = useRef<HTMLDivElement>(null);
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
          // The whole world until the warehouses are fitted below.
          center: [0, 20],
          zoom: 2,
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
         * Ready is the style having loaded, not the constructor having
         * returned - which is the one real difference from a raster tile
         * library, where there is nothing to wait for. Until `load` fires
         * there are no layers to repoint at their English names and nothing
         * for a marker to sit on top of.
         *
         * `on` rather than `once`, which would say the intent better and does
         * not typecheck as cleanly: MapLibre's `once` doubles as a promise
         * when its listener is omitted, so its return type is a union with a
         * `Promise` in it and every call site is a floating promise. `load`
         * fires exactly once in a map's life, so the two are the same thing
         * here.
         */
        map.on('load', () => {
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

        element.addEventListener('mouseleave', () => {
          cancelTimer(hoverTimerRef);
          // Scheduled, not done. See HOVER_LEAVE_MS: the answer has to
          // survive the journey towards it and the gap between two markers.
          scheduleClose(leaveTimerRef, onPointAtRef);
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
    <div className="relative">
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
          back on. */}
      {overlay !== undefined && (
        <div
          className="pointer-events-none absolute inset-0 z-10"
          // The panel is part of the hover rather than something that happens
          // after it: reaching it cancels the pending close, so the countries
          // in it can be read and their flaps opened, and leaving it starts
          // the close the same way leaving a marker does.
          //
          // `over`/`out` rather than `enter`/`leave`, which is not a detail.
          // React derives enter and leave from the same two events, and the
          // pointer here arrives from a marker - a DOM element MapLibre owns,
          // outside React's tree - which is a journey React's derivation does
          // not raise an `onMouseEnter` for on this layer. It was measured
          // doing exactly nothing. `over` and `out` are the real bubbling
          // events and arrive whatever the pointer came from.
          //
          // Moving *within* the panel fires `out` immediately followed by
          // `over`, which schedules a close and cancels it in the same tick -
          // no timer ever elapses in between, so it costs nothing.
          // No onFocus/onBlur beside them, which the a11y rule asks for and
          // this is the case it cannot know about: the keyboard equivalent of
          // this gesture is not focus, it is the *Delivery coverage* button in
          // the detail panel, and it opens and closes with that one button.
          // Closing on blur would take the panel away from a keyboard reader
          // the moment they tabbed towards the flaps in it.
          // eslint-disable-next-line jsx-a11y/mouse-events-have-key-events
          onMouseOver={() => {
            cancelTimer(leaveTimerRef);
          }}
          // eslint-disable-next-line jsx-a11y/mouse-events-have-key-events
          onMouseOut={() => {
            scheduleClose(leaveTimerRef, onPointAtRef);
          }}
        >
          {overlay}
        </div>
      )}

      <div aria-hidden="true">
        <div
          ref={containerRef}
          className={cx(
            'h-[22rem] w-full overflow-hidden rounded-lg border border-border sm:h-[26rem]',
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
