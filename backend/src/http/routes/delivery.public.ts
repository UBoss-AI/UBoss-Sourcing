/**
 * Where we deliver, as the storefront asks it.
 *
 * Unauthenticated, deliberately. "Can you deliver to Belgium, and when?" is a
 * question a buyer asks before they have an account, and answering it only
 * after sign-in loses the sale to whoever answered it on the product page. It
 * discloses a dispatch town, a lead time and a delivery fee - which is exactly
 * what every carrier's own tracking page shows, and exactly what a buyer has
 * to know before agreeing to a price.
 *
 * **A POST for something that changes nothing, and that is a considered
 * choice.** The basket is the input: up to a hundred product ids with
 * quantities, which does not fit in a query string a proxy will keep, and
 * which would sit in this server's access log and in every log in front of it
 * if it did. There is no caching to lose - the answer depends on live stock,
 * and a cached "yes, two days" is the one answer that must never be stale.
 *
 * The rules the answer obeys - stock as well as reach, exclusions withheld,
 * nothing invented - live in `delivery-options.service.ts`, which is where
 * they are explained.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { deliveryOptions } from '../../modules/inventory/delivery-options.service.js';

/**
 * The basket, as the storefront sends it.
 *
 * Capped at 100 lines because that is the shape of the question rather than a
 * limit on a cart: past a hundred lines this is not a buyer choosing a
 * delivery option, and the availability join would be doing a hundred lookups
 * per candidate warehouse to answer something nobody is reading.
 *
 * `items` is optional and an empty basket is a real question - "who could ever
 * deliver here", which is what a product page and a country picker ask before
 * anything is in a cart.
 */
const bodySchema = z.object({
  countryCode: z.string().trim().length(2).toUpperCase(),
  items: z
    .array(
      z.object({
        productId: z.string().length(26),
        variantId: z.string().length(26).nullable().optional(),
        quantity: z.number().int().min(1).max(1_000_000),
      }),
    )
    .max(100)
    .optional(),
});

export function registerPublicDeliveryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Which warehouses can deliver this basket to this country.
   *
   * 200 with an empty `options` when nobody can, which is a real answer the
   * storefront has a screen for. An error there would make "we do not ship to
   * Iceland yet" indistinguishable from a request this endpoint could not
   * understand, and the buyer would be shown a fault instead of a fact.
   */
  app.post('/options', async (request, reply) => {
    const body = bodySchema.parse(request.body);

    const result = await deliveryOptions({
      countryCode: body.countryCode,
      ...(body.items === undefined ? {} : { items: body.items }),
    });

    // No cache header at all. Availability is the input that changes fastest
    // in this system, and a proxy holding "Antwerp, two days, in stock" for
    // sixty seconds is sixty seconds of promising a unit that has gone.
    return reply.header('cache-control', 'no-store').status(200).send(result);
  });

  return Promise.resolve();
}
