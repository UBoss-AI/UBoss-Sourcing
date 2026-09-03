/**
 * Background worker.
 *
 * A polling loop rather than a push subscription, because the queue is
 * MariaDB-backed (XAMPP ships no Redis). At this system's volume a 2-second
 * poll is well inside any latency the business cares about, and it costs one
 * indexed query per tick when the queue is empty.
 *
 * The loop:
 *   1. Reap leases from workers that died mid-job.
 *   2. Claim up to WORKER_CONCURRENCY due jobs (see database-queue.ts for how
 *      claiming works without SKIP LOCKED).
 *   3. Run them in parallel, each with its own lease.
 *   4. Enqueue recurring maintenance on a timer.
 *
 * Several workers can run at once. The claim guard is what keeps them from
 * processing the same job.
 */
import { hostname } from 'node:os';
import { env } from '../config/env.js';
import { logger, loggerFor } from '../infra/logger.js';
import { disconnectPrisma } from '../infra/prisma.js';
import { JobType, queue, type ClaimedJob } from '../infra/queue/index.js';
import { dispatchPendingNotifications } from '../modules/notifications/notification.service.js';
import { purgeExpiredExports } from '../modules/reports/export.service.js';
import { PermanentJobError, handlerFor } from './handlers.js';

/** Identifies this worker in `leaseOwner`, so a stuck lease can be traced. */
const WORKER_ID = `${hostname()}-${String(process.pid)}`;

/** How often to enqueue the periodic maintenance jobs. */
const MAINTENANCE_INTERVAL_MS = 60_000;

let running = true;
let inFlight = 0;

async function runJob(job: ClaimedJob): Promise<void> {
  const jobLogger = loggerFor(job.correlationId ?? job.id, {
    jobId: job.id,
    jobType: job.jobType,
    attempt: job.attemptCount,
  });

  const handler = handlerFor(job.jobType);

  if (handler === undefined) {
    // Nothing can process this. Retrying would only fill the queue with noise.
    jobLogger.error('no handler registered for job type; marking dead');
    await queue.fail(job.id, `No handler registered for job type "${job.jobType}"`, 0);
    await forceDead(job.id);
    return;
  }

  const startedAt = Date.now();

  try {
    await handler(job.payload, job);
    await queue.complete(job.id);
    jobLogger.info({ durationMs: Date.now() - startedAt }, 'job completed');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown job error';

    if (error instanceof PermanentJobError) {
      // Retrying cannot fix this - a deleted record, a malformed payload.
      jobLogger.error({ err: error }, 'job failed permanently');
      await queue.fail(job.id, message, 0);
      await forceDead(job.id);
      return;
    }

    jobLogger.warn({ err: error, durationMs: Date.now() - startedAt }, 'job failed; will retry');
    await queue.fail(job.id, message);
  }
}

/**
 * Move a job straight to DEAD without consuming its remaining attempts.
 *
 * `queue.fail` schedules a retry while attempts remain, which is wrong for a
 * permanent failure; this closes it out.
 */
async function forceDead(jobId: string): Promise<void> {
  const { prisma } = await import('../infra/prisma.js');
  await prisma.jobQueue.updateMany({
    where: { id: jobId, status: { in: ['PENDING', 'RUNNING'] } },
    data: { status: 'DEAD', completedAt: new Date(), leaseOwner: null, leaseExpiresAt: null },
  });
}

async function tick(): Promise<void> {
  const capacity = env.WORKER_CONCURRENCY - inFlight;
  if (capacity <= 0) return;

  const jobs = await queue.claim(capacity, env.WORKER_LEASE_SECONDS, WORKER_ID);
  if (jobs.length === 0) return;

  inFlight += jobs.length;

  // Jobs run in parallel; each holds its own lease, so a slow one does not
  // block the rest.
  await Promise.allSettled(jobs.map((job) => runJob(job)));

  inFlight -= jobs.length;
}

/**
 * Periodic maintenance.
 *
 * `dispatchPendingNotifications` is the outbox safety net: a crash between a
 * business transaction committing and its delivery job being enqueued would
 * otherwise strand the notification. Here it is delayed, not lost.
 */
async function maintenance(): Promise<void> {
  try {
    const reclaimed = await queue.reapExpiredLeases();
    if (reclaimed > 0) logger.info({ reclaimed }, 'reclaimed expired job leases');

    const dispatched = await dispatchPendingNotifications();
    if (dispatched > 0) logger.info({ dispatched }, 'dispatched orphaned outbox rows');

    // Export files hold personal data, so they are deleted once their download
    // window closes. The job row survives as an audit record.
    const purgedExports = await purgeExpiredExports();
    if (purgedExports > 0) logger.info({ purgedExports }, 'purged expired export files');

    // One of each in flight at a time, whatever the tick rate.
    const slot = String(Math.floor(Date.now() / MAINTENANCE_INTERVAL_MS));

    await queue.enqueue(JobType.RESERVATION_SWEEP, {}, { dedupeKey: `reservation_sweep:${slot}` });

    // The recurring engine's heartbeat. Claiming is idempotent and a tick with
    // nothing due costs one indexed query, so a steady beat is cheaper than
    // trying to be clever about when to look.
    await queue.enqueue(JobType.SCHEDULE_RUN, {}, { dedupeKey: `schedule_run:${slot}` });

    await queue.enqueue(
      JobType.PAYMENT_LINK_EXPIRE,
      {},
      { dedupeKey: `payment_link_expire:${slot}` },
    );


    // Reminders look 24h ahead, so an hourly sweep is ample.
    await queue.enqueue(
      JobType.SCHEDULE_REMINDER,
      {},
      { dedupeKey: `schedule_reminder:${String(Math.floor(Date.now() / 3_600_000))}` },
    );
  } catch (error) {
    // Maintenance must never take the loop down; the next tick retries it.
    logger.error({ err: error }, 'maintenance pass failed');
  }
}

async function main(): Promise<void> {
  logger.info(
    {
      workerId: WORKER_ID,
      concurrency: env.WORKER_CONCURRENCY,
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
      leaseSeconds: env.WORKER_LEASE_SECONDS,
      queueDriver: env.QUEUE_DRIVER,
    },
    'UBOSS worker started',
  );

  await maintenance();
  const maintenanceTimer = setInterval(() => void maintenance(), MAINTENANCE_INTERVAL_MS);

  const shutdown = (signal: string): void => {
    if (!running) return;
    running = false;
    logger.info({ signal, inFlight }, 'worker shutting down');
    clearInterval(maintenanceTimer);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'unhandled promise rejection in worker');
    shutdown('unhandledRejection');
  });

  while (running) {
    try {
      await tick();
    } catch (error) {
      // A failed tick is usually a transient database blip. Log and keep
      // polling rather than exiting and relying on a restart.
      logger.error({ err: error }, 'worker tick failed');
    }

    await new Promise((resolve) => setTimeout(resolve, env.WORKER_POLL_INTERVAL_MS));
  }

  // Let in-flight jobs finish before the connection pool closes, so a job that
  // already did its work still gets marked complete.
  const drainDeadline = Date.now() + 15_000;
  while (inFlight > 0 && Date.now() < drainDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (inFlight > 0) {
    // Their leases will expire and the reaper will hand them back.
    logger.warn({ inFlight }, 'exiting with jobs still in flight; leases will be reclaimed');
  }

  await queue.shutdown();
  await disconnectPrisma();
  logger.info('worker stopped');
  process.exit(0);
}

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'worker failed to start');
  process.exit(1);
});
