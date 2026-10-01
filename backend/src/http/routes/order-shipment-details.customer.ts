/**
 * The buyer's view of how their order ships (Master rows 42 and 56): each
 * consignment's booking - mode, Incoterm, ports, pickup and carrier - and the
 * trade documents the sellers have recorded that a buyer may see.
 *
 * Mounted under `/orders`. Ownership is the same `orderScopeWhere` filter as
 * the order itself, so another buyer's order is simply not found.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { buyerComplianceActions } from '../../modules/compliance/destination-compliance.service.js';
import { listBuyerShipmentDetails } from '../../modules/seller/shipment-booking.service.js';
import {
  buyerTradeDocumentFile,
  listBuyerTradeDocuments,
} from '../../modules/seller/trade-documents.service.js';
import { orderScopeWhere, requireCustomer } from '../plugins/auth.js';
import { sendDocumentFile } from './seller.shipment-paperwork.js';

const orderParam = z.object({ id: z.string().length(26) });

export function registerCustomerOrderShipmentDetailRoutes(app: FastifyInstance): Promise<void> {
  // The booking of every consignment on one of the buyer's orders, the trade documents the buyer may see, and what the destination rules ask the buyer to produce.
  app.get('/:id/shipment-details', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = orderParam.parse(request.params);
    const scope = orderScopeWhere(request);
    const [shipments, documents, buyerActions] = await Promise.all([
      listBuyerShipmentDetails(scope, id),
      listBuyerTradeDocuments(scope, id),
      buyerComplianceActions(scope, id),
    ]);
    return reply.header('cache-control', 'no-store').send({ shipments, documents, buyerActions });
  });

  // Download the current version of a buyer-visible trade document on one of the buyer's orders.
  app.get('/:id/trade-documents/:versionId/file', { preHandler: requireCustomer }, async (request, reply) => {
    const params = z
      .object({ id: z.string().length(26), versionId: z.string().length(26) })
      .parse(request.params);
    const file = await buyerTradeDocumentFile(orderScopeWhere(request), params.id, params.versionId);
    return sendDocumentFile(reply, file);
  });

  return Promise.resolve();
}
