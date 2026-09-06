/**
 * Product filters, shared by the storefront and the admin list.
 *
 * Both screens filter the same catalogue and must agree on what the answers
 * mean: "in stock" cannot be one thing on the shop and another on the screen
 * an administrator uses to check the shop. Two copies of that rule is how they
 * quietly stop agreeing, so the rules live here once and both routes import
 * them.
 *
 * What is *not* here is anything about where the price lives. The storefront
 * filters on `product_prices` for the shopper's own currency; the admin list
 * filters on the product's base price. That difference is real and each route
 * expresses it itself.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../infra/prisma.js';

/** How many `attr=Name:Value` pairs one request may carry. */
export const MAX_ATTRIBUTE_FILTERS = 24;

/** How many distinct name/value pairs a facet listing will consider. */
export const MAX_FACET_ROWS = 500;

/** How many values one facet offers. Beyond this the long tail is noise. */
export const MAX_FACET_VALUES = 40;

/**
 * A facet needs two values before it is worth offering.
 *
 * A specification every product shares - "Latex: latex-free" across the whole
 * catalogue - is a fact about the range, not a way to narrow it. Ticking it
 * removes nothing, and a real catalogue has a dozen such attributes: offered,
 * they bury the filters that do work under a column of controls that do not.
 */
export const MIN_FACET_VALUES = 2;

/**
 * The attribute facets a request is asking for, grouped by name.
 *
 * Malformed pairs are dropped rather than rejected. These arrive from a URL
 * somebody may have edited and from links that have aged past a renamed
 * attribute, and an unreadable facet should narrow nothing - not turn the page
 * into an error. The count is capped so a hand-written URL cannot make the
 * database AND together an unbounded number of subqueries.
 */
export function attributeFiltersFrom(raw: string | string[] | undefined): Map<string, string[]> {
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  const byName = new Map<string, string[]>();

  for (const entry of entries.slice(0, MAX_ATTRIBUTE_FILTERS)) {
    const separator = entry.indexOf(':');
    if (separator <= 0) continue;

    const name = entry.slice(0, separator).trim();
    // Not split on every colon: a value may legitimately contain one ("Ratio:
    // 1:2"), and only the first separates the name from it.
    const value = entry.slice(separator + 1).trim();
    if (name === '' || value === '' || name.length > 128 || value.length > 512) continue;

    const values = byName.get(name) ?? [];
    if (!values.includes(value)) values.push(value);
    byName.set(name, values);
  }

  return byName;
}

/**
 * One `where` clause per attribute name.
 *
 * Names AND while their values OR - "Brand is Acme or Bosch, and the finish is
 * zinc" - which is how anybody reads a column of tick boxes. Folding the names
 * into a single `some` would instead match a product carrying *any* one of the
 * ticked values, so a Bosch product would answer a search for Acme in zinc.
 *
 * `isFilterable` is not decoration: without it any internal specification
 * becomes a public filter by URL, and the catalogue can be enumerated by
 * supplier.
 */
export function attributeConditions(attributes: Map<string, string[]>): Prisma.ProductWhereInput[] {
  return [...attributes].map(([name, values]) => ({
    attributes: { some: { isFilterable: true, name, value: { in: values } } },
  }));
}

/**
 * Products with something left to sell.
 *
 * Reserved stock is already spoken for by somebody else's cart, so the
 * comparison is against `reservedQty` rather than against zero. Untracked
 * products always pass: "we do not count this one" is not the same statement
 * as "there are none of these", and treating it as one would empty the
 * catalogue of a business that never used stock control.
 */
export function inStockCondition(): Prisma.ProductWhereInput {
  return {
    OR: [
      { isStockTracked: false },
      {
        inventoryBalances: {
          some: { onHandQty: { gt: prisma.inventoryBalance.fields.reservedQty } },
        },
      },
    ],
  };
}

/**
 * Products that have run out.
 *
 * The exact negation of `inStockCondition`, restricted to tracked products -
 * an untracked product is never "out of stock", it is simply not counted, and
 * listing it under a heading that says otherwise would send somebody off to
 * reorder something they already have.
 */
export function outOfStockCondition(): Prisma.ProductWhereInput {
  return {
    isStockTracked: true,
    NOT: {
      inventoryBalances: {
        some: { onHandQty: { gt: prisma.inventoryBalance.fields.reservedQty } },
      },
    },
  };
}

/** One attribute offered as a filter, with how many products carry each value. */
export interface AttributeFacet {
  name: string;
  values: { value: string; count: number }[];
}

/**
 * Shape grouped attribute rows into the facets a filter panel can render.
 *
 * Values come back commonest first: the one matching most of what is on the
 * shelf is the one most people are looking for. Ties fall back to alphabetical
 * so the order is stable between requests rather than shuffling under the
 * cursor.
 */
export function groupAttributeFacets(
  rows: { name: string; value: string; _count: { _all: number } }[],
): AttributeFacet[] {
  const byName = new Map<string, { value: string; count: number }[]>();

  for (const row of rows) {
    const values = byName.get(row.name) ?? [];
    values.push({ value: row.value, count: row._count._all });
    byName.set(row.name, values);
  }

  return [...byName]
    .filter(([, values]) => values.length >= MIN_FACET_VALUES)
    .map(([name, values]) => ({
      name,
      values: values
        .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
        .slice(0, MAX_FACET_VALUES),
    }));
}

/**
 * The filterable attribute values carried by the products this `where` selects.
 *
 * One grouped read, capped: a catalogue with a free-text attribute could
 * otherwise return tens of thousands of distinct values to build a filter
 * panel nobody could use.
 */
export async function attributeFacetsFor(
  productWhere: Prisma.ProductWhereInput,
): Promise<AttributeFacet[]> {
  const rows = await prisma.productAttribute.groupBy({
    by: ['name', 'value'],
    where: { isFilterable: true, product: productWhere },
    _count: { _all: true },
    orderBy: [{ name: 'asc' }, { value: 'asc' }],
    take: MAX_FACET_ROWS,
  });

  return groupAttributeFacets(rows);
}
