/**
 * The Stripe adapter's hosted-Checkout half.
 *
 * What a Checkout Session request must and must not carry, asserted on the
 * exact form body Stripe would receive:
 *
 *   · The order's amount, as one integer, in Stripe's lowercase currency.
 *   · Stripe's own unticked save box - and no `setup_future_usage`, which would
 *     save every card whether or not the customer ticked anything, and no
 *     off-session wording of any kind.
 *   · Our opaque ids in metadata, and no name, email or address there.
 *   · Return addresses from configuration, with Stripe's session template.
 *   · India's export declaration: a description, a shipping address, and the
 *     billing address collected on Stripe's page.
 *
 * And the four checkout.session.* events, plus a dispute and a detached card,
 * parsed into what the service matches on.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PaymentProviderError, type CreateCheckoutSessionInput } from '../../src/modules/payments/provider.js';
import { StripeAdapter, isCheckoutUrlFor } from '../../src/modules/payments/stripe.adapter.js';

const WEBHOOK_SECRET = 'whsec_test_secret_value';

function adapter(): StripeAdapter {
  return new StripeAdapter({
    keyId: 'pk_test_publishable',
    keySecret: 'sk_test_secret',
    webhookSecret: WEBHOOK_SECRET,
  });
}

function sign(body: string): { rawBody: Buffer; headers: Record<string, string> } {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', WEBHOOK_SECRET)
    .update(`${String(timestamp)}.${body}`)
    .digest('hex');

  return {
    rawBody: Buffer.from(body, 'utf8'),
    headers: { 'stripe-signature': `t=${String(timestamp)},v1=${signature}` },
  };
}

const SESSION_ID = 'cs_test_a1B2c3D4e5F6g7H8i9';

const openSession = {
  id: SESSION_ID,
  object: 'checkout.session',
  url: `https://checkout.stripe.com/c/pay/${SESSION_ID}#fid`,
  status: 'open',
  payment_status: 'unpaid',
  expires_at: 1_900_000_000,
  amount_total: 180_000,
  currency: 'inr',
  client_reference_id: '01J0000000000000000000TXN1',
  customer: 'cus_test_1',
  payment_intent: null,
};

function input(overrides: Partial<CreateCheckoutSessionInput> = {}): CreateCheckoutSessionInput {
  return {
    paymentTransactionId: '01J0000000000000000000TXN1',
    orderId: '01J0000000000000000000ORD1',
    orderNumber: 'GL-2026-000042',
    amountMinor: 180_000n,
    currency: 'INR',
    lineItemName: 'Order GL-2026-000042',
    lineItemDescription: '2 × Nitrile gloves',
    description: 'Order GL-2026-000042: 2 × Nitrile gloves',
    providerCustomerId: 'cus_test_1',
    customerEmail: 'buyer@example.com',
    offerToSaveCard: true,
    shipping: {
      name: 'Asha Rao',
      line1: '12 MG Road',
      line2: null,
      city: 'Bengaluru',
      state: 'KA',
      postalCode: '560001',
      country: 'IN',
      phone: null,
    },
    locale: 'de',
    successUrl: 'https://shop.example.com/checkout/payment/ORD/confirmation?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl: 'https://shop.example.com/checkout/payment/ORD?payment=cancelled',
    expiresAt: new Date(1_900_000_000_000),
    idempotencyKey: 'stripe-checkout:01J0000000000000000000TXN1',
    ...overrides,
  };
}

/** Stub fetch with one answer, and capture what was sent. */
function stubStripe(body: unknown, status = 200): {
  sent: () => { url: string; form: URLSearchParams; headers: Record<string, string>; method: string };
} {
  let captured: { url: string; init: RequestInit } | null = null;

  vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
    captured = { url, init };
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  });

  return {
    sent: () => {
      if (captured === null) throw new Error('nothing was sent');
      return {
        url: captured.url,
        method: captured.init.method ?? 'GET',
        form: new URLSearchParams(typeof captured.init.body === 'string' ? captured.init.body : ''),
        headers: captured.init.headers as Record<string, string>,
      };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('creating a Checkout Session', () => {
  it('charges the order total as one integer line, in Stripe’s lowercase currency', async () => {
    const stripe = stubStripe(openSession);

    await adapter().createCheckoutSession(input());
    const { url, form, headers, method } = stripe.sent();

    expect(method).toBe('POST');
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(form.get('mode')).toBe('payment');
    expect(form.get('line_items[0][quantity]')).toBe('1');
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('180000');
    expect(form.get('line_items[0][price_data][currency]')).toBe('inr');
    expect(headers['Idempotency-Key']).toBe('stripe-checkout:01J0000000000000000000TXN1');
  });

  it('offers Stripe’s own save box for the customer’s record, and never saves on its own', async () => {
    const stripe = stubStripe(openSession);

    await adapter().createCheckoutSession(input());
    const { form } = stripe.sent();

    expect(form.get('customer')).toBe('cus_test_1');
    expect(form.get('customer_email')).toBeNull();
    expect(form.get('saved_payment_method_options[payment_method_save]')).toBe('enabled');
    // Either of these would save a card nobody chose to save, or claim a
    // mandate nobody gave.
    expect(form.get('payment_intent_data[setup_future_usage]')).toBeNull();
    expect([...form.values()].join(' ')).not.toContain('off_session');
  });

  it('offers no save box when there is no customer record to save to', async () => {
    const stripe = stubStripe({ ...openSession, customer: null });

    await adapter().createCheckoutSession(input({ providerCustomerId: null }));
    const { form } = stripe.sent();

    expect(form.get('customer')).toBeNull();
    expect(form.get('customer_email')).toBe('buyer@example.com');
    expect(form.get('saved_payment_method_options[payment_method_save]')).toBeNull();
  });

  it('puts our opaque ids in metadata and nothing personal', async () => {
    const stripe = stubStripe(openSession);

    await adapter().createCheckoutSession(input());
    const { form } = stripe.sent();

    const metadata = [...form.entries()].filter(([key]) => key.includes('metadata'));
    expect(Object.fromEntries(metadata)).toEqual({
      'metadata[uboss_payment_transaction_id]': '01J0000000000000000000TXN1',
      'metadata[uboss_order_id]': '01J0000000000000000000ORD1',
      'payment_intent_data[metadata][uboss_payment_transaction_id]': '01J0000000000000000000TXN1',
      'payment_intent_data[metadata][uboss_order_id]': '01J0000000000000000000ORD1',
      'payment_intent_data[metadata][uboss_order_number]': 'GL-2026-000042',
    });
    expect(form.get('client_reference_id')).toBe('01J0000000000000000000TXN1');
  });

  it('declares what India’s export rules ask for', async () => {
    const stripe = stubStripe(openSession);

    await adapter().createCheckoutSession(input());
    const { form } = stripe.sent();

    expect(form.get('billing_address_collection')).toBe('required');
    expect(form.get('payment_intent_data[description]')).toBe('Order GL-2026-000042: 2 × Nitrile gloves');
    expect(form.get('payment_intent_data[shipping][name]')).toBe('Asha Rao');
    expect(form.get('payment_intent_data[shipping][address][line1]')).toBe('12 MG Road');
    expect(form.get('payment_intent_data[shipping][address][country]')).toBe('IN');
    // Not needed for the declaration, so not sent.
    expect(form.get('payment_intent_data[shipping][phone]')).toBeNull();
  });

  it('keeps Stripe’s session template in the success address and uses the customer’s language', async () => {
    const stripe = stubStripe(openSession);

    await adapter().createCheckoutSession(input());
    const { form } = stripe.sent();

    expect(form.get('success_url')).toContain('session_id={CHECKOUT_SESSION_ID}');
    expect(form.get('cancel_url')).toContain('payment=cancelled');
    expect(form.get('locale')).toBe('de');
    expect(form.get('expires_at')).toBe('1900000000');
  });

  it('falls back to the browser’s language for one Stripe does not list', async () => {
    const stripe = stubStripe(openSession);

    await adapter().createCheckoutSession(input({ locale: 'xx' }));
    expect(stripe.sent().form.get('locale')).toBe('auto');
  });

  it('refuses an amount Stripe cannot take before any request is made', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      adapter().createCheckoutSession(input({ amountMinor: 100_000_000n })),
    ).rejects.toBeInstanceOf(PaymentProviderError);
    await expect(
      adapter().createCheckoutSession(input({ amountMinor: 12_345n, currency: 'HUF' })),
    ).rejects.toBeInstanceOf(PaymentProviderError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses an open session whose page is not an https page for that session', async () => {
    stubStripe({ ...openSession, url: 'http://checkout.stripe.com/c/pay/cs_test_other' });

    await expect(adapter().createCheckoutSession(input())).rejects.toBeInstanceOf(
      PaymentProviderError,
    );
  });

  it('reports the session in the shape the service matches on', async () => {
    stubStripe(openSession);

    const session = await adapter().createCheckoutSession(input());

    expect(session).toMatchObject({
      sessionId: SESSION_ID,
      status: 'open',
      paymentStatus: 'unpaid',
      amountTotal: 180_000n,
      currency: 'INR',
      providerCustomerId: 'cus_test_1',
      providerPaymentIntentId: null,
      payment: null,
    });
    expect(session.expiresAt.getTime()).toBe(1_900_000_000_000);
  });
});

describe('reading a completed session', () => {
  it('expands the payment, the charge and the card behind it', async () => {
    const stripe = stubStripe({
      ...openSession,
      status: 'complete',
      payment_status: 'paid',
      url: null,
      payment_intent: {
        id: 'pi_test_1',
        amount: 180_000,
        amount_received: 180_000,
        currency: 'inr',
        status: 'succeeded',
        latest_charge: { id: 'ch_test_1', amount: 180_000, currency: 'inr', payment_method_details: { type: 'card' } },
        payment_method: {
          id: 'pm_test_1',
          type: 'card',
          customer: 'cus_test_1',
          allow_redisplay: 'always',
          card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
        },
      },
    });

    const session = await adapter().retrieveCheckoutSession(SESSION_ID);

    expect(stripe.sent().url).toContain('expand%5B0%5D=payment_intent.latest_charge');
    expect(stripe.sent().url).toContain('expand%5B1%5D=payment_intent.payment_method');
    expect(session.status).toBe('complete');
    expect(session.providerPaymentIntentId).toBe('pi_test_1');
    expect(session.payment).toEqual({
      status: 'CAPTURED',
      chargeId: 'ch_test_1',
      amountReceived: 180_000n,
      method: 'card',
      paymentMethodId: 'pm_test_1',
      card: { brand: 'visa', last4: '4242' },
      failureCode: null,
    });
  });

  it('reads allow_redisplay back, which is the evidence the box was ticked', async () => {
    stubStripe({
      id: 'pm_test_1',
      type: 'card',
      customer: 'cus_test_1',
      allow_redisplay: 'always',
      card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030, funding: 'credit', country: 'IN' },
    });

    const card = await adapter().fetchVaultedCard('cus_test_1', 'pm_test_1');

    expect(card).toMatchObject({ allowRedisplay: 'always', methodType: 'card', last4: '4242' });
  });

  it('expires an open session with Stripe’s own endpoint', async () => {
    const stripe = stubStripe({ ...openSession, status: 'expired', url: null });

    const session = await adapter().expireCheckoutSession(SESSION_ID);

    expect(stripe.sent().url).toBe(`https://api.stripe.com/v1/checkout/sessions/${SESSION_ID}/expire`);
    expect(stripe.sent().method).toBe('POST');
    expect(session.status).toBe('expired');
  });
});

describe('Checkout webhook events', () => {
  function verify(type: string, object: Record<string, unknown>): ReturnType<StripeAdapter['verifyWebhook']> {
    const { rawBody, headers } = sign(JSON.stringify({ id: 'evt_test_1', type, data: { object } }));
    return adapter().verifyWebhook(rawBody, headers);
  }

  it('maps a completed session, carrying the session, the intent and our own reference', () => {
    const event = verify('checkout.session.completed', {
      ...openSession,
      status: 'complete',
      payment_status: 'paid',
      payment_intent: 'pi_test_1',
    });

    expect(event).toMatchObject({
      verified: true,
      intent: 'CHECKOUT_COMPLETED',
      providerSessionId: SESSION_ID,
      providerOrderId: 'pi_test_1',
      checkoutPaymentStatus: 'paid',
      internalReference: '01J0000000000000000000TXN1',
      amountMinor: 180_000n,
      currency: 'INR',
    });
  });

  it('maps the delayed-payment outcomes and the expiry', () => {
    expect(verify('checkout.session.async_payment_succeeded', openSession).intent).toBe(
      'CHECKOUT_ASYNC_SUCCEEDED',
    );
    expect(verify('checkout.session.async_payment_failed', openSession).intent).toBe(
      'CHECKOUT_ASYNC_FAILED',
    );
    expect(verify('checkout.session.expired', openSession).intent).toBe('CHECKOUT_EXPIRED');
  });

  it('carries our attempt id on a payment intent event, so it can overtake the session event', () => {
    const event = verify('payment_intent.succeeded', {
      id: 'pi_test_1',
      amount: 180_000,
      amount_received: 180_000,
      currency: 'inr',
      status: 'succeeded',
      latest_charge: 'ch_test_1',
      metadata: { uboss_payment_transaction_id: '01J0000000000000000000TXN1' },
    });

    expect(event.intent).toBe('PAYMENT_CAPTURED');
    expect(event.internalReference).toBe('01J0000000000000000000TXN1');
  });

  it('maps a dispute to the charge it was opened against', () => {
    const event = verify('charge.dispute.created', {
      id: 'dp_test_1',
      charge: 'ch_test_1',
      payment_intent: 'pi_test_1',
      amount: 180_000,
      currency: 'inr',
      reason: 'fraudulent',
    });

    expect(event).toMatchObject({
      intent: 'DISPUTE_OPENED',
      providerPaymentId: 'ch_test_1',
      providerOrderId: 'pi_test_1',
      disputeReason: 'fraudulent',
    });
  });

  it('maps a card detached at Stripe', () => {
    const event = verify('payment_method.detached', { id: 'pm_test_1', customer: null });

    expect(event).toMatchObject({ intent: 'PAYMENT_METHOD_DETACHED', providerPaymentMethodId: 'pm_test_1' });
  });
});

describe('isCheckoutUrlFor', () => {
  it('accepts an https page for the session, on Stripe or a custom domain', () => {
    expect(isCheckoutUrlFor(`https://checkout.stripe.com/c/pay/${SESSION_ID}#x`, SESSION_ID)).toBe(true);
    expect(isCheckoutUrlFor(`https://pay.shop.example/c/pay/${SESSION_ID}`, SESSION_ID)).toBe(true);
  });

  it('refuses plain http, another session, and junk', () => {
    expect(isCheckoutUrlFor(`http://checkout.stripe.com/c/pay/${SESSION_ID}`, SESSION_ID)).toBe(false);
    expect(isCheckoutUrlFor('https://checkout.stripe.com/c/pay/cs_test_other', SESSION_ID)).toBe(false);
    expect(isCheckoutUrlFor('javascript:alert(1)', SESSION_ID)).toBe(false);
    expect(isCheckoutUrlFor(null, SESSION_ID)).toBe(false);
  });
});
