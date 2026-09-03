/**
 * Payments.
 *
 * The rule this module exists to enforce: **an order becomes CONFIRMED only
 * from a signature-verified provider event whose amount and currency match the
 * order.** Not from a client redirect, not from an admin button, not from a
 * hopeful assumption after a timeout.
 *
 * Duplicate protection is structural. `payment_events.providerEventId` is
 * unique, so a redelivered webhook collides on insert and is acknowledged
 * without being reprocessed. Razorpay retries webhooks; without that index a
 * retry would confirm the order twice and commit the stock twice.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { env } from '../../config/env.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { transitionOrder } from '../orders/order.service.js';
import { RazorpayAdapter } from './razorpay.adapter.js';
import {
  PaymentProviderError,
  modeForCredential,
  type CreatePaymentResult,
  type PaymentProvider,
  type ProviderCredentials,
  type ProviderKind,
  type VerifiedEvent,
} from './provider.js';

/** AAD binds a credential ciphertext to the row it belongs to. */
function credentialAad(connectionId: string): string {
  return `payment_connection:${connectionId}`;
}

export interface LoadedProvider {
  provider: PaymentProvider;
  connectionId: string;
  kind: ProviderKind;
}

/**
 * Resolve the active provider.
 *
 * Prefers an admin-configured connection (credentials encrypted in the
 * database) and falls back to environment credentials for local development.
 * With neither, it throws PAYMENT_PROVIDER_NOT_CONFIGURED - there is no
 * simulated-success branch, and none should be added.
 */
export async function loadActiveProvider(): Promise<LoadedProvider> {
  const connection = await prisma.paymentProviderConnection.findFirst({
    where: { isActive: true },
    orderBy: { updatedAt: 'desc' },
  });

  if (connection !== null) {
    const decrypted = decryptSecret(connection.credentialsEnc, credentialAad(connection.id));
    const credentials = JSON.parse(decrypted) as ProviderCredentials;

    const webhookSecret =
      connection.webhookSecretEnc === null
        ? ''
        : decryptSecret(connection.webhookSecretEnc, credentialAad(connection.id));

    return {
      provider: buildProvider(connection.provider, { ...credentials, webhookSecret }),
      connectionId: connection.id,
      kind: connection.provider,
    };
  }

  // Development fallback. The env guard in config/env.ts already refuses a
  // live key outside production, so this path cannot silently go live.
  if (env.RAZORPAY_KEY_ID.length > 0 && env.RAZORPAY_KEY_SECRET.length > 0) {
    const bootstrapped = await ensureBootstrapConnection();
    return {
      provider: buildProvider('RAZORPAY', {
        keyId: env.RAZORPAY_KEY_ID,
        keySecret: env.RAZORPAY_KEY_SECRET,
        webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
      }),
      connectionId: bootstrapped,
      kind: 'RAZORPAY',
    };
  }

  throw badRequest(
    ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
    'No payment provider is configured. An administrator must connect one in Settings > Payments.',
  );
}

function buildProvider(kind: ProviderKind, credentials: ProviderCredentials): PaymentProvider {
  switch (kind) {
    case 'RAZORPAY':
      return new RazorpayAdapter(credentials);
    case 'STRIPE':
      // Declared rather than silently unsupported: a deployment that believes
      // it has Stripe must fail loudly, not fall back to another provider.
      throw badRequest(
        ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
        'The Stripe adapter is not implemented yet.',
      );
    default: {
      const exhaustive: never = kind;
      throw badRequest(
        ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
        `Unknown payment provider: ${String(exhaustive)}`,
      );
    }
  }
}

/**
 * Persist a connection row for the environment credentials.
 *
 * Payment transactions carry a foreign key to a connection, so one has to
 * exist. The credentials are encrypted here exactly as an admin-entered one
 * would be.
 */
async function ensureBootstrapConnection(): Promise<string> {
  const mode = modeForCredential(env.RAZORPAY_KEY_ID);

  const existing = await prisma.paymentProviderConnection.findUnique({
    where: { provider_mode: { provider: 'RAZORPAY', mode } },
    select: { id: true },
  });

  if (existing !== null) return existing.id;

  const id = newId();

  await prisma.paymentProviderConnection.create({
    data: {
      id,
      provider: 'RAZORPAY',
      mode,
      label: `Razorpay (${mode}, from environment)`,
      credentialsEnc: encryptSecret(
        JSON.stringify({ keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET }),
        credentialAad(id),
      ),
      webhookSecretEnc:
        env.RAZORPAY_WEBHOOK_SECRET.length > 0
          ? encryptSecret(env.RAZORPAY_WEBHOOK_SECRET, credentialAad(id))
          : null,
      credentialsMask: maskSecret(env.RAZORPAY_KEY_ID),
      isActive: true,
    },
  });

  return id;
}

export interface CreateOrderPaymentInput {
  orderId: string;
  customerProfileId: string;
  idempotencyKey: string;
  actorUserId: string | null;
  correlationId?: string | null;
}

export interface CreateOrderPaymentResult {
  paymentTransactionId: string;
  provider: ProviderKind;
  mode: string;
  providerOrderId: string;
  amount: ReturnType<typeof serialiseMoney>;
  checkoutPayload: Record<string, string | number>;
}

/**
 * Start a payment for an order.
 *
 * The amount comes from `orders.grandTotalMinor` and nowhere else. A client
 * that supplied its own amount would be choosing what to pay.
 */
export async function createOrderPayment(
  input: CreateOrderPaymentInput,
): Promise<CreateOrderPaymentResult> {
  const order = await prisma.order.findFirst({
    // Scoped by customer: another customer's order must not be payable.
    where: { id: input.orderId, customerProfileId: input.customerProfileId },
    include: { customerProfile: { include: { user: { select: { email: true } } } } },
  });

  if (order === null) throw notFound('Order');

  if (order.status !== 'PENDING_PAYMENT') {
    throw conflict(
      order.status === 'PENDING_APPROVAL'
        ? ErrorCode.ORDER_APPROVAL_REQUIRED
        : ErrorCode.ORDER_ALREADY_PAID,
      order.status === 'PENDING_APPROVAL'
        ? 'This order is waiting for approval and cannot be paid yet.'
        : `This order is ${order.status.toLowerCase()} and is not awaiting payment.`,
    );
  }

  const outstanding = order.grandTotalMinor - order.paidMinor;
  if (outstanding <= 0n) {
    throw conflict(ErrorCode.ORDER_ALREADY_PAID, 'This order is already paid in full.');
  }

  const { provider, connectionId } = await loadActiveProvider();

  /**
   * An earlier attempt with this same key.
   *
   * `payment_transactions.idempotencyKey` is unique, so a retry would collide
   * on insert — which is the protection working, but a unique-constraint
   * violation is not an answer a client can use. A customer whose payment
   * failed and who presses "try again" reaches exactly this path, so it must
   * replay the original session rather than 500.
   *
   * Checked before the provider is called, so a retry also does not leave an
   * orphaned order in the gateway's dashboard.
   */
  const existing = await prisma.paymentTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing !== null) {
    if (existing.orderId !== order.id) {
      // The same key used against a different order is a client bug, and
      // replaying the other order's session would be a data leak.
      throw conflict(
        ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY,
        'That request key has already been used for a different order.',
      );
    }

    return {
      paymentTransactionId: existing.id,
      provider: existing.provider,
      mode: existing.mode,
      providerOrderId: existing.providerOrderId ?? '',
      amount: serialiseMoney(existing.amountMinor, existing.currency),
      checkoutPayload: provider.buildCheckoutPayload(existing.providerOrderId ?? '', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountMinor: existing.amountMinor,
        currency: existing.currency,
        customerEmail: order.customerProfile.user.email,
        customerName: order.customerProfile.fullName,
        customerPhone: order.customerProfile.phone,
      }),
    };
  }

  let created: CreatePaymentResult;
  try {
    created = await provider.createPayment({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: outstanding,
      currency: order.currency,
      customerEmail: order.customerProfile.user.email,
      customerName: order.customerProfile.fullName,
      customerPhone: order.customerProfile.phone,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw badRequest(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        // The provider's own message is safe to surface: it explains the
        // failure to the customer without exposing credentials.
        error.message,
        [{ code: error.providerCode ?? 'PROVIDER_ERROR', field: 'payment' }],
      );
    }
    throw error;
  }

  const transactionId = newId();

  await prisma.paymentTransaction.create({
    data: {
      id: transactionId,
      orderId: order.id,
      connectionId,
      provider: provider.kind,
      mode: provider.mode,
      providerOrderId: created.providerOrderId,
      status: 'CREATED',
      amountMinor: outstanding,
      currency: order.currency,
      idempotencyKey: input.idempotencyKey,
    },
  });

  await recordAudit({
    action: AuditAction.PAYMENT_CREATED,
    resourceType: 'payment',
    resourceId: transactionId,
    actorType: 'CUSTOMER',
    actorUserId: input.actorUserId,
    after: {
      orderId: order.id,
      providerOrderId: created.providerOrderId,
      amountMinor: outstanding,
      provider: provider.kind,
      mode: provider.mode,
    },
    correlationId: input.correlationId ?? null,
  });

  return {
    paymentTransactionId: transactionId,
    provider: provider.kind,
    mode: provider.mode,
    providerOrderId: created.providerOrderId,
    amount: serialiseMoney(outstanding, order.currency),
    checkoutPayload: created.checkoutPayload,
  };
}

export interface WebhookResult {
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
}

/**
 * Process a provider webhook.
 *
 * The order of operations is the security design:
 *
 *   1. Verify the signature over the RAW body. Nothing is trusted before this.
 *   2. Record the event, keyed unique on providerEventId. A duplicate collides
 *      here and stops.
 *   3. Match the order, amount and currency. A mismatch is rejected and
 *      alerted, never applied.
 *   4. Apply the state change transactionally.
 *
 * Returns 200 even for a rejected event: the provider must stop retrying
 * something we have deliberately refused. The rejection is recorded and
 * alerted instead.
 */
export async function processWebhook(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  correlationId?: string,
): Promise<WebhookResult> {
  const { provider, connectionId } = await loadActiveProvider();

  // --- 1. Verify --------------------------------------------------------
  const event: VerifiedEvent = provider.verifyWebhook(rawBody, headers);

  if (!event.verified) {
    logger.warn(
      { reason: event.rejectionReason, provider: provider.kind, correlationId },
      'rejected an unverified payment webhook',
    );

    await prisma.paymentEvent.create({
      data: {
        id: newId(),
        provider: provider.kind,
        connectionId,
        // Unverified events have no trustworthy id; a random one keeps the
        // audit row without letting a forged id poison the duplicate guard.
        providerEventId: `unverified:${newId()}`,
        eventType: 'unverified',
        signatureVerified: false,
        rawPayload: rawBody.toString('utf8').slice(0, 60_000),
        processingStatus: 'REJECTED',
        processingError: event.rejectionReason ?? 'signature verification failed',
      },
    });

    await recordAudit({
      action: AuditAction.WEBHOOK_REJECTED,
      resourceType: 'payment_event',
      actorType: 'PROVIDER',
      after: { reason: event.rejectionReason, provider: provider.kind },
      correlationId: correlationId ?? null,
    });

    return { accepted: false, duplicate: false, reason: 'signature verification failed' };
  }

  // --- 2. Duplicate guard ------------------------------------------------
  const eventRowId = newId();

  const inserted = await prisma.paymentEvent.createMany({
    data: [
      {
        id: eventRowId,
        provider: provider.kind,
        connectionId,
        providerEventId: event.eventId,
        eventType: event.eventType,
        signatureVerified: true,
        rawPayload: rawBody.toString('utf8').slice(0, 60_000),
        processingStatus: 'RECEIVED',
      },
    ],
    skipDuplicates: true,
  });

  if (inserted.count === 0) {
    // Already seen. Acknowledge so the provider stops retrying, and change
    // nothing - this is what makes redelivery harmless.
    logger.info({ eventId: event.eventId, correlationId }, 'duplicate webhook acknowledged');
    return { accepted: true, duplicate: true };
  }

  try {
    const outcome = await applyEvent(event, eventRowId, correlationId);
    return outcome;
  } catch (error) {
    await prisma.paymentEvent.update({
      where: { id: eventRowId },
      data: {
        processingStatus: 'FAILED',
        processingError: error instanceof Error ? error.message.slice(0, 1000) : 'unknown error',
      },
    });
    throw error;
  }
}

async function applyEvent(
  event: VerifiedEvent,
  eventRowId: string,
  correlationId?: string,
): Promise<WebhookResult> {
  if (event.intent === 'UNKNOWN') {
    // A real event we simply do not act on (payment.authorized, and so on).
    await prisma.paymentEvent.update({
      where: { id: eventRowId },
      data: { processingStatus: 'PROCESSED', processedAt: new Date() },
    });
    return { accepted: true, duplicate: false, reason: 'event type not actionable' };
  }

  // --- 3. Match ----------------------------------------------------------
  const transaction =
    event.providerOrderId === null
      ? null
      : await prisma.paymentTransaction.findFirst({
          where: { providerOrderId: event.providerOrderId },
          include: { order: true },
        });

  if (transaction === null) {
    await markEventRejected(eventRowId, 'no matching payment transaction');
    return { accepted: false, duplicate: false, reason: 'no matching payment transaction' };
  }

  const order = transaction.order;

  if (event.intent === 'PAYMENT_CAPTURED') {
    // The amount check. A provider event claiming a different amount than the
    // order is either a bug or an attack, and must never confirm the order.
    if (event.amountMinor !== null && event.amountMinor !== transaction.amountMinor) {
      await markEventRejected(
        eventRowId,
        `amount mismatch: event ${event.amountMinor.toString()} vs expected ${transaction.amountMinor.toString()}`,
      );

      await alertFinance(order.id, order.orderNumber, 'PAYMENT_AMOUNT_MISMATCH', {
        expectedMinor: transaction.amountMinor.toString(),
        receivedMinor: event.amountMinor.toString(),
      });

      return { accepted: false, duplicate: false, reason: 'amount mismatch' };
    }

    if (event.currency !== null && event.currency !== transaction.currency) {
      await markEventRejected(
        eventRowId,
        `currency mismatch: event ${event.currency} vs expected ${transaction.currency}`,
      );
      return { accepted: false, duplicate: false, reason: 'currency mismatch' };
    }

    // --- 4. Apply --------------------------------------------------------
    await prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: 'CAPTURED',
          providerPaymentId: event.providerPaymentId,
          capturedMinor: event.amountMinor ?? transaction.amountMinor,
          method: event.method,
          capturedAt: new Date(),
        },
      });

      await tx.order.update({
        where: { id: order.id },
        data: { paidMinor: { increment: event.amountMinor ?? transaction.amountMinor } },
      });

      await tx.paymentEvent.update({
        where: { id: eventRowId },
        data: {
          processingStatus: 'PROCESSED',
          processedAt: new Date(),
          orderId: order.id,
          paymentTransactionId: transaction.id,
        },
      });
    });

    // The only path to CONFIRMED. SYSTEM actor, because the authority is the
    // verified provider event, not any human.
    if (order.status === 'PENDING_PAYMENT') {
      await transitionOrder({
        orderId: order.id,
        to: 'CONFIRMED',
        actor: {
          userId: null,
          email: null,
          type: 'SYSTEM',
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        reason: 'Payment captured and verified',
        meta: { providerPaymentId: event.providerPaymentId, eventId: event.eventId },
      });
    }

    await recordAudit({
      action: AuditAction.PAYMENT_CAPTURED,
      resourceType: 'payment',
      resourceId: transaction.id,
      actorType: 'PROVIDER',
      after: {
        orderId: order.id,
        providerPaymentId: event.providerPaymentId,
        amountMinor: event.amountMinor,
      },
      correlationId: correlationId ?? null,
    });

    return { accepted: true, duplicate: false };
  }

  if (event.intent === 'PAYMENT_FAILED') {
    await prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: 'FAILED',
          providerPaymentId: event.providerPaymentId,
          failureCode: event.failureCode,
          failureMessage: event.failureMessage,
          failedAt: new Date(),
        },
      });

      await tx.paymentEvent.update({
        where: { id: eventRowId },
        data: {
          processingStatus: 'PROCESSED',
          processedAt: new Date(),
          orderId: order.id,
          paymentTransactionId: transaction.id,
        },
      });
    });

    // The order stays PENDING_PAYMENT so the customer can safely retry against
    // the SAME order. Cancelling here would strand their reserved stock.
    await enqueueNotification({
      eventKey: NotificationEvent.PAYMENT_FAILED,
      recipientEmail: (
        await prisma.customerProfile.findUniqueOrThrow({
          where: { id: order.customerProfileId },
          include: { user: { select: { email: true } } },
        })
      ).user.email,
      variables: {
        orderNumber: order.orderNumber,
        reason: event.failureMessage ?? 'The payment could not be completed.',
      },
      dedupeKey: `payment_failed:${event.eventId}`,
      relatedType: 'order',
      relatedId: order.id,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    await dispatchPendingNotifications();
    return { accepted: true, duplicate: false };
  }

  if (event.intent === 'REFUND_PROCESSED' && event.providerRefundId !== null) {
    await prisma.refund.updateMany({
      where: { providerRefundId: event.providerRefundId },
      data: {
        status: event.eventType === 'refund.failed' ? 'FAILED' : 'SUCCEEDED',
        completedAt: new Date(),
      },
    });

    await prisma.paymentEvent.update({
      where: { id: eventRowId },
      data: {
        processingStatus: 'PROCESSED',
        processedAt: new Date(),
        orderId: order.id,
        paymentTransactionId: transaction.id,
      },
    });

    return { accepted: true, duplicate: false };
  }

  await markEventRejected(eventRowId, 'event could not be applied');
  return { accepted: false, duplicate: false, reason: 'event could not be applied' };
}

async function markEventRejected(eventRowId: string, reason: string): Promise<void> {
  logger.error({ eventRowId, reason }, 'payment webhook rejected after verification');

  await prisma.paymentEvent.update({
    where: { id: eventRowId },
    data: {
      processingStatus: 'REJECTED',
      processingError: reason.slice(0, 1000),
      processedAt: new Date(),
    },
  });

  await recordAudit({
    action: AuditAction.WEBHOOK_REJECTED,
    resourceType: 'payment_event',
    resourceId: eventRowId,
    actorType: 'PROVIDER',
    after: { reason },
  });
}

/** A verified event we refused to apply is a security signal, not a footnote. */
async function alertFinance(
  orderId: string,
  orderNumber: string,
  code: string,
  detail: Record<string, string>,
): Promise<void> {
  const setting = await prisma.notificationSetting.findUnique({
    where: { eventKey: NotificationEvent.PAYMENT_FAILED },
  });

  const recipients = Array.isArray(setting?.internalRecipientsJson)
    ? (setting.internalRecipientsJson as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];

  if (recipients.length === 0) {
    logger.error(
      { orderId, orderNumber, code, ...detail },
      'payment discrepancy detected but no finance recipients are configured',
    );
    return;
  }

  for (const recipient of recipients) {
    await enqueueNotification({
      eventKey: NotificationEvent.PAYMENT_FAILED,
      recipientEmail: recipient,
      variables: { orderNumber, reason: `${code}: ${JSON.stringify(detail)}` },
      dedupeKey: `discrepancy:${orderId}:${code}`,
      relatedType: 'order',
      relatedId: orderId,
    });
  }

  await dispatchPendingNotifications();
}

/**
 * Re-query the provider and reconcile.
 *
 * The recovery path when a customer's browser timed out mid-redirect or a
 * webhook has not arrived. The provider is the authority; the client's belief
 * about what happened is not consulted.
 */
export async function reconcilePayment(
  paymentTransactionId: string,
): Promise<{ status: string; changed: boolean }> {
  const transaction = await prisma.paymentTransaction.findUnique({
    where: { id: paymentTransactionId },
    include: { order: true },
  });

  if (transaction === null) throw notFound('Payment');
  if (transaction.providerOrderId === null) {
    return { status: transaction.status, changed: false };
  }

  const { provider } = await loadActiveProvider();
  const remote = await provider.fetchPaymentStatus(transaction.providerOrderId);

  await prisma.paymentTransaction.update({
    where: { id: transaction.id },
    data: { reconciledAt: new Date() },
  });

  if (remote.status !== 'CAPTURED' || transaction.status === 'CAPTURED') {
    return { status: transaction.status, changed: false };
  }

  // The provider says captured and we did not know. The amount check applies
  // here exactly as it does on the webhook path.
  if (remote.amountMinor !== transaction.amountMinor) {
    logger.error(
      {
        paymentTransactionId,
        expected: transaction.amountMinor.toString(),
        received: remote.amountMinor.toString(),
      },
      'reconciliation found an amount mismatch; refusing to confirm',
    );

    await alertFinance(transaction.orderId, transaction.order.orderNumber, 'RECONCILE_AMOUNT_MISMATCH', {
      expectedMinor: transaction.amountMinor.toString(),
      receivedMinor: remote.amountMinor.toString(),
    });

    return { status: transaction.status, changed: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'CAPTURED',
        providerPaymentId: remote.providerPaymentId,
        capturedMinor: remote.amountMinor,
        method: remote.method,
        capturedAt: new Date(),
      },
    });

    await tx.order.update({
      where: { id: transaction.orderId },
      data: { paidMinor: { increment: remote.amountMinor } },
    });
  });

  if (transaction.order.status === 'PENDING_PAYMENT') {
    await transitionOrder({
      orderId: transaction.orderId,
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
      reason: 'Payment confirmed by reconciliation',
    });
  }

  return { status: 'CAPTURED', changed: true };
}

/** Read-only payment view for the order page while a webhook is in flight. */
export async function getPaymentStatusForOrder(
  orderId: string,
  customerProfileId: string,
): Promise<{ status: string; paid: boolean; orderStatus: string }> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerProfileId },
    include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  if (order === null) throw notFound('Order');

  const latest = order.payments[0] ?? null;

  return {
    status: latest?.status ?? 'NONE',
    // Derived from the order's settled money, which only a verified event
    // advances - never from what the browser reported.
    paid: order.paidMinor >= order.grandTotalMinor && order.grandTotalMinor > 0n,
    orderStatus: order.status,
  };
}

export type { PrismaTransaction };

/**
 * Test one saved connection's credentials and record the verdict on the row.
 *
 * Distinct from the environment-level test: an administrator who has just
 * pasted keys needs to know whether *those* keys work, and activation is
 * gated on the stored `lastTestStatus`. Testing the ambient provider instead
 * would let a broken connection be activated on the strength of a different
 * one's success.
 *
 * A failure is recorded, not thrown away - the Integrations page shows the
 * provider's own message, which is usually the fastest route to the fix.
 */
export async function testStoredConnection(
  connectionId: string,
): Promise<{ ok: boolean; mode: string | null; message: string }> {
  const connection = await prisma.paymentProviderConnection.findUnique({
    where: { id: connectionId },
  });

  if (connection === null) throw notFound('Payment connection');

  const decrypted = decryptSecret(connection.credentialsEnc, credentialAad(connection.id));
  const credentials = JSON.parse(decrypted) as ProviderCredentials;

  const webhookSecret =
    connection.webhookSecretEnc === null
      ? ''
      : decryptSecret(connection.webhookSecretEnc, credentialAad(connection.id));

  let result: { ok: boolean; mode: string | null; message: string };

  try {
    const provider = buildProvider(connection.provider, { ...credentials, webhookSecret });
    const outcome = await provider.testConnection();
    result = { ok: outcome.ok, mode: outcome.mode, message: outcome.message };
  } catch (error) {
    // Includes the unimplemented-Stripe case, which is a legitimate answer to
    // "do these credentials work" rather than a server fault.
    result = {
      ok: false,
      mode: null,
      message: error instanceof Error ? error.message : 'The connection test failed.',
    };
  }

  await prisma.paymentProviderConnection.update({
    where: { id: connectionId },
    data: {
      lastTestedAt: new Date(),
      lastTestStatus: result.ok ? 'OK' : 'FAILED',
      lastTestMessage: result.message.slice(0, 500),
      // A connection that has stopped working must not keep taking payments.
      ...(result.ok ? {} : { isActive: false }),
    },
  });

  return result;
}
