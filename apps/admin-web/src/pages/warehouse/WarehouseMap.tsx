/**
 * The warehouse map, whichever kind this deployment configured.
 *
 * Two implementations sit behind this file and it does nothing but choose
 * between them:
 *
 *   - `WarehouseMapGoogle` where the operator set a Google Maps key and map
 *     ID. Vector rendering, and whatever style they built in the Cloud
 *     console.
 *   - `WarehouseMapLibre` for everything else - a MapLibre vector style,
 *     raster tiles from any XYZ service, and the no-background case, which is
 *     the default and a working state rather than a fault.
 *
 * Why a switch rather than one component with a provider option: Google's
 * tiles cannot be used as an XYZ layer or as a MapLibre source at all, so the
 * two are different libraries rather than different URLs. Keeping them apart
 * means each one's library loads only where it is used - a deployment on
 * Google never downloads MapLibre, and one on OpenStreetMap never fetches a
 * line of Google's API. Both are lazy inside their own module, so this file
 * costs nothing.
 *
 * Why the raster path stays rather than being folded into the vector one: this
 * software is bought and run by other companies. An installation behind a
 * firewall with an XYZ tile server and no vector style, and one whose operator
 * will not send warehouse coordinates to Google, both need a map that works -
 * and one that has configured nothing at all needs a screen that still says
 * something true. The two are one component because MapLibre draws both; they
 * are two providers because only the vector one can be relabelled, which is
 * the reason an operator would move.
 *
 * ---
 *
 * **The basemap does not follow the dark theme, and that is deliberate.** The
 * map imagery is the operator's: a Cloud console map style on the Google path,
 * and whatever style or tile service they pointed at on the others. None of
 * them has a dark variant this app is entitled to assume exists, and the usual
 * shortcut - a CSS `filter: invert()` over the map - turns their basemap into
 * a photographic negative where water reads as land and their own labels come
 * out inverted. So a light map sits in a dark panel, which is what a photo
 * does too. The chrome around it, the markers and the popups are all drawn
 * from tokens and do follow the theme, so the frame is right even where the
 * picture inside it is somebody else's.
 */
import type { MapConfig, Warehouse } from '@/lib/warehouses';
import type { DeliveryCoverage } from '@/lib/delivery-coverage';
import { WarehouseMapGoogle } from './WarehouseMapGoogle';
import { WarehouseMapLibre } from './WarehouseMapLibre';

interface WarehouseMapProps {
  warehouses: Warehouse[];
  /** What the operator configured, straight from the warehouses response. */
  map: MapConfig;
  /** The row the table has selected, drawn larger and in front. */
  selectedId: string | null;
  onSelect: (id: string) => void;
  /**
   * Delivery coverage, which only the MapLibre arm draws.
   *
   * Not a gap being papered over but a limit worth stating: the ring, the
   * shaded countries and the arcs are MapLibre sources and layers, and the
   * Google map is a different renderer with a different API for all three.
   * Rather than a second implementation of the same picture that would drift
   * from this one, a Google deployment does not offer the feature - and
   * `supportsDeliveryCoverage` below is what the page asks so that the button
   * offering it is absent rather than broken.
   */
  coverageId?: string | null;
  coverage?: DeliveryCoverage | null;
  onPointAt?: ((id: string | null) => void) | undefined;
  overlay?: React.ReactNode;
}

/*
 * Which providers can draw the ring is `supportsDeliveryCoverage` in
 * `lib/warehouses.ts`, next to the `MapConfig` it reads. It is not here
 * because a module that exports a component and a function alongside it cannot
 * keep its state across a Fast Refresh edit.
 */

export function WarehouseMap({
  warehouses,
  map,
  selectedId,
  onSelect,
  coverageId = null,
  coverage = null,
  onPointAt,
  overlay,
}: WarehouseMapProps): React.JSX.Element {
  if (map.provider === 'GOOGLE') {
    return (
      <WarehouseMapGoogle
        warehouses={warehouses}
        apiKey={map.apiKey}
        mapId={map.mapId}
        selectedId={selectedId}
        onSelect={onSelect}
      />
    );
  }

  return (
    <WarehouseMapLibre
      warehouses={warehouses}
      // MapLibre covers the other three: a vector style, raster tiles, and the
      // plain ground that is what a map with no background configured looks
      // like. The narrowed union is handed straight over - `map` is everything
      // but Google by here, which is exactly what that component takes.
      background={map}
      selectedId={selectedId}
      onSelect={onSelect}
      coverageId={coverageId}
      coverage={coverage}
      onPointAt={onPointAt}
      overlay={overlay}
    />
  );
}
