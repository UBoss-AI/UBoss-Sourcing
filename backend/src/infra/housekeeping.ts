/**
 * Operational housekeeping.
 *
 * `privacy/retention.service.ts` deletes personal data because somebody has a
 * right to have it deleted. This deletes bookkeeping because a database is not
 * infinite, and the two are kept apart on purpose: that file makes a careful
 * argument about Art. 5(1)(e) and none of it applies here.
 *
 * Every table below grows with TRAFFIC rather than with business volume, which
 * is what makes them worth their own pass:
 *
 *   - `job_queue` gains roughly twenty thousand rows a day from the
 *     maintenance beat alone, before a single order is placed.
 *   - `rate_limit_buckets` takes a write on every request that reaches the
 *     API, and keeps one row per address per route scope for ever.
 *   - `sessions` gains a row per refresh ROTATION, not per sign-in, so a
 *     browser in daily use leaves a trail behind it.
 *   - `idempotency_records` and `payment_events` each carry a stored response
 *     or payload, so their rows are large as well as numerous.
 *
 * None of them had a sweep. Two of them - sessions and idempotency records -
 * had a purge function written, exported, documented as "run periodically by
 * the worker", and never called by anything. This is the caller.
 *
 * Three properties, copied deliberately from the retention sweeps next door
 * because they were right there:
 *
 *   - **Bounded per pass.** At most `BATCH` rows each, so an installation
 *     turning this on with a year of backlog drains it over hours instead of
 *     locking a table for everybody in one statement.
 *   - **Zero means off.** An operator who wants to keep the lot sets the
 *     window to 0 and that sweep does nothing.
 *   - **Nothing here touches work still to be done.** A PENDING or RUNNING job
 *     is never deleted whatever the window says, and neither is a live session
 *     or an unexpired idempotency claim.
 */
import { env } from '../config/env.js';
import { purgeExpiredSessions } from '../modules/identity/session.service.js';
import { purgeExpiredIdempotencyRecords } from '../modules/orders/idempotency.service.js';
import { logger } from './logger.js';
import { prisma } from './prisma.js';

/** Rows one sweep may delete in a single pass. */
const BATCH = 500;

/**
 * How long a spent rate-limit bucket is kept after its window closes.
 *
 * Not a setting, because it is not a policy question: the row means nothing
 * once `expiresAt` has passed - the counter resets on the next request through
 * the same key regardless - and the only reason to wait at all is so a pass
 * racing a request in flight cannot delete a bucket that is about to be read.
 * An hour is several orders of magnitude more than that needs.
 */
const RATE_LIMIT_GRACE_MS = 3_600_000;

export interface HousekeepingResult {
  /** Rows removed, by sweep. Sweeps that removed nothing are omitted. */
  removed: Record<string, number>;
  /** True while any sweep is still hitting its batch ceiling. */
  moreToDo: boolean;
}

function cutoff(days: number): Date {
  return new Date(Date.now() - days * 86_400_000);
}

/**
 * Finished background jobs.
 *
 * SUCCEEDED and DEAD only. A DEAD job has exhausted its attempts and is worth
 * keeping for a while precisely because somebody may want to know what failed;
 * a PENDING or RUNNING one is work outstanding and must survive any window.
 *
 * Deleting these cannot resurrect a job. `dedupeKey` is unique and is what
 * stops the same job being queued twice, so the question is whether a key
 * could come round again after its row has gone - and none can. The
 * maintenance beat's keys carry the time slot they belong to (`schedule_run:
 * <minute>`, `fx_rate_refresh:<date>`), which only ever moves forward, and the
 * rest are keyed on a one-shot row id whose own table decides whether the work
 * is still outstanding.
 */
async function sweepFinishedJobs(days: number): Promise<number> {
  const stale = await prisma.jobQueue.findMany({
    where: { status: { in: ['SUCCEEDED', 'DEAD'] }, completedAt: { lt: cutoff(days) } },
    select: { id: true },
    take: BATCH,
  });

  if (stale.length === 0) return 0;

  const result = await prisma.jobQueue.deleteMany({
    where: { id: { in: stale.map((job) => job.id) } },
  });

  return result.count;
}

/**
 * Spent rate-limit counters.
 *
 * The one sweep with no window of its own: the row carries `expiresAt`, which
 * already says when it stopped meaning anything. Anything past that plus the
 * grace above is dead weight - and there is a lot of it, because the key is
 * derived from the caller's address and every scanner on the internet leaves
 * one behind.
 */
async function sweepRateLimitBuckets(): Promise<number> {
  const stale = await prisma.rateLimitBucket.findMany({
    where: { expiresAt: { lt: new Date(Date.now() - RATE_LIMIT_GRACE_MS) } },
    select: { bucketKey: true },
    take: BATCH,
  });

  if (stale.length === 0) return 0;

  const result = await prisma.rateLimitBucket.deleteMany({
    where: { bucketKey: { in: stale.map((bucket) => bucket.bucketKey) } },
  });

  return result.count;
}

/**
 * Verified provider webhooks past their window.
 *
 * Deliberately last and deliberately the longest window. These rows are the
 * evidence behind a captured payment, and the money itself lives on the order
 * and the transaction rather than here - which is the only reason this may be
 * deleted at all.
 *
 * An event still in flight or awaiting another attempt is never taken:
 * RECEIVED and FAILED are both claimable states, and deleting one under a
 * provider's retry would let the event be applied a second time. Only rows
 * that reached a decision are eligible.
 */
async function sweepPaymentEvents(days: number): Promise<number> {
  const stale = await prisma.paymentEvent.findMany({
    where: {
      processingStatus: { in: ['PROCESSED', 'REJECTED', 'DUPLICATE'] },
      receivedAt: { lt: cutoff(days) },
    },
    select: { id: true },
    take: BATCH,
  });

  if (stale.length === 0) return 0;

  const result = await prisma.paymentEvent.deleteMany({
    where: { id: { in: stale.map((event) => event.id) } },
  });

  return result.count;
}

/**
 * Run every operational sweep once.
 *
 * Failures are per sweep rather than per pass: a housekeeping error must not
 * stop the other four, and none of them is urgent enough to be worth failing
 * the job over. The next beat tries again.
 */
export async function runHousekeeping(): Promise<HousekeepingResult> {
  const sweeps: { name: string; run: () => Promise<number> }[] = [
    {
      name: 'finishedJobs',
      run: () =>
        env.RETENTION_JOB_HISTORY_DAYS === 0
          ? Promise.resolve(0)
          : sweepFinishedJobs(env.RETENTION_JOB_HISTORY_DAYS),
    },
    { name: 'rateLimitBuckets', run: sweepRateLimitBuckets },
    {
      name: 'expiredSessions',
      run: () =>
        env.RETENTION_EXPIRED_SESSION_DAYS === 0
          ? Promise.resolve(0)
          : purgeExpiredSessions(env.RETENTION_EXPIRED_SESSION_DAYS),
    },
    // No window: the row carries its own `expiresAt`, set when the claim was
    // made, and that IS the policy.
    { name: 'idempotencyRecords', run: purgeExpiredIdempotencyRecords },
    {
      name: 'paymentEvents',
      run: () =>
        env.RETENTION_PAYMENT_EVENT_DAYS === 0
          ? Promise.resolve(0)
          : sweepPaymentEvents(env.RETENTION_PAYMENT_EVENT_DAYS),
    },
  ];

  const removed: Record<string, number> = {};
  let moreToDo = false;

  for (const sweep of sweeps) {
    try {
      const count = await sweep.run();
      if (count > 0) removed[sweep.name] = count;
      if (count >= BATCH) moreToDo = true;
    } catch (error) {
      logger.error({ err: error, sweep: sweep.name }, 'a housekeeping sweep failed');
    }
  }

  if (Object.keys(removed).length > 0) {
    logger.info({ removed, moreToDo }, 'housekeeping removed operational rows');
  }

  return { removed, moreToDo };
}
