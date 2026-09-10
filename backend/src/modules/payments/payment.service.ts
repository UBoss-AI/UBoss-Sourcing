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
import {
  cardSuitsInstrument,
  isCardInstrument,
  offerableInstruments,
  resolveInstrument,
  type GatewayOffer,
  type PaymentInstrument,
} from '../../domain/payment-instrument.js';
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
import {
  assertChargeable,
  markPaymentMethodExpired,
  recordCardSavedAtCheckout,
} from './payment-method.service.js';
import {
  PaymentProviderError,
  supportsCardVault,
  supportsDirectCardCharge,
  supportsOffSession,
  modeForCredential,
  type CreatePaymentResult,
  type DirectCardChargeProvider,
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

/**
 * What the storefront may put in front of a customer, and what it may promise
 * about each option.
 *
 * The gateway is deliberately absent. A customer choosing how to pay is
 * choosing an instrument; which acquirer settles it is the operator's business
 * and is resolved server-side by `resolveInstrument`. Naming Razorpay or
 * Stripe on a checkout page asks somebody to decide something they have no
 * basis for deciding, and tells a passer-by how the shop is wired.
 */
export interface InstrumentOffer {
  instrument: PaymentInstrument;
  /**
   * Whether a card paid with here can be kept for next time.
   *
   * False for UPI, which produces nothing to keep, and false where the gateway
   * that would take the payment cannot vault a card. The storefront hides the
   * "save this card" tick when it is false rather than offering a promise
   * nothing downstream can honour.
   */
  canSaveCard: boolean;
  /**
   * Whether a saved card can be charged from our own pages.
   *
   * True on Stripe. False on Razorpay, where charging one named token needs a
   * server-to-server API open only to PCI-DSS-certified merchants - so its
   * saved cards are picked inside Razorpay's own sheet instead. The storefront
   * uses this to word what happens next, rather than to hide anything.
   */
  savedCardsChargeableHere: boolean;
}

/**
 * Which instruments this deployment can offer for a cart in this currency.
 *
 * Wraps `availableGateways` rather than replacing it: what is connected is
 * still the same question, only answered in the customer's vocabulary. The
 * currency comes from the cart, which is why this is asked per checkout and
 * not cached across them.
 */
export async function gatewayOffers(): Promise<GatewayOffer[]> {
  const { gateways } = await availableGateways();

  return gateways.map((gateway) => ({
    provider: gateway.provider,
    currencies: gateway.currencies,
    hasUpi: gateway.methods.includes('UPI'),
    // Asserted from the adapter class rather than assumed from the gateway's
    // name, so an adapter that later drops the capability stops being offered
    // instead of failing at a checkout.
    canStoreCards: CARD_VAULT_CAPABLE.has(gateway.provider),
  }));
}

export async function availableInstruments(currency: string): Promise<{
  instruments: InstrumentOffer[];
}> {
  const offers = await gatewayOffers();
  const instruments = offerableInstruments(offers, currency);

  return {
    instruments: instruments.map((instrument) => {
      // What this instrument would actually resolve to, so the two answers
      // below describe the gateway that will really take the payment.
      const usable = offers.filter(
        (offer) =>
          (offer.currencies === null || offer.currencies.includes(currency.toUpperCase())) &&
          (instrument !== 'UPI' || offer.hasUpi),
      );

      const chosen = usable[0] ?? null;

      return {
        instrument,
        canSaveCard:
          isCardInstrument(instrument) && chosen !== null && chosen.canStoreCards,
        savedCardsChargeableHere:
          isCardInstrument(instrument) &&
          chosen !== null &&
          DIRECT_CARD_CHARGE_CAPABLE.has(chosen.provider),
      };
    }),
  };
}

/**
 * Which adapters can vault a card, and which can charge a vaulted one.
 *
 * Derived once from the classes themselves rather than written out as a list
 * of provider names, so the two sets cannot drift from what the adapters
 * actually implement. `supportsCardVault` and `supportsDirectCardCharge` are
 * the same narrows the payment path uses.
 */
const CAPABILITY_PROBE_CREDENTIALS: ProviderCredentials = {
  keyId: '',
  keySecret: '',
  webhookSecret: '',
};

const CARD_VAULT_CAPABLE: ReadonlySet<ProviderKind> = new Set(
  (['RAZORPAY', 'STRIPE'] as const).filter((kind) =>
    supportsCardVault(buildProvider(kind, CAPABILITY_PROBE_CREDENTIALS)),
  ),
);

const DIRECT_CARD_CHARGE_CAPABLE: ReadonlySet<ProviderKind> = new Set(
  (['RAZORPAY', 'STRIPE'] as const).filter((kind) =>
    supportsDirectCardCharge(buildProvider(kind, CAPABILITY_PROBE_CREDENTIALS)),
  ),
);

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
  /**
   * What the customer chose to pay with, in their own words.
   *
   * Takes precedence over `preferredProvider`, which it exists to replace: an
   * instrument is a decision the customer can actually make, and the gateway
   * is derived from it. Absent for an order placed before instruments existed,
   * or by an API client that names a gateway directly - both of which still
   * work, through the older path below.
   */
  instrument?: PaymentInstrument;
  /**
   * A card of theirs to pay with, rather than a fresh one.
   *
   * Always re-checked against the customer here. A client naming somebody
   * else's card must reach a refusal, not a charge.
   */
  savedPaymentMethodId?: string | null;
  /**
   * Whether to keep the card used for this payment.
   *
   * Only ever true because the customer ticked a box. Ignored for UPI, which
   * produces nothing to keep, and for a payment already using a stored card.
   */
  saveCard?: boolean;
}

/**
 * Where a gateway sends the customer back after an authentication challenge.
 *
 * Built here rather than accepted from the browser. Stripe requires one before
 * it will begin a full-page challenge, and a client-supplied value would be an
 * open redirect carrying a payment gateway's credibility - somebody who has
 * just authenticated with their bank and lands on a lookalike has every reason
 * to believe it.
 *
 * `CUSTOMER_WEB_PUBLIC_URL` is what this codebase already means by "where the
 * storefront is": it addresses payment links, sign-in links and every
 * verification email. Using it here keeps one answer to that question rather
 * than two that will eventually disagree.
 *
 * `stripe_return=1` is the marker the payment page looks for. It reads nothing
 * else off the URL - Stripe appends its own status parameters, and those come
 * through the customer's browser, which is not a trusted reporter of whether
 * money moved.
 */
function paymentReturnUrl(orderId: string): string {
  const base = env.CUSTOMER_WEB_PUBLIC_URL.replace(/\/$/, '');
  return `${base}/checkout/payment/${orderId}?stripe_return=1`;
}

/**
 * What the browser has to do next.
 *
 * Three genuinely different situations, and the storefront cannot infer which
 * one it is in from the rest of the response:
 *
 *   OPEN_PROVIDER_UI    - mount the gateway's form or sheet. The ordinary case
 *                         for a new card, for UPI, and for every Razorpay
 *                         payment including one using a saved card, because
 *                         Razorpay's saved cards live inside its own sheet.
 *   AUTHENTICATE        - the charge is already under way on a stored card and
 *                         the bank wants the cardholder. Hand `client_secret`
 *                         to Stripe.js and let it run the challenge.
 *   AWAIT_CONFIRMATION  - the charge went through without one. Nothing for the
 *                         browser to do but wait for the webhook, which is
 *                         still the only thing that marks the order paid.
 */
export type PaymentNextStep = 'OPEN_PROVIDER_UI' | 'AUTHENTICATE' | 'AWAIT_CONFIRMATION';

export interface CreateOrderPaymentResult {
  paymentTransactionId: string;
  provider: ProviderKind;
  mode: string;
  providerOrderId: string;
  amount: ReturnType<typeof serialiseMoney>;
  checkoutPayload: Record<string, string | number>;
  /** What the customer picked, echoed back so a reload shows the same thing. */
  instrument: PaymentInstrument | null;
  next: PaymentNextStep;
}

/**
 * Load a saved card and prove the customer may pay this order with it.
 *
 * Four separate questions, and each one is a way this could go wrong:
 *
 *   · Is it theirs? Scoped in the query, so somebody else's id is a not-found
 *     rather than a leak that the card exists.
 *   · Is it usable? A detached or expired card must not be charged.
 *   · Is it at the gateway that is about to be used? A Stripe token means
 *     nothing to Razorpay, and a deployment can have both connected.
 *   · Does it match what they said they were paying with? A card filed under
 *     Debit offered against "Pay with Credit Card" means the two screens have
 *     drifted apart, and guessing which one is right is not this function's
 *     job.
 *
 * Deliberately does NOT call `assertChargeable`: that one is about off-session
 * authority, which is a stricter thing than this path needs and would refuse
 * every card saved at a checkout - see its own comment.
 */
async function loadSavedCardForOrder(
  paymentMethodId: string,
  customerProfileId: string,
  providerKind: ProviderKind,
  instrument: PaymentInstrument | null,
): Promise<{ id: string; providerCustomerId: string; providerPaymentMethodId: string } | null> {
  const row = await prisma.customerPaymentMethod.findFirst({
    where: { id: paymentMethodId, customerProfileId },
  });

  if (row === null) throw notFound('Payment method');

  if (row.status !== 'ACTIVE') {
    throw conflict(
      ErrorCode.PAYMENT_METHOD_NOT_CHARGEABLE,
      'That card can no longer be used. Please choose another, or enter a new one.',
      [{ code: 'METHOD_STATUS', meta: { status: row.status } }],
    );
  }

  if (row.provider !== providerKind) {
    throw conflict(
      ErrorCode.PAYMENT_METHOD_NOT_CHARGEABLE,
      'That card was saved with a payment provider this store no longer uses. ' +
        'Please enter the card again.',
    );
  }

  if (instrument !== null && !cardSuitsInstrument(row.funding, instrument)) {
    throw badRequest(
      ErrorCode.PAYMENT_METHOD_NOT_CHARGEABLE,
      instrument === 'CREDIT_CARD'
        ? 'That is a debit card. Choose "Pay with Debit Card", or pick another card.'
        : 'That is a credit card. Choose "Pay with Credit Card", or pick another card.',
      [{ field: 'savedPaymentMethodId', code: 'FUNDING_MISMATCH' }],
    );
  }

  return {
    id: row.id,
    providerCustomerId: row.providerCustomerId,
    providerPaymentMethodId: row.providerPaymentMethodId,
  };
}

/**
 * Find or make the customer's record at the gateway.
 *
 * Swallows failures on purpose. Being unable to create a gateway customer
 * costs the customer the option of saving their card; letting it throw would
 * cost them the ability to buy anything, which is a wildly disproportionate
 * response to a convenience feature being unavailable.
 */
async function ensureVaultCustomerFor(
  provider: PaymentProvider,
  order: {
    customerProfileId: string;
    customerProfile: { fullName: string; phone: string | null; user: { email: string } };
  },
  existingProviderCustomerId: string | null,
): Promise<string | null> {
  if (!supportsCardVault(provider)) return null;

  try {
    return await provider.ensureVaultCustomer({
      providerCustomerId: existingProviderCustomerId,
      customerEmail: order.customerProfile.user.email,
      customerName: order.customerProfile.fullName,
      customerPhone: order.customerProfile.phone,
      customerProfileId: order.customerProfileId,
    });
  } catch (error) {
    logger.warn(
      { err: error, provider: provider.kind },
      'could not prepare a gateway customer record; the card cannot be saved this time',
    );
    return null;
  }
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

  /**
   * The instrument, which is what the customer actually chose.
   *
   * Same precedence as the pair above and for the same reason: the request may
   * override, so a customer whose card was declined can come back and pick
   * differently, but silence means "what this order already says".
   */
  const instrument: PaymentInstrument | null =
    input.instrument ?? order.preferredPaymentInstrument ?? null;

  /**
   * Resolve the gateway from the instrument, where there is one.
   *
   * Two paths on purpose, not one with a default. An order that expressed an
   * instrument is resolved by `resolveInstrument`, which refuses rather than
   * substituting - a customer who chose UPI and is silently handed a card form
   * has been told something untrue. An order that expressed none is an older
   * order or an API client naming a gateway directly, and keeps exactly the
   * behaviour it had before instruments existed.
   */
  const resolved =
    instrument === null
      ? null
      : resolveInstrument(
          instrument,
          order.currency,
          await gatewayOffers(),
          preferredProvider ?? (await availableGateways()).defaultProvider,
        );

  const { provider, connectionId } = await loadActiveProvider(
    resolved?.provider ?? preferredProvider,
  );

  /*
   * The gateway that answered may not be the one the instrument needs.
   *
   * `loadActiveProvider` treats its argument as a preference and will hand
   * back something else rather than fail. That is right for a gateway
   * preference and wrong for an instrument: nothing but Razorpay can settle a
   * UPI payment, so a UPI order that resolved onto Stripe must be refused here
   * rather than opened on a card form the customer did not ask for.
   */
  if (resolved !== null && provider.kind !== resolved.provider) {
    throw badRequest(
      ErrorCode.PAYMENT_INSTRUMENT_UNAVAILABLE,
      instrument === 'UPI'
        ? 'UPI is no longer available for this order. Please pay by card instead.'
        : 'That way of paying is no longer available for this order.',
      [{ field: 'instrument', code: 'INSTRUMENT_UNAVAILABLE', meta: { instrument } }],
    );
  }

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
    (resolved?.methodHint ?? preferredMethod) === 'UPI' && provider.kind === 'RAZORPAY'
      ? 'UPI'
      : 'ANY';

  /**
   * The card the customer picked, if they picked one of theirs.
   *
   * Loaded scoped to this customer, so a client naming somebody else's card id
   * gets a not-found rather than a charge. Every other check on it lives in
   * `assertSavedCardUsable`.
   */
  const savedCard =
    input.savedPaymentMethodId === null || input.savedPaymentMethodId === undefined
      ? null
      : await loadSavedCardForOrder(
          input.savedPaymentMethodId,
          order.customerProfileId,
          provider.kind,
          instrument,
        );

  /**
   * The customer's record at the gateway, when this payment needs one.
   *
   * Needed to store a card, and needed on Razorpay to show the customer the
   * cards they have already stored. Reused from a card of theirs when one
   * exists, so a second card joins the first rather than starting a parallel
   * record nothing joins back together.
   *
   * Best-effort: a gateway that will not create a customer record must not
   * stop the customer paying. They lose the option to save the card, which is
   * a convenience, not the purchase.
   */
  const wantsVault =
    instrument !== null &&
    isCardInstrument(instrument) &&
    (input.saveCard === true || savedCard !== null);

  const providerCustomerId =
    wantsVault && supportsCardVault(provider)
      ? await ensureVaultCustomerFor(provider, order, savedCard?.providerCustomerId ?? null)
      : null;

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
        // Part of the replayed payload for the same reason `methodHint` is: a
        // retry that dropped these would reopen the same payment with the
        // customer's saved cards missing from the sheet.
        providerCustomerId,
        saveCard: input.saveCard === true,
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
      instrument,
      /*
       * A replay resumes what the first attempt started.
       *
       * For a charge already made against a stored card, that is the
       * authentication step - not a card form. Stripe's replayed payload
       * carries the same client secret, so the browser either finishes the
       * challenge the customer walked away from or, if the payment has since
       * succeeded, finds nothing left to do and falls straight into the wait.
       * Reopening the Payment Element on an intent that already has a payment
       * method attached would ask them to enter a card they have paid with.
       *
       * Everything else reopens the gateway's own UI, which is where it was.
       */
      next:
        savedCard !== null && supportsDirectCardCharge(provider)
          ? 'AUTHENTICATE'
          : 'OPEN_PROVIDER_UI',
    };
  }

  /*
   * A stored card that this gateway can charge directly.
   *
   * Stripe only. The card is charged here, on the server, in one call - the
   * browser is never asked to confirm a payment of its own accord, and at most
   * answers an authentication challenge against the client secret handed back.
   *
   * Razorpay falls past this into the ordinary sheet below, carrying
   * `providerCustomerId` so the customer's saved cards are waiting for them
   * inside it. That is not a shortcut: charging one named Razorpay token needs
   * its server-to-server API, which is open only to PCI-DSS-certified
   * merchants, and no deployment of this software is one.
   */
  if (savedCard !== null && supportsDirectCardCharge(provider)) {
    return chargeSavedCardForOrder({
      provider,
      connectionId,
      order,
      outstanding,
      savedCard,
      instrument,
      idempotencyKey: input.idempotencyKey,
      returnUrl: paymentReturnUrl(order.id),
      actorUserId: input.actorUserId,
      correlationId: input.correlationId ?? null,
    });
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
      providerCustomerId,
      saveCard: input.saveCard === true,
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
    instrument,
    next: 'OPEN_PROVIDER_UI',
  };
}

/**
 * Charge a card the customer has already stored, with them watching.
 *
 * Split out of `createOrderPayment` because it is a genuinely different act:
 * the money is attempted in this one call rather than in a sheet the customer
 * drives, so the transaction row is written from a result that already exists
 * instead of from an intent that has yet to be confirmed.
 *
 * Three things it holds to, all of which match the surrounding module:
 *
 *   1. **The row is written whatever the outcome.** A declined charge still
 *      produced a payment at the gateway, and the idempotency key has been
 *      spent. Without a row, a retry would collide on the unique index with
 *      nothing to replay.
 *
 *   2. **`CREATED` is the status, not `CAPTURED`.** Even a charge Stripe says
 *      succeeded is not applied here. It is applied by the webhook, through
 *      the same guarded path every other payment goes through, so this module
 *      keeps exactly one place that turns money into a CONFIRMED order.
 *
 *   3. **Authentication required is not a failure.** The cardholder is here
 *      and can answer. It comes back as `AUTHENTICATE` with the client secret
 *      the browser needs, and the order stays payable.
 */
async function chargeSavedCardForOrder(params: {
  provider: DirectCardChargeProvider;
  connectionId: string;
  order: {
    id: string;
    orderNumber: string;
    currency: string;
  };
  outstanding: bigint;
  savedCard: { id: string; providerCustomerId: string; providerPaymentMethodId: string };
  instrument: PaymentInstrument | null;
  idempotencyKey: string;
  returnUrl: string;
  actorUserId: string | null;
  correlationId: string | null;
}): Promise<CreateOrderPaymentResult> {
  const { provider, order, savedCard } = params;

  let charge;
  try {
    charge = await provider.chargeSavedCardOnSession({
      orderId: order.id,
      orderNumber: order.orderNumber,
      amountMinor: params.outstanding,
      currency: order.currency,
      providerCustomerId: savedCard.providerCustomerId,
      providerPaymentMethodId: savedCard.providerPaymentMethodId,
      returnUrl: paymentReturnUrl(order.id),
      idempotencyKey: params.idempotencyKey,
    });
  } catch (error) {
    if (error instanceof PaymentProviderError) {
      // A declined card reaches the customer as the gateway's own sentence,
      // which explains it better than anything this file could write.
      throw badRequest(ErrorCode.PAYMENT_PROVIDER_ERROR, error.message, [
        { code: error.providerCode ?? 'PROVIDER_ERROR', field: 'payment' },
      ]);
    }
    throw error;
  }

  const transactionId = newId();

  await prisma.paymentTransaction.create({
    data: {
      id: transactionId,
      orderId: order.id,
      connectionId: params.connectionId,
      provider: provider.kind,
      mode: provider.mode,
      providerOrderId: charge.providerOrderId,
      // See point 2. The webhook applies the capture.
      status: 'CREATED',
      amountMinor: params.outstanding,
      currency: order.currency,
      idempotencyKey: params.idempotencyKey,
    },
  });

  await recordAudit({
    action: AuditAction.PAYMENT_CREATED,
    resourceType: 'payment',
    resourceId: transactionId,
    actorType: 'CUSTOMER',
    actorUserId: params.actorUserId,
    after: {
      orderId: order.id,
      providerOrderId: charge.providerOrderId,
      amountMinor: params.outstanding,
      provider: provider.kind,
      mode: provider.mode,
      // Recorded because "which stored card" is the first question asked of a
      // disputed charge, and the token itself is never written to a log.
      paymentMethodId: savedCard.id,
      requiresAction: charge.requiresAction,
    },
    correlationId: params.correlationId,
  });

  return {
    paymentTransactionId: transactionId,
    provider: provider.kind,
    mode: provider.mode,
    providerOrderId: charge.providerOrderId,
    amount: serialiseMoney(params.outstanding, order.currency),
    // The publishable key and the client secret, and nothing else. The secret
    // key never leaves this process, and the client secret authorises
    // finishing this one payment.
    checkoutPayload: {
      key: charge.publishableKey,
      client_secret: charge.clientSecret ?? '',
    },
    instrument: params.instrument,
    next: charge.requiresAction ? 'AUTHENTICATE' : 'AWAIT_CONFIRMATION',
  };
}

/**
 * Store a card a captured payment tokenised.
 *
 * The webhook carries references only. What the card looks like is read back
 * from the gateway here, which is the same rule enrolment follows: the
 * provider is the authority on what it stored, and a display field taken from
 * an event body is a second source that will eventually disagree with the
 * first.
 *
 * Every failure is swallowed. The caller is inside the path that confirms an
 * order, and nothing about a convenience feature may put that at risk.
 */
async function storeVaultedCardFromEvent(
  providerKind: ProviderKind,
  customerProfileId: string,
  vaulted: { providerTokenId: string; providerCustomerId: string | null },
): Promise<void> {
  const loaded = await loadActiveProvider(providerKind);

  if (loaded.kind !== providerKind || !supportsCardVault(loaded.provider)) {
    logger.warn(
      { provider: providerKind },
      'a payment tokenised a card but its gateway can no longer be asked about it',
    );
    return;
  }

  const details = await loaded.provider.fetchVaultedCard(
    vaulted.providerCustomerId ?? '',
    vaulted.providerTokenId,
  );

  if (details === null) {
    // The gateway does not have it. Nothing to store, and nothing wrong: a
    // customer can delete a card in the gateway's own portal between paying
    // and this webhook arriving.
    return;
  }

  await recordCardSavedAtCheckout({
    customerProfileId,
    provider: providerKind,
    card: {
      ...details,
      // The event's customer id wins where the gateway did not echo one back:
      // it came from the payment that actually created the token.
      providerCustomerId: details.providerCustomerId ?? vaulted.providerCustomerId,
    },
  });
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

    // --- 4b. The card the customer asked to keep --------------------------
    //
    // Reached only when the gateway reports having tokenised one, which it
    // does only when the customer ticked the box and completed whatever
    // additional confirmation its own rules require. The browser said nothing
    // about this; a signature-verified capture did.
    //
    // Placed after the money is applied and deliberately unable to affect it.
    // A card that fails to store costs the customer a retype at their next
    // order; a throw here would cost them a confirmed order they have already
    // paid for. `storeVaultedCardFromEvent` swallows its own failures for the
    // same reason, and this `catch` is the second belt.
    if (event.vaultedCard !== null && event.vaultedCard !== undefined) {
      await storeVaultedCardFromEvent(
        transaction.provider,
        order.customerProfileId,
        event.vaultedCard,
      ).catch((error: unknown) => {
        logger.error(
          { err: error, orderId: order.id },
          'could not store the card a customer saved while paying',
        );
      });
    }

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
