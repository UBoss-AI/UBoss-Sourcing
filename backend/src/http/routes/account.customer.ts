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
  cancelEmailChange,
  cancelPhoneChange,
  confirmEmailChange,
  confirmPhoneChange,
  requestEmailChange,
  requestPhoneChange,
} from '../../modules/customers/contact-change.service.js';
import {
  deactivateOwnAccount,
  describeClosure,
} from '../../modules/customers/account-closure.service.js';
import {
  addToWishlist,
  listWishlist,
  removeFromWishlist,
} from '../../modules/customers/wishlist.service.js';
import { listPublicCoupons } from '../../modules/coupons/coupon.service.js';
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
  /**
   * The name in two parts, which is what the profile screen sends.
   *
   * `fullName` is recomposed from them by `updateCustomer` and stays the
   * canonical name on every order and invoice — see the note there for why the
   * composition only ever runs in that direction.
   */
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  organization: z.string().max(255).nullable().optional(),
  department: z.string().max(128).nullable().optional(),
  jobTitle: z.string().max(128).nullable().optional(),
  /**
   * The delivery contact number, which is NOT the account's own.
   *
   * `users.phone` identifies the account and moves only through the verified
   * change below; this is the number on the profile that a courier rings, and
   * it is an ordinary editable field. The two are separate columns because
   * they answer separate questions, and this schema deliberately only reaches
   * the second.
   */
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

/**
 * A new address for the account.
 *
 * `z.email()` and nothing more. Deliberately no "is this a real mailbox"
 * heuristic — the confirmation link IS that check, and a regex that rejects a
 * legal address is a customer who cannot use their own email.
 */
const emailChangeSchema = z.object({
  email: z.string().trim().min(3).max(320).email(),
});

/**
 * A new telephone number for the account.
 *
 * Loose on purpose. The markets this ships into write numbers half a dozen
 * ways, and a pattern strict enough to be useful rejects a legitimate one
 * somewhere — which on this screen means a buyer cannot record the number a
 * courier will ring.
 */
const phoneChangeSchema = z.object({
  phone: z.string().trim().min(5).max(32),
});

/** Either confirmation link, redeemed. The purpose is on the token, not here. */
const confirmSchema = z.object({
  token: z.string().min(16).max(512),
});

/**
 * Closing the account.
 *
 * The password is required and is not optional-with-a-default: this is
 * destructive-feeling, one click from a menu, and on a shared purchasing
 * machine the person at the keyboard is not reliably the account holder.
 */
const deactivateSchema = z.object({
  password: z.string().min(1).max(256),
  reason: z.string().max(512).nullable().optional(),
});

const notificationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const wishlistQuerySchema = z.object({
  currency: z.string().trim().length(3).optional(),
  country: z.string().trim().length(2).optional(),
  language: z.string().trim().min(2).max(10).optional(),
});

const wishlistAddSchema = z.object({
  productId: z.string().length(26),
  variantId: z.string().length(26).nullable().optional(),
});

export function registerCustomerAccountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/profile', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);

    const profile = await prisma.customerProfile.findUnique({
      where: { id: auth.customerProfileId ?? '' },
      include: {
        user: {
          select: {
            email: true,
            status: true,
            lastLoginAt: true,
            phone: true,
            emailVerifiedAt: true,
            phoneVerifiedAt: true,
            preferredLanguage: true,
            // What is waiting to be confirmed. Read here rather than from a
            // second endpoint: the profile screen has to render the pending
            // state beside the live value, and two reads for one panel is two
            // chances for them to disagree on screen.
            pendingEmail: true,
            pendingPhone: true,
          },
        },
        _count: { select: { orders: true, schedules: true, wishlistItems: true } },
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
        emailVerifiedAt: profile.user.emailVerifiedAt?.toISOString() ?? null,
        fullName: profile.fullName,
        firstName: profile.firstName,
        lastName: profile.lastName,
        organization: profile.organization,
        department: profile.department,
        jobTitle: profile.jobTitle,
        phone: profile.phone,
        /**
         * The number on the identity, and whether it has been confirmed.
         *
         * Separate from `phone` above, which is the delivery contact on the
         * profile. Two columns for two questions — see the update schema.
         */
        accountPhone: profile.user.phone,
        accountPhoneVerifiedAt: profile.user.phoneVerifiedAt?.toISOString() ?? null,
        /** What is waiting on a confirmation link. Null when nothing is. */
        pendingEmail: profile.user.pendingEmail,
        pendingPhone: profile.user.pendingPhone,
        /**
         * The market and the language, so the profile screen can state them
         * without a second read. All three are nullable and mean "never
         * chosen" rather than a default — the storefront's own resolution
         * decides what an unanswered account is quoted in.
         */
        preferredCountry: profile.preferredCountry,
        preferredCurrency: profile.preferredCurrency,
        preferredLanguage: profile.user.preferredLanguage,
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
        wishlistCount: profile._count.wishlistItems,
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

  // --- Changing the two things that identify the account ------------------
  //
  // Neither takes effect on the PATCH. The requested value is parked, a
  // single-use link is minted, and only consuming that link promotes it — see
  // `customers/contact-change.service.ts` for why, at length. The short
  // version: `users.email` is what the account signs in with and where every
  // order confirmation goes, so one typo written straight into it locks
  // somebody out of their own purchasing account with no way back.
  //
  // Rate-limited harder than the profile edit next door. Each request sends
  // two emails, one of them to an address the requester has just typed, so an
  // unlimited endpoint here is an open relay pointed at anybody.

  app.post(
    '/email-change',
    { preHandler: requireCustomer, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = emailChangeSchema.parse(request.body);

      const result = await requestEmailChange(auth.id, body.email, {
        userId: auth.id,
        email: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      // 202: accepted, not done. The client renders "check your inbox", and
      // the distinction matters because the old address still works.
      return reply.status(202).send({ pendingEmail: body.email, expiresAt: result.expiresAt });
    },
  );

  app.post(
    '/email-change/confirm',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = confirmSchema.parse(request.body);

      const result = await confirmEmailChange(body.token, auth.id, {
        userId: auth.id,
        email: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      // Every session is gone by now, including this one: the address is the
      // sign-in identity. The client is told so rather than left to discover
      // it on its next request.
      return reply.status(200).send({ email: result.email, signedOut: true });
    },
  );

  app.delete('/email-change', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    await cancelEmailChange(auth.id);
    return reply.status(200).send({ cancelled: true });
  });

  app.post(
    '/phone-change',
    { preHandler: requireCustomer, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = phoneChangeSchema.parse(request.body);

      const result = await requestPhoneChange(auth.id, body.phone, {
        userId: auth.id,
        email: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      return reply.status(202).send({ pendingPhone: body.phone, expiresAt: result.expiresAt });
    },
  );

  app.post(
    '/phone-change/confirm',
    { preHandler: requireCustomer, config: { rateLimit: { max: 20, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = confirmSchema.parse(request.body);

      const result = await confirmPhoneChange(body.token, auth.id, {
        userId: auth.id,
        email: auth.email,
        ipAddress: request.ip,
        correlationId: request.correlationId,
      });

      // No sign-out: a telephone number is not the sign-in identity.
      return reply.status(200).send({ phone: result.phone });
    },
  );

  app.delete('/phone-change', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    await cancelPhoneChange(auth.id);
    return reply.status(200).send({ cancelled: true });
  });

  // --- Closing the account ------------------------------------------------
  //
  // Deactivation is here. Erasure is NOT: it goes through `/data-requests`
  // with type ERASURE, like every other data-subject right, because it has to
  // be assessed against the obligations that survive it — an unpaid order, an
  // open return, an invoice a tax authority requires be kept for years. The
  // two are different acts and the screen says so.

  /**
   * What closing this account would actually do.
   *
   * Read by the confirmation dialog so the warning names the customer's own
   * arrangements: "this will pause 2 scheduled orders" is a sentence somebody
   * can act on, where "scheduled orders may be affected" is one they scroll
   * past.
   */
  app.get('/closure', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const impact = await describeClosure(auth.customerProfileId ?? '');
    return reply.status(200).send({ closure: impact });
  });

  app.post(
    '/deactivate',
    { preHandler: requireCustomer, config: { rateLimit: { max: 5, timeWindow: '1 hour' } } },
    async (request, reply) => {
      const auth = currentUser(request);
      const body = deactivateSchema.parse(request.body);

      const result = await deactivateOwnAccount(
        {
          userId: auth.id,
          customerProfileId: auth.customerProfileId ?? '',
          password: body.password,
          reason: body.reason ?? null,
        },
        {
          userId: auth.id,
          email: auth.email,
          ipAddress: request.ip,
          correlationId: request.correlationId,
        },
      );

      return reply.status(200).send({ deactivated: true, ...result });
    },
  );

  // --- Coupons -------------------------------------------------------------

  /**
   * The coupons this customer could use, and the ones they have used.
   *
   * Advertised coupons are read from the same `listPublicCoupons` the cart
   * reads, so a code offered here is a code the cart will accept — there is
   * one definition of "live, publicly listed, priced in this currency" and
   * this is not a second one.
   *
   * What it deliberately does not do is evaluate each coupon against a basket.
   * The cart does that, because eligibility depends on what is in the basket,
   * and a page that said "eligible" against an empty cart would be promising
   * something it cannot know. The minimum is stated instead, which is the fact
   * a customer can act on.
   */
  app.get('/coupons', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const profileId = auth.customerProfileId ?? '';

    const currency = await resolveCurrencyFor(profileId);

    const [offers, redemptions] = await Promise.all([
      listPublicCoupons(currency),
      prisma.couponRedemption.findMany({
        where: { customerProfileId: profileId },
        orderBy: { redeemedAt: 'desc' },
        take: 50,
        select: {
          redeemedAt: true,
          discountMinor: true,
          currencyCode: true,
          // The code as it was at redemption, not as the coupon reads now: a
          // coupon can be renamed or repercentaged afterwards, and what this
          // order actually received must not move. The name comes off the
          // coupon because there is no snapshot of it and a heading is not
          // evidence of anything.
          codeSnapshot: true,
          coupon: { select: { name: true } },
          order: { select: { orderNumber: true } },
        },
      }),
    ]);

    return reply.status(200).send({
      currency,
      available: offers.map((coupon) => {
        const minimum = coupon.minimums.find((row) => row.currencyCode === currency);

        return {
          code: coupon.code,
          name: coupon.name,
          description: coupon.description,
          discountPercent: coupon.discountPercent.toString(),
          // Money crosses the API as a string of minor units, always.
          minOrderMinor: minimum?.minOrderMinor.toString() ?? null,
          validUntil: coupon.validUntil?.toISOString() ?? null,
        };
      }),
      used: redemptions.map((row) => ({
        code: row.codeSnapshot,
        name: row.coupon.name,
        orderNumber: row.order.orderNumber,
        discountMinor: row.discountMinor.toString(),
        currency: row.currencyCode,
        usedAt: row.redeemedAt.toISOString(),
      })),
    });
  });

  // --- Notifications -------------------------------------------------------

  /**
   * What this deployment has sent to this customer.
   *
   * Read out of the notification outbox by recipient address, which is the
   * honest answer to "my notifications": these are the messages that were
   * actually queued for them. It is not a feed and not a preference screen —
   * there is nothing here to mark as read, because there is nothing on the
   * server that tracks whether a customer opened an email.
   *
   * Only what was actually SENT. A PENDING row is a message the queue has not
   * got to yet and a FAILED one is a message that never arrived, and listing
   * either as a notification the customer received would be a lie about their
   * own record.
   *
   * The body is deliberately not returned. It is a rendered email, often
   * carrying a single-use link — a payment link, a reset token — and a list
   * endpoint that handed those back would turn one leaked session into every
   * live link the account has ever been sent.
   */
  app.get('/notifications', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const { limit } = notificationQuerySchema.parse(request.query);

    const rows = await prisma.notificationOutbox.findMany({
      where: { recipientEmail: auth.email, status: 'SENT' },
      orderBy: { sentAt: 'desc' },
      take: limit,
      select: {
        id: true,
        eventKey: true,
        subject: true,
        sentAt: true,
        relatedType: true,
        relatedId: true,
      },
    });

    return reply.status(200).send({
      notifications: rows.map((row) => ({
        id: row.id,
        eventKey: row.eventKey,
        subject: row.subject,
        sentAt: row.sentAt?.toISOString() ?? null,
        relatedType: row.relatedType,
        relatedId: row.relatedId,
      })),
    });
  });

  // --- Saved for later -----------------------------------------------------

  app.get('/wishlist', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const query = wishlistQuerySchema.parse(request.query);
    const profileId = auth.customerProfileId ?? '';

    /*
     * The currency the customer is actually quoted in, unless the request
     * names one.
     *
     * It has to be quoted in *something* consistent with the rest of the
     * storefront: a saved line showing a euro figure on a page whose header
     * says INR is the misreading `location-price.service.ts` exists to
     * prevent.
     */
    const currency = query.currency ?? (await resolveCurrencyFor(profileId));

    const result = await listWishlist(profileId, {
      currency,
      country: query.country ?? null,
      language: query.language ?? null,
    });

    return reply.status(200).send(result);
  });

  app.post('/wishlist', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const body = wishlistAddSchema.parse(request.body);

    const saved = await addToWishlist(auth.customerProfileId ?? '', {
      productId: body.productId,
      variantId: body.variantId ?? null,
    });

    // 200, not 201: saving something already saved is the same outcome as
    // saving it for the first time, and this endpoint is idempotent on
    // purpose. A 201 would be a claim that a row was created.
    return reply.status(200).send({ id: saved.id });
  });

  app.delete('/wishlist/:itemId', { preHandler: requireCustomer }, async (request, reply) => {
    const auth = currentUser(request);
    const { itemId } = z.object({ itemId: z.string().length(26) }).parse(request.params);

    // Scoped to the session's profile inside the service, so another
    // customer's saved line is "not found" rather than deletable.
    await removeFromWishlist(auth.customerProfileId ?? '', itemId);
    return reply.status(200).send({ removed: true });
  });

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
