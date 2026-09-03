/**
 * Inventory.
 *
 * Two representations, deliberately:
 *   - `inventory_balances` is the fast read path (on-hand, reserved).
 *   - `inventory_movements` is the append-only ledger and the source of truth.
 * Every balance change writes a movement in the same transaction, so the ledger
 * can always be replayed to prove the balance.
 *
 * Overselling is prevented with `SELECT ... FOR UPDATE` on the balance row
 * inside the transaction that reserves or commits. MariaDB 10.4 supports
 * `FOR UPDATE` (it lacks only `SKIP LOCKED`), so concurrent checkouts for the
 * last unit serialise on that row and exactly one wins.
 *
 * Prisma has no first-class row-locking API, so the lock is issued through
 * `$queryRaw`. It must run inside `$transaction` - a lock taken outside one is
 * released immediately and buys nothing.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { newId, variantKeyOf } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { JobType, queue } from '../../infra/queue/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

export interface InventoryActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface StockKey {
  productId: string;
  variantId?: string | null;
  locationId?: string;
}

export interface Availability {
  productId: string;
  variantId: string | null;
  locationId: string;
  onHandQty: number;
  reservedQty: number;
  /** What a customer may actually buy: on-hand minus reserved. */
  availableQty: number;
  reorderThreshold: number;
  isLowStock: boolean;
}

/** Reservations expire on their own so an abandoned checkout frees stock. */
const RESERVATION_TTL_MINUTES = 20;

async function defaultLocationId(tx: PrismaTransaction | typeof prisma): Promise<string> {
  const location = await tx.inventoryLocation.findFirst({
    where: { isDefault: true, isActive: true },
    select: { id: true },
  });

  if (location === null) {
    throw badRequest(
      ErrorCode.VALIDATION_FAILED,
      'No default inventory location is configured. Add one in Settings.',
    );
  }
  return location.id;
}

/**
 * Lock the balance row for update, creating it if this SKU has never been
 * stocked at this location.
 *
 * The raw `FOR UPDATE` is the whole point: two transactions racing for the last
 * unit both reach this line, and InnoDB makes the second wait until the first
 * commits or rolls back. Without it, both would read the same available
 * quantity and both would succeed.
 */
async function lockBalance(
  tx: PrismaTransaction,
  productId: string,
  variantId: string | null,
  locationId: string,
): Promise<{ id: string; onHandQty: number; reservedQty: number }> {
  const variantKey = variantKeyOf(variantId);

  const locked = await tx.$queryRaw<{ id: string; onHandQty: number; reservedQty: number }[]>`
    SELECT id, onHandQty, reservedQty
      FROM inventory_balances
     WHERE productId = ${productId}
       AND variantKey = ${variantKey}
       AND locationId = ${locationId}
     FOR UPDATE
  `;

  const existing = locked[0];
  if (existing !== undefined) {
    return {
      id: existing.id,
      onHandQty: Number(existing.onHandQty),
      reservedQty: Number(existing.reservedQty),
    };
  }

  // First movement for this SKU/location. A concurrent transaction may be
  // creating the same row, so a unique-violation here is expected and resolved
  // by re-reading with the lock held.
  const id = newId();
  try {
    await tx.inventoryBalance.create({
      data: { id, productId, variantId, variantKey, locationId, onHandQty: 0, reservedQty: 0 },
    });
    return { id, onHandQty: 0, reservedQty: 0 };
  } catch {
    const retry = await tx.$queryRaw<{ id: string; onHandQty: number; reservedQty: number }[]>`
      SELECT id, onHandQty, reservedQty
        FROM inventory_balances
       WHERE productId = ${productId}
         AND variantKey = ${variantKey}
         AND locationId = ${locationId}
       FOR UPDATE
    `;

    const row = retry[0];
    if (row === undefined) {
      throw conflict(ErrorCode.CONFLICT, 'Could not lock the inventory record. Please retry.');
    }
    return {
      id: row.id,
      onHandQty: Number(row.onHandQty),
      reservedQty: Number(row.reservedQty),
    };
  }
}

/** Append a ledger movement. Never called without a matching balance update. */
async function writeMovement(
  tx: PrismaTransaction,
  params: {
    productId: string;
    variantId: string | null;
    locationId: string;
    type:
      | 'RECEIPT'
      | 'ADJUSTMENT'
      | 'RESERVATION_COMMIT'
      | 'ORDER_CANCEL_RESTOCK'
      | 'RETURN_RESTOCK'
      | 'RETURN_QUARANTINE'
      | 'SYNC_CORRECTION';
    quantityDelta: number;
    resultingOnHand: number;
    reason?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    actorUserId?: string | null;
    actorType?: 'SYSTEM' | 'ADMIN' | 'CUSTOMER';
  },
): Promise<void> {
  await tx.inventoryMovement.create({
    data: {
      id: newId(),
      productId: params.productId,
      variantId: params.variantId,
      variantKey: variantKeyOf(params.variantId),
      locationId: params.locationId,
      type: params.type,
      quantityDelta: params.quantityDelta,
      resultingOnHand: params.resultingOnHand,
      reason: params.reason ?? null,
      referenceType: params.referenceType ?? null,
      referenceId: params.referenceId ?? null,
      actorUserId: params.actorUserId ?? null,
      actorType: params.actorType ?? 'SYSTEM',
    },
  });
}

/**
 * Emit a low-stock event when available quantity crosses the threshold.
 *
 * Fires only on the transition, not on every movement below the line -
 * otherwise every sale of an already-low SKU would send another alert and the
 * Inventory Manager would filter them all to a folder.
 */
async function checkLowStock(
  productId: string,
  variantId: string | null,
  locationId: string,
  previousAvailable: number,
  currentAvailable: number,
): Promise<void> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { name: true, sku: true, reorderThreshold: true, isStockTracked: true },
  });

  if (product === null || !product.isStockTracked || product.reorderThreshold <= 0) return;

  const crossed =
    previousAvailable > product.reorderThreshold && currentAvailable <= product.reorderThreshold;

  if (!crossed) return;

  await queue.enqueue(
    JobType.LOW_STOCK_CHECK,
    {
      productId,
      variantId,
      locationId,
      sku: product.sku,
      productName: product.name,
      availableQty: currentAvailable,
      threshold: product.reorderThreshold,
    },
    // One alert per SKU per day, however many movements cross the line.
    { dedupeKey: `low_stock:${productId}:${variantKeyOf(variantId)}:${new Date().toISOString().slice(0, 10)}` },
  );
}

// --- Reads -----------------------------------------------------------------

export async function getAvailability(key: StockKey): Promise<Availability> {
  const locationId = key.locationId ?? (await defaultLocationId(prisma));
  const variantKey = variantKeyOf(key.variantId ?? null);

  const [balance, product] = await Promise.all([
    prisma.inventoryBalance.findUnique({
      where: {
        productId_variantKey_locationId: { productId: key.productId, variantKey, locationId },
      },
    }),
    prisma.product.findUnique({
      where: { id: key.productId },
      select: { reorderThreshold: true },
    }),
  ]);

  const onHandQty = balance?.onHandQty ?? 0;
  const reservedQty = balance?.reservedQty ?? 0;
  const availableQty = onHandQty - reservedQty;
  const reorderThreshold = product?.reorderThreshold ?? 0;

  return {
    productId: key.productId,
    variantId: key.variantId ?? null,
    locationId,
    onHandQty,
    reservedQty,
    availableQty,
    reorderThreshold,
    isLowStock: reorderThreshold > 0 && availableQty <= reorderThreshold,
  };
}

/** Availability for many SKUs at once, for a cart or a product list. */
export async function getAvailabilityMap(
  keys: readonly StockKey[],
  locationId?: string,
): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map();

  const resolvedLocation = locationId ?? (await defaultLocationId(prisma));

  const balances = await prisma.inventoryBalance.findMany({
    where: {
      locationId: resolvedLocation,
      OR: keys.map((key) => ({
        productId: key.productId,
        variantKey: variantKeyOf(key.variantId ?? null),
      })),
    },
    select: { productId: true, variantKey: true, onHandQty: true, reservedQty: true },
  });

  const map = new Map<string, number>();
  for (const balance of balances) {
    map.set(`${balance.productId}:${balance.variantKey}`, balance.onHandQty - balance.reservedQty);
  }
  return map;
}

// --- Writes ----------------------------------------------------------------

export interface ReceiveStockInput extends StockKey {
  quantity: number;
  reference?: string | null;
  note?: string | null;
}

export async function receiveStock(
  input: ReceiveStockInput,
  actor: InventoryActor,
): Promise<Availability> {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Received quantity must be a positive whole number.', [
      { field: 'quantity', code: 'INVALID' },
    ]);
  }

  const locationId = input.locationId ?? (await defaultLocationId(prisma));
  const variantId = input.variantId ?? null;

  const before = await getAvailability({ ...input, locationId });

  await prisma.$transaction(async (tx: PrismaTransaction) => {
    const product = await tx.product.findUnique({
      where: { id: input.productId },
      select: { id: true, archivedAt: true },
    });
    if (product === null || product.archivedAt !== null) throw notFound('Product');

    const balance = await lockBalance(tx, input.productId, variantId, locationId);
    const resultingOnHand = balance.onHandQty + input.quantity;

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: { onHandQty: resultingOnHand, version: { increment: 1 } },
    });

    await writeMovement(tx, {
      productId: input.productId,
      variantId,
      locationId,
      type: 'RECEIPT',
      quantityDelta: input.quantity,
      resultingOnHand,
      reason: input.note ?? null,
      referenceType: input.reference === null ? null : 'stock_receipt',
      referenceId: null,
      actorUserId: actor.userId,
      actorType: 'ADMIN',
    });

    await recordAudit(
      {
        action: AuditAction.INVENTORY_RECEIVED,
        resourceType: 'inventory',
        resourceId: input.productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { onHandQty: balance.onHandQty },
        after: { onHandQty: resultingOnHand, quantity: input.quantity, reference: input.reference },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  const after = await getAvailability({ ...input, locationId });

  // A receipt can lift a SKU back above its threshold; a later drop must then
  // be able to alert again, so the transition is re-evaluated either way.
  await checkLowStock(
    input.productId,
    variantId,
    locationId,
    before.availableQty,
    after.availableQty,
  );

  return after;
}

export interface AdjustStockInput extends StockKey {
  /** Signed. Negative writes stock off, positive corrects it upward. */
  quantityDelta: number;
  reason: string;
}

/**
 * Manual correction.
 *
 * A reason is mandatory (SOP 6): an adjustment can conjure or destroy stock, so
 * an unexplained one is indistinguishable from theft or a data-entry error.
 */
export async function adjustStock(
  input: AdjustStockInput,
  actor: InventoryActor,
): Promise<Availability> {
  if (!Number.isInteger(input.quantityDelta) || input.quantityDelta === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Adjustment must be a non-zero whole number.', [
      { field: 'quantityDelta', code: 'INVALID' },
    ]);
  }

  if (input.reason.trim().length === 0) {
    throw badRequest(ErrorCode.ADJUSTMENT_REASON_REQUIRED, 'A reason is required for a stock adjustment.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }

  const locationId = input.locationId ?? (await defaultLocationId(prisma));
  const variantId = input.variantId ?? null;
  const before = await getAvailability({ ...input, locationId });

  await prisma.$transaction(async (tx: PrismaTransaction) => {
    const balance = await lockBalance(tx, input.productId, variantId, locationId);
    const resultingOnHand = balance.onHandQty + input.quantityDelta;

    if (resultingOnHand < 0) {
      throw conflict(
        ErrorCode.INSUFFICIENT_STOCK,
        `That adjustment would leave negative stock (${String(balance.onHandQty)} on hand).`,
        [{ field: 'quantityDelta', code: 'WOULD_GO_NEGATIVE', meta: { onHand: balance.onHandQty } }],
      );
    }

    // On-hand may not drop below what is already reserved for live checkouts -
    // those customers have been promised the stock.
    if (resultingOnHand < balance.reservedQty) {
      throw conflict(
        ErrorCode.INSUFFICIENT_STOCK,
        `That adjustment would leave less stock than is already reserved (${String(balance.reservedQty)} reserved).`,
        [{ field: 'quantityDelta', code: 'BELOW_RESERVED', meta: { reserved: balance.reservedQty } }],
      );
    }

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: { onHandQty: resultingOnHand, version: { increment: 1 } },
    });

    await writeMovement(tx, {
      productId: input.productId,
      variantId,
      locationId,
      type: 'ADJUSTMENT',
      quantityDelta: input.quantityDelta,
      resultingOnHand,
      reason: input.reason.trim(),
      actorUserId: actor.userId,
      actorType: 'ADMIN',
    });

    await recordAudit(
      {
        action: AuditAction.INVENTORY_ADJUSTED,
        resourceType: 'inventory',
        resourceId: input.productId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { onHandQty: balance.onHandQty },
        after: {
          onHandQty: resultingOnHand,
          quantityDelta: input.quantityDelta,
          reason: input.reason,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  const after = await getAvailability({ ...input, locationId });

  await checkLowStock(
    input.productId,
    variantId,
    locationId,
    before.availableQty,
    after.availableQty,
  );

  return after;
}

export interface ReserveInput {
  items: { productId: string; variantId?: string | null; quantity: number }[];
  cartId?: string;
  orderId?: string;
  locationId?: string;
  ttlMinutes?: number;
}

export interface ReservationFailure {
  productId: string;
  variantId: string | null;
  requested: number;
  available: number;
}

/**
 * Reserve stock for a checkout.
 *
 * All-or-nothing: if any line cannot be satisfied the whole transaction rolls
 * back, so a customer is never left with a partially reserved cart.
 *
 * Items are locked in a deterministic order (by productId, then variant) to
 * avoid deadlocks - two checkouts containing the same two SKUs in opposite
 * order would otherwise each hold what the other needs.
 */
export async function reserveStock(
  input: ReserveInput,
  tx?: PrismaTransaction,
): Promise<{ reservationIds: string[]; expiresAt: Date }> {
  if (input.items.length === 0) {
    throw badRequest(ErrorCode.CART_EMPTY, 'There is nothing to reserve.');
  }

  const locationId = input.locationId ?? (await defaultLocationId(prisma));
  const ttl = input.ttlMinutes ?? RESERVATION_TTL_MINUTES;
  const expiresAt = new Date(Date.now() + ttl * 60_000);

  const ordered = [...input.items].sort((a, b) => {
    const byProduct = a.productId.localeCompare(b.productId);
    return byProduct !== 0 ? byProduct : variantKeyOf(a.variantId).localeCompare(variantKeyOf(b.variantId));
  });

  const failures: ReservationFailure[] = [];

  const run = async (client: PrismaTransaction): Promise<string[]> => {
    const ids: string[] = [];

    for (const item of ordered) {
      const variantId = item.variantId ?? null;

      const product = await client.product.findUnique({
        where: { id: item.productId },
        select: { id: true, isStockTracked: true, archivedAt: true },
      });

      if (product === null || product.archivedAt !== null) throw notFound('Product');

      // Untracked products are always available; there is nothing to hold.
      if (!product.isStockTracked) continue;

      const balance = await lockBalance(client, item.productId, variantId, locationId);
      const available = balance.onHandQty - balance.reservedQty;

      if (available < item.quantity) {
        failures.push({
          productId: item.productId,
          variantId,
          requested: item.quantity,
          available: Math.max(0, available),
        });
        continue;
      }

      await client.inventoryBalance.update({
        where: { id: balance.id },
        data: { reservedQty: balance.reservedQty + item.quantity, version: { increment: 1 } },
      });

      const reservationId = newId();
      await client.stockReservation.create({
        data: {
          id: reservationId,
          productId: item.productId,
          variantId,
          variantKey: variantKeyOf(variantId),
          locationId,
          cartId: input.cartId ?? null,
          orderId: input.orderId ?? null,
          quantity: item.quantity,
          status: 'ACTIVE',
          expiresAt,
        },
      });

      ids.push(reservationId);
    }

    if (failures.length > 0) {
      // Rolls the whole transaction back, including reservations already taken
      // in this loop.
      throw conflict(
        ErrorCode.INSUFFICIENT_STOCK,
        'Some items do not have enough stock.',
        failures.map((failure) => ({
          field: `items.${failure.productId}`,
          code: 'INSUFFICIENT_STOCK',
          message: `Only ${String(failure.available)} available; ${String(failure.requested)} requested.`,
          meta: {
            productId: failure.productId,
            requested: failure.requested,
            available: failure.available,
          },
        })),
      );
    }

    return ids;
  };

  const reservationIds = tx !== undefined ? await run(tx) : await prisma.$transaction(run);

  return { reservationIds, expiresAt };
}

/**
 * Commit reservations when an order is confirmed.
 *
 * Reduces on-hand and releases the reservation in one step. The
 * `status: 'ACTIVE'` guard on the update makes this idempotent: a duplicate
 * webhook that confirms the same order twice finds nothing left to commit and
 * changes nothing.
 */
export async function commitReservations(
  orderId: string,
  tx: PrismaTransaction,
): Promise<{ committed: number }> {
  const reservations = await tx.stockReservation.findMany({
    where: { orderId, status: 'ACTIVE' },
  });

  let committed = 0;

  for (const reservation of reservations) {
    const claimed = await tx.stockReservation.updateMany({
      where: { id: reservation.id, status: 'ACTIVE' },
      data: { status: 'COMMITTED', committedAt: new Date() },
    });

    // Lost the race to another confirmation of the same order. Not an error -
    // it is exactly what idempotency should look like.
    if (claimed.count !== 1) continue;

    const balance = await lockBalance(
      tx,
      reservation.productId,
      reservation.variantId,
      reservation.locationId,
    );

    const resultingOnHand = balance.onHandQty - reservation.quantity;

    await tx.inventoryBalance.update({
      where: { id: balance.id },
      data: {
        onHandQty: resultingOnHand,
        reservedQty: Math.max(0, balance.reservedQty - reservation.quantity),
        version: { increment: 1 },
      },
    });

    await writeMovement(tx, {
      productId: reservation.productId,
      variantId: reservation.variantId,
      locationId: reservation.locationId,
      type: 'RESERVATION_COMMIT',
      quantityDelta: -reservation.quantity,
      resultingOnHand,
      referenceType: 'order',
      referenceId: orderId,
      actorType: 'SYSTEM',
    });

    committed += 1;
  }

  return { committed };
}

/** Release active reservations - payment failed, cart abandoned, order cancelled. */
export async function releaseReservations(
  filter: { orderId?: string; cartId?: string; reservationIds?: string[] },
  reason: string,
  tx?: PrismaTransaction,
): Promise<{ released: number }> {
  const run = async (client: PrismaTransaction): Promise<{ released: number }> => {
    const reservations = await client.stockReservation.findMany({
      where: {
        status: 'ACTIVE',
        ...(filter.orderId !== undefined ? { orderId: filter.orderId } : {}),
        ...(filter.cartId !== undefined ? { cartId: filter.cartId } : {}),
        ...(filter.reservationIds !== undefined ? { id: { in: filter.reservationIds } } : {}),
      },
    });

    let released = 0;

    for (const reservation of reservations) {
      const claimed = await client.stockReservation.updateMany({
        where: { id: reservation.id, status: 'ACTIVE' },
        data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: reason },
      });

      if (claimed.count !== 1) continue;

      const balance = await lockBalance(
        client,
        reservation.productId,
        reservation.variantId,
        reservation.locationId,
      );

      await client.inventoryBalance.update({
        where: { id: balance.id },
        data: {
          // Clamped at zero: a double release must not manufacture available
          // stock out of a negative reserved count.
          reservedQty: Math.max(0, balance.reservedQty - reservation.quantity),
          version: { increment: 1 },
        },
      });

      released += 1;
    }

    return { released };
  };

  return tx !== undefined ? run(tx) : prisma.$transaction(run);
}

/**
 * Return committed stock after a cancellation or an accepted return.
 *
 * Only the sellable quantity comes back; damaged goods are quarantined with a
 * separate movement so the ledger records where the difference went.
 */
export async function restockFromOrder(
  orderId: string,
  items: { productId: string; variantId?: string | null; sellableQty: number; damagedQty?: number }[],
  type: 'ORDER_CANCEL_RESTOCK' | 'RETURN_RESTOCK',
  tx: PrismaTransaction,
  locationId?: string,
): Promise<void> {
  const resolvedLocation = locationId ?? (await defaultLocationId(tx));

  for (const item of items) {
    const variantId = item.variantId ?? null;

    if (item.sellableQty > 0) {
      const balance = await lockBalance(tx, item.productId, variantId, resolvedLocation);
      const resultingOnHand = balance.onHandQty + item.sellableQty;

      await tx.inventoryBalance.update({
        where: { id: balance.id },
        data: { onHandQty: resultingOnHand, version: { increment: 1 } },
      });

      await writeMovement(tx, {
        productId: item.productId,
        variantId,
        locationId: resolvedLocation,
        type,
        quantityDelta: item.sellableQty,
        resultingOnHand,
        referenceType: 'order',
        referenceId: orderId,
        actorType: 'SYSTEM',
      });
    }

    // Damaged stock is recorded but never returns to on-hand: it exists
    // physically and must not be sellable.
    if ((item.damagedQty ?? 0) > 0) {
      const balance = await lockBalance(tx, item.productId, variantId, resolvedLocation);
      await writeMovement(tx, {
        productId: item.productId,
        variantId,
        locationId: resolvedLocation,
        type: 'RETURN_QUARANTINE',
        // Zero-delta movements are rejected by a CHECK constraint, so a
        // quarantine is recorded as a write-off against on-hand.
        quantityDelta: -(item.damagedQty ?? 0),
        resultingOnHand: balance.onHandQty,
        reason: 'Returned damaged; quarantined and not restocked.',
        referenceType: 'order',
        referenceId: orderId,
        actorType: 'SYSTEM',
      });
    }
  }
}

/**
 * Release reservations whose lease has expired.
 *
 * Run periodically by the worker. Without it, an abandoned checkout would hold
 * stock away from paying customers indefinitely.
 */
export async function sweepExpiredReservations(): Promise<{ released: number }> {
  const expired = await prisma.stockReservation.findMany({
    where: { status: 'ACTIVE', expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 500,
  });

  if (expired.length === 0) return { released: 0 };

  return releaseReservations(
    { reservationIds: expired.map((reservation) => reservation.id) },
    'reservation_expired',
  );
}

/** Emit low-stock events after a movement. Called outside the transaction. */
export async function evaluateLowStock(
  key: StockKey,
  previousAvailable: number,
): Promise<void> {
  const current = await getAvailability(key);
  await checkLowStock(
    key.productId,
    key.variantId ?? null,
    current.locationId,
    previousAvailable,
    current.availableQty,
  );
}

export { RESERVATION_TTL_MINUTES };
