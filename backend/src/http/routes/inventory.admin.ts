/**
 * Admin inventory routes.
 *
 * The service layer and its ledger were built in Prompt 1 step 5; this is the
 * HTTP surface the Admin Panel's Inventory screen needs.
 *
 * One rule shapes every route here: **computed balances are never writable.**
 * `onHandQty` and `reservedQty` are the result of the movement ledger. The API
 * exposes receipts and adjustments, which append movements; it exposes no way
 * to set a balance directly. An admin who could type a number into on-hand
 * could erase the audit trail that explains where stock went.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorCode, badRequest, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import { variantKeyOf } from '../../infra/ids.js';
import { prisma } from '../../infra/prisma.js';
import {
  adjustStock,
  getAvailability,
  receiveStock,
} from '../../modules/inventory/inventory.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const stockKeySchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
  locationId: z.string().length(26).optional(),
});

function actorFrom(request: FastifyRequest): {
  userId: string;
  email: string;
  ipAddress: string;
  correlationId: string;
} {
  const auth = currentUser(request);
  return {
    userId: auth.id,
    email: auth.email,
    ipAddress: request.ip,
    correlationId: request.correlationId,
  };
}

export function registerAdminInventoryRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Stock levels, one row per SKU and location.
   *
   * Joined to the product so the screen can show name, SKU and threshold
   * without a second round trip per row.
   */
  app.get(
    '/inventory',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          q: z.string().trim().max(120).optional(),
          locationId: z.string().length(26).optional(),
          lowStockOnly: z.enum(['true', 'false']).default('false'),
        })
        .parse(request.query);

      const where = {
        product: {
          archivedAt: null,
          isStockTracked: true,
          ...(query.q !== undefined && query.q.length > 0
            ? { OR: [{ name: { contains: query.q } }, { sku: { contains: query.q } }] }
            : {}),
        },
        ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.inventoryBalance.findMany({
          where,
          // `id` as a tiebreaker keeps pagination stable.
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: {
            product: {
              select: {
                id: true,
                name: true,
                sku: true,
                reorderThreshold: true,
                basePriceMinor: true,
                currency: true,
              },
            },
            variant: { select: { id: true, name: true, sku: true } },
            location: { select: { id: true, code: true, name: true } },
          },
        }),
        prisma.inventoryBalance.count({ where }),
      ]);

      const mapped = rows.map((row) => {
        const available = row.onHandQty - row.reservedQty;
        const isLowStock =
          row.product.reorderThreshold > 0 && available <= row.product.reorderThreshold;

        return {
          balanceId: row.id,
          productId: row.product.id,
          productName: row.product.name,
          sku: row.variant?.sku ?? row.product.sku,
          variantId: row.variant?.id ?? null,
          variantName: row.variant?.name ?? null,
          location: row.location,
          onHandQty: row.onHandQty,
          reservedQty: row.reservedQty,
          // Derived, and clearly labelled as such: the UI must show this as
          // read-only, not as an editable field.
          availableQty: available,
          reorderThreshold: row.product.reorderThreshold,
          isLowStock,
          unitPrice: serialiseMoney(row.product.basePriceMinor, row.product.currency),
          valuation: serialiseMoney(
            row.product.basePriceMinor * BigInt(row.onHandQty),
            row.product.currency,
          ),
          updatedAt: row.updatedAt.toISOString(),
        };
      });

      // Filtering on a derived value has to happen after the join. The page is
      // capped at 100 rows, so this is bounded work.
      const filtered = query.lowStockOnly === 'true' ? mapped.filter((row) => row.isLowStock) : mapped;

      return reply.status(200).send({
        inventory: filtered,
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  /** Live availability for one SKU. Used by the receipt and adjustment dialogs. */
  app.get(
    '/inventory/availability',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = stockKeySchema.parse(request.query);

      const product = await prisma.product.findUnique({
        where: { id: query.productId },
        select: { id: true, name: true, sku: true, isStockTracked: true, archivedAt: true },
      });

      if (product === null || product.archivedAt !== null) throw notFound('Product');

      if (!product.isStockTracked) {
        throw badRequest(
          ErrorCode.STOCK_NOT_TRACKED,
          `${product.name} is not stock-tracked, so it has no balance.`,
          [{ field: 'productId', code: 'NOT_TRACKED' }],
        );
      }

      const availability = await getAvailability({
        productId: query.productId,
        variantId: query.variantId ?? null,
        ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
      });

      return reply.status(200).send({
        product: { id: product.id, name: product.name, sku: product.sku },
        ...availability,
      });
    },
  );

  /**
   * Movement history.
   *
   * The append-only ledger. Every row names the actor, the reason and the
   * order or reference that caused it - which is what makes a stock
   * discrepancy investigable rather than a mystery.
   */
  app.get(
    '/inventory/movements',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          productId: z.string().length(26).optional(),
          variantId: z.string().length(26).optional(),
          locationId: z.string().length(26).optional(),
          type: z
            .enum([
              'RECEIPT',
              'ADJUSTMENT',
              'RESERVATION_COMMIT',
              'ORDER_CANCEL_RESTOCK',
              'RETURN_RESTOCK',
              'RETURN_QUARANTINE',
              'SYNC_CORRECTION',
            ])
            .optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
        })
        .parse(request.query);

      const where = {
        ...(query.productId !== undefined ? { productId: query.productId } : {}),
        ...(query.variantId !== undefined
          ? { variantKey: variantKeyOf(query.variantId) }
          : {}),
        ...(query.locationId !== undefined ? { locationId: query.locationId } : {}),
        ...(query.type !== undefined ? { type: query.type } : {}),
        ...(query.from !== undefined || query.to !== undefined
          ? {
              createdAt: {
                ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
                ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.inventoryMovement.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: {
            product: { select: { id: true, name: true, sku: true } },
            variant: { select: { id: true, name: true, sku: true } },
            location: { select: { id: true, code: true } },
          },
        }),
        prisma.inventoryMovement.count({ where }),
      ]);

      // The actor is stored as an id; resolve the emails in one query rather
      // than per row.
      const actorIds = [
        ...new Set(rows.map((row) => row.actorUserId).filter((id): id is string => id !== null)),
      ];

      const actors =
        actorIds.length === 0
          ? []
          : await prisma.user.findMany({
              where: { id: { in: actorIds } },
              select: { id: true, email: true },
            });

      const emailById = new Map(actors.map((actor) => [actor.id, actor.email]));

      return reply.status(200).send({
        movements: rows.map((row) => ({
          id: row.id,
          type: row.type,
          product: row.product,
          variant: row.variant,
          location: row.location,
          quantityDelta: row.quantityDelta,
          resultingOnHand: row.resultingOnHand,
          reason: row.reason,
          referenceType: row.referenceType,
          referenceId: row.referenceId,
          actorType: row.actorType,
          actorUserId: row.actorUserId,
          actorEmail: row.actorUserId === null ? null : (emailById.get(row.actorUserId) ?? null),
          createdAt: row.createdAt.toISOString(),
        })),
        pagination: {
          page: query.page,
          limit: query.limit,
          total,
          totalPages: Math.ceil(total / query.limit),
        },
      });
    },
  );

  /**
   * Receive stock.
   *
   * Positive only. Correcting a mistaken receipt is an adjustment with a
   * reason, not a negative receipt - the ledger should say what happened.
   */
  app.post(
    '/inventory/receipts',
    { preHandler: requireAdmin(Permission.INVENTORY_RECEIVE) },
    async (request, reply) => {
      const body = stockKeySchema
        .extend({
          quantity: z.number().int().min(1).max(10_000_000),
          reference: z.string().max(128).nullable().optional(),
          note: z.string().max(512).nullable().optional(),
        })
        .parse(request.body);

      const result = await receiveStock(
        {
          productId: body.productId,
          variantId: body.variantId ?? null,
          ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
          quantity: body.quantity,
          reference: body.reference ?? null,
          note: body.note ?? null,
        },
        actorFrom(request),
      );

      return reply.status(201).send(result);
    },
  );

  /**
   * Adjust stock.
   *
   * A reason is mandatory (SOP §6). An adjustment can conjure or destroy
   * stock, so an unexplained one is indistinguishable from theft or a
   * data-entry error.
   */
  app.post(
    '/inventory/adjustments',
    { preHandler: requireAdmin(Permission.INVENTORY_ADJUST) },
    async (request, reply) => {
      const body = stockKeySchema
        .extend({
          // Signed and non-zero. Refusing 0 here gives a field-level error
          // rather than letting the service reject it generically.
          quantityDelta: z
            .number()
            .int()
            .min(-10_000_000)
            .max(10_000_000)
            .refine((value) => value !== 0, 'An adjustment cannot be zero.'),
          reason: z.string().trim().min(1).max(512),
        })
        .parse(request.body);

      const result = await adjustStock(
        {
          productId: body.productId,
          variantId: body.variantId ?? null,
          ...(body.locationId !== undefined ? { locationId: body.locationId } : {}),
          quantityDelta: body.quantityDelta,
          reason: body.reason,
        },
        actorFrom(request),
      );

      return reply.status(201).send(result);
    },
  );

  /** Locations, for the receipt and adjustment dialogs. */
  app.get(
    '/inventory/locations',
    { preHandler: requireAdmin(Permission.INVENTORY_READ) },
    async (_request, reply) => {
      const locations = await prisma.inventoryLocation.findMany({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        select: { id: true, code: true, name: true, isDefault: true },
      });

      return reply.status(200).send({ locations });
    },
  );

  return Promise.resolve();
}
