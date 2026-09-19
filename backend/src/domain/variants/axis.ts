/**
 * What a variant axis is, and what it is not.
 *
 * An axis is a dimension a BUYER chooses along, and every distinct combination
 * of axis values is a different thing in a different box with its own SKU,
 * price and stock. Size is an axis. Colour is an axis. Pack count is an axis,
 * because ten packets and one packet are two different things to pick, weigh
 * and ship.
 *
 * Country of origin is not an axis. Warranty wording is not an axis. Neither
 * of them changes what leaves the warehouse, and turning a fact about a
 * product into a selector is how a buyer ends up staring at a dropdown with
 * one entry in it wondering what they are supposed to decide. Those are
 * specifications - `product_attributes` - and they stay there.
 *
 * Nor is a purchasing rule an axis. A minimum of ten boxes is a term of trade
 * with this seller, not a variety of the product; it lives on the variant as a
 * number, and the buyer is told about it rather than asked to pick it.
 *
 * ---
 *
 * Everything in this file is pure. No database, no clock, no request. It is
 * the half of the variant system that the seller's matrix builder and the
 * buyer's selector have to agree on exactly - a signature computed one way on
 * the way in and another way on the way out is a duplicate combination the
 * unique index cannot see.
 */
import { createHash } from 'node:crypto';

/**
 * The width of `product_variants.optionSignature`.
 *
 * Kept beside the code that produces the value rather than left implicit in
 * the schema: a signature longer than its column is truncated on MariaDB 10.4
 * and rejected on 11.4, and this repository develops on the first and deploys
 * to the second.
 */
const MAX_SIGNATURE_LENGTH = 512;

/** How a value is captured from the seller. */
export type VariantInputType =
  | 'TEXT_SELECT'
  | 'NUMERIC'
  /** A number and a unit, held apart so 12 cm and 120 mm compare. */
  | 'MEASUREMENT'
  | 'COLOUR'
  | 'BOOLEAN'
  /** A whole count of identical sellable units grouped together. */
  | 'PACK_COUNT';

/** How the choice is drawn for the buyer. */
export type VariantDisplayType =
  | 'CHIPS'
  | 'SIZE_BUTTONS'
  | 'SWATCHES'
  | 'IMAGE_SWATCHES'
  | 'DROPDOWN'
  | 'MEASUREMENT'
  | 'PACK'
  | 'SPEC_TABLE';

/**
 * How strongly the template recommends this axis.
 *
 * Advice to the seller, never a rule enforced against them. A template says
 * "footwear is normally sold by size" because it is; it does not say that a
 * seller with one size in stock has filled the form in wrong. What the server
 * enforces is the axes the seller actually switched on - see the product
 * family's own active axis list.
 */
export type AxisImportance = 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL';

/** How the values of one axis are put in order for the buyer. */
export type AxisSortMode =
  /** 8 before 10. The sort every numeric size needs and no locale gives. */
  | 'NUMERIC'
  /** XXS, XS, S, M, L, XL, 2XL... Alphabetical puts L before M and S before XL. */
  | 'APPAREL'
  /** The order the seller typed them in. */
  | 'GIVEN'
  | 'ALPHA';

/**
 * One candidate dimension, as a template offers it.
 *
 * `suggestions` are a starting list, not a closed one: a template cannot know
 * every grit, every voltage or every shade a seller stocks, and a marketplace
 * that refuses a value it has not heard of is a marketplace nobody can list
 * on. `allowsCustomValues: false` is reserved for the handful where the set
 * genuinely is closed - a size SYSTEM is UK, EU, US or India and nothing else.
 */
export interface VariantAxis {
  /** Stable machine name. Appears in signatures and URLs, so renaming is a migration. */
  readonly key: string;
  readonly label: string;
  readonly importance: AxisImportance;
  readonly input: VariantInputType;
  readonly display: VariantDisplayType;
  /** For MEASUREMENT. The first is the default the form offers. */
  readonly units?: readonly string[];
  readonly suggestions?: readonly string[];
  readonly allowsCustomValues: boolean;
  /**
   * Whether a difference here is a different SKU.
   *
   * True for everything a template offers as an axis - that is what makes it
   * an axis. The field exists because the seller-side form shares its renderer
   * with specifications, and a shared renderer needs to be told which half of
   * the screen it is drawing.
   */
  readonly affectsSku: boolean;
  readonly isFilterable: boolean;
  /** Contributes to the generated variant name, in axis order. */
  readonly inTitle: boolean;
  readonly sortOrder: number;
  readonly sort: AxisSortMode;
  /**
   * Axes that must be chosen before this one means anything.
   *
   * "Size" depends on "Size system": a bare 8 is a different shoe in UK and in
   * EU, and offering the number before the system has been picked is offering
   * a measurement with no unit.
   */
  readonly dependsOn?: readonly string[];
  readonly helpText?: string;
}

/** A template: the candidate axes for one subcategory. */
export interface VariantTemplate {
  /** The department's slug, as `categories.slug` holds it. */
  readonly categorySlug: string;
  /** The subcategory's slug. Null for a department-wide fallback. */
  readonly subcategorySlug: string | null;
  readonly label: string;
  readonly axes: readonly VariantAxis[];
}

/** Defaults every axis gets unless the template says otherwise. */
interface AxisOptions {
  readonly importance?: AxisImportance;
  readonly input?: VariantInputType;
  readonly display?: VariantDisplayType;
  readonly units?: readonly string[];
  readonly suggestions?: readonly string[];
  readonly allowsCustomValues?: boolean;
  readonly isFilterable?: boolean;
  readonly inTitle?: boolean;
  readonly sort?: AxisSortMode;
  readonly dependsOn?: readonly string[];
  readonly helpText?: string;
}

/**
 * Build one axis.
 *
 * `sortOrder` is deliberately NOT a parameter. It is the position in the
 * template's own list, applied by `template()` below, because two numbers that
 * have to agree - the order in the array and a number beside each entry - are
 * two numbers that will one day disagree.
 */
export function axis(key: string, label: string, options: AxisOptions = {}): VariantAxis {
  const input = options.input ?? 'TEXT_SELECT';

  return {
    key,
    label,
    importance: options.importance ?? 'OPTIONAL',
    input,
    display: options.display ?? defaultDisplayFor(input),
    ...(options.units === undefined ? {} : { units: options.units }),
    ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
    allowsCustomValues: options.allowsCustomValues ?? true,
    affectsSku: true,
    isFilterable: options.isFilterable ?? true,
    inTitle: options.inTitle ?? true,
    sortOrder: 0,
    sort: options.sort ?? (input === 'NUMERIC' || input === 'MEASUREMENT' ? 'NUMERIC' : 'GIVEN'),
    ...(options.dependsOn === undefined ? {} : { dependsOn: options.dependsOn }),
    ...(options.helpText === undefined ? {} : { helpText: options.helpText }),
  };
}

function defaultDisplayFor(input: VariantInputType): VariantDisplayType {
  switch (input) {
    case 'COLOUR':
      return 'SWATCHES';
    case 'MEASUREMENT':
      return 'MEASUREMENT';
    case 'PACK_COUNT':
      return 'PACK';
    case 'NUMERIC':
      return 'SIZE_BUTTONS';
    case 'BOOLEAN':
    case 'TEXT_SELECT':
      return 'CHIPS';
  }
}

/** Assemble a template, numbering its axes from their position in the list. */
export function template(
  categorySlug: string,
  subcategorySlug: string | null,
  label: string,
  axes: readonly VariantAxis[],
): VariantTemplate {
  return Object.freeze({
    categorySlug,
    subcategorySlug,
    label,
    axes: Object.freeze(axes.map((entry, index) => Object.freeze({ ...entry, sortOrder: index }))),
  });
}

// ---------------------------------------------------------------------------
// NORMALISATION AND SIGNATURES
// ---------------------------------------------------------------------------

/**
 * The comparable form of a value the seller typed.
 *
 * Case folded, accents stripped, every run of anything that is not a letter or
 * a digit collapsed to a single hyphen. "UK 8", "uk-8" and "Uk  8" are one
 * value; "Navy Blue" and "navy blue" are one colour.
 *
 * What it must NOT do is travel back to the buyer. The seller wrote "2.5 mm2"
 * and that is what the page says; this produces "2-5-mm2" and that is what the
 * unique index compares. Displaying the normalised form is how a catalogue
 * starts shouting SIZE-UK-8 at people.
 */
export function normaliseValue(value: string): string {
  return value
    .normalize('NFKD')
    // Combining marks, so an accented letter folds to its base rather than
    // surviving as the base plus a mark that then becomes a hyphen.
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    // Letters that are not an accented Latin base and therefore do NOT
    // decompose. Without this, a German "Größe" folds to "gro-e" - which
    // collides with "Gro E" and reads as two values where there is one. This
    // storefront sells in eight languages; leaving them to become separators
    // is a real collision, not a theoretical one.
    .replace(/ß/g, 'ss')
    .replace(/æ/g, 'ae')
    .replace(/œ/g, 'oe')
    .replace(/ø/g, 'o')
    .replace(/đ|ð/g, 'd')
    .replace(/ł/g, 'l')
    .replace(/þ/g, 'th')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The same folding for an axis key, so a hand-typed key cannot collide. */
export function normaliseAxisKey(key: string): string {
  return normaliseValue(key).replace(/-/g, '_');
}

/** One chosen value, as it is displayed and as it compares. */
export interface OptionValue {
  readonly axisKey: string;
  /** Exactly what the seller typed. Never derived from the normalised form. */
  readonly label: string;
  /** For a MEASUREMENT axis: the number and the unit, held apart. */
  readonly amount?: string | null;
  readonly unit?: string | null;
}

/**
 * What one value reads as on its own.
 *
 * A measurement is its number and its unit with a space between - "2.5 mm2" -
 * because a number with the unit welded on is a value nobody can sort and a
 * unit nobody can change.
 */
export function measurementText(value: OptionValue): string {
  if (value.amount === undefined || value.amount === null || value.amount === '') {
    return value.label;
  }
  const unit = value.unit ?? '';
  return unit === '' ? value.amount : `${value.amount} ${unit}`;
}

/**
 * The deterministic identity of one combination.
 *
 * `colour:black|size:8|size_system:uk` - axes sorted by key, values
 * normalised, joined with a pipe. Two sellers typing "Black" and "black"
 * produce the same signature and the unique index on (productId,
 * optionSignature) refuses the second, which is the whole point: a duplicate
 * combination is two rows the resolver cannot choose between, and the buyer
 * gets whichever one the query planner happened to return.
 *
 * Sorted by key rather than by the template's own order on purpose. The
 * template can gain an axis, lose one or reorder them next month; a signature
 * that moved when it did would orphan every row already stored.
 */
export function optionSignature(values: readonly OptionValue[]): string {
  const parts = values
    .map((value) => ({
      key: normaliseAxisKey(value.axisKey),
      value: normaliseValue(measurementText(value)),
    }))
    .filter((part) => part.key !== '' && part.value !== '');

  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part.key)) {
      throw new Error(`Axis "${part.key}" appears twice in one combination.`);
    }
    seen.add(part.key);
  }

  const full = parts
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((part) => `${part.key}:${part.value}`)
    .join('|');

  if (full.length <= MAX_SIGNATURE_LENGTH) return full;

  /*
   * Too long for its column, so shortened WITHOUT becoming ambiguous.
   *
   * `product_variants.optionSignature` is VARCHAR(512) and five axes of long
   * values overrun it. Plain truncation is the obvious fix and the wrong one:
   * two combinations that agree for the first 512 characters and differ after
   * would fold to one string, and the unique index would reject the second as
   * a duplicate of a combination it is not.
   *
   * Development runs MariaDB 10.4, which truncates silently; production runs
   * 11.4, which rejects the insert. So the untreated version of this is a bug
   * that cannot be reproduced on the machine it was written on - it either
   * corrupts quietly or fails loudly depending on which database you are
   * standing in front of.
   *
   * A prefix plus a digest of the WHOLE value keeps it readable, keeps it
   * deterministic, and keeps it unique: two different combinations differ in
   * the digest even where the prefix matches.
   */
  const digest = createHash('sha256').update(full).digest('hex').slice(0, 16);
  return `${full.slice(0, MAX_SIGNATURE_LENGTH - digest.length - 1)}~${digest}`;
}

/** The option values of one variant, keyed by axis, as the database holds them. */
export type OptionMap = Readonly<Record<string, string>>;

/** Signature from the plain `{ axis: value }` shape `optionsJson` stores. */
export function signatureOfMap(options: OptionMap): string {
  return optionSignature(
    Object.entries(options).map(([axisKey, label]) => ({ axisKey, label })),
  );
}

// ---------------------------------------------------------------------------
// SORTING
// ---------------------------------------------------------------------------

/**
 * Apparel sizes in the order a rail hangs them.
 *
 * Alphabetical gives L, M, S, XL - which is not a size run, it is a word list.
 * Anything not named here sorts after everything named, alphabetically, so a
 * seller's "One Size" or "Tall" lands predictably at the end rather than
 * scattering the run.
 */
const APPAREL_ORDER: readonly string[] = Object.freeze([
  'xxxs',
  '3xs',
  'xxs',
  '2xs',
  'xs',
  's',
  'small',
  'm',
  'medium',
  'l',
  'large',
  'xl',
  'x-large',
  'xxl',
  '2xl',
  'xxxl',
  '3xl',
  '4xl',
  'xxxxl',
  '5xl',
  '6xl',
  '7xl',
  '8xl',
]);

/**
 * The leading number in a value, or null.
 *
 * "8" gives 8 and "2.5 mm" gives 2.5. "UK 8" gives null deliberately: the
 * number that sorts a size run is the one the value STARTS with, and a value
 * whose first token is a word is not a number however many digits follow it.
 * The size system belongs on its own axis, which is why it has one.
 */
function leadingNumber(value: string): number | null {
  const match = /^\s*(-?\d+(?:[.,]\d+)?)/.exec(value);
  const digits = match?.[1];
  if (digits === undefined) return null;
  const parsed = Number(digits.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

/** Order one axis's values for display. Stable: ties keep their given order. */
export function sortAxisValues(values: readonly string[], mode: AxisSortMode): string[] {
  const indexed = values.map((value, index) => ({ value, index }));

  const compare = (
    left: { value: string; index: number },
    right: { value: string; index: number },
  ): number => {
    switch (mode) {
      case 'GIVEN':
        return left.index - right.index;
      case 'ALPHA':
        return left.value.localeCompare(right.value) || left.index - right.index;
      case 'NUMERIC': {
        const a = leadingNumber(left.value);
        const b = leadingNumber(right.value);
        // A value with no number sorts after every value with one, rather than
        // being read as zero and jumping to the front of the run.
        if (a === null && b === null) {
          return left.value.localeCompare(right.value) || left.index - right.index;
        }
        if (a === null) return 1;
        if (b === null) return -1;
        return a - b || left.value.localeCompare(right.value) || left.index - right.index;
      }
      case 'APPAREL': {
        const a = APPAREL_ORDER.indexOf(normaliseValue(left.value));
        const b = APPAREL_ORDER.indexOf(normaliseValue(right.value));
        if (a === -1 && b === -1) {
          return left.value.localeCompare(right.value) || left.index - right.index;
        }
        if (a === -1) return 1;
        if (b === -1) return -1;
        return a - b;
      }
    }
  };

  return indexed.sort(compare).map((entry) => entry.value);
}

// ---------------------------------------------------------------------------
// SKU GENERATION
// ---------------------------------------------------------------------------

/**
 * A short, stable code for one value, for use inside a SKU.
 *
 * Uppercase, alphanumeric, at most six characters. Not reversible and not
 * meant to be: a SKU is an identifier, and a buyer reading "BLK" off a label
 * is reading a hint, not a specification. What matters is that the same value
 * always produces the same code, so re-running generation over an unchanged
 * matrix produces the SKUs that are already stored.
 */
export function skuToken(value: string): string {
  const cleaned = normaliseValue(value).replace(/-/g, '').toUpperCase();
  return cleaned.slice(0, 6);
}

export interface SkuPattern {
  /** The seller's or operator's own prefix, e.g. "UB". Optional. */
  readonly prefix?: string | null;
  /** The product family's code - usually the product SKU. */
  readonly productCode: string;
  readonly separator?: string;
}

/**
 * `{prefix}-{product-code}-{option-codes}`, deterministically.
 *
 * Axis order inside the SKU is the SIGNATURE's order - axes sorted by key -
 * and not the template's, for exactly the reason the signature is: a template
 * that reorders its axes must not change the SKU of a variant that already
 * exists on a picking label.
 *
 * Collisions are possible - two long values can share six characters - and
 * they are not resolved here. The caller holds the set of SKUs already taken,
 * so it is the only thing that can disambiguate without guessing; see
 * `generateSkus`.
 */
export function generateSku(pattern: SkuPattern, values: readonly OptionValue[]): string {
  const separator = pattern.separator ?? '-';
  const head = [pattern.prefix, pattern.productCode]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .map((part) => part.trim().toUpperCase());

  const tokens = values
    .map((value) => ({
      key: normaliseAxisKey(value.axisKey),
      token: skuToken(measurementText(value)),
    }))
    .filter((entry) => entry.token !== '')
    .sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
    .map((entry) => entry.token);

  return [...head, ...tokens].join(separator).slice(0, 64);
}

/**
 * SKUs for a whole matrix, with collisions broken by a numeric suffix.
 *
 * `taken` is every SKU already in use - product SKUs and variant SKUs share
 * one namespace in this database, so a scanner cannot tell them apart and
 * neither may this. It is mutated as it goes, so two rows in the same batch
 * cannot both take the same code.
 */
export function generateSkus(
  pattern: SkuPattern,
  combinations: readonly (readonly OptionValue[])[],
  taken: Set<string>,
): string[] {
  return combinations.map((values) => {
    const base = generateSku(pattern, values);
    if (!taken.has(base)) {
      taken.add(base);
      return base;
    }

    for (let suffix = 2; suffix < 1000; suffix += 1) {
      const candidate = `${base.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }

    throw new Error(`Could not find a free SKU for "${base}".`);
  });
}

// ---------------------------------------------------------------------------
// COMBINATIONS
// ---------------------------------------------------------------------------

/** The values a seller entered for one axis, in the order they entered them. */
export interface AxisValues {
  readonly axisKey: string;
  readonly values: readonly OptionValue[];
}

/**
 * The ceiling on one generated matrix.
 *
 * Four axes of six values each is 1,296 rows, and a seller who meant to type
 * six sizes and typed six of everything has just been handed a table they
 * cannot check. The number is not a database limit - it is the point past
 * which nobody reads the result before saving it.
 */
export const MAX_GENERATED_COMBINATIONS = 500;

/** Beyond this the caller is expected to ask the seller to confirm first. */
export const COMBINATION_WARNING_THRESHOLD = 100;

/** How many rows a given set of axes would produce, without producing them. */
export function countCombinations(axes: readonly AxisValues[]): number {
  return axes
    .filter((entry) => entry.values.length > 0)
    .reduce((total, entry) => total * entry.values.length, 1);
}

/**
 * The Cartesian product, in a stable order.
 *
 * The LAST axis varies fastest, which is what makes a generated table read as
 * a table: every size of black, then every size of brown. Reversing that gives
 * a list that looks shuffled to the person checking it.
 */
export function generateCombinations(axes: readonly AxisValues[]): OptionValue[][] {
  const usable = axes.filter((entry) => entry.values.length > 0);
  if (usable.length === 0) return [];

  const total = countCombinations(usable);
  if (total > MAX_GENERATED_COMBINATIONS) {
    throw new Error(
      `${total} combinations is more than the ${MAX_GENERATED_COMBINATIONS} this can generate at once.`,
    );
  }

  let rows: OptionValue[][] = [[]];
  for (const entry of usable) {
    const next: OptionValue[][] = [];
    for (const row of rows) {
      for (const value of entry.values) {
        next.push([...row, value]);
      }
    }
    rows = next;
  }

  return rows;
}

/** Signatures appearing more than once in a proposed matrix. */
export function duplicateSignatures(combinations: readonly (readonly OptionValue[])[]): string[] {
  const counts = new Map<string, number>();
  for (const values of combinations) {
    const signature = optionSignature(values);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([signature]) => signature);
}

/**
 * The name a generated variant carries.
 *
 * Only the axes the template marks `inTitle`, in template order, joined with a
 * slash. "Black / UK 8 / Wide" - which is how a picker reads it off a label
 * and how a buyer recognises the line on their order.
 */
export function variantDisplayName(
  axes: readonly VariantAxis[],
  values: readonly OptionValue[],
): string {
  const byKey = new Map(values.map((value) => [normaliseAxisKey(value.axisKey), value]));

  return axes
    .filter((entry) => entry.inTitle)
    .map((entry) => byKey.get(normaliseAxisKey(entry.key)))
    .filter((value): value is OptionValue => value !== undefined)
    .map((value) => measurementText(value))
    .join(' / ');
}
