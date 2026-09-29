/**
 * Payment and refund receipts - the buyer's copy and the staff copy.
 *
 * The buyer's routes find the order with `orderScopeWhere`, exactly like the
 * order detail route, so another buyer's order - or one from the other buyer
 * context - does not match and answers 404. Staff reach any order behind
 * PAYMENT_READ. Both download the same PDF; see
 * `modules/payments/payment-receipt.service.ts`.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../domain/errors.js';
import { Permission } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';
import { isSupportedLanguage, type SupportedLanguage } from '../../modules/identity/language.service.js';
import { listOrderReceipts, renderReceipt } from '../../modules/payments/payment-receipt.service.js';
import { currentUser, orderScopeWhere, requireAdmin, requireCustomer } from '../plugins/auth.js';

const orderParam = z.object({ id: z.string().length(26) });
const receiptParam = orderParam.extend({
  kind: z.enum(['payment', 'refund']),
  sourceId: z.string().length(26),
});
const languageQuery = z.object({ lang: z.string().max(8).optional() });

async function languageFor(userId: string, requested: string | undefined): Promise<SupportedLanguage> {
  if (isSupportedLanguage(requested)) return requested;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { preferredLanguage: true } });
  return isSupportedLanguage(user?.preferredLanguage) ? user.preferredLanguage : 'en';
}

function sendPdf(reply: FastifyReply, file: { bytes: Buffer; fileName: string }): FastifyReply {
  return reply
    .header('content-type', 'application/pdf')
    .header('content-disposition', `attachment; filename="${file.fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`)
    .header('cache-control', 'no-store')
    .send(file.bytes);
}

export function registerCustomerPaymentReceiptRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  // The receipts the buyer can download for one of their own orders: each captured payment and each confirmed refund.
  app.get('/:id/receipts', async (request, reply) => {
    const { id } = orderParam.parse(request.params);
    const order = await prisma.order.findFirst({ where: { id, ...orderScopeWhere(request) }, select: { id: true } });
    if (order === null) throw notFound('Order');
    return reply.header('cache-control', 'no-store').send({ receipts: await listOrderReceipts(order.id) });
  });

  // Download the buyer's receipt for one payment or refund on their own order as a PDF; the first download issues its number.
  app.get('/:id/receipts/:kind/:sourceId', async (request, reply) => {
    const { id, kind, sourceId } = receiptParam.parse(request.params);
    const { lang } = languageQuery.parse(request.query);
    const auth = currentUser(request);
    const order = await prisma.order.findFirst({ where: { id, ...orderScopeWhere(request) }, select: { id: true } });
    if (order === null) throw notFound('Order');
    const file = await renderReceipt({
      orderId: order.id,
      kind,
      sourceId,
      language: await languageFor(auth.id, lang),
      actor: { type: 'CUSTOMER', userId: auth.id, email: auth.email },
    });
    return sendPdf(reply, file);
  });

  return Promise.resolve();
}

export function registerAdminPaymentReceiptRoutes(app: FastifyInstance): Promise<void> {
  // The receipts staff can download for any order: each captured payment and each confirmed refund.
  app.get('/orders/:id/receipts', { preHandler: requireAdmin(Permission.PAYMENT_READ) }, async (request, reply) => {
    const { id } = orderParam.parse(request.params);
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
    if (order === null) throw notFound('Order');
    return reply.header('cache-control', 'no-store').send({ receipts: await listOrderReceipts(order.id) });
  });

  // Download the buyer's receipt for one payment or refund as a PDF, as staff; the same document and number the buyer gets.
  app.get(
    '/orders/:id/receipts/:kind/:sourceId',
    { preHandler: requireAdmin(Permission.PAYMENT_READ) },
    async (request, reply) => {
      const { id, kind, sourceId } = receiptParam.parse(request.params);
      const { lang } = languageQuery.parse(request.query);
      const auth = currentUser(request);
      const order = await prisma.order.findUnique({ where: { id }, select: { id: true } });
      if (order === null) throw notFound('Order');
      const file = await renderReceipt({
        orderId: order.id,
        kind,
        sourceId,
        language: await languageFor(auth.id, lang),
        actor: { type: 'ADMIN', userId: auth.id, email: auth.email },
      });
      return sendPdf(reply, file);
    },
  );

  return Promise.resolve();
}
