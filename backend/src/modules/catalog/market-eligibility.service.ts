/**
 * Which products may be offered to a shopper in a given destination country.
 *
 * The operator records a `market_rules` row for anything that may not be sold
 * into a country (`BLOCK`) or may be sold only to a buyer holding named
 * documents (`DOCUMENTS_REQUIRED`). A rule names a product, or a category -
 * and a category rule covers everything filed beneath it, because a buyer
 * browsing "Chemicals" in a country that restricts chemicals must not find
 * them one level down.
 *
 * This file answers the listing's question: "what must I leave out for this
 * destination?" Leaving a blocked product in the grid and refusing it at the
 * cart is the worst of both - the shopper is shown something they were never
 * able to buy. So a blocked product is absent from the grid, from search and
 * from every facet count, for that destination only.
 *
 * NO DESTINATION, NO RULE
 *
 * A shopper who has not said where they are gets the unfiltered catalogue.
 * Guessing a country to apply rules for would hide goods from somebody the
 * rule was never about; the destination is asked for again at checkout, where
 * it is certain.
 *
 * A rule is in force from `effectiveFrom`, until `effectiveUntil` (exclusive),
 * and only while `isActive`.
 */
import type { MarketRuleEffect, Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../infra/prisma.js';
import { subtreeCategoryIds } from './category.service.js';

/** The rules for one destination that are in force right now. */
function inForce(country: string, effect: MarketRuleEffect, now: Date): Prisma.MarketRuleWhereInput {
  return {
    countryCode: country,
    effect,
    isActive: true,
    effectiveFrom: { lte: now },
    OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
  };
}

export interface BlockedScope {
  productIds: string[];
  /** Every blocked category AND everything beneath it. */
  categoryIds: string[];
}

export async function blockedScopeFor(
  country: string | null,
  now: Date = new Date(),
): Promise<BlockedScope> {
  if (country === null) return { productIds: [], categoryIds: [] };

  const rules = await prisma.marketRule.findMany({
    where: inForce(country, 'BLOCK', now),
    select: { scope: true, productId: true, categoryId: true },
  });

  const productIds = rules
    .filter((rule) => rule.scope === 'PRODUCT' && rule.productId !== null)
    .map((rule) => rule.productId as string);
  const roots = [
    ...new Set(
      rules
        .filter((rule) => rule.scope === 'CATEGORY' && rule.categoryId !== null)
        .map((rule) => rule.categoryId as string),
    ),
  ];
  const categoryIds = [...new Set((await Promise.all(roots.map((id) => subtreeCategoryIds(id)))).flat())];

  return { productIds: [...new Set(productIds)], categoryIds };
}

/**
 * The condition that keeps blocked products out of a listing, or null when
 * nothing is blocked for this destination (so the query is unchanged).
 */
export async function marketEligibleWhere(
  country: string | null,
  now: Date = new Date(),
): Promise<Prisma.ProductWhereInput | null> {
  const scope = await blockedScopeFor(country, now);
  const excluded: Prisma.ProductWhereInput[] = [];
  if (scope.productIds.length > 0) excluded.push({ id: { in: scope.productIds } });
  if (scope.categoryIds.length > 0) excluded.push({ categoryId: { in: scope.categoryIds } });
  return excluded.length === 0 ? null : { NOT: { OR: excluded } };
}
