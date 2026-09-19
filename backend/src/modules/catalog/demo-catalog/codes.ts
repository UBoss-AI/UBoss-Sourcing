/**
 * The codes a demonstration product is known by.
 *
 * A SKU on this catalogue has four jobs and they pull against each other. It
 * has to be UNIQUE, because the column says so. It has to be STABLE, or a
 * second run of the seed renames every line on every purchase order somebody
 * printed from the first. It has to be READABLE, because in B2B purchasing the
 * code is what a buyer checks a card against, not the name. And it has to be
 * OBVIOUSLY NOT REAL, because a demonstration SKU that looks like a supplier's
 * own is one that ends up typed into a genuine system.
 *
 * `DEMO-` answers the last of those and answers it first. Everything after it
 * is derived from the blueprint's key and its chosen options, so the same
 * blueprint always produces the same code and two blueprints cannot produce
 * one.
 *
 *     DEMO-TOOL-CRDRL-18V-50AH-2BAT
 *     DEMO-CLTH-TSHRT-BLK-M
 *     DEMO-SAFE-SFTBT-UK8-BLK
 *
 * What it is NOT is a barcode. Nothing here writes a GTIN, an EAN or a UPC,
 * and nothing ever should: those are issued by GS1 against a real company
 * prefix, and a fabricated one is a number that belongs to somebody else.
 */
import { hashString } from './rng.js';

/** MariaDB's `products.sku` and `product_variants.sku` are both VARCHAR(64). */
const MAX_SKU_LENGTH = 64;

/** `products.slug` is VARCHAR(255), and `slugify` already caps at 200. */
const MAX_SLUG_LENGTH = 200;

/**
 * Four letters per department, written down rather than derived.
 *
 * Derivation gives `ELEC` to both "Electrical & Lighting" and "Electronics &
 * Components", and a buyer holding two lines that differ in the third
 * character has a filing problem the code was supposed to solve. An
 * unrecognised department falls back to the derivation below, which is correct
 * for an operator who has added a department of their own and simply not as
 * carefully chosen.
 */
const DEPARTMENT_CODES: Readonly<Record<string, string>> = Object.freeze({
  'medical-devices': 'MEDX',
  'laboratory-scientific': 'LABS',
  'industrial-supplies': 'INDS',
  'tools-hardware': 'TOOL',
  'electrical-lighting': 'ELEC',
  'electronics-components': 'ECMP',
  'computers-it': 'COMP',
  'phones-communication': 'PHON',
  'office-stationery': 'OFFC',
  'packaging-shipping': 'PACK',
  'safety-protective-equipment': 'SAFE',
  'cleaning-hygiene': 'CLEN',
  'building-construction': 'BULD',
  'automotive-transport': 'AUTO',
  'agriculture-gardening': 'AGRI',
  'food-service-catering': 'FOOD',
  'furniture-fixtures': 'FURN',
  'home-kitchen': 'HOME',
  'clothing-textiles': 'CLTH',
  'beauty-personal-care': 'BEAU',
  'sports-outdoors': 'SPRT',
  'toys-hobbies-crafts': 'TOYS',
  'books-media': 'BOOK',
  'chemicals-raw-materials': 'CHEM',
  'energy-environment': 'ENGY',
});

/** The four-letter code for a department, by slug. */
export function departmentCode(slug: string): string {
  const known = DEPARTMENT_CODES[slug];
  if (known !== undefined) return known;

  const letters = slug.replace(/[^a-z]/g, '').toUpperCase();
  return letters.length >= 4 ? letters.slice(0, 4) : letters.padEnd(4, 'X');
}

/**
 * A short code from a blueprint key or an option value.
 *
 * Vowels after the first character go first, because a buyer reading `CRDRL`
 * recovers "cordless drill" and one reading `CORDL` does not recover anything
 * the next code does not also start with. Digits are never dropped - `18V` and
 * `36V` differ only in them.
 */
export function shortCode(value: string, maxLength: number): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');

  if (cleaned.length <= maxLength) return cleaned;

  // Keep the first character whatever it is, then drop vowels from the rest.
  const head = cleaned.slice(0, 1);
  const squeezed = head + cleaned.slice(1).replace(/[AEIOU]/g, '');

  return (squeezed.length >= 2 ? squeezed : cleaned).slice(0, maxLength);
}

/**
 * The family code every SKU under one blueprint shares.
 *
 * `DEMO-TOOL-CRDRL`. The variant SKUs hang their option codes off it, so a
 * warehouse sorting by code finds a product's sizes together.
 */
export function productSku(departmentSlug: string, blueprintKey: string): string {
  return `DEMO-${departmentCode(departmentSlug)}-${shortCode(blueprintKey, 10)}`;
}

/**
 * One variant's code, and the guarantee that no two of them collide.
 *
 * Two different option sets can abbreviate to one string - "Blue" and "Black"
 * both want `BL` at two characters - and a collision is not a cosmetic
 * problem: `product_variants.sku` is UNIQUE across the whole catalogue, so the
 * second insert fails and takes the product with it.
 *
 * So a collision is resolved rather than hoped against, with four hex
 * characters of the full option signature. Deterministic, so the SKU a
 * colliding variant gets on the first run is the SKU it gets on every run
 * after - which is the property that matters, because a code that changes is
 * worse than a code that is ugly.
 *
 * `taken` is the set of codes already issued ON THIS RUN, in the order the
 * generator produces them. That order is itself fixed by the blueprint, so the
 * same variant wins the plain code every time.
 */
export function variantSku(
  familySku: string,
  optionValues: readonly string[],
  signature: string,
  taken: Set<string>,
): string {
  const parts = optionValues.map((value) => shortCode(value, 6)).filter((part) => part !== '');
  const base = [familySku, ...parts].join('-').slice(0, MAX_SKU_LENGTH);

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  const digest = hashString(signature).toString(16).padStart(8, '0').slice(0, 4).toUpperCase();
  const suffixed = `${base.slice(0, MAX_SKU_LENGTH - 5)}-${digest}`;

  if (!taken.has(suffixed)) {
    taken.add(suffixed);
    return suffixed;
  }

  // Two different signatures sharing four hex characters AND an abbreviation.
  // Vanishingly unlikely and still handled, because "vanishingly unlikely"
  // applied to nine thousand variants is a run that fails on somebody else's
  // machine and not on this one.
  for (let attempt = 2; ; attempt += 1) {
    const numbered = `${base.slice(0, MAX_SKU_LENGTH - 3)}-${String(attempt)}`;
    if (!taken.has(numbered)) {
      taken.add(numbered);
      return numbered;
    }
  }
}

/**
 * A URL slug for a demonstration product.
 *
 * `demo-` prefixed for the same reason the SKU is: the slug is in the address
 * bar of every screenshot anybody takes of this catalogue, and a URL that
 * says what it is stops a demonstration page being mistaken for a live one.
 *
 * `taken` carries the slugs already issued, because two blueprints can quite
 * reasonably produce one title - a 500 ml and a 1 L of the same thing - and
 * `products.slug` is UNIQUE.
 */
export function productSlug(title: string, blueprintKey: string, taken: Set<string>): string {
  const base = `demo-${title}`
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SLUG_LENGTH);

  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }

  const keyed = `${base}-${shortCode(blueprintKey, 8).toLowerCase()}`.slice(0, MAX_SLUG_LENGTH);
  if (!taken.has(keyed)) {
    taken.add(keyed);
    return keyed;
  }

  for (let attempt = 2; ; attempt += 1) {
    const numbered = `${base.slice(0, MAX_SLUG_LENGTH - 4)}-${String(attempt)}`;
    if (!taken.has(numbered)) {
      taken.add(numbered);
      return numbered;
    }
  }
}
