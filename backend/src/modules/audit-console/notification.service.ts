/**
 * The Audit Console's own notification feed.
 *
 * Who is told what:
 *   - an agency's admins and coordinators: a job offered to the agency;
 *   - the named inspector: assigned, report returned by QA;
 *   - the agency's QA reviewers: a report waiting for review;
 *   - audit staff: a seller asked for review, a document submitted or
 *     resubmitted, a rule waiting for approval, a failed or inconclusive
 *     inspection, a document about to expire.
 *
 * Written inside the caller's transaction when there is one, so a rolled-back
 * action never leaves a notification behind it. A dedupe key stops the same
 * event notifying the same person twice. The text is plain English: the
 * console's i18n renders its own labels, and these lines are a feed, not the
 * record - the record is the timeline and the audit log.
 */
import type { PrismaTransaction } from '../../infra/prisma.js';
import { newId } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import type { AuditStaffRoleName } from '../../domain/audit-console-permissions.js';
import type { InspectionAgencyRoleName } from '../../domain/inspection-permissions.js';

type Client = PrismaTransaction | typeof prisma;

export interface AuditNotice {
  kind: string;
  title: string;
  body?: string | null;
  link?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  dedupeKey?: string | null;
}

/** Notify these console users. Skips anybody already told about this dedupe key. */
export async function notifyAuditUsers(client: Client, userIds: readonly string[], notice: AuditNotice): Promise<number> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return 0;
  const dedupeKey = (notice.dedupeKey ?? '').slice(0, 160);

  let recipients = unique;
  if (dedupeKey.length > 0) {
    const already = await client.auditNotification.findMany({
      where: { userId: { in: unique }, dedupeKey },
      select: { userId: true },
    });
    const told = new Set(already.map((row) => row.userId));
    recipients = unique.filter((id) => !told.has(id));
  }
  if (recipients.length === 0) return 0;

  await client.auditNotification.createMany({
    data: recipients.map((userId) => ({
      id: newId(),
      userId,
      kind: notice.kind.slice(0, 48),
      title: notice.title.slice(0, 200),
      body: notice.body ?? null,
      link: notice.link?.slice(0, 512) ?? null,
      subjectType: notice.subjectType ?? null,
      subjectId: notice.subjectId ?? null,
      dedupeKey,
    })),
  });
  return recipients.length;
}

/** The active console users of one agency holding one of these roles. */
export async function agencyUserIds(client: Client, agencyId: string, roles: readonly InspectionAgencyRoleName[]): Promise<string[]> {
  const rows = await client.inspectionAgencyMember.findMany({
    where: { agencyId, status: 'ACTIVE', role: { in: [...roles] } },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/** One agency member's console user id, if they are active. */
export async function memberUserId(client: Client, memberId: string | null): Promise<string[]> {
  if (memberId === null) return [];
  const row = await client.inspectionAgencyMember.findUnique({ where: { id: memberId }, select: { userId: true, status: true } });
  return row === null || row.status !== 'ACTIVE' ? [] : [row.userId];
}

/** Active audit staff in these roles. */
export async function staffUserIds(client: Client, roles: readonly AuditStaffRoleName[]): Promise<string[]> {
  const rows = await client.auditStaffMember.findMany({
    where: { status: 'ACTIVE', role: { in: [...roles] } },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

export interface NotificationView {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  readAt: string | null;
}

export async function listAuditNotifications(userId: string, limit = 50): Promise<{ items: NotificationView[]; unread: number }> {
  const [rows, unread] = await Promise.all([
    prisma.auditNotification.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: limit }),
    prisma.auditNotification.count({ where: { userId, readAt: null } }),
  ]);
  return {
    unread,
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      title: row.title,
      body: row.body,
      link: row.link,
      createdAt: row.createdAt.toISOString(),
      readAt: row.readAt?.toISOString() ?? null,
    })),
  };
}

/** Mark one read. Another person's notification is "not found", not "forbidden". */
export async function markAuditNotificationRead(userId: string, id: string): Promise<boolean> {
  const result = await prisma.auditNotification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (result.count === 1) return true;
  return (await prisma.auditNotification.count({ where: { id, userId } })) === 1;
}

export async function markAllAuditNotificationsRead(userId: string): Promise<number> {
  const result = await prisma.auditNotification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
  return result.count;
}
