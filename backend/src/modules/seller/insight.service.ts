/**
 * One seller, as the marketplace's own staff need to see it.
 *
 * The Companies screen could already say that a seller, four buying accounts
 * and a carrier were one business. What it could not say was how that business
 * is doing, or where its goods actually are — so an operator answering "should
 * we give these people more volume?" or "who is near enough to collect this?"
 * left the console and asked somebody.
 *
 * TWO THINGS THIS IS NOT
 *
 * **It is not the seller's own dashboard.** `dashboard.service.ts` answers a
 * seller's question — what do I have to do today — and it takes a
 * `SellerMembership` because the seller API never accepts a seller id from its
 * caller. This answers the marketplace's question, from the admin API, where
 * reading across every seller is the whole job and the permission model is the
 * console's own. Sharing one function between the two would mean either
 * forging a membership or letting the seller API take an id, and both of those
 * are how one seller ends up reading another seller's orders.
 *
 * **It never writes.** Same rule as the Companies screen it feeds.
 *
 * MONEY
 *
 * Minor units, as `BigInt`, summed per currency and crossing the API as a
 * string. A seller trading in two currencies gets two rows rather than one
 * meaningless total, because adding rupees to euros produces a number that is
 * wrong in both.
 */
import { prisma } from '../../infra/prisma.js';
import { notFound } from '../../domain/errors.js';
import { mapConfig, type MapConfig } from '../inventory/location.service.js';

export interface SellerInsightMoney {
  currency: string;
  /** Minor units. A string because it is a `BigInt` and JSON has no such thing. */
  amountMinor: string;
}

export interface SellerInsightLocation {
  id: string;
  code: string;
  name: string;
  addressLine1: string;
  city: string;
  postcode: string;
  countryCode: string;
  /**
   * Null when nobody has placed it.
   *
   * Never 0,0 — the API refuses those coordinates, because they are a real
   * point in the Gulf of Guinea and several systems have shipped to it. The
   * screen says "not placed" rather than drawing a pin in the Atlantic.
   */
  latitude: number | null;
  longitude: number | null;
  timezone: string;
  isPickupLocation: boolean;
  isReturnLocation: boolean;
  hasColdChain: boolean;
  isOperational: boolean;
}

export interface SellerInsight {
  sellerAccountId: string;
  displayName: string;
  legalName: string;

  catalogue: {
    live: number;
    paused: number;
    needsChanges: number;
    inReview: number;
    drafts: number;
  };

  trade: {
    ordersTotal: number;
    ordersLast30Days: number;
    /** Null when nothing has ever been ordered — which is not a date of zero. */
    lastOrderAt: string | null;
    grossSales: SellerInsightMoney[];
    sellerNet: SellerInsightMoney[];
  };

  stock: {
    unitsAvailable: number;
    outOfStockOffers: number;
    /** Places that keep their history and their balances but sell none of it. */
    closedLocations: number;
  };

  locations: SellerInsightLocation[];

  /**
   * What the operator configured the map to draw with.
   *
   * Carried here rather than fetched separately, because the alternative is
   * making the Companies screen call the warehouses endpoint for one field —
   * which would also mean an operator needed permission over the marketplace's
   * own stock to see where a seller ships from. It is a pure function of the
   * deployment's settings and costs nothing.
   */
  map: MapConfig;

  /**
   * How many places carry coordinates.
   *
   * On the screen beside the map, so "one pin" on a seller with four
   * warehouses reads as three unplaced addresses rather than as three
   * warehouses that do not exist.
   */
  placedLocations: number;
}

/** A Prisma `Decimal` column to a number, or null when it was never set. */
function coordinate(value: unknown): number | null {
  if (value === null || value === undefined) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function money(
  rows: { currency: string; _sum: { goodsTotalMinor: bigint | null; sellerNetMinor: bigint | null } }[],
  field: 'goodsTotalMinor' | 'sellerNetMinor',
): SellerInsightMoney[] {
  return rows
    .map((row) => ({ currency: row.currency, amountMinor: (row._sum[field] ?? 0n).toString() }))
    .filter((row) => row.amountMinor !== '0')
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export async function readSellerInsight(sellerAccountId: string): Promise<SellerInsight> {
  const account = await prisma.sellerAccount.findUnique({
    where: { id: sellerAccountId },
    select: { id: true, displayName: true, legalName: true },
  });

  if (account === null) throw notFound('Seller account');

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);

  const [offers, drafts, ordersTotal, ordersLast30, lastOrder, sales, stock, outOfStock, closed, locations] =
    await Promise.all([
      prisma.sellerOffer.groupBy({
        by: ['status'],
        where: { sellerAccountId, archivedAt: null },
        _count: { _all: true },
      }),

      prisma.sellerListingDraft.count({
        where: { sellerAccountId, status: { in: ['DRAFT', 'VALIDATION_FAILED', 'READY_FOR_SUBMISSION'] } },
      }),

      prisma.sellerOrderGroup.count({ where: { sellerAccountId } }),

      prisma.sellerOrderGroup.count({
        where: { sellerAccountId, createdAt: { gte: thirtyDaysAgo } },
      }),

      prisma.sellerOrderGroup.findFirst({
        where: { sellerAccountId },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),

      prisma.sellerOrderGroup.groupBy({
        by: ['currency'],
        where: {
          sellerAccountId,
          // A rejected order is not a sale. The seller's own dashboard draws
          // the same line, and two screens disagreeing about what was sold is
          // how a settlement conversation starts.
          status: { notIn: ['CANCELLED'] },
        },
        _sum: { goodsTotalMinor: true, sellerNetMinor: true },
      }),

      prisma.sellerInventory.aggregate({
        where: { sellerAccountId },
        _sum: { availableQuantity: true },
      }),

      prisma.sellerOffer.count({
        where: { sellerAccountId, archivedAt: null, status: 'ACTIVE', availableQuantity: { lte: 0 } },
      }),

      prisma.sellerLocation.count({
        where: { sellerAccountId, archivedAt: null, isOperational: false },
      }),

      prisma.sellerLocation.findMany({
        where: { sellerAccountId, archivedAt: null },
        orderBy: [{ isOperational: 'desc' }, { code: 'asc' }],
        select: {
          id: true,
          code: true,
          name: true,
          addressLine1: true,
          city: true,
          postcode: true,
          countryCode: true,
          latitude: true,
          longitude: true,
          timezone: true,
          isPickupLocation: true,
          isReturnLocation: true,
          hasColdChain: true,
          isOperational: true,
        },
      }),
    ]);

  const byStatus = new Map(offers.map((row) => [String(row.status), row._count._all]));

  const placedLocations = locations.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    addressLine1: row.addressLine1,
    city: row.city,
    postcode: row.postcode,
    countryCode: row.countryCode,
    latitude: coordinate(row.latitude),
    longitude: coordinate(row.longitude),
    timezone: row.timezone,
    isPickupLocation: row.isPickupLocation,
    isReturnLocation: row.isReturnLocation,
    hasColdChain: row.hasColdChain,
    isOperational: row.isOperational,
  }));

  return {
    sellerAccountId: account.id,
    displayName: account.displayName,
    legalName: account.legalName,

    catalogue: {
      live: byStatus.get('ACTIVE') ?? 0,
      paused: byStatus.get('PAUSED') ?? 0,
      needsChanges: byStatus.get('NEEDS_CHANGES') ?? 0,
      inReview: await prisma.sellerListingDraft.count({
        where: { sellerAccountId, status: 'PENDING_REVIEW' },
      }),
      drafts,
    },

    trade: {
      ordersTotal,
      ordersLast30Days: ordersLast30,
      lastOrderAt: lastOrder?.createdAt.toISOString() ?? null,
      grossSales: money(sales, 'goodsTotalMinor'),
      sellerNet: money(sales, 'sellerNetMinor'),
    },

    stock: {
      unitsAvailable: stock._sum.availableQuantity ?? 0,
      outOfStockOffers: outOfStock,
      closedLocations: closed,
    },

    locations: placedLocations,
    map: mapConfig(),
    placedLocations: placedLocations.filter(
      (row) => row.latitude !== null && row.longitude !== null,
    ).length,
  };
}
