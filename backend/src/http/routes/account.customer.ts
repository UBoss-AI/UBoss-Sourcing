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
  createDataRequest,
  downloadBundle,
  listRequestsForSubject,
} from '../../modules/privacy/data-request.service.js';
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
  // Their own EU VAT registration. Safe to let a customer edit: an unverified
  // or wrong number costs them the reverse charge, it does not cost the seller
  // the tax - see resolveTaxTreatment.
  vatNumber: z.string().max(32).nullable().optional(),
});

/**
 * A data subject request.
 *
 * The note is the subject's own words. It is stored and shown to staff, and it
 * is never read as an instruction - a request asking for something the law
 * does not grant is still only a request.
 */
const dataRequestSchema = z.object({
  type: z.enum(['EXPORT', 'ERASURE']),
  note: z.string().max(1024).nullable().optional(),
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
        vatNumber: profile.vatNumber,
        // Null means "not checked", which is not the same as invalid and is
        // shown differently: one is a problem with the number, the other is a
        // step nobody has taken yet.
        vatNumberValid: profile.vatNumberValid,
        vatNumberCheckedAt: profile.vatNumberCheckedAt?.toISOString() ?? null,
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

  // --- Data subject rights ------------------------------------------------
  //
  // Both routes derive the subject from the session, like everything else in
  // this file. That is also the identity check Art. 12(6) asks for: the person
  // asking is signed in as the person being asked about, which is a stronger
  // proof than the copy of a passport a paper process would collect.

  /**
   * What has been asked for, and where each one stands.
   *
   * Carries the live download token for a finished export, so a page reload
   * does not lose the link. Once the window closes the field is null rather
   * than a token the download route would refuse.
   */
  app.get('/data-requests', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const requests = await listRequestsForSubject(auth.id);
    return reply.status(200).send({ requests });
  });

  /**
   * Exercise a right.
   *
   * Rate-limited hard. Building a bundle reads most of the database for one
   * account, and the service refuses a second open request of the same type
   * anyway - this is the cheaper of the two refusals.
   */
  app.post(
    '/data-requests',
    {
      preHandler: requireCustomer,
      config: { rateLimit: { max: 5, timeWindow: '1 hour' } },
    },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = dataRequestSchema.parse(request.body);

      const created = await createDataRequest({
        userId: auth.id,
        email: auth.email,
        type: body.type,
        note: body.note ?? null,
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] ?? null,
        correlationId: request.correlationId,
      });

      return reply.status(202).send(created);
    },
  );

  app.get('/config', (_request, reply) =>
    reply.status(200).send({ selfRegistrationEnabled: selfRegistrationEnabled() }),
  );

  return Promise.resolve();
}

/**
 * The download itself.
 *
 * Outside the account tree and outside the session, exactly like the admin
 * export download next door: the hashed, expiring token IS the authorisation,
 * so the link in the email works from a mail client that carries no cookie.
 */
export function registerDataBundleDownloadRoute(app: FastifyInstance): Promise<void> {
  app.get(
    '/download/:token',
    { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const { token } = z.object({ token: z.string().min(16).max(512) }).parse(request.params);
      const file = await downloadBundle(token);

      return reply
        .header('Content-Type', 'application/json; charset=utf-8')
        // `attachment`, never inline: this is somebody's whole record, and a
        // JSON document rendered in the API's own origin is a gift to anyone
        // who can get a link into a browser.
        .header('Content-Disposition', `attachment; filename="${file.fileName}"`)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Cache-Control', 'no-store')
        .status(200)
        .send(file.content);
    },
  );

  return Promise.resolve();
}
