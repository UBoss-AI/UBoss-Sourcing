/**
 * Razorpay adapter.
 *
 * Talks to the real Razorpay API over HTTPS. There is no simulated success
 * path: with no credentials configured the payment service refuses the request
 * with PAYMENT_PROVIDER_NOT_CONFIGURED rather than pretending a payment worked.
 * A mock that returns "captured" is the single most dangerous thing that can
 * exist in a payments module.
 *
 * Amounts are integer paise throughout - Razorpay's own unit - so no conversion
 * to or from a decimal ever happens.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { logger } from '../../infra/logger.js';
import {
  PaymentProviderError,
  modeForCredential,
  type ConnectionTestResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type NormalisedPaymentStatus,
  type PaymentProvider,
  type PaymentStatusResult,
  type ProviderCredentials,
  type ProviderMode,
  type RefundInput,
  type RefundResult,
  type VerifiedEvent,
} from './provider.js';

const API_BASE = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Razorpay order/payment states, mapped to ours.
 *
 * `authorized` is deliberately not treated as success: the money is held but
 * not taken, and an order must not be confirmed on a hold.
 */
const PAYMENT_STATUS_MAP: Readonly<Record<string, NormalisedPaymentStatus>> = Object.freeze({
  created: 'CREATED',
  attempted: 'PENDING',
  authorized: 'AUTHORIZED',
  captured: 'CAPTURED',
  paid: 'CAPTURED',
  refunded: 'CAPTURED',
  failed: 'FAILED',
});

interface RazorpayError {
  error?: { code?: string; description?: string; reason?: string };
}

interface RazorpayOrder {
  id: string;
  amount: number;
  amount_paid?: number;
  currency: string;
  status: string;
  receipt?: string;
}

interface RazorpayPayment {
  id: string;
  order_id: string | null;
  amount: number;
  amount_refunded?: number;
  currency: string;
  status: string;
  method?: string;
  error_code?: string | null;
  error_description?: string | null;
  captured?: boolean;
}

interface RazorpayRefund {
  id: string;
  amount: number;
  status: string;
  payment_id: string;
}

export class RazorpayAdapter implements PaymentProvider {
  readonly kind = 'RAZORPAY' as const;
  readonly mode: ProviderMode;

  private readonly authHeader: string;
  private readonly webhookSecret: string;

  constructor(private readonly credentials: ProviderCredentials) {
    this.mode = modeForCredential(credentials.keyId);
    this.authHeader = `Basic ${Buffer.from(
      `${credentials.keyId}:${credentials.keySecret}`,
      'utf8',
    ).toString('base64')}`;
    this.webhookSecret = credentials.webhookSecret;
  }

  /**
   * One HTTP call, with a bounded timeout.
   *
   * A hung provider must not pin a request thread indefinitely - the customer
   * is sitting on a checkout page waiting for it.
   */
  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/json',
          ...(idempotencyKey !== undefined ? { 'X-Razorpay-Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text.length > 0 ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        const error = (parsed as RazorpayError | null)?.error;

        // 5xx and 429 are worth retrying; a 4xx means the request itself is
        // wrong and retrying only delays telling the customer.
        const retryable = response.status >= 500 || response.status === 429;

        // Deliberately does not log the body: a provider error response can
        // echo request fields.
        logger.warn(
          { httpStatus: response.status, providerCode: error?.code, path },
          'razorpay request failed',
        );

        throw new PaymentProviderError({
          message: error?.description ?? `Razorpay returned HTTP ${String(response.status)}`,
          providerCode: error?.code ?? null,
          retryable,
          httpStatus: response.status,
        });
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;

      // A timeout or a DNS failure. Retryable, and the caller must reconcile
      // rather than assume the payment did not happen - the provider may have
      // processed it.
      const isAbort = error instanceof Error && error.name === 'AbortError';
      throw new PaymentProviderError({
        message: isAbort
          ? 'Razorpay did not respond in time.'
          : `Could not reach Razorpay: ${error instanceof Error ? error.message : 'unknown error'}`,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(): Promise<ConnectionTestResult> {
    try {
      // Listing one order is the cheapest authenticated call that proves the
      // credentials work without creating anything.
      await this.request<{ items: unknown[] }>('GET', '/orders?count=1');

      return {
        ok: true,
        mode: this.mode,
        message:
          this.mode === 'TEST'
            ? 'Connected to Razorpay in TEST mode. No real money can move.'
            : 'Connected to Razorpay in LIVE mode. Real payments will be processed.',
      };
    } catch (error) {
      return {
        ok: false,
        mode: this.mode,
        message: error instanceof Error ? error.message : 'Connection test failed.',
      };
    }
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    // Razorpay counts in paise, exactly as we do, so the BigInt converts with
    // no decimal arithmetic. The Number() is safe: an order beyond 2^53 paise
    // is ~90 trillion rupees.
    const amount = Number(input.amountMinor);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new PaymentProviderError({
        message: `Refusing to create a payment for an implausible amount: ${input.amountMinor.toString()}`,
      });
    }

    const order = await this.request<RazorpayOrder>(
      'POST',
      '/orders',
      {
        amount,
        currency: input.currency,
        // Our order number, so a Razorpay dashboard row can be traced back.
        receipt: input.orderNumber,
        notes: { uboss_order_id: input.orderId, uboss_order_number: input.orderNumber },
      },
      input.idempotencyKey,
    );

    return {
      providerOrderId: order.id,
      checkoutPayload: await this.buildCheckoutPayload(order.id, input),
      status: PAYMENT_STATUS_MAP[order.status] ?? 'CREATED',
      amountMinor: BigInt(order.amount),
      currency: order.currency,
    };
  }

  /**
   * Everything the browser needs to open Razorpay Checkout.
   *
   * `key` is the PUBLISHABLE key id; the secret never leaves this process.
   * Deriving the payload rather than storing it keeps a replayed retry
   * byte-identical to the original without a second API call.
   *
   * The signature is a promise only because the interface is shared with
   * Stripe, whose payload cannot be derived. Nothing here awaits, so a replay
   * still costs no network round trip.
   */
  buildCheckoutPayload(
    providerOrderId: string,
    input: Omit<CreatePaymentInput, 'idempotencyKey'>,
  ): Promise<Record<string, string | number>> {
    return Promise.resolve({
      key: this.credentials.keyId,
      order_id: providerOrderId,
      amount: Number(input.amountMinor),
      currency: input.currency,
      name: 'UBOSS Sourcing',
      description: `Order ${input.orderNumber}`,
      prefill_email: input.customerEmail ?? '',
      prefill_name: input.customerName ?? '',
      prefill_contact: input.customerPhone ?? '',
      // Razorpay's own key for pre-selecting an instrument. Flat rather than
      // nested because the payload crosses the wire as Record<string, string |
      // number>; the browser module turns it into Checkout's `prefill.method`.
      // Empty means "offer everything", which is Razorpay's default.
      prefill_method: input.methodHint === 'UPI' ? 'upi' : '',
    });
  }

  async fetchPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    const [order, payments] = await Promise.all([
      this.request<RazorpayOrder>('GET', `/orders/${providerOrderId}`),
      this.request<{ items: RazorpayPayment[] }>('GET', `/orders/${providerOrderId}/payments`),
    ]);

    // An order can carry several attempts. A captured one is the outcome that
    // matters; otherwise report the most recent attempt.
    const captured = payments.items.find((payment) => payment.status === 'captured');
    const latest = captured ?? payments.items[payments.items.length - 1] ?? null;

    if (latest === null) {
      return {
        providerPaymentId: null,
        providerOrderId,
        status: PAYMENT_STATUS_MAP[order.status] ?? 'CREATED',
        amountMinor: BigInt(order.amount),
        capturedMinor: BigInt(order.amount_paid ?? 0),
        currency: order.currency,
        method: null,
        failureCode: null,
        failureMessage: null,
      };
    }

    return {
      providerPaymentId: latest.id,
      providerOrderId,
      status: PAYMENT_STATUS_MAP[latest.status] ?? 'PENDING',
      amountMinor: BigInt(latest.amount),
      capturedMinor: latest.status === 'captured' ? BigInt(latest.amount) : 0n,
      currency: latest.currency,
      method: latest.method ?? null,
      failureCode: latest.error_code ?? null,
      failureMessage: latest.error_description ?? null,
    };
  }

  async createRefund(input: RefundInput): Promise<RefundResult> {
    const amount = Number(input.amountMinor);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new PaymentProviderError({
        message: `Refusing to refund an implausible amount: ${input.amountMinor.toString()}`,
      });
    }

    const refund = await this.request<RazorpayRefund>(
      'POST',
      `/payments/${input.providerPaymentId}/refund`,
      { amount, speed: 'normal', notes: { reason: input.reason.slice(0, 250) } },
      input.idempotencyKey,
    );

    return {
      providerRefundId: refund.id,
      // `processed` is terminal; `pending` and `created` settle asynchronously
      // and are followed up by webhook or reconciliation.
      status:
        refund.status === 'processed'
          ? 'SUCCEEDED'
          : refund.status === 'failed'
            ? 'FAILED'
            : 'PROCESSING',
      amountMinor: BigInt(refund.amount),
      failureMessage: null,
    };
  }

  /**
   * Verify a webhook.
   *
   * HMAC-SHA256 over the raw body with the webhook secret, compared in constant
   * time against `X-Razorpay-Signature`. Nothing in the payload is trusted
   * until this passes - the body is attacker-controlled until proven otherwise.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | undefined>): VerifiedEvent {
    const reject = (reason: string): VerifiedEvent => ({
      verified: false,
      eventId: '',
      eventType: '',
      intent: 'UNKNOWN',
      providerOrderId: null,
      providerPaymentId: null,
      providerRefundId: null,
      amountMinor: null,
      currency: null,
      method: null,
      failureCode: null,
      failureMessage: null,
      rejectionReason: reason,
    });

    const signature = headers['x-razorpay-signature'];
    if (typeof signature !== 'string' || signature.length === 0) {
      return reject('missing X-Razorpay-Signature header');
    }

    if (this.webhookSecret.length === 0) {
      return reject('no webhook secret is configured for this connection');
    }

    const expected = createHmac('sha256', this.webhookSecret).update(rawBody).digest('hex');

    const provided = Buffer.from(signature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    // Length is compared first because timingSafeEqual throws on a mismatch.
    if (provided.length !== computed.length || !timingSafeEqual(provided, computed)) {
      return reject('signature mismatch');
    }

    // Only now is the payload safe to parse.
    let payload: RazorpayWebhookPayload;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as RazorpayWebhookPayload;
    } catch {
      return reject('body is not valid JSON');
    }

    const eventType = payload.event ?? '';
    const payment = payload.payload?.payment?.entity ?? null;
    const refund = payload.payload?.refund?.entity ?? null;
    const order = payload.payload?.order?.entity ?? null;

    const intent: VerifiedEvent['intent'] =
      eventType === 'payment.captured' || eventType === 'order.paid'
        ? 'PAYMENT_CAPTURED'
        : eventType === 'payment.failed'
          ? 'PAYMENT_FAILED'
          : eventType === 'refund.processed' || eventType === 'refund.failed'
            ? 'REFUND_PROCESSED'
            : 'UNKNOWN';

    // Razorpay does not always send an event id header, so fall back to a
    // deterministic composite. It still has to be stable across redeliveries -
    // that is what makes the unique index a duplicate guard.
    const eventId =
      headers['x-razorpay-event-id'] ??
      `${eventType}:${payment?.id ?? refund?.id ?? order?.id ?? 'unknown'}`;

    return {
      verified: true,
      eventId,
      eventType,
      intent,
      providerOrderId: payment?.order_id ?? order?.id ?? null,
      providerPaymentId: payment?.id ?? refund?.payment_id ?? null,
      providerRefundId: refund?.id ?? null,
      amountMinor:
        payment !== null
          ? BigInt(payment.amount)
          : refund !== null
            ? BigInt(refund.amount)
            : order !== null
              ? BigInt(order.amount)
              : null,
      currency: payment?.currency ?? order?.currency ?? null,
      method: payment?.method ?? null,
      failureCode: payment?.error_code ?? null,
      failureMessage: payment?.error_description ?? null,
    };
  }

  /**
   * Verify the signature Razorpay Checkout hands the browser.
   *
   * This proves the browser is not lying about a successful payment, but it is
   * NOT what confirms an order - the webhook is. Used only to decide whether to
   * show "processing" or "something went wrong" while the webhook is in flight.
   */
  verifyCheckoutSignature(params: {
    razorpayOrderId: string;
    razorpayPaymentId: string;
    razorpaySignature: string;
  }): boolean {
    const expected = createHmac('sha256', this.credentials.keySecret)
      .update(`${params.razorpayOrderId}|${params.razorpayPaymentId}`)
      .digest('hex');

    const provided = Buffer.from(params.razorpaySignature, 'utf8');
    const computed = Buffer.from(expected, 'utf8');

    if (provided.length !== computed.length) return false;
    return timingSafeEqual(provided, computed);
  }
}

interface RazorpayWebhookPayload {
  event?: string;
  payload?: {
    payment?: { entity?: RazorpayPayment };
    refund?: { entity?: RazorpayRefund };
    order?: { entity?: RazorpayOrder };
  };
}
