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
import type {
  AdminNotificationClass,
  AdminNotificationResolutionSource,
  LogisticsNotificationKind,
} from '../../generated/prisma/enums.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ShipmentStatusName } from '../../domain/logistics-shipment-state.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';

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
  /**
   * News or problem. Defaults to news.
   *
   * The same split the operator's bell draws, and for the same reason: "your
   * parcel was collected" is over the moment it is read, and "the delivery
   * failed" is not over until the parcel moves again. See the header of
   * `notifications/admin-notification.service.ts` for the full reasoning.
   */
  class?: AdminNotificationClass;
  /**
   * What problem an ALERT is about, so one domain event can close every
   * occurrence of it. Required for an ALERT and ignored for news.
   */
  resolutionKey?: string;
}

/**
 * Queue one notification, or do nothing because it is already queued.
 *
 * Returns whether a row was actually written, so a caller that wants to know
 * whether it is the one that announced something can find out - the webhook
 * ingestion uses it to decide whether to raise an operations alert.
 *
 * Takes the caller's transaction where there is one. An alert raised inside
 * the transaction that recorded the problem cannot be lost by a failure
 * afterwards, which matters more now that the same alert is what a dispatcher
 * works from rather than only a line in a feed.
 */
export async function createLogisticsNotification(
  input: LogisticsNotificationInput,
  tx?: PrismaTransaction,
): Promise<{ created: boolean; id: string | null }> {
  const id = newId();
  const client = tx ?? prisma;
  const isAlert = (input.class ?? 'INFORMATION') === 'ALERT';

  if (isAlert && (input.resolutionKey ?? '') === '') {
    throw new Error(`logistics notification kind "${input.kind}" is an alert and needs a resolutionKey`);
  }

  try {
    await client.logisticsNotification.create({
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
        class: input.class ?? 'INFORMATION',
        status: 'ACTIVE',
        resolutionKey: isAlert ? (input.resolutionKey?.slice(0, 120) ?? null) : null,
      },
    });

    return { created: true, id };
  } catch (error) {
    // P2002: the same thing has already been announced. That is a success.
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
      return { created: false, id: null };
    }

    /*
     * Inside a caller's transaction a failure is theirs to see: swallowing it
     * would leave the transaction marked aborted by MariaDB and the caller
     * committing something that cannot commit. Standalone it stays
     * best-effort, because a notification is a consequence of work that has
     * already happened.
     */
    if (tx !== undefined) throw error;

    logger.warn({ err: error, kind: input.kind }, 'logistics notification could not be queued');
    return { created: false, id: null };
  }
}

/**
 * Close every live carrier alert about one problem.
 *
 * The mirror of `resolveAdminNotifications`, and called from the same place at
 * the same moment - a domain event that fixes something closes the alert on
 * both consoles or neither. Idempotent for the same reason: `updateMany`
 * filtered on ACTIVE writes nothing the second time, so a retried worker and a
 * double-pressed button land on one answer and the first resolution's reason
 * survives.
 */
export async function resolveLogisticsNotifications(
  input: {
    resolutionKey: string;
    reason: string;
    source: AdminNotificationResolutionSource;
    resolvedByUserId?: string | null;
  },
  tx?: PrismaTransaction,
): Promise<number> {
  const client = tx ?? prisma;

  const run = async (): Promise<number> => {
    const result = await client.logisticsNotification.updateMany({
      where: { resolutionKey: input.resolutionKey, class: 'ALERT', status: 'ACTIVE' },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        resolvedByUserId: input.resolvedByUserId ?? null,
        resolutionReason: input.reason.slice(0, 512),
        resolutionSource: input.source,
      },
    });

    return result.count;
  };

  if (tx !== undefined) return run();

  try {
    return await run();
  } catch (error) {
    logger.warn(
      { err: error, resolutionKey: input.resolutionKey },
      'logistics notifications could not be resolved',
    );
    return 0;
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
interface StatusNotification {
  kind: LogisticsNotificationKind;
  title: string;
  /**
   * Whether this status means something is WRONG with the consignment.
   *
   * A problem stays on the carrier's list until the parcel moves again; a
   * milestone is over once it has been read. See the file header. The flag is
   * here rather than derived from the kind because `EXCEPTION_RAISED` is used
   * for both a temperature excursion and an ordinary hold, and only one of
   * those should sit on a badge.
   */
  problem?: true;
}

const STATUS_NOTIFICATIONS: Readonly<Partial<Record<ShipmentStatusName, StatusNotification>>> =
  Object.freeze({
    ACCEPTED: { kind: 'ASSIGNMENT_ACCEPTED', title: 'Assignment accepted' },
    PICKUP_SCHEDULED: { kind: 'PICKUP_SCHEDULED', title: 'Pickup scheduled' },
    PICKED_UP: { kind: 'PICKUP_COMPLETED', title: 'Collected' },
    DISPATCHED: { kind: 'SHIPMENT_DISPATCHED', title: 'Dispatched' },
    IN_TRANSIT: { kind: 'SHIPMENT_IN_TRANSIT', title: 'In transit' },
    OUT_FOR_DELIVERY: { kind: 'OUT_FOR_DELIVERY', title: 'Out for delivery' },
    DELIVERED: { kind: 'SHIPMENT_DELIVERED', title: 'Delivered' },
    DELIVERY_ATTEMPTED: { kind: 'DELIVERY_ATTEMPTED', title: 'Delivery attempted' },
    DELAYED: { kind: 'SHIPMENT_DELAYED', title: 'Delayed', problem: true },
    ON_HOLD: { kind: 'EXCEPTION_RAISED', title: 'On hold', problem: true },
    ADDRESS_ISSUE: { kind: 'EXCEPTION_RAISED', title: 'Address problem', problem: true },
    CUSTOMS_HOLD: { kind: 'EXCEPTION_RAISED', title: 'Held at customs', problem: true },
    DAMAGED: { kind: 'EXCEPTION_RAISED', title: 'Damage reported', problem: true },
    TEMPERATURE_EXCEPTION: {
      kind: 'EXCEPTION_RAISED',
      title: 'Temperature excursion',
      problem: true,
    },
    DELIVERY_FAILED: { kind: 'EXCEPTION_RAISED', title: 'Delivery failed', problem: true },
    LOST: { kind: 'EXCEPTION_RAISED', title: 'Consignment lost', problem: true },
    RETURN_REQUESTED: { kind: 'RETURN_INITIATED', title: 'Return requested' },
  });

/**
 * What a consignment is in trouble about, as one key.
 *
 * Keyed on the SHIPMENT rather than on each status, and that is the right
 * granularity here: a parcel that is delayed and then held at customs has one
 * problem - it is not moving - and two badges for it would be two things to
 * clear for one fix. That is the opposite of the exception alerts next door,
 * which are keyed per exception because a customs hold and a temperature
 * excursion genuinely are two problems with two answers.
 */
export function shipmentTroubleKey(shipmentId: string): string {
  return `shipment-trouble:${shipmentId}`;
}

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
  const isProblem = template?.problem === true;

  /*
   * The parcel is moving again, so whatever it was stuck on is over.
   *
   * Run BEFORE the new row is written and for every status that is not itself
   * a problem - including the ones with no notification template at all, like
   * AT_ORIGIN_HUB. Those are not worth announcing and they are very much worth
   * clearing: a consignment that was delayed and has reached a hub is a
   * consignment nobody needs to chase.
   */
  if (!isProblem) {
    await resolveLogisticsNotifications({
      resolutionKey: shipmentTroubleKey(params.shipmentId),
      reason: `Moved on to ${params.status.toLowerCase().replace(/_/g, ' ')}.`,
      source: 'DOMAIN_EVENT',
    });
  }

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
    // A milestone is news; a hold, a failure or an excursion is a problem that
    // stays on the list until the parcel moves.
    ...(isProblem
      ? { class: 'ALERT' as const, resolutionKey: shipmentTroubleKey(params.shipmentId) }
      : {}),
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

  /** News or problem. Decides how the row leaves the list. */
  class: AdminNotificationClass;
  status: 'ACTIVE' | 'RESOLVED' | 'ARCHIVED';
  resolvedAt: Date | null;
  resolutionReason: string | null;
}

export interface LogisticsNotificationFeed {
  notifications: LogisticsNotificationView[];
  unreadCount: number;
  /**
   * The badge: unread news plus live problems.
   *
   * The same active-alert rule the marketplace's own console follows, so a
   * dispatcher and an operator looking at the same consignment are counting
   * the same way. See
   * `backend/src/modules/notifications/admin-notification.service.ts`.
   */
  activeCount: number;
  /** Live problems alone. */
  openAlertCount: number;
}

/** How many rows the bell ever shows. Beyond this, a person needs a list. */
export const MAX_LOGISTICS_FEED = 50;

/** Which half of a carrier's feed to read. */
export type LogisticsFeedView = 'active' | 'resolved' | 'all';

/**
 * One person's feed.
 *
 * Their own notifications plus the organisation's. `partnerUserId: null` means
 * "everybody here", which is how an assignment offer reaches whichever
 * dispatcher is on shift rather than whichever one happened to be named.
 *
 * A carrier notification has no per-reader dismissal, unlike the marketplace's
 * console, and the reason is structural rather than an omission: a row here is
 * addressed either to one member or to the whole organisation, so there is no
 * shared row for one person to hide from themselves. Resolution still reaches
 * everybody, because a delivery that was re-attempted was re-attempted for
 * every dispatcher looking at it.
 */
export async function listLogisticsNotifications(
  logisticsPartnerId: string,
  partnerUserId: string,
  view: LogisticsFeedView = 'active',
): Promise<LogisticsNotificationFeed> {
  /*
   * Everything this person is addressed by: their own rows and the
   * organisation's. Written as an AND member rather than a spread `OR`, so the
   * live/resolved clauses below can use `OR` for their own purpose without
   * silently replacing the audience filter - which would have shown one
   * carrier's dispatcher the whole table.
   */
  const audience: Prisma.LogisticsNotificationWhereInput = {
    logisticsPartnerId,
    OR: [{ partnerUserId }, { partnerUserId: null }],
  };

  const live: Prisma.LogisticsNotificationWhereInput = {
    AND: [
      audience,
      {
        OR: [
          // News nobody has read.
          { class: 'INFORMATION', readAt: null },
          // A problem that is still a problem, read or not.
          { class: 'ALERT', status: 'ACTIVE' },
        ],
      },
    ],
  };

  const where: Prisma.LogisticsNotificationWhereInput =
    view === 'resolved'
      ? { AND: [audience, { class: 'ALERT', status: { in: ['RESOLVED', 'ARCHIVED'] } }] }
      : view === 'all'
        ? audience
        : {
            AND: [
              audience,
              // The feed keeps read news - a carrier bell is "what happened
              // lately" and a list that empties as you read it cannot be
              // looked back at. Only a closed alert leaves.
              { OR: [{ class: 'INFORMATION' }, { class: 'ALERT', status: 'ACTIVE' }] },
            ],
          };

  const [rows, unreadCount, activeCount, openAlertCount] = await Promise.all([
    prisma.logisticsNotification.findMany({
      where,
      // Closed alerts read by when they were closed; live ones by when they
      // happened. A history ordered by `createdAt` buries this morning's
      // resolution under an older raise.
      orderBy: view === 'resolved' ? { resolvedAt: 'desc' } : { createdAt: 'desc' },
      take: MAX_LOGISTICS_FEED,
      select: {
        id: true,
        kind: true,
        title: true,
        body: true,
        shipmentId: true,
        readAt: true,
        createdAt: true,
        class: true,
        status: true,
        resolvedAt: true,
        resolutionReason: true,
        shipment: { select: { shipmentReference: true } },
      },
    }),
    prisma.logisticsNotification.count({ where: { AND: [audience, { readAt: null }] } }),
    prisma.logisticsNotification.count({ where: live }),
    prisma.logisticsNotification.count({
      where: { AND: [audience, { class: 'ALERT', status: 'ACTIVE' }] },
    }),
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
      class: row.class,
      status: row.status,
      resolvedAt: row.resolvedAt,
      resolutionReason: row.resolutionReason,
    })),
    unreadCount,
    activeCount,
    openAlertCount,
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
