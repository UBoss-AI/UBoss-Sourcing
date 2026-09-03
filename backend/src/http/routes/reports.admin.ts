/**
 * Reports, exports and integrations - admin only.
 *
 * Every figure here is a database aggregate. The Admin Panel renders what these
 * return; it never sums a paginated page and calls the result revenue.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';
import {
  createConnector,
  getSyncRun,
  listConnectors,
  runSync,
  setConnectorActive,
  testConnector,
} from '../../modules/integrations/connector.service.js';
import {
  ExportType,
  downloadExport,
  getExportStatus,
  requestExport,
} from '../../modules/reports/export.service.js';
import {
  customerReport,
  dashboard,
  fulfilmentAgeing,
  inventoryMovementSummary,
  inventoryValuation,
  ordersByStatus,
  paymentsReport,
  recurringReport,
  resolveWindow,
  salesByCategory,
  salesByPeriod,
  salesSummary,
  topCustomers,
  topProducts,
} from '../../modules/reports/report.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const windowQuery = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

function actorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  ipAddress: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerAdminReportRoutes(app: FastifyInstance): Promise<void> {
  // --- Dashboard -----------------------------------------------------------

  app.get(
    '/dashboard',
    { preHandler: requireAdmin(Permission.REPORT_READ) },
    async (request, reply) => {
      const query = windowQuery.parse(request.query);
      return reply.status(200).send(await dashboard(resolveWindow(query.from, query.to)));
    },
  );

  // --- Sales ---------------------------------------------------------------

  app.get(
    '/reports/sales',
    { preHandler: requireAdmin(Permission.REPORT_READ) },
    async (request, reply) => {
      const query = windowQuery
        .extend({
          granularity: z.enum(['day', 'month']).default('day'),
          limit: z.coerce.number().int().min(1).max(100).default(20),
        })
        .parse(request.query);

      const window = resolveWindow(query.from, query.to);

      const [summary, byPeriod, products, customers, categories] = await Promise.all([
        salesSummary(window),
        salesByPeriod(window, query.granularity),
        topProducts(window, query.limit),
        topCustomers(window, query.limit),
        salesByCategory(window),
      ]);

      return reply.status(200).send({
        summary,
        byPeriod,
        topProducts: products,
        topCustomers: customers,
        byCategory: categories,
      });
    },
  );

  // --- Orders --------------------------------------------------------------

  app.get(
    '/reports/orders',
    { preHandler: requireAdmin(Permission.REPORT_READ) },
    async (request, reply) => {
      const query = windowQuery.parse(request.query);
      const window = resolveWindow(query.from, query.to);

      const [byStatus, ageing] = await Promise.all([ordersByStatus(window), fulfilmentAgeing()]);
      return reply.status(200).send({ byStatus, fulfilmentAgeing: ageing });
    },
  );

  // --- Payments ------------------------------------------------------------

  app.get(
    '/reports/payments',
    // Financial reporting sits behind payment.read, not the general
    // report.read: a Catalog Manager has no business seeing settlement data.
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (request, reply) => {
      const query = windowQuery.parse(request.query);
      return reply.status(200).send(await paymentsReport(resolveWindow(query.from, query.to)));
    },
  );

  // --- Inventory -----------------------------------------------------------

  app.get(
    '/reports/inventory',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = windowQuery
        .extend({ lowStockOnly: z.enum(['true', 'false']).default('false') })
        .parse(request.query);

      const window = resolveWindow(query.from, query.to);

      const [valuation, movements] = await Promise.all([
        inventoryValuation({ lowStockOnly: query.lowStockOnly === 'true' }),
        inventoryMovementSummary(window),
      ]);

      return reply.status(200).send({ valuation, movements });
    },
  );

  // --- Customers and recurring --------------------------------------------

  app.get(
    '/reports/customers',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const query = windowQuery.parse(request.query);
      return reply.status(200).send(await customerReport(resolveWindow(query.from, query.to)));
    },
  );

  app.get(
    '/reports/recurring',
    { preHandler: requireAdmin(Permission.SCHEDULE_READ) },
    async (request, reply) => {
      const query = z
        .object({ daysAhead: z.coerce.number().int().min(1).max(90).default(7) })
        .parse(request.query);

      return reply.status(200).send(await recurringReport(query.daysAhead));
    },
  );

  // --- Exports -------------------------------------------------------------

  /**
   * Request an export.
   *
   * Returns immediately with a job id; the file is built by the worker. A year
   * of orders is not something to assemble inside an HTTP request.
   */
  app.post(
    '/exports',
    {
      preHandler: requireAdmin(Permission.EXPORT_CREATE),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const body = z
        .object({
          type: z.enum(Object.values(ExportType) as [string, ...string[]]),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .parse(request.body);

      const actor = actorFrom(request);

      const result = await requestExport({
        type: body.type as (typeof ExportType)[keyof typeof ExportType],
        ...(body.from !== undefined ? { from: body.from } : {}),
        ...(body.to !== undefined ? { to: body.to } : {}),
        actorUserId: actor.userId,
        actorEmail: actor.email,
        ipAddress: actor.ipAddress,
        correlationId: actor.correlationId,
      });

      return reply.status(202).send(result);
    },
  );

  app.get(
    '/exports',
    { preHandler: requireAdmin(Permission.EXPORT_CREATE) },
    async (request, reply) => {
      const auth = currentUser(request);

      const jobs = await prisma.exportJob.findMany({
        // Scoped to the requester: one admin's export of customer data is not
        // another's to collect.
        where: { createdById: auth.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          type: true,
          status: true,
          rowCount: true,
          fileName: true,
          downloadExpiresAt: true,
          errorMessage: true,
          createdAt: true,
          completedAt: true,
        },
      });

      return reply.status(200).send({
        exports: jobs.map((job) => ({
          ...job,
          downloadExpiresAt: job.downloadExpiresAt?.toISOString() ?? null,
          createdAt: job.createdAt.toISOString(),
          completedAt: job.completedAt?.toISOString() ?? null,
        })),
      });
    },
  );

  app.get(
    '/exports/:id',
    { preHandler: requireAdmin(Permission.EXPORT_CREATE) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const auth = currentUser(request);

      return reply.status(200).send(await getExportStatus(id, auth.id));
    },
  );

  // --- Integrations --------------------------------------------------------

  app.get(
    '/integrations',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (_request, reply) => reply.status(200).send({ connectors: await listConnectors() }),
  );

  app.post(
    '/integrations',
    { preHandler: requireAdmin(Permission.INTEGRATION_WRITE) },
    async (request, reply) => {
      const body = z
        .object({
          name: z.string().trim().min(1).max(128),
          baseUrl: z.string().url().max(1024),
          authType: z.enum(['NONE', 'API_KEY_HEADER', 'BEARER_TOKEN', 'BASIC']),
          credentials: z
            .object({
              headerName: z.string().max(64).optional(),
              token: z.string().max(512).optional(),
              username: z.string().max(128).optional(),
              password: z.string().max(512).optional(),
            })
            .optional(),
          fieldMapping: z.object({
            sku: z.string().min(1).max(128),
            name: z.string().max(128).optional(),
            priceMinor: z.string().max(128).optional(),
            stockQty: z.string().max(128).optional(),
            shortDescription: z.string().max(128).optional(),
            itemsPath: z.string().max(128).optional(),
          }),
          direction: z.enum(['IMPORT', 'EXPORT', 'BIDIRECTIONAL']).optional(),
          conflictPolicy: z.enum(['EXTERNAL_WINS', 'UBOSS_WINS', 'FIELD_LEVEL']).optional(),
          scheduleCron: z.string().max(64).nullable().optional(),
          timeoutMs: z.number().int().min(1000).max(60_000).optional(),
          maxRetries: z.number().int().min(0).max(10).optional(),
          alertRecipients: z.array(z.string().email()).max(10).optional(),
        })
        .parse(request.body);

      const result = await createConnector(body, actorFrom(request));
      return reply.status(201).send(result);
    },
  );

  /** Proves the endpoint answers and reports its field names, for mapping. */
  app.post(
    '/integrations/:id/test',
    {
      preHandler: requireAdmin(Permission.INTEGRATION_WRITE),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const result = await testConnector(id, actorFrom(request));
      return reply.status(result.ok ? 200 : 502).send(result);
    },
  );

  /**
   * Run a sync.
   *
   * Dry run by default. Writing requires `dryRun: false` explicitly, because a
   * bad mapping that silently reprices the catalog is the failure that matters.
   */
  app.post(
    '/integrations/:id/sync',
    {
      preHandler: requireAdmin(Permission.INTEGRATION_WRITE),
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const body = z.object({ dryRun: z.boolean().default(true) }).parse(request.body ?? {});
      const auth = currentUser(request);

      const result = await runSync({
        connectionId: id,
        dryRun: body.dryRun,
        triggeredBy: 'manual',
        actorUserId: auth.id,
      });

      return reply.status(200).send(result);
    },
  );

  app.patch(
    '/integrations/:id/status',
    { preHandler: requireAdmin(Permission.INTEGRATION_WRITE) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      const body = z.object({ active: z.boolean() }).parse(request.body);

      await setConnectorActive(id, body.active, actorFrom(request));
      return reply.status(200).send({ isActive: body.active });
    },
  );

  app.get(
    '/integrations/sync-runs/:id',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      return reply.status(200).send(await getSyncRun(id));
    },
  );

  // --- Audit ---------------------------------------------------------------

  app.get(
    '/audit-logs',
    { preHandler: requireAdmin(Permission.AUDIT_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          action: z.string().max(96).optional(),
          resourceType: z.string().max(48).optional(),
          resourceId: z.string().length(26).optional(),
          actorUserId: z.string().length(26).optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .parse(request.query);

      const where = {
        ...(query.action !== undefined ? { action: query.action } : {}),
        ...(query.resourceType !== undefined ? { resourceType: query.resourceType } : {}),
        ...(query.resourceId !== undefined ? { resourceId: query.resourceId } : {}),
        ...(query.actorUserId !== undefined ? { actorUserId: query.actorUserId } : {}),
        ...(query.from !== undefined || query.to !== undefined
          ? {
              createdAt: {
                ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
                ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.auditLog.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
        }),
        prisma.auditLog.count({ where }),
      ]);

      return reply.status(200).send({
        entries: rows.map((row) => ({
          id: row.id,
          action: row.action,
          resourceType: row.resourceType,
          resourceId: row.resourceId,
          actorType: row.actorType,
          actorUserId: row.actorUserId,
          actorEmail: row.actorEmail,
          // Values were redacted on write; secrets are already [REDACTED].
          before: row.beforeJson,
          after: row.afterJson,
          ipAddress: row.ipAddress,
          correlationId: row.correlationId,
          createdAt: row.createdAt.toISOString(),
        })),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  return Promise.resolve();
}

/**
 * Export download.
 *
 * Unauthenticated by token: the hashed, expiring token IS the authorisation,
 * so a link can be followed from an email client or a fresh tab without a
 * session. It is registered outside the admin tree for exactly that reason.
 */
export function registerExportDownloadRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/download/:token',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { token } = z.object({ token: z.string().min(16).max(512) }).parse(request.params);
      const file = await downloadExport(token);

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        // `attachment` so the browser saves rather than renders it - a CSV
        // rendered inline is a stored-XSS vector in some clients.
        .header('Content-Disposition', `attachment; filename="${file.fileName}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .status(200)
        .send(file.content);
    },
  );

  return Promise.resolve();
}
