/**
 * The seller's half of an order.
 *
 * A buyer places ONE order. That order may hold lines from three sellers
 * shipping from four warehouses, and every one of those sellers needs to see
 * their part, accept it, pick it and ship it - without seeing the other two.
 *
 * So `Order` is untouched. It still belongs to the buyer, still carries one
 * payment and one invoice, and still moves through `assertTransition` in
 * `order-state-machine.ts`. What this module adds is a GROUP over its lines,
 * with its own status, its own numbering and its own money.
 *
 * The alternative - an `Order` row per seller - was rejected: it gives the
 * buyer three order numbers for one checkout, three payment intents, three
 * invoices and three delivery estimates, and it would mean touching every
 * existing order path in the system.
 *
 * COMMISSION IS FROZEN AT CREATION
 *
 * `commissionBasisPointsApplied` is stored on the group, not looked up when the
 * settlement runs. A seller's earnings must not move because an operator edited
 * a rate in between, and a disputed settlement has to be recomputable from what
 * was in force on the day.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  SELLER_ORDER_STOCK_HELD,
  dispatchDeadline,
  allowedSellerOrderTransitions,
  assertSellerOrderTransition,
  type SellerOrderGroupStatusName,
} from '../../domain/seller-state.js';
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { recordSellerAudit } from './audit.service.js';
import {
  assertSellerOwnership,
  assertSellerPermission,
  type SellerMembership,
} from './account.service.js';
import { consumeReservation, releaseReservation, reserveStock } from './inventory.service.js';
import { syncOrderWithSellerGroups } from './order-split.service.js';

export interface SellerOrderRow {
  id: string;
  sellerOrderNumber: string;
  status: SellerOrderGroupStatusName;
  /** The buyer's own order number, so support conversations line up. */
  orderNumber: string;
  placedAt: string | null;
  dispatchDueAt: string | null;
  /** True when the dispatch deadline has passed and it has not shipped. */
  isOverdue: boolean;
  currency: string;
  goodsTotalMinor: string;
  sellerNetMinor: string;
  lineCount: number;
  itemCount: number;
  locationName: string | null;
}

export interface SellerOrderQuery {
  status?: SellerOrderGroupStatusName | null;
  search?: string | null;
  locationId?: string | null;
  /** Only those whose dispatch deadline has passed. */
  overdueOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export async function listSellerOrders(
  membership: SellerMembership,
  query: SellerOrderQuery,
): Promise<{ rows: SellerOrderRow[]; total: number; counts: Record<string, number> }> {
  assertSellerPermission(membership, SellerPermission.ORDER_READ);

  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 25));
  const search = query.search?.trim() ?? '';
  const now = new Date();

  const where: Prisma.SellerOrderGroupWhereInput = {
    sellerAccountId: membership.sellerAccountId,
    ...(query.status === null || query.status === undefined ? {} : { status: query.status }),
    ...(query.locationId === null || query.locationId === undefined ? {} : { locationId: query.locationId }),
    ...(query.overdueOnly === true
      ? {
          dispatchDueAt: { lt: now },
          status: { in: ['NEW', 'ACCEPTED', 'PROCESSING', 'READY_FOR_DISPATCH'] },
        }
      : {}),
    ...(search.length === 0
      ? {}
      : {
          OR: [
            { sellerOrderNumber: { contains: search } },
            { order: { orderNumber: { contains: search } } },
          ],
        }),
  };

  const [rows, total, grouped] = await Promise.all([
    prisma.sellerOrderGroup.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        order: { select: { orderNumber: true, placedAt: true } },
        lines: { select: { quantity: true } },
      },
    }),
    prisma.sellerOrderGroup.count({ where }),
    prisma.sellerOrderGroup.groupBy({
      by: ['status'],
      where: { sellerAccountId: membership.sellerAccountId },
      _count: { _all: true },
    }),
  ]);

  const locationIds = rows
    .map((row) => row.locationId)
    .filter((id): id is string => id !== null);

  const locations =
    locationIds.length === 0
      ? []
      : await prisma.sellerLocation.findMany({
          where: { id: { in: locationIds } },
          select: { id: true, name: true },
        });

  const locationName = new Map(locations.map((entry) => [entry.id, entry.name]));

  return {
    rows: rows.map((row) => ({
      id: row.id,
      sellerOrderNumber: row.sellerOrderNumber,
      status: row.status,
      orderNumber: row.order.orderNumber,
      placedAt: row.order.placedAt?.toISOString() ?? null,
      dispatchDueAt: row.dispatchDueAt?.toISOString() ?? null,
      isOverdue:
        row.dispatchDueAt !== null &&
        row.dispatchDueAt < now &&
        SELLER_ORDER_STOCK_HELD.includes(row.status),
      currency: row.currency,
      goodsTotalMinor: row.goodsTotalMinor.toString(),
      sellerNetMinor: row.sellerNetMinor.toString(),
      lineCount: row.lines.length,
      itemCount: row.lines.reduce((sum, line) => sum + line.quantity, 0),
      locationName: row.locationId === null ? null : (locationName.get(row.locationId) ?? null),
    })),
    total,
    counts: Object.fromEntries(grouped.map((entry) => [entry.status, entry._count._all])),
  };
}

/**
 * One order group in full.
 *
 * Note what is NOT selected off `Order`: the buyer's email, their phone, their
 * payment reference, the other sellers' lines. A seller needs a delivery
 * address and the items they are shipping, and a marketplace that hands over
 * the buyer's contact details has handed over its own customer relationship.
 */
export async function readSellerOrder(membership: SellerMembership, groupId: string) {
  assertSellerPermission(membership, SellerPermission.ORDER_READ);

  const group = await prisma.sellerOrderGroup.findUnique({
    where: { id: groupId },
    include: {
      order: {
        select: {
          orderNumber: true,
          placedAt: true,
          status: true,
          shippingAddressJson: true,
        },
      },
      lines: {
        include: {
          offer: {
            select: {
              id: true,
              sellerSku: true,
              product: { select: { name: true, slug: true } },
            },
          },
        },
      },
      shipments: { orderBy: { createdAt: 'desc' } },
      returns: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (group === null) throw notFound('Order');
  assertSellerOwnership(membership, group.sellerAccountId, 'Order');

  return {
    id: group.id,
    sellerOrderNumber: group.sellerOrderNumber,
    orderNumber: group.order.orderNumber,
    status: group.status,
    buyerOrderStatus: group.order.status,
    placedAt: group.order.placedAt?.toISOString() ?? null,
    dispatchDueAt: group.dispatchDueAt?.toISOString() ?? null,
    locationId: group.locationId,
    currency: group.currency,
    goodsTotalMinor: group.goodsTotalMinor.toString(),
    taxTotalMinor: group.taxTotalMinor.toString(),
    shippingTotalMinor: group.shippingTotalMinor.toString(),
    commissionMinor: group.commissionMinor.toString(),
    sellerNetMinor: group.sellerNetMinor.toString(),
    commissionBasisPointsApplied: group.commissionBasisPointsApplied,
    cancellationReason: group.cancellationReason,
    deliveryAddress: group.order.shippingAddressJson,
    lines: group.lines.map((line) => ({
      id: line.id,
      // The buyer order line this covers. Returned because a shipment says what
      // went in the box in those terms, and a screen that only knows its own
      // ids cannot name anything the rest of the order recognises.
      orderItemId: line.orderItemId,
      offerId: line.offerId,
      sellerSku: line.offer.sellerSku,
      productName: line.offer.product.name,
      productSlug: line.offer.product.slug,
      quantity: line.quantity,
      fulfilledQuantity: line.fulfilledQuantity,
      returnedQuantity: line.returnedQuantity,
      unitPriceMinor: line.unitPriceMinor.toString(),
      lineTotalMinor: line.lineTotalMinor.toString(),
      sellerNetMinor: line.sellerNetMinor.toString(),
    })),
    shipments: group.shipments.map((shipment) => ({
      id: shipment.id,
      status: shipment.status,
      carrierName: shipment.carrierName,
      trackingNumber: shipment.trackingNumber,
      trackingUrl: shipment.trackingUrl,
      dispatchedAt: shipment.dispatchedAt?.toISOString() ?? null,
      deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
    })),
    returns: group.returns.map((entry) => ({
      id: entry.id,
      status: entry.status,
      reasonCode: entry.reasonCode,
      reasonText: entry.reasonText,
      sellerResponse: entry.sellerResponse,
      createdAt: entry.createdAt.toISOString(),
    })),
    /** What this member may do next. The panel renders exactly these buttons. */
    allowedTransitions: allowedSellerOrderTransitions(
      group.status,
      'SELLER',
    ),
  };
}

export interface OrderTransitionInput {
  membership: SellerMembership;
  groupId: string;
  to: SellerOrderGroupStatusName;
  reason?: string | null;
  /** Required when accepting: which of the seller's places it ships from. */
  locationId?: string | null;
  correlationId?: string | null;
}

/**
 * Move a seller order group.
 *
 * Cancelling releases the stock the group was holding, inside the same
 * transaction. Doing it afterwards means a crash between the two leaves units
 * reserved against an order that no longer exists - and reserved stock nobody
 * can find is indistinguishable from stock that was stolen.
 */
export async function transitionSellerOrder(input: OrderTransitionInput): Promise<void> {
  const { membership } = input;

  assertSellerPermission(
    membership,
    input.to === 'CANCELLED' ? SellerPermission.ORDER_CANCEL : SellerPermission.ORDER_FULFIL,
  );

  const orderId = await prisma.$transaction(async (tx) => {
    const group = await tx.sellerOrderGroup.findUnique({
      where: { id: input.groupId },
      include: { lines: { select: { offerId: true, quantity: true, fulfilledQuantity: true } } },
    });

    if (group === null) throw notFound('Order');
    assertSellerOwnership(membership, group.sellerAccountId, 'Order');

    const from = group.status;

    assertSellerOrderTransition({
      from,
      to: input.to,
      actor: 'SELLER',
      reason: input.reason ?? null,
    });

    // Accepting is where a location is chosen, and it is required: a group with
    // no location has no dispatch deadline, so its SLA can never be breached
    // and it silently never appears in the overdue list.
    let locationId = group.locationId;
    let dispatchDueAt: Date | null = group.dispatchDueAt;

    if (input.to === 'ACCEPTED') {
      locationId = input.locationId ?? group.locationId;

      if (locationId === null) {
        throw badRequest(
          ErrorCode.SELLER_LOCATION_REQUIRED,
          'Choose which of your locations this ships from.',
          [{ field: 'locationId', code: 'REQUIRED' }],
        );
      }

      const location = await tx.sellerLocation.findUnique({
        where: { id: locationId },
        select: {
          sellerAccountId: true,
          isOperational: true,
          handlingTimeDays: true,
          timezone: true,
          workingDaysMask: true,
          dispatchCutoff: true,
        },
      });

      if (location === null) throw notFound('Location');
      assertSellerOwnership(membership, location.sellerAccountId, 'Location');

      if (!location.isOperational) {
        throw conflict(
          ErrorCode.SELLER_LOCATION_REQUIRED,
          'That location is closed. Choose another, or reopen it first.',
        );
      }

      /*
       * Accepting is also where the units stop being available to anybody
       * else.
       *
       * The operator's checkout cannot do this for a marketplace line: at
       * that moment nobody has said which of the seller's buildings the
       * parcel leaves from, and a reservation has to name a place or it
       * cannot be released or dispatched again. Accepting is the first
       * moment both facts exist - the order and the location - so it is
       * where the hold is taken, and it is refused outright if the shelf
       * cannot cover it rather than accepting an order that cannot ship.
       */
      for (const line of group.lines) {
        const outstanding = line.quantity - line.fulfilledQuantity;
        if (outstanding <= 0) continue;

        await reserveStock(tx, {
          offerId: line.offerId,
          locationId,
          quantity: outstanding,
          orderId: group.orderId,
        });
      }

      /*
       * And where the clock starts.
       *
       * Counted from the building that was just named: its cut-off, its
       * working week, its handling time. Before this moment there was no
       * location to count against, which is why the split leaves the deadline
       * null rather than inventing one - a seller marked late against a
       * deadline computed from nothing has no way to argue with it.
       */
      dispatchDueAt = dispatchDeadline(
        {
          timezone: location.timezone,
          workingDaysMask: location.workingDaysMask,
          dispatchCutoff: location.dispatchCutoff,
          handlingTimeDays: location.handlingTimeDays,
        },
        new Date(),
      );
    }

    if (input.to === 'CANCELLED' && locationId !== null) {
      for (const line of group.lines) {
        const outstanding = line.quantity - line.fulfilledQuantity;
        if (outstanding <= 0) continue;

        await releaseReservation(tx, {
          offerId: line.offerId,
          locationId,
          quantity: outstanding,
          orderId: group.orderId,
        });
      }
    }

    const now = new Date();

    await tx.sellerOrderGroup.update({
      where: { id: input.groupId },
      data: {
        status: input.to,
        locationId,
        ...(input.to === 'ACCEPTED' ? { acceptedAt: now, dispatchDueAt } : {}),
        ...(input.to === 'SHIPPED' ? { dispatchedAt: now } : {}),
        ...(input.to === 'DELIVERED' ? { deliveredAt: now } : {}),
        ...(input.to === 'CANCELLED'
          ? { cancelledAt: now, cancellationReason: input.reason ?? null }
          : {}),
      },
    });

    await recordSellerAudit({
      sellerAccountId: membership.sellerAccountId,
      action: `seller.order.${input.to.toLowerCase()}`,
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_order_group',
      resourceId: input.groupId,
      before: { status: from },
      after: { status: input.to },
      summary: `Order ${group.sellerOrderNumber} moved to ${input.to.toLowerCase().replace(/_/g, ' ')}.`,
      correlationId: input.correlationId ?? null,
      tx,
    });

    return group.orderId;
  });

  // The buyer's order follows the sellers on an order nobody's staff touches.
  // Outside the transaction on purpose - see `syncOrderWithSellerGroups`.
  await syncOrderWithSellerGroups(orderId);

  /*
   * And the carriers hear about it.
   *
   * Accepting is the first moment a seller with several buildings has said
   * which one the parcel leaves from, and a consignment cannot name a pickup
   * door before that. The confirmation already raised one for every seller
   * whose place was not in doubt, and raising is idempotent per part, so this
   * adds the ones that were waiting and repeats nothing.
   *
   * Never allowed to fail the acceptance: the seller has taken the work on,
   * and a logistics table that is unhappy must not undo that.
   */
  if (input.to === 'ACCEPTED' && env.FEATURE_LOGISTICS_PORTAL) {
    try {
      const { createShipmentsForOrder } = await import(
        '../logistics/shipment-create.service.js'
      );

      await createShipmentsForOrder(orderId, null);
    } catch (error: unknown) {
      logger.warn(
        { err: error, orderId, groupId: input.groupId },
        'could not raise the consignment for an accepted seller order; it can be raised from the admin panel',
      );
    }
  }
}

export interface ShipmentInput {
  membership: SellerMembership;
  groupId: string;
  carrierName: string;
  trackingNumber: string;
  trackingUrl?: string | null;
  /** What went in this box. Omitted means everything still outstanding. */
  contents?: { orderItemId: string; quantity: number }[] | null;
  correlationId?: string | null;
}

/**
 * Record a dispatch.
 *
 * Partial fulfilment is supported because it is what actually happens: a seller
 * with eight of ten in one warehouse ships eight now. Each line's
 * `fulfilledQuantity` climbs, the group moves to SHIPPED only when every line
 * is complete, and shipping more than remains is refused - a line that claimed
 * to have dispatched twelve of ten would make the settlement wrong as well as
 * the stock.
 */
export async function recordShipment(input: ShipmentInput): Promise<{ shipmentId: string }> {
  const { membership } = input;
  assertSellerPermission(membership, SellerPermission.ORDER_FULFIL);

  const shipmentId = newId();

  const orderId = await prisma.$transaction(async (tx) => {
    const group = await tx.sellerOrderGroup.findUnique({
      where: { id: input.groupId },
      include: { lines: true },
    });

    if (group === null) throw notFound('Order');
    assertSellerOwnership(membership, group.sellerAccountId, 'Order');

    const contents =
      input.contents ??
      group.lines
        .map((line) => ({
          orderItemId: line.orderItemId,
          quantity: line.quantity - line.fulfilledQuantity,
        }))
        .filter((entry) => entry.quantity > 0);

    if (contents.length === 0) {
      throw conflict(
        ErrorCode.SELLER_FULFILMENT_QUANTITY_INVALID,
        'Everything on this order has already been dispatched.',
      );
    }

    const byItem = new Map(group.lines.map((line) => [line.orderItemId, line]));

    for (const entry of contents) {
      const line = byItem.get(entry.orderItemId);
      if (line === undefined) throw notFound('Order line');

      const remaining = line.quantity - line.fulfilledQuantity;

      if (entry.quantity <= 0 || entry.quantity > remaining) {
        throw badRequest(
          ErrorCode.SELLER_FULFILMENT_QUANTITY_INVALID,
          `Only ${String(remaining)} of that item are still to go.`,
          [{ field: 'contents', code: 'OUT_OF_RANGE', meta: { remaining } }],
        );
      }

      await tx.sellerOrderLine.update({
        where: { id: line.id },
        data: { fulfilledQuantity: { increment: entry.quantity } },
      });

      // Reserved stock becomes dispatched stock. Both halves in this
      // transaction, so a crash cannot leave units reserved for a parcel that
      // has left the building.
      if (group.locationId !== null) {
        await consumeReservation(tx, {
          offerId: line.offerId,
          locationId: group.locationId,
          quantity: entry.quantity,
          sellerAccountId: group.sellerAccountId,
          shipmentId,
          lineId: line.id,
        });
      }
    }

    await tx.sellerShipment.create({
      data: {
        id: shipmentId,
        sellerAccountId: group.sellerAccountId,
        orderGroupId: group.id,
        locationId: group.locationId,
        status: 'DISPATCHED',
        carrierName: input.carrierName.trim(),
        trackingNumber: input.trackingNumber.trim(),
        trackingUrl: input.trackingUrl ?? null,
        contentsJson: contents as never,
        dispatchedAt: new Date(),
      },
    });

    const refreshed = await tx.sellerOrderLine.findMany({
      where: { orderGroupId: group.id },
      select: { quantity: true, fulfilledQuantity: true },
    });

    const everythingGone = refreshed.every((line) => line.fulfilledQuantity >= line.quantity);

    if (everythingGone && group.status !== 'SHIPPED') {
      assertSellerOrderTransition({
        from: group.status,
        to: 'SHIPPED',
        actor: 'SELLER',
      });

      await tx.sellerOrderGroup.update({
        where: { id: group.id },
        data: { status: 'SHIPPED', dispatchedAt: new Date() },
      });
    }

    await recordSellerAudit({
      sellerAccountId: group.sellerAccountId,
      action: 'seller.order.shipment_recorded',
      actor: { type: 'CUSTOMER', label: membership.displayName },
      resourceType: 'seller_shipment',
      resourceId: shipmentId,
      summary: `Dispatched with ${input.carrierName.trim()}, tracking ${input.trackingNumber.trim()}.`,
      correlationId: input.correlationId ?? null,
      tx,
    });

    return group.orderId;
  });

  // A dispatch is the event most likely to move the buyer's order, so it asks
  // the same question the status transitions do.
  await syncOrderWithSellerGroups(orderId);

  return { shipmentId };
}
