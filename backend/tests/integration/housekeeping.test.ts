/**
 * Operational housekeeping - integration, against a real MariaDB.
 *
 * The regression this file exists for is an absence rather than a bug: five
 * tables grew without limit because nothing ever swept them, and two of them -
 * sessions and idempotency records - had a purge function that was written,
 * exported, documented as "run periodically by the worker" and called by
 * nothing. A test that only checked the sweeps delete things would have passed
 * against that code, because the functions worked; what was missing was a
 * caller. So the last test here asserts the wiring, not the deleting.
 *
 * The other half of each test matters as much as the deleting: work still
 * outstanding must survive. A sweep that took a PENDING job, a live session or
 * a webhook awaiting another attempt would not be housekeeping, it would be
 * data loss - and in the webhook's case it would let a captured payment be
 * applied twice.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { runHousekeeping } from '../../src/infra/housekeeping.js';
import { newId } from '../../src/infra/ids.js';
import { prisma } from '../../src/infra/prisma.js';
import { JobType, queue } from '../../src/infra/queue/index.js';
import { handlerFor } from '../../src/worker/handlers.js';

/**
 * Comfortably outside every window under test, and the longest of them is the
 * two years `RETENTION_PAYMENT_EVENT_DAYS` gives a provider webhook - so this
 * has to clear 730 days, not merely look old.
 */
const LONG_AGO = new Date(Date.now() - 900 * 86_400_000);
const RECENTLY = new Date();

beforeEach(async () => {
  await prisma.jobQueue.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
});

afterAll(async () => {
  await prisma.jobQueue.deleteMany({});
  await prisma.rateLimitBucket.deleteMany({});
  await prisma.paymentEvent.deleteMany({});
  await prisma.idempotencyRecord.deleteMany({});
});

async function makeJob(status: 'SUCCEEDED' | 'DEAD' | 'PENDING', completedAt: Date | null) {
  const id = newId();
  await prisma.jobQueue.create({
    data: {
      id,
      jobType: 'test.housekeeping',
      payloadJson: {},
      status,
      completedAt,
      dedupeKey: `housekeeping-test:${id}`,
    },
  });
  return id;
}

describe('housekeeping', () => {
  it('removes finished jobs and leaves outstanding work alone', async () => {
    const oldSuccess = await makeJob('SUCCEEDED', LONG_AGO);
    const oldDead = await makeJob('DEAD', LONG_AGO);
    const recentSuccess = await makeJob('SUCCEEDED', RECENTLY);
    // The one that matters: a job nobody has run yet, older than any window.
    const pending = await makeJob('PENDING', null);

    await runHousekeeping();

    const surviving = await prisma.jobQueue.findMany({ select: { id: true } });
    const ids = surviving.map((job) => job.id);

    expect(ids).not.toContain(oldSuccess);
    expect(ids).not.toContain(oldDead);
    expect(ids).toContain(recentSuccess);
    expect(ids).toContain(pending);
  });

  it('removes rate-limit counters whose window has closed', async () => {
    await prisma.rateLimitBucket.create({
      data: {
        bucketKey: 'spent',
        counter: 9,
        windowStart: LONG_AGO,
        expiresAt: LONG_AGO,
      },
    });

    // Still counting. Deleting this would hand somebody a fresh allowance
    // halfway through their window, which is the one thing a rate limiter
    // must not do.
    await prisma.rateLimitBucket.create({
      data: {
        bucketKey: 'live',
        counter: 9,
        windowStart: RECENTLY,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });

    await runHousekeeping();

    const keys = (await prisma.rateLimitBucket.findMany({ select: { bucketKey: true } })).map(
      (bucket) => bucket.bucketKey,
    );

    expect(keys).not.toContain('spent');
    expect(keys).toContain('live');
  });

  it('removes expired idempotency claims and keeps live ones', async () => {
    await prisma.idempotencyRecord.create({
      data: {
        id: newId(),
        scope: 'CHECKOUT_SUBMIT',
        key: 'expired-key',
        requestHash: 'a'.repeat(64),
        status: 'COMPLETED',
        expiresAt: LONG_AGO,
      },
    });

    await prisma.idempotencyRecord.create({
      data: {
        id: newId(),
        scope: 'CHECKOUT_SUBMIT',
        key: 'live-key',
        requestHash: 'b'.repeat(64),
        status: 'COMPLETED',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });

    await runHousekeeping();

    const keys = (await prisma.idempotencyRecord.findMany({ select: { key: true } })).map(
      (record) => record.key,
    );

    expect(keys).not.toContain('expired-key');
    expect(keys).toContain('live-key');
  });

  /**
   * The sweep with the sharpest edge.
   *
   * A RECEIVED or FAILED row is an event that may still be claimed by a
   * provider's retry. Deleting one lets the retry insert a fresh row and apply
   * the capture a SECOND time - the duplicate credit this whole table exists
   * to make impossible. Only rows that reached a decision are eligible,
   * however old the others are.
   */
  it('removes only settled payment events, whatever their age', async () => {
    const rows: { status: 'PROCESSED' | 'REJECTED' | 'RECEIVED' | 'FAILED'; id: string }[] = [
      { status: 'PROCESSED', id: newId() },
      { status: 'REJECTED', id: newId() },
      { status: 'RECEIVED', id: newId() },
      { status: 'FAILED', id: newId() },
    ];

    for (const row of rows) {
      await prisma.paymentEvent.create({
        data: {
          id: row.id,
          provider: 'RAZORPAY',
          providerEventId: `evt_${row.id}`,
          eventType: 'payment.captured',
          signatureVerified: true,
          rawPayload: '{}',
          processingStatus: row.status,
          receivedAt: LONG_AGO,
        },
      });
    }

    await runHousekeeping();

    const surviving = (await prisma.paymentEvent.findMany({ select: { id: true } })).map(
      (event) => event.id,
    );

    expect(surviving).not.toContain(rows[0]?.id);
    expect(surviving).not.toContain(rows[1]?.id);
    // Still claimable, so still here.
    expect(surviving).toContain(rows[2]?.id);
    expect(surviving).toContain(rows[3]?.id);
  });

  it('does nothing to a table whose window is switched off', async () => {
    const kept = await makeJob('SUCCEEDED', LONG_AGO);

    const original = env.RETENTION_JOB_HISTORY_DAYS;
    // `0` is the documented way an operator keeps the lot.
    (env as { RETENTION_JOB_HISTORY_DAYS: number }).RETENTION_JOB_HISTORY_DAYS = 0;

    try {
      await runHousekeeping();
    } finally {
      (env as { RETENTION_JOB_HISTORY_DAYS: number }).RETENTION_JOB_HISTORY_DAYS = original;
    }

    expect(await prisma.jobQueue.findUnique({ where: { id: kept } })).not.toBeNull();
  });

  /**
   * The wiring, which is the thing that was actually missing.
   *
   * Two of these sweeps existed and worked for months while nothing called
   * them. A worker with no handler registered for this job type hands it back
   * to the queue every beat until its attempts run out, so the sweeps would
   * silently never run again - and the symptom would be a slow database
   * six months later with nothing in the application to explain it.
   */
  it('is registered as a job the worker can actually run', async () => {
    expect(handlerFor(JobType.HOUSEKEEPING_SWEEP)).toBeTypeOf('function');

    // And it survives a round trip through the queue, so the job type the
    // worker enqueues is the one it can handle.
    const jobId = await queue.enqueue(
      JobType.HOUSEKEEPING_SWEEP,
      {},
      { dedupeKey: `housekeeping_sweep:test:${newId()}` },
    );

    // Null would mean the dedupe key collided, which a fresh ULID cannot.
    expect(jobId).not.toBeNull();

    const stored = await prisma.jobQueue.findUniqueOrThrow({ where: { id: jobId ?? '' } });
    expect(handlerFor(stored.jobType)).toBeTypeOf('function');
  });
});
