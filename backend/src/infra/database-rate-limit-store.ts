/** Shared rate-limit counters for every API process. */
import { createHash } from 'node:crypto';
import type {
  FastifyRateLimitOptions,
  FastifyRateLimitStore,
} from '@fastify/rate-limit';
import type { RouteOptions } from 'fastify';
import { prisma } from './prisma.js';

type IncrementCallback = (
  error: Error | null,
  result?: { current: number; ttl: number },
) => void;

interface StoreOptionsWithRoute extends FastifyRateLimitOptions {
  routeInfo?: { method?: string | string[]; url?: string };
}

export class DatabaseRateLimitStore implements FastifyRateLimitStore {
  private readonly scope: string;

  constructor(options: FastifyRateLimitOptions, scope = 'global') {
    const route = (options as StoreOptionsWithRoute).routeInfo;
    const method = Array.isArray(route?.method) ? route.method.join(',') : route?.method;
    this.scope = route?.url === undefined ? scope : `${method ?? 'ANY'}:${route.url}`;
  }

  child(options: RouteOptions & { path: string; prefix: string }): FastifyRateLimitStore {
    return new DatabaseRateLimitStore(options, this.scope);
  }

  incr(key: string, callback: IncrementCallback, timeWindow: number, _max: number): void {
    void this.increment(key, timeWindow)
      .then((result) => callback(null, result))
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error('Rate-limit storage failed.')),
      );
  }

  private async increment(key: string, timeWindow: number): Promise<{ current: number; ttl: number }> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + timeWindow);
    // Do not persist IP addresses or other raw subjects in an operational
    // table. The scope keeps login and global windows independent.
    const bucketKey = createHash('sha256').update(`${this.scope}\0${key}`).digest('hex');

    await prisma.$executeRaw`
      INSERT INTO rate_limit_buckets
        (bucketKey, counter, windowStart, expiresAt, updatedAt)
      VALUES
        (${bucketKey}, 1, ${now}, ${expiresAt}, ${now})
      ON DUPLICATE KEY UPDATE
        counter = IF(expiresAt <= VALUES(windowStart), 1, counter + 1),
        windowStart = IF(expiresAt <= VALUES(windowStart), VALUES(windowStart), windowStart),
        expiresAt = IF(expiresAt <= VALUES(windowStart), VALUES(expiresAt), expiresAt),
        updatedAt = VALUES(updatedAt)
    `;

    const row = await prisma.rateLimitBucket.findUniqueOrThrow({
      where: { bucketKey },
      select: { counter: true, expiresAt: true },
    });

    return {
      current: row.counter,
      ttl: Math.max(0, row.expiresAt.getTime() - Date.now()),
    };
  }
}
