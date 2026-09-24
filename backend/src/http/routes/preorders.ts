/**
 * Bulk preorders: the buyer's side.
 *
 * `GET /preorders/eligibility` is PUBLIC. A guest sees the Preorder button on
 * every product page, and whether it is enabled has to be decided by the same
 * server rule a signed-in buyer's submission is held to - otherwise the button
 * could invite a request the form then refuses. It says what the seller's
 * terms are, never who else has asked.
 *
 * Everything else requires a signed-in customer, and every read or write is
 * narrowed to that customer's own profile inside the service, so another
 * buyer's preorder answers exactly as a missing one does.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { ErrorCode, badRequest } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import { IdempotencyScope, runIdempotent } from '../../modules/orders/idempotency.service.js';
import {
  evaluateEligibility,
  serialiseEligibility,
} from '../../modules/preorders/policy.service.js';
import {
  buyerCancel,
  buyerConfirm,
  buyerConfirmSchema,
  buyerDecline,
  buyerDeclineSchema,
  getBuyerPreorder,
  listBuyerPreorders,
  preorderInputSchema,
  previewPreorder,
  reasonSchema,
  submitPreorder,
  type BuyerActor,
} from '../../modules/preorders/request.service.js';
import { currentUser, optionalCustomer, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

function buyerActor(request: FastifyRequest): BuyerActor {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    customerProfileId: auth.customerProfileId ?? '',
    correlationId: request.correlationId,
    ipAddress: request.ip,
  };
}

function idempotencyKey(request: FastifyRequest): string {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw badRequest(
      ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
      'Send an Idempotency-Key header with this request.',
      [{ field: 'Idempotency-Key', code: 'REQUIRED' }],
    );
  }
  return key.trim();
}

export function registerPreorderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Can this product be preordered, and on what terms?
   *
   * A signed-in buyer is answered for their default delivery address (or the
   * one named), because the earliest date depends on where it is going. A
   * guest is answered on the notice and production lead time alone, and the
   * form recomputes once an address is chosen.
   */
  app.get(
    '/eligibility',
    { preHandler: optionalCustomer, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const query = z
        .object({
          productId: z.string().length(26),
          variantId: z.string().length(26).optional(),
          offerId: z.string().length(26).optional(),
          addressId: z.string().length(26).optional(),
        })
        .parse(request.query);

      const profileId = request.auth?.customerProfileId ?? null;

      const address =
        profileId === null
          ? null
          : await prisma.address.findFirst({
              where: {
                customerProfileId: profileId,
                archivedAt: null,
                ...(query.addressId === undefined
                  ? { isDefaultShipping: true }
                  : { id: query.addressId }),
              },
              select: { id: true, country: true, timezone: true },
            });

      const buyer =
        profileId === null
          ? null
          : await prisma.customerProfile.findUnique({
              where: { id: profileId },
              select: { organization: true },
            });

      const result = await evaluateEligibility({
        productId: query.productId,
        variantId: query.variantId ?? null,
        offerId: query.offerId ?? null,
        destinationCountry: address?.country ?? null,
        timezone: address?.timezone ?? null,
      });

      reply.header('cache-control', 'no-store');
      return reply.status(200).send({
        eligibility: serialiseEligibility(result),
        viewer: {
          signedIn: profileId !== null,
          // Whether THIS account could submit: a business name is required.
          isBusinessBuyer: (buyer?.organization ?? '').trim() !== '',
          addressId: address?.id ?? null,
        },
      });
    },
  );

  app.post(
    '/preview',
    { preHandler: requireCustomer, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const input = preorderInputSchema.parse(request.body);
      const actor = buyerActor(request);
      return reply
        .status(200)
        .send({ preview: await previewPreorder(actor.customerProfileId, input) });
    },
  );

  app.post(
    '/',
    { preHandler: requireCustomer, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const input = preorderInputSchema.parse(request.body);
      const actor = buyerActor(request);

      const result = await runIdempotent({
        scope: IdempotencyScope.PREORDER_SUBMIT,
        key: idempotencyKey(request),
        ownerId: actor.customerProfileId,
        body: input,
        operation: async () => ({ preorder: await submitPreorder(actor, input) }),
      });

      return reply.status(result.httpStatus).send(result.value);
    },
  );

  app.get('/', { preHandler: requireCustomer }, async (request, reply) => {
    const actor = buyerActor(request);
    return reply.status(200).send(await listBuyerPreorders(actor.customerProfileId));
  });

  app.get('/:id', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const actor = buyerActor(request);
    return reply
      .status(200)
      .send({ preorder: await getBuyerPreorder(actor.customerProfileId, id) });
  });

  /**
   * Agree to the seller's current terms. Creates the order, awaiting payment.
   * The body names the revision and its hash, so only terms the buyer was
   * shown can be confirmed.
   */
  app.post(
    '/:id/confirm',
    { preHandler: requireCustomer, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = buyerConfirmSchema.parse(request.body);
      const actor = buyerActor(request);

      const result = await runIdempotent({
        scope: IdempotencyScope.PREORDER_CONFIRM,
        key: idempotencyKey(request),
        ownerId: actor.customerProfileId,
        body: { id, ...input },
        successStatus: 200,
        operation: async () => ({ preorder: await buyerConfirm(actor, id, input) }),
      });

      return reply.status(result.httpStatus).send(result.value);
    },
  );

  app.post(
    '/:id/decline',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = buyerDeclineSchema.parse(request.body ?? {});
      return reply
        .status(200)
        .send({ preorder: await buyerDecline(buyerActor(request), id, input) });
    },
  );

  app.post(
    '/:id/cancel',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = reasonSchema.parse(request.body);
      return reply
        .status(200)
        .send({ preorder: await buyerCancel(buyerActor(request), id, input) });
    },
  );

  return Promise.resolve();
}
