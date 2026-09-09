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
  activateSchedule,
  cancelOccurrence,
  cancelSchedule,
  createSchedule,
  editableUntil,
  pauseSchedule,
  resumeSchedule,
  scheduleSummary,
  skipNextOccurrence,
  skipOccurrence,
  updateSchedule,
} from '../../modules/recurring/schedule.service.js';
import {
  convertCartAfterActivation,
  createCartSchedule,
  previewCartSchedule,
} from '../../modules/recurring/cart-schedule.service.js';
import {
  listAbandonedErpPushes,
  retryAbandonedErpPush,
} from '../../modules/integrations/erp-order.service.js';
import { currentUser, requireAdmin, requireCustomer } from '../plugins/auth.js';

const idParam = z.object({ id: z.string().length(26) });

const itemSchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
  quantity: z.number().int().min(1).max(1_000_000),
  /**
   * The one product the customer authorises as a stand-in for this line.
   *
   * Only ever used when the plan's substitutionPolicy is SAVED_PREFERENCE.
   * There is no second choice and no category fallback: a substitution the
   * customer did not name is one they did not authorise.
   */
  substituteProductId: z.string().length(26).nullable().optional(),
  substituteVariantId: z.string().length(26).nullable().optional(),
});

/**
 * Every frequency the API accepts.
 *
 * ONE_TIME is Buy Later. BIWEEKLY is a first-class option rather than
 * EVERY_N_DAYS with 14, because the two behave differently when a delivery is
 * skipped - see the enum in the schema.
 */
const frequencyEnum = z.enum([
  'EVERY_N_DAYS',
  'WEEKLY',
  'BIWEEKLY',
  'MONTHLY',
  // Every N calendar months: two-monthly, quarterly, half-yearly, yearly. A
  // first-class frequency rather than EVERY_N_DAYS with 60, 90, 180 or 365,
  // because a quarter is not ninety days and counting one in days walks a
  // standing order into the wrong month.
  'EVERY_N_MONTHS',
  'ONE_TIME',
]);

const planStatusEnum = z.enum([
  'DRAFT',
  'ACTIVE',
  'PAUSED',
  'CANCELLED',
  'COMPLETED',
  'FAILED',
]);

/** The configuration both the review screen and creation-from-cart accept. */
const cartScheduleSchema = z.object({
  frequency: frequencyEnum,
  intervalDays: z.number().int().min(1).max(365).nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  /** EVERY_N_MONTHS. Two and up; one would be MONTHLY under another name. */
  intervalMonths: z.number().int().min(2).max(24).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD.'),
  runAtMinute: z.number().int().min(0).max(1439).optional(),
  timezone: z.string().max(64).optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  maxOccurrences: z.number().int().min(1).max(10_000).nullable().optional(),
  shippingAddressId: z.string().length(26),
  billingAddressId: z.string().length(26).optional(),
  shippingMethodCode: z.string().max(32).nullable().optional(),
  paymentMode: z.enum(['AUTO_PAY', 'PAYMENT_LINK']),
  paymentMethodId: z.string().length(26).nullable().optional(),
  payerEmail: z.string().trim().max(320).email().nullable().optional(),
  substitutionPolicy: z.enum(['NEVER', 'SAVED_PREFERENCE']).optional(),
  fulfilmentRule: z.enum(['AUTO', 'FIXED_LOCATION']).optional(),
  inventoryLocationId: z.string().length(26).nullable().optional(),
  /** Per-cart-item quantity overrides, keyed by cart item id. */
  quantities: z.record(z.string().length(26), z.number().int().min(1).max(1_000_000)).optional(),
  substitutes: z
    .record(
      z.string().length(26),
      z.object({
        productId: z.string().length(26),
        variantId: z.string().length(26).nullable().optional(),
      }),
    )
    .optional(),
  name: z.string().trim().min(1).max(128).optional(),
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(128),
  frequency: frequencyEnum,
  intervalDays: z.number().int().min(1).max(365).nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  /** EVERY_N_MONTHS. Two and up; one would be MONTHLY under another name. */
  intervalMonths: z.number().int().min(2).max(24).nullable().optional(),
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
  paymentMethodId: z.string().length(26).nullable().optional(),
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
  priceTolerancePercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Expected a percentage, e.g. "5" or "2.50".')
    .nullable()
    .optional(),
  priceToleranceMinor: z
    .string()
    .regex(/^\d+$/, 'Expected whole minor units.')
    .nullable()
    .optional(),
  editCutoffMinutes: z.number().int().min(0).max(20_160).optional(),
  substitutionPolicy: z.enum(['NEVER', 'SAVED_PREFERENCE']).optional(),
  fulfilmentRule: z.enum(['AUTO', 'FIXED_LOCATION']).optional(),
  inventoryLocationId: z.string().length(26).nullable().optional(),
  asDraft: z.boolean().optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  frequency: frequencyEnum.optional(),
  intervalDays: z.number().int().min(1).max(365).nullable().optional(),
  weekday: z.number().int().min(1).max(7).nullable().optional(),
  monthDay: z.number().int().min(1).max(31).nullable().optional(),
  /** EVERY_N_MONTHS. Two and up; one would be MONTHLY under another name. */
  intervalMonths: z.number().int().min(2).max(24).nullable().optional(),
  runAtMinute: z.number().int().min(0).max(1439).optional(),
  /** Re-date a Buy Later, or move a subscription's anchor. */
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  endDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  maxOccurrences: z.number().int().min(1).max(10_000).nullable().optional(),
  shippingAddressId: z.string().length(26).optional(),
  billingAddressId: z.string().length(26).optional(),
  shippingMethodCode: z.string().max(32).nullable().optional(),
  payerEmail: z.string().trim().max(320).email().nullable().optional(),
  paymentMethodId: z.string().length(26).nullable().optional(),
  items: z.array(itemSchema).min(1).max(50).optional(),
  substitutionPolicy: z.enum(['NEVER', 'SAVED_PREFERENCE']).optional(),
  priceTolerancePercent: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,2})?$/)
    .nullable()
    .optional(),
  priceToleranceMinor: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional(),
  repriceApprovalThresholdMinor: z
    .string()
    .regex(/^\d+$/)
    .nullable()
    .optional(),
  fulfilmentRule: z.enum(['AUTO', 'FIXED_LOCATION']).optional(),
  inventoryLocationId: z.string().length(26).nullable().optional(),
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
    intervalMonths: schedule.intervalMonths,
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

    // --- Added with Buy Later and Subscribe & Reorder ---
    kind: schedule.kind,
    runOnceAt: schedule.runOnceAt?.toISOString() ?? null,
    activatedAt: schedule.activatedAt?.toISOString() ?? null,
    completedAt: schedule.completedAt?.toISOString() ?? null,
    substitutionPolicy: schedule.substitutionPolicy,
    fulfilmentRule: schedule.fulfilmentRule,
    inventoryLocationId: schedule.inventoryLocationId,
    editCutoffMinutes: schedule.editCutoffMinutes,
    /**
     * The moment this plan stops accepting changes for its next delivery.
     *
     * Returned so the screen can say what it will refuse instead of offering a
     * button that then errors.
     */
    editableUntil:
      editableUntil({
        nextRunAt: schedule.nextRunAt,
        editCutoffMinutes: schedule.editCutoffMinutes,
      })?.toISOString() ?? null,
    priceTolerancePercent: schedule.priceTolerancePercent?.toString() ?? null,
    priceToleranceMinor: schedule.priceToleranceMinor?.toString() ?? null,
    repriceApprovalThresholdMinor: schedule.repriceApprovalThresholdMinor?.toString() ?? null,
    // Which card, never its provider reference.
    hasStoredPaymentMethod: schedule.paymentMethodId !== null,
  };
}

/** One occurrence, as the customer's screens read it. */
function serialiseOccurrence(
  occurrence: {
    id: string;
    plannedRunAt: Date;
    timezone: string;
    status: string;
    attemptCount: number;
    nextRetryAt: Date | null;
    quotedTotalMinor: bigint | null;
    actualTotalMinor: bigint | null;
    erpOrderReference: string | null;
    skippedByUser: boolean;
    skipReason: string | null;
    failureCode: string | null;
    failureMessage: string | null;
    reminderSentAt: Date | null;
    completedAt: Date | null;
    order?: { id: string; orderNumber: string; status: string } | null;
  },
  currency: string,
): Record<string, unknown> {
  return {
    id: occurrence.id,
    plannedRunAt: occurrence.plannedRunAt.toISOString(),
    timezone: occurrence.timezone,
    status: occurrence.status,
    attemptCount: occurrence.attemptCount,
    nextRetryAt: occurrence.nextRetryAt?.toISOString() ?? null,
    quotedTotal:
      occurrence.quotedTotalMinor === null
        ? null
        : serialiseMoney(occurrence.quotedTotalMinor, currency),
    total:
      occurrence.actualTotalMinor === null
        ? null
        : serialiseMoney(occurrence.actualTotalMinor, currency),
    erpOrderReference: occurrence.erpOrderReference,
    // Both a customer skip and an engine hold end in SKIPPED, and the screens
    // owe a different sentence for each.
    skippedByUser: occurrence.skippedByUser,
    skipReason: occurrence.skipReason,
    failureCode: occurrence.failureCode,
    failureMessage: occurrence.failureMessage,
    reminderSentAt: occurrence.reminderSentAt?.toISOString() ?? null,
    completedAt: occurrence.completedAt?.toISOString() ?? null,
    /** True only while the customer can still skip or re-date this delivery. */
    canModify: occurrence.status === 'SCHEDULED',
    order:
      occurrence.order === null || occurrence.order === undefined
        ? null
        : {
            id: occurrence.order.id,
            orderNumber: occurrence.order.orderNumber,
            status: occurrence.order.status,
          },
  };
}

// --- Customer routes -------------------------------------------------------

export function registerCustomerScheduleRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireCustomer);

  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const query = z
      .object({
        status: planStatusEnum.optional(),
        /** ONE_TIME for Buy Later, RECURRING for subscriptions. */
        kind: z.enum(['ONE_TIME', 'RECURRING']).optional(),
      })
      .parse(request.query);

    const schedules = await prisma.recurringSchedule.findMany({
      where: {
        customerProfileId: auth.customerProfileId ?? '',
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
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

  /**
   * The review screen.
   *
   * Prices the current cart under a proposed schedule and answers with
   * everything the customer has to read before authorising anything: items,
   * quantities, price, discount, tax, delivery, total, address, payment
   * method, frequency and the next processing date.
   *
   * A POST because it takes a whole configuration, and it writes nothing - a
   * customer can adjust and re-preview as often as they like.
   */
  app.post('/preview', async (request, reply) => {
    const auth = currentUser(request);
    const config = cartScheduleSchema.parse(request.body);

    const preview = await previewCartSchedule(auth.customerProfileId ?? '', config);

    return reply.status(200).send({ preview });
  });

  /**
   * Create a DRAFT from the cart.
   *
   * Charges nobody and leaves the cart alone: a draft the customer abandons
   * must not cost them their basket. Activation is a separate request, so the
   * consent recorded against the plan is consent to the numbers they actually
   * read.
   */
  app.post(
    '/from-cart',
    { config: { rateLimit: { max: 30, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const config = cartScheduleSchema.parse(request.body);

      const created = await createCartSchedule(auth.customerProfileId ?? '', config, {
        userId: auth.id,
        email: auth.email,
        type: 'CUSTOMER',
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      return reply.status(201).send({
        scheduleId: created.scheduleId,
        name: created.name,
        status: created.status,
        kind: created.kind,
        summary: created.summary,
        paymentMode: created.paymentMode,
        preview: created.preview,
      });
    },
  );

  /**
   * Activate a draft.
   *
   * The customer's explicit confirmation, and the moment the plan becomes an
   * authority to charge. The cart it was built from is emptied here rather
   * than at draft creation.
   */
  app.post('/:id/activate', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const body = z
      .object({
        consentAccepted: z.boolean(),
        consentVersion: z.string().max(32).optional(),
      })
      .parse(request.body);

    const result = await activateSchedule(
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

    const cart = await convertCartAfterActivation(auth.customerProfileId ?? '', id);

    return reply.status(200).send({
      status: result.status,
      nextRunAt: result.nextRunAt?.toISOString() ?? null,
      cartCleared: cart.converted,
    });
  });

  /** The deliveries on a plan - past, pending and upcoming. */
  app.get('/:id/occurrences', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).default(50),
        upcomingOnly: z.coerce.boolean().optional(),
      })
      .parse(request.query);

    // The ownership check IS the where clause.
    const schedule = await prisma.recurringSchedule.findFirst({
      where: { id, customerProfileId: auth.customerProfileId ?? '' },
      select: { id: true },
    });

    if (schedule === null) throw notFound('Schedule');

    const occurrences = await prisma.scheduleOccurrence.findMany({
      where: {
        scheduleId: id,
        ...(query.upcomingOnly === true
          ? { status: 'SCHEDULED', plannedRunAt: { gt: new Date() } }
          : {}),
      },
      orderBy: { plannedRunAt: query.upcomingOnly === true ? 'asc' : 'desc' },
      take: query.limit,
      include: { order: { select: { id: true, orderNumber: true, status: true } } },
    });

    const business = await prisma.businessProfile.findFirst({ select: { currency: true } });
    const currency = business?.currency ?? env.DEFAULT_CURRENCY;

    return reply.status(200).send({
      occurrences: occurrences.map((occurrence) => serialiseOccurrence(occurrence, currency)),
    });
  });

  /**
   * Skip the next delivery.
   *
   * The subscription keeps running; only this cycle is withdrawn. Refused once
   * the engine has started preparing it, and refused inside the edit cutoff -
   * both would race the charge.
   */
  app.post('/:id/skip-next', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);
    const body = z.object({ reason: z.string().max(512).optional() }).parse(request.body ?? {});

    const skipped = await skipNextOccurrence(
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

    return reply.status(200).send({
      skipped: true,
      occurrenceId: skipped.occurrenceId,
      plannedRunAt: skipped.plannedRunAt.toISOString(),
    });
  });

  /** Skip one named delivery. */
  app.post('/occurrences/:occurrenceId/skip', async (request, reply) => {
    const auth = currentUser(request);
    const { occurrenceId } = z
      .object({ occurrenceId: z.string().length(26) })
      .parse(request.params);
    const body = z.object({ reason: z.string().max(512).optional() }).parse(request.body ?? {});

    const skipped = await skipOccurrence(
      occurrenceId,
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

    return reply.status(200).send({
      skipped: true,
      scheduleId: skipped.scheduleId,
      plannedRunAt: skipped.plannedRunAt.toISOString(),
    });
  });

  /** Cancel one delivery outright, rather than skipping it. */
  app.delete('/occurrences/:occurrenceId', async (request, reply) => {
    const auth = currentUser(request);
    const { occurrenceId } = z
      .object({ occurrenceId: z.string().length(26) })
      .parse(request.params);
    const body = z.object({ reason: z.string().max(512).optional() }).parse(request.body ?? {});

    await cancelOccurrence(
      occurrenceId,
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

    return reply.status(200).send({ cancelled: true });
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
          status: planStatusEnum.optional(),
          kind: z.enum(['ONE_TIME', 'RECURRING']).optional(),
          customerProfileId: z.string().length(26).optional(),
          /** Schedules due within the next N hours - the operations view. */
          dueWithinHours: z.coerce.number().int().min(1).max(720).optional(),
        })
        .parse(request.query);

      const where = {
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
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

  /**
   * Orders the ERP has refused, and that a person now has to look at.
   *
   * The console's queue for the single worst state in the feature: paid, real,
   * and not in the warehouse system. Every row here is somebody's money.
   */
  app.get(
    '/erp/order-pushes',
    { preHandler: requireAdmin(Permission.INTEGRATION_READ) },
    async (request, reply) => {
      const query = z
        .object({ limit: z.coerce.number().int().min(1).max(200).default(50) })
        .parse(request.query);

      const pushes = await listAbandonedErpPushes(query.limit);

      return reply.status(200).send({ pushes });
    },
  );

  /**
   * Push an abandoned order to the ERP again, by hand.
   *
   * The only way out of ABANDONED, and deliberately manual: an ERP that has
   * refused the same payload eight times will refuse the ninth, so resuming
   * should follow a change somebody made rather than a timer.
   *
   * The idempotency key is NOT regenerated - see the service. A manual retry
   * has to be the same request as the automatic ones, or the ERP could accept
   * it as a second order.
   */
  app.post(
    '/erp/order-pushes/:orderId/retry',
    { preHandler: requireAdmin(Permission.INTEGRATION_WRITE) },
    async (request, reply) => {
      const { orderId } = z.object({ orderId: z.string().length(26) }).parse(request.params);
      const auth = currentUser(request);

      const result = await retryAbandonedErpPush(orderId, {
        userId: auth.id,
        email: auth.email,
      });

      return reply.status(200).send({
        status: result.status,
        erpOrderReference: result.erpOrderReference,
        message: result.message,
      });
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
