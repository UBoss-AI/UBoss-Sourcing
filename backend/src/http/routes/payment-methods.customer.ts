/**
 * Saved payment methods.
 *
 * The enrolment flow, in three requests:
 *
 *   1. POST /setup-intent  - the server asks the provider to begin. Answers
 *      with a client secret the browser needs to collect the card, and a
 *      publishable key. No card data touches this process, ever.
 *   2. The browser confirms the SetupIntent directly with the provider. The
 *      card number goes from the customer to Stripe and nowhere else.
 *   3. POST /  - the server RE-READS the SetupIntent from the provider and
 *      stores what it says, along with the customer's off-session consent.
 *
 * Step 3 not trusting step 2 is the point. The browser sends a setup-intent id
 * and a consent flag; everything else about the stored instrument comes from
 * the provider. A client that claims a card was enrolled when it was not gets
 * a refusal, not a row.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ErrorCode, forbidden } from '../../domain/errors.js';
import {
  beginPaymentMethodEnrolment,
  completePaymentMethodEnrolment,
  listPaymentMethods,
  removePaymentMethod,
  setDefaultPaymentMethod,
} from '../../modules/payments/payment-method.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

export function registerCustomerPaymentMethodRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  /**
   * Refuse the whole surface when auto-pay is off.
   *
   * A stored card exists only to be charged off-session. Letting a customer
   * save one where nothing can ever charge it would be collecting a payment
   * credential for no purpose, which is exactly what a deployment that turned
   * the flag off has decided not to do.
   */
  app.addHook('preHandler', async () => {
    if (!env.FEATURE_SUBSCRIPTION_AUTOPAY) {
      throw forbidden(
        ErrorCode.FEATURE_DISABLED,
        'Saving a card for automatic payments is not enabled for this store.',
      );
    }
    await Promise.resolve();
  });

  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const methods = await listPaymentMethods(auth.customerProfileId ?? '');

    return reply.status(200).send({ paymentMethods: methods });
  });

  /**
   * Begin enrolment.
   *
   * Rate-limited harder than an ordinary read: each call can create a customer
   * record at the provider, and the idempotency key inside the service buckets
   * repeats within ten minutes rather than for ever.
   */
  app.post(
    '/setup-intent',
    { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const auth = currentUser(request);

      const setup = await beginPaymentMethodEnrolment(auth.customerProfileId ?? '', {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        correlationId: request.correlationId,
      });

      // The client secret authorises confirming this one SetupIntent and
      // nothing else - it cannot read the account, list payments or refund
      // anything. The publishable key is public by design.
      return reply.status(201).send(setup);
    },
  );

  /** Finish enrolment. The provider is re-read; the client is not trusted. */
  app.post(
    '/',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const auth = currentUser(request);

      const body = z
        .object({
          setupIntentId: z.string().trim().min(1).max(128),
          /** Must be true. The customer is authorising charges they will not see. */
          consentAccepted: z.boolean(),
          consentVersion: z.string().trim().max(32).optional(),
          makeDefault: z.boolean().optional(),
        })
        .parse(request.body);

      const method = await completePaymentMethodEnrolment(
        { ...body, customerProfileId: auth.customerProfileId ?? '' },
        {
          userId: auth.id,
          email: auth.email,
          type: 'CUSTOMER',
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          correlationId: request.correlationId,
        },
      );

      return reply.status(201).send({ paymentMethod: method });
    },
  );

  app.post('/:id/default', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const method = await setDefaultPaymentMethod(id, auth.customerProfileId ?? '', {
      userId: auth.id,
      email: auth.email,
      type: 'CUSTOMER',
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });

    return reply.status(200).send({ paymentMethod: method });
  });

  /**
   * Remove a card.
   *
   * Refused while a live schedule depends on it, with the plans named in the
   * error detail so the storefront can offer to change them rather than just
   * saying no.
   */
  app.delete('/:id', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    await removePaymentMethod(id, auth.customerProfileId ?? '', {
      userId: auth.id,
      email: auth.email,
      type: 'CUSTOMER',
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });

    return reply.status(200).send({ removed: true });
  });

  return Promise.resolve();
}
