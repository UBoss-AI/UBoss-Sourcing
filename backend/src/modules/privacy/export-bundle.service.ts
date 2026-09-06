/**
 * The Art. 15 / Art. 20 bundle.
 *
 * One person asks what is held about them; this assembles the answer. Access
 * (Art. 15) and portability (Art. 20) are separate rights that want the same
 * file, so there is one bundle rather than two formats: JSON, because Art. 20
 * asks for "structured, commonly used and machine-readable", and because a CSV
 * cannot carry an order with its lines nested inside it.
 *
 * Three rules decide what goes in.
 *
 *   - **Every table that names the subject is read, or the omission is
 *     deliberate and written down.** The `SECTIONS` list below is the record
 *     of that decision. A new table holding personal data is a new section
 *     here, and the test in `export-bundle.test.ts` fails until it is added -
 *     which is the point, because the failure mode of an access request is
 *     quiet incompleteness, not an error anyone sees.
 *
 *   - **Nothing that identifies a different person comes with it.** Art. 15(4)
 *     says the copy must not adversely affect the rights of others, and the
 *     obvious offender is free-text staff commentary: `internalNotes` on the
 *     profile and `internalNote` on an order are written by a colleague, about
 *     the subject, often mentioning a third party. They are listed in the
 *     bundle's manifest as withheld rather than silently dropped, so the
 *     subject can ask for them and a person can make that call case by case.
 *
 *   - **Secrets never travel.** Password hashes, token hashes, MFA secrets and
 *     mandate references are the subject's data in the trivial sense and a
 *     credential in every sense that matters. Their existence is reported; the
 *     value is not.
 *
 * The bundle is deliberately built in one pass in memory. It is one person's
 * account, not a year of orders across the business, so the bounded-memory
 * paging that `reports/export.service.ts` needs is cost without benefit here -
 * and a bundle assembled in a single read cannot be internally inconsistent.
 */
import { prisma } from '../../infra/prisma.js';

/**
 * Where personal data about a customer lives.
 *
 * Written out as data rather than left implicit in the code below so that it
 * can be asserted against the Prisma schema in a test: any model carrying a
 * `customerProfileId` or a `userId` must appear here, as `included` or as
 * `withheld` with a reason. Forgetting a table is the one bug in this file
 * that nothing else would catch.
 */
export const SECTIONS = Object.freeze({
  included: Object.freeze([
    'account',
    'profile',
    'addresses',
    'consents',
    'purchasingLimits',
    'orders',
    'recurringSchedules',
    'carts',
    'couponRedemptions',
    'chatEnquiries',
    'sessions',
    'dataRequests',
  ]),
  withheld: Object.freeze([
    {
      section: 'internalNotes',
      reason:
        'Free-text notes written by staff about this account, which routinely name other ' +
        'people. Withheld under Art. 15(4); available on request after a case-by-case review.',
    },
    {
      section: 'credentials',
      reason:
        'Password hash, MFA secret, session and token hashes, and payment mandate references. ' +
        'Held about the subject but usable as a credential, so their existence is reported ' +
        'and their values are not.',
    },
    {
      section: 'auditTrail',
      reason:
        'Security and accountability log of administrative actions. Entries naming this ' +
        'subject are retained under Art. 17(3)(b) and are available on request; the log as a ' +
        'whole describes staff activity and is not the subject’s personal data.',
    },
  ]),
});

/** JSON cannot carry a BigInt, and every money column is one. */
function money(value: bigint | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toString();
}

function iso(value: Date | null | undefined): string | null {
  return value === null || value === undefined ? null : value.toISOString();
}

export interface BundleSubject {
  userId: string;
  email: string;
}

/**
 * Read everything held about one customer.
 *
 * Returns a plain object ready for `JSON.stringify`. Throws only if the user
 * has vanished between the request being approved and the job running, which
 * the caller turns into a failed request rather than a retry - a subject who
 * no longer exists cannot be sent their data.
 */
export async function buildCustomerBundle(subject: BundleSubject): Promise<Record<string, unknown>> {
  const user = await prisma.user.findUnique({
    where: { id: subject.userId },
    select: {
      id: true,
      email: true,
      phone: true,
      type: true,
      status: true,
      emailVerifiedAt: true,
      phoneVerifiedAt: true,
      preferredLanguage: true,
      mfaEnabledAt: true,
      passwordHash: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
      archivedAt: true,
      erasedAt: true,
    },
  });

  if (user === null) throw new Error(`data subject ${subject.userId} no longer exists`);

  const profile = await prisma.customerProfile.findUnique({
    where: { userId: subject.userId },
    select: {
      id: true,
      fullName: true,
      organization: true,
      department: true,
      phone: true,
      gstin: true,
      customerCode: true,
      requiresOrderApproval: true,
      preferredCountry: true,
      preferredCurrency: true,
      localeChosenAt: true,
      detectedCountry: true,
      detectedAt: true,
      consentAcceptedAt: true,
      consentVersion: true,
      invitedAt: true,
      activatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const account = {
    userId: user.id,
    email: user.email,
    phone: user.phone,
    accountType: user.type,
    status: user.status,
    emailVerifiedAt: iso(user.emailVerifiedAt),
    phoneVerifiedAt: iso(user.phoneVerifiedAt),
    interfaceLanguage: user.preferredLanguage,
    // Reported, never disclosed: knowing that a password is set is the
    // subject's business, and the hash is not.
    passwordSet: user.passwordHash !== null,
    twoFactorEnabledAt: iso(user.mfaEnabledAt),
    lastSignInAt: iso(user.lastLoginAt),
    createdAt: iso(user.createdAt),
    updatedAt: iso(user.updatedAt),
    deactivatedAt: iso(user.archivedAt),
    erasedAt: iso(user.erasedAt),
  };

  // The subject's own history of exercising these rights. Keyed by user rather
  // than by profile, so it is read here alongside the account and appears even
  // in the short bundle below. The download token is stripped: it is a bearer
  // credential for this very file, and one that has already been used by the
  // time anybody reads it.
  const dataRequests = (
    await prisma.dataRequest.findMany({
      where: { subjectUserId: subject.userId },
      orderBy: { requestedAt: 'asc' },
      select: {
        id: true,
        type: true,
        status: true,
        requestedAt: true,
        dueAt: true,
        completedAt: true,
        subjectNote: true,
        decisionNote: true,
        downloadedAt: true,
      },
    })
  ).map((request) => ({
    ...request,
    requestedAt: iso(request.requestedAt),
    dueAt: iso(request.dueAt),
    completedAt: iso(request.completedAt),
    downloadedAt: iso(request.downloadedAt),
  }));

  // A staff account, or a customer whose profile was never created, still gets
  // a bundle - it is just a short one. Returning early here rather than
  // guarding every query below keeps the shape of the file predictable.
  if (profile === null) {
    return envelope(subject, { account, profile: null, dataRequests });
  }

  const [addresses, limits, orders, schedules, carts, redemptions, enquiries, sessions] =
    await Promise.all([
      prisma.address.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          kind: true,
          label: true,
          contactName: true,
          contactPhone: true,
          line1: true,
          line2: true,
          city: true,
          state: true,
          postalCode: true,
          country: true,
          isDefaultBilling: true,
          isDefaultShipping: true,
          createdAt: true,
          archivedAt: true,
        },
      }),

      // Selected field by field rather than taken whole: the row also carries
      // `updatedById`, which identifies the member of staff who set the limit
      // and is their data, not the subject's.
      prisma.customerLimit.findMany({
        where: { customerProfileId: profile.id },
        select: {
          currencyCode: true,
          perOrderMinMinor: true,
          perOrderMaxMinor: true,
          monthlySpendCapMinor: true,
          approvalThresholdMinor: true,
          createdAt: true,
          updatedAt: true,
        },
      }),

      prisma.order.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          orderNumber: true,
          status: true,
          source: true,
          currency: true,
          subtotalMinor: true,
          discountMinor: true,
          taxMinor: true,
          shippingMinor: true,
          grandTotalMinor: true,
          paidMinor: true,
          refundedMinor: true,
          billingAddressJson: true,
          shippingAddressJson: true,
          shippingMethodName: true,
          paymentMode: true,
          // The note the subject wrote. `internalNote` next to it is staff
          // commentary and is withheld - see SECTIONS.
          customerNote: true,
          placedAt: true,
          confirmedAt: true,
          cancelledAt: true,
          cancelReason: true,
          createdAt: true,
          items: {
            select: {
              nameSnapshot: true,
              skuSnapshot: true,
              variantNameSnapshot: true,
              quantity: true,
              unitPriceMinor: true,
              lineSubtotalMinor: true,
              taxRatePercent: true,
              taxAmountMinor: true,
              discountMinor: true,
              lineTotalMinor: true,
            },
          },
        },
      }),

      prisma.recurringSchedule.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          name: true,
          status: true,
          frequency: true,
          intervalDays: true,
          weekday: true,
          monthDay: true,
          timezone: true,
          runAtMinute: true,
          startDate: true,
          endDate: true,
          occurrenceCount: true,
          nextRunAt: true,
          lastRunAt: true,
          paymentMode: true,
          payerEmail: true,
          // Selected so the bundle can say whether a standing payment
          // authority exists. The reference itself is a payment credential and
          // never leaves this function - see the mapping below.
          mandateReference: true,
          mandateProvider: true,
          consentAcceptedAt: true,
          consentVersion: true,
          createdAt: true,
          cancelledAt: true,
        },
      }),

      prisma.cart.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          status: true,
          currency: true,
          createdAt: true,
          updatedAt: true,
          items: {
            select: { quantity: true, createdAt: true, product: { select: { name: true, sku: true } } },
          },
        },
      }),

      prisma.couponRedemption.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { redeemedAt: 'asc' },
        select: {
          orderId: true,
          codeSnapshot: true,
          discountPercentSnapshot: true,
          currencyCode: true,
          discountMinor: true,
          redeemedAt: true,
        },
      }),

      // Enquiries the subject started from the storefront widget before, or
      // alongside, having an account. Matched on the profile link the capture
      // step writes when the address is already known.
      prisma.assistantConversation.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          visitorName: true,
          visitorPhone: true,
          visitorEmail: true,
          messageCount: true,
          lastMessageAt: true,
          ipAddress: true,
          userAgent: true,
          createdAt: true,
          messages: {
            orderBy: { createdAt: 'asc' },
            select: { role: true, content: true, createdAt: true },
          },
        },
      }),

      // Sign-in history. The refresh-token hash is a credential and stays out;
      // where and when someone signed in is squarely their own data.
      prisma.session.findMany({
        where: { userId: subject.userId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          userAgent: true,
          ipAddress: true,
          locationLabel: true,
          locationCapturedAt: true,
          createdAt: true,
          lastUsedAt: true,
          expiresAt: true,
          revokedAt: true,
          revokedReason: true,
        },
      }),
    ]);

  return envelope(subject, {
    account,

    profile: {
      customerProfileId: profile.id,
      fullName: profile.fullName,
      organization: profile.organization,
      department: profile.department,
      phone: profile.phone,
      taxRegistration: profile.gstin,
      customerCode: profile.customerCode,
      requiresOrderApproval: profile.requiresOrderApproval,
      statedCountry: profile.preferredCountry,
      preferredCurrency: profile.preferredCurrency,
      localeChosenAt: iso(profile.localeChosenAt),
      // Recorded separately from the stated country so the two can be
      // compared. Both are the subject's data and both are disclosed.
      browserDetectedCountry: profile.detectedCountry,
      browserDetectedAt: iso(profile.detectedAt),
      invitedAt: iso(profile.invitedAt),
      activatedAt: iso(profile.activatedAt),
      createdAt: iso(profile.createdAt),
      updatedAt: iso(profile.updatedAt),
    },

    addresses: addresses.map((address) => ({
      ...address,
      createdAt: iso(address.createdAt),
      // Archived rather than deleted: an address the customer removed is still
      // held, so it is still disclosed, with the fact that it is retired.
      archivedAt: iso(address.archivedAt),
    })),

    consents: [
      {
        what: 'Terms of business',
        version: profile.consentVersion,
        acceptedAt: iso(profile.consentAcceptedAt),
      },
      ...schedules.map((schedule) => ({
        what: `Recurring order authority: ${schedule.name}`,
        version: schedule.consentVersion,
        acceptedAt: iso(schedule.consentAcceptedAt),
      })),
    ],

    purchasingLimits: limits.map((limit) => ({
      currency: limit.currencyCode,
      perOrderMinMinor: money(limit.perOrderMinMinor),
      perOrderMaxMinor: money(limit.perOrderMaxMinor),
      monthlySpendCapMinor: money(limit.monthlySpendCapMinor),
      approvalThresholdMinor: money(limit.approvalThresholdMinor),
      agreedAt: iso(limit.createdAt),
      updatedAt: iso(limit.updatedAt),
    })),

    orders: orders.map((order) => ({
      ...order,
      subtotalMinor: money(order.subtotalMinor),
      discountMinor: money(order.discountMinor),
      taxMinor: money(order.taxMinor),
      shippingMinor: money(order.shippingMinor),
      grandTotalMinor: money(order.grandTotalMinor),
      paidMinor: money(order.paidMinor),
      refundedMinor: money(order.refundedMinor),
      placedAt: iso(order.placedAt),
      confirmedAt: iso(order.confirmedAt),
      cancelledAt: iso(order.cancelledAt),
      createdAt: iso(order.createdAt),
      items: order.items.map((item) => ({
        ...item,
        unitPriceMinor: money(item.unitPriceMinor),
        lineSubtotalMinor: money(item.lineSubtotalMinor),
        taxAmountMinor: money(item.taxAmountMinor),
        discountMinor: money(item.discountMinor),
        lineTotalMinor: money(item.lineTotalMinor),
        // Prisma Decimal is neither a number nor a string to JSON.
        taxRatePercent: item.taxRatePercent.toString(),
      })),
    })),

    recurringSchedules: schedules.map(({ mandateReference, ...schedule }) => ({
      ...schedule,
      startDate: iso(schedule.startDate),
      endDate: iso(schedule.endDate),
      nextRunAt: iso(schedule.nextRunAt),
      lastRunAt: iso(schedule.lastRunAt),
      consentAcceptedAt: iso(schedule.consentAcceptedAt),
      createdAt: iso(schedule.createdAt),
      cancelledAt: iso(schedule.cancelledAt),
      // The fact, not the credential.
      paymentMandateOnFile: mandateReference !== null,
    })),

    carts: carts.map((cart) => ({
      ...cart,
      createdAt: iso(cart.createdAt),
      updatedAt: iso(cart.updatedAt),
      items: cart.items.map((item) => ({
        productName: item.product.name,
        sku: item.product.sku,
        quantity: item.quantity,
        addedAt: iso(item.createdAt),
      })),
    })),

    couponRedemptions: redemptions.map((redemption) => ({
      orderId: redemption.orderId,
      code: redemption.codeSnapshot,
      discountPercent: redemption.discountPercentSnapshot.toString(),
      currency: redemption.currencyCode,
      discountMinor: money(redemption.discountMinor),
      redeemedAt: iso(redemption.redeemedAt),
    })),

    chatEnquiries: enquiries.map((enquiry) => ({
      ...enquiry,
      lastMessageAt: iso(enquiry.lastMessageAt),
      createdAt: iso(enquiry.createdAt),
      messages: enquiry.messages.map((message) => ({
        ...message,
        createdAt: iso(message.createdAt),
      })),
    })),

    sessions: sessions.map((session) => ({
      ...session,
      locationCapturedAt: iso(session.locationCapturedAt),
      createdAt: iso(session.createdAt),
      lastUsedAt: iso(session.lastUsedAt),
      expiresAt: iso(session.expiresAt),
      revokedAt: iso(session.revokedAt),
    })),

    dataRequests,
  });
}

/**
 * Wrap the data in the manifest that makes it an answer rather than a dump.
 *
 * A subject who receives a JSON file with no explanation has been given data,
 * not information. The header says who it is about, when it was produced, what
 * is in it, what is not and why - which is most of what Art. 15(1) requires be
 * communicated alongside the copy itself.
 */
function envelope(subject: BundleSubject, data: Record<string, unknown>): Record<string, unknown> {
  return {
    manifest: {
      about: subject.email,
      subjectId: subject.userId,
      generatedAt: new Date().toISOString(),
      format: 'application/json',
      basis: 'GDPR Art. 15 (right of access) and Art. 20 (data portability)',
      sectionsIncluded: SECTIONS.included,
      sectionsWithheld: SECTIONS.withheld,
      note:
        'Amounts are in minor currency units (cents) as strings, so no value is rounded by ' +
        'a JSON number. Timestamps are ISO-8601 UTC.',
    },
    data,
  };
}
