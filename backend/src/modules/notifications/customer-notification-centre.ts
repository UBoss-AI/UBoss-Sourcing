/**
 * The storefront notification centre (checklist JOURNEY-056).
 *
 * What a buyer or a seller member sees at /account/notifications: the email
 * and in-app notifications this deployment actually sent to their address,
 * newest first, each with
 *
 *   - **unread** - `notification_outbox.readAt` is this person's own mark,
 *     because one outbox row is one recipient. Opening the centre does not
 *     mark anything; pressing a row or "mark all read" does.
 *   - **priority** - HIGH, NORMAL or LOW, derived from the event key.
 *   - **family** - the group a person can mute, and whether it is mandatory.
 *   - **link** - the screen the notification is about: the order, the claim,
 *     the request. Built here from what the row is about, never stored.
 *
 * Only SENT rows: a queued message has not arrived and a failed one never
 * will. SMS and WhatsApp rows are not listed - they are copies of the same
 * notification on another channel, and listing them would show it twice.
 *
 * The body is never returned. It is a rendered email, often with a
 * single-use link in it.
 */
import { prisma } from '../../infra/prisma.js';
import { buyerDeepLink, familyOf, isMandatoryEvent, priorityOf, type NotificationPriority } from './notification-preferences.js';

export interface CentreNotification {
  id: string;
  eventKey: string;
  subject: string;
  sentAt: string | null;
  relatedType: string | null;
  relatedId: string | null;
  readAt: string | null;
  priority: NotificationPriority;
  family: string | null;
  mandatory: boolean;
  /** In-app path, e.g. /account/orders/<id>. Null when there is no screen. */
  link: string | null;
}

export async function listCentreNotifications(
  recipient: { userId: string; email: string },
  options: { limit: number; unreadOnly: boolean },
): Promise<{ notifications: CentreNotification[]; unreadCount: number }> {
  // Events an operator has taken out of the notification centre
  // (`inAppEnabled` off) are not listed, whatever was emailed for them.
  const [hidden, mutes] = await Promise.all([
    prisma.notificationSetting.findMany({ where: { inAppEnabled: false }, select: { eventKey: true } }),
    // Families this person muted for the centre itself.
    prisma.notificationPreference.findMany({
      where: { userId: recipient.userId, channel: 'IN_APP' },
      select: { family: true },
    }),
  ]);
  const mutedFamilies = new Set(mutes.map((row) => row.family));
  const shown = (eventKey: string): boolean => {
    if (isMandatoryEvent(eventKey)) return true;
    const family = familyOf(eventKey);
    return family === null || !mutedFamilies.has(family.key);
  };

  const where = {
    recipientEmail: recipient.email,
    status: 'SENT' as const,
    channel: { in: ['EMAIL' as const, 'IN_APP' as const] },
    ...(hidden.length > 0 ? { eventKey: { notIn: hidden.map((row) => row.eventKey) } } : {}),
  };

  const rows = await prisma.notificationOutbox.findMany({
    where: { ...where, ...(options.unreadOnly ? { readAt: null } : {}) },
    orderBy: { sentAt: 'desc' },
    // Read a little more than asked, so muted families do not leave a short page.
    take: Math.min(options.limit * 2, 200),
    select: { id: true, eventKey: true, subject: true, sentAt: true, relatedType: true, relatedId: true, readAt: true },
  });
  const visible = rows.filter((row) => shown(row.eventKey)).slice(0, options.limit);

  const unreadRows = await prisma.notificationOutbox.findMany({
    where: { ...where, readAt: null },
    select: { eventKey: true },
    take: 1000,
  });
  const unreadCount = unreadRows.filter((row) => shown(row.eventKey)).length;

  // A claim is opened by its reference, not its id.
  const disputeIds = visible.filter((row) => row.relatedType === 'dispute' && row.relatedId !== null).map((row) => row.relatedId as string);
  const disputes =
    disputeIds.length === 0
      ? []
      : await prisma.dispute.findMany({ where: { id: { in: disputeIds } }, select: { id: true, reference: true } });
  const references = new Map(disputes.map((row) => [row.id, row.reference]));

  return {
    unreadCount,
    notifications: visible.map((row) => {
      const family = familyOf(row.eventKey);
      return {
        id: row.id,
        eventKey: row.eventKey,
        subject: row.subject,
        sentAt: row.sentAt?.toISOString() ?? null,
        relatedType: row.relatedType,
        relatedId: row.relatedId,
        readAt: row.readAt?.toISOString() ?? null,
        priority: priorityOf(row.eventKey),
        family: family?.key ?? null,
        mandatory: isMandatoryEvent(row.eventKey),
        link: buyerDeepLink(row.relatedType, row.relatedId, references),
      };
    }),
  };
}

/**
 * Mark some, or all, of this person's notifications read. Scoped by address,
 * so another person's row is simply not touched. Returns how many changed.
 */
export async function markCentreNotificationsRead(
  recipient: { email: string },
  input: { ids: readonly string[] } | { all: true },
): Promise<number> {
  const result = await prisma.notificationOutbox.updateMany({
    where: {
      recipientEmail: recipient.email,
      status: 'SENT',
      readAt: null,
      ...('ids' in input ? { id: { in: [...input.ids] } } : {}),
    },
    data: { readAt: new Date() },
  });
  return result.count;
}
