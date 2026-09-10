/**
 * The warehouse map, drawn with Google Maps.
 *
 * The second of two implementations - `WarehouseMapLibre.tsx` is the other,
 * and `WarehouseMap.tsx` picks between them from the operator's settings. This
 * one runs only where a deployment has configured `MAP_GOOGLE_API_KEY` and
 * `MAP_GOOGLE_MAP_ID`; with any of the OpenStreetMap paths instead, none of
 * the code below is downloaded.
 *
 * **Why not a MapLibre source.** Google has no public tile endpoint and their
 * terms forbid reaching for one, so a Google map cannot be another
 * `MAP_STYLE_URL` or `MAP_TILE_URL` handed to MapLibre - it has to be their
 * JavaScript API, which brings its own renderer. That is the reason the panel
 * carries two map implementations rather than one with a different URL in it,
 * and the reason the OpenStreetMap paths stay: an installation behind a
 * firewall, or one whose operator will not send warehouse coordinates to
 * Google, keeps a working map.
 *
 * **The map ID is not optional.** It is what carries the style the operator
 * built in the Cloud console, and it is what Advanced Markers require. The
 * backend refuses to start with a key and no ID, so by the time this component
 * has a `mapId` prop it is a real one.
 *
 * **The key is public.** The Maps JavaScript API has no server side; every
 * deployment's key is visible to anybody who opens this screen. What stops it
 * being spent elsewhere is the HTTP-referrer restriction on the key, which is
 * the operator's to set - see MAP_GOOGLE_API_KEY in `backend/src/config/env.ts`
 * for the two restrictions that matter. `authReferrerPolicy: 'origin'` below
 * is the other half of that: it keeps the panel's own URL, filters and all,
 * out of what is sent to Google.
 *
 * **On accessibility**, the same decision as the MapLibre map and for the same
 * reason: the wrapper is `aria-hidden`, because everything on the map is also
 * in the table underneath it in a real `<table>` a screen reader can navigate.
 * The sighted-only content is the geography, and the coordinates column says
 * that in words.
 */
import { useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { isPlaced } from '@/lib/warehouses';
import type { Warehouse } from '@/lib/warehouses';
import { markerElement } from './warehouse-marker';

interface WarehouseMapGoogleProps {
  warehouses: Warehouse[];
  apiKey: string;
  mapId: string;
  /** The row the table has selected, drawn larger and in front. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * `authFailed` is its own state rather than folded into `failed`.
 *
 * The two have completely different fixes and completely different readers. A
 * `failed` is a script that did not load - a network, an extension, an offline
 * laptop - and it will probably work on a retry. An `authFailed` is Google
 * rejecting the key: unrestricted-key-now-restricted, a referrer that does not
 * match, billing switched off, the Maps JavaScript API not enabled on the
 * project. Nobody looking at this screen can fix that, and telling them to try
 * again would waste their afternoon.
 */
type Status = 'loading' | 'ready' | 'failed' | 'authFailed';

/**
 * How Google's API is told about the key: once per page, globally.
 *
 * `setOptions` configures the loader module, not a map, and has to be called
 * before the first library import - so calling it again for a second map would
 * be either a no-op or a warning, depending on their version. This remembers
 * what was configured so a remount does not try. A deployment whose key
 * changes needs a reload, which is true of every other setting in this panel.
 */
let configuredKey: string | null = null;

/**
 * Google's own hook for "the key was rejected", which is a global callback
 * rather than an event.
 *
 * Typed here rather than declared on the global `Window`: one component owns
 * it, and a module-scoped cast keeps a browser-global augmentation out of the
 * app's type surface for the sake of one property.
 */
interface AuthFailureWindow {
  gm_authFailure?: (() => void) | undefined;
}

/** Past this, a fitted view of two nearby warehouses reads as a street map. */
const MAX_FIT_ZOOM = 13;

/** What one warehouse gets, since a single point has no extent to fit. */
const SINGLE_WAREHOUSE_ZOOM = 11;

export function WarehouseMapGoogle({
  warehouses,
  apiKey,
  mapId,
  selectedId,
  onSelect,
}: WarehouseMapGoogleProps): React.JSX.Element {
  const { t } = useI18n();

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const markersRef = useRef<Map<string, google.maps.marker.AdvancedMarkerElement>>(new Map());
  /** The constructor, kept so the marker effect need not re-import the library. */
  const markerCtorRef = useRef<typeof google.maps.marker.AdvancedMarkerElement | null>(null);

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

  // The identity of the placed set. Redrawing on every render would fight
  // whoever is panning; redrawing when the warehouses change is what somebody
  // expects after adding one.
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
     * Per-run rather than a component-wide ref, for the reason spelled out at
     * length in the MapLibre implementation: StrictMode mounts every effect
     * twice in development, and a shared flag lets the first run believe it is
     * still live after the second has started - which here would mean two maps
     * built on one container.
     *
     * Read through a function because the flag is written by the cleanup while
     * the awaits are in flight, and TypeScript's narrowing reads the
     * initialiser and calls every check dead code.
     */
    const run = { cancelled: false };
    const isCancelled = (): boolean => run.cancelled;

    const authFailureWindow = window as unknown as AuthFailureWindow;

    void (async () => {
      try {
        const { importLibrary, setOptions } = await import('@googlemaps/js-api-loader');

        if (isCancelled()) return;

        if (configuredKey !== apiKey) {
          setOptions({
            key: apiKey,
            // Pinned to the current stable release rather than 'weekly'. A map
            // that changes behaviour on Google's release cadence is a map that
            // can break on a Tuesday in a deployment nobody is watching.
            v: 'quarterly',
            // The Advanced Markers library. The warehouses are drawn with
            // `AdvancedMarkerElement`, which lives here rather than in core.
            libraries: ['marker'],
            // Send only the origin when the key is checked, not the full URL.
            // This screen keeps its search and its filters in the address bar,
            // and none of that is Google's business.
            authReferrerPolicy: 'origin',
          });
          configuredKey = apiKey;
        }

        // Google reports a rejected key by calling this, not by rejecting the
        // promise below - the script loads perfectly well and then refuses to
        // draw. Without it the reader gets Google's own grey watermark and no
        // explanation from us.
        authFailureWindow.gm_authFailure = () => {
          if (!isCancelled()) setStatus('authFailed');
        };

        const [{ Map: GoogleMap }, { AdvancedMarkerElement }] = await Promise.all([
          importLibrary('maps'),
          importLibrary('marker'),
        ]);

        if (isCancelled() || containerRef.current === null) return;

        const map = new GoogleMap(containerRef.current, {
          mapId,
          // The whole world until the warehouses are fitted below, which is
          // the same opening view the MapLibre map takes.
          center: { lat: 20, lng: 0 },
          zoom: 2,
          // Chrome, pared back to what this screen is for. Satellite imagery,
          // Street View and a fullscreen button are all answers to questions
          // nobody opens a warehouse list to ask, and each one is a control
          // sitting on top of a marker.
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          rotateControl: false,
          zoomControl: true,
          // Earns its place most where warehouses are far apart: it is what
          // says whether a cluster is ten kilometres across or a thousand.
          scaleControl: true,
          // Google's own points of interest are not clickable. A shop that
          // happens to be near a warehouse is not part of this screen, and a
          // stray click opening its info window would cover the markers.
          clickableIcons: false,
          // The map sits in a scrolling page. 'cooperative' scrolls the page
          // on a plain wheel and zooms on ctrl+wheel, which is the behaviour
          // the MapLibre map buys by switching wheel zoom off entirely - and it
          // keeps a way to zoom with the wheel for whoever wants one.
          gestureHandling: 'cooperative',
        });

        markerCtorRef.current = AdvancedMarkerElement;
        mapRef.current = map;
        setStatus('ready');
      } catch {
        if (!isCancelled()) setStatus('failed');
      }
    })();

    return () => {
      run.cancelled = true;

      // Google's maps have no `destroy`. Detaching every marker and dropping
      // the reference is the whole of the teardown: React removes the
      // container itself, and the instance goes with it.
      for (const marker of markers.values()) marker.map = null;
      markers.clear();
      markerCtorRef.current = null;
      mapRef.current = null;

      // Only ours. A second map on the page would have replaced this, and
      // clearing somebody else's callback would silently swallow their
      // failure.
      if (authFailureWindow.gm_authFailure !== undefined) {
        authFailureWindow.gm_authFailure = undefined;
      }
    };
    // The key and the map ID arrive with the first response and do not change
    // while the screen is open; rebuilding the map for them is not a case
    // worth carrying.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Sync the markers -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    const AdvancedMarkerElement = markerCtorRef.current;
    if (map === null || AdvancedMarkerElement === null || status !== 'ready') return;

    for (const marker of markersRef.current.values()) marker.map = null;
    markersRef.current.clear();

    for (const warehouse of placed) {
      // `AdvancedMarkerElement` anchors its content by the bottom centre, the
      // way a pin's point sits on the place. This marker is a ring meant to be
      // centred on the coordinate, so it is pushed down by half its own height
      // to put its middle where the anchor is.
      const content = document.createElement('div');
      content.style.transform = 'translateY(50%)';
      content.appendChild(markerElement(warehouse, warehouse.id === selectedId));

      const marker = new AdvancedMarkerElement({
        map,
        position: { lat: warehouse.latitude, lng: warehouse.longitude },
        content,
        // The browser's own tooltip, which costs nothing and answers "which one
        // is this" on hover. The full record is one click away in the detail
        // panel; an info window carrying fifteen fields would have to cover the
        // markers around it to fit.
        title: `${warehouse.name} (${warehouse.code})`,
        // The selected marker sits in front, which matters where two
        // warehouses are in the same city and overlap at low zoom.
        zIndex: warehouse.id === selectedId ? 1000 : 0,
        gmpClickable: true,
      });

      marker.addListener('click', () => {
        onSelectRef.current(warehouse.id);
      });

      markersRef.current.set(warehouse.id, marker);
    }
    // `placed` is derived from props each render; `placedKey` and `selectedId`
    // are what actually decide whether the markers need redrawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey, selectedId, status]);

  // --- Frame the warehouses -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || status !== 'ready' || placed.length === 0) return undefined;

    if (placed.length === 1) {
      // A single warehouse has no extent to fit, and fitting a zero-size box
      // zooms to the maximum - a street corner, which says nothing about where
      // in the world this is.
      const only = placed[0];
      if (only !== undefined) {
        map.setCenter({ lat: only.latitude, lng: only.longitude });
        map.setZoom(SINGLE_WAREHOUSE_ZOOM);
      }
      return undefined;
    }

    const bounds = new google.maps.LatLngBounds();
    for (const warehouse of placed) {
      bounds.extend({ lat: warehouse.latitude, lng: warehouse.longitude });
    }

    map.fitBounds(bounds, 48);

    // `fitBounds` takes no maximum zoom, unlike MapLibre's, so two warehouses
    // in one city would fit to a view of two streets. Clamped once the fit has
    // settled, which is what 'idle' means, and the listener is removed
    // immediately so panning afterwards is left alone.
    const listener = map.addListener('idle', () => {
      listener.remove();
      if ((map.getZoom() ?? 0) > MAX_FIT_ZOOM) map.setZoom(MAX_FIT_ZOOM);
    });

    return () => {
      listener.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey, status]);

  return (
    <div className="relative">
      {/* The accessible copy of everything below. See the note at the top of
          this file for why the map itself is hidden rather than described. */}
      <p className="sr-only">
        {t('warehouses.map.screenReaderNote', { count: placed.length })}
      </p>

      <div aria-hidden="true">
        <div
          ref={containerRef}
          className={cx(
            'h-[22rem] w-full overflow-hidden rounded-lg border border-border sm:h-[26rem]',
            // The ground before Google's renderer paints. Deliberately the
            // panel's sunken surface rather than a grey, so the wait reads as
            // part of this screen rather than as a map that failed.
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

      {(status === 'failed' || status === 'authFailed') && (
        <div className="absolute inset-0 flex items-center justify-center px-6">
          <p role="alert" className="max-w-prose text-center text-sm leading-relaxed text-ink-muted">
            {status === 'authFailed' ? t('warehouses.map.authFailed') : t('warehouses.map.failed')}
          </p>
        </div>
      )}
    </div>
  );
}
