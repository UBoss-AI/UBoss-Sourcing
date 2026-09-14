/**
 * A seller's stock: what is where, and every movement that put it there.
 *
 * Two rules, and neither is negotiable:
 *
 *   1. **The movements are the truth.** `SellerInventory.availableQuantity` is a
 *      running total kept for speed. It is only trustworthy because every write
 *      to it happens in the same transaction as the movement that explains it,
 *      and nothing ever edits a movement afterwards.
 *
 *   2. **Concurrency is handled with a conditional UPDATE, not a lock.** MariaDB
 *      10.4 has no `SELECT ... FOR UPDATE SKIP LOCKED`, so a decrement is
 *      "UPDATE ... WHERE id = ? AND version = ? AND availableQuantity >= ?" and
 *      a zero-row result means somebody else got there first. That is the same
 *      lease pattern `JobQueue` and `RecurringSchedule` use, and it is why two
 *      buyers reaching for the last unit produce one sale and one honest
 *      refusal rather than two sales.
 */
import type { SellerInventoryMovementType } from '../../generated/prisma/enums.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';

export interface InventoryRow {
  offerId: string;
  sellerSku: string;
  productName: string;
  locationId: string;
  locationName: string;
  locationCode: string;
  availableQuantity: number;
  reservedQuantity: number;
  quarantinedQuantity: number;
  reorderThreshold: number;
  batchNumber: string | null;
  expiresOn: string | null;
  erpQuantity: number | null;
  erpSyncedAt: string | null;
  /** True when available is at or below the threshold and the threshold is set. */
  isLow: boolean;
  version: number;
}

export interface InventoryQuery {
  locationId?: string | null;
  search?: string | null;
  /** Only rows at or below their reorder threshold. */
  lowOnly?: boolean;
  /** Only rows whose batch expires within this many days. */
  expiringWithinDays?: number | null;
  page?: number;
  pageSize?: number;
}

export async function listInventory(
  membership: SellerMembership,
  query: InventoryQuery,
): Promise<{ rows: InventoryRow[]; total: number }> {
  assertSellerPermission(membership, SellerPermission.INVENTORY_READ);

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, query.pageSize ?? 50));
  const search = query.search?.trim() ?? '';

  const expiryCutoff =
    query.expiringWithinDays === null || query.expiringWithinDays === undefined
      ? null
      : new Date(Date.now() + query.expiringWithinDays * 86_400_000);

  const where = {
    sellerAccountId: membership.sellerAccountId,
    ...(query.locationId === null || query.locationId === undefined ? {} : { locationId: query.locationId }),
    ...(expiryCutoff === null ? {} : { expiresOn: { not: null, lte: expiryCutoff } }),
    ...(search.length === 0
      ? {}
      : {
          OR: [
            { offer: { sellerSku: { contains: search } } },
            { offer: { product: { name: { contains: search } } } },
          ],
        }),
  };

  const [rows, total] = await Promise.all([
    prisma.sellerInventory.findMany({
      where,
      orderBy: [{ availableQuantity: 'asc' }, { updatedAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        location: { select: { id: true, name: true, code: true } },
        offer: { select: { sellerSku: true, product: { select: { name: true } } } },
      },
    }),
    prisma.sellerInventory.count({ where }),
  ]);

  const mapped = rows.map((row) => ({
    offerId: row.offerId,
    sellerSku: row.offer.sellerSku,
    productName: row.offer.product.name,
    locationId: row.locationId,
    locationName: row.location.name,
    locationCode: row.location.code,
    availableQuantity: row.availableQuantity,
    reservedQuantity: row.reservedQuantity,
    quarantinedQuantity: row.quarantinedQuantity,
    reorderThreshold: row.reorderThreshold,
    batchNumber: row.batchNumber,
    expiresOn: row.expiresOn?.toISOString().slice(0, 10) ?? null,
    erpQuantity: row.erpQuantity,
    erpSyncedAt: row.erpSyncedAt?.toISOString() ?? null,
    isLow: row.reorderThreshold > 0 && row.availableQuantity <= row.reorderThreshold,
    version: row.version,
  }));

  // The "low stock only" filter is applied here rather than in SQL because the
  // comparison is between two columns, which Prisma cannot express in a `where`
  // without a raw fragment. The page is already bounded, so the cost is the
  // page rather than the table - and a raw fragment here would be the one
  // place in this module a seller id was interpolated into SQL by hand.
  const filtered = query.lowOnly === true ? mapped.filter((row) => row.isLow) : mapped;

  return { rows: filtered, total };
}

export interface StockMovementInput {
  membership: SellerMembership;
  offerId: string;
  locationId: string;
  type: SellerInventoryMovementType;
  /** Signed. Negative takes stock away. */
  quantityDelta: number;
  reason?: string | null;
  batchNumber?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  /** Makes a retry harmless. Required for anything a worker or an ERP can repeat. */
  idempotencyKey?: string | null;
  correlationId?: string | null;
  tx?: PrismaTransaction;
}

/**
 * Move stock, and write the movement that explains it.
 *
 * The two writes are one transaction. A balance change without its movement is
 * stock that appeared from nowhere; a movement without its balance change is a
 * ledger that no longer adds up. Either one alone is worse than the operation
 * failing.
 */
export async function recordStockMovement(input: StockMovementInput): Promise<{ balance: number }> {
  const { membership } = input;

  // An adjustment can conjure or destroy stock, so it needs its own grant -
  // exactly as `inventory.adjust` does in the operator's catalogue.
  assertSellerPermission(
    membership,
    input.type === 'ADJUSTMENT' ? SellerPermission.INVENTORY_ADJUST : SellerPermission.INVENTORY_WRITE,
  );

  if (input.quantityDelta === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A movement of zero changes nothing.', [
      { field: 'quantityDelta', code: 'ZERO' },
    ]);
  }

  if (input.type === 'ADJUSTMENT' && (input.reason ?? '').trim().length === 0) {
    // The rule the operator's ledger already follows. An adjustment with no
    // reason is how stock quietly disappears and nobody can say when.
    throw badRequest(
      ErrorCode.ADJUSTMENT_REASON_REQUIRED,
      'Say why the count is being changed. It goes on the stock record.',
      [{ field: 'reason', code: 'REQUIRED' }],
    );
  }

  const run = async (tx: PrismaTransaction): Promise<{ balance: number }> => {
    if (input.idempotencyKey !== null && input.idempotencyKey !== undefined && input.idempotencyKey.length > 0) {
      const seen = await tx.sellerInventoryMovement.findFirst({
        where: {
          sellerAccountId: membership.sellerAccountId,
          idempotencyKey: input.idempotencyKey,
        },
        select: { balanceAfter: true },
      });

      // Already applied. Returning the balance it produced rather than
      // re-applying it is the whole point of the key.
      if (seen !== null) return { balance: seen.balanceAfter };
    }

    const row = await tx.sellerInventory.findUnique({
      where: { offerId_locationId: { offerId: input.offerId, locationId: input.locationId } },
      select: {
        id: true,
        sellerAccountId: true,
        availableQuantity: true,
        version: true,
      },
    });

    if (row === null) throw notFound('Stock record');
    assertSellerOwnership(membership, row.sellerAccountId, 'Stock record');

    const next = row.availableQuantity + input.quantityDelta;

    if (next < 0) {
      throw conflict(
        ErrorCode.INSUFFICIENT_STOCK,
        `Only ${String(row.availableQuantity)} in stock at this location.`,
        [{ field: 'quantityDelta', code: 'BELOW_ZERO', meta: { available: row.availableQuantity } }],
      );
    }

    // The conditional update. `version` in the WHERE is what makes this safe
    // without a row lock: if anybody else moved this stock since it was read,
    // no row matches and `count` is zero.
    const updated = await tx.sellerInventory.updateMany({
      where: { id: row.id, version: row.version },
      data: { availableQuantity: next, version: { increment: 1 } },
    });

    if (updated.count === 0) {
      throw conflict(
        ErrorCode.SELLER_INVENTORY_CONFLICT,
        'This stock was changed a moment ago. Try again.',
      );
    }

    await tx.sellerInventoryMovement.create({
      data: {
        id: newId(),
        sellerAccountId: membership.sellerAccountId,
        offerId: input.offerId,
        locationId: input.locationId,
        type: input.type,
        quantityDelta: input.quantityDelta,
        balanceAfter: next,
        reason: input.reason ?? null,
        batchNumber: input.batchNumber ?? null,
        referenceType: input.referenceType ?? null,
        referenceId: input.referenceId ?? null,
        actorProfileId: membership.customerProfileId,
        idempotencyKey: input.idempotencyKey ?? null,
      },
    });

    await refreshOfferTotals(tx, input.offerId);

    return { balance: next };
  };

  const result = input.tx !== undefined ? await run(input.tx) : await prisma.$transaction(run);

  await recordSellerAudit({
    sellerAccountId: membership.sellerAccountId,
    action: `seller.inventory.${input.type.toLowerCase()}`,
    actor: { type: 'CUSTOMER', label: membership.displayName },
    resourceType: 'seller_inventory',
    resourceId: input.offerId,
    after: { quantityDelta: input.quantityDelta, balance: result.balance },
    summary:
      input.quantityDelta > 0
        ? `${String(input.quantityDelta)} units added, leaving ${String(result.balance)}.`
        : `${String(-input.quantityDelta)} units removed, leaving ${String(result.balance)}.`,
    correlationId: input.correlationId ?? null,
  });

  return result;
}

/**
 * Reserve stock for an order, or refuse.
 *
 * Called inside the checkout transaction. The refusal is a normal outcome
 * rather than an error condition: two buyers reaching for the last unit is not
 * a fault, and the second one has to be told honestly rather than sold
 * something that does not exist.
 */
export async function reserveStock(
  tx: PrismaTransaction,
  input: { offerId: string; locationId: string; quantity: number; orderId: string },
): Promise<void> {
  const row = await tx.sellerInventory.findUnique({
    where: { offerId_locationId: { offerId: input.offerId, locationId: input.locationId } },
    select: { id: true, availableQuantity: true, reservedQuantity: true, version: true },
  });

  if (row === null) throw notFound('Stock record');

  if (row.availableQuantity < input.quantity) {
    throw conflict(
      ErrorCode.INSUFFICIENT_STOCK,
      `Only ${String(row.availableQuantity)} left.`,
      [{ code: 'INSUFFICIENT', meta: { available: row.availableQuantity } }],
    );
  }

  const updated = await tx.sellerInventory.updateMany({
    where: {
      id: row.id,
      version: row.version,
      // Repeated in the WHERE as well as checked above. The check above gives
      // the buyer a useful message; this one is what actually holds under
      // concurrency, because the read and the write are not atomic together.
      availableQuantity: { gte: input.quantity },
    },
    data: {
      availableQuantity: { decrement: input.quantity },
      reservedQuantity: { increment: input.quantity },
      version: { increment: 1 },
    },
  });

  if (updated.count === 0) {
    throw conflict(
      ErrorCode.SELLER_INVENTORY_CONFLICT,
      'Somebody else took the last of this while you were checking out.',
    );
  }

  const offer = await tx.sellerOffer.findUnique({
    where: { id: input.offerId },
    select: { sellerAccountId: true },
  });

  await tx.sellerInventoryMovement.create({
    data: {
      id: newId(),
      sellerAccountId: offer?.sellerAccountId ?? '',
      offerId: input.offerId,
      locationId: input.locationId,
      type: 'RESERVATION',
      quantityDelta: -input.quantity,
      balanceAfter: row.availableQuantity - input.quantity,
      referenceType: 'order',
      referenceId: input.orderId,
      // Derived from the order and the offer rather than random, so a retried
      // checkout cannot reserve the same units twice.
      idempotencyKey: `reserve:${input.orderId}:${input.offerId}:${input.locationId}`,
    },
  });

  await refreshOfferTotals(tx, input.offerId);
}

/**
 * Put the offer's cached totals back in step with its locations.
 *
 * Every write to a `SellerInventory` row has to end here. The columns on the
 * offer are what the storefront, the listings table and the buyer's basket
 * read - nothing walks the locations at read time - so a reservation that
 * moves a location row and leaves the offer alone keeps selling units that
 * are already promised to somebody else.
 *
 * Summed rather than adjusted by the delta, for the reason
 * `recordStockMovement` already sums: one query that cannot drift beats an
 * increment that drifts the first time a caller forgets it.
 */
async function refreshOfferTotals(tx: PrismaTransaction, offerId: string): Promise<void> {
  const totals = await tx.sellerInventory.aggregate({
    where: { offerId },
    _sum: { availableQuantity: true, reservedQuantity: true },
  });

  await tx.sellerOffer.update({
    where: { id: offerId },
    data: {
      availableQuantity: totals._sum.availableQuantity ?? 0,
      reservedQuantity: totals._sum.reservedQuantity ?? 0,
    },
  });
}

/** Give reserved stock back - a cancellation, an expired reservation. */
export async function releaseReservation(
  tx: PrismaTransaction,
  input: { offerId: string; locationId: string; quantity: number; orderId: string },
): Promise<void> {
  const row = await tx.sellerInventory.findUnique({
    where: { offerId_locationId: { offerId: input.offerId, locationId: input.locationId } },
    select: { id: true, availableQuantity: true, reservedQuantity: true, sellerAccountId: true },
  });

  if (row === null) return;

  // Never release more than is held. A double release would invent stock, and
  // a cancellation handled twice is exactly the shape that produces one.
  const releasing = Math.min(input.quantity, row.reservedQuantity);
  if (releasing <= 0) return;

  await tx.sellerInventory.update({
    where: { id: row.id },
    data: {
      availableQuantity: { increment: releasing },
      reservedQuantity: { decrement: releasing },
      version: { increment: 1 },
    },
  });

  await tx.sellerInventoryMovement.create({
    data: {
      id: newId(),
      sellerAccountId: row.sellerAccountId,
      offerId: input.offerId,
      locationId: input.locationId,
      type: 'RESERVATION_RELEASE',
      quantityDelta: releasing,
      balanceAfter: row.availableQuantity + releasing,
      referenceType: 'order',
      referenceId: input.orderId,
      idempotencyKey: `release:${input.orderId}:${input.offerId}:${input.locationId}`,
    },
  });

  await refreshOfferTotals(tx, input.offerId);
}

/**
 * Reserved stock leaves the building.
 *
 * The other half of `reserveStock`, and it lives here for the same reason:
 * the movement and the balance are one write, and a dispatch recorded without
 * its movement is a ledger that stops adding up.
 *
 * Capped at what is actually reserved rather than refusing. A seller shipping
 * a box is describing something that has already happened, and a hold that is
 * short - stock adjusted between accepting and packing - is not a reason to
 * refuse the parcel that is on the van. It is written down for exactly what it
 * was.
 */
export async function consumeReservation(
  tx: PrismaTransaction,
  input: {
    offerId: string;
    locationId: string;
    quantity: number;
    sellerAccountId: string;
    shipmentId: string;
    lineId: string;
  },
): Promise<void> {
  const row = await tx.sellerInventory.findUnique({
    where: { offerId_locationId: { offerId: input.offerId, locationId: input.locationId } },
    select: { id: true, availableQuantity: true, reservedQuantity: true },
  });

  if (row === null) return;

  const dispatching = Math.min(input.quantity, row.reservedQuantity);
  if (dispatching <= 0) return;

  await tx.sellerInventory.update({
    where: { id: row.id },
    data: { reservedQuantity: { decrement: dispatching }, version: { increment: 1 } },
  });

  await tx.sellerInventoryMovement.create({
    data: {
      id: newId(),
      sellerAccountId: input.sellerAccountId,
      offerId: input.offerId,
      locationId: input.locationId,
      type: 'DISPATCH',
      quantityDelta: -dispatching,
      balanceAfter: row.availableQuantity,
      referenceType: 'seller_shipment',
      referenceId: input.shipmentId,
      idempotencyKey: `dispatch:${input.shipmentId}:${input.lineId}`,
    },
  });

  await refreshOfferTotals(tx, input.offerId);
}

/** The stock ledger for one offer, most recent first. */
export async function listMovements(
  membership: SellerMembership,
  offerId: string,
  limit = 100,
): Promise<
  {
    id: string;
    type: string;
    quantityDelta: number;
    balanceAfter: number;
    reason: string | null;
    locationName: string;
    referenceType: string | null;
    referenceId: string | null;
    createdAt: string;
  }[]
> {
  assertSellerPermission(membership, SellerPermission.INVENTORY_READ);

  const rows = await prisma.sellerInventoryMovement.findMany({
    where: { sellerAccountId: membership.sellerAccountId, offerId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(500, Math.max(1, limit)),
    include: { location: { select: { name: true } } },
  });

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    quantityDelta: row.quantityDelta,
    balanceAfter: row.balanceAfter,
    reason: row.reason,
    locationName: row.location.name,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    createdAt: row.createdAt.toISOString(),
  }));
}

/** Change the reorder threshold and batch details on a stock row. */
export async function updateStockSettings(
  membership: SellerMembership,
  offerId: string,
  locationId: string,
  settings: {
    reorderThreshold?: number | null;
    batchNumber?: string | null;
    manufacturedOn?: string | null;
    expiresOn?: string | null;
  },
): Promise<void> {
  assertSellerPermission(membership, SellerPermission.INVENTORY_WRITE);

  const row = await prisma.sellerInventory.findUnique({
    where: { offerId_locationId: { offerId, locationId } },
    select: { id: true, sellerAccountId: true },
  });

  if (row === null) throw notFound('Stock record');
  assertSellerOwnership(membership, row.sellerAccountId, 'Stock record');

  if (settings.reorderThreshold !== null && settings.reorderThreshold !== undefined && settings.reorderThreshold < 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A reorder level cannot be negative.', [
      { field: 'reorderThreshold', code: 'NEGATIVE' },
    ]);
  }

  await prisma.sellerInventory.update({
    where: { id: row.id },
    data: {
      ...(settings.reorderThreshold === null || settings.reorderThreshold === undefined
        ? {}
        : { reorderThreshold: settings.reorderThreshold }),
      ...(settings.batchNumber === undefined ? {} : { batchNumber: settings.batchNumber }),
      ...(settings.manufacturedOn === undefined
        ? {}
        : {
            manufacturedOn:
              settings.manufacturedOn === null ? null : new Date(settings.manufacturedOn),
          }),
      ...(settings.expiresOn === undefined
        ? {}
        : { expiresOn: settings.expiresOn === null ? null : new Date(settings.expiresOn) }),
    },
  });
}
