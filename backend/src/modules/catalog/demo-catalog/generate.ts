/**
 * A blueprint, turned into a product family nobody has to finish by hand.
 *
 * Pure. No database, no clock, no network - which is what makes the coverage
 * test able to assert that every sub-category gets three products, that every
 * SKU is unique and that every combination has its own stock, without a
 * MariaDB anywhere near it.
 *
 * THE ONE RULE ABOUT COMBINATIONS
 *
 * Stock, price and SKU belong to the WHOLE combination, never to one value of
 * one axis. A safety boot stocked in two colours and four sizes is eight
 * things on eight shelves - Black/7, Black/8, Brown/7, Brown/8 and so on - and
 * a generator that put a stock figure on "Black" and another on "size 8" would
 * be describing a warehouse that cannot exist. Everything below follows from
 * that.
 *
 * WHY THE GRID IS TRIMMED RATHER THAN SAMPLED
 *
 * Three axes of four values is sixty-four combinations, which is not a product
 * page - it is a spreadsheet with a Buy button. So the grid is REDUCED until
 * it fits: values come off the trailing axes one at a time until the total is
 * within the cap, and what is left is a COMPLETE grid of what remains. That
 * matters more than it sounds. Sampling sixteen of sixty-four combinations
 * produces a selector where choosing Brown greys out three of four sizes for
 * no reason a shopper can see; a complete smaller grid is a seller who stocks
 * two colours and four sizes, which is what most sellers actually do.
 */
import {
  measurementText,
  normaliseAxisKey,
  optionSignature,
  type OptionValue,
  type VariantTemplate,
} from '../../../domain/variants/axis.js';
import { findAxis } from '../../../domain/variants/registry.js';
import { productSku, productSlug, variantSku } from './codes.js';
import { bandedPrice, Rng } from './rng.js';
import type { Blueprint } from './types.js';

/**
 * The most combinations one product family may carry.
 *
 * Twelve, because a selector is a thing a person reads. The brief this
 * catalogue was written to says two to twelve, and the ceiling is the half
 * that needs enforcing: nothing forces a family to have more than one.
 */
export const MAX_VARIANTS_PER_PRODUCT = 12;

/** One sellable combination. */
export interface GeneratedVariant {
  readonly sku: string;
  readonly name: string;
  /** `{ colour: 'Black', size: '8' }` - keyed by axis key, valued as displayed. */
  readonly options: Readonly<Record<string, string>>;
  readonly optionSignature: string;
  readonly priceMinor: bigint;
  readonly compareAtPriceMinor: bigint | null;
  /** This combination's own stock. Zero is a real answer and a deliberate one. */
  readonly stock: number;
  readonly sortOrder: number;
  readonly minOrderQty: number | null;
  readonly qtyIncrement: number | null;
  readonly leadTimeDays: number | null;
  readonly multipackCount: number | null;
  readonly netContentValue: string | null;
  readonly netContentUnit: string | null;
  readonly unitPricingBaseValue: string | null;
  readonly unitPricingBaseUnit: string | null;
  readonly manufacturerPackLabel: string | null;
  readonly shippingWeightGrams: number | null;
}

/** One specification row. */
export interface GeneratedAttribute {
  readonly name: string;
  readonly value: string;
  readonly sortOrder: number;
  readonly isFilterable: boolean;
}

/** A whole product family, ready to be written. */
export interface GeneratedProduct {
  /** `demo-catalog:<blueprint key>`. The identity a re-run matches on. */
  readonly seedKey: string;
  readonly blueprintKey: string;
  readonly departmentSlug: string;
  readonly subcategorySlug: string;

  readonly name: string;
  readonly slug: string;
  readonly sku: string;
  readonly productType: string;
  readonly brand: string;

  readonly shortDescription: string;
  readonly description: string;
  readonly descriptionHtml: string;
  readonly highlights: readonly string[];
  readonly keywords: readonly string[];
  readonly metaTitle: string;
  readonly metaDescription: string;

  readonly attributes: readonly GeneratedAttribute[];
  /** Template axis keys, in template order. Null where the family has none. */
  readonly variantAxes: readonly string[] | null;

  readonly basePriceMinor: bigint;
  readonly compareAtPriceMinor: bigint | null;
  readonly minOrderQty: number;
  readonly qtyIncrement: number;
  readonly weightGrams: number | null;

  readonly variants: readonly GeneratedVariant[];

  readonly imageQuery: string;
  readonly imageAlt: string;
  readonly featured: boolean;

  readonly packing: Blueprint['packing'];
}

/**
 * Cut the grid down until it fits, by shortening axes from the end.
 *
 * The LAST axis loses values first, because blueprints are written with the
 * axis a buyer chooses first at the front - size before colour, voltage before
 * kit contents - and the dimension a seller actually narrows their range on is
 * the one nobody leads with.
 *
 * An axis is never emptied. Losing an axis entirely would change what the
 * product IS - a boot with no size is not a boot - so the floor is one value,
 * which is a seller who stocks this in one colour.
 */
function fitGrid(axisValues: readonly (readonly string[])[]): string[][] {
  const trimmed = axisValues.map((values) => [...values]);

  const total = (): number => trimmed.reduce((product, values) => product * values.length, 1);

  while (total() > MAX_VARIANTS_PER_PRODUCT) {
    let cut = -1;
    for (let index = trimmed.length - 1; index >= 0; index -= 1) {
      const values = trimmed[index];
      if (values !== undefined && values.length > 1) {
        cut = index;
        break;
      }
    }
    // Every axis is down to one value and the total is still over the cap,
    // which arithmetic does not permit - but a loop with no exit is worse than
    // a redundant guard.
    if (cut === -1) break;
    trimmed[cut]?.pop();
  }

  return trimmed;
}

/** Every combination of the trimmed grid, in odometer order. */
function gridCombinations(axisValues: readonly (readonly string[])[]): string[][] {
  return axisValues.reduce<string[][]>(
    (rows, values) => rows.flatMap((row) => values.map((value) => [...row, value])),
    [[]],
  );
}

/**
 * Where in the price band a combination sits, from 0 to 1.
 *
 * The average of each chosen value's position along its own axis, so "the
 * biggest of everything" lands at the top of the band and "the smallest of
 * everything" at the bottom. Crude on purpose: the alternative is a weighting
 * per axis per department, which is four hundred more numbers to get wrong for
 * a catalogue whose prices are openly synthetic.
 *
 * A single-value axis contributes its midpoint rather than 0, or a family
 * whose second axis happens to have one value would price its whole range at
 * the floor of the band.
 */
function bandPosition(choice: readonly string[], axisValues: readonly (readonly string[])[]): number {
  if (axisValues.length === 0) return 0.5;

  let total = 0;
  for (const [index, values] of axisValues.entries()) {
    const chosen = choice[index];
    if (values.length <= 1 || chosen === undefined) {
      total += 0.5;
      continue;
    }
    total += values.indexOf(chosen) / (values.length - 1);
  }

  return total / axisValues.length;
}

/**
 * The label a variant carries, built from the values that earn a place in it.
 *
 * `inTitle` is the template's answer to "would a person say this out loud when
 * naming the thing?", and it is false for exactly the axes that would make a
 * name unreadable - an IP rating, a certificate option, a thread pitch. A
 * variant with nothing to say for itself is named after its product rather
 * than left blank, because an empty variant name renders as a gap in the
 * selector.
 */
function variantName(
  productName: string,
  templateEntry: VariantTemplate | null,
  axisKeys: readonly string[],
  choice: readonly string[],
): string {
  const parts: string[] = [];

  for (const [index, key] of axisKeys.entries()) {
    const value = choice[index];
    if (value === undefined) continue;

    const axis = templateEntry === null ? null : findAxis(templateEntry, key);
    // No template means Medical Devices, where every authored option is part
    // of how the item is named - "3 ml / 23G x 1\"" is the thing being bought.
    if (axis !== null && !axis.inTitle) continue;

    parts.push(value);
  }

  return parts.length === 0 ? productName : parts.join(' / ');
}

/**
 * The bullets under the description.
 *
 * Derived from the specifications and the terms of trade rather than written
 * separately, and that is not laziness - it is the only way the bullets cannot
 * contradict the table three inches below them. Every one of them restates
 * something this product actually stores.
 */
function highlightsFor(blueprint: Blueprint, variantCount: number): string[] {
  const bullets: string[] = [];

  for (const [name, value] of Object.entries(blueprint.specs).slice(0, 4)) {
    bullets.push(`${name}: ${value}`);
  }

  if (variantCount > 1) {
    bullets.push(`${String(variantCount)} options, each with its own stock and price`);
  }

  const moq = blueprint.moq ?? 1;
  if (moq > 1) bullets.push(`Minimum order ${String(moq)}`);

  if (blueprint.sold !== undefined) {
    const [amount, unit] = blueprint.sold.content;
    bullets.push(`Supplied as ${String(amount)} ${unit} per unit`);
  }

  if (blueprint.leadDays !== undefined) {
    bullets.push(`Made to order - ${String(blueprint.leadDays)} working days`);
  }

  return bullets;
}

/**
 * What this product should be findable by.
 *
 * The title, the type, the brand, the department, every specification value
 * and every option value - which is the whole point, because a buyer searching
 * "M8 zinc" is searching a specification and a buyer searching "UK 9" is
 * searching an option. Folded to lower case and de-duplicated so the stored
 * list is a set rather than a transcript.
 */
function keywordsFor(
  blueprint: Blueprint,
  subcategoryName: string,
  optionValues: readonly string[],
): string[] {
  const words = [
    blueprint.title,
    blueprint.type,
    blueprint.brand,
    subcategoryName,
    ...Object.values(blueprint.specs),
    ...optionValues,
  ]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9.+/-]+/)
    .filter((word) => word.length > 1);

  return [...new Set(words)].slice(0, 60);
}

/** Escape text for the small amount of HTML this file emits. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface GenerateContext {
  readonly departmentSlug: string;
  readonly subcategorySlug: string;
  readonly subcategoryName: string;
  /** The sub-category's variant template, or null where it has none. */
  readonly template: VariantTemplate | null;
  /** Slugs already issued this run, so the unique index cannot be hit. */
  readonly slugs: Set<string>;
  /**
   * Every SKU issued this run, family and variant alike.
   *
   * Shared across the whole registry rather than per product, because
   * `product_variants.sku` and `products.sku` are each unique across the entire
   * catalogue - not within a family. Two blueprint keys in one department can
   * abbreviate to the same six characters, and without this the second one's
   * insert fails on a unique index several thousand rows into the run.
   */
  readonly skus: Set<string>;
}

/** Turn one blueprint into one product family. */
export function generateProduct(
  blueprint: Blueprint,
  context: GenerateContext,
): GeneratedProduct {
  const seedKey = `demo-catalog:${blueprint.key}`;

  const axes = blueprint.axes ?? [];
  const axisKeys = axes.map(([key]) => key);
  const fitted = fitGrid(axes.map(([, values]) => values));
  const combinations = gridCombinations(fitted);

  /*
   * The axes that survived the trim with more than one value, PLUS anything
   * one of those depends on.
   *
   * The second half is not a refinement, it is a bug fix. `size` declares
   * `dependsOn: ['size_system']`, because a bare 8 is a different shoe in UK
   * and in EU - so the buyer's selector greys the size run out until a system
   * has been chosen. A boot sold only in UK sizing has one value on that axis,
   * and dropping it for that reason left the product page showing "Choose size
   * system first" above a control that was never drawn. The dependency is
   * declared, so it is honoured rather than second-guessed.
   */
  const varying = axisKeys.filter((_, index) => (fitted[index]?.length ?? 0) > 1);

  const required = new Set(varying);
  for (const key of varying) {
    const axis = context.template === null ? null : findAxis(context.template, key);
    for (const dependency of axis?.dependsOn ?? []) required.add(dependency);
  }

  const declaredAxes = axisKeys.filter((key) => required.has(key));

  const priceRng = new Rng(`${blueprint.key}:price`);
  const stockRng = new Rng(`${blueprint.key}:stock`);
  // Through `variantSku` so a family code that collides with one already
  // issued is resolved the same way a variant code is - deterministically, and
  // once.
  const familySku = variantSku(
    productSku(context.departmentSlug, blueprint.key),
    [],
    blueprint.key,
    context.skus,
  );

  const [lowPrice, highPrice] = blueprint.price;
  const [lowStock, highStock] = blueprint.stock;

  const variants: GeneratedVariant[] = [];

  for (const [index, choice] of combinations.entries()) {
    const optionValues: OptionValue[] = axisKeys.map((key, position) => ({
      axisKey: key,
      label: choice[position] ?? '',
    }));

    const signature = optionSignature(optionValues);

    const options: Record<string, string> = {};
    for (const value of optionValues) {
      if (value.label !== '') options[normaliseAxisKey(value.axisKey)] = measurementText(value);
    }

    const position = bandPosition(choice, fitted);
    const priceMinor = bandedPrice(lowPrice, highPrice, position, priceRng.next());

    /*
     * A list price on some products and not others, at a margin that differs
     * per product.
     *
     * A catalogue where every card shows the same invented percentage off is a
     * catalogue whose discounts nobody believes, and rightly - it is the
     * single most obvious tell of generated data. Where the blueprint gives no
     * margin there is no list price at all, which is the ordinary state of a
     * trade catalogue.
     */
    const compareAt =
      blueprint.mrp === undefined
        ? null
        : BigInt(Math.round(priceMinor * (1 + blueprint.mrp * priceRng.float(0.75, 1.25))));

    /*
     * Some combinations are out of stock, and that is the point.
     *
     * A catalogue where everything is available never exercises the notice, the
     * disabled buy button or the back-in-stock copy, and those are exactly the
     * states a reviewer should be able to see without editing the database.
     * The first combination is never one of them, so no product is entirely
     * unbuyable by accident.
     */
    const outOfStock = index > 0 && stockRng.chance(0.09);
    const stock = outOfStock ? 0 : stockRng.int(lowStock, highStock);

    const sold = blueprint.sold;

    variants.push({
      sku: variantSku(familySku, choice, signature, context.skus),
      name: variantName(blueprint.title, context.template, axisKeys, choice),
      options,
      optionSignature: signature,
      priceMinor: BigInt(priceMinor),
      compareAtPriceMinor: compareAt,
      stock,
      sortOrder: index,
      minOrderQty: blueprint.moq ?? null,
      qtyIncrement: blueprint.step ?? null,
      leadTimeDays: blueprint.leadDays ?? null,
      multipackCount: blueprint.multipack ?? null,
      netContentValue: sold === undefined ? null : String(sold.content[0]),
      netContentUnit: sold === undefined ? null : sold.content[1],
      unitPricingBaseValue: sold?.per === undefined ? null : String(sold.per[0]),
      unitPricingBaseUnit: sold?.per === undefined ? null : sold.per[1],
      manufacturerPackLabel: sold?.label ?? null,
      shippingWeightGrams: blueprint.grams ?? null,
    });
  }

  /*
   * A family with no axes still gets one variant.
   *
   * Not a workaround - it is what a product with nothing to choose between
   * actually is, and it keeps every downstream reader on one path. The
   * alternative, a product whose stock and price live on the product row for
   * some items and on a variant row for others, is two code paths through the
   * cart for no benefit a buyer can see. Its option map is empty, so its
   * signature is the empty string, which is exactly the value the unique index
   * was designed around.
   */
  if (variants.length === 0) {
    const priceMinor = bandedPrice(lowPrice, highPrice, 0.5, priceRng.next());
    variants.push({
      sku: familySku,
      name: blueprint.title,
      options: {},
      optionSignature: '',
      priceMinor: BigInt(priceMinor),
      compareAtPriceMinor:
        blueprint.mrp === undefined
          ? null
          : BigInt(Math.round(priceMinor * (1 + blueprint.mrp * priceRng.float(0.75, 1.25)))),
      stock: stockRng.int(lowStock, highStock),
      sortOrder: 0,
      minOrderQty: blueprint.moq ?? null,
      qtyIncrement: blueprint.step ?? null,
      leadTimeDays: blueprint.leadDays ?? null,
      multipackCount: blueprint.multipack ?? null,
      netContentValue: blueprint.sold === undefined ? null : String(blueprint.sold.content[0]),
      netContentUnit: blueprint.sold === undefined ? null : blueprint.sold.content[1],
      unitPricingBaseValue:
        blueprint.sold?.per === undefined ? null : String(blueprint.sold.per[0]),
      unitPricingBaseUnit: blueprint.sold?.per === undefined ? null : blueprint.sold.per[1],
      manufacturerPackLabel: blueprint.sold?.label ?? null,
      shippingWeightGrams: blueprint.grams ?? null,
    });
  }

  // The family's own figure is the cheapest thing a shopper could buy, which
  // is what "from" on a card means and what the catalogue sorts by.
  const cheapest = variants.reduce(
    (lowest, variant) => (variant.priceMinor < lowest ? variant.priceMinor : lowest),
    variants[0]?.priceMinor ?? 0n,
  );
  const cheapestCompare = variants
    .filter((variant) => variant.priceMinor === cheapest)
    .map((variant) => variant.compareAtPriceMinor)
    .find((value) => value !== null);

  const highlights = highlightsFor(blueprint, variants.length);

  const attributes: GeneratedAttribute[] = [
    { name: 'Brand', value: blueprint.brand, sortOrder: 0, isFilterable: true },
    { name: 'Product type', value: blueprint.type, sortOrder: 1, isFilterable: true },
    ...Object.entries(blueprint.specs).map(([name, value], index) => ({
      name,
      value,
      sortOrder: index + 2,
      isFilterable: (blueprint.facets ?? []).includes(name),
    })),
  ];

  const descriptionHtml = [
    `<p>${escapeHtml(blueprint.long)}</p>`,
    `<ul>${highlights.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>`,
  ].join('');

  return {
    seedKey,
    blueprintKey: blueprint.key,
    departmentSlug: context.departmentSlug,
    subcategorySlug: context.subcategorySlug,

    name: blueprint.title,
    slug: productSlug(blueprint.title, blueprint.key, context.slugs),
    sku: familySku,
    productType: blueprint.type,
    brand: blueprint.brand,

    shortDescription: blueprint.short,
    description: blueprint.long,
    descriptionHtml,
    highlights,
    keywords: keywordsFor(
      blueprint,
      context.subcategoryName,
      [...new Set(fitted.flat())],
    ),
    metaTitle: `${blueprint.title} | ${context.subcategoryName}`,
    metaDescription: blueprint.short.slice(0, 320),

    attributes,
    /*
     * The axes the storefront draws a SELECTOR for, which is not quite the
     * same list as the axes this family varies along.
     *
     * An axis the seller stocks one value of is a fact about the product, not
     * a decision the buyer makes - a boot sold only in UK sizing, a cannula
     * sold only in boxes of a hundred. It stays in the variant's option map,
     * in its signature and in its SKU, because it is part of what is in the
     * box; it is simply not offered as a choice, because a dropdown with one
     * entry asks somebody to decide something that has already been decided.
     *
     * Read the note at the top of `axis.ts`: an axis is a dimension a buyer
     * chooses along. One value is not a dimension.
     */
    variantAxes: declaredAxes.length === 0 || context.template === null ? null : declaredAxes,

    basePriceMinor: cheapest,
    compareAtPriceMinor: cheapestCompare ?? null,
    minOrderQty: blueprint.moq ?? 1,
    qtyIncrement: blueprint.step ?? 1,
    weightGrams: blueprint.grams ?? null,

    variants,

    imageQuery: blueprint.img,
    imageAlt: `${blueprint.title} - ${blueprint.type} by ${blueprint.brand}`,
    featured: blueprint.featured ?? false,

    packing: blueprint.packing,
  };
}
