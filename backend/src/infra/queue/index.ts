/**
 * Queue driver selection.
 *
 * `QUEUE_DRIVER=database` (the default) needs no extra infrastructure and is
 * what this deployment runs on, since XAMPP ships no Redis. `redis` is wired
 * as a deliberate not-yet-implemented boundary rather than a silent fallback:
 * booting a production instance that believes it has Redis and quietly does not
 * is worse than refusing to start.
 */
import { env } from '../../config/env.js';
import { DatabaseJobQueue } from './database-queue.js';
import type { JobQueueDriver, QueueHealth } from './types.js';

function createQueue(): JobQueueDriver {
  switch (env.QUEUE_DRIVER) {
    case 'database':
      return new DatabaseJobQueue();
    case 'redis':
      throw new Error(
        'QUEUE_DRIVER=redis is not implemented yet. Use QUEUE_DRIVER=database, or add ' +
          'src/infra/queue/redis-queue.ts implementing JobQueueDriver.',
      );
    default: {
      const exhaustive: never = env.QUEUE_DRIVER;
      throw new Error(`Unknown QUEUE_DRIVER: ${String(exhaustive)}`);
    }
  }
}

export const queue: JobQueueDriver = createQueue();

export function checkQueue(): Promise<QueueHealth> {
  return queue.health();
}

export { JobType } from './types.js';
export type {
  ClaimedJob,
  EnqueueOptions,
  JobQueueDriver,
  JobTypeValue,
  QueueHealth,
} from './types.js';
