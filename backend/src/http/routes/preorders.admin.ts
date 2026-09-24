/**
 * Bulk preorders, for the operator.
 *
 * Two different jobs on one screen:
 *
 *   - **A seller's preorder** is a negotiation between a buyer and that
 *     seller. Staff read it - support and audit need to see what was asked,
 *     proposed and agreed - and are given no way to answer for either party.
 *   - **A preorder on the operator's own product** (no seller) is the
 *     operator's to answer, exactly as a seller answers theirs: accept,
 *     counter, refuse, then production started and ready. The service's one
 *     access rule (`request.sellerAccountId === responder.sellerAccountId`,
 *     NULL for staff) is what keeps these routes off sellers' preorders.
 *
 * Reading needs `order.read`. Answering needs `order.fulfil`, the permission
 * staff already use to move an order through fulfilment.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { Permission } from '../../domain/permissions.js';
import { PreorderStatusValues } from '../../domain/preorder-state.js';
import {
  getAdminPreorder,
  listAdminPreorders,
  reasonSchema,
  sellerAccept,
  sellerAcceptSchema,
  sellerAdvanceProduction,
  sellerCounter,
  sellerCounterSchema,
  sellerReject,
} from '../../modules/preorders/request.service.js';
import { operatorResponder } from '../../modules/preorders/supplier.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });
const noteBody = z.object({ note: z.string().trim().max(1000).nullable().default(null) }).strict();
const WRITE_RATE_LIMIT = { max: 60, timeWindow: '1 minute' } as const;

export function registerAdminPreorderRoutes(app: FastifyInstance): Promise<void> {
  /**
   * List bulk preorders, optionally filtered by status and by who supplies
   * them (the store itself or a seller).
   */
  app.get(
    '/preorders',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { status, supplier } = z
        .object({
          status: z.enum(PreorderStatusValues).optional(),
          supplier: z.enum(['OPERATOR', 'SELLER']).optional(),
        })
        .parse(request.query);
      return reply
        .status(200)
        .send(await listAdminPreorders({ status: status ?? null, supplier: supplier ?? null }));
    },
  );

  /**
   * One preorder in full - what was asked, proposed and agreed - whether it
   * is a seller's or the store's own.
   */
  app.get(
    '/preorders/:id',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      return reply.status(200).send({ preorder: await getAdminPreorder(id) });
    },
  );

  const write = {
    preHandler: requireAdmin(Permission.ORDER_FULFIL),
    config: { rateLimit: WRITE_RATE_LIMIT },
  };

  /**
   * Accept a preorder for the store's own product exactly as the buyer asked.
   * Refused if the price or date differs from the request - that must be sent
   * as a counter-offer. Tells the buyer and writes an audit entry.
   *
   * Only reaches preorders with no seller; a seller's preorder answers 404.
   * `expectedVersion` guards against answering a request that changed since it
   * was opened.
   */
  app.post('/preorders/:id/accept', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = sellerAcceptSchema.parse(request.body);
    const responder = await operatorResponder(currentUser(request));
    return reply.status(200).send({ preorder: await sellerAccept(responder, id, input) });
  });

  /**
   * Answer a preorder for the store's own product with different terms -
   * quantity, price, freight, delivery date or split deliveries. Tells the
   * buyer and writes an audit entry.
   */
  app.post('/preorders/:id/counter', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = sellerCounterSchema.parse(request.body);
    const responder = await operatorResponder(currentUser(request));
    return reply.status(200).send({ preorder: await sellerCounter(responder, id, input) });
  });

  /**
   * Turn down a preorder for the store's own product, giving a reason. Closes
   * the request, releases any capacity it held and tells the buyer.
   */
  app.post('/preorders/:id/reject', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = reasonSchema.parse(request.body);
    const responder = await operatorResponder(currentUser(request));
    return reply.status(200).send({ preorder: await sellerReject(responder, id, input) });
  });

  /**
   * Record that production has started on a confirmed preorder for the
   * store's own product, with an optional note. Emails the buyer and writes an
   * audit entry.
   */
  app.post('/preorders/:id/start-production', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { note } = noteBody.parse(request.body ?? {});
    const responder = await operatorResponder(currentUser(request));
    return reply.status(200).send({
      preorder: await sellerAdvanceProduction(responder, id, 'IN_PRODUCTION', note),
    });
  });

  /**
   * Mark a preorder on the store's own product as ready to ship, with an
   * optional note. Emails the buyer and writes an audit entry.
   */
  app.post('/preorders/:id/ready', write, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { note } = noteBody.parse(request.body ?? {});
    const responder = await operatorResponder(currentUser(request));
    return reply.status(200).send({
      preorder: await sellerAdvanceProduction(responder, id, 'READY_FOR_FULFILLMENT', note),
    });
  });

  return Promise.resolve();
}
