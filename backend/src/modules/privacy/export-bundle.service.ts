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
    'savedPaymentMethods',
    'carts',
    // Lines saved without buying them. A record of what somebody was thinking
    // of ordering, which is plainly theirs, and short enough to disclose whole.
    'wishlist',
    // What they asked a seller for, on products they did not buy. Their own
    // words about their own requirements, held indefinitely until they take
    // them back, so plainly theirs and disclosed whole.
    'productInstructions',
    'couponRedemptions',
    // Delivery options this person was shown at checkout, with the price and
    // the dates each one promised. Short-lived and mostly unaccepted, and
    // disclosed anyway: it is a record of what a shop offered a named
    // individual, and the one they took is the evidence behind a delivery
    // date they may later be arguing about.
    'fulfilmentQuotes',
    /*
     * Requests this person made for a freight price on a pallet or container
     * order, and the answers they got.
     *
     * Disclosed on exactly the reasoning above `fulfilmentQuotes`, and rather
     * more strongly: a freight quotation is a negotiation a named individual
     * started, it carries what they asked for and what they were told, and it
     * is the evidence behind a delivery charge and a delivery date they may
     * later be arguing about. Some of these sit unanswered for weeks, so a
     * subject asking what is held about them today would otherwise get
     * nothing about a conversation that is still open.
     *
     * The seller's own commercial terms - which carrier, at what cost to the
     * seller - are not in it. What is disclosed is what was said to THIS
     * person.
     */
    'freightQuoteRequests',
    // Bulk preorders this person requested: what they asked for, every set of
    // terms the seller proposed to them, what they agreed to and the history.
    // A negotiation a named individual started, and the evidence behind a
    // committed delivery date, so disclosed whole.
    'preorderRequests',
    'chatEnquiries',
    'sessions',
    'dataRequests',
    // Their standing authority to be charged, and the evidence of when they
    // gave it. Disclosed in full: it is the record a subject would want if they
    // ever disputed a charge.
    'autoPayAuthority',
    // Where they work and what authority they hold there. The organisation's
    // ERP connection is the COMPANY's and is not disclosed here - see the
    // section itself for why the line falls where it does.
    'organisationMembership',
    // Their place in a SELLER organisation, where they sell here as well as buy.
    // A membership is a fact about an individual, so it is disclosed - the same
    // line `organisationMembership` draws. The seller BUSINESS's own data is not
    // theirs and does not come with it.
    'sellerMembership',
    // Their place in a LOGISTICS organisation, where they work for a carrier
    // that delivers for this marketplace. Same line again: the membership and
    // the driver record are facts about the person; the carrier's consignments
    // are the carrier's.
    'logisticsMembership',
    /*
     * Where they drove, while on duty.
     *
     * The most sensitive personal data this installation collects about
     * anybody: one employee's movements, minute by minute. Disclosed in full
     * rather than summarised, because a subject asking what is held about them
     * is entitled to the actual positions and not a count of them - and
     * because the honest answer to "you track my location" is to show them
     * exactly what that means.
     *
     * Bounded by the retention window, which is short for exactly this
     * reason, and by a row cap on the section itself.
     */
    'logisticsLocationHistory',
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
    {
      section: 'logisticsAuditTrail',
      reason:
        'Accountability log of actions taken inside a logistics company - shipments accepted, ' +
        'status updates recorded, contact details revealed. It belongs to that COMPANY rather ' +
        'than to any one member of it, and most entries describe colleagues. Entries naming ' +
        'this subject are retained under Art. 17(3)(b) and are available on request.',
    },
    {
      section: 'sellerAuditTrail',
      reason:
        'Accountability log of actions taken on a seller account - listings submitted, stock ' +
        'adjusted, orders dispatched. It belongs to the seller BUSINESS rather than to any one ' +
        'member of it, and most entries describe colleagues. Entries naming this subject are ' +
        'retained under Art. 17(3)(b) and are available on request.',
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
export async function buildCustomerBundle(
  subject: BundleSubject,
): Promise<Record<string, unknown>> {
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

  const [
    addresses,
    limits,
    orders,
    schedules,
    paymentMethods,
    carts,
    redemptions,
    enquiries,
    sessions,
    wishlist,
    productInstructions,
  ] = await Promise.all([
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
          intervalMonths: true,
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

      /**
       * Saved cards, and the consent that lets them be charged.
       *
       * Disclosed because it is unambiguously the subject's data - which cards
       * they saved, and when they agreed to automatic charges. That consent
       * record is the part that matters most to them: it is the evidence for
       * why money left their account while they were not looking.
       *
       * The columns NOT selected are the point of this block. The provider's
       * customer and payment-method references are omitted entirely, because
       * they are chargeable: anyone holding them and this deployment's Stripe
       * key could take money. They are credentials about the subject rather
       * than information about them, so they fall under the same Art. 15(4)
       * reasoning as the password hash - and `credentials` on the withheld
       * list already tells the subject that such values exist and are not
       * being sent.
       *
       * `consentIpHash` is omitted too. It is a hash of an address the subject
       * already knows, it identifies nobody else, and disclosing it would only
       * hand back something they cannot read.
       */
      prisma.customerPaymentMethod.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          provider: true,
          brand: true,
          last4: true,
          expMonth: true,
          expYear: true,
          funding: true,
          country: true,
          status: true,
          isDefault: true,
          // What the customer agreed to when this card was stored, which is
          // the single most consequential fact about the row: it is the
          // difference between a card that can only be used with them present
          // and one that authorises charges they will not see. Art. 15(1)(a)
          // asks what the data is processed for, and this field IS the answer
          // for this table.
          //
          // Added by hand, and worth saying why: this select is the export's
          // real column list, and nothing in the test suite compares it to the
          // schema. A column left out here is silently missing from every copy
          // a customer ever receives, with no test going red.
          consentScope: true,
          consentAcceptedAt: true,
          consentVersion: true,
          consentUserAgent: true,
          detachedAt: true,
          createdAt: true,
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
          select: {
            quantity: true,
            createdAt: true,
            product: { select: { name: true, sku: true } },
          },
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

      /*
       * Lines the subject saved without buying them.
       *
       * A short list and an obviously personal one — it is a record of what
       * somebody was thinking of ordering — so it is disclosed in full rather
       * than summarised. The product is named as well as identified: an id
       * tells the subject nothing about what they had saved.
       */
      prisma.wishlistItem.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          variantKey: true,
          createdAt: true,
          product: { select: { name: true, sku: true } },
        },
      }),

      /*
       * What they asked a seller for, on products they did not buy.
       *
       * Short, indefinitely held, and unambiguously the subject's own words
       * about their own requirements, so it is disclosed whole and in the
       * original text rather than summarised. The product is named as well as
       * identified, for the reason the wishlist gives: an id tells the subject
       * nothing about what they wrote it against.
       *
       * The instruction attached to an ORDER line is a different record and
       * already travels with `orders` above, frozen as it was at checkout.
       */
      prisma.productInstruction.findMany({
        where: { customerProfileId: profile.id },
        orderBy: { createdAt: 'asc' },
        select: {
          variantKey: true,
          body: true,
          createdAt: true,
          updatedAt: true,
          product: { select: { name: true, sku: true } },
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

    savedPaymentMethods: paymentMethods.map((method) => ({
      ...method,
      consentAcceptedAt: iso(method.consentAcceptedAt),
      detachedAt: iso(method.detachedAt),
      createdAt: iso(method.createdAt),
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

    wishlist: wishlist.map((item) => ({
      productName: item.product.name,
      sku: item.product.sku,
      // The empty string means the base product rather than a variant. Sent as
      // null so the subject reads an absence rather than a sentinel.
      variantId: item.variantKey === '' ? null : item.variantKey,
      savedAt: iso(item.createdAt),
    })),

    productInstructions: productInstructions.map((instruction) => ({
      productName: instruction.product.name,
      sku: instruction.product.sku,
      // As above: the sentinel becomes an absence on the way out, so the
      // subject reads "about the product" rather than an empty string.
      variantId: instruction.variantKey === '' ? null : instruction.variantKey,
      instruction: instruction.body,
      writtenAt: iso(instruction.createdAt),
      // There is one row per product and editing replaces it, so this is when
      // they last changed their mind — which is part of the record.
      lastChangedAt: iso(instruction.updatedAt),
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

    // The one thing in this feature that IS the subject's: their standing
    // authority to be charged, and the evidence of when they gave it. The ERP
    // connection itself belongs to the business - it is the company's
    // integration with its own supplier system, not a fact about this person -
    // so nothing about it appears here.
    // The consent itself, which is the part that matters: it is the evidence
    // this subject would want if they ever disputed a charge.
    autoPayAuthority: await (async () => {
      const settings = await prisma.customerAutoPaySetting.findUnique({
        where: { customerProfileId: profile?.id ?? '' },
      });

      if (settings === null) return null;

      return {
        status: settings.status,
        maxTransactionMinor: money(settings.maxTransactionMinor),
        approvalThresholdMinor: money(settings.approvalThresholdMinor),
        limitCurrency: settings.limitCurrency,
        retryPreference: settings.retryPreference,
        notifyOnCharge: settings.notifyOnCharge,
        notifyOnFailure: settings.notifyOnFailure,
        consentAcceptedAt: iso(settings.consentAcceptedAt),
        consentVersion: settings.consentVersion,
        consentWithdrawnAt: iso(settings.consentWithdrawnAt),
        // The hash of the address consent came from is reported as present
        // rather than disclosed: it is a hash, so it tells the subject nothing
        // they do not know, and reversing it is exactly what it exists to
        // prevent.
        consentEvidenceHeld: settings.consentIpHash !== null,
        consentUserAgent: settings.consentUserAgent,
        enabledAt: iso(settings.enabledAt),
        pausedAt: iso(settings.pausedAt),
      };
    })(),

    /**
     * Which buyer organisation this person belongs to, and what they may do
     * in it.
     *
     * Their MEMBERSHIP is theirs - it says where they work and what authority
     * they hold there, which is plainly a fact about them. The organisation's
     * ERP connection is not: it is the company's integration with its own
     * purchasing system, configured by whoever holds the role rather than
     * being a fact about any individual, and it would still exist unchanged if
     * this person left tomorrow. So the role is disclosed and the credentials,
     * mappings and purchase orders behind it are not.
     *
     * Null for the great majority of accounts, which belong to no
     * organisation because nobody has opened the integrations area.
     */
    /**
     * Delivery options offered to this person, newest first.
     *
     * Capped, because a customer who reloads a checkout page a dozen times
     * generates a dozen sets of these and a subject access request is not
     * improved by four hundred near-identical rows. The cap is stated in the
     * data rather than applied silently - a bundle that quietly truncated
     * would be an incomplete answer presented as a complete one - and the
     * count says how many there were altogether.
     *
     * The basket digest is deliberately absent: it is an internal integrity
     * check, it identifies nothing about the person, and a sixty-four
     * character hash in a file a human is meant to read is noise.
     */
    fulfilmentQuotes: await (async () => {
      const LIMIT = 100;

      const [rows, total] = await Promise.all([
        prisma.fulfilmentQuote.findMany({
          where: { customerProfileId: profile.id },
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
          include: { location: { select: { code: true, name: true } } },
        }),
        prisma.fulfilmentQuote.count({ where: { customerProfileId: profile.id } }),
      ]);

      return {
        total,
        disclosed: rows.length,
        ...(total > rows.length
          ? {
              note: `The ${String(LIMIT)} most recent are listed. Ask for the rest and they will be sent.`,
            }
          : {}),
        quotes: rows.map((quote) => ({
          offeredAt: iso(quote.createdAt),
          warehouse: `${quote.location.code} - ${quote.location.name}`,
          carrier: quote.carrierName,
          serviceLevel: quote.serviceLevel,
          destinationCountry: quote.destinationCountry,
          destinationPostalCode: quote.destinationPostalCode,
          // An estimate taken against a country rather than an address. Said
          // out loud, because it is the difference between an offer and a
          // conversation.
          wasEstimate: quote.isEstimate,
          currency: quote.currency,
          subtotalMinor: money(quote.subtotalMinor),
          discountMinor: money(quote.discountMinor),
          taxMinor: money(quote.taxMinor),
          shippingMinor: money(quote.shippingMinor),
          grandTotalMinor: money(quote.grandTotalMinor),
          // Calendar days, as they were shown. Not timestamps - "arrives on
          // the 18th" is the 18th wherever it is read.
          dispatchDate: quote.dispatchDate.toISOString().slice(0, 10),
          deliveryFromDate: quote.deliveryFromDate.toISOString().slice(0, 10),
          deliveryToDate: quote.deliveryToDate.toISOString().slice(0, 10),
          expiredAt: iso(quote.expiresAt),
        })),
      };
    })(),

    /*
     * Freight prices this person asked for, and what came back.
     *
     * A pallet or a container cannot be priced by a parcel API, so the order
     * raises a request and a person at the seller or the freight desk answers
     * it. That exchange is about a named individual's order, so it is theirs.
     *
     * What is NOT here is the seller's side of it: which carrier they
     * approached, what it cost them, what margin they took. That is the
     * seller's commercial data and belongs to the seller, exactly as the
     * warehouse's own costs are absent from `fulfilmentQuotes` above. The line
     * is drawn at what was said TO this person.
     */
    freightQuoteRequests: await (async () => {
      const LIMIT = 100;

      const where = { requestedByProfileId: profile?.id ?? '' };

      const [rows, total] = await Promise.all([
        prisma.sellerFreightQuoteRequest.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
        }),
        prisma.sellerFreightQuoteRequest.count({ where }),
      ]);

      return {
        total,
        disclosed: rows.length,
        ...(total > rows.length
          ? {
              note: `The ${String(LIMIT)} most recent are listed. Ask for the rest and they will be sent.`,
            }
          : {}),
        requests: rows.map((request) => ({
          askedAt: iso(request.createdAt),
          status: request.state,
          loadType: request.loadType,
          packages: request.totalPackages,
          baseUnits: request.totalBaseUnits,
          cartons: request.totalCartons,
          pallets: request.totalPallets,
          containers: request.totalContainers,
          grossWeightGrams: request.grossWeightGrams?.toString() ?? null,
          originCountry: request.originCountry,
          destinationCountry: request.destinationCountry,
          incoterm: request.incoterm,
          // The answer, where there is one. Null throughout while it is still
          // REQUESTED, which is an honest shape rather than a missing row: the
          // question was asked and nobody has answered it.
          quotedAmountMinor:
            request.quotedAmountMinor === null ? null : money(request.quotedAmountMinor),
          quotedCurrency: request.quotedCurrency,
          serviceName: request.serviceName,
          expectedPickupAt: iso(request.expectedPickupAt),
          expectedDeliveryAt: iso(request.expectedDeliveryAt),
          quoteExpiresAt: iso(request.quoteExpiresAt),
          // The note the freight desk left, which was written to be read by
          // this person. `quotedByUserId` is deliberately absent: which member
          // of the seller's staff answered is that person's data, not this
          // one's - the same line `organisationMembership` draws below.
          response: request.responseNote,
          answeredAt: iso(request.quotedAt),
        })),
      };
    })(),

    preorderRequests: await (async () => {
      const LIMIT = 100;
      const where = { customerProfileId: profile?.id ?? '' };

      const [rows, total] = await Promise.all([
        prisma.preorderRequest.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          take: LIMIT,
          include: {
            offers: { orderBy: { revision: 'asc' } },
            history: { orderBy: { createdAt: 'asc' } },
            sellerAccount: { select: { displayName: true } },
          },
        }),
        prisma.preorderRequest.count({ where }),
      ]);

      return {
        total,
        disclosed: rows.length,
        ...(total > rows.length
          ? {
              note: `The ${String(LIMIT)} most recent are listed. Ask for the rest and they will be sent.`,
            }
          : {}),
        requests: rows.map((request) => ({
          requestNumber: request.requestNumber,
          // Null seller: the operator's own product, answered by the operator.
          seller: request.sellerAccount?.displayName ?? 'The operator of this store',
          status: request.status,
          askedAt: iso(request.submittedAt),
          baseUnits: request.requestedBaseUnits,
          orderingUnit: request.orderingUnit,
          unitQuantity: request.unitQuantity,
          requestedDeliveryDate: iso(request.requestedDeliveryDate),
          deliveryAddress: request.shippingAddressJson,
          purchaseOrderReference: request.purchaseOrderReference,
          notes: request.customerNotes,
          handlingInstructions: request.handlingInstructions,
          currency: request.currency,
          indicativeTotalMinor:
            request.indicativeTotalMinor === null ? null : money(request.indicativeTotalMinor),
          // Every set of terms proposed to this person, and what they said.
          // Which member of the seller's staff wrote each is that person's
          // data, so only the seller's name is given.
          terms: request.offers.map((offer) => ({
            revision: offer.revision,
            state: offer.state,
            quantityBaseUnits: offer.quantityBaseUnits,
            unitPriceMinor: money(offer.unitPriceMinor),
            freightMinor: money(offer.freightMinor),
            committedDeliveryDate: iso(offer.committedDeliveryDate),
            note: offer.note,
            proposedAt: iso(offer.createdAt),
            answeredAt: iso(offer.respondedAt),
            answer: offer.responseNote,
          })),
          confirmedTermsHash: request.confirmedTermsHash,
          convertedOrderId: request.convertedOrderId,
          history: request.history.map((entry) => ({
            from: entry.fromStatus,
            to: entry.toStatus,
            at: iso(entry.createdAt),
            reason: entry.reason,
          })),
        })),
      };
    })(),

    organisationMembership: await (async () => {
      const membership = await prisma.buyerOrganizationMember.findUnique({
        where: { customerProfileId: profile?.id ?? '' },
        include: { organization: { select: { name: true, createdAt: true } } },
      });

      if (membership === null) return null;

      return {
        organisationName: membership.organization.name,
        role: membership.role,
        joinedAt: iso(membership.joinedAt),
        // Whether somebody invited them, not who: the inviter is a different
        // person, and their identity is that person's data rather than this
        // subject's.
        joinedByInvitation: membership.invitedByProfileId !== null,
      };
    })(),

    /*
     * Their place in a seller organisation, if they sell here.
     *
     * The same shape and the same line as `organisationMembership` above: what
     * the business is called, what authority this person holds in it, and when
     * they got it. Not the business's catalogue, stock, orders or money - those
     * belong to the company, and a departing employee is not entitled to a copy
     * of their former employer's sales.
     *
     * `removedAt` is not filtered out. A former membership is still a fact
     * about this person and is still held, so a copy of what is held has to
     * include it.
     */
    sellerMembership: await (async () => {
      const membership = await prisma.sellerMember.findUnique({
        where: { customerProfileId: profile?.id ?? '' },
        include: { sellerAccount: { select: { displayName: true, legalName: true } } },
      });

      if (membership === null) return null;

      return {
        sellerName: membership.sellerAccount.displayName,
        registeredName: membership.sellerAccount.legalName,
        role: membership.role,
        joinedAt: iso(membership.joinedAt),
        // Whether somebody invited them, not who - the inviter is a different
        // person, and their identity is that person's data.
        joinedByInvitation: membership.invitedByProfileId !== null,
        removedAt: iso(membership.removedAt),
      };
    })(),

    /**
     * Where they work as a CARRIER, and what they drive.
     *
     * The same line as the two memberships above: what the company is called,
     * what authority this person holds in it, and - where they are a driver -
     * the certifications and consent recorded against them. Not the carrier's
     * consignments, which are somebody else's goods going to a third party's
     * address.
     *
     * Consent is disclosed as BOTH timestamps rather than as a boolean,
     * because "never agreed" and "agreed and later withdrew" are different
     * facts and a subject checking whether their employer switched it on for
     * them needs to see which.
     */
    logisticsMembership: await (async () => {
      const membership = await prisma.logisticsPartnerUser.findUnique({
        where: { userId: subject.userId },
        select: {
          role: true,
          status: true,
          fullName: true,
          jobTitle: true,
          createdAt: true,
          disabledAt: true,
          partner: { select: { displayName: true, legalName: true } },
          driverProfile: {
            select: {
              state: true,
              employeeReference: true,
              licenceExpiresAt: true,
              canCarryDangerousGoods: true,
              canCarryColdChain: true,
              canCarrySterile: true,
              locationConsentAt: true,
              locationConsentWithdrawnAt: true,
            },
          },
        },
      });

      if (membership === null) return null;

      return {
        carrierName: membership.partner.displayName,
        registeredName: membership.partner.legalName,
        nameOnRecord: membership.fullName,
        jobTitle: membership.jobTitle,
        role: membership.role,
        status: membership.status,
        joinedAt: iso(membership.createdAt),
        accessRemovedAt: iso(membership.disabledAt),
        driver:
          membership.driverProfile === null
            ? null
            : {
                state: membership.driverProfile.state,
                employeeReference: membership.driverProfile.employeeReference,
                licenceExpiresAt: iso(membership.driverProfile.licenceExpiresAt),
                clearedForDangerousGoods: membership.driverProfile.canCarryDangerousGoods,
                clearedForColdChain: membership.driverProfile.canCarryColdChain,
                clearedForSterileHandling: membership.driverProfile.canCarrySterile,
                locationSharingAgreedAt: iso(membership.driverProfile.locationConsentAt),
                locationSharingWithdrawnAt: iso(
                  membership.driverProfile.locationConsentWithdrawnAt,
                ),
              },
      };
    })(),

    /**
     * Every position recorded about this person, while they were on duty.
     *
     * Capped at the most recent 5,000, and the cap is stated in the row rather
     * than applied silently - a subject who received a truncated file that
     * looked complete would have been given a misleading answer to a legal
     * question. Anything older has already been deleted by the retention
     * sweep, which is why the cap is rarely reached.
     */
    logisticsLocationHistory: await (async () => {
      const driver = await prisma.logisticsDriverProfile.findFirst({
        where: { partnerUser: { userId: subject.userId } },
        select: { id: true },
      });

      if (driver === null) return null;

      const total = await prisma.logisticsLocationPing.count({
        where: { driverProfileId: driver.id },
      });

      const pings = await prisma.logisticsLocationPing.findMany({
        where: { driverProfileId: driver.id },
        orderBy: { deviceTimestamp: 'desc' },
        take: 5000,
        select: {
          latitude: true,
          longitude: true,
          accuracyM: true,
          speedMps: true,
          deviceTimestamp: true,
          receivedAt: true,
        },
      });

      return {
        totalRecorded: total,
        includedInThisCopy: pings.length,
        note:
          total > pings.length
            ? 'The most recent 5,000 positions are included. Ask for the rest if you need them.'
            : 'Every position held about you is included.',
        positions: pings.map((ping) => ({
          latitude: ping.latitude.toString(),
          longitude: ping.longitude.toString(),
          accuracyMetres: ping.accuracyM,
          speedMetresPerSecond: ping.speedMps === null ? null : ping.speedMps.toString(),
          recordedByDeviceAt: iso(ping.deviceTimestamp),
          receivedAt: iso(ping.receivedAt),
        })),
      };
    })(),
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
