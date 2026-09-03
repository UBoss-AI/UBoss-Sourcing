/**
 * Product variants.
 *
 * A variant is a separately stocked, separately priced form of a product -
 * "1L", "Pack of 12". Two rules matter:
 *
 *   1. Variant SKUs share one namespace with product SKUs. A picker or a
 *      barcode scanner cannot tell them apart, so neither can the database.
 *   2. A variant that has been ordered is archived, never deleted. Order items
 *      reference it, and history must stay readable.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface VariantActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface VariantInput {
  sku: string;
  name: string;
  /** Selected option values, e.g. { "Size": "1L", "Pack": "12" }. */
  options: Record<string, string>;
  /** Absolute price in minor units. Omitted, the product base price applies. */
  priceMinor?: string | null;
  isActive?: boolean;
  sortOrder?: number;
}

async function assertSkuAvailable(sku: string, excludeVariantId: string | null): Promise<void> {
  const [product, variant] = await Promise.all([
    prisma.product.findUnique({ where: { sku }, select: { id: true } }),
    prisma.productVariant.findUnique({ where: { sku }, select: { id: true } }),
  ]);

  if (product !== null) {
    throw conflict(ErrorCode.SKU_ALREADY_EXISTS, `SKU "${sku}" is already used by a product.`, [
      { field: 'sku', code: 'DUPLICATE_PRODUCT', meta: { sku } },
    ]);
  }

  if (variant !== null && variant.id !== excludeVariantId) {
    throw conflict(ErrorCode.SKU_ALREADY_EXISTS, `SKU "${sku}" is already used by another variant.`, [
      { field: 'sku', code: 'DUPLICATE_VARIANT', meta: { sku } },
    ]);
  }
}

function parseMinor(value: string, field: string): bigint {
  if (!/^\d+$/.test(value.trim())) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Amounts must be whole minor units.', [
      { field, code: 'INVALID_MONEY' },
    ]);
  }
  return BigInt(value.trim());
}

export async function listVariants(productId: string): Promise<Record<string, unknown>[]> {
  const rows = await prisma.productVariant.findMany({
    where: { productId },
    orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
    include: {
      _count: { select: { orderItems: true } },
      inventoryBalances: { select: { onHandQty: true, reservedQty: true } },
    },
  });

  return rows.map((row) => {
    const onHand = row.inventoryBalances.reduce((total, balance) => total + balance.onHandQty, 0);
    const reserved = row.inventoryBalances.reduce((total, balance) => total + balance.reservedQty, 0);

    return {
      id: row.id,
      sku: row.sku,
      name: row.name,
      options: row.optionsJson,
      priceMinor: row.priceMinor?.toString() ?? null,
      isActive: row.isActive,
      sortOrder: row.sortOrder,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      onHandQty: onHand,
      availableQty: onHand - reserved,
      // The UI uses this to choose between "archive" and "delete".
      orderCount: row._count.orderItems,
    };
  });
}

export async function createVariant(
  productId: string,
  input: VariantInput,
  actor: VariantActor,
): Promise<{ id: string }> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, archivedAt: true, hasVariants: true },
  });

  if (product === null || product.archivedAt !== null) throw notFound('Product');

  const sku = input.sku.trim().toUpperCase();
  await assertSkuAvailable(sku, null);

  if (Object.keys(input.options).length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Give the variant at least one option value.', [
      { field: 'options', code: 'REQUIRED' },
    ]);
  }

  const id = newId();

  await prisma.$transaction(async (tx) => {
    await tx.productVariant.create({
      data: {
        id,
        productId,
        sku,
        name: input.name.trim(),
        optionsJson: input.options as never,
        priceMinor:
          input.priceMinor === null || input.priceMinor === undefined
            ? null
            : parseMinor(input.priceMinor, 'priceMinor'),
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
      },
    });

    // The first variant flips the product into variant mode, which the
    // publication check then requires at least one active variant for.
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
        after: { variantAdded: id, sku, name: input.name },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { id };
}

export async function updateVariant(
  productId: string,
  variantId: string,
  input: Partial<VariantInput>,
  actor: VariantActor,
): Promise<void> {
  // Scoped by productId, so a variant id from another product does not resolve.
  const existing = await prisma.productVariant.findFirst({
    where: { id: variantId, productId },
  });

  if (existing === null) throw notFound('Variant');

  const data: Prisma.ProductVariantUncheckedUpdateInput = {};

  if (input.sku !== undefined) {
    const sku = input.sku.trim().toUpperCase();
    await assertSkuAvailable(sku, variantId);
    data.sku = sku;
  }

  if (input.name !== undefined) data.name = input.name.trim();
  if (input.options !== undefined) data.optionsJson = input.options;
  if (input.isActive !== undefined) data.isActive = input.isActive;
  if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

  if (input.priceMinor !== undefined) {
    data.priceMinor =
      input.priceMinor === null ? null : parseMinor(input.priceMinor, 'priceMinor');
  }

  await prisma.$transaction(async (tx) => {
    await tx.productVariant.update({ where: { id: variantId }, data });

    // A price change on a variant is a price change on a saleable unit, so it
    // gets the same dedicated audit entry a product price change does.
    if (input.priceMinor !== undefined && data.priceMinor !== existing.priceMinor) {
      await recordAudit(
        {
          action: AuditAction.PRODUCT_PRICE_CHANGED,
          resourceType: 'product_variant',
          resourceId: variantId,
          actorType: 'ADMIN',
          actorUserId: actor.userId,
          actorEmail: actor.email,
          before: { priceMinor: existing.priceMinor },
          after: { priceMinor: data.priceMinor },
          ipAddress: actor.ipAddress ?? null,
          correlationId: actor.correlationId ?? null,
        },
        tx,
      );
    }

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UPDATED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { variantId, sku: existing.sku, name: existing.name, isActive: existing.isActive },
        after: input,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Archive a variant.
 *
 * Soft delete when it has been ordered - `order_items` references it, and a
 * hard delete would break history. A never-ordered variant with no stock is
 * removed outright, because leaving debris in a variant picker is worse than
 * keeping a row nobody needs.
 */
export async function archiveVariant(
  productId: string,
  variantId: string,
  actor: VariantActor,
): Promise<{ deleted: boolean }> {
  const existing = await prisma.productVariant.findFirst({
    where: { id: variantId, productId },
    include: {
      _count: { select: { orderItems: true, scheduleItems: true } },
      inventoryBalances: { select: { onHandQty: true } },
    },
  });

  if (existing === null) throw notFound('Variant');

  const hasHistory = existing._count.orderItems > 0 || existing._count.scheduleItems > 0;
  const hasStock = existing.inventoryBalances.some((balance) => balance.onHandQty > 0);

  await prisma.$transaction(async (tx) => {
    if (hasHistory || hasStock) {
      await tx.productVariant.update({
        where: { id: variantId },
        data: { archivedAt: new Date(), isActive: false },
      });
    } else {
      await tx.cartItem.deleteMany({ where: { variantId } });
      await tx.inventoryBalance.deleteMany({ where: { variantId } });
      await tx.productVariant.delete({ where: { id: variantId } });
    }

    // Back to a simple product when the last variant goes. Otherwise the
    // publication check would demand an active variant that cannot exist.
    const remaining = await tx.productVariant.count({
      where: { productId, archivedAt: null },
    });

    if (remaining === 0) {
      await tx.product.update({ where: { id: productId }, data: { hasVariants: false } });
    }

    await recordAudit(
      {
        action: AuditAction.PRODUCT_UPDATED,
        resourceType: 'product',
        resourceId: productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { variantId, sku: existing.sku },
        after: {
          variantRemoved: variantId,
          hardDeleted: !hasHistory && !hasStock,
          reason: hasHistory ? 'referenced by orders or schedules' : hasStock ? 'holds stock' : null,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { deleted: !hasHistory && !hasStock };
}
