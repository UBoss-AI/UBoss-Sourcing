/**
 * Warehouses.
 *
 * `inventory_locations` has been in the schema since the beginning - every
 * balance, movement and reservation carries a `locationId` - but nothing could
 * create one. A deployment ran on whatever the seed inserted, and a second
 * warehouse meant an INSERT by hand. This module is the missing half: opening
 * one, correcting one, and saying where each is so the console can draw it.
 *
 * Four rules shape everything below.
 *
 *   - **A warehouse that has been used is never deleted, only retired.**
 *     Movements point at it with `onDelete: Restrict`, and rightly: deleting
 *     the place would orphan the ledger that explains where stock went.
 *     Retiring one sets `isActive` false, which takes it out of the receipt
 *     and adjustment dialogs while leaving every historical movement
 *     readable. A warehouse nothing has ever been booked against is a
 *     different thing - the duplicate created with a typo in its code, the
 *     site that was planned and never opened - and `deleteWarehouse` removes
 *     that row outright, because there is no ledger to orphan and archiving a
 *     mistake forever only clutters the list somebody reads to find a real
 *     one.
 *   - **There is always exactly one default, and it is always active.**
 *     `inventory.service.ts` resolves an unqualified receipt against
 *     `isDefault: true, isActive: true`, so a deployment with none has an
 *     inventory system that refuses to book stock. Promoting a new default
 *     clears the old one in the same transaction; demoting the only one is
 *     refused rather than obeyed.
 *   - **A code is permanent in practice.** It is stamped on the movement rows
 *     and read back by whoever is investigating a discrepancy years later, so
 *     two warehouses may not share one. It can be corrected - a typo on the
 *     day it was created is not a life sentence - but the uniqueness is
 *     enforced by the database, not only by this code.
 *   - **The geocoder is a convenience, never a gate.** A warehouse saves with
 *     coordinates typed by hand, with coordinates looked up from its address,
 *     or with no coordinates at all. A geocoder that is switched off, slow or
 *     firewalled must not be able to stop somebody recording a building.
 *   - **Reachable and offered are two different facts, stored separately.**
 *     `deliveryRadiusKm` is what geometry can reach; the exclusion rows are
 *     what the business will serve. Keeping them apart is what stops a radius
 *     raised next year from quietly re-opening a country somebody deliberately
 *     closed. See `WarehouseCountryExclusion` in the schema, and
 *     `delivery-coverage.service.ts` for the measurement itself.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { isIsoCountryCode, isoCountries } from '../../domain/country-boundaries.js';
import { currencyExponent, serialiseMoney } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface LocationActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * The street-level address, as the panel's form collects it.
 *
 * The country is deliberately *not* in here any more - it is a column with a
 * foreign key to `countries`, because the console filters and searches on it
 * and JSON answers neither question. The 20260908140000 migration lifted it
 * out of existing rows. Everything left is free text written to be read by a
 * person or printed on a label.
 */
export interface LocationAddress {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
}

export type OperationalStatus = 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';

export const OPERATIONAL_STATUSES: readonly OperationalStatus[] = [
  'OPERATIONAL',
  'LIMITED',
  'MAINTENANCE',
  'SUSPENDED',
];

export type ErpSyncStatus = 'NEVER_SYNCED' | 'SYNCED' | 'PENDING' | 'FAILED';

export const ERP_SYNC_STATUSES: readonly ErpSyncStatus[] = [
  'NEVER_SYNCED',
  'SYNCED',
  'PENDING',
  'FAILED',
];

export interface WarehouseStock {
  /** Distinct SKU/variant rows stocked here, archived products excluded. */
  skuCount: number;
  onHandQty: number;
  reservedQty: number;
  /** How many of those SKUs are at or below their reorder threshold. */
  lowStockCount: number;
  /** Reservations still holding stock here for a live checkout. */
  activeReservations: number;
}

/**
 * A country a warehouse has been told not to deliver to.
 *
 * The name comes from the deployment's own `countries` table where it has a
 * row and from the ISO list otherwise, which is most of the world for most
 * deployments - see `isoCountries()` in `domain/country-boundaries.ts` for why
 * the two lists are different sizes.
 */
export interface ExcludedCountry {
  /** ISO 3166-1 alpha-2, upper case. */
  code: string;
  name: string;
  /** The emoji flag. */
  flag: string;
  /** Why it is closed, in the operator's words. Null when they gave none. */
  reason: string | null;
}

/**
 * One lane: somewhere this warehouse delivers to, and on what terms.
 *
 * This is what actually decides whether a buyer is offered this warehouse at
 * checkout. The radius beside it is geometry and answers a different question
 * - what could a van reach - which is the right thing to draw on a map and
 * the wrong thing to sell against. See `WarehouseDeliveryZone` in the schema
 * for the full reasoning.
 */
export interface WarehouseZone {
  id: string;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string;
  /** The country's name, from the deployment's table or the ISO list. */
  countryName: string;
  flag: string;
  /**
   * Comma-separated postcode prefixes, or `''` for the whole country.
   *
   * Sent back exactly as stored rather than parsed into an array: it is one
   * field on one form, and a round trip through an array is a round trip that
   * can reorder or re-space what somebody typed.
   */
  postalPrefixes: string;
  carrierName: string;
  serviceLevel: string;
  handlingDays: number;
  transitDays: { min: number; max: number };
  usesBusinessDays: boolean;
  /** Money on the wire, as everywhere else: minor units as a string. */
  fee: { minor: string; formatted: string; currency: string };
  freeAbove: { minor: string; formatted: string; currency: string } | null;
  supportsColdChain: boolean;
  maxWeightGrams: number | null;
  isActive: boolean;
  priority: number;
}

/**
 * What this warehouse promises, and where it refuses to go.
 *
 * The geofence, and the two facts a buyer chooses between when more than one
 * warehouse can serve them. Grouped rather than spread across the top level of
 * `Warehouse` because they are read together, written together on one panel of
 * the form, and because "delivery" is the word the operator uses for all four.
 */
export interface WarehouseDelivery {
  /**
   * The radius that applies, in kilometres - never null.
   *
   * The warehouse's own figure, or the deployment's default where it has none.
   * Resolved here rather than left for each caller to fall back on its own,
   * because a frontend that has to remember to apply a default is a frontend
   * that will one day draw a 100 km ring over a 500 km promise.
   */
  radiusKm: number;
  /**
   * True when `radiusKm` came from `DELIVERY_COVERAGE_RADIUS_KM` rather than
   * from this warehouse.
   *
   * The screen says something different about each: "this warehouse promises
   * 500 km" is a decision somebody made, and "the deployment's 500 km applies"
   * is a decision nobody has made yet.
   */
  radiusIsDefault: boolean;
  /**
   * How long delivery from here takes, in days. Null where nobody has said.
   *
   * Null is a real state with a consequence, not a missing value: the
   * storefront cannot offer a warehouse whose lead time nobody has recorded
   * without inventing a promise, so it says the warehouse has not published
   * one instead.
   */
  leadTimeDays: { min: number; max: number } | null;
  /** What delivery from here costs. Null where this warehouse has not priced it. */
  fee: { minor: string; formatted: string; currency: string } | null;
  /** The countries closed on this warehouse, by name. */
  excludedCountries: ExcludedCountry[];
  /**
   * The lanes - what checkout actually offers from here.
   *
   * Grouped under `delivery` with the radius rather than at the top level,
   * because an operator reads all of it as one subject and edits it on one
   * panel. Empty is a real and visible state: a warehouse with no lane holds
   * stock and appears on every map and is offered to nobody, which is the
   * thing the panel most needs to be able to say out loud.
   */
  zones: WarehouseZone[];
}

/** Where a warehouse stands with the ERP that owns its stock figures. */
export interface ErpSync {
  status: ErpSyncStatus;
  /** ISO-8601, or null when no sync has ever finished. */
  lastSyncAt: string | null;
  /** What the connector said - the reason on a failure, a note on a success. */
  message: string | null;
  /** This warehouse's id in the ERP. Null means it is not mapped to anything. */
  externalId: string | null;
}

export interface Warehouse {
  id: string;
  code: string;
  name: string;
  address: LocationAddress | null;
  /** ISO-3166-1 alpha-2, or null on a warehouse recorded before the column. */
  countryCode: string | null;
  /** The country's name from the reference table, for a label. */
  countryName: string | null;
  /** IANA zone, e.g. "Europe/Brussels". Null where nobody has set one. */
  timezone: string | null;
  /**
   * Degrees, WGS-84, or null when nobody has placed this warehouse yet.
   *
   * A `number` rather than the string money crosses the API as, and the
   * difference is not an inconsistency. Minor units are strings because they
   * are summed, apportioned and rounded, and a float that drifts by one paise
   * is a wrong invoice. A coordinate is drawn and compared and never added to
   * anything; at six decimal places the representation error is a matter of
   * nanometres, and the map needs numbers anyway.
   *
   * Null here also covers a *rejected* pair - see `coordinatesInvalid`. The
   * map is never handed a number it cannot plot.
   */
  latitude: number | null;
  longitude: number | null;
  /**
   * True when this warehouse has coordinates stored that cannot be used.
   *
   * The CHECK constraints added in 20260908090000 make this unreachable
   * through the API, which is exactly why it is reported rather than assumed
   * away: the rows that predate those constraints, an import script, and a
   * manual SQL fix are all still capable of leaving a latitude of 999 or a
   * lone longitude behind. Silently dropping such a warehouse off the map
   * would be the worst answer - it would simply be missing, with nothing
   * saying so. The panel lists these separately and asks somebody to fix
   * them.
   */
  coordinatesInvalid: boolean;
  /** Can this place ship today? Not the same question as `isActive`. */
  operationalStatus: OperationalStatus;
  isDefault: boolean;
  isActive: boolean;
  erp: ErpSync;
  /** The geofence, the timing, the price and the closed countries. */
  delivery: WarehouseDelivery;
  stock: WarehouseStock;
  createdAt: string;
  updatedAt: string;
}

/** What the browser needs in order to draw tiles, when the operator set it. */
export interface MapTiles {
  urlTemplate: string;
  attribution: string;
}

/**
 * The vector style, when the operator pointed at one.
 *
 * A style JSON URL rather than a tile template, because that is the shape
 * MapLibre takes: the style is what names the tile source, the glyphs and
 * every layer's paint, and a bare tile URL would leave the browser guessing at
 * all three.
 *
 * `attribution` is an addition, not the whole credit. A style declares its own
 * sources and each of those carries its own attribution string, so the corner
 * of the map is usually right with this empty; it is here for the self-hosted
 * style that declares none.
 */
export interface MapStyle {
  url: string;
  attribution: string;
}

/**
 * What the Warehouses screen should draw its warehouses on.
 *
 * Four answers, and the panel has an implementation of each. A discriminated
 * union rather than a bag of optional fields, because the browser has to pick
 * one library and load it - `provider` is the thing it switches on, and a
 * shape that let `GOOGLE` arrive with no key would put that decision back in
 * the frontend.
 *
 * `NONE` is the default and a working state rather than a misconfiguration.
 * Every other one tells somebody outside the building which part of the world
 * is being looked at, and for this product that is where the buyer's
 * warehouses are - not a fact this software gets to disclose on their behalf
 * until they ask it to. With `NONE` the screen plots its markers on a plain
 * ground, keeps its scale bar, and says in words that there is no background.
 *
 * `VECTOR` and `RASTER` are both OpenStreetMap-shaped and they are not
 * interchangeable, which is why there are two of them. A raster tile arrives
 * as a finished picture with the place names already drawn into it **in
 * whatever language is local to that place**, and no amount of work in the
 * browser can change that. A vector tile arrives as data - every place
 * carrying `name`, `name:en`, `name:de` - so the panel can ask for one
 * language and get it worldwide. An operator who wants a map that reads the
 * same in Pune and in Athens needs `VECTOR`.
 */
export type MapConfig =
  | { provider: 'NONE' }
  | { provider: 'RASTER'; tiles: MapTiles }
  | { provider: 'VECTOR'; style: MapStyle }
  /**
   * The key is here on purpose. The Maps JavaScript API has no server side:
   * every deployment's key is public to anyone who opens the panel, and what
   * stops it being spent elsewhere is the referrer restriction on the key
   * itself. See MAP_GOOGLE_API_KEY in config/env.ts.
   */
  | { provider: 'GOOGLE'; apiKey: string; mapId: string };

/**
 * Which of the four, from settings.
 *
 * A pure function taking the strings rather than reading `env` directly, so
 * the precedence below can be tested without a process per case. `env` is
 * parsed once at import and a test that wanted to try every combination would
 * otherwise need a child process for each.
 *
 * **The order is Google, then vector, then raster**, and it is the order of
 * how deliberately somebody had to arrive there: nobody sets a Google key or a
 * style URL by accident. An operator moving an installation forward sets the
 * new provider's variables and nothing else - falling the other way round
 * would leave them looking at the provider they had just moved off, with
 * nothing on the screen saying why the setting they added did nothing.
 */
export function resolveMapConfig(source: {
  googleApiKey: string;
  googleMapId: string;
  styleUrl: string;
  styleAttribution: string;
  tileUrl: string;
  tileAttribution: string;
}): MapConfig {
  const apiKey = source.googleApiKey.trim();
  const mapId = source.googleMapId.trim();

  // Both, or neither. `env.ts` refuses to start a process with a key and no
  // map ID, so reaching here with half a pair means this was called from
  // somewhere else - and half a pair draws an unstyled map with no markers on
  // it, which is worse than the plain grid.
  if (apiKey.length > 0 && mapId.length > 0) {
    return { provider: 'GOOGLE', apiKey, mapId };
  }

  // Above the raster tiles, because the reason to set this is nearly always
  // the labels: a deployment selling into eight languages wants place names in
  // one of them, and the vector path is the only one that can give it them.
  const styleUrl = source.styleUrl.trim();
  if (styleUrl.length > 0) {
    return {
      provider: 'VECTOR',
      style: { url: styleUrl, attribution: source.styleAttribution.trim() },
    };
  }

  const urlTemplate = source.tileUrl.trim();
  if (urlTemplate.length > 0) {
    return {
      provider: 'RASTER',
      tiles: { urlTemplate, attribution: source.tileAttribution.trim() },
    };
  }

  return { provider: 'NONE' };
}

export function mapConfig(): MapConfig {
  return resolveMapConfig({
    googleApiKey: env.MAP_GOOGLE_API_KEY,
    googleMapId: env.MAP_GOOGLE_MAP_ID,
    styleUrl: env.MAP_STYLE_URL,
    styleAttribution: env.MAP_STYLE_ATTRIBUTION,
    tileUrl: env.MAP_TILE_URL,
    tileAttribution: env.MAP_TILE_ATTRIBUTION,
  });
}

// --- Reads -----------------------------------------------------------------

/**
 * A coordinate as the API and the audit trail carry it.
 *
 * Prisma hands one back as a `Decimal`, which JSON-serialises to an object
 * rather than a number and would reach the browser as
 * `{"s":1,"e":1,"d":[18,52]}`. Decimal strings on the way *in* pass through
 * here too, so the value written and the value logged are read the same way.
 */
function coordinate(value: Prisma.Decimal | string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** Degrees within the range the axis actually has. */
function isPlottable(latitude: number | null, longitude: number | null): boolean {
  if (latitude === null || longitude === null) return false;

  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * What the stored pair means: a point, nothing, or something wrong.
 *
 * Three outcomes, not two, and the third is the reason this function exists.
 * `unplaced` is an ordinary state - a warehouse nobody has geocoded. `invalid`
 * is a warehouse that *has* coordinates which cannot be drawn: a lone
 * latitude, a longitude of 999, a value that survived from before the CHECK
 * constraints in 20260908090000 existed. Both come out of here with null
 * coordinates so the map is never handed a bad point, and the flag is what
 * lets the panel tell the two apart on screen instead of showing a silently
 * shorter list.
 */
export function classifyCoordinates(row: {
  latitude: Prisma.Decimal | string | number | null;
  longitude: Prisma.Decimal | string | number | null;
}): {
  latitude: number | null;
  longitude: number | null;
  coordinatesInvalid: boolean;
} {
  const latitude = coordinate(row.latitude);
  const longitude = coordinate(row.longitude);

  if (latitude === null && longitude === null) {
    return { latitude: null, longitude: null, coordinatesInvalid: false };
  }

  if (!isPlottable(latitude, longitude)) {
    return { latitude: null, longitude: null, coordinatesInvalid: true };
  }

  return { latitude, longitude, coordinatesInvalid: false };
}

/**
 * The shape of an IANA zone name: `Region/City`, or `Region/Area/City`.
 *
 * Checked as well as asking ICU, and this is the half that does the work.
 * `Intl.DateTimeFormat` accepts an *offset* identifier - "+02:00" is legal
 * ECMA-402 and resolves happily - and an offset is precisely the wrong thing
 * to store here. A zone carries a country's daylight-saving rules with it; an
 * offset is a frozen guess that goes wrong twice a year. This is also the
 * exact rule the `chk_location_timezone_shape` constraint holds, so a value
 * this accepts is a value the database will accept too - without it, "+02:00"
 * reached the INSERT and came back as a 500.
 */
const IANA_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9+_-]*(\/[A-Za-z0-9+_-]+)+$/;

/**
 * Is this a zone the runtime can actually format a time in?
 *
 * Both tests, because neither is sufficient. The pattern rejects an offset and
 * a Windows zone name ("W. Europe Standard Time"); ICU rejects a well-shaped
 * name for a place that does not exist. A hard-coded list of zones is the one
 * thing not used - it would be out of date the next time a country changes its
 * rules, and what matters is whether the `Intl.DateTimeFormat` the panel will
 * hand this to accepts it.
 */
function isValidTimezone(zone: string): boolean {
  if (!IANA_ZONE_PATTERN.test(zone)) return false;

  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function normaliseTimezone(zone: string | null | undefined): string | null {
  const trimmed = (zone ?? '').trim();
  if (trimmed.length === 0) return null;

  if (!isValidTimezone(trimmed)) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `"${trimmed}" is not a time zone this system recognises. Use an IANA name such as Europe/Brussels.`,
      [{ field: 'timezone', code: 'UNKNOWN_ZONE' }],
    );
  }

  return trimmed;
}

/**
 * The country, checked against the reference table rather than a regex.
 *
 * Two letters is not the test that matters - "XX" passes it and names nothing.
 * `countries` is the table that decides a country's currency, its interface
 * language and whether it is in the EU VAT area, so a warehouse pointing at a
 * row that is not there is a warehouse the rest of the system cannot reason
 * about. The foreign key would refuse it anyway; this turns that refusal into
 * a field-level message instead of a 500.
 */
async function normaliseCountry(code: string | null | undefined): Promise<string | null> {
  const trimmed = (code ?? '').trim().toUpperCase();
  if (trimmed.length === 0) return null;

  const country = await prisma.country.findUnique({
    where: { code: trimmed },
    select: { code: true },
  });

  if (country === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `${trimmed} is not a country this deployment carries. Add it under reference data first.`,
      [{ field: 'countryCode', code: 'UNKNOWN_COUNTRY' }],
    );
  }

  return country.code;
}

/**
 * The stored address, or null.
 *
 * The column is `Json?`, so anything could be in there - a deployment that
 * wrote it by hand, an import script, a shape from before this form existed.
 * Only an object is offered to the panel; an array or a bare string is treated
 * as no address rather than rendered as one.
 */
function addressOf(value: Prisma.JsonValue | null): LocationAddress | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value;
}

/**
 * Stock per warehouse, in three queries rather than one per row.
 *
 * The product filter matches the Inventory screen's exactly - archived and
 * untracked products excluded - because these totals sit next to a link into
 * that screen, and two numbers that disagree teach people to trust neither.
 *
 * What is deliberately absent is a valuation. Product prices are per-currency
 * in this system, so summing `basePriceMinor` across the SKUs in a warehouse
 * would add rupees to euros and print the total as though it meant something.
 * Units are what a warehouse holds; money belongs on the screens that know
 * which currency they are quoting.
 */
async function stockByLocation(): Promise<Map<string, WarehouseStock>> {
  const trackedProduct = { archivedAt: null, isStockTracked: true } as const;

  const [totals, lowStock, reservations] = await Promise.all([
    prisma.inventoryBalance.groupBy({
      by: ['locationId'],
      where: { product: trackedProduct },
      _sum: { onHandQty: true, reservedQty: true },
      _count: { _all: true },
    }),

    // The low-stock test compares a derived value (on hand minus reserved)
    // against a column on the joined product, which `groupBy` cannot express.
    // Raw SQL rather than reading every balance row into memory to filter it:
    // this table grows with products times warehouses, and a count is the only
    // thing wanted from it.
    prisma.$queryRaw<{ locationId: string; lowCount: bigint }[]>`
      SELECT b.locationId AS locationId, COUNT(*) AS lowCount
        FROM inventory_balances b
        JOIN products p ON p.id = b.productId
       WHERE p.archivedAt IS NULL
         AND p.isStockTracked = 1
         AND p.reorderThreshold > 0
         AND (b.onHandQty - b.reservedQty) <= p.reorderThreshold
       GROUP BY b.locationId
    `,

    prisma.stockReservation.groupBy({
      by: ['locationId'],
      where: { status: 'ACTIVE' },
      _count: { _all: true },
    }),
  ]);

  const lowByLocation = new Map(lowStock.map((row) => [row.locationId, Number(row.lowCount)]));
  const reservedByLocation = new Map(reservations.map((row) => [row.locationId, row._count._all]));

  const byLocation = new Map<string, WarehouseStock>();

  for (const row of totals) {
    byLocation.set(row.locationId, {
      skuCount: row._count._all,
      onHandQty: row._sum.onHandQty ?? 0,
      reservedQty: row._sum.reservedQty ?? 0,
      lowStockCount: lowByLocation.get(row.locationId) ?? 0,
      activeReservations: reservedByLocation.get(row.locationId) ?? 0,
    });
  }

  // A location can carry live reservations with no balance row of its own only
  // in odd states, but the count must not be lost if it does - it is what the
  // retire guard reads.
  for (const [locationId, count] of reservedByLocation) {
    if (byLocation.has(locationId)) continue;
    byLocation.set(locationId, {
      skuCount: 0,
      onHandQty: 0,
      reservedQty: 0,
      lowStockCount: 0,
      activeReservations: count,
    });
  }

  return byLocation;
}

/**
 * What a warehouse that has never held anything reports.
 *
 * It has no row in any of the three queries above and still has to appear on
 * the screen - it is usually the one somebody created a minute ago and is
 * about to receive into.
 */
const EMPTY_STOCK: WarehouseStock = {
  skuCount: 0,
  onHandQty: 0,
  reservedQty: 0,
  lowStockCount: 0,
  activeReservations: 0,
};

/**
 * Country names for the exclusion lists, from the deployment's table first.
 *
 * The same precedence `delivery-coverage.service.ts` uses and for the same
 * reason: if an operator has renamed a country in `countries`, the chip on the
 * warehouse form has to read the same as the filter dropdown beside it. Where
 * there is no row - which is most of the world, because `countries` is the
 * list of markets this deployment prices in - the ISO English name stands.
 *
 * One query for every warehouse in the list rather than one per warehouse:
 * five warehouses each closing eight countries is forty codes and one `IN`.
 */
async function nameExclusions(
  codes: readonly string[],
): Promise<Map<string, { name: string; flag: string }>> {
  const iso = new Map(isoCountries().map((country) => [country.code, country]));
  const unique = [...new Set(codes)];

  const rows =
    unique.length === 0
      ? []
      : await prisma.country.findMany({
          where: { code: { in: unique } },
          select: { code: true, name: true },
        });

  const operator = new Map(rows.map((row) => [row.code.toUpperCase(), row.name]));

  return new Map(
    unique.map((code) => [
      code,
      {
        // The code itself is the last resort, for an exclusion naming a code
        // the ISO list has since retired. It reads as what it is rather than
        // as a blank chip nobody can identify.
        name: operator.get(code) ?? iso.get(code)?.name ?? code,
        flag: iso.get(code)?.flag ?? '',
      },
    ]),
  );
}

/**
 * The delivery block, assembled from the row and the deployment's default.
 *
 * The fallback lives here, in one place, rather than in every caller: the
 * panel, the storefront's option list and the coverage endpoint must all agree
 * on what radius a warehouse with no radius of its own has, and three separate
 * `?? env...` expressions are three chances to disagree.
 */
function deliveryOf(
  row: {
    deliveryRadiusKm: number | null;
    deliveryLeadTimeMinDays: number | null;
    deliveryLeadTimeMaxDays: number | null;
    deliveryFeeMinor: bigint | null;
    deliveryFeeCurrency: string | null;
    exclusions: { countryCode: string; reason: string | null }[];
    deliveryZones?: {
      id: string;
      countryCode: string;
      postalPrefixes: string;
      carrierName: string;
      serviceLevel: string;
      handlingDays: number;
      transitMinDays: number;
      transitMaxDays: number;
      usesBusinessDays: boolean;
      shippingFeeMinor: bigint;
      shippingFeeCurrency: string;
      freeAboveMinor: bigint | null;
      supportsColdChain: boolean;
      maxWeightGrams: number | null;
      isActive: boolean;
      priority: number;
    }[];
  },
  names: Map<string, { name: string; flag: string }>,
): WarehouseDelivery {
  return {
    radiusKm: row.deliveryRadiusKm ?? env.DELIVERY_COVERAGE_RADIUS_KM,
    radiusIsDefault: row.deliveryRadiusKm === null,
    // The column pair is held together by `chk_location_lead_time_pair`, so
    // one being set and the other not is unreachable - but the type has to
    // narrow anyway, and reading both is what makes that obvious.
    leadTimeDays:
      row.deliveryLeadTimeMinDays === null || row.deliveryLeadTimeMaxDays === null
        ? null
        : { min: row.deliveryLeadTimeMinDays, max: row.deliveryLeadTimeMaxDays },
    fee:
      row.deliveryFeeMinor === null || row.deliveryFeeCurrency === null
        ? null
        : serialiseMoney(row.deliveryFeeMinor, row.deliveryFeeCurrency),
    excludedCountries: row.exclusions
      .map((entry) => {
        const code = entry.countryCode.toUpperCase();
        const named = names.get(code);
        return {
          code,
          name: named?.name ?? code,
          flag: named?.flag ?? '',
          reason: entry.reason,
        };
      })
      // By name, because that is the order the chips are read in. The database
      // returns them in insertion order, which is the order somebody happened
      // to click.
      .sort((a, b) => a.name.localeCompare(b.name, 'en')),
    zones: (row.deliveryZones ?? []).map((zone) => {
      const code = zone.countryCode.toUpperCase();
      const named = names.get(code);

      return {
        id: zone.id,
        countryCode: code,
        countryName: named?.name ?? code,
        flag: named?.flag ?? '',
        postalPrefixes: zone.postalPrefixes,
        carrierName: zone.carrierName,
        serviceLevel: zone.serviceLevel,
        handlingDays: zone.handlingDays,
        transitDays: { min: zone.transitMinDays, max: zone.transitMaxDays },
        usesBusinessDays: zone.usesBusinessDays,
        fee: serialiseMoney(zone.shippingFeeMinor, zone.shippingFeeCurrency),
        freeAbove:
          zone.freeAboveMinor === null
            ? null
            : serialiseMoney(zone.freeAboveMinor, zone.shippingFeeCurrency),
        supportsColdChain: zone.supportsColdChain,
        maxWeightGrams: zone.maxWeightGrams,
        isActive: zone.isActive,
        priority: zone.priority,
      } satisfies WarehouseZone;
    }),
  };
}

export interface ListWarehousesOptions {
  /**
   * Whether retired warehouses are included.
   *
   * False for the pickers that choose where stock is going - a retired place
   * must not be offered. True for the management screen, which is the only
   * screen from which a retired one can be brought back; filtering them out
   * there would make retiring a warehouse irreversible through the panel.
   */
  includeInactive?: boolean;
  /**
   * Free text matched against the name, the code and the country's name.
   *
   * Searched on the server rather than filtered in the browser, and the
   * country's *name* is in there deliberately: somebody hunting for the Greek
   * warehouse types "greece", not "GR", and a search that only looked at the
   * two-letter code would answer nothing.
   */
  search?: string;
  /** Any one of these matches. Empty or absent means every status. */
  operationalStatus?: readonly OperationalStatus[];
  /** ISO-3166-1 alpha-2. */
  countryCode?: string;
}

export async function listWarehouses(options: ListWarehousesOptions = {}): Promise<Warehouse[]> {
  const search = (options.search ?? '').trim();
  const statuses = options.operationalStatus ?? [];

  const where: Prisma.InventoryLocationWhereInput = {
    ...(options.includeInactive === true ? {} : { isActive: true }),
    ...(options.countryCode === undefined ? {} : { countryCode: options.countryCode }),
    ...(statuses.length === 0 ? {} : { operationalStatus: { in: [...statuses] } }),
    ...(search.length === 0
      ? {}
      : {
          OR: [
            { name: { contains: search } },
            { code: { contains: search } },
            { country: { name: { contains: search } } },
          ],
        }),
  };

  const [rows, stock] = await Promise.all([
    prisma.inventoryLocation.findMany({
      where,
      // The default first, then alphabetically. The default is the one most
      // questions are about, and a list of warehouses is read by name.
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      include: {
        country: { select: { name: true } },
        exclusions: { select: { countryCode: true, reason: true } },
        // The lanes, in the order the panel lists them: the operator's own
        // priority first, then soonest, then by country so a warehouse
        // serving six of them reads alphabetically rather than by whenever
        // somebody happened to add each one.
        deliveryZones: {
          orderBy: [{ priority: 'asc' }, { countryCode: 'asc' }, { transitMaxDays: 'asc' }],
        },
      },
    }),
    stockByLocation(),
  ]);

  // Named in one query for the whole list, after the rows are in hand. Both
  // the closed countries and the lanes need a name and a flag, and asking for
  // them together is one round trip rather than two.
  const names = await nameExclusions([
    ...rows.flatMap((row) => row.exclusions.map((entry) => entry.countryCode.toUpperCase())),
    ...rows.flatMap((row) => row.deliveryZones.map((zone) => zone.countryCode.toUpperCase())),
  ]);

  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    address: addressOf(row.addressJson),
    countryCode: row.countryCode,
    countryName: row.country?.name ?? null,
    timezone: row.timezone,
    ...classifyCoordinates(row),
    operationalStatus: row.operationalStatus,
    isDefault: row.isDefault,
    isActive: row.isActive,
    erp: {
      status: row.erpSyncStatus,
      lastSyncAt: row.erpLastSyncAt?.toISOString() ?? null,
      message: row.erpSyncMessage,
      externalId: row.erpExternalId,
    },
    delivery: deliveryOf(row, names),
    stock: stock.get(row.id) ?? EMPTY_STOCK,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}

// --- Writes ----------------------------------------------------------------

export interface WarehouseInput {
  code: string;
  name: string;
  address?: LocationAddress | null;
  countryCode?: string | null;
  timezone?: string | null;
  latitude?: number | null;
  longitude?: number | null;
  operationalStatus?: OperationalStatus;
  /**
   * The ERP's own id for this warehouse. Editable, unlike the sync state
   * beside it, because it is a mapping a person knows and types.
   */
  erpExternalId?: string | null;
  isDefault?: boolean;
  isActive?: boolean;
  /**
   * This warehouse's own geofence radius, in kilometres.
   *
   * Explicit null means "go back to the deployment's default", which is a
   * different instruction from absent - absent leaves whatever is stored
   * alone. The same distinction the coordinates have carried since they were
   * added, and for the same reason: a PATCH that renames a building must not
   * silently change what it promises.
   */
  deliveryRadiusKm?: number | null;
  /**
   * The lead-time window in days. Both, or neither.
   *
   * Passing one and not the other is refused rather than half-applied: a
   * minimum with no maximum is a promise with no end.
   */
  deliveryLeadTimeMinDays?: number | null;
  deliveryLeadTimeMaxDays?: number | null;
  /**
   * The delivery fee, in minor units, as a string.
   *
   * A string because that is how money crosses the API in this product - a
   * JSON number cannot hold a paise-exact amount past 2^53 and would invite a
   * float somewhere upstream. Parsed to BigInt here.
   */
  deliveryFeeMinor?: string | null;
  /** The fee's currency. Must be present when the fee is, and absent when it is not. */
  deliveryFeeCurrency?: string | null;
  /**
   * The countries this warehouse will not deliver to.
   *
   * **The whole list, not a delta.** Passing it replaces the set; passing
   * `[]` clears it; leaving it out changes nothing. A form that shows the
   * operator every closed country and sends back what is left after they
   * untick one is the only shape that cannot drift out of step with what they
   * are looking at - an add/remove API would need the browser to work out the
   * difference, and a difference computed from a stale list closes the wrong
   * country.
   */
  excludedCountries?: readonly { code: string; reason?: string | null }[];
  /**
   * The lanes this warehouse delivers on.
   *
   * **The whole list, not a delta**, on exactly the reasoning
   * `excludedCountries` carries: the panel shows every lane and sends back
   * what is left after an edit, which is the only shape that cannot drift out
   * of step with what the operator is looking at. Passing `[]` removes every
   * lane - and that is a real instruction rather than an accident to guard
   * against, because a warehouse with no lane is exactly what a building
   * holding stock for another site should be.
   *
   * Replacing rather than diffing means the rows get new ids. That is fine
   * and is the reason quotes hold `zoneId` as SET NULL: an offer already
   * made keeps its own frozen copy of the fee and the dates, and simply stops
   * pointing at a lane that no longer exists.
   */
  deliveryZones?: readonly DeliveryZoneInput[];
}

/** One lane, as a form sends it. */
export interface DeliveryZoneInput {
  countryCode: string;
  /** Comma-separated prefixes. Empty, absent or null all mean the whole country. */
  postalPrefixes?: string | null;
  carrierName: string;
  serviceLevel: string;
  handlingDays?: number;
  transitMinDays: number;
  transitMaxDays: number;
  usesBusinessDays?: boolean;
  /** Minor units as a digit string, like every amount crossing this API. */
  shippingFeeMinor?: string;
  shippingFeeCurrency: string;
  freeAboveMinor?: string | null;
  supportsColdChain?: boolean;
  maxWeightGrams?: number | null;
  isActive?: boolean;
  priority?: number;
}

/**
 * Normalise and check a coordinate pair.
 *
 * Both axes or neither, which is the rule the database also holds. Half a
 * position is not partial knowledge - a latitude alone names a line right
 * around the planet - and storing it would put a marker somewhere arbitrary
 * rather than leaving the warehouse in the unplaced list where it belongs.
 */
function coordinatePair(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): { latitude: string | null; longitude: string | null } {
  const lat = latitude ?? null;
  const lon = longitude ?? null;

  if (lat === null && lon === null) return { latitude: null, longitude: null };

  if (lat === null || lon === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Give both a latitude and a longitude, or leave both empty.',
      [{ field: lat === null ? 'latitude' : 'longitude', code: 'REQUIRED' }],
    );
  }

  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Latitude must be between -90 and 90.', [
      { field: 'latitude', code: 'OUT_OF_RANGE' },
    ]);
  }

  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Longitude must be between -180 and 180.', [
      { field: 'longitude', code: 'OUT_OF_RANGE' },
    ]);
  }

  // Handed to Prisma as exact decimal strings, the way the session's position
  // is written in identity/session-location.service.ts. Rounding to the
  // column's scale here rather than leaving it to the driver means what the
  // panel reads back is what it will read back forever.
  return { latitude: lat.toFixed(6), longitude: lon.toFixed(6) };
}

/**
 * The largest geofence a warehouse may promise, in kilometres.
 *
 * Not a physical limit - `chk_location_delivery_radius` allows 20,000, which
 * is half the planet's circumference and the point past which a radius stops
 * meaning anything. This is the commercial one, and it is the same ceiling
 * `DELIVERY_COVERAGE_RADIUS_KM` has: past a couple of thousand kilometres a
 * circle intersects most of a continent, the coverage answer carries a
 * hundred countries' clipped polygons, and nobody promises next-week delivery
 * across it anyway. An operator who really needs more says so and this number
 * changes; a typo of 50000 does not get to become a delivery promise.
 */
const MAX_DELIVERY_RADIUS_KM = 2000;

/**
 * A geofence radius, checked.
 *
 * Undefined passes straight through - absent means "leave it alone". Null is
 * an instruction: go back to the deployment default.
 */
function deliveryRadius(value: number | null | undefined): number | null | undefined {
  if (value === undefined || value === null) return value;

  if (!Number.isInteger(value) || value < 1 || value > MAX_DELIVERY_RADIUS_KM) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `A delivery radius has to be a whole number of kilometres between 1 and ${String(MAX_DELIVERY_RADIUS_KM)}. Clear it to fall back on the deployment's default.`,
      [{ field: 'deliveryRadiusKm', code: 'OUT_OF_RANGE' }],
    );
  }

  return value;
}

/**
 * The lead-time window, checked as a pair.
 *
 * Undefined for both leaves the stored window alone; null for both clears it.
 * One of each is refused, because half a range cannot be printed and cannot be
 * promised. Read together with the stored values by the callers below, so a
 * PATCH that only moves the maximum is checked against the minimum already on
 * the row rather than against nothing.
 */
function leadTimeWindow(
  min: number | null,
  max: number | null,
): { min: number | null; max: number | null } {
  if (min === null && max === null) return { min: null, max: null };

  if (min === null || max === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Give both the fastest and the slowest delivery time in days, or leave both empty.',
      [
        {
          field: min === null ? 'deliveryLeadTimeMinDays' : 'deliveryLeadTimeMaxDays',
          code: 'REQUIRED',
        },
      ],
    );
  }

  for (const [field, value] of [
    ['deliveryLeadTimeMinDays', min],
    ['deliveryLeadTimeMaxDays', max],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 365) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A delivery time has to be a whole number of days between 0 and 365.',
        [{ field, code: 'OUT_OF_RANGE' }],
      );
    }
  }

  if (min > max) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The fastest delivery time cannot be slower than the slowest one.',
      [{ field: 'deliveryLeadTimeMinDays', code: 'OUT_OF_ORDER' }],
    );
  }

  return { min, max };
}

/**
 * The delivery fee and its currency, checked as a pair.
 *
 * Money, so: BigInt minor units parsed from a string, never a float, and never
 * an amount with no currency attached. Zero is a legitimate fee - "we deliver
 * here for nothing" - which is why it is the pairing that is constrained and
 * not the value.
 *
 * The currency is checked against `domain/money.ts` rather than against the
 * `currencies` table, deliberately: what matters is that the arithmetic knows
 * this code's exponent, because a fee stored under a code whose exponent
 * nothing knows is an amount that will one day be displayed a hundred times
 * too large.
 */
function deliveryFee(
  minor: string | null,
  currency: string | null,
): { minor: bigint | null; currency: string | null } {
  if (minor === null && currency === null) return { minor: null, currency: null };

  if (minor === null || currency === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Give both a delivery fee and the currency it is in, or leave both empty.',
      [
        {
          field: minor === null ? 'deliveryFeeMinor' : 'deliveryFeeCurrency',
          code: 'REQUIRED',
        },
      ],
    );
  }

  if (!/^\d+$/.test(minor.trim())) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A delivery fee is a whole number of minor units - 1250 for 12.50 - and cannot be negative.',
      [{ field: 'deliveryFeeMinor', code: 'INVALID' }],
    );
  }

  const code = currency.trim().toUpperCase();

  try {
    // Throws for a code the money module does not carry an exponent for.
    currencyExponent(code);
  } catch {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      `${code} is not a currency this deployment can price in.`,
      [{ field: 'deliveryFeeCurrency', code: 'UNKNOWN_CURRENCY' }],
    );
  }

  return { minor: BigInt(minor.trim()), currency: code };
}

/**
 * The excluded-country list, normalised and checked.
 *
 * Every code is upper-cased and checked against the ISO 3166-1 list rather
 * than against the `countries` table - see the model comment on
 * `WarehouseCountryExclusion` for why the two are different lists and why this
 * one is the right one. A duplicate is folded rather than refused: a form that
 * sends Belgium twice has a bug, and rejecting the save would leave the
 * operator staring at an error about something they cannot see.
 */
function normaliseExclusions(
  entries: readonly { code: string; reason?: string | null }[],
): { countryCode: string; reason: string | null }[] {
  const byCode = new Map<string, string | null>();

  for (const entry of entries) {
    const code = entry.code.trim().toUpperCase();

    if (!/^[A-Z]{2}$/.test(code) || !isIsoCountryCode(code)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `"${entry.code}" is not a country code. Use the two-letter ISO code, e.g. BE for Belgium.`,
        [{ field: 'excludedCountries', code: 'UNKNOWN_COUNTRY' }],
      );
    }

    const reason = nullIfBlank(entry.reason);

    if (reason !== null && reason.length > 256) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A reason for closing a country has to fit in 256 characters.',
        [{ field: 'excludedCountries', code: 'TOO_LONG' }],
      );
    }

    // Last one wins, so a form that sends a code twice with a reason on the
    // second copy keeps the reason.
    byCode.set(code, reason);
  }

  return [...byCode].map(([countryCode, reason]) => ({ countryCode, reason }));
}

/**
 * Write the exclusion set for one warehouse, replacing whatever was there.
 *
 * Delete-then-insert rather than a diff, and inside the caller's transaction.
 * The set is small - a warehouse closes a handful of countries, not a hundred -
 * and a diff would have to decide what to do about a row whose *reason*
 * changed, which is a second code path for no gain. What matters is that the
 * whole replacement is one transaction: an operator who removes two countries
 * and adds one must never be able to observe a moment with none.
 */
async function replaceExclusions(
  tx: PrismaTransaction,
  locationId: string,
  entries: { countryCode: string; reason: string | null }[],
): Promise<void> {
  await tx.warehouseCountryExclusion.deleteMany({ where: { locationId } });

  if (entries.length === 0) return;

  await tx.warehouseCountryExclusion.createMany({
    data: entries.map((entry) => ({
      id: newId(),
      locationId,
      countryCode: entry.countryCode,
      reason: entry.reason,
    })),
  });
}


/**
 * Normalise and check the lanes.
 *
 * Every rule the CHECK constraints hold is checked here first, so the
 * rejection names the field somebody typed into instead of surfacing a
 * constraint name nobody outside this repository can read.
 *
 * A duplicate lane - same country, same postcodes, same service level - is
 * refused rather than folded. That is the opposite of what
 * `normaliseExclusions` does with a repeated country, and the difference is
 * that an exclusion has one meaningful field and a lane has ten: silently
 * keeping the last copy would throw away a price and a transit window
 * somebody typed, and they would never learn which of the two rows survived.
 */
function normaliseZones(
  entries: readonly DeliveryZoneInput[],
): Prisma.WarehouseDeliveryZoneCreateManyLocationInput[] {
  const seen = new Set<string>();
  const rows: Prisma.WarehouseDeliveryZoneCreateManyLocationInput[] = [];

  entries.forEach((entry, index) => {
    const field = `deliveryZones.${String(index)}`;
    const countryCode = entry.countryCode.trim().toUpperCase();

    if (!/^[A-Z]{2}$/.test(countryCode) || !isIsoCountryCode(countryCode)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `"${entry.countryCode}" is not a country code. Use the two-letter ISO code, e.g. BE for Belgium.`,
        [{ field: `${field}.countryCode`, code: 'UNKNOWN_COUNTRY' }],
      );
    }

    // Stored the way it is matched: upper case, no spaces, no hyphens. A lane
    // written as "80-601, 81" and a postcode typed as "80601" are the same
    // place, and normalising both ends here is what makes them meet.
    const postalPrefixes = (entry.postalPrefixes ?? '')
      .split(',')
      .map((prefix) => prefix.trim().toUpperCase().replace(/[\s-]/g, ''))
      .filter((prefix) => prefix.length > 0)
      .join(',');

    if (postalPrefixes.length > 512) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'That is more postcode prefixes than one lane can hold. Split it into two lanes.',
        [{ field: `${field}.postalPrefixes`, code: 'TOO_LONG' }],
      );
    }

    const carrierName = entry.carrierName.trim();
    const serviceLevel = entry.serviceLevel.trim();

    if (carrierName.length === 0 || serviceLevel.length === 0) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A lane needs a carrier and a service level - they are what the buyer chooses between.',
        [
          {
            field: carrierName.length === 0 ? `${field}.carrierName` : `${field}.serviceLevel`,
            code: 'REQUIRED',
          },
        ],
      );
    }

    const handlingDays = entry.handlingDays ?? 1;

    if (!Number.isInteger(handlingDays) || handlingDays < 0 || handlingDays > 90) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Handling time is a whole number of days between 0 and 90.',
        [{ field: `${field}.handlingDays`, code: 'OUT_OF_RANGE' }],
      );
    }

    // Both ends, in the right order. Half a range is not partial knowledge: a
    // minimum with no maximum is a promise with no end, and the storefront
    // would have nothing to print after the dash.
    if (
      !Number.isInteger(entry.transitMinDays) ||
      !Number.isInteger(entry.transitMaxDays) ||
      entry.transitMinDays < 0 ||
      entry.transitMaxDays > 365 ||
      entry.transitMinDays > entry.transitMaxDays
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'Transit time is a range of whole days, smallest first, up to 365.',
        [{ field: `${field}.transitMinDays`, code: 'INVALID_RANGE' }],
      );
    }

    const currency = entry.shippingFeeCurrency.trim().toUpperCase();

    if (!/^[A-Z]{3}$/.test(currency)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A delivery fee needs a three-letter currency code.',
        [{ field: `${field}.shippingFeeCurrency`, code: 'INVALID' }],
      );
    }

    const feeMinor = parseMinor(entry.shippingFeeMinor ?? '0', `${field}.shippingFeeMinor`);
    const freeAboveMinor =
      entry.freeAboveMinor === null || entry.freeAboveMinor === undefined
        ? null
        : parseMinor(entry.freeAboveMinor, `${field}.freeAboveMinor`);

    if (
      entry.maxWeightGrams !== null &&
      entry.maxWeightGrams !== undefined &&
      (!Number.isInteger(entry.maxWeightGrams) || entry.maxWeightGrams <= 0)
    ) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        'A weight limit is a whole number of grams above zero. Leave it empty for no limit.',
        [{ field: `${field}.maxWeightGrams`, code: 'OUT_OF_RANGE' }],
      );
    }

    const key = `${countryCode}|${postalPrefixes}|${serviceLevel.toUpperCase()}`;

    if (seen.has(key)) {
      throw badRequest(
        ErrorCode.VALIDATION_FAILED,
        `Two lanes cover ${countryCode} with the same postcodes at the "${serviceLevel}" service level. Give one of them a different service level, or narrow its postcodes.`,
        [{ field: `${field}.serviceLevel`, code: 'DUPLICATE' }],
      );
    }

    seen.add(key);

    rows.push({
      id: newId(),
      countryCode,
      postalPrefixes,
      carrierName,
      serviceLevel,
      handlingDays,
      transitMinDays: entry.transitMinDays,
      transitMaxDays: entry.transitMaxDays,
      usesBusinessDays: entry.usesBusinessDays ?? true,
      shippingFeeMinor: feeMinor,
      shippingFeeCurrency: currency,
      freeAboveMinor,
      supportsColdChain: entry.supportsColdChain ?? false,
      maxWeightGrams: entry.maxWeightGrams ?? null,
      isActive: entry.isActive ?? true,
      priority: entry.priority ?? 0,
    });
  });

  return rows;
}

/** A digit string to BigInt, with the field named in the refusal. */
function parseMinor(value: string, field: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'An amount is a whole number of minor units.', [
      { field, code: 'INVALID' },
    ]);
  }

  return BigInt(value.trim());
}

/**
 * Write the lane set for one warehouse, replacing whatever was there.
 *
 * Delete-then-insert inside the caller's transaction, the same shape
 * `replaceExclusions` uses and for the same reason: the form states the whole
 * set, the set is small, and an operator who removes two lanes and adds one
 * must never be able to observe a moment with none.
 *
 * A quote that pointed at a deleted lane keeps working - `zoneId` is SET NULL
 * - but `assertQuoteUsable` then withdraws the offer rather than honouring a
 * service that no longer exists, which is the right way round: the customer
 * is asked to choose again instead of being sold a lane nobody stands behind.
 */
async function replaceZones(
  tx: PrismaTransaction,
  locationId: string,
  rows: Prisma.WarehouseDeliveryZoneCreateManyLocationInput[],
): Promise<void> {
  await tx.warehouseDeliveryZone.deleteMany({ where: { locationId } });

  if (rows.length === 0) return;

  await tx.warehouseDeliveryZone.createMany({
    data: rows.map((row) => ({ ...row, locationId })),
  });
}

/**
 * Warehouse codes are upper case.
 *
 * Not a matter of taste: MariaDB's default collation is case-insensitive, so
 * `main` and `MAIN` already collide on the unique index. Normalising on the
 * way in means the rejection says "that code is taken" instead of the write
 * failing on a constraint whose message means nothing to the reader.
 */
/** Trim, and treat an empty string as "not set" rather than as a value. */
function nullIfBlank(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

function normaliseCode(code: string): string {
  const trimmed = code.trim().toUpperCase();

  if (trimmed.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A warehouse needs a code.', [
      { field: 'code', code: 'REQUIRED' },
    ]);
  }

  return trimmed;
}

async function assertCodeFree(code: string, exceptId?: string): Promise<void> {
  const existing = await prisma.inventoryLocation.findFirst({
    where: { code, ...(exceptId === undefined ? {} : { id: { not: exceptId } }) },
    select: { id: true, name: true, isActive: true },
  });

  if (existing === null) return;

  // Names the holder, including a retired one. "MAIN is already taken" with no
  // warehouse called MAIN visible on the screen is the kind of dead end that
  // finishes with somebody opening the database.
  throw conflict(
    ErrorCode.LOCATION_CODE_EXISTS,
    existing.isActive
      ? `The code ${code} already belongs to ${existing.name}.`
      : `The code ${code} belongs to ${existing.name}, which is retired. Bring that one back rather than creating a second.`,
    [{ field: 'code', code: 'TAKEN' }],
  );
}

/**
 * Make one warehouse the default, clearing whichever held it.
 *
 * Inside the caller's transaction, so there is never an instant with two
 * defaults or none - `defaultLocationId` in inventory.service.ts resolves a
 * `findFirst` against exactly this flag, and would choose arbitrarily between
 * two or refuse a receipt outright if it saw zero.
 */
async function promoteDefault(tx: PrismaTransaction, id: string): Promise<void> {
  await tx.inventoryLocation.updateMany({
    where: { isDefault: true, id: { not: id } },
    data: { isDefault: false },
  });
  await tx.inventoryLocation.update({ where: { id }, data: { isDefault: true } });
}

/**
 * One warehouse, read back the way the list reads it.
 *
 * Both writes below answer with the full row - stock counts included - so the
 * panel can drop it straight into the table it came from rather than firing a
 * second request to find out what it just created.
 */
async function readBack(id: string): Promise<Warehouse> {
  const warehouse = (await listWarehouses({ includeInactive: true })).find(
    (candidate) => candidate.id === id,
  );

  if (warehouse === undefined) throw notFound('Warehouse');
  return warehouse;
}

export async function createWarehouse(
  input: WarehouseInput,
  actor: LocationActor,
): Promise<Warehouse> {
  const code = normaliseCode(input.code);
  const name = input.name.trim();

  if (name.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A warehouse needs a name.', [
      { field: 'name', code: 'REQUIRED' },
    ]);
  }

  await assertCodeFree(code);
  const coordinates = coordinatePair(input.latitude, input.longitude);
  const countryCode = await normaliseCountry(input.countryCode);
  const timezone = normaliseTimezone(input.timezone);

  // The geofence. Absent and null mean the same thing on a create - there is
  // nothing stored to leave alone - and both land on the deployment's default.
  const radiusKm = deliveryRadius(input.deliveryRadiusKm) ?? null;
  const leadTime = leadTimeWindow(
    input.deliveryLeadTimeMinDays ?? null,
    input.deliveryLeadTimeMaxDays ?? null,
  );
  const fee = deliveryFee(input.deliveryFeeMinor ?? null, input.deliveryFeeCurrency ?? null);
  const exclusions = normaliseExclusions(input.excludedCountries ?? []);
  const zones = normaliseZones(input.deliveryZones ?? []);

  // Required on create, nullable in the column. The column has to allow null
  // because warehouses existed before it did; a warehouse created today has
  // no such excuse, and the map's country filter is only as good as this.
  if (countryCode === null) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Say which country this warehouse is in.', [
      { field: 'countryCode', code: 'REQUIRED' },
    ]);
  }

  // The first warehouse is the default whatever the form said. A deployment
  // whose only warehouse is not the default cannot book a receipt at all, and
  // that is not a state to let somebody create by leaving a checkbox alone.
  const existingCount = await prisma.inventoryLocation.count();
  const isDefault = existingCount === 0 || input.isDefault === true;

  // A retired warehouse that is also the default is the one combination that
  // breaks receipts, so it is refused at the point of creation too.
  const isActive = input.isActive ?? true;
  if (isDefault && !isActive) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The default warehouse has to be active. Stock received without a warehouse named lands here.',
      [{ field: 'isActive', code: 'DEFAULT_MUST_BE_ACTIVE' }],
    );
  }

  const id = newId();

  await prisma.$transaction(async (tx: PrismaTransaction) => {
    await tx.inventoryLocation.create({
      data: {
        id,
        code,
        name,
        ...(input.address === undefined || input.address === null
          ? {}
          : { addressJson: input.address as Prisma.InputJsonValue }),
        countryCode,
        timezone,
        latitude: coordinates.latitude,
        longitude: coordinates.longitude,
        operationalStatus: input.operationalStatus ?? 'OPERATIONAL',
        erpExternalId: nullIfBlank(input.erpExternalId),
        deliveryRadiusKm: radiusKm,
        deliveryLeadTimeMinDays: leadTime.min,
        deliveryLeadTimeMaxDays: leadTime.max,
        deliveryFeeMinor: fee.minor,
        deliveryFeeCurrency: fee.currency,
        // The three sync columns are left at their defaults on purpose. A
        // warehouse has not synced with anything the moment it is created,
        // and NEVER_SYNCED is the only honest thing to say about it.
        // Set through `promoteDefault` rather than here, so clearing the
        // previous holder and setting this one are the same write.
        isDefault: false,
        isActive,
      },
    });

    if (exclusions.length > 0) await replaceExclusions(tx, id, exclusions);
    if (zones.length > 0) await replaceZones(tx, id, zones);

    if (isDefault) await promoteDefault(tx, id);

    await recordAudit(
      {
        action: AuditAction.INVENTORY_LOCATION_CREATED,
        resourceType: 'inventory_location',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          code,
          name,
          countryCode,
          timezone,
          operationalStatus: input.operationalStatus ?? 'OPERATIONAL',
          erpExternalId: nullIfBlank(input.erpExternalId),
          isDefault,
          isActive,
          latitude: input.latitude ?? null,
          longitude: input.longitude ?? null,
          deliveryRadiusKm: radiusKm,
          deliveryLeadTimeMinDays: leadTime.min,
          deliveryLeadTimeMaxDays: leadTime.max,
          // The audit trail carries money as a string for the same reason the
          // API does: a JSON number is not a safe place to put minor units.
          deliveryFeeMinor: fee.minor === null ? null : fee.minor.toString(),
          deliveryFeeCurrency: fee.currency,
          excludedCountries: exclusions.map((entry) => entry.countryCode),
          // The count rather than the lanes. An audit entry is read to answer
          // "who changed what and when", and twelve carrier rate lines in it
          // would bury the answer; the rows themselves are still there to
          // read.
          deliveryZoneCount: zones.length,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return readBack(id);
}

export type WarehouseUpdate = Partial<WarehouseInput>;

/**
 * May this warehouse be retired?
 *
 * Two ways it may not, and each answer says the count behind it, because the
 * count is the whole of "so what do I do about it".
 */
async function assertRetirable(id: string, isDefault: boolean, name: string): Promise<void> {
  if (isDefault) {
    throw conflict(
      ErrorCode.LOCATION_STILL_IN_USE,
      `${name} is the default warehouse. Make another one the default first, then retire this.`,
      [{ field: 'isActive', code: 'IS_DEFAULT' }],
    );
  }

  const [held, reserved] = await Promise.all([
    prisma.inventoryBalance.aggregate({
      where: { locationId: id, product: { archivedAt: null, isStockTracked: true } },
      _sum: { onHandQty: true },
    }),
    prisma.stockReservation.count({ where: { locationId: id, status: 'ACTIVE' } }),
  ]);

  const onHand = held._sum.onHandQty ?? 0;

  // Retiring a warehouse with stock in it does not move the stock - it hides
  // it. The balances stay, the movements stay, and the pickers stop offering
  // the only place from which it could be adjusted back out again.
  if (onHand > 0) {
    throw conflict(
      ErrorCode.LOCATION_STILL_IN_USE,
      `${name} still holds ${String(onHand)} unit(s) of stock. Move or write it off before retiring the warehouse.`,
      [{ field: 'isActive', code: 'HOLDS_STOCK', meta: { onHandQty: onHand } }],
    );
  }

  if (reserved > 0) {
    throw conflict(
      ErrorCode.LOCATION_STILL_IN_USE,
      `${name} has ${String(reserved)} live reservation(s) against it. They expire on their own; try again shortly.`,
      [{ field: 'isActive', code: 'HAS_RESERVATIONS', meta: { activeReservations: reserved } }],
    );
  }
}

export async function updateWarehouse(
  id: string,
  input: WarehouseUpdate,
  actor: LocationActor,
): Promise<Warehouse> {
  const before = await prisma.inventoryLocation.findUnique({
    where: { id },
    include: { exclusions: { select: { countryCode: true, reason: true } } },
  });
  if (before === null) throw notFound('Warehouse');

  const code = input.code === undefined ? undefined : normaliseCode(input.code);
  if (code !== undefined && code !== before.code) await assertCodeFree(code, id);

  const name = input.name === undefined ? undefined : input.name.trim();
  if (name !== undefined && name.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A warehouse needs a name.', [
      { field: 'name', code: 'REQUIRED' },
    ]);
  }

  // Coordinates only move when the caller mentions them. A PATCH that renames
  // a warehouse must not silently unplace it.
  const touchesCoordinates = input.latitude !== undefined || input.longitude !== undefined;
  const coordinates = touchesCoordinates
    ? coordinatePair(
        input.latitude === undefined ? coordinate(before.latitude) : input.latitude,
        input.longitude === undefined ? coordinate(before.longitude) : input.longitude,
      )
    : undefined;

  // The same "absent leaves it alone" rule as the coordinates, and for the
  // same reason: a PATCH that changes the operational status must not blank a
  // country or a time zone it never mentioned.
  const countryCode =
    input.countryCode === undefined ? undefined : await normaliseCountry(input.countryCode);
  const timezone = input.timezone === undefined ? undefined : normaliseTimezone(input.timezone);

  // The geofence and the delivery promise, on the same "absent leaves it
  // alone, null clears it" rule as everything above.
  const radiusKm = input.deliveryRadiusKm === undefined ? undefined : deliveryRadius(input.deliveryRadiusKm);

  /**
   * The lead-time window, checked against the row for the half that was not
   * sent.
   *
   * A PATCH that moves only the maximum has to be validated against the
   * minimum that is already stored, not against nothing - otherwise raising
   * the maximum on a warehouse with a stored minimum of 2 could be checked as
   * if the minimum were absent, and "give both or neither" would fire on a
   * request that is perfectly complete.
   */
  const touchesLeadTime =
    input.deliveryLeadTimeMinDays !== undefined || input.deliveryLeadTimeMaxDays !== undefined;
  const leadTime = touchesLeadTime
    ? leadTimeWindow(
        input.deliveryLeadTimeMinDays === undefined
          ? before.deliveryLeadTimeMinDays
          : input.deliveryLeadTimeMinDays,
        input.deliveryLeadTimeMaxDays === undefined
          ? before.deliveryLeadTimeMaxDays
          : input.deliveryLeadTimeMaxDays,
      )
    : undefined;

  // Same rule for the fee: sending an amount and no currency on a warehouse
  // that already has one is a currency change of nothing, not a missing field.
  const touchesFee =
    input.deliveryFeeMinor !== undefined || input.deliveryFeeCurrency !== undefined;
  const fee = touchesFee
    ? deliveryFee(
        input.deliveryFeeMinor === undefined
          ? (before.deliveryFeeMinor?.toString() ?? null)
          : input.deliveryFeeMinor,
        input.deliveryFeeCurrency === undefined
          ? before.deliveryFeeCurrency
          : input.deliveryFeeCurrency,
      )
    : undefined;

  const exclusions =
    input.excludedCountries === undefined
      ? undefined
      : normaliseExclusions(input.excludedCountries);

  // Absent leaves the lanes alone; `[]` removes every one of them. The same
  // distinction the closed countries carry, and it matters more here: a PATCH
  // that renamed a building and silently cleared its lanes would take the
  // warehouse off every checkout in the deployment.
  const zones =
    input.deliveryZones === undefined ? undefined : normaliseZones(input.deliveryZones);

  // A warehouse that already has a country may not have it taken away - the
  // country is required on every warehouse created through the panel, and
  // clearing it would put this row back into the pre-migration state on
  // purpose.
  if (countryCode === null && before.countryCode !== null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'A warehouse has to be in a country. Change it rather than clearing it.',
      [{ field: 'countryCode', code: 'REQUIRED' }],
    );
  }

  // Demoting the only default would leave `defaultLocationId` with nothing to
  // find, and the next receipt would be refused. The way to change the default
  // is to promote the other one - the same reasoning the tax classes use, and
  // it means there is never a moment with none.
  if (input.isDefault === false && before.isDefault) {
    throw conflict(
      ErrorCode.LOCATION_STILL_IN_USE,
      'Make another warehouse the default instead. Stock received without a warehouse named has to land somewhere.',
      [{ field: 'isDefault', code: 'PROMOTE_ANOTHER_INSTEAD' }],
    );
  }

  if (input.isActive === false && before.isActive) {
    await assertRetirable(before.id, before.isDefault, before.name);
  }

  // Promoting a retired warehouse to default in one request would leave the
  // pair in the state receipts cannot use. Reactivate it, then promote it.
  if (input.isDefault === true && (input.isActive ?? before.isActive) === false) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'The default warehouse has to be active. Bring this one back before making it the default.',
      [{ field: 'isActive', code: 'DEFAULT_MUST_BE_ACTIVE' }],
    );
  }

  await prisma.$transaction(async (tx: PrismaTransaction) => {
    await tx.inventoryLocation.update({
      where: { id },
      data: {
        ...(code === undefined ? {} : { code }),
        ...(name === undefined ? {} : { name }),
        ...(input.address === undefined
          ? {}
          : {
              addressJson:
                input.address === null ? Prisma.DbNull : (input.address as Prisma.InputJsonValue),
            }),
        ...(countryCode === undefined ? {} : { countryCode }),
        ...(timezone === undefined ? {} : { timezone }),
        ...(coordinates === undefined
          ? {}
          : { latitude: coordinates.latitude, longitude: coordinates.longitude }),
        ...(input.operationalStatus === undefined
          ? {}
          : { operationalStatus: input.operationalStatus }),
        ...(input.erpExternalId === undefined
          ? {}
          : { erpExternalId: nullIfBlank(input.erpExternalId) }),
        ...(radiusKm === undefined ? {} : { deliveryRadiusKm: radiusKm }),
        ...(leadTime === undefined
          ? {}
          : {
              deliveryLeadTimeMinDays: leadTime.min,
              deliveryLeadTimeMaxDays: leadTime.max,
            }),
        ...(fee === undefined
          ? {}
          : { deliveryFeeMinor: fee.minor, deliveryFeeCurrency: fee.currency }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });

    if (exclusions !== undefined) await replaceExclusions(tx, id, exclusions);
    if (zones !== undefined) await replaceZones(tx, id, zones);

    if (input.isDefault === true && !before.isDefault) await promoteDefault(tx, id);

    await recordAudit(
      {
        action: AuditAction.INVENTORY_LOCATION_UPDATED,
        resourceType: 'inventory_location',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          code: before.code,
          name: before.name,
          countryCode: before.countryCode,
          timezone: before.timezone,
          operationalStatus: before.operationalStatus,
          erpExternalId: before.erpExternalId,
          isDefault: before.isDefault,
          isActive: before.isActive,
          latitude: coordinate(before.latitude),
          longitude: coordinate(before.longitude),
          // The geofence is in the audit trail because it is a commercial
          // promise. "Why did we stop offering Luxembourg in March" is a
          // question somebody asks, and the answer is either a radius that
          // shrank or a country somebody closed - both of which are here.
          deliveryRadiusKm: before.deliveryRadiusKm,
          deliveryLeadTimeMinDays: before.deliveryLeadTimeMinDays,
          deliveryLeadTimeMaxDays: before.deliveryLeadTimeMaxDays,
          deliveryFeeMinor: before.deliveryFeeMinor?.toString() ?? null,
          deliveryFeeCurrency: before.deliveryFeeCurrency,
          excludedCountries: before.exclusions
            .map((entry) => entry.countryCode)
            .sort((a, b) => a.localeCompare(b)),
        },
        after: {
          code: code ?? before.code,
          name: name ?? before.name,
          countryCode: countryCode ?? before.countryCode,
          timezone: timezone === undefined ? before.timezone : timezone,
          operationalStatus: input.operationalStatus ?? before.operationalStatus,
          erpExternalId:
            input.erpExternalId === undefined
              ? before.erpExternalId
              : nullIfBlank(input.erpExternalId),
          isDefault: input.isDefault ?? before.isDefault,
          isActive: input.isActive ?? before.isActive,
          latitude:
            coordinates === undefined
              ? coordinate(before.latitude)
              : coordinate(coordinates.latitude),
          longitude:
            coordinates === undefined
              ? coordinate(before.longitude)
              : coordinate(coordinates.longitude),
          deliveryRadiusKm: radiusKm === undefined ? before.deliveryRadiusKm : radiusKm,
          deliveryLeadTimeMinDays:
            leadTime === undefined ? before.deliveryLeadTimeMinDays : leadTime.min,
          deliveryLeadTimeMaxDays:
            leadTime === undefined ? before.deliveryLeadTimeMaxDays : leadTime.max,
          deliveryFeeMinor:
            fee === undefined
              ? (before.deliveryFeeMinor?.toString() ?? null)
              : (fee.minor?.toString() ?? null),
          deliveryFeeCurrency: fee === undefined ? before.deliveryFeeCurrency : fee.currency,
          excludedCountries: (exclusions === undefined ? before.exclusions : exclusions)
            .map((entry) => entry.countryCode)
            .sort((a, b) => a.localeCompare(b)),
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return readBack(id);
}

/**
 * What still points at this warehouse.
 *
 * Four tables reference `inventory_locations` with `onDelete: Restrict`:
 * balances, movements, reservations and the scheduled orders that pin a plan
 * to one warehouse. The guard below reads all four and names whichever is in
 * the way, because "that cannot be deleted" with no reason attached is how
 * somebody ends up opening the database to find out why.
 *
 * Counted rather than merely existence-checked, for the same reason the retire
 * guard sums the stock: the number is most of the answer to "so what do I do
 * about it".
 *
 * Reservations are counted in **every** status, not only ACTIVE. A RELEASED
 * one is finished business and its row still holds the warehouse in place.
 * Balances are counted without the tracked-and-unarchived product filter the
 * roll-up uses, for the same reason - a balance against an archived product is
 * still a row with a foreign key in it.
 */
interface WarehouseReferences {
  balances: number;
  heldQty: number;
  movements: number;
  reservations: number;
  schedules: number;
  /** Orders this warehouse was chosen to fulfil. RESTRICT, so it blocks. */
  orders: number;
  /** Delivery offers quoted from here. RESTRICT too, but they expire. */
  quotes: number;
}

async function referencesTo(id: string): Promise<WarehouseReferences> {
  const [balances, movements, reservations, schedules, orders, quotes] = await Promise.all([
    prisma.inventoryBalance.aggregate({
      where: { locationId: id },
      _count: { _all: true },
      _sum: { onHandQty: true, reservedQty: true },
    }),
    prisma.inventoryMovement.count({ where: { locationId: id } }),
    prisma.stockReservation.count({ where: { locationId: id } }),
    prisma.recurringSchedule.count({ where: { inventoryLocationId: id } }),
    // Orders this warehouse was chosen to fulfil, and the offers behind them.
    // Both are RESTRICT, so both have to be counted here or the delete would
    // fail on a constraint name instead of on a sentence.
    prisma.order.count({ where: { fulfilmentLocationId: id } }),
    prisma.fulfilmentQuote.count({ where: { locationId: id } }),
  ]);

  return {
    balances: balances._count._all,
    heldQty: (balances._sum.onHandQty ?? 0) + (balances._sum.reservedQty ?? 0),
    movements,
    reservations,
    schedules,
    orders,
    quotes,
  };
}

/**
 * May this warehouse's row actually go?
 *
 * Only while nothing has ever been booked against it. That is a narrower door
 * than it sounds and it is the whole point of having one: the warehouse this
 * removes is the duplicate created with a typo in its code, or the site that
 * was planned and never opened. Neither should have to be archived forever
 * where it clutters the list somebody reads to find a real one.
 *
 * The moment a movement exists the row stays and retiring is the answer. Not
 * because deleting would be hard - `Restrict` refuses the write on its own -
 * but because the ledger is the record of where stock went, and a movement
 * whose warehouse cannot be named is a hole in it. So nothing here cascades
 * and nothing here takes a force flag: a delete that could take history with
 * it would be worth more to an attacker than every other write on this screen
 * put together.
 */
async function assertDeletable(row: {
  id: string;
  name: string;
  isDefault: boolean;
}): Promise<void> {
  // Checked first, because it is the one refusal with an obvious next step and
  // because a deployment whose default has been deleted cannot book a receipt
  // at all - `defaultLocationId` in inventory.service.ts would find nothing.
  // The only warehouse is always the default, so this is also what stops the
  // last one being deleted.
  if (row.isDefault) {
    throw conflict(
      ErrorCode.LOCATION_STILL_IN_USE,
      `${row.name} is the default warehouse. Make another one the default first.`,
      [{ field: 'isDefault', code: 'IS_DEFAULT' }],
    );
  }

  const references = await referencesTo(row.id);

  if (references.movements > 0) {
    throw conflict(
      ErrorCode.LOCATION_HAS_HISTORY,
      `${row.name} has ${String(references.movements)} stock movement(s) recorded against it, so the record has to stay - deleting it would leave the ledger unable to say where that stock went. Retire it instead: it stops being offered, and its history stays readable.`,
      [{ field: 'id', code: 'HAS_MOVEMENTS', meta: { movements: references.movements } }],
    );
  }

  if (references.balances > 0) {
    throw conflict(
      ErrorCode.LOCATION_HAS_HISTORY,
      references.heldQty > 0
        ? `${row.name} holds ${String(references.heldQty)} unit(s) of stock. Move or write it off, then retire the warehouse.`
        : `${row.name} has ${String(references.balances)} stock record(s) against it. Retire it instead.`,
      [
        {
          field: 'id',
          code: 'HAS_BALANCES',
          meta: { balances: references.balances, heldQty: references.heldQty },
        },
      ],
    );
  }

  if (references.reservations > 0) {
    throw conflict(
      ErrorCode.LOCATION_HAS_HISTORY,
      `${row.name} has ${String(references.reservations)} reservation(s) recorded against it, live or finished. Retire it instead.`,
      [{ field: 'id', code: 'HAS_RESERVATIONS', meta: { reservations: references.reservations } }],
    );
  }

  // A scheduled order naming this warehouse is the reference that bites
  // hardest, because it is about the future rather than the past: a worker
  // will price that basket weeks from now and charge a card for it, and it
  // needs somewhere to take the stock from. Cancelled and finished plans keep
  // their row too and are counted, because the foreign key does not care
  // which.
  if (references.schedules > 0) {
    throw conflict(
      ErrorCode.LOCATION_HAS_HISTORY,
      `${row.name} is named on ${String(references.schedules)} scheduled order(s). Point those at another warehouse first, or retire this one.`,
      [{ field: 'id', code: 'HAS_SCHEDULES', meta: { schedules: references.schedules } }],
    );
  }

  // An order that named this warehouse at checkout. History in the fullest
  // sense - the customer chose this building and was promised a date from it -
  // so the row stays and retiring is the answer.
  if (references.orders > 0) {
    throw conflict(
      ErrorCode.LOCATION_HAS_HISTORY,
      `${row.name} is named on ${String(references.orders)} order(s) as the warehouse they ship from. Retire it instead: it stops being offered, and those orders keep saying where they came from.`,
      [{ field: 'id', code: 'HAS_ORDERS', meta: { orders: references.orders } }],
    );
  }

  // Delivery options quoted from here. Unlike the four above these expire on
  // their own, so the refusal says when rather than only that - "try again
  // after lunch" is a far better answer than "retire it instead" for a
  // warehouse created by mistake this morning.
  if (references.quotes > 0) {
    throw conflict(
      ErrorCode.LOCATION_STILL_IN_USE,
      `${row.name} has ${String(references.quotes)} delivery quote(s) outstanding against it. Unaccepted ones are cleared automatically once they expire; try again shortly.`,
      [{ field: 'id', code: 'HAS_QUOTES', meta: { quotes: references.quotes } }],
    );
  }
}

/**
 * Delete a warehouse that was never used.
 *
 * Answers 404 for a warehouse that is not there, which is also the answer to
 * pressing delete twice - and the right one: the row is gone either way.
 *
 * The audit entry is written in the same transaction as the delete and carries
 * the whole record rather than an id, because it is the only thing that will
 * be left. There is no row to look up afterwards, and "who removed the
 * warehouse called Pune North, and what was its code" is exactly the question
 * somebody asks a week later. `audit_logs` has no foreign key to
 * `inventory_locations`, so the entry outlives the row it describes.
 */
export async function deleteWarehouse(id: string, actor: LocationActor): Promise<void> {
  const before = await prisma.inventoryLocation.findUnique({ where: { id } });
  if (before === null) throw notFound('Warehouse');

  await assertDeletable(before);

  await prisma.$transaction(async (tx: PrismaTransaction) => {
    await recordAudit(
      {
        action: AuditAction.INVENTORY_LOCATION_DELETED,
        resourceType: 'inventory_location',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          code: before.code,
          name: before.name,
          countryCode: before.countryCode,
          timezone: before.timezone,
          operationalStatus: before.operationalStatus,
          erpExternalId: before.erpExternalId,
          isDefault: before.isDefault,
          isActive: before.isActive,
          latitude: coordinate(before.latitude),
          longitude: coordinate(before.longitude),
          createdAt: before.createdAt.toISOString(),
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    // The delete sits inside the transaction, after the guard, so a movement
    // written between the two takes the whole thing down rather than slipping
    // past: `Restrict` is enforced by the database and it is the last word
    // here, not `assertDeletable`. The guard exists to explain the refusal,
    // not to be the refusal.
    await tx.inventoryLocation.delete({ where: { id } });
  });
}

// --- ERP synchronisation ---------------------------------------------------

export interface ErpSyncReport {
  status: ErpSyncStatus;
  /**
   * What the connector wants the operator to read. The reason on a failure,
   * a note like "412 SKUs reconciled" on a success.
   */
  message?: string | null;
  /**
   * When the sync actually happened, if not now. A connector that batches its
   * reporting must be able to say when the work was done rather than when it
   * got round to saying so.
   */
  syncedAt?: Date | null;
}

/**
 * Record where a warehouse stands with the ERP.
 *
 * This is the *only* writer of `erpSyncStatus`, `erpLastSyncAt` and
 * `erpSyncMessage`, and the warehouse form deliberately cannot touch them. A
 * sync state a person typed is a sync state that lies: the whole value of the
 * field is that it was written by the thing that did the syncing.
 *
 * `erpLastSyncAt` moves only on a terminal outcome. PENDING means an attempt
 * is in flight and the last *completed* sync is still whenever it was -
 * stamping the time when a job starts would make a warehouse that has been
 * failing for a week look freshly synced.
 */
export async function recordErpSync(
  id: string,
  report: ErpSyncReport,
  actor: LocationActor,
): Promise<Warehouse> {
  const before = await prisma.inventoryLocation.findUnique({
    where: { id },
    select: {
      id: true,
      code: true,
      erpSyncStatus: true,
      erpLastSyncAt: true,
      erpSyncMessage: true,
    },
  });

  if (before === null) throw notFound('Warehouse');

  const isTerminal = report.status === 'SYNCED' || report.status === 'FAILED';
  const syncedAt = isTerminal ? (report.syncedAt ?? new Date()) : before.erpLastSyncAt;

  await prisma.$transaction(async (tx: PrismaTransaction) => {
    await tx.inventoryLocation.update({
      where: { id },
      data: {
        erpSyncStatus: report.status,
        erpLastSyncAt: syncedAt,
        // Cleared on a status that carries no explanation, rather than left
        // showing last week's failure next to a green badge.
        erpSyncMessage: nullIfBlank(report.message)?.slice(0, 512) ?? null,
      },
    });

    await recordAudit(
      {
        action: AuditAction.INVENTORY_LOCATION_ERP_SYNCED,
        resourceType: 'inventory_location',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: {
          erpSyncStatus: before.erpSyncStatus,
          erpLastSyncAt: before.erpLastSyncAt?.toISOString() ?? null,
          erpSyncMessage: before.erpSyncMessage,
        },
        after: {
          erpSyncStatus: report.status,
          erpLastSyncAt: syncedAt?.toISOString() ?? null,
          erpSyncMessage: nullIfBlank(report.message),
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return readBack(id);
}

// --- Geocoding -------------------------------------------------------------

export interface GeocodedAddress {
  latitude: number;
  longitude: number;
  /** What the geocoder thinks it was asked about, so a person can check it. */
  label: string | null;
}

/**
 * An address to coordinates.
 *
 * The mirror of `reverseGeocode` in identity/session-location.service.ts, and
 * deliberately total in the same way: no URL configured, a timeout, a non-200,
 * a body in an unrecognised shape, or simply no match all return null rather
 * than throwing. The caller is a button that fills in two fields; a geocoder
 * having a bad afternoon must not stop a warehouse being recorded.
 */
export async function forwardGeocode(query: string): Promise<GeocodedAddress | null> {
  const address = query.trim();
  if (address.length === 0) return null;

  const template = env.GEOCODE_FORWARD_URL.trim();
  if (template.length === 0) return null;

  const url = template.replace('{query}', encodeURIComponent(address));

  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        // OpenStreetMap's usage policy asks callers to identify themselves,
        // and an unidentified client is the one they block first.
        'user-agent': `UBOSS/1.0 (+${env.API_PUBLIC_URL})`,
      },
      signal: AbortSignal.timeout(env.GEOCODE_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.warn({ status: response.status }, 'forward geocode answered a non-200');
      return null;
    }

    const body: unknown = await response.json();

    // Nominatim's search endpoint answers with an array; some of its clones
    // wrap the same objects in `{ results: [...] }`. Both are read, and
    // anything else is treated as no answer at all.
    const candidates: unknown[] = Array.isArray(body)
      ? body
      : isResultsEnvelope(body)
        ? body.results
        : [];

    const first = candidates[0];
    if (typeof first !== 'object' || first === null) return null;

    const record = first as Record<string, unknown>;
    const latitude = Number(record.lat ?? record.latitude);
    const longitude = Number(record.lon ?? record.lng ?? record.longitude);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

    const label = [record.display_name, record.name].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );

    return {
      // Rounded to the column's scale, so the panel shows the value that will
      // actually be stored rather than one that changes on save.
      latitude: Number(latitude.toFixed(6)),
      longitude: Number(longitude.toFixed(6)),
      label: label === undefined ? null : label.trim().slice(0, 255),
    };
  } catch (error) {
    logger.warn({ err: error }, 'forward geocode failed');
    return null;
  }
}

function isResultsEnvelope(body: unknown): body is { results: unknown[] } {
  return (
    typeof body === 'object' &&
    body !== null &&
    Array.isArray((body as { results?: unknown }).results)
  );
}
