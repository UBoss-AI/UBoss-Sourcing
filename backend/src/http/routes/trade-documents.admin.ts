/**
 * Sellers' trade documents, for the marketplace's reviewers (Master row 42):
 * read every version of every document on an order, open its file, and mark
 * the current version valid or rejected. Under `/admin`.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Permission } from '../../domain/permissions.js';
import {
  adminTradeDocumentFile,
  listAdminTradeDocuments,
  validateTradeDocumentVersion,
} from '../../modules/seller/trade-documents.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';
import { sendDocumentFile } from './seller.shipment-paperwork.js';

const idParam = z.object({ id: z.string().length(26) });

export function registerAdminTradeDocumentRoutes(app: FastifyInstance): Promise<void> {
  // Every trade document on one order, every seller and every version, with its validation state.
  app.get(
    '/orders/:id/trade-documents',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.header('cache-control', 'no-store').send({ documents: await listAdminTradeDocuments(id) });
    },
  );

  // Open the file of one version of a seller's trade document.
  app.get(
    '/trade-documents/versions/:id/file',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return sendDocumentFile(reply, await adminTradeDocumentFile(id));
    },
  );

  // Mark the current version of a trade document valid, or reject it with a reason.
  app.post(
    '/trade-documents/versions/:id/validation',
    {
      preHandler: requireAdmin(Permission.LOGISTICS_WRITE),
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ decision: z.enum(['VALID', 'REJECTED']), note: z.string().trim().max(1000).nullable().optional() })
        .strict()
        .parse(request.body);
      const user = currentUser(request);
      const version = await validateTradeDocumentVersion({
        versionId: id,
        decision: body.decision,
        note: body.note ?? null,
        staffUserId: user.id,
        staffLabel: user.email,
      });
      return reply.send({ version });
    },
  );

  return Promise.resolve();
}
