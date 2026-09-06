/**
 * Console notifications - the bell in the Admin Panel's top bar.
 *
 * Deliberately not the outbox next door. `notification.service.ts` is mail
 * leaving the building: a template, a recipient address, a delivery worker and
 * a retry schedule. This is the opposite direction - something happened inside
 * the system and the people running it should see it the next time they look
 * at any screen, without an email arriving and without opening the dashboard.
 *
 * Three decisions worth keeping:
 *
 *   - **Written inside the caller's transaction**, like the audit trail. An
 *     order that rolls back must not leave a notification claiming somebody
 *     bought something, and an order that commits must not lose its one.
 *   - **No stored prose.** A row carries its `kind` and the values that fill
 *     it; the panel renders the sentence from its own catalogue in whatever
 *     language the reader chose. Rendering English at write time would leave
 *     every non-English console permanently half-translated.
 *   - **Permission carried per row.** An order notification names a customer
 *     and a total, so only staff holding `order.read` see it. Putting the
 *     grant on the row rather than on the endpoint keeps the bell inside the
 *     permission model as further kinds are added.
 */
import type { PermissionKey } from '../../domain/permissions.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';

/** Console notification kinds. Each one the panel knows how to phrase. */
export const AdminNotificationKind = {
  /// A customer completed checkout. The variables are customerName,
  /// orderNumber, itemCount and orderTotal.
  ORDER_PLACED: 'order.placed',
  /// A member of staff opened the console, and where from. The variables are
  /// email, place, latitude, longitude, accuracyM and ipAddress. Carries
  /// `staff.read`, because it names a colleague and says where they were.
  ADMIN_SIGNED_IN: 'admin.signed_in',
  /// Somebody signed themselves up on the storefront and confirmed their email.
  /// The variables are fullName, email, phone, country and requiresApproval.
  /// Carries `customer.read`, because it names a person and their contact
  /// details. Raised at confirmation rather than at sign-up: an address nobody
  /// has proved they can read is not yet worth a colleague's attention.
  CUSTOMER_REGISTERED: 'customer.registered',
  /// Somebody has exercised a data subject right and it needs a decision. The
  /// variables are email, type and dueAt. Carries `data_request.read` rather
  /// than `customer.read`: that a named individual has asked to be erased is
  /// its own piece of information, and not everyone who may look a customer up
  /// should be told it unprompted.
  DATA_REQUEST_RAISED: 'data_request.raised',
} as const;

export type AdminNotificationKindKey =
  (typeof AdminNotificationKind)[keyof typeof AdminNotificationKind];

/**
 * The values that fill a phrase. Primitives only - the same rule the outbox
 * follows, and for the same reason: passing an entity would put personal data
 * or a provider secret into a row that every member of staff with the matching
 * grant can read.
 */
export type AdminNotificationVariables = Record<string, string | number | boolean | null>;

export interface CreateAdminNotificationInput {
  kind: string;
  variables?: AdminNotificationVariables;
  /** Admin Panel path the row opens, e.g. `/orders/<id>`. */
  linkPath?: string | null;
  /** Null shows the row to every member of staff. */
  requiredPermission?: PermissionKey | null;
  relatedType?: string;
  relatedId?: string;
  /** One bell per business event, however many times the operation is retried. */
  dedupeKey?: string;
}

/** How much of the feed the bell ever asks for. */
export const MAX_FEED_SIZE = 50;

/**
 * Marking everything read is bounded rather than unbounded. A console left
 * unopened for a month should not turn one click into a ten-thousand-row
 * insert; anything past this stays unread, and the next click clears the rest.
 */
const MARK_ALL_LIMIT = 500;

/** Rows older than this are deleted by the worker's maintenance pass. */
const RETENTION_DAYS = 90;

/** What the panel needs to render one row. */
export interface AdminNotificationView {
  id: string;
  kind: string;
  variables: Record<string, unknown>;
  linkPath: string | null;
  isRead: boolean;
  createdAt: string;
}

export interface AdminNotificationFeed {
  items: AdminNotificationView[];
  /** Across the whole visible feed, not only the page returned. */
  unreadCount: number;
}

/** Who is looking, and therefore which rows exist as far as they are concerned. */
export interface NotificationViewer {
  userId: string;
  permissions: readonly string[];
}

/**
 * The visibility clause.
 *
 * Unpermissioned rows are visible to everyone; the rest only to a holder of
 * the named grant. Written once and reused by every query here so the feed,
 * the badge and "mark all as read" can never disagree about what a person can
 * see.
 */
function visibleTo(viewer: NotificationViewer): Prisma.AdminNotificationWhereInput {
  return {
    OR: [{ requiredPermission: null }, { requiredPermission: { in: [...viewer.permissions] } }],
  };
}

type CreateClient = Pick<typeof prisma, 'adminNotification'>;

/**
 * Record something worth telling the people running the shop.
 *
 * Pass the caller's `tx` whenever there is one - see the note at the top of
 * the file. Without it the write is standalone and best-effort: a bell that
 * cannot be rung must not turn a completed checkout into a 500.
 */
export async function createAdminNotification(
  input: CreateAdminNotificationInput,
  tx?: unknown,
): Promise<void> {
  const client = (tx as CreateClient | undefined) ?? prisma;

  const data: Prisma.AdminNotificationCreateManyInput = {
    id: newId(),
    kind: input.kind,
    variablesJson: input.variables ?? {},
    linkPath: input.linkPath ?? null,
    requiredPermission: input.requiredPermission ?? null,
    relatedType: input.relatedType ?? null,
    relatedId: input.relatedId ?? null,
    dedupeKey: input.dedupeKey ?? null,
  };

  // `createMany` rather than `create` for the sake of `skipDuplicates`: a
  // repeated dedupe key has to be a no-op, not a unique-constraint error that
  // rolls back the order it was told about.
  if (tx !== undefined) {
    await client.adminNotification.createMany({ data: [data], skipDuplicates: true });
    return;
  }

  try {
    await client.adminNotification.createMany({ data: [data], skipDuplicates: true });
  } catch (error) {
    logger.error({ err: error, kind: input.kind }, 'failed to record console notification');
  }
}

/**
 * The feed and the badge, in one round trip.
 *
 * The badge counts the whole visible feed rather than the page returned: a
 * bell reading "12" that opens onto ten rows is a bell people stop trusting.
 */
export async function listAdminNotifications(
  viewer: NotificationViewer,
  options: { limit?: number } = {},
): Promise<AdminNotificationFeed> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), MAX_FEED_SIZE);
  const visible = visibleTo(viewer);

  const [rows, unreadCount] = await Promise.all([
    prisma.adminNotification.findMany({
      where: visible,
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        kind: true,
        variablesJson: true,
        linkPath: true,
        createdAt: true,
        // A read row exists only for the person who opened it, so this is
        // "have *I* read it" and not "has anyone".
        reads: { where: { userId: viewer.userId }, select: { readAt: true }, take: 1 },
      },
    }),
    prisma.adminNotification.count({
      where: { AND: [visible, { reads: { none: { userId: viewer.userId } } }] },
    }),
  ]);

  return {
    items: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      variables:
        row.variablesJson === null || typeof row.variablesJson !== 'object'
          ? {}
          : (row.variablesJson as Record<string, unknown>),
      linkPath: row.linkPath,
      isRead: row.reads.length > 0,
      createdAt: row.createdAt.toISOString(),
    })),
    unreadCount,
  };
}

/**
 * Mark specific rows read for one person.
 *
 * Filtered through the same visibility clause as the feed: an id guessed or
 * kept from a revoked grant must not become a way to confirm that a
 * notification exists.
 */
export async function markAdminNotificationsRead(
  viewer: NotificationViewer,
  notificationIds: readonly string[],
): Promise<number> {
  if (notificationIds.length === 0) return 0;

  const visible = await prisma.adminNotification.findMany({
    where: { AND: [visibleTo(viewer), { id: { in: [...notificationIds] } }] },
    select: { id: true },
  });

  if (visible.length === 0) return 0;

  // Already-read rows collide on the composite primary key; skipping them
  // keeps this idempotent, which matters because the panel fires it every
  // time the bell is opened.
  const result = await prisma.adminNotificationRead.createMany({
    data: visible.map((row) => ({ notificationId: row.id, userId: viewer.userId })),
    skipDuplicates: true,
  });

  return result.count;
}

/** Clear the badge. Bounded - see MARK_ALL_LIMIT. */
export async function markAllAdminNotificationsRead(viewer: NotificationViewer): Promise<number> {
  const unread = await prisma.adminNotification.findMany({
    where: { AND: [visibleTo(viewer), { reads: { none: { userId: viewer.userId } } }] },
    orderBy: { createdAt: 'desc' },
    take: MARK_ALL_LIMIT,
    select: { id: true },
  });

  if (unread.length === 0) return 0;

  const result = await prisma.adminNotificationRead.createMany({
    data: unread.map((row) => ({ notificationId: row.id, userId: viewer.userId })),
    skipDuplicates: true,
  });

  return result.count;
}

/**
 * Retention.
 *
 * The bell is a "what happened lately" feed, not a record - the audit trail
 * and the orders themselves are the record, and both outlive this. Without a
 * sweep the table grows for the life of the installation to hold rows nobody
 * will ever scroll to. Read rows go with their notification through the
 * cascade.
 */
export async function pruneAdminNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const result = await prisma.adminNotification.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return result.count;
}
