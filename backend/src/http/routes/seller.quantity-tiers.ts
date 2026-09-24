/**
 * A seller's quantity price bands on one listing. Under `/seller`; another
 * seller's listing answers 404.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  readQuantityTiers,
  saveQuantityTiers,
  tiersInputSchema,
} from '../../modules/seller/quantity-tier.service.js';
import { currentSeller, requireSeller } from '../plugins/seller.js';

const idParam = z.object({ id: z.string().length(26) });

export function registerSellerQuantityTierRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/offers/:id/quantity-tiers',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(await readQuantityTiers(currentSeller(request), id));
    },
  );

  app.put(
    '/offers/:id/quantity-tiers',
    {
      preHandler: requireSeller(SellerPermission.LISTING_WRITE),
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.send(
        await saveQuantityTiers(currentSeller(request), id, tiersInputSchema.parse(request.body)),
      );
    },
  );

  return Promise.resolve();
}
