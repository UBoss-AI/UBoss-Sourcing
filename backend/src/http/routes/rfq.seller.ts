/**
 * Requests for quotation: the seller's side. Seller Hub -> Requests for
 * quotation (checklist Master rows 17-19).
 *
 * The seller is resolved from the session's membership; there is no seller id
 * in any path. A request this seller was not invited to answers 404.
 * Reading needs ORDER_READ; answering (declining, asking, quoting,
 * negotiating) needs ORDER_FULFIL on an account approved to trade.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { prisma } from '../../infra/prisma.js';
import { rfqNotFound, supplierFromMembership, type RfqSupplier } from '../../modules/rfq/access.js';
import {
  acceptOffer,
  acceptSchema,
  acceptedTerms,
  counterOffer,
  counterSchema,
  rejectOffer,
  rejectSchema,
  withdrawQuote,
  type Negotiator,
} from '../../modules/rfq/negotiation.service.js';
import { readRfqAttachment, storeRfqAttachment, supplierAttachmentWhere } from '../../modules/rfq/attachment.service.js';
import { quoteInputSchema, submitQuote, supplierQuote } from '../../modules/rfq/quote.service.js';
import { listThread, messageBodySchema, postMessage, threadQuerySchema } from '../../modules/rfq/message.service.js';
import {
  declineRfq,
  declineSchema,
  getSupplierRfq,
  listSupplierRfqs,
  loadInvitation,
  responseClosed,
  supplierListQuerySchema,
} from '../../modules/rfq/supplier.service.js';
import { currentUser } from '../plugins/auth.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';
import { sendAttachment } from './preorder-chats.js';
import { readRfqUpload, requireFeature } from './rfq.customer.js';

const idParams = z.object({ id: z.string().length(26) });
const attachmentParams = z.object({ id: z.string().length(26), attachmentId: z.string().length(26) });
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

function sellerNegotiator(supplier: RfqSupplier): Negotiator {
  return { party: 'SUPPLIER', userId: supplier.userId, email: null };
}

/** This seller's own quote on the request; anything else is not found. */
async function ownQuoteId(supplier: RfqSupplier, rfqId: string): Promise<string> {
  await loadInvitation(supplier, rfqId);
  const quote = await prisma.rfqQuote.findUnique({
    where: { rfqId_sellerAccountId: { rfqId, sellerAccountId: supplier.sellerAccountId } },
    select: { id: true },
  });
  if (quote === null) rfqNotFound();
  return quote.id;
}

export function supplierOf(request: FastifyRequest): RfqSupplier {
  return supplierFromMembership(currentSeller(request), currentUser(request).id);
}

export function registerSellerRfqRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', requireFeature);

  /** Requests for quotation this seller was asked to answer, with a count per filter. */
  app.get('/rfqs', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { filter } = supplierListQuerySchema.parse(request.query);
    return reply.header('Cache-Control', 'no-store').status(200).send(await listSupplierRfqs(supplierOf(request), filter));
  });

  /** One request this seller was invited to. Opening it marks the invitation viewed. */
  app.get('/rfqs/:id', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return reply.header('Cache-Control', 'no-store').status(200).send({ rfq: await getSupplierRfq(supplierOf(request), id) });
  });

  /** Decline to quote, with a reason the buyer reads. Writes an audit entry. */
  app.post(
    '/rfqs/:id/decline',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = declineSchema.parse(request.body);
      return reply.status(200).send({ rfq: await declineRfq(supplierOf(request), id, input) });
    },
  );

  /** This seller's questions and the buyer's answers, oldest first; `?after=` for only new ones. */
  app.get('/rfqs/:id/messages', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const { after } = threadQuerySchema.parse(request.query);
    const supplier = supplierOf(request);
    await loadInvitation(supplier, id);
    return reply
      .header('Cache-Control', 'no-store')
      .status(200)
      .send({ messages: await listThread(id, supplier.sellerAccountId, 'SUPPLIER', after) });
  });

  /** Ask the buyer a question. A resend with the same clientMessageId is not a second message. */
  app.post(
    '/rfqs/:id/messages',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const body = messageBodySchema.parse(request.body);
      const supplier = supplierOf(request);
      const invitation = await loadInvitation(supplier, id);
      const message = await postMessage({
        rfq: invitation.rfq,
        sellerAccountId: supplier.sellerAccountId,
        invitationStatus: invitation.status,
        party: 'SUPPLIER',
        userId: supplier.userId,
        body,
      });
      return reply.status(201).send({ message });
    },
  );

  /**
   * Quote on a request: a unit price, optional tiers and the commercial
   * terms, with files uploaded first. One quote per seller; before the
   * deadline only. Tells the buyer and writes an audit entry.
   */
  app.post(
    '/rfqs/:id/quotes',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = quoteInputSchema.parse(request.body);
      return reply.status(201).send({ quote: await submitQuote(supplierOf(request), id, input) });
    },
  );

  /** This seller's own quote on the request, with every offer version; null before it quoted. */
  app.get('/rfqs/:id/quote', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    return reply.header('Cache-Control', 'no-store').status(200).send({ quote: await supplierQuote(supplierOf(request), id) });
  });

  /** Send a counter-offer on this seller's quote. Names the version being answered. */
  app.post(
    '/rfqs/:id/quote/offers',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = counterSchema.parse(request.body);
      const supplier = supplierOf(request);
      return reply.status(201).send({ quote: await counterOffer(sellerNegotiator(supplier), await ownQuoteId(supplier, id), input) });
    },
  );

  /** Accept the buyer's counter-offer on the table. Awards the request and freezes the terms. */
  app.post(
    '/rfqs/:id/quote/accept',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = acceptSchema.parse(request.body);
      const supplier = supplierOf(request);
      return reply.status(200).send({ quote: await acceptOffer(sellerNegotiator(supplier), await ownQuoteId(supplier, id), input) });
    },
  );

  /** Reject the buyer's counter-offer on the table. */
  app.post(
    '/rfqs/:id/quote/reject',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const input = rejectSchema.parse(request.body);
      const supplier = supplierOf(request);
      return reply.status(200).send({ quote: await rejectOffer(sellerNegotiator(supplier), await ownQuoteId(supplier, id), input) });
    },
  );

  /** Withdraw this seller's quote while it is open. The buyer is told. */
  app.post(
    '/rfqs/:id/quote/withdraw',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const supplier = supplierOf(request);
      return reply.status(200).send({ quote: await withdrawQuote(sellerNegotiator(supplier), await ownQuoteId(supplier, id)) });
    },
  );

  /** The terms agreed with this seller, frozen at acceptance. Not found unless its quote won. */
  app.get('/rfqs/:id/accepted-terms', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const supplier = supplierOf(request);
    await loadInvitation(supplier, id);
    return reply.header('Cache-Control', 'no-store').status(200).send({ acceptedTerms: await acceptedTerms(id, supplier.sellerAccountId) });
  });

  /**
   * Upload a PDF or image to send with this seller's quote or next offer.
   * Seen by nobody else until it is sent with one.
   */
  app.post(
    '/rfqs/:id/attachments',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_FULFIL), config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const { purpose } = z.object({ purpose: z.enum(['QUOTE', 'NEGOTIATION']).default('QUOTE') }).parse(request.query);
      const supplier = supplierOf(request);
      const invitation = await loadInvitation(supplier, id);
      if (invitation.rfq.status !== 'OPEN') throw responseClosed(invitation.rfq.status);
      const file = await readRfqUpload(request);
      const attachment = await storeRfqAttachment(
        id,
        { ...file, purpose, sellerAccountId: supplier.sellerAccountId },
        { party: 'SUPPLIER', userId: supplier.userId, email: null },
      );
      return reply.status(201).send({ attachment });
    },
  );

  /** Download a file this seller may see on the request. Served as a download, never inline. */
  app.get(
    '/rfqs/:id/attachments/:attachmentId/download',
    { preHandler: requireSeller(SellerPermission.ORDER_READ) },
    async (request, reply) => {
      const { id, attachmentId } = attachmentParams.parse(request.params);
      const supplier = supplierOf(request);
      await loadInvitation(supplier, id);
      const file = await readRfqAttachment(id, attachmentId, supplierAttachmentWhere(id, supplier.sellerAccountId), {
        party: 'SUPPLIER',
        userId: supplier.userId,
        email: null,
      });
      return sendAttachment(reply, file);
    },
  );

  return Promise.resolve();
}
