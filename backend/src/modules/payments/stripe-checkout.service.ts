/**
 * Stripe-hosted Checkout.
 *
 * The customer presses "Pay securely now", this tab is sent to Stripe's own
 * page, and they come back. Card numbers, CVCs, 3-D Secure, bank redirects and
 * the list of cards they saved all live on that page; none of it passes
 * through this process or the storefront. What this module does is everything
 * either side of that page:
 *
 *   OPEN      Price nothing - the order was priced when it was placed - and
 *             check what can have changed since: the order is still awaiting
 *             payment, the amount is chargeable in its currency, and the stock
 *             it holds is still held for as long as Stripe's page will be open.
 *             Then open ONE session for the order, however many tabs and clicks
 *             ask for it.
 *   CONFIRM   From Stripe's signed webhook, or from Stripe's own API when the
 *             customer asks us to check again. Never from the return URL: it
 *             arrives through the customer's browser, and anybody can type one.
 *   CLOSE     When the customer comes back through Cancel, when Stripe expires
 *             the session, or when a delayed bank payment fails - and only
 *             then may a new attempt for the order begin.
 *
 * ONE OPEN ATTEMPT PER ORDER is the rule that makes double charging
 * impossible rather than unlikely, and it is held by the database:
 * `payment_transactions.openAttemptKey` is the order id while an attempt is
 * open and NULL once it closes, under a UNIQUE index. A second tab, a double
 * click and a network retry all collide on insert and are handed the attempt
 * that already exists - the same Stripe page, not a second one. Stripe's own
 * idempotency key is `stripe-checkout:<attempt id>`, an id this server minted,
 * so a retried create returns the same session rather than a new one.
 *
 * WHY THE ORDER IS NOT RE-PRICED HERE. The order was priced - lines, discount,
 * delivery, tax, the exchange-rate snapshot - by the server at checkout, and
 * the customer accepted that number. Re-pricing it on the way to Stripe would
 * make the amount they are charged depend on when they pressed a button, and
 * would be a second implementation of "what does this basket cost" that could
 * disagree with the first. The browser still cannot influence the amount: it
 * is `grandTotalMinor - paidMinor`, read from the order row, and the request
 * body carries no money at all.
 */
import { ErrorCode, badRequest, conflict, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { paymentSourcesOf, type PaymentStatus } from '../../domain/payment-state.js';
import type { PaymentInstrument } from '../../domain/payment-instrument.js';
import { StripeAmountError, toStripeAmount } from '../../domain/stripe-amount.js';
import { env } from '../../config/env.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma } from '../../infra/prisma.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import { reserveStock } from '../inventory/inventory.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import type { AddressSnapshot } from '../orders/order.service.js';
import {
  CHECKOUT_NATIVE_CONSENT_VERSION,
  recordCardSavedAtCheckout,
} from './payment-method.service.js';
import {
  alertFinance,
  applyCapturedPayment,
  loadProviderForWebhook,
  markEventProcessed,
  markEventRejected,
  type CreateOrderPaymentResult,
  type TransactionWithOrder,
  type WebhookResult,
} from './payment.service.js';
import {
  ensureProviderCustomer,
  findProviderCustomer,
  forgetProviderCustomer,
} from './provider-customer.service.js';
import {
  PaymentProviderError,
  supportsHostedCheckout,
  type CheckoutSessionResult,
  type HostedCheckoutProvider,
  type PaymentProvider,
  type VerifiedEvent,
} from './provider.js';
import { isCheckoutUrlFor } from './stripe.adapter.js';

/**
 * How long Stripe's page stays open.
 *
 * Stripe's floor is 30 minutes from creation; a little over it, so that clock
 * skew between us and Stripe can never make the request invalid. Short on
 * purpose: the order's stock is held for exactly this long, and a page left
 * open overnight would keep units away from somebody who wants to buy them.
 */
export const CHECKOUT_SESSION_MINUTES = 32;

/** Stock is held a little past the session, so a last-second payment still has it. */
const RESERVATION_GRACE_MINUTES = 5;

/**
 * A session with less than this left is not handed out again.
 *
 * Sending a customer to a page that closes while they are typing their card
 * number is worse than making them a fresh one.
 */
const MIN_REMAINING_SECONDS = 120;

/**
 * How long an attempt may sit without a session before it is presumed dead.
 *
 * Covers a request that claimed the order's slot and then died - a process
 * restart, a Stripe timeout - before it could record the session. Younger
 * than this, the attempt is somebody else's request still in flight, and the
 * caller is told to wait rather than handed a second page.
 */
const IN_FLIGHT_SECONDS = 20;

/** Stripe's session ids: cs_test_... or cs_live_..., letters and digits. */
export const CHECKOUT_SESSION_ID_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{8,180}$/;

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export interface OpenCheckoutContext {
  provider: HostedCheckoutProvider;
  connectionId: string;
  orderId: string;
  customerProfileId: string;
  instrument: PaymentInstrument | null;
  actorUserId: string | null;
  correlationId: string | null;
}

type OrderForCheckout = NonNullable<Awaited<ReturnType<typeof loadOrderForCheckout>>>;

function loadOrderForCheckout(orderId: string, customerProfileId: string) {
  return prisma.order.findFirst({
    // Scoped by customer: another customer's order is not found, rather than
    // refused, so its existence is not confirmed either.
    where: { id: orderId, customerProfileId },
    include: {
      customerProfile: {
        include: { user: { select: { email: true, preferredLanguage: true } } },
      },
      items: { select: { nameSnapshot: true, quantity: true }, orderBy: { createdAt: 'asc' } },
    },
  });
}

/**
 * Open - or hand back - the order's Stripe Checkout page.
 *
 * Every answer is one of three: REDIRECT to a page that is open right now,
 * AWAIT_CONFIRMATION because the customer has already paid or submitted and
 * the bank is still answering, or a refusal the storefront can put into words.
 * Never a second page while the first can still take money.
 */
export async function openStripeCheckout(
  context: OpenCheckoutContext,
): Promise<CreateOrderPaymentResult> {
  const order = await loadOrderForCheckout(context.orderId, context.customerProfileId);
  if (order === null) throw notFound('Order');

  assertPayable(order);

  const outstanding = order.grandTotalMinor - order.paidMinor;

  try {
    toStripeAmount(outstanding, order.currency);
  } catch (error) {
    if (error instanceof StripeAmountError) {
      throw badRequest(
        ErrorCode.PAYMENT_AMOUNT_NOT_SUPPORTED,
        'This order cannot be paid by card online. Please use a payment link, or contact us.',
        [{ field: 'amount', code: error.problem }],
      );
    }
    throw error;
  }

  // --- Is there already an attempt holding this order? ---------------------
  const open = await prisma.paymentTransaction.findUnique({
    where: { openAttemptKey: order.id },
    include: { order: true },
  });

  if (open !== null) {
    const resumed = await resumeOpenAttempt(context, open);
    if (resumed !== null) return resumed;
  }

  // --- Claim the order's one open slot ---------------------------------------
  const attemptId = newId();

  try {
    await prisma.paymentTransaction.create({
      data: {
        id: attemptId,
        orderId: order.id,
        connectionId: context.connectionId,
        provider: context.provider.kind,
        mode: context.provider.mode,
        status: 'CREATED',
        amountMinor: outstanding,
        currency: order.currency,
        // Minted here, never taken from the request: the idempotency key Stripe
        // sees is derived from it, and a client-chosen key would let two tabs
        // pick two keys and so two sessions.
        idempotencyKey: `stripe-checkout:${attemptId}`,
        openAttemptKey: order.id,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error, 'uq_payment_open_attempt')) {
      // Another tab or click claimed it between our read and our insert.
      // Hand back theirs; it is the same order and the same amount.
      const winner = await prisma.paymentTransaction.findUnique({
        where: { openAttemptKey: order.id },
        include: { order: true },
      });

      const resumed = winner === null ? null : await resumeOpenAttempt(context, winner);
      if (resumed !== null) return resumed;

      throw attemptInProgress();
    }
    throw error;
  }

  // --- Hold the stock for as long as Stripe's page can take money -------------
  const expiresAt = new Date(Date.now() + CHECKOUT_SESSION_MINUTES * 60_000);

  try {
    await holdStockForCheckout(
      order.id,
      new Date(expiresAt.getTime() + RESERVATION_GRACE_MINUTES * 60_000),
    );
  } catch (error) {
    await closeAttempt(attemptId, 'FAILED', { failureCode: 'STOCK_UNAVAILABLE' });
    throw error;
  }

  // --- This person's Stripe Customer, so their saved cards are offered --------
  //
  // Best-effort. Being unable to reach the Customer costs the customer their
  // saved cards and the option to save this one; letting it throw would cost
  // them the purchase, which is out of all proportion.
  let providerCustomerId: string | null = null;
  try {
    providerCustomerId = await ensureProviderCustomer(context.provider, identityOf(order));
  } catch (error) {
    logger.warn(
      { err: error, orderId: order.id },
      'could not prepare the Stripe customer; opening checkout without saved cards',
    );
  }

  // --- Open Stripe's page ------------------------------------------------------
  let session: CheckoutSessionResult;
  try {
    session = await createSession(context.provider, order, {
      attemptId,
      outstanding,
      expiresAt,
      providerCustomerId,
      idempotencyKey: `stripe-checkout:${attemptId}`,
    });
  } catch (error) {
    if (
      error instanceof PaymentProviderError &&
      providerCustomerId !== null &&
      isMissingCustomer(error)
    ) {
      // The filed Customer is gone at Stripe - deleted in the dashboard, or
      // left behind by a change of Stripe account. Forget it, make a fresh
      // one, and try once more under a new key.
      await forgetProviderCustomer(context.provider, order.customerProfileId, providerCustomerId);
      providerCustomerId = await ensureProviderCustomer(context.provider, identityOf(order)).catch(
        () => null,
      );

      try {
        session = await createSession(context.provider, order, {
          attemptId,
          outstanding,
          expiresAt,
          providerCustomerId,
          idempotencyKey: `stripe-checkout:${attemptId}:customer-renewed`,
        });
      } catch (retryError) {
        throw await failedToOpen(attemptId, retryError);
      }
    } else {
      throw await failedToOpen(attemptId, error);
    }
  }

  await prisma.paymentTransaction.update({
    where: { id: attemptId },
    data: { providerSessionId: session.sessionId, sessionExpiresAt: session.expiresAt },
  });

  await recordAudit({
    action: AuditAction.PAYMENT_CREATED,
    resourceType: 'payment',
    resourceId: attemptId,
    actorType: 'CUSTOMER',
    actorUserId: context.actorUserId,
    after: {
      orderId: order.id,
      checkoutSessionId: session.sessionId,
      amountMinor: outstanding,
      currency: order.currency,
      provider: context.provider.kind,
      mode: context.provider.mode,
      savedCardsOffered: providerCustomerId !== null,
    },
    correlationId: context.correlationId,
  });

  return redirectResult(context, attemptId, outstanding, order.currency, session);
}

function assertPayable(order: { status: string; grandTotalMinor: bigint; paidMinor: bigint }): void {
  if (order.status !== 'PENDING_PAYMENT') {
    throw conflict(
      order.status === 'PENDING_APPROVAL'
        ? ErrorCode.ORDER_APPROVAL_REQUIRED
        : ErrorCode.ORDER_ALREADY_PAID,
      order.status === 'PENDING_APPROVAL'
        ? 'This order is waiting for approval and cannot be paid yet.'
        : `This order is ${order.status.toLowerCase()} and is not awaiting payment.`,
    );
  }

  if (order.grandTotalMinor - order.paidMinor <= 0n) {
    throw conflict(ErrorCode.ORDER_ALREADY_PAID, 'This order is already paid in full.');
  }
}

function attemptInProgress(): Error {
  return conflict(
    ErrorCode.PAYMENT_ATTEMPT_IN_PROGRESS,
    'A secure payment for this order is already being opened. Please wait a moment.',
  );
}

/**
 * Decide what an existing open attempt means for this request.
 *
 * Returns the answer to give, or null when the attempt turned out to be
 * closed and a new one may be opened. Stripe is asked, not assumed: the row
 * says what we last knew, and a webhook may still be on its way.
 */
async function resumeOpenAttempt(
  context: OpenCheckoutContext,
  open: TransactionWithOrder,
): Promise<CreateOrderPaymentResult | null> {
  // An attempt from another gateway, or one opened before Checkout existed,
  // cannot be resumed here. Close it rather than leave the order unpayable.
  if (open.provider !== context.provider.kind || open.providerSessionId === null) {
    const ageSeconds = (Date.now() - open.createdAt.getTime()) / 1000;

    if (open.providerSessionId === null && ageSeconds < IN_FLIGHT_SECONDS) {
      throw attemptInProgress();
    }

    // Dead: its request never recorded a session. If Stripe did create one,
    // nobody has its address - it was never returned to anyone - so it can
    // never be paid, and it expires by itself.
    await closeAttempt(open.id, 'FAILED', { failureCode: 'SESSION_NOT_RECORDED' });
    return null;
  }

  let session: CheckoutSessionResult;
  try {
    session = await context.provider.retrieveCheckoutSession(open.providerSessionId);
  } catch (error) {
    // Not knowing is not a reason to open a second page. The customer can
    // try again in a moment; a second page could take a second payment.
    logger.warn(
      { err: error, paymentTransactionId: open.id },
      'could not read an open Stripe Checkout session; refusing to open another',
    );
    throw conflict(
      ErrorCode.PAYMENT_ATTEMPT_IN_PROGRESS,
      'We could not check the payment already open for this order. Please try again in a moment.',
    );
  }

  if (session.status === 'open') {
    const remaining = (session.expiresAt.getTime() - Date.now()) / 1000;

    if (remaining > MIN_REMAINING_SECONDS && isCheckoutUrlFor(session.url, session.sessionId)) {
      // The same page, handed back. A second tab or a second click lands on
      // exactly the session the first one opened.
      return redirectResult(context, open.id, open.amountMinor, open.currency, session);
    }

    // About to close under them. Close it now so it cannot take money, and
    // open a fresh one.
    const expired = await context.provider.expireCheckoutSession(session.sessionId).catch(
      () => null,
    );

    if (expired !== null && expired.status === 'complete') {
      await settleFromSession(open, expired, context.provider);
      return awaitingResult(context, open, expired);
    }

    await closeAttempt(open.id, 'EXPIRED', {});
    return null;
  }

  if (session.status === 'complete') {
    // Already paid, or submitted and settling. Record what Stripe says and
    // send the customer to wait for it - never to a second page.
    await settleFromSession(open, session, context.provider);
    return awaitingResult(context, open, session);
  }

  await closeAttempt(open.id, 'EXPIRED', {});
  return null;
}

function redirectResult(
  context: OpenCheckoutContext,
  attemptId: string,
  amountMinor: bigint,
  currency: string,
  session: CheckoutSessionResult,
): CreateOrderPaymentResult {
  if (!isCheckoutUrlFor(session.url, session.sessionId)) {
    throw badRequest(
      ErrorCode.PAYMENT_PROVIDER_ERROR,
      'We could not open the secure payment page. Please try again.',
    );
  }

  return {
    paymentTransactionId: attemptId,
    provider: context.provider.kind,
    mode: context.provider.mode,
    providerOrderId: session.providerPaymentIntentId ?? '',
    amount: serialiseMoney(amountMinor, currency),
    // Nothing for a browser to open a form with. The page is Stripe's.
    checkoutPayload: {},
    instrument: context.instrument,
    next: 'REDIRECT',
    redirectUrl: session.url,
    checkoutSessionId: session.sessionId,
    expiresAt: session.expiresAt.toISOString(),
  };
}

function awaitingResult(
  context: OpenCheckoutContext,
  attempt: TransactionWithOrder,
  session: CheckoutSessionResult,
): CreateOrderPaymentResult {
  return {
    paymentTransactionId: attempt.id,
    provider: context.provider.kind,
    mode: context.provider.mode,
    providerOrderId: session.providerPaymentIntentId ?? '',
    amount: serialiseMoney(attempt.amountMinor, attempt.currency),
    checkoutPayload: {},
    instrument: context.instrument,
    next: 'AWAIT_CONFIRMATION',
    redirectUrl: null,
    checkoutSessionId: session.sessionId,
    expiresAt: session.expiresAt.toISOString(),
  };
}

function identityOf(order: OrderForCheckout): {
  customerProfileId: string;
  email: string | null;
  name: string | null;
  phone: string | null;
} {
  return {
    customerProfileId: order.customerProfileId,
    email: order.customerProfile.user.email,
    name: order.customerProfile.fullName,
    phone: order.customerProfile.phone,
  };
}

function isMissingCustomer(error: PaymentProviderError): boolean {
  return error.providerCode === 'resource_missing' && /customer/i.test(error.message);
}

/**
 * Close an attempt that could not be opened, and say so in our own words.
 *
 * Stripe's own message is logged, not shown: it can echo request fields, and
 * a customer has no use for "Invalid string: cus_...". A timeout is left open
 * rather than closed - Stripe may have created the session after all - and
 * `resumeOpenAttempt` closes it once it is clearly abandoned.
 */
async function failedToOpen(attemptId: string, error: unknown): Promise<Error> {
  if (!(error instanceof PaymentProviderError)) {
    await closeAttempt(attemptId, 'FAILED', { failureCode: 'INTERNAL_ERROR' });
    return error instanceof Error ? error : new Error('Could not open the secure payment page.');
  }

  logger.warn(
    {
      paymentTransactionId: attemptId,
      providerCode: error.providerCode,
      httpStatus: error.httpStatus,
      retryable: error.retryable,
    },
    'stripe refused or did not answer a checkout session request',
  );

  if (!error.retryable) {
    await closeAttempt(attemptId, 'FAILED', {
      failureCode: (error.providerCode ?? 'PROVIDER_ERROR').slice(0, 64),
    });
  }

  return badRequest(
    ErrorCode.PAYMENT_PROVIDER_ERROR,
    'We could not open the secure payment page. Please try again.',
    [{ field: 'payment', code: 'CHECKOUT_UNAVAILABLE' }],
  );
}

async function createSession(
  provider: HostedCheckoutProvider,
  order: OrderForCheckout,
  params: {
    attemptId: string;
    outstanding: bigint;
    expiresAt: Date;
    providerCustomerId: string | null;
    idempotencyKey: string;
  },
): Promise<CheckoutSessionResult> {
  const base = env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '');
  const summary = itemSummary(order.items);

  return provider.createCheckoutSession({
    paymentTransactionId: params.attemptId,
    orderId: order.id,
    orderNumber: order.orderNumber,
    amountMinor: params.outstanding,
    currency: order.currency,
    lineItemName: `Order ${order.orderNumber}`,
    lineItemDescription: summary,
    description: `Order ${order.orderNumber}: ${summary}`,
    providerCustomerId: params.providerCustomerId,
    customerEmail: order.customerProfile.user.email,
    offerToSaveCard: params.providerCustomerId !== null,
    shipping: shippingOf(order.shippingAddressJson),
    locale: order.customerProfile.user.preferredLanguage?.slice(0, 2).toLowerCase() ?? null,
    /*
     * Both built from configuration, never from the request. A client-chosen
     * return address would be an open redirect carrying a payment page's
     * credibility: somebody who has just paid and lands on a lookalike has
     * every reason to believe it. `{CHECKOUT_SESSION_ID}` is Stripe's own
     * template, filled in by Stripe.
     */
    successUrl: `${base}/checkout/payment/${order.id}/confirmation?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/checkout/payment/${order.id}?payment=cancelled`,
    expiresAt: params.expiresAt,
    idempotencyKey: params.idempotencyKey,
  });
}

/**
 * What is being bought, in a line: "3 × Nitrile gloves, 1 × Face shield, +2 more".
 *
 * Product names and quantities only - what the customer's bank statement
 * query and India's export declaration both need, and nothing about who is
 * buying it.
 */
function itemSummary(items: readonly { nameSnapshot: string; quantity: number }[]): string {
  const shown = items.slice(0, 3).map((item) => `${String(item.quantity)} × ${item.nameSnapshot}`);
  const more = items.length > 3 ? `, +${String(items.length - 3)} more` : '';
  return `${shown.join(', ')}${more}`.slice(0, 480);
}

function shippingOf(snapshot: unknown): {
  name: string;
  line1: string;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  phone: null;
} | null {
  if (typeof snapshot !== 'object' || snapshot === null) return null;
  const address = snapshot as Partial<AddressSnapshot>;
  if (typeof address.line1 !== 'string' || address.line1.length === 0) return null;

  return {
    name: address.contactName ?? '',
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postalCode: address.postalCode ?? null,
    country: address.country ?? null,
    // Not needed by the declaration, so not sent.
    phone: null,
  };
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/**
 * Make sure the order's stock is held until `until`.
 *
 * Placing the order reserved it for twenty minutes, and Stripe's page stays
 * open for over thirty - so the hold is extended to cover the page. If the
 * hold has already lapsed (the customer left and came back an hour later),
 * the same quantities are reserved again, all or nothing, and a shortfall is
 * refused here rather than discovered after they have paid for goods that are
 * gone.
 *
 * An order with no stock-tracked lines holds nothing and needs nothing.
 */
export async function holdStockForCheckout(orderId: string, until: Date): Promise<void> {
  const reservations = await prisma.stockReservation.findMany({ where: { orderId } });
  if (reservations.length === 0) return;

  const active = reservations.filter((reservation) => reservation.status === 'ACTIVE');

  if (active.length > 0) {
    // Only ever lengthened: a hold that already runs past `until` is left be.
    await prisma.stockReservation.updateMany({
      where: { orderId, status: 'ACTIVE', expiresAt: { lt: until } },
      data: { expiresAt: until },
    });
    return;
  }

  // Nothing active. Committed means the order was confirmed, and nothing here
  // should be paying for it; anything else released for a reason other than
  // lapsing was released on purpose.
  const lapsed = reservations.filter(
    (reservation) =>
      reservation.status === 'RELEASED' && reservation.releaseReason === 'reservation_expired',
  );

  if (lapsed.length === 0) return;

  // Only the most recent hold. Every reservation made by one call shares one
  // expiry to the millisecond, and each re-hold below is stamped the same way,
  // so an older generation - lapsed, re-held, lapsed again - is not counted
  // twice.
  const latest = Math.max(...lapsed.map((reservation) => reservation.expiresAt.getTime()));
  const generation = lapsed.filter((reservation) => reservation.expiresAt.getTime() === latest);

  const byLocation = new Map<string, typeof generation>();
  for (const reservation of generation) {
    const list = byLocation.get(reservation.locationId) ?? [];
    list.push(reservation);
    byLocation.set(reservation.locationId, list);
  }

  const ttlMinutes = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));

  await prisma.$transaction(async (tx) => {
    const created: string[] = [];

    for (const [locationId, items] of byLocation) {
      const result = await reserveStock(
        {
          items: items.map((item) => ({
            productId: item.productId,
            variantId: item.variantId,
            quantity: item.quantity,
          })),
          orderId,
          locationId,
          ttlMinutes,
        },
        tx,
      );
      created.push(...result.reservationIds);
    }

    await tx.stockReservation.updateMany({
      where: { id: { in: created } },
      data: { expiresAt: until },
    });
  });
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * Close an attempt that took no money, and free the order's slot.
 *
 * Conditional on the state machine, so an attempt that has meanwhile been
 * captured - by a webhook racing this very call - matches nothing and stays
 * captured. Returns whether it closed.
 */
export async function closeAttempt(
  attemptId: string,
  to: Extract<PaymentStatus, 'FAILED' | 'CANCELLED' | 'EXPIRED'>,
  details: { failureCode?: string; failureMessage?: string },
  actor: { type: 'SYSTEM' | 'CUSTOMER'; userId: string | null } = { type: 'SYSTEM', userId: null },
): Promise<boolean> {
  const closed = await prisma.paymentTransaction.updateMany({
    where: { id: attemptId, status: { in: paymentSourcesOf(to) } },
    data: {
      status: to,
      openAttemptKey: null,
      ...(to === 'FAILED' ? { failedAt: new Date() } : {}),
      ...(details.failureCode === undefined ? {} : { failureCode: details.failureCode }),
      ...(details.failureMessage === undefined
        ? {}
        : { failureMessage: details.failureMessage.slice(0, 512) }),
    },
  });

  if (closed.count === 1) {
    await recordAudit({
      action: AuditAction.PAYMENT_CHECKOUT_CLOSED,
      resourceType: 'payment',
      resourceId: attemptId,
      actorType: actor.type,
      actorUserId: actor.userId,
      after: { status: to, reason: details.failureCode ?? null },
    });
  }

  return closed.count === 1;
}

/**
 * Record what a completed session says, from Stripe's own answer.
 *
 * `session` came from Stripe's API over an authenticated connection - never
 * from anything the browser sent - so it is as authoritative as a webhook.
 * Paid: the capture is applied through the one guarded path. Submitted but
 * unpaid: a delayed method is settling, and the attempt waits in PENDING,
 * still holding the order so nothing opens a second payment beside it.
 */
async function settleFromSession(
  attempt: TransactionWithOrder,
  session: CheckoutSessionResult,
  provider: HostedCheckoutProvider,
): Promise<'CAPTURED' | 'PENDING' | 'REFUSED' | 'UNCHANGED'> {
  if (session.status !== 'complete') return 'UNCHANGED';

  const payment = session.payment;

  if (session.paymentStatus === 'paid' && payment !== null && payment.status === 'CAPTURED') {
    if (!amountMatches(attempt, session.amountTotal, session.currency)) {
      await alertFinance(attempt.orderId, attempt.order.orderNumber, 'PAYMENT_AMOUNT_MISMATCH', {
        expectedMinor: attempt.amountMinor.toString(),
        receivedMinor: (session.amountTotal ?? 0n).toString(),
      });
      return 'REFUSED';
    }

    await applyCapturedPayment({
      transaction: attempt,
      capture: {
        providerOrderId: session.providerPaymentIntentId,
        providerPaymentId: payment.chargeId,
        amountMinor: payment.amountReceived,
        method: payment.method,
        card: payment.card,
      },
      eventRowId: null,
      eventId: null,
      reason: 'Payment confirmed with Stripe',
    });

    await storeCardSavedInCheckout(provider, attempt, session);
    return 'CAPTURED';
  }

  if (session.paymentStatus === 'unpaid') {
    await prisma.paymentTransaction.updateMany({
      where: { id: attempt.id, status: 'CREATED' },
      data: {
        status: 'PENDING',
        ...(attempt.providerOrderId === null && session.providerPaymentIntentId !== null
          ? { providerOrderId: session.providerPaymentIntentId }
          : {}),
      },
    });
    return 'PENDING';
  }

  return 'UNCHANGED';
}

function amountMatches(
  attempt: { amountMinor: bigint; currency: string },
  amount: bigint | null,
  currency: string | null,
): boolean {
  return amount === attempt.amountMinor && currency === attempt.currency;
}

// ---------------------------------------------------------------------------
// Saved cards
// ---------------------------------------------------------------------------

/**
 * Record a card the customer ticked Stripe's "save" box for.
 *
 * The evidence that they ticked it is Stripe's, read back from Stripe: the
 * card is attached to THIS person's Customer, and its `allow_redisplay` is
 * 'always' - which Checkout sets only when the box is ticked. A card that
 * merely paid, with the box left empty, is neither, and nothing is stored.
 * Both conditions, because each alone has an innocent explanation.
 *
 * What is stored is a reference and the display fields - brand, last four,
 * expiry. Stripe has the card. This system has never seen the number.
 *
 * Never throws. The payment it follows is already applied, and a card that
 * fails to record costs the customer a retype, not an order.
 */
async function storeCardSavedInCheckout(
  provider: HostedCheckoutProvider,
  attempt: TransactionWithOrder,
  session: CheckoutSessionResult,
): Promise<void> {
  try {
    const methodId = session.payment?.paymentMethodId ?? null;
    if (methodId === null) return;

    const filed = await findProviderCustomer(provider, attempt.order.customerProfileId);
    if (filed === null || session.providerCustomerId !== filed) return;

    const card = await provider.fetchVaultedCard(filed, methodId);

    if (
      card === null ||
      card.methodType !== 'card' ||
      card.allowRedisplay !== 'always' ||
      card.providerCustomerId !== filed
    ) {
      return;
    }

    await recordCardSavedAtCheckout({
      customerProfileId: attempt.order.customerProfileId,
      provider: provider.kind,
      card,
      consentVersion: CHECKOUT_NATIVE_CONSENT_VERSION,
      consentContext: { providerSessionId: session.sessionId, paymentTransactionId: attempt.id },
    });
  } catch (error) {
    logger.error(
      { err: error, paymentTransactionId: attempt.id },
      'could not record a card the customer saved in Stripe Checkout',
    );
  }
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Apply a checkout.session.* event.
 *
 * The event says which session and what Stripe's page reported; for a paid
 * one, Stripe's API is then asked for the charge and the card behind it - the
 * charge is what a refund is issued against, and the card is what the
 * confirmation page shows. That read is an authenticated server-to-server
 * call, and if it fails the event is left for Stripe to redeliver rather than
 * applied half-known.
 */
export async function applyCheckoutSessionEvent(params: {
  event: VerifiedEvent;
  eventRowId: string;
  correlationId: string | undefined;
  provider: PaymentProvider;
  transaction: TransactionWithOrder;
}): Promise<WebhookResult> {
  const { event, eventRowId, provider, transaction } = params;
  const links = { orderId: transaction.orderId, paymentTransactionId: transaction.id };

  if (!supportsHostedCheckout(provider)) {
    await markEventRejected(eventRowId, 'checkout event for a gateway without hosted checkout');
    return { accepted: false, duplicate: false, reason: 'gateway has no hosted checkout' };
  }

  // One attempt, one PaymentIntent. A session event naming a different one
  // than the attempt already carries is not ours to reconcile silently.
  if (
    event.providerOrderId !== null &&
    transaction.providerOrderId !== null &&
    event.providerOrderId !== transaction.providerOrderId
  ) {
    await markEventRejected(eventRowId, 'checkout session names a different payment intent');
    await alertFinance(transaction.orderId, transaction.order.orderNumber, 'PAYMENT_INTENT_MISMATCH', {
      paymentTransactionId: transaction.id,
    });
    return { accepted: false, duplicate: false, reason: 'payment intent mismatch' };
  }

  if (event.intent === 'CHECKOUT_EXPIRED') {
    await closeAttempt(transaction.id, 'EXPIRED', {});
    await markEventProcessed(eventRowId, links);
    return { accepted: true, duplicate: false };
  }

  if (event.intent === 'CHECKOUT_ASYNC_FAILED') {
    const closed = await closeAttempt(transaction.id, 'FAILED', {
      failureCode: 'async_payment_failed',
    });
    await markEventProcessed(eventRowId, links);

    if (closed) await notifyPaymentFailed(transaction, event, params.correlationId);
    return { accepted: true, duplicate: false };
  }

  // CHECKOUT_COMPLETED or CHECKOUT_ASYNC_SUCCEEDED.
  const paid =
    event.intent === 'CHECKOUT_ASYNC_SUCCEEDED' || event.checkoutPaymentStatus === 'paid';

  if (!paid) {
    // Submitted on Stripe's page, and a delayed method is still settling.
    // Not paid, and not failed: the order waits, holding its slot.
    await prisma.paymentTransaction.updateMany({
      where: { id: transaction.id, status: 'CREATED' },
      data: {
        status: 'PENDING',
        ...(transaction.providerOrderId === null && event.providerOrderId !== null
          ? { providerOrderId: event.providerOrderId }
          : {}),
      },
    });
    await markEventProcessed(eventRowId, links);
    return { accepted: true, duplicate: false };
  }

  if (!amountMatches(transaction, event.amountMinor, event.currency)) {
    await markEventRejected(
      eventRowId,
      `checkout amount mismatch: event ${(event.amountMinor ?? 0n).toString()} ${event.currency ?? '?'} ` +
        `vs expected ${transaction.amountMinor.toString()} ${transaction.currency}`,
    );
    await alertFinance(transaction.orderId, transaction.order.orderNumber, 'PAYMENT_AMOUNT_MISMATCH', {
      expectedMinor: transaction.amountMinor.toString(),
      receivedMinor: (event.amountMinor ?? 0n).toString(),
    });
    return { accepted: false, duplicate: false, reason: 'amount mismatch' };
  }

  if (transaction.providerSessionId === null) {
    await markEventRejected(eventRowId, 'matched attempt has no checkout session');
    return { accepted: false, duplicate: false, reason: 'attempt has no session' };
  }

  // Throws on a network failure, which leaves the event claimable again and
  // Stripe redelivers it. Better late than applied with half the facts.
  const session = await provider.retrieveCheckoutSession(transaction.providerSessionId);
  const payment = session.payment;

  if (payment === null || payment.status !== 'CAPTURED') {
    // Stripe's session says paid and its PaymentIntent does not agree yet.
    // Not applied; `payment_intent.succeeded` will follow, or this event will
    // be redelivered.
    logger.warn(
      { paymentTransactionId: transaction.id, intentStatus: payment?.status ?? null },
      'checkout session reported paid before its payment intent did; waiting',
    );
    throw new Error('Checkout session paid but its payment intent has not settled yet.');
  }

  await applyCapturedPayment({
    transaction,
    capture: {
      providerOrderId: session.providerPaymentIntentId,
      providerPaymentId: payment.chargeId,
      amountMinor: payment.amountReceived,
      method: payment.method,
      card: payment.card,
    },
    eventRowId,
    eventId: event.eventId,
    correlationId: params.correlationId,
    reason: 'Payment captured and verified',
  });

  await storeCardSavedInCheckout(provider, transaction, session);

  return { accepted: true, duplicate: false };
}

async function notifyPaymentFailed(
  transaction: TransactionWithOrder,
  event: VerifiedEvent,
  correlationId: string | undefined,
): Promise<void> {
  const profile = await prisma.customerProfile.findUniqueOrThrow({
    where: { id: transaction.order.customerProfileId },
    include: { user: { select: { email: true } } },
  });

  await enqueueNotification({
    eventKey: NotificationEvent.PAYMENT_FAILED,
    recipientEmail: profile.user.email,
    variables: {
      orderNumber: transaction.order.orderNumber,
      reason: 'Your bank did not complete the payment.',
    },
    dedupeKey: `payment_failed:${event.eventId}`,
    relatedType: 'order',
    relatedId: transaction.orderId,
    ...(correlationId !== undefined ? { correlationId } : {}),
  });

  await dispatchPendingNotifications();
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

/**
 * What the confirmation page may say, in its own vocabulary.
 *
 *   CONFIRMING  The customer is back and Stripe has not told us yet. The page
 *               waits; it never assumes.
 *   SUCCEEDED   The money moved, by Stripe's signed word or Stripe's API.
 *   PROCESSING  Submitted, and the bank is still settling it.
 *   FAILED      A delayed payment failed, or the page could not be opened.
 *   CANCELLED   The customer came back through Cancel.
 *   EXPIRED     Stripe closed the page before anything was paid.
 */
export type CheckoutConfirmationState =
  | 'CONFIRMING'
  | 'SUCCEEDED'
  | 'PROCESSING'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

/**
 * Why a payment did not go through, as a customer may be told it.
 *
 * A small, fixed set. Stripe's raw decline codes are not passed on: some of
 * them - `stolen_card`, `fraudulent` - are the issuer talking to the merchant,
 * and saying them to whoever holds the card helps exactly the wrong person.
 */
export type CheckoutFailureReason =
  | 'DECLINED'
  | 'INSUFFICIENT_FUNDS'
  | 'EXPIRED_CARD'
  | 'INCORRECT_CVC'
  | 'AUTHENTICATION_FAILED'
  | 'BANK_PAYMENT_FAILED'
  | 'OTHER';

export function customerFailureReason(code: string | null): CheckoutFailureReason | null {
  if (code === null || code.length === 0) return null;

  switch (code) {
    case 'insufficient_funds':
      return 'INSUFFICIENT_FUNDS';
    case 'expired_card':
      return 'EXPIRED_CARD';
    case 'incorrect_cvc':
    case 'invalid_cvc':
      return 'INCORRECT_CVC';
    case 'authentication_required':
    case 'authentication_failed':
    case 'payment_intent_authentication_failure':
      return 'AUTHENTICATION_FAILED';
    case 'async_payment_failed':
      return 'BANK_PAYMENT_FAILED';
    // The customer's own choice, not a refusal. Nothing to explain.
    case 'customer_cancelled':
      return null;
    case 'STOCK_UNAVAILABLE':
    case 'SESSION_NOT_RECORDED':
    case 'INTERNAL_ERROR':
      return 'OTHER';
    default:
      // Every other issuer answer - generic_decline, do_not_honor,
      // stolen_card, fraudulent, lost_card and the rest - is one sentence.
      return 'DECLINED';
  }
}

export interface CheckoutConfirmationView {
  state: CheckoutConfirmationState;
  orderId: string;
  orderNumber: string;
  orderStatus: string;
  amount: ReturnType<typeof serialiseMoney>;
  /** When the money moved, ISO-8601. Only once it has. */
  paidAt: string | null;
  /** "Visa ending 4242". Brand and last four only; there is nothing else. */
  card: { brand: string | null; last4: string } | null;
  /** The most recent decline Stripe reported, in customer terms. */
  failureReason: CheckoutFailureReason | null;
  /** Whether a new attempt may be started for this order now. */
  canRetry: boolean;
}

async function loadOwnedAttempt(
  orderId: string,
  customerProfileId: string,
  sessionId: string,
): Promise<TransactionWithOrder> {
  if (!CHECKOUT_SESSION_ID_PATTERN.test(sessionId)) throw notFound('Payment');

  // Scoped three ways - the session, the order it was opened for, and the
  // customer who owns that order - so a session id copied from somebody
  // else's address bar finds nothing.
  const attempt = await prisma.paymentTransaction.findFirst({
    where: { providerSessionId: sessionId, orderId, order: { customerProfileId } },
    include: { order: true },
  });

  if (attempt === null) throw notFound('Payment');
  return attempt;
}

function viewOf(attempt: TransactionWithOrder): CheckoutConfirmationView {
  const order = attempt.order;

  let state: CheckoutConfirmationState;
  switch (attempt.status) {
    case 'CAPTURED':
      state = 'SUCCEEDED';
      break;
    case 'PENDING':
    case 'AUTHORIZED':
      state = 'PROCESSING';
      break;
    case 'FAILED':
      state = 'FAILED';
      break;
    case 'CANCELLED':
      state = 'CANCELLED';
      break;
    case 'EXPIRED':
      state = 'EXPIRED';
      break;
    case 'CREATED':
      state =
        attempt.sessionExpiresAt !== null && attempt.sessionExpiresAt.getTime() < Date.now()
          ? 'EXPIRED'
          : 'CONFIRMING';
      break;
    default: {
      const exhaustive: never = attempt.status;
      state = exhaustive;
    }
  }

  const paidInFull = order.grandTotalMinor > 0n && order.paidMinor >= order.grandTotalMinor;

  return {
    state,
    orderId: order.id,
    orderNumber: order.orderNumber,
    orderStatus: order.status,
    amount: serialiseMoney(attempt.amountMinor, attempt.currency),
    paidAt: attempt.capturedAt?.toISOString() ?? null,
    card:
      attempt.cardLast4 === null ? null : { brand: attempt.cardBrand, last4: attempt.cardLast4 },
    // Only for an attempt that closed unpaid. A decline recorded while the
    // customer was still on Stripe's page is history once they paid with
    // another card, and must not be read out beside "Confirming payment".
    failureReason:
      state === 'FAILED' || state === 'EXPIRED' || state === 'CANCELLED'
        ? customerFailureReason(attempt.failureCode)
        : null,
    canRetry:
      order.status === 'PENDING_PAYMENT' &&
      !paidInFull &&
      (state === 'FAILED' || state === 'CANCELLED' || state === 'EXPIRED'),
  };
}

/** What we know right now. Reads our own records only - costs Stripe nothing. */
export async function getCheckoutConfirmation(
  orderId: string,
  customerProfileId: string,
  sessionId: string,
): Promise<CheckoutConfirmationView> {
  return viewOf(await loadOwnedAttempt(orderId, customerProfileId, sessionId));
}

/**
 * "Check again": ask Stripe, when the webhook is late.
 *
 * The recovery path for a webhook that has not arrived - on a laptop it never
 * will. It asks Stripe's API, over the server's own authenticated connection,
 * and applies the answer through the same guarded path the webhook uses. The
 * browser's return to our page is still not evidence of anything; this is
 * the gateway's word, fetched by us. It never starts a payment.
 */
export async function refreshCheckoutConfirmation(
  orderId: string,
  customerProfileId: string,
  sessionId: string,
): Promise<CheckoutConfirmationView> {
  const attempt = await loadOwnedAttempt(orderId, customerProfileId, sessionId);

  if (attempt.status === 'CREATED' || attempt.status === 'PENDING') {
    await reconcileCheckoutAttempt(attempt);
    return viewOf(await loadOwnedAttempt(orderId, customerProfileId, sessionId));
  }

  return viewOf(attempt);
}

/** Reconcile one Checkout attempt against Stripe. Shared with `reconcilePayment`. */
export async function reconcileCheckoutAttempt(
  attempt: TransactionWithOrder,
): Promise<{ status: string; changed: boolean }> {
  if (attempt.providerSessionId === null) return { status: attempt.status, changed: false };

  const { provider } = await loadProviderForWebhook(attempt.provider);
  if (!supportsHostedCheckout(provider)) return { status: attempt.status, changed: false };

  const session = await provider.retrieveCheckoutSession(attempt.providerSessionId);

  await prisma.paymentTransaction.update({
    where: { id: attempt.id },
    data: { reconciledAt: new Date() },
  });

  if (session.status === 'expired') {
    const closed = await closeAttempt(attempt.id, 'EXPIRED', {});
    return { status: closed ? 'EXPIRED' : attempt.status, changed: closed };
  }

  const outcome = await settleFromSession(attempt, session, provider);

  return {
    status: outcome === 'CAPTURED' ? 'CAPTURED' : outcome === 'PENDING' ? 'PENDING' : attempt.status,
    changed: outcome === 'CAPTURED' || (outcome === 'PENDING' && attempt.status !== 'PENDING'),
  };
}

/**
 * The customer came back through Stripe's Cancel link.
 *
 * Their Stripe page is closed at Stripe, so a tab they left open behind it
 * cannot take money for an attempt this system is about to call cancelled.
 * If they had in fact paid in that other tab a moment earlier, Stripe refuses
 * to expire a completed session - and the payment is recorded instead.
 */
export async function cancelOpenCheckout(
  orderId: string,
  customerProfileId: string,
  actorUserId: string | null,
): Promise<{ state: CheckoutConfirmationState | 'NONE'; checkoutSessionId: string | null }> {
  const attempt = await prisma.paymentTransaction.findFirst({
    where: { openAttemptKey: orderId, order: { customerProfileId } },
    include: { order: true },
  });

  if (attempt === null) return { state: 'NONE', checkoutSessionId: null };

  if (attempt.providerSessionId === null) {
    return { state: 'CONFIRMING', checkoutSessionId: null };
  }

  const { provider } = await loadProviderForWebhook(attempt.provider);
  if (!supportsHostedCheckout(provider)) return { state: 'NONE', checkoutSessionId: null };

  let session: CheckoutSessionResult;
  try {
    session = await provider.expireCheckoutSession(attempt.providerSessionId);
  } catch (error) {
    // Stripe will not expire a session that has completed. Read it instead and
    // record what it says - which may well be that they paid.
    logger.info(
      { err: error, paymentTransactionId: attempt.id },
      'stripe would not expire the session on cancel; reading it instead',
    );
    session = await provider.retrieveCheckoutSession(attempt.providerSessionId);
  }

  if (session.status === 'complete') {
    await settleFromSession(attempt, session, provider);
  } else {
    await closeAttempt(
      attempt.id,
      'CANCELLED',
      { failureCode: 'customer_cancelled' },
      { type: 'CUSTOMER', userId: actorUserId },
    );
  }

  const refreshed = await prisma.paymentTransaction.findUniqueOrThrow({
    where: { id: attempt.id },
    include: { order: true },
  });

  return { state: viewOf(refreshed).state, checkoutSessionId: attempt.providerSessionId };
}

// ---------------------------------------------------------------------------
// One-off: cards saved before Checkout
// ---------------------------------------------------------------------------

/**
 * Let Checkout offer the cards customers saved with the old in-page tick.
 *
 * Those customers ticked "save this card" and were told it would be offered
 * next time - but Stripe offers a card in Checkout only when its
 * `allow_redisplay` is 'always', and cards saved the old way carry
 * 'unspecified'. This sets it, for CHECKOUT-consent cards and nothing else.
 * Auto-pay cards (OFF_SESSION) are deliberately left alone: that consent was
 * for unattended charges, not for being shown at a checkout.
 *
 * Idempotent: setting 'always' twice is the same as once, and a card Stripe
 * no longer has is skipped.
 */
export async function backfillCheckoutRedisplay(): Promise<{
  updated: number;
  skipped: number;
  failed: number;
}> {
  const { provider } = await loadProviderForWebhook('STRIPE');
  if (!supportsHostedCheckout(provider)) return { updated: 0, skipped: 0, failed: 0 };

  const cards = await prisma.customerPaymentMethod.findMany({
    where: { provider: 'STRIPE', status: 'ACTIVE', consentScope: 'CHECKOUT' },
    select: { id: true, providerPaymentMethodId: true, providerCustomerId: true },
  });

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const card of cards) {
    try {
      const current = await provider.fetchVaultedCard(
        card.providerCustomerId,
        card.providerPaymentMethodId,
      );

      if (current === null || current.providerCustomerId === null) {
        skipped += 1;
        continue;
      }

      if (current.allowRedisplay !== 'always') {
        await provider.allowCheckoutRedisplay(card.providerPaymentMethodId);
      }
      updated += 1;
    } catch (error) {
      failed += 1;
      logger.error({ err: error, paymentMethodId: card.id }, 'could not backfill allow_redisplay');
    }
  }

  return { updated, skipped, failed };
}

function isUniqueViolation(error: unknown, index: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; message?: unknown; meta?: unknown };
  if (candidate.code !== 'P2002') return false;
  const message = typeof candidate.message === 'string' ? candidate.message : '';
  const detail = `${message} ${JSON.stringify(candidate.meta ?? {})}`;
  return detail.includes(index) || detail.includes('openAttemptKey');
}
