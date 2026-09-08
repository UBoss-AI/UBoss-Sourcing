/**
 * Payments.
 *
 * The rule this module exists to enforce: **an order becomes CONFIRMED only
 * from a signature-verified provider event whose amount and currency match the
 * order.** Not from a client redirect, not from an admin button, not from a
 * hopeful assumption after a timeout.
 *
 * Duplicate protection is structural. `payment_events.providerEventId` is
 * unique, so a redelivered webhook collides on insert and is acknowledged
 * without being reprocessed. Razorpay retries webhooks; without that index a
 * retry would confirm the order twice and commit the stock twice.
 */
import { ErrorCode, badRequest, conflict, forbidden, notFound } from '../../domain/errors.js';
import { serialiseMoney } from '../../domain/money.js';
import { decryptSecret, encryptSecret, maskSecret } from '../../infra/crypto.js';
import { newId } from '../../infra/ids.js';
import { logger } from '../../infra/logger.js';
import { prisma, type PrismaTransaction } from '../../infra/prisma.js';
import { env } from '../../config/env.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';
import {
  NotificationEvent,
  dispatchPendingNotifications,
  enqueueNotification,
} from '../notifications/notification.service.js';
import { transitionOrder } from '../orders/order.service.js';
import { RazorpayAdapter } from './razorpay.adapter.js';
import { StripeAdapter } from './stripe.adapter.js';
import { assertChargeable, markPaymentMethodExpired } from './payment-method.service.js';
import {
  PaymentProviderError,
  supportsOffSession,
  modeForCredential,
  type CreatePaymentResult,
  type PaymentMethodHint,
  type PaymentProvider,
  type ProviderCredentials,
  type ProviderKind,
  type VerifiedEvent,
} from './provider.js';

/** AAD binds a credential ciphertext to the row it belongs to. */
function credentialAad(connectionId: string): string {
  return `payment_connection:${connectionId}`;
}

export interface LoadedProvider {
  provider: PaymentProvider;
  connectionId: string;
  kind: ProviderKind;
}

/**
 * Resolve the active provider.
 *
 * Prefers an admin-configured connection (credentials encrypted in the
 * database) and falls back to environment credentials for local development.
 * With neither, it throws PAYMENT_PROVIDER_NOT_CONFIGURED - there is no
 * simulated-success branch, and none should be added.
 *
 * `preferred` is the customer's choice at checkout, and is exactly that: a
 * preference. A gateway the operator has not connected cannot be conjured up
 * by asking for it, so an unavailable preference falls back to whatever is
 * configured rather than failing the checkout. The caller is told which
 * gateway it actually got, in `kind`.
 */
export async function loadActiveProvider(preferred?: ProviderKind): Promise<LoadedProvider> {
  const connection =
    (preferred === undefined
      ? null
      : await prisma.paymentProviderConnection.findFirst({
          where: { isActive: true, provider: preferred },
          orderBy: { updatedAt: 'desc' },
        })) ??
    (await prisma.paymentProviderConnection.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' },
    }));

  if (connection !== null) {
    const decrypted = decryptSecret(connection.credentialsEnc, credentialAad(connection.id));
    const credentials = JSON.parse(decrypted) as ProviderCredentials;

    const webhookSecret =
      connection.webhookSecretEnc === null
        ? ''
        : decryptSecret(connection.webhookSecretEnc, credentialAad(connection.id));

    return {
      provider: buildProvider(connection.provider, { ...credentials, webhookSecret }),
      connectionId: connection.id,
      kind: connection.provider,
    };
  }

  // Development fallback. The env guard in config/env.ts already refuses a
  // live key outside production, so this path cannot silently go live.
  const fromEnv = envCredentials(preferred);

  if (fromEnv !== null) {
    const bootstrapped = await ensureBootstrapConnection(fromEnv.kind, fromEnv.credentials);
    return {
      provider: buildProvider(fromEnv.kind, fromEnv.credentials),
      connectionId: bootstrapped,
      kind: fromEnv.kind,
    };
  }

  throw badRequest(
    ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
    'No payment provider is configured. An administrator must connect one in Settings > Payments.',
  );
}

function buildProvider(kind: ProviderKind, credentials: ProviderCredentials): PaymentProvider {
  switch (kind) {
    case 'RAZORPAY':
      return new RazorpayAdapter(credentials);
    case 'STRIPE':
      return new StripeAdapter(credentials);
    default: {
      const exhaustive: never = kind;
      throw badRequest(
        ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
        `Unknown payment provider: ${String(exhaustive)}`,
      );
    }
  }
}

/** Display name for a gateway, for labels an administrator will read. */
const PROVIDER_LABEL: Readonly<Record<ProviderKind, string>> = Object.freeze({
  RAZORPAY: 'Razorpay',
  STRIPE: 'Stripe',
});

/**
 * Gateway credentials from the environment, if a complete pair exists.
 *
 * `preferred` is the customer's pick and outranks the configured default when
 * that gateway is actually usable. With no pick, or a pick whose keys are
 * missing, PAYMENT_DEFAULT_PROVIDER decides; and the non-default is still used
 * when the default one is absent - a half-configured default should not leave
 * a working gateway sitting unused and the checkout dead.
 *
 * Stripe's keyId is the PUBLISHABLE key, which is what the browser needs and
 * what `modeForCredential` reads; the secret key stays in `keySecret`.
 */
function envCredentials(
  preferred?: ProviderKind,
): { kind: ProviderKind; credentials: ProviderCredentials } | null {
  const razorpayCredentials = envCredentialsFor('RAZORPAY');
  const stripeCredentials = envCredentialsFor('STRIPE');

  const razorpay =
    razorpayCredentials === null
      ? null
      : { kind: 'RAZORPAY' as const, credentials: razorpayCredentials };

  const stripe =
    stripeCredentials === null ? null : { kind: 'STRIPE' as const, credentials: stripeCredentials };

  if (preferred === 'RAZORPAY' && razorpay !== null) return razorpay;
  if (preferred === 'STRIPE' && stripe !== null) return stripe;

  return env.PAYMENT_DEFAULT_PROVIDER === 'stripe' ? (stripe ?? razorpay) : (razorpay ?? stripe);
}

/**
 * Environment credentials for one named gateway, with no fallback.
 *
 * `envCredentials` answers "what should we use", and will hand back the other
 * gateway when the one asked for has no keys. This answers "does THIS gateway
 * have a complete pair", which is what a caller reasoning about one gateway at
 * a time needs - being given the other one would make its answer wrong.
 */
function envCredentialsFor(kind: ProviderKind): ProviderCredentials | null {
  if (kind === 'RAZORPAY') {
    return env.RAZORPAY_KEY_ID.length > 0 && env.RAZORPAY_KEY_SECRET.length > 0
      ? {
          keyId: env.RAZORPAY_KEY_ID,
          keySecret: env.RAZORPAY_KEY_SECRET,
          webhookSecret: env.RAZORPAY_WEBHOOK_SECRET,
        }
      : null;
  }

  return env.STRIPE_PUBLISHABLE_KEY.length > 0 && env.STRIPE_SECRET_KEY.length > 0
    ? {
        keyId: env.STRIPE_PUBLISHABLE_KEY,
        keySecret: env.STRIPE_SECRET_KEY,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      }
    : null;
}

/** A gateway the storefront may offer, and what it can be asked to show. */
export interface AvailableGateway {
  provider: ProviderKind;
  label: string;
  /**
   * Instruments worth naming separately in the UI.
   *
   * Two filters, and the list is what survives both. Only what this codebase
   * can actually *request* of the gateway, which is why it is short: a
   * Razorpay account also does netbanking and wallets, but nothing here asks
   * for those, so offering them as a choice would be a checkbox that changes
   * nothing. And only what the gateway's own account has switched on, which
   * comes from `offerableMethods` rather than from a list written here.
   */
  methods: PaymentMethodHint[];
  /**
   * ISO-4217 codes this gateway may be offered for, or null for no
   * restriction.
   *
   * Razorpay settles to an Indian account and is not an EEA acquirer - the
   * same point processors.service.ts makes to the operator. Offering it for a
   * EUR cart would put a gateway in front of the customer that declines the
   * payment after they have chosen it, which is a worse outcome than never
   * showing it.
   */
  currencies: string[] | null;
}

/**
 * Which gateways the storefront may put in front of a customer, and the
 * default.
 *
 * Derived from what is actually connected - an admin-configured connection or
 * environment keys - so a gateway nobody has credentials for never appears as
 * a choice. Returns no secrets: a provider name and a label, nothing more.
 */
export async function availableGateways(): Promise<{
  gateways: AvailableGateway[];
  defaultProvider: ProviderKind | null;
}> {
  const connections = await prisma.paymentProviderConnection.findMany({
    where: { isActive: true },
    select: { id: true, provider: true, credentialsEnc: true, webhookSecretEnc: true },
    orderBy: { updatedAt: 'desc' },
  });

  /**
   * One row per gateway, most recently updated first.
   *
   * Same tie-break `loadActiveProvider` uses, so the row consulted here about
   * a gateway's instruments is the row that would take the payment.
   */
  const active = new Map<ProviderKind, (typeof connections)[number]>();
  for (const row of connections) {
    if (!active.has(row.provider)) active.set(row.provider, row);
  }

  /**
   * What the environment could serve, if it came to that.
   *
   * Deliberately not merged with the active connections above. This has to
   * mirror `loadActiveProvider` exactly, and that function reaches for the
   * environment only when there is no active connection at all - so a
   * deployment with one active connection cannot serve a *second* gateway from
   * env keys, however complete those keys are.
   *
   * Getting this wrong is not a cosmetic bug. Env keys used to be merged in,
   * and the result was a checkout that offered a gateway an administrator had
   * deliberately deactivated: the customer chose it, and the payment silently
   * fell back to the one gateway that was actually connected. The offer must
   * never promise what resolution cannot deliver.
   */
  const fromEnvironment = new Set<ProviderKind>();
  if (env.RAZORPAY_KEY_ID.length > 0 && env.RAZORPAY_KEY_SECRET.length > 0) {
    fromEnvironment.add('RAZORPAY');
  }
  if (env.STRIPE_PUBLISHABLE_KEY.length > 0 && env.STRIPE_SECRET_KEY.length > 0) {
    fromEnvironment.add('STRIPE');
  }

  const connected = active.size > 0 ? new Set(active.keys()) : fromEnvironment;

  /**
   * What is fixed about each gateway. `methods` is not on this list, because
   * it is a fact about the merchant account and only the gateway knows it.
   */
  const catalogue: Omit<AvailableGateway, 'methods'>[] = [
    { provider: 'STRIPE', label: PROVIDER_LABEL.STRIPE, currencies: null },
    { provider: 'RAZORPAY', label: PROVIDER_LABEL.RAZORPAY, currencies: ['INR'] },
  ];

  const gateways: AvailableGateway[] = await Promise.all(
    catalogue
      .filter((entry) => connected.has(entry.provider))
      .map(async (entry) => ({
        ...entry,
        methods: await offerableMethodsFor(entry.provider, active.get(entry.provider)),
      })),
  );

  const configuredDefault: ProviderKind =
    env.PAYMENT_DEFAULT_PROVIDER === 'stripe' ? 'STRIPE' : 'RAZORPAY';

  const defaultProvider =
    gateways.find((entry) => entry.provider === configuredDefault)?.provider ??
    gateways[0]?.provider ??
    null;

  return { gateways, defaultProvider };
}

/** Just enough of a connection row to build an adapter from it. */
interface CredentialRow {
  id: string;
  credentialsEnc: string;
  webhookSecretEnc: string | null;
}

/**
 * Ask one gateway which instruments it would actually open on.
 *
 * `connection` is the active row for that gateway, or undefined when the offer
 * is coming from environment keys - the same two sources, resolved the same
 * way, as everywhere else in this file.
 *
 * Never throws and never rejects the whole offer. This runs while a customer
 * waits on the checkout page, and a gateway that cannot be asked is still a
 * gateway they can pay through: the fallback drops the named instrument, not
 * the gateway. Under-promising costs one tap inside the sheet.
 */
async function offerableMethodsFor(
  kind: ProviderKind,
  connection: CredentialRow | undefined,
): Promise<PaymentMethodHint[]> {
  try {
    const credentials =
      connection === undefined
        ? envCredentialsFor(kind)
        : {
            ...(JSON.parse(
              decryptSecret(connection.credentialsEnc, credentialAad(connection.id)),
            ) as ProviderCredentials),
            webhookSecret:
              connection.webhookSecretEnc === null
                ? ''
                : decryptSecret(connection.webhookSecretEnc, credentialAad(connection.id)),
          };

    if (credentials === null) return ['ANY'];

    return await buildProvider(kind, credentials).offerableMethods();
  } catch (error) {
    logger.warn(
      { provider: kind, reason: error instanceof Error ? error.message : 'unknown error' },
      'could not read the gateway instruments; offering none by name',
    );

    return ['ANY'];
  }
}

/**
 * Persist a connection row for the environment credentials.
 *
 * Payment transactions carry a foreign key to a connection, so one has to
 * exist. The credentials are encrypted here exactly as an admin-entered one
 * would be.
 *
 * The row is written inactive, and that is the point of it. `isActive` records
 * an operator's decision in Settings > Payments; this row records neither a
 * decision nor an operator, only that a payment once resolved through the
 * environment. Marking it active made the environment fallback destroy itself:
 * a deployment with keys for both gateways offered both, and then the first
 * payment turned one of them into "the active connection" - after which
 * `loadActiveProvider` stopped consulting the environment, `availableGateways`
 * saw a non-empty active set, and the other gateway vanished from checkout
 * with nothing changed by anybody. Left inactive, the environment keeps
 * governing both, and the first thing an administrator activates takes over
 * cleanly.
 */
async function ensureBootstrapConnection(
  kind: ProviderKind,
  credentials: ProviderCredentials,
): Promise<string> {
  const mode = modeForCredential(credentials.keyId);

  const existing = await prisma.paymentProviderConnection.findUnique({
    where: { provider_mode: { provider: kind, mode } },
    select: { id: true },
  });

  if (existing !== null) return existing.id;

  const id = newId();

  await prisma.paymentProviderConnection.create({
    data: {
      id,
      provider: kind,
      mode,
      label: `${PROVIDER_LABEL[kind]} (${mode}, from environment)`,
      credentialsEnc: encryptSecret(
        JSON.stringify({ keyId: credentials.keyId, keySecret: credentials.keySecret }),
        credentialAad(id),
      ),
      webhookSecretEnc:
        credentials.webhookSecret.length > 0
          ? encryptSecret(credentials.webhookSecret, credentialAad(id))
          : null,
      credentialsMask: maskSecret(credentials.keyId),
      isActive: false,
    },
  });

  return id;
}

export interface CreateOrderPaymentInput {
  orderId: string;
  customerProfileId: string;
  idempotencyKey: string;
  actorUserId: string | null;
  correlationId?: string | null;
  /**
   * The gateway the customer picked at checkout. A preference, not a
   * requirement - see `loadActiveProvider`.
   */
  preferredProvider?: ProviderKind;
  /** Which instruments to put in front of them. See `PaymentMethodHint`. */
  methodHint?: PaymentMethodHint;
}

export interface CreateOrderPaymentResult {
  paymentTransactionId: string;
  provider: ProviderKind;
  mode: string;
  providerOrderId: string;
  amount: ReturnType<typeof serialiseMoney>;
  checkoutPayload: Record<string, string | number>;
}

/**
 * Start a payment for an order.
 *
 * The amount comes from `orders.grandTotalMinor` and nowhere else. A client
 * that supplied its own amount would be choosing what to pay.
 */
export async function createOrderPayment(
  input: CreateOrderPaymentInput,
): Promise<CreateOrderPaymentResult> {
  const order = await prisma.order.findFirst({
    // Scoped by customer: another customer's order must not be payable.
    where: { id: input.orderId, customerProfileId: input.customerProfileId },
    include: { customerProfile: { include: { user: { select: { email: true } } } } },
  });

  if (order === null) throw notFound('Order');

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

  const outstanding = order.grandTotalMinor - order.paidMinor;
  if (outstanding <= 0n) {
    throw conflict(ErrorCode.ORDER_ALREADY_PAID, 'This order is already paid in full.');
  }

  /**
   * What the customer asked for, from the request or from the order.
   *
   * The order is the durable record, written at checkout. The request may
   * still override it, which is what lets a payment page offer a different
   * gateway after a decline - but with nothing in the request, a reload or a
   * return to this order hours later gets the same sheet rather than the
   * default, which is the whole point of storing it.
   */
  const preferredProvider = input.preferredProvider ?? order.preferredPaymentProvider ?? undefined;
  const preferredMethod = input.methodHint ?? order.preferredPaymentMethod ?? undefined;

  const { provider, connectionId } = await loadActiveProvider(preferredProvider);

  /**
   * A hint the resolved gateway can actually act on.
   *
   * The customer picks a gateway and an instrument together, but the gateway
   * they picked may not be the one they get - the one they chose may have been
   * disconnected since checkout. Carrying "UPI" over to Stripe would open a
   * sheet asking for an instrument Stripe cannot settle, so the hint is
   * dropped with the gateway it belonged to.
   */
  const methodHint: PaymentMethodHint =
    preferredMethod === 'UPI' && provider.kind === 'RAZORPAY' ? 'UPI' : 'ANY';

  /**
   * An earlier attempt with this same key.
   *
   * `payment_transactions.idempotencyKey` is unique, so a retry would collide
   * on insert — which is the protection working, but a unique-constraint
   * violation is not an answer a client can use. A customer whose payment
   * failed and who presses "try again" reaches exactly this path, so it must
   * replay the original session rather than 500.
   *
   * Checked before the provider is called, so a retry also does not leave an
   * orphaned order in the gateway's dashboard.
   */
  const existing = await prisma.paymentTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing !== null) {
    if (existing.orderId !== order.id) {
      // The same key used against a different order is a client bug, and
      // replaying the other order's session would be a data leak.
      throw conflict(
        ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY,
        'That request key has already been used for a different order.',
      );
    }

    // Razorpay derives this with no call; Stripe re-reads the intent for its
    // client secret. Either way a provider failure here is the provider's, and
    // must reach the customer as one rather than as a 500 on a retry that was
    // working a moment ago.
    let replayPayload: Record<string, string | number>;
    try {
      replayPayload = await provider.buildCheckoutPayload(existing.providerOrderId ?? '', {
        orderId: order.id,
        orderNumber: order.orderNumber,
        amountMinor: existing.amountMinor,
        currency: existing.currency,
        customerEmail: order.customerProfile.user.email,
        customerName: order.customerProfile.fullName,
        customerPhone: order.customerProfile.phone,
        methodHint,
      });
    } catch (error) {
      if (error instanceof PaymentProviderError) {
        throw badRequest(
          ErrorCode.PAYMENT_PROVIDER_ERROR,
          error.message,
          [{ code: error.providerCode ?? 'PROVIDER_ERROR', field: 'payment' }],
        );
      }
      throw error;
    }

    return {
      paymentTransactionId: existing.id,
      provider: existing.provider,
      mode: existing.mode,
      providerOrderId: existing.providerOrderId ?? '',
      amount: serialiseMoney(existing.amountMinor, existing.currency),
      checkoutPayload: replayPayload,
    };
  }

  let created: CreatePaymentResult;
  try {
    created = await provider.createPayment({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: outstanding,
      currency: order.currency,
      customerEmail: order.customerProfile.user.email,
      customerName: order.customerProfile.fullName,
      customerPhone: order.customerProfile.phone,
      methodHint,
      idempotencyKey: input.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      throw badRequest(
        ErrorCode.PAYMENT_PROVIDER_ERROR,
        // The provider's own message is safe to surface: it explains the
        // failure to the customer without exposing credentials.
        error.message,
        [{ code: error.providerCode ?? 'PROVIDER_ERROR', field: 'payment' }],
      );
    }
    throw error;
  }

  const transactionId = newId();

  await prisma.paymentTransaction.create({
    data: {
      id: transactionId,
      orderId: order.id,
      connectionId,
      provider: provider.kind,
      mode: provider.mode,
      providerOrderId: created.providerOrderId,
      status: 'CREATED',
      amountMinor: outstanding,
      currency: order.currency,
      idempotencyKey: input.idempotencyKey,
    },
  });

  await recordAudit({
    action: AuditAction.PAYMENT_CREATED,
    resourceType: 'payment',
    resourceId: transactionId,
    actorType: 'CUSTOMER',
    actorUserId: input.actorUserId,
    after: {
      orderId: order.id,
      providerOrderId: created.providerOrderId,
      amountMinor: outstanding,
      provider: provider.kind,
      mode: provider.mode,
    },
    correlationId: input.correlationId ?? null,
  });

  return {
    paymentTransactionId: transactionId,
    provider: provider.kind,
    mode: provider.mode,
    providerOrderId: created.providerOrderId,
    amount: serialiseMoney(outstanding, order.currency),
    checkoutPayload: created.checkoutPayload,
  };
}

// ---------------------------------------------------------------------------
// Off-session charging
// ---------------------------------------------------------------------------

export interface ChargeOffSessionInput {
  orderId: string;
  /** The stored instrument to charge. Never the provider's default. */
  paymentMethodId: string;
  /**
   * Stable across every retry of this charge.
   *
   * Doing double duty: it is `payment_transactions.idempotencyKey` (unique, so
   * a retry finds the first attempt instead of starting a second) and it is
   * the key sent to the provider (so the provider itself de-duplicates). One
   * value for both means the two cannot disagree about what "the same charge"
   * means.
   */
  idempotencyKey: string;
  scheduleId?: string | null;
  occurrenceId?: string | null;
  correlationId?: string | null;
}

export interface ChargeOffSessionResult {
  outcome: 'CAPTURED' | 'ACTION_REQUIRED' | 'FAILED';
  paymentTransactionId: string;
  providerOrderId: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  /** True when an earlier attempt with this key had already charged. */
  replayed: boolean;
}

/**
 * Charge a stored instrument for an order, with nobody present.
 *
 * The path a subscription's money actually travels. Four properties matter,
 * and each one is a bug that has bitten somebody else:
 *
 *   1. **A replay never charges twice.** The idempotency key is checked
 *      against `payment_transactions` BEFORE the provider is called, and it
 *      is also handed to the provider. A worker that dies between the charge
 *      succeeding and the row being written retries into the same payment.
 *
 *   2. **Authentication-required is not a failure.** The bank asking for the
 *      cardholder means the money has not moved and the payment is still open.
 *      Reported as its own outcome so the caller holds and notifies instead of
 *      failing the occurrence and cancelling the order.
 *
 *   3. **The capture is applied by the provider's authority, not ours.** On
 *      success this defers to `reconcilePayment`, which re-reads the payment
 *      from the provider and applies it through the same guarded code the
 *      webhook uses. So there is exactly one place in this system that turns a
 *      payment into a CONFIRMED order, and it is never a caller's belief about
 *      what happened.
 *
 *   4. **A failure leaves the order payable, not cancelled.** Cancelling here
 *      would release the stock and destroy the record the retry needs. The
 *      caller decides what happens to the order, because only it knows whether
 *      a human is waiting.
 */
export async function chargeOrderOffSession(
  input: ChargeOffSessionInput,
): Promise<ChargeOffSessionResult> {
  const order = await prisma.order.findUnique({
    where: { id: input.orderId },
    include: { customerProfile: { include: { user: { select: { email: true } } } } },
  });

  if (order === null) throw notFound('Order');

  const method = await prisma.customerPaymentMethod.findUnique({
    where: { id: input.paymentMethodId },
  });

  if (method === null) {
    throw badRequest(
      ErrorCode.SCHEDULE_PAYMENT_METHOD_INVALID,
      'The saved payment method for this order no longer exists.',
    );
  }

  // Belongs to somebody else. Would be a serious mix-up, so it is refused
  // rather than reconciled.
  if (method.customerProfileId !== order.customerProfileId) {
    logger.error(
      { orderId: order.id, paymentMethodId: input.paymentMethodId },
      'refusing to charge a payment method that belongs to a different customer',
    );
    throw forbidden(
      ErrorCode.RESOURCE_OWNERSHIP_DENIED,
      'That payment method does not belong to this order.',
    );
  }

  assertChargeable(method);

  // --- Replay check, before the provider is touched ----------------------
  const existing = await prisma.paymentTransaction.findUnique({
    where: { idempotencyKey: input.idempotencyKey },
  });

  if (existing !== null) {
    if (existing.orderId !== order.id) {
      throw conflict(
        ErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY,
        'That request key has already been used for a different order.',
      );
    }

    if (existing.status === 'CAPTURED') {
      // Already paid. Returned as a replay so the caller does not treat it as
      // a fresh success and repeat everything that follows a charge.
      return {
        outcome: 'CAPTURED',
        paymentTransactionId: existing.id,
        providerOrderId: existing.providerOrderId,
        failureCode: null,
        failureMessage: null,
        replayed: true,
      };
    }

    // A previous attempt that did not settle. Re-reading the provider is the
    // only safe way to find out what really happened, and it is what
    // reconciliation is for.
    if (existing.providerOrderId !== null) {
      const reconciled = await reconcilePayment(existing.id);

      if (reconciled.status === 'CAPTURED') {
        return {
          outcome: 'CAPTURED',
          paymentTransactionId: existing.id,
          providerOrderId: existing.providerOrderId,
          failureCode: null,
          failureMessage: null,
          replayed: true,
        };
      }
    }
  }

  const outstanding = order.grandTotalMinor - order.paidMinor;

  if (outstanding <= 0n) {
    throw conflict(ErrorCode.ORDER_ALREADY_PAID, 'This order is already paid in full.');
  }

  const { provider, connectionId, kind } = await loadActiveProvider('STRIPE');

  if (!supportsOffSession(provider)) {
    throw badRequest(
      ErrorCode.PAYMENT_PROVIDER_NOT_CONFIGURED,
      `${kind} cannot charge a saved payment method without the customer present.`,
    );
  }

  // The row exists before the charge, so a crash mid-call leaves a record with
  // the idempotency key on it rather than an unexplained charge at the
  // provider that nothing here can match.
  const transactionId = existing?.id ?? newId();

  if (existing === null) {
    await prisma.paymentTransaction.create({
      data: {
        id: transactionId,
        orderId: order.id,
        connectionId,
        provider: provider.kind,
        mode: provider.mode,
        status: 'CREATED',
        amountMinor: outstanding,
        currency: order.currency,
        idempotencyKey: input.idempotencyKey,
      },
    });
  }

  let charge;

  try {
    charge = await provider.chargeOffSession({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: outstanding,
      currency: order.currency,
      providerCustomerId: method.providerCustomerId,
      providerPaymentMethodId: method.providerPaymentMethodId,
      idempotencyKey: input.idempotencyKey,
      scheduleId: input.scheduleId ?? null,
      occurrenceId: input.occurrenceId ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown provider error';
    const code = error instanceof PaymentProviderError ? error.providerCode : null;

    await prisma.paymentTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'FAILED',
        failureCode: code,
        failureMessage: message.slice(0, 500),
        failedAt: new Date(),
      },
    });

    // A card the provider says has expired is worth recording: the stored
    // month and year were what it knew at enrolment, and a reissued card can
    // lapse earlier than that. Left ACTIVE, it would be offered again.
    if (code === 'expired_card') {
      await markPaymentMethodExpired(input.paymentMethodId);
    }

    await recordAudit({
      action: AuditAction.PAYMENT_FAILED,
      resourceType: 'payment',
      resourceId: transactionId,
      actorType: 'SYSTEM',
      after: {
        orderId: order.id,
        offSession: true,
        providerCode: code,
        message: message.slice(0, 300),
      },
      correlationId: input.correlationId ?? null,
    });

    return {
      outcome: 'FAILED',
      paymentTransactionId: transactionId,
      providerOrderId: null,
      failureCode: code,
      failureMessage: message,
      replayed: false,
    };
  }

  await prisma.paymentTransaction.update({
    where: { id: transactionId },
    data: {
      providerOrderId: charge.providerOrderId,
      providerPaymentId: charge.providerPaymentId,
      status: charge.requiresAction ? 'PENDING' : 'CREATED',
    },
  });

  if (charge.requiresAction) {
    await recordAudit({
      action: AuditAction.PAYMENT_ACTION_REQUIRED,
      resourceType: 'payment',
      resourceId: transactionId,
      actorType: 'SYSTEM',
      after: { orderId: order.id, providerOrderId: charge.providerOrderId },
      correlationId: input.correlationId ?? null,
    });

    return {
      outcome: 'ACTION_REQUIRED',
      paymentTransactionId: transactionId,
      providerOrderId: charge.providerOrderId,
      failureCode: 'authentication_required',
      failureMessage: charge.failureMessage,
      replayed: false,
    };
  }

  if (charge.status === 'FAILED' || charge.status === 'CANCELLED') {
    await prisma.paymentTransaction.update({
      where: { id: transactionId },
      data: {
        status: 'FAILED',
        failureCode: charge.failureCode,
        failureMessage: charge.failureMessage?.slice(0, 500) ?? null,
        failedAt: new Date(),
      },
    });

    return {
      outcome: 'FAILED',
      paymentTransactionId: transactionId,
      providerOrderId: charge.providerOrderId,
      failureCode: charge.failureCode,
      failureMessage: charge.failureMessage,
      replayed: false,
    };
  }

  // Captured, as far as the charge call is concerned. It is still applied
  // through reconciliation rather than written here - see point 3 in the
  // header. One code path turns a payment into a confirmed order.
  const reconciled = await reconcilePayment(transactionId);

  if (reconciled.status !== 'CAPTURED') {
    // The charge returned a success the provider then did not confirm on
    // re-read. Left PENDING rather than forced either way: the webhook and the
    // reconcile sweep will settle it, and guessing here is how an order gets
    // confirmed against a payment that did not happen.
    logger.warn(
      { transactionId, orderId: order.id, reconciledStatus: reconciled.status },
      'an off-session charge reported success but did not reconcile as captured',
    );

    return {
      outcome: 'ACTION_REQUIRED',
      paymentTransactionId: transactionId,
      providerOrderId: charge.providerOrderId,
      failureCode: 'not_confirmed',
      failureMessage: 'The payment has not been confirmed by the provider yet.',
      replayed: false,
    };
  }

  await recordAudit({
    action: AuditAction.PAYMENT_OFF_SESSION_CHARGED,
    resourceType: 'payment',
    resourceId: transactionId,
    actorType: 'SYSTEM',
    after: {
      orderId: order.id,
      scheduleId: input.scheduleId ?? null,
      occurrenceId: input.occurrenceId ?? null,
      amountMinor: outstanding.toString(),
      currency: order.currency,
      // Which card, in the terms a person reads. Not the reference.
      card: `${method.brand ?? 'card'} ****${method.last4 ?? '????'}`,
    },
    correlationId: input.correlationId ?? null,
  });

  return {
    outcome: 'CAPTURED',
    paymentTransactionId: transactionId,
    providerOrderId: charge.providerOrderId,
    failureCode: null,
    failureMessage: null,
    replayed: false,
  };
}

export interface WebhookResult {
  accepted: boolean;
  duplicate: boolean;
  reason?: string;
}

/**
 * Process a provider webhook.
 *
 * The order of operations is the security design:
 *
 *   1. Verify the signature over the RAW body. Nothing is trusted before this.
 *   2. Record the event, keyed unique on providerEventId. A duplicate collides
 *      here and stops.
 *   3. Match the order, amount and currency. A mismatch is rejected and
 *      alerted, never applied.
 *   4. Apply the state change transactionally.
 *
 * Returns 200 even for a rejected event: the provider must stop retrying
 * something we have deliberately refused. The rejection is recorded and
 * alerted instead.
 */
export async function processWebhook(
  rawBody: Buffer,
  headers: Record<string, string | undefined>,
  correlationId?: string,
): Promise<WebhookResult> {
  const { provider, connectionId } = await loadActiveProvider();

  // --- 1. Verify --------------------------------------------------------
  const event: VerifiedEvent = provider.verifyWebhook(rawBody, headers);

  if (!event.verified) {
    logger.warn(
      { reason: event.rejectionReason, provider: provider.kind, correlationId },
      'rejected an unverified payment webhook',
    );

    await prisma.paymentEvent.create({
      data: {
        id: newId(),
        provider: provider.kind,
        connectionId,
        // Unverified events have no trustworthy id; a random one keeps the
        // audit row without letting a forged id poison the duplicate guard.
        providerEventId: `unverified:${newId()}`,
        eventType: 'unverified',
        signatureVerified: false,
        rawPayload: rawBody.toString('utf8').slice(0, 60_000),
        processingStatus: 'REJECTED',
        processingError: event.rejectionReason ?? 'signature verification failed',
      },
    });

    await recordAudit({
      action: AuditAction.WEBHOOK_REJECTED,
      resourceType: 'payment_event',
      actorType: 'PROVIDER',
      after: { reason: event.rejectionReason, provider: provider.kind },
      correlationId: correlationId ?? null,
    });

    return { accepted: false, duplicate: false, reason: 'signature verification failed' };
  }

  // --- 2. Duplicate guard ------------------------------------------------
  const eventRowId = newId();

  const inserted = await prisma.paymentEvent.createMany({
    data: [
      {
        id: eventRowId,
        provider: provider.kind,
        connectionId,
        providerEventId: event.eventId,
        eventType: event.eventType,
        signatureVerified: true,
        rawPayload: rawBody.toString('utf8').slice(0, 60_000),
        processingStatus: 'RECEIVED',
      },
    ],
    skipDuplicates: true,
  });

  if (inserted.count === 0) {
    // Already seen. Acknowledge so the provider stops retrying, and change
    // nothing - this is what makes redelivery harmless.
    logger.info({ eventId: event.eventId, correlationId }, 'duplicate webhook acknowledged');
    return { accepted: true, duplicate: true };
  }

  try {
    const outcome = await applyEvent(event, eventRowId, correlationId);
    return outcome;
  } catch (error) {
    await prisma.paymentEvent.update({
      where: { id: eventRowId },
      data: {
        processingStatus: 'FAILED',
        processingError: error instanceof Error ? error.message.slice(0, 1000) : 'unknown error',
      },
    });
    throw error;
  }
}

async function applyEvent(
  event: VerifiedEvent,
  eventRowId: string,
  correlationId?: string,
): Promise<WebhookResult> {
  if (event.intent === 'UNKNOWN') {
    // A real event we simply do not act on (payment.authorized, and so on).
    await prisma.paymentEvent.update({
      where: { id: eventRowId },
      data: { processingStatus: 'PROCESSED', processedAt: new Date() },
    });
    return { accepted: true, duplicate: false, reason: 'event type not actionable' };
  }

  // --- Enrolment, which has no payment to match --------------------------
  //
  // Handled before the lookup below, because a SetupIntent has no
  // PaymentTransaction and would otherwise fall through to "no matching
  // payment transaction" - which is treated as a security signal and alerts
  // finance. A customer saving a card is not a security signal.
  //
  // The enrolment itself is completed by the browser calling
  // `completePaymentMethodEnrolment`, which re-reads the SetupIntent from the
  // provider. This event is the backstop for the case where the customer
  // closed the tab in between: the card is attached at the provider and this
  // records that fact so support can see it.
  if (event.intent === 'SETUP_COMPLETED') {
    await prisma.paymentEvent.update({
      where: { id: eventRowId },
      data: { processingStatus: 'PROCESSED', processedAt: new Date() },
    });

    logger.info(
      {
        setupIntentId: event.providerSetupIntentId,
        paymentMethodId: event.providerPaymentMethodId,
      },
      'a payment method finished setup at the provider',
    );

    return { accepted: true, duplicate: false };
  }

  // --- 3. Match ----------------------------------------------------------
  const transaction =
    event.providerOrderId === null
      ? null
      : await prisma.paymentTransaction.findFirst({
          where: { providerOrderId: event.providerOrderId },
          include: { order: true },
        });

  if (transaction === null) {
    await markEventRejected(eventRowId, 'no matching payment transaction');
    return { accepted: false, duplicate: false, reason: 'no matching payment transaction' };
  }

  const order = transaction.order;

  if (event.intent === 'PAYMENT_CAPTURED') {
    // The amount check. A provider event claiming a different amount than the
    // order is either a bug or an attack, and must never confirm the order.
    if (event.amountMinor !== null && event.amountMinor !== transaction.amountMinor) {
      await markEventRejected(
        eventRowId,
        `amount mismatch: event ${event.amountMinor.toString()} vs expected ${transaction.amountMinor.toString()}`,
      );

      await alertFinance(order.id, order.orderNumber, 'PAYMENT_AMOUNT_MISMATCH', {
        expectedMinor: transaction.amountMinor.toString(),
        receivedMinor: event.amountMinor.toString(),
      });

      return { accepted: false, duplicate: false, reason: 'amount mismatch' };
    }

    if (event.currency !== null && event.currency !== transaction.currency) {
      await markEventRejected(
        eventRowId,
        `currency mismatch: event ${event.currency} vs expected ${transaction.currency}`,
      );
      return { accepted: false, duplicate: false, reason: 'currency mismatch' };
    }

    // --- 4. Apply --------------------------------------------------------
    //
    // The transaction is moved to CAPTURED with a conditional UPDATE, and
    // `paidMinor` is credited only if that UPDATE actually matched a row.
    //
    // Without the guard, a capture applied twice credits the order twice.
    // `payment_events` de-duplicates redelivery of the SAME event, but it
    // cannot help when the capture arrives by two different routes - which is
    // the ordinary case, not an edge one: an off-session charge is applied from
    // Stripe's own synchronous response via `reconcilePayment`, and
    // `payment_intent.succeeded` then arrives seconds later as a genuinely new
    // event. That produced an order with `paidMinor` at twice its total, which
    // reads as an overpayment and would invite a refund of money nobody paid.
    const applied = await prisma.$transaction(async (tx) => {
      const claimed = await tx.paymentTransaction.updateMany({
        // The guard. Once this row is CAPTURED, it matches nothing.
        where: { id: transaction.id, status: { not: 'CAPTURED' } },
        data: {
          status: 'CAPTURED',
          providerPaymentId: event.providerPaymentId,
          capturedMinor: event.amountMinor ?? transaction.amountMinor,
          method: event.method,
          capturedAt: new Date(),
        },
      });

      if (claimed.count === 1) {
        await tx.order.update({
          where: { id: order.id },
          data: { paidMinor: { increment: event.amountMinor ?? transaction.amountMinor } },
        });
      }

      await tx.paymentEvent.update({
        where: { id: eventRowId },
        data: {
          processingStatus: 'PROCESSED',
          processedAt: new Date(),
          orderId: order.id,
          paymentTransactionId: transaction.id,
        },
      });

      return claimed.count === 1;
    });

    if (!applied) {
      logger.info(
        { orderId: order.id, eventId: event.eventId },
        'capture already applied by another route; acknowledged without crediting again',
      );
    }

    // The only path to CONFIRMED. SYSTEM actor, because the authority is the
    // verified provider event, not any human.
    if (order.status === 'PENDING_PAYMENT') {
      await transitionOrder({
        orderId: order.id,
        to: 'CONFIRMED',
        actor: {
          userId: null,
          email: null,
          type: 'SYSTEM',
          ...(correlationId !== undefined ? { correlationId } : {}),
        },
        reason: 'Payment captured and verified',
        meta: { providerPaymentId: event.providerPaymentId, eventId: event.eventId },
      });
    }

    await recordAudit({
      action: AuditAction.PAYMENT_CAPTURED,
      resourceType: 'payment',
      resourceId: transaction.id,
      actorType: 'PROVIDER',
      after: {
        orderId: order.id,
        providerPaymentId: event.providerPaymentId,
        amountMinor: event.amountMinor,
      },
      correlationId: correlationId ?? null,
    });

    // --- 5. Everything that follows a confirmed payment -------------------
    //
    // Reached whether the money arrived by an interactive checkout, a payment
    // link, or an off-session charge, and safe to reach twice: both branches
    // below are idempotent, which is what keeps a redelivered webhook from
    // producing a second ERP order.
    //
    // Deliberately after the audit record and outside the transaction above:
    // an ERP that is slow or refusing must not roll back a payment this system
    // has already accepted.
    if (order.scheduleOccurrenceId !== null) {
      // A scheduled delivery. Settlement covers the ERP push, the inventory
      // reconciliation, the occurrence's own status and the plan's next slot.
      const { settleOccurrenceForOrder } = await import('../recurring/occurrence.service.js');

      await settleOccurrenceForOrder(order.id, correlationId).catch((error: unknown) => {
        // The payment stands. An occurrence left mid-settlement is picked up
        // by the retry sweep, and failing the webhook here would only make
        // the provider redeliver something already applied.
        logger.error(
          { err: error, orderId: order.id },
          'could not settle the scheduled occurrence behind a captured payment',
        );
      });
    } else {
      // An ordinary order. A no-op where no ERP is configured.
      const { pushOrderToErp } = await import('../integrations/erp-order.service.js');

      await pushOrderToErp({
        orderId: order.id,
        // Derived from the order, so every retry - and every redelivery of
        // this webhook - sends the ERP the same idempotency key.
        idempotencyKey: `erp:order:${order.id}`,
        correlationId: correlationId ?? null,
      }).catch((error: unknown) => {
        logger.error(
          { err: error, orderId: order.id },
          'could not push a paid order to the ERP; it will be retried',
        );
      });
    }

    return { accepted: true, duplicate: false };
  }

  // Not a failure, and it must not be recorded as one: the money has not
  // moved, the payment is still open, and only the customer can advance it.
  // Marking the transaction FAILED here would let the retry path start a
  // second charge for the same delivery.
  if (event.intent === 'PAYMENT_ACTION_REQUIRED') {
    await prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.updateMany({
        // Never over a settled payment. A late-arriving requires_action for an
        // intent that has since succeeded must change nothing.
        where: { id: transaction.id, status: { notIn: ['CAPTURED', 'FAILED'] } },
        data: { status: 'PENDING', failureCode: event.failureCode },
      });

      await tx.paymentEvent.update({
        where: { id: eventRowId },
        data: {
          processingStatus: 'PROCESSED',
          processedAt: new Date(),
          orderId: order.id,
          paymentTransactionId: transaction.id,
        },
      });
    });

    if (order.scheduleOccurrenceId !== null) {
      await prisma.scheduleOccurrence.updateMany({
        where: { id: order.scheduleOccurrenceId, status: 'PAYMENT_PENDING' },
        data: {
          status: 'ACTION_REQUIRED',
          actionRequiredAt: new Date(),
          failureCode: event.failureCode,
          failureMessage: event.failureMessage?.slice(0, 500) ?? null,
        },
      });
    }

    return { accepted: true, duplicate: false };
  }

  if (event.intent === 'PAYMENT_FAILED') {
    await prisma.$transaction(async (tx) => {
      await tx.paymentTransaction.update({
        where: { id: transaction.id },
        data: {
          status: 'FAILED',
          providerPaymentId: event.providerPaymentId,
          failureCode: event.failureCode,
          failureMessage: event.failureMessage,
          failedAt: new Date(),
        },
      });

      await tx.paymentEvent.update({
        where: { id: eventRowId },
        data: {
          processingStatus: 'PROCESSED',
          processedAt: new Date(),
          orderId: order.id,
          paymentTransactionId: transaction.id,
        },
      });
    });

    // The order stays PENDING_PAYMENT so the customer can safely retry against
    // the SAME order. Cancelling here would strand their reserved stock.
    await enqueueNotification({
      eventKey: NotificationEvent.PAYMENT_FAILED,
      recipientEmail: (
        await prisma.customerProfile.findUniqueOrThrow({
          where: { id: order.customerProfileId },
          include: { user: { select: { email: true } } },
        })
      ).user.email,
      variables: {
        orderNumber: order.orderNumber,
        reason: event.failureMessage ?? 'The payment could not be completed.',
      },
      dedupeKey: `payment_failed:${event.eventId}`,
      relatedType: 'order',
      relatedId: order.id,
      ...(correlationId !== undefined ? { correlationId } : {}),
    });

    await dispatchPendingNotifications();
    return { accepted: true, duplicate: false };
  }

  if (event.intent === 'REFUND_PROCESSED' && event.providerRefundId !== null) {
    await prisma.refund.updateMany({
      where: { providerRefundId: event.providerRefundId },
      data: {
        status: event.eventType === 'refund.failed' ? 'FAILED' : 'SUCCEEDED',
        completedAt: new Date(),
      },
    });

    await prisma.paymentEvent.update({
      where: { id: eventRowId },
      data: {
        processingStatus: 'PROCESSED',
        processedAt: new Date(),
        orderId: order.id,
        paymentTransactionId: transaction.id,
      },
    });

    return { accepted: true, duplicate: false };
  }

  await markEventRejected(eventRowId, 'event could not be applied');
  return { accepted: false, duplicate: false, reason: 'event could not be applied' };
}

async function markEventRejected(eventRowId: string, reason: string): Promise<void> {
  logger.error({ eventRowId, reason }, 'payment webhook rejected after verification');

  await prisma.paymentEvent.update({
    where: { id: eventRowId },
    data: {
      processingStatus: 'REJECTED',
      processingError: reason.slice(0, 1000),
      processedAt: new Date(),
    },
  });

  await recordAudit({
    action: AuditAction.WEBHOOK_REJECTED,
    resourceType: 'payment_event',
    resourceId: eventRowId,
    actorType: 'PROVIDER',
    after: { reason },
  });
}

/** A verified event we refused to apply is a security signal, not a footnote. */
async function alertFinance(
  orderId: string,
  orderNumber: string,
  code: string,
  detail: Record<string, string>,
): Promise<void> {
  const setting = await prisma.notificationSetting.findUnique({
    where: { eventKey: NotificationEvent.PAYMENT_FAILED },
  });

  const recipients = Array.isArray(setting?.internalRecipientsJson)
    ? (setting.internalRecipientsJson as unknown[]).filter(
        (entry): entry is string => typeof entry === 'string',
      )
    : [];

  if (recipients.length === 0) {
    logger.error(
      { orderId, orderNumber, code, ...detail },
      'payment discrepancy detected but no finance recipients are configured',
    );
    return;
  }

  for (const recipient of recipients) {
    await enqueueNotification({
      eventKey: NotificationEvent.PAYMENT_FAILED,
      recipientEmail: recipient,
      variables: { orderNumber, reason: `${code}: ${JSON.stringify(detail)}` },
      dedupeKey: `discrepancy:${orderId}:${code}`,
      relatedType: 'order',
      relatedId: orderId,
    });
  }

  await dispatchPendingNotifications();
}

/**
 * Re-query the provider and reconcile.
 *
 * The recovery path when a customer's browser timed out mid-redirect or a
 * webhook has not arrived. The provider is the authority; the client's belief
 * about what happened is not consulted.
 */
export async function reconcilePayment(
  paymentTransactionId: string,
): Promise<{ status: string; changed: boolean }> {
  const transaction = await prisma.paymentTransaction.findUnique({
    where: { id: paymentTransactionId },
    include: { order: true },
  });

  if (transaction === null) throw notFound('Payment');
  if (transaction.providerOrderId === null) {
    return { status: transaction.status, changed: false };
  }

  const { provider } = await loadActiveProvider();
  const remote = await provider.fetchPaymentStatus(transaction.providerOrderId);

  await prisma.paymentTransaction.update({
    where: { id: transaction.id },
    data: { reconciledAt: new Date() },
  });

  if (remote.status !== 'CAPTURED' || transaction.status === 'CAPTURED') {
    return { status: transaction.status, changed: false };
  }

  // The provider says captured and we did not know. The amount check applies
  // here exactly as it does on the webhook path.
  if (remote.amountMinor !== transaction.amountMinor) {
    logger.error(
      {
        paymentTransactionId,
        expected: transaction.amountMinor.toString(),
        received: remote.amountMinor.toString(),
      },
      'reconciliation found an amount mismatch; refusing to confirm',
    );

    await alertFinance(transaction.orderId, transaction.order.orderNumber, 'RECONCILE_AMOUNT_MISMATCH', {
      expectedMinor: transaction.amountMinor.toString(),
      receivedMinor: remote.amountMinor.toString(),
    });

    return { status: transaction.status, changed: false };
  }

  await prisma.$transaction(async (tx) => {
    await tx.paymentTransaction.update({
      where: { id: transaction.id },
      data: {
        status: 'CAPTURED',
        providerPaymentId: remote.providerPaymentId,
        capturedMinor: remote.amountMinor,
        method: remote.method,
        capturedAt: new Date(),
      },
    });

    await tx.order.update({
      where: { id: transaction.orderId },
      data: { paidMinor: { increment: remote.amountMinor } },
    });
  });

  if (transaction.order.status === 'PENDING_PAYMENT') {
    await transitionOrder({
      orderId: transaction.orderId,
      to: 'CONFIRMED',
      actor: { userId: null, email: null, type: 'SYSTEM' },
      reason: 'Payment confirmed by reconciliation',
    });
  }

  return { status: 'CAPTURED', changed: true };
}

/** Read-only payment view for the order page while a webhook is in flight. */
export async function getPaymentStatusForOrder(
  orderId: string,
  customerProfileId: string,
): Promise<{ status: string; paid: boolean; orderStatus: string }> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerProfileId },
    include: { payments: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });

  if (order === null) throw notFound('Order');

  const latest = order.payments[0] ?? null;

  return {
    status: latest?.status ?? 'NONE',
    // Derived from the order's settled money, which only a verified event
    // advances - never from what the browser reported.
    paid: order.paidMinor >= order.grandTotalMinor && order.grandTotalMinor > 0n,
    orderStatus: order.status,
  };
}

export type { PrismaTransaction };

/**
 * Test one saved connection's credentials and record the verdict on the row.
 *
 * Distinct from the environment-level test: an administrator who has just
 * pasted keys needs to know whether *those* keys work, and activation is
 * gated on the stored `lastTestStatus`. Testing the ambient provider instead
 * would let a broken connection be activated on the strength of a different
 * one's success.
 *
 * A failure is recorded, not thrown away - the Integrations page shows the
 * provider's own message, which is usually the fastest route to the fix.
 */
export async function testStoredConnection(
  connectionId: string,
): Promise<{ ok: boolean; mode: string | null; message: string }> {
  const connection = await prisma.paymentProviderConnection.findUnique({
    where: { id: connectionId },
  });

  if (connection === null) throw notFound('Payment connection');

  const decrypted = decryptSecret(connection.credentialsEnc, credentialAad(connection.id));
  const credentials = JSON.parse(decrypted) as ProviderCredentials;

  const webhookSecret =
    connection.webhookSecretEnc === null
      ? ''
      : decryptSecret(connection.webhookSecretEnc, credentialAad(connection.id));

  let result: { ok: boolean; mode: string | null; message: string };

  try {
    const provider = buildProvider(connection.provider, { ...credentials, webhookSecret });
    const outcome = await provider.testConnection();
    result = { ok: outcome.ok, mode: outcome.mode, message: outcome.message };
  } catch (error) {
    // Includes the unimplemented-Stripe case, which is a legitimate answer to
    // "do these credentials work" rather than a server fault.
    result = {
      ok: false,
      mode: null,
      message: error instanceof Error ? error.message : 'The connection test failed.',
    };
  }

  await prisma.paymentProviderConnection.update({
    where: { id: connectionId },
    data: {
      lastTestedAt: new Date(),
      lastTestStatus: result.ok ? 'OK' : 'FAILED',
      lastTestMessage: result.message.slice(0, 500),
      // A connection that has stopped working must not keep taking payments.
      ...(result.ok ? {} : { isActive: false }),
    },
  });

  return result;
}
