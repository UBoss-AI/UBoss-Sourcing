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

/** A rule a buyer is told about on a category page. */
export interface CategoryMarketNote {
  effect: MarketRuleEffect;
  /** The operator's sentence, shown as written. */
  reason: string;
  /** Documents the buyer must hold, for DOCUMENTS_REQUIRED. */
  requiredDocuments: string[];
  /** The category the rule was written on - this one, or one above it. */
  categoryName: string;
}

/**
 * The rules in force for a category page, for one destination.
 *
 * A rule on a category above this one applies here too, exactly as it does in
 * the listing, so the page says why a shelf is empty rather than leaving the
 * buyer to guess. `path` is the stored `/rootId/parentId/` of the category.
 */
export async function categoryMarketNotes(
  country: string | null,
  category: { id: string; path: string },
  now: Date = new Date(),
): Promise<CategoryMarketNote[]> {
  if (country === null) return [];
  const lineage = [...category.path.split('/').filter((part) => part.length > 0), category.id];

  const rules = await prisma.marketRule.findMany({
    where: {
      countryCode: country,
      isActive: true,
      scope: 'CATEGORY',
      categoryId: { in: lineage },
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
    },
    select: {
      effect: true,
      reason: true,
      requiredDocumentsJson: true,
      category: { select: { name: true } },
    },
    // Blocks first: they are the answer to "why is this empty".
    orderBy: [{ effect: 'asc' }, { createdAt: 'asc' }],
  });

  return rules.map((rule) => ({
    effect: rule.effect,
    reason: rule.reason,
    requiredDocuments: Array.isArray(rule.requiredDocumentsJson)
      ? rule.requiredDocumentsJson.filter((entry): entry is string => typeof entry === 'string')
      : [],
    categoryName: rule.category?.name ?? '',
  }));
}

/**
 * The rules in force for one product page: rules on the product itself plus
 * every rule on its category and the categories above it - the same set the
 * listing applies, so a product missing from the grid for a country explains
 * itself when its page is opened directly.
 */
export async function productMarketNotes(
  country: string | null,
  product: { id: string; categoryId: string },
  now: Date = new Date(),
): Promise<CategoryMarketNote[]> {
  if (country === null) return [];
  const category = await prisma.category.findUnique({
    where: { id: product.categoryId },
    select: { id: true, path: true },
  });
  const onCategories = category === null ? [] : await categoryMarketNotes(country, category, now);

  const onProduct = await prisma.marketRule.findMany({
    where: {
      countryCode: country,
      isActive: true,
      scope: 'PRODUCT',
      productId: product.id,
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
    },
    select: { effect: true, reason: true, requiredDocumentsJson: true },
    orderBy: [{ effect: 'asc' }, { createdAt: 'asc' }],
  });

  return [
    ...onProduct.map((rule) => ({
      effect: rule.effect,
      reason: rule.reason,
      requiredDocuments: Array.isArray(rule.requiredDocumentsJson)
        ? rule.requiredDocumentsJson.filter((entry): entry is string => typeof entry === 'string')
        : [],
      categoryName: '',
    })),
    ...onCategories,
  ].sort((a, b) => (a.effect === b.effect ? 0 : a.effect === 'BLOCK' ? -1 : 1));
}
