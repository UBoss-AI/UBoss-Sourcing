/**
 * MariaDB-backed job queue.
 *
 * The interesting part is claiming. MariaDB 10.4 has no `FOR UPDATE SKIP
 * LOCKED` (that landed in 10.6), so the usual "lock the next N rows and move
 * on" pattern is unavailable: plain `FOR UPDATE` would make every worker queue
 * up behind the same row and serialise the whole pool.
 *
 * Instead, claiming is optimistic and lock-free:
 *
 *   1. SELECT a batch of candidate ids (no locks held).
 *   2. For each candidate, run a conditional UPDATE that only matches while the
 *      row is still PENDING.
 *   3. Proceed only when affectedRows === 1. A worker that loses the race sees
 *      0 and moves to the next candidate.
 *
 * Step 2 is atomic at the InnoDB row level, so exactly one worker can win. The
 * cost is a few wasted round-trips under heavy contention, which is a good
 * trade against serialising every worker.
 *
 * A worker that dies mid-job leaves `leaseExpiresAt` in the past;
 * `reapExpiredLeases` returns those rows to PENDING.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../prisma.js';
import { newId } from '../ids.js';
import { logger } from '../logger.js';
import type {
  ClaimedJob,
  EnqueueOptions,
  JobQueueDriver,
  JobTypeValue,
  QueueHealth,
} from './types.js';

/** Minimal surface both `prisma` and a transaction client satisfy. */
type PrismaLike = Pick<typeof prisma, 'jobQueue'>;

function clientFor(tx?: unknown): PrismaLike {
  return (tx as PrismaLike | undefined) ?? prisma;
}

/** Exponential backoff, capped. Attempt 1 -> 10s, 2 -> 20s, 3 -> 40s ... max 1h. */
function backoffSeconds(attemptCount: number): number {
  const base = 10 * 2 ** Math.max(0, attemptCount - 1);
  return Math.min(base, 3600);
}

export class DatabaseJobQueue implements JobQueueDriver {
  readonly name = 'database';

  async enqueue(
    jobType: JobTypeValue,
    payload: unknown,
    options: EnqueueOptions = {},
    tx?: unknown,
  ): Promise<string | null> {
    const client = clientFor(tx);
    const id = newId();

    const data: Prisma.JobQueueUncheckedCreateInput = {
      id,
      queue: options.queue ?? 'default',
      jobType,
      payloadJson: {
        data: payload,
        correlationId: options.correlationId ?? null,
      } as Prisma.InputJsonValue,
      status: 'PENDING',
      priority: options.priority ?? 0,
      runAt: options.runAt ?? new Date(),
      maxAttempts: options.maxAttempts ?? 5,
      ...(options.dedupeKey !== undefined ? { dedupeKey: options.dedupeKey } : {}),
    };

    if (options.dedupeKey === undefined) {
      await client.jobQueue.create({ data });
      return id;
    }

    // Deduped enqueue: a unique index on dedupeKey turns a duplicate into a
    // no-op rather than a second job. `createMany` with skipDuplicates keeps
    // that in one statement, so it is safe inside a caller's transaction (a
    // caught constraint error would otherwise abort the whole transaction).
    const result = await client.jobQueue.createMany({ data: [data], skipDuplicates: true });
    return result.count === 1 ? id : null;
  }

  async claim(limit: number, leaseSeconds: number, owner: string): Promise<ClaimedJob[]> {
    const now = new Date();

    // Step 1: candidates, no locks. Over-fetch so losing a race still leaves
    // work to try.
    const candidates = await prisma.jobQueue.findMany({
      where: { status: 'PENDING', runAt: { lte: now } },
      orderBy: [{ priority: 'desc' }, { runAt: 'asc' }],
      take: limit * 2,
      select: { id: true },
    });

    const claimed: ClaimedJob[] = [];
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1000);

    for (const candidate of candidates) {
      if (claimed.length >= limit) break;

      // Step 2 + 3: conditional update. `status: 'PENDING'` in the where clause
      // is the whole guard - once another worker flips it, this matches nothing.
      const result = await prisma.jobQueue.updateMany({
        where: { id: candidate.id, status: 'PENDING' },
        data: {
          status: 'RUNNING',
          leaseOwner: owner,
          leaseExpiresAt,
          startedAt: now,
          attemptCount: { increment: 1 },
        },
      });

      if (result.count !== 1) continue; // Lost the race; try the next candidate.

      const job = await prisma.jobQueue.findUnique({ where: { id: candidate.id } });
      if (!job) continue;

      const envelope = job.payloadJson as { data?: unknown; correlationId?: string | null } | null;

      claimed.push({
        id: job.id,
        jobType: job.jobType,
        queue: job.queue,
        payload: envelope?.data ?? null,
        attemptCount: job.attemptCount,
        maxAttempts: job.maxAttempts,
        correlationId: envelope?.correlationId ?? null,
      });
    }

    return claimed;
  }

  async complete(jobId: string): Promise<void> {
    await prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
      },
    });
  }

  async fail(jobId: string, error: string, retryDelaySeconds?: number): Promise<void> {
    const job = await prisma.jobQueue.findUnique({
      where: { id: jobId },
      select: { attemptCount: true, maxAttempts: true },
    });

    if (!job) {
      logger.warn({ jobId }, 'fail() called for a job that no longer exists');
      return;
    }

    const exhausted = job.attemptCount >= job.maxAttempts;

    if (exhausted) {
      // DEAD, not deleted. A dead job is an operational signal and the payload
      // is needed to replay it once the underlying cause is fixed.
      await prisma.jobQueue.update({
        where: { id: jobId },
        data: {
          status: 'DEAD',
          completedAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          lastError: error.slice(0, 4000),
        },
      });
      logger.error({ jobId, attempts: job.attemptCount }, 'job exhausted its retries');
      return;
    }

    const delay = retryDelaySeconds ?? backoffSeconds(job.attemptCount);

    await prisma.jobQueue.update({
      where: { id: jobId },
      data: {
        status: 'PENDING',
        runAt: new Date(Date.now() + delay * 1000),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: error.slice(0, 4000),
      },
    });
  }

  async reapExpiredLeases(): Promise<number> {
    const result = await prisma.jobQueue.updateMany({
      where: { status: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      data: {
        status: 'PENDING',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: 'Lease expired; the worker holding this job stopped responding.',
      },
    });

    if (result.count > 0) {
      logger.warn({ reclaimed: result.count }, 'reclaimed jobs from expired leases');
    }
    return result.count;
  }

  async health(): Promise<QueueHealth> {
    const startedAt = process.hrtime.bigint();
    try {
      const depth = await prisma.jobQueue.count({
        where: { status: 'PENDING', runAt: { lte: new Date() } },
      });
      return {
        ok: true,
        latencyMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        depth,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
        error: error instanceof Error ? error.message : 'unknown queue error',
      };
    }
  }

  shutdown(): Promise<void> {
    // Nothing to release: the queue rides on the shared Prisma pool, which the
    // process shutdown hook disconnects.
    return Promise.resolve();
  }
}
