/**
 * Shipments and returns.
 *
 * Two rules from SOP §12 shape this file:
 *
 *   1. You cannot ship more of a line than the order contains. Over-shipping
 *      is checked against what has ALREADY shipped, not just the order total,
 *      so two partial shipments cannot together exceed it.
 *   2. Returned stock only comes back if it is sellable. Damaged quantity is
 *      recorded as a quarantine movement and never rejoins available stock.
 *      "It came back" and "we can sell it again" are different facts.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import type { OrderStatusName } from '../../domain/order-state-machine.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { transitionOrder } from '../orders/order.service.js';
import { dispatchPendingNotifications } from '../notifications/notification.service.js';

export interface FulfilmentActor {
  userId: string;
  email: string;
  permissions?: readonly string[];
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface ShipmentLineInput {
  orderItemId: string;
  quantity: number;
}

export interface CreateShipmentInput {
  orderId: string;
  carrier: string;
  trackingNumber?: string | null;
  trackingUrl?: string | null;
  items: ShipmentLineInput[];
  notes?: string | null;
  /** Move the order to SHIPPED. False leaves it PROCESSING for a partial send. */
  markShipped?: boolean;
}

/**
 * What remains to ship on each line.
 *
 * Derived from the order items minus everything already dispatched, so partial
 * shipments compose correctly.
 */
export async function shippableLines(
  orderId: string,
): Promise<{ orderItemId: string; name: string; sku: string; ordered: number; shipped: number; remaining: number }[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true, shipments: true },
  });

  if (order === null) throw notFound('Order');

  const shippedByItem = new Map<string, number>();

  for (const shipment of order.shipments) {
    // A cancelled shipment never left, so it does not consume the line.
    if (shipment.status === 'RETURNED_TO_ORIGIN' || shipment.status === 'FAILED') continue;

    const lines = Array.isArray(shipment.itemsJson) ? shipment.itemsJson : [];

    for (const raw of lines as unknown[]) {
      if (typeof raw !== 'object' || raw === null) continue;
      const line = raw as { orderItemId?: unknown; quantity?: unknown };

      if (typeof line.orderItemId !== 'string' || typeof line.quantity !== 'number') continue;
      shippedByItem.set(line.orderItemId, (shippedByItem.get(line.orderItemId) ?? 0) + line.quantity);
    }
  }

  return order.items.map((item) => {
    const shipped = shippedByItem.get(item.id) ?? 0;
    return {
      orderItemId: item.id,
      name: item.nameSnapshot,
      sku: item.skuSnapshot,
      ordered: item.quantity,
      shipped,
      remaining: Math.max(0, item.quantity - shipped),
    };
  });
}

export async function createShipment(
  input: CreateShipmentInput,
  actor: FulfilmentActor,
): Promise<{ shipmentId: string; orderStatus: string }> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { customerProfile: { include: { user: { select: { email: true } } } } },
  });

  if (order === null) throw notFound('Order');

  // Shipping an unpaid or cancelled order is a fulfilment mistake worth
  // catching before goods leave the building.
  if (order.status !== 'CONFIRMED' && order.status !== 'PROCESSING') {
    throw conflict(
      ErrorCode.ORDER_TRANSITION_NOT_ALLOWED,
      `An order that is ${order.status.toLowerCase()} cannot be shipped.`,
    );
  }

  if (input.items.length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'Select at least one item to ship.', [
      { field: 'items', code: 'REQUIRED' },
    ]);
  }

  const shippable = await shippableLines(input.orderId);
  const remainingByItem = new Map(shippable.map((line) => [line.orderItemId, line]));

  const problems: { field: string; code: string; message: string }[] = [];

  input.items.forEach((line, index) => {
    const available = remainingByItem.get(line.orderItemId);

    if (available === undefined) {
      problems.push({
        field: `items.${String(index)}.orderItemId`,
        code: 'NOT_ON_ORDER',
        message: 'That line is not part of this order.',
      });
      return;
    }

    if (line.quantity < 1) {
      problems.push({
        field: `items.${String(index)}.quantity`,
        code: 'INVALID',
        message: 'Ship at least one unit, or leave the line out.',
      });
      return;
    }

    // The over-shipping guard, measured against what already left.
    if (line.quantity > available.remaining) {
      problems.push({
        field: `items.${String(index)}.quantity`,
        code: 'EXCEEDS_REMAINING',
        message: `${available.name}: only ${String(available.remaining)} left to ship of ${String(available.ordered)}.`,
      });
    }
  });

  if (problems.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This shipment cannot be created.', problems);
  }

  const shipmentId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.shipment.create({
      data: {
        id: shipmentId,
        orderId: input.orderId,
        carrier: input.carrier.trim(),
        trackingNumber: input.trackingNumber ?? null,
        trackingUrl: input.trackingUrl ?? null,
        status: 'DISPATCHED',
        itemsJson: input.items as never,
        dispatchedAt: new Date(),
        notes: input.notes ?? null,
        createdById: actor.userId,
      },
    });

    await recordAudit(
      {
        action: AuditAction.ORDER_STATUS_CHANGED,
        resourceType: 'shipment',
        resourceId: shipmentId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          orderId: input.orderId,
          orderNumber: order.orderNumber,
          carrier: input.carrier,
          trackingNumber: input.trackingNumber,
          lineCount: input.items.length,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // Typed explicitly: the guard above narrowed `order.status` to
  // CONFIRMED | PROCESSING, but a transition can return any status.
  let orderStatus: OrderStatusName = order.status;

  // The order only advances when everything has gone. A partial shipment
  // leaves it PROCESSING so the rest is still visibly outstanding.
  const afterThis = await shippableLines(input.orderId);
  const fullyShipped = afterThis.every((line) => line.remaining === 0);

  if (order.status === 'CONFIRMED') {
    await transitionOrder({
      orderId: input.orderId,
      to: 'PROCESSING',
      actor: {
        userId: actor.userId,
        email: actor.email,
        type: 'ADMIN',
        permissions: actor.permissions ?? [],
        ...(actor.correlationId !== null && actor.correlationId !== undefined
          ? { correlationId: actor.correlationId }
          : {}),
      },
      reason: 'Fulfilment started',
    });
    orderStatus = 'PROCESSING';
  }

  if (fullyShipped && (input.markShipped ?? true)) {
    const result = await transitionOrder({
      orderId: input.orderId,
      to: 'SHIPPED',
      actor: {
        userId: actor.userId,
        email: actor.email,
        type: 'ADMIN',
        permissions: actor.permissions ?? [],
        ...(actor.correlationId !== null && actor.correlationId !== undefined
          ? { correlationId: actor.correlationId }
          : {}),
      },
      reason: `Dispatched via ${input.carrier}`,
      meta: { shipmentId, trackingNumber: input.trackingNumber },
    });
    orderStatus = result.status;
  }

  await dispatchPendingNotifications();
  return { shipmentId, orderStatus };
}

export async function updateShipmentStatus(
  shipmentId: string,
  status: 'IN_TRANSIT' | 'DELIVERED' | 'FAILED' | 'RETURNED_TO_ORIGIN',
  actor: FulfilmentActor,
): Promise<{ orderStatus: string | null }> {
  const shipment = await prisma.shipment.findUnique({
    where: { id: shipmentId },
    include: { order: true },
  });

  if (shipment === null) throw notFound('Shipment');

  await prisma.shipment.update({
    where: { id: shipmentId },
    data: {
      status,
      ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
    },
  });

  // Delivery of the last outstanding shipment closes the order.
  if (status === 'DELIVERED' && shipment.order.status === 'SHIPPED') {
    const outstanding = await prisma.shipment.count({
      where: {
        orderId: shipment.orderId,
        status: { in: ['CREATED', 'DISPATCHED', 'IN_TRANSIT'] },
        id: { not: shipmentId },
      },
    });

    if (outstanding === 0) {
      const result = await transitionOrder({
        orderId: shipment.orderId,
        to: 'DELIVERED',
        actor: {
          userId: actor.userId,
          email: actor.email,
          type: 'ADMIN',
          permissions: actor.permissions ?? [],
        },
        reason: 'Carrier confirmed delivery',
      });

      await dispatchPendingNotifications();
      return { orderStatus: result.status };
    }
  }

  return { orderStatus: null };
}

// Returns live in modules/returns/return.service.ts: the buyer asks, the
// seller answers, staff decide, and the refund goes through createRefund.
