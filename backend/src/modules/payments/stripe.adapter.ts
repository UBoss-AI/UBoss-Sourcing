/**
 * Stripe adapter.
 *
 * Talks to the real Stripe API over HTTPS. Like the Razorpay adapter there is
 * no simulated success path: with no credentials configured the payment
 * service refuses the request rather than pretending a payment worked.
 *
 * The unit of work is a **PaymentIntent**, not a Checkout Session. A
 * PaymentIntent is what every relevant webhook carries a reference to
 * (`payment_intent.succeeded`, `payment_intent.payment_failed`, and a refund's
 * charge), so one identifier - `pi_...` - fills the `providerOrderId` slot on
 * every path. A Checkout Session id would only appear on the session events,
 * leaving failures and refunds unmatchable.
 *
 * Amounts are integer minor units, which is Stripe's own unit. `money.ts`
 * already models zero-decimal currencies (JPY, KRW) with exponent 0, exactly
 * as Stripe does, so the BigInt crosses the boundary unchanged - there is no
 * decimal conversion anywhere in this file.
 *
 * Credential naming follows `ProviderCredentials`, shared with Razorpay:
 *   keyId     -> the PUBLISHABLE key (pk_test_... / pk_live_...). Public, sent
 *                to the browser, and what `modeForCredential` reads.
 *   keySecret -> the SECRET key (sk_... or a restricted rk_...). Never leaves
 *                this process.
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
  type PaymentMethodHint,
  type PaymentProvider,
  type PaymentStatusResult,
  type ProviderCredentials,
  type ProviderMode,
  type RefundInput,
  type RefundResult,
  type VerifiedEvent,
} from './provider.js';

const API_BASE = 'https://api.stripe.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Pinned API version.
 *
 * Without it Stripe applies whatever version the *account* defaults to, which
 * an administrator can change in the dashboard - silently altering the shape
 * of the objects this file parses, on a deployment nobody touched. Pinned here
 * so an upgrade is a code change with a test run behind it.
 */
const API_VERSION = '2024-06-20';

/**
 * How much clock skew a webhook timestamp may carry, in seconds.
 *
 * A signature stays valid forever without this: an attacker who captures one
 * delivery could replay it months later. Stripe's own libraries default to the
 * same five minutes.
 */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * PaymentIntent states, mapped to ours.
 *
 * `requires_capture` is deliberately not success: the money is authorised but
 * not taken, and an order must not be confirmed on a hold. `processing` is not
 * success either - delayed methods (SEPA debit, and others European buyers
 * use) sit there for days and can still fail.
 */
const INTENT_STATUS_MAP: Readonly<Record<string, NormalisedPaymentStatus>> = Object.freeze({
  requires_payment_method: 'CREATED',
  requires_confirmation: 'CREATED',
  requires_action: 'PENDING',
  processing: 'PENDING',
  requires_capture: 'AUTHORIZED',
  succeeded: 'CAPTURED',
  canceled: 'CANCELLED',
});

interface StripeErrorBody {
  error?: {
    type?: string;
    code?: string;
    message?: string;
    decline_code?: string;
  };
}

interface StripePaymentIntent {
  id: string;
  object?: string;
  amount: number;
  amount_received?: number;
  currency: string;
  status: string;
  client_secret?: string | null;
  payment_method_types?: string[];
  /** A charge id when unexpanded, the charge object when expanded. */
  latest_charge?: string | StripeCharge | null;
  last_payment_error?: {
    code?: string;
    decline_code?: string;
    message?: string;
  } | null;
}

interface StripeCharge {
  id: string;
  object?: string;
  amount: number;
  amount_refunded?: number;
  currency: string;
  payment_intent?: string | null;
  payment_method_details?: { type?: string } | null;
  refunds?: { data?: StripeRefund[] } | null;
}

interface StripeRefund {
  id: string;
  object?: string;
  amount: number;
  currency?: string;
  status?: string;
  charge?: string | null;
  payment_intent?: string | null;
  failure_reason?: string | null;
}

interface StripeBalance {
  livemode?: boolean;
}

interface StripeEventEnvelope {
  id?: string;
  type?: string;
  data?: { object?: Record<string, unknown> };
}

/**
 * What a Stripe request body may contain, once flattened.
 *
 * Spelled out rather than `unknown` so the encoder below cannot be handed an
 * object it would silently stringify to "[object Object]" and send as a
 * parameter value.
 */
type FormValue = string | number | boolean | null | undefined | FormValue[] | FormObject;
interface FormObject {
  [key: string]: FormValue;
}

/**
 * Flatten a nested object into Stripe's bracketed form encoding.
 *
 * Stripe's API is form-encoded, not JSON, and expresses nesting as
 * `metadata[order_id]=x` and `expand[0]=latest_charge`. Undefined and null
 * entries are dropped rather than sent as the strings "undefined"/"null",
 * which Stripe would store verbatim in metadata.
 */
function encodeForm(payload: FormObject, prefix = ''): string {
  const parts: string[] = [];

  const push = (path: string, value: string | number | boolean): void => {
    parts.push(`${encodeURIComponent(path)}=${encodeURIComponent(value.toString())}`);
  };

  const walk = (path: string, value: FormValue): void => {
    if (value === undefined || value === null) return;

    if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        walk(`${path}[${index}]`, entry);
      });
      return;
    }

    if (typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        walk(`${path}[${key}]`, nested);
      }
      return;
    }

    push(path, value);
  };

  for (const [key, value] of Object.entries(payload)) {
    walk(prefix === '' ? key : `${prefix}[${key}]`, value);
  }

  return parts.join('&');
}

/** Stripe returns lowercase ISO codes; the rest of the system works uppercase. */
function normaliseCurrency(currency: string): string {
  return currency.toUpperCase();
}

/** `latest_charge` is a bare id unless the request expanded it. */
function chargeIdOf(intent: StripePaymentIntent): string | null {
  const charge = intent.latest_charge;
  if (typeof charge === 'string') return charge;
  return charge?.id ?? null;
}

export class StripeAdapter implements PaymentProvider {
  readonly kind = 'STRIPE' as const;
  readonly mode: ProviderMode;

  private readonly authHeader: string;
  private readonly webhookSecret: string;

  constructor(private readonly credentials: ProviderCredentials) {
    // Read from the publishable key, which is the field an administrator types
    // into the "Key id" box and the one the mode-mismatch guard checks.
    this.mode = modeForCredential(credentials.keyId);
    this.authHeader = `Bearer ${credentials.keySecret}`;
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
    body?: FormObject,
    idempotencyKey?: string,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Stripe-Version': API_VERSION,
          ...(idempotencyKey !== undefined ? { 'Idempotency-Key': idempotencyKey } : {}),
        },
        ...(body !== undefined ? { body: encodeForm(body) } : {}),
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
        const error = (parsed as StripeErrorBody | null)?.error;

        // 5xx and 429 are worth retrying. A 402 is a declined card and a 400 is
        // a wrong request; retrying either only delays telling the customer.
        const retryable = response.status >= 500 || response.status === 429;

        // Deliberately does not log the body: a Stripe error response echoes
        // request fields, and one of them can be a customer's email.
        logger.warn(
          { httpStatus: response.status, providerCode: error?.code, path },
          'stripe request failed',
        );

        throw new PaymentProviderError({
          message: error?.message ?? `Stripe returned HTTP ${String(response.status)}`,
          providerCode: error?.decline_code ?? error?.code ?? error?.type ?? null,
          retryable,
          httpStatus: response.status,
        });
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof PaymentProviderError) throw error;

      // A timeout or a DNS failure. Retryable, and the caller must reconcile
      // rather than assume the payment did not happen - Stripe may well have
      // processed it.
      const isAbort = error instanceof Error && error.name === 'AbortError';
      throw new PaymentProviderError({
        message: isAbort
          ? 'Stripe did not respond in time.'
          : `Could not reach Stripe: ${error instanceof Error ? error.message : 'unknown error'}`,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Nothing to name beyond the default.
   *
   * Stripe decides its own instrument list from the account's settings and the
   * customer's country, and nothing in this codebase asks it to open on a
   * particular one. Enumerating what the account has enabled would therefore
   * produce a list this application cannot act on - a choice that changes
   * nothing is worse than no choice at all.
   *
   * No network call, so a checkout page costs nothing to ask.
   */
  offerableMethods(): Promise<PaymentMethodHint[]> {
    return Promise.resolve(['ANY']);
  }

  async testConnection(): Promise<ConnectionTestResult> {
    // Checked before the network call: a publishable key paired with the other
    // environment's secret key produces a working API handshake and a checkout
    // that can never be confirmed, which is the hardest variant to diagnose
    // from the symptom.
    const secret = this.credentials.keySecret;

    if (!secret.startsWith('sk_') && !secret.startsWith('rk_')) {
      return {
        ok: false,
        mode: this.mode,
        message:
          'That secret does not look like a Stripe secret key. It should begin with sk_ ' +
          '(or rk_ for a restricted key). The pk_ key belongs in the Key id field.',
      };
    }

    if (!this.credentials.keyId.startsWith('pk_')) {
      return {
        ok: false,
        mode: this.mode,
        message:
          'The Key id should be your Stripe PUBLISHABLE key, beginning with pk_. ' +
          'It is sent to the browser, so the secret key must not go there.',
      };
    }

    const secretIsLive = secret.startsWith('sk_live_') || secret.startsWith('rk_live_');

    if (secretIsLive !== (this.mode === 'LIVE')) {
      return {
        ok: false,
        mode: this.mode,
        message:
          'The publishable key and the secret key are from different Stripe environments. ' +
          'Pair pk_test_ with sk_test_, or pk_live_ with sk_live_.',
      };
    }

    try {
      // The cheapest authenticated call that creates nothing, and it reports
      // `livemode` from Stripe's own side rather than from the key prefix.
      const balance = await this.request<StripeBalance>('GET', '/balance');
      const remoteMode: ProviderMode = balance.livemode === true ? 'LIVE' : 'TEST';

      if (remoteMode !== this.mode) {
        return {
          ok: false,
          mode: remoteMode,
          message: `Stripe reports these credentials are ${remoteMode}, but they are filed as ${this.mode}.`,
        };
      }

      return {
        ok: true,
        mode: remoteMode,
        message:
          remoteMode === 'TEST'
            ? 'Connected to Stripe in TEST mode. No real money can move.'
            : 'Connected to Stripe in LIVE mode. Real payments will be processed.',
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
    // Stripe counts in minor units, exactly as we do, so the BigInt converts
    // with no decimal arithmetic. The Number() is safe: an order beyond 2^53
    // minor units is far past any amount Stripe itself will accept.
    const amount = Number(input.amountMinor);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new PaymentProviderError({
        message: `Refusing to create a payment for an implausible amount: ${input.amountMinor.toString()}`,
      });
    }

    const intent = await this.request<StripePaymentIntent>(
      'POST',
      '/payment_intents',
      {
        amount,
        currency: input.currency.toLowerCase(),
        // Lets the account's enabled methods decide what the browser offers -
        // cards, plus iDEAL/Bancontact/SEPA where the deployment sells into
        // Europe - without this file enumerating them.
        automatic_payment_methods: { enabled: true },
        description: `Order ${input.orderNumber}`,
        // Our identifiers, so a Stripe dashboard row traces back to an order.
        metadata: {
          uboss_order_id: input.orderId,
          uboss_order_number: input.orderNumber,
        },
        // Deliberately no `receipt_email`: Stripe would send its own receipt on
        // top of the order confirmation this system already sends, and the
        // customer would get two emails for one purchase.
      },
      input.idempotencyKey,
    );

    if (typeof intent.client_secret !== 'string' || intent.client_secret.length === 0) {
      // Without it the browser cannot confirm the payment, and continuing would
      // leave an intent open in Stripe that nothing can ever complete.
      throw new PaymentProviderError({
        message: 'Stripe created the payment but returned no client secret.',
      });
    }

    return {
      providerOrderId: intent.id,
      checkoutPayload: this.payloadFor(intent, input),
      status: INTENT_STATUS_MAP[intent.status] ?? 'CREATED',
      amountMinor: BigInt(intent.amount),
      currency: normaliseCurrency(intent.currency),
    };
  }

  /**
   * Everything the browser needs to mount Stripe's Payment Element.
   *
   * `key` is the PUBLISHABLE key; the secret never leaves this process. The
   * client secret authorises confirming this one PaymentIntent and nothing
   * else - it cannot read the account, list payments, or refund anything.
   *
   * Unlike Razorpay's, this payload cannot be derived: `client_secret` carries
   * random bytes Stripe generated. So the replay path re-reads the intent. It
   * is a GET - no second intent is created, which is the property the retry
   * path actually depends on.
   */
  async buildCheckoutPayload(
    providerOrderId: string,
    input: Omit<CreatePaymentInput, 'idempotencyKey'>,
  ): Promise<Record<string, string | number>> {
    if (providerOrderId.length === 0) {
      throw new PaymentProviderError({
        message: 'Cannot rebuild a Stripe checkout without a payment intent id.',
      });
    }

    const intent = await this.request<StripePaymentIntent>(
      'GET',
      `/payment_intents/${encodeURIComponent(providerOrderId)}`,
    );

    if (typeof intent.client_secret !== 'string' || intent.client_secret.length === 0) {
      throw new PaymentProviderError({
        message: 'Stripe returned no client secret for that payment.',
      });
    }

    return this.payloadFor(intent, input);
  }

  private payloadFor(
    intent: StripePaymentIntent,
    input: Omit<CreatePaymentInput, 'idempotencyKey'>,
  ): Record<string, string | number> {
    return {
      key: this.credentials.keyId,
      client_secret: intent.client_secret ?? '',
      payment_intent_id: intent.id,
      amount: Number(input.amountMinor),
      currency: input.currency,
      name: 'UBOSS Sourcing',
      description: `Order ${input.orderNumber}`,
      prefill_email: input.customerEmail ?? '',
      prefill_name: input.customerName ?? '',
      prefill_contact: input.customerPhone ?? '',
    };
  }

  async fetchPaymentStatus(providerOrderId: string): Promise<PaymentStatusResult> {
    // Expanding the charge in the same call gets the real method ("card",
    // "ideal", "sepa_debit") rather than the list of methods that were merely
    // offered.
    const intent = await this.request<StripePaymentIntent>(
      'GET',
      `/payment_intents/${encodeURIComponent(providerOrderId)}?${encodeForm({
        expand: ['latest_charge'],
      })}`,
    );

    const charge = typeof intent.latest_charge === 'object' ? intent.latest_charge : null;
    const status = INTENT_STATUS_MAP[intent.status] ?? 'PENDING';

    return {
      providerPaymentId: chargeIdOf(intent),
      providerOrderId: intent.id,
      status,
      amountMinor: BigInt(intent.amount),
      capturedMinor: status === 'CAPTURED' ? BigInt(intent.amount_received ?? intent.amount) : 0n,
      currency: normaliseCurrency(intent.currency),
      method: charge?.payment_method_details?.type ?? intent.payment_method_types?.[0] ?? null,
      failureCode: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null,
      failureMessage: intent.last_payment_error?.message ?? null,
    };
  }

  async createRefund(input: RefundInput): Promise<RefundResult> {
    const amount = Number(input.amountMinor);

    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new PaymentProviderError({
        message: `Refusing to refund an implausible amount: ${input.amountMinor.toString()}`,
      });
    }

    // Normally a charge id, because that is what a captured event records. An
    // intent id is accepted too so a refund still works for a payment
    // reconciled before any charge id was stored.
    const target = input.providerPaymentId.startsWith('pi_')
      ? { payment_intent: input.providerPaymentId }
      : { charge: input.providerPaymentId };

    const refund = await this.request<StripeRefund>(
      'POST',
      '/refunds',
      {
        ...target,
        amount,
        metadata: { reason: input.reason.slice(0, 250) },
      },
      input.idempotencyKey,
    );

    return {
      // `succeeded` is terminal; `pending` and `requires_action` settle
      // asynchronously and are followed up by webhook or reconciliation.
      status:
        refund.status === 'succeeded'
          ? 'SUCCEEDED'
          : refund.status === 'failed' || refund.status === 'canceled'
            ? 'FAILED'
            : 'PROCESSING',
      providerRefundId: refund.id,
      amountMinor: BigInt(refund.amount),
      failureMessage: refund.failure_reason ?? null,
    };
  }

  /**
   * Verify a webhook.
   *
   * Stripe signs `${timestamp}.${rawBody}` with the endpoint's signing secret
   * and sends the result as `Stripe-Signature: t=...,v1=...`. Nothing in the
   * payload is trusted until the HMAC matches in constant time AND the
   * timestamp is recent - a signature with no freshness check stays valid
   * forever, so a captured delivery could be replayed indefinitely.
   *
   * The header may carry several `v1` values during a secret rotation; any one
   * matching is enough.
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

    const header = headers['stripe-signature'];
    if (typeof header !== 'string' || header.length === 0) {
      return reject('missing Stripe-Signature header');
    }

    if (this.webhookSecret.length === 0) {
      return reject('no webhook secret is configured for this connection');
    }

    let timestamp: string | null = null;
    const signatures: string[] = [];

    for (const element of header.split(',')) {
      const separator = element.indexOf('=');
      if (separator === -1) continue;

      const name = element.slice(0, separator).trim();
      const value = element.slice(separator + 1).trim();

      if (name === 't') timestamp = value;
      else if (name === 'v1') signatures.push(value);
    }

    if (timestamp === null || !/^\d+$/.test(timestamp)) {
      return reject('Stripe-Signature header has no usable timestamp');
    }

    if (signatures.length === 0) {
      return reject('Stripe-Signature header has no v1 signature');
    }

    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
    if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) {
      return reject(`webhook timestamp is ${String(ageSeconds)}s out of tolerance`);
    }

    const expected = createHmac('sha256', this.webhookSecret)
      .update(`${timestamp}.`)
      .update(rawBody)
      .digest('hex');

    const computed = Buffer.from(expected, 'utf8');

    const matched = signatures.some((candidate) => {
      const provided = Buffer.from(candidate, 'utf8');
      // Length is compared first because timingSafeEqual throws on a mismatch.
      return provided.length === computed.length && timingSafeEqual(provided, computed);
    });

    if (!matched) return reject('signature mismatch');

    // Only now is the payload safe to parse.
    let envelope: StripeEventEnvelope;
    try {
      envelope = JSON.parse(rawBody.toString('utf8')) as StripeEventEnvelope;
    } catch {
      return reject('body is not valid JSON');
    }

    const eventType = envelope.type ?? '';
    const object = envelope.data?.object ?? null;

    if (object === null) return reject('event carries no object');
    if (typeof envelope.id !== 'string' || envelope.id.length === 0) {
      // The event id is the duplicate-delivery guard's unique key. Without one
      // a redelivery would be applied a second time, and Stripe retries for
      // three days.
      return reject('event carries no id');
    }

    const base = {
      verified: true as const,
      eventId: envelope.id,
      eventType,
    };

    const empty = {
      providerOrderId: null,
      providerPaymentId: null,
      providerRefundId: null,
      amountMinor: null,
      currency: null,
      method: null,
      failureCode: null,
      failureMessage: null,
    };

    if (eventType === 'payment_intent.succeeded') {
      const intent = object as unknown as StripePaymentIntent;

      return {
        ...base,
        ...empty,
        intent: 'PAYMENT_CAPTURED',
        providerOrderId: intent.id,
        // The charge id, which is what a later refund is issued against.
        providerPaymentId: chargeIdOf(intent),
        // What Stripe actually collected, not what was asked for. The service
        // compares this against the order and refuses a mismatch.
        amountMinor: BigInt(intent.amount_received ?? intent.amount),
        currency: normaliseCurrency(intent.currency),
        method: intent.payment_method_types?.[0] ?? null,
      };
    }

    if (eventType === 'payment_intent.payment_failed') {
      const intent = object as unknown as StripePaymentIntent;

      return {
        ...base,
        ...empty,
        intent: 'PAYMENT_FAILED',
        providerOrderId: intent.id,
        providerPaymentId: chargeIdOf(intent),
        amountMinor: BigInt(intent.amount),
        currency: normaliseCurrency(intent.currency),
        failureCode: intent.last_payment_error?.decline_code ?? intent.last_payment_error?.code ?? null,
        failureMessage: intent.last_payment_error?.message ?? null,
      };
    }

    if (eventType === 'charge.refunded') {
      const charge = object as unknown as StripeCharge;
      const latestRefund = charge.refunds?.data?.[0] ?? null;

      return {
        ...base,
        ...empty,
        intent: 'REFUND_PROCESSED',
        providerOrderId: charge.payment_intent ?? null,
        providerPaymentId: charge.id,
        providerRefundId: latestRefund?.id ?? null,
        amountMinor: BigInt(latestRefund?.amount ?? charge.amount_refunded ?? 0),
        currency: normaliseCurrency(charge.currency),
      };
    }

    if (eventType === 'refund.updated' || eventType === 'refund.failed') {
      const refund = object as unknown as StripeRefund;

      // `refund.updated` also fires on non-terminal transitions. Reporting one
      // as REFUND_PROCESSED would settle the refund row on a status that has
      // not settled, so only the terminal states are acted on.
      const terminal = refund.status === 'succeeded' || refund.status === 'failed';

      return {
        ...base,
        ...empty,
        intent: terminal ? 'REFUND_PROCESSED' : 'UNKNOWN',
        // The service reads the literal string 'refund.failed' to decide
        // whether the refund row becomes FAILED or SUCCEEDED, so a failed
        // `refund.updated` has to arrive under that name to be recorded
        // correctly.
        eventType: refund.status === 'failed' ? 'refund.failed' : eventType,
        providerOrderId: refund.payment_intent ?? null,
        providerPaymentId: refund.charge ?? null,
        providerRefundId: refund.id,
        amountMinor: BigInt(refund.amount),
        currency: refund.currency === undefined ? null : normaliseCurrency(refund.currency),
        failureMessage: refund.failure_reason ?? null,
      };
    }

    // A real, verified event this system does not act on - `charge.succeeded`
    // among them, deliberately: it reports the same capture as
    // `payment_intent.succeeded`, and acting on both would credit the order
    // twice.
    return { ...base, ...empty, intent: 'UNKNOWN' };
  }
}
