/**
 * The axes that recur across departments.
 *
 * Colour means the same thing on a safety boot and on a laptop; pack count
 * means the same thing on a bag of seeds and on a box of gloves. Defining each
 * once and referring to it from the templates is what stops "Colour", "Color"
 * and "Colour/Finish" existing as three different filters on the same shop,
 * and it is why a change to how colours are captured is one edit rather than
 * ninety.
 *
 * Each helper takes the suggestions that make sense in its trade, because the
 * suggestion list is the one thing that is genuinely different: the colours a
 * cable comes in are not the colours a lipstick comes in. Everything else -
 * input type, sort order, whether custom values are allowed - is the same
 * wherever the axis appears, which is the point.
 *
 * Nothing here is a closed list unless it says so. A seller stocking a shade
 * no template anticipated must be able to list it.
 */
import { axis, type VariantAxis } from './axis.js';

/** Colour. A swatch, and always with its name beside it - see the selector. */
export function colour(suggestions: readonly string[], importance: 'RECOMMENDED' | 'OPTIONAL' = 'OPTIONAL'): VariantAxis {
  return axis('colour', 'Colour', { input: 'COLOUR', importance, suggestions });
}

/**
 * How many identical sellable units are supplied together.
 *
 * NOT how many the buyer wants - that is cart quantity, and confusing the two
 * is how somebody ordering "3" of a "Pack of 10" is sent three packets. The
 * selector says "Pack of 10" and the quantity control counts packs.
 */
export function packCount(
  suggestions: readonly string[] = ['1', '5', '10', '20'],
  label = 'Pack size',
): VariantAxis {
  return axis('pack_count', label, {
    input: 'PACK_COUNT',
    importance: 'OPTIONAL',
    suggestions,
    sort: 'NUMERIC',
    helpText: 'How many units are supplied together. The buyer still chooses how many packs.',
  });
}

/** Apparel sizing, sorted the way a rail hangs rather than alphabetically. */
export function apparelSize(
  suggestions: readonly string[] = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
): VariantAxis {
  return axis('size', 'Size', {
    importance: 'RECOMMENDED',
    display: 'SIZE_BUTTONS',
    sort: 'APPAREL',
    suggestions,
  });
}

/**
 * Which country's size run the numbers below are in.
 *
 * A closed list, and the only reason the numeric size beside it means
 * anything: an 8 is three different shoes in UK, EU and US. Declared as a
 * dependency of `numericSize` so the selector cannot offer the number first.
 */
export function sizeSystem(suggestions: readonly string[] = ['UK/India', 'EU', 'US']): VariantAxis {
  return axis('size_system', 'Size system', {
    importance: 'RECOMMENDED',
    suggestions,
    allowsCustomValues: false,
    inTitle: true,
  });
}

/** A numbered size run. Depends on the system above it. */
export function numericSize(
  suggestions: readonly string[] = ['5', '6', '7', '8', '9', '10', '11', '12'],
  label = 'Size',
): VariantAxis {
  return axis('size', label, {
    importance: 'RECOMMENDED',
    input: 'NUMERIC',
    display: 'SIZE_BUTTONS',
    sort: 'NUMERIC',
    suggestions,
    dependsOn: ['size_system'],
  });
}

/** A measured dimension: a number the seller types and a unit they pick. */
export function measure(
  key: string,
  label: string,
  units: readonly string[],
  options: { suggestions?: readonly string[]; importance?: 'RECOMMENDED' | 'OPTIONAL' } = {},
): VariantAxis {
  return axis(key, label, {
    input: 'MEASUREMENT',
    importance: options.importance ?? 'OPTIONAL',
    units,
    sort: 'NUMERIC',
    ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
  });
}

/** Net weight of what is inside one unit - 500 g of seeds, 25 kg of cement. */
export function netWeight(
  suggestions: readonly string[] = ['100', '250', '500', '1', '5', '10', '25'],
  label = 'Net weight',
): VariantAxis {
  return measure('net_weight', label, ['g', 'kg', 'mg', 'lb'], {
    suggestions,
    importance: 'RECOMMENDED',
  });
}

/** Net volume of what is inside one unit - 500 ml, 5 L. */
export function netVolume(
  suggestions: readonly string[] = ['100', '250', '500', '1', '5', '20'],
  label = 'Net volume',
): VariantAxis {
  return measure('net_volume', label, ['ml', 'L', 'cl', 'fl oz'], {
    suggestions,
    importance: 'RECOMMENDED',
  });
}

/** A plain picked list. The workhorse of most templates. */
export function choice(
  key: string,
  label: string,
  suggestions: readonly string[],
  options: {
    importance?: 'RECOMMENDED' | 'OPTIONAL';
    display?: 'CHIPS' | 'DROPDOWN';
    inTitle?: boolean;
    /** Only for a genuinely closed set - a thread system, a trip curve. */
    allowsCustomValues?: boolean;
    /** Axes that must be answered first for this one to mean anything. */
    dependsOn?: readonly string[];
  } = {},
): VariantAxis {
  return axis(key, label, {
    suggestions,
    importance: options.importance ?? 'OPTIONAL',
    display: options.display ?? 'CHIPS',
    ...(options.inTitle === undefined ? {} : { inTitle: options.inTitle }),
    ...(options.allowsCustomValues === undefined
      ? {}
      : { allowsCustomValues: options.allowsCustomValues }),
    ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
  });
}

/** A yes/no that genuinely makes two SKUs - sterile and non-sterile. */
export function flag(key: string, label: string, suggestions: readonly [string, string]): VariantAxis {
  return axis(key, label, { input: 'BOOLEAN', suggestions, allowsCustomValues: false });
}

/** Mains voltage. Two SKUs when a seller stocks both, one when they do not. */
export function voltage(suggestions: readonly string[] = ['110-120 V', '220-240 V']): VariantAxis {
  return choice('voltage', 'Voltage', suggestions);
}

/** Material. Suggestions differ by trade; the axis does not. */
export function material(suggestions: readonly string[]): VariantAxis {
  return choice('material', 'Material', suggestions);
}

/** Finish, coating or surface treatment. */
export function finish(suggestions: readonly string[]): VariantAxis {
  return choice('finish', 'Finish', suggestions);
}

/** Capacity as a measured amount - a tank, a drum, a battery. */
export function capacity(units: readonly string[], suggestions?: readonly string[]): VariantAxis {
  return measure('capacity', 'Capacity', units, {
    importance: 'RECOMMENDED',
    ...(suggestions === undefined ? {} : { suggestions }),
  });
}

/** Length supplied - a reel, a roll, a bar. */
export function length(
  units: readonly string[] = ['m', 'cm', 'mm', 'ft'],
  suggestions?: readonly string[],
): VariantAxis {
  return measure('length', 'Length', units, {
    importance: 'RECOMMENDED',
    ...(suggestions === undefined ? {} : { suggestions }),
  });
}

/** Diameter - a bolt, a disc, a pipe, a cutter. */
export function diameter(
  units: readonly string[] = ['mm', 'cm', 'in'],
  suggestions?: readonly string[],
): VariantAxis {
  return measure('diameter', 'Diameter', units, {
    importance: 'RECOMMENDED',
    ...(suggestions === undefined ? {} : { suggestions }),
  });
}

/** How many pieces are in a set sold as one thing - a 12-piece spanner set. */
export function pieceCount(
  suggestions: readonly string[] = ['1', '3', '6', '12', '24'],
  label = 'Pieces in set',
): VariantAxis {
  return axis('piece_count', label, {
    input: 'NUMERIC',
    sort: 'NUMERIC',
    suggestions,
    display: 'SIZE_BUTTONS',
  });
}

/** Grade, class or quality designation. Never asserted as a certification. */
export function grade(suggestions: readonly string[], label = 'Grade'): VariantAxis {
  return choice('grade', label, suggestions);
}

// ---------------------------------------------------------------------------
// THE AXES A REAL SHOP TURNS OUT TO NEED
//
// The ones below were added after reading how the large Indian marketplaces
// actually break these shelves down. Several were missing outright - a shirt
// varies by neckline and sleeve as much as it varies by size, and a pan varies
// by its coating more than by anything else - and several had suggestion lists
// far shorter than the values sellers really use.
//
// They are still candidates. A template offering nine of these does not mean a
// seller has to switch nine on.
// ---------------------------------------------------------------------------

/** Print or weave. Solid, striped, checked - a real choice, not a photograph. */
export function pattern(suggestions: readonly string[]): VariantAxis {
  return choice('pattern', 'Pattern', suggestions);
}

/** How a garment, bag or case is fastened. */
export function closure(suggestions: readonly string[]): VariantAxis {
  return choice('closure', 'Closure', suggestions);
}

/** A surface treatment that changes what the thing does, not just how it looks. */
export function coating(suggestions: readonly string[], label = 'Coating'): VariantAxis {
  return choice('coating', label, suggestions);
}

/** Who or what it is cut for - mens, womens, a vehicle, a printer, a phone. */
export function fit(suggestions: readonly string[], label = 'Fit'): VariantAxis {
  return choice('fit', label, suggestions);
}

/** What the thing runs on. */
export function powerSource(
  suggestions: readonly string[] = ['Manual', 'Corded electric', 'Battery', 'Petrol', 'Diesel'],
): VariantAxis {
  return choice('power_source', 'Power source', suggestions);
}

/** Ingress protection. A closed list, because IP codes are defined. */
export function ipRating(
  suggestions: readonly string[] = ['IP20', 'IP44', 'IP54', 'IP65', 'IP66', 'IP67', 'IP68'],
): VariantAxis {
  return choice('ip_rating', 'IP rating', suggestions, { allowsCustomValues: false });
}

/** What it fits, works with or is made for. Rarely closed; usually free text. */
export function compatibility(
  suggestions: readonly string[] = [],
  label = 'Compatible with',
): VariantAxis {
  return choice('compatibility', label, suggestions);
}

/** Thickness, gauge or micron - the measurement a trade buyer asks for first. */
export function thickness(
  units: readonly string[] = ['mm', 'micron', 'gauge'],
  suggestions?: readonly string[],
): VariantAxis {
  return measure('thickness', 'Thickness', units, {
    importance: 'RECOMMENDED',
    ...(suggestions === undefined ? {} : { suggestions }),
  });
}

/** Width, for anything sold off a roll or a bar. */
export function width(
  units: readonly string[] = ['mm', 'cm', 'in'],
  suggestions?: readonly string[],
): VariantAxis {
  return measure('width', 'Width', units, {
    importance: 'RECOMMENDED',
    ...(suggestions === undefined ? {} : { suggestions }),
  });
}

/** Overall size as one measured figure, where three dimensions is too much. */
export function dimensions(
  units: readonly string[] = ['mm', 'cm', 'in', 'ft'],
  suggestions?: readonly string[],
): VariantAxis {
  return measure('dimensions', 'Dimensions', units, {
    importance: 'RECOMMENDED',
    ...(suggestions === undefined ? {} : { suggestions }),
  });
}

/** Wattage, for anything that draws power. */
export function wattage(suggestions?: readonly string[]): VariantAxis {
  return measure('power', 'Power', ['W', 'kW', 'HP'], {
    importance: 'RECOMMENDED',
    ...(suggestions === undefined ? {} : { suggestions }),
  });
}

/** Warranty term, where a seller genuinely lists the same item on two terms. */
export function warranty(
  suggestions: readonly string[] = ['6 months', '1 year', '2 years', '3 years'],
): VariantAxis {
  return choice('warranty', 'Warranty', suggestions, { inTitle: false });
}

/** Age band. A real SKU axis for toys, books and children's clothing. */
export function ageGroup(suggestions: readonly string[]): VariantAxis {
  return choice('age_group', 'Age group', suggestions);
}

/** Scent or flavour, where a seller stocks more than one of the same product. */
export function fragrance(suggestions: readonly string[], label = 'Fragrance'): VariantAxis {
  return choice('fragrance', label, suggestions);
}

/** Style, cut or silhouette. The apparel axis that is not size and not colour. */
export function style(suggestions: readonly string[], label = 'Style'): VariantAxis {
  return choice('style', label, suggestions);
}
