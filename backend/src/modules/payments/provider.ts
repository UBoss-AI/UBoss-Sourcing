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

  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;

  /**
   * Rebuild the browser payload for a payment that already exists.
   *
   * Needed to replay an idempotent retry. Without it, answering "you already
   * started this payment" would mean either asking the provider to create a
   * second order, or storing the payload — and the payload contains only
   * public values that can be derived, so neither is warranted.
   *
   * Must be pure: no network call, no new provider-side state.
   */
  buildCheckoutPayload(
    providerOrderId: string,
    input: Omit<CreatePaymentInput, 'idempotencyKey'>,
  ): Record<string, string | number>;

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
