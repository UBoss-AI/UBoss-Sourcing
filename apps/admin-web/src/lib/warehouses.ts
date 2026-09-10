/**
 * Warehouse types and presentation, shared by the page, the map, the detail
 * panel and the form.
 *
 * Kept out of the page files so those export only components - a file that
 * mixes the two cannot keep its state across a Fast Refresh edit.
 */
import type { BadgeTone } from '@/components/ui';
import type { TranslationKey } from '@/i18n/i18n-context';

/**
 * The street-level address.
 *
 * The country is *not* in here - it is its own field on the warehouse, with a
 * foreign key to the reference table, because the console filters and searches
 * on it. Everything left is free text written to be read by a person.
 */
export interface WarehouseAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
}

/**
 * Can this warehouse ship today?
 *
 * Deliberately a different question from `isActive`, and mixing the two up is
 * the mistake this exists to prevent. `isActive` says whether the place is
 * part of the business at all; a retired warehouse is archived master data.
 * This says whether one that *is* can move a box. A warehouse closed for a
 * roof repair is thoroughly active and cannot ship a thing.
 */
export type OperationalStatus = 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';

export const OPERATIONAL_STATUSES: readonly OperationalStatus[] = [
  'OPERATIONAL',
  'LIMITED',
  'MAINTENANCE',
  'SUSPENDED',
];

export type ErpSyncStatus = 'NEVER_SYNCED' | 'SYNCED' | 'PENDING' | 'FAILED';

export interface ErpSync {
  status: ErpSyncStatus;
  /** ISO-8601, or null when no sync has ever finished. */
  lastSyncAt: string | null;
  message: string | null;
  externalId: string | null;
}

export interface WarehouseStock {
  skuCount: number;
  onHandQty: number;
  reservedQty: number;
  lowStockCount: number;
  activeReservations: number;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: WarehouseAddress | null;
  countryCode: string | null;
  countryName: string | null;
  /** IANA zone, e.g. "Europe/Brussels". */
  timezone: string | null;
  /**
   * Degrees, or null when this warehouse has no usable position.
   *
   * A number, not the string an amount of money arrives as. The rule about
   * money is about values that get summed and rounded; a coordinate is drawn
   * and compared and never added to anything. See the note on the same fields
   * in `backend/src/modules/inventory/location.service.ts`.
   *
   * Null covers two different states, and `coordinatesInvalid` is what tells
   * them apart: nothing was ever recorded, or what was recorded cannot be
   * plotted.
   */
  latitude: number | null;
  longitude: number | null;
  /**
   * The warehouse has coordinates stored that the server refused to hand over.
   *
   * Unreachable through the API - the database's CHECK constraints stop it -
   * which is why it is still reported: rows that predate those constraints, an
   * import script and a manual SQL fix can all leave a latitude of 999 behind.
   * A warehouse silently missing from the map is the worst outcome, so these
   * are listed and named.
   */
  coordinatesInvalid: boolean;
  operationalStatus: OperationalStatus;
  isDefault: boolean;
  isActive: boolean;
  erp: ErpSync;
  stock: WarehouseStock;
  createdAt: string;
  updatedAt: string;
}

/** The tile source, when the operator configured a raster one. */
export interface MapTiles {
  urlTemplate: string;
  attribution: string;
}

/**
 * The vector style, when the operator pointed at one.
 *
 * A style JSON URL rather than a tile template, because that is the shape
 * MapLibre takes: the style names the tile source, the glyphs and every
 * layer's paint. `attribution` is an *addition* to what the style's own
 * sources declare, and is usually empty.
 */
export interface MapStyle {
  url: string;
  attribution: string;
}

/**
 * What the warehouses are drawn on, decided by the operator's settings.
 *
 * The server sends one of four, and the panel has an implementation of each.
 * Which one arrives decides which map library the browser downloads, so this
 * has to be in hand before the map component mounts - hence its travelling in
 * the warehouses response rather than behind a request of its own.
 *
 * `NONE` is the default and a working state: markers on a plain ground, scale
 * bar included, and a line on the screen saying there is no background. Every
 * other one tells somebody outside the building where this company's
 * warehouses are, which is not a thing this software decides on the operator's
 * behalf.
 *
 * `VECTOR` and `RASTER` are both OpenStreetMap-shaped and are not
 * interchangeable. A raster tile is a finished picture with its place names
 * drawn in **whatever language is local to that place**; a vector tile carries
 * the names as data, so the panel can ask for English and get it worldwide.
 * See `labelInEnglish` in `WarehouseMapLibre.tsx`.
 */
export type MapConfig =
  | { provider: 'NONE' }
  | { provider: 'RASTER'; tiles: MapTiles }
  | { provider: 'VECTOR'; style: MapStyle }
  /**
   * The key is public, and that is not an oversight. The Maps JavaScript API
   * has no server side - every deployment's key is visible to anybody who
   * opens the panel - and what stops it being spent elsewhere is the HTTP
   * referrer restriction on the key itself. See MAP_GOOGLE_API_KEY in
   * `backend/src/config/env.ts`.
   */
  | { provider: 'GOOGLE'; apiKey: string; mapId: string };

/**
 * Can this map provider draw a delivery-coverage ring?
 *
 * Here rather than beside the component that reads it, because a file which
 * exports both a component and a function loses Fast Refresh - and because the
 * question is about `MapConfig`, which is defined above.
 *
 * The ring, the shaded countries and the arcs are MapLibre sources and layers;
 * the Google map is a different renderer with a different API for all three,
 * and a second implementation of the same picture would drift from the first.
 * So a Google deployment does not offer the feature, and the page asks this so
 * that the button offering it is *absent* rather than present and inert - a
 * dead control is worse than a missing one, because the reader cannot tell
 * whether they misunderstood it or whether it broke.
 */
export function supportsDeliveryCoverage(map: MapConfig): boolean {
  return map.provider !== 'GOOGLE';
}

export interface WarehousesResponse {
  warehouses: Warehouse[];
  map: MapConfig;
  /**
   * How far this deployment says it delivers.
   *
   * From the server, never a constant here: "we deliver within 100 km" is a
   * commercial promise that belongs to whoever runs the installation, and 100
   * is the right number in the Benelux and nothing like it for a distributor
   * covering Rajasthan. See `DELIVERY_COVERAGE_RADIUS_KM` in
   * `backend/src/config/env.ts`.
   */
  coverage: { radiusKm: number };
}

export interface CountryOption {
  code: string;
  name: string;
}

export interface CountriesResponse {
  countries: CountryOption[];
}

export interface GeocodeResponse {
  result: { latitude: number; longitude: number; label: string | null } | null;
}

/** A warehouse with both coordinates, narrowed so the map can rely on them. */
export type PlacedWarehouse = Warehouse & { latitude: number; longitude: number };

export function isPlaced(warehouse: Warehouse): warehouse is PlacedWarehouse {
  return warehouse.latitude !== null && warehouse.longitude !== null;
}

/**
 * What a warehouse's record state is called, and in what colour.
 *
 * Three states rather than two, because "the default" is the one an operator
 * most needs to spot: it is where every receipt with no warehouse named lands,
 * and it is the one that cannot be retired.
 */
export function warehouseState(warehouse: Warehouse): {
  labelKey: TranslationKey;
  tone: BadgeTone;
} {
  if (!warehouse.isActive) return { labelKey: 'warehouses.state.retired', tone: 'neutral' };
  if (warehouse.isDefault) return { labelKey: 'warehouses.state.default', tone: 'operational' };
  return { labelKey: 'warehouses.state.active', tone: 'success' };
}

/**
 * The operational status, as a badge.
 *
 * `LIMITED` is a warning rather than a success: it is running, and somebody
 * planning a dispatch needs to know it is running badly. `SUSPENDED` is the
 * only one drawn in danger - maintenance is expected back, a suspension is
 * not.
 */
export function operationalTone(status: OperationalStatus): BadgeTone {
  switch (status) {
    case 'OPERATIONAL':
      return 'success';
    case 'LIMITED':
      return 'warning';
    case 'MAINTENANCE':
      return 'neutral';
    case 'SUSPENDED':
      return 'danger';
  }
}

export function operationalLabelKey(status: OperationalStatus): TranslationKey {
  switch (status) {
    case 'OPERATIONAL':
      return 'warehouses.operational.OPERATIONAL';
    case 'LIMITED':
      return 'warehouses.operational.LIMITED';
    case 'MAINTENANCE':
      return 'warehouses.operational.MAINTENANCE';
    case 'SUSPENDED':
      return 'warehouses.operational.SUSPENDED';
  }
}

/**
 * The ERP sync state, as a badge.
 *
 * `NEVER_SYNCED` is neutral, not a warning: a deployment with no ERP is not
 * in a bad state, and colouring every warehouse amber for not doing something
 * nobody asked for is how a status column stops being read.
 */
export function erpTone(status: ErpSyncStatus): BadgeTone {
  switch (status) {
    case 'SYNCED':
      return 'success';
    case 'PENDING':
      return 'accent';
    case 'FAILED':
      return 'danger';
    case 'NEVER_SYNCED':
      return 'neutral';
  }
}

export function erpLabelKey(status: ErpSyncStatus): TranslationKey {
  switch (status) {
    case 'SYNCED':
      return 'warehouses.erp.SYNCED';
    case 'PENDING':
      return 'warehouses.erp.PENDING';
    case 'FAILED':
      return 'warehouses.erp.FAILED';
    case 'NEVER_SYNCED':
      return 'warehouses.erp.NEVER_SYNCED';
  }
}

/**
 * The address on one line, for a table cell and a map popup.
 *
 * Empty parts are dropped rather than leaving ", , 411026" behind, and an
 * address with nothing in it returns an empty string for the caller to replace
 * with something better than a stray comma.
 */
export function addressLine(warehouse: Warehouse): string {
  const address = warehouse.address ?? {};

  return [address.line1, address.city, address.postalCode, warehouse.countryCode]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim())
    .join(', ');
}

/** Every line of the address, for the detail panel. Blank parts dropped. */
export function addressLines(warehouse: Warehouse): string[] {
  const address = warehouse.address ?? {};

  return [
    address.line1,
    address.line2,
    [address.postalCode, address.city].filter(Boolean).join(' '),
    address.region,
    warehouse.countryName ?? warehouse.countryCode,
  ]
    .map((part) => (part ?? '').trim())
    .filter((part) => part.length > 0);
}

/**
 * Coordinates as a person reads them.
 *
 * Four decimals is about 11 metres, which is finer than a warehouse needs and
 * short enough to sit in a table cell. The stored value keeps all six.
 */
export function formatCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

/**
 * The local time at a warehouse right now.
 *
 * The point of storing the zone at all: "is anybody there?" is the first
 * question asked of a warehouse in another country, and it cannot be answered
 * from the country - Spain spans two zones. Returns null on a zone this
 * browser's ICU does not know, which is treated as "do not show a clock"
 * rather than as an error; the server already refused any zone `Intl` cannot
 * parse, so this is the belt to that braces.
 */
export function localTimeAt(timezone: string | null, at: Date = new Date()): string | null {
  if (timezone === null || timezone.trim().length === 0) return null;

  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
    }).format(at);
  } catch {
    return null;
  }
}
