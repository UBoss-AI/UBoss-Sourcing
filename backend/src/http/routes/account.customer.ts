/**
 * Customer self-service account.
 *
 * Every route derives the profile id from the authenticated session, never from
 * the request. There is no `/account/:id` here on purpose: an endpoint that
 * takes an id is an endpoint someone will eventually forget to ownership-check,
 * and this is the surface where that would expose another customer's data.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../domain/errors.js';
import { prisma } from '../../infra/prisma.js';
import {
  addAddress,
  archiveAddress,
  selfRegistrationEnabled,
  updateAddress,
  updateCustomer,
} from '../../modules/customers/customer.service.js';
import { getSpendSummary } from '../../modules/customers/limits.service.js';
import {
  getCustomerLocale,
  resolveCurrencyFor,
  setCustomerLocale,
} from '../../modules/settings/currency.service.js';
import { currentUser, requireCustomer } from '../plugins/auth.js';

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
  country: z.string().trim().length(2),
  isDefaultBilling: z.boolean().optional(),
  isDefaultShipping: z.boolean().optional(),
});

/**
 * Where the shopper says they are, plus whatever the browser's geolocation
 * resolved to.
 *
 * `detectedCountry` is advisory: it is stored alongside the stated country so
 * a disagreement can be surfaced, never used to override the person's own
 * answer. A browser that refuses the permission simply omits it.
 */
const localeSchema = z.object({
  country: z.string().trim().length(2),
  currency: z.string().trim().length(3).nullable().optional(),
  detectedCountry: z.string().trim().length(2).nullable().optional(),
});

/**
 * A customer may edit their own contact details, and nothing else.
 *
 * `customerCode`, `internalNotes` and every purchasing limit are deliberately
 * absent - a customer raising their own spending cap is the obvious attack, and
 * omitting the fields from the schema is a stronger guarantee than remembering
 * to strip them later.
 */
const profileUpdateSchema = z.object({
  fullName: z.string().trim().min(1).max(255).optional(),
  organization: z.string().max(255).nullable().optional(),
  department: z.string().max(128).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  gstin: z.string().max(32).nullable().optional(),
});

export function registerCustomerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/profile', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);

    const profile = await prisma.customerProfile.findUnique({
      where: { id: auth.customerProfileId ?? '' },
      include: {
        user: { select: { email: true, status: true, lastLoginAt: true } },
        _count: { select: { orders: true, schedules: true } },
      },
    });

    if (profile === null) throw notFound('Profile');

    // The currency this shopper is actually quoted in, not the business's own.
    // Showing them a cap denominated in a market they are not browsing would
    // be worse than showing nothing.
    const currency = await resolveCurrencyFor(profile.id);

    const [terms, spend] = await Promise.all([
      prisma.customerLimit.findUnique({
        where: {
          customerProfileId_currencyCode: {
            customerProfileId: profile.id,
            currencyCode: currency,
          },
        },
        select: { perOrderMinMinor: true, perOrderMaxMinor: true },
      }),
      getSpendSummary(profile.id, currency),
    ]);

    return reply.status(200).send({
      profile: {
        id: profile.id,
        email: profile.user.email,
        fullName: profile.fullName,
        organization: profile.organization,
        department: profile.department,
        phone: profile.phone,
        gstin: profile.gstin,
        // `internalNotes` and `customerCode` are omitted: internal notes are
        // written by staff about the customer and are not theirs to read.
        consentAcceptedAt: profile.consentAcceptedAt?.toISOString() ?? null,
        consentVersion: profile.consentVersion,
        activatedAt: profile.activatedAt?.toISOString() ?? null,
        lastLoginAt: profile.user.lastLoginAt?.toISOString() ?? null,
        orderCount: profile._count.orders,
        scheduleCount: profile._count.schedules,
      },
      // Shown so the customer understands a rejected checkout, rather than
      // hitting an opaque limit error at payment time.
      purchasingLimits: {
        // The terms for the currency this customer is quoted in. Showing
        // another market's figures beside their prices would just mislead.
        perOrderMinMinor: terms?.perOrderMinMinor?.toString() ?? null,
        perOrderMaxMinor: terms?.perOrderMaxMinor?.toString() ?? null,
        requiresOrderApproval: profile.requiresOrderApproval,
        currency,
      },
      spend,
    });
  });

  app.patch('/profile', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const body = profileUpdateSchema.parse(request.body);

    await updateCustomer(auth.customerProfileId ?? '', body, {
      // Recorded as a CUSTOMER-actor audit entry, distinct from an admin edit.
      userId: auth.id,
      email: auth.email,
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });

    return reply.status(200).send({ updated: true });
  });

  app.get('/addresses', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);

    const addresses = await prisma.address.findMany({
      where: { customerProfileId: auth.customerProfileId ?? '', archivedAt: null },
      orderBy: [{ isDefaultShipping: 'desc' }, { createdAt: 'asc' }],
    });

    return reply.status(200).send({ addresses });
  });

  app.post('/addresses', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const body = addressSchema.parse(request.body);

    const result = await addAddress(auth.customerProfileId ?? '', body, {
      userId: auth.id,
      email: auth.email,
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });

    return reply.status(201).send(result);
  });

  app.patch('/addresses/:addressId', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const { addressId } = z.object({ addressId: z.string().length(26) }).parse(request.params);
    const body = addressSchema.partial().parse(request.body);

    // Scoped by the session's profile id, so an address belonging to another
    // customer resolves to "not found" rather than being editable.
    await updateAddress(auth.customerProfileId ?? '', addressId, body, {
      userId: auth.id,
      email: auth.email,
      ipAddress: request.ip,
      correlationId: request.correlationId,
    });

    return reply.status(200).send({ updated: true });
  });

  app.delete('/addresses/:addressId', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const { addressId } = z.object({ addressId: z.string().length(26) }).parse(request.params);

    await archiveAddress(auth.customerProfileId ?? '', addressId);
    return reply.status(200).send({ archived: true });
  });

  /** Public capability flags the storefront branches on before rendering. */
  /**
   * The shopper's country and currency choice.
   *
   * Returns null until they have answered, which is how the storefront knows
   * to put the question up on first sign-in.
   */
  app.get('/locale', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const locale = await getCustomerLocale(auth.customerProfileId ?? '');
    return reply.status(200).send({ locale });
  });

  app.put('/locale', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const body = localeSchema.parse(request.body);

    const locale = await setCustomerLocale(auth.customerProfileId ?? '', {
      country: body.country,
      currency: body.currency ?? null,
      detectedCountry: body.detectedCountry ?? null,
    });

    return reply.status(200).send({ locale });
  });

  app.get('/config', (_request, reply) =>
    reply.status(200).send({ selfRegistrationEnabled: selfRegistrationEnabled() }),
  );

  return Promise.resolve();
}
