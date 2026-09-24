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
  app.get(
    '/orders/:id/seller-documents',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
      return reply.send(await listAdminOrderDocuments(id));
    },
  );

  app.post(
    '/documents/:kind/:id/link',
    { preHandler: requireAdmin(Permission.INVOICE_READ) },
    async (request, reply) => {
      const { kind, id } = kindParam.parse(request.params);
      return reply.send(await adminDocumentLink(currentUser(request).id, kind, id));
    },
  );

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
