/**
 * Bulk preorders: the seller's side. Seller Hub -> Orders -> Preorders, and
 * the preorder terms on a listing.
 *
 * Every route resolves the seller from the session's membership and passes
 * its id into the service, which narrows every read and write to it. A
 * request or a policy belonging to another seller answers 404, never 403.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { SellerPermission } from '../../domain/seller-permissions.js';
import {
  deletePolicy,
  policyInputSchema,
  readPolicyChain,
  savePolicy,
} from '../../modules/preorders/policy.service.js';
import {
  getSellerPreorder,
  listSellerPreorders,
  reasonSchema,
  sellerAccept,
  sellerAcceptSchema,
  sellerAdvanceProduction,
  sellerCounter,
  sellerCounterSchema,
  sellerReject,
} from '../../modules/preorders/request.service.js';
import { sellerResponder } from '../../modules/preorders/supplier.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;
const idParam = z.object({ id: z.string().length(26) });
const noteBody = z.object({ note: z.string().trim().max(1000).nullable().default(null) }).strict();

export function registerSellerPreorderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * List the seller's bulk preorder requests, newest activity first, with a
   * count for each filter tab. An optional filter narrows the list, such as
   * new, awaiting the buyer or in production.
   */
  app.get(
    '/preorders',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { filter } = z.object({ filter: z.string().max(32).optional() }).parse(request.query);
      const seller = currentSeller(request);
      return reply
        .status(200)
        .send(await listSellerPreorders(seller.sellerAccountId, filter ?? null));
    },
  );

  /** Show one of the seller's preorder requests in full. */
  app.get(
    '/preorders/:id',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const seller = currentSeller(request);
      return reply
        .status(200)
        .send({ preorder: await getSellerPreorder(seller.sellerAccountId, id) });
    },
  );

  /**
   * Accept a preorder on exactly the quantity, price and date the buyer asked
   * for, and email the buyer the terms to confirm. Refused if the price or date
   * differs; that has to be sent as a counter-offer. Writes an audit entry.
   */
  app.post(
    '/preorders/:id/accept',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: WRITE_RATE_LIMIT },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = sellerAcceptSchema.parse(request.body);
      return reply
        .status(200)
        .send({ preorder: await sellerAccept(sellerResponder(currentSeller(request)), id, input) });
    },
  );

  /**
   * Send the buyer a counter-offer on a preorder: a different quantity, price,
   * delivery date or split deliveries. Emails the buyer and writes an audit
   * entry.
   */
  app.post(
    '/preorders/:id/counter',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: WRITE_RATE_LIMIT },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = sellerCounterSchema.parse(request.body);
      return reply
        .status(200)
        .send({
          preorder: await sellerCounter(sellerResponder(currentSeller(request)), id, input),
        });
    },
  );

  /**
   * Turn down a preorder with a reason. Releases any capacity it was holding,
   * withdraws open offers, emails the buyer and writes an audit entry.
   */
  app.post(
    '/preorders/:id/reject',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: WRITE_RATE_LIMIT },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = reasonSchema.parse(request.body);
      return reply
        .status(200)
        .send({ preorder: await sellerReject(sellerResponder(currentSeller(request)), id, input) });
    },
  );

  /**
   * Mark a confirmed preorder as in production, with an optional note. Emails
   * the buyer and writes an audit entry.
   */
  app.post(
    '/preorders/:id/start-production',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: WRITE_RATE_LIMIT },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { note } = noteBody.parse(request.body ?? {});
      return reply.status(200).send({
        preorder: await sellerAdvanceProduction(
          sellerResponder(currentSeller(request)),
          id,
          'IN_PRODUCTION',
          note,
        ),
      });
    },
  );

  /**
   * Mark a preorder as made and ready to ship, with an optional note. Emails
   * the buyer and writes an audit entry.
   */
  app.post(
    '/preorders/:id/ready',
    {
      preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL),
      config: { rateLimit: WRITE_RATE_LIMIT },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { note } = noteBody.parse(request.body ?? {});
      return reply.status(200).send({
        preorder: await sellerAdvanceProduction(
          sellerResponder(currentSeller(request)),
          id,
          'READY_FOR_FULFILLMENT',
          note,
        ),
      });
    },
  );

  // --- Terms -----------------------------------------------------------------

  /** The three levels for one listing, or the seller default when no offer is named. */
  app.get(
    '/preorder-policies',
    { preHandler: requireSeller(SellerPermission.LISTING_READ) },
    async (request, reply) => {
      const { offerId } = z
        .object({ offerId: z.string().length(26).optional() })
        .parse(request.query);
      const seller = currentSeller(request);
      return reply
        .status(200)
        .send({ chain: await readPolicyChain(seller.sellerAccountId, offerId ?? null) });
    },
  );

  /**
   * Save the seller's preorder terms for one listing, one product, or as their
   * default. Refused if the terms would turn away every request. Writes an
   * audit entry.
   */
  app.put(
    '/preorder-policies',
    {
      preHandler: requireSeller(SellerPermission.OFFER_PRICE_WRITE),
      config: { rateLimit: WRITE_RATE_LIMIT },
    },
    async (request, reply) => {
      const input = policyInputSchema.parse(request.body);
      return reply.status(200).send({ policy: await savePolicy(currentSeller(request), input) });
    },
  );

  /**
   * Remove a set of preorder terms. Refused while a confirmed preorder still
   * depends on them; switch them off instead. Writes an audit entry.
   */
  app.delete(
    '/preorder-policies/:id',
    {
      preHandler: requireSeller(SellerPermission.OFFER_PRICE_WRITE),
      config: { rateLimit: WRITE_RATE_LIMIT },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      await deletePolicy(currentSeller(request), id);
      return reply.status(204).send();
    },
  );

  return Promise.resolve();
}
