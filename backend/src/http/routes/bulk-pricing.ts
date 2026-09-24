/**
 * `GET /catalog/bulk-pricing` - what one piece costs at a quantity, in each way
 * of buying it. Public: a guest sees list bands; a signed-in business buyer
 * also sees bands kept for business accounts and for their delivery country.
 * Read only, and priced by the same function as the basket.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { bulkPricing } from '../../modules/catalog/bulk-pricing.service.js';
import { optionalCustomer } from '../plugins/auth.js';

export function registerBulkPricingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Show what one piece of a product costs at a given quantity, for each way of
   * buying it, so the shopper can see the price drop as the quantity goes up.
   * Anyone can ask; a signed-in business buyer also sees prices kept for
   * business accounts and for their delivery country.
   */
  app.get(
    '/bulk-pricing',
    { preHandler: optionalCustomer, config: { rateLimit: { max: 240, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = z
        .object({
          productId: z.string().length(26),
          variantId: z.string().length(26).optional(),
          offerId: z.string().length(26).optional(),
          quantity: z.coerce.number().int().min(1).max(100_000_000),
          displayCurrency: z
            .string()
            .regex(/^[A-Za-z]{3}$/)
            .optional(),
        })
        .parse(request.query);
      // Personalised by who is asking, so never shared between viewers.
      reply.header('cache-control', 'private, no-store');
      return reply.send(
        await bulkPricing({
          productId: query.productId,
          variantId: query.variantId ?? null,
          offerId: query.offerId ?? null,
          quantity: query.quantity,
          displayCurrency: query.displayCurrency?.toUpperCase() ?? null,
          customerProfileId: request.auth?.customerProfileId ?? null,
        }),
      );
    },
  );
  return Promise.resolve();
}
