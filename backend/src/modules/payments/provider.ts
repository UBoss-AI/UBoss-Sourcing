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
  /** Normalised meaning, so order code does not switch on provider strings. */
  intent: 'PAYMENT_CAPTURED' | 'PAYMENT_FAILED' | 'REFUND_PROCESSED' | 'UNKNOWN';
  providerOrderId: string | null;
  providerPaymentId: string | null;
  providerRefundId: string | null;
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
