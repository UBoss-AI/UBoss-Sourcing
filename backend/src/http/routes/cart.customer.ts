/**
 * Cart and checkout.
 *
 * Every response is a full repriced cart, not a delta. A mutation that returned
 * only "ok" would leave the browser guessing at totals, and a client that
 * computes its own totals is a client that can disagree with the server about
 * what an order costs.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest } from '../../domain/errors.js';
import {
  addItem,
  applyCoupon,
  clearCart,
  removeCoupon,
  removeItem,
  resolveCart,
  toCartView,
  updateItemQuantity,
} from '../../modules/cart/cart.service.js';
import {
  IdempotencyScope,
  runIdempotent,
} from '../../modules/orders/idempotency.service.js';
import { submitCheckout } from '../../modules/orders/order.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

const addItemSchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
  quantity: z.number().int().min(1).max(1_000_000),
});

const updateQuantitySchema = z.object({
  // Zero removes the line, which is what a quantity stepper sends at 0.
  quantity: z.number().int().min(0).max(1_000_000),
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
  customerNote: z.string().max(2000).nullable().optional(),
});

const itemParam = z.object({ itemId: z.string().length(26) });

const couponSchema = z.object({
  code: z.string().trim().min(1).max(32),
});

const shippingQuerySchema = z.object({
  shippingMethodCode: z.string().max(32).optional(),
});

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

    await addItem(auth.customerProfileId ?? '', body);

    // Repriced and revalidated, so the client sees immediately if the line it
    // just added has a stock or limit problem.
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

  app.delete('/items/:itemId', async (request, reply) => {
    const auth = currentUser(request);
    const { itemId } = itemParam.parse(request.params);

    await removeItem(auth.customerProfileId ?? '', itemId);

    const resolved = await resolveCart(auth.customerProfileId ?? '');
    return reply.status(200).send({ cart: toCartView(resolved) });
  });

  app.delete('/', async (request, reply) => {
    const auth = currentUser(request);
    const result = await clearCart(auth.customerProfileId ?? '');
    return reply.status(200).send(result);
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
