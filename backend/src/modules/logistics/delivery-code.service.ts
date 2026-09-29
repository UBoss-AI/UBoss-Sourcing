/**
 * Delivery codes: the six digits a buyer reads out at the door.
 *
 * Used only where the consignment's SLA policy sets `podRequiresOtp`. Before
 * this file existed that policy could never be satisfied - the check was
 * written and nothing ever sent a code - so every delivery under it was stuck.
 *
 * WHEN A CODE IS SENT
 *
 *   1. **Automatically, when the consignment goes OUT_FOR_DELIVERY.** That is
 *      the moment the buyer needs it: the van has left, and the code in their
 *      inbox is for today's delivery. `recordShipmentEvent` calls
 *      `sendDeliveryCodeOnDispatch` after the status has committed, so a code
 *      is never sent for a move that rolled back. It never throws: a missing
 *      email must not undo a van leaving the depot.
 *   2. **On request, from the carrier portal**, while the consignment is out
 *      for delivery or a delivery was attempted. The buyer deleted the email,
 *      or the code expired, or too many wrong guesses killed it.
 *
 * Nothing here moves a status. The status moves through
 * `assertShipmentTransition` like every other move; a code is a consequence of
 * a move, never a cause of one.
 *
 * WHO SEES THE CODE
 *
 * The buyer, by email, and nobody else. It is not in any response, any audit
 * row or any log line, and the row that records it holds an HMAC keyed with a
 * server secret rather than the digits - so a copied table of six-digit codes
 * cannot be guessed offline in the million tries it would otherwise take.
 * Delivered by EMAIL because this deployment has no SMS driver - the same
 * honest compromise `users.pendingPhone` documents. It proves control of the
 * buyer's account, which is what stops a parcel being signed for by whoever
 * happens to be in the corridor; it does not prove control of a telephone.
 *
 * THE LIMITS, AND WHY EACH ONE
 *
 *   - Five wrong guesses kill a code. A driver cannot try every number.
 *   - Five codes per consignment in any 24 hours, the automatic one included.
 *     Together with the above, that is at most 25 guesses a day against a
 *     million possibilities.
 *   - A minute between codes, so a double press sends one email, not two.
 *   - Twelve hours of life, which covers a delivery day. Sending a new code
 *     supersedes the old one, so yesterday's email cannot complete today's
 *     delivery.
 */
import { createHmac, randomInt } from 'node:crypto';
import { env } from '../../config/env.js';
import { safeCompare } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { recordLogisticsAudit } from './audit.service.js';
import { renderDeliveryCodeEmail } from './delivery-code-email.js';

export const DELIVERY_CODE_TTL_HOURS = 12;
export const DELIVERY_CODE_MAX_ATTEMPTS = 5;
export const DELIVERY_CODE_MAX_PER_DAY = 5;
export const DELIVERY_CODE_RESEND_COOLDOWN_MS = 60_000;

const DAY_MS = 24 * 3_600_000;

export type DeliveryCodeOrigin = 'OUT_FOR_DELIVERY' | 'REQUESTED';

/** Keyed with a server secret, like the buyer-company email code. */
function hashCode(shipmentId: string, code: string): string {
  return createHmac('sha256', env.SESSION_COOKIE_SECRET)
    .update(`logistics-delivery-code:${shipmentId}:${code}`)
    .digest('hex');
}

async function policyRequiresCode(shipmentId: string): Promise<boolean> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: { slaPolicy: { select: { podRequiresOtp: true } } },
  });
  return shipment?.slaPolicy?.podRequiresOtp === true;
}

interface Recipient {
  email: string;
  name: string;
  language: string | null;
  order: string;
  shipment: string;
  carrier: string;
  partnerId: string | null;
}

/**
 * Who the code goes to: the buyer the consignment is being delivered to.
 *
 * Two reads rather than a join, and the reason is the schema.
 * `receivingCustomerProfileId` is stored as a bare id with no Prisma relation,
 * deliberately: it is the OPERATOR's link back to the buyer and is never
 * selected on a path a carrier can reach. This function is not one either -
 * what it returns goes into an email and nowhere else.
 */
async function findRecipient(shipmentId: string): Promise<Recipient | null> {
  const shipment = await prisma.logisticsShipment.findUnique({
    where: { id: shipmentId },
    select: {
      receivingCustomerProfileId: true,
      shipmentReference: true,
      assignedPartnerId: true,
      assignedPartner: { select: { displayName: true } },
      order: { select: { orderNumber: true } },
    },
  });

  const profileId = shipment?.receivingCustomerProfileId ?? null;
  if (shipment === null || profileId === null) return null;

  const profile = await prisma.customerProfile.findUnique({
    where: { id: profileId },
    select: {
      fullName: true,
      user: { select: { email: true, preferredLanguage: true, archivedAt: true } },
    },
  });

  // No live account behind the consignment means nowhere to send a code - a
  // manual movement, or an order imported without a buyer. The delivery is
  // then refused rather than accepted unverified, which is the safe direction.
  if (profile === null || profile.user.archivedAt !== null || profile.user.email.length === 0) {
    return null;
  }

  return {
    email: profile.user.email,
    name: profile.fullName,
    language: profile.user.preferredLanguage,
    order: shipment.order?.orderNumber ?? shipment.shipmentReference,
    shipment: shipment.shipmentReference,
    carrier: shipment.assignedPartner?.displayName ?? 'the carrier',
    partnerId: shipment.assignedPartnerId,
  };
}

export type SendDeliveryCodeResult =
  | { kind: 'SENT'; sentAt: Date; expiresAt: Date }
  | { kind: 'NOT_REQUIRED' }
  | { kind: 'NO_RECIPIENT' }
  | { kind: 'TOO_SOON'; retryAt: Date }
  | { kind: 'DAILY_LIMIT_REACHED' };

export interface SendDeliveryCodeContext {
  origin: DeliveryCodeOrigin;
  /** Who asked, for the carrier's audit trail. Absent for the automatic send. */
  requestedBy?: { userId: string; label: string } | null;
  correlationId?: string | null;
}

/**
 * Send the buyer a fresh code, superseding any earlier one.
 *
 * The limits are checked inside a transaction that holds the consignment's row
 * lock, so two presses of "send a new code" in the same instant cannot both
 * slip under the daily cap. The email is queued in the same transaction as the
 * code: a code that was never recorded is never sent, and one that was
 * recorded is always sent.
 */
export async function sendDeliveryCode(
  shipmentId: string,
  context: SendDeliveryCodeContext,
): Promise<SendDeliveryCodeResult> {
  if (!(await policyRequiresCode(shipmentId))) return { kind: 'NOT_REQUIRED' };

  const recipient = await findRecipient(shipmentId);
  if (recipient === null) return { kind: 'NO_RECIPIENT' };

  // A credential, however short-lived: never Math.random.
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DELIVERY_CODE_TTL_HOURS * 3_600_000);
  const rowId = newId();

  const outcome = await prisma.$transaction(async (tx): Promise<SendDeliveryCodeResult> => {
    // Serialise every send for this consignment on its own row.
    await tx.$queryRaw`SELECT id FROM logistics_shipments WHERE id = ${shipmentId} FOR UPDATE`;

    const recent = await tx.logisticsDeliveryCode.findMany({
      where: { shipmentId, createdAt: { gt: new Date(now.getTime() - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    if (recent.length >= DELIVERY_CODE_MAX_PER_DAY) return { kind: 'DAILY_LIMIT_REACHED' };

    const last = recent[0];
    if (last !== undefined && now.getTime() - last.createdAt.getTime() < DELIVERY_CODE_RESEND_COOLDOWN_MS) {
      return {
        kind: 'TOO_SOON',
        retryAt: new Date(last.createdAt.getTime() + DELIVERY_CODE_RESEND_COOLDOWN_MS),
      };
    }

    await tx.logisticsDeliveryCode.updateMany({
      where: { shipmentId, consumedAt: null, supersededAt: null },
      data: { supersededAt: now },
    });

    await tx.logisticsDeliveryCode.create({
      data: {
        id: rowId,
        shipmentId,
        codeHash: hashCode(shipmentId, code),
        origin: context.origin,
        expiresAt,
        createdAt: now,
      },
    });

    const message = renderDeliveryCodeEmail(recipient.language, {
      name: recipient.name,
      order: recipient.order,
      shipment: recipient.shipment,
      carrier: recipient.carrier,
      code,
      hours: DELIVERY_CODE_TTL_HOURS,
    });

    await enqueueNotification(
      {
        eventKey: NotificationEvent.SHIPMENT_DELIVERY_CODE,
        recipientEmail: recipient.email,
        recipientName: recipient.name,
        variables: { subjectLine: message.subject, bodyText: message.body },
        dedupeKey: `delivery-code:${rowId}`,
        relatedType: 'logistics_shipment',
        relatedId: shipmentId,
        correlationId: context.correlationId ?? null,
      },
      tx,
    );

    return { kind: 'SENT', sentAt: now, expiresAt };
  });

  if (outcome.kind !== 'SENT') return outcome;

  await dispatchPendingNotifications();

  if (recipient.partnerId !== null) {
    await recordLogisticsAudit({
      logisticsPartnerId: recipient.partnerId,
      actorUserId: context.requestedBy?.userId ?? null,
      actorLabel: context.requestedBy?.label ?? 'System',
      action: 'logistics.pod.code_sent',
      resourceType: 'logistics_shipment',
      resourceId: shipmentId,
      // Neither the code nor where it went. The carrier reads this trail.
      after: { origin: context.origin, expiresAt: expiresAt.toISOString() },
      summary:
        context.origin === 'OUT_FOR_DELIVERY'
          ? 'A delivery code was sent to the recipient when the shipment went out for delivery.'
          : 'A new delivery code was sent to the recipient.',
      correlationId: context.correlationId ?? null,
    });
  }

  return outcome;
}

/**
 * The automatic send, when a consignment goes out for delivery.
 *
 * Called after the status has committed, and never throws: the parcel IS on
 * the van, and a timeline that denied it because an email could not be queued
 * would be worse than a missing email - which the driver can re-send from the
 * door.
 */
export async function sendDeliveryCodeOnDispatch(
  shipmentId: string,
  correlationId?: string | null,
): Promise<void> {
  try {
    const result = await sendDeliveryCode(shipmentId, {
      origin: 'OUT_FOR_DELIVERY',
      correlationId: correlationId ?? null,
    });
    if (result.kind === 'NO_RECIPIENT' || result.kind === 'DAILY_LIMIT_REACHED') {
      logger.warn({ shipmentId, outcome: result.kind }, 'no delivery code was sent for a consignment out for delivery');
    }
  } catch (error) {
    logger.warn({ err: error, shipmentId }, 'could not send a delivery code');
  }
}

export type DeliveryCodeCheck =
  | 'OK'
  | 'MISSING'
  | 'NOT_SENT'
  | 'INVALID'
  | 'EXPIRED'
  | 'TOO_MANY_ATTEMPTS';

/**
 * Check the code the recipient read out, and spend it.
 *
 * The guess is COUNTED before it is compared, with a conditional update, so
 * parallel guesses cannot all slip in under the limit. The spend is a second
 * conditional update, so two drivers racing the same right code produce one
 * accepted delivery.
 */
export async function checkAndSpendDeliveryCode(
  shipmentId: string,
  supplied: string | null | undefined,
): Promise<DeliveryCodeCheck> {
  const digits = (supplied ?? '').replace(/\s/g, '');
  if (digits.length === 0) return 'MISSING';

  const live = await prisma.logisticsDeliveryCode.findFirst({
    where: { shipmentId, consumedAt: null, supersededAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, codeHash: true, attempts: true, expiresAt: true },
  });

  if (live === null) return 'NOT_SENT';
  if (live.expiresAt.getTime() <= Date.now()) return 'EXPIRED';
  if (live.attempts >= DELIVERY_CODE_MAX_ATTEMPTS) return 'TOO_MANY_ATTEMPTS';

  const counted = await prisma.logisticsDeliveryCode.updateMany({
    where: {
      id: live.id,
      consumedAt: null,
      supersededAt: null,
      attempts: { lt: DELIVERY_CODE_MAX_ATTEMPTS },
    },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) return 'TOO_MANY_ATTEMPTS';

  if (!/^\d{6}$/.test(digits) || !safeCompare(hashCode(shipmentId, digits), live.codeHash)) {
    return live.attempts + 1 >= DELIVERY_CODE_MAX_ATTEMPTS ? 'TOO_MANY_ATTEMPTS' : 'INVALID';
  }

  const spent = await prisma.logisticsDeliveryCode.updateMany({
    where: { id: live.id, consumedAt: null, supersededAt: null },
    data: { consumedAt: new Date() },
  });

  return spent.count === 1 ? 'OK' : 'INVALID';
}

export interface DeliveryCodeState {
  /**
   * `NOT_SENT` - no code yet; `ACTIVE` - one is live; `EXPIRED` and `LOCKED`
   * (too many wrong guesses) - send a new one; `USED` - a delivery was
   * completed with it.
   */
  status: 'NOT_SENT' | 'ACTIVE' | 'EXPIRED' | 'LOCKED' | 'USED';
  /** False when there is no buyer account to send a code to. */
  canBeSent: boolean;
  sentAt: Date | null;
  expiresAt: Date | null;
  attemptsLeft: number | null;
  /** The earliest another code may be sent. Null when none may be sent in the next 24 hours. */
  nextSendAt: Date | null;
  sendsLeftToday: number;
}

/**
 * What the portal may know about the code: whether one is live, and when
 * another may be sent. Never the code, and never where it went.
 */
export async function readDeliveryCodeState(shipmentId: string): Promise<DeliveryCodeState> {
  const now = Date.now();

  const [recipient, rows] = await Promise.all([
    findRecipient(shipmentId),
    prisma.logisticsDeliveryCode.findMany({
      where: { shipmentId, createdAt: { gt: new Date(now - DAY_MS) } },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        expiresAt: true,
        attempts: true,
        consumedAt: true,
        supersededAt: true,
      },
    }),
  ]);

  const newest = rows[0];
  const sendsLeftToday = Math.max(0, DELIVERY_CODE_MAX_PER_DAY - rows.length);

  let nextSendAt: Date | null = null;
  if (sendsLeftToday > 0) {
    nextSendAt =
      newest === undefined
        ? new Date(now)
        : new Date(Math.max(now, newest.createdAt.getTime() + DELIVERY_CODE_RESEND_COOLDOWN_MS));
  }

  if (newest === undefined || newest.supersededAt !== null) {
    return {
      status: 'NOT_SENT',
      canBeSent: recipient !== null,
      sentAt: null,
      expiresAt: null,
      attemptsLeft: null,
      nextSendAt,
      sendsLeftToday,
    };
  }

  const status: DeliveryCodeState['status'] =
    newest.consumedAt !== null
      ? 'USED'
      : newest.expiresAt.getTime() <= now
        ? 'EXPIRED'
        : newest.attempts >= DELIVERY_CODE_MAX_ATTEMPTS
          ? 'LOCKED'
          : 'ACTIVE';

  return {
    status,
    canBeSent: recipient !== null,
    sentAt: newest.createdAt,
    expiresAt: newest.expiresAt,
    attemptsLeft: status === 'ACTIVE' ? DELIVERY_CODE_MAX_ATTEMPTS - newest.attempts : null,
    nextSendAt,
    sendsLeftToday,
  };
}
