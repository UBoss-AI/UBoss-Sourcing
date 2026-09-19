/**
 * A map of the places a seller dispatches from.
 *
 * The Seller Hub's answer to a question the Hub could not previously answer at
 * all: *where is this address?* A seller could type a street, press a button
 * and be told a pair of coordinates, and coordinates are unverifiable - nobody
 * reads 51.21940, 4.40250 and knows whether it is the right side of the river.
 * This is the picture that makes the answer checkable before it is saved.
 *
 * **One component for all four providers.** The operator's `MapConfig` chooses
 * between a MapLibre style, raster tiles from any XYZ service, a plain ground
 * with no basemap at all, and Google. Both libraries are behind `import()`
 * inside the effect, so a seller who never opens this screen downloads
 * neither, and a deployment on one provider never fetches a line of the
 * other's - Vite splits each dynamic import into its own chunk and only the
 * branch that runs is ever requested. The storefront's own bundle is
 * untouched.
 *
 * **No basemap is a working state, not a fault.** `MAP_TILE_URL` and
 * `MAP_STYLE_URL` are empty by default, because a tile request tells whoever
 * serves it which part of the world is being looked at, and in this product
 * that is where a seller's warehouses are. With nothing configured the map
 * still pans, zooms and places every marker correctly relative to the others -
 * it simply has no picture of the ground behind it, and the panel around it
 * says so rather than looking broken.
 *
 * **The basemap does not follow the dark theme**, for the reason the console's
 * map gives at length: the imagery is the operator's, none of the providers
 * has a dark variant this app is entitled to assume exists, and the usual
 * `filter: invert()` turns their map into a photographic negative where water
 * reads as land. The chrome, the markers and the frame are all drawn from
 * tokens and do follow the theme.
 *
 * **On accessibility**, the canvas is `aria-hidden` and the same places are
 * listed in real markup beside it - which is true on the Hub's address list
 * and on the dialogs, where the address being placed is in the fields above.
 * Exposing both would announce every address twice, and the canvas copy would
 * be the useless one.
 */
import { useEffect, useRef, useState } from 'react';
import type { Map as MapLibreMap, StyleSpecification } from 'maplibre-gl';
import { useI18n } from '@/i18n/i18n-context';

/**
 * The map background, exactly as the API describes it.
 *
 * The same four shapes the console's `MapConfig` carries, because it is the
 * same server setting read by a second screen. The Google key is in here on
 * purpose: the Maps JavaScript API has no server side, so every deployment's
 * key is visible to anybody who opens a map, and what stops it being spent
 * elsewhere is the HTTP-referrer restriction on the key itself.
 */
export interface MapTiles {
  urlTemplate: string;
  attribution: string;
}

export type MapConfig =
  /**
   * `satellite` is the GROUND a map is drawn on, not a provider of its own.
   *
   * With a vector style it goes *underneath* that style's roads, borders and
   * labels - the hybrid view, where an address is on a photograph of the
   * building it is in and the street reaching it is still named. With nothing
   * else configured it is the whole map. It is `null` on `RASTER` because
   * those tiles are already a finished picture of the ground, and absent from
   * `GOOGLE` because their imagery is a map type inside their own API.
   */
  | { provider: 'NONE'; satellite: MapTiles | null }
  | { provider: 'RASTER'; tiles: MapTiles; satellite: null }
  | { provider: 'VECTOR'; style: { url: string; attribution: string }; satellite: MapTiles | null }
  | { provider: 'GOOGLE'; apiKey: string; mapId: string };

/** One thing to draw. Anything with a position and a name satisfies it. */
export interface MapPlace {
  id: string;
  label: string;
  latitude: number;
  longitude: number;
}

type Status = 'loading' | 'ready' | 'failed';

/** Past this, a fitted view of two nearby addresses reads as a street map. */
const MAX_FIT_ZOOM = 13;

/** What one address gets, since a single point has no extent to fit. */
const SINGLE_ZOOM = 12;

/**
 * Where the map opens, decided *before* it is built rather than flown to after.
 *
 * A correctness fix rather than a nicety, and the failure it prevents looks
 * like a bug in this file. A map constructed at zoom 2 asks its style for the
 * whole world immediately, and on a planet-wide vector style - OpenFreeMap's
 * `liberty`, the one the setup documentation recommends - one zoom-2 tile is
 * about 1.5 MB and the opening view needs several. Nothing fails; the tiles
 * simply take tens of seconds to arrive, or on a poor connection never do, and
 * what the seller sees in the meantime is a blank relief map that never
 * reaches their address.
 *
 * Opening on the addresses means the only tiles ever fetched are the ones
 * somebody is going to look at. The world view is kept for the one case with
 * no better answer: nothing placed yet.
 */
function openingCamera(
  places: readonly MapPlace[],
): { center: [number, number]; zoom: number } | { bounds: [number, number, number, number] } {
  if (places.length === 0) return { center: [0, 20], zoom: 2 };

  if (places.length === 1) {
    const only = places[0];
    if (only !== undefined) {
      return { center: [only.longitude, only.latitude], zoom: SINGLE_ZOOM };
    }
  }

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;

  for (const place of places) {
    west = Math.min(west, place.longitude);
    east = Math.max(east, place.longitude);
    south = Math.min(south, place.latitude);
    north = Math.max(north, place.latitude);
  }

  return { bounds: [west, south, east, north] };
}

/**
 * Escaped by hand, because MapLibre's attribution control takes markup and
 * writes it with `innerHTML`.
 *
 * `MAP_TILE_ATTRIBUTION` and `MAP_STYLE_ATTRIBUTION` are free text an operator
 * sets in a settings file, and they are printed in the corner of the map.
 * Escaping them costs a licence its link and keeps the text, which is the
 * right way round for a value arriving from configuration.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The marker: a ring centred on the coordinate, not a pin whose point is it.
 *
 * Built with `textContent` rather than markup, so an address called
 * `Antwerp <b>2</b>` reads as its own name and nothing here has to stay
 * correct about escaping. The colours are the app's own tokens, so the pin
 * follows the theme even where the ground behind it cannot.
 */
function markerElement(label: string, isSelected: boolean): HTMLElement {
  const element = document.createElement('div');
  element.className = [
    'flex h-4 w-4 items-center justify-center rounded-full border-2 border-white',
    'shadow-[0_1px_4px_rgba(0,0,0,0.45)] transition-transform',
    isSelected ? 'scale-150 bg-action' : 'bg-brand',
  ].join(' ');
  element.title = label;
  return element;
}

/**
 * The operator's style, fetched rather than handed over as a URL.
 *
 * `credentials: 'omit'` because the tile host is somebody else's server: the
 * shopper's session cookie has no business travelling to it, and on a
 * deployment whose style happens to be served from this origin it would be
 * sent by default.
 */
async function styleFor(background: Exclude<MapConfig, { provider: 'GOOGLE' }>): Promise<
  StyleSpecification
> {
  if (background.provider === 'VECTOR') {
    const response = await fetch(background.style.url, { credentials: 'omit' });
    if (!response.ok) {
      throw new Error(`map style answered ${String(response.status)}`);
    }

    const style = (await response.json()) as StyleSpecification;
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

  if (background.satellite !== null) {
    return {
      version: 8,
      sources: { [IMAGERY_SOURCE]: imagerySource(background.satellite) },
      layers: [{ id: IMAGERY_SOURCE, type: 'raster', source: IMAGERY_SOURCE }],
    };
  }

  // A real, working map with nothing in it. That is what makes `NONE` a state
  // rather than a special case threaded through the rest of this file.
  return { version: 8, sources: {}, layers: [] };
}

/** The source and layer id the imagery is added under, kept out of the way. */
const IMAGERY_SOURCE = 'uboss-satellite';

function imagerySource(satellite: MapTiles): {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  maxzoom: number;
  attribution: string;
} {
  return {
    type: 'raster',
    tiles: [satellite.urlTemplate],
    tileSize: 256,
    // Past this most imagery services run out and the map would go blank;
    // MapLibre stretches the last level instead, which is soft but keeps the
    // markers where they belong.
    maxzoom: 19,
    attribution: escapeHtml(satellite.attribution),
  };
}

/**
 * The operator's style, redrawn over satellite imagery.
 *
 * The hybrid view, and the reason it earns its place here: an address on a
 * vector basemap sits on a beige rectangle, and an address on imagery sits on
 * the roof it is actually in - which is the difference between believing a
 * coordinate and checking it. Nobody reads 51.219, 4.402 and knows whether it
 * is the right side of the dock.
 *
 * **Which layers survive is by type, not by name**, and that is what makes
 * this work with any style rather than with the one it was written against.
 * Imagery already shows the ground - the water, the fields, the buildings - so
 * everything that *paints* ground is what would hide it: the background, every
 * fill, the hillshade, the low-zoom relief raster. What is kept is `line` and
 * `symbol`: the roads, the borders and every label. A style's layer names are
 * its author's business and change between versions; a layer's `type` is in
 * the specification.
 */
function overImagery(style: StyleSpecification, satellite: MapTiles): StyleSpecification {
  const kept = style.layers.filter((layer) => layer.type === 'line' || layer.type === 'symbol');

  return {
    ...style,
    sources: { ...style.sources, [IMAGERY_SOURCE]: imagerySource(satellite) },
    // First in the array is lowest on the screen. The imagery is the ground.
    layers: [{ id: IMAGERY_SOURCE, type: 'raster', source: IMAGERY_SOURCE }, ...kept],
  };
}

export function LocationMap({
  places,
  map,
  selectedId = null,
  heightClassName = 'h-64',
}: {
  places: MapPlace[];
  map: MapConfig;
  /** Drawn larger and in front. The address being edited, usually. */
  selectedId?: string | null;
  heightClassName?: string;
}): React.JSX.Element {
  const { t } = useI18n();

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | google.maps.Map | null>(null);
  /*
   * How to take each marker off the map, rather than the markers themselves.
   *
   * The two libraries detach a marker differently - MapLibre's has `remove()`,
   * Google's is an element taken off by setting `map` to null - and a union of
   * the two cannot be told apart by their methods, because an
   * `AdvancedMarkerElement` is an `HTMLElement` and so has a `remove()` of its
   * own that does something else entirely. Keeping the closure that knows is
   * shorter than keeping the thing and guessing.
   */
  const detachRef = useRef<(() => void)[]>([]);
  const [status, setStatus] = useState<Status>('loading');

  /*
   * The identity of what is drawn, as a string.
   *
   * The effects below depend on this rather than on the array: `places` is
   * rebuilt on every render by every caller, and an effect keyed on the array
   * itself would tear the markers down and rebuild them while somebody is
   * dragging the map.
   */
  const placesKey = places
    .map((place) => `${place.id}:${String(place.latitude)}:${String(place.longitude)}`)
    .join('|');

  /*
   * The places, readable from inside an effect that runs once.
   *
   * The map is built in an effect keyed on the provider, and it has to know
   * where it is going *before* it is constructed - see `openingCamera`. A ref
   * rather than a dependency, because adding `places` to that list would tear
   * the map down and rebuild it on every render.
   */
  const placesRef = useRef(places);
  placesRef.current = places;

  const provider = map.provider;
  const configKey = JSON.stringify(map);

  // --- Create the map, once per provider -----------------------------------
  useEffect(() => {
    /*
     * Whether *this run* of the effect has been torn down.
     *
     * Per-run rather than a component-wide ref: StrictMode mounts every effect
     * twice in development, and a shared flag lets run 1 believe it is still
     * live after run 2 has started - which here would build two maps on one
     * container, leaving two WebGL contexts fighting over one element and only
     * one of them ever removed.
     *
     * Read through a function because the flag is written by the cleanup while
     * the awaits are in flight, and TypeScript's narrowing reads the
     * initialiser and calls every check dead code.
     */
    const run = { cancelled: false };
    const isCancelled = (): boolean => run.cancelled;

    setStatus('loading');

    void (async () => {
      try {
        if (map.provider === 'GOOGLE') {
          const { importLibrary, setOptions } = await import('@googlemaps/js-api-loader');
          if (isCancelled()) return;

          setOptions({
            key: map.apiKey,
            v: 'weekly',
            // Keeps the Hub's own URL, and anything in it, out of what is sent
            // to Google.
            authReferrerPolicy: 'origin',
          });

          const { Map: GoogleMap } = await importLibrary('maps');
          if (isCancelled() || containerRef.current === null) return;

          mapRef.current = new GoogleMap(containerRef.current, {
            mapId: map.mapId,
            center: { lat: 20, lng: 0 },
            zoom: 2,
            disableDefaultUI: true,
            zoomControl: true,
            // This map sits in a scrolling page, and a wheel that zooms
            // instead of scrolling traps the reader on it.
            gestureHandling: 'cooperative',
          });

          setStatus('ready');
          return;
        }

        // The stylesheet travels with the library - it is what positions the
        // markers and the zoom buttons. Imported here rather than in
        // index.css, which is what keeps it out of the storefront's bundle.
        const [maplibre] = await Promise.all([
          import('maplibre-gl'),
          import('maplibre-gl/dist/maplibre-gl.css'),
        ]);
        if (isCancelled()) return;

        // Before the map: for the vector provider this is a fetch that can
        // fail, and a style that never arrives has to reach the `catch` below
        // rather than leave a blank rectangle on the screen.
        const style = await styleFor(map);
        if (isCancelled() || containerRef.current === null) return;

        const instance = new maplibre.Map({
          container: containerRef.current,
          style,
          // Opened on the addresses, not on the world and flown in afterwards.
          // See `openingCamera` for why that decides whether this map ever
          // finishes loading at all.
          ...openingCamera(placesRef.current),
          fitBoundsOptions: { padding: 40, maxZoom: MAX_FIT_ZOOM },
          maxZoom: 19,
          // Off for the same reason as Google's cooperative gestures above.
          scrollZoom: false,
          // North stays up. Nobody opens an address list to check a bearing.
          dragRotate: false,
          pitchWithRotate: false,
          attributionControl:
            map.provider === 'VECTOR' && map.style.attribution.length > 0
              ? { compact: true, customAttribution: escapeHtml(map.style.attribution) }
              : { compact: true },
        });

        instance.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');

        // Held before the style is up, so an unmount in the next millisecond
        // has something to tear down. A map that is never removed leaves its
        // WebGL context behind, and a browser allows only a handful of those
        // before it starts dropping the oldest.
        mapRef.current = instance;

        /*
         * Ready is `style.load`, not `load`.
         *
         * The two sound interchangeable and are not. `load` means the first
         * *complete* rendering has happened, which waits for every tile in the
         * opening view - megabytes each on a planet-wide vector style, so on a
         * poor connection it can take a minute or never come, and the map sits
         * under its own loading message the whole time. `style.load` means the
         * style document is up: the camera is where it belongs and a marker
         * has something to sit on, which is everything this component needs.
         * The tiles paint in underneath as they arrive, which is what a map is
         * supposed to look like while it loads.
         */
        instance.on('style.load', () => {
          if (isCancelled()) return;
          setStatus('ready');
        });
      } catch {
        if (isCancelled()) return;
        setStatus('failed');
      }
    })();

    return () => {
      run.cancelled = true;

      for (const detach of detachRef.current) detach();
      detachRef.current = [];

      const current = mapRef.current;
      // Only MapLibre owns a context that has to be given back. Google's map
      // goes when its container does.
      if (current !== null && 'remove' in current) current.remove();
      mapRef.current = null;
    };
    // Rebuilt when the operator's provider changes, which in practice means
    // once - the settings cannot change while a screen is open.
  }, [configKey, map, provider]);

  // --- Draw the markers, and frame them ------------------------------------
  useEffect(() => {
    const instance = mapRef.current;
    if (instance === null || status !== 'ready') return;

    for (const detach of detachRef.current) detach();
    detachRef.current = [];

    if (places.length === 0) return;

    void (async () => {
      if ('addControl' in instance) {
        const maplibre = await import('maplibre-gl');

        for (const place of places) {
          const marker = new maplibre.Marker({
            element: markerElement(place.label, place.id === selectedId),
          })
            .setLngLat([place.longitude, place.latitude])
            .addTo(instance);

          detachRef.current.push(() => {
            marker.remove();
          });
        }

        if (places.length === 1) {
          const only = places[0];
          if (only !== undefined) {
            instance.jumpTo({ center: [only.longitude, only.latitude], zoom: SINGLE_ZOOM });
          }
          return;
        }

        const bounds = new maplibre.LngLatBounds();
        for (const place of places) bounds.extend([place.longitude, place.latitude]);
        // `duration: 0` rather than a flight: this runs when the screen opens,
        // and a second of animation from the middle of the Atlantic is a
        // second on the way to the answer.
        instance.fitBounds(bounds, { padding: 40, maxZoom: MAX_FIT_ZOOM, duration: 0 });
        return;
      }

      const { AdvancedMarkerElement } = await import('@googlemaps/js-api-loader').then(
        ({ importLibrary }) => importLibrary('marker'),
      );

      for (const place of places) {
        const marker = new AdvancedMarkerElement({
          map: instance,
          position: { lat: place.latitude, lng: place.longitude },
          content: markerElement(place.label, place.id === selectedId),
          title: place.label,
        });

        detachRef.current.push(() => {
          marker.map = null;
        });
      }

      if (places.length === 1) {
        const only = places[0];
        if (only !== undefined) {
          instance.setCenter({ lat: only.latitude, lng: only.longitude });
          instance.setZoom(SINGLE_ZOOM);
        }
        return;
      }

      const bounds = new google.maps.LatLngBounds();
      for (const place of places) bounds.extend({ lat: place.latitude, lng: place.longitude });
      instance.fitBounds(bounds, 40);
    })();
    // `places` is rebuilt every render; `placesKey` is what actually changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placesKey, selectedId, status]);

  /**
   * MapLibre measures its container when the map is created and then watches
   * the window, not the box.
   *
   * This one is created inside a card that can still be settling - a dialog
   * growing as a suggestion fills three fields, a callout wrapping to two
   * lines - and a canvas that measured the wrong height renders into the wrong
   * place and stops dragging correctly, with no window resize to correct it.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || status !== 'ready') return undefined;

    const observer = new ResizeObserver(() => {
      const instance = mapRef.current;
      if (instance !== null && 'resize' in instance) instance.resize();
    });

    observer.observe(container);
    return () => {
      observer.disconnect();
    };
  }, [status]);

  return (
    <div className="relative">
      <div aria-hidden="true">
        <div
          ref={containerRef}
          className={[
            'w-full overflow-hidden rounded-xl border border-border',
            heightClassName,
            // The ground under a map with no basemap. Deliberately the app's
            // sunken surface rather than a renderer's own grey, which reads as
            // a map that failed to load rather than one with nothing behind it.
            'bg-surface-sunken',
          ].join(' ')}
        />
      </div>

      {status === 'loading' && (
        <p
          role="status"
          className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-ink-muted"
        >
          {t('locationMap.loading')}
        </p>
      )}

      {status === 'failed' && (
        <p
          role="alert"
          className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-ink-muted"
        >
          {t('locationMap.failed')}
        </p>
      )}
    </div>
  );
}
