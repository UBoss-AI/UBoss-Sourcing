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
  type CardVaultProvider,
  type ConnectionTestResult,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type EnsureVaultCustomerInput,
  type NormalisedPaymentStatus,
  type PaymentMethodHint,
  type PaymentStatusResult,
  type ProviderCredentials,
  type ProviderMode,
  type RefundInput,
  type RefundResult,
  type VaultedCardDetails,
  type VerifiedEvent,
} from './provider.js';

const API_BASE = 'https://api.razorpay.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A much shorter budget for reading which instruments the account has enabled.
 *
 * That call sits on the checkout page's critical path and buys nothing but a
 * more precise instrument list. Fifteen seconds is the right patience for a
 * payment; for this it would mean a customer staring at an unfinished checkout
 * because a cosmetic lookup is slow.
 */
const PREFERENCES_TIMEOUT_MS = 4_000;

/** How long an answer is reused. An operator toggles UPI once, not hourly. */
const METHODS_TTL_MS = 10 * 60 * 1000;

/** Shorter, so a Razorpay outage is re-checked soon but not on every load. */
const METHODS_FAILURE_TTL_MS = 60 * 1000;

/**
 * Enabled instruments, keyed by the account they belong to.
 *
 * Cached because `availableGateways` runs on every checkout page load and the
 * answer changes only when an operator changes it in the Razorpay dashboard.
 *
 * Deliberately not persisted on the connection row and refreshed at
 * Test Connection time, which was the alternative. That would keep the
 * checkout page free of any dependency on Razorpay being reachable - but it
 * would also go stale the moment an operator switched UPI on or off without
 * re-testing in UBOSS, and serving a stale "UPI is available" is exactly the
 * silent lie this method exists to prevent. A ten-minute window in which UPI
 * is not yet offered errs in the harmless direction.
 *
 * One entry per key_id ever seen in this process: two in practice, and one
 * more each time an operator rotates credentials.
 */
const methodsByKeyId = new Map<string, { methods: PaymentMethodHint[]; expiresAt: number }>();

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
  /**
   * The customer this payment was made by, when checkout was given one.
   *
   * Present because a saved card belongs to a customer record, and without it
   * the token that comes back could not be filed against anybody.
   */
  customer_id?: string | null;
  /**
   * The token this payment produced, when the customer asked to save the card.
   *
   * Absent on every payment where they did not. Its presence is Razorpay's own
   * statement that a card was tokenised - which is why it is read here, off a
   * signature-verified webhook, and never from the browser.
   */
  token_id?: string | null;
  /**
   * The card, as far as Razorpay will describe it.
   *
   * `network` is what a person calls the brand; `type` is credit or debit and
   * is what files the card under one heading or the other. There is no expiry
   * here - Razorpay does not return one on this object - so a Razorpay card is
   * stored without one, which `assertChargeable` already tolerates.
   */
  card?: {
    id?: string;
    last4?: string | null;
    network?: string | null;
    type?: string | null;
    issuer?: string | null;
    international?: boolean | null;
  } | null;
}

interface RazorpayCustomer {
  id: string;
  name?: string | null;
  email?: string | null;
  contact?: string | null;
}

/**
 * A saved card, as Razorpay's Tokens API describes it.
 *
 * Richer than the card object on a payment: this one carries an expiry, which
 * is what lets a stored Razorpay card be retired when it lapses rather than
 * failing at a checkout.
 */
interface RazorpayToken {
  id: string;
  method?: string;
  card?: {
    last4?: string | null;
    network?: string | null;
    type?: string | null;
    issuer?: string | null;
    international?: boolean | null;
    expiry_month?: number | null;
    expiry_year?: number | null;
  } | null;
}

interface RazorpayRefund {
  id: string;
  amount: number;
  status: string;
  payment_id: string;
}

export class RazorpayAdapter implements CardVaultProvider {
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
    method: 'GET' | 'POST' | 'DELETE',
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

  /**
   * Which instruments this account will actually show, `ANY` included.
   *
   * `/preferences` is the same endpoint Razorpay's own checkout.js asks before
   * it draws the sheet, so it is the sheet's own answer rather than a guess
   * about it. It takes the key_id as a query parameter and no authentication -
   * that key already reaches the browser - so this sends no credentials and
   * uses its own short timeout rather than the payment path's.
   *
   * Every failure answers `['ANY']`: unreachable, malformed, or a shape
   * Razorpay has since changed. The customer then sees no named instrument,
   * which costs them one tap inside a sheet that still offers everything.
   */
  async offerableMethods(): Promise<PaymentMethodHint[]> {
    const cached = methodsByKeyId.get(this.credentials.keyId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.methods;

    let methods: PaymentMethodHint[] = ['ANY'];
    let ttl = METHODS_FAILURE_TTL_MS;

    try {
      const enabled = await this.readEnabledMethods();

      // Strictly `=== true`. Razorpay answers with a boolean here, and a shape
      // change that made it an object must not be read as "enabled" by
      // truthiness - that is how the promise gets made again.
      methods = enabled.upi === true ? ['ANY', 'UPI'] : ['ANY'];
      ttl = METHODS_TTL_MS;
    } catch (error) {
      logger.warn(
        { reason: error instanceof Error ? error.message : 'unknown error' },
        'could not read razorpay enabled instruments; offering none by name',
      );
    }

    methodsByKeyId.set(this.credentials.keyId, { methods, expiresAt: Date.now() + ttl });

    return methods;
  }

  /** The raw `methods` block from `/preferences`. Throws on anything unusable. */
  private async readEnabledMethods(): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, PREFERENCES_TIMEOUT_MS);

    try {
      const response = await fetch(
        `${API_BASE}/preferences?key_id=${encodeURIComponent(this.credentials.keyId)}`,
        { signal: controller.signal },
      );

      if (!response.ok) {
        throw new Error(`Razorpay returned HTTP ${String(response.status)}`);
      }

      const parsed = (await response.json()) as { methods?: Record<string, unknown> };

      return parsed.methods ?? {};
    } finally {
      clearTimeout(timer);
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
      /*
       * The customer's record at Razorpay, and whether to tokenise the card.
       *
       * These two are what make Razorpay's saved cards work at all. Given a
       * `customer_id`, Checkout shows that customer their previously saved
       * cards and asks only for the CVV; given `save`, it offers to store the
       * card they are about to use.
       *
       * The pick happens inside Razorpay's sheet rather than on our page, and
       * that is not a design choice - charging one named token directly needs
       * Razorpay's server-to-server API, which is open only to merchants
       * holding PCI-DSS certification. A deployment of this software does not
       * hold one, so the sheet is where the card is chosen. Our own list
       * upstream exists to tell the customer what they will find in there.
       *
       * `save` is 1 only when the customer ticked the box. Razorpay also asks
       * them again inside the sheet, which is the additional factor its own
       * tokenisation rules require - so a customer who changes their mind
       * there is not overridden by this flag.
       *
       * Both flat, and both empty rather than absent when they do not apply:
       * the payload type is Record<string, string | number>, and a replayed
       * retry has to be byte-identical to the original.
       */
      customer_id: input.providerCustomerId ?? '',
      save: input.saveCard === true && (input.providerCustomerId ?? '').length > 0 ? 1 : 0,
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
      /*
       * A card Razorpay tokenised as a side effect of this payment.
       *
       * Razorpay has no SetupIntent: a card becomes reusable by being paid
       * with, and the token id arrives here. So unlike Stripe's enrolment -
       * which the server re-reads from the provider before storing anything -
       * this IS the provider's own report, delivered over a channel whose
       * signature was checked against the raw bytes a few lines above. The
       * browser's success callback says nothing about it and is not consulted.
       *
       * Only reported on a capture. A token from a payment that failed would
       * be a card the customer never successfully used, and offering it back
       * to them at the next checkout would be offering a card we have no
       * evidence works.
       */
      vaultedCard:
        intent === 'PAYMENT_CAPTURED' &&
        typeof payment?.token_id === 'string' &&
        payment.token_id.length > 0
          ? {
              providerTokenId: payment.token_id,
              providerCustomerId: payment.customer_id ?? null,
            }
          : null,
      failureCode: payment?.error_code ?? null,
      failureMessage: payment?.error_description ?? null,
    };
  }

  // -------------------------------------------------------------------------
  // Storing a card
  // -------------------------------------------------------------------------
  //
  // Razorpay's tokenisation, which is a different shape from Stripe's and
  // worth stating outright:
  //
  //   · There is no SetupIntent. A card becomes reusable by being paid with,
  //     with `customer_id` and `save: 1` on the Checkout payload. The token
  //     comes back on the capture webhook.
  //   · This adapter can therefore STORE a card but cannot CHARGE a stored one
  //     directly - that needs Razorpay's server-to-server API, which is open
  //     only to PCI-DSS-certified merchants. So `RazorpayAdapter` implements
  //     `CardVaultProvider` and deliberately not `DirectCardChargeProvider`,
  //     and the difference is a compile error rather than a 500 at a checkout.
  //   · It implements neither half of `OffSessionProvider`. A card saved here
  //     cannot be charged in the night by anybody, which is exactly right: the
  //     customer agreed to skip retyping it, not to a mandate.

  /**
   * Find or create the Razorpay customer a saved card hangs off.
   *
   * `fail_existing: 0` is what makes this idempotent. Razorpay's default is to
   * error when a customer with the same contact already exists; with it set to
   * zero the existing record is returned instead, so a second checkout does
   * not produce a second customer whose cards the first one cannot see.
   */
  async ensureVaultCustomer(input: EnsureVaultCustomerInput): Promise<string> {
    const existing = input.providerCustomerId ?? '';
    if (existing.length > 0) return existing;

    const created = await this.request<RazorpayCustomer>(
      'POST',
      '/customers',
      {
        ...(input.customerName === null ? {} : { name: input.customerName }),
        ...(input.customerEmail === null ? {} : { email: input.customerEmail }),
        ...(input.customerPhone === null ? {} : { contact: input.customerPhone }),
        // See above. Without this a returning customer is an error, not a
        // lookup.
        fail_existing: 0,
        notes: { uboss_customer_profile_id: input.customerProfileId },
      },
      // Keyed on our profile id: a double-submitted checkout must not mint two
      // customer records for one person.
      `vault-customer:${input.customerProfileId}`,
    );

    return created.id;
  }

  /**
   * Read a stored token back.
   *
   * A 400 or 404 here means the token is gone - deleted by the customer in
   * their bank's app, or expired out of Razorpay's vault. That is a real
   * answer, so it comes back as null rather than as an error that would fail
   * the webhook carrying it.
   */
  async fetchVaultedCard(
    providerCustomerId: string,
    providerTokenId: string,
  ): Promise<VaultedCardDetails | null> {
    if (providerCustomerId.length === 0) return null;

    let token: RazorpayToken;
    try {
      token = await this.request<RazorpayToken>(
        'GET',
        `/customers/${encodeURIComponent(providerCustomerId)}/tokens/${encodeURIComponent(
          providerTokenId,
        )}`,
      );
    } catch (error) {
      if (error instanceof PaymentProviderError && !error.retryable) {
        logger.info(
          { providerTokenId },
          'razorpay does not have that token; treating it as gone',
        );
        return null;
      }
      throw error;
    }

    return {
      providerTokenId: token.id,
      providerCustomerId,
      // Razorpay's word for the brand is `network` and for the funding type it
      // is `type`. Passed through unmapped - turning either into this
      // application's vocabulary happens in one place, and this is not it.
      brand: token.card?.network ?? null,
      last4: token.card?.last4 ?? null,
      expMonth: token.card?.expiry_month ?? null,
      expYear: token.card?.expiry_year ?? null,
      funding: token.card?.type ?? null,
      country: token.card?.international === false ? 'IN' : null,
    };
  }

  /**
   * Delete a stored token at Razorpay.
   *
   * Unlike Stripe's detach, this genuinely needs the customer id - a token is
   * addressed underneath the customer it belongs to, which is also what stops
   * one customer's id being used to delete another's card.
   */
  async forgetVaultedCard(providerCustomerId: string, providerTokenId: string): Promise<void> {
    if (providerCustomerId.length === 0) {
      throw new PaymentProviderError({
        message: 'Cannot delete a Razorpay token without the customer it belongs to.',
      });
    }

    await this.request<unknown>(
      'DELETE',
      `/customers/${encodeURIComponent(providerCustomerId)}/tokens/${encodeURIComponent(
        providerTokenId,
      )}`,
    );
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
