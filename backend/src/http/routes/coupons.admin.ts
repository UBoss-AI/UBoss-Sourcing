/**
 * Admin coupon routes.
 *
 * Staff author a percentage discount, narrow it to categories if they want, and
 * set the cart value that unlocks it — once per currency, because a threshold
 * converted between currencies would drift with the exchange rate.
 *
 * The code is generated on create and editable afterwards. Nothing here deletes
 * a coupon: redemptions reference it so an order stays explicable years later,
 * and archiving takes it out of every list while keeping that trail.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serialiseMoney } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import { AuditAction, recordAudit } from '../../modules/audit/audit.service.js';
import {
  archiveCoupon,
  createCoupon,
  findCouponById,
  generateUniqueCode,
  listCoupons,
  updateCoupon,
  type CouponWriteInput,
} from '../../modules/coupons/coupon.service.js';
import { notFound } from '../../domain/errors.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

/** Minor units arrive as a digit string; a JSON number has already lost precision. */
const minorUnits = z
  .string()
  .regex(/^\d+$/, 'Amount must be an integer number of minor units')
  .transform((value) => BigInt(value));

const minimumSchema = z.object({
  currencyCode: z.string().trim().length(3),
  minOrderMinor: minorUnits,
});

const couponBodySchema = z.object({
  code: z.string().trim().max(32).nullable().optional(),
  name: z.string().trim().min(1).max(128),
  description: z.string().trim().max(255).nullable().optional(),
  /** Decimal string, not a number, so 12.5 cannot arrive as 12.499999. */
  discountPercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Discount must look like 10 or 12.50'),
  scope: z.enum(['ALL_PRODUCTS', 'CATEGORIES']),
  categoryIds: z.array(z.string().length(26)).max(100).optional(),
  includeDescendants: z.boolean().optional(),
  minimums: z.array(minimumSchema).min(1).max(20),
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).optional(),
  isPubliclyListed: z.boolean().optional(),
  validFrom: z.coerce.date().nullable().optional(),
  validUntil: z.coerce.date().nullable().optional(),
  usageLimit: z.number().int().min(1).max(1_000_000).nullable().optional(),
  perCustomerLimit: z.number().int().min(1).max(10_000).nullable().optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'DISABLED']).optional(),
  search: z.string().trim().max(64).optional(),
  includeArchived: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
});

const idParam = z.object({ couponId: z.string().length(26) });

type LoadedCoupon = NonNullable<Awaited<ReturnType<typeof findCouponById>>>;

function toView(coupon: LoadedCoupon): Record<string, unknown> {
  return {
    id: coupon.id,
    code: coupon.code,
    name: coupon.name,
    description: coupon.description,
    discountPercent: coupon.discountPercent.toString(),
    scope: coupon.scope,
    status: coupon.status,
    isPubliclyListed: coupon.isPubliclyListed,
    validFrom: coupon.validFrom?.toISOString() ?? null,
    validUntil: coupon.validUntil?.toISOString() ?? null,
    usageLimit: coupon.usageLimit,
    perCustomerLimit: coupon.perCustomerLimit,
    usageCount: coupon.usageCount,
    categoryIds: coupon.categories.map((row) => row.categoryId),
    includeDescendants: coupon.categories[0]?.includeDescendants ?? true,
    minimums: coupon.minimums.map((row) => ({
      currencyCode: row.currencyCode,
      minOrderMinor: row.minOrderMinor.toString(),
      minOrder: serialiseMoney(row.minOrderMinor, row.currencyCode),
    })),
    archivedAt: coupon.archivedAt?.toISOString() ?? null,
    createdAt: coupon.createdAt.toISOString(),
    updatedAt: coupon.updatedAt.toISOString(),
  };
}

function toWriteInput(body: z.infer<typeof couponBodySchema>): CouponWriteInput {
  return {
    ...(body.code !== undefined ? { code: body.code } : {}),
    name: body.name,
    ...(body.description !== undefined ? { description: body.description } : {}),
    discountPercent: body.discountPercent,
    scope: body.scope,
    ...(body.categoryIds !== undefined ? { categoryIds: body.categoryIds } : {}),
    ...(body.includeDescendants !== undefined
      ? { includeDescendants: body.includeDescendants }
      : {}),
    minimums: body.minimums,
    ...(body.status !== undefined ? { status: body.status } : {}),
    ...(body.isPubliclyListed !== undefined ? { isPubliclyListed: body.isPubliclyListed } : {}),
    ...(body.validFrom !== undefined ? { validFrom: body.validFrom } : {}),
    ...(body.validUntil !== undefined ? { validUntil: body.validUntil } : {}),
    ...(body.usageLimit !== undefined ? { usageLimit: body.usageLimit } : {}),
    ...(body.perCustomerLimit !== undefined ? { perCustomerLimit: body.perCustomerLimit } : {}),
  };
}

export function registerAdminCouponRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/coupons',
    { preHandler: requireAdmin(Permission.COUPON_READ) },
    async (request, reply) => {
      const query = listQuerySchema.parse(request.query);

      const result = await listCoupons({
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.search !== undefined ? { search: query.search } : {}),
        ...(query.includeArchived !== undefined ? { includeArchived: query.includeArchived } : {}),
        ...(query.page !== undefined ? { page: query.page } : {}),
        ...(query.pageSize !== undefined ? { pageSize: query.pageSize } : {}),
      });

      return reply.status(200).send({
        coupons: result.rows.map(toView),
        page: result.page,
        pageSize: result.pageSize,
        total: result.total,
      });
    },
  );

  /**
   * A free code, so the form can show one before anything is saved.
   *
   * The unique index remains the real guard - two admins could be handed the
   * same suggestion in the same millisecond - and create returns a conflict if
   * that ever happens.
   */
  app.get(
    '/coupons/suggest-code',
    { preHandler: requireAdmin(Permission.COUPON_WRITE) },
    async (_request, reply) => {
      return reply.status(200).send({ code: await generateUniqueCode() });
    },
  );

  app.get(
    '/coupons/:couponId',
    { preHandler: requireAdmin(Permission.COUPON_READ) },
    async (request, reply) => {
      const { couponId } = idParam.parse(request.params);

      const coupon = await findCouponById(couponId);
      if (coupon === null) throw notFound('Coupon');

      return reply.status(200).send({ coupon: toView(coupon) });
    },
  );

  app.post(
    '/coupons',
    { preHandler: requireAdmin(Permission.COUPON_WRITE) },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = couponBodySchema.parse(request.body);

      const coupon = await createCoupon(toWriteInput(body), auth.id);

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
        action: AuditAction.COUPON_CREATED,
        resourceType: 'coupon',
        resourceId: coupon.id,
        after: {
          code: coupon.code,
          discountPercent: coupon.discountPercent.toString(),
          scope: coupon.scope,
          status: coupon.status,
        },
      });

      return reply.status(201).send({ coupon: toView(coupon) });
    },
  );

  app.put(
    '/coupons/:couponId',
    { preHandler: requireAdmin(Permission.COUPON_WRITE) },
    async (request, reply) => {
      const auth = currentUser(request);
      const { couponId } = idParam.parse(request.params);
      const body = couponBodySchema.parse(request.body);

      const before = await findCouponById(couponId);
      if (before === null) throw notFound('Coupon');

      const coupon = await updateCoupon(couponId, toWriteInput(body), auth.id);

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
        action: AuditAction.COUPON_UPDATED,
        resourceType: 'coupon',
        resourceId: coupon.id,
        before: {
          code: before.code,
          discountPercent: before.discountPercent.toString(),
          status: before.status,
        },
        after: {
          code: coupon.code,
          discountPercent: coupon.discountPercent.toString(),
          status: coupon.status,
        },
      });

      return reply.status(200).send({ coupon: toView(coupon) });
    },
  );

  app.delete(
    '/coupons/:couponId',
    { preHandler: requireAdmin(Permission.COUPON_ARCHIVE) },
    async (request, reply) => {
      const auth = currentUser(request);
      const { couponId } = idParam.parse(request.params);

      await archiveCoupon(couponId, auth.id);

      await recordAudit({
        actorType: 'ADMIN',
        actorUserId: auth.id,
        actorEmail: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
        action: AuditAction.COUPON_ARCHIVED,
        resourceType: 'coupon',
        resourceId: couponId,
      });

      return reply.status(204).send();
    },
  );

  return Promise.resolve();
}
