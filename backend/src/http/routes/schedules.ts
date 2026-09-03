/**
 * Recurring schedule routes.
 *
 * Customer routes derive the profile from the session and pass it as the
 * ownership scope; admin routes pass `null`, which means "no ownership scope"
 * and is reachable only behind a permission check. Both call the same service,
 * so the rules cannot drift between the two surfaces.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ErrorCode, forbidden, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { Permission } from '../../domain/permissions.js';
import { env } from '../../config/env.js';
import { prisma } from '../../infra/prisma.js';
import {
  cancelSchedule,
  createSchedule,
  pauseSchedule,
  resumeSchedule,
  scheduleSummary,
  updateSchedule,
} from '../../modules/recurring/schedule.service.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

const itemSchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
  quantity: z.number().int().min(1).max(1_000_000),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(128),
  frequency: z.enum(['EVERY_N_DAYS', 'WEEKLY', 'MONTHLY']),
  intervalDays: z.number().int().min(1).max(365).nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  timezone: z.string().max(64).optional(),
  runAtMinute: z.number().int().min(0).max(1439).optional(),
  // Calendar dates, not instants: a schedule starts on a day in the customer's
  // own zone, which is what the timezone field then interprets.
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.'),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.')
    .nullable()
    .optional(),
  maxOccurrences: z.number().int().min(1).max(10_000).nullable().optional(),
  paymentMode: z.enum(['AUTO_PAY', 'PAYMENT_LINK']),
  mandateReference: z.string().max(128).nullable().optional(),
  payerEmail: z.string().trim().max(320).email().nullable().optional(),
  shippingAddressId: z.string().length(26),
  billingAddressId: z.string().length(26).optional(),
  shippingMethodCode: z.string().max(32).nullable().optional(),
  items: z.array(itemSchema).min(1).max(50),
  consentAccepted: z.boolean(),
  consentVersion: z.string().max(32).optional(),
  maxFailures: z.number().int().min(1).max(10).optional(),
  repriceApprovalThresholdMinor: z
    .string()
    .regex(/^\d+$/, 'Expected whole minor units.')
    .nullable()
    .optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  intervalDays: z.number().int().min(1).max(365).nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  runAtMinute: z.number().int().min(0).max(1439).optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  maxOccurrences: z.number().int().min(1).max(10_000).nullable().optional(),
  shippingAddressId: z.string().length(26).optional(),
  billingAddressId: z.string().length(26).optional(),
  payerEmail: z.string().trim().max(320).email().nullable().optional(),
  items: z.array(itemSchema).min(1).max(50).optional(),
});

type ScheduleRow = Awaited<ReturnType<typeof prisma.recurringSchedule.findFirstOrThrow>>;

function serialiseSchedule(
  schedule: ScheduleRow & {
    items?: { productId: string; variantId: string | null; quantity: number }[];
    _count?: { occurrences: number };
  },
): Record<string, unknown> {
  return {
    id: schedule.id,
    name: schedule.name,
    status: schedule.status,
    summary: scheduleSummary(schedule),
    frequency: schedule.frequency,
    intervalDays: schedule.intervalDays,
    weekday: schedule.weekday,
    monthDay: schedule.monthDay,
    timezone: schedule.timezone,
    runAtMinute: schedule.runAtMinute,
    startDate: schedule.startDate.toISOString().slice(0, 10),
    endDate: schedule.endDate?.toISOString().slice(0, 10) ?? null,
    maxOccurrences: schedule.maxOccurrences,
    occurrenceCount: schedule.occurrenceCount,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    paymentMode: schedule.paymentMode,
    payerEmail: schedule.payerEmail,
    // The mandate reference itself is a provider credential; only its presence
    // is reported.
    hasMandate: (schedule.mandateReference ?? '').length > 0,
    consentAcceptedAt: schedule.consentAcceptedAt.toISOString(),
    consentVersion: schedule.consentVersion,
    failureCount: schedule.failureCount,
    maxFailures: schedule.maxFailures,
    pausedReason: schedule.pausedReason,
    cancelReason: schedule.cancelReason,
    itemCount: schedule.items?.length ?? 0,
    occurrenceRecordCount: schedule._count?.occurrences ?? 0,
  };
}

// --- Customer routes -------------------------------------------------------

export function registerCustomerScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const query = z
      .object({
        status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED', 'FAILED']).optional(),
      })
      .parse(request.query);

    const schedules = await prisma.recurringSchedule.findMany({
      where: {
        customerProfileId: auth.customerProfileId ?? '',
        ...(query.status !== undefined ? { status: query.status } : {}),
      },
      orderBy: [{ status: 'asc' }, { nextRunAt: 'asc' }, { id: 'desc' }],
      include: { items: true, _count: { select: { occurrences: true } } },
    });

    return reply.status(200).send({ schedules: schedules.map(serialiseSchedule) });
  });

  app.get('/:id', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const schedule = await prisma.recurringSchedule.findFirst({
      // The ownership check IS the where clause.
      where: { id, customerProfileId: auth.customerProfileId ?? '' },
      include: {
        items: { include: { product: { select: { name: true, sku: true, slug: true } } } },
        occurrences: { orderBy: { plannedRunAt: 'desc' }, take: 20 },
        shippingAddress: true,
        billingAddress: true,
        _count: { select: { occurrences: true } },
      },
    });

    if (schedule === null) throw notFound('Schedule');

    const business = await prisma.businessProfile.findFirst({ select: { currency: true } });
    const currency = business?.currency ?? 'INR';

    return reply.status(200).send({
      schedule: {
        ...serialiseSchedule(schedule),
        items: schedule.items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          name: item.product.name,
          sku: item.product.sku,
          slug: item.product.slug,
          quantity: item.quantity,
        })),
        shippingAddress: schedule.shippingAddress,
        billingAddress: schedule.billingAddress,
        occurrences: schedule.occurrences.map((occurrence) => ({
          plannedRunAt: occurrence.plannedRunAt.toISOString(),
          status: occurrence.status,
          orderId: null,
          total:
            occurrence.actualTotalMinor === null
              ? null
              : serialiseMoney(occurrence.actualTotalMinor, currency),
          failureMessage: occurrence.failureMessage,
          skipReason: occurrence.skipReason,
          attemptCount: occurrence.attemptCount,
        })),
      },
    });
  });

  app.post(
    '/',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      if (!env.FEATURE_RECURRING_ORDERS) {
        throw forbidden(
          ErrorCode.FEATURE_DISABLED,
          'Repeat purchases are not enabled for this store.',
        );
      }

      const auth = currentUser(request);
      const body = createSchema.parse(request.body);

      const created = await createSchedule(
        { ...body, customerProfileId: auth.customerProfileId ?? '' },
        {
          userId: auth.id,
          email: auth.email,
          type: 'CUSTOMER',
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
      );

      return reply.status(201).send({
        ...created,
        nextRunAt: created.nextRunAt?.toISOString() ?? null,
      });
    },
  );

  app.patch('/:id', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);
    const body = updateSchema.parse(request.body);

    const result = await updateSchedule(
      id,
      body,
      {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        correlationId: request.correlationId,
      },
      auth.customerProfileId ?? '',
    );

    return reply.status(200).send({ updated: true, nextRunAt: result.nextRunAt?.toISOString() ?? null });
  });

  app.post('/:id/pause', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().max(512).optional() }).parse(request.body ?? {});

    await pauseSchedule(
      id,
      {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        correlationId: request.correlationId,
      },
      auth.customerProfileId ?? '',
      body.reason,
    );

    return reply.status(200).send({ status: 'PAUSED' });
  });

  app.post('/:id/resume', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const result = await resumeSchedule(
      id,
      {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        correlationId: request.correlationId,
      },
      auth.customerProfileId ?? '',
    );

    return reply
      .status(200)
      .send({ status: 'ACTIVE', nextRunAt: result.nextRunAt?.toISOString() ?? null });
  });

  /** Cancels FUTURE runs only. Completed orders keep their own lifecycle. */
  app.delete('/:id', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().max(512).optional() }).parse(request.body ?? {});

    await cancelSchedule(
      id,
      {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        correlationId: request.correlationId,
      },
      auth.customerProfileId ?? '',
      body.reason,
    );

    return reply.status(200).send({ status: 'CANCELLED', futureRunsOnly: true });
  });

  return Promise.resolve();
}

// --- Admin routes ----------------------------------------------------------

export function registerAdminScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/schedules',
    { preHandler: requireAdmin(Permission.SCHEDULE_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED', 'FAILED']).optional(),
          customerProfileId: z.string().length(26).optional(),
          /** Schedules due within the next N hours - the operations view. */
          dueWithinHours: z.coerce.number().int().min(1).max(720).optional(),
        })
        .parse(request.query);

      const where = {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.customerProfileId !== undefined
          ? { customerProfileId: query.customerProfileId }
          : {}),
        ...(query.dueWithinHours !== undefined
          ? {
              nextRunAt: {
                not: null,
                lte: new Date(Date.now() + query.dueWithinHours * 3_600_000),
              },
            }
          : {}),
      };

      const [rows, total] = await Promise.all([
        prisma.recurringSchedule.findMany({
          where,
          orderBy: [{ nextRunAt: 'asc' }, { id: 'desc' }],
          skip: (query.page - 1) * query.limit,
          take: query.limit,
          include: {
            items: true,
            _count: { select: { occurrences: true } },
            customerProfile: { select: { id: true, fullName: true, organization: true } },
          },
        }),
        prisma.recurringSchedule.count({ where }),
      ]);

      return reply.status(200).send({
        schedules: rows.map((row) => ({
          ...serialiseSchedule(row),
          customer: row.customerProfile,
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

  app.get(
    '/schedules/:id',
    { preHandler: requireAdmin(Permission.SCHEDULE_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const schedule = await prisma.recurringSchedule.findUnique({
        where: { id },
        include: {
          items: { include: { product: { select: { name: true, sku: true } } } },
          occurrences: { orderBy: { plannedRunAt: 'desc' }, take: 50, include: { order: true } },
          customerProfile: { include: { user: { select: { email: true, status: true } } } },
          shippingAddress: true,
          billingAddress: true,
          _count: { select: { occurrences: true } },
        },
      });

      if (schedule === null) throw notFound('Schedule');

      const business = await prisma.businessProfile.findFirst({ select: { currency: true } });
      const currency = business?.currency ?? 'INR';

      return reply.status(200).send({
        schedule: {
          ...serialiseSchedule(schedule),
          customer: {
            id: schedule.customerProfile.id,
            fullName: schedule.customerProfile.fullName,
            organization: schedule.customerProfile.organization,
            email: schedule.customerProfile.user.email,
            status: schedule.customerProfile.user.status,
          },
          items: schedule.items.map((item) => ({
            productId: item.productId,
            name: item.product.name,
            sku: item.product.sku,
            quantity: item.quantity,
          })),
          shippingAddress: schedule.shippingAddress,
          billingAddress: schedule.billingAddress,
          // Each occurrence with its linked order. There is deliberately no
          // "run now" action: a manual trigger is the obvious route to a
          // duplicate charge, and the engine already retries on its own.
          occurrences: schedule.occurrences.map((occurrence) => ({
            id: occurrence.id,
            plannedRunAt: occurrence.plannedRunAt.toISOString(),
            status: occurrence.status,
            attemptCount: occurrence.attemptCount,
            nextRetryAt: occurrence.nextRetryAt?.toISOString() ?? null,
            failureCode: occurrence.failureCode,
            failureMessage: occurrence.failureMessage,
            skipReason: occurrence.skipReason,
            order:
              occurrence.order === null
                ? null
                : {
                    id: occurrence.order.id,
                    orderNumber: occurrence.order.orderNumber,
                    status: occurrence.order.status,
                    total: serialiseMoney(occurrence.order.grandTotalMinor, currency),
                  },
          })),
        },
      });
    },
  );

  app.post(
    '/schedules/:id/pause',
    { preHandler: requireAdmin(Permission.SCHEDULE_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ reason: z.string().max(512).optional() }).parse(request.body ?? {});
      const auth = currentUser(request);

      await pauseSchedule(
        id,
        {
          userId: auth.id,
          email: auth.email,
          type: 'ADMIN',
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        // No ownership scope: reachable only behind schedule.write.
        null,
        body.reason,
      );

      return reply.status(200).send({ status: 'PAUSED' });
    },
  );

  app.post(
    '/schedules/:id/resume',
    { preHandler: requireAdmin(Permission.SCHEDULE_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const auth = currentUser(request);

      const result = await resumeSchedule(
        id,
        {
          userId: auth.id,
          email: auth.email,
          type: 'ADMIN',
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        null,
      );

      return reply
        .status(200)
        .send({ status: 'ACTIVE', nextRunAt: result.nextRunAt?.toISOString() ?? null });
    },
  );

  app.delete(
    '/schedules/:id',
    { preHandler: requireAdmin(Permission.SCHEDULE_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z.object({ reason: z.string().max(512).optional() }).parse(request.body ?? {});
      const auth = currentUser(request);

      await cancelSchedule(
        id,
        {
          userId: auth.id,
          email: auth.email,
          type: 'ADMIN',
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
        null,
        body.reason,
      );

      return reply.status(200).send({ status: 'CANCELLED', futureRunsOnly: true });
    },
  );

  return Promise.resolve();
}
