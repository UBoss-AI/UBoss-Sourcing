/**
 * Available-to-promise for a seller's listing, and the stock a preorder holds.
 *
 * The arithmetic is `domain/preorder-availability.ts`. This file reads the
 * figures it needs and makes the one write that matters: holding stock for a
 * buyer who has accepted, without ever holding the same unit twice.
 *
 * HOW OVERSELLING IS PREVENTED
 *
 * `holdStockForPreorder` runs inside the buyer's acceptance transaction and:
 *
 *   1. locks the listing's stock rows (`SELECT ... FOR UPDATE`), so a second
 *      acceptance for the same listing waits for this one to commit;
 *   2. recomputes available-to-promise from those locked rows;
 *   3. takes the units with a conditional decrement
 *      (`availableQuantity >= n`) - the same guard every basket reservation
 *      uses - and writes the movement and the hold in the same transaction.
 *
 * If there is not enough, NOTHING is taken and the caller is told how much
 * there was. It never takes "as much as there is": a buyer who accepted
 * 15,000 from stock is not quietly given 12,000.
 *
 * Private to the seller: the per-location breakdown is only ever returned to
 * the seller's own screens. A buyer sees one number - what is available for
 * their first fulfilment - and never a warehouse.
 */
import { availableToPromise, type Atp } from '../../domain/preorder-availability.js';
import { newId } from '../../infra/ids.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { prisma } from '../../infra/prisma.js';
import { refreshOfferTotals } from '../seller/inventory.service.js';

type Client = PrismaTransaction | typeof prisma;

export interface OfferAvailability extends Atp {
  /** Seller-only. Sellable pieces at each location that may serve preorders. */
  byLocation: { locationId: string; availableQuantity: number }[];
}

async function unacceptedOrderQuantity(client: Client, offerId: string): Promise<number> {
  // A paid order the seller has not yet accepted holds no stock - acceptance
  // is where a marketplace order is reserved - but it has been sold, and a
  // preorder must not be promised the same units.
  const totals = await client.sellerOrderLine.aggregate({
    where: { offerId, orderGroup: { status: 'NEW' } },
    _sum: { quantity: true, fulfilledQuantity: true },
  });
  return Math.max(0, (totals._sum.quantity ?? 0) - (totals._sum.fulfilledQuantity ?? 0));
}

function locationFilter(eligibleLocationIds: readonly string[]) {
  return eligibleLocationIds.length > 0 ? { locationId: { in: [...eligibleLocationIds] } } : {};
}

/**
 * Available-to-promise for one listing, read now.
 *
 * `eligibleLocationIds` is the policy's list of places that may serve a
 * preorder; empty means every operational location.
 */
export async function offerAvailability(
  input: { offerId: string; eligibleLocationIds: readonly string[]; safetyStock: number },
  client: Client = prisma,
): Promise<OfferAvailability> {
  const rows = await client.sellerInventory.findMany({
    where: {
      offerId: input.offerId,
      ...locationFilter(input.eligibleLocationIds),
      location: { isOperational: true, archivedAt: null },
    },
    select: { locationId: true, availableQuantity: true },
  });
  const pending = await unacceptedOrderQuantity(client, input.offerId);
  const byLocation = rows.map((row) => ({
    locationId: row.locationId,
    availableQuantity: Math.max(0, row.availableQuantity),
  }));
  return {
    ...availableToPromise({
      locations: byLocation,
      unacceptedOrderQuantity: pending,
      safetyStock: input.safetyStock,
    }),
    byLocation,
  };
}

export type HoldResult =
  | { ok: true; heldBaseUnits: number; holds: { locationId: string; quantity: number }[] }
  | { ok: false; availableToPromise: number };

/**
 * Hold `quantity` pieces of this listing for an accepted preorder, or nothing.
 *
 * Must be called inside the acceptance transaction. The preferred location -
 * the one the seller said it ships from - is drawn on first, then the others
 * by how much each has, so a hold spans as few buildings as it can.
 */
export async function holdStockForPreorder(
  tx: PrismaTransaction,
  input: {
    requestId: string;
    offerId: string;
    sellerAccountId: string;
    quantity: number;
    preferredLocationId: string | null;
    eligibleLocationIds: readonly string[];
    safetyStock: number;
  },
): Promise<HoldResult> {
  if (input.quantity <= 0) return { ok: true, heldBaseUnits: 0, holds: [] };

  // Lock every stock row of the listing first. A second buyer accepting
  // against the same listing blocks here until this transaction ends, and then
  // reads the stock this one left.
  const locked = await tx.$queryRaw<
    { id: string; locationId: string; availableQuantity: number }[]
  >`
    SELECT si.id, si.locationId, si.availableQuantity
      FROM seller_inventory si
      JOIN seller_locations sl ON sl.id = si.locationId
     WHERE si.offerId = ${input.offerId}
       AND sl.isOperational = 1
       AND sl.archivedAt IS NULL
     FOR UPDATE`;

  const eligible =
    input.eligibleLocationIds.length > 0
      ? locked.filter((row) => input.eligibleLocationIds.includes(row.locationId))
      : locked;

  const atp = availableToPromise({
    locations: eligible.map((row) => ({
      locationId: row.locationId,
      availableQuantity: Number(row.availableQuantity),
    })),
    unacceptedOrderQuantity: await unacceptedOrderQuantity(tx, input.offerId),
    safetyStock: input.safetyStock,
  });

  if (atp.availableToPromise < input.quantity) {
    return { ok: false, availableToPromise: atp.availableToPromise };
  }

  const ordered = [...eligible].sort((a, b) => {
    if (a.locationId === input.preferredLocationId) return -1;
    if (b.locationId === input.preferredLocationId) return 1;
    return Number(b.availableQuantity) - Number(a.availableQuantity);
  });

  let remaining = input.quantity;
  const holds: { locationId: string; quantity: number }[] = [];

  for (const row of ordered) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Number(row.availableQuantity));
    if (take <= 0) continue;

    const updated = await tx.sellerInventory.updateMany({
      where: { id: row.id, availableQuantity: { gte: take } },
      data: {
        availableQuantity: { decrement: take },
        reservedQuantity: { increment: take },
        version: { increment: 1 },
      },
    });
    // Cannot happen under the lock above; refusing is still the only safe
    // answer if it ever does.
    if (updated.count !== 1) return { ok: false, availableToPromise: atp.availableToPromise };

    await tx.sellerInventoryMovement.create({
      data: {
        id: newId(),
        sellerAccountId: input.sellerAccountId,
        offerId: input.offerId,
        locationId: row.locationId,
        type: 'RESERVATION',
        quantityDelta: -take,
        balanceAfter: Number(row.availableQuantity) - take,
        referenceType: 'preorder_request',
        referenceId: input.requestId,
        reason: 'Held for an accepted preorder',
        idempotencyKey: `preorder-hold:${input.requestId}:${row.locationId}`,
      },
    });

    await tx.preorderStockHold.create({
      data: {
        id: newId(),
        requestId: input.requestId,
        sellerAccountId: input.sellerAccountId,
        offerId: input.offerId,
        locationId: row.locationId,
        quantityBaseUnits: take,
      },
    });

    holds.push({ locationId: row.locationId, quantity: take });
    remaining -= take;
  }

  if (remaining > 0) return { ok: false, availableToPromise: atp.availableToPromise };

  await refreshOfferTotals(tx, input.offerId);
  return { ok: true, heldBaseUnits: input.quantity, holds };
}

/**
 * Give a preorder's held stock back.
 *
 * `RELEASED` when the preorder ended without an order; `TRANSFERRED` when the
 * seller accepted the order and the order's own reservation takes over. Either
 * way the units return to available stock here, in the same transaction as
 * whatever ended the hold, and a hold already released is left alone - so a
 * cancellation handled twice cannot invent stock.
 */
export async function releasePreorderHolds(
  tx: PrismaTransaction,
  requestId: string,
  outcome: 'RELEASED' | 'TRANSFERRED',
): Promise<number> {
  const holds = await tx.preorderStockHold.findMany({ where: { requestId, status: 'HELD' } });
  let released = 0;
  const offers = new Set<string>();

  for (const hold of holds) {
    const claimed = await tx.preorderStockHold.updateMany({
      where: { id: hold.id, status: 'HELD' },
      data: { status: outcome, releasedAt: new Date() },
    });
    if (claimed.count !== 1) continue;

    const row = await tx.sellerInventory.findUnique({
      where: { offerId_locationId: { offerId: hold.offerId, locationId: hold.locationId } },
      select: { id: true, availableQuantity: true, reservedQuantity: true },
    });
    if (row === null) continue;

    const giving = Math.min(hold.quantityBaseUnits, row.reservedQuantity);
    if (giving <= 0) continue;

    await tx.sellerInventory.update({
      where: { id: row.id },
      data: {
        availableQuantity: { increment: giving },
        reservedQuantity: { decrement: giving },
        version: { increment: 1 },
      },
    });

    await tx.sellerInventoryMovement.create({
      data: {
        id: newId(),
        sellerAccountId: hold.sellerAccountId,
        offerId: hold.offerId,
        locationId: hold.locationId,
        type: 'RESERVATION_RELEASE',
        quantityDelta: giving,
        balanceAfter: row.availableQuantity + giving,
        referenceType: 'preorder_request',
        referenceId: requestId,
        reason:
          outcome === 'TRANSFERRED'
            ? 'Preorder hold handed to the accepted order'
            : 'Preorder closed; held stock released',
        idempotencyKey: `preorder-${outcome.toLowerCase()}:${hold.id}`,
      },
    });

    released += giving;
    offers.add(hold.offerId);
  }

  for (const offerId of offers) await refreshOfferTotals(tx, offerId);
  return released;
}
