/**
 * Where the buyer's parcels are: the carrier timeline, the ETA and the proof
 * of delivery, per consignment on one of their own orders.
 *
 * Its own route file rather than more of `orders.ts`, because the proof of
 * delivery brings a download with it and the order detail is read on every
 * visit to the page. Mounted under the same `/orders` prefix and behind the
 * same guard, and ownership is the same `orderScopeWhere` filter: another
 * buyer's order - or this buyer's order from their other buying context - is
 * simply not found.
 *
 * What may be shown is decided in `modules/logistics/buyer-tracking.service.ts`
 * and only there.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createBuyerPodLink,
  readBuyerTracking,
  redeemBuyerPodLink,
} from '../../modules/logistics/buyer-tracking.service.js';
import { currentUser, orderScopeWhere, requireCustomer } from '../plugins/auth.js';

const orderParam = z.object({ id: z.string().length(26) });
const podParam = z.object({
  id: z.string().length(26),
  shipmentId: z.string().length(26),
  kind: z.enum(['signature', 'photo']),
});

export function registerCustomerOrderTrackingRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  // Every consignment on one of the buyer's orders: its timeline in the buyer's words, anything wrong with it, its ETA and its proof of delivery.
  app.get('/:id/tracking', async (request, reply) => {
    const { id } = orderParam.parse(request.params);
    const tracking = await readBuyerTracking(orderScopeWhere(request), id);
    return reply.header('cache-control', 'no-store').status(200).send(tracking);
  });

  // A single-use link, valid for a few minutes, to the signature or photograph captured as proof of delivery of one of the buyer's consignments.
  app.post(
    '/:id/shipments/:shipmentId/proof-of-delivery/:kind/link',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const params = podParam.parse(request.params);
      const link = await createBuyerPodLink({
        scope: orderScopeWhere(request),
        userId: currentUser(request).id,
        orderId: params.id,
        shipmentId: params.shipmentId,
        kind: params.kind,
      });
      return reply.header('cache-control', 'no-store').status(200).send(link);
    },
  );

  // Redeem a proof-of-delivery link: works once, only for the person it was made for, and is recorded in the audit log.
  app.get('/:id/shipments/:shipmentId/proof-of-delivery/:kind/download', async (request, reply) => {
    const params = podParam.parse(request.params);
    const { token } = z.object({ token: z.string().min(20).max(200) }).parse(request.query);

    const file = await redeemBuyerPodLink({
      scope: orderScopeWhere(request),
      userId: currentUser(request).id,
      orderId: params.id,
      shipmentId: params.shipmentId,
      kind: params.kind,
      token,
      correlationId: request.correlationId,
    });

    /*
     * An attachment with `nosniff`, never inline - the same as every other
     * private file here. Only raster images are ever stored for a POD (the
     * upload sniffs the bytes and refuses SVG), but a file from the private
     * prefix never becomes part of a page on this origin.
     */
    return reply
      .header('content-type', file.contentType)
      .header(
        'content-disposition',
        `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
      )
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .status(200)
      .send(file.body);
  });

  return Promise.resolve();
}
