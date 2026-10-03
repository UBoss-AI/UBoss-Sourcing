import { MAX_CATEGORY_DEPTH } from './category.service.js';
/** Public discovery shares catalogue, market and seller visibility. No private entities. */
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../infra/prisma.js';
import { publicCategoryWhere, publicProductWhere } from './catalog.visibility.js';
import { marketEligibleWhere } from './market-eligibility.service.js';
import { verifiedSupplierWhere } from './supplier-directory.service.js';
import { interpretSearch, literalLike, normalizeSearch, oneEditApart, type SearchInterpretation } from './search-query.js';

export interface DiscoveryQuery { q: string; currency: string; country: string | null; language: string | null; sellerAccountId: string | null; }
export interface DiscoveryItem { scope: 'product' | 'category' | 'supplier' | 'capability'; label: string; href: string; }

export async function searchCatalogue(input: DiscoveryQuery): Promise<{ query: string; terms: string[]; items: DiscoveryItem[]; suggestions: string[] }> {
  const normalized = normalizeSearch(input.q);
  if (normalized === '') return { query: '', terms: [], items: [], suggestions: [] };
  const interpreted = await searchInterpretationFor(normalized);
  const initial = interpretSearch(normalized);
  const eligible = await marketEligibleWhere(input.country);
  const liveOffer: Prisma.SellerOfferWhereInput = { status: 'ACTIVE', archivedAt: null, currency: input.currency, sellerAccount: { status: 'APPROVED', suspendedAt: null, archivedAt: null } };
  const visible: Prisma.ProductWhereInput = {
    ...publicProductWhere(), AND: [
      ...(eligible === null ? [] : [eligible]),
      input.sellerAccountId === null ? { prices: { some: { currencyCode: input.currency, variantKey: '' } } } : { sellerOffers: { some: { ...liveOffer, sellerAccountId: input.sellerAccountId } } },
    ],
  };
  const productMatch = publicSearchProductMatch(interpreted.groups, input.language);
  const categoryMatch: Prisma.CategoryWhereInput = { AND: interpreted.groups.map(group => ({ OR: group.flatMap(term => [
    { name: { contains: term } }, { description: { contains: term } }, { translations: { some: { language: input.language ?? '', name: { contains: term } } } },
  ]) })) };
  const supplierScope: Prisma.SellerAccountWhereInput = { ...verifiedSupplierWhere(),
    ...(input.sellerAccountId === null ? {} : { id: input.sellerAccountId }),
    offers: { some: { ...liveOffer, product: visible } },
  };
  const [products, categories, suppliers] = await Promise.all([
    prisma.product.findMany({ where: { AND: [visible, productMatch] }, select: { name: true, slug: true, translations: { where: { language: input.language ?? '' }, select: { name: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 12 }),
    prisma.category.findMany({ where: { ...publicCategoryWhere(), AND: [categoryMatch, categoryContainingVisibleProduct(visible)] }, select: { name: true, slug: true, translations: { where: { language: input.language ?? '' }, select: { name: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 8 }),
    prisma.sellerAccount.findMany({ where: { AND: [supplierScope, ...interpreted.groups.map(group => ({ OR: group.map(term => ({ displayName: { contains: term } })) }))] }, select: { displayName: true, slug: true }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: 8 }),
  ]);
  // MariaDB JSON_SEARCH matches inside actual stored capability tags. Bound SQL
  // parameters and literal wildcard escaping prevent words becoming SQL patterns.
  // The returned ids are internal candidates only; public seller/market filters
  // are applied again before any name or capability is returned.
  const clauses = interpreted.groups.map(group => Prisma.sql`(${Prisma.join(group.map(term => Prisma.sql`JSON_SEARCH(LOWER(capabilitiesJson), 'one', ${'%' + literalLike(term.replaceAll(' ', '_')) + '%'}, '\\\\') IS NOT NULL`), ' OR ')})`);
  const capabilityIds = await prisma.$queryRaw<{ sellerAccountId: string }[]>(Prisma.sql`SELECT sellerAccountId FROM seller_trust_profiles WHERE JSON_TYPE(capabilitiesJson) = 'ARRAY' AND ${Prisma.join(clauses, ' AND ')}`);
  const capabilitySuppliers = capabilityIds.length === 0 ? [] : await prisma.sellerAccount.findMany({ where: { AND: [supplierScope, { id: { in: capabilityIds.map(row => row.sellerAccountId) } }] }, select: { displayName: true, slug: true, trustProfile: { select: { capabilitiesJson: true } } }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: 8 });
  const translatedName = (row: { name: string; translations: { name: string }[] }): string => row.translations[0]?.name.trim() || row.name;
  const items: DiscoveryItem[] = [
    ...products.map(row => ({ scope: 'product' as const, label: translatedName(row), href: '/product/' + encodeURIComponent(row.slug) })),
    ...categories.map(row => ({ scope: 'category' as const, label: translatedName(row), href: '/category/' + encodeURIComponent(row.slug) })),
    ...suppliers.map(row => ({ scope: 'supplier' as const, label: row.displayName, href: '/suppliers/' + encodeURIComponent(row.slug) })),
    ...capabilitySuppliers.filter(row => {
      const tags = Array.isArray(row.trustProfile?.capabilitiesJson) ? row.trustProfile.capabilitiesJson.filter((tag): tag is string => typeof tag === 'string') : [];
      return interpreted.groups.every(group => group.some(term => tags.some(tag => normalizeSearch(tag.replaceAll('_', ' ')).includes(normalizeSearch(term.replaceAll('_', ' '))))));
    }).map(row => {
      const tags = Array.isArray(row.trustProfile?.capabilitiesJson) ? row.trustProfile.capabilitiesJson.filter((tag): tag is string => typeof tag === 'string').filter(tag => interpreted.groups.some(group => group.some(term => normalizeSearch(tag.replaceAll('_', ' ')).includes(normalizeSearch(term.replaceAll('_', ' ')))))) : [];
      return { scope: 'capability' as const, label: row.displayName + (tags.length === 0 ? '' : ' — ' + tags.map(tag => tag.replaceAll('_', ' ')).join(', ')), href: '/suppliers/' + encodeURIComponent(row.slug) };
    }),
  ];
  // Suggestions come only from visible catalogue names, not an unrestricted
  // dictionary. A bounded shortlist can suggest a correction; it never rewrites
  // the buyer's request or claims that a missed correction proves no stock.
  let suggestions: string[] = [];
  if (items.length === 0 && initial.terms.length === 1 && initial.terms[0]!.length >= 4) {
    const word = initial.terms[0]!;
    const candidates = await prisma.product.findMany({ where: { AND: [visible, { OR: [{ name: { startsWith: word.slice(0, 2) } }, { translations: { some: { language: input.language ?? '', name: { startsWith: word.slice(0, 2) } } } }] }] }, select: { name: true, translations: { where: { language: input.language ?? '' }, select: { name: true } } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], take: 100 });
    suggestions = [...new Set(candidates.flatMap(row => normalizeSearch(translatedName(row)).split(' ')).filter(candidate => oneEditApart(word, candidate)))].sort().slice(0, 3);
  }
  return { query: normalized, terms: initial.terms, items, suggestions };
}

export async function searchInterpretationFor(value: string): Promise<SearchInterpretation> {
  const normalized = normalizeSearch(value);
  const aliases = await prisma.searchSynonym.findMany({ where: { isActive: true, OR: [{ term: normalized }, ...normalized.split(' ').map(term => ({ term }))] }, select: { term: true, synonymsJson: true }, orderBy: { term: 'asc' }, take: 20 });
  // Request prefixes may precede a maintained phrase synonym.
  const initial = interpretSearch(normalized);
  if (initial.terms.join(' ') !== normalized) {
    const phrase = await prisma.searchSynonym.findUnique({ where: { term: initial.terms.join(' ') }, select: { term: true, synonymsJson: true, isActive: true } });
    if (phrase?.isActive) aliases.push(phrase);
  }
  return interpretSearch(normalized, aliases);
}

export function publicSearchProductMatch(groups: string[][], language: string | null): Prisma.ProductWhereInput {
  return { AND: groups.map(group => ({ OR: group.flatMap(term => [
    { name: { contains: term } }, { shortDescription: { contains: term } }, { sku: { contains: term } }, { gtin: { contains: term } }, { modelIdentifier: { contains: term } },
    { translations: { some: { language: language ?? '', OR: [{ name: { contains: term } }, { shortDescription: { contains: term } }] } } },
    { variants: { some: { isActive: true, archivedAt: null, OR: [{ name: { contains: term } }, { sku: { contains: term } }, { gtin: { contains: term } }, { modelIdentifier: { contains: term } }] } } },
  ]) })) };
}

/** Parent departments are searchable when a visible descendant shelf holds goods. */
function categoryContainingVisibleProduct(product: Prisma.ProductWhereInput, remainingDepth = MAX_CATEGORY_DEPTH): Prisma.CategoryWhereInput {
  const own: Prisma.CategoryWhereInput = { products: { some: product } };
  if (remainingDepth <= 0) return own;
  return { OR: [own, { children: { some: { ...publicCategoryWhere(), ...categoryContainingVisibleProduct(product, remainingDepth - 1) } } }] };
}
