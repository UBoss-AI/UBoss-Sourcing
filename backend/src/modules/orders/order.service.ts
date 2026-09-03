/**
 * Orders.
 *
 * Checkout is the moment the system stops being a catalog and starts being a
 * financial record. Three things happen atomically, or none do:
 *
 *   1. Prices are frozen into `order_items` - name, SKU, unit price, tax rate.
 *      Later catalog edits must never rewrite what a customer bought.
 *   2. Stock is reserved. A confirmed order that cannot be shipped is worse
 *      than a rejected checkout.
 *   3. The cart is converted.
 *
 * Every status change goes through `assertTransition` and appends to
 * `order_status_history`. No service writes `orders.status` directly.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import {
  assertTotalsConsistent,
  type PricedLine,
} from '../../domain/pricing.js';
import {
  allowedTransitions,
  assertTransition,
  holdsCommittedStock,
  type OrderStatusName,
  type TransitionActor,
} from '../../domain/order-state-machine.js';
import { newId } from '../../infra/ids.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  assertCheckoutReady,
  markCartConverted,
  resolveCart,
  type ResolvedCart,
} from '../cart/cart.service.js';
import { recordRedemption } from '../coupons/coupon.service.js';
import {
  commitReservations,
  releaseReservations,
  reserveStock,
  restockFromOrder,
} from '../inventory/inventory.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';

export interface OrderActor {
  userId: string | null;
  email: string | null;
  type: TransitionActor;
  permissions?: readonly string[];
  ipAddress?: string | null;
  correlationId?: string | null;
}

/**
 * Allocate the next order number.
 *
 * `UB-2026-000123`. A dedicated counter row incremented with
 * `value = value + 1` takes an InnoDB row lock, so two concurrent checkouts
 * cannot receive the same number. Gaps are acceptable (a rolled-back checkout
 * consumes one); duplicates are not.
 */
async function nextOrderNumber(tx: PrismaTransaction): Promise<string> {
  const business = await tx.businessProfile.findFirst({ select: { orderPrefix: true } });
  const prefix = business?.orderPrefix ?? 'UB';
  const year = new Date().getUTCFullYear();
  const key = `order:${String(year)}`;

  await tx.numberSequence.upsert({
    where: { key },
    update: { value: { increment: 1 } },
    create: { key, value: 1, prefix, padding: 6 },
  });

  const sequence = await tx.numberSequence.findUniqueOrThrow({ where: { key } });
  const padded = sequence.value.toString().padStart(sequence.padding, '0');

  return `${prefix}-${String(year)}-${padded}`;
}

export interface AddressSnapshot {
  contactName: string;
  contactPhone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  postalCode: string;
  country: string;
}

async function loadAddressSnapshot(
  customerProfileId: string,
  addressId: string,
  label: string,
): Promise<AddressSnapshot> {
  const address = await prisma.address.findFirst({
    where: { id: addressId, customerProfileId, archivedAt: null },
  });

  if (address === null) {
    throw badRequest(ErrorCode.ADDRESS_REQUIRED, `Select a valid ${label} address.`, [
      { field: `${label}AddressId`, code: 'NOT_FOUND' },
    ]);
  }

  return {
    contactName: address.contactName,
    contactPhone: address.contactPhone,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    state: address.state,
    postalCode: address.postalCode,
    country: address.country,
  };
}

export interface CheckoutInput {
  customerProfileId: string;
  shippingAddressId: string;
  billingAddressId?: string;
  shippingMethodCode?: string | null;
  paymentMode: 'ONLINE' | 'PAYMENT_LINK';
  customerNote?: string | null;
  actor: OrderActor;
}

export interface CheckoutResult {
  orderId: string;
  orderNumber: string;
  status: OrderStatusName;
  currency: string;
  totals: {
    subtotal: ReturnType<typeof serialiseMoney>;
    discount: ReturnType<typeof serialiseMoney>;
    tax: ReturnType<typeof serialiseMoney>;
    shipping: ReturnType<typeof serialiseMoney>;
    grandTotal: ReturnType<typeof serialiseMoney>;
  };
  requiresApproval: boolean;
  paymentMode: 'ONLINE' | 'PAYMENT_LINK';
}

/**
 * Submit a checkout.
 *
 * Wrap the call in `runIdempotent` - this function assumes it runs at most once
 * per attempt and does not deduplicate on its own.
 */
export async function submitCheckout(input: CheckoutInput): Promise<CheckoutResult> {
  // Reprice from the current catalog. The client's totals are never trusted;
  // this is the same function that produced what they were shown.
  const resolved: ResolvedCart = await resolveCart(input.customerProfileId, {
    shippingMethodCode: input.shippingMethodCode ?? null,
  });

  assertCheckoutReady(resolved);

  // Belt and braces against an arithmetic regression: totals must equal the sum
  // of their lines before anything is written or charged.
  assertTotalsConsistent(resolved.pricing.lines, resolved.pricing.totals);

  const billingAddressId = input.billingAddressId ?? input.shippingAddressId;

  const [shippingSnapshot, billingSnapshot] = await Promise.all([
    loadAddressSnapshot(input.customerProfileId, input.shippingAddressId, 'shipping'),
    loadAddressSnapshot(input.customerProfileId, billingAddressId, 'billing'),
  ]);

  const shippingMethod =
    input.shippingMethodCode === null || input.shippingMethodCode === undefined
      ? null
      : await prisma.shippingMethod.findFirst({
          where: { code: input.shippingMethodCode, isActive: true },
          select: { code: true, name: true },
        });

  const orderId = newId();
  const requiresApproval = resolved.limits.requiresApproval;

  const stockedItems = resolved.sourceItems.filter((item) => item.isStockTracked);

  const result = await prisma.$transaction(async (tx) => {
    const orderNumber = await nextOrderNumber(tx);

    // Approval routing decides the entry status. Reaching PENDING_PAYMENT
    // without approval would let an order be paid that policy says needs a
    // decision first.
    const initialStatus: OrderStatusName = requiresApproval
      ? 'PENDING_APPROVAL'
      : 'PENDING_PAYMENT';

    const { totals } = resolved.pricing;

    await tx.order.create({
      data: {
        id: orderId,
        orderNumber,
        customerProfileId: input.customerProfileId,
        cartId: resolved.cartId,
        source: 'ONE_TIME',
        status: initialStatus,
        currency: resolved.currency,
        subtotalMinor: totals.subtotalMinor,
        discountMinor: totals.discountMinor,
        taxMinor: totals.taxMinor,
        shippingMinor: totals.shippingMinor,
        grandTotalMinor: totals.grandTotalMinor,
        billingAddressJson: billingSnapshot as never,
        shippingAddressJson: shippingSnapshot as never,
        shippingMethodCode: shippingMethod?.code ?? null,
        shippingMethodName: shippingMethod?.name ?? null,
        paymentMode: input.paymentMode,
        customerNote: input.customerNote ?? null,
        placedAt: new Date(),
      },
    });

    // The immutable snapshots. Everything a future invoice or dispute needs,
    // frozen at this instant.
    await tx.orderItem.createMany({
      data: resolved.pricing.lines.map((line: PricedLine) => ({
        id: newId(),
        orderId,
        productId: line.productId,
        variantId: line.variantId,
        nameSnapshot: line.nameSnapshot,
        skuSnapshot: line.skuSnapshot,
        variantNameSnapshot: line.variantNameSnapshot,
        taxClassCodeSnapshot: line.taxClassCodeSnapshot,
        imageUrlSnapshot: line.imageUrlSnapshot,
        unitPriceMinor: line.unitPriceMinor,
        quantity: line.quantity,
        lineSubtotalMinor: line.lineSubtotalMinor,
        taxRatePercent: line.taxRatePercent,
        taxInclusive: line.taxInclusive,
        taxAmountMinor: line.taxAmountMinor,
        discountMinor: line.discountMinor,
        lineTotalMinor: line.lineTotalMinor,
        isRecurringEligibleSnapshot: line.isRecurringEligibleSnapshot,
      })),
    });

    // Reserved inside the same transaction and AFTER the order row exists:
    // stock_reservations.orderId is a foreign key, and "order created" must
    // mean "stock held" or neither. If any line is short, the whole
    // transaction rolls back and no order is written.
    if (stockedItems.length > 0) {
      await reserveStock(
        {
          items: stockedItems.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          orderId,
        },
        tx,
      );
    }

    await tx.orderStatusHistory.create({
      data: {
        id: newId(),
        orderId,
        fromStatus: null,
        toStatus: initialStatus,
        actorType: 'CUSTOMER',
        actorUserId: input.actor.userId,
        reason: 'Checkout submitted',
        correlationId: input.actor.correlationId ?? null,
      },
    });

    if (requiresApproval) {
      await tx.orderApproval.create({
        data: {
          id: newId(),
          orderId,
          status: 'PENDING',
          requiredReason: resolved.limits.approvalReason ?? 'Approval required by account policy.',
        },
      });
    }

    // The coupon is banked inside the same transaction as the order. A retried
    // checkout collides on the unique index over orderId rather than counting
    // the discount twice, and a rolled-back order takes its redemption with it.
    if (resolved.appliedCoupon !== null) {
      await recordRedemption(tx, {
        couponId: resolved.appliedCoupon.couponId,
        orderId,
        customerProfileId: input.customerProfileId,
        codeSnapshot: resolved.appliedCoupon.code,
        discountPercentSnapshot: resolved.appliedCoupon.discountPercent,
        currencyCode: resolved.currency,
        discountMinor: resolved.appliedCoupon.discountMinor,
      });
    }

    await markCartConverted(resolved.cartId, tx);

    await enqueueNotification(
      {
        eventKey: NotificationEvent.ORDER_SUBMITTED,
        recipientEmail: input.actor.email ?? '',
        variables: {
          orderNumber,
          orderTotal: serialiseMoney(totals.grandTotalMinor, resolved.currency).formatted,
          orderStatus: initialStatus,
          orderUrl: `/orders/${orderId}`,
        },
        dedupeKey: `order_submitted:${orderId}`,
        relatedType: 'order',
        relatedId: orderId,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.ORDER_CREATED,
        resourceType: 'order',
        resourceId: orderId,
        actorType: 'CUSTOMER',
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        after: {
          orderNumber,
          status: initialStatus,
          grandTotalMinor: totals.grandTotalMinor,
          currency: resolved.currency,
          lineCount: resolved.pricing.lines.length,
        },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );

    return { orderNumber, status: initialStatus, totals };
  });

  await dispatchPendingNotifications();

  return {
    orderId,
    orderNumber: result.orderNumber,
    status: result.status,
    currency: resolved.currency,
    totals: {
      subtotal: serialiseMoney(result.totals.subtotalMinor, resolved.currency),
      discount: serialiseMoney(result.totals.discountMinor, resolved.currency),
      tax: serialiseMoney(result.totals.taxMinor, resolved.currency),
      shipping: serialiseMoney(result.totals.shippingMinor, resolved.currency),
      grandTotal: serialiseMoney(result.totals.grandTotalMinor, resolved.currency),
    },
    requiresApproval,
    paymentMode: input.paymentMode,
  };
}

export interface TransitionInput {
  orderId: string;
  to: OrderStatusName;
  actor: OrderActor;
  reason?: string;
  meta?: Record<string, unknown>;
}

/**
 * Move an order to a new status.
 *
 * The single write path for `orders.status`. Guards the transition, applies the
 * inventory consequence, appends history and audits - all in one transaction,
 * so an order cannot end up CONFIRMED with its stock uncommitted.
 */
export async function transitionOrder(input: TransitionInput): Promise<{ status: OrderStatusName }> {
  const result = await prisma.$transaction(async (tx) => {
    const order = await tx.order.findUnique({
      where: { id: input.orderId },
      include: { items: true, customerProfile: { include: { user: { select: { email: true } } } } },
    });

    if (order === null) throw notFound('Order');

    const from = order.status;

    assertTransition({
      from,
      to: input.to,
      actor: input.actor.type,
      permissions: input.actor.permissions ?? [],
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
    });

    const now = new Date();
    const data: Record<string, unknown> = { status: input.to };

    // --- Inventory consequences -------------------------------------------
    if (input.to === 'CONFIRMED') {
      data['confirmedAt'] = now;
      // Commit is idempotent: a duplicate confirmation finds nothing ACTIVE.
      await commitReservations(input.orderId, tx);
    }

    if (input.to === 'CANCELLED') {
      data['cancelledAt'] = now;
      data['cancelReason'] = input.reason ?? null;

      if (holdsCommittedStock(from)) {
        // Stock was already committed, so return it rather than releasing a
        // reservation that no longer exists.
        await restockFromOrder(
          input.orderId,
          order.items.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            sellableQty: item.quantity,
          })),
          'ORDER_CANCEL_RESTOCK',
          tx,
        );
      } else {
        await releaseReservations({ orderId: input.orderId }, 'order_cancelled', tx);
      }
    }

    if (input.to === 'RETURNED') {
      // Restocking happens when the return is inspected, not on the status
      // change: how much comes back sellable is not known yet.
      data['cancelReason'] = input.reason ?? null;
    }

    await tx.order.update({ where: { id: input.orderId }, data });

    await tx.orderStatusHistory.create({
      data: {
        id: newId(),
        orderId: input.orderId,
        fromStatus: from,
        toStatus: input.to,
        actorType: input.actor.type,
        actorUserId: input.actor.userId,
        reason: input.reason ?? null,
        metaJson: (input.meta ?? null) as never,
        correlationId: input.actor.correlationId ?? null,
      },
    });

    // --- Customer-facing notifications ------------------------------------
    const notifiableEvent =
      input.to === 'CONFIRMED'
        ? NotificationEvent.ORDER_CONFIRMED
        : input.to === 'CANCELLED'
          ? NotificationEvent.ORDER_CANCELLED
          : input.to === 'SHIPPED'
            ? NotificationEvent.ORDER_SHIPPED
            : null;

    if (notifiableEvent !== null) {
      await enqueueNotification(
        {
          eventKey: notifiableEvent,
          recipientEmail: order.customerProfile.user.email,
          recipientName: order.customerProfile.fullName,
          variables: {
            orderNumber: order.orderNumber,
            orderTotal: serialiseMoney(order.grandTotalMinor, order.currency).formatted,
            orderStatus: input.to,
            orderUrl: `/orders/${input.orderId}`,
          },
          // One email per order per status, however many times a retry runs.
          dedupeKey: `order_status:${input.orderId}:${input.to}`,
          relatedType: 'order',
          relatedId: input.orderId,
          correlationId: input.actor.correlationId ?? null,
        },
        tx,
      );
    }

    await recordAudit(
      {
        action:
          input.to === 'CANCELLED' ? AuditAction.ORDER_CANCELLED : AuditAction.ORDER_STATUS_CHANGED,
        resourceType: 'order',
        resourceId: input.orderId,
        actorType: input.actor.type === 'SYSTEM' ? 'SYSTEM' : input.actor.type,
        actorUserId: input.actor.userId,
        actorEmail: input.actor.email,
        before: { status: from },
        after: { status: input.to, reason: input.reason ?? null },
        ipAddress: input.actor.ipAddress ?? null,
        correlationId: input.actor.correlationId ?? null,
      },
      tx,
    );

    return { status: input.to };
  });

  await dispatchPendingNotifications();
  return result;
}

/** Approve or reject an order awaiting a decision. */
export async function decideApproval(
  orderId: string,
  approved: boolean,
  actor: OrderActor,
  comment?: string,
): Promise<{ status: OrderStatusName }> {
  const approval = await prisma.orderApproval.findFirst({
    where: { orderId, status: 'PENDING' },
  });

  if (approval === null) {
    throw conflict(
      ErrorCode.ORDER_APPROVAL_ALREADY_DECIDED,
      'This order has no pending approval.',
    );
  }

  await prisma.orderApproval.update({
    where: { id: approval.id },
    data: {
      status: approved ? 'APPROVED' : 'REJECTED',
      decidedById: actor.userId,
      decidedAt: new Date(),
      comment: comment ?? null,
    },
  });

  return transitionOrder({
    orderId,
    to: approved ? 'PENDING_PAYMENT' : 'CANCELLED',
    actor,
    reason: approved
      ? (comment ?? 'Approved')
      : (comment ?? 'Rejected by approver'),
  });
}

/** What this actor may currently do, so the Admin Panel renders real buttons. */
export async function availableTransitions(
  orderId: string,
  actor: OrderActor,
): Promise<{ to: OrderStatusName; requiresReason: boolean; permission: string | null }[]> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });

  if (order === null) throw notFound('Order');

  return allowedTransitions(
    order.status,
    actor.type,
    actor.permissions ?? [],
  );
}
