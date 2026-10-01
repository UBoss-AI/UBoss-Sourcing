/**
 * Which sellers a request for quotation is sent to.
 *
 * A seller MATCHES a request when all of these are true, and nothing else is
 * considered:
 *
 *   1. The marketplace approved them to trade (`status = APPROVED`). A
 *      suspended, pending or refused seller is never asked.
 *   2. They have a live offer on a public product filed in the request's
 *      category or anywhere beneath it - the same shelf a buyer browsing that
 *      category would see.
 *   3. That product may be sold into the destination: a product or category
 *      blocked there by a market rule does not count (`market-eligibility`).
 *   4. They are not the buyer's own business. Nobody is asked to quote to
 *      themselves.
 *
 * NEVER PRETEND A MATCH
 *
 * When nothing matches, the answer is an empty list and the outcome says so.
 * The request can still go to sellers the buyer picks by name, and the
 * buyer's screen says that it was hand-picked rather than matched. When the
 * CATEGORY itself is blocked for the destination, the outcome is BLOCKED and
 * submission is refused: no seller may be asked to sell into a market the
 * operator has closed to that category.
 */
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import { publicProductWhere } from '../catalog/catalog.visibility.js';
import { subtreeCategoryIds } from '../catalog/category.service.js';
import {
  categoryMarketNotes,
  marketEligibleWhere,
} from '../catalog/market-eligibility.service.js';

export interface SupplierCard {
  sellerAccountId: string;
  displayName: string;
  slug: string;
  registrationCountry: string;
  /** When the marketplace approved them. Null for accounts approved before it was recorded. */
  verifiedAt: string | null;
  /** They have a live offer in this category that may be sold into the destination. */
  matchesCategory: boolean;
}

export type MatchOutcome = 'MATCHED' | 'NO_MATCH' | 'BLOCKED' | 'INCOMPLETE';

export interface MatchResult {
  outcome: MatchOutcome;
  suppliers: SupplierCard[];
  /** The operator's sentence when the category is blocked for the destination. */
  blockedReason: string | null;
}

const CARD_SELECT = {
  id: true,
  displayName: true,
  slug: true,
  registrationCountry: true,
  approvedAt: true,
} as const;

function card(
  row: { id: string; displayName: string; slug: string; registrationCountry: string; approvedAt: Date | null },
  matchesCategory: boolean,
): SupplierCard {
  return {
    sellerAccountId: row.id,
    displayName: row.displayName,
    slug: row.slug,
    registrationCountry: row.registrationCountry,
    verifiedAt: row.approvedAt?.toISOString() ?? null,
    matchesCategory,
  };
}

/** The seller accounts this person works for. Never invited on their own request. */
async function ownSellerIds(customerProfileId: string): Promise<string[]> {
  const rows = await prisma.sellerMember.findMany({
    where: { customerProfileId, removedAt: null },
    select: { sellerAccountId: true },
  });
  return rows.map((row) => row.sellerAccountId);
}

/** Whether a market rule closes this category (or one above it) to the destination. */
export async function categoryBlockedFor(
  categoryId: string,
  destinationCountry: string,
): Promise<string | null> {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true, path: true },
  });
  if (category === null) return null;
  const notes = await categoryMarketNotes(destinationCountry, category);
  const block = notes.find((note) => note.effect === 'BLOCK' && note.minOrderValueMinor === null);
  return block === undefined ? null : block.reason;
}

/** The ids of sellers that match, in a stable order, capped by the setting. */
async function matchingSellerIds(
  categoryId: string,
  destinationCountry: string,
  exclude: readonly string[],
): Promise<string[]> {
  const subtree = await subtreeCategoryIds(categoryId);
  if (subtree.length === 0) return [];
  const eligible = await marketEligibleWhere(destinationCountry);

  const offers = await prisma.sellerOffer.findMany({
    where: {
      status: 'ACTIVE',
      sellerAccountId: exclude.length > 0 ? { notIn: [...exclude] } : undefined,
      sellerAccount: { status: 'APPROVED', archivedAt: null },
      product: {
        AND: [publicProductWhere(), { categoryId: { in: subtree } }, ...(eligible === null ? [] : [eligible])],
      },
    },
    select: { sellerAccountId: true },
    distinct: ['sellerAccountId'],
    orderBy: { sellerAccountId: 'asc' },
    take: env.RFQ_MAX_MATCHED_SUPPLIERS,
  });
  return offers.map((offer) => offer.sellerAccountId);
}

/** Who a request with this category and destination would be sent to. */
export async function matchSuppliers(input: {
  categoryId: string | null;
  destinationCountry: string | null;
  customerProfileId: string;
}): Promise<MatchResult> {
  if (input.categoryId === null || input.destinationCountry === null) {
    return { outcome: 'INCOMPLETE', suppliers: [], blockedReason: null };
  }

  const blockedReason = await categoryBlockedFor(input.categoryId, input.destinationCountry);
  if (blockedReason !== null) return { outcome: 'BLOCKED', suppliers: [], blockedReason };

  const ids = await matchingSellerIds(
    input.categoryId,
    input.destinationCountry,
    await ownSellerIds(input.customerProfileId),
  );
  if (ids.length === 0) return { outcome: 'NO_MATCH', suppliers: [], blockedReason: null };

  const rows = await prisma.sellerAccount.findMany({
    where: { id: { in: ids } },
    select: CARD_SELECT,
    orderBy: { displayName: 'asc' },
  });
  return { outcome: 'MATCHED', suppliers: rows.map((row) => card(row, true)), blockedReason: null };
}

/**
 * Sellers a buyer may pick by name: approved to trade, not their own, whose
 * public name contains the words typed. Says for each whether it would also
 * have matched, so the screen can say "not usually in this category".
 */
export async function searchSuppliers(input: {
  q: string;
  categoryId: string | null;
  destinationCountry: string | null;
  customerProfileId: string;
}): Promise<SupplierCard[]> {
  const own = await ownSellerIds(input.customerProfileId);
  const rows = await prisma.sellerAccount.findMany({
    where: {
      status: 'APPROVED',
      archivedAt: null,
      ...(own.length > 0 ? { id: { notIn: own } } : {}),
      ...(input.q.length > 0 ? { displayName: { contains: input.q } } : {}),
    },
    select: CARD_SELECT,
    orderBy: { displayName: 'asc' },
    take: 20,
  });

  const matching =
    input.categoryId === null || input.destinationCountry === null
      ? new Set<string>()
      : new Set(await matchingSellerIds(input.categoryId, input.destinationCountry, own));
  return rows.map((row) => card(row, matching.has(row.id)));
}

/**
 * The sellers of `ids` that may be invited by hand: approved to trade and not
 * the buyer's own. Returns the ones that may, and the ones refused.
 */
export async function eligibleForInvitation(
  ids: readonly string[],
  customerProfileId: string,
): Promise<{ eligible: string[]; refused: string[] }> {
  if (ids.length === 0) return { eligible: [], refused: [] };
  const own = new Set(await ownSellerIds(customerProfileId));
  const rows = await prisma.sellerAccount.findMany({
    where: { id: { in: [...ids] }, status: 'APPROVED', archivedAt: null },
    select: { id: true },
  });
  const approved = new Set(rows.map((row) => row.id));
  const eligible = ids.filter((id) => approved.has(id) && !own.has(id));
  return { eligible, refused: ids.filter((id) => !eligible.includes(id)) };
}

/** Cards for a set of seller ids, in name order. */
export async function supplierCards(
  ids: readonly string[],
  matched: ReadonlySet<string>,
): Promise<SupplierCard[]> {
  if (ids.length === 0) return [];
  const rows = await prisma.sellerAccount.findMany({
    where: { id: { in: [...ids] } },
    select: CARD_SELECT,
    orderBy: { displayName: 'asc' },
  });
  return rows.map((row) => card(row, matched.has(row.id)));
}
