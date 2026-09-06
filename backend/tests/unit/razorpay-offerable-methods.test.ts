/**
 * Which instruments the Razorpay adapter will let checkout name.
 *
 * The bug these cover was found by paying for an order rather than by reading
 * the code. `availableGateways` had `methods: ['ANY', 'UPI']` written into it,
 * so checkout offered UPI for every Razorpay connection. The account behind
 * this deployment's key has UPI switched off, and Razorpay's sheet has no UPI
 * tab when that is so - `prefill.method: 'upi'` is not refused, it is silently
 * dropped. The customer chose UPI, read "Checkout opens on the UPI tab", and
 * was handed a card form with nothing to explain it.
 *
 * So the rule under test is the same one `availableGateways` already applies
 * to currencies: never offer what the gateway cannot deliver. The direction of
 * every fallback here is deliberate - an instrument is named only when
 * Razorpay has said it is on.
 *
 * Nothing here reaches the network; `fetch` is stubbed and the request
 * Razorpay would actually receive is asserted on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RazorpayAdapter } from '../../src/modules/payments/razorpay.adapter.js';

/**
 * A fresh key for every case.
 *
 * The adapter caches per key_id in module scope, which is the point of it -
 * but it means two cases sharing a key would answer each other rather than
 * Razorpay. Each test gets its own account.
 */
let keySeq = 0;
function adapter(): RazorpayAdapter {
  keySeq += 1;

  return new RazorpayAdapter({
    keyId: `rzp_test_offerable_${String(keySeq)}`,
    keySecret: 'secret',
    webhookSecret: 'whsec_test',
  });
}

/** Razorpay's `/preferences` answer, trimmed to the part that is read. */
function stubPreferences(methods: unknown, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve({ methods }),
  });

  vi.stubGlobal('fetch', spy);

  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('instruments the Razorpay sheet will actually open on', () => {
  it('names UPI when the account has it switched on', async () => {
    stubPreferences({ upi: true, card: true });

    expect(await adapter().offerableMethods()).toStrictEqual(['ANY', 'UPI']);
  });

  it('does not name UPI when the account has it switched off', async () => {
    // The reported bug, at its source. This account does card, netbanking and
    // wallets; its sheet has no UPI tab, so nothing may promise one.
    stubPreferences({ upi: false, card: true, netbanking: { HDFC: 'HDFC Bank' } });

    expect(await adapter().offerableMethods()).toStrictEqual(['ANY']);
  });

  it('does not name UPI when the field is missing entirely', async () => {
    stubPreferences({ card: true });

    expect(await adapter().offerableMethods()).toStrictEqual(['ANY']);
  });

  it('does not name UPI on a shape it does not understand', async () => {
    // Read by truthiness, `{}` would mean "enabled" and the promise would be
    // made all over again the next time Razorpay changed this field.
    stubPreferences({ upi: {} });

    expect(await adapter().offerableMethods()).toStrictEqual(['ANY']);
  });

  it('does not name UPI when Razorpay cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.razorpay.com')),
    );

    // A gateway that cannot be asked is still a gateway the customer can pay
    // through. The fallback drops the named instrument, never the gateway.
    expect(await adapter().offerableMethods()).toStrictEqual(['ANY']);
  });

  it('does not name UPI when Razorpay answers with an error status', async () => {
    stubPreferences({ upi: true }, 503);

    expect(await adapter().offerableMethods()).toStrictEqual(['ANY']);
  });

  it('sends the key id and no credentials', async () => {
    const spy = stubPreferences({ upi: true });
    const instance = adapter();

    await instance.offerableMethods();

    const [url, init] = spy.mock.calls[0] as [string, RequestInit | undefined];

    expect(url).toContain('/preferences?key_id=rzp_test_offerable_');

    // key_id already reaches the browser; the secret must not leave this
    // process for a lookup that does not need it.
    expect(init?.headers).toBeUndefined();
    expect(JSON.stringify(spy.mock.calls[0])).not.toContain('secret');
  });

  it('asks once per account and reuses the answer', async () => {
    const spy = stubPreferences({ upi: true });
    const instance = adapter();

    expect(await instance.offerableMethods()).toStrictEqual(['ANY', 'UPI']);
    expect(await instance.offerableMethods()).toStrictEqual(['ANY', 'UPI']);

    // This runs on every checkout page load. Two loads must not be two calls
    // to Razorpay.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reuses the answer across adapter instances for the same account', async () => {
    const spy = stubPreferences({ upi: true });
    const credentials = {
      keyId: 'rzp_test_shared_account',
      keySecret: 'secret',
      webhookSecret: 'whsec_test',
    };

    // An adapter is built per request, so a cache tied to the instance would
    // never be read a second time.
    await new RazorpayAdapter(credentials).offerableMethods();
    await new RazorpayAdapter(credentials).offerableMethods();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});
