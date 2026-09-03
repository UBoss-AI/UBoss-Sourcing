/**
 * Job queue - integration, against a real MariaDB.
 *
 * This is the test that justifies the whole queue design. MariaDB 10.4 has no
 * `FOR UPDATE SKIP LOCKED`, so claiming is done with an optimistic conditional
 * UPDATE instead. If that guard is wrong, two workers process the same job -
 * which for `schedule.run` means charging a customer twice.
 *
 * Requires TEST_DATABASE_URL to be migrated:
 *   PRISMA_TARGET_TEST_DB=1 npx prisma migrate deploy
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseJobQueue } from '../../src/infra/queue/database-queue.js';
import { JobType } from '../../src/infra/queue/types.js';
import { prisma } from '../../src/infra/prisma.js';

const queue = new DatabaseJobQueue();

beforeEach(async () => {
  await prisma.jobQueue.deleteMany({});
});

afterAll(async () => {
  await prisma.jobQueue.deleteMany({});
  await prisma.$disconnect();
});

describe('enqueue', () => {
  it('stores a job as PENDING and due now', async () => {
    const id = await queue.enqueue(JobType.NOTIFICATION_SEND, { to: 'a@example.com' });
    expect(id).not.toBeNull();

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id: id! } });
    expect(row.status).toBe('PENDING');
    expect(row.jobType).toBe(JobType.NOTIFICATION_SEND);
    expect(row.attemptCount).toBe(0);
  });

  it('round-trips the payload and the correlation id', async () => {
    const id = await queue.enqueue(
      JobType.PAYMENT_RECONCILE,
      { orderId: '01ABC', amountMinor: '149950' },
      { correlationId: '01CORRELATION' },
    );

    const [claimed] = await queue.claim(1, 60, 'worker-1');
    expect(claimed?.id).toBe(id);
    expect(claimed?.payload).toEqual({ orderId: '01ABC', amountMinor: '149950' });
    expect(claimed?.correlationId).toBe('01CORRELATION');
  });

  it('drops a duplicate dedupeKey instead of queueing the job twice', async () => {
    const first = await queue.enqueue(JobType.PAYMENT_RECONCILE, { orderId: '01X' }, {
      dedupeKey: 'reconcile:01X',
    });
    const second = await queue.enqueue(JobType.PAYMENT_RECONCILE, { orderId: '01X' }, {
      dedupeKey: 'reconcile:01X',
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(await prisma.jobQueue.count()).toBe(1);
  });

  it('does not claim a job scheduled for the future', async () => {
    await queue.enqueue(JobType.SCHEDULE_REMINDER, {}, {
      runAt: new Date(Date.now() + 60_000),
    });
    expect(await queue.claim(10, 60, 'worker-1')).toHaveLength(0);
  });
});

describe('claiming', () => {
  it('honours priority, then age', async () => {
    await queue.enqueue(JobType.NOTIFICATION_SEND, { tag: 'low' }, { priority: 0 });
    await queue.enqueue(JobType.NOTIFICATION_SEND, { tag: 'high' }, { priority: 10 });

    const [first] = await queue.claim(1, 60, 'worker-1');
    expect(first?.payload).toEqual({ tag: 'high' });
  });

  it('marks a claimed job RUNNING with a lease and an incremented attempt', async () => {
    const id = await queue.enqueue(JobType.NOTIFICATION_SEND, {});
    await queue.claim(1, 60, 'worker-alpha');

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id: id! } });
    expect(row.status).toBe('RUNNING');
    expect(row.leaseOwner).toBe('worker-alpha');
    expect(row.attemptCount).toBe(1);
    expect(row.leaseExpiresAt).not.toBeNull();
  });

  /**
   * The critical one. Ten workers race for five jobs; every job must be claimed
   * exactly once. Without the conditional-UPDATE guard this over-delivers.
   */
  it('never hands the same job to two concurrent workers', async () => {
    const jobCount = 5;
    const workerCount = 10;

    for (let i = 0; i < jobCount; i += 1) {
      await queue.enqueue(JobType.SCHEDULE_RUN, { index: i });
    }

    const results = await Promise.all(
      Array.from({ length: workerCount }, (_, index) =>
        queue.claim(jobCount, 60, `worker-${String(index)}`),
      ),
    );

    const claimedIds = results.flat().map((job) => job.id);

    expect(claimedIds).toHaveLength(jobCount);
    expect(new Set(claimedIds).size).toBe(jobCount);
    expect(await prisma.jobQueue.count({ where: { status: 'RUNNING' } })).toBe(jobCount);
  });

  it('leaves nothing claimable once every job is taken', async () => {
    await queue.enqueue(JobType.NOTIFICATION_SEND, {});
    expect(await queue.claim(10, 60, 'worker-1')).toHaveLength(1);
    expect(await queue.claim(10, 60, 'worker-2')).toHaveLength(0);
  });
});

describe('completion and failure', () => {
  it('marks a finished job SUCCEEDED and releases the lease', async () => {
    const id = await queue.enqueue(JobType.NOTIFICATION_SEND, {});
    await queue.claim(1, 60, 'worker-1');
    await queue.complete(id!);

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id: id! } });
    expect(row.status).toBe('SUCCEEDED');
    expect(row.leaseOwner).toBeNull();
    expect(row.completedAt).not.toBeNull();
  });

  it('reschedules a failure with backoff while attempts remain', async () => {
    const id = await queue.enqueue(JobType.NOTIFICATION_SEND, {}, { maxAttempts: 3 });
    await queue.claim(1, 60, 'worker-1');
    await queue.fail(id!, 'SMTP timeout');

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id: id! } });
    expect(row.status).toBe('PENDING');
    expect(row.lastError).toBe('SMTP timeout');
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
    expect(row.leaseOwner).toBeNull();
  });

  it('marks a job DEAD once attempts are exhausted, keeping the payload', async () => {
    const id = await queue.enqueue(JobType.NOTIFICATION_SEND, { to: 'a@example.com' }, {
      maxAttempts: 1,
    });
    await queue.claim(1, 60, 'worker-1');
    await queue.fail(id!, 'permanent bounce');

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id: id! } });
    // DEAD, not deleted: it is an operational signal and must stay replayable.
    expect(row.status).toBe('DEAD');
    expect(row.payloadJson).toMatchObject({ data: { to: 'a@example.com' } });
  });

  it('does not throw when failing a job that no longer exists', async () => {
    await expect(queue.fail('01NONEXISTENT0000000000000', 'gone')).resolves.toBeUndefined();
  });
});

describe('lease reaping', () => {
  it('returns a crashed worker’s job to PENDING', async () => {
    const id = await queue.enqueue(JobType.SCHEDULE_RUN, {});
    await queue.claim(1, 60, 'worker-that-dies');

    // Simulate the crash: the lease is held, but nobody is coming back for it.
    await prisma.jobQueue.update({
      where: { id: id! },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });

    expect(await queue.reapExpiredLeases()).toBe(1);

    const row = await prisma.jobQueue.findUniqueOrThrow({ where: { id: id! } });
    expect(row.status).toBe('PENDING');
    expect(row.leaseOwner).toBeNull();

    // And it is genuinely workable again.
    expect(await queue.claim(1, 60, 'worker-2')).toHaveLength(1);
  });

  it('leaves a live lease alone', async () => {
    await queue.enqueue(JobType.SCHEDULE_RUN, {});
    await queue.claim(1, 300, 'worker-1');
    expect(await queue.reapExpiredLeases()).toBe(0);
  });
});

describe('health', () => {
  it('reports the due-job depth', async () => {
    await queue.enqueue(JobType.NOTIFICATION_SEND, {});
    await queue.enqueue(JobType.NOTIFICATION_SEND, {});

    const health = await queue.health();
    expect(health.ok).toBe(true);
    expect(health.depth).toBe(2);
  });
});
