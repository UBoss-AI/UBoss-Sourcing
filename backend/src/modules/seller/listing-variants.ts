/**
 * The variants a seller describes while they are listing.
 *
 * `domain/variants/` knows what a shelf looks like - that footwear is sold
 * along a size system and a size and a width, that a laptop is sold along RAM
 * and storage. `catalog/variant-matrix.service.ts` applies that to a product
 * that already exists, which is the admin's job. This file is the third
 * corner: a seller filling in the wizard, before there is a product at all.
 *
 * The difference matters more than it looks. The admin edits rows that are
 * already selling, so every write is immediately real and is validated as
 * such. A draft is the opposite - it is a form the seller leaves half-finished
 * for three days, and refusing to save it until it is correct would make it
 * useless. So nothing here throws on incomplete work. It NORMALISES what the
 * seller typed and REPORTS what is still wrong, as the same `ListingIssue`
 * shape every other section of the wizard produces, and the draft saves
 * either way. Only submission is gated, and it is gated by the issues.
 *
 * ---
 *
 * WHAT IS TRUSTED FROM THE CLIENT, AND WHAT IS NOT
 *
 * The option signature is not. It is the thing that decides whether two rows
 * are the same combination, and a client that computes it itself - or simply
 * sends the same string twice - could put two rows on one product that the
 * unique index on `(productId, optionSignature)` will later reject halfway
 * through an approval. It is recomputed here from the option values on every
 * save, by the same `signatureOfMap` the catalogue uses, so the seller's
 * matrix and the catalogue's index can never disagree about what a duplicate
 * is.
 *
 * The labels ARE trusted, after trimming. A seller who writes "Navy blue"
 * rather than "Navy" is describing their own stock and the catalogue's job is
 * to record it, not to correct it. Normalisation is for MATCHING only:
 * "XL" and "xl" are one combination, and both keep the spelling they were
 * given for display.
 */
import { ErrorCode } from '../../domain/errors.js';
import {
  COMBINATION_WARNING_THRESHOLD,
  MAX_GENERATED_COMBINATIONS,
  countCombinations,
  generateCombinations,
  generateSku,
  measurementText,
  normaliseAxisKey,
  signatureOfMap,
  variantDisplayName,
  type AxisValues,
  type OptionValue,
  type VariantAxis,
  type VariantTemplate,
} from '../../domain/variants/axis.js';
import type { ListingIssue } from '../../domain/listing-completeness.js';
import { findAxis } from '../../domain/variants/registry.js';

// ---------------------------------------------------------------------------
// What a draft stores
// ---------------------------------------------------------------------------

/** One axis the seller switched on, with the values they offer on it. */
export interface DraftVariantAxis {
  axisKey: string;
  /** In the order the seller arranged them. Reordering is meaningful. */
  values: { label: string; amount?: string | null; unit?: string | null }[];
}

/** Stock for one combination in one of the seller's warehouses. */
export interface DraftVariantStock {
  locationId: string;
  availableQuantity: number;
}

/**
 * One combination the seller approved, with its own terms of trade.
 *
 * Every commercial field is optional and nullable, and that is not laziness:
 * a matrix is filled in column by column - all the SKUs, then all the prices,
 * then the stock - and a row with a SKU and no price yet is a normal state of
 * a draft, reported as an issue rather than refused.
 */
export interface DraftVariantRow {
  /** Recomputed server-side from `options`. Whatever arrives is discarded. */
  optionSignature: string;
  /** Axis key -> the label the seller chose, as they spelled it. */
  options: Record<string, string>;
  name: string;
  sku: string;
  barcode?: string | null;
  isActive: boolean;

  priceMinor?: string | null;
  compareAtPriceMinor?: string | null;

  minOrderQty?: number | null;
  qtyIncrement?: number | null;
  maxOrderQty?: number | null;
  leadTimeDays?: number | null;

  multipackCount?: number | null;
  netContentValue?: string | null;
  netContentUnit?: string | null;

  shippingWeightGrams?: number | null;
  shippingLengthMm?: number | null;
  shippingWidthMm?: number | null;
  shippingHeightMm?: number | null;

  stock: DraftVariantStock[];
  mediaId?: string | null;
}

/**
 * Whether this listing has variants at all, and which.
 *
 * `null` axes and `null` rows mean the seller has not answered the question
 * yet. An EMPTY axes array means they answered "one configuration only" - the
 * wizard stops asking, and approval creates the single default variant every
 * product must have. The two states are genuinely different and collapsing
 * them would make the wizard nag a seller who already said no.
 */
export interface DraftVariants {
  axes: DraftVariantAxis[] | null;
  rows: DraftVariantRow[] | null;
}

// ---------------------------------------------------------------------------
// Reading what is stored
// ---------------------------------------------------------------------------

function asArray<T>(value: unknown): T[] | null {
  return Array.isArray(value) ? (value as T[]) : null;
}

/** The axes and rows a draft row holds, narrowed out of its JSON columns. */
export function readDraftVariants(
  variantAxesJson: unknown,
  variantsJson: unknown,
): DraftVariants {
  const container =
    variantAxesJson !== null && typeof variantAxesJson === 'object' && !Array.isArray(variantAxesJson)
      ? (variantAxesJson as { axes?: unknown })
      : null;

  return {
    axes: container === null ? null : asArray<DraftVariantAxis>(container.axes),
    rows: asArray<DraftVariantRow>(variantsJson),
  };
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

const MAX_AXES = 5;
const MAX_VALUES_PER_AXIS = 60;

/** The width of `product_variants.name`. */
const MAX_VARIANT_NAME = 255;

/**
 * The name to store for one combination, bounded to its column.
 *
 * Falls back to the option values joined together, because a row whose name
 * the seller never typed still has to be recognisable on a picking list.
 *
 * TRUNCATED DELIBERATELY, and unlike the signature it is safe to truncate:
 * a name is for a person to read and nothing keys off it. The signature is
 * the identity and carries its own bounding.
 *
 * It has to be bounded at all because five axes of long values overrun 255,
 * and MariaDB 10.4 - which this repository develops on - truncates silently
 * where 11.4, which it deploys to, rejects the insert. An unbounded join is
 * therefore a bug that cannot be reproduced on the machine that wrote it.
 */
export function variantNameOf(row: {
  name?: string | null;
  options: Record<string, string>;
}): string {
  const given = (row.name ?? '').trim();
  const name = given === '' ? Object.values(row.options).join(' / ') : given;
  return name.slice(0, MAX_VARIANT_NAME);
}

/**
 * Clean up the axes a seller sent, and drop what cannot be used.
 *
 * Dropping rather than refusing, throughout. A blank row in the value editor
 * is not a choice the seller made, it is a row they have not filled in yet,
 * and turning it into a validation error would stop the autosave that the
 * wizard depends on. An axis the template does not offer is the one exception
 * worth reporting, because it means the seller changed category and the form
 * is now showing them something that will silently vanish.
 */
export function normaliseAxes(
  template: VariantTemplate | null,
  axes: readonly DraftVariantAxis[],
): { axes: DraftVariantAxis[]; unknownKeys: string[] } {
  const unknownKeys: string[] = [];
  const seen = new Set<string>();
  const result: DraftVariantAxis[] = [];

  for (const entry of axes.slice(0, MAX_AXES)) {
    const key = normaliseAxisKey(entry.axisKey ?? '');
    if (key === '' || seen.has(key)) continue;

    // A category with no template is a supported state - an operator invented
    // the shelf, or it is Medical Devices, which authors its options free-form
    // on purpose. The seller then gets to name their own axes and nothing is
    // checked against a list, which is the only behaviour that lets somebody
    // sell a thing we did not anticipate.
    if (template !== null && findAxis(template, key) === null) {
      unknownKeys.push(key);
      continue;
    }

    const values: DraftVariantAxis['values'] = [];
    const seenValues = new Set<string>();

    for (const value of (entry.values ?? []).slice(0, MAX_VALUES_PER_AXIS)) {
      const label = (value?.label ?? '').trim();
      const amount = value?.amount === null || value?.amount === undefined ? null : String(value.amount).trim();
      const unit = value?.unit === null || value?.unit === undefined ? null : String(value.unit).trim();

      const text = measurementText({ axisKey: key, label, ...(amount === null ? {} : { amount }), ...(unit === null ? {} : { unit }) });
      if (text === '') continue;

      // "XL" and "xl" are one choice. The first spelling wins, because it is
      // the one the seller typed first and re-casing their own catalogue
      // behind their back is not this function's job.
      const fingerprint = text.toLowerCase();
      if (seenValues.has(fingerprint)) continue;
      seenValues.add(fingerprint);

      values.push({ label, ...(amount === null ? {} : { amount }), ...(unit === null ? {} : { unit }) });
    }

    seen.add(key);
    result.push({ axisKey: key, values });
  }

  return { axes: result, unknownKeys };
}

function toAxisValues(axes: readonly DraftVariantAxis[]): AxisValues[] {
  return axes.map((axis) => ({
    axisKey: axis.axisKey,
    values: axis.values.map<OptionValue>((value) => ({
      axisKey: axis.axisKey,
      label: value.label,
      ...(value.amount === null || value.amount === undefined ? {} : { amount: value.amount }),
      ...(value.unit === null || value.unit === undefined ? {} : { unit: value.unit }),
    })),
  }));
}

/**
 * Re-key every row against the options it carries.
 *
 * The signature is recomputed, the row is dropped if it has no options at all,
 * and two rows that fold to the same signature are collapsed to the first -
 * which is what stops a seller who duplicated a row from discovering the
 * problem at approval, when it would be a failed transaction rather than a
 * warning on a form.
 */
export function normaliseRows(rows: readonly DraftVariantRow[]): {
  rows: DraftVariantRow[];
  duplicateSignatures: string[];
} {
  const bySignature = new Map<string, DraftVariantRow>();
  const duplicateSignatures: string[] = [];

  for (const row of rows.slice(0, MAX_GENERATED_COMBINATIONS)) {
    const options: Record<string, string> = {};
    for (const [key, value] of Object.entries(row.options ?? {})) {
      const axisKey = normaliseAxisKey(key);
      const label = typeof value === 'string' ? value.trim() : '';
      if (axisKey === '' || label === '') continue;
      options[axisKey] = label;
    }

    if (Object.keys(options).length === 0) continue;

    const optionSignature = signatureOfMap(options);

    if (bySignature.has(optionSignature)) {
      duplicateSignatures.push(optionSignature);
      continue;
    }

    bySignature.set(optionSignature, {
      ...row,
      options,
      optionSignature,
      sku: (row.sku ?? '').trim(),
      name: (row.name ?? '').trim(),
      barcode: row.barcode === null || row.barcode === undefined ? null : String(row.barcode).trim(),
      isActive: row.isActive !== false,
      stock: (row.stock ?? [])
        .filter((entry) => typeof entry?.locationId === 'string' && entry.locationId !== '')
        .map((entry) => ({
          locationId: entry.locationId,
          availableQuantity: Math.max(0, Math.trunc(Number(entry.availableQuantity) || 0)),
        })),
    });
  }

  return { rows: [...bySignature.values()], duplicateSignatures };
}

// ---------------------------------------------------------------------------
// Generating the matrix
// ---------------------------------------------------------------------------

export interface MatrixProjection {
  total: number;
  warnAbove: number;
  maximum: number;
  exceedsMaximum: boolean;
}

/** How many combinations these axes would produce, without producing them. */
export function projectMatrix(axes: readonly DraftVariantAxis[]): MatrixProjection {
  const total = countCombinations(toAxisValues(axes));
  return {
    total,
    warnAbove: COMBINATION_WARNING_THRESHOLD,
    maximum: MAX_GENERATED_COMBINATIONS,
    exceedsMaximum: total > MAX_GENERATED_COMBINATIONS,
  };
}

/**
 * `base`, or the first free `base-2`, `base-3`, ... after it.
 *
 * `taken` is mutated, so two rows generated in the same pass cannot both
 * claim one code. Upper-cased throughout because a SKU printed on a label and
 * the same SKU typed into a search box differ in case all the time, and
 * treating those as two codes is how a picker is sent to the wrong bin.
 */
function nextFreeSku(base: string, taken: Set<string>): string {
  const upper = base.toUpperCase();

  if (!taken.has(upper)) {
    taken.add(upper);
    return base;
  }

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
    if (!taken.has(candidate.toUpperCase())) {
      taken.add(candidate.toUpperCase());
      return candidate;
    }
  }

  // A thousand rows folding to one token is not reachable from a matrix
  // capped at 500 combinations, but returning a duplicate silently would be
  // worse than an empty cell the seller is asked to fill in.
  return '';
}

export interface GenerateOptions {
  /** Rows the seller has already edited. Matched by signature and KEPT. */
  existing?: readonly DraftVariantRow[];
  /**
   * The template's axes, for naming.
   *
   * A generated row is named from the axes the template marks `inTitle`, in
   * template order - "Black / UK 8 / Wide". Empty for a category with no
   * template, where every chosen value goes into the name instead, because
   * there is nothing that says which of them are the distinguishing ones.
   */
  templateAxes?: readonly VariantAxis[];
  /** The seller's own code for the family. Generated SKUs hang off it. */
  productCode?: string | null;
  /** An optional short seller prefix, e.g. "UB". */
  skuPrefix?: string | null;
}

/**
 * Build the rows for every combination these axes allow.
 *
 * Existing rows win. A seller who has priced forty combinations and then adds
 * one more colour gets ten new blank rows and forty untouched ones - anything
 * else would throw away an afternoon's typing, which is the single most
 * expensive bug a matrix builder can have.
 *
 * The seller is expected to then DELETE the combinations they do not stock.
 * That is the whole point of generating into a draft rather than into the
 * catalogue: "black in 8" and "black in 8 but we never made it" have to be
 * distinguishable, and the only person who knows the difference is the seller.
 */
export function generateMatrix(
  axes: readonly DraftVariantAxis[],
  options: GenerateOptions = {},
): { rows: DraftVariantRow[]; projection: MatrixProjection } {
  const projection = projectMatrix(axes);
  if (projection.total === 0 || projection.exceedsMaximum) {
    return { rows: [...(options.existing ?? [])], projection };
  }

  const existingBySignature = new Map(
    (options.existing ?? []).map((row) => [row.optionSignature, row]),
  );

  const productCode = (options.productCode ?? '').trim();
  const prefix = (options.skuPrefix ?? '').trim();
  const templateAxes = options.templateAxes ?? [];
  const combinations = generateCombinations(toAxisValues(axes));

  // Every SKU already spoken for in this matrix, so `generateSkus`-style
  // collision breaking can be applied row by row. Two long values can fold to
  // the same six characters, and two rows sharing a code is the one thing a
  // warehouse cannot recover from.
  const taken = new Set(
    (options.existing ?? [])
      .map((row) => row.sku.trim().toUpperCase())
      .filter((sku) => sku !== ''),
  );

  const rows = combinations.map<DraftVariantRow>((combination) => {
    const optionMap: Record<string, string> = {};
    for (const value of combination) optionMap[value.axisKey] = measurementText(value);

    const optionSignature = signatureOfMap(optionMap);
    const kept = existingBySignature.get(optionSignature);
    if (kept !== undefined) return kept;

    const name =
      templateAxes.length === 0
        ? combination.map((value) => measurementText(value)).join(' / ')
        : variantDisplayName(templateAxes, combination);

    return {
      optionSignature,
      options: optionMap,
      // A name is what the seller and the picker read. Falling back to the
      // raw values rather than leaving it blank, because a template whose
      // `inTitle` axes the seller did not switch on would otherwise produce a
      // matrix of nameless rows.
      name: name === '' ? combination.map((value) => measurementText(value)).join(' / ') : name,
      sku:
        productCode === ''
          ? ''
          : nextFreeSku(generateSku({ prefix, productCode }, combination), taken),
      barcode: null,
      isActive: true,
      stock: [],
    };
  });

  return { rows, projection };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SECTION = 'PRICE_STOCK_SHIPPING' as const;

function issue(
  severity: ListingIssue['severity'],
  code: string,
  message: string,
  attributeKey: string,
): ListingIssue {
  return { severity, code, section: SECTION, attributeKey, message };
}

export interface ValidateVariantsInput {
  axes: readonly DraftVariantAxis[] | null;
  rows: readonly DraftVariantRow[] | null;
  /** Active axis keys the template does not offer, from `normaliseAxes`. */
  unknownAxisKeys?: readonly string[];
  duplicateSignatures?: readonly string[];
  /** SKUs this seller already uses elsewhere - other offers, other drafts. */
  skusInUseElsewhere?: ReadonlySet<string>;
}

/**
 * Everything wrong with the variant section, as issues the wizard renders.
 *
 * BLOCKER stops submission; WARNING does not. The split is deliberate and
 * follows one rule: a BLOCKER is something that would make the listing
 * incorrect or unsellable if it went live, and a WARNING is something a
 * reasonable seller might mean. No stock on a combination is a warning,
 * because "we are out of it but we do sell it" is a true thing to say about a
 * shoe. No price on an ACTIVE combination is a blocker, because there is no
 * reading of that which a buyer could be shown.
 */
export function validateVariants(input: ValidateVariantsInput): ListingIssue[] {
  const issues: ListingIssue[] = [];

  for (const key of input.unknownAxisKeys ?? []) {
    issues.push(
      issue(
        'WARNING',
        ErrorCode.VARIANT_AXIS_NOT_IN_TEMPLATE,
        `This category does not offer "${key}" as a variant option, so it was removed. ` +
          'If you changed category, check the options below still describe what you sell.',
        `variants.axes.${key}`,
      ),
    );
  }

  // Not answered yet. Silent: the seller has not reached the step, and an
  // unvisited step is not a mistake.
  if (input.axes === null) return issues;

  // Answered "one configuration". Nothing further to check - approval creates
  // the single default variant from the offer's own price and stock.
  if (input.axes.length === 0) return issues;

  for (const axis of input.axes) {
    if (axis.values.length === 0) {
      issues.push(
        issue(
          'BLOCKER',
          'VARIANT_AXIS_EMPTY',
          `You switched on "${axis.axisKey}" but did not list any values for it. ` +
            'Add the ones you stock, or turn the option off.',
          `variants.axes.${axis.axisKey}`,
        ),
      );
    }
  }

  const projection = projectMatrix(input.axes);
  if (projection.exceedsMaximum) {
    issues.push(
      issue(
        'BLOCKER',
        ErrorCode.VARIANT_MATRIX_TOO_LARGE,
        `These options make ${projection.total} combinations, and ${projection.maximum} is the most ` +
          'one listing can hold. Split it into separate listings, or remove an option.',
        'variants.axes',
      ),
    );
  }

  for (const signature of input.duplicateSignatures ?? []) {
    issues.push(
      issue(
        'WARNING',
        ErrorCode.VARIANT_COMBINATION_EXISTS,
        `Two rows described the same combination (${signature}), so the second was removed.`,
        'variants.rows',
      ),
    );
  }

  const rows = input.rows ?? [];
  const active = rows.filter((row) => row.isActive);

  if (rows.length === 0) {
    issues.push(
      issue(
        'BLOCKER',
        'VARIANT_ROWS_MISSING',
        'You chose to sell this in several variations but have not generated the combinations yet.',
        'variants.rows',
      ),
    );
    return issues;
  }

  if (active.length === 0) {
    issues.push(
      issue(
        'BLOCKER',
        'VARIANT_NONE_ACTIVE',
        'Every combination is switched off, so there would be nothing for a buyer to order.',
        'variants.rows',
      ),
    );
  }

  // A SKU is unique per seller, and that has to hold WITHIN this matrix as
  // well as against everything else they sell. Checked in one pass, so a
  // forty-row matrix costs one scan rather than forty.
  const skuSeen = new Map<string, number>();

  for (const [index, row] of rows.entries()) {
    const where = row.name === '' ? `Row ${index + 1}` : row.name;

    if (row.sku === '') {
      issues.push(
        issue(
          row.isActive ? 'BLOCKER' : 'WARNING',
          'VARIANT_SKU_MISSING',
          `${where} has no product code. Use "Generate missing codes" or type one.`,
          `variants.rows.${row.optionSignature}.sku`,
        ),
      );
    } else {
      const fingerprint = row.sku.toLowerCase();
      const first = skuSeen.get(fingerprint);

      if (first !== undefined) {
        issues.push(
          issue(
            'BLOCKER',
            ErrorCode.SELLER_SKU_ALREADY_EXISTS,
            `${where} uses the code ${row.sku}, which row ${first + 1} already uses. ` +
              'Every combination needs its own code.',
            `variants.rows.${row.optionSignature}.sku`,
          ),
        );
      } else {
        skuSeen.set(fingerprint, index);

        if (input.skusInUseElsewhere?.has(fingerprint) === true) {
          issues.push(
            issue(
              'BLOCKER',
              ErrorCode.SELLER_SKU_ALREADY_EXISTS,
              `${where} uses the code ${row.sku}, which you already use on another listing.`,
              `variants.rows.${row.optionSignature}.sku`,
            ),
          );
        }
      }
    }

    if (!row.isActive) continue;

    const price = row.priceMinor ?? null;
    if (price === null || price === '' || !/^\d+$/.test(price) || BigInt(price) <= 0n) {
      issues.push(
        issue(
          'BLOCKER',
          'VARIANT_PRICE_MISSING',
          `${where} is on sale but has no price.`,
          `variants.rows.${row.optionSignature}.priceMinor`,
        ),
      );
    } else if (
      typeof row.compareAtPriceMinor === 'string' &&
      /^\d+$/.test(row.compareAtPriceMinor) &&
      BigInt(row.compareAtPriceMinor) > 0n &&
      BigInt(row.compareAtPriceMinor) < BigInt(price)
    ) {
      // A "was" price below the selling price is not a discount, it is a
      // claim that the buyer is paying more than usual, and showing it would
      // be worse than showing nothing.
      issues.push(
        issue(
          'BLOCKER',
          'VARIANT_COMPARE_AT_BELOW_PRICE',
          `${where} has a recommended price lower than what you are charging.`,
          `variants.rows.${row.optionSignature}.compareAtPriceMinor`,
        ),
      );
    }

    if (row.minOrderQty !== null && row.minOrderQty !== undefined && row.minOrderQty < 1) {
      issues.push(
        issue(
          'BLOCKER',
          'VARIANT_MOQ_INVALID',
          `${where} has a minimum order below one.`,
          `variants.rows.${row.optionSignature}.minOrderQty`,
        ),
      );
    }

    if (row.qtyIncrement !== null && row.qtyIncrement !== undefined && row.qtyIncrement < 1) {
      issues.push(
        issue(
          'BLOCKER',
          'VARIANT_INCREMENT_INVALID',
          `${where} has an order step below one.`,
          `variants.rows.${row.optionSignature}.qtyIncrement`,
        ),
      );
    }

    if (
      row.maxOrderQty !== null &&
      row.maxOrderQty !== undefined &&
      row.minOrderQty !== null &&
      row.minOrderQty !== undefined &&
      row.maxOrderQty < row.minOrderQty
    ) {
      issues.push(
        issue(
          'BLOCKER',
          'VARIANT_MAX_BELOW_MIN',
          `${where} has a maximum order below its minimum.`,
          `variants.rows.${row.optionSignature}.maxOrderQty`,
        ),
      );
    }

    const onHand = row.stock.reduce((sum, entry) => sum + entry.availableQuantity, 0);
    if (onHand === 0) {
      issues.push(
        issue(
          'WARNING',
          'VARIANT_STOCK_EMPTY',
          `${where} has no stock in any warehouse. It will show as out of stock.`,
          `variants.rows.${row.optionSignature}.stock`,
        ),
      );
    }
  }

  return issues;
}
