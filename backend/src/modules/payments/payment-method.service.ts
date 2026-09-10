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
import { fundingFor, type PaymentInstrument } from '../../domain/payment-instrument.js';
import { sha256Hex } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { loadActiveProvider } from './payment.service.js';
import {
  supportsCardVault,
  supportsOffSession,
  type OffSessionProvider,
  type VaultedCardDetails,
} from './provider.js';

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
  /**
   * Which instrument this card is offered under at a checkout, derived from
   * the provider's own `funding`.
   *
   * Null when the provider would not say - a prepaid card, or one it reports
   * as `unknown`. Such a card is still perfectly usable; it simply appears
   * under both Credit and Debit rather than being filed wrongly under one.
   */
  instrument: PaymentInstrument | null;
  /**
   * What its owner agreed to. See `PaymentConsentScope` in the schema.
   *
   * Sent to the storefront because the two scopes are not interchangeable
   * there either: only an OFF_SESSION card may be picked for a scheduled
   * order, and a screen that offered a CHECKOUT one would be offering
   * something the server is about to refuse.
   */
  consentScope: string;
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
        // Stated rather than left to the column default. This function is the
        // auto-pay enrolment path and only ever the auto-pay enrolment path -
        // the customer has just agreed to charges they will not see - and a
        // reader should not have to go to the schema to learn that.
        consentScope: 'OFF_SESSION',
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

/**
 * The consent text version a card saved at a checkout is recorded against.
 *
 * Separate from `OFF_SESSION_CONSENT_VERSION` and versioned separately,
 * because the two say different things and will change for different reasons.
 * This one is "keep this so I need not type it again"; the other authorises
 * charges nobody is watching.
 */
export const CHECKOUT_CONSENT_VERSION = 'checkout-v1';

export interface RecordVaultedCardInput {
  customerProfileId: string;
  provider: 'RAZORPAY' | 'STRIPE';
  card: VaultedCardDetails;
  /** Where the consent came from, for the record. Hashed before storage. */
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Store a card the customer asked to keep while paying for an order.
 *
 * The counterpart to `completePaymentMethodEnrolment`, for the other way a
 * card can come to be stored, and it differs in three ways that matter:
 *
 *   1. **The consent is narrower.** `CHECKOUT`, not `OFF_SESSION`. Nothing may
 *      charge this card without the customer present, and `assertChargeable`
 *      is what makes that true rather than a comment.
 *
 *   2. **The trigger is a verified webhook, not a browser.** The customer's
 *      tab said nothing; a signature-checked capture event did, and the card's
 *      display fields were then read back from the gateway. So the same rule
 *      holds as everywhere else here: the provider is the authority.
 *
 *   3. **It must never break the payment.** A card that fails to store is a
 *      customer who has to type it again next time. An exception escaping into
 *      the capture path would be an order that never reaches CONFIRMED - money
 *      taken, nothing delivered. So this returns null on trouble and the
 *      caller carries on.
 *
 * Idempotent on `(provider, providerPaymentMethodId)`, which is a unique index.
 * A re-delivered webhook finds the existing row and changes nothing.
 */
export async function recordCardSavedAtCheckout(
  input: RecordVaultedCardInput,
): Promise<StoredPaymentMethodView | null> {
  const { card } = input;

  if (card.providerTokenId.length === 0) return null;

  const existing = await prisma.customerPaymentMethod.findUnique({
    where: {
      provider_providerPaymentMethodId: {
        provider: input.provider,
        providerPaymentMethodId: card.providerTokenId,
      },
    },
  });

  if (existing !== null) {
    // Somebody else's card arriving under this customer would be a serious
    // mix-up. Refused rather than reconciled - the same rule the enrolment
    // path applies, and for the same reason.
    if (existing.customerProfileId !== input.customerProfileId) {
      logger.error(
        {
          paymentMethodId: existing.id,
          expectedCustomerProfileId: input.customerProfileId,
          actualCustomerProfileId: existing.customerProfileId,
        },
        'a payment tokenised a card that is already saved to another customer',
      );
      return null;
    }

    return toView(existing);
  }

  /*
   * Default only when there is nothing else.
   *
   * `isDefault` is what the auto-pay screen preselects, and a card saved at a
   * checkout cannot be used there. Making one the default whenever it is
   * newest would put a card in that box which the server then refuses, and the
   * customer would have no idea why. With no other card at all the field is
   * simply the only answer available.
   */
  const otherCount = await prisma.customerPaymentMethod.count({
    where: { customerProfileId: input.customerProfileId, status: 'ACTIVE' },
  });

  const id = newId();

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.customerPaymentMethod.create({
        data: {
          id,
          customerProfileId: input.customerProfileId,
          provider: input.provider,
          providerCustomerId: card.providerCustomerId ?? '',
          providerPaymentMethodId: card.providerTokenId,
          brand: card.brand,
          last4: card.last4,
          expMonth: card.expMonth,
          expYear: card.expYear,
          funding: card.funding,
          country: card.country,
          status: 'ACTIVE',
          consentScope: 'CHECKOUT',
          consentAcceptedAt: new Date(),
          consentVersion: CHECKOUT_CONSENT_VERSION,
          consentIpHash:
            input.ipAddress === null || input.ipAddress === undefined
              ? null
              : sha256Hex(input.ipAddress),
          consentUserAgent: input.userAgent?.slice(0, 256) ?? null,
          isDefault: otherCount === 0,
        },
      });

      await recordAudit(
        {
          action: AuditAction.PAYMENT_METHOD_SAVED,
          resourceType: 'customer_payment_method',
          resourceId: id,
          // The gateway reported it, off a verified event. No human did this.
          actorType: 'PROVIDER',
          actorUserId: null,
          after: {
            provider: input.provider,
            brand: row.brand,
            last4: row.last4,
            consentScope: 'CHECKOUT',
            consentVersion: row.consentVersion,
          },
        },
        tx,
      );

      return row;
    });

    return toView(created);
  } catch (error) {
    // Storing the card is a convenience; the payment behind it is not. See
    // point 3 in the header.
    logger.error(
      { err: error, provider: input.provider },
      'could not store a card the customer saved at checkout',
    );
    return null;
  }
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
    instrument: fundingFor(row.funding),
    consentScope: row.consentScope,
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
  //
  // At the card's OWN gateway, not the default one. A deployment can have both
  // connected, and asking Stripe to forget a Razorpay token would report a
  // success that removed nothing.
  try {
    const loaded = await loadActiveProvider(row.provider);

    if (loaded.kind !== row.provider) {
      // The gateway this card belongs to is no longer connected, so there is
      // nothing to call. The row is still marked removed below: leaving a card
      // on the customer's screen that this deployment can neither charge nor
      // delete would be worse than a token outliving us at a gateway the
      // operator has disconnected.
      logger.warn(
        { paymentMethodId, provider: row.provider },
        'the gateway a saved card belongs to is not connected; removing it here only',
      );
    } else if (supportsCardVault(loaded.provider)) {
      await loaded.provider.forgetVaultedCard(
        row.providerCustomerId,
        row.providerPaymentMethodId,
      );
    }
  } catch (error) {
    // An already-detached card, or one the gateway has never heard of, is the
    // state being asked for. Anything else and the customer is told it failed
    // rather than shown a card that is gone here and live there.
    //
    // Both gateways' spellings, because either can own the card:
    // Stripe says "No such PaymentMethod" / resource_missing / not attached,
    // Razorpay answers a deleted token with a not-found description.
    const message = error instanceof Error ? error.message : 'unknown error';
    const alreadyGone =
      /No such PaymentMethod|resource_missing|not attached|does not exist|not found/i.test(
        message,
      );

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
  consentScope: string;
  expMonth: number | null;
  expYear: number | null;
}): void {
  /*
   * The card's owner has to have agreed to THIS, not merely to something.
   *
   * A card stored at a checkout was stored under "keep this so I need not type
   * it again" - an agreement whose every charge the customer watches happen.
   * Charging it off-session would be taking money under an authority nobody
   * gave, and it would be an easy mistake to make: the row looks identical in
   * every other respect to one enrolled for auto-pay.
   *
   * Checked first, before status and expiry, because it is the only one of the
   * three that is a question about consent rather than about whether the card
   * still works. A card can be perfectly good and still not be ours to charge.
   *
   * This is the single place the two scopes are held apart. Every off-session
   * path in this codebase reaches it - the auto-pay evaluator, schedule
   * enrolment, and `chargeOrderOffSession` itself - so a new caller that
   * forgets is refused rather than trusted.
   */
  if (row.consentScope !== 'OFF_SESSION') {
    throw conflict(
      ErrorCode.PAYMENT_METHOD_NOT_CHARGEABLE,
      'That card was saved for faster checkout, not for automatic payments. ' +
        'To use it for a scheduled order, add it again from the Autopay screen.',
      [{ code: 'CONSENT_SCOPE', meta: { consentScope: row.consentScope } }],
    );
  }

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
