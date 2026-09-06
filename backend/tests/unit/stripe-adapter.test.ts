/**
 * The Stripe adapter.
 *
 * Each test here maps to a specific way money could go wrong: a forged webhook
 * accepted, a captured delivery replayed months later, one capture credited
 * twice because two Stripe events describe it, a currency compared in the
 * wrong case and rejected, a secret key sent to a browser.
 *
 * Nothing here reaches the network. `verifyWebhook` is pure, and the calls
 * that are not run against a stubbed `fetch` so the request Stripe would
 * actually receive can be asserted on.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StripeAdapter } from '../../src/modules/payments/stripe.adapter.js';
import { PaymentProviderError } from '../../src/modules/payments/provider.js';

const WEBHOOK_SECRET = 'whsec_test_secret_value';

const credentials = {
  keyId: 'pk_test_publishable',
  keySecret: 'sk_test_secret',
  webhookSecret: WEBHOOK_SECRET,
};

function adapter(overrides: Partial<typeof credentials> = {}): StripeAdapter {
  return new StripeAdapter({ ...credentials, ...overrides });
}

/** Sign a body the way Stripe does, so a valid delivery can be constructed. */
function sign(
  body: string,
  { secret = WEBHOOK_SECRET, timestamp = Math.floor(Date.now() / 1000) } = {},
): { rawBody: Buffer; headers: Record<string, string> } {
  const signature = createHmac('sha256', secret).update(`${String(timestamp)}.${body}`).digest('hex');

  return {
    rawBody: Buffer.from(body, 'utf8'),
    headers: { 'stripe-signature': `t=${String(timestamp)},v1=${signature}` },
  };
}

function eventBody(type: string, object: Record<string, unknown>, id = 'evt_test_1'): string {
  return JSON.stringify({ id, type, data: { object } });
}

const succeededIntent = {
  id: 'pi_test_123',
  object: 'payment_intent',
  amount: 250_00,
  amount_received: 250_00,
  currency: 'eur',
  status: 'succeeded',
  latest_charge: 'ch_test_456',
  payment_method_types: ['card'],
};

describe('webhook signature verification', () => {
  it('accepts a correctly signed delivery', () => {
    const body = eventBody('payment_intent.succeeded', succeededIntent);
    const { rawBody, headers } = sign(body);

    const event = adapter().verifyWebhook(rawBody, headers);

    expect(event.verified).toBe(true);
    expect(event.eventId).toBe('evt_test_1');
  });

  it('rejects a delivery with no signature header', () => {
    const event = adapter().verifyWebhook(Buffer.from('{}', 'utf8'), {});

    expect(event.verified).toBe(false);
    expect(event.rejectionReason).toMatch(/missing Stripe-Signature/i);
  });

  it('rejects a body that was altered after signing', () => {
    const body = eventBody('payment_intent.succeeded', succeededIntent);
    const { headers } = sign(body);

    // The amount an attacker would want to change, with the original signature.
    const tampered = Buffer.from(body.replace('25000', '1'), 'utf8');

    const event = adapter().verifyWebhook(tampered, headers);

    expect(event.verified).toBe(false);
    expect(event.rejectionReason).toBe('signature mismatch');
  });

  it('rejects a signature made with a different secret', () => {
    const body = eventBody('payment_intent.succeeded', succeededIntent);
    const { rawBody, headers } = sign(body, { secret: 'whsec_someone_elses_secret' });

    const event = adapter().verifyWebhook(rawBody, headers);

    expect(event.verified).toBe(false);
    expect(event.rejectionReason).toBe('signature mismatch');
  });

  it('rejects a genuine delivery replayed outside the tolerance window', () => {
    // Correctly signed, and captured an hour ago. Without a freshness check
    // this stays valid forever.
    const body = eventBody('payment_intent.succeeded', succeededIntent);
    const { rawBody, headers } = sign(body, {
      timestamp: Math.floor(Date.now() / 1000) - 3600,
    });

    const event = adapter().verifyWebhook(rawBody, headers);

    expect(event.verified).toBe(false);
    expect(event.rejectionReason).toMatch(/out of tolerance/);
  });

  it('accepts a delivery during a secret rotation, when only one v1 matches', () => {
    const body = eventBody('payment_intent.succeeded', succeededIntent);
    const timestamp = Math.floor(Date.now() / 1000);
    const good = createHmac('sha256', WEBHOOK_SECRET)
      .update(`${String(timestamp)}.${body}`)
      .digest('hex');

    const event = adapter().verifyWebhook(Buffer.from(body, 'utf8'), {
      'stripe-signature': `t=${String(timestamp)},v1=${'0'.repeat(64)},v1=${good}`,
    });

    expect(event.verified).toBe(true);
  });

  it('refuses to verify when no webhook secret is configured', () => {
    const body = eventBody('payment_intent.succeeded', succeededIntent);
    const { rawBody, headers } = sign(body);

    const event = adapter({ webhookSecret: '' }).verifyWebhook(rawBody, headers);

    expect(event.verified).toBe(false);
    expect(event.rejectionReason).toMatch(/no webhook secret/i);
  });

  it('rejects a signed event with no id, which the duplicate guard depends on', () => {
    const body = JSON.stringify({
      type: 'payment_intent.succeeded',
      data: { object: succeededIntent },
    });
    const { rawBody, headers } = sign(body);

    const event = adapter().verifyWebhook(rawBody, headers);

    expect(event.verified).toBe(false);
    expect(event.rejectionReason).toMatch(/no id/);
  });
});

describe('webhook event mapping', () => {
  function verify(type: string, object: Record<string, unknown>, id = 'evt_test_1') {
    const body = eventBody(type, object, id);
    const { rawBody, headers } = sign(body);
    return adapter().verifyWebhook(rawBody, headers);
  }

  it('maps a succeeded intent to a capture, in the amount actually received', () => {
    const event = verify('payment_intent.succeeded', {
      ...succeededIntent,
      amount: 300_00,
      amount_received: 250_00,
    });

    expect(event.intent).toBe('PAYMENT_CAPTURED');
    expect(event.providerOrderId).toBe('pi_test_123');
    // The charge, because that is what a refund is later issued against.
    expect(event.providerPaymentId).toBe('ch_test_456');
    expect(event.amountMinor).toBe(25_000n);
  });

  it('reports the currency uppercased, as the order stores it', () => {
    // Stripe sends "eur". Compared as-is against an order's "EUR", every
    // payment would be rejected as a currency mismatch.
    const event = verify('payment_intent.succeeded', succeededIntent);

    expect(event.currency).toBe('EUR');
  });

  it('does not act on charge.succeeded, which describes the same capture', () => {
    // Both events arrive for one payment. Acting on both would credit the
    // order twice, and the duplicate guard would not catch it - they carry
    // different event ids.
    const event = verify('charge.succeeded', {
      id: 'ch_test_456',
      amount: 250_00,
      currency: 'eur',
      payment_intent: 'pi_test_123',
    });

    expect(event.verified).toBe(true);
    expect(event.intent).toBe('UNKNOWN');
  });

  it('maps a failed intent, carrying the decline code Stripe gave', () => {
    const event = verify('payment_intent.payment_failed', {
      ...succeededIntent,
      status: 'requires_payment_method',
      last_payment_error: {
        code: 'card_declined',
        decline_code: 'insufficient_funds',
        message: 'Your card has insufficient funds.',
      },
    });

    expect(event.intent).toBe('PAYMENT_FAILED');
    expect(event.failureCode).toBe('insufficient_funds');
    expect(event.failureMessage).toBe('Your card has insufficient funds.');
  });

  it('maps a settled refund', () => {
    const event = verify('refund.updated', {
      id: 're_test_1',
      amount: 100_00,
      currency: 'eur',
      status: 'succeeded',
      charge: 'ch_test_456',
      payment_intent: 'pi_test_123',
    });

    expect(event.intent).toBe('REFUND_PROCESSED');
    expect(event.providerRefundId).toBe('re_test_1');
    expect(event.providerOrderId).toBe('pi_test_123');
  });

  it('renames a failed refund.updated so it is not recorded as a success', () => {
    // The service decides SUCCEEDED vs FAILED from the literal event type, so
    // a failure arriving under the name "refund.updated" would settle the
    // refund row as though the money had gone back.
    const event = verify('refund.updated', {
      id: 're_test_2',
      amount: 100_00,
      currency: 'eur',
      status: 'failed',
      charge: 'ch_test_456',
      payment_intent: 'pi_test_123',
      failure_reason: 'expired_or_canceled_card',
    });

    expect(event.intent).toBe('REFUND_PROCESSED');
    expect(event.eventType).toBe('refund.failed');
  });

  it('does not settle a refund that is still in flight', () => {
    const event = verify('refund.updated', {
      id: 're_test_3',
      amount: 100_00,
      currency: 'eur',
      status: 'pending',
      payment_intent: 'pi_test_123',
    });

    expect(event.intent).toBe('UNKNOWN');
  });
});

describe('credential checks', () => {
  it('catches the two keys pasted the wrong way round, before any network call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await adapter({
      keyId: 'sk_test_secret',
      keySecret: 'pk_test_publishable',
    }).testConnection();

    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('catches a test publishable key paired with a live secret key', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const result = await adapter({ keySecret: 'sk_live_secret' }).testConnection();

    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/different Stripe environments/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('outbound requests', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * The form-encoded body of a recorded call.
   *
   * Asserted to be a string rather than coerced: a body that arrived as
   * anything else would mean the adapter stopped form-encoding, and a test
   * that quietly stringified it to "[object Object]" would still pass.
   */
  function bodyOf(call: unknown): string {
    const body = (call as [string, RequestInit])[1].body;
    if (typeof body !== 'string') throw new Error('expected a form-encoded string body');
    return body;
  }

  function stubFetch(body: unknown, status = 200): ReturnType<typeof vi.fn> {
    const spy = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  const paymentInput = {
    orderId: '01JBOSSORDER00000000000001',
    orderNumber: 'UB-2026-000123',
    amountMinor: 250_00n,
    currency: 'EUR',
    customerEmail: 'buyer@example.com',
    customerName: 'A Buyer',
    customerPhone: null,
    idempotencyKey: 'idem-key-1',
  };

  it('sends a form-encoded intent with the idempotency key and our order metadata', async () => {
    const spy = stubFetch({ ...succeededIntent, status: 'requires_payment_method', client_secret: 'pi_test_123_secret_abc' });

    await adapter().createPayment(paymentInput);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;

    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(headers['Idempotency-Key']).toBe('idem-key-1');
    expect(headers.Authorization).toBe('Bearer sk_test_secret');

    const body = bodyOf(spy.mock.calls[0]);
    expect(body).toContain('amount=25000');
    // Lowercased for Stripe, which is the only place the currency is not
    // carried in the system's own uppercase form.
    expect(body).toContain('currency=eur');
    expect(body).toContain('automatic_payment_methods%5Benabled%5D=true');
    expect(body).toContain(`metadata%5Buboss_order_id%5D=${paymentInput.orderId}`);
  });

  it('returns the client secret the browser needs, and nothing secret', async () => {
    stubFetch({ ...succeededIntent, status: 'requires_payment_method', client_secret: 'pi_test_123_secret_abc' });

    const created = await adapter().createPayment(paymentInput);

    expect(created.providerOrderId).toBe('pi_test_123');
    expect(created.checkoutPayload.key).toBe('pk_test_publishable');
    expect(created.checkoutPayload.client_secret).toBe('pi_test_123_secret_abc');
    expect(JSON.stringify(created.checkoutPayload)).not.toContain('sk_test');
  });

  it('refuses an intent Stripe returned without a client secret', async () => {
    // Continuing would leave an intent open in Stripe that nothing can finish.
    stubFetch({ ...succeededIntent, status: 'requires_payment_method', client_secret: null });

    await expect(adapter().createPayment(paymentInput)).rejects.toBeInstanceOf(PaymentProviderError);
  });

  it('replays a retry by reading the intent, never by creating a second one', async () => {
    const spy = stubFetch({ ...succeededIntent, client_secret: 'pi_test_123_secret_abc' });

    const payload = await adapter().buildCheckoutPayload('pi_test_123', paymentInput);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('GET');
    expect(url).toBe('https://api.stripe.com/v1/payment_intents/pi_test_123');
    expect(payload.client_secret).toBe('pi_test_123_secret_abc');
  });

  it('refunds against the charge, which is what a capture recorded', async () => {
    const spy = stubFetch({ id: 're_test_1', amount: 100_00, status: 'succeeded' });

    await adapter().createRefund({
      providerPaymentId: 'ch_test_456',
      amountMinor: 100_00n,
      currency: 'EUR',
      reason: 'Damaged on arrival',
      idempotencyKey: 'refund-key-1',
    });

    const body = bodyOf(spy.mock.calls[0]);
    expect(body).toContain('charge=ch_test_456');
    expect(body).toContain('amount=10000');
  });

  it('refunds against the intent when that is all that was stored', async () => {
    const spy = stubFetch({ id: 're_test_2', amount: 100_00, status: 'pending' });

    const result = await adapter().createRefund({
      providerPaymentId: 'pi_test_123',
      amountMinor: 100_00n,
      currency: 'EUR',
      reason: 'Cancelled',
      idempotencyKey: 'refund-key-2',
    });

    const body = bodyOf(spy.mock.calls[0]);
    expect(body).toContain('payment_intent=pi_test_123');
    // Not settled yet - the webhook says when.
    expect(result.status).toBe('PROCESSING');
  });

  it('surfaces Stripe’s own wording for a declined payment, and does not retry it', async () => {
    stubFetch(
      { error: { type: 'card_error', code: 'card_declined', message: 'Your card was declined.' } },
      402,
    );

    await expect(adapter().createPayment(paymentInput)).rejects.toMatchObject({
      message: 'Your card was declined.',
      retryable: false,
    });
  });

  it('treats a Stripe outage as retryable, so the caller reconciles instead of assuming failure', async () => {
    stubFetch({ error: { type: 'api_error', message: 'Internal server error' } }, 503);

    await expect(adapter().createPayment(paymentInput)).rejects.toMatchObject({ retryable: true });
  });

  it('refuses a zero or negative amount before Stripe ever sees it', async () => {
    const spy = stubFetch({});

    await expect(
      adapter().createPayment({ ...paymentInput, amountMinor: 0n }),
    ).rejects.toBeInstanceOf(PaymentProviderError);

    expect(spy).not.toHaveBeenCalled();
  });
});
