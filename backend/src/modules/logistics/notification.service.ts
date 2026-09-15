/**
 * Telling a carrier something.
 *
 * Two channels, one row. `LogisticsNotification` is the in-app feed AND the
 * record an email was sent from, so "was this person told?" has one answer
 * rather than two that can disagree.
 *
 * THE DEDUPLICATION RULE
 *
 * Requirement 16 of the brief - duplicate provider events must not produce
 * duplicate notifications - is expressed as a UNIQUE index rather than as a
 * code path: `(logisticsPartnerId, kind, dedupeKey)`. A carrier redelivering
 * the same tracking event produces the same key, the insert is refused, and
 * nothing is sent. There is no check-then-insert to lose a race in, which
 * matters because a carrier redelivering a webhook does it twice in the same
 * second rather than politely spaced out.
 *
 * The key is the identity of the THING being announced - the event id, the
 * assignment id, the exception id - and never a timestamp, because a timestamp
 * makes every retry unique, which is the opposite of the point.
 *
 * NOTHING HERE THROWS INTO ITS CALLER. A notification is a consequence of work
 * that has already happened; failing a driver's "collected" scan because an
 * email queue was full would be reporting a failure that did not occur.
 */
import type { LogisticsNotificationKind } from '../../generated/prisma/enums.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

export interface LogisticsNotificationInput {
  logisticsPartnerId: string;
  /** Null addresses the whole organisation rather than one person. */
  partnerUserId?: string | null;
  shipmentId?: string | null;
  kind: LogisticsNotificationKind;
  title: string;
  body?: string | null;
  /** Variables for the translated template, so the row renders in any locale. */
  variables?: Record<string, string | number | boolean | null>;
  /** The identity of the thing being announced. Never a timestamp. */
  dedupeKey: string;
}

/**
 * Queue one notification, or do nothing because it is already queued.
 *
 * Returns whether a row was actually written, so a caller that wants to know
 * whether it is the one that announced something can find out - the webhook
 * ingestion uses it to decide whether to raise an operations alert.
 */
export async function createLogisticsNotification(
  input: LogisticsNotificationInput,
): Promise<{ created: boolean; id: string | null }> {
  const id = newId();

  try {
    await prisma.logisticsNotification.create({
      data: {
        id,
        logisticsPartnerId: input.logisticsPartnerId,
        partnerUserId: input.partnerUserId ?? null,
        shipmentId: input.shipmentId ?? null,
        kind: input.kind,
        title: input.title.slice(0, 200),
        body: input.body?.slice(0, 1000) ?? null,
        variablesJson: input.variables ?? undefined,
        dedupeKey: input.dedupeKey.slice(0, 120),
      },
    });

    return { created: true, id };
  } catch (error) {
    // P2002: the same thing has already been announced. That is a success.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      return { created: false, id: null };
    }

    logger.warn({ err: error, kind: input.kind }, 'logistics notification could not be queued');
    return { created: false, id: null };
  }
}

/**
 * Which status changes are worth telling somebody about, and how they are
 * worded.
 *
 * Not every status is here, and the omissions are deliberate: AT_ORIGIN_HUB
 * and AT_DESTINATION_HUB are internal movements a dispatcher can see on the
 * timeline and does not need an alert for. A feed that announces everything is
 * a feed nobody reads, and the one that gets ignored is the cold-chain
 * excursion.
 */
const STATUS_NOTIFICATIONS: Readonly<
  Partial<Record<ShipmentStatusName, { kind: LogisticsNotificationKind; title: string }>>
> = Object.freeze({
  ACCEPTED: { kind: 'ASSIGNMENT_ACCEPTED', title: 'Assignment accepted' },
  PICKUP_SCHEDULED: { kind: 'PICKUP_SCHEDULED', title: 'Pickup scheduled' },
  PICKED_UP: { kind: 'PICKUP_COMPLETED', title: 'Collected' },
  DISPATCHED: { kind: 'SHIPMENT_DISPATCHED', title: 'Dispatched' },
  IN_TRANSIT: { kind: 'SHIPMENT_IN_TRANSIT', title: 'In transit' },
  OUT_FOR_DELIVERY: { kind: 'OUT_FOR_DELIVERY', title: 'Out for delivery' },
  DELIVERED: { kind: 'SHIPMENT_DELIVERED', title: 'Delivered' },
  DELIVERY_ATTEMPTED: { kind: 'DELIVERY_ATTEMPTED', title: 'Delivery attempted' },
  DELAYED: { kind: 'SHIPMENT_DELAYED', title: 'Delayed' },
  ON_HOLD: { kind: 'EXCEPTION_RAISED', title: 'On hold' },
  ADDRESS_ISSUE: { kind: 'EXCEPTION_RAISED', title: 'Address problem' },
  CUSTOMS_HOLD: { kind: 'EXCEPTION_RAISED', title: 'Held at customs' },
  DAMAGED: { kind: 'EXCEPTION_RAISED', title: 'Damage reported' },
  TEMPERATURE_EXCEPTION: { kind: 'EXCEPTION_RAISED', title: 'Temperature excursion' },
  DELIVERY_FAILED: { kind: 'EXCEPTION_RAISED', title: 'Delivery failed' },
  LOST: { kind: 'EXCEPTION_RAISED', title: 'Consignment lost' },
  RETURN_REQUESTED: { kind: 'RETURN_INITIATED', title: 'Return requested' },
});

/**
 * Announce a status change, if it is one worth announcing.
 *
 * The dedupe key is the EVENT id, which is already unique and already
 * deduplicated upstream by `recordShipmentEvent`. So a redelivered webhook
 * that resolved to an existing event never reaches here at all, and one that
 * somehow did would be refused by the index. Two locks on the same door,
 * because this is the door that emails people.
 */
export async function notifyShipmentEvent(params: {
  shipmentId: string;
  logisticsPartnerId: string | null;
  status: ShipmentStatusName;
  eventId: string;
}): Promise<void> {
  if (params.logisticsPartnerId === null) return;

  const template = STATUS_NOTIFICATIONS[params.status];
  if (template === undefined) return;

  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: params.shipmentId },
    select: { shipmentReference: true, receivingCompanyName: true, destinationCity: true },
  });

  if (shipment === null) return;

  await createLogisticsNotification({
    logisticsPartnerId: params.logisticsPartnerId,
    shipmentId: params.shipmentId,
    kind: template.kind,
    title: `${shipment.shipmentReference}: ${template.title}`,
    body: `${shipment.receivingCompanyName}${
      shipment.destinationCity === null ? '' : `, ${shipment.destinationCity}`
    }`,
    variables: {
      shipmentReference: shipment.shipmentReference,
      status: params.status,
      receivingCompany: shipment.receivingCompanyName,
    },
    dedupeKey: `event:${params.eventId}`,
  });
}

export interface LogisticsNotificationView {
  id: string;
  kind: LogisticsNotificationKind;
  title: string;
  body: string | null;
  shipmentId: string | null;
  shipmentReference: string | null;
  readAt: Date | null;
  createdAt: Date;
}

export interface LogisticsNotificationFeed {
  notifications: LogisticsNotificationView[];
  unreadCount: number;
}

/** How many rows the bell ever shows. Beyond this, a person needs a list. */
export const MAX_LOGISTICS_FEED = 50;

/**
 * One person's feed.
 *
 * Their own notifications plus the organisation's. `partnerUserId: null` means
 * "everybody here", which is how an assignment offer reaches whichever
 * dispatcher is on shift rather than whichever one happened to be named.
 */
export async function listLogisticsNotifications(
  logisticsPartnerId: string,
  partnerUserId: string,
): Promise<LogisticsNotificationFeed> {
  const where = {
    logisticsPartnerId,
    OR: [{ partnerUserId }, { partnerUserId: null }],
  };

  const [rows, unreadCount] = await Promise.all([
    prisma.logisticsNotification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: MAX_LOGISTICS_FEED,
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        shipmentId: true,
        readAt: true,
        createdAt: true,
        shipment: { select: { shipmentReference: true } },
      },
    }),
    prisma.logisticsNotification.count({ where: { ...where, readAt: null } }),
  ]);

  return {
    notifications: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      shipmentId: row.shipmentId,
      shipmentReference: row.shipment?.shipmentReference ?? null,
      readAt: row.readAt,
      createdAt: row.createdAt,
    })),
    unreadCount,
  };
}

/**
 * Mark some, or all, as read.
 *
 * The tenant filter is in the `where`, so an id from another carrier's feed
 * simply matches nothing. `updateMany` rather than `update` for exactly that
 * reason: `update` on a foreign id would throw a not-found that confirms the
 * row exists somewhere.
 */
export async function markLogisticsNotificationsRead(
  logisticsPartnerId: string,
  partnerUserId: string,
  ids: readonly string[] | null,
): Promise<number> {
  const result = await prisma.logisticsNotification.updateMany({
    where: {
      logisticsPartnerId,
      OR: [{ partnerUserId }, { partnerUserId: null }],
      readAt: null,
      ...(ids !== null && ids.length > 0 ? { id: { in: [...ids] } } : {}),
    },
    data: { readAt: new Date() },
  });

  return result.count;
}
