/**
 * The seller's side of variants: which axes a product sells along, and turning
 * a set of chosen values into rows.
 *
 * Kept apart from `variant.service.ts` on purpose. That file edits ONE
 * variant; this one decides what the set of them should be. They are different
 * jobs with different failure modes - a bad SKU on one row, versus nine
 * hundred rows nobody meant to create - and the buyer-side resolver shares
 * nothing with either.
 *
 * Two rules the whole file is built around:
 *
 *   **Preview before write, always.** `previewMatrix` is a pure read: it says
 *   how many rows would be created, which already exist, which would collide,
 *   and what each SKU would be. The seller sees that table and then decides.
 *   A generator that writes first is a generator that has to be undone.
 *
 *   **Generation never removes anything.** A combination the seller drops out
 *   of the matrix keeps its row, its stock and its order history; it is
 *   deactivated, at most, and only when they ask. The only thing that removes
 *   a variant is `archiveVariant`, which refuses to hard-delete anything an
 *   order has touched.
 */
import {
  COMBINATION_WARNING_THRESHOLD,
  MAX_GENERATED_COMBINATIONS,
  countCombinations,
  duplicateSignatures,
  generateCombinations,
  generateSkus,
  measurementText,
  normaliseAxisKey,
  optionSignature,
  variantDisplayName,
  type AxisValues,
  type OptionValue,
} from '../../domain/variants/axis.js';
import { findAxis, findTemplate, resolveActiveAxes } from '../../domain/variants/registry.js';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import type { VariantActor, VariantCommerceInput } from './variant.service.js';

/**
 * The category and its ancestors, nearest first, as slugs.
 *
 * Exported because the seller's listing wizard needs the same answer for a
 * category the seller has only just picked, before any product exists to hang
 * it off. Two implementations of "which shelf is this" is how the wizard ends
 * up offering axes the catalogue will later refuse.
 */
export async function categorySlugPath(categoryId: string): Promise<string[]> {
  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { slug: true, path: true },
  });

  if (category === null) return [];

  // `path` is the materialised `/rootId/childId/` trail, so the ancestors are
  // one indexed read rather than a walk up the tree.
  const ancestorIds = category.path.split('/').filter((part) => part !== '');
  if (ancestorIds.length === 0) return [category.slug];

  const ancestors = await prisma.category.findMany({
    where: { id: { in: ancestorIds } },
    select: { id: true, slug: true },
  });

  const slugById = new Map(ancestors.map((row) => [row.id, row.slug]));

  return [
    category.slug,
    // Nearest ancestor first: the path reads root-to-leaf, so it is reversed.
    ...ancestorIds
      .slice()
      .reverse()
      .map((id) => slugById.get(id))
      .filter((slug): slug is string => slug !== undefined),
  ];
}

/**
 * The template for a product, and the axes it has switched on.
 *
 * `template` is null for a category with none - Medical Devices, or a shelf an
 * operator invented - and that is a supported answer. The admin panel then
 * shows the free-form option editor the catalogue has always had.
 */
export async function loadProductAxes(productId: string): Promise<{
  template: ReturnType<typeof findTemplate>;
  activeAxisKeys: string[];
  categorySlugs: string[];
}> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { categoryId: true, variantAxesJson: true, archivedAt: true },
  });

  if (product === null || product.archivedAt !== null) throw notFound('Product');

  const categorySlugs = await categorySlugPath(product.categoryId);
  const template = findTemplate(categorySlugs);

  const stored = product.variantAxesJson;
  const activeAxisKeys = Array.isArray(stored)
    ? stored.filter((entry): entry is string => typeof entry === 'string')
    : [];

  return { template, activeAxisKeys, categorySlugs };
}

/**
 * Choose which axes this product sells along.
 *
 * Refuses a key the category's template does not offer, rather than storing
 * it: an axis nothing can render is an axis that produces a selector with no
 * label, and the seller would have no way of telling why.
 *
 * REMOVING an axis that variants already carry is allowed and is deliberately
 * not destructive. Those variants keep their stored option values and keep
 * selling; the axis simply stops being offered on the form and stops being
 * shown as a selector. `warnings` names the count so the caller can ask the
 * seller to confirm before saving, which the admin panel does.
 */
export async function setProductAxes(
  productId: string,
  axisKeys: readonly string[],
  actor: VariantActor,
): Promise<{ activeAxisKeys: string[]; warnings: string[] }> {
  const { template } = await loadProductAxes(productId);

  if (template === null && axisKeys.length > 0) {
    throw badRequest(
      ErrorCode.VARIANT_AXIS_NOT_IN_TEMPLATE,
      'This category has no variant template, so it has no axes to switch on.',
      [{ field: 'axisKeys', code: 'NO_TEMPLATE' }],
    );
  }

  const unknown = axisKeys.filter((key) => template !== null && findAxis(template, key) === null);
  if (unknown.length > 0) {
    throw badRequest(
      ErrorCode.VARIANT_AXIS_NOT_IN_TEMPLATE,
      `This category does not offer ${unknown.join(', ')}.`,
      unknown.map((key) => ({ field: 'axisKeys', code: 'UNKNOWN_AXIS', meta: { key } })),
    );
  }

  // Stored in the template's order, never the caller's, so two products on one
  // shelf cannot present the same axes in a different sequence.
  const ordered = resolveActiveAxes(template, axisKeys).map((entry) => entry.key);

  const variants = await prisma.productVariant.findMany({
    where: { productId, archivedAt: null },
    select: { optionsJson: true },
  });

  const kept = new Set(ordered.map((key) => normaliseAxisKey(key)));
  const orphaned = new Set<string>();

  for (const variant of variants) {
    const options = variant.optionsJson;
    if (typeof options !== 'object' || options === null || Array.isArray(options)) continue;
    for (const key of Object.keys(options)) {
      if (!kept.has(normaliseAxisKey(key))) orphaned.add(key);
    }
  }

  const warnings =
    orphaned.size === 0
      ? []
      : [
          `${variants.length} variant(s) still carry values for ${[...orphaned].join(', ')}. ` +
            'Those values are kept and those variants keep selling; they will no longer be shown as a choice.',
        ];

  await prisma.$transaction(async (tx) => {
    await tx.product.update({
      where: { id: productId },
      data: { variantAxesJson: ordered },
    });

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UPDATED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { variantAxes: ordered },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { activeAxisKeys: ordered, warnings };
}

/** What the seller entered for one axis, from the request. */
export interface MatrixAxisInput {
  axisKey: string;
  /** In the order the seller arranged them. Reordering is meaningful. */
  values: { label: string; amount?: string | null; unit?: string | null }[];
}

export interface MatrixRow {
  optionSignature: string;
  options: Record<string, string>;
  displayName: string;
  /** The SKU that would be created. Editable before saving. */
  sku: string;
  /** True when a variant with this combination already exists. */
  exists: boolean;
  existingVariantId: string | null;
  existingSku: string | null;
}

export interface MatrixPreview {
  rows: MatrixRow[];
  total: number;
  /** How many rows would actually be created. */
  toCreate: number;
  /** Past this, the caller is expected to make the seller confirm. */
  warnAbove: number;
  maximum: number;
  warnings: string[];
}

function toOptionValues(axes: readonly MatrixAxisInput[]): AxisValues[] {
  return axes.map((axis) => ({
    axisKey: axis.axisKey,
    values: axis.values
      .map<OptionValue>((entry) => ({
        axisKey: axis.axisKey,
        label: entry.label.trim(),
        ...(entry.amount === undefined || entry.amount === null
          ? {}
          : { amount: entry.amount.trim() }),
        ...(entry.unit === undefined || entry.unit === null ? {} : { unit: entry.unit.trim() }),
      }))
      // An empty value is not a choice. Dropping it here rather than refusing
      // the request means a seller who left one row of the value editor blank
      // gets the matrix they meant instead of a validation error.
      .filter((entry) => measurementText(entry) !== ''),
  }));
}

/**
 * What generating would produce, without producing it.
 *
 * Pure apart from reading the variants that already exist, which is what makes
 * "this one is already listed" answerable. Nothing is written.
 */
export async function previewMatrix(
  productId: string,
  axes: readonly MatrixAxisInput[],
  skuPrefix: string | null,
): Promise<MatrixPreview> {
  const { template, activeAxisKeys } = await loadProductAxes(productId);

  const product = await prisma.product.findUniqueOrThrow({
    where: { id: productId },
    select: { sku: true },
  });

  const unknown = axes.filter((axis) => template !== null && findAxis(template, axis.axisKey) === null);
  if (unknown.length > 0) {
    throw badRequest(
      ErrorCode.VARIANT_AXIS_NOT_IN_TEMPLATE,
      `This category does not offer ${unknown.map((axis) => axis.axisKey).join(', ')}.`,
      unknown.map((axis) => ({ field: 'axes', code: 'UNKNOWN_AXIS', meta: { key: axis.axisKey } })),
    );
  }

  const prepared = toOptionValues(axes);
  const total = countCombinations(prepared);

  if (total > MAX_GENERATED_COMBINATIONS) {
    throw badRequest(
      ErrorCode.VARIANT_MATRIX_TOO_LARGE,
      `${total} combinations is more than the ${MAX_GENERATED_COMBINATIONS} this can generate at once. Split the product, or generate one axis at a time.`,
      [{ field: 'axes', code: 'TOO_MANY', meta: { total, maximum: MAX_GENERATED_COMBINATIONS } }],
    );
  }

  const combinations = generateCombinations(prepared);

  const duplicates = duplicateSignatures(combinations);
  if (duplicates.length > 0) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'Two of the values you entered are the same once case and spacing are ignored.',
      duplicates.map((signature) => ({
        field: 'axes',
        code: 'DUPLICATE_VALUE',
        meta: { signature },
      })),
    );
  }

  const existing = await prisma.productVariant.findMany({
    where: { productId },
    select: { id: true, sku: true, optionSignature: true },
  });
  const existingBySignature = new Map(existing.map((row) => [row.optionSignature, row]));

  // Every SKU already in use, so a generated one cannot take one. Product and
  // variant SKUs share a namespace, so both are read.
  const [takenProducts, takenVariants] = await Promise.all([
    prisma.product.findMany({ select: { sku: true } }),
    prisma.productVariant.findMany({ select: { sku: true } }),
  ]);
  const taken = new Set([
    ...takenProducts.map((row) => row.sku),
    ...takenVariants.map((row) => row.sku),
  ]);

  const templateAxes = resolveActiveAxes(template, activeAxisKeys);

  const skus = generateSkus(
    { prefix: skuPrefix, productCode: product.sku },
    combinations,
    // A copy, so previewing twice does not walk the suffixes upward.
    new Set(taken),
  );

  const rows: MatrixRow[] = combinations.map((values, index) => {
    const signature = optionSignature(values);
    const found = existingBySignature.get(signature) ?? null;

    const options: Record<string, string> = {};
    for (const value of values) options[value.axisKey] = measurementText(value);

    return {
      optionSignature: signature,
      options,
      displayName:
        // Falls back to the raw values where the product has no template, so a
        // free-form matrix still produces a readable name.
        templateAxes.length > 0
          ? variantDisplayName(templateAxes, values)
          : values.map((value) => measurementText(value)).join(' / '),
      sku: found?.sku ?? skus[index] ?? '',
      exists: found !== null,
      existingVariantId: found?.id ?? null,
      existingSku: found?.sku ?? null,
    };
  });

  const toCreate = rows.filter((row) => !row.exists).length;

  const warnings: string[] = [];
  if (total > COMBINATION_WARNING_THRESHOLD) {
    warnings.push(
      `${total} combinations is a large table. Check every price and stock figure before saving.`,
    );
  }
  if (toCreate === 0 && total > 0) {
    warnings.push('Every combination here already exists. Nothing new would be created.');
  }

  return {
    rows,
    total,
    toCreate,
    warnAbove: COMBINATION_WARNING_THRESHOLD,
    maximum: MAX_GENERATED_COMBINATIONS,
    warnings,
  };
}

/** One row the seller approved, with whatever they edited on it. */
export interface MatrixCommitRow extends VariantCommerceInput {
  optionSignature: string;
  options: Record<string, string>;
  name: string;
  sku: string;
  priceMinor?: string | null;
  isActive?: boolean;
}

/**
 * Create the rows the seller approved.
 *
 * Idempotent by signature: a row whose combination already exists is SKIPPED,
 * not overwritten. Re-running a generation after adding one size creates the
 * one row and leaves the prices, stock and SKUs of the rest exactly as the
 * seller edited them.
 *
 * All or nothing. A duplicate SKU halfway through a hundred rows would
 * otherwise leave a half-built matrix that the seller has to reconcile by
 * hand.
 */
export async function commitMatrix(
  productId: string,
  rows: readonly MatrixCommitRow[],
  actor: VariantActor,
): Promise<{ created: number; skipped: number }> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, archivedAt: true, hasVariants: true },
  });

  if (product === null || product.archivedAt !== null) throw notFound('Product');

  const existing = await prisma.productVariant.findMany({
    where: { productId },
    select: { optionSignature: true },
  });
  const known = new Set(existing.map((row) => row.optionSignature));

  const wanted = rows.filter((row) => !known.has(row.optionSignature));

  // Within the batch as well as against the database: two rows of one request
  // carrying the same combination is a client bug, and the unique index would
  // report it as a 500 halfway through the transaction.
  const seenSignatures = new Set<string>();
  const seenSkus = new Set<string>();
  for (const row of wanted) {
    const sku = row.sku.trim().toUpperCase();

    if (seenSignatures.has(row.optionSignature)) {
      throw badRequest(ErrorCode.VARIANT_COMBINATION_EXISTS, 'That combination appears twice in this table.', [
        { field: 'rows', code: 'DUPLICATE_COMBINATION', meta: { signature: row.optionSignature } },
      ]);
    }
    if (seenSkus.has(sku)) {
      throw badRequest(ErrorCode.SKU_ALREADY_EXISTS, `SKU "${sku}" appears twice in this table.`, [
        { field: 'rows', code: 'DUPLICATE_VARIANT', meta: { sku } },
      ]);
    }

    seenSignatures.add(row.optionSignature);
    seenSkus.add(sku);
  }

  if (wanted.length === 0) {
    return { created: 0, skipped: rows.length };
  }

  const clashes = await prisma.productVariant.findMany({
    where: { sku: { in: [...seenSkus] } },
    select: { sku: true },
  });
  const productClashes = await prisma.product.findMany({
    where: { sku: { in: [...seenSkus] } },
    select: { sku: true },
  });

  const allClashes = [...clashes, ...productClashes].map((row) => row.sku);
  if (allClashes.length > 0) {
    throw badRequest(
      ErrorCode.SKU_ALREADY_EXISTS,
      `These SKUs are already in use: ${allClashes.join(', ')}.`,
      allClashes.map((sku) => ({ field: 'rows', code: 'DUPLICATE_VARIANT', meta: { sku } })),
    );
  }

  const highestSortOrder = await prisma.productVariant.aggregate({
    where: { productId },
    _max: { sortOrder: true },
  });
  let sortOrder = (highestSortOrder._max.sortOrder ?? -1) + 1;

  await prisma.$transaction(async (tx) => {
    for (const row of wanted) {
      await tx.productVariant.create({
        data: {
          id: newId(),
          productId,
          sku: row.sku.trim().toUpperCase(),
          name: row.name.trim(),
          optionsJson: row.options as never,
          optionSignature: row.optionSignature,
          priceMinor:
            row.priceMinor === null || row.priceMinor === undefined
              ? null
              : BigInt(row.priceMinor),
          compareAtPriceMinor:
            row.compareAtPriceMinor === null || row.compareAtPriceMinor === undefined
              ? null
              : BigInt(row.compareAtPriceMinor),
          minOrderQty: row.minOrderQty ?? null,
          qtyIncrement: row.qtyIncrement ?? null,
          maxOrderQty: row.maxOrderQty ?? null,
          leadTimeDays: row.leadTimeDays ?? null,
          multipackCount: row.multipackCount ?? null,
          netContentValue: row.netContentValue ?? null,
          netContentUnit: row.netContentUnit ?? null,
          unitPricingBaseValue: row.unitPricingBaseValue ?? null,
          unitPricingBaseUnit: row.unitPricingBaseUnit ?? null,
          manufacturerPackLabel: row.manufacturerPackLabel ?? null,
          shippingWeightGrams: row.shippingWeightGrams ?? null,
          gtin: row.gtin ?? null,
          isActive: row.isActive ?? true,
          sortOrder: sortOrder++,
        },
      });
    }

    if (!product.hasVariants) {
      await tx.product.update({ where: { id: productId }, data: { hasVariants: true } });
    }

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UPDATED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          variantsGenerated: wanted.length,
          skipped: rows.length - wanted.length,
          skus: wanted.map((row) => row.sku),
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { created: wanted.length, skipped: rows.length - wanted.length };
}

/** A figure to apply to every selected variant at once. */
export interface BulkVariantEdit {
  variantIds: string[];
  priceMinor?: string | null;
  compareAtPriceMinor?: string | null;
  minOrderQty?: number | null;
  qtyIncrement?: number | null;
  leadTimeDays?: number | null;
  isActive?: boolean;
}

/**
 * Set one figure across many variants.
 *
 * The alternative is a seller opening forty rows to type the same price into
 * each, which is how a matrix ends up with thirty-nine correct prices and one
 * that was missed. Scoped to one product, so a variant id from elsewhere
 * cannot be swept into the update.
 */
export async function bulkEditVariants(
  productId: string,
  edit: BulkVariantEdit,
  actor: VariantActor,
): Promise<{ updated: number }> {
  if (edit.variantIds.length === 0) return { updated: 0 };

  const data: Record<string, unknown> = {};
  if (edit.priceMinor !== undefined) {
    data.priceMinor = edit.priceMinor === null ? null : BigInt(edit.priceMinor);
  }
  if (edit.compareAtPriceMinor !== undefined) {
    data.compareAtPriceMinor =
      edit.compareAtPriceMinor === null ? null : BigInt(edit.compareAtPriceMinor);
  }
  if (edit.minOrderQty !== undefined) data.minOrderQty = edit.minOrderQty;
  if (edit.qtyIncrement !== undefined) data.qtyIncrement = edit.qtyIncrement;
  if (edit.leadTimeDays !== undefined) data.leadTimeDays = edit.leadTimeDays;
  if (edit.isActive !== undefined) data.isActive = edit.isActive;

  if (Object.keys(data).length === 0) return { updated: 0 };

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.productVariant.updateMany({
      where: { id: { in: edit.variantIds }, productId },
      data,
    });

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UPDATED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { bulkVariantEdit: { count: updated.count, fields: Object.keys(data) } },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return updated;
  });

  return { updated: result.count };
}
