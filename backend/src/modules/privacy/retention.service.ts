/**
 * Storage limitation, as running code.
 *
 * Art. 5(1)(e) says personal data is kept "no longer than is necessary". A
 * retention policy written in a document satisfies nobody: the table still
 * grows, and the first time anyone finds out how long the oldest row is comes
 * during a complaint. So the policy is a set of numbers in the environment
 * (see `RETENTION_*` in `config/env.ts`) and this file is what enforces them,
 * on the same maintenance beat that expires reservations.
 *
 * Three properties matter more than the sweeps themselves.
 *
 *   - **Bounded per pass.** Each sweep deletes at most `BATCH` rows and says
 *     how many it took. A deployment switching this on for the first time has
 *     years of backlog, and one statement deleting a million rows locks the
 *     table for everyone; the beat is frequent enough that the backlog drains
 *     over hours instead.
 *
 *   - **Zero means off.** A deployment whose own retention schedule is longer,
 *     or whose regulator has told it otherwise, sets the window to 0 and that
 *     sweep does nothing. Silently overriding a controller's own policy would
 *     be the worse default.
 *
 *   - **Nothing here touches an order, a payment or a refund.** Those carry a
 *     statutory retention period of their own and are dealt with by erasure,
 *     which pseudonymises rather than deletes - see `erasure.service.ts`. A
 *     sweep that quietly deleted invoices would trade one regulator for
 *     another.
 */
import { env } from '../../config/env.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/** Rows one sweep may delete in a single pass. */
const BATCH = 500;

export interface RetentionSweepResult {
  /** Rows removed or scrubbed, by sweep. Sweeps that did nothing are omitted. */
  removed: Record<string, number>;
  /** True while any sweep is still hitting its batch ceiling. */
  moreToDo: boolean;
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * Baskets nobody bought.
 *
 * A cart names a person and everything they were interested in, and no tax
 * authority anywhere wants one. Converted carts are left alone: they are the
 * link between an order and the reservation that fed it.
 */
async function sweepAbandonedCarts(days: number): Promise<number> {
  const stale = await prisma.cart.findMany({
    where: { status: { not: 'CONVERTED' }, updatedAt: { lt: cutoff(days) } },
    select: { id: true },
    take: BATCH,
  });

  if (stale.length === 0) return 0;

  // Items cascade; reservations null out their cart and are picked up by the
  // reservation sweep next door.
  const result = await prisma.cart.deleteMany({
    where: { id: { in: stale.map((cart) => cart.id) } },
  });

  return result.count;
}

/**
 * Storefront chat enquiries.
 *
 * The shortest window of the four, and deliberately: a stranger typed their
 * name, mobile number and email into a widget to ask a question, which is the
 * thinnest lawful basis anything in this system rests on. An enquiry that
 * turned into an account is already represented by the account.
 */
async function sweepAssistantConversations(days: number): Promise<number> {
  const stale = await prisma.assistantConversation.findMany({
    where: { createdAt: { lt: cutoff(days) } },
    select: { id: true },
    take: BATCH,
  });

  if (stale.length === 0) return 0;

  const ids = stale.map((conversation) => conversation.id);

  // Messages cascade from the conversation, but they are deleted explicitly so
  // the count reported is the number of rows actually removed rather than the
  // number of parents.
  await prisma.assistantMessage.deleteMany({ where: { conversationId: { in: ids } } });

  const result = await prisma.assistantConversation.deleteMany({ where: { id: { in: ids } } });
  return result.count;
}

/**
 * The audit trail.
 *
 * The one sweep that deletes evidence, which is why its default window is the
 * longest. Two years covers a security investigation and an accountability
 * question without keeping every administrative action for the life of the
 * installation - and an audit log kept forever is itself a growing pile of
 * personal data about staff.
 */
async function sweepAuditLogs(days: number): Promise<number> {
  const stale = await prisma.auditLog.findMany({
    where: { createdAt: { lt: cutoff(days) } },
    select: { id: true },
    take: BATCH,
  });

  if (stale.length === 0) return 0;

  const result = await prisma.auditLog.deleteMany({
    where: { id: { in: stale.map((entry) => entry.id) } },
  });

  return result.count;
}

/**
 * Sign-in telemetry: where a session was opened from, and from which address.
 *
 * This is the sweep that matters most for staff. `FEATURE_ADMIN_LOGIN_LOCATION`
 * records the precise position of a member of staff every time they open the
 * console, and position data about an employee ages from useful to hazardous
 * very quickly: it answers "was that sign-in me?" for a few weeks and is a
 * pattern-of-life record after that. The session row survives - it is still
 * the thing that says a session existed - with the coordinates, the place
 * name, the IP and the user-agent taken off it.
 *
 * Failed sign-in attempts go on the same schedule. They are keyed by email
 * address and carry the IP the attempt came from, and lockout only ever looks
 * at the last few minutes.
 */
async function sweepSessionTelemetry(days: number): Promise<number> {
  const before = cutoff(days);

  const scrubbed = await prisma.session.updateMany({
    where: {
      createdAt: { lt: before },
      OR: [
        { locationLatitude: { not: null } },
        { ipAddress: { not: null } },
        { userAgent: { not: null } },
      ],
    },
    data: {
      locationLatitude: null,
      locationLongitude: null,
      locationAccuracyM: null,
      locationLabel: null,
      locationCapturedAt: null,
      ipAddress: null,
      userAgent: null,
    },
  });

  const attempts = await prisma.loginAttempt.deleteMany({
    where: { createdAt: { lt: before } },
  });

  return scrubbed.count + attempts.count;
}

/**
 * Delivered notifications.
 *
 * The outbox stores the rendered body of every message sent, and an order
 * confirmation is the customer's name and delivery address written out in
 * prose. It is an operational record - did that email go, and did it arrive -
 * with a short useful life and no retention obligation of its own; the order
 * it refers to is the record that has to survive.
 *
 * Only delivered rows are swept. A pending or failed one is still work in
 * flight, and the outbox drain owns it.
 */
async function sweepSentNotifications(days: number): Promise<number> {
  const stale = await prisma.notificationOutbox.findMany({
    where: { status: 'SENT', sentAt: { lt: cutoff(days) } },
    select: { id: true },
    take: BATCH,
  });

  if (stale.length === 0) return 0;

  const ids = stale.map((row) => row.id);

  // Deliveries cascade from the outbox row, but are deleted explicitly so the
  // reported count is rows actually removed rather than parents.
  await prisma.notificationDelivery.deleteMany({ where: { outboxId: { in: ids } } });

  const result = await prisma.notificationOutbox.deleteMany({ where: { id: { in: ids } } });
  return result.count;
}

/**
 * Run every configured sweep once.
 *
 * Returns what it removed so the worker can log it and, when anything went,
 * write a single audit row. An empty pass writes nothing: a trail full of
 * "deleted 0 rows" is a trail nobody reads.
 */
export async function runRetentionSweeps(): Promise<RetentionSweepResult> {
  const removed: Record<string, number> = {};

  const sweeps: { name: string; days: number; run: (days: number) => Promise<number> }[] = [
    { name: 'abandonedCarts', days: env.RETENTION_ABANDONED_CART_DAYS, run: sweepAbandonedCarts },
    {
      name: 'assistantConversations',
      days: env.RETENTION_ASSISTANT_CONVERSATION_DAYS,
      run: sweepAssistantConversations,
    },
    { name: 'auditLogs', days: env.RETENTION_AUDIT_LOG_DAYS, run: sweepAuditLogs },
    {
      name: 'sessionTelemetry',
      days: env.RETENTION_SESSION_LOCATION_DAYS,
      run: sweepSessionTelemetry,
    },
    {
      name: 'sentNotifications',
      days: env.RETENTION_SENT_NOTIFICATION_DAYS,
      run: sweepSentNotifications,
    },
  ];

  let moreToDo = false;

  for (const sweep of sweeps) {
    if (sweep.days === 0) continue;

    try {
      const count = await sweep.run(sweep.days);
      if (count > 0) {
        removed[sweep.name] = count;
        if (count >= BATCH) moreToDo = true;
      }
    } catch (error) {
      // One failing sweep must not stop the others. A retention pass is a
      // best-effort maintenance job, and the next beat tries again.
      logger.error({ err: error, sweep: sweep.name }, 'retention sweep failed');
    }
  }

  if (Object.keys(removed).length > 0) {
    logger.info({ removed }, 'retention sweep removed expired personal data');

    await recordAudit({
      action: AuditAction.RETENTION_PURGED,
      resourceType: 'retention',
      actorType: 'SYSTEM',
      after: removed,
    });
  }

  return { removed, moreToDo };
}
