/**
 * Seller Hub: bulk update of the seller's own listings from a spreadsheet, and
 * production milestones on the seller's own orders.
 *
 * Everything here is resolved from the session's seller membership. No seller
 * id appears in any path, and every service checks ownership again.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { PRODUCTION_DELAY_REASONS, PRODUCTION_STAGES } from '../../domain/production-milestones.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  MAX_SELLER_IMPORT_BYTES,
  applySellerImport,
  createSellerImportDryRun,
  listSellerImports,
  readSellerImport,
  sellerImportTemplate,
} from '../../modules/seller/bulk-import.service.js';
import {
  completeMilestone,
  planMilestone,
  raiseDelay,
  readProduction,
  resolveDelay,
} from '../../modules/seller/production.service.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });
const IMPORT_RATE_LIMIT = { max: 20, timeWindow: '15 minutes' } as const;

export function registerSellerWorkbenchRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireSeller());

  // The blank CSV template for a bulk listing update: the column headers only.
  app.get(
    '/bulk-imports/template',
    { preHandler: requireSeller(SellerPermission.BULK_IMPORT) },
    async (_request, reply) =>
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="listing-update-template.csv"')
        .status(200)
        .send(sellerImportTemplate()),
  );

  // The seller's recent bulk updates, newest first, previews and applied runs alike.
  app.get(
    '/bulk-imports',
    { preHandler: requireSeller(SellerPermission.BULK_IMPORT) },
    async (request, reply) => {
      const jobs = await listSellerImports(currentSeller(request));
      return reply.header('cache-control', 'no-store').status(200).send({ jobs });
    },
  );

  // Upload a CSV or XLSX and check it against the seller's own listings. Changes nothing; returns the problems and the changes it would make.
  app.post(
    '/bulk-imports',
    { preHandler: requireTradingSeller(SellerPermission.BULK_IMPORT), config: { rateLimit: IMPORT_RATE_LIMIT } },
    async (request, reply) => {
      const file = await request.file({ limits: { fileSize: MAX_SELLER_IMPORT_BYTES } });
      if (file === undefined) {
        throw badRequest(ErrorCode.BULK_IMPORT_FILE_INVALID, 'No file was uploaded.', [
          { field: 'file', code: 'REQUIRED' },
        ]);
      }
      const content = await file.toBuffer();
      const membership = currentSeller(request);
      const jobId = await createSellerImportDryRun(
        membership,
        { fileName: file.filename, content },
        request.correlationId,
      );
      return reply.status(200).send(await readSellerImport(membership, jobId));
    },
  );

  // One bulk update: its counts, row problems and, for an unapplied preview, the changes it would make.
  app.get(
    '/bulk-imports/:id',
    { preHandler: requireSeller(SellerPermission.BULK_IMPORT) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send(await readSellerImport(currentSeller(request), id));
    },
  );

  // Apply a checked preview. The file is re-checked first; any problem and nothing changes. A preview applies once.
  app.post(
    '/bulk-imports/:id/apply',
    { preHandler: requireTradingSeller(SellerPermission.BULK_IMPORT), config: { rateLimit: IMPORT_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const membership = currentSeller(request);
      const jobId = await applySellerImport(membership, id, request.correlationId);
      return reply.status(200).send(await readSellerImport(membership, jobId));
    },
  );

  // --- Production ---------------------------------------------------------

  const stage = z.enum(PRODUCTION_STAGES);
  const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

  // Production milestones and exceptions on one of the seller's orders, with the next stage that can be recorded.
  app.get(
    '/orders/:id/production',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply
        .header('cache-control', 'no-store')
        .status(200)
        .send(await readProduction(currentSeller(request), id));
    },
  );

  // Record that a production stage is done. Stages go in order and none can be skipped. Never changes the order's status.
  app.post(
    '/orders/:id/production/milestones',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          stage,
          internalNote: z.string().trim().max(2000).nullish(),
          buyerNote: z.string().trim().max(1000).nullish(),
        })
        .parse(request.body);
      await completeMilestone({ membership: currentSeller(request), groupId: id, ...body, correlationId: request.correlationId });
      return reply.status(204).send();
    },
  );

  // Set the date a production stage is expected. The buyer is told the date.
  app.post(
    '/orders/:id/production/plan',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ stage, plannedFor: date }).parse(request.body);
      await planMilestone({ membership: currentSeller(request), groupId: id, ...body, correlationId: request.correlationId });
      return reply.status(204).send();
    },
  );

  // Raise a production exception with a reason and a revised date. The buyer sees the reason, the date and the seller's message, never the internal detail.
  app.post(
    '/orders/:id/production/delays',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          stage,
          reason: z.enum(PRODUCTION_DELAY_REASONS),
          revisedDate: date,
          detail: z.string().trim().max(2000).nullish(),
          buyerMessage: z.string().trim().max(1000).nullish(),
        })
        .parse(request.body);
      const result = await raiseDelay({ membership: currentSeller(request), groupId: id, ...body, correlationId: request.correlationId });
      return reply.status(201).send(result);
    },
  );

  // Resolve an open production exception. The note is shown to the buyer.
  app.post(
    '/orders/:id/production/delays/:delayId/resolve',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL) },
    async (request, reply) => {
      const params = z.object({ id: z.string().length(26), delayId: z.string().length(26) }).parse(request.params);
      const body = z.object({ resolutionNote: z.string().trim().max(1000).nullish() }).parse(request.body ?? {});
      await resolveDelay({
        membership: currentSeller(request),
        groupId: params.id,
        delayId: params.delayId,
        resolutionNote: body.resolutionNote ?? null,
        correlationId: request.correlationId,
      });
      return reply.status(204).send();
    },
  );

  return Promise.resolve();
}
