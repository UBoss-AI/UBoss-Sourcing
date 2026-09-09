/**
 * Sending an order to the business's ERP.
 *
 * The sibling of `erp-order.service.ts`, and the difference between them is
 * only where the connection is configured. That one reads the legacy path - an
 * `integration_connections` row named by `ERP_ORDER_CONNECTION_NAME`, which
 * needs a deployment to change. This one reads `erp_connections`, which an
 * administrator manages under Settings -> ERP.
 *
 * `resolveErpConnection` decides which applies: the Settings connection when
 * one is ACTIVE, and the legacy env-var path otherwise. An installation with
 * neither takes orders exactly as it did before this file existed - that is a
 * supported state, not a broken one.
 *
 * **The state this module exists for is Paid - ERP Pending.** The money has
 * moved, the platform order is real, and the customer's ERP has not taken it.
 * Every wrong answer is tempting:
 *
 *   - Failing the order tells the customer it did not happen, which is false,
 *     and invites them to order again - now paying twice.
 *   - Refunding throws away an order the ERP would have taken thirty seconds
 *     later, and a refund is slow, visible and alarming.
 *   - Retrying with a fresh key risks two ERP orders: two deliveries and two
 *     stock movements for one payment.
 *
 * So the order stays PAID, an `ErpOrderPush` row holds the retry state, and
 * every attempt sends the SAME idempotency key. Three guards make a duplicate
 * structurally impossible rather than merely unlikely:
 *
 *   1. `unique(erp_order_pushes.orderId)` - one push row per order, ever.
 *   2. `unique(integration_events.idempotencyKey)` - one ledger row per logical
 *      operation, so a redelivered webhook collides instead of starting a
 *      second push.
 *   3. The same key in the header on every attempt, so an ERP that honours it
 *      de-duplicates on its own side too - and one that answers a replay with
 *      409 is read as success, not as a failure to retry.
 *
 * "Paid - ERP Pending" is a DERIVED state, not a new `OrderStatus`. The ten
 * order statuses are fixed by the SOP and adding an eleventh would touch every
 * screen, report and state-machine branch in the system. The order is CONFIRMED
 * and its push row is PENDING or FAILED; `erpSyncStateFor` is what turns that
 * pair into the words a customer reads.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { notFound } from '../../domain/errors.js';
import { carriesTraffic } from '../../domain/erp-connection-state.js';
import { newId } from '../../infra/ids.js';
import { loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  ErpCallError,
  callErp,
  redactForLedger,
  resolveEndpointUrl,
  safeErrorMessage,
} from './erp-client.js';
import { callContextFor, ensureOAuthToken, suspendAfterFailures } from './erp-connection.service.js';
import { parseFieldMapping, readPath, coerceString } from './erp-field-mapping.js';
import {
  claimEvent,
  recordEventFailure,
  recordEventSuccess,
  releaseEvent,
} from './integration-event.service.js';

type ConnectionRow = Prisma.ErpConnectionGetPayload<Record<string, never>>;

// ---------------------------------------------------------------------------
// Which ERP, if any
// ---------------------------------------------------------------------------

/**
 * The connection orders are pushed to, or null.
 *
 * Null is an ordinary, supported answer and every caller handles it: an
 * installation with no ERP takes orders exactly as it always did.
 *
 * `activateConnection` allows only one ACTIVE row at a time, so the ordering
 * here is belt and braces rather than a tie-break - but it is deterministic, so
 * a row that slipped past that rule would at least send every order to the same
 * place rather than to whichever the database felt like returning.
 */
export async function resolveErpConnection(): Promise<ConnectionRow | null> {
  if (!env.FEATURE_ERP_INTEGRATION) return null;

  const row = await prisma.erpConnection.findFirst({
    where: { status: 'ACTIVE', orderPushEnabled: true, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });

  if (row === null) return null;

  // Belt and braces: the WHERE clause already says ACTIVE, and this says the
  // same thing through the state machine, so "what does ACTIVE mean" has one
  // answer even if the query is edited later.
  return carriesTraffic(row.status) ? row : null;
}

// ---------------------------------------------------------------------------
// The payload
// ---------------------------------------------------------------------------

/**
 * The order as this system describes it, before the customer's mapping is
 * applied.
 *
 * Deliberately the same shape as the operator push builds, because it is the
 * shape documented in PROJECT-GUIDE.md and a deployment may already have a
 * translating proxy that reads it. Money is a STRING throughout: a JSON number
 * is a double, and putting a total through one is how a rounding error reaches
 * an invoice.
 */
async function buildOrderPayload(orderId: string): Promise<Record<string, unknown>> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      customerProfile: {
        select: {
          id: true,
          fullName: true,
          organization: true,
          customerCode: true,
          user: { select: { email: true } },
        },
      },
      occurrence: { select: { id: true, scheduleId: true, plannedRunAt: true } },
      payments: {
        where: { status: 'CAPTURED' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { providerPaymentId: true, provider: true, amountMinor: true, currency: true },
      },
    },
  });

  if (order === null) throw notFound('Order');

  const payment = order.payments[0] ?? null;

  return {
    external_order_id: order.id,
    order_number: order.orderNumber,
    placed_at: order.placedAt?.toISOString() ?? order.createdAt.toISOString(),
    source: order.source,
    currency: order.currency,

    totals: {
      subtotal_minor: order.subtotalMinor.toString(),
      discount_minor: order.discountMinor.toString(),
      tax_minor: order.taxMinor.toString(),
      shipping_minor: order.shippingMinor.toString(),
      grand_total_minor: order.grandTotalMinor.toString(),
    },

    customer: {
      external_customer_id: order.customerProfile.id,
      erp_customer_code: order.customerProfile.customerCode,
      name: order.customerProfile.fullName,
      company: order.customerProfile.organization,
      email: order.customerProfile.user.email,
    },

    // The ERP's side of the reconciliation. An order that arrives with the
    // payment reference on it can be matched to the money without anybody
    // exporting a spreadsheet, which is the first thing a finance team asks
    // for.
    payment:
      payment === null
        ? null
        : {
            provider: payment.provider,
            reference: payment.providerPaymentId,
            amount_minor: payment.amountMinor.toString(),
            currency: payment.currency,
          },

    shipping_address: order.shippingAddressJson,
    billing_address: order.billingAddressJson,
    shipping_method: order.shippingMethodCode,

    lines: order.items.map((item) => ({
      sku: item.skuSnapshot,
      name: item.nameSnapshot,
      variant: item.variantNameSnapshot,
      quantity: item.quantity,
      unit_price_minor: item.unitPriceMinor.toString(),
      tax_amount_minor: item.taxAmountMinor.toString(),
      line_total_minor: item.lineTotalMinor.toString(),
    })),

    schedule:
      order.occurrence === null
        ? null
        : {
            schedule_id: order.occurrence.scheduleId,
            occurrence_id: order.occurrence.id,
            due_at: order.occurrence.plannedRunAt.toISOString(),
          },
  };
}

/**
 * Read the ERP's identifier for the order it just created.
 *
 * Through the customer's own field mapping, because "where is the order id in
 * the response" is the question ERPs disagree about more than any other. A
 * mapping with no `erpOrderId` falls back to the handful of names that are
 * nearly universal - which is a convenience, not a guess: the push still
 * succeeds without a reference, it is just harder to reconcile afterwards.
 */
function readErpOrderReference(
  connection: ConnectionRow,
  response: unknown,
): string | null {
  const mapping = parseFieldMapping(connection.fieldMappingJson);
  const path = mapping?.fields.erpOrderId;

  if (path !== undefined) {
    const value = coerceString(readPath(response, path));
    if (value !== null) return value.slice(0, 191);
  }

  for (const candidate of ['id', 'order_id', 'orderId', 'orderNumber', 'documentNumber', 'data.id']) {
    const value = coerceString(readPath(response, candidate));
    if (value !== null) return value.slice(0, 191);
  }

  return null;
}

// ---------------------------------------------------------------------------
// The push
// ---------------------------------------------------------------------------

export interface ErpPushResult {
  status: 'SUCCEEDED' | 'DEFERRED' | 'ABANDONED' | 'SKIPPED';
  erpOrderReference: string | null;
  message: string | null;
  alreadyPushed: boolean;
}

/**
 * Send one order to the configured ERP.
 *
 * Never throws for an ERP failure; it returns a status. The caller is usually a
 * webhook handler or a worker holding a paid order, and an exception there
 * would be turned into "this order failed" - which is exactly the wrong thing
 * to tell somebody whose money has already gone.
 *
 * Safe to call repeatedly. The first call creates the ledger row; every later
 * one finds it, and a row that already carries a reference returns without
 * touching the network.
 */
export async function pushOrderToErpConnection(input: {
  orderId: string;
  occurrenceId?: string | null;
  /**
   * The SAME value on every attempt at this order. Derived from the order, not
   * generated per call - that is the entire point, and it is what a retry
   * recomputes rather than mints afresh.
   */
  idempotencyKey: string;
  correlationId?: string | null;
}): Promise<ErpPushResult> {
  const correlationId = input.correlationId ?? newId();
  const log = loggerFor(correlationId, { orderId: input.orderId });

  const connection = await resolveErpConnection();

  if (connection === null) {
    // No ERP configured under Settings. Not a failure, and no ledger row:
    // recording a push that was never meant to happen would leave every order
    // looking half-finished for ever.
    return { status: 'SKIPPED', erpOrderReference: null, message: null, alreadyPushed: false };
  }

  const endpoint = connection.orderCreateEndpoint;
  if (endpoint === null || endpoint === '') {
    return {
      status: 'SKIPPED',
      erpOrderReference: null,
      message: null,
      alreadyPushed: false,
    };
  }

  // --- The ledger row. Unique on orderId, which is the duplicate guard. ---
  const pushId = newId();

  await prisma.erpOrderPush.createMany({
    data: [
      {
        id: pushId,
        orderId: input.orderId,
        occurrenceId: input.occurrenceId ?? null,
        erpConnectionId: connection.id,
        idempotencyKey: input.idempotencyKey,
        status: 'PENDING',
      },
    ],
    skipDuplicates: true,
  });

  const push = await prisma.erpOrderPush.findUnique({ where: { orderId: input.orderId } });

  if (push === null) {
    // Cannot happen: the insert either created the row or collided with one.
    // Reported rather than assumed away.
    log.error('the ERP push ledger row vanished immediately after being written');
    return {
      status: 'DEFERRED',
      erpOrderReference: null,
      message: 'The record of this hand-off could not be read back.',
      alreadyPushed: false,
    };
  }

  // The single most important early return in this file: what makes a
  // redelivered webhook or a re-run job harmless.
  if (push.status === 'SUCCEEDED') {
    log.info({ erpOrderReference: push.erpOrderReference }, 'order already reached the ERP');
    return {
      status: 'SUCCEEDED',
      erpOrderReference: push.erpOrderReference,
      message: null,
      alreadyPushed: true,
    };
  }

  if (push.status === 'ABANDONED') {
    return {
      status: 'ABANDONED',
      erpOrderReference: null,
      message: push.lastErrorMessage,
      alreadyPushed: false,
    };
  }

  // --- Claim the operation ------------------------------------------------
  const claim = await claimEvent({
    connectionId: connection.id,
    eventType: 'ORDER_PUSH',
    correlationId,
    idempotencyKey: input.idempotencyKey,
    orderId: input.orderId,
  });

  if (claim.outcome === 'ALREADY_SUCCEEDED') {
    return {
      status: 'SUCCEEDED',
      erpOrderReference: claim.erpOrderReference,
      message: null,
      alreadyPushed: true,
    };
  }

  if (claim.outcome === 'IN_FLIGHT') {
    // Another worker holds it and will finish. Reported as deferred rather than
    // failed: nothing is wrong, and the caller should not retry on top of it.
    return {
      status: 'DEFERRED',
      erpOrderReference: null,
      message: 'This order is already being sent.',
      alreadyPushed: false,
    };
  }

  if (claim.outcome === 'ABANDONED') {
    return {
      status: 'ABANDONED',
      erpOrderReference: null,
      message: claim.message,
      alreadyPushed: false,
    };
  }

  const { eventId, attempt } = claim;

  // --- Send ---------------------------------------------------------------
  let payload: Record<string, unknown>;
  try {
    payload = await buildOrderPayload(input.orderId);
  } catch (error) {
    await releaseEvent(eventId, safeErrorMessage(error));
    throw error;
  }

  try {
    const oauthToken = await ensureOAuthToken(connection);
    const url = resolveEndpointUrl(connection.baseUrl, endpoint, 'endpoints.orderCreate');

    const methods = (connection.methodsJson ?? {}) as Record<string, unknown>;
    const configured = methods['orderCreate'];
    const method =
      configured === 'POST' || configured === 'PUT' || configured === 'PATCH' ? configured : 'POST';

    const result = await callErp(callContextFor(connection), url, {
      method,
      body: payload,
      // The same key on every attempt. This is the point.
      idempotencyKey: input.idempotencyKey,
      idempotencyHeader: connection.idempotencyHeader,
      oauthAccessToken: oauthToken,
    });

    const erpOrderReference = readErpOrderReference(connection, result.data);

    await prisma.$transaction(async (tx) => {
      await tx.erpOrderPush.update({
        where: { id: push.id },
        data: {
          status: 'SUCCEEDED',
          erpOrderReference,
          attemptCount: attempt,
          lastAttemptAt: new Date(),
          nextRetryAt: null,
          succeededAt: new Date(),
          lastErrorCode: null,
          lastErrorMessage: null,
          requestJson: redactForLedger(payload) as Prisma.InputJsonValue,
          responseJson: redactForLedger(result.data) as Prisma.InputJsonValue,
        },
      });

      if (input.occurrenceId !== null && input.occurrenceId !== undefined) {
        await tx.scheduleOccurrence.update({
          where: { id: input.occurrenceId },
          data: { erpOrderReference, erpPushStatus: 'SUCCEEDED' },
        });
      }

      await recordAudit(
        {
          action: AuditAction.ERP_ORDER_PUSHED,
          resourceType: 'order',
          resourceId: input.orderId,
          actorType: 'SYSTEM',
          after: {
            erpOrderReference,
            attempt,
            connectionId: connection.id,
            connectionName: connection.name,
          },
          correlationId,
        },
        tx,
      );
    });

    await recordEventSuccess({
      eventId,
      httpStatus: result.status,
      durationMs: result.durationMs,
      erpOrderReference,
      response: result.data,
    });

    await prisma.erpConnection.update({
      where: { id: connection.id },
      data: { consecutiveFailures: 0, circuitOpenedAt: null, lastSyncSuccessAt: new Date() },
    });

    log.info({ erpOrderReference, attempt }, 'order pushed to the customer ERP');

    return { status: 'SUCCEEDED', erpOrderReference, message: null, alreadyPushed: false };
  } catch (error) {
    const erpError = error instanceof ErpCallError ? error : null;

    // --- 409: the ERP already has it ------------------------------------
    //
    // An ERP that honours the idempotency header answers a replay with 409 and
    // the reference of the order it already made. That is success. Treating it
    // as a conflict would retry for hours against an ERP that took the order on
    // the first attempt - and, worse, would eventually abandon an order the
    // warehouse is already picking.
    if (erpError?.httpStatus === 409) {
      const erpOrderReference = readErpOrderReference(connection, erpError.responseSnippet);

      log.info(
        { erpOrderReference },
        'the customer ERP reports it already has this order; treating the push as complete',
      );

      await prisma.$transaction(async (tx) => {
        await tx.erpOrderPush.update({
          where: { id: push.id },
          data: {
            status: 'SUCCEEDED',
            erpOrderReference,
            attemptCount: attempt,
            lastAttemptAt: new Date(),
            nextRetryAt: null,
            succeededAt: new Date(),
            responseJson: (erpError.responseSnippet ?? null) as Prisma.InputJsonValue,
          },
        });

        if (input.occurrenceId !== null && input.occurrenceId !== undefined) {
          await tx.scheduleOccurrence.update({
            where: { id: input.occurrenceId },
            data: { erpOrderReference, erpPushStatus: 'SUCCEEDED' },
          });
        }
      });

      await recordEventSuccess({
        eventId,
        httpStatus: 409,
        erpOrderReference,
        response: erpError.responseSnippet,
      });

      return { status: 'SUCCEEDED', erpOrderReference, message: null, alreadyPushed: true };
    }

    // --- Everything else --------------------------------------------------
    //
    // The order is PAID. That is why the ceiling here is the OPERATOR's larger
    // one rather than the customer-ERP default: giving up early on a stock poll
    // costs an hour of stale figures, and giving up early here leaves money
    // taken for an order the warehouse cannot see.
    const outcome = await recordEventFailure({
      eventId,
      attempt,
      error,
      maxAttempts: env.ERP_ORDER_MAX_ATTEMPTS,
    });

    const message = outcome.message;
    const errorCode = erpError?.errorCode ?? 'UNKNOWN';

    // A rate limit is the customer's ERP working correctly, so it does not
    // count towards taking their connection out of service.
    if (erpError?.kind !== 'RATE_LIMIT') {
      await suspendAfterFailures(connection.id, message);
    }

    const terminal = outcome.status === 'FAILED' || outcome.status === 'ABANDONED';

    await prisma.$transaction(async (tx) => {
      await tx.erpOrderPush.update({
        where: { id: push.id },
        data: {
          // ABANDONED means nothing will retry on its own. A FAILED push with a
          // retry booked stays FAILED, which is what the sweep looks for.
          status: outcome.status === 'ABANDONED' ? 'ABANDONED' : 'FAILED',
          attemptCount: attempt,
          lastAttemptAt: new Date(),
          nextRetryAt: outcome.nextRetryAt,
          lastErrorCode: errorCode,
          lastErrorMessage: message.slice(0, 1000),
          requestJson: redactForLedger(payload) as Prisma.InputJsonValue,
          responseJson: (erpError?.responseSnippet ?? null) as Prisma.InputJsonValue,
        },
      });

      if (input.occurrenceId !== null && input.occurrenceId !== undefined) {
        await tx.scheduleOccurrence.update({
          where: { id: input.occurrenceId },
          data: { erpPushStatus: outcome.status === 'ABANDONED' ? 'ABANDONED' : 'FAILED' },
        });
      }

      await recordAudit(
        {
          action: terminal
            ? AuditAction.ERP_ORDER_PUSH_ABANDONED
            : AuditAction.ERP_ORDER_PUSH_DEFERRED,
          resourceType: 'order',
          resourceId: input.orderId,
          actorType: 'SYSTEM',
          after: {
            attempt,
            connectionId: connection.id,
            nextRetryAt: outcome.nextRetryAt?.toISOString() ?? null,
            message: message.slice(0, 500),
          },
          correlationId,
        },
        tx,
      );
    });

    log.warn(
      { attempt, errorCode, status: outcome.status },
      'order could not be sent to the customer ERP; it is paid and will be retried',
    );

    return {
      status: terminal ? 'ABANDONED' : 'DEFERRED',
      erpOrderReference: null,
      message,
      alreadyPushed: false,
    };
  }
}

// ---------------------------------------------------------------------------
// "Paid - ERP Pending", as a customer reads it
// ---------------------------------------------------------------------------

export type ErpSyncState =
  /** No ERP is connected. The order is simply an order. */
  | 'NOT_APPLICABLE'
  | 'PENDING'
  /** Paid, and the ERP has not taken it yet. Retrying; no action needed. */
  | 'PAID_ERP_PENDING'
  | 'SYNCED'
  /** Retries exhausted or refused outright. A person has to look. */
  | 'FAILED';

export interface ErpSyncStatusView {
  state: ErpSyncState;
  erpOrderReference: string | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  nextRetryAt: string | null;
  /** Safe for a customer to read. Never a provider body. */
  message: string | null;
  /** Whether the customer is offered a Retry button. */
  retryable: boolean;
}

/**
 * Where an order stands with the ERP.
 *
 * This is the derived "Paid - ERP Pending" state. It is computed rather than
 * stored as an eleventh `OrderStatus` because the ten statuses are fixed by the
 * SOP: an order that has been paid for IS confirmed, whatever the warehouse
 * system has managed to acknowledge, and telling a customer otherwise because
 * of a hiccup in a back-office system would be a lie about their money.
 */
export async function erpSyncStateFor(orderId: string): Promise<ErpSyncStatusView> {
  const push = await prisma.erpOrderPush.findUnique({ where: { orderId } });

  const none: ErpSyncStatusView = {
    state: 'NOT_APPLICABLE',
    erpOrderReference: null,
    attemptCount: 0,
    lastAttemptAt: null,
    nextRetryAt: null,
    message: null,
    retryable: false,
  };

  if (push === null) return none;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true },
  });

  if (order === null) return none;

  const paid = order.status !== 'DRAFT' && order.status !== 'PENDING_PAYMENT';

  const state: ErpSyncState =
    push.status === 'SUCCEEDED'
      ? 'SYNCED'
      : push.status === 'ABANDONED'
        ? 'FAILED'
        : paid
          ? 'PAID_ERP_PENDING'
          : 'PENDING';

  return {
    state,
    erpOrderReference: push.erpOrderReference,
    attemptCount: push.attemptCount,
    lastAttemptAt: push.lastAttemptAt?.toISOString() ?? null,
    nextRetryAt: push.nextRetryAt?.toISOString() ?? null,
    message: push.lastErrorMessage,
    retryable: push.status === 'ABANDONED' || push.status === 'FAILED',
  };
}

// ---------------------------------------------------------------------------
// Retrying
// ---------------------------------------------------------------------------

/**
 * Pushes due for another attempt against a customer's ERP.
 *
 * The exit from Paid - ERP Pending. Every row this touches is an order somebody
 * has already paid for and cannot yet be dispatched, which is why it runs on
 * the ordinary maintenance beat rather than nightly.
 */
export async function retryDueErpConnectionPushes(limit = 25): Promise<{
  attempted: number;
  succeeded: number;
  stillPending: number;
}> {
  if (!env.FEATURE_ERP_INTEGRATION) {
    return { attempted: 0, succeeded: 0, stillPending: 0 };
  }

  const due = await prisma.erpOrderPush.findMany({
    where: {
      status: 'FAILED',
      erpConnectionId: { not: null },
      nextRetryAt: { lte: new Date() },
    },
    orderBy: { nextRetryAt: 'asc' },
    take: limit,
    select: {
      orderId: true,
      occurrenceId: true,
      idempotencyKey: true,
    },
  });

  let succeeded = 0;
  let stillPending = 0;

  for (const row of due) {
    // The SAME key the first attempt used. Recomputing or regenerating it here
    // would be the bug this whole module exists to prevent.
    const result = await pushOrderToErpConnection({
      orderId: row.orderId,
      occurrenceId: row.occurrenceId,
      idempotencyKey: row.idempotencyKey,
    });

    if (result.status === 'SUCCEEDED') succeeded += 1;
    else if (result.status === 'DEFERRED') stillPending += 1;
  }

  return { attempted: due.length, succeeded, stillPending };
}

/**
 * Retry one push at the customer's request.
 *
 * For a push that has been abandoned, where the customer has since fixed
 * whatever the ERP was objecting to. The idempotency key is deliberately NOT
 * regenerated: if the earlier attempt did reach the ERP despite reporting
 * failure, this has to collide with it rather than create a second order.
 */
export async function retryErpConnectionPush(input: {
  orderId: string;
  correlationId?: string | null;
}): Promise<ErpPushResult> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    select: { id: true },
  });

  if (order === null) throw notFound('That order');

  const push = await prisma.erpOrderPush.findUnique({ where: { orderId: input.orderId } });
  if (push === null) throw notFound('That hand-off');

  if (push.status === 'SUCCEEDED') {
    return {
      status: 'SUCCEEDED',
      erpOrderReference: push.erpOrderReference,
      message: null,
      alreadyPushed: true,
    };
  }

  // Reopened so the push is attemptable again, with the attempt count reset:
  // the customer is asserting the cause is fixed, and the old count describes a
  // configuration that no longer exists.
  await prisma.erpOrderPush.update({
    where: { id: push.id },
    data: { status: 'PENDING', attemptCount: 0, nextRetryAt: null },
  });

  // The ledger event has to be reopened too, or the claim below would answer
  // ABANDONED and nothing would be sent.
  await prisma.integrationEvent.updateMany({
    where: { idempotencyKey: push.idempotencyKey },
    data: { status: 'RETRY_SCHEDULED', attemptCount: 0, nextRetryAt: new Date() },
  });

  return pushOrderToErpConnection({
    orderId: input.orderId,
    occurrenceId: push.occurrenceId,
    idempotencyKey: push.idempotencyKey,
    ...(input.correlationId === undefined ? {} : { correlationId: input.correlationId }),
  });
}
