/**
 * The public list of verified suppliers.
 *
 * What the storefront's home page shows under "Verified suppliers", and the
 * name a catalogue filtered to one supplier puts at the top of the grid.
 *
 * "VERIFIED" MEANS ONE THING HERE, AND IT IS A FACT THE SYSTEM HOLDS
 *
 * A seller is listed only when the marketplace operator has reviewed their
 * application and approved it (`SellerAccount.status = APPROVED`). Nothing
 * else reaches that state: `domain/seller-state.ts` lets only the OPERATOR
 * move an application to APPROVED, so the word on the page is exactly as true
 * as the operator's own review. Suspended, rejected, archived and unfinished
 * applications are never listed, and neither is a seller with nothing to
 * sell — a supplier card that opens an empty catalogue is a broken promise.
 *
 * Nothing here claims more than that. No rating, no "top supplier", no count
 * of buyers: those would be claims this deployment may not be able to keep.
 *
 * ON A SELLER'S OWN SHOP FRONT THERE IS NO LIST
 *
 * A seller's subdomain is that seller's shop. Advertising the other sellers on
 * it would send their customers to competitors, so the route answers an empty
 * list there instead of asking this module.
 */
import type { Prisma, SellerKind } from '../../generated/prisma/client.js';
import { prisma } from '../../infra/prisma.js';
import { publicProductWhere } from './catalog.visibility.js';
import { logoUrlFor } from '../seller/logo.service.js';

/** The most suppliers one answer may carry. It is an unauthenticated read. */
export const MAX_SUPPLIERS = 24;

export interface VerifiedSupplier {
  slug: string;
  displayName: string;
  kind: SellerKind;
  /** ISO 3166-1 alpha-2, as the seller registered it. */
  registrationCountry: string;
  /**
   * When the operator approved them, as ISO 8601. Null for an account approved
   * before the date was recorded — the screen then says "verified" without a
   * date rather than inventing one.
   */
  verifiedAt: string | null;
  /** Public products this supplier has a live offer on. */
  productCount: number;
  logoUrl: string | null;
}

export interface SupplierListQuery {
  limit: number;
  /** Only suppliers registered in this country. */
  country?: string | undefined;
  /** Exactly one supplier, by slug — what a filtered catalogue asks for. */
  slug?: string | undefined;
  /** Words in the public name — what a search shows beside its products. */
  q?: string | undefined;
}

export interface SupplierListResult {
  suppliers: VerifiedSupplier[];
  /**
   * Every verified supplier's country, with how many there are, whatever the
   * `limit`. The home page uses it to say "from India" only when that is true
   * of every supplier listed, not merely of the first eight.
   */
  countries: { country: string; count: number }[];
  total: number;
}

/**
 * An offer that makes a supplier worth listing: live, not archived, and on a
 * product the public catalogue actually shows.
 */
function liveOfferWhere(): Prisma.SellerOfferWhereInput {
  return { status: 'ACTIVE', archivedAt: null, product: publicProductWhere() };
}

/** The one definition of a listed supplier. */
export function verifiedSupplierWhere(): Prisma.SellerAccountWhereInput {
  return {
    status: 'APPROVED',
    archivedAt: null,
    suspendedAt: null,
    offers: { some: liveOfferWhere() },
  };
}

export async function listVerifiedSuppliers(
  query: SupplierListQuery,
): Promise<SupplierListResult> {
  const base = verifiedSupplierWhere();
  const where: Prisma.SellerAccountWhereInput = {
    ...base,
    ...(query.country === undefined ? {} : { registrationCountry: query.country }),
    ...(query.slug === undefined ? {} : { slug: query.slug }),
    ...(query.q === undefined || query.q === '' ? {} : { displayName: { contains: query.q } }),
  };

  const [rows, total, byCountry] = await Promise.all([
    prisma.sellerAccount.findMany({
      where,
      select: {
        id: true,
        slug: true,
        displayName: true,
        kind: true,
        registrationCountry: true,
        approvedAt: true,
        logoStorageKey: true,
      },
      // Longest-verified first, then by name, so the order is stable between
      // two visits and never depends on which row the database found first.
      orderBy: [{ approvedAt: 'asc' }, { displayName: 'asc' }, { id: 'asc' }],
      take: Math.min(Math.max(query.limit, 1), MAX_SUPPLIERS),
    }),
    prisma.sellerAccount.count({ where }),
    prisma.sellerAccount.groupBy({
      by: ['registrationCountry'],
      where: base,
      _count: { _all: true },
    }),
  ]);

  // One grouped read for every listed supplier's product count, rather than a
  // count per card. Distinct products, not offers: a supplier with three
  // sizes of one glove sells one product.
  const offers =
    rows.length === 0
      ? []
      : await prisma.sellerOffer.findMany({
          where: { ...liveOfferWhere(), sellerAccountId: { in: rows.map((row) => row.id) } },
          select: { sellerAccountId: true, productId: true },
          distinct: ['sellerAccountId', 'productId'],
        });
  const counts = new Map<string, number>();
  for (const offer of offers) {
    counts.set(offer.sellerAccountId, (counts.get(offer.sellerAccountId) ?? 0) + 1);
  }

  return {
    suppliers: rows.map((row) => ({
      slug: row.slug,
      displayName: row.displayName,
      kind: row.kind,
      registrationCountry: row.registrationCountry,
      verifiedAt: row.approvedAt?.toISOString() ?? null,
      productCount: counts.get(row.id) ?? 0,
      logoUrl: logoUrlFor(row.logoStorageKey),
    })),
    countries: byCountry
      .map((group) => ({ country: group.registrationCountry, count: group._count._all }))
      .sort((a, b) => b.count - a.count || a.country.localeCompare(b.country)),
    total,
  };
}

/**
 * The catalogue filter for "products this supplier sells".
 *
 * The same live-offer rule the list uses, and the same verified-supplier rule,
 * so a suspended supplier's old link shows an empty grid rather than products
 * nobody can buy from them.
 */
export function suppliedByWhere(slug: string): Prisma.ProductWhereInput {
  return {
    sellerOffers: {
      some: {
        status: 'ACTIVE',
        archivedAt: null,
        sellerAccount: { slug, status: 'APPROVED', archivedAt: null, suspendedAt: null },
      },
    },
  };
}
