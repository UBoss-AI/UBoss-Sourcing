/**
 * Seller documents on the customer surface (buyers and sellers share it: a
 * seller is a customer account), and the public document check.
 *
 * A download needs BOTH the single-use token from a `…/link` call and the
 * session of the person it was minted for.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { findSellerMembership } from '../../modules/seller/account.service.js';
import {
  buyerDocumentLink,
  listBuyerOrderDocuments,
  parseBatchDocuments,
  redeemCustomerDocument,
  redeemSellerBatch,
  verifyDocument,
} from '../../modules/documents/documents.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

const kindParam = z.object({
  kind: z.enum(['invoice', 'packing-list']),
  id: z.string().length(26),
});

export function registerDocumentRoutes(app: FastifyInstance): Promise<void> {
  /** Is this a document this deployment issued? Public; says only what is printed on it. */
  app.get(
    '/verify',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = z
        .object({
          kind: z.enum(['invoice', 'packing-list']),
          number: z.string().trim().min(3).max(24),
          code: z.string().trim().length(16),
        })
        .parse(request.query);
      reply.header('cache-control', 'no-store');
      return reply.send(await verifyDocument(query.kind, query.number, query.code));
    },
  );

  /** The buyer's view of an order's seller documents. */
  app.get('/orders/:orderId', { preHandler: requireCustomer }, async (request, reply) => {
    const { orderId } = z.object({ orderId: z.string().length(26) }).parse(request.params);
    const auth = currentUser(request);
    return reply.send(await listBuyerOrderDocuments(auth.customerProfileId ?? '', orderId));
  });

  /**
   * Get a short-lived, single-use download link for one of the buyer's own
   * invoices or credit notes. A packing list is never offered to a buyer.
   */
  app.post(
    '/buyer/:kind/:id/link',
    { preHandler: requireCustomer, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { kind, id } = kindParam.parse(request.params);
      const auth = currentUser(request);
      return reply.send(await buyerDocumentLink(auth.customerProfileId ?? '', auth.id, kind, id));
    },
  );

  /**
   * Download several of a seller's own issued documents as one ZIP file, using
   * a link from the seller's batch-link request. Works once, only for the person
   * the link was made for, and records each document download in the audit log.
   */
  app.get('/batch/:id/download', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(10).max(40) }).parse(request.params);
    const { token, docs } = z
      .object({ token: z.string().min(20).max(200), docs: z.string().max(4000) })
      .parse(request.query);
    const auth = currentUser(request);
    const membership = await findSellerMembership(auth.customerProfileId ?? '');
    const file = await redeemSellerBatch({
      userId: auth.id,
      sellerAccountId: membership?.sellerAccountId ?? '',
      batchId: id,
      documents: parseBatchDocuments(docs),
      token,
      correlationId: request.correlationId,
    });
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename="${file.fileName}"`)
      .header('cache-control', 'no-store')
      .send(file.bytes);
  });

  /**
   * Download one invoice or packing list as a PDF, for the seller who issued it
   * or the buyer it was issued to. The link works once, only for the person it
   * was made for, and the download is recorded in the audit log.
   */
  app.get('/:kind/:id/download', { preHandler: requireCustomer }, async (request, reply) => {
    const { kind, id } = kindParam.parse(request.params);
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.query);
    const auth = currentUser(request);
    const membership = await findSellerMembership(auth.customerProfileId ?? '');
    const file = await redeemCustomerDocument({
      userId: auth.id,
      customerProfileId: auth.customerProfileId ?? '',
      sellerAccountId: membership?.sellerAccountId ?? null,
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
  });

  return Promise.resolve();
}
