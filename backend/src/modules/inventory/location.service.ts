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
 *   - **A warehouse is never deleted.** Movements point at it with
 *     `onDelete: Restrict`, and rightly: deleting the place would orphan the
 *     ledger that explains where stock went. Retiring one sets `isActive`
 *     false, which takes it out of the receipt and adjustment dialogs while
 *     leaving every historical movement readable.
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
 */
import { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
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
 * The tile source, or null for "draw the markers on a plain grid".
 *
 * Null is the default and a working state, not a misconfiguration. A tile
 * request tells whoever serves it which part of the world is being looked at,
 * and for this product that is where the buyer's warehouses are - not a fact
 * this software gets to disclose on their behalf until they ask it to.
 */
export function mapTiles(): MapTiles | null {
  const urlTemplate = env.MAP_TILE_URL.trim();
  if (urlTemplate.length === 0) return null;

  return { urlTemplate, attribution: env.MAP_TILE_ATTRIBUTION.trim() };
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
      include: { country: { select: { name: true } } },
    }),
    stockByLocation(),
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
        // The three sync columns are left at their defaults on purpose. A
        // warehouse has not synced with anything the moment it is created,
        // and NEVER_SYNCED is the only honest thing to say about it.
        // Set through `promoteDefault` rather than here, so clearing the
        // previous holder and setting this one are the same write.
        isDefault: false,
        isActive,
      },
    });

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
  const before = await prisma.inventoryLocation.findUnique({ where: { id } });
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
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });

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
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return readBack(id);
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
