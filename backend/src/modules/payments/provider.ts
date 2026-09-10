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
  /**
   * The gateway's own customer record, when this customer has one.
   *
   * Passing it is what lets the gateway show the customer their saved cards,
   * and what keeps a newly saved card attached to the record their existing
   * ones hang off rather than to a fresh parallel one.
   *
   * Part of the replayed payload for the same reason `methodHint` is: a retry
   * that dropped it would reopen the same payment with the saved cards
   * missing.
   */
  providerCustomerId?: string | null;
  /**
   * Ask the gateway to tokenise whatever card is used, so it can be offered
   * back at the next checkout.
   *
   * Only ever true when the customer ticked the box. It is not a preference
   * this application may set on their behalf: storing a payment credential
   * needs their agreement under both the RBI's tokenisation rules and the
   * GDPR, and a pre-ticked or implied consent is not one.
   */
  saveCard?: boolean;
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
  /**
   * A card this payment tokenised, when the customer asked for it.
   *
   * Carries references and nothing else. What the card LOOKS like - brand,
   * last four, funding - is read back from the provider by
   * `fetchVaultedCard`, not taken from here, for the same reason enrolment
   * re-reads a SetupIntent: the provider is the authority on what it stored,
   * and one path that reads it is easier to keep honest than two.
   *
   * Reported only on a capture. A token from a payment that failed is a card
   * the customer never successfully used, and offering it back to them later
   * would be offering a card nothing shows works.
   */
  vaultedCard?: {
    providerTokenId: string;
    providerCustomerId: string | null;
  } | null;
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

// ---------------------------------------------------------------------------
// Storing a card at a checkout
// ---------------------------------------------------------------------------
//
// Different from the off-session machinery above, and kept apart from it on
// purpose. Off-session means "charge this while nobody is looking", and only a
// gateway with a SetupIntent-shaped enrolment can honour it. Storing a card at
// a checkout is a smaller thing: the customer is present, they are paying now,
// and they have asked not to have to type the card again next time.
//
// Both gateways can do the smaller thing. Only one of them can do the larger.

/**
 * A stored card, as much as anybody is allowed to know about it.
 *
 * Display fields only. Not one of them can pay for anything, and that is the
 * point: this is what a person needs to recognise their own card in a list,
 * and it is the whole of what this application ever holds about a card.
 */
export interface VaultedCardDetails {
  providerTokenId: string;
  providerCustomerId: string | null;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  /**
   * The provider's own word for credit vs debit - Stripe's `funding`,
   * Razorpay's `card.type`. Passed through unmapped; turning it into an
   * instrument is `fundingFor`'s job in domain/payment-instrument.ts, and it
   * happens in exactly one place.
   */
  funding: string | null;
  country: string | null;
}

export interface EnsureVaultCustomerInput {
  /** The gateway's existing customer id for this person, when there is one. */
  providerCustomerId?: string | null;
  customerEmail: string | null;
  customerName: string | null;
  customerPhone: string | null;
  /** Ours, sent as metadata so the gateway's dashboard traces back here. */
  customerProfileId: string;
}

/**
 * A gateway that can keep a card on file for a customer.
 *
 * What is kept is a **token**, never a card number. Since the RBI's rules of
 * October 2022 a merchant may not store a PAN at all, and no deployment of
 * this software is inside PCI DSS scope - so what comes back is a reference
 * plus the brand and last four digits a person recognises their own card by.
 */
export interface CardVaultProvider extends PaymentProvider {
  /**
   * Find or create the gateway's customer record.
   *
   * Idempotent from the caller's side: given an existing id it returns it
   * unchanged rather than making a second record, because a customer with two
   * records at the gateway has cards that nothing joins back together.
   */
  ensureVaultCustomer(input: EnsureVaultCustomerInput): Promise<string>;

  /**
   * Read back a stored card, so it can be shown to the person who owns it.
   *
   * The provider is the authority on what it stored - the same rule
   * `fetchSetupIntent` exists for. Returns null when the token is not there,
   * which is a real answer rather than an error: a customer can delete a card
   * in the gateway's own portal without telling this system.
   */
  fetchVaultedCard(
    providerCustomerId: string,
    providerTokenId: string,
  ): Promise<VaultedCardDetails | null>;

  /**
   * Stop a stored card being usable, at the gateway.
   *
   * Called when the customer removes it here. Marking our row detached while
   * the gateway still holds a chargeable token would leave the two disagreeing
   * about something that can take money.
   */
  forgetVaultedCard(providerCustomerId: string, providerTokenId: string): Promise<void>;
}

export function supportsCardVault(provider: PaymentProvider): provider is CardVaultProvider {
  const candidate = provider as Partial<CardVaultProvider>;
  return (
    typeof candidate.ensureVaultCustomer === 'function' &&
    typeof candidate.fetchVaultedCard === 'function' &&
    typeof candidate.forgetVaultedCard === 'function'
  );
}

export interface OnSessionChargeInput {
  orderId: string;
  orderNumber: string;
  amountMinor: bigint;
  currency: string;
  providerCustomerId: string;
  providerPaymentMethodId: string;
  /**
   * Where the gateway sends the customer back after a full-page
   * authentication challenge. Required even when one is not expected: the
   * gateway refuses to start a challenge it cannot return from.
   */
  returnUrl: string;
  idempotencyKey: string;
}

export interface OnSessionChargeResult {
  providerOrderId: string;
  providerPaymentId: string | null;
  status: NormalisedPaymentStatus;
  /**
   * The bank wants the cardholder to authenticate.
   *
   * Unlike the off-session case this is entirely ordinary and entirely
   * recoverable - the cardholder is right there. The caller hands
   * `clientSecret` to the browser, which completes the challenge and then
   * waits for the webhook like any other payment.
   */
  requiresAction: boolean;
  /** Authorises the browser to finish THIS payment. Never stored. */
  clientSecret: string | null;
  /**
   * The publishable key the browser needs to run the challenge.
   *
   * Public by design - it is the same key the gateway's own sheet is opened
   * with. Returned here rather than read off the provider so that the secret
   * half of the credential pair has no path to a response object at all.
   */
  publishableKey: string;
  amountMinor: bigint;
  currency: string;
  failureCode: string | null;
  failureMessage: string | null;
}

/**
 * A gateway that can charge a stored card directly, with the customer present.
 *
 * Stripe can: the token is ours to name in a PaymentIntent. **Razorpay cannot**
 * - charging a specific saved token needs its server-to-server API, which is
 * open only to merchants holding PCI-DSS certification, and a company that
 * installs a purchasing system does not hold one. Razorpay's saved cards are
 * therefore chosen inside Razorpay's own sheet, which we open with the
 * customer's id so the cards are already there.
 *
 * Separate from `CardVaultProvider` so that the difference is a compile error
 * rather than a runtime surprise at a checkout.
 */
export interface DirectCardChargeProvider extends CardVaultProvider {
  chargeSavedCardOnSession(input: OnSessionChargeInput): Promise<OnSessionChargeResult>;
}

export function supportsDirectCardCharge(
  provider: PaymentProvider,
): provider is DirectCardChargeProvider {
  const candidate = provider as Partial<DirectCardChargeProvider>;
  return supportsCardVault(provider) && typeof candidate.chargeSavedCardOnSession === 'function';
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
