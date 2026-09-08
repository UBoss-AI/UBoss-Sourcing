/**
 * The warehouse map.
 *
 * Leaflet, loaded by dynamic `import()` inside the effect below rather than at
 * the top of the file. That is the whole reason this component exists as its
 * own module: the router already splits every page into its own chunk, and
 * this pushes the map library one level further down again, so a member of
 * staff who opens Warehouses to correct a postcode never downloads it.
 *
 * **Tiles are the operator's decision, and the default is none.** A tile
 * request tells whoever serves it which part of the world is being looked at,
 * and in this product that is where the buyer's warehouses are. With no
 * `MAP_TILE_URL` set the map still works - it pans, zooms, carries a scale bar
 * and places every marker correctly relative to the others - it simply has no
 * photograph of the ground behind it. The screen says so rather than looking
 * broken.
 *
 * **Markers are `divIcon`s, not Leaflet's default pin.** Two reasons, and the
 * second is the one that matters: the default marker is a PNG referenced by a
 * path Leaflet computes from its own stylesheet's location, which bundlers
 * reliably break, and a `divIcon` takes the panel's own palette so a warehouse
 * that is low on stock can be a different colour from one that is fine.
 *
 * **On accessibility.** The whole wrapper is `aria-hidden`, and that is a
 * decision rather than an omission. Everything the map shows is also in the
 * table underneath it - name, code, stock, state, coordinates - in a real
 * `<table>` that a screen reader can navigate and this canvas never could.
 * Exposing both would make every warehouse appear twice, and the second copy
 * would be the useless one. The sighted-only content is the geography, and
 * geography is what the coordinates column says in words.
 */
import { useEffect, useRef, useState } from 'react';
import type { Map as LeafletMap, Marker } from 'leaflet';
import { Spinner } from '@/components/ui';
import { cx } from '@/lib/cx';
import { useI18n } from '@/i18n/i18n-context';
import { isPlaced } from '@/lib/warehouses';
import type { MapTiles, PlacedWarehouse, Warehouse } from '@/lib/warehouses';

interface WarehouseMapProps {
  warehouses: Warehouse[];
  tiles: MapTiles | null;
  /** The row the table has selected, drawn larger and in front. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * Escaped by hand, because Leaflet's `divIcon` and `bindTooltip` both take
 * markup and assign it with `innerHTML`.
 *
 * A warehouse's name and code are typed by a member of staff, so this is not
 * the classic hostile-input case - but "the person who typed it is trusted" is
 * exactly the assumption that turns one compromised staff account into a
 * scripted admin panel, and a warehouse called `Pune <b>2</b>` should read as
 * its own name either way.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * How a marker is drawn.
 *
 * The operational status decides the colour, because that is the question a
 * map of warehouses is opened to answer: which of these can ship today. The
 * record state only overrides it in one case - a retired warehouse is drawn
 * hollow, because whether a place nobody uses any more is "operational" is
 * not a meaningful question.
 *
 * Colour is never the only signal. Every marker's warehouse is in the table
 * below it with the status written out, the marker carries the code's initial,
 * and the low-stock ones get a dot as well as a hue.
 */
function markerTone(warehouse: Warehouse): string {
  if (!warehouse.isActive) return 'border-border-strong bg-surface text-ink-subtle';

  switch (warehouse.operationalStatus) {
    case 'SUSPENDED':
      return 'border-danger bg-danger text-white';
    case 'MAINTENANCE':
      return 'border-ink-muted bg-surface-sunken text-ink';
    case 'LIMITED':
      return 'border-warning bg-warning text-white';
    case 'OPERATIONAL':
      // The default warehouse in the palette's own teal, so the place every
      // unqualified receipt lands in is pickable out of a cluster.
      return warehouse.isDefault
        ? 'border-operational bg-operational text-white'
        : 'border-accent bg-accent text-white';
  }
}

type Status = 'loading' | 'ready' | 'failed';

export function WarehouseMap({
  warehouses,
  tiles,
  selectedId,
  onSelect,
}: WarehouseMapProps): React.JSX.Element {
  const { t } = useI18n();

  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<Map<string, Marker>>(new Map());

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
    .map((warehouse) => `${warehouse.id}:${String(warehouse.latitude)}:${String(warehouse.longitude)}`)
    .join('|');

  // --- Create the map, once -------------------------------------------------
  useEffect(() => {
    const markers = markersRef.current;

    /**
     * Whether *this run* of the effect has been torn down.
     *
     * It has to be per-run rather than a component-wide ref, and getting that
     * wrong is a real bug rather than a tidiness point. StrictMode mounts every
     * effect twice in development: run 1 starts loading Leaflet, is cleaned up,
     * and run 2 starts. With one shared flag, run 2 resets it to false before
     * run 1's `await` resumes - so run 1 believes it is still live, builds a map
     * on the container, and run 2 then throws "Map container is already
     * initialized" into the catch below. The screen shows a working map with
     * "the map could not be loaded" written across it.
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
        // The stylesheet travels with the library. Importing it here rather
        // than in index.css is what keeps it out of the panel's main bundle.
        const [leaflet] = await Promise.all([import('leaflet'), import('leaflet/dist/leaflet.css')]);
        const L = leaflet.default;

        if (isCancelled() || containerRef.current === null) return;

        const map = L.map(containerRef.current, {
          // Leaflet's own attribution prefix advertises Leaflet in the corner
          // of somebody else's product. The tile licence's attribution is
          // added below and is the one that is actually required.
          attributionControl: false,
          zoomControl: true,
          // Scroll-wheel zoom off. This map sits in a scrolling page, and a
          // wheel that zooms instead of scrolling traps the reader on it.
          // Double-click, pinch and the +/- buttons all still zoom.
          scrollWheelZoom: false,
        }).setView([20, 0], 2);

        // Unmounted while the library was in flight. The cleanup below already
        // ran and found no map to remove, so this has to remove its own.
        if (isCancelled()) {
          map.remove();
          return;
        }

        if (tiles !== null) {
          L.tileLayer(tiles.urlTemplate, {
            attribution: escapeHtml(tiles.attribution),
            // Past this the tiles run out on most services and the map goes
            // grey; Leaflet stretches the last level instead, which is blurry
            // but keeps the markers where they belong.
            maxZoom: 19,
            maxNativeZoom: 19,
          }).addTo(map);

          if (tiles.attribution.length > 0) {
            L.control.attribution({ prefix: false }).addTo(map);
          }
        }

        // A scale bar, and it earns its place most when there are no tiles:
        // without it a cluster of markers on a blank ground says nothing about
        // whether these warehouses are ten kilometres or a thousand apart.
        L.control.scale({ imperial: false }).addTo(map);

        mapRef.current = map;
        setStatus('ready');
      } catch {
        if (!isCancelled()) setStatus('failed');
      }
    })();

    return () => {
      run.cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markers.clear();
    };
    // Tiles arrive with the first response and do not change while the screen
    // is open; rebuilding the map for them is not a case worth carrying.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Sync the markers -----------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || status !== 'ready') return;

    void (async () => {
      const L = (await import('leaflet')).default;
      if (mapRef.current === null) return;

      for (const marker of markersRef.current.values()) marker.remove();
      markersRef.current.clear();

      for (const warehouse of placed) {
        const marker = L.marker([warehouse.latitude, warehouse.longitude], {
          icon: L.divIcon({
            className: '',
            html: markerHtml(warehouse, warehouse.id === selectedId),
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          }),
          // The selected marker sits in front of the rest, which matters where
          // two warehouses are in the same city and overlap at low zoom.
          zIndexOffset: warehouse.id === selectedId ? 1000 : 0,
          // The browser's own tooltip, which costs nothing and answers "which
          // one is this" on hover. The full record is one click away in the
          // detail panel; a Leaflet popup carrying fifteen fields would have
          // to cover the markers around it to fit.
          title: `${warehouse.name} (${warehouse.code})`,
        });

        marker.on('click', () => {
          onSelectRef.current(warehouse.id);
        });

        marker.addTo(map);
        markersRef.current.set(warehouse.id, marker);
      }
    })();
    // `placed` is derived from props each render; `placedKey` and `selectedId`
    // are what actually decide whether the markers need redrawing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey, selectedId, status]);

  // --- Frame the warehouses -------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (map === null || status !== 'ready' || placed.length === 0) return;

    void (async () => {
      const L = (await import('leaflet')).default;
      if (mapRef.current === null) return;

      const bounds = L.latLngBounds(
        placed.map((warehouse) => [warehouse.latitude, warehouse.longitude]),
      );

      // A single warehouse has no extent to fit, and `fitBounds` on a
      // zero-size box zooms to the maximum - a street corner, which says
      // nothing. A fixed regional zoom is the honest answer for one marker.
      if (placed.length === 1) {
        map.setView(bounds.getCenter(), 11);
        return;
      }

      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 13 });
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placedKey, status]);

  /**
   * Leaflet measures its container once, when the map is created.
   *
   * This one is created inside a card that can still be settling - a callout
   * above it wrapping to two lines, a scrollbar appearing - and a map that
   * measured the wrong height renders its tiles into the wrong place and stops
   * dragging correctly. Watching the box is what fixes it for good, rather
   * than a timeout that is right on one machine.
   */
  useEffect(() => {
    const container = containerRef.current;
    if (container === null || status !== 'ready') return undefined;

    const observer = new ResizeObserver(() => {
      mapRef.current?.invalidateSize();
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

      <div aria-hidden="true">
        <div
          ref={containerRef}
          className={cx(
            'h-[22rem] w-full overflow-hidden rounded-lg border border-border sm:h-[26rem]',
            // The ground under a map with no tiles. Deliberately the sunken
            // surface rather than Leaflet's own grey, which reads as a map
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

/**
 * One marker's markup.
 *
 * A ring with the warehouse's initial in it, rather than a pin: at this size a
 * pin's point is what says where the thing is, and a circle centred on the
 * coordinate is both smaller and more precise. The low-stock ones carry a dot
 * so the warning does not rest on colour alone - the panel's contrast audit
 * covers palettes, not what a red circle means to somebody who cannot see red.
 */
function markerHtml(warehouse: PlacedWarehouse, isSelected: boolean): string {
  const initial = escapeHtml(warehouse.code.trim().charAt(0).toUpperCase() || '?');

  // Leaflet sizes the wrapper it puts this inside to `iconSize` and positions
  // it by `iconAnchor`, so the circle only has to centre itself in that box.
  const size = isSelected ? 'h-8 w-8 text-xs' : 'h-6 w-6 text-xxs';
  const ring = isSelected ? 'ring-2 ring-ring' : '';

  const dot =
    warehouse.stock.lowStockCount > 0
      ? '<span class="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border border-surface bg-danger"></span>'
      : '';

  return [
    '<span class="flex h-full w-full items-center justify-center">',
    `<span class="relative flex ${size} items-center justify-center rounded-full border-2 font-semibold shadow-card ${markerTone(warehouse)} ${ring}">`,
    initial,
    dot,
    '</span>',
    '</span>',
  ].join('');
}
