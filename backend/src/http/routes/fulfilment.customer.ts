/**
 * "Where will this come from, when will it arrive, and what does it cost?"
 *
 * Signed in, unlike `/delivery/options`, and the difference is not an
 * oversight. That endpoint answers a browsing question - can you reach
 * Belgium, roughly when - from a country code, and it has to work before
 * anybody has an account. This one answers a buying question about a
 * particular person's basket going to a particular address of theirs, so it
 * needs the session for both: the cart it prices is the one on the session,
 * and the address is checked against the session's own profile rather than
 * taken on trust from an id in a body.
 *
 * **Every answer writes rows.** Each option comes back with a quote id that
 * checkout will accept, and that id names a stored offer - see
 * `FulfilmentQuote`. That makes this a POST that has effects, which is the
 * honest shape for it: the alternative is recomputing the price at payment
 * from ids the browser hands back, and two runs against a moving stock ledger
 * produce two answers.
 *
 * Rate-limited for the same reason: it is not a free read.
 *
 * **No cache header, ever.** Availability is the fastest-moving input in this
 * system and a proxy holding "Antwerp, Thursday, in stock" for sixty seconds
 * is sixty seconds of promising a unit that has gone.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  checkQuote,
  currentBasketDigest,
  quoteWarehouseOptions,
} from '../../modules/fulfilment/warehouse-options.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

/**
 * The basket, as the storefront believes it to be.
 *
 * Optional, and checked rather than used: the server prices its own cart. It
 * is sent so a browser showing a stale basket is told so - answering for the
 * cart it *thinks* it has would put a total on screen for something nobody
 * owns.
 *
 * Capped at 100 lines, which is the shape of the question rather than a limit
 * on a cart.
 */
const itemSchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
  quantity: z.number().int().min(1).max(1_000_000),
});

const optionsSchema = z
  .object({
    /** The address this is going to. The real case, and the only bindable one. */
    deliveryAddressId: z.string().length(26).nullable().optional(),
    /**
     * Where the buyer is, when that is all they have said yet.
     *
     * Ignored when an address is given. On its own it produces an estimate,
     * which the storefront labels and checkout refuses.
     */
    countryCode: z.string().trim().length(2).toUpperCase().nullable().optional(),
    items: z.array(itemSchema).max(100).optional(),
    currency: z.string().trim().length(3).toUpperCase().nullable().optional(),
    /** `YYYY-MM-DD`. "Can you make the 24th?" */
    requestedDeliveryDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.')
      .nullable()
      .optional(),
  })
  .refine(
    (body) =>
      (body.deliveryAddressId ?? null) !== null || (body.countryCode ?? null) !== null,
    {
      message: 'Give a delivery address, or a country to estimate against.',
      path: ['deliveryAddressId'],
    },
  );

const quoteParam = z.object({ quoteId: z.string().length(26) });

export function registerCustomerFulfilmentRoutes(app: FastifyInstance): Promise<void> {
  /** Nothing here is public. The cart and the address both belong to a session. */
  app.addHook('preHandler', requireCustomer);

  /**
   * Which warehouses can fulfil this basket, and on what terms.
   *
   * 200 with an empty `options` when none can, which is a real answer the
   * storefront has a screen for - and `ineligible` beside it says why each
   * warehouse the buyer might have expected is missing. An error there would
   * make "nobody serves your postcode" indistinguishable from a request this
   * endpoint could not understand, and the buyer would be shown a fault
   * instead of a fact.
   */
  app.post(
    '/warehouse-options',
    { config: { rateLimit: { max: 60, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = optionsSchema.parse(request.body);

      const result = await quoteWarehouseOptions({
        customerProfileId: auth.customerProfileId ?? '',
        ...(body.deliveryAddressId === undefined
          ? {}
          : { deliveryAddressId: body.deliveryAddressId }),
        ...(body.countryCode === undefined ? {} : { countryCode: body.countryCode }),
        ...(body.items === undefined ? {} : { items: body.items }),
        ...(body.currency === undefined ? {} : { currency: body.currency }),
        ...(body.requestedDeliveryDate === undefined
          ? {}
          : { requestedDeliveryDate: body.requestedDeliveryDate }),
      });

      return reply.header('cache-control', 'no-store').status(200).send(result);
    },
  );

  /**
   * Is the option I chose still an offer?
   *
   * Asked by the checkout page before it enables Pay, so a page left open
   * over lunch finds out where the customer can do something about it rather
   * than at the moment money would move.
   *
   * Answers 200 with `ok: false` and a code rather than throwing. A screen
   * that has to catch an exception in order to render "this expired" is a
   * screen that renders a stack trace one day - and the storefront's job here
   * is to re-ask for options, which is a normal flow and not an error.
   */
  app.post(
    '/warehouse-options/:quoteId/revalidate',
    { config: { rateLimit: { max: 120, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const { quoteId } = quoteParam.parse(request.params);
      const body = z
        .object({ deliveryAddressId: z.string().length(26) })
        .parse(request.body);

      const customerProfileId = auth.customerProfileId ?? '';
      const { cartId, basketHash } = await currentBasketDigest(customerProfileId);

      const check = await checkQuote({
        quoteId,
        customerProfileId,
        cartId,
        addressId: body.deliveryAddressId,
        basketHash,
      });

      return reply.header('cache-control', 'no-store').status(200).send(check);
    },
  );

  return Promise.resolve();
}
