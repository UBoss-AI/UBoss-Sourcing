/**
 * Freezing what was ordered, and reading it back for a seller.
 *
 * `captureOrderItemSnapshots` runs inside the transaction that creates an
 * order's items - checkout, a preorder becoming an order, a scheduled order -
 * after the items and their packaging are written. It writes each item's
 * snapshot once: the update only touches rows whose snapshot is still NULL,
 * so running it twice, or a later caller, can never rewrite one.
 *
 * `currentListingInfo` builds the same shape from the listing as it is now,
 * for an order placed before snapshots existed. It is never stored, and the
 * seller's page labels it as the current listing, not what was sold.
 */
import { Prisma } from '../../generated/prisma/client.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  ORDER_ITEM_SNAPSHOT_VERSION,
  type OrderItemSnapshot,
} from '../../domain/order-item-snapshot.js';
import { shownSpecifications } from '../../domain/product-specifications.js';
import { containerOptionsForOffer } from '../seller/container-loading.service.js';

type Client = PrismaTransaction | typeof prisma;

const ITEM_SELECT = {
  id: true,
  productId: true,
  variantId: true,
  sellerOfferId: true,
  nameSnapshot: true,
  skuSnapshot: true,
  variantNameSnapshot: true,
  noteSnapshot: true,
  orderingUnit: true,
  unitQuantity: true,
  piecesPerUnitSnapshot: true,
  quantity: true,
  packaging: {
    select: {
      packageType: true,
      unitsPerCarton: true,
      cartonsPerPallet: true,
      cartonsPerContainer: true,
      lengthMm: true,
      widthMm: true,
      heightMm: true,
      grossWeightGrams: true,
    },
  },
} as const;

type ItemRow = Prisma.OrderItemGetPayload<{ select: typeof ITEM_SELECT }>;

function optionsOf(value: unknown): { name: string; value: string }[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.entries(value as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '')
    .map(([name, option]) => ({ name, value: option }));
}

/** The snapshot of one item, from the product, variant and offer as they are at this moment. */
async function snapshotOf(client: Client, item: ItemRow, capturedAt: Date): Promise<OrderItemSnapshot> {
  const [product, variant, offer] = await Promise.all([
    client.product.findUnique({
      where: { id: item.productId },
      select: {
        description: true,
        descriptionHtml: true,
        piecesPerCarton: true,
        minOrderQty: true,
        attributes: {
          select: { name: true, value: true, unit: true, groupKey: true, sortOrder: true, isHighlight: true },
          orderBy: { sortOrder: 'asc' },
        },
        descriptionSections: {
          where: { isActive: true, language: null },
          select: { heading: true, body: true },
          orderBy: { sortOrder: 'asc' },
        },
      },
    }),
    item.variantId === null
      ? Promise.resolve(null)
      : client.productVariant.findUnique({
          where: { id: item.variantId },
          select: {
            optionsJson: true,
            attributes: {
              select: { name: true, value: true, unit: true, groupKey: true, sortOrder: true },
              orderBy: { sortOrder: 'asc' },
            },
          },
        }),
    item.sellerOfferId === null
      ? Promise.resolve(null)
      : client.sellerOffer.findUnique({
          where: { id: item.sellerOfferId },
          select: { minimumOrderQuantity: true },
        }),
  ]);

  const containers = item.sellerOfferId === null ? null : await containerOptionsForOffer(item.sellerOfferId);
  const loading = (unit: 'CONTAINER_20_FT' | 'CONTAINER_40_FT'): OrderItemSnapshot['containerCapacity']['CONTAINER_20_FT'] => {
    const option = containers?.options.find((candidate) => candidate.unit === unit);
    if (option === undefined || !option.available || option.piecesPerContainer === null) return null;
    return { pieces: option.piecesPerContainer, cartons: option.cartonsPerContainer, piecesPerCarton: option.piecesPerCarton };
  };

  const pack = item.packaging;
  return {
    schemaVersion: ORDER_ITEM_SNAPSHOT_VERSION,
    capturedAt: capturedAt.toISOString(),
    productId: item.productId,
    productName: item.nameSnapshot,
    sku: item.skuSnapshot,
    variantId: item.variantId,
    variantName: item.variantNameSnapshot,
    selectedOptions: optionsOf(variant?.optionsJson),
    description: {
      text: product?.description ?? null,
      html: product?.descriptionHtml ?? null,
      sections: (product?.descriptionSections ?? []).map((section) => ({ heading: section.heading, body: section.body })),
    },
    specificationGroups: shownSpecifications(product?.attributes ?? [], variant?.attributes ?? []),
    packaging: {
      orderingUnit: item.orderingUnit,
      unitQuantity: item.unitQuantity,
      piecesPerUnit: item.piecesPerUnitSnapshot,
      equivalentPieces: item.quantity,
      packageType: pack?.packageType ?? null,
      unitsPerCarton: pack?.unitsPerCarton ?? null,
      cartonsPerPallet: pack?.cartonsPerPallet ?? null,
      cartonsPerContainer: pack?.cartonsPerContainer ?? null,
      dimensionsMm:
        pack === null || (pack.lengthMm === null && pack.widthMm === null && pack.heightMm === null)
          ? null
          : { length: pack.lengthMm, width: pack.widthMm, height: pack.heightMm },
      grossWeightGrams: pack?.grossWeightGrams?.toString() ?? null,
    },
    moqPieces: offer?.minimumOrderQuantity ?? product?.minOrderQty ?? null,
    piecesPerCarton: pack?.unitsPerCarton ?? product?.piecesPerCarton ?? null,
    containerCapacity: { CONTAINER_20_FT: loading('CONTAINER_20_FT'), CONTAINER_40_FT: loading('CONTAINER_40_FT') },
    specialInstructions: item.noteSnapshot,
  };
}

/**
 * Freeze every item of this order that has no snapshot yet. Call it inside the
 * transaction that created the items, after their packaging rows.
 */
export async function captureOrderItemSnapshots(tx: PrismaTransaction, orderId: string): Promise<void> {
  const items = await tx.orderItem.findMany({
    where: { orderId, productInfoSnapshotJson: { equals: Prisma.DbNull } },
    select: ITEM_SELECT,
  });
  const capturedAt = new Date();
  for (const item of items) {
    const snapshot = await snapshotOf(tx, item, capturedAt);
    // Only where still empty: a snapshot, once written, is never replaced.
    await tx.orderItem.updateMany({
      where: { id: item.id, productInfoSnapshotJson: { equals: Prisma.DbNull } },
      data: { productInfoSnapshotJson: snapshot, productInfoCapturedAt: capturedAt },
    });
  }
}

/**
 * For an order placed before snapshots existed: the same shape from the
 * listing as it is NOW. Not stored, and labelled as such wherever it is shown.
 */
export async function currentListingInfo(orderItemId: string): Promise<OrderItemSnapshot | null> {
  const item = await prisma.orderItem.findUnique({ where: { id: orderItemId }, select: ITEM_SELECT });
  if (item === null) return null;
  return snapshotOf(prisma, item, new Date());
}
