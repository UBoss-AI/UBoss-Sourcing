/**
 * Product analytics (checklist Section 17 and LIVE-020).
 *
 * Public: a browser posts a small batch of event names with route patterns.
 * No session is read and no cookie is needed - the counters carry no
 * identifier - so the route takes no credentials and is rate-limited by
 * address instead. Staff with `report.read` read the totals and the
 * reconciliation against the source transactions.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import { ANALYTICS_EVENTS, analyticsSummary, reconcileAnalytics, recordEvents } from '../../modules/analytics/analytics.service.js';
import { requireAdmin } from '../plugins/auth.js';

const batch = z.object({
  events: z
    .array(z.object({ event: z.enum(ANALYTICS_EVENTS), screen: z.string().max(96).default('') }))
    .min(1)
    .max(20),
});

const range = z.object({ from: z.coerce.date(), to: z.coerce.date() });

export function registerPublicAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  // Count a batch of anonymous product events (route patterns only). Stores no identifier.
  app.post('/analytics/events', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { events } = batch.parse(request.body);
    await recordEvents(events);
    return reply.status(204).send();
  });
  return Promise.resolve();
}

export function registerAdminAnalyticsRoutes(app: FastifyInstance): Promise<void> {
  // Event totals and the most viewed screens for a range of UTC days.
  app.get('/analytics/summary', { preHandler: requireAdmin(Permission.REPORT_READ) }, async (request, reply) => {
    const query = range.parse(request.query);
    return reply.header('cache-control', 'no-store').send(await analyticsSummary(query));
  });

  // Client-reported events against the source transactions (orders, RFQs, returns, disputes).
  app.get('/analytics/reconciliation', { preHandler: requireAdmin(Permission.REPORT_READ) }, async (request, reply) => {
    const query = range.parse(request.query);
    return reply.header('cache-control', 'no-store').send(await reconcileAnalytics(query));
  });
  return Promise.resolve();
}
