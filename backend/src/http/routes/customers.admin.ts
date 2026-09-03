/**
 * Admin customer management.
 *
 * Nothing here ever returns or accepts a password. Onboarding is invitation
 * only, recovery is a reset link - an administrator has no route by which they
 * could learn a customer's credential.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { Permission } from '../../domain/permissions.js';
import { prisma } from '../../infra/prisma.js';
import {
  addAddress,
  archiveAddress,
  createCustomer,
  getCustomer,
  listCustomers,
  resendInvitation,
  setCustomerStatus,
  updateAddress,
  updateCustomer,
  updatePurchasingLimits,
} from '../../modules/customers/customer.service.js';
import { getSpendSummary } from '../../modules/customers/limits.service.js';
import {
  buildTokenUrl,
  requestPasswordReset,
} from '../../modules/identity/token.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../../modules/notifications/notification.service.js';
import { currentUser, requireAdmin } from '../plugins/auth.js';

const minorUnits = z
  .string()
  .regex(/^\d+$/, 'Expected whole minor units, e.g. "500000".')
  .nullable();

const limitsSchema = z.object({
  perOrderMinMinor: minorUnits.optional(),
  perOrderMaxMinor: minorUnits.optional(),
  monthlySpendCapMinor: minorUnits.optional(),
  requiresOrderApproval: z.boolean().optional(),
  approvalThresholdMinor: minorUnits.optional(),
});

const addressSchema = z.object({
  kind: z.enum(['BILLING', 'SHIPPING', 'BOTH']).optional(),
  label: z.string().max(64).nullable().optional(),
  contactName: z.string().trim().min(1).max(255),
  contactPhone: z.string().trim().min(1).max(32),
  line1: z.string().trim().min(1).max(255),
  line2: z.string().max(255).nullable().optional(),
  city: z.string().trim().min(1).max(128),
  state: z.string().trim().min(1).max(128),
  postalCode: z.string().trim().min(1).max(16),
  // ISO-3166-1 alpha-2, so it matches the CHAR(2) column.
  country: z.string().trim().length(2),
  isDefaultBilling: z.boolean().optional(),
  isDefaultShipping: z.boolean().optional(),
});

const createCustomerSchema = z.object({
  email: z.string().trim().min(1).max(320).email('Enter a valid email address.'),
  fullName: z.string().trim().min(1).max(255),
  organization: z.string().max(255).nullable().optional(),
  department: z.string().max(128).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  gstin: z.string().max(32).nullable().optional(),
  customerCode: z.string().max(32).nullable().optional(),
  internalNotes: z.string().max(20_000).nullable().optional(),
  limits: limitsSchema.optional(),
  addresses: z.array(addressSchema).max(20).optional(),
  sendInvitation: z.boolean().optional(),
});

const idParam = z.object({ id: z.string().length(26) });

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

export function registerAdminCustomerRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/customers',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const query = z
        .object({
          page: z.coerce.number().int().min(1).max(10_000).default(1),
          limit: z.coerce.number().int().min(1).max(100).default(25),
          q: z.string().trim().max(120).optional(),
          status: z
            .enum(['PENDING_INVITATION', 'PENDING_APPROVAL', 'ACTIVE', 'DEACTIVATED'])
            .optional(),
          organization: z.string().trim().max(255).optional(),
        })
        .parse(request.query);

      const result = await listCustomers(query);
      return reply.status(200).send(result);
    },
  );

  app.get(
    '/customers/:id',
    { preHandler: requireAdmin(Permission.CUSTOMER_READ) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const [customer, business] = await Promise.all([
        getCustomer(id),
        prisma.businessProfile.findFirst({ select: { currency: true } }),
      ]);

      const spend = await getSpendSummary(id, business?.currency ?? 'INR');
      return reply.status(200).send({ customer, spend });
    },
  );

  app.post(
    '/customers',
    { preHandler: requireAdmin(Permission.CUSTOMER_WRITE, Permission.CUSTOMER_INVITE) },
    async (request, reply) => {
      const body = createCustomerSchema.parse(request.body);
      const created = await createCustomer(body, actorFrom(request));
      return reply.status(201).send(created);
    },
  );

  app.patch(
    '/customers/:id',
    { preHandler: requireAdmin(Permission.CUSTOMER_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = createCustomerSchema
        .pick({
          fullName: true,
          organization: true,
          department: true,
          phone: true,
          gstin: true,
          customerCode: true,
          internalNotes: true,
        })
        .partial()
        .parse(request.body);

      await updateCustomer(id, body, actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  /** Limits are a financial control, so they need their own permission. */
  app.patch(
    '/customers/:id/limits',
    { preHandler: requireAdmin(Permission.CUSTOMER_LIMITS_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = limitsSchema.parse(request.body);
      await updatePurchasingLimits(id, body, actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  app.patch(
    '/customers/:id/status',
    { preHandler: requireAdmin(Permission.CUSTOMER_STATUS_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = z
        .object({ active: z.boolean(), reason: z.string().max(512).optional() })
        .parse(request.body);

      const result = await setCustomerStatus(id, body.active, actorFrom(request), body.reason);
      return reply.status(200).send({ active: body.active, ...result });
    },
  );

  app.post(
    '/customers/:id/invite',
    {
      preHandler: requireAdmin(Permission.CUSTOMER_INVITE),
      // Tighter than the global limit: each call emails a real person.
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const result = await resendInvitation(id, actorFrom(request));
      return reply.status(200).send({ sent: true, expiresAt: result.expiresAt.toISOString() });
    },
  );

  /**
   * Start a password reset on the customer's behalf.
   *
   * Sends them a link; it never reveals or sets a password. Unlike the public
   * forgot-password route, this one may report that no eligible account exists,
   * because the caller is already an authorised admin looking at that record.
   */
  app.post(
    '/customers/:id/password-reset',
    {
      preHandler: requireAdmin(Permission.CUSTOMER_WRITE),
      config: { rateLimit: { max: 20, timeWindow: '15 minutes' } },
    },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);

      const profile = await prisma.customerProfile.findUnique({
        where: { id },
        include: { user: { select: { email: true } } },
      });

      if (profile === null) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Customer was not found.',
            details: [],
            correlationId: request.correlationId,
          },
        });
      }

      const issued = await requestPasswordReset(profile.user.email, {
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      if (issued === null) {
        return reply.status(409).send({
          error: {
            code: 'ACCOUNT_NOT_ACTIVATED',
            message: 'This account is not active. Send an invitation instead.',
            details: [],
            correlationId: request.correlationId,
          },
        });
      }

      await enqueueNotification({
        eventKey: NotificationEvent.USER_PASSWORD_RESET,
        recipientEmail: issued.email,
        recipientName: profile.fullName,
        variables: {
          resetUrl: buildTokenUrl('PASSWORD_RESET', issued.token, 'CUSTOMER'),
          expiresAt: issued.expiresAt.toISOString(),
        },
        relatedType: 'user',
        relatedId: issued.userId,
        correlationId: request.correlationId,
      });

      await dispatchPendingNotifications();

      return reply.status(200).send({ sent: true, expiresAt: issued.expiresAt.toISOString() });
    },
  );

  // --- Addresses -----------------------------------------------------------

  app.post(
    '/customers/:id/addresses',
    { preHandler: requireAdmin(Permission.CUSTOMER_WRITE) },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = addressSchema.parse(request.body);
      const result = await addAddress(id, body, actorFrom(request));
      return reply.status(201).send(result);
    },
  );

  app.patch(
    '/customers/:id/addresses/:addressId',
    { preHandler: requireAdmin(Permission.CUSTOMER_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), addressId: z.string().length(26) })
        .parse(request.params);
      const body = addressSchema.partial().parse(request.body);

      await updateAddress(params.id, params.addressId, body, actorFrom(request));
      return reply.status(200).send({ updated: true });
    },
  );

  app.delete(
    '/customers/:id/addresses/:addressId',
    { preHandler: requireAdmin(Permission.CUSTOMER_WRITE) },
    async (request, reply) => {
      const params = z
        .object({ id: z.string().length(26), addressId: z.string().length(26) })
        .parse(request.params);

      await archiveAddress(params.id, params.addressId);
      return reply.status(200).send({ archived: true });
    },
  );

  return Promise.resolve();
}
