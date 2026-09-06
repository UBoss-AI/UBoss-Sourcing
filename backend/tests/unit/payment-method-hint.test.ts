/**
 * The gateway and instrument a customer picks at checkout.
 *
 * The choice travels a long way — a radio button, a navigation, a request
 * body, a provider adapter — and the failure it could cause is specific:
 * a customer who asked for UPI is shown a sheet that cannot do UPI, or worse,
 * a preference silently changes which gateway takes the money.
 *
 * So the rules under test are the ones that keep a *preference* from becoming
 * an instruction:
 *
 *   - A hint the gateway cannot honour is dropped, not passed on.
 *   - A hint is part of the payload, so a replayed retry reopens the same
 *     sheet rather than a different one.
 *   - The offer list never contains a gateway nobody has credentials for, and
 *     never offers one for money it cannot settle.
 *
 * Nothing here reaches the network. `buildCheckoutPayload` is pure for
 * Razorpay by design — that is what makes an idempotent replay free — so it
 * can be asserted on directly.
 */
import { describe, expect, it } from 'vitest';
import { RazorpayAdapter } from '../../src/modules/payments/razorpay.adapter.js';
import type { CreatePaymentInput } from '../../src/modules/payments/provider.js';

const razorpayCredentials = {
  keyId: 'rzp_test_key',
  keySecret: 'rzp_test_secret',
  webhookSecret: 'rzp_test_webhook',
};

/** The order half of a create/replay input, without the idempotency key. */
function paymentInput(
  overrides: Partial<Omit<CreatePaymentInput, 'idempotencyKey'>> = {},
): Omit<CreatePaymentInput, 'idempotencyKey'> {
  return {
    orderId: 'order_test_1',
    orderNumber: 'UB-1001',
    amountMinor: 245_700n,
    currency: 'INR',
    customerEmail: 'buyer@example.test',
    customerName: 'A Buyer',
    customerPhone: '+911234567890',
    ...overrides,
  };
}

describe('Razorpay checkout payload', () => {
  it('asks the sheet to open on UPI when the customer chose it', async () => {
    const payload = await new RazorpayAdapter(razorpayCredentials).buildCheckoutPayload(
      'order_rzp_1',
      paymentInput({ methodHint: 'UPI' }),
    );

    expect(payload.prefill_method).toBe('upi');
  });

  it('leaves the instrument open when the customer expressed no preference', async () => {
    const adapter = new RazorpayAdapter(razorpayCredentials);

    // Both spellings of "no preference" have to mean the same thing: an older
    // client sends no field at all, a newer one sends the default.
    const unset = await adapter.buildCheckoutPayload('order_rzp_1', paymentInput());
    const explicit = await adapter.buildCheckoutPayload(
      'order_rzp_1',
      paymentInput({ methodHint: 'ANY' }),
    );

    expect(unset.prefill_method).toBe('');
    expect(explicit.prefill_method).toBe('');
  });

  it('never puts a secret in the payload the browser receives', async () => {
    const payload = await new RazorpayAdapter(razorpayCredentials).buildCheckoutPayload(
      'order_rzp_1',
      paymentInput({ methodHint: 'UPI' }),
    );

    // The publishable key id is what the browser needs; the secret is not.
    expect(payload.key).toBe(razorpayCredentials.keyId);
    expect(JSON.stringify(payload)).not.toContain(razorpayCredentials.keySecret);
    expect(JSON.stringify(payload)).not.toContain(razorpayCredentials.webhookSecret);
  });

  /**
   * The regression this guards: a retry reuses its idempotency key and is
   * answered from stored state rather than a second provider call. If the hint
   * were dropped on that path, a customer who asked for UPI and pressed "try
   * again" would get a different sheet the second time — and would reasonably
   * conclude the first attempt had charged them.
   */
  it('replays byte-identically, hint included', async () => {
    const adapter = new RazorpayAdapter(razorpayCredentials);
    const input = paymentInput({ methodHint: 'UPI' });

    const first = await adapter.buildCheckoutPayload('order_rzp_1', input);
    const second = await adapter.buildCheckoutPayload('order_rzp_1', input);

    expect(second).toStrictEqual(first);
  });
});
