/**
 * Reusable payment instruments, and the consent that makes them chargeable.
 *
 * This is the enrolment half of auto-pay. Nothing here moves money; it turns a
 * card the customer is looking at into a reference that can be charged weeks
 * later while they are asleep. That is a serious thing to hold, so the rules
 * are narrow and stated once, here:
 *
 *   1. **The provider is the authority on what was enrolled.** A browser
 *      saying "the setup succeeded" is not evidence - it is an unauthenticated
 *      claim about somebody else's money. Every stored instrument is built from
 *      a server-side re-read of the SetupIntent, which is the same rule that
 *      stops a client redirect confirming a payment.
 *
 *   2. **No card data, ever.** What lands in the database is a customer
 *      reference, a payment-method reference, and the six display fields
 *      Stripe itself hands back so a person can tell which card they picked.
 *      No PAN, no CVV, no client secret. The client secret in particular is a
 *      short-lived capability and a database is the wrong place for one.
 *
 *   3. **Consent is a record, not a checkbox.** `consentVersion` is stored so
 *      that changing the terms can require a fresh agreement rather than
 *      quietly inheriting the old one, and the IP is hashed rather than kept -
 *      it is evidence that consent came from somewhere, and there is no reason
 *      to make this table a worse thing to leak than it has to be.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { loadActiveProvider } from './payment.service.js';
import { supportsOffSession, type OffSessionProvider } from './provider.js';

/**
 * The consent text version a new enrolment is recorded against.
 *
 * Bump this when the wording of the auto-pay agreement changes. Existing
 * instruments keep the version they were agreed under, so a deployment can
 * tell who has and has not accepted the current terms.
 */
export const OFF_SESSION_CONSENT_VERSION = 'v1';

export interface PaymentMethodActor {
  userId: string;
  email: string;
  type: 'ADMIN' | 'CUSTOMER';
  ipAddress?: string | null;
  userAgent?: string | null;
  correlationId?: string | null;
}

/**
 * Resolve the active gateway, insisting it can charge off-session.
 *
 * Refused up front rather than at the first occurrence. A deployment running
 * only Razorpay cannot store a card for later under this design - its
 * e-mandate flow is a different shape - and the customer should be told that
 * while they are on the page, not by a subscription that silently never
 * charges.
 */
async function loadOffSessionProvider(): Promise<{
  provider: OffSessionProvider;
  connectionId: string;
}> {
  // STRIPE preferred explicitly: it is the gateway this path is built on, and
  // asking for it means a deployment with both connected does not enrol a card
  // against whichever was configured most recently.
  const loaded = await loadActiveProvider('STRIPE');

  if (!supportsOffSession(loaded.provider)) {
    throw badRequest(
      ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
      `${loaded.kind} cannot store a payment method for automatic future charges. ` +
        'Ask an administrator to connect Stripe, or choose to pay by link for each order.',
    );
  }

  return { provider: loaded.provider, connectionId: loaded.connectionId };
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

export interface BeginEnrolmentResult {
  setupIntentId: string;
  clientSecret: string;
  publishableKey: string;
  provider: 'STRIPE';
}

/**
 * Start enrolling a reusable instrument.
 *
 * Reuses the customer's existing provider customer id when they already have
 * one, so a second card attaches to the same provider-side record instead of
 * creating a parallel one their first card cannot be found from.
 */
export async function beginPaymentMethodEnrolment(
  customerProfileId: string,
  actor: PaymentMethodActor,
): Promise<BeginEnrolmentResult> {
  const { provider } = await loadOffSessionProvider();

  const profile = await prisma.customerProfile.findUnique({
    where: { id: customerProfileId },
    select: { id: true, fullName: true, user: { select: { email: true } } },
  });

  if (profile === null) throw notFound('Customer');

  // Any instrument of theirs will do - they all hang off the same provider
  // customer. DETACHED ones included: the provider customer outlives the card.
  const existing = await prisma.customerPaymentMethod.findFirst({
    where: { customerProfileId, provider: 'STRIPE' },
    orderBy: { createdAt: 'desc' },
    select: { providerCustomerId: true },
  });

  const setup = await provider.createSetupIntent({
    providerCustomerId: existing?.providerCustomerId ?? null,
    customerEmail: profile.user.email,
    customerName: profile.fullName,
    customerProfileId,
    // Keyed on the customer and a coarse time bucket rather than a fresh
    // random value: a double-clicked "add a card" button reuses one
    // SetupIntent, while a genuine second attempt ten minutes later gets its
    // own. A per-request key would defeat the point; a per-customer key would
    // never let them retry.
    idempotencyKey: `setup:${customerProfileId}:${String(Math.floor(Date.now() / 600_000))}`,
  });

  await recordAudit({
    action: AuditAction.PAYMENT_METHOD_SETUP_STARTED,
    resourceType: 'customer_payment_method',
    resourceId: setup.setupIntentId,
    actorType: actor.type,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { setupIntentId: setup.setupIntentId, provider: 'STRIPE' },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return {
    setupIntentId: setup.setupIntentId,
    clientSecret: setup.clientSecret,
    publishableKey: setup.publishableKey,
    provider: 'STRIPE',
  };
}

export interface CompleteEnrolmentInput {
  customerProfileId: string;
  setupIntentId: string;
  /** Must be true. The customer is authorising charges they will not see. */
  consentAccepted: boolean;
  consentVersion?: string;
  makeDefault?: boolean;
}

export interface StoredPaymentMethodView {
  id: string;
  provider: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  funding: string | null;
  status: string;
  isDefault: boolean;
  consentAcceptedAt: string;
  consentVersion: string;
  createdAt: string;
}

/**
 * Finish enrolment and store the instrument.
 *
 * Idempotent by construction: `(provider, providerPaymentMethodId)` is unique,
 * so a customer who submits the confirmation twice - or a webhook that arrives
 * alongside their browser doing the same thing - ends up with one row. The
 * second caller is handed the row the first one created rather than an error,
 * because from the customer's point of view nothing went wrong.
 */
export async function completePaymentMethodEnrolment(
  input: CompleteEnrolmentInput,
  actor: PaymentMethodActor,
): Promise<StoredPaymentMethodView> {
  if (!input.consentAccepted) {
    throw badRequest(
      ErrorCode.PAYMENT_SETUP_CONSENT_REQUIRED,
      'You must agree to future automatic charges before this card can be saved.',
      [{ field: 'consentAccepted', code: 'CONSENT_REQUIRED' }],
    );
  }

  const { provider } = await loadOffSessionProvider();

  // The authority. Never the client's word for it.
  const setup = await provider.fetchSetupIntent(input.setupIntentId);

  if (setup.status !== 'succeeded') {
    throw conflict(
      ErrorCode.PAYMENT_SETUP_INCOMPLETE,
      'That card has not finished being set up. Please complete the card details and try again.',
      [{ code: 'SETUP_STATUS', meta: { status: setup.status } }],
    );
  }

  if (setup.providerPaymentMethodId === null || setup.providerCustomerId === null) {
    throw conflict(
      ErrorCode.PAYMENT_SETUP_INCOMPLETE,
      'The card setup completed without producing a reusable payment method.',
    );
  }

  const existing = await prisma.customerPaymentMethod.findUnique({
    where: {
      provider_providerPaymentMethodId: {
        provider: 'STRIPE',
        providerPaymentMethodId: setup.providerPaymentMethodId,
      },
    },
  });

  if (existing !== null) {
    // Somebody else's instrument arriving under this customer would be a
    // serious mix-up, and quietly returning it would hand one customer a
    // reference to another's card. Refuse rather than reconcile.
    if (existing.customerProfileId !== input.customerProfileId) {
      logger.error(
        {
          paymentMethodId: existing.id,
          expectedCustomerProfileId: input.customerProfileId,
          actualCustomerProfileId: existing.customerProfileId,
        },
        'a setup intent resolved to a payment method belonging to another customer',
      );

      throw conflict(
        ErrorCode.PAYMENT_SETUP_INCOMPLETE,
        'That card is already saved to a different account.',
      );
    }

    return toView(existing);
  }

  const id = newId();
  const now = new Date();

  // First instrument becomes the default without being asked: a customer with
  // exactly one saved card has no meaningful choice to make.
  const otherCount = await prisma.customerPaymentMethod.count({
    where: { customerProfileId: input.customerProfileId, status: 'ACTIVE' },
  });

  const shouldBeDefault = input.makeDefault === true || otherCount === 0;

  const created = await prisma.$transaction(async (tx) => {
    if (shouldBeDefault) {
      // One default per customer. Enforced here rather than in the schema:
      // MariaDB 10.4 has no partial unique index to express it with.
      await tx.customerPaymentMethod.updateMany({
        where: { customerProfileId: input.customerProfileId, isDefault: true },
        data: { isDefault: false },
      });
    }

    const row = await tx.customerPaymentMethod.create({
      data: {
        id,
        customerProfileId: input.customerProfileId,
        provider: 'STRIPE',
        providerCustomerId: setup.providerCustomerId ?? '',
        providerPaymentMethodId: setup.providerPaymentMethodId ?? '',
        setupIntentId: setup.setupIntentId,
        brand: setup.card?.brand ?? null,
        last4: setup.card?.last4 ?? null,
        expMonth: setup.card?.expMonth ?? null,
        expYear: setup.card?.expYear ?? null,
        funding: setup.card?.funding ?? null,
        country: setup.card?.country ?? null,
        status: 'ACTIVE',
        consentAcceptedAt: now,
        consentVersion: input.consentVersion ?? OFF_SESSION_CONSENT_VERSION,
        // Hashed. See the header.
        consentIpHash:
          actor.ipAddress === null || actor.ipAddress === undefined
            ? null
            : sha256Hex(actor.ipAddress),
        consentUserAgent: actor.userAgent?.slice(0, 256) ?? null,
        isDefault: shouldBeDefault,
      },
    });

    await recordAudit(
      {
        action: AuditAction.PAYMENT_METHOD_SAVED,
        resourceType: 'customer_payment_method',
        resourceId: id,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        after: {
          provider: 'STRIPE',
          // The brand and last four are what a person needs to recognise the
          // card in an audit trail. The references are not recorded: they are
          // chargeable, and an audit log is read by more people than this
          // table is.
          brand: row.brand,
          last4: row.last4,
          consentVersion: row.consentVersion,
          isDefault: row.isDefault,
        },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );

    return row;
  });

  return toView(created);
}

// ---------------------------------------------------------------------------
// Listing, defaults, removal
// ---------------------------------------------------------------------------

type PaymentMethodRow = Awaited<
  ReturnType<typeof prisma.customerPaymentMethod.findFirstOrThrow>
>;

function toView(row: PaymentMethodRow): StoredPaymentMethodView {
  return {
    id: row.id,
    provider: row.provider,
    brand: row.brand,
    last4: row.last4,
    expMonth: row.expMonth,
    expYear: row.expYear,
    funding: row.funding,
    status: row.status,
    isDefault: row.isDefault,
    consentAcceptedAt: row.consentAcceptedAt.toISOString(),
    consentVersion: row.consentVersion,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listPaymentMethods(
  customerProfileId: string,
): Promise<StoredPaymentMethodView[]> {
  const rows = await prisma.customerPaymentMethod.findMany({
    // DETACHED ones are not shown: a removed card is removed. They are kept in
    // the table because live plans and past occurrences reference them.
    where: { customerProfileId, status: { in: ['ACTIVE', 'EXPIRED'] } },
    orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
  });

  return rows.map(toView);
}

/**
 * Load an instrument, scoped to its owner.
 *
 * `customerProfileId` of null means an administrator, who is not scoped. Every
 * customer-facing caller passes theirs, which is what makes one customer
 * unable to name another's card.
 */
export async function loadOwnedPaymentMethod(
  paymentMethodId: string,
  customerProfileId: string | null,
): Promise<PaymentMethodRow> {
  const row = await prisma.customerPaymentMethod.findFirst({
    where: {
      id: paymentMethodId,
      ...(customerProfileId !== null ? { customerProfileId } : {}),
    },
  });

  if (row === null) throw notFound('Payment method');
  return row;
}

export async function setDefaultPaymentMethod(
  paymentMethodId: string,
  customerProfileId: string,
  actor: PaymentMethodActor,
): Promise<StoredPaymentMethodView> {
  const row = await loadOwnedPaymentMethod(paymentMethodId, customerProfileId);

  if (row.status !== 'ACTIVE') {
    throw conflict(
      ErrorCode.SCHEDULE_PAYMENT_METHOD_INVALID,
      'That card can no longer be used. Add a new one instead.',
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.customerPaymentMethod.updateMany({
      where: { customerProfileId, isDefault: true },
      data: { isDefault: false },
    });

    return tx.customerPaymentMethod.update({
      where: { id: paymentMethodId },
      data: { isDefault: true },
    });
  });

  await recordAudit({
    action: AuditAction.PAYMENT_METHOD_UPDATED,
    resourceType: 'customer_payment_method',
    resourceId: paymentMethodId,
    actorType: actor.type,
    actorUserId: actor.userId,
    actorEmail: actor.email,
    after: { isDefault: true },
    ipAddress: actor.ipAddress ?? null,
    correlationId: actor.correlationId ?? null,
  });

  return toView(updated);
}

/**
 * Remove an instrument.
 *
 * Refused while a live plan depends on it, and the refusal names the plans.
 * Silently detaching would leave a subscription that fails at its next
 * occurrence for a reason the customer could not have anticipated - and they
 * would find out when a delivery did not arrive.
 *
 * The row is marked DETACHED rather than deleted: past occurrences and audit
 * records point at it, and a foreign key with `Restrict` would refuse the
 * delete anyway.
 */
export async function removePaymentMethod(
  paymentMethodId: string,
  customerProfileId: string | null,
  actor: PaymentMethodActor,
): Promise<void> {
  const row = await loadOwnedPaymentMethod(paymentMethodId, customerProfileId);

  const dependants = await prisma.recurringSchedule.findMany({
    where: {
      paymentMethodId,
      // A cancelled or completed plan will never charge again, so it does not
      // block removal. DRAFT does not either: nothing has been authorised.
      status: { in: ['ACTIVE', 'PAUSED', 'FAILED'] },
    },
    select: { id: true, name: true, status: true },
    take: 10,
  });

  if (dependants.length > 0) {
    throw conflict(
      ErrorCode.PAYMENT_METHOD_IN_USE,
      dependants.length === 1
        ? `This card pays for your scheduled order "${dependants[0]?.name ?? ''}". ` +
            'Change that order to another card, or cancel it, before removing this one.'
        : `This card pays for ${String(dependants.length)} of your scheduled orders. ` +
            'Change them to another card, or cancel them, before removing this one.',
      dependants.map((schedule) => ({
        code: 'SCHEDULE_DEPENDS_ON_METHOD',
        meta: { scheduleId: schedule.id, name: schedule.name, status: schedule.status },
      })),
    );
  }

  // Detach at the provider first. Marking our row DETACHED while the provider
  // still holds a chargeable card would leave the two disagreeing about
  // something that can take money.
  try {
    const { provider } = await loadOffSessionProvider();
    await provider.detachPaymentMethod(row.providerPaymentMethodId);
  } catch (error) {
    // An already-detached card, or one Stripe has never heard of, is the state
    // being asked for. Anything else and the customer is told it failed rather
    // than shown a card that is gone here and live there.
    const message = error instanceof Error ? error.message : 'unknown error';
    const alreadyGone = /No such PaymentMethod|resource_missing|not attached/i.test(message);

    if (!alreadyGone) {
      logger.error(
        { err: error, paymentMethodId },
        'could not detach a payment method at the provider',
      );
      throw conflict(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        'That card could not be removed just now. Please try again in a moment.',
      );
    }

    logger.info(
      { paymentMethodId },
      'payment method was already detached at the provider; marking it removed here',
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.customerPaymentMethod.update({
      where: { id: paymentMethodId },
      data: { status: 'DETACHED', detachedAt: new Date(), isDefault: false },
    });

    await recordAudit(
      {
        action: AuditAction.PAYMENT_METHOD_REMOVED,
        resourceType: 'customer_payment_method',
        resourceId: paymentMethodId,
        actorType: actor.type,
        actorUserId: actor.userId,
        actorEmail: actor.email,
        before: { status: row.status, brand: row.brand, last4: row.last4 },
        after: { status: 'DETACHED' },
        ipAddress: actor.ipAddress ?? null,
        correlationId: actor.correlationId ?? null,
      },
      tx,
    );
  });
}

/**
 * Assert an instrument can be charged off-session right now.
 *
 * Called at enrolment AND again at every occurrence, because the answer
 * changes: cards expire, and customers detach them in Stripe's own portal
 * without telling this system.
 */
export function assertChargeable(row: {
  status: string;
  expMonth: number | null;
  expYear: number | null;
}): void {
  if (row.status !== 'ACTIVE') {
    throw conflict(
      ErrorCode.SCHEDULE_PAYMENT_METHOD_INVALID,
      'The saved card for this schedule is no longer usable. Please add a new one.',
      [{ code: 'METHOD_STATUS', meta: { status: row.status } }],
    );
  }

  if (row.expMonth !== null && row.expYear !== null) {
    const now = new Date();
    // A card is good through the last day of its expiry month, so the
    // comparison is against the FIRST day of the month after it.
    const expiresAfter = new Date(Date.UTC(row.expYear, row.expMonth, 1));

    if (now >= expiresAfter) {
      throw conflict(
        ErrorCode.SCHEDULE_PAYMENT_METHOD_INVALID,
        'The saved card for this schedule has expired. Please add a new one.',
        [{ code: 'METHOD_EXPIRED', meta: { expMonth: row.expMonth, expYear: row.expYear } }],
      );
    }
  }
}

/**
 * Mark an instrument expired, so it stops being offered.
 *
 * Called from the charge path when the provider reports an expiry we had not
 * noticed - the stored month and year are what Stripe knew at enrolment, and a
 * reissued card can lapse earlier than that.
 */
export async function markPaymentMethodExpired(paymentMethodId: string): Promise<void> {
  await prisma.customerPaymentMethod.updateMany({
    where: { id: paymentMethodId, status: 'ACTIVE' },
    data: { status: 'EXPIRED', isDefault: false },
  });
}
