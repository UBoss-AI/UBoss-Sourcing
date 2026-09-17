/**
 * Seller warehouses, as the marketplace's own console sees them.
 *
 * The operator's Warehouses screen has always drawn `inventory_locations` -
 * the buildings this deployment runs itself. A marketplace has a second set it
 * does not own and very much needs to see: the dispatch locations of every
 * approved seller, which is where a growing share of what buyers order
 * actually ships from. "Which of our sellers can reach Greece?" and "where is
 * Northwind dispatching from?" were questions with no screen.
 *
 * WHAT THIS IS NOT
 *
 *   - **Not a second warehouse table.** A seller location is a `SellerLocation`
 *     row and stays one. Nothing here copies, mirrors or shadows a row into
 *     `inventory_locations`; duplicating them for display is how two records of
 *     one building start disagreeing about where it is.
 *   - **Not a write surface.** A seller's locations are theirs to maintain in
 *     the Seller Hub. This module reads. An operator who needs one changed asks
 *     the seller, exactly as they do for a listing.
 *   - **Not the seller-insight panel.** `seller/insight.service.ts` answers
 *     "how is this seller doing", with catalogue and trade figures, and happens
 *     to include locations. This answers "where does stock sit", for the
 *     warehouse screen, and carries what that screen shows: an owner, an
 *     operational state, a stock roll-up and a sync time.
 *
 * SELLER ELIGIBILITY IS ONE RULE, WRITTEN ONCE
 *
 * A seller is offered to the operator when its **onboarding** is approved and
 * its account is live - `status = APPROVED` and `archivedAt = null`. Not
 * whether its brands were approved, and not whether it has a published listing:
 * those are catalogue decisions about products, and a business can be perfectly
 * approved with nothing live yet. Getting that wrong in the other direction is
 * worse - a SUSPENDED seller offered in a picker is a business the operator
 * stopped trading with, presented as though they had not.
 *
 * `APPROVED_SELLER` below is that rule, and every query here uses it rather
 * than spelling the conditions out again.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../infra/prisma.js';
import { classifyCoordinates, mapConfig, type MapConfig } from './location.service.js';

/**
 * The eligibility rule.
 *
 * Frozen and shared, so the autocomplete, the warehouse fetch and the combined
 * view cannot drift into three slightly different ideas of which sellers an
 * operator may pick - which is how a suspended business ends up reachable
 * through one screen and not another.
 */
const APPROVED_SELLER: Prisma.SellerAccountWhereInput = Object.freeze({
  status: 'APPROVED',
  archivedAt: null,
});

/**
 * How many suggestions the picker is ever handed.
 *
 * Short on purpose. A list of forty companies is not a recommendation, it is
 * the search results the operator was trying to avoid reading - and a picker
 * that returns everything is a picker somebody will eventually filter in the
 * browser.
 */
export const MAX_SELLER_SUGGESTIONS = 10;

/**
 * Below this, no search runs.
 *
 * One letter matches most of the marketplace, so the query costs a scan and
 * returns nothing useful. The panel says "keep typing" rather than showing a
 * spinner over a list that was never going to help.
 */
export const MIN_SEARCH_LENGTH = 2;

/**
 * The ceiling on one warehouse answer.
 *
 * A cap rather than a page size, and deliberately so: the map and the table
 * show the SAME rows, and a map that plots page one of four is a map that lies
 * about where a seller ships from. So the answer is complete up to this many
 * and says `isTruncated` when it is not - the same shape the company directory
 * uses, and for the same reason. One seller has a handful of locations; only
 * the combined view can approach this, and the screen tells the operator to
 * narrow it rather than silently showing the first five hundred as though they
 * were all of them.
 */
export const MAX_WAREHOUSE_ROWS = 500;

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------

export interface SellerSuggestion {
  sellerAccountId: string;
  /** The public shopfront name. What buyers see, and what the operator types. */
  displayName: string;
  /** The registered business name. Two sellers can legitimately share one. */
  legalName: string;
  /**
   * The seller's stable public identifier.
   *
   * `slug` rather than a column called "code", because this schema has no
   * seller code: the slug is the unique, immutable-in-practice handle the
   * public seller page is addressed by, and it is what an operator quoting a
   * seller in a ticket actually writes down.
   */
  sellerCode: string;
  registrationCountry: string;
  /** Always `APPROVED` here. Carried so the row can say so rather than imply it. */
  status: string;
  /** Places this seller dispatches from and has not closed or archived. */
  activeWarehouseCount: number;
}

export interface SellerSearchResult {
  sellers: SellerSuggestion[];
  /** More matched than were returned. The panel says "keep typing". */
  isTruncated: boolean;
}

/**
 * Approved sellers matching what the operator has typed.
 *
 * Matched against the public name, the registered name and the handle, which
 * are the three things somebody actually knows about a business. Deliberately
 * NOT against a contact's name or address: a company picker is not a way to
 * look people up, and widening it would make this endpoint a search over
 * personal data that the screen has no reason to offer.
 *
 * Ordering is by display name and then by id. The second key is not
 * decoration - two sellers can share a display name across an archive boundary
 * and an unstable order makes a keyboard-driven picker select a different row
 * on a re-render.
 */
export async function searchApprovedSellers(
  rawSearch: string,
  limit = MAX_SELLER_SUGGESTIONS,
): Promise<SellerSearchResult> {
  const search = rawSearch.trim();
  const take = Math.min(Math.max(limit, 1), MAX_SELLER_SUGGESTIONS);

  if (search.length < MIN_SEARCH_LENGTH) return { sellers: [], isTruncated: false };

  const where: Prisma.SellerAccountWhereInput = {
    AND: [
      APPROVED_SELLER,
      {
        OR: [
          { displayName: { contains: search } },
          { legalName: { contains: search } },
          { slug: { contains: search } },
        ],
      },
    ],
  };

  // One more than asked for, which is how "there are others" is known without
  // a second COUNT over the same predicate.
  const rows = await prisma.sellerAccount.findMany({
    where,
    orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
    take: take + 1,
    select: {
      id: true,
      displayName: true,
      legalName: true,
      slug: true,
      registrationCountry: true,
      status: true,
    },
  });

  const page = rows.slice(0, take);

  if (page.length === 0) return { sellers: [], isTruncated: false };

  /*
   * The warehouse counts, in one grouped query for the whole page.
   *
   * A count per row would be ten queries for a picker that fires on every
   * keystroke. `ix_seller_location_operational` leads on `sellerAccountId`, so
   * this is an index read per seller rather than a scan.
   */
  const counts = await prisma.sellerLocation.groupBy({
    by: ['sellerAccountId'],
    where: {
      sellerAccountId: { in: page.map((row) => row.id) },
      archivedAt: null,
      isOperational: true,
    },
    _count: { _all: true },
  });

  const byId = new Map(counts.map((row) => [row.sellerAccountId, row._count._all]));

  return {
    sellers: page.map((row) => ({
      sellerAccountId: row.id,
      displayName: row.displayName,
      legalName: row.legalName,
      sellerCode: row.slug,
      registrationCountry: row.registrationCountry,
      status: row.status,
      activeWarehouseCount: byId.get(row.id) ?? 0,
    })),
    isTruncated: rows.length > take,
  };
}

// ---------------------------------------------------------------------------
// The warehouses
// ---------------------------------------------------------------------------

/** Who owns a building on this screen. */
export type WarehouseOwnerType = 'PLATFORM' | 'SELLER';

export interface WarehouseStockSummary {
  /** Offers held here. */
  skuCount: number;
  onHandQty: number;
  reservedQty: number;
  /** Present and unsellable: damaged, quarantined, past its date. */
  quarantinedQty: number;
  /** At or below the seller's own reorder threshold, where they set one. */
  lowStockCount: number;
}

const EMPTY_STOCK: WarehouseStockSummary = Object.freeze({
  skuCount: 0,
  onHandQty: 0,
  reservedQty: 0,
  quarantinedQty: 0,
  lowStockCount: 0,
});

/**
 * One building, whoever owns it.
 *
 * A single shape for both kinds, because the map and the table draw both and a
 * screen with two row types is a screen with two of every column. What differs
 * is carried in `owner`, which is the field the table shows and the popup
 * names - so a combined view is readable rather than a list where an operator
 * has to guess whose warehouse each row is.
 */
export interface SellerWarehouseRow {
  id: string;
  code: string;
  name: string;

  owner: {
    type: WarehouseOwnerType;
    /** Null for the operator's own buildings - they have no seller behind them. */
    sellerAccountId: string | null;
    /** The deployment's own name for PLATFORM rows; the seller's for SELLER rows. */
    name: string;
    sellerCode: string | null;
  };

  addressLine1: string | null;
  city: string | null;
  postcode: string | null;
  countryCode: string | null;
  timezone: string | null;

  /**
   * Degrees, or null where the place has no usable position.
   *
   * Two different states, told apart by `coordinatesInvalid`: nothing was ever
   * recorded, or what was recorded cannot be plotted. Both come back with a
   * null pair so the map never has to defend itself, and the table shows the
   * row either way with a warning - a warehouse nobody has geocoded is still a
   * warehouse holding stock.
   */
  latitude: number | null;
  longitude: number | null;
  coordinatesInvalid: boolean;

  /**
   * Can it ship today?
   *
   * Mapped from the seller's `isOperational` onto the same vocabulary the
   * operator's own warehouses use, so one column reads consistently down a
   * combined list. A seller location carries a closed/open boolean rather than
   * the operator's four-way status, so it resolves to OPERATIONAL or SUSPENDED
   * and never invents the two states in between.
   */
  operationalStatus: 'OPERATIONAL' | 'LIMITED' | 'MAINTENANCE' | 'SUSPENDED';
  /** Whether the place is part of the business at all. Archived means no. */
  isActive: boolean;
  /** The seller's own reason for closing it, where they gave one. */
  closedReason: string | null;

  isPickupLocation: boolean;
  isReturnLocation: boolean;
  hasColdChain: boolean;
  hasControlledStorage: boolean;
  hasSterileStorage: boolean;

  stock: WarehouseStockSummary;

  /**
   * When this place's stock last agreed with the seller's own ERP.
   *
   * The most recent `erpSyncedAt` across its balances, which is the only thing
   * a seller location records about syncing - there is no per-location sync
   * state on it the way there is on `inventory_locations`. Null means nothing
   * here has ever been synced, which is the ordinary case for a seller with no
   * ERP connected and is not an error.
   *
   * **No credential, endpoint or connection detail is carried.** Those belong
   * to the seller and appear on no operator screen.
   */
  erpLastSyncAt: string | null;
}

export interface SellerWarehouseResult {
  warehouses: SellerWarehouseRow[];
  /** More matched than the cap allowed. Narrow the view. */
  isTruncated: boolean;
  /** What to draw them on. Carried here so the screen fills in one response. */
  map: MapConfig;
  /** Present when one seller was asked for, so the screen can name them. */
  seller: SellerSuggestion | null;
}

export interface SellerWarehouseFilters {
  /** One seller, or null for every approved seller's places. */
  sellerAccountId?: string | null;
  /** Matched against the place's name, code and city. */
  search?: string | null;
  countryCode?: string | null;
  /** Closed and archived places are excluded unless this is true. */
  includeClosed?: boolean;
}

/**
 * The stock roll-up, per location, for the locations in hand.
 *
 * Grouped in one query rather than counted per row. `groupBy` cannot express
 * "how many are below their own threshold" - that compares two columns - so
 * the low-stock count is a second, narrow query rather than a join this would
 * have had to grow a raw SQL escape hatch for.
 */
async function stockByLocation(
  locationIds: readonly string[],
): Promise<Map<string, WarehouseStockSummary>> {
  if (locationIds.length === 0) return new Map();

  const ids = [...locationIds];

  const [totals, lowStock] = await Promise.all([
    prisma.sellerInventory.groupBy({
      by: ['locationId'],
      where: { locationId: { in: ids } },
      _count: { _all: true },
      _sum: { availableQuantity: true, reservedQuantity: true, quarantinedQuantity: true },
    }),
    /*
     * Below the seller's own threshold.
     *
     * `reorderThreshold: 0` means "no alert on this line", not "alert at zero",
     * so those rows are excluded rather than counted as permanently low - which
     * would make the column read as an alarm on every seller who never set one.
     * The comparison itself is a column-to-column test Prisma cannot express in
     * a filter, so the candidates are read and compared here; the `gt: 0` is
     * what keeps that set small.
     */
    prisma.sellerInventory.findMany({
      where: { locationId: { in: ids }, reorderThreshold: { gt: 0 } },
      select: { locationId: true, availableQuantity: true, reorderThreshold: true },
    }),
  ]);

  const lowByLocation = new Map<string, number>();
  for (const row of lowStock) {
    if (row.availableQuantity > row.reorderThreshold) continue;
    lowByLocation.set(row.locationId, (lowByLocation.get(row.locationId) ?? 0) + 1);
  }

  return new Map(
    totals.map((row) => [
      row.locationId,
      {
        skuCount: row._count._all,
        onHandQty: row._sum.availableQuantity ?? 0,
        reservedQty: row._sum.reservedQuantity ?? 0,
        quarantinedQty: row._sum.quarantinedQuantity ?? 0,
        lowStockCount: lowByLocation.get(row.locationId) ?? 0,
      },
    ]),
  );
}

/** The newest ERP sync time per location, or nothing where none exists. */
async function erpSyncByLocation(
  locationIds: readonly string[],
): Promise<Map<string, Date>> {
  if (locationIds.length === 0) return new Map();

  const rows = await prisma.sellerInventory.groupBy({
    by: ['locationId'],
    where: { locationId: { in: [...locationIds] }, erpSyncedAt: { not: null } },
    _max: { erpSyncedAt: true },
  });

  const map = new Map<string, Date>();
  for (const row of rows) {
    if (row._max.erpSyncedAt !== null) map.set(row.locationId, row._max.erpSyncedAt);
  }
  return map;
}

/**
 * Seller warehouses, for the operator's map and table.
 *
 * **Tenant scoping is not optional and is not the caller's to supply.** The
 * seller filter is always intersected with `APPROVED_SELLER`, so asking for a
 * suspended, rejected, draft or archived seller's locations by id returns
 * nothing rather than returning their warehouses - which is the difference
 * between a picker that hides ineligible businesses and an API that does.
 */
export async function listSellerWarehouses(
  filters: SellerWarehouseFilters = {},
): Promise<SellerWarehouseResult> {
  const search = (filters.search ?? '').trim();

  const where: Prisma.SellerLocationWhereInput = {
    AND: [
      // The ownership gate. Written as a relation filter rather than as a
      // pre-resolved list of seller ids, so there is no window between
      // resolving the ids and reading the rows in which a seller could be
      // suspended and still answer.
      { sellerAccount: APPROVED_SELLER },
      ...(filters.sellerAccountId === undefined || filters.sellerAccountId === null
        ? []
        : [{ sellerAccountId: filters.sellerAccountId }]),
      ...(filters.includeClosed === true ? [] : [{ archivedAt: null, isOperational: true }]),
      // Archived places never come back, whatever `includeClosed` says. A
      // seller archives a location to take it out of the record; showing it on
      // an operator's map would put a building back that the owner removed.
      { archivedAt: null },
      ...(filters.countryCode === undefined || filters.countryCode === null
        ? []
        : [{ countryCode: filters.countryCode }]),
      ...(search.length === 0
        ? []
        : [
            {
              OR: [
                { name: { contains: search } },
                { code: { contains: search } },
                { city: { contains: search } },
              ],
            },
          ]),
    ],
  };

  const rows = await prisma.sellerLocation.findMany({
    where,
    // Open places first, then by seller, then by the seller's own code - so a
    // combined view groups a company's buildings together and a closed one
    // never sits above a working one.
    orderBy: [
      { isOperational: 'desc' },
      { sellerAccountId: 'asc' },
      { code: 'asc' },
      { id: 'asc' },
    ],
    take: MAX_WAREHOUSE_ROWS + 1,
    select: {
      id: true,
      code: true,
      name: true,
      sellerAccountId: true,
      addressLine1: true,
      city: true,
      postcode: true,
      countryCode: true,
      timezone: true,
      latitude: true,
      longitude: true,
      isOperational: true,
      closedReason: true,
      isPickupLocation: true,
      isReturnLocation: true,
      hasColdChain: true,
      hasControlledStorage: true,
      hasSterileStorage: true,
      // The owner, joined rather than looked up per row - which is the N+1 this
      // screen would otherwise have one of per warehouse.
      sellerAccount: { select: { displayName: true, slug: true } },
    },
  });

  const page = rows.slice(0, MAX_WAREHOUSE_ROWS);
  const ids = page.map((row) => row.id);

  const [stock, erp, seller] = await Promise.all([
    stockByLocation(ids),
    erpSyncByLocation(ids),
    filters.sellerAccountId === undefined || filters.sellerAccountId === null
      ? Promise.resolve(null)
      : readApprovedSeller(filters.sellerAccountId),
  ]);

  return {
    warehouses: page.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      owner: {
        type: 'SELLER' as const,
        sellerAccountId: row.sellerAccountId,
        name: row.sellerAccount.displayName,
        sellerCode: row.sellerAccount.slug,
      },
      addressLine1: row.addressLine1,
      city: row.city,
      postcode: row.postcode,
      countryCode: row.countryCode,
      timezone: row.timezone,
      ...classifyCoordinates(row),
      operationalStatus: row.isOperational ? ('OPERATIONAL' as const) : ('SUSPENDED' as const),
      isActive: true,
      closedReason: row.closedReason,
      isPickupLocation: row.isPickupLocation,
      isReturnLocation: row.isReturnLocation,
      hasColdChain: row.hasColdChain,
      hasControlledStorage: row.hasControlledStorage,
      hasSterileStorage: row.hasSterileStorage,
      stock: stock.get(row.id) ?? EMPTY_STOCK,
      erpLastSyncAt: erp.get(row.id)?.toISOString() ?? null,
    })),
    isTruncated: rows.length > MAX_WAREHOUSE_ROWS,
    map: mapConfig(),
    seller,
  };
}

/**
 * One seller, if the operator may pick them.
 *
 * Returns null rather than throwing for a seller that exists but is not
 * approved: the screen's answer to "that company is not available" and to
 * "there is no such company" is the same sentence, and distinguishing them
 * here would let the endpoint confirm that a rejected application exists.
 */
export async function readApprovedSeller(
  sellerAccountId: string,
): Promise<SellerSuggestion | null> {
  const row = await prisma.sellerAccount.findFirst({
    where: { AND: [APPROVED_SELLER, { id: sellerAccountId }] },
    select: {
      id: true,
      displayName: true,
      legalName: true,
      slug: true,
      registrationCountry: true,
      status: true,
      _count: { select: { locations: { where: { archivedAt: null, isOperational: true } } } },
    },
  });

  if (row === null) return null;

  return {
    sellerAccountId: row.id,
    displayName: row.displayName,
    legalName: row.legalName,
    sellerCode: row.slug,
    registrationCountry: row.registrationCountry,
    status: row.status,
    activeWarehouseCount: row._count.locations,
  };
}
