/**
 * Cart and checkout.
 *
 * Every response is a full repriced cart, not a delta. A mutation that returned
 * only "ok" would leave the browser guessing at totals, and a client that
 * computes its own totals is a client that can disagree with the server about
 * what an order costs.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import { PaymentInstrumentValues } from '../../domain/payment-instrument.js';
import {
  addItem,
  addItems,
  applyCoupon,
  clearCart,
  removeCoupon,
  removeItem,
  resolveCart,
  toCartView,
  updateItemPackQuantity,
  updateItemQuantity,
} from '../../modules/cart/cart.service.js';
import {
  IdempotencyScope,
  runIdempotent,
} from '../../modules/orders/idempotency.service.js';
import { submitCheckout } from '../../modules/orders/order.service.js';
import { prisma } from '../../infra/prisma.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

const addItemSchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
  /**
   * Whose offer to buy, where several businesses sell the same product.
   *
   * Absent means the operator's own stock, which is what every caller that
   * existed before the marketplace did means. The service re-checks it against
   * the product on the same line and against the offer still being on sale —
   * this only says the shape is right.
   */
  sellerOfferId: z.string().length(26).nullable().optional(),
  /**
   * Pieces. Required, and still the whole request for every caller that does
   * not count in cartons - an ERP, an API client, a reorder of a line placed
   * before this shop settled on the carton.
   *
   * A piece count is rounded UP to whole cartons, because a part carton is not
   * something this shop can ship. 600 pieces is two cartons of 500.
   */
  quantity: z.number().int().min(1).max(1_000_000),
  /**
   * Ordering by the carton, which is the only way anything is sold.
   *
   * Only the unit and how many of them: the carton size is the deployment's
   * own setting, never taken from the request. A client that could post its
   * own "pieces per carton" could post 1 and buy a carton at the price of a
   * syringe. When these are present, `quantity` above is ignored in favour of
   * the figure the server works out.
   *
   * `PIECE` and `INNER_PACK` are gone from the enum on purpose. They are still
   * in the database for rows written before the change, and they are refused
   * here rather than quietly reinterpreted - a client asking for 3 pieces
   * should be told the shop does not sell them, not handed three cartons.
   */
  orderingUnit: z.enum(['OUTER_CARTON']).optional(),
  unitQuantity: z.number().int().min(1).max(1_000_000).optional(),
});

/**
 * Several options at once.
 *
 * The cap is enforced twice on purpose: Zod refuses an oversized array before
 * anything is queried, and the service refuses it again for callers that do
 * not come through this route.
 */
const addItemsSchema = z.object({
  items: z.array(addItemSchema).min(1).max(50),
});

const updateQuantitySchema = z.object({
  // Zero removes the line, which is what a quantity stepper sends at 0.
  // Anything else is pieces, rounded up to whole cartons by the service.
  quantity: z.number().int().min(0).max(1_000_000),
});

/**
 * The same line, counted in cartons. What the storefront's stepper sends.
 *
 * A separate route rather than a second field on the one above, because the two
 * are authoritative about different things: that one states pieces and derives
 * cartons, this one states cartons and derives pieces. One endpoint taking both
 * would have to decide which to believe when a client sends a pair that does
 * not multiply out, and whichever it chose would surprise one of the two
 * screens that calls it.
 */
const updatePackQuantitySchema = z.object({
  unitQuantity: z.number().int().min(0).max(1_000_000),
});

const checkoutSchema = z.object({
  shippingAddressId: z.string().length(26),
  billingAddressId: z.string().length(26).optional(),
  shippingMethodCode: z.string().max(32).nullable().optional(),
  paymentMode: z.enum(['ONLINE', 'PAYMENT_LINK']).default('ONLINE'),
  // The gateway pick, where the storefront offered one. Optional: a client
  // that sends nothing gets the configured default at payment time, which is
  // what every caller written before this did.
  preferredPaymentProvider: z.enum(['RAZORPAY', 'STRIPE']).optional(),
  preferredPaymentMethod: z.enum(['ANY', 'UPI']).optional(),
  // What the customer actually chose, in the words the storefront showed them.
  // The gateway is derived from this at payment time; the two fields above are
  // what an API client naming a gateway directly still uses.
  preferredPaymentInstrument: z.enum(PaymentInstrumentValues).optional(),
  // A card of theirs, picked at checkout. Re-checked against the customer when
  // the payment starts - this is a preference, never an authorisation.
  preferredPaymentMethodId: z.string().length(26).optional(),
  /**
   * The warehouse option the customer chose, by quote id.
   *
   * Optional. A destination no warehouse publishes a lane to offers nothing
   * to choose, and checkout there behaves exactly as it did before fulfilment
   * options existed - so this is additive rather than a new requirement an
   * existing installation has to satisfy.
   *
   * Unlike the payment fields above it is NOT a preference. It is an offer
   * being accepted, and `assertQuoteUsable` re-checks the warehouse, the
   * lane, the basket and the stock behind it before anything is written.
   */
  fulfilmentQuoteId: z.string().length(26).optional(),
  customerNote: z.string().max(2000).nullable().optional(),
});

const itemParam = z.object({ itemId: z.string().length(26) });

const couponSchema = z.object({
  code: z.string().trim().min(1).max(32),
});

const shippingQuerySchema = z.object({
  shippingMethodCode: z.string().max(32).optional(),
});

/**
 * Whose offer a line is, on the shop front it was added from.
 *
 * On a seller's own storefront the seller is not a choice the shopper makes —
 * they are the shop. So the offer is resolved here, from the HOST the request
 * arrived on, and a `sellerOfferId` in the body is ignored rather than trusted:
 * accepting one would let a shopper on `northwind.uboss.example` post somebody
 * else's offer id and buy at that seller's price out of that seller's stock.
 *
 * A product this seller does not offer is refused by `addLines`, which re-checks
 * the offer against the product on the line — reaching this point with one is a
 * shopper following a stale link to a product the seller has since withdrawn.
 *
 * On the operator's own storefront this changes nothing: it returns the line
 * exactly as it arrived, `sellerOfferId` and all, which is what an API client
 * or a future integration needs.
 */
async function withStorefrontSeller<T extends { productId: string; variantId?: string | null }>(
  request: FastifyRequest,
  item: T,
): Promise<T & { sellerOfferId?: string | null }> {
  if (request.storefront === null) return item;

  const offer = await prisma.sellerOffer.findFirst({
    where: {
      sellerAccountId: request.storefront.sellerAccountId,
      productId: item.productId,
      variantKey: item.variantId ?? '',
      status: 'ACTIVE',
    },
    select: { id: true },
  });

  if (offer === null) {
    throw badRequest(
      ErrorCode.CART_ITEM_UNAVAILABLE,
      `${request.storefront.displayName} does not sell this.`,
      [{ field: 'productId', code: 'NOT_OFFERED_HERE' }],
    );
  }

  return { ...item, sellerOfferId: offer.id };
}

export function registerCartRoutes(app: FastifyInstance): Promise<void> {
  /** Every cart route requires an activated customer; guest checkout is off. */
  app.addHook('preHandler', requireCustomer);

  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const query = shippingQuerySchema.parse(request.query);

    const resolved = await resolveCart(auth.customerProfileId ?? '', {
      shippingMethodCode: query.shippingMethodCode ?? null,
    });

    return reply.status(200).send({ cart: toCartView(resolved) });
  });

  app.post('/items', async (request, reply) => {
    const auth = currentUser(request);
    const body = addItemSchema.parse(request.body);

    await addItem(auth.customerProfileId ?? '', await withStorefrontSeller(request, body));

    // Repriced and revalidated, so the client sees immediately if the line it
    // just added has a stock or limit problem.
    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(201).send({ cart: toCartView(resolved) });
  });

  /**
   * Add several options in one request.
   *
   * A customer who wants 3 ml *and* 5 ml of the same syringe picks both on the
   * product page and gets one request, not two. It matters that it is one:
   * both lines are written in a single transaction, so "added to your cart"
   * is never true of only half of what they chose, and a customer whose first
   * cart is being created cannot have two adds race into two carts.
   */
  app.post('/items/bulk', async (request, reply) => {
    const auth = currentUser(request);
    const body = addItemsSchema.parse(request.body);

    await addItems(
      auth.customerProfileId ?? '',
      await Promise.all(body.items.map((item) => withStorefrontSeller(request, item))),
    );

    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(201).send({ cart: toCartView(resolved) });
  });

  app.patch('/items/:itemId', async (request, reply) => {
    const auth = currentUser(request);
    const { itemId } = itemParam.parse(request.params);
    const body = updateQuantitySchema.parse(request.body);

    await updateItemQuantity(auth.customerProfileId ?? '', itemId, body.quantity);

    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(200).send({ cart: toCartView(resolved) });
  });

  /**
   * Change how many packs of a line the customer wants.
   *
   * The stepper on the basket sends this when the line was added by the box or
   * the carton, so "2" means two cartons and the pieces follow from the
   * conversion the line was agreed at - not from today's catalogue, which may
   * have been corrected since.
   */
  app.patch('/items/:itemId/packs', async (request, reply) => {
    const auth = currentUser(request);
    const { itemId } = itemParam.parse(request.params);
    const body = updatePackQuantitySchema.parse(request.body);

    await updateItemPackQuantity(auth.customerProfileId ?? '', itemId, body.unitQuantity);

    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(200).send({ cart: toCartView(resolved) });
  });

  app.delete('/items/:itemId', async (request, reply) => {
    const auth = currentUser(request);
    const { itemId } = itemParam.parse(request.params);

    await removeItem(auth.customerProfileId ?? '', itemId);

    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(200).send({ cart: toCartView(resolved) });
  });

  /**
   * Empty the cart.
   *
   * Answers with the emptied cart, like every other route in this file. It used
   * to answer `{ removed: n }` - the count the service happens to return - and
   * that single inconsistency broke the storefront: the client writes a cart
   * response straight into the cache both the cart page and the header basket
   * read from, so a body with no `cart` in it left every page rendering
   * `undefined.itemCount`. A delta is not a cheaper answer here, it is a
   * different shape, and one route with a different shape is the one the client
   * gets wrong.
   */
  app.delete('/', async (request, reply) => {
    const auth = currentUser(request);
    await clearCart(auth.customerProfileId ?? '');

    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(200).send({ cart: toCartView(resolved) });
  });

  /**
   * Apply a coupon.
   *
   * Validated here so a bad code is refused with a reason at the moment it is
   * typed, and re-validated on every cart read afterwards - a coupon can expire
   * or stop qualifying while the cart sits open.
   */
  app.post(
    '/coupon',
    { config: { rateLimit: { max: 30, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = couponSchema.parse(request.body);

      await applyCoupon(auth.customerProfileId ?? '', body.code);

      const resolved = await resolveCart(auth.customerProfileId ?? '');
      return reply.status(200).send({ cart: toCartView(resolved) });
    },
  );

  app.delete('/coupon', async (request, reply) => {
    const auth = currentUser(request);

    await removeCoupon(auth.customerProfileId ?? '');

    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(200).send({ cart: toCartView(resolved) });
  });

  /**
   * Submit the checkout.
   *
   * Requires an `Idempotency-Key` header. A double-clicked Pay button, or a
   * mobile network retrying a POST whose response was never seen, must not
   * produce two orders - and by the time payment is attached, a duplicate is
   * a duplicate charge.
   */
  app.post(
    '/checkout',
    { config: { rateLimit: { max: 20, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = checkoutSchema.parse(request.body);

      const idempotencyKey = request.headers['idempotency-key'];

      if (typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
        throw badRequest(
          ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
          'Send an Idempotency-Key header with this request.',
          [{ field: 'Idempotency-Key', code: 'REQUIRED' }],
        );
      }

      const result = await runIdempotent({
        scope: IdempotencyScope.CHECKOUT_SUBMIT,
        key: idempotencyKey.trim(),
        ownerId: auth.customerProfileId ?? auth.id,
        body,
        successStatus: 201,
        operation: () =>
          submitCheckout({
            customerProfileId: auth.customerProfileId ?? '',
            shippingAddressId: body.shippingAddressId,
            ...(body.billingAddressId !== undefined
              ? { billingAddressId: body.billingAddressId }
              : {}),
            shippingMethodCode: body.shippingMethodCode ?? null,
            paymentMode: body.paymentMode,
            ...(body.preferredPaymentProvider === undefined
              ? {}
              : { preferredPaymentProvider: body.preferredPaymentProvider }),
            ...(body.preferredPaymentMethod === undefined
              ? {}
              : { preferredPaymentMethod: body.preferredPaymentMethod }),
            ...(body.preferredPaymentInstrument === undefined
              ? {}
              : { preferredPaymentInstrument: body.preferredPaymentInstrument }),
            ...(body.preferredPaymentMethodId === undefined
              ? {}
              : { preferredPaymentMethodId: body.preferredPaymentMethodId }),
            ...(body.fulfilmentQuoteId === undefined
              ? {}
              : { fulfilmentQuoteId: body.fulfilmentQuoteId }),
            customerNote: body.customerNote ?? null,
            actor: {
              userId: auth.id,
              email: auth.email,
              type: 'CUSTOMER',
              ipAddress: request.ip,
              correlationId: request.correlationId,
            },
          }),
      });

      // `replayed` lets the client tell "your order was placed" from "your
      // order was already placed", without creating a second one either way.
      return reply.status(result.httpStatus).send({ ...result.value, replayed: result.replayed });
    },
  );

  return Promise.resolve();
}
