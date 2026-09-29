/**
 * Chargebacks: the buyer's bank asking for the money back, as a lifecycle.
 *
 * Driven ONLY by signature-verified payment-provider webhooks. The route
 * verifies the signature and `processWebhook` claims the event exactly once
 * (the unique `providerEventId`); what arrives here is authentic and new.
 * Nothing a browser or a member of staff says moves a chargeback's status -
 * the card network decides it, and staff add evidence notes while it runs.
 *
 * ONE PROVIDER DISPUTE, ONE ROW. `providerDisputeId` is unique, so the
 * created, updated and closed events for dp_123 all land on the same dispute
 * whatever order they arrive in. A late "under review" after "lost" is
 * refused by `nextChargebackStatus` and changes nothing.
 *
 * WHEN IT IS LOST the money has gone back to the buyer through their bank,
 * and the sellers' settlements must say so exactly as they would for a
 * refund. So a lost chargeback is recorded as a SUCCEEDED `Refund` row keyed
 * `chargeback-lost:<dp_id>` (at most what is still refundable - the
 * `chk_order_refund_within_paid` constraint holds here too), the order's
 * refunded total moves, and `syncSettlementRefunds` re-derives every seller's
 * settlement from it - the same function the refund path calls. Finance then
 * issues any commission credit note against that settlement, as for a refund.
 * It is all one transaction with the event's own "processed" mark, so a
 * redelivered "lost" event lands on a row that is already LOST and does
 * nothing.
 *
 * WHEN IT IS WON nothing moves: the provider returns the withdrawn funds and
 * no refund was ever recorded.
 */
import type { VerifiedEvent } from '../payments/provider.js';
import {
  chargebackStatusFor,
  nextChargebackStatus,
  type DisputeStatusName,
} from '../../domain/dispute-state.js';
import { serialiseMoney } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import type { PaymentProviderKind } from '../../generated/prisma/enums.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import type { PrismaTransaction } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  AdminNotificationKind,
  createAdminNotification,
} from '../notifications/admin-notification.service.js';
import { syncSettlementRefunds } from '../seller/settlement-refund.service.js';
import { consoleDisputePath, newDisputeReference, writeEvent } from './dispute-common.js';

/**
 * Who "asked" for the refund row a lost chargeback records. Nobody did - the
 * card network took the money - so it is a fixed, recognisable id rather than
 * a person's. `Refund.requestedById` is not a foreign key.
 */
export const CHARGEBACK_ACTOR_ID = '0'.repeat(26);

export interface ChargebackContext {
  event: VerifiedEvent;
  transaction: { id: string; provider: PaymentProviderKind };
  order: { id: string; orderNumber: string; customerProfileId: string; currency: string };
}

export interface ChargebackOutcome {
  disputeId: string | null;
  status: DisputeStatusName | null;
  changed: boolean;
}

/**
 * Where the payout ledger posts a chargeback's outcome.
 *
 * The ledger is its own module; this is the one place a chargeback's final
 * outcome is handed to it, inside the same transaction as the outcome itself.
 * Until that module is present the ledger has nothing to post here and this
 * returns without writing.
 */
async function postChargebackOutcomeToLedger(
  _tx: PrismaTransaction,
  _outcome: {
    disputeId: string;
    orderId: string;
    status: 'WON' | 'LOST';
    amountMinor: bigint;
    currency: string;
    refundId: string | null;
  },
): Promise<void> {
  return Promise.resolve();
}

/**
 * Apply one verified dispute event. Call inside the transaction that marks
 * the event processed.
 */
export async function recordChargebackEvent(
  tx: PrismaTransaction,
  context: ChargebackContext,
): Promise<ChargebackOutcome> {
  const { event, transaction, order } = context;
  const providerDisputeId = event.providerDisputeId ?? null;
  if (providerDisputeId === null) {
    // An event with no dispute id cannot be tied to one lifecycle. Recorded on
    // the payment by the caller; nothing to track here.
    logger.warn({ eventId: event.eventId }, 'a dispute event carried no dispute id');
    return { disputeId: null, status: null, changed: false };
  }

  const reported = chargebackStatusFor(event.disputeStatus);
  const now = new Date();
  const currency = event.currency ?? order.currency;

  let row = await tx.dispute.findUnique({
    where: { providerDisputeId },
    select: { id: true, reference: true, status: true, kind: true, disputedAmountMinor: true, currency: true },
  });

  let changed = false;
  if (row === null) {
    const id = newId();
    const reference = newDisputeReference();
    await tx.dispute.create({
      data: {
        id,
        reference,
        kind: 'CHARGEBACK',
        status: 'CHARGEBACK_OPEN',
        orderId: order.id,
        customerProfileId: order.customerProfileId,
        paymentTransactionId: transaction.id,
        providerDisputeId,
        providerStatus: event.disputeStatus?.slice(0, 40) ?? null,
        reasonCode: (event.disputeReason ?? 'unspecified').slice(0, 40),
        currency,
        disputedAmountMinor: event.amountMinor,
        evidenceDueAt: event.disputeEvidenceDueBy ?? null,
        lastActivityAt: now,
      },
    });
    await writeEvent(tx, {
      disputeId: id,
      kind: 'CREATED',
      party: 'PROVIDER',
      visibleToBuyer: false,
      visibleToSeller: false,
      toValue: event.disputeStatus?.slice(0, 40) ?? null,
      amountMinor: event.amountMinor,
      createdAt: now,
    });
    await createAdminNotification(
      {
        kind: AdminNotificationKind.DISPUTE_CHARGEBACK,
        variables: { reference, orderNumber: order.orderNumber, status: 'CHARGEBACK_OPEN' },
        linkPath: consoleDisputePath(id),
        requiredPermission: Permission.DISPUTE_VIEW,
        relatedType: 'dispute',
        relatedId: id,
        dedupeKey: `chargeback-opened:${id}`,
      },
      tx,
    );
    row = { id, reference, status: 'CHARGEBACK_OPEN', kind: 'CHARGEBACK', disputedAmountMinor: event.amountMinor, currency };
    changed = true;
  }

  const next = nextChargebackStatus(row.status, reported);

  // What the provider said, whether or not it moves the status: the latest
  // evidence deadline and its own status word are what staff work from.
  await tx.dispute.update({
    where: { id: row.id },
    data: {
      providerStatus: event.disputeStatus?.slice(0, 40) ?? undefined,
      ...(event.disputeEvidenceDueBy === undefined || event.disputeEvidenceDueBy === null
        ? {}
        : { evidenceDueAt: event.disputeEvidenceDueBy }),
      ...(event.amountMinor === null ? {} : { disputedAmountMinor: event.amountMinor }),
      lastActivityAt: now,
    },
  });

  if (next === null) {
    if (!changed) {
      await writeEvent(tx, {
        disputeId: row.id,
        kind: 'PROVIDER_UPDATE',
        party: 'PROVIDER',
        visibleToBuyer: false,
        visibleToSeller: false,
        toValue: event.disputeStatus?.slice(0, 40) ?? null,
        createdAt: now,
      });
    }
    return { disputeId: row.id, status: row.status, changed };
  }

  const moved = await tx.dispute.updateMany({
    where: { id: row.id, status: row.status },
    data: { status: next, ...(next === 'WON' || next === 'LOST' ? { closedAt: now } : {}) },
  });
  if (moved.count === 0) {
    // Another delivery of a later event won the row; it has the newer word.
    return { disputeId: row.id, status: row.status, changed };
  }
  await writeEvent(tx, {
    disputeId: row.id,
    kind: 'STATUS_CHANGED',
    party: 'PROVIDER',
    visibleToBuyer: false,
    visibleToSeller: false,
    fromValue: row.status,
    toValue: next,
    createdAt: new Date(now.getTime() + 1),
  });
  await recordAudit(
    {
      action: AuditAction.DISPUTE_CHARGEBACK_UPDATED,
      resourceType: 'dispute',
      resourceId: row.id,
      actorType: 'PROVIDER',
      before: { status: row.status },
      after: { status: next, providerStatus: event.disputeStatus ?? null, providerEventId: event.eventId },
    },
    tx,
  );
  await createAdminNotification(
    {
      kind: AdminNotificationKind.DISPUTE_CHARGEBACK,
      variables: { reference: row.reference, orderNumber: order.orderNumber, status: next },
      linkPath: consoleDisputePath(row.id),
      requiredPermission: Permission.DISPUTE_VIEW,
      relatedType: 'dispute',
      relatedId: row.id,
      dedupeKey: `chargeback-status:${row.id}:${next}`,
    },
    tx,
  );

  if (next === 'LOST') {
    await settleLostChargeback(tx, { disputeId: row.id, reference: row.reference, providerDisputeId, transaction, order, disputedAmountMinor: event.amountMinor ?? row.disputedAmountMinor, currency });
  } else if (next === 'WON') {
    await postChargebackOutcomeToLedger(tx, { disputeId: row.id, orderId: order.id, status: 'WON', amountMinor: event.amountMinor ?? row.disputedAmountMinor ?? 0n, currency, refundId: null });
  }
  return { disputeId: row.id, status: next, changed: true };
}

/**
 * The money a lost chargeback took, carried into the order and the sellers'
 * settlements exactly as a refund is.
 */
async function settleLostChargeback(
  tx: PrismaTransaction,
  input: {
    disputeId: string;
    reference: string;
    providerDisputeId: string;
    transaction: { id: string; provider: PaymentProviderKind };
    order: { id: string; orderNumber: string };
    disputedAmountMinor: bigint | null;
    currency: string;
  },
): Promise<void> {
  // Serialise against a refund settling on the same order at the same moment.
  await tx.$queryRaw`SELECT id FROM orders WHERE id = ${input.order.id} FOR UPDATE`;
  const order = await tx.order.findUniqueOrThrow({
    where: { id: input.order.id },
    select: { paidMinor: true, refundedMinor: true, currency: true },
  });
  const left = order.paidMinor - order.refundedMinor;
  const taken = input.disputedAmountMinor ?? order.paidMinor;
  // Never more than is still refundable. Anything above that was already
  // refunded to the buyer once - the operator's double loss, told to finance.
  const amount = taken < left ? taken : left > 0n ? left : 0n;

  let refundId: string | null = null;
  if (amount > 0n) {
    refundId = newId();
    await tx.refund.create({
      data: {
        id: refundId,
        orderId: input.order.id,
        paymentTransactionId: input.transaction.id,
        provider: input.transaction.provider,
        amountMinor: amount,
        currency: order.currency,
        reason: `Chargeback lost (${input.providerDisputeId})`.slice(0, 512),
        status: 'SUCCEEDED',
        requestedById: CHARGEBACK_ACTOR_ID,
        idempotencyKey: `chargeback-lost:${input.providerDisputeId}`.slice(0, 128),
        completedAt: new Date(),
      },
    });
    // chk_order_refund_within_paid refuses this if it would ever exceed paid.
    await tx.order.update({ where: { id: input.order.id }, data: { refundedMinor: { increment: amount } } });
    await syncSettlementRefunds(input.order.id, tx);
    await tx.dispute.update({ where: { id: input.disputeId }, data: { refundId, resolutionAmountMinor: amount } });
  }

  await writeEvent(tx, {
    disputeId: input.disputeId,
    kind: 'DECISION_APPLIED',
    party: 'PROVIDER',
    visibleToBuyer: false,
    visibleToSeller: false,
    toValue: 'LOST',
    amountMinor: amount,
    body:
      amount > 0n
        ? `The chargeback was lost. ${serialiseMoney(amount, order.currency).formatted} ${order.currency} is recorded as returned to the buyer and taken out of the sellers' settlements.`
        : 'The chargeback was lost. The order had already been refunded in full, so no settlement changed.',
  });
  await recordAudit(
    {
      action: AuditAction.DISPUTE_CHARGEBACK_LOST_SETTLED,
      resourceType: 'dispute',
      resourceId: input.disputeId,
      actorType: 'PROVIDER',
      after: {
        reference: input.reference,
        orderId: input.order.id,
        refundId,
        amountMinor: amount,
        disputedMinor: taken,
        uncoveredMinor: taken > amount ? taken - amount : 0n,
      },
    },
    tx,
  );
  await postChargebackOutcomeToLedger(tx, {
    disputeId: input.disputeId,
    orderId: input.order.id,
    status: 'LOST',
    amountMinor: amount,
    currency: order.currency,
    refundId,
  });
}
