/**
 * Support monitoring for buyers' own ERP connections.
 *
 * Staff need to be able to answer "is this customer's integration working" when
 * they ring up, and they need to be able to answer it without being able to
 * read the customer's credentials, their field mappings, or their purchase
 * orders.
 *
 * WHAT THIS SURFACE DELIBERATELY DOES NOT RETURN
 *
 *   - **No credentials and no hints.** Not masked, not truncated: absent. A
 *     hint is `X-API-Key: sk_live...9f2a`, which is enough to tell one key from
 *     another and is still the customer's. `summariseCredentials` is not
 *     imported by this file, and that is the control.
 *   - **No endpoint paths, no base URLs beyond the host.** A buyer's internal
 *     URL structure is theirs. The HOST is shown, because "we cannot reach
 *     erp.customer.example" is the single most useful thing support can say.
 *   - **No field mappings and no request or response bodies.** Those contain
 *     the customer's own data - SKUs, quantities, prices, supplier numbers.
 *     What support gets instead is the error CODE and the safe message, which
 *     is what actually determines the remedy.
 *   - **No write actions at all.** Staff cannot test, activate, pause,
 *     disconnect or retry on a customer's behalf. Every one of those is an
 *     action against a system this business does not own, using a credential
 *     its customer supplied for their own purposes, and "support pressed the
 *     button" is not a defensible answer to "who raised this purchase order".
 *     The remedy support offers is a phone call and a screen-share.
 *
 * Reading is gated on `integration.read`, the same permission that governs the
 * operator's own connector screens.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { Permission } from '../../domain/permissions.js';
import { connectionStateLabel } from '../../domain/customer-erp-state.js';
import { prisma } from '../../infra/prisma.js';
import { requireAdmin } from '../plugins/auth.js';
import { presetById } from '../../modules/customer-erp/vendor-presets.js';

export function registerAdminCustomerErpRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Every buyer connection on the installation, with its health.
   *
   * The list support opens first thing: which tenants have connections, which
   * are broken, and how long each has been broken for.
   */
  app.get(
    '/customer-erp/connections',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const query = z
        .object({
          state: z
            .enum([
              'DRAFT',
              'TESTING',
              'ACTIVE',
              'PAUSED',
              'ACTION_REQUIRED',
              'FAILED',
              'DISCONNECTED',
            ])
            .optional(),
          system: z.enum(['SAP', 'MONDAY', 'ODOO', 'CUSTOM']).optional(),
          search: z.string().max(128).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const search = (query.search ?? '').trim();

      const rows = await prisma.customerErpConnection.findMany({
        where: {
          deletedAt: null,
          ...(query.state === undefined ? {} : { state: query.state }),
          ...(query.system === undefined ? {} : { system: query.system }),
          ...(search.length === 0
            ? {}
            : {
                OR: [
                  { name: { contains: search } },
                  { organization: { nameNormalized: { contains: search.toLowerCase() } } },
                ],
              }),
        },
        include: { organization: { select: { id: true, name: true } } },
        orderBy: [{ state: 'asc' }, { updatedAt: 'desc' }],
        take: query.limit,
      });

      // Counts by state, per connection, in one grouped query rather than one
      // query per row - support opens this list on every call and a fifty-row
      // page must not be fifty round trips.
      const counts = await prisma.customerErpSyncEvent.groupBy({
        by: ['connectionId', 'state'],
        where: { connectionId: { in: rows.map((row) => row.id) } },
        _count: { _all: true },
      });

      const byConnection = new Map<string, Record<string, number>>();

      for (const entry of counts) {
        const existing = byConnection.get(entry.connectionId) ?? {};
        existing[entry.state] = entry._count._all;
        byConnection.set(entry.connectionId, existing);
      }

      return reply.status(200).send({
        available: env.FEATURE_CUSTOMER_ERP,
        connections: rows.map((row) => ({
          id: row.id,
          organizationId: row.organization.id,
          organizationName: row.organization.name,
          name: row.name,
          system: row.system,
          // The brand, so support can tell a misconfigured Dynamics from a
          // misconfigured QuickBooks - both of which are `system: CUSTOM`.
          vendorLabel: presetById(row.vendorPreset)?.label ?? row.system,
          environment: row.environment,
          state: row.state,
          stateLabel: connectionStateLabel(row.state),
          stateReason: row.stateReason,
          // The HOST only. A buyer's internal URL structure is theirs; "we
          // cannot reach that host" is the useful half and the only half.
          host: safeHost(row.baseUrl),
          authMethod: row.authMethod,
          webhookEnabled: row.webhookEnabled,
          pollingEnabled: row.pollingEnabled,
          pollingIntervalMinutes: row.pollingIntervalMinutes,
          consecutiveFailures: row.consecutiveFailures,
          lastTestAt: row.lastTestAt?.toISOString() ?? null,
          lastTestOk: row.lastTestOk,
          lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
          lastFailureAt: row.lastFailureAt?.toISOString() ?? null,
          nextPollAt: row.nextPollAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          eventCounts: byConnection.get(row.id) ?? {},
        })),
      });
    },
  );

  /**
   * One connection's recent events.
   *
   * The error code, the safe message, the HTTP status and the timings - and
   * NOT `requestJson` or `responseJson`, which hold the customer's own order
   * data. Support diagnosing "their SAP keeps refusing us" needs the code and
   * the status; it does not need the SKUs.
   */
  app.get(
    '/customer-erp/connections/:id/events',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
        .parse(request.query);

      const rows = await prisma.customerErpSyncEvent.findMany({
        where: { connectionId: id },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        // A select list rather than a full row, so a column added later that
        // happens to hold customer data does not start appearing here.
        select: {
          id: true,
          eventType: true,
          state: true,
          attemptCount: true,
          httpStatus: true,
          durationMs: true,
          errorCode: true,
          errorMessage: true,
          skipReason: true,
          nextRetryAt: true,
          correlationId: true,
          createdAt: true,
          completedAt: true,
        },
      });

      return reply.status(200).send({
        events: rows.map((row) => ({
          ...row,
          nextRetryAt: row.nextRetryAt?.toISOString() ?? null,
          createdAt: row.createdAt.toISOString(),
          completedAt: row.completedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  /**
   * Inbound deliveries, verified and refused alike.
   *
   * A run of refusals against one connection is either a misconfigured ERP or
   * somebody probing the endpoint, and the operator is the only one positioned
   * to notice the second pattern across tenants. The payload is not returned.
   */
  app.get(
    '/customer-erp/connections/:id/deliveries',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
        .parse(request.query);

      const rows = await prisma.customerErpWebhookEvent.findMany({
        where: { connectionId: id },
        orderBy: { receivedAt: 'desc' },
        take: query.limit,
        select: {
          id: true,
          externalEventType: true,
          verified: true,
          rejectionReason: true,
          receivedAt: true,
          processedAt: true,
          correlationId: true,
        },
      });

      return reply.status(200).send({
        deliveries: rows.map((row) => ({
          ...row,
          receivedAt: row.receivedAt.toISOString(),
          processedAt: row.processedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  /** A roll-up for the dashboard: how many connections, in what state. */
  app.get(
    '/customer-erp/summary',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (_request, reply) => {
      const [byState, bySystem, failingEvents, pendingApprovals] = await Promise.all([
        prisma.customerErpConnection.groupBy({
          by: ['state'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.customerErpConnection.groupBy({
          by: ['system'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        prisma.customerErpSyncEvent.count({ where: { state: 'FAILED' } }),
        prisma.customerErpApproval.count({ where: { state: 'PENDING' } }),
      ]);

      return reply.status(200).send({
        available: env.FEATURE_CUSTOMER_ERP,
        byState: Object.fromEntries(byState.map((row) => [row.state, row._count._all])),
        bySystem: Object.fromEntries(bySystem.map((row) => [row.system, row._count._all])),
        failingEvents,
        pendingApprovals,
      });
    },
  );

  return Promise.resolve();
}

/** The host, and nothing else. Never a path, never a query string. */
function safeHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).host;
  } catch {
    return 'unparseable';
  }
}
