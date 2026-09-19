/**
 * What a demonstration product is described as, before it is one.
 *
 * A BLUEPRINT is the authored half: the words, the specifications, the
 * dimensions the thing is stocked along and the band its price sits in. It
 * says nothing about identifiers, exact prices or stock levels, because those
 * are DERIVED - see `generate.ts` - deterministically from the blueprint's own
 * key, so that a second run of the seed produces the same catalogue rather
 * than a differently-priced one.
 *
 * Two rules the whole registry is written under, and both are about honesty
 * rather than tidiness:
 *
 *   - **Nothing here may state a claim this software cannot stand behind.** No
 *     certification, no approval, no clinical outcome, no "best seller", no
 *     "number one", no award. A specification is a fact about a thing that can
 *     be checked against the thing; a certificate is a fact about a document
 *     nobody here has seen. The first belongs in `specs`, the second belongs
 *     nowhere. The medical shelves are written with this at its strictest: a
 *     gauge and a length are dimensions, and a dose is not.
 *
 *   - **A title has to name a real product.** "High Quality Product 1" and
 *     "Sample Item 4" are what makes a demonstration catalogue read as filler,
 *     and a catalogue that reads as filler demonstrates nothing. Every title
 *     here is the sort of line a trade supplier would actually print.
 *
 * The compact field names are deliberate. There are four hundred and fourteen
 * of these, they are read as a block far more often than one at a time, and a
 * blueprint that fits on a screen is one a person will actually correct.
 */
import type { VariantTemplate } from '../../../domain/variants/axis.js';
import { findAxis } from '../../../domain/variants/registry.js';

/**
 * One dimension this product is stocked along, and the values it is stocked in.
 *
 * A tuple rather than an object, because it is always exactly these two things
 * and the registry is nine thousand lines of them.
 *
 * The key is a VARIANT TEMPLATE AXIS KEY - `size`, `battery_capacity`,
 * `cross_section` - and `assertAxesAreKnown` below refuses a key the
 * sub-category's template does not offer. That is what stops a blueprint
 * inventing a dimension the buyer's selector, the seller's matrix builder and
 * the catalogue's facets have never heard of, and it is why the generated
 * products behave on the storefront exactly like a seller's own.
 *
 * Medical Devices is the exception, and a deliberate one: that department has
 * no template at all (see `registry.ts`), its variants are free-form options,
 * and a hospital buyer picks several sizes at once rather than narrowing to
 * one. Its blueprints therefore author their own keys, which is precisely what
 * the department already does today.
 */
export type AxisSpec = readonly [key: string, values: readonly string[]];

/** How a product family is sold, where it is not sold one at a time. */
export interface SaleUnit {
  /** What is inside one purchasable unit - 500 g, 250 ml, 100 sheets. */
  readonly content: readonly [amount: number, unit: string];
  /**
   * The amount a unit price is quoted against - "per 1 kg", "per 100 g".
   * Omitted where a sensible default per unit family is enough.
   */
  readonly per?: readonly [amount: number, unit: string];
  /** The manufacturer's own words for the packed unit - "Box of 100". */
  readonly label?: string;
}

/** One authored product family. */
export interface Blueprint {
  /**
   * The stable identity of this product, for as long as it exists.
   *
   * Everything derived is derived from it: the product's SKU, every variant's
   * SKU, every price, every stock figure and the seed key the re-run matches
   * on. Changing it is not an edit - it retires one product and creates
   * another - which is exactly the property that makes the seed idempotent.
   *
   * Unique across the whole registry, asserted by `assertRegistryIsSound`.
   */
  readonly key: string;

  /** What kind of thing this is, in a buyer's words. Never blank. */
  readonly type: string;

  /** The line on the card. A real product name, not a category with a number. */
  readonly title: string;

  /**
   * A neutral, fictional trade brand.
   *
   * Invented on purpose. Putting a real manufacturer's name on a fabricated
   * product is passing off, and it would survive into screenshots, demos and
   * whatever somebody exports from this catalogue. The names are drawn from
   * `brands.ts` so that a brand means the same supplier across every
   * department it appears in.
   */
  readonly brand: string;

  /** One sentence for the card and the meta description. */
  readonly short: string;

  /** Two or three sentences for the product page. What it is and what it does. */
  readonly long: string;

  /**
   * What to search a photograph library for.
   *
   * Specific to the PRODUCT, never to its department: "cordless electric drill
   * isolated" and not "tools". A broad query is how a bearing ends up
   * illustrated by a photograph of a factory floor.
   */
  readonly img: string;

  /**
   * The facts shared by every variant, as they are shown on the product page.
   *
   * Written in the operator's own display form - "13 mm keyless", "IP66" -
   * because these are printed, not computed. Anything a buyer CHOOSES belongs
   * in `axes` instead: a specification with one value per variant is a
   * specification that contradicts itself on three quarters of the page.
   */
  readonly specs: Readonly<Record<string, string>>;

  /**
   * Which of those specifications are worth a tick box in the filter panel.
   *
   * Named rather than inferred, because "filterable" is a judgement about
   * whether a shopper narrows by it, not a property of the value. A dozen
   * distinct torque figures make a useless facet; four insulation types make a
   * good one.
   */
  readonly facets?: readonly string[];

  /** The dimensions this is stocked along. Absent means a single SKU. */
  readonly axes?: readonly AxisSpec[];

  /**
   * The band this family's prices fall in, in minor units of the base
   * currency, cheapest variant to dearest.
   *
   * A band rather than a figure, because a 2 Ah drill and a 5 Ah drill are not
   * the same money and a catalogue that prices them identically is a catalogue
   * whose variant selector is decoration. Where a family has one SKU the two
   * numbers are the ends of the jitter this key happens to land in.
   */
  readonly price: readonly [low: number, high: number];

  /**
   * How much stock a variant carries, low to high.
   *
   * Per variant, never per family: the whole point of the exercise is that
   * Black/Size 8 and Brown/Size 9 are two different things on two different
   * shelves. A small share of variants land on zero deliberately, so that the
   * out-of-stock path is something a reviewer can actually see.
   */
  readonly stock: readonly [low: number, high: number];

  /** Minimum a buyer may order. Default 1. */
  readonly moq?: number;

  /** Quantities must be a multiple of this. Default 1. */
  readonly step?: number;

  /** How this is sold, where it is not sold as a bare piece. */
  readonly sold?: SaleUnit;

  /** Dispatch weight of one unit, in grams. Used for the carrier quote. */
  readonly grams?: number;

  /**
   * How many identical sellable units are supplied together - the 10 in "Pack
   * of 10". Absent or 1 is a single.
   */
  readonly multipack?: number;

  /**
   * How much above the selling price the list price sits, as a fraction.
   *
   * Absent means NO list price at all, which is the honest answer for most of
   * a trade catalogue: a strike-through figure that was never charged is a
   * fabricated discount. Where it is present it is a modest trade margin, and
   * it varies per blueprint so the grid does not show one invented percentage
   * on every card.
   */
  readonly mrp?: number;

  /**
   * Whether this is the product that leads its shelf.
   *
   * It buys a photograph resolved first when the image budget is tight, a
   * fuller gallery, and a place in the seed's report. It is NOT a claim about
   * popularity: this catalogue has no sales figures, so nothing here is
   * allowed to say "best selling" or "trending", and nothing does.
   */
  readonly featured?: boolean;

  /** Days of lead time where this is made or brought in to order. */
  readonly leadDays?: number;

  /** How it is packed, for the packaging panel. */
  readonly packing?: {
    readonly type: string;
    readonly perInner?: number;
    readonly innersPerOuter?: number;
    readonly innerName?: string;
    readonly outerName?: string;
  };
}

/** Every blueprint written for one sub-category. */
export interface Shelf {
  /** `categories.slug` of the sub-category. Never a display name. */
  readonly subcategory: string;
  readonly products: readonly Blueprint[];
}

/** A shelf, with its axis keys checked against the sub-category's template. */
export function shelf(subcategory: string, products: readonly Blueprint[]): Shelf {
  return Object.freeze({ subcategory, products: Object.freeze([...products]) });
}

/**
 * Refuse an axis key the sub-category's own template does not offer.
 *
 * The check that keeps the generated catalogue honest. A blueprint that
 * invents `"colour_family"` where the template says `"colour"` produces a
 * product whose selector the storefront cannot draw, whose facet the filter
 * panel cannot offer and whose signature nothing else in the catalogue
 * matches - and it does all of that silently, because a variant is just a JSON
 * blob until something tries to read it.
 *
 * A null template means the department deliberately has none - Medical Devices
 * - and free-form keys are then correct rather than a mistake.
 */
export function unknownAxisKeys(
  templateEntry: VariantTemplate | null,
  axes: readonly AxisSpec[],
): string[] {
  if (templateEntry === null) return [];
  return axes.map(([key]) => key).filter((key) => findAxis(templateEntry, key) === null);
}
