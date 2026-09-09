/**
 * The warehouse map, whichever kind this deployment configured.
 *
 * Two implementations sit behind this file and it does nothing but choose
 * between them:
 *
 *   - `WarehouseMapGoogle` where the operator set a Google Maps key and map
 *     ID. Vector rendering, and whatever style they built in the Cloud
 *     console.
 *   - `WarehouseMapLeaflet` for everything else - raster tiles from any XYZ
 *     service, and the no-background case, which is the default and a working
 *     state rather than a fault.
 *
 * Why a switch rather than one component with a provider option: Google's
 * tiles cannot be used as an XYZ layer at all, so the two are different
 * libraries rather than different URLs. Keeping them apart means each one's
 * library loads only where it is used - a deployment on Google never
 * downloads Leaflet, and one on tiles never fetches a line of Google's API.
 * Both are lazy inside their own module, so this file costs nothing.
 *
 * Why the raster path stays rather than being replaced: this software is
 * bought and run by other companies. An installation behind a firewall with
 * its own tile server, and one whose operator will not send warehouse
 * coordinates to Google, both need a map that works - and one that has
 * configured nothing at all needs a screen that still says something true.
 */
import type { MapConfig, Warehouse } from '@/lib/warehouses';
import { WarehouseMapGoogle } from './WarehouseMapGoogle';
import { WarehouseMapLeaflet } from './WarehouseMapLeaflet';

interface WarehouseMapProps {
  warehouses: Warehouse[];
  /** What the operator configured, straight from the warehouses response. */
  map: MapConfig;
  /** The row the table has selected, drawn larger and in front. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function WarehouseMap({
  warehouses,
  map,
  selectedId,
  onSelect,
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
    <WarehouseMapLeaflet
      warehouses={warehouses}
      // Leaflet covers two providers: tiles, and the plain grid that is what a
      // map with no background configured looks like.
      tiles={map.provider === 'RASTER' ? map.tiles : null}
      selectedId={selectedId}
      onSelect={onSelect}
    />
  );
}
