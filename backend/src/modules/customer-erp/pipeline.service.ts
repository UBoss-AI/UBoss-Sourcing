/**
 * What actually happens to a buyer's ERP when something happens here.
 *
 * The outbox (`event.service.ts`) knows how to queue, claim, retry and give up.
 * The connectors know one system's dialect each. This file is the part in
 * between: what a confirmed order MEANS for somebody's SAP, which facts to
 * gather, what to do with the answer, and - the part most easily got wrong -
 * when stock is allowed to move.
 *
 * THE ORDER OF THINGS, WHICH IS THE POINT OF THE WHOLE FEATURE
 *
 *   1. An order is confirmed here. A PURCHASE ORDER is raised there, and the
 *      quantity becomes ON ORDER. **On-hand stock does not move.** The buyer
 *      has committed to buy something; nothing has arrived.
 *   2. It ships. The shipment status and tracking are synced. Still nothing on
 *      hand - a crate on a lorry is not stock.
 *   3. It is delivered, or the buyer's own ERP posts a goods receipt. NOW
 *      on-hand may move, and only if the buyer's policy says to write it
 *      automatically rather than ask.
 *   4. An invoice is issued: number, amounts, tax, due date, document link.
 *   5. It is paid: the provider's reference and status, and nothing whatsoever
 *      about the instrument.
 *
 * Getting step 1 wrong - incrementing on-hand when an order is placed - is the
 * classic failure of this kind of integration, and it is not a small one. A
 * buyer whose ERP believes stock arrived the moment it was ordered will stop
 * reordering, run out, and discover why during a procedure.
 *
 * INSTANT BUY AND SCHEDULED DELIVERIES USE THIS SAME PATH
 *
 * Both reach `dispatchOrderConfirmed`, because both end with an order becoming
 * CONFIRMED and there is exactly one place that happens - `transitionOrder`.
 * A schedule occurrence gets its own link row and its own events, because each
 * delivery is receipted separately, and the occurrence id rides along so an ERP
 * that wants to group a subscription's deliveries can.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { ErrorCode, conflict } from '../../domain/errors.js';
import { carriesTraffic } from '../../domain/customer-erp-state.js';
import { newId } from '../../infra/ids.js';
import { loggerFor } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { NotificationEvent, enqueueNotification } from '../notifications/notification.service.js';
import { recordOrgAudit, SYSTEM_ACTOR } from './audit.service.js';
import { loadConnectorContext } from './connectors/index.js';
import type {
  GoodsReceiptPayload,
  InboundEvent,
  InvoicePayload,
  OutboundPayload,
  PaymentReferencePayload,
  PurchaseOrderLine,
  PurchaseOrderPayload,
  ShipmentPayload,
} from './connectors/types.js';
import {
  claimDueEvents,
  deferEvent,
  enqueueEvent,
  recordFailure,
  recordSkip,
  recordSuccess,
  type ClaimedEvent,
  type EventTypeName,
} from './event.service.js';
import { ErpCallError, safeErrorMessage } from './http.js';

/**
 * How long an event waits when the CONNECTION rather than the event is the
 * problem - paused, waiting on somebody, out of service.
 *
 * Fifteen minutes. Long enough that a fortnight's pause costs about a thousand
 * cheap no-op checks rather than a hundred thousand, short enough that
 * resuming a connection feels immediate.
 */
const CONNECTION_DEFER_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// Which connections does an order belong to?
// ---------------------------------------------------------------------------

/**
 * The ACTIVE connections of the organisation that placed this order.
 *
 * Plural, deliberately. A buyer mid-migration may legitimately run SAP and
 * monday at once, and both should see the purchase order. Each gets its own
 * event with its own idempotency key, so one failing has no effect on the
 * other.
 *
 * An order whose customer is in no organisation - every customer, on an
 * installation where nobody has opened the integrations area - resolves to an
 * empty list and nothing else in this file runs. That is the no-op path and it
 * costs one indexed query.
 */
async function activeConnectionsForOrder(
  orderId: string,
): Promise<{ connectionId: string; organizationId: string }[]> {
  if (!env.FEATURE_CUSTOMER_ERP) return [];

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerProfileId: true },
  });

  if (order === null) return [];

  const membership = await prisma.buyerOrganizationMember.findUnique({
    where: { customerProfileId: order.customerProfileId },
    select: { organizationId: true },
  });

  if (membership === null) return [];

  const connections = await prisma.customerErpConnection.findMany({
    where: { organizationId: membership.organizationId, state: 'ACTIVE', deletedAt: null },
    select: { id: true, organizationId: true },
  });

  return connections.map((row) => ({
    connectionId: row.id,
    organizationId: row.organizationId,
  }));
}

// ---------------------------------------------------------------------------
// The five things that can happen
// ---------------------------------------------------------------------------

/**
 * An order was confirmed. Raise the purchase order.
 *
 * Called from `transitionOrder`, after the transaction commits - so an ERP that
 * is slow, refusing or switched off cannot roll back an order this platform has
 * already confirmed and taken money for. The event is queued; the call happens
 * in a worker.
 *
 * Never throws. The caller is a status transition holding a paid order, and an
 * exception there would be caught and turned into "this order failed", which is
 * exactly the wrong thing to tell somebody whose money has gone.
 */
export async function dispatchOrderConfirmed(
  orderId: string,
  correlationId: string,
): Promise<void> {
  await queueForOrder(orderId, 'PURCHASE_ORDER_CREATE', correlationId, (policy) =>
    policy.sendPurchaseOrders,
  );
}

/** It shipped. Sync the carrier and tracking. */
export async function dispatchOrderShipped(
  orderId: string,
  correlationId: string,
): Promise<void> {
  await queueForOrder(orderId, 'SHIPMENT_STATUS', correlationId, (policy) =>
    policy.sendShipmentStatus,
  );
}

/**
 * It was delivered.
 *
 * Whether this becomes a goods receipt depends on the buyer's policy.
 * `receiptOnPlatformDelivery` defaults to FALSE and that is the conservative
 * direction: a buyer whose warehouse scans everything in wants their own goods
 * receipt to be what moves their stock, and a platform "delivered" status that
 * moved it before the crate was opened would be worse than useless.
 *
 * The event is queued either way, and skipped with a reason where the policy
 * says no - because "nothing happened, and here is why" is a far better answer
 * than silence.
 */
export async function dispatchOrderDelivered(
  orderId: string,
  correlationId: string,
): Promise<void> {
  await queueForOrder(orderId, 'GOODS_RECEIPT', correlationId, (policy) =>
    policy.sendGoodsReceipts,
  );
}

/** The order was cancelled. Tell the ERP so its commitment is released. */
export async function dispatchOrderCancelled(
  orderId: string,
  correlationId: string,
): Promise<void> {
  await queueForOrder(orderId, 'PURCHASE_ORDER_UPDATE', correlationId, (policy) =>
    policy.sendPurchaseOrders,
  );
}

/** An invoice was issued. */
export async function dispatchInvoiceIssued(
  invoiceId: string,
  correlationId: string,
): Promise<void> {
  if (!env.FEATURE_CUSTOMER_ERP) return;

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { id: true, orderId: true },
  });

  if (invoice === null) return;

  const connections = await activeConnectionsForOrder(invoice.orderId);

  for (const target of connections) {
    const policy = await policyFor(target.connectionId);
    if (!policy.sendInvoices) continue;

    await enqueueEvent({
      connectionId: target.connectionId,
      organizationId: target.organizationId,
      eventType: 'INVOICE_SYNC',
      subject: invoice.id,
      correlationId,
      orderId: invoice.orderId,
      invoiceId: invoice.id,
    }).catch((error: unknown) => {
      loggerFor(correlationId, { invoiceId }).error(
        { err: error },
        'could not queue an invoice for a buyer ERP',
      );
    });
  }
}

/**
 * A payment settled.
 *
 * Sends the provider's REFERENCE and status. Nothing about the instrument
 * crosses this boundary - not a card number, not a last four, not a token, not
 * a bank detail. Handing an instrument to somebody else's ERP would move their
 * system into PCI scope on our say-so, and their accounts payable needs a
 * reference to reconcile against, which is all this is.
 */
export async function dispatchPaymentSettled(
  orderId: string,
  correlationId: string,
): Promise<void> {
  await queueForOrder(orderId, 'PAYMENT_REFERENCE', correlationId, (policy) =>
    policy.sendPaymentReferences,
  );
}

interface PolicyShape {
  sendPurchaseOrders: boolean;
  sendShipmentStatus: boolean;
  sendGoodsReceipts: boolean;
  sendInvoices: boolean;
  sendPaymentReferences: boolean;
  syncInventory: boolean;
  inventoryWriteMode: 'AUTOMATIC' | 'APPROVAL_REQUIRED';
  receiptOnPlatformDelivery: boolean;
  approvalThresholdMinor: bigint | null;
  approvalCurrency: string | null;
  approvalExpiryHours: number;
  mode: 'INBOUND' | 'OUTBOUND' | 'BIDIRECTIONAL';
}

/** A connection's policy, with the safe defaults for one that has none yet. */
async function policyFor(connectionId: string): Promise<PolicyShape> {
  const row = await prisma.customerErpSyncPolicy.findUnique({ where: { connectionId } });

  if (row === null) {
    // No policy row. Everything off except purchase orders, and stock writes
    // requiring a person - which is the posture a buyer who has not answered
    // the questions should be held to.
    return {
      sendPurchaseOrders: true,
      sendShipmentStatus: false,
      sendGoodsReceipts: false,
      sendInvoices: false,
      sendPaymentReferences: false,
      syncInventory: false,
      inventoryWriteMode: 'APPROVAL_REQUIRED',
      receiptOnPlatformDelivery: false,
      approvalThresholdMinor: null,
      approvalCurrency: null,
      approvalExpiryHours: 72,
      mode: 'OUTBOUND',
    };
  }

  return {
    sendPurchaseOrders: row.sendPurchaseOrders,
    sendShipmentStatus: row.sendShipmentStatus,
    sendGoodsReceipts: row.sendGoodsReceipts,
    sendInvoices: row.sendInvoices,
    sendPaymentReferences: row.sendPaymentReferences,
    syncInventory: row.syncInventory,
    inventoryWriteMode: row.inventoryWriteMode,
    receiptOnPlatformDelivery: row.receiptOnPlatformDelivery,
    approvalThresholdMinor: row.approvalThresholdMinor,
    approvalCurrency: row.approvalCurrency,
    approvalExpiryHours: row.approvalExpiryHours,
    mode: row.mode,
  };
}

/**
 * Queue one event type for every active connection behind an order.
 *
 * `subject` is the order id and the event type is part of the key, so the same
 * order produces one purchase-order event, one shipment event and one goods
 * receipt - and calling this twice for the same thing produces nothing the
 * second time, which is what makes every caller safe to retry.
 */
async function queueForOrder(
  orderId: string,
  eventType: EventTypeName,
  correlationId: string,
  wanted: (policy: PolicyShape) => boolean,
): Promise<void> {
  if (!env.FEATURE_CUSTOMER_ERP) return;

  const log = loggerFor(correlationId, { orderId, eventType });

  try {
    const connections = await activeConnectionsForOrder(orderId);
    if (connections.length === 0) return;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { scheduleOccurrenceId: true },
    });

    for (const target of connections) {
      const policy = await policyFor(target.connectionId);

      // The buyer switched this off. No event, because an event nobody asked
      // for is noise in a log they are meant to be able to read.
      if (!wanted(policy)) continue;

      // An INBOUND-only connection reads their ERP and never writes to it.
      if (policy.mode === 'INBOUND') continue;

      await enqueueEvent({
        connectionId: target.connectionId,
        organizationId: target.organizationId,
        eventType,
        subject: orderId,
        correlationId,
        orderId,
        occurrenceId: order?.scheduleOccurrenceId ?? null,
      });
    }
  } catch (error) {
    // Swallowed on purpose. Every caller of this is holding a confirmed order
    // or a settled payment, and neither may fail because a queue insert did.
    // The order stands; the ERP hand-off is visibly missing, which is what the
    // dashboard's pending count is for.
    log.error({ err: error }, 'could not queue a buyer ERP event');
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Process one claimed event.
 *
 * Never throws for an ERP failure - it records one. The caller is a worker
 * running a batch, and one buyer's broken SAP must not stop the other forty
 * being served.
 */
export async function dispatchEvent(event: ClaimedEvent): Promise<void> {
  const log = loggerFor(event.correlationId, {
    eventId: event.id,
    eventType: event.eventType,
    connectionId: event.connectionId,
  });

  const connection = await prisma.customerErpConnection.findUnique({
    where: { id: event.connectionId },
    select: { state: true, deletedAt: true, environment: true },
  });

  if (connection === null || connection.deletedAt !== null) {
    await recordSkip(event.id, 'The connection this was for has been removed.');
    return;
  }

  const state = connection.state;

  // A disconnected connection has had its credentials destroyed. There is
  // nothing to send to and no prospect of one appearing without somebody
  // setting it up again, so this is a permanent skip rather than a deferral.
  if (state === 'DISCONNECTED') {
    await recordSkip(event.id, 'The connection was disconnected before this could be sent.');
    return;
  }

  // Paused, waiting on somebody, or out of service. **This is what makes
  // "pausing stops automatic writes" true** - asked at dispatch time, on every
  // attempt, rather than only when the event was queued.
  //
  // Deferred rather than failed, and without spending an attempt: the event is
  // fine, the connection is not, and burning its retry budget on a fortnight's
  // pause would put a perfectly good purchase order in the dead-letter list for
  // a reason that was never its own.
  if (!carriesTraffic(state)) {
    await deferEvent(
      event.id,
      CONNECTION_DEFER_MS,
      state === 'PAUSED'
        ? 'Waiting: the connection is paused.'
        : state === 'ACTION_REQUIRED'
          ? 'Waiting: the connection needs attention.'
          : 'Waiting: the connection is out of service.',
    );
    return;
  }

  try {
    const outbound = await buildOutbound(event);

    if (outbound === null) {
      await recordSkip(event.id, 'There was nothing to send for this.');
      return;
    }

    // The approval gate, before a single byte goes anywhere.
    const approval = await approvalFor(event, outbound);

    if (approval !== null) {
      await recordSkip(
        event.id,
        'Held for approval before it is sent.',
        { approvalId: approval },
      );
      return;
    }

    const { connector, context } = await loadConnectorContext({
      connectionId: event.connectionId,
      organizationId: event.organizationId,
      currencyExponent: await currencyExponentFor(event),
    });

    const result = await connector.send(context, outbound);

    await recordSuccess(event.id, {
      erpReference: result.erpReference,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      requestJson: result.request,
      responseJson: result.response,
    });

    await applyOutboundResult(event, outbound, result.erpReference, result.alreadyPresent);
    await markConnectionHealthy(event.connectionId);

    log.info(
      { erpReference: result.erpReference, alreadyPresent: result.alreadyPresent },
      'sent an event to a buyer ERP',
    );
  } catch (error) {
    const outcome = await recordFailure(event.id, error);
    await markConnectionUnhealthy(event, error, outcome.willRetry);

    log.warn(
      { err: error, willRetry: outcome.willRetry },
      'a buyer ERP event did not go through',
    );
  }
}

/**
 * Run a batch. The worker's entry point.
 *
 * Sequential rather than parallel, deliberately. These calls go to systems
 * other people run, several of them rate-limited, and forty simultaneous
 * requests to one buyer's SAP is how an integration gets blocked at the
 * firewall. The leases mean several workers can still share the queue.
 */
export async function dispatchDueEvents(limit = 20): Promise<{ processed: number }> {
  if (!env.FEATURE_CUSTOMER_ERP) return { processed: 0 };

  const events = await claimDueEvents(limit);

  for (const event of events) {
    await dispatchEvent(event);
  }

  return { processed: events.length };
}

// ---------------------------------------------------------------------------
// Building what goes out
// ---------------------------------------------------------------------------

async function buildOutbound(event: ClaimedEvent): Promise<OutboundPayload | null> {
  switch (event.eventType) {
    case 'PURCHASE_ORDER_CREATE': {
      const payload = await buildPurchaseOrder(event);
      return payload === null ? null : { kind: 'PURCHASE_ORDER_CREATE', payload };
    }
    case 'PURCHASE_ORDER_UPDATE': {
      const payload = await buildPurchaseOrder(event);
      if (payload === null) return null;

      const order = await prisma.order.findUnique({
        where: { id: event.orderId ?? '' },
        select: { status: true },
      });

      return {
        kind: 'PURCHASE_ORDER_UPDATE',
        payload: { ...payload, status: order?.status ?? 'CANCELLED' },
      };
    }
    case 'SHIPMENT_STATUS': {
      const payload = await buildShipment(event);
      return payload === null ? null : { kind: 'SHIPMENT_STATUS', payload };
    }
    case 'GOODS_RECEIPT': {
      const payload = await buildGoodsReceipt(event);
      return payload === null ? null : { kind: 'GOODS_RECEIPT', payload };
    }
    case 'INVOICE_SYNC': {
      const payload = await buildInvoice(event);
      return payload === null ? null : { kind: 'INVOICE_SYNC', payload };
    }
    case 'PAYMENT_REFERENCE': {
      const payload = await buildPaymentReference(event);
      return payload === null ? null : { kind: 'PAYMENT_REFERENCE', payload };
    }
    // Not outbound writes. The poller and the webhook handler own these, and a
    // dispatcher that tried to `send` one would be asking a connector to write
    // something that has no shape.
    case 'CONNECTION_TEST':
    case 'DRY_RUN':
    case 'INVENTORY_UPDATE':
    case 'INBOUND_POLL':
    case 'INBOUND_WEBHOOK':
      return null;
  }
}

/**
 * Everything a purchase order needs, gathered in one read.
 *
 * Money stays `BigInt` from the database and becomes a STRING of minor units
 * here - never a JS number, not even briefly. A purchase order raised for one
 * minor unit less than the invoice is a dispute nobody can explain, and that is
 * exactly what a float round-trip produces.
 */
async function buildPurchaseOrder(event: ClaimedEvent): Promise<PurchaseOrderPayload | null> {
  if (event.orderId === null) return null;

  const order = await prisma.order.findUnique({
    where: { id: event.orderId },
    include: {
      items: true,
      customerProfile: { select: { customerCode: true, organization: true } },
      occurrence: { select: { id: true, scheduleId: true, plannedRunAt: true } },
    },
  });

  if (order === null) return null;

  const warehouses = await warehouseMapFor(event.connectionId, event.orderId);
  const materials = await materialMapFor(event.connectionId, order.items.map((item) => item.productId));

  const lines: PurchaseOrderLine[] = order.items.map((item) => {
    const placement = warehouses.get(`${item.productId}:${item.variantId ?? ''}`) ?? warehouses.get('*');

    return {
      sku: item.skuSnapshot,
      productId: item.productId,
      name: item.nameSnapshot,
      quantity: item.quantity,
      unitOfMeasure: null,
      unitPriceMinor: item.unitPriceMinor.toString(),
      netAmountMinor: item.lineSubtotalMinor.toString(),
      taxAmountMinor: item.taxAmountMinor.toString(),
      erpPlant: placement?.plant ?? null,
      erpStorageLocation: placement?.storageLocation ?? null,
      erpMaterialNumber: materials.get(`${item.productId}:${item.variantId ?? ''}`) ?? null,
    };
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderedAt: (order.placedAt ?? order.createdAt).toISOString(),
    currency: order.currency,
    netAmountMinor: order.subtotalMinor.toString(),
    taxAmountMinor: order.taxMinor.toString(),
    grossAmountMinor: order.grandTotalMinor.toString(),
    requestedDeliveryAt: order.occurrence?.plannedRunAt.toISOString() ?? null,
    // The buyer's ERP knows us as a vendor; this is the identifier THEY gave
    // us, carried on the connection. Null where they have not set one, which is
    // fine for a system with a single supplier.
    vendorId: await tenantIdentifierFor(event.connectionId),
    customerId: order.customerProfile.customerCode,
    lines,
    scheduleId: order.occurrence?.scheduleId ?? null,
    occurrenceId: order.occurrence?.id ?? null,
  };
}

async function buildShipment(event: ClaimedEvent): Promise<ShipmentPayload | null> {
  if (event.orderId === null) return null;

  const order = await prisma.order.findUnique({
    where: { id: event.orderId },
    select: { id: true, orderNumber: true, status: true },
  });

  if (order === null) return null;

  const shipment = await prisma.shipment.findFirst({
    where: { orderId: order.id },
    orderBy: { createdAt: 'desc' },
  });

  const link = await prisma.customerErpOrderLink.findUnique({
    where: {
      connectionId_orderId: { connectionId: event.connectionId, orderId: order.id },
    },
    select: { erpPurchaseOrderId: true },
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    erpPurchaseOrderId: link?.erpPurchaseOrderId ?? null,
    status: order.status,
    carrier: shipment?.carrier ?? null,
    trackingNumber: shipment?.trackingNumber ?? null,
    trackingUrl: shipment?.trackingUrl ?? null,
    dispatchedAt: shipment?.dispatchedAt?.toISOString() ?? null,
    expectedAt: null,
  };
}

/**
 * The goods receipt, built only when the buyer's policy allows it.
 *
 * Returning null here is the mechanism by which `receiptOnPlatformDelivery`
 * works: the event exists, the dispatcher finds nothing to send, and it is
 * recorded as skipped with a reason the buyer can read. The alternative - never
 * queueing it - would leave "why was nothing receipted" with no answer at all.
 */
async function buildGoodsReceipt(event: ClaimedEvent): Promise<GoodsReceiptPayload | null> {
  if (event.orderId === null) return null;

  const policy = await policyFor(event.connectionId);
  if (!policy.receiptOnPlatformDelivery) return null;

  const order = await prisma.order.findUnique({
    where: { id: event.orderId },
    include: { items: true },
  });

  if (order === null) return null;

  const warehouses = await warehouseMapFor(event.connectionId, order.id);
  const materials = await materialMapFor(
    event.connectionId,
    order.items.map((item) => item.productId),
  );

  const link = await prisma.customerErpOrderLink.findUnique({
    where: { connectionId_orderId: { connectionId: event.connectionId, orderId: order.id } },
    select: { erpPurchaseOrderId: true },
  });

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    erpPurchaseOrderId: link?.erpPurchaseOrderId ?? null,
    receivedAt: new Date().toISOString(),
    lines: order.items.map((item) => {
      const placement =
        warehouses.get(`${item.productId}:${item.variantId ?? ''}`) ?? warehouses.get('*');

      return {
        sku: item.skuSnapshot,
        erpMaterialNumber: materials.get(`${item.productId}:${item.variantId ?? ''}`) ?? null,
        quantity: item.quantity,
        unitOfMeasure: null,
        erpPlant: placement?.plant ?? null,
        erpStorageLocation: placement?.storageLocation ?? null,
      };
    }),
  };
}

async function buildInvoice(event: ClaimedEvent): Promise<InvoicePayload | null> {
  if (event.invoiceId === null) return null;

  const invoice = await prisma.invoice.findUnique({
    where: { id: event.invoiceId },
    include: { order: { select: { id: true, orderNumber: true } } },
  });

  if (invoice === null) return null;

  const link = await prisma.customerErpOrderLink.findUnique({
    where: {
      connectionId_orderId: { connectionId: event.connectionId, orderId: invoice.orderId },
    },
    select: { erpPurchaseOrderId: true },
  });

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    orderId: invoice.orderId,
    orderNumber: invoice.order.orderNumber,
    erpPurchaseOrderId: link?.erpPurchaseOrderId ?? null,
    issuedAt: invoice.issuedAt.toISOString(),
    dueAt: null,
    currency: invoice.currency,
    netAmountMinor: invoice.subtotalMinor.toString(),
    taxAmountMinor: invoice.taxMinor.toString(),
    grossAmountMinor: invoice.grandTotalMinor.toString(),
    // A link on THIS platform, behind the buyer's own authentication. We never
    // hand somebody's ERP an address it can fetch without signing in.
    documentUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/account/orders/${invoice.orderId}`,
  };
}

/**
 * The payment reference.
 *
 * Reads the captured transaction for its PROVIDER REFERENCE and nothing else.
 * There is no branch here that could reach an instrument, and that is by
 * construction rather than by discipline: the select list names four columns.
 */
async function buildPaymentReference(
  event: ClaimedEvent,
): Promise<PaymentReferencePayload | null> {
  if (event.orderId === null) return null;

  const order = await prisma.order.findUnique({
    where: { id: event.orderId },
    select: { id: true, orderNumber: true, currency: true, paidMinor: true },
  });

  if (order === null) return null;

  const transaction = await prisma.paymentTransaction.findFirst({
    where: { orderId: order.id, status: 'CAPTURED' },
    orderBy: { createdAt: 'desc' },
    // Six columns, named one by one. The narrowness is the control rather than
    // a habit: there is no branch in this function that could reach an
    // instrument, because `method`, the vaulted card and everything else about
    // HOW it was paid were never read.
    select: {
      providerPaymentId: true,
      providerOrderId: true,
      status: true,
      amountMinor: true,
      currency: true,
      capturedAt: true,
    },
  });

  // The payment id where the provider issued one, the order id where capture is
  // still settling. Either is a reference the buyer's accounts payable can
  // reconcile against; neither is an instrument.
  const reference = transaction?.providerPaymentId ?? transaction?.providerOrderId ?? null;

  if (transaction === null || reference === null) return null;

  const invoice = await prisma.invoice.findFirst({
    where: { orderId: order.id, creditsInvoiceId: null },
    orderBy: { issuedAt: 'desc' },
    select: { id: true, number: true },
  });

  return {
    invoiceId: invoice?.id ?? null,
    invoiceNumber: invoice?.number ?? null,
    orderId: order.id,
    orderNumber: order.orderNumber,
    reference,
    status: transaction.status,
    paidAmountMinor: transaction.amountMinor.toString(),
    currency: transaction.currency,
    paidAt: (transaction.capturedAt ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Applying the answer
// ---------------------------------------------------------------------------

/**
 * Write down what the ERP made of it.
 *
 * The link row is what answers "did my purchase order get raised, and what is
 * it called over there" - the most-asked question this feature has - and it is
 * also what makes the NEXT event about the same order able to reference it.
 *
 * **This is the only place `onOrderQty` is set, and the only place
 * `receivedQty` is.** Keeping both movements in one function is what stops a
 * future change incrementing on-hand at order time: the two are visibly
 * different branches of the same switch, a few lines apart.
 */
async function applyOutboundResult(
  event: ClaimedEvent,
  outbound: OutboundPayload,
  erpReference: string | null,
  alreadyPresent: boolean,
): Promise<void> {
  switch (outbound.kind) {
    case 'PURCHASE_ORDER_CREATE': {
      const quantity = outbound.payload.lines.reduce((total, line) => total + line.quantity, 0);

      await prisma.customerErpOrderLink.upsert({
        where: {
          connectionId_orderId: {
            connectionId: event.connectionId,
            orderId: outbound.payload.orderId,
          },
        },
        create: {
          id: newId(),
          connectionId: event.connectionId,
          organizationId: event.organizationId,
          orderId: outbound.payload.orderId,
          occurrenceId: outbound.payload.occurrenceId,
          erpPurchaseOrderId: erpReference,
          erpPurchaseOrderNumber: erpReference,
          // ON ORDER. Not on hand - the buyer has committed to buy something
          // and nothing has arrived. See this file's header.
          onOrderQty: quantity,
          receivedQty: 0,
          pushedAt: new Date(),
          lastSyncedAt: new Date(),
        },
        update: {
          erpPurchaseOrderId: erpReference ?? undefined,
          erpPurchaseOrderNumber: erpReference ?? undefined,
          onOrderQty: quantity,
          lastSyncedAt: new Date(),
          ...(alreadyPresent ? {} : { pushedAt: new Date() }),
        },
      });

      await applyOnOrderQuantities(event, outbound.payload.lines);
      return;
    }

    case 'PURCHASE_ORDER_UPDATE':
    case 'SHIPMENT_STATUS': {
      const payload = outbound.payload as { orderId: string; status: string };
      const tracking =
        outbound.kind === 'SHIPMENT_STATUS' ? outbound.payload.trackingNumber : null;

      await prisma.customerErpOrderLink.updateMany({
        where: { connectionId: event.connectionId, orderId: payload.orderId },
        data: {
          erpOrderStatus: payload.status,
          shipmentStatus: outbound.kind === 'SHIPMENT_STATUS' ? payload.status : undefined,
          trackingNumber: tracking ?? undefined,
          lastSyncedAt: new Date(),
        },
      });
      return;
    }

    case 'GOODS_RECEIPT': {
      const quantity = outbound.payload.lines.reduce((total, line) => total + line.quantity, 0);

      await prisma.customerErpOrderLink.updateMany({
        where: { connectionId: event.connectionId, orderId: outbound.payload.orderId },
        data: {
          erpGoodsReceiptId: erpReference,
          goodsReceiptedAt: new Date(),
          receivedQty: quantity,
          // What was on order has arrived. Decremented rather than zeroed, so a
          // partial receipt leaves the remainder outstanding.
          onOrderQty: { decrement: quantity },
          lastSyncedAt: new Date(),
        },
      });

      await applyReceivedQuantities(event, outbound.payload.lines);
      return;
    }

    case 'INVOICE_SYNC': {
      await prisma.customerErpInvoiceLink.upsert({
        where: {
          connectionId_invoiceId: {
            connectionId: event.connectionId,
            invoiceId: outbound.payload.invoiceId,
          },
        },
        create: {
          id: newId(),
          connectionId: event.connectionId,
          organizationId: event.organizationId,
          invoiceId: outbound.payload.invoiceId,
          orderId: outbound.payload.orderId,
          erpInvoiceId: erpReference,
          erpInvoiceNumber: erpReference,
          currency: outbound.payload.currency,
          grandTotalMinor: BigInt(outbound.payload.grossAmountMinor),
          taxMinor: BigInt(outbound.payload.taxAmountMinor),
          dueAt: outbound.payload.dueAt === null ? null : new Date(outbound.payload.dueAt),
          documentUrl: outbound.payload.documentUrl,
          syncedAt: new Date(),
        },
        update: {
          erpInvoiceId: erpReference ?? undefined,
          erpInvoiceNumber: erpReference ?? undefined,
          syncedAt: new Date(),
        },
      });
      return;
    }

    case 'PAYMENT_REFERENCE': {
      if (outbound.payload.invoiceId === null) return;

      await prisma.customerErpInvoiceLink.updateMany({
        where: {
          connectionId: event.connectionId,
          invoiceId: outbound.payload.invoiceId,
        },
        data: {
          paymentReference: outbound.payload.reference,
          paymentStatus: outbound.payload.status,
          paymentSyncedAt: new Date(),
        },
      });
      return;
    }
  }
}

/**
 * Record what is now on order, per product.
 *
 * `customer_erp_inventory_links` is a record of what we told the buyer's ERP
 * and what it told us - NOT a stock ledger for this platform. Nothing here
 * writes `inventory_balances`, which is the operator's own ledger and is moved
 * only by a person through the Inventory screens, with a reason and an actor
 * against it.
 */
async function applyOnOrderQuantities(
  event: ClaimedEvent,
  lines: readonly PurchaseOrderLine[],
): Promise<void> {
  for (const line of lines) {
    await upsertInventoryLink(event, line, { onOrderDelta: line.quantity });
  }
}

/**
 * Record what has arrived.
 *
 * The ONLY path in this file that touches `onHandQty`, and it is reached only
 * from a goods receipt - either a delivery this platform recorded under a
 * policy that allows it, or one the buyer's own ERP told us about. That is the
 * rule the whole feature turns on.
 */
async function applyReceivedQuantities(
  event: ClaimedEvent,
  lines: readonly { sku: string; erpMaterialNumber: string | null; quantity: number }[],
): Promise<void> {
  const policy = await policyFor(event.connectionId);

  for (const line of lines) {
    const productId = await productIdForSku(line.sku);
    if (productId === null) continue;

    await upsertInventoryLink(
      event,
      {
        sku: line.sku,
        productId,
        erpMaterialNumber: line.erpMaterialNumber,
        erpPlant: null,
        quantity: line.quantity,
      },
      {
        onOrderDelta: -line.quantity,
        // An APPROVAL_REQUIRED policy still records the receipt against the
        // order; what it withholds is the automatic stock figure. The approval
        // that releases it re-queues the same event.
        onHandDelta: policy.inventoryWriteMode === 'AUTOMATIC' ? line.quantity : 0,
      },
    );
  }
}

async function upsertInventoryLink(
  event: ClaimedEvent,
  line: {
    sku: string;
    productId: string;
    erpMaterialNumber: string | null;
    erpPlant: string | null;
    quantity: number;
  },
  deltas: { onOrderDelta?: number; onHandDelta?: number; incomingDelta?: number },
): Promise<void> {
  const plant = line.erpPlant ?? '';

  await prisma.customerErpInventoryLink.upsert({
    where: {
      connectionId_productId_variantKey_erpPlant: {
        connectionId: event.connectionId,
        productId: line.productId,
        variantKey: '',
        erpPlant: plant,
      },
    },
    create: {
      id: newId(),
      connectionId: event.connectionId,
      organizationId: event.organizationId,
      productId: line.productId,
      variantKey: '',
      erpPlant: plant,
      erpMaterialNumber: line.erpMaterialNumber,
      onOrderQty: Math.max(0, deltas.onOrderDelta ?? 0),
      incomingQty: Math.max(0, deltas.incomingDelta ?? 0),
      onHandQty: Math.max(0, deltas.onHandDelta ?? 0),
      lastAppliedEventId: event.id,
      lastSyncedAt: new Date(),
    },
    update: {
      erpMaterialNumber: line.erpMaterialNumber ?? undefined,
      ...(deltas.onOrderDelta === undefined
        ? {}
        : { onOrderQty: { increment: deltas.onOrderDelta } }),
      ...(deltas.onHandDelta === undefined || deltas.onHandDelta === 0
        ? {}
        : { onHandQty: { increment: deltas.onHandDelta } }),
      ...(deltas.incomingDelta === undefined
        ? {}
        : { incomingQty: { increment: deltas.incomingDelta } }),
      lastAppliedEventId: event.id,
      lastSyncedAt: new Date(),
    },
  });

  // A CHECK constraint keeps these at or above zero, and a decrement that would
  // break it is a sign the two systems disagree rather than a reason to crash.
  // Clamped here so the divergence is recorded instead.
  await prisma.customerErpInventoryLink.updateMany({
    where: {
      connectionId: event.connectionId,
      productId: line.productId,
      variantKey: '',
      erpPlant: plant,
      onOrderQty: { lt: 0 },
    },
    data: {
      onOrderQty: 0,
      divergenceNote: 'More was received than we recorded as on order.',
    },
  });
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

/**
 * Does somebody have to say yes first?
 *
 * Two reasons one might: the purchase order is over the organisation's
 * threshold, or the policy requires a person for stock writes. Returns the
 * approval's id when one was raised, and null when the write may proceed.
 *
 * The event holds at SKIPPED naming the approval, and approving RE-QUEUES THE
 * SAME EVENT under the SAME idempotency key - which is what stops an approval
 * producing a second purchase order.
 */
async function approvalFor(
  event: ClaimedEvent,
  outbound: OutboundPayload,
): Promise<string | null> {
  const policy = await policyFor(event.connectionId);

  const existing = await prisma.customerErpApproval.findUnique({
    where: { syncEventId: event.id },
  });

  if (existing !== null) {
    // Already decided. APPROVED means carry on; anything else means stop, and
    // a rejected approval must not be re-raised on the next attempt.
    if (existing.state === 'APPROVED') return null;
    if (existing.state === 'PENDING') return existing.id;

    throw new ErpCallError(
      existing.state === 'REJECTED'
        ? 'Somebody in your organisation declined this.'
        : 'The approval for this expired before anybody decided.',
      'REJECTED',
    );
  }

  const needed = approvalReason(policy, outbound);
  if (needed === null) return null;

  const approvalId = newId();
  const expiresAt = new Date(Date.now() + policy.approvalExpiryHours * 3600 * 1000);

  await prisma.customerErpApproval.create({
    data: {
      id: approvalId,
      connectionId: event.connectionId,
      organizationId: event.organizationId,
      kind: needed.kind,
      state: 'PENDING',
      syncEventId: event.id,
      orderId: event.orderId,
      amountMinor: needed.amountMinor,
      currency: needed.currency,
      summary: needed.summary,
      expiresAt,
    },
  });

  await recordOrgAudit({
    organizationId: event.organizationId,
    connectionId: event.connectionId,
    action: 'approval.requested',
    resourceType: 'approval',
    resourceId: approvalId,
    actor: SYSTEM_ACTOR,
    after: { summary: needed.summary, expiresAt: expiresAt.toISOString() },
  });

  await notifyOrganization(event.organizationId, NotificationEvent.CUSTOMER_ERP_APPROVAL_NEEDED, {
    summary: needed.summary,
    systemLabel: 'ERP',
    expiresAt: expiresAt.toISOString().slice(0, 10),
    connectionUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/account/integrations/erp/${event.connectionId}`,
  });

  return approvalId;
}

function approvalReason(
  policy: PolicyShape,
  outbound: OutboundPayload,
): {
  kind: 'PURCHASE_ORDER' | 'INVENTORY_WRITE';
  amountMinor: bigint | null;
  currency: string | null;
  summary: string;
} | null {
  if (outbound.kind === 'PURCHASE_ORDER_CREATE') {
    if (policy.approvalThresholdMinor === null) return null;

    const amount = BigInt(outbound.payload.grossAmountMinor);

    // Compared only where the currencies match. Converting a threshold
    // somebody typed is not something to do silently - the same reasoning
    // auto-pay uses for `AUTOPAY_CURRENCY_MISMATCH`.
    if (policy.approvalCurrency !== outbound.payload.currency) return null;
    if (amount < policy.approvalThresholdMinor) return null;

    return {
      kind: 'PURCHASE_ORDER',
      amountMinor: amount,
      currency: outbound.payload.currency,
      summary:
        `Purchase order for order ${outbound.payload.orderNumber}, ` +
        `${outbound.payload.currency} ${formatMinor(amount)}, at or above your ` +
        `${policy.approvalCurrency} ${formatMinor(policy.approvalThresholdMinor)} threshold.`,
    };
  }

  if (outbound.kind === 'GOODS_RECEIPT' && policy.inventoryWriteMode === 'APPROVAL_REQUIRED') {
    const quantity = outbound.payload.lines.reduce((total, line) => total + line.quantity, 0);

    return {
      kind: 'INVENTORY_WRITE',
      amountMinor: null,
      currency: null,
      summary:
        `Goods receipt for order ${outbound.payload.orderNumber}: ${quantity} units across ` +
        `${outbound.payload.lines.length} lines. Your sync rules ask for a person to ` +
        'approve stock writes.',
    };
  }

  return null;
}

/** Minor units as a decimal string, by string arithmetic. Never a float. */
function formatMinor(minor: bigint, exponent = 2): string {
  const negative = minor < 0n;
  const digits = (negative ? -minor : minor).toString().padStart(exponent + 1, '0');

  return `${negative ? '-' : ''}${digits.slice(0, digits.length - exponent)}.${digits.slice(
    digits.length - exponent,
  )}`;
}

// ---------------------------------------------------------------------------
// Inbound: what the buyer's ERP tells us
// ---------------------------------------------------------------------------

/**
 * Apply a verified inbound event.
 *
 * Reached from the webhook handler and from the poller, and the two share this
 * function on purpose: a goods receipt means the same thing whether the ERP
 * pushed it or we asked for it, and two implementations of "what does a goods
 * receipt do" is how they come to disagree.
 */
export async function applyInboundEvent(input: {
  connectionId: string;
  organizationId: string;
  correlationId: string;
  event: InboundEvent;
}): Promise<{
  applied: boolean;
  note: string;
  /**
   * How many of the event's records were actually recorded.
   *
   * Only an inventory feed carries more than one, and only it sets this. The
   * caller counting a whole PAGE as applied because one record in it matched
   * is how a sync that recorded a single product reported "recorded 100" - a
   * hundredfold overstatement in the one log this feature promises can always
   * say what happened. Absent means "the event was one subject", and the caller
   * falls back to the record count.
   */
  count?: number;
}> {
  const policy = await policyFor(input.connectionId);

  // An OUTBOUND-only connection writes to their ERP and never reads from it.
  // Refusing here rather than at the door means the delivery is still recorded,
  // so a buyer who has set this by mistake can see their ERP is trying.
  if (policy.mode === 'OUTBOUND') {
    return { applied: false, note: 'This connection is set to send only, so this was not applied.' };
  }

  switch (input.event.kind) {
    case 'GOODS_RECEIPT': {
      const link =
        input.event.erpPurchaseOrderId === null
          ? null
          : await prisma.customerErpOrderLink.findFirst({
              where: {
                connectionId: input.connectionId,
                erpPurchaseOrderId: input.event.erpPurchaseOrderId,
              },
            });

      if (link === null) {
        return {
          applied: false,
          note: 'No order here matches that purchase order number.',
        };
      }

      const quantity = input.event.lines.reduce((total, line) => total + line.quantity, 0);

      await prisma.customerErpOrderLink.update({
        where: { id: link.id },
        data: {
          erpGoodsReceiptId: input.event.erpGoodsReceiptId,
          goodsReceiptedAt:
            input.event.receivedAt === null ? new Date() : new Date(input.event.receivedAt),
          receivedQty: { increment: quantity },
          onOrderQty: { decrement: Math.min(quantity, link.onOrderQty) },
          lastSyncedAt: new Date(),
        },
      });

      // The buyer's own ERP saying the goods arrived is the strongest evidence
      // there is, and it is what `receiptOnPlatformDelivery = false` defers to.
      for (const line of input.event.lines) {
        const productId =
          line.sku === null ? null : await productIdForSku(line.sku);

        if (productId === null) continue;

        await upsertInventoryLink(
          {
            id: newId(),
            connectionId: input.connectionId,
            organizationId: input.organizationId,
          } as ClaimedEvent,
          {
            sku: line.sku ?? '',
            productId,
            erpMaterialNumber: line.erpMaterialNumber,
            erpPlant: null,
            quantity: line.quantity,
          },
          {
            onOrderDelta: -line.quantity,
            onHandDelta: policy.inventoryWriteMode === 'AUTOMATIC' ? line.quantity : 0,
          },
        );
      }

      return {
        applied: true,
        note:
          policy.inventoryWriteMode === 'AUTOMATIC'
            ? 'Goods receipt applied and stock updated.'
            : 'Goods receipt recorded. Stock was not written because your rules ask for ' +
              'a person to approve that.',
      };
    }

    case 'ORDER_STATUS': {
      if (input.event.erpPurchaseOrderId === null) {
        return { applied: false, note: 'The update named no purchase order.' };
      }

      const updated = await prisma.customerErpOrderLink.updateMany({
        where: {
          connectionId: input.connectionId,
          erpPurchaseOrderId: input.event.erpPurchaseOrderId,
        },
        data: { erpOrderStatus: input.event.erpStatus, lastSyncedAt: new Date() },
      });

      return updated.count > 0
        ? { applied: true, note: `Status recorded as "${input.event.erpStatus}".` }
        : { applied: false, note: 'No order here matches that purchase order number.' };
    }

    case 'INVENTORY': {
      if (!policy.syncInventory) {
        return { applied: false, note: 'Stock syncing is switched off on this connection.' };
      }

      let applied = 0;

      for (const record of input.event.records) {
        if (record.sku === null) continue;

        const productId = await productIdForSku(record.sku);
        if (productId === null) continue;

        await prisma.customerErpInventoryLink.upsert({
          where: {
            connectionId_productId_variantKey_erpPlant: {
              connectionId: input.connectionId,
              productId,
              variantKey: '',
              erpPlant: record.plant ?? '',
            },
          },
          create: {
            id: newId(),
            connectionId: input.connectionId,
            organizationId: input.organizationId,
            productId,
            variantKey: '',
            erpPlant: record.plant ?? '',
            erpMaterialNumber: record.erpMaterialNumber,
            onHandQty: Math.max(0, record.onHandQty ?? 0),
            onOrderQty: Math.max(0, record.onOrderQty ?? 0),
            incomingQty: Math.max(0, record.incomingQty ?? 0),
            erpUnitOfMeasure: record.unitOfMeasure,
            lastSyncedAt: new Date(),
          },
          update: {
            erpMaterialNumber: record.erpMaterialNumber ?? undefined,
            // Absolute figures from a feed REPLACE rather than increment: the
            // ERP is telling us what it believes, not what changed.
            ...(record.onHandQty === null ? {} : { onHandQty: Math.max(0, record.onHandQty) }),
            ...(record.onOrderQty === null ? {} : { onOrderQty: Math.max(0, record.onOrderQty) }),
            ...(record.incomingQty === null
              ? {}
              : { incomingQty: Math.max(0, record.incomingQty) }),
            erpUnitOfMeasure: record.unitOfMeasure ?? undefined,
            lastSyncedAt: new Date(),
          },
        });

        applied += 1;
      }

      return {
        applied: applied > 0,
        note: `${applied} stock records recorded.`,
        count: applied,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Connection health
// ---------------------------------------------------------------------------

async function markConnectionHealthy(connectionId: string): Promise<void> {
  await prisma.customerErpConnection.update({
    where: { id: connectionId },
    data: { consecutiveFailures: 0, circuitOpenedAt: null, lastSuccessAt: new Date() },
  });
}

/**
 * Count the failure, and take the connection out of service if it keeps going.
 *
 * An AUTH failure goes straight to ACTION_REQUIRED rather than waiting for the
 * threshold: an expired authorisation is not going to fix itself, and every
 * further attempt is a request to somebody else's system that we already know
 * will be refused.
 */
async function markConnectionUnhealthy(
  event: ClaimedEvent,
  error: unknown,
  willRetry: boolean,
): Promise<void> {
  const isAuth = error instanceof ErpCallError && error.kind === 'AUTH';

  const connection = await prisma.customerErpConnection.update({
    where: { id: event.connectionId },
    data: { consecutiveFailures: { increment: 1 }, lastFailureAt: new Date() },
    select: { consecutiveFailures: true, state: true, name: true, system: true },
  });

  const reason = safeErrorMessage(error).slice(0, 512);

  if (isAuth && connection.state === 'ACTIVE') {
    await setConnectionState(event.connectionId, 'ACTION_REQUIRED', reason, event.organizationId);
    await notifyOrganization(
      event.organizationId,
      NotificationEvent.CUSTOMER_ERP_ACTION_REQUIRED,
      {
        connectionName: connection.name,
        systemLabel: connection.system,
        reason,
        connectionUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/account/integrations/erp/${event.connectionId}`,
      },
    );
    return;
  }

  if (
    !willRetry &&
    connection.consecutiveFailures >= env.CUSTOMER_ERP_FAILURE_THRESHOLD &&
    connection.state === 'ACTIVE'
  ) {
    await setConnectionState(event.connectionId, 'FAILED', reason, event.organizationId);
    await notifyOrganization(event.organizationId, NotificationEvent.CUSTOMER_ERP_SUSPENDED, {
      connectionName: connection.name,
      systemLabel: connection.system,
      reason,
      connectionUrl: `${env.CUSTOMER_WEB_PUBLIC_URL}/account/integrations/erp/${event.connectionId}`,
    });
  }
}

/**
 * Move a connection's state from the machinery.
 *
 * Goes through the state machine like every other change - see
 * `customer-erp-state.ts`. Failures are swallowed because this is reached from
 * an error path: a connection already in ACTION_REQUIRED being told to go there
 * again is a no-op worth ignoring, not a second failure to report.
 */
async function setConnectionState(
  connectionId: string,
  state: 'ACTION_REQUIRED' | 'FAILED',
  reason: string,
  organizationId: string,
): Promise<void> {
  await prisma.customerErpConnection
    .update({
      where: { id: connectionId },
      data: { state, stateReason: reason, stateChangedAt: new Date() },
    })
    .then(async () => {
      await recordOrgAudit({
        organizationId,
        connectionId,
        action: state === 'FAILED' ? 'connection.suspended' : 'connection.attention_required',
        resourceType: 'connection',
        resourceId: connectionId,
        actor: SYSTEM_ACTOR,
        after: { state, reason },
      });
    })
    .catch(() => undefined);
}

/**
 * Tell the people who can act.
 *
 * Owners and integration managers, not every member: a message telling somebody
 * to fix a credential they have no authority to change is a message that
 * teaches them to ignore the next one.
 */
async function notifyOrganization(
  organizationId: string,
  eventKey: string,
  variables: Record<string, string | number | boolean | null>,
): Promise<void> {
  const members = await prisma.buyerOrganizationMember.findMany({
    where: { organizationId, role: { in: ['OWNER', 'INTEGRATION_MANAGER'] } },
    include: {
      customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
    },
    take: 10,
  });

  for (const member of members) {
    await enqueueNotification({
      eventKey,
      recipientEmail: member.customerProfile.user.email,
      recipientName: member.customerProfile.fullName,
      variables,
      // One message per organisation per cause per day. A connection failing
      // every fifteen minutes must not produce ninety-six emails.
      dedupeKey: `customer_erp:${eventKey}:${organizationId}:${new Date()
        .toISOString()
        .slice(0, 10)}`,
      relatedType: 'buyer_organization',
      relatedId: organizationId,
    }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------

interface WarehousePlacement {
  plant: string | null;
  storageLocation: string | null;
}

/**
 * Which plant each line ships from, by product.
 *
 * Resolved from the stock reservations the order committed, which is the only
 * record of where it was actually allocated. `'*'` is the connection's fallback
 * mapping, used for a line whose warehouse the buyer has not mapped - without
 * it a single unmapped warehouse would fail every purchase order rather than
 * one line of one.
 */
async function warehouseMapFor(
  connectionId: string,
  orderId: string,
): Promise<Map<string, WarehousePlacement>> {
  const [maps, reservations] = await Promise.all([
    prisma.customerErpWarehouseMap.findMany({ where: { connectionId } }),
    prisma.stockReservation.findMany({
      where: { orderId },
      select: { productId: true, variantId: true, locationId: true },
    }),
  ]);

  const byLocation = new Map<string, WarehousePlacement>();
  const result = new Map<string, WarehousePlacement>();

  for (const row of maps) {
    const placement = { plant: row.erpPlant, storageLocation: row.erpStorageLocation };

    if (row.isFallback || row.inventoryLocationId === null) {
      result.set('*', placement);
      continue;
    }

    byLocation.set(row.inventoryLocationId, placement);
  }

  for (const reservation of reservations) {
    const placement = byLocation.get(reservation.locationId);
    if (placement === undefined) continue;

    result.set(`${reservation.productId}:${reservation.variantId ?? ''}`, placement);
  }

  return result;
}

/** The buyer's own material number for each product, where they have mapped one. */
async function materialMapFor(
  connectionId: string,
  productIds: readonly string[],
): Promise<Map<string, string>> {
  if (productIds.length === 0) return new Map();

  const rows = await prisma.customerErpInventoryLink.findMany({
    where: { connectionId, productId: { in: [...new Set(productIds)] } },
    select: { productId: true, variantKey: true, erpMaterialNumber: true },
  });

  const result = new Map<string, string>();

  for (const row of rows) {
    if (row.erpMaterialNumber === null) continue;
    result.set(`${row.productId}:${row.variantKey}`, row.erpMaterialNumber);
  }

  return result;
}

/** Our product for a SKU the ERP named. Null when we do not sell it. */
async function productIdForSku(sku: string): Promise<string | null> {
  if (sku.trim().length === 0) return null;

  const product = await prisma.product.findFirst({
    where: { sku: sku.trim() },
    select: { id: true },
  });

  return product?.id ?? null;
}

async function tenantIdentifierFor(connectionId: string): Promise<string | null> {
  const row = await prisma.customerErpConnection.findUnique({
    where: { id: connectionId },
    select: { tenantIdentifier: true },
  });

  return row?.tenantIdentifier ?? null;
}

/**
 * How many minor units the order's currency has.
 *
 * Read rather than assumed: JPY has none, and a purchase order for
 * "12000.00 JPY" where the buyer meant 12000 is off by a factor of a hundred.
 */
async function currencyExponentFor(event: ClaimedEvent): Promise<number> {
  if (event.orderId === null) return 2;

  const order = await prisma.order.findUnique({
    where: { id: event.orderId },
    select: { currency: true },
  });

  if (order === null) return 2;

  const currency = await prisma.currency.findUnique({
    where: { code: order.currency },
    select: { exponent: true },
  });

  return currency?.exponent ?? 2;
}

/** Re-export so the routes need one import for the whole feature's policy shape. */
export type { PolicyShape };

/** Narrow a Prisma JSON column without `any`. */
export type JsonObject = Prisma.InputJsonValue;

/** Refuse an operation on a feature that is switched off for this deployment. */
export function assertFeatureEnabled(): void {
  if (!env.FEATURE_CUSTOMER_ERP) {
    throw conflict(
      ErrorCode.FEATURE_DISABLED,
      'Connecting your own purchasing system is not switched on for this store.',
    );
  }
}
