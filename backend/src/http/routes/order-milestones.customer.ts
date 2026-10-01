/**
 * The buyer's milestone timeline for one of their orders: production,
 * inspection, shipments, documents and payment. Read-only.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { readBuyerOrderMilestones } from '../../modules/orders/order-milestones.service.js';
import { orderScopeWhere, requireCustomer } from '../plugins/auth.js';

export function registerCustomerOrderMilestoneRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  // Production milestones and exceptions, inspection status, shipments, buyer-visible documents and payment status of one of the buyer's orders.
  app.get('/:id/milestones', async (request, reply) => {
    const { id } = z.object({ id: z.string().length(26) }).parse(request.params);
    const milestones = await readBuyerOrderMilestones(orderScopeWhere(request), id);
    return reply.header('cache-control', 'no-store').status(200).send(milestones);
  });

  return Promise.resolve();
}
