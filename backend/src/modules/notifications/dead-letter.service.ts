/**
 * The two dead-letter queues, readable and retryable by staff.
 *
 * A background job that exhausted its attempts is left `DEAD` in `job_queue`,
 * and an email that could not be delivered is left `DEAD` in
 * `notification_outbox` - on purpose, with its payload, so it can be replayed
 * once whatever broke it is fixed. The operations dashboard has always counted
 * both. Until this module there was nothing behind the count: both queues
 * linked to routes that did not exist, so a member of staff could see that
 * twelve emails had failed and do nothing about any of them.
 *
 * What is shown is deliberately thin. A job's payload and an email's body are
 * NOT returned: the body is a rendered message that often carries a
 * single-use link (a payment link, a password reset), and a payload can carry
 * whatever its producer put in it. Staff get what they need to decide whether
 * to retry - what it was, how often it was tried, the last error, when - and
 * the recipient's address masked to its first letter and domain.
 *
 * A retry is exactly one more attempt. The attempt counter is never reset: it
 * is the history of how hard this has been tried, and zeroing it would let a
 * permanently broken job be retried without limit by somebody pressing a
 * button. Both retries are conditional updates on the dead state, so a double
 * click, two tabs or two members of staff retry once, not twice.
 */
import { ErrorCode, conflict, notFound } from '../../domain/errors.js';
import { maskEmail } from '../../domain/logistics-masking.js';
import { prisma } from '../../infra/prisma.js';
import { JobType, queue } from '../../infra/queue/index.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/** The address an erasure writes; a message to it can never be delivered. */
const ERASED_RECIPIENT_SUFFIX = '@erased.invalid';

/** Provider error text is bounded, and may echo an address: masked on the way out. */
function safeError(raw: string | null): string | null {
  if (raw === null) return null;
  return raw
    .replace(/[^\s<>()"',;:]+@[^\s<>()"',;:]+/g, (address) => maskEmail(address) ?? '•••')
    .slice(0, 500);
}

export interface DeadLetterActor {
  userId: string;
  email: string;
  ipAddress?: string | null;
  correlationId?: string | null;
}

interface Page {
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Background jobs
// ---------------------------------------------------------------------------

export interface DeadJobView {
  id: string;
  jobType: string;
  queue: string;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  failedAt: string | null;
}

export async function listDeadJobs(page: Page): Promise<{ jobs: DeadJobView[]; total: number }> {
  const where = { status: 'DEAD' as const };
  const [rows, total] = await Promise.all([
    prisma.jobQueue.findMany({
      where,
      orderBy: [{ completedAt: 'desc' }, { id: 'desc' }],
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
      select: {
        id: true,
        jobType: true,
        queue: true,
        attemptCount: true,
        maxAttempts: true,
        lastError: true,
        createdAt: true,
        completedAt: true,
      },
    }),
    prisma.jobQueue.count({ where }),
  ]);

  return {
    total,
    jobs: rows.map((row) => ({
      id: row.id,
      jobType: row.jobType,
      queue: row.queue,
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      lastError: safeError(row.lastError),
      createdAt: row.createdAt.toISOString(),
      failedAt: row.completedAt?.toISOString() ?? null,
    })),
  };
}

export async function retryDeadJob(id: string, actor: DeadLetterActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const job = await tx.jobQueue.findUnique({
      where: { id },
      select: { id: true, jobType: true, status: true, attemptCount: true, maxAttempts: true },
    });
    if (job === null) throw notFound('Background job');

    // Conditional on DEAD, so a second press - or a second member of staff -
    // finds nothing to change and is told so, rather than queueing it twice.
    const updated = await tx.jobQueue.updateMany({
      where: { id, status: 'DEAD' },
      data: {
        status: 'PENDING',
        runAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        // Room for one more go, and only one.
        maxAttempts: Math.max(job.maxAttempts, job.attemptCount + 1),
      },
    });

    if (updated.count !== 1) {
      throw conflict(ErrorCode.CONFLICT, 'This job is no longer waiting to be retried.', [
        { code: 'NOT_RETRYABLE', meta: { status: job.status } },
      ]);
    }

    await recordAudit(
      {
        action: AuditAction.JOB_RETRIED,
        resourceType: 'job',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
        before: { status: 'DEAD', attemptCount: job.attemptCount, maxAttempts: job.maxAttempts },
        after: { status: 'PENDING', jobType: job.jobType },
      },
      tx,
    );
  });
}

// ---------------------------------------------------------------------------
// Emails
// ---------------------------------------------------------------------------

export interface FailedNotificationView {
  id: string;
  eventKey: string;
  channel: string;
  recipient: string | null;
  attemptCount: number;
  maxAttempts: number;
  lastError: string | null;
  relatedType: string | null;
  relatedId: string | null;
  createdAt: string;
  lastAttemptAt: string;
  /** False for a message to an erased person, which can never be delivered. */
  retryable: boolean;
}

/** DEAD is what exhaustion writes; FAILED is counted by the dashboard too, so it is listed. */
const FAILED_OUTBOX = ['DEAD', 'FAILED'] as const;

export async function listFailedNotifications(
  page: Page,
): Promise<{ notifications: FailedNotificationView[]; total: number }> {
  const where = { status: { in: [...FAILED_OUTBOX] } };
  const [rows, total] = await Promise.all([
    prisma.notificationOutbox.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      skip: (page.page - 1) * page.pageSize,
      take: page.pageSize,
      // Never body, payloadJson, subject, recipientName or recipientPhone.
      select: {
        id: true,
        eventKey: true,
        channel: true,
        recipientEmail: true,
        attemptCount: true,
        maxAttempts: true,
        lastError: true,
        relatedType: true,
        relatedId: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.notificationOutbox.count({ where }),
  ]);

  return {
    total,
    notifications: rows.map((row) => ({
      id: row.id,
      eventKey: row.eventKey,
      channel: row.channel,
      recipient: maskEmail(row.recipientEmail),
      attemptCount: row.attemptCount,
      maxAttempts: row.maxAttempts,
      lastError: safeError(row.lastError),
      relatedType: row.relatedType,
      relatedId: row.relatedId,
      createdAt: row.createdAt.toISOString(),
      lastAttemptAt: row.updatedAt.toISOString(),
      retryable: !(row.recipientEmail ?? '').endsWith(ERASED_RECIPIENT_SUFFIX),
    })),
  };
}

export async function retryFailedNotification(id: string, actor: DeadLetterActor): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const row = await tx.notificationOutbox.findUnique({
      where: { id },
      select: { id: true, eventKey: true, status: true, attemptCount: true, maxAttempts: true, recipientEmail: true },
    });
    if (row === null) throw notFound('Notification');

    // The person was erased: the address is a placeholder and the body was
    // scrubbed. There is nothing to deliver and nobody to deliver it to.
    if ((row.recipientEmail ?? '').endsWith(ERASED_RECIPIENT_SUFFIX)) {
      throw conflict(ErrorCode.CONFLICT, 'This message was for an account that has since been erased.', [
        { code: 'RECIPIENT_ERASED' },
      ]);
    }

    const updated = await tx.notificationOutbox.updateMany({
      where: { id, status: { in: [...FAILED_OUTBOX] } },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        maxAttempts: Math.max(row.maxAttempts, row.attemptCount + 1),
      },
    });

    if (updated.count !== 1) {
      throw conflict(ErrorCode.CONFLICT, 'This message is no longer waiting to be retried.', [
        { code: 'NOT_RETRYABLE', meta: { status: row.status } },
      ]);
    }

    // Re-arm the delivery job. It is keyed `notification:<id>` and that key is
    // unique, so while the old job row survives (until housekeeping sweeps it)
    // a fresh enqueue would be silently dropped as a duplicate and the message
    // would sit PENDING for ever. The handler skips a message already SENT, so
    // re-arming can never send one twice.
    const dedupeKey = `notification:${id}`;
    const rearmed = await tx.jobQueue.updateMany({
      where: { dedupeKey, status: { in: ['SUCCEEDED', 'DEAD', 'FAILED'] } },
      data: {
        status: 'PENDING',
        runAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: null,
        lastError: null,
      },
    });

    if (rearmed.count === 0) {
      // No finished job to re-arm: either it was swept, or one is already
      // queued - in which case the unique key drops this and the queued one
      // will send the message.
      await queue.enqueue(JobType.NOTIFICATION_SEND, { outboxId: id }, { dedupeKey }, tx);
    }

    await recordAudit(
      {
        action: AuditAction.NOTIFICATION_RETRIED,
        resourceType: 'notification',
        resourceId: id,
        actorType: 'ADMIN',
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
        before: { status: row.status, attemptCount: row.attemptCount, maxAttempts: row.maxAttempts },
        after: { status: 'PENDING', eventKey: row.eventKey },
      },
      tx,
    );
  });
}
