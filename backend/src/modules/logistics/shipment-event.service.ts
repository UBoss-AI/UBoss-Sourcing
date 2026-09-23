/**
 * Recording what happened to a consignment.
 *
 * The single write path for `logistics_shipments.status`. Nothing else in this
 * codebase writes that column - the same rule `assertTransition` enforces for
 * orders and `schedule-state.ts` for occurrences, and it matters more here
 * than in either of them: a shipment changes status inside a webhook handler
 * with nobody watching, and the state it lands in decides whether a hospital
 * is told its consignment arrived.
 *
 * THE FOUR THINGS THIS FILE GUARANTEES
 *
 *  1. **The transition is legal.** `assertShipmentTransition` runs inside the
 *     same transaction as the update, for the caller's actor and permissions.
 *     The portal renders the buttons that function returned; this asks it
 *     again, because a UI restriction is not a security control.
 *
 *  2. **A duplicate request writes at most one event.** Not by checking first
 *     and then inserting - that loses to a carrier redelivering a webhook
 *     twice in the same second - but by letting the database refuse the second
 *     insert. Two UNIQUE indexes do it:
 *     `(shipmentId, idempotencyKey)` and `externalEventKey`. A constraint
 *     violation here is a SUCCESS: it means the work was already done, and the
 *     existing event is returned.
 *
 *  3. **The timeline is immutable.** Nothing updates an event row, ever. The
 *     status column is a projection maintained from the events inside the same
 *     transaction, so the timeline is the record and the column is the index
 *     over it. An operator correction is a NEW event flagged `isCorrection`,
 *     never an edit.
 *
 *  4. **Inventory is never touched from here.** Not "carefully", not "only
 *     once" - never. Where a shipment event should move stock, it moves the
 *     ORDER through `transitionOrder`, and the order state machine does what
 *     it already does. That is why requirement 17 of the brief - shipment
 *     events must not create duplicate inventory movements - is true by
 *     construction rather than by this file remembering to be careful.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import type { LogisticsEventSource } from '../../generated/prisma/enums.js';
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import type { OrderStatusName } from '../../domain/order-state-machine.js';
import type { LogisticsPermissionKey } from '../../domain/logistics-permissions.js';
import {
  assertShipmentCorrection,
  assertShipmentTransition,
  isShipmentException,
  isTrackingComplete,
  type ShipmentActor,
  type ShipmentStatusName,
} from '../../domain/logistics-shipment-state.js';
import { Permission } from '../../domain/permissions.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import {
  AdminNotificationKind,
  ResolutionKey,
  createAdminNotification,
  resolveAdminNotifications,
} from '../notifications/admin-notification.service.js';
import { transitionOrder } from '../orders/order.service.js';
import { recordLogisticsAudit } from './audit.service.js';
// The leaf module rather than `driver.service.ts`, deliberately: that one
// reaches this file through `operations.service.ts`, and importing it here
// would close the loop. See the header of `driver-assignment.service.ts`.
import { completeDriverAssignmentsFor } from './driver-assignment.service.js';
import { notifyShipmentEvent } from './notification.service.js';
import {
  NotificationEvent,
  enqueueNotification,
} from '../notifications/notification.service.js';

/**
 * The two ways a concurrent insert of the same key can fail.
 *
 * `P2002` is the ordinary unique-constraint violation: the other transaction
 * had already committed. `P2034` is InnoDB reporting a deadlock or write
 * conflict, which is what actually happens when two transactions reach the
 * same unique index in the same instant - the index takes a gap lock, both
 * wait, and the engine kills one of them.
 *
 * BOTH mean "somebody else wrote this event", and treating only the first as
 * such is the bug an integration test caught: a carrier redelivering a webhook
 * twice in the same millisecond got a 500 rather than a clean duplicate, which
 * made it retry, which made it happen again.
 */
const LOST_THE_RACE_CODES: ReadonlySet<string> = new Set(['P2002', 'P2034']);

function lostTheRace(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && LOST_THE_RACE_CODES.has(code);
}

/**
 * The event this key already wrote, if it wrote one.
 *
 * Looked up by BOTH keys, because either index could have been the one that
 * decided: the caller's idempotency key, or the carrier's own event id.
 */
async function findExistingEvent(
  shipmentId: string,
  idempotencyKey: string,
  externalEventKey: string,
): Promise<ShipmentEventResult | null> {
  const existing = await prisma.logisticsShipmentEvent.findFirst({
    where: {
      OR: [{ shipmentId, idempotencyKey }, { externalEventKey }],
    },
    select: {
      id: true,
      shipmentId: true,
      previousStatus: true,
      status: true,
      occurredAt: true,
    },
  });

  if (existing === null) return null;

  return {
    eventId: existing.id,
    shipmentId: existing.shipmentId,
    previousStatus: (existing.previousStatus) ?? null,
    status: existing.status,
    occurredAt: existing.occurredAt,
    duplicate: true,
  };
}

export interface ShipmentEventInput {
  shipmentId: string;
  status: ShipmentStatusName;
  actor: ShipmentActor;
  source: LogisticsEventSource;

  /** Who, where a person did it. */
  actorUserId?: string | null;
  actorLogisticsPartnerId?: string | null;
  /** How the actor is described in the carrier's own audit trail. */
  actorLabel?: string;
  /** Permissions the actor holds. Ignored for CARRIER and SYSTEM. */
  permissions?: readonly LogisticsPermissionKey[];

  /** Required by every transition the matrix marks `requiresReason`. */
  reason?: string | null;
  /** The sentence a customer reads. */
  publicDescription?: string | null;
  /** Operations' own words. Never leaves the portal. */
  internalNote?: string | null;

  /** When it happened. Defaults to now; a carrier feed supplies its own. */
  occurredAt?: Date;

  locationLabel?: string | null;
  locationCountry?: string | null;
  locationLatitude?: number | null;
  locationLongitude?: number | null;

  /** The carrier's own identifiers, kept verbatim even after mapping. */
  externalEventId?: string | null;
  externalStatusCode?: string | null;
  carrierIntegrationId?: string | null;

  /**
   * The caller's key.
   *
   * Absent means "this is a distinct event", and the event's own ULID is
   * stored - which makes the column NOT NULL and the UNIQUE index meaningful.
   * A MariaDB UNIQUE index treats every NULL as distinct, so a nullable column
   * here would enforce precisely nothing.
   */
  idempotencyKey?: string | null;

  /** An operator correction rather than a movement. */
  isCorrection?: boolean;

  /** Proof of Delivery exists, or accompanies this call. */
  hasProofOfDelivery?: boolean;

  exceptionId?: string | null;
  documentId?: string | null;

  /** Updated ETA, where the event moved it. */
  revisedEtaAt?: Date | null;

  correlationId?: string | null;
}

export interface ShipmentEventResult {
  eventId: string;
  shipmentId: string;
  previousStatus: ShipmentStatusName | null;
  status: ShipmentStatusName;
  occurredAt: Date;
  /**
   * True when this call changed nothing because an event with the same key
   * already existed.
   *
   * Returned rather than thrown, and the distinction matters to two different
   * callers: a carrier's webhook handler must answer 2xx so the carrier stops
   * retrying, and the portal must show "already recorded" rather than an
   * error. Both need to know, and neither needs to fail.
   */
  duplicate: boolean;
}

/**
 * The external key, which is what deduplicates a carrier feed.
 *
 * `"<provider>:<their id>"` where a carrier supplied one, and the event's own
 * ULID otherwise. Namespaced by provider because two carriers can and do issue
 * the same event id, and a global UNIQUE over un-namespaced ids would reject
 * the second carrier's events months after anybody remembers this column.
 */
function externalEventKeyFor(input: ShipmentEventInput, eventId: string): string {
  if ((input.externalEventId !== undefined && input.externalEventId !== null) && input.externalEventId.trim().length > 0) {
    const scope = input.carrierIntegrationId ?? 'carrier';
    return `${scope}:${input.externalEventId.trim()}`.slice(0, 200);
  }
  return eventId;
}

/**
 * Columns to set on the shipment for a given status.
 *
 * Milestone timestamps are written ONCE - `pickedUpAt` records the first
 * collection, not the most recent scan that happened to say PICKED_UP - which
 * is why each is guarded on being null. A parcel that goes back to a hub and
 * out again must not reset the clock the SLA is measured against.
 */
function milestoneColumns(
  status: ShipmentStatusName,
  occurredAt: Date,
  current: {
    acceptedAt: Date | null;
    pickedUpAt: Date | null;
    dispatchedAt: Date | null;
    deliveredAt: Date | null;
    deliveryAttemptCount: number;
  },
): Prisma.LogisticsShipmentUpdateInput {
  const data: Prisma.LogisticsShipmentUpdateInput = {};

  if (status === 'ACCEPTED' && current.acceptedAt === null) data.acceptedAt = occurredAt;
  if (status === 'PICKED_UP' && current.pickedUpAt === null) data.pickedUpAt = occurredAt;
  if (status === 'DISPATCHED' && current.dispatchedAt === null) data.dispatchedAt = occurredAt;

  if (status === 'DELIVERED') {
    data.deliveredAt = occurredAt;
    data.closedAt = occurredAt;
  }

  // Terminal in the other direction. `closedAt` is what takes a consignment
  // out of the SLA calculation: a written-off parcel is not "late", it is
  // over, and counting it would make a carrier's score worse every day it sat
  // in the table.
  if (status === 'CANCELLED' || status === 'LOST' || status === 'RETURNED') {
    data.closedAt = occurredAt;
  }

  if (status === 'DELIVERY_ATTEMPTED') {
    data.deliveryAttemptCount = current.deliveryAttemptCount + 1;
  }

  return data;
}

/**
 * Record one event, move the status, and do whatever follows.
 *
 * The whole of it is one transaction. An event with no status change, or a
 * status change with no event, is the shape of every timeline nobody can
 * reconcile afterwards.
 */
/**
 * How many times a deadlocked attempt is retried.
 *
 * Three, and the number is small on purpose. InnoDB's own advice for a
 * deadlock is "retry your transaction", and one retry settles almost every
 * real collision: by the time the loser comes back the winner has committed,
 * and the idempotency fast path answers immediately. Beyond three, something
 * other than a race is wrong and the caller should hear about it.
 */
const MAX_RACE_RETRIES = 3;

/**
 * Record one event, retrying a lost race.
 *
 * Two callers reaching the same UNIQUE index in the same instant do not
 * produce a clean constraint violation on InnoDB - the index takes a gap lock,
 * both wait, and the engine kills one of them with a deadlock. The loser may
 * come back BEFORE the winner has committed, so looking for the winner's row
 * immediately can find nothing.
 *
 * So a lost race is retried rather than resolved in place: on the next attempt
 * the winner has committed, the idempotency fast path finds their row, and the
 * caller gets a duplicate answer. An attempt that keeps losing is a real fault
 * and is thrown.
 */
export async function recordShipmentEvent(
  input: ShipmentEventInput,
): Promise<ShipmentEventResult> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptShipmentEvent(input);
    } catch (error) {
      if (!lostTheRace(error) || attempt >= MAX_RACE_RETRIES) throw error;

      // A short, growing pause. Long enough for the winner to commit, short
      // enough that a driver's phone does not notice.
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

async function attemptShipmentEvent(
  input: ShipmentEventInput,
): Promise<ShipmentEventResult> {
  const eventId = newId();
  const occurredAt = input.occurredAt ?? new Date();
  const suppliedKey = input.idempotencyKey ?? null;
  const idempotencyKey = (suppliedKey ?? eventId).slice(0, 64);
  const externalEventKey = externalEventKeyFor(input, eventId);

  /*
   * A retry is answered BEFORE the transition is checked, and that order is
   * the whole point.
   *
   * By the time a caller retries, the work is done and the shipment is already
   * in the status they asked for - so `assertShipmentTransition` would refuse
   * it as a move to the status it already holds. Refusing a retry is the same
   * mistake as processing it twice: a driver's phone told "that failed" tries
   * again, and a carrier told 4xx logs an integration error about a scan that
   * was accepted perfectly.
   *
   * Only for a caller who SUPPLIED a key, or a carrier who supplied an event
   * id. Without either there is nothing to be idempotent about, and two
   * genuinely separate scans of the same parcel are two events.
   *
   * This is a fast path, not the control. The UNIQUE indexes are the control,
   * and the catch below is what makes them one - two callers racing arrive
   * here at the same moment and both see nothing.
   */
  if (suppliedKey !== null || (input.externalEventId ?? '').length > 0) {
    const already = await findExistingEvent(input.shipmentId, idempotencyKey, externalEventKey);
    if (already !== null) return already;
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      const shipment = await tx.logisticsShipment.findUnique({
        where: { id: input.shipmentId },
        select: {
          id: true,
          status: true,
          version: true,
          acceptedAt: true,
          pickedUpAt: true,
          dispatchedAt: true,
          deliveredAt: true,
          deliveryAttemptCount: true,
          assignedPartnerId: true,
          orderId: true,
          shipmentReference: true,
          proofOfDelivery: { select: { id: true } },
        },
      });

      if (shipment === null) throw notFound('Shipment');

      const from = shipment.status;

      /*
       * The legality check.
       *
       * A correction takes the other door: it is the marketplace saying "the
       * record is wrong", which is a different act from a parcel moving, and
       * it is the only way out of DELIVERED, RETURNED, LOST or CANCELLED in
       * the wrong direction. It demands a written reason of its own.
       */
      if (input.isCorrection === true) {
        assertShipmentCorrection({
          from,
          to: input.status,
          actor: input.actor,
          ...((input.reason !== undefined && input.reason !== null) ? { reason: input.reason } : {}),
        });
      } else {
        assertShipmentTransition({
          from,
          to: input.status,
          actor: input.actor,
          permissions: input.permissions ?? [],
          ...((input.reason !== undefined && input.reason !== null) ? { reason: input.reason } : {}),
          hasProofOfDelivery:
            input.hasProofOfDelivery === true || shipment.proofOfDelivery !== null,
        });
      }

      // The insert that deduplicates. If this throws P2002 the work was
      // already done, and the catch below turns that into a success.
      await tx.logisticsShipmentEvent.create({
        data: {
          id: eventId,
          shipmentId: shipment.id,
          previousStatus: from,
          status: input.status,
          publicDescription: input.publicDescription ?? null,
          internalNote: input.internalNote ?? null,
          occurredAt,
          locationLabel: input.locationLabel ?? null,
          locationCountry: input.locationCountry ?? null,
          locationLatitude: input.locationLatitude ?? null,
          locationLongitude: input.locationLongitude ?? null,
          source: input.source,
          actorUserId: input.actorUserId ?? null,
          actorLogisticsPartnerId: input.actorLogisticsPartnerId ?? null,
          externalEventId: input.externalEventId ?? null,
          externalStatusCode: input.externalStatusCode ?? null,
          carrierIntegrationId: input.carrierIntegrationId ?? null,
          externalEventKey,
          idempotencyKey,
          isCorrection: input.isCorrection === true,
          reason: input.reason ?? null,
          exceptionId: input.exceptionId ?? null,
          documentId: input.documentId ?? null,
        },
      });

      /*
       * The status write, guarded on the version we read.
       *
       * A dispatcher and a webhook can touch one consignment in the same
       * second. Without this the loser overwrites the winner and the status
       * disagrees with the last event on the timeline. With it the loser sees
       * zero affected rows and retries against the new state.
       */
      const updated = await tx.logisticsShipment.updateMany({
        where: { id: shipment.id, version: shipment.version },
        data: {
          status: input.status,
          lastEventAt: occurredAt,
          version: { increment: 1 },
          ...((input.revisedEtaAt !== undefined && input.revisedEtaAt !== null) ? { estimatedDeliveryAt: input.revisedEtaAt } : {}),
          ...(milestoneColumns(input.status, occurredAt, shipment) as Prisma.LogisticsShipmentUpdateManyMutationInput),
        },
      });

      if (updated.count !== 1) {
        throw conflict(
          ErrorCode.CONFLICT,
          'This shipment was changed by somebody else a moment ago. Reload and try again.',
          [{ code: 'VERSION_CONFLICT' }],
        );
      }

      /*
       * A finished consignment is finished for its driver too.
       *
       * Inside the transaction, because "delivered" and "off the driver's task
       * list" are one fact: a delivered parcel that stayed on somebody's round
       * because a second write failed is a stop a driver would go and look
       * for. It also clears `activeShipmentId`, so a consignment later
       * corrected out of a terminal status can be given to a driver again
       * without the unique index refusing it.
       */
      if (isTrackingComplete(input.status)) {
        await completeDriverAssignmentsFor(shipment.id, tx);
      }

      if (shipment.assignedPartnerId !== null) {
        await recordLogisticsAudit(
          {
            logisticsPartnerId: shipment.assignedPartnerId,
            actorUserId: input.actorUserId ?? null,
            actorLabel: input.actorLabel ?? sourceLabel(input.source),
            action: input.isCorrection === true
              ? 'logistics.shipment.corrected'
              : 'logistics.shipment.status_changed',
            resourceType: 'logistics_shipment',
            resourceId: shipment.id,
            before: { status: from },
            after: { status: input.status },
            summary:
              `${shipment.shipmentReference} moved from ${from} to ${input.status}` +
              ((input.reason !== undefined && input.reason !== null) ? `: ${input.reason}` : '.'),
            correlationId: input.correlationId ?? null,
          },
          tx,
        );
      }

      return {
        eventId,
        shipmentId: shipment.id,
        previousStatus: from,
        status: input.status,
        occurredAt,
        duplicate: false,
        orderId: shipment.orderId,
        partnerId: shipment.assignedPartnerId,
      };
    });

    /*
     * Consequences, outside the transaction.
     *
     * Deliberately after the commit rather than inside it. A notification that
     * could not be queued, or an order transition the order state machine
     * refuses, must not roll back the fact that a parcel was collected - the
     * parcel WAS collected, and a timeline that denies it is worse than a
     * missing email.
     */
    await propagateToOrder(result.orderId, input);
    await notifyShipmentEvent({
      shipmentId: result.shipmentId,
      logisticsPartnerId: result.partnerId,
      status: result.status,
      eventId: result.eventId,
    });
    await syncOperationsAlert(result.shipmentId, result.status);
    await tellTheBuyer(result.shipmentId, result.status);

    return {
      eventId: result.eventId,
      shipmentId: result.shipmentId,
      previousStatus: result.previousStatus,
      status: result.status,
      occurredAt: result.occurredAt,
      duplicate: false,
    };
  } catch (error) {
    if (!lostTheRace(error)) throw error;

    /*
     * Somebody got there first. If they have committed, their row is the
     * answer and this was a duplicate all along.
     */
    const existing = await findExistingEvent(input.shipmentId, idempotencyKey, externalEventKey);
    if (existing !== null) return existing;

    /*
     * Nothing there yet.
     *
     * Either the winner has not committed, or this was not our race at all -
     * a deadlock between two transactions writing DIFFERENT events on the same
     * shipment. Both are answered the same way: rethrow, and let the wrapper
     * try again. A caller told "already recorded" for an event nobody recorded
     * would stop retrying something that still has to happen.
     */
    throw error;
  }
}

/**
 * Let a shipment milestone move the ORDER, and nothing else.
 *
 * This is the whole inventory integration, and what it does not do is the
 * point. It writes no balance, no movement and no reservation. It asks the
 * order state machine to move the order, and the order state machine does what
 * it already does - commits reservations, releases them, restocks a return -
 * with all of its existing idempotency intact.
 *
 * Three consequences of doing it this way:
 *
 *   - A duplicate shipment event cannot produce a duplicate inventory
 *     movement, because it cannot produce a second order transition:
 *     `assertTransition` refuses `SHIPPED -> SHIPPED`.
 *   - An order made of several consignments is not marked delivered by the
 *     first one. `allDeliveredFor` checks the others first.
 *   - A refusal is swallowed and logged rather than thrown. The order may
 *     legitimately be somewhere the transition is illegal - already cancelled,
 *     already delivered by another route - and a carrier must not be told
 *     their scan failed because of a state on the commerce side they cannot
 *     see or fix.
 */
async function propagateToOrder(
  orderId: string | null,
  input: ShipmentEventInput,
): Promise<void> {
  if (orderId === null) return;

  const to =
    input.status === 'PICKED_UP' || input.status === 'DISPATCHED'
      ? 'SHIPPED'
      : input.status === 'DELIVERED'
        ? 'DELIVERED'
        : null;

  if (to === null) return;

  // Every consignment on this order has to be there before the order is.
  if (to === 'DELIVERED' && !(await allDeliveredFor(orderId))) return;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { status: true },
  });

  if (order === null) return;

  /*
   * One rung at a time, because the order state machine has no jumps in it.
   *
   * `assertTransition` offers CONFIRMED -> PROCESSING -> SHIPPED -> DELIVERED
   * and no shortcuts, deliberately, so the buyer's timeline reads as a
   * sequence rather than a leap. Asking for the far rung is therefore refused
   * - and since a refusal here is swallowed on purpose (see above), asking for
   * it directly meant a collected parcel left the buyer looking at "Confirmed"
   * for ever, with only an info log to say why.
   *
   * The seller path already walks this ladder in `syncOrderWithSellerGroups`,
   * and the operator's own dispatch walks it in the fulfilment service. This
   * is the third caller doing the same thing, for the same reason.
   */
  // Widened for the lookup: `order.status` is any OrderStatusName, and the
  // whole point of the next line is to find out whether it is a rung at all.
  const from = (LADDER as readonly OrderStatusName[]).indexOf(order.status);

  // Somewhere off the ladder entirely - CANCELLED, RETURNED, REFUNDED. A
  // carrier's scan must not resurrect an order staff have closed, and without
  // this an index of -1 would slice from the first rung and try to.
  if (from === -1) return;

  const steps = LADDER.slice(from + 1, LADDER.indexOf(to) + 1);

  for (const step of steps) {
    try {
      await transitionOrder({
        orderId,
        to: step,
        // The buyer reads this on their order. Every other entry in that
        // timeline carries a line saying what happened, and a blank one in the
        // middle of the sequence reads like something went wrong.
        reason: LADDER_REASONS[step],
        actor: {
          userId: input.actorUserId ?? null,
          email: null,
          // SYSTEM, always. A carrier is not an actor on the commerce side, and
          // giving it ADMIN there would let a transition rule written for staff
          // be satisfied by a courier's scan.
          type: 'SYSTEM',
          ...((input.correlationId !== undefined && input.correlationId !== null) ? { correlationId: input.correlationId } : {}),
        },
      });
    } catch (error) {
      logger.info(
        { orderId, to: step, shipmentId: input.shipmentId, err: error },
        'shipment milestone did not move the order',
      );
      // A rung that will not move makes the ones above it unreachable too.
      return;
    }
  }
}

/**
 * The marketplace's own bell, for a delivery that did not happen.
 *
 * WHY THIS ONE AND NOT THE OTHERS
 *
 * A carrier works holds, customs and address corrections in their own portal
 * and the operator has nothing to do about them - a bell that rings for every
 * one is a bell nobody reads, and the one that gets ignored is the batch of
 * reagents that went warm. A FAILED delivery is different: it is the buyer's
 * problem as much as the carrier's, it is the call the marketplace answers,
 * and there is a decision on the marketplace's side about what to do next.
 *
 * Keyed on the consignment rather than on the attempt, so a second failed
 * attempt does not add a second row to chase - the alert says "this parcel is
 * not being delivered", which stays one fact however many times a van calls.
 *
 * **Cleared by the parcel moving**, and by nothing else: re-attempted,
 * delivered, sent back or cancelled. Reading about a failed delivery has never
 * fixed one.
 *
 * Outside the transaction, like every other consequence here. An alert that
 * could not be written must not roll back the record of what the van reported.
 */
async function syncOperationsAlert(shipmentId: string, status: ShipmentStatusName): Promise<void> {
  const resolutionKey = ResolutionKey.shipmentDelivery(shipmentId);

  if (status !== 'DELIVERY_FAILED') {
    // Every other status means it is moving again, or it is over. Either way
    // there is nothing left on the operator's desk about this one.
    await resolveAdminNotifications({
      resolutionKey,
      reason: `The consignment moved on to ${status.toLowerCase().replace(/_/g, ' ')}.`,
      source: 'DOMAIN_EVENT',
    });
    return;
  }

  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: {
      shipmentReference: true,
      receivingCompanyName: true,
      deliveryAttemptCount: true,
    },
  });

  if (shipment === null) return;

  await createAdminNotification({
    kind: AdminNotificationKind.LOGISTICS_DELIVERY_FAILED,
    variables: {
      shipmentReference: shipment.shipmentReference,
      receivingCompany: shipment.receivingCompanyName,
      attemptCount: shipment.deliveryAttemptCount,
      reason: '',
    },
    linkPath: `/logistics/shipments/${shipmentId}`,
    // Names a customer's company and what went wrong with their delivery, so
    // it carries the same grant the consignment screen itself is behind.
    requiredPermission: Permission.LOGISTICS_READ,
    relatedType: 'logistics_shipment',
    relatedId: shipmentId,
    dedupeKey: `shipment-delivery-failed:${shipmentId}`,
    resolutionKey,
  });
}

/** The rungs of that route, and nothing else an order can be. */
type FulfilmentRung = 'CONFIRMED' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED';

/** The only route an order takes through fulfilment, in order. */
const LADDER: readonly FulfilmentRung[] = Object.freeze([
  'CONFIRMED',
  'PROCESSING',
  'SHIPPED',
  'DELIVERED',
]);

/**
 * What the buyer is told about each rung, when a carrier is what moved it.
 *
 * Written from the buyer's side of the glass. They did not ask for a
 * consignment and have never heard of one, so these say what happened to their
 * order rather than what happened to a row in the logistics module.
 *
 * Each sits under the status label on the buyer's timeline - "Being prepared",
 * "On its way", "Delivered" - so none of them repeats it. A line that only
 * says the heading again is worse than no line.
 *
 * CONFIRMED is here to satisfy the record and is never reached: the walk
 * always starts at the rung above wherever the order already is, and CONFIRMED
 * is the lowest rung there is.
 */
const LADDER_REASONS: Readonly<Record<FulfilmentRung, string>> = Object.freeze({
  CONFIRMED: 'Payment received',
  PROCESSING: 'A carrier has collected this order',
  SHIPPED: 'With the carrier, on the way to you',
  DELIVERED: 'The carrier confirmed the delivery',
});

/** Are all of this order's consignments delivered? */
async function allDeliveredFor(orderId: string): Promise<boolean> {
  const outstanding = await prisma.logisticsShipment.count({
    where: {
      orderId,
      status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED', 'LOST'] },
    },
  });

  return outstanding === 0;
}

/**
 * Tell the buyer a consignment reached a milestone they care about.
 *
 * Four milestones, no more: a buyer does not need an email per hub scan. The
 * dedupe key is the consignment and the milestone, so a carrier reporting
 * IN_TRANSIT six times sends one email, and a redelivered webhook sends none.
 * The carrier named is the company whose van it is; a driver's name and the
 * carrier's internal notes never appear.
 *
 * After the commit and never throwing, like every consequence here.
 */
async function tellTheBuyer(shipmentId: string, status: ShipmentStatusName): Promise<void> {
  const eventKey =
    status === 'PICKED_UP'
      ? NotificationEvent.SHIPMENT_PICKED_UP
      : status === 'IN_TRANSIT'
        ? NotificationEvent.SHIPMENT_IN_TRANSIT
        : status === 'OUT_FOR_DELIVERY'
          ? NotificationEvent.SHIPMENT_OUT_FOR_DELIVERY
          : status === 'DELIVERED'
            ? NotificationEvent.SHIPMENT_DELIVERED
            : null;

  if (eventKey === null) return;

  try {
    const shipment = await prisma.logisticsShipment.findUnique({
      where: { id: shipmentId },
      select: {
        shipmentReference: true,
        orderId: true,
        carrierTrackingNumber: true,
        assignedPartner: { select: { displayName: true } },
        manualCarrierBookings: {
          where: { activeShipmentId: { not: null } },
          select: { provider: true },
        },
        order: {
          select: {
            orderNumber: true,
            customerProfile: { select: { fullName: true, user: { select: { email: true } } } },
            _count: { select: { logisticsShipments: true } },
          },
        },
      },
    });

    if (shipment === null || shipment.order === null || shipment.orderId === null) return;

    // One consignment: the order's own "shipped" email already said this.
    if (status === 'PICKED_UP' && shipment.order._count.logisticsShipments <= 1) return;

    const provider = shipment.manualCarrierBookings[0]?.provider;
    const carrier =
      shipment.assignedPartner?.displayName ??
      (provider === 'DHL' ? 'DHL' : provider === 'FEDEX' ? 'FedEx' : provider === 'INDIA_POST' ? 'India Post' : 'the carrier');

    await enqueueNotification({
      eventKey,
      recipientEmail: shipment.order.customerProfile.user.email,
      recipientName: shipment.order.customerProfile.fullName,
      variables: {
        orderNumber: shipment.order.orderNumber,
        shipmentReference: shipment.shipmentReference,
        carrier,
        trackingLine:
          shipment.carrierTrackingNumber === null
            ? ''
            : `${carrier} tracking number: ${shipment.carrierTrackingNumber}\n\n`,
        orderUrl: `/orders/${shipment.orderId}`,
      },
      dedupeKey: `consignment:${shipmentId}:${status}`,
      relatedType: 'logistics_shipment',
      relatedId: shipmentId,
    });
  } catch (error) {
    logger.warn({ err: error, shipmentId, status }, 'could not tell the buyer about a consignment milestone');
  }
}

function sourceLabel(source: LogisticsEventSource): string {
  switch (source) {
    case 'LOGISTICS_PORTAL':
      return 'Portal';
    case 'DRIVER_APP':
      return 'Driver app';
    case 'UBOSS_ADMIN':
      return 'UBOSS operations';
    case 'CARRIER_API':
      return 'Carrier API';
    case 'INBOUND_WEBHOOK':
      return 'Carrier webhook';
    case 'SYSTEM_AUTOMATION':
      return 'Automatic';
    case 'SELLER_PORTAL':
      return 'Seller (entered by hand)';
  }
}

// ---------------------------------------------------------------------------
// Reading the timeline
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  id: string;
  previousStatus: ShipmentStatusName | null;
  status: ShipmentStatusName;
  publicDescription: string | null;
  /** Null for a caller without operations authority. */
  internalNote: string | null;
  reason: string | null;
  occurredAt: Date;
  recordedAt: Date;
  locationLabel: string | null;
  locationCountry: string | null;
  source: LogisticsEventSource;
  /** The carrier's own code, preserved even after it was mapped. */
  externalStatusCode: string | null;
  isCorrection: boolean;
  isException: boolean;
  documentId: string | null;
  exceptionId: string | null;
}

/**
 * One consignment's timeline, oldest first.
 *
 * Ordered by `occurredAt` and NOT by `recordedAt`. The two differ by hours on
 * a polled integration, and a timeline sorted by when we heard about things
 * reads as though the parcel went backwards. `recordedAt` is returned beside
 * it so the portal can say "reported 3 hours later", which is the honest way
 * to show a late scan.
 *
 * `includeInternal` is decided by the ROUTE from the caller's permissions, not
 * here, so a read-only tracking viewer cannot be handed an operations note by
 * a service that guessed.
 */
export async function readTimeline(
  shipmentId: string,
  options: { includeInternal: boolean; limit?: number },
): Promise<TimelineEntry[]> {
  const rows = await prisma.logisticsShipmentEvent.findMany({
    where: { shipmentId },
    orderBy: [{ occurredAt: 'asc' }, { recordedAt: 'asc' }],
    take: Math.min(Math.max(options.limit ?? 500, 1), 1000),
    select: {
      id: true,
      previousStatus: true,
      status: true,
      publicDescription: true,
      internalNote: true,
      reason: true,
      occurredAt: true,
      recordedAt: true,
      locationLabel: true,
      locationCountry: true,
      source: true,
      externalStatusCode: true,
      isCorrection: true,
      documentId: true,
      exceptionId: true,
    },
  });

  return rows.map((row) => ({
    ...row,
    previousStatus: (row.previousStatus) ?? null,
    status: row.status,
    internalNote: options.includeInternal ? row.internalNote : null,
    isException: isShipmentException(row.status),
  }));
}

/**
 * Write an event inside somebody else's transaction.
 *
 * Used by the assignment service, which has to move a shipment to ASSIGNED and
 * write the assignment row atomically. Deliberately thin: it does NOT
 * propagate to the order and does NOT notify, because a caller that owns the
 * transaction owns those decisions too and doing them from inside one would
 * mean sending an email for a change that might still roll back.
 */
export async function appendEventInTransaction(
  tx: PrismaTransaction,
  params: {
    shipmentId: string;
    from: ShipmentStatusName;
    to: ShipmentStatusName;
    source: LogisticsEventSource;
    actorUserId?: string | null;
    actorLogisticsPartnerId?: string | null;
    publicDescription?: string | null;
    internalNote?: string | null;
    reason?: string | null;
    occurredAt?: Date;
  },
): Promise<string> {
  const eventId = newId();

  await tx.logisticsShipmentEvent.create({
    data: {
      id: eventId,
      shipmentId: params.shipmentId,
      previousStatus: params.from,
      status: params.to,
      publicDescription: params.publicDescription ?? null,
      internalNote: params.internalNote ?? null,
      reason: params.reason ?? null,
      occurredAt: params.occurredAt ?? new Date(),
      source: params.source,
      actorUserId: params.actorUserId ?? null,
      actorLogisticsPartnerId: params.actorLogisticsPartnerId ?? null,
      externalEventKey: eventId,
      idempotencyKey: eventId,
    },
  });

  return eventId;
}
