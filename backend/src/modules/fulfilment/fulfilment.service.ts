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
import { restockFromOrder } from '../inventory/inventory.service.js';
import { transitionOrder } from '../orders/order.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';

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

// --- Returns ---------------------------------------------------------------

export interface ReturnLineInput {
  orderItemId: string;
  quantity: number;
}

export interface CreateReturnInput {
  orderId: string;
  reason: string;
  items: ReturnLineInput[];
  requestedById: string;
}

export async function createReturnRequest(
  input: CreateReturnInput,
  actor: FulfilmentActor,
): Promise<{ returnId: string }> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { items: true },
  });

  if (order === null) throw notFound('Order');

  // Nothing can be returned that was never delivered.
  if (order.status !== 'DELIVERED' && order.status !== 'SHIPPED') {
    throw conflict(
      ErrorCode.ORDER_NOT_CANCELLABLE,
      `An order that is ${order.status.toLowerCase()} cannot be returned.`,
    );
  }

  if (input.reason.trim().length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A reason is required for a return.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }

  const itemById = new Map(order.items.map((item) => [item.id, item]));
  const problems: { field: string; code: string; message: string }[] = [];

  input.items.forEach((line, index) => {
    const item = itemById.get(line.orderItemId);

    if (item === undefined) {
      problems.push({
        field: `items.${String(index)}.orderItemId`,
        code: 'NOT_ON_ORDER',
        message: 'That line is not part of this order.',
      });
      return;
    }

    if (line.quantity < 1 || line.quantity > item.quantity) {
      problems.push({
        field: `items.${String(index)}.quantity`,
        code: 'INVALID_QUANTITY',
        message: `${item.nameSnapshot}: between 1 and ${String(item.quantity)} may be returned.`,
      });
    }
  });

  if (problems.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This return cannot be recorded.', problems);
  }

  const returnId = newId();

  await prisma.$transaction(async (tx) => {
    await tx.returnRequest.create({
      data: {
        id: returnId,
        orderId: input.orderId,
        status: 'REQUESTED',
        reason: input.reason.trim(),
        itemsJson: input.items as never,
        requestedById: input.requestedById,
      },
    });

    await recordAudit(
      {
        action: AuditAction.ORDER_STATUS_CHANGED,
        resourceType: 'return_request',
        resourceId: returnId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: { orderId: input.orderId, reason: input.reason, lineCount: input.items.length },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  return { returnId };
}

export interface InspectReturnInput {
  returnId: string;
  /** Per line: how much is sellable and how much is damaged. */
  outcome: { orderItemId: string; sellableQty: number; damagedQty: number }[];
  decisionNote?: string | null;
}

/**
 * Record the inspection outcome and restock.
 *
 * This is where "returned" becomes "sellable again", and only for the quantity
 * that actually is. Damaged units are written off to quarantine with their own
 * ledger movement so the difference is explained rather than lost.
 */
export async function inspectReturn(
  input: InspectReturnInput,
  actor: FulfilmentActor,
): Promise<{ restocked: number; quarantined: number; orderStatus: string }> {
  const request = await prisma.returnRequest.findUnique({
    where: { id: input.returnId },
    include: { order: { include: { items: true } } },
  });

  if (request === null) throw notFound('Return request');

  if (request.status === 'COMPLETED' || request.status === 'REJECTED') {
    throw conflict(
      ErrorCode.CONFLICT,
      `This return has already been ${request.status.toLowerCase()}.`,
    );
  }

  const itemById = new Map(request.order.items.map((item) => [item.id, item]));
  const requested = Array.isArray(request.itemsJson) ? (request.itemsJson as unknown[]) : [];

  const requestedByItem = new Map<string, number>();
  for (const raw of requested) {
    if (typeof raw !== 'object' || raw === null) continue;
    const line = raw as { orderItemId?: unknown; quantity?: unknown };
    if (typeof line.orderItemId === 'string' && typeof line.quantity === 'number') {
      requestedByItem.set(line.orderItemId, line.quantity);
    }
  }

  const problems: { field: string; code: string; message: string }[] = [];

  input.outcome.forEach((line, index) => {
    const item = itemById.get(line.orderItemId);
    const expected = requestedByItem.get(line.orderItemId) ?? 0;

    if (item === undefined) {
      problems.push({
        field: `outcome.${String(index)}.orderItemId`,
        code: 'NOT_ON_ORDER',
        message: 'That line is not part of this return.',
      });
      return;
    }

    if (line.sellableQty < 0 || line.damagedQty < 0) {
      problems.push({
        field: `outcome.${String(index)}`,
        code: 'NEGATIVE',
        message: 'Quantities cannot be negative.',
      });
      return;
    }

    // The inspection must account for exactly what was sent back - no more,
    // and the split must add up.
    if (line.sellableQty + line.damagedQty > expected) {
      problems.push({
        field: `outcome.${String(index)}`,
        code: 'EXCEEDS_RETURNED',
        message: `${item.nameSnapshot}: ${String(expected)} unit(s) were returned, but ${String(
          line.sellableQty + line.damagedQty,
        )} are accounted for.`,
      });
    }
  });

  if (problems.length > 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'This inspection cannot be recorded.', problems);
  }

  const restockLines = input.outcome
    .map((line) => {
      const item = itemById.get(line.orderItemId);
      if (item === undefined) return null;

      return {
        productId: item.productId,
        variantId: item.variantId,
        sellableQty: line.sellableQty,
        damagedQty: line.damagedQty,
      };
    })
    .filter((line): line is NonNullable<typeof line> => line !== null);

  await prisma.$transaction(async (tx) => {
    await restockFromOrder(request.orderId, restockLines, 'RETURN_RESTOCK', tx);

    await tx.returnRequest.update({
      where: { id: input.returnId },
      data: {
        status: 'COMPLETED',
        decidedById: actor.userId,
        decidedAt: new Date(),
        decisionNote: input.decisionNote ?? null,
        completedAt: new Date(),
        itemsJson: {
          requested: request.itemsJson,
          inspected: input.outcome,
        } as never,
      },
    });

    await recordAudit(
      {
        action: AuditAction.ORDER_STATUS_CHANGED,
        resourceType: 'return_request',
        resourceId: input.returnId,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          status: 'COMPLETED',
          restocked: restockLines.reduce((total, line) => total + line.sellableQty, 0),
          quarantined: restockLines.reduce((total, line) => total + line.damagedQty, 0),
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });

  // The order moves to RETURNED so a refund becomes possible. The refund
  // itself is a separate, separately permissioned action.
  let orderStatus: OrderStatusName = request.order.status;

  if (request.order.status === 'DELIVERED' || request.order.status === 'SHIPPED') {
    const result = await transitionOrder({
      orderId: request.orderId,
      to: 'RETURNED',
      actor: {
        userId: actor.userId,
        email: actor.email,
        type: 'ADMIN',
        permissions: actor.permissions ?? [],
      },
      reason: request.reason,
    });
    orderStatus = result.status;
  }

  await enqueueNotification({
    eventKey: NotificationEvent.ORDER_CANCELLED,
    recipientEmail: (
      await prisma.customerProfile.findUniqueOrThrow({
        where: { id: request.order.customerProfileId },
        include: { user: { select: { email: true } } },
      })
    ).user.email,
    variables: { orderNumber: request.order.orderNumber, orderStatus },
    dedupeKey: `return_completed:${input.returnId}`,
    relatedType: 'order',
    relatedId: request.orderId,
  });

  await dispatchPendingNotifications();

  return {
    restocked: restockLines.reduce((total, line) => total + line.sellableQty, 0),
    quarantined: restockLines.reduce((total, line) => total + line.damagedQty, 0),
    orderStatus,
  };
}

export async function rejectReturn(
  returnId: string,
  note: string,
  actor: FulfilmentActor,
): Promise<void> {
  const updated = await prisma.returnRequest.updateMany({
    where: { id: returnId, status: { in: ['REQUESTED', 'APPROVED', 'RECEIVED', 'INSPECTED'] } },
    data: {
      status: 'REJECTED',
      decidedById: actor.userId,
      decidedAt: new Date(),
      decisionNote: note,
      completedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    throw conflict(ErrorCode.CONFLICT, 'This return has already been decided.');
  }

  await recordAudit({
    action: AuditAction.ORDER_STATUS_CHANGED,
    resourceType: 'return_request',
    resourceId: returnId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { status: 'REJECTED', note },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}
