/**
 * Payment links.
 *
 * The SOP 10.3 flow: a customer chooses "send the payment link to Finance", or
 * policy requires it, and an authorised payer settles the order from an email.
 *
 * A payment link is a bearer credential sitting in an inbox, so it is built
 * like one:
 *
 *   - 32 bytes of CSPRNG output. Only the SHA-256 is stored, so a database
 *     dump yields no usable links.
 *   - Bound to one order, one recipient and one amount. A later order edit
 *     invalidates it rather than silently repricing what the payer approved.
 *   - Expiring and single use. Redemption marks it used inside the same
 *     transaction that creates the payment, so two clicks cannot both pay.
 *   - Resending supersedes the old link. The previous email stops working.
 */
import { env } from '../../config/env.js';
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { generateToken, sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { loadActiveProvider } from './payment.service.js';
import { PaymentProviderError } from './provider.js';

export interface CreatePaymentLinkInput {
  orderId: string;
  recipientEmail: string;
  recipientName?: string | null;
  /** Overrides the configured default. Bounded so a link cannot live forever. */
  expiryHours?: number;
  actorUserId: string;
  actorEmail: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export interface CreatedPaymentLink {
  paymentLinkId: string;
  recipientEmail: string;
  amount: ReturnType<typeof serialiseMoney>;
  expiresAt: Date;
  /** Only returned so tests and local development can follow the flow. */
  url: string;
}

function buildLinkUrl(token: string): string {
  return `${env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '')}/pay?token=${encodeURIComponent(token)}`;
}

export async function createPaymentLink(
  input: CreatePaymentLinkInput,
): Promise<CreatedPaymentLink> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { customerProfile: { select: { fullName: true } } },
  });

  if (order === null) throw notFound('Order');

  if (order.status !== 'PENDING_PAYMENT') {
    throw conflict(
      ErrorCode.ORDER_ALREADY_PAID,
      `This order is ${order.status.toLowerCase()} and is not awaiting payment.`,
    );
  }

  const outstanding = order.grandTotalMinor - order.paidMinor;
  if (outstanding <= 0n) {
    throw conflict(ErrorCode.ORDER_ALREADY_PAID, 'This order is already paid in full.');
  }

  const expiryHours = Math.min(input.expiryHours ?? env.PAYMENT_LINK_TTL_HOURS, 8760);
  const expiresAt = new Date(Date.now() + expiryHours * 3_600_000);

  const { token, tokenHash } = generateToken(32);
  const linkId = newId();

  await prisma.$transaction(async (tx) => {
    // Supersede outstanding links for this order. Two live links for one order
    // is two invitations to pay the same money.
    const superseded = await tx.paymentLink.findMany({
      where: { orderId: order.id, usedAt: null, revokedAt: null },
      select: { id: true },
    });

    if (superseded.length > 0) {
      await tx.paymentLink.updateMany({
        where: { id: { in: superseded.map((link) => link.id) } },
        data: {
          revokedAt: new Date(),
          revokedReason: 'superseded by a newer link',
          supersededByLinkId: linkId,
        },
      });
    }

    await tx.paymentLink.create({
      data: {
        id: linkId,
        orderId: order.id,
        // Only the hash. The raw token exists in exactly one email.
        tokenHash,
        recipientEmail: input.recipientEmail.trim().toLowerCase(),
        recipientName: input.recipientName ?? null,
        // Locked at creation: the payer approves this figure, not whatever the
        // order says later.
        amountMinor: outstanding,
        currency: order.currency,
        expiresAt,
        createdById: input.actorUserId,
        sentAt: new Date(),
      },
    });

    await enqueueNotification(
      {
        eventKey: NotificationEvent.PAYMENT_LINK,
        recipientEmail: input.recipientEmail.trim(),
        recipientName: input.recipientName ?? null,
        variables: {
          orderNumber: order.orderNumber,
          amount: serialiseMoney(outstanding, order.currency).formatted,
          currency: order.currency,
          customerName: order.customerProfile.fullName,
          paymentUrl: buildLinkUrl(token),
          expiresAt: expiresAt.toISOString(),
        },
        dedupeKey: `payment_link:${linkId}`,
        relatedType: 'order',
        relatedId: order.id,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );

    await recordAudit(
      {
        action: AuditAction.PAYMENT_LINK_CREATED,
        resourceType: 'payment_link',
        resourceId: linkId,
        actorType: 'ADMIN',
        actorUserId: input.actorUserId,
        actorEmail: input.actorEmail,
        after: {
          orderId: order.id,
          orderNumber: order.orderNumber,
          recipientEmail: input.recipientEmail,
          amountMinor: outstanding,
          expiresAt: expiresAt.toISOString(),
          supersededCount: superseded.length,
        },
        ipAddress: input.ipAddress ?? null,
        correlationId: input.correlationId ?? null,
      },
      tx,
    );
  });

  await dispatchPendingNotifications();

  return {
    paymentLinkId: linkId,
    recipientEmail: input.recipientEmail,
    amount: serialiseMoney(outstanding, order.currency),
    expiresAt,
    url: buildLinkUrl(token),
  };
}

export interface ResolvedPaymentLink {
  paymentLinkId: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  amount: ReturnType<typeof serialiseMoney>;
  expiresAt: Date;
  itemCount: number;
}

/**
 * Look up a link for display, without consuming it.
 *
 * The payer sees what they are about to pay for before committing.
 */
export async function resolvePaymentLink(token: string): Promise<ResolvedPaymentLink> {
  const link = await prisma.paymentLink.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: {
      order: {
        include: {
          customerProfile: { select: { fullName: true } },
          _count: { select: { items: true } },
        },
      },
    },
  });

  // Every failure below is a distinct, actionable state for the payer.
  if (link === null) {
    throw badRequest(ErrorCode.PAYMENT_LINK_INVALID, 'This payment link is not valid.');
  }

  if (link.usedAt !== null) {
    throw conflict(
      ErrorCode.PAYMENT_LINK_ALREADY_USED,
      'This payment link has already been used. The order may already be paid.',
    );
  }

  if (link.revokedAt !== null) {
    throw conflict(
      ErrorCode.PAYMENT_LINK_REVOKED,
      'This payment link is no longer valid. Please ask for a new one.',
    );
  }

  if (link.expiresAt.getTime() <= Date.now()) {
    throw conflict(
      ErrorCode.PAYMENT_LINK_EXPIRED,
      'This payment link has expired. Please ask for a new one.',
    );
  }

  // The order moved on since the link was sent - paid another way, cancelled.
  if (link.order.status !== 'PENDING_PAYMENT') {
    throw conflict(
      ErrorCode.ORDER_ALREADY_PAID,
      `This order is ${link.order.status.toLowerCase()} and no longer needs payment.`,
    );
  }

  // The locked amount must still match what is owed. If the order was edited,
  // the payer would otherwise be settling a figure they never approved.
  const outstanding = link.order.grandTotalMinor - link.order.paidMinor;
  if (outstanding !== link.amountMinor) {
    throw conflict(
      ErrorCode.PAYMENT_AMOUNT_MISMATCH,
      'This order has changed since the link was sent. Please ask for a new link.',
    );
  }

  await prisma.paymentLink.update({
    where: { id: link.id },
    data: { openedAt: link.openedAt ?? new Date() },
  });

  return {
    paymentLinkId: link.id,
    orderId: link.orderId,
    orderNumber: link.order.orderNumber,
    customerName: link.order.customerProfile.fullName,
    amount: serialiseMoney(link.amountMinor, link.currency),
    expiresAt: link.expiresAt,
    itemCount: link.order._count.items,
  };
}

export interface RedeemedPaymentLink {
  paymentTransactionId: string;
  providerOrderId: string;
  checkoutPayload: Record<string, string | number>;
  amount: ReturnType<typeof serialiseMoney>;
}

/**
 * Start the payment for a link.
 *
 * The link is marked used inside the same transaction that records the payment
 * attempt, guarded on `usedAt: null` - so two simultaneous clicks race there
 * and exactly one creates a payment.
 */
export async function redeemPaymentLink(
  token: string,
  correlationId?: string,
): Promise<RedeemedPaymentLink> {
  // Revalidates every condition and throws on any of them. The return value is
  // not needed - this call is here for its checks, not its data, and the fresh
  // row is loaded below.
  await resolvePaymentLink(token);

  const link = await prisma.paymentLink.findUniqueOrThrow({
    where: { tokenHash: sha256Hex(token) },
    include: {
      order: {
        include: { customerProfile: { include: { user: { select: { email: true } } } } },
      },
    },
  });

  // Claim it. `usedAt: null` in the where clause is the whole guard.
  const claimed = await prisma.paymentLink.updateMany({
    where: { id: link.id, usedAt: null, revokedAt: null },
    data: { usedAt: new Date() },
  });

  if (claimed.count !== 1) {
    throw conflict(
      ErrorCode.PAYMENT_LINK_ALREADY_USED,
      'This payment link has just been used. Refresh to see the order status.',
    );
  }

  const { provider, connectionId } = await loadActiveProvider();

  try {
    const created = await provider.createPayment({
      orderId: link.orderId,
      orderNumber: link.order.orderNumber,
      amountMinor: link.amountMinor,
      currency: link.currency,
      customerEmail: link.recipientEmail,
      customerName: link.recipientName ?? link.order.customerProfile.fullName,
      customerPhone: null,
      idempotencyKey: `link:${link.id}`,
    });

    const transactionId = newId();

    await prisma.paymentTransaction.create({
      data: {
        id: transactionId,
        orderId: link.orderId,
        connectionId,
        provider: provider.kind,
        mode: provider.mode,
        providerOrderId: created.providerOrderId,
        status: 'CREATED',
        amountMinor: link.amountMinor,
        currency: link.currency,
        idempotencyKey: `link:${link.id}`,
      },
    });

    await recordAudit({
      action: AuditAction.PAYMENT_CREATED,
      resourceType: 'payment',
      resourceId: transactionId,
      actorType: 'SYSTEM',
      after: {
        via: 'payment_link',
        paymentLinkId: link.id,
        orderId: link.orderId,
        amountMinor: link.amountMinor,
      },
      correlationId: correlationId ?? null,
    });

    return {
      paymentTransactionId: transactionId,
      providerOrderId: created.providerOrderId,
      checkoutPayload: created.checkoutPayload,
      amount: serialiseMoney(link.amountMinor, link.currency),
    };
  } catch (error) {
    // The provider refused. Release the link so the payer can try again rather
    // than being locked out by a failure that was not theirs.
    await prisma.paymentLink.updateMany({
      where: { id: link.id, usedAt: { not: null } },
      data: { usedAt: null },
    });

    if (error instanceof PaymentProviderError) {
      throw badRequest(ErrorCode.PAYMENT_PROVIDER_ERROR, error.message);
    }
    throw error;
  }
}

export async function revokePaymentLink(
  paymentLinkId: string,
  actor: { userId: string; email: string; ipAddress?: string | null; correlationId?: string | null },
  reason: string,
): Promise<void> {
  const revoked = await prisma.paymentLink.updateMany({
    where: { id: paymentLinkId, usedAt: null, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });

  if (revoked.count === 0) {
    throw conflict(
      ErrorCode.CONFLICT,
      'This link is already used or revoked and cannot be revoked again.',
    );
  }

  await recordAudit({
    action: AuditAction.PAYMENT_LINK_REVOKED,
    resourceType: 'payment_link',
    resourceId: paymentLinkId,
    actorType: 'ADMIN',
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { reason },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });
}

/** Housekeeping: mark expired links so admin lists show why they stopped working. */
export async function expirePaymentLinks(): Promise<number> {
  const result = await prisma.paymentLink.updateMany({
    where: { usedAt: null, revokedAt: null, expiresAt: { lt: new Date() } },
    data: { revokedAt: new Date(), revokedReason: 'expired' },
  });
  return result.count;
}
