/**
 * Orders - customer and admin.
 *
 * Both surfaces are registered from this file so the serialisation stays in one
 * place, but they are separate route trees with separate guards. The customer
 * view is scoped by session-derived profile id and omits internal notes; the
 * admin view is permission-gated and shows everything.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { OrderStatusValues } from '../../domain/order-state-machine.js';
import { Permission } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';
import {
  availableTransitions,
  decideApproval,
  transitionOrder,
} from '../../modules/orders/order.service.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(OrderStatusValues).optional(),
  source: z.enum(['ONE_TIME', 'RECURRING']).optional(),
});

const adminListQuerySchema = listQuerySchema.extend({
  q: z.string().trim().max(120).optional(),
  customerProfileId: z.string().length(26).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

type OrderRow = Awaited<ReturnType<typeof prisma.order.findFirstOrThrow>>;

function serialiseTotals(order: OrderRow): Record<string, unknown> {
  return {
    subtotal: serialiseMoney(order.subtotalMinor, order.currency),
    discount: serialiseMoney(order.discountMinor, order.currency),
    tax: serialiseMoney(order.taxMinor, order.currency),
    shipping: serialiseMoney(order.shippingMinor, order.currency),
    grandTotal: serialiseMoney(order.grandTotalMinor, order.currency),
    paid: serialiseMoney(order.paidMinor, order.currency),
    refunded: serialiseMoney(order.refundedMinor, order.currency),
  };
}

function serialiseSummary(order: OrderRow & { _count?: { items: number } }): Record<string, unknown> {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    source: order.source,
    currency: order.currency,
    totals: serialiseTotals(order),
    paymentMode: order.paymentMode,
    placedAt: order.placedAt?.toISOString() ?? null,
    confirmedAt: order.confirmedAt?.toISOString() ?? null,
    itemCount: order._count?.items ?? 0,
    createdAt: order.createdAt.toISOString(),
  };
}

// --- Customer routes -------------------------------------------------------

export function registerCustomerOrderRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const query = listQuerySchema.parse(request.query);

    // Scoped by the session's profile. There is no customer route that accepts
    // a profile id, so there is nothing here to forget to check.
    const where = {
      customerProfileId: auth.customerProfileId ?? '',
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.source !== undefined ? { source: query.source } : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: { _count: { select: { items: true } } },
      }),
      prisma.order.count({ where }),
    ]);

    return reply.status(200).send({
      orders: rows.map(serialiseSummary),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const order = await prisma.order.findFirst({
      // The ownership check is the `where` clause itself: another customer's
      // order simply does not match, so it 404s rather than 403s.
      where: { id, customerProfileId: auth.customerProfileId ?? '' },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: 'asc' } },
        shipments: true,
        approvals: true,
      },
    });

    if (order === null) throw notFound('Order');

    return reply.status(200).send({
      order: {
        ...serialiseSummary(order),
        shippingAddress: order.shippingAddressJson,
        billingAddress: order.billingAddressJson,
        shippingMethodName: order.shippingMethodName,
        customerNote: order.customerNote,
        // `internalNote` is deliberately absent: it is written by staff about
        // the order and is not the customer's to read.
        cancelReason: order.cancelReason,
        items: order.items.map((item) => ({
          id: item.id,
          // The product and variant ids let a customer reorder from their own
          // history. They identify no more than the SKU already returned
          // beside them, and without them Reorder cannot name what to add.
          productId: item.productId,
          variantId: item.variantId,
          name: item.nameSnapshot,
          sku: item.skuSnapshot,
          variantName: item.variantNameSnapshot,
          imageUrl: item.imageUrlSnapshot,
          quantity: item.quantity,
          unitPrice: serialiseMoney(item.unitPriceMinor, order.currency),
          lineSubtotal: serialiseMoney(item.lineSubtotalMinor, order.currency),
          tax: serialiseMoney(item.taxAmountMinor, order.currency),
          lineTotal: serialiseMoney(item.lineTotalMinor, order.currency),
          taxRatePercent: item.taxRatePercent.toString(),
        })),
        timeline: order.statusHistory.map((entry) => ({
          from: entry.fromStatus,
          to: entry.toStatus,
          reason: entry.reason,
          at: entry.createdAt.toISOString(),
        })),
        shipments: order.shipments.map((shipment) => ({
          carrier: shipment.carrier,
          trackingNumber: shipment.trackingNumber,
          trackingUrl: shipment.trackingUrl,
          status: shipment.status,
          dispatchedAt: shipment.dispatchedAt?.toISOString() ?? null,
          deliveredAt: shipment.deliveredAt?.toISOString() ?? null,
        })),
        approval: order.approvals[0] ?? null,
      },
    });
  });

  /** Cancel an order the policy still allows to be cancelled. */
  app.post('/:id/cancel', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().trim().min(1).max(512) }).parse(request.body);

    const order = await prisma.order.findFirst({
      where: { id, customerProfileId: auth.customerProfileId ?? '' },
      select: { id: true },
    });
    if (order === null) throw notFound('Order');

    // The state machine decides whether a customer may cancel from the current
    // status. After dispatch they cannot, and it says so.
    const result = await transitionOrder({
      orderId: id,
      to: 'CANCELLED',
      actor: {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        correlationId: request.correlationId,
      },
      reason: body.reason,
    });

    return reply.status(200).send(result);
  });

  return Promise.resolve();
}

// --- Admin routes ----------------------------------------------------------

export function registerAdminOrderRoutes(app: FastifyInstance): Promise<void> {
  app.get('/orders', { preHandler: requireAdmin(Permission.ORDER_READ) }, async (request, reply) => {
    const query = adminListQuerySchema.parse(request.query);

    const where = {
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.source !== undefined ? { source: query.source } : {}),
      ...(query.customerProfileId !== undefined
        ? { customerProfileId: query.customerProfileId }
        : {}),
      ...(query.from !== undefined || query.to !== undefined
        ? {
            createdAt: {
              ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
              ...(query.to !== undefined ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q !== undefined && query.q.length > 0
        ? {
            OR: [
              { orderNumber: { contains: query.q } },
              { customerProfile: { fullName: { contains: query.q } } },
              { customerProfile: { organization: { contains: query.q } } },
            ],
          }
        : {}),
    };

    const [rows, total] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        include: {
          _count: { select: { items: true } },
          customerProfile: {
            select: { id: true, fullName: true, organization: true },
          },
        },
      }),
      prisma.order.count({ where }),
    ]);

    return reply.status(200).send({
      orders: rows.map((row) => ({
        ...serialiseSummary(row),
        customer: row.customerProfile,
      })),
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    });
  });

  app.get(
    '/orders/:id',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const auth = currentUser(request);

      const order = await prisma.order.findUnique({
        where: { id },
        include: {
          items: true,
          statusHistory: { orderBy: { createdAt: 'asc' } },
          approvals: true,
          payments: true,
          paymentLinks: true,
          refunds: true,
          shipments: true,
          reservations: true,
          customerProfile: {
            include: { user: { select: { email: true, status: true } } },
          },
        },
      });

      if (order === null) throw notFound('Order');

      // The Admin Panel renders exactly these as buttons, so what it offers
      // always matches what the API will accept.
      const transitions = await availableTransitions(id, {
        userId: auth.id,
        email: auth.email,
        type: 'ADMIN',
        permissions: auth.permissions,
      });

      return reply.status(200).send({
        order: {
          ...serialiseSummary(order),
          customer: {
            id: order.customerProfile.id,
            fullName: order.customerProfile.fullName,
            organization: order.customerProfile.organization,
            email: order.customerProfile.user.email,
            status: order.customerProfile.user.status,
          },
          shippingAddress: order.shippingAddressJson,
          billingAddress: order.billingAddressJson,
          shippingMethodName: order.shippingMethodName,
          customerNote: order.customerNote,
          internalNote: order.internalNote,
          cancelReason: order.cancelReason,
          items: order.items.map((item) => ({
            id: item.id,
            productId: item.productId,
            name: item.nameSnapshot,
            sku: item.skuSnapshot,
            variantName: item.variantNameSnapshot,
            quantity: item.quantity,
            unitPrice: serialiseMoney(item.unitPriceMinor, order.currency),
            lineSubtotal: serialiseMoney(item.lineSubtotalMinor, order.currency),
            tax: serialiseMoney(item.taxAmountMinor, order.currency),
            lineTotal: serialiseMoney(item.lineTotalMinor, order.currency),
            taxRatePercent: item.taxRatePercent.toString(),
            taxClassCode: item.taxClassCodeSnapshot,
          })),
          timeline: order.statusHistory.map((entry) => ({
            from: entry.fromStatus,
            to: entry.toStatus,
            actorType: entry.actorType,
            actorUserId: entry.actorUserId,
            reason: entry.reason,
            at: entry.createdAt.toISOString(),
          })),
          approvals: order.approvals,
          payments: order.payments.map((payment) => ({
            id: payment.id,
            provider: payment.provider,
            mode: payment.mode,
            status: payment.status,
            amount: serialiseMoney(payment.amountMinor, payment.currency),
            captured: serialiseMoney(payment.capturedMinor, payment.currency),
            providerOrderId: payment.providerOrderId,
            providerPaymentId: payment.providerPaymentId,
            failureCode: payment.failureCode,
            createdAt: payment.createdAt.toISOString(),
          })),
          paymentLinks: order.paymentLinks.map((link) => ({
            id: link.id,
            // The token hash is never exposed; only its lifecycle is.
            recipientEmail: link.recipientEmail,
            amount: serialiseMoney(link.amountMinor, link.currency),
            expiresAt: link.expiresAt.toISOString(),
            sentAt: link.sentAt?.toISOString() ?? null,
            usedAt: link.usedAt?.toISOString() ?? null,
            revokedAt: link.revokedAt?.toISOString() ?? null,
          })),
          refunds: order.refunds.map((refund) => ({
            id: refund.id,
            status: refund.status,
            amount: serialiseMoney(refund.amountMinor, refund.currency),
            reason: refund.reason,
            createdAt: refund.createdAt.toISOString(),
          })),
          shipments: order.shipments,
          reservationCount: order.reservations.filter((r) => r.status === 'ACTIVE').length,
          availableTransitions: transitions,
        },
      });
    },
  );

  /**
   * Apply a status transition.
   *
   * One endpoint rather than per-status routes, because the state machine
   * already knows which moves are legal and which permission each needs -
   * duplicating that as route definitions would let the two drift apart.
   */
  app.post(
    '/orders/:id/transition',
    { preHandler: requireAdmin(Permission.ORDER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({
          to: z.enum(OrderStatusValues),
          reason: z.string().max(512).optional(),
        })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await transitionOrder({
        orderId: id,
        to: body.to,
        actor: {
          userId: auth.id,
          email: auth.email,
          type: 'ADMIN',
          // The state machine performs the per-transition permission check.
          permissions: auth.permissions,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        ...(body.reason !== undefined ? { reason: body.reason } : {}),
      });

      return reply.status(200).send(result);
    },
  );

  app.post(
    '/orders/:id/approval',
    { preHandler: requireAdmin(Permission.ORDER_APPROVE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ approved: z.boolean(), comment: z.string().max(512).optional() })
        .parse(request.body);

      const auth = currentUser(request);

      const result = await decideApproval(
        id,
        body.approved,
        {
          userId: auth.id,
          email: auth.email,
          type: 'ADMIN',
          permissions: auth.permissions,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        body.comment,
      );

      return reply.status(200).send(result);
    },
  );

  app.patch(
    '/orders/:id/note',
    { preHandler: requireAdmin(Permission.ORDER_NOTE_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ internalNote: z.string().max(20_000).nullable() }).parse(request.body);

      const updated = await prisma.order.updateMany({
        where: { id },
        data: { internalNote: body.internalNote },
      });

      if (updated.count === 0) throw notFound('Order');
      return reply.status(200).send({ updated: true });
    },
  );

  return Promise.resolve();
}
