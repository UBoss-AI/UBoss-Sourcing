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
 *
 * WHAT THESE MAY SAY, AND WHAT THEY MAY NOT
 *
 * Both are reachable without a session - nginx proxies `/health/` to every
 * caller, because an uptime check has no credential to offer. So the response
 * body is held to what an anonymous stranger may know: up or down, and how
 * long it took.
 *
 * It used to carry the driver's own failure text as well, and that text is
 * written for an operator: MariaDB and Prisma name the host, the port and the
 * database user in it. An outage was therefore the moment this endpoint handed
 * out the shape of the infrastructure, to anybody, unauthenticated. The reason
 * is logged at error level with the correlation id instead - the operator reads
 * it in the journal, which is where they were already looking.
 */
import type { FastifyInstance } from 'fastify';
import { metricsContentType, renderMetrics } from '../../infra/metrics.js';
import { checkQueue } from '../../infra/queue/index.js';
import { checkDatabase } from '../../infra/prisma.js';

const startedAt = Date.now();

/** What a caller is told: whether it answered, and how quickly. Never why not. */
interface PublicDependencyResult {
  ok: boolean;
  latencyMs: number;
}

export function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/live', (_request, reply) =>
    reply.status(200).send({
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    }),
  );

  app.get('/health/ready', async (request, reply) => {
    const [database, queue] = await Promise.all([checkDatabase(), checkQueue()]);

    const ready = database.ok && queue.ok;

    if (!ready) {
      // The whole reason, once, where an operator can read it. Never in the
      // response - see this file's header.
      request.log.error(
        {
          correlationId: request.correlationId,
          database: { ok: database.ok, error: database.error },
          queue: { ok: queue.ok, error: queue.error },
        },
        'readiness check failed',
      );
    }

    const dependencies: Record<string, PublicDependencyResult> = {
      database: { ok: database.ok, latencyMs: database.latencyMs },
      queue: { ok: queue.ok, latencyMs: queue.latencyMs },
    };

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
