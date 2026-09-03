/**
 * Health endpoints.
 *
 * The split matters to an orchestrator:
 *   /health/live  - "is the process alive?" Never touches a dependency. A
 *                   database outage must not get the container killed and
 *                   restarted, because restarting fixes nothing.
 *   /health/ready - "should traffic be routed here?" Checks the database and
 *                   the queue, and returns 503 when either is down so the load
 *                   balancer drains this instance instead.
 */
import type { FastifyInstance } from 'fastify';
import { metricsContentType, renderMetrics } from '../../infra/metrics.js';
import { checkQueue } from '../../infra/queue/index.js';
import { checkDatabase } from '../../infra/prisma.js';

const startedAt = Date.now();

interface DependencyResult {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

export function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', (_request, reply) =>
    reply.status(200).send({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.get('/health/ready', async (_request, reply) => {
    const [database, queue] = await Promise.all([checkDatabase(), checkQueue()]);

    const dependencies: Record<string, DependencyResult> = { database, queue };
    const ready = Object.values(dependencies).every((dependency) => dependency.ok);

    return reply.status(ready ? 200 : 503).send({
      status: ready ? 'ready' : 'not_ready',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      dependencies,
    });
  });

  /**
   * Prometheus scrape endpoint.
   *
   * Deliberately unauthenticated, like the health probes: a scraper has no
   * session, and the numbers here are counts and latencies - no customer data,
   * no identifiers. In production it belongs on an internal port or behind a
   * network policy, which is a deployment concern rather than a code one.
   */
  app.get('/metrics', async (_request, reply) =>
    reply.header('Content-Type', metricsContentType).status(200).send(await renderMetrics()),
  );

  return Promise.resolve();
}
