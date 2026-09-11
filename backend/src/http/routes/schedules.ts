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
  VISIBLE_TO_CUSTOMER,
  activateSchedule,
  cancelOccurrence,
  cancelSchedule,
  createSchedule,
  editableUntil,
  hideSchedule,
  pauseSchedule,
  resumeSchedule,
  scheduleSummary,
  skipNextOccurrence,
  skipOccurrence,
  updateSchedule,
} from '../../modules/recurring/schedule.service.js';
import {
  MAX_LIST_ESTIMATES,
  estimateSchedule,
  estimateSchedules,
} from '../../modules/recurring/schedule-estimate.service.js';
import { deliveryNoticeFloor } from '../../modules/recurring/schedule-notice.js';
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
  /**
   * The wall clock the plan runs on.
   *
   * Editable, unlike at creation where it defaults to the store's own zone. A
   * standing order handed from a buyer in Kolkata to a colleague in Rotterdam
   * otherwise keeps firing at the wrong city's 06:00, and "cancel it and build
   * another" is not an answer when the alternative is one field. The service
   * re-dates every upcoming delivery when it changes.
   */
  timezone: z.string().trim().max(64).optional(),
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

  /**
   * The earliest date a first delivery may be asked for.
   *
   * The calendar on the builder and on the plan editor draws its floor from
   * this. It could not be computed in the browser: half of the answer is the
   * notice period, which is a deployment setting, and the other half is what
   * the chosen warehouse can actually reach, which needs the lanes. A
   * storefront that guessed either would grey out the wrong fortnight.
   *
   * A GET with the configuration in the query rather than a POST, because it
   * writes nothing and the screen re-asks it every time the address or the
   * warehouse changes - which is exactly the recalculation the rule requires.
   *
   * It answers a date; it does not enforce one. `createSchedule` and
   * `updateSchedule` refuse a date inside the window whatever the browser
   * did with this, which is what makes bypassing the picker pointless rather
   * than profitable.
   */
  app.get('/delivery-window', async (request, reply) => {
    const auth = currentUser(request);

    const query = z
      .object({
        shippingAddressId: z.string().length(26),
        timezone: z.string().trim().max(64).optional(),
        fulfilmentRule: z.enum(['AUTO', 'FIXED_LOCATION']).optional(),
        inventoryLocationId: z.string().length(26).nullable().optional(),
      })
      .parse(request.query);

    const business = await prisma.businessProfile.findFirst({ select: { timezone: true } });

    const floor = await deliveryNoticeFloor({
      scheduleTimezone: query.timezone ?? business?.timezone ?? env.DEFAULT_TIMEZONE,
      shippingAddressId: query.shippingAddressId,
      customerProfileId: auth.customerProfileId ?? '',
      fulfilmentRule: query.fulfilmentRule ?? 'AUTO',
      inventoryLocationId: query.inventoryLocationId ?? null,
    });

    // No caching. The floor moves at midnight in the customer's own zone, and
    // a held answer is a calendar offering a day that has just closed.
    return reply.header('cache-control', 'no-store').status(200).send(floor);
  });

  app.get('/', async (request, reply) => {
    const auth = currentUser(request);
    const query = z
      .object({
        status: planStatusEnum.optional(),
        /** ONE_TIME for Buy Later, RECURRING for subscriptions. */
        kind: z.enum(['ONE_TIME', 'RECURRING']).optional(),
        /**
         * Price every plan in the answer.
         *
         * Opt-in, because it is the expensive half of this endpoint: each
         * estimate is a small round of indexed reads through `quoteSchedule`,
         * and the header's badge does not need any of them. The screen that
         * shows a column of cards with amounts on them asks for it.
         */
        estimate: z.enum(['true', 'false']).optional(),
      })
      .parse(request.query);

    const schedules = await prisma.recurringSchedule.findMany({
      where: {
        customerProfileId: auth.customerProfileId ?? '',
        // What the customer cleared off their own list. See `hideSchedule`.
        ...VISIBLE_TO_CUSTOMER,
        ...(query.status !== undefined ? { status: query.status } : {}),
        ...(query.kind !== undefined ? { kind: query.kind } : {}),
      },
      orderBy: [{ status: 'asc' }, { nextRunAt: 'asc' }, { id: 'desc' }],
      include: { items: true, _count: { select: { occurrences: true } } },
    });

    const estimates =
      query.estimate === 'true'
        ? await estimateSchedules(schedules, auth.customerProfileId ?? '')
        : new Map<string, Awaited<ReturnType<typeof estimateSchedule>>>();

    return reply.status(200).send({
      schedules: schedules.map((schedule) => {
        const estimate = estimates.get(schedule.id);

        return {
          ...serialiseSchedule(schedule),
          /**
           * What this delivery would cost if it went out now.
           *
           * Absent unless it was asked for, and null where it could not be
           * priced - so a card can render a dash rather than a confident
           * 0.00, which would read as "this delivery is free".
           */
          ...(query.estimate === 'true'
            ? {
                estimatedTotal: estimate?.estimatedTotal ?? null,
                estimateOk: estimate?.ok ?? false,
              }
            : {}),
        };
      }),
      /** How many were priced, so a long list can say why the rest are dashes. */
      ...(query.estimate === 'true'
        ? { estimatedCount: estimates.size, estimateLimit: MAX_LIST_ESTIMATES }
        : {}),
    });
  });

  app.get('/:id', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const schedule = await prisma.recurringSchedule.findFirst({
      // The ownership check IS the where clause, and so is the visibility one:
      // a plan the customer removed answers 404 here rather than opening from
      // a stale link.
      where: { id, customerProfileId: auth.customerProfileId ?? '', ...VISIBLE_TO_CUSTOMER },
      include: {
        items: {
          include: {
            product: {
              select: {
                name: true,
                sku: true,
                slug: true,
                // The purchasing rules, because the screen that edits a
                // schedule's quantities cannot work without them. Left out,
                // the stepper has to assume a minimum of one and a step of
                // one - and a customer would save three of a product sold in
                // tens, only to be told so by the next occurrence.
                minOrderQty: true,
                maxOrderQty: true,
                qtyIncrement: true,
              },
            },
          },
        },
        occurrences: {
          orderBy: { plannedRunAt: 'desc' },
          take: 20,
          // The order each cycle produced, where it produced one. Without the
          // join the history could show a delivery with no way to open the
          // order it became, which is the first thing a buyer looks for.
          include: { order: { select: { id: true, orderNumber: true, status: true } } },
        },
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
          /**
           * Named `purchaseRules` to match the shape the catalogue sends, so
           * the storefront's quantity control takes the same object from a
           * schedule line as it does from a product page.
           */
          purchaseRules: {
            minOrderQty: item.product.minOrderQty,
            maxOrderQty: item.product.maxOrderQty,
            qtyIncrement: item.product.qtyIncrement,
          },
        })),
        shippingAddress: schedule.shippingAddress,
        billingAddress: schedule.billingAddress,
        occurrences: schedule.occurrences.map((occurrence) => ({
          id: occurrence.id,
          plannedRunAt: occurrence.plannedRunAt.toISOString(),
          status: occurrence.status,
          orderId: occurrence.order?.id ?? null,
          orderNumber: occurrence.order?.orderNumber ?? null,
          total:
            occurrence.actualTotalMinor === null
              ? null
              : serialiseMoney(occurrence.actualTotalMinor, currency),
          failureMessage: occurrence.failureMessage,
          skipReason: occurrence.skipReason,
          skippedByUser: occurrence.skippedByUser,
          attemptCount: occurrence.attemptCount,
          /** True only while the customer can still skip or re-date this one. */
          canModify: occurrence.status === 'SCHEDULED',
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

  /**
   * What this schedule would cost if it ran now.
   *
   * A GET, and it writes nothing: the editing screen reads it after every
   * change so the customer sees the effect of adding a line before they apply
   * anything. Priced by `quoteSchedule`, the same function the worker uses
   * weeks later - which is what makes the figure on the screen and the figure
   * on the card statement one number rather than two.
   *
   * Problems come back rather than throwing. "This product is out of stock"
   * is something the customer needs told on this screen, not a 409 that
   * empties it.
   */
  app.get('/:id/estimate', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    const estimate = await estimateSchedule(id, auth.customerProfileId ?? '');

    return reply.status(200).send({ estimate });
  });

  /**
   * Take a finished plan off my list.
   *
   * Separate from `DELETE /:id`, which cancels — two different acts that a
   * customer means differently. Cancelling stops future deliveries; this puts
   * a plan that has already stopped out of sight. Refused on anything that has
   * not stopped, because hiding a live authority to charge would mean money
   * leaving an account for an arrangement nobody can see.
   *
   * A POST rather than a DELETE: nothing is deleted. The row, its consent
   * record, its occurrences and its orders all stay exactly where they are,
   * and staff still read them.
   */
  app.post('/:id/hide', async (request, reply) => {
    const auth = currentUser(request);
    const { id } = idParam.parse(request.params);

    await hideSchedule(
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

    return reply.status(200).send({ hidden: true });
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

    // Ownership and visibility, both as where clauses.
    const schedule = await prisma.recurringSchedule.findFirst({
      where: { id, customerProfileId: auth.customerProfileId ?? '', ...VISIBLE_TO_CUSTOMER },
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
