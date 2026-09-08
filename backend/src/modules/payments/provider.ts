/**
 * Payment provider abstraction.
 *
 * Order code never learns which gateway is in use. It asks for a payment
 * session, receives a normalised result, and reacts to normalised events -
 * so adding Stripe later touches this directory and nothing else.
 *
 * Two rules every adapter must honour:
 *
 *   1. No card data. Ever. Adapters exchange provider references and tokenised
 *      mandates; a PAN or CVV must never reach this process.
 *   2. Success comes from a verified provider event, never from a client
 *      redirect. `verifyWebhook` checks a signature over the RAW request body,
 *      before the payload is parsed or trusted.
 */

export type ProviderKind = 'RAZORPAY' | 'STRIPE';
export type ProviderMode = 'TEST' | 'LIVE';

/**
 * A narrowing of which instruments the provider's sheet should offer.
 *
 * `ANY` is the provider's own default set. `UPI` is a request, not a promise:
 * an adapter whose gateway has no such instrument ignores it rather than
 * failing, because a customer preference must never be able to break a
 * checkout. Only Razorpay honours `UPI` today.
 *
 * It is deliberately *not* a payment-method record. Nothing here is settled
 * money — what the customer actually paid with is read back from the provider
 * in `PaymentStatusResult.method`, which is a fact rather than a preference.
 */
export type PaymentMethodHint = 'ANY' | 'UPI';

/** Normalised payment states. Provider vocabularies map onto these. */
export type NormalisedPaymentStatus =
  | 'CREATED'
  | 'PENDING'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'FAILED'
  | 'CANCELLED'
  | 'EXPIRED';

export interface ProviderCredentials {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
}

export interface CreatePaymentInput {
  /** Our order id, sent as the provider receipt so the two can be reconciled. */
  orderId: string;
  orderNumber: string;
  /** Minor units. Never a float, never a major-unit decimal. */
  amountMinor: bigint;
  currency: string;
  customerEmail: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /**
   * Which instruments to offer, where the gateway can be told.
   *
   * Part of the payload the browser opens, so it has to be part of the input
   * `buildCheckoutPayload` replays — a retry that dropped it would reopen the
   * same payment with a different sheet.
   */
  methodHint?: PaymentMethodHint;
  /** Idempotency key passed through where the provider supports one. */
  idempotencyKey: string;
}

export interface CreatePaymentResult {
  providerOrderId: string;
  /** What the browser needs to open the provider's hosted UI. No secrets. */
  checkoutPayload: Record<string, string | number>;
  status: NormalisedPaymentStatus;
  amountMinor: bigint;
  currency: string;
}

export interface PaymentStatusResult {
  providerPaymentId: string | null;
  providerOrderId: string;
  status: NormalisedPaymentStatus;
  amountMinor: bigint;
  capturedMinor: bigint;
  currency: string;
  method: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

export interface RefundInput {
  providerPaymentId: string;
  amountMinor: bigint;
  currency: string;
  reason: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
  status: 'PROCESSING' | 'SUCCEEDED' | 'FAILED';
  amountMinor: bigint;
  failureMessage: string | null;
}

/** A webhook whose signature has been checked. `verified: false` is never applied. */
export interface VerifiedEvent {
  verified: boolean;
  /** Provider event id - the duplicate-delivery guard's unique key. */
  eventId: string;
  eventType: string;
  /**
   * Normalised meaning, so order code does not switch on provider strings.
   *
   * PAYMENT_ACTION_REQUIRED is not a failure and must not be treated as one.
   * It means the charge was attempted while the customer was away and the bank
   * asked for them - 3-D Secure, or a mandate it wants re-authorised. The money
   * has not moved, the payment is still open, and the only thing that can
   * advance it is the customer authenticating. Retrying it off-session produces
   * the same answer and, on some issuers, counts against the card.
   *
   * SETUP_COMPLETED reports a SetupIntent that has yielded a reusable
   * instrument. No money moves on one; it is how a card becomes chargeable
   * later.
   */
  intent:
    | 'PAYMENT_CAPTURED'
    | 'PAYMENT_FAILED'
    | 'PAYMENT_ACTION_REQUIRED'
    | 'REFUND_PROCESSED'
    | 'SETUP_COMPLETED'
    | 'UNKNOWN';
  providerOrderId: string | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
  /** Set on SETUP_COMPLETED. The SetupIntent this event is about. */
  providerSetupIntentId?: string | null;
  /** Set on SETUP_COMPLETED. The reusable instrument it produced. */
  providerPaymentMethodId?: string | null;
  amountMinor: bigint | null;
  currency: string | null;
  method: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  rejectionReason?: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  mode: ProviderMode | null;
  message: string;
}

export interface PaymentProvider {
  readonly kind: ProviderKind;
  readonly mode: ProviderMode;

  /** Prove the credentials work before an administrator activates them. */
  testConnection(): Promise<ConnectionTestResult>;

  /**
   * The instruments this gateway would actually open on, `ANY` included.
   *
   * Asked of the gateway rather than declared here, because the answer belongs
   * to the merchant account and not to the integration. Razorpay supports UPI;
   * a particular Razorpay account may still have it switched off, and its
   * checkout sheet then has no UPI tab to open on.
   *
   * Naming an instrument the account cannot serve is the same class of mistake
   * as offering a gateway that cannot settle the cart's currency: the customer
   * chooses UPI, reads that checkout will open on the UPI tab, and is handed a
   * card form with nothing to explain the difference. `prefill.method` is not
   * refused in that case - it is silently ignored, so nothing downstream can
   * catch it either.
   *
   * An adapter that cannot find out must answer `['ANY']`. Under-promising
   * costs the customer one extra tap inside the sheet; over-promising breaks a
   * statement this application made to them.
   */
  offerableMethods(): Promise<PaymentMethodHint[]>;

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;

  /**
   * Rebuild the browser payload for a payment that already exists.
   *
   * Needed to replay an idempotent retry. Without it, answering "you already
   * started this payment" would mean asking the provider to create a second
   * order for one checkout attempt.
   *
   * The rule is that it must create NO new provider-side state. Razorpay's
   * payload is derivable and needs no call at all; Stripe's carries a client
   * secret only Stripe knows, so that adapter re-reads the intent. A read is
   * within the rule - a second create never is.
   */
  buildCheckoutPayload(
    providerOrderId: string,
    input: Omit<CreatePaymentInput, 'idempotencyKey'>,
  ): Promise<Record<string, string | number>>;

  /**
   * Re-query a payment.
   *
   * The recovery path for a browser that timed out mid-redirect or a webhook
   * that has not arrived. The provider, not the client, is the authority.
   */
  fetchPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult>;

  createRefund(input: RefundInput): Promise<RefundResult>;

  /**
   * Verify a webhook against the RAW body.
   *
   * Re-serialising the parsed object changes key order and whitespace, so every
   * signature would fail - and the usual "fix" is to stop verifying. The raw
   * bytes are captured in the HTTP layer specifically to avoid that.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): VerifiedEvent;
}

// ---------------------------------------------------------------------------
// Off-session payments
// ---------------------------------------------------------------------------
//
// Charging somebody who is not there is a different act from taking a payment
// at a checkout, and it needs a different contract. Two things have to happen
// first, and both are represented here:
//
//   1. The instrument has to be made reusable, with the customer present and
//      agreeing to it. That is `createSetupIntent` - no money moves.
//   2. Later, and without them, the stored instrument is charged. That is
//      `chargeOffSession`.
//
// This is a SEPARATE interface from `PaymentProvider` rather than more methods
// on it, because not every gateway can do it and the ones that cannot should
// fail to compile rather than throw at 06:00 inside a worker. Razorpay's
// e-mandate flow is a different shape entirely (a registered mandate with a
// pre-agreed ceiling, not a stored card), so its adapter deliberately does not
// implement this and `supportsOffSession` returns false for it.

export interface CreateSetupIntentInput {
  /**
   * The provider's customer id, when one already exists.
   *
   * Passing it is what keeps a customer from accumulating a new Stripe
   * Customer per card, which would scatter their instruments across records
   * nothing joins back together.
   */
  providerCustomerId?: string | null;
  customerEmail: string | null;
  customerName: string | null;
  /** Our customer profile id, sent as metadata so Stripe's dashboard traces back. */
  customerProfileId: string;
  idempotencyKey: string;
}

export interface CreateSetupIntentResult {
  setupIntentId: string;
  /**
   * Authorises the browser to confirm THIS SetupIntent and nothing else.
   *
   * Handed to the client and never stored: it is a short-lived capability, and
   * a database is the wrong place for one.
   */
  clientSecret: string;
  providerCustomerId: string;
  /** The publishable key the browser needs to mount the provider's element. */
  publishableKey: string;
  status: string;
}

/** What a completed setup yields: an instrument, and enough to display it. */
export interface SetupIntentResult {
  setupIntentId: string;
  /** 'succeeded' is the only status that produces a chargeable instrument. */
  status: string;
  providerCustomerId: string | null;
  providerPaymentMethodId: string | null;
  /** Display-only. None of these can pay for anything. */
  card: {
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
    funding: string | null;
    country: string | null;
  } | null;
}

export interface OffSessionChargeInput {
  orderId: string;
  orderNumber: string;
  amountMinor: bigint;
  currency: string;
  providerCustomerId: string;
  providerPaymentMethodId: string;
  /**
   * Stable across every retry of this charge.
   *
   * The single most important field here. The provider de-duplicates on it, so
   * a worker that crashes after Stripe accepted the charge but before the
   * result was written retries into the SAME payment rather than a second one.
   */
  idempotencyKey: string;
  /** Carried into the provider's metadata for reconciliation. */
  scheduleId?: string | null;
  occurrenceId?: string | null;
}

export interface OffSessionChargeResult {
  providerOrderId: string;
  providerPaymentId: string | null;
  status: NormalisedPaymentStatus;
  /**
   * True when the bank wants the cardholder present.
   *
   * Reported separately from `status` because the caller has to do something
   * quite different with it: notify the customer and hold, rather than retry or
   * fail. Retrying an off-session charge that asked for authentication gets the
   * same answer every time.
   */
  requiresAction: boolean;
  amountMinor: bigint;
  currency: string;
  method: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}

/**
 * A gateway that can store an instrument and charge it later.
 *
 * Implemented by the Stripe adapter. Use `supportsOffSession` to narrow a
 * `PaymentProvider` to it rather than casting.
 */
export interface OffSessionProvider extends PaymentProvider {
  /** Begin enrolment. No money moves; the customer must be present. */
  createSetupIntent(input: CreateSetupIntentInput): Promise<CreateSetupIntentResult>;

  /**
   * Re-read a SetupIntent.
   *
   * The authority on whether enrolment succeeded is the provider, never the
   * browser that says it did - the same rule as a payment. A client can claim
   * anything; this is what the stored instrument is actually built from.
   */
  fetchSetupIntent(setupIntentId: string): Promise<SetupIntentResult>;

  /** Charge a stored instrument with nobody present. */
  chargeOffSession(input: OffSessionChargeInput): Promise<OffSessionChargeResult>;

  /**
   * Stop the instrument being chargeable, at the provider.
   *
   * Called when a customer removes a card. Marking our row DETACHED without
   * telling the provider would leave a card this system believes is gone and
   * the provider believes is live.
   */
  detachPaymentMethod(providerPaymentMethodId: string): Promise<void>;
}

/** Narrow a provider to one that can charge off-session. */
export function supportsOffSession(provider: PaymentProvider): provider is OffSessionProvider {
  const candidate = provider as Partial<OffSessionProvider>;
  return (
    typeof candidate.createSetupIntent === 'function' &&
    typeof candidate.fetchSetupIntent === 'function' &&
    typeof candidate.chargeOffSession === 'function' &&
    typeof candidate.detachPaymentMethod === 'function'
  );
}

/**
 * Provider errors, separated by whether a retry could help.
 *
 * `retryable` is a network blip or a 5xx; a declined card or a bad key is not,
 * and retrying it just delays telling the customer.
 */
export class PaymentProviderError extends Error {
  readonly providerCode: string | null;
  readonly retryable: boolean;
  readonly httpStatus: number | null;

  constructor(params: {
    message: string;
    providerCode?: string | null;
    retryable?: boolean;
    httpStatus?: number | null;
  }) {
    super(params.message);
    this.name = 'PaymentProviderError';
    this.providerCode = params.providerCode ?? null;
    this.retryable = params.retryable ?? false;
    this.httpStatus = params.httpStatus ?? null;
  }
}

/** True when a key belongs to a provider's live environment. */
export function isLiveCredential(keyId: string): boolean {
  return keyId.startsWith('rzp_live_') || keyId.startsWith('sk_live_') || keyId.startsWith('pk_live_');
}

export function modeForCredential(keyId: string): ProviderMode {
  return isLiveCredential(keyId) ? 'LIVE' : 'TEST';
}
