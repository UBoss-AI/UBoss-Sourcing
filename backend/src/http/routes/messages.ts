/**
 * The message centre's routes (checklist JOURNEY-055).
 *
 *   - Order threads: the buyer and one seller about that seller's part of an
 *     order. Buyer side under /orders, seller side under /seller.
 *   - Report a message: a buyer (under /account) or a seller (under /seller)
 *     flags a message in a preorder chat, an RFQ thread or an order thread.
 *   - Translate a message: the same two audiences, behind
 *     FEATURE_MESSAGE_TRANSLATION and a stored DeepL key.
 *   - The moderation queue for staff, under /admin.
 *
 * Every read and write here is scoped by the session - the buyer's order and
 * RFQ ownership, or the seller the session belongs to - so an id from somebody
 * else's conversation is "not found", never "forbidden".
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import { SellerPermission } from '../../domain/seller-permissions.js';
import { buyerScopeWhere } from '../../modules/rfq/access.js';
import {
  MESSAGE_REPORT_REASONS,
  MESSAGE_THREAD_KINDS,
  decideMessageReport,
  listMessageReports,
  reportMessage,
  translateMessage,
  type MessageViewer,
} from '../../modules/messages/message-safety.service.js';
import {
  listBuyerOrderThreads,
  listBuyerRecentOrderThreads,
  listSellerOrderThread,
  orderMessageBodySchema,
  orderThreadQuerySchema,
  postOrderMessage,
} from '../../modules/messages/order-message.service.js';
import { buyerContextOf, currentUser, orderScopeWhere, requireAdmin, requireCustomer } from '../plugins/auth.js';
import { currentSeller, requireSeller, requireTradingSeller } from '../plugins/seller.js';

const WRITE_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;
const TRANSLATE_RATE_LIMIT = { max: 20, timeWindow: '1 minute' } as const;

const idParam = z.object({ id: z.string().length(26) });
const groupParams = z.object({ id: z.string().length(26), groupId: z.string().length(26) });

const reportSchema = z
  .object({
    threadKind: z.enum(MESSAGE_THREAD_KINDS),
    messageId: z.string().length(26),
    reason: z.enum(MESSAGE_REPORT_REASONS),
    note: z.string().trim().max(1000).nullable().default(null),
  })
  .strict();

const translateSchema = z
  .object({
    threadKind: z.enum(MESSAGE_THREAD_KINDS),
    messageId: z.string().length(26),
    language: z.enum(['en', 'de', 'el', 'es', 'fr', 'it', 'nl', 'pl']),
  })
  .strict();

function buyerViewer(request: FastifyRequest): MessageViewer {
  const auth = currentUser(request);
  const customerProfileId = auth.customerProfileId ?? '';
  return {
    party: 'BUYER',
    userId: auth.id,
    email: auth.email,
    customerProfileId,
    orderScope: orderScopeWhere(request),
    rfqScope: buyerScopeWhere({ userId: auth.id, email: auth.email, customerProfileId, context: buyerContextOf(request) }),
  };
}

function sellerViewer(request: FastifyRequest): MessageViewer {
  const auth = currentUser(request);
  return { party: 'SELLER', userId: auth.id, email: auth.email, sellerAccountId: currentSeller(request).sellerAccountId };
}

// ---------------------------------------------------------------------------
// Buyer: order threads (prefix /orders)
// ---------------------------------------------------------------------------

export function registerCustomerOrderMessageRoutes(app: FastifyInstance): Promise<void> {
  // Your messages with each seller on one of your orders, oldest first; `?after=` for only new ones.
  app.get('/:id/messages', { preHandler: requireCustomer }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { after } = orderThreadQuerySchema.parse(request.query);
    const threads = await listBuyerOrderThreads(id, orderScopeWhere(request), after);
    return reply.header('cache-control', 'no-store').status(200).send({ threads });
  });

  // Write to the seller of one part of your order. A resend with the same clientMessageId is not a second message.
  app.post(
    '/:id/messages/:groupId',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id, groupId } = groupParams.parse(request.params);
      const body = orderMessageBodySchema.parse(request.body);
      const auth = currentUser(request);
      const message = await postOrderMessage({
        groupId,
        party: 'BUYER',
        userId: auth.id,
        access: { orderScope: { id, ...orderScopeWhere(request) } },
        body,
      });
      return reply.status(201).send({ message });
    },
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Buyer: report and translate (prefix /account)
// ---------------------------------------------------------------------------

export function registerCustomerMessageSafetyRoutes(app: FastifyInstance): Promise<void> {
  // Your order threads with sellers that have messages, most recently active first.
  app.get('/order-messages', { preHandler: requireCustomer }, async (request, reply) => {
    const threads = await listBuyerRecentOrderThreads(orderScopeWhere(request));
    return reply.header('cache-control', 'no-store').status(200).send({ threads });
  });

  // Report a message in one of your conversations as abusive. Staff review it; a repeat finds the first report.
  app.post(
    '/messages/reports',
    { preHandler: requireCustomer, config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const input = reportSchema.parse(request.body);
      return reply.status(201).send({ report: await reportMessage(buyerViewer(request), input) });
    },
  );

  // Translate one message you can read into your language. Off unless the marketplace switched it on.
  app.post(
    '/messages/translate',
    { preHandler: requireCustomer, config: { rateLimit: TRANSLATE_RATE_LIMIT } },
    async (request, reply) => {
      const input = translateSchema.parse(request.body);
      return reply.header('cache-control', 'no-store').status(200).send(await translateMessage(buyerViewer(request), input));
    },
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Seller: order thread, report and translate (prefix /seller)
// ---------------------------------------------------------------------------

export function registerSellerMessageRoutes(app: FastifyInstance): Promise<void> {
  // The buyer's and your messages about one of your orders, oldest first; `?after=` for only new ones.
  app.get('/orders/:id/messages', { preHandler: requireSeller(SellerPermission.ORDER_READ) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { after } = orderThreadQuerySchema.parse(request.query);
    const thread = await listSellerOrderThread(id, currentSeller(request).sellerAccountId, after);
    return reply.header('cache-control', 'no-store').status(200).send({ thread });
  });

  // Write to the buyer about one of your orders. A resend with the same clientMessageId is not a second message.
  app.post(
    '/orders/:id/messages',
    { preHandler: requireTradingSeller(SellerPermission.ORDER_READ), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = orderMessageBodySchema.parse(request.body);
      const message = await postOrderMessage({
        groupId: id,
        party: 'SELLER',
        userId: currentUser(request).id,
        access: { sellerAccountId: currentSeller(request).sellerAccountId },
        body,
      });
      return reply.status(201).send({ message });
    },
  );

  // Report a message from a buyer as abusive. Staff review it; a repeat finds the first report.
  app.post(
    '/messages/reports',
    { preHandler: requireSeller(SellerPermission.ORDER_READ), config: { rateLimit: WRITE_RATE_LIMIT } },
    async (request, reply) => {
      const input = reportSchema.parse(request.body);
      return reply.status(201).send({ report: await reportMessage(sellerViewer(request), input) });
    },
  );

  // Translate one message in your RFQ or order threads into your language. Off unless switched on.
  app.post(
    '/messages/translate',
    { preHandler: requireSeller(SellerPermission.ORDER_READ), config: { rateLimit: TRANSLATE_RATE_LIMIT } },
    async (request, reply) => {
      const input = translateSchema.parse(request.body);
      return reply.header('cache-control', 'no-store').status(200).send(await translateMessage(sellerViewer(request), input));
    },
  );

  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// Staff: the moderation queue (prefix /admin)
// ---------------------------------------------------------------------------

export function registerAdminMessageReportRoutes(app: FastifyInstance): Promise<void> {
  // Reported messages, open first, with the words, who reported them and why.
  app.get('/message-reports', { preHandler: requireAdmin(Permission.REVIEW_READ) }, async (request, reply) => {
    const query = z
      .object({
        status: z.enum(['OPEN', 'ACTIONED', 'DISMISSED']).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(request.query);
    return reply.header('cache-control', 'no-store').status(200).send({ reports: await listMessageReports(query) });
  });

  // Decide a report - actioned or dismissed - with a note. Closes its bell alert; audited.
  app.post('/message-reports/:id/decision', { preHandler: requireAdmin(Permission.REVIEW_MODERATE) }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const body = z
      .object({ decision: z.enum(['ACTIONED', 'DISMISSED']), note: z.string().trim().min(1).max(1000) })
      .strict()
      .parse(request.body);
    const auth = currentUser(request);
    await decideMessageReport(id, body, { userId: auth.id, email: auth.email });
    return reply.status(204).send();
  });

  return Promise.resolve();
}
