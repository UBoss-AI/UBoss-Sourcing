/**
 * Seller documents, for the operator: read and download only, under
 * `invoice.read`. A seller's invoice is the seller's legal document, and
 * nothing here can edit, void or re-issue one.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Permission } from '../../domain/permissions.js';
import {
  adminDocumentLink,
  listAdminOrderDocuments,
  redeemAdminDocument,
} from '../../modules/documents/documents.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const kindParam = z.object({
  kind: z.enum(['invoice', 'packing-list']),
  id: z.string().length(26),
});

export function registerAdminDocumentRoutes(app: FastifyInstance): Promise<void> {
  /**
   * List the invoices, credit notes and packing lists sellers have issued for
   * one order. Drafts are left out.
   */
  app.get(
    '/orders/:id/seller-documents',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      return reply.send(await listAdminOrderDocuments(id));
    },
  );

  /** Get a short-lived, single-use download link for a seller's invoice or packing list. */
  app.post(
    '/documents/:kind/:id/link',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { kind, id } = kindParam.parse(request.params);
      return reply.send(await adminDocumentLink(currentUser(request).id, kind, id));
    },
  );

  /**
   * Download a seller's invoice or packing list as a PDF, using a link from the
   * request above. The link works once, only for the admin it was made for, and
   * the download is recorded in the audit log.
   */
  app.get(
    '/documents/:kind/:id/download',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { kind, id } = kindParam.parse(request.params);
      const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.query);
      const file = await redeemAdminDocument({
        userId: currentUser(request).id,
        kind,
        id,
        token,
        correlationId: request.correlationId,
      });
      return reply
        .header('content-type', 'application/pdf')
        .header(
          'content-disposition',
          `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
        )
        .header('cache-control', 'no-store')
        .send(file.bytes);
    },
  );

  return Promise.resolve();
}
