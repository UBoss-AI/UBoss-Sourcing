/**
 * A seller's consignment, as its documents see it: what it carries, in which
 * packages, from where, to whom - and the two documents that travel with it.
 *
 * TENANCY. Every entry point takes the seller from the session's membership
 * and loads the consignment WHERE its `sellerAccountId` is that seller. A
 * consignment belonging to anybody else answers "not found", never "not
 * yours", so one seller cannot learn that another's exists.
 *
 * WHAT A CONSIGNMENT CARRIES. `logistics_shipment_lines` rows. A consignment
 * that has none yet is given the unallocated remainder of its seller order the
 * first time its documents are prepared - which for the ordinary order, one
 * consignment per seller, is simply everything. Splitting moves quantity to a
 * new consignment; the sum over a seller order's consignments never exceeds the
 * order line, and that is checked inside the transaction that moves it.
 */
import { z } from 'zod';

import {
  ErrorCode,
  badRequest,
  conflict,
  notFound,
  type ErrorDetail,
} from '../../domain/errors.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import type { SellerMembership } from '../seller/account.service.js';
import { recordSellerAudit } from '../seller/audit.service.js';

type Client = PrismaTransaction | typeof prisma;

/** Consignment statuses a document may no longer be prepared for. */
const DEAD_SHIPMENT = new Set(['CANCELLED', 'LOST', 'RETURNED']);

/** Seller order statuses whose goods have been sold and not undone. */
export const INVOICEABLE_GROUP = new Set([
  'ACCEPTED',
  'PROCESSING',
  'READY_FOR_DISPATCH',
  'SHIPPED',
  'DELIVERED',
]);

/** Order statuses that mean the buyer has paid (or was approved to). */
export const INVOICEABLE_ORDER = new Set(['CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED']);

export const CONSIGNMENT_INCLUDE = {
  packages: {
    orderBy: { sequence: 'asc' as const },
    include: { contents: { orderBy: { createdAt: 'asc' as const } } },
  },
  lines: { orderBy: { createdAt: 'asc' as const } },
  driverAssignments: {
    where: { unassignedAt: null },
    orderBy: { assignedAt: 'desc' as const },
    take: 1,
    include: { vehicle: { select: { registration: true } } },
  },
  assignedPartner: { select: { displayName: true, legalName: true } },
  manualCarrierBookings: {
    where: { status: 'BOOKED' as const },
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      provider: true,
      carrierTrackingNumber: true,
      serviceName: true,
      expectedPickupAt: true,
    },
  },
  purchases: {
    where: { purchasedShipmentId: { not: null } },
    take: 1,
    select: { provider: true, providerTrackingNumber: true },
  },
} as const;

export async function loadOwnedShipment(
  sellerAccountId: string,
  shipmentId: string,
  client: Client = prisma,
) {
  const shipment = await client.logisticsShipment.findFirst({
    where: { id: shipmentId, sellerAccountId },
    include: CONSIGNMENT_INCLUDE,
  });
  if (shipment === null || shipment.sellerOrderGroupId === null || shipment.orderId === null) {
    throw notFound('Consignment');
  }
  return shipment;
}

export type OwnedShipment = Awaited<ReturnType<typeof loadOwnedShipment>>;

/** The seller order behind a consignment, with the lines the buyer was charged against. */
export async function loadGroup(sellerOrderGroupId: string, client: Client = prisma) {
  return client.sellerOrderGroup.findUniqueOrThrow({
    where: { id: sellerOrderGroupId },
    include: {
      lines: { orderBy: { createdAt: 'asc' } },
      order: {
        include: {
          customerProfile: {
            select: {
              fullName: true,
              organization: true,
              gstin: true,
              vatNumber: true,
              user: { select: { email: true } },
            },
          },
        },
      },
    },
  });
}

export type LoadedGroup = Awaited<ReturnType<typeof loadGroup>>;

export async function loadOrderItems(orderItemIds: string[], client: Client = prisma) {
  return client.orderItem.findMany({
    where: { id: { in: orderItemIds } },
    include: {
      packaging: true,
      sellerOffer: { select: { id: true, sellerSku: true, hsnCode: true, countryOfOrigin: true } },
    },
  });
}

export type LoadedItem = Awaited<ReturnType<typeof loadOrderItems>>[number];

/**
 * Give a consignment its lines, if it has none: the part of each seller order
 * line no other live consignment already carries. Idempotent, and inside the
 * caller's transaction so two first-opens cannot both allocate.
 */
export async function ensureShipmentLines(
  tx: PrismaTransaction,
  shipment: { id: string; sellerAccountId: string | null; sellerOrderGroupId: string | null },
  group: LoadedGroup,
): Promise<{ orderItemId: string; quantity: number }[]> {
  const existing = await tx.logisticsShipmentLine.findMany({ where: { shipmentId: shipment.id } });
  if (existing.length > 0) {
    return existing.map((line) => ({ orderItemId: line.orderItemId, quantity: line.quantity }));
  }

  const elsewhere = await tx.logisticsShipmentLine.findMany({
    where: {
      shipmentId: { not: shipment.id },
      shipment: { sellerOrderGroupId: group.id, status: { notIn: [...DEAD_SHIPMENT] as never } },
    },
    select: { orderItemId: true, quantity: true },
  });
  const taken = new Map<string, number>();
  for (const line of elsewhere)
    taken.set(line.orderItemId, (taken.get(line.orderItemId) ?? 0) + line.quantity);

  const rows = group.lines
    .map((line) => ({
      orderItemId: line.orderItemId,
      quantity: line.quantity - (taken.get(line.orderItemId) ?? 0),
    }))
    .filter((line) => line.quantity > 0);

  if (rows.length > 0) {
    await tx.logisticsShipmentLine.createMany({
      data: rows.map((row) => ({
        id: newId(),
        shipmentId: shipment.id,
        sellerAccountId: shipment.sellerAccountId ?? group.sellerAccountId,
        orderItemId: row.orderItemId,
        quantity: row.quantity,
      })),
      skipDuplicates: true,
    });
  }
  return rows;
}

/** Why packages may no longer change, as a code the screens translate. */
export type PackagesLock = 'SCANNED_OUT' | 'LABEL_BOUGHT' | 'PACKING_LIST_ISSUED';

export const PACKAGES_LOCK_MESSAGE: Readonly<Record<PackagesLock, string>> = {
  SCANNED_OUT: 'A package has already been scanned out by the carrier.',
  LABEL_BOUGHT: 'A carrier label has been bought for these packages.',
  PACKING_LIST_ISSUED: 'The packing list is issued. Supersede it to change the packages.',
};

/** Why packages may no longer change, or null when they may. */
export async function packagesLockReason(
  shipmentId: string,
  client: Client = prisma,
): Promise<PackagesLock | null> {
  const [scanned, label, issued] = await Promise.all([
    client.logisticsShipmentPackage.count({ where: { shipmentId, scannedOutAt: { not: null } } }),
    client.shipmentPurchase.count({ where: { shipmentId, purchasedShipmentId: { not: null } } }),
    client.sellerPackingList.count({
      where: { logisticsShipmentId: shipmentId, status: 'ISSUED' },
    }),
  ]);
  if (scanned > 0) return 'SCANNED_OUT';
  if (label > 0) return 'LABEL_BOUGHT';
  if (issued > 0) return 'PACKING_LIST_ISSUED';
  return null;
}

// ---------------------------------------------------------------------------
// Packages and what they hold
// ---------------------------------------------------------------------------

const contentSchema = z.object({
  orderItemId: z.string().length(26),
  quantity: z.number().int().positive(),
  batchNumber: z.string().trim().max(64).default(''),
  expiryDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  serialNumbers: z.array(z.string().trim().min(1).max(64)).max(10_000).nullable().default(null),
});

export const packagesInputSchema = z
  .object({
    packages: z
      .array(
        z.object({
          packagingType: z.string().trim().min(1).max(64),
          lengthMm: z.number().int().positive().max(20_000).nullable(),
          widthMm: z.number().int().positive().max(20_000).nullable(),
          heightMm: z.number().int().positive().max(20_000).nullable(),
          grossWeightGrams: z.number().int().positive().max(50_000_000),
          netWeightGrams: z.number().int().positive().max(50_000_000).nullable().default(null),
          containerNumber: z.string().trim().max(20).nullable().default(null),
          sealNumber: z.string().trim().max(64).nullable().default(null),
          contents: z.array(contentSchema).min(1).max(200),
        }),
      )
      .min(1)
      .max(500),
  })
  .strict();

export type PackagesInput = z.infer<typeof packagesInputSchema>;

/**
 * Replace a consignment's packages with what the seller says went in each.
 *
 * Whole-set, not patch: the packages are one statement ("four cartons, holding
 * this"), and a partial update is how a carton ends up counted twice. Refused
 * once the packages are locked - see `packagesLockReason`.
 */
export async function savePackages(
  membership: SellerMembership,
  shipmentId: string,
  input: PackagesInput,
): Promise<void> {
  const shipment = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  if (DEAD_SHIPMENT.has(shipment.status)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_NOT_ELIGIBLE, 'This consignment is closed.', [
      { code: 'CLOSED' },
    ]);
  }
  const lock = await packagesLockReason(shipment.id);
  if (lock !== null) {
    throw conflict(ErrorCode.SHIPMENT_PACKAGES_LOCKED, PACKAGES_LOCK_MESSAGE[lock], [
      { code: lock },
    ]);
  }

  const group = await loadGroup(shipment.sellerOrderGroupId ?? '');

  await prisma.$transaction(async (tx) => {
    const lines = await ensureShipmentLines(tx, shipment, group);
    const carried = new Map(lines.map((line) => [line.orderItemId, line.quantity]));

    // Every content row must be something this consignment carries.
    for (const [index, pack] of input.packages.entries()) {
      for (const [row, content] of pack.contents.entries()) {
        if (!carried.has(content.orderItemId)) {
          throw badRequest(
            ErrorCode.SHIPMENT_CONTENTS_MISMATCH,
            'A package holds something this consignment does not carry.',
            [
              {
                field: `packages.${String(index)}.contents.${String(row)}.orderItemId`,
                code: 'NOT_CARRIED',
              },
            ],
          );
        }
        if (content.serialNumbers !== null && content.serialNumbers.length !== content.quantity) {
          throw badRequest(
            ErrorCode.SHIPMENT_CONTENTS_MISMATCH,
            'The number of serial numbers must equal the quantity.',
            [
              {
                field: `packages.${String(index)}.contents.${String(row)}.serialNumbers`,
                code: 'COUNT',
              },
            ],
          );
        }
      }
    }

    await tx.logisticsShipmentPackage.deleteMany({ where: { shipmentId: shipment.id } });

    for (const [index, pack] of input.packages.entries()) {
      const packageId = newId();
      await tx.logisticsShipmentPackage.create({
        data: {
          id: packageId,
          shipmentId: shipment.id,
          packageReference: `${shipment.shipmentReference}-${String(index + 1).padStart(2, '0')}`,
          sequence: index + 1,
          weightGrams: pack.grossWeightGrams,
          netWeightGrams: pack.netWeightGrams,
          lengthMm: pack.lengthMm,
          widthMm: pack.widthMm,
          heightMm: pack.heightMm,
          packagingType: pack.packagingType,
          containerNumber: pack.containerNumber === '' ? null : pack.containerNumber,
          sealNumber: pack.sealNumber === '' ? null : pack.sealNumber,
          isFragile: shipment.isFragile,
          requiresColdChain: shipment.requiresColdChain,
          batchReference:
            pack.contents.find((content) => content.batchNumber !== '')?.batchNumber ?? null,
        },
      });
      await tx.logisticsShipmentPackageLine.createMany({
        data: pack.contents.map((content) => ({
          id: newId(),
          packageId,
          shipmentId: shipment.id,
          orderItemId: content.orderItemId,
          quantity: content.quantity,
          batchNumber: content.batchNumber,
          expiryDate:
            content.expiryDate === null ? null : new Date(`${content.expiryDate}T00:00:00.000Z`),
          serialNumbersJson: (content.serialNumbers ?? undefined) as never,
        })),
      });
    }

    const gross = input.packages.reduce((sum, pack) => sum + pack.grossWeightGrams, 0);
    const volume = input.packages.reduce(
      (sum, pack) =>
        pack.lengthMm === null || pack.widthMm === null || pack.heightMm === null
          ? sum
          : sum + Math.round((pack.lengthMm * pack.widthMm * pack.heightMm) / 1000),
      0,
    );

    await tx.logisticsShipment.update({
      where: { id: shipment.id },
      data: {
        packageCount: input.packages.length,
        totalWeightGrams: gross,
        totalVolumeCm3: volume === 0 ? null : volume,
      },
    });

    // Any draft built on the old packages no longer describes them.
    await tx.sellerPackingList.updateMany({
      where: {
        logisticsShipmentId: shipment.id,
        status: { in: ['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'] },
      },
      data: { status: 'DRAFT' },
    });

    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'consignment.packages_saved',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'logistics_shipment',
      resourceId: shipment.id,
      after: { packages: input.packages.length, grossWeightGrams: gross },
      summary: `Packed ${String(input.packages.length)} package(s) for ${shipment.shipmentReference}`,
      tx,
    });
  });
}

/**
 * Compare what the packages hold with what the consignment carries. Empty when
 * they agree exactly - which a packing list must before it can be issued.
 */
export function contentsProblems(
  lines: readonly { orderItemId: string; quantity: number }[],
  packages: readonly { contents: readonly { orderItemId: string; quantity: number }[] }[],
  labels: ReadonlyMap<string, string>,
): ErrorDetail[] {
  const packed = new Map<string, number>();
  for (const pack of packages) {
    for (const content of pack.contents) {
      packed.set(content.orderItemId, (packed.get(content.orderItemId) ?? 0) + content.quantity);
    }
  }

  const problems: ErrorDetail[] = [];
  for (const line of lines) {
    const inPackages = packed.get(line.orderItemId) ?? 0;
    if (inPackages !== line.quantity) {
      problems.push({
        field: `contents.${line.orderItemId}`,
        code: 'MISMATCH',
        message: `${labels.get(line.orderItemId) ?? 'A line'}: ${String(inPackages)} packed, ${String(line.quantity)} in this consignment.`,
        meta: {
          name: labels.get(line.orderItemId) ?? '',
          packed: inPackages,
          carried: line.quantity,
        },
      });
    }
    packed.delete(line.orderItemId);
  }
  for (const [orderItemId] of packed) {
    problems.push({
      field: `contents.${orderItemId}`,
      code: 'NOT_CARRIED',
      message: 'A package holds something this consignment does not carry.',
    });
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

export const splitInputSchema = z
  .object({
    lines: z
      .array(
        z.object({ orderItemId: z.string().length(26), quantity: z.number().int().positive() }),
      )
      .min(1)
      .max(200),
  })
  .strict();

/**
 * Move part of a consignment onto a new one - a second vehicle, a second day.
 *
 * The new consignment copies the addresses, the parties and the handling of
 * the original, gets its own reference and tracking number, and carries
 * exactly the quantities named; the original keeps the rest. Refused once
 * either document is issued or the packages are locked, because the paperwork
 * already describes the load as it is.
 */
export async function splitConsignment(
  membership: SellerMembership,
  shipmentId: string,
  input: z.infer<typeof splitInputSchema>,
): Promise<{ shipmentId: string; shipmentReference: string }> {
  const original = await loadOwnedShipment(membership.sellerAccountId, shipmentId);
  if (DEAD_SHIPMENT.has(original.status)) {
    throw conflict(ErrorCode.SELLER_DOCUMENT_NOT_ELIGIBLE, 'This consignment is closed.', [
      { code: 'CLOSED' },
    ]);
  }
  const lock = await packagesLockReason(original.id);
  if (lock !== null) {
    throw conflict(ErrorCode.SHIPMENT_PACKAGES_LOCKED, PACKAGES_LOCK_MESSAGE[lock], [
      { code: lock },
    ]);
  }
  const invoiced = await prisma.sellerInvoice.count({
    where: { logisticsShipmentId: original.id, status: 'ISSUED' },
  });
  if (invoiced > 0) {
    throw conflict(
      ErrorCode.SELLER_DOCUMENT_IMMUTABLE,
      'This consignment is already invoiced. Credit the invoice before splitting it.',
      [{ code: 'INVOICED' }],
    );
  }

  const group = await loadGroup(original.sellerOrderGroupId ?? '');
  const { createShipment } = await import('../logistics/shipment-create.service.js');

  return prisma.$transaction(async (tx) => {
    const lines = await ensureShipmentLines(tx, original, group);
    const carried = new Map(lines.map((line) => [line.orderItemId, line.quantity]));

    const moving = new Map<string, number>();
    for (const line of input.lines)
      moving.set(line.orderItemId, (moving.get(line.orderItemId) ?? 0) + line.quantity);

    for (const [orderItemId, quantity] of moving) {
      const has = carried.get(orderItemId) ?? 0;
      if (quantity > has) {
        throw badRequest(
          ErrorCode.SHIPMENT_SPLIT_INVALID,
          `This consignment carries only ${String(has)} of that line.`,
          [{ field: `lines.${orderItemId}`, code: 'TOO_MANY', meta: { carried: has } }],
        );
      }
    }
    const remaining = [...carried].reduce(
      (sum, [orderItemId, quantity]) => sum + quantity - (moving.get(orderItemId) ?? 0),
      0,
    );
    if (remaining === 0) {
      throw badRequest(
        ErrorCode.SHIPMENT_SPLIT_INVALID,
        'A split must leave something on the original consignment.',
        [{ code: 'EMPTY' }],
      );
    }

    const pickup = original.pickupAddressJson as unknown as {
      line1: string;
      city: string;
      postalCode: string;
      countryCode: string;
    };
    const delivery = original.deliveryAddressJson as unknown as {
      line1: string;
      city: string;
      postalCode: string;
      countryCode: string;
    };

    const created = await createShipment(
      {
        orderId: original.orderId,
        sellerOrderGroupId: original.sellerOrderGroupId,
        originLocationId: original.originLocationId,
        serviceType: original.serviceType,
        sellerAccountId: original.sellerAccountId,
        sellerCompanyName: original.sellerCompanyName,
        receivingCustomerProfileId: original.receivingCustomerProfileId,
        receivingCompanyName: original.receivingCompanyName,
        pickupAddress: pickup,
        deliveryAddress: delivery,
        pickupContactName: original.pickupContactName,
        pickupContactPhone: original.pickupContactPhone,
        pickupContactEmail: original.pickupContactEmail,
        deliveryContactName: original.deliveryContactName,
        deliveryContactPhone: original.deliveryContactPhone,
        deliveryContactEmail: original.deliveryContactEmail,
        sellerFulfilmentMethodId: original.sellerFulfilmentMethodId,
        sellerCarrierConnectionId: original.sellerCarrierConnectionId,
        fulfilmentSelectionSource: original.fulfilmentSelectionSource,
        fulfilmentSelectionRuleId: original.fulfilmentSelectionRuleId,
        fulfilmentSelectionReason: original.fulfilmentSelectionReason,
        requiresColdChain: original.requiresColdChain,
        requiresTemperatureRange: original.requiresTemperatureRange,
        requiresSterileHandling: original.requiresSterileHandling,
        isFragile: original.isFragile,
        isDangerousGoods: original.isDangerousGoods,
        dangerousGoodsClass: original.dangerousGoodsClass,
        handlingNotes: original.handlingNotes,
        currency: original.currency,
        packageCount: 1,
      },
      undefined,
      tx,
    );

    await tx.logisticsShipment.update({
      where: { id: created.id },
      data: { splitFromShipmentId: original.id },
    });

    for (const [orderItemId, quantity] of moving) {
      const left = (carried.get(orderItemId) ?? 0) - quantity;
      if (left === 0) {
        await tx.logisticsShipmentLine.delete({
          where: { shipmentId_orderItemId: { shipmentId: original.id, orderItemId } },
        });
      } else {
        await tx.logisticsShipmentLine.update({
          where: { shipmentId_orderItemId: { shipmentId: original.id, orderItemId } },
          data: { quantity: left },
        });
      }
      await tx.logisticsShipmentLine.create({
        data: {
          id: newId(),
          shipmentId: created.id,
          sellerAccountId: membership.sellerAccountId,
          orderItemId,
          quantity,
        },
      });
    }

    // The original's packages described the whole load; they no longer do.
    await tx.logisticsShipmentPackageLine.deleteMany({ where: { shipmentId: original.id } });
    await tx.sellerInvoice.deleteMany({
      where: {
        logisticsShipmentId: original.id,
        status: { in: ['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'] },
      },
    });
    await tx.sellerPackingList.deleteMany({
      where: {
        logisticsShipmentId: original.id,
        status: { in: ['DRAFT', 'VALIDATION_REQUIRED', 'READY_TO_ISSUE'] },
      },
    });

    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: 'consignment.split',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'logistics_shipment',
      resourceId: original.id,
      after: {
        newShipmentId: created.id,
        lines: [...moving].map(([orderItemId, quantity]) => ({ orderItemId, quantity })),
      },
      summary: `Split ${original.shipmentReference} into ${created.shipmentReference}`,
      tx,
    });

    return { shipmentId: created.id, shipmentReference: created.shipmentReference };
  });
}
