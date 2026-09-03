/**
 * Inventory - integration, against a real MariaDB.
 *
 * The test that matters most is "two customers race for the last unit". If the
 * `SELECT ... FOR UPDATE` in `lockBalance` is wrong, both reservations succeed,
 * stock goes negative, and a customer is charged for something that cannot be
 * shipped. Everything else here protects the ledger that makes that provable.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import {
  adjustStock,
  commitReservations,
  getAvailability,
  getAvailabilityMap,
  receiveStock,
  releaseReservations,
  reserveStock,
  restockFromOrder,
  sweepExpiredReservations,
} from '../../src/modules/inventory/inventory.service.js';

let actor: { userId: string; email: string };
let locationId: string;
let productId: string;
let untrackedProductId: string;
let customerProfileId: string;

/**
 * Create a real order row.
 *
 * `stock_reservations.orderId` has a foreign key, so a synthetic id is
 * (correctly) rejected: a reservation must never point at an order that does
 * not exist.
 */
async function makeOrder(): Promise<string> {
  const id = newId();
  await prisma.order.create({
    data: {
      id,
      orderNumber: `UB-TEST-${id.slice(-10)}`,
      customerProfileId,
      status: 'PENDING_PAYMENT',
      currency: 'INR',
      billingAddressJson: { line1: 'Test', city: 'Pune', country: 'IN' },
      shippingAddressJson: { line1: 'Test', city: 'Pune', country: 'IN' },
    },
  });
  return id;
}

async function resetInventory(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.jobQueue.deleteMany({});
  await prisma.stockReservation.deleteMany({});
  await prisma.orderItem.deleteMany({});
  await prisma.orderStatusHistory.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.address.deleteMany({});
  await prisma.customerProfile.deleteMany({});
  await prisma.inventoryMovement.deleteMany({});
  await prisma.inventoryBalance.deleteMany({});
  await prisma.cartItem.deleteMany({});
  await prisma.cart.deleteMany({});
  await prisma.product.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.taxClass.deleteMany({});
  await prisma.inventoryLocation.deleteMany({});
  await prisma.user.deleteMany({
    where: { emailNormalized: { in: ['inventory@test.local', 'buyer@inventory.test'] } },
  });
}

beforeEach(async () => {
  await resetInventory();

  const actorId = newId();
  await prisma.user.create({
    data: {
      id: actorId,
      type: 'ADMIN',
      email: 'inventory@test.local',
      emailNormalized: 'inventory@test.local',
      status: 'ACTIVE',
    },
  });
  actor = { userId: actorId, email: 'inventory@test.local' };

  const buyerId = newId();
  await prisma.user.create({
    data: {
      id: buyerId,
      type: 'CUSTOMER',
      email: 'buyer@inventory.test',
      emailNormalized: 'buyer@inventory.test',
      status: 'ACTIVE',
    },
  });
  const profile = await prisma.customerProfile.create({
    data: { id: newId(), userId: buyerId, fullName: 'Test Buyer' },
  });
  customerProfileId = profile.id;

  const location = await prisma.inventoryLocation.create({
    data: { id: newId(), code: 'MAIN', name: 'Main', isDefault: true, isActive: true },
  });
  locationId = location.id;

  const taxClass = await prisma.taxClass.create({
    data: { id: newId(), code: 'GST18', name: 'GST 18%', ratePercent: '18.000000', isDefault: true },
  });
  const category = await prisma.category.create({
    data: { id: newId(), name: 'Fasteners', slug: 'fasteners', isActive: true },
  });

  const product = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Hex Bolt',
      slug: 'hex-bolt',
      sku: 'HEX-1',
      basePriceMinor: 4550n,
      currency: 'INR',
      isStockTracked: true,
      reorderThreshold: 5,
    },
  });
  productId = product.id;

  const untracked = await prisma.product.create({
    data: {
      id: newId(),
      categoryId: category.id,
      taxClassId: taxClass.id,
      name: 'Consulting Hour',
      slug: 'consulting-hour',
      sku: 'SVC-1',
      basePriceMinor: 500000n,
      currency: 'INR',
      isStockTracked: false,
    },
  });
  untrackedProductId = untracked.id;
});

afterAll(async () => {
  await resetInventory();
  await prisma.$disconnect();
});

describe('receiving stock', () => {
  it('increases on-hand and writes a ledger movement', async () => {
    const result = await receiveStock({ productId, quantity: 100 }, actor);

    expect(result.onHandQty).toBe(100);
    expect(result.availableQty).toBe(100);

    const movements = await prisma.inventoryMovement.findMany({ where: { productId } });
    expect(movements).toHaveLength(1);
    expect(movements[0]?.type).toBe('RECEIPT');
    expect(movements[0]?.quantityDelta).toBe(100);
    // The ledger records the balance after the movement, so it can be replayed.
    expect(movements[0]?.resultingOnHand).toBe(100);
  });

  it('accumulates across receipts', async () => {
    await receiveStock({ productId, quantity: 40 }, actor);
    const result = await receiveStock({ productId, quantity: 60 }, actor);
    expect(result.onHandQty).toBe(100);
  });

  it('rejects a non-positive quantity', async () => {
    await expect(receiveStock({ productId, quantity: 0 }, actor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
    await expect(receiveStock({ productId, quantity: -5 }, actor)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('writes an audit entry', async () => {
    await receiveStock({ productId, quantity: 10 }, actor);
    const entry = await prisma.auditLog.findFirst({ where: { action: 'inventory.received' } });
    expect(entry).not.toBeNull();
  });
});

describe('adjustments', () => {
  it('applies a signed correction and records the reason', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const result = await adjustStock({ productId, quantityDelta: -3, reason: 'Damaged in transit' }, actor);

    expect(result.onHandQty).toBe(97);

    const movement = await prisma.inventoryMovement.findFirst({
      where: { productId, type: 'ADJUSTMENT' },
    });
    expect(movement?.reason).toBe('Damaged in transit');
  });

  /** SOP 6: an unexplained adjustment is indistinguishable from theft. */
  it('requires a reason', async () => {
    await receiveStock({ productId, quantity: 10 }, actor);
    await expect(
      adjustStock({ productId, quantityDelta: -1, reason: '   ' }, actor),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_REASON_REQUIRED' });
  });

  it('rejects a zero adjustment', async () => {
    await expect(
      adjustStock({ productId, quantityDelta: 0, reason: 'No-op' }, actor),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('refuses to drive stock negative', async () => {
    await receiveStock({ productId, quantity: 5 }, actor);
    await expect(
      adjustStock({ productId, quantityDelta: -10, reason: 'Write-off' }, actor),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  /**
   * Reserved stock has been promised to a customer mid-checkout. An adjustment
   * must not be able to take it back out from under them.
   */
  it('refuses to drop on-hand below what is already reserved', async () => {
    await receiveStock({ productId, quantity: 10 }, actor);
    await reserveStock({ items: [{ productId, quantity: 8 }] });

    await expect(
      adjustStock({ productId, quantityDelta: -5, reason: 'Write-off' }, actor),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // The permitted amount still works.
    const result = await adjustStock({ productId, quantityDelta: -2, reason: 'Write-off' }, actor);
    expect(result.onHandQty).toBe(8);
  });
});

describe('reservations', () => {
  it('holds stock without reducing on-hand', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const result = await reserveStock({ items: [{ productId, quantity: 10 }] });

    expect(result.reservationIds).toHaveLength(1);

    const availability = await getAvailability({ productId });
    // On-hand is unchanged; only available drops. The goods are still here.
    expect(availability.onHandQty).toBe(100);
    expect(availability.reservedQty).toBe(10);
    expect(availability.availableQty).toBe(90);
  });

  it('refuses to reserve more than is available', async () => {
    await receiveStock({ productId, quantity: 5 }, actor);
    await expect(reserveStock({ items: [{ productId, quantity: 6 }] })).rejects.toMatchObject({
      code: 'INSUFFICIENT_STOCK',
    });
  });

  it('reports how many are actually available in the error detail', async () => {
    await receiveStock({ productId, quantity: 3 }, actor);

    const error = await reserveStock({ items: [{ productId, quantity: 10 }] }).catch(
      (e: unknown) => e,
    );

    const details = (error as { details: { meta?: Record<string, unknown> }[] }).details;
    expect(details[0]?.meta).toMatchObject({ requested: 10, available: 3 });
  });

  /**
   * All-or-nothing. A partially reserved cart would let a customer reach payment
   * for items that were never held.
   */
  it('rolls back every line when one line cannot be satisfied', async () => {
    const second = await prisma.product.create({
      data: {
        id: newId(),
        categoryId: (await prisma.category.findFirstOrThrow()).id,
        taxClassId: (await prisma.taxClass.findFirstOrThrow()).id,
        name: 'Nut M12',
        slug: 'nut-m12',
        sku: 'NUT-1',
        basePriceMinor: 1000n,
        currency: 'INR',
        isStockTracked: true,
      },
    });

    await receiveStock({ productId, quantity: 100 }, actor);
    await receiveStock({ productId: second.id, quantity: 1 }, actor);

    await expect(
      reserveStock({
        items: [
          { productId, quantity: 10 },
          { productId: second.id, quantity: 5 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });

    // Neither line was held.
    expect((await getAvailability({ productId })).reservedQty).toBe(0);
    expect((await getAvailability({ productId: second.id })).reservedQty).toBe(0);
    expect(await prisma.stockReservation.count()).toBe(0);
  });

  it('does not reserve an untracked product', async () => {
    const result = await reserveStock({ items: [{ productId: untrackedProductId, quantity: 999 }] });
    // Nothing to hold, and no failure - services are always available.
    expect(result.reservationIds).toHaveLength(0);
  });

  it('rejects an empty reservation', async () => {
    await expect(reserveStock({ items: [] })).rejects.toMatchObject({ code: 'CART_EMPTY' });
  });
});

describe('oversell prevention', () => {
  /**
   * THE test. Ten concurrent reservations for a stock of 3: exactly three must
   * succeed. This is what the raw `SELECT ... FOR UPDATE` in `lockBalance`
   * buys - without it every transaction reads available = 3 and all ten win.
   */
  it('lets only as many reservations succeed as there is stock', async () => {
    await receiveStock({ productId, quantity: 3 }, actor);

    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveStock({ items: [{ productId, quantity: 1 }] })),
    );

    const succeeded = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const failed = attempts.filter((attempt) => attempt.status === 'rejected');

    expect(succeeded).toHaveLength(3);
    expect(failed).toHaveLength(7);

    const availability = await getAvailability({ productId });
    expect(availability.reservedQty).toBe(3);
    expect(availability.availableQty).toBe(0);
    // The invariant that must never break.
    expect(availability.availableQty).toBeGreaterThanOrEqual(0);
  });

  it('lets exactly one of two customers take the last unit', async () => {
    await receiveStock({ productId, quantity: 1 }, actor);

    const [first, second] = await Promise.allSettled([
      reserveStock({ items: [{ productId, quantity: 1 }] }),
      reserveStock({ items: [{ productId, quantity: 1 }] }),
    ]);

    const outcomes = [first?.status, second?.status];
    expect(outcomes.filter((status) => status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((status) => status === 'rejected')).toHaveLength(1);
  });

  it('never leaves reserved above on-hand under concurrency', async () => {
    await receiveStock({ productId, quantity: 20 }, actor);

    await Promise.allSettled(
      Array.from({ length: 15 }, () => reserveStock({ items: [{ productId, quantity: 3 }] })),
    );

    const balance = await prisma.inventoryBalance.findFirstOrThrow({ where: { productId } });
    // Also enforced by chk_inventory_reserved_within_on_hand, so a breach here
    // would have failed at the database first.
    expect(balance.reservedQty).toBeLessThanOrEqual(balance.onHandQty);
  });
});

describe('committing reservations', () => {
  it('reduces on-hand and clears the reservation', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });

    await prisma.$transaction((tx) => commitReservations(orderId, tx));

    const availability = await getAvailability({ productId });
    expect(availability.onHandQty).toBe(90);
    expect(availability.reservedQty).toBe(0);
    expect(availability.availableQty).toBe(90);

    const movement = await prisma.inventoryMovement.findFirst({
      where: { productId, type: 'RESERVATION_COMMIT' },
    });
    expect(movement?.quantityDelta).toBe(-10);
    expect(movement?.referenceId).toBe(orderId);
  });

  /**
   * Idempotency. A duplicate payment webhook confirms the same order twice; the
   * second attempt must find nothing left to commit and change no stock.
   */
  it('is idempotent - a second commit does nothing', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });

    const first = await prisma.$transaction((tx) => commitReservations(orderId, tx));
    const second = await prisma.$transaction((tx) => commitReservations(orderId, tx));

    expect(first.committed).toBe(1);
    expect(second.committed).toBe(0);

    // Stock was reduced once, not twice.
    expect((await getAvailability({ productId })).onHandQty).toBe(90);
  });

  it('survives two concurrent commits of the same order', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });

    await Promise.allSettled([
      prisma.$transaction((tx) => commitReservations(orderId, tx)),
      prisma.$transaction((tx) => commitReservations(orderId, tx)),
    ]);

    expect((await getAvailability({ productId })).onHandQty).toBe(90);
    expect(await prisma.inventoryMovement.count({ where: { type: 'RESERVATION_COMMIT' } })).toBe(1);
  });
});

describe('releasing reservations', () => {
  it('returns held stock to available', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });

    const result = await releaseReservations({ orderId }, 'payment_failed');

    expect(result.released).toBe(1);
    const availability = await getAvailability({ productId });
    expect(availability.reservedQty).toBe(0);
    expect(availability.availableQty).toBe(100);
  });

  it('does not double-release', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });

    await releaseReservations({ orderId }, 'payment_failed');
    const second = await releaseReservations({ orderId }, 'payment_failed');

    expect(second.released).toBe(0);
    // A second release must not manufacture available stock.
    expect((await getAvailability({ productId })).availableQty).toBe(100);
  });

  it('cannot release a reservation that was already committed', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });
    await prisma.$transaction((tx) => commitReservations(orderId, tx));

    const result = await releaseReservations({ orderId }, 'cancelled');
    expect(result.released).toBe(0);
    // The sale stands.
    expect((await getAvailability({ productId })).onHandQty).toBe(90);
  });
});

describe('expiry sweep', () => {
  it('frees stock held by an abandoned checkout', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const cart = await prisma.cart.create({
      data: { id: newId(), currency: 'INR', status: 'ACTIVE' },
    });
    await reserveStock({ items: [{ productId, quantity: 10 }], cartId: cart.id });

    // Nothing to sweep while the lease is live.
    expect((await sweepExpiredReservations()).released).toBe(0);

    await prisma.stockReservation.updateMany({
      where: { cartId: cart.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    expect((await sweepExpiredReservations()).released).toBe(1);
    expect((await getAvailability({ productId })).availableQty).toBe(100);
  });
});

describe('restocking', () => {
  it('returns sellable stock after a cancellation', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });
    await prisma.$transaction((tx) => commitReservations(orderId, tx));

    await prisma.$transaction((tx) =>
      restockFromOrder(orderId, [{ productId, sellableQty: 10 }], 'ORDER_CANCEL_RESTOCK', tx),
    );

    expect((await getAvailability({ productId })).onHandQty).toBe(100);
  });

  /**
   * Damaged goods exist physically but must never become sellable. They are
   * recorded as a write-off so the ledger explains the difference.
   */
  it('quarantines damaged returns instead of restocking them', async () => {
    await receiveStock({ productId, quantity: 100 }, actor);
    const orderId = await makeOrder();
    await reserveStock({ items: [{ productId, quantity: 10 }], orderId });
    await prisma.$transaction((tx) => commitReservations(orderId, tx));

    await prisma.$transaction((tx) =>
      restockFromOrder(
        orderId,
        [{ productId, sellableQty: 7, damagedQty: 3 }],
        'RETURN_RESTOCK',
        tx,
      ),
    );

    // 90 committed + 7 sellable back = 97. The 3 damaged never return.
    expect((await getAvailability({ productId })).onHandQty).toBe(97);

    const quarantine = await prisma.inventoryMovement.findFirst({
      where: { type: 'RETURN_QUARANTINE' },
    });
    expect(quarantine?.quantityDelta).toBe(-3);
  });
});

describe('low stock', () => {
  it('queues an alert when available crosses the threshold', async () => {
    await receiveStock({ productId, quantity: 10 }, actor);
    expect(await prisma.jobQueue.count({ where: { jobType: 'low_stock.check' } })).toBe(0);

    // Threshold is 5; dropping to 4 crosses it.
    await adjustStock({ productId, quantityDelta: -6, reason: 'Write-off' }, actor);

    expect(await prisma.jobQueue.count({ where: { jobType: 'low_stock.check' } })).toBe(1);
  });

  /** One alert per SKU per day, not one per movement below the line. */
  it('does not re-alert on every movement while already low', async () => {
    await receiveStock({ productId, quantity: 10 }, actor);
    await adjustStock({ productId, quantityDelta: -6, reason: 'Write-off' }, actor);
    await adjustStock({ productId, quantityDelta: -1, reason: 'Write-off' }, actor);
    await adjustStock({ productId, quantityDelta: -1, reason: 'Write-off' }, actor);

    expect(await prisma.jobQueue.count({ where: { jobType: 'low_stock.check' } })).toBe(1);
  });

  it('reports the low-stock flag on a read', async () => {
    await receiveStock({ productId, quantity: 4 }, actor);
    const availability = await getAvailability({ productId });
    expect(availability.isLowStock).toBe(true);
  });
});

describe('bulk availability', () => {
  it('returns available quantities keyed by product and variant', async () => {
    await receiveStock({ productId, quantity: 50 }, actor);
    await reserveStock({ items: [{ productId, quantity: 10 }] });

    const map = await getAvailabilityMap([{ productId }], locationId);
    expect(map.get(`${productId}:`)).toBe(40);
  });

  it('returns an empty map for no keys', async () => {
    expect((await getAvailabilityMap([])).size).toBe(0);
  });
});
