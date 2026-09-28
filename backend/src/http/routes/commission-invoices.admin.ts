/**
 * Finance → Commission Invoices: the operator's invoices to sellers for the
 * platform commission, their credit notes and their settings.
 *
 * Every route is gated by its own `commission_invoice.*` permission, checked
 * here on the server; the Admin Panel hiding a button is a courtesy. Nothing
 * a client sends is trusted as a figure: a generate names a seller order, an
 * issue names a draft, a credit names a basis - every amount is the server's.
 * Creating a draft and issuing a credit note need an Idempotency-Key header,
 * so a double click or a retried request makes one document.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ErrorCode, badRequest } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import {
  commissionForOrder,
  createCreditNote,
  downloadLink,
  generateDraft,
  issueInvoice,
  listCandidates,
  listInvoices,
  previewPdf,
  readInvoice,
  recordCollection,
  redeemDownload,
  regenerateDraft,
  voidInvoice,
  type FinanceActor,
} from '../../modules/commission-invoicing/commission-invoice.service.js';
import { loadSettings, saveSettings, serialiseSettings } from '../../modules/commission-invoicing/commission-settings.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

function actorOf(request: FastifyRequest): FinanceActor {
  const user = currentUser(request);
  return { userId: user.id, email: user.email, ipAddress: request.ip, correlationId: request.correlationId };
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (typeof value !== 'string' || value.trim().length < 8) {
    throw badRequest(ErrorCode.IDEMPOTENCY_KEY_REQUIRED, 'Send an Idempotency-Key header with this request.', [
      { field: 'Idempotency-Key', code: 'REQUIRED' },
    ]);
  }
  return value.trim();
}

export function registerCommissionInvoiceAdminRoutes(app: FastifyInstance): Promise<void> {
  // List commission invoices, filtered and paginated on the server.
  app.get('/commission-invoices', { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_VIEW) }, async (request, reply) => {
    return reply.send(await listInvoices(request.query));
  });

  // List seller orders with a commission and no live commission invoice, each with why it cannot be invoiced yet.
  app.get('/commission-invoices/candidates', { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_VIEW) }, async (request, reply) => {
    return reply.send(await listCandidates(request.query));
  });

  // Read who commission invoices are issued by and how they are numbered.
  app.get('/commission-invoices/settings', { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_VIEW) }, async (_request, reply) => {
    return reply.send(serialiseSettings(await loadSettings()));
  });

  // Save the issuing legal entity's details and the numbering; refused on a stale version.
  app.put(
    '/commission-invoices/settings',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_SETTINGS_WRITE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      return reply.send(await saveSettings(actorOf(request), request.body));
    },
  );

  // Show the commission and the commission invoice of every seller order on one buyer order.
  app.get('/orders/:id/commission-invoices', { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_VIEW) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await commissionForOrder(id));
  });

  // Create the draft commission invoice for one seller order, or return the live one. Needs an Idempotency-Key.
  app.post(
    '/seller-orders/:id/commission-invoice',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_GENERATE), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = await generateDraft(actorOf(request), id, idempotencyKey(request));
      return reply.status(result.created ? 201 : 200).send(result);
    },
  );

  // Read one commission invoice with its lines, sources, credit notes and history.
  app.get('/commission-invoices/:id', { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_VIEW) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    return reply.send(await readInvoice(id));
  });

  // Rebuild a draft from its sources.
  app.post(
    '/commission-invoices/:id/regenerate',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_GENERATE), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await regenerateDraft(actorOf(request), id));
    },
  );

  // Render the draft as a watermarked A6 PDF, with no number, barcode or QR.
  app.get(
    '/commission-invoices/:id/preview.pdf',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_PREVIEW), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const file = await previewPdf(actorOf(request), id);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `inline; filename="${file.fileName}"`)
        .header('cache-control', 'no-store')
        .send(file.bytes);
    },
  );

  // Issue a draft: reserve its number, render and store the PDF, freeze it. Issuing an issued invoice returns it.
  app.post(
    '/commission-invoices/:id/issue',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_ISSUE), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { snapshotHash } = z.object({ snapshotHash: z.string().regex(/^[0-9a-f]{64}$/).optional() }).strict().parse(request.body ?? {});
      return reply.send(await issueInvoice(actorOf(request), id, snapshotHash ?? null));
    },
  );

  // Discard a draft, which holds no number, so a new one can be started.
  app.post(
    '/commission-invoices/:id/discard',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_GENERATE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await voidInvoice(actorOf(request), id, request.body, 'DRAFT'));
    },
  );

  // Void an issued invoice, only where the settings permit it; its number stays used.
  app.post(
    '/commission-invoices/:id/void',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_ISSUE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await voidInvoice(actorOf(request), id, request.body, 'ISSUED'));
    },
  );

  // Record that the seller paid an issued invoice, with the payment's reference.
  app.post(
    '/commission-invoices/:id/collection',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_ISSUE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await recordCollection(actorOf(request), id, request.body));
    },
  );

  // Issue a credit note against an issued commission invoice. Needs an Idempotency-Key.
  app.post(
    '/commission-invoices/:id/credit-notes',
    { preHandler: requireAdmin(Permission.COMMISSION_CREDIT_NOTE_CREATE), config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = await createCreditNote(actorOf(request), id, request.body, idempotencyKey(request));
      return reply.status(result.created ? 201 : 200).send(result);
    },
  );

  // Get a five-minute, single-use download link for an issued invoice or credit note PDF.
  app.post(
    '/commission-invoices/documents/:id/link',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_DOWNLOAD), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await downloadLink(actorOf(request), id));
    },
  );

  // Download an issued invoice or credit note PDF with a link from the request above; checked against its stored hash.
  app.get(
    '/commission-invoices/documents/:id/download',
    { preHandler: requireAdmin(Permission.COMMISSION_INVOICE_DOWNLOAD), config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.query);
      const file = await redeemDownload(actorOf(request), id, token);
      return reply
        .header('content-type', 'application/pdf')
        .header('content-disposition', `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
        .header('x-content-sha256', file.contentHash)
        .header('cache-control', 'no-store')
        .send(file.bytes);
    },
  );

  return Promise.resolve();
}
