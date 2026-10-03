/**
 * Reports, exports and integrations - admin only.
 *
 * Every figure here is a database aggregate. The Admin Panel renders what these
 * return; it never sums a paginated page and calls the result revenue.
 */
import { readExceptionCentre } from '../../modules/notifications/exception-centre.service.js';
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
import {
  disputeReport,
  gmvReport,
  inspectionSummary,
  settlementReport,
  supplierQualityReport,
} from '../../modules/reports/marketplace-report.service.js';
import { buildInsight } from '../../modules/assistant/insights.service.js';
import {
  AUDIT_EXPORT_ROWS_HEADER,
  AUDIT_EXPORT_TOTAL_HEADER,
  auditFilterSchema,
  exportAuditEntries,
  listAuditEntries,
} from '../../modules/audit/audit-log.read.js';
import {
  listDeadJobs,
  listFailedNotifications,
  retryDeadJob,
  retryFailedNotification,
} from '../../modules/notifications/dead-letter.service.js';
import {
  operationsInsightMetrics,
  readOperationsOverview,
} from '../../modules/notifications/operations-overview.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';
import {
  INSIGHT_RATE_LIMIT,
  assertUsableWindow,
  describeFilters,
  insightBody,
  streamInsightResponse,
} from './dashboard-insights.js';

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

  /**
   * What is waiting across the platform, grouped, for THIS member of staff.
   *
   * `requireAdmin()` with no permission listed is the deliberate "any member
   * of staff" form — the same one the portal's own summary routes use. The
   * authorization that matters here is not on the endpoint: it is on each
   * queue, inside `readOperationsOverview`, which counts only the queues the
   * caller holds the acting grant for and OMITS the rest.
   *
   * That is why this is not behind `REPORT_READ` like the figures below it.
   * Reporting is a job; knowing that four listings are waiting for you is not,
   * and gating it behind the reports grant would hide an operator's own work
   * from them.
   */
  app.get('/operations', { preHandler: requireAdmin() }, async (request, reply) => {
    const auth = currentUser(request);
    const overview = await readOperationsOverview({ permissions: auth.permissions });

    return reply.header('cache-control', 'no-store').status(200).send(overview);
  });

  // One queue of failed payments, missing documents, failed inspections, late shipments, settlement mismatches and integration failures (ENH-019).
  app.get('/exceptions', { preHandler: requireAdmin() }, async (request, reply) => {
    const centre = await readExceptionCentre({ permissions: currentUser(request).permissions });
    return reply.header('cache-control', 'no-store').status(200).send(centre);
  });

  // --- The dead-letter queues the overview counts -------------------------
  //
  // Reading needs SETTINGS_READ - the grant the dashboard queue itself is
  // gated on, so whoever sees the count can see what is behind it. Retrying
  // makes something happen that had stopped, so it needs SETTINGS_WRITE.
  // Neither response carries a job payload or an email body; see
  // modules/notifications/dead-letter.service.ts.
  const deadLetterPage = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  });
  const deadLetterId = z.object({ id: z.string().length(26) });
  const deadLetterActor = (request: FastifyRequest) => {
    const auth = currentUser(request);
    return { userId: auth.id, email: auth.email, ipAddress: request.ip, correlationId: request.correlationId };
  };

  // Background jobs that exhausted their attempts, newest first.
  app.get(
    '/operations/dead-jobs',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (request, reply) => {
      const page = deadLetterPage.parse(request.query);
      return reply.header('cache-control', 'no-store').send(await listDeadJobs(page));
    },
  );

  // Queue one more attempt of a dead background job.
  app.post(
    '/operations/dead-jobs/:id/retry',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const { id } = deadLetterId.parse(request.params);
      await retryDeadJob(id, deadLetterActor(request));
      return reply.status(202).send({ retried: true });
    },
  );

  // Emails that could not be delivered, newest first, with the recipient masked.
  app.get(
    '/operations/failed-notifications',
    { preHandler: requireAdmin(Permission.SETTINGS_READ) },
    async (request, reply) => {
      const page = deadLetterPage.parse(request.query);
      return reply.header('cache-control', 'no-store').send(await listFailedNotifications(page));
    },
  );

  // Queue one more delivery attempt of an undeliverable email.
  app.post(
    '/operations/failed-notifications/:id/retry',
    { preHandler: requireAdmin(Permission.SETTINGS_WRITE) },
    async (request, reply) => {
      const { id } = deadLetterId.parse(request.params);
      await retryFailedNotification(id, deadLetterActor(request));
      return reply.status(202).send({ retried: true });
    },
  );

  /**
   * The operational picture, explained.
   *
   * Same permission model as the overview itself, and for the same reason: the
   * metric bundle is built from `readOperationsOverview` for THIS caller, so a
   * queue they may not see is not in the bundle and therefore cannot be
   * mentioned. The model is never told what it is not allowed to say — it is
   * never given it.
   */
  /** The operational picture, delivered as it is written. See the buyer route. */
  app.post(
    '/dashboard/insights/stream',
    { preHandler: requireAdmin(), config: { rateLimit: INSIGHT_RATE_LIMIT } },
    async (request, reply) => {
      await streamInsightResponse(request, reply, async () => {
        const body = insightBody.parse(request.body ?? {});

        const window = resolveWindow(body.from, body.to);
        assertUsableWindow(window);

        const auth = currentUser(request);
        const overview = await readOperationsOverview({ permissions: auth.permissions });
        const metrics = operationsInsightMetrics(overview);

        return {
          audience: 'ADMIN' as const,
          window: { from: window.from.toISOString(), to: window.to.toISOString() },
          filters: describeFilters(window, {
            segment: metrics.some((metric) => metric.key === body.segment)
              ? (body.segment ?? null)
              : null,
          }),
          metrics,
          ...(body.question === undefined ? {} : { question: body.question }),
          ...(body.language === undefined ? {} : { language: body.language }),
        };
      });
    },
  );

  /**
   * A short written explanation of what is waiting across the platform for
   * this member of staff, optionally answering a question. Uses the AI
   * provider where one is set up and a plain summary otherwise; only queues
   * the caller may see are included.
   */
  app.post(
    '/dashboard/insights',
    { preHandler: requireAdmin(), config: { rateLimit: INSIGHT_RATE_LIMIT } },
    async (request, reply) => {
      const body = insightBody.parse(request.body ?? {});

      const window = resolveWindow(body.from, body.to);
      assertUsableWindow(window);

      const auth = currentUser(request);
      const overview = await readOperationsOverview({ permissions: auth.permissions });
      const metrics = operationsInsightMetrics(overview);

      const insight = await buildInsight({
        audience: 'ADMIN',
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        filters: describeFilters(window, {
          segment: metrics.some((metric) => metric.key === body.segment)
            ? (body.segment ?? null)
            : null,
        }),
        metrics,
        ...(body.question === undefined ? {} : { question: body.question }),
        ...(body.language === undefined ? {} : { language: body.language }),
      });

      return reply.header('cache-control', 'no-store').status(200).send(insight);
    },
  );

  app.get(
    '/dashboard',
    { preHandler: requireAdmin(Permission.REPORT_READ) },
    async (request, reply) => {
      const query = windowQuery.parse(request.query);
      return reply.status(200).send(await dashboard(resolveWindow(query.from, query.to)));
    },
  );

  // --- Sales ---------------------------------------------------------------

  /**
   * The sales report for a date range: totals (sales, tax, shipping,
   * discounts, refunds, net revenue), sales by day or month, top products,
   * top customers and sales by category.
   */
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

  /**
   * The orders report: how many orders, and of what value, are in each status
   * for a date range, and how long confirmed orders have been waiting to ship.
   */
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

  // --- Marketplace --------------------------------------------------------

  // GMV, supplier quality (returns, claims, failed inspections per seller), inspection and dispute figures for a date range.
  app.get(
    '/reports/marketplace',
    { preHandler: requireAdmin(Permission.REPORT_READ) },
    async (request, reply) => {
      const query = windowQuery
        .extend({ limit: z.coerce.number().int().min(1).max(200).default(50) })
        .parse(request.query);
      const window = resolveWindow(query.from, query.to);

      const [gmv, supplierQuality, inspection, disputes] = await Promise.all([
        gmvReport(window),
        supplierQualityReport(window, query.limit),
        inspectionSummary(window),
        disputeReport(window),
      ]);
      return reply.status(200).send({ gmv, supplierQuality, inspection, disputes });
    },
  );

  // Seller settlements and payouts for a date range, by status and currency, with failed payouts and holds.
  app.get(
    '/reports/settlements',
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (request, reply) => {
      const query = windowQuery.parse(request.query);
      return reply.status(200).send(await settlementReport(resolveWindow(query.from, query.to)));
    },
  );

  // --- Payments ------------------------------------------------------------

  /**
   * The payments report for a date range: payments by status, amounts
   * captured, failed and refunded, rejected payment notifications and
   * payments not yet reconciled.
   */
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

  /**
   * The inventory report: stock on hand valued at the current selling price
   * (optionally only low-stock items), and a summary of stock movements in a
   * date range.
   */
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

  /**
   * The customer report for a date range: how many customers there are by
   * status, and how many signed up, activated their account and ordered in
   * that range.
   */
  app.get(
    '/reports/customers',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const query = windowQuery.parse(request.query);
      return reply.status(200).send(await customerReport(resolveWindow(query.from, query.to)));
    },
  );

  /**
   * The recurring-orders report: schedules by status, the runs due in the
   * next few days (7 unless asked otherwise), failed runs, and schedules
   * paused after repeated failures that need somebody to look at them.
   */
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

  /**
   * The caller's own 50 most recent exports, with the status of each. Other
   * staff members' exports are never shown.
   */
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

  /**
   * Check on one export the caller requested. Once it is ready, and until the
   * link expires, it includes the download token.
   */
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

  /**
   * List the integrations set up with outside systems, each with its latest
   * sync. Credentials are never included.
   */
  app.get(
    '/integrations',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (_request, reply) => reply.status(200).send({ connectors: await listConnectors() }),
  );

  /**
   * Set up a connection to an outside system's product feed: its address,
   * how to sign in to it, and which of its fields map to SKU, name, price and
   * stock. It starts switched off. Writes an audit entry.
   *
   * The address must be HTTPS unless it is local. Credentials are stored
   * encrypted and are never returned.
   */
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

  /**
   * Switch an integration on or off. Switching on is refused until its last
   * connection test passed. Writes an audit entry.
   */
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

  /**
   * The result of one integration sync: whether it was a trial run, how many
   * records it handled and the errors it hit (up to 200).
   */
  app.get(
    '/integrations/sync-runs/:id',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      return reply.status(200).send(await getSyncRun(id));
    },
  );

  // --- Audit ---------------------------------------------------------------

  /**
   * Search the audit trail, newest first, a page at a time: who did what, in
   * which role, to which record, why (where the entry says), when, and from
   * which address and device. Filter by action, record, person or date range.
   * Secrets were already blanked out when each entry was written.
   */
  app.get(
    '/audit-logs',
    { preHandler: requireAdmin(Permission.AUDIT_READ) },
    async (request, reply) => {
      const query = auditFilterSchema
        .extend({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query);

      const { page, limit, ...filter } = query;
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send(await listAuditEntries(filter, page, limit));
    },
  );

  /**
   * Download the audit entries matching a filter as a CSV file, newest first,
   * at most 10,000 of them. Needs audit.read and export.create, and writes an
   * audit entry of its own before the file is produced.
   */
  app.post(
    '/audit-logs/export',
    {
      // Both, not either: the file holds nothing the caller could not already
      // read on the screen (audit.read), and taking a copy away is the act
      // export.create already gates for every other download of records.
      preHandler: requireAdmin(Permission.AUDIT_READ, Permission.EXPORT_CREATE),
      config: { rateLimit: { max: 10, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const filter = auditFilterSchema.parse(request.body ?? {});
      const auth = currentUser(request);
      const agent = request.headers['user-agent'];

      const file = await exportAuditEntries(filter, {
        userId: auth.id,
        email: auth.email,
        ipAddress: request.ip,
        userAgent: typeof agent === 'string' ? agent : null,
        correlationId: request.correlationId,
      });

      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        // `attachment` so the browser saves rather than renders it.
        .header('Content-Disposition', `attachment; filename="${file.fileName}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .header(AUDIT_EXPORT_ROWS_HEADER, String(file.rowCount))
        .header(AUDIT_EXPORT_TOTAL_HEADER, String(file.total))
        .status(200)
        .send(file.stream);
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
