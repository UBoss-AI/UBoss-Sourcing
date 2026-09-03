/**
 * Refunds.
 *
 * The invariant, from SOP 10.4: a refund can never exceed what was captured,
 * minus what has already been refunded. It is enforced three times over, on
 * purpose:
 *
 *   1. Here, in the service, inside a transaction that locks the order row.
 *   2. By `chk_order_refund_within_paid` in the database.
 *   3. By the provider, which rejects an over-refund of its own accord.
 *
 * Refunds settle asynchronously. `SUCCEEDED` is set from a verified provider
 * event or a reconciliation, never from the API response that merely accepted
 * the request.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { loadActiveProvider } from './payment.service.js';
import { PaymentProviderError } from './provider.js';

export interface RefundQuote {
  capturedMinor: string;
  alreadyRefundedMinor: string;
  maxRefundableMinor: string;
  currency: string;
}

/**
 * What the admin refund dialog shows before anything is submitted.
 *
 * SOP 8 requires the operator to see captured, previously refunded and maximum
 * refundable, so the number they type is an informed one.
 */
export async function getRefundQuote(orderId: string): Promise<RefundQuote> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { paidMinor: true, refundedMinor: true, currency: true },
  });

  if (order === null) throw notFound('Order');

  const maxRefundable = order.paidMinor - order.refundedMinor;

  return {
    capturedMinor: order.paidMinor.toString(),
    alreadyRefundedMinor: order.refundedMinor.toString(),
    maxRefundableMinor: (maxRefundable > 0n ? maxRefundable : 0n).toString(),
    currency: order.currency,
  };
}

export interface CreateRefundInput {
  orderId: string;
  /** Minor units as a string. Omit to refund the full remaining amount. */
  amountMinor?: string;
  reason: string;
  idempotencyKey: string;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface CreatedRefund {
  refundId: string;
  status: string;
  amount: ReturnType<typeof serialiseMoney>;
  providerRefundId: string | null;
}

export async function createRefund(input: CreateRefundInput): Promise<CreatedRefund> {
  // --- Input shape first, business state second -------------------------
  //
  // Ordering matters: a malformed amount is a caller mistake and should be
  // reported as one, whatever state the order happens to be in. Checking the
  // order first would answer "no captured payment" to a request that was never
  // well-formed, and the caller would fix the wrong thing.
  if (input.reason.trim().length === 0) {
    throw badRequest(ErrorCode.VALIDATION_FAILED, 'A reason is required for a refund.', [
      { field: 'reason', code: 'REQUIRED' },
    ]);
  }

  let requestedMinor: bigint | null = null;

  if (input.amountMinor !== undefined) {
    if (!/^\d+$/.test(input.amountMinor.trim())) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'Amounts must be whole minor units.', [
        { field: 'amountMinor', code: 'INVALID_MONEY' },
      ]);
    }

    requestedMinor = BigInt(input.amountMinor.trim());

    if (requestedMinor <= 0n) {
      throw badRequest(ErrorCode.VALIDATION_FAILED, 'A refund must be greater than zero.', [
        { field: 'amountMinor', code: 'INVALID' },
      ]);
    }
  }

  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: {
      payments: { where: { status: 'CAPTURED' }, orderBy: { capturedAt: 'desc' } },
      customerProfile: { include: { user: { select: { email: true } } } },
    },
  });

  if (order === null) throw notFound('Order');

  const capturedPayment = order.payments[0];
  if (capturedPayment === undefined || capturedPayment.providerPaymentId === null) {
    throw conflict(
      ErrorCode.PAYMENT_NOT_CAPTURED,
      'There is no captured payment on this order to refund.',
    );
  }

  const maxRefundable = order.paidMinor - order.refundedMinor;

  if (maxRefundable <= 0n) {
    throw conflict(
      ErrorCode.REFUND_EXCEEDS_CAPTURED,
      'This order has already been refunded in full.',
    );
  }

  // Omitting the amount means "refund everything still refundable".
  const amountMinor = requestedMinor ?? maxRefundable;

  // The check that matters. Also enforced by the database and the provider.
  if (amountMinor > maxRefundable) {
    throw conflict(
      ErrorCode.REFUND_EXCEEDS_CAPTURED,
      `The maximum refundable amount is ${serialiseMoney(maxRefundable, order.currency).formatted} ${order.currency}.`,
      [
        {
          field: 'amountMinor',
          code: 'EXCEEDS_MAX',
          meta: {
            maxRefundableMinor: maxRefundable.toString(),
            requestedMinor: amountMinor.toString(),
          },
        },
      ],
    );
  }

  // Idempotency: a retried request with the same key returns the existing
  // refund rather than issuing a second one.
  const existing = await prisma.refund.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing !== null) {
    return {
      refundId: existing.id,
      status: existing.status,
      amount: serialiseMoney(existing.amountMinor, existing.currency),
      providerRefundId: existing.providerRefundId,
    };
  }

  const refundId = newId();

  // Recorded as REQUESTED before the provider call, so a crash mid-call leaves
  // a row to reconcile rather than a refund nobody knows about.
  await prisma.refund.create({
    data: {
      id: refundId,
      orderId: order.id,
      paymentTransactionId: capturedPayment.id,
      provider: capturedPayment.provider,
      amountMinor,
      currency: order.currency,
      reason: input.reason.trim(),
      status: 'REQUESTED',
      requestedById: input.actorUserId,
      idempotencyKey: input.idempotencyKey,
    },
  });

  const { provider } = await loadActiveProvider();

  try {
    const result = await provider.createRefund({
      providerPaymentId: capturedPayment.providerPaymentId,
      amountMinor,
      currency: order.currency,
      reason: input.reason.trim(),
      idempotencyKey: input.idempotencyKey,
    });

    await prisma.$transaction(async (tx) => {
      await tx.refund.update({
        where: { id: refundId },
        data: {
          providerRefundId: result.providerRefundId,
          status: result.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PROCESSING',
          ...(result.status === 'SUCCEEDED' ? { completedAt: new Date() } : {}),
        },
      });

      // The order's refunded total advances as soon as the provider accepts.
      // chk_order_refund_within_paid rejects the write if this would ever
      // exceed what was paid.
      await tx.order.update({
        where: { id: order.id },
        data: { refundedMinor: { increment: amountMinor } },
      });
    });

    await enqueueNotification({
      eventKey: NotificationEvent.REFUND_PROCESSED,
      recipientEmail: order.customerProfile.user.email,
      recipientName: order.customerProfile.fullName,
      variables: {
        orderNumber: order.orderNumber,
        amount: serialiseMoney(amountMinor, order.currency).formatted,
        currency: order.currency,
        status: result.status,
      },
      dedupeKey: `refund:${refundId}`,
      relatedType: 'order',
      relatedId: order.id,
      correlationId: input.correlationId ?? null,
    });

    await recordAudit({
      action: AuditAction.REFUND_CREATED,
      resourceType: 'refund',
      resourceId: refundId,
      actorType: 'ADMIN',
      actorUserId: input.actorUserId,
      actorEmail: input.actorEmail,
      after: {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountMinor,
        reason: input.reason,
        providerRefundId: result.providerRefundId,
      },
      ipAddress: input.ipAddress ?? null,
      correlationId: input.correlationId ?? null,
    });

    await dispatchPendingNotifications();

    return {
      refundId,
      status: result.status === 'SUCCEEDED' ? 'SUCCEEDED' : 'PROCESSING',
      amount: serialiseMoney(amountMinor, order.currency),
      providerRefundId: result.providerRefundId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown provider error';

    await prisma.refund.update({
      where: { id: refundId },
      data: {
        status: 'FAILED',
        failureMessage: message.slice(0, 500),
        ...(error instanceof PaymentProviderError
          ? { failureCode: error.providerCode ?? 'PROVIDER_ERROR' }
          : {}),
      },
    });

    logger.error({ refundId, orderId: order.id, err: error }, 'refund failed at the provider');

    if (error instanceof PaymentProviderError) {
      throw badRequest(ErrorCode.PAYMENT_PROVIDER_ERROR, error.message, [
        { code: error.providerCode ?? 'PROVIDER_ERROR', field: 'refund' },
      ]);
    }
    throw error;
  }
}

/**
 * Move an order to REFUNDED once it is fully refunded.
 *
 * Separate from `createRefund` because a partial refund must not change the
 * order status - the goods may still be shipping.
 */
export async function settleRefundedOrder(
  orderId: string,
  actor: { userId: string | null; email: string | null; permissions?: readonly string[] },
): Promise<{ transitioned: boolean }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, paidMinor: true, refundedMinor: true },
  });

  if (order === null) throw notFound('Order');

  const fullyRefunded = order.paidMinor > 0n && order.refundedMinor >= order.paidMinor;
  if (!fullyRefunded) return { transitioned: false };

  // Only CANCELLED and RETURNED lead to REFUNDED in the state machine.
  if (order.status !== 'CANCELLED' && order.status !== 'RETURNED') {
    return { transitioned: false };
  }

  const { transitionOrder } = await import('../orders/order.service.js');

  await transitionOrder({
    orderId,
    to: 'REFUNDED',
    actor: {
      userId: actor.userId,
      email: actor.email,
      type: actor.userId === null ? 'SYSTEM' : 'ADMIN',
      permissions: actor.permissions ?? [],
    },
    reason: 'Refund completed in full',
  });

  return { transitioned: true };
}
